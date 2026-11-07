// The tacit chain's hybrid post-quantum memo: what a sender publishes beside a note so its recipient, and no one else, finds it again
// from its keys alone. A memo is MEMO_LEN (1,152) bytes whatever it holds, so its size says nothing; the block program and the landing
// contract see only its hash and length. Vectors for the hash: tests/vectors/tacit-chain-lock-vectors.json.
//
//   memo   = ML-KEM-768 ciphertext (1,088) ‖ secp256k1 ephemeral key (33) ‖ value ciphertext (8) ‖ tag (16) ‖ 7 random bytes
//   s      = 0x02 ‖ SHA-256("tacit-chain-s-v1" ‖ ECDH point (33) ‖ ML-KEM shared secret (32) ‖ ciphertext ‖ ephemeral key)
//   key    = SHA-256("tacit-chain-memo-key-v1" ‖ s)
//   value  = BE64 value ⊕ SHA-256("tacit-chain-memo-v-" ‖ key)[0..8]
//   tag    = HMAC-SHA256(key, "tag" ‖ ephemeral key ‖ ciphertext ‖ value ciphertext)[0..16]
//
// `s` is the 33-byte shared secret the pool's note keys are derived from (btc-pool-zk.js `outputKeys` / `ownedKeys`): the note's keys
// and its nullifier key come from it. It depends on BOTH key exchanges, so an attacker who breaks the elliptic-curve one (a quantum
// computer, later) still cannot read a memo it recorded, nor compute a note's keys or nullifiers, nor link a note to its owner,
// unless it also breaks ML-KEM. Every memo, change to oneself included, is made the same way, so none stands out.
//
// A recipient's keys come from its seed alone (`memoKeys`), so a wallet recovers its notes from the seed and the chain's published memos.

import { secp, sha256, hmac, concatBytes } from './vendor/tacit-deps.min.js';
import { ml_kem768 } from './vendor/tacit-pq.min.js';

export const MEMO_LEN = 1152;
export const KEM_CT = 1088;
const te = new TextEncoder();
const Pt = secp.ProjectivePoint;
const N = secp.CURVE.n;
const MEMO_DOMAIN = te.encode('tacit-block-memo-v1');

const h = (tag, ...parts) => sha256(concatBytes(te.encode(tag), ...parts));
const be64 = (v) => { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, BigInt(v)); return o; };
const fromBe = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const scalarOf = (tag, ...parts) => { const x = fromBe(concatBytes(h(tag, ...parts, Uint8Array.of(0)), h(tag, ...parts, Uint8Array.of(1)))) % (N - 1n); return x + 1n; };
const sameBytes = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < a.length && i < b.length; i++) d |= a[i] ^ b[i]; return d === 0; };
const randomBytes = (n) => { const o = new Uint8Array(n); globalThis.crypto.getRandomValues(o); return o; };

/// The hash a body names a memo by, and a block commits it under: SHA-256("tacit-block-memo-v1" ‖ memo).
export const memoHash = (memo) => sha256(concatBytes(MEMO_DOMAIN, memo));

/// A recipient's memo keys from its 32-byte seed: the scan key (secp256k1) and the ML-KEM-768 key pair, both derived from the seed alone.
/// `address` is what a sender needs (scanPub 33 ‖ kemPub 1,184); `secret` is what opens memos.
export function memoKeys(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('tacit-chain-memo: seed is 32 bytes');
  const scan = scalarOf('tacit-chain-memo-scan-v1', seed);
  const kem = ml_kem768.keygen(concatBytes(h('tacit-chain-memo-kem-v1', seed, Uint8Array.of(0)), h('tacit-chain-memo-kem-v1', seed, Uint8Array.of(1))));
  const scanPub = Pt.BASE.multiply(scan).toRawBytes(true);
  return { address: { scanPub, kemPub: kem.publicKey }, secret: { scan, kem: kem.secretKey } };
}

function derive(ecdh, kss, ct, epk) {
  const s = concatBytes(Uint8Array.of(0x02), h('tacit-chain-s-v1', ecdh, kss, ct, epk));
  const key = h('tacit-chain-memo-key-v1', s);
  return { s, key };
}

const stream = (key) => h('tacit-chain-memo-v-', key).slice(0, 8);
const tagOf = (key, epk, ct, vct) => hmac(sha256, key, concatBytes(te.encode('tag'), epk, ct, vct)).slice(0, 16);

/// Seals a note of `value` to `address`: → { memo (MEMO_LEN bytes), s (the note's 33-byte shared secret) }. `entropy` (32 bytes) makes it
/// deterministic, for tests; leave it out and every memo is fresh.
export function sealMemo(address, value, entropy = null) {
  const e = entropy ?? randomBytes(32);
  const eph = scalarOf('tacit-chain-memo-eph-v1', e);
  const epk = Pt.BASE.multiply(eph).toRawBytes(true);
  const ecdh = Pt.fromHex(address.scanPub).multiply(eph).toRawBytes(true);
  const { cipherText: ct, sharedSecret: kss } = ml_kem768.encapsulate(address.kemPub, h('tacit-chain-memo-kem-rand-v1', e));
  const { s, key } = derive(ecdh, kss, ct, epk);
  const v8 = be64(value);
  const st = stream(key);
  const vct = v8.map((b, i) => b ^ st[i]);
  const tag = tagOf(key, epk, ct, vct);
  const pad = entropy ? h('tacit-chain-memo-pad-v1', e).slice(0, 7) : randomBytes(7);
  const memo = concatBytes(ct, epk, vct, tag, pad);
  if (memo.length !== MEMO_LEN) throw new Error('tacit-chain-memo: memo size');
  return { memo, s };
}

/// Opens a memo with a recipient's `secret` (from `memoKeys`): → { value (bigint), s } when it is for them, else null. A memo for someone
/// else, or one changed, gives null; ML-KEM's implicit rejection and the tag make the two indistinguishable.
export function openMemo(memo, secret) {
  if (!(memo instanceof Uint8Array) || memo.length !== MEMO_LEN) return null;
  const ct = memo.slice(0, KEM_CT);
  const epk = memo.slice(KEM_CT, KEM_CT + 33);
  const vct = memo.slice(KEM_CT + 33, KEM_CT + 41);
  const tag = memo.slice(KEM_CT + 41, KEM_CT + 57);
  let ecdh;
  try { ecdh = Pt.fromHex(epk).multiply(secret.scan).toRawBytes(true); } catch { return null; }
  const kss = ml_kem768.decapsulate(ct, secret.kem);
  const { s, key } = derive(ecdh, kss, ct, epk);
  if (!sameBytes(tag, tagOf(key, epk, ct, vct))) return null;
  const st = stream(key);
  return { value: fromBe(vct.map((b, i) => b ^ st[i])), s };
}

