// dapp/private-route.js with the relay registry's relays (listRelays): a relay the page has read from the registry is reached through the route, sealed to its own
// key by a forwarder's /r/ routes (dapp/route-community.js); any other relay is still refused and never sent in the open. The whole path through real forwarders,
// keys and gateways is worker-relay/tests/relay-community-route.test.mjs.
//   node tests/private-route-community.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

// the module as a page loads it, with its absolute imports pointed at the files
const url = (p) => pathToFileURL(new URL(p, import.meta.url).pathname).href;
const source = readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8');
assert.equal((source.match(/\/sealed-request\.js\?cb=/g) || []).length, 1, 'one place loads the sealed module (the test points it at the file)');
const dir = mkdtempSync(join(tmpdir(), 'private-route-community-'));
writeFileSync(join(dir, 'private-route.mjs'), source.replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/, url('../dapp/sealed-request.js')).replace(/\/route-community\.js\?cb=[A-Za-z0-9_-]+/, url('../dapp/route-community.js')));
const { ROUTE, keeperFetch, listRelays } = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);

const RELAYER = '0x' + 'a1'.repeat(20);
const URL1 = 'https://relay.example/1/evm-pool/keeper';
const calls = [];
globalThis.fetch = async (u, init = {}) => {
  calls.push({ url: String(u), method: init.method || 'GET' });
  return new Response('{"error":"not found"}', { status: 404 });      // every forwarder answers 404: no key to show
};
const direct = () => calls.filter((c) => !c.url.startsWith('https://tacit-evm-pool-forwarder'));

await check('a relay the page has not read from the registry is refused and nothing is sent', async () => {
  await assert.rejects(keeperFetch(`${URL1}/quote`), /does not reach this relay/);
  assert.equal(calls.length, 0);
});
await check('listRelays takes only an https url ending /evm-pool/keeper with an address, once each', async () => {
  listRelays(1, [{ url: 'http://relay.example/1/evm-pool/keeper', relayer: RELAYER }, { url: 'https://relay.example/x', relayer: RELAYER }, { url: URL1, relayer: 'nope' }, null, { url: 5 }]);
  await assert.rejects(keeperFetch('http://relay.example/1/evm-pool/keeper/quote'), /does not reach this relay/);
  await assert.rejects(keeperFetch(`${URL1}/quote`), /does not reach this relay/, 'none of those was listed');
  assert.equal(calls.length, 0);
});
await check('a listed relay goes through the route: its key is asked of a forwarder, and with none to show it is not reached, never sent directly', async () => {
  listRelays(1, [{ url: URL1 + '/', relayer: RELAYER }, { url: URL1, relayer: RELAYER }]);
  await assert.rejects(keeperFetch(`${URL1}/quote`), /could not be shown and checked/);
  const asked = calls.map((c) => c.url);
  assert.ok(asked.length >= 2 && asked.every((u) => /^https:\/\/tacit-evm-pool-forwarder(?:-2)?\.onrender\.com\/r\/1\/0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1\/key$/.test(u)), asked.join());
  assert.deepEqual(direct(), [], 'no request went to the relay itself');
  assert.ok(ROUTE.forwarders.length >= 2);
});
await check('a relay on another url is still refused after others were listed, and a keeper request outside the route is passed on as before', async () => {
  const before = calls.length;
  await assert.rejects(keeperFetch('https://other.example/1/evm-pool/keeper/quote'), /does not reach this relay/);
  assert.equal(calls.length, before);
  await keeperFetch('https://api.example/thing');
  assert.equal(calls.at(-1).url, 'https://api.example/thing');
});
console.log(`\n${n} passed`);
