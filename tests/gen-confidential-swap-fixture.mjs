#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/swap_op.json — a single A→B OP_SWAP batch the box's
// exec-swap harness feeds to the guest (execute → prove). Pool 1000/1000, swap 100 A in, price
// 90/100 ⇒ 90 B out, reserves → 1100/910 (k↑). The witness fields are emitted in the guest's
// io::read order; `expected` carries the PublicValues the guest must commit.
//
// Run: node tests/gen-confidential-swap-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap } from '../dapp/confidential-swap.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
const _ptHexK = (P) => (typeof P === 'string' ? P : '0x' + Buffer.from(P.toRawBytes(true)).toString('hex'));
const _scHexK = (v) => (typeof v === 'string' ? v : '0x' + BigInt(v).toString(16).padStart(64, '0'));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const _ct = makeConfidentialTransfer({ keccak256 });
const swap = makeConfidentialSwap({ keccak256, pool, kernelSign: _ct.kernelSign, rangeProve: _ct.rangeProve });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const OWNER_OUT = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);

// deterministic blindings so the fixture is reproducible
const det = (tag) => '0x' + keccak256(new TextEncoder().encode('cswap-fixture-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

const intent = swap.buildIntent({
  direction: 'A->B', amountIn: 100, priceNum: 90, priceDen: 100, minOut: 90,
  rInSecp: BigInt(det('in-secp')), rOutSecp: BigInt(det('out-secp')),
  nonceIn: BigInt(det('in-nonce')), nonceOut: BigInt(det('out-nonce')),
  inNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, outOwner: OWNER_OUT,
});

const tree = new pool.Tree();
const idx = tree.insert(pool.leaf(ASSET_A, intent.in.cx, intent.in.cy, intent.in.owner));
const { root, path } = tree.rootAndPath(idx);
intent.in.leafIndex = idx; intent.in.path = path;

const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: 30, reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100, intents: [intent], spendRoot: root });
const { settlement, nullifiers, leaves } = swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot: root,
  assetA: ASSET_A, assetB: ASSET_B,
  feeBps: 30,
  reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
  intents: [{
    direction: intent.dirByte,
    // Inputs are an ARRAY, each with its OWN value-hiding blind PoK. Membership binds each input's asset,
    // so a note of another asset simply is not in the tree under that leaf hash.
    inputs: [{
      cx: intent.in.cx, cy: intent.in.cy, owner: intent.in.owner,
      leafIndex: intent.in.leafIndex, path: intent.in.path,
      pokR: intent.inPok.R, pokZv: intent.inPok.zV, pokZr: intent.inPok.zR,
    }],
    amountIn: Number(intent.amountIn), fee: Number(intent.fee ?? 0),
    amountOut: Number(intent.amountOut), rem: Number(intent.rem),
    minOut: Number(intent.minOut),
    deadline: Number(intent.deadline ?? 0), // per-op Expired; bound in the sigma (buildIntent), read after minOut
    outCx: intent.out.cx, outCy: intent.out.cy, outOwner: intent.out.owner,
    outSigR: intent.outSig.R, outSigZ: intent.outSig.z,
    // Change is in the INPUT asset, never the output asset.
    change: (intent.change || []).map((c) => ({ cx: c.cx, cy: c.cy, owner: c.owner })),
    ...(intent.changeRangeProof ? { changeRangeProof: intent.changeRangeProof } : {}),
    changeKernelR: _ptHexK(intent.changeKernel.R), changeKernelZ: _scHexK(intent.changeKernel.z),
  }],
  expected: {
    poolId: settlement.poolId,
    reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost),
    nullifiers, leaves,
  },
};

const out = 'contracts/sp1/confidential/fixtures/swap_op.json';
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', out, '— A→B 100→90, reserves 1000/1000 →', fixture.expected.reserveAPost + '/' + fixture.expected.reserveBPost);
