// The real Pay page (dapp/pay/eth/) with the large-pool cards: off unless the page was opened with ?fixed=1 (the form is
// then exactly what it was), and on Ethereum with the flag the cards load under the page's own content-security policy
// and the split shows for an amount. Every request that leaves the machine is answered by a stand-in.
//   PLAYWRIGHT=<path to playwright-core> node tests/fixed-pool-pay-page.mjs        (SHOTS=<dir> saves screenshots)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { keccak_256, secp, hexToBytes, bytesToHex, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('../dapp/vendor/tacit-poseidon.min.js');
const { makeEvmPoolZk, poolAsset } = await import('../dapp/evm-pool-zk.js');
const { evmPoolKeys, sealNote, openNote } = await import('../dapp/evm-pool-wallet.js');
const { signBox } = await import('../dapp/fixed-pool-box.js');
const { FIXED_POOLS } = await import('../dapp/fixed-pool-notes.js');
const { receiveBoxAddress, RECEIVE_FEE_BPS, EVM_POOL_ROUTER } = await import('../dapp/evm-pool-gateway.js');
const { encodeList } = await import('./helpers/relay-registry-list.mjs');
const { newGatewayKey, gatewayKeys } = await import('../dapp/sealed-request.js');
const { makeServiceGateway } = await import('../worker-relay/src/lib/evm-pool-keeper-sealed.js');

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = normalize(decodeURIComponent(url.pathname));
  let file = join(DAPP, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(DAPP) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let pass = 0, fail = 0;
const test = async (label, fn) => {
  if (process.env.ONLY && !label.includes(process.env.ONLY)) return;      // ONLY=<part of a test's name> runs just those
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

// a wallet that announces itself the way wallets do (EIP-6963) and signs for real, so the page can open the Tacit wallet
const KEY = hexToBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const WALLET_SCRIPT = (addr) => {
  const provider = { async request({ method, params = [] }) {
    switch (method) {
      case 'eth_accounts': case 'eth_requestAccounts': return [addr];
      case 'eth_chainId': return '0x1';
      case 'personal_sign': return window.__sign(params[0]);
      case 'eth_sendTransaction': return window.__send(params[0]);
      case 'eth_signTypedData_v4': return window.__signTyped(params[1]);
      case 'wallet_switchEthereumChain': return null;
      case 'wallet_requestPermissions': case 'wallet_revokePermissions': return [];
      default: throw Object.assign(new Error('unsupported ' + method), { code: 4200 });
    }
  }, on() {}, removeListener() {} };
  const info = { uuid: '00000000-0000-4000-8000-000000000001', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'test.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};
// the gate: the Tacit wallet is opened with the Ethereum wallet, which signs once (twice, to be sure it signs the same)
async function unlock(page) {
  const gate = page.locator('button', { hasText: /Connect wallet|Ethereum wallet|Tacit wallet/ }).first(), form = page.locator('#f-damt');
  // a page that was opened before keeps the Tacit wallet open, and shows the form at once
  await Promise.race([gate.waitFor({ state: 'visible', timeout: 60000 }), form.waitFor({ state: 'attached', timeout: 60000 })]);
  if (!(await form.count())) await gate.click();
  await form.waitFor({ state: 'attached', timeout: 60000 });
}

// what the page asks of nodes and services, answered with the least that keeps it going
const POOL_DEN = new Map(FIXED_POOLS[1].map((p) => [p.address.toLowerCase(), p.denomination]));
const SELS = { den: bytesToHex(keccak_256(new TextEncoder().encode('denomination()')).slice(0, 4)), com: bytesToHex(keccak_256(new TextEncoder().encode('commitments(bytes32)')).slice(0, 4)), next: bytesToHex(keccak_256(new TextEncoder().encode('nextIndex()')).slice(0, 4)) };
// how many deposits each pool has had and how many notes are in it now (the line under a row of notes in the split)
const POOL_SIZE = new Map([[10n ** 17n, [76863n, 6502n]], [10n ** 18n, [97860n, 4221n]], [10n * 10n ** 18n, [79970n, 2409n]], [100n * 10n ** 18n, [50287n, 2810n]]]);
// registry: the relay registry's list, when a test gives one (the page reads it through a node, like any chain data)
const REGISTRY = '0x00000000000299f48fb844626ab96c6a20059a01';
let REGISTRY_ENTRIES = null;
const WAITING = new Map();
// TOKEN_CHAIN: a token pool's history, when a test gives one (tokenChain below): its logs, the size the pool answers for each root, the head, receipts
let TOKEN_CHAIN = null;
const lcs = (x) => String(x).toLowerCase();
const T_TRANSACT = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)')));
const ROOT_SIZE = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('rootSize(bytes32)')).slice(0, 4));
const w64 = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, '0');
const rpcAnswer = (method, params = [], landed = new Set(), depositLogs = []) => {
  if (method === 'eth_call' && REGISTRY_ENTRIES && String(params[0]?.to).toLowerCase() === REGISTRY && String(params[0]?.data).startsWith('0xd4d25113')) {
    const start = Number(BigInt('0x' + params[0].data.slice(10 + 64, 10 + 128)));
    return encodeList(REGISTRY_ENTRIES.slice(start, start + 100), Math.min(REGISTRY_ENTRIES.length, start + 100));
  }
  switch (method) {
    // a note's deposit, as the pool logged it: [{ c, index, time }] by commitment (the pool's 1 ETH pool, 29,999,000)
    case 'eth_getLogs': {
      const q = params[0] || {}, a = parseInt(q.fromBlock, 16), b = parseInt(q.toBlock, 16), blk = 29_999_000;
      if (TOKEN_CHAIN && [q.address].flat().some((x) => lcs(x) === lcs(TOKEN_CHAIN.pool))) {
        const t0 = [q.topics?.[0] ?? []].flat().map(lcs);
        return TOKEN_CHAIN.logs.filter((l) => (!t0.length || t0.includes(l.topics[0])) && Number(l.blockNumber) >= a && Number(l.blockNumber) <= b);
      }
      return depositLogs.filter((d) => String(q.topics?.[1]).toLowerCase() === d.c && blk >= a && blk <= b).map((d) => ({
        address: q.address, topics: [q.topics[0], d.c], blockNumber: '0x' + blk.toString(16),
        data: '0x' + BigInt(d.index).toString(16).padStart(64, '0') + BigInt(d.time).toString(16).padStart(64, '0') }));
    }
    case 'eth_call': {
      const { to, data } = params[0] || {};
      if (TOKEN_CHAIN && lcs(to) === lcs(TOKEN_CHAIN.pool) && String(data).startsWith(ROOT_SIZE)) return '0x' + w64(TOKEN_CHAIN.sizeOf.get(BigInt('0x' + data.slice(10, 74))) ?? 0);
      const den = POOL_DEN.get(String(to).toLowerCase());
      if (den == null) return '0x';
      if (data.slice(2, 10) === SELS.next) return '0x' + POOL_SIZE.get(den)[0].toString(16).padStart(64, '0');
      if (data.slice(2, 10) === SELS.den) return '0x' + den.toString(16).padStart(64, '0');
      if (data.slice(2, 10) === SELS.com) return '0x' + (landed.has(data.slice(10)) ? '1' : '0').padStart(64, '0');
      return '0x';
    }
    case 'eth_getCode': return POOL_DEN.has(String(params[0]).toLowerCase()) ? '0x6080' : '0x';
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return '0x' + (TOKEN_CHAIN?.tip ?? 0x1c9c380).toString(16);
    case 'eth_getBalance': {
      const waiting = WAITING.get(String(params[0]).toLowerCase());
      if (waiting != null) return waiting;
      const den = POOL_DEN.get(String(params[0]).toLowerCase());
      if (den != null) return '0x' + (den * POOL_SIZE.get(den)[1]).toString(16);
      return String(params[0]).toLowerCase() === ADDR.toLowerCase() ? '0x' + (100n * 10n ** 18n).toString(16) : '0x0';   // the test wallet holds 100 ETH
    }
    case 'eth_gasPrice': return GAS_PRICE;
    case 'eth_getTransactionReceipt': return TOKEN_CHAIN?.receipts.get(params[0]) ?? { status: '0x1', blockNumber: '0x1c9c380', logs: [] };
    case 'eth_getBlockByNumber': return { number: '0x1c9c380', timestamp: '0x6a000000', baseFeePerGas: '0x5f5e100', transactions: [] };
    default: return '0x';
  }
};
// names: records the name service holds ({ 'ross.wei': { pool, address, box } }), swapped in for the page's own lookups;
// keeper: the relay's quote, answered for the chain. What the page sent from the wallet and told the relay is returned.
const NAMES_STUB = `export const makeMainnetCall = () => async () => '0x';
export function makeConfidentialNames() {
  const calls = {};
  const base = {
    resolveName: async (n) => { const r = window.__names?.[n]; if (!r) { const e = new Error(n + ' has not published a Tacit address.'); e.code = 'no-record'; throw e; }
      calls[n] = (calls[n] || 0) + 1; const pool = r.flip && calls[n] % 2 === 0 ? r.flip : r.pool; return { name: n, pool, address: r.address }; },
    readBox: async (n) => window.__names?.[n]?.box ?? null,
    findPrimary: async () => ({ primary: null }),
    planPublish: async () => ({ changed: false }),
  };
  // any other call answers null; "then" must stay undefined or awaiting the object waits on it forever
  return new Proxy(base, { get: (t, k) => (k in t || k === 'then' || typeof k === 'symbol' ? t[k] : async () => null) });
}`;
// notes: values (wei) the private balance holds, standing in for what the wallet would read from the pool: the real wallet module is
// served with its sync and notes answering these, so the form sees a funded balance
const WALLET_WRAP = `
export function makeEvmPoolWallet(o) {
  const w = __realMakeEvmPoolWallet(o), fake = globalThis.__fakeNotes;
  if (!fake) return w;
  const sync = w.sync;
  w.sync = async (...a) => { const s = await sync.apply(w, a); return { ...s, balance: fake.reduce((x, v) => x + BigInt(v), 0n), behind: false }; };
  w.notes = () => fake.map((v) => ({ v: BigInt(v) }));
  return w;
}`;
// stubProve: a token pool's wallet proves with a stand-in (the relay at the other end checks nothing of the proof), so a spend runs to its send
const PROVE_WRAP = `
export function makeEvmPoolWallet(o) {
  if (!o.chain?.token) return __realMakeEvmPoolWallet(o);
  return __realMakeEvmPoolWallet({ ...o, prove: async () => { globalThis.__proved = (globalThis.__proved || 0) + 1; return { proof: { pi_a: ['1', '2'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['1', '2'] }, publicSignals: Array(11).fill('0') }; } });
}`;
// payWith: dapp/pay-with.js served with a fixed price (3,000 of a token a ETH; `__priceMove` added to every quote after the first) and a pull that finds an
// allowance in place, and the wallet's deposits replaced by a spy that builds the call the page hands it (selfCall) on a stand-in proof and keeps it
const PAYWITH_STUB = `export const ZAP = '0x0000008EbBF2323f95c4fBc18254f3D65C53998c';
export const payTokens = (l) => l.filter((t) => t.c === 1 && ['USDC', 'DAI', 'WBTC'].includes(t.s));
export const mostOf = (x) => (BigInt(x) * 101n + 99n) / 100n;
export async function quoteDeposit({ token, dec, depositWei }) { const n = (globalThis.__quotes = (globalThis.__quotes || 0) + 1); return { amountIn: (BigInt(depositWei) * 3000n * 10n ** BigInt(dec)) / 10n ** 18n + (n > 1 ? BigInt(globalThis.__priceMove || 0) : 0n), callData: '0xfeed', min: BigInt(depositWei), out: BigInt(depositWei), name: 'Uniswap v3 0.05%' }; }
export async function zapPullWith(o) { globalThis.__pulled = { token: o.token, amount: String(o.amount) }; return { kind: 'allowance' }; }
export async function quoteOut({ token, amount, to }) { globalThis.__outQuotes = (globalThis.__outQuotes || 0) + 1; const out = BigInt(amount) * 3000n; return { r: { to, out, min: (out * 995n) / 1000n, callData: '0xbeef', deadline: 9999999999n, name: 'Uniswap v4 0.05%' }, gas: 900000 }; }
export const outIntent = (gw, { r, amount, refund, nonce }) => gw.callIntent({ calls: [{ target: '0x000000000000FB114709235f1ccBFfb925F600e4', value: BigInt(amount), data: r.callData }], refund, deadline: r.deadline, nonce });`;
const DEPOSIT_SPY = `
export function makeEvmPoolWallet(o) {
  const w = __realMakeEvmPoolWallet(o);
  const tx = { pA: [1n, 2n], pB: [[1n, 2n], [3n, 4n]], pC: [1n, 2n], publicInputs: Array(11).fill(0n), recipient: '0x' + '00'.repeat(20), extAmount: 0n, relayer: '0x' + '00'.repeat(20), fee: 0n, memo0: '0x', memo1: '0x' };
  const spy = (kind) => async (a) => { const c = a.selfCall ? a.selfCall({ ...tx, extAmount: BigInt(a.amount) }) : null; (globalThis.__deposits ||= []).push({ kind, amount: String(a.amount), to: a.to || null, call: c && { to: c.to, value: String(c.value), sel: c.data.slice(0, 10), before: !!c.before } }); return '0x' + 'cd'.repeat(32); };
  w.deposit = spy('deposit'); w.depositTo = spy('depositTo');
  const fake = globalThis.__fakeNotes;
  if (fake) {
    const sync = w.sync;
    w.sync = async (...a) => { const s = await sync.apply(w, a); return { ...s, balance: fake.reduce((x, v) => x + BigInt(v), 0n), behind: false }; };
    w.notes = () => fake.map((v) => ({ v: BigInt(v) }));
  }
  w.spendQuote = async (gas) => { (globalThis.__feeGas ||= []).push(gas); return { fee: String(5n * 10n ** 14n) }; };
  w.refundBox = async () => '0x' + 'ee'.repeat(20);
  w.withdrawAndCall = async (a) => { (globalThis.__calls ||= []).push({ amount: String(a.amount), gas: a.gas, maxFee: a.maxFee == null ? null : String(a.maxFee), via: a.via, calls: a.intent.calls.map((x) => ({ target: x.target, value: String(x.value), data: x.data })), refund: a.intent.refund }); return '0x' + 'ce'.repeat(32); };
  return w;
}`;
// payWrap: the card module served with the parts that need a wallet's signatures and a prover replaced by recorders (the flags are set
// on the page: __fakeRun makes the split's run place notes at once, __fakeExit makes a note withdrawal come back at once)
const PAY_WRAP = `
export function attach(env) {
  const o = env.onPlan;
  return __realAttach({ ...env, onPlan: (p) => o(p && globalThis.__fakeRun ? { ...p, run: async (step) => { globalThis.__ran = (globalThis.__ran || 0) + 1; step('fake'); return { text: 'Fake: the notes are placed.', h: globalThis.__fakeH ?? null }; } } : p) });
}
export function attachIntake(env) {
  return __realAttachIntake(!globalThis.__fakeIntake ? env : { ...env, send: async (a) => {
    (globalThis.__intakes ||= []).push({ n: a.intent.calls.length, amount: a.amount.toString(), via: a.via, gas: a.gas, maxFee: a.maxFee == null ? null : a.maxFee.toString() });
    for (const c of a.intent.calls) await globalThis.__land(c.data.slice(10));
    return '0x' + 'ab'.repeat(32);
  } });
}
export function attachWithdraw(env) {
  const ctl = __realAttachWithdraw(env);
  if (!globalThis.__fakeExit) return ctl;
  return { get list() { return ctl.list; }, repaint: ctl.repaint, exit: async (step, c, notes, to) => {
    (globalThis.__exits ||= []).push({ n: notes.length, to }); step('fake');
    if (globalThis.__exitFail) throw Object.assign(new Error('1 of 2 notes went out (fake). Note 2 did not: fake'), { done: [] });
    return notes.map((x, i) => ({ receive: x.den - 10n ** 15n, spent: true, hash: '0x' + (i + 1).toString(16).padStart(64, 'a') }));
  } };
}`;
const POOL1 = FIXED_POOLS[1][1].address;
let GAS_PRICE = '0x0';
// route: the private route on, its forwarders answered by route.carry (sealedRoute below); tabKey: a Tacit key this tab holds already, opened with no sign-in
async function open({ search = '', flagged = null, chain = 1, names = null, keeper = null, keeperCap = null, quotes = null, notes = null, payWrap = false, fixedNotes = null, depositLogs = [], registry = null, min = '1000000000000000000', gasPrice = '0x0', route = null, stubProve = false, tabKey = null, payWith = false } = {}) {
  REGISTRY_ENTRIES = registry; GAS_PRICE = gasPrice; WAITING.clear();
  const ctx = await browser.newContext({ viewport: { width: 560, height: 1100 } });
  const page = await ctx.newPage();
  const problems = [], sent = [], told = [], keeperCalls = [], landed = new Set();
  await page.exposeFunction('__send', async (tx) => { sent.push(tx); return '0x' + 'ab'.repeat(32); });
  await page.exposeFunction('__land', (c) => { landed.add(c); });
  await page.exposeFunction('__signTyped', (json) => { const n = BigInt(JSON.parse(json).message.nonce), h = (x) => BigInt(x).toString(16).padStart(64, '0'); return '0x' + h(0x1111n + n) + h(1n + n) + '1b'; });
  if (payWrap) {
    const real = readFileSync(join(DAPP, 'fixed-pool-pay.js'), 'utf8').replace('export function attach(', 'function __realAttach(').replace('export function attachWithdraw(', 'function __realAttachWithdraw(').replace('export function attachIntake(', 'function __realAttachIntake(');
    assert.ok(real.includes('function __realAttach(') && real.includes('function __realAttachWithdraw(') && real.includes('function __realAttachIntake('), 'the card module is wrapped');
    await page.route(/\/fixed-pool-pay\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: real + PAY_WRAP }));
  }
  if (fixedNotes) {
    await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, [`tacit-fixed-notes:1:${ADDR.toLowerCase()}`, fixedNotes]);
  }
  if (payWith) {
    await page.route(/\/pay-with\.js/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: PAYWITH_STUB }));
    const real = readFileSync(join(DAPP, 'evm-pool-wallet.js'), 'utf8').replace('export function makeEvmPoolWallet(', 'function __realMakeEvmPoolWallet(');
    await page.route(/\/evm-pool-wallet\.js/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: real + DEPOSIT_SPY }));
  }
  if (payWith && notes) await page.addInitScript((n) => { window.__fakeNotes = n; }, notes.map(String));
  if (!payWith && (notes || stubProve)) {
    if (notes) await page.addInitScript((n) => { window.__fakeNotes = n; }, notes.map(String));
    const real = readFileSync(join(DAPP, 'evm-pool-wallet.js'), 'utf8').replace('export function makeEvmPoolWallet(', 'function __realMakeEvmPoolWallet(');
    assert.ok(real.includes('function __realMakeEvmPoolWallet('), 'the wallet module is wrapped');
    await page.route(/\/evm-pool-wallet\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: real + (notes ? WALLET_WRAP : PROVE_WRAP) }));
  }
  if (tabKey) await page.addInitScript((k) => { try { sessionStorage.setItem('tacit-tab-key-v1', JSON.stringify({ mode: 'key', priv: k, at: Date.now() })); } catch {} }, tabKey);
  if (names) {
    await page.addInitScript((n) => { window.__names = n; }, names);
    await page.route(/\/confidential-names\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: NAMES_STUB }));
  }
  // The private route has its own tests (tests/private-route*.test.mjs, worker-relay/tests/relay-community-route.test.mjs). The flows here are the form's, and this
  // stand-in answers a keeper's quote directly, so the page gets the route's module with the route off: its relay requests go straight to the stand-in.
  // With `route` it stays on, sealed to the keepers service's gateway key that `route` holds the secret of, and with no Nostr carrier (nothing leaves the machine).
  const ROUTE_ON = 'export const available = () => !!(ROUTE.gateway && ROUTE.forwarders.length);', ROUTE_KEY = /^  gateway: '[0-9a-f]{66}',/m, ROUTE_NOSTR = /^  nostr: \[[^\]]*\],/m;
  const routeSrc = readFileSync(join(DAPP, 'private-route.js'), 'utf8');
  assert.ok(routeSrc.includes(ROUTE_ON) && ROUTE_KEY.test(routeSrc) && ROUTE_NOSTR.test(routeSrc), 'the route module still defines available(), its gateway key and its Nostr relays the way this stand-in expects');
  const routeServed = route ? routeSrc.replace(ROUTE_KEY, `  gateway: '${route.gateway}',`).replace(ROUTE_NOSTR, '  nostr: [],') : routeSrc.replace(ROUTE_ON, 'export const available = () => false;');
  await page.route(/\/private-route\.js/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: routeServed }));
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  if (process.env.DEBUG_PAGE) page.on('console', (m) => console.log('   [page]', m.type(), m.text().slice(0, 300)));
  if (process.env.DEBUG_PAGE === '2') page.on('request', (r) => console.log('   [req]', r.method(), r.url().slice(0, 130), r.method() === 'POST' ? (r.postData() || '').slice(0, 90) : ''));
  if (process.env.DEBUG_PAGE) page.on('response', (r) => { if (r.status() >= 400) console.log('   [http]', r.status(), r.url().slice(0, 160)); });
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp ' + m.text()); });
  await page.exposeFunction('__sign', async (msgHex) => {
    const msg = hexToBytes(msgHex.replace(/^0x/, ''));
    const sig = await secp.signAsync(keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg)), KEY);
    return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16);
  });
  if (min != null) await page.addInitScript((m) => { try { localStorage.setItem('tacit-fixed-min:1', m); } catch {} }, min);   // the tests below were written for a 1 ETH smallest note; the ones for the default pass min: null
  await page.addInitScript(WALLET_SCRIPT, ADDR);
  await page.addInitScript(([c, f]) => { try { localStorage.setItem('tacit-pay-chain-v1', JSON.stringify(c)); if (f != null) localStorage.setItem('tacit-fixed-pools', f); } catch {} }, [chain, flagged]);
  const carry = route?.carry;
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const carried = carry ? await carry(req) : null;
    if (carried) return route.fulfill({ status: carried.status, headers: { ...headers, 'content-type': carried.type }, body: carried.body });
    if (/\/evm-pool\/keeper\//.test(req.url())) keeperCalls.push({ method: req.method(), url: req.url() });
    const custom = quotes && /\/evm-pool\/keeper\/quote/.test(req.url()) ? await quotes(req.url(), req) : null;
    if (custom) return route.fulfill({ status: custom.status || 200, headers, contentType: 'application/json', body: JSON.stringify(custom.body || custom) });
    if (keeper && keeperCap && /\/evm-pool\/keeper\/quote/.test(req.url()) && Number(new URL(req.url()).searchParams.get('gas')) > keeperCap) return route.fulfill({ status: 400, headers, contentType: 'application/json', body: JSON.stringify({ error: `gas above the ${keeperCap} cap` }) });
    if (keeper && /\/evm-pool\/keeper\/quote/.test(req.url())) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(keeper) });
    if (keeper && req.method() === 'POST' && /\/evm-pool\/keeper\/receive/.test(req.url())) { told.push(req.postDataJSON()); return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '{"ok":true}' }); }
    if (req.method() === 'POST') {
      let body = null; try { body = req.postDataJSON(); } catch { /* not JSON */ }
      const one = (b) => ({ jsonrpc: '2.0', id: b?.id ?? 1, result: rpcAnswer(b?.method, b?.params, landed, depositLogs) });
      if (body) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    }
    return route.fulfill({ status: 404, headers, body: '{}' });
  });
  await page.goto(base + '/pay/eth/' + search);
  return { ctx, page, problems, sent, told, keeperCalls, waiting: WAITING, landed };
}

