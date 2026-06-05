#!/usr/bin/env node
// Generates real secp256k1 vectors for the EVM gas probe (Secp256k1Probe.t.sol):
//   - mulmuladd: address(a·G + b·P) via the ecrecover trick
//   - ecAdd:     affine point addition (modexp inverse)
//   - schnorr:   verify z·G == R + e·P
//   - orproof:   a real 1-of-8 CDS OR-proof that a Pedersen commitment opens to
//                one of the denomination ladder values (the Tier-A output proof)
//   - conservation: a kernel Schnorr over Σin − Σout − fee·H for a 2-in-2-out
// All math is done with @noble/secp256k1 so the Solidity is checked against a
// reference implementation, not just measured.
//
// Run: node tests/gen-secp-probe-vectors.mjs

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'secp_probe.json');

const P = secp.ProjectivePoint;
const N = secp.CURVE.n;
const FP = secp.CURVE.p;
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(Buffer.from(p)); return new Uint8Array(h.digest()); };
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const beBytes = (n, len = 32) => Uint8Array.from(Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex'));
const hx = (n) => '0x' + n.toString(16).padStart(64, '0');

// Pedersen NUMS generator H — sha256("tacit-generator-H-v1") + try-increment (matches the dapp).
function pedersenH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let c = 0; c < 256; c++) {
    const x = sha256(seed, new Uint8Array([c]));
    try { return P.fromHex('02' + bytesToHex(x)); } catch {}
  }
  throw new Error('no H');
}

// address of an affine point = last 20 bytes of keccak256(x32 || y32).
function addrOf(pt) {
  const a = pt.toAffine();
  const buf = new Uint8Array(64);
  buf.set(beBytes(a.x), 0); buf.set(beBytes(a.y), 32);
  return '0x' + bytesToHex(keccak_256(buf).slice(12));
}
const xParity = (pt) => { const a = pt.toAffine(); return { x: hx(a.x), parity: Number(a.y & 1n) }; };
const xy = (pt) => { const a = pt.toAffine(); return { x: hx(a.x), y: hx(a.y) }; };
const mod = (a, m) => ((a % m) + m) % m;
const rnd = (seed) => mod(BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('probe'), new Uint8Array([seed])))), N) || 1n;

const G = P.BASE;
const H = pedersenH();

// ── mulmuladd: T = a·G + b·P ──
function mulmuladdVec(seed, a, b) {
  const sk = rnd(seed);
  const pt = G.multiply(sk);
  const T = G.multiply(mod(a, N)).add(pt.multiply(mod(b, N)));
  const { x, parity } = xParity(pt);
  return { px: x, pyParity: parity, a: hx(mod(a, N)), b: hx(mod(b, N)), expected: addrOf(T) };
}

// ── ecAdd: P3 = P1 + P2 (distinct points) ──
function ecAddVec(s1, s2) {
  const p1 = G.multiply(rnd(s1)), p2 = G.multiply(rnd(s2));
  return { p1: xy(p1), p2: xy(p2), sum: xy(p1.add(p2)) };
}

// ── schnorr: prove knowledge of sk in P=sk·G; verify z·G == R + e·P ──
function schnorrVec(seed) {
  const sk = rnd(seed), k = rnd(seed + 50);
  const Ppt = G.multiply(sk), R = G.multiply(k);
  const e = mod(BigInt('0x' + bytesToHex(keccak_256(beBytes(R.toAffine().x)))), N);
  const z = mod(k + e * sk, N);
  const { x, parity } = xParity(Ppt);
  return { px: x, pyParity: parity, e: hx(e), z: hx(z), rAddr: addrOf(R) };
}

// ── orproof: 1-of-K CDS proof that C = d_j·H + r·G for some ladder index j ──
// Verify: e == Σ e_i (mod N) AND for all i: addr(z_i·G + (N−e_i)·(C − d_i·H)) == addr(A_i).
const LADDER = [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n]; // 8 denoms
function orProofVec(seed, jIndex) {
  const K = LADDER.length;
  const r = rnd(seed);
  const dj = LADDER[jIndex];
  const C = H.multiply(dj).add(G.multiply(r));               // commitment to d_j
  const D = LADDER.map((d) => H.multiply(d));                // D_i = d_i·H (constants)
  const Cmi = D.map((Di) => C.add(Di.negate()));             // C − d_i·H

  const e_arr = new Array(K), z_arr = new Array(K), A = new Array(K);
  // Simulated branches i != j: pick random z_i, e_i; A_i = z_i·G − e_i·(C−D_i).
  for (let i = 0; i < K; i++) {
    if (i === jIndex) continue;
    e_arr[i] = rnd(seed + 100 + i);
    z_arr[i] = rnd(seed + 200 + i);
    A[i] = G.multiply(z_arr[i]).add(Cmi[i].multiply(mod(N - e_arr[i], N)));
  }
  // Real branch j: A_j = k_j·G.
  const kj = rnd(seed + 300);
  A[jIndex] = G.multiply(kj);

  // Challenge e = keccak(Cx||Cy || A_0x||A_0y .. ) — uncompressed coords, so the
  // contract recomputes it and derives addr(A_i) without decompressing.
  const tparts = [beBytes(C.toAffine().x), beBytes(C.toAffine().y)];
  for (let i = 0; i < K; i++) { const a = A[i].toAffine(); tparts.push(beBytes(a.x), beBytes(a.y)); }
  const e = mod(BigInt('0x' + bytesToHex(keccak_256(concat(tparts)))), N);

  // e_j = e − Σ_{i≠j} e_i ; z_j = k_j + e_j·r.
  let sumOther = 0n;
  for (let i = 0; i < K; i++) if (i !== jIndex) sumOther = mod(sumOther + e_arr[i], N);
  e_arr[jIndex] = mod(e - sumOther, N);
  z_arr[jIndex] = mod(kj + e_arr[jIndex] * r, N);

  return {
    c: xy(C),
    branches: A.map((Ai, i) => ({ a: xy(Ai), e: hx(e_arr[i]), z: hx(z_arr[i]) })),
    challenge: hx(e),
  };
}

