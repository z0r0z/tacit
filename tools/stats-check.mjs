#!/usr/bin/env node
// Checks the Cross-chain card on the stats page (dapp/weld/stats) in a real browser with every service stubbed: the pool and relay
// answer fixed counters, the reflection's status carries what it recorded, and the explorers list nothing. Nothing reaches a live
// service, and no fork is needed.
//   to Bitcoin       the pool's attested cross-out count, with the reflection's folded count beside it
//   spent on Ethereum the pool's count of Bitcoin notes spent on Ethereum directly
//   bridged in       the burns the reflection has recorded (a status that lacks the field leaves it out)
//   activity chart   drawn from a shared reading whose device-pool deposits number in the hundreds of thousands
//   PLAYWRIGHT=<path to playwright-core> node tools/stats-check.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const WEB = 8990 + Math.floor(Math.random() * 90);
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let failed = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${extra ? ` (${extra})` : ''}`); if (!c) failed++; };
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const COUNTS = { '0x1fd4827a': 970100, '0xa6f8c9d6': 9, '0x281d8cc9': 2, '0x0be4f422': 7921 };   // tipHeight, crossOuts, consumed, nextLeafIndex

async function card(status) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const answer = (m, p) => {
    if (m === 'eth_blockNumber') return '0x18e8c59';
    if (m === 'eth_call') {
      const d = (p[0].data || '').slice(0, 10);
      if (d in COUNTS) return word(COUNTS[d]);
      if (d === '0x59a53331') return word(970090);                  // blockHeight(hash)
      return word(0);
    }
    if (m === 'eth_getLogs') return [];
    return '0x0';
  };
  for (const host of ['mainnet.gateway.tenderly.co', 'ethereum-rpc.publicnode.com', 'cloudflare-eth.com', 'eth.drpc.org', 'mainnet.base.org', 'base-rpc.publicnode.com', 'rpc.mainnet.chain.robinhood.com']) {
    await ctx.route(`https://${host}/**`, async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      const one = (b) => ({ jsonrpc: '2.0', id: b.id, result: answer(b.method, b.params || []) });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    });
  }
  const send = (route, b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
  await ctx.route((u) => u.hostname !== '127.0.0.1', async (route) => {      // lowest priority: the routes below are tried first
    const body = JSON.parse(route.request().postData() || 'null');
    if (!body || typeof body !== 'object') return send(route, {}, 404);
    const one = (b) => ({ jsonrpc: '2.0', id: b.id, result: answer(b.method, b.params || []) });
    return send(route, Array.isArray(body) ? body.map(one) : one(body));
  });
  await ctx.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/reflection/status') return send(route, status);
    if (u.pathname === '/leaderboard') return send(route, []);
    return send(route, {}, 404);
  });
  for (const host of ['eth.blockscout.com', 'base.blockscout.com', 'api.routescan.io']) await ctx.route(`https://${host}/**`, (route) => send(route, { status: '1', message: 'OK', result: [], items: [] }));
  for (const host of ['mempool.space', 'blockstream.info']) await ctx.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '970124' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('     page error:', e.message));
  await page.goto(`http://127.0.0.1:${WEB}/weld/stats/`);
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => /^Cross-chain/.test(c.querySelector('.k')?.textContent.trim() || '') && c.querySelector('.v .sk') == null), null, { timeout: 30000 });
  const text = await page.$$eval('.card', (cs) => cs.map((c) => ['.k', '.v', '.m'].map((x) => c.querySelector(x).textContent.replace(/\s+/g, ' ').trim()).join(' | ')).find((t) => t.startsWith('Cross-chain |')));
  const gloss = await page.evaluate(() => [...document.querySelectorAll('dt')].find((d) => /^Cross-chain/.test(d.textContent))?.nextElementSibling?.textContent || '');
  await browser.close();
  return { text, gloss };
}

