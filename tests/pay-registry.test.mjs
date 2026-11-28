// dapp/pay-registry.js: the page's own curated registry (TacitPayRegistry), read through two agreeing nodes, its entries checked for shape, kept an hour;
// and dapp/private-route.js setRouteEndpoints: its forwarders and Nostr relays in front of the page's own, hosts the page's policy allows only.
//
// Run: node tests/pay-registry.test.mjs

import assert from 'node:assert/strict';
import { readCalldata, decodeRead, regOf, readPayRegistry, flagOn, FLAG_OPEN_OFF, PAY_REGISTRY } from '../dapp/pay-registry.js';

let pass = 0, fail = 0;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

// the registry's own answer to read([keepers, forwarders, nostr], [1, 1, 0]), read from Ethereum on 2026-11-28
const REAL = '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002b68747470733a2f2f74616369742d65766d2d706f6f6c2d6b6565706572732e6f6e72656e6465722e636f6d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002d68747470733a2f2f74616369742d65766d2d706f6f6c2d666f727761726465722e6f6e72656e6465722e636f6d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002f68747470733a2f2f74616369742d65766d2d706f6f6c2d666f727761726465722d322e6f6e72656e6465722e636f6d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

await check('the call asks for keepers, forwarders and nostr (keepers and forwarders for chain 1)', () => {
  const d = readCalldata();
  assert.ok(d.startsWith('0x78f142e8'));
  assert.ok(d.includes(Buffer.from('keepers').toString('hex')) && d.includes(Buffer.from('forwarders').toString('hex')) && d.includes(Buffer.from('nostr').toString('hex')));
});
await check('the registry\'s real answer decodes, and is taken as it is: no relay (its keepers entry names no relayer), its two forwarders, no Nostr relay, no flag', () => {
  const r = regOf(decodeRead(REAL));
  assert.deepEqual(r.relays, []);
  assert.deepEqual(r.forwarders, ['https://tacit-evm-pool-forwarder.onrender.com', 'https://tacit-evm-pool-forwarder-2.onrender.com']);
  assert.deepEqual(r.nostr, []);
  assert.equal(r.flags, 0n);
  assert.equal(flagOn(r, FLAG_OPEN_OFF), false);
});
await check('entries a page cannot use are left out: a keepers entry with its relayer becomes a relay; bad shapes go', () => {
  const r = regOf({ flags: 8n, lists: [['https://a.example#0x' + 'ab'.repeat(20), 'https://b.example', 'http://c.example#0x' + 'cd'.repeat(20)], ['https://f.example', 'https://f.example/path', 'javascript:x'], ['wss://n.example', 'ws://n2.example']] });
  assert.deepEqual(r.relays, [{ url: 'https://a.example/1/evm-pool/keeper', relayer: '0x' + 'ab'.repeat(20) }]);
  assert.deepEqual(r.forwarders, ['https://f.example']);
  assert.deepEqual(r.nostr, ['wss://n.example']);
  assert.equal(flagOn(r, FLAG_OPEN_OFF), true, 'bit 3: the open registry is not read');
});
await check('a reply that is not the contract\'s shape is refused', () => {
  assert.throws(() => decodeRead('0x1234'));
  assert.throws(() => decodeRead('0x' + '00'.repeat(96)));
});
await check('two nodes must agree; one alone (or two that differ) is not taken, and nothing is kept', async () => {
  const s = mem(), other = REAL.slice(0, -2) + (REAL.endsWith('0') ? '1' : '0');
  assert.equal(await readPayRegistry({ calls: [async () => REAL], store: s }), null);
  assert.equal(await readPayRegistry({ calls: [async () => REAL, async () => other], store: s }), null);
  assert.equal(s.m.size, 0);
  const r = await readPayRegistry({ calls: [async () => REAL, async () => { throw new Error('down'); }, async () => REAL], store: s });
  assert.equal(r.forwarders.length, 2);
});
await check('an agreed read is kept an hour, and kept past that when the nodes cannot be read', async () => {
  const s = mem(); let t = 1_000_000;
  let asked = 0;
  const call = async (to) => { asked++; assert.equal(to, PAY_REGISTRY); return REAL; };
  await readPayRegistry({ calls: [call, call], store: s, now: () => t });
  assert.equal(asked, 2);
  t += 30 * 60_000; await readPayRegistry({ calls: [call, call], store: s, now: () => t });
  assert.equal(asked, 2, 'within the hour: from this browser');
  t += 60 * 60_000; const r = await readPayRegistry({ calls: [async () => { throw new Error('down'); }, async () => null], store: s, now: () => t });
  assert.equal(r.forwarders.length, 2, 'past the hour with no answer: the last good read');
});

console.log('the route');
{
  globalThis.document = { querySelector: () => ({ content: "default-src 'self'; connect-src 'self' https://tacit-evm-pool-forwarder.onrender.com https://tacit-evm-pool-forwarder-2.onrender.com https://new-forwarder.example wss://relay.primal.net wss://nos.lol wss://offchain.pub" }) };
  const pr = await import('../dapp/private-route.js');
  await check('the registry\'s forwarders go first, the page\'s own stay behind; a host the policy does not name is left out', () => {
    const own = [...pr.ROUTE.forwarders];
    assert.equal(pr.setRouteEndpoints({ forwarders: ['https://new-forwarder.example', 'https://not-in-policy.example'], nostr: ['wss://elsewhere.example'] }), true);
    assert.deepEqual(pr.ROUTE.forwarders, ['https://new-forwarder.example', ...own]);
    assert.ok(!pr.ROUTE.nostr.includes('wss://elsewhere.example'));
    assert.equal(pr.setRouteEndpoints({ forwarders: ['https://new-forwarder.example'] }), false, 'the same again changes nothing');
    pr.setRouteEndpoints({});
    assert.deepEqual(pr.ROUTE.forwarders, own, 'an empty registry leaves the page\'s own');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
