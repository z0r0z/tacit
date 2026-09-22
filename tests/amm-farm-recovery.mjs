#!/usr/bin/env node
// Confidential farm-position recovery — proves a wiped wallet reconstructs its lp_return + reward
// note openings from the on-chain unbond/harvest envelope + the worker farm/bond records, and that
// the reconstructed Pedersen commitments are BYTE-IDENTICAL to the validator's decree
// (tests/amm-farm.mjs validateLpUnbond / validateLpHarvest), so the recovered openings reopen the
// real on-chain UTXOs and are spendable.
//
// Run: node tests/amm-farm-recovery.mjs

import * as secp from '@noble/secp256k1';
import { pedersenCommit, pointToBytes, SECP_N } from '../dapp/bulletproofs.js';
import { encodeLpUnbond, encodeLpHarvest, deriveLpAssetIdFromPoolId } from '../dapp/amm-envelope.js';
import { makeFarmRecovery } from '../dapp/amm-farm-recovery.js';
import assert from 'node:assert';

const farm = makeFarmRecovery();
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const beBig = (b) => BigInt('0x' + hex(b));
const rand32 = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (i * 37 + 11) & 0xff; return b; };
const rand32b = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (i * 53 + 7) & 0xff; return b; };

// Worker-resolved farm/bond records (in production from fetchFarm / fetchBondsForBonder).
const poolId = new Uint8Array(32).fill(0xab);
const rewardAssetIdHex = 'cd'.repeat(32);
const bondAmount = 4242n;
const rewardAmount = 777n;
const lpReturnR = rand32();
const rewardR = rand32b();
const unbonderPub = secp.getPublicKey(new Uint8Array(32).fill(9), true); // 33B

const ownerCommit = new Uint8Array(32).fill(3);
const receiptNonce = new Uint8Array(32).fill(4);

// ── 1. UNBOND: reconstruct lp_return (vout 1) and match the validator's commit; no reward is minted ──
const unbondEnv = encodeLpUnbond({
  farmId: new Uint8Array(32).fill(1), ownerCommit, nonce: receiptNonce, shares: bondAmount,
  lpReturnR, unbonderSig: new Uint8Array(64),
});
const got = farm.recoverUnbond(unbondEnv, { poolId });
assert.strictEqual(got.length, 1, 'unbond recovers only lp_return (harvest pays the reward)');

const lp = got[0];
assert.strictEqual(lp.kind, 'lp_return', 'only lp_return');
// The validator decrees these EXACT commitments — recovery must reproduce them byte-for-byte.
const cLp = hex(pointToBytes(pedersenCommit(bondAmount, beBig(lpReturnR) % SECP_N)));
const cRw = hex(pointToBytes(pedersenCommit(rewardAmount, beBig(rewardR) % SECP_N)));
assert.strictEqual(lp.commitmentHex, cLp, 'lp_return commitment matches the validator decree');
assert.strictEqual(lp.vout, 1, 'lp_return at vout 1');
assert.strictEqual(lp.amount, bondAmount, 'lp_return amount = bonded shares');
assert.strictEqual(lp.assetIdHex, hex(deriveLpAssetIdFromPoolId(poolId)), 'lp_return asset = deriveLpAssetId(pool_id)');
ok('unbond reconstructs the lp_return opening byte-identical to the validator commitment');

// ── 2. HARVEST: reward only (vout 1) ──
const harvestArgs = {
  farmId: new Uint8Array(32).fill(1), bondId: new Uint8Array(36).fill(2), harvesterPubkey: unbonderPub,
  exitAccPerShare: 0n, exitViewHeight: 0, rewardAmount, rewardR,
  ownerCommit, oldNonce: receiptNonce, shares: bondAmount, harvesterSig: new Uint8Array(64),
};
const h = farm.recoverHarvest(encodeLpHarvest(harvestArgs), { rewardAssetIdHex });
assert.strictEqual(h.length, 1, 'harvest recovers the reward');
const rw = h[0];
assert.strictEqual(rw.kind, 'farm_reward', 'reward kind');
assert.strictEqual(rw.vout, 1, 'harvest reward at vout 1');
assert.strictEqual(rw.commitmentHex, cRw, 'harvest reward commitment matches the validator decree');
assert.strictEqual(rw.amount, rewardAmount, 'reward amount from envelope');
assert.strictEqual(rw.assetIdHex, rewardAssetIdHex, 'reward asset = farm.reward_asset_id');
ok('harvest reconstructs the reward opening at vout 1');

// ── 3. The recovered (amount, blinding) reproduce the stored commitment (self-consistent + spendable) ──
assert.strictEqual(hex(pointToBytes(pedersenCommit(lp.amount, lp.blinding))), lp.commitmentHex, 'lp_return opening reopens its commitment');
assert.strictEqual(hex(pointToBytes(pedersenCommit(rw.amount, rw.blinding))), rw.commitmentHex, 'reward opening reopens its commitment');
ok('recovered openings reopen their on-chain commitments (spendable)');

// ── 4. A zero-reward harvest mints no reward note (skip it) ──
const z = farm.recoverHarvest(encodeLpHarvest({ ...harvestArgs, rewardAmount: 0n }), { rewardAssetIdHex });
assert.strictEqual(z.length, 0, 'zero-reward harvest recovers nothing (no reward note minted)');
ok('a zero-reward harvest recovers no phantom reward note');

console.log(`\n${n} farm-recovery checks passed.`);
