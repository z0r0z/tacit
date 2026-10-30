import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';
import * as M from '/vault/math.js?cb=ac1ed53e';
import { makeRpc, RPCS, ARCHIVE, HISTORY, makeReader, QUEUE_EXPIRY } from '/vault/chain.js?cb=c20b4576';
import { makeFeed } from '/vault/feed.js?cb=5f8dd137';
import { makePools } from '/vault/pools.js?cb=d71b2162';
import { makeVaultEngine, KIND, BATCH_MAX, StopWaiting } from '/vault/engine.js?cb=369ffbff';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=de979716';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Math.floor(Date.now() / 1000);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const icon = (key) => `<svg class="tk" aria-hidden="true"><use href="#tk-${key === 'usd' ? 'tacd' : 'tace'}"/></svg>`;
const mk = (id) => `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-${id}"/></svg>`;
const synMk = (x) => mk(x.V.key === 'usd' ? 'tacd' : 'tace');
const ACTS = [['deposit', 'Deposit'], ['borrow', 'Borrow'], ['repay', 'Repay'], ['withdraw', 'Withdraw']];

const params = () => new URLSearchParams(location.hash.replace(/^#/, ''));
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const hintOf = (h) => (h && ['tac', 'synth', 'oracle', 'feed'].every((k) => ADDR.test(h[k] || '')) ? Object.fromEntries(['tac', 'synth', 'oracle', 'feed'].map((k) => [k, h[k].toLowerCase()])) : null);
const VS = (() => {
  let list = DEPLOYMENTS.vaults.filter((v) => KIND[v.key] && ADDR.test(v.vault)).map((v) => ({ key: v.key, addr: v.vault, hint: hintOf(v.hint) }));
  if (LOCAL) {
    const p = params(), over = ['usd', 'eth'].filter((k) => ADDR.test(p.get(`v${k}`) || '')).map((k) => { const [tac, synth, oracle, feed] = (p.get(`h${k}`) || '').split(','); return { key: k, addr: p.get(`v${k}`), hint: hintOf({ tac, synth, oracle, feed }) }; });
    if (over.length) list = over;
  }
  return list.map((v) => ({ ...v, s: null, d: null }));
})();

const ROUTER = (() => { const a = LOCAL && ADDR.test(params().get('router') || '') ? params().get('router') : DEPLOYMENTS.router; return ADDR.test(a || '') ? a : null; })();

const S = { v: VS[0]?.key, t: 'borrow', pre: true, batchOk: false, batchFor: null, routerFor: null, routerOff: false, routerSettled: false, batchBusy: false, amt: '', view: null, busy: false, seq: 0, chainT: 0, chainAt: 0, loaded: false, failed: false, more: false, toPools: false };
const BOOT = now();
const MORE_KEY = 'tacit-vault-more';
try { S.more = localStorage.getItem(MORE_KEY) === '1'; } catch { }
const WALLET_READS = new Set(['eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getProof', 'eth_getTransactionReceipt', 'eth_gasPrice']);
let walletNow = null;
const walletNode = (order) => ({
  id: 'wallet', timeout: 8e3, ...order,
  usable: (m) => !!walletNow?.prov && !walletNow.prov.isWalletConnect && walletNow.chain === '0x1' && WALLET_READS.has(m),
  send: (m, p) => walletNow.prov.request({ method: m, params: p }),
});
const rpc = makeRpc([...RPCS, walletNode({ last: true })]);
const { ethCall, batch } = makeReader(rpc);
const cur = () => VS.find((v) => v.key === S.v) || null;

const connect = makeConnect({
  describe: 'Borrow against TAC', name: 'tacit borrow', rpc,
  busy: () => S.busy,
  say: (t) => say(t),
  onChange: () => { detectBatch(); if (side === 'tac') pools.read(); if (S.busy || side !== 'tac') return; if (!S.view) { refresh(); } else renderAll(); },
  restore: false,
});
const { wallet, W } = connect;
const connectWallet = connect.connect, renderChip = connect.renderChip;
walletNow = W;
const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
const who = () => S.view || W.account || null;
const canAct = () => !!W.account && sameAddr(W.account, who());
const onDay = (t) => new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).replace(',', '') + ' UTC';
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;
const say = (t, kind = 'trade') => { const s = $('#status'); s.innerHTML = t; s.dataset.kind = kind; };

const POOLS = (() => {
  const c = DEPLOYMENTS.pools;
  if (!c || !LOCAL) return c || null;
  const usdc = params().get('usdc');
  return ADDR.test(usdc || '') ? { ...c, quotes: { ...c.quotes, USDC: { ...c.quotes.USDC, addr: usdc } } } : c;
})();
const pools = makePools({
  el: $('#pools'), cfg: POOLS, esc, rpc, ethCall, batch, wallet, W, connect: connectWallet, txLink, onChange: () => { renderBoard(); renderPromo(); toPools(); },
  synthOf: (key) => VS.find((v) => v.key === key)?.synth || null, symOf: (key) => KIND[key].sym,
});

function renderPromo() {
  const el = $('#promo');
  if (!el) return;
  const t = pools.promo();
  el.hidden = !t;
  if (t) setHtml(el, `${t} <button class="linkbtn" type="button" data-to-pools>See the markets ↓</button>`);
}


const zoneName = { liquidation: 'Liquidation', redemption: 'Redemption', safe: 'Safe' };

function renderPick() {
  $('#pick-w').hidden = VS.length < 2;
  $('#pick').innerHTML = VS.map((v) => `<button type="button" data-v="${v.key}" aria-pressed="${v.key === S.v}"${S.busy ? ' disabled' : ''}>${icon(v.key)}${esc(KIND[v.key].name)}<small>${esc(KIND[v.key].sym)}</small></button>`).join('');
}
const setHtml = (el, h) => { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } };
const GROUP = (list) => { const m = new Map(); for (const [x, t] of list) { const k = JSON.stringify(t); if (!m.has(k)) m.set(k, { names: [], t }); m.get(k).names.push(x.k.name); } return [...m.values()]; };
const announcedTerm = (x, id) => { const n = chainNow(), a = (x.d.announced || []).find((q) => q.id === id && q.eta > 0 && q.eta + QUEUE_EXPIRY > n); return a ? { value: BigInt(a.value), eta: a.eta } : null; };
function afterAnnounced(x) {
  const depth = announcedTerm(x, 0), min = announcedTerm(x, 6);
  if ((!depth && !min) || x.d.depthCeiling == null || x.d.debtCeiling == null || x.d.totalDebt == null) return null;
  const ceil = depth ? x.d.depthCeiling * depth.value / x.s.depthBps : x.d.depthCeiling, cap = ceil < x.d.debtCeiling ? ceil : x.d.debtCeiling;
  return { room: cap > x.d.totalDebt ? cap - x.d.totalDebt : 0n, minDebt: min ? min.value : x.s.minDebt, eta: Math.max(depth?.eta || 0, min?.eta || 0) };
}
function statusOf(x) {
  const f = feedOf(x.V), checking = { state: 'wait', short: '', why: 'Checking the prices…', next: '' };
  if (x.paused) {
    if (x.stale) return { state: 'paused', short: 'ETH/USD price old', why: `The ETH/USD price is ${M.span(x.feedAge)} old; borrowing needs one under ${M.span(x.s.staleness)}.`, next: 'It clears with the feed’s next update.' };
    if (f && !f.ready && f.missing > 0 && f.missing <= BATCH_MAX && !viaOf(x.V) && viaPending(x.V)) return checking;
    if (f && !f.ready && f.missing > 0 && f.missing <= BATCH_MAX && viaOf(x.V)) {
      const p = postOf(x.V)?.d;
      if (p && p.depthCeiling != null && p.debtCeiling != null && p.totalDebt != null) {
        const room = M.sharedRoom({ debtCeiling: p.debtCeiling, depthCeiling: p.depthCeiling, totalDebt: p.totalDebt });
        if (room < x.s.minDebt) return { state: 'thin', short: 'room too small', why: `Room (${syn(x, room)} ${x.sym}) is under the smallest debt (${syn(x, x.s.minDebt)} ${x.sym}).`, next: 'More liquidity in the TAC pools adds room. <a href="/rewards/#farm">Add liquidity →</a>' };
      }
      return { state: 'open', carry: f.missing, short: '', why: '', next: '' };
    }
    if (f && !f.ready) return { state: 'paused', short: 'prices not recorded', why: `Borrowing waits for ${f.missing} price${f.missing === 1 ? '' : 's'} to be recorded.`, next: 'Anyone can record them, <a href="#feed" data-tofeed>below</a>.' };
    if (!f && !F.tried) return checking;
    return { state: 'paused', short: 'prices unreadable', why: 'Could not read the prices. Try again in a moment.', next: '' };
  }
  if (x.room < x.s.minDebt) {
    const ceil = x.d.debtCeiling, g = (v) => `${syn(x, v)} ${x.sym}`;
    if (x.ownerCap && ceil === 0n) return { state: 'thin', short: 'switched off', why: 'The owner has switched borrowing off.', next: '' };
    if (x.ownerCap) return { state: 'thin', short: 'cap reached', why: `The owner caps borrowing at ${g(ceil)}; ${g(x.room)} is left, under the smallest debt (${g(x.s.minDebt)}).`, next: '' };
    const after = afterAnnounced(x), why = x.room === 0n ? `All ${g(x.cap)} is borrowed.` : `Room (${g(x.room)}) is under the smallest debt (${g(x.s.minDebt)}).`;
    if (after && after.room >= after.minDebt && after.room > 0n) return { state: 'thin', short: 'room too small', why, next: `The announced change makes the room ${g(after.room)} (smallest debt ${g(after.minDebt)}): borrowing opens from ${onDay(after.eta)}.` };
    return { state: 'thin', short: 'room too small', why, next: 'More liquidity in the TAC pools adds room. <a href="/rewards/#farm">Add liquidity →</a>' };
  }
  return { state: 'open', short: '', why: '', next: '' };
}
function boardRows(xs) {
  const cell = (fn) => xs.map((x) => `<td class="num">${fn(x)}</td>`).join('');
  const dash = '—';
  const rows = [
    ['Borrowing', (x) => { const st = x.status; return `<span class="st s-${st.state}"><i class="sd"></i>${st.state === 'open' ? 'Open' : st.state === 'wait' ? 'Checking' : 'Not open'}</span>${st.short && !x.hideShort ? `<small>${esc(st.short)}</small>` : ''}`; }],
    ['Room to borrow', (x) => {
      if (x.room != null) return `<b>${esc(syn(x, x.room))}</b> ${esc(x.sym)}`;
      const p = x.status?.carry ? postOf(x.V)?.d : null;
      return p && p.debtCeiling != null && p.depthCeiling != null && p.totalDebt != null ? `<b>${esc(syn(x, M.sharedRoom({ debtCeiling: p.debtCeiling, depthCeiling: p.depthCeiling, totalDebt: p.totalDebt })))}</b> ${esc(x.sym)}` : dash;
    }],
    ['Smallest debt', (x) => `${esc(syn(x, x.s.minDebt))} ${esc(x.sym)}`],
    ['Fee', (x) => (x.d.feeBps != null ? esc(feeText(x.d.feeBps)) : dash)],
    ...(xs.some((x) => pools.cell(x.V.key) != null) ? [['Trades at', (x) => pools.cell(x.V.key) ?? dash]] : []),
    ['Borrowed so far', (x) => (x.d.totalDebt != null ? `${esc(syn(x, x.d.totalDebt))} ${esc(x.sym)}` : dash)],
    ['TAC deposited', (x) => (x.d.held != null ? `${esc(tac(x.d.held))} TAC` : dash), true],
    ['Collateral ratio', (x) => (x.backing != null ? esc(pctOf(x.backing)) : dash), true],
    ['Pools’ depth', (x) => {
      const f = feedOf(x.V), d = x.d;
      if (d.depthCeiling != null && x.s.depthBps > 0n) return `${esc(syn(x, d.depthCeiling * 10000n / x.s.depthBps))} ${esc(x.sym)}<small>lowest in 8 h</small>`;
      if (f?.depth != null && d.feed && d.feed.answer > 0n) return `${esc(syn(x, f.depth * d.feed.answer / 10n ** BigInt(d.feed.decimals)))} ${esc(x.sym)}<small>lowest so far</small>`;
      return dash;
    }, true],
    ['Share of depth lent', (x) => `${esc(String(Number(x.s.depthBps) / 100))}%`, true],
    ['TAC price', (x) => (x.px != null ? esc(priceText(x, x.px, 'down')) : dash), true],
    ...(xs.some((x) => x.feedAge != null) ? [['ETH/USD price', (x) => (x.feedAge != null ? `<span class="${x.stale ? 'z-liquidation' : ''}">${esc(M.span(x.feedAge))} old</span><small>${x.stale ? 'too old to use' : `limit ${esc(M.span(x.s.staleness))}`}</small>` : dash), true]] : []),
    ['Borrow / liquidate at', (x) => `${esc(pctOf(x.s.mint))} · ${esc(pctOf(x.s.liq))}`, true],
  ];
  return rows.filter((r) => S.more || !r[2]).map(([label, fn]) => `<tr><th scope="row">${esc(label)}</th>${cell(fn)}</tr>`).join('');
}
function renderBoard() {
  const el = $('#board'), xs = VS.map((v) => derive(v)).filter(Boolean);
  const head = `<p class="eyebrow" id="board-h"><span>Vault status</span><span class="who">${S.readAt ? `read <span data-ago="${S.readAt}">${agoText(now() - S.readAt)}</span> · ` : ''}<button class="linkbtn" type="button" data-refresh>Refresh</button></span></p>`;
  el.classList.toggle('loading', !xs.length && !S.failed);
  if (!xs.length) { setHtml(el, `${head}<p class="verdict off">${S.failed ? 'Could not read the vaults.' : 'Reading the vaults…'}</p>${S.failed ? '<p class="note">Try again in a moment.</p>' : '<div class="sk" aria-hidden="true">' + '<i></i>'.repeat(9) + '</div>'}`); return; }
  for (const x of xs) x.status = statusOf(x);
  const open = xs.filter((x) => x.status.state === 'open'), waiting = xs.some((x) => x.status.state === 'wait');
  const verdict = waiting ? 'Checking whether borrowing is open…' : open.length === xs.length ? (xs.length > 1 ? 'Borrowing is open on both vaults' : `Borrowing is open on ${xs[0].k.name}`) : open.length ? `Borrowing is open on ${open.map((x) => x.k.name).join(' and ')}` : 'Borrowing is not open yet';
  const need = GROUP(xs.filter((x) => x.status.state !== 'open').map((x) => [x, { why: x.status.why, next: x.status.next }]));
  const shared = need.length === 1 && need[0].names.length === xs.length;
  for (const x of xs) x.hideShort = shared;
  const needs = need.map((g) => `<li>${g.names.length === xs.length ? '' : `<b>${esc(g.names.join(' and '))}:</b> `}${g.t.why}${g.t.next ? ` ${g.t.next}` : ''}</li>`).join('');
  const carry = Math.max(0, ...xs.map((x) => x.status.carry || 0));
  const cost = carry && gasEth(carry) ? `, for about ${gasEth(carry)} ETH` : '';
  const carryLine = carry ? `<li>The last ${carry} price${carry === 1 ? '' : 's'} ${carry === 1 ? 'is' : 'are'} recorded with your transaction${cost}.</li>` : '';
  const notices = xs.filter((x) => x.auctionsPaused).map((x) => pauseBox(x, xs.length > 1)).join('') + changesNotice(xs);
  setHtml(el, `${head}<p class="verdict ${waiting ? 'wait' : open.length ? 'on' : 'off'}"><i class="sd"></i><span>${esc(verdict)}</span></p>
    ${needs || carryLine ? `<ul class="needs${waiting ? ' wait' : ''}">${needs}${carryLine}</ul>` : ''}
    <div class="bt-wrap"><table class="bt"><thead><tr><td></td>${xs.map((x) => `<th scope="col"${x.V.key === S.v ? ' class="cur" aria-current="true"' : ''}>${icon(x.V.key)}${esc(x.k.name)}<small>${esc(x.sym)}</small></th>`).join('')}</tr></thead><tbody>${boardRows(xs)}</tbody></table></div>
    <button class="linkbtn more" type="button" data-more aria-expanded="${!!S.more}">${S.more ? 'Fewer figures' : 'More figures'}</button>
    ${notices}`);
}
const agoText = (s) => (s < 5 ? 'just now' : s < 60 ? `${Math.round(s)} s ago` : `${M.span(s)} ago`);

