// /amm/op-accepted (worker/src/index.js): the applied-op record for T_LP_ADD / T_LP_REMOVE /
// T_PROTOCOL_FEE_CLAIM that the dapp validator reads before crediting those ops' outputs, served next to
// /amm/swap-accepted with the scan cursor and the first height scanned with records (since_height).
//
// Run: node tests/amm-op-accepted-worker.test.mjs

import worker, {
  ammOpAcceptedGet, ammOpAcceptedPut, ammOpAcceptedSince, ammOpAcceptedKey, ammOpAcceptedSinceKey,
} from '../worker/src/index.js';

function kv(entries = []) {
  const m = new Map(entries);
  return {
    m,
    async get(k, type) { if (!m.has(k)) return null; const v = m.get(k); return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}
async function call(env, network, txid) {
  const r = await worker.fetch(new Request(`https://api.tacit.finance/amm/op-accepted?network=${network}&txid=${txid}`, { headers: { Origin: 'https://tacit.finance' } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json() };
}

let fails = 0;
const ok = (c, m, d = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || !d ? '' : ` — ${d}`)); if (!c) fails++; };

const TX = 'ab'.repeat(32), OTHER = 'cd'.repeat(32), POOL = 'ee'.repeat(32);

ok(ammOpAcceptedKey('mainnet', TX) === `ammopok:mainnet:${TX}`, 'mainnet record key carries the network');
ok(ammOpAcceptedKey('signet', TX) === `ammopok:${TX}`, 'signet record key has no network segment (like ammswapok)');
ok(ammOpAcceptedSinceKey('mainnet') === 'meta:ammopok_since:mainnet' && ammOpAcceptedSinceKey('signet') === 'meta:ammopok_since', 'since keys per network');

{
  const env = { REGISTRY_KV: kv() };
  ok((await ammOpAcceptedSince(env, 'mainnet')) === null, 'no since key → null');
  await ammOpAcceptedPut(env, 'mainnet', TX, { h: 900100, op: 'lp_add', pool_id: POOL });
  const rec = await ammOpAcceptedGet(env, 'mainnet', TX);
  ok(rec && rec.op === 'lp_add' && rec.h === 900100, 'put/get round-trip');
  ok((await ammOpAcceptedGet(env, 'signet', TX)) === null, 'a mainnet record is not read on signet');
}

{
  const env = { REGISTRY_KV: kv([['meta:last_scanned:mainnet', '900110']]) };
  const a = await call(env, 'mainnet', TX);
  ok(a.status === 200 && a.body.accepted === false && a.body.since_height === null && a.body.scanned_height === 900110,
    'before any record: not accepted, since_height null, cursor reported', JSON.stringify(a.body));
  await env.REGISTRY_KV.put('meta:ammopok_since:mainnet', '900050');
  await ammOpAcceptedPut(env, 'mainnet', TX, { h: 900100, op: 'lp_remove', pool_id: POOL });
  const b = await call(env, 'mainnet', TX);
  ok(b.status === 200 && b.body.accepted === true && b.body.height === 900100 && b.body.op === 'lp_remove' && b.body.pool_id === POOL && b.body.since_height === 900050,
    'recorded op: accepted with its height, op and pool', JSON.stringify(b.body));
  const c = await call(env, 'mainnet', OTHER);
  ok(c.status === 200 && c.body.accepted === false && c.body.since_height === 900050 && c.body.scanned_height === 900110,
    'unrecorded op: not accepted, with since_height and the cursor', JSON.stringify(c.body));
  const d = await call(env, 'mainnet', TX.toUpperCase());
  ok(d.status === 200 && d.body.accepted === true, 'txid is case-insensitive');
  const e = await call(env, 'mainnet', 'xyz');
  ok(e.status === 400, 'malformed txid → 400');
}

{
  // A KV read error is a 500, never a negative answer.
  const env = { REGISTRY_KV: { async get() { throw new Error('kv down'); }, async put() {}, async list() { return { keys: [], list_complete: true }; } } };
  const r = await call(env, 'mainnet', TX);
  ok(r.status === 500 && r.body.accepted === undefined, 'a storage error is a 500, not accepted:false', JSON.stringify(r.body));
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
