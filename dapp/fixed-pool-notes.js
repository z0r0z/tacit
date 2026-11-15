// Notes for fixed-denomination pools: the plan that splits an amount between them and the Tacit pool, the
// signature-derived secrets, the commitment a deposit carries, and the note string that lets any other tool
// spend the deposit.
//
// A fixed pool holds notes of one size (0.1, 1, 10 or 100 ETH), so a note says nothing about the amount beyond
// that size. It cannot take an odd amount. Tacit's pool can, so the plan puts whole denominations into the fixed
// pools and sends what is left, and every amount under the smallest denomination used, into Tacit.
//
// Secrets come from one EIP-712 signature per (nonce, chain), the layout the wallet keychain uses, so a deposit
// made here opens there and the other way round, and the only thing to keep is the wallet itself. The
// commitment is a Pedersen hash on BabyJubJub (the circomlib construction: BLAKE-256 generators, signed 5-bit
// windows in 25-byte chunks) of nullifier(31 bytes LE) || secret(31 bytes LE), taken as the x coordinate.
//
// Nothing here signs, sends or reads the chain. The page does that and passes the results in.

import { keccak_256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { addPoint, mulScalar, modSqrt, modInv, mod, P_FR, A_BJJ, D_BJJ, packPoint } from './amm-bjj.js';

const ETHER = 10n ** 18n;
const enc = new TextEncoder();

// ---- the pools -------------------------------------------------------------------------------------------

// Canonical pools only. Other addresses that carry the same code exist, but nobody deposits there any more, and
// a note in an empty pool is no cover.
export const FIXED_POOLS = Object.freeze({
  1: Object.freeze([
    { denomination: ETHER / 10n, address: '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc' },
    { denomination: ETHER, address: '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936' },
    { denomination: 10n * ETHER, address: '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF' },
    { denomination: 100n * ETHER, address: '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291' },
  ]),
  11155111: Object.freeze([
    { denomination: ETHER / 10n, address: '0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b' },
    { denomination: ETHER, address: '0x8cc930096B4Df705A007c4A039BDFA1320Ed2508' },
    { denomination: 10n * ETHER, address: '0x8D10d506D29Fc62ABb8A290B99F66dB27Fc43585' },
  ]),
});

// Under this, everything goes to Tacit: a 1 ETH note is the smallest that sits in a pool with a large crowd,
// and amounts below it are the ones Tacit's own pool is for.
export const DEFAULT_MIN_DENOMINATION = ETHER;
// Each note is a deposit transaction of about a million gas. Past this many, the rest goes to Tacit.
export const DEFAULT_MAX_NOTES = 6;

// Splits `amountWei` into whole notes for the fixed pools, largest first, and the remainder for Tacit.
//   { notes: [{ denomination, address, count }], remainder, noteCount }
// A denomination below `minDenominationWei` is not used. `maxNotes` caps the number of deposits; what the cap
// leaves out is part of the remainder, which Tacit takes in any amount.
export function planSplit(amountWei, chainId, { minDenominationWei = DEFAULT_MIN_DENOMINATION, maxNotes = DEFAULT_MAX_NOTES } = {}) {
  let left = BigInt(amountWei);
  if (left < 0n) throw new Error('amount below zero');
  const min = BigInt(minDenominationWei);
  const pools = [...(FIXED_POOLS[chainId] || [])].filter((p) => p.denomination >= min).sort((a, b) => (a.denomination < b.denomination ? 1 : -1));
  const notes = [];
  let budget = maxNotes;
  for (const p of pools) {
    if (budget <= 0) break;
    const fit = left / p.denomination;
    const count = fit < BigInt(budget) ? Number(fit) : budget;
    if (count === 0) continue;
    notes.push({ denomination: p.denomination, address: p.address, count });
    left -= p.denomination * BigInt(count);
    budget -= count;
  }
  return { notes, remainder: left, noteCount: maxNotes - budget };
}

// ---- BLAKE-256 -------------------------------------------------------------------------------------------
// The SHA-3 finalist, not BLAKE2: the generator points are defined by it. Plain 14-round BLAKE-256 with a zero
// salt and message padding that ends in a one bit.

const BLAKE_C = new Uint32Array([
  0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0, 0x082efa98, 0xec4e6c89,
  0x452821e6, 0x38d01377, 0xbe5466cf, 0x34e90c6c, 0xc0ac29b7, 0xc97c50dd, 0x3f84d5b5, 0xb5470917,
]);
const BLAKE_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const BLAKE_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

export function blake256(msg) {
  const len = msg.length;
  // pad: 0x80, zeros, a one bit at the end of the pad, then the bit length as 64 bits big-endian
  const total = Math.ceil((len + 1 + 8) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  buf[total - 9] |= 0x01;
  const bits = BigInt(len) * 8n;
  new DataView(buf.buffer).setBigUint64(total - 8, bits, false);

  const h = Uint32Array.from(BLAKE_IV);
  const m = new Uint32Array(16);
  const v = new Uint32Array(16);
  for (let off = 0, k = 0; off < total; off += 64, k++) {
    const dv = new DataView(buf.buffer, off, 64);
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(i * 4, false);
    // the counter is the message bits seen so far, and zero for a block that holds none of them
    const seen = off >= len ? 0n : BigInt(Math.min(off + 64, len)) * 8n;
    const t0 = Number(seen & 0xffffffffn), t1 = Number(seen >> 32n);
    for (let i = 0; i < 8; i++) v[i] = h[i];
    for (let i = 0; i < 4; i++) v[8 + i] = BLAKE_C[i];
    v[12] = (t0 ^ BLAKE_C[4]) >>> 0;
    v[13] = (t0 ^ BLAKE_C[5]) >>> 0;
    v[14] = (t1 ^ BLAKE_C[6]) >>> 0;
    v[15] = (t1 ^ BLAKE_C[7]) >>> 0;
    const G = (r, i, a, b, c, d) => {
      const s = BLAKE_SIGMA[r % 10];
      v[a] = (v[a] + v[b] + (m[s[2 * i]] ^ BLAKE_C[s[2 * i + 1]])) >>> 0;
      v[d] = rotr(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) >>> 0;
      v[b] = rotr(v[b] ^ v[c], 12);
      v[a] = (v[a] + v[b] + (m[s[2 * i + 1]] ^ BLAKE_C[s[2 * i]])) >>> 0;
      v[d] = rotr(v[d] ^ v[a], 8);
      v[c] = (v[c] + v[d]) >>> 0;
      v[b] = rotr(v[b] ^ v[c], 7);
    };
    for (let r = 0; r < 14; r++) {
      G(r, 0, 0, 4, 8, 12); G(r, 1, 1, 5, 9, 13); G(r, 2, 2, 6, 10, 14); G(r, 3, 3, 7, 11, 15);
      G(r, 4, 0, 5, 10, 15); G(r, 5, 1, 6, 11, 12); G(r, 6, 2, 7, 8, 13); G(r, 7, 3, 4, 9, 14);
    }
    for (let i = 0; i < 8; i++) h[i] = (h[i] ^ v[i] ^ v[i + 8]) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i], false);
  return out;
}

// ---- Pedersen hash on BabyJubJub -------------------------------------------------------------------------

const HALF = (P_FR - 1n) / 2n;
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

const leToBig = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };

