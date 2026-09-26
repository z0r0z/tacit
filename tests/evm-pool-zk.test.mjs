// EVM shielded pool: reference model, transact.circom proofs (deposit, transfer, withdraw), soundness
// negatives.
//
// Needs the circuit and a DEV zkey:
//   (cd dapp/circuits && npm ci) && bash dapp/circuits/evm-pool/build.sh
//   PTAU=<pinned pot18> bash dapp/circuits/evm-pool/build-dev-zkey.sh
// Run: node tests/evm-pool-zk.test.mjs
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7, poseidon8 } from 'poseidon-lite';

import { makeEvmPoolZk, poolAsset, extDataHash, publicAmount, publicSignals, EVM_N_IN, EVM_N_OUT } from '../dapp/evm-pool-zk.js';
import { proveTransact, verifyTransact, encodeProof, decodeProof } from '../dapp/evm-pool-zk-prover.js';
import { P_FR } from '../dapp/amm-bjj.js';

const DIR = new URL('../dapp/circuits/evm-pool/build/', import.meta.url).pathname;
const WASM = DIR + 'transact_js/transact.wasm';
const R1CS = DIR + 'transact.r1cs';
const ZKEY = DIR + 'transact_dev_final.zkey';
const VKF = DIR + 'transact_dev_vk.json';
for (const f of [WASM, R1CS, ZKEY, VKF]) {
  if (!existsSync(f)) { console.error(`missing ${f}: run build.sh and build-dev-zkey.sh (see header)`); process.exit(1); }
}
const vk = JSON.parse(readFileSync(VKF, 'utf8'));
const wasm = readFileSync(WASM);
const zkey = readFileSync(ZKEY);

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7, 8: poseidon8 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const S = (x) => BigInt(x).toString();
const clone = (x) => JSON.parse(JSON.stringify(x));

async function satisfies(input) {
  try {
    const wtns = { type: 'mem' };
    await snarkjs.wtns.calculate(input, wasm, wtns);
    return await snarkjs.wtns.check(R1CS, wtns, quiet);
  } catch {
    return false;
  }
}

// ── fixture ──
const CHAIN_ID = 8453n;
const POOL = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const RELAYER = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
const asset = poolAsset({ chainId: CHAIN_ID, pool: POOL, token: TOKEN });

const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
const bob = zk.walletKeys(new Uint8Array(32).fill(9), 'mainnet');
const sOut = (i) => Uint8Array.from([2, i, ...new Uint8Array(31).fill(0x50 + i)]);
const outTo = (wallet, v, i) => { const o = zk.outputKeys(wallet.A, wallet.N, sOut(i)); return { v, npk: o.npk, rho: o.rho }; };

const eh = (extAmount, fee, memo0, memo1) => extDataHash({ chainId: CHAIN_ID, pool: POOL, recipient: RECIPIENT, extAmount, relayer: RELAYER, fee, memo0, memo1 });

console.log('reference model');
{
  const t = zk.tree([]);
  const ins = zk.insert([1n, 2n], 0n, t.siblings(1, 0));
  assert.strictEqual(ins, zk.tree([1n, 2n]).root);
  ok('insert() against an empty tree matches tree() built from scratch');

  const t4 = zk.tree([10n, 20n, 30n, 40n]);
  const ins2 = zk.insert([50n, 60n], 4n, t4.siblings(1, 2));
  assert.strictEqual(ins2, zk.tree([10n, 20n, 30n, 40n, 50n, 60n]).root);
  ok('insert() onto a non-empty tree matches an append');

  assert.strictEqual(publicAmount(1000n, 0n), 1000n);
  assert.strictEqual(publicAmount(-1000n, 0n), P_FR - 1000n);
  assert.strictEqual(publicAmount(0n, 5n), P_FR - 5n);
  ok('publicAmount: deposit positive, withdraw wraps mod p, fee subtracts');
}

console.log('valid proofs (DEV zkey, tests/testnets only)');
const proofs = {};
let leaves = [];
let pool = zk.tree(leaves);

async function run(name, c) {
  const { input, publicSignals: pub, newRoot, outLeaf } = zk.buildWitness({ asset, leaves, ...c });
  const t0 = performance.now();
  const { proof, publicSignals, wire } = await proveTransact(input, { wasm, zkey, snarkjs });
  const dt = performance.now() - t0;
  assert.deepStrictEqual(publicSignals, pub);
  assert.ok(await verifyTransact(vk, pub, proof, { snarkjs }));
  assert.ok(await verifyTransact(vk, pub, wire, { snarkjs }));
  assert.deepStrictEqual(decodeProof(encodeProof(proof)).pi_a.slice(0, 2), proof.pi_a.slice(0, 2));
  proofs[name] = { proof, pub, wire, input };
  if (outLeaf[0] !== 0n || outLeaf[1] !== 0n) leaves = [...leaves, ...outLeaf];
  pool = zk.tree(leaves);
  assert.strictEqual(pool.root, newRoot);
  ok(`${name}: proves and verifies (${(dt / 1000).toFixed(2)} s fullProve), pool grows to ${leaves.length} leaves`);
}

await run('deposit', {
  inputs: [null, null],
  outputs: [outTo(alice, 1000n, 0), null],
  extAmount: 1000n, fee: 0n, extDataHash: eh(1000n, 0n),
});
const alice0 = { v: 1000n, npk: zk.outputKeys(alice.A, alice.N, sOut(0)).npk, rho: zk.outputKeys(alice.A, alice.N, sOut(0)).rho, nk: zk.ownedKeys(alice, sOut(0)).nk, sk: zk.ownedKeys(alice, sOut(0)).sk, index: 0 };

