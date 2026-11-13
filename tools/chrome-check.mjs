#!/usr/bin/env node
// Checks the header's page menu and the footer that every page wears (build/chrome.mjs) in a real browser, with nothing reaching a live
// service and no fork needed:
//   menu     the pages a holder goes to, in order, with no divider; Assets, Rewards and Prove beside it in a wide header and first in it on a phone
//   footer   icons for the places outside the app, Build and Stats among them, and the whole row on the page down to a 320 px phone
//   here     the page you are on is marked in the menu; the Tacit chain has no entry of its own, and its old address goes on to TAC's page
//   PLAYWRIGHT=<path to playwright-core> node tools/chrome-check.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const WEB = 8890 + Math.floor(Math.random() * 90);
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let failed = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${extra ? ` (${extra})` : ''}`); if (!c) failed++; };

const HEADER = 'Assets:/assets/ Rewards:/rewards/ Prove:/prove/';
const MENU = 'Portfolio:/#portfolio Pay:/pay/ Borrow:/vault/ Bridges:/bridge/ TAC:/tac/ Etch:/etch/ Tasks:/tasks/ FACE:/face/';
const FOOTER = 'Whitepaper | Build | Security | Source | Pool contract | Stats | DefiLlama | Listed on ETHBeat | @tacitfi on X | Tacit Discord community';
// page → the menu entry marked as the page you are on (none for a page the menu does not list)
const PAGES = { '/': null, '/tac/': 'TAC', '/chain/': 'TAC', '/vault/': 'Borrow', '/bridge/': 'Bridges', '/pay/': 'Pay', '/build/': null, '/docs/chain/': null, '/weld/stats/': null };
const VIEWS = { desktop: { width: 1280, height: 800 }, 'phone 390': { width: 390, height: 800 }, 'phone 360': { width: 360, height: 800 }, 'phone 320': { width: 320, height: 700 } };

const browser = await chromium.launch();
const ctx = await browser.newContext();
// Whatever is not the page's own answers as an empty reading (a node, the API, an explorer), so the page settles without a network.
await ctx.route((u) => u.hostname !== '127.0.0.1', (route) => {
  const body = JSON.parse(route.request().postData() || 'null');
  const one = (b) => ({ jsonrpc: '2.0', id: b?.id ?? 1, result: '0x0' });
  return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : body ? one(body) : {}) });
});

for (const [vname, viewport] of Object.entries(VIEWS)) {
  console.log(`== ${vname}`);
  for (const [path, here] of Object.entries(PAGES)) {
    const page = await ctx.newPage();
    await page.setViewportSize(viewport);
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errs.push(m.text().slice(0, 140)); });
    await page.goto(`http://127.0.0.1:${WEB}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => {});      // /chain/ goes on at once
    if (path === '/chain/') await page.waitForURL(/\/tac\/$/);
    await page.waitForSelector('.sn .sm > summary');
    await page.waitForTimeout(600);
    const seen = await page.evaluate(() => {
      const list = (s) => [...document.querySelectorAll(s)].map((a) => `${a.textContent.trim()}:${a.getAttribute('href')}`).join(' ');
      const foot = [...document.querySelectorAll('footer.sf nav a')], fr = document.querySelector('footer.sf nav')?.getBoundingClientRect();
      const visible = (a) => { const b = a.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return {
        at: location.pathname, header: [...document.querySelectorAll('.sn > a')].filter(visible).map((a) => `${a.textContent.trim()}:${a.getAttribute('href')}`).join(' '),
        menu: list('.sm-p a:not(.pr)'), phone: list('.sm-p a.pr'), dividers: document.querySelectorAll('.sm-p hr:not(.pr)').length,
        marked: [...document.querySelectorAll('.sm-p a[aria-current="page"]')].map((a) => a.textContent.trim()).join(','),
        chain: document.querySelectorAll('.sn a[href="/chain/"], .sm-p a[href="/chain/"]').length,
        foot: foot.map((a) => a.getAttribute('aria-label')).join(' | '), footHref: Object.fromEntries(foot.map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])),
        footIn: !!fr && fr.left >= -12 && fr.right <= window.innerWidth + 1, scroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    const tag = `${vname} ${path}`;
    if (path === '/chain/') ok(seen.at === '/tac/', `${tag}: the old address goes on to TAC's page`, seen.at);
    ok(seen.menu === MENU && seen.dividers === 0, `${tag}: the menu is the pages a holder goes to, with no divider`, seen.menu);
    if (vname === 'desktop') ok(seen.header === HEADER, `${tag}: and Assets, Rewards and Prove sit beside it`, seen.header);
    else ok(seen.phone === HEADER, `${tag}: and on a phone it holds them first`, seen.phone);
    ok(seen.chain === 0, `${tag}: the Tacit chain has no entry of its own`);
    ok(seen.marked === (here || ''), `${tag}: the page you are on is marked${here ? ` (${here})` : ' (none)'}`, seen.marked);
    ok(seen.foot === FOOTER && seen.footHref.Build === '/build/' && seen.footHref.Stats === '/weld/stats/', `${tag}: the footer has Build and Stats among its icons`, seen.foot);
    ok(seen.footIn && !seen.scroll, `${tag}: the footer is on the page, which does not scroll sideways`);
    ok(errs.length === 0, `${tag}: no page or CSP errors`, errs.slice(0, 2).join(' | '));
    if (path === '/') {
      await page.click('.sn .sm > summary');
      ok(await page.$eval('.sm', (d) => d.open), `${tag}: the menu opens`);
      await page.keyboard.press('Escape');
      ok(!(await page.$eval('.sm', (d) => d.open)), `${tag}: and Escape shuts it`);
    }
    await page.close();
  }
}
// The old /chain/ address is a stub: a link made for it keeps its search and hash on the way to TAC's page, and a browser without scripts is sent there too.
console.log('== the old /chain/ address');
{
  const page = await ctx.newPage();
  const seenUrls = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) seenUrls.push(new URL(f.url()).pathname + new URL(f.url()).search + new URL(f.url()).hash); });
  await page.goto(`http://127.0.0.1:${WEB}/chain/?ref=a#card=swap:eth:tac`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForURL(/\/tac\//);
  ok(seenUrls.includes('/tac/?ref=a#card=swap:eth:tac'), 'a link with a search and a hash arrives on /tac/ with both', seenUrls.join(' → '));
  await page.close();
  const quiet = await browser.newContext({ javaScriptEnabled: false });
  const bare = await quiet.newPage();
  await bare.goto(`http://127.0.0.1:${WEB}/chain/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await bare.waitForURL(/\/tac\/$/, { timeout: 15000 }).then(() => ok(true, 'and a browser without scripts is sent to /tac/'), () => ok(false, 'and a browser without scripts is sent to /tac/', bare.url()));
  await quiet.close();
  const size = readFileSync(join(DAPP, 'chain', 'index.html')).length;
  ok(size < 2048, 'and the stub stays a stub', `${size} bytes`);
}
await browser.close();
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
