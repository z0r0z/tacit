import { makeConnect } from '/trade/connect.js?cb=92e87ca4';
import { $, esc, short, word, strip, fmtUnits, parseUnits, rpc, ethCall } from '/trade/util.js?cb=ba5a02b1';
import { SALE, FROM_BLOCK, TOTAL, FACE, LOCK_DAYS } from '/face/config.js?cb=aa6672a5';
import { pixelText, ghost, blocks } from '/face/pixel.js?cb=2a763b38';

// FACE RACE: buy TAC (and Z, one for one) from the sale at the oracle price less 5%, each buy unlocking over 90 days; the
// biggest buyer when it sells out (or after 30 days) gets the 0x000000000000FACE deploy right. Reads come from the
// public nodes; the leaderboard is built here from the sale's Bought events.

const SEL = {
  buy: '0xd96a094a', claimAll: '0x77329f35', finalize: '0x4bb278f3', price: '0xa035b1fe', sold: '0x02c7e7af',
  START: '0xba9a061a', END: '0xefe7a504', leader: '0x40eedabb', leaderSpent: '0x4bb9c7d3', spent: '0x1e6a41ea',
  bought: '0x667022fd', claimable: '0x402914f5', sharesClaimable: '0x493b6178', tokenOf: '0x42ec38e2',
  tokenURI: '0xc87b56dd', finalized: '0xb3f05b97', cancelled: '0x9a82a09a', MIN_BUY: '0x3af96b90', contributors: '0x6e7e3b2b',
};
const BOUGHT = '0xa9a40dec7a304e5915d11358b968c1e8d365992abf20f82285d1df1b30c8e24c';
const PAUSES = { '0x4e7e2916': 'BELOW FLOOR', '0x9fcbf9db': 'PRICES SETTLING', '0xa889a81f': 'PRICE FEED CATCHING UP' };

const S = { st: null, me: null, board: [], busy: false, note: '', bad: false, eth: '' };
const conn = makeConnect({
  describe: 'FACE RACE: buy TAC, race for 0x…FACE', name: 'tacit face', rewards: false,
  say: (t, b) => say(t, b), busy: () => S.busy, onChange: () => { S.me = null; render(); readMe(); },
});
const W = conn.W;
$('#wallet-chip').hidden = false;

const say = (t, bad = false) => { S.note = t; S.bad = bad; const el = $('#note'); if (el) { el.textContent = t; el.className = `note${bad ? ' bad' : ''}`; } };
const addr = (a) => word(BigInt(a));
const u = (hex) => (hex && hex !== '0x' ? BigInt(hex) : 0n);
const call = (sel, arg = '') => ethCall(SALE, sel + arg);
const eth = (v, d = 4) => fmtUnits(v, 18, d);
const tac = (v) => fmtUnits(v, 18, 0);

// ── reads ──
async function readState() {
  if (!SALE) { S.st = { soon: true }; render(); return; }
  try {
    const [start, end, sold, leader, leaderSpent, fin, can, minBuy, n] = await Promise.all(
      ['START', 'END', 'sold', 'leader', 'leaderSpent', 'finalized', 'cancelled', 'MIN_BUY', 'contributors'].map((k) => call(SEL[k]).then(u)));
    let price = null, pause = '';
    try { price = u(await call(SEL.price)); } catch (e) { pause = pauseWord(e); }
    S.st = { start, end, sold, leader: '0x' + leader.toString(16).padStart(40, '0'), leaderSpent, fin: !!fin, can: !!can, minBuy, n, price, pause };
  } catch { say('Could not read the race. Retrying…', true); }
  render();
}
const pauseWord = (e) => { const m = String(e?.data ?? e?.message ?? e).match(/0x[0-9a-f]{8}/i); return (m && PAUSES[m[0].toLowerCase()]) || 'PAUSED'; };

