// Client-proved Bitcoin shielded pool: reference model, spend.circom proofs, soundness negatives, the
// secp↔BabyJub boundary, and cross-implementation vectors.
//
// Needs the circuit and a DEV zkey:
//   (cd dapp/circuits && npm ci) && bash dapp/circuits/btc-pool/build.sh
//   PTAU=<pinned pot18> bash dapp/circuits/btc-pool/build-dev-zkey.sh
// Run: node tests/btc-pool-zk.test.mjs            (REGEN=1 rewrites tests/vectors/btc-pool-zk-vectors.json)
import assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';

import {
  makeBtcPoolZk, assetField, bodyHash, hsL, hsP, mulB8, be32, publicSignals, publicsAcceptable,
  L_BJJ, BASE8, ZK_TREE_DEPTH, packCommitment, pedersenBJJ, BJJ_IDENTITY,
} from '../dapp/btc-pool-zk.js';
import { proveSpend, verifySpend, encodeProof, decodeProof } from '../dapp/btc-pool-zk-prover.js';
import {
  proveBoundary, verifyBoundary, encodeBoundary, decodeBoundary, BOUNDARY_LEN,
} from '../dapp/btc-pool-zk-boundary.js';
import { verifyXCurve, challenge as xcChallenge } from '../dapp/amm-sigma.js';
import { bppRangeProve, bppRangeVerify, bppGens } from '../dapp/bulletproofs-plus.js';
import { H as H_SECP, G as G_SECP, SECP_N, pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';
import { H_BJJ, G_BJJ, N_BJJ, P_FR, mulScalar, addPoint, packPoint, eq as ptEq } from '../dapp/amm-bjj.js';

const DIR = new URL('../dapp/circuits/btc-pool/build/', import.meta.url).pathname;
const WASM = DIR + 'spend_js/spend.wasm';
const R1CS = DIR + 'spend.r1cs';
const ZKEY = DIR + 'spend_dev_signet_final.zkey';
const VKF = DIR + 'spend_dev_signet_vk.json';
const VEC = new URL('./vectors/btc-pool-zk-vectors.json', import.meta.url).pathname;
for (const f of [WASM, R1CS, ZKEY, VKF]) {
  if (!existsSync(f)) { console.error(`missing ${f}: run build.sh and build-dev-zkey.sh (see header)`); process.exit(1); }
}
const vk = JSON.parse(readFileSync(VKF, 'utf8'));
const wasm = readFileSync(WASM);
const zkey = readFileSync(ZKEY);

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const zk = makeBtcPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const te = new TextEncoder();
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

async function satisfies(input) {
  try {
    const wtns = { type: 'mem' };
    await snarkjs.wtns.calculate(input, wasm, wtns);
    return await snarkjs.wtns.check(R1CS, wtns, quiet);
  } catch {
    return false;
  }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const S = (x) => BigInt(x).toString();

// ── fixture: a wallet with two notes in a tree ──
const seed = new Uint8Array(32).fill(7);
const alice = zk.walletKeys(seed, 'signet');
const bob = zk.walletKeys(new Uint8Array(32).fill(9), 'signet');
const ASSET = new Uint8Array(32).fill(0xab);
const assetF = assetField(ASSET);
const s1 = Uint8Array.from([2, ...new Uint8Array(32).fill(0x11)]);
const s2 = Uint8Array.from([3, ...new Uint8Array(32).fill(0x22)]);
const k1 = zk.ownedKeys(alice, s1);
const k2 = zk.ownedKeys(alice, s2);
const leaf1 = zk.leafOf(assetF, 1000n, k1.npk, k1.rho);
const leaf2 = zk.leafOf(assetF, 234n, k2.npk, k2.rho);
const T = zk.tree([123n, leaf1, 456n, leaf2]);
const body = te.encode('T_BTC_SPEND body bytes: asset h_anchor bind nf outputs exit want');
const BH = bodyHash(body);
const inp = (k, v, index, bh = BH, sk = k.sk) => ({ v, rho: k.rho, nk: k.nk, Ak: k.Ak, index, path: T.path(index), sig: zk.sign(sk, bh) });
const bobOut = (v, s) => { const o = zk.outputKeys(bob.A, bob.N, s); return { v, npk: o.npk, rho: o.rho }; };
const aliceOut = (v, s) => { const o = zk.outputKeys(alice.A, alice.N, s); return { v, npk: o.npk, rho: o.rho }; };
const sOut = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x40 + i)]);
const rExit = hsL('test-exit-r', s1);

