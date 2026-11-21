#!/usr/bin/env node
// The readable fragment links: #shield/eth/imd?amt=0.001, #shield/<token>, #earn/eth/p0?amt=0.05[&lp=1], #earn/eth/imd, and the older #card=… forms, which keep working.
//   - Shield: ETH buys a token by symbol or by address (the same card), a token by symbol with an unknown one doing nothing harmful
//   - Earn: a farm by its number (the TAC / tETH farm as a zap, with &lp=1 as liquidity alone), a token by symbol or address (its tETH row)
//   - the Earn tile's copy link is the readable form, and opening it lands on the same card
//   - the older #card=shield:ether:0x…, #card=earn:ether:p0 and #card=earn:ether:0x… links still open the same cards
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/readable-links.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const IMD = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7', AAVE = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';
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
async function open(hash, wait, ms = 50000) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }), p = await ctx.newPage();
  p.on('pageerror', (e) => bad.push('script error: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); });
  await p.goto(BASE + '/' + hash, { waitUntil: 'load' });
  await p.waitForSelector('#hx .go', { timeout: 40000 });
  const t0 = Date.now(); let t = '';
  while (Date.now() - t0 < ms) { t = await p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' ')); if (wait.test(t)) break; await p.waitForTimeout(500); }
  return { p, t, amt: await p.evaluate(() => document.querySelector('#amt, #hx-amt')?.value) };
}

// ── Shield ──
let r = await open(`#shield/eth/imd?amt=0.001`, /swap, then shield/i);
ok(/private IMD/.test(r.t) && r.amt === '0.001', '#shield/eth/imd?amt=0.001: ETH buys IMD (by symbol), the amount filled');
await r.p.close();
r = await open(`#shield/eth/${IMD}?amt=0.002`, /swap, then shield/i);
ok(/private IMD/.test(r.t) && r.amt === '0.002', '#shield/eth/<address>?amt=0.002: the same card by address');
ok((await r.p.evaluate(() => location.hash)) === '#shield/eth/imd?amt=0.002', 'and the address bar then shows the readable symbol form');
await r.p.close();
r = await open(`#card=shield:ether:${IMD}&amt=0.001`, /swap, then shield/i);
ok(/private IMD/.test(r.t) && r.amt === '0.001', 'the older #card=shield:ether:<address> link still opens it');
await r.p.close();
r = await open(`#shield/eth/nosuchtokenxyz?amt=0.001`, /Shield ETH|Connect wallet/);
ok(/Shield ETH|Connect wallet/.test(r.t) && !/private nosuch/i.test(r.t), 'an unknown symbol leaves the default Shield card (no crash)');
await r.p.close();
r = await open(`#shield/eth?amt=0.002`, /Shield ETH/);
ok(/To DeFi pool 0\.002 ETH/.test(r.t), '#shield/eth?amt=0.002: the plain ETH shield with the amount');
await r.p.close();

// ── Earn ──
r = await open(`#earn/eth/p0?amt=0.05`, /tETH \/ TAC/);
ok(/tETH \/ TAC/.test(r.t) && r.amt === '0.05' && /Zap into the farm/.test(r.t), '#earn/eth/p0?amt=0.05: Earn on the TAC / tETH farm, as a zap into the farm, the amount filled');
await r.p.click('#hx-copy').catch(() => {});
await r.p.waitForTimeout(500);
const copied = await r.p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
ok(copied === `${BASE}/#earn/eth/p0?amt=0.05`, `the Earn tile's copy link is the readable form (${copied.slice(0, 80)})`);
await r.p.close();
r = await open(`#earn/eth/p0?amt=0.05&lp=1`, /Add as private LP/);
ok(/tETH \/ TAC/.test(r.t) && /Add as private LP/.test(r.t) && !/Zap into the farm/.test(r.t), '&lp=1 opens it as liquidity alone');
await r.p.close();
r = await open(`#earn/eth/aave?amt=0.01`, /tETH \/ AAVE/);
ok(/tETH \/ AAVE/.test(r.t) && r.amt === '0.01', '#earn/eth/aave?amt=0.01: a token\'s tETH row, by symbol');
await r.p.close();
r = await open(`#earn/eth/${AAVE}?amt=0.01`, /tETH \/ AAVE/);
ok(/tETH \/ AAVE/.test(r.t) && r.amt === '0.01', 'and by address');
await r.p.close();
r = await open(`#earn/aave?amt=0.01`, /tETH \/ AAVE/);
ok(/tETH \/ AAVE/.test(r.t), '#earn/aave: with no source, ETH is the source');
await r.p.close();
r = await open(`#card=earn:ether:p0&amt=0.05`, /tETH \/ TAC/);
ok(/tETH \/ TAC/.test(r.t) && r.amt === '0.05', 'the older #card=earn:ether:p0 link still opens it');
await r.p.close();
r = await open(`#card=earn:ether:${AAVE}&amt=0.01`, /tETH \/ AAVE/);
ok(/tETH \/ AAVE/.test(r.t), 'and #card=earn:ether:<address>');
await r.p.close();

await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
