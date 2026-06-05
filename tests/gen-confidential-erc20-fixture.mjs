#!/usr/bin/env node
// Real-crypto lifecycle fixture for the EVM confidential token, generated
// THROUGH the shared prover module (dapp/evm-confidential.js). Because the
// Solidity tests verify these proofs on the real contracts, a passing suite
// proves the prover module produces proofs the contracts accept — the generator
// is a thin wrapper over the same code the dapp will call.
//
// One coherent flow: wrap 100 + wrap 10 -> a confidential 2-in/2-out transfer
// (output denominations hidden) -> unwrap one output (100); plus an etched-burn
// PoK and an attest PoK on the same notes.
//
// Bound to a deterministic contract address. Run: node tests/gen-confidential-erc20-fixture.mjs

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'confidential_erc20.json');

const CONTRACT = '0xE8279BE14E9fe2Ad2D8E52E42Ca96Fb33a813BBe'; // cast compute-address 0x..DeaDBeef --nonce 0
const CHAIN_ID = 1;
const RECIP = '0x00000000000000000000000000000000cafe0001';
const ZERO = '0x0000000000000000000000000000000000000000';
const ATTESTER = '0x00000000000000000000000000000000A77E5701';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const N = secp.CURVE.n;
const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const { commit, proveOpen, proveTransfer, denomPoints } = prover;

// Deterministic nonces so the fixture is reproducible.
let seedCtr = 1;
const rand = () => { const b = sha256(new Uint8Array([seedCtr++, (seedCtr * 7) & 0xff, 0x42])); return (BigInt('0x' + Buffer.from(b).toString('hex')) % N) || 1n; };
const xy = (pt) => { const a = pt.toAffine(); return { x: '0x' + a.x.toString(16).padStart(64, '0'), y: '0x' + a.y.toString(16).padStart(64, '0') }; };
const openVec = (denomIdx, r, to, extra = {}) => { const o = proveOpen({ chainId: CHAIN_ID, contract: CONTRACT, denomIdx, r, to, rand }); return { denomIdx, x: o.cx, y: o.cy, rAddr: o.rAddr, z: o.z, ...extra }; };

async function main() {
  const ladder = prover.LADDER.map(String);
  const D = denomPoints();

  // ── wrap: denom 100 (idx 2), denom 10 (idx 1) ──
  const r_in0 = rand(), r_in1 = rand();
  const Cin0 = commit(100n, r_in0), Cin1 = commit(10n, r_in1);
  const wrap0 = openVec(2, r_in0, ZERO);
  const wrap1 = openVec(1, r_in1, ZERO);

  // ── transfer: 2-in (100,10) -> 2-out (100,10), fresh blindings ──
  const r_out0 = rand(), r_out1 = rand();
  const Cout0 = commit(100n, r_out0), Cout1 = commit(10n, r_out1);
  const transfer = proveTransfer({
    chainId: CHAIN_ID, contract: CONTRACT,
    inputs: [{ d: 100, r: r_in0 }, { d: 10, r: r_in1 }],
    outputs: [{ d: 100, r: r_out0 }, { d: 10, r: r_out1 }],
    rand,
  });

  // ── unwrap / etched-burn / attest on the existing notes ──
  const unwrap = openVec(2, r_out0, RECIP, { to: RECIP });   // output 0 to a recipient
  const etchedBurn = openVec(2, r_out0, ZERO);               // output 0, no recipient
  const attest = openVec(2, r_in0, ATTESTER, { attester: ATTESTER }); // input 0, caller-bound

  const fixture = {
    note: 'EVM confidential-token lifecycle generated via dapp/evm-confidential.js. Regenerate: node tests/gen-confidential-erc20-fixture.mjs.',
    deployer: '0x00000000000000000000000000000000DeaDBeef', contract: CONTRACT, chainId: CHAIN_ID,
    ladder, Dx: D.map((d) => d.x), Dy: D.map((d) => d.y),
    wrap: [wrap0, wrap1],
    transfer,
    unwrap, etchedBurn, attest,
  };
  // sanity: the transfer's input commitments must equal the wrapped notes.
  if (transfer.cinx[0] !== xy(Cin0).x || transfer.cinx[1] !== xy(Cin1).x) throw new Error('input commitment mismatch');

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fixture, null, 2));
  console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
  console.log('   wrap0 C.x:', wrap0.x);
  console.log('   kernel R :', transfer.kernelRAddr);
}
main().catch((e) => { console.error(e); process.exit(1); });
