#!/usr/bin/env node
// A wallet connected on one tacit.finance page is connected on the next, without a prompt: the front page, tacit pay (the hub and its
// Ethereum page), the keeper page and the trade pages all find the wallet connected last (one record in this browser, which wallet only)
// and ask it for the accounts it already allows. Disconnect on any of them ends it for all. In a real browser under each page's own
// CSP, with a browser wallet that counts what it is asked; no network.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/wallet-restore.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { useWcFake } from './wc-fake.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;           // DAPP=<another build of dapp//> to run the same checks against it
const WEB = 23100 + Math.floor(Math.random() * 90);
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

// A browser wallet that announces itself through EIP-6963 (a second one, `other`, announces before it). It allows this site once
// asked (kept across a reload, as a wallet does), says which of its methods were called, and keeps the listeners the page adds.
const wallet = ({ uuid, name, rdns, account, announce = true, inject = false }) => `(() => {
  const key = 'stub-allowed-${uuid}', listeners = {};
  const provider = { async request({ method }) {
    window.__log('${uuid}:' + method);
    if (method === 'eth_requestAccounts') { localStorage.setItem(key, '1'); return [window.__account_${uuid} || '${account}']; }
    if (method === 'eth_accounts') return localStorage.getItem(key) ? [window.__account_${uuid} || '${account}'] : [];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') return '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b';
    throw Object.assign(new Error('stub: ' + method), { code: -32601 }); },
    on(ev, f) { (listeners[ev] ||= []).push(f); }, removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); } };
  window.__emit_${uuid} = (ev, ...a) => (listeners[ev] || []).forEach((f) => f(...a));
  ${inject ? 'window.ethereum = provider;' : ''}
  ${announce ? `const detail = Object.freeze({ info: Object.freeze({ uuid: '${uuid}', name: '${name}', icon: '', rdns: '${rdns}' }), provider });
  const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', say); say();` : ''}
})();`;
const MAIN = wallet({ uuid: 'main', name: 'Test Wallet', rdns: 'test.wallet', account: A, inject: true });
const OTHER = wallet({ uuid: 'other', name: 'Other Wallet', rdns: 'other.wallet', account: B });
const BARE = wallet({ uuid: 'bare', name: 'x', rdns: 'x', account: A, announce: false, inject: true });

const browser = await chromium.launch();
async function newContext(wallets, { phone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light', ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  const calls = [];
  await ctx.exposeFunction('__log', (m) => { calls.push(m); });
  for (const w of wallets) await ctx.addInitScript(w);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  // nor does a WebSocket (the pages dial public Nostr relays) leave it: closed at once, as a relay that is down would
  await ctx.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1|localhost)/, (ws) => ws.close());
  // the computer's own prover (a page may look for it): never this machine's real one
  await ctx.route('http://127.0.0.1:47815/**', (r) => r.abort('connectionrefused'));
  return { ctx, calls, asked: (m) => calls.filter((c) => c.endsWith(':' + m)).length };
}
async function open(ctx, path) {
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  // a request that could not leave the machine, or a public relay (a WebSocket, which the route above does not catch) that is down, is not the page's error
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource|net::|ERR_FAILED|WebSocket connection to 'wss?:\/\/(?!127\.0\.0\.1|localhost)/.test(t)) errors.push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}${path}`);
  return { page, errors, blocked };
}
// Each page: where it is, its header chip's label and dot, and how Disconnect is reached when no key is open.
const PAGES = {
  front: { path: '/', label: '#wallet-label', dot: '#wallet-dot', chip: '#wallet', sheet: '#sheet-wallet', off: '[data-wc-off]', idle: /Sign in|Open wallet/ },
  hub: { path: '/pay/', label: '#wallet-label', dot: '#wallet-dot', chip: '#wallet', sheet: '#sheet-wallet', off: '#w-wc-off', idle: /Sign in|Open wallet/ },
  eth: { path: '/pay/eth/', label: '#wallet-label', dot: '#wallet-dot', chip: '#wallet', sheet: '#sheet-wallet', off: '#w-wc-off', idle: /Sign in|Open wallet/ },
  keeper: { path: '/prove/#tab=bitcoin', label: '#wallet-label', dot: '#wallet-dot', chip: '#wallet', sheet: '#sheet-wc', off: '[data-off]', idle: /Connect/, bare: true },
  rewards: { path: '/rewards/', label: '#wallet-label', dot: '#wallet-dot', chip: '#wallet-chip', trade: true, idle: /Connect/ },
};
const label = (p, k) => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', PAGES[k].label);
const dotClass = (p, k) => p.evaluate((s) => document.querySelector(s)?.className || '', PAGES[k].dot);
const showing = (p, k, text) => until(p, ([s, t]) => document.querySelector(s)?.textContent.includes(t), [PAGES[k].label, text], 20000).then(() => true, () => false);
const remembered = (p) => p.evaluate(() => localStorage.getItem('tacit-trade-wallet'));