const cases = {
  pay: { inputs: [inp(k1, 1000n, 1), inp(k2, 234n, 3)], outputs: [bobOut(900n, sOut(0)), aliceOut(300n, sOut(1)), bobOut(34n, sOut(2))] },
  partialExit: { inputs: [inp(k1, 1000n, 1), null], outputs: [aliceOut(350n, sOut(3)), bobOut(50n, sOut(4)), null], exit: { v: 600n, r: rExit } },
  shield: { inputs: [null, null], outputs: [aliceOut(777n, sOut(5)), null, null], dep: { v: 777n, r: hsL('test-dep-r', s2) }, bh: bodyHash(te.encode('T_BTC_SHIELD body')) },
};
const build = (c, extra = {}) => zk.buildWitness({ root: T.root, bodyHash: c.bh ?? BH, assetF, ...c, ...extra });

console.log('reference model');
{
  const o = zk.outputKeys(alice.A, alice.N, s1);
  assert.ok(ptEq(o.Ak, k1.Ak) && ptEq(o.NK, k1.NK) && o.npk === k1.npk && o.rho === k1.rho);
  assert.ok(ptEq(mulB8(k1.sk), k1.Ak) && ptEq(mulB8(k1.nk), k1.NK));
  ok('sender and owner derive the same Ak, NK, npk, rho; sk·B8 = Ak, nk·B8 = NK');
  const other = zk.walletKeys(seed, 'mainnet');
  assert.notStrictEqual(other.a, alice.a);
  assert.ok(!ptEq(zk.ownedKeys(alice, s2).Ak, k1.Ak));
  ok('network and shared secret separate keys');
  const sig = zk.sign(k1.sk, BH);
  assert.ok(zk.verify(k1.Ak, BH, sig));
  assert.ok(!zk.verify(k1.Ak, BH + 1n, sig));
  assert.ok(!zk.verify(k2.Ak, BH, sig));
  ok('EdDSA-Poseidon sign/verify; wrong message or key rejected');
  assert.strictEqual(zk.rootFromPath(leaf2, 3, T.path(3)), T.root);
  assert.throws(() => zk.nullifier(k1.nk + L_BJJ, leaf1, 1));
  assert.throws(() => zk.nullifier(k1.nk, leaf1, 2 ** 32));
  ok('Merkle path round trip; nullifier refuses non-canonical nk and index ≥ 2^32');
  assert.ok(bppGens().H.equals(H_SECP));
  ok('BP+ and the cross-curve sigma share the secp Pedersen H');
}

console.log('valid proofs (DEV zkey, signet only)');
const proofs = {};
for (const [name, c] of Object.entries(cases)) {
  const { input, publicSignals: pub } = build(c);
  const t0 = performance.now();
  const { proof, publicSignals, wire } = await proveSpend(input, { wasm, zkey, snarkjs });
  const dt = performance.now() - t0;
  assert.deepStrictEqual(publicSignals, pub);
  assert.ok(await verifySpend(vk, pub, proof, { snarkjs }));
  assert.ok(await verifySpend(vk, pub, wire, { snarkjs }));
  assert.deepStrictEqual(decodeProof(encodeProof(proof)).pi_a.slice(0, 2), proof.pi_a.slice(0, 2));
  proofs[name] = { proof, pub, wire, input };
  ok(`${name}: proves and verifies (${(dt / 1000).toFixed(2)} s fullProve), 256-byte wire round trip`);
}
assert.ok(publicsAcceptable({ nf: proofs.pay.input.nf }));
assert.ok(publicsAcceptable({ nf: proofs.partialExit.input.nf }));
assert.ok(publicsAcceptable({ nf: proofs.shield.input.nf, shield: true }));
ok('indexer publics rules accept pay, partial exit and shield');

