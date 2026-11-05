#!/usr/bin/env node
// Changing and leaving a wallet on tacit.finance, in a real browser under each page's own CSP, with a browser wallet that holds two accounts, counts what it
// is asked, offers the account chooser (wallet_requestPermissions) and takes the site's permission back (wallet_revokePermissions) unless told it has neither:
//   · the trade pages' wallet (rewards, vault) and the front page's (front page, tacit pay's Ethereum page, the keeper page): "Change account" opens the wallet's own
//     chooser and the page follows the account it answers; a wallet without a chooser is told to choose in itself; Disconnect hands the permission back, so
//     the next Connect asks, and it works the same with a wallet that cannot take it back;
//   · a second press on Connect while the wallet's prompt is open asks the wallet nothing more, and the chip says it is waiting;
//   · a wallet connected or disconnected in one tab is connected or disconnected in the others.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/wallet-change.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const WEB = 23300 + Math.floor(Math.random() * 90);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const A = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', B = '0x1234567890abcdef1234567890abcdef12345678';
const SHORT_A = '0xabcd…abcd', SHORT_B = '0x1234…5678';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const until = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });

// The wallet. Its two accounts, whether it has been allowed this site, and which account is chosen are kept in localStorage, as a wallet keeps them across a
// reload and for every tab; `window.__cfg` says what it can do and `window.__hold` makes the account prompt wait. `__walletEmit` is the wallet telling a page.
const WALLET = `(() => {
  const ACC = ${JSON.stringify([A, B])}, L = {};
  const cfg = window.__cfg = { chooser: true, revoke: true, hold: null };
  const at = () => Number(localStorage.getItem('stub-at') || 0), cur = () => ACC[at()];
  const emit = (ev, ...a) => (L[ev] || []).forEach((f) => f(...a));
  window.__walletEmit = emit;
  const no = (m) => Object.assign(new Error('The method ' + m + ' does not exist'), { code: -32601 });
  const provider = { async request({ method }) {
    window.__log(method);
    if (method === 'eth_requestAccounts') { if (cfg.hold) await cfg.hold; localStorage.setItem('stub-allowed', '1'); return [cur()]; }
    if (method === 'eth_accounts') return localStorage.getItem('stub-allowed') ? [cur()] : [];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'wallet_requestPermissions') {
      if (!cfg.chooser) throw no(method);
      localStorage.setItem('stub-at', String((at() + 1) % ACC.length));
      setTimeout(() => emit('accountsChanged', [cur()]), 5);
      return [{ parentCapability: 'eth_accounts' }];
    }
    if (method === 'wallet_revokePermissions') {
      if (!cfg.revoke) throw no(method);
      localStorage.removeItem('stub-allowed');
      setTimeout(() => emit('accountsChanged', []), 5);
      return null;
    }
    throw Object.assign(new Error('stub: ' + method), { code: -32601 }); },
    on(ev, f) { (L[ev] ||= []).push(f); }, removeListener(ev, f) { L[ev] = (L[ev] || []).filter((x) => x !== f); } };
  window.ethereum = provider;
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'main', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', say); say();
})();`;

