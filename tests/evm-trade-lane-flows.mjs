#!/usr/bin/env node
// dapp/evm-trade-tile.js in a real browser against scripted venues, RPC and wallet: what the
// quote and the review dialog promise is what is sent — the reviewed floor rides as minOut, a
// price that falls below it asks first, a wallet rejection sends nothing, and the venues
// panel ranks what the quote ranked.
//   PLAYWRIGHT=<path to playwright-core> node tests/evm-trade-lane-flows.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;

function extractRootBlocks(css) {
  let out = '', idx = 0;
  while ((idx = css.indexOf(':root', idx)) !== -1) {
    const open = css.indexOf('{', idx);
    if (open === -1) break;
    let depth = 1, i = open + 1;
    while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    out += css.slice(idx, i) + '\n';
    idx = i;
  }
  return out;
}
// The real market-page CSS (Bitcoin lane + the Ethereum lane's additions), real :root tokens.
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><style>${
  (() => { const h = readFileSync(join(DAPP, 'classic.html'), 'utf8'); const i = h.indexOf('/* ── Market page (btc-market.js)'); const j = h.indexOf('/* ── Shielded Send composer'); return extractRootBlocks(h) + 'body{font-family:monospace;background:#e8e0cc}' + h.slice(i, j); })()
}</style></head><body><section class="bm"><div class="bm-lane" data-lane="eth"><div id="host"></div></div></section>
<script type="module">
import { mountEvmTradeLane } from '/evm-trade-tile.js';
window.__mount = mountEvmTradeLane;
window.__ready = true;
</script></body></html>`;

const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png' };
const srv = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/__harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS); }
  const f = normalize(join(DAPP, p));
  if (!f.startsWith(DAPP) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;

// Installed into the page: scripted venues (a spot rate and a per-venue haircut), RPC and wallet.
const SETUP = () => {
  const E = 10n ** 18n;
  const W = window.__w = {
    calls: [], addr: null, connectFails: null, sendFails: null, receiptStatus: '0x1',
    ethBal: 2n * E, tacBal: 50_000n * E, allowance: 0n, gasPrice: 20n * 10n ** 9n,
    // TAC per ETH at spot; each venue pays this minus a haircut that grows with size.
    spotTacPerEth: 17_700n, haircutBps: { precision: 30n, 'tacit-amm': 60n }, impactPerEth: 50n, restingOrders: 0,
    freshDrift: 0n, // bps the re-quote falls by
    receipts: {},
  };
  const rec = (name, args) => { W.calls.push({ name, args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) }); };
  const outFor = (venue, dir, amountIn, driftBps = 0n) => {
    const haircut = W.haircutBps[venue];
    if (haircut == null) return null;
    const ethIn = dir === 'ETH_TO_TAC' ? amountIn : (amountIn / W.spotTacPerEth);
    const impact = (ethIn * W.impactPerEth) / E; // bps
    const bps = 10000n - haircut - impact - driftBps;
    const out = dir === 'ETH_TO_TAC' ? (amountIn * W.spotTacPerEth * bps) / 10000n : (amountIn * bps) / (W.spotTacPerEth * 10000n);
    // Precision's lens reports its fee in millionths, the AMM in basis points — as live
    return { venue, amountIn, amountOut: out, feeBps: venue === 'precision' ? haircut * 100n : haircut, tokenIn: '0x0', tokenOut: '0x1' };
  };
  const quoteAll = async ({ dir, amountIn, account }) => {
    if (W.quoteDelay) await new Promise((r) => setTimeout(r, W.quoteDelay));
    rec('quoteAll', { dir, amountIn, account, fresh: W.calls.some((c) => c.name === 'build') });
    const drift = W.calls.some((c) => c.name === 'build') ? W.freshDrift : 0n;
    const flipped = W.flipVenueAfterBuild && W.calls.some((c) => c.name === 'build');
    const ranked = ['precision', 'tacit-amm'].map((v) => outFor(v, dir, amountIn, drift)).filter(Boolean).sort((a, b) => (flipped ? (a.venue === 'tacit-amm' ? -1 : 1) : (a.amountOut > b.amountOut ? -1 : 1)));
    return { dir, amountIn, ranked, best: ranked[0] || null, precision: ranked.find((r) => r.venue === 'precision') || null, tacitAmm: ranked.find((r) => r.venue === 'tacit-amm') || null, boards: { restingOrders: W.restingOrders }, zquoter: null };
  };
  W.venues = {
    quoteAll,
    quotePrecision: async ({ dir, amountIn }) => { rec('quotePrecision', { dir, amountIn }); return outFor('precision', dir, amountIn); },
    quoteTacitAmm: async ({ dir, amountIn }) => outFor('tacit-amm', dir, amountIn),
    quoteZQuoter: async () => { rec('quoteZQuoter', {}); if (W.zq) return W.zq; throw new Error('NoRoute'); },
    build: ({ quote, dir, account, slippageBps, minOut }) => {
      rec('build', { venue: quote.venue, dir, account, slippageBps, minOut, amountOut: quote.amountOut });
      const ethIn = dir === 'ETH_TO_TAC';
      return { to: '0x' + 'ab'.repeat(20), data: '0x' + (ethIn ? '01' : '02') + quote.amountOut.toString(16).padStart(64, '0'), value: ethIn ? quote.amountIn : 0n, approval: ethIn ? null : { token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', spender: '0x' + (quote.venue === 'tacit-amm' ? 'ef' : 'cd').repeat(20), amount: quote.amountIn } };
    },
  };
  W.rpc = {
    call: async (to, data, block, o) => {
      rec('call', { to, sel: String(data).slice(0, 10), from: o?.from || null, value: o?.value || null });
      if (String(data).startsWith('0x70a08231')) return '0x' + W.tacBal.toString(16).padStart(64, '0');
      if (String(data).startsWith('0xdd62ed3e')) return '0x' + W.allowance.toString(16).padStart(64, '0');
      if (W.simFails) throw Object.assign(new Error(W.simFails), { data: W.simData || null });
      return '0x';
    },
    getBalance: async () => W.ethBal,
    gasPrice: async () => W.gasPrice,
    receipt: async (hash) => (W.pending ? null : (W.receipts[hash] || { status: W.receiptStatus, logs: W.logs || [] })),
  };
  W.wallet = {
    address: () => W.addr,
    connect: async () => { rec('connect', {}); if (W.connectFails) throw new Error(W.connectFails); W.addr = '0x' + '11'.repeat(20); },
    sendTx: async (tx) => { rec('sendTx', tx); if (W.sendFails) throw W.sendFails; const h = '0x' + (W.calls.length).toString(16).padStart(64, '0'); return h; },
    market: { markUnit: () => W.markUnit ?? 250, btcUsd: () => 100_000, iconHtml: () => '<b>T</b>' },
    txUrl: (h) => 'https://etherscan.io/tx/' + h,
    venues: W.venues, rpc: W.rpc, ethUsd: () => 4000,
  };
};

let passed = 0;
const b = await chromium.launch();
async function fresh() {
  const page = await b.newPage({ viewport: { width: Number(process.env.W || 1100), height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/__harness.html`);
  await page.waitForFunction(() => window.__ready);
  await page.evaluate(SETUP);
  page.errs = errs;
  return page;
}
const mount = (page) => page.evaluate(() => { window.__ctl = window.__mount(document.getElementById('host'), window.__w.wallet); });
const settle = (page, ms = 150) => page.waitForTimeout(ms);
const calls = (page, name) => page.evaluate((n) => window.__w.calls.filter((c) => !n || c.name === n), name);
const shot = async (page, n) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${n}.png`, fullPage: true }); };
async function waitModal(page, re, timeout = 8000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.bm-modal')?.textContent || ''), re.source, { timeout });
  return page.textContent('.bm-modal');
}
async function typeAmount(page, v) { await page.fill('[data-k=eamount]', v); await page.waitForTimeout(450); }

async function test(name, fn) {
  const page = await fresh();
  try {
    await fn(page);
    assert.deepEqual(page.errs, [], 'no page errors');
    passed++; console.log(`  ok   ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
    await shot(page, 'fail-' + name.replace(/\W+/g, '-').slice(0, 40));
  } finally { await page.close(); }
}

