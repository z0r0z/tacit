#!/usr/bin/env node
// dapp/sw.js and the registration in dapp/chrome.js, in a real browser. A versioned file (?cb=<first eight hex digits of its sha-256>) is kept
// once its bytes match its token and is then answered from disk; a token that does not match is passed through and never kept; everything the
// worker keeps matches its token; and on a repeat visit the server is asked for the page and for files with no token, and for no versioned file.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/sw-tokened.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const PORT = 27000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let hits = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.set(u.pathname + u.search, (hits.get(u.pathname + u.search) || 0) + 1);
  let f = join(DAPP, decodeURIComponent(u.pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=0' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokened = (k) => /\?cb=[0-9a-f]{8}$/.test(k) && /\.(js|css)\?/.test(k);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await ctx.route('https://**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await ctx.addInitScript(() => { window.__tacitSw = true; });      // under automation the worker is registered only when a test asks
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // under automation, with no ask, a page does not register it
  const quiet = await browser.newContext();
  const qp = await quiet.newPage();
  await qp.goto(`http://127.0.0.1:${PORT}/bridge/`, { waitUntil: 'load' }); await sleep(2500);
  ok(await qp.evaluate(() => navigator.webdriver === true) && await qp.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 0), 'under browser automation a page does not register the worker unless a test asks');
  await quiet.close();

  // the first visit registers the worker (a moment after load) and it takes the page over
  await page.goto(`http://127.0.0.1:${PORT}/bridge/`, { waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => {});
  ok(await page.evaluate(() => navigator.serviceWorker.controller !== null), 'the worker is registered from the page header and controls the page');
  ok(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.scope === location.origin + '/'), 'its scope is the whole site');

  // the second visit goes through the worker, which fetches and keeps each versioned file
  await page.reload({ waitUntil: 'load' }); await sleep(900);
  const keys = await page.evaluate(async () => (await (await caches.open('tacit-tokened-v2')).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search));
  ok(keys.length >= 3 && keys.every(tokened), `it kept the page's versioned files and only those (${keys.length}: ${keys.slice(0, 3).join(', ')}…)`);

  // every kept file's bytes match its token
  const bad = await page.evaluate(async () => {
    const out = [], cache = await caches.open('tacit-tokened-v2');
    for (const req of await cache.keys()) {
      const body = await (await cache.match(req)).arrayBuffer();
      const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body)).subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== new URL(req.url).searchParams.get('cb')) out.push(req.url);
    }
    return out;
  });
  ok(bad.length === 0, `every kept file matches its token (${bad.length} that did not)`);

  // the third visit: the server is asked for the page and the files with no token, and for no versioned file
  hits = new Map();
  await page.reload({ waitUntil: 'load' }); await sleep(600);
  const asked = [...hits.keys()];
  const versioned = asked.filter(tokened);
  ok(versioned.length === 0, `a repeat visit asks the server for no versioned file (${versioned.join(', ') || 'none'})`);
  ok(asked.some((k) => k === '/bridge/') && asked.some((k) => !tokened(k) && /\.js$/.test(k)), `and still asks for the page and for files with no token (${asked.length} requests)`);

  // a token that does not match is passed through and never kept
  hits = new Map();
  const r1 = await page.evaluate(async () => { const r = await fetch('/bridge/track.js?cb=00000000'); return { ok: r.ok, len: (await r.text()).length }; });
  await page.evaluate(() => fetch('/bridge/track.js?cb=00000000').then((r) => r.text()));
  await sleep(300);
  const after = await page.evaluate(async () => (await (await caches.open('tacit-tokened-v2')).keys()).map((r) => r.url));
  ok(r1.ok && r1.len > 1000, 'a file under a wrong token is still served');
  ok(!after.some((u) => u.includes('cb=00000000')) && hits.get('/bridge/track.js?cb=00000000') === 2, 'but it is not kept: the server is asked each time');

  // other things are not touched
  const other = await page.evaluate(async () => { const r = await fetch('/rpc-body.js'); return r.ok; });
  const keys2 = await page.evaluate(async () => (await (await caches.open('tacit-tokened-v2')).keys()).map((r) => r.url));
  ok(other && !keys2.some((u) => u.endsWith('/rpc-body.js')), 'a file with no token is left to the network');

  // the code files with no token ask the network first, and the kept copy answers only when the network cannot
  hits = new Map();
  const v1 = await page.evaluate(async () => (await fetch('/vendor/tacit-deps.min.js')).ok);
  const v2 = await page.evaluate(async () => (await fetch('/vendor/tacit-deps.min.js')).ok);
  await sleep(300);
  ok(v1 && v2 && hits.get('/vendor/tacit-deps.min.js') === 2, 'the vendor bundle is asked of the network each time, so it can never be older than the modules beside it');
  await ctx.setOffline(true);
  const off = await page.evaluate(async () => { try { const r = await fetch('/vendor/tacit-deps.min.js'); return r.ok && (await r.arrayBuffer()).byteLength > 10000; } catch { return false; } });
  await ctx.setOffline(false);
  ok(off, 'and offline it is answered from the kept copy');

  // a page that wears the header on another path takes the same worker
  const p2 = await ctx.newPage();
  await p2.goto(`http://127.0.0.1:${PORT}/swap/`, { waitUntil: 'load' }); await sleep(300);
  ok(await p2.evaluate(() => navigator.serviceWorker.controller !== null), 'another page under the header is controlled by the same worker');
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ').slice(0, 300) : ''}`);
  await ctx.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e));
}
await browser.close(); server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
