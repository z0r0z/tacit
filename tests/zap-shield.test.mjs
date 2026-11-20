// The SPX page's "Buy and shield" as ONE transaction (ConfidentialRouter.zapETHToShieldedNote, selector 0x65dcbb8e, already on mainnet):
//   route.js    zapShieldPlan reads a quote whose swap pays the ROUTER (real zQuoter answers in tests/fixtures/zap-shield-quotes.json, one a Uniswap v3 swap and one a v2):
//               the note is the swap's least in whole pool units, and every way of sending a different call is refused (another recipient, token, ETH amount, deadline, a floor
//               under the note)
//   card.js     zapOne reads the swap again with the router as recipient and hands the host the plan; any "no" before the host starts hands the press to the two steps
//   index.html  xtZapDeposit runs the exact call as a call first and sends nothing when it would revert; xtWrapNow settles that deposit as it settles any other (the relay's way,
//               never prove-first), says a revert as "nothing was bought", and a deposit step that throws zapFallback ends it with false and no sound; xtZapShield offers the one
//               transaction only when it can be made here
//   Nothing is sent anywhere: the wallet, the relay and the RPC are stubs.
//   node --test tests/zap-shield.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as R from '../dapp/swap/route.js';
import { decodeZRouterCall } from '../dapp/zrouter-guard.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const cardSrc = readFileSync(new URL('../dapp/swap/card.js', import.meta.url), 'utf8');
const frontSrc = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/zap-shield-quotes.json', import.meta.url), 'utf8'));

const SPX = '0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C', OTHER = '0x' + 'ba'.repeat(20), ROUTER = R.CONF_ROUTER, WALLET = '0x' + '0a'.repeat(20);
const quoteOf = (f) => ({ callData: f.callData, amountOut: BigInt(f.amountOut), amountLimit: BigInt(f.amountLimit), msgValue: BigInt(f.msgValue), deadline: BigInt(f.deadline), tokenOut: f.tokenOut, to: ROUTER, name: 'a pool' });
const planOf = (f, over = {}) => R.zapShieldPlan({ quote: quoteOf(f), tokenOut: f.tokenOut, wei: BigInt(f.wei), scale: 1n, ...over });
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

// ── zapShieldPlan, on the quoter's own answers ──
test('zapWrapAmount cuts the swap\'s least down to whole pool units, and to nothing under one', () => {
  assert.strictEqual(R.zapWrapAmount(237438733n, 1n), 237438733n, 'a token the pool counts in its own units (SPX: scale 1) loses nothing');
  assert.strictEqual(R.zapWrapAmount(12345678901234567n, 10n ** 10n), 12345670000000000n, 'an 18-decimals token at scale 1e10 is cut to a multiple of it');
  assert.strictEqual(R.zapWrapAmount(9999999999n, 10n ** 10n), 0n, 'under one unit there is no note');
  assert.strictEqual(R.zapWrapAmount(5n, 0n), 0n, 'no scale, no note');
  assert.strictEqual(R.zapWrapAmount('237438733', '1'), 237438733n, 'strings are read as numbers');
});

