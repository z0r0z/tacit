#!/usr/bin/env node
// Deterministic CLASSIC-Bulletproofs (0x23) range-proof adversarial + boundary vectors.
// Emits valid aggregated proofs (m ∈ {1,2,4,8}, boundary values 0/1/2^64-1/mid) plus a
// full MUTATED set derived from one valid m=2 proof — one fixture per structurally-parsed
// field tweaked minimally — so the on-chain classic verifier (guest verify_range_classic +
// dapp bpRangeVerify) gets the same soundness-evidence bar as the BP+ path.
//
// Everything is seeded off a fixed keccak/sha stream: the prover's blindings (alpha, rho,
// s_L, s_R, tau_1, tau_2 and the value blindings) all come from a deterministic PRNG that
// replaces crypto.getRandomValues, so re-running reproduces byte-identical fixtures.
//
//   node tests/gen-classic-bp-vectors.mjs
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---- deterministic PRNG: seed a keccak/sha counter stream and splice it into the global
// crypto.getRandomValues that bulletproofs.mjs's randomScalar() reads. MUST be installed
// before importing the prover module is fine (it reads the global at call time), but we
// also re-seed per proof so each fixture is a pure function of its (seed, label). ----
const SEED = sha256(new TextEncoder().encode('tacit-classic-bp-vectors-v1'));
let _ctr = 0;
function seedStream(label) {
  _ctr = 0;
  const base = sha256(concatBytes(SEED, new TextEncoder().encode('|' + label)));
  globalThis.crypto.getRandomValues = (arr) => {
    // fill arr from sha256(base || counter) blocks
    let need = arr.length, pos = 0;
    while (need > 0) {
      const block = sha256(concatBytes(base, new Uint8Array([
        _ctr & 0xff, (_ctr >> 8) & 0xff, (_ctr >> 16) & 0xff, (_ctr >> 24) & 0xff,
      ])));
      _ctr++;
      const take = Math.min(need, block.length);
      arr.set(block.subarray(0, take), pos);
      pos += take; need -= take;
    }
    return arr;
  };
}

const bp = await import('./bulletproofs.mjs');
const { bpRangeAggProve, bpRangeAggVerify, pedersenCommit, pointToBytes, SECP_N, modN } = bp;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../contracts/sp1/confidential/fixtures/classic_bp');
mkdirSync(outDir, { recursive: true });

const hx = (b) => '0x' + bytesToHex(b);
const N_BITS = 64;
const MAX = (1n << 64n) - 1n; // 2^64 - 1, the largest in-range value

// A deterministic mid value + blinding per (m, index), seeded, always < 2^64.
function midValue(m, j) {
  const h = sha256(concatBytes(SEED, new TextEncoder().encode(`mid|${m}|${j}`)));
  return BigInt('0x' + bytesToHex(h.subarray(0, 8))); // 64-bit, < 2^64
}
function blinding(m, j) {
  const h = sha256(concatBytes(SEED, new TextEncoder().encode(`blind|${m}|${j}`)));
  return BigInt('0x' + bytesToHex(h)) % SECP_N || 1n;
}

// Boundary value menu per aggregation width. Pad/truncate to exactly m values, cycling.
const BOUNDARY_MENU = [0n, 1n, MAX];

function caseValues(m, k) {
  // case 0: all-zero; case 1: all-max; case 2: mixed boundaries + seeded mids
  const vals = [];
  for (let j = 0; j < m; j++) {
    if (k === 0) vals.push(0n);
    else if (k === 1) vals.push(MAX);
    else {
      // interleave 0,1,MAX,mid across the slots for a mixed boundary case
      const pick = (j % 4);
      if (pick === 0) vals.push(0n);
      else if (pick === 1) vals.push(1n);
      else if (pick === 2) vals.push(MAX);
      else vals.push(midValue(m, j));
    }
  }
  return vals;
}

function emit(name, obj) {
  writeFileSync(join(outDir, name), JSON.stringify(obj, null, 2) + '\n');
}

const summary = [];

