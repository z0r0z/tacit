#!/usr/bin/env node
// The front page tile's Send tab picks its coin by where the coin is held: a switch between Wallet, Private and Bitcoin, a line on what the place is, and the coins of
// the one chosen (dapp/index.html: hxPick). Private TAC, USDC and USDT wear the dashed ring the private ETH mark has, in the list and in the field's coin, so a private
// dollar is told from the wallet's. A press with an amount and no recipient asks for the recipient in place.
// Nothing leaves the machine: every request to another host is refused, so nothing is held and every balance reads empty; the rows are in their natural order.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/send-picker.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const PORT = 31000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://127.0.0.1:${PORT}/`;
const THEM = '0x1111111111111111111111111111111111111111';

const visible = (page) => page.$$eval('#hx .pk .pk-r', (rs) => rs.filter((r) => !r.hidden).map((r) => r.dataset.v).join());
const open = async (page) => { await page.click('#hx-panel .coin[data-pk="hx-sa"]'); await page.waitForSelector('#hx .pk .pk-r:not([hidden])', { timeout: 30000 }); };
const rowText = (page, v) => page.$eval(`#hx .pk .pk-r[data-v="${v}"] small`, (s) => s.textContent.replace(/\s+/g, ' ').trim());
const ringed = (page, v) => page.$eval(`#hx .pk .pk-r[data-v="${v}"] svg.tk`, (s) => s.classList.contains('pvt'));
const where = (page) => page.$eval('#hx-panel .f .fh .where', (e) => e.textContent.trim());
const pillRing = (page) => page.$eval('#hx-panel .coin[data-pk="hx-sa"] svg.tk', (s) => s.classList.contains('pvt'));
const way = (page) => page.$eval('#hx-way', (e) => (e.hidden ? '' : e.textContent.trim()));

