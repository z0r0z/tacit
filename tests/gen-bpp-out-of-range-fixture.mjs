#!/usr/bin/env node
// BPP-1: emit a FORGED out-of-range BP+ proof (V commits v=2^64, the inflation-critical case the
// verifier MUST reject) + an honest 2^64-1 proof (the max in-range value it MUST accept), so the
// Rust on-chain verify_range gets an explicit negative test on the no-inflation root primitive.
//   node tests/gen-bpp-out-of-range-fixture.mjs > contracts/sp1/confidential/fixtures/bpp_out_of_range.json
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as bpp from '../dapp/bulletproofs-plus.js';

const cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, cat(m));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const g = 0x1111111111111111111111111111111111111111111111111111111111111111n;

// Forged: V commits v=2^64 (out of range), the bit-decomposition is of v mod 2^64 (all-zero low 64 bits).
const oor = bpp.bppRangeProve([1n << 64n], [g], true);
// Honest max in-range value 2^64-1 (boundary): must still verify (no false reject).
const ok = bpp.bppRangeProve([(1n << 64n) - 1n], [g]);

process.stdout.write(JSON.stringify({
  note: 'BPP-1: a FORGED out-of-range BP+ proof (V commits 2^64) the verifier MUST reject, + an honest 2^64-1 it MUST accept.',
  outOfRange: { commitment: hx(oor.commitments[0].toRawBytes(true)), proof: hx(oor.proof) },
  honestMax: { commitment: hx(ok.commitments[0].toRawBytes(true)), proof: hx(ok.proof) },
}, null, 2) + '\n');