async function readMe() {
  const who = W.account;
  if (!SALE || !who) return;
  try {
    const a = addr(who);
    const [spent, bought, claimable, zClaimable, id] = await Promise.all(
      [SEL.spent, SEL.bought, SEL.claimable, SEL.sharesClaimable, SEL.tokenOf].map((s) => call(s, a).then(u)));
    let card = null;
    if (id) {
      const raw = strip(await call(SEL.tokenURI, word(id)));
      const len = Number(BigInt('0x' + raw.slice(64, 128)));
      const uri = new TextDecoder().decode(Uint8Array.from(raw.slice(128, 128 + len * 2).match(/../g).map((b) => parseInt(b, 16))));
      card = JSON.parse(atob(uri.split(',')[1])).image;
    }
    if (who === W.account) { S.me = { spent, bought, claimable, zClaimable, id, card }; render(); }
  } catch { /* shown as not yet bought */ }
}

// The leaderboard: every Bought event since the deploy block, summed per buyer. Ranked by ETH spent; ties go to whoever
// got there first, as the contract decides.
async function readBoard() {
  if (!SALE) return;
  try {
    const head = Number(await rpc('eth_blockNumber', []));
    const by = new Map();
    for (let from = FROM_BLOCK; from <= head; from += 10_000) {
      const logs = await rpc('eth_getLogs', [{ address: SALE, topics: [BOUGHT], fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(head, from + 9_999).toString(16) }]);
      for (const l of logs) {
        const who = '0x' + l.topics[1].slice(26), d = strip(l.data);
        const r = by.get(who) || { who, eth: 0n, tac: 0n, first: Number(l.blockNumber) * 1e4 + Number(l.logIndex) };
        r.eth += BigInt('0x' + d.slice(0, 64)); r.tac += BigInt('0x' + d.slice(64, 128));
        by.set(who, r);
      }
    }
    S.board = [...by.values()].sort((x, y) => (y.eth > x.eth ? 1 : y.eth < x.eth ? -1 : x.first - y.first));
    render();
  } catch { /* the board waits for the next refresh */ }
}

// ── actions ──
async function send(data, value = 0n, done = 'Done.') {
  if (!W.account) { await conn.connect(); return; }
  S.busy = true; render(); say('Confirm in your wallet. No popup? Reconnect your wallet.');
  try {
    const hash = await conn.wallet.sendTx({ to: SALE, data, value });
    say('Sent. Waiting for it to land…');
    const r = await conn.wallet.receipt(hash);
    say(r.status === '0x1' ? done : 'It did not go through. Nothing was spent but gas.', r.status !== '0x1');
  } catch (e) {
    say(e?.userStopped ? e.message : String(e?.message || e).slice(0, 140), true);
  } finally {
    S.busy = false; await Promise.all([readState(), readMe(), readBoard()]);
  }
}
// When buys pause because the price feed is behind, anyone can record the missing prices from their wallet.
async function catchUp() {
  if (!W.account) { await conn.connect(); return; }
  S.busy = true; render();
  try {
    const { makeCatchUp } = await import('/face/catchup.js?cb=faefced5');
    await makeCatchUp({ rpc, sale: SALE, wallet: conn.wallet, account: () => W.account, say }).run();
  } catch (e) {
    say(e?.userStopped ? e.message : String(e?.message || e).slice(0, 140), true);
  } finally {
    S.busy = false; await readState();
  }
}

function buy() {
  const st = S.st;
  let v;
  try { v = parseUnits(S.eth || '0', 18); } catch { return say('Enter an amount of ETH.', true); }
  if (v < st.minBuy) return say(`At least ${eth(st.minBuy)} ETH.`, true);
  const quote = (v * 10n ** 18n) / st.price;
  send(SEL.buy + word((quote * 99n) / 100n), v, 'Bought. Your TAC and Z unlock over 90 days.');
}

