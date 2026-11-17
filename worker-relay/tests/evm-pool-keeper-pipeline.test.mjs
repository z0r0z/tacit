// The keeper's queue of insertions (src/lib/evm-pool-keeper-pipeline.js) against a mock chain with a real tree.
//   node worker-relay/tests/evm-pool-keeper-pipeline.test.mjs

import assert from 'node:assert/strict';
import { makePipeline, PipelineError } from '../src/lib/evm-pool-keeper-pipeline.js';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';
import { extDataHash } from '../../dapp/evm-pool-zk.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const zk = await loadZk();

const CHAIN_ID = 8453, POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', KEEPER = '0x00000000000000000000000000000000000000Ab';
const ZERO = '0x0000000000000000000000000000000000000000';
const ASSET = 777n;

function mockChain() {
  const c = { leaves: [1n, 2n, 3n, 4n], spentSet: new Set() };
  c.tree = () => { const t = zk.incTree(); t.append(c.leaves); return t; };
  c.known = new Set([c.tree().root]);
  c.poolState = async () => { const t = c.tree(); return { root: t.root, nextIndex: BigInt(t.size) }; };
  c.knownRoot = async (r) => c.known.has(BigInt(r));
  c.spent = async (nfs) => nfs.map((x) => c.spentSet.has(BigInt(x)));
  c.land = (pair, nfs = []) => { c.leaves.push(...pair); c.known.add(c.tree().root); for (const x of nfs) c.spentSet.add(BigInt(x)); };
  return c;
}
// A relayed transfer filling `slot`, spending nfs, correctly bound.
function txFor(slot, { outLeaf, nfs = [], fee = 5n, memo0 = '0xaa' }) {
  const eh = extDataHash({ chainId: BigInt(CHAIN_ID), pool: POOL, recipient: ZERO, extAmount: 0n, relayer: KEEPER, fee, memo0: Buffer.from(memo0.slice(2), 'hex'), memo1: new Uint8Array() });
  const o = BigInt(slot.oldRoot);
  return {
    pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n],
    publicInputs: [o, o, BigInt(slot.newRoot), BigInt(slot.start), 0n, eh, ASSET, nfs[0] ?? 900n + BigInt(slot.start), nfs[1] ?? 0n, outLeaf[0], outLeaf[1]],
    recipient: ZERO, extAmount: 0n, relayer: KEEPER, fee, memo0, memo1: '0x',
  };
}
function setup(over = {}) {
  const chain = mockChain();
  let ok = true, t = 0;
  const p = makePipeline({ chain, verify: async () => ok, assetField: ASSET, baseTree: async () => ({ tree: chain.tree(), root: chain.tree().root }), maxDepth: 4, now: () => t, reserveMs: 1000, ...over });
  const sends = [];
  const sender = (tag) => async ({ simulate }) => { sends.push({ tag, simulate }); return `0x${tag}`; };
  return { chain, p, sends, sender, setVerify: (v) => { ok = v; }, advance: (ms) => { t += ms; } };
}
const opts = { chainId: CHAIN_ID, pool: POOL };
const code = (status, st) => (e) => e instanceof PipelineError && e.status === status && (st === undefined || !!e.stale === st);
// A client's view: the pool at the slot's base, plus the leaves queued ahead, must reach the slot's oldRoot.
const clientRoot = (chain, slot) => { const t = zk.incTree(); t.append(chain.leaves); t.append(slot.pending.flatMap((x) => [BigInt(x.outLeaf0), BigInt(x.outLeaf1)])); return { root: t.root, size: t.size }; };

await test('slots line up: each proves from the root the slots ahead end at, and clients can rebuild it', async () => {
  const { p, chain } = setup();
  const a = await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  const b = await p.reserve({ outLeaf: [13n, 14n], nfs: [2n] });
  const c = await p.reserve({ outLeaf: [15n, 0n], nfs: [3n] });
  assert.deepEqual([a.start, b.start, c.start], ['4', '6', '8']);
  assert.equal(b.oldRoot, a.newRoot);
  assert.equal(c.oldRoot, b.newRoot);
  for (const s of [a, b, c]) {
    const v = clientRoot(chain, s);
    assert.equal(v.root.toString(), s.oldRoot);
    assert.equal(String(v.size), s.start);
  }
  p.stop();
});

