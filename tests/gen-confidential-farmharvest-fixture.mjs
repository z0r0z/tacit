#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/farm_harvest_op.json — a single OP_FARM_HARVEST for the box's
// exec-farmharvest harness: prove a farm receipt, bound the reward against the rps checkpoint, nullify the
// old receipt and append the advanced one plus the reward note.
//
// RECEIPT v2 (FARM-01): `farm_receipt_leaf` now commits the STAKED asset, so harvest witnesses `lpAsset`
// (between `fee` and `oldIndex`). It is forced to equal the bonded asset by receipt membership — which is
// what closes the cross-asset re-labelling v1 allowed: with the asset absent from the leaf, OP_FARM_UNBOND
// could re-witness it, bond a worthless token and unbond as cETH, draining pool-wide escrow. The owner
// BIP-340 signature does bind lpAsset, but the attacker IS the owner, so a signature over a prover-chosen
// field binds nothing — the leaf commitment is what fixes it.
//
// Run: node tests/gen-confidential-farmharvest-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialFarm } from '../dapp/confidential-farm.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const _cat = (a) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const farm = makeConfidentialFarm({ keccak256, pool });

const CONTROLLER = '0x' + '11'.repeat(20);
const LP_ASSET = '0x' + 'dd'.repeat(32);     // the STAKED asset — now committed in the receipt (v2)
const REWARD_ASSET = '0x' + 'ee'.repeat(32);
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cfh-fixture-' + tag))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const ownerPrivBn = det('owner') % (2n ** 250n);
const OWNER_PRIV = '0x' + ownerPrivBn.toString(16).padStart(64, '0');
const OWNER = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(ownerPrivBn).toRawBytes(true).slice(1)).toString('hex');

const SHARES = 1000n;
const RPS_ENTRY = 0n;
const REWARD = 100n;
const FEE = BigInt(process.env.FEE || 0); // coarse ladder (<= 2 significant digits)
const OLD_NONCE = ZERO32;
const NEW_NONCE = '0x' + '00'.repeat(31) + '01';

const rewardBlind = det('reward');
const rewardNote = { ...pool.commitXY(REWARD - FEE, rewardBlind), blinding: rewardBlind };

// The OLD receipt lives in the note tree — v2, so its leaf commits LP_ASSET.
const controller32 = '0x' + '00'.repeat(12) + CONTROLLER.replace(/^0x/, '');
const oldReceipt = pool.farmReceiptLeaf(controller32, LP_ASSET, SHARES, RPS_ENTRY, OWNER, OLD_NONCE);
const tree = new pool.Tree();
const oldIndex = tree.insert(oldReceipt);
const { root: spendRoot, path: oldPath } = tree.rootAndPath(oldIndex);

const op = farm.buildHarvestOp({
  chainBinding: CHAIN_BINDING,
  spendRoot,
  controller: CONTROLLER,
  owner: OWNER,
  ownerPriv: OWNER_PRIV,
  shares: SHARES,
  rpsEntry: RPS_ENTRY,
  oldNonce: OLD_NONCE,
  newNonce: NEW_NONCE,
  reward: REWARD,
  oldIndex,
  oldPath,
  lpAsset: LP_ASSET,      // receipt v2
  rewardAsset: REWARD_ASSET,
  rewardNote,
  fee: FEE,
});

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot,
  op: 21, // OP_FARM_HARVEST
  controller: CONTROLLER,
  owner: OWNER,
  shares: Number(SHARES),
  rpsEntry: String(RPS_ENTRY),
  oldNonce: OLD_NONCE,
  newNonce: NEW_NONCE,
  reward: Number(REWARD),
  fee: Number(FEE),
  lpAsset: LP_ASSET,       // read between fee and oldIndex (receipt v2)
  oldIndex,
  oldPath,
  rewardAsset: REWARD_ASSET,
  rewardCx: op.rewardCx, rewardCy: op.rewardCy,
  sigR: op.sigR, sigZ: op.sigZ,
  ownerSig: op.ownerSig,
  expected: { reward: Number(REWARD), fee: Number(FEE), shares: Number(SHARES) },
};

const out = 'contracts/sp1/confidential/fixtures/farm_harvest_op.json';
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', out, `— harvest ${REWARD} (fee ${FEE}) against ${SHARES} shares; receipt v2 commits lpAsset`);
