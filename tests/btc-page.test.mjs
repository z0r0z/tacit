#!/usr/bin/env node
// The BTC and ETH page (dapp/btc/) in a real browser, under its own CSP, and the front page's link into the swap card's lane. The page, the lane (swap/atomic.js),
// the market read (swap/atomic-market.js) and the card are the real files; the wallet module (/trade/btc.js), the pair opener (/fast/pair-wire.js openPair) and the pair
// client behind it are stand-ins of the shape fastbridge-pair.js gives, as in tests/swap-atomic-lane.test.mjs. The board is answered by the test with an ad that is
// really signed, and the public nodes with Chainlink's ETH / BTC answer, so the real check of ads and the real price read run. Nothing reaches Bitcoin or Ethereum.
//   checks: the page (title, the two marks, one line, the lane), the providers (each way's limits, what is available, the fee, the totals), becoming a provider,
//   an estimate before the wallet opens, the swaps after it opens (steps, when to be back, a copy to save), links (?dir=e2b&amt=, ?from=ETH&to=BTC) and the address,
//   stepping while the tab is hidden, the leave guard, a phone width and the dark scheme; the front page's ?from=BTC&to=ETH&from-at=btc opens the lane.
//
//   node tests/btc-page.test.mjs        (SHOTS=<dir> saves screenshots; PLAYWRIGHT=<path to playwright-core>)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { signAd } from '../dapp/fastbridge-board.js';
import { G } from '../dapp/bulletproofs.js';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const SATS = '0'.repeat(64), ETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const BOARD = 'https://tacit-fast-board.onrender.com';
const CHAINLINK = '0xac559f25b1619171cbc396a50854a3240b6a4e99';

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// a provider of the pair, both ways: 0.0005 to 1 BTC (0.3 available) at 0.4% + 800 sats, and 0.01 to 30 ETH (2 available) at 0.2% + 0.0003 ETH
const priv = 0x1d2c3b4a5968778695a4b3c2d1e0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8cn;
const pub = (k) => bytesToHex(G.multiply(k).toRawBytes(true));
const ad = () => {
  const at = Math.floor(Date.now() / 1000);
  return signAd({ claimPub: pub(priv), gateway: pub(priv + 1n), name: 'Test provider', btcAsset: SATS, evmAsset: ETH, minAmount: '50000', maxAmount: '100000000', available: '30000000', flatFee: '800', feeBps: 40, csvBlocks: 144, evmWindowSecs: 14400,
    reverse: { minAmount: '1000000', maxAmount: '3000000000', available: '200000000', feeBps: 20, flatFee: '30000', csvBlocks: 96, evmWindowSecs: 14400 }, at, until: at + 300 }, priv);
};
// Chainlink's aggregator: 18 places, BTC per ETH of 1/30.62
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const chainlink = (data) => {
  if (data.startsWith('0x313ce567')) return `0x${word(18)}`;
  const now = Math.floor(Date.now() / 1000), answer = BigInt(Math.round(1e18 / 30.62));
  return `0x${word(5)}${word(answer)}${word(now - 60)}${word(now - 60)}${word(5)}`;
};

