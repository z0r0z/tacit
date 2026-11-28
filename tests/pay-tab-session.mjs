// The Pay pages' ETH, TAC and BTC tabs: a Tacit wallet opened on one of them is open on the next, with no second sign-in, for the length of the tab's session
// (tab-key.js: the tab's own session storage, 30 minutes without use, never localStorage). ETH is /pay/eth/ and TAC and BTC are /pay/, so moving between them loads a page.
//   a pasted key and a passkey open at once; an Ethereum wallet's key opens again with no signature while that wallet answers as the same account, and not when it has moved;
//   Lock on a page lets the next one ask again; another tab never had it; thirty minutes without use lock the page and let the saved key go.
// Every request that leaves the machine is answered by a stand-in. The keys are made here and thrown away.
//   PLAYWRIGHT=<path to playwright-core> node tests/pay-tab-session.mjs        (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { keccak_256, secp, hexToBytes, bytesToHex, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = (process.env.DAPP || new URL('../dapp/', import.meta.url).pathname).replace(/\/?$/, '/');      // DAPP=<another build of dapp/> runs the same checks against it
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(DAPP, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(DAPP) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;      // localhost: a secure context, and a name a passkey can be tied to

const browser = await chromium.launch();
let pass = 0, fail = 0;
const test = async (label, fn) => {
  if (process.env.ONLY && !label.includes(process.env.ONLY)) return;      // ONLY=<part of a test's name> runs just those
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const rpcAnswer = (method) => {
  switch (method) {
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return '0x1c9c380';
    case 'eth_getBalance': return '0x0';
    case 'eth_getLogs': return [];
    case 'eth_gasPrice': return '0x5f5e100';
    case 'eth_getBlockByNumber': return { number: '0x1c9c380', timestamp: '0x6a000000', baseFeePerGas: '0x5f5e100', transactions: [] };
    default: return '0x';
  }
};
const json = (route, status, body) => route.fulfill({ status, headers: H, contentType: 'application/json', body: JSON.stringify(body) });
// the nodes, the explorers and the services, answered with the least that keeps a page going: an empty chain and an empty pool
async function stub(ctx) {
  await ctx.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)[:/])/, async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: H });
    if (req.method() === 'POST') {
      let body = null; try { body = req.postDataJSON(); } catch { /* not JSON */ }
      const one = (b) => ({ jsonrpc: '2.0', id: b?.id ?? 1, result: rpcAnswer(b?.method) });
      if (body) return json(route, 200, Array.isArray(body) ? body.map(one) : one(body));
    }
    if (/\/blocks\/tip\/height/.test(url.pathname)) return route.fulfill({ status: 200, headers: H, contentType: 'text/plain', body: '970600' });
    if (/\/address\/|\/scripthash\//.test(url.pathname)) return json(route, 200, []);
    if (/tacit-btc-pool-mainnet\.onrender\.com$/.test(url.hostname)) {
      if (url.pathname === '/btc-pool/status') return json(route, 200, { height: 970600, halted: false });
      if (url.pathname === '/btc-pool/notes') return json(route, 200, { notes: [], next: 0 });
      if (url.pathname === '/btc-pool/nullifiers') return json(route, 200, { nullifiers: [], next: null });
      if (url.pathname === '/sp/hints') return json(route, 200, { hints: [], next: null });
    }
    return json(route, 404, {});
  });
}

