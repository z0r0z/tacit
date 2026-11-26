import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stuckRecycleCandidates, makeStuckRecycler, makeTacitWalletSwitch, applyReverseSalesToRecycling, findCpfpAnchor, buildCpfpBump } from '../fastbridge-lp/lib/stuck-recycle.mjs';

const A = '11'.repeat(32), T1 = '22'.repeat(32), T2 = '33'.repeat(32), REVPUB = '02' + '44'.repeat(32);
const memStore = () => { const m = new Map(); return { get: async (id) => m.get(id), put: async (r) => { m.set(r.id, { ...r }); }, list: async () => [...m.values()] }; };
const swap = (id, cls, txid = T1, amount = '2500000000') => ({
  id, phase: 'done', lineageClass: cls, take: { txid }, offer: { btc: { value: amount } },
});
const note = (txid = T1, amount = 2500000000n) => ({ utxo: { txid, vout: 0, value: 330, status: { confirmed: true } }, amount, blinding: 7n });
const recStore = (records) => { const m = new Map(records.map((r) => [r.id, { ...r }])); return { get: async (id) => m.get(id), put: async (r) => { m.set(r.id, { ...r }); }, list: async () => [...m.values()], map: m }; };
const mk = ({ records, scanNote = note(), statuses = {}, reverse = [], reserve = 0 }) => {
  const sent = [], scans = [];
  const tacit = {
    wallet: { priv: Uint8Array.of(1), pub: Uint8Array.of(2) },
    invalidateHoldingsCache() {},
    async scanHoldings() { scans.push(1); return new Map([[A, { utxos: scanNote ? [scanNote] : [] }]]); },
    async buildAndBroadcastCXferMulti(args) { sent.push(args); return { commitTxid: 'c'.repeat(64), revealTxid: T2 }; },
  };
  const store = memStore();
  const rec = makeStuckRecycler({
    tacit, withWallet: makeTacitWalletSwitch({ tacit }), mainPriv: Uint8Array.of(1), mainPub: Uint8Array.of(2), reversePubHex: REVPUB, assetIdHex: A,
    swaps: recStore(records), reverseSwaps: { list: async () => reverse }, store, btc: { status: async (txid) => ({ confirmations: statuses[txid] || 0 }) }, now: () => 100, satsChangeReserve: reserve,
  });
  return { rec, sent, scans, store };
};

test('stuck recycle candidates are only completed forward takes of long or pool-exit notes', () => {
  const cs = stuckRecycleCandidates([
    swap('long1', 'long'), swap('pool1', 'pool-exit', T2), swap('clean1', 'clean'), { ...swap('open', 'long'), phase: 'claimed' },
  ]);
  assert.deepEqual(cs.map((x) => [x.swapId, x.txid, x.vout, String(x.amount)]), [
    ['long1', T1, 0, '2500000000'], ['pool1', T2, 0, '2500000000'],
  ]);
});

test('first sighting is a dry run, then the exact take output is moved to the reverse key', async () => {
  const { rec, sent, scans } = mk({ records: [swap('s1', 'pool-exit')], reserve: 15000 });
  let r = await rec.tick();
  assert.equal(sent.length, 0);
  assert.equal(r.state.bySwap.s1.status, 'dry');
  r = await rec.tick();
  assert.equal(sent.length, 1);
  assert.equal(r.state.bySwap.s1.status, 'sent');
  assert.equal(sent[0].assetIdHex, A);
  assert.deepEqual(sent[0].recipients, [{ pubHex: REVPUB, amount: 2500000000n }]);
  assert.equal(sent[0].forceUtxos.length, 1);
  assert.equal(sent[0].forceUtxos[0].utxo.txid, T1);
  assert.equal(sent[0].forceUtxos[0].utxo.vout, 0);
  assert.equal(sent[0].satsChangeReserve, 15000);
  assert.ok(scans.length >= 2);
});

