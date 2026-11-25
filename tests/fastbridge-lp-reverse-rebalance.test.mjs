// Offline checks for the opt-in reverse rebalancer. Fake chain, wallet, reverse inventory, clock and alerts; the production funder's planner and executor are used.
// node tests/fastbridge-lp-reverse-rebalance.test.mjs (Node 22)

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TAC, executeFund as executeFundReal, planFund as planFundReal } from '../tools/fastbridge-lp-reverse-fund.mjs';
import { makeFileStore, makeMemoryStore, makeStrictFileStore } from '../fastbridge-lp/lib/store.mjs';
import {
  ONE_TAC, acquireProcessLock, admissionDecision, buildStatusRecord, chainDecision, formatTac,
  journalId, journalPosition, lineageDecision, makeReverseRebalancer, makeThrottledAlert,
  outpointId, parseBaseAmount, parseLeaseManifest, parseRebalanceConfig, parseTacAmount,
  exactReverseSale, planRebalance, reconcileDone, reconcileMoved, recoverAmbiguousBroadcasts, reverseOutputBounds, reverseSwapPosition,
  selectFeeCoin, selectWholeNote, utcDay, wholeNotePlan,
} from '../fastbridge-lp/lib/reverse-rebalance.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const id = (c) => c.repeat(64);
const N1 = { txid: id('a'), vout: 0 }, N2 = { txid: id('b'), vout: 1 }, N3 = { txid: id('c'), vout: 0 };
const N4 = { txid: id('d'), vout: 0 }, N5 = { txid: id('e'), vout: 0 }, N6 = { txid: id('f'), vout: 0 };
const C1 = { txid: id('1'), vout: 2 }, C2 = { txid: id('2'), vout: 0 };
const MAIN = 'bc1qmain', REVERSE = 'bc1qreverse', OTHER = 'bc1qother', DESTINATION = '02' + 'ab'.repeat(32);
const units = (n) => BigInt(n) * ONE_TAC;
const str = (n) => units(n).toString();
const NOW = 1_800_000_000;
const note = (o, amount, extra = {}) => ({ ...o, amount: String(amount), lineage: { state: 'long' }, ...extra });
const coin = (o, extra = {}) => ({ ...o, ...extra });

function rawConfig(rebalance = {}, reverse = {}) {
  return {
    btcAsset: TAC, policy: {},
    reverse: {
      enabled: true, minAmount: String(ONE_TAC), maxAmount: String(1000n * ONE_TAC), feeBps: 0, flatFee: '0',
      ...reverse,
      rebalance: {
        enabled: true, leases: 'leases.json', maxNoteTac: '100', maxDailyTac: '200', maxInventoryTac: '300', maxStuckTac: '400',
        maxFeeRate: 10, minSourceConfs: 2, tickSecs: 3, stallSecs: 100, ...rebalance,
      },
    },
  };
}
const config = (rebalance = {}, reverse = {}) => parseRebalanceConfig(rawConfig(rebalance, reverse));

function txFor(o, { value = 546, address = MAIN, confirmed = true, height = 99 } = {}) {
  const vout = Array.from({ length: o.vout + 1 }, (_, i) => ({ value: i === o.vout ? value : 1, scriptpubkey_address: i === o.vout ? address : OTHER }));
  return { vout, status: { confirmed, ...(confirmed ? { block_height: height, block_hash: 'h', block_time: NOW - 600 } : {}) } };
}

function world({ notes = [note(N1, str(5))], feeCoins = [coin(C1)], extraNotes = [], reverseNotes = [], rate = 3 } = {}) {
  const w = {
    now: NOW, tip: 100, rate, txs: {}, spent: {}, walletNotes: [...notes, ...extraNotes], reverseNotes: reverseNotes.map((n) => ({ ...n, amount: BigInt(n.amount) })),
    sent: [], builderCalls: [], scans: 0, lineageCalls: [], alerts: [], revealConfirmed: true, reverseVisible: true, broadcastError: null,
  };
  w.leases = { version: 1, notes: notes.map((n) => ({ txid: n.txid, vout: n.vout, amount: n.amount })), feeCoins: feeCoins.map((c) => ({ txid: c.txid, vout: c.vout })) };
  for (const n of [...notes, ...extraNotes]) w.txs[n.txid] = txFor(n, n);
  for (const c of feeCoins) w.txs[c.txid] = txFor(c, { value: c.value ?? 5000, address: c.address ?? MAIN, confirmed: c.confirmed ?? true, height: c.height ?? 99 });
  for (const n of notes) if (n.spent) w.spent[outpointId(n)] = { spent: true, txid: id('9') };
  w.getJson = async (path) => {
    if (path === '/blocks/tip/height') return w.tip;
    let m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(path);
    if (m) return w.spent[`${m[1]}:${Number(m[2])}`] ?? { spent: false };
    m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
    if (m) return w.txs[m[1]] || null;
    throw new Error('unexpected explorer read ' + path);
  };
  const entry = (n) => ({
    utxo: { txid: n.txid, vout: n.vout, value: n.value ?? 546, status: w.txs[n.txid]?.status || { confirmed: true, block_height: 99 } },
    amount: BigInt(n.actual ?? n.amount), blinding: 7n, ...(n.stealth ? { stealthTweakedSk: 9n } : {}),
  });
  w.tacit = {
    wallet: { pub: Uint8Array.from([2, 1]) },
    invalidateHoldingsCache: () => {},
    scanHoldings: async () => { w.scans++; return new Map([[TAC, { utxos: w.walletNotes.map(entry) }]]); },
    getFeeRate: async (tier, opts) => { w.feeArgs = [tier, opts]; if (w.rate instanceof Error) throw w.rate; return w.rate; },
    bridgeUx: () => ({
      lineage: async (ns) => {
        w.lineageCalls.push(ns.map(outpointId));
        return new Map(ns.map((n) => [outpointId(n), n.lineage || w.walletNotes.find((x) => outpointId(x) === outpointId(n))?.lineage || { state: 'unread' }]));
      },
    }),
    buildAndBroadcastCXferMulti: async (args) => {
      w.builderCalls.push(args);
      if (args.feeRate != null && (!Number.isFinite(args.feeRate) || args.feeRate <= 0 || args.feeRate > args.maxFeeRate)) throw new Error('builder fee cap refused');
      w.sent.push(args);
      if (w.broadcastError) throw w.broadcastError;
      const txid = w.broadcastTxid || id('7');
      for (const input of args.forceUtxos) w.spent[outpointId(input.utxo)] = { spent: true, txid };
      w.txs[txid] = txFor({ txid, vout: 0 }, { value: 546, address: REVERSE, confirmed: w.revealConfirmed, height: w.revealHeight ?? Math.max(1, w.tip - 1) });
      if (w.reverseVisible && w.revealConfirmed) w.reverseNotes.push({ txid, vout: 0, amount: BigInt(args.recipients[0].amount) });
      return { revealTxid: txid };
    },
  };
  w.reverseInventory = { notes: async () => w.reverseNotes.map((n) => ({ ...n })) };
  w.confirmReveal = (txid = w.broadcastTxid || id('7'), height = Math.max(1, w.tip - 1)) => {
    w.revealConfirmed = true;
    w.txs[txid] = txFor({ txid, vout: 0 }, { value: 546, address: REVERSE, confirmed: true, height });
    if (!w.reverseNotes.some((n) => n.txid === txid)) w.reverseNotes.push({ txid, vout: 0, amount: BigInt(w.sent[0].recipients[0].amount) });
  };
  return w;
}

function sidecar(w, { store = makeMemoryStore(), reverseSwaps = makeMemoryStore(), cfg = config(), dryRun = false, hooks = {}, alert = null, fund = {} } = {}) {
  const runner = makeReverseRebalancer({
    config: cfg, leases: w.leases, store, reverseSwaps, tacit: w.tacit, getJson: w.getJson, reverseInventory: w.reverseInventory,
    mainAddress: MAIN, reverseAddress: REVERSE, destination: DESTINATION, dryRun, now: () => w.now,
    alert: alert || ((a) => w.alerts.push(a)), ownPubHex: () => 'main-pub', expectedPubHex: 'main-pub', hooks, fund,
    realFetch: async () => new Response('{}', { status: 200 }),
  });
  return { runner, store };
}

const moveRecord = (o, amount, state = 'done', extra = {}) => ({
  id: journalId(o), kind: 'move', state, note: { ...o, amount: String(amount) }, amount: String(amount),
  coin: { ...C2 }, sourceAddress: MAIN, houseAddress: MAIN, reverseAddress: REVERSE, destination: DESTINATION,
  selectedAt: NOW, ...extra,
});

const saleRecord = (inputs, amount, phase = 'offered', extra = {}) => ({
  id: `s-${inputs[0].txid.slice(0, 12)}`, phase, amount: String(amount), noteInputs: inputs.map((o) => ({ txid: o.txid, vout: o.vout })),
  created: NOW, updated: NOW, ...extra,
});

const tmp = () => mkdtempSync(join(tmpdir(), 'tacit-reverse-rebalance-'));

