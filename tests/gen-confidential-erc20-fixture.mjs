#!/usr/bin/env node
// Real-crypto lifecycle fixture for TacitConfidentialERC20 (the EVM confidential
// token). One coherent flow, all proofs real (noble): wrap 100 + wrap 10 -> a
// confidential 2-in-2-out transfer (output denominations hidden by 1-of-8
// OR-proofs, conservation by a kernel Schnorr) -> unwrap one output (100).
// Notes are denominated, so amount·H is always a constant D_i = d_i·H and every
// proof reduces to the cheap ecrecover/ecAdd primitives in Secp256k1.sol.
//
// Bound to a deterministic contract address so the on-chain challenge recompute
// matches. Run: node tests/gen-confidential-erc20-fixture.mjs

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'confidential_erc20.json');

const P = secp.ProjectivePoint;
const N = secp.CURVE.n;
const FP = secp.CURVE.p;
const G = P.BASE;

const CONTRACT = '0xE8279BE14E9fe2Ad2D8E52E42Ca96Fb33a813BBe'; // cast compute-address 0x..DeaDBeef --nonce 0
const CHAIN_ID = 1n;
const LADDER = [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n];

const sha256 = (...p) => { const h = createHash('sha256'); for (const x of p) h.update(Buffer.from(x)); return new Uint8Array(h.digest()); };
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const beBytes = (n, len = 32) => Uint8Array.from(Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex'));
const addrBytes = (a) => Uint8Array.from(Buffer.from(a.replace(/^0x/, ''), 'hex'));
const hx = (n) => '0x' + n.toString(16).padStart(64, '0');
const mod = (a, m) => ((a % m) + m) % m;
const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
let seedCtr = 1;
const rnd = () => mod(BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('cnote'), new Uint8Array([seedCtr++, (seedCtr * 7) & 0xff])))), N) || 1n;

function pedersenH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let c = 0; c < 256; c++) { const x = sha256(seed, new Uint8Array([c])); try { return P.fromHex('02' + bytesToHex(x)); } catch {} }
  throw new Error('no H');
}
const H = pedersenH();
const D = LADDER.map((d) => H.multiply(d));
const xy = (pt) => { const a = pt.toAffine(); return { x: a.x, y: a.y }; };
const xyHex = (pt) => { const a = pt.toAffine(); return { x: hx(a.x), y: hx(a.y) }; };
const addrOf = (pt) => { const a = pt.toAffine(); return '0x' + bytesToHex(keccak_256(concat([beBytes(a.x), beBytes(a.y)])).slice(12)); };
const commit = (d, r) => H.multiply(d).add(G.multiply(r));

// Schnorr PoK that C − D_i is r·G, challenge binds the op (domain, contract, C, denomIdx, to).
function schnorrPok(C, denomIdx, r, toAddr) {
  const Pt = C.add(D[denomIdx].negate());               // = r·G
  const k = rnd(), R = G.multiply(k);
  const rAddr = addrOf(R);
  const aff = C.toAffine();
  const e = mod(BigInt('0x' + bytesToHex(keccak_256(concat([
    new TextEncoder().encode('tacit-evm-cnote-pok-v1'), beBytes(CHAIN_ID), addrBytes(CONTRACT),
    beBytes(aff.x), beBytes(aff.y), new Uint8Array([denomIdx]), addrBytes(toAddr), addrBytes(rAddr),
  ])))), N);
  const z = mod(k + e * r, N);
  return { rAddr, e: hx(e), z: hx(z) };
}

// 1-of-8 CDS OR-proof that C opens to one of {d_i·H + r·G}; output denom hidden.
function orProof(C, jIndex, r) {
  const K = LADDER.length;
  const Cmi = D.map((Di) => C.add(Di.negate()));
  const e_arr = new Array(K), z_arr = new Array(K), A = new Array(K);
  for (let i = 0; i < K; i++) {
    if (i === jIndex) continue;
    e_arr[i] = rnd(); z_arr[i] = rnd();
    A[i] = G.multiply(z_arr[i]).add(Cmi[i].multiply(mod(N - e_arr[i], N)));
  }
  const kj = rnd();
  A[jIndex] = G.multiply(kj);
  const aff = C.toAffine();
  // Challenge binds the domain, chainid, and contract address (matches
  // ConfidentialNoteCore._verifyOrProof) so a proof is contract-specific.
  const tparts = [new TextEncoder().encode('tacit-evm-cnote-or-v1'), beBytes(CHAIN_ID), addrBytes(CONTRACT), beBytes(aff.x), beBytes(aff.y)];
  for (let i = 0; i < K; i++) { const a = A[i].toAffine(); tparts.push(beBytes(a.x), beBytes(a.y)); }
  const e = mod(BigInt('0x' + bytesToHex(keccak_256(concat(tparts)))), N);
  let sumOther = 0n;
  for (let i = 0; i < K; i++) if (i !== jIndex) sumOther = mod(sumOther + e_arr[i], N);
  e_arr[jIndex] = mod(e - sumOther, N);
  z_arr[jIndex] = mod(kj + e_arr[jIndex] * r, N);
  return { Ax: A.map((a) => hx(a.toAffine().x)), Ay: A.map((a) => hx(a.toAffine().y)), e: e_arr.map(hx), z: z_arr.map(hx) };
}

