// tacit.finance/cbtc: cBTC, bitcoin locked at an address only its owner's key can spend, minted one for one in the Tacit pool against an ETH bond.
// The page tracks it: what stands behind it (the locks on Bitcoin, the bond, what was minted, the cUSD lent against it), the private pools that hold it and
// the farms that pay for liquidity in them, and, with a Tacit key open, that key's own locks, cBTC, loans and farm positions. It reads the chain and the
// API with no wallet and holds no key it was not given. Making cBTC (lock, bond, mint, borrow) is a flow of several steps with Bitcoin and Ethereum
// transactions, and it is done on tacit.finance's Borrow sheet, which each button here opens; this page sizes the bond for an amount before it does.
import { sha256 } from '/vendor/tacit-deps.min.js';
import { mountChart, fmtLocalStamp, fmtLocalTime } from '/trade/chart.js?cb=deafdf6c';
import { makeConnect } from '/trade/connect.js?cb=92188b57';
import { makeKeySession, signInSheet } from '/trade/key.js?cb=149c5b79';
import { getUx, forgetUx } from '/trade/poolux.js?cb=e792b253';
import { readRates, readProgram, heldBars, rangesFor, barSize } from '/teth/read.js?cb=b2a110d0';
import { totalsOf, readEngine, sizeBond, coverage, readPools, poolRows, farmApr, readLocks, readLoans, readHeld, readHistory, positionsIn, lockStep, CBTC_ID, ENGINE, WSTETH } from '/cbtc/read.js?cb=c51b1e58';
import { $, esc, api, now, fmtUnits, parseUnits, grp, usd, pct, short, sig } from '/trade/util.js?cb=509d6618';

const SCAN = 'https://etherscan.io/', MEMPOOL = 'https://mempool.space/';
const PRESETS = [['0.001 BTC', '0.001'], ['0.01 BTC', '0.01'], ['0.1 BTC', '0.1']];
const D = { totals: null, engine: null, rates: {}, program: null, pools: null, rows: [], size: null, mine: null, hist: null, live: null, histFailed: false };
// The totals as the page shows them: the stats' reading, with what the per-lock reads say of the live locks (minted sats, bonds) once those are in: the stats
// count a spent lock's mint and bond too, until its bond is slashed or taken back.
const tot = () => (D.totals ? { ...D.totals, ...(D.live || {}) } : null);
const S = { mode: 'get', amt: '', seq: 0, chart: 'locked', range: null, unit: 'btc' };

const tn = (s) => esc(s).replace(/\b(tETH|cBTC|cUSD)\b/g, '<span class="tn">$1</span>');   // a token's own spelling inside an uppercase label
const compact = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : usd(x));
const btcTxt = (sats) => { const x = Number(sats) / 1e8; return x === 0 ? '0' : x >= 1 ? grp(x, 4) : x >= 0.001 ? x.toFixed(6).replace(/0+$/, '') : x.toFixed(8).replace(/0+$/, ''); };
const usdBtc = () => D.engine?.usdBtc ?? D.rates.btcUsd ?? null;                         // the price the loans are made at, else the feed's
const ethUsd = () => D.rates.ethUsd;
const cusdTxt = (v) => grp(Number(v) / 1e8, Number(v) / 1e8 >= 100 ? 0 : 2);
const aprTxt = (a) => (a == null ? '—' : a >= 10000 ? '10,000%+' : `${Math.round(a).toLocaleString('en-US')}%`);
const DUST_USD = 25;                                                                         // a pool under this is too small for its price to mean anything