test('a sent move becomes done when its reveal confirms and is not sent again', async () => {
  const { rec, sent } = mk({ records: [swap('s1', 'long')], statuses: { [T2]: 2 } });
  await rec.tick();
  await rec.tick();
  const r = await rec.tick();
  assert.equal(r.state.bySwap.s1.status, 'done');
  assert.equal(sent.length, 1);
  await rec.tick();
  assert.equal(sent.length, 1);
});

test('clean proceeds are left at the main address', async () => {
  const { rec, sent, scans } = mk({ records: [swap('s1', 'clean')] });
  const r = await rec.tick();
  assert.equal(sent.length, 0);
  assert.equal(scans.length, 0);
  assert.deepEqual(r.state.bySwap, {});
});

test('a broadcast failure is recorded and not retried automatically', async () => {
  const { rec, sent } = mk({ records: [swap('s1', 'long')] });
  await rec.tick();
  await rec.tick();
  assert.equal(sent.length, 1);
  sent.length = 0;
  const failing = mk({ records: [swap('s2', 'long')] });
  failing.rec = makeStuckRecycler({
    tacit: {
      wallet: { priv: Uint8Array.of(1), pub: Uint8Array.of(2) }, invalidateHoldingsCache() {},
      async scanHoldings() { return new Map([[A, { utxos: [note()] }]]); },
      async buildAndBroadcastCXferMulti() { throw new Error('relay rejected'); },
    },
    withWallet: (priv, pub, fn) => fn(), mainPriv: Uint8Array.of(1), mainPub: Uint8Array.of(2), reversePubHex: REVPUB, assetIdHex: A,
    swaps: { list: async () => [swap('s2', 'long')] }, store: memStore(), btc: { status: async () => ({ confirmations: 0 }) },
  });
  await failing.rec.tick();
  const r = await failing.rec.tick();
  assert.equal(r.state.bySwap.s2.status, 'error');
  assert.match(r.state.bySwap.s2.error, /relay rejected/);
  const again = await failing.rec.tick();
  assert.equal(again.state.bySwap.s2.status, 'error');
});


test('cap release waits for a completed reverse sale of the exact recycled output', async () => {
  const forward = swap('s1', 'pool-exit');
  const store = recStore([forward]);
  const sent = [];
  const tacit = {
    wallet: { priv: Uint8Array.of(1), pub: Uint8Array.of(2) }, invalidateHoldingsCache() {},
    async scanHoldings() { return new Map([[A, { utxos: [note()] }]]); },
    async buildAndBroadcastCXferMulti(args) { sent.push(args); return { commitTxid: 'c'.repeat(64), revealTxid: T2 }; },
  };
  let revs = [];
  const rec = makeStuckRecycler({
    tacit, withWallet: (priv, pub, fn) => fn(), mainPriv: Uint8Array.of(1), mainPub: Uint8Array.of(2), reversePubHex: REVPUB, assetIdHex: A,
    swaps: store, reverseSwaps: { list: async () => revs }, store: memStore(), btc: { status: async () => ({ confirmations: 2 }) }, now: () => 100,
  });
  await rec.tick(); await rec.tick(); await rec.tick();
  const inInventory = await store.get('s1');
  assert.equal(inInventory.stuckInventoryAt, 100);
  assert.equal(inInventory.stuckRecoveredAt, undefined, 'inventory alone does not release the exposure cap');
  revs = [{ id: 'r1', phase: 'done', amount: '2500000000', noteInputs: [{ txid: T2, vout: 0 }] }];
  await rec.tick();
  const sold = await store.get('s1');
  assert.equal(sold.stuckRecoveredAt, 100);
  assert.equal(sold.stuckReverseSwapId, 'r1');
  revs = [{ id: 'r2', phase: 'done', noteInputs: [{ txid: T2, vout: 1 }] }];
  assert.equal((await store.get('s1')).stuckReverseSwapId, 'r1', 'a sale of another output is ignored');
});


