// Fast-lane consumed-source registration must accept ONLY the genuine source for a given ν.
//
// Why this matters more than a normal input check: `buildModeBBatch` resolves a consumed ν by first match
// and throws when it finds none, and the guest's `fold_consumed` is `.expect(...)` — a wrong source panics
// the proof rather than skipping it, and the whole consumed set must fold for the attest's freshness gate
// to pass. So one bad stored entry wedges every later Mode-B proof for everyone. Validating at write time
// is what makes first-match resolution safe: a wrong submission is rejected, never recorded.
//
// These cases are built with the real pool primitives, so the leaf/nullifier derivations are the same ones
// cxfer-core `fold_consumed` re-checks in the zkVM.
//
// Run: node tests/consumed-source-validation.test.mjs

import * as secp from '@noble/secp256k1';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { validateConsumedSource, deriveConsumedSource } from '../worker/src/consumed-source.js';

const pool = makeConfidentialPool({ secp, keccak256, sha256 });

let pass = 0, fail = 0;
const test = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const CHAIN_BINDING = '0x' + '7c'.repeat(32);
const ASSET = '0x' + 'ab'.repeat(32);
const AUTH = '0x' + '33'.repeat(32);
const CX = '0x' + '11'.repeat(32);
const CY = '0x' + '22'.repeat(32);
const TXID = 'de'.repeat(32);
const VOUT = 3;

// Build a live-set row exactly as the reflection records one, for both generation domains.
function fixture(bound) {
  const key = pool.outpointKey('0x' + TXID, VOUT);
  const ch = pool.commitmentHash(CX, CY);
  const leaf = bound
    ? pool.btcNoteLeafBound(ASSET, CX, CY, AUTH, CHAIN_BINDING)
    : pool.btcNoteLeaf(ASSET, CX, CY, AUTH);
  const nu = pool.nullifier(leaf);
  return { live: [[key, ch, ASSET, AUTH, bound ? 1 : 0]], nu, sub: { nu, cx: CX, cy: CY, srcTxid: TXID, srcVout: VOUT } };
}

console.log('consumed-source registration validation:\n');

for (const bound of [false, true]) {
  const name = bound ? 'generation-bound (0x39) note' : 'legacy-domain note';
  const f = fixture(bound);

  test(`accepts the genuine source for a ${name}`, () => {
    const r = validateConsumedSource(f.sub, f.live, pool, CHAIN_BINDING);
    ok(r.ok, r.reason);
    ok(r.record.nu === f.nu, 'record carries the nu');
    ok(r.record.srcVout === VOUT, 'record carries the vout');
  });

  test(`rejects a WRONG commitment for a ${name} (poisoning attempt)`, () => {
    const r = validateConsumedSource({ ...f.sub, cx: '0x' + '99'.repeat(32) }, f.live, pool, CHAIN_BINDING);
    ok(!r.ok, 'must reject');
    ok(/commitment does not match/.test(r.reason), `reason: ${r.reason}`);
  });

  test(`rejects a WRONG outpoint for a ${name} (poisoning attempt)`, () => {
    const r = validateConsumedSource({ ...f.sub, srcTxid: 'ff'.repeat(32) }, f.live, pool, CHAIN_BINDING);
    ok(!r.ok, 'must reject');
    ok(/not a live UTXO/.test(r.reason), `reason: ${r.reason}`);
  });

  test(`rejects a WRONG vout for a ${name}`, () => {
    const r = validateConsumedSource({ ...f.sub, srcVout: VOUT + 1 }, f.live, pool, CHAIN_BINDING);
    ok(!r.ok, 'must reject');
  });

  test(`rejects a ν that is not this note's nullifier for a ${name}`, () => {
    const r = validateConsumedSource({ ...f.sub, nu: '0x' + '77'.repeat(32) }, f.live, pool, CHAIN_BINDING);
    ok(!r.ok, 'must reject');
    ok(/not the nullifier/.test(r.reason), `reason: ${r.reason}`);
  });
}

