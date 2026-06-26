#!/usr/bin/env node
// Build a real wrap→transfer round-trip for the live ConfidentialPool settle relay.
//
// Emits two op witnesses (the same JSON shape the box harnesses read):
//   wrap_op.json     — OP_WRAP: consume the on-chain pending deposit into tree leaf 0.
//   transfer_op.json — OP_TRANSFER: spend leaf 0 → a fresh output note (1-in / 1-out, value conserved).
//
// The note's (value, blinding) are deterministic from SEED here so the box's `wrap(...)` call escrows
// the matching commitment. Self-checks the transfer (range + conservation) and the membership path
// before writing, so a bad op is caught locally, not by a wasted GPU prove.
//
//   node tests/e2e-confidential-settle.mjs <OUTDIR> <ASSET_ID> <CHAIN_BINDING> [VALUE]
//   -> writes <OUTDIR>/wrap_op.json + transfer_op.json, prints the wrap() args + expected post-wrap root.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const xfer = makeConfidentialTransfer({ keccak256: keccak_256 });

const [OUTDIR, ASSET, CHAIN_BINDING, VALUE_ARG] = process.argv.slice(2);
if (!OUTDIR || !ASSET || !CHAIN_BINDING) { console.error('usage: e2e-confidential-settle.mjs <OUTDIR> <ASSET_ID> <CHAIN_BINDING> [VALUE]'); process.exit(1); }

const V = BigInt(VALUE_ARG || '1000');                 // in-system value (= wei escrowed, unitScale 1)
const OWNER = '0x' + '11'.repeat(32);                  // arbitrary 32-byte owner field
const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: be32(a.x), cy: be32(a.y) }; };
// deterministic-but-distinct blindings (keccak of a tag) reduced into the scalar field, never 0
const scalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-e2e:' + tag)))) % N; return s || 1n; };

const rIn = scalar('in-blinding');
const rOut = scalar('out-blinding');

// ── the note: C_in = V·H + rIn·G (the assembler's commit == the guest's H/G) ──
const Cin = xfer.commit(V, rIn);
const { cx, cy } = xy(Cin);
const leaf0 = pool.leaf(ASSET, cx, cy, OWNER);

// ── OP_WRAP witness: prove C opens to (V, rIn), emit leaf + deposit id ──
const wrapOp = { chainBinding: CHAIN_BINDING, asset: ASSET, value: V.toString(), cx, cy, owner: OWNER, blinding: be32(rIn) };

// ── the tree after the wrap settle: leaf 0 only → root R1 + its membership path ──
const tree = new pool.Tree();
tree.insert(leaf0);
const { root: R1, path: path0 } = tree.rootAndPath(0);
if (!pool.verifyPath(leaf0, 0, path0, R1)) throw new Error('membership self-check failed');

// ── OP_TRANSFER witness: spend leaf 0 → one fresh output of the same value ──
const t = xfer.buildTransfer({ inputs: [{ value: V, blinding: rIn }], outputs: [{ value: V, blinding: rOut, owner: OWNER }], assetId: ASSET });
if (!xfer.verifyTransfer(t)) throw new Error('transfer range/conservation self-check failed');
const inXY = xy(t.inC[0]);
if (inXY.cx !== cx || inXY.cy !== cy) throw new Error('input commitment != wrapped note (H/G mismatch)');
const outXY = xy(t.outC[0]);
const transferOp = {
  chainBinding: CHAIN_BINDING, spendRoot: R1, asset: ASSET,
  inputs: [{ cx, cy, owner: OWNER, leafIndex: 0, path: path0, secret: '0x' + '00'.repeat(32) }],
  outputs: [{ cx: outXY.cx, cy: outXY.cy, owner: OWNER }],
  rangeProof: hx(t.rangeProof),
  kernel: { R: hx(xfer._ptBytes(t.kernel.R)), z: be32(t.kernel.z) },
};

await fs.mkdir(OUTDIR, { recursive: true });
await fs.writeFile(path.join(OUTDIR, 'wrap_op.json'), JSON.stringify(wrapOp, null, 2));
await fs.writeFile(path.join(OUTDIR, 'transfer_op.json'), JSON.stringify(transferOp, null, 2));

console.log('value            ', V.toString(), '(wei to escrow in wrap)');
console.log('asset            ', ASSET);
console.log('cx               ', cx);
console.log('cy               ', cy);
console.log('owner            ', OWNER);
console.log('leaf0            ', leaf0);
console.log('expected post-wrap currentRoot (R1):', R1);
console.log('depositId        ', pool.depositId(ASSET, V, cx, cy, OWNER));
console.log('nullifier(in)    ', pool.nullifier(cx, cy));
console.log('wrote            ', path.join(OUTDIR, 'wrap_op.json'), '+ transfer_op.json');
console.log('');
console.log('WRAP_ARGS', ASSET, V.toString(), cx, cy, OWNER); // for the box: cast send wrap(...)