test('partial reverse sales are followed through the change output, and mixed inputs are not guessed', () => {
  const state = { labels: { [`${T2}:0`]: { swapId: 's1', amount: '1000' } }, recovered: {}, processedReverse: {} };
  const first = applyReverseSalesToRecycling(state, [
    { id: 'ra', phase: 'done', amount: '400', lock: { txid: 'aa'.repeat(32) }, noteInputs: [{ txid: T2, vout: 0 }], updated: 1 },
  ]);
  assert.deepEqual(first, [{ reverseSwapId: 'ra', swapId: 's1', sold: '400', partial: true }]);
  assert.equal(state.recovered.s1, '400');
  assert.deepEqual(state.labels[`${'aa'.repeat(32)}:1`], { swapId: 's1', amount: '600' });
  const second = applyReverseSalesToRecycling(state, [
    { id: 'rb', phase: 'done', amount: '600', noteInputs: [{ txid: 'aa'.repeat(32), vout: 1 }], updated: 2 },
  ]);
  assert.equal(state.recovered.s1, '1000');
  assert.equal(second[0].partial, false);

  const mixed = { labels: { [`${T1}:0`]: { swapId: 's2', amount: '1000' } }, recovered: {}, processedReverse: {} };
  applyReverseSalesToRecycling(mixed, [
    { id: 'rc', phase: 'done', amount: '500', noteInputs: [{ txid: T1, vout: 0 }, { txid: 'ef'.repeat(32), vout: 2 }], updated: 3 },
  ]);
  assert.equal(mixed.recovered.s2, undefined, 'a sale with an untracked input is not attributed by guessing');
});


test('a stalled recycle transfer is CPFP-bumped from its reveal sats-change reserve without touching the note', async () => {
  const commit = 'c'.repeat(64), mainSpk = '0014' + '55'.repeat(20), reverseSpk = '0014' + '66'.repeat(20);
  const store = memStore();
  await store.put({ id: 'state', bySwap: { s1: { status: 'sent', at: 100, amount: '5000', txid: T1, vout: 0, commitTxid: commit, revealTxid: T2 } } });
  const broadcasts = [], signed = [];
  const btc = {
    status: async (txid) => ({ confirmations: 0 }),
    fetchTx: async (txid) => txid === commit ? { txid, vout: [{ value: 870, scriptpubkey: '5120' + '77'.repeat(32) }] } : { txid, vout: [{ value: 546, scriptpubkey: reverseSpk }, { value: 5000, scriptpubkey: mainSpk }] },
    outspend: async () => null,
    feeRate: async () => 2,
    broadcast: async (x) => broadcasts.push(x),
  };
  const rec = makeStuckRecycler({
    tacit: { wallet: {} }, withWallet: (priv, pub, fn) => fn(), mainPriv: Uint8Array.of(1), mainPub: Uint8Array.of(2), reversePubHex: REVPUB, assetIdHex: A,
    swaps: recStore([swap('s1', 'pool-exit')]), store, btc, now: () => 1000,
    cpfp: { enabled: true, afterSecs: 10, maxBumps: 2, maxFeeRate: 25, feeFactor: 2 }, mainSpk,
    sign: (tx, i, value) => { signed.push({ tx, i, value }); return ['sig', 'pub']; },
    serialize: () => 'aa', txidOf: () => 'b'.repeat(64),
  });
  const r = await rec.tick();
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].revealHex, 'aa');
  assert.equal(signed.length, 1);
  assert.equal(signed[0].tx.inputs[0].txid, T2);
  assert.equal(signed[0].tx.inputs[0].vout, 1);
  assert.equal(signed[0].tx.inputs[0].sequence, 0xfffffffd);
  assert.equal(signed[0].tx.outputs.length, 1);
  assert.equal(signed[0].tx.outputs[0].value, 4560); // 5000 - 110 vB × 4 sat/vB
  assert.equal(Buffer.from(signed[0].tx.outputs[0].script).toString('hex'), mainSpk);
  assert.equal(r.state.bySwap.s1.bumps, 1);
  assert.deepEqual(r.state.bySwap.s1.bumpTxids, ['b'.repeat(64)]);
  assert.equal(r.state.bySwap.s1.bumpWhy, undefined);
  assert.equal((await rec.info()).bumps, 1);
  assert.equal((await rec.info()).bumpBlocked, 0);
});