for (const f of fixtures) {
  test(`zapShieldPlan accepts the router-paid quote: ${f.label}`, () => {
    const p = planOf(f);
    assert.ok(!p.why, `accepted (${p.why})`);
    assert.strictEqual(p.wrapAmount, BigInt(f.amountLimit), 'the note is exactly the swap\'s least');
    assert.strictEqual(p.value, BigInt(f.wei), 'all the ETH typed is sent');
    assert.strictEqual(p.zrSwapData, f.callData, 'the swap is the quoter\'s own bytes');
    assert.strictEqual(p.to.toLowerCase(), ROUTER.toLowerCase(), 'for the router');
    assert.strictEqual(p.rest, BigInt(f.amountOut) - BigInt(f.amountLimit), 'what comes back above the note, as the quote expects it');
    assert.ok(p.rest > 0n && p.rest < p.wrapAmount, 'a small share of the buy');
  });
  test(`zapShieldPlan reads the swap again whatever the quote says: ${f.label}`, () => {
    const call = decodeZRouterCall(f.callData)[0];
    // the recipient inside the bytes: rewritten to the wallet, the swap would hand the token to the person and the router would revert (ShortSwapOutput)
    const bent = f.callData.replaceAll(pad(ROUTER), pad(WALLET));
    assert.notStrictEqual(bent, f.callData);
    assert.match(planOf(f, { quote: { ...quoteOf(f), callData: bent } }).why, /recipient/, 'refuses a swap that pays another address');
    assert.ok(planOf(f, { quote: { ...quoteOf(f), callData: f.callData.replaceAll(pad(SPX), pad(OTHER)) } }).why, 'refuses another output token');
    assert.ok(planOf(f, { tokenOut: OTHER }).why, 'refuses a token other than the one asked');
    assert.match(planOf(f, { wei: BigInt(f.wei) + 1n }).why, /ETH/, 'refuses a quote for another amount of ETH');
    assert.ok(planOf(f, { quote: { ...quoteOf(f), msgValue: BigInt(f.msgValue) + 1n } }).why, 'refuses a swap that is sent more ETH than was typed');
    assert.ok(planOf(f, { deadline: BigInt(f.deadline) + 60n }).why, 'refuses another deadline');
    // a swap whose own floor is under the note: it could pay the router less than the router is told to deposit
    const low = f.callData.replace(word(call.limit), word(call.limit - 1n));
    assert.notStrictEqual(low, f.callData);
    assert.match(planOf(f, { quote: { ...quoteOf(f), callData: low } }).why, /less than allowed/, 'refuses a swap that can pay less than the note');
    assert.ok(planOf(f, { quote: { ...quoteOf(f), amountLimit: 0n } }).why, 'a quote with no floor makes no note');
    assert.ok(planOf(f, { quote: { ...quoteOf(f), callData: '0x5f3bd1c8' + f.callData.slice(10) } }).why, 'only a swap is sent: another zRouter function in its place is refused');
    assert.ok(R.zapShieldPlan({ quote: null, tokenOut: f.tokenOut, wei: BigInt(f.wei) }).why, 'and no quote, no call');
  });
}

test('zapShieldPlan: the note is a whole number of the pool\'s units, and a swap that pays less than one makes none', () => {
  const f = fixtures[0], q = quoteOf(f);
  // the same calldata read as a token whose pool unit is 1e3 raw: the note is the least cut to it, still under the swap's floor
  const p = R.zapShieldPlan({ quote: q, tokenOut: f.tokenOut, wei: BigInt(f.wei), scale: 1000n });
  assert.ok(!p.why && p.wrapAmount % 1000n === 0n && p.wrapAmount <= q.amountLimit && q.amountLimit - p.wrapAmount < 1000n, 'a multiple of the unit within one unit of the least');
  assert.match(R.zapShieldPlan({ quote: q, tokenOut: f.tokenOut, wei: BigInt(f.wei), scale: 10n ** 12n }).why, /less than the pool takes/, 'under one unit: no note, so no call');
});

