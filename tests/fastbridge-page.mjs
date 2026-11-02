// The fast bridge page (dapp/fast/) in a real browser: the page and its module graph load under its content-security policy, a provider
// (the LP service of the machine tests, on a socket) is read and shown, the key sheet opens from the button and closes without a key.
//   PLAYWRIGHT=<path to playwright-core> node tests/fastbridge-page.mjs        (Node 22; SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { closers, configFor, serve, httpWorld } from './lib/lp-harness.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };


// The page's own entry script, replaced by one that gives the page logic a stand-in key, wallet and provider.
const STAND_IN = `
import { mountFast } from '/fast/ui.js';
const TAC = 10n ** 8n, fns = new Set();
const keyS = { unlocked: false, key: null, onChange: (f) => { fns.add(f); }, };
const STEPS = ['Lock on Bitcoin', 'Lock in the pool', 'Claim', 'Done'];
const rec = (o) => ({ phase: 'broadcast', title: 'Waiting for Bitcoin', detail: 'The lock needs one confirmation, about ten minutes.', at: 0, steps: STEPS, ended: false, returned: false, amount: String(100n * TAC), receive: String(98n * TAC), created: 1, lockTxid: 'bb'.repeat(32), ...o });
let recs = [
  rec({ id: '01'.repeat(36), phase: 'offered', title: 'Waiting for the pool lock', detail: 'The provider is locking TAC in the pool for you.', at: 1, amount: String(2500n * TAC), receive: String(2492n * TAC) }),
  rec({ id: '02'.repeat(36), phase: 'done', title: 'Done', detail: 'The TAC is in your private balance.', at: 3, ended: true }),
  rec({ id: '03'.repeat(36), phase: 'refund-wait', title: 'Returning to Bitcoin', detail: 'The lock returns to your Bitcoin address when its timelock ends.', returned: true, amount: String(40n * TAC), receive: '0' }),
  rec({ id: '04'.repeat(36), phase: 'refunded', title: 'Returned', detail: 'The lock came back to your Bitcoin address.', at: 3, ended: true, returned: true, amount: String(40n * TAC), receive: '0', lockTxid: null }),
];
const fb = {
  quote: async (units) => { const fee = (units * 30n) / 10000n + TAC; return { id: 'q', btcValue: units, evmAmount: units - fee, fee, validUntil: Math.floor(Date.now() / 1000) + 600 }; },
  start: async (a) => { recs = [rec({ id: 'aa'.repeat(36), amount: String(a.quote.btcValue), receive: String(a.quote.evmAmount) }), ...recs]; },
  records: async () => recs,
  run: ({ onChange }) => { onChange(recs); return () => {}; },
  recover: async () => [],
};
mountFast({
  root: document.getElementById('gate'), providers: [{ name: 'Tacit', base: 'https://lp.example' }], keyS,
  signIn: async () => { keyS.unlocked = true; keyS.key = { pubHex: '03' + 'cd'.repeat(32) }; fns.forEach((f) => f()); },
  info: async () => ({ claimPub: '02' + 'ab'.repeat(32), minAmount: String(10n * TAC), maxAmount: String(1000n * TAC), feeBps: 30, flatFee: String(TAC) }),
  open: async () => ({ fb, notes: async () => [{ txid: 'ee'.repeat(32), vout: 0, value: 546, amount: 1234550000000n, blinding: 7n }], balance: async () => 1234550000000n }),
});
`;

const web = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

// a provider, the real LP service of the machine tests
const { w } = httpWorld();
const lp = await serve(w, { config: configFor(w, { quote: { feeBps: 30, flatFee: 200 } }), origins: ['*'] });
const claimPub = bytesToHex(w.lW.wallet.pub);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const browser = await chromium.launch();
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());

async function visit(path, { entry = null } = {}) {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
  if (entry) await page.route(/\/fast\/app\.js/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: entry }));
  const bad = [];
  page.on('pageerror', (e) => bad.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => bad.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  await page.goto(WEB + path, { waitUntil: 'networkidle' });
  return { page, bad, shot: async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } };
}

