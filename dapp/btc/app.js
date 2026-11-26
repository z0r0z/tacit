// The BTC and ETH page (/btc/): the swap card's Bitcoin and Ethereum lane on a page of its own (swap/atomic.js, mounted as the card mounts it), the providers of the
// pair with what each takes and holds (swap/atomic-market.js, read with no wallet open), the visitor's own swaps with a copy of them to keep, and how to become a provider.
//
// A link names the way and the amount: /btc/?dir=e2b&amt=0.05 (or ?from=ETH&to=BTC&amt=0.05, as the front page's card writes it); the address follows the lane.
import { makeAtomicLane, fmt } from '/swap/atomic.js?cb=432caf87';
import { readMarket, estimate, takeable, feeAtMin } from '/swap/atomic-market.js?cb=ccfdb3d0';
import { getUx as loadUx } from '/trade/poolux.js?cb=59d125e5';
import { connectedInjected } from '/eth-nodes.js';
import { esc } from '/trade/util.js?cb=9c8b4133';
import { makeAddEth } from '/btc/add-eth.js?cb=d423798a';
import { mountSendPanel } from '/btc/panel.js?cb=4e01aedd';
import { makePayout } from '/btc/payout.js?cb=3b028d52';

const $ = (id) => document.getElementById(id);
const MARKET_MS = 60000;
// Tacit's own provider of the pair: its /info carries what its fees came to and where they go (fastbridge-lp README, "Upkeep")
const HOUSE = 'https://tacit-fastbridge-pair-lp.onrender.com', FUND_MS = 300000;

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
// While a swap is under way the tab says so in its title, seen or hidden, so a tab among many is not closed by mistake; it is put back when none is left
let underway = false;
const UNDERWAY = 'Swap under way, keep open';
function titleFor(recs) {
  underway = recs.some((r) => r.state === 'working');
  document.title = underway ? `${UNDERWAY} · ${TITLE}` : TITLE;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = underway ? `${UNDERWAY} · ${TITLE}` : TITLE; });