const BTC_STUB = `
const W = window.__btc = { unlocked: false, signIns: 0, funds: 0, fundAsk: null };
const T = { wallet: { priv: new Uint8Array(32).fill(7), address: () => 'bc1qtestaddress0000000000000000000000000' } };
const session = { get unlocked() { return W.unlocked; }, get key() { return W.unlocked ? { pubHex: '02' + 'ab'.repeat(32) } : null; }, get T() { return T; }, load: async () => T, turn: async (fn) => fn() };
export function makeBitcoin({ onChange }) { return { session, signIn: async () => { W.unlocked = true; W.signIns++; onChange?.(); }, fund: (o) => { W.funds++; W.fundAsk = o || null; } }; }`;
const WIRE_STUB = `export async function openPair(o) { window.__atom.opened.push(o.pubHex); return { pair: window.__atom.pair, address: () => ({ btc: 'bc1qtest' }), run: () => () => {}, keep: { save: () => ({ v: 1, kind: 'tacit-btc-eth-swaps', prefix: 'p', at: 1, items: { 'p:sw1': '{}' } }), load: () => 1 } }; }`;
const FAKE = `
(() => {
  const now = () => Math.floor(Date.now() / 1000);
  const calls = { quote: [], start: [], pump: 0, records: 0, recover: 0 };
  const TITLES = { b2e: ['Lock your BTC', 'Provider locks ETH', 'You claim the ETH', 'Provider takes BTC'], e2b: ['Provider locks BTC', 'You lock your ETH', 'Provider claims ETH', 'You take your BTC'] };
  const steps = (dir, at, state) => TITLES[dir].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: state === 'done' ? 'done' : i < at ? 'done' : i === at && state === 'working' ? 'active' : 'todo' }));
  const S = window.__atom = { calls, opened: [], bal: { sats: 50000000n, eth: 400000000n },
    recs: [
      { id: 'sw1', dir: 'b2e', state: 'working', title: 'Claiming your ETH', detail: 'Your claim is being settled in the pool.', pay: 1000000n, get: 30400000n, steps: steps('b2e', 2, 'working'), etaSecs: 120, at: now() - 900, refundAt: now() + 86000, backBy: now() + 3 * 3600 },
      { id: 'sw0', dir: 'e2b', state: 'done', title: 'Done', detail: 'The BTC is at your Bitcoin address.', pay: 5000000n, get: 160000n, steps: steps('e2b', 4, 'done'), etaSecs: 0, at: now() - 86400, refundAt: null, backBy: null },
    ] };
  S.pair = {
    providers: async () => [{ id: 'p1', name: 'Test provider', dirs: ['b2e', 'e2b'], b2e: { min: 50000n, max: 100000000n, available: 30000000n }, e2b: { min: 1000000n, max: 3000000000n, available: 200000000n } }],
    reference: async () => ({ ethPerBtc: 30.62, at: now(), source: 'test' }),
    balances: async () => ({ sats: S.bal.sats, eth: S.bal.eth, ethHeld: S.bal.eth, pendingSats: 0n }),
    quote: async ({ dir, amount }) => { calls.quote.push({ dir, amount: String(amount) }); const b2e = dir === 'b2e';
      return { dir, provider: { id: 'p1', name: 'Test provider' }, pay: amount, get: b2e ? (amount * 304n) / 10n : (amount * 10n) / 304n, rate: 30.4, market: 30.62, vsMarketBps: -72, feeBps: 72, etaSecs: 1500, networkFeeSats: b2e ? 1200 : null, takeFeeSats: b2e ? null : 500, expiresAt: now() + 300, warnings: [], blocked: null, ref: {} }; },
    start: async (q) => { calls.start.push(q); return { id: 'sw9' }; },
    pump: async () => { calls.pump++; return S.recs; },
    records: async () => { calls.records++; return S.recs; },
    recover: async () => { calls.recover++; return 0; },
  };
})();`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const text = async (page, sel) => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const SHOT = async (page, name, full = true) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: full }); };

// the network: the board and the public nodes are answered here, everything else off the machine is refused
async function wire(page, { ads, boardDelayMs = 0 }) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request(), url = req.url();
    if (url === `${BOARD}/ads`) { if (boardDelayMs) await sleep(boardDelayMs); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ads }) }).catch(() => {}); }
    if (req.method() === 'POST' && /publicnode|drpc|1rpc|tenderly|mevblocker|blastapi|buidlguidl|thirdweb|stakely|nodereal|flashbots|tacit-node-gw/.test(url)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }
      const one = (x) => (x.method === 'eth_call' && String(x.params?.[0]?.to || '').toLowerCase() === CHAINLINK ? { jsonrpc: '2.0', id: x.id, result: chainlink(String(x.params[0].data)) } : { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'offline in this test' } });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    }
    return route.abort();
  });
}
async function fresh({ path = '/btc/', ads = [ad()], viewport = { width: 1200, height: 1000 }, scheme = 'light' } = {}) {
  const page = await b.newPage({ viewport, colorScheme: scheme, acceptDownloads: true });
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await wire(page, { ads });
  await page.addInitScript(FAKE);
  await page.route(/\/trade\/btc\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: BTC_STUB }));
  await page.route(/\/fast\/pair-wire\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: WIRE_STUB }));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#a-go') && document.querySelector('#a-go').textContent !== 'Loading…', null, { timeout: 30000 });
  return { page, errs, csp };
}
const listed = (page) => page.waitForFunction(() => document.querySelectorAll('#pv-list li').length > 0 && /1 BTC =/.test(document.querySelector('#live').textContent), null, { timeout: 20000 });
const atom = (page, expr) => page.evaluate((e) => new Function('A', `return (${e})`)(window.__atom), expr);

