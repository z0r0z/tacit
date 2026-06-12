#!/usr/bin/env node
// REFLECT-1: the worker's CXFER value-conservation gate (dapp verifyCxferConservation /
// cxferKernelVerify) is a faithful JS mirror of the reflection guest's cxfer-core
// verify_cxfer_conservation (kernel + BP+ range). If a confirmed Bitcoin tx carries a CXFER
// envelope that does NOT conserve value, the guest skips its outputs (folds nothing); the worker
// must reach the SAME verdict so its canonical pool root stays byte-identical to what the guest
// proves. This test cross-checks the kernel against the Rust-validated fixture (cxfer_kernel.json,
// the same file cxfer-core's cxfer_kernel_verify_accepts_real_sig_rejects_tamper asserts), exercises
// the full kernel+range predicate on a constructed conserving cxfer, and verifies the assembler
// SKIPS a non-conserving cxfer (no note folded, inputs still nullified).
//
// Run: node tests/confidential-reflection-conservation.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m)); // signSchnorr / bppRangeProve nonces
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE;
const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const compress = (P) => hx(P.toRawBytes(true));
const be32 = (n) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex'));

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`ok   ${msg}`); else { console.error(`FAIL ${msg}`); failures++; } };

// ── 1. Kernel cross-impl vs the Rust-validated fixture ──────────────────────────────────────────
// cxfer_kernel.json is asserted accepted by cxfer-core::cxfer_kernel_verify; the JS kernel must agree.
const fx = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/cxfer_kernel.json', import.meta.url)));
const fInOutpoints = fx.inputs.map((i) => [i.txid, i.vout]);
const fInPoints = fx.inputs.map((i) => secp.ProjectivePoint.fromHex(i.commitment.replace(/^0x/, '')));
const fOuts = fx.outputs.map((o) => o.commitment);

ok(pool.cxferKernelVerify({ asset: fx.asset, inputOutpoints: fInOutpoints, inputPoints: fInPoints, outsCompressed: fOuts, kernelSig: fx.kernelSig }),
  'JS kernel ACCEPTS the Rust-validated fixture sig');

// tamper the sig → reject (mirrors the Rust KAT "tampered sig rejected")
const badSig = fx.kernelSig.slice(0, -2) + (fx.kernelSig.endsWith('00') ? '01' : '00');
ok(!pool.cxferKernelVerify({ asset: fx.asset, inputOutpoints: fInOutpoints, inputPoints: fInPoints, outsCompressed: fOuts, kernelSig: badSig }),
  'JS kernel REJECTS a tampered sig');
// reordered outputs → different msg → reject (mirrors "reordered outputs rejected")
ok(!pool.cxferKernelVerify({ asset: fx.asset, inputOutpoints: fInOutpoints, inputPoints: fInPoints, outsCompressed: [fOuts[1], fOuts[0]], kernelSig: fx.kernelSig }),
  'JS kernel REJECTS reordered outputs');
// wrong asset → different msg → reject (mirrors "wrong asset rejected")
ok(!pool.cxferKernelVerify({ asset: '0x' + '00'.repeat(32), inputOutpoints: fInOutpoints, inputPoints: fInPoints, outsCompressed: fOuts, kernelSig: fx.kernelSig }),
  'JS kernel REJECTS a wrong asset');
// drop an input → Σin ≠ Σout → reject (the REFLECT-1 inflation class: outputs not backed by inputs)
ok(!pool.cxferKernelVerify({ asset: fx.asset, inputOutpoints: fInOutpoints.slice(1), inputPoints: fInPoints.slice(1), outsCompressed: fOuts, kernelSig: fx.kernelSig }),
  'JS kernel REJECTS a missing input (non-conservation)');