await run('transfer', {
  inputs: [alice0, null],
  outputs: [outTo(bob, 700n, 1), outTo(alice, 300n, 2)],
  extAmount: 0n, fee: 0n, extDataHash: eh(0n, 0n),
});
const bob1 = { v: 700n, npk: zk.outputKeys(bob.A, bob.N, sOut(1)).npk, rho: zk.outputKeys(bob.A, bob.N, sOut(1)).rho, nk: zk.ownedKeys(bob, sOut(1)).nk, sk: zk.ownedKeys(bob, sOut(1)).sk, index: 2 };

await run('withdraw-with-relayer-fee', {
  inputs: [bob1, null],
  outputs: [null, null],
  extAmount: -690n, fee: 10n, extDataHash: eh(-690n, 10n),
});

console.log('soundness negatives');
const base = clone(proofs.transfer.input);
const neg = async (label, input) => { assert.strictEqual(await satisfies(input), false, label); ok(label); };

{
  const x = clone(base); x.publicAmount = S(BigInt(x.publicAmount) + 1n);
  await neg('publicAmount tamper breaks the signed message binding', x);
}
{
  const x = clone(base); x.outV[0] = S(BigInt(x.outV[0]) + 1n);
  await neg('inflation: an output value the leaf hash does not commit to', x);
}
{
  const x = clone(base); x.newRoot = S(BigInt(x.newRoot) + 1n);
  await neg('wrong newRoot: insertion proof fails', x);
}
{
  const x = clone(base); x.oldRoot = S(BigInt(x.oldRoot) + 1n);
  await neg('wrong oldRoot: insertion proof fails against the empty-pair check', x);
}
{
  const x = clone(base); x.startIndex = S(BigInt(x.startIndex) + 2n);
  await neg('wrong startIndex: insertion lands at the wrong tree position', x);
}
{
  const x = clone(base); x.root = S(BigInt(x.root) + 1n);
  await neg('wrong membership root', x);
  const { proof, pub } = proofs.transfer;
  const bad = [...pub]; bad[0] = S(zk.tree([1n]).root);
  assert.strictEqual(await verifyTransact(vk, bad, proof, { snarkjs }), false);
  ok('wrong root: a valid proof does not verify under another root');
}
{
  const x = clone(base); x.nf[0] = S(BigInt(x.nf[0]) + 1n);
  await neg('nullifier: any value other than Poseidon(nk, leaf, index)', x);
}
{
  const x = clone(base); const sg = zk.sign(BigInt(base.inNk[0]) + 1n, zk.message({ asset, nf: base.nf.map(BigInt), outLeaf: base.outLeaf.map(BigInt), publicAmount: BigInt(base.publicAmount), extDataHash: BigInt(base.extDataHash) }));
  x.sigR8[0] = sg.R8.map(S); x.sigS[0] = S(sg.S);
  await neg('wrong owner: signature under another key', x);
}
{
  const x = clone(base); x.extDataHash = S(BigInt(x.extDataHash) + 1n);
  await neg('extDataHash tamper: signatures are over the original message', x);
  const { proof, pub } = proofs.transfer;
  const bad = [...pub]; bad[5] = S(BigInt(pub[5]) + 1n);
  assert.strictEqual(await verifyTransact(vk, bad, proof, { snarkjs }), false);
  ok('extDataHash tamper: a valid proof does not verify for another binding');
}
{
  const x = clone(base); x.nf[0] = '0';
  await neg('empty slot: nf = 0 with a non-zero value', x);
  const y = clone(base); y.outLeaf[0] = '0';
  await neg('empty output: leaf 0 with a non-zero value', y);
}
{
  const oob = { v: 1n << 120n, npk: 0n, rho: 0n };
  assert.throws(() => zk.buildWitness({ asset, leaves, inputs: [null, null], outputs: [oob, null], extAmount: 1n << 120n, fee: 0n, extDataHash: 0n }));
  ok('buildWitness refuses a value ≥ 2^120');
}
{
  const p = zk.ownedKeys(alice, sOut(0));
  assert.throws(() => zk.buildWitness({ asset, leaves: [], inputs: [{ ...alice0, index: 1 }, null], outputs: [outTo(alice, 1000n, 0), null], extAmount: 0n, fee: 0n, extDataHash: 0n }));
  ok('buildWitness refuses an input whose claimed leaf is not at its index');
}
{
  const w = proofs['withdraw-with-relayer-fee'].input;
  assert.strictEqual(w.newRoot, w.oldRoot);
  const x = clone(w); x.newRoot = S(BigInt(x.newRoot) + 1n);
  await neg('no outputs: the root cannot move', x);
}
{
  const a1 = zk.buildWitness({ asset, leaves, inputs: [{ dummy: true }, null], outputs: [outTo(alice, 0n, 9), null], extAmount: 0n, fee: 0n, extDataHash: 0n });
  const a2 = zk.buildWitness({ asset, leaves, inputs: [{ dummy: true }, null], outputs: [outTo(alice, 0n, 9), null], extAmount: 0n, fee: 0n, extDataHash: 0n });
  assert.notStrictEqual(a1.nf[0], a2.nf[0]);
  assert.ok(await satisfies(a1.input));
  ok('dummy inputs get fresh keys: distinct nullifiers, and the witness satisfies the circuit');
}

console.log(`${n} checks passed`);
process.exit(0);
