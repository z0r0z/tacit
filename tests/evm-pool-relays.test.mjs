// dapp/evm-pool-relays.js: which relays a wallet accepts for a chain, and how a spend picks one.
//
// Run: node tests/evm-pool-relays.test.mjs

import assert from 'node:assert/strict';
import { relaysOf, orderQuotes, NEAR_PCT } from '../dapp/evm-pool-relays.js';

let pass = 0, fail = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const U1 = 'https://one.example/1/evm-pool/keeper', U2 = 'https://two.example/evm-pool/keeper', U3 = 'https://three.example/8453/evm-pool/keeper';

console.log('the entries');
await check('the one keeper a chain config has always named is kept as it is, with the pin given for it, and nothing else is invented', () => {
  assert.deepEqual(relaysOf({ keeper: U1, relayer: A }), [{ url: U1, relayer: A, weight: 1 }]);
  assert.deepEqual(relaysOf({ keeper: U1 }), [{ url: U1, relayer: null, weight: 1 }], 'with no pin, none');
  assert.deepEqual(relaysOf({}), []);
});
await check('a listed relay is pinned to the address its quote must name: on a real origin one without it is left out, off one it may go without', () => {
  const list = [{ url: U2, relayer: B }, { url: U3 }];
  assert.deepEqual(relaysOf({ keeper: U1, relayer: A, keepers: list, pinned: true }).map((e) => e.url), [U1, U2]);
  assert.deepEqual(relaysOf({ keeper: U1, relayer: A, keepers: list, pinned: false }).map((e) => e.url), [U1, U2, U3]);
  assert.equal(relaysOf({ keepers: list, pinned: false }).find((e) => e.url === U3).relayer, null);
});
await check('the chain\'s own keeper is never dropped for lacking a pin, even on a real origin (a token pool has none)', () => {
  assert.deepEqual(relaysOf({ keeper: U1, relayer: null, pinned: true }).map((e) => e.url), [U1]);
});
await check('only plain https URLs (and a local one, for a page and a test on this machine) are taken; no other scheme, no credentials, no query', () => {
  const bad = ['http://evil.example/evm-pool/keeper', 'javascript:alert(1)', 'https://user:pw@evil.example/evm-pool/keeper', 'https://evil.example/evm-pool/keeper?y=1', 'ftp://x.example/evm-pool/keeper', 'data:text/plain,hi', '//evil.example/evm-pool/keeper', '', null, 5];
  for (const url of bad) assert.deepEqual(relaysOf({ keepers: [{ url, relayer: A }], pinned: true }), [], String(url));
  assert.deepEqual(relaysOf({ keepers: [{ url: 'http://127.0.0.1:8787/evm-pool/keeper', relayer: A }], pinned: false }).map((e) => e.url), ['http://127.0.0.1:8787/evm-pool/keeper']);
  assert.deepEqual(relaysOf({ keepers: [{ url: 'http://localhost:3000/evm-pool/keeper', relayer: A }], pinned: false }).map((e) => e.url), ['http://localhost:3000/evm-pool/keeper']);
});
await check('a listed relay must end in /evm-pool/keeper, the path the private route knows a relay by: any other is left out, so no request to it can go past the route', () => {
  for (const url of ['https://two.example', 'https://two.example/relay', 'https://two.example/evm-pool', 'https://two.example/evm-pool/keeper/quote', 'https://two.example/evm-pool/keepers', 'https://two.example/x/evm-pool/keeper/y']) {
    assert.deepEqual(relaysOf({ keepers: [{ url, relayer: A }], pinned: false }), [], url);
  }
  assert.deepEqual(relaysOf({ keepers: [{ url: 'https://two.example/1/evm-pool/keeper/', relayer: A }], pinned: true }).map((e) => e.url), ['https://two.example/1/evm-pool/keeper'], 'with a slash after it, and under a chain\'s id');
  assert.deepEqual(relaysOf({ keeper: 'https://old.example', relayer: A }).map((e) => e.url), ['https://old.example'], 'the keeper a chain has always named is not held to it: it is the one the wallet already knew');
});
await check('a pin that is not an address is no pin; a trailing slash is not a different relay; the same URL and address listed twice is one (the first entry wins)', () => {
  assert.deepEqual(relaysOf({ keepers: [{ url: U2, relayer: 'nope' }], pinned: true }), []);
  const two = relaysOf({ keeper: U1 + '/', relayer: A, keepers: [{ url: U1, relayer: A, weight: 9 }, { url: 'https://TWO.example/evm-pool/keeper', relayer: C }, { url: U2, relayer: C.toUpperCase().replace('0X', '0x'), weight: 7 }], pinned: true });
  assert.deepEqual(two.map((e) => e.url), [U1, 'https://TWO.example/evm-pool/keeper'], 'U1 once; the other once, though its host is spelled with capitals the second time');
  assert.equal(two[0].weight, 1, 'the keeper the chain named, not the list\'s second word on it');
});
await check('two addresses at one URL are both kept: an entry made by someone else for a URL cannot push the real relay off the list', () => {
  // B lists A's host ahead of A, with the weight of five; the server at that URL names A, so only A's entry will ever be used, but both are quoted
  const list = relaysOf({ keepers: [{ url: U2, relayer: B, weight: 5 }, { url: U2, relayer: A, weight: 1 }], pinned: true });
  assert.deepEqual(list.map((e) => e.relayer), [B, A]);
  assert.equal(relaysOf({ keepers: [{ url: U2, relayer: B }, { url: U2, relayer: B.toUpperCase().replace('0X', '0x') }], pinned: true }).length, 1, 'the same address twice is one');
  // the chain's own keeper is the relay at its URL: an entry listed for that URL adds nothing, so it neither doubles the keeper nor pins it elsewhere
  assert.deepEqual(relaysOf({ keeper: U2, relayer: A, keepers: [{ url: U2, relayer: B }], pinned: true }).map((e) => e.relayer), [A], 'one listed against the chain\'s own keeper is dropped');
});
await check('on a real origin a listed relay\'s host must be a public name: no IP address, localhost or local network name; off one, anything goes', () => {
  const hosts = ['localhost', 'localhost:8443', '127.0.0.1', '10.0.0.5:8443', '192.168.1.20', '169.254.169.254', '0x7f000001', 'printer.local', 'router.lan', 'svc.internal', 'host.home.arpa', 'nodot', '1.2', 'a.b.localhost', 'a.1'];
  for (const h of hosts) assert.deepEqual(relaysOf({ keepers: [{ url: `https://${h}/evm-pool/keeper`, relayer: A }], pinned: true }), [], h);
  for (const h of ['relay.example', 'relay-1.example.org:8443', 'a.b.c.example.com', 'RELAY.Example', 'x_y.example']) {
    assert.equal(relaysOf({ keepers: [{ url: `https://${h}/evm-pool/keeper`, relayer: A }], pinned: true }).length, 1, h);
  }
  assert.equal(relaysOf({ keepers: [{ url: 'https://127.0.0.1/evm-pool/keeper', relayer: A }], pinned: false }).length, 1, 'a local page or a test may use a local relay');
  assert.deepEqual(relaysOf({ keeper: 'https://localhost:8787', relayer: A }).map((e) => e.url), ['https://localhost:8787'], 'and the chain\'s own keeper is not held to it');
});
await check('a weight is a positive finite number, else 1', () => {
  const w = (x) => relaysOf({ keepers: [{ url: U2, relayer: B, weight: x }], pinned: true })[0].weight;
  assert.equal(w(3), 3); assert.equal(w(0.5), 0.5); assert.equal(w('4'), 4);
  for (const x of [0, -1, NaN, Infinity, undefined, null, 'x']) assert.equal(w(x), 1, String(x));
});