// the ordinary quotes a relay was asked for (its base URL), and a sync forced through the balance's refresh, as a person would: pressed until a new one has
// asked the built-in relay at `own` for its quote (a press while one runs is not taken), and waited for where the page shows it running. → the quotes it asked of `own`
const quotesAt = (calls, base) => calls.filter((c) => c.url === `${base}/quote`).length;
async function syncAgain(page, calls, own) {
  const before = quotesAt(calls, own);
  for (let i = 0; i < 120 && quotesAt(calls, own) === before; i++) { await page.click('#bal-re').catch(() => {}); await page.waitForTimeout(500); }
  assert.ok(quotesAt(calls, own) > before, 'a sync ran');
  await page.waitForFunction(() => { const b = document.querySelector('#bal-re'); return b && !b.disabled && !b.hasAttribute('aria-disabled'); }, null, { timeout: 60000 });
  return quotesAt(calls, own) - before;
}

console.log('Pay page');
await test('with ?fixed=0 the deposit form has no large-pool cards and the module is never asked for', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=0' });
  const asked = [];
  page.on('request', (r) => { if (/fixed-pool-pay/.test(r.url())) asked.push(r.url()); });
  await unlock(page);
  await page.fill('#f-damt', '2.5');
  assert.equal(await page.locator('#lg-split').count(), 0);
  assert.equal(await page.locator('#lg-notes').count(), 0);
  await page.click('#dep-addr'); // From an exchange
  await page.waitForSelector('#f-check', { timeout: 30000 });
  assert.equal(await page.locator('#lg-name').count(), 0, 'no deposit-address row with the cards off');
  assert.deepEqual(asked, []);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('?fixed=1 on Ethereum: the cards load under the page\'s policy and the split shows for 2.5 ETH', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=1' });
  await unlock(page);
  await page.waitForSelector('#lg-split', { state: 'attached' });
  await page.fill('#f-damt', '2.5');
  await page.waitForFunction(() => /2 × 1 ETH/.test(document.querySelector('#lg-split')?.textContent || ''), null, { timeout: 30000 });
  const text = await page.locator('#lg-split').innerText();
  assert.match(text, /2 × 1 ETH\s+whole notes · Tornado Cash/); assert.match(text, /0\.5 ETH\s+your private balance/);
  assert.match(text, /a few signatures first \(nothing is sent\)/, 'the signatures are announced before the first is asked for');
  assert.match(await page.locator('#lg-notes').innerText(), /Notes in the large pools/);
  assert.equal(await page.locator('#lg-go').count(), 0, 'the card has no button of its own: the form\'s is the one');
  assert.match(await page.locator('#f-go').innerText(), /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/, 'the wallet that opened the page is the one that deposits');
  // the split is drawn once, between the amount and the receipt, and the receipt does not say it again
  assert.equal(await page.evaluate(() => { const a = document.querySelector('#f-damt'), s = document.querySelector('#lg-split'), r = document.querySelector('#f-rcpt'); return !!(a.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(s.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING); }), true, 'amount, then the split, then the receipt');
  assert.doesNotMatch(await page.locator('#f-rcpt').innerText(), /Into the large pools|Into your private balance/);
  assert.match(await page.locator('#f-rcpt').innerText(), /Relay fee\s+none/);
  // the crowd the notes blend in with, read from the pool, and the points the part that goes to Tacit earns
  await page.waitForFunction(() => /1 ETH pool: 97,860 deposits so far, 4,221 notes in it now\./.test(document.querySelector('#lg-split')?.textContent || ''), null, { timeout: 30000 });
  assert.match(await page.locator('#lg-split').innerText(), /Whole notes earn no TAC points/);
  assert.equal(await page.locator('#f-rcpt svg.tk use[href="#tk-tac"]').count(), 1, 'the points row has the TAC icon');
  const pts = (await page.locator('#f-rcpt').innerText()).match(/TAC points\s+how\?\s+(?:≈|at least)\s*([\d,.]+)/);
  assert.ok(pts && Number(pts[1].replace(/,/g, '')) >= 500, 'the points are an amount, at least 1,000 a ETH on the 0.5 ETH that goes to Tacit: ' + (pts && pts[0]));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'paypage-cards.png'), fullPage: true });
  await page.fill('#f-damt', '0.9');
  await page.waitForFunction(() => /^Deposit privately$/.test(document.querySelector('#f-go')?.textContent || ''));
  await page.click('#dep-addr'); // From an exchange: the row for the name's deposit address has its place
  await page.waitForSelector('#lg-name', { state: 'attached', timeout: 30000 });
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('?fixed=0 turns the flag off again, even where it was on', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=0', flagged: '1' });
  await unlock(page);
  await page.fill('#f-damt', '2.5');
  assert.equal(await page.locator('#lg-split').count(), 0);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('with the flag on another chain (Base, opened with ?chains=all) the deposit form is untouched', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=1&chains=all', chain: 8453 });
  await unlock(page);
  await page.fill('#f-damt', '2.5');
  assert.equal(await page.locator('#lg-split').count(), 0);
  assert.deepEqual(problems, []);
  await ctx.close();
});