// ── the head: what a cBTC is worth, what is locked ──
function renderHead() {
  const px = usdBtc(), T = tot();
  $('#px-usd').textContent = px != null ? usd(px) : 'cBTC';
  document.title = px != null ? `cBTC ${usd(px)} · tacit` : 'tacit cBTC';
  const bits = ['<span title="Lock bitcoin and the same amount is minted as cBTC"><b class="num">1 cBTC</b> = 1 BTC, locked</span>'];
  if (T) {
    bits.push(`<span><b class="num">${esc(btcTxt(T.minted))} cBTC</b>${px != null ? ` (${compact(Number(T.minted) / 1e8 * px)})` : ''} minted</span>`);
    bits.push(`<span>${grp(T.locks, 0)} lock${T.locks === 1 ? '' : 's'} · ${grp(T.open, 0)} loan${T.open === 1 ? '' : 's'} open</span>`);
  }
  $('#px-sub').innerHTML = T || px != null ? bits.join('') : '<span class="mute">Reading the locks…</span>';
}
function renderLanes() {
  const px = usdBtc(), rows = D.rows, priced = rows.filter((r) => r.usd != null && (r.depthUsd ?? 0) >= DUST_USD);
  const cards = [{ name: 'Bitcoin', sw: '#f7931a', v: px, s: '1 BTC', g: 'the price loans use' },
    ...rows.map((r) => { const dust = (r.depthUsd ?? 0) < DUST_USD; return { name: `cBTC in the ${r.other} pool`, sw: r.other === 'TAC' ? '#f7931a' : r.other === 'cUSD' ? '#16a34a' : '#627eea', v: dust ? null : r.usd, s: `1 cBTC = ${sig(r.per, 3)} ${r.other}`, gap: dust ? null : r.gap, idle: dust, g: dust ? 'too small to price' : r.gap != null ? `${Math.abs(r.gap) >= 0.01 ? `${Math.round(Math.abs(r.gap) * 100)}% ${r.gap > 0 ? 'above' : 'below'} BTC` : 'in line with BTC'} · ${compact(r.depthUsd)} deep` : 'reading' }; })];
  const lo = priced.length ? Math.min(...priced.map((r) => r.usd)) : null, hi = priced.length ? Math.max(...priced.map((r) => r.usd)) : null, apart = Math.max(0, ...priced.map((r) => Math.abs(r.gap || 0)));
  $('#hints-sum').innerHTML = px != null
    ? `<span>Bitcoin <b>${usd(px)}</b></span>${priced.length ? `<span>· cBTC in pools <b>${usd(lo)}${lo === hi ? '' : ` to ${usd(hi)}`}</b></span>` : ''}${apart >= 0.01 ? `<span class="apart">· ${priced.length === 1 ? '' : 'up to '}${Math.round(apart * 100)}% off</span>` : ''}` : 'cBTC prices';
  $('#lanes').innerHTML = cards.map((c) => `<div class="lane"><span class="k"><i class="sw" style="background:${c.sw}"></i>${tn(c.name)}</span><span class="v num">${c.idle ? '—' : c.v == null && c.name !== 'Bitcoin' ? '<i class="sk"></i>' : usd(c.v)}</span><span class="s num">${esc(c.s || '')}</span><span class="g ${c.gap != null && Math.abs(c.gap) >= 0.01 ? 'dev' : ''}">${esc(c.g || '')}</span></div>`).join('');
  $('#gapnote').textContent = apart >= 0.01 ? 'Each pool prices cBTC from its own reserves, so a small one can sit far from BTC.' : '';
}

// ── what stands behind it ──
function renderBacking() {
  const T = tot(), px = usdBtc(), cov = coverage(T, { ethUsd: ethUsd(), usdBtc: px, wstEth: D.engine?.wstEth });
  if (!T) return;
  const row = (head, val, bar, sub) => `<div class="cov-row"><div class="cov-h"><b>${head}</b><span>${val}</span></div>${bar || ''}<div class="cov-s">${sub}</div></div>`;
  const usdTxt = (sats) => (px != null ? ` · ${compact(Number(sats) / 1e8 * px)}` : '');
  const rows = [row('Bitcoin locked', `${esc(btcTxt(T.locked))} BTC${usdTxt(T.locked)}`, '<div class="cov-bar"><i class="btc" style="width:100%"></i></div>',
    `${grp(T.locks, 0)} lock${T.locks === 1 ? '' : 's'}, each spendable only by its owner.${T.unlocked ? ` ${grp(T.unlocked, 0)} spent.` : ''}${T.redeemed ? ` ${grp(T.redeemed, 0)} redeemed.` : ''}${T.waiting ? ` ${grp(T.waiting, 0)} waiting to mint.` : ''}`)];
  if (cov) {
    const scale = Math.max(2, Math.ceil((cov.ratio || 0) * 4) / 4 + 0.25), w = Math.min(100, (cov.ratio / scale) * 100), tick = (1.5 / scale) * 100, wstTxt = grp(Number(T.bond) / 1e18, 2);
    rows.push(row('ETH bond', `${Math.round(cov.ratio * 100)}% of locked BTC`, `<div class="cov-bar"><i class="eth" style="width:${w.toFixed(1)}%"></i><u style="left:${tick.toFixed(1)}%" title="1.5×"></u></div>`,
      `<b>${wstTxt} wstETH</b> (${compact(cov.bondUsd)}) in ${grp(T.bonds, 0)} bond${T.bonds === 1 ? '' : 's'}. Each lock needs a bond of at least 1.5× (dashed line). Spending the BTC without redeeming forfeits it.`));
  } else rows.push(row('ETH bond', `${grp(Number(T.bond) / 1e18, 2)} wstETH`, '', 'Held by the collateral engine.'));
  const mintedPct = T.locked > 0n ? Number(T.minted * 1000n / T.locked) / 10 : null;
  rows.push(row('cBTC minted', `${esc(btcTxt(T.minted))} of ${esc(btcTxt(T.locked))}`, mintedPct != null ? `<div class="cov-bar"><i style="width:${Math.min(100, mintedPct)}%"></i></div>` : '', `${grp(T.mints, 0)} of ${grp(T.locks, 0)} live lock${T.locks === 1 ? '' : 's'} minted, 1:1.${T.tacbtc > 0n ? ` ${esc(grp(Number(T.tacbtc) / 1e18, 5))} BTC withdrawn as public tacBTC.` : ''}`));
  rows.push(row('cUSD lent', `${cusdTxt(T.out)} out`, '', `<b>${grp(T.open, 0)} open loan${T.open === 1 ? '' : 's'}</b>: ${cusdTxt(T.borrowed)} borrowed, ${cusdTxt(T.repaid)} repaid, ${cusdTxt(T.liquidated)} liquidated. Loans need ${D.engine?.ratio ?? 150}% collateral and are liquidated below ${D.engine?.liq ?? 130}%.`));
  const html = rows.join('');
  if ($('#cov').__h !== html) { $('#cov').__h = html; $('#cov').innerHTML = html; }
  $('#cov-note').textContent = 'Read live from the pool and the collateral engine.';
}

