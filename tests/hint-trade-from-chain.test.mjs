// POST /assets/hint records a settled trade's price and amount as the chain gives them, never as the request says, and reads an etch at
// output 0 only. The derivation is held to the cron's own records, a trade the chain does not say sets no price, and a chain that cannot be read
// is an error (so the hint defers to the scan). The handler is held to not reading the request's figures.
//   node tests/hint-trade-from-chain.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { _deriveTradeFromChain, atomicIntentOutpointIndexKey, atomicIntentKey, preauthOutpointIndexKey, preauthSaleKey, T_AXFER } from '../worker/src/index.js';

const NETWORK = 'signet', ASSET = 'aa'.repeat(32), SELLER = { txid: '11'.repeat(32), vout: 0 }, COMMIT = '33'.repeat(32), REVEAL = '44'.repeat(32);
const store = new Map();
const kv = { get: async (k, t) => { const v = store.get(k); if (v === undefined) return null; return t === 'json' ? (typeof v === 'string' ? JSON.parse(v) : v) : (typeof v === 'string' ? v : JSON.stringify(v)); }, put: async (k, v) => { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); }, delete: async (k) => { store.delete(k); } };
let chain = new Map(), down = false;
globalThis.fetch = async (url) => {
  if (down) throw new TypeError('fetch failed');
  const m = String(url).match(/\/tx\/([0-9a-f]{64})$/i);
  if (m && chain.has(m[1])) return { ok: true, status: 200, json: async () => chain.get(m[1]) };
  return { ok: false, status: 404, text: async () => 'not found' };
};
const reveal = { txid: REVEAL, vin: [{ txid: COMMIT, vout: 0 }], vout: [{ scriptpubkey: '5120' + '01'.repeat(32) }], status: { block_time: 1_700_000_000 } };
chain.set(COMMIT, { txid: COMMIT, vin: [{ txid: SELLER.txid, vout: SELLER.vout }], vout: [{ scriptpubkey: '5120' + '00'.repeat(32), value: 1000 }], status: { block_time: 1_700_000_000 } });
const env = { REGISTRY_KV: kv };
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

// a sale the chain's spent outpoint matches
const SALE = 'ab'.repeat(16);
await kv.put(preauthSaleKey(NETWORK, ASSET, SALE), { asset_id: ASSET, sale_id: SALE, asset_outpoint: SELLER, asset_opening: { amount: '500', blinding: '00'.repeat(32) }, min_price_sats: 12345 });
await kv.put(preauthOutpointIndexKey(NETWORK, ASSET, SELLER.txid, SELLER.vout), SALE);
const t = await _deriveTradeFromChain(env, NETWORK, reveal, T_AXFER, ASSET);
ok(t && t.price_sats === 12345 && t.amount === 500n && t.fills.length === 1, 'the trade is the sale record the spent outpoint matches (12,345 sats for 500)');

// nothing backs the outpoint: the chain does not say
store.clear();
ok((await _deriveTradeFromChain(env, NETWORK, reveal, T_AXFER, ASSET)) === null, 'a transfer no listing or bid backs gives no trade, so it sets no price');

// the chain cannot be read: an error, which the hint takes as a reason to leave it to the scan
down = true;
const err = await _deriveTradeFromChain(env, NETWORK, reveal, T_AXFER, ASSET).then(() => null, (e) => e);
ok(err instanceof Error, 'a chain that cannot be read is an error, not "nothing to derive"');
down = false;

// the handler: no figure from the request reaches a recorded trade, an etch is read at output 0
const src = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const a = src.indexOf('async function handleAssetHint('), b = src.indexOf('\nasync function ', a + 10), handler = src.slice(a, b);
ok(!/body\.price_sats|body\.amount|body\.fill_count/.test(handler), 'the hint handler reads no price, amount or fill count from the request');
ok(/_deriveTradeFromChain\(/.test(handler) && /source: 'hint-chain'/.test(handler), 'it records the trade the chain derives');
ok((handler.match(/an etch is read at output 0/g) || []).length === 2, 'both kinds of etch are refused at an output other than 0');
console.log(`${n} ok`);
process.exit(0);