await test('spot price and venues show before any amount; a quote names what you get, the floor, the price, its impact and the route', async (page) => {
  await mount(page); await settle(page, 300);
  assert.match(await page.textContent('[data-k=espot]'), /1 TAC ≈ .* ETH.*1 ETH ≈ 17,6\d\d TAC/s);
  assert.match(await page.textContent('[data-k=evenues]'), /Precision.*1 ETH ≈ 17,6\d\d TAC.*Enter an amount to compare/s);
  assert.equal(await page.textContent('[data-k=ego]'), 'Enter an amount');
  await typeAmount(page, '1');
  const q = await page.textContent('[data-k=equote]');
  assert.match(q, /You get17,5\d\d TAC/);
  assert.match(q, /At least17,4\d\d TAC after 0.5% slippage/);
  assert.match(q, /Price1 TAC = .* ETH .*1 ETH = 17,5\d\d TAC/);
  assert.match(q, /Price impact0\.5\d%/); // 50 bps per ETH on top of the probe's own
  assert.match(q, /RoutePrecision 0.30% fee/);
  assert.match(q, /Network fee≈ 0\.0044 ETH/);
  assert.match(q, /On Bitcoin the last trade was 250 sats per TAC \(\$0\.25\)/);
  const v = await page.textContent('[data-k=evenues]');
  assert.match(v, /bestPrecision17,5\d\d0\.30%Tacit AMM17,5\d\d0\.60%zQuoterno routeOrder boardsno resting orders/s);
  // an aggregator route that pays more takes over when it answers
  await page.evaluate(() => { window.__w.zq = { venue: 'zquoter', status: 'ok', amountIn: 10n ** 18n, amountOut: 18_000n * 10n ** 18n, feeBps: 5n }; });
  await typeAmount(page, '1.0');
  assert.match(await page.textContent('[data-k=equote]'), /You get18,000 TAC.*RoutezQuoter 0\.05% fee/s);
  assert.match(await page.textContent('[data-k=evenues]'), /bestzQuoter18,0000\.05%Precision/s);
  // not connected: the quote shows, the button offers to connect
  assert.equal(await page.textContent('[data-k=ego]'), 'Connect wallet');
  assert.equal(await page.isDisabled('[data-k=ego]'), false);
  await shot(page, 'eth-quote');
});

