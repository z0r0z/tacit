// The production esplora fee adapter behind a capped reverse quote: ordinary callers keep stale fallback, but a new sale cannot use
// that fallback when the current explorers are down. A later fresh answer reopens quoting.
//   node tests/fastbridge-reverse-fee-adapter.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { makeReverseService } from '../dapp/fastbridge-reverse-provider.js';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { startEsploraMock } from './lib/esplora-mock.mjs';
import { memStore } from './lib/fastbridge-world.mjs';

const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });

async function run() {
  const estimates = { 3: 2 };
  let broken = false;
  const mock = await startEsploraMock({ sim: {}, feeEstimates: estimates, fail: (p) => broken && p === '/fee-estimates' });
  try {
    const clock = { t: 1_000_000 };
    const chain = makeEsploraBtcChain({ bases: [mock.base], prims, builder: null, fetchImpl: realFetch, nowMs: () => clock.t, feeFreshMs: 1000, feeStaleMs: 60_000 });
    const reads = () => mock.state.gets.filter((p) => p === '/fee-estimates').length;
    assert.equal(await chain.feeRate(), 2, 'the production adapter seeds its cache from the explorer');
    clock.t += 5000; broken = true;
    assert.equal(await chain.feeRate(), 2, 'an ordinary caller still gets the aged estimate when the refresh fails');
    clock.t += 15_001;

    const swaps = memStore();
    const service = makeReverseService({
      seed: new Uint8Array(32).fill(8),
      btc: { wallet: { pub: prims.wallet.pub, xonly: prims.wallet.xonly }, feeRate: chain.feeRate }, evm: {},
      swaps, quotes: memStore(), offers: memStore(), evmOffers: memStore(),
      inventory: { notes: async () => [{ txid: '11'.repeat(32), vout: 0, value: 546, amount: 5000n, blinding: 1n }] },
      now: () => Math.floor(clock.t / 1000),
      config: {
        quote: { btcAsset: 'aa'.repeat(32), evmAsset: 'bb'.repeat(32), minAmount: 1000n, maxAmount: 1_000_000n, feeBps: 30, flatFee: 200n, validSecs: 600 },
        csvBlocks: 96, evmWindowSecs: 4 * 3600, maxOpen: 2, maxFeeRate: 3, minConfsFor: () => 1, refreshSecs: 0,
      },
    });
    const quote = () => service.handle({ method: 'POST', path: '/reverse/quote', body: { amount: '3000', claimPub: bytesToHex(prims.wallet.pub) } });
    const refused = await quote();
    assert.equal(refused.status, 503, 'a capped reverse quote cannot use the stale fallback');
    assert.equal(refused.body.retry, true); assert.match(refused.body.error, /cannot read the current Bitcoin fee rate/);
    assert.equal(service.health.feeRateOk, false); assert.equal(service.health.feeRate, null);
    assert.equal(reads(), 3, 'the capped check made its own fresh read after the ordinary stale fallback');
    assert.deepEqual(await swaps.list(), [], 'the refused quote made no swap');

    clock.t += 15_001; broken = false; estimates[3] = 3;
    const accepted = await quote();
    assert.equal(accepted.status, 200, 'a fresh answer at the ceiling reopens quoting');
    assert.equal(service.health.feeRateOk, true); assert.equal(service.health.feeRate, 3);
    const info = await service.info();
    assert.equal(info.health.feeRateOk, true); assert.equal(info.health.feeRate, 3);
  } finally { await mock.close(); }
}

try { await run(); console.log('  ok - capped reverse quotes require a fresh adapter estimate while ordinary callers keep stale fallback'); }
catch (e) { console.log(`  FAIL - capped reverse fee adapter\n${e.stack}`); process.exitCode = 1; }
console.log(`\n${process.exitCode ? 0 : 1}/1 reverse fee-adapter checks passed`);
process.exit(process.exitCode || 0);
