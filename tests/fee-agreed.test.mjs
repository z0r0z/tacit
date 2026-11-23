// A withdrawal of private ETH or a token (dapp/index.html: hxUnwrapGo, hxXOutGo, hxSendPoolGo, and the unwrapNow / assetOutNow they end in) used to stop on ANY rise of the relay's fee between the
// figure on the card and the one asked for when the button was pressed: "The relay's fee moved while this was open. It is shown again: check it and press once more." The fee is worked out from
// a gas price and a prove cost that move a little every few seconds, so on 2026-11-23 about one press in two was stopped, one of them after a paid combine step (0.00021 became 0.00022 ETH).
// A rise of up to a quarter is now paid at the figure that was shown (what the person agreed to; the relay's own floor sits well under it) and only a bigger one stops to ask. The EVM-pool move
// (dapp/index.html poolOutNow, tests/front-move-teth-fee.test.mjs) already caps its fee at 1.25 times the quote: the same rule.
//   node --test tests/fee-agreed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '..', 'dapp', 'index.html'), 'utf8');
const between = (from, to) => { const a = page.indexOf(from), b = page.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `cannot find ${from} .. ${to}`); return page.slice(a, b); };
const m = /const feeAgreed = (\(now, shown\) => .*);\n/.exec(page);
assert.ok(m, 'feeAgreed is in the page');
const feeAgreed = new Function(`return ${m[1]}`)();

test('feeAgreed: the fresh fee when it is no higher, the shown one within a quarter above it, nothing beyond', () => {
  assert.equal(feeAgreed(21000n, 21000n), 21000n, 'the same');
  assert.equal(feeAgreed(19000n, 21000n), 19000n, 'lower: the person pays the lower fee');
  assert.equal(feeAgreed(22000n, 21000n), 21000n, 'one ladder step up (the case that stopped a withdrawal): paid at the figure shown');
  assert.equal(feeAgreed(24000n, 21000n), 21000n, 'up 14%');
  assert.equal(feeAgreed(26250n, 21000n), 21000n, 'up exactly a quarter');
  assert.equal(feeAgreed(26251n, 21000n), null, 'a unit more than a quarter stops to ask');
  assert.equal(feeAgreed(42000n, 21000n), null, 'a doubling stops to ask');
  assert.equal(feeAgreed(0n, 0n), 0n, 'a proof of one\'s own carries no relay fee');
  assert.equal(feeAgreed(1n, 0n), null, 'and a relay fee appearing where there was none stops to ask');
  assert.equal(feeAgreed(21000n, null), 21000n, 'nothing shown before: the fresh fee');
  assert.equal(feeAgreed(21000n, undefined), 21000n);
});

test('feeAgreed does not throw on a shown fee that is a plain number (a BigInt and a Number never mix in arithmetic): a withdrawal press must not die on a type', () => {
  assert.equal(feeAgreed(22000n, 21000), 21000, 'a step up from a number: paid at the shown figure');
  assert.equal(feeAgreed(30000n, 21000), null, 'a real jump from a number: asks');
  assert.equal(feeAgreed(19000n, 21000), 19000n);
});

test('feeAgreed never asks for more than the quarter, whatever the size: the fee a person pays is at most what they were shown, or the lower fresh one', () => {
  for (const shown of [1n, 4n, 19000n, 21000n, 10n ** 12n]) {
    for (const now of [0n, shown / 2n, shown, shown + 1n, shown + shown / 4n, shown + shown / 4n + 1n, shown * 3n]) {
      const a = feeAgreed(now, shown);
      if (a != null) assert.ok(a <= shown && a <= now, `shown ${shown}, now ${now}: pays ${a}`);
    }
  }
});

