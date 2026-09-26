// Real-proof fixture for contracts/test/TacitEvmPool.t.sol: a deposit, a private transfer and a withdraw with a
// relayer fee, each proven with the DEV zkey against the pool state the previous one left behind.
//
// The pool's asset field binds (chainid, pool, token), so the fixture fixes all three: chainid 31337 and the
// addresses Foundry's default test contract gets for its first CREATEs (token, then verifier, then pool). The
// Solidity test asserts both addresses before using the fixture.
//
//   (cd dapp/circuits && npm ci) && bash dapp/circuits/evm-pool/build.sh
//   PTAU=<pinned pot18> bash dapp/circuits/evm-pool/build-dev-zkey.sh
//   node tests/gen-evm-pool-fixture.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeEvmPoolZk, poolAsset, extDataHash } from '../dapp/evm-pool-zk.js';
import { proveTransact } from '../dapp/evm-pool-zk-prover.js';

const DIR = new URL('../dapp/circuits/evm-pool/build/', import.meta.url).pathname;
const OUT = new URL('../contracts/test/fixtures/evm_pool_transact.json', import.meta.url).pathname;
const VERIFIER_OUT = new URL('../contracts/test/TransactVerifierDev.sol', import.meta.url).pathname;
const wasm = readFileSync(DIR + 'transact_js/transact.wasm');
const zkey = readFileSync(DIR + 'transact_dev_final.zkey');

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
function createAddress(sender, nonce) {
  if (nonce < 1 || nonce > 127) throw new Error('nonce out of single-byte RLP range');
  const rlp = Uint8Array.from([0xd6, 0x94, ...unhex(sender), nonce]);
  return hex(keccak_256(rlp).slice(12));
}

const CHAIN_ID = 31337n;
const TEST_CONTRACT = '0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496';
const TOKEN = createAddress(TEST_CONTRACT, 1);
const VERIFIER = createAddress(TEST_CONTRACT, 2);
const POOL = createAddress(TEST_CONTRACT, 3);
const DEPOSITOR = '0x00000000000000000000000000000000000d3905';
const RECIPIENT = '0x0000000000000000000000000000000000c0ffee';
const RELAYER = '0x0000000000000000000000000000000000000fee';
const asset = poolAsset({ chainId: CHAIN_ID, pool: POOL, token: TOKEN });

const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
const bob = zk.walletKeys(new Uint8Array(32).fill(9), 'mainnet');
const sOut = (i) => Uint8Array.from([2, i, ...new Uint8Array(31).fill(0x50 + i)]);
const outTo = (w, v, i) => { const o = zk.outputKeys(w.A, w.N, sOut(i)); return { v, npk: o.npk, rho: o.rho }; };
const owned = (w, v, i, index) => { const k = zk.ownedKeys(w, sOut(i)); return { v, rho: k.rho, nk: k.nk, sk: k.sk, index }; };

let leaves = [];
const steps = [];
async function step(name, { inputs, outputs, recipient, extAmount, relayer, fee, memo0, memo1 }) {
  const eh = extDataHash({ chainId: CHAIN_ID, pool: POOL, recipient, extAmount, relayer, fee, memo0: unhex(memo0), memo1: unhex(memo1) });
  const { input, outLeaf } = zk.buildWitness({ asset, leaves, inputs, outputs, extAmount, fee, extDataHash: eh });
  const { proof, publicSignals } = await proveTransact(input, { wasm, zkey, snarkjs });
  const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  if (outLeaf[0] !== 0n || outLeaf[1] !== 0n) leaves = [...leaves, ...outLeaf];
  steps.push({
    name, pA: cd[0], pB: cd[1], pC: cd[2], publicInputs: cd[3],
    recipient, extAmount: extAmount.toString(), relayer, fee: fee.toString(), memo0, memo1,
  });
  console.log(`  ${name}: proved, pool now ${leaves.length} leaves`);
}

await step('deposit', {
  inputs: [null, null], outputs: [outTo(alice, 1000n, 0), null],
  recipient: '0x0000000000000000000000000000000000000000', extAmount: 1000n, relayer: '0x0000000000000000000000000000000000000000', fee: 0n,
  memo0: '0xa11ce0', memo1: '0x',
});
await step('transfer', {
  inputs: [owned(alice, 1000n, 0, 0), null], outputs: [outTo(bob, 700n, 1), outTo(alice, 295n, 2)],
  recipient: '0x0000000000000000000000000000000000000000', extAmount: 0n, relayer: RELAYER, fee: 5n,
  memo0: '0xb0b1', memo1: '0xa11ce2',
});
await step('withdraw', {
  inputs: [owned(bob, 700n, 1, 2), null], outputs: [null, null],
  recipient: RECIPIENT, extAmount: -690n, relayer: RELAYER, fee: 10n,
  memo0: '0x', memo1: '0x',
});

writeFileSync(OUT, JSON.stringify({
  note: 'DEV zkey, tests only: tests/gen-evm-pool-fixture.mjs',
  chainId: CHAIN_ID.toString(), testContract: TEST_CONTRACT, token: TOKEN, verifier: VERIFIER, pool: POOL,
  depositor: DEPOSITOR, asset: '0x' + asset.toString(16).padStart(64, '0'), steps,
}, null, 2) + '\n');
const sol = readFileSync(DIR + 'TransactVerifierDev.sol', 'utf8').replace('contract Groth16Verifier {', 'contract TransactVerifierDev {');
if (!sol.includes('contract TransactVerifierDev {')) throw new Error('unexpected verifier contract name');
writeFileSync(VERIFIER_OUT, sol);
console.log(`wrote ${OUT} and ${VERIFIER_OUT}`);
process.exit(0);
