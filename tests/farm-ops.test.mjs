// dapp/farm-ops.js, a private farm position as every page treats it: when Harvest and Unbond are offered, and an unbond refused over a pending
// reward sent again giving it up only when that reward is dust.
//   node tests/farm-ops.test.mjs
import assert from 'node:assert/strict';
import { exitSaid, canHarvest, canUnbond, unharvested, locked, harvest, unbond, UNBOND_DUST, HARVEST_WORTH, WTAC, wtacWithdrawCall, wtacBalanceCall, rewardNotes, relayable, worthHarvesting, redeem, lpNotes, takeOut, bFor, aFor, joinTerms, notesOf, exactOf, cutPick, cut, cutSized, ladder, feeShort, farmManager, bond, ownSend, ownWhy, walletSettle, relayedOrOwn } from '../dapp/farm-ops.js';

const now = 1_800_000_000;
assert.equal(canHarvest({ pendingUnits: '1' }), true); assert.equal(canHarvest({ pendingUnits: '0' }), false, 'nothing pending: nothing to harvest');
assert.equal(canHarvest({}), false); assert.equal(canHarvest({ pendingUnits: 'junk' }), false, 'an unreadable figure is nothing');
assert.equal(unharvested({ pendingUnits: String(UNBOND_DUST) }), false, 'dust is not an unharvested reward'); assert.equal(unharvested({ pendingUnits: String(UNBOND_DUST + 1n) }), true);
assert.equal(locked({ unlockAt: now + 60 }, now), true); assert.equal(locked({ unlockAt: now - 1 }, now), false); assert.equal(locked({}, now), false, 'no lock-up: free');
assert.equal(canUnbond({ unlockAt: now + 60, pendingUnits: '0' }, now), false, 'not before the bond is over');
assert.equal(canUnbond({ unlockAt: now - 1, pendingUnits: String(UNBOND_DUST * 2n) }, now), false, 'not while it holds a reward worth harvesting');
assert.equal(canUnbond({ unlockAt: now - 1, pendingUnits: '5' }, now), true);

