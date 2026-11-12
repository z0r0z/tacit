#!/usr/bin/env node
// What the front page's "Your Tacit" tiles (dapp/index.html dashItems) show of what a key holds at its own Bitcoin address, in a real browser under the
// page's own CSP, with a pasted key. The Bitcoin read is the page's own (loadBtc -> scanHoldings) with the holdings the scan would return put in its place
// (tacit.js has a hook for it, and this test appends the line that reaches it); the Bitcoin address's coins are answered here and every other host refused:
//   · TAC held on Bitcoin has a tile of its own, "TAC · on Bitcoin", as FAIR (a token the page has not met) does, and so has tETH: neither is a clause
//     tucked into the BTC tile's one line, where a long amount was cut off;
//   · the BTC tile is BTC alone ("at your Bitcoin address"), and is not shown for a key that holds no coin (only TAC);
//   · the tiles come after BTC, and the Wallet sheet lists the same TAC once.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/dash-bitcoin-tac.mjs      (DAPP=<dir> to try another build)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
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
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', FAIR = 'fa'.repeat(32);
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const COIN = [{ txid: 'aa'.repeat(32), vout: 0, value: 250000, status: { confirmed: true, block_height: 900000, block_time: 1700000000 } }];
const TACIT_JS = readFileSync(join(DAPP, 'tacit.js'), 'utf8') + '\n_testSetScanHoldingsOverride(() => (globalThis.__held ? globalThis.__held() : new Map()));\n';

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
// a fresh browser context (so no earlier visit's tiles are remembered) with the key opened and the Bitcoin address read; `utxos` are the address's coins
async function visit(utxos) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([tac, teth, fair]) => {
    const note = (txid, amount) => ({ utxo: { txid, vout: 0, status: { confirmed: true } }, amount });
    window.__held = () => new Map([
      [tac, { assetIdHex: tac, ticker: 'TAC', decimals: 8, balance: 638843749000000n, utxos: [note('cc'.repeat(32), 638843749000000n)], unverified: [] }],
      [teth, { assetIdHex: teth, ticker: 'tETH', decimals: 8, balance: 150000000n, utxos: [note('dd'.repeat(32), 150000000n)], unverified: [] }],
      [fair, { assetIdHex: fair, ticker: 'FAIR', decimals: 0, balance: 300n, utxos: [note('ee'.repeat(32), 300n)], unverified: [] }],
    ]);
  }, [TAC, TETH, FAIR]);
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE)) {
      if (new URL(u).pathname === '/tacit.js') return r.fulfill({ status: 200, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }, body: TACIT_JS });
      return r.continue();
    }
    if (/\/address\/[^/]+\/utxo/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(utxos) });
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#wallet', { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  // Refresh in the Wallet sheet reads the Bitcoin address again and repaints the tiles (the Ethereum reads here are refused, so nothing else would)
  await page.click('#wallet');
  await page.waitForSelector('#wbal-re:not([disabled])', { timeout: 30000 });
  await page.click('#wbal-re');
  await page.waitForFunction(() => !document.querySelector('#wbal-re')?.disabled, null, { timeout: 60000 }).catch(() => {});
  await page.keyboard.press('Escape');
  return { ctx, page, errors };
}
const tile = (id) => `#dash [data-btc-asset="${id}"]`, btcTile = '#dash [data-dash-open="btc"]:not([data-btc-asset])';
const tiles = (page) => page.$$eval('#dash .di', (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));

try {
  // a key whose Bitcoin address holds some BTC, TAC, tETH and FAIR
  {
    const { ctx, page, errors } = await visit(COIN);
    const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
    await page.waitForSelector(tile(TAC), { timeout: 60000 }).catch(() => {});
    if (process.env.DEBUG) console.log(await tiles(page));
    ok(!!(await page.$(tile(TAC))), 'TAC held on Bitcoin has a tile of its own');
    if (await page.$(tile(TAC))) {
      const t = await text(tile(TAC));
      ok(/TAC/.test(t) && /6,388,437\.49/.test(t) && /on Bitcoin/.test(t), `and it says how much, in full, and where: ${t}`);
    }
    ok(!!(await page.$(tile(TETH))) && /tETH.*1\.5/.test(await text(tile(TETH)).catch(() => '')), 'tETH held on Bitcoin has one too');
    ok(!!(await page.$(tile(FAIR))) && /FAIR.*300/.test(await text(tile(FAIR)).catch(() => '')), 'FAIR, a token the page has not met, still has its own');
    const b = await text(btcTile).catch(() => '');
    ok(/BTC/.test(b) && /0\.0025/.test(b) && /at your Bitcoin address/.test(b) && !/TAC|tETH/.test(b), `the BTC tile is BTC alone: ${b}`);
    const order = await page.evaluate(([a, c, d]) => {
      const q = (s) => document.querySelector(s), before = (x, y) => !!(x && y && x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
      return before(q(c), q(a)) && before(q(c), q(d));
    }, [tile(TAC), btcTile, tile(TETH)]);
    ok(order, 'the tiles for what is on Bitcoin come after BTC');
    // the Wallet sheet lists the same TAC, once
    await page.click('#wallet');
    await page.waitForSelector('#wbal-box', { timeout: 20000 });
    await page.waitForFunction(() => /6,388,437\.49/.test(document.querySelector('#wbal-box')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const rows = await page.$$eval('#wbal-box li', (es) => es.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /TAC/.test(t) && /6,388,437\.49/.test(t)));
    ok(rows.length === 1 && /on Bitcoin/.test(rows[0]), `the Wallet sheet lists it once: ${rows.join(' | ')}`);
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
  // a key whose Bitcoin address holds no coin, only TAC: the TAC tile is there and a BTC tile of 0 is not
  {
    const { ctx, page } = await visit([]);
    await page.waitForSelector(tile(TAC), { timeout: 60000 }).catch(() => {});
    if (process.env.DEBUG) console.log(await tiles(page));
    ok(!!(await page.$(tile(TAC))) && !(await page.$(btcTile)), 'with no coin on the address the TAC tile shows and a BTC tile of nothing does not');
    await ctx.close();
  }
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\ndash bitcoin TAC checks passed (${n})`);
process.exit(fails ? 1 : 0);