const browser = await chromium.launch();
async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light' });
  const calls = [];
  await ctx.exposeFunction('__log', (m) => { calls.push(m); });
  await ctx.addInitScript(WALLET);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  return { ctx, calls, asked: (m) => calls.filter((c) => c === m).length, clear: () => { calls.length = 0; } };
}
async function open(ctx, path) {
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource|net::|ERR_FAILED/.test(t)) errors.push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}${path}`);
  return { page, errors, blocked };
}
// The wallet has been allowed this site and was connected last, as after a connect on any page (so a page finds it on load).
async function seed(ctx, { account = 0 } = {}) {
  const page = await ctx.newPage();
  await page.route('**/__seed', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
  await page.goto(`http://127.0.0.1:${WEB}/__seed`);
  await page.evaluate((i) => { localStorage.setItem('stub-allowed', '1'); localStorage.setItem('stub-at', String(i)); localStorage.setItem('tacit-trade-wallet', 'test.wallet'); }, account);
  await page.close();
}
const label = (p) => p.evaluate(() => document.querySelector('#wallet-label')?.textContent.replace(/\s+/g, ' ').trim() || '');
const showing = (p, text) => until(p, (t) => document.querySelector('#wallet-label')?.textContent.includes(t), text, 20000).then(() => true, () => false);
const idle = (p, re) => until(p, (s) => new RegExp(s).test(document.querySelector('#wallet-label')?.textContent || ''), re.source, 20000).then(() => true, () => false);
const remembered = (p) => p.evaluate(() => localStorage.getItem('tacit-trade-wallet'));
const cfg = (p, o) => p.evaluate((x) => Object.assign(window.__cfg, x), o);