test('safe config defaults and finite required caps: disabled without opt-in, strict when enabled', () => {
  assert.equal(parseRebalanceConfig({ reverse: {}, policy: {} }).enabled, false);
  assert.equal(parseRebalanceConfig(rawConfig({ enabled: false })).enabled, false);
  assert.equal(parseRebalanceConfig(rawConfig({ enabled: 'true' })).enabled, false);
  const c = config();
  assert.deepEqual([c.maxNoteTac, c.maxDailyTac, c.maxInventoryTac, c.maxStuckTac], [units(100), units(200), units(300), units(400)]);
  assert.deepEqual([c.maxFeeRate, c.minSourceConfs, c.tickSecs, c.stallSecs], [10, 2, 3, 100]);
  assert.equal(c.minProceedsBps, 10000);
  for (const field of ['maxNoteTac', 'maxDailyTac', 'maxInventoryTac', 'maxStuckTac', 'maxFeeRate']) {
    const raw = rawConfig(); delete raw.reverse.rebalance[field];
    assert.throws(() => parseRebalanceConfig(raw), new RegExp(field), field);
  }
  for (const bad of [0, -1, Infinity, NaN, 'x']) assert.throws(() => config({ maxFeeRate: bad }), /maxFeeRate/);
  assert.throws(() => config({ maxDailyTac: '1.000000001' }), /maxDailyTac/);
  assert.throws(() => config({ maxStuckTac: '1.000000001' }), /maxStuckTac/);
  assert.throws(() => config({ maxStuckTac: '0' }), /maxStuckTac/);
  const dryWithoutStuckCeiling = rawConfig(); delete dryWithoutStuckCeiling.reverse.rebalance.maxStuckTac;
  assert.equal(parseRebalanceConfig(dryWithoutStuckCeiling, { dryRun: true }).maxStuckTac, null);
  assert.throws(() => parseRebalanceConfig(dryWithoutStuckCeiling), /maxStuckTac.*enabled live rebalance/);
  const disabledWithoutCeiling = rawConfig({ enabled: false }); delete disabledWithoutCeiling.reverse.rebalance.maxStuckTac;
  const disabled = parseRebalanceConfig(disabledWithoutCeiling);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.maxStuckTac, null);
  assert.throws(() => parseRebalanceConfig(rawConfig({ enabled: false, maxStuckTac: 'not-a-tac-amount' })), /maxStuckTac/);
  assert.throws(() => config({ minSourceConfs: 0 }), /minSourceConfs/);
  assert.throws(() => parseRebalanceConfig(rawConfig({}, { enabled: false })), /requires reverse.enabled=true for a live run/);
  const dryWithReverseOff = parseRebalanceConfig(rawConfig({}, { enabled: false }), { dryRun: true });
  assert.equal(dryWithReverseOff.enabled, true);
  assert.equal(dryWithReverseOff.terms.minAmount, String(ONE_TAC));
  const wrongAsset = rawConfig(); wrongAsset.btcAsset = '00'.repeat(32);
  assert.throws(() => parseRebalanceConfig(wrongAsset), /requires the TAC btcAsset/);
  assert.equal(parseTacAmount('0.00000001'), 1n);
  assert.equal(formatTac(parseTacAmount('2.50000000')), '2.5');
  assert.throws(() => parseTacAmount('0'), /greater than zero/);
  assert.throws(() => parseTacAmount('1e2'), /decimal TAC/);
  assert.equal(parseBaseAmount('1'), 1n);
  for (const bad of [1, '01', '0', '-1', '1.0', ' 1']) assert.throws(() => parseBaseAmount(bad), /base-unit decimal string/);
});

test('lease manifest version 1 is strict, amounts stay base-unit strings, and all outpoint collisions are refused', () => {
  const parsed = parseLeaseManifest({ version: 1, notes: [{ ...N1, amount: '123' }], feeCoins: [C1] });
  assert.deepEqual(parsed.notes[0], { ...N1, amount: '123' });
  assert.deepEqual(parsed.feeCoins, [C1]);
  const example = JSON.parse(readFileSync(new URL('../fastbridge-lp/rebalance-leases.example.json', import.meta.url), 'utf8'));
  assert.equal(parseLeaseManifest(example).version, 1);
  for (const bad of [
    { version: 2, notes: [], feeCoins: [] },
    { version: 1, notes: [{ ...N1, amount: 1 }], feeCoins: [] },
    { version: 1, notes: [{ ...N1, amount: '1' }, { ...N1, amount: '2' }], feeCoins: [] },
    { version: 1, notes: [{ ...N1, amount: '1' }], feeCoins: [N1] },
    { version: 1, notes: [{ ...N1, amount: '1', change: '0' }], feeCoins: [] },
  ]) assert.throws(() => parseLeaseManifest(bad));
});

test('the exact direct-lineage table: only long and unprovable through shielded are eligible; unread requires an alert', () => {
  assert.deepEqual(lineageDecision({ state: 'long', hops: 300 }).ok, true);
  assert.deepEqual(lineageDecision({ state: 'unprovable', through: 'shielded' }).ok, true);
  for (const verdict of [{ state: 'tracked' }, { state: 'traced', hops: 3 }, { state: 'unprovable', through: 'farm' }, { state: 'unprovable' }, { state: 'other' }]) {
    assert.equal(lineageDecision(verdict).ok, false, JSON.stringify(verdict));
    assert.equal(lineageDecision(verdict).alert, false);
  }
  for (const verdict of [{ state: 'unread' }, null, undefined]) {
    assert.equal(lineageDecision(verdict).reason, 'lineage_unread');
    assert.equal(lineageDecision(verdict).alert, true);
  }
  const source = readFileSync(new URL('../fastbridge-lp/lib/reverse-rebalance.mjs', import.meta.url), 'utf8');
  assert.match(source, /tacit\.bridgeUx\(\)\.lineage\(notes\)/);
  assert.doesNotMatch(source, /lineageScreen/);
});

test('chain admission covers wrong address, amount carrier, unconfirmed, spent, unread, and exact confirmation boundaries', () => {
  const base = { tx: txFor(N1), outspend: { spent: false }, vout: 0, address: MAIN, tipHeight: 100, minConfs: 2 };
  assert.equal(chainDecision(base).ok, true);
  assert.equal(chainDecision({ ...base, minConfs: 3 }).reason, 'insufficient_confirmations');
  assert.equal(chainDecision({ ...base, tx: txFor(N1, { address: OTHER }) }).reason, 'wrong_source_address');
  assert.equal(chainDecision({ ...base, tx: txFor(N1, { confirmed: false }) }).reason, 'unconfirmed');
  assert.equal(chainDecision({ ...base, outspend: { spent: true } }).reason, 'spent');
  assert.equal(chainDecision({ ...base, outspend: null }).reason, 'spent_state_unread');
  assert.equal(chainDecision({ ...base, tx: null }).reason, 'transaction_unread');
  assert.equal(chainDecision({ ...base, vout: 9 }).reason, 'output_missing');
  assert.equal(chainDecision({ ...base, tx: txFor(N1, { value: 5000 }) }).reason, 'not_a_note_sized_output');
  assert.equal(chainDecision({ ...base, tx: txFor(C1, { value: 2999 }), vout: 2, kind: 'coin' }).reason, 'fee_coin_out_of_range');
});

test('reverse terms are an output floor and ceiling after the provider fee, not a promise of buyer demand', () => {
  const terms = { minAmount: '1000', maxAmount: '10000', feeBps: 100, flatFee: '10' };
  const bounds = reverseOutputBounds(terms);
  assert.deepEqual([bounds.min, bounds.max], [980n, 9890n]);
  const c = config({ maxNoteTac: '1', maxDailyTac: '10', maxInventoryTac: '10' });
  const position = journalPosition([], [], NOW);
  assert.ok(admissionDecision({ amount: 979n, config: c, position, feeRate: 1, terms }).reasons.includes('reverse_amount_below_min'));
  assert.ok(admissionDecision({ amount: 9891n, config: c, position, feeRate: 1, terms }).reasons.includes('reverse_amount_above_max'));
  assert.equal(admissionDecision({ amount: 980n, config: c, position, feeRate: 1, terms }).ok, true);
  assert.equal(reverseOutputBounds(null), null);
});

test('pure selector chooses the smallest eligible whole note and centralises every cap and fee decision', () => {
  const candidates = [note(N1, str(8)), note(N2, str(4)), note(N3, str(6))];
  const c = config({ maxNoteTac: '10', maxDailyTac: '10', maxInventoryTac: '20' });
  const selected = selectWholeNote({ candidates, config: c, feeRate: 10, nowSecs: NOW });
  assert.equal(outpointId(selected.note), outpointId(N2));
  assert.equal(planRebalance({ candidates, config: c, feeRate: 10, nowSecs: NOW }).note.amount, str(4));
  assert.equal(selected.position.totalStockTac, 0n);
  assert.ok(selectWholeNote({ candidates, config: config({ maxNoteTac: '3' }), feeRate: 1, nowSecs: NOW }).decisions.every((d) => d.reasons.includes('per_note_cap')));
  assert.ok(selectWholeNote({ candidates, config: c, feeRate: 10.01, nowSecs: NOW }).decisions.every((d) => d.reasons.includes('fee_rate_above_cap')));
  assert.ok(selectWholeNote({ candidates, config: c, feeRate: null, nowSecs: NOW }).decisions.every((d) => d.reasons.includes('fee_rate_unavailable')));
});

test('UTC daily accounting includes selected, moved, done, and ambiguous halted journals across restart', () => {
  const records = [
    moveRecord(N1, str(2), 'selected'), moveRecord(N2, str(3), 'moved'),
    moveRecord(N3, str(4), 'done', { completedAt: NOW }), moveRecord(N4, str(5), 'halted', { broadcastAttempted: true }),
    moveRecord(N5, str(50), 'done', { selectedAt: NOW - 86400 }),
  ];
  const p = journalPosition(records, [], NOW);
  assert.equal(p.dailyTac, units(14));
  assert.equal(p.pendingTac, units(10));
  assert.equal(p.lastCompletedAt, NOW);
  assert.notEqual(utcDay(NOW), utcDay(NOW - 86400));
  const c = config({ maxDailyTac: '15', maxInventoryTac: '100' });
  assert.equal(admissionDecision({ amount: units(1), config: c, position: p, feeRate: 1 }).ok, true);
  assert.ok(admissionDecision({ amount: units(2), config: c, position: p, feeRate: 1 }).reasons.includes('daily_cap'));
});

test('inventory accounting includes current reverse stock and unobserved pending, without counting a visible move twice', () => {
  const rec = moveRecord(N1, str(5), 'moved', { broadcastTxid: id('e') });
  const other = moveRecord(N2, str(7), 'selected');
  const current = [{ txid: id('e'), vout: 0, amount: units(5) }, { txid: id('8'), vout: 0, amount: units(20) }];
  const p = journalPosition([rec, other], current, NOW);
  assert.equal(p.reverseStockTac, units(25));
  assert.equal(p.pendingTac, units(7));
  assert.equal(p.totalStockTac, units(32));
  const c = config({ maxInventoryTac: '40', maxDailyTac: '100' });
  assert.equal(admissionDecision({ amount: units(8), config: c, position: p, feeRate: 1 }).ok, true);
  assert.ok(admissionDecision({ amount: units(9), config: c, position: p, feeRate: 1 }).reasons.includes('inventory_cap'));
});

test('fee-coin selection refuses source collisions and coins reserved by any pending or ambiguous move', () => {
  const p = journalPosition([moveRecord(N3, str(1), 'selected', { coin: C1 })], [], NOW);
  assert.equal(selectFeeCoin({ coins: [{ ...C1, chain: { ok: true, value: 3000 } }], candidate: N2, position: p }), null);
  const chosen = selectFeeCoin({ coins: [{ ...C2, chain: { ok: true, value: 4000 } }, { ...C1, chain: { ok: true, value: 3000 } }], candidate: N2, position: journalPosition([], [], NOW) });
  assert.equal(outpointId(chosen), outpointId(C1));
  assert.equal(selectFeeCoin({ coins: [N2], candidate: N2, position: journalPosition([], [], NOW) }), null);
});