// ---- 1) valid vectors: m ∈ {1,2,4,8}, cases k ∈ {0,1,2} ----
let m2ValidProof = null, m2ValidCommits = null, m2ValidValues = null, m2ValidBlindings = null;
for (const m of [1, 2, 4, 8]) {
  for (let k = 0; k < 3; k++) {
    const values = caseValues(m, k);
    const blindings = values.map((_, j) => blinding(m, j));
    seedStream(`valid|m${m}|case${k}`);
    const { proof, commitments } = bpRangeAggProve(values, blindings, N_BITS);
    // self-check: reference verifier must accept
    if (!bpRangeAggVerify(commitments, proof, N_BITS)) {
      throw new Error(`generator self-check FAILED: valid m=${m} case=${k} did not verify`);
    }
    const name = `valid_m${m}_case${k}.json`;
    emit(name, {
      note: `valid classic-BP aggregated range proof, m=${m}, case=${k}`,
      m, n_bits: N_BITS,
      values: values.map((v) => v.toString()),
      commitments: commitments.map((c) => hx(pointToBytes(c))),
      proof: hx(proof),
    });
    summary.push(`${name}  ACCEPT  m=${m} vals=[${values.join(',')}]`);
    if (m === 2 && k === 2) {
      m2ValidProof = proof; m2ValidCommits = commitments;
      m2ValidValues = values; m2ValidBlindings = blindings;
    }
  }
}

// ---- 2) mutated set derived from one valid m=2 proof ----
// m=2 ⇒ nm=128, log_nm=7. Layout (byte offsets):
//   A[0..33) S[33..66) T1[66..99) T2[99..132)
//   t_hat[132..164) tau_x[164..196) mu[196..228)
//   L/R × 7 pairs: [228..690)   (each 66B: L=33, R=33)
//   a_final[690..722) b_final[722..754)
const proof = m2ValidProof;
const P = proof.length; // 754
if (P !== 754) throw new Error(`unexpected m=2 proof length ${P}`);

// helpers on a working copy
function tweakScalarPlus1(buf, off) {
  const s = BigInt('0x' + bytesToHex(buf.slice(off, off + 32)));
  const s2 = modN(s + 1n);
  const b = hexToBytes(s2.toString(16).padStart(64, '0'));
  buf.set(b, off);
}
function tweakPoint(buf, off) {
  // decompress → add G → recompress, so bytes remain a VALID curve point.
  // This makes the fixture test the verification EQUATION, not the point parser.
  const pt = bp.bytesToPoint(buf.slice(off, off + 33));
  const tw = pt.add(bp.G);
  buf.set(pointToBytes(tw), off);
}
function mutate(label, fn) {
  const buf = proof.slice(); // copy
  fn(buf);
  const commits = m2ValidCommits.map((c) => hx(pointToBytes(c)));
  const name = `tamper_${label}.json`;
  // self-check: reference verifier MUST reject
  const accepted = bpRangeAggVerify(m2ValidCommits, buf, N_BITS);
  if (accepted) {
    // A soundness bug — surface it loudly rather than emitting a "reject" fixture.
    console.error(`\n!!! SOUNDNESS BUG: mutation ${label} was ACCEPTED by the reference verifier !!!\n`);
  }
  emit(name, {
    note: `classic-BP proof with field '${label}' minimally mutated — verifier MUST reject`,
    m: 2, n_bits: N_BITS,
    field: label,
    commitments: commits,
    proof: hx(buf),
    reference_rejects: !accepted,
  });
  summary.push(`${name}  ${accepted ? 'ACCEPT(BUG!)' : 'REJECT'}  field=${label}`);
  return accepted;
}

let anyBug = false;
// point fields: A,S,T1,T2, one L, one R
anyBug |= mutate('A',  (b) => tweakPoint(b, 0));
anyBug |= mutate('S',  (b) => tweakPoint(b, 33));
anyBug |= mutate('T1', (b) => tweakPoint(b, 66));
anyBug |= mutate('T2', (b) => tweakPoint(b, 99));
anyBug |= mutate('L0', (b) => tweakPoint(b, 228));           // first L
anyBug |= mutate('R0', (b) => tweakPoint(b, 228 + 33));      // first R
// scalar fields: t_hat, tau_x, mu, a_final, b_final  (+1 mod N)
anyBug |= mutate('t_hat',   (b) => tweakScalarPlus1(b, 132));
anyBug |= mutate('tau_x',   (b) => tweakScalarPlus1(b, 164));
anyBug |= mutate('mu',      (b) => tweakScalarPlus1(b, 196));
anyBug |= mutate('a_final', (b) => tweakScalarPlus1(b, 690));
anyBug |= mutate('b_final', (b) => tweakScalarPlus1(b, 722));

// ---- 3) wrong_commitment: valid proof, but one commitment replaced by commit(value+1) ----
{
  const wrongCommits = m2ValidCommits.slice();
  const v0 = m2ValidValues[0];
  wrongCommits[0] = pedersenCommit(v0 + 1n, m2ValidBlindings[0]); // same blinding, value+1
  const accepted = bpRangeAggVerify(wrongCommits, proof, N_BITS);
  if (accepted) { anyBug = 1; console.error('\n!!! SOUNDNESS BUG: wrong_commitment ACCEPTED !!!\n'); }
  emit('wrong_commitment.json', {
    note: 'valid m=2 proof but commitment[0] replaced with commit(value+1) — MUST reject',
    m: 2, n_bits: N_BITS,
    commitments: wrongCommits.map((c) => hx(pointToBytes(c))),
    proof: hx(proof),
    reference_rejects: !accepted,
  });
  summary.push(`wrong_commitment.json  ${accepted ? 'ACCEPT(BUG!)' : 'REJECT'}`);
}

