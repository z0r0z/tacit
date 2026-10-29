#!/usr/bin/env node
// dapp/discord/ in a real browser, under its own CSP, against the real worker: the page the Discord verification panel sends a holder to. The page and its modules
// are the real files, and the API behind api.tacit.finance is the real worker on the Node harness. What stands in: the Ethereum node (each account's TAC),
// Discord's REST (the role), and the wallet, which signs for real with a key held here, so the worker recovers the same account the page showed.
//   checks: no link; a holder gets the role (what the wallet is asked to sign, the link taken out of the address bar, the role asked for); 99.5 TAC is
//   not enough and nothing is signed; a lapsed link; Discord refusing the role, then the retry on the same link; a phone width in both colour schemes.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/discord-page.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { discordGateMessage } from '../dapp/discord/message.js';
import { DISCORD_VERIFY_BUTTON_ID } from '../discord/panel.js';
import { TAC as TAC_TOKEN, FARM, POOL } from '../dapp/trade/farm-read.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const dapp = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => dapp.on('listening', r));
const BASE = `http://127.0.0.1:${dapp.address().port}`;

// ── the worker ──
globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const { buildEnv, createCtxFactory, createTacitServer } = await import('../server/harness.mjs');
const workerModule = (await import('../worker/src/index.js')).default;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const driver = createMemDriver();
const env = buildEnv(driver);
env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
env.DISCORD_BOT_TOKEN = 'bot-token'; env.TAC_ROLE_ID = '323456789012345678';
env.GOV_TAC_ERC20_MAINNET = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const api = createTacitServer({ workerModule, env, driver, ctxFactory: createCtxFactory() });
await new Promise((r) => api.listen(0, r));
const API = `http://127.0.0.1:${api.address().port}`;

const TAC = 10n ** 18n;
const balances = new Map();
const stakes = new Map();
let farmDown = false;
const roles = [];
let discordReply = () => new Response(null, { status: 204 });
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {                    // the worker's own reads: Discord's REST and the Ethereum nodes
  const u = String(url);
  if (u.startsWith('https://discord.com/')) { roles.push(u); return Promise.resolve(discordReply()); }
  if (/^https:\/\/(ethereum-rpc\.publicnode\.com|rpc\.mevblocker\.io|eth\.merkle\.io)/.test(u)) return Promise.resolve(balanceAnswer(JSON.parse(init.body)));
  return realFetch(url, init);
};
const balanceAnswer = (body) => {
  const one = (q) => {
    if (q.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: q.id, result: '0x123456' };
    const { to, data } = q.params[0], who = '0x' + data.slice(-40);
    const isFarm = to.toLowerCase() === FARM.toLowerCase() || to.toLowerCase() === POOL.toLowerCase();
    if (farmDown && isFarm) return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'farm read unavailable' } };
    const value = to.toLowerCase() === TAC_TOKEN.toLowerCase() ? balances.get(who) ?? 0n
      : to.toLowerCase() === FARM.toLowerCase() && data.startsWith('0x98807d84') ? stakes.get(who) ?? 0n
      : to.toLowerCase() === POOL.toLowerCase() && ['0x5a76f25e', '0x18160ddd'].includes(data) ? 10_000n * TAC : 0n;
    return { jsonrpc: '2.0', id: q.id, result: '0x' + value.toString(16).padStart(64, '0') };
  };
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
};