// An Ethereum wallet that announces itself the way wallets do (EIP-6963) and signs for real, so the page can open the Tacit wallet with it. The account it answers as
// is the one in localStorage 'stub-acct' (this test moves it between pages).
const WALLET_KEY = hexToBytes(randomBytes(32).toString('hex'));
const WALLET_ADDR = '0x' + bytesToHex(keccak_256(secp.getPublicKey(WALLET_KEY, false).slice(1)).slice(12));
const OTHER_ADDR = '0x' + '5e'.repeat(20);
const WALLET_SCRIPT = (addr) => {
  const acct = () => { try { return localStorage.getItem('stub-acct') || addr; } catch { return addr; } };
  const provider = { async request({ method, params = [] }) {
    switch (method) {
      case 'eth_accounts': return [acct()];
      case 'eth_requestAccounts': return [acct()];
      case 'eth_chainId': return '0x1';
      case 'personal_sign': return window.__sign(params[0]);
      case 'wallet_switchEthereumChain': return null;
      case 'wallet_requestPermissions': case 'wallet_revokePermissions': return [];
      default: throw Object.assign(new Error('unsupported ' + method), { code: 4200 });
    }
  }, on() {}, removeListener() {} };
  const info = { uuid: '00000000-0000-4000-8000-000000000001', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'test.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};
// whether the sign-in options were ever drawn on a page (a page that opens the key by itself never draws them)
const GATE_WATCH = () => {
  window.__gate = false;
  new MutationObserver(() => { if (document.getElementById('g-in')) window.__gate = true; }).observe(document, { childList: true, subtree: true });
};

async function open({ passkey = false, wallet = false, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 980 } });
  const probe = { signs: 0, gets: 0 };
  await ctx.exposeFunction('__sign', async (msgHex) => {
    probe.signs++;
    const msg = hexToBytes(msgHex.replace(/^0x/, ''));
    const sig = await secp.signAsync(keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), msg)), WALLET_KEY);
    return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16);
  });
  await ctx.exposeFunction('__got', () => { probe.gets++; });
  await ctx.addInitScript(GATE_WATCH);
  await ctx.addInitScript(() => { const g = navigator.credentials?.get?.bind(navigator.credentials); if (g) navigator.credentials.get = (...a) => { window.__got(); return g(...a); }; });
  if (wallet) await ctx.addInitScript(WALLET_SCRIPT, WALLET_ADDR);
  if (clock) await ctx.clock.install();
  await stub(ctx);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push('csp ' + m.text()); });
  if (passkey) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  }
  await page.goto(base + '/pay/eth/');
  return { ctx, page, problems, probe };
}

const chipText = (page) => page.evaluate(() => (document.querySelector('#wallet-label .wide')?.textContent || document.querySelector('#wallet-label')?.textContent || '').trim());
const opened = (page) => page.waitForFunction(() => /tacit1/.test(document.querySelector('#wallet-label')?.textContent || '') && document.body.classList.contains('in'), null, { timeout: 60000 });
const asks = (page) => page.waitForSelector('#form #g-in', { timeout: 60000 });
const gateSeen = (page) => page.evaluate(() => window.__gate);
const stored = (page) => page.evaluate(() => sessionStorage.getItem('tacit-tab-key-v1'));