// ── the card: zapOne ──
const grab = (src, re, end = '\n}\n') => { const i = src.search(re); assert.ok(i >= 0, `${re} is in the source`); return src.slice(i, src.indexOf(end, i) + end.length); };
const zapOneOfSrc = cardSrc.slice(cardSrc.indexOf('const zapOneOf = '), cardSrc.indexOf('// The buy as ONE transaction'));
const zapOneSrc = grab(cardSrc, /^async function zapOne\(/m);
function cardWith({ coin = { ticker: 'x:spx', id: '0xid', tdec: 8, scale: '1', sym: 'SPX' }, quote, host = {}, chainT = 1_800_000_000 } = {}) {
  const log = { said: [], quoted: [], hosted: [], requotes: 0 };
  const S = { busy: true, chainT, get: SPX.toLowerCase(), slip: 50 };
  const H = { moves: { poolCoin: () => coin, zapShield: async (...a) => { log.hosted.push(a); return host.result === undefined ? true : host.result; }, ...(host.moves || {}) } };
  if (host.throws) H.moves.zapShield = async () => { throw new Error(host.throws); };
  const Rx = { ...R, quoteEthToToken: async (o) => { log.quoted.push(o); return typeof quote === 'function' ? quote(o) : quote; } };
  const mk = new Function('H', 'S', 'R', 'within', 'chainTime', 'chainDeadline', 'say', 'requote', 'ethCall', 'esc', 'buyQuote', `${zapOneOfSrc}\n${zapOneSrc}\nreturn { zapOne, zapOneOf };`);
  // buyQuote is the card's quoter with its fallback to the aggregator's route: here the quoter alone, which is what answers (or does not) in these cases
  const api = mk(H, S, Rx, (p) => p, async () => {}, () => BigInt(f0.deadline), (...a) => log.said.push(a), () => { log.requotes++; }, async () => '0x', (x) => String(x), (o) => Rx.quoteEthToToken(o));
  return { ...api, S, log };
}
const f0 = fixtures[0];
const press = (over = {}) => ({ kind: 'zap', wei: BigInt(f0.wei), slip: 50, get: SPX.toLowerCase(), floor: (BigInt(f0.amountOut) * 9950n) / 10000n, ...over });

test('zapOne: the swap is read again with the router as its recipient, and the host is given the plan', async () => {
  const c = cardWith({ quote: quoteOf(f0) });
  assert.strictEqual(await c.zapOne(press()), true, 'the press is taken');
  assert.strictEqual(c.log.quoted.length, 1);
  assert.strictEqual(c.log.quoted[0].to, ROUTER, 'asked to pay the router');
  assert.strictEqual(c.log.quoted[0].slippageBps, 50, 'with the slippage that stood at the press');
  assert.strictEqual(c.log.quoted[0].amount, BigInt(f0.wei));
  assert.strictEqual(c.log.hosted.length, 1);
  const [addr, plan] = c.log.hosted[0];
  assert.strictEqual(addr, SPX.toLowerCase());
  assert.strictEqual(plan.wrapAmount, BigInt(f0.amountLimit));
  assert.strictEqual(plan.value, BigInt(f0.wei));
  assert.strictEqual(plan.zrSwapData, f0.callData);
  assert.deepStrictEqual(c.log.said.at(-1), [''], 'the old line is cleared before the host tells the rest');
});

test('zapOne: every no before the host starts leaves the press to the two steps, and the host is not asked', async () => {
  for (const [why, c] of [
    ['the pool does not hold the token (or the page has no row for it yet)', cardWith({ coin: null, quote: quoteOf(f0) })],
    ['no price from the quoter', cardWith({ quote: null })],
    ['the quoter throws', cardWith({ quote: () => { throw new Error('boom'); } })],
    ['the swap pays another address', cardWith({ quote: { ...quoteOf(f0), callData: f0.callData.replaceAll(pad(ROUTER), pad(WALLET)) } })],
    ['the swap\'s least is under one pool unit', cardWith({ coin: { scale: String(10n ** 12n), sym: 'SPX' }, quote: quoteOf(f0) })],
    ['the chain\'s clock could not be read', cardWith({ quote: quoteOf(f0), chainT: 0 })],
  ]) {
    assert.strictEqual(await c.zapOne(press()), false, why);
    assert.strictEqual(c.log.hosted.length, 0, `${why}: the host was not asked`);
    assert.strictEqual(c.S.busy, true, `${why}: the press is still the card's to finish`);
  }
});

test('zapOne: the host saying no is the two steps; the host failing is said, never a second buy', async () => {
  const no = cardWith({ quote: quoteOf(f0), host: { result: false } });
  assert.strictEqual(await no.zapOne(press()), false, 'false from the host: the card goes on with the swap');
  const boom = cardWith({ quote: quoteOf(f0), host: { throws: 'the page stopped' } });
  assert.strictEqual(await boom.zapOne(press()), true, 'a throw is the press taken: falling back after it could buy twice');
  assert.match(String(boom.log.said.at(-1)[0]), /the page stopped/);
});

test('zapOne: a price that fell below the least the person accepted stops the press, as the two steps do', async () => {
  const c = cardWith({ quote: { ...quoteOf(f0), amountOut: BigInt(f0.amountOut) * 98n / 100n } });
  assert.strictEqual(await c.zapOne(press()), true);
  assert.strictEqual(c.log.hosted.length, 0);
  assert.strictEqual(c.log.requotes, 1);
  assert.strictEqual(c.S.busy, false);
  assert.match(String(c.log.said.at(-1)[0]), /price moved below the least you accept\. Nothing was sent/);
});

test('zapOneOf: what the quote shows the person is the note and what comes back, and nothing where the buy would be in two steps', () => {
  const r = { zap: quoteOf(f0) };
  const c = cardWith({ quote: null });
  assert.deepStrictEqual(c.zapOneOf(r), { wrap: BigInt(f0.amountLimit), back: BigInt(f0.amountOut) - BigInt(f0.amountLimit) });
  assert.strictEqual(cardWith({ coin: null }).zapOneOf(r), null, 'the pool does not hold the token yet');
  assert.strictEqual(cardWith({ host: { moves: { zapShield: undefined } } }).zapOneOf(r), null, 'a host that does not offer it');
  assert.strictEqual(c.zapOneOf({}), null, 'a row that is not a buy and shield');
});

test('the press: go() tries the one transaction before it reads a balance or asks for a swap, only when the host offers it, and the one-transaction code reads the slippage of the press', () => {
  const go = grab(cardSrc, /^async function go\(/m);
  const at = go.indexOf("P.kind === 'zap' && H.moves?.zapShield && await zapOne(P)");
  assert.ok(at > 0, 'go() calls zapOne for the zap, if the host has zapShield');
  assert.ok(at < go.indexOf('balanceNow(P.get, from)') && at < go.indexOf('await prepare(P, from)'), 'before the two steps begin');
  assert.ok(go.slice(at, at + 200).includes('S.busy = false; paintQuote(); return;'), 'and a taken press leaves the card as it was');
  assert.ok(!/S\.slip/.test(zapOneSrc), 'zapOne reads P.slip, not the card\'s slippage after the awaits');
  assert.ok(/slippageBps: P\.slip/.test(zapOneSrc));
});

// ── the host: xtZapDeposit, xtWrapNow, xtZapShield ──
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, m.reduce((a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }, new Uint8Array()));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const SPX_ROW = { ticker: `x:${SPX.toLowerCase()}`, assetId: '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48', underlying: SPX.toLowerCase(), unitScale: '1', decimals: 8, tacitDecimals: 8, native: false, live: true, runtime: true, symbol: 'SPX', name: 'SPX6900' };
const hostSrc = ['xtZapDeposit', 'xtWrapNow', 'xtZapShield'].map((n) => grab(frontSrc, new RegExp(`^async function ${n}\\(`, 'm'))).join('\n');
const html = (s, ...v) => s.reduce((a, c, i) => a + c + (v[i] ?? ''), '');
const walletDeclined = (e) => e?.code === 4001 || /user (rejected|denied)|rejected the request|denied transaction|no wallet selected/i.test(String(e?.shortMessage || e?.message || e || ''));
const ENGINE = (() => {
  const t = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet', fetchImpl: async () => { throw new Error('offline'); } });
  t.addAsset({ ...SPX_ROW });
  return t;
})();
const priv = '0x' + randomBytes(32).toString('hex');   // a key made for this run
const PLAN = { wrapAmount: BigInt(f0.amountLimit), value: BigInt(f0.wei), zrSwapData: f0.callData, to: ROUTER };
const SPX_RECORD = () => ({ addr: SPX.toLowerCase(), sym: 'SPX', dec: 8, tdec: 8, scale: 1n, ticker: SPX_ROW.ticker, id: SPX_ROW.assetId, registered: true, keep: false, p: null });

function hostWith(o = {}) {
  const log = { calls: [], sent: [], failed: [], released: [], runTxs: [], waits: [], settled: [], said: [], proveFirst: 0, depositPlain: 0, proveOr: 0, kept: 0, releases: [] };
  const t = { cfg: { router: o.router || ROUTER }, buildWrap: (a) => ENGINE.buildWrap(a), router: ENGINE.router, nextWrapIndex: async () => 7, releaseWrapIndex: (a) => log.released.push(a.index), externalAsset: async () => ({ registered: true, row: SPX_ROW }), addAsset: () => {},
    submitWrapSettle: async (a) => { log.settled.push(a); return {}; } };
  const run = { to: null, away: false, op: null, go(to) { this.to = { one: true, ...to }; }, take() {}, check() {}, say: () => {}, fail(el, e) { log.failed.push(e); }, release(keep) { log.releases.push(keep); }, wait: () => ({}) };
  const S = { wallet: o.wallet === undefined ? WALLET : o.wallet, key: o.key === undefined ? { pubHex: '0x02' } : o.key, address: WALLET };
  const rec = o.record || SPX_RECORD();
  const env = {
    S, t, run, html, walletDeclined, log, rec,
    rpc: async (m, p) => { log.calls.push([m, p]); if (o.simFails) throw Object.assign(new Error('execution reverted'), { code: 3 }); return '0x'; },
    say: (el, v) => log.said.push(String(v)),
    sendTx: async (tx) => { log.sent.push(tx); if (o.declines) throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); return '0x' + 'ab'.repeat(32); },
    fmt: (v, d) => String(Number(v) / 10 ** d), txLink: (h) => h, kDep: (d) => 'd:' + d.depositId, minedAs: (h) => h, runTx: (r, h) => { log.runTxs.push(h); return h; }, actTx: (h) => h,
    waitTx: async (h) => { log.waits.push(h); if (o.reverts) throw new Error('The transaction reverted.'); return {}; },
    getUx: async () => t, walletPriv: () => priv, ownNow: () => !!o.own, proveOwn: async () => !!o.own, ownReady: async () => {}, xtRegister: async () => {}, xtFrom: () => {}, xtSave: () => {},
    proveFirstWrap: async () => { log.proveFirst++; }, xtToken: (r) => ({ address: r.addr, sym: r.sym, dec: r.dec, permit2: true }),
    xtWrapDeposit: async () => { log.depositPlain++; return { depositId: '0xplain', txHash: '0x' + 'cd'.repeat(32), commit: '0x' }; },
    proveOr: async (spec) => { log.proveOr++; log.proveSpec = spec; return spec.relayed(); },
    waitRanOut: () => false, keptDeposit: (e) => { log.kept++; return Object.assign(new Error('KEPT: ' + e.message), { said: true }); },
    scanPrivate: async () => {}, hxWalletBals: async () => {}, hxMoveAfter: () => {},
    xtEnsure: () => rec, hxMoveSlot: () => ({}), SWC: { el: { querySelector: () => (o.noGo ? null : { getAttribute: () => (o.goBusy ? 'true' : null) }) }, card: { clear() {} } }, PROVE_AT: {},
    busy: async (btn, fn) => { await fn(run); },
  };
  const names = Object.keys(env);
  const make = new Function(...names, `${hostSrc}\nreturn { xtZapDeposit, xtWrapNow, xtZapShield };`);
  return { ...make(...names.map((k) => env[k])), env, log, t, run, S, rec };
}
const wrapArgs = (h, extra = {}) => ({ run: h.run, r: h.rec, wei: PLAN.wrapAmount, src: 'wallet', status: {}, line: () => ({}), clear() {}, after() {}, ...extra });
const decodeZap = (data) => {
  const d = String(data).replace(/^0x/, ''), w = (i) => d.slice(8 + i * 64, 8 + (i + 1) * 64), at = Number(BigInt('0x' + w(3))) / 32, len = Number(BigInt('0x' + w(at)));
  return { sel: d.slice(0, 8), tokenOut: '0x' + w(0).slice(24), wrapAmount: BigInt('0x' + w(1)), commit: '0x' + w(2), swap: '0x' + d.slice(8 + (at + 1) * 64, 8 + (at + 1) * 64 + len * 2) };
};

