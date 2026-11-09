// The slice of Solidity's ABI the tacit leader needs: uint256, bytes32, address, bytes, bytes32[] and tuples of them, encoded and decoded.
// A type is 'uint256' | 'bytes32' | 'address' | 'bytes' | 'bytes32[]' | 'uint256[]' | { tuple: [types] }.
import { keccak_256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

const te = new TextEncoder();
export const hexOf = (b) => '0x' + Buffer.from(b).toString('hex');
export const bytesOf = (h) => (h instanceof Uint8Array ? h : Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex')));

const word = (x) => { let v = BigInt(x); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const pad32 = (n) => Math.ceil(n / 32) * 32;
const dynamic = (t) => t === 'bytes' || t === 'bytes32[]' || t === 'uint256[]' || (typeof t === 'object' && t.tuple.some(dynamic));

export function selector(signature) { return keccak_256(te.encode(signature)).slice(0, 4); }

export function encode(types, values) {
  const heads = [];
  const tails = [];
  const headSize = 32 * types.length;
  let tailSize = 0;
  types.forEach((t, i) => {
    const v = values[i];
    if (!dynamic(t)) {
      heads.push(t === 'address' || t === 'uint256' ? word(BigInt(v)) : (() => { const b = bytesOf(v); if (b.length !== 32) throw new Error('abi: bytes32'); return b; })());
      return;
    }
    let body;
    if (t === 'bytes') { const b = bytesOf(v); body = concatBytes(word(b.length), b, new Uint8Array(pad32(b.length) - b.length)); }
    else if (t === 'bytes32[]') body = concatBytes(word(v.length), ...v.map((x) => bytesOf(x)));
    else if (t === 'uint256[]') body = concatBytes(word(v.length), ...v.map((x) => word(BigInt(x))));
    else body = encode(t.tuple, v);
    heads.push(word(headSize + tailSize));
    tails.push(body);
    tailSize += body.length;
  });
  return concatBytes(...heads, ...tails);
}

export function decode(types, data) {
  const out = [];
  types.forEach((t, i) => {
    const at = 32 * i;
    const w = data.subarray(at, at + 32);
    if (!dynamic(t)) { out.push(t === 'uint256' ? BigInt(hexOf(w)) : t === 'address' ? hexOf(w.subarray(12)) : hexOf(w)); return; }
    const off = Number(BigInt(hexOf(w)));
    if (t === 'bytes') { const len = Number(BigInt(hexOf(data.subarray(off, off + 32)))); out.push(data.slice(off + 32, off + 32 + len)); }
    else if (t === 'bytes32[]') { const len = Number(BigInt(hexOf(data.subarray(off, off + 32)))); out.push(Array.from({ length: len }, (_, k) => hexOf(data.subarray(off + 32 + 32 * k, off + 64 + 32 * k)))); }
    else if (t === 'uint256[]') { const len = Number(BigInt(hexOf(data.subarray(off, off + 32)))); out.push(Array.from({ length: len }, (_, k) => BigInt(hexOf(data.subarray(off + 32 + 32 * k, off + 64 + 32 * k))))); }
    else out.push(decode(t.tuple, data.subarray(off)));
  });
  return out;
}

export const LISTS = { tuple: ['bytes', 'bytes', 'bytes32[]', 'bytes32[]', 'bytes', 'bytes', 'bytes', 'bytes', 'bytes', 'bytes', 'bytes'] };
export const LAND = 'land(bytes,bytes,(bytes,bytes,bytes32[],bytes32[],bytes,bytes,bytes,bytes,bytes,bytes,bytes))';

/// Calldata for TacitBlocks.land(publicValues, proof, lists), lists as { leaves, memos, nullifiers, anchors, deposits, exits, hops, claims, blobs,
/// migrations, migrationTotals }.
export function landCalldata(publicValues, proof, l) {
  const lists = [l.leaves, l.memos, l.nullifiers, l.anchors, l.deposits, l.exits, l.hops, l.claims, l.blobs, l.migrations ?? new Uint8Array(0), l.migrationTotals ?? new Uint8Array(0)];
  return concatBytes(selector(LAND), encode(['bytes', 'bytes', LISTS], [publicValues, proof, lists]));
}

/// The arguments of a land call from its calldata: a direct call, or one made through a contract (anyone may land a block, from any contract:
/// the land call is then inside the calldata, as the bytes the wrapper passes on, and is found by its selector).
export function decodeLand(input) {
  const b = bytesOf(input), sel = hexOf(selector(LAND));
  const at = (i) => {
    try {
      const [publicValues, proof, lists] = decode(['bytes', 'bytes', LISTS], b.subarray(i + 4));
      if (publicValues.length % 32 !== 0 || publicValues.length < 32 * 19) return null;
      const [leaves, memos, nullifiers, anchors, deposits, exits, hops, claims, blobs, migrations, migrationTotals] = lists;
      return { publicValues, proof, lists: { leaves, memos, nullifiers, anchors, deposits, exits, hops, claims, blobs, migrations, migrationTotals } };
    } catch { return null; }
  };
  if (hexOf(b.subarray(0, 4)) === sel) return at(0);
  for (let i = 4; i + 4 <= b.length; i++) {
    if (hexOf(b.subarray(i, i + 4)) !== sel) continue;
    const call = at(i);
    if (call) return call;
  }
  return null;
}
