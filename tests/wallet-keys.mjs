#!/usr/bin/env node
// What the Wallet sheet and the Bitcoin tab's Receive show of the open key (dapp/index.html), in a real browser under the page's own CSP, with a pasted key and a
// Bitcoin address that holds 0.0025 BTC and 0.00007 arriving (the page's only answers; every other host is refused):
//   · the Tacit address heads the sheet on a card of its own: its two ends at first, the whole 276 characters after Show all, and Copy address puts
//     the whole one on the clipboard; it is not listed a second time below;
//   · the public key: the key's compressed secp256k1 point, in full, and Copy puts it on the clipboard;
//   · the Bitcoin address: the key's own bc1q…, the same one Receive shows; the Tacit account: the key's own 0x, the one Add ETH shows;
//   · Balances: the Bitcoin address's BTC (and what is arriving) is a row under Bitcoin, read when the sheet opens, matching the landing card;
//   · Receive carries the public key and a folded Tacit address too;
//   · the Bitcoin address has a QR code (the same drawing as the page's other codes), in the sheet and in Receive;
//   · Refresh reads the Bitcoin address again; a row goes to its sheet and puts the Wallet sheet away; the old "connects when you lock BTC" row is gone;
//   · the Balances box has an id of its own: the ETH form's balance (#w-bal) lands in that form, not in Balances.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/wallet-keys.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import { unifiedAddress } from '../dapp/tacit-unified.js';
import { qrSvg } from '../dapp/qr.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
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
const PUB = Buffer.from(secp.getPublicKey(Uint8Array.from(Buffer.from(KEY, 'hex')), true)).toString('hex');
const TACIT = unifiedAddress(KEY).address;
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
let utxoReads = 0, lastRead = 0;
const UTXOS = [{ txid: 'aa'.repeat(32), vout: 0, value: 250000, status: { confirmed: true, block_height: 900000, block_time: 1700000000 } }, { txid: 'bb'.repeat(32), vout: 1, value: 7000, status: { confirmed: false } }];

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE)) return r.continue();
    if (/\/address\/[^/]+\/utxo/.test(u)) { utxoReads++; lastRead = Date.now(); return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(UTXOS) }); }
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#wallet', { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#w-keys .keyrow', { timeout: 20000 });
  const keys = '#w-keys';
  const row = (label) => `${keys} .keyrow:has(.kv > span:first-child:text-is("${label}"))`;
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());

  // the Tacit address, on the card at the top: its ends, then the whole of it
  const hero = '#w-tacit';
  ok(TACIT.length === 276, 'the unified Tacit address is the 276-character one');
  const ends = await text(`${hero} .ends`);
  ok(ends.startsWith(TACIT.slice(0, 14)) && ends.endsWith(TACIT.slice(-12)) && ends.length < 60, `the Tacit address shows its two ends first: ${ends}`);
  ok(!(await page.isVisible(`${hero} .full`)), 'and not the whole until it is asked for');
  await page.click(`${hero} [data-fold]`);
  ok(await page.isVisible(`${hero} .full`) && (await text(`${hero} .full code`)) === TACIT && !(await page.isVisible(`${hero} .ends`)), 'Show all gives the whole address in place of its ends');
  ok((await text(`${hero} [data-fold]`)) === 'Show less' && (await page.getAttribute(`${hero} [data-fold]`, 'aria-expanded')) === 'true', 'and the button says it can be closed');
  await page.click('#w-copy');
  ok((await page.evaluate(() => navigator.clipboard.readText())) === TACIT, 'Copy address puts the whole Tacit address on the clipboard, folded or not');
  ok((await page.$$eval('#toast-container .toast', (es) => es.map((e) => e.textContent))).some((t) => t.includes('Tacit address copied')), 'and says which thing was copied');
  ok(!(await page.$(row('Tacit address'))) && (await page.$$eval('#wallet-body code', (es, t) => es.filter((e) => e.textContent.trim() === t).length, TACIT)) === 1, 'the address is not listed again below the card');
  ok(/^Opened with a pasted key/.test(await text(`${hero} .by`)) && !!(await page.$(`${hero} .by #w-lock`)), 'the card says how the key was opened, with Lock beside it');

  // the Tacit account: the key's own 0x, the address Add ETH asks to be sent to
  const acct = await text(`${row('Tacit account')} code`);
  ok(/^0x[0-9a-fA-F]{40}$/.test(acct) && acct === (await page.$eval('#ac-form [data-copy]', (b) => b.dataset.copy)), `the Tacit account is listed, the same one Add ETH shows: ${acct.slice(0, 10)}…`);

  // the public key
  ok((await text(`${row('Public key')} code`)) === PUB && PUB.length === 66, `the public key is the key's compressed point, in full: ${PUB.slice(0, 12)}…`);
  await page.click(`${row('Public key')} [data-copy-addr]`);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === PUB, 'Copy puts it on the clipboard');

  // the Bitcoin address, which the Bitcoin tab's Receive shows too
  await page.waitForFunction(() => /^bc1q[0-9a-z]{38}$/.test([...document.querySelectorAll('#w-keys .keyrow')].find((r) => r.querySelector('.kv > span')?.textContent.trim() === 'Bitcoin address')?.querySelector('code')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  const bc = await text(`${row('Bitcoin address')} code`);
  ok(/^bc1q[0-9a-z]{38}$/.test(bc), `the key's own Bitcoin address is there: ${bc}`);

  // Balances: BTC under Bitcoin, from the address's own read
  await page.waitForFunction(() => /0\.0025/.test(document.querySelector('#wbal-box')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const bal = await text('#wbal-box');
  ok(/Bitcoin/.test(bal) && /BTC\s*0\.0025/.test(bal.replace(/\s+/g, ' ')) && /0\.00007 arriving/.test(bal), `Balances lists the Bitcoin address's BTC and what is arriving: ${bal.replace(/\s+/g, ' ').slice(0, 120)}`);
  ok(bal.indexOf('Bitcoin') < bal.indexOf('Ethereum'), 'Bitcoin and Ethereum are separate groups');
  ok((await page.$$('#wbal-box .wbal li')).length >= 2, 'each asset is a row of its own');

  // the old placeholder row is gone
  ok(!/connects when you lock BTC/.test(await text('#wallet-body')), 'the sheet no longer says the Bitcoin wallet "connects when you lock BTC to borrow"');

  // the Bitcoin address as a QR code
  const qrRow = row('Bitcoin address');
  ok(!(await page.isVisible(`${qrRow} .keyqr`)), 'the QR code is not drawn until it is asked for');
  await page.click(`${qrRow} [data-qr]`);
  await page.waitForSelector(`${qrRow} .keyqr svg`, { timeout: 10000 });
  const want = qrSvg(bc, 208, 'QR code of your bitcoin address'), drawn = await page.$eval(`${qrRow} .keyqr svg`, (e) => ({ d: e.querySelector('path').getAttribute('d'), label: e.getAttribute('aria-label'), style: e.getAttribute('style') }));
  ok(drawn.d === /<path d="([^"]+)"/.exec(want)[1] && drawn.label === 'QR code of your bitcoin address' && drawn.style === /style="([^"]+)"/.exec(want)[1], 'Show QR draws the address as the page draws its other codes (the same modules, at 208 px)');
  ok((await text(`${qrRow} [data-qr]`)) === 'Hide QR', 'and the button can put it away');
  await page.click(`${qrRow} [data-qr]`);
  ok(!(await page.isVisible(`${qrRow} .keyqr`)) && (await text(`${qrRow} [data-qr]`)) === 'QR', 'Hide QR puts it away');

  // the ETH form has its own #w-bal; opening it must leave Balances alone (it once wrote its balance into this sheet's box) and fill its own
  ok((await page.$$('#w-bal')).length === 0 && (await page.$$('#wbal-box')).length === 1, 'the Balances box and the ETH form do not share an id');
  await page.evaluate(() => { const d = document.querySelector('#sheet-wallet'); d.close(); });
  await page.goto(BASE + '/#private', { waitUntil: 'commit' });
  await page.waitForSelector('#w-max #w-bal', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#w-max #w-bal .sk'), null, { timeout: 20000 }).catch(() => {});
  ok(!(await page.$eval('#w-max #w-bal', (e) => !!e.querySelector('.sk'))), 'the ETH form fills its own balance');
  ok(/Balances/.test(await page.$eval('#wbal-box', (e) => e.textContent)), 'and leaves the wallet sheet\'s Balances as they were');
  await page.keyboard.press('Escape');

  // Refresh reads the Bitcoin address again
  await page.click('#wallet');
  await page.waitForSelector('#wbal-re', { timeout: 15000 });
  // tacit.js answers an address's coins from a 15-second cache, so Refresh is pressed once the last read is older than that
  await page.waitForTimeout(Math.max(0, lastRead + 15500 - Date.now()));
  const before = utxoReads;
  await page.click('#wbal-re');
  await page.waitForFunction((n) => document.querySelector('#wbal-re')?.textContent === 'Refresh' && !document.querySelector('#wbal-re').disabled, null, { timeout: 60000 }).catch(() => {});
  ok(utxoReads > before, `Refresh asks for the Bitcoin address's coins again (${before} → ${utxoReads})`);
  ok(/0\.0025/.test(await text('#wbal-box')), 'and the balance is still there after it');

  // a row goes to its own sheet, and the Wallet sheet is put away
  await page.click('#wbal-box [data-dash-open="btc"]');
  await page.waitForSelector('#sheet-btc[open]', { timeout: 10000 });
  ok(!(await page.$eval('#sheet-wallet', (d) => d.open)), 'pressing the BTC row opens the Bitcoin sheet and puts the Wallet sheet away');

  // Receive, from the Bitcoin sheet the row opened
  await page.click('[data-btcm="receive"]');
  await page.waitForSelector('#btc-form .keyrow', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('#btc-form .keyrow code').length >= 4, null, { timeout: 20000 });
  const labels = await page.$$eval('#btc-form .keyrow > .kv:first-child > span:first-child', (es) => es.map((e) => e.textContent.trim()));
  ok(labels.join('|') === 'Bitcoin address|Tacit address|Public key|Silent payments', `Receive lists the addresses and the public key: ${labels.join(', ')}`);
  ok((await page.$eval('#btc-form .keyrow:nth-of-type(3) code', (e) => e.textContent.trim())) === PUB, 'its public key is the same one');
  ok((await page.$eval('#btc-form .keyrow:nth-of-type(1) code', (e) => e.textContent.trim())) === bc, 'and its Bitcoin address the same one');
  ok(!!(await page.$('#btc-form .keyrow:nth-of-type(1) [data-qr]')) && !(await page.$('#btc-form .keyrow:nth-of-type(2) [data-qr]')), 'with a QR code on the Bitcoin address only');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  await ctx.close();
} finally { await browser.close(); server.close(); }
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
