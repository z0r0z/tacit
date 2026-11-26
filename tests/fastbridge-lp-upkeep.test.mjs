// A pair provider's upkeep (fastbridge-lp/lib/automation.mjs and the modules it runs): the move of take coins to the reverse address (never a note, never a coin of
// a swap under way, batched, capped, a dry run first, the off switch, RBF), the accounting of each swap (the fee over the market, the network costs, reinvested
// or owed), the lean of the price (its bounds and the 3% guard), the merge of small ETH notes, and the buyback (off unless switched on, only past the target,
// only to TacBuyback, capped, the TAC it bought), the auto-shield of the pool account's ETH and the low-balance alerts. Nothing reaches a network.
//   node tests/fastbridge-lp-upkeep.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { recycleConfig, agreedFeeRate, outpointsIn, busyOutpoints, takeTxids, eligibleCoins, planBatch, buildRecycleTx, makeRecycler, vsizeOf, RECYCLE_DEFAULTS } from '../fastbridge-lp/lib/recycle.mjs';
import { emptyStats, feeOverMarket, addSwap, addCost, forwardEntry, reverseEntry, statsView, sampleCapacity } from '../fastbridge-lp/lib/stats.mjs';
import { skewConfig, skewBps, applySkew, feeAtMinBps } from '../fastbridge-lp/lib/skew.mjs';
import { notesConfig, noteReport, planMerge } from '../fastbridge-lp/lib/notes.mjs';
import { buybackConfig, targetConfig, planBuyback, attributeBuys, TAC_BUYBACK, buybackTopic } from '../fastbridge-lp/lib/buyback.mjs';
import { makeAutomation } from '../fastbridge-lp/lib/automation.mjs';
import { applyEnv } from '../fastbridge-lp/lib/env-config.mjs';
import { wireAutomation } from '../fastbridge-lp/lib/automation-wire.mjs';
import { shieldConfig, makeShield } from '../fastbridge-lp/lib/shield.mjs';
import { watchConfig, makeRefillWatch } from '../fastbridge-lp/lib/refill-watch.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T = (c) => c.repeat(64);
const MAIN = '0014' + '11'.repeat(20), REV = '0014' + '22'.repeat(20), OTHER = '0014' + '33'.repeat(20);
const cfg = (o = {}) => ({ ...recycleConfig({}, {}), ...o });
const RATE = { num: 300000000n, den: 10000000000n };          // 0.03 ETH per BTC: 1 sat = 0.03 pool units

// ── recycle ──
test('the switch: on by default, FB_LP_RECYCLE=off stops it, a bad value stops the process', () => {
  assert.equal(recycleConfig({}, {}).enabled, true);
  assert.equal(recycleConfig({}, { FB_LP_RECYCLE: 'off' }).enabled, false);
  assert.equal(recycleConfig({ recycle: false }, {}).enabled, false);
  assert.equal(recycleConfig({ recycle: false }, { FB_LP_RECYCLE: 'on' }).enabled, true);
  assert.throws(() => recycleConfig({}, { FB_LP_RECYCLE: 'maybe' }), /on or off/);
  assert.throws(() => recycleConfig({ recycle: { minCoin: 100 } }, {}), /minCoin/, 'a minimum of note size is refused');
  assert.throws(() => recycleConfig({ recycle: { minCoin: 50000, maxCoin: 20000 } }, {}), /not be over/);
});

test('the coins a swap under way names are busy; a finished swap\'s are not', () => {
  const open = { phase: 'locking', offer: { btc: { txid: T('a'), vout: 1 } }, feeInputs: [{ txid: T('b'), vout: 0 }] };
  const done = { phase: 'done', offer: { btc: { txid: T('c'), vout: 0 } } };
  const revOpen = { phase: 'broadcast', feeInputs: [{ txid: T('d'), vout: 2 }], lock: { txid: T('e'), vout: 0 } };
  const b = busyOutpoints([open, done], [revOpen, { phase: 'done', lock: { txid: T('f'), vout: 0 } }]);
  assert.deepEqual([...b].sort(), [`${T('a')}:1`, `${T('b')}:0`, `${T('d')}:2`, `${T('e')}:0`]);
  assert.equal(outpointsIn({ x: { txid: 'zz', vout: 0 } }).size, 0, 'only real txids');
});

test('the takes of finished swaps are read, each bump too; open and refunded swaps give none', () => {
  const ids = takeTxids([{ phase: 'done', takenBy: T('1'), take: { txid: T('2') }, takes: [T('2'), T('3')] }, { phase: 'refunded', takes: [T('4')] }, { phase: 'taking', takes: [T('5')] }]);
  assert.deepEqual(ids.sort(), [T('1'), T('2'), T('3')]);
});

test('eligible coins: in range only (never dust that may carry a note), never busy, never being spent, no duplicates', () => {
  const c = cfg();
  const coins = [{ txid: T('a'), vout: 0, value: 546 }, { txid: T('a'), vout: 1, value: 9_999 }, { txid: T('b'), vout: 0, value: 200_000 }, { txid: T('b'), vout: 0, value: 200_000 },
    { txid: T('c'), vout: 0, value: 300_000 }, { txid: T('d'), vout: 0, value: 400_000 }, { txid: T('e'), vout: 0, value: 6_000_000 }];
  const ok = eligibleCoins(coins, { cfg: c, busy: new Set([`${T('c')}:0`]), spending: new Set([`${T('d')}:0`]) });
  assert.deepEqual(ok.map((x) => x.txid), [T('b')]);
});

