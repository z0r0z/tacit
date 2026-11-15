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
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { evmPoolKeys } = await import('../dapp/evm-pool-wallet.js');
const { signBox } = await import('../dapp/fixed-pool-box.js');
const { receiveBoxAddress, RECEIVE_FEE_BPS, EVM_POOL_ROUTER } = await import('../dapp/evm-pool-gateway.js');

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
  const gate = page.locator('button', { hasText: 'Ethereum wallet' }).first(), form = page.locator('#f-damt');
  // a page that was opened before keeps the Tacit wallet open, and shows the form at once
  await Promise.race([gate.waitFor({ state: 'visible', timeout: 60000 }), form.waitFor({ state: 'attached', timeout: 60000 })]);
  if (!(await form.count())) await gate.click();
  await form.waitFor({ state: 'attached', timeout: 60000 });
}

// what the page asks of nodes and services, answered with the least that keeps it going
const rpcAnswer = (method) => {
  switch (method) {
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return '0x1c9c380';
    case 'eth_getBalance': case 'eth_gasPrice': return '0x0';
    case 'eth_getLogs': return [];
    case 'eth_getCode': return '0x';
    case 'eth_getTransactionReceipt': return { status: '0x1', blockNumber: '0x1c9c380', logs: [] };
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
async function open({ search = '', flagged = null, chain = 1, names = null, keeper = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 560, height: 1100 } });
  const page = await ctx.newPage();
  const problems = [], sent = [], told = [];
  await page.exposeFunction('__send', async (tx) => { sent.push(tx); return '0x' + 'ab'.repeat(32); });
  if (names) {
    await page.addInitScript((n) => { window.__names = n; }, names);
    await page.route(/\/confidential-names\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: NAMES_STUB }));
  }
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp ' + m.text()); });
  await page.exposeFunction('__sign', async (msgHex) => {
    const msg = hexToBytes(msgHex.replace(/^0x/, ''));
    const sig = await secp.signAsync(keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg)), KEY);
    return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16);
  });
  await page.addInitScript(WALLET_SCRIPT, ADDR);
  await page.addInitScript(([c, f]) => { try { localStorage.setItem('tacit-pay-chain-v1', JSON.stringify(c)); if (f != null) localStorage.setItem('tacit-fixed-pools', f); } catch {} }, [chain, flagged]);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (keeper && /\/evm-pool\/keeper\/quote/.test(req.url())) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(keeper) });
    if (keeper && req.method() === 'POST' && /\/evm-pool\/keeper\/receive/.test(req.url())) { told.push(req.postDataJSON()); return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '{"ok":true}' }); }
    if (req.method() === 'POST') {
      let body = null; try { body = req.postDataJSON(); } catch { /* not JSON */ }
      const one = (b) => ({ jsonrpc: '2.0', id: b?.id ?? 1, result: rpcAnswer(b?.method) });
      if (body) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    }
    return route.fulfill({ status: 404, headers, body: '{}' });
  });
  await page.goto(base + '/pay/eth/' + search);
  return { ctx, page, problems, sent, told };
}

console.log('Pay page');
await test('without the flag the deposit form has no large-pool cards and the module is never asked for', async () => {
  const { ctx, page, problems } = await open();
  const asked = [];
  page.on('request', (r) => { if (/fixed-pool-pay/.test(r.url())) asked.push(r.url()); });
  await unlock(page);
  await page.fill('#f-damt', '2.5');
  assert.equal(await page.locator('#lg-split').count(), 0);
  assert.equal(await page.locator('#lg-notes').count(), 0);
  await page.click('#dep-addr'); // From an exchange
  await page.waitForSelector('#f-check', { timeout: 30000 });
  assert.equal(await page.locator('#lg-name').count(), 0, 'no deposit-address row without the flag');
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
  assert.match(text, /0\.5 ETH\s+stays for the deposit above/);
  assert.match(await page.locator('#lg-notes').innerText(), /Notes in the large pools/);
  assert.match(await page.locator('#lg-go').innerText(), /Deposit 2 whole notes/, 'the wallet that opened the page is the one that deposits');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'paypage-cards.png'), fullPage: true });
  await page.fill('#f-damt', '0.9');
  await page.waitForFunction(() => !document.querySelector('#lg-go'));
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
await test('with the flag on another chain (Base) the deposit form is untouched', async () => {
  const { ctx, page, problems } = await open({ search: '?fixed=1', chain: 8453 });
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
await test('without the flag the Send form never looks for a deposit address', async () => {
  const names = { 'ross.wei': { ...ENTRY, box: await rec(payee.v, N1) } };
  const { ctx, page, sent } = await open({ names, keeper: QUOTE });
  await toSend(page, 'ross.wei', '0.5');
  assert.match(await receiptText(page, /More than your private balance covers/), /^((?!from my wallet)[\s\S])*$/);
  assert.equal(await page.locator('#f-go').isDisabled(), true);
  assert.equal(sent.length, 0);
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
