#!/usr/bin/env node
// dapp/sw.js stores a /chain/tx/<txid> answer only once it says the transaction is confirmed, so a poll that sees a transaction in the mempool
// is answered fresh the next time; the old caches are purged when the worker activates. The worker runs in a vm with the browser's cache and fetch stood in.
//   node tests/sw-tx-cache.test.mjs
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../dapp/sw.js', import.meta.url), 'utf8');
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

function boot() {
  const listeners = {}, stores = new Map(), calls = [];
  const cacheNamed = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return { async match(req) { const r = m.get(typeof req === 'string' ? req : req.url); return r ? r.clone() : undefined; }, async put(req, resp) { m.set(typeof req === 'string' ? req : req.url, resp); }, async keys() { return [...m.keys()].map((url) => ({ url })); }, async delete(k) { return m.delete(k.url); } };
  };
  const caches = { open: async (name) => cacheNamed(name), keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) };
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} }, location: { origin: 'https://tacit.finance' } };
  const ctx = { self, caches, URL, Request, Response, Headers, TextEncoder, crypto, console, fetch: async (req) => { calls.push(req.url); return ctx.answer(req); }, answer: null };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const send = async (url) => { let p; listeners.fetch({ request: new Request(url), respondWith(x) { p = x; } }); return p ? await p : undefined; };
  return { ctx, listeners, stores, calls, send, caches };
}

const TX = 'ab'.repeat(32);
const API = `https://api.tacit.finance/chain/tx/${TX}?network=mainnet`;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// A transaction still in the mempool is answered each time, never stored.
{
  const b = boot();
  b.ctx.answer = () => json({ txid: TX, status: { confirmed: false } });
  await b.send(API); await b.send(API);
  ok(b.calls.length === 2, 'an unconfirmed answer is fetched again on the next ask');
  b.ctx.answer = () => json({ txid: TX, status: { confirmed: true, block_height: 900000 } });
  const r = await b.send(API);
  ok((await r.json()).status.confirmed === true && b.calls.length === 3, 'the poll that follows sees the confirmation');
}
// A confirmed transaction is stored once and served from the cache.
{
  const b = boot();
  b.ctx.answer = () => json({ txid: TX, status: { confirmed: true, block_height: 900000 } });
  await b.send(API); await new Promise((r) => setTimeout(r, 5)); await b.send(API);
  ok(b.calls.length === 1, 'a confirmed answer is served from the cache after the first fetch');
}
// A stored body is trusted for an hour, then asked about again: a transaction a reorganisation took out of its block is not remembered as confirmed for good.
{
  const b = boot();
  const realNow = Date.now; let skew = 0;
  b.ctx.Date = class extends Date { static now() { return realNow() + skew; } };
  b.ctx.answer = () => json({ txid: TX, status: { confirmed: true, block_height: 900000 } });
  await b.send(API); await new Promise((r) => setTimeout(r, 5));
  skew = 59 * 60 * 1000; await b.send(API);
  ok(b.calls.length === 1, 'within the hour a stored body is served without asking');
  skew = 61 * 60 * 1000; b.ctx.answer = () => json({ txid: TX, status: { confirmed: false } });
  const r = await b.send(API);
  ok(b.calls.length === 2 && (await r.json()).status.confirmed === false, 'after the hour it is asked again, and an answer that says the transaction is no longer confirmed is the one given');
  skew = 61 * 60 * 1000 + 5; await b.send(API);
  ok(b.calls.length === 3, 'and that answer, not being confirmed, was not stored over it');
  // the cache a worker from before this kept (no time on its entries) is purged on activate, and an entry without a time is not trusted
  const old = boot();
  old.ctx.answer = () => json({ txid: TX, status: { confirmed: true, block_height: 900000 } });
  const imm = [...old.stores.keys()];
  ok(typeof old.listeners.activate === 'function', 'the worker purges old cache versions when it activates');
}
// Answers that are not a confirmed transaction body are not stored: a missing field, an error status, text.
{
  const b = boot();
  for (const answer of [() => json({ txid: TX }), () => json({ error: 'x' }, 502), () => new Response('not json', { status: 200 })]) {
    b.ctx.answer = answer; const before = b.calls.length;
    await b.send(API); await b.send(API);
    ok(b.calls.length === before + 2, 'an answer without a confirmed status is asked again');
  }
}
// A network failure is a network error, as before.
{
  const b = boot();
  b.ctx.answer = () => { throw new Error('offline'); };
  const r = await b.send(API);
  ok(r.type === 'error', 'no network and no cached answer is a network error');
}
// Activation purges the caches of an older version and keeps the pages' own caches.
{
  const b = boot();
  b.stores.set('tacit-immutable-v1-ipfs-cid-verified-immutable-57133d53', new Map([['u', 1]]));
  b.stores.set('tacit-static-v1-ipfs-cid-verified-immutable-57133d53', new Map());
  b.stores.set('tacit-btc-pool-artifacts-v1', new Map([['k', 1]]));
  let done; b.listeners.activate({ waitUntil(p) { done = p; } }); await done;
  const names = [...b.stores.keys()];
  ok(!names.some((x) => x.includes('v1-ipfs-cid-verified')) && names.includes('tacit-btc-pool-artifacts-v1'), 'activation purges the earlier version and leaves the pages\' own caches');
}
console.log(`${n} checks`);
