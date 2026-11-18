#!/usr/bin/env node
// The Shield tab's ETH buy (ETH -> a token, bought and shielded in one go) has its own link: #card=shield:ether:<token address>&amt=<ETH>.
//   - opening it puts the card on the Shield tab, ETH to that token, the amount filled, priced as a buy ("swap, then shield")
//   - the card shows a copy button, and the address bar carries the same link while the buy is on the card (it follows the amount and the token)
//   - the button copies exactly that link, and opening the copied link again lands on the same card
//   - with ETH picked as the To coin again (the plain shield) the link is gone from the address bar and the button is hidden
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/shield-buy-link.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const IMD = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7', PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
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
const b = await chromium.launch(), bad = [];
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
async function fresh() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }), p = await ctx.newPage();
  p.on('pageerror', (e) => bad.push('script error: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); });
  return p;
}
const tile = (p) => p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' '));
const waitFor = async (p, re, ms = 45000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(p); if (re.test(t)) return t; await p.waitForTimeout(500); } return t; };
const copyShown = (p) => p.evaluate(() => { const c = document.querySelector('#copy'); return !!c && !c.hidden && c.offsetParent !== null; });

const p = await fresh();
await p.goto(`${BASE}/#card=shield:ether:${IMD}&amt=0.001`, { waitUntil: 'load' });
await p.waitForSelector('#hx .go', { timeout: 40000 });
let t = await waitFor(p, /swap, then shield/i);
ok(/To DeFi pool/.test(t) && /IMD/.test(t) && /private IMD/.test(t) && /swap, then shield/i.test(t), 'the link opens the Shield tab on ETH to IMD, priced as a buy: "swap, then shield"');
ok((await p.evaluate(() => document.querySelector('#amt')?.value)) === '0.001', 'the amount from the link, 0.001 ETH, is filled in');
ok(await copyShown(p), 'the card shows a copy button');
await p.waitForTimeout(1500);
const want = `#card=shield:ether:${IMD}&amt=0.001`;
ok((await p.evaluate(() => location.hash)) === want, `the address bar carries the link (${await p.evaluate(() => location.hash)})`);

// the button copies that link
await p.click('#copy');
await p.waitForTimeout(600);
const copied = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
ok(copied === `${BASE}/${want}`, `the button copies exactly the link (${copied.slice(0, 90)}…)`);

// the amount and the token move the link
await p.fill('#amt', '0.0025');
await p.waitForTimeout(1500);
ok((await p.evaluate(() => location.hash)) === `#card=shield:ether:${IMD}&amt=0.0025`, 'a new amount is in the address bar');
await p.click('#get-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { state: 'attached', timeout: 15000 });
await p.fill('#pk-q', 'pepe');
await p.waitForTimeout(800);
await p.click('#pk .pk-r:not([hidden])');
await waitFor(p, /private PEPE/);
await p.waitForTimeout(1500);
ok((await p.evaluate(() => location.hash)) === `#card=shield:ether:${PEPE}&amt=0.0025`, 'another token is in the address bar');

// the copied link opens the same card
const q = await fresh();
await q.goto(copied.replace(IMD, IMD).replace(/&amt=.*/, '&amt=0.001'), { waitUntil: 'load' });
await q.waitForSelector('#hx .go', { timeout: 40000 });
t = await waitFor(q, /private IMD/);
ok(/private IMD/.test(t) && (await q.evaluate(() => document.querySelector('#amt')?.value)) === '0.001', 'opening the copied link lands on the same card');

// ETH as the To coin again: the plain shield, no link
await p.click('#get-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { state: 'attached', timeout: 15000 });
await p.click('#pk .pk-r[data-k="0x0000000000000000000000000000000000000000"]');
await waitFor(p, /To DeFi pool [\d.]+ ETH/);
await p.waitForTimeout(1500);
ok(!(await p.evaluate(() => location.hash)).startsWith('#card=shield:ether:0x') && !(await copyShown(p)), 'with ETH picked again (the plain shield) the link is off the address bar and the button is hidden');

await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