// ── Send: a name that publishes a deposit address can be paid from the wallet when the private balance cannot cover it ──
const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });
const payee = evmPoolKeys(zk, new Uint8Array(32).fill(21)), other = evmPoolKeys(zk, new Uint8Array(32).fill(22));
const hex64 = (n) => n.toString(16).padStart(64, '0');
const N1 = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn, N2 = N1 + 1n;
const BOX1 = receiveBoxAddress(N1, RECEIVE_FEE_BPS, EVM_POOL_ROUTER), BOX2 = receiveBoxAddress(N2, RECEIVE_FEE_BPS, EVM_POOL_ROUTER);
const rec = async (v, n) => ({ n: hex64(n), ns: await signBox(v, n) });
const ENTRY = { pool: payee.address, address: '0x' + 'cd'.repeat(20) };
const QUOTE = { chainId: 1, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', relayer: '0x' + '11'.repeat(20), fee: '100000000000000', receiveMin: '856000000000000' };
const toSend = async (page, to, amount) => {
  await unlock(page);
  await page.click('#tab-send');
  await page.fill('#f-to', to);
  await page.fill('#f-amt', amount);
};
const receiptText = async (page, re) => {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#f-rcpt')?.textContent || ''), re.source, { timeout: 60000 });
  return page.locator('#f-rcpt').innerText();
};
console.log('Send');
await test('a name with a deposit address, an empty private balance: the wallet pays the box, and the relay is told of it', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, problems, sent, told } = await open({ search: '?fixed=1', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  const text = await receiptText(page, /You send/);
  assert.match(text, /ross\.wei/); assert.match(text, /0\.5 ETH from your wallet/); assert.match(text, /at least 0\.49875 ETH/);
  assert.match(await page.locator('#f-note').innerText(), /deposit address show on chain/);
  assert.match(await page.locator('#f-go').innerText(), /Pay ross\.wei from my wallet/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'send-from-wallet.png'), fullPage: true });
  await page.click('#f-go');
  await page.waitForFunction(() => /Paid ross\.wei 0\.5 ETH/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.toLowerCase(), BOX1.toLowerCase(), 'plain ETH to the box the record names');
  assert.equal(sent[0].value, '0x' + (5n * 10n ** 17n).toString(16));
  assert.equal(sent[0].from.toLowerCase(), ADDR.toLowerCase());
  assert.equal(sent[0].data, undefined, 'no call data: a plain transfer');
  // the page also tells the relay of its own wallet's boxes, so only what names the payee's box key counts
  assert.deepEqual(told.filter((b) => b.npk === N1.toString()), [{ chainId: 1, npk: N1.toString(), feeBps: RECEIVE_FEE_BPS }]);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('below the relay\'s minimum nothing is offered', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, sent } = await open({ search: '?fixed=1', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.0005');
  assert.match(await receiptText(page, /needs at least/), /needs at least 0\.000856 ETH/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  await ctx.close();
});
await test('a name payment uses the built-in receiver\'s minimum, not the community spend quote\'s', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const R2 = '0x' + 'b2'.repeat(20), own = 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', community = 'https://tacit-evm-pool-forwarder.onrender.com/1/evm-pool/keeper';
  const { ctx, page, sent, problems } = await open({
    search: '?fixed=1', names, registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: community }],
    quotes: (url) => {
      if (url === `${own}/quote`) return { ...QUOTE, receiveMin: '2000000000000000000' };
      if (url === `${community}/quote`) return { ...QUOTE, relayer: R2, receiveMin: '1000000000000000000' };
      return null;
    },
  });
  await toSend(page, 'ross.wei', '1.5');
  assert.match(await receiptText(page, /needs at least/), /needs at least 2(?:\.0+)? ETH/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a name payment cannot fall back to a community minimum when the built-in receiver fails at submission', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const R2 = '0x' + 'b2'.repeat(20), own = 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', community = 'https://tacit-evm-pool-forwarder.onrender.com/1/evm-pool/keeper';
  let ownDown = false;
  const { ctx, page, sent, told, problems } = await open({
    search: '?fixed=1', names, registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: community }],
    quotes: (url) => {
      if (url === `${own}/quote`) return ownDown ? { status: 503, body: { error: 'the built-in receiver is down' } } : { ...QUOTE, receiveMin: '500000000000000000' };
      if (url === `${community}/quote`) return { ...QUOTE, relayer: R2, receiveMin: '100000000000000000' };
      return null;
    },
  });
  await toSend(page, 'ross.wei', '0.75');
  await receiptText(page, /You send/);
  ownDown = true;
  await page.click('#f-go');
  await page.waitForFunction(() => /Could not read the relay’s minimum/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(sent.length, 0);
  assert.deepEqual(told.filter((b) => b.npk === N1.toString()), []);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a request link paid from a wallet is refused while the relay\'s minimum cannot be read, and goes once it can', async () => {
  // the minimum is the built-in relay's floor for moving a payment in: below it the payment waits at the link's address for its payee to take in, from a
  // wallet of theirs and at their cost, and the payer cannot take it back; so an unknown minimum sends nothing rather than guess it is 0
  const own = 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', r = await rec(payee.v, N1);
  let ownDown = true;
  const { ctx, page, sent, told, problems } = await open({
    keeper: QUOTE, quotes: (url) => (ownDown && url === `${own}/quote` ? { status: 503, body: { error: 'the built-in relay is down' } } : null),
  });
  await unlock(page);
  await page.evaluate((h) => { location.hash = h; }, `pay=${payee.address}&n=${r.n}&ns=${r.ns}&amount=0.5&chain=ethereum`);
  const press = async () => { await page.waitForSelector('#req-wallet:not([disabled])', { timeout: 30000 }); await page.click('#req-wallet'); };
  await press();
  await page.waitForFunction(() => /Could not read the relay’s minimum/.test(document.querySelector('#req')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(sent.length, 0, 'nothing was sent to the link\'s address');
  assert.deepEqual(told.filter((b) => b.npk === N1.toString()), []);
  ownDown = false;
  await press();
  await page.waitForFunction(() => /Paid 0\.5 ETH/.test(document.body.textContent || ''), null, { timeout: 30000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.toLowerCase(), BOX1.toLowerCase(), 'plain ETH to the box the link names');
  assert.equal(sent[0].value, '0x' + (5n * 10n ** 17n).toString(16));
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a name with no deposit address cannot be paid from the wallet here, and the form says what to do', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: null } };
  const { ctx, page, sent } = await open({ search: '?fixed=1', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  assert.match(await receiptText(page, /has not published a deposit address/), /Deposit tab/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  await ctx.close();
});
await test('a record signed by another key is refused: nothing is offered', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(other.v, N1) } };
  const { ctx, page, sent } = await open({ search: '?fixed=1', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  assert.match(await receiptText(page, /More than your private balance covers/), /^((?!from my wallet)[\s\S])*$/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  await ctx.close();
});
await test('a name whose pool address moved between the two lookups is refused', async () => {
  const names = { 'ross.wei': { ...ENTRY, flip: other.address, box: await rec(other.v, N1) } };
  const { ctx, page, sent } = await open({ search: '?fixed=1', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  assert.match(await receiptText(page, /More than your private balance covers/), /^((?!from my wallet)[\s\S])*$/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  await ctx.close();
});
await test('a record that changes after it is shown is read again at the press, and nothing is sent', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, sent, told } = await open({ search: '?fixed=1', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  await receiptText(page, /You send/);
  const next = await rec(payee.v, N2);
  await page.evaluate((b) => { window.__names['ross.wei'].box = b; }, next);
  await page.click('#f-go');
  await page.waitForFunction(() => /Where that name points changed/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(sent.length, 0); assert.deepEqual(told.filter((b) => b.npk === N1.toString() || b.npk === N2.toString()), []);
  assert.notEqual(BOX1, BOX2);
  await ctx.close();
});
await test('with the cards off (?fixed=0) the Send form never looks for a deposit address', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, sent } = await open({ search: '?fixed=0', names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  assert.match(await receiptText(page, /More than your private balance covers/), /^((?!from my wallet)[\s\S])*$/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  await ctx.close();
});

// ── Send: with a private balance that covers the payment, the wallet is one visible link away ──
const ETH = 10n ** 18n;
const sendToName = async (page, amount) => { await toSend(page, 'ross.wei', amount); };
await test('a private balance that covers it pays privately, with one link to pay from the wallet instead, and one back', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, sent, problems } = await open({ search: '?fixed=1', names, keeper: QUOTE, notes: [ETH] });
  await sendToName(page, '0.5');
  const text = await receiptText(page, /Pay ross\.wei from my wallet instead/);
  assert.match(text, /They receive/); assert.doesNotMatch(text, /You send/);
  assert.match(await page.locator('#f-go').innerText(), /Send privately/, 'private stays the default');
  assert.match(await page.locator('#f-note').innerText(), /Nothing on chain links/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'send-link.png'), fullPage: true });
  await page.click('#f-viawallet');
  const chosen = await receiptText(page, /You chose your wallet over your private balance/);
  assert.match(chosen, /You send/); assert.match(chosen, /Pay privately instead/);
  assert.match(await page.locator('#f-go').innerText(), /Pay ross\.wei from my wallet/);
  assert.match(await page.locator('#f-note').innerText(), /deposit address show on chain/);
  await page.click('#f-private');
  assert.match(await receiptText(page, /Pay ross\.wei from my wallet instead/), /They receive/);
  assert.match(await page.locator('#f-go').innerText(), /Send privately/);
  assert.equal(sent.length, 0, 'nothing is sent by moving between the two');
  await page.click('#f-viawallet');
  await receiptText(page, /You chose your wallet/);
  await page.click('#f-go');
  await page.waitForFunction(() => /Paid ross\.wei 0\.5 ETH/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60000 });
  assert.equal(sent.length, 1); assert.equal(sent[0].to.toLowerCase(), BOX1.toLowerCase());
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('changing the recipient puts the form back on the private payment', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) }, 'kim.wei': { ...ENTRY, box: null } };
  const { ctx, page } = await open({ search: '?fixed=1', names, keeper: QUOTE, notes: [ETH] });
  await sendToName(page, '0.5');
  await receiptText(page, /from my wallet instead/);
  await page.click('#f-viawallet');
  await receiptText(page, /You chose your wallet/);
  await page.fill('#f-to', 'kim.wei');
  await receiptText(page, /They receive/);
  assert.equal(await page.locator('#f-viawallet').count(), 0, 'a name with no deposit address has no such link');
  assert.match(await page.locator('#f-go').innerText(), /Send privately/);
  await page.fill('#f-to', 'ross.wei');
  assert.match(await receiptText(page, /from my wallet instead/), /They receive/);
  assert.match(await page.locator('#f-go').innerText(), /Send privately/, 'not still on the wallet');
  await ctx.close();
});
await test('a balance spread over too many notes keeps the private message, and the wallet stays a link, not the answer', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, sent } = await open({ search: '?fixed=1', names, keeper: QUOTE, notes: Array(12).fill(ETH / 10n) });
  await sendToName(page, '1.15');
  await receiptText(page, /spread over 12 notes/);
  const text = await receiptText(page, /from my wallet instead/);   // the link comes a moment after the message: wait for it, as for the message, before reading the receipt
  assert.match(text, /Send up to/); assert.match(text, /Pay ross\.wei from my wallet instead/);
  assert.doesNotMatch(text, /You send/); assert.doesNotMatch(text, /can’t cover this/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  await page.click('#f-viawallet');
  await receiptText(page, /You chose your wallet/);
  assert.equal(await page.locator('#f-go').isDisabled(), false);
  assert.equal(sent.length, 0);
  await ctx.close();
});
await test('with too little in the private balance the wallet is the way, and there is no link back', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page } = await open({ search: '?fixed=1', names, keeper: QUOTE, notes: [ETH / 10n] });
  await sendToName(page, '0.5');
  const text = await receiptText(page, /You send/);
  assert.match(text, /can’t cover this/); assert.doesNotMatch(text, /Pay privately instead/);
  assert.equal(await page.locator('#f-private').count(), 0);
  await ctx.close();
});
await test('with the cards off (?fixed=0) a funded Send form has no wallet link', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page } = await open({ search: '?fixed=0', names, keeper: QUOTE, notes: [ETH] });
  await sendToName(page, '0.5');
  assert.match(await receiptText(page, /They receive/), /0\.5 ETH/);
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#f-viawallet').count(), 0);
  await ctx.close();
});

