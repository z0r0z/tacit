// The Pay pool's press toward the Tacit chain (dapp/front/tac.js tacPayChainRun, with tacPayChainSize), and tokOutNow's word on whether a withdrawal went (dapp/index.html).
//
// One press takes the Pay pool's TAC out to the wallet and in again as a shield. It works out how much that is before anything moves: the most one withdrawal can take
// (the relay's fee comes out of the pool as well, and a balance spread over many notes limits it), less the leader's fee when the leader pays the shield's gas, and no more
// than a shield takes. It shields only once the withdrawal is known to have gone and the wallet shows the TAC, so a withdrawal that failed or has not landed never
// goes on to a shield.
//
// The functions are cut out of the two files and run against stand-ins for what they touch.
//
// Run: node tests/front-pay-to-chain.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mergePlan } from '../dapp/evm-pool-wallet.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tacJs = readFileSync(join(ROOT, 'dapp/front/tac.js'), 'utf8');
const page = readFileSync(join(ROOT, 'dapp/index.html'), 'utf8');

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

const E10 = 10n ** 10n, TAC = 10n ** 18n;
const plain = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'), i = s.slice(0, -d), f = s.slice(-d).replace(/0+$/, ''); return f ? `${i}.${f}` : i; };
const chainSaid = (m) => Object.assign(new Error(m), { said: true });

const chainSrc = between(tacJs, 'function tacPayChainSize', '// Where the press was made', 'dapp/front/tac.js');
const outSrc = between(page, 'async function tokOutNow', 'const hxSendTokGo', 'dapp/index.html');

// the Pay pool's press, against a pool holding `notes` (wei) with a relay fee of `fee`, a wallet that shows the TAC `lands` polls after the withdrawal.
// mergePlan is the wallet's own (dapp/evm-pool-wallet.js): what one withdrawal can take is what it says, fee and note count included.
function press({ notes = [500n * TAC], fee = 0n, way = 'own', sweepFee = 0n, cap = null, outOk = true, lands = 2, start = 0n, shieldFails = false } = {}) {
  const log = { out: [], shield: [], toasts: [], say: [], fail: [], go: [], polls: 0, waited: 0 };
  const wallet = { v: start }, bal = notes.reduce((a, b) => a + b, 0n);
  const P = { slug: 'tac', keeper: 'https://keeper' };
  const W = { quote: async () => ({ fee: String(fee) }), notes: () => notes.map((v) => ({ v })) };
  const scope = {
    E10, plain, chainSaid, hxDevAny: () => P, payingAccount: async () => '0xWALLET', tokenSync: async () => {}, tokenWallet: async () => W, getDeviceMods: async () => ({ mergePlan }),
    TK: { bal, self: false }, chainSweepFee: async () => sweepFee, CHAIN_SWEEP: { cap: null }, chainCap: async () => cap,
    fmt: (v) => String(v), say: (el, v) => log.say.push(String(v)), toast: (t) => log.toasts.push(String(t)),
    tokOutNow: async (o) => { log.out.push(o); return outOk; },
    hxWalletBals: async () => { log.polls++; if (log.out.length && outOk && log.polls >= lands) wallet.v = start + parseWei(log.out[0].amt); },
    hxWalletBal: () => wallet.v, sleep: async (ms) => { log.waited += ms; },
    chainShieldRun: async (r, st, units, o) => { log.shield.push({ units, held: o.held, way: o.way }); if (shieldFails) r.fail(st, new Error('shield refused')); },
  };
  const fns = run(chainSrc, scope, 'tacPayChainRun, tacPayChainSize');
  const runObj = { check() {}, go: (t) => log.go.push(t), fail: (el, e) => log.fail.push(e) };
  return { log, wallet, fns, go: () => fns.tacPayChainRun(runObj, 'st', way) };
}
const parseWei = (s) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + f.padEnd(18, '0').slice(0, 18)); };

