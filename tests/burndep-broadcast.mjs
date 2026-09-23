#!/usr/bin/env node
// Dapp burn-deposit (BTC→ETH) Slipstream broadcast seam. Locks: submits the raw tx to MARA's queue,
// polls a real chain check (not just MARA's own queue status) for confirmation, then registers the
// provenance bundle with the worker — in that order, never registering before confirmation.
//
// Run: node tests/burndep-broadcast.mjs

import assert from 'node:assert';
import { makeBurnDepositBroadcaster } from '../dapp/burndep-broadcast.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── 1. submitToSlipstream posts tx_hex to the right endpoint, throws on a non-ok response ──
{
  let posted = null;
  const fetchImpl = async (url, opts) => {
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ success: true }), text: async () => JSON.stringify(({ success: true })) };
  };
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const r = await b.submitToSlipstream('deadbeef');
  assert.strictEqual(posted.url, 'https://slipstream.mara.com/api/transactions', 'posts to the slipstream submit endpoint');
  assert.deepStrictEqual(posted.body, { tx_hex: 'deadbeef' }, 'body is { tx_hex }');
  assert.deepStrictEqual(r, { success: true }, 'returns the slipstream response');
  await assert.rejects(() => b.submitToSlipstream(), /txHex required/, 'rejects a missing txHex');
  ok('submitToSlipstream posts tx_hex, returns the response, rejects a missing tx');
}

// ── 2. submitToSlipstream throws loudly on a rejected submission ──
{
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad tx' }), text: async () => JSON.stringify(({ error: 'bad tx' })) });
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  await assert.rejects(() => b.submitToSlipstream('deadbeef'), /slipstream submit failed/, 'surfaces a rejected submission');
  ok('submitToSlipstream fails loudly on a non-ok response');
}

// ── 3. waitForBurnDepositMined resolves once checkConfirmed says so, not before ──
{
  let calls = 0;
  const checkConfirmed = async () => (++calls >= 3);
  const fetchImpl = async () => ({ json: async () => ({ position: { block: 2 } }) });
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const updates = [];
  const slept = [];
  const r = await b.waitForBurnDepositMined({
    txid: 'abc123', checkConfirmed, intervalMs: 10,
    onUpdate: (u) => updates.push(u.status),
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.strictEqual(calls, 3, 'polled checkConfirmed until it returned true');
  assert.strictEqual(r.confirmed, true, 'resolves confirmed');
  assert.deepStrictEqual(updates, ['queued', 'confirmed'], 'onUpdate fires on status change, ending in confirmed');
  assert.deepStrictEqual(slept, [10, 10], 'slept between polls via the injected sleep');
  ok('waitForBurnDepositMined polls checkConfirmed, not slipstream queue status, for the real exit condition');
}

// ── 4. waitForBurnDepositMined keeps working even if MARA's status endpoint errors ──
{
  let calls = 0;
  const checkConfirmed = async () => (++calls >= 2);
  const fetchImpl = async () => { throw new Error('network blip'); };
  const b = makeBurnDepositBroadcaster({ fetchImpl });
  const r = await b.waitForBurnDepositMined({ txid: 'x', checkConfirmed, intervalMs: 1, sleep: async () => {} });
  assert.strictEqual(r.confirmed, true, 'still resolves via checkConfirmed despite slipstream status being unreachable');
  ok('waitForBurnDepositMined tolerates a failing slipstream status poll (best-effort only)');
}

// ── 5. waitForBurnDepositMined times out rather than hanging forever, and validates its inputs ──
{
  const b = makeBurnDepositBroadcaster({ fetchImpl: async () => ({ json: async () => ({}) }) });
  await assert.rejects(
    () => b.waitForBurnDepositMined({ txid: 'x', checkConfirmed: async () => false, timeoutMs: 5, intervalMs: 1, sleep: async () => {} }),
    /not confirmed after/,
    'rejects on timeout',
  );
  await assert.rejects(() => b.waitForBurnDepositMined({ checkConfirmed: async () => true }), /txid required/, 'rejects a missing txid');
  await assert.rejects(() => b.waitForBurnDepositMined({ txid: 'x' }), /inject checkConfirmed/, 'rejects a missing checkConfirmed');
  ok('waitForBurnDepositMined times out loudly and validates required inputs');
}

// ── 6. registerBurnDeposit posts to /reflection/burndep, requires workerBase ──
{
  let posted = null;
  const fetchImpl = async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ ok: true, stored: 'k' }), text: async () => JSON.stringify(({ ok: true, stored: 'k' })) }; };
  const b = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl });
  const r = await b.registerBurnDeposit({ burnTxidDisplay: 'abc', bundle: { some: 'data' } });
  assert.strictEqual(posted.url, 'https://api.example/reflection/burndep?network=mainnet', 'posts to the burndep endpoint with network');
  assert.deepStrictEqual(posted.body, { burnTxidDisplay: 'abc', bundle: { some: 'data' } }, 'body carries the txid + bundle');
  assert.deepStrictEqual(r, { ok: true, stored: 'k' }, 'returns the worker response');

  const noBase = makeBurnDepositBroadcaster({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify(({ ok: true })) }) });
  await assert.rejects(() => noBase.registerBurnDeposit({ burnTxidDisplay: 'abc', bundle: {} }), /needs workerBase/, 'rejects without workerBase');
  ok('registerBurnDeposit posts to /reflection/burndep, requires workerBase');
}

// ── 7. completeBurnDepositToEthereum runs submit → wait → register, in that order ──
{
  const order = [];
  let confirmedAt = null;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/transactions') && opts?.method === 'POST') { order.push('submit'); return { ok: true, json: async () => ({ success: true }), text: async () => JSON.stringify(({ success: true })) }; }
    if (url.includes('/reflection/burndep')) { order.push('register'); confirmedAt = order.includes('wait-confirmed'); return { ok: true, json: async () => ({ ok: true }), text: async () => JSON.stringify(({ ok: true })) }; }
    return { json: async () => ({}) };
  };
  const checkConfirmed = async () => { order.push('wait-confirmed'); return true; };
  const b = makeBurnDepositBroadcaster({ workerBase: 'https://api.example', fetchImpl });
  const r = await b.completeBurnDepositToEthereum({
    txHex: 'deadbeef', txid: 'abc', burnTxidDisplay: 'abc', bundle: { x: 1 },
    checkConfirmed, waitOpts: { intervalMs: 1, sleep: async () => {} },
  });
  assert.deepStrictEqual(order, ['submit', 'wait-confirmed', 'register'], 'submits, then waits for confirmation, then registers');
  assert.strictEqual(confirmedAt, true, 'registration only happens after confirmation was observed');
  assert.ok(r.submitResult && r.registered, 'returns both the submit and registration results');
  ok('completeBurnDepositToEthereum orders submit → confirm → register, never registering before confirmation');
}

console.log(`\n${n}/7 burndep-broadcast checks passed`);