console.log('soundness negatives');
const base = build(cases.pay).input;
const baseExit = build(cases.partialExit).input;
const baseShield = build(cases.shield).input;
assert.ok(await satisfies(base));
const neg = async (label, input) => { assert.strictEqual(await satisfies(input), false, label); ok(label); };
// Euclidean mod: a deliberately wrapped (negative) value lands in [0, 2^64) like the in-circuit residue.
const mod64 = (v) => ((v % (1n << 64n)) + (1n << 64n)) % (1n << 64n);
const relink = (x, k) => { x.outLeaf[k] = S(zk.leafOf(assetF, mod64(BigInt(x.outV[k])), BigInt(x.outNpk[k]), BigInt(x.outRho[k]))); };

{
  const x = clone(base); x.outV[0] = S(BigInt(x.outV[0]) + 1n); relink(x, 0);
  await neg('inflation: outputs exceed inputs', x);
}
{
  const x = clone(base); x.outV[0] = S(P_FR - 1n); x.outV[1] = S(BigInt(x.outV[1]) + 1n + BigInt(base.outV[0]));
  x.outLeaf[0] = S(zk.H([assetF, P_FR - 1n, BigInt(x.outNpk[0]), BigInt(x.outRho[0])])); relink(x, 1);
  await neg('range: a field-negative output balancing a larger one', x);
}
{
  const vBig = (1n << 64n) + 1n;
  const lb = zk.H([assetF, vBig, k1.npk, k1.rho]);
  const T2 = zk.tree([lb]);
  const x = clone(base);
  x.root = S(T2.root); x.inV = [S(vBig), '0']; x.inIndex = ['0', '0']; x.inPath = [T2.path(0).map(S), x.inPath[1]];
  x.nf = [S(zk.H([k1.nk, lb, 0n])), '0'];
  x.outV = [S(vBig), '0', '0']; x.outLeaf = [S(zk.H([assetF, vBig, BigInt(x.outNpk[0]), BigInt(x.outRho[0])])), '0', '0'];
  await neg('range: an input ≥ 2^64 that is a tree member', x);
}
{
  const x = clone(baseExit); x.exitV = S((1n << 64n) + 600n); x.outV[0] = S(BigInt(x.outV[0]) - (1n << 64n)); relink(x, 0);
  await neg('range: exit value ≥ 2^64 against a wrapped output', x);
}
{
  const x = clone(base); x.root = S(BigInt(x.root) + 1n);
  await neg('wrong root', x);
  const { proof, pub } = proofs.pay;
  const bad = [...pub]; bad[0] = S(zk.tree([leaf1]).root);
  assert.strictEqual(await verifySpend(vk, bad, proof, { snarkjs }), false);
  ok('wrong root: a valid proof does not verify under another root');
}
{
  const forged = zk.leafOf(assetF, 5000n, k1.npk, k1.rho);
  const x = clone(base); x.inV[0] = '5000'; x.outV[0] = S(BigInt(x.outV[0]) + 4000n); relink(x, 0);
  x.nf[0] = S(zk.nullifier(k1.nk, forged, 1));
  await neg('membership: a leaf that is not in the tree', x);
}
{
  const x = clone(base); const idx = (1n << 32n) + 1n; x.inIndex[0] = S(idx);
  x.nf[0] = S(zk.H([k1.nk, leaf1, idx]));
  await neg('nullifier alias: index + 2^32', x);
}
{
  const x = clone(base); const nk = k1.nk + L_BJJ; x.inNk[0] = S(nk);
  x.nf[0] = S(zk.H([nk, leaf1, 1n]));
  await neg('nullifier alias: nk_note + l', x);
}
{
  const x = clone(base); const nk = L_BJJ - k1.nk; x.inNk[0] = S(nk);
  x.nf[0] = S(zk.H([nk, leaf1, 1n]));
  await neg('nullifier alias: l − nk_note (negated NK)', x);
}
{
  const x = clone(base); x.nf[0] = S(BigInt(x.nf[0]) + 1n);
  await neg('nullifier: any value other than Poseidon(nk, leaf, index)', x);
}
{
  const c = { inputs: [inp(k1, 1000n, 1), inp(k1, 1000n, 1)], outputs: [bobOut(2000n, sOut(6)), null, null] };
  const { input } = build(c);
  assert.strictEqual(input.nf[0], input.nf[1]);
  assert.strictEqual(publicsAcceptable({ nf: input.nf }), false);
  ok('one note in both slots yields one nullifier twice; the indexer distinctness rule rejects it');
}
{
  const x = clone(base); x.nf[1] = '0';
  await neg('empty slot: nf = 0 with a non-zero value', x);
  const y = clone(base); y.outLeaf[2] = '0';
  await neg('empty output: leaf 0 with a non-zero value', y);
}
{
  const x = clone(base); x.bodyHash = S(BigInt(x.bodyHash) + 1n);
  await neg('body-hash tamper: signatures are over the original body', x);
  const { proof, pub } = proofs.pay;
  const bad = [...pub]; bad[1] = S(bodyHash(te.encode('another body')));
  assert.strictEqual(await verifySpend(vk, bad, proof, { snarkjs }), false);
  ok('body-hash tamper: a valid proof does not verify for another body');
}
{
  const x = clone(base); const sg = zk.sign(k1.sk + 1n, BH); x.sigR8[0] = sg.R8.map(S); x.sigS[0] = S(sg.S);
  await neg('wrong owner: signature under another key', x);
  const tA = zk.noteTweaks(s1).tA; const sg2 = zk.sign(tA, BH);
  const y = clone(base); y.sigR8[0] = sg2.R8.map(S); y.sigS[0] = S(sg2.S);
  await neg('wrong owner: the sender, who knows t_a but not a', y);
  const other = bodyHash(te.encode('redirected body'));
  const z = clone(base); z.bodyHash = S(other);
  await neg('delegated prover: a signed body cannot be proved as another body', z);
}
{
  const x = clone(base); x.depC = pedersenBJJ(0n, 0n).map(S); x.depV = '5'; x.depR = '0'; x.outV[0] = S(BigInt(x.outV[0]) + 5n); relink(x, 0);
  await neg('deposit: a spend with depC = identity cannot add value', x);
  const y = clone(baseShield); y.depV = S(BigInt(y.depV) + 1n); y.outV[0] = S(BigInt(y.outV[0]) + 1n); relink(y, 0);
  await neg('deposit: shield value must open depC', y);
}
{
  const x = clone(baseExit); x.exitV = S(BigInt(x.exitV) + N_BJJ);
  x.outV[0] = S((BigInt(x.outV[0]) - N_BJJ + P_FR) % P_FR);
  x.outLeaf[0] = S(zk.H([assetF, BigInt(x.outV[0]), BigInt(x.outNpk[0]), BigInt(x.outRho[0])]));
  const y = clone(baseExit); y.exitV = S(BigInt(y.exitV) + SECP_N);
  await neg('exit: v + l opens the same BabyJub point but fails the 64-bit range', x);
  await neg('exit: v + n_secp fails the 64-bit range', y);
  const z = clone(baseExit); z.exitV = S(BigInt(z.exitV) - 1n);
  await neg('exit: value must open exitC', z);
}