try {
  // ── nothing remembered: no page so much as asks the wallet ──────────────────────────────────────────────────────
  let c = await newContext([MAIN]);
  for (const k of ['front', 'hub', 'eth', 'keeper', 'rewards']) {
    const { page, errors, blocked } = await open(c.ctx, PAGES[k].path);
    await page.waitForSelector(PAGES[k].chip);
    await page.waitForTimeout(1500);
    ok(PAGES[k].idle.test(await label(page, k)) && !c.calls.length, `${k}: with no wallet remembered the chip offers a way in and the wallet is not asked anything (${await label(page, k)}; ${c.calls.join(' ') || 'no calls'})`);
    ok(!blocked.length && !errors.length, `${k}: no page errors or blocked requests (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
    await page.close();
  }

  // ── connect on the rewards page (the trade pages' wallet) → every other page has it ─────────────────────────────
  {
    const { page } = await open(c.ctx, PAGES.rewards.path);
    await page.click('#wallet-chip');
    await page.click('.bsheet.top .picker .way:has-text("Test Wallet")');            // WalletConnect is on offer beside it, so the page asks which
    ok(await showing(page, 'rewards', SHORT_A), 'rewards: Connect, choosing the wallet, connects it');
    ok((await remembered(page)) === 'test.wallet' && c.asked('eth_requestAccounts') === 1, `the record names the wallet, not an account (${await remembered(page)})`);
    await page.close();
  }
  for (const k of ['front', 'hub', 'eth', 'keeper']) {
    c.calls.length = 0;
    const { page, errors, blocked } = await open(c.ctx, PAGES[k].path);
    ok(await showing(page, k, SHORT_A), `${k}: arrives connected to the wallet connected on the rewards page (${await label(page, k)})`);
    ok(c.asked('eth_requestAccounts') === 0 && c.asked('personal_sign') === 0 && c.asked('eth_accounts') >= 1, `${k}: it asked for the accounts already allowed and showed no prompt, signed nothing (${c.calls.join(' ')})`);
    ok(/live|on/.test(await dotClass(page, k)), `${k}: the dot says a wallet is connected (${await dotClass(page, k)})`);
    ok(!blocked.length && !errors.length, `${k}: no page errors or blocked requests (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
    await page.close();
  }

  // ── arriving connected barely moves the header (the account is wider than "Sign in", so the right-hand group grows leftward), on a phone or at a desktop ──
  for (const [w, h] of [[390, 844], [1280, 900]]) {
    for (const k of ['front', 'hub', 'eth', 'keeper']) {
      const page = await c.ctx.newPage();
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript(() => {
        window.__moved = [];
        new PerformanceObserver((list) => { for (const e of list.getEntries()) for (const s of e.sources || []) { const el = s.node?.nodeType === 3 ? s.node.parentElement : s.node; if (el?.closest?.('header') && !e.hadRecentInput) window.__moved.push(e.value); } }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(`http://127.0.0.1:${WEB}${PAGES[k].path}`);
      await showing(page, k, SHORT_A);
      await page.waitForTimeout(800);
      const moved = (await page.evaluate(() => window.__moved)).reduce((a, b) => a + b, 0);
      ok(moved <= 0.04, `${k} at ${w}px: the chip changing to the account shifts the header by ${moved.toFixed(3)}, within the 0.04 every page keeps to`);
      await page.close();
    }
  }

  // ── the wallet moves to another account: the chip follows ───────────────────────────────────────────────────────
  for (const k of ['front', 'hub', 'eth', 'keeper']) {
    const { page } = await open(c.ctx, PAGES[k].path);
    await showing(page, k, SHORT_A);
    await page.evaluate((b) => window.__emit_main('accountsChanged', [b]), B);
    ok(await showing(page, k, SHORT_B), `${k}: the wallet switching accounts changes the chip (${await label(page, k)})`);
    await page.evaluate(() => window.__emit_main('accountsChanged', []));
    await until(page, ([s, t]) => !document.querySelector(s)?.textContent.includes(t), [PAGES[k].label, SHORT_B], 5000).catch(() => {});
    ok(!(await label(page, k)).includes('0x'), `${k}: and the wallet locking puts it back (${await label(page, k)})`);
    await page.close();
  }

  // ── Disconnect on a page ends it everywhere ─────────────────────────────────────────────────────────────────────
  for (const k of ['front', 'hub', 'eth', 'keeper']) {
    // connected again by the rewards page, which remembers it
    { const { page } = await open(c.ctx, PAGES.rewards.path); await page.waitForSelector('#wallet-chip'); await page.waitForTimeout(500); if (!(await showing(page, 'rewards', SHORT_A))) { await page.click('#wallet-chip'); await page.click('.bsheet.top .picker .way:has-text("Test Wallet")'); await showing(page, 'rewards', SHORT_A); } await page.close(); }
    const { page } = await open(c.ctx, PAGES[k].path);
    await showing(page, k, SHORT_A);
    await page.click(PAGES[k].chip);
    await page.waitForSelector(`${PAGES[k].sheet}[open] ${PAGES[k].off}`);
    ok(true, `${k}: the wallet sheet offers Disconnect for a browser wallet`);
    await page.click(`${PAGES[k].sheet}[open] ${PAGES[k].off}`);
    await until(page, (s) => !document.querySelector(s)?.textContent.includes('0x'), PAGES[k].label, 10000).catch(() => {});
    ok(PAGES[k].idle.test(await label(page, k)) && (await remembered(page)) === null, `${k}: Disconnect puts the chip back to a way in and forgets the wallet (${await label(page, k)})`);
    await page.close();
    c.calls.length = 0;
    const again = await open(c.ctx, PAGES.eth.path);
    await again.page.waitForTimeout(1200);
    ok(PAGES.eth.idle.test(await label(again.page, 'eth')) && !c.calls.length, `${k}: another page, opened after, stays disconnected and does not ask the wallet (${await label(again.page, 'eth')}; ${c.calls.join(' ') || 'no calls'})`);
    await again.page.close();
    const rw = await open(c.ctx, PAGES.rewards.path); await rw.page.waitForTimeout(800);
    ok(PAGES.rewards.idle.test(await label(rw.page, 'rewards')), `${k}: and the trade pages stay disconnected too`);
    await rw.page.close();
  }
  // ── with a key open the wallet is still a row of its own, and Disconnect lets go of the wallet but not the key ─────────────────
  c.calls.length = 0;
  for (const k of ['front', 'hub', 'eth']) {
    { const { page } = await open(c.ctx, PAGES.rewards.path); await page.waitForTimeout(500); if (!(await showing(page, 'rewards', SHORT_A))) { await page.click('#wallet-chip'); await page.click('.bsheet.top .picker .way:has-text("Test Wallet")'); await showing(page, 'rewards', SHORT_A); } await page.close(); }
    const { page } = await open(c.ctx, PAGES[k].path);
    await showing(page, k, SHORT_A);
    await page.click(PAGES[k].chip);
    await page.waitForSelector(`${PAGES[k].sheet}[open] [data-in="paste"]`);
    await page.click(`${PAGES[k].sheet}[open] [data-in="paste"]`);
    await page.fill(`${PAGES[k].sheet}[open] #ws-hex`, '11'.repeat(32));
    await page.click(`${PAGES[k].sheet}[open] [data-in="key"]`);
    await until(page, (s) => /^(tacit1|Opening)/.test(document.querySelector(s)?.textContent.trim()), PAGES[k].label, 30000);
    if (await page.$(`${PAGES[k].sheet}[open]`)) await page.keyboard.press('Escape');
    await page.click(PAGES[k].chip);
    await page.waitForSelector(`${PAGES[k].sheet}[open] ${PAGES[k].off}`);
    ok(true, `${k}: with a key open the sheet still shows the wallet, with Disconnect`);
    await page.click(`${PAGES[k].sheet}[open] ${PAGES[k].off}`);
    await until(page, (s) => !document.querySelector(`${s} ${'[data-wc-off], #w-wc-off'}`), PAGES[k].sheet, 10000).catch(() => {});
    ok((await remembered(page)) === null && /^(tacit1|Opening)/.test((await label(page, k)).trim()), `${k}: Disconnect forgets the wallet and the key stays open (${await label(page, k)})`);
    await page.close();
  }
  ok(c.asked('personal_sign') === 0, 'no signature was asked of the wallet for any of it');

  await c.ctx.close();

  // ── connect on the keeper page (this layer) → the trade pages have it ───────────────────────────────────────────
  c = await newContext([MAIN]);
  {
    const { page } = await open(c.ctx, PAGES.keeper.path);
    await page.click('#wallet');
    ok(await showing(page, 'keeper', SHORT_A) && (await remembered(page)) === 'test.wallet', `keeper: Connect shows the account and records which wallet (${await remembered(page)})`);
    await page.close();
    const rw = await open(c.ctx, PAGES.rewards.path);
    ok(await showing(rw.page, 'rewards', SHORT_A) && c.asked('eth_requestAccounts') === 1, 'rewards: arrives connected to the wallet connected on the keeper page, with no new prompt');
    await rw.page.close();
  }

  // ── a wallet that no longer allows the site: nothing shown, nothing asked of the person ─────────────────────────
  {
    const probe = await open(c.ctx, PAGES.front.path);
    await probe.page.evaluate(() => localStorage.removeItem('stub-allowed-main'));              // revoked in the wallet's own settings
    await probe.page.close();
    c.calls.length = 0;
    for (const k of ['front', 'hub', 'eth', 'keeper']) {
      const { page } = await open(c.ctx, PAGES[k].path);
      await page.waitForTimeout(1500);
      ok(!(await label(page, k)).includes('0x'), `${k}: a wallet that revoked the site is not shown as connected (${await label(page, k)})`);
      await page.close();
    }
    ok(c.asked('eth_requestAccounts') === 0, `and none showed a prompt for it (${c.calls.join(' ')})`);
  }
  await c.ctx.close();

  // ── two wallets: the one connected last, not the first to announce ──────────────────────────────────────────────
  c = await newContext([OTHER, MAIN]);
  {
    await (await c.ctx.newPage()).goto(`http://127.0.0.1:${WEB}/pay/eth/`);
    await c.ctx.pages()[0].evaluate(() => { localStorage.setItem('tacit-trade-wallet', 'test.wallet'); localStorage.setItem('stub-allowed-main', '1'); localStorage.setItem('stub-allowed-other', '1'); });
    await c.ctx.pages()[0].close();
    c.calls.length = 0;
    for (const k of ['front', 'hub', 'eth', 'keeper']) {
      const { page } = await open(c.ctx, PAGES[k].path);
      ok(await showing(page, k, SHORT_A), `${k}: with two wallets in the browser the one connected last is the one connected (${await label(page, k)})`);
      await page.close();
    }
    ok(c.calls.every((m) => m.startsWith('main:')), `and the other wallet was never asked (${[...new Set(c.calls)].join(' ')})`);
  }
  await c.ctx.close();

  // ── a wallet's own browser: window.ethereum and no announcement ─────────────────────────────────────────────────
  c = await newContext([BARE]);
  {
    const first = await open(c.ctx, PAGES.keeper.path);
    await first.page.click('#wallet');
    ok(await showing(first.page, 'keeper', SHORT_A) && (await remembered(first.page)) === 'Browser wallet', `keeper: a wallet that announces nothing is recorded as the browser's wallet (${await remembered(first.page)})`);
    await first.page.close();
    for (const k of ['front', 'hub', 'eth']) {
      const { page } = await open(c.ctx, PAGES[k].path);
      ok(await showing(page, k, SHORT_A), `${k}: and is connected on arrival (${await label(page, k)})`);
      await page.close();
    }
  }
  await c.ctx.close();

  // ── a wallet app through WalletConnect: paired on one page, kept for all (the bundle is a stand-in, tests/wc-fake.mjs) ──────────────
  c = await newContext([]);
  await useWcFake(c.ctx, { account: B });
  {
    const rw = await open(c.ctx, PAGES.rewards.path);
    await rw.page.click('#wallet-chip');
    await rw.page.waitForSelector('.bsheet.top .wc-qr svg');
    await rw.page.evaluate(() => window.__wcfake.approve());
    ok(await showing(rw.page, 'rewards', SHORT_B), 'rewards: a wallet app pairs');
    ok((await remembered(rw.page)) === 'com.walletconnect', 'and WalletConnect is the wallet recorded');
    const asked = await rw.page.evaluate(() => window.__wcfake.opts.optionalChains);
    ok([1, 8453, 4663].every((id) => asked.includes(id)), `it was asked for every chain the site works on (${asked.join(', ')})`);
    await rw.page.close();
    for (const k of ['front', 'hub', 'eth', 'keeper']) {
      const { page } = await open(c.ctx, PAGES[k].path);
      ok(await showing(page, k, SHORT_B) && (await page.evaluate(() => window.__wcfake.pairs)) === 0, `${k}: arrives connected to the wallet app through the kept session, with no new pairing (${await label(page, k)})`);
      await page.close();
    }
    const { page } = await open(c.ctx, PAGES.front.path);
    await showing(page, 'front', SHORT_B);
    await page.click(PAGES.front.chip);
    await page.waitForSelector('#sheet-wallet[open] [data-wc-off]');
    await page.click('#sheet-wallet[open] [data-wc-off]');
    await until(page, () => !document.querySelector('#wallet-label').textContent.includes('0x'), null, 10000).catch(() => {});
    ok((await page.evaluate(() => window.__wcfake.disconnected)) === 1 && PAGES.front.idle.test(await label(page, 'front')) && (await remembered(page)) === null, 'front: Disconnect ends the session in the wallet app and forgets it');
    await page.close();
    const after = await open(c.ctx, PAGES.rewards.path);
    await after.page.waitForTimeout(800);
    ok(PAGES.rewards.idle.test(await label(after.page, 'rewards')), 'and the other pages are no longer connected');
  }
  await c.ctx.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${fails ? `${fails} failed` : 'all passed'} (${n} checks)`);
process.exit(fails ? 1 : 0);
