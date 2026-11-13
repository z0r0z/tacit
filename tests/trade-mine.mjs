#!/usr/bin/env node
// The visitor on the Bitcoin side of dapp/trade/: the wallet connected on the page, the Tacit key it opens (one prompt, no sheet), the order
// book marking the visitor's own orders and a returning wallet's key known with no signature at all, the Yours tab (open orders on both
// books, what the key holds on Bitcoin, what this browser saw the visitor do), the price a press on the book would pay, and the wallet sheet's
// Bitcoin line. The market data is the fixtures captured from the API on 2026-10-12 with their expiry moved forward, Bitcoin's explorer is
// answered by the test, and the stub Ethereum wallet signs for real (so the key it opens is a real one). Nothing is broadcast.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-mine.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { RPC_HOSTS } from './eth-hosts.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const WEB = 22000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);
const done = () => server.close();

const AID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const json = (n) => JSON.parse(readFileSync(join(FX, n), 'utf8'));
const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
const asset = json('tac-asset-2026-10-12.json'), sales = json('tac-sales-2026-10-12.json'), bids = json('tac-bids-2026-10-12.json'), market = json('tac-market-2026-10-12.json'), petch = json('tac-petch-2026-10-12.json');
sales.sales = sales.sales.map((x) => ({ ...x, expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) }));
bids.intents = bids.intents.map((x) => ({ ...x, expiry: soon }));
market.listings = market.listings.map((x) => ({ ...x, expiry: soon, expired: false }));

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// A wallet in the page: an EIP-1193 provider that signs the Tacit identity message with a real key.
async function stubWallet(ctx) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], account = j.address, log = { signs: 0, requests: [], account: j.address };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    log.requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [log.account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') { log.signs++; return cast('wallet', 'sign', '--private-key', j.private_key, params[0]); }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => {
    window.__h = {};
    window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { (window.__h[ev] ||= []).push(fn); }, removeListener(ev, fn) { window.__h[ev] = (window.__h[ev] || []).filter((x) => x !== fn); } };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'test-wallet-1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }, provider: window.ethereum }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });
  return log;
}

