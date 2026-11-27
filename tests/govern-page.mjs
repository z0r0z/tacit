#!/usr/bin/env node
// dapp/govern/ in a real browser, under its own CSP, against the real worker on the Node harness. The page and its modules are the real files; what
// stands in: the Ethereum nodes (each account's TAC, at any block), the Bitcoin tip, the IPFS pin, and the wallet, which signs for real with a key held
// here, so the worker recovers the account the page showed.
//   checks: an empty list; a 250-TAC holder opens a proposal (the exact message signed, the proposal recorded under that address, both snapshots taken);
//   a Bitcoin vote already in the tally shows on its own side; the holder votes and the results, the per-chain split and the vote list follow;
//   a 99-TAC holder cannot open one; a phone width in dark.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/govern-page.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { TAC as TAC_TOKEN } from '../dapp/trade/farm-read.js';
import { voteMessage } from '../dapp/govern/message.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const dapp = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
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
const driver = createMemDriver();
const env = buildEnv(driver);
env.GOV_TAC_ERC20_MAINNET = TAC_TOKEN.toLowerCase();
env.PINATA_JWT = 'test';
const api = createTacitServer({ workerModule, env, driver, ctxFactory: createCtxFactory() });
await new Promise((r) => api.listen(0, r));
const API = `http://127.0.0.1:${api.address().port}`;

