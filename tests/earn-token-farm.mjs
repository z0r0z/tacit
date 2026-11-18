#!/usr/bin/env node
// The front page's Earn tab, paid in ETH: a token's own farm (the tETH / SPX stream) is offered on every page, not only /spx/. The zap buys the token's leg where it is cheaper
// (xtAddPlan: the pool's price or the open market, whichever gives the deposit more) and puts the share in the farm. Browser, no wallet; the pool and farm program are read live.
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/earn-token-farm.mjs
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
const waitFor = async (re, ms = 40000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(); if (re.test(t)) return t; await p.waitForTimeout(500); } return t; };
await p.evaluate(() => [...document.querySelectorAll('#hx button')].find((e) => e.innerText.trim() === 'Earn')?.click());
await p.waitForTimeout(2000);
await p.fill('#hx-amt, #amt', '0.05');
const t = await waitFor(/tETH \/ SPX/);
ok(/tETH \/ SPX\s+private/.test(t), 'the front page offers the tETH / SPX farm to an ETH source');
ok(/Zap into the farm/.test(t) && /on the open market, then both go in|swapped in the pool, then both go in/.test(t), 'it is a zap into the farm, and says where the token leg comes from');
ok(/You hold private tETH \/ SPX liquidity, in the farm/.test(t) && /TAC streams to it/.test(t), 'the share goes in the farm and its stream is shown');
ok(!(await p.evaluate(() => document.documentElement.dataset.page)), 'on the front page itself, not the SPX page');
await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
