// The phantom sweep (worker/src/index.js sweepPreauthPhantoms) forgets a listing whose note has been spent. A spend that is a TAKE is a trade, and the sweep used to
// forget it without recording it: the listing record is what prices the trade, and a buyer that sends no /hint (a script) leaves nothing else to learn it from, so three
// fills on mainnet (2026-11-22) never appeared in the price history. Now the sweep records the trade first, counted
// through the gate the hint and the scan share, and forgets a spend that is no fill (the seller moving their own note) as it always did.
// The transactions are the real ones (tests/fixtures/preauth-fills-2026-11-22.json).
//   node tests/preauth-sweep-records-fills.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { sweepPreauthPhantoms, preauthOutpointIndexKey, preauthSaleKey } from '../worker/src/index.js';

const NETWORK = 'mainnet', ASSET = 'aa'.repeat(32);
const fills = JSON.parse(readFileSync(new URL('./fixtures/preauth-fills-2026-11-22.json', import.meta.url), 'utf8')).fills;
const [F1, F2] = fills;
const store = new Map();
const kv = {
  get: async (k, t) => { const v = store.get(k); if (v === undefined) return null; return t === 'json' ? (typeof v === 'string' ? JSON.parse(v) : v) : (typeof v === 'string' ? v : JSON.stringify(v)); },
  put: async (k, v) => { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  delete: async (k) => { store.delete(k); },
  list: async ({ prefix = '', limit = 1000, cursor = null } = {}) => {
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0, page = all.slice(from, from + limit);
    return { keys: page.map((name) => ({ name })), list_complete: from + limit >= all.length, cursor: from + limit >= all.length ? undefined : String(from + limit) };
  },
};
const env = { REGISTRY_KV: kv };
const txs = new Map(), broken = new Set(), outspends = new Map();
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
globalThis.fetch = async (url) => {
  const u = String(url);
  let m = u.match(/\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/i);
  if (m) return res(200, outspends.get(`${m[1]}:${m[2]}`) || { spent: false });
  m = u.match(/\/tx\/([0-9a-f]{64})$/i);
  if (m && broken.has(m[1])) return res(500, 'upstream error');
  if (m && txs.has(m[1])) return res(200, txs.get(m[1]));
  return res(404, 'not found');
};
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

const CNT = `cnt:presale:${NETWORK}:${ASSET}`, seen = (txid) => `xferseen:${NETWORK}:${ASSET}:${txid}`;
const events = () => [...store.keys()].filter((k) => k.includes('trade-event'));
const ring = () => { const k = [...store.keys()].find((x) => /trades-ring|tradesring|trades:ring|ring/i.test(x) && x.includes(ASSET)); return k ? JSON.parse(store.get(k)) : null; };
const seed = async (f, over = {}) => {
  await kv.put(preauthSaleKey(NETWORK, ASSET, f.sale_id), { asset_id: ASSET, sale_id: f.sale_id, asset_outpoint: f.note, asset_opening: { amount: f.amount, blinding: '00'.repeat(32) }, min_price_sats: f.price_sats, seller_payout_script: f.reveal.vout[1].scriptpubkey, expiry: 4_000_000_000, ...over });
  await kv.put(preauthOutpointIndexKey(NETWORK, ASSET, f.note.txid, f.note.vout), f.sale_id);
};
const spentBy = (f, spender = f.reveal.txid, confirmed = true) => outspends.set(`${f.note.txid}:${f.note.vout}`, { spent: true, txid: spender, vin: 1, status: confirmed ? { confirmed: true, block_height: 977050 } : { confirmed: false } });
const world = () => { store.clear(); txs.clear(); broken.clear(); outspends.clear(); for (const f of fills) { txs.set(f.reveal.txid, f.reveal); txs.set(f.commit.txid, f.commit); } };
const hasSale = (f) => store.has(preauthSaleKey(NETWORK, ASSET, f.sale_id));
const hasIndex = (f) => store.has(preauthOutpointIndexKey(NETWORK, ASSET, f.note.txid, f.note.vout));
const tick = () => new Promise((r) => setTimeout(r, 15));

// 1. a take: the trade is recorded, then the listing goes
world(); await seed(F1); store.set(CNT, '1'); spentBy(F1);
let r = await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(r.probed === 1 && r.deleted === 1, `the sweep probed the listing and dealt with it (${JSON.stringify(r)})`);
ok(!hasSale(F1) && !hasIndex(F1), 'the listing and its outpoint index are gone');
ok(events().length === 1, 'a trade-event journal entry was written');
const ev = JSON.parse(store.get(events()[0]));
ok(ev.price_sats === 1158275 && ev.amount === '100000000000' && ev.source === 'sweep-chain' && ev.fill_count === 1, `it says 1,158,275 sats for 1,000 TAC (${JSON.stringify(ev)})`);
ok(store.has(seen(F1.reveal.txid)), 'the reveal is marked counted, so the hint and the scan will not count it again');
ok(store.get(CNT) === '0', `the listing count fell once (${store.get(CNT)})`);
const rg = ring();
ok(rg && JSON.stringify(rg).includes(F1.reveal.txid.slice(0, 16)), 'the recent-trades ring holds the trade');

// 2. a second sweep, or the scan arriving later, adds nothing
r = await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(events().length === 1 && store.get(CNT) === '0', 'a second sweep records nothing more and moves no count');

// 3. the hint (or the scan) counted the reveal first: the records still go, the trade is not counted twice
world(); await seed(F1); store.set(CNT, '1'); store.set(seen(F1.reveal.txid), '1'); spentBy(F1);
await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(!hasSale(F1) && !hasIndex(F1) && events().length === 0, 'a reveal already counted: the listing goes and no second trade is written');

// 4. the seller moving their own note is no trade: dropped as a phantom, as always
world(); await seed(F1); store.set(CNT, '1');
const move = { txid: 'bb'.repeat(32), vin: [{ txid: F1.note.txid, vout: F1.note.vout, witness: ['30' + '44'.repeat(35), '02' + '11'.repeat(32)] }], vout: [{ scriptpubkey: '0014' + 'ab'.repeat(20), value: 546 }], status: { confirmed: true, block_height: 977051 } };
txs.set(move.txid, move); spentBy(F1, move.txid);
await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(!hasSale(F1) && !hasIndex(F1) && events().length === 0 && !store.has(seen(move.txid)), 'a plain spend of the note (a retraction) drops the listing and records no trade');
ok(store.get(CNT) === '0', 'and the count falls once there too');

// 5. a tacit reveal that does not pay the seller is no fill either
world(); await seed(F1); store.set(CNT, '1');
const unpaid = { ...F1.reveal, txid: 'cc'.repeat(32), vout: F1.reveal.vout.map((o, i) => (i === 1 ? { ...o, value: 1000 } : o)) };
txs.set(unpaid.txid, unpaid); spentBy(F1, unpaid.txid);
await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(!hasSale(F1) && events().length === 0, 'a reveal that pays the seller under the price drops the listing and records no trade');

// 6. the spender cannot be read just now: the listing stays, and the next sweep records the trade
world(); await seed(F1); store.set(CNT, '1'); spentBy(F1); broken.add(F1.reveal.txid);
r = await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(hasSale(F1) && hasIndex(F1) && events().length === 0, 'a spender that cannot be read leaves the listing for the next sweep (no trade is lost to a blip)');
broken.delete(F1.reveal.txid);
// the worker rests an explorer that answered 5xx for 15 s (its per-isolate circuit breaker); the next cron tick is minutes later, so move the clock past it
const realNow = Date.now; Date.now = () => realNow() + 60_000;
await sweepPreauthPhantoms(env, NETWORK); await tick();
Date.now = realNow;
ok(!hasSale(F1) && events().length === 1, 'and once it can be read the trade is recorded and the listing goes');

// 7. an unspent note is left alone; a spend with no spender named is dropped as before
world(); await seed(F1);
await sweepPreauthPhantoms(env, NETWORK);
ok(hasSale(F1) && hasIndex(F1) && events().length === 0, 'an unspent note keeps its listing');
outspends.set(`${F1.note.txid}:${F1.note.vout}`, { spent: true, status: { confirmed: true, block_height: 977050 } });
await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(!hasSale(F1) && events().length === 0, 'a spend whose spender the chain does not name is dropped as a phantom, as before');

// 8. a batched take: one trade for the two lots, both listings gone though the sweep reaches the second after the first
world(); await seed(F1); await seed(F2); store.set(CNT, '2');
const batch = { ...F1.reveal, txid: 'ee'.repeat(32), vin: [F1.reveal.vin[0], F1.reveal.vin[1], F2.reveal.vin[1]], vout: [F1.reveal.vout[0], F1.reveal.vout[1], F2.reveal.vout[1]] };
txs.set(batch.txid, batch); spentBy(F1, batch.txid); spentBy(F2, batch.txid);
await sweepPreauthPhantoms(env, NETWORK); await tick();
ok(!hasSale(F1) && !hasSale(F2) && !hasIndex(F1) && !hasIndex(F2), 'both lots of a batched take leave the book');
const bev = events().map((k) => JSON.parse(store.get(k)));
ok(bev.length === 1 && bev[0].price_sats === 1158275 + 1193023 && bev[0].fill_count === 2, `and it is one trade of both fills (${JSON.stringify(bev)})`);
ok(store.get(CNT) === '0', `the count fell by two, once each (${store.get(CNT)})`);

// 9. one take of two notes pays only one of the sellers: the paid lot is a trade and the unpaid note is a phantom, whichever the sweep reaches first
for (const [paid, unpaidLot, label] of [[F2, F1, 'second lot paid'], [F1, F2, 'first lot paid']]) {
  world(); await seed(F1); await seed(F2); store.set(CNT, '2');
  const pay = (f) => f.reveal.vout[1];
  const half = { ...F1.reveal, txid: 'dd'.repeat(32), vin: [F1.reveal.vin[0], F1.reveal.vin[1], F2.reveal.vin[1]],
    vout: [F1.reveal.vout[0], paid === F1 ? pay(F1) : { ...pay(F1), value: 1000 }, paid === F2 ? pay(F2) : { ...pay(F2), value: 1000 }] };
  txs.set(half.txid, half); spentBy(F1, half.txid); spentBy(F2, half.txid);
  await sweepPreauthPhantoms(env, NETWORK); await tick();
  const hev = events().map((k) => JSON.parse(store.get(k)));
  ok(!hasSale(F1) && !hasSale(F2) && !hasIndex(F1) && !hasIndex(F2), `a take that pays one of two sellers leaves neither listing behind (${label})`);
  ok(hev.length === 1 && hev[0].price_sats === paid.price_sats && hev[0].fill_count === 1, `and records only the paid lot, ${paid.price_sats} sats (${label}: ${JSON.stringify(hev)})`);
  ok(store.get(CNT) === '0', `with the count fallen by two (${label}: ${store.get(CNT)})`);
}

console.log(`${n} ok`);
process.exit(0);
