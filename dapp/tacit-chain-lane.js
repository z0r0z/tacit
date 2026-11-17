// A Tacit key's chain lane: the hash of its address on the Tacit chain, which the key's tacit1… address names (as the 0x… chain lane of the address)
// so a payer on the chain finds the key without asking the directory. It comes from the key alone: the chain and the asset only matter once a note is
// spent, so any page can make it with no contract read and no prover. The derivation is the chain wallet's own.
import { sha256, hmac, hexToBytes, bytesToHex, concatBytes, secp } from './vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from './vendor/tacit-poseidon.min.js';
import { makeChainWallet } from './tacit-chain-wallet.js';

const te = new TextEncoder();
export const chainSeed = (priv) => hmac(sha256, priv, te.encode('tacit-chain-seed-v1'));

// A PQ ID: chain keys from a root that no published key leads to (a passkey's own output, prf-wallet.js prfChainRoot). The keys above come from the
// Tacit key, whose public key is in the Tacit address, so whoever can solve that key (a quantum computer) could open their memos; these it cannot.
export const rootSeed = (root) => hmac(sha256, root, te.encode('tacit-chain-seed-v2'));

// The root is kept on this device sealed under the Tacit key, so any page the key opens has it without asking the passkey again:
// { cred, n, w, t } with pad = HMAC(key, "tacit-chain-root-wrap-v1" ‖ n), w = root ⊕ pad, t = HMAC(key, "tacit-chain-root-tag-v1" ‖ n ‖ w)[0..16].
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

const NO_CHAIN = '0x' + '00'.repeat(32);
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (xs) => POSEIDON[xs.length](xs);
let wallet = null;

// priv: the 32-byte Tacit key, as bytes or hex (left as given). → the 32-byte chain lane
export function chainLane(priv) {
  wallet ||= makeChainWallet({ poseidon, prover: null, chain: NO_CHAIN, asset: 0n });
  const k = typeof priv === 'string' ? hexToBytes(priv.replace(/^0x/, '')) : Uint8Array.from(priv);
  let seed = null;
  try {
    seed = chainSeed(k);
    return wallet.chainAddressHash(wallet.address(wallet.keys(seed)));
  } finally { k.fill(0); seed?.fill(0); }
}
