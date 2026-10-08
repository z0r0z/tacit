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
import { DEFAULT_BUCKETS_WEI, ETH, DAY, FIELD_P, parseBuckets, bucketFor, snapshotTime, randomnessOf, claimHashOf, claimableEpochs, holdingTxHash } from '../src/lib/holding-epoch.js';
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

  const mixes = Array.from({ length: 32 }, (_, i) => keccak256(toHex(`mix ${i}`)));
  assert.equal(randomnessOf(mixes), randomnessOf([...mixes]), 'the same blocks draw the same randomness');
  for (const i of [0, 15, 31]) assert.notEqual(randomnessOf(mixes), randomnessOf(mixes.map((m, j) => (j === i ? keccak256(toHex('other')) : m))), `block ${i} of 32 matters`);
  assert.throws(() => randomnessOf([]));

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

const fx0 = fx.scenarios[0], fx1 = fx.scenarios[1];
const snapshotOf = (e = fx0.events) => poolStateAt({ events: e, block: fx0.snapshot.block, hash, emptyRoot: fx0.emptyRoot });
{
  const s = snapshotOf();
  assert.equal(s.root, BigInt(fx0.snapshot.root));
  assert.equal(s.nfRoot, BigInt(fx0.snapshot.nfRoot));
  assert.equal(s.size, 10);
  assert.equal(s.nullifiers.length, 3);
  assert.equal(poolStateAt({ events: fx0.events, block: fx0.snapshot.block, hash, emptyRoot: fx0.emptyRoot, nfRoot: false }).nfRoot, null, 'the costly spent-set root is optional');
  assert.equal(poolStateAt({ events: fx0.events, block: 100, hash, emptyRoot: fx0.emptyRoot }).size, 4, 'the state at an earlier block');
  assert.equal(poolStateAt({ events: [], block: 5, hash, emptyRoot: fx0.emptyRoot }).root, BigInt(fx0.emptyRoot), 'an empty pool is the empty tree');
  assert.equal(emptyRootOf(hash), BigInt(fx0.emptyRoot));
  assert.throws(() => poolStateAt({ events: fx0.events.filter((_, i) => i !== 1), block: fx0.snapshot.block, hash, emptyRoot: fx0.emptyRoot }), HoldingStateError, 'an event missing from the read refuses the snapshot');
  assert.notEqual(fx0.poolAsset, fx1.poolAsset, 'the two chains\' pools commit under different assets, as the real ones do');
  console.log('ok - the pool\'s state at a snapshot block, and a gap in what was read is refused');
}