// Conservation kernel: Σin − Σout == excess·G, challenge binds contract + notes + R.
function kernel(Cin, Cout, rin, rout) {
  const excess = mod(rin.reduce((s, x) => s + x, 0n) - rout.reduce((s, x) => s + x, 0n), N);
  let kp = Cin[0].add(Cin[1]).add(Cout[0].negate()).add(Cout[1].negate());
  if (!kp.equals(G.multiply(excess))) throw new Error('kernel point != excess·G (denoms not balanced)');
  const k = rnd(), R = G.multiply(k);
  const rAddr = addrOf(R);
  const t = [new TextEncoder().encode('tacit-evm-cnote-kernel-v1'), addrBytes(CONTRACT)];
  for (const C of [...Cin, ...Cout]) { const a = C.toAffine(); t.push(beBytes(a.x), beBytes(a.y)); }
  t.push(addrBytes(rAddr));
  const e = mod(BigInt('0x' + bytesToHex(keccak_256(concat(t)))), N);
  const z = mod(k + e * excess, N);
  return { kernelE: hx(e), kernelZ: hx(z), kernelRAddr: rAddr };
}

async function main() {
  // ── wrap: two notes, denom 100 (idx 2) and denom 10 (idx 1) ──
  const r_in0 = rnd(), r_in1 = rnd();
  const Cin0 = commit(100n, r_in0), Cin1 = commit(10n, r_in1);
  const wrap0 = { denomIdx: 2, ...xyHex(Cin0), ...schnorrPok(Cin0, 2, r_in0, '0x0000000000000000000000000000000000000000') };
  const wrap1 = { denomIdx: 1, ...xyHex(Cin1), ...schnorrPok(Cin1, 1, r_in1, '0x0000000000000000000000000000000000000000') };

  // ── transfer: 2-in (100,10) -> 2-out (100,10), fresh blindings, denoms hidden ──
  const r_out0 = rnd(), r_out1 = rnd();
  const Cout0 = commit(100n, r_out0), Cout1 = commit(10n, r_out1);
  const or0 = orProof(Cout0, 2, r_out0);
  const or1 = orProof(Cout1, 1, r_out1);
  const k = kernel([Cin0, Cin1], [Cout0, Cout1], [r_in0, r_in1], [r_out0, r_out1]);

  // ── unwrap: output note 0 (denom 100) to a recipient ──
  const RECIP = '0x00000000000000000000000000000000cafe0001';
  const unwrap = { denomIdx: 2, ...xyHex(Cout0), to: RECIP, ...schnorrPok(Cout0, 2, r_out0, RECIP) };

  // ── etched burn: PoK on output note 0 (denom 100) with to = 0 (no recipient) ──
  const ZERO = '0x0000000000000000000000000000000000000000';
  const etchedBurn = { denomIdx: 2, ...xyHex(Cout0), ...schnorrPok(Cout0, 2, r_out0, ZERO) };

  // ── attest: caller ATTESTER discloses control of input note 0 (denom 100) ──
  const ATTESTER = '0x00000000000000000000000000000000A77E5701';
  const attest = { denomIdx: 2, ...xyHex(Cin0), attester: ATTESTER, ...schnorrPok(Cin0, 2, r_in0, ATTESTER) };

  const fixture = {
    note: 'TacitConfidentialERC20 lifecycle (real noble). Regenerate: node tests/gen-confidential-erc20-fixture.mjs.',
    deployer: '0x00000000000000000000000000000000DeaDBeef', contract: CONTRACT, chainId: Number(CHAIN_ID),
    ladder: LADDER.map(String), Dx: D.map((d) => hx(d.toAffine().x)), Dy: D.map((d) => hx(d.toAffine().y)),
    wrap: [wrap0, wrap1],
    transfer: {
      cinx: [hx(Cin0.toAffine().x), hx(Cin1.toAffine().x)], ciny: [hx(Cin0.toAffine().y), hx(Cin1.toAffine().y)],
      coutx: [hx(Cout0.toAffine().x), hx(Cout1.toAffine().x)], couty: [hx(Cout0.toAffine().y), hx(Cout1.toAffine().y)],
      or0, or1, ...k,
    },
    unwrap,
    etchedBurn,
    attest,
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fixture, null, 2));
  console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
  console.log('   wrap0 C.x:', wrap0.x);
  console.log('   kernel e :', k.kernelE);
}
main().catch((e) => { console.error(e); process.exit(1); });