await test('connect shows the address and balances; chips fill 25/50/Max and Max keeps the network fee back', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  assert.match(await page.textContent('[data-k=ebal]'), /Balance: 2 ETH · 0x1111…1111/);
  const chips = await page.$$eval('[data-k=echips] button', (bs) => bs.map((x) => [x.textContent, x.dataset.v]));
  assert.deepEqual(chips.map((c) => c[0]), ['25%', '50%', 'Max']);
  // reserve = 220k gas × 20 gwei × 1.5 = 0.0066 ETH
  assert.equal(chips[2][1], '1.9934');
  assert.equal(chips[0][1], '0.49835');
  await page.click('[data-act=echip]:nth-child(3)'); await settle(page, 450);
  assert.equal(await page.inputValue('[data-k=eamount]'), '1.9934');
  assert.equal(await page.textContent('[data-k=ego]'), 'Review buy');
  // sell side reads the TAC balance
  await page.click('[data-act=eside][data-v=sell]'); await settle(page, 300);
  assert.match(await page.textContent('[data-k=ebal]'), /Balance: 50,000 TAC/);
  assert.equal(await page.textContent('[data-k=elabel]'), 'You sell');
  assert.equal(await page.inputValue('[data-k=eamount]'), '');
});

await test('more than the balance, or no ETH left for the fee, cannot be reviewed', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await typeAmount(page, '3');
  assert.equal(await page.textContent('[data-k=ego]'), 'Not enough ETH');
  assert.equal(await page.isDisabled('[data-k=ego]'), true);
  await typeAmount(page, '1.999');
  assert.equal(await page.textContent('[data-k=ego]'), 'Not enough ETH for the network fee');
  await page.click('[data-act=eside][data-v=sell]'); await settle(page);
  await typeAmount(page, '60000');
  assert.equal(await page.textContent('[data-k=ego]'), 'Not enough TAC');
});

