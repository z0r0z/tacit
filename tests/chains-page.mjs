#!/usr/bin/env node
// The Chains entry point is a choice page, not an arbitrary tool. Exercise its
// routing, language and narrow-screen layout with the real built page offline.

import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const SHOTS = process.env.SHOTS || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
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

async function check(width, name) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: name.includes('dark') ? 'dark' : 'light' });
  await ctx.route('**/*', (r) => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to fetch/i.test(m.text())) errors.push(m.text()); });
  await page.goto(base + '/#/chains', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.sec === 'chains/overview' && location.hash === '#/chains/overview');

  const state = await page.evaluate(() => {
    const visible = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
    const tabs = [...document.querySelectorAll('#sec-head .sh-t a')];
    const cards = [...document.querySelectorAll('#page-chains .cpg-card')];
    const tabTops = tabs.map((e) => Math.round(e.getBoundingClientRect().top));
    return {
      sec: document.documentElement.dataset.sec,
      hash: location.hash,
      overview: visible('#page-chains'), hero: visible('.hero'),
      active: document.querySelector('#sec-head .sh-t a[aria-current="page"]')?.textContent.trim(),
      tabs: tabs.map((e) => e.textContent.trim()),
      tabRows: new Set(tabTops).size,
      cards: cards.map((a) => [a.querySelector('h3')?.textContent.trim(), a.getAttribute('href')]),
      cardColumns: new Set(cards.map((a) => Math.round(a.getBoundingClientRect().left))).size,
      compare: document.querySelector('.cpg-compare')?.textContent.replace(/\s+/g, ' ').trim(),
      notes: document.querySelector('.cpg-note a')?.getAttribute('href'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  ok(state.sec === 'chains/overview' && state.hash === '#/chains/overview', `${name}: /#/chains resolves to the overview`);
  ok(state.overview && !state.hero, `${name}: choice page is visible without the default tool`);
  ok(state.active === 'Overview', `${name}: Overview is marked active`);
  ok(state.tabs.join('|') === 'Overview|Private balance|BTC ⇄ ETH|TAC bridge|Fast TAC|Bitcoin notes', `${name}: task-based navigation is complete`);
  ok(JSON.stringify(state.cards) === JSON.stringify([
    ['Use a private balance', '/#/chains/move'], ['Swap BTC and ETH', '/btc/'],
    ['Move TAC across chains', '/#/chains/bridge'], ['Move TAC faster', '/fast/']
  ]), `${name}: four outcome cards preserve their destinations`);
  ok(/Trustless.+both directions.+Takes longer/i.test(state.compare) && /minutes.+Bitcoin → Ethereum only.+fee and limit/i.test(state.compare), `${name}: standard and fast routes explain their tradeoffs`);
  ok(state.notes === '/tac/?v=notes#bridge', `${name}: note management remains one click away`);
  ok(state.overflow <= 0, `${name}: no horizontal overflow`);
  if (width < 640) {
    ok(state.tabRows === 2, `${name}: six navigation choices form two readable rows`);
    ok(state.cardColumns === 1, `${name}: outcome cards stack in one column`);
  } else {
    ok(state.cardColumns === 2, `${name}: outcome cards use a scannable two-column grid`);
  }
  ok(errors.length === 0, `${name}: no page or CSP errors${errors.length ? ` (${errors.join(' | ')})` : ''}`);

  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `chains-${name}.png`), fullPage: true }); }
  await page.click('#sec-head .sh-t a[href="/#/chains/move"]');
  await page.waitForFunction(() => document.documentElement.dataset.sec === 'chains/move');
  const moved = await page.evaluate(() => ({ hash: location.hash, active: document.querySelector('#sec-head .sh-t a[aria-current="page"]')?.textContent.trim(), overview: getComputedStyle(document.querySelector('#page-chains')).display }));
  ok(moved.hash === '#/chains/move' && moved.active === 'Private balance' && moved.overview === 'none', `${name}: a choice opens its existing tool and updates navigation`);
  await ctx.close();
}

try {
  await check(1280, 'desktop');
  await check(390, 'mobile');
  await check(1280, 'desktop-dark');
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