test('xtZapDeposit: runs the exact call from the wallet first, then sends the router that call with the ETH, for the wallet to confirm', async () => {
  const h = hostWith();
  const w = await h.xtZapDeposit(h.t, priv, h.rec, PLAN, {}, 7, 'Buy and shield');
  assert.strictEqual(h.log.calls.length, 1, 'one call first');
  const [m, [call, block]] = h.log.calls[0];
  assert.strictEqual(m, 'eth_call'); assert.strictEqual(block, 'latest');
  assert.strictEqual(call.from, WALLET); assert.strictEqual(call.to, ROUTER); assert.strictEqual(call.value, '0x' + PLAN.value.toString(16));
  assert.strictEqual(h.log.sent.length, 1);
  const tx = h.log.sent[0];
  assert.deepStrictEqual([tx.to, tx.value, tx.via, tx.label], [ROUTER, PLAN.value, 'wallet', 'Buy and shield'], 'to the router, the ETH typed, from the wallet, nothing else (no approval, no signature, no Permit2)');
  assert.strictEqual(tx.data, call.data, 'what was run as a call is what is sent, byte for byte');
  const d = decodeZap(tx.data);
  assert.strictEqual(d.sel, '65dcbb8e', 'zapETHToShieldedNote');
  assert.strictEqual(d.tokenOut.toLowerCase(), SPX.toLowerCase());
  assert.strictEqual(d.wrapAmount, PLAN.wrapAmount);
  assert.strictEqual(d.commit, w.commit, 'for this key\'s note');
  assert.strictEqual(d.swap, f0.callData, 'with the quoter\'s swap');
  assert.ok(w.depositId && w.txHash && w.commit && w.wrapOp, 'the record is the wrap xtWrapNow settles (depositId, commit, proof input) with its transaction');
  assert.strictEqual(w.amount, String(PLAN.wrapAmount), 'for exactly the note');
  assert.ok(h.log.said.some((s) => /Confirm in your wallet/.test(s)), 'the person is told what to confirm');
});

