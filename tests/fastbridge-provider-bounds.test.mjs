// What a provider keeps within bounds: the transactions one reservation looks at, the quotes it keeps, and the order of an offer's checks (the cheap ones
// before the walk of a note's history).
//   node tests/fastbridge-provider-bounds.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { memStore } from './lib/fastbridge-world.mjs';
import { pairWorld, SATS } from './lib/pair-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const hex64 = (i) => i.toString(16).padStart(64, '0');
const post = (w, path, body) => w.fwd.handle({ method: 'POST', path, body });

async function funded(opts = {}) {
  const w = pairWorld(opts);
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount * 50n, 'inv0');
  return w;
}

test('one reservation looks at a limited number of transactions, and asking again for the one it holds is answered without a look', async () => {
  const w = await funded();
  let looks = 0;
  const fetchTx = w.lBtc.fetchTx;
  w.lBtc.fetchTx = async (txid) => { looks++; return fetchTx(txid); };
  const q = (await post(w, '/quote', { amount: String(SATS) })).body;
  assert.equal((await post(w, '/reserve', { quoteId: q.id })).body.ok, true);
  for (let i = 1; i <= 20; i++) assert.match((await post(w, '/extend', { quoteId: q.id, txid: hex64(i) })).body.why, /not visible yet/);
  assert.equal(looks, 20);
  const more = (await post(w, '/extend', { quoteId: q.id, txid: hex64(99) })).body;
  assert.equal(more.ok, false);
  assert.match(more.why, /looked at enough transactions/);
  assert.equal(looks, 20, 'and no explorer was asked for it');
});

test('a provider holds a bounded number of quotes: when the store is full, dead ones are freed sooner, and a quote is refused while it stays full', async () => {
  const m = memStore();
  const store = { ...m, del: async (id) => { m.m.delete(id); } };
  const w = await funded({ fwdQuoteStore: store, fwdPolicy: { maxQuotes: 3 } });
  await w.fwd.tick();                                              // counts what the store holds: nothing
  for (let i = 0; i < 3; i++) assert.ok((await post(w, '/quote', { amount: String(SATS) })).body.id);
  const full = await post(w, '/quote', { amount: String(SATS) });
  assert.equal(full.status, 503);
  assert.match(full.body.error, /too many open quotes/);
  // the quotes live out their validity and the longest an offer is answered after it: then a look frees them and quoting goes on
  w.clock.advance(600 + 21600 + 3600 + 10);
  await w.providerFeed.refresh();
  await w.fwd.tick();
  assert.equal((await store.list()).length, 0);
  assert.ok((await post(w, '/quote', { amount: String(SATS) })).body.id);
});

test('an offer whose lock does not pay the take is refused before the history of its note is walked, and one that arrived too late the same', async () => {
  const lp = makeBtcWallet({ priv: bigintToBytes32(12345n) }).prims;
  let walked = 0, now = 1_800_000_000;
  const txid = 'ab'.repeat(32), noteAsset = '11'.repeat(32), quote = { id: 'q1', btcValue: '1000', evmAmount: '990', btcAsset: noteAsset, evmAsset: '22'.repeat(32), validUntil: now + 600, takeSats: 3000 };
  const mk = (tx, blockAt) => makeEthereumLocker({
    seed: new Uint8Array(32).fill(5), now: () => now, store: memStore(),
    policy: { minAmount: 1, maxAmount: 10 ** 9, minCsv: 72, maxOfferAgeSecs: 3600 },
    quotes: { get: async () => quote },
    btc: {
      prims: lp, wallet: { pub: lp.wallet.pub, priv: lp.wallet.priv, xonly: lp.wallet.xonly() },
      fetchTx: async () => tx, status: async () => ({ confirmations: 3, height: 100 }), blockTime: async () => blockAt,
      resolveNote: async () => { walked++; throw new Error('walked'); }, crossLaneBlocked: async () => null, outspend: async () => null,
    },
    evm: {}, counter: {},
  });
  const offer = { swapId: 'cd'.repeat(36), btc: { txid, vout: 0, value: '1000', asset: noteAsset, csvBlocks: 144 }, evm: { amount: '990' } };
  const noTake = { vin: [{ txid: 'ee'.repeat(32), vout: 0 }, { txid: 'ff'.repeat(32), vout: 1 }], vout: [{ value: 546, scriptpubkey: '5120' + '00'.repeat(32) }] };
  const r1 = await mk(noTake, now - 60).receive({ quoteId: 'q1', offer });
  assert.equal(r1.ok, false);
  assert.match(r1.why, /does not pay the fee of the take/);
  const r2 = await mk(noTake, now - 7200).receive({ quoteId: 'q1', offer });
  assert.match(r2.why, /arrived too late/);
  assert.equal(walked, 0, 'no history was walked for either');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} provider bound checks passed`);
process.exit(process.exitCode || 0);