// ---- 4) truncated / padded (length off by a few bytes) ----
{
  const trunc = proof.slice(0, P - 5);
  const acc = bpRangeAggVerify(m2ValidCommits, trunc, N_BITS);
  if (acc) { anyBug = 1; console.error('\n!!! SOUNDNESS BUG: truncated ACCEPTED !!!\n'); }
  emit('truncated.json', {
    note: 'valid m=2 proof truncated by 5 bytes — MUST reject (length dispatch)',
    m: 2, n_bits: N_BITS,
    commitments: m2ValidCommits.map((c) => hx(pointToBytes(c))),
    proof: hx(trunc),
    reference_rejects: !acc,
  });
  summary.push(`truncated.json  ${acc ? 'ACCEPT(BUG!)' : 'REJECT'}`);
}
{
  const padded = concatBytes(proof, new Uint8Array([0, 1, 2, 3, 4]));
  const acc = bpRangeAggVerify(m2ValidCommits, padded, N_BITS);
  if (acc) { anyBug = 1; console.error('\n!!! SOUNDNESS BUG: padded ACCEPTED !!!\n'); }
  emit('padded.json', {
    note: 'valid m=2 proof padded by 5 bytes — MUST reject (length dispatch)',
    m: 2, n_bits: N_BITS,
    commitments: m2ValidCommits.map((c) => hx(pointToBytes(c))),
    proof: hx(padded),
    reference_rejects: !acc,
  });
  summary.push(`padded.json  ${acc ? 'ACCEPT(BUG!)' : 'REJECT'}`);
}

// ---- 5) out-of-range: honestly prove v = 2^64-1 at a WIDER width (n_bits=128) for a value
// >= 2^64, then hand that proof to the 64-bit verifier. The prover's own guard blocks a
// value >= 2^64 at n_bits=64, so we widen n_bits to 128 to build an honest proof of a
// value that a 64-bit range CANNOT cover, and confirm the 64-bit verifier rejects it. ----
{
  const oorValue = 1n << 64n; // exactly 2^64, out of the 64-bit range
  const oorBlind = blinding(1, 99);
  seedStream('oor|n128');
  const wide = bpRangeAggProve([oorValue], [oorBlind], 128); // honest 128-bit proof
  // sanity: it verifies at its own width
  if (!bpRangeAggVerify(wide.commitments, wide.proof, 128)) {
    throw new Error('generator self-check FAILED: 128-bit oor proof did not verify at width 128');
  }
  // hand to 64-bit verifier → the commitment is a valid point, but at n_bits=64 the proof
  // length (log_nm for nm=64) differs from the 128-bit proof length, so length-dispatch
  // rejects; even if lengths matched the transcript/equation would fail.
  const acc64 = bpRangeAggVerify(wide.commitments, wide.proof, 64);
  if (acc64) { anyBug = 1; console.error('\n!!! SOUNDNESS BUG: out-of-range (wide proof) ACCEPTED at width 64 !!!\n'); }
  emit('out_of_range.json', {
    note: 'honest 128-bit proof of v=2^64 handed to the 64-bit verifier — MUST reject. '
        + 'Mechanism: proof-length for nm=128 (n=128,m=1) differs from the 64-bit verifier\'s '
        + 'expected length (nm=64), so length-dispatch rejects before the equation runs.',
    value: oorValue.toString(),
    m: 1, prove_n_bits: 128, verify_n_bits: 64,
    commitments: wide.commitments.map((c) => hx(pointToBytes(c))),
    proof: hx(wide.proof),
    reference_rejects_at_64: !acc64,
  });
  summary.push(`out_of_range.json  ${acc64 ? 'ACCEPT(BUG!)' : 'REJECT'} at width 64`);
}

