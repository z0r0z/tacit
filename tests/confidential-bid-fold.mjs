#!/usr/bin/env node
// preauth-bid (T_PREAUTH_BID 0x5B exact-fill / T_PREAUTH_BID_VAR 0x5C partial-fill) — JS mirror. A bid fill
// is a CXFER on the tacit-asset side, so it folds via the IDENTICAL cxfer fold; the only bid-specific code is
// parsePreauthBidEnvelope (→ the cxfer { asset, kernelSig, commitments, rangeProof } shape) + the voutBase 1
// routing (notes start at vout[1], after the envelope-hash OP_RETURN). Validates the parser (round-trip 0x5C
// N=2 / 0x5B N=1 + reject cases), classifyConfidentialTx (→ cxfer, voutBase 1), and that a parsed conserving
// bid passes verifyCxferConservation (tamper ⇒ fail). End-to-end guest parity: gen-reflection-bid-synth.mjs.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { parsePreauthBidEnvelope, classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, varint, cat } from './btc-mini.mjs';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE, N = secp.CURVE.n;
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const ASSET = Uint8Array.from(Buffer.from('a1'.repeat(32), 'hex'));
const compress = (P) => P.toRawBytes(true);

// ── parser round-trip: build envelopes with KNOWN fields, parse, assert ──
function bidEnvelope(opcode, inlineLen, commitments, kernelSig, rangeProof) {
  const parts = [[opcode], Buffer.from(ASSET), Buffer.alloc(1), Buffer.alloc(inlineLen), Buffer.from(kernelSig), [commitments.length]];
  commitments.forEach((c, i) => { parts.push(Buffer.from(c)); if (i === 1) parts.push(Buffer.alloc(8)); });
  parts.push(u16le(rangeProof.length)); parts.push(Buffer.from(rangeProof));
  return cat(parts);
}
{
  const ks = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
  const c0 = compress(prover.commit(600n, 0x33n)), c1 = compress(prover.commit(400n, 0x44n));
  const rp = Uint8Array.from({ length: 40 }, (_, i) => 0x80 ^ i);
  const env5c = bidEnvelope(0x5C, 134, [c0, c1], ks, rp);
  const p = parsePreauthBidEnvelope(hx(env5c));
  ok(p, '0x5C (partial-fill) parses');
  eq(p.asset, hx(ASSET), '  asset');
  eq(p.kernelSig, hx(ks), '  kernel_sig');
  eq(p.commitments.length, 2, '  N=2 commitments');
  eq(p.commitments[0], hx(c0), '  commitment 0');
  eq(p.commitments[1], hx(c1), '  commitment 1 (after its amount_ct)');
  eq(p.rangeProof, hx(rp), '  rangeProof');

  const env5b = bidEnvelope(0x5B, 97, [c0], ks, rp); // exact-fill, N=1, shorter inline
  const q = parsePreauthBidEnvelope(hx(env5b));
  ok(q, '0x5B (exact-fill) parses');
  eq(q.commitments.length, 1, '  N=1 commitment');
  eq(q.commitments[0], hx(c0), '  commitment 0');
  eq(q.rangeProof, hx(rp), '  rangeProof');
}

// ── parser rejects ──
eq(parsePreauthBidEnvelope(hx(cat([[0x22], Buffer.alloc(200)]))), null, 'non-bid opcode (0x22) → null');
eq(parsePreauthBidEnvelope(hx(cat([[0x5C], Buffer.alloc(50)]))), null, 'truncated 0x5C → null');
{
  const ks = new Uint8Array(64), c0 = compress(prover.commit(1n, 1n));
  const bad = cat([[0x5C], Buffer.from(ASSET), Buffer.alloc(1), Buffer.alloc(134), Buffer.from(ks), [0x03], Buffer.from(c0), u16le(0)]); // N=3
  eq(parsePreauthBidEnvelope(hx(bad)), null, 'N=3 (only 1/2 allowed) → null');
}

// ── classifyConfidentialTx on a real bid tx → cxfer with voutBase 1 ──
{
  const ks = new Uint8Array(64), c0 = compress(prover.commit(600n, 0x33n)), c1 = compress(prover.commit(400n, 0x44n));
  const env = bidEnvelope(0x5C, 134, [c0, c1], ks, Uint8Array.from({ length: 8 }, (_, i) => i));
  const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([env.length & 0xff, (env.length >> 8) & 0xff]), env, [0x68]]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  const tx = cat([[0x02, 0, 0, 0], [0x00, 0x01], varint(1), Buffer.alloc(32, 0x5c), u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff], [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
  const d = classifyConfidentialTx('0x' + tx.toString('hex'));
  ok(d, 'bid tx classifies');
  eq(d.type, 'cxfer', '  type cxfer (folds via the cxfer fold)');
  eq(d.voutBase, 1, '  voutBase 1 (notes start at vout[1])');
  eq(d.commitments.length, 2, '  2 commitments');
  eq(d.assetId, hx(ASSET), '  assetId');
}

// ── a parsed conserving bid passes verifyCxferConservation; a tampered kernel fails ──
{
  const seller = { d: 1000n, r: 0x1111n, txid: '0x' + 'aa'.repeat(32), vout: 0 };
  const outs = [{ d: 600n, r: 0x3333n }, { d: 400n, r: 0x4444n }];
  const Cin = prover.commit(seller.d, seller.r), Cout = outs.map((o) => prover.commit(o.d, o.r));
  const { proof: rangeProof } = bppRangeProve(outs.map((o) => o.d), outs.map((o) => o.r));
  const excess = ((seller.r - outs.reduce((s, o) => s + o.r, 0n)) % N + N) % N;
  const dsign = (() => { let d = excess % N; if (G.multiply(d).toAffine().y & 1n) d = N - d;
    const Px = be(G.multiply(d).toAffine().x); let k = bytesToBig(sha256(_cat([be(d), msg()]))) % N; if (G.multiply(k).toAffine().y & 1n) k = N - k;
    const Rx = be(G.multiply(k).toAffine().x); const th = (t, m) => { const h = sha256(new TextEncoder().encode(t)); return sha256(_cat([h, h, m])); };
    const e = bytesToBig(th('BIP0340/challenge', _cat([Rx, Px, msg()]))) % N; return _cat([Rx, be((k + e * d) % N)]); });
  function msg() { const parts = [new TextEncoder().encode('tacit-kernel-v1'), ASSET, new Uint8Array([1]), Buffer.from(seller.txid.slice(2), 'hex'), u32le(seller.vout), new Uint8Array([2])]; for (const C of Cout) parts.push(compress(C)); parts.push(u64le(0)); return sha256(_cat(parts.map((x) => Uint8Array.from(x)))); }
  const sig = dsign();
  const env = bidEnvelope(0x5C, 134, Cout.map(compress), sig, rangeProof);
  const d = parsePreauthBidEnvelope(hx(env));
  const conserveArgs = (kernelSig) => ({ asset: d.asset, inputOutpoints: [[seller.txid, seller.vout]], inputPoints: [Cin], outsCompressed: d.commitments, rangeProof: d.rangeProof, kernelSig });
  ok(pool.verifyCxferConservation(conserveArgs(d.kernelSig)), 'parsed conserving bid passes verifyCxferConservation');
  ok(!pool.verifyCxferConservation(conserveArgs('0x' + 'de'.repeat(64))), 'tampered kernel fails conservation');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