function renderHow() {
  const el = $('#how');
  el.hidden = !VS.length;
  const V = cur(), x = V && derive(V);
  if (!x) return;
  const sym = esc(x.sym), fee = x.d.feeBps != null ? `${feeText(x.d.feeBps)} fee to borrow` : 'One fee to borrow', redeem = `${feeText(x.s.redemptionFee)} to ${feeText(x.s.redemptionFee * 4n)}`;
  setHtml($('#how-body'), `<ol>
    <li><b>Deposit TAC, borrow ${sym}.</b> Up to your TAC’s value over ${pctOf(x.s.mint)}. ${fee}, no interest.</li>
    <li><b>Prices move slowly.</b> They come from the TAC pools over hours, so a brief dip does not liquidate you.</li>
    <li><b>Under ${pctOf(x.s.liq)}, a vault can be auctioned.</b> Bids repay its debt for its TAC at a bonus that grows over ${esc(M.span(x.s.auctionDuration))}; only the vault’s owner can bid for the first ${esc(M.span(x.s.ownerWindow))}. Repaying or adding TAC ends it.</li>
    <li><b>${pctOf(x.s.liq)} to ${pctOf(x.safe)}, it can be redeemed against.</b> A ${sym} holder swaps it for the vault’s TAC at its price (${redeem} fee), which lowers the debt.</li>
    <li><b>Repay any time.</b> The debt left must be zero or at least ${esc(syn(x, x.s.minDebt))} ${sym}.</li>
  </ol>
  <p>The owner can lower the cap, set fees (up to 5% to borrow, 2.5% to redeem) and pause auctions for up to 12 hours. Other changes are announced here 2 to 3 days ahead.</p>`);
}

