// The front page's "Move ETH into tETH" press (Pay pool -> Tacit pool, dapp/index.html poolOutNow with dest 'v1').
//
// The relay prices its fee by gas, and the wallet's toV1 asks it for a quote at 700,000 gas (a plain withdrawal's quote is at 450,000): 1.56 times as much. The press caps the fee
// it will pay at 1.25 times the quote at the move's own gas, not the plain quote (a cap under the move's price refuses every press with "The relay fee changed to ... Check it and
// press again."), and the card's fee row shows that fee. A fee that really did move is said with the fee it was and the fee it is.
//
// The page's functions are cut out of dapp/index.html and run against stand-ins for what they touch; the stand-in wallet refuses a quote above its cap the way toV1's quoteFor does.
//
// Run: node tests/front-move-teth-fee.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontPage } from './lib/front-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = frontPage(join(ROOT, 'dapp/index.html'));
const wallet = readFileSync(join(ROOT, 'dapp/evm-pool-wallet.js'), 'utf8');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const between = (from, to) => {
  const a = page.indexOf(from), b = page.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)} in dapp/index.html`);
  return page.slice(a, b);
};
const src = between('const V1_MOVE_GAS', 'async function hxSendPoolOutGo') + '\n' + between('function hxMoveRows', 'function hxHandoff');

// The relay: a fee per gas (what a quote at 450,000 gas costs is the plain quote), as the keeper's /quote does.
const PER_GAS = 271_000_000n, PLAIN_GAS = 450_000n;
const feeFor = (gas) => PER_GAS * BigInt(gas ?? PLAIN_GAS);

function make({ bal = 10n ** 18n, onSend = null, h = '0xhash' } = {}) {
  const log = { quotes: [], sends: [], said: [], redraw: 0, links: 0 };
  const DEV = { chain: { chainId: 1, keeper: 'k' }, quote: null, gq: {}, bal, self: false, W: null };
  const W = {
    quote: async (gas) => { log.quotes.push(gas ?? null); return { fee: String(feeFor(gas)), gas: String(gas ?? PLAIN_GAS) }; },
    notes: () => [{ v: String(bal) }],
  };
  DEV.W = W;
  const html = (s, ...v) => s.reduce((a, x, i) => a + x + (v[i] ?? ''), '');
  const stubs = {
    say: (_, t) => log.said.push(String(t)), html, your: () => 'your wallet', HX: { tab: 'swap', mode: 'ppv1' }, DEV, HXD: {},
    hxQuoteSoon: () => { log.redraw++; }, PROVE_AT: {}, E10: 10n ** 10n,
    parseUnits: (s) => BigInt(Math.round(Number(s) * 1e8)) * 10n ** 10n,
    setDeviceChain: () => {}, deviceSync: async () => {}, keeperRead: async () => {}, keeperDown: () => false,
    deviceWallet: async () => W, getDeviceMods: async () => ({ mergePlan: () => [0] }), payingAccount: async () => '0xabc',
    // toV1 / withdraw as the wallet does them: the quote is asked at the call's gas, and refused above the cap
    devOutSend: async ({ dest, maxFee }) => {
      const gas = dest === 'v1' ? 700_000 : null, q = await W.quote(gas);
      log.sends.push({ dest, gas, maxFee });
      if (onSend) onSend(q);
      if (maxFee != null && BigInt(q.fee) > maxFee) throw Object.assign(new Error('The relay fee went up since it was shown. Check the new fee and try again.'), { feeMoved: BigInt(q.fee) });
      return { h, done: 'Moved.' };
    },
    waitTx: async () => {}, txLink: () => { log.links++; return '[link]'; }, PB: { at: {} }, hxWalletBals: () => {}, payBals: async () => {}, txFail: (_, __, e) => { throw e; },
    waitRanOut: () => false, keeperTrouble: () => false, errText: (e) => String(e.message || e),
    fmt: (v, d, dp) => (Number(v) / 10 ** d).toFixed(dp),
  };
  const scope = new Proxy(stubs, { has: (t, k) => typeof k === 'string' && k in t });
  const fns = new Function('scope', `with (scope) { ${src}\nreturn { poolOutNow, hxMoveRows, V1_MOVE_GAS }; }`)(scope);
  const press = (dest, amt = '0.001') => fns.poolOutNow({ run: {}, c: DEV.chain, dest, amt, st: {}, clear: () => {}, after: () => {} });
  return { ...fns, press, log, DEV };
}

console.log('front page: Move ETH into tETH fee\n');

await test('the page asks for the same gas as the wallet\'s toV1', () => {
  const m = wallet.match(/async toV1\([\s\S]*?quoteFor\(via, ([\d_]+), maxFee\)/);
  ok(m, 'toV1 no longer quotes with quoteFor(via, <gas>, maxFee)');
  const t = make();
  ok(Number(m[1].replace(/_/g, '')) === t.V1_MOVE_GAS, `toV1 quotes at ${m[1]}, the page at ${t.V1_MOVE_GAS}`);
});

await test('a plain quote is not what a move into tETH is capped by (the old cap was always under its price)', () => {
  ok(feeFor(700_000) > (feeFor(null) * 5n) / 4n, 'the stand-in relay no longer prices the move above 1.25 x the plain quote');
});

await test('the press reads the quote at the move\'s gas and goes through', async () => {
  const t = make();
  await t.press('v1');
  ok(t.log.quotes.includes(700_000), `quotes asked: ${t.log.quotes}`);
  ok(!t.log.quotes.includes(null), 'a plain quote was read for a move into tETH');
  ok(t.log.sends.length === 1 && t.log.sends[0].maxFee === (feeFor(700_000) * 5n) / 4n, `cap ${t.log.sends[0]?.maxFee}`);
  ok(/Moved\./.test(t.log.said.at(-1)), `said ${t.log.said.at(-1)}`);
  ok(!t.log.said.some((x) => /fee/.test(x)), `a fee message appeared: ${t.log.said}`);
  ok(t.log.links === 1 && /\[link\]/.test(t.log.said.at(-1)), 'the transaction was not linked');
});

await test('a move that landed with no hash to show (its answer was lost) says it is done, with no link', async () => {
  const t = make({ h: null });
  await t.press('v1');
  ok(/Moved\./.test(t.log.said.at(-1)), `said ${t.log.said.at(-1)}`);
  ok(t.log.links === 0 && !/\[link\]|undefined|null/.test(t.log.said.at(-1)), `said ${t.log.said.at(-1)}, links ${t.log.links}`);
});

await test('a press that is told the fee moved says what it was and now is, and the next press goes through', async () => {
  let hike = true;
  const t = make({ onSend: (q) => { if (hike) { hike = false; q.fee = String(BigInt(q.fee) * 2n); } } });
  await t.press('v1');
  const said = t.log.said.at(-1);
  ok(/now 0\.000379 ETH, up from 0\.000190\./.test(said), `said ${said}`);
  ok(/Check it and press again/.test(said), `said ${said}`);
  ok(t.DEV.quote === null && Object.keys(t.DEV.gq).length === 0, 'the quotes were kept');
  ok(t.log.redraw === 1, 'the card was not told to read the fee again');
  await t.press('v1');
  ok(/Moved\./.test(t.log.said.at(-1)), `second press said ${t.log.said.at(-1)}`);
});

await test('a withdrawal to an address is still capped by the plain quote', async () => {
  const t = make();
  await t.press('addr');
  ok(t.log.quotes.length > 0 && t.log.quotes.every((g) => g === null), `quotes asked: ${t.log.quotes}`);
  ok(t.log.sends[0].maxFee === (feeFor(null) * 5n) / 4n, `cap ${t.log.sends[0].maxFee}`);
});

await test('sent from the wallet: no quote is read and no fee is capped', async () => {
  const t = make();
  t.DEV.self = true;
  await t.press('v1');
  ok(t.log.sends[0].maxFee === null, `cap ${t.log.sends[0].maxFee}`);
});

await test('a relay fee of 0 is a cap of 0, so a later fee is shown before it is paid', async () => {
  const t = make();
  t.DEV.W.quote = async (gas) => { t.log.quotes.push(gas ?? null); return { fee: '0', gas: String(gas ?? PLAIN_GAS) }; };
  await t.press('addr');
  ok(t.log.sends[0].maxFee === 0n, `cap ${t.log.sends[0].maxFee}`);
});

await test('the private-ETH sheets cap a relay fee of 0 at 0 too', () => {
  const sheets = readFileSync(join(ROOT, 'dapp/front/sheets.js'), 'utf8');
  const caps = [...sheets.matchAll(/const capOf = \(fee\) => ([^;]+);/g)].map((m) => new Function('fee', `return ${m[1]};`));
  ok(caps.length >= 2, `capOf found ${caps.length} times`);
  for (const capOf of caps) ok(capOf(0n) === 0n && capOf(null) === null && capOf(4n) === 5n, String(capOf));
});

await test('the card\'s fee row shows the relay fee, or that the wallet sends it, or "shown next" until read', () => {
  const t = make();
  const h = { go: 'Move ETH into tETH', rc: [['Arrives', 'tETH'], ['Chain sees', 'no public stop on the way'], ['Relay fee', 'shown next']] };
  const row = (x) => x.rc.find((r) => r[0] === 'Relay fee' || r[0] === 'Sent from');
  ok(row(t.hxMoveRows(h, feeFor(700_000)))[1] === 'about 0.000190 ETH', JSON.stringify(row(t.hxMoveRows(h, feeFor(700_000)))));
  ok(row(t.hxMoveRows(h, 'self'))[0] === 'Sent from', JSON.stringify(row(t.hxMoveRows(h, 'self'))));
  ok(t.hxMoveRows(h, null) === h && row(h)[1] === 'shown next', 'an unread fee changed the card');
  ok(t.hxMoveRows(h, feeFor(700_000)).rc.length === 3, 'a row was added or lost');
});

// The fee row when the relay's fee could not be read: a failed read is kept 5 s (a good one 60 s), and the card asks again, a bounded number of times.
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
function feeReader(answers) {
  const log = { fetched: 0 }, clock = { now: 1_000_000 };
  const scope = {
    HXD: {}, Date: { now: () => clock.now }, AbortSignal,
    fetch: async () => { const a = answers[Math.min(log.fetched++, answers.length - 1)]; if (a === 'down') throw new TypeError('Failed to fetch'); return a; },
  };
  const f = new Function('scope', `with (scope) { ${between('function hxDevFee', 'const hxDevKeep')}\nreturn { hxDevFee }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));
  const p = { slug: 1, keeper: 'https://k.test', pool: POOL };
  return { ask: () => f.hxDevFee(p), log, at: (s) => { clock.now = 1_000_000 + s * 1000; } };
}
const quote = (fee) => ({ ok: true, json: async () => ({ pool: POOL, fee: String(fee) }) });