test('xtZapDeposit: a call that would revert, or a router the swap does not pay, sends nothing and falls back without a word', async () => {
  const sim = hostWith({ simFails: true });
  await assert.rejects(sim.xtZapDeposit(sim.t, priv, sim.rec, PLAN, {}, 7, 'x'), (e) => e.zapFallback === true);
  assert.strictEqual(sim.log.sent.length, 0, 'nothing was sent');
  assert.strictEqual(sim.log.said.length, 0, 'and nothing was said');
  const other = hostWith();
  await assert.rejects(other.xtZapDeposit(other.t, priv, other.rec, { ...PLAN, to: OTHER }, {}, 7, 'x'), (e) => e.zapFallback === true);
  assert.strictEqual(other.log.sent.length + other.log.calls.length, 0, 'the swap pays another contract than the one the call goes to: not even a call');
  const no = hostWith({ wallet: null });
  await assert.rejects(no.xtZapDeposit(no.t, priv, no.rec, PLAN, {}, 7, 'x'), (e) => e.zapFallback === true);
});

test('xtWrapNow with the one-transaction deposit: sent first, then settled the relay\'s way with this deposit', async () => {
  const h = hostWith();
  const res = await h.xtWrapNow(wrapArgs(h, { label: 'Buy and shield 2.37 SPX', deposit: (t, p, i) => h.xtZapDeposit(t, p, h.rec, PLAN, {}, i, 'Buy and shield 2.37 SPX') }));
  assert.notStrictEqual(res, false, 'done, not a fallback');
  assert.strictEqual(h.run.to.label, 'Buy and shield 2.37 SPX', 'Activity names the buy');
  assert.strictEqual(h.log.depositPlain, 0, 'the plain deposit step is not used');
  assert.strictEqual(h.log.sent.length, 1, 'one transaction from the wallet');
  assert.strictEqual(h.log.runTxs.length, 1);
  assert.deepStrictEqual(h.log.waits, ['0x' + 'ab'.repeat(32)], 'waits for it to land');
  assert.strictEqual(h.log.proveOr, 1);
  assert.deepStrictEqual(h.log.proveSpec.types, ['wrap'], 'settled as a wrap, through the relay');
  assert.strictEqual(h.log.settled.length, 1);
  assert.strictEqual(h.log.settled[0].built.depositId, ENGINE.buildWrap({ walletPriv: priv, amountWei: String(PLAN.wrapAmount), ticker: SPX_ROW.ticker, index: 7 }).depositId, 'the deposit it settles is the note of this buy at the index it was given');
  assert.strictEqual(h.log.settled[0].depositTx, '0x' + 'ab'.repeat(32), 'with the transaction that made it');
  assert.strictEqual(h.log.failed.length, 0);
  assert.strictEqual(h.rec.keep, true, 'the token stays among the key\'s');
});

