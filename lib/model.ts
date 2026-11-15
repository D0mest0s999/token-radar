// Token Radar — a calibrated-comp implied-value model for pre-token protocols.
//
// The question the board answers: if this protocol, which records no token, issued one
// today, what would the market plausibly say it is worth? The model refuses to invent a
// number from a single flat multiple. Instead it prices each protocol the way the market
// already prices its tokenized peers, using only figures inside the sealed snapshot:
//
//   implied = tvl x category_multiple x momentum x maturity x breadth
//
// category_multiple is calibrated, not chosen: for every category, take the protocols in
// the same snapshot that DO trade a token, compute each one's market cap over TVL, and
// use the category median, shrunk toward the global median by sample size so a category
// with three wild observations cannot shout down three hundred quiet ones — and a
// category with fewer than three comps of its own is not trusted at all: the global
// median speaks for it. Momentum is
// the 7-day TVL change through a tanh, so one hot week bends the value without breaking
// it. Maturity rewards protocols that have survived, on a saturating curve. Breadth adds
// a small premium per extra chain, capped, because distribution is real but not magic.
//
// The board ranks every watchlist protocol (the floor, never a ceiling) plus every other
// rankable pre-token protocol in the snapshot — the full early universe, not a top slice.
// A protocol is rankable when it records no token and is not a versioned pool, an
// exchange, a bridge, or a wrapped/staked product of someone else's asset: transit TVL
// and receipt TVL are not a protocol waiting on a launch of its own.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2 (calibrated comps)';

/** How many live-token protocols the comps view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Shrinkage: a category median counts as this many extra global-median observations. */
export const SHRINK_PRIOR = 8;
/** A category needs at least this many trading comps before its own median is trusted;
 *  below it, the global median speaks for the category. */
export const MIN_CATEGORY_SAMPLE = 3;
/** No category multiple leaves this band, however the comps voted. */
export const MULTIPLE_MIN = 0.03;
export const MULTIPLE_MAX = 2.5;
/** Momentum: implied moves at most this fraction on the 7-day TVL change. */
export const MOMENTUM_WEIGHT = 0.3;
/** Breadth: this much per chain beyond the first, for at most BREADTH_CHAINS extra chains. */
export const BREADTH_PER_CHAIN = 0.04;
export const BREADTH_CHAINS = 5;
/** Maturity: floor plus range on a saturating age curve with this time constant, in days. */
export const MATURITY_FLOOR = 0.75;
export const MATURITY_RANGE = 0.35;
export const MATURITY_TAU_DAYS = 540;
export const UNKNOWN_AGE_DAYS = 270;

/** One category's calibration: how many trading comps, their median, the multiple used. */
export interface CategoryComp {
  category: string;
  sample: number;
  median_ratio: number;
  multiple: number;
}

/** The whole calibration: the global fallback and every category with at least one comp. */
export interface Calibration {
  global_sample: number;
  global_median: number;
  categories: CategoryComp[];
}

/** The per-row model breakdown, carried into board.json and the dashboard. */
export interface ModelBreakdown {
  category_multiple: number;
  category_sample: number;
  multiple_basis: 'category' | 'global';
  momentum_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  mcap_tvl: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  constants: {
    shrink_prior: number;
    momentum_weight: number;
    breadth_per_chain: number;
    maturity_floor: number;
    maturity_range: number;
  };
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * Calibrate the category multiples from the snapshot's own trading protocols.
 * A comp is a protocol with a token market cap and TVL, both positive. Categories with
 * no comps fall back to the global median at scoring time.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const list = ratiosByCategory.get(key);
    if (list) list.push(ratio);
    else ratiosByCategory.set(key, [ratio]);
  }
  const globalMedian = median(all);
  const categories: CategoryComp[] = [];
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const shrunk = (ratios.length * med + SHRINK_PRIOR * globalMedian) / (ratios.length + SHRINK_PRIOR);
    categories.push({
      category,
      sample: ratios.length,
      median_ratio: round4(med),
      multiple: round4(Math.min(MULTIPLE_MAX, Math.max(MULTIPLE_MIN, shrunk))),
    });
  }
  categories.sort((a, b) => b.sample - a.sample || (a.category < b.category ? -1 : 1));
  return { global_sample: all.length, global_median: round4(globalMedian), categories };
}

function multipleFor(calibration: Calibration, category: string | null): { multiple: number; sample: number; basis: 'category' | 'global' } {
  const key = category ?? '(uncategorised)';
  const comp = calibration.categories.find((c) => c.category === key);
  if (comp && comp.sample >= MIN_CATEGORY_SAMPLE) return { multiple: comp.multiple, sample: comp.sample, basis: 'category' };
  return {
    multiple: Math.min(MULTIPLE_MAX, Math.max(MULTIPLE_MIN, calibration.global_median)),
    sample: comp ? comp.sample : 0,
    basis: 'global',
  };
}

