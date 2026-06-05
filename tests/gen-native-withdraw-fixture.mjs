#!/usr/bin/env node
// Builds a COMPLETE, real deposit -> native withdraw fixture for the on-chain
// Foundry test (ShieldedPoolRealProof.t.sol). The note tree is built exactly
// the way ShieldedPool builds it on chain (empty leaf = 0, zeros[i+1] =
// Poseidon2(zeros[i], zeros[i])), so the off-chain root matches the root the
// contract derives after deposit() — ShieldedPool's withdraw checks
// everKnownRoot, unlike the bridge path. Everything is bound to a deterministic
// pool address so bind_hash matches what the deployed contract recomputes:
//   - real ceremony Groth16 proof (same withdraw circuit / ceremony zkey)
//   - "tacit-eth-withdraw-v1" bind_hash over (chainid, pool, asset, denom_wei,
//     recipient, relayer, fee) — the native domain, recomputed identically here
//   - proof serialized in call-data order (G2 pre-swapped) since the contract
//     passes a/b/c straight to the verifier with no in-contract swap
//
// Run: node tests/gen-native-withdraw-fixture.mjs
// (pool address = cast compute-address 0x..DeaDBeef --nonce 0)

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as snarkjs from '../dapp/circuits/node_modules/snarkjs/main.js';
import { buildPoseidon } from '../dapp/circuits/node_modules/circomlibjs/main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRC = path.join(__dirname, '..', 'dapp', 'circuits');
const WASM = path.join(CIRC, 'artifacts', 'withdraw.wasm');
const ZKEY = path.join(CIRC, 'ceremony-bundle', 'withdraw_final.zkey');
const VK   = path.join(CIRC, 'ceremony-bundle', 'verification_key.json');
const OUT  = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'native_withdraw_flow.json');

// ── Fixed parameters (must match the Foundry test) ──
const POOL_ADDR   = '0xE8279BE14E9fe2Ad2D8E52E42Ca96Fb33a813BBe'; // cast compute-address 0x..DeaDBeef --nonce 0
const CHAIN_ID    = 1n;                   // mainnet L1 target
const DENOM_TACIT = 100000000n;           // 1.0 ETH in tacit 8-dec units; circuit `denomination`
const UNIT_SCALE  = 10n ** 10n;           // ETH 18 -> tacit 8
const WEI_DENOM   = DENOM_TACIT * UNIT_SCALE; // 1e18 = 1 ETH
const RECIPIENT   = 'cafe000000000000000000000000000000c0ffee';
const RELAYER     = '1111111111111111111111111111111111111111';
const FEE_WEI     = 10n ** 16n;           // 0.01 ETH relayer fee
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LEVELS = 20;

const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(Buffer.from(p)); return new Uint8Array(h.digest()); };
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const bytesToHex = (b) => Buffer.from(b).toString('hex');
const beBytes = (n, len = 32) => hexToBytes(n.toString(16).padStart(len * 2, '0'));
const bToBig = (b) => BigInt('0x' + bytesToHex(b));
const hex32 = (n) => '0x' + bytesToHex(beBytes(n));

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const p3 = (a, b, c) => F.toObject(poseidon([a, b, c]));
  const p2 = (a, b) => F.toObject(poseidon([a, b]));
  const p1 = (a) => F.toObject(poseidon([a]));
  const randFr = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (i * 37 + 11) & 0xff; b[0] &= 0x3f; return bToBig(b); };

  const secret = randFr(), nullifierPreimage = (randFr() ^ 0x9n);

  // Note leaf — the value deposited as the on-chain commitment.
  const leaf = p3(secret, nullifierPreimage, DENOM_TACIT);

  // ShieldedPool's tree: empty leaf = 0; zeros[0] = 0; zeros[i+1] = P2(zeros[i], zeros[i]).
  const zeros = [0n];
  for (let i = 1; i < LEVELS; i++) zeros.push(p2(zeros[i - 1], zeros[i - 1]));

  // Insert at index 0 (single deposit): fold the leaf up with zeros on the right.
  let h = leaf;
  for (let i = 0; i < LEVELS; i++) h = p2(h, zeros[i]);
  const root = h;
  const path_elements = zeros.slice();            // path element at level i = zeros[i]
  const path_indices = new Array(LEVELS).fill(0);  // index 0 → always left child

  const nullifierHash = p1(nullifierPreimage);
  const rLeaf = p2(secret, nullifierPreimage);

  // bind_hash — exact ShieldedPool.withdraw() formula, "tacit-eth-withdraw-v1" domain.
  const assetId = sha256(new TextEncoder().encode('tacit-evm-token-v1'), beBytes(CHAIN_ID, 8), new Uint8Array(20));
  const bindRaw = sha256(
    new TextEncoder().encode('tacit-eth-withdraw-v1'),
    beBytes(CHAIN_ID), hexToBytes(POOL_ADDR),
    assetId, beBytes(WEI_DENOM), hexToBytes(RECIPIENT), hexToBytes(RELAYER), beBytes(FEE_WEI),
  );
  const bindHash = bToBig(bindRaw) % FIELD;

  const input = {
    root: root.toString(), nullifier_hash: nullifierHash.toString(), denomination: DENOM_TACIT.toString(),
    r_leaf: rLeaf.toString(), bind_hash: bindHash.toString(),
    secret: secret.toString(), nullifier_preimage: nullifierPreimage.toString(),
    path_elements: path_elements.map(String), path_indices,
  };
  console.log('==> fullProve (ceremony zkey)');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const vk = JSON.parse(await fs.readFile(VK, 'utf8'));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error('snarkjs verify failed');

  // Call-data order: a, b (G2 halves SWAPPED to precompile order), c — passed
  // straight to ShieldedPool.withdraw, which does no in-contract swap.
  const proofFlat = [
    proof.pi_a[0], proof.pi_a[1],
    proof.pi_b[0][1], proof.pi_b[0][0],
    proof.pi_b[1][1], proof.pi_b[1][0],
    proof.pi_c[0], proof.pi_c[1],
  ].map((x) => BigInt(x).toString());

  const fixture = {
    note: 'Real deposit->native withdraw fixture bound to a deterministic pool address. Regenerate with node tests/gen-native-withdraw-fixture.mjs.',
    deployer: '0x00000000000000000000000000000000DeaDBeef',
    pool: POOL_ADDR, chainId: Number(CHAIN_ID),
    assetId: '0x' + bytesToHex(assetId), denomTacit: DENOM_TACIT.toString(), weiDenom: WEI_DENOM.toString(),
    recipient: '0x' + RECIPIENT, relayer: '0x' + RELAYER, fee: FEE_WEI.toString(),
    commitment: hex32(leaf), root: hex32(root),
    nullifierHash: hex32(nullifierHash), rLeaf: hex32(rLeaf), bindHash: hex32(bindHash),
    proof: proofFlat,
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fixture, null, 2));
  console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
  console.log('   pool    :', POOL_ADDR);
  console.log('   root    :', fixture.root);
  console.log('   bindHash:', fixture.bindHash);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
