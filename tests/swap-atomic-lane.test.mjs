#!/usr/bin/env node
// The swap card's Bitcoin and Ethereum lane (swap/atomic.js, swap/atomic-probe.js) on the card's test harness (tests/swap-harness/, served at /swap/) in a real browser, under
// the page's CSP. The lane and the card are the real files. The wallet module (/trade/btc.js), the pair opener (/fast/pair-wire.js openPair) and the pair client behind it are
// stand-ins of the shape fastbridge-pair.js gives (opened by fast/pair-wire.js openPair), which record what the lane asks of them; the boards are answered by the test, with an ad that is really signed so that the
// real check of ads runs. Nothing here reaches Bitcoin or Ethereum.
//   checks: with no provider the card is as it was (two switches, no lane code or markup, one read of the board) for a board that is empty, one with other ads, and one with an ad
//   no key signed; with a provider the third switch appears; the lane (sign-in, balances, the minimum, a quote and its comparison with the market, a quote that must not be started,
//   a flip, one start however many presses, the steps of a swap under way, done and returned, dismissing, found again from the key); links and the address; the front page's switch; a phone width.
//   The card hosts the lane with the /btc/ page's Add ETH and Receive as; a finished swap's next steps open /btc/ (Add ETH's flow is tested in tests/btc-page.test.mjs).
//
//   node tests/swap-atomic-lane.test.mjs        (SHOTS=<dir> saves screenshots; PLAYWRIGHT=<path to playwright-core>)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { signAd } from '../dapp/fastbridge-board.js';
import { G } from '../dapp/bulletproofs.js';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SH = new URL('./swap-harness/', import.meta.url).pathname;
const HARNESS = { '/swap/': join(SH, 'index.html'), '/swap/index.html': join(SH, 'index.html'), '/swap/app.js': join(SH, 'app.js') };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const SATS = '0'.repeat(64), ETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const BOARD = 'https://tacit-fast-board.onrender.com';

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

// an ad for a provider of the pair: plain sats against the pool's ETH, signed by a key (or not signed, or for another pair)
const priv = 0x1d2c3b4a5968778695a4b3c2d1e0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8cn;
const pub = (k) => bytesToHex(G.multiply(k).toRawBytes(true));
const ad = ({ btcAsset = SATS, evmAsset = ETH, sign = true } = {}) => {
  const at = Math.floor(Date.now() / 1000), body = { claimPub: pub(priv), gateway: pub(priv + 1n), name: 'Test provider', btcAsset, evmAsset, minAmount: '50000', maxAmount: '100000000', flatFee: '0', feeBps: 40, csvBlocks: 144, evmWindowSecs: 14400, at, until: at + 300 };
  const signed = signAd(body, priv);
  return sign ? signed : { ...signed, sig: '00'.repeat(64) };
};

// stand-in for /trade/btc.js: the lane's door to the Tacit key
const BTC_STUB = `
const W = window.__btc = { unlocked: false, signIns: 0, funds: 0, pub: '02' + 'ab'.repeat(32) };
const T = { wallet: { priv: new Uint8Array(32).fill(7), address: () => 'bc1qtestaddress0000000000000000000000000' } };
const session = { get unlocked() { return W.unlocked; }, get key() { return W.unlocked ? { pubHex: W.pub } : null; }, get T() { return T; }, load: async () => T, turn: async (fn) => fn() };
export function makeBitcoin({ onChange }) {
  W.lock = () => { W.unlocked = false; onChange?.(); };
  W.openAs = (pub) => { W.pub = pub; W.unlocked = true; onChange?.(); };
  return { session, signIn: async () => { W.unlocked = true; W.signIns++; onChange?.(); }, fund: (o) => { W.funds++; W.fundAsk = o || null; } };
}`;
const WIRE_STUB = `export async function openPair(o) { window.__atom.opened.push({ pubHex: o.pubHex, priv: o.priv instanceof Uint8Array && o.priv.length === 32, hasT: !!(o.T && o.T.wallet && typeof o.T.wallet.address === 'function'), hasUx: !!o.ux, walletIsGetter: typeof o.wallet }); return { pair: window.__atom.pair, address: () => ({ btc: 'bc1qtest' }), run: () => () => {} }; }`;
// the pair client, as fastbridge-pair.js shapes it
const FAKE = `
(() => {
  const calls = { quote: [], quotes: [], start: [], pump: 0, records: 0, recover: 0, balances: 0, providers: 0 };
  const now = () => Math.floor(Date.now() / 1000);
  const S = window.__atom = { calls, opened: [], mode: 'ok', recs: [], bal: { sats: 50000000n, eth: 400000000n }, failStart: false, warn: false, providers: [{ id: 'p1', name: 'Test provider', dirs: ['b2e', 'e2b'], minSats: 50000n, maxSats: 100000000n,
    b2e: { min: 50000n, max: 100000000n, available: null }, e2b: { min: 1000000n, max: 3000000000n, available: 2000000000n } }] };
  const TITLES = { b2e: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'], e2b: ['They send BTC', 'You send ETH', 'They confirm', 'You get BTC'] };
  const steps = (dir, at, state) => TITLES[dir].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: state === 'done' ? 'done' : i < at ? 'done' : i === at && state === 'working' ? 'active' : 'todo' }));
  const set = (id, patch) => { S.recs = S.recs.map((r) => (r.id === id ? { ...r, ...patch } : r)); };
  S.advance = (id, at, state, title) => { const r = S.recs.find((x) => x.id === id); set(id, { state, title: title || r.title, steps: steps(r.dir, at, state), refundAt: state === 'working' ? r.refundAt : null, detail: state === 'returned' ? 'Your coins came back.' : '' }); };
  S.pair = {
    providers: async () => { calls.providers++; return S.providers; },
    reference: async () => ({ ethPerBtc: 30.62, at: now(), source: 'test' }),
    balances: async () => { calls.balances++; return { sats: S.bal.sats, eth: S.bal.eth, ethHeld: S.bal.ethHeld, pendingSats: S.bal.pendingSats }; },
    quote: async ({ dir, amount }) => {
      calls.quote.push({ dir, amount: String(amount) });
      if (S.failN > 0) { S.failN--; throw new TypeError('Failed to fetch'); }
      if (S.mode === 'none') throw new Error('No provider can take that amount.');
      const b2e = dir === 'b2e', blocked = S.mode === 'blocked';
      const q = { dir, provider: { id: 'p1', name: 'Test provider' }, pay: amount, get: ((b2e ? (amount * 304n) / 10n : (amount * 10n) / 304n) * (S.cut ? 99n : 100n)) / 100n, rate: blocked ? 29.4 : 30.4, market: 30.62, vsMarketBps: blocked ? -410 : -72, feeBps: 40, etaSecs: 780,
        networkFeeSats: b2e ? 1200 : 0, takeFeeSats: b2e ? null : 500, expiresAt: now() + (S.ttl || 300), highFee: S.highFee ? { sats: 1200, bps: 1200 } : null, warnings: S.warn ? ['The provider holds less than this right now.'] : [], blocked: blocked ? 'the provider quotes 4.1% under the market' : null, ref: { n: calls.quote.length } };
      // (a swap that three providers fill: the plan beside the quote, as fastbridge-pair.js shapes it)
      if (S.mode === 'split') {
        const part = (name, pay) => ({ provider: { id: name, name }, pay, get: (pay * 304n) / 10n, ref: {} });
        const each = amount / 3n;
        q.provider = { id: 'split', name: '3 providers' }; q.split = { legs: [part('Alpha', each), part('Bravo', each), part('Charlie', amount - 2n * each)], single: null };
      }
      calls.quotes.push(q);
      return q;
    },
    start: async (q) => {
      calls.start.push(q);
      await new Promise((r) => setTimeout(r, 200));
      if (S.failStart === 'requote') throw Object.assign(new Error('The provider cannot hold that amount just now: a new quote is being asked for.'), { requote: true });
      if (S.failStart) throw new Error('The provider cannot hold that amount.');
      const id = 'sw' + calls.start.length;
      S.recs = [{ id, dir: q.dir, state: 'working', title: q.dir === 'b2e' ? 'Waiting for Bitcoin' : 'Waiting for the Bitcoin lock', detail: 'The lock needs a confirmation.', pay: q.pay, get: q.get, steps: steps(q.dir, 0, 'working'), etaSecs: 780, at: now(), refundAt: now() + 86400 }, ...S.recs];
      return { id };
    },
    pump: async () => { calls.pump++; if (S.pumpMs) await new Promise((r) => setTimeout(r, S.pumpMs)); return S.recs; },
    records: async () => { calls.records++; return S.recs; },
    recover: async () => { calls.recover++; return 0; },
  };
})();`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const text = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const SHOT = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };

