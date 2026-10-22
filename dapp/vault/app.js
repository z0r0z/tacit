import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';
import * as M from '/vault/math.js?cb=ac1ed53e';
import {
  makeRpc, RPCS, ARCHIVE, HISTORY, makeReader, staticCalls, parseStatic, dynamicCalls, parseDynamic, timestampCall, refusal, decString, SEL, wordAt, addrWord, QUEUE_EXPIRY,
  encDeposit, encWithdraw, encBorrow, encRepay, encCancel, encApprove, encPermit, encMulticall,
} from '/vault/chain.js?cb=2846737a';
import { makeFeed, RECORD_GAS, PER_TX, encBatch, MULTICALL3 } from '/vault/feed.js?cb=69eaea4d';
import { batchSupport, simulateBundle, sendBundle, readMixed } from '/vault/batch.js?cb=91c83890';
import { makePools } from '/vault/pools.js?cb=47344938';
import { ROUTER_SEL, encRouterRecords, encRouterBorrow, encRouterWithdraw, encRouterDeposit, encRouterRepay, encRouterPermitSynth, borrowTyped, withdrawTyped } from '/vault/router.js?cb=21df6509';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=92188b57';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Math.floor(Date.now() / 1000);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const KIND = { usd: { name: 'TAC Dollar', sym: 'TACD', dp: 2, price: (t) => `$${t}` }, eth: { name: 'TAC Ether', sym: 'TACE', dp: 4, price: (t) => `${t} ETH` } };
const icon = (key) => `<svg class="tk" aria-hidden="true"><use href="#tk-${key === 'usd' ? 'tacd' : 'tace'}"/></svg>`;
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

const S = { v: VS[0]?.key, t: 'borrow', pre: true, batchOk: false, batchFor: null, routerFor: null, routerOff: false, routerSettled: false, batchBusy: false, amt: '', view: null, busy: false, seq: 0, chainT: 0, chainAt: 0, loaded: false, failed: false, more: false };
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
const chainNow = () => (S.chainT ? S.chainT + (now() - S.chainAt) : now());
const chainDeadline = (s) => BigInt(chainNow() + s);

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
  el: $('#pools'), cfg: POOLS, esc, rpc, ethCall, batch, wallet, W, connect: connectWallet, txLink, onChange: () => { renderBoard(); renderPromo(); },
  synthOf: (key) => VS.find((v) => v.key === key)?.synth || null, symOf: (key) => KIND[key].sym,
});

function renderPromo() {
  const el = $('#promo');
  if (!el) return;
  const t = pools.promo();
  el.hidden = !t;
  if (t) setHtml(el, `${t} <button class="linkbtn" type="button" data-to-pools>See the markets ↓</button>`);
}

async function load() {
  if (!VS.length) return;
  const my = ++S.seq, who0 = who();
  for (const v of VS) if (!v.s && v.hint && !v.hinted) { Object.assign(v, v.hint); v.hinted = true; }
  const fresh = VS.filter((v) => !v.s && !v.hinted);
  if (fresh.length) {
    const n = staticCalls('0x').length, res = await batch(fresh.flatMap((v) => staticCalls(v.addr)));
    if (my !== S.seq) return;
    fresh.forEach((v, i) => { v.s = parseStatic(res.slice(i * n, (i + 1) * n)); });
  }
  const live = VS.filter((v) => v.s || v.hinted);
  for (const v of live) if (v.s) { v.tac = v.s.tac; v.synth = v.s.synth; v.oracle = v.s.oracle; v.feed = v.s.feed; }
  const nS = staticCalls('0x').length;
  const calls = [timestampCall(), ...live.flatMap((v) => staticCalls(v.addr)), ...live.flatMap((v) => dynamicCalls(v, who0))];
  const res = await batch(calls);
  if (my !== S.seq || who0 !== who()) return;
  const ts = res[0] ? Number(wordAt(res[0], 0)) : 0;
  if (ts) { S.chainT = ts; S.chainAt = now(); }
  let stale = false;
  live.forEach((v, k) => {
    const s = parseStatic(res.slice(1 + k * nS, 1 + (k + 1) * nS));
    if (v.hinted) {
      v.hinted = false;
      if (s && s.tac === v.tac && s.synth === v.synth && s.oracle === v.oracle && s.feed === v.feed) { v.s = s; return; }
      v.hint = null; v.tac = v.synth = v.oracle = v.feed = undefined; stale = true;
      return;
    }
    if (s && s.tac === v.tac && s.synth === v.synth) { v.s = s; v.oracle = s.oracle; v.feed = s.feed; }
  });
  if (stale) return load();
  let i = 1 + live.length * nS;
  for (const v of live) { const n = dynamicCalls(v, who0).length; v.d = parseDynamic(v, who0, res.slice(i, i + n)); v.d.who = who0; i += n; }
  S.loaded = VS.some((v) => v.d); S.failed = !S.loaded;
  if (S.loaded) S.readAt = now();
}

