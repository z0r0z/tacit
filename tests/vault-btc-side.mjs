#!/usr/bin/env node
// The borrow page's Bitcoin side (/vault/#btc) and the links that reach it, with no chain behind them:
//   1. front-route.js sends /vault/btc to /vault/#btc (its own fragment, when it has one, instead) and /vault/tac to /vault/, keeping the query;
//   2. btc.js reads the collateral engine's three figures and formats them;
//   3. in a real browser under the page's CSP (skipped without playwright-core): a page opened on #btc draws the Bitcoin side from its first paint
//      (with JavaScript off too), reads only the engine and never the vaults, the switch moves between the sides without a reload, back and forward
//      follow it, the TAC side's own hash comes back, a page opened on TAC never fetches btc.js, and the Bitcoin side does not shift.
//
//   node tests/vault-btc-side.mjs        (PLAYWRIGHT=<playwright-core dir> to name the browser driver)
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname, DAPP = join(REPO, 'dapp');
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// ── 1. front-route.js ──
const ROUTE = readFileSync(join(DAPP, 'front-route.js'), 'utf8');
function route(url) {
  const u = new URL(url, 'https://tacit.finance');
  const out = { to: null, replaced: null };
  const window = {
    location: { pathname: u.pathname, search: u.search, hash: u.hash, replace: (to) => { out.to = to; } },
    history: { replaceState: (_s, _t, to) => { out.replaced = to; } },
  };
  vm.runInNewContext(ROUTE, { window, URLSearchParams });
  return out;
}
const cases = [
  ['/vault/btc', '/vault/#btc'],
  ['/vault/btc/', '/vault/#btc'],
  ['/vault/btc?ref=x', '/vault/?ref=x#btc'],
  ['/vault/btc#v=eth', '/vault/#v=eth'],
  ['/vault/btc?ref=x#t=repay', '/vault/?ref=x#t=repay'],
  ['/vault/BTC', '/vault/#btc'],
  ['/vault/tac', '/vault/'],
  ['/vault/tac?ref=x#t=repay', '/vault/?ref=x#t=repay'],
  ['/vault', '/vault/'],
  ['/vault#btc', '/vault/#btc'],
];
for (const [from, to] of cases) { const r = route(from); ok(r.to === to, `front-route ${from} → ${to}${r.to === to ? '' : ` (got ${r.to})`}`); }
ok(route('/borrow').replaced === '/#borrow', 'front-route /borrow is still the front page’s Borrow sheet');

// ── 2. btc.js ──
const btc = await import(join(DAPP, 'vault/btc.js'));
const w = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const e = btc.parseEngine([w(15000), w(13000), w(442_012_345_678n)]);
ok(e.ratio === 150 && e.liq === 130 && e.out === 442_012_345_678n, 'parseEngine: the ratios in percent and the cUSD out');
const f = Object.fromEntries(btc.figures(e));
ok(f.out === '4,420.12 cUSD' && f.ratio === '150%' && f.liq === '130%', `figures: ${JSON.stringify(f)}`);
const none = Object.fromEntries(btc.figures(btc.parseEngine([null, '0x', undefined])));
ok(none.out === '—' && none.ratio === '—' && none.liq === '—', 'figures: a failed read is a dash');
ok(btc.engineCalls().every((c) => c.to === btc.ENGINE) && btc.engineCalls().length === 4, 'engineCalls: four reads of the engine');
{
  const els = {}, el = (k) => (els[k] ||= { textContent: '…' });
  const root = { querySelector: (s) => { const m = /data-bf="(\w+)"/.exec(s); return m ? el(m[1]) : s === '[data-bf-who]' ? el('who') : null; } };
  await btc.loadBtc(root, { batch: async () => { throw new Error('down'); } });
  ok(els.out.textContent === '—' && els.who.textContent === 'could not be read', 'loadBtc: a failed batch leaves dashes and says so');
  await btc.loadBtc(root, { batch: async (calls) => (calls.length === 4 ? [w(15000), w(13000), w(1e8), w(7_600_000_000_000n)] : []) });
  ok(els.out.textContent === '1.00 cUSD' && els.ratio.textContent === '150%' && els.px.textContent === '$76,000' && els.max.textContent === '50,666 cUSD' && els.who.textContent === '', `loadBtc: fills the rows (${els.px.textContent}, ${els.max.textContent})`);
}

