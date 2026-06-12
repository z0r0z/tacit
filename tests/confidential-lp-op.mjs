#!/usr/bin/env node
// OP_LP_ADD / OP_LP_REMOVE — Node round-trip that locks the witness the SP1 guest re-verifies.
// Builds real LP ops (secp contribution/withdrawal notes + a shielded LP-share note) and runs
// verifyAdd/verifyRemove, which mirror EVERY guest assertion in
// contracts/sp1/confidential/src/main.rs: membership, the secp Pedersen openings, first-mint
// isqrt(dA·dB)−MIN_LIQ / subsequent min-rule shares, proportional withdrawal + the MIN_LIQUIDITY
// remove floor, and the LpSettlement (reserves + totalShares pre→post). A batch that passes here is
// one the guest accepts; a tamper that fails here it rejects.
//
// Run: node tests/confidential-lp-op.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const lp = makeConfidentialLp({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZEROS = pool.zeros;
const FEE_BPS = 30; // 0.3% fee tier (one pool per (canonical pair, fee))
const POOL_ID = lp.poolId(ASSET_A, ASSET_B, FEE_BPS);
const LP_ASSET = lp.lpShareId(POOL_ID);

// ───────────────── 1. add liquidity in-ratio mints proportional LP shares ─────────────────
{
  // pool 1000 A / 2000 B, 1000 shares; add 100 A + 200 B (in ratio) → +100 shares
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
    aNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dA: 100, rA: randomScalar(),
    bNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dB: 200, rB: randomScalar(),
    shareOwner: OWNER, rShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(), nonceShares: randomScalar(),
  });
  // place the spent A + B notes in one tree, patch membership paths
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const spendRoot = tree.rootAndPath(0).root;

  const { settlement, nullifiers, leaves } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(op.dShares, 100n, 'min(1000·100/1000, 1000·200/2000) = 100 shares');
  assert.strictEqual(settlement.reserveAPost, 1100n);
  assert.strictEqual(settlement.reserveBPost, 2200n);
  assert.strictEqual(settlement.sharesPost, 1100n, 'totalShares 1000 → 1100');
  assert.strictEqual(nullifiers.length, 2, 'A + B contribution notes spent');
  assert.strictEqual(leaves.length, 1, 'one LP-share note minted');
  assert.strictEqual(leaves[0], pool.leaf(LP_ASSET, op.share.cx, op.share.cy, op.share.owner), 'leaf = LP-share note of the pool LP asset');
  ok('add 100 A + 200 B in-ratio → +100 shares, reserves 1000/2000 → 1100/2200, LP-share note minted');
}

// ───────────────── 2. an off-ratio add mints the LIMITING leg's shares (min rule) ─────────────────
{
  // 100 A : 199 B against a 1:2 pool. B leg limits: min(1000·100/1000, 1000·199/2000) = min(100,99) = 99.
  // The add SUCCEEDS (no exact-ratio gate); the ~1 excess A accrues to the pool. The old gate rejected this.
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
    aNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dA: 100, rA: randomScalar(),
    bNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dB: 199, rB: randomScalar(),
    shareOwner: OWNER, rShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(), nonceShares: randomScalar(),
  });
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const spendRoot = tree.rootAndPath(0).root;
  const { settlement } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(op.dShares, 99n, 'min(100, 99) = 99 shares — the B leg limits');
  assert.strictEqual(settlement.reserveAPost, 1100n);
  assert.strictEqual(settlement.reserveBPost, 2199n);
  assert.strictEqual(settlement.sharesPost, 1099n, 'totalShares 1000 → 1099');
  ok('off-ratio add (100 A : 199 B) mints the limiting-leg shares (99); excess accrues to the pool');
}

// ───────────────── 2b. F1 REGRESSION: incremental add on a COPRIME, traded pool now works ─────────────────
{
  // After trading, reserves go coprime; the old exact-ratio gate then forced dA to be a multiple of R_A,
  // so incremental LP was impossible. The min rule accepts an arbitrary near-ratio (dA, dB).
  const RA = 1000003, RB = 1999991, S = 1000003; // gcd(RA, RB) = 1
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: RA, reserveBPre: RB, sharesPre: S,
    aNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dA: 500, rA: randomScalar(),
    bNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dB: 999, rB: randomScalar(),
    shareOwner: OWNER, rShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(), nonceShares: randomScalar(),
  });
  assert.notStrictEqual(500n * BigInt(RB), 999n * BigInt(RA), 'deliberately off exact-ratio (old gate would reject)');
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const spendRoot = tree.rootAndPath(0).root;
  const { settlement } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(op.dShares, 499n, 'min(500, 499) = 499 shares');
  assert.strictEqual(settlement.sharesPost, BigInt(S) + 499n);
  ok('incremental add on a coprime/traded pool earns shares (499) — the exact-ratio gate would have rejected it');
}