// ── Deposit: one press for a large amount ──
const NAMES = async () => ({ 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } });
await test('Deposit: the form\'s one button deposits the whole notes and the rest, and the split can be turned off there', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=1', payWrap: true });
  await unlock(page);
  await page.evaluate(() => { window.__fakeRun = true; window.__fakeH = '0x' + 'ab'.repeat(32); });
  await page.fill('#f-damt', '3');
  await page.waitForFunction(() => /^Deposit 3 ETH: 3 whole notes$/.test(document.querySelector('#f-go')?.textContent || ''), null, { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#f-rcpt').innerText(), /Into your private balance/, 'nothing left over');
  assert.doesNotMatch(await page.locator('#f-rcpt').innerText(), /TAC points/, 'whole notes alone earn no points, so none are promised');
  await page.fill('#f-damt', '2.5');
  await page.waitForFunction(() => /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/.test(document.querySelector('#f-go')?.textContent || ''));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'deposit-one-press.png'), fullPage: true });
  await page.selectOption('#lg-min', '0');
  await page.waitForFunction(() => /^Deposit privately$/.test(document.querySelector('#f-go')?.textContent || ''));
  assert.match(await page.locator('#f-rcpt').innerText(), /Into your private balance\s+2\.5 ETH/);
  await page.selectOption('#lg-min', '1000000000000000000');
  await page.waitForFunction(() => /2 whole notes \+ 0\.5/.test(document.querySelector('#f-go')?.textContent || ''));
  await page.click('#f-go');
  await page.waitForFunction(() => /Fake: the notes are placed/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__ran), 1, 'the plan ran once, inside the form\'s busy wrapper');
  assert.match(await page.locator('#status').innerText(), /Fake: the notes are placed\./);
  assert.equal(await page.locator('#status a').count() > 0, true, 'the transaction of what was left is linked');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('Deposit: to someone else the notes are not used, and the form says so', async () => {
  const { ctx, page } = await open({ search: '?fixed=1', payWrap: true, names: await NAMES() });
  await unlock(page);
  await page.fill('#f-damt', '2.5');
  await page.waitForFunction(() => /2 whole notes/.test(document.querySelector('#f-go')?.textContent || ''));
  await page.click('summary:has-text("Deposit to someone else")');
  await page.fill('#f-dto', 'ross.wei');
  await page.waitForFunction(() => /Deposit to them privately/.test(document.querySelector('#f-go')?.textContent || ''), null, { timeout: 30000 });
  assert.match(await page.locator('#f-rcpt').innerText(), /Whole notes are for your own balance/);
  await page.fill('#f-dto', '');
  await page.waitForFunction(() => /2 whole notes/.test(document.querySelector('#f-go')?.textContent || ''));
  await ctx.close();
});