const browser = await chromium.launch();
try {
  for (const [w, h, phone] of [[1280, 900, false], [390, 844, true]]) {
    const tag = phone ? 'phone' : 'desktop';
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
    await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}#card=send:eth`, { waitUntil: 'commit' });
    await page.waitForSelector('#hx-panel .coin[data-pk="hx-sa"]', { timeout: 60000 });
    await sleep(800);

    // the place the coin is held in is where the picker opens, with a switch and the line on what that place is
    await open(page);
    const kinds = await page.$$eval('#hx .pk .pk-kind [role="radio"]', (b) => b.map((x) => `${x.textContent.trim()}${x.getAttribute('aria-checked') === 'true' ? '*' : ''}`).join());
    ok(kinds === 'Wallet,Private*,Bitcoin', `${tag}: the Send picker is a switch between Wallet, Private and Bitcoin, opened on the place of the coin it has (${kinds})`);
    ok(await visible(page) === 'eth,tac,cusd,cbtc,pp,ptac,usdc,usdt', `${tag}: Private lists tETH, TAC, cUSD and cBTC, then ETH, TAC, USDC and USDT held for payments (${await visible(page)})`);
    const note = await page.$eval('#hx .pk .pk-d:not([hidden])', (p) => p.textContent.trim());
    ok(/^Held privately\./.test(note) && (await page.$$('#hx .pk .pk-d:not([hidden])')).length === 1, `${tag}: one line says what Private is (${note})`);

    // each coin says what it is, and a coin held in both pools what each is for
    const subs = { eth: 'ETH, made private · swap, farm, borrow', tac: 'Tacit’s token · swap, farm, borrow', usdc: 'a private dollar · pay anyone on Ethereum', usdt: 'a private dollar · pay anyone on Ethereum', ptac: 'private TAC · pay anyone on Ethereum' };
    for (const [v, s] of Object.entries(subs)) { const got = await rowText(page, v); ok(got === s, `${tag}: ${v} reads "${s}" (${got})`); }
    const pp = await rowText(page, 'pp');
    ok(/^private ETH · pay anyone on$/.test(pp) && (await page.$$('#hx .pk .pk-r[data-v="pp"] .cm svg.tk')).length >= 2, `${tag}: private ETH names its chains by their marks (${pp})`);
    ok(!/DeFi pool|payments pool|Pay pool/.test(await page.$eval('#hx .pk', (e) => e.textContent)), `${tag}: no pool is named in the list`);

    // the private form of a coin has the dashed ring; the DeFi pool's own marks and the wallet's do not need it
    ok(await ringed(page, 'usdc') && await ringed(page, 'usdt') && await ringed(page, 'ptac') && await ringed(page, 'tac') && !(await ringed(page, 'eth')) && !(await ringed(page, 'cusd')), `${tag}: private USDC, USDT and TAC (both homes) wear the ring; tETH and cUSD, which are their own marks, do not need it`);

    // Wallet and Bitcoin are one press away, and the arrows move between the places
    await page.click('#hx .pk .pk-kind [data-kind="wallet"]');
    ok(await visible(page) === 'ether,wtac,wusdc,wusdt', `${tag}: Wallet lists ETH, TAC, USDC and USDT (${await visible(page)})`);
    ok(!(await ringed(page, 'wusdc')) && await rowText(page, 'wusdc') === 'a dollar', `${tag}: the wallet's USDC has no ring and says a dollar`);
    ok(/^Public, in your wallet\.$/.test(await page.$eval('#hx .pk .pk-d:not([hidden])', (p) => p.textContent.trim())), `${tag}: Wallet says it is public`);
    await page.focus('#hx .pk .pk-kind [data-kind="wallet"]');
    await page.keyboard.press('ArrowRight');
    ok(await visible(page) === 'eth,tac,cusd,cbtc,pp,ptac,usdc,usdt' && await page.evaluate(() => document.activeElement?.dataset.kind) === 'private', `${tag}: the right arrow moves to Private`);
    await page.keyboard.press('ArrowRight');
    ok(await visible(page) === 'tacb,btc', `${tag}: and on to Bitcoin (${await visible(page)})`);
    await page.keyboard.press('ArrowDown');
    ok(await page.evaluate(() => document.activeElement?.dataset.v) === 'tacb', `${tag}: the down arrow enters its coins`);
    const fits = await page.$eval('#hx .pk .pk-l', (l) => l.scrollWidth <= l.clientWidth + 1);
    ok(fits, `${tag}: the list does not scroll sideways`);

    // choosing a coin: its ring and its place are read from the field
    await page.click('#hx .pk .pk-kind [data-kind="private"]');
    await page.click('#hx .pk .pk-r[data-v="usdc"]');
    await page.waitForFunction(() => document.querySelector('#hx-sa')?.value === 'usdc');
    ok(await where(page) === 'Private' && await pillRing(page), `${tag}: private USDC reads Private and wears the ring in the field`);
    ok(/^To tacit1… or a name: stays private\. To 0x…: taken out of the pool to that address\.$/.test(await way(page)), `${tag}: its line says what each address does (${await way(page)})`);
    await open(page);
    ok(await visible(page) === 'eth,tac,cusd,cbtc,pp,ptac,usdc,usdt', `${tag}: it opens on Private again`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#hx .pk'));
    ok(await page.evaluate(() => document.activeElement?.dataset.pk) === 'hx-sa', `${tag}: Escape closes it and the field's coin has the focus`);
    await open(page);
    await page.click('#hx .pk .pk-kind [data-kind="wallet"]');
    await page.click('#hx .pk .pk-r[data-v="wusdc"]');
    await page.waitForFunction(() => document.querySelector('#hx-sa')?.value === 'wusdc');
    ok(await where(page) === 'Wallet' && !(await pillRing(page)), `${tag}: the wallet's USDC reads Wallet and has no ring`);
    ok(/^To 0x… or a name: a public transfer\. To tacit1…: paid into their private USDC\.$/.test(await way(page)) && await page.$eval('#hx-go', (b) => b.textContent) === 'Send USDC', `${tag}: with no recipient the button does not promise privacy (${await way(page)})`);

    // an amount with no one to send it to asks for the recipient, in place, and opens nothing
    await page.fill('#hx-amt', '5');
    await page.click('#hx-go');
    ok(await page.evaluate(() => document.activeElement?.id) === 'hx-rcpt' && /^Enter who to send it to\.$/.test(await page.$eval('#hx-q', (e) => e.textContent)) && !(await page.$('dialog[open]')), `${tag}: Send with an amount and no recipient asks for the recipient (${await page.$eval('#hx-q', (e) => e.textContent)})`);
    await page.fill('#hx-rcpt', THEM);
    await sleep(300);
    ok(await page.$eval('#hx-go', (b) => b.textContent) === 'Send USDC' && /^A public transfer from your/.test(await way(page)), `${tag}: an Ethereum address is a public transfer from the wallet`);
    await page.selectOption('#hx-sa', 'eth');
    await page.fill('#hx-rcpt', '');
    await sleep(300);
    await page.fill('#hx-amt', '0.2');
    await page.click('#hx-go');
    ok(await page.evaluate(() => document.activeElement?.id) === 'hx-rcpt' && !(await page.$('dialog[open]')), `${tag}: so does private tETH`);
    // Send and Request are one switch; a wallet coin is only sent
    await page.selectOption('#hx-sa', 'usdc');
    ok(await page.$$eval('#hx-panel .hx-sr [role="radio"]', (b) => b.map((x) => x.textContent + (x.getAttribute('aria-checked') === 'true' ? '*' : '')).join()) === 'Send*,Request', `${tag}: Send and Request are a switch, on Send`);
    await page.click('#hx-ask');
    ok(/You ask for/.test(await page.$eval('#hx-panel', (e) => e.textContent)) && await page.$eval('#hx-ask', (b) => b.getAttribute('aria-checked')) === 'true', `${tag}: Request opens the request`);
    await page.click('#hx-pay');
    await page.selectOption('#hx-sa', 'wusdc');
    ok(!(await page.$('#hx-ask')), `${tag}: a wallet coin has no Request`);
    ok(!errors.length, `${tag}: no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`\n${fails ? `${fails} FAILED, ${n} ok` : `${n} send-picker checks passed`}`);
process.exit(fails ? 1 : 0);