// ── the history: the locked bitcoin, and the cUSD lent, over time ──
const chart = mountChart($('#chart'), (h) => paintRead(h));
const RANGE_WORDS = { 1: 'past day', 7: 'past week', 30: 'past month', 90: 'past 3 months', 0: 'all time' };
const KINDS = { locked: 'BTC locked', out: 'cUSD out' };
const histOf = () => D.hist?.[S.chart] || null;
const spanDays = () => { const h = histOf(); return h?.pts.length ? (now() - h.pts[0].t) / 86400 : 0; };
function effRange() { const days = rangesFor(spanDays()).map(([, d]) => d); return days.includes(S.range) ? S.range : days.includes(30) ? 30 : 0; }
const unitOf = () => (S.chart === 'out' ? 'cusd' : S.unit === 'usd' && usdBtc() ? 'usd' : 'btc');
const fmtOf = (unit) => (unit === 'btc' ? (v) => `${v < 1 ? v.toFixed(4) : v.toFixed(3)} BTC` : (v) => usd(v));
function renderControls() {
  const seg = (label, attr, opts, cur) => `<div class="seg sm" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  const r = effRange();
  $('#lane-seg').innerHTML = Object.entries(KINDS).map(([k, l]) => `<button type="button" data-chart="${k}" aria-pressed="${k === S.chart}">${l}</button>`).join('');
  $('#range-seg').innerHTML = rangesFor(spanDays()).map(([l, d]) => `<button type="button" data-range="${d}" aria-pressed="${r === d}">${l}</button>`).join('');
  $('#view-seg').innerHTML = S.chart === 'locked' ? seg('Show in', 'unit', [['btc', 'BTC'], ['usd', 'USD']], unitOf()) : '';
  $('#chart-name').innerHTML = S.chart === 'locked' ? 'BTC locked' : tn('cUSD lent');
}
function paintRead(h = null) {
  const el = $('#ch-read'), V = S.view;
  let out = '';
  if (V?.bars.length) {
    const { bars, unit, range } = V, b = h?.b || bars.at(-1), first = bars[0].close, f = fmtOf(unit), chg = first > 0.05 * bars.at(-1).close ? b.close / first - 1 : null,   // a move from next to nothing is not a figure worth showing
      up = chg != null && chg >= 0.0005, down = chg != null && chg <= -0.0005;
    const closes = bars.map((x) => x.close), lo = Math.min(...closes), hi = Math.max(...closes);
    const word = h ? `${fmtLocalStamp(b.t)}${b.held ? ' · no change' : ''}` : range ? RANGE_WORDS[range] : `all time · since ${fmtLocalTime(bars[0].t, true)}`;
    const verb = S.chart === 'locked' ? 'locked' : 'lent or repaid', amt = (v) => (S.chart === 'locked' ? (v < 1 ? v.toFixed(4) : v.toFixed(3)) : grp(v, 2));
    const right = h ? (b.vol > 0 ? `<span><b>${amt(b.vol)}</b> ${S.chart === 'locked' ? 'BTC' : 'cUSD'} ${verb}${b.n ? ` in ${b.n} step${b.n === 1 ? '' : 's'}` : ''}</span>` : '<span>no change</span>') : `<span>low <b>${f(lo)}</b></span><span>high <b>${f(hi)}</b></span>`;
    out = `<div class="l"><span class="px num">${f(b.close)}</span>${chg != null ? `<span class="chg ${up ? 'up' : down ? 'down' : 'mute'}">${up ? '▲' : down ? '▼' : ''} ${Math.abs(chg * 100).toFixed(Math.abs(chg) < 0.1 ? 1 : 0)}%</span>` : ''}<em>${esc(word)}</em></div><div class="r">${right}</div>`;
  }
  if (el.__h !== out) { el.__h = out; el.innerHTML = out; }
}
function renderChart() {
  const H = histOf();
  renderControls();
  if (!H?.pts.length) { chart.update({ series: [], tags: [], period: 3600, label: 'History of the locks and the loans', empty: D.histFailed ? 'Could not read the history. Try again in a moment.' : D.hist ? 'Nothing to draw yet.' : 'Reading the history…' }); S.view = null; paintRead(); return; }
  const span = spanDays(), range = effRange(), tf = barSize(range, span), unit = unitOf(), k = unit === 'usd' ? usdBtc() : 1;
  const T = tot(), spot = S.chart === 'locked' ? T?.locked : T?.out;
  const raw = heldBars(H.pts, { tf, since: range ? now() - range * 86400 : 0, spot: spot ?? null, scale: 1e8 });
  const bars = raw.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k, vol: b.vol }));
  const color = S.chart === 'locked' ? '#f7931a' : '#16a34a';
  chart.update({ series: [{ id: S.chart, name: KINDS[S.chart], color, kind: 'line', area: true, bars, fmt: fmtOf(unit), volFmt: (v) => (S.chart === 'locked' ? `${v.toFixed(4)} BTC` : `${grp(v, 2)} cUSD`) }], tags: bars.length ? [{ y: bars.at(-1).close, label: 'Now', color }] : [], empty: 'Nothing to draw for this range yet.', period: tf, label: `${KINDS[S.chart]}, ${range ? RANGE_WORDS[range] : 'all time'}` });
  S.view = { bars, unit, range };
  paintRead();
  $('#chart-note').textContent = (S.chart === 'locked'
    ? 'BTC in live locks. Spent or redeemed locks drop out.'
    : 'cUSD borrowed, minus repaid and liquidated.') + ` From the collateral engine’s events.${S.chart === 'locked' && unit === 'usd' ? ' In USD at today’s BTC price.' : ''}${H.exact ? '' : ' Past events do not add up exactly to today’s total, so the last point is the total.'}`;
}

// ── the ticket: size a lock's bond, then do it on tacit.finance ──
const getSats = () => parseUnits(S.amt, 8);
async function requote() {
  const sats = getSats(), my = ++S.seq;
  if (!sats) { D.size = null; renderRoute(); return; }
  D.size = { sats, loading: true }; renderRoute();
  try { const s = await sizeBond(sats); if (my === S.seq) D.size = { sats, ...s }; } catch { if (my === S.seq) D.size = { sats, err: true }; }
  renderRoute();
}
function renderRoute() {
  const z = D.size, el = $('#route'), px = usdBtc();
  // The front page's card opens on minting cBTC with the BTC typed here (an amount it would not read opens the plain lock step).
  const amt = String(S.amt || '').trim();
  $('#go').href = getSats() && /^\d{0,12}(?:\.\d{1,8})?$/.test(amt) ? `/#card=borrow:cbtc:mint&amt=${amt}` : '/#lock';
  $('#chips').innerHTML = PRESETS.map(([l, v]) => `<button type="button" data-amt="${v}" aria-pressed="${S.amt === v}">${l}</button>`).join('');
  if (!z) { el.innerHTML = ''; return; }
  if (z.loading) { el.innerHTML = '<div class="kv"><span>Bond</span><b class="mute">reading…</b></div>'; return; }
  if (z.err || z.eth == null) { el.innerHTML = '<p class="note">Could not size the bond. Try again in a moment.</p>'; return; }
  const max = px && D.engine?.ratio ? Number(z.sats) / 1e8 * px / (D.engine.ratio / 100) : null, ethTxt = fmtUnits(z.eth, 18, 4);
  el.innerHTML = `<div class="kv"><span>You get</span><b>${esc(btcTxt(z.sats))} cBTC${px ? ` <span class="mute">· ${compact(Number(z.sats) / 1e8 * px)}</span>` : ''}</b></div>
    <div class="kv"><span>ETH bond, at least</span><b>${esc(ethTxt)} ETH${ethUsd() ? ` <span class="mute">· ${compact(Number(z.eth) / 1e18 * ethUsd())}</span>` : ''}</b></div>
    ${max ? `<div class="kv"><span>Borrow up to</span><b>about ${esc(grp(max, max >= 100 ? 0 : 2))} cUSD <span class="mute">at the ${D.engine.ratio}% floor</span></b></div>` : ''}
    <p class="note">The bond is held as wstETH, 10% over the minimum, and its value moves with ETH. Minting opens about 4 hours after the lock confirms.</p>`;
}

