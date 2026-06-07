#!/usr/bin/env node
// Build a full OP_BRIDGE_MINT witness (BTC → ETH) for the SP1 guest: a real
// Bitcoin block (valid easy-PoW) whose single tx is a Taproot reveal carrying the
// 0x2B confidential-burn envelope (asset ‖ btc_pool_root ‖ ν ‖ dest_commitment),
// the burned note's membership in a Bitcoin pool tree, and the dest note + its
// aggregated BP+ range proof + conservation kernel. The Rust host feeds this to
// the guest and executes the whole bridge_mint op loop in the zkVM.
//
// Run: node tests/gen-cxfer-bridgemint-fixture.mjs > contracts/sp1/confidential/fixtures/bridgemint_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { buildRevealTx, computeTxid, computeMerkleRoot, mineHeader } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const ct = makeConfidentialTransfer({ keccak256 });
const pool = makeConfidentialPool({ secp, keccak256, sha256 });

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER_BTC = '0x' + '00'.repeat(31) + 'b7'; // burned note's owner on Bitcoin
const OWNER_ETH = '0x' + '00'.repeat(31) + 'e7'; // dest note's owner on Ethereum
const ETHEREUM = 2;
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex'); // 33B compressed
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32 = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex'));

// The burn: one Bitcoin note (1500) → one Ethereum dest note (1500), conserved.
const burned = { value: 1500n, blinding: randomScalar(), secret: '0x' + 'b1'.repeat(32) };
const dest = { value: 1500n, blinding: randomScalar(), owner: OWNER_ETH };
const bindNullifier = pool.nullifier(burned.secret);

const burn = ct.buildBridgeBurn({
  inputs: [{ value: burned.value, blinding: burned.blinding }],
  outputs: [dest], assetId: ASSET, destChain: ETHEREUM, bindNullifier,
});
if (!ct.verifyBridgeBurn(burn)) throw new Error('JS bridge-burn self-verify failed');
const inXY = xy(burn.inC[0]);
const co = burn.crossOuts[0]; // { destCommitment (= ETH leaf), cx, cy, owner: OWNER_ETH, ... }

// Bitcoin pool tree: insert the burned note's leaf, take root + membership path.
const tree = new pool.Tree();
const inLeaf = pool.leaf(ASSET, inXY.cx, inXY.cy, OWNER_BTC);
tree.insert(inLeaf);
const poolRoot = tree.root();
const { path } = tree.rootAndPath(0);

// 0x2B envelope: asset ‖ btc_pool_root ‖ ν ‖ dest_commitment.
const envelope = Buffer.concat([
  Buffer.from([0x2b]), b32(ASSET), b32(poolRoot), b32(bindNullifier), b32(co.destCommitment),
]);
const tx = buildRevealTx(envelope);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

process.stdout.write(JSON.stringify({
  note: 'full OP_BRIDGE_MINT witness (BTC→ETH) for the SP1 guest op loop',
  chainBinding: '0x' + '00'.repeat(32),
  asset: ASSET,
  header: hx(header),
  tx: hx(tx),
  txIndex: 0,
  txids: [hx(txid)],
  poolRoot, // = env btc_pool_root; the guest reads it from the envelope
  input: { cx: inXY.cx, cy: inXY.cy, owner: OWNER_BTC, leafIndex: 0, path, secret: burned.secret },
  output: { cx: co.cx, cy: co.cy, owner: OWNER_ETH },
  rangeProof: '0x' + Buffer.from(burn.rangeProof).toString('hex'),
  kernel: { R: ptHex(burn.kernel.R), z: beHex(burn.kernel.z) },
  expect: { destLeaf: co.destCommitment, claimId: co.claimId, nullifier: bindNullifier },
}, null, 2) + '\n');
