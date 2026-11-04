#!/usr/bin/env node
// The swap card on its test harness (tests/swap-harness/, which is what /swap/ was) with no outside network: two small things it does with no wallet.
//   - a link that names a token the card does not know opens on the default pair and SAYS so (the note was set and then cleared by the same load, so it never showed),
//     and still says so once the long token list has been read and the name is still not in it;
//   - the sides turned round with no quote to carry over do not keep the number typed, which would be read in the other coin.
// Nothing is quoted (every node is refused) or sent.
//
//   node tests/swap-card-presses.mjs

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const SH = join(dirname(fileURLToPath(import.meta.url)), 'swap-harness');
const HARNESS = { '/swap/': join(SH, 'index.html'), '/swap/index.html': join(SH, 'index.html'), '/swap/app.js': join(SH, 'app.js') };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = HARNESS[u.pathname] || normalize(join(ROOT, decodeURIComponent(u.pathname)));
  if (!HARNESS[u.pathname] && !p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) p = join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.log('FAIL -', m); } };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));

async function open(url) {
  const page = await ctx.newPage();
  page.errs = [];
  page.on('pageerror', (e) => page.errs.push(String(e.message || e).slice(0, 140)));
  await page.goto(base + url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sw #amt', { timeout: 40000 });
  return page;
}
const said = (page) => page.$eval('#q', (e) => e.textContent.replace(/\s+/g, ' ').trim());

console.log('a link naming a token the card does not know');
{
  const page = await open('/swap/?to=NOSUCHCOINXYZ&amt=1');
  await page.waitForFunction(() => /not in the list/.test(document.querySelector('#q').textContent), null, { timeout: 15000 }).catch(() => {});
  ok(/That token is not in the list/.test(await said(page)), `the card says it opened on its default pair (${await said(page)})`);
  ok(await page.inputValue('#amt') === '', 'and the amount, meant for another pair, is not filled in');
  // the long token list is read a moment after the load: the name is still not in it, and the note stays
  await page.waitForTimeout(1500);
  ok(/That token is not in the list/.test(await said(page)), 'the note is still there once the token list has been read');
  await page.fill('#amt', '2');
  ok(!/not in the list/.test(await said(page)), 'typing an amount takes it away');
  ok(!page.errs.length, `no page errors${page.errs.length ? ': ' + page.errs.join(' | ') : ''}`);
  await page.close();
}

console.log('a link naming a token by an address the card does not hold');
{
  // an address is not looked for in the token list, so nothing sets the note again after the load: it has to survive the load itself
  const page = await open('/swap/?to=0x1111111111111111111111111111111111111111&amt=1');
  ok(/That token is not in the list/.test(await said(page)), `the card says it opened on its default pair (${await said(page)})`);
  ok(!page.errs.length, `no page errors${page.errs.length ? ': ' + page.errs.join(' | ') : ''}`);
  await page.close();
}

console.log('turning the sides round');
{
  const page = await open('/swap/');
  await page.fill('#amt', '1');
  await page.waitForTimeout(600);
  await page.click('#flip');
  ok(await page.inputValue('#amt') === '', `with no price to carry over, the 1 typed for ETH is not left to be read as 1 TAC (${JSON.stringify(await page.inputValue('#amt'))})`);
  ok(!page.errs.length, `no page errors${page.errs.length ? ': ' + page.errs.join(' | ') : ''}`);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