async function openPage(viewport, { wallet = false, hash = '#btc=on', utxos = [] } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const walletLog = wallet ? await stubWallet(ctx) : null;
  const seen = { api: new Set(), explorer: new Set(), posts: [], unmatched: new Set() };
  const ok200 = (body, ct = 'application/json') => ({ status: 200, contentType: ct, headers: { 'access-control-allow-origin': '*' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // Ethereum is not what this checks: its reads fail quickly and the page says so.
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, (r) => r.fulfill(ok200({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'not served in this test' } })));
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, (route) => {
    const u = new URL(route.request().url()), path = u.pathname;
    seen.api.add(`${route.request().method()} ${path}`);
    if (route.request().method() !== 'GET') { seen.posts.push(`${path}`); return route.fulfill(ok200({ error: 'not served in this test' })); }
    if (/preauth-sales$/.test(path)) return route.fulfill(ok200(sales));
    if (/bid-intents$/.test(path)) return route.fulfill(ok200(bids));
    if (path === '/market') return route.fulfill(ok200(market));
    if (path === '/petch-assets') return route.fulfill(ok200(petch));
    if (path === `/assets/${AID}`) return route.fulfill(ok200(asset));
    seen.unmatched.add(`api ${path}`);
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not found"}' });
  });
  // Bitcoin's explorers: the key's address holds one coin of 3,000,000 sats (`utxos` replaces that), the fee rate is 5 sat/vB, and a broadcast is recorded and refused.
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info|mempool\.emzy\.de|mempool\.bitaroo\.net)\//, (route) => {
    const u = new URL(route.request().url()), path = u.pathname, who = u.host;
    seen.explorer.add(`${route.request().method()} ${path}`);
    if (route.request().method() === 'POST') { seen.posts.push(`${who}${path}`); return route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, body: 'not served in this test' }); }
    let m;
    if ((m = /\/address\/([^/]+)\/utxo$/.exec(path))) return route.fulfill(ok200(utxos.length ? utxos : [{ txid: 'cd'.repeat(32), vout: 0, value: 3000000, status: { confirmed: true, block_height: 900000, block_time: soon - 700000 } }]));
    if (/\/v1\/prices$/.test(path)) return route.fulfill(ok200({ time: soon, USD: 100000, EUR: 92000 }));
    if ((m = /\/tx\/([0-9a-f]{64})$/.exec(path))) return route.fulfill(ok200({ txid: m[1], version: 2, locktime: 0, vin: [{ txid: '11'.repeat(32), vout: 0, sequence: 4294967295, witness: [], prevout: { value: 3001000, scriptpubkey_address: 'bc1qplainfunding' } }], vout: [{ value: 3000000, scriptpubkey_address: 'bc1qplainfunding' }], size: 200, weight: 800, fee: 1000, status: { confirmed: true, block_height: 900000, block_time: soon - 700000 } }));      // a plain coin whose parent can be read: a coin whose parent cannot is held back, as the executors hold it back
    if (/\/fees\/recommended$/.test(path)) return route.fulfill(ok200({ fastestFee: 5, halfHourFee: 5, hourFee: 4, economyFee: 3, minimumFee: 2 }));
    if (/\/blocks\/tip\/height$/.test(path)) return route.fulfill(ok200('900100', 'text/plain'));
    if (/\/address\/[^/]+$/.test(path)) return route.fulfill(ok200({ chain_stats: { funded_txo_sum: 3000000, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }));
    if (/\/address\/[^/]+\/txs/.test(path) || /\/scripthash\/[^/]+\/txs/.test(path)) return route.fulfill(ok200([]));
    seen.unmatched.add(`explorer ${path}`);
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'not found' });
  });
  await ctx.route(/^https:\/\/(api\.coinbase\.com|api\.kraken\.com|api\.coingecko\.com)\//, (route) => route.fulfill(ok200({ data: { amount: '100000' }, result: { XXBTZUSD: { c: ['100000'] } }, bitcoin: { usd: 100000 } })));
  await ctx.route(/^https:\/\/ipfs\.filebase\.io\//, (route) => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource/.test(t)) errors.push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}/trade/tac/${hash}`);
  return { browser, page, errors, blocked, seen, walletLog };
}
const ladderReady = (p) => until(p, () => document.querySelectorAll('#ladders .ob-row').length >= 4, null, 120000);

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

const lc = (x) => String(x).toLowerCase();
let r;
try {
  r = await openPage({ width: 1280, height: 900 }, { wallet: true, hash: '' });
  let p = r.page;
  await ladderReady(p);
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 60000);

  // before a wallet is connected: no Yours tab, no marks, and the book says what a press would pay
  ok(await p.$eval('[data-book="mine"]', (b) => b.hidden) && !(await p.$('#ladders .ob-row.mine')), 'with no wallet connected there is no Yours tab and no order is marked');
  ok(/^Press a price to buy or sell up to it\./.test(await text(p, '#ob-peek')), 'the book says what a press does');
  await p.hover('#ladders [data-btc="buy"][data-i="2"]');
  const peek = await text(p, '#ob-peek');
  ok(/^Buy [\d,.]+ TAC for [\d,]+ sats( · [^·]+){1,3}$/.test(peek) && !/\n/.test(peek), `on a price, what taking everything up to it costs, on one line (${peek})`);
  await p.hover('#ladders [data-btc="sell"][data-i="0"]');
  ok(/^Sell [\d,.]+ TAC for [\d,]+ sats/.test(await text(p, '#ob-peek')), `and on a bid, what selling into it brings (${(await text(p, '#ob-peek')).slice(0, 70)})`);
  await p.mouse.move(5, 5);
  ok(/^Press a price/.test(await text(p, '#ob-peek')), 'and goes back to its hint when the pointer leaves');

  // connected: the Yours tab appears, and it does not claim to know the visitor's orders
  await p.click('#wallet-chip');
  await p.click('.bsheet.top .way:has-text("Test Wallet")');                       // the picker lists WalletConnect beside the browser's wallets
  await until(p, () => /0x/.test(document.querySelector('#wallet-label')?.textContent || ''), null, 30000);
  ok(!(await p.$eval('[data-book="mine"]', (b) => b.hidden)) && (await text(p, '[data-book="mine"]')).trim() === 'Yours', 'once a wallet is connected the Yours tab is there');
  await p.click('[data-book="mine"]');
  const head0 = (await text(p, '.mine-head')).replace(/\s+/g, ' ');
  ok(/Your Tacit wallet Ethereum 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/.test(head0) && /Open your Tacit wallet to see your Bitcoin orders/.test(head0) && /One free signature, two the first time/.test(head0) && !!(await p.$('[data-mine="open"]')), `with no Tacit key known it names the wallet and offers to open it (${head0.slice(0, 120)})`);
  ok(!/No open orders/.test(await text(p, '#ladders')) && !(await p.$('table.yours')), 'and it does not say there are no orders when it cannot know');
  ok(await p.$eval('#depthchart', (e) => e.hidden), 'the depth chart gives way to the list');

  // one press opens the key from the wallet connected here: no sheet, one prompt (two signatures the first time), the balance read
  await p.click('[data-mine="open"]');
  await until(p, () => /^[\d,]+ sats · [\d,.]+ TAC on Bitcoin$/.test((document.querySelector('.mine-bal')?.textContent || '').trim()), null, 180000);
  const bal = (await text(p, '.mine-bal')).trim();
  ok(/^3,000,000 sats · 0 TAC on Bitcoin$/.test(bal) && r.walletLog.signs === 2 && !(await p.$('.bsheet')), `the key opens from that wallet with no sheet and no chooser: two signatures the first time, and it holds ${bal}`);
  ok(!!(await p.$('[data-mine="fund"]')) && !!(await p.$('[data-mine="lock"]')) && !(await p.$('[data-mine="open"]')), 'with Add sats and Lock beside it');
  const rec = await p.evaluate(() => JSON.parse(localStorage.getItem('tacit-trade-id-v1') || 'null'));
  ok(rec?.mode === 'eth' && lc(rec.address) === lc(r.walletLog.account) && /^0[23][0-9a-f]{64}$/.test(rec.pubHex), 'the public record of how it opened is kept (public data only)');
  const pub = rec.pubHex;

  // the wallet sheet carries the Bitcoin side of the same wallet
  await p.click('#wallet-chip');
  await until(p, () => /bc1q/.test(document.querySelector('.bsheet.top')?.textContent || ''), null, 20000);
  const ws = (await text(p, '.bsheet.top')).replace(/\s+/g, ' ');
  ok(/Bitcoin ?bc1q\w+ ?On Bitcoin ?3,000,000 sats · 0 TAC ?Lock/.test(ws), `the wallet sheet shows the key's Bitcoin address and what it holds, with Lock (${ws.slice(60, 220)})`);
  await p.click('.bsheet.top [data-btc-lock]');
  await until(p, () => !document.querySelector('.bsheet.top'), null, 10000);
  ok(/^Open it to see what it holds on Bitcoin\./.test((await text(p, '.mine-bal')).trim()) && !!(await p.$('[data-mine="open"]')), 'Lock closes the key and the Yours tab says it must be opened again to show what it holds');
  ok(/No open orders on the Bitcoin order book/.test(await text(p, '#ladders')), 'but the key is known (the wallet opened it before), so it can say there are no orders');

  // returning: two of the book's listings and a bid are this key's. A reload knows it with no signature.
  sales.sales[3].seller_pubkey = pub; sales.sales[5].seller_pubkey = pub;
  market.listings.filter((l) => l.kind === 'preauth').slice(3, 5).forEach((l) => { l.seller_pubkey = pub; });            // the market module reads its own feed of the same listings
  bids.intents.push({ ...bids.intents[0], bid_id: 'aa'.repeat(16), buyer_pubkey: pub, buyer_address: 'bc1qmine', price_sats: 180, amount: '500000000', min_fill_amount: '50000000', remaining_amount: '500000000', expiry: soon });
  const t0 = Math.floor(Date.now() / 1000);
  await p.evaluate(([who, other, t]) => localStorage.setItem('tacit-trade-activity-v1', JSON.stringify([
    { t: t - 400, who, lane: 'btc', kind: 'bought', tac: 1500.25, paid: 262544, unit: 'sats', tx: 'ab'.repeat(32) },
    { t: t - 9000, who, lane: 'btc', kind: 'listed', tac: 10000, paid: null, unit: 'sats', tx: 'cd'.repeat(32) },
    { t: t - 60, who: other, lane: 'eth', kind: 'sold', tac: 99, paid: 0.01, unit: 'eth', tx: 'ef'.repeat(32) },
  ])), [pub, '0x' + '11'.repeat(20), t0]);
  const signsBefore = r.walletLog.signs;
  await p.reload(); await p.waitForLoadState('load');
  await ladderReady(p);
  await until(p, () => /Yours\s*3/.test(document.querySelector('[data-book="mine"]')?.textContent || ''), null, 60000);
  ok(r.walletLog.signs === signsBefore, `a returning wallet's key is known with no signature (still ${r.walletLog.signs})`);
  await p.click('[data-book="btc"]');
  const mineRows = await p.$$eval('#ladders .ob-row.mine', (x) => x.map((e) => ({ tag: e.querySelector('.ob-tag')?.textContent, btn: e.tagName === 'BUTTON' })));
  ok(mineRows.length >= 1 && mineRows.every((m) => /yours/i.test(m.tag || '') && !m.btn), `the book marks the visitor's own orders as theirs and gives them no buy button (${mineRows.length} rows)`);
  ok(/You have 3 open orders here/.test(await text(p, '#depth-note')), 'and says so under the book (two listings and a bid)');
  ok((await p.$$eval('#ladders .ob-row.mine', (x) => x.every((e) => getComputedStyle(e).opacity === '1'))) && (await contrast(p, '#ladders .ob-row.mine .ob-tag')) >= 4.5 && (await contrast(p, '#ladders .ob-row.mine .p')) >= 4.4, 'the visitor\'s own rows are marked by a rule and a tag, not dimmed: their text and tag stay readable');
  await p.click('#depth-note [data-goto="mine"]');
  const rows = await p.$$eval('#ladders table.yours:first-of-type tbody tr', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.filter((x) => /^Selling/.test(x)).length === 2 && rows.filter((x) => /^Bid/.test(x)).length === 1, `Yours lists the two listings and the bid (${rows.length} rows)`);
  ok(rows.some((x) => /taken whole/.test(x)) && rows.some((x) => /settles while you are online/.test(x)) && rows.every((x) => /\d+ (days|h|min)|Manage/.test(x)), 'each with what it is, its price and when it ends');
  const mineTxt = (await text(p, '#ladders')).replace(/\s+/g, ' ');
  ok(/Recent what this browser saw, and the Precision pool’s swaps to your account over the last day/.test(mineTxt) && /Bought 1,500 TAC for 262,544 sats/.test(mineTxt) && /Listed 10,000 TAC/.test(mineTxt) && !/Sold 99 TAC/.test(mineTxt), 'what this browser saw the key do is listed, and another account\'s is not');
  ok(await p.$eval('#ladders table.yours a[href^="https://mempool.space/tx/"]', (a) => a.href.endsWith('ab'.repeat(32))), 'with a link to the transaction');
  ok(/Open it to see what it holds on Bitcoin\./.test(await text(p, '.mine-bal')), 'the balance waits to be opened (nothing was asked of the wallet)');

  // Manage opens the market in its sheet; its sign-in offers the Tacit wallet this wallet opened before, and the market then lists the same three orders
  await p.click('#ladders [data-mine="manage"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-k]') && document.querySelector('.bsheet.wide .bm input'), null, 180000);
  await p.click('.bsheet .bm >> text=Connect a wallet');
  await p.waitForSelector('.bsheet.top .opt', { timeout: 30000 });
  const first = await p.$eval('.bsheet.top .opt', (b) => b.textContent.replace(/\s+/g, ' '));
  ok(/^Tacit wallet ?Opens with Ethereum 0x/.test(first) && (await p.$$('.bsheet.top .ways [data-in="eth"]')).length === 0, `a wallet that opened its key before is offered it, and not a second way in with the same wallet (${first.slice(0, 90)})`);
  await p.click('.bsheet.top [data-in="known"]');
  await until(p, () => !document.querySelector('.bsheet.top'), null, 60000);
  await until(p, () => /Your orders\s*3/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000);
  ok(r.walletLog.signs === signsBefore + 1, `one signature opened it (second time: ${r.walletLog.signs - signsBefore})`);
  await until(p, () => { const o = document.querySelector('.bsheet [data-k="orders"]'), b = document.querySelector('.bsheet'); if (!o || o.hidden) return false; const a = o.getBoundingClientRect(), c = b.getBoundingClientRect(); return a.top >= c.top - 2 && a.bottom <= c.bottom + 2; }, null, 30000);
  ok(true, 'and Manage has brought the visitor\'s own orders into view in the market');
  await p.click('.bsheet.wide .x');
  await until(p, () => !document.querySelector('.bsheet'), null, 10000);
  await until(p, () => /^[\d,]+ sats · [\d,.]+ TAC on Bitcoin$/.test((document.querySelector('.mine-bal')?.textContent || '').trim()), null, 60000);
  ok(/3,000,000 sats/.test(await text(p, '.mine-bal')), 'and the page knows what it holds once the sheet has opened the key');

  // another account in the same wallet: the key that account opened is closed, and its orders are not shown as the new account's
  await p.evaluate(() => { (window.__h.accountsChanged || []).forEach((f) => f(['0x' + '22'.repeat(20)])); });
  r.walletLog.account = '0x' + '22'.repeat(20);
  await until(p, () => !document.querySelector('[data-mine="fund"]'), null, 30000);
  ok(!/Yours\s*\d/.test(await text(p, '[data-book="mine"]')) && !(await p.$('#ladders table.yours')) && !(await p.$('#ladders .ob-row.mine')), 'switching accounts closes the key and no order is shown as the new account\'s');
  await p.evaluate(() => { (window.__h.accountsChanged || []).forEach((f) => f([])); });

  // a phone: the tab and its list fit
  await p.setViewportSize({ width: 390, height: 844 });
  await p.evaluate((a) => { (window.__h.accountsChanged || []).forEach((f) => f([a])); }, r.walletLog.account = (await p.evaluate(() => JSON.parse(localStorage.getItem('tacit-trade-id-v1')).address)));
  await until(p, () => /Yours\s*3/.test(document.querySelector('[data-book="mine"]')?.textContent || ''), null, 30000);
  await p.click('[data-book="mine"]');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll at 390px with the Yours tab open (${await p.evaluate(() => document.documentElement.scrollWidth)})`);
  ok(r.errors.length === 0 && r.blocked.length === 0, `no errors or blocked requests (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();

  // a first visit with a wallet connected: the sheet's sign-in leads with that wallet and opens the key with one prompt (two signatures), no chooser
  r = await openPage({ width: 1280, height: 900 }, { wallet: true, hash: '' });
  p = r.page;
  await ladderReady(p);
  await p.click('#wallet-chip');
  await p.click('.bsheet.top .way:has-text("Test Wallet")');
  await until(p, () => /0x/.test(document.querySelector('#wallet-label')?.textContent || ''), null, 30000);
  await p.click('#ladders [data-btc="open"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-k]') && document.querySelector('.bsheet.wide .bm input'), null, 180000);
  await p.click('.bsheet .bm >> text=Connect a wallet');
  await p.waitForSelector('.bsheet.top .opt', { timeout: 30000 });
  const lead = await p.$eval('.bsheet.top .opt', (b) => ({ t: b.textContent.replace(/\s+/g, ' '), k: b.dataset.in, main: b.classList.contains('main') }));
  ok(lead.k === 'eth' && lead.main && /^Ethereum wallet ?0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} is connected here\. Sign to open/.test(lead.t), `with no key opened before, the sheet's sign-in leads with the wallet connected on the page (${lead.t.slice(0, 80)})`);
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => !document.querySelector('.bsheet.top'), null, 60000);
  await until(p, () => /Balance:\s*3,000,000 sats/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000);
  ok(r.walletLog.signs === 2 && !(await p.$('.bsheet.top')), `it opened with no chooser: ${r.walletLog.signs} signatures, and the market shows the balance`);
  ok(r.errors.length === 0 && r.blocked.length === 0, `no errors or blocked requests there (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / '));
  if (r) console.log('     errors:', r.errors.slice(0, 4), 'blocked:', r.blocked.slice(0, 3));
  await r?.browser.close().catch(() => {});
}
done();
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-mine checks passed`);
process.exit(fails ? 1 : 0);