const vk = fx.vkey, buckets = DEFAULT_BUCKETS_WEI;
const snap = { root: fx0.snapshot.root, nfRoot: fx0.snapshot.nfRoot };
const claimOf = (sc, i = 0) => ({ chainId: sc.chainId, epoch: fx.epoch, claimAddress: sc.claims[i].claimAddress, proof: sc.claims[i].proof, publicSignals: sc.claims[i].publicSignals });
const good = (i = 0) => claimOf(fx0, i);
const verify = (claim, over = {}) => verifyHoldingClaim({ claim, snapshot: snap, buckets, poolAsset: BigInt(fx0.poolAsset), vkey: vk, groth16: snarkjs.groth16, ...over });
{
  const ok = await verify(good());
  assert.equal(ok.ok, true, String(ok.reason));
  assert.equal(ok.bucketWei, ETH);
  assert.equal(ok.retNf, BigInt(fx0.claims[0].publicSignals[6]));
  const other = await verify(good(1));
  assert.equal(other.retNf, ok.retNf, 'the tag is the note\'s for the day, whoever it pays');

  const withSignal = (i, v) => ({ ...good(), publicSignals: good().publicSignals.map((x, j) => (j === i ? String(v) : x)) });
  for (const [i, why] of [[0, /note tree/], [1, /spent set/], [2, /asset/], [3, /this day/], [4, /size/], [5, /payout address/], [6, /proof does not verify/]]) {
    const r = await verify(withSignal(i, BigInt(good().publicSignals[i]) + 1n));
    assert.equal(r.ok, false); assert.match(r.reason, why, `signal ${i}: ${r.reason}`);
  }
  assert.equal((await verify(withSignal(6, 0n))).reason, 'no tag');
  assert.match((await verify(withSignal(0, FIELD_P + 5n))).reason, /field element/);
  assert.match((await verify({ ...good(), claimAddress: '0x' + 'cd'.repeat(20) })).reason, /payout address/, 'a proof made for one address does not pay another');
  assert.match((await verify({ ...good(), chainId: 8453 })).reason, /payout address/, 'nor on another chain');
  assert.match((await verify(good(), { poolAsset: BigInt(fx1.poolAsset) })).reason, /asset/, 'a note of one chain\'s pool is not another\'s');
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

// Each chain has its own clock and heads. Chain 1 doubles as Ethereum for the day's randomness: its blocks come every 12 s with
// the pool's last event a thousand seconds before the day starts; the other chain's come every 2 s. Every snapshot of the day
// therefore follows the pool's last event whatever the draw.
const dayStart = fx.epoch * DAY;
const CHAIN = {
  1: { sc: fx0, head: 40000, cursor: 39900, ts: (n) => dayStart - 1000 + (n - fx0.snapshot.block) * 12 },
  8453: { sc: fx1, head: 90000, cursor: 89900, ts: (n) => dayStart - 1000 + (n - fx1.snapshot.block) * 2 },
};
const mixOf = (n, salt = '') => keccak256(toHex(`mix ${n}${salt}`));
const fakeClient = (chainId, extra = {}) => {
  const { sc, head, ts } = CHAIN[chainId];
  const last = sc.events[sc.events.length - 1];
  return {
    getBlockNumber: async () => BigInt(head),
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: BigInt(ts(Number(blockNumber))), hash: keccak256(toHex(`block ${blockNumber}`)), mixHash: mixOf(blockNumber) }),
    readContract: async ({ functionName, args }) => {
      if (functionName === 'everKnownRoot') return args[0].toLowerCase() === sc.snapshot.root.toLowerCase();
      if (functionName === 'rootSize') return BigInt(sc.snapshot.size);
      if (functionName === 'root') return last.newRoot;
      if (functionName === 'nextIndex') return BigInt(sc.snapshot.size);
      if (functionName === 'ASSET_FIELD') return BigInt(sc.poolAsset);
      throw new Error(`unexpected read ${functionName}`);
    },
    ...extra,
  };
};
const bothClients = (over = {}) => ({ 1: fakeClient(1, over[1]), 8453: fakeClient(8453, over[8453]) });
// A scan that finds `events(chainId)` already on the chain and reads it all, as far as the chain's cursor.
const scanOf = (store, events = (chainId) => CHAIN[chainId].sc.events) => async ({ chainId }) => { store.saveHoldingEvents(chainId, events(chainId)); store.saveHoldingCursor(chainId, CHAIN[chainId].cursor); };

