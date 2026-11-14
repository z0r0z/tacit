// The worker's bound offers (worker/src/bound-offers.js), through the real fetch handler over the in-memory KV the Render server
// uses: the POST flag gate, the offer's shape, the seller's signature (the same message the dapp signs, dapp/bound-swap.js), the
// bid it answers (an active BOUND watchtower bid of this asset, its key, its remaining amount and unit price), the list, the
// seller's cancel and the watchtower's fill report.
//   node tests/worker-bound-offers.test.mjs
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv } from '../server/harness.mjs';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex } from '@noble/hashes/utils';
import * as wbo from '../worker/src/bound-offers.js';
import * as bs from '../dapp/bound-swap.js';
import { signSchnorr } from '../dapp/bulletproofs.js';

globalThis.caches = createCacheStorage({ maxBytes: 32 * 1024 * 1024 });
const worker = (await import('../worker/src/index.js')).default;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const ctx = { waitUntil: () => {} };
const NET = 'signet';
async function call(env, method, path, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const resp = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  let json; try { json = JSON.parse(await resp.text()); } catch { json = {}; }
  return { status: resp.status, json };
}
const key = (b) => new Uint8Array(32).fill(b);
const pubOf = (k) => bytesToHex(secp.getPublicKey(k, true));
const sign = async (msg, k) => bytesToHex(signSchnorr(msg, k));
const h160 = (hex) => bytesToHex(ripemd160(sha256(Buffer.from(hex, 'hex'))));

const OWNER = key(7), BIDK = key(9), SELLER = key(11), OTHERK = key(13);
const OWNER_PUB = pubOf(OWNER), BID_PUB = pubOf(BIDK), SELLER_PUB = pubOf(SELLER);
const ASSET = 'ab'.repeat(32), BID_ID = 'cd'.repeat(16), NOW = Math.floor(Date.now() / 1000);
const env = buildEnv(createMemDriver(), { extra: { BOUND_OFFERS_ENABLED: 'true', WATCHTOWER_REGISTER_ENABLED: 'true' } });
const offEnv = buildEnv(createMemDriver(), { extra: {} });
const seedBid = async (e, over = {}) => e.REGISTRY_KV.put(`wtbid:${NET}:${h160(OWNER_PUB)}:${over.bid_id || BID_ID}`, JSON.stringify({
  network: NET, bid_id: BID_ID, asset_id: ASSET, owner_pubkey: OWNER_PUB, bid_pubkey: BID_PUB, enc_bid_privkey: 'ef'.repeat(32), bid_price_sats: 50000, bid_amount_base: '1000',
  decimals: 8, funding_outpoint: { txid: '11'.repeat(32), vout: 0 }, expiry: NOW + 3600, kind: 'bound', status: 'active', filled_base: '0', created_at: NOW, ...over }));
await seedBid(env);

const sx = SELLER_PUB.slice(2), bx = BID_PUB.slice(2);
const offerOf = (over = {}) => ({
  v: 1, kind: 'taproot', assetId: ASSET, chainBinding: '22'.repeat(32), amount: '400', priceSats: 20000, sellerPub: SELLER_PUB, sellerXonly: sx, buyerXonly: bx,
  note: { txid: '33'.repeat(32), vout: 0, value: 546, script: '5120' + sx }, payload: '39' + '00'.repeat(120), noteScripts: ['5120' + bx, '5120' + sx],
  payoutScript: '5120' + '44'.repeat(32), witness: ['55'.repeat(64) + '81'], ...over,
});
const posted = async (o, { k = SELLER, bid = BID_ID, owner = OWNER_PUB, expiry = NOW + 1800, e = env } = {}) => call(e, 'POST', `/assets/${ASSET}/bound-offers?network=${NET}`,
  { offer: o, bid_id: bid, owner_pubkey: owner, expiry, sig: await sign(wbo.boundOfferMsg(NET, o, bid, expiry), k) });

// the dapp signs the same message the worker checks
{
  const o = offerOf();
  ok(bytesToHex(wbo.boundOfferMsg(NET, o, BID_ID, 123)) === bytesToHex(bs.boundOfferMsg(NET, o, BID_ID, 123))
    && bytesToHex(wbo.boundOfferCancelMsg(NET, ASSET, 'aa')) === bytesToHex(bs.boundOfferCancelMsg(NET, ASSET, 'aa'))
    && bytesToHex(wbo.boundOfferFilledMsg(NET, ASSET, 'aa', 'bb')) === bytesToHex(bs.boundOfferFilledMsg(NET, ASSET, 'aa', 'bb')), 'the dapp (bound-swap.js) and the worker sign and check the same offer, cancel and fill messages');
}
ok((await posted(offerOf(), { e: offEnv })).status === 410, 'POST is off unless BOUND_OFFERS_ENABLED=true');