// a page on the harness. `ads`: what the board lists; `stubs`: the wallet module, the opener and the pair client are stood in for.
async function fresh({ path = '/swap/', ads = [], viewport = { width: 1100, height: 1100 }, scheme = 'light', stubs = true } = {}) {
  const page = await b.newPage({ viewport, colorScheme: scheme });
  const seen = [], errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // (the harness page's CSP has never listed tacit-node-gw, which eth-nodes.js reads: not the lane's, and left as it is)
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t) && !/tacit-node-gw\.onrender\.com/.test(t)) csp.push(t.slice(0, 160)); });
  page.on('request', (r) => seen.push(r.url()));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request(), url = req.url();
    if (url === `${BOARD}/ads`) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ads }) });
    if (/publicnode|drpc|1rpc|tenderly|mevblocker|blastapi/.test(url)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }
      const err = (id) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'offline in this test' } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map((x) => err(x.id)) : err(body.id)) });
    }
    return route.abort();
  });
  const app = readFileSync(join(SH, 'app.js'), 'utf8');
  if (!app.includes('card.load(new URLSearchParams(location.search));')) throw new Error('the harness app has changed: the card hook has nowhere to go');
  await page.route(/\/swap\/app\.js(\?|$)/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: app.replace('card.load(new URLSearchParams(location.search));', 'window.__card = card; card.load(new URLSearchParams(location.search));') }));
  if (stubs) {
    await page.addInitScript(FAKE);
    await page.route(/\/trade\/btc\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: BTC_STUB }));
    await page.route(/\/fast\/pair-wire\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: WIRE_STUB }));
  }
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sw');
  return { page, seen, errs, csp };
}
const probed = (page) => page.waitForFunction(() => performance.getEntriesByType('resource').some((r) => /\/swap\/atomic-probe\.js/.test(r.name)) , null, { timeout: 15000 }).then(() => sleep(900));
const radios = (page) => page.$$eval('.mode [role=radio]', (els) => els.map((e) => [e.dataset.mode, e.getAttribute('aria-checked')]));
const laneUp = (page) => page.waitForSelector('.swc .mode [data-mode=atomic]', { timeout: 15000 });
const open = async (page) => { await laneUp(page); await page.click('[data-mode=atomic]'); await page.waitForFunction(() => document.querySelector('#a-go') && document.querySelector('#a-go').textContent !== 'Loading…', null, { timeout: 8000 }); };
const type = async (page, v) => { await page.fill('#a-amt', v); await page.waitForFunction(() => !document.querySelector('#a-out').classList.contains('ph') || /No quote|Minimum|Maximum|Not enough/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 }); };
const atom = (page, expr) => page.evaluate((e) => new Function('A', `return (${e})`)(window.__atom), expr);

