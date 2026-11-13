// The wallet's cBTC locks, recovered from its Bitcoin history alone (dapp/confidential-recovery-btc.js locks()).
//   node tests/btc-history-locks.test.mjs
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha256';
import { makeBtcHistoryProvider } from '../dapp/confidential-recovery-btc.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const hex = (b) => Buffer.from(b).toString('hex');
const priv = 'c0ffee'.padEnd(64, '1');

// Esplora stub: the lock script's history (newest first, as esplora serves it) and the commit transactions.
function esplora(pages) {
  return async (url) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    const body = pages[path];
    return body === undefined ? { ok: false, status: 404 } : { ok: true, json: async () => body };
  };
}

await test('every lock above the dust band comes back oldest first, with its blinding anchor, and a payment that is not a reveal\'s is not one', async () => {
  const probe = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) });
  const spk = probe.walletScripts(priv).lock, lock = hex(spk), h = hex(sha256(spk));
  const out = (value) => ({ scriptpubkey: lock, value });
  const other = { scriptpubkey: '0014' + '00'.repeat(20), value: 5000 };
  const commit = { scriptpubkey: '5120' + '11'.repeat(32), scriptpubkey_type: 'v1_p2tr' }, wallet = { scriptpubkey: '0014' + '22'.repeat(20), scriptpubkey_type: 'v0_p2wpkh' };
  const txs = [
    { txid: 'e1'.repeat(32), vin: [{ txid: 'c8'.repeat(32), vout: 0, prevout: wallet }], vout: [other, out(40000)], status: { block_time: 2600 } },   // a plain payment to the same script
    { txid: 'e0'.repeat(32), vin: [{ txid: 'c7'.repeat(32), vout: 0, prevout: commit }], vout: [out(50000), other], status: { block_time: 2500 } },   // at output 0, where a lock never is
    { txid: 'b2'.repeat(32), vin: [{ txid: 'c2'.repeat(32), vout: 0, prevout: commit }], vout: [other, out(30000)], status: { block_time: 2000 } },
    { txid: 'd0'.repeat(32), vin: [{ txid: 'c9'.repeat(32), vout: 0, prevout: commit }], vout: [other, out(330)], status: { block_time: 1500 } },   // a Tacit note, not a lock
    { txid: 'b1'.repeat(32), vin: [{ txid: 'c1'.repeat(32), vout: 0, prevout: commit }], vout: [other, out(20000)], status: { block_time: 1000 } },
  ];
  const p = makeBtcHistoryProvider({
    sha256, bases: ['https://esplora.test/api'],
    fetchImpl: esplora({
      [`/scripthash/${h}/txs`]: txs,
      [`/tx/${'c1'.repeat(32)}`]: { vin: [{ txid: 'a1'.repeat(32), vout: 3 }] },
      [`/tx/${'c2'.repeat(32)}`]: { vin: [{ txid: 'a2'.repeat(32), vout: 1 }] },
    }),
  });
  const locks = await p.locks(priv);
  assert.deepEqual(locks.map((l) => [l.lockTxid.slice(0, 4), l.lockVout, l.vBtc, l.anchor.txid.slice(0, 4), l.anchor.vout]), [
    ['b1b1', 1, '20000', 'a1a1', 3],
    ['b2b2', 1, '30000', 'a2a2', 1],
  ]);
  assert.equal(locks[0].at, 1_000_000);
});

await test('a key with no locks has none', async () => {
  const probe = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) });
  const h = hex(sha256(probe.walletScripts(priv).lock));
  const p = makeBtcHistoryProvider({ sha256, bases: ['https://esplora.test/api'], fetchImpl: esplora({ [`/scripthash/${h}/txs`]: [] }) });
  assert.deepEqual(await p.locks(priv), []);
});

// A script's history of `count` confirmed transactions, newest first, served in esplora's pages of 25, and every path asked.
function paged(h, count) {
  const txs = Array.from({ length: count }, (_, i) => ({ txid: (count - i).toString(16).padStart(64, '0'), vin: [], vout: [], status: { confirmed: true, block_height: count - i } }));
  const asked = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    asked.push(path);
    let from = 0;
    const m = /\/txs\/chain\/([0-9a-f]{64})$/.exec(path);
    if (m) from = txs.findIndex((t) => t.txid === m[1]) + 1;
    else if (path !== `/scripthash/${h}/txs`) return { ok: false, status: 404 };
    return { ok: true, json: async () => txs.slice(from, from + 25) };
  };
  return { txs, asked, fetchImpl, add: (t) => txs.unshift(t) };
}
const memStore = () => { const m = new Map(); return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); } }; };
const settle = () => new Promise((r) => setTimeout(r, 0));

await test('a kept history is read again only down to the newest transaction it holds', async () => {
  const spk = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) }).walletScripts(priv).lock, h = hex(sha256(spk));
  const chain = paged(h, 30), store = memStore();
  const p = makeBtcHistoryProvider({ sha256, bases: ['https://kept.test/api'], fetchImpl: chain.fetchImpl, store });
  assert.equal((await p.txsOf(spk)).length, 30);
  assert.equal(chain.asked.length, 2, 'the first walk reads both pages');
  await settle();
  chain.add({ txid: 'ff'.repeat(32), vin: [], vout: [], status: { confirmed: true, block_height: 31 } });
  chain.asked.length = 0;
  const again = await p.txsOf(spk);
  assert.deepEqual(chain.asked, [`/scripthash/${h}/txs`], 'the next reads one page');
  assert.equal(again.length, 31);
  assert.deepEqual(again.slice(0, 2).map((t) => t.txid), ['ff'.repeat(32), (30).toString(16).padStart(64, '0')], 'newest first, the new one ahead of what was kept');
});

await test('a walk stopped by its page cap keeps what it read, and the next carries on from there', async () => {
  const spk = makeBtcHistoryProvider({ sha256, fetchImpl: async () => ({ ok: false }) }).walletScripts(priv).lock, h = hex(sha256(spk));
  const chain = paged(h, 70), store = memStore();
  const p = makeBtcHistoryProvider({ sha256, bases: ['https://capped.test/api'], fetchImpl: chain.fetchImpl, store, maxPages: 2 });
  await assert.rejects(p.txsOf(spk), /page cap/, 'still refuses a cut-off history');
  await settle();
  chain.asked.length = 0;
  const all = await p.txsOf(spk);
  assert.equal(all.length, 70);
  assert.deepEqual(all.map((t) => t.status.block_height), Array.from({ length: 70 }, (_, i) => 70 - i), 'whole, in order');
  assert.equal(chain.asked.length, 2, 'the top page, then on from where the first walk stopped');
  assert.ok(chain.asked[1].endsWith(`/txs/chain/${(21).toString(16).padStart(64, '0')}`));
});

await test('a mirror that rate-limits, or answers a 200 that is not JSON, is asked last on the next read', async () => {
  for (const [busy, calm, answer] of [
    ['limited.test', 'calm-a.test', { ok: false, status: 429 }],
    ['texty.test', 'calm-b.test', { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token R'); } }],
  ]) {
    const order = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      order.push(u.hostname);
      return u.hostname === busy ? answer : { ok: true, json: async () => [] };
    };
    const p = makeBtcHistoryProvider({ sha256, bases: [`https://${busy}/api`, `https://${calm}/api`], fetchImpl });
    await p.locks(priv);
    assert.deepEqual(order, [busy, calm], `${busy}: passed over for the next mirror`);
    await p.locks(priv);
    assert.deepEqual(order.slice(2), [calm], `${busy}: and on the next read the mirror that answered goes first`);
  }
});

console.log(`${n} passed`);