function healthBar(x, after = false) {
  const p2 = M.barPos(Number(x.s.liq)), p4 = M.barPos(Number(x.safe)), pl = M.barPos(x.line), pm = M.barPos(Number(x.ratio));
  const pc = (f) => `${(f * 100).toFixed(2)}%`, edge = pm < 0.1 ? ' l' : pm > 0.9 ? ' r' : '';
  const z = (name, w) => `<i class="hb-z ${name}${x.zone === name ? ' on' : ''}" style="width:${pc(w)}"></i>`;
  const label = `Ratio ${pctOf(x.ratio)}: ${x.zone === 'liquidation' ? 'liquidation' : x.zone === 'redemption' ? 'open to redemption' : 'safe'}. Liquidation under ${pctOf(x.s.liq)}, safe from ${pctOf(x.safe)}; you can borrow or withdraw down to ${pctOf(x.s.mint)}.`;
  return `<div class="hb${after ? ' after' : ''}"${after ? ' aria-hidden="true"' : ` role="img" aria-label="${esc(label)}"`}>
    <div class="hb-top"><span style="left:${pc(pl)}">${pctOf(x.s.mint)} borrowing line</span></div>
    <div class="hb-bar">${z('liquidation', p2)}${z('redemption', p4 - p2)}${z('safe', 1 - p4)}<i class="hb-tick" style="left:${pc(pl)}"></i><i class="hb-pin" style="left:${pc(pm)}"></i></div>
    <div class="hb-nums"><span style="left:${pc(p2)}">${pctOf(x.s.liq)}</span><span style="left:${pc(p4)}">${pctOf(x.safe)}</span></div>
    <div class="hb-bot"><span class="hb-val${edge}" style="left:${pc(pm)}">${pctOf(x.ratio)}</span></div>
    <div class="hb-key">${['liquidation', 'redemption', 'safe'].map((k) => `<span class="${x.zone === k ? 'on' : ''}"><i class="${k}"></i>${zoneName[k]}</span>`).join('')}</div></div>`;
}
function zoneLine(x) {
  if (x.zone === 'liquidation') return `Under ${pctOf(x.s.liq)}: this vault can be auctioned.`;
  if (x.zone === 'redemption') return `Open to redemption: a ${esc(x.sym)} holder can swap it for your TAC at its price, and your debt falls by as much.`;
  return 'Safe: nothing can be redeemed or auctioned against this vault.';
}
function pauseBox(x, named = false) {
  return `<div class="callout"><span class="t"><b>Auctions paused${named ? ` on ${esc(x.k.name)}` : ''}</b> for <b data-cd="${x.pauseEnd}">${M.clock(x.pauseEnd - chainNow())}</b>: no liquidations, outside bids or redemptions. Everything else works.</span></div>`;
}
const TERM_NAMES = ['Share of depth lent', 'Borrowing line', 'Liquidation ratio', 'Bid bonus', 'Vault owner’s bidding window', 'Auction length', 'Smallest debt'];
const EASIER_WHEN_LARGER = [1, -1, -1, -1, 1, 0, -1];
const CURRENT_TERM = [(x) => x.s.depthBps, (x) => x.s.mint, (x) => x.s.liq, () => null, (x) => x.s.ownerWindow, (x) => x.s.auctionDuration, (x) => x.s.minDebt];
function termText(x, id, v) {
  if (id === 0) return `${Number(v) / 100}%`;
  if (id === 1 || id === 2) return pctOf(v);
  if (id === 3) return feeText(v);
  if (id === 4 || id === 5) return M.span(Number(v));
  return `${syn(x, v)} ${x.sym}`;
}
function changesNotice(xs) {
  const now = chainNow(), live = (eta) => eta > 0 && eta + QUEUE_EXPIRY > now, many = xs.length > 1;
  const when = (eta) => (eta > now ? `from ${onDay(eta)} (in ${M.span(eta - now)})` : 'can be made now');
  const lines = [];
  let tightens = false;
  for (const x of xs) {
    const pre = many ? `${esc(x.k.name)}: ` : '';
    for (const a of (x.d.announced || []).filter((q) => live(q.eta))) {
      lines.push(`${pre}${TERM_NAMES[a.id]} → ${termText(x, a.id, a.value)} · ${when(a.eta)}`);
      const dir = EASIER_WHEN_LARGER[a.id], was = CURRENT_TERM[a.id]?.(x);
      if (was == null || !dir || dir * (BigInt(a.value) > BigInt(was) ? 1 : BigInt(a.value) < BigInt(was) ? -1 : 0) < 0) tightens = true;
    }
    if (live(x.d.oracleEta)) { lines.push(`${pre}New price source · ${when(x.d.oracleEta)}`); tightens = true; }
    if (live(x.d.minterEta)) { lines.push(`${pre}Another contract may mint ${esc(x.sym)} · ${when(x.d.minterEta)}`); tightens = true; }
  }
  if (!lines.length) return '';
  const head = tightens ? '<b>Changes announced by the owner.</b> They tighten borrowing: repay or withdraw before then if you would rather not take them.' : '<b>Changes announced by the owner.</b> They make borrowing easier; nothing to do.';
  return `<div class="callout${tightens ? '' : ' soft'}"><span class="t">${head}${lines.map((l) => `<span class="sub">${l}</span>`).join('')}</span></div>`;
}