// ── conservation kernel: Σin − Σout − fee·H == excess·G, Schnorr over excess ──
function conservationVec(seed) {
  // Two inputs (d=100, d=10), two outputs (d=100, d=10), fee=0 → excess = r_in − r_out.
  const rin = [rnd(seed + 1), rnd(seed + 2)], rout = [rnd(seed + 3), rnd(seed + 4)];
  const din = [100n, 10n], dout = [100n, 10n], fee = 0n;
  const Cin = din.map((d, i) => H.multiply(d).add(G.multiply(rin[i])));
  const Cout = dout.map((d, i) => H.multiply(d).add(G.multiply(rout[i])));
  // Kernel point = Σin − Σout − fee·H. Amounts cancel → excess·G with excess = Σrin − Σrout.
  let kp = Cin[0].add(Cin[1]).add(Cout[0].negate()).add(Cout[1].negate());
  if (fee !== 0n) kp = kp.add(H.multiply(fee).negate());
  const excess = mod(rin[0] + rin[1] - rout[0] - rout[1], N);
  // sanity: kp == excess·G
  if (!kp.equals(G.multiply(excess))) throw new Error('kernel point != excess·G');
  const k = rnd(seed + 9), R = G.multiply(k);
  const e = mod(BigInt('0x' + bytesToHex(keccak_256(beBytes(R.toAffine().x)))), N);
  const z = mod(k + e * excess, N);
  return {
    cin: Cin.map(xy), cout: Cout.map(xy), fee: fee.toString(),
    kernelE: hx(e), kernelZ: hx(z), kernelRAddr: addrOf(R),
  };
}

function concat(arr) { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; }

function flattenOr(op, ladderD) {
  return {
    cx: op.c.x, cy: op.c.y,
    Dx: ladderD.map((d) => d.x), Dy: ladderD.map((d) => d.y),
    Ax: op.branches.map((b) => b.a.x), Ay: op.branches.map((b) => b.a.y),
    e: op.branches.map((b) => b.e), z: op.branches.map((b) => b.z),
    challenge: op.challenge,
  };
}

async function main() {
  const ladderD = LADDER.map((d) => xy(H.multiply(d))); // D_i = d_i·H constants for the contract
  const cons = conservationVec(9);
  const fixture = {
    note: 'secp256k1 EVM gas-probe vectors (real noble math). Regenerate with node tests/gen-secp-probe-vectors.mjs.',
    H: xy(H),
    ladder: LADDER.map(String),
    mulmuladd: [mulmuladdVec(1, 7n, 3n), mulmuladdVec(2, rnd(80), rnd(81)), mulmuladdVec(3, 9n, 4n)],
    ecAdd: [ecAddVec(11, 22), ecAddVec(33, 44)].map((v) => ({ p1x: v.p1.x, p1y: v.p1.y, p2x: v.p2.x, p2y: v.p2.y, sx: v.sum.x, sy: v.sum.y })),
    schnorr: schnorrVec(7),
    orproof: flattenOr(orProofVec(5, 3), ladderD),    // commitment to ladder[3] = 1000
    orproofBad: flattenOr(orProofVec(6, 0), ladderD), // valid for ladder[0]; tampered in-test
    conservation: {
      cinx: cons.cin.map((c) => c.x), ciny: cons.cin.map((c) => c.y),
      coutx: cons.cout.map((c) => c.x), couty: cons.cout.map((c) => c.y),
      kernelE: cons.kernelE, kernelZ: cons.kernelZ, kernelRAddr: cons.kernelRAddr,
    },
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fixture, null, 2));
  console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
  console.log('   H.x       :', fixture.H.x);
  console.log('   orproof e :', fixture.orproof.challenge);
}
main().catch((e) => { console.error(e); process.exit(1); });
