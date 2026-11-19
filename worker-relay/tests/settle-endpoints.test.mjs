// How the settle relay reaches the chain (src/lib/config.js settleRpcUrls, src/lib/chain.js, src/settle-relay.js round loop).
//
// 2026-11-19: a wrap's settle took minutes. MEV Blocker rate-limited the relay (its shared egress address) on every round, and Flashbots Protect in its default mode took the
// transaction and did not include it; with those two the only routes, nothing else was tried. Now five private routes are offered every settle at once, nothing retries behind
// the rounds' back (viem's default asks a failing endpoint three more times, which a rate-limited one counts as four requests), a rate limit gets one backoff retry while nothing
// has taken the transaction, rounds are a few blocks, and with SETTLE_ALLOW_PUBLIC=1 the last round offers the public mempool as well.
//
//   node worker-relay/tests/settle-endpoints.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.RPC_URL ||= 'https://rpc.invalid';
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');
const relay = read('src/settle-relay.js'), chain = read('src/lib/chain.js'), config = read('src/lib/config.js'), yaml = read('render.yaml');
const { privateSettleUrl } = await import('../src/lib/config.js');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

const DEFAULTS = ['https://rpc.flashbots.net/fast?hint=hash', 'https://rpc.mevblocker.io/fullprivacy', 'https://rpc.beaverbuild.org', 'https://rpc.titanbuilder.xyz', 'https://rpc.lightspeedbuilder.info'];

test('five independent private routes by default, each a different operator', () => {
  const m = /settleRpcUrls: opt\('SETTLE_RPC_URLS', '([^']+)'\)/.exec(config);
  assert.ok(m, 'default list not found');
  assert.deepEqual(m[1].split(','), DEFAULTS);
  assert.equal(new Set(DEFAULTS.map((u) => new URL(u).hostname)).size, 5);
});

test('each route is used in its private mode: Flashbots shares only the hash, MEV Blocker its full-privacy path, builders as they are', () => {
  assert.equal(privateSettleUrl('https://rpc.flashbots.net/fast?hint=hash'), 'https://rpc.flashbots.net/fast?hint=hash');
  assert.equal(privateSettleUrl('https://rpc.flashbots.net/fast'), 'https://rpc.flashbots.net/fast?hint=hash');
  assert.equal(privateSettleUrl('https://rpc.mevblocker.io'), 'https://rpc.mevblocker.io/fullprivacy');
  for (const u of DEFAULTS.slice(2)) assert.equal(privateSettleUrl(u), new URL(u).toString());
});

test('the deployed blueprint lists the same routes, so a redeploy from it does not shrink them to two', () => {
  const lines = yaml.split('\n').filter((l, i, a) => /key: SETTLE_RPC_URLS/.test(a[i - 1] || '') && /value:/.test(l));
  assert.equal(lines.length, 2, 'the settle service and the buyback keeper each carry one');
  for (const u of DEFAULTS) assert.ok(lines[0].includes(new URL(u).hostname), `${new URL(u).hostname} missing from the settle service's list`);
  // the buyback keeper sends value-bearing swaps: a builder reached directly could sandwich one, so it keeps only the two protecting services
  assert.ok(!/beaverbuild|titanbuilder|lightspeed/.test(lines[1]), 'the buyback keeper was given direct builders');
  assert.match(yaml, /key: SETTLE_RECEIPT_WAIT_MS\n\s+value: "24000"/);
});

test('nothing retries behind the rounds: the private transports have viem\'s own retries off, and a time limit', () => {
  assert.match(chain, /http\(url, \{ retryCount: 0, timeout: 10_000 \}\)/);
});

test('a rate limit is its own answer, retried once after a pause and only while no endpoint has the transaction', () => {
  assert.match(relay, /if \(isRateLimited\(e\)\) return 'limited';/);
  assert.match(relay, /if \(!txHash && !taken && RATE_LIMIT_BACKOFF_MS > 0 && outs\.includes\('limited'\)\)/);
  assert.match(relay, /await sleep\(\(RATE_LIMIT_BACKOFF_MS \+ Math\.floor\(Math\.random\(\) \* RATE_LIMIT_BACKOFF_MS\)\) \/ 1000\);/, 'this file\'s sleep takes SECONDS: a millisecond count would sleep for most of an hour');
  assert.match(relay, /const sleep = \(s\) => new Promise\(\(r\) => setTimeout\(r, s \* 1000\)\);/, 'the unit of sleep changed under the backoff');
});

test('rounds are a few blocks (down to 12 s), and the public mempool joins the last round even when a private route took it', () => {
  assert.match(relay, /Math\.max\(12_000, parseInt\(process\.env\.SETTLE_RECEIPT_WAIT_MS \|\| '90000', 10\)\)/);
  assert.match(relay, /if \(!taken && pub\.length && \(!txHash \|\| round \+ 1 >= PUBLIC_FROM_ROUND\)\) \{/);
  assert.match(relay, /const PUBLIC_FROM_ROUND = Math\.max\(1, parseInt\(process\.env\.SETTLE_PUBLIC_FROM_ROUND \|\| String\(Math\.max\(1, parseInt\(process\.env\.SETTLE_SUBMIT_ROUNDS \|\| '3', 10\)\)\), 10\)\);/);
  assert.match(config, /settleAllowPublic: opt\('SETTLE_ALLOW_PUBLIC', '0'\) === '1'/, 'the public mempool stays off unless asked for');
});

test('only a real transaction hash is kept from a route\'s answer (a builder may answer null or an object)', () => {
  assert.match(relay, /const real = typeof h === 'string' && \/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(h\);/);
  assert.match(relay, /if \(real\) \{ if \(!seen\.includes\(h\)\) seen\.push\(h\); txHash \|\|= h; \}/);
  const real = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
  for (const bad of [null, undefined, {}, [], '0x', '0x1234', 'null', 42]) assert.equal(real(bad), false, String(bad));
  assert.equal(real('0x' + 'ab'.repeat(32)), true);
});

console.log(`${n} passed`);
