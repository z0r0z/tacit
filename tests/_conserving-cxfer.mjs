// Test helper: build a CONSERVING zero-value Bitcoin CXFER for the reflection scan tests. With no
// detected pool inputs (Σ C_in = 0), conservation requires Σ C_out = 0 — so each output is a
// commitment to value 0 with blinding k (C = k·G, matching the tests' `commit(k)`). The kernel
// signs the excess −Σk and the BP+ range covers the zero values, so the conservation gate
// (dapp verifyCxferConservation) folds it. Returns the envelope additions a cxfer decode/env needs:
// { commitments:[compressed hex], kernelSig, rangeProof }.

import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m)); // signSchnorr / bppRangeProve nonces
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const N = secp.CURVE.n;
const modN = (n) => ((n % N) + N) % N;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32hex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, '').padStart(64, '0'), 'hex'));
const be32 = (n) => Uint8Array.from(Buffer.from(modN(n).toString(16).padStart(64, '0'), 'hex'));
const compress = (k) => secp.ProjectivePoint.BASE.multiply(modN(BigInt(k))).toRawBytes(true);

export function conservingZeroCxfer(assetIdHex, blindings) {
  const ks = blindings.map((k) => modN(BigInt(k)));
  const comps = ks.map(compress);
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), b32hex(assetIdHex), Uint8Array.of(0), Uint8Array.of(comps.length)];
  for (const c of comps) parts.push(c);
  parts.push(new Uint8Array(8)); // burned = 0
  const msg = sha256(_cat(parts));
  const excess = ks.reduce((s, k) => s - k, 0n);     // P = Σin − Σout = (−Σk)·G  ⇒ key = −Σk
  const kernelSig = hx(signSchnorr(msg, be32(excess)));
  const rangeProof = hx(bppRangeProve(ks.map(() => 0n), ks).proof);
  return { commitments: comps.map(hx), kernelSig, rangeProof };
}