await test('buy: the review is what is sent — ETH as value, no approval, the reviewed floor as minOut, then the receipt\'s TAC', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await typeAmount(page, '0.5');
  await page.click('[data-k=ego]');
  const m = await waitModal(page, /Buy 8,80\d TAC/);
  assert.match(m, /You pay0\.5 ETH \$2,000\.00/);
  assert.match(m, /At least8,7\d\d TAC or the swap reverts/);
  assert.match(m, /RoutePrecision on Ethereum/);
  assert.match(m, /Confirm in your wallet.*Confirming on Ethereum/s);
  const floor = (await page.textContent('.bm-modal')).match(/At least([\d,]+) TAC/)[1];
  await page.evaluate(() => { const W = window.__w; W.logs = [{ address: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + '11'.repeat(20).padStart(64, '0')], data: '0x' + (8765n * 10n ** 18n).toString(16).padStart(64, '0') }]; });
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Bought 8,765 TAC/);
  const sends = await calls(page, 'sendTx');
  assert.equal(sends.length, 1, 'one transaction, no approval for ETH in');
  assert.equal(sends[0].args.value, '0x' + (5n * 10n ** 17n).toString(16));
  assert.equal(sends[0].args.from, '0x' + '11'.repeat(20));
  const builds = await calls(page, 'build');
  const last = builds[builds.length - 1].args;
  assert.equal(fmt(BigInt(last.minOut)), floor.replace(/,/g, ''), 'the floor shown is the floor built');
  // the simulate call carried the sender and the value
  const sims = (await calls(page, 'call')).filter((c) => c.args.from);
  assert.equal(sims.length, 1); assert.equal(sims[0].args.value, sends[0].args.value);
  assert.match(await page.textContent('.bm-modal'), /View on Etherscan/);
  assert.equal(await page.inputValue('[data-k=eamount]'), '');
  await shot(page, 'eth-bought');
});
function fmt(v) { return Math.round(Number(v) / 1e18).toString(); }

await test('sell: an allowance is granted first when short, then the swap; both are steps the user can follow', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await page.click('[data-act=eside][data-v=sell]'); await settle(page);
  await typeAmount(page, '1000');
  await page.click('[data-k=ego]');
  const m = await waitModal(page, /Sell 1,000 TAC/);
  assert.match(m, /Allow the venue to take your TACskipped if already allowed/);
  assert.match(m, /two transactions the first time/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Sold 1,000 TAC/);
  const sends = await calls(page, 'sendTx');
  assert.equal(sends.length, 2);
  assert.match(sends[0].args.data, /^0x095ea7b3/, 'approve first');
  assert.equal(sends[0].args.to, '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279');
  assert.equal(sends[1].args.value, undefined);
  assert.match(await page.textContent('.bm-modal'), /Allow the venue to take your TAC.*Confirm in your wallet.*Confirming on Ethereum/s);
  // enough allowance already: one transaction
  await page.evaluate(() => { window.__w.allowance = 10n ** 30n; window.__w.calls = []; });
  await page.click('.bm-modal .bm-mfoot .bm-go'); await settle(page);
  await typeAmount(page, '10');
  await page.click('[data-k=ego]'); await waitModal(page, /Sell 10 TAC/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Sold 10 TAC/);
  assert.equal((await calls(page, 'sendTx')).length, 1);
  assert.match(await page.textContent('.bm-modal'), /already allowed/);
});

await test('a re-quote that falls below the reviewed floor asks first; stopping sends nothing, continuing uses the new floor', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await page.evaluate(() => { window.__w.freshDrift = 200n; });
  await typeAmount(page, '0.1');
  await page.click('[data-k=ego]'); await waitModal(page, /Buy 1,7\d\d TAC/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  const m = await waitModal(page, /The price moved/);
  assert.match(m, /You were shown≈ 1,7\d\d TAC.*It is now≈ 1,7\d\d TAC/s);
  assert.match(m, /Nothing has been sent/);
  await page.click('.bm-modal .bm-mfoot button:not(.bm-go)');
  await waitModal(page, /Nothing sent/);
  assert.equal((await calls(page, 'sendTx')).length, 0);
  await page.click('.bm-modal .bm-mfoot .bm-go'); await settle(page);
  // the page's quote was refreshed to the lower price
  assert.match(await page.textContent('[data-k=equote]'), /You get1,7\d\d TAC/);
  // continue path
  await page.click('[data-k=ego]'); await waitModal(page, /Buy 1,7\d\d TAC/);
  await page.evaluate(() => { window.__w.freshDrift = 400n; });
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /The price moved/);
  const shownNew = (await page.textContent('.bm-modal')).match(/It is now≈ ([\d,]+) TAC at least ([\d,]+)/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Bought/);
  const builds = await calls(page, 'build');
  const last = builds[builds.length - 1].args;
  assert.equal(fmt(BigInt(last.minOut)), shownNew[2].replace(/,/g, ''), 'the accepted floor is what was built');
  assert.equal((await calls(page, 'sendTx')).length, 1);
});

