#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/lp_op.json — a single OP_LP_ADD the box's exec-lp harness
// feeds to the guest (execute → prove). Pool 1000 A / 2000 B / 1000 shares; add 100 A + 200 B
// in-ratio ⇒ +100 LP shares, reserves → 1100/2200. The witness fields are emitted in the guest's
// io::read order; `expected` carries the LpSettlement + the minted/spent leaves the guest commits.
//
// Run: node tests/gen-confidential-lp-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const lp = makeConfidentialLp({ keccak256, pool });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const SHARE_OWNER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('clp-fixture-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const FEE_BPS = 30; // 0.3% fee tier — binds the pool id (one pool per (canonical pair, fee))
const PF_BPS = Number(process.env.PF_BPS || 0);                  // optional Uniswap fee-switch (0 ⇒ canonical 3-arg id)
// recipient pubkey bound into the 6-arg id. For pfBps!=0 the guest decompresses it (must be a valid on-curve
// compressed key), so default to a deterministic valid pubkey — not the zero placeholder (zero is acceptable
// only on the pfBps==0 path, where the recipient is ignored and the id collapses to the 3-arg pool id).
const PF_RCPT = process.env.PF_RCPT
  || (PF_BPS ? '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(12345n).toRawBytes(true)).toString('hex')
             : '0x' + '00'.repeat(33));

const op = lp.buildAdd({
  assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, protocolFeeBps: PF_BPS, protocolFeeRecipient: PF_RCPT, reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
  aNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, dA: 100, rA: det('a-secp'),
  bNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, dB: 200, rB: det('b-secp'),
  shareOwner: SHARE_OWNER, rShares: det('share-secp'),
  nonceA: det('a-nonce'), nonceB: det('b-nonce'), nonceShares: det('share-nonce'),
});

// place the spent A + B contribution notes in one tree, patch membership paths
const tree = new pool.Tree();
const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
const spendRoot = tree.rootAndPath(0).root;

const { settlement, nullifiers, leaves } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot,
  op: 7, // OP_LP_ADD
  assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS, protocolFeeBps: PF_BPS, protocolFeeRecipient: PF_RCPT,
  reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
  a: { cx: op.a.cx, cy: op.a.cy, owner: op.a.owner, leafIndex: op.a.leafIndex, path: op.a.path, d: Number(op.dA), sigR: op.aSig.R, sigZ: op.aSig.z },
  b: { cx: op.b.cx, cy: op.b.cy, owner: op.b.owner, leafIndex: op.b.leafIndex, path: op.b.path, d: Number(op.dB), sigR: op.bSig.R, sigZ: op.bSig.z },
  // d_shares is DERIVED in-guest (the V2 min rule) — not streamed in the witness.
  share: { cx: op.share.cx, cy: op.share.cy, owner: op.share.owner, sigR: op.sSig.R, sigZ: op.sSig.z },
  deadline: Number(op.deadline ?? 0), // per-op Expired; bound in the LP's sigma (buildAdd), read after the share sigma (guest 554)
  expected: {
    poolId: settlement.poolId,
    reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost), sharesPost: Number(settlement.sharesPost),
    nullifiers, leaves,
  },
};

const out = PF_BPS ? 'contracts/sp1/confidential/fixtures/lp_protofee_op.json' : 'contracts/sp1/confidential/fixtures/lp_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— add 100A/200B, reserves 1000/2000 →', fixture.expected.reserveAPost + '/' + fixture.expected.reserveBPost, '+', fixture.expected.sharesPost - fixture.sharesPre, 'shares (V2 min rule, derived in-guest)');
