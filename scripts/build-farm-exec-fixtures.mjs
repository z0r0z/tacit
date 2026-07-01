#!/usr/bin/env node
// Build the OP_FARM_BOND / OP_FARM_HARVEST / OP_FARM_UNBOND execute fixtures
// (contracts/sp1/confidential/fixtures/farm_{bond,harvest,unbond}_op.json) for reflect-exec's farm-execute
// validator. Byte-aligned to the settle guest's io::read order (contracts/sp1/confidential/src/main.rs
// OP_FARM_*), using dapp/confidential-farm.js for the opening sigmas + dapp/confidential-pool.js for the
// receipt leaves + single-leaf membership. A clean execute proves the guest ACCEPTS each farm witness (leg/
// receipt membership against spendRoot + the opening sigma) — the controller's rps policy is NOT in execute.
//   node scripts/build-farm-exec-fixtures.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialFarm } from '../dapp/confidential-farm.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const farm = makeConfidentialFarm({ keccak256: keccak_256, pool });
const dir = new URL('../contracts/sp1/confidential/fixtures/', import.meta.url);

const ZERO = '0x' + '00'.repeat(32);
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const kc = (...parts) => hx(keccak_256(_cat(parts.map(b32))));
// Single-leaf (index 0) root + 32-deep zero-sibling path — the membership a 1-element note tree proves.
const singleLeafRootPath = (leafHex) => { let h = b32(leafHex); for (let i = 0; i < 32; i++) h = keccak_256(_cat([h, b32(ZERO)])); return { root: hx(h), path: Array(32).fill(ZERO) }; };
const noteLeaf = (asset, cx, cy, owner) => kc(asset, cx, cy, owner); // == guest leaf(asset, cx, cy, owner)

const chainBinding = '0x' + '11'.repeat(32);
const controller = '0x' + 'c1'.repeat(20);
// The receipt owner must be a real x-only pubkey: harvest/unbond require a BIP-340 sig under it (main.rs).
const ownerPriv = '0x' + 'a0'.repeat(32);
const owner = hx(secp.getPublicKey(b32(ownerPriv), true).slice(1)); // x-only (drop the 0x02/03 prefix)
const lpAsset = '0x' + 'a1'.repeat(32);
const controller32 = '0x' + '00'.repeat(12) + controller.replace(/^0x/, ''); // the receipt's "farm" field for an EVM farm

// OP_FARM_BOND: one LP-share note (value = shares) bonded → receipt(shares, rps_entry=0).
{
  const nonce = '0x' + 'b0'.repeat(32), shares = 1000, r = '0x' + '0'.repeat(63) + '7';
  const { cx, cy } = pool.commitXY(shares, r);
  const { root, path } = singleLeafRootPath(noteLeaf(lpAsset, cx, cy, owner));
  const op = farm.buildBondOp({ chainBinding, spendRoot: root, controller, owner, rpsEntry: '0', nonce, lpAsset,
    legs: [{ cx, cy, value: shares, index: 0, path, blinding: r }] });
  writeFileSync(new URL('farm_bond_op.json', dir),
    JSON.stringify({ ...op, expected: { nullifiers: 1, leaves: 1, cdpMints: 1 } }, null, 2));
  console.log('wrote farm_bond_op.json');
}

// OP_FARM_HARVEST: receipt(shares, rps_entry) in tree → nullify + append advanced receipt + reward note.
{
  const oldNonce = '0x' + 'b1'.repeat(32), newNonce = '0x' + 'b2'.repeat(32);
  const shares = 1000, rpsEntry = 0n, reward = 250, r = '0x' + '0'.repeat(63) + '9';
  const oldLeaf = farm.farmReceiptLeaf(controller32, shares, rpsEntry, owner, oldNonce);
  const { root, path } = singleLeafRootPath(oldLeaf);
  const { cx, cy } = pool.commitXY(reward, r);
  const rewardAsset = farm.debtAssetId(controller); // MINT mode (reward_asset == debt asset); ESCROW passes an escrow id
  const op = farm.buildHarvestOp({ chainBinding, spendRoot: root, controller, owner, ownerPriv, shares, rpsEntry: rpsEntry.toString(),
    oldNonce, newNonce, reward, oldIndex: 0, oldPath: path, rewardAsset, rewardNote: { cx, cy, blinding: r } });
  writeFileSync(new URL('farm_harvest_op.json', dir),
    JSON.stringify({ ...op, expected: { nullifiers: 1, leaves: 2, cdpMints: 1 } }, null, 2));
  console.log('wrote farm_harvest_op.json');
}

// OP_FARM_UNBOND: receipt in tree → nullify + re-mint the released LP-share note (value = shares).
{
  const nonce = '0x' + 'b3'.repeat(32), shares = 1000, rpsEntry = 0n, r = '0x' + '0'.repeat(63) + 'b';
  const receipt = farm.farmReceiptLeaf(controller32, shares, rpsEntry, owner, nonce);
  const { root, path } = singleLeafRootPath(receipt);
  const { cx, cy } = pool.commitXY(shares, r);
  const op = farm.buildUnbondOp({ chainBinding, spendRoot: root, controller, owner, ownerPriv, shares, rpsEntry: rpsEntry.toString(),
    nonce, lpAsset, oldIndex: 0, oldPath: path, releaseNote: { cx, cy, blinding: r } });
  writeFileSync(new URL('farm_unbond_op.json', dir),
    JSON.stringify({ ...op, expected: { nullifiers: 1, leaves: 1, cdpCloses: 1 } }, null, 2));
  console.log('wrote farm_unbond_op.json');
}