const auctionNow = (d) => (d.auctionTime == null ? chainNow() : d.auctionTime + Math.max(0, chainNow() - Math.max(S.chainT, Number(d.pausedUntil || 0))));
function auctionBox(x) {
  const left = x.me.auctionStart + x.s.ownerWindow - auctionNow(x.d);
  const owner = x.auctionsPaused ? `Bids from others are paused for <b data-cd="${x.pauseEnd}">${M.clock(x.pauseEnd - chainNow())}</b>; the vault’s owner can still bid.` : left > 0 ? `Only the vault’s owner can bid for <b data-cd="${chainNow() + left}">${M.clock(left)}</b>, then anyone.` : 'Anyone can bid now.';
  const offer = x.d.pO != null ? `<span class="sub">The offer is ${esc(priceText(x, x.d.pO, 'down'))} per TAC${x.d.onOffer != null ? `; a bid for all the debt takes ${esc(tac(x.d.onOffer))} TAC` : ''}.</span>` : '';
  const way = x.d.recovered ? 'The vault has recovered: ending the auction restores borrowing and withdrawing.' : 'Repay, or add TAC, to end it. It ends once the vault is back above ' + pctOf(x.s.liq) + '.';
  return `<div class="callout red"><span class="t"><b>An auction is running.</b> ${owner}${offer}<span class="sub">${way}</span></span>${x.d.recovered && canAct() ? '<button class="pillbtn" type="button" data-cancel>End the auction</button>' : lapsedCure(x) ? `<button class="pillbtn" type="button" data-cancel>Record ${lapsedCure(x)} price${lapsedCure(x) === 1 ? '' : 's'} and end the auction</button>` : ''}</div>`;
}
function renderPos() {
  const V = cur(), x = V && derive(V), el = $('#pos');
  const viewing = S.view ? `<span class="who">${esc(short(S.view))}</span>` : '';
  const head = `<p class="eyebrow" id="pos-h"><span>Your vault</span>${viewing}</p>`;
  if (!x) { setHtml(el, `${head}<p class="empty">${S.failed ? 'Not read yet.' : 'Reading the vault…'}</p>`); return; }
  if (!who()) { setHtml(el, `${head}<p class="empty"><button class="linkbtn" type="button" data-connect>Connect a wallet</button> to see your vault.</p>`); return; }
  const m = x.me;
  if (m.collateral === 0n && m.debt === 0n) {
    setHtml(el, `${head}<p class="empty">${S.view ? 'This account has nothing in the vault.' : `Nothing deposited yet. Deposit TAC to borrow ${esc(x.sym)} against it.`}</p>${S.view ? '<p class="note"><a href="#" data-mine>Use my wallet</a></p>' : ''}`);
    return;
  }
  const rows = [];
  rows.push(`<div class="kv"><span>Collateral</span><b class="num">${mk('tac')}${esc(tac(m.collateral))} TAC${x.value != null ? `<small>${esc(syn(x, x.value))} ${esc(x.sym)}</small>` : ''}</b></div>`);
  rows.push(`<div class="kv"><span>Debt</span><b class="num">${synMk(x)}${esc(syn(x, m.debt))} ${esc(x.sym)}</b></div>`);
  if (x.ratio != null) rows.push(`<div class="kv"><span>Ratio</span><b class="num z-${x.zone}">${esc(pctOf(x.ratio))}</b></div>`);
  if (x.borrow) rows.push(`<div class="kv"><span>You can borrow</span><b class="num">${synMk(x)}${esc(syn(x, x.borrow.amount))} ${esc(x.sym)}${x.borrow.binding === 'room' ? '<small>limited by the room left to borrow</small>' : ''}</b></div>`);
  if (x.liqPrice != null && x.d.pL != null) {
    const below = Math.floor((1 - Number(x.liqPrice) / Number(x.d.pL)) * 100);
    rows.push(`<div class="kv"><span>Liquidation price</span><b class="num">${esc(priceText(x, x.liqPrice, 'up'))}<small>${below > 0 ? `${below}% below TAC’s price` : 'TAC is at or below it'}</small></b></div>`);
  }
  let body = `<div class="rows flat">${rows.join('')}</div>`;
  if (x.ratio == null && m.debt > 0n) body += '<p class="zline">The ratio shows once prices are recorded.</p>';
  if (x.ratio != null) {
    body += healthBar(x) + `<p class="zline">${zoneLine(x)}</p>`;
    if (x.zone !== 'safe' && x.top > 0n && !x.auction && canAct()) body += `<div class="callout"><span class="t">Add <b class="num">${esc(tac(x.top))} TAC</b> to reach ${esc(pctOf(x.safe))}</span><button class="pillbtn" type="button" data-fill="${M.plain(x.top)}">Add it</button></div>`;
  }
  if (x.auction) body += auctionBox(x);
  if (x.auction && x.top > 0n && canAct()) body += `<div class="callout"><span class="t">Add <b class="num">${esc(tac(x.top))} TAC</b> to reach ${esc(pctOf(x.safe))}</span><button class="pillbtn" type="button" data-fill="${M.plain(x.top)}">Add it</button></div>`;
  setHtml(el, head + body + (S.view ? '<p class="note"><a href="#" data-mine>Use my wallet</a></p>' : ''));
}

