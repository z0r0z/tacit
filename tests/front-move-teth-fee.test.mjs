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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'dapp/index.html'), 'utf8');
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

function make({ bal = 10n ** 18n, onSend = null } = {}) {
  const log = { quotes: [], sends: [], said: [], redraw: 0 };
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
      return { h: '0xhash', done: 'Moved.' };
    },
    waitTx: async () => {}, txLink: () => '', PB: { at: {} }, hxWalletBals: () => {}, payBals: async () => {}, txFail: (_, __, e) => { throw e; },
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

await test('the card\'s fee row shows the relay fee, or that the wallet sends it, or "shown next" until read', () => {
  const t = make();
  const h = { go: 'Move ETH into tETH', rc: [['Arrives', 'tETH'], ['Chain sees', 'no public stop on the way'], ['Relay fee', 'shown next']] };
  const row = (x) => x.rc.find((r) => r[0] === 'Relay fee' || r[0] === 'Sent from');
  ok(row(t.hxMoveRows(h, feeFor(700_000)))[1] === 'about 0.000190 ETH', JSON.stringify(row(t.hxMoveRows(h, feeFor(700_000)))));
  ok(row(t.hxMoveRows(h, 'self'))[0] === 'Sent from', JSON.stringify(row(t.hxMoveRows(h, 'self'))));
  ok(t.hxMoveRows(h, null) === h && row(h)[1] === 'shown next', 'an unread fee changed the card');
  ok(t.hxMoveRows(h, feeFor(700_000)).rc.length === 3, 'a row was added or lost');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