await test('proofs for later slots wait for earlier ones, then all go in order; only the front is simulated', async () => {
  const { p, sends, sender } = setup();
  const a = await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  const b = await p.reserve({ outLeaf: [13n, 14n], nfs: [2n] });
  const pb = p.fulfil(b.id, txFor(b, { outLeaf: [13n, 14n], nfs: [2n] }), sender('b'), opts);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sends.length, 0, 'b waits for a');
  const ha = await p.fulfil(a.id, txFor(a, { outLeaf: [11n, 12n], nfs: [1n] }), sender('a'), opts);
  assert.equal(ha, '0xa');
  assert.equal(await pb, '0xb');
  assert.deepEqual(sends, [{ tag: 'a', simulate: true }, { tag: 'b', simulate: false }]);
  p.stop();
});

await test('a proof is checked against its slot, its transaction and the ceremony key', async () => {
  const { p, sender, setVerify } = setup();
  const a = await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  const good = txFor(a, { outLeaf: [11n, 12n], nfs: [1n] });
  await assert.rejects(p.fulfil(a.id, txFor(a, { outLeaf: [11n, 99n], nfs: [1n] }), sender('x'), opts), code(409, true), 'other leaves');
  await assert.rejects(p.fulfil(a.id, txFor(a, { outLeaf: [11n, 12n], nfs: [5n] }), sender('x'), opts), code(400), 'other notes');
  await assert.rejects(p.fulfil(a.id, { ...good, fee: 6n }, sender('x'), opts), code(400), 'fee not the proven one');
  await assert.rejects(p.fulfil(a.id, { ...good, publicInputs: good.publicInputs.map((x, i) => (i === 6 ? 1n : x)) }, sender('x'), opts), code(400), 'asset');
  setVerify(false);
  await assert.rejects(p.fulfil(a.id, good, sender('x'), opts), code(400), 'proof');
  setVerify(true);
  assert.equal(await p.fulfil(a.id, good, sender('a'), opts), '0xa');
  await assert.rejects(p.fulfil(a.id, good, sender('a'), opts), code(409, true), 'a slot is filled once');
  p.stop();
});

await test('a slot never fulfilled is cut in time, with the slots behind it; waiting proofs are told to redo', async () => {
  const { p, sender, advance } = setup();
  const a = await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  const b = await p.reserve({ outLeaf: [13n, 14n], nfs: [2n] });
  const pb = p.fulfil(b.id, txFor(b, { outLeaf: [13n, 14n], nfs: [2n] }), sender('b'), opts);
  advance(2000);
  const h = await p.head();
  assert.deepEqual(h.pending, []);
  await assert.rejects(pb, code(409, true));
  await assert.rejects(p.fulfil(a.id, txFor(a, { outLeaf: [11n, 12n], nfs: [1n] }), sender('a'), opts), code(409, true));
  p.stop();
});

await test('cancelling a slot cuts it and everything behind', async () => {
  const { p } = setup();
  const a = await p.reserve({ outLeaf: [11n, 12n] });
  await p.reserve({ outLeaf: [13n, 14n] });
  await p.cancel(a.id);
  assert.equal(p.size(), 0);
  p.stop();
});

await test('a slot sent and never landed is cut after staleMs (default 200 s), and its notes can be sent again', async () => {
  const { p, sender, advance } = setup({ reserveMs: 10_000_000 });
  const a = await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  assert.equal(await p.fulfil(a.id, txFor(a, { outLeaf: [11n, 12n], nfs: [1n] }), sender('a'), opts), '0xa');
  advance(190_000);
  await assert.rejects(p.reserve({ outLeaf: [21n, 22n], nfs: [1n] }), code(409, true), 'its notes are held at 190 s, while it may still land');
  advance(20_000);
  assert.equal((await p.head()).pending.length, 0, 'cut at 210 s');
  const b = await p.reserve({ outLeaf: [21n, 22n], nfs: [1n] });
  assert.equal(b.start, '4', 'the same notes are sent again from the pool\'s head');
  p.stop();
});

await test('landed slots leave the queue; another sender landing first drops it', async () => {
  const { p, chain, sender } = setup();
  const a = await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  const b = await p.reserve({ outLeaf: [13n, 14n], nfs: [2n] });
  await p.fulfil(a.id, txFor(a, { outLeaf: [11n, 12n], nfs: [1n] }), sender('a'), opts);
  chain.land([11n, 12n], [1n]);
  let h = await p.head();
  assert.equal(h.pending.length, 1);
  assert.equal(h.root, a.newRoot);
  chain.land([77n, 78n]);
  h = await p.head();
  assert.deepEqual(h.pending, []);
  await assert.rejects(p.fulfil(b.id, txFor(b, { outLeaf: [13n, 14n], nfs: [2n] }), sender('b'), opts), code(409, true));
  p.stop();
});