await test('a changed amount or side cannot be reviewed until its own quote lands', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await typeAmount(page, '0.5');
  assert.equal(await page.textContent('[data-k=ego]'), 'Review buy');
  await page.fill('[data-k=eamount]', '1.5');
  assert.equal(await page.textContent('[data-k=ego]'), 'Finding the best price…', 'the 0.5 quote does not answer for 1.5');
  assert.equal(await page.isDisabled('[data-k=ego]'), true);
  assert.match(await page.textContent('[data-k=equote]'), /Finding the best price/, 'no figures for another amount are shown');
  await settle(page, 700);
  assert.equal(await page.textContent('[data-k=ego]'), 'Review buy');
  await page.click('[data-k=ego]');
  const m = await waitModal(page, /Buy 2\d,\d{3} TAC/);
  assert.match(m, /You pay1\.5 ETH/);
  await page.keyboard.press('Escape');
  // a quote still in flight when the side flips does not answer for the other side
  await page.evaluate(() => { window.__w.quoteDelay = 900; });
  await typeAmount(page, '1');
  await page.click('[data-act=eside][data-v=sell]');
  await page.fill('[data-k=eamount]', '5000');
  await settle(page, 1200);
  await page.evaluate(() => { window.__w.quoteDelay = 0; });
  await page.fill('[data-k=eamount]', '5001');
  assert.equal(await page.textContent('[data-k=ego]'), 'Finding the best price…');
});

await test('a finished or failed swap dialog closes with Escape', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await typeAmount(page, '0.2');
  await page.click('[data-k=ego]'); await waitModal(page, /Buy/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Bought/);
  await page.keyboard.press('Escape'); await settle(page, 100);
  assert.equal(await page.$('.bm-modal'), null, 'Escape closes the result');
  await page.evaluate(() => { window.__w.sendFails = Object.assign(new Error('denied'), { code: 4001 }); });
  await typeAmount(page, '0.2');
  await page.click('[data-k=ego]'); await waitModal(page, /Buy/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Nothing sent/);
  await page.keyboard.press('Escape'); await settle(page, 100);
  assert.equal(await page.$('.bm-modal'), null, 'Escape closes the failure too');
  // while the swap is running, Escape does nothing
  await page.evaluate(() => { window.__w.sendFails = null; window.__w.pending = true; });
  await typeAmount(page, '0.2');
  await page.click('[data-k=ego]'); await waitModal(page, /Buy/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Confirming on Ethereum/); await settle(page, 200);
  await page.keyboard.press('Escape'); await settle(page, 100);
  assert.ok(await page.$('.bm-modal'), 'a swap in flight keeps its dialog');
});

await test('sell: if the winning venue changes after the allowance, the new venue is allowed too', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await page.click('[data-act=eside][data-v=sell]'); await settle(page);
  await page.evaluate(() => { window.__w.flipVenueAfterBuild = true; });
  await typeAmount(page, '1000');
  await page.click('[data-k=ego]'); await waitModal(page, /Sell 1,000 TAC/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  await waitModal(page, /Sold 1,000 TAC|Nothing sent|Swap failed/);
  const sends = await calls(page, 'sendTx');
  const spenders = sends.filter((c) => /^0x095ea7b3/.test(c.args.data)).map((c) => '0x' + c.args.data.slice(10 + 24, 10 + 64));
  assert.deepEqual(spenders, ['0x' + 'cd'.repeat(20), '0x' + 'ef'.repeat(20)], 'each venue the swap went to was allowed before it ran');
  assert.equal(sends.length, 3);
});

