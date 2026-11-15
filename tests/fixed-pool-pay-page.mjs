// The real Pay page (dapp/pay/eth/) with the large-pool cards: off unless the page was opened with ?fixed=1 (the form is
// then exactly what it was), and on Ethereum with the flag the cards load under the page's own content-security policy
// and the split shows for an amount. Every request that leaves the machine is answered by a stand-in.
//   PLAYWRIGHT=<path to playwright-core> node tests/fixed-pool-pay-page.mjs        (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { keccak_256, secp, hexToBytes, bytesToHex, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

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
    case 'eth_getBlockByNumber': return { number: '0x1c9c380', timestamp: '0x6a000000', baseFeePerGas: '0x5f5e100', transactions: [] };
    default: return '0x';
  }
};
async function open({ search = '', flagged = null, chain = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 560, height: 1100 } });
  const page = await ctx.newPage();
  const problems = [];
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
    if (req.method() === 'POST') {
      let body = null; try { body = req.postDataJSON(); } catch { /* not JSON */ }
      const one = (b) => ({ jsonrpc: '2.0', id: b?.id ?? 1, result: rpcAnswer(b?.method) });
      if (body) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    }
    return route.fulfill({ status: 404, headers, body: '{}' });
  });
  await page.goto(base + '/pay/eth/' + search);
  return { ctx, page, problems };
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

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
