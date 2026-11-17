// A PQ ID's root kept on this device, sealed under the Tacit key, so any page the key opens has it without asking the passkey again. Small on
// purpose: the passkey sign-in (prf-wallet.js) keeps the root it is given here, and loads nothing of the chain to do it.
//   { cred, n, w, t } with pad = HMAC(key, "tacit-chain-root-wrap-v1" ‖ n), w = root ⊕ pad, t = HMAC(key, "tacit-chain-root-tag-v1" ‖ n ‖ w)[0..16]
import { sha256, hmac, hexToBytes, bytesToHex, concatBytes, secp } from './vendor/tacit-deps.min.js';

const te = new TextEncoder();
const rootKey = (k) => `tacit-chain-root-v1:${bytesToHex(secp.getPublicKey(k, true))}`;
const keyBytes = (priv) => (typeof priv === 'string' ? hexToBytes(priv.replace(/^0x/, '')) : Uint8Array.from(priv));
const sealParts = (k, n) => ({ pad: hmac(sha256, k, concatBytes(te.encode('tacit-chain-root-wrap-v1'), n)), tag: (w) => hmac(sha256, k, concatBytes(te.encode('tacit-chain-root-tag-v1'), n, w)).slice(0, 16) });

export function keepRoot(priv, root, credentialId, storage = globalThis.localStorage) {
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('tacit chain: a root is 32 bytes');
  const k = keyBytes(priv), n = globalThis.crypto.getRandomValues(new Uint8Array(16));
  try {
    const { pad, tag } = sealParts(k, n), w = root.map((b, i) => b ^ pad[i]);
    storage?.setItem(rootKey(k), JSON.stringify({ cred: credentialId || null, n: bytesToHex(n), w: bytesToHex(w), t: bytesToHex(tag(w)) }));
  } finally { k.fill(0); }
}
// → { root, credentialId } when this device keeps the key's root, else null
export function keptRoot(priv, storage = globalThis.localStorage) {
  const k = keyBytes(priv);
  try {
    const j = JSON.parse(storage?.getItem(rootKey(k)) || 'null');
    if (!j || !/^[0-9a-f]{32}$/.test(j.n) || !/^[0-9a-f]{64}$/.test(j.w) || !/^[0-9a-f]{32}$/.test(j.t)) return null;
    const n = hexToBytes(j.n), w = hexToBytes(j.w), { pad, tag } = sealParts(k, n);
    if (bytesToHex(tag(w)) !== j.t) return null;
    return { root: w.map((b, i) => b ^ pad[i]), credentialId: j.cred || null };
  } catch { return null; } finally { k.fill(0); }
}
export function dropRoot(priv, storage = globalThis.localStorage) {
  const k = keyBytes(priv);
  try { storage?.removeItem(rootKey(k)); } catch { } finally { k.fill(0); }
}