const dir = mkdtempSync(join(tmpdir(), 'holding-'));
try {
  const store = openStore(join(dir, 'p.db'));
  let clock = (fx.epoch + 1) * DAY + 5000;
  const logs = [];
  const counting = { verifies: 0, verify: async (...a) => { counting.verifies += 1; return snarkjs.groth16.verify(...a); } };
  const mk = (over = {}, st = store, clients = bothClients()) => createHolding({
    store: st, hash, groth16: counting, nowSec: () => clock, log: (m) => logs.push(m), clients, scan: scanOf(st),
    cfg: { enabled: true, rate: 500, buckets, pool: POOL, vkey: vk, chains: [{ chainId: 1, deployBlock: 1 }, { chainId: 8453, deployBlock: 1 }], ...over },
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
  const drawnAll = store.holdingSnapshots(fx.epoch);
  assert.deepEqual(drawnAll.map((d) => d.chainId), [1, 8453], logs.join('\n'));
  for (const d of drawnAll) {
    const sc = CHAIN[d.chainId].sc;
    assert.equal(BigInt(d.root), BigInt(sc.snapshot.root));
    assert.equal(BigInt(d.nfRoot), BigInt(sc.snapshot.nfRoot));
    assert.deepEqual([d.size, d.nullifiers], [10, 3]);
    assert.ok(d.moment >= dayStart && d.moment < dayStart + DAY && CHAIN[d.chainId].ts(d.block) <= d.moment, 'drawn within the day, at the last block at or before the moment');
    assert.equal(store.loadHoldingVerified(d.chainId), CHAIN[d.chainId].cursor, 'the events were checked whole against the pool before a snapshot was drawn');
  }
  assert.notEqual(drawnAll[0].moment, drawnAll[1].moment, 'each chain draws its own moment');
  const again = store.holdingSnapshots(fx.epoch);
  await holding.cycle();
  assert.deepEqual(store.holdingSnapshots(fx.epoch), again, 'the first snapshot drawn stands');
  const st = holding.status();
  assert.equal(st.epochs[0].chains[0].nfRoot, drawnAll[0].nfRoot);
  assert.deepEqual(st.assets, { 1: fx0.poolAsset, 8453: fx1.poolAsset }, 'each pool\'s asset, read from the pool');
  assert.equal(st.epochs[0].closesAt, (fx.epoch + 3) * DAY + 1800);
  const nf = holding.nullifiers(1, fx.epoch);
  assert.equal(nf.status, 200); assert.equal(nf.body.nullifiers.length, 3, 'the spent set a client builds its proof from');
  assert.equal(holding.nullifiers(1, fx.epoch).body, nf.body, 'built once for a snapshot that never changes');
  assert.equal(holding.nullifiers(1, fx.epoch + 5).status, 404);
  console.log('ok - each chain\'s snapshot is drawn once the day is final, from events checked whole against the pool, with the pool\'s own asset');

  // The draw depends on every one of the 32 blocks it is made from, and on no block hash.
  const t0 = (fx.epoch + 1) * DAY + 1800;
  const lastL1 = fx0.snapshot.block + Math.floor((t0 - (dayStart - 1000)) / 12);
  const momentWith = async (clientOver) => {
    const st2 = openStore(join(dir, `m${Math.random()}.db`));
    const h2 = mk({}, st2, bothClients({ 1: clientOver }));
    await h2.cycle();
    return store.db && st2.holdingSnapshots(fx.epoch)[0]?.moment;
  };
  const baseline = await momentWith({});
  assert.equal(baseline, drawnAll[0].moment);
  const reHashed = await momentWith({ getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: BigInt(CHAIN[1].ts(Number(blockNumber))), hash: keccak256(toHex('another hash')), mixHash: mixOf(blockNumber) }) });
  assert.equal(reHashed, baseline, 'a block hash, which its proposer can vary, does not enter the draw');
  for (const n of [lastL1, lastL1 - 16, lastL1 - 31]) {
    const changed = await momentWith({ getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: BigInt(CHAIN[1].ts(Number(blockNumber))), hash: keccak256(toHex(`block ${blockNumber}`)), mixHash: Number(blockNumber) === n ? mixOf(n, 'x') : mixOf(blockNumber) }) });
    assert.notEqual(changed, baseline, `the randomness of block ${n} (${lastL1 - n} before the last) is part of the draw`);
  }
  const outside = await momentWith({ getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: BigInt(CHAIN[1].ts(Number(blockNumber))), hash: keccak256(toHex(`block ${blockNumber}`)), mixHash: Number(blockNumber) === lastL1 - 32 ? mixOf(1, 'x') : mixOf(blockNumber) }) });
  assert.equal(outside, baseline, 'a block before those 32 is not');
  const noRandao = openStore(join(dir, 'nr.db'));
  const hNo = mk({}, noRandao, bothClients({ 1: { getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: BigInt(CHAIN[1].ts(Number(blockNumber))), hash: keccak256(toHex('h')) }) } }));
  await hNo.cycle();
  assert.equal(noRandao.holdingSnapshots(fx.epoch).length, 0, 'blocks without prevRandao draw nothing');
  assert.match(logs.join('\n'), /without prevRandao/);
  const behind = openStore(join(dir, 'bh.db'));
  const hBehind = mk({}, behind, bothClients({ 1: { getBlockNumber: async () => BigInt(lastL1 - 500) } }));
  await hBehind.cycle();
  assert.equal(behind.holdingSnapshots(fx.epoch).length, 0, 'Ethereum not yet past the day\'s end: nothing is drawn from blocks that are not after it');
  console.log('ok - the draw uses the randomness of 32 Ethereum blocks, not their hashes, and waits for Ethereum to be past the day');

  // Claims, on both chains.
  const r1 = await holding.claim(good(0), { client: 'a' });
  assert.deepEqual([r1.status, r1.body.credited, r1.body.points, r1.body.bucketWei], [200, true, 500, ETH.toString()], JSON.stringify(r1));
  const rows = store.depositsFor(good(0).claimAddress, 10);
  assert.deepEqual(rows.map((r) => [r.activity, r.amount_wei, r.points, r.chain_id]), [['holding', '0', 500, 1]]);
  assert.match(rows[0].tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(rows[0].block_time % DAY, 0, 'the credit carries the day it was claimed, not the minute');
  assert.equal(store.leaderboard(5).find((x) => x.address === good(0).claimAddress).points, 500);
  const verifiesBefore = counting.verifies;
  assert.equal((await holding.claim(good(0), { client: 'a' })).body.credited, false, 'sending the same claim again credits nothing more');
  assert.equal((await holding.claim(good(1), { client: 'a' })).body.credited, false, 'the same note cannot be claimed again for the day by naming another address');
  assert.equal(counting.verifies, verifiesBefore, 'a tag already credited is answered without checking a proof');
  assert.equal(store.depositsFor(good(1).claimAddress, 10).length, 0);
  const onBase = await holding.claim(claimOf(fx1, 0), { client: 'a' });
  assert.deepEqual([onBase.status, onBase.body.credited, onBase.body.points], [200, true, 500], `a claim on the second chain, whose pool has another asset: ${JSON.stringify(onBase)}`);
  assert.deepEqual(store.depositsFor(fx1.claims[0].claimAddress, 10).map((r) => r.chain_id).sort((a, b) => a - b), [1, 8453], 'the same payout address, one credit for each chain\'s note');
  assert.equal((await holding.claim({ ...good(0), epoch: fx.epoch + 5 })).status, 409);
  assert.equal((await holding.claim({ ...good(0), chainId: 99 })).status, 400);
  const bad = await holding.claim({ ...good(1), publicSignals: good(1).publicSignals.map((x, j) => (j === 4 ? String(ETH * 5n) : j === 6 ? String(BigInt(x) + 1n) : x)) }, { client: 'b' });
  assert.deepEqual([bad.status, bad.body.error], [422, 'not a size that can be claimed']);
  const wrongPool = mk({ poolAssets: { 1: fx1.poolAsset, 8453: fx0.poolAsset } }, openStore(join(dir, 'wp.db')));
  await wrongPool.cycle();
  assert.equal((await wrongPool.claim(good(0), { client: 'c' })).body.error, 'not this pool\'s asset', 'a note under one pool\'s asset is not another pool\'s');
  console.log('ok - a verified claim is credited once as points to the address it names, on either chain; a replay, a second address and a bad claim are not');

  // A caller, and all callers, are held to a rate; a full queue is refused.
  const limited = mk({ claimsPerMin: 3, claimBurst: 2, allClaimsPerMin: 4 }, openStore(join(dir, 'rl.db')));
  await limited.cycle();
  const junk = { ...good(0), publicSignals: ['1', '2'] };
  assert.equal((await limited.claim(junk, { client: 'x' })).status, 422);
  assert.equal((await limited.claim(junk, { client: 'x' })).status, 422);
  assert.equal((await limited.claim(junk, { client: 'x' })).status, 429, 'a third from one caller within the burst');
  assert.equal((await limited.claim(junk, { client: 'y' })).status, 422, 'another caller is not held by it');
  assert.equal((await limited.claim(junk, { client: 'z' })).status, 422);
  assert.equal((await limited.claim(junk, { client: 'w' })).status, 429, 'the total across callers is capped too');
  clock += 120;
  assert.equal((await limited.claim(junk, { client: 'x' })).status, 422, 'and the allowance comes back');
  clock -= 120;
  const jammed = mk({ maxPending: 0 }, openStore(join(dir, 'jm.db')));
  await jammed.cycle();
  assert.equal((await jammed.claim(good(0))).status, 429, 'a full queue refuses a claim rather than line up proof checks');
  console.log('ok - claims are rate limited per caller and in total, and a full queue refuses');

  // An address that earns no points is refused whole, leaving the tag free for another.
  const exclStore = openStore(join(dir, 'ex.db'), { excluded: [good(0).claimAddress] });
  const excl = mk({}, exclStore);
  await excl.cycle();
  const refused = await excl.claim(good(0));
  assert.deepEqual([refused.status, refused.body.error], [422, 'that address does not earn points']);
  const tag = BigInt(good(0).publicSignals[6]);
  assert.equal(exclStore.holdingClaimFor(fx.epoch, tag), null, 'nothing was recorded for the refused claim');
  const instead = await excl.claim(good(1));
  assert.deepEqual([instead.status, instead.body.credited], [200, true], 'the same note then claims for an address that can earn');
  console.log('ok - a claim for an address that cannot earn is refused whole and does not use up the note\'s day');

  // The asset is read from the pool when not given, and a pool that cannot be read yet is waited on.
  let readable = false;
  const lazyStore = openStore(join(dir, 'lz.db'));
  const lazy = mk({}, lazyStore, bothClients({ 1: { readContract: async (a) => { if (a.functionName === 'ASSET_FIELD' && !readable) throw new Error('node down'); return fakeClient(1).readContract(a); } } }));
  await lazy.cycle();
  assert.deepEqual(lazy.status().assets, { 8453: fx1.poolAsset }, 'only the pool that could be read');
  assert.equal((await lazy.claim(good(0))).status, 503, 'a claim on a pool that cannot be read yet is told to try again');
  readable = true;
  await lazy.cycle();
  assert.equal((await lazy.claim(good(0))).status, 200);
  console.log('ok - each pool\'s asset is read lazily and retried');

  // Events that do not agree with the pool are healed, and nothing is drawn from them.
  const healStore = openStore(join(dir, 'hl.db'));
  let served = fx0.events.slice(0, 4), servedBase = fx1.events;
  const heal = mk({}, healStore, bothClients(), );
  const healer = createHolding({
    store: healStore, hash, groth16: counting, nowSec: () => clock, log: (m) => logs.push(m), clients: bothClients(), scan: scanOf(healStore, (id) => (id === 1 ? served : servedBase)),
    cfg: { enabled: true, rate: 500, buckets, pool: POOL, vkey: vk, chains: [{ chainId: 1, deployBlock: 1 }, { chainId: 8453, deployBlock: 1 }] },
  });
  await healer.cycle();
  assert.deepEqual(healStore.holdingSnapshots(fx.epoch).map((d) => d.chainId), [8453], 'chain 1 missed its last events: nothing is drawn from it');
  assert.equal(healStore.loadHoldingVerified(1), null);
  assert.equal(healStore.holdingEvents(1).length, 0, 'what was read is forgotten to be read again');
  assert.equal(healStore.loadHoldingCursor(1), 0);
  assert.match(logs.join('\n'), /do not agree with the pool/);
  served = fx0.events;
  await healer.cycle();
  assert.deepEqual(healStore.holdingSnapshots(fx.epoch).map((d) => d.chainId), [1, 8453], 'read again whole, it is checked and drawn');
  assert.equal(healStore.holdingEvents(1).length, fx0.events.length);

  const holeStore = openStore(join(dir, 'ho.db'));
  const holey = createHolding({
    store: holeStore, hash, groth16: counting, nowSec: () => clock, log: (m) => logs.push(m), clients: bothClients(), scan: scanOf(holeStore, (id) => (id === 1 ? fx0.events.filter((_, i) => i !== 1) : fx1.events)),
    cfg: { enabled: true, rate: 500, buckets, pool: POOL, vkey: vk, chains: [{ chainId: 1, deployBlock: 1 }, { chainId: 8453, deployBlock: 1 }] },
  });
  await holey.cycle();
  assert.deepEqual(holeStore.holdingSnapshots(fx.epoch).map((d) => d.chainId), [8453], 'a hole in the middle of the history draws nothing either');
  // After a check, a later one rewinds only to the last good block.
  const partial = openStore(join(dir, 'pa.db'));
  let seen = fx0.events.slice(0, 3);
  const cfgBase = { enabled: true, rate: 500, buckets, pool: POOL, vkey: vk, chains: [{ chainId: 1, deployBlock: 1 }] };
  const stepping = createHolding({
    store: partial, hash, groth16: counting, nowSec: () => clock, log: () => {}, cfg: cfgBase,
    clients: { 1: fakeClient(1, { readContract: async ({ functionName, args }) => { const evs = seen; if (functionName === 'root') return evs[evs.length - 1].newRoot; if (functionName === 'nextIndex') return BigInt(seen === fx0.events ? 10 : 6); return fakeClient(1).readContract({ functionName, args }); } }) },
    scan: async () => { partial.saveHoldingEvents(1, seen); partial.saveHoldingCursor(1, seen === fx0.events ? 39900 : 39800); },
  });
  await stepping.cycle();
  assert.equal(partial.loadHoldingVerified(1), 39800, 'events checked whole through block 39800');
  seen = [...fx0.events.slice(0, 3), { ...fx0.events[3], newRoot: fx0.events[0].newRoot }];
  await stepping.cycle();
  assert.equal(partial.loadHoldingVerified(1), 39800);
  assert.equal(partial.loadHoldingCursor(1), 39800, 'a later disagreement rewinds to the last block that was checked');
  assert.equal(partial.holdingEvents(1).every((e) => e.block <= 39800), true);
  console.log('ok - events that miss one the pool has, or have a hole, are forgotten and read again, never drawn from');

  // A chain that has not reached the snapshot's moment yet draws nothing.
  const lagStore = openStore(join(dir, 'lg.db'));
  const lagging = mk({}, lagStore, bothClients({ 8453: { getBlockNumber: async () => 2200n } }));
  await lagging.cycle();
  assert.deepEqual(lagStore.holdingSnapshots(fx.epoch).map((d) => d.chainId), [1], 'the second chain\'s node is behind the moment: no snapshot at its stale tip');
  console.log('ok - a chain that has not reached the moment draws nothing');

  const off = mk({ enabled: false });
  await off.cycle();
  assert.deepEqual(off.status(), { enabled: false });
  assert.equal((await off.claim(good(0))).status, 404);
  assert.equal(off.nullifiers(1, fx.epoch).status, 404);
  assert.throws(() => mk({ vkey: { ...vk, nPublic: 6 } }), /seven public values/, 'a key for other circuits is refused');
  console.log('ok - with the flag off nothing is read, drawn or credited, and only a key for this circuit is taken');

  // A chain whose own root history does not know the rebuilt root draws nothing.
  const store2 = openStore(join(dir, 'q.db'));
  const wrong = mk({}, store2, bothClients({ 1: { readContract: async (a) => (a.functionName === 'everKnownRoot' ? true : a.functionName === 'rootSize' ? 7n : fakeClient(1).readContract(a)) } }));
  await wrong.cycle();
  assert.deepEqual(store2.holdingSnapshots(fx.epoch).map((d) => d.chainId), [8453]);
  assert.match(logs.join('\n'), /is not one the pool held/);
  console.log('ok - a snapshot that disagrees with the pool\'s own root history is not drawn');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
