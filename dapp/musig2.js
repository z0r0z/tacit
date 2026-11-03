// MuSig2 (BIP-327) with an adaptor point: the two-party key of a Bitcoin-to-Bitcoin swap lock, whose key-path spend needs
// both parties and whose signature, once published, gives the party that did not complete it the swap secret t.
//
//   keyAgg(pubkeys, tweaks)        the aggregate key Q, its tweak accumulators, the coefficient of each key (BIP-327 KeyAgg,
//                                  ApplyTweak with x-only tweaks: a Taproot output key is keyAgg([..], [tapTweak(..)]))
//   nonceGen({ sk, pk, aggXonly, msg })   a fresh secret nonce and its public half (66 bytes); the secret signs ONCE
//   session({ keys, pubnonces, msg, T })  what every signer and verifier of one signature computes alike
//   partialSign / partialVerify / partialAgg
//   adapt(sPre, t, sess) -> sig    extract(sig, sPre, sess) -> t
//
// With an adaptor point T the published nonce is R' = R + T (BIP-340 wants it even-y: σ = 1 if it is, else −1, and every
// signer negates its nonces by σ). The sum of the partial signatures is then a pre-signature s̃, which verifies as
//   s̃·G = σ·R + e·Q (Q even-y)
// and completes to the BIP-340 signature (x(R'), s̃ + σ·t). Whoever holds s̃ reads t = σ·(s − s̃) off the published s.
//
// A secret nonce that signs two different sessions gives away the signer's key: nonceGen draws fresh randomness each
// call, partialSign zeroes the secret nonce it used, and a caller stores a used nonce as spent before it answers.
//
// Pure: no network, no storage. Points are noble ProjectivePoints, keys 33-byte compressed, scalars bigints.

import { secp, sha256, concatBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { G, ZERO, SECP_N, modN, bigintToBytes32, bytes32ToBigint } from './bulletproofs.js';

const Pt = secp.ProjectivePoint;
const te = new TextEncoder();
const tagged = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concatBytes(t, t, ...msgs)); };
const cbytes = (P) => P.toRawBytes(true);
const xbytes = (P) => cbytes(P).slice(1);
const hasEvenY = (P) => cbytes(P)[0] === 0x02;
const int = (b) => bytes32ToBigint(b);
const mulG = (k) => (modN(k) === 0n ? ZERO : G.multiply(modN(k)));
const mul = (P, k) => (modN(k) === 0n || P.equals(ZERO) ? ZERO : P.multiply(modN(k)));
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const asBytes = (x) => (typeof x === 'string' ? Uint8Array.from(x.replace(/^0x/, '').match(/../g).map((h) => parseInt(h, 16))) : x);
const pointOf = (b33) => { const b = asBytes(b33); if (b.length !== 33) throw new Error('musig2: a key or nonce point is 33 bytes'); return Pt.fromHex(bytesToHex(b)); };
// cbytes_ext: the point at infinity is 33 zero bytes (an aggregate nonce may be it)
const cbytesExt = (P) => (P.equals(ZERO) ? new Uint8Array(33) : cbytes(P));
const pointExt = (b33) => (b33.every((x) => x === 0) ? ZERO : pointOf(b33));
const u32be = (n) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const u64be = (n) => { const o = new Uint8Array(8); let x = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const randomBytes = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };

