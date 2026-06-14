// Adaptor signatures (PTLC) that lock Tacit's EXACT kernel signature (BIP-340 Schnorr) — the
// cryptographic core of the confidential cross-chain swap (ops/PLAN-confidential-adaptor-swap.md).
// The swap's secret t is revealed by ADAPTING a signature, not by an on-chain hash preimage: a
// pre-signature s̃ is "the signature minus t"; completing it (with the parity below) yields a
// signature that the REAL kernel verifier (`verifySchnorr`, dapp/bulletproofs.js) accepts, and that
// completion publishes t. Two legs locked to the same adaptor point T are atomically linked.
//
// FAITHFUL to the kernel sig: same `_taggedHash('BIP0340/challenge', Rx ‖ Px ‖ msg)` (reused sha256
// + the same x-only/even-y rules as signSchnorr/verifySchnorr). The one subtlety is the published
// nonce R' = R + T: BIP-340 requires it even-y, so the construction tracks σ = parity(R+T) — the
// completed signature uses σ·(R+T) (even-y), s = s̃ + σ·t, and t = σ·(s − s̃). The decisive test
// (tests/adaptor-signature.mjs) is that `verifySchnorr` accepts the completed signature.

import { G, ZERO, SECP_N, modN, bigintToBytes32, bytes32ToBigint } from './bulletproofs.js';
import { secp, sha256, concatBytes, bytesToHex } from './vendor/tacit-deps.min.js';

const Pt = secp.ProjectivePoint;
const te = new TextEncoder();
const _tagged = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concatBytes(t, t, ...msgs)); };
const xbytes = (P) => P.toRawBytes(true).slice(1);                 // x-only, 32 bytes
const isEvenY = (P) => P.toRawBytes(true)[0] === 0x02;
const mulG = (s) => (modN(s) === 0n ? ZERO : G.multiply(modN(s)));
const mul = (P, s) => (modN(s) === 0n ? ZERO : P.multiply(modN(s)));
const liftX = (px32) => Pt.fromHex('02' + bytesToHex(px32)); // even-y lift (matches verifySchnorr)

// e = int(taggedHash("BIP0340/challenge", Rx ‖ Px ‖ msg)) mod n — byte-identical to verifySchnorr.
const challenge = (Rx32, Px32, msg32) => bytes32ToBigint(_tagged('BIP0340/challenge', Rx32, Px32, msg32)) % SECP_N;

// Even-y signing key, matching signSchnorr: P = d·G even-y ⇒ d as-is, else n − d. Returns {d, P, Px}.
export function evenSigningKey(dPriv) {
  const dPrime = typeof dPriv === 'bigint' ? dPriv : bytes32ToBigint(dPriv);
  const P = G.multiply(dPrime);
  const d = isEvenY(P) ? dPrime : modN(SECP_N - dPrime);
  return { d, P, Px: xbytes(P) };
}

// T = t·G — the adaptor point published at swap setup.
export const adaptorPoint = (t) => mulG(t);

// Pre-sign `msg32` under the excess scalar `dPriv` (bigint or 32B), locked to adaptor point `T`.
// `nonce` (bigint) is the per-signature nonce — REQUIRED, must be fresh (production: BIP-340/RFC6979).
// Returns the pre-sig s̃ + the points the counterparty needs to verify + later extract t.
export function presign(dPriv, msg32, T, nonce) {
  const { d, Px } = evenSigningKey(dPriv);
  const k = modN(nonce);
  if (k === 0n) throw new Error('adaptor: nonce was zero');
  const R = mulG(k);
  const Rhat = R.add(T);                    // R' = R + T (the published nonce point)
  const rhatEven = isEvenY(Rhat);
  const RxPub = xbytes(Rhat);
  const e = challenge(RxPub, Px, msg32);
  const kEff = rhatEven ? k : modN(SECP_N - k);   // σ·k, σ = +1 if R' even-y else −1
  const sTilde = modN(kEff + e * d);
  return { R, T, Rhat, rhatEven, RxPub, Px, sTilde, e };
}

// Verify a pre-signature before locking the other leg: s̃·G == σ·R + e·P, σ = parity(R+T).
export function verifyPresign({ Px, msg32, R, T, sTilde }) {
  let P; try { P = liftX(Px); } catch { return false; }
  const Rhat = R.add(T);
  const e = challenge(xbytes(Rhat), Px, msg32);
  const rhs = (isEvenY(Rhat) ? R : R.negate()).add(mul(P, e));
  return mulG(sTilde).equals(rhs);
}

// Complete the pre-signature with `t` → the scalar `s`. Needs R, T to recover σ = parity(R+T).
export function complete(sTilde, t, R, T) {
  const rhatEven = isEvenY(R.add(T));
  return modN(sTilde + (rhatEven ? modN(t) : modN(SECP_N - modN(t))));
}

// The 64-byte signature the kernel verifier accepts: RxPub ‖ s. `verifySchnorr(sig, msg32, Px)` == true.
export const completedSig = (RxPub, s) => concatBytes(Uint8Array.from(RxPub), bigintToBytes32(modN(s)));

// Extract t from a completed signature: t = σ·(s − s̃), σ = parity(R+T). The counterparty holds s̃ and
// reads the completed s off-chain — this is how completing one leg unlocks the other.
export function extract(sTilde, s, R, T) {
  return isEvenY(R.add(T)) ? modN(s - sTilde) : modN(sTilde - s);
}
