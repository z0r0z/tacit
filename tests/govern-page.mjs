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
import { voteMessage, delegateMessage } from '../dapp/govern/message.js';

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
// the .wei name service (WNS) answers resolveId(node) for the names this test knows: node -> address
const WNS_ADDR = '0x0000000000696760e15f265e828db644a0c242eb';
const nodeOf = (name) => { let node = new Uint8Array(32); for (const l of name.split('.').reverse()) { node = keccak_256(concatBytes(node, keccak_256(new TextEncoder().encode(l)))); } return bytesToHex(node); };
const weiNames = new Map();
const ethAnswer = (body) => {
  const one = (q) => {
    if (q.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: q.id, result: '0x' + HEAD.toString(16) };
    if (q.method === 'eth_chainId') return { jsonrpc: '2.0', id: q.id, result: '0x1' };
    if (q.method !== 'eth_call') return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'not here' } };
    const { to, data } = q.params[0];
    if (to.toLowerCase() === WNS_ADDR && data.toLowerCase().startsWith('0x4f896d4f')) {
      const a = weiNames.get(data.slice(10).toLowerCase());
      return { jsonrpc: '2.0', id: q.id, result: '0x' + (a ? a.slice(2) : '').padStart(64, '0') };
    }
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
weiNames.set(nodeOf('rich.wei'), rich.addr);

// ── the browser ──
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch({ channel: 'chromium-headless-shell' });
// a Tacit key this tab already opened elsewhere on the site, and tacit.js in a stand-in that hands its governance calls to this test: the real proof
// is the worker suite's (tests/governance-worker.test.mjs) and the classic app's; here the page's own wiring is under test
const tacitStandIn = `export const wallet = { priv: null, pub: null, mode: null };
export function invalidateHoldingsCache() {}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function governanceApi() { return {
  readTacBalance: async () => 15000000000n,
  votePrivate: async (id, c, tier) => window.__btcVote(id, c, String(tier), hex(wallet.pub)),
  createProposal: async (c) => window.__btcPropose(JSON.stringify(c), hex(wallet.pub)),
}; }`;
const btcCalls = [];
async function open(holder, hash = '', { viewport = { width: 1280, height: 900 }, scheme = 'light', tacitKey = null, noDelegation = false, switchOnSign = null } = {}) {
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
  if (noDelegation) await page.route(/^https:\/\/api\.tacit\.finance\/governance\/delegation/, (route) => route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not found"}' }));
  await page.exposeFunction('__sign', async (hexMsg, account) => {
    const text = Buffer.from(hexMsg.slice(2), 'hex').toString('utf8');
    signed.push({ text, account });
    const sig = await personalSign(holder.priv, text);
    if (switchOnSign) await page.evaluate((a) => { window.__acct = a; window.__cbs?.accountsChanged?.([a]); }, switchOnSign);   // the wallet moves to another account while the prompt is open
    return sig;
  });
  await page.addInitScript((acct) => {
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [window.__acct || acct];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') return window.__sign(params[0], params[1]);
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
      on(ev, cb) { (window.__cbs ||= {})[ev] = cb; }, removeListener() {},
    };
    const info = { uuid: 'test-wallet', name: 'Test wallet', icon: '', rdns: 'test.wallet' };
    const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    addEventListener('eip6963:requestProvider', announce);
  }, holder.addr);
  if (tacitKey) {
    await page.route(/\/tacit\.js(\?|$)/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: tacitStandIn }));
    await page.exposeFunction('__btcVote', async (pid, choice, tier, pubHex) => {
      btcCalls.push({ kind: 'vote', pid, choice, tier, pubHex });
      const k = `gov:v:mainnet:${pid}:btc-${pubHex.slice(0, 32)}`, prior = await env.REGISTRY_KV.get(k, 'json');
      await env.REGISTRY_KV.put(k, JSON.stringify({ proposal_id: pid, network: 'mainnet', kind: 'private', choice, weight: tier, tier, voter: pubHex, outpoints: [], voted_at: Math.floor(Date.now() / 1000), revote: !!prior }));
      const p = await env.REGISTRY_KV.get(`gov:p:mainnet:${pid}`, 'json');        // the tally, as the worker's recount leaves it
      p.tally.totals[choice] = String(BigInt(p.tally.totals[choice]) + BigInt(tier)); p.tally.total_weight = String(BigInt(p.tally.total_weight) + BigInt(tier));
      p.tally.voters += 1; p.tally.private_voters += 1;
      await env.REGISTRY_KV.put(`gov:p:mainnet:${pid}`, JSON.stringify(p));
      return { ok: true, weight: tier, tier, revote: !!prior };
    });
    await page.exposeFunction('__btcPropose', async (json, pubHex) => { btcCalls.push({ kind: 'propose', c: JSON.parse(json), pubHex }); return { ok: true, id }; });
    await page.addInitScript((k) => sessionStorage.setItem('tacit-tab-key-v1', JSON.stringify({ ...k, at: Date.now() })), tacitKey);
  }
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