console.log('the page: the marks, the line, the lane');
{
  const { page, errs, csp } = await fresh();
  ok((await page.title()) === 'tacit btc', `the title is "tacit btc" (${await page.title()})`);
  const marks = await page.$$eval('.hero .mk use', (us) => us.map((u) => u.getAttribute('href')));
  const size = await page.$eval('.hero .mk .tk', (e) => e.getBoundingClientRect().width);
  ok(JSON.stringify(marks) === JSON.stringify(['#tk-btc', '#tk-eth']) && size >= 64, `the hero has the front page's BTC and ETH marks, large (${JSON.stringify(marks)}, ${Math.round(size)} px)`);
  ok(/BTC\s*⇄\s*ETH/.test(await text(page, 'h1')) && /Swap BTC and ETH with a provider\. Private on the Ethereum side\./.test(await text(page, '.hero .sub')), 'one heading and one line');
  ok(await page.isVisible('#atomic #a-go') && /Open your Tacit wallet/.test(await text(page, '#a-go')) && /From.*Bitcoin/.test(await text(page, '#a-pay')) && /To.*Ethereum, private/.test(await text(page, '#a-get')), 'the lane is mounted, BTC to ETH, and asks for the wallet');

  console.log('providers, read with no wallet open');
  await listed(page);
  const live = await text(page, '#live');
  ok(/1 BTC = 30\.62 ETH/.test(live) && /1 provider online/.test(live) && /up to 0\.3 BTC or 2 ETH now/.test(live), `the line under the heading: the market, who is online, what can be swapped now (${live})`);
  const row = await text(page, '#pv-list li');
  ok(/Test provider/.test(row) && /BTC → ETH 0\.0005 to 1 BTC 0\.3 BTC available now fee 0\.4% \+ 800 sats \(2\.0% at the minimum\)/.test(row), `the forward terms: limits, available, the fee and what it is at the minimum (${row})`);
  ok(/ETH → BTC 0\.01 to 30 ETH 2 ETH available now fee 0\.2% \+ 0\.0003 ETH \(3\.2% at the minimum\)/.test(row), 'the reverse terms, in ETH');
  ok(/up to 0\.3 BTC for ETH, and up to 2 ETH for BTC/.test(await text(page, '#cap')), `the totals (${await text(page, '#cap')})`);

  console.log('becoming a provider');
  const be = await text(page, '#be');
  ok(/What you need/i.test(be) && /Your terms/i.test(be) && /openssl rand -hex 32/.test(be) && /fastbridge-lp-shield\.mjs <ETH> --eth --index 0 --send/.test(be) && /config\.btc-eth\.example\.json/.test(be) && /--dry-run/.test(be), 'what is needed, the terms and the exact commands');
  ok((await page.$$('#be .cmd button')).length >= 5 && (await page.getAttribute('#be a[href*="README.md"]', 'href')).includes('pair-mode'), 'each command has a copy button, and the guide is linked at its pair-mode section');

  console.log('an estimate before the wallet opens');
  await page.fill('#a-amt', '0.01');
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  const est = await text(page, '#a-out'), rc = await text(page, '#a-rcpt');
  ok(/^≈ 0\.30\d+$/.test(est) && (await page.$eval('#a-out', (e) => e.classList.contains('est'))), `the amount out is an estimate, marked as one (${est})`);
  ok(/Market\s*1 BTC = 30\.62 ETH/.test(rc) && /Limits\s*0\.0005 to 1 BTC/.test(rc) && /Available now\s*up to 0\.3 BTC/.test(rc) && /Firm price\s*once your wallet is open/.test(rc), `with the market, the limits and what is available (${rc})`);
  ok((await atom(page, 'A.calls.quote.length')) === 0, 'no provider is asked for a quote before the wallet is open');
  await SHOT(page, 'desktop-light');

  console.log('the wallet opens: the swaps');
  ok(/Open your Tacit wallet above/.test(await text(page, '#mine-say')) && await page.isHidden('#mine-keep'), 'before: the swaps section says how to see them');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && !document.querySelector('#mine-list').hidden, null, { timeout: 30000 });
  ok(await page.isHidden('#a-sent') && (await page.$$('#mine-list > div')).length === 2, 'the swaps are listed in their own section, not under the lane');
  const mine = await text(page, '#mine-list');
  ok(/Claiming your ETH/.test(mine) && /0\.01 BTC → about 0\.304 ETH/.test(mine) && (await page.$$('#mine-list .wait .stp li')).length === 4 && (await page.$$('#mine-list .wait .stp li.done')).length === 2, 'a swap under way: its amounts and its four steps, two done');
  ok(/Keep this page open until it is done\. If you close it, come back by \d{1,2}:\d\d(?: [AP]M)? (today|tomorrow): the ETH has to be claimed by then, or your BTC returns by itself after about a day\./.test(mine), `it says when to be back, and what happens if not (${mine.slice(0, 400)})`);
  ok(/If it stops, your BTC returns in 2\d h/.test(mine) && /Done/.test(await text(page, '#mine-list .ok')), 'its refund time, and a finished swap marked done');
  ok(await page.isVisible('#keep-save') && (await text(page, '#mine-say')) === '', 'a copy of the swaps can be saved');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('#keep-save')]);
  ok(!!dl && /^tacit-btc-eth-swaps-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename()), `Save a copy downloads the swaps (${dl && dl.suggestedFilename()})`);
  await page.waitForFunction(() => /Balance 0\.5 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await page.fill('#a-amt', '0.02');
  await page.waitForFunction(() => /^Swap BTC → ETH$/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(!/^≈/.test(await text(page, '#a-out')) && (await atom(page, 'A.calls.quote.at(-1).amount')) === '2000000', 'with the wallet open, the amount is the provider\'s quote');
  await SHOT(page, 'desktop-light-open');

  console.log('a hidden tab still steps the swap; leaving asks first');
  const before = await atom(page, 'A.calls.pump');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(6500);
  ok((await atom(page, 'A.calls.pump')) > before, `with the tab hidden the swap under way is stepped (${before} → ${await atom(page, 'A.calls.pump')} passes)`);
  ok(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; }), 'leaving the page while a swap is under way is asked about');

  console.log('the address follows the lane');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
  await page.click('#a-flip');
  ok(/\?dir=e2b/.test(page.url()) && /From.*Ethereum, private/.test(await text(page, '#a-pay')), `the flip turns the lane and the address (${page.url()})`);
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('links');
{
  const { page } = await fresh({ path: '/btc/?dir=e2b&amt=0.05' });
  ok(/From.*Ethereum, private/.test(await text(page, '#a-pay')) && (await page.inputValue('#a-amt')) === '0.05', '/btc/?dir=e2b&amt=0.05 opens ETH to BTC with the amount');
  await listed(page);
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  ok(/^≈ 0\.0016\d+$/.test(await text(page, '#a-out')) && /Limits\s*0\.01 to 30 ETH/.test(await text(page, '#a-rcpt')), `and estimates it the other way, with that way's limits (${await text(page, '#a-out')})`);
  await page.close();
  const two = await fresh({ path: '/btc/?from=ETH&to=BTC' });
  ok(/From.*Ethereum, private/.test(await text(two.page, '#a-pay')), 'the card\'s own words (?from=ETH&to=BTC) open it the same way');
  await two.page.close();
}

