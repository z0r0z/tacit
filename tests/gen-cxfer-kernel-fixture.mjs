#!/usr/bin/env node
// Generate a Bitcoin T_CXFER_BPP kernel-signature fixture for cxfer-core's
// cxfer_kernel_verify. The Bitcoin confidential-transfer kernel proves conservation
// as a BIP-340 Schnorr signature over the kernel message, with verify key
//   P = Σ C_in − Σ C_out − burned·H   (= excess·G, the blinding residue).
// kernel_msg = sha256("tacit-kernel-v1" ‖ asset ‖ in_count ‖ (txid ‖ vout_LE)×in ‖
//                     out_count ‖ commitment(33)×out ‖ burned_LE8).
// Pure transfer here (burned = 0, Σ v_in = Σ v_out), so the H term drops and the KAT
// is independent of the H generator.
//
// Run: node tests/gen-cxfer-kernel-fixture.mjs > contracts/sp1/confidential/fixtures/cxfer_kernel.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE;
const N = secp.CURVE.n;
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Number(BigInt(n) & 0xffffffffn), true); v.setUint32(4, Number((BigInt(n) >> 32n) & 0xffffffffn), true); return b; };
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const compress = (P) => P.toRawBytes(true);

function taggedHash(tag, msg) {
  const th = sha256(new TextEncoder().encode(tag));
  return sha256(_cat([th, th, msg]));
}
// BIP-340 sign with private scalar d (deterministic nonce; matches dapp verifySchnorr).
function bip340Sign(msg, dIn) {
  let d = dIn % N; if (d === 0n) throw new Error('zero key');
  if (G.multiply(d).toAffine().y & 1n) d = N - d; // even-y key
  const P = G.multiply(d);
  const Px = be(P.toAffine().x);
  let k = bytesToBig(sha256(_cat([be(d), msg]))) % N; if (k === 0n) k = 1n;
  if (G.multiply(k).toAffine().y & 1n) k = N - k; // even-y nonce
  const R = G.multiply(k);
  const Rx = be(R.toAffine().x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', _cat([Rx, Px, msg]))) % N;
  const s = (k + e * d) % N;
  return { sig: _cat([Rx, be(s)]), px: Px };
}

const ASSET = Uint8Array.from(Buffer.from('aa'.repeat(32), 'hex'));
// 2 inputs, 2 outputs; Σ value_in = Σ value_out = 1000 (burned = 0)
const ins = [{ d: 700n, r: 0x1111n, txid: Uint8Array.from(Buffer.from('11'.repeat(32), 'hex')), vout: 0 },
             { d: 300n, r: 0x2222n, txid: Uint8Array.from(Buffer.from('22'.repeat(32), 'hex')), vout: 1 }];
const outs = [{ d: 600n, r: 0x3333n }, { d: 400n, r: 0x4444n }];

const Cin = ins.map((i) => prover.commit(i.d, i.r));
const Cout = outs.map((o) => prover.commit(o.d, o.r));
const excess = ((ins.reduce((s, i) => s + i.r, 0n) - outs.reduce((s, o) => s + o.r, 0n)) % N + N) % N;

// kernel message
const msgParts = [new TextEncoder().encode('tacit-kernel-v1'), ASSET, new Uint8Array([ins.length])];
for (const i of ins) { msgParts.push(i.txid); msgParts.push(u32le(i.vout)); }
msgParts.push(new Uint8Array([outs.length]));
for (const C of Cout) msgParts.push(compress(C));
msgParts.push(u64le(0));
const kernelMsg = sha256(_cat(msgParts));

const { sig, px } = bip340Sign(kernelMsg, excess);
// sanity: P = Σ Cin − Σ Cout, x-only must equal the signer's pubkey x
const P = Cin.reduce((a, c) => a.add(c), secp.ProjectivePoint.ZERO).add(Cout.reduce((a, c) => a.add(c), secp.ProjectivePoint.ZERO).negate());
if (Buffer.compare(Buffer.from(compress(P).slice(1)), Buffer.from(px)) !== 0) throw new Error('verify-key x mismatch');

process.stdout.write(JSON.stringify({
  note: 'Bitcoin T_CXFER_BPP kernel-sig fixture for cxfer-core::cxfer_kernel_verify (burned=0).',
  asset: hx(ASSET),
  burnedAmount: '0',
  inputs: ins.map((i, j) => ({ txid: hx(i.txid), vout: i.vout, commitment: hx(compress(Cin[j])) })),
  outputs: outs.map((o, j) => ({ commitment: hx(compress(Cout[j])) })),
  kernelMsg: hx(kernelMsg),
  kernelSig: hx(sig),
}, null, 2) + '\n');
