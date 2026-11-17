#!/usr/bin/env node
// The pool line under the chain row of /pay/eth/ (#poolstat), in a real browser under the page's own CSP. It holds the room its figures take (two lines, three on a phone) whether they
// are in yet or not, so nothing under it moves when they arrive: not when the read for them fails (the form would jump up 64px on a phone, 46px at a desktop), and not when they come
// in two pieces (the pool's balance first, the tally of what it has carried a moment after: the box shrank to the first piece's one line and grew back). A visitor with a wallet
// connected arrives as /pay/ -> /pay/eth/, one with none arrives on it; every host but the page's own is refused (the read fails) or, in the last checks, answers.
//   · the read fails: the pool line stays in the page at the room it held, and the form is where it was before the read ended (a phone and a desktop, connected and not);
//   · the read answers, the tally a second behind: the line shows the pool's figures and then the tally's, and in every frame from the form's first the form is at one height;
//   · the read answers: the line shows the pool's figures.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/pay-eth-poolstat.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname, WEB = 27100 + Math.floor(Math.random() * 90);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const A = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
// A browser wallet that allowed this site before, remembered as the one the pages restore (as wallet-restore.mjs sets it up).
const WALLET = `(() => { localStorage.setItem('stub-allowed-main', '1'); localStorage.setItem('tacit-trade-wallet', 'test.wallet');
  const provider = { async request({ method }) { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${A}']; if (method === 'eth_chainId') return '0x1'; if (method === 'eth_getCode') return '0x'; throw Object.assign(new Error('stub'), { code: -32601 }); }, on() {}, removeListener() {} };
  window.ethereum = provider;
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'main', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', say); say(); })();`;
const NODES = /^https:\/\/(ethereum-rpc\.publicnode\.com|rpc\.mevblocker\.io|mainnet\.rpc\.buidlguidl\.com|eth\.drpc\.org|1\.rpc\.thirdweb\.com|eth-mainnet\.public\.blastapi\.io|ethereum-json-rpc\.stakely\.io|1rpc\.io|eth-mainnet\.nodereal\.io)/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
// the pool holds 123.456789 ETH in 4,321 notes
const answer = (m) => (m.method === 'eth_chainId' ? '0x1' : m.method === 'eth_getBalance' ? '0x' + (123456789000000000000n).toString(16) : m.method === 'eth_call' ? '0x' + (4321).toString(16).padStart(64, '0') : m.method === 'eth_blockNumber' ? '0x1900000' : null);

const browser = await chromium.launch();
async function open({ width, connected, reads, tally = 0 }) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'light' });
  if (connected) await ctx.addInitScript(WALLET);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1|localhost)/, (ws) => ws.close());
  await ctx.route('http://127.0.0.1:47815/**', (r) => r.abort('connectionrefused'));
  if (reads) await ctx.route(NODES, (r) => {                                       // registered last, so asked first
    const q = r.request();
    if (q.method() !== 'POST') return r.fulfill({ status: 204, headers: CORS });
    let j = {}; try { j = JSON.parse(q.postData() || '{}'); } catch { }
    const one = (m) => { const v = answer(m); return v == null ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } } : { jsonrpc: '2.0', id: m.id, result: v }; };
    return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)) });
  });
  if (tally) await ctx.route(/^https:\/\/api\.tacit\.finance\/stats/, async (r) => {            // what the pool has carried, `tally` ms after the pool's own figures
    await new Promise((res) => setTimeout(res, tally));
    return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ dev: [{ chain: 1, dep: { $n: (1234560000000000000000n).toString() }, nd: 987 }] }) });
  });
  await ctx.addInitScript(() => {                                                    // every frame: where the form is, how tall the pool line is, whether the form and the figures are in
    window.__frames = [];
    const f = () => {
      const form = document.querySelector('#form'), p = document.querySelector('#poolstat');
      if (form && p) window.__frames.push({ top: Math.round(form.getBoundingClientRect().top * 10) / 10, h: Math.round(p.getBoundingClientRect().height), form: form.textContent.trim().length > 0, stage: /transacted/.test(p.textContent) ? 2 : /holds/.test(p.textContent) ? 1 : 0 });
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const page = await ctx.newPage(), pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  let ended; const readEnded = new Promise((res) => { ended = res; });
  page.on('console', (m) => { if (/^pool on Ethereum:/.test(m.text())) ended(); });          // the page says so when its read of the pool fails
  await page.goto(`http://127.0.0.1:${WEB}${connected ? '/pay/' : '/pay/eth/'}`);
  return { ctx, page, pageErrors, readEnded };
}
const top = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top * 10) / 10 : null; }, sel);
const room = (page) => page.evaluate(() => { const e = document.querySelector('#poolstat'); const b = e?.getBoundingClientRect(); return { here: !!e && !e.hidden && getComputedStyle(e).display !== 'none', h: Math.round(b?.height || 0) }; });

