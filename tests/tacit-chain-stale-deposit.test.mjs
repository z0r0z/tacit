// A pool move whose deposit no block can take in (dapp/tacit-chain-client.js depositStale; dapp/index.html chainKeptRead, chainKeptNote).
//
// 2026-11-17 a move of 360.56 TAC out of the private pool was swept into the chain contract, and the leader that swept it refused its spend a moment later (a
// restart, a fee that had moved 0.76%). The spend asked for 35,569,874,769 shares for 36,056,009,626 units. The pool's rate rose with every block, and 3.8 days
// on, those units no longer bought those shares: the contract counts such a deposit stale and sends it back at once, and the block program passes over a spend
// posted for it. The page kept offering "Post it to Ethereum yourself" (11-22: posted, passed over), then said "It was posted to Ethereum" with nothing to press, and
// showed "Take it back" only a week after the sweep.
//
// The page now reads the deposit's staleness from the contract, offers the way back at once and no posting, and says when a posting was passed over.
//
// Run: node tests/tacit-chain-stale-deposit.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { depositStale } from '../dapp/tacit-chain-client.js';
import { frontPage } from './lib/front-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = frontPage(join(ROOT, 'dapp/index.html'));

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m}: expected ${b}, got ${a}`); };

const between = (src, from, to, name) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)} in ${name}`);
  return src.slice(a, b);
};
const run = (src, scope, expose) => new Function('scope', `with (scope) { ${src}\nreturn { ${expose} }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));

// the page's own html helper, so the callouts are what the page builds
const htmlSrc = between(page, 'class Raw', 'const html = ', 'dapp/index.html') + page.slice(page.indexOf('const html = '), page.indexOf('\n', page.indexOf('const html = ')));
const { html } = run(htmlSrc, {}, 'html');

// the deposit of 2026-11-17 and the pool's rate at the sweep (chain height 411) and on 11-23 (height 905), read from the contract
const DEP = { shares: '35569874769', amount: '36056009626' };
const AT_SWEEP = { pool: '2514615930895', shares: '2481206857769' };
const NOW = { pool: '6760592801099', shares: '6650961798670' };

await test('the deposit of 11-17 was takeable when swept and is stale now', () => {
  ok(!depositStale(DEP, AT_SWEEP), 'takeable at the rate it was made at');
  ok(depositStale(DEP, NOW), 'stale at the rate of 11-23 (its units buy 35,471,327,464 shares, 0.28% short)');
});

await test('stale is strict: a deposit that buys exactly its shares is not stale', () => {
  // a rate with no pool or shares counts only the virtual unit on each side: one unit buys one share
  ok(!depositStale({ shares: '1000', amount: '1000' }, { pool: '0', shares: '0' }), 'exactly its shares');
  ok(depositStale({ shares: '1001', amount: '1000' }, { pool: '0', shares: '0' }), 'one share more than it buys');
  ok(!depositStale({ shares: '999', amount: '1000' }, { pool: '0', shares: '0' }), 'a share fewer than it buys');
});

// chainKeptRead against a client whose contract reads are `states` (by deposit amount) and whose kept list is `list`
const readSrc = between(page, 'async function chainKeptRead', 'const chainSpan', 'dapp/index.html');
async function read(list, states, { inbox = null } = {}) {
  const forgot = [], mine = { p: null, kept: null, hops: [] };
  const c = {
    pending: async () => list.map((e) => ({ ...e })),
    reclaimAfter: async () => 604800,
    depositState: async (d) => states[d.amount],
    inboxState: async () => inbox,
    forget: async (id) => forgot.push(id),
    hopsWaiting: async () => [],
  };
  mine.p = Promise.resolve(c);
  const { chainKeptRead } = run(readSrc, { CH: mine, E10: 10n ** 10n, hxPathPaint() {}, dashSoon() {} }, 'chainKeptRead');
  return { out: await chainKeptRead(c), forgot };
}
const entry = (id, amount, extra = {}) => ({ id, deposit: { amount, shares: '1' }, at: 1, inbox: '0x1d674a1d5ec50cd0d82bc4028b6e219c7f0f2f8f', ...extra });
const live = (o) => ({ from: '0x1d674a1d5ec50cd0d82bc4028b6e219c7f0f2f8f', at: 1_794_918_347, forced: 0, stale: false, done: 1, ...o });

await test('a stale deposit is marked stale and may go back at once, not a week after the sweep', async () => {
  const { out } = await read([entry('a', '1')], { 1: live({ stale: true }) });
  eq(out.length, 1, 'kept');
  ok(out[0].stale, 'marked stale');
  eq(out[0].backAt, 1_794_918_347, 'backAt is the sweep, already past');
});

await test('a deposit that can still land waits RECLAIM_AFTER to go back, and is not stale', async () => {
  const { out } = await read([entry('a', '1')], { 1: live({}) });
  ok(!out[0].stale && !out[0].passed, 'neither stale nor passed');
  eq(out[0].backAt, 1_794_918_347 + 604800, 'a week after the sweep');
});

await test('a posting the chain has taken past (forced <= queueDone) with the deposit still waiting is marked passed', async () => {
  const { out } = await read([entry('a', '1', { forced: { tx: '0x1', at: 1 } })], { 1: live({ forced: 1, done: 1 }) });
  ok(out[0].passed, 'passed over');
  const wait = await read([entry('a', '1')], { 1: live({ forced: 2, done: 1 }) });
  ok(!wait.out[0].passed, 'a posting still in the queue is not passed over');
  const never = await read([entry('a', '1')], { 1: live({ forced: 0, done: 5 }) });
  ok(!never.out[0].passed, 'nothing posted is not passed over');
  const unread = await read([entry('a', '1')], { 1: live({ done: null, forced: 1 }) });
  ok(!unread.out[0].passed, 'a queue position that could not be read is not read as passed');
});

await test('a deposit no longer waiting on Ethereum is forgotten (landed or given back), stale or not', async () => {
  const { out, forgot } = await read([entry('a', '1')], { 1: { from: '0x' + '0'.repeat(40), at: 0, forced: 0, stale: true, done: 1 } }, { inbox: { swept: true, held: 0n } });
  eq(out.length, 0, 'not listed');
  eq(forgot.join(), 'a', 'forgotten');
});

await test('a read of the contract that fails leaves the entry as it was, not stale', async () => {
  const { out } = await read([entry('a', '1')], {});
  ok(!out[0].stale && !out[0].passed && out[0].backAt == null, 'no state read, nothing claimed');
});

// what each kept spend says and offers
const noteSrc = between(page, 'const chainKeptNote', 'function chainKeptPaint', 'dapp/index.html');
const { chainKeptNote } = run(noteSrc, { html, chainWhat: () => 'A move of 360.56 TAC from the private pool' }, 'chainKeptNote');
const note = (e, now = 2e9) => chainKeptNote({ id: 'a', ...e }, now, false).s;
const NOW_S = 1_795_438_088, WEEK = 604800;

await test('a stale spend offers Take it back and no posting, whether or not a posting was made', () => {
  for (const e of [{ stale: true, backAt: 1_794_918_347 }, { stale: true, forced: { tx: '0x1' }, backAt: 1_794_918_347 }]) {
    const s = note(e, NOW_S);
    ok(/data-chainback="a"/.test(s), 'Take it back');
    ok(!/data-chainforce/.test(s), 'no posting offered');
    ok(/can no longer land/.test(s), 'says why');
  }
  ok(/passed over the one posted/.test(note({ stale: true, forced: { tx: '0x1' }, backAt: 1 }, NOW_S)), 'says the posting was passed over');
});

await test('a spend that can still land may be posted; once posted it says so and offers no second posting', () => {
  const fresh = note({ backAt: NOW_S + WEEK }, NOW_S);
  ok(/data-chainforce="a"/.test(fresh) && !/data-chainback/.test(fresh), 'posting only, not yet takeable back');
  const posted = note({ forced: { tx: '0x1' }, backAt: NOW_S + WEEK }, NOW_S);
  ok(/It was posted to Ethereum\./.test(posted) && !/data-chainforce/.test(posted), 'posted, no second button');
  const passed = note({ forced: { tx: '0x1' }, passed: true, backAt: NOW_S + WEEK }, NOW_S);
  ok(/passed it over/.test(passed) && !/data-chainforce/.test(passed), 'passed over, says so');
  const later = note({ forced: { tx: '0x1' }, passed: true, backAt: NOW_S - 1 }, NOW_S);
  ok(/data-chainback="a"/.test(later), 'Take it back once the contract allows it');
});

await test('a swept inbox the leader has yet to land is unchanged', () => {
  const s = chainKeptNote({ id: 'a', unswept: true, paid: true }, 2e9, true).s;
  ok(/is on its way/.test(s) && /data-chainsweep="a"/.test(s), 'on its way, with the sweep');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
