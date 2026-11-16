// The signature in a deposit-address record, in one place. A name publishes `<n>:<ns>`, where `ns` is the owner's signature, under the view
// key, of the box key `n`; a payer checks it before sending ETH to the address `n` makes. The Pay page's payment links (which carry the same
// `n` and `ns`) and the name records (fixed-pool-box.js) both use this, so what one signs the other accepts. Only the curve and the hash are
// imported, so a page can take this at once without loading anything else.

import { keccak_256, secp, concatBytes, hexToBytes } from './vendor/tacit-deps.min.js';

const TAG = new TextEncoder().encode('tacit-pay-box-v1');
export const hex64 = (n) => BigInt(n).toString(16).padStart(64, '0');

// What the owner signs: keccak256("tacit-pay-box-v1" || be32(n)).
export const boxDigest = (n) => keccak_256(concatBytes(TAG, hexToBytes(hex64(n))));

// The owner's signature of box key `n`: `v` is the view scalar. 128 hex (r then s). The signature is deterministic (RFC 6979), so the two forms
// give the same one; the sync form is for a page that has set the curve's sync hmac.
export async function signBox(v, n) {
  return (await secp.signAsync(boxDigest(n), hexToBytes(hex64(v)))).toCompactHex();
}
export function signBoxSync(v, n) {
  return secp.sign(boxDigest(n), hexToBytes(hex64(v))).toCompactHex();
}

// Whether `ns` is a signature of `n` (a bigint, or hex with or without 0x) under `V`, the view key (33 bytes) of a pool address.
export function boxSigOk(V, n, ns) {
  try { return secp.verify(String(ns).replace(/^0x/, ''), boxDigest(BigInt(typeof n === 'bigint' ? n : '0x' + String(n).replace(/^0x/, ''))), V); } catch { return false; }
}