console.log('boundary (sigma + BP+)');
const seedKey = new Uint8Array(32).fill(0x5a);
const bdExit = proveBoundary({ v: 600n, rSecp: hsP('test-exit-secp', s1) % SECP_N, rBjj: rExit, seedKey });
{
  const Cb = verifyBoundary(bdExit);
  assert.ok(Cb && ptEq(Cb, pedersenBJJ(600n, rExit)));
  assert.deepStrictEqual(Cb.map(S), proofs.partialExit.input.exitC);
  const rt = decodeBoundary(encodeBoundary(bdExit));
  assert.ok(verifyBoundary(rt));
  assert.strictEqual(encodeBoundary(bdExit).length, BOUNDARY_LEN);
  ok(`exit boundary verifies and yields the circuit's exitC (${BOUNDARY_LEN} bytes)`);
}
{
  const other = pointToBytes(pedersenCommit(601n, hsP('test-exit-secp', s1) % SECP_N));
  assert.strictEqual(verifyBoundary({ ...bdExit, cSecp: other }), null);
  ok('exit mismatch: secp commitment to v + 1 against the same sigma is rejected');
  const fresh = proveBoundary({ v: 601n, rSecp: 99n, rBjj: 77n, seedKey });
  assert.strictEqual(verifyBoundary({ ...fresh, cBjj: bdExit.cBjj }), null);
  ok('exit mismatch: a sigma for another BabyJub commitment is rejected');
  const t = bdExit.bpp.slice(); t[200] ^= 1;
  assert.strictEqual(verifyBoundary({ ...bdExit, bpp: t }), null);
  ok('exit: a corrupted BP+ is rejected');
}
{
  // Wrap: secp side commits v + l, BabyJub side v (the same BabyJub point, (v + l)·H_BJJ = v·H_BJJ).
  const v = 600n, a = v + N_BJJ, rs = 4242n, rb = rExit;
  const Cs = pedersenCommit(a, rs);
  const csb = pointToBytes(Cs), cbb = packPoint(pedersenBJJ(a, rb));
  assert.deepStrictEqual(cbb, packPoint(pedersenBJJ(v, rb)));
  // Honest sigma arithmetic with a ≈ 2^251: z_a = alpha + e·a needs ≈ 2^379 > 2^320, so it cannot be encoded.
  const alpha = 12345n, bs = 777n, bb = 888n;
  const As = H_SECP.multiply(alpha).add(G_SECP.multiply(bs));
  const Ab = addPoint(mulScalar(H_BJJ(), alpha), mulScalar(G_BJJ(), bb));
  const e = xcChallenge(csb, cbb, pointToBytes(As), packPoint(Ab));
  const za = alpha + e * a;
  assert.ok(za >= 1n << 320n);
  const zaTrunc = za % (1n << 320n);
  const proof = new Uint8Array(169);
  proof.set(pointToBytes(As), 0); proof.set(packPoint(Ab), 33);
  proof.set(Buffer.from(zaTrunc.toString(16).padStart(80, '0'), 'hex'), 65);
  proof.set(be32((bs + e * rs) % SECP_N), 105); proof.set(be32((bb + e * rb) % N_BJJ), 137);
  assert.strictEqual(verifyXCurve(proof, csb, cbb), false);
  ok('mod-order wrap: a sigma for secp v + l / BabyJub v needs z_a ≥ 2^320 and a truncated one fails');
  const { proof: bpp } = bppRangeProve([a % (1n << 64n)], [rs], true);
  assert.strictEqual(bppRangeVerify([Cs], bpp), false);
  assert.strictEqual(verifyBoundary({ cSecp: csb, cBjj: cbb, sigma: proof, bpp }), null);
  ok('mod-order wrap: the secp BP+ rejects v + l, so the boundary rejects even with the BabyJub range held');
}
const bdShield = proveBoundary({ v: 777n, rSecp: 31337n, rBjj: hsL('test-dep-r', s2), seedKey });
{
  const Cb = verifyBoundary(bdShield);
  assert.deepStrictEqual(Cb.map(S), proofs.shield.input.depC);
  ok('shield boundary verifies and yields the circuit depC');
}

