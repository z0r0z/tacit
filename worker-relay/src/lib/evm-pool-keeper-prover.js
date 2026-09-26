// Groth16 proving for the keeper's deposit completions (dapp/circuits/evm-pool/transact.circom), and the
// Poseidon-backed witness model. Every fresh proof is verified against the verification key before it is
// submitted, and the key can be pinned by hash.

import { readFileSync } from 'node:fs';
import { makeEvmPoolZk } from '../../../dapp/evm-pool-zk.js';
import { proveTransact, verifyTransact, vkHash as hashVk } from '../../../dapp/evm-pool-zk-prover.js';

export async function loadPoseidon() {
  const p = await import('poseidon-lite');
  const byArity = { 2: p.poseidon2, 3: p.poseidon3, 4: p.poseidon4, 5: p.poseidon5, 7: p.poseidon7 };
  return (xs) => {
    const f = byArity[xs.length];
    if (!f) throw new Error(`no Poseidon of arity ${xs.length}`);
    return f(xs);
  };
}

export async function loadZk() {
  return makeEvmPoolZk({ poseidon: await loadPoseidon() });
}

async function loadSnarkjs() {
  try { return await import('snarkjs'); }
  catch { return (await import('../../../dapp/vendor/tacit-mixer.min.js')).snarkjs; }
}

// snarkjs proof → the verifier's calldata shape (G2 coordinates swapped, as exportSolidityCallData does).
export function toSolidityProof(proof, publicSignals) {
  const b = (x) => BigInt(x);
  return {
    pA: [b(proof.pi_a[0]), b(proof.pi_a[1])],
    pB: [[b(proof.pi_b[0][1]), b(proof.pi_b[0][0])], [b(proof.pi_b[1][1]), b(proof.pi_b[1][0])]],
    pC: [b(proof.pi_c[0]), b(proof.pi_c[1])],
    publicInputs: publicSignals.map(b),
  };
}

// → { prove(input) → { pA, pB, pC, publicInputs }, vkHash }
export async function makeKeeperProver({ wasm, zkey, vk, vkHash = '', singleThread = false }) {
  const vkJson = JSON.parse(readFileSync(vk, 'utf8'));
  const hash = hashVk(vkJson);
  if (vkHash && hash !== vkHash.replace(/^0x/, '').toLowerCase()) throw new Error(`verification key ${hash} is not the pinned ${vkHash}`);
  const snarkjs = await loadSnarkjs();
  const wasmBytes = readFileSync(wasm);
  const zkeyBytes = readFileSync(zkey);
  return {
    vkHash: hash,
    async prove(input) {
      const { proof, publicSignals } = await proveTransact(input, { wasm: wasmBytes, zkey: zkeyBytes, snarkjs, singleThread });
      if (!(await verifyTransact(vkJson, publicSignals, proof, { snarkjs }))) throw new Error('fresh proof does not verify');
      return toSolidityProof(proof, publicSignals);
    },
  };
}