const holderOf = (seed) => {
  const priv = sha256(new TextEncoder().encode(seed));
  return { priv, addr: '0x' + bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12)) };
};
const personalSign = async (priv, text) => {
  const m = new TextEncoder().encode(text);
  const sig = await secp.signAsync(keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), m)), priv);
  return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
};
// Discord's own call, signed as Discord signs it: clicking the persistent panel
async function discordVerify() {
  const body = JSON.stringify({ type: 3, data: { component_type: 2, custom_id: DISCORD_VERIFY_BUTTON_ID }, guild_id: '223456789012345678', member: { user: { id: '123456789012345678' } } });
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await realFetch(`${API}/discord/interaction`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-signature-ed25519': sign(null, Buffer.from(ts + body), privateKey).toString('hex'), 'x-signature-timestamp': ts } });
  const link = (await r.json()).data.content;
  return /https:\/\/tacit\.finance\/discord\/#gate=([0-9a-f]{32})/.exec(link)[1];
}
const record = async (n) => env.REGISTRY_KV.get(`dgate:${n}`, 'json');

const rich = holderOf('page-holder-250tac'), poor = holderOf('page-holder-99tac'), farmer = holderOf('page-farmer-100tac');
balances.set(rich.addr, 250n * TAC); balances.set(poor.addr, 99n * TAC + TAC / 2n);
stakes.set(farmer.addr, 100n * TAC);

// ── the browser ──
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch({ channel: 'chromium-headless-shell' });
async function open(holder, hash = '', { viewport = { width: 1100, height: 800 }, scheme = 'light' } = {}) {
  const ctx = await b.newContext({ viewport, colorScheme: scheme });
  const page = await ctx.newPage();
  const errs = [], csp = [], signed = [];
  page.on('pageerror', (e) => errs.push(e.message));
  if (process.env.DEBUG) { page.on('console', (m) => console.log('  console:', m.text().slice(0, 200))); page.on('requestfailed', (r) => console.log('  failed:', r.url().slice(0, 120), r.failure()?.errorText)); }
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(/^https:\/\/(ethereum-rpc\.publicnode\.com|eth\.drpc\.org|1rpc\.io|mainnet\.gateway\.tenderly\.co)/, async (route) => {
    const r = balanceAnswer(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
  });
  await page.route(/^https:\/\/api\.tacit\.finance\//, async (route) => {
    const q = route.request(), u = new URL(q.url()), cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const r = await realFetch(`${API}${u.pathname}${u.search}`, { method: q.method(), headers: { 'content-type': 'application/json' }, body: q.postData() || undefined });
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: await r.text() });
  });
  // the wallet: announced as EIP-6963 does, signing for real with the holder's key
  await page.exposeFunction('__sign', async (hexMsg, account) => {
    signed.push({ message: Buffer.from(hexMsg.slice(2), 'hex').toString('utf8'), account });
    return personalSign(holder.priv, Buffer.from(hexMsg.slice(2), 'hex').toString('utf8'));
  });
  await page.addInitScript((acct) => {
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') return window.__sign(params[0], params[1]);
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
      on() {}, removeListener() {},
    };
    const info = { uuid: 'test-wallet', name: 'Test wallet', icon: '', rdns: 'test.wallet' };
    const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    addEventListener('eip6963:requestProvider', announce);
  }, holder.addr);
  await page.goto(`${BASE}/discord/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gate h2');
  return { page, errs, csp, signed, ctx };
}
// Connect wallet opens the site's wallet picker (the browser's wallets, then WalletConnect): the test wallet is the one chosen
async function connect(page) {
  await page.click('#go');
  await page.click('.bsheet .way:has-text("Test wallet")');
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

// 1. no link
{
  const { page, errs, csp } = await open(rich);
  ok(await text(page, '#gate h2') === 'Start from Discord.', 'without a link it says to start from Discord');
  ok(await page.$('#go') === null, 'and offers nothing to press');
  ok(/Verify.*panel.*#verify/.test(await text(page, '#gate') || ''), 'naming the persistent verification panel');
  ok((await page.title()) === 'tacit discord', 'the page is titled for what it is');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await shot(page, 'discord-nolink');
  await page.context().close();
}

// 2. a holder
{
  const nonce = await discordVerify();
  const { page, errs, csp, signed } = await open(rich, `#gate=${nonce}`);
  ok(await page.evaluate(() => location.hash) === '', 'the link is taken out of the address bar');
  ok(await text(page, '#go') === 'Connect wallet', 'a connected wallet is the first step');
  ok((await page.getAttribute('#gate a[href^="/classic.html"]', 'href')) === `/classic.html#gate=${nonce}`, 'Bitcoin holders are pointed at the Classic app with the same link');
  await shot(page, 'discord-connect');
  await connect(page);
  await page.waitForFunction(() => /TAC$/.test(document.querySelector('.kv:nth-child(2) b')?.textContent || ''));
  ok(await text(page, '.kv:nth-child(2) b') === '250 TAC', 'it shows the TAC the account holds');
  ok(await text(page, '.kv:nth-child(3) b') === '100 TAC', 'and the 100 TAC it needs');
  ok(await text(page, '#go') === 'Verify' && !(await page.isDisabled('#go')), 'and Verify opens');
  await shot(page, 'discord-ready');
  await page.click('#go');
  await page.waitForFunction(() => /holder role/.test(document.querySelector('#gate h2')?.textContent || ''));
  ok(signed.length === 1 && signed[0].message === discordGateMessage(nonce), 'the wallet was asked to sign the one message that names the link');
  ok(signed[0].account.toLowerCase() === rich.addr, 'for the account the page showed');
  const rec = await record(nonce);
  ok(rec.status === 'verified' && rec.holder === `eth:${rich.addr}`, 'the worker recovered that account and used the link');
  ok(roles.length === 1 && roles[0].endsWith('/guilds/223456789012345678/members/123456789012345678/roles/323456789012345678'), 'and asked Discord for the role on the member the link was made for');
  ok(await text(page, '#gate h2') === 'You have the holder role.', 'the page says so');
  await shot(page, 'discord-done');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gate h2');
  ok(await text(page, '#gate h2') === 'Start from Discord.', 'a reload does not offer the used link again');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}

