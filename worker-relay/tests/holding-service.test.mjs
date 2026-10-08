// The holding reward (src/lib/holding-*.js), driven with real proofs: a small pool's history gives the snapshot a proof is made
// against, a claim is checked against every public value before its proof, a verified claim is credited once, and with the flag
// off nothing runs. The proofs are DEVELOPMENT proofs from tests/fixtures/holding/fixture.json (made by
// dapp/circuits/evm-pool/holding-fixture.mjs).
//   node worker-relay/tests/holding-service.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex } from 'viem';
import * as snarkjs from 'snarkjs';
import { openStore } from '../src/lib/points-store.js';
import { loadHash } from '../src/lib/poseidon-hash.js';
import { DEFAULT_BUCKETS_WEI, ETH, DAY, FIELD_P, parseBuckets, bucketFor, snapshotTime, claimHashOf, claimableEpochs, holdingTxHash } from '../src/lib/holding-epoch.js';
import { poolStateAt, emptyRootOf, HoldingStateError } from '../src/lib/holding-state.js';
import { verifyHoldingClaim } from '../src/lib/holding-claims.js';
import { createHolding } from '../src/lib/holding-service.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/holding/fixture.json', import.meta.url), 'utf8'));
const hash = await loadHash();
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';

{
  assert.deepEqual(parseBuckets('0.01,0.1,1,3'), [ETH / 100n, ETH / 10n, ETH, 3n * ETH]);
  assert.deepEqual(parseBuckets('1, 0.5,1'), [ETH / 2n, ETH], 'sorted and without repeats');
  assert.deepEqual(parseBuckets(''), DEFAULT_BUCKETS_WEI);
  assert.throws(() => parseBuckets('one'));
  assert.equal(bucketFor(ETH * 3n / 2n, DEFAULT_BUCKETS_WEI), ETH, 'a note claims the largest size it holds');
  assert.equal(bucketFor(ETH / 200n, DEFAULT_BUCKETS_WEI), null, 'below the smallest size there is nothing to claim');
  assert.equal(bucketFor(100n * ETH, DEFAULT_BUCKETS_WEI), 3n * ETH);

  const rh = keccak256(toHex('a block hash'));
  const t = snapshotTime({ epoch: 20800, chainId: 1, randomHash: rh });
  assert.ok(t >= BigInt(20800 * DAY) && t < BigInt(20801 * DAY), 'the snapshot falls within its day');
  assert.equal(t, snapshotTime({ epoch: 20800, chainId: 1, randomHash: rh }), 'the same randomness draws the same moment');
  assert.notEqual(t, snapshotTime({ epoch: 20800, chainId: 8453, randomHash: rh }), 'each chain draws its own');
  assert.notEqual(t, snapshotTime({ epoch: 20800, chainId: 1, randomHash: keccak256(toHex('another')) }));
  const draws = new Set(Array.from({ length: 200 }, (_, i) => Number(snapshotTime({ epoch: 20800, chainId: 1, randomHash: keccak256(toHex(`b${i}`)) }) % BigInt(DAY)) >> 10));
  assert.ok(draws.size > 40, 'the draw is spread over the day');

  const a = '0x' + 'ab'.repeat(20);
  const ch = claimHashOf({ chainId: 1, epoch: 20800, claimAddress: a });
  assert.ok(ch > 0n && ch < FIELD_P);
  assert.equal(ch, claimHashOf({ chainId: 1, epoch: 20800, claimAddress: a.toUpperCase().replace('0X', '0x') }), 'the case of an address changes nothing');
  assert.notEqual(ch, claimHashOf({ chainId: 8453, epoch: 20800, claimAddress: a }));
  assert.notEqual(ch, claimHashOf({ chainId: 1, epoch: 20801, claimAddress: a }));
  assert.notEqual(ch, claimHashOf({ chainId: 1, epoch: 20800, claimAddress: '0x' + 'cd'.repeat(20) }));
  assert.match(holdingTxHash({ chainId: 1, epoch: 20800, retNf: 5n }), /^0x[0-9a-f]{64}$/);

  const now = (20800 + 1) * DAY + 5000;
  assert.deepEqual(claimableEpochs({ nowSec: now }), [20800, 20799], 'yesterday and the day before');
  assert.deepEqual(claimableEpochs({ nowSec: (20801) * DAY + 100 }), [20799, 20798], 'before the day has been over a while, it is not yet claimable');
  console.log('ok - sizes, the daily draw, what a claim is bound to and which days are open');
}

const snapshotOf = (e = fx.events) => poolStateAt({ events: e, block: 103, hash, emptyRoot: fx.emptyRoot });
{
  const s = snapshotOf();
  assert.equal(s.root, BigInt(fx.snapshot.root));
  assert.equal(s.nfRoot, BigInt(fx.snapshot.nfRoot));
  assert.equal(s.size, 8);
  assert.equal(s.nullifiers.length, 3);
  assert.equal(poolStateAt({ events: fx.events, block: 100, hash, emptyRoot: fx.emptyRoot }).size, 4, 'the state at an earlier block');
  assert.equal(poolStateAt({ events: [], block: 5, hash, emptyRoot: fx.emptyRoot }).root, BigInt(fx.emptyRoot), 'an empty pool is the empty tree');
  assert.equal(emptyRootOf(hash), BigInt(fx.emptyRoot));
  assert.throws(() => poolStateAt({ events: fx.events.filter((_, i) => i !== 1), block: 103, hash, emptyRoot: fx.emptyRoot }), HoldingStateError, 'an event missing from the read refuses the snapshot');
  console.log('ok - the pool\'s state at a snapshot block, and a gap in what was read is refused');
}

