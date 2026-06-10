#!/usr/bin/env node
// REFLECT-1 DIFFERENTIAL: generate adversarial CXFER conservation vectors + the JS verdict
// (dapp verifyCxferConservation), so a Rust test (cxfer-core) can assert verify_cxfer_conservation
// reaches the SAME verdict byte-for-byte. A divergence (one accepts, the other rejects) on any
// confirmed envelope desyncs the reflection witness stream (the guest reads output witnesses only
// for conserving cxfers; the assembler emits them under the same condition) → wrong roots / panic.
//
// Run: node tests/gen-cxfer-conservation-differential.mjs > /tmp/cxfer_conservation_diff.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
const modN = (n) => ((n % N) + N) % N;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const compress = (P) => hx(P.toRawBytes(true));
const be32 = (n) => Uint8Array.from(Buffer.from(modN(n).toString(16).padStart(64, '0'), 'hex'));
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
// commit handling value 0 (noble rejects scalar 0 in multiply): 0·H + r·G == r·G.
const commitV = (d, r) => (BigInt(d) === 0n ? secp.ProjectivePoint.BASE.multiply(modN(r)) : prover.commit(BigInt(d), modN(r)));

// Build the kernel msg + a sig under the excess key P = Σ C_in − Σ C_out (burned=0).
function kernelSigFor(asset, ins, outBlind, outVal) {
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), be32(BigInt(asset)), Uint8Array.of(ins.length & 0xff)];
  for (const i of ins) { parts.push(be32(BigInt(i.txid))); parts.push(u32le(i.vout)); }
  const comps = outBlind.map((r, j) => compress(commitV(outVal[j], r)));
  parts.push(Uint8Array.of(comps.length & 0xff));
  for (const c of comps) parts.push(Uint8Array.from(Buffer.from(c.replace(/^0x/, ''), 'hex')));
  parts.push(new Uint8Array(8)); // burned = 0
  const msg = sha256(_cat(parts));
  const inR = ins.reduce((s, i) => s + i.r, 0n);
  const outR = outBlind.reduce((s, r) => s + r, 0n);
  const excess = modN(inR - outR);
  return { comps, kernelSig: hx(signSchnorr(msg, be32(excess))) };
}

function vec(name, asset, ins, outBlind, outVal, mutate) {
  const inOutpoints = ins.map((i) => [i.txid, i.vout]);
  const inPoints = ins.map((i) => commitV(i.d, i.r));
  let { comps, kernelSig } = kernelSigFor(asset, ins, outBlind, outVal);
  let rangeProof = hx(bppRangeProve(outVal, outBlind).proof);
  let outsCompressed = comps.slice();
  if (mutate) ({ outsCompressed, kernelSig, rangeProof } = mutate({ outsCompressed, kernelSig, rangeProof, asset }) || { outsCompressed, kernelSig, rangeProof });
  let jsVerdict;
  try {
    jsVerdict = pool.verifyCxferConservation({
      asset, inputOutpoints: inOutpoints,
      inputPoints: inPoints, outsCompressed, rangeProof, kernelSig,
    });
  } catch (e) { jsVerdict = 'throw:' + e.message; }
  return {
    name, asset,
    inputs: ins.map((i, j) => ({ txid: i.txid, vout: i.vout, commitment: compress(inPoints[j]) })),
    outsCompressed, kernelSig, rangeProof, jsVerdict,
  };
}

const ASSET = '0x' + 'cd'.repeat(32);
const T = (b) => '0x' + b.repeat(32);
const ins2 = [{ d: 700n, r: 0x55n, txid: T('a1'), vout: 0 }, { d: 300n, r: 0x66n, txid: T('b2'), vout: 3 }];
const ins1 = [{ d: 1000n, r: 0x42n, txid: T('c3'), vout: 1 }];