await test('a fee read that failed is asked again after 5 s, a good one is kept for 60 s', async () => {
  const r = feeReader(['down', quote(190_000_000_000_000n)]);
  ok(await r.ask() === null && r.log.fetched === 1, 'the failed read');
  r.at(3); ok(await r.ask() === null && r.log.fetched === 1, 'asked again within 5 s');
  r.at(6); ok(await r.ask() === 190_000_000_000_000n && r.log.fetched === 2, `not asked again after 5 s (fetched ${r.log.fetched})`);
  r.at(40); ok(await r.ask() === 190_000_000_000_000n && r.log.fetched === 2, 'a good read was asked again inside 60 s');
  r.at(70); await r.ask(); ok(r.log.fetched === 3, 'a good read was kept past 60 s');
});

await test('a relay answer that is an error, or names another pool, counts as a failed read and is asked again after 5 s', async () => {
  const r = feeReader([{ ok: false, json: async () => ({}) }, { ok: true, json: async () => ({ pool: '0x' + '9'.repeat(40), fee: '5' }) }, quote(7n)]);
  ok(await r.ask() === null, 'an error answer');
  r.at(6); ok(await r.ask() === null && r.log.fetched === 2, 'another pool\'s answer');
  r.at(12); ok(await r.ask() === 7n && r.log.fetched === 3, 'the good answer');
});

