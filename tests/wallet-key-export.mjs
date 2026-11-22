#!/usr/bin/env node
// The Wallet sheet's "Back up your key" (dapp/front/sheets.js), in a real browser under the page's own CSP, with a browser wallet that signs for real:
//   · signed out, the sheet says where the key is once signed in;
//   · signed in with the wallet, the section sits right under the address card, says the wallet's recovery phrase brings the key back,
//     and has a Copy key button that puts 64 hex characters on the clipboard;
//   · that key, pasted after Lock, opens the same Tacit address, and the section then says a pasted key is its own backup, with no button.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/wallet-key-export.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { secp, sha256, hmac, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));      // (as tacit.js sets it: the wallet below signs here, in node)

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 34000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// A browser wallet holding one key, announcing itself and signing personal_sign for real (the sign-in checks whose signature it is).
const priv = hexToBytes('11'.repeat(32)), enc = new TextEncoder();
const addr = '0x' + bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12));
const signHex = (msgHex) => {
  const m = hexToBytes(msgHex.replace(/^0x/, '')), s = secp.sign(keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${m.length}`), ...m])), priv);
  return '0x' + bytesToHex(s.toCompactRawBytes()) + (27 + s.recovery).toString(16);
};
const WALLET = `(() => {
  const listeners = {};
  const provider = { async request({ method, params }) {
    (window.__calls ||= []).push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${addr}'];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') return window.__sign(params[0]);
    throw Object.assign(new Error('stub: ' + method), { code: -32601 }); },
    on(ev, f) { (listeners[ev] ||= []).push(f); }, removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); } };
  window.ethereum = provider;
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'key-export', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', say); say();
})();`;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ctx.exposeFunction('__sign', signHex);
  await ctx.addInitScript(WALLET);
  // every toast the page shows, kept (a toast goes after a few seconds), for what a failure prints
  await ctx.addInitScript(() => { window.__toasts = []; new MutationObserver((ms) => { for (const m of ms) for (const a of m.addedNodes) if (a.classList?.contains('toast')) window.__toasts.push(a.textContent); }).observe(document, { childList: true, subtree: true }); });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1|localhost)/, (ws) => ws.close());
  await ctx.route('http://127.0.0.1:47815/**', (r) => r.abort('connectionrefused'));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text()); });
  await page.goto(BASE + '/');
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);
  // signing in closes the sheet and toasts "Opened tacit1…"; the sheet is opened again to read it (`times`: how many sign-ins so far)
  const opened = async (times) => { await page.waitForFunction((t) => (window.__toasts || []).filter((x) => /^Opened /.test(x)).length >= t, times, { timeout: 60000 }); await page.waitForTimeout(300); if (!(await page.$('#sheet-wallet[open]'))) await openSheet(); };
  const openSheet = async () => { await page.click('#wallet'); if (await page.$('#acct-pop:not([hidden])')) await page.click('#acct-pop [data-acct="wallet"]'); await page.waitForSelector('#sheet-wallet[open]'); };

  // ── signed out ──
  await page.waitForSelector('#wallet');
  await openSheet();
  ok(/Looking for your key\? Sign in first/.test(await text('#wallet-body')), 'signed out, the sheet says where the key is once signed in');

  // ── signed in with the wallet ──
  await page.waitForTimeout(1500);
  await page.click('#sheet-wallet #ws-in [data-in="eth"]');
  await opened(1);
  await page.waitForSelector('#sheet-wallet #w-key', { timeout: 30000 }).catch(async (e) => { console.log('sheet said: ' + (await text('#wallet-body')).slice(0, 700), '| toasts:', await page.evaluate(() => (window.__toasts || []).join(' // ')), '| err:', await page.evaluate(() => [...document.querySelectorAll('.err, [role="alert"], .status')].map((e) => e.textContent.trim()).filter(Boolean).join(' / ')), 'calls:', await page.evaluate(() => (window.__calls || []).join()), errors.slice(0, 3), blocked.slice(0, 2)); throw e; });
  const how = await page.evaluate(() => document.querySelector('#w-key').nextElementSibling.textContent.replace(/\s+/g, ' ').trim());
  ok(await page.evaluate(() => { const a = document.querySelector('#w-tacit'), k = document.querySelector('#w-key'), p = document.querySelector('#pay-h'); return !!(a.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(k.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'Back up your key sits right under the address card, ahead of the rest');
  ok(/recovery phrase/.test(how) && /device that does not have your wallet/.test(how) && /Paste a key/.test(how), `a wallet sign-in is told its recovery phrase brings the key back, and that the copied key signs in on a device without the wallet: ${how.slice(0, 90)}…`);
  ok(!!(await page.$('#w-backup')), 'a wallet sign-in has a Copy key button');
  const tacit = (await page.evaluate(() => document.querySelector('#w-tacit .full code')?.textContent || '')).trim();
  ok(tacit.length > 100, `the Tacit address is read (${tacit.length} characters)`);
  await page.click('#w-backup');
  await page.waitForFunction(() => /Key copied/.test(document.body.textContent), null, { timeout: 15000 }).catch(() => {});
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  ok(/^[0-9a-f]{64}$/.test(copied), 'Copy key puts the 64-character key on the clipboard');

  // ── that key, pasted after Lock, opens the same address ──
  await page.click('#w-lock');
  await page.waitForFunction(() => !document.querySelector('#sheet-wallet #w-key'), null, { timeout: 15000 });
  if (!(await page.$('#sheet-wallet[open]'))) await openSheet();
  await page.evaluate(() => document.querySelector('#sheet-wallet [data-in="paste"]').click());
  await page.evaluate((h) => { const i = document.querySelector('#sheet-wallet input[type="password"]'); i.value = h; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sheet-wallet [data-in="key"]').click(); }, copied);
  await opened(2);
  await page.waitForSelector('#sheet-wallet #w-key', { timeout: 60000 });
  const again = (await page.evaluate(() => document.querySelector('#w-tacit .full code')?.textContent || '')).trim();
  ok(again === tacit, 'the copied key, pasted, opens the same Tacit address');
  ok(/pasted this key in/.test(await page.evaluate(() => document.querySelector('#w-key').nextElementSibling.textContent)), 'a pasted key says its own copy is the backup');
  ok(!(await page.$('#w-backup')), 'and has no Copy key button');
  ok(!errors.length && !blocked.length, `no page errors or blocked requests (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