// ── Withdraw: whole notes first, the rest from the private balance ──
const DEAD = '0x00000000000000000000000000000000000dead1';
const held = (n) => Array.from({ length: n }, (_, i) => ({ nonce: i, pool: POOL1, c: '0x' + (0xc0 + i).toString(16).padStart(64, '0'), nh: '0x' + (0xd0 + i).toString(16).padStart(64, '0') }));
// flags are set on the page before the Withdraw form opens, which is when the notes block attaches
const toWithdraw = async (page, amount, flags = null) => {
  await unlock(page);
  if (flags) await page.evaluate((f) => Object.assign(window, f), flags);
  await page.click('#tab-withdraw');
  await page.fill('#f-wto', DEAD);
  await page.fill('#f-wamt', amount);
};
const WD = { search: '?fixed=1', payWrap: true, keeper: QUOTE, notes: [ETH], fixedNotes: held(2) };
await test('Withdraw: the notes are counted first, the rest comes from the private balance, and the receipt says which is which', async () => {
  const { ctx, page, problems } = await open(WD);
  await toWithdraw(page, '2.3');
  const text = await receiptText(page, /From whole notes/);
  assert.match(text, /From whole notes\s+2 × 1 ETH/); assert.match(text, /paid from the notes, at most 3% of each/);
  assert.match(text, /From your private balance\s+0\.3 ETH/); assert.match(text, /at least 2\.24 ETH/);
  assert.match(await page.locator('#lg-wd').innerText(), /2 whole notes\s+2 ETH/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'withdraw-combined.png'), fullPage: true });
  await page.fill('#f-wamt', '0.4');
  await page.waitForFunction(() => /Arrives/.test(document.querySelector('#f-rcpt')?.textContent || '') && !/From whole notes/.test(document.querySelector('#f-rcpt')?.textContent || ''));
  await page.click('#f-max');
  const v = Number(await page.inputValue('#f-wamt'));
  assert.ok(v > 2.99 && v <= 3, 'Max is the notes and what the private balance can send: ' + v);
  assert.match(await receiptText(page, /From whole notes/), /2 × 1 ETH/);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('Withdraw: only notes, one press: the address is sent both, and nothing is asked of the private balance', async () => {
  const { ctx, page } = await open(WD);
  await toWithdraw(page, '2', { __fakeExit: true });
  const text = await receiptText(page, /From whole notes/);
  assert.doesNotMatch(text, /From your private balance/);
  await page.click('#f-go');
  await page.waitForFunction(() => /Withdrew 1\.998 ETH from 2 whole notes/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => window.__exits), [{ n: 2, to: DEAD }]);
  await ctx.close();
});
await test('Withdraw: when the notes fail partway the module\'s message is shown, and the private balance is not touched', async () => {
  const { ctx, page } = await open(WD);
  await toWithdraw(page, '2.3', { __fakeExit: true, __exitFail: true });
  await receiptText(page, /From whole notes/);
  await page.click('#f-go');
  await page.waitForFunction(() => /1 of 2 notes went out/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#status').innerText(), /The other 0\.3 ETH/, 'the rest was never attempted');
  await ctx.close();
});
await test('Notes: each shows when it went in and how many deposits came after it, the Withdraw tab names the newest, and the receipt asks to wait for more', async () => {
  const now = Math.floor(Date.now() / 1000), [n0, n1] = held(2);
  // the 1 ETH pool has 97,860 deposits: leaf 97,852 has 7 after it (five hours ago), leaf 97,855 has 4 (ten minutes ago)
  const depositLogs = [{ c: n0.c, index: 97852, time: now - 5 * 3600 }, { c: n1.c, index: 97855, time: now - 600 }];
  const { ctx, page, problems } = await open({ ...WD, depositLogs });
  await unlock(page);
  await page.waitForFunction(() => /Deposited 10 minutes ago · 4 deposits since/.test(document.querySelector('#lg-notes')?.textContent || ''), null, { timeout: 60000 });
  const card = await page.locator('#lg-notes').innerText();
  assert.match(card, /Deposited 5 hours ago · 7 deposits since/);
  assert.match(card, /Few deposits have come after them/, 'both are early, said once');
  assert.equal(await page.locator('#lg-notes p.note.warn').count(), 1, 'the advice is said once, not under each note');
  assert.equal(await page.locator('#lg-notes p.note.mute', { hasText: 'Deposited' }).count(), 2, 'each note says when it went in');
  await page.evaluate(() => { window.__fakeExit = true; });
  await page.click('#tab-withdraw');
  await page.fill('#f-wto', DEAD);
  await page.fill('#f-wamt', '2');
  await page.waitForFunction(() => /Newest note: deposited 10 minutes ago · 4 deposits since\./.test(document.querySelector('#lg-wd')?.textContent || ''), null, { timeout: 60000 });
  const text = await receiptText(page, /From whole notes/);
  assert.match(text, /Part of this went in recently: the newest note has only 4 deposits after it\. Waiting for more makes it blend in better\./);
  assert.equal(await page.locator('#f-rcpt p.note.warn').count(), 1);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('Notes: a note that is not in the log (or whose log cannot be read) has no line and no warning, and the withdrawal goes as before', async () => {
  const { ctx, page, problems } = await open({ ...WD });
  await toWithdraw(page, '2', { __fakeExit: true });
  const text = await receiptText(page, /From whole notes/);
  assert.doesNotMatch(text, /Part of this went in recently|less than an hour/);
  assert.doesNotMatch(await page.locator('#lg-wd').innerText(), /Newest note/);
  assert.equal(await page.locator('#lg-notes p.note.warn').count(), 0);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('Withdraw: an amount under a whole note is the ordinary withdrawal, with no notes in it', async () => {
  const { ctx, page } = await open(WD);
  await toWithdraw(page, '0.4');
  const text = await receiptText(page, /Arrives/);
  assert.doesNotMatch(text, /whole notes/);
  await ctx.close();
});
await test('Withdraw: with the cards off (?fixed=0) the form has no notes block and counts none', async () => {
  const { ctx, page } = await open({ ...WD, search: '?fixed=0' });
  await toWithdraw(page, '2.3');
  assert.equal(await page.locator('#lg-wd').count(), 0);
  const text = await receiptText(page, /Arrives|More than your private balance/);
  assert.doesNotMatch(text, /From whole notes/);
  await ctx.close();
});

// ── Withdraw: the way in from the private balance, and the wallet as the sender of a note ──
await test('Withdraw: whole notes from the private balance: the plan and the relay\'s fee, then the wallet as sender, and the notes are in the pools and kept', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=1', payWrap: true, keeper: QUOTE, notes: [10n * ETH] });
  await unlock(page);
  await page.evaluate(() => { window.__fakeIntake = true; });
  await page.click('#tab-withdraw');
  await page.waitForSelector('#li-amt', { state: 'attached', timeout: 30000 });
  await page.click('#lg-in summary');
  await page.fill('#li-amt', '2.5');
  await page.waitForFunction(() => /Relay fee\s*up to 0\.000125 ETH/.test(document.querySelector('#lg-in')?.textContent || ''), null, { timeout: 30000 });
  const t = await page.locator('#lg-in').innerText();
  assert.match(t, /2 × 1 ETH\s+whole notes, large pool/); assert.match(t, /0\.5 ETH\s+stays in your private balance/);
  assert.match(await page.locator('#li-go').innerText(), /Move 2 ETH into 2 notes/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'withdraw-intake.png'), fullPage: true });
  await page.selectOption('#li-via', 'wallet');
  assert.match(await page.locator('#lg-in').innerText(), /your wallet: it pays the gas and shows as the sender/);
  await page.click('#li-go');
  await page.waitForFunction(() => /are in the large pools \(2 ETH\), made from your private balance/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60000 });
  assert.deepEqual(await page.evaluate(() => window.__intakes), [{ n: 2, amount: String(2n * 10n ** 18n), via: 'self', gas: 2340000, maxFee: null }]);
  const kept = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), `tacit-fixed-notes:1:${ADDR.toLowerCase()}`));
  assert.equal(kept.length, 2); for (const n of kept) assert.equal(n.pool.toLowerCase(), POOL1.toLowerCase());
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('Withdraw: the relay path sends one note a transaction, priced for it', async () => {
  const { ctx, page } = await open({ search: '?fixed=1', payWrap: true, keeper: QUOTE, notes: [10n * ETH] });
  await unlock(page);
  await page.evaluate(() => { window.__fakeIntake = true; });
  await page.click('#tab-withdraw');
  await page.waitForSelector('#li-amt', { state: 'attached', timeout: 30000 });
  await page.click('#lg-in summary');
  await page.fill('#li-amt', '2');
  await page.waitForFunction(() => /Relay fee/.test(document.querySelector('#lg-in')?.textContent || '') && !document.querySelector('#li-go')?.disabled, null, { timeout: 30000 });
  await page.click('#li-go');
  await page.waitForFunction(() => /are in the large pools \(2 ETH\)/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60000 });
  assert.deepEqual(await page.evaluate(() => window.__intakes), [1, 2].map(() => ({ n: 1, amount: String(10n ** 18n), via: 'relay', gas: 1490000, maxFee: '125000000000000' })));
  await ctx.close();
});
await test('Withdraw: a relay that will not quote the gas of a note sends the notes from the wallet instead, and says why', async () => {
  const { ctx, page } = await open({ search: '?fixed=1', payWrap: true, keeper: QUOTE, keeperCap: 1000000, notes: [10n * ETH] });
  await unlock(page);
  await page.click('#tab-withdraw');
  await page.waitForSelector('#li-amt', { state: 'attached', timeout: 30000 });
  await page.click('#lg-in summary');
  await page.fill('#li-amt', '2');
  await page.waitForFunction(() => /The relay cannot send this one \(gas above the 1000000 cap\), so your wallet does/.test(document.querySelector('#lg-in')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(await page.locator('#li-via').inputValue(), 'wallet');
  await ctx.close();
});
await test('Withdraw: with the wallet as the notes\' sender the receipt says so, shows the whole amount, and the choice is kept', async () => {
  const { ctx, page } = await open(WD);
  await toWithdraw(page, '2.3');
  await receiptText(page, /From whole notes/);
  await page.selectOption('#lw-gas', 'wallet');
  const text = await receiptText(page, /one transaction for each note/);
  assert.match(text, /from your wallet, one transaction for each note: it shows as the sender/);
  assert.match(text, /Arrives\s+2\.3 ETH on/); assert.doesNotMatch(text, /at least 2\.24/);
  assert.equal(await page.evaluate(() => localStorage.getItem('tacit-fixed-gas:1')), 'wallet');
  await page.selectOption('#lw-gas', 'note');
  assert.match(await receiptText(page, /paid from the notes, at most 3% of each/), /at least 2\.24 ETH/);
  await ctx.close();
});

// ── amounts with commas: the cards read what the page reads ──
await test('"1,5" is 1.5 ETH in the deposit plan and the way in as it is on the form (it was 15 ETH there), and "1,500", which is no amount on the form, plans nothing', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=1', payWrap: true, keeper: QUOTE, notes: [10n * ETH] });
  await unlock(page);
  await page.fill('#f-damt', '1,5');
  await page.waitForFunction(() => /Deposit 1\.5 ETH: 1 whole note \+ 0\.5/.test(document.querySelector('#f-go')?.textContent || ''), null, { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#lg-split').innerText(), /15 ETH|6 whole/);
  await page.fill('#f-damt', '1,500');
  await page.waitForTimeout(1500);
  assert.equal((await page.locator('#lg-split').innerText()).trim(), '', 'nothing is planned for an amount the form does not take');
  assert.match(await page.locator('#f-go').innerText(), /^Deposit privately$/);
  await page.click('#tab-withdraw');
  await page.waitForSelector('#li-amt', { state: 'attached', timeout: 30000 });
  await page.click('#lg-in summary');
  await page.fill('#li-amt', '1,5');
  await page.waitForFunction(() => /1 × 1 ETH/.test(document.querySelector('#lg-in')?.textContent || ''), null, { timeout: 30000 });
  const t = await page.locator('#lg-in').innerText();
  assert.match(t, /0\.5 ETH\s+stays in your private balance/); assert.doesNotMatch(t, /15 ETH|5 × 1 ETH/);
  await page.fill('#li-amt', '1,500');
  await page.waitForFunction(() => !/whole notes, large pool/.test(document.querySelector('#lg-in')?.textContent || ''), null, { timeout: 30000 });
  assert.deepEqual(problems, []);
  await ctx.close();
});

// ── on by default ──
await test('the cards are on with no flag in the address and nothing stored, the explainer is in the notes card and opens, and ?fixed=0 turns them off for good', async () => {
  const { ctx, page, problems } = await open();   // no ?fixed, nothing in the browser
  await unlock(page);
  await page.waitForSelector('#lg-notes', { state: 'attached', timeout: 30000 });
  await page.waitForFunction(() => /Notes in the large pools/.test(document.querySelector('#lg-notes')?.textContent || ''), null, { timeout: 30000 });
  assert.match(await page.locator('#lg-notes summary').innerText(), /How it works/);
  await page.click('#lg-notes summary');
  const how = await page.locator('#lg-notes details').innerText();
  assert.match(how, /Tornado Cash/); assert.match(how, /1, 10 or 100 ETH/); assert.match(how, /Find/); assert.match(how, /blends in/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'explainer.png'), fullPage: true });
  await page.fill('#f-damt', '2.5');
  await page.waitForFunction(() => /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/.test(document.querySelector('#f-go')?.textContent || ''), null, { timeout: 30000 });
  assert.deepEqual(problems, []);
  // ?fixed=0 turns them off, and they stay off without the flag in the address
  await page.goto(base + '/pay/eth/?fixed=0');
  await unlock(page);
  assert.equal(await page.locator('#lg-notes').count(), 0);
  await page.goto(base + '/pay/eth/');
  await unlock(page);
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#lg-notes').count(), 0, 'still off: the choice is kept');
  // ?fixed=1 turns them on again
  await page.goto(base + '/pay/eth/?fixed=1');
  await unlock(page);
  await page.waitForSelector('#lg-notes', { state: 'attached', timeout: 30000 });
  await ctx.close();
});
console.log('Relay registry');
await test('the page reads the relay registry for the chain in use and lists what it finds next to its own relay; a relay is reached through the private route, never directly, so the policy does not open to its host', async () => {
  const R2 = '0x' + 'b2'.repeat(20), own = 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper';
  const { ctx, page, problems } = await open({ registry: [
    { relayer: R2, stake: 1000n * 10n ** 18n, url: 'https://relay2.example/1/evm-pool/keeper' },
    { relayer: '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0', stake: 1000n * 10n ** 18n, url: own },
  ] });
  const reads = [];
  page.on('request', (r) => { if (r.method() === 'POST' && (r.postData() || '').includes('0xd4d25113')) reads.push(r.postDataJSON()); });
  await unlock(page);
  const calls = () => reads.flat().map((b) => b?.params?.[0]).filter((c) => c && String(c.data).startsWith('0xd4d25113'));
  const LIST_1 = '0xd4d25113' + '1'.padStart(64, '0') + '0'.repeat(64) + (100).toString(16).padStart(64, '0');
  for (let i = 0; i < 60 && !calls().some((c) => c.data === LIST_1); i++) await page.waitForTimeout(500);
  assert.ok(calls().some((c) => c.data === LIST_1), 'the page asked the registry for Ethereum\'s relays: list(1, 0, 100)');
  assert.ok(calls().every((c) => c.to.toLowerCase() === REGISTRY), 'always the registry on Ethereum, whichever chain\'s relays it asks for');
  // a relay is reached through the private route's forwarders (already in the policy), so the page may not call its host itself
  const status = await page.evaluate(async () => { try { return (await fetch('https://relay2.example/1/evm-pool/keeper/quote')).status; } catch (e) { return 'blocked: ' + e.message; } });
  assert.match(String(status), /^blocked/, 'a direct request to a relay\'s host is refused by the policy: ' + status);
  await ctx.close();
});
await test('a registry that cannot be read leaves the page working with its own relay', async () => {
  const { ctx, page, problems } = await open({ registry: [] });
  await unlock(page);
  await page.fill('#f-damt', '0.5');
  await page.waitForFunction(() => /Deposit/.test(document.querySelector('#f-go')?.textContent || ''), null, { timeout: 30000 });
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a native ETH withdrawal keeps the community relay option when the built-in keeper cannot quote', async () => {
  const R2 = '0x' + 'b2'.repeat(20), host = 'https://tacit-evm-pool-keepers.onrender.com', communityHost = 'https://tacit-evm-pool-forwarder.onrender.com';
  const own = `${host}/1/evm-pool/keeper`, community = `${communityHost}/1/evm-pool/keeper`;
  const { ctx, page, problems, keeperCalls } = await open({
    notes: [10n * ETH], registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: community }],
    quotes: (url) => {
      if (url === `${own}/quote`) return { status: 503, body: { error: 'the built-in keeper is down' } };
      if (url === `${community}/quote`) return { ...QUOTE, relayer: R2 };
      return null;
    },
  });
  await unlock(page);
  await page.click('#tab-withdraw');
  await page.fill('#f-wto', DEAD);
  await page.fill('#f-wamt', '0.1');
  await page.waitForFunction(() => !document.querySelector('#f-go')?.disabled && /Sent by the relay/.test(document.querySelector('#form')?.textContent || ''), null, { timeout: 30000 });
  assert.ok(keeperCalls.some((c) => c.url === `${community}/quote`), 'the registered community relay supplied the spend quote');
  await syncAgain(page, keeperCalls, own); await syncAgain(page, keeperCalls, own);
  assert.equal(quotesAt(keeperCalls, community), 1, 'the form asked the listed relay once, and the syncs after it did not');
  assert.match(await page.locator('#form').innerText(), /Sent by the relay/, 'its quote stands while the built-in keeper cannot quote');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('an open deposit view keeps the built-in receive minimum and reacts when only its service quote fails', async () => {
  const R2 = '0x' + 'b2'.repeat(20), host = 'https://tacit-evm-pool-keepers.onrender.com', communityHost = 'https://tacit-evm-pool-forwarder.onrender.com';
  const own = `${host}/1/evm-pool/keeper`, community = `${communityHost}/1/evm-pool/keeper`;
  let ownDown = false;
  const { ctx, page, problems, waiting } = await open({
    notes: [10n * ETH], registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: community }],
    quotes: (url) => {
      if (url === `${own}/quote`) return ownDown ? { status: 503, body: { error: 'the built-in receive service is down' } } : { ...QUOTE, receiveMin: '2000000000000000000' };
      if (url === `${community}/quote`) return { ...QUOTE, relayer: R2, receiveMin: '1000000000000000000' };
      return null;
    },
  });
  await unlock(page);
  await page.click('#dep-addr');
  await page.waitForFunction(() => /takes it in from 2(?:\.0+)? ETH/.test(document.querySelector('#form')?.textContent || ''), null, { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#form').innerText(), /takes it in from 1(?:\.0+)? ETH/, 'a community spend quote cannot replace the built-in receive minimum');
  const address = await page.locator('#form .addr code').first().innerText();
  waiting.set(address.toLowerCase(), '0x' + (5n * 10n ** 17n).toString(16));
  await page.click('#f-check');
  await page.waitForFunction(() => /below the relay’s minimum/.test(document.querySelector('#form')?.textContent || '') && document.querySelector('[data-sweep]'), null, { timeout: 30000 });
  ownDown = true;
  await page.click('#f-check');
  await page.waitForFunction(() => /The relay can’t take this one right now/.test(document.querySelector('#form')?.textContent || '') && document.querySelector('[data-sweep]'), null, { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#form').innerText(), /The relay will collect it/);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a token withdrawal uses the registry relay projected to its pool when the built-in token keeper cannot quote', async () => {
  const R2 = '0x' + 'b2'.repeat(20), host = 'https://tacit-evm-pool-keepers.onrender.com', communityHost = 'https://tacit-evm-pool-forwarder.onrender.com';
  const own = `${host}/1-xa0b86991c6/evm-pool/keeper`, community = `${communityHost}/1-xa0b86991c6/evm-pool/keeper`;
  const native = `${host}/1/evm-pool/keeper`, nativeCommunity = `${communityHost}/1/evm-pool/keeper`;
  const usdc = { chainId: 1, pool: '0x6C0be904750Fe1b50cd7207cc94731642d99e908', relayer: R2, fee: '1000' };
  const { ctx, page, problems, keeperCalls } = await open({
    search: '?chains=all', notes: [10_000_000n],
    registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: nativeCommunity }],
    quotes: (url) => {
      if (url === `${own}/quote`) return { status: 503, body: { error: 'the built-in token keeper is down' } };
      if (url === `${community}/quote`) return usdc;
      if (url === `${native}/quote`) return QUOTE;
      if (url === `${nativeCommunity}/quote`) return { ...QUOTE, relayer: R2, fee: '100000000000000' };
      return null;
    },
  });
  await unlock(page);
  await page.click('[data-tok="usdc"]');
  await page.click('#tab-withdraw');
  await page.fill('#f-to', DEAD);
  await page.fill('#f-amt', '1');
  await page.waitForFunction(() => !document.querySelector('#f-go')?.disabled && /Relay fee/.test(document.querySelector('#f-rcpt')?.textContent || ''), null, { timeout: 30000 });
  assert.ok(keeperCalls.some((c) => c.url === `${community}/quote`), 'the registry entry was projected from the native route to the USDC pool');
  assert.ok(keeperCalls.some((c) => c.url === `${own}/quote`), 'the built-in token keeper was asked too');
  assert.match(await page.locator('#f-rcpt').innerText(), /at most .* USDC/);
  await syncAgain(page, keeperCalls, own); await syncAgain(page, keeperCalls, own);
  assert.equal(quotesAt(keeperCalls, community), 1, 'the form asked the projected relay once, and the syncs after it did not');
  assert.match(await page.locator('#f-rcpt').innerText(), /at most .* USDC/, 'its quote stands while the built-in keeper cannot quote');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a sync asks the built-in relay alone, once: a listed relay hears from the page when a withdrawal is sent, not on the page\'s timer', async () => {
  const R2 = '0x' + 'b2'.repeat(20), own = 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', community = 'https://tacit-evm-pool-forwarder.onrender.com/1/evm-pool/keeper';
  const { ctx, page, problems, keeperCalls } = await open({
    notes: [10n * ETH], registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: community }],
    quotes: (url) => (url === `${own}/quote` ? QUOTE : url === `${community}/quote` ? { ...QUOTE, relayer: R2 } : null),
  });
  await unlock(page);
  await page.click('#tab-withdraw');
  await page.fill('#f-wto', DEAD);
  await page.fill('#f-wamt', '0.1');
  await page.waitForFunction(() => !document.querySelector('#f-go')?.disabled && /Relay fee/.test(document.querySelector('#f-rcpt')?.textContent || ''), null, { timeout: 30000 });
  // a sync on the page's own timer can fall in one of these two, not in both
  const asked = [await syncAgain(page, keeperCalls, own), await syncAgain(page, keeperCalls, own)];
  assert.ok(asked.includes(1), `one quote from the built-in relay for a sync, not two (${asked})`);
  assert.equal(quotesAt(keeperCalls, community), 0, 'no sync and no form asked the listed relay while the built-in relay quotes');
  await page.click('#f-go');
  // the spend asks every relay for its quote first; it then stops, since the notes here are stand-ins the pool does not hold
  await page.waitForFunction(() => /does not cover this amount/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60000 });
  assert.equal(quotesAt(keeperCalls, community), 1, 'the withdrawal asked the listed relay as it was priced');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a token pool\'s sync asks its built-in relay alone: the projected relay is asked when its withdrawal is sent', async () => {
  const R2 = '0x' + 'b2'.repeat(20), host = 'https://tacit-evm-pool-keepers.onrender.com', communityHost = 'https://tacit-evm-pool-forwarder.onrender.com';
  const own = `${host}/1-xa0b86991c6/evm-pool/keeper`, community = `${communityHost}/1-xa0b86991c6/evm-pool/keeper`;
  const usdc = { chainId: 1, pool: '0x6C0be904750Fe1b50cd7207cc94731642d99e908', relayer: '0x' + '11'.repeat(20), fee: '2000' };
  const { ctx, page, problems, keeperCalls } = await open({
    search: '?chains=all', notes: [10_000_000n],
    registry: [{ relayer: R2, stake: 1000n * 10n ** 18n, url: `${communityHost}/1/evm-pool/keeper` }],
    quotes: (url) => {
      if (url === `${own}/quote`) return usdc;
      if (url === `${community}/quote`) return { ...usdc, relayer: R2, fee: '1000' };
      if (url.endsWith('/1/evm-pool/keeper/quote')) return { ...QUOTE, ...(url.startsWith(communityHost) ? { relayer: R2 } : {}) };
      return null;
    },
  });
  await unlock(page);
  await page.click('[data-tok="usdc"]');
  await page.click('#tab-withdraw');
  await page.fill('#f-to', DEAD);
  await page.fill('#f-amt', '1');
  await page.waitForFunction(() => !document.querySelector('#f-go')?.disabled && /Relay fee/.test(document.querySelector('#f-rcpt')?.textContent || ''), null, { timeout: 30000 });
  await syncAgain(page, keeperCalls, own); await syncAgain(page, keeperCalls, own);
  assert.equal(quotesAt(keeperCalls, community), 0, 'no sync asked the projected relay, so its timing does not say which pool is open');
  await page.click('#f-go');
  await page.waitForFunction(() => /does not cover this amount/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60000 });
  assert.equal(quotesAt(keeperCalls, community), 1, 'the withdrawal asked the projected relay as it was priced');
  assert.deepEqual(problems, []);
  await ctx.close();
});

