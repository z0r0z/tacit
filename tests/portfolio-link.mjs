#!/usr/bin/env node
// The Portfolio page (dapp/index.html: openPortfolio, pfPageSet, pfPageView) and the links to it (build/chrome.mjs -> /#portfolio), in a real browser
// under the page's own CSP with a pasted key; every host but the page's own is refused (the Bitcoin address answers as empty):
//   · signed out, /#portfolio is the page's signed-out self (no figures of anyone's, a way to open a wallet) with the Wallet sheet over it, and once
//     a key is open the page fills and the sheet is gone;
//   · the page lists what is held by asset, an asset opens to a row for each place it is in, and a row opens its own sheet over the page, which is
//     there again when the sheet shuts;
//   · the header's Portfolio opens it and marks itself, the mark leaves it, and the front page's "Your Tacit" keeps the totals and one press to it;
//   · anything that shows the card (#card=…) leaves the page for the card;
//   · from another page of the site, the header's Portfolio goes to the front page's, and asks for a wallet;
//   · on a phone it is the first entry of the bar at the foot.
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
// the page showing: <html data-view="portfolio">, its body drawn
const atPortfolio = (page) => page.waitForFunction(() => document.documentElement.dataset.view === 'portfolio' && !!document.querySelector('#ppg-body .ppg-card'), null, { timeout: 30000 }).then(() => true, () => false);
const state = (page) => page.evaluate(() => ({ view: document.documentElement.dataset.view || '', hash: location.hash, title: document.title, sheets: [...document.querySelectorAll('dialog.sheet[open]')].map((d) => d.id).join(','),
  assets: [...document.querySelectorAll('#ppg-body [data-pf-open]')].map((b) => b.dataset.pfOpen), hero: !!document.querySelector('.hero')?.getClientRects().length }));
const headLink = '.sn > a[href="/#portfolio"]';

