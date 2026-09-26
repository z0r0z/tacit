// dapp/evm-pool-gateway.js: deposit-box intents, keeper completion proofs and withdrawals to a box, proven with
// the DEV zkey (see tests/evm-pool-zk.test.mjs for the build steps).
//   node tests/evm-pool-gateway.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { makeEvmPoolZk, poolAsset } from '../dapp/evm-pool-zk.js';
import { proveTransact, verifyTransact } from '../dapp/evm-pool-zk-prover.js';
import { depositIntent, completionWitness, withdrawalWitness } from '../dapp/evm-pool-gateway.js';

const DIR = new URL('../dapp/circuits/evm-pool/build/', import.meta.url).pathname;
const wasm = readFileSync(DIR + 'transact_js/transact.wasm');
const zkey = readFileSync(DIR + 'transact_dev_final.zkey');
const vk = JSON.parse(readFileSync(DIR + 'transact_dev_vk.json', 'utf8'));
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const CHAIN_ID = 1n;
const POOL = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const KEEPER = '0x3333333333333333333333333333333333333333';
const BOX = '0x4444444444444444444444444444444444444444';
const REFUND = '0x5555555555555555555555555555555555555555';
const asset = poolAsset({ chainId: CHAIN_ID, pool: POOL, token: TOKEN });
const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
const s = (i) => Uint8Array.from([2, i, ...new Uint8Array(31).fill(0x60 + i)]);
const out = (v, i) => { const o = zk.outputKeys(alice.A, alice.N, s(i)); return { v, npk: o.npk, rho: o.rho }; };

console.log('deposit intents');
{
  assert.throws(() => depositIntent(zk, { asset, amount: 10n, outputs: [out(11n, 0)], refund: REFUND, deadline: 1n }));
  ok('outputs above the deposit are refused');
}
const { intent, hint } = depositIntent(zk, { asset, amount: 1000n, outputs: [out(990n, 0)], memo0: '0xa11ce0', refund: REFUND, deadline: 2_000_000_000n, nonce: 1n });
assert.strictEqual(hint.fee, 10n);
assert.strictEqual(intent.outLeaf1, 0n);
ok('fee is the deposit minus the outputs; an empty slot is leaf 0');

console.log('keeper completion (real proof)');
let leaves = [11n, 22n];
{
  const w = completionWitness(zk, { intent, hint, asset, leaves, chainId: CHAIN_ID, pool: POOL, relayer: KEEPER });
  const { proof, publicSignals } = await proveTransact(w.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, publicSignals, proof, { snarkjs }));
  assert.strictEqual(BigInt(publicSignals[9]), intent.outLeaf0);
  assert.strictEqual(w.tx.fee, 10n);
  leaves = [...leaves, ...w.outLeaf];
  ok('a keeper proves exactly the intent\'s leaves and collects the fee');

  const forged = { ...hint, outputs: [out(990n, 5), null] };
  assert.throws(() => completionWitness(zk, { intent, hint: forged, asset, leaves, chainId: CHAIN_ID, pool: POOL, relayer: KEEPER }));
  ok('a hint for other notes does not match the intent');
}

console.log('withdraw to a box (real proof)');
{
  const k = zk.ownedKeys(alice, s(0));
  const note = { v: 990n, rho: k.rho, nk: k.nk, sk: k.sk, index: 2 };
  const w = withdrawalWitness(zk, { asset, leaves, inputs: [note, null], change: out(300n, 1), amount: 680n, recipient: BOX, relayer: KEEPER, fee: 10n, chainId: CHAIN_ID, pool: POOL });
  const { proof, publicSignals } = await proveTransact(w.input, { wasm, zkey, snarkjs });
  assert.ok(await verifyTransact(vk, publicSignals, proof, { snarkjs }));
  assert.strictEqual(w.tx.extAmount, -680n);
  ok('withdraw 680 to a box with 300 change and a 10 fee');
}

console.log(`${n} checks passed`);
process.exit(0);
