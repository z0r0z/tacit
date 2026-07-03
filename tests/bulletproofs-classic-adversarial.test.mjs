// Adversarial + boundary coverage for the CLASSIC-Bulletproofs (0x23) range verifier — the
// path that lets legacy classic-BP assets (mainnet TAC) bridge. Brings the classic verifier
// to the BP+ soundness-evidence bar: every parsed field binds, all aggregation widths
// (m=1,2,4,8) and boundary values (0 / 1 / 2^64-1 / seeded mid) accept, and every tamper /
// wrong-commitment / length / out-of-range case rejects — checked through BOTH the reference
// verifier (tests/bulletproofs.mjs) and the dapp mirror (dapp/bulletproofs.js).
//
// Fixtures come from tests/gen-classic-bp-vectors.mjs (deterministic; re-run to regenerate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bpRangeAggVerify, bpRangeAggProve } from './bulletproofs.mjs';
import { bpRangeVerify, bpClassicProofLen } from '../dapp/bulletproofs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, '../contracts/sp1/confidential/fixtures/classic_bp');
const h2b = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const load = (name) => JSON.parse(readFileSync(join(fxDir, name), 'utf8'));

// Verify through BOTH paths and assert they agree.
function bothVerify(commitmentsHex, proofHex) {
  const commits = commitmentsHex.map(h2b);
  const proof = h2b(proofHex);
  const ref = bpRangeAggVerify(commits.map((c) => require_pt(c)), proof);
  const mirror = bpRangeVerify(commitmentsHex, proof);
  return { ref, mirror };
}
// reference verifier wants ProjectivePoints; import lazily to avoid dup of secp context
import { bytesToPoint } from './bulletproofs.mjs';
function require_pt(b) { return bytesToPoint(b); }

const files = readdirSync(fxDir);
const validFiles = files.filter((f) => f.startsWith('valid_')).sort();
const tamperFiles = files.filter((f) => f.startsWith('tamper_')).sort();

test('completeness: every valid_* accepts (both verifiers agree), all m + boundaries', () => {
  assert.ok(validFiles.length >= 12, `expected >=12 valid fixtures, got ${validFiles.length}`);
  for (const f of validFiles) {
    const fx = load(f);
    const { ref, mirror } = bothVerify(fx.commitments, fx.proof);
    assert.equal(ref, true, `${f}: reference verifier must ACCEPT`);
    assert.equal(mirror, true, `${f}: dapp mirror verifier must ACCEPT`);
    assert.equal(ref, mirror, `${f}: reference↔mirror must agree`);
  }
});

test('soundness: every tamper_* rejects (both verifiers)', () => {
  assert.ok(tamperFiles.length >= 11, `expected >=11 tamper fixtures, got ${tamperFiles.length}`);
  for (const f of tamperFiles) {
    const fx = load(f);
    const { ref, mirror } = bothVerify(fx.commitments, fx.proof);
    assert.equal(ref, false, `${f}: reference verifier must REJECT tampered ${fx.field}`);
    assert.equal(mirror, false, `${f}: dapp mirror verifier must REJECT tampered ${fx.field}`);
  }
});

test('soundness: wrong_commitment rejects (proof valid, commitment = commit(value+1))', () => {
  const fx = load('wrong_commitment.json');
  const { ref, mirror } = bothVerify(fx.commitments, fx.proof);
  assert.equal(ref, false, 'reference must REJECT wrong commitment');
  assert.equal(mirror, false, 'mirror must REJECT wrong commitment');
});

test('length: truncated and padded proofs reject (length dispatch)', () => {
  for (const name of ['truncated.json', 'padded.json']) {
    const fx = load(name);
    const { ref, mirror } = bothVerify(fx.commitments, fx.proof);
    assert.equal(ref, false, `${name}: reference must REJECT`);
    assert.equal(mirror, false, `${name}: mirror must REJECT`);
  }
});

test('out-of-range: prover guard THROWS for value = 2^64 at n_bits=64', () => {
  const g = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
  assert.throws(() => bpRangeAggProve([1n << 64n], [g], 64), /out of range/,
    'bpRangeAggProve must reject value >= 2^64 at 64-bit width');
});

test('out-of-range: honest wider-width proof of v>=2^64 rejects at the 64-bit verifier', () => {
  const fx = load('out_of_range.json');
  // The fixture is an HONEST 128-bit proof of v=2^64. Handed to the 64-bit verifier, its
  // length (nm=128) does not match the 64-bit expected length (nm=64) ⇒ length dispatch
  // rejects before any equation runs. This is the documented rejection mechanism.
  const proof = h2b(fx.proof);
  const commits = fx.commitments.map(h2b);
  const ref = bpRangeAggVerify(commits.map(require_pt), proof, 64);
  const mirror = bpRangeVerify(fx.commitments, proof, 64);
  assert.equal(ref, false, 'reference (64-bit) must REJECT the wider-width out-of-range proof');
  assert.equal(mirror, false, 'mirror (64-bit) must REJECT the wider-width out-of-range proof');
  // Confirm the documented mechanism: the wider proof is longer than a 64-bit m=1 proof.
  assert.ok(proof.length !== bpClassicProofLen(1, 64),
    'out-of-range proof length must differ from the 64-bit m=1 length (length-dispatch reject)');
});

test('length-dispatch: a valid classic proof is not a BP+-length proof for any m', () => {
  // A classic proof handed where a BP+ length is expected (and vice-versa) must not collide;
  // the verifier dispatches purely by length, so distinct lengths ⇒ no cross-scheme confusion.
  for (const m of [1, 2, 4, 8]) {
    const logmn = Math.log2(64 * m);
    const bppLen = 99 + 96 + logmn * 66;
    assert.notEqual(bpClassicProofLen(m), bppLen, `m=${m}: classic and BP+ lengths must differ`);
  }
  // And concretely: our valid m=2 classic proof (754B) is not the BP+ m=2 length.
  const fx = load('valid_m2_case2.json');
  const proof = h2b(fx.proof);
  const bppLen2 = 99 + 96 + Math.log2(128) * 66;
  assert.notEqual(proof.length, bppLen2, 'valid classic m=2 proof must not be BP+ m=2 length');
  assert.equal(proof.length, bpClassicProofLen(2), 'and must equal the classic m=2 length');
});