test('xtWrapNow: a key that proves its own is not taken down the prove-first way by the one-transaction deposit (and still is for a plain one)', async () => {
  const h = hostWith({ own: true });
  await h.xtWrapNow(wrapArgs(h, { deposit: (t, p, i) => h.xtZapDeposit(t, p, h.rec, PLAN, {}, i, 'x') }));
  assert.strictEqual(h.log.proveFirst, 0, 'with a deposit given, no prove-first wrap');
  assert.strictEqual(h.log.sent.length, 1);
  const plain = hostWith({ own: true });
  await plain.xtWrapNow(wrapArgs(plain));
  assert.strictEqual(plain.log.proveFirst, 1, 'the plain shield of a key that proves its own is unchanged');
  assert.strictEqual(plain.log.depositPlain, 0);
  const norm = hostWith();
  await norm.xtWrapNow(wrapArgs(norm));
  assert.strictEqual(norm.log.depositPlain, 1, 'and a plain shield still deposits the old way');
  assert.strictEqual(norm.run.to.label, 'Make 2.37438733 SPX private', 'under its old name');
});

test('xtWrapNow: a deposit step that falls back before anything is sent ends with false, gives the note index back, and says nothing', async () => {
  const h = hostWith({ simFails: true });
  const res = await h.xtWrapNow(wrapArgs(h, { deposit: (t, p, i) => h.xtZapDeposit(t, p, h.rec, PLAN, {}, i, 'x') }));
  assert.strictEqual(res, false);
  assert.deepStrictEqual(h.log.released, [7], 'the index it took is free again');
  assert.strictEqual(h.log.failed.length, 0, 'no error is shown');
  assert.strictEqual(h.log.sent.length + h.log.waits.length + h.log.proveOr + h.log.runTxs.length, 0, 'nothing sent, waited for or settled');
  assert.strictEqual(h.log.releases.length, 0);
});

