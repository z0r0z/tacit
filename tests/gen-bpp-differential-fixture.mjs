#!/usr/bin/env node
// BPP-A: emit a RANDOMIZED-but-DETERMINISTIC JS<->Rust differential corpus for the BP+ range proof.
//
// The on-chain authority is the Rust verify_range (cxfer-core/src/lib.rs); dapp/bulletproofs-plus.js
// is the attester mirror. Before this, the only Rust-side cross-checks of JS-produced proofs were a
// handful of pinned m=1/m=2 fixtures (range_accepts_js_proof_and_rejects_tamper, BPP-1). A port or
// @noble dependency drift that only manifested at m=4/m=8, or on a challenge-dependent path, could
// pass the green suite while diverging the two verifiers: attester-blesses-but-guest-rejects bricks
// settle; the reverse is a soundness gap. This corpus drives BOTH verifiers, across every m and a
// mix of honest / out-of-range / tampered / wrong-commitment cases, and pins each one's verdict.
//
// DETERMINISM: BP+ proving draws internal blindings from globalThis.crypto.getRandomValues
// (bulletproofs-plus.js randomScalar -> 524/605-606/660-663). We replace it with a seeded SHA256
// keystream so the whole proof is reproducible and the fixture is byte-stable -> committable and
// git-diffable. Re-running this generator and diffing the output is the drift alarm BPP-A asked for.
//
// Regenerate:  node tests/gen-bpp-differential-fixture.mjs > contracts/sp1/confidential/fixtures/bpp_differential.json
// Consumed by: tests/bulletproofs-plus-rust-differential.test.mjs (JS half)
//              cxfer-core/src/lib.rs range_matches_js_across_random_corpus (Rust half)

import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as bpp from '../dapp/bulletproofs-plus.js';

const SEED = 'tacit-bpp-differential-v1';
const MAX = (1n << 64n) - 1n; // 2^64 - 1, the max in-range value

// ---- deterministic CSPRNG seam (makes every randomScalar() reproducible) ----
function installDeterministicRng(seedStr) {
  let state = nobleSha256(new TextEncoder().encode(seedStr));
  let pos = 0;
  globalThis.crypto.getRandomValues = (buf) => {
    for (let i = 0; i < buf.length; i++) {
      if (pos >= state.length) { state = nobleSha256(state); pos = 0; }
      buf[i] = state[pos++];
    }
    return buf;
  };
}

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
// explicit, deterministic commitment blindings (gamma) so the V commitments are fixed too
const gamma = (tag) => {
  const s = bpp.modN(bpp.bytes32ToBigint(nobleSha256(new TextEncoder().encode(SEED + ':gamma:' + tag))));
  return s === 0n ? 1n : s;
};
const blindings = (m, tag) => Array.from({ length: m }, (_, i) => gamma(`${tag}:${i}`));

// in-range "mixed" values for an m-aggregate: exercises 0, 1, max, and a mid value
function mixedValues(m) {
  const pool = [0n, 1n, MAX, 0x0123456789abcdefn, 0xfedcba9876543210n & MAX, 42n, 1n << 63n, MAX - 1n];
  return Array.from({ length: m }, (_, i) => pool[i % pool.length]);
}
// an m-aggregate that is in-range except slot 0, which holds the (out-of-range) value v
function withOutOfRange(m, v) {
  const a = Array.from({ length: m }, () => 1n);
  a[0] = v;
  return a;
}

function buildCorpus() {
  installDeterministicRng(SEED);
  const cases = [];
  const honestByLabel = {};

  for (const m of [1, 2, 4, 8]) {
    // ---- honest, in-range: MUST verify ----
    const honest = [
      [`m${m}_honest_zero`, Array(m).fill(0n)],
      [`m${m}_honest_max`, Array(m).fill(MAX)],
      [`m${m}_honest_mixed`, mixedValues(m)],
    ];
    for (const [label, values] of honest) {
      const { commitments, proof } = bpp.bppRangeProve(values, blindings(m, label));
      const accept = bpp.bppRangeVerify(commitments, proof);
      if (accept !== true) throw new Error(`${label}: honest in-range proof did not verify`);
      const rec = { m, label, commitments: commitments.map((c) => hx(c.toRawBytes(true))), proof: hx(proof), accept: true };
      cases.push(rec);
      honestByLabel[label] = { commitments, proof };
    }

    // ---- out-of-range (malicious prover via the test hatch): MUST reject ----
    const oor = [
      [`m${m}_oor_2pow64`, withOutOfRange(m, 1n << 64n)],        // V opens to 2^64 exactly
      [`m${m}_oor_smuggle`, withOutOfRange(m, (1n << 64n) + 5n)], // high-bit smuggle: 2^64+5 == 5 mod 2^64
    ];
    for (const [label, values] of oor) {
      const { commitments, proof } = bpp.bppRangeProve(values, blindings(m, label), true /* _allowOutOfRangeForTest */);
      const accept = bpp.bppRangeVerify(commitments, proof);
      if (accept !== false) throw new Error(`${label}: out-of-range proof was accepted (no-inflation root broken)`);
      cases.push({ m, label, commitments: commitments.map((c) => hx(c.toRawBytes(true))), proof: hx(proof), accept: false });
    }

    // ---- tampered honest proof (one flipped byte): MUST reject ----
    {
      const base = honestByLabel[`m${m}_honest_mixed`];
      const bad = Uint8Array.from(base.proof);
      bad[bad.length - 1] ^= 0x01; // flip the low byte of the final scalar
      const accept = bpp.bppRangeVerify(base.commitments, bad);
      if (accept !== false) throw new Error(`m${m}_tamper: tampered proof was accepted`);
      cases.push({ m, label: `m${m}_tamper`, commitments: base.commitments.map((c) => hx(c.toRawBytes(true))), proof: hx(bad), accept: false });
    }

    // ---- wrong commitment (honest proof, commitment[0] shifted by +3*G): MUST reject ----
    {
      const base = honestByLabel[`m${m}_honest_mixed`];
      const shifted = base.commitments.slice();
      shifted[0] = shifted[0].add(bpp.G.multiply(3n));
      const accept = bpp.bppRangeVerify(shifted, base.proof);
      if (accept !== false) throw new Error(`m${m}_wrongc: wrong-commitment proof was accepted`);
      cases.push({ m, label: `m${m}_wrongc`, commitments: shifted.map((c) => hx(c.toRawBytes(true))), proof: hx(base.proof), accept: false });
    }
  }
  return cases;
}

export { buildCorpus, SEED };

// run as a script -> emit the committed fixture JSON
if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = buildCorpus();
  const out = {
    note:
      'BPP-A: deterministic JS<->Rust BP+ differential corpus. Each case is driven through dapp/bulletproofs-plus.js (JS attester, tests/bulletproofs-plus-rust-differential.test.mjs) AND cxfer-core verify_range (Rust on-chain authority, range_matches_js_across_random_corpus); both MUST agree with `accept`. Regenerate with: node tests/gen-bpp-differential-fixture.mjs > contracts/sp1/confidential/fixtures/bpp_differential.json',
    seed: SEED,
    count: cases.length,
    cases,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
