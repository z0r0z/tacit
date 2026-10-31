#!/usr/bin/env node
// The Swap card's Private list on the front page holds two pools' coins (the DeFi pool's, to swap, farm and borrow with, and the Pay pool's, to pay anyone), and
// says so: each pool's coins sit under a line of their own, a coin held in both (ETH, TAC) is not read as one, a search (which has no lines) still tells them apart,
// and a host with one pool (the card's test harness, tests/swap-harness/, which is what /swap/ was) draws none. Serves dapp/ locally with no outside network and
// reads the picker; nothing is quoted or sent.
//
//   node tests/swap-picker-homes.mjs

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
// /swap/ is the card's test harness (tests/swap-page.mjs serves it the same way); everything else is dapp/
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));

// the list as it is drawn, in order: a line as "# its words", a coin as "its place:its symbol" (and "!" when it is dimmed), what is hidden left out
const layout = (page, root) => page.$$eval(`${root} #pk-l > *`, (els) => els.filter((e) => !e.hidden).flatMap((e) => (e.classList.contains('pk-sub')
  ? [`# ${e.textContent.trim()}`]
  : e.classList.contains('pk-r') ? [`${/^@(\w+):/.exec(e.dataset.k)?.[1] || 'wallet'}:${e.querySelector('b').firstChild.textContent.trim()}${e.classList.contains('off') ? '!' : ''}`] : [])));
const sub = (page, root, coin) => page.$eval(`${root} #pk-l .pk-r[data-k${coin.startsWith('@') ? '^' : ''}="${coin}"] small`, (s) => s.innerText.replace(/\s+/g, ' ').trim());

async function open(url, root, side) {
  const page = await ctx.newPage();
  page.errs = [];
  page.on('pageerror', (e) => page.errs.push(String(e.message || e).slice(0, 140)));
  await page.goto(base + url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`${root} #${side}-coin`, { timeout: 40000 });
  await page.click(`${root} #${side}-coin`);
  await page.waitForSelector(`${root} #pk .pk-r:visible`, { timeout: 30000 });
  return page;
}

// the front page, From: both pools, each under its line
{
  const R = '#hx-swap', page = await open('/?from=tETH&to=cBTC&amt=0.01', R, 'pay');
  ok(await page.isVisible(`${R} #pk-kind [data-kind="private"][aria-checked="true"]`), 'the picker opens on Private for a private coin');
  ok((await layout(page, R)).join(' | ') === '# Swap, farm, borrow | defi:tETH | defi:TAC | defi:cUSD | defi:cBTC | # Pay anyone | pay:ETH | pay:USDC | pay:USDT | pay:TAC',
    `the DeFi pool's coins sit under "Swap, farm, borrow" and the Pay pool's under "Pay anyone" (${(await layout(page, R)).join(' | ')})`);
  // the group heading the other tests classify rows by is still one "Private" over all of them
  const under = await page.evaluate(() => { let g = '', bad = []; for (const el of document.querySelectorAll('#hx-swap #pk .pk-g, #hx-swap #pk .pk-r')) { if (el.classList.contains('pk-g')) { g = el.textContent; continue; } if (/^@(defi|pay):/.test(el.dataset.k) && !/^Private/.test(g)) bad.push(el.dataset.k); } return bad; });
  ok(!under.length, `every private coin is still listed under the one "Private" group heading (${under.join() || 'none stray'})`);
  ok(await page.$eval(`${R} #pk-l .pk-d:not([hidden])`, (p) => p.textContent.trim()) === 'Held privately.', 'the note over the lines no longer says again what each is for');
  // a coin held in both pools does not say what it is for under its own line, and says it once a search has taken the lines away
  ok(await sub(page, R, '@defi:teth') === 'ETH, made private' && await sub(page, R, '@defi:0xa1313eb9f3a445606d9583bcac3ebeb56a858279') === 'Tacit’s token', 'under its line a coin held in both pools says only what it is');
  await page.fill(`${R} #pk-q`, 'tac');
  ok(await page.$$eval(`${R} #pk-l .pk-sub`, (s) => s.every((x) => x.hidden)), 'a search draws no lines');
  const hits = await page.$$eval(`${R} #pk-l .pk-r[data-k^="@defi:"]:not([hidden]), ${R} #pk-l .pk-r[data-k^="@pay:"]:not([hidden])`, (rs) => rs.filter((r) => r.querySelector('b').firstChild.textContent.trim() === 'TAC').map((r) => `${/^@(\w+):/.exec(r.dataset.k)?.[1]}:${r.querySelector('small').innerText.replace(/\s+/g, ' ').trim()}`));
  ok(hits.length === 2 && hits.some((h) => /^defi:.*swap, farm, borrow/.test(h)) && hits.some((h) => /^pay:.*pay anyone/.test(h)), `and the two TACs tell themselves apart (${hits.join(' | ')})`);
  await page.fill(`${R} #pk-q`, '');
  ok((await layout(page, R)).filter((x) => x.startsWith('#')).join() === '# Swap, farm, borrow,# Pay anyone', 'clearing the search brings the lines back');
  ok(await sub(page, R, '@defi:teth') === 'ETH, made private', 'and the coins go back to saying only what they are');
  // the lines belong to Private: another kind's list has none
  await page.click(`${R} #pk-kind [data-kind="wallet"]`);
  ok(!(await layout(page, R)).some((x) => x.startsWith('#')) && (await layout(page, R)).some((x) => x.startsWith('wallet:')), 'the Wallet list has none');
  await page.click(`${R} #pk-kind [data-kind="private"]`);
  ok((await layout(page, R)).filter((x) => x.startsWith('#')).length === 2, 'and Private has them again');
  ok(!page.errs.length, `no page errors${page.errs.length ? ': ' + page.errs.join(' | ') : ''}`);
  await page.close();
}

// the front page, To, from tETH: the Pay pool's coins cannot be reached from it, so they are dimmed under their line, last
{
  const R = '#hx-swap', page = await open('/?from=tETH&to=cBTC&amt=0.01', R, 'get');
  const l = await layout(page, R);
  ok(l.filter((x) => x.startsWith('#')).length === 2, `the To list has both lines (${l.join(' | ')})`);
  const at = l.indexOf('# Pay anyone'), defi = l.slice(0, at), pay = l.slice(at + 1);
  ok(defi.every((x, i) => !x.endsWith('!') || defi.slice(i).every((y) => y.endsWith('!'))) && pay.every((x) => x.endsWith('!')), 'a coin that cannot be reached goes last under its own line');
  await page.close();
}

// a host with one pool: no lines, and the note says what the pool is for
{
  const page = await open('/swap/?from=tETH&to=cBTC&amt=0.01', '', 'pay');
  const l = await layout(page, '');
  ok(l.length >= 4 && !l.some((x) => x.startsWith('#')) && l.every((x) => x.startsWith('defi:')), `the swap page draws no lines (${l.join(' | ')})`);
  ok(await page.$eval('#pk-l .pk-d:not([hidden])', (p) => p.textContent.trim()) === 'Held privately in Tacit’s pool, to swap, farm and borrow with.', 'and its note keeps saying what the pool is for');
  ok(!page.errs.length, `no page errors${page.errs.length ? ': ' + page.errs.join(' | ') : ''}`);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
