#!/usr/bin/env node
// What keeps the front page's tile from staying a skeleton for good (dapp/index.html, dapp/front-guard.js, dapp/storage-fallback.js). The tile is drawn by the page's one
// module, which starts only when every file it imports has arrived, and which runs on whatever the browser lets it read; so each of these ended in a skeleton, with nothing said:
//   1. a browser that refuses storage (reading window.localStorage throws there): the module died on its first read of it, before it drew the tile;
//   2. every other host never answering: the tile must not wait on one (nothing it draws needs an answer), and takes an amount at once;
//   3. a file of the module that fails to load (a dropped connection): the module never starts. The page reloads itself once; if the file fails again it says so, with the
//      reload, and does not reload by itself a second time;
//   4. a file that never answers: after the limit (12 s, served here as 1.5) the page says it is slow, with the reload, and the line goes when the tile is drawn.
// Nothing leaves the machine: the page is served from dapp/ and every request to another host is refused or held.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/front-boot.mjs       (DAPP=<dir> to load another copy of dapp/: the cases fail on one from before the fix)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 31000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TILE = '#hx-swap #amt', LINE = '.hx-say';
const GUARD = existsSync(join(DAPP, 'front-guard.js')) ? readFileSync(join(DAPP, 'front-guard.js'), 'utf8') : '';
const BOOT_FILE = /\/activity\.js(\?|$)/;      // a file the page's module imports (and the head preloads)

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
// One fresh browser context (no cache, no storage, no service worker), with the failures each case asks for.
async function open({ refuseStorage = false, holdOthers = false, drop = null, stall = null, limit = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const s = { ctx, errors: [], navs: 0, held: [], dropped: 0 };
  if (refuseStorage) await ctx.addInitScript(() => {
    const refuse = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(window, k, { get: refuse, configurable: true });
  });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (!u.startsWith(BASE)) return holdOthers ? undefined : r.abort();       // held: never answered
    if (limit && /\/front-guard\.js(\?|$)/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: GUARD.replace(/LIMIT = \d+/, `LIMIT = ${limit}`) });
    if (drop && drop.test(u) && (s.max == null || s.dropped++ < s.max)) return r.abort('connectionreset');
    if (stall && stall.test(u)) { s.held.push(r); return; }
    return r.continue();
  });
  s.page = await ctx.newPage();
  s.page.on('pageerror', (e) => s.errors.push(String(e.message || e)));
  s.page.on('framenavigated', (f) => { if (f === s.page.mainFrame()) s.navs++; });
  return s;
}
const go = (s) => s.page.goto(BASE + '/', { waitUntil: 'commit' });
const drawn = (s, t = 30000) => s.page.waitForSelector(TILE, { timeout: t });
const skeleton = (s) => s.page.evaluate(() => !!document.querySelector('#hx-body > .hx-sk'));
const line = (s) => s.page.evaluate((sel) => { const e = document.querySelector(sel); return e ? { text: e.querySelector('span')?.textContent, button: e.querySelector('button')?.textContent, role: e.getAttribute('role') } : null; }, LINE);

