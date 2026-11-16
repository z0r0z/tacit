#!/usr/bin/env node
// The front page's Activity row for a farm entry that did not go through (dapp/index.html, dapp/front/sheets.js): a deposit into a private farm from the Earn card is proved against
// the pool's exact reserves, so a trade that lands first ends the proof, and the row says the pool moved. It must offer a way on that works: Try again, a link that opens that farm and
// closes Activity (the row of an Earn-card entry has no sheet of its own, and its old button, Read my balance again, led nowhere), and an attempt the page proved again by itself is
// not listed beside the one that replaced it. Served from dapp/ with every other host refused.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/front-act-row.mjs       (DAPP=<dir> to load another copy of dapp/)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 32000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
let fails = 0;
const ok = (c, s) => { if (!c) fails++; console.log((c ? '  ok   ' : 'FAIL   ') + s); };

async function row({ program, retried = false, click = false }) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const now = Date.now();
  const items = [
    { id: 'job:aaa', kind: 'job', type: 'lpbond', label: 'Add tETH / TAC liquidity and farm it', status: 'failed', err: 'The pool moved while it was being proved. Nothing was spent: it is still in your private balance. Try again for a fresh quote.', at: now - 3600e3, up: now - 3500e3, end: now - 3500e3, pub: null, ...(retried ? { retried: true } : {}) },
  ];
  await ctx.addInitScript(({ items, program }) => {
    try {
      localStorage.setItem('tacit-lite-activity-v1', JSON.stringify({ items, cleared: 0 }));
      if (program) localStorage.setItem('tacit-lite-farm-program-v1', JSON.stringify(program));
    } catch {}
  }, { items, program });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#hx-swap #amt', { timeout: 40000 }).catch(() => {});
  await page.waitForSelector('#act', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => typeof document.querySelector('#act')?.onclick === 'function', null, { timeout: 40000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('#act')?.click());
  const got = await page.waitForSelector('#act-body .actr, #act-body .gate-p', { timeout: 25000 }).then(async () => page.evaluate(() => {
    const r = document.querySelector('#act-body .actr');
    if (!r) return { none: true, text: document.querySelector('#act-body')?.textContent.trim().slice(0, 80) };
    const a = r.querySelector('.brr-a a[data-link]'), b = r.querySelector('.brr-a button');
    return { text: r.querySelector('.actr-h')?.textContent.trim(), foot: [...r.querySelectorAll('.actr-f')].map((x) => x.textContent.trim()).join(' | '), link: a ? { href: a.getAttribute('href'), label: a.textContent.trim() } : null, button: b ? b.textContent.trim() : null };
  })).catch(async (e) => ({ timeout: String(e.message).slice(0, 60), act: await page.evaluate(() => ({ hasAct: !!document.querySelector('#act'), open: !!document.querySelector('#sheet-act')?.open, body: (document.querySelector('#act-body')?.innerHTML || '').slice(0, 200), errs: 0 })).catch(() => null), errors: errors.slice(0, 3) }));
  if (click && got.link) {
    await page.click('#act-body .brr-a a[data-link]');
    await page.waitForTimeout(1500);
    got.after = await page.evaluate(() => ({ farmOpen: !!document.querySelector('#sheet-farm')?.open, actOpen: !!document.querySelector('#sheet-act')?.open, hash: location.hash }));
  }
  await ctx.close();
  return { got, errors };
}

try {
  const program = { pools: [{ pid: 0, pair: 'TAC/cETH', poolId: '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', lpAsset: '0x17c5', feeBps: 30 }, { pid: 2, pair: 'cETH/cBTC', poolId: '0x83', lpAsset: '0x0a0c', feeBps: 30 }], epoch: { active: true } };
  const a = await row({ program, click: true });
  console.log(JSON.stringify(a.got));
  ok(a.got.link?.href === '#farm/private-0' && a.got.link?.label === 'Try again' && !a.got.button, 'a failed farm entry with the farm known offers Try again, a link to that farm');
  ok(a.got.after?.farmOpen === true && a.got.after?.actOpen === false && a.got.after?.hash === '#farm/private-0', 'pressing it opens that farm and closes Activity (' + JSON.stringify(a.got.after) + ')');
  ok(!a.errors.length, 'no page errors' + (a.errors.length ? ': ' + a.errors[0] : ''));
  const b = await row({ program: null });
  console.log(JSON.stringify(b.got));
  ok(!b.got.link && b.got.button === 'Read my balance again', 'with no farm program read yet it falls back to the old button');
  const c = await row({ program, retried: true });
  console.log(JSON.stringify(c.got));
  ok(c.got.none === true, 'an attempt that was proved again is not listed');
} finally { await browser.close(); server.close(); }
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
