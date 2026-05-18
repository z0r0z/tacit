// Extract the BP rangeproof from a confirmed on-chain T_SWAP_ROUTE and
// run BOTH the reference verifier (tests/bulletproofs.mjs) and the
// worker's version to find which throws and where.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';
import { decodeSwapRoute } from './swap-route.mjs';
import { bpRangeAggVerify as refVerify, _bpGens, pedersenCommit } from './bulletproofs.mjs';

const ROUTE_TXID = process.argv[2] || 'c732c94a41aa23c004cdc06678c52c2271c446c263f28661a3217727de7dba55';
const ESPLORA = 'https://mempool.space/signet/api';

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function extractEnvelopePayload(scriptHex) {
  const s = hexToBytes(scriptHex);
  const TACIT = new TextEncoder().encode('TACIT');
  let idx = 0;
  while (idx < s.length - TACIT.length) {
    let m = true;
    for (let i = 0; i < TACIT.length; i++) if (s[idx + i] !== TACIT[i]) { m = false; break; }
    if (m) break;
    idx++;
  }
  let p = idx + TACIT.length + 2;
  const chunks = [];
  while (p < s.length) {
    const op = s[p];
    if (op === 0x68) break;
    if (op === 0x4d) {
      const ln = s[p + 1] | (s[p + 2] << 8);
      chunks.push(s.slice(p + 3, p + 3 + ln)); p += 3 + ln;
    } else if (op === 0x4c) {
      const ln = s[p + 1]; chunks.push(s.slice(p + 2, p + 2 + ln)); p += 2 + ln;
    } else if (op >= 0x01 && op <= 0x4b) {
      chunks.push(s.slice(p + 1, p + 1 + op)); p += 1 + op;
    } else break;
  }
  const payload = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0; for (const c of chunks) { payload.set(c, off); off += c.length; }
  return payload;
}

const tx = await jget(`${ESPLORA}/tx/${ROUTE_TXID}`);
const payload = extractEnvelopePayload(tx.vin[0].witness[1]);
const sr = decodeSwapRoute(payload);
console.log(`route ${ROUTE_TXID.slice(0,16)}…  deltaOutLast (last hop B): ${sr.hops[1].deltaBNetMag}`);

const rangeProof = sr.rangeProof;
const cReceiptSecp = sr.cReceiptSecp;
const ZERO = secp.ProjectivePoint.ZERO;
const cReceiptPt = secp.ProjectivePoint.fromHex(bytesToHex(cReceiptSecp));

console.log(`range_proof len: ${rangeProof.length}`);
console.log(`cReceipt: ${bytesToHex(cReceiptSecp)}`);

// First 4 chunks of 33 bytes are A, S, T_1, T_2 — check their prefixes.
console.log(`\nProof points (first 33 bytes each):`);
for (let i = 0; i < 4; i++) {
  const chunk = rangeProof.slice(i * 33, (i + 1) * 33);
  console.log(`  point[${i}]: ${bytesToHex(chunk).slice(0, 8)}… prefix=0x${chunk[0].toString(16)} ${chunk[0] === 0x02 || chunk[0] === 0x03 ? 'OK' : 'BAD'}`);
}

// Try ref verifier
console.log(`\nReference verifier:`);
try {
  const ok = refVerify([ZERO, cReceiptPt], rangeProof);
  console.log(`  result: ${ok ? '✓ ACCEPT' : '✗ REJECT (returned false)'}`);
} catch (e) {
  console.log(`  THROW: ${e.message}`);
}

// Now simulate worker by recreating compressedPointFromHex
function compressedPointFromHex(input) {
  const hex = typeof input === 'string' ? input.toLowerCase() : bytesToHex(input);
  if (hex.length !== 66) throw new Error('point must be 33 bytes (66 hex chars)');
  if (hex[0] !== '0' || (hex[1] !== '2' && hex[1] !== '3')) {
    throw new Error('point prefix must be 02/03 (compressed)');
  }
  return secp.ProjectivePoint.fromHex(hex);
}

// Try to parse all 33-byte point chunks via worker's compressedPointFromHex
console.log(`\nWorker compressedPointFromHex on each 33-byte chunk:`);
let off = 0;
const labels = ['A', 'S', 'T_1', 'T_2'];
try {
  for (let i = 0; i < 4; i++) {
    const chunk = rangeProof.slice(off, off + 33); off += 33;
    const p = compressedPointFromHex(bytesToHex(chunk));
    console.log(`  ${labels[i]}: parsed OK ${bytesToHex(p.toRawBytes(true)).slice(0, 16)}…`);
  }
  off += 32 * 3;  // skip t_hat, tau_x, mu
  let k = 0;
  while (off + 66 <= rangeProof.length - 64) {  // each pair is 66 bytes, leave 64 for a_final + b_final
    const chunkL = rangeProof.slice(off, off + 33); off += 33;
    const chunkR = rangeProof.slice(off, off + 33); off += 33;
    compressedPointFromHex(bytesToHex(chunkL));
    compressedPointFromHex(bytesToHex(chunkR));
    k++;
  }
  console.log(`  L/R pairs (k=${k}): all parsed`);
} catch (e) {
  console.log(`  THROW: ${e.message}`);
}