try {
  // the limit is a constant of the guard, and a quiet page never reaches it
  const limit = Number(/LIMIT = (\d+)/.exec(GUARD)?.[1]);
  ok(limit >= 8000 && limit <= 20000, `the guard waits ${limit / 1000} s for the tile (long enough for a slow link, short enough to be said while someone still watches)`);

  // a load with nothing wrong: the tile is drawn, nothing is said, the page is not reloaded
  {
    const s = await open(); await go(s); await drawn(s); await sleep(600);
    ok(!(await skeleton(s)) && !(await line(s)) && s.navs === 1 && !s.errors.length, `a normal load draws the tile, says nothing and does not reload${s.errors.length ? ': ' + s.errors[0] : ''}`);
    await s.ctx.close();
  }

  // 1. storage refused
  {
    const s = await open({ refuseStorage: true }); await go(s);
    const up = await drawn(s, 15000).then(() => true, () => false);
    ok(up && !(await skeleton(s)), 'a browser that refuses storage still gets the tile (the module no longer dies on its first read of it)');
    if (up) {
      const kept = await s.page.evaluate(() => { localStorage.setItem('probe', '1'); sessionStorage.setItem('probe', '2'); return [localStorage.getItem('probe'), sessionStorage.getItem('probe')].join(); });
      ok(kept === '1,2', 'and what the page saves is kept in memory for the visit');
    }
    ok(!s.errors.length, `with no error in the page${s.errors.length ? ': ' + s.errors.slice(0, 2).join(' | ') : ''}`);
    await s.ctx.close();
  }

  // 2. no other host is waited on
  {
    const s = await open({ holdOthers: true }); await go(s);
    const up = await drawn(s, 15000).then(() => true, () => false);
    ok(up && !(await skeleton(s)), 'with every other host never answering, the tile is still drawn (nothing it draws waits on an answer)');
    if (up) { await s.page.fill(TILE, '0.1'); ok((await s.page.inputValue(TILE)) === '0.1', 'and takes an amount'); }
    ok(!s.errors.length && !(await line(s)), `with no error and nothing said${s.errors.length ? ': ' + s.errors.slice(0, 2).join(' | ') : ''}`);
    await s.ctx.close();
  }

  // 3. a file of the module fails to load
  {
    const s = await open({ drop: BOOT_FILE }); s.max = 1; await go(s);            // dropped once
    const up = await drawn(s, 30000).then(() => true, () => false);
    const type = up ? await s.page.evaluate(() => performance.getEntriesByType('navigation')[0].type) : null;
    ok(up && s.navs === 2 && type === 'reload', `a file that fails once reloads the page once, and the tile is drawn (${s.navs} loads, the last a ${type})`);
    ok(!(await line(s)) && !(await skeleton(s)), 'with nothing said');
    await s.ctx.close();
  }
  {
    const s = await open({ drop: BOOT_FILE }); await go(s);                       // dropped every time
    const said = await s.page.waitForSelector(LINE, { timeout: 30000 }).then(() => true, () => false);
    await sleep(2500);
    const l = said ? await line(s) : null;
    ok(said && l.text === 'Could not load the page.' && l.button === 'Reload' && l.role === 'status', `a file that keeps failing is said, with the reload${l ? ` ("${l.text}" ${l.button})` : ''}`);
    ok(s.navs === 2 && (await skeleton(s)), `and the page does not reload itself again (${s.navs} loads; the skeleton is as it was)`);
    const again = said && await s.page.click(`${LINE} button`, { timeout: 5000 }).then(() => s.page.waitForSelector(LINE, { timeout: 30000 })).then(() => true, () => false);
    ok(again && s.navs === 3, 'the reload the person presses is a reload (and is not turned into another by the page)');
    await s.ctx.close();
  }
  {
    // a browser that does not say how a page was loaded (Safari before 15 has no navigation entry): the page cannot tell it has already reloaded, so it never reloads by itself
    const s = await open({ drop: BOOT_FILE });
    await s.ctx.addInitScript(() => { const entries = performance.getEntriesByType.bind(performance); performance.getEntriesByType = (t) => (t === 'navigation' ? [] : entries(t)); });
    await go(s);
    const said = await s.page.waitForSelector(LINE, { timeout: 30000 }).then(() => true, () => false);
    await sleep(2500);
    ok(said && s.navs === 1, `a browser that does not report its navigation type is told, and is not reloaded in circles (${s.navs} load${s.navs === 1 ? '' : 's'})`);
    await s.ctx.close();
  }

  // 4. a file never answers: said after the limit, and gone when the tile is drawn
  {
    const s = await open({ stall: BOOT_FILE, limit: 1500 }); await go(s);
    const said = await s.page.waitForSelector(LINE, { timeout: 15000 }).then(() => true, () => false);
    const l = said ? await line(s) : null;
    ok(said && l.text === 'Taking longer than usual.' && l.button === 'Reload', `a skeleton still up at the limit says so, with the reload${l ? ` ("${l.text}")` : ''}`);
    ok(s.navs === 1 && (await skeleton(s)), 'and the page is not reloaded on its own (it may only be slow)');
    for (const r of s.held) r.continue().catch(() => {});
    const up = await drawn(s, 30000).then(() => true, () => false);
    ok(up && !(await skeleton(s)) && !(await line(s)), 'when the file arrives the tile is drawn and the line goes with the skeleton');
    ok(!s.errors.length, `with no error in the page${s.errors.length ? ': ' + s.errors.slice(0, 2).join(' | ') : ''}`);
    await s.ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${n} front-boot checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
