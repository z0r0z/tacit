#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/cdp_topup_op.json — a single OP_CDP_TOPUP for the box's
// exec-cdptopup harness: add collateral to a live position, consuming the old position ν and installing a
// replacement leaf.
//
// SECURITY (F-3): a top-up REPLACES a live position, so it now carries the POSITION OWNER's BIP-340
// signature over (domain ‖ chainBinding ‖ oldLeaf ‖ oldNullifier ‖ newLeaf ‖ addedLegHashes ‖ debt).
// Authority over the ADDED collateral is NOT authority over someone else's position: without this, anyone
// able to mint a dust note carrying the victim's public owner LABEL (labels are not spend authority — notes
// are bearer) could replace their position at will, invalidating any close proof they had prepared, and
// repeat it on every attempt to censor them into liquidation. The controller's health check is not
// ownership, and the contract cannot infer hidden note control.
//
// Run: node tests/gen-confidential-cdptopup-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const _cat = (a) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const cdp = makeConfidentialCdp({ keccak256, pool, signSchnorr });

const CONTROLLER = '0x' + '11'.repeat(20);
const COLL_ASSET = '0x' + 'cc'.repeat(32);
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('ctop-fixture-' + tag))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const ownerPrivBn = det('owner') % (2n ** 250n);
const OWNER_PRIV = '0x' + ownerPrivBn.toString(16).padStart(64, '0');
const OWNER = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(ownerPrivBn).toRawBytes(true).slice(1)).toString('hex');

const DEBT_VALUE = 50n;
const OLD_COLL = 100n;   // already locked in the position
const ADD_COLL = 25n;    // the top-up
const RATE_SNAPSHOT = ZERO32;

const addBlind = det('add');

// The added collateral note lives in the NOTE tree (spendRoot).
const add = pool.commitXY(ADD_COLL, addBlind);
const noteTree = new pool.Tree();
const addIndex = noteTree.insert(pool.leaf(COLL_ASSET, add.cx, add.cy, OWNER));
const { root: spendRoot, path: addPath } = noteTree.rootAndPath(addIndex);

// The existing position leaf lives in the POSITION tree (cdpPositionRoot).
const oldBasket = [{ asset: COLL_ASSET, value: OLD_COLL }];
const oldBasketRoot = cdp.basketRoot(oldBasket.map((l) => cdp.basketLeg(l.asset, l.value)));
const debtAsset = cdp.debtAssetId(CONTROLLER);
const oldPosition = cdp.positionLeaf(CONTROLLER, debtAsset, oldBasketRoot, DEBT_VALUE, RATE_SNAPSHOT, OWNER, ZERO32);
const posTree = new pool.Tree();
const positionIndex = posTree.insert(oldPosition);
const { root: cdpPositionRoot, path: positionPath } = posTree.rootAndPath(positionIndex);

const op = cdp.buildCdpTopupOp({
  chainBinding: CHAIN_BINDING,
  controller: CONTROLLER,
  owner: OWNER,
  ownerPriv: OWNER_PRIV,          // F-3: only the position owner may replace it
  debtValue: DEBT_VALUE,
  oldNonce: ZERO32,
  newNonce: ZERO32,
  rateSnapshot: RATE_SNAPSHOT,
  oldBasket,
  addedCollateral: [{ asset: COLL_ASSET, cx: add.cx, cy: add.cy, value: ADD_COLL, blinding: addBlind, leafIndex: addIndex, path: addPath }],
  positionIndex,
  positionPath,
  spendRoot,
  cdpPositionRoot,
});

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot,
  cdpPositionRoot,
  op: 19, // OP_CDP_TOPUP
  controller: CONTROLLER,
  owner: OWNER,
  debtValue: Number(DEBT_VALUE),
  oldNonce: ZERO32,
  newNonce: ZERO32,
  rateSnapshot: RATE_SNAPSHOT,
  positionIndex,
  positionPath,
  oldLegs: op.oldLegs,
  addedLegs: op.addedLegs,
  ownerSig: op.ownerSig, // read LAST by the guest (R 32 ‖ s 32)
  expected: { debtValue: Number(DEBT_VALUE), oldLegs: op.oldLegs.length, addedLegs: op.addedLegs.length },
};

const out = 'contracts/sp1/confidential/fixtures/cdp_topup_op.json';
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', out, `— top up ${OLD_COLL} → ${OLD_COLL + ADD_COLL} collateral, owner-signed`);