// ── the key: sign in for the locks, the cBTC, the loans and the farm positions it holds ──
const key = makeKeySession({ moved: () => lockKey() });
const connect = makeConnect({ describe: 'Track cBTC', rows: () => (key.unlocked ? `<div class="kv"><span>Tacit wallet</span><b class="addr-s">${esc(key.key.address ? short(key.key.address, 6) : key.key.label || short(key.key.pubHex, 6))} <button class="linkbtn" type="button" id="sheet-lock">Lock</button></b></div>` : ''), onChange: () => {} });
const { wallet, W } = connect;
function pickProvider(list) { const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid; }
const signIn = () => signInSheet(key, { pick: pickProvider, why: 'Sign in to see your locks, cBTC and loans. Nothing is stored or sent.' });
let mineSeq = 0, histP = null, mineP = null, mineFor = null;
const history = () => (histP ||= import('/confidential-recovery-btc.js').then(({ makeBtcHistoryProvider }) => makeBtcHistoryProvider({ sha256, hrp: 'bc', fetchImpl: (u, o) => fetch(u, o) })));
function loadMine(force = false) {
  if (!key.unlocked) return Promise.resolve();
  if (!force && mineP && mineFor === key.key.pubHex) return mineP;                                   // a read for this key is under way: ask once, not twice
  mineFor = key.key.pubHex;
  return (mineP = readMine().finally(() => { mineP = null; }));
}
async function readMine() {
  const pub = key.key.pubHex, my = ++mineSeq, priv = () => key.priv();
  D.mine = { pub, loading: true }; renderMine();
  try {
    const ux = await getUx(), hist = await history();
    // Each read stands on its own: a failed one is said, the others still show.
    const [held, locks, loans] = await Promise.allSettled([readHeld({ ux, priv: priv() }), readLocks({ ux, priv: priv(), hist }), readLoans({ ux, priv: priv() })]);
    if (my !== mineSeq || key.key?.pubHex !== pub) return;
    const v = (r) => (r.status === 'fulfilled' ? r.value : null), why = (r) => (r.status === 'rejected' ? String(r.reason?.message || r.reason).slice(0, 140) : null);
    D.mine = { pub, held: v(held), locks: v(locks), loans: v(loans), errs: { held: why(held), locks: why(locks), loans: why(loans) }, at: now() };
  } catch (e) { if (my === mineSeq) D.mine = { pub, err: String(e?.message || e).slice(0, 160) }; }
  renderMine();
}
function lockKey() { key.lock(); forgetUx(); mineSeq++; D.mine = null; renderMine(); }
document.addEventListener('click', (e) => { if (e.target.id === 'sheet-lock') { lockKey(); e.target.closest('.bsheet')?.querySelector('.x')?.click(); } });
key.onChange(() => { if (key.unlocked && D.mine?.pub !== key.key.pubHex) loadMine(); else renderMine(); });
const mineOk = () => key.unlocked && D.mine?.pub === key.key.pubHex;
function renderMine() { renderLocks(); renderUse(); renderFarm(); renderPools(); }