// ── tacPayChainSize
await test('the size: gas paid in ETH moves the whole balance, down to the chain\'s 8 decimals', () => {
  const { fns } = press();
  const s = fns.tacPayChainSize({ most: 1000n * TAC + 5n });
  eq(s.units, 1000n * 10n ** 8n, 'units');
  eq(s.amount, 1000n * TAC, 'withdraw exactly what the units cover (the 5 wei left is dust)');
});
await test('the size: gas paid in TAC leaves the leader\'s fee and a tenth over it', () => {
  const { fns } = press();
  const s = fns.tacPayChainSize({ most: 1000n * TAC, sweepFee: 2n * TAC });
  const room = 2n * TAC + (2n * TAC) / 10n;
  eq(s.units, (1000n * TAC - room) / E10, 'units');
  eq(s.amount, s.units * E10 + room, 'amount covers the units and the room');
  ok(s.amount <= 1000n * TAC, 'never more than the withdrawal can take');
});
await test('the size: no more than a shield takes, and the withdrawal shrinks with it', () => {
  const { fns } = press();
  const s = fns.tacPayChainSize({ most: 1000n * TAC, sweepFee: TAC, cap: 100n * 10n ** 8n });
  eq(s.units, 100n * 10n ** 8n, 'units are the cap');
  eq(s.amount, 100n * TAC + TAC + TAC / 10n, 'only that much (and the room) is withdrawn');
});
await test('the size: nothing when the fees take it all', () => {
  const { fns } = press();
  ok(fns.tacPayChainSize({ most: TAC, sweepFee: TAC }) === null, 'the room is as large as the balance');
  ok(fns.tacPayChainSize({ most: 0n }) === null, 'an empty pool');
  ok(fns.tacPayChainSize({ most: E10 - 1n }) === null, 'less than one chain unit');
});
await test('the size: never asks for more than the pool can take (many sizes)', () => {
  const { fns } = press();
  for (let i = 0; i < 400; i++) {
    const most = BigInt(Math.floor(Math.random() * 3000)) * TAC / 7n + BigInt(i), sweepFee = BigInt(i % 5) * TAC / 3n, cap = i % 3 ? null : BigInt(1 + (i % 50)) * 10n ** 8n;
    const s = fns.tacPayChainSize({ most, sweepFee, cap });
    if (s) { ok(s.amount <= most, `amount ${s.amount} over ${most}`); ok(s.units > 0n && (cap == null || s.units <= cap), 'units in range'); ok(s.amount >= s.units * E10, 'amount covers units'); }
  }
});

// ── the whole press
await test('a press takes the most out, waits for the wallet to show it, then shields it', async () => {
  const p = press({ notes: [500n * TAC], fee: TAC / 2n });
  eq(await p.go(), true, 'the press went');
  eq(p.log.out.length, 1, 'one withdrawal');
  const o = p.log.out[0];
  eq(o.op, 'withdraw', 'a withdrawal'); eq(o.raw, '0xWALLET', 'to the paying wallet'); eq(o.amt, '499.5', 'the pool less the relay fee');
  eq(p.log.shield.length, 1, 'one shield');
  eq(p.log.shield[0].units, 499n * 10n ** 8n + 5n * 10n ** 7n, 'the whole of it, in 8-decimal units');
  eq(p.log.shield[0].way, 'own', 'the way the card shows'); eq(p.log.shield[0].held, parseWei('499.5'), 'against what the wallet holds');
  ok(p.log.polls >= 2, 'it looked again until the wallet showed the TAC');
});
await test('with gas paid in TAC the wallet must hold the leader\'s fee as well as the shield', async () => {
  const p = press({ notes: [100n * TAC], way: 'permit', sweepFee: TAC });
  eq(await p.go(), true, 'the press went');
  const units = p.log.shield[0].units;
  eq(units, (100n * TAC - (TAC + TAC / 10n)) / E10, 'units leave the fee and a tenth');
  eq(p.log.out[0].amt, plain(units * E10 + TAC + TAC / 10n, 18), 'the withdrawal carries the room');
  ok(p.log.shield[0].held >= units * E10 + TAC, 'what the wallet holds covers the shield and the fee');
  eq(p.log.shield[0].way, 'permit', 'the way is passed on');
});
await test('a balance spread over many notes moves as much as one withdrawal can take', async () => {
  const p = press({ notes: Array(20).fill(50n * TAC) });
  eq(await p.go(), true, 'the press went');
  eq(p.log.out[0].amt, '450', 'eight notes merged and the next one beside them: the most one withdrawal takes, not the 1000 held');
  eq(p.log.shield[0].units, 450n * 10n ** 8n, 'and that much is shielded');
});
await test('a pool over the shield cap moves the cap and says the rest is still there', async () => {
  const p = press({ notes: [1000n * TAC], cap: 100n * 10n ** 8n });
  eq(await p.go(), true, 'the press went');
  eq(p.log.out[0].amt, '100', 'only the cap is withdrawn');
  eq(p.log.shield[0].units, 100n * 10n ** 8n, 'and shielded');
  ok(p.log.toasts.some((t) => /still in the Pay pool/.test(t)), `a note about the rest: ${p.log.toasts}`);
});
await test('a withdrawal that did not go is not followed by a shield', async () => {
  const p = press({ outOk: false });
  eq(await p.go(), false, 'the press did not go');
  eq(p.log.shield.length, 0, 'nothing was shielded');
});
await test('a withdrawal that did not go is not followed by a shield even when the wallet already holds the TAC', async () => {
  const p = press({ outOk: false, start: 1000n * TAC });
  eq(await p.go(), false, 'the press did not go');
  eq(p.log.shield.length, 0, 'the wallet\'s own TAC is not shielded on the strength of a withdrawal that failed');
});
await test('a wallet that never shows the TAC is not shielded from, and the line says where it is', async () => {
  const p = press({ lands: 99 });
  eq(await p.go(), false, 'the press stopped');
  eq(p.log.shield.length, 0, 'nothing was shielded');
  ok(p.log.say.some((t) => /on its way to your wallet/.test(t) && /Wallet line/.test(t)), `says what to do: ${p.log.say.at(-1)}`);
  ok(p.log.polls >= 8, 'it looked for a while first');
});
await test('a pool with too little in it stops before any withdrawal', async () => {
  const p = press({ notes: [TAC / 1000n], fee: TAC / 1000n });
  let err = null;
  try { await p.go(); } catch (e) { err = e; }
  ok(err && err.said && /Too little/.test(err.message), `refused with a reason: ${err && err.message}`);
  eq(p.log.out.length, 0, 'nothing was withdrawn');
});
await test('a shield that fails is not counted as a press that went', async () => {
  const p = press({ notes: [1000n * TAC], cap: 100n * 10n ** 8n, shieldFails: true });
  eq(await p.go(), false, 'the press did not go');
  eq(p.log.fail.length, 1, 'the failure reached the run');
  ok(!p.log.toasts.some((t) => /still in the Pay pool/.test(t)), 'no word about the rest after a failure');
});
await test('a wallet already holding TAC before the press does not matter', async () => {
  const p = press({ notes: [50n * TAC], start: 20n * TAC, lands: 1 });
  eq(await p.go(), true, 'the press went');
  eq(p.log.shield[0].units, 50n * 10n ** 8n, 'only what the pool gave is shielded, not the wallet\'s own');
});

