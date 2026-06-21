#!/usr/bin/env node
// Validates dapp/confidential-farm.js (the EVM farm SETTLE-input builder) against the guest's opening-sigma
// contexts. For each of OP_FARM_BOND / HARVEST / UNBOND we build the sigma with the farm helper, then
// reconstruct the EXACT intent_context main.rs binds and confirm pool.verifyOpeningSigma (the same check the
// guest runs) accepts it — and that tampering a bound field breaks it. Also re-checks the receipt-leaf anchors.
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialFarm } from '../dapp/confidential-farm.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const farm = makeConfidentialFarm({ keccak256: keccak_256, pool });

let fails = 0;
const ok = (cond, name) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

// Fixed test scalars (the sigma round-trip only needs build/verify to agree on the context).
const chainBinding = '0x' + 'cb'.repeat(32);
const controller = '0x' + '11'.repeat(20);
const owner = '0x' + '0a'.repeat(32);
const lpAsset = '0x' + 'a1'.repeat(32);
const controllerWord = '0x' + '00'.repeat(12) + controller.replace(/^0x/, '');
const note = (value, bl) => { const c = pool.commitXY(value, bl); return { ...c, owner, value, blinding: bl }; };

// 1. receipt-leaf / nullifier / new-entry anchors (re-exported from the pool, byte-pinned in farm-js-parity).
const recFarm = '0x' + '44'.repeat(32), recNonce = '0x' + '01'.repeat(32);
const recLeaf = farm.farmReceiptLeaf(recFarm, 100, 0n, owner, recNonce);
ok(recLeaf === '0xa9a1a72e57bb86f2f1b8b2772a4968b6e5d12e81e3ed2e732423e5c040e4213a', 'farmReceiptLeaf anchor');
ok(farm.farmReceiptNullifier(recLeaf) === '0x9247c6895d378bd442b262ba0dab08f4cc627d104ab523198c026dc3c38ed6ff', 'farmReceiptNullifier anchor');
ok(farm.farmHarvestNewEntry(100, 0n, 250) === 46116860184273879040n, 'farmHarvestNewEntry anchor');
ok(farm.debtAssetId(controller) === '0x' + [...keccak_256(Buffer.concat([Buffer.from('tacit-cdp-debt-v1'), Buffer.from(controller.replace(/^0x/, ''), 'hex')]))].map((x) => x.toString(16).padStart(2, '0')).join(''), 'debtAssetId == keccak(domain‖controller)');

// helper: verify a built sigma against a reconstructed context, and that a tampered context is rejected.
const roundtrip = (label, n, sig, domain, assetA, assetB, notes, amounts, tamper) => {
  const ctx = pool.intentContext(domain, chainBinding, assetA, assetB, notes, amounts.map(BigInt));
  ok(pool.verifyOpeningSigma(n.cx, n.cy, n.value, sig.sigR, sig.sigZ, ctx) === true, `${label}: sigma verifies under guest ctx`);
  const bad = pool.intentContext(domain, chainBinding, assetA, assetB, notes, tamper.map(BigInt));
  ok(pool.verifyOpeningSigma(n.cx, n.cy, n.value, sig.sigR, sig.sigZ, bad) === false, `${label}: tampered amount rejected`);
};

// 2. OP_FARM_BOND leg — tacit-farm-bond-leg-v1, notes=[(leg),(controller32,nonce,owner)], amounts=[value,index]
{
  const value = 100, index = 7, nonce = '0x' + '02'.repeat(32);
  const n = note(value, 0x1111n);
  const sig = farm.farmBondLegSigma({ chainBinding, controller, nonce, owner, lpAsset, note: n, index });
  roundtrip('bond', n, sig, 'tacit-farm-bond-leg-v1', lpAsset, nonce,
    [[n.cx, n.cy, owner], [controllerWord, nonce, owner]], [value, index], [value, index + 1]);
}

// 3. OP_FARM_HARVEST reward — tacit-farm-harvest-reward-v1, notes=[(reward)], amounts=[reward], asset=reward_asset
{
  const reward = 250, newNonce = '0x' + '03'.repeat(32);
  const n = note(reward, 0x2222n);
  const rewardAsset = farm.debtAssetId(controller); // MINT mode: reward_asset == debt asset (ESCROW passes an escrow id)
  const sig = farm.farmHarvestRewardSigma({ chainBinding, rewardAsset, newNonce, note: n });
  roundtrip('harvest', n, sig, 'tacit-farm-harvest-reward-v1', rewardAsset, newNonce,
    [[n.cx, n.cy, owner]], [reward], [reward + 1]);
}

// 4. OP_FARM_UNBOND release — tacit-farm-unbond-release-v1, notes=[(release)], amounts=[shares], asset=lp
{
  const shares = 100, nonce = '0x' + '04'.repeat(32);
  const n = note(shares, 0x3333n);
  const sig = farm.farmUnbondReleaseSigma({ chainBinding, lpAsset, nonce, note: n });
  roundtrip('unbond', n, sig, 'tacit-farm-unbond-release-v1', lpAsset, nonce,
    [[n.cx, n.cy, owner]], [shares], [shares + 1]);
}

console.log(fails ? `\n${fails} FAILED` : '\nall farm settle-builder sigmas verify under the guest contexts');
process.exit(fails ? 1 : 0);
