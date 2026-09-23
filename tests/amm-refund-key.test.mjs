#!/usr/bin/env node
// The Bitcoin-lane AMM refund key must be FRESH (dapp/amm-refund-key.js).
//
// A refund commits the spent input's commitment verbatim under the refund output's x-only key, and a
// Bitcoin-homed note's nullifier is keccak(leaf ‖ "spent") over a leaf of (asset, Cx, Cy, auth_key) with NO
// outpoint. So refunding to the input note's own key produces the nullifier the vin scan just spent: the
// refund is born already-spent, the input is gone, and the value is destroyed. This pins the guard.
//
// Run: node tests/amm-refund-key.test.mjs

import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { p2trXonlyOf, refundKeyCollides, assertFreshRefundKey } from '../dapp/amm-refund-key.js';

let n = 0; const ok = (s) => { n++; console.log('  ok -', s); };
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const p2tr = (xonly) => '5120' + xonly;

const INPUT_KEY = 'aa'.repeat(32);
const FRESH_KEY = 'bb'.repeat(32);

// ── 1. the exact collision, demonstrated against the real leaf/nullifier construction ──
// btc_note_leaf = keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖ "tacit-btc-note-v1"); ν = keccak(leaf ‖ "spent").
{
  const enc = new TextEncoder();
  const cat = (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const h = (s) => Uint8Array.from((s.match(/../g) || []).map((x) => parseInt(x, 16)));
  const leaf = (asset, cx, cy, auth) => keccak_256(cat(h(asset), h(cx), h(cy), h(auth), enc.encode('tacit-btc-note-v1')));
  const nu = (lf) => keccak_256(cat(lf, enc.encode('spent')));

  const asset = '11'.repeat(32), cx = '22'.repeat(32), cy = '33'.repeat(32);
  // The input note, homed at INPUT_KEY, is nullified by the vin scan.
  const spentNu = hex(nu(leaf(asset, cx, cy, INPUT_KEY)));
  // A refund commits the SAME commitment. Under the input's own key it reproduces that nullifier exactly.
  const refundToInputKey = hex(nu(leaf(asset, cx, cy, INPUT_KEY)));
  const refundToFreshKey = hex(nu(leaf(asset, cx, cy, FRESH_KEY)));

  assert.strictEqual(refundToInputKey, spentNu, 'refund to the input key reproduces the spent nullifier');
  assert.notStrictEqual(refundToFreshKey, spentNu, 'a fresh key yields a distinct, spendable note');
  ok('refunding to the input note’s own key reproduces the nullifier the scan already spent');
}

// ── 2. the guard catches it, from a script or a bare key ──
{
  assert.strictEqual(p2trXonlyOf(p2tr(INPUT_KEY)), INPUT_KEY, 'parses a P2TR program');
  assert.strictEqual(p2trXonlyOf('0014' + 'cc'.repeat(20)), null, 'a P2WPKH program is not P2TR');
  assert.ok(refundKeyCollides({ refundSpk: p2tr(INPUT_KEY), inputAuthKeys: [INPUT_KEY] }), 'collides via bare key');
  assert.ok(refundKeyCollides({ refundSpk: p2tr(INPUT_KEY), inputAuthKeys: [p2tr(INPUT_KEY)] }), 'collides via script');
  assert.ok(!refundKeyCollides({ refundSpk: p2tr(FRESH_KEY), inputAuthKeys: [INPUT_KEY] }), 'a fresh key does not collide');
  ok('refundKeyCollides matches on x-only keys whether given a script or bare hex');
}

// ── 3. assertFreshRefundKey throws, and says why ──
{
  assert.throws(
    () => assertFreshRefundKey({ refundSpk: p2tr(INPUT_KEY), inputAuthKeys: [INPUT_KEY], label: 'swap_var' }),
    /born already-spent|input notes' own keys/,
    'refuses the input key',
  );
  assert.throws(
    () => assertFreshRefundKey({ refundSpk: p2tr(FRESH_KEY), otherRefundSpks: [p2tr(FRESH_KEY)] }),
    /share a key/,
    'refuses a duplicate refund key in the same tx',
  );
  assert.throws(
    () => assertFreshRefundKey({ refundSpk: '0014' + 'cc'.repeat(20) }),
    /must be a P2TR output/,
    'refuses a non-P2TR refund destination',
  );
  assert.strictEqual(
    assertFreshRefundKey({ refundSpk: p2tr(FRESH_KEY), inputAuthKeys: [INPUT_KEY, 'dd'.repeat(32)] }),
    FRESH_KEY,
    'a fresh key passes and returns the derived x-only key',
  );
  ok('assertFreshRefundKey refuses an input key, a duplicate, and a non-P2TR destination');
}

console.log(`\n${n} amm-refund-key checks passed.`);
