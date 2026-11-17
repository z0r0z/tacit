#!/usr/bin/env node
// What the browser's layout-shift log holds for /pay/eth/ as it loads, in a real browser under the page's own CSP, at a phone and a desktop and at the taller screens of each:
//   · the cards under the form (Activity, TAC points, Proved on this device), the links and the footer sit below the room the form reserves, which the page's first render closes by about 540px:
//     they stay out of sight until that render (html:not(.up)), so on a tall screen they are not seen to jump up into view (the log held 0.013 at 1280x900, 0.036 at 1280x1080 and 0.045 at
//     390x932 for it); while they are visible they are in one place;
//   · the two Instrument Serif faces the hero's heading is set in are preloaded, so the heading does not shift a sub-pixel when they arrive; the log's whole total stays under 0.001;
//   · with scripts off the cards still come: they show after 2.5 s, and are not there at half a second;
//   · a visitor arriving with a wallet connected has the header's chip widen (the one movement left, checked by wallet-restore.mjs) and nothing under it move.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/pay-eth-no-shift.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname, WEB = 27300 + Math.floor(Math.random() * 90);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const A = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const WALLET = `(() => { localStorage.setItem('stub-allowed-main', '1'); localStorage.setItem('tacit-trade-wallet', 'test.wallet');
  const provider = { async request({ method }) { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${A}']; if (method === 'eth_chainId') return '0x1'; if (method === 'eth_getCode') return '0x'; throw Object.assign(new Error('stub'), { code: -32601 }); }, on() {}, removeListener() {} };
  window.ethereum = provider;
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'main', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', say); say(); })();`;
// the log's entries (what shifted, by how much) and, every frame, whether the Activity card shows and where it is
const RECORD = () => {
  window.__ls = [];
  const name = (n) => { const e = n?.nodeType === 3 ? n.parentElement : n; return e ? (e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : '')) : '?'; };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ls.push({ v: e.value, input: e.hadRecentInput, src: (e.sources || []).map((s) => name(s.node)) }); }).observe({ type: 'layout-shift', buffered: true });
  window.__fr = [];
  const f = () => { const r = document.querySelector('#recover'); if (r) window.__fr.push([getComputedStyle(r).visibility, Math.round(r.getBoundingClientRect().top * 10) / 10]); requestAnimationFrame(f); };
  requestAnimationFrame(f);
};

const browser = await chromium.launch();
async function open({ width, height, connected = false, js = true }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'light', javaScriptEnabled: js });
  if (js) { if (connected) await ctx.addInitScript(WALLET); await ctx.addInitScript(RECORD); }
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1|localhost)/, (ws) => ws.close());
  await ctx.route('http://127.0.0.1:47815/**', (r) => r.abort('connectionrefused'));
  const page = await ctx.newPage(), pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${WEB}${connected ? '/pay/' : '/pay/eth/'}`);
  return { ctx, page, pageErrors };
}
const BELOW = /^#(recover|points|device)$|^nav\.sf-x$|^footer/;

try {
  for (const [width, height] of [[390, 844], [390, 932], [1280, 900], [1280, 1080]]) {
    for (const connected of [false, true]) {
      if (connected && height !== 932 && height !== 1080) continue;
      const who = `${width}x${height}, ${connected ? 'a wallet connected' : 'signed out'}`;
      const { ctx, page, pageErrors } = await open({ width, height, connected });
      await page.waitForFunction(() => document.documentElement.classList.contains('up') && location.pathname === '/pay/eth/', null, { timeout: 30000 });
      await page.waitForTimeout(1800);
      const ls = (await page.evaluate(() => window.__ls)).filter((e) => !e.input), fr = await page.evaluate(() => window.__fr);
      const total = ls.reduce((a, e) => a + e.v, 0), below = ls.filter((e) => e.src.some((s) => BELOW.test(s)));
      const tops = [...new Set(fr.filter((f) => f[0] === 'visible').map((f) => f[1]))];
      ok(below.length === 0, `${who}: nothing under the form is in the layout-shift log${below.length ? ` (${below.map((e) => e.src.join('+') + ' ' + e.v.toFixed(4)).join(', ')})` : ''}`);
      ok(total <= (connected ? 0.002 : 0.001), `${who}: the log's whole total is ${total.toFixed(4)}${connected ? ' (the chip widening is most of it)' : ''}`);
      ok(tops.length === 1, `${who}: while the Activity card shows it is in one place (${tops.join('px, ')}px, ${fr.filter((f) => f[0] === 'visible').length} of ${fr.length} frames)`);
      ok(!pageErrors.length, `${who}: no page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);
      await ctx.close();
    }
  }

  // the heading's two faces are preloaded
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    const links = await page.$$eval('link[rel="preload"][as="font"]', (ls) => ls.map((l) => l.getAttribute('href')));
    ok(links.includes('/fonts/instrument-serif-400-latin.woff2') && links.includes('/fonts/instrument-serif-400i-latin.woff2'), `the heading's regular and italic faces are preloaded (${links.join(', ')})`);
    await ctx.close();
  }

  // with scripts off the cards come late rather than never
  {
    const { ctx, page } = await open({ width: 390, height: 844, js: false });
    await page.waitForTimeout(500);
    const early = await page.$eval('#recover', (e) => getComputedStyle(e).visibility);
    await page.waitForTimeout(2700);
    const late = await page.$eval('#recover', (e) => getComputedStyle(e).visibility);
    ok(early === 'hidden' && late === 'visible', `with scripts off the Activity card is ${early} at half a second and ${late} after three`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