// the three ways into a Tacit wallet that need no Ethereum wallet, on a page that shows its sign-in options
async function pasteKey(page, key) {
  await asks(page);
  await page.locator('#form summary', { hasText: 'Other ways to sign in' }).click();
  await page.locator('#form button[data-in="paste"]').click();
  await page.fill('#g-hex', key);
  await page.locator('#form button[data-in="key"]').click();
  await opened(page);
}
async function newPasskey(page) {
  await asks(page);
  await page.locator('#form summary', { hasText: 'Other ways to sign in' }).click();
  await page.locator('#form button[data-in="new"]').click();
  await opened(page);
}
async function ethWallet(page) {
  await asks(page);
  await page.locator('#form button[data-in="eth"]').click();
  await opened(page);
}
// a tab of the strip: ETH is /pay/eth/, TAC and BTC are /pay/ (BTC from TAC is the same page)
async function tab(page, mode) {
  await Promise.all([page.waitForURL(mode === 'eth' ? /\/pay\/eth\// : new RegExp(`/pay/#${mode}`)), page.click(`#modes a[data-mode="${mode}"]`)]);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#wallet-label', { timeout: 60000 });
}
async function sats(page) {
  await page.evaluate(() => localStorage.setItem('tacit-sats-net-v1', 'mainnet'));
  await page.goto(base + '/sats/');
  await page.waitForSelector('#connected:not(.hidden)', { timeout: 60000 });
  assert.equal(await page.locator('#connect:not(.hidden)').count(), 0, 'Sats did not draw its sign-in options');
  assert.match((await page.locator('#w-addr').textContent()) || '', /^(bc1|[13])/, 'Sats adopted the open tab wallet');
}
const newKey = () => { let k; do { k = randomBytes(32); } while (k[0] === 0 || k[0] > 0xf0); return k.toString('hex'); };
const shot = async (page, name) => { if (SHOTS) { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(SHOTS, name + '.png') }); } };

console.log('Pay tabs');
await test('a pasted key: TAC, BTC and back to ETH open with the same wallet, with no sign-in drawn and the key in the tab\'s session only', async () => {
  const { ctx, page, problems } = await open();
  const key = newKey();
  await pasteKey(page, key);
  const me = await chipText(page);
  assert.match(me, /^tacit1/);
  await shot(page, 'paste-eth');
  for (const mode of ['tac', 'btc', 'eth', 'btc']) {
    await tab(page, mode);
    await opened(page);
    assert.equal(await chipText(page), me, `${mode}: the same Tacit address`);
    assert.equal(await page.locator('#g-in').count(), 0, `${mode}: no sign-in options`);
    assert.equal(await gateSeen(page), false, `${mode}: the sign-in options were never drawn on the way in`);
    if (mode === 'tac') await shot(page, 'paste-tac');
  }
  // TAC and BTC are one page: a tab of it keeps the key in memory
  await tab(page, 'tac');
  await opened(page);
  await page.click('#modes a[data-mode="btc"]');
  assert.equal(await page.locator('#g-in').count(), 0);
  assert.equal(await chipText(page), me);
  // the key is in the tab's session and nowhere persistent
  assert.match(await stored(page) || '', new RegExp(key));
  assert.equal(await page.evaluate((k) => Object.keys(localStorage).some((n) => localStorage.getItem(n).includes(k)), key), false, 'the key is in no localStorage entry');
  await sats(page);
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('a passkey: the other tabs open with no second touch', async () => {
  const { ctx, page, problems, probe } = await open({ passkey: true });
  await newPasskey(page);
  const me = await chipText(page), touched = probe.gets;
  for (const mode of ['tac', 'btc', 'eth']) {
    await tab(page, mode);
    await opened(page);
    assert.equal(await chipText(page), me, `${mode}: the same Tacit address`);
    assert.equal(await gateSeen(page), false, `${mode}: the sign-in options were never drawn on the way in`);
  }
  await sats(page);
  assert.equal(probe.gets, touched, 'the passkey was not asked again');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('an Ethereum wallet\'s key: the other tabs open with no signature while the wallet answers as the same account', async () => {
  const { ctx, page, problems, probe } = await open({ wallet: true });
  await ethWallet(page);
  const me = await chipText(page), signed = probe.signs;
  assert.ok(signed >= 1, 'the wallet signed to open it');
  for (const mode of ['tac', 'eth', 'btc']) {
    await tab(page, mode);
    await opened(page);
    assert.equal(await chipText(page), me, `${mode}: the same Tacit address`);
    assert.equal(await gateSeen(page), false, `${mode}: the sign-in options were never drawn on the way in`);
  }
  await sats(page);
  assert.equal(probe.signs, signed, 'the wallet was not asked to sign again');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('an Ethereum wallet that has moved to another account: the next page does not open the key, and lets it go', async () => {
  const { ctx, page } = await open({ wallet: true });
  await ethWallet(page);
  await page.evaluate((a) => localStorage.setItem('stub-acct', a), OTHER_ADDR);
  await page.goto(base + '/pay/#tac');
  await asks(page);
  assert.equal(await stored(page), null, 'the saved key is gone');
  assert.doesNotMatch(await chipText(page), /^tacit1/);
  await ctx.close();
});
await test('Lock on a page: the next page asks again; a tab of its own never had the key', async () => {
  const { ctx, page } = await open();
  await pasteKey(page, newKey());
  const other = await ctx.newPage();
  await other.goto(base + '/pay/#tac');
  await asks(other);
  assert.equal(await stored(other), null, 'a new tab has no session of this one');
  await other.close();
  await tab(page, 'btc');
  await opened(page);
  await page.click('#wallet');
  await page.click('#w-lock');
  assert.equal(await stored(page), null, 'locking lets the saved key go');
  await page.keyboard.press('Escape');
  await page.goto(base + '/pay/eth/');
  await asks(page);
  assert.doesNotMatch(await chipText(page), /^tacit1/);
  await shot(page, 'locked-eth');
  await ctx.close();
});
await test('a reload keeps the wallet open, and thirty minutes without use lock the page and let the saved key go', async () => {
  const { ctx, page } = await open({ clock: true });
  await pasteKey(page, newKey());
  await page.reload();
  await opened(page);
  assert.equal(await gateSeen(page), false, 'a reload opens the same wallet with no sign-in drawn');
  await tab(page, 'tac');
  await opened(page);
  await page.clock.fastForward('31:00');
  await page.waitForFunction(() => /locked after 30 minutes/.test(document.querySelector('#toast-container')?.textContent || ''), null, { timeout: 30000 });
  await asks(page);
  assert.equal(await stored(page), null, 'the saved key is let go');
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