const vk = fx.vkey, buckets = DEFAULT_BUCKETS_WEI;
const snap = { root: fx.snapshot.root, nfRoot: fx.snapshot.nfRoot };
const good = (i = 0) => ({ chainId: fx.chainId, epoch: fx.epoch, claimAddress: fx.claims[i].claimAddress, proof: fx.claims[i].proof, publicSignals: fx.claims[i].publicSignals });
const verify = (claim, over = {}) => verifyHoldingClaim({ claim, snapshot: snap, buckets, poolAsset: BigInt(fx.poolAsset), vkey: vk, groth16: snarkjs.groth16, ...over });
{
  const ok = await verify(good());
  assert.equal(ok.ok, true, String(ok.reason));
  assert.equal(ok.bucketWei, ETH);
  assert.equal(ok.retNf, BigInt(fx.claims[0].publicSignals[6]));
  const other = await verify(good(1));
  assert.equal(other.retNf, ok.retNf, 'the tag is the note\'s for the day, whoever it pays');

  const withSignal = (i, v) => ({ ...good(), publicSignals: good().publicSignals.map((x, j) => (j === i ? String(v) : x)) });
  const reasons = [];
  for (const [i, why] of [[0, /note tree/], [1, /spent set/], [2, /asset/], [3, /this day/], [4, /size/], [5, /payout address/], [6, /proof does not verify/]]) {
    const r = await verify(withSignal(i, BigInt(good().publicSignals[i]) + 1n));
    assert.equal(r.ok, false); assert.match(r.reason, why, `signal ${i}: ${r.reason}`);
    reasons.push(r.reason);
  }
  assert.equal((await verify(withSignal(6, 0n))).reason, 'no tag');
  assert.match((await verify(withSignal(0, FIELD_P + 5n))).reason, /field element/);
  assert.match((await verify({ ...good(), claimAddress: '0x' + 'cd'.repeat(20) })).reason, /payout address/, 'a proof made for one address does not pay another');
  assert.match((await verify({ ...good(), chainId: 8453 })).reason, /payout address/, 'nor on another chain');
  assert.match((await verify(good(), { snapshot: { ...snap, root: '0x1' } })).reason, /note tree/, 'a root other than the one drawn');
  assert.match((await verify(good(), { buckets: [ETH * 2n] })).reason, /size/, 'a size that cannot be claimed');
  const swapped = { ...good(), proof: { ...good().proof, pi_a: good(1).proof.pi_c } };
  assert.equal((await verify(swapped)).ok, false, 'a proof that has been altered');
  assert.match((await verify({ ...good(), proof: { pi_a: ['x'] } })).reason, /could not be read|does not verify/);
  assert.match((await verify({ ...good(), publicSignals: ['1', '2'] })).reason, /seven/);
  assert.match((await verify({ ...good(), claimAddress: 'nobody' })).reason, /address/);
  assert.match((await verify(null)).reason, /whole numbers/);
  console.log('ok - a real proof is accepted; each public value, the payout binding and an altered proof are refused with their reason');
}

