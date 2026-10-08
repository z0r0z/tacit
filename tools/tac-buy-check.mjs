// Checks buying TAC with sats on /tac (dapp/tac/), against live mainnet data and spending nothing: the asks standing on
// the Bitcoin order book carry Buy buttons; a locked page asks for the wallet; a fresh key's address shows no sats; a first
// press states the cost and a second runs tacit.js's takePreauthSale, which, finding no sats, stops before any transaction
// with a message that says so. No transaction is broadcast.
//   node tools/tac-buy-check.mjs        (PLAYWRIGHT=<path to playwright-core>)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((r, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(r.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const URL_ = `http://127.0.0.1:${server.address().port}/tac/`;

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
// The API answers only tacit.finance's origin: its reads pass through here, and nothing is ever posted to it.
await ctx.route('https://api.tacit.finance/**', async (route) => {
  const q = route.request();
  if (q.method() !== 'GET') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"read-only check"}' });
  try {
    const r = await fetch(q.url());
    route.fulfill({ status: r.status, contentType: r.headers.get('content-type') || 'application/json', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(await r.arrayBuffer()) });
  } catch (e) { route.fulfill({ status: 502, body: String(e.message) }); }
});
const page = await ctx.newPage();
const errors = [], sent = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => { if (r.method() === 'POST' && /\/tx$|broadcast|sendrawtransaction/i.test(r.url())) sent.push(r.url()); });
const text = (s) => page.evaluate((x) => (document.querySelector(x)?.textContent || '').replace(/\s+/g, ' ').trim(), s);
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.click('#tab-market');
  await page.waitForSelector('#market-body .dep', { timeout: 60000 });
  const asks = await page.$$eval('#market-body .dep .buy', (b) => b.length);
  ok(asks > 0, `the asks on the book carry Buy buttons (${asks})`);
  ok(/Open your wallet/.test(await text('#market-body .fund')), 'locked: the page asks for the wallet before buying');

  await page.click('#wallet-chip');
  // A key made for this run, pasted, so no one can have funded its address: pressing Confirm below can never send
  // anything. A pasted key is held for the tab only.
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', randomBytes(32).toString('hex'));
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => /Sats there/.test(document.querySelector('#market-body .fund')?.textContent || ''), null, { timeout: 90000 });
  ok(/Pay from\s*bc1q.*Sats there\s*0 sats/.test(await text('#market-body .fund')), `opened: the key's Bitcoin address and its sats (${(await text('#market-body .fund')).slice(0, 70)})`);
  if (!/Sats there\s*0 sats/.test(await text('#market-body .fund'))) throw new Error('this key\'s address holds sats: not pressing Confirm');

  await page.click('#market-body .dep .buy');
  ok(/^Buy [\d,.]+ TAC for [\d,]+ sats, [\d,.]+ sats per TAC.*plus the fees for two Bitcoin transactions.*Press Confirm to pay\.$/.test(await text('#st-market')) && (await text('#market-body .dep .buy')) === 'Confirm',
    `a first press states the cost and asks for a second (${(await text('#st-market')).slice(0, 80)})`);
  await page.click('#market-body .dep .buy');
  await page.waitForFunction(() => /err|Bought/.test(document.querySelector('#st-market')?.innerHTML || ''), null, { timeout: 300000 });   // the listing checks read public Bitcoin APIs, slow at times
  ok(/too few sats for this ask.*Nothing was sent\./.test(await text('#st-market')) && !sent.length, `confirm with no sats stops before any transaction (${(await text('#st-market')).slice(0, 80)})`);
  // An ask priced far over the market is listed, but not offered: one press from paying many times the going price.
  const far = await ctx.newPage();
  await far.route(/\/preauth-sales/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ sales: [{ sale_id: 'ff'.repeat(32), expiry: Math.floor(Date.now() / 1000) + 3600, min_price_sats: 100000000, asset_opening: { amount: '100000000' }, decimals: 8 }] }) }));
  await far.goto(URL_, { waitUntil: 'domcontentloaded' });
  await far.click('#tab-market');
  await far.waitForSelector('#market-body .dep', { timeout: 60000 });
  ok((await far.$$eval('#market-body .dep .buy', (b) => b.length)) === 0 && (await far.$$eval('#market-body .dep', (d) => d.length)) === 1, 'an ask far over the market is listed but has no Buy button');
  ok(!errors.length, `no page errors ${errors.join(' | ')}`);
} catch (e) { fails++; console.log('FAIL', e.message.split('\n')[0]); }
await browser.close();
server.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
