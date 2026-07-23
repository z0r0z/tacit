#!/usr/bin/env node
// Emit fixtures/route_op.json — a real-crypto OP_SWAP_ROUTE witness the SP1 settle guest re-verifies in
// execute mode (reflect-exec/src/route_execute.rs). A 2-hop A→B→C route: one input note → two
// constant-product hops → one output note, with the input leaf inserted into a pool tree so the
// membership proof is real. Mirrors tests/confidential-route-op.mjs §2; the guest accepts iff verifyRoute
// accepts. Run: node tests/gen-confidential-route-fixture.mjs > contracts/sp1/confidential/fixtures/route_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialRoute } from '../dapp/confidential-route.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const _ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const route = makeConfidentialRoute({ keccak256: keccak_256, pool , kernelSign: _ct.kernelSign, rangeProve: _ct.rangeProve });

const A = '0x' + 'aa'.repeat(32);
const B = '0x' + 'bb'.repeat(32);
const C = '0x' + 'cc'.repeat(32); // A < B < C
const OWNER = '0x' + '00'.repeat(31) + '01';
const OUT_OWNER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const FEE = 30; // 0.3%
const amountIn = 10_000;

const hops = [
  { assetNext: B, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 },
  { assetNext: C, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 },
];
const rIn = randomScalar(), rOut = randomScalar();
const op = route.buildRoute({
  asset0: A, chainBinding: CHAIN_BINDING, inNote: { owner: OWNER, leafIndex: 0, path: pool.zeros },
  amountIn, rIn, hops, minOut: 9000, outOwner: OUT_OWNER, rOut, deadline: 0,
});

// Real membership: insert the input note, take its leaf index + path, derive the spend root.
const tree = new pool.Tree();
const ii = tree.insert(pool.leaf(A, op.in.cx, op.in.cy, op.in.owner));
op.in.leafIndex = ii;
op.in.path = tree.rootAndPath(ii).path;
const spendRoot = tree.rootAndPath(0).root;

// Self-check: the JS verifier (byte-faithful mirror of the guest) must accept before we emit.
const { swaps, nullifiers, leaves } = route.verifyRoute(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });

const fixture = {
  note: '2-hop A→B→C confidential route; execute-mode validates the guest OP_SWAP_ROUTE dispatch + io order.',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  asset0: A,
  assetFinal: op.assetFinal,
  amountIn: Number(op.amountIn),
  amountOut: Number(op.amountOut),
  minOut: Number(op.minOut),
  deadline: 0,
  in: {
    cx: op.in.cx, cy: op.in.cy, owner: op.in.owner,
    leafIndex: op.in.leafIndex, path: op.in.path,
    sigR: op.inSig.R, sigZ: op.inSig.z,
  },
  out: {
    cx: op.out.cx, cy: op.out.cy, owner: op.out.owner,
    sigR: op.outSig.R, sigZ: op.outSig.z,
  },
  hops: op.hops.map((h) => ({
    assetNext: h.assetNext, feeBps: h.feeBps,
    reserveAPre: Number(h.reserveAPre), reserveBPre: Number(h.reserveBPre),
  })),
  expected: {
    nullifiers: nullifiers.length,
    leaves: leaves.length,
    swaps: swaps.length,
    amountOut: Number(op.amountOut),
  },
};

console.error(`route A→B→C amountIn=${amountIn} amountOut=${op.amountOut} hops=${op.hops.length} swaps=${swaps.length}`);
console.log(JSON.stringify(fixture, null, 2));