const good = await posted(offerOf());
ok(good.status === 200 && /^[0-9a-f]{64}$/.test(good.json.id), `a well-formed offer, signed by the seller, into an active bound bid is taken (${good.status} ${JSON.stringify(good.json).slice(0, 80)})`);
const id = good.json.id;
const list = await call(env, 'GET', `/assets/${ASSET}/bound-offers?network=${NET}&bid=${BID_ID}`);
ok(list.status === 200 && list.json.count === 1 && list.json.offers[0].id === id && list.json.offers[0].payload === offerOf().payload, 'the list for the bid shows it, with its payload and signature for the watchtower');
ok((await call(env, 'GET', `/assets/${ASSET}/bound-offers?network=${NET}&bid=${'ef'.repeat(16)}`)).json.count === 0, 'another bid lists none');

const refused = async (what, o, opts, status, re) => { const r = await posted(o, opts); ok(r.status === status && (!re || re.test(r.json.error || '')), `${what}: ${status} (${r.json.error})`); };
await refused('a signature by another key', offerOf(), { k: OTHERK }, 403, /signature/);
await refused('a note at a script that is not the seller key\'s', offerOf({ note: { ...offerOf().note, script: '5120' + '66'.repeat(32) } }), {}, 400, /note.script/);
await refused('a payload that is not 0x39', offerOf({ payload: '22' + '00'.repeat(120) }), {}, 400, /0x39/);
await refused('a SIGHASH_ALL (not ANYONECANPAY) witness', offerOf({ witness: ['55'.repeat(64) + '01'] }), {}, 400, /ANYONECANPAY/);
await refused('the buyer note at another key', offerOf({ buyerXonly: '77'.repeat(32), noteScripts: ['5120' + '77'.repeat(32), '5120' + sx] }), {}, 409, /buyerXonly/);
await refused('more per unit than the bid pays', offerOf({ priceSats: 20001 }), {}, 409, /per unit/);
await refused('more than the bid takes', offerOf({ amount: '1001', priceSats: 50050 }), {}, 409, /at most/);
await refused('an expiry past seven days', offerOf(), { expiry: NOW + 8 * 86400 }, 400, /7 days/);
await refused('a bid that does not exist', offerOf(), { bid: 'ee'.repeat(16) }, 404, /no active/);
await seedBid(env, { bid_id: 'aa'.repeat(16), kind: 'axfer' });
await refused('an atomic-intent (TAC) bid', offerOf(), { bid: 'aa'.repeat(16) }, 409, /not a bound/);

// cancel: the seller only
{
  const bad = await call(env, 'DELETE', `/assets/${ASSET}/bound-offers/${id}?network=${NET}`, { sig: await sign(wbo.boundOfferCancelMsg(NET, ASSET, id), OTHERK) });
  ok(bad.status === 403, 'a cancel by another key is refused');
}
// the fill report: the bid key only, then the offer leaves the list
{
  const second = await posted(offerOf({ note: { ...offerOf().note, txid: '88'.repeat(32) } }));
  const id2 = second.json.id;
  const rt = '99'.repeat(32), ct = 'aa'.repeat(32);
  const bad = await call(env, 'POST', `/assets/${ASSET}/bound-offers/${id2}/filled?network=${NET}`, { reveal_txid: rt, commit_txid: ct, sig: await sign(wbo.boundOfferFilledMsg(NET, ASSET, id2, rt), SELLER) });
  ok(bad.status === 403, 'a fill report not signed by the bid key is refused');
  const good2 = await call(env, 'POST', `/assets/${ASSET}/bound-offers/${id2}/filled?network=${NET}`, { reveal_txid: rt, commit_txid: ct, sig: await sign(wbo.boundOfferFilledMsg(NET, ASSET, id2, rt), BIDK) });
  ok(good2.status === 200 && good2.json.offer.status === 'filled' && good2.json.offer.reveal_txid === rt, 'the bid key\'s fill report marks it filled with its transactions');
  const l2 = await call(env, 'GET', `/assets/${ASSET}/bound-offers?network=${NET}`);
  ok(!l2.json.offers.some((o) => o.id === id2), 'a filled offer leaves the open list');
  const cancel = await call(env, 'DELETE', `/assets/${ASSET}/bound-offers/${id}?network=${NET}`, { sig: await sign(wbo.boundOfferCancelMsg(NET, ASSET, id), SELLER) });
  ok(cancel.status === 200 && (await call(env, 'GET', `/assets/${ASSET}/bound-offers?network=${NET}`)).json.count === 0, 'the seller cancels its own offer, and the list is empty');
}

console.log(`\n${pass} worker-bound-offers checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