/** The implied value of one protocol under the calibration, with its full breakdown. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: Calibration,
): { implied: number; breakdown: ModelBreakdown } {
  const { multiple, sample, basis } = multipleFor(calibration, protocol.category);
  const growth = finite(protocol.change_7d, 0);
  const momentum = 1 + MOMENTUM_WEIGHT * Math.tanh(growth / 40);
  const age = ageDays(asOf, protocol.listed_at);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturity = MATURITY_FLOOR + MATURITY_RANGE * (1 - Math.exp(-ageForModel / MATURITY_TAU_DAYS));
  const breadth = 1 + BREADTH_PER_CHAIN * Math.min(Math.max(protocol.chains.length - 1, 0), BREADTH_CHAINS);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * momentum * maturity * breadth));
  return {
    implied,
    breakdown: {
      category_multiple: multiple,
      category_sample: sample,
      multiple_basis: basis,
      momentum_multiplier: round4(momentum),
      maturity_multiplier: round4(maturity),
      breadth_multiplier: round4(breadth),
      age_days: age,
    },
  };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const TRANSIT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge']);
const RECEIPT_CATEGORIES = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whether a protocol records no token at all. The board says "records no token", never "has none". */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a pre-token protocol is one the board may rank as an early candidate: not a
 * versioned pool, not an exchange, not a bridge, and not a wrapped or staked product of
 * another protocol's asset — the same exclusions the watchlist states, applied evenly.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (p.category === 'CEX') return false;
  if (p.category !== null && (TRANSIT_CATEGORIES.has(p.category) || RECEIPT_CATEGORIES.has(p.category))) return false;
  if (WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow, with its real mechanic named. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}; if you borrow against it, stay under 50% of the borrow limit so a bad week cannot liquidate you.`;
  }
  if (c.includes('dex') || c.includes('aggregator')) {
    return `Provide $${capital} split across the main pair on ${name} (${chain}) and make two small swaps, so the wallet shows both sides of the product.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC margin on ${name} and run one small hedged position for a day, so the account has real trading history, not just a deposit.`;
  }
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the same wallet.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and take one position in a liquid market you actually have a view on.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the farming wallet.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield asset on ${chain} and hold it; RWA positions usually count holders, not volume.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy until it expires.`;
  }
  if (c.includes('gaming') || c.includes('nft') || c.includes('social')) {
    return `Use ${name} the way a player would: $${capital} of in-app activity on ${chain} across several days, not one burst.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, flavoured by category. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend')) return 'one supply, repay or borrow adjustment';
  if (c.includes('dex') || c.includes('aggregator')) return 'one swap and one liquidity check';
  if (c.includes('perpetual') || c.includes('derivative')) return 'one small trade';
  if (c.includes('yield') || c.includes('curator')) return 'one small top-up deposit';
  return 'one qualifying action, such as a deposit, a swap or a vote';
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps derived from its own record — category, chains,
 * TVL, age and 7-day trend. The trend step is honest about direction: TVL leaving fast
 * is a warning to read first, and TVL arriving fast is a warning about incentives.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const growth = finite(p.change_7d, 0);
  const steps: string[] = [];
  steps.push(stepText(
    `Start from a fresh wallet that holds only the funds you plan to farm ${p.name} with, and keep its seed phrase offline.`,
    'under $3 of gas for the first transaction',
    '5 minutes',
  ));
  steps.push(stepText(actionFor(p, capital, chain), `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, '15 minutes to set up'));
  if (growth <= -10) {
    steps.push(stepText(
      `${p.name}'s TVL fell ${Math.abs(growth).toFixed(1)}% in the last 7 days: before adding more, read the protocol's own announcements for an exploit, an ended incentive or a chain migration, and only continue if the cause is benign.`,
      'nothing to read first',
      '20 minutes',
    ));
  } else if (growth >= 25) {
    steps.push(stepText(
      `${p.name}'s TVL grew ${growth.toFixed(1)}% in the last 7 days: size in gradually over two weeks instead of at once, because incentive-driven TVL leaves as fast as it arrived.`,
      'the same capital, split into two entries',
      'spread over 2 weeks',
    ));
  } else {
    steps.push(stepText(
      `Make ${weeklyFor(p)} each week on ${p.name}, so the wallet reads as a user and not a one-day visitor.`,
      'about $2 of gas a week',
      '10 minutes a week',
    ));
  }
  steps.push(stepText(
    `Hold the position for at least ${hold} days so the activity appears in more than one weekly snapshot.`,
    `the $${capital} stays in the position`,
    `${hold} days`,
  ));
  steps.push(stepText(
    `Once a month, open ${p.name}'s own points or rewards page from the link on its official site and check the wallet is counted; never follow a claim link from a message or a search ad.`,
    'no fee to check, and never pay to claim',
    '10 minutes a month',
  ));
  steps.push(stepText(
    `Keep a farm log: the wallet, the entry date, the amount and every transaction hash for ${p.name}.`,
    'nothing but the log',
    '5 minutes',
  ));
  steps.push(stepText(
    `Unwind if ${p.name}'s TVL drops 30% from your entry week, if the team goes silent for a month, or once any snapshot the team announces has passed.`,
    'normal withdrawal gas',
    '15 minutes',
  ));
  return steps;
}

/** The board: every watchlist row plus every rankable pre-token protocol, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, calibration: Calibration): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const { implied, breakdown } = impliedValue(p, snapshot.as_of, calibration);
    return { p, implied, breakdown };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    model: s.breakdown,
    farm_steps: farmSteps(s.p, s.breakdown.age_days),
  }));
}

/** The live-token protocols, by market cap: the comps the calibration is built from. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; calibration: Calibration } {
  const calibration = calibrate(snapshot);
  const board = buildBoard(snapshot, calibration);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    constants: {
      shrink_prior: SHRINK_PRIOR,
      momentum_weight: MOMENTUM_WEIGHT,
      breadth_per_chain: BREADTH_PER_CHAIN,
      maturity_floor: MATURITY_FLOOR,
      maturity_range: MATURITY_RANGE,
    },
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar, calibration };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
