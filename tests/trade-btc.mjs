#!/usr/bin/env node
// The Bitcoin side of dapp/trade/ in a real browser: tacit.js loaded for real, the market page's own module mounted in a sheet, the order
// book and the market feed from fixtures captured from the API on 2026-10-12 (their expiry moved forward), Bitcoin's explorer answered by
// the test. A stub Ethereum wallet opens the Tacit key. Checks the flag, the buttons on the ladders, the sheet and how it is primed, the
// sign-in, the balance, the review, and that a confirmed purchase reaches tacit.js's executor and no transaction is broadcast
// (nothing here has a Bitcoin network to settle on: the executors themselves are tested elsewhere).
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-btc.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

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
// The API serves the page's listings and the sheet's feed from one book: the market feed's listings are the same sales (with the maker-confirm offers it adds).
market.listings = [...sales.sales.map((x) => ({ asset_id: AID, kind: 'preauth', ...x })), ...market.listings.filter((x) => x.kind !== 'preauth').map((x) => ({ ...x, expiry: soon, expired: false }))];

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// A wallet in the page: an EIP-1193 provider that signs the Tacit identity message with a real key.
async function stubWallet(ctx) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], account = j.address, log = { signs: 0, requests: [] };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    log.requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') { log.signs++; return cast('wallet', 'sign', '--private-key', j.private_key, params[0]); }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}

