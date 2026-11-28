#!/usr/bin/env node
// The Bridge section's overview: every way between the chains by direction, each coin with its routes. Exercise its
// routing, tabs and narrow-screen layout with the real built page offline.

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
    const dirs = [...document.querySelectorAll('#page-chains .cpg-dir')];
    const tabTops = tabs.map((e) => Math.round(e.getBoundingClientRect().top));
    return {
      sec: document.documentElement.dataset.sec,
      hash: location.hash,
      overview: visible('#page-chains'), hero: visible('.hero'),
      active: document.querySelector('#sec-head .sh-t a[aria-current="page"]')?.textContent.trim(),
      tabs: tabs.map((e) => e.textContent.trim()),
      tabRows: new Set(tabTops).size,
      dirs: dirs.map((d) => [d.querySelector('h2')?.textContent.replace('→', '').trim(), [...d.querySelectorAll('a')].map((a) => a.dataset.br ? `br:${a.dataset.br}` : a.getAttribute('href')).join(' ')]),
      dirColumns: new Set(dirs.map((d) => Math.round(d.getBoundingClientRect().left))).size,
      notes: document.querySelector('.cpg-note a')?.getAttribute('href'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  ok(state.sec === 'chains/overview' && state.hash === '#/chains/overview', `${name}: /#/chains resolves to the overview`);
  ok(state.overview && !state.hero, `${name}: the overview shows without the default tool`);
  ok(state.active === 'Overview', `${name}: Overview is marked active`);
  ok(state.tabs.join('|') === 'Overview|Bitcoin ⇄ Ethereum|BTC ⇄ ETH swap|Bitcoin notes', `${name}: four tabs (${state.tabs.join('|')})`);
  ok(JSON.stringify(state.dirs) === JSON.stringify([
    ['Bitcoin to Ethereum', '/btc/ br:btc /fast/ br:tb br:kb br:ub br:ut'],
    ['Ethereum to Bitcoin', '/btc/?dir=e2b br:tac br:eth br:cbtc br:cusd br:cusdt']
  ]), `${name}: two directions, each coin with its routes (${JSON.stringify(state.dirs)})`);
  ok(state.notes === '/tac/?v=notes#bridge', `${name}: note management remains one click away`);
  ok(state.overflow <= 0, `${name}: no horizontal overflow`);
  if (width < 640) {
    ok(state.tabRows === 1, `${name}: the tabs are one row (it scrolls sideways)`);
    ok(state.dirColumns === 1, `${name}: the two directions stack`);
  } else {
    ok(state.dirColumns === 2, `${name}: the two directions sit side by side`);
  }
  ok(errors.length === 0, `${name}: no page or CSP errors${errors.length ? ` (${errors.join(' | ')})` : ''}`);

  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `chains-${name}.png`), fullPage: true }); }
  // a coin's row opens the Bitcoin ⇄ Ethereum view on that coin
  await page.click('#page-chains .cpg-chip[data-br="tb"]');
  await page.waitForFunction(() => document.documentElement.dataset.sec === 'chains/bridge');
  await page.waitForFunction(() => document.querySelector('#hx-from')?.value === 'tb', null, { timeout: 15000 }).catch(() => {});
  const moved = await page.evaluate(() => ({ hash: location.hash, active: document.querySelector('#sec-head .sh-t a[aria-current="page"]')?.textContent.trim(), overview: getComputedStyle(document.querySelector('#page-chains')).display, from: document.querySelector('#hx-from')?.value }));
  ok(moved.hash === '#/chains/bridge' && moved.active === 'Bitcoin ⇄ Ethereum' && moved.overview === 'none' && moved.from === 'tb', `${name}: tETH from Bitcoin opens the bridge on tETH from Bitcoin (${JSON.stringify(moved)})`);
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