// The shared reading the API gives the page (/stats?view=page), as small as the page will draw. A device pool's deposits come in buckets
// [time, amount, how many], so one row can stand for a great many: the page lists each deposit's time for the activity chart.
async function activity(buckets) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const now = Math.floor(Date.now() / 1000), day = 86400, n = (v) => ({ $n: String(v) });
  const wei = (v) => n(BigInt(v) * 10n ** 15n);
  const at = (d) => now - d * day;
  const reading = {
    at: Date.now(), block: 26390305, partial: false, stale: [], staleAt: null, errors: {},
    pts: { participants: 3, full: true, points: 1000, allocated: n(1000), claimed: n(500) },
    link: {
      tip: 975405, btcTip: 975408, attestedHeight: 975381, anchorHeight: 964163, attests: 3, lastAttest: { hash: '0x' + 'ab'.repeat(32), timeStamp: at(1) },
      settles: 5, notes: 4, spent: 3, crossOuts: 21, consumed: 2,
      status: { network: 'mainnet', attestedHeight: 975381, tipHeight: 975381, lagBlocks: 0, confirmations: 24, foldedCrossoutCount: 19, bridgeBurns: 38, bridgeMinted: 27, consumedCount: 2, liveNotes: 3746 },
      times: { settles: [at(20), at(12), at(9), at(4), at(1)], attests: [at(18), at(10), at(2)] },
    },
    btc: { locked: n(11946354), nLocked: 24, redeemed: 1, unlocked: 1, waiting: 0, mint: n(12028354), nMint: 26, bonds: wei(5000), nBonds: 25, borrowed: n(479831815650), repaid: n(37046000000), liq: n(0), out: n(442785815650), open: 12, tacbtc: wei(294), tacusd: wei(18916) },
    tac: { supply: n(2766665201012540000000000n), tacIn: { n: 104, v: n(131941613676550000000000n) }, tacOut: { n: 1002, v: n(749599902932630000000000n), who: 165 }, times: { out: [at(15), at(3)], in: [at(16)] }, claims: 1072, claimed: n(652684023255810000000000n), claimers: 1072, others: [] },
    eth: { inWei: wei(3000), held: wei(20), outWei: wei(2980), deposits: 2, lastAt: at(5), wallets: 2, unread: 0, series: { ins: [[at(25), wei(2)], [at(5), wei(1)]], flows: [[at(25), wei(2)], [at(5), wei(-1)]] } },
    dev: [{ chain: 8453, bal: wei(100), dep: wei(5000), wd: wei(4900), nd: buckets, nw: 10, moves: buckets + 10, lastAt: at(1), series: { ins: [[at(14), wei(1), buckets]], flows: [[at(14), wei(1)]] } }],
  };
  const send = (route, b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
  await ctx.route((u) => u.hostname !== '127.0.0.1', (route) => send(route, {}, 404));
  await ctx.route('https://api.tacit.finance/**', (route) => (new URL(route.request().url()).pathname === '/stats' ? send(route, JSON.parse(JSON.stringify(reading, (_, x) => (typeof x === 'bigint' ? { $n: x.toString() } : x)))) : send(route, {}, 404)));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}/weld/stats/`);
  await page.waitForFunction(() => !/Reading the chains/.test(document.querySelector('#asof')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const out = await page.evaluate(() => ({
    asof: document.querySelector('#asof')?.textContent.trim() || '',
    drawn: !!document.querySelector('#c-act svg'), shown: document.querySelector('#f-act')?.hidden === false,
    rows: [...document.querySelectorAll('#c-act .rl')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  }));
  await browser.close();
  return { ...out, errors };
}

console.log('== an activity chart over deposits far past a hundred thousand');
for (const buckets of [1000, 300000]) {
  const a = await activity(buckets);
  const dep = (a.rows.find((t) => /^ETH deposits/.test(t)) || '').replace(/[^\d]/g, '');
  ok(a.errors.length === 0, `${buckets.toLocaleString('en')} deposits in one bucket: the page raises no error`, a.errors[0] || '');
  ok(a.drawn && a.shown, 'and the chart is drawn', a.rows.join(' · '));
  ok(Number(dep) === buckets + 2, 'with every deposit counted: the bucket and the pool\'s own two', dep);
  ok(/^As of /.test(a.asof), 'and the page says when the reading is from', a.asof.slice(0, 60));
}
console.log('== a status that carries the reflection\'s recorded bridges');
let r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, bridgeBurns: 27, liveNotes: 3860 });
ok(/9 to Bitcoin \(7 folded\)/.test(r.text) && /2 spent on Ethereum/.test(r.text) && /27 bridged in/.test(r.text), 'each kind of move is named', r.text);
ok(/^Cross-chain \| 38 ?moves/.test(r.text.replace(/\s+/g, ' ')), 'the total counts all three: 9 + 2 + 27', r.text.slice(0, 40));
ok(/bridges in/.test(r.gloss), 'the glossary says what a bridge in is', r.gloss.slice(0, 160));
console.log('== a status that also says how many have minted');
r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, bridgeBurns: 37, bridgeMinted: 27, liveNotes: 3860 });
ok(/27 bridged in \(10 more recorded, not minted yet\)/.test(r.text), 'arrivals are the bridges in, and the recorded-not-minted burns are named beside them', r.text);
ok(/^Cross-chain \| 38 ?moves/.test(r.text.replace(/\s+/g, ' ')), 'and the total counts the arrivals: 9 + 2 + 27', r.text.slice(0, 40));
r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, bridgeBurns: 27, bridgeMinted: 27, liveNotes: 3860 });
ok(/27 bridged in/.test(r.text) && !/not minted/.test(r.text), 'with every recorded burn minted nothing is said to wait', r.text);
r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, bridgeBurns: 37, bridgeMinted: null, liveNotes: 3860 });
ok(/37 bridged in/.test(r.text) && !/not minted/.test(r.text), 'a minted count that could not be read falls back to the recorded figure', r.text);
console.log('== an API that predates the field');
r = await card({ attestedHeight: 970090, tipHeight: 970100, foldedCrossoutCount: 7, consumedCount: 2, liveNotes: 3860 });
ok(/9 to Bitcoin \(7 folded\)/.test(r.text) && /2 spent on Ethereum/.test(r.text) && !/bridged in/.test(r.text), 'the line reads as before, without a bridged-in figure', r.text);
ok(/^Cross-chain \| 11 ?moves/.test(r.text.replace(/\s+/g, ' ')), 'and the total is the two counters', r.text.slice(0, 40));
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
