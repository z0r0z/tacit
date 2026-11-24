// The BTC and ETH page (/btc/): the swap card's Bitcoin and Ethereum lane on a page of its own (swap/atomic.js, mounted as the card mounts it), the providers of the
// pair with what each takes and holds (swap/atomic-market.js, read with no wallet open), the visitor's own swaps with a copy of them to keep, and how to become a provider.
//
// A link names the way and the amount: /btc/?dir=e2b&amt=0.05 (or ?from=ETH&to=BTC&amt=0.05, as the front page's card writes it); the address follows the lane.
import { makeAtomicLane, fmt } from '/swap/atomic.js?cb=8d3ff349';
import { readMarket, estimate, takeable, feeAtMin } from '/swap/atomic-market.js?cb=c19ede9d';
import { getUx as loadUx } from '/trade/poolux.js?cb=59d125e5';
import { connectedInjected } from '/eth-nodes.js';
import { esc } from '/trade/util.js?cb=9c8b4133';

const $ = (id) => document.getElementById(id);
const MARKET_MS = 60000;

// ── what a link asks for ──
function asked() {
  const q = new URLSearchParams(location.search), f = String(q.get('from') || '').toUpperCase(), t = String(q.get('to') || '').toUpperCase(), d = String(q.get('dir') || '').toLowerCase();
  const dir = d === 'e2b' || (f === 'ETH' && t === 'BTC') ? 'e2b' : 'b2e', a = q.get('amt') || '';
  return { dir, amt: /^\d{0,12}(?:\.\d{1,8})?$/.test(a) ? a : '' };
}
function follow(st) {
  if (!history.replaceState) return;
  const q = new URLSearchParams();
  if (st.dir === 'e2b') q.set('dir', 'e2b');
  if (st.amt && /^\d{0,12}(?:\.\d{1,8})?$/.test(st.amt)) q.set('amt', st.amt);
  const want = `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`;
  if (want !== location.pathname + location.search + location.hash) history.replaceState(null, '', want);
}

// ── a line at the foot of the window, and the tab's title while it is hidden ──
const TITLE = document.title;
let sayTimer = 0;
function notify(m) {
  const el = $('say');
  el.textContent = String(m); el.hidden = false;
  clearTimeout(sayTimer); sayTimer = setTimeout(() => { el.hidden = true; }, 5000);
  if (document.hidden) document.title = `• ${m} · ${TITLE}`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = TITLE; });

// ── the market: one read shared by the lane and the providers' list, again each minute while the page is seen ──
let mkP = null, mkAt = 0;
function market() {
  if (!mkP || Date.now() - mkAt > MARKET_MS - 5000) {
    mkAt = Date.now();
    const p = readMarket().then((m) => { const x = { ...m, estimate: (d, a) => estimate(m, d, a) }; paintProviders(x); return x; });
    p.catch(() => { if (mkP === p) mkP = null; paintProviders(null); });
    mkP = p;
  }
  return mkP;
}
setInterval(() => { if (!document.hidden) market().catch(() => {}); }, MARKET_MS);