// ── the private route, on: the keepers service's gateway and a listed relay's are real sealed gateways (worker-relay/src/lib/evm-pool-keeper-sealed.js) on this
// machine, and only the forwarders are stood in for: each envelope they get is handed to the gateway it is for, as a forwarder does ──
const jsonTo = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
// an account as a relay's key signs with it: its address, and a raw hash signed r ‖ s ‖ v
const accountOf = (priv) => {
  const k = hexToBytes(priv.replace(/^0x/, ''));
  return { address: '0x' + bytesToHex(keccak_256(secp.getPublicKey(k, false).slice(1)).slice(12)),
    sign: async ({ hash }) => { const g = await secp.signAsync(hexToBytes(hash.replace(/^0x/, '')), k); return bytesToHex(g.toCompactRawBytes()) + (g.recovery + 27).toString(16); } };
};
async function sealedRoute({ ownServe, relayServe, relay }) {
  const own = newGatewayKey(), carried = [];
  const listen = async (take) => {
    const srv = createServer((req, res) => { if (!take(req, res)) jsonTo(res, 404, { error: 'not found' }); });     // only what comes sealed, or the key document
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return srv;
  };
  const a = await listen(makeServiceGateway({ secret: own, serve: ownServe, json: jsonTo, ratePerMin: 100_000 }));
  const b = await listen(makeServiceGateway({ secret: newGatewayKey(), serve: relayServe, json: jsonTo, accounts: [relay], ratePerMin: 100_000 }));
  const at = (srv, path) => `http://127.0.0.1:${srv.address().port}${path}`;
  const pass = async (url, req) => {
    const post = req.method() === 'POST', r = await fetch(url, { method: req.method(), headers: post ? { 'content-type': 'application/octet-stream' } : {}, body: post ? req.postDataBuffer() : undefined });
    return { status: r.status, type: r.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await r.arrayBuffer()) };
  };
  return {
    gateway: bytesToHex(gatewayKeys(own).pub), carried,
    // a forwarder's routes: /f/k for the keepers service, /r/<chain>/<relayer> and its /key for a relay the registry lists (the wallet-read and API gateways are not here)
    async carry(req) {
      const u = new URL(req.url());
      if (!/^https:\/\/tacit-evm-pool-forwarder(?:-2)?\.onrender\.com$/.test(u.origin)) return null;
      carried.push(`${req.method()} ${u.pathname}`);
      if (u.pathname === '/f/k' && req.method() === 'POST') return pass(at(a, '/sealed'), req);
      const m = /^\/r\/1\/(0x[0-9a-fA-F]{40})(\/key)?$/.exec(u.pathname);
      if (m && lcs(m[1]) === lcs(relay.address)) return pass(at(b, m[2] ? '/sealed/key' : '/sealed'), req);
      return { status: 502, type: 'application/json', body: Buffer.from('{"error":"not carried here"}') };
    },
    close: () => { a.close(); b.close(); },
  };
}
// a token pool's logs as fakePool in tests/evm-pool-wallet-rpc.test.mjs keeps them: a Transact a block, its leaves in a tree whose root at each size the pool answers
function tokenChain(pool) {
  const tree = zk.incTree(), sizeOf = new Map([[tree.root, 0]]), logs = [], receipts = new Map();
  return { pool, logs, sizeOf, receipts, tip: 0x1c9c380,
    transact({ block, nf = [0n, 0n], out = null, memo = [null, null], tx = '0x' + w64(block) }) {
      const firstIndex = tree.size, [o0, o1] = out ?? [0n, 0n];
      if (out) { tree.append(out.map(BigInt)); sizeOf.set(tree.root, tree.size); }
      const m = memo.map((x) => Buffer.from(x ?? []).toString('hex')), pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64), body0 = w64(m[0].length / 2) + pad(m[0]);
      const l = { address: pool, blockNumber: '0x' + block.toString(16), transactionHash: tx, logIndex: '0x0', topics: [T_TRANSACT, '0x' + w64(nf[0]), '0x' + w64(nf[1])],
        data: '0x' + [o0, o1, firstIndex, 0, 0, 0, 0, 0, 320, 320 + body0.length / 2].map(w64).join('') + body0 + w64(m[1].length / 2) + pad(m[1]) };
      logs.push(l);
      return l;
    } };
}
console.log('The private route');
await test('a token withdrawal is quoted and sent through the registry relay projected to its pool, sealed to that relay\'s key through the forwarders', async () => {
  const usdc = { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', pool: '0x6C0be904750Fe1b50cd7207cc94731642d99e908' }, id = '1-xa0b86991c6';
  const PRIV = '5a'.repeat(32), keys = evmPoolKeys(zk, hexToBytes(PRIV)), asset = poolAsset({ chainId: 1n, pool: usdc.pool, token: usdc.token });
  // the key's one note in the USDC pool, 10 USDC
  const chainOf = TOKEN_CHAIN = tokenChain(usdc.pool), note = sealNote(zk, { to: { V: keys.V, A: keys.A, N: keys.N }, value: 10_000_000n, asset });
  chainOf.transact({ block: 29_000_000, out: [note.leaf, 21n], memo: [note.memo, null] });
  const nf = zk.nullifier(openNote(zk, keys, { memo: note.memo, leaf: note.leaf, asset }).nk, note.leaf, 0);
  const relay = accountOf('3a'.repeat(32)), H = '0x' + 'cd'.repeat(32), seen = { own: [], relay: [] }, relayed = [];
  const sr = await sealedRoute({
    relay,
    ownServe: (req, res) => {
      const path = req.url.split('?')[0];
      seen.own.push(`${req.method} ${path}`);
      if (path === `/${id}/evm-pool/keeper/quote`) return jsonTo(res, 200, { chainId: 1, pool: usdc.pool, relayer: '0x' + '11'.repeat(20), fee: '5000' });
      if (path === '/1/evm-pool/keeper/quote') return jsonTo(res, 200, QUOTE);
      if (path.endsWith('/receive')) return jsonTo(res, 200, { ok: true });
      if (path.endsWith('/rpc')) return jsonTo(res, 503, { error: 'no node behind this stand-in' });
      return jsonTo(res, 404, { error: 'not found' });
    },
    relayServe: async (req, res) => {
      const path = req.url.split('?')[0];
      seen.relay.push(`${req.method} ${path}`);
      if (path === `/${id}/evm-pool/keeper/quote`) return jsonTo(res, 200, { chainId: 1, pool: usdc.pool, relayer: relay.address, fee: '1000' });
      if (path === `/${id}/evm-pool/keeper/relay` && req.method === 'POST') {
        const parts = [];
        for await (const c of req) parts.push(c);
        relayed.push(JSON.parse(Buffer.concat(parts).toString()));
        // it lands: the spend of the note, in a block the wallet reads next, and its receipt
        chainOf.tip += 10;
        const l = chainOf.transact({ block: chainOf.tip - 5, nf: [nf, 0n], tx: H });
        chainOf.receipts.set(H, { status: '0x1', transactionHash: H, blockNumber: l.blockNumber, logs: [l] });
        return jsonTo(res, 200, { txHash: H });
      }
      return jsonTo(res, 404, { error: 'not found' });
    },
  });
  const { ctx, page, problems, keeperCalls } = await open({
    search: '?chains=all', tabKey: PRIV, stubProve: true, route: sr,
    registry: [{ relayer: relay.address, stake: 1000n * 10n ** 18n, url: 'https://relay.example/1/evm-pool/keeper' }],
  });
  try {
    await unlock(page);
    await page.click('[data-tok="usdc"]');
    await page.click('#tab-withdraw');
    await page.fill('#f-to', DEAD);
    await page.fill('#f-amt', '1');
    await page.waitForFunction(() => !document.querySelector('#f-go')?.disabled && /Relay fee/.test(document.querySelector('#f-rcpt')?.textContent || ''), null, { timeout: 60000 });
    assert.ok(seen.own.includes(`GET /${id}/evm-pool/keeper/quote`), 'the built-in token keeper priced the form, through its gateway');
    assert.ok(!seen.relay.some((x) => x.endsWith('/quote')), 'the listed relay was not asked before the spend');
    await page.click('#f-go');
    await page.waitForFunction(() => /Withdrew 1 USDC/.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, { timeout: 120000 });
    assert.match(await page.locator('#status').innerText(), /Withdrew 1 USDC/);
    assert.ok(sr.carried.some((x) => new RegExp(`^GET /r/1/${relay.address}/key$`, 'i').test(x)), 'a forwarder fetched the relay\'s key document, which the wallet checked against the registry\'s address');
    assert.ok(sr.carried.some((x) => new RegExp(`^POST /r/1/${relay.address}$`, 'i').test(x)), 'and carried envelopes sealed to that key');
    assert.ok(seen.relay.includes(`GET /${id}/evm-pool/keeper/quote`), 'the native registry entry was projected to the USDC pool and quoted through the relay\'s gateway');
    assert.equal(relayed.length, 1, 'the spend went to it, cheaper than the built-in keeper');
    const tx = relayed[0].tx;
    assert.equal(lcs(tx.relayer), lcs(relay.address), 'the proof pays the address the registry lists');
    assert.equal(String(tx.fee), '1000');
    assert.equal(lcs(tx.recipient), lcs(DEAD));
    assert.equal(String(tx.extAmount), String(-1_000_000n));
    assert.equal(await page.evaluate(() => globalThis.__proved), 1);
    assert.deepEqual(keeperCalls, [], 'no relay was asked in the open');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); sr.close(); TOKEN_CHAIN = null; }
});
await test('ETH only: a saved Base choice is ignored, no chain strip and no token row are drawn, and ?chains=all brings them back', async () => {
  const one = await open({ search: '', chain: 8453, min: null });
  await unlock(one.page);
  await one.page.waitForSelector('#f-damt');
  assert.equal(await one.page.locator('#chains').isVisible(), false, 'no chain strip');
  assert.equal(await one.page.locator('#assets').isVisible(), false, 'no token row');
  assert.match(await one.page.locator('#chain-1').getAttribute('aria-selected').catch(() => 'true'), /true/, 'on Ethereum');
  assert.equal(await one.page.locator('#chain-8453').count(), 0, 'Base is not built');
  await one.ctx.close();
  const all = await open({ search: '?chains=all', chain: 1, min: null });
  await unlock(all.page);
  await all.page.waitForSelector('#f-damt');
  assert.equal(await all.page.locator('#chain-8453').count(), 1, 'Base is back with ?chains=all');
  await all.ctx.close();
});

