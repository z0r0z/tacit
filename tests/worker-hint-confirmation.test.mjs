// Asset hints may observe a transaction while it is only in one explorer's
// mempool. Such a transaction can later be evicted or replaced, so it must not
// create a durable xferseen marker or trade-history entry before confirmation.

import assert from 'node:assert/strict';
import {
  _shouldPersistAssetHint, _removePhantomTrade,
  tradeEventKey, tradesRingKey, tradeDayKey, tradeLifetimeKey, _utcYyyymmdd,
} from '../worker/src/index.js';

assert.equal(
  _shouldPersistAssetHint(false),
  false,
  'an unconfirmed mempool hint must remain optimistic-only',
);

assert.equal(
  _shouldPersistAssetHint(true),
  true,
  'a confirmed hint may update durable transfer and trade state',
);

assert.equal(
  _shouldPersistAssetHint(undefined),
  false,
  'missing confirmation status must fail closed',
);

console.log('worker hint confirmation: 3 checks passed');

function kvStub(entries) {
  const data = new Map(entries);
  return {
    async get(key, type) {
      const value = data.get(key);
      if (value == null) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    data,
  };
}

const network = 'mainnet';
const aid = 'aa'.repeat(32);
const txid = 'bb'.repeat(32);
const ts = 1_795_000_000;
const trade = { txid, price_sats: 627, amount: '19', ts };
const seenKey = `xferseen:${network}:${aid}:${txid}`;
const countKey = `xfercnt:${network}:${aid}`;
const lastKey = `lasttrade:${network}:${aid}`;
const kv = kvStub([
  [tradeEventKey(network, aid, txid), JSON.stringify(trade)],
  [tradesRingKey(network, aid), JSON.stringify([trade, { ...trade, txid: 'cc'.repeat(32) }])],
  [tradeDayKey(network, aid, _utcYyyymmdd(ts)), '1000'],
  [tradeLifetimeKey(network, aid), '5000'],
  [seenKey, '1'],
  [countKey, '9'],
  [lastKey, JSON.stringify(trade)],
]);

const repaired = await _removePhantomTrade({ REGISTRY_KV: kv }, network, aid, txid);
assert.equal(repaired.removed, true);
assert.equal(kv.data.has(tradeEventKey(network, aid, txid)), false);
assert.equal(JSON.parse(kv.data.get(tradesRingKey(network, aid))).some(t => t.txid === txid), false);
assert.equal(kv.data.get(tradeLifetimeKey(network, aid)), '4373');
assert.equal(kv.data.get(tradeDayKey(network, aid, _utcYyyymmdd(ts))), '373');
assert.equal(kv.data.get(countKey), '8');
assert.equal(kv.data.has(seenKey), false);
assert.equal(JSON.parse(kv.data.get(lastKey)).txid, 'cc'.repeat(32));

console.log('worker phantom repair: 8 checks passed');