// ── the locks on Bitcoin, and this key's ──
function renderLocks() {
  const T = tot(), px = usdBtc(), m = mineOk() ? D.mine : null;
  $('#lk-sum').innerHTML = T ? `<b class="num">${esc(btcTxt(T.locked))} BTC</b> locked${px != null ? ` · ${compact(Number(T.locked) / 1e8 * px)}` : ''}` : '';
  $('#lk-lead').innerHTML = '<b>Every cBTC is backed by BTC locked on Bitcoin.</b> The locks are public. Who holds the cBTC is private.';
  const lines = T ? [`<li><b>${grp(T.locks, 0)}</b> live lock${T.locks === 1 ? '' : 's'}</li>`, `<li><b>${grp(T.mints, 0)}</b> minted</li>`, T.waiting ? `<li><b>${grp(T.waiting, 0)}</b> waiting to mint</li>` : '', T.unlocked ? `<li><b>${grp(T.unlocked, 0)}</b> spent</li>` : '', T.redeemed ? `<li><b>${grp(T.redeemed, 0)}</b> redeemed</li>` : ''].filter(Boolean) : [];
  const f = $('#lk-facts'), fh = lines.join('');
  if (f.__h !== fh) { f.__h = fh; f.innerHTML = fh; }
  const box = $('#lk-mine');
  let h;
  if (!key.unlocked) h = '<p class="note"><button class="linkbtn" type="button" id="lk-signin">Sign in</button> to see your locks.</p>';
  else if (!m || m.loading) h = '<p class="note">Reading your locks…</p>';
  else if (m.err) h = `<p class="note err">${esc(m.err)} <button class="linkbtn" type="button" id="lk-re">Try again</button></p>`;
  else if (m.errs.locks) h = `<p class="note err">Could not read your locks: ${esc(m.errs.locks)} <button class="linkbtn" type="button" id="lk-re">Try again</button></p>`;
  else if (!m.locks?.length) h = '<p class="note">No locks yet. <a href="/#lock">Lock BTC →</a></p>';
  else h = `<table class="table lk"><thead><tr><th>Your lock</th><th class="r">Bitcoin</th><th>Next</th><th></th></tr></thead><tbody>${m.locks.map((l) => {
    const step = lockStep(l);
    return `<tr><td>${esc(short(l.lockTxid, 6))}:${l.lockVout}</td><td class="r num">${esc(btcTxt(l.sats))} BTC${px != null ? `<small>${compact(Number(l.sats) / 1e8 * px)}</small>` : ''}</td><td class="st ${l.minted ? 'ok' : 'wait'}">${esc(step)}</td><td class="go"><a href="${MEMPOOL}tx/${esc(l.lockTxid)}" target="_blank" rel="noopener noreferrer" aria-label="Open the lock’s transaction">↗</a></td></tr>`;
  }).join('')}</tbody></table><p class="note"><a href="/#lock">Manage your locks on tacit.finance →</a></p>`;
  if (box.__h !== h) { box.__h = h; box.innerHTML = h; }
  $('#lk-note').textContent = 'Lock, bond, mint and borrow on tacit.finance.';
}

