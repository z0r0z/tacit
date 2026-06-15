#!/usr/bin/env node
// Asset-UTXO funding guard — proves the plain-sats picker every commit builder uses
// (selectSatsUtxosSafe / pickSafeCommitSats) excludes asset-bearing UTXOs by GROUND-TRUTH
// holdings, not just the 546-sat dust band. The headline regression: an asset UTXO whose
// value EXCEEDS dust (e.g. a non-standard / over-postage output) must still be excluded —
// gate 1 (holdings) catches it even though gate 2 (dust band) would let it through and a
// non-tacit-aware spend would burn it.
//
// The functions live in the browser script dapp/tacit.js (no ES exports), so we extract
// their real source and run it in a sandbox — the test tracks the shipped code, no drift.
//
// Run: node tests/sats-funding-guard.mjs

import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const SRC = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8').split('\n');

// Extract a top-level function by name: from its declaration line to the next col-0 `}`.
// (tacit.js convention: top-level functions close with `}` at column 0; inner braces are indented.)
function extract(name) {
  const re = new RegExp('^(?:async )?function ' + name + '\\b');
  const start = SRC.findIndex((l) => re.test(l));
  if (start < 0) throw new Error('function not found in tacit.js: ' + name);
  let end = start;
  while (end < SRC.length && SRC[end] !== '}') end++;
  if (end >= SRC.length) throw new Error('no closing brace for: ' + name);
  return SRC.slice(start, end + 1).join('\n');
}

const DUST = 546;
let SCAN; // mutable holdings result the stubbed scanHoldings returns
const scanHoldings = async () => SCAN;

const body =
  [extract('sortSatsForCommit'), extract('selectSatsUtxosSafe'), extract('pickSafeCommitSats')].join('\n\n') +
  '\nreturn { sortSatsForCommit, selectSatsUtxosSafe, pickSafeCommitSats };';
const { selectSatsUtxosSafe, pickSafeCommitSats } =
  new Function('DUST', 'scanHoldings', body)(DUST, scanHoldings);

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const u = (txid, value, confirmed = true) => ({ txid, vout: 0, value, status: { confirmed } });
const held = (txid) => ({ utxo: { txid, vout: 0 } });

// Wallet's raw address UTXOs.
const assetDust = u('a1', DUST);        // asset note at exactly dust
const assetBig  = u('b2', 10000);       // asset note ABOVE dust  ← the regression target
const ghost     = u('c3', 9000);        // unvalidated / parent-might-be-tacit
const pend      = u('d4', 8000);        // pending mint, same dust shape
const satsConf  = u('e5', 5000, true);  // genuine sats, confirmed
const satsUnc   = u('f6', 7000, false); // genuine sats, unconfirmed
const dustPlain = u('07', DUST);        // genuine but dust-sized sats
const allUtxos  = [assetDust, assetBig, ghost, pend, satsConf, satsUnc, dustPlain];

// Holdings classifier output: assetDust + assetBig are real asset UTXOs; ghost/pending tracked too.
const holdings = new Map([['0xAA', {
  balance: 0n,
  utxos:   [held('a1'), held('b2')],
  ghosts:  [held('c3')],
  inflated: [],
  pending: [held('d4')],
}]]);

// ── 1. headline: a >DUST asset UTXO is excluded by holdings (gate 1), not just the dust band ──
const safe = selectSatsUtxosSafe(allUtxos, holdings);
const ids = safe.map((x) => x.txid);
assert.ok(!ids.includes('b2'), 'a >DUST asset UTXO must NOT be selected as plain sats');
ok('a >DUST asset UTXO is excluded by ground-truth holdings (would be burned by dust-band alone)');

// ── 2. all asset / ghost / pending / dust UTXOs excluded; only genuine sats remain ──
assert.deepStrictEqual(ids.sort(), ['e5', 'f6'], 'only the two genuine non-dust sats survive');
assert.ok(!ids.includes('a1'), 'dust-sized asset note excluded');
assert.ok(!ids.includes('c3'), 'ghost UTXO excluded');
assert.ok(!ids.includes('d4'), 'pending UTXO excluded');
assert.ok(!ids.includes('07'), 'dust-sized plain sats excluded by dust band');
ok('asset / ghost / pending / dust UTXOs all excluded; genuine sats retained');

// ── 3. fail-closed: a missing/invalid holdings classifier throws, never spends everything ──
assert.throws(() => selectSatsUtxosSafe(allUtxos, null), /holdings/i,
  'null holdings must throw, not assume "no assets"');
assert.throws(() => selectSatsUtxosSafe(allUtxos, undefined), /holdings/i);
ok('selectSatsUtxosSafe fails closed when the holdings classifier is unavailable');

// ── 4. pickSafeCommitSats: holdings-aware + sorted (confirmed first, then value desc) ──
SCAN = holdings;
const picked = await pickSafeCommitSats(allUtxos);
assert.deepStrictEqual(picked.map((x) => x.txid), ['e5', 'f6'],
  'confirmed (5000) before unconfirmed (7000), asset UTXOs absent');
ok('pickSafeCommitSats returns the safe set, confirmed-first ordered');

// ── 5. pickSafeCommitSats fails closed when the scan fails ──
SCAN = null;
await assert.rejects(() => pickSafeCommitSats(allUtxos), /holdings scan failed/i,
  'a failed holdings scan must abort funding, not fund from asset UTXOs');
ok('pickSafeCommitSats rejects when scanHoldings returns no classification');

console.log(`\n${n} checks passed`);