const vectors = [];
// 1. honest conserving (m=2)
vectors.push(vec('conserving_m2', ASSET, ins2, [0x77n, 0x88n], [600n, 400n]));
// 2. honest conserving (m=1)
vectors.push(vec('conserving_m1', ASSET, ins1, [0x99n], [1000n]));
// 3. inflated output (Σout > Σin) — kernel must reject on both
vectors.push(vec('inflated_out', ASSET, ins2, [0x77n, 0x88n], [600n, 5000n]));
// 4. tampered sig (flip last byte) — reject both
vectors.push(vec('tampered_sig', ASSET, ins2, [0x77n, 0x88n], [600n, 400n], (e) => ({ ...e, kernelSig: e.kernelSig.slice(0, -2) + (e.kernelSig.endsWith('00') ? '01' : '00') })));
// 5. tampered range proof (flip a mid byte) — reject both
vectors.push(vec('tampered_range', ASSET, ins2, [0x77n, 0x88n], [600n, 400n], (e) => { const b = Buffer.from(e.rangeProof.replace(/^0x/, ''), 'hex'); b[200] ^= 1; return { ...e, rangeProof: '0x' + b.toString('hex') }; }));
// 6. reordered outputs (different kernel msg) — reject both
vectors.push(vec('reordered_outs', ASSET, ins2, [0x77n, 0x88n], [600n, 400n], (e) => ({ ...e, outsCompressed: [e.outsCompressed[1], e.outsCompressed[0]] })));
// 7. range proof for the WRONG values (valid shape, wrong commitments) — reject both
vectors.push(vec('mismatched_range', ASSET, ins2, [0x77n, 0x88n], [600n, 400n], (e) => ({ ...e, rangeProof: hx(bppRangeProve([601n, 399n], [0x77n, 0x88n]).proof) })));
// 8. non-canonical compressed output point: prefix 0x02 with x = field prime p (>= p, off-curve garbage)
const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
vectors.push(vec('noncanonical_x_ge_p', ASSET, ins2, [0x77n, 0x88n], [600n, 400n], (e) => ({ ...e, outsCompressed: [e.outsCompressed[0], '0x02' + SECP_P.toString(16).padStart(64, '0')] })));
// 9. output point = compressed identity-ish (all zeros) — decompress fails both
vectors.push(vec('zero_output_point', ASSET, ins2, [0x77n, 0x88n], [600n, 400n], (e) => ({ ...e, outsCompressed: [e.outsCompressed[0], '0x' + '00'.repeat(33)] })));
// 10. zero-input cxfer minting NON-zero value: Σin=0 forces Σ value_out=0; this signs over an excess
//     that does NOT cover a non-zero value — must reject both (mint-from-nothing class).
vectors.push((() => {
  // Zero inputs (Σin = 0), one real output to value 50 / blinding 0x11. The kernel verify key is
  // P = −C_out = −(50·H + 0x11·G); the attacker cannot sign under it (needs dlog(H)), so they sign
  // with the dlog-known key −0x11 (as if value were 0). The kernel message is built over the REAL
  // (value-50) wire commitment, so the challenge e is honest, but the sig was made for the wrong key
  // → reject on both sides. This is the mint-from-nothing class.
  const asset = ASSET;
  const realPt = prover.commit(50n, 0x11n);
  const realComp = compress(realPt);
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), be32(BigInt(asset)), Uint8Array.of(0), Uint8Array.of(1)];
  parts.push(Uint8Array.from(Buffer.from(realComp.replace(/^0x/, ''), 'hex')));
  parts.push(new Uint8Array(8));
  const msg = sha256(_cat(parts));
  const kernelSig = hx(signSchnorr(msg, be32(modN(-0x11n)))); // sign for −blinding (value-0 excess)
  const rangeProof = hx(bppRangeProve([50n], [0x11n]).proof);
  let jsVerdict;
  try {
    jsVerdict = pool.verifyCxferConservation({ asset, inputOutpoints: [], inputPoints: [], outsCompressed: [realComp], rangeProof, kernelSig });
  } catch (e) { jsVerdict = 'throw:' + e.message; }
  return { name: 'zero_input_mint_nonzero', asset, inputs: [], outsCompressed: [realComp], kernelSig, rangeProof, jsVerdict };
})());

console.log(JSON.stringify({ vectors }, null, 2));
console.error(`generated ${vectors.length} vectors; JS verdicts: ` + vectors.map((v) => `${v.name}=${v.jsVerdict}`).join(', '));