// ── the market: one read shared by the lane and the providers' list, again each minute while the page is seen ──
let mkP = null, mkAt = 0;
function market() {
  if (!mkP || Date.now() - mkAt > MARKET_MS - 5000) {
    mkAt = Date.now();
    const p = readMarket().then((m) => { const x = { ...m, estimate: (d, a) => estimate(m, d, a) }; paintProviders(x); return x; });
    fund();
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
  const n = takeable(s), u = SYM[dir], f = feeTxt(s, dir), at = f.indexOf(' (');
  // (what the fee is at the minimum stays whole: the line breaks before it)
  const fee = at < 0 ? esc(f) : `${esc(f.slice(0, at))} <span class="nw">${esc(f.slice(at + 1))}</span>`;
  return `<div class="d">${head}<span class="num">${esc(fmt(s.min))} to ${esc(fmt(s.max))} ${u}</span>`
    + `<span class="num${n >= s.min ? '' : ' off'}">${n >= s.min ? `${esc(fmt(n))} ${u} available now` : 'full right now'}</span><span>fee ${fee}</span></div>`;
}
function paintProviders(m) {
  const list = $('pv-list'), cap = $('cap'), live = $('live');
  if (!m) { cap.textContent = 'The boards could not be read just now.'; setSum('pv-at', 'not read just now'); return; }
  const ps = m.providers || [], tb = m.totals?.b2e, te = m.totals?.e2b;
  const nowB = tb && tb.now > 0n ? `${fmt(tb.now)} BTC` : null, nowE = te && te.now > 0n ? `${fmt(te.now)} ETH` : null;
  cap.innerHTML = !ps.length ? 'No provider is online. Swaps wait for one. Run one below.'
    : `Now, in one swap: ${nowB ? `up to <b class="num">${esc(nowB)}</b> for ETH` : 'no BTC for ETH'}, and ${nowE ? `up to <b class="num">${esc(nowE)}</b> for BTC` : 'no ETH for BTC'}.`;
  list.innerHTML = ps.length ? ps.map((p) => `<li data-pv="${esc(p.id)}"><span class="nm"><b>${esc(p.name)}</b><span class="num">${esc(String(p.id).slice(0, 10))}…</span></span>${side(p.b2e, 'b2e')}${side(p.e2b, 'e2b')}</li>`).join('') : '';
  // the line at the top: each part kept whole (the line breaks between them), and what can be swapped now to two figures, rounded down
  const bits = [];
  if (m.rate) bits.push(`<b class="num">1 BTC = ${esc(m.rate.toLocaleString('en-US', { maximumFractionDigits: m.rate >= 100 ? 1 : 3 }))} ETH</b>${m.rateAt ? ` <span class="mute">(price from ${Math.max(1, Math.round((Date.now() / 1000 - m.rateAt) / 60))} min ago)</span>` : ''}`);
  bits.push(ps.length ? `${ps.length} provider${ps.length === 1 ? '' : 's'} online` : 'no provider online');
  const upB = tb && tb.now > 0n ? `${twoFigures(tb.now)} BTC` : null, upE = te && te.now > 0n ? `${twoFigures(te.now)} ETH` : null;
  if (upB || upE) bits.push(`up to ${[upB, upE].filter(Boolean).map(esc).join(' or ')} now`);
  setSum('pv-at', ps.length ? `${ps.length} online${upB || upE ? ` · up to ${[upB, upE].filter(Boolean).join(' or ')}` : ''}` : 'none online');
  live.innerHTML = bits.map((b) => `<span>${b}</span>`).join(' · ');
}

// ── the house provider's fees: back into its capacity up to its target, then to TAC buybacks (a line, a bar, the figures; nothing when it does not say) ──
let fundAt = 0;
function fund() {
  if (Date.now() - fundAt < FUND_MS) return;
  fundAt = Date.now();
  fetch(`${HOUSE}/info`, { cache: 'no-cache', signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).then(paintFund, () => paintFund(null));
}
const eth2 = (v) => (BigInt(v) > 0n ? twoFigures(v) : '0');
const tacTxt = (wei) => { const t = Number(BigInt(wei || 0) / 10n ** 14n) / 1e4; return t.toLocaleString('en-US', { maximumFractionDigits: t < 100 ? 2 : 0 }); };
function paintFund(i) {
  const el = $('pv-fund'), s = i && i.stats, t = i && i.target, b = (i && i.buyback) || {};
  let ok = false;
  try {
    if (s && t && s.capacity) {
      const goal = BigInt(t.eth) + BigInt(t.btcAsEth), have = BigInt(s.capacity.valueEth), re = BigInt(s.reinvestedEth || 0);
      const pct = goal > 0n ? Math.min(100, Number((have * 1000n) / goal) / 10) : 0;
      const since = new Date(Number(s.since) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const figs = [t.reached ? `<b class="num">${esc(eth2(have))}</b> ETH, at its target` : `<b class="num">${esc(eth2(have))}</b> of ${esc(eth2(goal))} ETH`, re > 0n ? `${esc(fmt(re))} ETH of fees reinvested since ${esc(since)}` : `fees counted since ${esc(since)}`];
      if (b.startedAt || BigInt(b.routedEth || 0) > 0n) figs.push(`${esc(tacTxt(b.tacBought))} TAC bought`);
      el.innerHTML = `<p>Tacit’s provider puts its fees, after network costs, back into its capacity until it holds ${esc(eth2(t.eth))} ETH and as much in BTC. Past that, they go to TAC buybacks.</p>`
        + `<div class="bar" role="progressbar" aria-label="Capacity against that target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i></i></div>`
        + `<p class="fig">${figs.map((f) => `<span>${f}</span>`).join(' · ')}</p>`;
      el.querySelector('.bar i').style.width = `${pct}%`;
      ok = true;
    }
  } catch { ok = false; }
  el.hidden = !ok;
}

// ── the sections under the tile: disclosures (<details>), closed by default and remembered per section ──
// Opened by the page, not the visitor (a swap under way or needing attention, a send or a receipt, a link to the section), a section is not remembered as chosen.
const DD_KEY = 'tacit-btc-open';
const ddPref = () => { try { const o = JSON.parse(localStorage.getItem(DD_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const ddSave = (id, on) => { try { localStorage.setItem(DD_KEY, JSON.stringify({ ...ddPref(), [id]: on ? 1 : 0 })); } catch { /* a convenience */ } };
const autoToggle = new Set();
function ddOpen(id, on = true) {
  const d = $(id);
  if (!d || d.open === on) return;
  autoToggle.add(id); d.open = on;
}
for (const d of document.querySelectorAll('details[data-dd]')) {
  if (ddPref()[d.id] === 1) d.open = true;
  d.addEventListener('toggle', () => { if (autoToggle.delete(d.id)) return; ddSave(d.id, d.open); });
}
// a link to a section (or to something inside one) opens it and goes there
function ddHash() {
  let id = ''; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const el = id && document.getElementById(id), d = el && el.closest('details[data-dd]');
  if (!d) return;
  ddOpen(d.id);
  // (again once the section has opened out: until then the page is too short to scroll that far)
  requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  setTimeout(() => el.scrollIntoView({ block: 'start' }), 320);
}
addEventListener('hashchange', ddHash);
ddHash();
// each section's one line: what it holds
const setSum = (id, t) => { const el = $(id); if (el && el.textContent !== t) el.textContent = t; };
const recDir = new Map(), seenWorking = new Set(), flagged = new Set(), mineSeen = new Set();
let minePrimed = false;
function mineSummary() {
  const list = $('mine-list'), cards = [...list.querySelectorAll(':scope > div[data-rec]')];
  const w = cards.filter((c) => c.classList.contains('wait')), dn = cards.filter((c) => c.classList.contains('ok')), wn = cards.filter((c) => c.classList.contains('warn'));
  const attn = new Set([...wn, ...list.querySelectorAll('small.slow, small.paid.err')].map((e) => (e.closest('[data-rec]') || e).dataset.rec));
  const fresh = new Set();
  for (const c of w) { seenWorking.add(c.dataset.rec); fresh.add(c.dataset.rec); }
  for (const c of dn) if (seenWorking.has(c.dataset.rec)) fresh.add(c.dataset.rec);
  for (const id of attn) fresh.add(`!${id}`);
  // a receipt: a swap seen under way that is now done delivers to the other side
  for (const c of dn) {
    const id = c.dataset.rec;
    if (seenWorking.has(id) && !flagged.has(id)) { flagged.add(id); if (minePrimed) ddOpen(recDir.get(id) === 'e2b' ? 'mybtc' : 'myeth'); }
  }
  let grew = false;
  for (const id of fresh) if (!mineSeen.has(id)) { mineSeen.add(id); grew = true; }
  if (grew) ddOpen('mine');
  minePrimed = true;
  const bits = [];
  if (w.length) bits.push(`${w.length} in progress`);
  if (attn.size) bits.push(`${attn.size} need${attn.size === 1 ? 's' : ''} attention`);
  if (dn.length) bits.push(`${dn.length} done`);
  setSum('mine-sum', bits.length ? bits.join(' · ') : lane.unlocked ? (lane.looking ? 'looking for your swaps…' : 'none yet') : 'open your wallet');
}
function walletSummaries() {
  setSum('yb-sum', !$('yb-box').hidden ? $('yb-bal').textContent : 'address, balance, send');
  setSum('ye-sum', !$('ye-box').hidden ? `${$('ye-bal').textContent.replace(/ ETH$/, '')} private` : 'private balance, send');
}
function ddWatch() {
  new MutationObserver(mineSummary).observe($('mine-list'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const w = new MutationObserver(walletSummaries), o = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] };
  w.observe($('yb'), o); w.observe($('ye-box'), o);
}

// ── the lane ──
// the pool module reads Ethereum through public nodes and, last, a wallet the site is already connected to; a settle the relay holds is sent from that wallet
const getUx = async () => { const ux = await loadUx(); ux.useWallet?.(() => connectedInjected()); return ux; };
const first = asked();
// ETH short for a swap of ETH: added from the Ethereum wallet in one transaction (btc/add-eth.js), and the address's own BTC sent anywhere (btc/panel.js)
// and the ETH of a swap of BTC sent on to an Ethereum address once it has arrived, if the visitor asks (btc/payout.js)
let panel = null;
const payout = makePayout({ getUx });
const lane = makeAtomicLane({
  host: $('atomic'), recsHost: $('mine-list'), notify, wallet: () => null, provider: () => connectedInjected(), getUx, market, dir: first.dir,
  shield: makeAddEth({ getUx }), payout,
  onState: () => follow(lane.state()),
  onKey: () => paintChip(),
  onRecs: (recs) => { titleFor(recs); for (const r of recs) recDir.set(r.id, r.dir); paintMine(recs); panel?.paint(); paintEth(); },
  onBal: () => { panel?.paint(); paintEth(); },
  onOpen: () => { panel?.paint(); paintEth(); },
  // a finished swap's "Send BTC": the panel's send, the amount that arrived filled in
  // and a finished swap of BTC's "Send to an Ethereum address": where, and the relay's fee, asked first
  onNext: ({ act, sats, id, units }) => { if (act === 'send') { ddOpen('mybtc'); panel?.openSend({ sats }); } else if (act === 'withdraw') withdraw({ id, units }).catch(() => {}); },
});
// the header chip: the same sign-in as the card's button; once open, the wallet's address and a way to lock it
let tacitOf = null, tacitAsked = false;
function paintChip() {
  const on = lane.unlocked, a = lane.address;
  $('wallet-dot').className = `dot${on ? ' on' : ''}`;
  $('acct-id').textContent = a || '';
  // the chip names the key by its tacit1 address, as the front page does (its first 16 characters and last 6)
  if (!on) { $('acct-tacit').textContent = ''; tacitOf = null; tacitAsked = false; }
  else if (!tacitAsked) { tacitAsked = true; Promise.resolve(lane.tacitAddress?.()).then((t) => { tacitOf = t; if (t) { $('acct-tacit').textContent = t; $('wallet-label').textContent = `${t.slice(0, 16)}…${t.slice(-6)}`; } }, () => {}); }
  $('wallet-label').textContent = on ? (tacitOf ? `${tacitOf.slice(0, 16)}…${tacitOf.slice(-6)}` : a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'Signed in') : 'Sign in';
  if (!on) { $('acct-pop').hidden = true; $('wallet').setAttribute('aria-expanded', 'false'); }
}
$('wallet').addEventListener('click', () => {
  if (!lane.unlocked) { lane.signIn().then(paintChip, paintChip); return; }
  const pop = $('acct-pop'); pop.hidden = !pop.hidden; $('wallet').setAttribute('aria-expanded', String(!pop.hidden));
});
$('acct-pop').addEventListener('click', (e) => { const c = e.target.closest('[data-copy]'); if (c) { try { navigator.clipboard.writeText($(c.dataset.copy).textContent).then(() => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); }, () => {}); } catch { /* no clipboard */ } return; } if (e.target.closest('[data-acct="out"]')) { $('acct-pop').hidden = true; lane.lock(); paintChip(); } });
document.addEventListener('click', (e) => { if (!e.target.closest('#acct')) { $('acct-pop').hidden = true; $('wallet').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('acct-pop').hidden = true; $('wallet').setAttribute('aria-expanded', 'false'); } });
panel = mountSendPanel({ host: $('yb'), lane, notify });
// what the lane reads once the key opens is read ahead as soon as the visitor shows an interest in it (a link that names an amount, a hover, a tap): the
// signature then has less to wait on. Signing in does the same.
const warm = () => lane.warm();
if (first.amt) warm();
for (const ev of ['pointerenter', 'focusin', 'touchstart']) $('atomic').addEventListener(ev, warm, { once: true, passive: true });

// Private ETH sent to an Ethereum address: the key's own (the wallet sheet's) or one typed and checked, with what arrives after the relay's fee said before
// the press. From a finished swap of BTC whose amount is known (`id`, `units`), the lane sends it and says so on the swap's card; otherwise (the "Your ETH"
// panel, or a swap found again from the key, which does not know its amount) the amount is chosen here, up to the largest private amount that goes in one
// withdrawal (Max), and the dialog sends it and shows the Etherscan link.
async function withdraw({ id = null, units = null } = {}) {
  const { overlay } = await import('/trade/sheet.js?cb=d857446c');
  const o = overlay({ title: 'Send ETH to an address' });
  const own = lane.ethAddress(), fixed = units != null && units > 0n;
  const field = 'min-height:40px;padding:6px 10px;font:13px var(--mono, monospace)';
  o.body.innerHTML = `<p style="margin:0 0 12px">${fixed ? `${esc(fmt(units))} ETH from this swap` : 'ETH'} sent from your private balance to an Ethereum address. A small fee comes out of it.</p>
    ${fixed ? '' : `<div style="display:flex;gap:8px;align-items:center;margin:0 0 12px"><input data-amt inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="Amount of ETH" style="${field};flex:1;min-width:0"><span>ETH</span><button class="btn ghost" type="button" data-max disabled>Max</button></div>`}
    <div class="pt" style="display:grid;gap:8px">
      ${own ? `<label style="display:flex;gap:8px;align-items:baseline"><input type="radio" name="wd-to" value="own" checked><span>Your Tacit Ethereum address <code>${esc(own.slice(0, 6))}…${esc(own.slice(-4))}</code></span></label>` : ''}
      <label style="display:flex;gap:8px;align-items:baseline"><input type="radio" name="wd-to" value="other"${own ? '' : ' checked'}><span>Another address</span></label>
      <input data-addr placeholder="0x…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Ethereum address" style="${field}"${own ? ' hidden' : ''}>
    </div>
    <p data-say role="status" style="margin:12px 0 0"></p>
    <p class="note" style="margin:8px 0 0">It is public from that address on. ${fixed ? 'Sending it all right after the swap makes the two easy to match.' : 'An amount sent soon after a swap of the same size is easy to match.'}</p>
    <div class="bsheet-actions" style="margin-top:14px"><button class="btn" type="button" data-go disabled>Send</button><button class="btn ghost" type="button" data-x>Cancel</button></div>`;
  const q = (s) => o.body.querySelector(s), addr = q('[data-addr]'), amt = q('[data-amt]'), say = q('[data-say]'), go = q('[data-go]');
  let fee = null, feeFor = null, max = null, busy = false, seq = 0;
  const target = () => (o.body.querySelector('input[name="wd-to"]:checked')?.value === 'own' ? own : payout.checkAddress(addr.value).address || null);
  const amount = () => { if (fixed) return units; const t = (amt.value || '').trim(); if (!/^\d{0,8}(\.\d{1,8})?$/.test(t) || !t || t === '.') return null; const [w, f = ''] = t.split('.'); const v = BigInt(w || '0') * 100000000n + BigInt((f + '00000000').slice(0, 8)); return v > 0n ? v : null; };
  const paint = () => {
    if (busy) return;
    const other = o.body.querySelector('input[name="wd-to"]:checked')?.value !== 'own', t = target(), chk = payout.checkAddress(addr.value), v = amount();
    addr.hidden = !other;
    if (v && v !== feeFor) { const my = ++seq; feeFor = v; fee = null; payout.quote(v).then((f) => { if (my === seq) { fee = f; paint(); } }, () => { if (my === seq) { say.textContent = 'The fee could not be read just now. Try again soon.'; } }); }
    const tooMuch = !fixed && v && max != null && v > max, tooLittle = v && fee && fee.net <= 0n;
    go.disabled = !t || !v || !fee || feeFor !== v || tooMuch || tooLittle;
    say.textContent = other && addr.value.trim() && !chk.ok ? chk.why
      : !fixed && !v ? (max == null ? 'Reading your private ETH…' : max > 0n ? `Up to ${fmt(max)} ETH goes in one send.` : 'Your private balance holds no ETH to send.')
        : tooMuch ? `At most ${fmt(max)} ETH goes in one send: your private ETH is held in more than one amount. Send that, then the rest.`
          : tooLittle ? 'That is less than the relay’s fee.'
            : fee && feeFor === v ? `The relay’s fee is about ${fmt(fee.fee)} ETH: about ${fmt(fee.net)} ETH arrives${t ? ` at ${t.slice(0, 6)}…${t.slice(-4)}` : ''}.` : 'Reading the relay’s fee…';
  };
  o.body.addEventListener('change', paint); addr.addEventListener('input', paint); amt?.addEventListener('input', paint);
  q('[data-max]')?.addEventListener('click', () => { if (max > 0n) { amt.value = fmt(max); paint(); } });
  q('[data-x]').onclick = () => o.close();
  go.onclick = async () => {
    const t = target(), v = amount();
    if (!t || !v) return;
    if (fixed && id) { lane.payTo(id, t); o.close(); return; }
    busy = true; go.disabled = true; q('[data-x]').textContent = 'Close';
    say.textContent = 'Sending… this takes a few minutes. You can close this.';
    try {
      const r = await lane.sendEth({ units: v, to: t });
      say.innerHTML = `Sent: about ${esc(fmt(r.net || v))} ETH to ${esc(t.slice(0, 6))}…${esc(t.slice(-4))}.${/^0x[0-9a-f]{64}$/i.test(r.txHash || '') ? ` <a href="https://etherscan.io/tx/${esc(r.txHash)}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a>` : ''}`;
      notify('ETH sent to your address'); ddOpen('myeth');
    } catch (e) { busy = false; say.textContent = `Couldn’t send: ${String(e?.message || 'try again in a moment').replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, '$1.')}`; go.disabled = false; }
  };
  if (!fixed) lane.largestEth().then((m) => { max = m; q('[data-max]').disabled = !(m > 0n); paint(); }, () => { max = 0n; paint(); });
  paint();
}

// "Your ETH": the private ETH balance, and a send of it to an Ethereum address (the dialog above)
function paintEth() {
  const box = $('ye-box'), say = $('ye-say'), on = lane.unlocked && lane.bitcoin();
  box.hidden = !on; say.hidden = !!on;
  if (!on) { say.textContent = lane.unlocked ? 'Reading your private ETH…' : 'Sign in above to see your private ETH.'; return; }
  const b = lane.balances(), held = b.ethHeld ?? b.eth;
  $('ye-bal').textContent = held == null ? 'reading…' : `${fmt(held)} ETH`;
  $('ye-send').disabled = !(held > 0n);
}
$('ye-send').addEventListener('click', () => withdraw({}).catch(() => {}));

// (the swaps of an earlier visit are looked for on the chains for a minute or two after the wallet opens: until that ends the list says so, never 'No swaps yet')
function paintMine(recs) {
  const open = lane.unlocked, look = lane.looking;
  $('mine-say').textContent = !open ? 'Sign in above to see your swaps.'
    : look === 'failed' ? `Your ${recs.length ? 'other ' : ''}past swaps could not be looked for just now. Trying again.`
      : look ? (recs.length ? 'Looking for more of your past swaps…' : 'Looking for your past swaps on Bitcoin and Ethereum. This can take a minute or two.')
        : recs.length ? '' : 'No swaps yet. A swap you start shows here, with its steps.';
  $('mine-keep').hidden = !open;
}
// a copy of the swaps as a file: a swap of ETH for BTC is found again from this copy or this browser's storage, not from the key alone
$('keep-save').addEventListener('click', () => {
  const k = lane.keep(), st = $('mine-st');
  if (!k) { st.textContent = 'Sign in first.'; return; }
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
  if (!k) { st.textContent = 'Sign in first.'; return; }
  try { const n = k.load(await f.text()); st.textContent = n ? `${n} record${n === 1 ? '' : 's'} read back.` : 'Nothing new in that copy.'; await lane.reread(); }
  catch (err) { st.textContent = String(err?.message || 'That file could not be read.'); }
});

// the commands copy with one press; each line is its own block, so a long one wraps under itself (the copy is the text as written)
for (const pre of document.querySelectorAll('.cmd pre')) {
  const cmd = pre.textContent;
  // (and each word of it whole where it fits, so a line breaks between words, not inside a path or a --flag)
  pre.innerHTML = cmd.split('\n').map((l) => `<span class="ln">${l.split(/( +)/).map((w) => (/^ *$/.test(w) ? w : `<span class="w">${esc(w)}</span>`)).join('')}</span>`).join('');
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Copy' });
  b.setAttribute('aria-label', 'Copy the command');
  b.addEventListener('click', () => navigator.clipboard?.writeText(cmd).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }, () => { b.textContent = 'Select it'; }));
  pre.parentElement.append(b);
}

ddWatch();
if (first.amt) lane.set({ amt: first.amt });
market().catch(() => {});
lane.show();
paintChip();
