#!/usr/bin/env node
// The own-node setting on the front page (dapp/index.html, dapp/front/sheets.js, dapp/own-node.js), in a real browser under the page's own CSP with a pasted key. The node at
// 127.0.0.1:8545 and the public Ethereum nodes are stubs, so what is checked is where the page's reads go and what the Wallet sheet says:
//   · the row is there, says "Public nodes", and nothing has reached for 127.0.0.1:8545 before it is turned on;
//   · a node that is not running, or is 40 blocks behind, is not turned on, and the sheet says why; nothing is remembered;
//   · a node that answers is turned on: the row and button change, the sheet says the block it is at, it is first in the page's one node list, the key's balance is read from it
//     and no public node is asked for it, and the choice is remembered;
//   · when it stops answering, the sheet says so and that the public nodes are in use, and the setting stays on;
//   · a visit with the choice remembered has it first in the list from the first read, with nothing else done;
//   · turning it off returns to the public nodes.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/own-node-sheet.mjs        (SHOTS=dir saves screenshots of the sheet)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ETH_NODES } from '../dapp/eth-nodes.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PORT = 34000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const KEY = '11'.repeat(31) + '22';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json' };
const PUBLIC = new Set(ETH_NODES.map((u) => new URL(u).host));
const HEAD = 0x1000100, HEAD_TEXT = '16,777,472';
const own = { mode: 'down' }, hits = { own: [], tries: 0, pub: [] };
const answer = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, serviceWorkers: 'block' });
  const bad = [];
  await ctx.route('**/*', (r) => {
    const req = r.request(), u = new URL(req.url());
    if (u.origin === BASE) return r.continue();
    if (u.host === '127.0.0.1:8545') {
      hits.tries++;
      if (own.mode === 'down') return r.abort('connectionrefused');
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      const j = JSON.parse(req.postData() || '{}');
      hits.own.push(j.method);
      const result = j.method === 'eth_chainId' ? '0x1' : j.method === 'eth_blockNumber' ? '0x' + (own.mode === 'behind' ? HEAD - 40 : HEAD).toString(16) : j.method === 'eth_getBalance' ? '0x2386f26fc10000' : null;
      return r.fulfill({ status: 200, headers: CORS, body: result == null ? JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'method not supported' } }) : answer(j.id, result) });
    }
    if (PUBLIC.has(u.host) && req.method() === 'POST') {
      let j = {}; try { j = JSON.parse(req.postData() || '{}'); } catch { }
      hits.pub.push(j.method);
      const result = j.method === 'eth_chainId' ? '0x1' : j.method === 'eth_blockNumber' ? '0x' + HEAD.toString(16) : j.method === 'eth_getBalance' ? '0x0' : null;
      if (result != null) return r.fulfill({ status: 200, headers: CORS, body: answer(j.id, result) });
    }
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (/Content Security Policy|violates/i.test(m.text())) bad.push(m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#wallet', { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in .more-in summary');
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#w-own', { timeout: 20000 });

  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
  const shot = (name) => SHOTS && page.locator('#sheet-wallet').screenshot({ path: `${SHOTS}/${name}.png` });
  const rowText = () => page.$eval('#w-own', (b) => b.parentElement.querySelector('b').textContent.trim());
  const stored = () => page.evaluate(() => { try { return localStorage.getItem('tacit-own-node-v1'); } catch { return 'blocked'; } });
  const modUrl = await page.evaluate(() => (document.documentElement.innerHTML.match(/\/own-node\.js\?cb=[0-9a-f]{8}/) || [])[0]);
  const state = () => page.evaluate(async (u) => { const m = await import(u), n = await import('/eth-nodes.js'); return { on: m.ownNodeOn(), used: m.ownNodeUsed(), first: n.ETH_NODES[0] }; }, modUrl);

  ok(!!modUrl, 'the page imports own-node.js');
  ok((await text('#w-own')) === 'use my own node' && (await rowText()) === 'Public nodes', 'the Wallet sheet has an Ethereum node row, on the public nodes, with "use my own node"');
  ok(!(await page.isVisible('#w-own-say')), 'and says nothing yet');
  await shot('1-off');
  ok(hits.tries === 0, 'nothing reached for 127.0.0.1:8545 before it was turned on');

  // not running
  await page.click('#w-own');
  await page.waitForSelector('#w-own-say:not([hidden])', { timeout: 20000 });
  ok(/^Nothing answered at 127\.0\.0\.1:8545\./.test(await text('#w-own-say')) && /CORS/.test(await text('#w-own-say')), `not running: "${(await text('#w-own-say')).slice(0, 90)}…"`);
  ok(await page.$eval('#w-own-say', (e) => e.classList.contains('err')), 'said as an error');
  await shot('2-not-running');
  ok((await rowText()) === 'Public nodes' && (await text('#w-own')) === 'use my own node' && (await stored()) === null, 'not turned on, and nothing remembered');

  // behind
  own.mode = 'behind';
  await page.click('#w-own');
  await page.waitForFunction(() => /behind Ethereum/.test(document.querySelector('#w-own-say')?.textContent || ''), null, { timeout: 20000 });
  ok(/^It is 40 blocks behind Ethereum \(at block 16,777,432\)/.test(await text('#w-own-say')), `behind: "${(await text('#w-own-say')).slice(0, 80)}…"`);
  ok((await rowText()) === 'Public nodes' && (await stored()) === null && !(await state()).used, 'a node 40 blocks behind is not turned on');

  // answering
  own.mode = 'up';
  // the page's own reads settle first (a hedged read started before the click can still reach a second public node a moment later)
  for (let quiet = 0, seen = -1; quiet < 3;) { await page.waitForTimeout(1000); const c = hits.pub.length; quiet = c === seen ? quiet + 1 : 0; seen = c; }
  const pubBalBefore = hits.pub.filter((m) => m === 'eth_getBalance').length;
  await page.click('#w-own');
  await page.waitForFunction(() => document.querySelector('#w-own')?.textContent.trim() === 'stop using it', null, { timeout: 20000 });
  ok((await rowText()) === 'Yours, then public ones', 'turned on: the row says "Yours, then public ones" and the button "stop using it"');
  await page.waitForFunction((t) => (document.querySelector('#w-own-say')?.textContent || '').includes(t), HEAD_TEXT, { timeout: 20000 });
  ok(/^Answering at block 16,777,472\.$/.test(await text('#w-own-say')), `the sheet says where it is: "${await text('#w-own-say')}"`);
  await shot('3-on');
  const s = await state();
  ok(s.on && s.used && s.first === 'http://127.0.0.1:8545', 'it is first in the page\'s one node list');
  ok((await stored()) === '1', 'the choice is remembered');
  await page.waitForTimeout(1500);
  ok(hits.own.includes('eth_getBalance'), 'the key\'s balance was read from it');
  ok(hits.pub.filter((m) => m === 'eth_getBalance').length === pubBalBefore, 'and no public node was asked for it');
  ok(!(await page.$eval('#w-own-say', (e) => e.classList.contains('err'))), 'said plainly, not as an error');

  // it stops answering while the setting is on
  own.mode = 'down';
  await page.keyboard.press('Escape');
  await page.click('#wallet');
  await page.waitForFunction(() => /Nothing answered/.test(document.querySelector('#w-own-say')?.textContent || ''), null, { timeout: 20000 });
  ok(/Public nodes are used meanwhile\.$/.test(await text('#w-own-say')) && (await rowText()) === 'Yours, then public ones', 'down while on: the sheet says the public nodes are in use, and the setting stays on');

  // a visit with the choice remembered
  own.mode = 'up';
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(String(e.message || e)));
  p2.on('console', (m) => { if (/Content Security Policy|violates/i.test(m.text())) bad.push(m.text()); });
  const readsBefore = hits.own.length;
  await p2.goto(BASE + '/', { waitUntil: 'commit' });
  await p2.waitForFunction(() => /own-node\.js\?cb=/.test(document.documentElement.innerHTML), null, { timeout: 30000 });
  const s2 = await p2.evaluate(async (u) => { const m = await import(u), n = await import('/eth-nodes.js'); return { on: m.ownNodeOn(), first: n.ETH_NODES[0] }; }, modUrl);
  ok(s2.on && s2.first === 'http://127.0.0.1:8545', 'a visit with the choice remembered has it first in the list');
  await p2.waitForTimeout(2500);
  ok(hits.own.length - readsBefore > 2, `and asks it: ${hits.own.length - readsBefore} calls went to it from the new page, more than its own check's two`);
  await p2.close();

  // off
  await page.keyboard.press('Escape');
  await page.click('#wallet');
  await page.waitForSelector('#w-own', { timeout: 20000 });
  await page.click('#w-own');
  await page.waitForFunction(() => document.querySelector('#w-own')?.textContent.trim() === 'use my own node', null, { timeout: 20000 });
  ok((await rowText()) === 'Public nodes' && (await stored()) === '0', 'turned off: back to the public nodes, and remembered');
  const s3 = await state();
  ok(!s3.on && !s3.used && s3.first !== 'http://127.0.0.1:8545', 'it is out of the list');

  ok(bad.length === 0, `no CSP violation${bad.length ? ': ' + bad[0] : ''}`);
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  await ctx.close();
} finally { await browser.close(); server.close(); }
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
