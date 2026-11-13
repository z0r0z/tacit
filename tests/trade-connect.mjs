#!/usr/bin/env node
// Connecting a wallet on dapp/trade/ for someone who arrives straight at it, in a real browser under the page's own CSP: the header chip,
// the wallet picker, WalletConnect's pairing sheet (the page runs the real dapp/walletconnect.js over a stand-in for its bundle, tests/wc-fake.mjs,
// that pairs when the test says so: WalletConnect itself needs a relay and a phone), the account sheet with Disconnect, and on a phone the bar at
// the foot that leads to the ticket.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-connect.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { useWcFake } from './wc-fake.mjs';
import { RPC_HOSTS } from './eth-hosts.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const WEB = 22900 + Math.floor(Math.random() * 90);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const json = (n) => JSON.parse(readFileSync(join(FX, n), 'utf8'));
const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
const asset = json('tac-asset-2026-10-12.json'), sales = json('tac-sales-2026-10-12.json'), bids = json('tac-bids-2026-10-12.json');
sales.sales = sales.sales.map((x) => ({ ...x, expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) }));
bids.intents = bids.intents.map((x) => ({ ...x, expiry: soon }));
const ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678', OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

// A browser wallet that announces itself through EIP-6963.
const BROWSER_WALLET = `(() => {
  // It allows this site once asked (kept across a reload, as a wallet does), and counts the prompts it shows.
  const provider = { async request({ method }) {
    if (method === 'eth_requestAccounts') { window.__prompts = (window.__prompts || 0) + 1; localStorage.setItem('stub-allowed', '1'); return ['${OTHER}']; }
    if (method === 'eth_accounts') return localStorage.getItem('stub-allowed') ? ['${OTHER}'] : [];
    if (method === 'eth_chainId') return '0x1'; throw new Error('stub: ' + method); }, on() {}, removeListener() {} };
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'browser-stub', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });

async function openPage(viewport, { browserWallet = false, phone = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light', ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  if (browserWallet) await ctx.addInitScript(BROWSER_WALLET);
  const ok200 = (body) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, (r) => r.fulfill(ok200({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'not served in this test' } })));
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, (r) => { const p = new URL(r.request().url()).pathname; return r.fulfill(ok200(/preauth-sales$/.test(p) ? sales : /bid-intents$/.test(p) ? bids : asset)); });
  const hits = await useWcFake(ctx, { account: ACCOUNT });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource/.test(t)) errors.push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}/trade/tac/`);
  await page.waitForSelector('#wallet-chip');
  await page.waitForTimeout(800);
  return { browser, page, errors, blocked, hits, ctx };
}
const chip = (p) => p.evaluate(() => ({ label: document.querySelector('#wallet-label').textContent, on: document.querySelector('#wallet-dot').classList.contains('on') }));

