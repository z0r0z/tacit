#!/usr/bin/env node
// The menu's Portfolio link (build/chrome.mjs -> /#portfolio) and what the front page does with it (dapp/index.html openPortfolio), in a real browser under the
// page's own CSP with a pasted key; every host but the page's own is refused (the Bitcoin address answers as empty):
//   · signed out, /#portfolio opens the Wallet sheet to sign in, clears the address's hash, and once a key is open the Portfolio sheet opens;
//   · signed in, the menu's Portfolio opens the Portfolio sheet and shuts the menu, and does so again once it has been closed;
//   · the sheet groups what is held, a row opens its own sheet, and the front page's "Your Tacit" keeps the totals and one press to the sheet;
//   · from another page of the site, the menu's Portfolio goes to the front page and asks for a wallet.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/portfolio-link.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const KEY = '11'.repeat(31) + '22';
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
// a fresh browser context (nothing remembered), motion off so a scroll lands at once
async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 700 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE)) return r.continue();
    if (/\/address\/[^/]+\/utxo/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: '[]' });
    return r.abort();
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  return { ctx, page, errors };
}
const atPortfolio = (page) => page.waitForSelector('#sheet-portfolio[open] #dash-g .wb-go', { timeout: 30000 }).then(() => true, () => false);
// (an open sheet writes its own hash; with no wallet #portfolio must be gone, so the same link can be followed again)
const noHash = (page) => page.evaluate(() => !/portfolio/.test(location.hash));
const hashIs = (page) => page.evaluate(() => location.hash);
const menuLink = '.sm-p a[href="/#portfolio"]';

try {
  // signed out: the Wallet sheet, then the Portfolio once a key is open
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(BASE + '/#portfolio', { waitUntil: 'commit' });
    const sheet = await page.waitForSelector('#sheet-wallet[open] #ws-in', { timeout: 30000 }).then(() => true, () => false);
    ok(sheet, 'signed out, /#portfolio opens the Wallet sheet to sign in');
    ok(await noHash(page), `and #portfolio is cleared from the address (it reads ${JSON.stringify(await hashIs(page))})`);
    if (sheet) {
      await page.click('#ws-in [data-in="paste"]');
      await page.fill('#ws-hex', KEY);
      await page.click('#ws-in [data-in="key"]');
      await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
      ok(await atPortfolio(page), 'and once the key is open the Portfolio sheet opens');
      const groups = await page.$$eval('#sheet-portfolio .pf-h span', (es) => es.map((e) => e.textContent.trim()));
      const rows = await page.$$eval('#dash-g .wb-go', (es) => es.map((e) => e.dataset.dashOpen || e.dataset.asset || e.getAttribute('href')));
      ok(groups[0] === 'Private' && groups.includes('Rewards') && ['private', 'tac', 'pts'].every((r) => rows.includes(r)), `it groups what the key holds: private tETH and TAC, and its points (${groups.join(', ')} | ${rows.join(', ')})`);
      ok((await hashIs(page)) === '#portfolio', `the open sheet is the address's link (${await hashIs(page)})`);

      // a row is one press from its own sheet
      await page.click('#dash-g [data-dash-open="private"]');
      const eth = await page.waitForSelector('#sheet-eth[open]', { timeout: 15000 }).then(() => true, () => false);
      ok(eth && !(await page.$('#sheet-portfolio[open]')), 'a row opens its own sheet, and the Portfolio gives way to it');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});

      // the front page keeps the totals and the way in, not the rows
      const strip = await page.evaluate(() => ({ shown: !document.querySelector('#dash').hidden, rows: document.querySelectorAll('#dash .wb-go, #dash li').length, go: [...document.querySelectorAll('#dash-go button')].map((b) => b.textContent.trim()) }));
      ok(strip.shown && strip.rows === 0 && strip.go.at(-1) === 'Portfolio', `Your Tacit on the front page lists no rows and ends in Portfolio (${strip.go.join(' | ')})`);
      await page.click('#dash-go button.all');
      ok(await atPortfolio(page), 'which opens the sheet');
      await page.keyboard.press('Escape');

      // signed in: the menu's entry, twice
      for (const [i, word] of [[1, 'the menu\'s Portfolio opens the Portfolio sheet'], [2, 'and does it again once the sheet was closed']]) {
        await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.click('.sn .sm > summary');
        await page.click(menuLink);
        const there = await atPortfolio(page);
        ok(there && (await page.$eval('.sm', (d) => !d.open)), `signed in, ${word}, with the menu shut (${i})`);
        await page.keyboard.press('Escape');
      }
    }
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
  // from another page of the site
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(BASE + '/vault/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sn .sm > summary', { timeout: 30000 });
    await page.click('.sn .sm > summary');
    const entry = await page.$eval('.sm-p a:not(.pr)', (a) => `${a.textContent.trim()}:${a.getAttribute('href')}`).catch(() => '');
    ok(entry === 'Portfolio:/#portfolio', `the menu's first entry on another page is Portfolio (${entry})`);
    await page.click(menuLink);
    await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 30000 }).catch(() => {});
    const sheet = await page.waitForSelector('#sheet-wallet[open] #ws-in', { timeout: 30000 }).then(() => true, () => false);
    ok(sheet && (await noHash(page)), `and from there it goes to the front page and asks for a wallet (hash ${JSON.stringify(await hashIs(page))})`);
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nportfolio link checks passed (${n})`);
process.exit(fails ? 1 : 0);
