// A relay at a Tor onion address: listed as https://<id>.onion/evm-pool/keeper (the relay registry takes only https), used as plain http on Tor, left out off it.
//
// Run: node tests/onion-relays.test.mjs

import assert from 'node:assert/strict';
import { relaysOf, isOnion, onionHttp, onTor } from '../dapp/evm-pool-relays.js';
import { urlProblem } from '../dapp/relay-registry-ui.js';

let pass = 0, fail = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const ID = 'p53lf57qovyuvwsc6xnrppddxpr23otqjjd5ojq2yw6jz7qehbeoxyad';   // a v3 onion id: 56 characters
const ONION = `https://${ID}.onion/evm-pool/keeper`, CLEAR = 'https://two.example/evm-pool/keeper';

await check('the registry rule takes an onion url as it is', () => assert.equal(urlProblem(ONION), null));
await check('isOnion and onionHttp', () => {
  assert.ok(isOnion(ONION) && isOnion(onionHttp(ONION)) && isOnion(`http://${ID}.onion:8080/x`));
  assert.ok(!isOnion(CLEAR) && !isOnion('https://evil.example/x.onion/evm-pool/keeper') && !isOnion('https://a.onion.ly/evm-pool/keeper') && !isOnion(`https://${ID}.onion.evil.example/x`));
  assert.equal(onionHttp(ONION), `http://${ID}.onion/evm-pool/keeper`);
});
await check('on Tor an onion relay is listed, pinned like any other; off Tor it is left out', () => {
  const list = [{ url: ONION, relayer: B }, { url: CLEAR, relayer: A }];
  assert.deepEqual(relaysOf({ keepers: list, tor: true }).map((e) => e.url), [ONION, CLEAR]);
  assert.deepEqual(relaysOf({ keepers: list, tor: false }).map((e) => e.url), [CLEAR]);
  assert.deepEqual(relaysOf({ keepers: [{ url: ONION }], tor: true }), [], 'still needs the address its quote must name');
});
await check('onTor: an onion host, or the switch; nothing else', () => {
  const was = { location: globalThis.location, localStorage: globalThis.localStorage };
  const set = (loc, ls) => { Object.defineProperty(globalThis, 'location', { value: loc, configurable: true }); Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true }); };
  try {
    set({ hostname: 'tacit.finance' }, { getItem: () => null }); assert.equal(onTor(), false);
    set({ hostname: `${ID}.onion` }, { getItem: () => null }); assert.equal(onTor(), true);
    set({ hostname: 'tacit.finance' }, { getItem: (k) => (k === 'tacit-tor' ? '1' : null) }); assert.equal(onTor(), true);
    set({ hostname: 'tacit.finance' }, { getItem: () => { throw new Error('blocked'); } }); assert.equal(onTor(), false);
  } finally { set(was.location, was.localStorage); }
});
await check('onTor: a link with ?tor=1 turns it on and keeps it, ?tor=0 turns it off, even when storage is blocked', () => {
  const was = { location: globalThis.location, localStorage: globalThis.localStorage };
  const mem = new Map(); const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const set = (search, store) => { Object.defineProperty(globalThis, 'location', { value: { hostname: 'tacit.finance', search }, configurable: true }); Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true }); };
  try {
    set('?tor=1', ls); assert.equal(onTor(), true); assert.equal(mem.get('tacit-tor'), '1');
    set('', ls); assert.equal(onTor(), true, 'kept for the next page');
    set('?tor=0', ls); assert.equal(onTor(), false); assert.equal(mem.has('tacit-tor'), false);
    set('', ls); assert.equal(onTor(), false);
    const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    set('?tor=1', blocked); assert.equal(onTor(), true, 'the link still decides for this page');
    set('?tor=x', ls); assert.equal(onTor(), false, 'only 1 and 0');
  } finally { Object.defineProperty(globalThis, 'location', { value: was.location, configurable: true }); Object.defineProperty(globalThis, 'localStorage', { value: was.localStorage, configurable: true }); }
});
await check('keeperFetch: an onion relay is asked as http, directly, on Tor; refused off it; clear relays are unchanged', async () => {
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return { ok: true }; };
  const { keeperFetch } = await import('../dapp/private-route.js');
  const set = (host) => Object.defineProperty(globalThis, 'location', { value: { hostname: host }, configurable: true });
  set(`${ID}.onion`);
  await keeperFetch(`${ONION}/quote`, {});
  assert.deepEqual(seen, [`http://${ID}.onion/evm-pool/keeper/quote`]);
  set('tacit.finance');
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
  await assert.rejects(() => keeperFetch(`${ONION}/quote`, {}), /on Tor/);
  assert.equal(seen.length, 1, 'nothing was sent');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