async function openPage(viewport, { wallet = false, hash = '#btc=on', utxos = [], delay = 0, utxoHold = 0, taprootCoin = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const walletLog = wallet ? await stubWallet(ctx) : null;
  const seen = { api: new Set(), explorer: new Set(), posts: [], unmatched: new Set() };
  const ok200 = (body, ct = 'application/json') => ({ status: 200, contentType: ct, headers: { 'access-control-allow-origin': '*' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // Ethereum is not what this checks: its reads fail quickly and the page says so.
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co']) await ctx.route(`https://${h}/**`, (r) => r.fulfill(ok200({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'not served in this test' } })));
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
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info|mempool\.emzy\.de|mempool\.bitaroo\.net)\//, async (route) => {
    const u = new URL(route.request().url()), path = u.pathname, who = u.host;
    seen.explorer.add(`${route.request().method()} ${path}`);
    if (route.request().method() === 'POST') { seen.posts.push(`${who}${path}`); return route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, body: 'not served in this test' }); }
    let m;
    if ((m = /\/address\/(bc1p[^/]+)\/utxo$/.exec(path))) return route.fulfill(ok200(taprootCoin ? [{ txid: 'ee'.repeat(32), vout: 0, value: 546, status: { confirmed: true, block_height: 900000, block_time: soon - 700000 } }] : []));
    if ((m = /\/address\/([^/]+)\/utxo$/.exec(path))) { if (utxoHold) await new Promise((r) => setTimeout(r, utxoHold)); return route.fulfill(ok200(utxos.length ? utxos : [{ txid: 'cd'.repeat(32), vout: 0, value: 3000000, status: { confirmed: true, block_height: 900000, block_time: soon - 700000 } }])); }
    if (/\/v1\/prices$/.test(path)) return route.fulfill(ok200({ time: soon, USD: 100000, EUR: 92000 }));
    if ((m = /\/tx\/([0-9a-f]{64})$/.exec(path))) { if (delay) await new Promise((r) => setTimeout(r, delay)); return route.fulfill(ok200({ txid: m[1], version: 2, locktime: 0, vin: [{ txid: '11'.repeat(32), vout: 0, sequence: 4294967295, witness: [], prevout: { value: 3001000, scriptpubkey_address: 'bc1qplainfunding' } }], vout: [{ value: 3000000, scriptpubkey_address: 'bc1qplainfunding' }], size: 200, weight: 800, fee: 1000, status: { confirmed: true, block_height: 900000, block_time: soon - 700000 } })); };
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

let r;
try {
  // on by default, and off in one browser with #btc=off
  r = await openPage({ width: 1280, height: 900 }, { hash: '' });
  let p = r.page;
  await ladderReady(p);
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 60000);
  ok(true, 'the Bitcoin ladders have their buttons with no setting made');
  await p.click('[data-book="eth"]');
  ok(/Could not read zSwap’s boards/.test(await text(p, '#ladders')), 'when no RPC answers, the Ethereum tab says the boards could not be read rather than that they hold no orders');
  await p.click('[data-book="btc"]');
  await p.evaluate(() => { location.hash = '#btc=off'; location.reload(); });
  await p.waitForLoadState('load');
  await ladderReady(p);
  ok(!(await p.$('#ladders [data-btc]')) && (await p.evaluate(() => localStorage.getItem('tacit-trade-btc'))) === '0', '#btc=off takes them away in this browser');
  await r.browser.close();

  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 120000);
  const btns = await p.$$eval('#ladders [data-btc]', (b) => b.map((x) => `${x.dataset.btc}:${x.dataset.i ?? ''}`));
  ok(btns.filter((x) => x.startsWith('buy')).length >= 3 && btns.filter((x) => x.startsWith('buy')).length <= 8 && btns.filter((x) => x.startsWith('sell')).length >= 1 && btns.includes('open:') && btns.includes('list:'), `a Buy on each price of listings, a Sell on each price of bids, and Trade on Bitcoin and List a sale (${btns.length} buttons)`);

  // the sheet, primed from the second listing
  const firstTwo = await p.$$eval('#ladders .ob-asks .ob-row', (rows) => rows.reverse().slice(0, 2).map((x) => x.querySelector('.a').textContent.replace(/,/g, '')));
  await p.click('#ladders [data-btc="buy"][data-i="1"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-k]') && document.querySelector('.bsheet.wide .bm input'), null, 180000);
  await until(p, () => /sats\/TAC/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000);
  const head = (await text(p, '.bsheet .bm')).replace(/\s+/g, ' ');
  ok(/TAC.*✓ VERIFIED.*sats\/TAC/.test(head) && !/sats\/\?/.test(head), `the market page opens in a sheet with TAC's ticker and prices in sats (${head.slice(0, 90)})`);
  await until(p, () => (document.querySelector('.bsheet .bm input[data-k="amount"]')?.value || '') !== '', null, 60000);
  const amount = await p.evaluate(() => document.querySelector('.bsheet .bm input[data-k="amount"]')?.value);
  const want = (Number(firstTwo[0]) + Number(firstTwo[1]));
  ok(Math.abs(Number(amount) - want) / want < 0.02 || Number(amount) >= want * 0.98, `the ticket is set to buy up to that listing: ${amount} TAC (the two cheapest hold about ${want.toFixed(2)})`);
  ok(/Connect a wallet/.test(await text(p, '.bsheet .bm')), 'with no key open it asks to connect a wallet');
  ok((await p.$$eval('.bsheet .bm-back', (e) => e.map((x) => getComputedStyle(x).display))).every((d) => d === 'none'), 'and the classic "All markets" link is not shown');

  // signing in with the Ethereum wallet
  await p.click('.bsheet .bm [data-act="unlock"]');
  await p.waitForSelector('.bsheet.top .opts');
  const opts = (await text(p, '.bsheet.top .opts')).replace(/\s+/g, ' ');
  ok(/Ethereum wallet/.test(opts) && /Bitcoin wallet.*None found in this browser/.test(opts) && !/Paste a key|Saved in this browser/.test(opts), 'the sign-in offers the Ethereum wallet, a Bitcoin wallet (none here) and no way that needs a passphrase');
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => !document.querySelector('.bsheet.top') && /Balance/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 120000);
  ok(r.walletLog.signs >= 1, `the wallet signed the Tacit identity message (${r.walletLog.signs}×) and nothing else (${[...new Set(r.walletLog.requests)].join(', ')})`);
  await until(p, () => /3,000,000/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000).catch(() => {});
  ok(/3,000,000/.test(await text(p, '.bsheet .bm')), 'the balance is the sats at the key\'s address (3,000,000)');

  const who = (await text(p, '.bsheet .who')).replace(/\s+/g, ' ');
  ok(/bc1q\w{4}…\w{6}Lock/.test(who) && /bridge it to Bitcoin first/.test(await text(p, '.bsheet')), `the sheet names the key's Bitcoin address with a Lock, and says Ethereum TAC is bridged first (${who})`);

  // review, then confirm: it reaches tacit.js's executor, which asks the API for the listing and finds none here
  await p.click('.bsheet .bm [data-k="go"]');
  await p.waitForSelector('.bm-modal');
  const review = (await text(p, '.bm-modal')).replace(/\s+/g, ' ');
  ok(/You pay|You'll pay|sats/.test(review) && /TAC/.test(review), `the review says what it pays and gets (${review.slice(0, 140)})`);
  await until(p, () => !document.querySelector('.bm-modal .bm-go')?.disabled, null, 20000).catch(() => {});
  await p.waitForTimeout(800);
  await p.click('.bm-modal .bm-go');
  await until(p, () => /nothing bought|nothing was spent|not found|stale|could not|failed/i.test(document.querySelector('.bm-modal')?.textContent || '') || !document.querySelector('.bm-modal'), null, 90000);
  ok(/Nothing bought.*taken before you.*nothing was spent/i.test((await text(p, '.bm-modal')).replace(/\s+/g, ' ')), 'a listing the API no longer has is reported as taken before the buyer, with nothing spent');
  ok([...r.seen.api].some((x) => /GET \/assets\/[0-9a-f]{64}\/preauth-sales\/[0-9a-f]+/.test(x)) || /not found|refresh/i.test(await text(p, 'body')), `the executor asked the API for the full listing before anything else (${[...r.seen.api].filter((x) => /preauth-sales\//.test(x)).slice(0, 1).join('') || 'noted in the message'})`);
  const posted = r.seen.posts.filter((x) => x !== '/chain/tac/ancestry');                  // the archive's answer to a list of transactions is a read that happens to be a POST
  ok(posted.length === 0, `nothing was broadcast or posted (${posted.join(', ') || 'no POSTs'})`);
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page errors or blocked requests (${[...r.errors, ...r.blocked].slice(0, 3).join(' | ')})`);
  console.log('     unmatched requests:', [...r.seen.unmatched].join(' | ') || 'none');
  await r.browser.close();

  // locking forgets the key in this tab
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 120000);
  await p.click('#ladders [data-btc="open"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="unlock"]'), null, 180000);
  await p.click('.bsheet .bm [data-act="unlock"]'); await p.waitForSelector('.bsheet.top .opts'); await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => document.querySelector('.bsheet .who [data-lock]'), null, 120000);
  await p.click('.bsheet .who [data-lock]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="unlock"]') && !document.querySelector('.bsheet .who [data-lock]'), null, 60000);
  ok(!(await p.evaluate(() => (window.__x = 1, localStorage.getItem('tacit-trade-id-v1'))?.includes('priv'))), 'Lock puts the sheet back to asking for a wallet, and nothing stored holds a private key');
  await r.browser.close();

  // a press on the deepest visible price sets the ticket as a press on the sheet's own row does: everything up to it, within a limit that reaches it
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc="buy"]').length > 3, null, 120000);
  const lastI = await p.$$eval('#ladders [data-btc="buy"]', (b) => Math.max(...b.map((x) => Number(x.dataset.i))));
  const upTo = await p.$$eval('#ladders .ob-asks .ob-row', (rows, i) => rows.reverse().slice(0, i + 1).reduce((a, x) => a + Number(x.querySelector('.a').textContent.replace(/,/g, '')), 0), lastI);
  await p.click(`#ladders [data-btc="buy"][data-i="${lastI}"]`);
  await until(p, () => /sats\/TAC/.test(document.querySelector('.bsheet .bm')?.textContent || '') && (document.querySelector('.bsheet .bm input[data-k="amount"]')?.value || '') !== '', null, 180000);
  await p.waitForTimeout(600);
  const deep = { amount: Number(await p.evaluate(() => document.querySelector('.bsheet .bm input[data-k="amount"]')?.value)), quote: (await text(p, '.bsheet .bm [data-k="quote"]')).replace(/\s+/g, ' ') };
  ok(Math.abs(deep.amount - upTo) / upTo < 0.005 && !/within your max price/.test(deep.quote), `the deepest price (row ${lastI}) buys everything up to it, ${deep.amount} of the ${upTo.toFixed(2)} TAC the ladder shows, with no 'only … within your max price' (${deep.quote.slice(0, 80)})`);
  await r.browser.close();

  // signing in does not wait for the walk through the key's history: the sats show at once, the TAC follows
  r = await openPage({ width: 1280, height: 900 }, { wallet: true, delay: 9000 });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 120000);
  await p.click('#ladders [data-btc="open"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="unlock"]'), null, 180000);
  await p.click('.bsheet .bm [data-act="unlock"]'); await p.waitForSelector('.bsheet.top .opts');
  const t0 = Date.now();
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => /3,000,000/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000);
  const took = Date.now() - t0;
  ok(took < 6000, `signing in shows the sats in ${took} ms, not after the walk through the key's history (the explorer is held 9 s a request)`);
  await r.browser.close();

  // while the explorers are slow to give the sats, the key shows as open with its balance being checked: 'Connect a wallet' says the sign-in did not work
  r = await openPage({ width: 1280, height: 900 }, { wallet: true, utxoHold: 8000 });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 120000);
  await p.click('#ladders [data-btc="open"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="unlock"]'), null, 180000);
  await p.click('.bsheet .bm [data-act="unlock"]'); await p.waitForSelector('.bsheet.top .opts');
  await p.click('.bsheet.top [data-in="eth"]');
  const checking = await until(p, () => /Balance: checking/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 6000).then(() => true, () => false);
  const held = (await text(p, '.bsheet .bm')).replace(/\s+/g, ' ');
  ok(checking && !/Connect a wallet|Unlock/.test(held), `after signing in, while the sats are still being read, the sheet says the balance is being checked, not that no wallet is connected (${(/Balance[^|]{0,30}|Connect a wallet[^|]{0,30}/.exec(held) || [''])[0]})`);
  await until(p, () => /3,000,000/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000);
  ok(true, 'and the sats follow when they arrive');
  await r.browser.close();

  // notes bridged to Bitcoin sit at the key's Taproot address: with one there, the Sell side says nothing sells from it yet; with none, it says nothing
  for (const withNote of [true, false]) {
    r = await openPage({ width: 1280, height: 900 }, { wallet: true, taprootCoin: withNote });
    p = r.page;
    await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 120000);
    await p.click('#ladders [data-btc="open"]');
    await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="unlock"]'), null, 180000);
    await p.click('.bsheet .bm [data-act="unlock"]'); await p.waitForSelector('.bsheet.top .opts');
    await p.click('.bsheet.top [data-in="eth"]');
    await until(p, () => /3,000,000/.test(document.querySelector('.bsheet .bm')?.textContent || ''), null, 60000);
    await p.click('.bsheet .bm [data-act="side"][data-v="sell"]'); await p.waitForTimeout(2500);
    const hint = (await p.evaluate(() => document.querySelector('.bsheet .bm [data-k="bridged"]')?.textContent || '')).replace(/\s+/g, ' ');
    ok(withNote ? /TAC you bridged to Bitcoin sits at your Taproot address.*Move it here to sell/.test(hint) : hint === '', withNote ? `with a bridged note at the Taproot address the Sell side offers to move it (${hint.slice(0, 80)})` : 'with nothing at the Taproot address the Sell side says nothing about it');
    if (withNote) {
      await p.click('.bsheet .bm [data-k="bridged"] [data-act="moveBridged"]');
      await p.waitForSelector('.bm-modal', { timeout: 20000 });
      await until(p, () => !/Looking for your bridged/.test(document.querySelector('.bm-modal')?.textContent || ''), null, 60000);
      const dlg = (await text(p, '.bm-modal')).replace(/\s+/g, ' ');
      ok(/Could not read it just now|No bridged TAC found|Move .* TAC here/.test(dlg) && !(await p.$('.bm-modal .bm-go:not(:has-text("Close"))')), `pressing it opens the dialog, which reads the address and offers nothing to send when nothing there can be opened (${dlg.slice(0, 70)})`);
      ok(r.seen.posts.filter((x) => x !== '/chain/tac/ancestry').length === 0, 'and nothing was broadcast');
    }
    await r.browser.close();
  }

  // a bid's Sell sets the ticket to sell, and the recovery of a stopped purchase is offered with its figures
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc="sell"]').length > 0, null, 120000);
  await p.click('#ladders [data-btc="sell"][data-i="0"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="side"][data-v="sell"][aria-selected="true"]') && (document.querySelector('.bsheet .bm input[data-k="amount"]')?.value || '') !== '', null, 180000);
  ok(true, 'Sell on a bid opens the sheet on the Sell side with that bid\'s amount in the ticket');
  const tok = /\/trade\/btc\.js\?cb=([0-9a-f]+)/.exec(readFileSync(join(DAPP, 'trade/app.js'), 'utf8'))[1];
  await p.evaluate(async (t) => {
    const m = await import(`/trade/btc.js?cb=${t}`);
    window.__notes = []; window.__rb = m.makeBitcoin({ notify: (msg, kind) => window.__notes.push(`${kind}:${msg}`) });
    await window.__rb.session.load();
    await window.__rb.session.open.eth(undefined, () => null);                           // the key that made the purchase is open, as it is when one stops
    window.__rec = window.__rb.recovery(new Error('Commit tx broadcast — 12345 sats locked at ' + 'ab'.repeat(32) + ':0 · reveal failed'));
  }, tok);
  await p.waitForSelector('.bsheet.top');
  const dlg = (await text(p, '.bsheet.top')).replace(/\s+/g, ' ');
  ok(/Purchase stopped · sats recoverable/.test(dlg) && /12,345 sats/.test(dlg) && /Recover 12,345 sats now/.test(dlg) && /Later/.test(dlg), `a purchase that stopped after its commit offers to recover the sats it holds (${dlg.slice(0, 120)})`);
  await p.click('.bsheet.top .btn:not(.ghost)');
  await p.evaluate(() => window.__rec);
  const notes = await p.evaluate(() => window.__notes);
  ok(notes.some((x) => /^error:Could not recover them/.test(x)) && /classic app/.test(notes.join(' ')), `recovering a commit this browser has no record of says so and points to the classic app (${notes[0]?.slice(0, 80)})`);
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page errors or blocked requests (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();

  // a phone
  r = await openPage({ width: 390, height: 844 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelectorAll('#ladders [data-btc]').length > 0, null, 120000);
  await p.click('#ladders [data-btc="open"]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-k]'), null, 180000);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && getComputedStyle(document.querySelector('.bsheet.wide')).overflowX === 'hidden' && document.querySelector('.bsheet.wide .bsheet-in').getBoundingClientRect().right <= window.innerWidth + 1), 'the sheet fits a phone without sideways scroll');
  await p.click('.bsheet .x');
  ok(!(await p.$('.bsheet')), 'the close button closes it');
  await r.browser.close();
  // a link from another page (/tac/#buy, the front page's "Paying in sats?") opens the sheet on its side with no press: #btc=buy, #btc=sell
  for (const side of ['buy', 'sell']) {
    r = await openPage({ width: 1280, height: 900 }, { hash: `#btc=${side}` });
    p = r.page;
    await until(p, (want) => document.querySelector('.bsheet.wide .bm [data-act="side"][aria-selected="true"]')?.dataset.v === want, side, 180000).catch(() => {});
    const on = await p.$eval('.bsheet.wide .bm [data-act="side"][aria-selected="true"]', (b) => b.dataset.v).catch(() => 'none');
    ok(on === side, `#btc=${side} opens the Bitcoin market on its ${side} side by itself (${on})`);
    await r.browser.close();
  }
  // the line under the ticket: the same TAC for sats on Bitcoin, opened on the ticket's side
  r = await openPage({ width: 1280, height: 900 }, { hash: '' });
  p = r.page;
  await until(p, () => !document.querySelector('#btc-alt')?.hidden, null, 120000);
  const alt = (await text(p, '#btc-alt')).replace(/\s+/g, ' ').trim();
  ok(/Or buy TAC for sats on the Bitcoin order book\. Buy on Bitcoin →/.test(alt), `the ticket says the same TAC trades for sats on Bitcoin (${alt})`);
  await p.click('#side-seg [data-side="sell"]');
  await until(p, () => /Sell on Bitcoin/.test(document.querySelector('#btc-alt')?.textContent || ''), null, 30000);
  await p.click('#btc-alt [data-btc-alt]');
  await until(p, () => document.querySelector('.bsheet.wide .bm [data-act="side"][aria-selected="true"]')?.dataset.v === 'sell', null, 180000).catch(() => {});
  ok((await p.$eval('.bsheet.wide .bm [data-act="side"][aria-selected="true"]', (b) => b.dataset.v).catch(() => 'none')) === 'sell', 'and its press opens the Bitcoin market on the ticket\'s side');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page errors or blocked requests there (${[...r.errors, ...r.blocked].slice(0, 3).join(' | ')})`);
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / '));
  if (r) console.log('     errors:', r.errors.slice(0, 4), 'blocked:', r.blocked.slice(0, 3), 'unmatched:', [...r.seen.unmatched].slice(0, 8), 'api:', [...r.seen.api].slice(0, 12), 'explorer:', [...r.seen.explorer].slice(0, 8));
  if (r && process.env.SHOT) await r.page.screenshot({ path: process.env.SHOT }).catch(() => {});
  if (r) console.log('     sheet:', JSON.stringify(await r.page.evaluate(() => ({ t: document.querySelector('.bsheet')?.innerText.replace(/\s+/g, ' ').slice(0, 500), amount: document.querySelector('.bsheet .bm input')?.value, modal: document.querySelector('.bm-modal')?.innerText.replace(/\\s+/g, ' ').slice(0, 600) })).catch(() => null)));
  await r?.browser.close().catch(() => {});
} finally { done(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-btc checks passed`);
process.exit(fails ? 1 : 0);
