// The split page (dapp/split/) in a real browser, with a stand-in wallet: off unless the link turns it on, the plan
// for an amount, a deposit that asks for every signature and then sends, the notes it shows, and Find bringing
// the same notes back. The page loads under its content-security policy: any violation fails the run.
//   PLAYWRIGHT=<path to playwright-core> node tests/fixed-pool-page.mjs        (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { keccak_256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(DAPP, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(DAPP) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// A wallet and three pools, in the page. Signatures are fixed bytes per nonce (the page only derives from them).
const walletSource = (SEL) => `
(() => {
  const pools = {
    '0x8c4a04d872a6c1be37964a21ba3a138525dff50b': { d: 10n ** 17n, seen: new Set() },
    '0x8cc930096b4df705a007c4a039bdfa1320ed2508': { d: 10n ** 18n, seen: new Set() },
    '0x8d10d506d29fc62abb8a290b99f66db27fc43585': { d: 10n * 10n ** 18n, seen: new Set() },
  };
  const hex = (n, w) => BigInt(n).toString(16).padStart(w, '0');
  window.__log = { signs: 0, sends: 0 };
  window.ethereum = {
    on() {},
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts': return ['0x2c7536E3605D9C16a7a3D7b1898e529396a65c23'];
        case 'eth_chainId': return '0xaa36a7';
        case 'eth_getBalance': return '0x' + hex(10n ** 21n, 1);
        case 'eth_signTypedData_v4': {
          window.__log.signs++;
          const n = Number(JSON.parse(params[1]).message.nonce);
          return '0x' + hex(0x1111 + n, 64) + hex(1 + n, 64) + '1b';
        }
        case 'eth_getCode': return '0x6080';
        case 'eth_call': {
          const { to, data } = params[0];
          const p = pools[to.toLowerCase()];
          if (!p) return '0x';
          const s = data.slice(2, 10), arg = data.slice(10);
          if (s === '${SEL.den}') return '0x' + hex(p.d, 64);
          if (s === '${SEL.com}') return '0x' + (p.seen.has(arg) ? '1' : '0').padStart(64, '0');
          if (s === '${SEL.spent}') return '0x' + '0'.padStart(64, '0');
          throw new Error('call ' + s);
        }
        case 'wallet_getCapabilities': throw new Error('unsupported');
        case 'eth_sendTransaction': {
          const tx = params[0], p = pools[tx.to.toLowerCase()];
          if (BigInt(tx.value) !== p.d) throw new Error('value');
          p.seen.add(tx.data.slice(10));
          window.__log.sends++;
          return '0x' + hex(window.__log.sends, 64);
        }
        case 'eth_getTransactionReceipt': return { status: '0x1' };
        default: throw new Error('unexpected ' + method);
      }
    },
  };
})();
`;
// the three selectors the page asks the pools
const sel = (x) => bytesToHex(keccak_256(new TextEncoder().encode(x)).slice(0, 4));
const WALLET_SRC = walletSource({ den: sel('denomination()'), com: sel('commitments(bytes32)'), spent: sel('isSpent(bytes32)') });

const browser = await chromium.launch();
let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const open = async (url, { wallet = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console ' + m.text()); });
  if (wallet) await page.addInitScript(WALLET_SRC);
  await page.goto(base + url);
  return { ctx, page, problems };
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `split-${name}.png`), fullPage: true }); };

console.log('split page');
await test('off by default: nothing but a line, and the app stays hidden', async () => {
  const { ctx, page, problems } = await open('/split/');
  assert.equal(await page.locator('#off').isVisible(), true);
  assert.equal(await page.locator('#app').isVisible(), false);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('?fixed=1 turns it on, and it stays on without the flag, until ?fixed=0', async () => {
  const { ctx, page, problems } = await open('/split/?fixed=1');
  assert.equal(await page.locator('#app').isVisible(), true);
  await page.goto(base + '/split/');
  assert.equal(await page.locator('#app').isVisible(), true);
  await page.goto(base + '/split/?fixed=0');
  assert.equal(await page.locator('#app').isVisible(), false);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('the plan: 100.001234 ETH is one 100 ETH note and the odd part for Tacit', async () => {
  const { ctx, page, problems } = await open('/split/?fixed=1');
  await page.fill('#amt', '100.001234');
  const text = await page.locator('#plan').innerText();
  assert.match(text, /1 × 100 ETH/);
  assert.match(text, /0\.001234 ETH/);
  assert.match(text, /to Tacit/);
  await shot(page, 'plan');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('under 1 ETH everything goes to Tacit, with the default smallest note', async () => {
  const { ctx, page } = await open('/split/?fixed=1');
  await page.fill('#amt', '0.9');
  const text = await page.locator('#plan').innerText();
  assert.match(text, /all of it goes to Tacit/);
  await ctx.close();
});
await test('a deposit signs for every note, sends each, shows the notes, and Find brings them back', async () => {
  const { ctx, page, problems } = await open('/split/?fixed=1', { wallet: true });
  const say = async () => `who="${await page.locator('#who').innerText()}" status="${await page.locator('#status').innerText()}" find="${await page.locator('#findStatus').innerText()}" problems=${JSON.stringify(problems)}`;
  try {
  await page.click('summary'); // Settings
  await page.click('#go'); // connect
  await page.waitForFunction(() => document.querySelector('#who').textContent.includes('Sepolia'));
  await page.fill('#amt', '2.5');
  await page.selectOption('#min', String(10n ** 18n));
  assert.match(await page.locator('#go').innerText(), /Deposit 2 notes/);
  assert.match(await page.locator('#plan').innerText(), /2 × 1 ETH/);
  assert.match(await page.locator('#plan').innerText(), /0\.5 ETH/);
  await page.click('#go');
  await page.waitForSelector('#noteList .note');
  const notes = await page.locator('#noteList code').allInnerTexts();
  assert.equal(notes.length, 2);
  for (const n of notes) assert.match(n, /^tornado-eth-1-11155111-0x[0-9a-f]{124}$/);
  assert.equal(await page.locator('#dl').isVisible(), true);
  assert.equal(await page.evaluate(() => window.__log.sends), 2);
  assert.match(await page.locator('#status').innerText(), /Deposited all/);
  assert.equal(await page.locator('#next').isVisible(), true);
  await shot(page, 'deposited');
  // forget the shown notes, then Find
  await page.evaluate(() => { document.querySelector('#noteList').innerHTML = ''; });
  await page.click('#find');
  await page.waitForFunction(() => /found/.test(document.querySelector('#findStatus').textContent));
  const again = await page.locator('#noteList code').allInnerTexts();
  assert.deepEqual(again, notes);
  assert.deepEqual(problems, []);
  } catch (e) { e.message += ' | ' + await say(); throw e; }
  await ctx.close();
});
await test('a wallet-less browser says so', async () => {
  const { ctx, page } = await open('/split/?fixed=1');
  await page.click('#go');
  await page.waitForFunction(() => /No wallet/.test(document.querySelector('#status').textContent));
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
