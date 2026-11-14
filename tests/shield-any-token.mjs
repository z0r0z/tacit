#!/usr/bin/env node
// The front page's Shield tab takes any token the Swap card knows, not four coins, and every one goes in as itself: ETH as tETH, TAC as private TAC, the
// two dollars to their payments pools, and any other token as its own private form in the DeFi pool (the page registers it with the pool on the first
// shield). Nothing is sold on the way in. The To side reads the token, wearing its own logo in the private ring, and the button says Shield and the token.
// Withdraw still lists only private coins and offers no search. Serves dapp/ locally with no outside network and reads the picker and the card's sides; nothing is quoted or sent
// (the card's quote of a token into the pool, and a pasted address, are read live: tests/swap-private-fork.mjs and the scratch walk for those).
//
//   node tests/shield-any-token.mjs

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = normalize(join(ROOT, decodeURIComponent(u.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
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
for (const [tag, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForSelector('#pay-coin');

  const rows = () => page.$$eval('#pk .pk-r', (bs) => bs.filter((b) => !b.closest('[hidden]') && !b.hidden).map((b) => ({ k: b.dataset.k, sym: b.querySelector('b')?.firstChild?.textContent?.trim(), off: b.classList.contains('off') })));
  const groups = () => page.$$eval('#pk-l .pk-g', (gs) => gs.map((g) => g.textContent.trim()));
  const side = (id) => page.$eval(id, (b) => b.textContent.replace(/[▾\s]+/g, ' ').trim());
  const goText = () => page.$eval('#go', (b) => b.textContent.trim());
  const open = async () => { await page.click('#pay-coin'); await page.waitForSelector('#pk .pk-r'); };

  // Shield opens on ETH, and its From list is the wallet's coins, then the rest of the token list
  await open();
  ok(await page.$('#pk-q') !== null, `${tag}: Shield's From list has the token search`);
  const gs = await groups();
  ok(gs.includes('Wallet') && gs.includes('More tokens') && !gs.some((g) => /sold/.test(g)), `${tag}: the wallet's coins lead, then the rest of the list, none of it sold on the way in (${gs.join(' | ')})`);
  const all = await rows();
  const syms = all.map((r) => r.sym);
  ok(['ETH', 'TAC', 'USDC', 'USDT'].every((s) => syms.slice(0, 4).includes(s)), `${tag}: ETH, TAC, USDC and USDT still come first (${syms.slice(0, 6).join(', ')})`);
  ok(['WBTC', 'LINK', 'DAI', 'wstETH'].every((s) => syms.includes(s)), `${tag}: other tokens are there (${syms.length} rows)`);
  ok(all.every((r) => !r.off), `${tag}: every row goes somewhere (none dimmed)`);
  const subs = await page.$$eval('#pk .pk-r', (bs) => bs.filter((b) => !b.closest('[hidden]') && !b.hidden).map((b) => ({ sym: b.querySelector('b')?.firstChild?.textContent?.trim(), sub: b.querySelector('small')?.textContent || '' })));
  ok(subs.every((r) => !/sold/.test(r.sub)), `${tag}: no row says it is sold (${subs.slice(3, 5).map((r) => `${r.sym}: ${r.sub}`).join('; ')})`);

  // a token is picked by searching for it
  await page.fill('#pk-q', 'wbtc');
  ok(JSON.stringify((await rows()).map((r) => r.sym)) === '["WBTC"]', `${tag}: a search finds it`);
  ok(await page.$eval('#pk-l .pk-r:not([hidden]) b .pk-t', (e) => getComputedStyle(e).display) === 'none', `${tag}: and the result does not carry a Public tag (all of them are the wallet's)`);
  await page.click('#pk .pk-r:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#pk .pk-r'));
  ok(await side('#pay-coin') === 'WBTC', `${tag}: the From coin is WBTC (${await side('#pay-coin')})`);
  ok(await side('#get-coin') === 'WBTC', `${tag}: the To side reads WBTC: it goes in as itself (${await side('#get-coin')})`);
  ok(await page.$eval('#get-coin .tk', (e) => e.classList.contains('pvt') && !/teth|tk-eth/.test(e.querySelector?.('use')?.getAttribute('href') || '')), `${tag}: and wears its own logo in the private ring`);
  ok(/DeFi pool/.test(await page.$eval('#get-at', (e) => e.textContent)), `${tag}: it lands in the DeFi pool (${await page.$eval('#get-at', (e) => e.textContent.trim())})`);
  ok(await goText() === 'Shield WBTC', `${tag}: the button says what it does (${await goText()})`);
  const tip = () => page.$eval('#flow-tip', (e) => (e.hidden ? '' : e.textContent.trim()));
  ok(await tip() === '', `${tag}: and no line explains a sale, since there is none (${await tip()})`);
  await page.click('#pay-coin'); await page.waitForSelector('#pk .pk-r');
  await page.evaluate(() => [...document.querySelectorAll('#pk .pk-r')].find((b) => !b.hidden && b.querySelector('b')?.firstChild?.textContent?.trim() === 'ETH')?.click());
  await page.waitForFunction(() => !document.querySelector('#pk .pk-r'));
  ok(await side('#pay-coin') === 'ETH' && await goText() === 'Shield ETH' && await side('#get-coin') === 'ETH', `${tag}: ETH goes in as itself (${await side('#pay-coin')}, ${await goText()})`);
  ok(await page.$eval('#get-coin svg.tk', (s) => !s.classList.contains('pvt') && s.querySelector('use')?.getAttribute('href') === '#tk-teth'), `${tag}: and its To side keeps the tETH mark`);

  // the card turned to Withdraw (from ETH: a token has no private form to take back) lists private coins only and has no token search
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForSelector('#pay-coin');
  await page.waitForFunction(() => !document.querySelector('#flip')?.disabled);
  await page.click('#flip');
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() === 'Withdraw');
  await open();
  ok(await page.$('#pk-q') === null, `${tag}: Withdraw's list has no token search`);
  ok(JSON.stringify(await groups()) === '["Private"]', `${tag}: and holds only the private coins (${(await groups()).join(' | ')})`);
  ok((await rows()).every((r) => /^@/.test(r.k)), `${tag}: every row is a private coin`);
  await page.keyboard.press('Escape');
  await page.click('#flip');
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() === 'Shield');
  await open();
  ok(await page.$('#pk-q') !== null, `${tag}: turned back to Shield, the search is there again`);
  await page.keyboard.press('Escape');
  ok(errs.length === 0, `${tag}: no page errors${errs.length ? ' (' + errs[0] + ')' : ''}`);
  await ctx.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