test('xtWrapNow: declined in the wallet is said and gives the index back; a revert says nothing was bought, never "deposit to finish"', async () => {
  const dec = hostWith({ declines: true });
  const r1 = await dec.xtWrapNow(wrapArgs(dec, { deposit: (t, p, i) => dec.xtZapDeposit(t, p, dec.rec, PLAN, {}, i, 'x') }));
  assert.notStrictEqual(r1, false, 'a decline is not a fallback: the person said no');
  assert.strictEqual(dec.log.failed.length, 1);
  assert.deepStrictEqual(dec.log.released, [7]);
  const rev = hostWith({ reverts: true });
  const REVERTED = 'It did not go through: nothing was bought.';
  await rev.xtWrapNow(wrapArgs(rev, { reverted: REVERTED, deposit: (t, p, i) => rev.xtZapDeposit(t, p, rev.rec, PLAN, {}, i, 'x') }));
  assert.strictEqual(rev.log.sent.length, 1, 'it was sent');
  assert.strictEqual(rev.log.failed.length, 1);
  assert.strictEqual(rev.log.failed[0].message, REVERTED, 'the person is told the buy was undone');
  assert.strictEqual(rev.log.kept, 0, 'it is not offered as a deposit to finish');
  assert.strictEqual(rev.log.releases.length, 0);
  const plain = hostWith({ reverts: true });
  await plain.xtWrapNow(wrapArgs(plain));
  assert.strictEqual(plain.log.failed[0].message, 'The transaction reverted.', 'a plain deposit that reverts says what it said');
});