try {
  for (const [width, label, reserve] of [[390, 'a phone', 54], [1280, 'a desktop', 36]]) {
    for (const connected of [true, false]) {
      const who = `${label}, ${connected ? 'arriving with a wallet connected' : 'arriving with none'}`;
      const { ctx, page, pageErrors, readEnded } = await open({ width, connected, reads: false });
      await page.waitForFunction(() => location.pathname === '/pay/eth/' && !!document.querySelector('#form') && !document.querySelector('#form:empty'), null, { timeout: 30000 });
      const before = await top(page, '#form');                                          // as the page shows it before the read has ended
      const said = await Promise.race([readEnded.then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
      await page.waitForTimeout(600);
      const after = await top(page, '#form'), r = await room(page);
      await page.waitForTimeout(1500);
      const later = await top(page, '#form');
      ok(said, `${who}: the page's read of the pool fails here, as it is meant to in this check`);
      ok(r.here && r.h >= reserve, `${who}: the pool line stays in the page at the room it held (${r.h}px, at least ${reserve}px, shown: ${r.here})`);
      ok(Math.abs(after - before) <= 0.5 && Math.abs(later - before) <= 0.5, `${who}: the form is where it was when the read ended (${before}px, then ${after}px, then ${later}px)`);
      ok(!pageErrors.length, `${who}: no page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);
      await ctx.close();
    }
  }

  // the read answers, the tally a second behind it: the form holds one height from its first frame on, through the figures arriving in two pieces
  for (const [width, label, reserve] of [[390, 'a phone', 54], [1280, 'a desktop', 36]]) {
    const { ctx, page } = await open({ width, connected: false, reads: true, tally: 1200 });
    await page.waitForFunction(() => /transacted in/.test(document.querySelector('#poolstat')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    const frames = (await page.evaluate(() => window.__frames)), live = frames.slice(frames.findIndex((f) => f.form));
    const tops = [...new Set(live.map((f) => f.top))], stages = [...new Set(live.map((f) => f.stage))], low = Math.min(...live.map((f) => f.h));
    ok(stages.includes(1) && stages.includes(2), `${label}: the figures arrived in two pieces (the pool's, then the tally's; stages seen ${stages.join(', ')})`);
    ok(tops.length === 1, `${label}: the form held one height through the form's first frame to the last (${tops.join('px, ')}px, over ${live.length} frames)`);
    ok(low >= reserve, `${label}: the pool line never fell below its room (${low}px, at least ${reserve}px)`);
    await ctx.close();
  }

  // the read answers: the line is the pool's figures
  {
    const { ctx, page } = await open({ width: 390, connected: false, reads: true });
    await page.waitForFunction(() => /holds .* ETH in 4,321 notes/.test(document.querySelector('#poolstat')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const text = (await page.textContent('#poolstat')).replace(/\s+/g, ' ').trim();
    ok(/^The pool on Ethereum holds 123\.457 ETH in 4,321 notes/.test(text) && (await room(page)).here, `the read answers: the line gives the pool's figures (${text.slice(0, 70)})`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