console.log('vectors');
const pts = (p) => p.map(S);
const vecDeterministic = () => {
  const polys = [[1n, 2n], [1n, 2n, 3n], [1n, 2n, 3n, 4n], [1n, 2n, 3n, 4n, 5n], [P_FR - 1n, 0n, 7n]];
  const notes = [s1, s2].map((s, i) => {
    const k = zk.ownedKeys(alice, s); const t = zk.noteTweaks(s); const v = [1000n, 234n][i]; const index = [1, 3][i];
    const leaf = zk.leafOf(assetF, v, k.npk, k.rho);
    return { s: hex(s), t_a: S(t.tA), t_n: S(t.tN), rho: S(t.rho), sk: S(k.sk), nk: S(k.nk), Ak: pts(k.Ak), NK: pts(k.NK), npk: S(k.npk), v: S(v), leaf: S(leaf), index, nf: S(zk.nullifier(k.nk, leaf, index)) };
  });
  const sig = zk.sign(k1.sk, BH);
  return {
    note: 'Generated by tests/btc-pool-zk.test.mjs (REGEN=1). Field elements decimal, bytes hex.',
    poseidon: polys.map((xs) => ({ inputs: xs.map(S), out: S(zk.H(xs)) })),
    hs: [{ tag: 'tacit-btc-pool-zk-rho-v1', data: hex(s1), l: S(hsL('tacit-btc-pool-zk-rho-v1', s1)), p: S(hsP('tacit-btc-pool-zk-rho-v1', s1)) }],
    base8: pts(BASE8),
    wallet: { seed: hex(seed), network: 'signet', a: S(alice.a), n: S(alice.n), A: pts(alice.A), N: pts(alice.N) },
    asset: hex(ASSET), assetF: S(assetF),
    notes,
    tree: { leaves: [123n, leaf1, 456n, leaf2].map(S), root: S(T.root), paths: [1, 3].map((i) => ({ index: i, path: T.path(i).map(S) })), zeros32: S(zk.zeros[32]) },
    body: { hex: hex(body), bodyHash: S(BH) },
    eddsa: { A: pts(k1.Ak), M: S(BH), R8: pts(sig.R8), S: S(sig.S) },
    pedersen: [{ v: '600', r: S(rExit), C: pts(pedersenBJJ(600n, rExit)), packed: hex(packCommitment(pedersenBJJ(600n, rExit))) }],
  };
};
const det = vecDeterministic();
if (process.env.REGEN || !existsSync(VEC)) {
  const tampered = [...proofs.pay.pub]; tampered[1] = S(BigInt(tampered[1]) + 1n);
  const badBd = encodeBoundary({ ...bdExit, cSecp: pointToBytes(pedersenCommit(601n, 5n)) });
  const out = {
    ...det,
    boundary: [
      { hex: hex(encodeBoundary(bdExit)), valid: true, C_bjj: pts(pedersenBJJ(600n, rExit)) },
      { hex: hex(encodeBoundary(bdShield)), valid: true, C_bjj: proofs.shield.input.depC },
      { hex: hex(badBd), valid: false },
    ],
    groth16: {
      note: 'DEV single-contributor key, signet only. Regenerate with the dev zkey.',
      vk,
      cases: [
        ...Object.entries(proofs).map(([name, p]) => ({ name, proof: hex(p.wire), publics: p.pub, valid: true })),
        { name: 'pay-tampered-bodyHash', proof: hex(proofs.pay.wire), publics: tampered, valid: false },
      ],
    },
  };
  writeFileSync(VEC, JSON.stringify(out, null, 1) + '\n');
  ok(`wrote ${VEC}`);
} else {
  const stored = JSON.parse(readFileSync(VEC, 'utf8'));
  for (const k of Object.keys(det)) assert.deepStrictEqual(stored[k], det[k], `vector field ${k}`);
  for (const b of stored.boundary) assert.strictEqual(!!verifyBoundary(decodeBoundary(unhex(b.hex))), b.valid);
  for (const c of stored.groth16.cases) {
    assert.strictEqual(await verifySpend(stored.groth16.vk, c.publics, unhex(c.proof), { snarkjs }), c.valid, c.name);
  }
  ok('stored vectors match the JS reference; stored boundary and Groth16 cases verify as recorded');
}