// 2. one holder votes from both chains in one go: the Ethereum wallet signs, the Tacit wallet proves a tier
const tacitPriv = bytesToHex(sha256(new TextEncoder().encode('gov-page-tacit-key')));
const tacitPub = bytesToHex(secp.getPublicKey(tacitPriv, true));
const tacitKey = { mode: 'passkey', priv: tacitPriv, pubHex: tacitPub, label: 'Tacit', credentialId: 'test' };
{
  await env.REGISTRY_KV.put(`gov:v:mainnet:${id}:btc-${'cd'.repeat(16)}`, JSON.stringify({
    proposal_id: id, network: 'mainnet', kind: 'private', choice: 1, weight: String(100n * 10n ** 8n), tier: String(100n * 10n ** 8n),
    voter: '02' + 'ab'.repeat(32), outpoints: [], voted_at: Math.floor(Date.now() / 1000) - 600, revote: false,
  }));
  { const p = await env.REGISTRY_KV.get(`gov:p:mainnet:${id}`, 'json'); p.tally = { totals: ['0', String(100n * 10n ** 8n)], voters: 1, total_weight: String(100n * 10n ** 8n), public_voters: 0, private_voters: 1 }; await env.REGISTRY_KV.put(`gov:p:mainnet:${id}`, JSON.stringify(p)); }
  const { page, errs, csp, signed } = await open(rich, `#${id}`, { tacitKey });
  await page.waitForSelector('#ballot');
  await page.waitForFunction(() => /150 TAC/.test(document.querySelector('#side')?.textContent || ''));
  ok(true, 'a Tacit wallet this tab already opened is used, and its Bitcoin TAC shows in the side card');
  await connect(page);
  await page.waitForFunction(() => /250 TAC, held at block/.test(document.querySelector('#ballot')?.textContent || ''));
  ok(await page.isChecked('[data-src="eth"]') && await page.isChecked('[data-src="btc"]'), 'both chains are ready to vote');
  ok(await page.inputValue('#tier') === String(100n * 10n ** 8n), 'the Bitcoin tier starts at the highest it holds (≥ 100 of 150)');
  await page.click('.opt:has-text("Yes")');
  ok(await text(page, '#vote') === 'Vote from both', 'one button votes from both');
  await shot(page, 'gov-both-ready');
  await page.click('#vote');
  await page.waitForFunction(() => /Voted at/.test(document.querySelector('#step-btc')?.textContent || '') && /Voted with/.test(document.querySelector('#step-eth')?.textContent || ''), null, { timeout: 30e3 });
  ok(signed.length === 1 && signed[0].text === voteMessage(id, 0, 'Yes'), 'the Ethereum wallet signed the vote for Yes');
  const bv = btcCalls.find((c) => c.kind === 'vote');
  ok(bv && bv.pid === id && bv.choice === 0 && bv.tier === String(100n * 10n ** 8n) && bv.pubHex === tacitPub, 'tacit.js was asked for a Bitcoin vote for Yes at the 100 TAC tier, under the tab’s key');
  ok(/Voted with 250 TAC/.test(await text(page, '#step-eth')) && /Voted at 100 TAC/.test(await text(page, '#step-btc')), 'each source says what it counted');
  ok(/Bitcoin 200 TAC · 2/.test(await text(page, '#lane-b')) && /Ethereum 250 TAC · 1/.test(await text(page, '#lane-e')), 'each chain’s side shows its TAC and voters');
  const res = await page.$$eval('.res-h', (r) => r.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(/^Yes ?350 TAC · 77.7%/.test(res[0]) && /^No ?100 TAC · 22.2%/.test(res[1]), `results add both chains (${res.join(' | ')})`);
  ok(await text(page, '#vote') === 'Change vote from both' && (await page.$$eval('.src small b', (x) => x.map((e) => e.textContent))).length === 2, 'the ballot then shows both votes and offers to change them');
  const rows = await page.$$eval('.vrow', (r) => r.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 3 && rows.some((r) => /^Ethereum ?0x.*Yes ?250/.test(r)) && rows.filter((r) => /^Bitcoin ?key/.test(r)).length === 2, `the vote list names each chain (${rows.join(' | ')})`);
  ok(await page.$$eval('.vrow img.inv', (i) => i.length) === 3 && await page.$('.meta img.inv') && await page.$$eval('#side .acct img.inv', (i) => i.length) === 2, 'each voter, the proposer and both of the holder’s accounts wear their zOrgz face');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await shot(page, 'gov-voted');
  await page.click('.eyebrow a[href="#"]');
  await page.waitForSelector('.prop');
  ok(/Yes · 77.7%/.test(await text(page, '.prop')) && /2 Bitcoin · 1 Ethereum/.test(await text(page, '.prop')), 'the list shows the lead and both chains’ voters');
  await shot(page, 'gov-list');
  // a proposal opened from the Tacit wallet
  await page.click('a.btn.sm[href="#new"]');
  await page.waitForSelector('#newform');
  await page.click('[data-from="btc"]');
  await page.fill('#f-title', 'From Bitcoin');
  ok(await text(page, '#f-go') === 'Sign and open', 'a proposal can be opened from the Tacit wallet');
  await page.click('#f-go');
  await page.waitForFunction((pid) => location.hash === `#${pid}`, id, { timeout: 30e3 });
  const bp = btcCalls.find((c) => c.kind === 'propose');
  ok(bp && bp.c.title === 'From Bitcoin' && bp.c.network === 'mainnet' && bp.c.snapshot_height === 0 && bp.pubHex === tacitPub && signed.length === 1, 'tacit.js was asked to open it under the tab’s key, and the Ethereum wallet was not asked');
  await page.context().close();
}

// the real tacit.js, loaded the way the page loads it, offers the governance calls the page makes
{
  const tacitUrl = /const TACIT_URL = '([^']+)'/.exec(readFileSync(join(DAPP, 'govern/app.js'), 'utf8'))[1];
  const { page } = await open(poor);
  const got = await page.evaluate(async (u) => { globalThis.__TACIT_NO_INIT__ = true; const T = await import(u); const g = T.governanceApi(); return [typeof g.votePrivate, typeof g.createProposal, typeof g.readTacBalance, g.tiers.length, !!T.wallet]; }, tacitUrl);
  ok(JSON.stringify(got) === JSON.stringify(['function', 'function', 'function', 6, true]), `the real tacit.js exports governanceApi with the calls the page uses (${got})`);
  await page.context().close();
}