const BUY = '<a href="/trade/tac/">Buy TAC →</a>';

function renderTicket() {
  const V = cur(), t = S.t, x = V && derive(V, true);
  if (S.pre && t === 'borrow' && !S.amt && x && canAct() && !S.busy) {
    const m = planOf().max;
    if (m > 0n) {
      S.amt = M.plain(M.floorTo(m, S.v === 'eth' ? 6 : 4));
      if (planOf().ok) { $('#amt').value = S.amt; S.pre = false; } else S.amt = '';
    }
  }
  const P = planOf();
  const sym = x?.sym || KIND[S.v]?.sym || '', isTac = t === 'deposit' || t === 'withdraw';
  setHtml($('#acts'), ACTS.map(([k, l]) => `<button type="button" data-t="${k}" aria-pressed="${k === t}"${S.busy ? ' disabled' : ''}>${l}</button>`).join(''));
  const st = V && derive(V) ? statusOf(derive(V)) : null;
  setHtml($('#tk-h'), `<span>${esc(x ? `${x.k.name} vault` : 'Vault')}</span>${st ? `<span class="st s-${st.state}"><i class="sd"></i>${st.state === 'open' ? 'Open' : st.state === 'wait' ? 'Checking' : 'Not open'}</span>` : ''}`);
  $('#amt-lbl').textContent = isTac ? `TAC to ${t}` : `${sym} to ${t}`;
  $('#unit').innerHTML = `${isTac ? '<svg class="tk" aria-hidden="true"><use href="#tk-tac"/></svg>' : icon(S.v)}${esc(isTac ? 'TAC' : sym)}`;
  $('#amt').setAttribute('aria-label', isTac ? `TAC to ${t}` : `${sym} to ${t}`);
  const bal = $('#bal'); bal.hidden = !P.maxText || !x; bal.textContent = P.maxText; bal.disabled = S.busy;
  setHtml($('#chips'), [25, 50, 75, 100].map((p) => `<button type="button" data-pct="${p}"${S.busy || !(P.max > 0n) ? ' disabled' : ''}>${p === 100 ? 'Max' : `${p}%`}</button>`).join(''));
  setHtml($('#info'), P.rows.map(([l, v]) => `<div class="kv"><span>${esc(l)}</span><b class="num">${v}</b></div>`).join(''));
  $('#info').hidden = !P.rows.length;
  setHtml($('#after'), x && P.after ? healthBar({ ...x, ratio: P.after.ratio, zone: P.after.zone }, true) : '');
  const h = $('#hint'); setHtml(h, P.hint); h.classList.toggle('err', !!P.err);
  const go = $('#go');
  go.title = '';
  if (!W.account) { go.textContent = 'Connect wallet'; go.disabled = false; }
  else if (!canAct()) { go.textContent = 'Viewing another account'; go.disabled = true; }
  else if (S.busy || (F.busy && P.record)) { go.textContent = F.busy && P.record ? 'Recording…' : 'Working…'; go.disabled = true; }
  else { go.textContent = P.cta; go.disabled = !P.ok && !P.record; }
  $('#amt').disabled = S.busy;
  maybePrepare();
}
function setAmount(pct) {
  const P = planOf();
  if (!(P.max > 0n)) return;
  S.pre = false;
  const unit = (S.t === 'deposit' || S.t === 'withdraw') ? 4 : (S.v === 'eth' ? 6 : 4);
  S.amt = pct === 100 ? M.plain(P.max) : M.plain(M.floorTo(P.max * BigInt(pct) / 100n, unit));
  $('#amt').value = S.amt; renderTicket();
}

