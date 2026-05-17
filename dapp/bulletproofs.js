// secp256k1 Pedersen + NUMS-H primitives, packaged as an ES module that
// the dapp's AMM modules (amm-sigma.js, amm-lp.js) can import without
// circular-depending on dapp/tacit.js.
//
// IMPORTANT: H must match dapp/tacit.js's `deriveH()` byte-for-byte. We
// reuse the same domain string ('tacit-generator-H-v1') and try-and-increment
// pattern. A divergence would make Pedersen commits produced by the AMM
// modules incompatible with the worker's verifier. Cross-impl pinning test
// (tests/amm-foundation.test.mjs) catches drift.

import { secp, sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N_BITS = 64;

export function modN(x) { return ((x % SECP_N) + SECP_N) % SECP_N; }

function _deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(seed, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), x);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error('failed to derive NUMS generator H');
}

export const H = _deriveH();
export const G = secp.ProjectivePoint.BASE;
export const ZERO = secp.ProjectivePoint.ZERO;

export function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}

export const pointToBytes = P => P.toRawBytes(true);

export function bigintToBytes32(n) {
  const m = modN(n);
  return hexToBytes(m.toString(16).padStart(64, '0'));
}

export function bytes32ToBigint(b) {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

// BIP-340 Schnorr — same impl as dapp/tacit.js's inline signSchnorr but
// re-exported here so AMM modules can import without circular-depending
// on tacit.js. Math is byte-identical to the test reference's
// composition.mjs signSchnorr.
function _taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}
function _xor32(a, b) { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; }
export function signSchnorr(msgHash, priv32) {
  const dPrime = bytes32ToBigint(priv32);
  if (dPrime <= 0n || dPrime >= SECP_N) throw new Error('schnorr: invalid private key');
  const P = G.multiply(dPrime);
  const Pbytes = P.toRawBytes(true);
  const Px = Pbytes.slice(1);
  const d = (Pbytes[0] === 0x02) ? dPrime : (SECP_N - dPrime);
  const aux = crypto.getRandomValues(new Uint8Array(32));
  const t = _xor32(bigintToBytes32(d), _taggedHash('BIP0340/aux', aux));
  const rand = _taggedHash('BIP0340/nonce', t, Px, msgHash);
  let kPrime = bytes32ToBigint(rand) % SECP_N;
  if (kPrime === 0n) throw new Error('schnorr: nonce was zero');
  const R = G.multiply(kPrime);
  const Rbytes = R.toRawBytes(true);
  const Rx = Rbytes.slice(1);
  const k = (Rbytes[0] === 0x02) ? kPrime : (SECP_N - kPrime);
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, Px, msgHash)) % SECP_N;
  const s = (k + e * d) % SECP_N;
  return concatBytes(Rx, bigintToBytes32(s));
}
export function verifySchnorr(sig64, msgHash, pubXonly32) {
  if (sig64.length !== 64 || pubXonly32.length !== 32 || msgHash.length !== 32) return false;
  const Rx = sig64.slice(0, 32);
  const sBig = bytes32ToBigint(sig64.slice(32, 64));
  if (sBig >= SECP_N) return false;
  if (bytes32ToBigint(pubXonly32) >= SECP_P) return false;
  let P; try { P = secp.ProjectivePoint.fromHex('02' + bytesToHex(pubXonly32)); } catch { return false; }
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, pubXonly32, msgHash)) % SECP_N;
  // noble's Point.multiply throws on scalar=0. Guard so adversarial sigs
  // (s=0 or e=0) don't crash the verifier — let the identity-point check
  // below reject them as invalid.
  const sG = sBig === 0n ? ZERO : G.multiply(sBig);
  const eP = e === 0n ? ZERO : P.multiply(e);
  const R = sG.add(eP.negate());
  if (R.equals(ZERO)) return false;
  const Rb = R.toRawBytes(true);
  if (Rb[0] !== 0x02) return false;
  for (let i = 0; i < 32; i++) if (Rb[i + 1] !== Rx[i]) return false;
  return true;
}
