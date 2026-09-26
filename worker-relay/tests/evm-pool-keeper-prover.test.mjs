// The keeper's real proving path with the DEV zkey: a deposit completion built through the gateway, proven,
// verified, and laid out exactly as snarkjs's Solidity calldata export; plus revert-name decoding of a real
// viem revert error. Needs the evm-pool circuit build (see tests/evm-pool-zk.test.mjs); skips without it.
//   node worker-relay/tests/evm-pool-keeper-prover.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, toFunctionSelector } from 'viem';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { depositIntent, completionWitness } from '../../dapp/evm-pool-gateway.js';
import { loadKeeperConfig } from '../src/lib/evm-pool-keeper-config.js';
import { makeKeeperProver, loadZk } from '../src/lib/evm-pool-keeper-prover.js';
import { ROUTER_ABI, revertName } from '../src/lib/evm-pool-keeper-chain.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

await test('revertName decodes a router/pool custom error from a viem revert', () => {
  const cause = new ContractFunctionRevertedError({ abi: ROUTER_ABI, data: toFunctionSelector('StaleRoot()'), functionName: 'completeDeposit' });
  const e = new ContractFunctionExecutionError(cause, { abi: ROUTER_ABI, functionName: 'completeDeposit', args: [] });
  assert.equal(revertName(e), 'StaleRoot');
  assert.equal(revertName(new Error('connection reset')), null);
});

const cfg = loadKeeperConfig({ EVM_POOL_ADDR: '0x1111111111111111111111111111111111111111', EVM_POOL_ROUTER_ADDR: '0x2222222222222222222222222222222222222222', EVM_POOL_RPC_URL: 'http://127.0.0.1:1' });
if (![cfg.wasm, cfg.zkey, cfg.vk].every(existsSync)) {
  console.log('skip - real prover: dev circuit artifacts not built');
} else {
  await test('a deposit completion proves, verifies, and matches the Solidity calldata layout', async () => {
    const snarkjs = await import('snarkjs');
    const zk = await loadZk();
    const prover = await makeKeeperProver(cfg);
    const chainId = 1n;
    const pool = cfg.pool;
    const keeper = '0x4444444444444444444444444444444444444444';
    const asset = poolAsset({ chainId, pool, token: '0x3333333333333333333333333333333333333333' });
    const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'mainnet');
    const o = zk.outputKeys(alice.A, alice.N, Uint8Array.from([2, 1, ...new Uint8Array(31).fill(0x61)]));
    const { intent, hint } = depositIntent(zk, { asset, amount: 1000n, outputs: [{ v: 990n, npk: o.npk, rho: o.rho }], memo0: '0xa11ce0', refund: keeper, deadline: 2_000_000_000n });
    const leaves = [11n, 12n, 13n, 0n];
    const w = completionWitness(zk, { intent, hint, asset, leaves, chainId, pool, relayer: keeper });
    const p = await prover.prove(w.input);
    assert.deepEqual(p.publicInputs.map(String), w.publicSignals);
    assert.equal(p.publicInputs[3], 4n);
    assert.equal(p.publicInputs[9], intent.outLeaf0);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.input, cfg.wasm, cfg.zkey);
    const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
    const { toSolidityProof } = await import('../src/lib/evm-pool-keeper-prover.js');
    const mine = toSolidityProof(proof, publicSignals);
    const big = (x) => (Array.isArray(x) ? x.map(big) : BigInt(x));
    assert.deepEqual([mine.pA, mine.pB, mine.pC, mine.publicInputs], big(cd));
  });
}

console.log(`\n${n} passed`);
process.exit(0);
