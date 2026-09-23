#!/usr/bin/env node
// Dapp T_CROSSOUT_MINT broadcast seam (task #5). Locks: the broadcast builds the correct 0x65 envelope
// (decodes back to the burn destination), drives the injected commit/reveal broadcast, fast-tracks the
// worker /hint, and surfaces the txid + status; and it fails loudly if the broadcast returns no txid.
//
// Run: node tests/crossout-broadcast.mjs

import assert from 'node:assert';
import { decodeCrossoutMint, T_CROSSOUT_MINT } from '../dapp/confidential-crossout-consumer.js';
import { makeCrossoutBroadcaster } from '../dapp/crossout-broadcast.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const b32 = (tag) => '0x' + Buffer.from(tag.padEnd(32, '\0')).toString('hex');
const burn = { assetId: b32('TAC'), claimId: b32('claimZ'), cx: b32('cx'), cy: b32('cy'), owner: '0x' + '00'.repeat(32) };

// ── 1. happy path: builds the 0x65 envelope, broadcasts, hints, returns txid+status ──
{
  let broadcastPayload = null, hinted = null;
  const buildAndBroadcastEnvelope = async (payload) => { broadcastPayload = payload; return { txid: 'btc-txid-1', vout: 0 }; };
  const postHint = async (txid, vout) => { hinted = { txid, vout }; };
  const broadcast = makeCrossoutBroadcaster({ buildAndBroadcastEnvelope, postHint });

  const r = await broadcast(burn);
  assert.strictEqual(broadcastPayload.length, 161, 'broadcast the 161-byte envelope');
  assert.strictEqual(broadcastPayload[0], T_CROSSOUT_MINT, 'opcode 0x65');
  const dec = decodeCrossoutMint(broadcastPayload);
  assert.strictEqual(dec.claimId.toLowerCase(), burn.claimId.toLowerCase(), 'envelope decodes back to the burn claimId');
  assert.strictEqual(dec.assetId.toLowerCase(), burn.assetId.toLowerCase(), 'envelope carries the asset');
  assert.deepStrictEqual(hinted, { txid: 'btc-txid-1', vout: 0 }, 'fast-tracked the worker /hint');
  assert.strictEqual(r.txid, 'btc-txid-1', 'returns the broadcast txid');
  assert.strictEqual(r.status, 'broadcast', 'status broadcast');
  ok('builds the 0x65 envelope, broadcasts via commit/reveal, fast-tracks /hint, returns txid+status');
}

// ── 2. fails loudly if the broadcast returns no txid ──
{
  const broadcast = makeCrossoutBroadcaster({ buildAndBroadcastEnvelope: async () => ({}), postHint: async () => {} });
  await assert.rejects(() => broadcast(burn), /no txid/, 'rejects when broadcast yields no txid');
  assert.throws(() => makeCrossoutBroadcaster({}), /inject buildAndBroadcastEnvelope/, 'requires the broadcast injection');
  ok('fails loudly on a missing txid / missing injection');
}

// ── 3. the broadcast function is still directly callable (backward compatible), with the new methods
//      hanging off it rather than changing the return shape ──
{
  const broadcast = makeCrossoutBroadcaster({ buildAndBroadcastEnvelope: async () => ({ txid: 'x' }), workerBase: 'https://api.example' });
  assert.strictEqual(typeof broadcast, 'function', 'still returns the callable broadcast function');
  assert.strictEqual(typeof broadcast.waitForCrossOutCoverage, 'function', 'waitForCrossOutCoverage hangs off it');
  assert.strictEqual(typeof broadcast.completeCrossOutOnBitcoin, 'function', 'completeCrossOutOnBitcoin hangs off it');
  ok('backward compatible: broadcast is still a bare callable function');
}

// ── 4. waitForCrossOutCoverage polls until covered=true, firing onUpdate on each status change, using an
//      injected sleep so the test never actually waits ──
{
  let calls = 0;
  const fetchImpl = async () => ({ json: async () => ({ covered: ++calls >= 3, bestBlock: 100 + calls, network: 'mainnet', block: 105 }) });
  const updates = [];
  const broadcast = makeCrossoutBroadcaster({ buildAndBroadcastEnvelope: async () => ({ txid: 'x' }), workerBase: 'https://api.example', fetchImpl });
  const slept = [];
  const r = await broadcast.waitForCrossOutCoverage({ block: 105, intervalMs: 10, onUpdate: (b) => updates.push(b.covered), sleep: async (ms) => { slept.push(ms); } });
  assert.strictEqual(calls, 3, 'polled until covered');
  assert.strictEqual(r.covered, true, 'resolves with the covering response');
  assert.deepStrictEqual(updates, [false, true], 'onUpdate fires once per status change, not once per poll');
  assert.deepStrictEqual(slept, [10, 10], 'slept between polls via the injected sleep, not a real timer');
  ok('waitForCrossOutCoverage polls until covered, firing onUpdate on status change');
}

// ── 5. waitForCrossOutCoverage times out rather than returning uncovered silently ──
{
  const fetchImpl = async () => ({ json: async () => ({ covered: false }) });
  const broadcast = makeCrossoutBroadcaster({ buildAndBroadcastEnvelope: async () => ({ txid: 'x' }), workerBase: 'https://api.example', fetchImpl });
  await assert.rejects(
    () => broadcast.waitForCrossOutCoverage({ block: 105, timeoutMs: 5, intervalMs: 1, sleep: async () => {} }),
    /timed out/,
    'rejects on timeout rather than resolving uncovered',
  );
  await assert.rejects(() => broadcast.waitForCrossOutCoverage({ block: 0 }), /block .* required/, 'rejects a non-positive block');
  ok('waitForCrossOutCoverage times out loudly instead of returning uncovered');
}

// ── 6. completeCrossOutOnBitcoin waits for coverage, then broadcasts — not before ──
{
  let covered = false;
  const fetchImpl = async () => ({ json: async () => ({ covered }) });
  let broadcastCalledAt = null;
  const buildAndBroadcastEnvelope = async () => { broadcastCalledAt = covered; return { txid: 'btc-txid-2' }; };
  const broadcast = makeCrossoutBroadcaster({ buildAndBroadcastEnvelope, workerBase: 'https://api.example', fetchImpl });
  const sleep = async () => { covered = true; }; // flips to covered on the poll's wait, simulating time passing
  const r = await broadcast.completeCrossOutOnBitcoin({ block: 105, ...burn, waitOpts: { intervalMs: 1, sleep } });
  assert.strictEqual(broadcastCalledAt, true, 'only broadcast once coverage was confirmed, never before');
  assert.strictEqual(r.txid, 'btc-txid-2', 'returns the broadcast result');
  ok('completeCrossOutOnBitcoin waits for coverage before broadcasting');
}

console.log(`\n${n}/6 crossout-broadcast checks passed`);