// The keys in lexicographic order of their 33 bytes (BIP-327 KeySort): both parties aggregate the same list.
export function keySort(pubkeys) {
  return pubkeys.map(asBytes).slice().sort((a, b) => { for (let i = 0; i < 33; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
}

// KeyAgg, then ApplyTweak (x-only) for each tweak. Q = gacc·Q₀ + tacc·G, as BIP-327 tracks it.
export function keyAgg(pubkeys, tweaks = []) {
  const pks = pubkeys.map(asBytes);
  if (pks.length < 2) throw new Error('musig2: two keys or more');
  const L = tagged('KeyAgg list', ...pks);
  const pk2 = pks.find((p) => !eqBytes(p, pks[0])) || null;
  const coef = (pk) => (pk2 && eqBytes(pk, pk2) ? 1n : int(tagged('KeyAgg coefficient', L, pk)) % SECP_N);
  let Q = ZERO;
  for (const pk of pks) Q = Q.add(mul(pointOf(pk), coef(pk)));
  if (Q.equals(ZERO)) throw new Error('musig2: the keys cancel');
  let gacc = 1n, tacc = 0n;
  for (const tw of tweaks) {
    const t = int(asBytes(tw));
    if (t >= SECP_N) throw new Error('musig2: tweak out of range');
    const g = hasEvenY(Q) ? 1n : SECP_N - 1n;
    Q = mul(Q, g).add(mulG(t));
    if (Q.equals(ZERO)) throw new Error('musig2: the tweak cancels the key');
    gacc = modN(g * gacc); tacc = modN(t + g * tacc);
  }
  return { Q, xonly: xbytes(Q), gacc, tacc, pks, coef };
}

// The BIP-341 tweak of an internal x-only key with one script tree root (a single leaf's hash).
export const tapTweak = (internalXonly, merkleRoot) => tagged('TapTweak', internalXonly, merkleRoot);

// NonceGen. `sk` (32 bytes) only hardens the randomness; the nonce is fresh every call whatever is passed.
export function nonceGen({ sk = null, pk, aggXonly = null, msg = null, extra = new Uint8Array(0), rand = randomBytes(32) }) {
  let r = asBytes(rand);
  if (sk) { const h = tagged('MuSig/aux', r); r = asBytes(sk).map((x, i) => x ^ h[i]); }
  const pkb = asBytes(pk);
  const agg = aggXonly ? asBytes(aggXonly) : new Uint8Array(0);
  const m = msg ? asBytes(msg) : null;
  const msgPrefixed = m ? concatBytes(Uint8Array.of(1), u64be(m.length), m) : Uint8Array.of(0);
  const k = [0, 1].map((i) => int(tagged('MuSig/nonce', r, Uint8Array.of(pkb.length), pkb, Uint8Array.of(agg.length), agg, msgPrefixed, u32be(extra.length), extra, Uint8Array.of(i))) % SECP_N);
  if (k[0] === 0n || k[1] === 0n) throw new Error('musig2: nonce was zero');
  return {
    secnonce: concatBytes(bigintToBytes32(k[0]), bigintToBytes32(k[1]), pkb),
    pubnonce: concatBytes(cbytes(mulG(k[0])), cbytes(mulG(k[1]))),
  };
}

export function nonceAgg(pubnonces) {
  let R1 = ZERO, R2 = ZERO;
  for (const pn of pubnonces.map(asBytes)) {
    if (pn.length !== 66) throw new Error('musig2: a public nonce is 66 bytes');
    R1 = R1.add(pointOf(pn.slice(0, 33))); R2 = R2.add(pointOf(pn.slice(33)));
  }
  return concatBytes(cbytesExt(R1), cbytesExt(R2));
}

// Everything one signature's signers and verifiers share. `keys` is a keyAgg result, `T` the adaptor point or null.
export function session({ keys, pubnonces, msg, T = null }) {
  const aggnonce = nonceAgg(pubnonces);
  const m = asBytes(msg);
  const b = int(tagged('MuSig/noncecoef', aggnonce, keys.xonly, m)) % SECP_N;
  let R = pointExt(aggnonce.slice(0, 33)).add(mul(pointExt(aggnonce.slice(33)), b));
  if (R.equals(ZERO)) R = G;
  const Rf = T ? R.add(T) : R;
  if (Rf.equals(ZERO)) throw new Error('musig2: the adaptor point cancels the nonce');
  const e = int(tagged('BIP0340/challenge', xbytes(Rf), keys.xonly, m)) % SECP_N;
  return { keys, pubnonces: pubnonces.map(asBytes), msg: m, T, aggnonce, b, R, Rf, e, sigma: hasEvenY(Rf) ? 1n : SECP_N - 1n, g: hasEvenY(keys.Q) ? 1n : SECP_N - 1n };
}

// One signer's partial signature. The secret nonce is zeroed here, so the same bytes cannot sign a second session.
export function partialSign({ secnonce, sk, sess }) {
  const sn = asBytes(secnonce);
  const k1 = int(sn.slice(0, 32)), k2 = int(sn.slice(32, 64));
  if (k1 === 0n || k2 === 0n) throw new Error('musig2: this secret nonce was used already');
  const d0 = typeof sk === 'bigint' ? sk : int(asBytes(sk));
  const pk = cbytes(mulG(d0));
  if (!eqBytes(pk, sn.slice(64))) throw new Error('musig2: the secret nonce belongs to another key');
  if (!sess.keys.pks.some((p) => eqBytes(p, pk))) throw new Error('musig2: this key is not one of the aggregate');
  sn.fill(0, 0, 64);
  const a = sess.keys.coef(pk);
  const d = modN(sess.g * sess.keys.gacc * d0);
  const s = modN(sess.sigma * (k1 + sess.b * k2) + sess.e * a * d);
  const out = bigintToBytes32(s);
  if (!partialVerify({ psig: out, pubnonce: concatBytes(cbytes(mulG(k1)), cbytes(mulG(k2))), pk, sess })) throw new Error('musig2: own partial signature does not verify');
  return out;
}

// s_i·G = σ·(R1_i + b·R2_i) + e·a_i·g·gacc·P_i
export function partialVerify({ psig, pubnonce, pk, sess }) {
  try {
    const s = int(asBytes(psig));
    if (s >= SECP_N) return false;
    const pn = asBytes(pubnonce), pkb = asBytes(pk);
    if (!sess.keys.pks.some((p) => eqBytes(p, pkb))) return false;
    const Re = mul(pointOf(pn.slice(0, 33)).add(mul(pointOf(pn.slice(33)), sess.b)), sess.sigma);
    const rhs = Re.add(mul(pointOf(pkb), modN(sess.e * sess.keys.coef(pkb) * sess.g * sess.keys.gacc)));
    return mulG(s).equals(rhs);
  } catch { return false; }
}

// The sum of the partial signatures and the tweak term: the BIP-340 s when there is no adaptor point, the pre-signature s̃
// when there is one.
export function partialAgg({ psigs, sess }) {
  let s = modN(sess.e * sess.g * sess.keys.tacc);
  for (const p of psigs) { const v = int(asBytes(p)); if (v >= SECP_N) throw new Error('musig2: partial signature out of range'); s = modN(s + v); }
  return s;
}

// The pre-signature's check against the adaptor point: s̃·G = σ·R + e·(even-y Q). Each side runs it before relying on s̃.
export function preVerify({ sPre, sess }) {
  return mulG(sPre).equals(mul(sess.R, sess.sigma).add(mul(sess.keys.Q, modN(sess.e * sess.g))));
}

// The 64-byte BIP-340 signature from the pre-signature and t.
export function adapt({ sPre, t, sess }) {
  if (!sess.T || !mulG(t).equals(sess.T)) throw new Error('musig2: t does not open this adaptor point');
  return concatBytes(xbytes(sess.Rf), bigintToBytes32(modN(sPre + sess.sigma * t)));
}

// t from a published signature and the pre-signature, or null when this signature was not completed from it.
export function extract({ sig, sPre, sess }) {
  const sg = asBytes(sig);
  if (sg.length !== 64 || !eqBytes(sg.slice(0, 32), xbytes(sess.Rf))) return null;
  const t = modN(sess.sigma * (int(sg.slice(32)) - sPre));
  return t !== 0n && mulG(t).equals(sess.T) ? t : null;
}