const lockAll = () => { renderPick(); };
function watchToken(key) {
  const V = VS.find((v) => v.key === key), x = V && derive(V);
  if (!x || !W.prov) return;
  wallet.watchAsset({ address: V.synth, symbol: x.sym, decimals: 18, image: `${location.origin}/brand/${V.key === 'usd' ? 'tacd' : 'tace'}.svg` });
}

function renderAll() {
  if (side !== 'tac') return;
  const live = VS.length > 0;
  $('#soon').hidden = live; $('#app').hidden = !live; $('#wallet-chip').hidden = !live;
  $('#sub').hidden = !live;
  if (!live) return;
  renderChip(); renderPick(); renderBoard(); renderPos(); renderFeed(); renderTicket(); renderHow();
  pools.show(S.v);
  renderPromo();
}

const busyNote = (ms) => E.busyNote(ms);
const feed = makeFeed({
  rpc,
  headerRpc: makeRpc([walletNode({ prefer: true }), ...HISTORY], { spread: true, onWait: busyNote }),
  proofRpc: makeRpc([walletNode({ prefer: true }), ...ARCHIVE], { spread: true, onWait: busyNote }),
});
// `ticket`: the recording under way was started from the ticket, which shows its progress too
// the vaults' engine (vault/engine.js), with this page's state, wallet and markup; what it says lands in the ticket's status line and the feed's
const E = makeVaultEngine({
  S, VS, ROUTER, rpc, feed, wallet, W, who, canAct, UserStopped,
  ui: { esc, mk, synMk, txLink, zone: (z, t) => `<span class="z-${z}">${t}</span>`, fill: (amt, text) => `<button class="linkbtn" type="button" data-fill="${amt}">${esc(text)}</button>`,
    buy: BUY, stop: '<button class="linkbtn" type="button" data-stop>stop waiting</button>' },
  hooks: {
    say, feed: () => { renderFeed(); renderBoard(); }, all: () => renderAll(), ticket: () => renderTicket(), refresh: () => refresh(), connect: () => connectWallet(),
    busy: (on) => { if (on) S.pre = false; lockAll(); if (on) renderTicket(); else renderAll(); },
    sent: () => { S.amt = ''; $('#amt').value = ''; },
    focusAmount: () => $('#amt').focus({ preventScroll: true }),
    feedNote: (note, bad) => { const el = $('#feed-status'); if (el) { el.innerHTML = note; el.className = `status${bad ? ' err' : ''}`; } },
  },
});
const { load, derive, readable, postOf, lapsed, needs, lapsedCure, loadFeed, prepare, checkRouter, detectBatch, feedOf, oracleOf, viaOf, viaPending, F, PREP, VENUE,
  recordHint, gasEth, tac, syn, pctOf, feeText, priceText, chainNow, chainDeadline, setFeed } = E;