test('while the commit waits too, CPFP prefers the reveal reserve and prices the whole commit-reveal chain', async () => {
  const commit = 'c'.repeat(64), mainSpk = '0014' + '55'.repeat(20), reverseSpk = '0014' + '66'.repeat(20);
  const store = memStore();
  await store.put({ id: 'state', bySwap: { s1: { status: 'sent', at: 100, amount: '5000', txid: T1, vout: 0, commitTxid: commit, revealTxid: T2 } } });
  const signed = [];
  const commitTx = { txid: commit, weight: 440, fee: 220, vout: [{ value: 870, scriptpubkey: '5120' + '77'.repeat(32) }, { value: 20000, scriptpubkey: mainSpk }] };
  const revealTx = { txid: T2, weight: 800, fee: 400, vout: [{ value: 546, scriptpubkey: reverseSpk }, { value: 15000, scriptpubkey: mainSpk }] };
  const btc = {
    status: async () => ({ confirmations: 0 }),
    fetchTx: async (txid) => txid === commit ? commitTx : revealTx,
    outspend: async () => null,
    feeRate: async () => 2,
    broadcast: async () => {},
  };
  const rec = makeStuckRecycler({
    tacit: { wallet: {} }, withWallet: (priv, pub, fn) => fn(), mainPriv: Uint8Array.of(1), mainPub: Uint8Array.of(2), reversePubHex: REVPUB, assetIdHex: A,
    swaps: recStore([swap('s1', 'pool-exit')]), store, btc, now: () => 1000,
    cpfp: { enabled: true, afterSecs: 10, maxBumps: 2, maxFeeRate: 25, feeFactor: 2 }, mainSpk,
    sign: (tx, i, value) => { signed.push({ tx, i, value }); return ['sig', 'pub']; },
    serialize: () => 'aa', txidOf: () => 'b'.repeat(64),
  });
  const r = await rec.tick();
  assert.equal(signed[0].tx.inputs[0].txid, T2, 'the reveal reserve is used, so the child descends from the whole chain');
  assert.equal(signed[0].tx.inputs[0].vout, 1);
  assert.equal(signed[0].tx.outputs[0].value, 13940); // parents 310 vB/620 sats + 110-vB child at 4 sat/vB: 1060 fee
  assert.equal(r.state.bySwap.s1.bumps, 1);
});