console.log('the choice');
const quote = (fee, weight = 1, id = String(fee)) => ({ e: { url: `https://${id}.example`, relayer: A, weight }, q: { fee: String(fee) } });
const urls = (list) => list.map((x) => x.e.url);
await check('one quote, or none, is returned as it is', () => {
  assert.deepEqual(orderQuotes([]), []);
  const one = [quote(5)];
  assert.deepEqual(orderQuotes(one), one);
});
await check('a quote well above the lowest is never drawn first, however the draw falls, and follows the others by fee', () => {
  const qs = [quote(1000, 1, 'dear'), quote(100, 1, 'cheap'), quote(300, 1, 'mid')];
  for (const r of [0, 0.3, 0.5, 0.99999]) assert.equal(orderQuotes(qs, () => r)[0].e.url, 'https://cheap.example');
  assert.deepEqual(urls(orderQuotes(qs, () => 0)), ['https://cheap.example', 'https://mid.example', 'https://dear.example']);
});
await check('quotes within the margin of the lowest are drawn from by weight, the dearer one scaled down by its price: the draw falls where the odds say', () => {
  const lo = 1000, edge = 1000 + Number(NEAR_PCT) * 10;       // exactly at the margin: still near, at 64% of the cheapest's odds (1 / 1.25 squared)
  const qs = [quote(lo, 1, 'a'), quote(edge, 3, 'b')];        // odds 1 : 3 x 0.64 = 1 : 1.92, so a is drawn below 1 / 2.92 = 0.3425
  assert.equal(orderQuotes(qs, () => 0.0)[0].e.url, 'https://a.example');
  assert.equal(orderQuotes(qs, () => 0.34)[0].e.url, 'https://a.example');
  assert.equal(orderQuotes(qs, () => 0.35)[0].e.url, 'https://b.example');
  assert.equal(orderQuotes(qs, () => 0.9999)[0].e.url, 'https://b.example');
  assert.deepEqual(urls(orderQuotes(qs, () => 0.9)), ['https://b.example', 'https://a.example'], 'the one not drawn follows');
});
await check('at equal weight a relay priced above the lowest is drawn less, in proportion to its price squared, and an equal price is an equal draw', () => {
  const qs = [quote(1000, 1, 'a'), quote(1250, 1, 'b')];      // a: 1, b: 0.64 -> a is drawn below 1 / 1.64 = 0.6098
  assert.equal(orderQuotes(qs, () => 0.6097)[0].e.url, 'https://a.example');
  assert.equal(orderQuotes(qs, () => 0.6099)[0].e.url, 'https://b.example');
  let a = 0, seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 20000; i++) if (orderQuotes(qs, rnd)[0].e.url === 'https://a.example') a++;
  assert.ok(Math.abs(a / 20000 - 0.6098) < 0.02, `a drew ${a / 20000}`);
  const same = [quote(500, 1, 'c'), quote(500, 1, 'd')];
  assert.equal(orderQuotes(same, () => 0.49)[0].e.url, 'https://c.example');
  assert.equal(orderQuotes(same, () => 0.51)[0].e.url, 'https://d.example');
});
await check('quotes of no fee are drawn as equals, not divided by zero', () => {
  const qs = [quote(0, 1, 'a'), quote(0, 1, 'b')];
  assert.equal(orderQuotes(qs, () => 0.49)[0].e.url, 'https://a.example');
  assert.equal(orderQuotes(qs, () => 0.51)[0].e.url, 'https://b.example');
});
await check('one fee unit over the margin is out of the draw', () => {
  const qs = [quote(1000, 1, 'a'), quote(1251, 1000, 'b')];       // 25.1% over, with a thousand times the weight
  for (const r of [0, 0.5, 0.9999]) assert.equal(orderQuotes(qs, () => r)[0].e.url, 'https://a.example');
});
await check('over many draws the shares follow the weights (3 : 1)', () => {
  const qs = [quote(100, 3, 'a'), quote(100, 1, 'b')];
  let a = 0, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const n = 4000;
  for (let i = 0; i < n; i++) if (orderQuotes(qs, rnd)[0].e.url === 'https://a.example') a++;
  assert.ok(Math.abs(a / n - 0.75) < 0.03, `share ${a / n}`);
});
await check('equal fees and weights are shared evenly, and a relay with the weight of a thousand does not shut the others out of its margin only by being listed first', () => {
  const qs = [quote(100, 1, 'a'), quote(100, 1, 'b')];
  assert.equal(orderQuotes(qs, () => 0.1)[0].e.url, 'https://a.example');
  assert.equal(orderQuotes(qs, () => 0.9)[0].e.url, 'https://b.example');
});
await check('fees are compared exactly, as whole numbers: no rounding at the sizes of wei', () => {
  const big = 10n ** 18n;
  const qs = [{ e: { url: 'https://a.example', weight: 1 }, q: { fee: String(big * 4n) } }, { e: { url: 'https://b.example', weight: 1 }, q: { fee: String(big * 5n + 1n) } }];
  assert.equal(orderQuotes(qs, () => 0.99)[0].e.url, 'https://a.example', '5e18 + 1 is over 125% of 4e18');
  const near = [qs[0], { e: { url: 'https://c.example', weight: 1 }, q: { fee: String(big * 5n) } }];
  assert.equal(orderQuotes(near, () => 0.99)[0].e.url, 'https://c.example', 'exactly 125% is near');
});