test('a batch: the largest coins first, several in one transaction, a fee share cap, a minimum, the caps per move and per day, and a kept reserve', () => {
  const coins = [100_000, 300_000, 250_000, 50_000, 900_000].map((v, i) => ({ txid: T(String(i)), vout: 0, value: v }));
  const p = planBatch({ coins, rate: 5, cfg: cfg() });
  assert.equal(p.inputs.length, 5); assert.equal(p.sum, 1_600_000); assert.equal(p.vsize, vsizeOf(5)); assert.equal(p.fee, Math.ceil(vsizeOf(5) * 5)); assert.equal(p.out + p.fee, p.sum);
  const capped = planBatch({ coins, rate: 5, cfg: cfg({ maxPerTickSats: 1_000_000 }) });
  assert.ok(capped.sum <= 1_000_000); assert.deepEqual(capped.inputs.map((c) => c.value), [900_000, 100_000]);
  assert.match(planBatch({ coins, rate: 5, cfg: cfg(), movedToday: 9_900_000 }).skip, /day's moves/);
  assert.match(planBatch({ coins: coins.slice(0, 1), rate: 5, cfg: cfg() }).skip, /under the batch/);
  assert.match(planBatch({ coins, rate: 900, cfg: cfg() }).skip, /fee .* would be over/);
  const kept = planBatch({ coins, rate: 5, cfg: cfg({ keepSats: 120_000 }) });
  assert.deepEqual(kept.inputs.map((c) => c.value).sort((a, b) => a - b), [250_000, 300_000, 900_000], 'the two smallest stay back as fee coins');
  assert.ok(planBatch({ coins, rate: 5, cfg: cfg({ maxInputs: 2 }) }).inputs.length === 2);
});

test('the transaction: only coins of the main key, one output to the reverse key, replaceable, and it adds up', () => {
  const inputs = [{ txid: T('a'), vout: 0, value: 200_000, spk: MAIN }, { txid: T('b'), vout: 3, value: 100_000, spk: MAIN }];
  const plan = { inputs, sum: 300_000, fee: 1000, out: 299_000 };
  const signed = [];
  const { tx } = buildRecycleTx({ plan, mainSpk: MAIN, reverseSpk: REV, sign: (t, i, v) => { signed.push([i, v]); return [`sig${i}`]; } });
  assert.equal(tx.outputs.length, 1); assert.equal(Buffer.from(tx.outputs[0].script).toString('hex'), REV); assert.equal(tx.outputs[0].value, 299_000);
  assert.ok(tx.inputs.every((i) => i.sequence === 0xfffffffd), 'RBF');
  assert.deepEqual(signed, [[0, 200_000], [1, 100_000]]);
  assert.throws(() => buildRecycleTx({ plan: { ...plan, inputs: [{ ...inputs[0], spk: OTHER }, inputs[1]] }, mainSpk: MAIN, reverseSpk: REV, sign: () => [] }), /not an output of the main key/);
  assert.throws(() => buildRecycleTx({ plan: { ...plan, out: 299_001 }, mainSpk: MAIN, reverseSpk: REV, sign: () => [] }), /does not add up/);
  assert.throws(() => buildRecycleTx({ plan, mainSpk: MAIN, reverseSpk: MAIN, sign: () => [] }), /must not be the main address/);
  assert.throws(() => buildRecycleTx({ plan, mainSpk: MAIN, reverseSpk: '5120' + '22'.repeat(32), sign: () => [] }), /P2WPKH/);
});

test('the fee rate: the median of two or more explorers that agree; too few, a disagreement or a rate over the cap waits', async () => {
  const fx = (vals) => async (u) => { const v = vals[u.split('/fee-estimates')[0]]; if (v == null) throw new Error('down'); return { ok: true, json: async () => ({ 6: v }) }; };
  assert.equal(await agreedFeeRate({ bases: ['a', 'b', 'c'], fetchImpl: fx({ a: 3.2, b: 4.1, c: 5 }) }), 5);
  assert.equal(await agreedFeeRate({ bases: ['a', 'b'], fetchImpl: fx({ a: 2, b: 3 }) }), 3);
  assert.equal(await agreedFeeRate({ bases: ['a', 'b'], fetchImpl: fx({ a: 0.124, b: 1 }) }), 1, 'estimates under the 1 sat/vB floor count as the floor, so 0.124 against 1 agrees');
  await assert.rejects(() => agreedFeeRate({ bases: ['a', 'b'], fetchImpl: fx({ a: 2 }) }), (e) => e.wait && /1 explorer gave/.test(e.message));
  await assert.rejects(() => agreedFeeRate({ bases: ['a', 'b'], fetchImpl: fx({ a: 2, b: 30 }) }), (e) => e.wait && /disagree/.test(e.message));
  await assert.rejects(() => agreedFeeRate({ bases: ['a', 'b'], fetchImpl: fx({ a: 40, b: 50 }), cap: 25 }), (e) => e.wait && /over the 25/.test(e.message));
});

// a main chain of stand-ins: the take transactions, their outspends, a broadcast that records
function chain({ takes, spent = new Set(), confirmed = new Set() }) {
  const sent = [];
  return {
    sent,
    fetchTx: async (txid) => (takes[txid] ? { txid, status: { confirmed: true }, vout: takes[txid] } : null),
    coinsIn: async (txid) => (takes[txid] || []).map((o, vout) => ({ o, vout })).filter(({ o, vout }) => o.scriptpubkey === MAIN && o.value > 546 && !spent.has(`${txid}:${vout}`)).map(({ o, vout }) => ({ txid, vout, value: o.value })),
    status: async (txid) => (confirmed.has(txid) ? { confirmations: 1, height: 9 } : { confirmations: 0, height: 0 }),
    outspend: async () => null,
    broadcast: async (p) => { sent.push(p.revealHex); },
  };
}
const store = (recs) => ({ list: async () => recs });
const memo = () => { let s = null; return { load: async () => (s ? JSON.parse(JSON.stringify(s)) : null), save: async (x) => { s = JSON.parse(JSON.stringify(x)); }, get: () => s }; };
const recycler = (o) => {
  const m = o.memo || memo();
  let n = 0;
  const r = makeRecycler({ cfg: cfg(o.cfg || {}), btc: o.btc, fwd: store(o.fwd), rev: store(o.rev || []), mainSpk: MAIN, reverseSpk: REV, sign: () => ['sig'], serialize: () => 'hex' + (++n), txidOf: () => T(String(n % 10)),
    load: m.load, save: m.save, feeRate: async () => o.rate ?? 3, now: o.now || (() => 1_000_000), log: () => {}, alert: (a) => (o.alerts || []).push(a), onMoved: o.onMoved || (() => {}) });
  return { r, m };
};
const takeOut = (v, spk = MAIN) => ({ value: v, scriptpubkey: spk, scriptpubkey_type: 'v0_p2wpkh' });

test('the recycler: a dry run on the first look, then one batch of the take coins to the reverse address; note-size outputs and other scripts are left', async () => {
  const takes = { [T('a')]: [takeOut(300_000), takeOut(546)], [T('b')]: [takeOut(400_000), takeOut(90_000, OTHER)], [T('c')]: [takeOut(500_000)] };
  const btc = chain({ takes });
  const fwd = [{ id: 's1', phase: 'done', takes: [T('a')] }, { id: 's2', phase: 'done', takenBy: T('b') }, { id: 's3', phase: 'locking', takes: [T('c')] }];
  const { r, m } = recycler({ btc, fwd });
  const d = await r.step();
  assert.equal(d.did, 'dry'); assert.equal(btc.sent.length, 0, 'the first look sends nothing');
  const s = await r.step();
  assert.equal(s.did, 'sent'); assert.equal(btc.sent.length, 1);
  assert.deepEqual(s.plan.inputs.map((c) => c.value).sort(), [300_000, 400_000], 'the open swap\'s take, dust and the other script are left alone');
  assert.equal(m.get().pending.sent, true); assert.equal(m.get().dayMoved, 700_000);
  const again = await r.step();
  assert.equal(again.did, 'waiting', 'while the move is unconfirmed nothing else is moved'); assert.equal(btc.sent.length, 1);
});

test('the recycler: off does nothing; a confirmed move is counted and its fee told; a long wait is replaced at a higher rate with the same coins', async () => {
  assert.equal((await recycler({ btc: chain({ takes: {} }), fwd: [], cfg: { enabled: false } }).r.step()).did, 'off');
  const takes = { [T('a')]: [takeOut(300_000)], [T('b')]: [takeOut(400_000)] };
  let t = 1_000_000;
  const confirmed = new Set(), btc = chain({ takes, confirmed }), moved = [];
  const { r, m } = recycler({ btc, fwd: [{ id: 's', phase: 'done', takes: [T('a'), T('b')] }], now: () => t, onMoved: (x) => moved.push(x) });
  await r.step(); const s = await r.step();
  t += 7 * 3600;
  const b = await r.step();
  assert.equal(b.did, 'bumped'); assert.equal(btc.sent.length, 2);
  const p = m.get().pending;
  assert.deepEqual(p.inputs.map((c) => c.txid).sort(), s.plan.inputs.map((c) => c.txid).sort()); assert.ok(p.rate > s.plan.rate && p.fee > s.plan.fee); assert.equal(p.replaced[0], s.txid);
  confirmed.add(p.txid);
  const c = await r.step();
  assert.equal(c.did, 'nothing'); assert.equal(m.get().moved, p.out); assert.equal(moved[0].fee, p.fee);
  assert.ok(m.get().drained[T('a')] && m.get().drained[T('b')], 'the spent takes are not read again');
});

test('the recycler: the day\'s cap holds across looks; an unsent move is sent again, never rebuilt from other coins', async () => {
  const takes = {}; for (let i = 0; i < 6; i++) takes[T(String(i))] = [takeOut(2_000_000)];
  const btc = chain({ takes }), confirmed = new Set();
  btc.status = async (txid) => (confirmed.has(txid) ? { confirmations: 1 } : { confirmations: 0 });
  let fail = true;
  const real = btc.broadcast; btc.broadcast = async (p) => { if (fail) throw new Error('refused'); return real(p); };
  const fwd = Object.keys(takes).map((k, i) => ({ id: 's' + i, phase: 'done', takes: [k] }));
  const { r, m } = recycler({ btc, fwd, cfg: { maxPerTickSats: 4_000_000, maxPerDaySats: 6_000_000 } });
  await r.step(); await r.step();
  const p = m.get().pending; assert.equal(p.sent, false); assert.equal(btc.sent.length, 0);
  fail = false;
  assert.equal((await r.step()).did, 'resent'); assert.equal(btc.sent[0], p.hex);
  confirmed.add(p.txid);
  const next = await r.step();
  assert.equal(next.did, 'sent', 'the first move confirmed, the next goes'); assert.equal(next.plan.sum, 2_000_000, 'only what the day has left');
  assert.equal(m.get().dayMoved, 6_000_000);
  confirmed.add(m.get().pending.txid);
  assert.equal((await r.step()).did, 'skip', 'the day is full'); assert.equal(btc.sent.length, 2);
});

// ── accounting ──
test('the fee over the market, in each direction', () => {
  // 2,900,000 units at 0.03 units a sat are worth 96,666,667 sats: no. units = sats * num / den, so sats = units * den / num = 2,900,000 * 10^10 / 3*10^8 = 96,666,666.67
  const q = { btcValue: '100000000', evmAmount: '2900000', mkt: { num: '300000000', den: '10000000000' } };
  assert.equal(feeOverMarket(q, 'fwd').sats, 100000000n - 96666667n, 'the sats taken less the ETH paid, rounded so the fee is never more than it was');
  const r = { btcValue: '96000000', evmAmount: '2900000', mkt: q.mkt };
  assert.equal(feeOverMarket(r, 'rev').eth, 2900000n - 2880000n, 'the ETH taken less the sats paid');
  assert.equal(feeOverMarket({ btcValue: '1', evmAmount: '1' }, 'fwd'), null);
});

test('a swap into the totals: net reinvested under the target, owed past it with buybacks on, a loss never owed, counted once', async () => {
  const st = emptyStats(100);
  const e = { id: 'f:1', dir: 'fwd', end: 'done', feeSats: 3000n, costSats: 500n, costEth: 10n };
  addSwap(st, e, { rate: RATE, owe: false });
  assert.equal(st.swaps, 1); assert.equal(st.feesEarnedSats, '3000'); assert.equal(st.networkCostSats, '500'); assert.equal(st.networkCostEth, '10');
  assert.equal(st.reinvestedEth, String((2500n * RATE.num) / RATE.den - 10n)); assert.equal(st.owedEth, '0');
  addSwap(st, e, { rate: RATE, owe: true }); assert.equal(st.swaps, 1, 'counted once');
  addSwap(st, { id: 'r:2', dir: 'rev', end: 'done', feeEth: 20000n, costSats: 400n }, { rate: RATE, owe: true });
  assert.equal(st.owedEth, String(20000n - 12n)); assert.equal(st.swapsReverse, 1);
  addSwap(st, { id: 'f:3', dir: 'fwd', end: 'lost', lossEth: 5000n }, { rate: RATE, owe: true });
  assert.equal(st.owedEth, String(20000n - 12n), 'a loss comes out of what is reinvested'); assert.equal(st.lossesEth, '5000');
  addCost(st, { sats: 1000 }, { rate: RATE }); assert.equal(st.networkCostSats, '1900');
  sampleCapacity(st, { eth: 5n, sats: 6n, valueEth: 7n }, 200); sampleCapacity(st, { eth: 8n, sats: 9n, valueEth: 10n }, 300);
  const v = statsView(st);
  assert.equal(v.capacity.valueEth, '10'); assert.equal(v.capacity.firstValueEth, '7'); assert.equal(v.since, 100);
  assert.ok(!('counted' in v), 'the ids are not shown');
});

test('a finished record into an entry: the confirmed take\'s fee, the relay\'s cut fee, a refund\'s costs, a loss', async () => {
  const fees = { [T('t')]: 1500, [T('l')]: 2200, [T('r')]: 900 };
  const io = { txFee: async (t) => fees[t] ?? null, relayFee: async () => 3000n };
  const q = { btcValue: '1000000', evmAmount: '28000', mkt: { num: '3000000', den: '100000000' } };
  const f = await forwardEntry({ id: 'a', phase: 'done', takes: [T('x'), T('t')], prepared: true, offer: { evm: { amount: '28000' } } }, q, io);
  assert.equal(f.costSats, 1500n); assert.equal(f.costEth, 3000n); assert.equal(f.feeSats, 1000000n - 933334n);
  const rf = await forwardEntry({ id: 'b', phase: 'refunded', lock: {}, offer: { evm: { amount: '1' } } }, q, io); assert.equal(rf.costEth, 3000n); assert.equal(rf.feeSats, 0n);
  const lost = await forwardEntry({ id: 'c', phase: 'lost', offer: { evm: { amount: '28000' } } }, q, io); assert.equal(lost.lossEth, 28000n);
  assert.equal(await forwardEntry({ id: 'd', phase: 'locking' }, q, io), null);
  const rq = { btcValue: '1000000', evmAmount: '31000', mkt: q.mkt };
  const rv = await reverseEntry({ id: 'e', phase: 'done', amount: '1000000', lock: { txid: T('l') } }, rq, io); assert.equal(rv.costSats, 2200n); assert.equal(rv.feeEth, 1000n);
  const rr = await reverseEntry({ id: 'g', phase: 'refunded', amount: '1000000', lock: { txid: T('l') }, refund: { txid: T('r') } }, rq, io); assert.equal(rr.costSats, 3100n); assert.equal(rr.end, 'refunded');
  const took = await reverseEntry({ id: 'h', phase: 'counter-took', amount: '1000000', lock: { txid: T('l') }, claimedAt: 5 }, rq, io); assert.equal(took.end, 'done');
  const robbed = await reverseEntry({ id: 'i', phase: 'counter-took', amount: '1000000', lock: { txid: T('l') } }, rq, io); assert.equal(robbed.lossSats, 1000000n);
});

// ── the lean ──
test('the lean: nothing in the dead band, toward the side running low, at most maxBps, and never past the guard with the fee at the minimum', () => {
  const c = skewConfig({}, {});
  const fam = { fwd: feeAtMinBps(120000, 20, 800), rev: feeAtMinBps(4000000, 20, 30000) };
  assert.ok(Math.abs(fam.fwd - 86.67) < 0.01 && Math.abs(fam.rev - 95) < 1e-9);
  assert.equal(skewBps({ ethValueSats: 55, btcSats: 45, cfg: c, feeAtMinBps: fam }), 0);
  assert.equal(skewBps({ ethValueSats: 100, btcSats: 0, cfg: c, feeAtMinBps: fam }), 15, 'all ETH: the rate rises the most');
  assert.equal(skewBps({ ethValueSats: 0, btcSats: 100, cfg: c, feeAtMinBps: fam }), -15);
  const mid = skewBps({ ethValueSats: 80, btcSats: 20, cfg: c, feeAtMinBps: fam });
  assert.ok(mid > 0 && mid < 15);
  assert.equal(skewBps({ ethValueSats: 100, btcSats: 0, cfg: { ...c, maxBps: 100 }, feeAtMinBps: { fwd: 50, rev: 240 } }), 10, 'the guard (250) less the dearer side\'s fee at its minimum (240)');
  assert.equal(skewBps({ ethValueSats: 100, btcSats: 0, cfg: { ...c, maxBps: 100 }, feeAtMinBps: { fwd: 50, rev: 300 } }), 0, 'a fee already past the guard leaves no lean');
  assert.equal(skewBps({ ethValueSats: 100, btcSats: 0, cfg: skewConfig({}, { FB_LP_SKEW: 'off' }), feeAtMinBps: fam }), 0, 'off');
  assert.throws(() => skewConfig({ skew: { guardBps: 400 } }, {}), /guardBps/);
  assert.throws(() => skewConfig({ skew: { maxBps: 500 } }, {}), /maxBps/);
});
test('the lean moves the one rate both ways: up pays a BTC -> ETH user more ETH and an ETH -> BTC user fewer sats', () => {
  const up = applySkew(RATE, 10), down = applySkew(RATE, -10);
  const units = (r, sats) => (sats * r.num) / r.den, sats = (r, u) => (u * r.den) / r.num;
  assert.ok(units(up, 1_000_000n) > units(RATE, 1_000_000n) && sats(up, 30_000n) < sats(RATE, 30_000n));
  assert.ok(units(down, 1_000_000n) < units(RATE, 1_000_000n) && sats(down, 30_000n) > sats(RATE, 30_000n));
  assert.equal(applySkew(RATE, 0), RATE);
});

// ── notes ──
test('the notes: usable is the largest 16 less a cut, dust counted; a merge of the smallest when there are many or some are dust, and only when cheap', () => {
  const n = (v, i) => ({ value: String(v), leaf: '0x' + i.toString(16).padStart(64, '0') });
  const notes = Array.from({ length: 20 }, (_, i) => n(1_000_000 + i, i)).concat([n(100, 99)]);
  const c = notesConfig({}, {});
  const rep = noteReport(notes, { cutFee: 5000n, dustUnits: c.dustUnits });
  assert.equal(rep.notes, 21); assert.equal(rep.dust, 1); assert.ok(BigInt(rep.usable) < BigInt(rep.total));
  const p = planMerge(notes, { fee: 5000n, cfg: c });
  assert.equal(p.notes.length, 16); assert.equal(p.notes[0].value, '100', 'the smallest first'); assert.equal(p.out, p.sum - 5000n);
  assert.match(planMerge(notes, { fee: 10_000_000n, cfg: c }).skip, /fee/);
  assert.match(planMerge([n(5_000_000, 1), n(6_000_000, 2)], { fee: 0n, cfg: c }).skip, /none of them dust/);
  assert.equal(planMerge(notes, { fee: 0n, cfg: notesConfig({}, { FB_LP_NOTES_MERGE: 'off' }) }).skip, 'off');
});

// ── buyback ──
test('the buyback: off unless the environment turns it on, only to TacBuyback; the target', () => {
  assert.equal(buybackConfig({ buyback: { enabled: true } }, {}).enabled, false, 'a config file alone does not start it');
  const on = buybackConfig({}, { FB_LP_BUYBACK: 'on' });
  assert.equal(on.enabled, true); assert.equal(on.to, TAC_BUYBACK);
  assert.throws(() => buybackConfig({ buyback: { to: '0x' + '12'.repeat(20) } }, {}), /TacBuyback/);
  assert.throws(() => buybackConfig({}, { FB_LP_BUYBACK: 'yes' }), /on or off/);
  assert.throws(() => buybackConfig({ buyback: { minSendEth: '1', maxPerSendEth: '0.5' } }, {}), /minSendEth/);
  const t = targetConfig({}, {}); assert.equal(t.eth, 10n * 10n ** 8n); assert.equal(t.btcAsEth, 10n * 10n ** 8n);
  assert.equal(targetConfig({}, { FB_LP_TARGET_ETH: '2.5' }).btcAsEth, 250000000n);
  assert.throws(() => targetConfig({ target: { eth: 'ten' } }, {}), /target.eth/);
});
test('the buyback plan', () => {
  const on = buybackConfig({}, { FB_LP_BUYBACK: 'on' }), t = targetConfig({}, {});
  const base = { owed: 50_000_000n, ethFree: 11n * 10n ** 8n, targetEth: t.eth, aboveTarget: true, cfg: on };
  assert.equal(planBuyback({ ...base, cfg: buybackConfig({}, {}) }).skip, 'off');
  assert.match(planBuyback({ ...base, aboveTarget: false }).skip, /under the target/);
  assert.match(planBuyback({ ...base, quiet: false }).skip, /under way/);
  assert.equal(planBuyback(base).amount, 25_000_000n, 'at most 0.25 ETH a send');
  assert.equal(planBuyback({ ...base, ethFree: t.eth + 3_000_000n }).amount, 3_000_000n, 'never below the target');
  assert.match(planBuyback({ ...base, ethFree: t.eth + 500_000n }).skip, /under the least/);
  assert.equal(planBuyback({ ...base, dayRouted: 40_000_000n }).amount, 10_000_000n, 'the day\'s cap');
  assert.match(planBuyback({ ...base, owed: 0n }).skip, /under the least/);
});
test('the TAC bought: the provider\'s share of each buy, pro rata to its part of the contract\'s ETH; an unreadable balance counts nothing', async () => {
  const ev = [{ block: 10, ethIn: 100n, tacOut: 1000n }, { block: 20, ethIn: 100n, tacOut: 900n }, { block: 30, ethIn: 100n, tacOut: 800n }];
  const bal = { 9: 400n, 19: 300n, 29: null };
  const r = await attributeBuys({ events: ev, pending: 200n, balanceBefore: async (e) => { const b = bal[e.block - 1]; if (b == null) throw new Error('no'); return b; } });
  // first: 100 * 200/400 = 50 -> 500 TAC; second: 100 * 150/300 = 50 -> 450 TAC; third unreadable
  assert.equal(r.used, 100n); assert.equal(r.tac, 950n); assert.equal(r.pending, 100n);
  const all = await attributeBuys({ events: [{ block: 1, ethIn: 100n, tacOut: 10n }], pending: 500n, balanceBefore: async () => 100n });
  assert.equal(all.used, 100n, 'never more than the buy'); assert.equal(all.tac, 10n);
  assert.equal(buybackTopic(keccak_256), '0x' + Buffer.from(keccak_256(new TextEncoder().encode('Bought(uint8,uint256,uint256)'))).toString('hex'));
});

// ── the whole look ──
const kvMem = () => { const m = new Map(); return { get: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), put: async (r) => { m.set(r.id, JSON.stringify(r)); }, m }; };
const autoCfg = (env = {}) => ({ recycle: recycleConfig({}, env), skew: skewConfig({}, env), notes: notesConfig({}, env), buyback: buybackConfig({}, env), target: targetConfig({}, env) });
test('a look: swaps that ended before it began are not counted; then each new one is, the lean follows what is held, and /info carries it all', async () => {
  const fwd = [{ id: 'old', phase: 'done', quoteId: 'q0', takes: [] }];
  const rev = [];
  const kv = kvMem();
  let eth = 2n * 10n ** 8n, sats = 30_000_000n;           // 2 ETH and 0.3 BTC (0.009 ETH at this rate): ETH heavy
  const a = makeAutomation({
    cfg: autoCfg(), kv, rate: () => RATE, fwd: store(fwd), rev: store(rev), fwdQuote: async (id) => (id === 'q1' ? { btcValue: '1000000', evmAmount: '29000', mkt: { num: String(RATE.num), den: String(RATE.den) } } : null),
    ethFree: async () => eth, btcSats: async () => sats, txFee: async () => 700, relayFee: async () => 0n, feeAtMin: { fwd: 87, rev: 95 }, now: () => 5000,
  });
  await a.tick();
  assert.equal(a.info().stats.swaps, 0, 'the old swap is not counted'); assert.equal(a.skew(), 15);
  fwd.push({ id: 'new', phase: 'done', quoteId: 'q1', takes: [T('t')], offer: { evm: { amount: '29000' } } });
  await a.tick();
  const i = a.info();
  assert.equal(i.stats.swaps, 1); assert.equal(i.stats.feesEarnedSats, String(1000000n - 966667n)); assert.equal(i.stats.networkCostSats, '700');
  assert.equal(i.target.reached, false); assert.equal(i.buyback.on, false); assert.equal(i.buyback.routedEth, '0'); assert.equal(i.skewBps, 15);
  assert.ok(i.stats.capacity && i.stats.capacity.eth === String(eth));
  eth = 1000n; sats = 10n ** 9n; await a.tick(); assert.equal(a.skew(), -15, 'BTC heavy: the rate falls');
  assert.ok(JSON.parse(kv.m.get('stats')).counted['f:new'], 'kept in the store');
});