const readable = (d) => d.pB != null && d.feeBps != null && d.debtCeiling != null && d.depthCeiling != null && d.totalDebt != null;
const postOf = (V) => (V.post && V.d && (!readable(V.d) || V.d.pL == null || V.d.recovered == null) && V.post.who === (who() || '').toLowerCase() && now() - V.post.at < POST_TTL ? V.post : null);
const lapsed = (x) => x.auction && x.d.recovered == null;
const needs = (x, t) => (t === 'borrow' && x.paused && !x.auction) || (t === 'withdraw' && x.wpaused && !x.auction) || ((t === 'deposit' || t === 'repay') && lapsed(x));
function derive(V, post = false) {
  const s = V.s;
  if (!s || !V.d) return null;
  const pre = post ? postOf(V) : null, D = pre ? pre.d : V.d;
  const mine = (D.who || '').toLowerCase() === (who() || '').toLowerCase();
  const d = mine ? D : { ...D, me: null, recovered: null, onOffer: null, tacBal: null, tacAllow: null, synBal: null, synAllow: null };
  const k = KIND[V.key], me = d.me || { collateral: 0n, debt: 0n, auctionStart: 0 };
  const room = d.depthCeiling != null && d.debtCeiling != null && d.totalDebt != null ? M.sharedRoom({ debtCeiling: d.debtCeiling, depthCeiling: d.depthCeiling, totalDebt: d.totalDebt }) : null;
  const x = { V, s, d, k, me, room, post: !!pre, sym: /^[A-Za-z0-9]{2,12}$/.test(d.symbol || '') ? d.symbol : k.sym, safe: 2n * s.liq };
  x.paused = d.pB == null || room == null || d.feeBps == null;
  x.auction = me.auctionStart !== 0;
  x.pauseEnd = d.pausedUntil != null ? Number(d.pausedUntil) : 0;
  x.auctionsPaused = x.pauseEnd > chainNow();
  x.value = d.pL != null ? M.valueOf(me.collateral, d.pL) : null;
  x.zone = d.pL != null ? M.zoneOf({ collateral: me.collateral, debt: me.debt, price: d.pL, liq: s.liq }) : null;
  x.ratio = x.value != null && me.debt > 0n ? M.ratioBps(x.value, me.debt) : null;
  x.borrow = x.paused ? null : M.borrowLimit({ collateral: me.collateral, debt: me.debt, pB: d.pB, mint: s.mint, feeBps: d.feeBps, room, minDebt: s.minDebt });
  x.borrowAll = x.paused ? null : M.borrowLimit({ collateral: me.collateral + (d.tacBal ?? 0n), debt: me.debt, pB: d.pB, mint: s.mint, feeBps: d.feeBps, room, minDebt: s.minDebt });
  x.wpaused = me.debt > 0n && d.pB == null;
  x.wmax = x.wpaused ? 0n : M.withdrawLimit({ collateral: me.collateral, debt: me.debt, pB: d.pB, mint: s.mint });
  x.rep = M.repayLimit({ debt: me.debt, balance: d.synBal ?? 0n, minDebt: s.minDebt });
  x.top = d.pL != null && me.debt > 0n ? M.topUp({ collateral: me.collateral, debt: me.debt, price: d.pL, bps: x.safe }) : 0n;
  x.liqPrice = M.liquidationPriceOf(me.collateral, me.debt, s.liq);
  x.line = Number(M.borrowLineBps({ mint: s.mint, pL: d.pL, pB: d.pB }));
  x.px = d.spot != null && d.feed && d.feed.answer > 0n ? d.spot * d.feed.answer / 10n ** BigInt(d.feed.decimals) : null;
  x.feedAge = V.key === 'usd' && d.feed ? Math.max(0, chainNow() - d.feed.updatedAt) : null;
  x.stale = x.feedAge != null && x.feedAge > s.staleness;
  x.cap = d.debtCeiling != null && d.depthCeiling != null ? (d.debtCeiling < d.depthCeiling ? d.debtCeiling : d.depthCeiling) : null;
  x.ownerCap = x.cap != null && d.debtCeiling < d.depthCeiling;
  x.backing = d.held != null && d.pL != null && d.totalDebt > 0n ? M.ratioBps(M.valueOf(d.held, d.pL), d.totalDebt) : null;
  return x;
}

