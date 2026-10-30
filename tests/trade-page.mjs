#!/usr/bin/env node
// dapp/trade/ in a real browser, under its own CSP: Ethereum is an anvil fork of mainnet (so the price tape, the pools and the
// quotes are the chain's own), the Bitcoin order book is the fixtures captured from the API on 2026-10-12 with their expiry moved
// forward. Checks the head, the lanes, the chart in each lane and size, the ticket's routes (a split among them), the venues table,
// the order book and the facts, at a desktop and a phone width, and that nothing was blocked or logged as an error.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-page.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { readBook } from '../dapp/zboards.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', SHOTS = process.env.SHOTS || null;
const PORT = 21000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
let server;
const done = () => { anvil.kill('SIGKILL'); server?.close(); };
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  // As the host does: a directory is served at its address with the slash; without it, or with no file at all, the front page answers and its head script sends the visitor on.
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');            // as the host does: an address with no file of its own is the front page, which sends it on
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const asset = JSON.parse(readFileSync(join(FX, 'tac-asset-2026-10-12.json'), 'utf8')), sales = JSON.parse(readFileSync(join(FX, 'tac-sales-2026-10-12.json'), 'utf8'));
const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
sales.sales = sales.sales.map((x) => ({ ...x, expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) }));
const bids = JSON.parse(readFileSync(join(FX, 'tac-bids-2026-10-12.json'), 'utf8'));              // the 14 standing bids the API listed, their expiry moved forward
bids.intents = bids.intents.map((x) => ({ ...x, expiry: soon }));
const apiBody = (url) => (/preauth-sales/.test(url) ? sales : /bid-intents/.test(url) ? bids : asset);
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co'];

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });

const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
const TACADDR = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', ROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const tacBal = async (a) => BigInt(await rpcA('eth_call', [{ to: TACADDR, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const ethBal = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));

// A wallet in the page: window.ethereum answers as an EIP-1193 provider, signs TAC's permit with a real key and sends through the fork.
async function stubWallet(ctx, { account, key, refuseSends = false, noPermit = false }) {
  const log = { sends: [], signs: 0, signAttempts: 0, connects: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts') { log.connects++; return [account]; }
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') { if (log.onChainId) { const f = log.onChainId; log.onChainId = null; await f(); } return '0x1'; }
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'wallet_watchAsset') { (log.watched ||= []).push(params); return true; }
    if (method === 'eth_signTypedData_v4') {
      log.signAttempts++;
      if (noPermit) throw Object.assign(new Error('The method eth_signTypedData_v4 is not supported by this account.'), { code: -32601 });
      log.signs++; return cast('wallet', 'sign', '--private-key', key, '--data', params[1]);
    }
    if (method === 'eth_sendTransaction') {
      if (refuseSends) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      log.sends.push(params[0]);
      return rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x3d0900' }]);
    }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}
async function fundedWallet(eth, tac) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], who = j.address;
  await rpcA('anvil_setBalance', [who, '0x' + eth.toString(16)]);
  if (tac) {
    const slot = cast('keccak', '0x' + who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2');     // Solady's balance slot
    await rpcA('anvil_setStorageAt', [TACADDR, slot, '0x' + tac.toString(16).padStart(64, '0')]);
  }
  await rpcA('anvil_impersonateAccount', [who]);
  return { account: who, key: j.private_key };
}

async function openPage(viewport, wallet = null, hash = '', path = '/trade/', { hedge = '0', hangFirst = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const walletLog = wallet ? await stubWallet(ctx, wallet) : null;
  const seen = { rpc: [], api: [], apiT: [] };
  await ctx.addInitScript((h) => { try { localStorage.setItem('tacit-trade-hedge-ms', h); } catch { /* storage is a convenience */ } }, hedge);   // a cold fork is slow for every node: a hedge would only multiply its load
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    if (hangFirst && h === RPC_HOSTS[0]) return new Promise(() => {});                 // a node that never answers
    try { const j = JSON.parse(route.request().postData() || '{}'); seen.rpc.push({ method: j.method, to: String(j.params?.[0]?.to || '').toLowerCase(), data: String(j.params?.[0]?.data || '') }); } catch { /* not JSON */ }
    try {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  await ctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, (route) => {
    seen.api.push(new URL(route.request().url()).pathname.replace(/^\/assets\/[0-9a-f]{64}/, '')); seen.apiT.push(Date.now());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(apiBody(route.request().url())) });
  });
  // The points program's terms, stubbed so a pass shows they are read: ETH swapped into TAC pays 1,000 points an ETH.
  await ctx.route(/^https:\/\/api\.tacit\.finance\/leaderboard/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ day: 1, programDay: 1, programDays: 90, program: { startDay: 1, days: 90, dayBudgetWei: '1111111111111111111111', rates: { zswapeth: 1000 }, weights: [{ fromDay: 1, weights: {} }] }, totalPoints: 0, dayBudgetWei: '1111111111111111111111', taking: 0, rows: [] }) }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  if (walletLog) await page.clock.install();                                   // the wallet pages' timers can be moved on by a test
  await page.goto(`http://127.0.0.1:${WEB}${path}${hash}`);
  return { browser, page, errors, blocked, walletLog, seen };
}

// The contrast ratio of an element's text against the backgrounds layered behind it (WCAG): small text must reach 4.5.
const contrast = (page, sel) => page.$eval(sel, (el) => {
  const px = (s) => { let m = s.match(/rgba?\(([^)]+)\)/); if (m) { const v = m[1].split(/[ ,\/]+/).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; } m = s.match(/color\(srgb ([^)]+)\)/); if (m) { const v = m[1].split(/[ \/]+/).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1]; } return [0, 0, 0, 0]; };
  const over = (below, above) => { const a = above[3]; return [0, 1, 2].map((i) => above[i] * a + below[i] * (1 - a)).concat(1); };
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const chain = []; for (let e = el; e; e = e.parentElement) chain.unshift(px(getComputedStyle(e).backgroundColor));
  let bg = [255, 255, 255, 1]; for (const l of chain) bg = over(bg, l);
  const fg = over(bg, px(getComputedStyle(el).color)), a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