try {
  // ── the trade pages' wallet: rewards ──────────────────────────────────────────────────────────────────────────────
  let c = await newContext();
  let { page, errors, blocked } = await open(c.ctx, '/rewards/');
  await page.waitForSelector('#wallet-chip');

  // a second press while the wallet's prompt is open asks it nothing more, and the chip says it is waiting
  await page.evaluate(() => { window.__cfg.hold = new Promise((r) => { window.__release = r; }); });
  await page.evaluate(() => document.querySelector('#wallet-chip').click());
  await page.waitForSelector('.bsheet.top .picker');
  await page.evaluate(() => document.querySelector('#wallet-chip').click());
  await page.waitForTimeout(200);
  ok((await page.$$('.bsheet.top .picker')).length === 1, 'a second press on Connect while the wallet choice is open opens nothing more');
  await page.click('.bsheet.top .picker .way:has-text("Test Wallet")');
  await until(page, () => document.querySelector('#wallet-chip').hasAttribute('aria-busy'), null, 5000).catch(() => {});
  ok(await page.$eval('#wallet-chip', (e) => e.hasAttribute('aria-busy') && /Waiting/.test(e.getAttribute('aria-label')) && e.querySelector('#wallet-dot').classList.contains('warn')), 'while the wallet\'s prompt is open the chip says it is waiting (busy, orange dot) and keeps its label');
  ok((await label(page)) === 'Connect', 'and its text does not move the header');
  await page.evaluate(() => { document.querySelector('#wallet-chip').click(); document.querySelector('#wallet-chip').click(); });
  await page.waitForTimeout(300);
  ok(c.asked('eth_requestAccounts') === 1, `presses on the chip meanwhile ask the wallet nothing (asked ${c.asked('eth_requestAccounts')} time)`);
  await page.evaluate(() => window.__release());
  ok(await showing(page, SHORT_A), 'the prompt answered, the account shows');
  ok(await page.$eval('#wallet-chip', (e) => !e.hasAttribute('aria-busy') && /Wallet 0xabcd/.test(e.getAttribute('aria-label'))) && !(await page.$eval('#wallet-dot', (e) => e.classList.contains('warn'))), 'and the chip is no longer waiting');

  // Change account: the wallet's own chooser, and the page follows
  await page.click('#wallet-chip');
  await page.waitForSelector('.bsheet.top [data-change]');
  ok(/Change account/.test(await page.textContent('.bsheet.top')), 'the account sheet offers Change account');
  c.clear();
  await page.click('.bsheet.top [data-change]');
  ok(await showing(page, SHORT_B), 'Change account opens the wallet\'s chooser and the chip follows the account it answers');
  ok(c.asked('wallet_requestPermissions') === 1 && c.asked('eth_requestAccounts') === 0, `it asked the chooser, not a new connection (${c.calls.join(' ')})`);

  // a wallet without a chooser is told to choose in itself, and the page follows when it does
  await cfg(page, { chooser: false });
  await page.click('#wallet-chip');
  await page.click('.bsheet.top [data-change]');
  await until(page, () => /Choose another account in your wallet/.test(document.body.innerText), null, 5000).catch(() => {});
  ok(/Choose another account in your wallet/.test(await page.evaluate(() => document.body.innerText)) && (await label(page)) === SHORT_B, 'a wallet without a chooser is told to choose in itself, and nothing changes');
  await page.evaluate((a) => { localStorage.setItem('stub-at', '0'); window.__walletEmit('accountsChanged', [a]); }, A);
  ok(await showing(page, SHORT_A), 'and when it does, the page follows');
  await cfg(page, { chooser: true });

  // Disconnect hands the permission back; the next Connect asks
  await page.click('#wallet-chip');
  await page.click('.bsheet.top [data-leave]');
  ok(await idle(page, /^Connect$/), 'Disconnect puts the page back to asking for a wallet');
  ok(c.asked('wallet_revokePermissions') === 1, 'and handed the site\'s permission back to the wallet');
  ok((await remembered(page)) === null, 'no page is left to connect it again on load');
  await page.reload(); await page.waitForSelector('#wallet-chip'); await page.waitForTimeout(1200);
  ok((await label(page)) === 'Connect', 'a reload stays disconnected');
  c.clear();
  await page.click('#wallet-chip');
  await page.click('.bsheet.top .picker .way:has-text("Test Wallet")');
  ok((await showing(page, SHORT_A)) && c.asked('eth_requestAccounts') === 1, 'and the next Connect asks the wallet again (it shows its prompt)');

  // a wallet that cannot take the permission back is let go of all the same
  await cfg(page, { revoke: false });
  await page.click('#wallet-chip');
  await page.click('.bsheet.top [data-leave]');
  ok(await idle(page, /^Connect$/) && (await remembered(page)) === null, 'a wallet without wallet_revokePermissions is let go of all the same');
  ok(!errors.length && !blocked.length, `no page errors or blocked requests (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
  await page.close();

  // ── the vault page has the same wallet (it used to carry a copy of its own) ─────────────────────────────────────────
  await seed(c.ctx, { account: 0 });
  ({ page, errors, blocked } = await open(c.ctx, '/vault/'));
  ok(await showing(page, SHORT_A), 'the vault page arrives connected to the wallet connected last');
  await page.click('#wallet-chip');
  await page.waitForSelector('.bsheet.top [data-change]');
  c.clear();
  await page.click('.bsheet.top [data-change]');
  ok(await showing(page, SHORT_B) && c.asked('wallet_requestPermissions') === 1, 'and Change account works there too');
  ok(!errors.length && !blocked.length, `no page errors or blocked requests on the vault page (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
  await page.close();
  await c.ctx.close();

  // ── tabs: a wallet connected or disconnected in one is connected or disconnected in the others ────────────────────
  c = await newContext();
  const t1 = await open(c.ctx, '/rewards/'), t2 = await open(c.ctx, '/vault/');
  await t1.page.waitForSelector('#wallet-chip'); await t2.page.waitForSelector('#wallet-chip');
  await t1.page.waitForTimeout(800);
  await t1.page.click('#wallet-chip');
  await t1.page.click('.bsheet.top .picker .way:has-text("Test Wallet")');
  ok(await showing(t1.page, SHORT_A), 'connected in one tab');
  ok(await showing(t2.page, SHORT_A), 'the other tab shows it connected, with no prompt');
  ok(c.asked('eth_requestAccounts') === 1, 'it asked the wallet for the accounts already allowed, not to connect');
  await t1.page.click('#wallet-chip');
  await t1.page.click('.bsheet.top [data-leave]');
  ok(await idle(t2.page, /^Connect$/), 'disconnected in one tab, the other tab is disconnected too');
  await t1.page.close(); await t2.page.close();
  await c.ctx.close();

  // ── the front page's wallet: front page, tacit pay's Ethereum page, the keeper page ───────────────────────────────
  const EVM = {
    front: { path: '/', chip: '#wallet', sheet: '#sheet-wallet', change: '[data-wc-change]', off: '[data-wc-off]' },
    eth: { path: '/pay/eth/', chip: '#wallet', sheet: '#sheet-wallet', change: '#w-wc-change', off: '#w-wc-off' },
    keeper: { path: '/prove/#tab=bitcoin', chip: '#wallet', sheet: '#sheet-wc', change: '[data-change]', off: '[data-off]' },
    hub: { path: '/pay/', chip: '#wallet', sheet: '#sheet-wallet', off: '#w-wc-off' },
  };
  for (const [k, P] of Object.entries(EVM)) {
    c = await newContext();
    await seed(c.ctx, { account: 0 });
    ({ page, errors, blocked } = await open(c.ctx, P.path));
    ok(await showing(page, SHORT_A), `${k}: arrives connected to the wallet connected last`);
    await page.click(P.chip);
    await page.waitForSelector(`${P.sheet} ${P.off}`, { state: 'visible' });
    if (P.change) {
      ok(/Change account/.test(await page.textContent(P.sheet)), `${k}: the wallet sheet offers Change account`);
      c.clear();
      await page.click(`${P.sheet} ${P.change}`);
      ok(await showing(page, SHORT_B), `${k}: Change account opens the wallet's chooser and the page follows the account it answers`);
      ok(c.asked('wallet_requestPermissions') === 1 && c.asked('eth_requestAccounts') === 0, `${k}: it asked the chooser, not a new connection (${c.calls.join(' ')})`);
      await page.click(P.chip).catch(() => {});
      await page.waitForSelector(`${P.sheet} ${P.off}`, { state: 'visible' }).catch(() => {});
    }
    c.clear();
    await page.click(`${P.sheet} ${P.off}`);
    ok(await idle(page, P.sheet === '#sheet-wc' ? /Connect/ : /Sign in|Open wallet/), `${k}: Disconnect puts the page back to asking for a wallet (${await label(page)})`);
    ok(c.asked('wallet_revokePermissions') === 1 && (await remembered(page)) === null, `${k}: it handed the permission back and no page connects it again on load`);
    await page.reload(); await page.waitForTimeout(1500);
    ok(await idle(page, P.sheet === '#sheet-wc' ? /Connect/ : /Sign in|Open wallet/), `${k}: and a reload stays disconnected`);
    ok(c.asked('eth_requestAccounts') === 0, `${k}: and a reload shows the wallet no prompt`);
    ok(!errors.length && !blocked.length, `${k}: no page errors or blocked requests (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
    await c.ctx.close();
  }

  // tabs, on the front page's wallet: the keeper page follows a Disconnect on the front page, and both follow a connect made in a third tab
  c = await newContext();
  await seed(c.ctx, { account: 0 });
  const f = await open(c.ctx, '/'), kp = await open(c.ctx, '/prove/#tab=bitcoin');
  ok((await showing(f.page, SHORT_A)) && (await showing(kp.page, SHORT_A)), 'two tabs of the front page\'s wallet are connected');
  await f.page.click('#wallet');
  await f.page.waitForSelector('#sheet-wallet [data-wc-off]', { state: 'visible' });
  await f.page.click('#sheet-wallet [data-wc-off]');
  ok(await idle(kp.page, /Connect/), 'a Disconnect in one tab disconnects the other');
  c.clear();
  await seed(c.ctx, { account: 1 });
  ok((await showing(f.page, SHORT_B)) && (await showing(kp.page, SHORT_B)), 'and a wallet connected in a third tab is connected in both, with the account it allows');
  ok(c.asked('eth_requestAccounts') === 0, 'with no prompt');
  await c.ctx.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 5).join(' / '));
} finally { await browser.close(); server.close(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} wallet-change checks passed`);
process.exit(fails ? 1 : 0);