console.log('the Pay page');
await check('every relay the Pay page lists for a chain is pinned to an address, ends in /evm-pool/keeper, and is a place its policy lets it connect to', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
  const connect = /connect-src([^;"]*)/.exec(page)[1].split(/\s+/).filter(Boolean);
  const lists = [...page.matchAll(/keepers:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  for (const body of lists) {
    const entries = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
    for (const e of entries) {
      const url = /url:\s*'([^']+)'/.exec(e)?.[1], pin = /relayer:\s*'(0x[0-9a-fA-F]{40})'/.exec(e)?.[1];
      assert.ok(url && pin, `an entry needs its url and the address it is pinned to: ${e.trim()}`);
      assert.equal(relaysOf({ keepers: [{ url, relayer: pin }], pinned: true }).length, 1, `${url} is not a relay the wallet accepts`);
      assert.ok(connect.includes(new URL(url).origin) || connect.includes('https:'), `${new URL(url).origin} is not in the page's connect-src`);
    }
  }
  // the chain's own keeper (the one every chain names) is reachable too
  for (const m of page.matchAll(/keeper:\s*'(https:\/\/[^']+)'/g)) assert.ok(connect.includes(new URL(m[1]).origin), `${new URL(m[1]).origin} is not in connect-src`);
});

await check('a preferred relay wins among the near-cheapest, and a preferred one priced well above the cheapest does not', () => {
  const e = (url, w = 1) => ({ url, weight: w }), q = (fee) => ({ fee: String(fee) });
  const quotes = [{ e: e('https://a/x'), q: q(100) }, { e: e('https://b/x'), q: q(102) }, { e: e('https://c/x'), q: q(500) }];
  for (let i = 0; i < 30; i++) assert.equal(orderQuotes(quotes, Math.random, ['https://b/x/'])[0].e.url, 'https://b/x', 'b is within the near band: it is the pick');
  for (let i = 0; i < 30; i++) assert.notEqual(orderQuotes(quotes, Math.random, ['https://c/x'])[0].e.url, 'https://c/x', 'c is far dearer: preference does not lift it');
  const plain = orderQuotes(quotes, () => 0);
  assert.equal(plain[0].e.url, 'https://a/x', 'with no preference the order is as before');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