// 3. half a TAC
{
  roles.length = 0;
  const nonce = await discordVerify();
  const { page, signed } = await open(poor, `#gate=${nonce}`);
  await connect(page);
  await page.waitForFunction(() => /TAC$/.test(document.querySelector('.kv:nth-child(2) b')?.textContent || ''));
  ok(await text(page, '.kv:nth-child(2) b') === '99.5 TAC', 'just under the bar is shown as it is');
  ok(await text(page, '#go') === 'Needs at least 100 TAC' && await page.isDisabled('#go'), 'and the button says why it is shut');
  ok(signed.length === 0 && roles.length === 0, 'nothing is signed and no role is asked for');
  ok(await page.$('#swap-acct') !== null, 'another account can be chosen');
  await shot(page, 'discord-short');
  await page.context().close();
}

// 4. a link that lapsed
{
  roles.length = 0;
  const { page } = await open(rich, `#gate=${'ab'.repeat(16)}`);
  await connect(page);
  await page.waitForFunction(() => document.querySelector('#go')?.textContent === 'Verify');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#gate h2')?.textContent === 'Start from Discord.');
  ok(/expired.*Click Verify/.test(await text(page, '#note') || ''), 'a link the server does not know points back to the verification panel');
  ok(roles.length === 0, 'and no role is asked for');
  await page.context().close();
}

// 5. Discord refuses, then does not
{
  roles.length = 0;
  const nonce = await discordVerify();
  const { page } = await open(rich, `#gate=${nonce}`);
  discordReply = () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 });
  await connect(page);
  await page.waitForFunction(() => document.querySelector('#go')?.textContent === 'Verify');
  await page.click('#go');
  await page.waitForFunction(() => /Discord refused/.test(document.querySelector('#note')?.textContent || ''));
  ok(/Missing Permissions/.test(await text(page, '#note')), 'a role Discord refuses is reported with Discord\'s reason');
  ok(await text(page, '#go') === 'Verify' && !(await page.isDisabled('#go')) && (await record(nonce)).status === 'pending', 'and the same link can be tried again');
  discordReply = () => new Response(null, { status: 204 });
  await page.click('#go');
  await page.waitForFunction(() => /holder role/.test(document.querySelector('#gate h2')?.textContent || ''));
  ok((await record(nonce)).status === 'verified', 'which then gets the role');
  await page.context().close();
}

// 6. A farm-only holder can verify without withdrawing their TAC.
{
  roles.length = 0;
  const nonce = await discordVerify();
  const { page, signed, errs, csp } = await open(farmer, `#gate=${nonce}`);
  await connect(page);
  await page.waitForFunction(() => document.querySelector('#go')?.textContent === 'Verify');
  ok(await text(page, '.kv:nth-child(2) b') === '0 TAC', 'a farmer needs no loose wallet TAC');
  ok(await text(page, '.kv:nth-child(4) b') === '100 TAC', 'the page shows the TAC backing the staked farm position');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#gate h2')?.textContent === 'You have the holder role.');
  ok(signed.length === 1 && roles.length === 1 && (await record(nonce)).holder === `eth:${farmer.addr}`, 'a farm-only holder signs once and receives the role');
  ok(errs.length === 0 && csp.length === 0, 'the farm path has no browser or CSP errors');
  await page.context().close();
}

// 7. A failed farm read can be retried without replacing the member's link.
{
  roles.length = 0; farmDown = true;
  const nonce = await discordVerify();
  const { page } = await open(farmer, `#gate=${nonce}`);
  await connect(page);
  await page.waitForSelector('#retry');
  ok(await page.isDisabled('#go'), 'a farm read failure cannot verify an unqualified wallet');
  farmDown = false;
  await page.click('#retry');
  await page.waitForFunction(() => document.querySelector('#go')?.textContent === 'Verify');
  ok(await text(page, '.kv:nth-child(4) b') === '100 TAC', 'retry restores the farm balance');
  await page.context().close();
}

// 8. a phone, in both colour schemes
for (const scheme of ['light', 'dark']) {
  const nonce = await discordVerify();
  const { page } = await open(rich, `#gate=${nonce}`, { viewport: { width: 375, height: 760 }, scheme });
  await connect(page);
  await page.waitForFunction(() => document.querySelector('#go')?.textContent === 'Verify');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(over <= 0, `${scheme}: nothing runs off a 375px screen (${over}px over)`);
  await shot(page, `discord-phone-${scheme}`);
  await page.context().close();
}

await b.close(); dapp.close(); api.close();
globalThis.fetch = realFetch;
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
