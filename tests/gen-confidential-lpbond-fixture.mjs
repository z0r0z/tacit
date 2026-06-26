#!/usr/bin/env node
// OP_LP_BOND witness: add liquidity AND bond the resulting shares into a farm in one settle. Spends an A
// note + a B note (opening-sigma bound), derives d_shares (= lp_add_shares), and the guest emits a
// farm_receipt_leaf + bond CdpMint (no intermediate LP-share note). The A/B sigmas bind the bond target
// (controller, owner, nonce) so a relay can't re-point the bonded liquidity.
// Run: node tests/gen-confidential-lpbond-fixture.mjs > contracts/sp1/confidential/fixtures/lpbond_op.json
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');

// Canonical asset order: assetA < assetB.
const ASSET_A = '0x' + '0a'.repeat(32);
const ASSET_B = '0x' + 'b0'.repeat(32);
const OWNER = '0x' + Buffer.from('lp-owner-stealth'.padEnd(32, '\0')).toString('hex');
const CONTROLLER = '0x' + '00'.repeat(12) + 'cafe00000000000000000000000000000000d00d'.slice(0, 40);
const BOND_NONCE = '0x' + '77'.repeat(32);
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const FEE_BPS = 30, OP_DEADLINE = 0n, FEE = 0n, RPS_ENTRY = 0n;

const reserveA = 10000n, reserveB = 10000n, sharesPre = 10000n;
const dA = 1000n, dB = 1000n; // in-ratio add
const aBlind = randomScalar(), bBlind = randomScalar();
const dShares = pool.lpAddShares(sharesPre, dA - FEE, dB, reserveA, reserveB);
if (dShares <= 0n) throw new Error('zero shares');

const A = pool.commitXY(dA, beHex(aBlind));
const B = pool.commitXY(dB, beHex(bBlind));
const aLeaf = pool.leaf(ASSET_A, A.cx, A.cy, OWNER);
const bLeaf = pool.leaf(ASSET_B, B.cx, B.cy, OWNER);
const tree = new pool.Tree();
tree.insert(aLeaf); tree.insert(bLeaf);
const spendRoot = tree.root();
const aPath = tree.rootAndPath(0).path, bPath = tree.rootAndPath(1).path;

// ctx binds A,B + the bond target (controller32, bond_nonce, owner) + deltas (incl. DERIVED d_shares).
const ctx = pool.intentContext('tacit-lp-bond-v1', CHAIN_BINDING, ASSET_A, ASSET_B,
  [[A.cx, A.cy, OWNER], [B.cx, B.cy, OWNER], [CONTROLLER, BOND_NONCE, OWNER]],
  [dA, dB, dShares, OP_DEADLINE, FEE]);
const aSig = pool.openingSigma(dA, beHex(aBlind), ctx, pool.deriveOpeningNonce(beHex(aBlind), ctx, 'lp-bond-a'));
const bSig = pool.openingSigma(dB, beHex(bBlind), ctx, pool.deriveOpeningNonce(beHex(bBlind), ctx, 'lp-bond-b'));
if (!pool.verifyOpeningSigma(A.cx, A.cy, dA, aSig.R, aSig.z, ctx)) throw new Error('A sigma self-verify failed');
if (!pool.verifyOpeningSigma(B.cx, B.cy, dB, bSig.R, bSig.z, ctx)) throw new Error('B sigma self-verify failed');

process.stdout.write(JSON.stringify({
  note: 'OP_LP_BOND: add liquidity + bond shares into a farm in one settle (1-click farm entry)',
  op: 'lpbond',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  controller: CONTROLLER.slice(0, 2) + CONTROLLER.slice(26), // 20-byte address
  owner: OWNER,
  rpsEntry: RPS_ENTRY.toString(),
  bondNonce: BOND_NONCE,
  assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  reserveAPre: Number(reserveA), reserveBPre: Number(reserveB), sharesPre: Number(sharesPre),
  a: { cx: A.cx, cy: A.cy, owner: OWNER, index: 0, path: aPath, d: Number(dA), sigR: aSig.R, sigZ: aSig.z },
  b: { cx: B.cx, cy: B.cy, owner: OWNER, index: 1, path: bPath, d: Number(dB), sigR: bSig.R, sigZ: bSig.z },
  opDeadline: Number(OP_DEADLINE), fee: Number(FEE),
}, null, 2) + '\n');