// The circomlib point decoding, which differs from the usual one in two ways: the sign bit says "x is in the
// upper half" instead of "x is odd", and the root taken before the sign applies is the lower one. null when the
// bytes name no point.
function decodePoint(bytes) {
  const work = Uint8Array.from(bytes);
  const sign = (work[31] & 0x80) !== 0;
  work[31] &= 0x7f;
  const y = leToBig(work);
  if (y >= P_FR) return null;
  const y2 = (y * y) % P_FR;
  const den = mod(A_BJJ - ((D_BJJ * y2) % P_FR));
  if (den === 0n) return null;
  let x = modSqrt(mod((1n - y2) * modInv(den)));
  if (x === null) return null;
  if (x > HALF) x = mod(-x);
  if (sign) x = mod(-x);
  return [x, y];
}

const generators = [];
function generator(idx) {
  if (generators[idx]) return generators[idx];
  const pad = (n) => String(n).padStart(32, '0');
  let p = null;
  for (let i = 0; !p; i++) {
    const h = blake256(enc.encode(`PedersenGenerator_${pad(idx)}_${pad(i)}`));
    h[31] &= 0b10111111;
    p = decodePoint(h);
  }
  p = mulScalar(p, 8n); // the prime-order subgroup
  generators[idx] = p;
  return p;
}