test('the two generation domains do not cross-validate', () => {
  // A bound note's ν presented against a live row tagged legacy (and vice versa) must fail: the leaf is
  // reconstructed from the live row's own tag, so the nullifier will not match.
  const boundF = fixture(true);
  const legacyLive = [[boundF.live[0][0], boundF.live[0][1], ASSET, AUTH, 0]];
  const r1 = validateConsumedSource(boundF.sub, legacyLive, pool, CHAIN_BINDING);
  ok(!r1.ok && /not the nullifier/.test(r1.reason), `bound nu vs legacy row: ${r1.reason}`);

  const legacyF = fixture(false);
  const boundLive = [[legacyF.live[0][0], legacyF.live[0][1], ASSET, AUTH, 1]];
  const r2 = validateConsumedSource(legacyF.sub, boundLive, pool, CHAIN_BINDING);
  ok(!r2.ok && /not the nullifier/.test(r2.reason), `legacy nu vs bound row: ${r2.reason}`);
});

test('the asset and auth key are taken from live state, not from the caller', () => {
  // A caller who names a live outpoint but hopes to have the leaf built over an asset of their choosing
  // gets nothing: the function ignores any such field, so the nullifier check still binds the real note.
  const f = fixture(false);
  const r = validateConsumedSource(
    { ...f.sub, asset: '0x' + 'ee'.repeat(32), authKey: '0x' + 'ee'.repeat(32) },
    f.live, pool, CHAIN_BINDING,
  );
  ok(r.ok, `genuine submission must still pass: ${r.reason}`);
});

test('a bound note without a chain binding is rejected rather than mis-derived', () => {
  const f = fixture(true);
  const r = validateConsumedSource(f.sub, f.live, pool, null);
  ok(!r.ok, 'must reject');
  ok(/chain binding/.test(r.reason), `reason: ${r.reason}`);
});

test('an empty live set is rejected rather than treated as "no match is fine"', () => {
  const f = fixture(false);
  const r = validateConsumedSource(f.sub, [], pool, CHAIN_BINDING);
  ok(!r.ok && /live set/.test(r.reason), `reason: ${r.reason}`);
});