// ── tokOutNow says whether it went
function outer({ error = null, waitTx = async () => {}, bal = 100n * TAC, mergeOk = true } = {}) {
  const log = { says: [], fails: [], withdraws: [], cleared: 0, after: 0 };
  const html = (s, ...v) => s.reduce((a, x, i) => a + x + (v[i] ?? ''), '');
  const W = { quote: async () => ({ fee: '0' }), notes: () => [{ v: bal }], connect() {}, withdraw: async (o) => { log.withdraws.push(o); if (error) throw error; return '0xhash'; } };
  const scope = {
    html, say: (el, v) => log.says.push(String(v)), errText: (e) => e.message, parseUnits: (s, d) => parseWei(s),
    recipientOf: (x) => String(x).toLowerCase(), tokRecipient: async () => ({}), tokenWallet: async () => W, getDeviceMods: async () => ({ mergePlan: () => (mergeOk ? [] : null) }),
    tokenSync: async () => {}, TK: { self: false, bal, quote: null, qAt: 0 }, keeperRead: async () => {}, keeperDown: () => false, payingAccount: async () => '0xa', payFromTok: () => ({}),
    waitTx, hxWalletBals: () => {}, payBals: () => Promise.resolve(), PB: { pub: null, at: {} }, txLink: () => 'tx', fmt: (v) => String(v), txFail: (r, st, e) => log.fails.push(e.message),
    waitRanOut: () => false, keeperTrouble: () => false, PROVE_AT: { el: null }, HX: { tab: 'swap' }, hxQuoteSoon() {}, your: () => 'your wallet',
  };
  const { tokOutNow } = run(outSrc, scope, 'tokOutNow');
  const go = () => tokOutNow({ run: {}, t: { dec: 18, sym: 'TAC', keeper: null, explorer: '' }, op: 'withdraw', amt: '10', raw: '0xB', st: 'st', clear: () => { log.cleared++; }, after: () => { log.after++; } });
  return { go, log };
}
await test('tokOutNow: a withdrawal that went says true', async () => {
  const o = outer();
  eq(await o.go(), true, 'result'); eq(o.log.withdraws.length, 1, 'sent once'); eq(o.log.after, 1, 'after ran');
});
await test('tokOutNow: a withdrawal that threw says false and tells why', async () => {
  const o = outer({ error: Object.assign(new Error('the pool said no'), { said: true }) });
  eq(await o.go(), false, 'result'); ok(o.log.says.some((t) => /the pool said no/.test(t)), 'the reason was shown'); eq(o.log.after, 0, 'after did not run');
});
await test('tokOutNow: a withdrawal still waiting for its block says false', async () => {
  const o = outer({ waitTx: async () => { throw Object.assign(new Error('pending'), { pending: true }); } });
  eq(await o.go(), false, 'result'); eq(o.log.fails.length, 1, 'the wait was told');
});
await test('tokOutNow: a balance spread over too many notes says false before sending', async () => {
  const o = outer({ mergeOk: false });
  eq(await o.go(), false, 'result'); eq(o.log.withdraws.length, 0, 'nothing was sent');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