console.log('no provider online');
{
  const { page } = await fresh({ ads: [] });
  await page.waitForFunction(() => /No provider is online/.test(document.querySelector('#cap').textContent), null, { timeout: 20000 });
  ok((await page.$$('#pv-list li')).length === 0 && /no provider online/.test(await text(page, '#live')), 'the list says so, and the line under the heading too');
  await page.close();
}

console.log('a phone width, light and dark');
for (const scheme of ['light', 'dark']) {
  const { page, errs, csp } = await fresh({ viewport: { width: 390, height: 860 }, scheme });
  await listed(page);
  await page.fill('#a-amt', '0.01');
  await page.waitForFunction(() => /^≈/.test(document.querySelector('#a-out').textContent), null, { timeout: 8000 });
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${scheme}: no sideways scroll at 390 px`);
  const mk = await page.$eval('.hero .mk', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
  ok(mk, `${scheme}: the marks fit the width`);
  await SHOT(page, `phone-${scheme}`);
  if (scheme === 'dark') { await page.setViewportSize({ width: 1200, height: 1000 }); await SHOT(page, 'desktop-dark'); }
  ok(errs.length === 0 && csp.length === 0, `${scheme}: no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

// The front page reads the boards a moment after it draws: a link that names the pair waits for them and opens the lane, rather than being read as another pair
console.log('the front page: a link for BTC and ETH opens the lane');
for (const [path, dir] of [['/?from=BTC&to=ETH&from-at=btc', 'b2e'], ['/?from=ETH&to=BTC&to-at=btc&amt=0.05', 'e2b']]) {
  const page = await b.newPage({ viewport: { width: 1200, height: 1000 } });
  await wire(page, { ads: [ad()], boardDelayMs: 2500 });
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  const early = await page.waitForFunction(() => document.querySelector('#hx-swap.swc'), null, { timeout: 60000 }).then(() => page.url());
  ok(/from=(BTC|ETH)/.test(early) && !/tETH|TAC/.test(early), `${dir}: while the boards are read the address keeps the link (${early.replace(BASE, '')})`);
  const opened = await page.waitForFunction(() => document.querySelector('#atomic:not([hidden]) #a-go'), null, { timeout: 60000 }).then(() => true, () => false);
  ok(opened && (await page.isVisible('#atomic')), `${path}: the lane opens once the boards answer`);
  ok(dir === 'b2e' ? /From.*Bitcoin/.test(await text(page, '#a-pay')) : /From.*Ethereum, private/.test(await text(page, '#a-pay')) && (await page.inputValue('#a-amt')) === '0.05', `${dir}: the way round${dir === 'e2b' ? ' and the amount' : ''} the link names`);
  ok(dir === 'b2e' ? /from=BTC/.test(page.url()) && /to=ETH/.test(page.url()) : /from=ETH/.test(page.url()) && /to=BTC/.test(page.url()), `${dir}: the address is the lane's (${page.url().replace(BASE, '')})`);
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