// ── 3. the page ──
const PW = process.env.PLAYWRIGHT || (existsSync('/Users/z/zFi/node_modules/playwright-core') ? '/Users/z/zFi/node_modules/playwright-core' : 'playwright-core');
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)(PW)); } catch { /* no browser driver */ }
if (!chromium) {
  console.log('  skipped the browser part: no playwright-core (set PLAYWRIGHT)');
} else {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  const WEB = 22000 + Math.floor(Math.random() * 1000);
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = join(DAPP, p);
    if (existsSync(file) && statSync(file).isDirectory()) file = p.endsWith('/') ? join(file, 'index.html') : join(DAPP, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  }).listen(WEB);
  const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', 'rpc.mevblocker.io', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io', 'eth.rpc.blxrbdn.com', '1.rpc.thirdweb.com', '1rpc.io', 'mainnet.gateway.tenderly.co', 'eth-mainnet.nodereal.io', 'rpc.flashbots.net'];
  const ENGINE = btc.ENGINE.slice(2).toLowerCase();
  const { DEPLOYMENTS } = await import(join(DAPP, 'vault/deployments.js'));
  const VAULTS = DEPLOYMENTS.vaults.map((v) => v.vault.slice(2).toLowerCase());
  // aggregate3's (bool, bytes)[] for answers that are each one word.
  const agg = (words) => {
    const hex = (v) => BigInt(v).toString(16).padStart(64, '0'), k = words.length;
    let head = hex(32) + hex(k), body = '';
    words.forEach((x, i) => { head += hex(k * 32 + i * 128); body += hex(1) + hex(64) + hex(32) + hex(x); });
    return '0x' + head + body;
  };
  const browser = await chromium.launch();
  async function open(path, { js = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: js });
    const log = { engine: 0, vault: 0, other: 0, files: [] };
    await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const x of l.getEntries()) if (!x.hadRecentInput) window.__cls += x.value; }).observe({ type: 'layout-shift', buffered: true }); });
    for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, (r) => {
      const body = JSON.parse(r.request().postData() || '{}'), data = String(body.params?.[0]?.data || '').toLowerCase();
      const cors = { 'access-control-allow-origin': '*' };
      if (body.method === 'eth_call' && data.includes(ENGINE)) { log.engine++; return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: agg([15000, 13000, 442_012_345_678n, 7_600_000_000_000n]) }) }); }
      if (VAULTS.some((v) => data.includes(v) || String(body.params?.[0]?.to || '').toLowerCase().includes(v))) log.vault++; else log.other++;
      return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'not in this test' } }) });
    });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (x) => errors.push(String(x.message || x)));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused/i.test(m.text())) errors.push(m.text()); });
    page.on('request', (q) => log.files.push(new URL(q.url()).pathname));
    await page.goto(`http://127.0.0.1:${WEB}${path}`);
    return { ctx, page, log, errors };
  }
  const shown = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }, sel);
  const h1 = (page) => page.evaluate(() => document.querySelector('#h').innerText.replace(/\s+/g, ' ').trim());
  const current = (page) => page.evaluate(() => document.querySelector('.via a[aria-current="page"]')?.dataset.side || null);
  const sideIs = (page, s) => page.waitForFunction((x) => document.documentElement.dataset.side === x, s, { timeout: 10000 }).then(() => true, () => false);

  try {
    // Opened on Bitcoin, with no script at all: the side is the CSS's.
    {
      const { ctx, page } = await open('/vault/#btc', { js: false });
      ok(await shown(page, '#btc') && !(await shown(page, '#sub')) && (await h1(page)) === 'Borrow against Bitcoin', 'no script: /vault/#btc draws the Bitcoin side from its :target');
      ok(await page.evaluate(() => scrollY) === 0, 'no script: opening #btc leaves the page at its top');
      await ctx.close();
    }
    // Opened on Bitcoin.
    {
      const { ctx, page, log, errors } = await open('/vault/#btc');
      ok(await sideIs(page, 'btc'), 'the script marks the Bitcoin side');
      await page.waitForFunction(() => document.querySelector('[data-bf="out"]')?.textContent !== '…', null, { timeout: 15000 }).catch(() => {});
      ok((await page.textContent('[data-bf="out"]')) === '4,420.12 cUSD' && (await page.textContent('[data-bf="ratio"]')) === '150%' && (await page.textContent('[data-bf="liq"]')) === '130%', 'the board shows the engine’s figures');
      ok((await h1(page)) === 'Borrow against Bitcoin' && (await current(page)) === 'btc', 'h1 and aria-current are on Bitcoin');
      ok(await shown(page, '.s-btc.sub') && !(await shown(page, '#app')) && !(await shown(page, '#how')) && await shown(page, '#wallet-chip'), 'the TAC side and its how-to are hidden; the wallet chip stays (it posts a lock\'s bond)');
      ok(!!(await page.$('#btc-mine [data-mine="open"]')) && (await page.getAttribute('#btc a[href="/cbtc/"]', 'href')) === '/cbtc/' && !(await page.$('#btc a[href^="/#"]')), 'the side\'s own panels do the borrowing (Open your Tacit wallet), with the cBTC market a link and none back to the front page');
      await page.waitForTimeout(1500);
      ok(log.vault === 0 && log.engine === 1, `the Bitcoin side reads the engine once and no vault (engine ${log.engine}, vault ${log.vault}, other ${log.other})`);
      ok(log.files.some((p) => p === '/vault/btc.js'), 'btc.js is fetched for the Bitcoin side');
      const cls = await page.evaluate(() => window.__cls);
      ok(cls <= 0.04, `layout shift on the Bitcoin side ${cls.toFixed(4)} <= 0.04`);
      // To TAC, without a reload.
      await page.evaluate(() => { window.__same = 1; });
      await page.click('.via a[data-side="tac"]');
      ok(await sideIs(page, 'tac'), 'TAC in the switch shows the TAC side');
      ok(await page.evaluate(() => window.__same === 1 && location.pathname + location.search + location.hash === '/vault/'), 'no reload, and the address bar is /vault/ with no bare #');
      ok((await h1(page)) === 'Borrow against TAC' && (await current(page)) === 'tac' && await shown(page, '#sub') && !(await shown(page, '#btc')), 'h1, the sub line and aria-current follow');
      await page.waitForTimeout(1500);
      ok(log.vault > 0, `the vaults are read once the TAC side is shown (${log.vault} reads)`);
      await page.goBack();
      ok(await sideIs(page, 'btc') && (await page.evaluate(() => location.hash)) === '#btc' && await page.evaluate(() => window.__same === 1), 'back returns to #btc in the same page');
      await page.goForward();
      ok(await sideIs(page, 'tac') && (await h1(page)) === 'Borrow against TAC', 'forward returns to TAC');
      ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
      await ctx.close();
    }
    // Opened on TAC with a hash of its own.
    {
      const { ctx, page, log, errors } = await open('/vault/#t=repay');
      ok(await sideIs(page, 'tac') && (await current(page)) === 'tac', 'a page opened on TAC is on TAC');
      await page.waitForTimeout(1500);
      ok(!log.files.includes('/vault/btc.js') && log.engine === 0, 'the TAC side never fetches btc.js or reads the engine');
      ok(await shown(page, '.btc-l a[data-side="btc"]'), 'the TAC side has its one line to Bitcoin');
      await page.click('.btc-l a[data-side="btc"]');
      ok(await sideIs(page, 'btc') && (await page.evaluate(() => location.hash)) === '#btc', 'the TAC side’s line opens #btc');
      await page.click('.via a[data-side="tac"]');
      ok(await sideIs(page, 'tac') && (await page.evaluate(() => location.hash)) === '#t=repay', 'back on TAC, its own hash (#t=repay) is kept');
      await page.goBack();
      ok(await sideIs(page, 'btc'), 'back is Bitcoin');
      await page.goBack();
      ok(await sideIs(page, 'tac') && (await page.evaluate(() => location.hash)) === '#t=repay', 'and back again is TAC on #t=repay');
      ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
      await ctx.close();
    }
    // A phone.
    {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${WEB}/vault/#btc`);
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no sideways scroll on the Bitcoin side');
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); }
}

console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