// 2b. delegation: a 99-TAC wallet hands its vote to the 250-TAC wallet, which then votes with both; the 99 votes for itself and takes it back; a take-back
let id2;
{
  const { page, errs, csp, signed } = await open(poor, '#delegate');
  await connect(page);
  await page.waitForSelector('#dgform');
  ok(await text(page, '.ptitle') === 'Delegate your vote' && /not delegated/.test(await text(page, '.sec .note')), 'the delegate page says nothing is delegated yet');
  ok(/Delegation/.test(await text(page, '#dg-side')), 'and the side card links to it');
  await shot(page, 'gov-delegate');
  await page.fill('#dg-to', 'not an address');
  await page.click('#dg-go');
  ok(/0x address or a name/.test(await text(page, '#note')) && signed.length === 0, 'something that is neither an address nor a name is refused before the wallet is asked');
  ok(await page.getAttribute('#dg-to', 'placeholder') === '0x… or name.wei', 'the field says a name works too');
  await page.fill('#dg-to', rich.addr);
  ok(await page.getAttribute('[data-rights="vote"]', 'aria-checked') === 'true' && /^Sign and delegate to 0x/.test(await text(page, '#dg-go')), 'the vote right is the default, and the button names the address it signs for');
  await page.click('#dg-go');
  await page.waitForFunction(() => /Delegated\. It counts/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 30e3 });
  const issued = +/Issued: (\d+)/.exec(signed[0]?.text || '')?.[1];
  ok(signed.length === 1 && signed[0].text === delegateMessage({ network: 'mainnet', delegate: rich.addr, rights: 'vote', issued }), 'the wallet signed the delegation message');
  const drec = await env.REGISTRY_KV.get(`gov:d:mainnet:${poor.addr}`, 'json');
  ok(drec && drec.history.length === 1 && drec.history[0].to === rich.addr && drec.history[0].rights === 'vote', 'the worker recorded it under the signing account');
  ok(new RegExp(rich.addr.slice(2, 8), 'i').test(await text(page, '.sec')) && await page.$('#dg-off'), 'the page shows the delegate and a way to take it back');
  ok(/To 0x/i.test(await text(page, '#dg-side')), 'and the side card names them');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}
{
  // the delegate sees who handed theirs over, opens a new proposal (after the delegation) and votes with both
  const { page, errs, csp } = await open(rich, '#delegate');
  await connect(page);
  await page.waitForFunction(() => /1 · 99 TAC/.test(document.querySelector('.eyebrow .who')?.textContent || ''));
  ok(/99 TAC to you/.test(await text(page, '#dg-side')) && (await page.$$('.feed .vrow')).length === 1, 'the delegate sees one holder and 99 TAC handed to them');
  await shot(page, 'gov-delegated-to-you');
  await page.goto(`${BASE}/govern/#new`); await page.waitForSelector('#newform');
  await page.fill('#f-title', 'A second question after the delegation');
  await page.waitForFunction(() => !document.querySelector('#f-go')?.disabled);
  await page.click('#f-go');
  await page.waitForFunction(() => /^#[0-9a-f]{64}$/.test(location.hash) && document.querySelector('.ptitle'), null, { timeout: 30e3 });
  id2 = (await page.evaluate(() => location.hash)).slice(1);
  await page.waitForSelector('#ballot');
  await page.waitForFunction(() => /delegated to this wallet/.test(document.querySelector('#ballot')?.textContent || ''));
  ok(/Also carries TAC delegated to this wallet/.test(await text(page, '#ballot')), 'the ballot says delegated TAC votes with this wallet');
  await page.click('.opt:has-text("Yes")');
  await page.click('#vote');
  await page.waitForFunction(() => /Voted with/.test(document.querySelector('#step-eth')?.textContent || ''), null, { timeout: 30e3 });
  ok(/Voted with 349 TAC, 99 TAC of it delegated to you/.test(await text(page, '#step-eth')), `it voted with its own 250 and the 99 handed to it (${await text(page, '#step-eth')})`);
  const rows = await page.$$eval('.vrow', (r) => r.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 1 && /349/.test(rows[0]) && /includes 99 TAC delegated by 1/.test(rows[0]), `the vote list says what it carries (${rows.join(' | ')})`);
  ok(/Ethereum 349 TAC · 1/.test(await text(page, '#lane-e')), 'and the Ethereum side shows 349');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await shot(page, 'gov-delegate-voted');
  await page.context().close();
}
{
  // the delegator opens it, is told, and votes for themselves: their 99 leave the delegate's vote
  const { page, errs, csp } = await open(poor, `#${id2}`);
  await connect(page);
  await page.waitForFunction(() => /you delegated to/i.test(document.querySelector('#ballot')?.textContent || ''));
  ok(/vote with your TAC here unless you vote yourself/.test(await text(page, '#ballot')), 'the delegator is told their delegate votes for them unless they do');
  await page.click('.opt:has-text("No")');
  await page.click('#vote');
  await page.waitForFunction(() => /Voted with/.test(document.querySelector('#step-eth')?.textContent || ''), null, { timeout: 30e3 });
  ok(/Voted with 99 TAC/.test(await text(page, '#step-eth')), 'the delegator’s own vote counts their 99');
  await page.waitForFunction(() => /No\s*99 TAC/.test(document.querySelectorAll('.res-h')[1]?.textContent || ''), null, { timeout: 15e3 });
  const res = await page.$$eval('.res-h', (r) => r.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(/^Yes ?250 TAC/.test(res[0]) && /^No ?99 TAC/.test(res[1]), `the 99 moved from the delegate's vote to their own (${res.join(' | ')})`);
  const p2 = await env.REGISTRY_KV.get(`gov:p:mainnet:${id2}`, 'json');
  ok(p2.tally.total_weight === String(349n * 10n ** 8n) && p2.tally.delegated_weight === '0', 'the same 349 TAC, counted once');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}
{
  // taking it back (the worker waits five minutes between a wallet's changes, so move the last one back in time)
  const key = `gov:d:mainnet:${poor.addr}`, rec = await env.REGISTRY_KV.get(key, 'json');
  rec.history.forEach((h) => { h.at -= 900; h.issued -= 900; });
  await env.REGISTRY_KV.put(key, JSON.stringify(rec));
  const { page, errs, csp, signed } = await open(poor, '#delegate');
  await connect(page);
  await page.waitForSelector('#dg-off');
  await page.click('#dg-off');
  await page.waitForFunction(() => /taken back/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 30e3 });
  ok(signed.length === 1 && /Delegate: none/.test(signed[0].text), 'the wallet signed a take-back');
  const after = await env.REGISTRY_KV.get(key, 'json');
  ok(after.history.length === 2 && after.history[1].to === null, 'the worker recorded it');
  ok(/not delegated/.test(await text(page, '.sec .note')) && !(await page.$('#dg-off')), 'and the page says nothing is delegated');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}
{
  // delegating to a .wei name: it is looked up, shown as the address it points at, and that address is what gets signed
  const key = `gov:d:mainnet:${poor.addr}`, rec = await env.REGISTRY_KV.get(key, 'json');
  rec.history.forEach((h) => { h.at -= 900; h.issued -= 900; });
  await env.REGISTRY_KV.put(key, JSON.stringify(rec));
  const { page, errs, csp, signed } = await open(poor, '#delegate');
  await connect(page);
  await page.waitForSelector('#dgform');
  await page.fill('#dg-to', 'nobody.wei');
  await page.waitForFunction(() => /does not point at an address/.test(document.querySelector('#dg-res')?.textContent || ''), null, { timeout: 15e3 });
  ok(true, 'a name that points nowhere says so as it is typed');
  await page.click('#dg-go');
  await page.waitForFunction(() => /does not point at an address/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 15e3 });
  ok(signed.length === 0, 'and pressing the button does not ask the wallet');
  await page.fill('#dg-to', 'rich.com');
  await page.click('#dg-go');
  ok(signed.length === 0 && /0x address or a name/.test(await text(page, '#note')), 'a name from another service is not looked up');
  await page.fill('#dg-to', 'Rich.WEI');
  await page.waitForFunction((a) => (document.querySelector('#dg-res')?.textContent || '').includes(a), rich.addr, { timeout: 15e3 });
  ok(await text(page, '#dg-res') === `rich.wei is ${rich.addr}`, `the name shows the address it points at (${await text(page, '#dg-res')})`);
  await shot(page, 'gov-delegate-name');
  await page.click('#dg-go');
  await page.waitForFunction(() => /Delegated to rich\.wei/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 30e3 });
  const issued = +/Issued: (\d+)/.exec(signed[0]?.text || '')?.[1];
  ok(signed.length === 1 && signed[0].text === delegateMessage({ network: 'mainnet', delegate: rich.addr, rights: 'vote', issued }), 'the wallet signed the address the name points at');
  const after = await env.REGISTRY_KV.get(key, 'json');
  ok(after.history.at(-1).to === rich.addr, 'the worker recorded that address');
  ok(/rich\.wei · 0x/i.test(await text(page, '.sec .kv b')) && /To rich\.wei/.test(await text(page, '#dg-side')), 'and the page shows the name beside it, in the card as well');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}

