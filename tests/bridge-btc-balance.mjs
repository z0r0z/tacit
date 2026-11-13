#!/usr/bin/env node
// The front page's Bridge tab, bridging back from Bitcoin, in a real browser under the page's own CSP, with a pasted key. The Bitcoin read is the page's own
// (loadBtc -> scanHoldings) with the holdings the scan would return put in its place (tacit.js has a hook for it, and this test appends the line that reaches
// it); the Bitcoin address's coins are answered here and every other host refused:
//   · with TAC from Bitcoin picked, the From field says how much TAC the key holds on Bitcoin, as the wallet sheet does, and offers no Max (notes go whole);
//   · the From picker gives the amount beside "TAC, on Bitcoin", and beside tETH on Bitcoin when that way is offered.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/bridge-btc-balance.mjs      (DAPP=<dir> to try another build, INDEX=<file> another front page)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = process.env.INDEX && (path === '/' || path === '/index.html') ? process.env.INDEX : join(DAPP, path);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const KEY = '11'.repeat(31) + '22';
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const COIN = [{ txid: 'aa'.repeat(32), vout: 0, value: 250000, status: { confirmed: true, block_height: 900000, block_time: 1700000000 } }];
const TACIT_JS = readFileSync(join(DAPP, 'tacit.js'), 'utf8') + '\n_testSetScanHoldingsOverride(() => (globalThis.__held ? globalThis.__held() : new Map()));\n';

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([tac, teth]) => {
    const note = (txid, amount) => ({ utxo: { txid, vout: 0, status: { confirmed: true } }, amount });
    window.__held = () => new Map([
      [tac, { assetIdHex: tac, ticker: 'TAC', decimals: 8, balance: 638843749000000n, utxos: [note('cc'.repeat(32), 638843749000000n)], unverified: [] }],
      [teth, { assetIdHex: teth, ticker: 'tETH', decimals: 8, balance: 150000000n, utxos: [note('dd'.repeat(32), 150000000n)], unverified: [] }],
    ]);
  }, [TAC, TETH]);
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE)) {
      if (new URL(u).pathname === '/tacit.js') return r.fulfill({ status: 200, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }, body: TACIT_JS });
      return r.continue();
    }
    if (/\/address\/[^/]+\/utxo/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(COIN) });
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#wallet', { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#wbal-re:not([disabled])', { timeout: 30000 });
  await page.click('#wbal-re');
  await page.waitForFunction(() => /6,388,437\.49/.test(document.querySelector('#wbal-box')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
  ok(/6,388,437\.49/.test(await text('#wbal-box')), 'the wallet sheet shows the TAC held on Bitcoin');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});

  await page.click('#hx [data-hxm="more"]');
  await page.click('#hx [data-hxm="bridge"]').catch(() => {});
  await page.waitForSelector('#hx-tab-bridge[aria-selected="true"]', { timeout: 10000 }).catch(() => {});
  const from = await page.$eval('#hx-from', (s) => s.value).catch(() => '');
  ok(from === 'btc', `the Bridge tab starts on TAC from Bitcoin (${from})`);
  await page.waitForFunction(() => /6,388,437/.test(document.querySelector('#hx-bal')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const bal = await text('#hx-bal');
  ok(/Balance 6,388,437\.49/.test(bal), `the From field says how much TAC is on Bitcoin: "${bal}"`);
  const max = await page.$eval('#hx-max', (b) => ({ off: b.disabled, t: b.textContent })).catch(() => null);
  ok(!!max && max.off && !/Max/.test(max.t), 'and offers no Max, since notes bridge whole');
  ok(!(await page.$('#hx-bal .quick')), 'and no quick amounts');
  if (process.env.SHOT) await page.locator('#hx').screenshot({ path: process.env.SHOT.replace(/\.png$/, '-card.png') });

  await page.click('[data-pk="hx-from"]');
  await page.waitForSelector('.pk .pk-r[data-v="btc"]', { timeout: 10000 });
  await page.waitForFunction(() => /6,388,437/.test(document.querySelector('.pk .pk-r[data-v="btc"] em')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const row = await text('.pk .pk-r[data-v="btc"] em');
  ok(/6,388,437\.49/.test(row), `the From picker gives the amount beside TAC on Bitcoin: "${row}"`);
  if (await page.$('.pk .pk-r[data-v="tb"]')) {
    const tb = await text('.pk .pk-r[data-v="tb"] em');
    ok(/^1\.5/.test(tb), `and beside tETH on Bitcoin: "${tb}"`);
  }
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.keyboard.press('Escape');
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
  await ctx.close();
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nbridge Bitcoin balance checks passed (${n})`);
process.exit(fails ? 1 : 0);