const calls = [], t = {
  farmHarvest: async (a) => { calls.push(['harvest', a.position.id, a.waitOpts]); return { jobId: 'h' }; },
  farmUnbond: async (a) => { calls.push(['unbond', a.position.id, a.forfeitPending]); if (!a.forfeitPending && t.refuse != null) throw new Error(`farm-unbond: ${t.refuse} reward units would be forfeited`); return { jobId: 'u' }; },
};
assert.deepEqual(await harvest(t, 'PRIV', { id: 1 }, 'W'), { jobId: 'h' }); assert.deepEqual(calls.at(-1), ['harvest', 1, 'W']);
calls.length = 0; t.refuse = null;
await unbond(t, 'PRIV', { id: 2 }, 'W'); assert.deepEqual(calls, [['unbond', 2, false]], 'a clean unbond is sent once');
calls.length = 0; t.refuse = String(HARVEST_WORTH);
await unbond(t, 'PRIV', { id: 3 }, 'W', (p) => ({ ...p, id: 33 })); assert.deepEqual(calls, [['unbond', 3, false], ['unbond', 33, true]], 'refused over dust: sent again giving it up, with the position read again');
calls.length = 0; t.refuse = String(HARVEST_WORTH + 1n);
await assert.rejects(unbond(t, 'PRIV', { id: 4 }, 'W'), /reward units/, 'refused over a reward worth having: the refusal stands');
assert.equal(calls.length, 1);
// ── rewards turned into TAC, liquidity taken out ──
const to = '0x' + 'Ab'.repeat(20);
assert.deepEqual(wtacWithdrawCall(5n * 10n ** 18n, to), { to: WTAC, data: '0x00f714ce' + (5n * 10n ** 18n).toString(16).padStart(64, '0') + 'ab'.repeat(20).padStart(64, '0') }, 'withdraw(amount, to) on wTAC');
assert.equal(wtacBalanceCall(to).data, '0x70a08231' + 'ab'.repeat(20).padStart(64, '0'));
const RID = '0xRW', notes = [{ asset: '0xrw', value: '300' }, { asset: '0xother', value: '9' }, { asset: '0xRW', value: '50' }];
assert.deepEqual(rewardNotes(notes, RID).map((n) => n.value), ['300', '50'], 'the reward asset\'s notes, whatever its case'); assert.deepEqual(rewardNotes(notes, null), []);
const ft = { poolTickerOf: (id) => `tk(${id})`, quoteUnwrapFee: (v, tk) => { if (tk !== 'tk(0xrw)') throw new Error('ticker'); const fee = 100n; return { fee, net: BigInt(v) - fee }; } };
assert.equal(relayable(ft, { value: '300' }, RID), true); assert.equal(relayable(ft, { value: '100' }, RID), false, 'the fee takes it all: not through the relay');
assert.equal(relayable({ poolTickerOf: () => { throw new Error('x'); } }, { value: '1' }, RID), true, 'a note that cannot be priced is tried');
assert.equal(worthHarvesting(ft, HARVEST_WORTH, RID), false, 'dust is not harvested'); assert.equal(worthHarvesting(ft, HARVEST_WORTH + 1n, RID), true, 'over dust with a fee under half: harvested');
assert.equal(worthHarvesting({ poolTickerOf: () => 'x', quoteUnwrapFee: (v) => ({ fee: BigInt(v) }) }, 10n ** 9n, RID), false, 'a fee over half of it: not through the relay');
const rc = [], rt = { farmRedeem: async (a) => rc.push(a), lpRemove: async (a) => rc.push(a) };
await redeem(rt, 'PRIV', { id: 'n' }, to, 'W'); assert.deepEqual(rc.at(-1), { walletPriv: 'PRIV', note: { id: 'n' }, to, wait: true, waitOpts: 'W' });
const pool = { lpAsset: '0xLP', feeBps: 25, reserves: { assetA: '0xA', assetB: '0xB' } };
assert.deepEqual(lpNotes([{ asset: '0xlp', id: 1 }, { asset: '0xA', id: 2 }], pool).map((n) => n.id), [1], 'the pool\'s share notes');
await takeOut(rt, 'PRIV', pool, { id: 'lp' }, 'W'); assert.deepEqual(rc.at(-1), { walletPriv: 'PRIV', assetA: '0xA', assetB: '0xB', feeBps: 25, shareNote: { id: 'lp' }, waitOpts: 'W' }, 'taken out as the pool\'s two assets at its fee');
// ── joining ──
const res = { reserveA: 3n, reserveB: 10n, totalShares: 1n, assetA: '0xa', feeBps: 30 };
assert.equal(bFor(3n, res), 10n); assert.equal(bFor(1n, res), 4n, 'rounded up: the pool never takes less than its ratio'); assert.equal(aFor(10n, res), 3n); assert.equal(aFor(4n, res), 1n);
const jt = { poolTickerOf: (id) => `tk(${id})`, poolReserves: async (pid) => (pid === 'P' ? jt.res : null), quoteOpFee: async (tk) => (tk === 'tk(0xa)' ? 7 : 9), res };
assert.deepEqual(await joinTerms(jt, { poolId: 'P', reserves: { assetA: '0xA', assetB: '0xB' } }), { res, feeA: 7n, feeB: 9n });
await assert.rejects(joinTerms(jt, { poolId: 'Q', reserves: { assetA: '0xA', assetB: '0xB' } }), /not open/);
jt.res = { ...res, totalShares: 0n }; await assert.rejects(joinTerms(jt, { poolId: 'P', reserves: { assetA: '0xA', assetB: '0xB' } }), /not open/, 'no shares yet: not open');
jt.res = res; await assert.rejects(joinTerms(jt, { poolId: 'P', reserves: { assetA: '0xC', assetB: '0xB' } }), /reads differently/);
const ns = [{ asset: '0xA', value: '50' }, { asset: '0xa', value: '20' }, { asset: '0xB', value: '20' }, { asset: '0xA', value: '5' }];
assert.deepEqual(notesOf(ns, '0xa').map((n) => n.value), ['50', '20', '5']); assert.equal(exactOf(notesOf(ns, '0xA'), 20n).value, '20'); assert.equal(exactOf(notesOf(ns, '0xA'), 21n), null);
const as = notesOf(ns, '0xA');
assert.deepEqual(cutPick(as, 20n, 3n).map((n) => n.value), ['50'], 'the smallest one note that covers it and the fee');
assert.deepEqual(cutPick(as, 60n, 5n).map((n) => n.value), ['50', '20'], 'else the largest first until they do');
assert.equal(cutPick(as, 70n, 6n), null, 'not enough: none');
assert.equal(cutPick(Array.from({ length: 20 }, () => ({ value: '1' })), 17n, 0n), null, 'never more than 16 notes');
const jc = [], jx = { identity: (p) => ({ pubHex: `pub(${p})` }), transfer: async (a) => jc.push(a), lpBond: async (a) => jc.push(a) };
await cut(jx, 'PRIV', [{ value: '50' }], 20, 3, 'W'); assert.deepEqual(jc.at(-1), { walletPriv: 'PRIV', notes: [{ value: '50' }], recipientPubHex: 'pub(PRIV)', amount: 20n, fee: 3n, waitOpts: 'W' }, 'a cut is sent to the key itself');
jx.cfg = { farm: { manager: '0xM' } };
await bond(jx, 'PRIV', { manager: '0xm', aNote: 'a', bNote: 'b', waitOpts: 'W' }); assert.deepEqual(jc.at(-1), { walletPriv: 'PRIV', controller: '0xM', aNote: 'a', bNote: 'b', feeBps: 30, waitOpts: 'W' }, 'bonded under the configured farm manager at the pool\'s fee (30 when unread)');
const nb = jc.length;
assert.throws(() => farmManager(jx, '0xOther'), /other than the configured one/); await assert.rejects(async () => bond(jx, 'PRIV', { manager: '0xOther', aNote: 'a', bNote: 'b' }), /other than the configured one/); assert.equal(jc.length, nb, 'a manager the API names that is not the configured one gets nothing bonded');
assert.throws(() => farmManager({ cfg: {} }, '0xM'), /no farm program/); assert.equal(farmManager(jx, null), '0xM', 'no manager named: the configured one');
// ── the fee ladder, and a cut that is sent again at the next rung ──
assert.equal(ladder(5n), 5n); assert.equal(ladder(99n), 99n); assert.equal(ladder(123n), 130n); assert.equal(ladder(130n), 130n); assert.equal(ladder(1234567n), 1300000n, 'rounded up to two digits');
assert.equal(feeShort(new Error('relay: fee below the current floor')), true); assert.equal(feeShort('feeGate'), true); assert.equal(feeShort(new Error('relay 429')), false);
{
  const sent = [], t = { identity: () => ({ pubHex: 'pub' }), transfer: async (a) => { sent.push(a); if (t.floor && String(a.fee) === '100000') throw new Error('relay: fee below the current floor'); return { jobId: 'j' }; } };
  const notes = [{ value: '5000000' }, { value: '300000' }];
  t.floor = true;
  assert.deepEqual(await cutSized(t, 'PRIV', notes, 1000000n, 100000n, () => 'W'), { jobId: 'j' });
  assert.deepEqual(sent.map((a) => [String(a.fee), a.waitOpts]), [['100000', 'W'], ['200000', 'W']], 'refused for its fee: sent again at the next rung, each attempt with its own wait');
  sent.length = 0; t.floor = false;
  await cutSized(t, 'PRIV', notes, 1000000n, 100000n, 'W2'); assert.equal(sent.length, 1, 'taken the first time: sent once'); assert.equal(sent[0].waitOpts, 'W2', 'a wait that is not a function is used as it is');
  sent.length = 0; t.floor = true;
  await assert.rejects(cutSized(t, 'PRIV', [{ value: '1050000' }], 1000000n, 100000n, 'W'), /fee below/, 'the notes picked do not cover the higher fee: the refusal stands');
  assert.equal(sent.length, 1);
  const t2 = { identity: () => ({ pubHex: 'p' }), transfer: async () => { throw new Error('relay 503: down'); } };
  await assert.rejects(cutSized(t2, 'PRIV', notes, 1n, 1n, 'W'), /503/, 'any other refusal is passed on, not retried');
}
// ── an exit forfeits what it earned since its harvest ──
{
  const calls = [], t = { farmUnbond: async (a) => { calls.push([a.position.id, a.forfeitPending]); if (!a.forfeitPending) throw new Error('farm-unbond: 1041667 reward units are still pending'); return { jobId: 'u' }; } };
  assert.deepEqual(await unbond(t, 'PRIV', { id: 7 }, 'W', undefined, { forfeit: true }), { jobId: 'u' });
  assert.deepEqual(calls, [[7, true]], 'an exit gives it up at once: a position earning well has more than dust by the time its harvest is proved');
  calls.length = 0;
  await assert.rejects(unbond(t, 'PRIV', { id: 8 }, 'W'), /1041667 reward units/, 'a plain unbond over a reward worth having is still refused');
  assert.deepEqual(calls, [[8, false]]);
}
// How a position ends, as the Earn card's receipt says it: the pool's own lock decides when, and both coins come back private.
assert.equal(exitSaid(0, 'tETH / TAC'), 'any time, as private tETH and TAC', 'the launch pools have no lock (read from the farm contract: 0 seconds)');
assert.equal(exitSaid('0', 'tETH / cBTC'), 'any time, as private tETH and cBTC', 'a lock read as the text "0" is none too');
assert.equal(exitSaid(3 * 86400, 'tETH / cUSD'), 'after 3 days, as private tETH and cUSD', 'a lock of days says days');
assert.equal(exitSaid(36 * 3600, 'tETH / TAC'), 'after 2 days, as private tETH and TAC', 'a day and a half rounds to the nearest day');
assert.equal(exitSaid(7200, 'tETH / TAC'), 'after 2 h, as private tETH and TAC', 'a lock of hours says hours');
assert.equal(exitSaid(60, 'tETH / TAC'), 'after 1 h, as private tETH and TAC', 'a short lock is never "0 h"');
assert.equal(exitSaid(undefined, 'tETH / TAC'), null, 'a lock that is not known promises nothing');
assert.equal(exitSaid(null, 'tETH / TAC'), null, 'null is not none');
assert.equal(exitSaid('junk', 'tETH / TAC'), null, 'an unreadable lock promises nothing');
assert.equal(exitSaid(-5, 'tETH / TAC'), null, 'a negative lock is not a lock');
assert.equal(exitSaid(undefined, 'tETH / TAC', { lpOnly: true }), 'any time, as private tETH and TAC', 'LP only has no bond, so no lock, known or not');
assert.equal(exitSaid(9 * 86400, 'tETH / TAC', { lpOnly: true }), 'any time, as private tETH and TAC', 'and a pool lock does not apply to it');
assert.equal(exitSaid(0, 'TAC'), 'any time, as private TAC', 'a name that is not a pair is said as it is');
// A step the relay proves but will not send for free just now goes out from the connected wallet: the same step again with selfSettle.
{
  const refused = (code) => Object.assign(new Error('free relayed settles for today are used up (8/8)'), { code });
  assert.ok(ownSend(refused('free_budget')) && ownSend(refused('relay_held')), 'used-up free sends and a relay catching up are sent from the wallet');
  assert.ok(!ownSend(refused('prove_budget')) && !ownSend(refused('relay_paused')) && !ownSend(new Error('boom')), 'nothing else is: a relay that will not prove cannot be helped by a wallet');
  assert.match(ownWhy(refused('free_budget')), /free relay sends for this are used up, so your wallet sends this one/);
  assert.match(ownWhy(refused('relay_held')), /catching up on its sends/);

  const seen = [], step = (fail) => async (s) => { seen.push(s); if (!s && fail) throw refused(fail); return { jobId: s ? 'own' : 'relayed' }; };
  assert.deepEqual(await relayedOrOwn(step(null), 'SELF'), { jobId: 'relayed' }); assert.deepEqual(seen, [null], 'a relayed step that goes through is sent once');
  seen.length = 0; let told = null;
  assert.deepEqual(await relayedOrOwn(step('free_budget'), 'SELF', (e) => { told = e.code; }), { jobId: 'own' });
  assert.deepEqual(seen, [null, 'SELF'], 'refused for the day: sent again with the wallet sending'); assert.equal(told, 'free_budget', 'and the page is told why first');
  seen.length = 0;
  await assert.rejects(relayedOrOwn(step('free_budget'), null), /used up/, 'with no wallet to send it, the refusal stands');
  await assert.rejects(relayedOrOwn(step('prove_budget'), 'SELF'), /used up/, 'and a refusal a wallet cannot help with stands');

  // through the farm steps: each takes the wallet's sender and passes it as selfSettle on the second try
  const got = [], ft = {
    farmHarvest: async (a) => { got.push(['harvest', !!a.selfSettle]); if (!a.selfSettle) throw refused('free_budget'); return { jobId: 'h2', txHash: '0xh' }; },
    farmUnbond: async (a) => { got.push(['unbond', a.forfeitPending, !!a.selfSettle]); if (!a.selfSettle) throw refused('relay_held'); return { jobId: 'u2' }; },
    lpRemove: async (a) => { got.push(['out', !!a.selfSettle]); if (!a.selfSettle) throw refused('free_budget'); return { jobId: 'o2' }; },
    lpBond: async (a) => { got.push(['bond', !!a.selfSettle]); if (!a.selfSettle) throw refused('free_budget'); return { jobId: 'b2' }; },
    cfg: { farm: { manager: '0xm' } },
  };
  assert.deepEqual(await harvest(ft, 'P', { id: 1 }, 'W', 'SELF'), { jobId: 'h2', txHash: '0xh' });
  assert.deepEqual((await unbond(ft, 'P', { id: 2 }, 'W', undefined, { forfeit: true, own: 'SELF' })).jobId, 'u2');
  assert.deepEqual((await takeOut(ft, 'P', { reserves: { assetA: 'a', assetB: 'b' } }, { v: 1 }, 'W', 'SELF')).jobId, 'o2');
  assert.deepEqual((await bond(ft, 'P', { manager: '0xm', aNote: 1, bNote: 2, own: 'SELF' })).jobId, 'b2');
  assert.deepEqual(got, [['harvest', false], ['harvest', true], ['unbond', true, false], ['unbond', true, true], ['out', false], ['out', true], ['bond', false], ['bond', true]],
    'harvest, unbond, take-out and the two-coin entry each go relayed first, then from the wallet');
  got.length = 0;
  await assert.rejects(harvest(ft, 'P', { id: 1 }, 'W'), /used up/, 'a page that passes no wallet sender keeps the relay’s refusal');

  // the wallet's sender: estimated by the node first (a step that would revert is not sent), sent to the pool, waited for
  const sent = [], rpcSeen = [];
  const tt = { cfg: { pool: '0xpool' }, settleCalldata: ({ publicValues, proof, memos }) => `0xsettle:${publicValues}:${proof}:${memos.length}`,
    rpc: async (m, p) => { rpcSeen.push([m, p[0].from, p[0].to]); if (tt.revert) throw new Error('execution reverted: stale root'); return '0x7a120'; } };
  const wallet = { sendTx: async (x) => { sent.push(x); return '0xabc'; }, receipt: async () => ({ status: wallet.status ?? '0x1' }) };
  let asked = 0;
  const self = walletSettle(tt, wallet, async () => '0xme', { confirm: () => asked++ });
  assert.deepEqual(await self({ publicValues: '0xpv', proof: '0xpf', memos: ['0x1', '0x2'] }), { txHash: '0xabc' });
  assert.deepEqual(rpcSeen, [['eth_estimateGas', '0xme', '0xpool']]);
  assert.deepEqual(sent, [{ to: '0xpool', data: '0xsettle:0xpv:0xpf:2', from: '0xme', gas: 650000n }], 'sent to the pool with the node’s estimate and a margin');
  assert.equal(asked, 1, 'the page says to confirm before the wallet asks');
  tt.revert = true; sent.length = 0;
  await assert.rejects(self({ publicValues: '0xpv', proof: '0xpf', memos: [] }), /would not go through as the pool stands now, so nothing was sent/);
  assert.equal(sent.length, 0, 'a step that would revert is not sent');
  tt.revert = false; wallet.status = '0x0';
  await assert.rejects(self({ publicValues: '0xpv', proof: '0xpf', memos: [] }), /did not go through \(0xabc…\)\. Nothing was lost but its network fee/);
  await assert.rejects(walletSettle(tt, wallet, async () => null)({ publicValues: '0x', proof: '0x', memos: [] }), /connect a wallet and press again/);
  assert.equal(walletSettle(tt, null, '0xme'), null, 'no wallet that sends: no sender, so the relay’s refusal stands');
}
console.log('farm-ops: all checks passed');