console.log('no provider: the card is as it was');
for (const [what, ads] of [['an empty board', []], ['a board with an ad of another pair', [ad({ btcAsset: TAC })]], ['a board with an ad of plain sats against another token', [ad({ evmAsset: TAC })]], ['an ad that no key signed', [ad({ sign: false })]]]) {
  const { page, seen, errs, csp } = await fresh({ ads });
  await probed(page);
  const rs = await radios(page);
  ok(rs.length === 2 && rs[0][0] === 'wallet' && rs[1][0] === 'bitcoin', `${what}: two switches, as before (${JSON.stringify(rs)})`);
  ok((await page.$('#atomic')) === null && !(await page.evaluate(() => document.querySelector('#p-swap').classList.contains('ab'))), `${what}: no lane markup and no mark on the card`);
  ok(!seen.some((u) => /\/swap\/atomic\.js/.test(u)), `${what}: the lane's code is not fetched`);
  ok(seen.filter((u) => u === `${BOARD}/ads`).length === 1 && seen.filter((u) => /fast\/lp\.json/.test(u)).length === 1, `${what}: one read of the list and one of the board`);
  ok(what !== 'an ad that no key signed' || seen.some((u) => /fastbridge-mailbox\.js/.test(u)), `${what}: ${what === 'an ad that no key signed' ? 'its signature is checked by the real code, which refuses it' : 'no checking code is fetched for an answer of no'}`);
  ok(what === 'an ad that no key signed' || !seen.some((u) => /fastbridge-mailbox\.js/.test(u)), what === 'an ad that no key signed' ? 'the refused ad opened nothing' : 'no checking code was needed');
  ok(errs.length === 0 && csp.length === 0, `${what}: no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}
{
  const { page } = await fresh({ path: '/swap/?from=BTC&to=ETH&amt=0.01' });
  await probed(page);
  ok((await page.getAttribute('[data-mode=wallet]', 'aria-checked')) === 'true' && (await page.$('#atomic')) === null, 'a link naming BTC and ETH is read as it always was when no provider exists');
  await page.close();
}

console.log('a provider: the switch appears, and the lane opens');
{
  const { page, errs, csp, seen } = await fresh({ ads: [ad()] });
  await laneUp(page);
  const rs = await radios(page);
  ok(rs.length === 3 && rs[2][0] === 'atomic' && rs[2][1] === 'false' && rs[0][1] === 'true', `the third switch appears (${JSON.stringify(rs)})`);
  ok((await page.getAttribute('[data-mode=atomic]', 'aria-label')) === 'Bitcoin and Ethereum' && (await page.$$('[data-mode=atomic] svg')).length === 2, 'it is named for a screen reader and shows the two marks');
  ok(seen.some((u) => /fastbridge-mailbox\.js/.test(u)), 'the ad was checked by the real code before the switch was made');
  ok(!seen.some((u) => /\/swap\/atomic\.js/.test(u)), 'the lane\'s own code waits for the first press');
  await page.click('[data-mode=atomic]');
  await page.waitForFunction(() => document.querySelector('#a-go'));
  ok(await page.isVisible('#atomic') && !(await page.isVisible('#f-pay')) && !(await page.isVisible('#go')), 'the lane replaces the card');
  ok((await page.getAttribute('[data-mode=atomic]', 'aria-checked')) === 'true' && (await page.getAttribute('[data-mode=wallet]', 'aria-checked')) === 'false', 'the switch shows the lane');
  ok(/from=BTC/.test(page.url()) && /to=ETH/.test(page.url()) && /from-at=btc/.test(page.url()), `the address names the pair (${page.url()})`);
  await page.waitForFunction(() => /Sign in to swap/.test(document.querySelector('#a-go').textContent));
  ok(/From.*Bitcoin/.test(await text(page, '#a-pay')) && /To.*Ethereum, private/.test(await text(page, '#a-get')) && (await page.$$('#a-pay-coin svg use')).length === 1, 'BTC is paid from Bitcoin and ETH comes to the private balance, each with its mark');
  ok((await page.$eval('#a-pay-coin use', (u) => u.getAttribute('href'))) === '#tk-btc' && (await page.$eval('#a-get-coin use', (u) => u.getAttribute('href'))) === '#tk-teth', 'the marks are the real BTC and tETH symbols');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && /Balance 0\.5 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  ok(true, 'opening the key reads the balance: Balance 0.5 BTC');
  const opened = await atom(page, 'A.opened');
  ok(opened.length === 1 && opened[0].priv && opened[0].hasT && opened[0].hasUx && opened[0].walletIsGetter === 'function' && opened[0].pubHex.startsWith('02ab'), 'the pair client is opened once, with tacit.js, the key, the pool wallet and the page\'s Ethereum wallet');
  ok((await atom(page, 'A.calls.recover')) === 1 && (await atom(page, 'A.calls.records')) >= 1, 'swaps from an earlier visit are looked for once, and the swaps kept are listed');
  await SHOT(page, 'lane-empty');

  console.log('the lane: the minimum, a quote, the market, a quote that must not start');
  await page.fill('#a-amt', '0.0001');
  await page.waitForFunction(() => /Use the minimum: 0\.0005 BTC/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), 'under the least a provider takes the button offers the minimum');
  await page.click('#a-go');
  ok((await page.inputValue('#a-amt')) === '0.0005', `and pressing it puts the minimum in the field, swapping nothing (${await page.inputValue('#a-amt')})`);
  await type(page, '0.01');
  ok((await text(page, '#a-out')) === '0.304', `0.01 BTC quotes 0.304 ETH (${await text(page, '#a-out')})`);
  const q = (await atom(page, 'A.calls.quote')).at(-1);
  ok(q.dir === 'b2e' && q.amount === '1000000', `the quote was asked for b2e and 1,000,000 sats (${JSON.stringify(q)})`);
  const r = await text(page, '#a-rcpt');
  ok(/Market rate\s*1 BTC = 30\.62 ETH/.test(r) && /Fee\s*0\.00220467 ETH · 0\.72%/.test(r) && /You receive\s*0\.304 ETH/.test(r) && /Effective rate\s*1 BTC = 30\.364 ETH/.test(r) && !(await page.$('#a-rcpt dd.warn')), `the market, the fee, the network fee and what arrives are shown (${r.slice(0, 200)})`);
  ok(/Provider\s*Test provider(?!,)/.test(r) && /Bitcoin network fee\s*≈ 1,200 sats/.test(r) && /Time\s*about 13 min/.test(r) && /If it stops\s*BTC returns/.test(r), 'the provider and fee, the Bitcoin fee, the time and what happens if it stops');
  ok(/^Swap BTC → ETH$/.test(await text(page, '#a-go')) && !(await page.$eval('#a-go', (e) => e.disabled)), 'the button says what it does');
  await SHOT(page, 'lane-quote');
  await atom(page, '(A.mode = "blocked", 0)');
  await type(page, '0.011');
  await page.waitForFunction(() => /Not at this price/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok(await page.$eval('#a-go', (e) => e.disabled), 'a quote more than the page accepts under the market cannot be started: the button is off');
  ok(/The provider quotes 4\.1% under the market/.test(await text(page, '#a-q')) && (await page.$eval('#a-q', (e) => e.classList.contains('err'))), 'and says why, in words');
  ok(await page.$eval('#a-rcpt dd.err', (e) => !!e).catch(() => false), 'the comparison is marked');
  await atom(page, '(A.mode = "none", 0)');
  await type(page, '0.012');
  await page.waitForFunction(() => /No quote/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok(/No provider can take that amount\./.test(await text(page, '#a-q')) && await page.$eval('#a-go', (e) => e.disabled), 'a provider that cannot quote the amount is told in its own words');
  await atom(page, '(A.mode = "ok", A.warn = true, 0)');
  await type(page, '0.013');
  ok(/Note\s*The provider holds less than this right now\./.test(await text(page, '#a-rcpt')) && !(await page.$eval('#a-go', (e) => e.disabled)), 'a note from the provider is shown and does not stop the swap');
  await atom(page, '(A.warn = false, 0)');

  console.log('the lane: a quote that cannot be read is tried again by itself');
  const goText = () => text(page, '#a-go');
  await atom(page, '(A.failN = 2, A.calls.quote.length = 0, 0)');
  await page.fill('#a-amt', '0.014');
  await sleep(700);
  ok(/Getting a quote/.test(await goText()) && !(await text(page, '#a-q')).trim(), 'a first miss says it is getting a quote, with no error text');
  await page.waitForFunction(() => /^Swap /.test(document.querySelector('#a-go').textContent), null, { timeout: 12000 });
  ok(!(await text(page, '#a-q')).trim() && (await atom(page, 'A.calls.quote.length')) === 3 && !(await page.$eval('#a-go', (e) => e.disabled)), 'two misses, then the quote is shown with no error and no press');
  await atom(page, '(A.failN = 999, 0)');
  await page.fill('#a-amt', '0.0141');
  await page.waitForFunction(() => /^Try again$/.test(document.querySelector('#a-go').textContent), null, { timeout: 15000 });
  ok(/Can't reach the provider right now/.test(await text(page, '#a-q')) && !/No quote/.test(await goText()), 'a persistent miss ends with the plain line and a Try again button');
  await atom(page, '(A.failN = 0, 0)');
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap /.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok(!(await text(page, '#a-q')).trim(), 'Try again asks at once and the quote is shown');

  console.log('the lane: a swap that several providers fill');
  await atom(page, '(A.mode = "split", 0)');
  await type(page, '0.015');
  await page.waitForFunction(() => /Best price across 3 providers/.test(document.querySelector('#a-rcpt').textContent), null, { timeout: 5000 });
  const sr = await text(page, '#a-rcpt');
  ok(/Providers\s*Best price across 3 providers/.test(sr) && /Alpha\s*0\.005 BTC → 0\.152 ETH/.test(sr) && /Charlie\s*0\.005 BTC → 0\.152 ETH/.test(sr), `the plan is shown before the press: each provider, what it is given and what it pays out (${sr.slice(0, 260)})`);
  ok(/One provider\s*none can take this much/.test(sr) && /Bitcoin network fee\s*≈ 1,200 sats for all parts/.test(sr), 'and that no one provider takes it, and one fee for the one transaction');
  ok(/^Swap BTC → ETH$/.test(await text(page, '#a-go')) && !(await page.$eval('#a-go', (e) => e.disabled)), 'the button is as it is for one provider');
  await SHOT(page, 'lane-split-quote');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length >= 1, null, { timeout: 5000 });
  ok((await atom(page, 'A.calls.start.at(-1).split.legs.length')) === 3, 'one press starts the split with its three legs');
  await sleep(500);
  // the one card: three parts inside, one time, and what became of each part said by itself
  const leg = (id, provider, state, title, detail, o = {}) => ({ id, provider, state, title, detail, pay: 500000n, get: 15200000n, got: null, refundAt: null, steps: [], etaSecs: 0, k: 0, ...o });
  await atom(page, `(A.recs = [{ id: 'batch:b1', dir: 'b2e', state: 'working', title: 'Swapping across 3 providers', detail: '3 parts from one Bitcoin transaction. Each part is a swap of its own.', pay: 1500000n, get: 45600000n, steps: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'].map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: i === 0 ? 'done' : i === 1 ? 'active' : 'todo' })), etaSecs: 700, at: Math.floor(Date.now() / 1000), refundAt: Math.floor(Date.now() / 1000) + 86000, lockTxid: null, error: null, provider: '3 providers', backBy: null, batch: { id: 'b1', n: 3, legs: [${[['l0', 'Alpha', 'done', 'Done', 'The ETH is in your private balance.', ', got: 15200000n'], ['l1', 'Bravo', 'working', 'Returning your BTC', 'The lock returns to your Bitcoin address when its timelock ends.', ', refundAt: Math.floor(Date.now() / 1000) + 80000'], ['l2', 'Charlie', 'working', 'Waiting for Bitcoin', 'Your lock waits for a Bitcoin block.', '']].map(([i, p, st, t, d, o]) => `{ id: '${i}', provider: '${p}', state: '${st}', title: '${t}', detail: '${d}', pay: 500000n, get: 15200000n, got: null, refundAt: null, steps: [], etaSecs: 0, k: 0 ${o} }`).join(', ')}] } }], 0)`);
  await page.waitForFunction(() => /Swapping across 3 providers/.test(document.querySelector('#a-sent').textContent), null, { timeout: 9000 });
  ok((await page.$$('#a-sent [data-rec]')).length === 1 && (await page.$$('#a-sent details.legs li')).length === 3, 'the three swaps are one card with three parts folded inside');
  ok(/0\.015 BTC → about 0\.456 ETH/.test(await text(page, '#a-sent')), `the card says the total it pays and gets (${(await text(page, '#a-sent')).slice(0, 200)})`);
  await page.click('#a-sent details.legs summary');
  const lt = await text(page, '#a-sent details.legs');
  ok(/Alpha 0\.005 BTC → 0\.152 ETH/.test(lt) && /Bravo[^]*The lock returns to your Bitcoin address when its timelock ends/.test(lt) && /Charlie[^]*Waiting for Bitcoin/.test(lt), `each part says what became of it, the returning one plainly (${lt.slice(0, 300)})`);
  await SHOT(page, 'lane-split-card');
  await atom(page, "(A.recs = [], A.mode = \"ok\", A.calls.start.length = 0, 0)");
  await page.waitForFunction(() => !document.querySelector('#a-sent [data-rec]'), null, { timeout: 9000 }).catch(() => {});

  console.log('the lane: more than is held, the fee, flipping');
  await type(page, '0.6');
  ok(/^Add 0\.100012 BTC$/.test(await text(page, '#a-go')) && !(await page.$eval('#a-go', (e) => e.disabled)), `more than the balance offers to add what is short, the quote's Bitcoin fee with it (${await text(page, '#a-go')})`);
  await page.click('#a-go');
  ok(await page.evaluate(() => window.__btc.funds === 1 && window.__btc.fundAsk && window.__btc.fundAsk.sats === 10001200 && window.__btc.fundAsk.need === 60001200), 'and pressing it asks the wallet for that many sats, and the total the address must hold');
  await page.fill('#a-amt', '');
  await page.click('#a-quick button:last-child');
  const mx = parseFloat(await page.inputValue('#a-amt'));
  ok(/Max/.test(await text(page, '#a-quick')) && mx > 0.4999 && mx < 0.5, `Max fills the balance less something for the Bitcoin fee (${mx})`);
  await page.click('#a-flip');
  ok(/From.*Ethereum, private/.test(await text(page, '#a-pay')) && /To.*Bitcoin/.test(await text(page, '#a-get')) && /Balance 4 ETH/.test(await text(page, '#a-bal')), 'the flip turns the lane: ETH from the private balance (4 ETH), BTC to Bitcoin');
  ok((await page.inputValue('#a-amt')) === '' && (await page.$eval('#a-pay-coin use', (u) => u.getAttribute('href'))) === '#tk-teth' && (await page.$eval('#a-get-coin use', (u) => u.getAttribute('href'))) === '#tk-btc', 'the amount is cleared and the marks have changed sides');
  ok(/from=ETH/.test(page.url()) && /to=BTC/.test(page.url()) && /to-at=btc/.test(page.url()), `the address follows (${page.url()})`);
  await type(page, '1');
  const q2 = (await atom(page, 'A.calls.quote')).at(-1);
  ok(q2.dir === 'e2b' && q2.amount === '100000000', `a quote for e2b is asked in pool units (1 ETH = 100,000,000) (${JSON.stringify(q2)})`);
  ok(/Effective rate\s*1 ETH = 0\.03289 BTC/.test(await text(page, '#a-rcpt')) && /If it stops\s*ETH returns/.test(await text(page, '#a-rcpt')) && /Bitcoin network fee\s*≈ 500 sats, taken from your BTC/.test(await text(page, '#a-rcpt')), 'ETH to BTC is priced per ETH, says where the ETH goes if it stops, and names the fee of taking the Bitcoin');
  const getNow = parseFloat(await text(page, '#a-out')), want = Number((await atom(page, 'A.calls.quotes.at(-1).get')) - 500n) / 1e8;
  ok(Math.abs(getNow - want) < 1e-9, `the amount shown is what arrives, the lock less the fee of taking it (${getNow} = ${want})`);
  await type(page, '5');
  await page.waitForFunction(() => /^Swap 5 ETH → BTC$/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/^Swap 5 ETH → BTC$/.test(await text(page, '#a-go')) && (await page.$eval('#a-go', (e) => e.dataset.act)) === 'oneclick', 'the card passes the same Add ETH as /btc/: more than the private balance is one press that adds the shortfall and swaps ('+await text(page, '#a-go')+')');
  await page.click('#a-flip');

  console.log('starting: once, with the quote shown');
  await type(page, '0.01');
  await page.waitForFunction(() => !document.querySelector('#a-go').disabled);
  await atom(page, '(A.pumpMs = 2500, 0)');                        // (the pass that steps a started swap can take long: the swap is on the page all the while)
  await page.dblclick('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length >= 1, null, { timeout: 5000 });
  await sleep(600);
  await type(page, '1');                                            // a repaint while the pass runs
  ok(/Waiting for Bitcoin/.test(await text(page, '#a-sent')), `a repaint between the start and the stepping pass keeps the started swap listed (${(await text(page, '#a-sent')).slice(0, 80)})`);
  await page.fill('#a-amt', ''); await atom(page, '(A.pumpMs = 0, 0)'); await sleep(2500);
  const starts = await atom(page, 'A.calls.start.length'), same = await atom(page, 'A.calls.start[0] === A.calls.quotes.at(-1) || A.calls.quotes.includes(A.calls.start[0])');
  ok(starts === 1 && same, `two presses start one swap, with the very quote that was shown (starts ${starts})`);
  ok(/Waiting for Bitcoin/.test(await text(page, '#a-sent')) && /0\.01 BTC → about 0\.304 ETH/.test(await text(page, '#a-sent')) && (await page.inputValue('#a-amt')) === '', 'the swap is listed with what it pays and gets, and the form is cleared');
  ok((await page.$$('#a-sent .stp li')).length === 4 && (await page.$$('#a-sent .stp li.active')).length === 1 && (await page.$$('#a-sent .stp li.todo')).length === 3, 'four steps, the first under way');
  ok(/If it stops, your BTC returns in 2[34] h/.test(await text(page, '#a-sent')), `it says when the user's own refund opens (${(await text(page, '#a-sent')).slice(0, 220)})`);
  await SHOT(page, 'lane-working');
  ok(await page.evaluate(() => !!(document.querySelector('#a-go').compareDocumentPosition(document.querySelector('#a-sent')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'in the card the swaps sit under the button (a list of past swaps never pushes the button out of sight)');
  await atom(page, '(A.advance("sw1", 2, "working", "Claiming your ETH"), 0)');
  await page.waitForFunction(() => /Claiming your ETH/.test(document.querySelector('#a-sent').textContent), null, { timeout: 9000 });
  ok((await page.$$('#a-sent .stp li.done')).length === 2 && (await page.$$('#a-sent .stp li.active')).length === 1, 'a step further on: two done, one under way (the lane follows the swap on its own)');
  const pumps = await atom(page, 'A.calls.pump');
  ok(pumps >= 2, `the swaps are stepped again while the lane is open (${pumps} passes)`);
  await atom(page, '(A.advance("sw1", 4, "done", "Done"), 0)');
  await page.waitForFunction(() => document.querySelector('#a-sent .ok'), null, { timeout: 9000 });
  ok((await page.$$('#a-sent .stp li.done')).length === 4 && /Done/.test(await text(page, '#a-sent .ok')) && !/If it stops/.test(await text(page, '#a-sent')), 'done: four steps, the swap marked as done, no refund line');
  ok(await page.$('#a-sent [data-dismiss]') !== null, 'a finished swap can be dismissed');
  // a second swap, which the provider then does not complete: its own lock is returned
  await type(page, '0.02');
  await page.waitForFunction(() => !document.querySelector('#a-go').disabled);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 2 && document.querySelectorAll('#a-sent > div').length === 2, null, { timeout: 5000 });
  await atom(page, '(A.advance("sw2", 1, "returned", "Returned"), 0)');
  await page.waitForFunction(() => /Returned/.test(document.querySelector('#a-sent').textContent), null, { timeout: 9000 }).catch(() => {});
  ok(/Returned/.test(await text(page, '#a-sent')) && !!(await page.$('#a-sent .warn')) && !!(await page.$('#a-sent .ok')), 'a returned swap says so and is marked apart from a done one');
  ok(/Your coins came back\./.test(await text(page, '#a-sent .warn')) && (await page.$$('#a-sent .warn .stp li.done')).length === 1 && !/If it stops/.test(await text(page, '#a-sent .warn')), 'with its own words, its lock as the one step done, and no refund line');
  await SHOT(page, 'lane-done');
  await page.click('#a-sent .warn [data-dismiss]');
  ok(!/Returned/.test(await text(page, '#a-sent')) && /Done/.test(await text(page, '#a-sent')), 'dismissing removes that swap and no other');
  // a third swap is under way when the lane is left: nothing is stepped after that
  await type(page, '0.03');
  await page.waitForFunction(() => !document.querySelector('#a-go').disabled);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 3 && document.querySelectorAll('#a-sent > div.wait').length === 1, null, { timeout: 5000 });
  await page.click('[data-mode=wallet]');
  ok(await page.isVisible('#f-pay') && !(await page.isVisible('#atomic')) && !/from=BTC|to-at=btc/.test(page.url()), 'back to the wallet: the card returns and the address is clean');
  const p1 = await atom(page, 'A.calls.pump');
  await sleep(6500);
  ok((await atom(page, 'A.calls.pump')) === p1, 'with the lane hidden nothing is stepped, even a swap that is still under way');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('the Bitcoin fee: the sats cover the amount but not the fee');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  await atom(page, '(A.bal.sats = 1000200n, 0)');                              // 0.010002 BTC, the quote's fee is 1,200 sats
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance 0\.010002 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.01');
  await page.waitForFunction(() => /Add BTC for the fee/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), 'when the amount is held but not the fee, the button offers to add sats');
  await page.click('#a-go');
  ok((await page.evaluate(() => window.__btc.funds)) === 1 && (await atom(page, 'A.calls.start.length')) === 0, 'and pressing it opens the way to add them, starting nothing');
  await page.close();
}

console.log('a failed start, and the key not open');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && /Balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await atom(page, '(A.failStart = true, 0)');
  await type(page, '0.01');
  await page.waitForFunction(() => !document.querySelector('#a-go').disabled);
  await page.click('#a-go');
  await page.waitForFunction(() => /The provider cannot hold that amount\./.test(document.querySelector('#a-q').textContent), null, { timeout: 5000 });
  ok((await page.$eval('#a-q', (e) => e.classList.contains('err'))) && (await atom(page, 'A.calls.start.length')) === 1 && !(await page.$eval('#a-go', (e) => e.disabled)), 'a start the provider refuses is said in its words, nothing is listed, and the button is ready again');
  ok((await page.inputValue('#a-amt')) === '0.01' && (await page.$('#a-sent:not([hidden])')) === null, 'the amount stays so that it can be tried again');
  await page.close();
}

console.log('the wallet locks, and another key opens in the same tab');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && /Balance 0\.5 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.01');
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelectorAll('#a-sent [data-rec]').length === 1, null, { timeout: 8000 });
  await page.evaluate(() => window.__btc.lock());
  await page.waitForFunction(() => /Sign in to swap/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  const pumps = await atom(page, 'A.calls.pump');
  ok(/Open the same Tacit wallet again to finish it/.test(await text(page, '#a-q')), `a swap under way when the wallet locks: the page asks for the same wallet again (${await text(page, '#a-q')})`);
  ok((await page.$$('#a-sent [data-rec]')).length === 0 && (await text(page, '#a-bal')) === '' && (await text(page, '#a-out')) === '0', 'the locked wallet\'s swaps, balance and quote are no longer shown');
  await sleep(6500);
  ok((await atom(page, 'A.calls.pump')) === pumps, 'and its swaps are not stepped while it is locked');
  await atom(page, '(A.bal.sats = 70000000n, 0)');
  await page.evaluate(() => window.__btc.openAs('02' + 'cd'.repeat(32)));
  await page.waitForFunction(() => /Balance 0\.7 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  const opened = await atom(page, 'A.opened');
  ok(opened.length === 2 && opened[1].pubHex === '02' + 'cd'.repeat(32), `another key opens its own pair client (${opened.map((o) => o.pubHex.slice(0, 6)).join(', ')})`);
  ok(/Open the same Tacit wallet again|Open that wallet again/.test(await text(page, '#a-q')), `the page still says the other wallet has a swap to finish (${await text(page, '#a-q')})`);
  await page.evaluate(() => window.__btc.openAs('02' + 'ef'.repeat(32)));
  await page.waitForFunction(() => window.__atom.opened.length === 3, null, { timeout: 8000 });
  ok((await atom(page, 'A.opened.at(-1).pubHex')) === '02' + 'ef'.repeat(32), 'a key that replaces the open one without a lock gets its own pair client too');
  await page.close();
}

console.log('a quote near its end is renewed before a press, and a renewed quote that gives less is accepted first');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && /Balance 0\.5 BTC/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await atom(page, '(A.ttl = 120, 0)');
  await type(page, '0.01');
  ok((await text(page, '#a-out')) === '0.304', 'a quote with two minutes left is shown');
  const asked = (await atom(page, 'A.calls.quote')).length;
  await atom(page, '(A.ttl = 300, A.cut = true, 0)');
  await page.click('#a-go');
  await page.waitForFunction(() => /Accept the new price/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok((await atom(page, 'A.calls.start.length')) === 0 && (await atom(page, 'A.calls.quote')).length === asked + 1, 'a press on it asks for a new quote first, and starts nothing');
  ok(/New quote gives less: 0\.304 → 0\.30096 ETH/.test(await text(page, '#a-q')) && (await text(page, '#a-out')) === '0.30096', `the new numbers are shown and said (${await text(page, '#a-q')})`);
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap BTC → ETH$/.test(document.querySelector('#a-go').textContent.trim()), null, { timeout: 5000 });
  ok((await atom(page, 'A.calls.start.length')) === 0, 'accepting them starts nothing by itself');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 1, null, { timeout: 5000 });
  ok((await atom(page, 'String(A.calls.start[0].get)')) === '30096000', 'the next press starts the accepted quote');
  await page.close();
}

console.log('a provider that cannot hold its quote: a new quote is asked for and shown before anything starts');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && /Balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.01');
  await atom(page, '(A.failStart = "requote", 0)');
  const asked = (await atom(page, 'A.calls.quote')).length;
  await page.click('#a-go');
  await page.waitForFunction((n) => window.__atom.calls.quote.length > n && /^Swap BTC → ETH$/.test(document.querySelector('#a-go').textContent.trim()), asked, { timeout: 5000 });
  ok(/a new quote is being asked for/.test(await text(page, '#a-q')) && (await atom(page, 'A.calls.start.length')) === 1, `the refusal is said, a new quote is shown, and nothing more is started (${await text(page, '#a-q')})`);
  await page.close();
}

console.log('a Bitcoin fee that is a large share of the amount is accepted before a swap starts');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  await page.click('#a-go');
  await page.waitForFunction(() => window.__btc.unlocked && /Balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await atom(page, '(A.highFee = true, 0)');
  await type(page, '0.01');
  await page.waitForFunction(() => /Accept the fee/.test(document.querySelector('#a-go').textContent), null, { timeout: 5000 });
  ok(/Network fee ≈ 1,200 sats \(12\.0% of the amount/.test(await text(page, '#a-q')), `the fee and its share are said (${await text(page, '#a-q')})`);
  await page.click('#a-go');
  await page.waitForFunction(() => /^Swap BTC → ETH$/.test(document.querySelector('#a-go').textContent.trim()), null, { timeout: 5000 });
  ok((await atom(page, 'A.calls.start.length')) === 0, 'accepting it starts nothing by itself');
  await page.click('#a-go');
  await page.waitForFunction(() => window.__atom.calls.start.length === 1, null, { timeout: 5000 });
  ok((await atom(page, 'A.calls.start[0].feeAccepted')) === true, 'the swap starts with the fee accepted');
  await page.close();
}

console.log('links, the address and a reload');
{
  const { page } = await fresh({ path: '/swap/?from=ETH&to=BTC&to-at=btc&amt=0.05', ads: [ad()] });
  await laneUp(page);
  await page.waitForSelector('#a-go');
  ok(await page.isVisible('#atomic') && /From.*Ethereum, private/.test(await text(page, '#a-pay')), 'a link for ETH to BTC opens the lane that way round once the provider is read');
  ok((await page.inputValue('#a-amt')) === '0.05', 'with its amount');
  await page.waitForFunction(() => /from=ETH/.test(location.search) && /amt=0\.05/.test(location.search));
  const url = page.url();
  ok(/to=BTC/.test(url) && /to-at=btc/.test(url) && /amt=0\.05/.test(url), `the address keeps the lane (${url})`);
  await page.close();
  const again = await fresh({ path: url.replace(BASE, ''), ads: [ad()] });
  await laneUp(again.page); await again.page.waitForSelector('#a-go');
  ok(await again.page.isVisible('#atomic') && (await again.page.inputValue('#a-amt')) === '0.05' && /From.*Ethereum/.test(await text(again.page, '#a-pay')), 'a reload at that address returns to the lane');
  await again.page.close();
  const lnk = await fresh({ path: '/swap/?from=BTC&to=ETH', ads: [ad()] });
  await laneUp(lnk.page); await lnk.page.waitForSelector('#a-go');
  ok(await lnk.page.isVisible('#atomic') && /From.*Bitcoin/.test(await text(lnk.page, '#a-pay')), 'a link for BTC to ETH opens it too');
  await lnk.page.close();
}

console.log('a host that loads another link while the lane is open');
{
  const { page } = await fresh({ ads: [ad()] });
  await open(page);
  ok(await page.evaluate(() => window.__card.atomic === true && window.__card.atomicAvailable === true), 'the card says the lane is open and available');
  await page.evaluate(() => window.__card.load(new URLSearchParams('from=ETH&to=BTC&amt=0.07')));
  await page.waitForFunction(() => document.querySelector('#a-amt').value === '0.07');
  ok(await page.isVisible('#atomic') && /From.*Ethereum, private/.test(await text(page, '#a-pay')), 'a link for the same pair the other way turns the open lane and fills its amount, and keeps it open');
  await page.evaluate(() => window.__card.load(new URLSearchParams('from=ETH&to=TAC&amt=0.5')));
  ok(!(await page.isVisible('#atomic')) && await page.isVisible('#f-pay') && (await page.getAttribute('[data-mode=wallet]', 'aria-checked')) === 'true' && (await page.getAttribute('[data-mode=atomic]', 'aria-checked')) === 'false', 'a link for something else closes the lane and shows the card');
  ok(await page.evaluate(() => window.__card.atomic === false) && !/from=BTC|to=BTC|to-at=btc|from-at=btc/.test(page.url()), 'and the address is the card\'s again');
  await page.evaluate(() => window.__card.setAtomic(true));
  ok(await page.isVisible('#atomic'), 'the card can be asked to open the lane');
  await page.evaluate(() => window.__card.load(new URLSearchParams()));
  ok(!(await page.isVisible('#atomic')), 'and a plain load of the card leaves it');
  await page.close();
}

console.log('the front page: its card keeps the switch out of sight, so the lane\'s shows with Ethereum alone');
{
  const none = await fresh({});
  await probed(none.page);
  await none.page.evaluate(() => document.querySelector('#p-swap').classList.add('mv'));
  ok((await none.page.$eval('.mode', (e) => getComputedStyle(e).display)) === 'none', 'with no provider the switch stays out of sight there, as it was');
  await none.page.close();
  const yes = await fresh({ ads: [ad()] });
  await laneUp(yes.page);
  await yes.page.evaluate(() => document.querySelector('#p-swap').classList.add('mv'));
  const disp = await yes.page.$$eval('.mode button', (els) => Object.fromEntries(els.map((e) => [e.dataset.mode, getComputedStyle(e).display])));
  ok((await yes.page.$eval('.mode', (e) => getComputedStyle(e).display)) !== 'none' && disp.bitcoin === 'none' && disp.atomic !== 'none' && disp.wallet !== 'none', `with a provider it shows Ethereum and the lane, and not the Bitcoin switch that card reaches by its places (${JSON.stringify(disp)})`);
  await yes.page.close();
}

console.log('the words: durations, the market, errors, the probe');
{
  const { page } = await fresh({ ads: [ad()] });
  await laneUp(page);
  await page.click('[data-mode=atomic]');
  await page.waitForSelector('#a-go');
  const r = await page.evaluate(async (adJson) => {
    const m = await import('/swap/atomic.js'), now = 1_800_000_000, out = {};
    out.eta = [m.etaText(30), m.etaText(60), m.etaText(780), m.etaText(7200)];
    out.until = [m.untilText(now + 5 * 3600 + 7 * 60, now), m.untilText(now + 40 * 60, now), m.untilText(now - 5, now), m.untilText(now + 3 * 86400, now)];
    out.market = [m.marketText(-72), m.marketText(0), m.marketText(150), m.marketText(-1200), m.marketText(NaN)];
    out.rate = [m.rateText(30.4), m.rateText(304), m.rateText(30.123456)];
    out.err = [m.plainError(new TypeError("Cannot read properties of undefined")), m.plainError(new Error('No provider can take that amount.')), m.plainError(new Error('Failed to fetch')), m.plainError('the quote ran out'), m.plainError(new Error('x'.repeat(300))), m.plainError('TypeError: x is not a function'), m.plainError('[object Object]'),
      m.plainError('send 0.1 BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh to unlock your swap'), m.plainError('see https://example.com'), m.plainError('<b>x</b>')];
    out.fmt = [m.fmt(1n), m.fmt(100000000n), m.fmt(30400000n)];
    const p = await import('/swap/atomic-probe.js'), lists = { boards: ['https://b.example'], providers: [] };
    const on = (f) => p.probeAtomic({ lists, fetchImpl: f, now: () => Math.floor(Date.now() / 1000) });
    const j = (v) => async () => ({ ok: true, json: async () => v });
    out.probe = {
      none: await p.probeAtomic({ lists: { boards: [], providers: [] }, fetchImpl: async () => { throw new Error('no reads expected'); } }),
      other: await on(j({ ads: [{ ...adJson, btcAsset: 'f0'.repeat(32) }] })),
      signed: await on(j({ ads: [adJson] })),
      down: await on(async () => { throw new Error('offline'); }),
      bad: await on(async () => ({ ok: false, json: async () => ({}) })),
      otherToken: await on(j({ ads: [{ ...adJson, evmAsset: 'f0'.repeat(32) }] })),
      http: await p.probeAtomic({ lists: { boards: [], providers: [{ base: 'https://p.example' }] }, fetchImpl: j({ btcAsset: '0x' + '00'.repeat(32), evmAsset: '0x' + p.ETH_ASSET_ID }) }),
      httpOther: await p.probeAtomic({ lists: { boards: [], providers: [{ base: 'https://p.example' }] }, fetchImpl: j({ btcAsset: '00'.repeat(32), evmAsset: 'f0'.repeat(32) }) }),
      insecure: await p.probeAtomic({ lists: { boards: ['http://b.example'], providers: [{ base: 'http://p.example' }] }, fetchImpl: j({ ads: [adJson], btcAsset: '00'.repeat(32), evmAsset: p.ETH_ASSET_ID }) }),
    };
    // a board that names the pair is enough: the provider's own address is not read while it is there, and is read when no board names the pair
    const first = [], later = [], clock = () => Math.floor(Date.now() / 1000), both = { boards: ['https://b.example'], providers: [{ base: 'https://p.example' }] };
    out.probe.boardFirst = await p.probeAtomic({ lists: both, now: clock, fetchImpl: async (u) => { first.push(String(u)); return String(u).endsWith('/ads') ? { ok: true, json: async () => ({ ads: [adJson] }) } : { ok: false, json: async () => ({}) }; } });
    out.firstReads = first;
    out.probe.fallback = await p.probeAtomic({ lists: both, now: clock, fetchImpl: async (u) => { later.push(String(u)); return { ok: true, json: async () => (String(u).endsWith('/ads') ? { ads: [] } : { btcAsset: '00'.repeat(32), evmAsset: p.ETH_ASSET_ID }) }; } });
    out.laterReads = later;
    out.sats = p.SATS_ASSET_ID; out.eth = p.ETH_ASSET_ID;
    return out;
  }, ad());
  ok(JSON.stringify(r.eta) === JSON.stringify(['about 1 min', 'about 1 min', 'about 13 min', 'about 2 h']), `durations in words (${JSON.stringify(r.eta)})`);
  ok(JSON.stringify(r.until) === JSON.stringify(['in 5 h 7 min', 'in 40 min', 'now', 'in 3 days']), `refund times in words (${JSON.stringify(r.until)})`);
  ok(JSON.stringify(r.market) === JSON.stringify(['0.72% less than the market price', 'at the market price', '1.50% more than the market price', '12.0% less than the market price', null]), `the market comparison (${JSON.stringify(r.market)})`);
  ok(JSON.stringify(r.rate) === JSON.stringify(['1 BTC = 30.4 ETH', '1 BTC = 304 ETH', '1 BTC = 30.123 ETH']), `rates (${JSON.stringify(r.rate)})`);
  ok(r.err[0] === 'No answer just now. Nothing was sent. Try again soon.' && r.err[1] === 'No provider can take that amount.' && r.err[2] === r.err[0] && r.err[3] === 'The quote ran out.' && r.err[4] === r.err[0] && r.err[5] === r.err[0] && r.err[6] === r.err[0], `errors: an engine sentence stays, an exception's own words never show (${JSON.stringify(r.err)})`);
  ok(r.err.slice(7).every((x) => x === 'The provider could not do that. Nothing was sent. Try again soon.'), `errors: a line that names an address, a link or markup is not said (${JSON.stringify(r.err.slice(7))})`);
  ok(JSON.stringify(r.fmt) === JSON.stringify(['0.00000001', '1', '0.304']), `amounts have eight places and no trailing zeros (${JSON.stringify(r.fmt)})`);
  ok(r.probe.none === false && r.probe.other === false && r.probe.otherToken === false && r.probe.signed === true && r.probe.down === false && r.probe.bad === false && r.probe.http === true && r.probe.httpOther === false, `the probe: no list, another pair, sats against another token, a signed ad of the pair, a board down, a board that errs, and a provider that serves its own terms ${JSON.stringify(r.probe)}`);
  ok(r.probe.insecure === false, 'a board or provider that is not https is not read');
  ok(r.probe.boardFirst === true && r.firstReads.some((u) => u === 'https://b.example/ads') && !r.firstReads.some((u) => u.endsWith('/info')), `the probe: a board that names the pair is enough, and the provider's own address is not read (${r.firstReads.join(' ')})`);
  ok(r.probe.fallback === true && r.laterReads.includes('https://p.example/info'), `and the provider's own address is read when no board names the pair (${r.laterReads.join(' ')})`);
  ok(r.sats === SATS, 'the probe\'s asset id is plain sats (64 zeros, adaptor-xswap.js SATS_ASSET)');
  ok(r.eth === ETH, 'and the pool\'s ETH is the pair\'s other side (fastbridge-pair.js ETH_ASSET)');
  await page.close();
}

console.log('a phone width, and the dark scheme');
{
  const { page } = await fresh({ ads: [ad()], viewport: { width: 390, height: 900 }, scheme: 'dark' });
  await open(page);
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.01');
  await page.waitForFunction(() => !document.querySelector('#a-go').disabled);
  await page.click('#a-go');
  await page.waitForFunction(() => document.querySelector('#a-sent .stp li'), null, { timeout: 5000 });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  ok(!wide, 'no sideways scroll at 390 px');
  const st = await page.$eval('#a-sent .stp', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  ok(st === 2, `the four steps fall into two columns on a phone (${st})`);
  await SHOT(page, 'lane-phone-dark');
  await page.close();
}

// what the wallet holds against what it can put in, and coins that have not confirmed
{
  console.log('\nbalances: held and spendable, and sats that are confirming');
  const { page } = await fresh({ ads: [ad()] });
  await laneUp(page);
  await page.evaluate(() => { const A = window.__atom; A.bal = { sats: 0n, eth: 819639n, ethHeld: 847639n, pendingSats: 29162n }; A.providers[0].e2b.min = 100000n; });
  await page.click('[data-mode=atomic]');
  await page.waitForFunction(() => document.querySelector('#a-go'));
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  ok((await text(page, '#a-bal')) === 'Balance 0 BTC · 0.00029162 BTC confirming', `a deposit that waits for a block is said, not hidden (${await text(page, '#a-bal')})`);
  ok(/Balance 0\.00847639 ETH/.test(await text(page, '#a-get-bal')), `what the wallet holds is the balance shown on the receiving side (${await text(page, '#a-get-bal')})`);
  await page.click('#a-flip');
  ok((await text(page, '#a-bal')) === 'Balance 0.00847639 ETH', `the balance is what the wallet holds, not what is left after the relay fee (${await text(page, '#a-bal')})`);
  await page.fill('#a-amt', '0.0083');
  await page.waitForFunction(() => /^Swap 0\.0083 ETH/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(/^Swap 0\.0083 ETH → BTC$/.test(await text(page, '#a-go')) && (await page.$eval('#a-go', (e) => e.dataset.act)) === 'oneclick', `more than can be locked, but less than is held, is the one press that adds the rest (${await text(page, '#a-go')})`);
  await page.fill('#a-amt', '0.009');
  await page.waitForFunction(() => /^Swap 0\.009 ETH/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(/^Swap 0\.009 ETH → BTC$/.test(await text(page, '#a-go')), 'more than is held is the one-press Add ETH swap, as on /btc/');
  ok((await page.$eval('#a-go', (e) => e.dataset.act)) === 'oneclick', 'on the card, the lane has Add ETH, as /btc/ does');
  // the card's lane has the page's "Receive as" for a swap of BTC (btc/payout.js), and a finished swap's next steps open the page that has the panels
  await page.click('#a-flip');
  await page.fill('#a-amt', '0.001');
  await page.waitForFunction(() => document.querySelector('#a-payto') && !document.querySelector('#a-payto').hidden, null, { timeout: 8000 }).catch(() => {});
  ok(/Receive as/.test(await text(page, '#a-payto')) && /Another Ethereum address/.test(await text(page, '#a-payto')), 'on the card, a swap of BTC asks "Receive as", as /btc/ does');
  await page.click('#a-flip');
  await page.fill('#a-amt', '0.008');
  await page.waitForFunction(() => /^Swap/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), 'an amount that fits can be swapped');
  await SHOT(page, 'lane-held-confirming');
  await page.close();
}

// a provider that holds less than its own minimum
{
  console.log('\nno provider has enough to swap');
  const { page } = await fresh({ ads: [ad()] });
  await laneUp(page);
  await page.evaluate(() => { const A = window.__atom; A.providers[0].b2e.available = 1000n; });
  await page.click('[data-mode=atomic]');
  await page.waitForFunction(() => document.querySelector('#a-go'));
  await page.click('#a-go');
  await page.waitForFunction(() => /Balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await page.fill('#a-amt', '0.001');
  await page.waitForFunction(() => /No provider has enough/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(await page.$eval('#a-go', (e) => e.disabled), 'a provider with less than its minimum says so, and the button is off');
  ok(!/Minimum|Maximum/.test(await text(page, '#a-go')), 'it does not name a minimum nobody can meet');
  await page.close();
}

// a balance the explorers do not answer for is said, and read again
{
  console.log('\na balance that cannot be read');
  const { page } = await fresh({ ads: [ad()] });
  await laneUp(page);
  await page.evaluate(() => { const A = window.__atom; A.bal = { sats: null, eth: 400000000n }; });
  await page.click('[data-mode=atomic]');
  await page.waitForFunction(() => document.querySelector('#a-go'));
  await page.click('#a-go');
  await page.waitForFunction(() => /not read yet/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  ok(/BTC balance not read yet: trying again/.test(await text(page, '#a-bal')), `an unanswered Bitcoin balance is said, not left reading (${await text(page, '#a-bal')})`);
  await page.fill('#a-amt', '0.001');
  await page.waitForFunction(() => /Read the balance again/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), `with an amount, the button offers to read the balance again, not to swap (${await text(page, '#a-go')})`);
  await page.evaluate(() => { window.__atom.bal = { sats: 50000000n, eth: 400000000n }; });
  await page.click('#a-go');
  await page.waitForFunction(() => /Swap BTC → ETH/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(/Balance 0\.5 BTC/.test(await text(page, '#a-bal')), `the press reads it again, and the swap is offered once it is known (${await text(page, '#a-bal')})`);
  await page.close();
}

// a balance still being read: the button waits for it, and no swap is offered against an amount not known to be there
{
  console.log('\na balance still being read');
  const { page } = await fresh({ ads: [ad()] });
  await laneUp(page);
  await page.evaluate(() => { const A = window.__atom, real = A.pair.balances; A.pair.balances = () => new Promise((r) => { A.release = () => { A.pair.balances = real; r({ sats: 50000000n, eth: 400000000n }); }; }); });
  await page.click('[data-mode=atomic]');
  await page.waitForFunction(() => document.querySelector('#a-go'));
  await page.click('#a-go');
  await page.waitForFunction(() => /Reading your balance/.test(document.querySelector('#a-bal').textContent), null, { timeout: 8000 });
  await page.fill('#a-amt', '0.001');
  await page.waitForFunction(() => window.__atom.calls.quote.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(500);
  ok(/Reading your balance/.test(await text(page, '#a-go')) && (await page.$eval('#a-go', (e) => e.disabled)), `with a quote in and the balance not read, the button waits (${await text(page, '#a-go')})`);
  await page.evaluate(() => window.__atom.release());
  await page.waitForFunction(() => /Swap BTC → ETH/.test(document.querySelector('#a-go').textContent), null, { timeout: 8000 });
  ok(!(await page.$eval('#a-go', (e) => e.disabled)), 'once the balance is read, the swap is offered');
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
