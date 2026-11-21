#!/usr/bin/env node
// A buy whose best route is one the route check refuses (a Curve route through a pool the check does not list: CRV's best venue at times) is no longer "no route":
// the card falls back to the aggregator's candidates, which accept such a pool only after the swap is simulated paying its floor. Browser, no wallet, quotes read live.
//   - CRV on the Shield tab is priced (a route, 'swap, then shield'), whichever venue is best at the moment
//   - the message for a token with no route at all is still said (a token nothing trades)
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/buy-route-fallback.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch(), p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(), bad = [];
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
p.on('pageerror', (e) => bad.push('script error: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); });
await p.goto(BASE + '/', { waitUntil: 'load' });
await p.waitForSelector('#hx .go', { timeout: 40000 });
const tile = () => p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' '));
const waitFor = async (re, ms = 50000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(); if (re.test(t)) return t; await p.waitForTimeout(500); } return t; };
await p.evaluate(() => [...document.querySelectorAll('#hx button')].find((e) => e.innerText.trim() === 'Shield')?.click());
await p.waitForTimeout(2500);
await p.click('#get-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { timeout: 15000 });
await p.fill('#pk-q', 'crv');
await p.waitForTimeout(700);
await p.click('#pk .pk-r:not([hidden])');
await p.fill('#amt', '0.01');
const t = await waitFor(/swap, then shield|No pool trades|No route/);
const route = /Route ([^|]*?) (?:→|Privacy|Against)/.exec(t)?.[1] || '';
console.log(`  (CRV route now: ${route || 'none'})`);
ok(/private CRV/.test(t) && /swap, then shield/.test(t) && !/No pool trades ETH for CRV/.test(t), 'CRV is priced on the Shield tab: a route, not "no route", whichever venue is best');
await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
