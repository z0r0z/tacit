#!/usr/bin/env node
// A private swap too small for the relay's fee can be sent from the person's own account: the relay proves it (free) and charges no fee, the page sends the settle, and the network fee is theirs.
// The Swap card, tETH -> TAC privately (a visitor: the quote only, nothing is pressed):
//   - 0.0005 tETH: "Amount too small ... the relay's fee is ...", with a button to send it from one's own account
//   - the button prices the swap with no relay fee and says so ("Settle: from your account"), with a way back ("Use the relay")
//   - going back is the "too small" answer again
//   - 0.003 tETH (the fee is a big share): the swap is priced, and the row offers the same choice
//   - a large swap (the fee is a small share): no offer, the relay as before
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/swap-self-settle.mjs
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
const b = await chromium.launch(), bad = [];
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
async function open(amt) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  p.on('pageerror', (e) => bad.push('script error: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); });
  await p.goto(`${BASE}/?from=teth&to=TAC&private=both&amt=${amt}`, { waitUntil: 'load' });
  await p.waitForSelector('#hx .go', { timeout: 40000 });
  return p;
}
const tile = (p) => p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' '));
const waitFor = async (p, re, ms = 45000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(p); if (re.test(t)) return t; await p.waitForTimeout(500); } return t; };
const has = (p, sel) => p.evaluate((s) => !!document.querySelector(s), sel);

// tiny
let p = await open('0.0005');
let t = await waitFor(p, /Amount too small|Route/);
ok(/Amount too small/.test(t) && /the relay’s fee is/.test(t) && await has(p, '#pv-self-on'), '0.0005 tETH: too small for the relay, with a button to send it from one\'s own account');
await p.click('#pv-self-on');
t = await waitFor(p, /Settle from your account/);
ok(/Route Tacit pool/.test(t) && /Settle from your account: no relay fee, the network fee is yours/.test(t) && !/Amount too small/.test(t), 'the button prices the swap with no relay fee, and the Settle row says so');
ok(!/Relay fee/.test(t) && await has(p, '#pv-self-off'), 'no relay fee is shown, and there is a way back');
await p.click('#pv-self-off');
t = await waitFor(p, /Amount too small/);
ok(/Amount too small/.test(t) && await has(p, '#pv-self-on'), '"Use the relay" is the too-small answer again');
await p.context().close();

// the fee is a big share
p = await open('0.003');
t = await waitFor(p, /Route/);
ok(/Route/.test(t) && /Settle the relay’s fee is a big share of this/.test(t) && await has(p, '#pv-self-on'), '0.003 tETH: priced, and the row offers to skip the relay\'s fee');
await p.context().close();

// the fee is a small share
p = await open('0.2');
t = await waitFor(p, /Route/);
ok(/Route/.test(t) && !/Settle /.test(t) && !(await has(p, '#pv-self-on')), '0.2 tETH: the relay as before, no offer');
await p.context().close();

await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