// ── 2. Full kernel+range predicate on a constructed conserving cxfer ─────────────────────────────
const ASSET = '0x' + 'cd'.repeat(32);
const ins = [{ d: 700n, r: 0x55n, txid: '0x' + 'a1'.repeat(32), vout: 0 }, { d: 300n, r: 0x66n, txid: '0x' + 'b2'.repeat(32), vout: 3 }];
const outs = [{ d: 600n, r: 0x77n }, { d: 400n, r: 0x88n }]; // Σ in = Σ out = 1000, burned = 0
const Cin = ins.map((i) => prover.commit(i.d, i.r));
const Cout = outs.map((o) => prover.commit(o.d, o.r));
const inOutpoints = ins.map((i) => [i.txid, i.vout]);
const outsCompressed = Cout.map(compress);
const excess = ((ins.reduce((s, i) => s + i.r, 0n) - outs.reduce((s, o) => s + o.r, 0n)) % N + N) % N;

// kernel message must be byte-identical to the guest's; sign with the excess key (P = Σin − Σout)
const msgParts = [new TextEncoder().encode('tacit-kernel-v1'), be32(BigInt(ASSET)), Uint8Array.of(ins.length)];
for (const i of ins) { msgParts.push(be32(BigInt(i.txid))); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, i.vout, true); msgParts.push(b); }
msgParts.push(Uint8Array.of(outs.length));
for (const c of outsCompressed) msgParts.push(Uint8Array.from(Buffer.from(c.replace(/^0x/, ''), 'hex')));
msgParts.push(new Uint8Array(8)); // burned = 0
const kernelMsg = sha256(_cat(msgParts));
const kernelSig = hx(signSchnorr(kernelMsg, be32(excess)));
const rangeProof = hx(bppRangeProve(outs.map((o) => o.d), outs.map((o) => o.r)).proof);

ok(pool.verifyCxferConservation({ asset: ASSET, inputOutpoints: inOutpoints, inputPoints: Cin, outsCompressed, rangeProof, kernelSig }),
  'full conservation ACCEPTS a conserving cxfer (kernel + range)');
// a valid-shape range proof over the WRONG values → range fails → reject
const wrongRange = hx(bppRangeProve([601n, 399n], [0x77n, 0x88n]).proof);
ok(!pool.verifyCxferConservation({ asset: ASSET, inputOutpoints: inOutpoints, inputPoints: Cin, outsCompressed, rangeProof: wrongRange, kernelSig }),
  'full conservation REJECTS a mismatched range proof');
// a missing field is a wiring bug, not a silent drop → throws
let threw = false; try { pool.verifyCxferConservation({ asset: ASSET, inputOutpoints: inOutpoints, inputPoints: Cin, outsCompressed, kernelSig }); } catch { threw = true; }
ok(threw, 'full conservation THROWS on a missing rangeProof (wiring bug, not a silent drop)');

// ── 3. Assembler SKIPS a non-conserving cxfer (no note folded, inputs still nullified) ───────────
// Seed a scan state with one live pool note (the cxfer's single input), then feed a cxfer tx whose
// single output is INFLATED (well-formed range proof, but Σin ≠ Σout so the kernel won't verify).
const norm = (x) => pool._internal.hx(pool._internal.b32(x));
const st = pool.makeScanReflectionState();
const coords = new Map();
const prevTxid = '0x' + 'fe'.repeat(32);
const inKey = pool.outpointKey(prevTxid, 0);
const inCxHex = '0x' + Cin[0].toAffine().x.toString(16).padStart(64, '0');
const inCyHex = '0x' + Cin[0].toAffine().y.toString(16).padStart(64, '0');
// place the input note live + known coords (as a prior attested note would be), under the
// cxfer's own asset so the skip here is purely the non-conservation (not asset preservation).
st._acc.live.insert(inKey, pool.commitmentHash(inCxHex, inCyHex), ASSET);
coords.set(norm(inKey), { cx: inCxHex, cy: inCyHex });
const noteRootBefore = st.poolRoot();
const spentRootBefore = st.spentRoot();