// ───────────────── 3. inflating the LP-share note breaks the share opening/proportion ─────────────────
{
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
    aNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dA: 100, rA: randomScalar(),
    bNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dB: 200, rB: randomScalar(),
    shareOwner: OWNER, rShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(), nonceShares: randomScalar(),
  });
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const spendRoot = tree.rootAndPath(0).root;
  const bad = { ...op, dShares: 150n }; // claim 150 shares for a 100-share contribution
  assert.throws(() => lp.verifyAdd(bad, { merkleRootFrom: pool.merkleRootFrom, spendRoot }), /opening|proportional shares/, 'inflated shares rejected');
  ok('claiming 150 shares for a 100-proportional contribution fails the share proportion/opening');
}

// ───────────────── 4. remove liquidity returns the proportional underlying ─────────────────
{
  // pool 10000 A / 20000 B, 10000 shares; remove a 100-share note → 100 A + 200 B back, 9900 shares left
  // (a realistic pool — totalShares well above MINIMUM_LIQUIDITY so the partial remove clears the floor).
  const op = lp.buildRemove({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 10000, reserveBPre: 20000, sharesPre: 10000,
    shareNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dShares: 100, rShares: randomScalar(),
    aOwner: OWNER, rA: randomScalar(), bOwner: OWNER, rB: randomScalar(), nonceShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(),
  });
  const tree = new pool.Tree();
  const si = tree.insert(pool.leaf(LP_ASSET, op.share.cx, op.share.cy, op.share.owner));
  op.share.leafIndex = si; op.share.path = tree.rootAndPath(si).path;
  const spendRoot = tree.rootAndPath(0).root;

  const { settlement, nullifiers, leaves } = lp.verifyRemove(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(op.dA, 100n, 'floor(10000·100/10000) = 100 A');
  assert.strictEqual(op.dB, 200n, 'floor(20000·100/10000) = 200 B');
  assert.strictEqual(settlement.reserveAPost, 9900n);
  assert.strictEqual(settlement.reserveBPost, 19800n);
  assert.strictEqual(settlement.sharesPost, 9900n, 'totalShares 10000 → 9900');
  assert.strictEqual(nullifiers.length, 1, 'LP-share note spent');
  assert.strictEqual(leaves.length, 2, 'A + B withdrawn notes minted');
  ok('remove 100 shares → 100 A + 200 B back, reserves 10000/20000 → 9900/19800, shares → 9900');
}

// ───────────────── 5. removing more shares than exist is rejected ─────────────────
{
  const op = lp.buildRemove({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 10000, reserveBPre: 20000, sharesPre: 10000,
    shareNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dShares: 10001, rShares: randomScalar(),
    aOwner: OWNER, rA: randomScalar(), bOwner: OWNER, rB: randomScalar(), nonceShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(),
  });
  const tree = new pool.Tree();
  const si = tree.insert(pool.leaf(LP_ASSET, op.share.cx, op.share.cy, op.share.owner));
  op.share.leafIndex = si; op.share.path = tree.rootAndPath(si).path;
  const spendRoot = tree.rootAndPath(0).root;
  assert.throws(() => lp.verifyRemove(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot }), /shares in range/, 'over-remove rejected');
  ok('removing 10001 of 10000 shares is rejected (shares in range)');
}

// ───────────────── 5b. F6: a remove that would breach the MINIMUM_LIQUIDITY floor is rejected ─────────────────
{
  // pool 10000 shares; a (fabricated) 9500-share note would leave 500 < MINIMUM_LIQUIDITY (1000). The
  // locked floor can never be removed — the guest + contract + this mirror all reject it.
  const op = lp.buildRemove({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 10000, reserveBPre: 20000, sharesPre: 10000,
    shareNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dShares: 9500, rShares: randomScalar(),
    aOwner: OWNER, rA: randomScalar(), bOwner: OWNER, rB: randomScalar(), nonceShares: randomScalar(), nonceA: randomScalar(), nonceB: randomScalar(),
  });
  const tree = new pool.Tree();
  const si = tree.insert(pool.leaf(LP_ASSET, op.share.cx, op.share.cy, op.share.owner));
  op.share.leafIndex = si; op.share.path = tree.rootAndPath(si).path;
  const spendRoot = tree.rootAndPath(0).root;
  assert.throws(() => lp.verifyRemove(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot }), /MINIMUM_LIQUIDITY/, 'floor breach rejected');
  ok('removing 9500 of 10000 shares (would leave 500 < MINIMUM_LIQUIDITY) is rejected');
}