console.log('measurements');
{
  const info = await snarkjs.r1cs.info(R1CS, quiet);
  const wtns = { type: 'mem' };
  let t0 = performance.now();
  await snarkjs.wtns.calculate(proofs.pay.input, wasm, wtns);
  const tw = performance.now() - t0;
  const time = async (singleThread) => {
    const xs = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await snarkjs.groth16.prove(zkey, wtns, undefined, { singleThread });
      xs.push((performance.now() - t) / 1000);
    }
    return xs.map((x) => x.toFixed(2)).join(' / ');
  };
  const multi = await time(false);
  const single = await time(true);
  t0 = performance.now();
  await snarkjs.groth16.verify(vk, proofs.pay.pub, proofs.pay.proof, quiet);
  const tv = (performance.now() - t0) / 1000;
  console.log(`    constraints ${info.nConstraints}, public ${info.nPubInputs}, private ${info.nPrvInputs}, wires ${info.nVars}`);
  console.log(`    zkey ${statSync(ZKEY).size} B, wasm ${statSync(WASM).size} B`);
  console.log(`    witness ${(tw / 1000).toFixed(2)} s; prove ${cpus().length} threads ${multi} s; 1 thread ${single} s; verify ${tv.toFixed(2)} s`);
  ok('measured');
}

console.log(`\n${n} checks passed`);
process.exit(0);
