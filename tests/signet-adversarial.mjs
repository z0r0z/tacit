#!/usr/bin/env node
// Adversarial coverage for the auto-fulfil funding verifier.
//
// Locks in C1+H1 from the audit:
//   - C1: dapp's auto-fulfil must verify funding_txid actually paid the
//     treasury, not just check the field's format.
//   - H1: the verifier must reject unconfirmed (RBF-able) funding txs, with
//     `transient: true` caching so a later confirmation isn't missed.
//
// Three test vectors against the live signet API:
//   1. Junk txid (64 hex but not a real tx) → expect ok:false, transient
//      (fetch fails / tx not found).
//   2. Real signet tx that did NOT pay our treasury → expect ok:false with
//      "paid 0 sats" (permanent — not transient).
//   3. The happy-path tip txid from the just-completed dryrun, IF still
//      mempool-only when this runs → expect ok:false with "unconfirmed"
//      (transient). If already confirmed, expect ok:true.
//
// Run after `signet-dryrun.mjs` so vector 3 has a real txid to point at.

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

// ---- jsdom shim + dapp import ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const m = await import('../dapp/tacit.js');

// ---- Derive the treasury address from the same SEED as the dryrun ----
const SEED = process.env.SEED || '0101010101010101010101010101010101010101010101010101010101010101';
function deriveFromSeed(label) {
  return bytesToHex(sha256(new TextEncoder().encode('tacit-signet-dryrun-v1:' + label + ':' + SEED)));
}
const TREASURY_PRIV = (process.env.TREASURY_PRIV || deriveFromSeed('treasury')).toLowerCase();
const treasuryPub = secp.getPublicKey(hexToBytes(TREASURY_PRIV), true);
const TREASURY_ADDR = bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(treasuryPub)))]);
const MIN_SATS = 3000;

let pass = 0, fail = 0;
function expect(label, actual, predicate, hint) {
  const ok = predicate(actual);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else    { console.log(`  ✗ ${label} — ${hint}\n      got: ${JSON.stringify(actual)}`); fail++; }
}

console.log('\n=== Adversarial verifier tests ===');
console.log(`Treasury: ${TREASURY_ADDR}`);
console.log(`Min sats: ${MIN_SATS}`);
console.log();

// ---- Vector 1: junk txid (64 hex but not a real tx) ----
// The dapp's getTx hits mempool.space's /tx/:txid endpoint. A nonexistent
// txid returns 404; getTx throws → verifier returns ok:false + transient:true.
console.log('Vector 1: junk txid (not a real signet tx)');
{
  const junkTxid = 'd'.repeat(64);
  const result = await m.verifyAutoFulfilFundingTx(junkTxid, TREASURY_ADDR, MIN_SATS);
  expect('rejects with ok:false', result, r => r.ok === false, 'should reject');
  expect('marks transient (so cache re-checks on next cycle)', result, r => r.transient === true, 'transient:true means daemon retries');
  expect('error mentions tx fetch / not found', result, r => /fetch failed|not found|malformed/i.test(r.err || ''), 'expected fetch-failure error string');
}

// ---- Vector 2: real signet tx that didn't pay our treasury ----
// Use the live-fetched current tip's coinbase tx. Definitely doesn't pay
// our test treasury. Permanent rejection ("paid 0 sats").
console.log('\nVector 2: real signet tx that did NOT pay the treasury');
{
  let tipTxid = null;
  try {
    // mempool.space signet — get latest block tx[0] (coinbase)
    const tipResp = await fetch('https://mempool.space/signet/api/blocks/tip/hash');
    const tipHash = (await tipResp.text()).trim();
    const txsResp = await fetch(`https://mempool.space/signet/api/block/${tipHash}/txids`);
    const txids = await txsResp.json();
    tipTxid = txids[0];
  } catch (e) {
    console.log(`  ⚠ couldn't fetch a sample signet tx (${e.message}); skipping vector 2`);
  }
  if (tipTxid) {
    console.log(`  using coinbase ${tipTxid.slice(0, 16)}…`);
    const result = await m.verifyAutoFulfilFundingTx(tipTxid, TREASURY_ADDR, MIN_SATS);
    expect('rejects with ok:false', result, r => r.ok === false, 'should reject');
    expect('cites paid 0 sats (no treasury outputs)', result, r => /paid 0 sats|paid \d+ sats, need/i.test(r.err || ''), 'expected sats-paid error string');
    // Note: this could be transient OR permanent depending on whether the
    // coinbase tx is in a "confirmed" state per mempool.space's API. Either
    // way the rejection is correct.
  }
}

// ---- Vector 3: a confirmed-but-failing edge — use our own dryrun's funding txid ----
// If the just-completed dryrun's tip is fully confirmed, the verifier should
// return ok:true. If mempool-only (rare; signet blocks are slow), it returns
// ok:false + transient:true.
//
// We can't know the dryrun's txid programmatically here without a state
// handoff; skip unless an env var provides it.
console.log('\nVector 3: previous run\'s real funding txid (if provided)');
{
  const provided = process.env.PREV_FUNDING_TXID;
  if (provided && /^[0-9a-f]{64}$/.test(provided.toLowerCase())) {
    const result = await m.verifyAutoFulfilFundingTx(provided.toLowerCase(), TREASURY_ADDR, MIN_SATS);
    console.log(`  using ${provided.slice(0, 16)}…`);
    if (result.ok) {
      // Tip confirmed AND ≥ min sats — full happy path.
      expect('happy path: ok:true with sats ≥ min', result, r => r.ok === true && r.sats >= MIN_SATS, 'expected ok:true');
    } else if (result.transient) {
      // Mempool-only — H1 confirmation gate is firing (correct rejection).
      expect('still unconfirmed: rejected with transient:true (H1 conf gate)', result, r => r.ok === false && r.transient === true, 'expected transient rejection');
    } else if (/paid \d+ sats, need ≥ \d+/.test(result.err || '')) {
      // Permanent rejection for paying < MIN_SATS — also correct.
      // This is what fires when the dryrun's 1000-sat tips are checked
      // against the dapp's 3000-sat min. Security positive: verifier
      // refuses underfunded tips regardless of who broadcast them.
      expect('underfunded tip: permanent rejection (M6 floor)', result, r => r.ok === false && r.transient !== true, 'expected permanent under-min rejection');
    } else {
      expect('unexpected outcome shape', result, () => false, 'unrecognized rejection reason — investigate');
    }
  } else {
    console.log('  (skipped — set PREV_FUNDING_TXID=<hex64> from dryrun to exercise)');
  }
}

console.log(`\n=== Adversarial result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