// ── use cBTC ──
function renderUse() {
  const m = mineOk() ? D.mine : null, h = m?.held;
  const loans = m?.loans, owed = loans ? loans.reduce((a, l) => a + l.debt, 0n) : null;
  $('#held').innerHTML = !key.unlocked ? '<div class="held"><span class="mute">Sign in to see your cBTC and loans.</span><button class="linkbtn" type="button" id="signin">Sign in</button></div>'
    : !m || m.loading ? '<div class="held"><span class="mute">Reading your private cBTC…</span></div>'
    : m.err || m.errs.held ? `<div class="held"><span class="err">${esc(m.err || m.errs.held)}</span><button class="linkbtn" type="button" id="lk-re">Retry</button></div>`
    : `<div class="held"><span><b class="num">${esc(btcTxt(h.cbtc.value))}</b> <span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-cbtc"/></svg>cBTC, private</span></span><button class="linkbtn" type="button" id="lk-re">Refresh</button><button class="linkbtn" type="button" id="held-lock">Lock</button></div>
      ${owed != null ? `<div class="kv"><span>Borrowed against it</span><b>${loans.length ? `${esc(cusdTxt(owed))} cUSD in ${loans.length} loan${loans.length === 1 ? '' : 's'}` : 'nothing'}</b></div>` : m.errs.loans ? '<p class="note err">Could not read your loans.</p>' : ''}
      ${h.cusd.value > 0n ? `<div class="kv"><span>Private cUSD</span><b>${esc(cusdTxt(h.cusd.value))}</b></div>` : ''}${h.partial ? '<p class="note err">Could not read part of your balance. Refresh to try again.</p>' : ''}`;
  const rows = [['/#borrow', 'Borrow cUSD', 'Borrow dollars against your cBTC. Repay to unlock it.'],
    ['/#private/swap', 'Swap privately', (() => { const r = D.rows.find((x) => (x.depthUsd ?? 0) >= DUST_USD); return r?.per ? `${r.other} pool: 1 cBTC = ${sig(r.per, 4)} ${r.other}, ${compact(r.depthUsd)} deep.` : 'In the private pools.'; })()],
    ['#farm', 'Earn TAC', 'Join a farm with cBTC alone.', 'scroll'],
    ['/#lock', 'Take a bond back', 'Before minting, or after you redeem. Spending the BTC any other way forfeits it.']];
  $('#uses').innerHTML = rows.map(([href, t, sub, k]) => `<a class="use" href="${esc(href)}"${k === 'scroll' ? ' data-scroll' : ''}><b>${esc(t)}</b><span>${esc(sub)}</span><i aria-hidden="true">→</i></a>`).join('');
  $('#use-note').textContent = 'These open tacit.finance. Use the same wallet or passkey.';
}