await test('the Tornado Cash mark and the Kohaku mark and link show in the notes block with no notes and no amount typed', async () => {
  const { ctx, page } = await open({ search: '', min: null });
  await unlock(page);
  await page.waitForSelector('#lg-notes', { state: 'attached' });
  const block = page.locator('#lg-notes');
  assert.match(await block.innerText(), /Tornado Cash notes\. Kohaku can withdraw them too\./);
  assert.equal(await block.locator('p', { hasText: 'can withdraw them too' }).locator('svg').count(), 2, 'two marks in the line');
  assert.equal(await block.locator('a[href="https://ethereum.org/apps/kohaku/"][target="_blank"]').count(), 1, 'the Kohaku link');
  assert.equal(await block.locator('a[href*="tornado"]').count(), 0, 'no link on the Tornado mark');
  await ctx.close();
});

await test('Withdraw: an address still being typed says what an address is, and it is no error', async () => {
  const { ctx, page } = await open({ search: '', min: null });
  await unlock(page);
  await page.click('#tab-withdraw');
  await page.fill('#f-wto', '0x123'); await page.fill('#f-wamt', '0.1');
  await page.waitForFunction(() => /An address is 0x and 40 more characters\./.test(document.querySelector('#form')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(await page.locator('#form p.note.err').count(), 0, 'not an error');
  await ctx.close();
});

await test('the smallest note starts at 0.1 ETH, so 0.15 ETH is a 0.1 ETH note and 0.05 ETH for Tacit, and the explainer names every pool size', async () => {
  const { ctx, page } = await open({ search: '', min: null });
  await unlock(page);
  await page.waitForSelector('#lg-split', { state: 'attached' });
  await page.fill('#f-damt', '0.15');
  await page.waitForFunction(() => /1 × 0\.1 ETH/.test(document.querySelector('#lg-split')?.textContent || ''), null, { timeout: 30000 });
  const text = await page.locator('#lg-split').innerText();
  assert.match(text, /1 × 0\.1 ETH\s+whole note · Tornado Cash/); assert.match(text, /0\.05 ETH\s+your private balance/);
  assert.equal(await page.locator('#lg-min').inputValue(), String(10n ** 17n));
  assert.match(await page.evaluate(() => document.body.textContent), /0\.1, 1, 10 or 100 ETH/);
  await ctx.close();
});

await test('when network fees would be over 2% of a 0.1 ETH note, the default moves up to 1 ETH, and a person\'s own choice wins', async () => {
  const { ctx, page } = await open({ search: '', min: null, gasPrice: '0x' + (20n * 10n ** 9n).toString(16) });
  await unlock(page);
  await page.waitForSelector('#lg-split', { state: 'attached' });
  await page.fill('#f-damt', '1.3');
  await page.waitForFunction(() => document.querySelector('#lg-min')?.value === '1000000000000000000' && /1 × 1 ETH/.test(document.querySelector('#lg-split')?.textContent || ''), null, { timeout: 30000 });
  await page.selectOption('#lg-min', { label: '0.1 ETH' });
  await page.waitForFunction(() => document.querySelector('#lg-min').value === '100000000000000000');
  assert.equal(await page.evaluate(() => localStorage.getItem('tacit-fixed-min:1')), String(10n ** 17n));
  await ctx.close();
});

await test('Pay with a token: the picker lists the tokens, the receipt says what it pays and through what, and the press deposits through the zap', async () => {
  const { ctx, page, problems, sent } = await open({ search: '?fixed=0', payWith: true });
  await unlock(page);
  await page.waitForFunction(() => [...(document.querySelector('#f-pay')?.options || [])].some((o) => o.textContent === 'USDC'), null, { timeout: 30000 });
  assert.deepEqual(await page.$$eval('#f-pay option', (os) => os.map((o) => o.textContent)), ['ETH', 'WBTC', 'USDC', 'DAI']);
  await page.selectOption('#f-pay', { label: 'USDC' });
  await page.fill('#f-damt', '0.05');
  await page.waitForFunction(() => /Pays\s+about 150 USDC/.test(document.querySelector('#f-rcpt')?.innerText || ''), null, { timeout: 30000 });
  const rc = await page.locator('#f-rcpt').innerText();
  assert.match(rc, /Swapped through\s+Uniswap v3 0\.05%/);
  assert.match(rc, /Into your private balance\s+0\.05 ETH/);
  assert.match(await page.locator('#f-go').innerText(), /^Pay with USDC, deposit privately$/);
  assert.equal(await page.locator('#f-max').isHidden(), true, 'Max is for ETH');
  assert.equal(await page.evaluate(() => localStorage.length >= 0 && document.querySelector('#f-pay').value), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  if (SHOTS) await page.locator('.card, main').first().screenshot({ path: join(SHOTS, 'paywith.png') });
  await page.click('#f-go');
  await page.waitForFunction(() => (globalThis.__deposits || []).length === 1, null, { timeout: 60000 });
  const [d] = await page.evaluate(() => globalThis.__deposits);
  assert.equal(d.kind, 'deposit'); assert.equal(d.amount, String(5n * 10n ** 16n));
  assert.equal(d.call.to.toLowerCase(), '0x0000008ebbf2323f95c4fbc18254f3d65c53998c', 'the zap takes the call');
  assert.equal(d.call.value, '0', 'it is sent no ETH');
  assert.deepEqual(await page.evaluate(() => globalThis.__pulled), { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: '150000000' }, 'the zap is let take exactly the sale\'s amount');
  assert.equal(sent.length, 0, 'nothing else from the wallet');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('Pay with a token: a price that moved more than 1% since it was shown sends nothing', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=0', payWith: true });
  await page.addInitScript(() => { globalThis.__priceMove = 5_000000; });
  await page.reload();
  await unlock(page);
  await page.waitForFunction(() => [...(document.querySelector('#f-pay')?.options || [])].some((o) => o.textContent === 'USDC'), null, { timeout: 30000 });
  await page.selectOption('#f-pay', { label: 'USDC' });
  await page.fill('#f-damt', '0.05');
  await page.waitForFunction(() => /about 150 USDC/.test(document.querySelector('#f-rcpt')?.innerText || ''), null, { timeout: 30000 });
  await page.click('#f-go');
  await page.waitForFunction(() => /The price moved/.test(document.body.innerText), null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => (globalThis.__deposits || []).length), 0);
  assert.equal(await page.evaluate(() => globalThis.__pulled ?? null), null, 'nothing was asked of the wallet');
  assert.deepEqual(problems, []);
  await ctx.close();
});

await test('Receive as a token: Withdraw sells the ETH for the token in the same transaction, paid to the address, with the relay\'s fee for the larger call', async () => {
  const { ctx, page, problems, sent } = await open({ search: '?fixed=0', payWith: true, notes: [10n ** 18n], keeper: QUOTE });
  await unlock(page);
  await page.click('#tab-withdraw');
  await page.waitForFunction(() => [...(document.querySelector('#f-wout')?.options || [])].some((o) => o.textContent === 'DAI'), null, { timeout: 30000 });
  await page.selectOption('#f-wout', { label: 'DAI' });
  const DEST = '0x' + '5a'.repeat(20);
  await page.fill('#f-wto', DEST);
  await page.fill('#f-wamt', '0.1');
  await page.waitForFunction(() => /Arrives\s+at least 298\.5 DAI/.test(document.querySelector('#f-rcpt')?.innerText || ''), null, { timeout: 30000 });
  const rc = await page.locator('#f-rcpt').innerText();
  assert.match(rc, /Swapped through\s+Uniswap v4 0\.05%/);
  assert.match(rc, /From your private balance\s+0\.1 ETH/);
  assert.match(rc, /Relay fee/);
  assert.match(await page.locator('#f-go').innerText(), /^Withdraw as DAI$/);
  assert.ok((await page.evaluate(() => globalThis.__feeGas)).every((g) => g === 900000), 'the fee is asked for the call\'s gas');
  if (SHOTS) await page.locator('.card, main').first().screenshot({ path: join(SHOTS, 'recvas.png') });
  await page.click('#f-go');
  await page.waitForFunction(() => (globalThis.__calls || []).length === 1, null, { timeout: 60000 });
  const [c] = await page.evaluate(() => globalThis.__calls);
  assert.equal(c.amount, String(10n ** 17n));
  assert.equal(c.via, 'relay'); assert.equal(c.gas, 900000);
  assert.equal(c.maxFee, String((5n * 10n ** 14n * 5n) / 4n), 'held to the fee shown and a quarter over');
  assert.deepEqual(c.calls, [{ target: '0x000000000000FB114709235f1ccBFfb925F600e4', value: String(10n ** 17n), data: '0xbeef' }]);
  assert.equal(c.refund, '0x' + 'ee'.repeat(20), 'a failed sale comes back to a receive box of the person\'s own');
  assert.equal(sent.length, 0);
  assert.deepEqual(problems, []);
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
