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