const TAC = 10n ** 18n, HEAD = 0x123456, TIP = 925000;
const balances = new Map();
const ethAnswer = (body) => {
  const one = (q) => {
    if (q.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: q.id, result: '0x' + HEAD.toString(16) };
    if (q.method === 'eth_chainId') return { jsonrpc: '2.0', id: q.id, result: '0x1' };
    if (q.method !== 'eth_call') return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'not here' } };
    const { to, data } = q.params[0];
    const v = to.toLowerCase() === TAC_TOKEN.toLowerCase() && data.startsWith('0x70a08231') ? balances.get('0x' + data.slice(-40)) ?? 0n : 0n;
    return { jsonrpc: '2.0', id: q.id, result: '0x' + v.toString(16).padStart(64, '0') };
  };
  return JSON.stringify(Array.isArray(body) ? body.map(one) : one(body));
};
// a raw-codec CIDv1 of the bytes, as a pin provider answers
const b32 = (bytes) => { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, val = 0, out = ''; for (const x of bytes) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A[(val << (5 - bits)) & 31]; return out; };
const rawCid = (bytes) => 'b' + b32(concatBytes(new Uint8Array([0x01, 0x55, 0x12, 0x20]), sha256(bytes)));
const pins = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {             // the worker's own reads
  const u = String(url?.url || url);
  if (/\/blocks\/tip\/height$/.test(u)) return new Response(String(TIP));
  if (u.startsWith('https://api.pinata.cloud/')) {
    const file = init.body.get('file'), bytes = new Uint8Array(await file.arrayBuffer());
    pins.push(JSON.parse(new TextDecoder().decode(bytes)));
    return new Response(JSON.stringify({ IpfsHash: rawCid(bytes), PinSize: bytes.length }), { headers: { 'content-type': 'application/json' } });
  }
  if (typeof init.body === 'string' && /"method":"eth_/.test(init.body)) return new Response(ethAnswer(JSON.parse(init.body)), { headers: { 'content-type': 'application/json' } });
  if (/^https?:\/\/(?!127\.0\.0\.1)/.test(u)) throw new Error(`no network in this test: ${u}`);
  return realFetch(url, init);
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
const rich = holderOf('gov-page-250tac'), poor = holderOf('gov-page-99tac');
balances.set(rich.addr, 250n * TAC); balances.set(poor.addr, 99n * TAC);

// ── the browser ──
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch({ channel: 'chromium-headless-shell' });
async function open(holder, hash = '', { viewport = { width: 1280, height: 900 }, scheme = 'light' } = {}) {
  const ctx = await b.newContext({ viewport, colorScheme: scheme });
  const page = await ctx.newPage();
  const errs = [], csp = [], signed = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); if (process.env.DEBUG) console.log('  console:', t.slice(0, 200)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const q = route.request(), body = q.postData() || '';
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (/^https:\/\/api\.tacit\.finance\//.test(q.url())) {
      if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const u = new URL(q.url());
      const r = await realFetch(`${API}${u.pathname}${u.search}`, { method: q.method(), headers: { 'content-type': 'application/json' }, body: body || undefined });
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: await r.text() });
    }
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (q.method() === 'POST' && /"method":"eth_/.test(body)) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: ethAnswer(JSON.parse(body)) });
    return route.abort();
  });
  await page.exposeFunction('__sign', async (hexMsg, account) => {
    const text = Buffer.from(hexMsg.slice(2), 'hex').toString('utf8');
    signed.push({ text, account });
    return personalSign(holder.priv, text);
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
  await page.goto(`${BASE}/govern/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#side .eyebrow');
  return { page, errs, csp, signed };
}
async function connect(page) {
  await page.click('#side-connect');
  await page.click('.bsheet .way:has-text("Test wallet")');
  await page.waitForSelector('#side-connect', { state: 'detached' });
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

let id;
// 1. an empty list, then a holder opens a proposal
{
  const { page, errs, csp, signed } = await open(rich);
  ok((await page.title()) === 'tacit gov', 'the page is titled tacit gov');
  ok(await text(page, '.brand i') === 'gov' && /tacit gov/.test(await text(page, '#h')), 'and says so in the header and the head');
  await page.waitForSelector('.blank');
  ok(/No open proposals/.test(await text(page, '.blank')), 'an empty list says so');
  await shot(page, 'gov-empty');
  await connect(page);
  await page.waitForFunction(() => /250 TAC/.test(document.querySelector('#side')?.textContent || ''));
  ok(true, 'the side card shows the 250 TAC the account holds');
  await page.click('a.btn.sm[href="#new"]');
  await page.waitForSelector('#newform');
  await page.fill('#f-title', 'Should TAC list on a second venue?');
  await page.fill('#f-body', 'Holders say where.\nTwo lines.');
  await page.click('[data-dur="259200"]');
  ok(await page.getAttribute('[data-dur="259200"]', 'aria-checked') === 'true', 'the voting period is picked from the row');
  ok(await page.inputValue('#f-title') === 'Should TAC list on a second venue?', 'and the draft survives the redraw');
  ok(await text(page, '#f-go') === 'Sign and open' && !(await page.isDisabled('#f-go')), 'Sign and open is ready');
  await shot(page, 'gov-new');
  await page.click('#f-go');
  await page.waitForFunction(() => /^#[0-9a-f]{64}$/.test(location.hash) && document.querySelector('.ptitle'), null, { timeout: 30e3 });
  id = (await page.evaluate(() => location.hash)).slice(1);
  ok(signed.length === 1 && /^Tacit governance proposal\nNetwork: mainnet\nTitle: Should TAC list on a second venue\?\n/.test(signed[0].text), 'the wallet signed the proposal message');
  const rec = await env.REGISTRY_KV.get(`gov:p:mainnet:${id}`, 'json');
  ok(rec && rec.proposer_pubkey === rich.addr, 'the worker recorded it under the signing account');
  ok(rec.snapshot_height === TIP && rec.eth_snapshot_block === HEAD - 12, 'with the Bitcoin tip and an Ethereum block as its snapshots');
  ok(rec.voting_ends_at - rec.created_at > 3 * 86400 - 120 && rec.voting_ends_at - rec.created_at <= 3 * 86400, 'open for the three days picked');
  ok(pins.length === 1 && pins[0].title === rec.title, 'and pinned it');
  ok(await text(page, '.ptitle') === 'Should TAC list on a second venue?', 'the page opens the new proposal');
  ok(/Bitcoin 925000/.test(await text(page, '.meta')) && /Ethereum 1193034/.test(await text(page, '.meta')), 'naming both snapshot blocks');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}

// 2. a Bitcoin vote is in the tally; the holder votes from Ethereum
{
  await env.REGISTRY_KV.put(`gov:v:mainnet:${id}:btc-${'cd'.repeat(16)}`, JSON.stringify({
    proposal_id: id, network: 'mainnet', kind: 'private', choice: 1, weight: String(100n * 10n ** 8n), tier: String(100n * 10n ** 8n),
    voter: '02' + 'ab'.repeat(32), outpoints: [], voted_at: Math.floor(Date.now() / 1000) - 600, revote: false,
  }));
  const { page, errs, csp, signed } = await open(rich, `#${id}`);
  await page.waitForSelector('#ballot');
  await connect(page);
  await page.waitForSelector('#weight');
  ok(/250 TAC/.test(await text(page, '#weight')), 'the ballot shows the holder’s weight at the snapshot');
  await page.click('.opt:has-text("Yes")');
  await page.click('#vote');
  await page.waitForFunction(() => /Voted with/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 30e3 });
  ok(signed.length === 1 && signed[0].text === voteMessage(id, 0, 'Yes'), 'the wallet signed the vote for Yes');
  ok(/Voted with 250 TAC/.test(await text(page, '#note')), 'the page says the vote counted 250 TAC');
  ok(/You voted Yes with 250 TAC/.test(await text(page, '#mine')) && await text(page, '#vote') === 'Change vote', 'the ballot then shows the vote cast and offers to change it');
  ok(/Bitcoin 100 TAC · 1/.test(await text(page, '#lane-b')), 'the Bitcoin side shows its 100 TAC and one voter');
  ok(/Ethereum 250 TAC · 1/.test(await text(page, '#lane-e')), 'the Ethereum side shows 250 TAC and one voter');
  const res = await page.$$eval('.res-h', (r) => r.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(/^Yes ?250 TAC · 71.4%/.test(res[0]) && /^No ?100 TAC · 28.5%/.test(res[1]), `results add both chains (${res.join(' | ')})`);
  const rows = await page.$$eval('.vrow', (r) => r.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 2 && rows.some((r) => /^Ethereum ?0x.*Yes ?250/.test(r)) && rows.some((r) => /^Bitcoin ?key 02ababab… ?No ?≥ 100/.test(r)), `the vote list names each chain (${rows.join(' | ')})`);
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await shot(page, 'gov-voted');
  await page.click('.eyebrow a[href="#"]');
  await page.waitForSelector('.prop');
  ok(/Yes · 71.4%/.test(await text(page, '.prop')) && /1 Bitcoin · 1 Ethereum/.test(await text(page, '.prop')), 'the list shows the lead and both chains’ voters');
  await shot(page, 'gov-list');
  await page.context().close();
}

// 3. under the floor; a phone in dark
{
  const { page, errs, csp, signed } = await open(poor, '#new', { viewport: { width: 390, height: 844 }, scheme: 'dark' });
  await connect(page);
  await page.waitForFunction(() => /Needs 100 TAC/.test(document.querySelector('#f-go')?.textContent || ''));
  ok(await page.isDisabled('#f-go'), 'a 99-TAC account cannot open one, and is told why');
  ok(signed.length === 0, 'nothing was signed');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nothing runs off a phone screen');
  await shot(page, 'gov-phone-new');
  await page.goto(`${BASE}/govern/#${id}`); await page.waitForSelector('.vrow');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nor on a proposal');
  await shot(page, 'gov-phone-detail');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}

await b.close(); dapp.close(); api.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