// ---- 6) cross-width length-alias negative ----
// out_of_range.json is an HONEST proof built at n_bits=128 for m=1 → 754 bytes. 754 also
// equals the 64-bit classic length for m=2 (bpClassicProofLen(2)). Hand that 754-byte proof
// to the 64-bit verifier together with TWO on-curve commitments: the verifier computes m=2,
// its classic length 754 matches, so it actually runs verify_range_classic with an n=64,m=2
// transcript. It MUST reject — the transcript's n/m binding diverges from the proof's real
// 128-bit/m=1 parameters. Locks that a wider proof whose length aliases another m's classic
// length is caught by the transcript binding, not just the length gate.
{
  // reuse the exact out_of_range proof bytes (the honest 128-bit m=1, 754-byte proof);
  // load from the just-emitted fixture to guarantee identity with out_of_range.json
  const oorJson = JSON.parse(
    readFileSync(join(outDir, 'out_of_range.json'), 'utf8'));
  const aliasProof = hexToBytes(oorJson.proof.replace(/^0x/, ''));
  if (aliasProof.length !== 754) throw new Error(`alias proof length ${aliasProof.length} != 754`);
  // two arbitrary but on-curve commitments (seeded, deterministic)
  const c0 = pedersenCommit(midValue(2, 90), blinding(2, 90));
  const c1 = pedersenCommit(midValue(2, 91), blinding(2, 91));
  const aliasCommits = [c0, c1];
  const acc = bpRangeAggVerify(aliasCommits, aliasProof, 64);
  if (acc) { anyBug = 1; console.error('\n!!! SOUNDNESS BUG: length_alias_m2 ACCEPTED at width 64 !!!\n'); }
  emit('length_alias_m2.json', {
    note: 'the 754-byte out_of_range proof (honest n_bits=128, m=1) handed to the 64-bit '
        + 'verifier with TWO commitments so m=2 ⇒ classic length 754 matches and '
        + 'verify_range_classic runs with an n=64,m=2 transcript. MUST reject: the '
        + 'transcript n/m binding diverges from the proof\'s real 128-bit/m=1 parameters.',
    m: 2, n_bits: N_BITS,
    commitments: aliasCommits.map((c) => hx(pointToBytes(c))),
    proof: hx(aliasProof),
    reference_rejects: !acc,
  });
  summary.push(`length_alias_m2.json  ${acc ? 'ACCEPT(BUG!)' : 'REJECT'} (754B aliases m=2 classic len)`);
}

// ---- 7) malformed compressed-point per point field ----
// For the valid m=2 proof, replace one point field's 33 bytes with an INVALID compressed
// point: 0x02 || p (x = secp256k1 field modulus, not a valid field element) for half the
// fields, and a bad prefix byte 0x04||… for the others. Each MUST reject at decompression:
// the SEC1 parser fails closed before any field is used. Proves every parsed point is
// SEC1-validated.
{
  // secp256k1 field modulus p (x-coordinate that is not a valid field element)
  const SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
  const pBytes = hexToBytes(SECP_P.toString(16).padStart(64, '0'));
  const badModP = concatBytes(new Uint8Array([0x02]), pBytes);      // 0x02 || p
  // 0x04 prefix on a 33-byte field is an invalid encoding (uncompressed needs 65 bytes)
  const badPrefix = concatBytes(new Uint8Array([0x04]), pBytes);    // 0x04 || …

  // field → offset in the m=2 proof (A,S,T1,T2 at 0/33/66/99; L0,R0 at 228/261)
  const pointFields = [
    ['A',  0,   badModP],
    ['S',  33,  badPrefix],
    ['T1', 66,  badModP],
    ['T2', 99,  badPrefix],
    ['L0', 228, badModP],
    ['R0', 261, badPrefix],
  ];
  for (const [label, off, bad] of pointFields) {
    const buf = proof.slice();
    buf.set(bad, off);
    const acc = bpRangeAggVerify(m2ValidCommits, buf, N_BITS);
    if (acc) { anyBug = 1; console.error(`\n!!! SOUNDNESS BUG: badpoint_${label} ACCEPTED !!!\n`); }
    emit(`badpoint_${label}.json`, {
      note: `valid m=2 proof with point field '${label}' replaced by an invalid compressed `
          + `point (${bad === badModP ? '0x02||p (x=field modulus)' : '0x04 bad prefix'}). `
          + `MUST reject at SEC1 decompression before any point is used.`,
      m: 2, n_bits: N_BITS,
      field: label,
      commitments: m2ValidCommits.map((c) => hx(pointToBytes(c))),
      proof: hx(buf),
      reference_rejects: !acc,
    });
    summary.push(`badpoint_${label}.json  ${acc ? 'ACCEPT(BUG!)' : 'REJECT'}  field=${label}`);
  }
}

// ---- print summary ----
console.log('classic-BP vectors written to', outDir);
for (const line of summary) console.log('  ' + line);
if (anyBug) {
  console.error('\nSOUNDNESS BUG DETECTED — at least one malformed proof was accepted. STOP.');
  process.exit(2);
}
console.log(`\n${summary.length} fixtures emitted; all valid ACCEPT, all adversarial REJECT (reference verifier).`);