test('a look past the target with buybacks on: the net is owed and sent to TacBuyback from what is over the target, in the pool\'s turn, once', async () => {
  const fwd = [], kv = kvMem(), sends = [], turns = [];
  const note = { value: String(30_000_000n), leaf: '0x' + 'ab'.repeat(32) };
  let notes = [note, { value: '5000', leaf: '0x' + 'cd'.repeat(32) }], t = 10_000;
  const big = 12n * 10n ** 8n;
  const a = makeAutomation({
    cfg: autoCfg({ FB_LP_BUYBACK: 'on' }), kv, rate: () => RATE, fwd: store(fwd), rev: store([]), revQuote: async () => null,
    fwdQuote: async () => ({ btcValue: '100000000', evmAmount: '1000000', mkt: { num: String(RATE.num), den: String(RATE.den) } }),
    ethFree: async () => big, btcSats: async () => 10n ** 12n, ethNotes: async () => notes, txFee: async () => 1000, relayFee: async () => 0n,
    quiet: async () => true, gate: async (fn) => { turns.push('in'); const r = await fn(); turns.push('out'); return r; },
    sendBuyback: async ({ note: n, amount, to }) => { sends.push({ leaf: n.leaf, amount, to }); notes = notes.filter((x) => x !== n); return { fee: 2000n, txHash: '0x' + '99'.repeat(32), block: 100 }; },
    now: () => t, feeAtMin: { fwd: 87, rev: 95 },
  });
  await a.tick();
  fwd.push({ id: 's', phase: 'done', quoteId: 'q', takes: [T('t')], offer: { evm: { amount: '2000000' } } });
  t += 4000; await a.tick();
  const i = a.info();
  assert.equal(i.target.reached, true);
  const owedBefore = BigInt(i.buyback.owedEth) + BigInt(i.buyback.routedEth) + BigInt(i.buyback.feesEth);
  assert.equal(sends.length, 1); assert.equal(sends[0].to, TAC_BUYBACK); assert.equal(sends[0].leaf, note.leaf, 'the smallest single note that covers it');
  assert.ok(sends[0].amount <= 25_000_000n);
  assert.equal(i.buyback.sends, 1); assert.equal(i.buyback.lastTx, '0x' + '99'.repeat(32)); assert.equal(BigInt(i.buyback.routedEth), sends[0].amount - 2000n);
  assert.ok(owedBefore > 0n); assert.deepEqual(turns.slice(-2), ['in', 'out']);
  t += 4000; await a.tick();
  assert.equal(BigInt(a.info().buyback.owedEth) + sends.reduce((s, x) => s + x.amount, 0n), owedBefore, 'what was owed is what was sent and what is still owed');
});