await test('an unreserved relay takes the tail it was proven against; front-only waits for an empty queue', async () => {
  const { p, sender } = setup();
  const h0 = await p.head();
  const slot0 = { oldRoot: h0.tail.root, start: h0.tail.size, newRoot: null };
  // Its newRoot is what the pipeline computes for these leaves at the tail.
  const r = await p.reserve({ outLeaf: [21n, 22n] });
  await p.cancel(r.id);
  slot0.newRoot = r.newRoot;
  assert.equal(await p.append(txFor(slot0, { outLeaf: [21n, 22n] }), sender('u'), opts), '0xu');
  await assert.rejects(p.append(txFor(slot0, { outLeaf: [21n, 22n] }), sender('u'), opts), code(409, true), 'the tail moved');
  const s = await p.reserve({ outLeaf: [23n, 24n] });
  await assert.rejects(p.append(txFor({ oldRoot: s.newRoot, start: '8', newRoot: '1' }, { outLeaf: [25n, 26n] }), sender('w'), { ...opts, front: true }), code(429));
  p.stop();
});

await test('double spends and a full queue are refused at reservation; concurrent reservations get distinct slots', async () => {
  const { p, chain } = setup();
  await p.reserve({ outLeaf: [11n, 12n], nfs: [1n] });
  await assert.rejects(p.reserve({ outLeaf: [13n, 14n], nfs: [1n] }), code(409, true));
  chain.spentSet.add(9n);
  await assert.rejects(p.reserve({ outLeaf: [13n, 14n], nfs: [9n] }), code(400));
  const [x, y] = await Promise.all([p.reserve({ outLeaf: [31n, 32n] }), p.reserve({ outLeaf: [33n, 34n] })]);
  assert.notEqual(x.start, y.start);
  await p.reserve({ outLeaf: [35n, 36n] });
  await assert.rejects(p.reserve({ outLeaf: [37n, 38n] }), code(429));
  p.stop();
});

await test('one requester holds at most two open slots', async () => {
  const { p } = setup({ maxDepth: 10 });
  await p.reserve({ outLeaf: [11n, 12n], owner: 'ip1' });
  await p.reserve({ outLeaf: [13n, 14n], owner: 'ip1' });
  await assert.rejects(p.reserve({ outLeaf: [15n, 16n], owner: 'ip1' }), code(429));
  await p.reserve({ outLeaf: [15n, 16n], owner: 'ip2' });
  p.stop();
});

await test('a requester whose unused slot cost others their place may not reserve again for a while; others, and a harmless lapse, are unaffected', async () => {
  const { p, advance } = setup({ maxDepth: 10, pauseMs: 5000 });
  await p.reserve({ outLeaf: [11n, 12n], owner: 'ip1' });
  await p.reserve({ outLeaf: [13n, 14n], owner: 'ip2' });
  advance(2000);
  assert.deepEqual((await p.head()).pending, [], 'the lapsed slot took the one behind it');
  await assert.rejects(p.reserve({ outLeaf: [15n, 16n], owner: 'ip1' }), code(403), 'ip1 is paused');
  await p.reserve({ outLeaf: [15n, 16n], owner: 'ip2' });
  await p.cancel((await p.reserve({ outLeaf: [17n, 18n], owner: 'ip3' })).id);
  await p.reserve({ outLeaf: [19n, 20n], owner: 'ip3' });
  advance(6000);
  await p.reserve({ outLeaf: [21n, 22n], owner: 'ip1' });
  assert.equal(p.size(), 1, 'ip1 reserves again once the pause is over (the older slots lapsed meanwhile)');
  p.stop();
});

await test('giving up a slot with others behind it pauses its owner too', async () => {
  const { p } = setup({ maxDepth: 10, pauseMs: 5000 });
  const a = await p.reserve({ outLeaf: [11n, 12n], owner: 'ip1' });
  await p.reserve({ outLeaf: [13n, 14n], owner: 'ip2' });
  await p.cancel(a.id);
  await assert.rejects(p.reserve({ outLeaf: [15n, 16n], owner: 'ip1' }), code(403));
  p.stop();
});

console.log(`\n${n} passed`);
process.exit(0);
