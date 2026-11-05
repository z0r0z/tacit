// What this browser's bridges are and where each one stands, read from the journals the front page's bridge keeps.
//
// The front page and this page's forms start a bridge and move it on (dapp/burndep-ux.js on the way in from Bitcoin, dapp/crossout-ux.js on the way out
// to it); this page reads what they journal, and moves one on itself only once its holder opens the key here (mover.js). The engines lease
// each bridge while they move it, so it is never moved from two pages at once. A journal is one list per key:
//   tacit-burndep-bridge-v1:mainnet:<pub>    TAC (and tETH coming back) from Bitcoin to the pool on Ethereum
//   tacit-crossout-bridge-v1:mainnet:<pub>   TAC and tETH from the pool to Bitcoin
// Records also carry signing material for the steps still to come, so only the public fields named below are ever read out of
// them, and nothing read here leaves the page except a transaction id or block number, for a chain status.
//
// Pure functions over plain data, so they can be tested without a page.

export const IN_PREFIX = 'tacit-burndep-bridge-v1:mainnet:';
export const OUT_PREFIX = 'tacit-crossout-bridge-v1:mainnet:';
// The front page's bridge plans ({ [pub]: { [bridge id]: plan } }): a plan with `burn` has its two-step burn sent by the page itself.
export const PLAN_KEY = 'tacit-lite-bridge-plan-v1';

// The asset ids both chains know a note by (cxfer-core), lower case, without 0x.
export const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
export const CBTC_ID = '62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
export const CUSD_ID = '8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d';
// USDT crosses under the id of its registration in the pool; it keeps USDT's six decimals (`dec`), the others carry eight
export const CUSDT_ID = 'c50e8dd9666f64a23e5457d686382901f08aaea3554328fc4ac25d2f9fac6c00';

