#!/usr/bin/env node
// The swap card on its test harness (tests/swap-harness/, the retired /swap/ page, served at /swap/) in a real browser, under the page's own CSP: the Bitcoin lane (the third switch under the card's title) swaps tETH and TAC in the Bitcoin pool with a
// Tacit key. The lane is the real files (on the harness page); tacit.js (through /trade/btc.js) is a stand-in that holds a key, a pool and a few balances and
// records what the lane asks of it, so nothing here reaches Bitcoin or Ethereum. The stand-in's quote is the pool's constant-product formula.
//   checks: the switch and its address; the pool and a quote before any key is open; the price warning and the acknowledgement it asks for; opening the key;
//   balances; the bridged note's move (asked first, then made); the swap (its floor, the exact amount, what it says while it settles and after);
//   flipping the pair; going back to the wallet lane; a link to #bitcoin; a phone width.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/swap-bitcoin-lane.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
// /swap/ is the swap card's test harness (tests/swap-harness/, made from the retired /swap/ page); everything else is dapp/
const SH = new URL('./swap-harness/', import.meta.url).pathname;
const HARNESS = { '/swap/': join(SH, 'index.html'), '/swap/index.html': join(SH, 'index.html'), '/swap/app.js': join(SH, 'app.js') };
const TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = HARNESS[p] || join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// The stand-in for /trade/btc.js: the lane's only door to tacit.js.
const STUB = `
const TETH = '${TETH}', TAC = '${TAC}';
const W = window.__stub = { calls: [], unlocked: false, outcome: 'waiting', sats: 60000, need: 4000, bridged: true, bal: { [TETH]: 5000000n, [TAC]: 0n }, fail: {} };
const rec = (name, args) => W.calls.push({ name, args });
const pool = { pool_id: 'aa'.repeat(32), asset_a: TETH, asset_b: TAC, reserve_a: '20000', reserve_b: '182704255', fee_bps: 30, validation: 'xcurve-verified' };
const T = {
  wallet: { address: () => 'bc1qtestaddress0000000000000000000000000' },
  bitcoinSwapPools: async () => [pool],
  bitcoinSwapFundsNeeded: async () => W.need,
  bitcoinSwapQuote: async ({ fromAid, toAid, amountIn, slipBps = 100 }) => {
    const din = BigInt(amountIn), dir = fromAid === pool.asset_a ? 0 : 1, ra = BigInt(pool.reserve_a), rb = BigInt(pool.reserve_b), g = 9970n;
    const out = dir === 0 ? (rb * g * din) / (ra * 10000n + g * din) : (ra * g * din) / (rb * 10000n + g * din);
    return { kind: 'direct', poolId: pool.pool_id, direction: dir, feeBps: 30, reserveA: ra, reserveB: rb, deltaOut: out, minOut: (out * (10000n - BigInt(slipBps))) / 10000n, pending: W.pending || 0 };
  },
  getUtxos: async () => [{ txid: 'ee'.repeat(32), vout: 0, value: W.sats }],
  scanHoldings: async () => new Map([[TETH, { balance: W.bal[TETH], utxos: [] }], [TAC, { balance: W.bal[TAC], utxos: [] }]]),
  bridgedAtTaproot: async () => ({ count: W.bridged ? 1 : 0, address: 'bc1ptest' }),
  bridgedNotes: async (aid) => ({ notes: W.bridged && aid === TETH ? [{ txid: 'bb'.repeat(32), vout: 0, sats: 546, amount: 10000000n, confirmed: !W.unconfirmed, openErr: null }] : [], unread: 0 }),
  swapReceiptNotes: async () => W.receipts || [],
  getFeeRate: async () => W.feeRate,
  moveBridgedNote: async (o) => { rec('move', { txid: o.txid, assetIdHex: o.assetIdHex, vout: o.vout, swap: o.swap }); W.receipts = []; o.onProgress?.('commit-start'); o.onProgress?.('reveal-start'); if (W.fail.move) throw new Error(W.fail.move); W.bridged = false; return { reveal_txid: 'dd'.repeat(32) }; },
  bitcoinSwap: async (o) => { rec('swap', { fromAid: o.fromAid, toAid: o.toAid, amountIn: String(o.amountIn), minOut: String(o.minOut) }); for (const s of ['check', 'prepare', 'send']) { o.onProgress?.(s); await new Promise((r) => setTimeout(r, 30)); } if (W.fail.swap) throw new Error(W.fail.swap); return { revealTxid: 'cc'.repeat(32), quoted: 1n, floor: o.minOut }; },
  bitcoinSwapOutcome: async () => (W.outcome === 'filled' ? { state: 'filled', got: 16500000n } : W.outcome === 'refunded' ? { state: 'refunded', reason: 'floor miss', refund: 2000n } : { state: 'waiting' }),
};
const session = { key: null, get unlocked() { return W.unlocked; }, load: async () => T };
export function makeBitcoin({ onChange }) {
  return { session, signIn: async () => { W.unlocked = true; session.key = { pubHex: '02' + 'ab'.repeat(32) }; rec('signIn', {}); onChange?.(); }, fund: () => rec('fund', {}) };
}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
let MEMPOOL_STATUS = { confirmed: false };   // what the explorer says of a sent swap (null: it has never seen it); the tests move it

async function fresh(path = '/swap/', viewport = { width: 1100, height: 1000 }, seed = null) {
  const page = await b.newPage({ viewport });
  if (seed) await page.addInitScript((kv) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } }, seed);
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 160)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request();
    if (/publicnode|drpc|1rpc|tenderly|mevblocker|blastapi/.test(req.url())) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }
      const err = (id) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'offline in this test' } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map((x) => err(x.id)) : err(body.id)) });
    }
    return route.abort();
  });
  await page.route(/^https:\/\/mempool\.space\/api\/tx\/[0-9a-f]{64}$/, (route) => route.fulfill({ status: MEMPOOL_STATUS ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(MEMPOOL_STATUS ? { status: MEMPOOL_STATUS } : { error: 'not found' }) }));
  await page.route(/\/trade\/btc\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sw');
  return { page, errs, csp };
}
const text = async (page, sel) => (await page.textContent(sel).catch(() => '') || '').replace(/\s+/g, ' ').trim();
const visible = (page, sel) => page.isVisible(sel);
const calls = (page, name) => page.evaluate((nm) => window.__stub.calls.filter((c) => c.name === nm).map((c) => c.args), name);
const laneReady = (page) => page.waitForFunction(() => document.querySelector('#b-go') && document.querySelector('#b-go').textContent !== 'Loading…' && !/Loading/.test(document.querySelector('#b-q')?.textContent || ''), null, { timeout: 15000 });
const type = async (page, v) => { await page.fill('#b-amt', v); await page.waitForFunction(() => !document.querySelector('#b-out').classList.contains('ph'), null, { timeout: 8000 }); };

console.log('the switch');
{
  const { page, errs, csp } = await fresh();
  const radios = await page.$$eval('.mode [role=radio]', (els) => els.map((e) => [e.dataset.mode, e.getAttribute('aria-checked')]));
  ok(radios.length === 2 && radios[1][0] === 'bitcoin' && radios[0][1] === 'true', `a Bitcoin switch sits after To your wallet (Private is each side's own switch since 5f915905) (${JSON.stringify(radios)})`);
  ok(await page.getAttribute('[data-mode=bitcoin]', 'aria-label') === 'On Bitcoin', 'it is named "On Bitcoin" for a screen reader');
  ok(!(await visible(page, '#btc')) && await visible(page, '#f-pay'), 'the wallet card is shown and the lane is not');
  await page.click('[data-mode=bitcoin]');
  await laneReady(page);
  ok(page.url().endsWith('/swap/#bitcoin'), `the address says #bitcoin (${page.url()})`);
  ok(await visible(page, '#btc') && !(await visible(page, '#f-pay')) && !(await visible(page, '#go')), 'the lane replaces the wallet card');
  ok(await page.getAttribute('[data-mode=bitcoin]', 'aria-checked') === 'true' && await page.getAttribute('[data-mode=wallet]', 'aria-checked') === 'false', 'the switch shows Bitcoin');
  ok(/Open your Tacit wallet/.test(await text(page, '#b-go')), 'with no key open the button asks to open it');
  ok(/0\.0002 tETH · 1\.82704255 TAC/.test(await text(page, '#b-rcpt')) && /0\.30%/.test(await text(page, '#b-rcpt')), 'the pool and its fee are shown before any key is open');
  await page.click('[data-mode=wallet]');
  ok(await visible(page, '#f-pay') && !(await visible(page, '#btc')) && !page.url().includes('#bitcoin'), 'back to To your wallet: the wallet card returns and the address is clean');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('a quote, a price warning, the key, the balances');
{
  const { page, errs, csp } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  ok(await visible(page, '#btc') && !(await visible(page, '#f-pay')), 'a link to #bitcoin opens the lane');
  await type(page, '0.00002');
  ok(await text(page, '#b-out') === '0.16564166', `0.00002 tETH quotes 0.16564166 TAC from the pool's formula (${await text(page, '#b-out')})`);
  const r = await text(page, '#b-rcpt');
  ok(/1 tETH ≈ 8282/.test(r) && /At least\s*0\.16398524 TAC/.test(r), `the price and the floor (1% under) are shown (${r.slice(0, 160)})`);
  ok(/Price impact\s*9\.3%/.test(r) && await page.$eval('#b-rcpt dd.warn', (e) => !!e).catch(() => false), 'the price impact is stated and marked as a warning');
  ok(!(await visible(page, '#b-ack')), 'under 10% worse it asks for no acknowledgement');
  ok(/Open your Tacit wallet/.test(await text(page, '#b-go')) && !(await page.$eval('#b-go', (e) => e.disabled)), 'the button still asks for the key');
  await page.click('#b-go');
  await page.waitForFunction(() => window.__stub.unlocked && /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  ok(true, 'opening the key reads the balance: Balance 0.05 tETH');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/lane-quote.png` });
  ok(/^Swap$/.test(await text(page, '#b-go')) && !(await page.$eval('#b-go', (e) => e.disabled)), 'the button now says Swap');
  await type(page, '0.001');
  ok(/83%/.test(await text(page, '#b-rcpt')) && await visible(page, '#b-ack') && await page.$eval('#b-go', (e) => e.disabled), 'a swap 83% under the pool’s price asks to be accepted, and waits for it');
  await page.check('#b-ackbox');
  ok(!(await page.$eval('#b-go', (e) => e.disabled)), 'accepting enables the swap');
  // the lane reads the pool again every 45 s and re-quotes: the same quote keeps the box ticked and the button ready
  await page.waitForTimeout(47000);
  ok((await page.$eval('#b-ackbox', (e) => e.checked)) && !(await page.$eval('#b-go', (e) => e.disabled)), 'the acceptance stands through the lane\'s own refresh when the quote is unchanged');
  await type(page, '0.002');
  await page.waitForFunction(() => !document.querySelector('#b-out').classList.contains('ph'), null, { timeout: 8000 });
  ok(!(await page.$eval('#b-ackbox', (e) => e.checked)) && (await page.$eval('#b-go', (e) => e.disabled)), 'a new amount asks again');
  await type(page, '0.001');
  await page.waitForFunction(() => !document.querySelector('#b-out').classList.contains('ph'), null, { timeout: 8000 });
  await page.check('#b-ackbox');
  await type(page, '0.5');
  ok(/Move your bridged tETH first/.test(await text(page, '#b-go')) && !(await page.$eval('#b-go', (e) => e.disabled)), 'more than the trading address holds, with a bridged note waiting, leads to the move and not to a dead end (TAC the key does not hold is still refused, below)');
  await page.click('[data-quick="0.0125"]');
  await page.waitForFunction(() => !document.querySelector('#b-out').classList.contains('ph'), null, { timeout: 8000 });
  ok(await page.inputValue('#b-amt') === '0.0125', 'a quick amount fills the box (25% of the balance) and quotes');
  await page.click('#b-slip [data-slip="300"]');
  await page.waitForFunction(() => document.querySelector('#b-slip [data-slip="300"]').getAttribute('aria-pressed') === 'true', null, { timeout: 4000 });
  ok(/At least/.test(await text(page, '#b-rcpt')), 'a wider slippage is kept and the quote is read again');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('the bridged note');
{
  const { page } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => document.querySelector('#b-brd') && !document.querySelector('#b-brd').hidden, null, { timeout: 8000 });
  const t = await text(page, '#b-brd');
  ok(/0\.1 tETH you bridged sits at your Taproot address, which a swap does not spend from/.test(t), `the note is named (${t})`);
  await page.click('[data-move]');
  const ask = await text(page, '#b-brd');
  ok(/Move 0\.1 tETH to your trading address\? One Bitcoin transaction, about 5,000 sats/.test(ask) && (await calls(page, 'move')).length === 0, 'it asks first, naming the fee, and moves nothing');
  await page.click('[data-move-no]');
  ok(!/Move 0\.1 tETH to your trading address\?/.test(await text(page, '#b-brd')) && (await calls(page, 'move')).length === 0, 'Cancel leaves it as it was');
  await page.evaluate(() => { window.__stub.feeRate = 1; });
  await page.click('[data-move]');
  await page.waitForFunction(() => /about 2,000 sats in fees/.test(document.querySelector('#b-brd').textContent), null, { timeout: 8000 });
  ok(!/5,000/.test(await text(page, '#b-brd')), 'at 1 sat/vB the ask names about 2,000 sats, the commit and reveal at that rate, not a flat 5,000');
  await page.click('[data-move-no]');
  await page.evaluate(() => { window.__stub.feeRate = undefined; });
  await page.click('[data-move]'); await page.click('[data-move-yes]');
  await page.waitForFunction(() => /Moved 0\.1 tETH/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  const mv = await calls(page, 'move');
  ok(mv.length === 1 && mv[0].txid === 'bb'.repeat(32) && mv[0].assetIdHex === TETH, 'the move is asked for that note, as tETH');
  ok(/next Bitcoin block/.test(await text(page, '#b-q')) && await page.$eval('#b-q', (e) => e.classList.contains('ok')), 'it says it confirms with the next block');
  await page.close();
}
{
  const { page } = await fresh('/swap/#bitcoin');
  await page.evaluate(() => { window.__stub.sats = 1000; });
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => document.querySelector('#b-brd') && !document.querySelector('#b-brd').hidden, null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#b-bal').textContent.includes('Balance'), null, { timeout: 8000 });
  await page.click('[data-move]'); await page.click('[data-move-yes]');
  await page.waitForTimeout(300);
  ok((await calls(page, 'move')).length === 0 && /Add sats, then try again/.test(await text(page, '#b-q')) && (await calls(page, 'fund')).length === 1, 'with too few sats the move is not made, and the fund dialog opens');
  await page.close();
}

console.log('the nudge to move a bridged note');
{
  const PUB_A = '02' + 'cd'.repeat(32), PUB_STUB = '02' + 'ab'.repeat(32);
  const held = (extra = {}, pub = PUB_A) => ({ 'tacit-bridged-v1': JSON.stringify({ [pub]: extra }) });
  const dot = (page) => page.$eval('[data-mode=bitcoin]', (e) => ({ on: e.hasAttribute('data-nudge'), title: e.title, label: e.getAttribute('aria-label') }));
  let r = await fresh('/swap/', undefined, held({ teth: { v: '10000000', n: 1, ready: 1, at: Date.now() } }));
  let d = await dot(r.page);
  ok(d.on && /bridged tETH waits there to be moved/.test(d.title) && d.title === d.label, `a key that last read tETH bridged to its Taproot address puts a dot on the Bitcoin switch, and says why (${d.title})`);
  ok(await r.page.$eval('[data-mode=bitcoin]', (e) => getComputedStyle(e, '::after').content !== 'none'), 'the dot is drawn');
  await r.page.click('[data-mode=bitcoin]'); await laneReady(r.page);
  ok(!(await dot(r.page)).on && (await dot(r.page)).title === 'On Bitcoin', 'with the lane open the dot goes: the lane has the move');
  await r.page.click('[data-mode=wallet]');
  ok((await dot(r.page)).on, 'back on the wallet lane it returns while the note is still there');
  ok(r.errs.length === 0 && r.csp.length === 0, `no page errors or CSP violations (${r.errs.concat(r.csp).join(' | ')})`);
  await r.page.close();

  r = await fresh('/swap/', undefined, held({ tac: { v: '500000000', n: 2, ready: 2, at: Date.now() } }));
  ok(/bridged TAC waits/.test((await dot(r.page)).title), 'bridged TAC is named the same way');
  await r.page.close();
  for (const [what, seed] of [['a note count of zero', held({ teth: { v: '0', n: 0, ready: 0, at: Date.now() } })], ['nothing kept', {}], ['a damaged record', { 'tacit-bridged-v1': '{not json' }], ['a sum that is not a number', held({ teth: { v: 'lots', n: 1 } })]]) {
    r = await fresh('/swap/', undefined, seed);
    const x = await dot(r.page);
    ok(!x.on && x.title === 'On Bitcoin' && r.errs.length === 0, `${what} puts no dot on the switch`);
    await r.page.close();
  }

  // The lane: nothing to pay with at the trading address and the tETH bridged: the button leads to the move, which is asked first.
  r = await fresh('/swap/#bitcoin', undefined, held({ teth: { v: '10000000', n: 1, ready: 1, at: Date.now() } }, PUB_STUB));
  await laneReady(r.page);
  await r.page.evaluate((t) => { window.__stub.bal[t] = 0n; }, TETH);
  await r.page.click('#b-go');
  await r.page.waitForFunction(() => /Balance 0 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await r.page.waitForFunction(() => /Move your bridged tETH first/.test(document.querySelector('#b-go').textContent), null, { timeout: 8000 });
  ok(!(await r.page.$eval('#b-go', (e) => e.disabled)), 'with 0 tETH at the trading address and a bridged note, the button reads "Move your bridged tETH first" and is live');
  const kept = await r.page.evaluate((pub) => JSON.parse(localStorage.getItem('tacit-bridged-v1'))[pub]?.teth, PUB_STUB);
  ok(kept && kept.n === 1 && kept.v === '10000000' && kept.ready === 1, `reading the Taproot address keeps a count and a sum for the key, no note (${JSON.stringify(kept)})`);
  ok(!JSON.stringify(await r.page.evaluate(() => localStorage.getItem('tacit-bridged-v1'))).includes('bbbbbbbb'), 'and no transaction id');
  await r.page.click('#b-go');
  ok(/Move 0\.1 tETH to your trading address\? One Bitcoin transaction, about 5,000 sats/.test(await text(r.page, '#b-brd')) && (await calls(r.page, 'move')).length === 0, 'pressing it asks first, naming the fee, and moves nothing');
  await r.page.click('[data-move-no]');
  ok((await calls(r.page, 'move')).length === 0 && /Move your bridged tETH first/.test(await text(r.page, '#b-go')), 'Cancel leaves the button as it was');
  await r.page.click('#b-go'); await r.page.click('[data-move-yes]');
  await r.page.waitForFunction(() => /Moved 0\.1 tETH/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  const mv = await calls(r.page, 'move');
  ok(mv.length === 1 && mv[0].txid === 'bb'.repeat(32) && mv[0].assetIdHex === TETH, 'confirming moves that note, as tETH');
  const after = await r.page.evaluate((pub) => JSON.parse(localStorage.getItem('tacit-bridged-v1'))[pub]?.teth, PUB_STUB);
  ok(after && after.n === 0 && after.v === '0', `the moment it is moved the kept count is zero (${JSON.stringify(after)})`);
  ok(!/Move your bridged/.test(await text(r.page, '#b-go')), 'and the button no longer asks for it');
  await r.page.click('[data-mode=wallet]');
  ok(!(await dot(r.page)).on, 'back on the wallet lane the Bitcoin switch has no dot: nothing is left to move');
  await r.page.close();

  // With tETH at the trading address the lane is as before, however much is bridged.
  r = await fresh('/swap/#bitcoin', undefined, held({ teth: { v: '10000000', n: 1, ready: 1, at: Date.now() } }));
  await laneReady(r.page);
  await r.page.click('#b-go');
  await r.page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  ok(/^Enter an amount$/.test(await text(r.page, '#b-go')), 'holding tETH to pay with, the button is the ordinary one');
  await type(r.page, '0.00002');
  ok(/^Swap$/.test(await text(r.page, '#b-go')), 'and it swaps');
  await r.page.fill('#b-amt', '0.5');
  await r.page.waitForFunction(() => /Move your bridged tETH first/.test(document.querySelector('#b-go').textContent), null, { timeout: 8000 });
  ok(true, 'asking for more than the trading address holds, with a bridged note waiting, leads to the move');
  await r.page.close();

  // A bridged note that is not ready (waiting for its block) is no call to move yet: it is listed, with what it waits for.
  r = await fresh('/swap/#bitcoin', undefined, held({ teth: { v: '10000000', n: 1, ready: 0, at: Date.now() } }, PUB_STUB));
  await laneReady(r.page);
  await r.page.evaluate((t) => { window.__stub.bal[t] = 0n; window.__stub.unconfirmed = true; }, TETH);
  await r.page.click('#b-go');
  await r.page.waitForFunction(() => /Balance 0 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await r.page.waitForFunction(() => /Waiting for its Bitcoin confirmation/.test(document.querySelector('#b-brd').textContent), null, { timeout: 8000 });
  ok(/^Enter an amount$/.test(await text(r.page, '#b-go')) && !/Move your bridged/.test(await text(r.page, '#b-go')), 'a note still waiting for its block does not turn the button into a move');
  ok(/Waiting for its Bitcoin confirmation/.test(await text(r.page, '#b-brd')) && !(await r.page.$('[data-move]')), 'it is listed with what it waits for, and offers no move yet');
  await r.page.close();
}

console.log('a swap\'s receipt at the Taproot address');
{
  // The TAC a swap bought sits at the key's Taproot address, which the balance (the trading address) does not count: the lane lists it, and the move brings it here.
  const { page } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.evaluate(([txid, tac]) => { window.__stub.receipts = [{ txid, vout: 1, sats: 546, amount: 101366801n, assetIdHex: tac, confirmed: true, source: 'swap' }]; }, ['ee'.repeat(32), TAC]);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await page.click('#b-flip');
  await page.waitForFunction(() => /from your swap sits at your Taproot address/.test(document.querySelector('#b-brd').textContent), null, { timeout: 8000 });
  ok(/1\.01366801 TAC from your swap sits at your Taproot address, which a swap does not spend from/.test(await text(page, '#b-brd')), 'the TAC a swap bought is listed, as from the swap and not as bridged');
  ok(/Balance 0 TAC/.test(await text(page, '#b-bal')) && /^Move your TAC first$/.test(await text(page, '#b-go')), 'paying TAC, the balance is still the trading address\'s, and the button leads to the move');
  await page.click('#b-go'); await page.click('[data-move-yes]');
  await page.waitForFunction(() => /Moved 1\.01366801 TAC/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  const mv = (await calls(page, 'move'))[0];
  ok(mv && mv.txid === 'ee'.repeat(32) && mv.vout === 1 && mv.swap === true && mv.assetIdHex === TAC, `the move is of output 1, as a swap's receipt (${JSON.stringify(mv)})`);
  await page.close();
}

console.log('the swap');
{
  const { page, errs, csp } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await page.click('#b-go');
  await page.waitForFunction(() => /Waiting for a Bitcoin block/.test(document.querySelector('#b-sent').textContent), null, { timeout: 8000 });
  const sw = await calls(page, 'swap');
  ok(sw.length === 1 && sw[0].fromAid === TETH && sw[0].toAid === TAC && sw[0].amountIn === '2000' && sw[0].minOut === '16398524', `the swap is asked for the exact amount with the floor shown (${JSON.stringify(sw[0])})`);
  const sent = await text(page, '#b-sent');
  ok(/Waiting for a Bitcoin block/.test(sent) && /0\.00002 tETH → about 0\.16564166 TAC/.test(sent), `while it waits it says what is expected (${sent})`);
  ok(/At least 0\.16398524 TAC, or your tETH comes back/.test(sent) && /Sent just now/.test(sent) && sent.includes('cccccccccc'), 'with the floor, that a miss returns the tETH, and how long ago it was sent');
  ok((await page.getAttribute('#b-sent a', 'href')) === `https://mempool.space/tx/${'cc'.repeat(32)}`, 'it links the transaction');
  ok(await page.inputValue('#b-amt') === '' && (await text(page, '#b-q')) === '', 'the amount is cleared, and no progress line is left behind');
  ok(!(await page.$('#b-sent [data-dismiss]')), 'a swap still waiting cannot be dismissed');
  // the explorer sees it in a block: the swap says so, still unsettled
  MEMPOOL_STATUS = { confirmed: true, block_height: 800123 };
  await page.waitForFunction(() => /In block 800123/.test(document.querySelector('#b-sent').textContent), null, { timeout: 40000 });
  ok(/The pool settles it/.test(await text(page, '#b-sent')), 'once it is in a block it says the pool settles it');
  await page.evaluate(() => { window.__stub.outcome = 'filled'; });
  await page.waitForFunction(() => /Filled/.test(document.querySelector('#b-sent').textContent), null, { timeout: 40000 });
  ok(/Filled.*0\.00002 tETH → 0\.165 TAC/.test(await text(page, '#b-sent')) && await page.$eval('#b-sent > div', (e) => e.classList.contains('ok')), 'when the pool takes it, it says what was got');
  // a refund: a second row above the first
  await type(page, '0.00002');
  await page.evaluate(() => { window.__stub.outcome = 'refunded'; });
  await page.click('#b-go');
  await page.waitForFunction(() => /Returned/.test(document.querySelector('#b-sent > div').textContent), null, { timeout: 40000 });
  ok(/Returned.*0\.00002 tETH back/.test(await text(page, '#b-sent > div')) && /The pool had moved past your floor/.test(await text(page, '#b-sent > div')) && await page.$eval('#b-sent > div', (e) => e.classList.contains('warn')), 'a swap the pool moved past says the tETH came back');
  ok((await page.$$('#b-sent > div')).length === 2, 'and the filled one is kept below it');
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('tacit-swap-btc-sent-v1')).map((x) => x.state));
  ok(kept.join() === 'refunded,filled', `both are kept for the next visit (${kept})`);
  await page.click('#b-sent > div:first-child [data-dismiss]');
  ok((await page.$$('#b-sent > div')).length === 1 && (await page.evaluate(() => JSON.parse(localStorage.getItem('tacit-swap-btc-sent-v1')).length)) === 1, 'a settled swap can be dismissed, and stays dismissed');
  // a failure
  await page.evaluate(() => { window.__stub.fail.swap = 'the pool moved past your floor: quote it again'; });
  await type(page, '0.00001');
  await page.click('#b-go');
  await page.waitForFunction(() => /quote it again/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  ok(await page.$eval('#b-q', (e) => e.classList.contains('err')) && !(await page.$eval('#b-go', (e) => /Swapping/.test(e.textContent))), 'a swap that fails says why and frees the button');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('a swap sent before a reload');
{
  MEMPOOL_STATUS = { confirmed: false };
  const entry = { txid: 'dd'.repeat(32), from: TETH, to: TAC, din: '2000', quoted: '16564166', floor: '16398524', at: Date.now() - 4 * 60e3, state: 'waiting', block: null };
  const r = await fresh('/swap/#bitcoin', undefined, { 'tacit-swap-btc-sent-v1': JSON.stringify([entry]) });
  await laneReady(r.page);
  await r.page.waitForFunction(() => /Waiting for a Bitcoin block/.test(document.querySelector('#b-sent').textContent), null, { timeout: 8000 });
  ok(/Sent 4 min ago/.test(await text(r.page, '#b-sent')) && (await calls(r.page, 'swap')).length === 0, 'a swap sent before the page was reloaded is still shown, with its age, and nothing is sent again');
  await r.page.evaluate(() => { window.__stub.outcome = 'filled'; });
  await r.page.waitForFunction(() => /Filled/.test(document.querySelector('#b-sent').textContent), null, { timeout: 15000 });
  ok(/Filled.*0\.00002 tETH → 0\.165 TAC/.test(await text(r.page, '#b-sent')), 'and it is followed to the end: it was filled');
  await r.page.close();
  // the explorer does not know it, and it was sent long enough ago for that to mean something: it says so, and that nothing was spent if it was dropped
  MEMPOOL_STATUS = null;
  const lost = await fresh('/swap/#bitcoin', undefined, { 'tacit-swap-btc-sent-v1': JSON.stringify([{ ...entry, at: Date.now() - 30 * 60e3 }]) });
  await laneReady(lost.page);
  await lost.page.waitForFunction(() => /Not showing on mempool\.space/.test(document.querySelector('#b-sent').textContent), null, { timeout: 8000 });
  ok(/If it was dropped, nothing was spent/.test(await text(lost.page, '#b-sent')) && !!(await lost.page.$('#b-sent [data-dismiss]')), 'a swap the explorer has never seen says so, that a dropped one spent nothing, and can be dismissed');
  await lost.page.close();
  MEMPOOL_STATUS = { confirmed: false };
  const bad = await fresh('/swap/#bitcoin', undefined, { 'tacit-swap-btc-sent-v1': JSON.stringify([{ ...entry, txid: 'zz', din: 'x' }, { ...entry, at: Date.now() - 3 * 864e5 }]) });
  await laneReady(bad.page);
  ok(await bad.page.isHidden('#b-sent'), 'a damaged or day-old record is ignored');
  await bad.page.close();
}

console.log('the other direction, and sats');
{
  const { page } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await page.click('#b-flip');
  ok(/TAC/.test(await text(page, '#b-pay-coin')) && /tETH/.test(await text(page, '#b-get-coin')) && await page.inputValue('#b-amt') === '', 'flipping swaps the two sides and clears the amount');
  ok(/Balance 0 TAC/.test(await text(page, '#b-bal')), 'the balance follows the pay side');
  await type(page, '1');
  ok(/Not enough TAC on Bitcoin/.test(await text(page, '#b-go')), 'TAC the key does not hold is refused');
  await page.close();
}
{
  const { page } = await fresh('/swap/#bitcoin');
  await page.evaluate(() => { window.__stub.sats = 1000; });
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await page.waitForFunction(() => /Add sats for the Bitcoin fees/.test(document.querySelector('#b-go').textContent), null, { timeout: 8000 });
  ok(true, 'with fewer sats than the fees need, the button asks for sats');
  await page.click('#b-go');
  ok((await calls(page, 'fund')).length === 1 && (await calls(page, 'swap')).length === 0, 'pressing it opens the fund dialog and sends nothing');
  await page.close();
}

console.log('a phone');
{
  const { page, errs, csp } = await fresh('/swap/#bitcoin', { width: 360, height: 800 });
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await sleep(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `the lane has no sideways scroll at 360 px (${over})`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/lane-phone.png`, fullPage: true });
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

await b.close(); server.close();
console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