// ── the pools that hold cBTC, and the farms that pay for them ──
function renderPools() {
  const rows = D.rows, tb = $('#pl-table tbody');
  if (!D.pools) { return; }
  const html = rows.length ? rows.map((r) => {
    const dust = (r.depthUsd ?? 0) < DUST_USD, apr = farmApr(r, D.program, { usdBtc: usdBtc(), ethUsd: ethUsd(), tacEth: D.rates.tacEth });
    return `<tr><td><b>${esc(r.name)}</b><small>${esc(r.fee / 100)}% fee · ${esc(grp(r.cbtc, r.cbtc < 1 ? 5 : 2))} cBTC + ${esc(grp(r.side, r.side < 1 ? 4 : 2))} ${esc(r.other)}</small></td><td class="r num">${dust ? '—' : usd(r.usd)}<small>${esc(sig(r.per, 4))} ${esc(r.other)}</small></td><td class="r opt num ${r.gap != null && Math.abs(r.gap) >= 0.05 ? 'down' : ''}">${dust || r.gap == null ? '' : esc(pct(r.gap))}</td><td class="r opt num">${r.depthUsd == null ? '' : dust ? 'dust' : compact(r.depthUsd)}</td><td class="r num">${r.farm ? `<a href="/#farm/private-${r.farm.pid}">${esc(aprTxt(apr))}</a><small>${esc(Math.round(r.farm.perDay).toLocaleString('en-US'))} TAC a day</small>` : '<span class="mute">not farmed</span>'}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="mute">No private pool holds cBTC yet.</td></tr>';
  if (tb.__h !== html) { tb.__h = html; tb.innerHTML = html; }
  const dusty = rows.filter((r) => (r.depthUsd ?? 0) < DUST_USD).length;
  $('#pl-sum').textContent = rows.length ? `${rows.length} pool${rows.length === 1 ? '' : 's'}` : '';
  $('#pl-note').textContent = `Swaps in these private pools happen at the pool’s price. Farms pay TAC to liquidity providers.${dusty ? ' Dust pools are too small to price.' : ''}`;
}
function renderFarm() {
  const p = D.program, e = p?.epoch, rows = D.rows.filter((r) => r.farm), px = usdBtc();
  if (!p) { $('#fm-stats').innerHTML = '<p class="note">Reading the farms…</p>'; return; }
  if (!e?.active || !rows.length) { $('#fm-stats').innerHTML = '<p class="note">No cBTC farms right now.</p>'; $('#pools').innerHTML = ''; $('#fm-note').textContent = ''; return; }
  const aprs = rows.map((r) => farmApr(r, p, { usdBtc: px, ethUsd: ethUsd(), tacEth: D.rates.tacEth })).filter((a) => a != null), day = rows.reduce((a, r) => a + r.farm.perDay, 0);
  const tacUsd = D.rates.tacEth && ethUsd() ? D.rates.tacEth * ethUsd() : null, end = Number(e.periodFinish) || null;
  const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  $('#fm-stats').innerHTML = cell('Best APR now', aprs.length ? aprTxt(Math.max(...aprs)) : '—', 'paid in TAC, swap fees on top')
    + cell('Rewards', `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>${Math.round(day).toLocaleString('en-US')} TAC`, `a day${tacUsd ? ` · about ${usd(day * tacUsd)}` : ''}`)
    + cell('Farms', `${rows.length}`, 'positions are private')
    + cell('Stream ends', end ? new Date(end * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const icon = (k) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${k}"/></svg>`, ico = { tETH: 'teth', TAC: 'tac', cUSD: 'cusd' };
  const mine = mineOk() ? positionsIn(D.rows, D.mine.held?.positions) : new Map(), amt = (x, d) => (x < 0.00001 && x > 0 ? 'under 0.00001' : grp(x, d));
  $('#pools').innerHTML = rows.map((r) => {
    const apr = farmApr(r, p, { usdBtc: px, ethUsd: ethUsd(), tacEth: D.rates.tacEth }), dust = (r.depthUsd ?? 0) < DUST_USD, m = mine.get(r.farm.pid);
    return `<a class="pf" href="/#farm/private-${r.farm.pid}"><span class="nm"><span class="pairtk">${icon('cbtc')}${icon(ico[r.other])}</span>${esc(r.name)}${m ? '<span class="tag">yours</span>' : ''}</span><span class="rt num">${esc(aprTxt(apr))}<small>${esc(Math.round(r.farm.perDay).toLocaleString('en-US'))} TAC a day</small></span><i aria-hidden="true">→</i><span class="sb">${r.depthUsd == null ? '' : `${dust ? 'under $25' : compact(r.depthUsd)} deep · `}${esc(grp(r.cbtc, r.cbtc < 1 ? 5 : 2))} cBTC + ${esc(grp(r.side, r.side < 1 ? 4 : 2))} ${esc(r.other)}</span>${m ? `<span class="sb mine">Yours: ${esc(amt(m.cbtc, 6))} cBTC + ${esc(amt(m.side, 4))} ${esc(r.other)} · ${esc(grp(m.earned, 2))} TAC earned${m.perDay > 0 ? ` · about ${esc(m.perDay >= 10 ? grp(m.perDay, 0) : m.perDay.toFixed(2))} TAC a day` : ''}</span>` : ''}</a>`;
  }).join('');
  $('#fm-note').innerHTML = `Join on tacit.finance with cBTC, the paired asset or both.`;
}

// ── about ──
function renderAbout() {
  const link = (a, t) => `<a href="${SCAN}address/${a}" target="_blank" rel="noopener noreferrer">${t || `${a.slice(0, 8)}…${a.slice(-6)}`}</a>`;
  $('#about').innerHTML = `<p><b>cBTC</b> is bitcoin you keep, usable privately on Ethereum. Lock BTC at your own address, post an ETH bond of at least 1.5× and mint the same amount. Then swap it, farm it or borrow cUSD against it.</p>
    <p>The backing is public. <a href="/weld/stats/">Stats →</a></p>`;
  const main = [
    ['On Bitcoin', 'Each lock is spendable only by its owner.'],
    ['On Ethereum', `The collateral engine ${link(ENGINE)} prices BTC, holds bonds as ${link(WSTETH, 'wstETH')} and lends cUSD at ${D.engine?.ratio ?? 150}% collateral, liquidating below ${D.engine?.liq ?? 130}%.`],
    ['Cost', 'A Bitcoin fee to lock. Minting is free. The bond keeps earning and comes back when you redeem.'],
  ];
  const more = [['The engine', `${link(ENGINE)} · prices BTC, holds bonds, lends cUSD`], ['The pool', `${link('0x000000000Ed1eabD231Be41d93b719056F7febFC')} · cBTC is asset <code>${CBTC_ID.slice(0, 10)}…${CBTC_ID.slice(-6)}</code>`],
    ['More', '<a href="/vault/#btc">Borrow →</a> · <a href="/rewards/#farms">Farms →</a> · <a href="/teth/">tETH →</a> · <a href="/weld/stats/">Stats →</a>']];
  const li = ([k, v]) => `<li><b>${esc(k)}</b><span>${v}</span></li>`;
  $('#facts').innerHTML = main.map(li).join('');
  $('#facts-more').innerHTML = more.map(li).join('');
}

// ── reading ──
async function loadHistory() { try { const h = await readHistory({ locked: D.totals?.locked ?? null, out: D.totals?.out ?? null }); D.hist = h; D.live = h.live; D.histFailed = false; } catch { D.histFailed = !D.hist; } }
async function loadTotals() { const j = await api('/stats?network=mainnet&view=front'); const t = totalsOf(j); if (t) D.totals = t; }
async function loadChain() { const [e, r] = await Promise.allSettled([readEngine(), readRates()]); if (e.status === 'fulfilled') D.engine = e.value; if (r.status === 'fulfilled') D.rates = r.value; }
async function loadPools() { const [pl, pg] = await Promise.allSettled([readPools(), readProgram()]); if (pl.status === 'fulfilled') D.pools = pl.value; if (pg.status === 'fulfilled' && pg.value?.epoch) D.program = pg.value; if (D.pools) D.rows = poolRows(D.pools, D.program, { ethUsd: ethUsd(), usdBtc: usdBtc(), tacEth: D.rates.tacEth }); }
function paintAll() { renderHead(); renderLanes(); renderChart(); renderBacking(); renderRoute(); renderLocks(); renderUse(); renderPools(); renderFarm(); renderAbout(); }

// ── wiring ──
function setMode(m) {
  S.mode = m;
  $('#mode-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#get').hidden = m !== 'get'; $('#use').hidden = m !== 'use';
  $('#stick-go').textContent = m === 'use' ? 'Use your cBTC' : 'Get cBTC';
  if (m === 'use' && key.unlocked && !D.mine) loadMine();
  try { history.replaceState(null, '', `${location.pathname}${location.search}${m === 'use' ? '#mode=use' : S.amt ? `#amount=${S.amt}` : ''}`); } catch { /* the address is a nicety */ }
}
let amtTimer = 0;
$('#amt').addEventListener('input', (e) => { S.amt = e.target.value; clearTimeout(amtTimer); amtTimer = setTimeout(requote, 250); });
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-amt]'); if (!b) return; S.amt = b.dataset.amt; $('#amt').value = S.amt; requote(); });
$('#mode-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
$('#backing').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.chart) { S.chart = b.dataset.chart; S.range = null; } else if (b.dataset.unit) S.unit = b.dataset.unit; else if (b.dataset.range != null) S.range = Number(b.dataset.range); else return;
  renderChart();
});
document.addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'signin' || id === 'lk-signin') signIn().then(() => loadMine()).catch(() => {});
  else if (id === 'lk-re') loadMine(true);
  else if (id === 'held-lock') lockKey();
  const a = e.target.closest('[data-scroll]');
  if (a) { e.preventDefault(); $('#farm').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  const h = $('#hints'); if (h.open && !h.contains(e.target)) h.open = false;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#hints').open) { $('#hints').open = false; $('#hints summary').focus(); } });
{
  const stick = $('#stick'), ticket = $('.p-ticket');
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { stick.hidden = e.isIntersecting; }, { rootMargin: '0px 0px -40px 0px' }).observe(ticket);
  $('#stick-go').addEventListener('click', () => ticket.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

renderRoute(); renderAbout(); renderLanes(); renderLocks(); renderUse(); renderChart();
const totals = loadTotals().then(() => { renderHead(); renderBacking(); renderLocks(); });
totals.catch(() => {}).then(() => loadHistory()).then(paintAll);          // the events are checked against the totals, so they follow them; the pools and farms need not come first
Promise.allSettled([totals, loadChain().then(() => { renderHead(); renderBacking(); return loadPools(); }).then(paintAll)]).then(() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('mode') === 'use') setMode('use');
  if (params.get('amount')) { S.amt = params.get('amount'); $('#amt').value = S.amt; requote(); }
  paintAll();
});
let tick = 0;
setInterval(() => { if (!document.hidden) { loadTotals().then(paintAll).catch(() => {}); loadChain().then(() => loadPools()).then(paintAll).catch(() => {}); if (++tick % 5 === 0) loadHistory().then(paintAll); } }, 60e3);
