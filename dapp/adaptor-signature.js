// Adaptor signatures (PTLC) that lock Tacit's EXACT kernel signature (BIP-340 Schnorr) — the
// cryptographic core of the confidential cross-chain swap.
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
import { secp, sha256, keccak_256, concatBytes, bytesToHex } from './vendor/tacit-deps.min.js';

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

// Deterministic per-leg nonce (RFC6979-style, domain-separated by the leg's signing key, message, and
// adaptor point). A caller that omits an explicit nonce gets a fresh one bound to THIS leg, so the same
// (d, nonce) can never be reused across two legs/messages — reuse would expose s̃₁ − s̃₂ = (e₁ − e₂)·d
// and leak the leg's excess scalar d (a bearer spend of that note). Never returns 0.
export function deriveNonce(dPriv, msg32, T) {
  const { d } = evenSigningKey(dPriv);
  const k = bytes32ToBigint(_tagged('tacit-adaptor-nonce-v1', bigintToBytes32(d), Uint8Array.from(msg32), xbytes(T))) % SECP_N;
  return k === 0n ? 1n : k;
}

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

// ── EVM leg: the OP_ADAPTOR_CLAIM kernel ──
// The BIP-340 construction above locks a Bitcoin kernel signature. It does NOT verify on the Ethereum side:
// OP_ADAPTOR_CLAIM checks the settle guest's conservation kernel (cxfer-core verify_kernel) over the locked note L
// and the claim output O, whose challenge is e = keccak("tacit-evm-cxfer-kernel-v1" ‖ L ‖ O ‖ R) mod n over
// 33-byte compressed points, with z·G == R + e·(L − O) and no x-only or even-y rule. The guest commits `z` as the
// t-reveal. The adaptor form of that kernel: pre-sign with nonce point R = k·G and published point R' = R + T,
// s̃ = k + e'·x where e' is the challenge over R'; completing gives z = s̃ + t, and anyone holding s̃ extracts
// t = z − s̃. `x` is the kernel excess r_L − r_O. The kernel { R: R', z } is what the claim witness carries.
const EVM_KERNEL_DOMAIN = te.encode('tacit-evm-cxfer-kernel-v1');
const compressed = (P) => P.toRawBytes(true);

export function evmKernelChallenge(inC, outC, R) {
  const h = keccak_256(concatBytes(EVM_KERNEL_DOMAIN, ...inC.map(compressed), ...outC.map(compressed), compressed(R)));
  return bytes32ToBigint(h) % SECP_N;
}

// Pre-sign the claim kernel over (inC → outC) with excess `x`, locked to adaptor point T, under a fresh `nonce`.
export function evmKernelPresign({ excess, inC, outC, T, nonce }) {
  const k = modN(nonce);
  if (k === 0n) throw new Error('adaptor: nonce was zero');
  const R = mulG(k);
  const Rhat = R.add(T);
  const e = evmKernelChallenge(inC, outC, Rhat);
  return { R, T, Rhat, sTilde: modN(k + e * modN(excess)), e };
}

// Verify a claim-kernel pre-signature: s̃·G == R + e'·(ΣinC − ΣoutC), e' over R + T.
export function evmKernelVerifyPresign({ inC, outC, R, T, sTilde }) {
  const X = inC.reduce((acc, P) => acc.add(P), ZERO).add(outC.reduce((acc, P) => acc.add(P), ZERO).negate());
  const e = evmKernelChallenge(inC, outC, R.add(T));
  return mulG(sTilde).equals(R.add(mul(X, e)));
}

// Complete with t → the kernel { R: R + T, z } the guest verifies; extract t back from a published z.
export const evmKernelComplete = ({ R, T, sTilde }, t) => ({ R: R.add(T), z: modN(sTilde + modN(t)) });
export const evmKernelExtract = (sTilde, z) => modN(z - sTilde);

// Deterministic per-leg nonce for a claim kernel, bound to the excess, the (L, O) pair and T (as deriveNonce is for
// a BIP-340 leg), so one excess never signs two different claim kernels with the same nonce.
export function evmKernelNonce({ excess, inC, outC, T }) {
  const msg32 = keccak_256(concatBytes(EVM_KERNEL_DOMAIN, ...inC.map(compressed), ...outC.map(compressed)));
  return deriveNonce(modN(excess), msg32, T);
}