function retrier({ mode = 'ppv1' } = {}) {
  const log = { timers: [], cleared: 0, asked: 0 };
  const scope = {
    HX: { mode }, hxQuoteSoon: (now) => { log.asked++; log.now = now; },
    setTimeout: (f, ms) => { const id = log.timers.length + 1; log.timers.push({ f, ms, id, live: true }); return id; },
    clearTimeout: (id) => { log.cleared++; const t = log.timers.find((x) => x.id === id); if (t) t.live = false; },
  };
  const f = new Function('scope', `with (scope) { ${between('const HXF = {', 'function hxHandoff')}\nreturn { hxFeeRetry, HXF }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));
  const fire = () => { const t = [...log.timers].reverse().find((x) => x.live); if (!t) return false; t.live = false; t.f(); return true; };
  return { ...f, log, fire, hx: scope.HX };
}

await test('an unread fee is asked for again in six seconds, and that asks the card to quote at once', () => {
  const t = retrier();
  t.hxFeeRetry(false, '1000000');
  ok(t.log.timers.length === 1 && t.log.timers[0].ms === 6000, JSON.stringify(t.log.timers.map((x) => x.ms)));
  ok(t.fire() && t.log.asked === 1 && t.log.now === true, 'the card was not asked to quote');
});

await test('a fee that was read asks for nothing, and cancels a pending ask', () => {
  const t = retrier();
  t.hxFeeRetry(false, '1000000');
  t.hxFeeRetry(true, '1000000');
  ok(!t.fire() && t.log.asked === 0, 'asked after the fee was read');
});

await test('it asks six times for one amount, then stops, and a new amount starts again', () => {
  const t = retrier();
  for (let i = 0; i < 9; i++) { t.hxFeeRetry(false, '1000000'); t.fire(); }
  ok(t.log.asked === 6, `asked ${t.log.asked} times for one amount`);
  t.hxFeeRetry(false, '2000000');
  ok(t.fire() && t.log.asked === 7, 'a new amount did not start again');
});

await test('a fee read for an older ask does not leave two timers running', () => {
  const t = retrier();
  t.hxFeeRetry(false, '1000000');
  t.hxFeeRetry(false, '1000000');
  ok(t.log.timers.filter((x) => x.live).length === 1, 'two timers are live');
});

await test('once the card has left the move into tETH, the ask is not made', () => {
  const t = retrier();
  t.hxFeeRetry(false, '1000000');
  t.hx.mode = 'swap';
  ok(t.fire() && t.log.asked === 0, 'asked for a card that is no longer there');
});

await test('the card\'s move branch reads the fee, asks again only for the quote that is current, and never for a missing wallet', () => {
  const branch = between("if (m === 'ppv1' && units) {", '{ const h = hxHandoff(m, units)');
  ok(/hxDevFee\(hxPp\(\)\)/.test(branch), 'does not read the fee');
  ok(/if \(my === HX\.seq\) hxFeeRetry\(!!fee \|\| !S\.key, String\(units\)\)/.test(branch), 'the retry is not tied to the current quote');
  ok(/return done\(hxMoveRows\(hxHandoff\(m, units\), fee\)\)/.test(branch), 'the row is not painted with the fee');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