test('after the commit confirms, CPFP uses the reveal reserve; without one it says why instead of guessing', async () => {
  const commit = 'c'.repeat(64), mainSpk = '0014' + '55'.repeat(20), reverseSpk = '0014' + '66'.repeat(20);
  const mkstall = async (revealOutputs) => {
    const store = memStore();
    await store.put({ id: 'state', bySwap: { s1: { status: 'sent', at: 100, amount: '5000', txid: T1, vout: 0, commitTxid: commit, revealTxid: T2 } } });
    const broadcasts = [], signed = [];
    const btc = {
      status: async (txid) => ({ confirmations: txid === commit ? 1 : 0 }),
      fetchTx: async (txid) => ({ txid, vout: txid === T2 ? revealOutputs : [{ value: 5000, scriptpubkey: mainSpk }] }),
      outspend: async () => null,
      feeRate: async () => 2,
      broadcast: async (x) => broadcasts.push(x),
    };
    const rec = makeStuckRecycler({
      tacit: { wallet: {} }, withWallet: (priv, pub, fn) => fn(), mainPriv: Uint8Array.of(1), mainPub: Uint8Array.of(2), reversePubHex: REVPUB, assetIdHex: A,
      swaps: recStore([swap('s1', 'pool-exit')]), store, btc, now: () => 1000,
      cpfp: { enabled: true, afterSecs: 10, maxBumps: 2, maxFeeRate: 25, feeFactor: 2 }, mainSpk,
      sign: (tx, i, value) => { signed.push({ tx, i, value }); return ['sig', 'pub']; },
      serialize: () => 'aa', txidOf: () => 'b'.repeat(64),
    });
    return { rec, broadcasts, signed };
  };
  const yes = await mkstall([{ value: 546, scriptpubkey: reverseSpk }, { value: 5000, scriptpubkey: mainSpk }]);
  const r1 = await yes.rec.tick();
  assert.equal(yes.signed[0].tx.inputs[0].txid, T2, 'the reveal reserve is spent after the commit confirms');
  assert.equal(yes.signed[0].tx.inputs[0].vout, 1);
  assert.equal(r1.state.bySwap.s1.bumps, 1);

  const no = await mkstall([{ value: 546, scriptpubkey: reverseSpk }]);
  const r2 = await no.rec.tick();
  assert.equal(no.broadcasts.length, 0);
  assert.match(r2.state.bySwap.s1.bumpWhy, /no spendable sats-change/);
  assert.equal((await no.rec.info()).bumpBlocked, 1);
});

test('CPFP helpers find only main-key sats change and preserve dust', () => {
  const mainSpk = '0014' + '55'.repeat(20);
  const tx = { txid: T1, vout: [{ value: 546, scriptpubkey: '0014' + '66'.repeat(20) }, { value: 5000, scriptpubkey: mainSpk }] };
  assert.deepEqual(findCpfpAnchor(tx, mainSpk), { txid: T1, vout: 1, value: 5000 });
  assert.equal(findCpfpAnchor({ txid: T1, vout: [{ value: 546, scriptpubkey: mainSpk }] }, mainSpk), null, 'dust itself cannot pay a bump');
  const child = buildCpfpBump({ anchor: findCpfpAnchor(tx, mainSpk), rate: 4, mainSpkHex: mainSpk, sign: () => ['sig', 'pub'] });
  assert.equal(child.fee, 440);
  assert.equal(child.out, 4560);
  assert.throws(() => buildCpfpBump({ anchor: { txid: T1, vout: 1, value: 900 }, rate: 4, mainSpkHex: mainSpk, sign: () => [] }), /cannot pay/);
  const parent = { weight: 440, fee: 220 }; // a 110-vB parent that paid only 2 sat/vB
  const packaged = buildCpfpBump({ anchor: findCpfpAnchor(tx, mainSpk), rate: 4, mainSpkHex: mainSpk, sign: () => ['sig', 'pub'], parent });
  assert.equal(packaged.fee, 660, 'the child pays the parent shortfall so the package reaches 4 sat/vB');
  assert.equal(packaged.out, 4340);
});


test('the production multi-transfer source keeps the CPFP reserve in the reveal change calculation', () => {
  // The live signet rehearsal is the end-to-end check; this source guard keeps the optional argument from being silently
  // dropped or applied to a different commit/reveal builder again.
  const src = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function _buildAndBroadcastCXferMulti');
  assert.ok(start >= 0);
  const body = src.slice(start, start + 25000);
  for (const needle of ['satsChangeReserve = 0', 'const reserveSats = Math.floor(Number(satsChangeReserve))', 'commitValue += reserveSats', 'satsChange += reserveSats', 'if (satsChange >= DUST) revealOutputs.push']) assert.ok(body.includes(needle), needle);
  assert.ok(body.indexOf('commitValue += reserveSats') < body.indexOf('const revealOutputs'), 'the reserve is added before the reveal outputs are built');
});