test('a look: a send cut short leaves its record; a note still there means it did not go, a note gone means it did (said)', async () => {
  const kv = kvMem(), alerts = [];
  const leaf = '0x' + 'ab'.repeat(32);
  await kv.put({ id: 'stats', ...emptyStats(1), seeded: true, owedEth: '50000000', buyback: { ...emptyStats(1).buyback, pending: { leaf, amount: '20000000', at: 0 } } });
  let notes = [{ value: '30000000', leaf }];
  const mk = () => makeAutomation({ cfg: autoCfg({ FB_LP_BUYBACK: 'on' }), kv, rate: () => RATE, fwd: store([]), fwdQuote: async () => null, ethFree: async () => 12n * 10n ** 8n, btcSats: async () => null,
    ethNotes: async () => notes, txFee: async () => null, now: () => 100_000, alert: (x) => alerts.push(x), sendBuyback: async () => { throw new Error('should not send in the same look'); } });
  await mk().tick();
  assert.equal(JSON.parse(kv.m.get('stats')).buyback.pending, null, 'still there: planned again');
  await kv.put({ ...JSON.parse(kv.m.get('stats')), buyback: { ...JSON.parse(kv.m.get('stats')).buyback, pending: { leaf, amount: '20000000', at: 0 } } });
  notes = [];
  await mk().tick();
  const s = JSON.parse(kv.m.get('stats'));
  assert.equal(s.buyback.sends, 1); assert.equal(s.owedEth, '30000000'); assert.ok(alerts.some((x) => /spent its note/.test(x.msg)));
});