const planOf = () => E.planOf(cur(), S.t, S.amt);
const run = (kind) => E.run(cur(), S.t, S.amt, () => S.amt, kind);
const pokeFeed = (leave = 0, what = '') => E.pokeFeed(cur(), leave, what);
const maybePrepare = () => E.maybePrepare(cur(), S.t);
function renderFeed() { drawFeed(); renderTicket(); }
function drawFeed() {
  const el = $('#feed'), V = cur(), st = feedOf(V);
  const carried = V && st && !st.ready && st.missing > 0 && st.missing <= BATCH_MAX && !!viaOf(V) && !F.busy && !F.note;
  if (!VS.length || !st || carried || (st.ready && !F.busy && !F.note)) { el.hidden = true; return; }
  el.hidden = false;
  const rows = st.venues.map((v, i) => `<div class="vn"><div class="kv"><span>${esc(VENUE[i] || `Venue ${i + 1}`)}</span><b class="num">${v.counted} of ${v.points}</b></div><i class="mt" aria-hidden="true"><b style="width:${v.points ? Math.min(100, Math.round(v.counted * 100 / v.points)) : 0}%"></b></i></div>`).join('');
  setHtml(el, `<p class="eyebrow" id="feed-h"><span>Price feed</span><span class="who st${st.ready ? ' s-open' : ''}"><i class="sd"></i>${st.ready ? 'up to date' : `${st.missing} to record`}</span></p>
    <div class="rows flat">${rows}</div>
    ${st.missing ? `<p class="note">Anyone can record them. ${esc(recordHint(st.missing))}</p>
    <button class="btn" id="feed-go" type="button"${F.busy ? ' disabled' : ''}>${F.busy ? 'Recording…' : W.account ? `Record ${st.missing} price${st.missing === 1 ? '' : 's'}` : 'Connect wallet'}</button>` : ''}
    <div class="status${F.bad ? ' err' : ''}" id="feed-status" role="status">${F.note}</div>`);
  const go = $('#feed-go');
  if (go) go.onclick = () => pokeFeed();
}

function readHash() {
  const p = params(), v = p.get('v'), t = p.get('t'), a = p.get('a'), amt = p.has('amt') ? M.parseUnits(p.get('amt'), 18) : null;
  if (v && VS.some((x) => x.key === v)) S.v = v;
  if (ACTS.some(([k]) => k === t)) S.t = t;
  if (p.has('pools')) S.toPools = true;
  S.view = ADDR.test(a || '') ? a : null;
  if (amt != null && amt > 0n && !S.busy) { S.t = 'borrow'; S.pre = false; S.amt = M.plain(amt); $('#amt').value = S.amt; say('', ''); }
  if (p.has('amt')) keepInHash();
}
// A link ending in &pools opens on the markets, once they are drawn, and the page's address then drops it
function toPools() {
  if (!S.toPools || $('#pools').hidden) return;
  S.toPools = false;
  const p = params();
  p.delete('pools');
  history.replaceState(null, '', location.pathname + location.search + (p.toString() ? `#${p}` : ''));
  $('#pools').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}
