// dapp/evm-pool-open-relays.js: reading the relay registry, taking a few of its relays, and not waiting on the slowest.
//
// Run: node tests/evm-pool-open-relays.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeList, readRegistry, drawRelays, openRelays, keepersForPool, collectQuotes, RELAY_REGISTRY, MAX_RELAYS_ASKED, MAX_PAGES } from '../dapp/evm-pool-open-relays.js';
import { relaysOf } from '../dapp/evm-pool-relays.js';
import { encodeList } from './helpers/relay-registry-list.mjs';

let pass = 0, fail = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

// the registry's own answer, read from Ethereum (list(1, 0, 100) with one entry: the Pay relay) on 2026-11-18
const REAL = '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000007c9f8ae4e48cbb2727f95b6477a1cf92bcfc43d0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000003635c9adc5dea0000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003d68747470733a2f2f74616369742d65766d2d706f6f6c2d6b6565706572732e6f6e72656e6465722e636f6d2f312f65766d2d706f6f6c2f6b6565706572000000';
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

const U = (n) => `https://relay${n}.example/${n}/evm-pool/keeper`;
const entry = (n, stake = 1000n * 10n ** 18n) => ({ relayer: '0x' + n.toString(16).padStart(40, '0'), stake, url: U(n) });

console.log('reading what the registry returns');
await check('the registry\'s real answer decodes: the Pay relay, its stake, its url, and where to go on', () => {
  const d = decodeList(REAL);
  assert.deepEqual(d.relayers, ['0x7c9f8ae4e48cbb2727f95b6477a1cf92bcfc43d0']);
  assert.deepEqual(d.stakes, [1000n * 10n ** 18n]);
  assert.deepEqual(d.urls, ['https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper']);
  assert.equal(d.next, 1);
});
await check('the encoder here agrees with the real answer, so the shapes below are the contract\'s', () => {
  assert.equal(encodeList([{ relayer: '0x7c9f8ae4e48cbb2727f95b6477a1cf92bcfc43d0', stake: 1000n * 10n ** 18n, url: 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper' }], 1), REAL);
});
await check('several entries, urls of every length up to the contract\'s 128, and an empty page all decode', () => {
  const es = [entry(1), entry(2), { relayer: A, stake: 5n, url: 'https://' + 'a'.repeat(104) + '/evm-pool/keeper' }, { relayer: B, stake: 2n ** 200n, url: 'https://x.io/evm-pool/keeper' }];
  assert.equal(es[2].url.length, 128);
  const d = decodeList(encodeList(es, 9));
  assert.deepEqual(d.urls, es.map((e) => e.url));
  assert.deepEqual(d.stakes, es.map((e) => e.stake));
  assert.deepEqual(d.relayers, es.map((e) => e.relayer.toLowerCase()));
  assert.equal(d.next, 9);
  const empty = decodeList(encodeList([], 0));
  assert.deepEqual(empty, { relayers: [], stakes: [], urls: [], next: 0 });
});
await check('an answer that is not the shape the contract returns is null, never a throw and never a guess', () => {
  const ok = encodeList([entry(1), entry(2)], 2);
  for (const bad of [null, undefined, 5, '', '0x', '0x00', 'nonsense', '0xzz', ok + 'f', ok.slice(0, -80), ok.slice(0, 200)]) assert.equal(decodeList(bad), null, String(bad)?.slice(0, 30));
  const flip = (at, v) => { const h = ok.slice(2); return '0x' + h.slice(0, at * 2) + word(v) + h.slice((at + 32) * 2); };
  assert.equal(decodeList(flip(0, 10 ** 9)), null, 'an offset beyond the answer');
  assert.equal(decodeList(flip(64, 10 ** 9)), null, 'an offset beyond the answer (urls)');
  assert.equal(decodeList(flip(128, 10 ** 6)), null, 'a count beyond the answer');
  assert.equal(decodeList(flip(128, 3)), null, 'counts that differ');
  assert.equal(decodeList(flip(128 + 32, 2 ** 170)), null, 'an address wider than 160 bits');
});
await check('a node cannot make the decoder run long or wide with a huge count', () => {
  const h = '0x' + word(128) + word(160) + word(192) + word(1) + word(10 ** 12) + word(10 ** 12) + word(10 ** 12);
  assert.equal(decodeList(h), null);
});

console.log('reading the list');
// a registry that serves `entries` the way the contract does: pages of at most 100 from `start`, and `next` = where to go on
function fakeRegistry(entries, { page = 100, fail = new Set() } = {}) {
  const calls = [];
  const call = async (to, data) => {
    calls.push({ to, data });
    assert.equal(to, RELAY_REGISTRY);
    assert.equal(data.slice(0, 10), '0xd4d25113', 'list(uint64,uint256,uint256)');
    const start = Number(BigInt('0x' + data.slice(10 + 64, 10 + 128))), chain = Number(BigInt('0x' + data.slice(10, 10 + 64)));
    if (fail.has(calls.length)) throw new Error('node down');
    const from = Math.min(start, entries.length), got = entries.slice(from, from + page);
    return encodeList(got, from + got.length >= entries.length ? entries.length : from + got.length);
  };
  call.calls = calls;
  return call;
}
await check('the call is the contract\'s list(1, 0, 100) byte for byte (the calldata cast builds)', async () => {
  const call = fakeRegistry([entry(1)]);
  await readRegistry({ call, chainId: 1 });
  assert.equal(call.calls[0].data, '0xd4d25113000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064');
});
await check('every entry is read, a page at a time, and the read ends where the registry says it is done', async () => {
  const es = Array.from({ length: 230 }, (_, i) => entry(i + 1));
  const call = fakeRegistry(es);
  const got = await readRegistry({ call, chainId: 1 });
  assert.equal(got.length, 230);
  assert.deepEqual(got.map((e) => e.url), es.map((e) => e.url));
  assert.equal(call.calls.length, 4, 'three pages with entries and the empty one that says it is done');
});
await check('a node that does not move on, or goes past the cap, ends the read; a failing page keeps what came before; no registry is []', async () => {
  const stuck = async () => encodeList([entry(1)], 0);
  assert.equal((await readRegistry({ call: stuck, chainId: 1 })).length, 1, 'next not past start: read once');
  const es = Array.from({ length: 5000 }, (_, i) => entry(i + 1));
  const capped = fakeRegistry(es);
  assert.equal((await readRegistry({ call: capped, chainId: 1 })).length, 300, 'the entries kept are capped');
  assert.equal(capped.calls.length, 3, 'three pages of a hundred fill the cap: no fourth call');
  assert.ok(capped.calls.length <= MAX_PAGES);
  const flaky = fakeRegistry(Array.from({ length: 250 }, (_, i) => entry(i + 1)), { fail: new Set([2]) });
  assert.equal((await readRegistry({ call: flaky, chainId: 1 })).length, 100, 'the first page, then the failure ends it');
  assert.deepEqual(await readRegistry({ call: async () => { throw new Error('no node'); }, chainId: 1 }), []);
  assert.deepEqual(await readRegistry({ call: async () => '0x', chainId: 1 }), []);
});

console.log('taking a few');
await check('a draw has no repeats, takes what there is when there are fewer than asked, and is all alike', () => {
  const es = Array.from({ length: 10 }, (_, i) => entry(i + 1));
  const d = drawRelays(es, 4, () => 0.5);
  assert.equal(d.length, 4);
  assert.equal(new Set(d.map((e) => e.url)).size, 4);
  assert.equal(drawRelays(es, 40, () => 0.1).length, 10);
  assert.deepEqual(drawRelays([], 3), []);
  assert.deepEqual(drawRelays(es, 0), []);
  for (const r of [0, 0.999999, 1]) assert.equal(drawRelays(es, 3, () => r).length, 3, 'a random of 0 or just under 1 (or a bad 1) still draws');
  const first = new Map();
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 20000; i++) { const u = drawRelays(es, 1, rnd)[0].url; first.set(u, (first.get(u) || 0) + 1); }
  for (const n of first.values()) assert.ok(Math.abs(n / 20000 - 0.1) < 0.02, `one entry drew ${n / 20000}`);
});
await check('the page\'s own relay is never listed twice, and the draw leaves room for it: five relays asked in all', async () => {
  const OWN = 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper';
  const es = [{ relayer: A, stake: 1n, url: OWN }, { relayer: B, stake: 1n, url: OWN.toUpperCase().replace('HTTPS', 'https') + '/' }, ...Array.from({ length: 20 }, (_, i) => entry(i + 1))];
  const got = await openRelays({ call: fakeRegistry(es), chainId: 1, own: OWN, random: () => 0 });      // a draw that would take the first entries: the page's own, listed twice
  assert.equal(got.length, MAX_RELAYS_ASKED - 1);
  assert.ok(got.every((e) => e.url.toLowerCase().replace(/\/+$/, '') !== OWN.toLowerCase()), 'not the page\'s own, listed by anyone under any address');
  assert.ok(got.every((e) => /^0x[0-9a-f]{40}$/.test(e.relayer) && /^https:\/\//.test(e.url)));
  const none = await openRelays({ call: fakeRegistry(es), chainId: 1, random: () => 0.3 });
  assert.equal(none.length, MAX_RELAYS_ASKED, 'with no relay of its own the page may ask five');
});
await check('entries a wallet would not use take no place in the draw: a repeat, plain http, the wrong ending, an address, a local name', async () => {
  const bad = ['http://plain.example/evm-pool/keeper', 'https://x.example/evm-pool/keepers', 'https://203.0.113.9/evm-pool/keeper', 'https://localhost/evm-pool/keeper', 'https://printer.local/evm-pool/keeper', 'https://nodot/evm-pool/keeper'];
  const es = [...bad.map((url, i) => ({ relayer: '0x' + (i + 200).toString(16).padStart(40, '0'), stake: 1n, url })), entry(1), entry(1), entry(2)];
  const got = await openRelays({ call: fakeRegistry(es), chainId: 1, own: 'https://own.example/1/evm-pool/keeper', random: () => 0 });
  assert.deepEqual(got.map((e) => e.url).sort(), [U(1), U(2)], 'only the two good ones, once each');
  const local = await openRelays({ call: fakeRegistry([{ relayer: A, stake: 1n, url: 'https://localhost/evm-pool/keeper' }]), chainId: 1, pinned: false });
  assert.equal(local.length, 1, 'off a real origin a local relay is fine (a test, a local page)');
});
await check('a registry that cannot be read leaves the page with its own relay, and nothing throws', async () => {
  assert.deepEqual(await openRelays({ call: async () => { throw new Error('down'); }, chainId: 1, own: U(9) }), []);
  assert.deepEqual(await openRelays({ call: async () => 'garbage', chainId: 1 }), []);
  assert.deepEqual(await openRelays({ call: () => { throw new Error('sync throw'); }, chainId: 1 }), []);
});
await check('the built-in relay is the one at its URL: a listed entry for the same url adds nothing and cannot pin it to another address', () => {
  const OWN = 'https://own.example/1/evm-pool/keeper';
  const r = relaysOf({ keeper: OWN, relayer: null, keepers: [{ url: OWN, relayer: B }, { url: OWN.toUpperCase().replace('HTTPS', 'https'), relayer: A }, { url: U(1), relayer: C }] });
  assert.deepEqual(r.map((e) => [e.url, e.relayer]), [[OWN, null], [U(1), C]]);
  const r2 = relaysOf({ keeper: OWN, relayer: A, keepers: [{ url: OWN, relayer: A }] });
  assert.equal(r2.length, 1);
  const r3 = relaysOf({ keepers: [{ url: OWN, relayer: A }, { url: OWN, relayer: B }] });
  assert.equal(r3.length, 2, 'with no built-in, two addresses at one listed url are both kept (the quote says which it is)');
});

console.log('projecting a chain\'s relays to a token pool');
await check('native multi-keeper routes map to fixed and dynamic token pools without losing their signer or weight', () => {
  const entries = [
    { url: 'https://relay.example/1/evm-pool/keeper', relayer: A, weight: 3 },
    { url: 'https://relay.example/8453/evm-pool/keeper/', relayer: B, weight: 2 },
  ];
  const before = structuredClone(entries);
  assert.deepEqual(keepersForPool(entries, 1, '1-tac')[0], { url: 'https://relay.example/1-tac/evm-pool/keeper', relayer: A, weight: 3 });
  assert.deepEqual(keepersForPool(entries, 1, '1-xa0b86991c6')[0].url, 'https://relay.example/1-xa0b86991c6/evm-pool/keeper');
  assert.deepEqual(keepersForPool(entries, 8453, '8453-xdac17f958')[0], { url: 'https://relay.example/8453-xdac17f958/evm-pool/keeper', relayer: B, weight: 2 });
  assert.deepEqual(entries, before, 'the registry entries are not changed');
});
await check('an already projected route is kept, while bare, unrelated, malformed and ambiguous routes are not guessed at', () => {
  const projected = { url: 'https://relay.example/1-tac/evm-pool/keeper/', relayer: A };
  assert.deepEqual(keepersForPool([projected], 1, '1-tac'), [{ url: projected.url.slice(0, -1), relayer: A }]);
  const bad = [
    'https://relay.example/evm-pool/keeper',
    'https://relay.example/prefix/1/evm-pool/keeper',
    'https://relay.example/1-xa0b86991c6/evm-pool/keeper',
    'https://relay.example/8453/evm-pool/keeper',
    'https://relay.example/1/evm-pool/keeper?pool=tac',
    'https://relay.example/1/evm-pool/keeper#tac',
    'https://user@relay.example/1/evm-pool/keeper',
    'not a url',
  ].map((url) => ({ url, relayer: A }));
  assert.deepEqual(keepersForPool(bad, 1, '1-tac'), []);
  assert.deepEqual(keepersForPool([{ url: U(1), relayer: A }], 1, '8453-tac'), []);
  assert.deepEqual(keepersForPool([{ url: U(1), relayer: A }], 1, 'not-a-pool'), []);
  assert.deepEqual(keepersForPool(null, 1, '1-tac'), []);
});

console.log('not waiting on the slowest');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const E = (n) => ({ url: U(n), relayer: A, weight: 1 });
await check('when every relay answers, all of them are returned', async () => {
  const es = [E(1), E(2), E(3)];
  const got = await collectQuotes(es, async (e) => ({ fee: e.url }), 200);
  assert.deepEqual(got.map((x) => x.e.url).sort(), es.map((e) => e.url).sort());
});
await check('a relay that never answers costs the grace, not its timeout: the fast relays\' quotes come back shortly after the first', async () => {
  const t0 = Date.now();
  const got = await collectQuotes([E(1), E(2), E(3)], async (e) => (e.url === U(3) ? sleep(5000).then(() => ({ fee: '9' })) : (await sleep(e.url === U(1) ? 5 : 30), { fee: '1' })), 120);
  const took = Date.now() - t0;
  assert.deepEqual(got.map((x) => x.e.url).sort(), [U(1), U(2)]);
  assert.ok(took >= 100 && took < 1000, `took ${took} ms`);
});
await check('failures, nulls and throws are not quotes; no answers at all is [] once every relay has failed; an empty list is []', async () => {
  const got = await collectQuotes([E(1), E(2), E(3)], async (e) => { if (e.url === U(1)) throw new Error('boom'); if (e.url === U(2)) return null; return { fee: '3' }; }, 50);
  assert.deepEqual(got.map((x) => x.e.url), [U(3)]);
  const t0 = Date.now();
  assert.deepEqual(await collectQuotes([E(1), E(2)], async () => { await sleep(20); return null; }, 5000), []);
  assert.ok(Date.now() - t0 < 1000, 'ended when the last had failed, not at the grace');
  assert.deepEqual(await collectQuotes([], async () => ({ fee: '1' })), []);
  assert.deepEqual(await collectQuotes([E(1)], () => { throw new Error('sync'); }, 20), []);
});
await check('an answer after the grace is not added to what was returned', async () => {
  const got = await collectQuotes([E(1), E(2)], async (e) => { if (e.url === U(2)) await sleep(150); return { fee: '1' }; }, 30);
  assert.deepEqual(got.map((x) => x.e.url), [U(1)]);
  await sleep(200);
  assert.equal(got.length, 1);
});

console.log('the person\'s choice and the curated lists');
{
  const reg = [entry(1), entry(2), entry(3), entry(4), entry(5), entry(6)];
  const OWN = 'https://own.example/1/evm-pool/keeper';
  await check('a preferred relay is always asked, and an avoided one never is', async () => {
    for (let i = 0; i < 20; i++) {
      const got = (await openRelays({ call: fakeRegistry(reg), chainId: 1, own: OWN, prefer: [U(6)], avoid: [U(1), U(2)], random: Math.random })).map((e) => e.url);
      assert.ok(got.includes(U(6)), `preferred asked (${got})`);
      assert.ok(!got.includes(U(1)) && !got.includes(U(2)), `avoided never asked (${got})`);
      assert.equal(got.length, MAX_RELAYS_ASKED - 1);
    }
  });
  await check('a relay the person added (or the page\'s registry names) is a candidate, and a preferred one of those is asked', async () => {
    const mine = { url: 'https://mine.example/1/evm-pool/keeper', relayer: '0x' + 'ab'.repeat(20) };
    const got = await openRelays({ call: fakeRegistry(reg), chainId: 1, own: OWN, extra: [mine], prefer: [mine.url] });
    assert.ok(got.some((e) => e.url === mine.url && e.relayer === mine.relayer), JSON.stringify(got));
  });
  await check('with the open registry switched off, only the added relays are drawn from, and the registry is not read', async () => {
    let calls = 0;
    const mine = { url: 'https://mine.example/1/evm-pool/keeper', relayer: '0x' + 'ab'.repeat(20) };
    const got = await openRelays({ call: async (...a) => { calls++; return fakeRegistry(reg)(...a); }, chainId: 1, own: OWN, extra: [mine], openOff: true });
    assert.deepEqual(got.map((e) => e.url), [mine.url]);
    assert.equal(calls, 0);
  });
  await check('an added relay that a wallet would not use (no relayer pin, not https) takes no place, and a repeat is listed once', async () => {
    const got = await openRelays({ call: fakeRegistry([entry(1)]), chainId: 1, own: OWN, extra: [{ url: 'http://bad.example/1/evm-pool/keeper', relayer: '0x' + 'ab'.repeat(20) }, { url: U(1), relayer: '0x' + (1).toString(16).padStart(40, '0') }, { url: 'https://nopin.example/1/evm-pool/keeper' }] });
    assert.deepEqual(got.map((e) => e.url), [U(1)]);
  });
}

console.log('the page');
await check('the Pay page reads the registry for each chain and lists what it finds next to its own relay, and its policy does not open to the host of a relay (the private route carries it)', () => {
  const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
  assert.ok(/evm-pool-open-relays\.js/.test(page), 'the page imports the reader');
  assert.ok(/openRelays\(/.test(page), 'and uses it');
  assert.ok(/keepersForPool\(t\.chain\.keepers, t\.chainId, t\.id\)/.test(page), 'token pools project the same registry entries to their own keeper ids');
  assert.ok(/listRelays\(t\.chainId, keepers\)/.test(page), 'the private route accepts each projected token keeper');
  assert.ok(/maxRelayFee: t\.maxRelayFee, keepers/.test(page), 'the token wallet receives the projected relays');
  const connect = /connect-src([^;"]*)/.exec(page)[1].split(/\s+/).filter(Boolean);
  assert.ok(!connect.includes('https:') && !connect.includes('*'), 'a registered relay is reached through the private route\'s forwarders: the policy stays closed to its host');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
