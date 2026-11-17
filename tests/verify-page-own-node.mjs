#!/usr/bin/env node
// dapp/verify.html's "read Ethereum from my own node" box, in a real browser under the page's own CSP. Every Ethereum host is stubbed, so what is checked is
// where the reads go: with the box ticked every read goes to 127.0.0.1:8545 and none to a public node, and a node that is down, on another chain, refuses a
// method or cannot be reached stops the pass with a message naming it, never falling back to the public list. Also: the choice survives a reload, ticking
// it again off returns to the public nodes, and a node that only takes JSON bodies is reached by the second try.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/verify-page-own-node.mjs

import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, WEB = 24000 + Math.floor(Math.random() * 1000);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

const PUBLIC = ['ethereum-rpc.publicnode.com', 'rpc.mevblocker.io', 'eth.drpc.org'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
// Every read answers with something the page can take: chain 1, a code that does not match the pin (so the first step fails) and eight zero words.
const answer = (m, chain = '0x1') => (m === 'eth_chainId' ? chain : m === 'eth_getCode' ? '0x6001' : '0x' + '0'.repeat(512));

async function open(browser, { own = {}, stored = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  const page = await ctx.newPage();
  const hits = { public: [], own: [] }, bad = [];
  page.on('console', (m) => { if (/Content Security Policy|violates/i.test(m.text())) bad.push(m.text()); });
  page.on('pageerror', (e) => bad.push(String(e)));
  if (stored != null) await ctx.addInitScript((v) => { try { localStorage.setItem('tacit-verify-own-node-v1', v); } catch { } }, stored);
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost' && u.port === String(WEB)) return route.continue();
    if (PUBLIC.includes(u.hostname)) {
      const j = JSON.parse(route.request().postData() || '{}');
      hits.public.push(j.method);
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ jsonrpc: '2.0', id: j.id, result: answer(j.method) }) });
    }
    if (u.host === '127.0.0.1:8545') {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const j = JSON.parse(req.postData() || '{}');
      hits.own.push(j.method);
      return own.handle ? own.handle(route, j, req) : route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ jsonrpc: '2.0', id: j.id, result: answer(j.method, own.chain) }) });
    }
    return route.abort();
  });
  await page.goto(`http://localhost:${WEB}/verify.html`);
  return { ctx, page, hits, bad };
}
const settled = (page) => page.waitForFunction(() => /bad|ok/.test(document.getElementById('everdict')?.className || '') && !/Waiting|Running/.test(document.getElementById('everdict').textContent), null, { timeout: 30000 });

const browser = await chromium.launch();
try {
  // Default: two public nodes, the own node never asked.
  {
    const { ctx, page, hits, bad } = await open(browser);
    await settled(page);
    ok(!(await page.isChecked('#ownnode')), 'the box starts unticked');
    ok(await text(page, '#ethsrc') === 'two public nodes that agree', 'the page says it reads from two public nodes');
    ok(hits.public.length >= 16 && hits.own.length === 0, `default: ${hits.public.length} reads to public nodes, ${hits.own.length} to the own node`);

    // Ticking it re-runs the Ethereum pass against the own node alone.
    const before = hits.public.length;
    await page.click('#ownnode');
    await page.waitForFunction(() => /alone/.test(document.getElementById('ethsrc').textContent));
    await settled(page);
    ok(await text(page, '#ethsrc') === 'your node at 127.0.0.1:8545, alone', 'the page says it reads from the own node alone');
    ok(hits.own.length >= 9 && hits.own.filter((m) => m === 'eth_chainId').length === 1, `ticked: ${hits.own.length} reads to the own node, the chain asked once`);
    ok(hits.public.length === before, 'ticked: no public node was asked');
    ok(await page.evaluate(() => localStorage.getItem('tacit-verify-own-node-v1')) === '1', 'the choice is kept in this browser');
    ok(bad.length === 0, 'no CSP violation or page error' + (bad.length ? ': ' + bad[0] : ''));

    // Unticking returns to the public nodes.
    const ownBefore = hits.own.length;
    await page.click('#ownnode');
    await page.waitForFunction(() => /public/.test(document.getElementById('ethsrc').textContent));
    await settled(page);
    ok(hits.public.length > before && hits.own.length === ownBefore, 'unticked: back to the public nodes, the own node left alone');
    ok(await page.evaluate(() => localStorage.getItem('tacit-verify-own-node-v1')) === '0', 'the unticked choice is kept');
    await ctx.close();
  }

  // A stored choice is honoured from the first read.
  {
    const { ctx, page, hits } = await open(browser, { stored: '1' });
    await settled(page);
    ok(await page.isChecked('#ownnode'), 'a stored choice ticks the box on load');
    ok(hits.public.length === 0 && hits.own.length >= 9, `reload: ${hits.own.length} reads to the own node, ${hits.public.length} to public nodes`);
    await ctx.close();
  }

  // A node on another chain stops the pass; no public node stands in for it.
  {
    const { ctx, page, hits } = await open(browser, { stored: '1', own: { chain: '0xaa36a7' } });
    await settled(page);
    const v = await text(page, '#everdict');
    ok(/your node at 127\.0\.0\.1:8545/.test(v) && /not Ethereum mainnet/.test(v), `wrong chain: "${v}"`);
    ok(hits.public.length === 0, 'wrong chain: no public node was asked');
    await ctx.close();
  }

  // A node that refuses a method says so.
  {
    const handle = (route, j) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify(j.method === 'eth_getCode' ? { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'method not supported' } } : { jsonrpc: '2.0', id: j.id, result: answer(j.method) }) });
    const { ctx, page, hits } = await open(browser, { stored: '1', own: { handle } });
    await settled(page);
    const v = await text(page, '#everdict');
    ok(/answered eth_getCode with: method not supported/.test(v), `refused method: "${v}"`);
    ok(hits.public.length === 0, 'refused method: no public node was asked');
    await ctx.close();
  }

  // A node that cannot be reached from the page (not running, or a browser refusing it for want of CORS headers: both are a failed fetch) says what to look at.
  {
    const { ctx, page, hits } = await open(browser, { stored: '1', own: { handle: (route) => route.abort('connectionrefused') } });
    await settled(page);
    const v = await text(page, '#everdict');
    ok(/your node at 127\.0\.0\.1:8545/.test(v) && /did not answer/.test(v) && /CORS/.test(v), `unreachable: "${v}"`);
    ok(hits.public.length === 0, 'unreachable: no public node was asked');
    await ctx.close();
  }

  // A node that takes only JSON bodies is reached by the second try.
  {
    const handle = (route, j, req) => (/json/.test(req.headers()['content-type'] || '')
      ? route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ jsonrpc: '2.0', id: j.id, result: answer(j.method) }) })
      : route.fulfill({ status: 415, headers: { 'content-type': 'text/plain', ...CORS }, body: 'unsupported media type' }));
    const { ctx, page, hits } = await open(browser, { stored: '1', own: { handle } });
    await settled(page);
    const v = await text(page, '#everdict');
    ok(!/did not answer|answered/.test(v), `JSON-only node: the pass ran ("${v}")`);
    ok(hits.public.length === 0, 'JSON-only node: no public node was asked');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
