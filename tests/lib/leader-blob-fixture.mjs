// A block whose data is in blobs, as tests of the leader's blob reading build one: the stream and blob layout of tacit-block-common blob.rs written out again,
// with public values that commit its lists the way the block program does.
import { concatBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { listHash, memoHash } from '../../tacit-leader/abi.mjs';
import { BLOB_BYTES, BLOB_DATA, BYTES_PER_ELEMENT, MEMO_LEN } from '../../tacit-leader/blobs.mjs';

export const seeded = (n, seed) => { const o = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; o[i] = x >>> 24; } return o; };
export const u32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const hexBytes = (h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

/// blob.rs `stream`: output count, each leaf ‖ memo; nullifier count and nullifiers; claim count and claims (counts u32 BE).
export function streamOf(outputs, nullifiers, claims) {
  return concatBytes(u32(outputs.length), ...outputs.flatMap(([l, m]) => [l, m]), u32(nullifiers.length), ...nullifiers, u32(claims.length), ...claims);
}

/// blob.rs `blobs_for` and `blob`: 4096 big-endian elements, each a zero byte and 31 bytes of the stream.
export const blobsFor = (len) => Math.max(1, Math.ceil(len / BLOB_DATA));
export function blobOf(stream, i) {
  const out = new Uint8Array(BLOB_BYTES), part = stream.subarray(i * BLOB_DATA);
  for (let k = 0; k * BYTES_PER_ELEMENT < part.length && k < 4096; k++) out.set(part.subarray(k * BYTES_PER_ELEMENT, (k + 1) * BYTES_PER_ELEMENT), 32 * k + 1);
  return out;
}

/// A block of `nOutputs` new notes, `nNullifiers` nullifiers and `nClaims` claims: its stream, blobs, public values (word 1 `state`, word 3 `root`, the outputs list's
/// hash at 4 and the nullifiers' at 5, an empty hops list at 12, word 15 set for blobs) and one opening per blob (commitment ‖ z ‖ y ‖ proof).
export function block(nOutputs, nNullifiers, nClaims, seed = 7, { state = new Uint8Array(32).fill(0xa1), root = new Uint8Array(32).fill(0xb2) } = {}) {
  const outputs = Array.from({ length: nOutputs }, (_, i) => [seeded(32, seed + i), seeded(MEMO_LEN, 1000 + seed + i)]);
  const nullifiers = Array.from({ length: nNullifiers }, (_, i) => seeded(32, 5000 + seed + i));
  const claims = Array.from({ length: nClaims }, (_, i) => seeded(64, 9000 + seed + i));
  const stream = streamOf(outputs, nullifiers, claims);
  const blobs = Array.from({ length: blobsFor(stream.length) }, (_, i) => blobOf(stream, i));
  const items = concatBytes(...outputs.map(([l, m]) => concatBytes(l, memoHash(m))));
  const pv = new Uint8Array(32 * 19);
  pv.set(state, 32);
  pv.set(root, 96);
  pv.set(hexBytes(listHash(1, outputs.length, items)), 32 * 4);
  pv.set(hexBytes(listHash(2, nullifiers.length, concatBytes(...nullifiers))), 32 * 5);
  pv.set(hexBytes(listHash(6, 0, new Uint8Array(0))), 32 * 12);
  pv[32 * 15 + 31] = 1;
  const openings = concatBytes(...blobs.map((_, i) => concatBytes(seeded(48, 77 + i), seeded(32, 1), seeded(32, 2), seeded(48, 3))));
  return { outputs, nullifiers, claims, stream, blobs, pv, openings };
}