let r;
try {
  // someone with no wallet in the browser, at a desktop
  r = await openPage({ width: 1280, height: 900 });
  let p = r.page;
  let c = await chip(p);
  ok(c.label === 'Connect' && !c.on && (await text(p, '#go')) === 'Connect wallet', 'the header has a Connect button beside the page\'s links, and the ticket asks to connect');
  ok(!(await p.$eval('#stick', (e) => e.offsetParent !== null)), 'a desktop has no bar at the foot');
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top .wc-qr svg');
  const sheet = (await text(p, '.bsheet.top')).replace(/\s+/g, ' ');
  ok(/Connect a wallet app/.test(sheet) && /Scan the code with a wallet app on your phone/.test(sheet) && /Copy link/.test(sheet) && !/Open wallet app/.test(sheet), `with no wallet in the browser, Connect opens WalletConnect's pairing sheet with a code to scan (${sheet.slice(0, 90)})`);
  await p.click('.bsheet.top .x');
  await until(p, () => !document.querySelector('.bsheet'), null, 5000);
  ok((await p.evaluate(() => window.__wcfake.cancelled)) === 1 && (await chip(p)).label === 'Connect', 'closing the sheet cancels the pairing and nothing is connected');
  // the code was scanned before the sheet closed and the wallet app approves it after: the pairing is gone, so no session opens
  await p.evaluate(() => window.__wcfake.approve());
  await p.waitForTimeout(300);
  ok(!(await p.evaluate(() => localStorage.getItem('fake-wc-session'))) && (await chip(p)).label === 'Connect', 'a code approved in the wallet app after the sheet closed opens no session');
  // two presses on the ticket's button are one pairing, not two
  const pairs0 = await p.evaluate(() => window.__wcfake.pairs);
  await p.evaluate(() => { const b = document.querySelector('#go'); b.click(); b.click(); });
  await p.waitForSelector('.bsheet.top .wc-qr');
  await p.waitForTimeout(300);
  ok((await p.evaluate(() => window.__wcfake.pairs)) - pairs0 === 1 && (await p.$$('.bsheet')).length === 1, 'pressing Connect twice joins the pairing under way: one code, one sheet');
  await p.evaluate(() => window.__wcfake.approve());
  await until(p, () => !document.querySelector('.bsheet') && document.querySelector('#wallet-dot').classList.contains('on'), null, 10000);
  await until(p, () => document.querySelector('#go').textContent === 'Enter an amount', null, 15000).catch(() => {});
  c = await chip(p);
  ok(c.on && c.label === '0x1234…5678' && (await text(p, '#go')) === 'Enter an amount', `the ticket's own button connects too, and the header shows the account (${c.label})`);
  // the session is kept for every page of the site, so this page asks for the chains the others use too
  const asked = await p.evaluate(() => window.__wcfake.opts.optionalChains);
  ok([1, 8453, 4663].every((id) => asked.includes(id)), `a wallet app paired here is asked for every chain the site works on, so the pages that use Base keep it too (${asked.join(', ')})`);
  // WalletConnect answers eth_chainId with a number: the page still sees Ethereum, not another network
  ok(!(await p.$eval('#wallet-dot', (e) => e.classList.contains('warn'))) && !(await p.$eval('#wallet-chip', (e) => e.title)), 'a wallet app on Ethereum shows as connected, not as on another network');
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top [data-leave]');
  const acct = (await text(p, '.bsheet.top')).replace(/\s+/g, ' ');
  ok(/WalletConnect · Test Phone Wallet/.test(acct) && acct.includes(ACCOUNT) && /Copy address/.test(acct) && /Disconnect/.test(acct) && !/Switch/.test(acct), `the account sheet names the wallet app and the account and offers Disconnect (${acct.slice(0, 100)})`);
  await p.keyboard.press('Escape');
  await until(p, () => !document.querySelector('.bsheet'), null, 5000);
  // a reload: the session is kept, so the wallet app is back with no new code
  await p.reload(); await p.waitForSelector('#wallet-chip');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'), null, 15000).catch(() => {});
  ok((await chip(p)).label === '0x1234…5678' && !(await p.$('.bsheet')) && (await p.evaluate(() => window.__wcfake.pairs)) === 0, 'a reload finds the kept session and reconnects the wallet app with no new pairing');
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top [data-leave]');
  await p.click('.bsheet.top [data-leave]');
  await until(p, () => !document.querySelector('.bsheet') && document.querySelector('#wallet-label').textContent === 'Connect', null, 10000);
  ok((await p.evaluate(() => window.__wcfake.disconnected)) === 1 && (await text(p, '#go')) === 'Connect wallet' && !(await chip(p)).on, 'Disconnect ends the WalletConnect session and puts the page back to asking for a wallet');
  // with no session kept, a reload does not fetch WalletConnect's bundle at all
  const fetched = r.hits.bundle;
  await p.reload(); await p.waitForSelector('#wallet-chip'); await p.waitForTimeout(1500);
  ok(r.hits.bundle === fetched && (await chip(p)).label === 'Connect', `a reload with no session kept does not download WalletConnect (${r.hits.bundle - fetched} fetches)`);
  // a code nobody approved runs out: the page says so in words
  await p.click('#go');
  await p.waitForSelector('.bsheet.top .wc-qr');
  await p.evaluate(() => window.__wcfake.reject(new Error('Proposal expired')));
  await until(p, () => !document.querySelector('.bsheet') && /ran out/.test(document.querySelector('#status').textContent), null, 10000).catch(() => {});
  ok(/The code ran out before a wallet app approved it/.test(await text(p, '#status')) && !(await chip(p)).on, `an unapproved code that runs out says so (${(await text(p, '#status')).slice(0, 60)})`);
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page errors or blocked requests (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();

  // a browser wallet and WalletConnect both found: the person chooses
  r = await openPage({ width: 1280, height: 900 }, { browserWallet: true });
  p = r.page;
  await p.evaluate(() => window.dispatchEvent(new Event('eip6963:requestProvider')));                  // as a wallet announcing late would
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top .picker');
  const names = await p.$$eval('.bsheet.top .picker .way', (b) => b.map((x) => x.textContent.trim()));
  ok(names.length === 2 && names.includes('Test Wallet') && names.includes('WalletConnect'), `with a browser wallet and WalletConnect found, a short list asks which (${names.join(', ')})`);
  await p.click('.bsheet.top .picker .way:has-text("Test Wallet")');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'), null, 10000);
  ok((await chip(p)).label === '0xabcd…abcd' && !(await p.$('.bsheet')), 'choosing one connects it with no pairing sheet');
  // a reload: the wallet chosen last time is connected again, with no prompt
  await p.reload(); await p.waitForSelector('#wallet-chip');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'), null, 10000).catch(() => {});
  ok((await chip(p)).label === '0xabcd…abcd' && !(await p.evaluate(() => window.__prompts || 0)) && !(await p.$('.bsheet')), `a reload reconnects the same wallet without asking again (${(await chip(p)).label})`);
  await p.click('#wallet-chip'); await p.click('.bsheet.top [data-leave]');
  await p.reload(); await p.waitForSelector('#wallet-chip'); await p.waitForTimeout(1200);
  ok((await chip(p)).label === 'Connect', 'after Disconnect a reload stays disconnected');
  await r.browser.close();

  // a phone: nothing to tap in the first screen but the bar at the foot, which leads to the ticket
  r = await openPage({ width: 390, height: 844 }, { phone: true });
  p = r.page;
  ok(await p.$eval('.p-ticket', (e) => e.getBoundingClientRect().top < window.innerHeight * 0.75) && (await p.$eval('#stick', (e) => e.hidden)), 'on a phone the ticket comes right after the prices, so it is on the first screen and the bar waits');
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await until(p, () => !document.querySelector('#stick').hidden, null, 10000);
  ok(await p.$eval('#stick', (e) => getComputedStyle(e).display === 'block' && e.getBoundingClientRect().bottom <= window.innerHeight + 1), 'further down the bar at the foot leads back to it');
  await p.click('#stick-go');
  await until(p, () => document.querySelector('#stick').hidden, null, 10000);
  ok(await p.$eval('.p-ticket', (e) => { const r = e.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }), 'pressing it brings the ticket into view, and the bar goes away');
  await p.click('#go');
  await p.waitForSelector('.bsheet.top .wc-qr');
  const links = await p.$$eval('.bsheet.top a.btn', (a) => a.map((x) => [x.textContent.trim(), x.getAttribute('href')]));
  const apps = links.filter(([, h]) => /^(metamask|rainbow|trust):\/\/wc\?uri=wc%3Afake/.test(h)).map(([t]) => t);
  ok(apps.join('|') === 'Open MetaMask|Open Rainbow|Open Trust Wallet' && links.some(([t, h]) => t === 'Other wallet app' && /^wc:fake/.test(h)), `on a phone the pairing sheet has buttons that open a wallet app with the pairing link (${links.map(([t]) => t).join(', ')})`);
  ok(await p.$eval('.bsheet.top .wc-qr', (q) => q.getBoundingClientRect().top > document.querySelector('.bsheet.top a.btn').getBoundingClientRect().top), 'and they come before the code, which is for scanning from another device');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'and nothing scrolls sideways');
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / '));
  if (r) console.log('     errors:', r.errors.slice(0, 4), 'blocked:', r.blocked.slice(0, 3));
  await r?.browser.close().catch(() => {});
} finally { server.close(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-connect checks passed`);
process.exit(fails ? 1 : 0);