test('the daemon\'s wiring: /info gains the totals, the target, the lean and the buybacks; other routes and a failed /info are as they were', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upkeep-'));
  try {
    const store0 = (recs = []) => ({ list: async () => recs, get: async () => null });
    const prims = { p2wpkhScript: (pub) => Uint8Array.from([0, 20, ...Array(20).fill(pub[1])]), wallet: { pub: Uint8Array.from([2, 0x11]) } };
    const rprims = { p2wpkhScript: (pub) => Uint8Array.from([0, 20, ...Array(20).fill(pub[1])]), wallet: { pub: Uint8Array.from([2, 0x22]) } };
    const w = await wireAutomation({
      C: { evmAsset: 'ab'.repeat(32), btcBases: [], quote: { minAmount: '120000', feeBps: 20, flatFee: '800' }, reverse: { enabled: true, minAmount: '4000000', feeBps: 20, flatFee: '30000' } },
      key: new Uint8Array(32), prims, btc: { fetchTx: async () => null }, tacit: {}, ux: { balance: async () => ({ byAsset: {} }) }, evm: { cutReserve: async () => 0n },
      service: { free: async () => 10n ** 8n, held: async () => 0n, reservations: new Map() }, swapStore: store0(), quoteStore: store0(),
      rside: { btc: { satsUtxos: async () => [{ value: 1000000 }] }, prims: rprims, swaps: store0(), quotes: store0() }, rateFeed: { rate: () => RATE }, poolTurn: (fn) => fn(),
      data: dir, keccak256: keccak_256, log: () => {}, alert: () => {}, setLean: () => {}, env: {},
    });
    assert.equal(w.cfg.recycle.enabled, true); assert.equal(w.cfg.buyback.enabled, false);
    await w.auto.tick();
    const h = w.wrap(async (req) => (req.path === '/info' ? { status: 200, body: { v: 1, minAmount: '1' } } : { status: 404, body: { error: 'not found' } }));
    const i = (await h({ method: 'GET', path: '/info' })).body;
    assert.equal(i.minAmount, '1'); assert.ok(i.stats && i.target && i.buyback); assert.equal(typeof i.skewBps, 'number');
    assert.equal(i.target.eth, String(10n ** 9n)); assert.equal(i.buyback.on, false); assert.equal(i.buyback.to, TAC_BUYBACK);
    assert.equal(i.stats.capacity.eth, String(10n ** 8n)); assert.equal(i.stats.capacity.sats, '1000000');
    assert.deepEqual((await h({ method: 'GET', path: '/swap/x' })).body, { error: 'not found' });
    const bad = w.wrap(async () => ({ status: 503, body: { error: 'down' } }));
    assert.deepEqual((await bad({ method: 'GET', path: '/info' })).body, { error: 'down' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── auto-shield and the low-balance alerts ──
const E = (s) => BigInt(Math.round(Number(s) * 1e8)) * 10n ** 10n;         // ETH -> wei
const memStore = () => { let rec = null; return { load: async () => rec, save: async (r) => { rec = JSON.parse(JSON.stringify(r)); }, get: () => rec }; };
function shieldUx(o = {}) {
  const c = { sent: [], settled: 0, history: 0, checks: 0 };
  const ux = {
    rpc: async (m) => {
      if (m === 'eth_getBalance') return '0x' + o.bal().toString(16);
      if (m === 'eth_call') { c.checks++; if (o.dup) throw new Error('execution reverted: 0xad2fa98e'); return '0x'; }
      if (m === 'eth_getTransactionCount') return '0x' + (o.nonce ?? 5).toString(16);
      if (m === 'eth_getTransactionReceipt') return o.receipt === undefined ? { status: '0x1' } : o.receipt;
      throw new Error('rpc ' + m);
    },
    buildRouterWrap: async ({ index }) => ({ to: '0xrouter', value: '1', calldata: '0x01', index, permitType: 'native' }),
    routerWrap: async ({ amountWei, index }) => { c.sent.push({ amountWei, index }); return { txHash: '0x' + 'aa'.repeat(32), index }; },
    nextWrapIndex: async () => { c.history++; return 7; },
    relay: { state: async () => ({ state: 'ok' }) },
    submitWrapSettle: async () => { if (o.settleFails) throw new Error('relay said no'); c.settled++; return { status: 'settled' }; },
  };
  return { ux, c };
}
const mkShield = (o = {}, env = { FB_LP_AUTO_SHIELD: 'on' }, store = memStore(), extra = {}) => {
  const { ux, c } = shieldUx(o), alerts = [], logs = [];
  const s = makeShield({ cfg: shieldConfig(env), ux, key: new Uint8Array(32), address: '0xaddr', load: store.load, save: store.save, log: (x) => logs.push(x), alert: (x) => alerts.push(x), waitTries: 1, waitMs: 0, ...extra });
  return { s, c, alerts, logs, store };
};

test('auto-shield is off unless FB_LP_AUTO_SHIELD=on; its settings are checked', async () => {
  assert.equal(shieldConfig({}).enabled, false);
  assert.equal(shieldConfig({ FB_LP_AUTO_SHIELD: 'on' }).reserveWei, E('0.02'));
  assert.equal(shieldConfig({ FB_LP_AUTO_SHIELD: 'on' }).minWei, E('0.02'));
  assert.equal(shieldConfig({}).everySecs, 600);
  assert.throws(() => shieldConfig({ FB_LP_AUTO_SHIELD: 'yes' }), /on or off/);
  assert.throws(() => shieldConfig({ FB_LP_SHIELD_RESERVE_ETH: '0.0001' }), /gas/);
  assert.throws(() => shieldConfig({ FB_LP_SHIELD_EVERY_SECS: '1' }), /30 to 86400/);
  const m = mkShield({ bal: () => E('5') }, {});
  assert.equal((await m.s.step()).did, 'off'); assert.equal(m.c.sent.length, 0); assert.equal(m.c.history, 0);
});

test('auto-shield waits for a quiet address', async () => {
  let q = false;
  const m = mkShield({ bal: () => E('1') }, undefined, undefined, { quiet: async () => q });
  assert.equal((await m.s.step()).did, 'quiet'); assert.equal(m.c.sent.length, 0);
  q = true;
  assert.equal((await m.s.step()).did, 'shielded'); assert.equal(m.c.sent.length, 1);
});

test('auto-shield never touches the gas reserve and sends nothing under the smallest chunk', async () => {
  let m = mkShield({ bal: () => E('0.5') });
  assert.equal((await m.s.step()).did, 'shielded');
  assert.equal(m.c.sent[0].amountWei, E('0.48'), 'the balance less the 0.02 reserve');
  m = mkShield({ bal: () => E('0.0399') });
  assert.equal((await m.s.step()).did, 'low'); assert.equal(m.c.sent.length, 0);
  m = mkShield({ bal: () => E('0.04') });
  assert.equal((await m.s.step()).did, 'shielded'); assert.equal(m.c.sent[0].amountWei, E('0.02'));
  m = mkShield({ bal: () => E('1') }, { FB_LP_AUTO_SHIELD: 'on', FB_LP_SHIELD_RESERVE_ETH: '0.5' });
  await m.s.step(); assert.equal(m.c.sent[0].amountWei, E('0.5'));
});

test('auto-shield keeps one deposit in flight and waits the gap before the next', async () => {
  let t = 1000;
  const m = mkShield({ bal: () => E('1'), receipt: null }, undefined, undefined, { now: () => t });
  assert.equal((await m.s.step()).did, 'pending');
  assert.equal((await m.s.step()).did, 'pending'); assert.equal(m.c.sent.length, 1, 'a second is not sent while one is not mined');
  assert.equal(m.store.get().pending.tx, '0x' + 'aa'.repeat(32));
  const slow = mkShield({ bal: () => E('1') });
  const both = await Promise.all([slow.s.step(), slow.s.step()]);
  assert.deepEqual(both.map((x) => x.did).sort(), ['busy', 'shielded']);
  assert.equal((await slow.s.step()).did, 'wait', 'the least gap between deposits');
});

test('auto-shield: a restart settles the pending deposit and does not send it again', async () => {
  const store = memStore();
  const a = mkShield({ bal: () => E('1'), receipt: null }, undefined, store);
  assert.equal((await a.s.step()).did, 'pending'); assert.equal(a.c.sent.length, 1);
  const b = mkShield({ bal: () => E('1') }, undefined, store);
  const r = await b.s.step();
  assert.equal(r.did, 'shielded'); assert.equal(b.c.sent.length, 0); assert.equal(b.c.settled, 1);
  assert.equal(store.get().pending, null); assert.equal(store.get().nextIndex, 8);
  // killed between the record and the send: not sent if the nonce did not move, stopped if it did
  const s1 = memStore(); await s1.save({ v: 1, nextIndex: 8, pending: { index: 8, amountWei: String(E('0.1')), nonce: 5, tx: null, phase: 'sent', at: 1 } });
  assert.equal((await mkShield({ bal: () => E('1'), nonce: 5 }, undefined, s1).s.step()).did, 'cleared');
  const s2 = memStore(); await s2.save({ v: 1, nextIndex: 8, pending: { index: 8, amountWei: String(E('0.1')), nonce: 5, tx: null, phase: 'sent', at: 1 } });
  const moved = mkShield({ bal: () => E('1'), nonce: 6 }, undefined, s2);
  assert.equal((await moved.s.step()).did, 'halted'); assert.equal(moved.c.sent.length, 0); assert.ok(moved.alerts[0].level === 'error');
});

test('auto-shield reads the pool history once and keeps the next index', async () => {
  const store = memStore();
  let t = 0;
  const a = mkShield({ bal: () => E('1') }, undefined, store, { now: () => t });
  await a.s.step(); assert.equal(a.c.history, 1); assert.equal(a.c.sent[0].index, 7); assert.equal(store.get().nextIndex, 8);
  t += 700; await a.s.step(); assert.equal(a.c.history, 1); assert.equal(a.c.sent[1].index, 8);
  const b = mkShield({ bal: () => E('1') }, undefined, store);
  await b.s.step(); assert.equal(b.c.history, 0, 'after a restart the kept index is used'); assert.equal(b.c.sent[0].index, 9);
});

test('auto-shield: a used index stops it before anything is sent, and says so', async () => {
  const m = mkShield({ bal: () => E('1'), dup: true });
  assert.equal((await m.s.step()).did, 'halted');
  assert.equal(m.c.sent.length, 0); assert.equal(m.alerts.length, 1); assert.equal(m.alerts[0].level, 'error'); assert.match(m.alerts[0].msg, /already used/);
  assert.equal(m.store.get().nextIndex, null, 'the index is read again at the next start');
  assert.equal((await m.s.step()).did, 'halted'); assert.equal(m.c.checks, 1);
});

test('auto-shield: a settle that fails stops it and is alerted; the deposit is not repeated, a restart settles it', async () => {
  const store = memStore();
  const a = mkShield({ bal: () => E('1'), settleFails: true }, undefined, store);
  assert.equal((await a.s.step()).did, 'halted'); assert.equal(a.c.sent.length, 1);
  assert.match(a.alerts[0].msg, /settle did not go through/); assert.equal(a.alerts[0].error, 'relay said no');
  assert.equal((await a.s.step()).did, 'halted'); assert.equal(a.c.sent.length, 1);
  const b = mkShield({ bal: () => E('1') }, undefined, store);
  assert.equal((await b.s.step()).did, 'shielded'); assert.equal(b.c.sent.length, 0);
  const r = mkShield({ bal: () => E('1'), receipt: { status: '0x0' } });
  assert.equal((await r.s.step()).did, 'halted'); assert.match(r.alerts[0].msg, /reverted/);
});

test('auto-shield: ETH that falls with nothing of the provider\'s under way is alerted and nothing is sent that time', async () => {
  let bal = E('0.039');
  const m = mkShield({ bal: () => bal });
  assert.equal((await m.s.step()).did, 'low');
  bal = E('0.02');
  assert.equal((await m.s.step()).did, 'dropped'); assert.equal(m.alerts.length, 1); assert.equal(m.c.sent.length, 0);
  assert.equal((await m.s.step()).did, 'low');
});

function mkWatch(o = {}) {
  const v = { free: E('1') / 10n ** 10n, sats: 500000n, pub: E('0.03'), t: 0, ...o }, alerts = [];
  const w = makeRefillWatch({
    cfg: watchConfig({}), shield: shieldConfig({}), autoShield: !!v.auto, freeEth: async () => v.free, sats: async () => v.sats, publicEth: async () => v.pub,
    poolAccount: '0xPOOL', btcAddresses: ['bc1qmain', 'bc1qrev'], now: () => v.t, alert: (x) => alerts.push(x),
  });
  return { w, v, alerts };
}

test('low-balance alerts: each says what to send where, once per few hours, and a recovery', async () => {
  assert.equal(watchConfig({}).lowEthUnits, 5_000_000n); assert.equal(watchConfig({}).lowSats, 100000n);
  assert.equal(watchConfig({ FB_LP_ALERT_LOW_ETH: '0.1', FB_LP_ALERT_LOW_SATS: '5' }).lowEthUnits, 10_000_000n);
  assert.throws(() => watchConfig({ FB_LP_ALERT_LOW_SATS: 'x' }), /sats/);
  const { w, v, alerts } = mkWatch();
  await w.check(); assert.equal(alerts.length, 0);
  v.free = 1_000_000n; await w.check();
  assert.equal(alerts.length, 1); assert.match(alerts[0].msg, /private ETH to lend is low.*Send ETH to 0xPOOL/);
  v.t = 3600; await w.check(); assert.equal(alerts.length, 1, 'deduped');
  v.t = 15000; await w.check(); assert.equal(alerts.length, 2, 'said again after four hours');
  v.free = E('1') / 10n ** 10n; await w.check();
  assert.equal(alerts.length, 3); assert.equal(alerts[2].level, 'info'); assert.match(alerts[2].msg, /back/);
  await w.check(); assert.equal(alerts.length, 3);
  v.sats = 99999n; await w.check();
  assert.match(alerts[3].msg, /Bitcoin is low.*Send BTC to bc1qmain or bc1qrev/);
  v.pub = E('0.01'); await w.check();
  assert.match(alerts[4].msg, /gas reserve.*Send ETH to 0xPOOL/);
  assert.deepEqual(w.info().alerting, ['gas', 'sats']);
});

test('low-balance alerts: ETH waiting unshielded over 30 minutes is alerted only while auto-shield is off', async () => {
  const off = mkWatch({ pub: E('0.3') });
  await off.w.check(); off.v.t = 1700; await off.w.check(); assert.equal(off.alerts.length, 0, 'not yet 30 minutes');
  off.v.t = 1801; await off.w.check();
  assert.equal(off.alerts.length, 1); assert.match(off.alerts[0].msg, /unshielded.*FB_LP_AUTO_SHIELD=on/);
  off.v.pub = E('0.01'); await off.w.check(); assert.ok(off.alerts.some((x) => x.level === 'info'));
  const on = mkWatch({ pub: E('0.3'), auto: true });
  await on.w.check(); on.v.t = 5000; await on.w.check(); assert.equal(on.alerts.length, 0);
  const small = mkWatch({ pub: E('0.03') });
  await small.w.check(); small.v.t = 5000; await small.w.check(); assert.equal(small.alerts.length, 0, 'under the reserve and the smallest chunk');
});

test('low-balance alerts: /info shows the same facts, and no secret', async () => {
  const { w } = mkWatch({ free: 1_000_000n, sats: 7n, pub: E('0.3') });
  await w.check();
  const i = w.info();
  assert.deepEqual({ ...i, alerting: undefined }, { poolAccount: '0xPOOL', btcAddresses: ['bc1qmain', 'bc1qrev'], freeEth: '0.0100', lowEth: '0.0500', sats: '7', lowSats: '100000', publicEth: '0.3000', gasReserveEth: '0.0200', minChunkEth: '0.0200', alerting: undefined, autoShield: { on: false } });
  assert.deepEqual(i.alerting, ['freeEth', 'sats']);
});

test('the daemon\'s wiring: /info carries refill, and auto-shield is off with no switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upkeep-'));
  try {
    const store0 = (recs = []) => ({ list: async () => recs, get: async () => null });
    const prims = { p2wpkhScript: (pub) => Uint8Array.from([0, 20, ...Array(20).fill(pub[1])]), wallet: { pub: Uint8Array.from([2, 0x11]) } };
    const w = await wireAutomation({
      C: { evmAsset: 'ab'.repeat(32), btcBases: [], quote: { minAmount: '120000', feeBps: 20, flatFee: '800' } },
      key: new Uint8Array(32), prims, btc: { fetchTx: async () => null, address: 'bc1qmain', satsUtxos: async () => [{ value: 40000 }] }, tacit: {},
      ux: { balance: async () => ({ byAsset: {} }), account: () => ({ address: '0xPOOL' }), rpc: async () => '0x' + E('0.3').toString(16) }, evm: { cutReserve: async () => 0n },
      service: { free: async () => 10n ** 8n, held: async () => 0n, reservations: new Map() }, swapStore: store0(), quoteStore: store0(),
      rside: null, rateFeed: { rate: () => RATE }, poolTurn: (fn) => fn(), data: dir, keccak256: keccak_256, log: () => {}, alert: () => {}, setLean: () => {}, env: {},
    });
    await w.auto.tick();
    const h = w.wrap(async () => ({ status: 200, body: { v: 1 } }));
    const first = (await h({ method: 'GET', path: '/info' })).body;
    assert.equal(first.refill.autoShield.on, false); assert.equal(first.refill.poolAccount, '0xPOOL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('env: the existing settings are untouched by the new switches', () => {
  const out = applyEnv({ quote: { minAmount: '1' } }, { FB_LP_RECYCLE: 'off', FB_LP_BUYBACK: 'on' });
  assert.equal(out.quote.minAmount, '1');
  assert.equal(RECYCLE_DEFAULTS.minCoin, 10_000);
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} upkeep checks passed`);
process.exit(process.exitCode || 0);