// Each 25-byte chunk becomes one scalar: every nibble is a signed digit in 1..8, five bits apart.
function chunkScalars(msg) {
  const out = [];
  const digit = (n) => { const d = BigInt((n & 7) + 1); return n & 8 ? -d : d; };
  for (let pos = 0; pos < msg.length; pos += 25) {
    let scalar = 0n, shift = 1n;
    for (const b of msg.subarray(pos, pos + 25)) {
      scalar += digit(b & 15) * shift; shift <<= 5n;
      scalar += digit(b >>> 4) * shift; shift <<= 5n;
    }
    out.push(scalar < 0n ? SUBORDER + scalar : scalar);
  }
  return out;
}

// The hash as a point.
export function pedersenPoint(msg) {
  let acc = [0n, 1n];
  chunkScalars(msg).forEach((s, j) => { acc = addPoint(acc, mulScalar(generator(j), s)); });
  return acc;
}

// The hash as the 32 bytes the circomlib packing gives. Equals `packPoint` of the point.
export const pedersenHash = (msg) => packPoint(pedersenPoint(msg));

// ---- secrets and the commitment --------------------------------------------------------------------------

// Wire strings of the note format. Other tools verify the signature against these, so they stay as they are.
const KEYCHAIN_NAME = 'TornadoCash Keychain';
const NOTE_TYPE = 'TornadoCashNote';
const DOMAIN_SALT = '0x' + bytesToHex(keccak_256(enc.encode('tornado')));

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// The typed data the wallet signs for note number `nonce` on `chainId`. One signature serves every pool on the
// chain: the pool address is mixed in afterwards.
export function noteTypedData(nonce, chainId) {
  return {
    domain: { name: KEYCHAIN_NAME, version: '1', chainId: Number(chainId), salt: DOMAIN_SALT },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
      ],
      [NOTE_TYPE]: [{ name: 'nonce', type: 'uint64' }],
    },
    primaryType: NOTE_TYPE,
    message: { nonce: String(nonce) },
  };
}

const be32 = (n) => hexToBytes(n.toString(16).padStart(64, '0'));

// r || s with s in the lower half, 64 bytes. The recovery byte is dropped, so two signers that differ only in s
// or v still agree.
export function canonicalRS(sigHex) {
  const sig = hexToBytes(sigHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  const s = leToBig(sig.slice(32, 64).reverse());
  return concatBytes(sig.slice(0, 32), be32(s > SECP_N / 2n ? SECP_N - s : s));
}

const poolBytes = (address) => hexToBytes(address.replace(/^0x/i, '').toLowerCase());
const trunc31 = (tag, address, rs) => keccak_256(concatBytes(enc.encode(tag), poolBytes(address), rs)).slice(0, 31);

// The nullifier and secret of one deposit, with the commitment to send and the nullifier hash a withdrawal shows.
// `signature` is the wallet's signature of noteTypedData(nonce, chainId).
export function deriveSecrets({ signature, pool }) {
  const rs = canonicalRS(signature);
  const nullifier = trunc31('nullifier', pool, rs);
  const secret = trunc31('secret', pool, rs);
  const preimage = concatBytes(nullifier, secret);
  const commitment = pedersenPoint(preimage)[0];
  const nullifierHash = pedersenPoint(nullifier)[0];
  return { nullifier, secret, preimage, commitment, nullifierHash };
}

// The commitment as the 32 bytes a deposit carries.
export const commitmentBytes32 = (commitment) => '0x' + commitment.toString(16).padStart(64, '0');

// deposit(bytes32) on a fixed pool; the value is the denomination.
export function depositCall(pool, commitment) {
  return { to: pool.address, value: pool.denomination, data: '0xb214faa5' + commitmentBytes32(commitment).slice(2) };
}

// A note as text: the old single-line format every tool of this kind reads.
//   <prefix>-eth-<amount>-<chainId>-0x<62-byte preimage>
export function noteString({ denomination, chainId, preimage, prefix = 'tornado' }) {
  const eth = denomination % ETHER === 0n ? String(denomination / ETHER) : (Number(denomination) / 1e18).toString();
  return `${prefix}-eth-${eth}-${chainId}-0x${bytesToHex(preimage)}`;
}

export function parseNoteString(text) {
  const m = /^[a-z]+-eth-([0-9.]+)-(\d+)-0x([0-9a-fA-F]{124})$/.exec(String(text).trim());
  if (!m) throw new Error('not a note');
  const preimage = hexToBytes(m[3]);
  const nullifier = preimage.slice(0, 31);
  return {
    amount: m[1],
    chainId: Number(m[2]),
    preimage,
    nullifier,
    commitment: pedersenPoint(preimage)[0],
    nullifierHash: pedersenPoint(nullifier)[0],
  };
}
