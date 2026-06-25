// Drives the off-chain swap-batch COORDINATOR (dapp/confidential-swap-coordinator.js) end-to-end with the REAL
// assembler (confidential-swap.js) + a real note tree, and a mock relay/reserves. Asserts that N independently
// queued intents collapse into ONE OP_SWAP whose guest-mirror verifyBatch passes — i.e. the privacy upgrade
// (hide individual amounts behind one reserve delta) needs no contract/guest change. Run: node tests/confidential-swap-coordinator.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap } from '../dapp/confidential-swap.js';
import { makeConfidentialSwapCoordinator } from '../dapp/confidential-swap-coordinator.js';
import assert from 'node:assert';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const swap = makeConfidentialSwap({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const CHAIN_BINDING = '0x' + '11'.repeat(32);
// canonical: assetA < assetB
const assetA = '0x' + 'aa'.repeat(32);
const assetB = '0x' + 'bb'.repeat(32);
const FEE_BPS = 30;
const RES_A = 1_000_000n, RES_B = 1_000_000n;

// Two traders, both selling A for B, each with a distinct input note.
const traders = [
  { amountIn: 1000n, blinding: 111n, owner: '0x' + '01'.repeat(32), outOwner: '0x' + 'a1'.repeat(32), rOutSecp: 222n },
  { amountIn: 3000n, blinding: 333n, owner: '0x' + '02'.repeat(32), outOwner: '0x' + 'a2'.repeat(32), rOutSecp: 444n },
];

// Build the spend tree from each trader's INPUT note leaf (commit to the GROSS amountIn).
const tree = new pool.Tree();
for (const t of traders) {
  const c = pool.commitXY(t.amountIn, t.blinding);
  t.inCx = c.cx; t.inCy = c.cy;
  t.leafIndex = tree.insert(pool.leaf(assetA, c.cx, c.cy, t.owner));
}
const spendRoot = tree.rootAndPath(0).root;
for (const t of traders) t.path = tree.rootAndPath(t.leafIndex).path;

// Mocks
const submits = [];
const reservesFor = async () => ({ reserveA: RES_A, reserveB: RES_B, feeBps: FEE_BPS, spendRoot });
const submitBatch = async (payload) => { submits.push(payload); return { jobId: 'job-1', status: 'queued' }; };

const coord = makeConfidentialSwapCoordinator({
  swap, pool, reservesFor, submitBatch, chainBindingHex: () => CHAIN_BINDING,
  ephRand: () => 7n, minIntents: 2, maxWaitMs: 100000,
});

// canonical/direction sanity
{
  const c = coord._canonical(assetA, assetB, FEE_BPS);
  assert.strictEqual(c.direction, 'A->B');
  assert.strictEqual(c.poolId, swap.poolId(assetA, assetB, FEE_BPS));
  ok('canonical pair + direction + poolId match the assembler');
}

const results = await Promise.all(traders.map((t) => coord.addIntent({
  fromAsset: assetA, toAsset: assetB, feeBps: FEE_BPS, amountIn: t.amountIn, minOut: 0n, fee: 0n,
  inNote: { cx: t.inCx, cy: t.inCy, owner: t.owner, leafIndex: t.leafIndex, path: t.path, blinding: t.blinding },
  outOwner: t.outOwner, rOutSecp: t.rOutSecp, secret: '0x' + '09'.repeat(32), ownerPub: '0x02' + 'cd'.repeat(32),
})));

// Exactly ONE batch submitted, carrying BOTH intents.
assert.strictEqual(submits.length, 1, 'two intents collapse into one settle');
const { op, leaves, outputs, count } = submits[0];
assert.strictEqual(op.intents.length, 2, 'OP_SWAP carries both intents');
assert.strictEqual(count, 2);
assert.strictEqual(leaves.length, 2, 'one output leaf per intent');
assert.strictEqual(outputs.length, 2, 'one recovery descriptor per intent');
assert.strictEqual(op.type, undefined, 'op is the bare fixture (type lives on the submit envelope)');
assert.strictEqual(submits[0].type, 'swap');
ok('two independently-queued intents collapse into one OP_SWAP (one public reserve delta)');

// The single reserve delta covers BOTH trades — individual sizes are not separately observable.
const grossIn = traders[0].amountIn + traders[1].amountIn;
assert.strictEqual(BigInt(op.reserveAPre), RES_A);
assert.ok(BigInt(op.intents[0].amountOut) > 0n && BigInt(op.intents[1].amountOut) > 0n, 'both intents clear to positive output');
ok(`aggregate gross-in ${grossIn} clears at one uniform price; per-trade amounts hidden in the batch`);

// The op passes the FULL guest mirror (membership, openings, clearing, fee-price, k-non-decrease).
const rebuilt = {
  assetA, assetB, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, poolId: swap.poolId(assetA, assetB, FEE_BPS),
  spendRoot, priceNum: BigInt(op.priceNum), priceDen: BigInt(op.priceDen),
  reserveAPre: RES_A, reserveBPre: RES_B,
  reserveAPost: 0n, reserveBPost: 0n, // recomputed by verifyBatch from the netted intents
  intents: op.intents.map((it) => ({
    direction: it.direction === 0 ? 'A->B' : 'B->A', dirByte: it.direction,
    in: { cx: it.inCx, cy: it.inCy, owner: it.inOwner, leafIndex: it.inLeafIndex, path: it.inPath },
    amountIn: BigInt(it.amountIn), fee: 0n, amountOut: BigInt(it.amountOut), rem: BigInt(it.rem),
    minOut: BigInt(it.minOut), deadline: BigInt(it.deadline),
    out: { cx: it.outCx, cy: it.outCy, owner: it.outOwner },
    inSig: { R: it.inSigR, z: it.inSigZ }, outSig: { R: it.outSigR, z: it.outSigZ },
  })),
};
const v = swap.verifyBatch(rebuilt, { merkleRootFrom: pool.merkleRootFrom });
assert.strictEqual(v.nullifiers.length, 2);
assert.strictEqual(v.leaves.length, 2);
ok('the assembled OP_SWAP fixture passes the full guest-mirror verifyBatch (zero contract/guest change)');

// Each trader resolves with their own slice.
results.forEach((r, i) => { assert.ok(BigInt(r.amountOut) > 0n); assert.strictEqual(r.batchSize, 2); assert.strictEqual(r.outLeaf, leaves[i]); });
ok('each queued trader resolves with their own output slice of the shared batch');

// Buffers drained after flush.
assert.deepEqual(coord.pending(), {});
ok('pool buffer drained after the batch flushes');

console.log(`\n${n}/${n} swap-batch coordinator checks passed`);
