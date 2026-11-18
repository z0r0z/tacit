// A relay's gateway key, vouched for by the relay's own key.
//
// The private route (dapp/sealed-request.js) seals a wallet's request to a keeper's gateway key. For the relay a page ships with, that key is in the page. For a
// relay anyone has listed in the registry, the page has only its address (the registry's `relayer`), so the relay publishes its gateway key together with a
// signature, made by the key of that address, and the wallet seals only to a key that signature vouches for: whoever carries or serves the document (a
// forwarder fetches it, so the wallet's address is never shown to the relay) cannot swap in a key of its own.
//
//   doc   { relayer, key, kid, sig }: the relayer's address, its gateway key (33 bytes of hex), the key's id (4 bytes of hex), and the relayer's signature
//         (65 bytes of hex: r, s, v) of keccak256("tacit-relay-gateway-v1" ‖ relayer (20) ‖ key (33)).

import { secp, keccak_256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const TAG = new TextEncoder().encode('tacit-relay-gateway-v1');
const KID_TAG = new TextEncoder().encode('tacit-sealed-kid-v1');
const HEX = (n) => new RegExp(`^(?:0x)?[0-9a-fA-F]{${n}}$`);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

export const docDigest = (relayer, key) => keccak_256(concatBytes(TAG, hexToBytes(strip(relayer)), hexToBytes(strip(key))));
export const kidOf = (key) => bytesToHex(keccak_256(concatBytes(KID_TAG, hexToBytes(strip(key)))).slice(0, 4));
const addressOf = (pub65) => `0x${bytesToHex(keccak_256(pub65.slice(1)).slice(12))}`;

// The document a relay serves, signed with `sign(hash32 bytes) → the signature's 65 bytes as hex` (an account's raw-hash signer).
export async function makeDoc({ relayer, key, sign }) {
  const sig = strip(await sign(docDigest(relayer, key)));
  if (!HEX(130).test(sig)) throw new Error('the signer did not give a 65-byte signature');
  return { relayer: `0x${strip(relayer)}`, key: strip(key), kid: kidOf(key), sig };
}

// The gateway key a document vouches for, or null: it must name `relayer`, carry a key that is a point on the curve with the id it says, and be signed by
// `relayer`'s key. Never throws on bad input.
export function verifyDoc(doc, relayer) {
  try {
    if (!doc || typeof doc !== 'object' || !HEX(40).test(String(relayer)) || !HEX(40).test(String(doc.relayer)) || !HEX(66).test(String(doc.key)) || !HEX(8).test(String(doc.kid)) || !HEX(130).test(String(doc.sig))) return null;
    if (strip(doc.relayer) !== strip(relayer)) return null;
    const key = strip(doc.key);
    secp.ProjectivePoint.fromHex(key);                                    // a point on the curve
    if (kidOf(key) !== strip(doc.kid)) return null;
    const raw = hexToBytes(strip(doc.sig));
    const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
    if (v !== 0 && v !== 1) return null;
    const pub = secp.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(docDigest(relayer, key)).toRawBytes(false);
    return addressOf(pub) === `0x${strip(relayer)}` ? key : null;
  } catch { return null; }
}