const tac = (v) => M.fmtAmount(v, 2);
const syn = (x, v) => M.fmtAmount(v, x.k.dp);
const pctOf = (bps) => `${Math.floor(Number(bps) / 100).toLocaleString('en-US')}%`;
const feeText = (bps) => `${Number(bps) / 100}%`;
const priceText = (x, p, dir) => x.k.price(M.fmtUnits(M.sigTo(p, 3, dir), 18, 18));
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
    ...(xs.some((x) => pools.cell(x.V.key) != null) ? [['Sells for', (x) => pools.cell(x.V.key) ?? dash]] : []),
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
  const cost = carry && F.gas != null ? `, for about ${(Number(BigInt(carry * RECORD_GAS) * F.gas) / 1e18).toFixed(4)} ETH` : '';
  const carryLine = carry ? `<li>The last ${carry} price${carry === 1 ? '' : 's'} ${carry === 1 ? 'is' : 'are'} recorded with your transaction${cost}.</li>` : '';
  const notices = xs.filter((x) => x.auctionsPaused).map((x) => pauseBox(x, xs.length > 1)).join('') + changesNotice(xs);
  setHtml(el, `${head}<p class="verdict ${waiting ? 'wait' : open.length ? 'on' : 'off'}"><i class="sd"></i><span>${esc(verdict)}</span></p>
    ${needs || carryLine ? `<ul class="needs${waiting ? ' wait' : ''}">${needs}${carryLine}</ul>` : ''}
    <div class="bt-wrap"><table class="bt"><thead><tr><td></td>${xs.map((x) => `<th scope="col">${icon(x.V.key)}${esc(x.k.name)}<small>${esc(x.sym)}</small></th>`).join('')}</tr></thead><tbody>${boardRows(xs)}</tbody></table></div>
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

function healthBar(x) {
  const p2 = M.barPos(Number(x.s.liq)), p4 = M.barPos(Number(x.safe)), pl = M.barPos(x.line), pm = M.barPos(Number(x.ratio));
  const pc = (f) => `${(f * 100).toFixed(2)}%`, edge = pm < 0.1 ? ' l' : pm > 0.9 ? ' r' : '';
  const z = (name, w) => `<i class="hb-z ${name}${x.zone === name ? ' on' : ''}" style="width:${pc(w)}"></i>`;
  const label = `Ratio ${pctOf(x.ratio)}: ${x.zone === 'liquidation' ? 'liquidation' : x.zone === 'redemption' ? 'open to redemption' : 'safe'}. Liquidation under ${pctOf(x.s.liq)}, safe from ${pctOf(x.safe)}; you can borrow or withdraw down to ${pctOf(x.s.mint)}.`;
  return `<div class="hb" role="img" aria-label="${esc(label)}">
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
const lapsedCure = (x) => { const p = canAct() && lapsed(x) ? postOf(x.V) : null; return p && p.d.recovered ? p.n : 0; };
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
  rows.push(`<div class="kv"><span>Collateral</span><b class="num">${esc(tac(m.collateral))} TAC${x.value != null ? `<small>${esc(syn(x, x.value))} ${esc(x.sym)}</small>` : ''}</b></div>`);
  rows.push(`<div class="kv"><span>Debt</span><b class="num">${esc(syn(x, m.debt))} ${esc(x.sym)}</b></div>`);
  if (x.ratio != null) rows.push(`<div class="kv"><span>Ratio</span><b class="num z-${x.zone}">${esc(pctOf(x.ratio))}</b></div>`);
  if (x.borrow) rows.push(`<div class="kv"><span>You can borrow</span><b class="num">${esc(syn(x, x.borrow.amount))} ${esc(x.sym)}${x.borrow.binding === 'room' ? '<small>limited by the room left to borrow</small>' : ''}</b></div>`);
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
function planOf() {
  const P = planCore();
  if (P.ok && P.x?.post && needs(derive(P.x.V), P.kind)) { P.catchUp = P.x.V.post.n; P.via = viaOf(P.x.V); P.rows = [...P.rows, ['Price records', `${P.catchUp} included`]]; }
  return P;
}
function planCore() {
  const V = cur(), t = S.t, x = V && derive(V, true);
  if (!x) return { ok: false, cta: 'Reading the vault…', rows: [], hint: '' };
  const amt = M.parseUnits(S.amt, 18), m = x.me, d = x.d, sym = x.sym, mint = pctOf(x.s.mint);
  const P = { kind: t, x, amt, ok: false, cta: '', rows: [], hint: '', err: false, max: 0n, maxText: '' };
  const after = (collateral, debt) => (d.pL != null && debt > 0n ? M.ratioBps(M.valueOf(collateral, d.pL), debt) : null);
  const ratioRow = (collateral, debt) => { const r = after(collateral, debt), z = d.pL != null ? M.zoneOf({ collateral, debt, price: d.pL, liq: x.s.liq }) : null; return r != null ? [['Ratio after', `<span class="z-${z}">${esc(pctOf(r))}</span>`]] : []; };
  const fill = (n) => `<button class="linkbtn" type="button" data-fill="${M.plain(n)}">Add ${esc(tac(n))} TAC</button>`;
  const typed = S.amt.trim() !== '';
  if (typed && amt == null) { P.hint = 'Cannot read that amount. Write 1500 or 0.05 (1,500 alone is ambiguous).'; P.err = true; P.cta = 'Enter an amount'; return P; }
  const none = !amt;

  if (t === 'deposit') {
    const bal = d.tacBal ?? 0n; P.max = bal; P.maxText = who() ? `Balance ${tac(bal)} · Max` : '';
    if (who() && d.tacBal === 0n) P.hint = `This wallet holds no TAC. ${BUY}`;
    if (none) { P.cta = 'Enter an amount'; return P; }
    if (amt > bal) { P.cta = 'Not enough TAC'; return P; }
    P.ok = true; P.cta = 'Deposit TAC'; P.amount = amt;
    P.rows = [['Collateral after', `${esc(tac(m.collateral + amt))} TAC`], ...ratioRow(m.collateral + amt, m.debt)];
    return P;
  }
  if (t === 'borrow') {
    P.max = x.borrowAll?.amount ?? 0n; P.maxText = x.borrowAll && who() ? `Up to ${syn(x, P.max)} · Max` : '';
    if (x.auction) { P.cta = 'In an auction'; P.hint = 'Borrowing waits until the auction ends. Repay, or add TAC, to end it.'; return P; }
    if (x.paused) {
      const f = feedOf(x.V);
      if (!x.stale && ((!f && !F.tried) || (f && !f.ready && f.missing > 0 && f.missing <= BATCH_MAX && !viaOf(x.V) && viaPending(x.V)))) { P.cta = 'Checking prices…'; return P; }
      if (!x.stale && f && !f.ready && f.missing && viaOf(x.V) && PREP.busy && PREP.vkey === x.V.key) { P.cta = 'Preparing the prices…'; return P; }
      if (!x.stale && f && !f.ready && f.missing) { P.record = f.missing; P.cta = `Record ${f.missing} price${f.missing === 1 ? '' : 's'} to open borrowing`; return P; }
      P.cta = 'Borrowing is paused'; P.hint = 'Borrowing waits until prices are recorded.'; return P;
    }
    if (none) { P.cta = 'Enter an amount'; return P; }
    const held = d.tacBal ?? 0n, check = (collateral) => M.checkBorrow({ amount: amt, collateral, debt: m.debt, pB: d.pB, mint: x.s.mint, feeBps: d.feeBps, room: x.room, minDebt: x.s.minDebt });
    let c = check(m.collateral), add = 0n;
    P.cta = `Borrow ${sym}`;
    if (!c.ok && c.why === 'own') {
      const need = M.collateralFor(c.owe, d.pB, x.s.mint), exact = need > m.collateral ? need - m.collateral : 0n, least = M.ceilTo(exact, 2);
      const safeAdd = d.pL != null ? M.topUp({ collateral: m.collateral, debt: c.owe, price: d.pL, bps: x.safe }) : 0n, want = safeAdd > least ? safeAdd : least;
      add = held >= want ? want : held >= least ? least : held >= exact ? held : 0n;
      if (!(add > 0n)) { P.err = true; P.hint = `Borrowing this takes ${tac(least)} TAC in the vault. You hold ${tac(held)}.${held === 0n ? ` ${BUY}` : ''}`; return P; }
      c = check(m.collateral + add);
    }
    if (!c.ok) {
      P.err = true;
      if (c.why === 'min') P.hint = `Smallest debt is ${syn(x, x.s.minDebt)} ${sym}: borrow at least ${syn(x, M.ceilTo(c.least, x.k.dp))}.`;
      else if (c.why === 'own') P.hint = `You can borrow up to ${syn(x, c.limit)} ${sym} now.`;
      else P.hint = `Only ${syn(x, c.limit)} ${sym} is left to borrow.`;
      return P;
    }
    P.ok = true; P.amount = amt; P.feeBps = d.feeBps; P.add = add;
    const owe = c.owe, r = after(m.collateral + add, owe);
    P.rows = [...(add > 0n ? [['TAC added to your vault', `${esc(tac(add))} TAC`]] : []), [`Fee (${feeText(d.feeBps)})`, `${esc(syn(x, c.fee))} ${esc(sym)}`], ['You receive', `${esc(syn(x, amt))} ${esc(sym)}`], ['You owe after', `${esc(syn(x, owe))} ${esc(sym)}`], ...ratioRow(m.collateral + add, owe)];
    if (add > 0n) P.cta = `Deposit ${tac(add)} TAC and borrow`;
    if (r != null && d.pL != null && M.zoneOf({ collateral: m.collateral + add, debt: owe, price: d.pL, liq: x.s.liq }) !== 'safe') {
      const more = M.topUp({ collateral: m.collateral + add, debt: owe, price: d.pL, bps: x.safe });
      P.hint = `That leaves the vault at ${pctOf(r)}, open to redemption. ${add > 0n ? `Deposit ${tac(more)} TAC more first` : fill(more)} to stay at ${pctOf(x.safe)} or more.`;
    }
    return P;
  }
  if (t === 'repay') {
    const bal = d.synBal ?? 0n; P.max = x.rep.max; P.maxText = who() ? `You hold ${syn(x, bal)} · Max` : '';
    if (m.debt === 0n) { P.cta = 'Nothing to repay'; return P; }
    if (bal < m.debt) P.hint = `You hold ${syn(x, bal)} of the ${syn(x, m.debt)} ${sym} you owe.`;
    if (none) { P.cta = 'Enter an amount'; return P; }
    const c = M.checkRepay({ amount: amt, debt: m.debt, balance: bal, minDebt: x.s.minDebt });
    P.cta = c.all ? `Repay all ${sym}` : `Repay ${sym}`;
    if (!c.ok) {
      P.err = true;
      if (c.why === 'balance') P.hint = bal < m.debt ? `You hold ${syn(x, bal)} of the ${syn(x, m.debt)} ${sym} you owe.${x.rep.max > 0n ? ` You can repay up to ${syn(x, x.rep.max)}.` : ''}` : `You hold ${syn(x, bal)} ${sym}.`;
      else P.hint = `Debt left must be zero or at least ${syn(x, x.s.minDebt)} ${sym}. Repay ${m.debt > x.s.minDebt ? `up to ${syn(x, M.floorTo(m.debt - x.s.minDebt, x.k.dp))}, or ` : ''}all ${syn(x, m.debt)}.`;
      if (c.why === 'balance') P.cta = 'Not enough ' + sym;
      return P;
    }
    P.ok = true; P.all = c.all; P.paid = c.paid; P.amount = c.all ? M.MAX_UINT : amt;
    P.rows = [['You owe', `${esc(syn(x, m.debt))} ${esc(sym)}`], ['Owed after', `${esc(syn(x, c.left))} ${esc(sym)}`], ...(c.left > 0n ? ratioRow(m.collateral, c.left) : [])];
    return P;
  }
  P.max = x.wmax; P.maxText = who() ? `Up to ${tac(x.wmax)} · Max` : '';
  if (x.auction) { P.cta = 'In an auction'; P.hint = 'Withdrawing waits until the auction ends. Repay, or add TAC, to end it.'; return P; }
  if (x.wpaused) {
    const f = feedOf(x.V);
    if (!x.stale && f && !f.ready && f.missing > 0 && f.missing <= BATCH_MAX && !viaOf(x.V) && viaPending(x.V)) { P.cta = 'Checking prices…'; return P; }
    if (!x.stale && f && !f.ready && f.missing && viaOf(x.V) && PREP.busy && PREP.vkey === x.V.key) { P.cta = 'Preparing the prices…'; return P; }
    if (!x.stale && f && !f.ready && f.missing) { P.record = f.missing; P.cta = `Record ${f.missing} price${f.missing === 1 ? '' : 's'} to withdraw`; return P; }
    P.cta = 'Withdrawing is paused'; P.hint = 'With a debt, withdrawing waits until prices are recorded.'; return P;
  }
  if (m.collateral === 0n) { P.cta = 'Nothing to withdraw'; return P; }
  if (none) { P.cta = 'Enter an amount'; return P; }
  P.cta = 'Withdraw TAC';
  if (amt > x.wmax) {
    P.err = true;
    P.hint = m.debt === 0n ? `You have ${tac(m.collateral)} TAC in the vault.` : x.wmax > 0n ? `You can withdraw up to ${tac(x.wmax)} TAC and stay at ${mint}.` : `Every TAC here is needed to keep the vault at ${mint}. Repay some ${sym} first.`;
    return P;
  }
  P.ok = true; P.all = m.debt === 0n && amt >= m.collateral; P.amount = P.all ? M.MAX_UINT : amt;
  P.rows = [['Collateral after', `${esc(tac(m.collateral - amt))} TAC`], ...ratioRow(m.collateral - amt, m.debt)];
  return P;
}

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
  $('#tk-h').textContent = x ? `${x.k.name} vault` : 'Vault';
  $('#amt-lbl').textContent = isTac ? `TAC to ${t}` : `${sym} to ${t}`;
  $('#unit').innerHTML = `${isTac ? '<svg class="tk" aria-hidden="true"><use href="#tk-tac"/></svg>' : icon(S.v)}${esc(isTac ? 'TAC' : sym)}`;
  $('#amt').setAttribute('aria-label', isTac ? `TAC to ${t}` : `${sym} to ${t}`);
  const bal = $('#bal'); bal.hidden = !P.maxText || !x; bal.textContent = P.maxText; bal.disabled = S.busy;
  setHtml($('#chips'), [25, 50, 75, 100].map((p) => `<button type="button" data-pct="${p}"${S.busy || !(P.max > 0n) ? ' disabled' : ''}>${p === 100 ? 'Max' : `${p}%`}</button>`).join(''));
  setHtml($('#info'), P.rows.map(([l, v]) => `<div class="kv"><span>${esc(l)}</span><b class="num">${v}</b></div>`).join(''));
  $('#info').hidden = !P.rows.length;
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

async function simulate(to, data, from) {
  try { await ethCall(to, data, { from }); return { ok: true }; } catch (e) { return { ok: false, e }; }
}
const WHY = {
  limit: (x) => `That would take the vault under ${pctOf(x.s.mint)}.`, room: () => 'There is less room to borrow than that.', auction: () => 'This vault is in an auction.',
  amount: (x) => `That amount is not accepted: a vault’s debt is zero or at least ${syn(x, x.s.minDebt)} ${x.sym}.`, fee: () => 'The borrow fee changed.', paused: () => 'Borrowing waits until prices are recorded.',
  noauction: () => 'There is no auction on this vault.', unhealthy: () => 'The vault has not recovered yet.', healthy: () => 'The vault is healthy.', ownerwindow: () => 'Only the vault’s owner can bid for now.',
  access: (x, kind) => `The ${kind === 'repay' ? x.sym : 'TAC'} was not available to the vault.`, balance: (x, kind) => `Not enough ${kind === 'repay' ? x.sym : 'TAC'}.`,
};
const failText = (x, kind, e) => { const w = refusal(e); return `${w && WHY[w] ? WHY[w](x, kind) : 'This would fail.'} Nothing was sent; the figures above are current.`; };
const errText = (e) => esc(e instanceof UserStopped ? e.message : String(e?.message || e).slice(0, 220));

async function withAccess({ V, token, amount, allowance, from, make, spender = V.addr, batched = false, check = (data) => simulate(V.addr, data, from) }) {
  if (allowance >= amount) return { data: make(null) };
  if (batched) return { data: make(null), approve: { to: token, data: encApprove(spender, amount) } };
  try {
    say('Sign the permit in your wallet. The signature costs nothing.');
    const [name, nonce] = await Promise.all([ethCall(token, SEL.name), ethCall(token, SEL.nonces + addrWord(from))]);
    const dl = chainDeadline(1200);
    const sig = await askTicket(() => wallet.signPermit({ token, name: decString(name), spender, value: amount, deadline: dl, nonce: wordAt(nonce, 0), owner: from }));
    const data = make({ value: amount, deadline: dl, ...sig });
    say('Checking it first…');
    const sim = await check(data);
    if (sim.ok || sim.ok === null) return { data };
    const why = refusal(sim.e);
    if (why && why !== 'access') throw Object.assign(new Error(why), { sim: sim.e });
  } catch (e) { if (e instanceof UserStopped || e instanceof StopWaiting || e.sim) throw e; }
  say(`Approve in your wallet. It lets the ${spender === V.addr ? 'vault' : 'router'} take exactly this amount.`);
  const h = await askTicket(() => wallet.sendTx({ to: token, data: encApprove(spender, amount), from }));
  say(`Waiting for the approval ${txLink(h)}`);
  if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
  return { data: make(null), approved: true };
}

async function run(kindOverride) {
  if (S.busy) return;
  if (!W.account) { connectWallet(); return; }
  const V = cur();
  if (!V || !canAct()) return;
  const from = W.account;
  const cancel = kindOverride === 'cancel';
  const typed = S.amt, shown = cancel ? null : planOf();
  if (shown?.record) { pokeFeed(viaOf(V) ? BATCH_MAX : 0); return; }
  if (!cancel && !shown.ok) return;
  S.busy = true; S.pre = false; lockAll(); renderTicket();
  try {
    say(shown?.catchUp ? 'Reading the vault and the missing prices again…' : 'Reading the vault again…');
    await load();
    if (shown?.catchUp) {
      for (let i = 0; i < 200 && PREP.busy; i++) await new Promise((r) => setTimeout(r, 300));
      await prepare(V);
    }
    const P = cancel ? { kind: 'cancel', x: derive(V) } : planOf();
    if (S.amt !== typed) throw new Error('The amount changed. Nothing was sent.');
    if (!cancel && !P.ok) { say(`<span class="err">${esc(P.record ? 'The prices changed while this was prepared.' : P.hint || 'That is no longer possible.')} Nothing was sent; the figures above are current.</span>`); return; }
    const x = P.x, owner = from;
    if (P.kind === 'borrow' && P.feeBps > shown.feeBps) { say(`<span class="err">The borrow fee is now ${esc(feeText(P.feeBps))}. Nothing was sent; the figures above are current.</span>`); return; }
    if (P.kind === 'borrow' && (P.add ?? 0n) > (shown.add ?? 0n)) { say(`<span class="err">The TAC to deposit is now ${esc(tac(P.add))}. Nothing was sent; the figures above are current.</span>`); return; }
    const allow = P.kind === 'deposit' ? [P.amount, x.d.tacAllow] : P.kind === 'borrow' && P.add > 0n ? [P.add, x.d.tacAllow] : P.kind === 'repay' ? [P.paid, x.d.synAllow] : null;
    const via = P.catchUp ? viaOf(V) : S.batchOk && allow && (allow[1] ?? 0n) < allow[0] ? 'bundle' : null, post = P.catchUp ? V.post : null;
    let extra = [];
    const bundle = (d) => [...(post ? [{ to: MULTICALL3, data: post.data }] : []), ...extra, { to: V.addr, data: d }];
    const check = via === 'bundle' ? (d) => simulateBundle(rpc, from, bundle(d)) : via === 'router' ? (d) => simulate(ROUTER, d, from) : undefined;
    let target = via === 'router' ? ROUTER : V.addr, carried = 0;
    let data, acc = {};
    if (cancel) {
      const rec = lapsedCure(x) ? postOf(V) : null;
      if (rec) { data = encBatch([...rec.recs.map((r) => ({ to: r.to, data: r.data })), { to: V.addr, data: encCancel(owner) }]); target = MULTICALL3; carried = rec.n; }
      else data = encCancel(owner);
    }
    else if (via === 'router') {
      const records = [encRouterRecords(V.addr, post.recs)];
      const deadline = chainDeadline(300), nonce = wordAt(await ethCall(V.addr, SEL.nonces + addrWord(from)), 0);
      if (P.kind === 'withdraw') {
        say('Sign the withdrawal in your wallet. The signature costs nothing.');
        const sig = await askTicket(() => signTyped(from, withdrawTyped(V.addr, from, { amount: P.amount, nonce, deadline })));
        acc = { data: encMulticall([...records, encRouterWithdraw(V.addr, { amount: P.amount, deadline }, sig)]) };
      } else if (P.kind === 'deposit') {
        const make = (p) => encMulticall([...records, ...(p ? [encPermit('permitTac', p)] : []), encRouterDeposit(V.addr, P.amount)]);
        const allowance = wordAt(await ethCall(x.s.tac, SEL.allowance + addrWord(from) + addrWord(ROUTER)), 0);
        acc = await withAccess({ V, token: x.s.tac, amount: P.amount, allowance, from, spender: ROUTER, check, make });
      } else if (P.kind === 'repay') {
        const make = (p) => encMulticall([...records, ...(p ? [encRouterPermitSynth(V.addr, p)] : []), encRouterRepay(V.addr, P.paid)]);
        const allowance = wordAt(await ethCall(x.s.synth, SEL.allowance + addrWord(from) + addrWord(ROUTER)), 0);
        acc = await withAccess({ V, token: x.s.synth, amount: P.paid, allowance, from, spender: ROUTER, check, make });
      } else {
        const args = { tacIn: P.add ?? 0n, amount: P.amount, maxFeeBps: shown.feeBps, minCollateral: x.me.collateral + (P.add ?? 0n), deadline };
        say('Sign the borrow in your wallet. The signature costs nothing.');
        const sig = await askTicket(() => signTyped(from, borrowTyped(V.addr, from, { ...args, nonce })));
        const make = (p) => encMulticall([...records, ...(p ? [encPermit('permitTac', p)] : []), encRouterBorrow(V.addr, args, sig)]);
        if (args.tacIn > 0n) {
          const allowance = wordAt(await ethCall(x.s.tac, SEL.allowance + addrWord(from) + addrWord(ROUTER)), 0);
          acc = await withAccess({ V, token: x.s.tac, amount: args.tacIn, allowance, from, spender: ROUTER, check, make });
        } else acc = { data: make(null) };
      }
    }
    else if (P.kind === 'deposit') {
      acc = await withAccess({ V, token: x.s.tac, amount: P.amount, allowance: x.d.tacAllow ?? 0n, from, check, batched: via === 'bundle', make: (p) => (p ? encMulticall([encPermit('permitTac', p), encDeposit(P.amount)]) : encDeposit(P.amount)) });
    } else if (P.kind === 'borrow' && P.add > 0n) {
      acc = await withAccess({ V, token: x.s.tac, amount: P.add, allowance: x.d.tacAllow ?? 0n, from, check, batched: via === 'bundle', make: (p) => encMulticall([...(p ? [encPermit('permitTac', p)] : []), encDeposit(P.add), encBorrow(P.amount, shown.feeBps)]) });
    } else if (P.kind === 'borrow') acc = { data: encBorrow(P.amount, shown.feeBps) };
    else if (P.kind === 'repay') {
      acc = await withAccess({ V, token: x.s.synth, amount: P.paid, allowance: x.d.synAllow ?? 0n, from, check, batched: via === 'bundle', make: (p) => { const call = encRepay(owner, P.amount); return p ? encMulticall([encPermit('permitSynth', p), call]) : call; } });
    } else acc = { data: encWithdraw(P.amount) };
    if (acc.approve) extra = [acc.approve];
    data ||= acc.data;
    say('Checking it first…');
    const trial = () => (via === 'bundle' ? simulateBundle(rpc, from, bundle(data)) : simulate(target, data, from));
    let sim = await trial();
    for (let i = 0; i < 3 && sim.ok === false && acc.approved && refusal(sim.e) === 'access'; i++) { await new Promise((r) => setTimeout(r, 1500)); sim = await trial(); }
    if (sim.ok === false) { say(`<span class="err">${esc(failText(x, P.kind, sim.e))}</span>`); load().then(renderAll).catch(() => {}); return; }
    say(P.catchUp ? `Confirm in your wallet. It records the prices${extra.length ? ', approves the TAC' : ''} and then does this, as one transaction.` : extra.length ? 'Confirm in your wallet. It approves the amount and then does this, as one transaction.' : 'Confirm the transaction in your wallet.');
    const hash = via === 'bundle' ? await askTicket(() => sendAsBundle(from, bundle(data))) : await askTicket(() => wallet.sendTx({ to: target, data, from }));
    say(`Sent ${txLink(hash)}. Waiting for it to land…`);
    const rc = await wallet.receipt(hash);
    if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
    S.amt = ''; $('#amt').value = '';
    if (P.catchUp || carried) { for (const v of VS) v.post = null; loadFeed(); }
    await load().catch(() => {});
    const x2 = derive(V), said = { deposit: `Deposited ${tac(P.amount ?? 0n)} TAC.`, borrow: `${P.add > 0n ? `Deposited ${tac(P.add)} TAC and borrowed` : 'Borrowed'} ${P.amount != null ? syn(x2, P.amount) : ''} ${x2.sym}. You owe ${syn(x2, x2.me.debt)}.`, repay: x2.me.debt === 0n ? `Repaid. Nothing owed now.` : `Repaid. You owe ${syn(x2, x2.me.debt)} ${x2.sym}.`, withdraw: 'Withdrawn.', cancel: 'The auction has ended.' }[P.kind];
    const recs = P.catchUp || carried;
    say(`<span class="ok">${esc(said + (recs ? ` Recorded ${recs} price${recs === 1 ? '' : 's'} with it.` : ''))}</span> ${txLink(hash)}${S.t === 'borrow' ? ` <button class="linkbtn" type="button" data-watch="${esc(V.key)}">Add ${esc(x2.sym)} to your wallet</button>` : ''}`);
    setTimeout(() => { if (!S.busy) load().then(renderAll).catch(() => {}); }, 5000);
  } catch (e) {
    const x = derive(V);
    say(e instanceof StopWaiting ? esc(e.message) : `<span class="err">${e.sim ? esc(failText(x, S.t, e.sim)) : errText(e)}</span>`);
  } finally { S.busy = false; lockAll(); renderAll(); }
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

const busyNote = (ms) => { if (F.busy) setFeed(`The public nodes are busy. Trying again in ${Math.ceil(ms / 1000)} s…`); };
const feed = makeFeed({
  rpc,
  headerRpc: makeRpc([walletNode({ prefer: true }), ...HISTORY], { spread: true, onWait: busyNote }),
  proofRpc: makeRpc([walletNode({ prefer: true }), ...ARCHIVE], { spread: true, onWait: busyNote }),
});
const F = { by: {}, busy: false, note: '', bad: false, gas: null, at: 0, stop: null };
const ALREADY = '0x103b4afe';
const WALLET_HINT_MS = 20e3;
class StopWaiting extends Error { constructor() { super('Stopped waiting. If your wallet still shows the request, reject it there, then try again.'); } }
const feedOf = (V) => (V ? F.by[V.key] || null : null);
const oracleOf = (V) => V.oracle || V.addr;
const keepFeed = (V, st) => { for (const m of VS) if (oracleOf(m) === oracleOf(V)) F.by[m.key] = st; };
const VENUE = ['Precision pool', 'Tacit pool'];
const setFeed = (note, bad = false) => { F.note = note; F.bad = bad; const el = $('#feed-status'); if (el) { el.innerHTML = note; el.className = `status${bad ? ' err' : ''}`; } };
async function loadFeed() {
  if (!VS.length || F.busy) return;
  const firsts = [...new Map(VS.map((v) => [oracleOf(v), v])).values()];
  await Promise.all(firsts.map(async (V) => { try { keepFeed(V, await feed.read(V.addr)); F.at = now(); } catch (e) { console.warn('price feed read:', e?.message || e); } }));
  try { F.gas = BigInt(await rpc('eth_gasPrice', [])); } catch { }
  F.tried = true;
  renderFeed();
  renderBoard();
}
function renderFeed() { drawFeed(); renderTicket(); }
function drawFeed() {
  const el = $('#feed'), V = cur(), st = feedOf(V);
  const carried = V && st && !st.ready && st.missing > 0 && st.missing <= BATCH_MAX && !!viaOf(V) && !F.busy && !F.note;
  if (!VS.length || !st || carried || (st.ready && !F.busy && !F.note)) { el.hidden = true; return; }
  el.hidden = false;
  const cost = F.gas != null && st.missing ? `, for about ${(Number(BigInt(st.missing * RECORD_GAS) * F.gas) / 1e18).toFixed(4)} ETH` : '';
  const rows = st.venues.map((v, i) => `<div class="kv"><span>${esc(VENUE[i] || `Venue ${i + 1}`)}</span><b class="num">${v.counted} of ${v.points}</b></div>`).join('');
  setHtml(el, `<p class="eyebrow" id="feed-h"><span>Price feed</span><span class="who">${st.ready ? 'up to date' : `${st.missing} to record`}</span></p>
    <div class="rows flat">${rows}</div>
    ${st.missing ? `<p class="note">Anyone can record the ${st.missing} missing price${st.missing === 1 ? '' : 's'}${cost}.</p>
    <button class="btn" id="feed-go" type="button"${F.busy ? ' disabled' : ''}>${F.busy ? 'Recording…' : W.account ? `Record ${st.missing} price${st.missing === 1 ? '' : 's'}` : 'Connect wallet'}</button>` : ''}
    <div class="status${F.bad ? ' err' : ''}" id="feed-status" role="status">${F.note}</div>`);
  const go = $('#feed-go');
  if (go) go.onclick = () => pokeFeed();
}
function waitWallet(send, onHint, hold) {
  const hint = setTimeout(onHint, WALLET_HINT_MS);
  const stopped = new Promise((_, no) => { hold.stop = () => no(new StopWaiting()); });
  return Promise.race([send(), stopped]).finally(() => { clearTimeout(hint); hold.stop = null; });
}
const askWallet = (send, round) => waitWallet(send, () => setFeed(`Waiting for your wallet to confirm batch ${round}. Open it to answer, or <button class="linkbtn" type="button" data-feed-stop>stop waiting</button>.`), F);
const askTicket = (send) => waitWallet(send, () => say('Waiting for your wallet. Open it to answer, or <button class="linkbtn" type="button" data-stop>stop waiting</button>.'), S);
async function verifiedRecords(part, recs, note) {
  const pack = () => encBatch(recs.map((r) => ({ to: r.to, data: r.data })));
  let data = pack(), sim = await simulate(MULTICALL3, data, W.account);
  for (let again = 1; !sim.ok && again <= 2; again++) {
    const each = await Promise.all(recs.map((r) => simulate(r.to, r.data, W.account)));
    const bad = each.flatMap((r, i) => (!r.ok && !String(r.e?.data || '').startsWith(ALREADY) ? [i] : []));
    if (!bad.length) break;
    note(`Building ${bad.length} record${bad.length === 1 ? '' : 's'} again…`);
    const fresh = await Promise.all(bad.map((i) => feed.buildRecord(...part[i], undefined, again)));
    bad.forEach((i, j) => { recs[i] = fresh[j]; });
    data = pack(); sim = await simulate(MULTICALL3, data, W.account);
  }
  if (!sim.ok) {
    const each = await Promise.all(recs.map((r) => simulate(r.to, r.data, W.account)));
    const bad = each.find((r) => !r.ok && !String(r.e?.data || '').startsWith(ALREADY));
    if (bad) throw new Error(`A record would fail (${String(bad.e?.message || 'refused').slice(0, 120)}). Nothing was sent.`);
    return null;
  }
  return { data };
}

const BATCH_MAX = 12;
const POST_TTL = 10 * 60;
const PREP = { busy: false, vkey: null, failedAt: 0, last: null };
const viaOf = (V) => (S.batchOk ? 'bundle' : ROUTER && !S.routerOff && S.routerFor?.has(V.addr.toLowerCase()) ? 'router' : null);
const viaPending = () => now() - BOOT < 12 && ((ROUTER && !S.routerSettled) || S.batchBusy);
async function checkRouter() {
  if (!ROUTER) return;
  try {
    const [a, b] = await Promise.all([ethCall(ROUTER, ROUTER_SEL.vaultA), ethCall(ROUTER, ROUTER_SEL.vaultB)]);
    S.routerFor = new Set([addrAt(a), addrAt(b)].map((x) => x.toLowerCase()));
    renderAll();
  } catch { } finally { S.routerSettled = true; renderAll(); }
}
const addrAt = (hex) => `0x${String(hex).replace(/^0x/, '').slice(24, 64)}`;
const missingKey = (st) => st.venues.map((v) => v.missing.join()).join('|');
async function detectBatch() {
  const a = W.account ? W.account.toLowerCase() : null;
  if (a === S.batchFor) return;
  S.batchFor = a; S.batchOk = false;
  if (!a) { S.batchBusy = false; renderAll(); return; }
  S.batchBusy = true;
  const ok = await batchSupport(W.prov, W.account).catch(() => false);
  if (S.batchFor !== a) return;
  S.batchBusy = false; S.batchOk = ok;
  renderAll();
}
function maybePrepare() {
  const V = cur();
  if (!V || !canAct() || S.busy || F.busy || PREP.busy || now() - PREP.failedAt < 60) return;
  const x = derive(V), st = feedOf(V);
  if (!x || !st || st.ready || x.stale || !st.missing || st.missing > BATCH_MAX) return;
  if (!(viaOf(V) && needs(x, S.t)) && !lapsed(x)) return;
  const have = postOf(V), key = missingKey(st);
  if (have && have.key === key) return;
  if (PREP.last && PREP.last.key === key && now() - PREP.last.at < 60) return;
  prepare(V).then(renderAll);
}
async function prepare(V) {
  const from = W.account, who0 = (from || '').toLowerCase();
  if (!who0 || PREP.busy) return false;
  PREP.busy = true; PREP.vkey = V.key; renderTicket();
  try {
    const st = await feed.read(V.addr);
    keepFeed(V, st);
    if ((who() || '').toLowerCase() !== who0) return false;
    PREP.last = { key: missingKey(st), at: now() };
    if (!st.missing || st.missing > BATCH_MAX) { V.post = null; return false; }
    const part = feed.nextBatch(st, BATCH_MAX), keyOf = (v, k) => `${v.oracle}:${k}`;
    const kept = new Map((V.post?.recs || []).map((r) => [`${r.to}:${r.k}`, r]));
    const fresh = part.filter(([v, k]) => !kept.has(keyOf(v, k)));
    (fresh.length ? await feed.build(fresh) : []).forEach((r) => kept.set(`${r.to}:${r.k}`, r));
    const recs = part.map(([v, k]) => kept.get(keyOf(v, k)));
    const checked = await verifiedRecords(part, recs, () => {});
    if (!checked) { console.warn('price records: others recorded some while this was built'); return false; }
    const vs = VS.filter((m) => m.s && oracleOf(m) === oracleOf(V));
    const reads = vs.map((m) => dynamicCalls(m, from).map(([, to, data]) => ({ to, data })));
    const res = await readMixed(ethCall, [...recs.map((r) => ({ to: r.to, data: r.data, allowFailure: false })), ...reads.flat()]);
    let at = recs.length;
    const ds = vs.map((m, i) => { const d = parseDynamic(m, from, res.slice(at, at + reads[i].length)); d.who = from; at += reads[i].length; return [m, d]; });
    const d = ds.find(([m]) => m === V)[1];
    if (!(readable(d) || d.recovered != null)) { console.warn('price records: the records alone would not open the vault'); for (const m of vs) m.post = null; return false; }
    for (const [m, dm] of ds) m.post = { who: who0, key: missingKey(st), recs, data: checked.data, d: dm, n: recs.length, at: now() };
    return true;
  } catch (e) {
    PREP.failedAt = now(); for (const m of VS) if (oracleOf(m) === oracleOf(V)) m.post = null;
    console.warn('price records:', e?.message || e);
    return false;
  } finally { PREP.busy = false; }
}
const NO_BATCH = new Set([4200, 5700, 5710, 5740, 5750, 5760, -32601]);
const stopped = (e) => (e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(e?.message || '') ? new UserStopped() : e);
async function signTyped(from, typed) {
  if (String(W.account || '').toLowerCase() !== from.toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent; review it again.');
  await wallet.ensureMainnet();
  try { return String(await W.prov.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] })); } catch (e) {
    const s = stopped(e);
    if (s instanceof UserStopped) throw s;
    S.routerOff = true; for (const v of VS) v.post = null;
    throw new Error('Your wallet could not sign this. Nothing was sent: record the prices first, then try again.');
  }
}
async function sendAsBundle(from, calls) {
  if (String(W.account || '').toLowerCase() !== from.toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent; review it again.');
  await wallet.ensureMainnet();
  try { return await sendBundle(W.prov, from, calls); } catch (e) {
    if (stopped(e) instanceof UserStopped) throw new UserStopped();
    if (NO_BATCH.has(e?.code)) { S.batchOk = false; for (const v of VS) v.post = null; throw new Error('Your wallet could not send these together. Nothing was sent: record the prices first, then try again.'); }
    throw e;
  }
}

async function pokeFeed(leave = 0) {
  if (F.busy) return;
  if (!W.account) { await connectWallet(); return; }
  F.busy = true; renderFeed();
  try {
    for (let round = 1; round <= 12; round++) {
      const V = cur(), st = await feed.read(V.addr);
      keepFeed(V, st);
      renderFeed();
      if (st.missing <= leave) break;
      const part = feed.nextBatch(st);
      setFeed(`Building ${part.length} record${part.length === 1 ? '' : 's'} (batch ${round})…`);
      const recs = await feed.build(part);
      const checked = await verifiedRecords(part, recs, setFeed);
      if (!checked) { setFeed('Someone else is recording too; reading again…'); continue; }
      const data = checked.data;
      setFeed(`Confirm batch ${round} of ${round - 1 + Math.ceil(st.missing / PER_TX)} in your wallet (${part.length} record${part.length === 1 ? '' : 's'}).`);
      const hash = await askWallet(() => wallet.sendTx({ to: MULTICALL3, data, from: W.account }), round);
      setFeed(`Sent ${txLink(hash)}. Waiting for it to land…`);
      const rc = await wallet.receipt(hash);
      if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing more was sent.`);
      setFeed(`Batch ${round} recorded ${txLink(hash)}.`);
    }
    F.busy = false; await loadFeed();
    setFeed(feedOf(cur())?.ready ? 'The price feed is up to date.' : leave && feedOf(cur())?.missing <= leave ? `The older prices are recorded. The last ${feedOf(cur()).missing} go with your transaction.` : 'Recorded what could be. Some newer prices still need adding: record again.');
  } catch (e) {
    F.busy = false;
    setFeed(errText(e), !(e instanceof UserStopped || e instanceof StopWaiting));
  } finally { F.busy = false; await loadFeed(); refresh(); }
}

function readHash() {
  const p = params(), v = p.get('v'), t = p.get('t'), a = p.get('a'), amt = p.has('amt') ? M.parseUnits(p.get('amt'), 18) : null;
  if (v && VS.some((x) => x.key === v)) S.v = v;
  if (ACTS.some(([k]) => k === t)) S.t = t;
  S.view = ADDR.test(a || '') ? a : null;
  if (amt != null && amt > 0n && !S.busy) { S.t = 'borrow'; S.pre = false; S.amt = M.plain(amt); $('#amt').value = S.amt; say('', ''); }
  if (p.has('amt')) keepInHash();
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
  mineP = import('/vault/mine.js?cb=c84fc10c').then((m) => { m.mountMine($('#btc-mine'), { pick: pickProvider }); $('#btc-mine [data-mine="open"]')?.click(); })
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
  if (m) { e.preventDefault(); const p = params(); p.delete('a'); history.replaceState(null, '', location.pathname + (p.toString() ? `#${p}` : '')); S.view = null; refresh(); }
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