const sats = (n) => `${Number(n).toLocaleString('en-US')} sats`;
const pctTxt = (x) => `${x < 1 ? x.toFixed(2) : x.toFixed(1)}%`;
const feeTxt = (s, dir) => {
  const share = s.feeBps ? `${(s.feeBps / 100).toFixed(s.feeBps % 10 ? 2 : 1).replace(/\.0$/, '')}%` : '';
  const flat = s.flatFee > 0n ? (dir === 'b2e' ? sats(s.flatFee) : `${fmt(s.flatFee)} ETH`) : '';
  const at = feeAtMin(s);
  return `${[share, flat].filter(Boolean).join(' + ') || 'no fee'}${flat && at != null ? ` (${pctTxt(at)} at the minimum)` : ''}`;
};
// an amount of 8 places to its first two figures, rounded down, so it never says more than there is: 0.00753023 -> 0.0075, 0.07043193 -> 0.070, 1.53 -> 1.5
const twoFigures = (v) => {
  const s = BigInt(v).toString(), cut = Math.max(0, s.length - 2), dec = Math.max(0, 8 - cut);
  const kept = ((BigInt(v) / 10n ** BigInt(cut)) * 10n ** BigInt(cut)).toString().padStart(9, '0');
  return dec ? `${kept.slice(0, -8)}.${kept.slice(-8, -8 + dec || undefined)}` : kept.slice(0, -8);
};
const SYM = { b2e: 'BTC', e2b: 'ETH' };
function side(s, dir) {
  const head = dir === 'b2e' ? '<b><svg class="tk" aria-hidden="true"><use href="#tk-btc"/></svg>BTC → ETH</b>' : '<b><svg class="tk" aria-hidden="true"><use href="#tk-eth"/></svg>ETH → BTC</b>';
  if (!s) return `<div class="d">${head}<span>not offered</span></div>`;
  const n = takeable(s), u = SYM[dir];
  return `<div class="d">${head}<span class="num">${esc(fmt(s.min))} to ${esc(fmt(s.max))} ${u}</span>`
    + `<span class="num${n >= s.min ? '' : ' off'}">${n >= s.min ? `${esc(fmt(n))} ${u} available now` : 'full right now'}</span><span>fee ${esc(feeTxt(s, dir))}</span></div>`;
}
function paintProviders(m) {
  const list = $('pv-list'), cap = $('cap'), live = $('live');
  if (!m) { cap.textContent = 'The boards could not be read just now.'; return; }
  const ps = m.providers || [], tb = m.totals?.b2e, te = m.totals?.e2b;
  const nowB = tb && tb.now > 0n ? `${fmt(tb.now)} BTC` : null, nowE = te && te.now > 0n ? `${fmt(te.now)} ETH` : null;
  $('pv-at').textContent = ps.length ? `${ps.length} online` : '';
  cap.innerHTML = !ps.length ? 'No provider is online right now. A swap waits for one; anyone can become one, below.'
    : `Now, in one swap: ${nowB ? `up to <b class="num">${esc(nowB)}</b> for ETH` : 'no BTC for ETH'}, and ${nowE ? `up to <b class="num">${esc(nowE)}</b> for BTC` : 'no ETH for BTC'}.`;
  list.innerHTML = ps.length ? ps.map((p) => `<li data-pv="${esc(p.id)}"><span class="nm"><b>${esc(p.name)}</b><span class="num">${esc(String(p.id).slice(0, 10))}…</span></span>${side(p.b2e, 'b2e')}${side(p.e2b, 'e2b')}</li>`).join('') : '';
  // the line at the top: each part kept whole (the line breaks between them), and what can be swapped now to two figures, rounded down
  const bits = [];
  if (m.rate) bits.push(`<b class="num">1 BTC = ${esc(m.rate.toLocaleString('en-US', { maximumFractionDigits: m.rate >= 100 ? 1 : 3 }))} ETH</b>`);
  bits.push(ps.length ? `${ps.length} provider${ps.length === 1 ? '' : 's'} online` : 'no provider online');
  const upB = tb && tb.now > 0n ? `${twoFigures(tb.now)} BTC` : null, upE = te && te.now > 0n ? `${twoFigures(te.now)} ETH` : null;
  if (upB || upE) bits.push(`up to ${[upB, upE].filter(Boolean).map(esc).join(' or ')} now`);
  live.innerHTML = bits.map((b) => `<span>${b}</span>`).join(' · ');
}

// ── the lane ──
// the pool module reads Ethereum through public nodes and, last, a wallet the site is already connected to; a settle the relay holds is sent from that wallet
const getUx = async () => { const ux = await loadUx(); ux.useWallet?.(() => connectedInjected()); return ux; };
const first = asked();
const lane = makeAtomicLane({
  host: $('atomic'), recsHost: $('mine-list'), notify, wallet: () => null, provider: () => connectedInjected(), getUx, market, dir: first.dir,
  onState: () => follow(lane.state()),
  onRecs: (recs) => paintMine(recs),
});

// (the swaps of an earlier visit are looked for on the chains for a minute or two after the wallet opens: until that ends the list says so, never 'No swaps yet')
function paintMine(recs) {
  const open = lane.unlocked, look = lane.looking;
  $('mine-say').textContent = !open ? 'Open your Tacit wallet above to see your swaps.'
    : look === 'failed' ? `Your ${recs.length ? 'other ' : ''}past swaps could not be looked for just now. Trying again.`
      : look ? (recs.length ? 'Looking for more of your past swaps…' : 'Looking for your past swaps on Bitcoin and Ethereum. This can take a minute or two.')
        : recs.length ? '' : 'No swaps yet. A swap you start shows here, with its steps.';
  $('mine-keep').hidden = !open;
}
// a copy of the swaps as a file: a swap of ETH for BTC is found again from this copy or this browser's storage, not from the key alone
$('keep-save').addEventListener('click', () => {
  const k = lane.keep(), st = $('mine-st');
  if (!k) { st.textContent = 'Open your Tacit wallet first.'; return; }
  const blob = new Blob([JSON.stringify(k.save(), null, 1)], { type: 'application/json' }), url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `tacit-btc-eth-swaps-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  st.textContent = 'Saved. Keep it until your swaps are done.';
});
$('keep-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0], k = lane.keep(), st = $('mine-st');
  e.target.value = '';
  if (!f) return;
  if (!k) { st.textContent = 'Open your Tacit wallet first.'; return; }
  try { const n = k.load(await f.text()); st.textContent = n ? `${n} record${n === 1 ? '' : 's'} read back.` : 'Nothing new in that copy.'; await lane.reread(); }
  catch (err) { st.textContent = String(err?.message || 'That file could not be read.'); }
});

// the commands copy with one press
for (const pre of document.querySelectorAll('.cmd pre')) {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Copy' });
  b.setAttribute('aria-label', 'Copy the command');
  b.addEventListener('click', () => navigator.clipboard?.writeText(pre.textContent).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }, () => { b.textContent = 'Select it'; }));
  pre.parentElement.append(b);
}

if (first.amt) lane.set({ amt: first.amt });
market().catch(() => {});
lane.show();
