// Unit tests for the per-bid fill engine (fulfiller/watchtower-core.mjs),
// driving runTick over a mocked dapp so the orchestration logic — discovery
// filtering, the policy pre-filter, the settle-time re-check, accounting, the
// fill cap, and partial-fill accumulation — is validated deterministically
// without a signet cycle. The real claim/take path is exercised by the signet
// e2e; here we pin the control flow around it.
//
// Run: `node tests/watchtower-core.test.mjs`

import { runTick } from '../fulfiller/watchtower-core.mjs';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// A mock dapp: records claims/takes, serves a scripted intent list + fulfilments.
function mockDapp({ listIntents = [], fulfilFor = () => ({ partial_reveal: {}, enc_recipient_blinding: '' }), takeBehavior = () => ({ txid: 'aa'.repeat(32) }), satsBalance = 1_000_000 } = {}) {
  const calls = { claims: [], takes: [], cancels: [] };
  const dapp = {
    wallet: { priv: null, pub: null },
    async getUtxos() { return [{ value: satsBalance }]; },
    async claimAxferIntent({ intentIdHex }) { calls.claims.push(intentIdHex); },
    async fetchAxferFulfilment({ intentIdHex }) { return { fulfilment: fulfilFor(intentIdHex) }; },
    async takeAxferIntent({ intent }) { calls.takes.push(intent.intent_id); return takeBehavior(intent); },
    async cancelAxferClaim({ intentIdHex }) { calls.cancels.push(intentIdHex); },
    invalidateHoldingsCache() {},
  };
  return { dapp, calls };
}

// global fetch is monkeypatched per-test to serve the worker list + by-id.
const realFetch = globalThis.fetch;
function withFetch(listIntents, byId) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/atomic-intents\/[0-9a-f]+/.test(u)) {
      const id = u.match(/atomic-intents\/([0-9a-f]+)/)[1];
      return { ok: true, json: async () => ({ intent: byId ? byId(id) : (listIntents.find((i) => i.intent_id === id)) }) };
    }
    if (/\/atomic-intents\b/.test(u)) return { ok: true, json: async () => ({ intents: listIntents }) };
    throw new Error('unexpected fetch ' + u);
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

function baseCtx(dapp, over = {}) {
  return {
    dapp, workerBase: 'https://w', network: 'signet', assetId: 'ab'.repeat(32), decimals: 0,
    priv: new Uint8Array(32).fill(1), pub: new Uint8Array(33).fill(2), pubHex: '02'.repeat(33), h160: 'cd'.repeat(20),
    maxUnitPriceSats: 25, maxTotalFillBase: 1000n, claimFulfilTimeoutSec: 1, minBidWalletSats: 1000,
    dryRun: false, log: () => {}, ...over,
  };
}
const ask = (id, amount, price) => ({ intent_id: id, amount: String(amount), price_sats: price, expiry: 2_000_000_000 });

await test('takes an untargeted public ask within policy', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('aa'.repeat(16), 300, 6000)]); // 20 sats/unit ≤ 25
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 1 && calls.takes.length === 1 && state.filledBase === 300n;
});

await test('skips an ask over the unit-price ceiling (no claim)', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('aa'.repeat(16), 300, 9000)]); // 30 sats/unit > 25
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.claims.length === 0;
});

await test('skips an ask reserved for a different buyer', async () => {
  const { dapp, calls } = mockDapp();
  const other = { ...ask('aa'.repeat(16), 300, 6000), intended_buyer_h160: 'ff'.repeat(20) };
  withFetch([other]);
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.claims.length === 0;
});

await test('partial-fill accumulates across multiple asks toward the cap', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('11'.repeat(16), 300, 6000), ask('22'.repeat(16), 200, 4000)]); // both 20 sats/unit
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 2 && state.filledBase === 500n && calls.takes.length === 2;
});

await test('stops at the cap and refuses the chunk that would overshoot', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('11'.repeat(16), 800, 16000), ask('22'.repeat(16), 300, 6000)]); // 800 fits, +300 overshoots 1000
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  // 800 taken; the 300 chunk would make 1100 > 1000 cap → skipped by policy pre-filter (no claim).
  return state.filledBase === 800n && calls.takes.length === 1;
});

await test('settle-time re-check refuses + cancels when the by-id record is worse than listed', async () => {
  const { dapp, calls } = mockDapp();
  // listed at 20 sats/unit (passes pre-filter) but GET-by-id serves 60 sats/unit.
  const id = '33'.repeat(16);
  withFetch([ask(id, 300, 6000)], () => ({ intent_id: id, amount: '300', price_sats: 18000, expiry: 2_000_000_000 }));
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.cancels.length === 1 && state.filledBase === 0n
    && state.processed[id]?.refused === true;
});

await test('already-processed intents are not re-claimed', async () => {
  const { dapp, calls } = mockDapp();
  const id = '44'.repeat(16);
  withFetch([ask(id, 300, 6000)]);
  const state = { filledBase: 0n, processed: { [id]: { txid: 'old' } } };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.claims.length === 0;
});

await test('idles (no claim) when the bid wallet is below the minimum', async () => {
  const { dapp, calls } = mockDapp({ satsBalance: 500 });
  withFetch([ask('55'.repeat(16), 300, 6000)]);
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.idle === true && calls.claims.length === 0;
});

await test('reports capped when already at the fill cap', async () => {
  const { dapp } = mockDapp();
  withFetch([]);
  const state = { filledBase: 1000n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.capped === true && r.fills === 0;
});

await test('binds the dapp wallet to the bid key before acting', async () => {
  const { dapp } = mockDapp();
  withFetch([ask('66'.repeat(16), 300, 6000)]);
  const ctx = baseCtx(dapp);
  await runTick(ctx, { filledBase: 0n, processed: {} });
  restoreFetch();
  return dapp.wallet.priv === ctx.priv && dapp.wallet.pub === ctx.pub;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