function keepInHash() {
  const p = params();
  p.delete('amt');
  if (VS.length > 1 && S.v !== VS[0].key) p.set('v', S.v); else p.delete('v');
  if (S.t !== 'borrow') p.set('t', S.t); else p.delete('t');
  const h = p.toString() ? `#${p}` : '';
  if (h !== location.hash) history.replaceState(null, '', location.pathname + location.search + h);
}
const onBtc = () => location.hash === '#btc';
let side = null, tacStarted = false, btcP = null, tacHash = '';
function showSide() {
  const s = onBtc() ? 'btc' : 'tac';
  if (s === side) return false;
  side = s;
  document.documentElement.dataset.side = s;
  document.querySelectorAll('.via a[data-side]').forEach((a) => { if (a.dataset.side === s) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (s === 'btc') {
    $('#wallet-chip').hidden = true;
    btcP ||= import('/vault/btc.js?cb=701756e8').then((m) => m.loadBtc($('#btc'), { batch })).catch((e) => { btcP = null; console.warn('bitcoin side:', e?.message || e); });
    return true;
  }
  renderAll();
  if (!tacStarted) { tacStarted = true; checkRouter(); if (VS.length) refresh().then(() => loadFeed()); }
  else refresh();
  return true;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-side]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (a.dataset.side === side) return;
  if (a.dataset.side === 'btc') { tacHash = location.hash; location.hash = 'btc'; return; }
  location.hash = tacHash;
  if (!tacHash) history.replaceState(null, '', location.pathname + location.search);
});
// The Bitcoin side's own position (vault/mine.js): loaded on the holder's first press, so the side reads nothing more until then
const pickProvider = (list) => { const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid; };
let mineP = null;
$('#btc-mine').addEventListener('click', (e) => {
  if (mineP || !e.target.closest('[data-mine="open"]')) return;
  e.stopImmediatePropagation();
  mineP = import('/vault/mine.js?cb=1c83425e').then((m) => { m.mountMine($('#btc-mine'), { pick: pickProvider, wallet, W, connect: connectWallet }); $('#btc-mine [data-mine="open"]')?.click(); })
    .catch((err) => { mineP = null; console.warn('your position:', err?.message || err); });
});
const refresh = () => load().catch((e) => { console.warn('vault read:', e?.message || e); if (!S.loaded) S.failed = true; }).then(() => { renderAll(); pools.read(); });

$('#pick').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || S.busy || b.dataset.v === S.v) return; S.v = b.dataset.v; S.pre = S.t === 'borrow'; S.amt = ''; $('#amt').value = ''; say('', ''); keepInHash(); renderAll(); });
$('#acts').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b || S.busy || b.dataset.t === S.t) return; S.t = b.dataset.t; S.pre = S.t === 'borrow'; S.amt = ''; $('#amt').value = ''; say('', ''); keepInHash(); renderTicket(); });
$('#amt').addEventListener('input', (e) => { S.pre = false; S.amt = e.target.value; if ($('#status').dataset.kind === 'trade') say('', ''); renderTicket(); });
$('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-pct]'); if (b && !S.busy) setAmount(Number(b.dataset.pct)); });
$('#bal').addEventListener('click', () => { if (!S.busy) setAmount(100); });
$('#go').addEventListener('click', () => run());
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-fill]');
  if (f && !S.busy) { S.t = 'deposit'; S.pre = false; S.amt = f.dataset.fill; $('#amt').value = S.amt; say('', ''); keepInHash(); renderTicket(); $('#ticket').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); return; }
  if (e.target.closest('[data-to-pools]')) { $('#pools').scrollIntoView?.({ block: 'start', behavior: 'smooth' }); return; }
  if (e.target.closest('[data-more]')) { S.more = !S.more; try { localStorage.setItem(MORE_KEY, S.more ? '1' : '0'); } catch { } renderBoard(); return; }
  if (e.target.closest('[data-refresh]')) { if (!S.busy) { refresh(); loadFeed(); } return; }
  if (e.target.closest('[data-feed-stop]')) { F.stop?.(); return; }
  if (e.target.closest('[data-stop]')) { S.stop?.(); return; }
  const watch = e.target.closest('[data-watch]');
  if (watch) { watchToken(watch.dataset.watch); return; }
  const feedLink = e.target.closest('[data-tofeed]');
  if (feedLink) { e.preventDefault(); $('#feed')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
  if (e.target.closest('[data-connect]')) { connectWallet(); return; }
  if (e.target.closest('[data-cancel]')) { run('cancel'); return; }
  const m = e.target.closest('[data-mine]');
  // (the Bitcoin panel re-draws its buttons as it handles a press, so by now the one pressed is out of the page: the path the press took says where it was)
  if (m && !e.composedPath().some((n) => n.id === 'btc-mine')) { e.preventDefault(); const p = params(); p.delete('a'); history.replaceState(null, '', location.pathname + (p.toString() ? `#${p}` : '')); S.view = null; refresh(); }
});
addEventListener('hashchange', () => { if (onBtc()) { showSide(); return; } readHash(); if (!showSide()) refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.busy && side === 'tac') refresh(); });
connect.restore();

setInterval(() => {
  const els = document.querySelectorAll('[data-cd]');
  els.forEach((el) => { const left = Number(el.dataset.cd) - chainNow(); el.textContent = M.clock(left); if (left <= 0 && !S.busy) renderPos(); });
  document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = agoText(now() - Number(el.dataset.ago)); });
}, 1000);
setInterval(() => { if (!document.hidden && !S.busy && side === 'tac') refresh(); }, 30e3);
setInterval(() => { if (!document.hidden && !S.busy && !F.busy && side === 'tac') loadFeed(); }, 60e3);

readHash();
showSide();