// an INFLATED single output (value 5000, well-formed range proof) — kernel won't verify (Σin=700≠5000)
const infl = { d: 5000n, r: 0x99n };
const inflC = prover.commit(infl.d, infl.r);
const inflCompressed = compress(inflC);
const inflRange = hx(bppRangeProve([infl.d], [infl.r]).proof);
const { cx: ocx, cy: ocy } = pool.decompressCommitment(inflCompressed);
const cxferTx = {
  txData: '0x00', txid: '0x' + 'cc'.repeat(32),
  vins: [{ prevTxid: prevTxid, vout: 0 }],
  env: {
    type: 'cxfer', assetId: ASSET, kernelSig, rangeProof: inflRange,
    outputs: [{ cx: ocx, cy: ocy, compressed: inflCompressed, commitmentHash: pool.commitmentHash(ocx, ocy), noteLeaf: pool.leaf(ASSET, ocx, ocy, '0x' + '00'.repeat(32)), vout: 0 }],
  },
};
const asm = pool.assembleReflectionScanInput(st, { anchorHeight: 0, headers: [], blocks: [{ txs: [cxferTx] }] }, coords);

ok(asm.nonConserving.length === 1 && asm.nonConserving[0].txid === cxferTx.txid, 'assembler flags the non-conserving cxfer');
ok(asm.blocks[0].txs[0].outputs.length === 0, 'assembler folds NO output for the non-conserving cxfer');
ok(st.poolRoot() === noteRootBefore, 'note root UNCHANGED (no phantom note injected)');
ok(asm.blocks[0].txs[0].spentInserts.length === 1 && st.spentRoot() !== spentRootBefore, 'the cxfer input is still nullified (spent root advanced)');

// ── 4. Assembler SKIPS an asset-RELABELING cxfer (cross-asset inflation) ─────────────────────────
// The kernel only labels its message with `asset`, so a GENUINELY value-conserving cxfer can spend
// CHEAP-asset notes and declare DEAR-asset (ASSET) outputs of equal commitment-value. The assembler
// (mirroring the guest's fold_cxfer asset-preservation gate) must SKIP it — fold no dear note,
// while still nullifying the spent cheap inputs. Pre-fix this minted the relabeled note.
const CHEAP = '0x' + 'c4'.repeat(32);
ok(CHEAP !== ASSET, 'the cheap (input) asset differs from the dear (envelope) asset');
const st2 = pool.makeScanReflectionState();
const coords2 = new Map();
// seed BOTH conserving-fixture inputs live, but under the CHEAP asset (the notes' real asset)
for (let i = 0; i < ins.length; i++) {
  const k = pool.outpointKey(ins[i].txid, ins[i].vout);
  const cx = '0x' + Cin[i].toAffine().x.toString(16).padStart(64, '0');
  const cy = '0x' + Cin[i].toAffine().y.toString(16).padStart(64, '0');
  st2._acc.live.insert(k, pool.commitmentHash(cx, cy), CHEAP);
  coords2.set(norm(k), { cx, cy });
}
const noteRootBefore2 = st2.poolRoot();
const spentRootBefore2 = st2.spentRoot();
// the conserving cxfer (asset = ASSET = dear), reusing the §2 kernelSig/outs/range built above
const relabelTx = {
  txData: '0x00', txid: '0x' + 'ab'.repeat(32),
  vins: ins.map((i) => ({ prevTxid: i.txid, vout: i.vout })),
  env: {
    type: 'cxfer', assetId: ASSET, kernelSig, rangeProof,
    outputs: Cout.map((C, j) => { const c = compress(C); const { cx, cy } = pool.decompressCommitment(c); return { cx, cy, compressed: c, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(ASSET, cx, cy, '0x' + '00'.repeat(32)), vout: j }; }),
  },
};
const asm2 = pool.assembleReflectionScanInput(st2, { anchorHeight: 0, headers: [], blocks: [{ txs: [relabelTx] }] }, coords2);
ok(asm2.nonConserving.length === 1 && asm2.nonConserving[0].reason === 'non-asset-preserving', 'assembler flags the relabel as non-asset-preserving');
ok(asm2.blocks[0].txs[0].outputs.length === 0, 'assembler folds NO dear note for the relabeling cxfer');
ok(st2.poolRoot() === noteRootBefore2, 'note root UNCHANGED (no relabeled dear note injected)');
ok(asm2.blocks[0].txs[0].spentInserts.length === 2 && st2.spentRoot() !== spentRootBefore2, 'the cheap inputs are still nullified (the relabel burns them for nothing)');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