// ───────────────── 6. withdrawing more underlying than the proportional share entitles is rejected ─────────────────
{
  // The direct "withdraw more than entitled" vector: keep a valid 100-share note, but claim dA = 150
  // (the honest floor(1000·100/1000) is 100). A prover that re-commits the A note to 150 and re-signs
  // under the (now-different) intent context must still satisfy dA = floor(R_A·dShares/total): the
  // floor equation `R_A·dShares == dA·total + remA, remA<total` uniquely pins dA, so the inflated
  // withdrawal fails the proportional bind (no over-extraction).
  const reserveAPre = 10000n, reserveBPre = 20000n, sharesPre = 10000n, dShares = 100n;
  const rShares = randomScalar(), rA = randomScalar(), rB = randomScalar();
  const sC = pool.commitXY(dShares, rShares);
  const bq = (reserveBPre * dShares) / sharesPre, bRem = reserveBPre * dShares - bq * sharesPre;
  const dAClaim = 150n; // honest floor is floor(10000·100/10000) = 100
  const aRem = reserveAPre * dShares - dAClaim * sharesPre; // negative → never a valid floor remainder
  const aC = pool.commitXY(dAClaim, rA), bC = pool.commitXY(bq, rB);
  const op = {
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS,
    reserveAPre, reserveBPre, sharesPre,
    share: { cx: sC.cx, cy: sC.cy, owner: OWNER, leafIndex: 0, path: ZEROS }, dShares,
    dA: dAClaim, remA: aRem, dB: bq, remB: bRem,
    a: { cx: aC.cx, cy: aC.cy, owner: OWNER }, b: { cx: bC.cx, cy: bC.cy, owner: OWNER },
  };
  const removeCtx = (o) => pool.intentContext('tacit-lp-remove-v1', o.chainBinding, o.assetA, o.assetB,
    [[o.share.cx, o.share.cy, o.share.owner], [o.a.cx, o.a.cy, o.a.owner], [o.b.cx, o.b.cy, o.b.owner]],
    [o.dShares, o.dA, o.dB, o.deadline ?? 0n]);
  const ctx = removeCtx(op);
  op.sSig = pool.openingSigma(op.dShares, rShares, ctx, randomScalar());
  op.aSig = pool.openingSigma(op.dA, rA, ctx, randomScalar());
  op.bSig = pool.openingSigma(op.dB, rB, ctx, randomScalar());
  const tree = new pool.Tree();
  const si = tree.insert(pool.leaf(LP_ASSET, sC.cx, sC.cy, OWNER));
  op.share.leafIndex = si; op.share.path = tree.rootAndPath(si).path;
  const spendRoot = tree.rootAndPath(0).root;
  assert.throws(() => lp.verifyRemove(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot }), /dA proportional/, 'over-withdraw rejected');
  ok('withdrawing 150 A for a 100-proportional share (floor is 100) is rejected (dA proportional)');
}

// ───────────────── 7. ZAMM first mint: empty pool → isqrt(dA·dB) − MIN_LIQUIDITY ─────────────────
{
  const dA = 1_000_000n, dB = 4_000_000n; // isqrt(4e12) = 2_000_000; founder note = 1_999_000, 1000 locked
  const op = lp.buildAdd({
    assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 0, reserveBPre: 0, sharesPre: 0,
    aNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dA, rA: randomScalar(),
    bNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dB, rB: randomScalar(),
    shareOwner: OWNER, rShares: randomScalar(),
  });
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const spendRoot = tree.rootAndPath(0).root;
  const { settlement } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(op.dShares, 1_999_000n, 'founder note = isqrt(dA·dB) − 1000');
  assert.strictEqual(settlement.reserveAPost, 1_000_000n, 'reserves SET (not added)');
  assert.strictEqual(settlement.reserveBPost, 4_000_000n);
  assert.strictEqual(settlement.sharesPost, 2_000_000n, 'totalShares = isqrt; 1000 locked noteless');
  ok('first mint: empty pool → founder note isqrt(dA·dB)−1000, 1000 locked, reserves set (ZAMM)');
}

// ───────────────── 8. first mint below MINIMUM_LIQUIDITY is rejected ─────────────────
{
  let threw = null;
  try {
    const op = lp.buildAdd({
      assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 0, reserveBPre: 0, sharesPre: 0,
      aNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dA: 10, rA: randomScalar(),
      bNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, dB: 10, rB: randomScalar(), // isqrt(100)=10 ≤ 1000
      shareOwner: OWNER, rShares: randomScalar(),
    });
    const tree = new pool.Tree();
    const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
    const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
    op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
    op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
    lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: tree.rootAndPath(0).root });
  } catch (e) { threw = e; }
  assert.ok(threw && /MINIMUM_LIQUIDITY/.test(threw.message), 'dust first mint rejected');
  ok('first mint with isqrt(dA·dB) ≤ 1000 rejected (MINIMUM_LIQUIDITY floor)');
}

console.log(`\n${n} OP_LP checks passed.`);