try {
  // signed out: the page's signed-out self, the Wallet sheet over it, then the page filled once a key is open
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(BASE + '/#portfolio', { waitUntil: 'commit' });
    const sheet = await page.waitForSelector('#sheet-wallet[open] #ws-in', { timeout: 30000 }).then(() => true, () => false);
    let s = await state(page);
    ok(sheet && s.view === 'portfolio' && !s.hero, `signed out, /#portfolio is the Portfolio page with the Wallet sheet over it (view ${s.view}, sheets ${s.sheets})`);
    ok(s.assets.length === 0 && (await page.$('#ppg-body [data-signin]')) && /Open a wallet/.test(await page.textContent('#ppg-body')), 'and the page under it holds no figures, only a way to open a wallet');
    ok(s.title === 'tacit portfolio', `the tab is named for it (${s.title})`);
    if (sheet) {
      await page.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));   // the other ways to sign in are folded under one line
      await page.click('#ws-in [data-in="paste"]');
      await page.fill('#ws-hex', KEY);
      await page.click('#ws-in [data-in="key"]');
      await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll('#ppg-body [data-pf-open]').length > 0 && !document.querySelector('dialog.sheet[open]'), null, { timeout: 30000 }).catch(() => {});
      s = await state(page);
      ok(s.view === 'portfolio' && !s.sheets && s.hash === '#portfolio', `once the key is open the page is there, the sheet gone, the address its link (${s.hash}, sheets ${s.sheets || 'none'})`);
      const cards = await page.$$eval('#ppg-body h2, #ppg-body [role="heading"]', (es) => es.map((e) => e.textContent.trim()));
      ok(['eth', 'tac'].every((a) => s.assets.includes(a)) && ['Total', 'Assets', 'Needs you', 'Positions', 'Rewards'].every((h) => cards.includes(h)), `it lists what the key holds by asset, with its cards (${s.assets.join(', ')} | ${cards.join(', ')})`);
      const tags = await page.$$eval('#ppg-body [data-pf-open="tac"] .ppg-tag', (es) => es.map((e) => e.textContent.trim()));
      ok(tags.length >= 1 && tags.every((t) => /Private|Public/.test(t)), `and each asset says which places it is in (${tags.join(' | ')})`);

      // an asset opens to a row for each place, and a row opens its own sheet over the page
      await page.click('#ppg-body [data-pf-open="eth"]');
      const open = await page.evaluate(() => ({ exp: document.querySelector('#ppg-body [data-pf-open="eth"]').getAttribute('aria-expanded'), rows: [...document.querySelectorAll('#ppg-body .ppg-more:not([hidden]) .wb-go')].map((e) => e.dataset.dashOpen || e.dataset.asset || e.getAttribute('href')) }));
      ok(open.exp === 'true' && open.rows.includes('private'), `an asset opens to a row for each place it is in (${open.rows.join(', ')})`);
      await page.click('#ppg-body .ppg-more:not([hidden]) [data-dash-open="private"]');
      const eth = await page.waitForSelector('#sheet-eth[open]', { timeout: 15000 }).then(() => true, () => false);
      ok(eth && (await state(page)).view === 'portfolio', 'a row opens its own sheet, over the page');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]') && location.hash === '#portfolio', null, { timeout: 10000 }).catch(() => {});      // (the address follows the sheet's closing)
      s = await state(page);
      ok(s.view === 'portfolio' && s.hash === '#portfolio', `and the page is there again when the sheet shuts (${s.hash})`);
      await page.click('#ppg-body [data-pf-open="eth"]');
      const all = await page.$$eval('#dash-g .wb-go', (es) => es.map((e) => e.dataset.dashOpen || e.dataset.asset || e.getAttribute('href')));
      ok((await page.getAttribute('#ppg-body [data-pf-open="eth"]', 'aria-expanded')) === 'false' && !(await page.$('#ppg-body .ppg-more:not([hidden])')) && ['private', 'tac', 'pts'].every((r) => all.includes(r)),
        `a second press shuts the asset, and every row of what is held stays in the page under #dash-g (${all.join(', ')})`);

      // the mark leaves it; the header's entry opens it, twice
      for (const [i, word] of [[1, 'the header\'s Portfolio opens the page and marks itself'], [2, 'and does it again once the page was left']]) {
        await page.click('header.top a.brand');
        await page.waitForFunction(() => !document.documentElement.dataset.view, null, { timeout: 10000 }).catch(() => {});
        const left = await state(page);
        await page.click(headLink);
        const there = await atPortfolio(page);
        s = await state(page);
        ok(!left.view && left.hero && there && s.hash === '#portfolio' && (await page.getAttribute(headLink, 'aria-current')) === 'page', `signed in, ${word} (${i}; left to ${left.hash || '/'})`);
      }

      // the front page keeps the totals and the way in, not the rows
      await page.click('header.top a.brand');
      await page.waitForFunction(() => !document.documentElement.dataset.view, null, { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('#dash-go button.all', { timeout: 15000 }).catch(() => {});      // (the strip is drawn on the next frame)
      const strip = await page.evaluate(() => ({ shown: !document.querySelector('#dash').hidden, rows: document.querySelectorAll('#dash .wb-go, #dash li').length, go: [...document.querySelectorAll('#dash-go button')].map((b) => b.textContent.trim()) }));
      ok(strip.shown && strip.rows === 0 && strip.go.at(-1) === 'Portfolio', `Your Tacit on the front page lists no rows and ends in Portfolio (${strip.go.join(' | ')})`);
      await page.click('#dash-go button.all');
      ok(await atPortfolio(page), 'which opens the page');

      // anything that shows the card leaves the page for the card
      await page.evaluate(() => { location.hash = 'card=swap'; });
      await page.waitForFunction(() => !document.documentElement.dataset.view, null, { timeout: 10000 }).catch(() => {});
      s = await state(page);
      ok(!s.view && s.hero && !/portfolio/.test(s.hash) && s.title === 'tacit defi', `a link to the card leaves the page for the card (${s.hash || '/'}, ${s.title})`);
      // no sheet of the old name is left to open
      ok(!(await page.$('#sheet-portfolio')), 'and there is no Portfolio sheet any more');
    }
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
  // from another page of the site
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(BASE + '/vault/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(headLink, { timeout: 30000 });
    const first = await page.$eval('.sn > a', (a) => `${a.textContent.trim()}:${a.getAttribute('href')}`).catch(() => '');
    ok(first === 'Portfolio:/#portfolio', `the header's first section on another page is Portfolio (${first})`);
    await page.click(headLink);
    await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 30000 }).catch(() => {});
    const sheet = await page.waitForSelector('#sheet-wallet[open] #ws-in', { timeout: 30000 }).then(() => true, () => false);
    const s = await state(page);
    ok(sheet && s.view === 'portfolio', `and from there it goes to the front page's Portfolio and asks for a wallet (view ${s.view}, ${s.hash})`);
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
  // a phone: the first entry of the bar at the foot
  {
    const { ctx, page, errors } = await fresh();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav.bn a[href="/#portfolio"]', { timeout: 30000 });
    const bar = await page.$eval('nav.bn a', (a) => `${a.textContent.trim()}:${a.getAttribute('href')}`);
    await page.click('nav.bn a[href="/#portfolio"]');
    const there = await atPortfolio(page);
    ok(bar === 'Portfolio:/#portfolio' && there && (await page.getAttribute('nav.bn a[href="/#portfolio"]', 'aria-current')) === 'page' && (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)),
      `on a phone the bar's first entry is Portfolio, opens the page and marks itself, and nothing is wider than the screen (${bar})`);
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nportfolio page checks passed (${n})`);
process.exit(fails ? 1 : 0);
