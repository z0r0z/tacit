#!/usr/bin/env node
// Phase 4.3 — assemble a reflection-prover input from the indexer (makeReflectionState +
// assembleReflectionInput) and emit the fixture the exec harness feeds to the reflection guest.
// This fixture resumes from GENESIS and folds zero effects against a REAL Bitcoin header (from
// btc_block.json) — so it validates (a) the assembler serializes the prior state + headers in
// the guest's read order, and (b) the guest verifies a real header chain (PoW) end-to-end.
// A full effect-fold fixture additionally needs a real CXFER/burn tx (confidential signet
// activity) whose vin chains to a prior pool output — out of scope for this header-binding check.
//
// Run: node tests/gen-reflection-input.mjs > contracts/sp1/confidential/fixtures/reflection_input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync as rf } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const block = JSON.parse(rf(new URL('../contracts/sp1/confidential/fixtures/btc_block.json', import.meta.url)));
const header = block.header.replace(/^0x/, ''); // a REAL mined header (PoW the guest verifies)

const state = pool.makeReflectionState();
const input = pool.assembleReflectionInput(state, {
  anchorHeight: 800000,    // the relay-anchored height of headers[0] (contract-checked on-chain)
  headers: [header],
  effects: [],             // header-binding fixture; effect-fold needs a real CXFER tx (see header)
});

// sanity: with no effects the digest is unchanged (== genesis).
if (input.prior.poolRoot !== state.poolRoot()) throw new Error('prior poolRoot drift');
if (input.newDigest !== '0x0ca539ff3a68ab1969e7df9234359872225fff86fc72192d9127f8d8b94a5b9f') {
  throw new Error('genesis newDigest drift: ' + input.newDigest);
}

process.stdout.write(JSON.stringify({
  note: 'reflection-prover input: resume from genesis, 0 effects, REAL header (PoW). Phase 4.3 assembler + header-binding fixture.',
  ...input,
}, null, 2) + '\n');