test('xtZapShield: the one transaction is offered only where it can be made, and false leaves everything as it was', async () => {
  for (const [why, o, plan] of [
    ['no Tacit key is open', { key: null }, PLAN],
    ['no wallet is connected', { wallet: null }, PLAN],
    ['the token is not in the pool yet', { record: { ...SPX_RECORD(), registered: null } }, PLAN],
    ['the key proves its own (prove-first is its way)', { own: true }, PLAN],
    ['the card has no button', { noGo: true }, PLAN],
    ['the button is busy with another press', { goBusy: true }, PLAN],
    ['no note', {}, { ...PLAN, wrapAmount: 0n }],
    ['no ETH', {}, { ...PLAN, value: 0n }],
    ['a note that is not whole pool units', { record: { ...SPX_RECORD(), scale: 1000n } }, { ...PLAN, wrapAmount: 1234n }],
  ]) {
    const h = hostWith(o);
    assert.strictEqual(await h.xtZapShield(SPX.toLowerCase(), plan), false, why);
    assert.strictEqual(h.log.sent.length + h.log.calls.length + h.log.runTxs.length, 0, `${why}: nothing was run, sent or asked of the wallet`);
  }
});

test('xtZapShield: taken, it is the card\'s whole press; a fallback inside it is false for the card to carry on', async () => {
  const ok = hostWith();
  assert.strictEqual(await ok.xtZapShield(SPX.toLowerCase(), PLAN), true);
  assert.strictEqual(ok.run.to.label, `Buy and shield ${2.37438733} SPX`);
  assert.strictEqual(ok.log.sent.length, 1);
  assert.strictEqual(ok.log.sent[0].to, ROUTER);
  assert.strictEqual(ok.log.sent[0].via, 'wallet');
  assert.strictEqual(ok.log.proveOr, 1, 'settled the relay\'s way');
  const no = hostWith({ simFails: true });
  assert.strictEqual(await no.xtZapShield(SPX.toLowerCase(), PLAN), false, 'the call would revert: back to the card, which swaps and then shields');
  assert.strictEqual(no.log.sent.length, 0);
  assert.strictEqual(no.log.failed.length, 0);
  assert.deepStrictEqual(no.log.released, [7]);
  assert.strictEqual(no.log.said.at(-1), '', 'and the status line left by the attempt is cleared, for the card\'s own lines');
  const dec = hostWith({ declines: true });
  assert.strictEqual(await dec.xtZapShield(SPX.toLowerCase(), PLAN), true, 'declined: the press is over, not retried the long way');
});

test('the host offers it to the card as a move beside the plain shield, which the long way still uses', () => {
  assert.match(frontSrc, /zapShield: \(addr, plan\) => xtZapShield\(addr, plan\),/);
  assert.match(frontSrc, /shield: \(addr, raw\) => xtShieldRaw\(addr, raw\),/);
  assert.match(cardSrc, /try \{ await H\.moves\.shield\(P\.get, got\); \}/, 'the card\'s second step is the plain shield, as before');
  const dep = grab(frontSrc, /^async function xtZapDeposit\(/m);
  assert.ok(dep.indexOf("rpc('eth_call'") > 0 && dep.indexOf("rpc('eth_call'") < dep.indexOf('sendTx('), 'the call is run before the send');
  assert.ok(!/Permit2|permit|approve|allowance/i.test(dep.replace(/\/\/.*$/gm, '')), 'the wallet pays ETH only: no approval, no permit');
});
