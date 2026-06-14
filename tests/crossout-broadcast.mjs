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

console.log(`\n${n}/2 crossout-broadcast checks passed`);