await test('selling TAC with no ETH for the network fee cannot be reviewed', async (page) => {
  await page.evaluate(() => { window.__w.ethBal = 0n; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await page.click('[data-act=eside][data-v=sell]'); await settle(page);
  await typeAmount(page, '100');
  assert.equal(await page.textContent('[data-k=ego]'), 'Not enough ETH for the network fee');
  assert.equal(await page.isDisabled('[data-k=ego]'), true);
});

await test('a wallet rejection sends nothing and says so plainly; a failing simulation never reaches the wallet', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await typeAmount(page, '0.2');
  await page.evaluate(() => { window.__w.sendFails = Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), { code: 4001 }); });
  await page.click('[data-k=ego]'); await waitModal(page, /Buy/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  const m = await waitModal(page, /Nothing sent/);
  assert.match(m, /Cancelled in your wallet — nothing was sent/);
  assert.doesNotMatch(m, /MetaMask/);
  await page.click('.bm-modal .bm-mfoot .bm-go'); await settle(page);
  assert.equal(await page.inputValue('[data-k=eamount]'), '0.2', 'the amount stays for a retry');
  await page.evaluate(() => { window.__w.sendFails = null; window.__w.simFails = 'execution reverted'; window.__w.simData = '0x08c379a0' + '20'.padStart(64, '0') + '0e'.padStart(64, '0') + '546f6f206c6974746c65206f7574'.padEnd(64, '0'); window.__w.calls = []; });
  await page.click('[data-k=ego]'); await waitModal(page, /Buy/);
  await page.click('.bm-modal .bm-mfoot .bm-go');
  const m2 = await waitModal(page, /Nothing sent/);
  assert.match(m2, /It would fail: Too little out/);
  assert.equal((await calls(page, 'sendTx')).length, 0);
});

await test('a trade that moves the price past 10% must be acknowledged before review; past 3% it is called out', async (page) => {
  await mount(page); await settle(page, 300);
  await page.evaluate(() => { window.__w.ethBal = 100n * 10n ** 18n; window.__w.impactPerEth = 100n; });
  await page.click('[data-act=econnect]'); await settle(page, 300);
  await typeAmount(page, '4');
  assert.match(await page.textContent('[data-k=equote]'), /Price impact4\.0\d%.*A large trade for this pool/s);
  assert.equal(await page.textContent('[data-k=ego]'), 'Review buy');
  await typeAmount(page, '12');
  assert.match(await page.textContent('[data-k=equote]'), /Price impact12\.0\d%.*I understand I'm trading well off the market price/s);
  assert.equal(await page.textContent('[data-k=ego]'), 'Confirm the price impact above');
  assert.equal(await page.isDisabled('[data-k=ego]'), true);
  await page.check('[data-act=eack]'); await settle(page);
  assert.equal(await page.textContent('[data-k=ego]'), 'Review buy');
  await typeAmount(page, '13');
  assert.equal(await page.isDisabled('[data-k=ego]'), true, 'a changed amount needs a fresh acknowledgement');
});

await test('slippage changes the floor; the choice is remembered; typing survives a background re-quote', async (page) => {
  await mount(page); await settle(page, 300);
  await typeAmount(page, '1');
  assert.match(await page.textContent('[data-k=equote]'), /after 0.5% slippage/);
  await page.click('[data-k=eopts-sum]'); await page.selectOption('[data-act=eslip]', '300'); await settle(page);
  assert.match(await page.textContent('[data-k=equote]'), /At least17,0\d\d TAC after 3% slippage/);
  assert.match(await page.textContent('[data-k=eopts-sum]'), /Slippage 3%/);
  await page.focus('[data-k=eamount]');
  await page.evaluate(() => window.__ctl.refresh()); await settle(page, 400);
  assert.equal(await page.inputValue('[data-k=eamount]'), '1');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.k), 'eamount');
  // a second mount on the same host reuses the lane instead of wiping the typed amount
  await mount(page); await settle(page);
  assert.equal(await page.inputValue('[data-k=eamount]'), '1');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tacit-eth-lane-v1')).slippageBps), 300);
});

await test('no route: says so and points at resting board orders; a connect failure is a toast, not a stuck button', async (page) => {
  await mount(page); await settle(page, 300);
  await page.evaluate(() => { const W = window.__w; W.haircutBps = {}; W.restingOrders = 2; });
  await typeAmount(page, '1');
  const q = await page.textContent('[data-k=equote]');
  assert.match(q, /No venue can fill this amount right now/);
  assert.match(q, /2 resting orders on zSwap's boards may — fill there/);
  assert.equal(await page.getAttribute('[data-k=equote] a', 'href'), 'https://zswap.wei.limo/#token=ETH&out=0xA1313eb9f3A445606D9583bcAc3ebeB56a858279&amount=1');
  await page.evaluate(() => { window.__w.connectFails = 'no Ethereum wallet detected — install MetaMask'; });
  await page.click('[data-k=ego]'); await settle(page, 300);
  assert.equal(await page.textContent('[data-k=ego]'), 'Connect wallet');
  assert.equal(await page.isDisabled('[data-k=ego]'), false);
});

await b.close();
srv.close();
console.log(`evm-trade-lane flows: ${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
