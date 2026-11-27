// Which account pays, and what the Tacit chain card offers to shield (dapp/index.html acctUsed, dapp/front/tac.js tacPubSplit).
//
// A withdraw from the Tacit chain to "your wallet" can pay out to this key's own address, which then holds TAC but no ETH and has sent nothing. That address
// counts as used, so it stays the paying account and a shield from it (by permit, no ETH) works. The card counts public TAC by account: Shield takes what the
// paying account holds, and TAC at the other account is offered with a switch to pay from it.
//
// Run: node tests/front-shield-payer.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontPage } from './lib/front-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tacJs = readFileSync(join(ROOT, 'dapp/front/tac.js'), 'utf8');
const page = frontPage(join(ROOT, 'dapp/index.html'));

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m}: expected ${b}, got ${a}`); };
const between = (src, from, to, name) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)} in ${name}`);
  return src.slice(a, b);
};
const run = (src, scope, expose) => new Function('scope', `with (scope) { ${src}\nreturn { ${expose} }; }`)(new Proxy(scope, { has: (t, k) => typeof k === 'string' && k in t }));

const TAC = 10n ** 18n, KEY = '0x149c2a0836ea6d64a8e5c2015f12d12693fab430', WAL = '0xdae826b412b4a0f5e2890c777782b5f8fc3bbbc8';
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '');

// acctUsed and payer, against an RPC that answers for this key's address
const usedSrc = between(page, 'const ACCT_USED', 'function syncAccount', 'dapp/index.html');
async function payerFor({ eth = 0n, nonce = 0n, tac = 0n, wallet = null, pay = undefined, ext = true }) {
  const mem = {}, S = { key: { pubHex: 'pk' }, acct: { pub: 'pk', address: KEY }, wallet, pay };
  const rpc = async (m, p) => (m === 'eth_getBalance' ? word(eth) : m === 'eth_getTransactionCount' ? word(nonce) : word(tac));
  const scope = {
    S, rpc, store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, evm: { available: () => ext },
    ADDR: { tac: '0xa1313eb9f3a445606d9583bcac3ebeb56a858279' }, SEL: { balanceOf: '70a08231' },
    addrWord: (a) => strip(a).toLowerCase().padStart(64, '0'), wordAt: (h, i) => BigInt('0x' + (strip(h).slice(i * 64, i * 64 + 64) || '0')),
    syncAccount() {}, paintWallet() {}, refreshAll() {}, SWC: {},
  };
  const f = run(usedSrc, scope, 'acctUsed, payer');
  f.payer();
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  return f.payer();
}

// tacPubSplit, against the combined read (TACB) and who pays
const splitSrc = between(tacJs, 'function tacPubSplit', 'const tacPubMine', 'dapp/front/tac.js');
function split({ acct, erc, payer, wallet = null }) {
  const S = { acct: { address: KEY }, wallet };
  const who = [wallet, KEY].filter(Boolean).join();
  return run(splitSrc, { S, TACB: { who, erc, acct }, tacWho: () => who, payer: () => payer }, 'tacPubSplit').tacPubSplit();
}

await test('key address holding only TAC (no ETH, nonce 0) stays the paying account', async () => {
  eq(await payerFor({ tac: 151n * TAC }), 'tacit', 'payer');
});
await test('key address with nothing at all still gives way to the browser wallet', async () => {
  eq(await payerFor({}), 'wallet', 'payer');
});
await test('key address with ETH pays, as before', async () => {
  eq(await payerFor({ eth: 1n }), 'tacit', 'payer');
});
await test('an explicit choice of the wallet wins over TAC at the key address', async () => {
  eq(await payerFor({ tac: 151n * TAC, wallet: WAL, pay: 'wallet' }), 'wallet', 'payer');
});
await test('the key pays: Shield takes the key address TAC, the wallet TAC is offered apart', async () => {
  const s = split({ acct: 151n * TAC, erc: 160n * TAC, payer: 'tacit', wallet: WAL });
  eq(s.mine, 151n * TAC, 'mine'); eq(s.other, 9n * TAC, 'other'); eq(s.otherAs, 'wallet', 'otherAs');
});
await test('the wallet pays but none is connected: nothing to shield, the key address TAC is offered', async () => {
  const s = split({ acct: 151n * TAC, erc: 151n * TAC, payer: 'wallet' });
  eq(s.mine, 0n, 'mine'); eq(s.other, 151n * TAC, 'other'); eq(s.otherAs, 'tacit', 'otherAs');
});
await test('the wallet pays: Shield takes the wallet TAC', async () => {
  const s = split({ acct: 0n, erc: 40n * TAC, payer: 'wallet', wallet: WAL });
  eq(s.mine, 40n * TAC, 'mine'); eq(s.other, 0n, 'other');
});
await test('no split while the key address share is unread', async () => {
  eq(split({ acct: null, erc: 40n * TAC, payer: 'wallet', wallet: WAL }), null, 'split');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
