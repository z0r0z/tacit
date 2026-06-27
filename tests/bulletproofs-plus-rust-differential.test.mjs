// BPP-A: JS half of the JS<->Rust BP+ range-proof differential.
//
// Drives the committed differential corpus (fixtures/bpp_differential.json) through the JS attester
// verifier dapp/bulletproofs-plus.js and asserts each verdict matches the pinned `accept`. The Rust
// half (cxfer-core/src/lib.rs range_matches_js_across_random_corpus) drives the SAME bytes through
// the on-chain verify_range and asserts the SAME verdicts. Together: both verifiers must agree, case
// for case, across every m and the honest / out-of-range / tampered / wrong-commitment families.
//
// This file also re-runs the deterministic generator in-memory and asserts it reproduces the
// committed corpus byte-for-byte, so a port/@noble drift that changes proof bytes (or flips a
// verdict) fails loudly here and tells you to regenerate the fixture (see the generator header).
//
// Run: node --test tests/bulletproofs-plus-rust-differential.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as bpp from '../dapp/bulletproofs-plus.js';
import { buildCorpus } from './gen-bpp-differential-fixture.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dir, '../contracts/sp1/confidential/fixtures/bpp_differential.json');

const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const ptOf = (h) => bpp.bytesToPoint(hexToBytes(h));

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('BP+ differential: JS verify_range agrees with every pinned verdict (the bytes Rust also checks)', () => {
  assert.ok(fixture.cases.length >= 4 * 7, `expected a full m in {1,2,4,8} x family corpus, got ${fixture.cases.length}`);
  // every m is represented, and both accept and reject verdicts are present (a one-sided corpus is useless)
  const ms = new Set(fixture.cases.map((c) => c.m));
  for (const m of [1, 2, 4, 8]) assert.ok(ms.has(m), `corpus missing m=${m}`);
  assert.ok(fixture.cases.some((c) => c.accept === true), 'corpus has no accept case');
  assert.ok(fixture.cases.some((c) => c.accept === false), 'corpus has no reject case');

  for (const c of fixture.cases) {
    const commitments = c.commitments.map(ptOf);
    const proof = hexToBytes(c.proof);
    const got = bpp.bppRangeVerify(commitments, proof);
    assert.equal(got, c.accept, `JS verdict diverged from pinned for ${c.label}: got ${got}, pinned ${c.accept}`);
  }
});

test('BP+ differential: committed fixture is reproducible from the deterministic generator (drift alarm)', () => {
  const fresh = buildCorpus();
  assert.equal(fresh.length, fixture.cases.length, 'regenerated case count differs from committed');
  for (let i = 0; i < fresh.length; i++) {
    const a = fresh[i];
    const b = fixture.cases[i];
    assert.equal(a.label, b.label, `case ${i} label drift`);
    assert.equal(a.m, b.m, `${a.label} m drift`);
    assert.equal(a.accept, b.accept, `${a.label} verdict drift`);
    assert.deepEqual(a.commitments, b.commitments, `${a.label} commitment bytes drift -> regenerate fixture`);
    assert.equal(a.proof, b.proof, `${a.label} proof bytes drift -> regenerate fixture`);
  }
});