// ── page ──
const left = (t) => {
  const s = Math.max(0, t - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}D ${h}H` : h ? `${h}H ${m}M` : `${m}M ${s % 60}S`;
};

function phase(st) {
  if (st.soon) return { word: 'OPENS SOON', live: false };
  const now = Math.floor(Date.now() / 1000);
  if (st.can) return { word: 'CLOSED', live: false };
  if (st.fin) return { word: 'FINISHED', live: false };
  if (now < Number(st.start)) return { word: `OPENS IN ${left(Number(st.start))}`, live: false };
  if (st.sold >= TOTAL || now >= Number(st.end)) return { word: st.sold >= TOTAL ? 'SOLD OUT' : 'TIME', live: false, final: true };
  if (st.pause) return { word: st.pause, live: false, paused: true };
  return { word: `LIVE ${left(Number(st.end))} LEFT`, live: true };
}

function render() {
  const st = S.st || { soon: !SALE };
  const ph = phase(st);
  const sold = st.sold ?? 0n;
  const lit = Number((sold * 24n) / TOTAL);
  const me = (W.account || '').toLowerCase();
  const rank = S.board.findIndex((r) => r.who === me);

  $('#status').innerHTML = pixelText(ph.word, 3, ph.live ? 'hot' : '');
  $('#stats').innerHTML = `
    <div class="stat"><span>Price</span><b>${st.price ? (Number(st.price) / 1e18).toPrecision(3) : '—'}</b><em>ETH per TAC</em></div>
    <div class="stat"><span>Sold</span><b>${tac(sold)}</b><em>of ${tac(TOTAL)} TAC</em></div>
    <div class="stat"><span>Raised</span><b>${st.price !== undefined ? eth(S.board.reduce((a, r) => a + r.eth, 0n), 3) : '0'} ETH</b><em>${st.n ?? 0} racers</em></div>
    <div class="bar">${blocks(lit)}</div>`;

  const lead = st.leader && !/^0x0+$/.test(st.leader) ? st.leader : null;
  $('#lead').innerHTML = `<span>${st.fin ? 'Winner' : 'Leading'}</span>
    <b>${lead ? esc(short(lead, 5)) : '—'}</b><em>${lead ? `${eth(st.leaderSpent, 3)} ETH` : 'no one yet'}</em>`;

  const quote = st.price && S.eth ? (() => { try { return (parseUnits(S.eth, 18) * 10n ** 18n) / st.price; } catch { return null; } })() : null;
 $('#buy').innerHTML = ph.paused && st.pause !== 'BELOW FLOOR'
    ? `<p class="small">Buys wait for the price feed. Anyone can catch it up.</p>
       <button class="go" id="catch" ${S.busy ? 'disabled' : ''}>${pixelText('CATCH UP PRICES', 3)}</button>
       <p class="small">A few transactions from your wallet, gas only.</p>`
    : ph.final
    ? `<button class="go" id="fin" ${S.busy ? 'disabled' : ''}>${pixelText('FINISH RACE', 3)}</button>
       <p class="small">Sends 0x…FACE to the leader. Anyone can press it.</p>`
    : `<label for="eth">ETH</label>
       <div class="field"><input id="eth" inputmode="decimal" placeholder="0.1" value="${esc(S.eth)}" ${ph.live ? '' : 'disabled'}><span>ETH</span></div>
       <div class="kv"><span>You get</span><b>${quote ? `${tac(quote)} TAC + ${tac(quote)} Z` : '—'}</b></div>
       <button class="go" id="go" ${ph.live && !S.busy ? '' : 'disabled'}>${pixelText(W.account ? 'BUY' : 'CONNECT', 3)}</button>
       <p class="small">Every buyer gets a card.</p>`;

  const m = S.me;
  $('#me').innerHTML = !W.account ? `<p class="small">Connect to see your place.</p>`
    : !m || !m.bought ? `<p class="small">Not in the race yet.</p>`
    : `${m.card ? `<img class="card" src="${m.card}" alt="Your FACE contributor card">` : ''}
       <div class="kv"><span>Rank</span><b>${rank >= 0 ? `#${rank + 1}` : '—'}</b></div>
       <div class="kv"><span>Spent</span><b>${eth(m.spent, 4)} ETH</b></div>
       <div class="kv"><span>TAC / Z</span><b>${tac(m.bought)}</b></div>
       <div class="kv"><span>Unlocked now</span><b>${tac(m.claimable)} TAC · ${tac(m.zClaimable)} Z</b></div>
       <button class="go small-go" id="claim" ${m.claimable || m.zClaimable ? '' : 'disabled'}>${pixelText('CLAIM', 2)}</button>`;

  $('#board').innerHTML = S.board.length
    ? `<ol>${S.board.slice(0, 50).map((r, i) => `<li class="${i === 0 ? 'top' : ''}${r.who === me ? ' you' : ''}">
        <span class="rk">${i + 1}</span><span class="who">${esc(short(r.who, 5))}${r.who === me ? ' <em>you</em>' : ''}</span>
        <span class="amt">${eth(r.eth, 3)} ETH</span><span class="tc">${tac(r.tac)} TAC</span></li>`).join('')}</ol>`
    : `<p class="small">No racers yet.</p>`;

  $('#eth')?.addEventListener('input', (e) => { S.eth = e.target.value.trim(); const q = $('#buy .kv b'); if (q) { try { const v = (parseUnits(S.eth || '0', 18) * 10n ** 18n) / st.price; q.textContent = v ? `${tac(v)} TAC + ${tac(v)} Z` : '—'; } catch { q.textContent = '—'; } } });
  $('#go')?.addEventListener('click', () => (W.account ? buy() : conn.connect()));
  $('#catch')?.addEventListener('click', catchUp);
  $('#fin')?.addEventListener('click', () => send(SEL.finalize, 0n, 'Race finished.'));
  $('#claim')?.addEventListener('click', () => send(SEL.claimAll + addr(W.account), 0n, 'Claimed.'));
}

$('#title').innerHTML = pixelText('FACE RACE', 9, 'hot');
$('#deal').innerHTML = [
  ['5% OFF', 'under the market price'],
  ['+1 Z', 'for every TAC. Z holds a seat on tacit’s ops multisig.'],
  ['90 DAYS', 'unlocks from your buy'],
  ['WIN FACE', 'biggest buyer, at sellout or 30 days'],
].map(([k, v], i) => `<div>${pixelText(k, 3, i === 3 ? 'hot' : '')}<span>${v}</span></div>`).join('');
$('#h-board').innerHTML = pixelText('LEADERBOARD', 3);
$('#h-me').innerHTML = pixelText('YOU', 3);
$('#addr').innerHTML = `${pixelText('0X000000000000', 3)}${pixelText('FACE', 3, 'hot')}`;
$('#hero-ghost').innerHTML = ghost('0x000000000000face', 14);
$('#face-link').href = `https://etherscan.io/address/${FACE}`;
if (location.hash === '#demo') {
  const now = Math.floor(Date.now() / 1000), e = 10n ** 18n;
  S.board = [['0x7a1c90e2bd0b3c5d2f4b8e1a9c6d7e5f4a3b2c1d', 412n], ['0x3f9e2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f', 230n], ['0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a21', 155n], ['0x9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b', 41n], ['0x5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c', 10n]]
    .map(([who, c], i) => ({ who, eth: c * e / 100n, tac: c * e / 100n * e / 61400000000000n, first: i }));
  S.st = { start: BigInt(now - 86400 * 3), end: BigInt(now + 86400 * 27 + 3600 * 5), sold: S.board.reduce((a, r) => a + r.tac, 0n), leader: S.board[0].who, leaderSpent: S.board[0].eth, fin: false, can: false, minBuy: 25n * 10n ** 14n, n: 5n, price: 61400000000000n, pause: '' };
  S.eth = '0.5';
  render();
} else {
  render();
  readState(); readBoard();
}
if (location.hash !== '#demo') { setInterval(() => { readState(); readMe(); }, 20_000); setInterval(readBoard, 60_000); }
setInterval(() => { if (S.st && !S.busy && document.activeElement?.id !== 'eth') render(); }, 1000);