test('whole-plan validation requires plain mode, exact amount, zero change, and the persisted source/destination/coin', () => {
  const plan = { mode: 'plain', amount: '5', change: '0', note: { ...N1, amount: '5' }, coin: C1, destination: DESTINATION, houseAddress: MAIN };
  assert.equal(wholeNotePlan(plan, { note: N1, amount: '5', coin: C1, destination: DESTINATION, houseAddress: MAIN }).ok, true);
  for (const bad of [
    { ...plan, mode: 'silent' }, { ...plan, amount: '4' }, { ...plan, change: '1' },
    { ...plan, destination: 'other' }, { ...plan, coin: C2 }, { ...plan, note: { ...N2, amount: '5' } },
  ]) assert.equal(wholeNotePlan(bad, { note: N1, amount: '5', coin: C1, destination: DESTINATION, houseAddress: MAIN }).ok, false);
});

test('a live integration move uses the real funder planner and executor for exactly one leased whole note', async () => {
  const w = world({ notes: [note(N1, str(10)), note(N2, str(5))] });
  const { runner, store } = sidecar(w);
  const result = await runner.step();
  assert.equal(result.sent, true);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0].recipients, [{ pubHex: DESTINATION, amount: units(5) }]);
  assert.deepEqual(w.sent[0].forceUtxos.map((n) => outpointId(n.utxo)), [outpointId(N2)]);
  const rec = (await store.get(journalId(N2)));
  assert.equal(rec.state, 'moved');
  assert.deepEqual([rec.amount, rec.change, rec.mode, rec.destination], [str(5), '0', 'plain', DESTINATION]);
  assert.equal(outpointId(rec.coin), outpointId(C1));
  assert.ok(rec.selectedAt <= rec.broadcastingAt);
  assert.equal(result.plan.buyerDemandGuaranteed, false);
});

test('unleased notes are never candidates even when smaller and present in wallet holdings', async () => {
  const w = world({ notes: [note(N1, str(10))], extraNotes: [note(N2, str(1))] });
  const { runner } = sidecar(w);
  await runner.step();
  assert.equal(w.sent.length, 1);
  assert.equal(outpointId(w.sent[0].forceUtxos[0].utxo), outpointId(N1));
});

test('integration lineage table skips tracked, traced, other unprovable and unread, alerts on unread, then picks smallest eligible', async () => {
  const w = world({ notes: [
    note(N1, str(1), { lineage: { state: 'tracked' } }), note(N2, str(2), { lineage: { state: 'traced' } }),
    note(N3, str(3), { lineage: { state: 'unprovable', through: 'farm' } }), note(N4, str(4), { lineage: { state: 'unread' } }),
    note(N5, str(7), { lineage: { state: 'unprovable', through: 'shielded' } }), note(N6, str(8), { lineage: { state: 'long' } }),
  ] });
  const { runner } = sidecar(w);
  await runner.step();
  assert.equal(outpointId(w.sent[0].forceUtxos[0].utxo), outpointId(N5));
  assert.ok(w.lineageCalls.length >= 2, 'direct lineage is checked initially and immediately before planning');
  assert.ok(w.alerts.some((a) => a.outpoint === outpointId(N4) && /lineage/.test(a.msg)));
});

test('unconfirmed, insufficient-confirmed, spent, wrong-address and non-note outputs are all excluded without a send', async () => {
  const w = world({ notes: [
    note(N1, str(1), { confirmed: false }), note(N2, str(2), { height: 100 }), note(N3, str(3), { spent: true }),
    note(N4, str(4), { address: OTHER }), note(N5, str(5), { value: 5000 }), note(N6, str(6), { stealth: true }),
  ] });
  const { runner, store } = sidecar(w);
  const result = await runner.step();
  assert.equal(w.sent.length, 0);
  assert.equal(result.plan, null);
  assert.equal((await store.list()).filter((r) => r.kind === 'move').length, 0);
  assert.equal(result.status.stall.eligibleStockBaseUnits, str(6), 'the stealth wallet note passes chain/lineage but is refused at wallet amount verification');
});

test('a wrong leased amount is not partially moved: the mismatch is skipped and the next exact whole note is used', async () => {
  const w = world({ notes: [note(N1, str(5), { actual: str(6) }), note(N2, str(10))] });
  const { runner, store } = sidecar(w);
  await runner.step();
  assert.equal(w.sent.length, 1);
  assert.equal(outpointId(w.sent[0].forceUtxos[0].utxo), outpointId(N2));
  assert.equal(await store.get(journalId(N1)), null);
  assert.ok(w.alerts.some((a) => /amount does not match/.test(a.msg)));
});

test('fee ceiling is checked with a fresh wallet fee read: above and unavailable send nothing, equality is allowed', async () => {
  const high = world({ rate: 10.01 });
  assert.equal((await sidecar(high).runner.step()).plan, null);
  assert.equal(high.sent.length, 0);
  const unavailable = world({ rate: new Error('fee API down') });
  assert.equal((await sidecar(unavailable).runner.step()).plan, null);
  assert.equal(unavailable.sent.length, 0);
  const exact = world({ rate: 10 });
  await sidecar(exact).runner.step();
  assert.equal(exact.sent.length, 1);
  assert.deepEqual(exact.feeArgs, [null, { fresh: true, requireSource: true }]);
  assert.equal(exact.sent[0].feeRate, 10);
  assert.equal(exact.sent[0].maxFeeRate, 10);
});