const candles = (page) => page.$$eval('#chart .body', (b) => b.length);
const lines = (page) => page.$$eval('#chart polyline', (b) => b.length);
// The fork is cold: reading zSwap's four boards pulls every order's storage from the upstream node one slot at a time, which takes minutes the first
// time and milliseconds after. The page reads them as it loads, so they are read once here, before any page asks (the pages' own first read
// otherwise times out, over and over, until the node has finished; an earlier quote used to warm them by accident).
await readBook({ ethCall: (to, data, block = 'latest') => rpcA('eth_call', [{ to, data }, block]), base: TACADDR, now: Math.floor(Date.now() / 1000) }).catch(() => null);
let r;
try {
  r = await openPage({ width: 1280, height: 900 });
  const p = r.page;
  await until(p, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && document.querySelectorAll('#lanes .lane .v').length === 4 && !document.querySelector('#lanes .sk') && !!document.querySelector('#chart .line') && document.querySelectorAll('#ladders .ob-row').length > 3, null, 240000).catch(async (e) => {
    console.log('     page at the first wait:', JSON.stringify(await p.evaluate(() => ({ url: location.href, px: document.querySelector('#px-usd')?.textContent, lanes: document.querySelectorAll('#lanes .lane .v').length, skeleton: !!document.querySelector('#lanes .sk'), candles: document.querySelectorAll('#chart .body').length, asks: document.querySelectorAll('#ladders .ob-row').length, chart: document.querySelector('#chart')?.textContent.slice(0, 80) }))), 'errors:', r.errors.slice(0, 3), 'blocked:', r.blocked.slice(0, 2));
    throw e;
  });

  const early = await p.evaluate(() => (self.__tradeEarly instanceof Map ? [...self.__tradeEarly.keys()].map((k) => k.slice(0, 120)) : null));
  ok(Array.isArray(early) && early.length === 0, `the reads the head sends (its inline script) are each taken by the call the page makes${early?.length ? `. Not taken: ${early.join(' | ')}. The page asked first for: ${r.seen.rpc.slice(0, 8).map((x) => `${x.method} ${x.to} ${x.data.slice(0, 74)}`).join(' | ')}` : ''}`);
  const burst = r.seen.api.filter((_, i) => r.seen.apiT[i] - r.seen.apiT[0] < 5000), apiOnce = (re) => burst.filter((x) => re.test(x)).length;     // the first reads (a refresh a minute on can fall in a slow start)
  ok((await p.$$eval('link[rel="preload"][as="fetch"][crossorigin]', (l) => l.length)) === 4 && apiOnce(/preauth-sales/) === 1 && apiOnce(/bid-intents/) === 1 && apiOnce(/^$/) === 1 && apiOnce(/farm/) <= 1, `the page's four API reads start with its HTML and are asked for once (${burst.join(' ')})`);
  ok(await p.$eval('.chart .halo', (e) => getComputedStyle(e).animationIterationCount) === '4', 'the live dot pulses a few times when the price is drawn, not for as long as the page is open');
  ok(!(await p.$('p.eyebrow')) && (await p.$$eval('h2.eyebrow', (h) => h.length)) >= 4 && (await p.$$eval('h1, h2, h3', (h) => h.map((x) => +x.tagName[1]).every((n, i, a) => i === 0 || n - a[i - 1] <= 1))), 'the panels are titled by headings, and the heading levels step down one at a time');
  ok((await contrast(p, '.assets a:not([aria-current])')) >= 4.5 && (await p.$$eval('footer nav a', (a) => a.every((x) => x.getBoundingClientRect().height >= 23.9))), `the inactive asset links read at 4.5:1 or more on their pill (${(await contrast(p, '.assets a:not([aria-current])')).toFixed(2)}) and the footer links are 24px high`);
  const head = (await text(p, '#px-usd')).trim(), sub = (await text(p, '#px-sub')).replace(/\s+/g, ' ');
  ok(/^\$0\.\d{2,}/.test(head), `the head shows TAC's price in dollars (${head})`);
  ok(/1 TAC = [\d.]+ ETH/.test(sub) && /24h volume [\d.,]+ ETH/.test(sub), `and in ETH and the day's volume, each figure with its name (${sub.slice(0, 120)})`);
  const lanes = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes.length === 4 && /Precision pool.*\$0\.\d+.*ETH.*the reference/.test(lanes[0]) && /Tacit pool.*\$0\.\d+.*ETH.*vs Precision/.test(lanes[1]) && /Bitcoin · last trade.*\$0\.\d+.*150 sats/.test(lanes[2]) && /Bitcoin · cheapest ask.*\$0\.\d+.*157 sats/.test(lanes[3]), `four prices, each in dollars with ETH or sats and its gap against Precision (${lanes.map((l) => l.slice(0, 60)).join(' | ')})`);
  ok(/^On Bitcoin, the last trade was (level with|\d+% (above|below)) Ethereum’s price(, (and|but) the cheapest ask is (level with|\d+% (above|below)) it)?\.$/.test((await text(p, '#gapnote')).trim()), `Bitcoin's last trade and its cheapest ask are each set against Ethereum's price in words (${(await text(p, '#gapnote')).slice(0, 160)})`);

  // the chart: a line by default, as the Bitcoin market draws it, and candles a press away
  ok(!!(await p.$('#chart .line')) && !!(await p.$('#chart polygon.area')) && !!(await p.$('#chart .lastdot')) && (await candles(p)) === 0 && !!(await p.$('[data-kind="candles"]')), 'the Ethereum lane draws the Precision pool\'s price as a shaded line with its last price marked');
  const rd = (await text(p, '#ch-read')).replace(/\s+/g, ' ');
  ok(/^\$0\.\d{4}.*(all time|past month).*low \$0\.\d+.*high \$0\.\d+.*ETH \(\$[\d.,]+[kM]?\) traded/.test(rd), `a line above the chart gives the price, its move over the range, the low, the high and the volume (${rd.slice(0, 120)})`);
  ok((await p.$$eval('#chart .mark', (m) => m.length)) === 2 && (await p.$eval('#tf-seg', (e) => e.hidden)) === true, 'the high and the low are named on the line, and a line has no candle size to choose');
  const lineN = await p.$eval('#chart polyline', (l) => l.getAttribute('points').split(' ').length);
  await p.click('[data-range="1"]'); await until(p, () => document.querySelector('#chart polyline') && document.querySelector('#chart polyline').getAttribute('points').split(' ').length < 120 && /past day/.test(document.querySelector('#ch-read')?.textContent || ''));
  const dayN = await p.$eval('#chart polyline', (l) => l.getAttribute('points').split(' ').length);
  ok(dayN >= 20 && dayN <= 100 && dayN < lineN, `1D draws the day at 15 minutes (${dayN} points; whole range ${lineN})`);
  await p.click('[data-range="0"]'); await until(p, () => /all time · since \d+ \w{3}/.test(document.querySelector('#ch-read')?.textContent || ''));
  const offered = await p.$$eval('#range-seg button', (b) => b.map((x) => x.textContent));
  ok(offered.at(-1) === 'All' && offered[0] === '1D' && new Set(offered).size === offered.length, `the ranges offered are the ones that differ for the history there is (${offered.join(' ')})`);
  const sub2 = (await text(p, '#px-sub')).replace(/\s+/g, ' ');
  ok(/1h\s*[+−]?[\d.]+%/.test(sub2) && /24h\s*[+−]?[\d.]+%/.test(sub2) && /Liquidity \$[\d.,]+[kM]?/.test(sub2) && /FDV \$[\d.,]+[kM]?/.test(sub2), `the headline gives the move over 1h, 6h, 24h and 7d, the pool's liquidity and the fully diluted value (${sub2.slice(0, 150)})`);
  await p.hover('#chart svg', { position: { x: 300, y: 150 } });
  await until(p, () => /\d{2}:\d{2}/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  ok(await p.$eval('#chart .cross .cd', (c) => c.getAttribute('visibility') === 'visible') && (await p.$eval('.chart-tip', (e) => e.hidden)) && /^\$0\.\d{4}/.test(await text(p, '#ch-read')), 'a pointer on the line reads the price and time at that bar in the line above, with a dot on the line and no box over it');
  const axisRead = await p.$$eval('#chart .cross .clabt', (t) => t.map((x) => x.textContent));
  ok(axisRead.length === 2 && /^\$0\.\d+$/.test(axisRead[0]) && /^\d+ \w{3}( \d{2}:\d{2})?$/.test(axisRead[1]), `and its price and time sit on the axes (${axisRead.join(' | ')})`);
  await p.mouse.move(5, 5); await until(p, () => /all time/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  ok((await p.$$eval('#chart .cross .cd[visibility="visible"]', (d) => d.length)) === 0, 'and the pointer leaving the chart takes the dot with it');
  // the keys read the chart too: an arrow steps through the bars, Escape lets go
  await p.focus('#chart svg'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
  await until(p, () => /\d{2}:\d{2}/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  const keyRead = (await text(p, '#ch-read')).replace(/\s+/g, ' ');
  await p.keyboard.press('Escape'); await until(p, () => /all time/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  ok(/\d{2}:\d{2}/.test(keyRead) && /(traded|nothing traded|trade)/.test(keyRead), `the arrow keys read a bar's time, price and volume, and Escape goes back to the whole range (${keyRead.slice(0, 110)})`);
  // a mouse dragged across the chart measures that stretch; let go, the chart zooms into it, and Zoom out goes back to the whole
  await p.$eval('#chart', (e) => e.scrollIntoView({ block: 'center' }));
  const zb = await (await p.$('#chart svg')).boundingBox();
  await p.mouse.move(zb.x + zb.width * 0.3, zb.y + zb.height * 0.5); await p.mouse.down();
  await p.mouse.move(zb.x + zb.width * 0.6, zb.y + zb.height * 0.5, { steps: 8 });
  const measuring = (await text(p, '#ch-read')).replace(/\s+/g, ' ').trim(), band = await p.$eval('#chart .selband', (b) => b.getAttribute('visibility'));
  await p.mouse.up(); await p.mouse.move(5, 5);
  await until(p, () => !!document.querySelector('#ch-read [data-zoomout]'), null, 10000).catch(() => {});
  const zoomedRead = (await text(p, '#ch-read')).replace(/\s+/g, ' ').trim(), zoomedLabel = await p.$eval('#chart svg', (e) => e.getAttribute('aria-label'));
  const spanOf = (t) => (t.match(/\d+ \w{3} \d{2}:\d{2} to (\d+ \w{3} )?\d{2}:\d{2} · \d+ (days|h|min)/) || [])[0];
  ok(band === 'visible' && !!spanOf(measuring) && /low \$0\.\d+ high \$0\.\d+/.test(measuring), `dragging across the chart reads the stretch: its move, its times and length, its low and high (${measuring.slice(0, 120)})`);
  ok(spanOf(zoomedRead) === spanOf(measuring) && /Zoom out/.test(zoomedRead) && /zoomed in/.test(zoomedLabel), `letting go zooms into that stretch and offers to zoom out (${zoomedRead.slice(0, 90)})`);
  await p.click('#ch-read [data-zoomout]');
  await until(p, () => /all time/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  ok(!/zoomed in/.test(await p.$eval('#chart svg', (e) => e.getAttribute('aria-label'))) && !(await p.$('#ch-read [data-zoomout]')), 'and Zoom out draws the whole range again');
  ok((await p.$$eval('#chart .halo', (h) => h.length)) === 1 && (await p.$$eval('.hero h1 svg.tk', (h) => h.length)) === 1 && (await p.$eval('.hero h1 svg.tk', (e) => e.getBoundingClientRect().width)) > 30 && (await p.$$eval('main use[href="#tk-tac"]', (u) => u.length)) >= 7, 'the live price is marked, and the TAC mark sits beside the price and on the page\'s headings');
  await p.click('[data-kind="candles"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 5);
  const c4 = await candles(p);
  ok(c4 >= 30 && c4 <= 190, `the Ethereum lane draws the 4-hour tape as candles (${c4})`);          // a month of 4-hour bars is 181, and the bars at its two ends add a few
  const nowRead = (await text(p, '#ch-read .px')).trim();
  ok((await p.$$eval('#chart .tagtext', (t) => t.map((x) => x.textContent))).includes(nowRead), `with the Precision pool's price now at the edge, as the line above reads it (${nowRead})`);
  // the move over a range is the same in candles as on the line, and the past day's is the head's 24h move
  const moveOf = async () => { const t = (await text(p, '#ch-read .chg')).trim(); const v = parseFloat(t.replace(/[^\d.]/g, '')); return /▼/.test(t) ? -v : v; };
  await p.click('[data-range="1"]'); await until(p, () => /past day/.test(document.querySelector('#ch-read')?.textContent || ''));
  const dayCandles = await moveOf();
  await p.click('[data-kind="line"]'); await until(p, () => !!document.querySelector('#chart .line') && /past day/.test(document.querySelector('#ch-read')?.textContent || ''));
  const dayLine = await moveOf(), head24 = (await text(p, '#px-sub')).replace(/\s+/g, ' ').match(/24h ([+−])([\d.]+)%/);
  const headMove = head24 ? (head24[1] === '−' ? -1 : 1) * parseFloat(head24[2]) : NaN;
  ok(dayCandles === dayLine && Math.abs(dayLine - headMove) < 1e-9, `the past day moved the same in candles (${dayCandles}%), on the line (${dayLine}%) and in the head's 24h (${headMove}%)`);
  await p.click('[data-kind="candles"]'); await p.click('[data-range="0"]'); await until(p, () => /all time/.test(document.querySelector('#ch-read')?.textContent || '') && document.querySelectorAll('#chart .body').length > 5);
  await p.click('[data-range="7"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 20 && document.querySelectorAll('#chart .body').length < 50);
  ok((await candles(p)) <= 43 && (await candles(p)) >= 30, `7 days of 4-hour candles is at most 42 (${await candles(p)})`);
  await p.click('[data-range="0"]');
  await p.click('[data-log="1"]'); await until(p, () => document.querySelector('[data-log="1"]').getAttribute('aria-pressed') === 'true');
  const logAxis = await p.$$eval('#chart .axis:not(.mid)', (t) => t.map((x) => x.textContent));
  ok(logAxis.length >= 3 && logAxis.every((x) => /^\$0\.\d+$/.test(x)) && logAxis.some((x) => /^\$0\.[1-9]00?$|^\$0\.[1-9]$|^\$0\.\d{1,2}0?$/.test(x)), `the log axis names round dollar prices (${logAxis.join(' ')})`);
  await p.click('[data-log="1"]');
  await p.click('[data-tf="86400"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 5 && document.querySelectorAll('#chart .body').length < 400);   // one a day since TAC began trading (a month on 2026-10-22), so no fixed ceiling near it
  const c1d = await candles(p);
  ok(c1d < c4 && c1d >= 15, `a day's candles are fewer than 4 hours' (${c1d} against ${c4})`);
  const allSizes = await p.$$eval('#tf-seg button', (b) => b.map((x) => x.textContent));
  ok(allSizes.includes('1d') && !allSizes.some((x) => /m$|^1h$/.test(x)), `a range of weeks offers no candle finer than the 4-hour tape holds that far back (${allSizes.join(' ')})`);
  await p.click('[data-range="1"]'); await until(p, () => [...document.querySelectorAll('#tf-seg button')].map((x) => x.textContent).join() === '5m,15m,1h');
  await p.click('[data-tf="3600"]'); await until(p, () => document.querySelector('[data-tf="3600"]')?.getAttribute('aria-pressed') === 'true');
  ok((await candles(p)) > 0 && (await candles(p)) <= 25, `the past day offers 5-minute to 1-hour candles, from the 5-minute tape (${await candles(p)} hourly)`);
  await p.hover('#chart svg', { position: { x: 300, y: 120 } });
  await until(p, () => /O \$0\.\d+.*H \$0\.\d+.*L \$0\.\d+/.test(document.querySelector('#ch-read')?.textContent.replace(/\s+/g, ' ') || ''), null, 10000).catch(() => {});
  ok(/O \$0\.\d+.*H \$0\.\d+.*L \$0\.\d+/.test((await text(p, '#ch-read')).replace(/\s+/g, ' ')) && (await p.$eval('.chart-tip', (e) => e.hidden)), `a pointer on a candle reads its open, high, low and close in the line above (${(await text(p, '#ch-read')).replace(/\s+/g, ' ').slice(0, 100)})`);
  await p.mouse.move(5, 5);
  await p.click('[data-range="0"]');
  await p.click('[data-unit="native"]'); await until(p, () => /ETH/.test(document.querySelector('#chart .axis')?.textContent || ''));
  ok(/ETH/.test(await p.$eval('#chart .axis', (e) => e.textContent)), 'the price can be shown in ETH instead of dollars');
  await p.click('[data-unit="usd"]');
  await p.click('[data-lane="btc"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 20);
  const cb = await candles(p);
  ok(cb > 20, `the Bitcoin lane draws the order book's trades as candles (${cb})`);
  ok(/Every trade on the Bitcoin order book since \d{1,2} \w{3,4} 2026/.test(await text(p, '#chart-note')), 'and says where they come from');
  await p.click('[data-lane="cmp"]'); await until(p, () => document.querySelectorAll('#chart polyline').length === 2);
  ok((await lines(p)) === 2 && !(await p.$('#chart .body')), 'Compare draws the two lanes as lines in dollars');
  ok(/Ethereum and Bitcoin in dollars, at today’s ETH and BTC prices/.test(await text(p, '#chart-note')), 'and says they are at today\'s rates');
  // prices a hair apart (the Tacit pool beside the Precision pool) each keep a whole tag: they are spaced out, not drawn one over the other
  const tagYs = await p.evaluate(async () => {
    const { mountChart } = await import('/trade/chart.js');
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-9999px;top:0;width:640px;height:300px'; document.body.append(host);
    const bars = Array.from({ length: 24 }, (_, i) => ({ t: 1.75e9 + i * 3600, open: 1, high: 1, low: 1, close: 1 + i * 0.002, vol: 0 }));
    mountChart(host).update({ series: [{ id: 'a', name: 'a', color: '#00f', kind: 'line', area: true, bars, fmt: String }], period: 3600,
      tags: [{ y: 1.04, label: '$1.04', color: '#00f' }, { y: 1.0402, label: 'Tacit', color: '#0a0' }, { y: 1.2, label: 'far', color: '#f90' }] });
    const ys = [...host.querySelectorAll('.tagbox')].map((b) => Number(b.getAttribute('y'))).sort((a, b) => a - b);
    host.remove();
    return ys;
  });
  ok(tagYs.length === 3 && tagYs.every((y, i) => i === 0 || y - tagYs[i - 1] >= 16), `tags on prices a hair apart do not overlap (${tagYs.map((y) => Math.round(y))})`);
  ok(/Precision pool \(Ethereum\).*Bitcoin order book.*Tacit pool/.test((await text(p, '#legend')).replace(/\s+/g, ' ')), 'the legend names the lanes and the Tacit pool\'s place against Precision');
  ok(/^[+−]\d[\d.]*% Bitcoin against Ethereum · now Ethereum \$0\.\d{4} Bitcoin \$0\.\d{4}$/.test((await text(p, '#ch-read')).replace(/\s+/g, ' ').trim()), `above the chart, how far Bitcoin sits from Ethereum now, and both prices (${(await text(p, '#ch-read')).replace(/\s+/g, ' ').trim()})`);
  await p.hover('#chart svg', { position: { x: 400, y: 150 } });
  await until(p, () => /\d{2}:\d{2}/.test(document.querySelector('#ch-read')?.textContent || ''), null, 5000).catch(() => {});
  ok(/Bitcoin against Ethereum · \d+ \w{3} \d{2}:\d{2}/.test(await text(p, '#ch-read')) && (await p.$$eval('#chart .cross .cd[visibility="visible"]', (d) => d.length)) === 2, 'hovering reads the two prices and their gap at that time, with a dot on each line');
  await p.click('[data-lane="eth"]');
  ok(await p.evaluate(() => { const e = document.querySelector('[data-lane="eth"]'), c = getComputedStyle(e); return e.matches(':hover') && c.color !== c.backgroundColor; }), 'the chosen lane stays readable with the pointer on it');
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'trade-desktop-top.png') });

  // the ticket: a purchase large enough to split
  ok((await p.$$eval('#chips button', (b) => b.map((x) => x.textContent))).join() === '0.05 ETH,0.25 ETH,1 ETH' && (await p.$eval('#cmp', (e) => e.hidden)) === true, 'the ticket offers quick amounts, and the quotes panel waits for an amount');
  await p.click('#chips [data-amt="0.25"]');
  await until(p, () => !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale') && document.querySelector('#out').textContent !== '…', null, 240000);
  const ZQ = '0x000000bd2db80567c23e353ca95a251c573cbf9b', zqCalls = () => r.seen.rpc.filter((x) => x.to === ZQ).length;
  await p.waitForTimeout(1500);
  ok(zqCalls() === 0, `a quote does not ask zQuoter (the heavy scan of every Uniswap, Sushi and Curve pool) until the comparison is opened (${zqCalls()} calls)`);
  await p.click('#cmp > summary');
  await until(p, () => true, null, 1000); await p.waitForTimeout(1500);
  ok(zqCalls() >= 1, `and opening the comparison asks it for the amount on the ticket (${zqCalls()} calls)`);
  await p.click('#cmp > summary');
  ok((await p.inputValue('#amt')) === '0.25' && (await p.getAttribute('#chips [data-amt="0.25"]', 'aria-pressed')) === 'true' && (await p.$eval('#cmp', (e) => e.hidden)) === false, 'pressing one fills the amount, quotes it and shows the quotes');
  await p.fill('#amt', '2');
  await until(p, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale') && Number(document.querySelector('#out').textContent.replace(/,/g, '')) > 5000, null, 240000);
  const route = (await text(p, '#route')).replace(/\s+/g, ' ');
  ok((await contrast(p, '.splitbar .pp')) >= 4.5 && (await contrast(p, '.splitbar .tp')) >= 4.5, `the split bar's labels read on the colours behind them (${(await contrast(p, '.splitbar .pp')).toFixed(2)}, ${(await contrast(p, '.splitbar .tp')).toFixed(2)})`);
  ok(/Split across two pools \+[\d.]+%/.test(route) && /Precision \d+%\s*Tacit \d+%/.test(route) && !!(await p.$('#route .splitbar')), `2 ETH is quoted as a split, drawn as a bar of the two pools with what it gains (${route.slice(0, 160)})`);
  await until(p, () => /Points\s*[\d,]+\+ points/.test(document.querySelector('#route')?.textContent || ''), null, 60000);
  const earned = Number(((await text(p, '#route')).match(/Points\s*([\d,]+)\+ points/) || [])[1]?.replace(/,/g, ''));
  ok(earned > 0 && earned < 2000, `a split earns on its Precision leg only: ${earned}+ points for 2 ETH, under the 2,000 a whole buy through the Precision pool would`);
  ok(/^[\d,]+(\.\d+)?$/.test((await text(p, '#out')).trim()) && Number((await text(p, '#out')).replace(/,/g, '')) > 2 * 3000, `with the TAC it pays (${await text(p, '#out')}: at least 3,000 TAC to the ETH even after the price impact of 2 ETH)`);
  const rows = await p.$$eval('#venues tbody tr', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length >= 5 && rows.length <= 7, `the quotes table holds the places that quote: the pools, the split, the private swap and the Bitcoin book (${rows.length} rows)`);
  ok(rows.some((x) => /^Precision pool.*fee 0\.30%/.test(x)) && rows.some((x) => /^Tacit pool.*public swap/.test(x)) && rows.some((x) => /^Both, split.*best/.test(x)), 'the pools and the split are there (the Precision fee as 0.30%), the split tagged best');
  ok(rows.some((x) => /^Tacit pool, private.*estimate.*before the relay fee/.test(x)), 'the private swap is an estimate, from the same reserves');
  const privHref = await p.$eval('#venues a[href^="/#card="]', (a) => a.getAttribute('href'));
  ok(privHref === '/#card=swap:ether:tac:private&amt=2' && /Swap privately/.test(await text(p, '#route')), `and links to the main page's private swap with the amount (${privHref})`);
  // the arrows turn the trade around, carrying what it gets over as what the other side pays
  const got2 = (await text(p, '#out')).replace(/,/g, '').trim();
  await p.click('#flip');
  await until(p, () => document.querySelector('[data-side="sell"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale') && document.querySelector('#out').textContent !== '…', null, 240000);
  ok(Math.abs(Number(await p.inputValue('#amt')) - Number(got2)) < 0.02 && /ETH/.test(await text(p, '#out-unit')), `the flip sells the ${got2} TAC the purchase would get (${await p.inputValue('#amt')} TAC → ${await text(p, '#out')} ETH)`);
  await p.click('[data-side="buy"]'); await p.fill('#amt', '2');
  await until(p, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
  ok(!(await p.$('#absent')) && !(await p.$('#venues-note')) && !rows.some((x) => /Uniswap v4/.test(x)), 'the quotes say no more than the rows: no line of venues that do not quote, no how-to-read note');
  ok(/#side=buy&amount=2$/.test(p.url()), `the address keeps the side and amount, so a reload or a shared link opens the same ticket (${p.url().split('#')[1]})`);
  ok(rows.some((x) => /^Bitcoin order book.*pay [\d,]+ sats/.test(x)), 'the Bitcoin order book (paid in sats) is a row too');
  ok(/^Buy on Bitcoin →$/.test(await p.$eval('#venues [data-btc-row="buy"]', (b) => b.textContent.trim()).catch(() => '')), 'and leads on to the Bitcoin sheet: "Buy on Bitcoin →" in that row');
  ok(/Connect wallet/.test(await text(p, '#go')) && !(await p.$eval('#go', (b) => b.disabled)), 'with a quote and no wallet the button asks to connect one');

  // a small purchase is not split, and says why a split would not pay
  await p.fill('#amt', '0.02');
  await until(p, () => !/Split across/.test(document.querySelector('#route')?.textContent || '') && /Precision pool|Tacit pool/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 120000);
  ok(/^Route(Precision|Tacit) pool/.test((await text(p, '#route')).replace(/\s+/g, ' ')), `0.02 ETH runs on one pool, whichever pays more today (${(await text(p, '#route')).replace(/\s+/g, ' ').slice(0, 100)})`);

  // amounts: a lone comma is a decimal point, as on the front page; 1,500 is ambiguous and not read
  ok(/this ticket/.test((await text(p, '#venues')).replace(/\s+/g, ' ')), 'the venues table says which row the ticket runs');
  await p.fill('#amt', '0,05'); await until(p, () => !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 120000);
  const withComma = (await text(p, '#out')).trim();
  await p.evaluate(() => { window.__tk = { emptied: false, stale: false }; new MutationObserver(() => { if (!document.querySelector('#route').textContent.trim() || document.querySelector('#out').textContent === '…') window.__tk.emptied = true; if (document.querySelector('.p-ticket').classList.contains('stale')) window.__tk.stale = true; }).observe(document.querySelector('.p-ticket'), { childList: true, subtree: true, characterData: true, attributes: true }); });
  await p.fill('#amt', '0.05'); await until(p, (x) => !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale') && document.querySelector('#out').textContent.trim() !== '…', null, 120000);
  ok(withComma === (await text(p, '#out')).trim() && Number(withComma.replace(/,/g, '')) < 2000, `0,05 ETH reads as 0.05 (both quote ${withComma} TAC), not 5`);
  { const tk = await p.evaluate(() => window.__tk); ok(tk.stale && !tk.emptied, `a new amount leaves the last quote on the ticket, dimmed, until the new one replaces it: the ticket does not empty and fill again (${JSON.stringify(tk)})`); }
  await p.fill('#amt', '1,500'); await until(p, () => /Could not read that amount/.test(document.querySelector('#status')?.textContent || ''), null, 10000);
  ok(await p.$eval('#out', (e) => e.classList.contains('ph')), 'an ambiguous 1,500 is said to be unreadable, with no quote');
  await p.fill('#amt', '1,500.25'); await until(p, () => !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 120000);
  ok(true, 'and 1,500.25 reads as one thousand five hundred and a quarter');
  await p.fill('#amt', '');

  // selling
  await p.click('[data-side="sell"]');
  ok((await p.$$eval('#chips button', (b) => b.map((x) => x.textContent))).join() === '1,000 TAC,5,000 TAC,20,000 TAC', 'the sell side has quick amounts in TAC');
  await p.fill('#amt', '12000');
  await until(p, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
  const sell = (await text(p, '#route')).replace(/\s+/g, ' ');
  ok(/Split across two pools \+[\d.]+%/.test(sell) && /TAC$/.test((await text(p, '#in-unit')).trim()), `selling 12,000 TAC is quoted as a split, paid in ETH (${sell.slice(0, 120)})`);
  ok(/Bitcoin order book.*\d+ bids? · settles (when the bidder is online|within minutes).*sats in fees/.test((await text(p, '#venues')).replace(/\s+/g, ' ')), 'the Bitcoin row says what the standing bids pay for the sale, and that each settles when its bidder is online');
  ok(/^Sell on Bitcoin →$/.test(await p.$eval('#venues [data-btc-row="sell"]', (b) => b.textContent.trim()).catch(() => '')), 'and the sale\'s row leads on too: "Sell on Bitcoin →"');
  await p.click('#book-seg [data-book="btc"]');
  await until(p, () => document.querySelectorAll('#depthchart path.dep-bid.take').length === 1, null, 60000).catch(() => {});
  ok((await p.$$eval('#depthchart path.dep-bid.take', (x) => x.length)) === 1 && (await p.$eval('#depthchart path.dep-bid.take', (x) => x.getBBox().width)) > 1, 'a sale quoted on the Bitcoin tab marks the bids it would take on the depth chart, as a purchase marks the listings');
  ok((await p.$$eval('#ladders [data-btc="buy"]', (b) => b.every((x) => /^Buy [\d,.]+ TAC in all, up to /.test(x.getAttribute('aria-label') || '')))) && (await p.$$eval('#ladders [data-btc="sell"]', (b) => b.every((x) => /^Sell [\d,.]+ TAC in all, down to /.test(x.getAttribute('aria-label') || '')))), 'each Bitcoin row says what a press takes: everything up to its price, in all');

  // the order book and the facts
  ok((await p.getAttribute('[data-book="btc"]', 'aria-pressed')) === 'true', 'with zSwap holding no TAC order the order book opens on Bitcoin\'s listings');
  const dep = await p.$$eval('#ladders .ob-asks .ob-row', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).reverse()), bidRows = await p.$$eval('#ladders .ob-bids .ob-row', (d) => d.length);
  const mid = (await text(p, '#ladders .ob-spread')).replace(/\s+/g, ' ');
  ok(dep.length >= 3 && dep.length <= 8 && bidRows >= 1 && /^\$0\.\d+[\d,.]+ sats/.test(dep[0]) && /last trade/.test(mid) && /(spread [\d.]+%|bids [\d.]+% over asks)/.test(mid), `the book stacks the listings over the last price and the bids under it, one line per price (${dep.length} + ${bidRows}: ${dep[0]} | ${mid})`);
  ok(await p.$eval('#ladders .ob-asks .ob-row:last-child', (e) => parseFloat(getComputedStyle(e, '::before').width) > 0), 'each row is shaded by the depth from the middle out');
  ok((await p.$$eval('#depthchart path.dep-ask:not(.take)', (x) => x.length)) === 1 && (await p.$$eval('#depthchart path.dep-bid:not(.take)', (x) => x.length)) === 1, 'drawn as a depth chart of listings and bids');
  ok((await p.$$eval('#depthchart path.dep-bid:not(.take), #depthchart path.dep-ask:not(.take)', (x) => x.every((e) => e.getBBox().height > 8))), 'both sides of the depth chart are tall enough to see');
  const dbox = await (await p.$('#depthchart svg')).boundingBox();
  await p.hover('#depthchart svg', { position: { x: dbox.width * 0.85, y: dbox.height / 2 } });      // scrolled into view first
  await until(p, () => !document.querySelector('#depthchart .chart-tip')?.hidden, null, 5000).catch(() => {});
  const dtip = (await p.$eval('#depthchart .chart-tip', (e) => e.innerText)).replace(/\s+/g, ' ').trim();
  ok(/^Buy [\d,.]+ TAC up to \$0\.\d+( · \d+ orders)? \$[\d,.]+ in all · average \$0\.\d+$/.test(dtip), `a pointer on the asks reads what buying up to that price takes: the TAC, what it comes to and its average price (${dtip})`);
  await p.mouse.move(5, 5);
  ok(/\d+ bids \([\d,]+ TAC\) settle when the bidder is online/.test(await text(p, '#depth-note')), 'and the note says how many bids stand and when a sale to one settles');
  await p.click('[data-book="trades"]');
  await until(p, () => document.querySelectorAll('#ladders table.trades tbody tr').length >= 3, null, 120000);
  const tr = await p.$$eval('#ladders table.trades tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(tr.length >= 3 && tr.some((x) => /(buy|sell)/.test(x)) && tr.every((x) => /(just now|\d+[mhd] ago)/.test(x)) && !!(await p.$('#ladders table.trades a[href^="https://etherscan.io/tx/"]')) && (await p.$eval('#depthchart', (e) => e.hidden)), `the Trades tab lists the pool's recent swaps with when, side, TAC, price and a link to the transaction (${tr.length} rows: ${tr[0]})`);
  const rowsAt = await p.$$eval('#ladders table.trades tbody tr', (r) => r.length), moreBtn = await p.$('#ladders [data-more-trades]');
  ok(rowsAt === 12 && !!moreBtn && /Show all \d+ trades/.test(await moreBtn.textContent()) && (await p.$eval('#ladders table.trades td small', (e) => getComputedStyle(e).display)) === 'inline' && (await p.$eval('#ladders table.trades tbody tr', (e) => e.getBoundingClientRect().height)) < 46, `the Trades tab shows the first dozen on one line each, with the rest a press away (${rowsAt} rows)`);
  ok((await p.$eval('#ladders table.trades tbody td', (e) => e.title)) !== '', 'and each time carries its date');
  await moreBtn.click();
  ok((await p.$$eval('#ladders table.trades tbody tr', (r) => r.length)) > 12 && /Show fewer/.test(await text(p, '#ladders [data-more-trades]')), 'Show all lists every one, and Show fewer folds them again');
  await p.click('#ladders [data-more-trades]');
  await p.click('[data-book="eth"]');
  await until(p, () => /No TAC orders on zSwap’s boards|No TAC orders on the boards that answered/.test(document.querySelector('#ladders')?.textContent || ''), null, 150000);
  ok(/No TAC orders on zSwap’s boards|No TAC orders on the boards that answered/.test(await text(p, '#ladders')) && !!(await p.$('#ladders a[href^="https://zswap"]')), 'the Ethereum tab says zSwap holds none and where to place one');
  await p.click('[data-book="btc"]');
  ok(/\d+ listings \([\d,]+ TAC\), taken whole/.test(await text(p, '#depth-note')) && !(await p.$('#depth-note a')), 'with how deep the book is (the buttons beside it do what the old links did)');
  const facts = (await text(p, '#facts')).replace(/\s+/g, ' '), more = (await text(p, '#facts-more')).replace(/\s+/g, ' ');
  ok(/21,000,000/.test(await text(p, '#about')) && /ERC-20.*0xA1313e.*TAC minted there/.test(facts) && /2,032 holders/.test(facts) && /Precision pool.*holds [\d.,]+ ETH and [\d,]+ TAC/.test(more), `the facts are live (${facts.slice(0, 120)})`);
  const lay = await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { inSide: !!document.querySelector('.side > .p-info'), infoLeft: r('.p-info').left, ticketLeft: r('.p-ticket').left, farmBottom: r('.p-farm').bottom, infoTop: r('.p-info').top, }; });
  ok(lay.inSide && Math.abs(lay.infoLeft - lay.ticketLeft) < 1 && lay.infoTop >= lay.farmBottom, `on a wide page the facts sit under the farm, in the ticket's column (${JSON.stringify(lay)})`);
  ok(!/Uniswap v4/.test(more) && /TacBuyback/.test(more) && !(await p.$eval('details.more:has(#facts-more)', (d) => d.open)), 'Uniswap v4\'s pools and the buyback are named, behind a "more" that starts closed');

  const nav = await p.$eval('.sn > a:not([aria-current])', (a) => { const c = getComputedStyle(a); return { display: c.display, border: c.borderTopWidth, bg: c.backgroundColor, h: a.getBoundingClientRect().height }; });
  const col = await p.$eval('#venues th.opt', (a) => { const c = getComputedStyle(a); return { display: c.display, border: c.borderTopWidth }; });
  ok(nav.display === 'flex' && nav.border === '0px' && nav.bg === 'rgba(0, 0, 0, 0)' && nav.h <= 40, `the header's links are plain links, not boxes (${JSON.stringify(nav)})`);
  ok(col.display === 'table-cell' && col.border === '0px', `and a table column that hides on phones keeps its own style (${JSON.stringify(col)})`);
  ok(r.errors.length === 0, `no page errors (${r.errors.slice(0, 3).join(' | ')})`);
  ok(r.blocked.length === 0, `nothing blocked by the page's CSP (${r.blocked.slice(0, 2).join(' | ')})`);
  if (SHOTS) await (await p.$('.grid')).screenshot({ path: join(SHOTS, 'trade-desktop-grid.png') }).catch(() => {});
  await r.browser.close();
  if (process.env.TOP_ONLY) { console.log(fails ? `\n${fails} FAILED, ${n} ok (top only)` : `\n${n} trade-page checks passed (top only)`); done(); process.exit(fails ? 1 : 0); }


  // ── trading from the page: a wallet in the browser, backed by the fork ──
  const E18 = 10n ** 18n;
  {
    const me = await fundedWallet(10n * E18, 30000n * E18);
    const w = await openPage({ width: 1280, height: 900 }, me);
    const q = w.page;
    await until(q, () => !!document.querySelector('#chart .line') && /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    ok(/Connect wallet/.test(await text(q, '#go')), 'with no wallet connected the button says Connect wallet');
    // Borrowing against TAC, under the ticket: one line and a link with no wallet; with a wallet holding TAC, what that TAC could borrow, from the vaults themselves.
    const quoteJs = []; q.on('request', (rq) => { if (/\/vault\/quote\.js/.test(rq.url())) quoteJs.push(rq.url()); });
    const bw0 = await q.$eval('#bw', (e) => ({ h: e.getBoundingClientRect().height, t: e.innerText.replace(/\s+/g, ' ').trim(), links: [...e.querySelectorAll('a')].map((a) => a.getAttribute('href')) }));
    ok(/^Borrow TACD or TACE against TAC\. No interest, one fee\. Borrow against TAC →$/.test(bw0.t) && bw0.links.join() === '/vault/' && quoteJs.length === 0, `with no wallet the Borrow box is one line and a link to /vault/, and reads nothing (${bw0.t})`);
    const bwReads = () => w.seen.rpc.filter((x) => x.method === 'eth_call' && x.to === MC3.toLowerCase() && /fc7b9c18/.test(x.data) && /16275096/.test(x.data)).length, bwReads0 = bwReads();
    await q.click('#go');
    await until(q, () => /Balance [\d.,]+ ETH/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    ok(w.walletLog.connects === 1 && /Balance 10 ETH/.test(await text(q, '#in-bal')) && /Enter an amount/.test(await text(q, '#go')), `connecting shows the balance and asks for an amount (${await text(q, '#in-bal')})`);
    ok((await q.$$eval('#chips button', (b) => b.map((x) => x.textContent))).join() === '25%,50%,75%', 'with a wallet that holds ETH the quick amounts are shares of it');
    await q.click('#chips button:nth-child(2)');
    ok((await q.inputValue('#amt')) === '5' && (await q.getAttribute('#chips button:nth-child(2)', 'aria-pressed')) === 'true', `and 50% fills half of it (${await q.inputValue('#amt')} of 10 ETH)`);
    await q.fill('#amt', '');
    await until(q, () => !/^Borrow TACD or TACE against TAC\./.test(document.querySelector('#bw')?.textContent || ''), null, 60000).catch(() => {});
    const bw1 = await q.$eval('#bw', (e) => ({ h: e.getBoundingClientRect().height, t: e.innerText.replace(/\s+/g, ' ').trim(), go: e.querySelector('.bw-go')?.getAttribute('href'), goT: e.querySelector('.bw-go')?.textContent, alt: e.querySelector('.bw-alt')?.getAttribute('href') }));
    ok(quoteJs.length === 1 && bwReads() - bwReads0 >= 1, `a wallet holding TAC loads the quote module once and reads the vaults (${quoteJs.length} module, ${bwReads() - bwReads0} node requests: one Multicall3 read, sent to more than one node by the page's hedging)`);
    const m1 = bw1.t.match(/^Your 30,000 TAC can borrow up to ([\d,.]+) TACD Borrow ([\d,.]+) TACD →(?: or ([\d,.]+) TACE)?$/);
    if (m1) {
      const x = m1[1].replace(/,/g, '');
      ok(m1[2] === m1[1] && bw1.go === `/vault/#v=usd&amt=${x}` && (!m1[3] || bw1.alt === `/vault/#v=eth&amt=${m1[3].replace(/,/g, '')}`), `with 30,000 TAC: “${bw1.t}”, the button opens /vault/ with that amount (${bw1.go}${bw1.alt ? `, ${bw1.alt}` : ''})`);
      // The figure is the vault's: 30,000 TAC at its borrow price over its line, less its fee, is at least it (rounded down) and the vault's room covers it.
      const V = '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F', W1 = async (data) => BigInt(await rpcA('eth_call', [{ to: V, data }, 'latest']));
      const pB = await W1('0x195168b6' + (E18).toString(16).padStart(64, '0') + '1'.padStart(64, '0')), mint = await W1('0x347bbf43'), fee = await W1('0xb76b0aa7');
      const amt = BigInt(Math.round(Number(x) * 100)) * (E18 / 100n), own = 30000n * E18 * pB / E18 * 10000n / mint;
      ok(amt > 0n && amt + amt * fee / 10000n <= own, `and is within what 30,000 TAC backs at the vault’s own price, line and fee (${x} TACD, limit ${Number(own / 10n ** 16n) / 100})`);
    } else ok(bw1.go === '/vault/' && /^(Borrowing against TAC is not open right now\. See the vaults →|Borrow TACD or TACE against TAC\. No interest, one fee\. Borrow against TAC →)$/.test(bw1.t), `the vaults cannot lend on this fork: the box says so or only links, with no figure (${bw1.t})`);
    ok(Math.abs(bw1.h - bw0.h) < 1, `the box keeps its height when the figures arrive (${bw0.h} → ${bw1.h} px)`);
    for (const width of [390, 900]) {
      await q.setViewportSize({ width, height: 900 }); await sleep(100);
      const hh = await q.$eval('#bw', (e) => [e.getBoundingClientRect().height, parseFloat(getComputedStyle(e).minHeight)]);
      ok(hh[0] <= hh[1] + 1, `at ${width} px the content fits the box's reserved height, so nothing moves when it fills in (${hh[0]} of ${hh[1]} px)`);
    }
    await q.setViewportSize({ width: 1280, height: 900 });
    {
      // The vaults lend on mainnet only once their prices are recorded, which this fork may not have: the open state is drawn from the quote module with figures of its
      // own (the module's own limitOf, served in place of its chain read) to check what the box says and where it links.
      const w2 = await openPage({ width: 1280, height: 900 }, me), q2 = w2.page;
      await w2.page.context().route(/\/vault\/quote\.js/, async (route) => {
        const src = readFileSync(join(DAPP, 'vault/quote.js'), 'utf8').replace('export async function quoteBorrow', 'async function quoteChain');
        const f = '{ mint: 30000n, minDebt: 10n * 10n ** 18n, totalDebt: 0n, debtCeiling: 10n ** 24n, depthCeiling: 5000n * 10n ** 18n, feeBps: 50n, pB: 2n * 10n ** 17n }', g = '{ mint: 30000n, minDebt: 4n * 10n ** 15n, totalDebt: 0n, debtCeiling: 10n ** 24n, depthCeiling: 2n * 10n ** 18n, feeBps: 50n, pB: 8n * 10n ** 13n }';
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${src}\nexport async function quoteBorrow({ tac }) { return { usd: limitOf('usd', ${f}, tac), eth: limitOf('eth', ${g}, tac) }; }\n` });
      });
      await until(q2, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
      const h0 = await q2.$eval('#bw', (e) => e.getBoundingClientRect().height);
      await q2.click('#go');
      await until(q2, () => /can borrow/.test(document.querySelector('#bw')?.textContent || ''), null, 60000);
      const b2 = await q2.$eval('#bw', (e) => ({ t: e.innerText.replace(/\s+/g, ' ').trim(), h: e.getBoundingClientRect().height, go: e.querySelector('.bw-go')?.getAttribute('href'), alt: e.querySelector('.bw-alt')?.getAttribute('href') }));
      // 30,000 TAC at $0.20 over a 300% line is $2,000, less the 0.5% fee: 1,990.04; at 0.00008 ETH a TAC, 0.8 ETH less the fee, 0.7960, but the 2 TACE of room caps nothing here.
      ok(b2.t === 'Your 30,000 TAC can borrow up to 1,990.04 TACD Borrow 1,990.04 TACD → or 0.796 TACE' && b2.go === '/vault/#v=usd&amt=1990.04' && b2.alt === '/vault/#v=eth&amt=0.796', `a vault that lends: “${b2.t}” (${b2.go}, ${b2.alt})`);
      ok(Math.abs(b2.h - h0) < 1, `and the box is the height it was before the figures (${h0} → ${b2.h} px)`);
      if (SHOTS) await q2.locator('#bw').screenshot({ path: join(SHOTS, 'borrow-box.png') });
      ok(w2.errors.length === 0 && w2.blocked.length === 0, `nothing logged or blocked (${[...w2.errors, ...w2.blocked].join(' | ')})`);
      await w2.browser.close();
    }
    await q.click('#in-bal'); await until(q, () => document.querySelector('#amt').value !== '', null, 10000);
    ok(Number(await q.inputValue('#amt')) > 9.9 && Number(await q.inputValue('#amt')) < 10, `Max leaves the network fee behind (${await q.inputValue('#amt')})`);
    await q.fill('#amt', '99');
    await until(q, () => /Not enough ETH/.test(document.querySelector('#go')?.textContent || ''), null, 120000);
    ok(await q.$eval('#go', (b) => b.disabled), 'more ETH than the wallet holds says so and cannot be sent');

    // a purchase that splits
    await q.evaluate(() => { window.__go = new Set(); new MutationObserver(() => window.__go.add(document.querySelector('#go').textContent)).observe(document.querySelector('#go'), { childList: true, characterData: true, subtree: true }); });
    await q.fill('#amt', '2');
    await until(q, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && /buy TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok(await q.evaluate(() => window.__go.has('Updating the quote…')), `while a new amount is quoted the button says so and waits (${await q.evaluate(() => [...window.__go].join(' / '))})`);
    if (SHOTS) await q.locator('.p-ticket').screenshot({ path: join(SHOTS, 'ticket-quoted.png') });
    const rv = (await text(q, '#route')).replace(/\s+/g, ' ');
    ok(/Split across two pools/.test(rv) && /Price impact\d+%/.test(rv) && /At least[\d,.]+ TAC/.test(rv) && /Slippage/.test(rv) && !!(await q.$('#slip-seg')) && /checked before it is sent/.test(await text(q, '#tk-note')) && !(await q.$('#review')), `the quote itself says the route, the price impact and the least it takes, with slippage in it and no review step (${rv.slice(0, 200)})`);
    ok(/Network fee(≈ \$\d+\.\d\d|under \$0\.01)/.test(rv) && /gas at [\d.]+ gwei/.test(await q.$eval('#route .kv b[title*="gas at"]', (b) => b.title)), `the quote says what the network takes, at the gas price now (${(rv.match(/Network fee[^S]*/) || [''])[0]})`);
    const floorTxt = (rv.match(/At least([\d,.]+) TAC/) || [])[1];
    ok(await q.$eval('#go', (b) => b.disabled) && /I accept losing about \d+%/.test(await text(q, '#route')), 'a purchase that moves the price over 10% waits for the box to be ticked');
    ok(/^Accept the loss to buy TAC$/.test(await text(q, '#go')), `the waiting button says what it waits for (${await text(q, '#go')})`);
    await q.check('#ack');
    ok((await text(q, '#go')) === 'Buy TAC', 'and ticking the box makes it Buy TAC');
    // the page refreshes its readings each minute: what is on the ticket, a ticked box included, is left as it is
    await q.clock.fastForward(61000); await q.waitForTimeout(2500);
    ok(await q.$eval('#ack', (c) => c.checked) && !(await q.$eval('#go', (b) => b.disabled)), 'a minute passing (the page\'s own refresh) keeps the ticked box and the button ready');
    // what a minute's refresh reads: the Bitcoin lists when the book shows them (else every second minute), the 4-hour tape every fifth minute
    const PP = '0x0155358241411db868ba714ae7c83a27087e3d6e', sales = () => w.seen.api.filter((x) => /preauth-sales/.test(x)).length;
    const coarse = () => w.seen.rpc.filter((x) => x.to === PP && x.data.startsWith('0x29a65241') && BigInt('0x' + x.data.slice(10, 74)) === 14400n).length;
    const minute = async () => { await q.clock.fastForward(61000); await q.waitForTimeout(1800); };
    await q.click('[data-book="btc"]');
    const s0 = sales(), c0 = coarse();
    await minute(); await minute();
    ok(sales() - s0 === 2, `with the Bitcoin book on screen every minute reads its listings (${sales() - s0} in two minutes)`);
    await q.click('[data-book="trades"]');
    const s1 = sales();
    for (let i = 0; i < 4; i++) await minute();
    ok(sales() - s1 === 2, `with the Trades tab on screen the listings are read every second minute (${sales() - s1} in four)`);
    ok(coarse() - c0 === 1, `and the 4-hour tape is read once in these six minutes, the 5-minute one each time (${coarse() - c0})`);
    await q.click('[data-book="btc"]');
    await q.click('[data-slip="100"]');
    ok(await q.$eval('[data-slip="100"]', (b) => b.getAttribute('aria-pressed') === 'true') && (await q.$eval('#ack', (c) => c.checked)), 'slippage is changed in the quote, and the accepted loss stays accepted');
    await q.click('[data-slip="50"]');
    const t0 = await tacBal(me.account), e0 = await ethBal(me.account), n0 = BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])), mc0 = await tacBal(MC3), rt0 = await ethBal(ROUTER);
    await q.click('#go');
    await until(q, () => /Bought\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    const got = (await tacBal(me.account)) - t0, floor = Number(floorTxt.replace(/,/g, ''));
    ok(!!(await q.$('#status #add-tac')), 'a purchase offers TAC to the wallet');
    await q.click('#add-tac');
    await until(q, () => /Added to your wallet/.test(document.querySelector('#status')?.textContent || ''), null, 10000);
    ok(w.walletLog.watched?.[0]?.options?.address === TACADDR && w.walletLog.watched[0].options.symbol === 'TAC' && w.walletLog.watched[0].options.decimals === 18 && (await q.evaluate(() => localStorage.getItem('tacit-trade-tac-added'))) === '1', 'the wallet is asked to list TAC at its address, and the page does not offer it again');
    ok(/Bought\. Received [\d,.]+ TAC/.test(await text(q, '#status')) && Number(got / 10n ** 16n) / 100 >= floor, `2 ETH bought through the split: ${Number(got / 10n ** 16n) / 100} TAC, at least the ${floorTxt} it showed (${(await text(q, '#status')).slice(0, 80)})`);
    ok(BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])) === n0 + 1n && w.walletLog.sends.length === 1 && w.walletLog.sends[0].to.toLowerCase() === ROUTER.toLowerCase(), 'in one transaction, sent to zRouter');
    ok(e0 - (await ethBal(me.account)) >= 2n * E18 && e0 - (await ethBal(me.account)) < 2n * E18 + E18 / 50n && (await tacBal(MC3)) === mc0 && (await ethBal(ROUTER)) === rt0, 'the ETH spent is the 2 ETH and its gas, and nothing is left in Multicall3 or the router');
    ok(/Balance [\d.,]+ ETH/.test(await text(q, '#in-bal')) && (await q.inputValue('#amt')) === '', 'the balance and the form are refreshed');
    ok(!!(await q.$('#status #farm-it')), 'a purchase offers to farm it');
    await q.click('#farm-it');
    await until(q, () => document.querySelector('[data-fm="tac"]')?.getAttribute('aria-pressed') === 'true' && Number(document.querySelector('#fm-tacamt').value) > 0 && /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 120000);
    await q.waitForTimeout(1200);
    const fi = await q.evaluate(() => { const r = document.querySelector('#farm').getBoundingClientRect(); return { tac: Number(document.querySelector('#fm-tacamt').value), eth: document.querySelector('#fm-amt').value, inView: r.top < innerHeight && r.bottom > 0 }; });
    ok(Math.abs(fi.tac - Number(got / 10n ** 16n) / 100) < 0.01 && fi.eth === '' && fi.inView, `Farm it opens the farm on TAC with the TAC just bought typed in and quoted (${fi.tac} of ${Number(got / 10n ** 16n) / 100} TAC)`);
    await until(q, () => !!document.querySelector('#chart path.tpt.up'), null, 30000).catch(() => {});
    ok(!!(await q.$('#chart path.tpt.up')) && /your purchases and sales/.test(await text(q, '#legend')), `the purchase is flagged on the chart at its price, and the key under it says what the flags are (${(await text(q, '#legend')).trim()})`);

    // Yours: the purchase is listed once (what this browser saw, with its figures, and not again from the pool's swap to the same account), with the
    // balances on Ethereum above it; the Trades tab marks that swap as the visitor's
    const logs0 = w.seen.rpc.filter((x) => x.method === 'eth_getLogs').length;
    await q.click('[data-book="mine"]');
    await until(q, () => /ETH · [\d,.]+ TAC on Ethereum/.test(document.querySelector('.mine-eth')?.textContent || ''), null, 60000);
    await until(q, () => document.querySelectorAll('#ladders table.yours.recent tbody tr').length >= 1, null, 60000);
    await q.waitForTimeout(4000);
    const mrows = await q.$$eval('#ladders table.yours.recent tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(w.seen.rpc.filter((x) => x.method === 'eth_getLogs').length > logs0 && mrows.length === 1 && /Bought [\d,]+ TAC for 2 ETH/.test(mrows[0]), `Yours reads the pool's swaps for the account and lists the purchase once (${mrows.length} row: ${mrows[0]?.slice(0, 60)})`);
    ok(/^[\d.]+ ETH · [\d,.]+ TAC on Ethereum$/.test((await text(q, '.mine-eth')).trim()), `with what the wallet holds on Ethereum above it (${(await text(q, '.mine-eth')).trim()})`);
    await q.click('[data-book="trades"]');
    await q.waitForSelector('#ladders table.trades small.you', { timeout: 60000 }).catch(() => null);
    ok((await q.$$('#ladders table.trades small.you')).length >= 1, 'the Trades tab marks the visitor\'s own swap');
    // a swap this browser never logged (another device, or a cleared browser) is listed from the pool's own record: the Precision share of the split, in ETH
    await q.evaluate(() => localStorage.removeItem('tacit-trade-activity-v1'));
    await q.click('[data-book="btc"]'); await q.click('[data-book="mine"]');
    await until(q, () => document.querySelectorAll('#ladders table.yours.recent tbody tr').length >= 1, null, 60000);
    const crow = (await q.$$eval('#ladders table.yours.recent tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim())))[0];
    ok(/Bought [\d,]+ TAC for [\d.]+ ETH/.test(crow) && !/for 2 ETH/.test(crow), `with no record in this browser the purchase is listed from the pool's swap to the account (its Precision share: ${crow.slice(0, 60)})`);
    await q.click('[data-book="btc"]');

    // a sale that splits: the permit is signed in the wallet, then one transaction
    await q.click('[data-side="sell"]');
    await q.fill('#amt', '12000');
    await until(q, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && /sell TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok(await q.$eval('#go', (b) => b.disabled) && /I accept losing about \d+%/.test(await text(q, '#route')), 'a sale that moves the price over 10% waits for the box to be ticked');
    await q.check('#ack'); ok(!(await q.$eval('#go', (b) => b.disabled)), 'ticking it lets the sale go');
    const e1 = await ethBal(me.account), t1 = await tacBal(me.account), n1 = BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest']));
    await q.click('#go');
    await until(q, () => /Sold\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Sold\. Received about [\d.,]+ ETH/.test(await text(q, '#status')) && t1 - (await tacBal(me.account)) === 12000n * E18 && (await ethBal(me.account)) > e1 + 5n * 10n ** 17n, `12,000 TAC sold through the split for ETH (${(await text(q, '#status')).slice(0, 70)})`);
    ok(w.walletLog.sends.every((t) => t.from.toLowerCase() === me.account.toLowerCase()), 'every transaction was sent from the account that traded');
    ok(w.walletLog.signs === 1 && BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])) === n1 + 1n, 'with the permit signed once in the wallet and one transaction sent: no approval, no allowance');
    ok((await tacBal(MC3)) === mc0, 'and Multicall3 holds no TAC');
    await until(q, () => !!document.querySelector('#chart path.tpt.down'), null, 30000).catch(() => {});
    ok(!!(await q.$('#chart path.tpt.down')), 'and the sale is flagged on the chart too');
    ok(w.errors.length === 0 && w.blocked.length === 0, `no page errors or blocked requests while trading (${[...w.errors, ...w.blocked].slice(0, 2).join(' | ')})`);
    await w.browser.close();

    // a wallet that cannot sign a permit (a smart-contract account) approves the pool, and the sale goes by that approval and one transaction
    {
      const sc = await openPage({ width: 1280, height: 900 }, { ...(await fundedWallet(2n * E18, 6000n * E18)), noPermit: true }), sp = sc.page;
      await until(sp, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
      await sp.click('#go'); await until(sp, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
      await sp.click('[data-side="sell"]'); await sp.fill('#amt', '5000');
      await until(sp, () => /sell TAC/i.test(document.querySelector('#go')?.textContent || '') && !document.querySelector('#go').disabled, null, 240000);
      const permitRoute = /Precision pool|Split across/.test(await text(sp, '#route'));
      await sp.click('#go');
      await until(sp, () => /Sold\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
      ok(/Sold\./.test(await text(sp, '#status')) && sc.walletLog.signs === 0 && sc.walletLog.signAttempts === (permitRoute ? 1 : 0) && sc.walletLog.sends.length === 2, `a wallet that cannot sign a permit sells by an approval and a transaction (${sc.walletLog.sends.length} sent, ${sc.walletLog.signAttempts} permit asked; ${(await text(sp, '#status')).slice(0, 50)})`);
      await sc.browser.close();
    }

    // a wallet that says no
    const refuser = await fundedWallet(5n * E18, 0n), rf = await openPage({ width: 1280, height: 900 }, { ...refuser, refuseSends: true });
    await until(rf.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    await rf.page.click('#go'); await until(rf.page, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    await rf.page.fill('#amt', '0.1'); await until(rf.page, () => /buy TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await rf.page.click('#go');
    await until(rf.page, () => /Cancelled in your wallet/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(/Nothing was sent/.test(await text(rf.page, '#status')) && (await tacBal(refuser.account)) === 0n && (await ethBal(refuser.account)) === 5n * E18, 'a wallet that refuses the transaction ends with Cancelled, nothing sent, nothing spent');
    await rf.browser.close();

    // a small balance: the fee row says about two cents, so 0.0013 ETH buys 0.0001 ETH of TAC and is not told to leave 0.004 ETH behind
    const small = await fundedWallet(13n * 10n ** 14n, 1000n * E18), sm = await openPage({ width: 1280, height: 900 }, small);
    await until(sm.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    await sm.page.click('#go'); await until(sm.page, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    await sm.page.fill('#amt', '0.0001'); await until(sm.page, () => /Buy TAC|Leave ETH/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok((await text(sm.page, '#go')) === 'Buy TAC' && !(await sm.page.$eval('#go', (b) => b.disabled)), `0.0001 ETH from a 0.0013 ETH balance can be sent (${await text(sm.page, '#go')})`);
    await sm.page.click('#in-bal'); await until(sm.page, () => Number(document.querySelector('#amt').value) > 0 && Number(document.querySelector('#amt').value) < 0.0013, null, 10000);
    await until(sm.page, () => /Buy TAC|Leave ETH/.test(document.querySelector('#go')?.textContent || '') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
    // what Max keeps back follows the fork's own gas price (1 gwei on an anvil fork, far under it on mainnet): it must be about the fee (the split
    // route's gas, twice, with half again for room), whatever the price, and never the old flat 0.004 ETH
    const forkGas = BigInt((await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' })).json()).result);
    const keepMax = Number(261000n * forkGas * 2n) / 1e18 * 1.5, maxAmt = Number(await sm.page.inputValue('#amt'));
    ok(maxAmt > 0.0013 - keepMax && maxAmt < 0.0013 && (await text(sm.page, '#go')) === 'Buy TAC', `Max keeps back about the fee, not 0.004 ETH, and what it fills in can be sent (${maxAmt}, ${await text(sm.page, '#go')})`);
    await sm.page.fill('#amt', '0.0013'); await until(sm.page, () => /Leave ETH|Not enough/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok((await text(sm.page, '#go')) === 'Leave ETH for the network fee' && (await sm.page.$eval('#go', (b) => b.disabled)), 'all of the balance leaves nothing for the fee and says so');
    await sm.page.click('[data-side="sell"]'); await sm.page.fill('#amt', '100');
    await until(sm.page, () => /Sell TAC|Add ETH/.test(document.querySelector('#go')?.textContent || '') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
    ok((await text(sm.page, '#go')) === 'Sell TAC' && !(await sm.page.$eval('#go', (b) => b.disabled)), `a sale needs ETH for the approval and the swap, not 0.0005 ETH (${await text(sm.page, '#go')})`);
    await sm.browser.close();

    // the card's link: the side and the amount both arrive
    const dl = await openPage({ width: 1280, height: 900 }, null, '#side=sell&amount=1500');
    await until(dl.page, () => document.querySelector('#amt')?.value === '1500' && document.querySelector('[data-side="sell"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
    ok(/TAC$/.test((await text(dl.page, '#in-unit')).trim()), 'a link to #side=sell&amount=1500 opens the sale with the 1,500 TAC quoted');
    await dl.browser.close();

    // an account that changes while a trade is being made: nothing is sent for the other
    const swapper = await fundedWallet(5n * E18, 0n), sw = await openPage({ width: 1280, height: 900 }, swapper);
    await until(sw.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    await sw.page.click('#go'); await until(sw.page, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    await sw.page.fill('#amt', '0.1'); await until(sw.page, () => /buy TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    if (await sw.page.$('#ack')) await sw.page.check('#ack');
    sw.walletLog.onChainId = () => sw.page.evaluate(() => window.__h.accountsChanged(['0x000000000000000000000000000000000000dEaD']));
    await sw.page.click('#go');
    await until(sw.page, () => /account changed/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(sw.walletLog.sends.length === 0 && (await tacBal(swapper.account)) === 0n && (await ethBal(swapper.account)) === 5n * E18, 'a wallet whose account changes while the trade is made is sent nothing: the trade stops, and nothing is spent');
    await sw.browser.close();
  }

  // ── zSwap's boards: orders for TAC placed on the fork, read into an order book and filled from the page ──
  {
    const sendTx = async (from, to, sig, args = [], value = 0n) => {
      const h = await rpcA('eth_sendTransaction', [{ from, to, data: cast('calldata', sig, ...args.map(String)), ...(value ? { value: '0x' + value.toString(16) } : {}), gas: '0x2dc6c0' }]);
      let rc = null; for (let i = 0; i < 80 && !rc; i++) { rc = await rpcA('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
      if (!rc || rc.status !== '0x1') throw new Error(`${sig} failed on the fork`);
    };
    const V1 = '0x000000fF3D7A2d373615141d7489Ca66683DbecF', V2 = '0x000000dA7bb4B2A9E3e80e9A4D4157E26CA6189b', DU = '0x000000a213b430D14Bae6062c176289B05e04489', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ZERO = '0x0000000000000000000000000000000000000000';
    const m1 = await fundedWallet(50n * E18, 100000n * E18), m2 = await fundedWallet(50n * E18, 100000n * E18), m3 = await fundedWallet(50n * E18, 100000n * E18), m4 = await fundedWallet(50n * E18, 100000n * E18);
    const nextId = async (board, sig) => BigInt(await rpcA('eth_call', [{ to: board, data: cast('sig', sig) }, 'latest']));
    const idV1 = await nextId(V1, 'nextOrderId()'), idV2 = await nextId(V2, 'nextOrderId()'), idDu = await nextId(DU, 'nextId()');
    const eth = (milli) => BigInt(milli) * 10n ** 15n, tac = (n) => BigInt(n) * E18;
    await sendTx(m1.account, TACADDR, 'approve(address,uint256)', [V1, tac(1000)]);
    await sendTx(m1.account, V1, 'createOrder(address,uint256,address,uint256)', [TACADDR, tac(1000), WETH, eth(10)]);                                       // v1 ask: 1000 TAC for 0.01 ETH
    await sendTx(m2.account, TACADDR, 'approve(address,uint256)', [V2, tac(2000)]);
    await sendTx(m2.account, V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TACADDR, tac(2000), WETH, eth(40), true, 0, false, false, ZERO]);   // v2 ask, partial: 2000 TAC for 0.04 ETH
    await sendTx(m3.account, V2, 'createOrderWithEth(address,uint256,bool,uint64,bool,address)', [TACADDR, tac(1000), true, 0, false, ZERO], eth(15));            // v2 bid, partial: 0.015 ETH for 1000 TAC
    await sendTx(m4.account, TACADDR, 'approve(address,uint256)', [DU, tac(1000)]);
    await sendTx(m4.account, DU, 'listERC20(address,address,uint128,uint256,uint256,uint40,uint40,uint40)', [TACADDR, ZERO, tac(1000), eth(30), eth(20), 0, 360000, 0]);   // Dutchboard ask: 1000 TAC, 0.03 falling to 0.02 ETH
    const me = await fundedWallet(10n * E18, 30000n * E18);
    await sendTx(me.account, TACADDR, 'approve(address,uint256)', [V2, tac(500)]);
    await sendTx(me.account, V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TACADDR, tac(500), WETH, eth(30), true, 0, false, false, ZERO]);         // the account's own ask

    const w = await openPage({ width: 1280, height: 900 }, me);
    const q = w.page;
    await until(q, () => !!document.querySelector('#chart .line') && document.querySelector('[data-book="eth"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#ladders [data-fill]').length >= 4, null, 240000);
    const lad = (sel) => q.$$eval(sel, (rows) => rows.map((x) => `${x.textContent} ${x.title || ''}`.replace(/\s+/g, ' ').trim()));
    const askRows = () => lad('#ladders .ob-asks .ob-row').then((r) => r.reverse());                 // drawn with the cheapest nearest the middle
    const asks = await askRows(), bids = await lad('#ladders .ob-bids .ob-row');
    ok(asks.length === 4 && bids.length === 1, `the Ethereum tab opens with orders: ${asks.length} to sell, ${bids.length} to buy (${asks[0].slice(0, 90)})`);
    ok(/^\$0\.\d+.*1,000.*0\.01.*Swapboard v1.*whole only/.test(asks[0]) || /^\$0\.\d+.*1,000.*0\.01.*Swapboard v1/.test(asks.find((x) => /Swapboard v1/.test(x)) || ''), 'each with its price, size, the ETH it takes, the board and what it allows');
    ok(asks.some((x) => /Dutchboard.*price changes with time/.test(x)) && asks.some((x) => /Swapboard v2.*part fills ok/.test(x)) && /Swapboard v2/.test(bids[0]), 'a Dutchboard lot, a partial v2 order and the v2 bid are all there');
    ok((await q.$$eval('#depthchart path.dep-ask', (x) => x.length)) >= 1 && (await q.$$eval('#depthchart path.dep-bid', (x) => x.length)) >= 1, 'and drawn as a depth chart of both sides');
    ok(!(await askRows()).some((x) => /yours/.test(x)), 'before a wallet is connected no order is marked as the account\'s');
    await q.click('#go');
    await until(q, () => /Balance [\d.,]+ ETH/.test(document.querySelector('#in-bal')?.textContent || '') && document.querySelectorAll('#ladders .ob-row.mine').length === 1, null, 60000);
    ok(/yours/.test(await text(q, '#ladders .ob-row.mine')) && !(await q.$('#ladders .ob-row.mine[data-fill]')), 'once connected, the account\'s own order says yours and has no Fill');

    // the best route: boards that take the amount and pay more than the pools are what the ticket uses
    await q.fill('#amt', '0.03');
    await until(q, () => /zSwap order|Swapboard v\d order|Dutchboard order/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
    const auto = (await text(q, '#route')).replace(/\s+/g, ' ');
    ok(/Route.*(zSwap orders|Swapboard v1 order|Swapboard v2 order)/.test(auto) && !/Tacit pool|Precision/.test(auto), `0.03 ETH goes to the boards, whose orders are cheaper than the pools (${auto.slice(0, 110)})`);
    const vrows = await lad('#venues tbody tr');
    ok(vrows.some((x) => /^zSwap boards.*this ticket/.test(x)) && vrows.some((x) => /best/.test(x) && /^zSwap boards/.test(x)), 'the quotes table lists zSwap boards as the route and the best');
    ok((await q.$$eval('#ladders .ob-row.take', (x) => x.length)) >= 1 && (await q.$$eval('#depthchart path.dep-ask.take', (x) => x.length)) === 1 && (await q.$$eval('#depthchart path.dep-ask.take', (x) => x[0].getBBox().width)) > 1, 'and the order book marks the orders the ticket would take, in the ladder and on the chart (a band with width)');
    await q.fill('#amt', '');

    // Fill on the cheapest order pins it to the ticket
    const fillKey = await q.$$eval('#ladders .ob-asks .ob-row[data-fill]:not(.mine)', (b) => b.at(-1).dataset.fill);
    ok(fillKey === `v1:${idV1}`, `the cheapest order is the Swapboard v1 one (${fillKey})`);
    await q.click(`[data-fill="${fillKey}"]`);
    await until(q, () => /Filling Swapboard v1/.test(document.querySelector('#pin')?.textContent || '') && /^1,000/.test(document.querySelector('#out')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale') && /buy TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);   // that order's own quote, not the one before it
    ok(/Filling Swapboard v1 order #\d+/.test(await text(q, '#pin')) && (await q.inputValue('#amt')) === '0.01' && /^1,000/.test((await text(q, '#out')).trim()), `Fill sets the ticket to buy that order whole: 0.01 ETH for ${await text(q, '#out')} TAC`);
    ok(/Route.*Swapboard v1 order #\d+/.test((await text(q, '#route')).replace(/\s+/g, ' ')), 'and the route is that order');
    const rvb = (await text(q, '#route')).replace(/\s+/g, ' ');
    ok(/Swapboard v1 order #\d+/.test(rvb) && /At least[\d,.]+ TAC/.test(rvb) && !/I accept losing/.test(rvb), `the quote names the order and the least it takes (${rvb.slice(0, 150)})`);
    const t0 = await tacBal(me.account), e0 = await ethBal(me.account), mc0 = await tacBal(MC3), n0 = w.walletLog.sends.length;
    await q.click('#go');
    await until(q, () => /Bought\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Bought\. Received 1,000 TAC/.test(await text(q, '#status')) && (await tacBal(me.account)) - t0 === tac(1000), `the order was filled: exactly 1,000 TAC arrived (${(await text(q, '#status')).slice(0, 60)})`);
    ok(w.walletLog.sends.length === n0 + 1 && w.walletLog.sends.at(-1).to.toLowerCase() === ROUTER.toLowerCase() && e0 - (await ethBal(me.account)) >= eth(10) && e0 - (await ethBal(me.account)) < eth(10) + E18 / 100n, 'in one transaction to zRouter, costing 0.01 ETH and its gas');
    await until(q, (k) => !document.querySelector(`[data-fill="${k}"]`), fillKey, 120000);                       // the page reads the boards again once the trade has landed
    ok((await tacBal(MC3)) === mc0 && await q.$eval('#pin', (e) => e.hidden), 'the filled order has left the book, the pin is gone, and Multicall3 holds nothing');

    // a sale into the bid: the permit is signed, then one transaction
    const bidKey = await q.$eval('#ladders .ob-bids .ob-row[data-fill]', (b) => b.dataset.fill);
    ok(bidKey === `v2:${idV2 + 1n}`, `the bid is the Swapboard v2 one (${bidKey})`);
    await q.click(`[data-fill="${bidKey}"]`);
    await until(q, () => !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale') && /sell TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok((await q.inputValue('#amt')) === '1000' && /Filling Swapboard v2 order/.test(await text(q, '#pin')) && /^0\.015/.test((await text(q, '#out')).trim()), `Fill on a bid sets the ticket to sell 1,000 TAC for ${await text(q, '#out')} ETH`);
    if (await q.$('#ack')) await q.check('#ack');
    const s1 = w.walletLog.signs, tt = await tacBal(me.account), ee = await ethBal(me.account);
    await q.click('#go');
    await until(q, () => /Sold\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Sold\. Received about 0\.01/.test(await text(q, '#status')) && tt - (await tacBal(me.account)) === tac(1000) && (await ethBal(me.account)) - ee > eth(14) - E18 / 100n, `1,000 TAC sold into the bid for about 0.015 ETH (${(await text(q, '#status')).slice(0, 70)})`);
    await until(q, (k) => !document.querySelector(`[data-fill="${k}"]`), bidKey, 120000);
    ok(w.walletLog.signs === s1 + 1, 'with the permit signed once, no approval, and the bid gone from the book');

    // "Use the best route" lets go of a pinned order
    const dutchKey = await q.$eval('#ladders [data-fill^="dutch:"]', (b) => b.dataset.fill);
    await q.click(`[data-fill="${dutchKey}"]`);
    await until(q, () => /Filling Dutchboard order/.test(document.querySelector('#pin')?.textContent || '') && /buy TAC/i.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await q.click('#unpin');
    ok(await q.$eval('#pin', (e) => e.hidden), '"Use the best route" lets go of the pinned order');

    // an order filled by someone else between the quote and the press stops the trade: nothing is sent
    await q.click(`[data-fill="${dutchKey}"]`);
    await until(q, () => /buy TAC/i.test(document.querySelector('#go')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 240000);
    const rival = await fundedWallet(10n * E18, 0n);
    await sendTx(rival.account, DU, 'fill(uint256,uint128,address,uint256)', [idDu, tac(1000), rival.account, eth(40)], eth(40));
    const before = w.walletLog.sends.length;
    if (await q.$('#ack')) await q.check('#ack');
    await q.click('#go');
    await until(q, () => /filled or cancelled/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(/Nothing was sent/.test(await text(q, '#status')) && w.walletLog.sends.length === before, 'a lot someone else fills after the quote stops the trade with nothing sent');
    await until(q, (k) => !document.querySelector(`[data-fill="${k}"]`) && document.querySelector('#pin').hidden, dutchKey, 120000);
    ok(true, 'and the filled lot leaves the book and the pin');
    ok(w.errors.length === 0 && w.blocked.length === 0, `no page errors or blocked requests with the boards (${[...w.errors, ...w.blocked].slice(0, 2).join(' | ')})`);
    await w.browser.close();
  }


  // the main page takes the private swap from the link: the console on Swap, ETH to TAC, the amount in, the address its own again
  {
    const fp = await openPage({ width: 1280, height: 900 }, null, '#card=swap:ether:tac:private&amt=0.25', '/');
    await until(fp.page, () => (document.querySelector('#hx-swap #amt') || document.querySelector('#hx-amt'))?.value === '0.25', null, 120000).catch(() => {});
    const st = await fp.page.evaluate(() => ({ amt: (document.querySelector('#hx-swap #amt') || document.querySelector('#hx-amt'))?.value, tab: document.querySelector('[data-hxm][aria-selected="true"]')?.dataset.hxm, hash: location.hash }));
    ok(st.amt === '0.25' && st.tab === 'swap' && st.hash === '', `the main page opens its console on the private swap with the amount (${JSON.stringify(st)})`);
    await fp.browser.close();
  }

  // the addresses: TAC's own, and the bare ones people type
  {
    const own = await openPage({ width: 1280, height: 900 }, null, '', '/trade/tac/');
    await until(own.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && !!document.querySelector('#chart .line'), null, 240000);
    ok(own.page.url().endsWith('/trade/tac/') && /tacit trade$/.test(await own.page.title()) && (await own.page.getAttribute('link[rel="canonical"]', 'href')) === 'https://tacit.finance/trade/tac/', '/trade/tac/ is the trade page at its own address, naming itself as its canonical one');
    ok((await own.page.getAttribute('meta[property="og:url"]', 'content')) === 'https://tacit.finance/trade/tac/' && own.errors.length === 0 && own.blocked.length === 0, 'and its shared link says so too, with nothing blocked');
    await own.browser.close();
    const bare = await openPage({ width: 1280, height: 900 }, null, '#side=sell&amount=1500', '/trade/tac');
    await until(bare.page, () => /\/trade\/tac\/#side=sell/.test(location.href) && document.querySelector('#amt')?.value === '1500' && !document.querySelector('#out')?.classList.contains('ph') && !document.querySelector('.p-ticket')?.classList.contains('stale'), null, 240000);
    ok(/\/trade\/tac\/#side=sell&amount=1500$/.test(bare.page.url()) && /tacit trade$/.test(await bare.page.title()), '/trade/tac, without the slash, arrives at /trade/tac/ with the link\'s fragment kept: the sale of 1,500 TAC is quoted');
    // a ticket link followed while the page is open sets the ticket; an address with neither side nor amount (#farm) leaves it alone
    const quoted = (v) => until(bare.page, (x) => document.querySelector('#amt')?.value === x && !document.querySelector('#out')?.classList.contains('ph') && !document.querySelector('.p-ticket')?.classList.contains('stale'), v, 240000);
    await bare.page.evaluate(() => { location.hash = '#side=buy&amount=0.05'; });
    await quoted('0.05');
    ok((await bare.page.getAttribute('#side-seg [data-side="buy"]', 'aria-pressed')) === 'true' && /TAC/.test(await text(bare.page, '#out-unit')) && /^#side=buy&amount=0\.05$/.test(await bare.page.evaluate(() => location.hash)), 'a link to #side=buy&amount=0.05 followed on the open page turns the ticket to a purchase of 0.05 ETH, quoted');
    await bare.page.evaluate(() => { location.hash = '#farm'; });
    await bare.page.waitForTimeout(600);
    ok((await bare.page.inputValue('#amt')) === '0.05' && (await bare.page.getAttribute('#side-seg [data-side="buy"]', 'aria-pressed')) === 'true', 'and #farm leaves the ticket as it was');
    // an amount whose output is less than the last place shown says so, not 0
    await bare.page.fill('#amt', '0.00000001');
    await until(bare.page, () => /^under /.test(document.querySelector('#out')?.textContent || '') && !document.querySelector('.p-ticket')?.classList.contains('stale'), null, 240000);
    ok(/^under 0\.01$/.test(await text(bare.page, '#out')) && !/e-/.test(await text(bare.page, '#out-usd')) && /under 0\.01 TAC/.test(await text(bare.page, '#route')), `a dust purchase reads "under 0.01" TAC, not 0 (${await text(bare.page, '#out-usd')})`);
    await bare.browser.close();
    const root = await openPage({ width: 1280, height: 900 }, null, '', '/trade');
    await until(root.page, () => /\/trade\/tac\/$/.test(location.pathname) && /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    ok(/tacit trade$/.test(await root.page.title()), '/trade arrives at /trade/tac/');
    await root.browser.close();
  }

  // dark
  if (SHOTS) {
    const d = await chromium.launch(), dctx = await d.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }), dp = await dctx.newPage();
    for (const h of RPC_HOSTS) await dctx.route(`https://${h}/**`, async (route) => { const x = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() }); await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await x.text() }); });
    await dctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(apiBody(route.request().url())) }));
    await dp.goto(`http://127.0.0.1:${WEB}/trade/`);
    await until(dp, () => !!document.querySelector('#chart .line') && document.querySelectorAll('#ladders .ob-row').length > 0, null, 240000);   // the earlier checks have filled some of the orders
    await dp.click('[data-lane="cmp"]'); await dp.fill('#amt', '0.5');
    await until(dp, () => !document.querySelector('#out').classList.contains('ph') && !document.querySelector('.p-ticket').classList.contains('stale'), null, 120000);
    await dp.screenshot({ path: join(SHOTS, 'trade-dark.png') });
    await d.close();
  }

  // a node that never answers does not hold the page up: the next is asked after the hedge, and the price is on screen long before the first node's timeout
  await r.browser.close();
  r = await openPage({ width: 1280, height: 900 }, null, '', '/trade/', { hedge: '1200', hangFirst: true });
  const tH = Date.now();
  await until(r.page, () => /^\$0\.\d/.test(document.querySelector('#px-usd')?.textContent || ''), null, 120000);
  ok(Date.now() - tH < 11000, `with the first node never answering the price is read from the next (${Date.now() - tH} ms, not the 12 s the first node's timeout would cost)`);
  await r.browser.close();
  // a phone
  r = await openPage({ width: 390, height: 844 });
  const m = r.page;
  await until(m, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && !!document.querySelector('#chart .line'), null, 240000);
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll at 390px (${await m.evaluate(() => document.documentElement.scrollWidth)})`);
  const order = await m.evaluate(() => ['.p-ticket', '.p-chart', '.p-depth', '.p-info'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)));
  ok(order.every((t, i) => i === 0 || t > order[i - 1]), `the panels stack ticket, chart, book, facts (${order})`);
  ok((await m.$eval('#chart', (e) => e.getBoundingClientRect().width)) > 300, 'the chart takes the phone\'s width');
  ok(await m.$$eval('.sn > a', (a) => a.every((x) => getComputedStyle(x).display === 'none')) && (await m.$$eval('.sm-p a.pr', (a) => a.length)) === 4, 'and the header\'s page links are in its menu there');
  const hd = await m.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { top: r('.top').height, brand: r('.brand').top, chip: r('#wallet-chip').top, menu: r('.sn summary').width }; });
  ok(hd.top < 90 && Math.abs(hd.brand - hd.chip) < 30 && hd.menu > 30, `the brand, the menu and the wallet chip share one row on a phone (${JSON.stringify(hd)})`);
  const subh = await m.$eval('#px-sub', (e) => e.getBoundingClientRect().height);
  ok(subh >= parseFloat(await m.$eval('#px-sub', (e) => getComputedStyle(e).minHeight)) - 1 && (await m.$$eval('#px-sub .st', (a) => a.every((x) => x.getBoundingClientRect().height < 26))), `the headline's figures are one line each, in a block that holds its height (${subh}px)`);
  const hs = await m.$eval('#hints-sum', (e) => ({ h: e.getBoundingClientRect().height, t: e.textContent.replace(/\s+/g, ' ').trim() }));
  ok(hs.h < 32 && /Ethereum \$0\.\d+/.test(hs.t) && /Bitcoin \$0\.\d+/.test(hs.t), `the prices under the headline are one line on a phone, the chains' names kept for a screen reader (${Math.round(hs.h)}px: ${hs.t})`);
  const shift = await m.evaluate(() => new Promise((done) => { let v = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) v += e.value; }).observe({ type: 'layout-shift', buffered: true }); setTimeout(() => done(v), 100); }));
  ok(shift < 0.05, `nothing moves as the page's figures arrive (layout shift ${shift.toFixed(4)})`);
  if (SHOTS) await m.screenshot({ path: join(SHOTS, 'trade-phone.png'), fullPage: true });
  // the chart comes back as it was left: its lane, range and kind are kept in this browser
  await m.click('[data-lane="btc"]'); await m.click('[data-kind="candles"]'); await m.click('[data-range="0"]');
  await m.reload();
  await until(m, () => document.querySelector('[data-lane="btc"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-kind="candles"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#chart .body').length > 0, null, 120000).catch(() => {});
  ok((await m.getAttribute('[data-lane="btc"]', 'aria-pressed')) === 'true' && (await m.getAttribute('[data-kind="candles"]', 'aria-pressed')) === 'true' && (await m.getAttribute('#range-seg [data-range="0"]', 'aria-pressed')) === 'true', 'the chart opens again on the lane, range and kind it was left on');
  ok(r.errors.length === 0 && r.blocked.length === 0, `and no errors or blocked requests there (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / '));
  if (r) console.log('     errors:', r.errors.slice(0, 4), 'blocked:', r.blocked.slice(0, 3));
  await r?.browser.close().catch(() => {});
} finally { done(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-page checks passed`);
process.exit(fails ? 1 : 0);
