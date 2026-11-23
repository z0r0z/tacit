#!/usr/bin/env node
// The Wallet sheet's "Back up your key" (dapp/front/sheets.js), in a real browser under the page's own CSP, with a browser wallet that signs for real:
//   · signed out, the sheet says where the key is once signed in;
//   · signed in with the wallet, the section sits right under the address card, says the wallet's recovery phrase brings the key back,
//     says never to send the key to anyone, and has a Copy key button that asks for a second press before it puts 64 hex characters on the clipboard;
//   · a Show key button, with the same second press, puts the same key on screen without touching the clipboard, and hides it on a second tap or when the sheet closes;
//   · an Ethereum key and a Bitcoin key (WIF) for another wallet, each with Show and Copy: the Ethereum key is the derived one (not the Tacit key) and
//     opens the Ethereum address the sheet lists, the WIF is the Tacit key's own and opens the Bitcoin address the sheet lists, a pasted key has them too;
//   · that key, pasted after Lock, opens the same Tacit address, and the section then says a pasted key is its own backup, with no button.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/wallet-key-export.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { secp, sha256, hmac, keccak_256, ripemd160, bech32, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeEvmAccount } from '../dapp/evm-account.js';
import { privFromWif } from '../dapp/key-export.js';

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
  ok(/Never send it to anyone, including Tacit support/.test(how), 'the note says never to send the key to anyone, Tacit support included');
  // a wallet sign-in's copy takes two presses: the first copies nothing and asks, the second copies
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));
  await page.click('#w-backup');
  ok(/Press again/.test(await text('#w-backup')) && (await page.evaluate(() => navigator.clipboard.readText())) === 'untouched', 'the first press copies nothing and asks for a second');
  await page.click('#w-backup');
  await page.waitForFunction(() => /Key copied/.test(document.body.textContent), null, { timeout: 15000 }).catch(() => {});
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  ok(/^[0-9a-f]{64}$/.test(copied), 'the second press puts the 64-character key on the clipboard');
  ok(await text('#w-backup') === 'Copy key', 'and the button goes back to Copy key');

  // ── Show key: the same key on screen, so it never has to pass through the clipboard ──
  const secretHidden = () => page.$eval('#w-secret', (e) => e.hidden && !e.textContent);
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));
  ok(!!(await page.$('#w-reveal')) && await secretHidden(), 'a wallet sign-in has a Show key button, and the key starts hidden');
  await page.click('#w-reveal');
  ok(/Press again/.test(await text('#w-reveal')) && await secretHidden(), 'the first press shows nothing and asks for a second');
  await page.click('#w-reveal');
  await page.waitForSelector('#w-secret:not([hidden]) code', { timeout: 15000 });
  ok((await text('#w-secret code')) === copied, 'the second press shows the same 64-character key the copy gave');
  ok(await text('#w-reveal') === 'Hide key' && (await page.$eval('#w-reveal', (e) => e.getAttribute('aria-expanded'))) === 'true', 'and the button turns to Hide key');
  ok((await page.evaluate(() => navigator.clipboard.readText())) === 'untouched', 'showing the key puts nothing on the clipboard');
  await page.click('#w-reveal');
  ok(await secretHidden() && await text('#w-reveal') === 'Show key', 'a tap on Hide key clears the key from the page');
  await page.click('#w-reveal'); await page.click('#w-reveal');
  await page.waitForSelector('#w-secret:not([hidden]) code', { timeout: 15000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#sheet-wallet[open]'), null, { timeout: 15000 });
  // (the dialog's close event is a task of its own after it closes, so the key is waited for, not read in the gap)
  ok(await page.waitForFunction(() => { const e = document.querySelector('#w-secret'); return e.hidden && !e.textContent; }, null, { timeout: 5000 }).then(() => true, () => false), 'closing the sheet clears a key that was showing');
  await openSheet();

  // ── the keys behind the wallet's own Ethereum and Bitcoin addresses, for another wallet ──
  const evm = makeEvmAccount({ secp, keccak256: keccak_256, sha256 });
  const wantEth = evm.deriveEvmAccount(hexToBytes(copied), 'mainnet');
  const wantBtc = bech32.encode('bc', [0, ...bech32.toWords(ripemd160(sha256(secp.getPublicKey(hexToBytes(copied), true))))]);
  await page.click('#w-other summary');
  ok(/Ethereum key/.test(await text('#w-xeth')) && /Bitcoin key \(WIF\)/.test(await text('#w-xbtc')), 'the sheet offers an Ethereum key and a Bitcoin key (WIF) for another wallet');
  ok(/send any TAC out with Tacit first/.test(await text('#w-xbtc')) && /Tacit key itself opens a different Ethereum address/.test(await text('#w-xeth')), 'and warns where each can go wrong: TAC left at the Bitcoin address, the Tacit key pasted as an Ethereum key');
  const boxed = (id) => page.$eval(`${id} .keyshow`, (e) => e.hidden && !e.textContent);
  ok(await boxed('#w-xeth') && await boxed('#w-xbtc'), 'both keys start hidden');
  await page.click('#w-xeth [data-sec="show"]');
  ok(/Press again/.test(await text('#w-xeth [data-sec="show"]')) && await boxed('#w-xeth'), 'a wallet sign-in asks for a second press before the Ethereum key shows');
  await page.click('#w-xeth [data-sec="show"]');
  await page.waitForSelector('#w-xeth .keyshow:not([hidden]) code', { timeout: 15000 });
  const ethShown = await text('#w-xeth .keyshow code');
  ok(ethShown === wantEth.priv && ethShown !== '0x' + copied, 'the Ethereum key shown is the one derived from the Tacit key, and not the Tacit key');
  await page.click('#w-xbtc [data-sec="show"]'); await page.click('#w-xbtc [data-sec="show"]');
  await page.waitForSelector('#w-xbtc .keyshow:not([hidden]) code', { timeout: 15000 });
  const wifShown = await text('#w-xbtc .keyshow code');
  ok(/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/.test(wifShown) && bytesToHex(privFromWif(wifShown)) === copied, `the Bitcoin key shown is a compressed WIF of the Tacit key (${wifShown.slice(0, 5)}…)`);
  const pageAddr = (label) => page.evaluate((l) => { for (const r of document.querySelectorAll('#w-keys .keyrow')) if (r.querySelector('.kv span')?.textContent.trim() === l) return (r.querySelector('.full code') || r.querySelector('.addrline code'))?.textContent.trim() || ''; return ''; }, label);
  await page.waitForFunction(() => [...document.querySelectorAll('#w-keys .keyrow')].some((r) => /^bc1q/.test((r.querySelector('.full code') || r.querySelector('.addrline code'))?.textContent.trim() || '')), null, { timeout: 60000 }).catch(() => {});
  ok(await pageAddr('Ethereum address') === wantEth.address, `that Ethereum key opens the Ethereum address the sheet lists (${wantEth.address.slice(0, 8)}…)`);
  ok(await pageAddr('Bitcoin address') === wantBtc, `and the WIF opens the Bitcoin address the sheet lists (${wantBtc.slice(0, 8)}…)`);
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));
  await page.click('#w-xeth [data-sec="copy"]');
  ok((await page.evaluate(() => navigator.clipboard.readText())) === 'untouched', 'the first press of Copy puts nothing on the clipboard');
  await page.click('#w-xeth [data-sec="copy"]');
  await page.waitForFunction((w) => navigator.clipboard.readText().then((t) => t === w), wantEth.priv, { timeout: 15000 });
  ok(true, 'and the second puts the Ethereum key on it');
  await page.click('#w-xbtc [data-sec="copy"]'); await page.click('#w-xbtc [data-sec="copy"]');
  await page.waitForFunction((w) => navigator.clipboard.readText().then((t) => t === w), wifShown, { timeout: 15000 });
  ok(true, 'the Bitcoin key copies as the same WIF it shows');
  await page.click('#w-xeth [data-sec="show"]');
  ok(await boxed('#w-xeth') && !(await boxed('#w-xbtc')), 'a tap on Hide clears that key only');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#sheet-wallet[open]'), null, { timeout: 15000 });
  ok(await page.waitForFunction(() => { const e = document.querySelector('#w-xbtc .keyshow'); return e.hidden && !e.textContent; }, null, { timeout: 5000 }).then(() => true, () => false), 'closing the sheet clears the Bitcoin key');
  await openSheet();

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
  ok(!(await page.$('#w-backup')) && !(await page.$('#w-reveal')), 'and has no Copy key or Show key button');
  // a pasted key is the same wallet, so its own Ethereum and Bitcoin keys are there too, and take a single press
  await page.click('#w-other summary');
  await page.click('#w-xeth [data-sec="show"]');
  await page.waitForSelector('#w-xeth .keyshow:not([hidden]) code', { timeout: 15000 });
  ok(await text('#w-xeth .keyshow code') === wantEth.priv, 'a pasted key shows the same Ethereum key at one press');
  await page.click('#w-xbtc [data-sec="show"]');
  await page.waitForSelector('#w-xbtc .keyshow:not([hidden]) code', { timeout: 15000 });
  ok(await text('#w-xbtc .keyshow code') === wifShown, 'and the same Bitcoin key');
  ok(!errors.length && !blocked.length, `no page errors or blocked requests (${[...errors, ...blocked].slice(0, 2).join(' | ')})`);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