// A chain whose blocks come every 12 s with block 103 a thousand seconds before the day starts, so every snapshot of that day
// follows the pool's last event whatever the draw.
const dayStart = fx.epoch * DAY;
const ts = (n) => dayStart - 1000 + (n - 103) * 12;
const fakeClient = (extra = {}) => ({
  getBlockNumber: async () => 40000n,
  getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: BigInt(ts(Number(blockNumber))), hash: keccak256(toHex(`block ${blockNumber}`)) }),
  readContract: async ({ functionName, args }) => {
    if (functionName === 'everKnownRoot') return args[0].toLowerCase() === fx.snapshot.root.toLowerCase();
    if (functionName === 'rootSize') return BigInt(fx.snapshot.size);
    throw new Error(`unexpected read ${functionName}`);
  },
  ...extra,
});
const dir = mkdtempSync(join(tmpdir(), 'holding-'));
try {
  const store = openStore(join(dir, 'p.db'));
  let clock = (fx.epoch + 1) * DAY + 5000;
  const logs = [];
  const mk = (over = {}) => createHolding({
    store, hash, groth16: snarkjs.groth16, nowSec: () => clock, log: (m) => logs.push(m),
    clients: { 1: fakeClient() }, scan: async () => { store.saveHoldingEvents(1, fx.events); store.saveHoldingCursor(1, 39000); },
    cfg: { enabled: true, rate: 500, buckets, pool: POOL, poolAsset: BigInt(fx.poolAsset), vkey: vk, chains: [{ chainId: 1, deployBlock: 1 }], ...over },
  });
  const holding = mk();

  assert.deepEqual(holding.status().epochs.map((e) => e.epoch), [fx.epoch, fx.epoch - 1]);
  assert.deepEqual(holding.status().epochs[0].chains, [], 'before a snapshot is drawn there is nothing to prove against');
  assert.equal((await holding.claim(good())).status, 409, 'a claim before the snapshot is drawn is told so');

  clock = (fx.epoch + 1) * DAY + 100;
  await holding.cycle();
  assert.equal(store.holdingSnapshots(fx.epoch).length, 0, 'a day that has only just ended draws nothing until its randomness is final');
  clock = (fx.epoch + 1) * DAY + 5000;
  await holding.cycle();
  const [drawn] = store.holdingSnapshots(fx.epoch);
  assert.ok(drawn, logs.join('\n'));
  assert.equal(BigInt(drawn.root), BigInt(fx.snapshot.root));
  assert.equal(BigInt(drawn.nfRoot), BigInt(fx.snapshot.nfRoot));
  assert.deepEqual([drawn.size, drawn.nullifiers], [8, 3]);
  assert.ok(drawn.moment >= dayStart && drawn.moment < dayStart + DAY && ts(drawn.block) <= drawn.moment, 'drawn within the day, at the last block at or before the moment');
  const again = store.holdingSnapshots(fx.epoch)[0];
  await holding.cycle();
  assert.deepEqual(store.holdingSnapshots(fx.epoch)[0], again, 'the first snapshot drawn stands');
  const st = holding.status();
  assert.equal(st.epochs[0].chains[0].nfRoot, drawn.nfRoot);
  assert.equal(st.epochs[0].closesAt, (fx.epoch + 3) * DAY + 1800);
  const nf = holding.nullifiers(1, fx.epoch);
  assert.equal(nf.status, 200); assert.equal(nf.body.nullifiers.length, 3, 'the spent set a client builds its proof from');
  assert.equal(holding.nullifiers(1, fx.epoch + 5).status, 404);
  console.log('ok - a day\'s snapshot is drawn once it is final, from the events, and agrees with the pool\'s own root history');

  const r1 = await holding.claim(good(0));
  assert.deepEqual([r1.status, r1.body.credited, r1.body.points, r1.body.bucketWei], [200, true, 500, ETH.toString()], JSON.stringify(r1));
  const rows = store.depositsFor(good(0).claimAddress, 10);
  assert.deepEqual(rows.map((r) => [r.activity, r.amount_wei, r.points, r.chain_id]), [['holding', '0', 500, 1]]);
  assert.match(rows[0].tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(store.leaderboard(5).find((x) => x.address === good(0).claimAddress).points, 500);
  assert.equal((await holding.claim(good(0))).body.credited, false, 'sending the same claim again credits nothing more');
  const r2 = await holding.claim(good(1));
  assert.deepEqual([r2.status, r2.body.credited], [200, false], 'the same note cannot be claimed again for the day by naming another address');
  assert.equal(store.depositsFor(good(1).claimAddress, 10).length, 0);
  assert.equal((await holding.claim({ ...good(0), epoch: fx.epoch + 5 })).status, 409);
  assert.equal((await holding.claim({ ...good(0), chainId: 99 })).status, 400);
  const bad = await holding.claim({ ...good(1), publicSignals: good(1).publicSignals.map((x, j) => (j === 4 ? String(ETH * 5n) : x)) });
  assert.deepEqual([bad.status, bad.body.error], [422, 'not a size that can be claimed']);
  console.log('ok - a verified claim is credited once as points to the address it names; a replay, a second address and a bad claim are not');

  const jammed = mk({ maxPending: 0 });
  assert.equal((await jammed.claim(good(0))).status, 429, 'a full queue refuses a claim rather than line up proof checks');

  const off = mk({ enabled: false });
  await off.cycle();
  assert.deepEqual(off.status(), { enabled: false });
  assert.equal((await off.claim(good(0))).status, 404);
  assert.equal(off.nullifiers(1, fx.epoch).status, 404);
  console.log('ok - with the flag off nothing is read, drawn or credited');

  // A chain whose own root history does not know the rebuilt root draws nothing.
  const store2 = openStore(join(dir, 'q.db'));
  const wrong = createHolding({
    store: store2, hash, groth16: snarkjs.groth16, nowSec: () => clock, log: (m) => logs.push(m),
    clients: { 1: fakeClient({ readContract: async () => 7n }) }, scan: async () => { store2.saveHoldingEvents(1, fx.events); store2.saveHoldingCursor(1, 39000); },
    cfg: { enabled: true, rate: 500, buckets, pool: POOL, poolAsset: BigInt(fx.poolAsset), vkey: vk, chains: [{ chainId: 1, deployBlock: 1 }] },
  });
  await wrong.cycle();
  assert.equal(store2.holdingSnapshots(fx.epoch).length, 0);
  assert.match(logs.join('\n'), /is not one the pool held/);
  console.log('ok - a snapshot that disagrees with the pool\'s own root history is not drawn');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