test('malformed fields are rejected before any derivation', () => {
  const f = fixture(false);
  for (const bad of [
    { ...f.sub, nu: 'nope' },
    { ...f.sub, cx: '0x1234' },
    { ...f.sub, srcTxid: 'zz'.repeat(32) },
    { ...f.sub, srcVout: -1 },
    { ...f.sub, srcVout: 1.5 },
  ]) {
    const r = validateConsumedSource(bad, f.live, pool, CHAIN_BINDING);
    ok(!r.ok, `must reject ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

test('case and 0x-prefix variations of a genuine submission still validate', () => {
  const f = fixture(false);
  const r = validateConsumedSource(
    { ...f.sub, nu: f.sub.nu.replace(/^0x/, '').toUpperCase(), cx: CX.toUpperCase(), srcTxid: '0x' + TXID.toUpperCase() },
    f.live, pool, CHAIN_BINDING,
  );
  ok(r.ok, `reason: ${r.reason}`);
  ok(r.record.nu.startsWith('0x') && r.record.nu === r.record.nu.toLowerCase(), 'record is normalised');
});


// ── derivation: the source resolved from state alone, with nothing submitted ──────────────────────────
console.log('\nderivation from reflected state (no submission):\n');

const coordsFor = (bound) => new Map([[pool.outpointKey('0x' + TXID, VOUT), { cx: CX, cy: CY, txid: TXID, vout: VOUT }]]);

for (const bound of [false, true]) {
  const name = bound ? 'generation-bound (0x39) note' : 'legacy-domain note';
  const f = fixture(bound);
  test(`derives the source for a ${name} with no input beyond the nullifier`, () => {
    const r = deriveConsumedSource(f.nu, f.live, coordsFor(bound), pool, CHAIN_BINDING);
    ok(r.ok, r.reason);
    ok(r.record.srcTxid === TXID, `txid: ${r.record.srcTxid}`);
    ok(r.record.srcVout === VOUT, `vout: ${r.record.srcVout}`);
    ok(r.record.cx === CX && r.record.cy === CY, 'coords');
  });
  test(`the derived record passes validation for a ${name} (the two agree)`, () => {
    const d = deriveConsumedSource(f.nu, f.live, coordsFor(bound), pool, CHAIN_BINDING);
    ok(d.ok, d.reason);
    const v = validateConsumedSource(d.record, f.live, pool, CHAIN_BINDING);
    ok(v.ok, `derived record failed validation: ${v.reason}`);
  });
}

test('derivation returns nothing for a nullifier no live note produces', () => {
  const f = fixture(false);
  const r = deriveConsumedSource('0x' + '5a'.repeat(32), f.live, coordsFor(false), pool, CHAIN_BINDING);
  ok(!r.ok && /no live note reproduces/.test(r.reason), `reason: ${r.reason}`);
});

test('a legacy coords entry without the outpoint preimage is reported, not half-answered', () => {
  const f = fixture(false);
  const legacy = new Map([[pool.outpointKey('0x' + TXID, VOUT), { cx: CX, cy: CY }]]); // pre-change shape
  const r = deriveConsumedSource(f.nu, f.live, legacy, pool, CHAIN_BINDING);
  ok(!r.ok, 'must not return a record without txid/vout');
  ok(/preimage/.test(r.reason), `reason: ${r.reason}`);
});

test('derivation ignores a live note whose coords are absent', () => {
  const f = fixture(false);
  const r = deriveConsumedSource(f.nu, f.live, new Map(), pool, CHAIN_BINDING);
  ok(!r.ok && /no live note reproduces/.test(r.reason), `reason: ${r.reason}`);
});

test('derivation picks the RIGHT note out of a populated live set', () => {
  const f = fixture(false);
  // Surround the real note with decoys that differ only in asset / auth key.
  const decoyKeys = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32)];
  const live = [
    [decoyKeys[0], pool.commitmentHash(CX, CY), '0x' + 'cc'.repeat(32), AUTH, 0],
    ...f.live,
    [decoyKeys[1], pool.commitmentHash(CX, CY), ASSET, '0x' + 'dd'.repeat(32), 0],
  ];
  const coords = new Map([
    [decoyKeys[0], { cx: CX, cy: CY, txid: '11'.repeat(32), vout: 0 }],
    [pool.outpointKey('0x' + TXID, VOUT), { cx: CX, cy: CY, txid: TXID, vout: VOUT }],
    [decoyKeys[1], { cx: CX, cy: CY, txid: '22'.repeat(32), vout: 9 }],
  ]);
  const r = deriveConsumedSource(f.nu, live, coords, pool, CHAIN_BINDING);
  ok(r.ok, r.reason);
  ok(r.record.srcTxid === TXID, `picked the wrong note: ${r.record.srcTxid}`);
});

test('a WRONG outpoint preimage is rejected, whatever wrote it', () => {
  // The live key is keccak(txid || vout_le32), so a preimage that does not hash to it cannot be genuine.
  // This is what lets a backfill be untrusted: a wrong entry fails closed instead of stalling the lane.
  const f = fixture(false);
  const bad = new Map([[pool.outpointKey('0x' + TXID, VOUT), { cx: CX, cy: CY, txid: 'ab'.repeat(32), vout: VOUT }]]);
  const r = deriveConsumedSource(f.nu, f.live, bad, pool, CHAIN_BINDING);
  ok(!r.ok, 'must reject a forged preimage');
  ok(/does not hash to its own outpoint key/.test(r.reason), `reason: ${r.reason}`);
});

test('a preimage with the right txid but the wrong vout is rejected', () => {
  const f = fixture(false);
  const bad = new Map([[pool.outpointKey('0x' + TXID, VOUT), { cx: CX, cy: CY, txid: TXID, vout: VOUT + 1 }]]);
  const r = deriveConsumedSource(f.nu, f.live, bad, pool, CHAIN_BINDING);
  ok(!r.ok && /does not hash/.test(r.reason), `reason: ${r.reason}`);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