// Every asset's routes: where one starts (the front page's Bridge tab, or the Borrow page for a lock) and where the front page's sheet moves one on
// that is under way. `in` is from Bitcoin to Ethereum, `out` the other way.
export const ROUTES = {
  tac: {
    ticker: 'TAC', icon: 'tk-tac', dp: 4,
    in: { start: '/#card=bridge:btc', href: '/#bridge', go: 'Bridge TAC', steps: ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'] },
    out: { start: '/#card=bridge:tac', href: '/#bridge/out', go: 'Bridge TAC', steps: ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'] },
  },
  teth: {
    ticker: 'tETH', icon: 'tk-teth', dp: 6,
    in: { start: '/#card=bridge:tb', href: '/#private/bitcoin/back', go: 'Bring tETH back', steps: ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'] },
    out: { start: '/#card=bridge:eth', href: '/#private/bitcoin/out', go: 'Bridge tETH', steps: ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'] },
  },
  // cBTC is made by a lock (the Borrow tab's); once made it crosses as tETH does, to Bitcoin and back, from the Borrow sheet's cBTC and cUSD on Bitcoin
  cbtc: {
    ticker: 'cBTC', icon: 'tk-cbtc', dp: 8,
    in: { start: '/#card=bridge:kb', href: '/#borrow/bitcoin/cbtc/back', go: 'Bring cBTC back', steps: ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'] },
    out: { start: '/#card=bridge:cbtc', href: '/#borrow/bitcoin/cbtc', go: 'Bridge cBTC', steps: ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'] },
  },
  cusd: {
    ticker: 'cUSD', icon: 'tk-cusd', dp: 2,
    in: { start: '/#card=bridge:ub', href: '/#borrow/bitcoin/cusd/back', go: 'Bring cUSD back', steps: ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'] },
    out: { start: '/#card=bridge:cusd', href: '/#borrow/bitcoin/cusd', go: 'Bridge cUSD', steps: ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'] },
  },
  // USDT starts from the wallet's (the card makes it private, then bridges it) and has a sheet of its own
  cusdt: {
    ticker: 'cUSDT', icon: 'tk-usdt', dp: 2, dec: 6,
    in: { start: '/#card=bridge:ut', href: '/#usdt/bitcoin/back', go: 'Bring USDT back', steps: ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'] },
    out: { start: '/#card=bridge:wusdt', href: '/#usdt/bitcoin/out', go: 'Bridge USDT', steps: ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'] },
  },
};

// What one bridge takes while the bridge is new, in the eight-decimal units a note carries. The limits live in dapp/crossout-ux.js (to Bitcoin),
// dapp/burndep-ux.js (back from it) and the TAC minimum in the front page's own asset table; tests/bridge-track.test.mjs holds these to them.
const E8 = 100_000_000n;
export const LIMITS = {
  tac: { in: { max: 1000n * E8 }, out: { min: 20n * E8, max: 1000n * E8 } },
  teth: { in: { max: 50_000_000n }, out: { min: 100_000n, max: 50_000_000n } },
  cbtc: { in: { max: 50_000_000n }, out: { min: 1_000n, max: 50_000_000n } },
  cusd: { in: { max: 1000n * E8 }, out: { min: 10n * E8, max: 1000n * E8 } },
  cusdt: { in: { max: 1_000_000_000n }, out: { min: 2_000_000n, max: 1_000_000_000n } },       // 2 to 1,000 USDT, in six-decimal units
};
// The line under the steps: '20 to 1,000 TAC a bridge', 'Up to 0.5 tETH a bridge', or '' for a way with no such limit.
// The FAQ's sentence of every asset's limits, read from the same table as the line under the steps.
export function limitsSaid() {
  return ['tac', 'teth', 'cbtc', 'cusd', 'cusdt'].map((k) => { const l = LIMITS[k], r = ROUTES[k]; return `${r.ticker} ${fmtAmount(l.out.min, r.dp, r.dec)} to ${fmtAmount(l.out.max, r.dp, r.dec)} to Bitcoin and up to ${fmtAmount(l.in.max, r.dp, r.dec)} back`; }).join('; ');
}
export function limitLine(asset, dir) {
  const l = LIMITS[asset]?.[dir], r = ROUTES[asset];
  if (!l || !r) return '';
  return `${l.min ? `${fmtAmount(l.min, r.dp, r.dec)} to ` : 'Up to '}${fmtAmount(l.max, r.dp, r.dec)} ${r.ticker} a bridge while it is new`;
}

const lc = (s) => String(s || '').replace(/^0x/i, '').toLowerCase();
const big = (v) => { try { return BigInt(v?.__big ?? v ?? 0); } catch { return 0n; } };
const num = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);
// a transaction id is 64 hex digits: anything else read out of a record or an answer is not made into a link
const hex64 = (v) => { const x = lc(v); return /^[0-9a-f]{64}$/.test(x) ? x : null; };
const assetKey = (id, ticker) => (lc(id) === TETH_ID || ticker === 'tETH' ? 'teth' : lc(id) === CBTC_ID || ticker === 'cBTC' ? 'cbtc' : lc(id) === CUSD_ID || ticker === 'cUSD' ? 'cusd' : lc(id) === CUSDT_ID || ticker === 'cUSDT' ? 'cusdt' : 'tac');

// ── the way in: burndep-ux's stages ──────────────────────────────────────────────────────────────────────────────────────
// One-step ("reflected") and two-step (a move to a burn address, then a burn through a miner) bridges share the last two steps.
const IN_AT = {
  'rburn-signed': 0, 'rburn-sent': 0, 'rburn-mined': 2, rfolded: 3,
  'migrate-signed': 0, 'migrate-sent': 0, 'migrate-confirmed': 0, traced: 0, 'burn-signed': 0, 'burn-submitted': 0, 'burn-mined': 2, registered: 2, folded: 3,
};
const IN_SIGNED = ['rburn-signed', 'rburn-sent', 'migrate-signed', 'migrate-sent'];
const IN_DONE = ['minted', 'reclaimed'];
const IN_BACK = ['reclaimed', 'recovered'];                    // the TAC is on the key's Bitcoin address again (moved back, or returned by the relay's recovery)
const MINER_WAIT = 12 * 3600e3;

// What a bridge in waits on its holder for, in the front page's own words for the press (its Bridge tab offers it), or ''.
// A traced bridge needs no press when its plan sends the burn, or while a burn its holder pressed waits on the history check.
export function inDue(r, now = Date.now(), plan = null) {
  const err = r.lastError, tries = r.errorCount || 0;
  if (r.stage === 'traced') return (plan?.burn || r.checkWait?.go) && !err && !r.feeWait ? '' : 'Burn it';
  if ((r.stage === 'folded' || r.stage === 'rfolded') && !(r.arm && r.arm.ok)) {
    if (err && Number(err.until) > now) return '';            // the day's free mints are used up: the page mints it after midnight UTC
    if (err && err.relay) return '';                           // asked again by the page every few minutes
    return 'Mint now';
  }
  if (r.stage === 'stopped') return 'Move it back';
  if (r.stage === 'burn-signed' && err && tries >= 3) return 'Move it back';
  if (r.stage === 'burn-submitted' && now - Number(r.submittedAt || r.updatedAt || now) > MINER_WAIT) return 'Move it back';
  if ((r.stage === 'migrate-confirmed' || r.stage === 'traced') && err && tries >= 3) return 'Move it back';
  if (r.stage === 'not-recorded' && r.path === 'reflected' && !r.source?.p2tr && assetKey(r.source?.assetId, r.source?.ticker) === 'tac') return 'Recover';   // only TAC is recovered (the service takes no other asset)
  if (IN_SIGNED.includes(r.stage) && err && tries >= 3) return 'Try again or cancel';
  return '';
}

// What the API last said about a bridge's history check, as a fragment ('' when it said nothing or has not been heard from for
// minutes): so many checks ahead of it, or what it is doing while it runs (reading its history, so many of so many transactions, or
// checking them), or the line full. Only `progress` and `busy` are read out of
// the record's `checkWait`. The front page words the same fragment in its own copy (brCheckNote, dapp/index.html).
const CHECK_NOTE_FRESH_MS = 3 * 60_000;
export function checkNote(cw, now = Date.now()) {
  if (!cw || !(now - Number(cw.at || 0) <= CHECK_NOTE_FRESH_MS)) return '';
  if (cw.busy) return 'the check is busy with others, so it asks again by itself';
  const p = cw.progress;
  if (p && p.state === 'queued') return p.ahead < 1 ? 'it is next' : p.ahead === 1 ? 'one check is ahead of it' : `${p.ahead} checks are ahead of it`;
  if (p && p.state === 'running') {
    if (p.phase === 'reading' && p.total > 0) return `reading its history from Bitcoin, ${p.done} of ${p.total} transactions`;
    if ((p.phase === 'headers' || p.phase === 'verifying') && p.total > 0) return `checking its ${p.total} transactions now`;
    const m = Math.floor((Number(p.runningSec || 0) + (now - Number(cw.at)) / 1000) / 60);
    return m < 1 ? 'checking now' : `checking now, ${m} min in`;
  }
  return '';
}
// The presses a bridge in offers its holder, as the front page's row does: [{ kind, label, main }]. They are made with the key, by the page
// that holds it (mover.js here, the front page otherwise). A bridge that goes on by itself offers none.
export function inActs(r, due, now = Date.now()) {
  const failing = !!r.lastError && !['not-recorded', 'stopped', 'recovered', 'minted', 'reclaimed'].includes(r.stage);
  const acts = [];
  if (due === 'Burn it') acts.push({ kind: 'burn', label: 'Burn it', main: true });
  else if (due === 'Mint now') acts.push({ kind: 'mint', label: 'Mint now', main: true });
  else if (due === 'Move it back') acts.push({ kind: 'reclaim', label: 'Move it back', main: true });
  else if (due === 'Recover') acts.push({ kind: 'recover', label: 'Recover', main: true }, { kind: 'recheck', label: 'Check again' });
  else if (due === 'Try again or cancel') acts.push({ kind: 'poll', label: 'Try again', main: true }, { kind: 'cancel', label: 'Cancel this bridge' });
  else if (failing) acts.push({ kind: 'poll', label: 'Try again' });
  if (r.stage === 'not-recorded' && r.path === 'reflected' && !acts.some((a) => a.kind === 'recheck')) acts.push({ kind: 'recheck', label: 'Check again' });
  // a move Bitcoin's proof has not reached, kept failing: its burn can still be pressed, and the coin at its burn address can go home
  if (r.stage === 'traced' && r.lastError && (r.errorCount || 0) >= 3 && !acts.some((a) => a.kind === 'reclaim')) acts.push({ kind: 'reclaim', label: 'Move it back' });
  return acts;
}
// The Bitcoin transaction a way in links to, as the front page links it: nothing for a burn only signed (it was never sent), the move for a two-step bridge before its burn.
function inBtcTx(r, burnTxid) {
  if (r.stage === 'recovered' && r.recover?.txid) return hex64(r.recover.txid);
  if (r.stage === 'reclaim-sent' && r.reclaim?.txid) return hex64(r.reclaim.txid);
  if (burnTxid && ['rburn-sent', 'rburn-mined', 'rfolded', 'burn-mined', 'registered', 'folded', 'minted', 'not-recorded', 'recovering'].includes(r.stage)) return burnTxid;
  return r.migrate?.revealTxid && r.stage !== 'migrate-signed' ? hex64(r.migrate.revealTxid) : null;
}
export function inRow(r, now = Date.now(), plan = null) {
  const key = assetKey(r.source?.assetId, r.source?.ticker);
  const route = ROUTES[key]?.in || ROUTES.tac.in;
  const done = r.stage === 'minted';
  const burnTxid = hex64(r.burn?.txid), minted = hex64(r.mintedTxHash);
  const row = {
    id: String(r.id || ''), dir: 'in', asset: key, amount: big(r.source?.amount), stage: r.stage,
    // a bridge that paid someone else ends in a payment to them, not a private note for the key
    at: done ? 4 : (IN_AT[r.stage] ?? 0), steps: r.stealth ? [...route.steps.slice(0, 3), 'Paid privately'] : route.steps, href: route.href, paid: !!r.stealth,
    done, back: IN_BACK.includes(r.stage), moving: ['reclaim-sent', 'recovering'].includes(r.stage), held: ['not-recorded', 'stopped'].includes(r.stage),
    due: done ? '' : inDue(r, now, plan), acts: done || IN_BACK.includes(r.stage) ? [] : inActs(r, inDue(r, now, plan), now), armed: !!(r.arm && r.arm.ok), checking: r.stage === 'traced' && !!r.checkWait && !r.lastError,
    checkNote: r.stage === 'traced' && !r.lastError ? checkNote(r.checkWait, now) : '',
    btcTx: inBtcTx(r, burnTxid), btcHeight: num(r.burnHeight), ethTx: minted ? '0x' + minted : null,
    since: num(r.createdAt), doneAt: num(r.mintedAt), err: r.lastError?.message ? String(r.lastError.message).slice(0, 240) : null,
    tries: num(r.errorCount), feeWait: r.feeWait && num(r.feeWait.rate) != null && num(r.feeWait.max) != null ? { rate: num(r.feeWait.rate), max: num(r.feeWait.max) } : null,
  };
  row.note = rowNote(row);
  return row;
}
// What holds a bridge, in the front page's words, so a press that spends a Bitcoin fee is made with its cost in view: the fee it waits for, or the
// error it keeps meeting (the engine's own message, which names the rates and the sats), and what a press would do that is not plain.
export function rowNote(row) {
  if (row.done || row.back) return '';
  const parts = [];
  if (row.dir === 'in' && row.feeWait) parts.push(`Moved. The miner’s rate is ${row.feeWait.rate.toFixed(1)} sat/vB, over the ${row.feeWait.max} sat/vB allowed (twice the rate quoted), so its burn waits for the rate to fall. Burn it sends it now at today’s rate.`);
  else if (row.err) parts.push(`${String(row.err).replace(/^(crossout-ux|burndep-ux):\s*/, '')}${row.tries > 1 ? ` (${row.tries} tries)` : ''}`);
  const acts = (row.acts || []).map((a) => a.kind);
  if (row.dir === 'in' && row.stage === 'stopped') parts.push('This bridge paused before its burn, and your TAC is untouched. Move it back to your wallet, then bridge it again: it goes in one step.');
  if (row.dir === 'in' && row.stage === 'not-recorded' && acts.includes('recover')) parts.push('This bridge did not complete. Recover returns your TAC to your Bitcoin address so you can try again.');
  if (row.dir === 'in' && row.stage === 'not-recorded' && !acts.includes('recover')) parts.push('Bitcoin’s proof on Ethereum passed the burn without recording it, so it cannot be minted. Keep this row and its transaction ids, and ask for help with them.');
  if (row.dir === 'out' && acts.includes('resign')) parts.push('Bitcoin has not taken the signed transaction. Signing again uses a coin that is free now; it is only offered while the first one is not on Bitcoin.');
  if (row.dir === 'out' && acts.includes('retry')) parts.push('Confirmed on Bitcoin, but it was not credited. It can be sent again; that costs another Bitcoin fee.');
  if (row.dir === 'out' && acts.includes('cancel')) parts.push('Cancelling looks for the burn on Ethereum once more first. If it shows up later, “Can’t see a bridge?” finds it from its transaction.');
  if (row.dir === 'in' && acts.includes('cancel')) parts.push('Bitcoin has not taken this transaction. Cancelling asks Bitcoin once more, and frees what it holds for another try when Bitcoin has neither of the bridge’s transactions.');
  return parts.map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)).join(' ');
}

// ── the way out: crossout-ux's stages ─────────────────────────────────────────────────────────────────────────────────────
const OUT_AT = { settling: 0, settled: 1, covered: 2, 'mint-signed': 2, 'mint-submitted': 3, 'mint-confirmed': 3, 'mint-rejected': 3 };

export function outDue(r) {
  if (r.stage === 'covered') return r.lastError?.fundWait ? 'Add bitcoin' : 'Send to Bitcoin';         // the Bitcoin step is signed with the key, in the page that holds it; it waits for a coin of sats when the address has none
  if (r.stage === 'mint-rejected') return r.settle?.claimIdVerified !== false && (r.attempts || []).length + 1 < 3 ? 'Send it again' : 'Look at it';   // the front page's own press, while it offers one
  if (r.stage === 'settled' && r.settle && r.settle.claimIdVerified === false) return 'Look at it';
  if ((r.stage === 'mint-signed' || r.stage === 'mint-submitted') && r.lastError && (r.errorCount || 0) >= 6 && !r.feeWait) return 'Try again';
  return '';
}

// The same for a bridge out. Its Bitcoin step is sent by the page's pass, so a covered bridge has a press only when fees held it back.
export function outActs(r, now = Date.now()) {
  const unsure = !!r.settle && r.settle.claimIdVerified === false, fund = r.stage === 'covered' && !!r.lastError?.fundWait;
  const failing = !!r.lastError && !fund, rejected = r.stage === 'mint-rejected', tries = Number(r.errorCount) || 0;
  const high = failing && /fees are high/i.test(String(r.lastError?.message || ''));
  const acts = [];
  if (r.stage === 'minted') return acts;
  if (unsure) acts.push({ kind: 'recheck', label: 'Check it again', main: true });
  else if (r.stage === 'settling') acts.push({ kind: 'poll', label: 'Look again' });
  else if (r.stage === 'covered' && high) acts.push({ kind: 'force', label: 'Send it anyway', main: true });
  else if (rejected && r.settle?.claimIdVerified !== false && (r.attempts || []).length + 1 < 3) acts.push({ kind: 'retry', label: 'Send it again', main: true });
  else if (fund) acts.push({ kind: 'poll', label: 'Check again' });
  else if (failing && !rejected) acts.push({ kind: 'poll', label: 'Try again' });
  if ((r.stage === 'mint-signed' || r.stage === 'mint-submitted') && failing && tries >= 3) acts.push({ kind: 'resign', label: 'Sign it again' });
  if (r.stage === 'settling' && now - Number(r.createdAt || now) > 2 * 3600e3) acts.push({ kind: 'cancel', label: 'Cancel' });
  return acts;
}
export function outRow(r, now = Date.now()) {
  const key = assetKey(r.source?.assetId, r.source?.ticker);
  const route = ROUTES[key]?.out || ROUTES.tac.out;
  const done = r.stage === 'minted';
  const settleTx = hex64(r.settle?.txHash), btcTx = hex64(r.creditedTxid || r.mint?.revealTxid);
  const row = {
    id: String(r.id || ''), dir: 'out', asset: key, amount: big(r.source?.amount ?? r.source?.value), stage: r.stage,
    at: done ? 4 : (OUT_AT[r.stage] ?? 0), steps: route.steps, href: route.href,
    done, back: false, held: r.stage === 'mint-rejected', due: done ? '' : outDue(r), acts: outActs(r, now), armed: false,
    ethTx: settleTx ? '0x' + settleTx : null, ethBlock: num(r.settle?.ethBlock),
    btcTx,
    since: num(r.createdAt), doneAt: num(r.mintedAt), feeWait: !!r.feeWait,
    err: r.lastError?.message ? String(r.lastError.message).slice(0, 240) : null, tries: num(r.errorCount),
  };
  row.note = rowNote(row);
  return row;
}

// ── every journal in this browser ────────────────────────────────────────────────────────────────────────────────────────
// `storage` is anything with length/key(i)/getItem (localStorage). Arrived bridges stay listed for three days, then drop off.
export const KEEP_DONE_MS = 3 * 86400e3;

function parse(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function readBridges(storage, now = Date.now()) {
  const rows = [];
  let n = 0;
  try { n = storage ? storage.length : 0; } catch { return rows; }
  let plans = {};
  try { plans = JSON.parse(storage.getItem(PLAN_KEY) || 'null') || {}; } catch { /* no plans */ }
  for (let i = 0; i < n; i++) {
    let k;
    try { k = storage.key(i); } catch { continue; }
    if (!k) continue;
    const dir = k.startsWith(IN_PREFIX) ? 'in' : k.startsWith(OUT_PREFIX) ? 'out' : null;
    if (!dir) continue;
    let text = null;
    try { text = storage.getItem(k); } catch { continue; }
    for (const r of parse(text)) {
      if (!r || typeof r !== 'object' || !r.stage) continue;
      if (dir === 'in' && IN_BACK.includes(r.stage) && now - Number(r.updatedAt || r.createdAt || 0) > KEEP_DONE_MS) continue;
      const row = dir === 'in' ? inRow(r, now, plans[k.slice(IN_PREFIX.length)]?.[r.id] || null) : outRow(r, now);
      if (row.done && now - Number(row.doneAt || 0) > KEEP_DONE_MS) continue;
      row.pub = k.slice((dir === 'in' ? IN_PREFIX : OUT_PREFIX).length);        // the key it belongs to (public: it names the journal)
      rows.push(row);
    }
  }
  // what needs its holder first, then what is on its way, newest first; arrivals last
  const rank = (r) => (r.due ? 0 : r.done || r.back ? 2 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.since || 0) - (a.since || 0));
}

// ── what a bridge costs now: the live Bitcoin fee rate, the relay's floor, and the two prices ──────────────────────────────────
// The sizes are the app's own (crossout-mint-reveal.js estimateSats for the way out, burndep-ux.js bridgeCost 'reflected' for a P2TR note
// coming back); tests/bridge-track.test.mjs holds these to them.
const DUST = 546, REVEAL_VB = 180, COMMIT_VB = 154;
export const satsOut = (rate) => Math.ceil(REVEAL_VB * rate) + DUST + Math.ceil(COMMIT_VB * rate);
export const satsBack = (rate) => Math.max(500, Math.ceil(218 * rate)) + Math.max(500, Math.ceil((85 + 68) * rate));

// One line for the tile: what the way costs at today's rates, or '' while the rate is not known.
// c = { satvb, relay: { teth, tac } (units, 8 decimals), ethUsd, btcUsd }
export function costLine(asset, dir, c = {}) {
  const r = ROUTES[asset];
  if (!r || !r[dir] || !(c.satvb > 0) || (asset === 'tac' && dir === 'in')) return '';   // TAC's two-step way in is priced on its own sheet
  const sats = dir === 'out' ? satsOut(c.satvb) : satsBack(c.satvb);
  const fee = dir === 'out' ? c.relay?.[asset] : null;
  if (dir === 'out' && fee == null) return '';
  const btc = `${sats.toLocaleString('en-US')} sats on Bitcoin`;
  const relay = fee != null ? `${fmtAmount(fee, asset === 'teth' ? 4 : r.dp, r.dec)} ${r.ticker} to the relay` : '';
  const usd = asset === 'teth' && c.btcUsd > 0 && (fee == null || c.ethUsd > 0) ? (sats / 1e8) * c.btcUsd + (fee != null ? (Number(fee) / 1e8) * c.ethUsd : 0) : null;
  // The relay's figure is its floor; what the app quotes adds headroom for gas that moves, so the way out reads as a least.
  const lead = fee != null ? 'From' : 'About';
  const money = usd != null ? `${lead} $${usd < 10 ? usd.toFixed(2) : Math.round(usd)} now: ` : `${lead} `;
  return `${money}${[relay, btc].filter(Boolean).join(' and ')}${dir === 'in' ? '; Tacit covers the Ethereum side' : ''}`;
}

// A number of Bitcoin blocks (about ten minutes each) as a time: '40 min', or hours from an hour and a half.
export function btcSpan(blocks) {
  const m = Math.max(1, Math.round(Number(blocks) * 10));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} hours`;
}

// ── where a bridge really is, from the chains, when the journal has not been moved on (no page open) ─────────────────────
// `live` = { btcAttested, btcConfs, ethCovered, txs: Map(txid → { confirmed, height }) }. Returns a short line, or ''.
export function liveLine(row, live) {
  if (row.done || row.back) return '';
  if (row.checking) return `Its history is being checked before its burn${row.checkNote ? `: ${row.checkNote}` : ''}`;
  if (!live) return '';
  if (row.dir === 'in') {
    const tx = row.btcTx && live.txs?.get(row.btcTx);
    const h = row.btcHeight ?? (tx?.confirmed ? tx.height : null);
    if (row.btcTx && tx && !tx.confirmed && row.at < 2) return 'In the mempool, waiting for a block';
    if (h != null && live.btcAttested != null) {
      if (live.btcAttested >= h) return row.at < 3 ? 'Bitcoin’s proof on Ethereum has reached this block' : '';
      const left = h - live.btcAttested;
      return `Block ${h.toLocaleString('en-US')}: the proof is ${left.toLocaleString('en-US')} block${left === 1 ? '' : 's'} behind it, about ${btcSpan(left)}`;
    }
    return '';
  }
  if (row.ethBlock != null && live.ethCovered != null && row.at < 2) {
    if (live.ethCovered >= row.ethBlock) return 'Ethereum’s proof has reached this block';
    return `Ethereum block ${row.ethBlock.toLocaleString('en-US')}: the proof is about ${ethSpan(row.ethBlock - live.ethCovered)} short of it`;
  }
  const tx = row.btcTx && live.txs?.get(row.btcTx);
  if (tx && row.at >= 3) return tx.confirmed ? `In Bitcoin block ${Number(tx.height).toLocaleString('en-US')}` : 'In the mempool, waiting for a block';
  return '';
}

// A number of Ethereum blocks (12 seconds each) as a time: '20 min', or hours from an hour and a half.
export function ethSpan(blocks) {
  const m = Math.max(1, Math.round(Number(blocks) * 12 / 60));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} hours`;
}

// A row the journal still shows as waiting that the chains say is ready for its holder: the proof has reached its burn, and the next step
// needs the key, so it waits for the holder however long no page has been open. Returns the press the front page offers, or ''.
export function readyNow(row, live) {
  if (!live || row.done || row.back || row.due) return '';
  if (row.dir === 'out' && row.stage === 'settled' && row.ethBlock != null && live.ethCovered != null && live.ethCovered >= row.ethBlock) return 'Send to Bitcoin';
  if (row.dir === 'in' && !row.armed && row.stage === 'rburn-mined' && row.btcHeight != null && live.btcAttested != null && live.btcAttested >= row.btcHeight) return 'Mint now';
  return '';
}

// What a row says goes on next and whether it needs the holder: { due, self } (`self`: it goes on with no page open). With `live` (the
// chains' figures, see liveLine) a step the journal has not caught up with is named too. `auto`: the key of this bridge is open on the page that
// moves bridges on (mover.js), which takes the step the chains say is ready by itself on its next pass: it is not put to the holder.
export function nextOf(row, live = null, auto = false) {
  if (row.done || row.back) return { due: '', self: false };
  if (row.due) return { due: row.due, self: false };
  const ready = readyNow(row, live);
  if (ready) return auto ? { due: '', self: true } : { due: ready, self: false };
  if (row.dir === 'in') {
    // the burn and its record happen on the chains; the mint needs the page unless the relay holds it (armed)
    if (row.at >= 3) return { due: '', self: row.armed };
    if (row.held) return { due: '', self: false };                                           // not recorded (and not one that can be recovered): nothing moves it on
    return { due: '', self: !['rburn-signed', 'migrate-signed', 'migrate-confirmed', 'traced'].includes(row.stage) };
  }
  // out: the Ethereum burn and its proof go on by themselves; the Bitcoin step is the holder's (covered → due above)
  return { due: '', self: row.at < 2 || row.at >= 3 };
}

// An amount in an asset's units (8 decimals on both chains, 6 for cUSDT: `dec`), trimmed to the asset's places.
export function fmtAmount(raw, dp = 4, dec = 8) {
  const v = big(raw), neg = v < 0n, a = neg ? -v : v, one = 10n ** BigInt(dec);
  const whole = a / one, frac = (a % one).toString().padStart(dec, '0').slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}
