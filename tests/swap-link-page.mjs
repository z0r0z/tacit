#!/usr/bin/env node
// A swap link opens the front page's Swap card on that swap, and the card's own copy link brings the same form back. Serves dapp/ locally with no
// outside network and reads what the card shows: its two coins and where each is held (#pay-coin, #get-coin, #pay-at, #get-at) and the amount.
// Nothing is quoted or sent; the card only has to show what the link names.
//
//   node tests/swap-link-page.mjs
//
// The unit-level rule is tests/swap-link.test.mjs; this is the same links through the real page.

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
await ctx.addInitScript(() => {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true });
});

const read = (page) => page.evaluate(() => {
  const t = (s) => (document.querySelector(s)?.textContent || '').trim().replace(/\s+/g, ' ');
  const coin = (s) => t(s).match(/^[A-Za-z0-9]+/)?.[0] || '';
  return { pay: coin('#hx-swap #pay-coin'), get: coin('#hx-swap #get-coin'), payAt: t('#hx-swap #pay-at'), getAt: t('#hx-swap #get-at'), amt: document.querySelector('#hx-swap #amt')?.value || '', search: location.search };
});
// open a link and wait until the card shows `want` (the card may settle a moment after it first paints, when the token list arrives)
async function open(page, link, want) {
  await page.goto(base + link, { waitUntil: 'domcontentloaded' });
  const key = (s) => `${s.pay}|${s.payAt}|${s.get}|${s.getAt}|${s.amt}`;
  const wantKey = key(want);
  await page.waitForFunction((w) => {
    const t = (s) => (document.querySelector(s)?.textContent || '').trim().replace(/\s+/g, ' ');
    const coin = (s) => t(s).match(/^[A-Za-z0-9]+/)?.[0] || '';
    return `${coin('#hx-swap #pay-coin')}|${t('#hx-swap #pay-at')}|${coin('#hx-swap #get-coin')}|${t('#hx-swap #get-at')}|${document.querySelector('#hx-swap #amt')?.value || ''}` === w;
  }, wantKey, { timeout: 40000 }).catch(() => {});
  return read(page);
}
const show = (s) => `${s.pay} ${s.payAt} → ${s.get} ${s.getAt}${s.amt ? ' · ' + s.amt : ''}`;

// what each link should open on: [link, pay, where, get, where, amount]
const CASES = [
  // the private names carry their side
  ['/?from=tETH&to=cBTC&amt=0.01', 'tETH', 'Private', 'cBTC', 'Private', '0.01'],
  ['/?from=tETH&to=cUSD&amt=0.5', 'tETH', 'Private', 'cUSD', 'Private', '0.5'],
  ['/?from=cETH&to=cTAC&amt=1', 'tETH', 'Private', 'TAC', 'Private', '1'],
  ['/?from=tETH&to=USDC&amt=0.01', 'tETH', 'Private', 'USDC', 'Wallet', '0.01'],
  // the private flag, as it always was
  ['/?from=ETH&to=cBTC&amt=0.01&private', 'ETH', 'Wallet', 'cBTC', 'Private', '0.01'],
  ['/?from=ETH&to=cBTC&amt=0.01&private=to', 'ETH', 'Wallet', 'cBTC', 'Private', '0.01'],
  ['/?from=tETH&to=cBTC&amt=0.01&private=both', 'tETH', 'Private', 'cBTC', 'Private', '0.01'],
  ['/?from=TAC&to=cBTC&amt=5&private', 'TAC', 'Private', 'cBTC', 'Private', '5'],
  // old links keep their meaning: cusd / cBTC alone are the public tokens
  ['/?to=cusd', 'ETH', 'Wallet', 'tacUSD', 'Wallet', ''],
  ['/?from=ETH&to=cBTC&amt=0.01', 'ETH', 'Wallet', 'tacBTC', 'Wallet', '0.01'],
];
for (const [link, pay, payAt, get, getAt, amt] of CASES) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 140)));
  const s = await open(page, link, { pay, payAt, get, getAt, amt });
  ok(s.pay === pay && s.payAt === payAt && s.get === get && s.getAt === getAt && s.amt === amt, `${link} opens ${pay} ${payAt} → ${get} ${getAt}${amt ? ' · ' + amt : ''} (${show(s)})`);
  ok(!errs.length, `${link}: no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
  await page.close();
}

// sharing: the card's copy link carries the pair, the private sides and the amount, and opening it brings the same form back
{
  const page = await ctx.newPage();
  const first = await open(page, '/?from=tETH&to=cBTC&amt=0.01', { pay: 'tETH', payAt: 'Private', get: 'cBTC', getAt: 'Private', amt: '0.01' });
  ok(first.pay === 'tETH' && first.get === 'cBTC', 'share: the link opens tETH → cBTC');
  ok(!/amt=/.test(first.search), `share: the amount stays out of the address bar of a private swap (${first.search})`);
  await page.waitForFunction(() => !document.querySelector('#hx-swap #copy')?.hidden, null, { timeout: 30000 }).catch(() => {});
  await page.click('#hx-swap #copy');
  const link = new URL((await page.evaluate(() => window.__copied)).at(-1) || 'http://x/');
  const q = link.searchParams;
  ok(q.get('from') === 'tETH' && q.get('to') === 'cBTC' && q.get('amt') === '0.01' && q.get('private') === 'both', `share: the copy link names both coins, both sides private and the amount (${link.search})`);
  await page.close();
  const again = await ctx.newPage();
  const s = await open(again, link.pathname + link.search, { pay: 'tETH', payAt: 'Private', get: 'cBTC', getAt: 'Private', amt: '0.01' });
  ok(show(s) === show(first), `share: opening the copy link brings the same form back (${show(s)})`);
  await again.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