test('every withdrawal press uses it, and none of them still stops on a bare rise', () => {
  const unwrapGo = between('async function hxUnwrapGo(', 'async function hxChainShieldGo(');
  assert.match(unwrapGo, /agreed = feeAgreed\(fee, shown\);\n\s*if \(agreed == null\) \{ say\(st, 'The relay’s fee moved while this was open\./);
  assert.match(unwrapGo, /unwrapNow\(\{ run, x: \{ units, fee: agreed, minFee, own \}/);
  assert.doesNotMatch(unwrapGo, /shown != null && fee > shown/);

  const xOutGo = between('async function hxXOutGo(', 'async function usdtExitFee(');
  assert.match(xOutGo, /q = await xtOutQuote\(units\), agreed = feeAgreed\(q\.fee, shown\);/);
  assert.match(xOutGo, /if \(agreed == null\) \{ say\(st, 'The relay’s fee moved while this was open\./);
  assert.match(xOutGo, /fee: agreed, own: ownNow/);
  assert.doesNotMatch(xOutGo, /shown != null && q\.fee > shown/);

  const sendPoolGo = between('async function hxSendPoolGo(', 'async function hxSendBtcGo(');
  assert.match(sendPoolGo, /const agreed = feeAgreed\(q\.fee, shown\);\n\s*if \(agreed == null\)/);
  assert.match(sendPoolGo, /unwrapNow\(\{ run, x: \{ units, fee: agreed, minFee: q\.minFee, own: q\.own \}/);
  assert.match(sendPoolGo, /fee: agreed, own: q\.own/);
  assert.doesNotMatch(sendPoolGo, /shown != null && q\.fee > shown/);
});

test('the steps that run later (after a combine, minutes after the card) pay at the figure shown when the fresh fee is a little higher', () => {
  const assetOut = between('async function assetOutNow(', 'const SWAP_ASSETS');
  assert.match(assetOut, /now = t\.quoteUnwrapFee\(units, tk, \{ minFee \}\)\.fee, agreed = feeAgreed\(now, fee\);/);
  assert.match(assetOut, /if \(agreed == null\) throw Object\.assign\(new Error\(`The relay fee is now/);
  assert.match(assetOut, /feeOpts = \{ minFee: agreed < now \? agreed : minFee \};/);
  assert.doesNotMatch(assetOut, /if \(now > fee\)/);

  const unwrap = between('async function unwrapNow(', 'const EXIT_AHEAD =');
  assert.match(unwrap, /fee = t\.quoteUnwrapFee\(x\.units, 'cETH', \{ minFee \}\)\.fee, agreed = feeAgreed\(fee, x\.fee\);/);
  assert.match(unwrap, /if \(agreed == null\) throw Object\.assign\(new Error\(`The relay fee is now/);
  assert.match(unwrap, /feeOpts = \{ minFee: agreed < fee \? agreed : minFee \};/);
  assert.doesNotMatch(unwrap, /if \(fee > x\.fee\)/);
});

test('a rise beyond the quarter still stops with the old words and the two figures, so a real jump in the relay\'s price is never paid unseen', () => {
  const assetOut = between('async function assetOutNow(', 'const SWAP_ASSETS'), unwrap = between('async function unwrapNow(', 'const EXIT_AHEAD =');
  assert.match(assetOut, /up from \$\{fmt\(fee, 8, 8\)\}\. Your note is ready: check the new fee and press again\./);
  assert.match(unwrap, /up from \$\{fmt\(x\.fee, 8, 8\)\}\. Your note is ready: check the new fee and press again\./);
});

// The two steps every withdrawal ends in, cut out of the page and run against stand-ins: what fee is built into the op when the relay's fresh fee is the same, a step lower, a step higher, or a jump.
const stepsSrc = between('const feeAgreed =', 'const SWAP_ASSETS') + '\n' + between('async function unwrapNow(', 'const EXIT_AHEAD =');
async function press(kind, { shown, fresh }) {
  const calls = { send: [], failed: [] };
  const stubs = {
    fmt: (v) => String(v), short: (s) => String(s).slice(0, 8), shownAs: (t) => t, html: (s) => s.join(''), toast() {},
    getUx: async () => ({
      quoteOpFee: async () => fresh,
      quoteUnwrapFee: (u, tk, { minFee } = {}) => { const pct = (BigInt(u) * 30n + 9999n) / 10000n, floor = minFee == null ? 0n : BigInt(minFee), fee = pct > floor ? pct : floor; return { fee, net: BigInt(u) - fee }; },
      sendUnwrap: async (a) => { calls.send.push(a); return {}; },
    }),
    walletPriv: () => '0x' + '11'.repeat(32), recipientOf: (r) => r, noteFor: async (run, t, priv, u) => ({ value: u, leaf: '0xaa' }),
    sealOn: () => true, exitAheadReady: async () => null, EXIT_AHEAD: { at: 0, key: null, p: null },
    proveOr: async ({ relayed }) => relayed(), exitGo: () => () => {}, anyoneExit: () => () => {}, kNote: (n) => n.leaf, scanPrivate: async () => {}, POOL_TK: { tac: 'cTAC' },
  };
  const f = new Function('S', `with (S) { ${stepsSrc}; return { unwrapNow, assetOutNow }; }`)(stubs);
  const run = { go() {}, say() {}, wait: () => ({}), fail: (st, e) => calls.failed.push(e), to: { label: 'x' } };
  const units = 2_000_000n, common = { run, status: {}, line: () => ({}), sheet: '', clear() {}, after() {} };
  if (kind === 'unwrap') await f.unwrapNow({ ...common, x: { units, fee: shown, minFee: shown, own: false }, raw: '0x' + '22'.repeat(20), moved() {} });
  else await f.assetOutNow({ ...common, k: 'tac', label: 'l', units, recipient: '0x' + '22'.repeat(20), as: 'TAC', fee: shown }).catch((e) => calls.failed.push(e));   // assetOutNow throws to its caller (each has its own try/catch); unwrapNow says it itself
  return calls;
}
for (const kind of ['unwrap', 'asset']) {
  test(`${kind}: the fee built into the op is the figure shown, a lower fresh one, and never a higher one; a jump stops before anything is sent`, async () => {
    let c = await press(kind, { shown: 21000n, fresh: 21000n });
    assert.equal(c.send.length, 1); assert.equal(BigInt(c.send[0].feeOpts.minFee), 21000n, 'the same fee');
    c = await press(kind, { shown: 21000n, fresh: 22000n });
    assert.deepEqual(c.failed, [], 'a step up no longer stops the press'); assert.equal(c.send.length, 1);
    assert.equal(BigInt(c.send[0].feeOpts.minFee), 21000n, 'and it is sent at the figure that was shown, not the higher fresh one');
    c = await press(kind, { shown: 21000n, fresh: 26250n });
    assert.equal(BigInt(c.send[0].feeOpts.minFee), 21000n, 'a quarter up is still paid at the shown figure');
    c = await press(kind, { shown: 21000n, fresh: 19000n });
    assert.equal(BigInt(c.send[0].feeOpts.minFee), 19000n, 'a lower fresh fee is the one paid');
    c = await press(kind, { shown: 21000n, fresh: 30000n });
    assert.equal(c.send.length, 0, 'a jump sends nothing');
    assert.equal(c.failed.length, 1); assert.equal(c.failed[0].feeMoved, true, 'and says the fee moved, with both figures');
    assert.match(c.failed[0].message, /30000.*up from.*21000/);
  });
}
