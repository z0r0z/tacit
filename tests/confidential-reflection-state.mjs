#!/usr/bin/env node
// Phase 4.1 — the Bitcoin reflection indexer's canonical state (dapp makeReflectionState)
// mirrors the Rust prover (cxfer-core WitnessedReflection) and the contract byte-for-byte.
// The genesis digest is the three-way anchor: JS indexer == Rust prover == ConfidentialPool
// .REFLECTION_GENESIS_DIGEST. If this drifts, knownReflectionDigest chaining breaks.
//
// Run: node tests/confidential-reflection-state.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

let failures = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${msg}`); };
const ne = (a, b, msg) => { if (a === b) { console.error(`FAIL ${msg} (should differ)`); failures++; } else console.log(`ok   ${msg}`); };

// The reflection prover's WitnessedReflection::genesis().digest() (box execute) ==
// ConfidentialPool.REFLECTION_GENESIS_DIGEST.
const GENESIS = '0x0ca539ff3a68ab1969e7df9234359872225fff86fc72192d9127f8d8b94a5b9f';

const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// 1. genesis: the three-way anchor + the per-set roots the prover commits.
const rs = pool.makeReflectionState();
eq(rs.digest(), GENESIS, 'genesis digest == Rust prover == contract constant');
eq(JSON.stringify(rs.counts()), JSON.stringify({ note: 0, spent: 1, utxo: 1, burn: 1, height: 0 }), 'genesis counts (sentinels)');
eq(rs.poolRoot(), '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757', 'genesis poolRoot == prover');
eq(rs.spentRoot(), '0x5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0', 'genesis spentRoot == prover');

// 2. two deposits advance the pool + utxo roots; spent/burn unchanged.
const notes = [];
for (let i = 0; i < 2; i++) {
  const cx = v(0x0a + i), cy = v(0x1a + i);
  notes.push({ cx, cy, outpoint: v(0xa0 + i), noteLeaf: v(0x1aa + i), commitmentHash: pool.commitmentHash(cx, cy) });
}
const d0 = rs.digest();
rs.applyTransfer([], notes.map((n) => ({ noteLeaf: n.noteLeaf, outpoint: n.outpoint, commitmentHash: n.commitmentHash })), 100);
ne(rs.digest(), d0, 'deposits advance the digest');
eq(rs.counts().note, 2, 'two notes appended');
eq(rs.counts().utxo, 3, 'utxo = 2 + sentinel');
eq(rs.spentRoot(), '0x5f3e94ca833807f1196d5ebe6d8f764b8dbc4edd0f473ff628fb4fd9abd17eb0', 'spent root unchanged by deposits');

// 3. spend note 0 (ν derived from its commitment), create one output.
const nu0 = pool.nullifier(notes[0].cx, notes[0].cy);
const out = { cx: v(0x0c), cy: v(0x1c), outpoint: v(0xc0), noteLeaf: v(0x1cc) };
out.commitmentHash = pool.commitmentHash(out.cx, out.cy);
const spentBefore = rs.spentRoot();
rs.applyTransfer([{ nu: nu0, outpoint: notes[0].outpoint }], [{ noteLeaf: out.noteLeaf, outpoint: out.outpoint, commitmentHash: out.commitmentHash }], 101);
ne(rs.spentRoot(), spentBefore, 'spend advances the spent root');
eq(rs.counts().spent, 2, 'one spend + sentinel');
eq(rs._acc.utxo.membershipWitness ? 'has' : 'no', 'has', 'utxo witness builder present');

// 4. bridge-out note 1 → destCommitment: burn root advances, ν enters spent + burn.
const nu1 = pool.nullifier(notes[1].cx, notes[1].cy);
const dest = v(0xde);
const burnBefore = rs.burnRoot();
rs.applyBridgeOut({ nu: nu1, outpoint: notes[1].outpoint, destCommitment: dest }, 102);
ne(rs.burnRoot(), burnBefore, 'bridge-out advances the burn root');
eq(rs.counts().burn, 2, 'one burn + sentinel');

// 5. determinism: a fresh state folding the same effects reaches the same digest.
const rs2 = pool.makeReflectionState();
rs2.applyTransfer([], notes.map((n) => ({ noteLeaf: n.noteLeaf, outpoint: n.outpoint, commitmentHash: n.commitmentHash })), 100);
rs2.applyTransfer([{ nu: nu0, outpoint: notes[0].outpoint }], [{ noteLeaf: out.noteLeaf, outpoint: out.outpoint, commitmentHash: out.commitmentHash }], 101);
rs2.applyBridgeOut({ nu: nu1, outpoint: notes[1].outpoint, destCommitment: dest }, 102);
eq(rs2.digest(), rs.digest(), 'same effects → same digest (deterministic resume anchor)');

// 6. a height decrease (rollback) is rejected.
let threw = false;
try { rs.applyTransfer([], [], 101); } catch { threw = true; }
eq(threw ? 'threw' : 'ok', 'threw', 'height decrease rejected');

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