test('dry-run reports an exact plan but sends nothing and writes no status, alert, selected or move journal', async () => {
  const dir = tmp();
  try {
    const w = world();
    const store = makeFileStore(join(dir, 'production-journal'));
    const { runner } = sidecar(w, { store, dryRun: true });
    const result = await runner.step();
    assert.equal(result.plan.wholeNote, true);
    assert.equal(result.plan.amount, str(5));
    assert.equal(result.status.dryRun, true);
    assert.equal(result.status.intakeAllowed, false);
    assert.equal(w.sent.length, 0);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(readdirSync(join(dir, 'production-journal')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('daily cap persists through a file journal restart and opens again on the next UTC day', async () => {
  const dir = tmp();
  try {
    const w = world({ notes: [note(N1, str(3))] });
    const store = makeFileStore(join(dir, 'journal'));
    const earlier = { txid: id('9'), vout: 0 };
    await store.put(moveRecord(earlier, str(8), 'done', { completedAt: NOW }));
    const cfg = config({ maxDailyTac: '10', maxInventoryTac: '100' });
    assert.equal((await sidecar(w, { store, cfg }).runner.step()).plan, null);
    assert.equal((await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg }).runner.step()).plan, null, 'restart reads the same committed daily total');
    assert.equal(w.sent.length, 0);
    w.now += 86400;
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg }).runner.step();
    assert.equal(w.sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-note and fee ceilings also refuse identically after a file-store restart', async () => {
  const dir = tmp();
  try {
    const w = world({ notes: [note(N1, str(5))], rate: 3 });
    const noteCfg = config({ maxNoteTac: '4' });
    assert.equal((await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg: noteCfg }).runner.step()).plan, null);
    assert.equal((await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg: noteCfg }).runner.step()).plan, null);
    assert.equal(w.sent.length, 0);
    const fees = world({ notes: [note(N1, str(5))], rate: 11 });
    const feeCfg = config({ maxFeeRate: 10 });
    assert.equal((await sidecar(fees, { store: makeFileStore(join(dir, 'journal')), cfg: feeCfg }).runner.step()).plan, null);
    assert.equal((await sidecar(fees, { store: makeFileStore(join(dir, 'journal')), cfg: feeCfg }).runner.step()).plan, null);
    assert.equal(fees.sent.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an ambiguous halted pending amount counts against daily and inventory caps after restart and is never retried', async () => {
  const dir = tmp();
  try {
    const other = { txid: id('9'), vout: 0 };
    const w = world({ notes: [note(N1, str(3))] });
    const store = makeFileStore(join(dir, 'journal'));
    await store.put(moveRecord(other, str(8), 'halted', { broadcastAttempted: true, coin: C2 }));
    const cfg = config({ maxDailyTac: '10', maxInventoryTac: '10' });
    const first = await sidecar(w, { store, cfg }).runner.step();
    assert.equal(first.plan, null);
    assert.equal(first.status.intakeReason, 'manual_broadcast_reconciliation_required');
    const second = await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg }).runner.step();
    assert.equal(second.plan, null);
    assert.equal(w.sent.length, 0);
    assert.equal((await store.get(journalId(other))).state, 'halted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('total reverse stock including pending caps admission identically after a restart', async () => {
  const dir = tmp();
  try {
    const w = world({ notes: [note(N1, str(10))], reverseNotes: [{ txid: id('8'), vout: 0, amount: str(95) }] });
    const cfg = config({ maxInventoryTac: '100', maxDailyTac: '100' });
    const store = makeFileStore(join(dir, 'journal'));
    assert.equal((await sidecar(w, { store, cfg }).runner.step()).plan, null);
    const again = await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg }).runner.step();
    assert.equal(again.plan, null);
    assert.ok(again.status.stall.aboveConfiguredStuckCeiling === false);
    assert.equal(w.sent.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crash after selected but before broadcasting is safe to resume once; no duplicate selected journal is made', async () => {
  const dir = tmp();
  try {
    const w = world();
    const store = makeFileStore(join(dir, 'journal'));
    await assert.rejects(() => sidecar(w, { store, hooks: { afterSelected: async () => { throw new Error('process crash before broadcast'); } } }).runner.step(), /process crash/);
    assert.equal((await store.get(journalId(N1))).state, 'selected');
    assert.equal(w.sent.length, 0);
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    assert.equal(w.sent.length, 1);
    assert.equal((await store.get(journalId(N1))).state, 'moved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a selected journal with a changed destination or non-whole fields is never resumed', async () => {
  const dir = tmp();
  try {
    const w = world();
    const store = makeFileStore(join(dir, 'journal'));
    const bad = moveRecord(N1, str(5), 'selected', { coin: C1, destination: '02' + 'cd'.repeat(32) });
    await store.put(bad);
    await assert.rejects(() => sidecar(w, { store }).runner.step(), /persisted selected plan/);
    assert.equal(w.sent.length, 0);
    assert.equal((await store.get(journalId(N1))).state, 'selected');
    await store.put({ ...bad, destination: DESTINATION, change: '1' });
    await assert.rejects(() => sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step(), /persisted selected plan/);
    assert.equal(w.sent.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an execute error after entering the wallet permanently halts that outpoint and never auto-sends it again', async () => {
  const dir = tmp();
  try {
    const w = world(); w.broadcastError = new Error('wallet disconnected after request');
    const store = makeFileStore(join(dir, 'journal'));
    await assert.rejects(() => sidecar(w, { store }).runner.step(), /wallet disconnected/);
    const halted = await store.get(journalId(N1));
    assert.equal(halted.state, 'halted');
    assert.equal(halted.manualReconciliationRequired, true);
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    assert.equal(w.sent.length, 1);
    assert.equal((await store.get(journalId(N1))).state, 'halted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crash after broadcast before moved leaves broadcasting; restart makes the ambiguity a persistent halt, not a second send', async () => {
  const dir = tmp();
  try {
    const w = world();
    const store = makeFileStore(join(dir, 'journal'));
    await assert.rejects(() => sidecar(w, { store, hooks: { afterExecute: async () => { throw new Error('crash after wallet returned'); } } }).runner.step(), /crash after wallet/);
    assert.equal((await store.get(journalId(N1))).state, 'broadcasting');
    assert.equal(w.sent.length, 1);
    const restarted = await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    assert.equal((await store.get(journalId(N1))).state, 'halted');
    assert.equal(restarted.status.intakeAllowed, false);
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    assert.equal(w.sent.length, 1, 'even a visible destination is manually reconciled, never broadcast again');
    assert.equal((await store.get(journalId(N1))).state, 'halted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crash after moved is reconciled from chain and reverse inventory without another move', async () => {
  const dir = tmp();
  try {
    const w = world();
    const store = makeFileStore(join(dir, 'journal'));
    await assert.rejects(() => sidecar(w, { store, hooks: { afterMoved: async () => { throw new Error('crash after moved'); } } }).runner.step(), /crash after moved/);
    assert.equal((await store.get(journalId(N1))).state, 'moved');
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    const done = await store.get(journalId(N1));
    assert.equal(done.state, 'done');
    assert.equal(done.destinationNote.amount, str(5));
    assert.equal(w.sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('moved waits for source spend, destination confirmation and exact reverse inventory, then completes once', async () => {
  const w = world(); w.revealConfirmed = false; w.reverseVisible = false;
  const { runner, store } = sidecar(w);
  await runner.step();
  assert.equal((await store.get(journalId(N1))).state, 'moved');
  const waiting = await runner.step();
  assert.equal(waiting.status.newFundingAllowed, false);
  assert.equal((await store.get(journalId(N1))).state, 'moved');
  w.confirmReveal();
  await sidecar(w, { store }).runner.step();
  assert.equal((await store.get(journalId(N1))).state, 'done');
  assert.equal(w.sent.length, 1);
});

test('pure reconciliation refuses wrong spender, wrong address, wrong amount, missing output and insufficient confirmations', () => {
  const record = { ...moveRecord(N1, str(5), 'moved'), broadcastTxid: id('e') };
  const base = {
    record, sourceOutspend: { spent: true, txid: id('e') }, broadcastTx: txFor({ txid: id('e'), vout: 0 }, { address: REVERSE, height: 99 }),
    reverseNotes: [{ txid: id('e'), vout: 0, amount: units(5) }], tipHeight: 100, minConfs: 2,
  };
  assert.equal(reconcileMoved(base).done, true);
  assert.equal(reconcileMoved({ ...base, sourceOutspend: { spent: false } }).reason, 'source_not_spent_yet');
  assert.equal(reconcileMoved({ ...base, sourceOutspend: { spent: true } }).reason, 'source_spender_unread');
  assert.equal(reconcileMoved({ ...base, sourceOutspend: { spent: true, txid: id('f') } }).reason, 'source_spent_by_another_transaction');
  assert.equal(reconcileMoved({ ...base, minConfs: 3 }).reason, 'broadcast_insufficient_confirmations');
  assert.equal(reconcileMoved({ ...base, broadcastTx: txFor(N1, { address: OTHER }) }).reason, 'reverse_destination_output_missing');
  assert.equal(reconcileMoved({ ...base, reverseNotes: [{ txid: id('e'), vout: 0, amount: units(6) }] }).reason, 'reverse_inventory_not_visible_or_amount_mismatch');
});

test('restart recovery changes only broadcasting to halted; selected, moved, done and existing halted records keep their states', () => {
  const records = ['selected', 'broadcasting', 'moved', 'done', 'halted'].map((state, i) => moveRecord({ txid: id(String(i + 1)), vout: 0 }, str(i + 1), state));
  const recovered = recoverAmbiguousBroadcasts(records, NOW);
  assert.deepEqual(recovered.records.map((r) => r.state), ['selected', 'halted', 'moved', 'done', 'halted']);
  assert.equal(recovered.halted.length, 1);
  assert.equal(recovered.halted[0].haltReason, 'restart_or_tick_with_broadcast_outcome_uncertain');
});

test('alerts are durable, idempotent and throttled across runner restarts', async () => {
  const dir = tmp();
  try {
    const w = world({ notes: [note(N1, str(5), { lineage: { state: 'unread' } })] });
    const store = makeFileStore(join(dir, 'journal'));
    await sidecar(w, { store }).runner.step();
    assert.equal(w.alerts.length, 1);
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    assert.equal(w.alerts.length, 1, 'same unread condition does not alert again after restart');
    w.now += 3601;
    await sidecar(w, { store: makeFileStore(join(dir, 'journal')) }).runner.step();
    assert.equal(w.alerts.length, 2, 'the throttle window expiring permits a reminder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('alert helper persists before notifying and is idempotent even when keys contain outpoints', async () => {
  const store = makeMemoryStore(), alerts = [];
  let now = 100;
  const notify = makeThrottledAlert({ store, alert: (a) => alerts.push(a), now: () => now, alertSecs: 60 });
  assert.equal(await notify(`lineage:${outpointId(N1)}`, { level: 'warn', msg: 'unread' }), true);
  assert.equal(await notify(`lineage:${outpointId(N1)}`, { level: 'warn', msg: 'unread' }), false);
  now += 60;
  assert.equal(await notify(`lineage:${outpointId(N1)}`, { level: 'warn', msg: 'unread' }), true);
  assert.equal(alerts.length, 2);
});

test('a failed alert rolls back its marker for immediate retry while concurrent calls remain throttled', async () => {
  const store = makeMemoryStore();
  let calls = 0, rejectFirst;
  const gate = new Promise((resolve, reject) => { rejectFirst = reject; });
  const notify = makeThrottledAlert({
    store, now: () => 100, alertSecs: 60,
    alert: async () => { calls++; if (calls === 1) await gate; },
  });
  const first = notify('lineage:test', { level: 'warn', msg: 'unread' });
  for (let i = 0; i < 5 && calls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(await notify('lineage:test', { level: 'warn', msg: 'unread' }), false, 'the in-flight marker still throttles concurrent callers');
  rejectFirst(new Error('webhook failed'));
  await assert.rejects(first, /webhook failed/);
  assert.equal(await notify('lineage:test', { level: 'warn', msg: 'unread' }), true, 'failure rollback permits an immediate retry');
  assert.equal(calls, 2);
  assert.equal(await notify('lineage:test', { level: 'warn', msg: 'unread' }), false, 'the successful retry is idempotent');
});

test('measured stuck exposure is main eligible plus pending plus reverse stock, with below, at and above ceiling boundaries', () => {
  const candidate = note(N1, str(5));
  const records = [moveRecord(N2, str(6), 'selected')];
  const reverseNotes = [{ txid: id('8'), vout: 0, amount: str(4) }];
  const at = (maxStuckTac) => buildStatusRecord({
    config: config({ maxStuckTac, maxInventoryTac: '100', stallSecs: 100 }), records, reverseNotes, candidates: [candidate, note(N2, str(6))], nowSecs: NOW,
  });
  const below = at('16'), exact = at('15'), above = at('14');
  for (const status of [below, exact, above]) {
    assert.equal(status.measuredStuckTac, '15');
    assert.equal(status.measuredStuckBaseUnits, str(15));
    assert.equal(status.stall.measuredStuckTac, '15');
    assert.equal(status.stall.totalReverseStockIncludingPendingTac, '10');
    assert.equal(status.stall.eligibleStockTac, '5');
    assert.equal(status.reverseStockTac, '4');
    assert.equal(status.pendingTac, '6');
    assert.equal(status.eligibleNoteCount, 1, 'the pending source is not counted again as eligible main stock');
    assert.equal(status.unleasedHouseNotesIncluded, false);
  }
  assert.equal(below.stall.aboveConfiguredStuckCeiling, false);
  assert.equal(below.intakeAllowed, true);
  assert.equal(exact.stall.aboveConfiguredStuckCeiling, false, 'the ceiling itself is allowed');
  assert.equal(exact.intakeAllowed, true);
  assert.equal(above.maxStuckTac, '14');
  assert.equal(above.maxStuckBaseUnits, str(14));
  assert.equal(above.stall.configuredStuckCeilingTac, '14');
  assert.equal(above.stall.aboveConfiguredStuckCeiling, true);
  assert.equal(above.aboveConfiguredStuckCeiling, true);
  assert.equal(above.intakeAllowed, false);
});

test('maxStuckTac circuit breaking is separate from maxInventoryTac move admission', () => {
  const candidate = note(N1, str(50));
  const reverseNotes = [{ txid: id('8'), vout: 0, amount: str(20) }];
  const circuitOnly = config({ maxStuckTac: '60', maxInventoryTac: '100' });
  const position = journalPosition([], reverseNotes, NOW);
  assert.equal(admissionDecision({ note: candidate, config: circuitOnly, position, feeRate: 3 }).ok, true, '70 fits the 100 admission inventory cap');
  const stopped = buildStatusRecord({ config: circuitOnly, records: [], reverseNotes, candidates: [candidate], nowSecs: NOW });
  assert.equal(stopped.measuredStuckTac, '70');
  assert.equal(stopped.stall.aboveConfiguredStuckCeiling, true, 'the same 70 exceeds the separate 60 circuit ceiling');
  assert.equal(stopped.intakeAllowed, false);

  const admissionOnly = config({ maxStuckTac: '100', maxInventoryTac: '30' });
  assert.ok(admissionDecision({ note: candidate, config: admissionOnly, position, feeRate: 3 }).reasons.includes('inventory_cap'));
  const intake = buildStatusRecord({ config: admissionOnly, records: [], reverseNotes, candidates: [candidate], nowSecs: NOW });
  assert.equal(intake.stall.aboveConfiguredStuckCeiling, false, '70 remains below the 100 circuit ceiling');
  assert.equal(intake.intakeAllowed, true, 'an individual move failing inventory admission does not trip the circuit breaker');
});

test('unleased main-address wallet notes are not claimed or counted as measured stuck exposure', async () => {
  const w = world({ notes: [note(N1, str(5))], extraNotes: [note(N2, str(500))], rate: 11 });
  const { runner } = sidecar(w, { cfg: config({ maxStuckTac: '10', maxInventoryTac: '1000' }) });
  const result = await runner.step();
  assert.equal(result.plan, null, 'the high fee rate leaves the leased candidate untouched');
  assert.equal(result.status.eligibleNoteCount, 1);
  assert.equal(result.status.measuredStuckTac, '5', 'the unleased 500 TAC wallet note is outside the measurement');
  assert.equal(result.status.measurementScope, 'eligible_leased_main_candidates_plus_reverse_stock_and_pending');
  assert.equal(result.status.unleasedHouseNotesIncluded, false);
  assert.equal(result.status.stall.aboveConfiguredStuckCeiling, false);
  assert.equal(result.status.intakeAllowed, true);
  assert.equal(w.sent.length, 0);
});

test('measured stuck status and its intake gate persist for consumers across restart', async () => {
  const dir = tmp();
  try {
    const w = world({ notes: [note(N1, str(5))], reverseNotes: [{ txid: id('8'), vout: 0, amount: str(4) }] });
    const pending = moveRecord(N2, str(6), 'moved', { broadcastTxid: id('7') });
    const store = makeFileStore(join(dir, 'journal'));
    await store.put(pending);
    const cfg = config({ maxStuckTac: '14', maxInventoryTac: '100' });
    const first = await sidecar(w, { store, cfg }).runner.step();
    assert.equal(first.status.measuredStuckTac, '15');
    assert.equal(first.status.pendingTac, '6');
    assert.equal(first.status.reverseStockTac, '4');
    assert.equal(first.status.stall.eligibleStockTac, '5');
    assert.equal(first.status.stall.aboveConfiguredStuckCeiling, true);
    assert.equal(first.status.intakeAllowed, false);
    const consumed = await makeFileStore(join(dir, 'journal')).get('status');
    assert.equal(consumed.maxStuckTac, '14');
    assert.equal(consumed.measuredStuckBaseUnits, str(15));
    assert.equal(consumed.stall.aboveConfiguredStuckCeiling, true);
    assert.equal(consumed.intakeAllowed, false);
    const second = await sidecar(w, { store: makeFileStore(join(dir, 'journal')), cfg }).runner.step();
    assert.equal(second.status.measuredStuckTac, consumed.measuredStuckTac);
    assert.equal(second.status.intakeAllowed, false);
    assert.equal(w.sent.length, 0, 'restart only reconciles and reports the existing pending move');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status exposes above-ceiling and no-completed-recovery stall reasons with a forward intake gate', () => {
  const candidate = note(N1, str(5));
  const base = { config: config({ maxInventoryTac: '100', maxStuckTac: '100', stallSecs: 100 }), records: [], candidates: [candidate], nowSecs: NOW, eligibleSince: NOW };
  const ok = buildStatusRecord(base);
  assert.equal(ok.intakeAllowed, true);
  assert.equal(ok.stallReason, null);
  assert.equal(ok.buyerDemandGuaranteed, false);
  const above = buildStatusRecord({ ...base, reverseNotes: [{ txid: id('8'), vout: 0, amount: str(101) }] });
  assert.equal(above.stallReason, 'reverse_stock_above_configured_ceiling');
  assert.equal(above.intakeAllowed, false);
  const timeless = buildStatusRecord({ ...base, eligibleSince: null, nowSecs: NOW + 100 });
  assert.equal(timeless.stall.noCompletedRecoveryWithinStallSecs, false, 'no concrete elapsed interval is not evidence of a stall');
  const stalled = buildStatusRecord({ ...base, nowSecs: NOW + 100 });
  assert.equal(stalled.stallReason, 'no_completed_recovery_within_stallSecs');
  assert.equal(stalled.stall.elapsedSecs, 100);
  assert.equal(stalled.stall.lastCompletedAt, null);
  assert.equal(stalled.intakeAllowed, false);
  const fundingOnly = buildStatusRecord({ ...base, nowSecs: NOW + 100, records: [moveRecord(N2, str(1), 'done', { completedAt: NOW + 50 })] });
  assert.equal(fundingOnly.stalled, true, 'funding moved to done is not a completed sale and does not reset the stall');
  const recovered = buildStatusRecord({
    ...base, nowSecs: NOW + 100, records: [moveRecord(N2, str(1), 'done', { completedAt: NOW + 50 })],
    reverseSwaps: [{ ...saleRecord([N3], str(1), 'done', { updated: NOW + 50 }), noteInputs: [{ ...N3, amount: str(1) }] }],
  });
  assert.equal(recovered.stalled, false);
  assert.equal(recovered.stall.lastCompletedAt, NOW + 50);
  assert.equal(recovered.stall.lastSaleAt, NOW + 50);
  assert.equal(recovered.stall.elapsedSecs, 50);
  const disabled = buildStatusRecord({ ...base, config: parseRebalanceConfig(rawConfig({ enabled: false })) });
  assert.equal(disabled.intakeReason, 'rebalancer_disabled');
  const ambiguous = buildStatusRecord({ ...base, records: [moveRecord(N2, str(1), 'halted', { broadcastAttempted: true })] });
  assert.equal(ambiguous.intakeReason, 'manual_broadcast_reconciliation_required');
  assert.equal(ambiguous.intakeAllowed, false);
});

test('strict journal never resurrects a selected backup beside a torn broadcasting primary', async () => {
  const dir = tmp();
  try {
    const store = makeStrictFileStore(join(dir, 'journal'));
    const selected = moveRecord(N1, str(5), 'selected', { coin: C1, mode: 'plain', change: '0' });
    await store.put(selected);
    await store.put({ ...selected, state: 'broadcasting', broadcastAttempted: true });
    writeFileSync(join(dir, 'journal', `${journalId(N1)}.json`), '{');
    assert.equal(JSON.parse(readFileSync(join(dir, 'journal', `${journalId(N1)}.json.bak`), 'utf8')).state, 'selected');
    const w = world();
    await assert.rejects(() => sidecar(w, { store }).runner.step(), /journal.*fail closed|journal is unreadable/);
    assert.equal(w.sent.length, 0, 'the selected backup is never used for a second send');
    assert.ok(store.problems().length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict journal detects orphaned backups and fails closed when primary and backup are both unreadable', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'journal', `${journalId(N1)}.json`);
    const orphan = makeStrictFileStore(join(dir, 'journal'));
    writeFileSync(file + '.bak', '{also broken');
    await assert.rejects(() => sidecar(world(), { store: orphan }).runner.step(), /fail closed/);
    assert.match(orphan.problems()[0].error, /orphaned backup/);
    writeFileSync(file, '{broken');
    const both = makeStrictFileStore(join(dir, 'journal'));
    const w = world();
    await assert.rejects(() => sidecar(w, { store: both }).runner.step(), /fail closed/);
    assert.equal(w.sent.length, 0);
    assert.ok(both.problems().length > 0, 'caps and reservations cannot be computed from unreadable records');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary stores retain backup reads while strict stores report the same primary as unsafe', async () => {
  const dir = tmp();
  try {
    const ordinary = makeFileStore(join(dir, 'ordinary')), strict = makeStrictFileStore(join(dir, 'strict'));
    const rec = moveRecord(N1, str(5), 'selected');
    await ordinary.put(rec); await ordinary.put({ ...rec, state: 'broadcasting' });
    await strict.put(rec); await strict.put({ ...rec, state: 'broadcasting' });
    writeFileSync(join(dir, 'ordinary', `${journalId(N1)}.json`), '{');
    writeFileSync(join(dir, 'strict', `${journalId(N1)}.json`), '{');
    assert.equal((await ordinary.get(journalId(N1))).state, 'selected');
    assert.equal(await strict.get(journalId(N1)), null);
    assert.ok(strict.problems().length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a removed or amount-changed note lease persistently halts a resumed selected plan without broadcasting', async () => {
  for (const changedAmount of [false, true]) {
    const w = world();
    const store = makeMemoryStore();
    await store.put(moveRecord(N1, str(5), 'selected', { coin: C1, mode: 'plain', change: '0' }));
    if (changedAmount) w.leases.notes[0].amount = str(6); else w.leases.notes = [];
    await assert.rejects(() => sidecar(w, { store }).runner.step(), /current lease does not authorise note/);
    const halted = await store.get(journalId(N1));
    assert.equal(halted.state, 'halted');
    assert.equal(halted.broadcastAttempted, false);
    assert.equal(halted.haltReason, 'lease_note_revoked');
    await sidecar(w, { store }).runner.step();
    assert.equal(w.sent.length, 0);
  }
});

test('a removed fee-coin lease persistently halts a resumed selected plan without broadcasting', async () => {
  const w = world(), store = makeMemoryStore();
  await store.put(moveRecord(N1, str(5), 'selected', { coin: C1, mode: 'plain', change: '0' }));
  w.leases.feeCoins = [];
  await assert.rejects(() => sidecar(w, { store }).runner.step(), /current lease does not authorise fee coin/);
  assert.equal((await store.get(journalId(N1))).haltReason, 'lease_coin_revoked');
  assert.equal((await store.get(journalId(N1))).state, 'halted');
  await sidecar(w, { store }).runner.step();
  assert.equal(w.sent.length, 0);
});

test('lease revocation after selection and inside the pre-execute hook cannot race a broadcast', async () => {
  const afterSelection = world();
  await assert.rejects(() => sidecar(afterSelection, { hooks: { afterSelected: async () => { afterSelection.leases.feeCoins = []; } } }).runner.step(), /current lease does not authorise fee coin/);
  assert.equal(afterSelection.sent.length, 0);
  const beforeExecute = world();
  await assert.rejects(() => sidecar(beforeExecute, { hooks: { beforeExecute: async () => { beforeExecute.leases.notes = []; } } }).runner.step(), /current lease does not authorise note/);
  assert.equal(beforeExecute.sent.length, 0);
});

test('a compliant runner precheck cannot protect an above-cap builder rate: the builder refuses before chain broadcasts', async () => {
  const w = world({ rate: 3 });
  const fund = {
    executeFund: async (args) => executeFundReal({ ...args, plan: { ...args.plan, feeRate: 11 } }),
  };
  await assert.rejects(() => sidecar(w, { fund }).runner.step(), /builder fee cap refused/);
  assert.equal(w.builderCalls.length, 1);
  assert.equal(w.builderCalls[0].feeRate, 11);
  assert.equal(w.builderCalls[0].maxFeeRate, 10);
  assert.equal(w.sent.length, 0, 'no commit or reveal is broadcast');
  assert.equal(w.reverseNotes.length, 0);
});

test('an ambiguous halted record blocks all new funding with headroom while moved reconciliation still completes', async () => {
  const w = world({ notes: [note(N1, str(5)), note(N2, str(4))] });
  const store = makeMemoryStore(), moved = moveRecord(N1, str(5), 'moved', { broadcastTxid: id('7'), destinationNote: { txid: id('7'), vout: 0, amount: str(5) } });
  await store.put(moved);
  await store.put(moveRecord(N3, str(1), 'halted', { broadcastAttempted: true }));
  w.spent[outpointId(N1)] = { spent: true, txid: id('7') };
  w.txs[id('7')] = txFor({ txid: id('7'), vout: 0 }, { address: REVERSE, height: 99 });
  w.reverseNotes.push({ txid: id('7'), vout: 0, amount: units(5) });
  const result = await sidecar(w, { store }).runner.step();
  assert.equal((await store.get(journalId(N1))).state, 'done');
  assert.equal(result.status.newFundingAllowed, false);
  assert.equal(result.status.intakeAllowed, false);
  assert.equal(result.plan, null);
  assert.equal(w.sent.length, 0, 'the other eligible 4 TAC note is not funded');
});

test('every pre-existing lock, including a valid dead-PID lock, requires manual removal', () => {
  const dir = tmp();
  try {
    for (const [name, contents] of [['empty', ''], ['partial', '{"version":1,"pid":'], ['invalid', '{"version":1,"pid":123}']]) {
      const file = join(dir, name + '.pid');
      writeFileSync(file, contents);
      assert.throws(() => acquireProcessLock(file), /remove it manually/);
      assert.equal(readFileSync(file, 'utf8'), contents, 'the lock is left for the operator');
    }
    const stale = join(dir, 'stale.pid'), contents = JSON.stringify({ version: 1, pid: 99999999, token: 'dead-pid' });
    writeFileSync(stale, contents);
    assert.throws(() => acquireProcessLock(stale), /remove it manually/);
    assert.equal(readFileSync(stale, 'utf8'), contents, 'a dead PID is never reclaimed automatically');
    rmSync(stale);
    const recovered = acquireProcessLock(stale);
    recovered.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent lock creation has exactly one winner', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'race.pid');
    const attempts = await Promise.allSettled([Promise.resolve().then(() => acquireProcessLock(file)), Promise.resolve().then(() => acquireProcessLock(file))]);
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((r) => r.status === 'rejected').length, 1);
    attempts.find((r) => r.status === 'fulfilled').value.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a valid first explorer read followed by malformed second-read confirmations cannot reach planning or broadcast', async () => {
  const w = world(), real = w.getJson;
  let reads = 0;
  w.getJson = async (path) => {
    const result = await real(path);
    if (path === `/tx/${N1.txid}`) {
      reads++;
      if (reads === 3) return { ...result, status: { ...result.status, block_height: '99' } };
    }
    return result;
  };
  await assert.rejects(() => sidecar(w).runner.step(), /no valid confirmation height|invalid confirmations/);
  assert.equal(reads, 3);
  assert.equal(w.sent.length, 0);
});

test('malformed, inverted and economically invalid reverse terms fail closed', () => {
  assert.throws(() => config({}, { minAmount: '100', maxAmount: '99' }), /inverted or empty/);
  assert.throws(() => config({}, { feeBps: 10000, flatFee: '0' }), /economically invalid/);
  const c = config();
  const position = journalPosition([], [], NOW);
  assert.ok(admissionDecision({ amount: 100n, config: c, position, feeRate: 1, terms: { minAmount: '1' } }).reasons.includes('invalid_reverse_terms'));
  assert.ok(admissionDecision({ amount: 100n, config: c, position, feeRate: 1, terms: { minAmount: '200', maxAmount: '100', feeBps: 0, flatFee: 0 } }).reasons.includes('invalid_reverse_terms'));
});

test('zero-fee terms with a 105 percent proceeds floor cannot move or count a note as eligible', async () => {
  const cfg = config({}, { feeBps: 0, flatFee: '0', minProceedsBps: 10500 });
  const candidate = note(N1, str(5));
  assert.equal(selectWholeNote({ candidates: [candidate], config: cfg, feeRate: 3, nowSecs: NOW }).note, null);
  const status = buildStatusRecord({ config: cfg, candidates: [candidate], nowSecs: NOW, watchSince: NOW });
  assert.equal(status.eligibleNoteCount, 0);
  assert.equal(status.measuredStuckTac, '0');
  const w = world();
  const result = await sidecar(w, { cfg }).runner.step();
  assert.equal(result.plan, null);
  assert.equal(w.sent.length, 0);
});

test('proceeds admission uses the exact whole-note quote, including note-specific impossible premiums', () => {
  const terms = { minAmount: '1000', maxAmount: '20000', feeBps: 0, flatFee: '500', minProceedsBps: 10500 };
  assert.equal(exactReverseSale(terms, 1000n).evmAmount, 1500n);
  assert.equal(exactReverseSale(terms, 1000n).proceedsOk, true);
  assert.equal(exactReverseSale(terms, 10000n).evmAmount, 10500n);
  assert.equal(exactReverseSale(terms, 10000n).proceedsOk, true);
  assert.equal(exactReverseSale(terms, 10001n).evmAmount, 10501n);
  assert.equal(exactReverseSale(terms, 10001n).proceedsOk, false);
  const c = config();
  const position = journalPosition([], [], NOW);
  assert.equal(admissionDecision({ amount: 1000n, config: c, position, feeRate: 1, terms }).ok, true);
  assert.ok(admissionDecision({ amount: 10001n, config: c, position, feeRate: 1, terms }).reasons.includes('proceeds_floor_unreachable'));
});

test('active, completed and refunded reverse swaps produce sale-aware exposure without double counting', () => {
  const left = { txid: id('8'), vout: 0 }, right = { txid: id('9'), vout: 0 };
  const active = saleRecord([left, right], str(8), 'offered');
  const oneVisible = [{ ...left, amount: units(5) }];
  let position = reverseSwapPosition(oneVisible, [active]);
  assert.equal(position.reverseStockTac, units(5));
  assert.equal(position.activeReverseSwapTac, units(3));
  position = reverseSwapPosition([...oneVisible, { txid: id('7'), vout: 0, amount: units(2) }], [active]);
  assert.equal(position.reverseStockTac + position.activeReverseSwapTac, units(10));
  const done = saleRecord([left], str(5), 'done', { terminalAt: NOW + 10, completedAt: NOW + 15, updated: NOW + 999 });
  position = reverseSwapPosition(oneVisible, [done]);
  assert.equal(position.reverseStockTac, 0n, 'a stale wallet note already sold is excluded');
  assert.equal(position.activeReverseSwapTac, 0n);
  assert.equal(position.lastSaleAt, NOW + 10, 'terminalAt wins over an unrelated later updated value');
  const refundTxid = id('6'), refunded = saleRecord([left], str(5), 'refunded', { terminalAt: NOW + 25, completedAt: NOW + 28, updated: NOW + 999, refund: { txid: refundTxid, vout: 1 } });
  assert.notEqual(refundTxid, left.txid, 'the refund is a different transaction from the original input');
  position = reverseSwapPosition([], [refunded]);
  assert.equal(position.activeReverseSwapTac, units(5), 'a missing refund remains fully represented as in-flight exposure');
  assert.equal(position.reverseStockTac, 0n);
  assert.equal(position.activeReverseSwapCount, 0);
  assert.equal(position.lastSaleAt, null);
  assert.equal(position.lastRefundAt, NOW + 25);
  position = reverseSwapPosition(oneVisible, [refunded]);
  assert.equal(position.reverseStockTac, 0n, 'a stale original input is excluded while the new refund is invisible');
  assert.equal(position.activeReverseSwapTac, units(5), 'refund exposure appears exactly once while invisible');
  const refundNote = { txid: refundTxid, vout: 1, amount: units(5) };
  position = reverseSwapPosition([refundNote], [refunded]);
  assert.equal(position.reverseStockTac, units(5), 'the exact visible refund is wallet stock');
  assert.equal(position.activeReverseSwapTac, 0n, 'and is not counted again as active sale exposure');
  assert.equal(position.activeReverseSwapCount, 0);
  position = reverseSwapPosition([{ ...refundNote, vout: 0 }], [refunded]);
  assert.equal(position.activeReverseSwapTac, units(5), 'a different vout does not hide the missing refund');
  position = reverseSwapPosition([{ ...refundNote, amount: units(4) }], [refunded]);
  assert.equal(position.activeReverseSwapTac, units(5), 'a different amount does not hide the missing refund');
});

test('an early active reverse sale is destination evidence for moved reconciliation', async () => {
  const broadcastTxid = id('7'), record = { ...moveRecord(N1, str(5), 'moved'), broadcastTxid };
  const swap = saleRecord([{ txid: broadcastTxid, vout: 0 }], str(5), 'offered');
  const result = reconcileMoved({
    record, sourceOutspend: { spent: true, txid: broadcastTxid },
    broadcastTx: txFor({ txid: broadcastTxid, vout: 0 }, { address: REVERSE, height: 99 }),
    reverseNotes: [], reverseSwaps: [swap], tipHeight: 100, minConfs: 2,
  });
  assert.equal(result.done, true);
  assert.equal(result.destinationEvidence, 'reverse_swap_journal');
  const w = world(), store = makeMemoryStore(), reverseSwaps = makeMemoryStore();
  await store.put(record);
  await reverseSwaps.put(swap);
  w.spent[outpointId(N1)] = { spent: true, txid: broadcastTxid };
  w.txs[broadcastTxid] = txFor({ txid: broadcastTxid, vout: 0 }, { address: REVERSE, height: 99 });
  const tick = await sidecar(w, { store, reverseSwaps }).runner.step();
  assert.equal((await store.get(journalId(N1))).state, 'done');
  assert.equal(tick.status.activeReverseSwapTac, '5');
  assert.equal(tick.status.lastSaleAt, null, 'funding done and an active sale are not a completed recovery');
});

test('journal reconciliation rejects multiple destination references and verifies only private note amounts', () => {
  const broadcastTxid = id('7'), record = { ...moveRecord(N1, str(5), 'moved'), broadcastTxid };
  const broadcastTx = txFor({ txid: broadcastTxid, vout: 0 }, { address: REVERSE, height: 99 });
  broadcastTx.vout.push({ value: 546, scriptpubkey_address: REVERSE });
  const base = {
    record, sourceOutspend: { spent: true, txid: broadcastTxid }, broadcastTx,
    reverseNotes: [], tipHeight: 100, minConfs: 2,
  };
  const multiple = saleRecord([{ txid: broadcastTxid, vout: 0 }, { txid: broadcastTxid, vout: 1 }], str(5), 'offered');
  assert.equal(reconcileMoved({ ...base, reverseSwaps: [multiple] }).reason, 'ambiguous_reverse_swap_destination');
  const first = saleRecord([{ txid: broadcastTxid, vout: 0 }], str(5), 'offered');
  const second = { ...first, id: 's-second-reference' };
  assert.equal(reconcileMoved({ ...base, reverseSwaps: [first, second] }).reason, 'ambiguous_reverse_swap_destination');
  first.noteInputs[0].amount = str(5);
  const accepted = reconcileMoved({ ...base, reverseSwaps: [first] });
  assert.equal(accepted.done, true);
  assert.equal(accepted.destination.amount, str(5));
  assert.equal(broadcastTx.vout[0].value, 546, 'the chain output remains dust, not the private TAC amount');
  first.noteInputs[0].amount = str(4);
  assert.equal(reconcileMoved({ ...base, reverseSwaps: [first] }).reason, 'reverse_swap_amount_mismatch');
});

test('unsold reverse stock alone stalls, while new exposure receives its full watch interval', async () => {
  const reverseNotes = [{ txid: id('8'), vout: 0, amount: str(5) }];
  const stalled = buildStatusRecord({ config: config({ stallSecs: 100 }), reverseNotes, nowSecs: NOW, watchSince: NOW - 100 });
  assert.equal(stalled.eligibleNoteCount, 0);
  assert.equal(stalled.stallReason, 'no_completed_recovery_within_stallSecs');
  assert.equal(stalled.intakeAllowed, false);
  const w = world({ notes: [], reverseNotes, rate: 11 }), store = makeMemoryStore();
  const first = await sidecar(w, { store }).runner.step();
  assert.equal(first.status.stall.noCompletedRecoveryWithinStallSecs, false);
  const watch = first.status.watchSince;
  w.now += 50;
  w.leases.notes = [note(N1, str(2))];
  w.txs[N1.txid] = txFor(N1);
  w.walletNotes = [note(N1, str(2))];
  const second = await sidecar(w, { store }).runner.step();
  assert.equal(second.status.watchSince, w.now, 'new main stock resets the watch instead of inheriting an old sale or funding timestamp');
  w.now += 99;
  assert.equal((await sidecar(w, { store }).runner.step()).status.stall.noCompletedRecoveryWithinStallSecs, false);
  w.now += 1;
  assert.equal((await sidecar(w, { store }).runner.step()).status.stall.noCompletedRecoveryWithinStallSecs, true);
  assert.equal(watch, NOW);
});

test('a done funding record with changed spend becomes a manual exposure-restoring halt and never rebroadcasts', async () => {
  const w = world({ notes: [note(N1, str(5)), note(N2, str(4))] }), store = makeMemoryStore();
  const done = moveRecord(N1, str(5), 'done', {
    broadcastTxid: id('7'), completedAt: NOW, destinationNote: { txid: id('7'), vout: 0, amount: str(5) },
  });
  await store.put(done);
  w.spent[outpointId(N1)] = { spent: true, txid: id('9') };
  w.txs[id('7')] = txFor({ txid: id('7'), vout: 0 }, { address: REVERSE, height: 99 });
  const result = await sidecar(w, { store }).runner.step();
  const halted = await store.get(journalId(N1));
  assert.equal(halted.state, 'halted');
  assert.equal(halted.previousState, 'done');
  assert.equal(halted.exposurePending, true);
  assert.equal(halted.haltReason, 'done_source_spend_changed');
  assert.equal(result.status.newFundingAllowed, false);
  assert.ok(Number(result.status.pendingBaseUnits) >= Number(str(5)));
  assert.ok(w.alerts.some((a) => /lost or changed its chain evidence/.test(a.msg)));
  await sidecar(w, { store }).runner.step();
  assert.equal(w.sent.length, 0);
  assert.equal(reconcileDone({ record: done, sourceOutspend: { spent: true, txid: id('9') }, broadcastTx: w.txs[id('7')], tipHeight: 100, minConfs: 2 }).ok, false);
  const unreadable = reconcileDone({ record: done, sourceOutspend: { spent: true, txid: id('7') }, broadcastTx: null, tipHeight: 100, minConfs: 2 });
  assert.equal(unreadable.reason, 'done_broadcast_unreadable');
  assert.equal(unreadable.transient, true);
});

test('reverse swap store problems fail closed before any funding', async () => {
  const w = world(), reverseSwaps = { list: async () => [], problems: () => [{ id: 'broken', error: 'unreadable' }] };
  await assert.rejects(() => sidecar(w, { reverseSwaps }).runner.step(), /reverse swap journal is unreadable/);
  assert.equal(w.sent.length, 0);
});

test('restricted global wallet views are serial across runner instances and prepareExact is not public', async () => {
  const worlds = [world({ notes: [note(N1, str(5))] }), world({ notes: [note(N2, str(4))], feeCoins: [coin(C2)] })];
  let active = 0, most = 0;
  const seen = [];
  const runners = worlds.map((w) => {
    const fund = {
      planFund: async (args) => {
        active++; most = Math.max(most, active);
        const response = await globalThis.fetch(`https://offline/address/${MAIN}/utxo`);
        seen.push((await response.json()).map(outpointId));
        await new Promise((resolve) => setTimeout(resolve, 20));
        try { return await planFundReal(args); } finally { active--; }
      },
    };
    const { runner } = sidecar(w, { fund });
    assert.equal(runner.prepareExact, undefined);
    return runner;
  });
  await Promise.all(runners.map((runner) => runner.step()));
  assert.equal(most, 1);
  assert.deepEqual(seen, [[outpointId(N1), outpointId(C1)], [outpointId(N2), outpointId(C2)]]);
});

test('inventory-then-journal ordering preserves a deferred sale that the old unsafe ordering measured as zero', async () => {
  const order = [], sale = saleRecord([{ txid: id('7'), vout: 0 }], str(5), 'offered');
  assert.equal(journalPosition([], [], NOW, []).totalStockTac, 0n, 'swap journal first, then a post-sale empty inventory would hide the value');
  const w = world({ notes: [] });
  w.reverseInventory.notes = async () => { order.push('inventory'); return []; };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reverseSwaps = {
    list: async () => { order.push('swaps'); await gate; return [sale]; },
    problems: () => [],
  };
  const { runner } = sidecar(w, { reverseSwaps, cfg: config({ maxStuckTac: '4' }) });
  const pending = runner.step();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const result = await pending;
  assert.deepEqual(order.slice(0, 2), ['inventory', 'swaps']);
  assert.equal(result.status.activeReverseSwapTac, '5');
  assert.equal(result.status.measuredStuckTac, '5');
  assert.equal(result.status.intakeAllowed, false);
});

test('a real orphan reverse swap backup fails the strict read-only CLI store path', async () => {
  const dir = tmp();
  try {
    const reverseSwaps = makeStrictFileStore(join(dir, 'swaps'));
    writeFileSync(join(dir, 'swaps', 's-orphan.json.bak'), JSON.stringify(saleRecord([N1], str(5), 'offered')));
    const w = world();
    await assert.rejects(() => sidecar(w, { reverseSwaps }).runner.step(), /reverse swap journal is unreadable/);
    assert.match(reverseSwaps.problems()[0].error, /orphaned backup/);
    assert.equal(w.sent.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a refunded outpoint reused by a follow-on swap is represented only by the follow-on lifecycle', () => {
  const refundTxid = id('6'), old = saleRecord([{ txid: id('8'), vout: 0 }], str(5), 'refunded', { refund: { txid: refundTxid, vout: 1 } });
  const offered = { ...saleRecord([{ txid: refundTxid, vout: 1 }], str(5), 'offered'), id: 's-follow-on' };
  const refundNote = { txid: refundTxid, vout: 1, amount: units(5) };
  let position = journalPosition([], [refundNote], NOW, [old, offered]);
  assert.equal(position.totalStockTac, units(5), 'refunded to offered counts five once while the input is visible');
  assert.equal(position.activeReverseSwapTac, 0n);
  position = journalPosition([], [], NOW, [old, offered]);
  assert.equal(position.totalStockTac, units(5), 'and counts five once after the input leaves inventory');
  assert.equal(position.activeReverseSwapTac, units(5));
  const done = { ...offered, phase: 'done', terminalAt: NOW + 10 };
  position = journalPosition([], [refundNote], NOW, [old, done]);
  assert.equal(position.totalStockTac, 0n, 'refunded to done has recovered the value and counts no remaining exposure');
  const unknownVout = { ...old, refund: { txid: refundTxid } };
  position = journalPosition([], [], NOW, [unknownVout, offered]);
  assert.equal(position.totalStockTac, units(5), 'a unique txid-only follow-on resolves the old refund conservatively');
});

test('done-monitor transients leave the record done for retry, then recover without a manual halt', async () => {
  const w = world(), store = makeMemoryStore(), done = moveRecord(N1, str(5), 'done', {
    broadcastTxid: id('7'), completedAt: NOW, destinationNote: { txid: id('7'), vout: 0, amount: str(5) },
  });
  await store.put(done);
  w.spent[outpointId(N1)] = { spent: true, txid: id('7') };
  w.txs[id('7')] = null;
  await sidecar(w, { store }).runner.step();
  assert.equal((await store.get(journalId(N1))).state, 'done');
  assert.ok(w.alerts.some((a) => /remains done and will be checked again/.test(a.msg)));
  assert.equal(w.alerts.some((a) => /lost or changed its chain evidence/.test(a.msg)), false);
  w.txs[id('7')] = txFor({ txid: id('7'), vout: 0 }, { address: REVERSE, height: 99 });
  await sidecar(w, { store }).runner.step();
  assert.equal((await store.get(journalId(N1))).state, 'done');
  assert.equal(w.sent.length, 0);
});

test('partial active sale and unconfirmed change preserve 100, then visible change still preserves 100', () => {
  const funding = moveRecord(N1, str(100), 'done', {
    broadcastTxid: id('7'), completedAt: NOW, destinationNote: { txid: id('7'), vout: 0, amount: str(100) },
  });
  const sale = saleRecord([{ txid: id('7'), vout: 0 }], str(60), 'offered', { lock: { txid: id('6'), vout: 0 } });
  let position = journalPosition([funding], [], NOW, [sale]);
  assert.equal(position.activeReverseSwapTac, units(60));
  assert.equal(position.pendingTac, units(40));
  assert.equal(position.totalStockTac, units(100), '60 active plus 40 unconfirmed change residual');
  const change = { txid: id('6'), vout: 1, amount: units(40), confirmed: false };
  position = journalPosition([funding], [change], NOW, [sale]);
  assert.equal(position.reverseStockTac, units(40));
  assert.equal(position.activeReverseSwapTac, units(60));
  assert.equal(position.pendingTac, 0n);
  assert.equal(position.totalStockTac, units(100), 'visible change is not counted as a further reduction and addition');
  assert.equal(position.unconfirmedReverseStockTac, units(40));
  const status = buildStatusRecord({ config: config(), records: [funding], reverseNotes: [change], reverseSwaps: [sale], nowSecs: NOW });
  assert.equal(status.unconfirmedReverseStockBaseUnits, str(40));
  change.confirmed = true;
  position = journalPosition([funding], [change], NOW, [sale]);
  assert.equal(position.totalStockTac, units(100));
  assert.equal(position.unconfirmedReverseStockTac, 0n);
});

test('multi-input allocation preserves original exposure through active, done and refunded lifecycles', () => {
  const first = moveRecord(N1, str(100), 'done', { broadcastTxid: id('7'), destinationNote: { txid: id('7'), vout: 0, amount: str(100) } });
  const second = moveRecord(N2, str(50), 'done', { broadcastTxid: id('8'), destinationNote: { txid: id('8'), vout: 0, amount: str(50) } });
  const records = [first, second], inputs = [{ txid: id('7'), vout: 0 }, { txid: id('8'), vout: 0 }];
  const active = saleRecord(inputs, str(120), 'offered', { lock: { txid: id('6'), vout: 0 } });
  let position = journalPosition(records, [], NOW, [active]);
  assert.equal(position.activeReverseSwapTac, units(120));
  assert.equal(position.pendingTac, units(30));
  assert.equal(position.totalStockTac, units(150));
  const change = { txid: id('6'), vout: 1, amount: units(30) };
  position = journalPosition(records, [change], NOW, [active]);
  assert.equal(position.reverseStockTac + position.pendingTac + position.activeReverseSwapTac, units(150));
  const done = { ...active, phase: 'done', terminalAt: NOW + 10 };
  position = journalPosition(records, [], NOW, [done]);
  assert.equal(position.totalStockTac, units(30), '120 completed sale leaves only the 30 residual');
  position = journalPosition(records, [change], NOW, [done]);
  assert.equal(position.totalStockTac, units(30), 'visible change represents that residual once');
  const refunded = { ...active, phase: 'refunded', refund: { txid: id('5'), vout: 0 } };
  position = journalPosition(records, [change], NOW, [refunded]);
  assert.equal(position.totalStockTac, units(150), 'a missing refund and visible change do not double count');
  const refundNote = { txid: id('5'), vout: 0, amount: units(120) };
  position = journalPosition(records, [change, refundNote], NOW, [refunded]);
  assert.equal(position.totalStockTac, units(150), 'visible refund and change represent the original 150 exactly once');
});

test('unlinked residuals survive active, done and refunded sales with visible change allocated once', () => {
  const input = { txid: id('7'), vout: 0, amount: str(100) }, sale = saleRecord([input], str(60), 'offered', { lock: { txid: id('6'), vout: 0 } });
  sale.noteInputs[0].amount = str(100);
  let position = journalPosition([], [], NOW, [sale]);
  assert.equal(position.activeReverseSwapTac, units(60));
  assert.equal(position.pendingTac, units(40));
  assert.equal(position.totalStockTac, units(100));
  assert.ok(position.pendingItems.some((item) => item.startsWith('unlinked:')));
  const change = { txid: id('6'), vout: 1, amount: units(40), confirmed: false };
  position = journalPosition([], [change], NOW, [sale]);
  assert.equal(position.reverseStockTac, units(40));
  assert.equal(position.activeReverseSwapTac, units(60));
  assert.equal(position.pendingTac, 0n);
  assert.equal(position.totalStockTac, units(100));
  const done = { ...sale, phase: 'done', terminalAt: NOW + 10 };
  position = journalPosition([], [], NOW, [done]);
  assert.equal(position.totalStockTac, units(40));
  position = journalPosition([], [change], NOW, [done]);
  assert.equal(position.totalStockTac, units(40));
  const refunded = { ...sale, phase: 'refunded', refund: { txid: id('5'), vout: 0 } };
  position = journalPosition([], [change], NOW, [refunded]);
  assert.equal(position.totalStockTac, units(100));
  const followOn = { ...saleRecord([{ txid: id('5'), vout: 0 }], str(60), 'offered'), id: 's-follow-on-unlinked' };
  position = journalPosition([], [change], NOW, [refunded, followOn]);
  assert.equal(position.totalStockTac, units(100), 'refund to active follow-on retains 60 sale plus 40 residual exactly once');
  position = journalPosition([], [change], NOW, [refunded, { ...followOn, phase: 'done' }]);
  assert.equal(position.totalStockTac, units(40), 'refund to completed follow-on leaves only the 40 residual');
});

test('multi-input unlinked residuals and visible originals preserve exposure without double counting', () => {
  const inputs = [{ txid: id('7'), vout: 0, amount: str(100) }, { txid: id('8'), vout: 0, amount: str(50) }];
  const sale = saleRecord(inputs, str(120), 'offered', { lock: { txid: id('6'), vout: 0 } });
  sale.noteInputs.forEach((input, i) => { input.amount = inputs[i].amount; });
  let position = journalPosition([], [], NOW, [sale]);
  assert.equal(position.activeReverseSwapTac, units(120));
  assert.equal(position.pendingTac, units(30));
  assert.equal(position.totalStockTac, units(150));
  assert.equal(position.pendingItems.filter((item) => item.startsWith('unlinked:')).length, 1, 'the fully allocated first input has no residual; the second has 30');
  const change = { txid: id('6'), vout: 1, amount: units(30) };
  position = journalPosition([], [change], NOW, [sale]);
  assert.equal(position.totalStockTac, units(150));
  position = journalPosition([], [change], NOW, [{ ...sale, phase: 'done' }]);
  assert.equal(position.totalStockTac, units(30));
  const visibleOriginal = { txid: id('7'), vout: 0, amount: units(100) };
  position = journalPosition([], [visibleOriginal], NOW, [sale]);
  assert.equal(position.reverseStockTac, units(100));
  assert.equal(position.pendingTac, units(30), 'only the other unlinked residual is pending');
  assert.equal(position.totalStockTac, units(150));
});

test('unknown historical unlinked input amounts fail closed until a new amount is supplied', async () => {
  const historical = saleRecord([{ txid: id('7'), vout: 0 }], str(60), 'offered', { lock: { txid: id('6'), vout: 0 } });
  let position = journalPosition([], [], NOW, [historical]);
  assert.equal(position.exposureUnknown, true);
  assert.equal(position.unknownExposure[0].reason, 'reverse_input_amount_unknown');
  assert.ok(position.pendingItems.some((item) => item.startsWith('unknown:')));
  const candidate = note(N2, str(1));
  assert.ok(admissionDecision({ note: candidate, config: config(), position, feeRate: 3 }).reasons.includes('reverse_exposure_unknown'));
  assert.equal(selectWholeNote({ candidates: [candidate], reverseSwaps: [historical], config: config(), feeRate: 3, nowSecs: NOW }).note, null);
  let status = buildStatusRecord({ config: config(), candidates: [candidate], reverseSwaps: [historical], nowSecs: NOW });
  assert.equal(status.exposureUnknown, true);
  assert.equal(status.intakeAllowed, false);
  assert.equal(status.intakeReason, 'reverse_input_amount_unknown');
  assert.equal(status.newFundingAllowed, false);
  assert.ok(status.exposureItems.some((item) => item.startsWith('unknown:')));
  const w = world(), store = makeMemoryStore(), reverseSwaps = makeMemoryStore();
  await store.put(moveRecord(N1, str(5), 'selected', { coin: C1, mode: 'plain', change: '0' }));
  await reverseSwaps.put(historical);
  await assert.rejects(() => sidecar(w, { store, reverseSwaps }).runner.step(), /reverse_exposure_unknown/);
  assert.equal(w.sent.length, 0);
  historical.noteInputs[0].amount = str(100);
  position = journalPosition([], [], NOW, [historical]);
  assert.equal(position.exposureUnknown, false);
  assert.equal(position.totalStockTac, units(100));
  assert.equal(position.pendingTac, units(40));
  status = buildStatusRecord({ config: config(), reverseSwaps: [historical], nowSecs: NOW });
  assert.equal(status.exposureUnknown, false);
  assert.equal(status.intakeAllowed, true);
  assert.equal(status.newFundingAllowed, true);
});

test('an unconfirmed inventory note cannot complete moved reconciliation even with confirmed transaction evidence', () => {
  const broadcastTxid = id('7'), record = { ...moveRecord(N1, str(5), 'moved'), broadcastTxid };
  const result = reconcileMoved({
    record, sourceOutspend: { spent: true, txid: broadcastTxid },
    broadcastTx: txFor({ txid: broadcastTxid, vout: 0 }, { address: REVERSE, height: 99 }),
    reverseNotes: [{ txid: broadcastTxid, vout: 0, amount: units(5), confirmed: false }], tipHeight: 100, minConfs: 2,
  });
  assert.equal(result.done, false);
});

test('CLI uses strict funding and read-only reverse swap journals, accounting-only unconfirmed notes, and dry-run error exits', () => {
  const source = readFileSync(new URL('../fastbridge-lp/rebalance.mjs', import.meta.url), 'utf8');
  assert.match(source, /makeStrictFileStore\(resolve\(data, 'rebalance'\)\)/);
  assert.match(source, /makeStrictFileStore\(resolve\(data, 'reverse\/swaps'\)\)/);
  assert.match(source, /includeUnconfirmed: true/);
  assert.match(source, /reverseSwaps,/);
  assert.match(source, /catch \(e\) \{ tickFailed = true;/);
  assert.match(source, /if \(DRY\) \{ await tick\(\); if \(tickFailed\) process\.exitCode = 1; return; \}/);
});

test('one process lock excludes a concurrent sidecar and can be reacquired after release', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'rebalance.pid');
    const lock = acquireProcessLock(file);
    assert.throws(() => acquireProcessLock(file), /remove it manually/);
    lock.release();
    const second = acquireProcessLock(file);
    second.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} reverse rebalancer checks passed`);
process.exit(process.exitCode || 0);
