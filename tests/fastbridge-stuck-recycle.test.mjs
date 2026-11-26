import test from 'node:test';
import assert from 'node:assert/strict';
import { stuckRecycleCandidates, makeStuckRecycler, makeTacitWalletSwitch } from '../fastbridge-lp/lib/stuck-recycle.mjs';

const A = '11'.repeat(32), T1 = '22'.repeat(32), T2 = '33'.repeat(32), REVPUB = '02' + '44'.repeat(32);
const memStore = () => { const m = new Map(); return { get: async (id) => m.get(id), put: async (r) => { m.set(r.id, { ...r }); }, list: async () => [...m.values()] }; };
const swap = (id, cls, txid = T1, amount = '2500000000') => ({
  id, phase: 'done', lineageClass: cls, take: { txid }, offer: { btc: { value: amount } },
});
const note = (txid = T1, amount = 2500000000n) => ({ utxo: { txid, vout: 0, value: 330, status: { confirmed: true } }, amount, blinding: 7n });
const mk = ({ records, scanNote = note(), statuses = {} }) => {
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
    swaps: { list: async () => records }, store, btc: { status: async (txid) => ({ confirmations: statuses[txid] || 0 }) }, now: () => 100,
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
  const { rec, sent, scans } = mk({ records: [swap('s1', 'pool-exit')] });
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
