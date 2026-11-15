// Token Radar dashboard: renders window.RADAR (written by the entry's program beside
// this page as ../data.js), with search, filters, a per-protocol detail view carrying
// the model breakdown and the farm plan, the calibration table the model was built
// from, and a sandbox that re-ranks the board in the page with the model's own
// formulas when a weight moves. No network, no framework.
'use strict';

const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);

function money(v) {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}
function pct(v) {
  if (v === null || v === undefined) return '—';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(1)}%`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- header, calibration, comps ----------
$('model-version').textContent = R.model_version;
$('footer-model').textContent = R.model_version;
$('footer-source').textContent = `${R.source}, as of ${R.as_of}`;
$('source-line').textContent = `Snapshot: ${R.source} · as of ${R.as_of} · watchlist floor ${money(R.floor_usd)}`;
$('headline').textContent =
  `${R.board_size} protocols that record no token, ranked by implied value — ` +
  `${R.watchlist_size} from the watchlist and ${R.early_size} early finds below its floor, ` +
  `priced from ${R.calibration.global_sample} trading peers in the same snapshot.`;

{
  const body = $('calibration-table').querySelector('tbody');
  body.innerHTML = R.calibration.categories
    .filter((c) => c.sample >= 2)
    .map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.sample}</td><td class="num">${c.median_ratio.toFixed(3)}×</td><td class="num">${(c.sample >= 3 ? c.multiple : R.calibration.global_median).toFixed(3)}×</td></tr>`)
    .join('');
  $('calibration-note').textContent =
    `Global median across all ${R.calibration.global_sample} trading protocols: ${R.calibration.global_median.toFixed(3)}×. ` +
    `Each category's multiple is its median shrunk toward that global figure with a prior of ${R.constants.shrink_prior} observations, ` +
    `then held inside 0.03×–2.5×. Categories with fewer than three comps are not trusted with a multiple of their own: the global median speaks for them.`;
}
{
  const body = $('live-table').querySelector('tbody');
  body.innerHTML = R.live
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.category ?? '—')}</td><td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td><td class="num">${p.mcap_tvl === null ? '—' : `${p.mcap_tvl.toFixed(2)}×`}</td><td class="num ${p.change_7d > 0 ? 'pos' : 'neg'}">${pct(p.change_7d)}</td></tr>`)
    .join('');
}

// ---------- the board ----------
const state = {
  q: '',
  category: params.get('category') ?? '',
  chain: params.get('chain') ?? '',
  watchOnly: params.get('watch') === '1',
  sort: 'rank',
  sandbox: null, // { momentum, breadth, maturityFloor } while the sandbox differs
};

{
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  $('f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option ${c === state.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option ${c === state.chain ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('f-watch').checked = state.watchOnly;
}

function sandboxImplied(row) {
  const s = state.sandbox;
  const growth = row.change_7d ?? 0;
  const momentum = 1 + s.momentum * Math.tanh(growth / 40);
  const age = row.model.age_days ?? 270;
  const maturity = s.maturityFloor + R.constants.maturity_range * (1 - Math.exp(-age / 540));
  const breadth = 1 + s.breadth * Math.min(Math.max(row.chains.length - 1, 0), 5);
  return {
    implied: Math.max(1, Math.round(row.tvl_usd * row.model.category_multiple * momentum * maturity * breadth)),
    momentum,
    maturity,
    breadth,
  };
}

function visibleRows() {
  let rows = R.rows.filter((r) => {
    if (state.watchOnly && !r.watchlist) return false;
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const impliedOf = (r) => (state.sandbox ? sandboxImplied(r).implied : r.implied_value_usd);
  if (state.sort === 'tvl') rows.sort((a, b) => b.tvl_usd - a.tvl_usd);
  else if (state.sort === 'momentum') rows.sort((a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity));
  else if (state.sort === 'age') rows.sort((a, b) => (b.model.age_days ?? -1) - (a.model.age_days ?? -1));
  else rows.sort((a, b) => impliedOf(b) - impliedOf(a));
  return rows.map((r, i) => ({ row: r, rank: state.sort === 'rank' ? i + 1 : r.rank, implied: impliedOf(r) }));
}

function renderBoard() {
  const rows = visibleRows();
  $('row-count').textContent = `${rows.length} of ${R.board_size} protocols`;
  $('board-table').querySelector('tbody').innerHTML = rows
    .map(({ row: r, rank, implied }) => `<tr data-slug="${esc(r.slug)}">
      <td class="num">${rank}</td>
      <td>${esc(r.name)}${r.watchlist ? '<span class="watch-mark">W</span>' : ''}</td>
      <td>${esc(r.category ?? '—')}</td>
      <td>${esc(r.chains.slice(0, 3).join(', '))}${r.chains.length > 3 ? ` +${r.chains.length - 3}` : ''}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num ${r.change_7d > 0 ? 'pos' : 'neg'}">${pct(r.change_7d)}</td>
      <td class="num">${money(implied)}</td>
      <td class="num">${(implied / r.tvl_usd).toFixed(2)}×</td>
    </tr>`)
    .join('');
  for (const tr of $('board-table').querySelectorAll('tbody tr')) {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  }
}

$('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
$('f-category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
$('f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('f-watch').addEventListener('change', (e) => { state.watchOnly = e.target.checked; renderBoard(); });
$('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderBoard(); });

// ---------- detail ----------
function bar(label, value, max, display) {
  const width = Math.max(2, Math.min(100, (value / max) * 100));
  return `<div class="row"><span class="label">${label}</span><span class="bar"><i style="width:${width}%"></i></span><span class="value">${display}</span></div>`;
}

function openDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const sb = state.sandbox ? sandboxImplied(r) : null;
  const implied = sb ? sb.implied : r.implied_value_usd;
  const momentum = sb ? sb.momentum : r.model.momentum_multiplier;
  const maturity = sb ? sb.maturity : r.model.maturity_multiplier;
  const breadth = sb ? sb.breadth : r.model.breadth_multiplier;
  $('detail-name').textContent = `${r.name}${r.watchlist ? ' · watchlist' : ' · early find'}`;
  $('detail-meta').textContent =
    `${r.category ?? 'Uncategorised'} · ${r.chains.join(', ') || 'no chains recorded'} · ` +
    `TVL ${money(r.tvl_usd)} · 7-day ${pct(r.change_7d)} · ` +
    `${r.model.age_days === null ? 'age unknown' : `${r.model.age_days} days old`} · records no token`;
  $('detail-breakdown').innerHTML =
    bar('TVL', Math.min(r.tvl_usd, 3e9), 3e9, money(r.tvl_usd)) +
    bar(r.model.multiple_basis === 'category' ? `Category multiple (${r.model.category_sample} comps)` : `Global multiple (only ${r.model.category_sample} comps)`, r.model.category_multiple, 2.5, `${r.model.category_multiple.toFixed(3)}×`) +
    bar('Momentum', momentum, 1.3, `${momentum.toFixed(3)}×`) +
    bar('Maturity', maturity, 1.1, `${maturity.toFixed(3)}×`) +
    bar('Breadth', breadth, 1.2, `${breadth.toFixed(3)}×`) +
    `<div class="row total"><span class="label">Implied value${state.sandbox ? ' (sandbox)' : ''}</span><span></span><span class="value">${money(implied)}</span></div>`;
  $('detail-farm').innerHTML = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  $('detail-panel').hidden = false;
  $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('detail-close').addEventListener('click', () => {
  $('detail-panel').hidden = true;
  $('board-panel').scrollIntoView({ behavior: 'smooth' });
});

// ---------- sandbox ----------
function syncSandbox() {
  const momentum = Number($('sb-momentum').value);
  const breadth = Number($('sb-breadth').value);
  const maturityFloor = Number($('sb-maturity').value);
  $('sb-momentum-value').textContent = momentum.toFixed(2);
  $('sb-breadth-value').textContent = breadth.toFixed(2);
  $('sb-maturity-value').textContent = maturityFloor.toFixed(2);
  const isDefault =
    Math.abs(momentum - R.constants.momentum_weight) < 1e-9 &&
    Math.abs(breadth - R.constants.breadth_per_chain) < 1e-9 &&
    Math.abs(maturityFloor - R.constants.maturity_floor) < 1e-9;
  state.sandbox = isDefault ? null : { momentum, breadth, maturityFloor };
  $('sandbox-state').textContent = isDefault
    ? 'Showing the handed-in model.'
    : 'Sandbox weights active: the board below is re-ranked in this page only. The handed-in board.json is unchanged.';
  renderBoard();
}
$('sb-momentum').value = R.constants.momentum_weight;
$('sb-breadth').value = R.constants.breadth_per_chain;
$('sb-maturity').value = R.constants.maturity_floor;
for (const id of ['sb-momentum', 'sb-breadth', 'sb-maturity']) $(id).addEventListener('input', syncSandbox);
$('sb-reset').addEventListener('click', () => {
  $('sb-momentum').value = R.constants.momentum_weight;
  $('sb-breadth').value = R.constants.breadth_per_chain;
  $('sb-maturity').value = R.constants.maturity_floor;
  syncSandbox();
});

// ---------- go ----------
syncSandbox();
if (params.get('view') === 'detail') {
  openDetail(params.get('slug') ?? R.rows[0].slug);
}