// 2c. an API without delegation: the page leaves it out, with or without a wallet
{
  const { page, errs, csp } = await open(poor, '', { noDelegation: true });
  await page.waitForSelector('.blank, .prop');
  await page.waitForFunction(() => !document.querySelector('#to-delegate') && !document.querySelector('#dg-side'));
  ok(true, 'no Delegate button or side row where the API has no delegation');
  await connect(page);
  await page.waitForFunction(() => /99 TAC/.test(document.querySelector('#side')?.textContent || ''));
  ok(!(await page.$('#to-delegate')) && !(await page.$('#dg-side')), 'and none once a wallet is connected');
  await page.evaluate(() => { location.hash = 'delegate'; });
  await page.waitForSelector('.ptitle');
  ok(/not available yet/.test(await text(page, '.lede')), 'a link straight to the delegate page says it is not available yet');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}
// 2d. the wallet flow's guards: a name that moves between lookup and press is not signed, and an account switch mid-prompt records nothing
{
  const other = holderOf('gov-page-other-wallet');
  const key = `gov:d:mainnet:${poor.addr}`;
  const back = async () => { const r = await env.REGISTRY_KV.get(key, 'json'); r.history.forEach((h) => { h.at -= 900; h.issued -= 900; }); await env.REGISTRY_KV.put(key, JSON.stringify(r)); };
  await back();
  const before = (await env.REGISTRY_KV.get(key, 'json')).history.length;
  const { page, errs, csp, signed } = await open(poor, '#delegate');
  await connect(page);
  await page.waitForSelector('#dgform');
  await page.fill('#dg-to', 'moves.wei'); weiNames.set(nodeOf('moves.wei'), rich.addr);
  await page.waitForFunction((a) => (document.querySelector('#dg-res')?.textContent || '').includes(a), rich.addr, { timeout: 15e3 });
  ok(/to moves\.wei$/.test(await text(page, '#dg-go')), 'the button names who it will sign for');
  weiNames.set(nodeOf('moves.wei'), other.addr);                      // the name changes hands before the press
  await page.click('#dg-go');
  await page.waitForFunction((a) => (document.querySelector('#dg-res')?.textContent || '').includes(a), other.addr, { timeout: 15e3 });
  ok(signed.length === 0 && /now points at a different address/.test(await text(page, '#note')), 'a name that moved since it was shown is not signed: the new address is shown instead');
  ok((await env.REGISTRY_KV.get(key, 'json')).history.length === before, 'and nothing was recorded');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}
{
  // the wallet switches account while the prompt is open: what the first account signed is not sent
  const other = holderOf('gov-page-other-wallet');
  balances.set(other.addr, 40n * TAC);
  const key = `gov:d:mainnet:${poor.addr}`, before = (await env.REGISTRY_KV.get(key, 'json')).history.length;
  const { page, errs, csp, signed } = await open(poor, '#delegate', { switchOnSign: other.addr });
  await connect(page);
  await page.waitForSelector('#dgform');
  await page.fill('#dg-to', rich.addr);
  await page.click('#dg-go');
  await page.waitForFunction(() => /account changed/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 30e3 });
  ok(signed.length === 1, 'the prompt was shown once');
  ok((await env.REGISTRY_KV.get(key, 'json')).history.length === before && !(await env.REGISTRY_KV.get(`gov:d:mainnet:${other.addr}`, 'json')), 'but nothing was recorded for either account');
  ok(/Nothing was sent/.test(await text(page, '#note')), 'and the page says so');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
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
  await page.evaluate(() => { location.hash = 'delegate'; }); await page.waitForSelector('#dgform');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nor on the delegate page');
  await shot(page, 'gov-phone-delegate');
  await shot(page, 'gov-phone-detail');
  ok(errs.length === 0 && csp.length === 0, `no script errors and nothing the CSP refused (${errs.concat(csp).join(' | ')})`);
  await page.context().close();
}

await b.close(); dapp.close(); api.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