try {
  // a provider the page is told of: its terms, and a button to open the wallet
  {
    const { page, bad, shot } = await visit(`/fast/?lp=${encodeURIComponent(lp.base)}&claimPub=${claimPub}`);
    await page.waitForFunction(() => /Fee/.test(document.getElementById('fx-lp')?.textContent || ''), null, { timeout: 15000 });
    ok(/^tacit fast/.test(await text(page, 'h1')), 'the page is "tacit fast"');
    ok(/Fee\s*0\.30% \+ 0\.000002 TAC/.test(await text(page, '#fx-lp')), `the provider's fee is shown (${await text(page, '#fx-lp')})`);
    ok((await text(page, '#fx-go')) === 'Open wallet' && !(await page.$eval('#fx-go', (e) => e.hidden)), 'the button reads Open wallet');
    ok(await page.$eval('#fx-form', (e) => e.hidden), 'no form before a key');
    ok(/Keep this page open/.test(await text(page, '.fx-keep')), 'the page says to keep it open');
    await shot('fast-signed-out');
    await page.click('#fx-go');
    await page.waitForSelector('.bsheet', { timeout: 5000 });
    ok(/Open your Tacit wallet/.test(await text(page, '.bsheet')), 'the key sheet opens from the button');
    await shot('fast-key-sheet');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.bsheet', { state: 'detached', timeout: 5000 }).catch(() => {});
    if (await page.$('.bsheet')) await page.click('.bsheet .x');
    await page.waitForFunction(() => !document.querySelector('.bsheet'), null, { timeout: 5000 });
    ok((await text(page, '#fx-st')) === '' && (await page.$eval('#fx-form', (e) => e.hidden)), 'closing the sheet without a key leaves the page as it was');
    ok(bad.length === 0, `no errors or failed requests (${bad.join(' | ')})`);
    await page.context().close();
  }
  // a pinned key that is not the provider's: the page treats it as offline
  {
    const { page, bad } = await visit(`/fast/?lp=${encodeURIComponent(lp.base)}&claimPub=02${'ab'.repeat(32)}`);
    await page.waitForFunction(() => /No provider is online/.test(document.getElementById('fx-lp')?.textContent || ''), null, { timeout: 15000 });
    ok(await page.$eval('#fx-go', (e) => e.hidden), 'a provider with another key than the pinned one is not offered');
    ok(bad.length === 0, `no errors (${bad.join(' | ')})`);
    await page.context().close();
  }
  // no provider named: the list the page ships (none yet) says so, with a way to the regular bridge
  {
    const { page, bad, shot } = await visit('/fast/');
    await page.waitForFunction(() => /No provider is online/.test(document.getElementById('fx-lp')?.textContent || ''), null, { timeout: 15000 });
    ok(!!(await page.$('#fx-lp a[href="/"]')), 'a link to the front page');
    await shot('fast-no-provider');
    ok(bad.length === 0, `no errors (${bad.join(' | ')})`);
    await page.context().close();
  }
  // the page's states with a key open, drawn by the real page logic over a stand-in wallet and provider: the form, the quote, the press, the bridges
  {
    const { page, bad, shot } = await visit('/fast/', { entry: STAND_IN });
    await page.waitForFunction(() => /Fee/.test(document.getElementById('fx-lp')?.textContent || ''), null, { timeout: 15000 });
    await page.click('#fx-go');
    await page.waitForFunction(() => !document.getElementById('fx-form').hidden && /on Bitcoin/.test(document.getElementById('fx-bal').textContent), null, { timeout: 5000 });
    ok(/12,345\.5 TAC on Bitcoin/.test(await text(page, '#fx-bal')), `the TAC on Bitcoin is shown (${await text(page, '#fx-bal')})`);
    ok((await text(page, '#fx-go')) === 'Bridge' && await page.$eval('#fx-go', (e) => e.disabled), 'the button reads Bridge and waits for an amount');
    ok(await page.$eval('#fx-list', (e) => !e.hidden) && (await page.$$('#fx-list .fx-rec')).length === 4, 'the bridges under way are listed');
    await page.fill('#fx-amt', '5');
    ok(/The least is 10 TAC/.test(await text(page, '#fx-st')), 'an amount under the least is said');
    await page.fill('#fx-amt', '250');
    await page.waitForFunction(() => !document.getElementById('fx-recv').hidden, null, { timeout: 5000 });
    ok(/You pay\s*250 TAC/.test(await text(page, '#fx-recv')) && /You receive, private\s*248\.25 TAC/.test(await text(page, '#fx-recv')), `the quote is shown (${await text(page, '#fx-recv')})`);
    ok(!(await page.$eval('#fx-go', (e) => e.disabled)), 'the button is ready');
    await shot('fast-quote');
    await page.click('#fx-go');
    await page.waitForFunction(() => /Started/.test(document.getElementById('fx-st').textContent), null, { timeout: 5000 });
    ok((await page.$$('#fx-list .fx-rec')).length === 5 && (await page.inputValue('#fx-amt')) === '', 'the new bridge is at the top and the amount is cleared');
    await shot('fast-bridges');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('fast-phone');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
    ok(bad.length === 0, `no errors (${bad.join(' | ')})`);
    await page.context().close();
  }
} finally {
  await browser.close();
  web.close();
  while (closers.length) { try { await closers.pop()(); } catch { /* closed */ } }
}
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
