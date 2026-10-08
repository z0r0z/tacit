#!/usr/bin/env node
// dapp/btc-market.js in a real browser against a scripted wallet: every executor call the
// page makes is recorded and checked against what its review screen promised — amounts,
// prices, the confirmed bounds on re-routes, stopping on errors that aren't safe to retry.
//   PLAYWRIGHT=<path to playwright-core> node tests/btc-market-flows.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;

// Pull every top-level `:root { … }` token block straight out of the real stylesheet
// (brace-balanced, not line-scoped) instead of hand-copying a token subset — a hand-copy
// silently drifts as tokens are added/renamed and lets a real "this var doesn't resolve"
// bug (e.g. a background using an undefined custom property) render invisibly-but-"fine"
// in tests while broken live. Only :root is pulled; component styles still come from the
// real market-page CSS slice below.
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
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><style>${
  (() => { const h = readFileSync(join(DAPP, 'classic.html'), 'utf8'); const i = h.indexOf('/* ── Market page (btc-market.js)'); const j = h.indexOf("/* ── TAC's Ethereum trading lane"); return extractRootBlocks(h) + 'body{font-family:monospace;background:#e8e0cc}' + h.slice(i, j); })()
}</style></head><body><div id="host"></div><div id="host2"></div>
<script type="module">
import { mountBtcMarket } from '/btc-market.js';
window.__mount = mountBtcMarket;
window.__ready = true;
</script></body></html>`;

const types = { '.js': 'text/javascript', '.html': 'text/html' };
const srv = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/__harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS); }
  const f = normalize(join(DAPP, p));
  if (!f.startsWith(DAPP) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;

// Installed into the page: a fake ctx whose book and executors each test scripts.
const SETUP = () => {
  const AID = 'aa'.repeat(32);
  const now = Math.floor(Date.now() / 1000);
  const TAC = (n) => String(BigInt(Math.round(n * 1e8)));
  const preauth = (id, tac, sats, extra = {}) => ({ kind: 'preauth', asset_id: AID, sale_id: id, seller_pubkey: '02' + id.padEnd(64, '0'), asset_opening: { amount: TAC(tac), blinding: '11'.repeat(32) }, min_price_sats: sats, expiry: now + 86400, created_at: now - 100, ...extra });
  const intent = (id, tac, sats, extra = {}) => ({ kind: 'intent', asset_id: AID, intent_id: id, maker_pubkey: '03' + id.padEnd(64, '0'), amount: TAC(tac), price_sats: sats, expiry: now + 86400, created_at: now - 100, ...extra });
  const bid = (id, tac, sats, extra = {}) => ({ bid_id: id, asset_id: AID, buyer_pubkey: '02' + id.padEnd(64, 'b'), amount: TAC(tac), price_sats: sats, expiry: now + 86400, created_at: now - 50, min_fill_amount: TAC(tac / 10), remaining_amount: TAC(tac), state: 'OPEN', ...extra });
  const W = window.__w = {
    calls: [], listings: [], bids: [], confirmAnswer: true, fail: {}, statuses: {},
    me: { pubHex: '02' + 'ee'.repeat(32), h160: 'ff'.repeat(20), unlocked: true, sats: 5_000_000, assetBase: BigInt(TAC(1000)) },
    preauth, intent, bid, TAC, AID,
  };
  const rec = (name, args) => { W.calls.push({ name, args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) }); };
  const maybeFail = async (name, key) => {
    const f = W.fail[name];
    if (!f) return;
    const hit = typeof f === 'function' ? f(key) : f;
    if (hit) throw new Error(hit);
  };
  W.ctx = (aid = AID) => ({
    aid,
    asset: () => ({ ticker: 'TAC', decimals: 8, identityHtml: '<b>TAC</b>', markUnit: 200, change24h: -1.5, lastTradeTs: now - 600, vol24Sats: 100000, mcapSats: 1e9, holders: 12 }),
    listings: () => W.listings,
    loadListings: async () => { rec('loadListings', {}); },
    loadBids: async () => W.bids,
    loadStats: async () => ({ trades: [{ ts: now - 60, price_sats: 20000, amount: TAC(100), txid: 'ab'.repeat(32) }] }),
    btcUsd: () => 100000,
    me: () => W.me,
    unlock: async () => { rec('unlock', {}); },
    fundSats: () => rec('fundSats', {}),
    takenIds: () => new Set(),
    flags: { varIntents: false, watchtower: { enabled: true, maxSats: 250000 } },
    exec: {
      takePreauthBatch: async (raws) => { rec('takePreauthBatch', raws.map((r) => r.sale_id)); await maybeFail('takePreauthBatch', raws.map((r) => r.sale_id).join()); return { commit_txid: 'c1'.repeat(32), reveal_txid: 'r1'.repeat(32) }; },
      takeAsk: async (raw, kind, amt, cb) => {
        const id = raw.sale_id || raw.intent_id;
        rec('takeAsk', { id, kind, amt: String(amt) });
        if (kind !== 'preauth') cb?.onClaimed?.();
        await maybeFail('takeAsk', id);
        return { reveal_txid: 'r2'.repeat(32) };
      },
      sellToBid: async (raw, fill) => {
        rec('sellToBid', { id: raw.bid_id, fill: fill == null ? null : String(fill) });
        await maybeFail('sellToBid', raw.bid_id);
        return { offer: { intent_id: 'i' + raw.bid_id.padEnd(31, '0') }, commit_txid: 'c3'.repeat(32) };
      },
      placeBid: async (o) => { rec('placeBid', o); return { bid_id: 'nb'.padEnd(32, '0'), expiry: now + o.expirySec }; },
      registerWatchtower: async (o) => { rec('registerWatchtower', o); },
      listForSale: async (o) => { rec('listForSale', { amountBase: String(o.amountBase), k: o.shape.k, perLotSats: o.shape.perLotSats, unit: o.unit, expirySec: o.expirySec }); return { txid: 'f1'.repeat(32) }; },
      cancelListing: async (raw) => { rec('cancelListing', raw.sale_id); await maybeFail('cancelListing', raw.sale_id); if (W.hold) await W.hold; },
      cancelOffer: async (raw) => rec('cancelOffer', raw.intent_id),
      cancelBid: async (raw) => rec('cancelBid', raw.bid_id),
      ensureAutoConfirm: () => rec('ensureAutoConfirm', {}),
      offerStatus: async ({ intentId }) => W.statuses[intentId] || 'posted',
    },
    after: {
      bought: async (o) => rec('bought', { amount: String(o.amount), ids: o.ids }),
      sold: async (o) => rec('sold', { amount: String(o.amount), ids: o.ids }),
      listed: async () => rec('listed', {}),
    },
    confirm: async (o) => { rec('confirm', { title: o.title }); return W.confirmAnswer; },
    toast: (m, k) => rec('toast', { m, k }),
    // Mirrors the real formatter: a verb names the operation, so a failed cancel is never "Trade failed".
    friendlyError: (e, o) => `${o?.verb || 'Trade'} failed: ${e?.message || String(e)}`,
    onError: (e) => rec('onError', { m: e?.message }),
    goBack: () => rec('goBack', {}),
  });
};

let passed = 0;
const b = await chromium.launch();
async function fresh() {
  const page = await b.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/__harness.html`);
  await page.waitForFunction(() => window.__ready);
  await page.evaluate(SETUP);
  page.errs = errs;
  return page;
}
const mount = (page) => page.evaluate(() => { window.__ctl = window.__mount(document.getElementById('host'), window.__w.ctx()); });
const shot = async (page, n) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${n}.png` }); };
const calls = (page, name) => page.evaluate((n) => window.__w.calls.filter((c) => !n || c.name === n), name);
const settle = (page, ms = 150) => page.waitForTimeout(ms);
async function clickGo(page) { await page.click('[data-k=go]'); await settle(page); }
async function modalPrimary(page) { await page.click('.bm-modal .bm-mfoot .bm-go'); }
async function waitModal(page, re, timeout = 8000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.bm-modal h2')?.textContent || ''), re.source, { timeout });
  return page.textContent('.bm-modal');
}
const test = async (name, fn) => {
  const page = await fresh();
  try { await fn(page); passed++; console.log('  ok  ', name); }
  catch (e) { console.log('  FAIL', name, '\n', e); process.exitCode = 1; }
  finally { if (page.errs.length) { console.log('  page errors:', page.errs); process.exitCode = 1; } await page.close(); }
};

await test('market buy: two listings in one batch, then the seller-confirmed offer; review numbers = what runs', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 20000), W.preauth('p2', 50, 10100), W.intent('i1', 10, 2050)]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '40000'); await settle(page);
  const q = await page.textContent('[data-k=quote]');
  assert.match(q, /You pay32,150 sats/);
  await clickGo(page);
  await shot(page, 'review-buy');
  const rv = await page.textContent('.bm-modal');
  assert.match(rv, /32,150 sats/);
  await modalPrimary(page);
  const done = await waitModal(page, /Bought/);
  await shot(page, 'done-buy');
  assert.match(done, /Bought 160 TAC/);
  const batch = await calls(page, 'takePreauthBatch');
  assert.deepEqual(batch[0].args, ['p1', 'p2']);
  const takes = await calls(page, 'takeAsk');
  assert.deepEqual(takes.map((c) => c.args.id), ['i1']);
  const bought = await calls(page, 'bought');
  assert.equal(bought.reduce((t, c) => t + BigInt(c.args.amount), 0n), 16000000000n);
});

await test('a taken listing re-routes to the next one inside the confirmed price and budget', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 20000), W.preauth('p2', 100, 20200)]; W.fail.takeAsk = (id) => (id === 'p1' ? 'preauth sale not found — refresh listings' : null); });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '20500'); await settle(page);
  await clickGo(page);
  // Confirmed plan: p1 for 20,000 sats at 200/TAC, limit = best × 1.05 = 210.
  await page.evaluate(() => { const W = window.__w; W.listings = W.listings.filter((l) => l.sale_id !== 'p1'); });
  await modalPrimary(page);
  const done = await waitModal(page, /Bought|Nothing/);
  assert.match(done, /Bought 100 TAC/);
  assert.match(done, /re-routed/);
  const takes = (await calls(page, 'takeAsk')).map((c) => c.args.id);
  assert.deepEqual(takes, ['p1', 'p2']);
});

await test('a re-route that would break the price limit stops instead', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 20000), W.preauth('p9', 100, 30000)]; W.fail.takeAsk = (id) => (id === 'p1' ? 'already spent' : null); });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '20000'); await settle(page);
  await clickGo(page);
  await page.evaluate(() => { const W = window.__w; W.listings = W.listings.filter((l) => l.sale_id !== 'p1'); });
  await modalPrimary(page);
  const done = await waitModal(page, /Bought|Nothing/);
  assert.match(done, /Nothing bought/);
  assert.match(done, /within your price limit/);
  assert.deepEqual((await calls(page, 'takeAsk')).map((c) => c.args.id), ['p1']);
});

await test('an error after sats are in flight stops at once and opens recovery', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 10, 2000), W.intent('i1', 10, 2100)]; W.fail.takeAsk = (id) => (id === 'p1' ? 'reveal rejected · Commit tx broadcast — 1200 sats locked at abc:0' : null); });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '4200'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  const done = await waitModal(page, /Nothing|Bought/);
  assert.match(done, /locked at/);
  assert.deepEqual((await calls(page, 'takeAsk')).map((c) => c.args.id), ['p1']);
  assert.equal((await calls(page, 'onError')).length, 1);
});

await test('sell: only auto-settling bids by default; variable bids get an exact chunk; offers tracked to settled', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.bids = [W.bid('b1', 40, 8400, { watchtower: true }), W.bid('b2', 100, 22000)]; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=side][data-v=sell]');
  await page.fill('[data-k=amount]', '25'); await settle(page);
  const q = await page.textContent('[data-k=quote]');
  assert.match(q, /You get5,250 sats/);
  await clickGo(page); await modalPrimary(page);
  await waitModal(page, /Waiting for buyers|Sold/);
  const s = await calls(page, 'sellToBid');
  assert.deepEqual(s.map((c) => c.args), [{ id: 'b1', fill: '2500000000' }]);
  assert.equal((await calls(page, 'ensureAutoConfirm')).length, 1);
  await page.evaluate(() => { window.__w.statuses['i' + 'b1'.padEnd(31, '0')] = 'settled'; });
  await page.evaluate(() => window.__ctl.refresh({ force: true }));
  await waitModal(page, /Sold 25 TAC/, 12000);
  await shot(page, 'sold');
  const toasts = (await calls(page, 'toast')).map((c) => c.args.m);
  assert.ok(toasts.some((m) => /Sold 25 TAC for 5,250 sats/.test(m)));
});

await test('limit buy: crossing part fills now, the rest rests as a bid, watchtower funded for exactly that bid', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 10, 1900)]; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=type][data-v=limit]'); await settle(page);
  await page.fill('[data-k=limit-price]', '195');
  await page.fill('[data-k=amount]', '100'); await settle(page);
  const q = await page.textContent('[data-k=quote]');
  assert.match(q, /Totalup to 19,500 sats/);
  assert.match(q, /Fills now10 TAC for 1,900 sats/);
  await clickGo(page); await modalPrimary(page);
  await waitModal(page, /bid is live|not completed|Done/);
  const pb = (await calls(page, 'placeBid'))[0].args;
  assert.equal(BigInt(pb.amountBase) * 195n <= (19500n - 1900n) * 100000000n, true);
  assert.ok(pb.priceSats <= 19500 - 1900);
  const wt = (await calls(page, 'registerWatchtower'))[0].args;
  assert.equal(wt.priceSats, pb.priceSats);
  assert.equal(wt.amountBase, pb.amountBase);
});

await test('limit sell lists in walk-away pieces', async (page) => {
  await mount(page); await settle(page, 300);
  await page.click('[data-act=side][data-v=sell]');
  await page.click('[data-act=type][data-v=limit]'); await settle(page);
  await page.fill('[data-k=limit-price]', '250');
  await page.fill('[data-k=amount]', '70'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  await waitModal(page, /Listed/);
  const l = (await calls(page, 'listForSale'))[0].args;
  assert.equal(l.k, 7);
  assert.equal(l.amountBase, '7000000000');
  assert.equal(l.perLotSats, 2500);
});

await test('stop after the current step', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.intent('i1', 10, 2000), W.intent('i2', 10, 2010), W.intent('i3', 10, 2020)];
    const orig = W.ctx; W.ctx = () => { const c = orig(); const t = c.exec.takeAsk; c.exec.takeAsk = async (...a) => { await new Promise((r) => setTimeout(r, 400)); return t(...a); }; return c; }; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '6100'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  await settle(page, 100);
  await page.click('.bm-modal .bm-mfoot button');
  await waitModal(page, /Bought/);
  assert.equal((await calls(page, 'takeAsk')).length, 1);
});

await test('cancel your own orders, each with its own executor', async (page) => {
  await page.evaluate(() => { const W = window.__w; const me = W.me.pubHex;
    W.listings = [W.preauth('mp', 10, 3000, { seller_pubkey: me }), W.intent('mi', 10, 3100, { maker_pubkey: me })];
    W.bids = [W.bid('mb', 10, 1500, { buyer_pubkey: me })]; });
  await mount(page); await settle(page, 300);
  const rows = await page.$$eval('.bm-orow', (ns) => ns.length);
  assert.equal(rows, 3);
  for (let i = 0; i < 3; i++) { await page.click(`.bm-orow:nth-child(${i + 1}) [data-act=cancel]`); await settle(page, 200); }
  assert.deepEqual((await calls(page, 'cancelListing')).map((c) => c.args), ['mp']);
  assert.deepEqual((await calls(page, 'cancelOffer')).map((c) => c.args), ['mi']);
  assert.deepEqual((await calls(page, 'cancelBid')).map((c) => c.args), ['mb']);
});

await test('a cancel runs once however often it is clicked, and says so while it runs', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('mp', 10, 3000, { seller_pubkey: W.me.pubHex })]; W.hold = new Promise((r) => { W.release = r; }); });
  await mount(page); await settle(page, 300);
  await page.click('.bm-orow [data-act=cancel]'); await settle(page, 150);
  assert.equal(await page.$('.bm-orow [data-act=cancel]'), null, 'no second Cancel while one runs');
  assert.match(await page.$eval('.bm-orow', (n) => n.textContent), /cancelling/);
  await page.evaluate(() => window.__ctl.refresh({ force: true })); await settle(page, 150);
  assert.match(await page.$eval('.bm-orow', (n) => n.textContent), /cancelling/, 'a live refresh keeps it');
  await page.evaluate(() => window.__w.release()); await settle(page, 300);
  assert.equal((await calls(page, 'cancelListing')).length, 1);
  assert.equal((await calls(page, 'confirm')).length, 1);
  assert.equal((await calls(page, 'toast')).filter((c) => /Order cancelled/.test(c.args.m)).length, 1);
});

await test('a failed cancel names the cancel, not a trade', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('mp', 10, 3000, { seller_pubkey: W.me.pubHex })]; W.fail.cancelListing = 'listed UTXO no longer in your wallet'; });
  await mount(page); await settle(page, 300);
  await page.click('.bm-orow [data-act=cancel]'); await settle(page, 200);
  const toasts = (await calls(page, 'toast')).map((c) => c.args);
  assert.deepEqual(toasts.map((t) => t.m), ['Cancel failed: listed UTXO no longer in your wallet']);
  assert.equal(toasts[0].k, 'error');
  assert.ok(await page.$('.bm-orow [data-act=cancel]'), 'the Cancel button is back to retry');
});

await test('typing and focus survive live refreshes; a row click primes the ticket', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 20000)]; W.bids = [W.bid('b1', 10, 1800, { watchtower: true })]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '1234'); await page.focus('[data-k=amount]');
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__ctl.refresh({ force: true }));
  await settle(page, 200);
  assert.equal(await page.inputValue('[data-k=amount]'), '1234');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.k), 'amount');
  await page.click('.bm-row.bid');
  assert.equal(await page.getAttribute('[data-act=side][data-v=sell]', 'aria-selected'), 'true');
  assert.equal(await page.inputValue('[data-k=amount]'), '10');
});

await test('mounting a different asset replaces the page instead of reusing it', async (page) => {
  await mount(page); await settle(page, 200);
  await page.fill('[data-k=amount]', '999');
  await page.evaluate(() => { window.__ctl2 = window.__mount(document.getElementById('host'), window.__w.ctx('bb'.repeat(32))); });
  await settle(page, 200);
  assert.equal(await page.getAttribute('.bm', 'data-aid'), 'bb'.repeat(32));
  assert.equal(await page.inputValue('[data-k=amount]'), '');
});

await test('after switching asset, one Review click opens exactly one dialog (the new asset\'s)', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 20000)]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '20000');
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('q1', 100, 20000, { asset_id: 'bb'.repeat(32) })];
    window.__ctl = window.__mount(document.getElementById('host'), W.ctx('bb'.repeat(32))); });
  await settle(page, 300);
  await page.fill('[data-k=amount]', '20000'); await settle(page);
  await clickGo(page);
  assert.equal(await page.$$eval('.bm-modal', (n) => n.length), 1);
});

await test('a listing edited since review is not paid — the page re-routes instead', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 20000), W.preauth('p2', 100, 20100)]; W.fail.takeAsk = (id) => (id === 'p1' ? 'listing changed since you reviewed it — stale' : null); });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '20500'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  const done = await waitModal(page, /Bought|Nothing/);
  assert.match(done, /Bought 100 TAC/);
  assert.deepEqual((await calls(page, 'takeAsk')).map((c) => c.args.id), ['p1', 'p2']);
});

await test('a sell whose bid claim fails after the offer posted stops — no re-route onto other bids', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.bids = [W.bid('b1', 10, 2100, { watchtower: true }), W.bid('b2', 10, 2000, { watchtower: true })];
    const orig = W.ctx; W.ctx = (a) => { const c = orig(a); c.exec.sellToBid = async (raw) => { W.calls.push({ name: 'sellToBid', args: raw.bid_id }); throw Object.assign(new Error("the bid couldn't take your offer (<b>bid already claimed</b>). Your offer was withdrawn"), { noReroute: true }); }; return c; }; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=side][data-v=sell]');
  await page.fill('[data-k=amount]', '10'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  const done = await waitModal(page, /Nothing sold|Waiting/);
  assert.match(done, /withdrawn/);
  assert.deepEqual((await calls(page, 'sellToBid')).map((c) => c.args), ['b1']);
  assert.equal(await page.$$eval('.bm-modal b', (n) => n.length), 0, 'error text is escaped, not rendered as HTML');
});

await test('Escape does not close a running order', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.intent('i1', 10, 2000)];
    const orig = W.ctx; W.ctx = (a) => { const c = orig(a); const t = c.exec.takeAsk; c.exec.takeAsk = async (...x) => { await new Promise((r) => setTimeout(r, 600)); return t(...x); }; return c; }; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '2000'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  await settle(page, 100);
  await page.keyboard.press('Escape');
  await settle(page, 100);
  assert.equal(await page.$$eval('.bm-modal', (n) => n.length), 1);
  await waitModal(page, /Bought/);
});

await test('at my price: any two of price, amount, total set the third; a row click sets the price', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 100, 25000)]; W.bids = [W.bid('b1', 10, 1900, { watchtower: true })]; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=type][data-v=limit]'); await settle(page);
  await page.fill('[data-k=limit-price]', '200');
  await page.fill('[data-k=amount]', '50'); await settle(page);
  assert.equal(await page.inputValue('[data-k=total]'), '10000');
  await page.fill('[data-k=total]', '30000'); await settle(page);
  assert.equal(await page.inputValue('[data-k=amount]'), '150');
  await page.fill('[data-k=limit-price]', '300'); await page.dispatchEvent('[data-k=limit-price]', 'input'); await settle(page);
  assert.equal(await page.inputValue('[data-k=amount]'), '100', 'total anchored: amount follows the price');
  await page.click('.bm-row.bid'); await settle(page);
  assert.equal(await page.inputValue('[data-k=limit-price]'), '190.00');
  assert.equal(await page.getAttribute('[data-act=type][data-v=limit]', 'aria-pressed'), 'true');
  assert.match(await page.textContent('[data-k=mode-note]'), /Name your price/);
});

await test('a buy that only fits above the price limit offers a one-tap raise, and the review keeps it', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('big', 5000, 1000000), W.preauth('p2', 100, 26500)]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '60000'); await settle(page);
  assert.equal(await page.isDisabled('[data-k=go]'), true);
  await page.click('[data-act=allow-price]'); await settle(page);
  assert.match(await page.textContent('[data-k=quote]'), /You pay26,500 sats/);
  assert.match(await page.textContent('[data-k=opts-sum]'), /Max price 265\.00/);
  await clickGo(page);
  assert.match(await page.textContent('.bm-modal'), /at most 265\.00 sats\/TAC/);
});

await test('at my price warns when you already have an open order at that price', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.bids = [W.bid('mine', 25, 5000, { buyer_pubkey: W.me.pubHex })]; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=type][data-v=limit]'); await settle(page);
  await page.fill('[data-k=limit-price]', '200');
  await page.fill('[data-k=amount]', '30'); await settle(page);
  assert.match(await page.textContent('[data-k=quote]'), /already have an open bid for 25 TAC at this price/);
  await page.fill('[data-k=limit-price]', '150'); await page.dispatchEvent('[data-k=limit-price]', 'input'); await settle(page);
  assert.doesNotMatch(await page.textContent('[data-k=quote]'), /already have an open/);
});

await test('a limit buy never fills more than the amount asked for', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('big', 200, 1000)]; });
  await mount(page); await settle(page, 300);
  await page.click('[data-act=type][data-v=limit]'); await settle(page);
  await page.fill('[data-k=limit-price]', '10');
  await page.fill('[data-k=amount]', '100'); await settle(page);
  await clickGo(page);
  assert.doesNotMatch(await page.textContent('.bm-modal'), /Fills now/);
  await modalPrimary(page);
  await waitModal(page, /bid is live/i);
  assert.equal((await calls(page, 'takeAsk')).length, 0);
  assert.equal((await calls(page, 'placeBid'))[0].args.amountBase, '10000000000');
});

await test('a buy far above the last trade says so before review', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('hi', 10, 3000)]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '3000'); await settle(page);
  assert.match(await page.textContent('[data-k=quote]'), /above the last trade/);
});

await test('review re-reads a stale book and shows the new quote instead of a gone offer', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 10, 2000), W.preauth('p2', 10, 2600)]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '2000'); await settle(page);
  await page.evaluate(() => { window.__ctl.state.lastOk = Date.now() - 60_000; window.__w.listings = [window.__w.preauth('p2', 10, 2600)]; });
  await page.click('[data-k=go]'); await settle(page, 400);
  assert.equal(await page.$$eval('.bm-modal', (n) => n.length), 0);
  assert.ok((await calls(page, 'toast')).some((c) => /Prices changed/.test(c.args.m)));
});

await test('a finished order closes with Escape', async (page) => {
  await page.evaluate(() => { const W = window.__w; W.listings = [W.preauth('p1', 10, 2000)]; });
  await mount(page); await settle(page, 300);
  await page.fill('[data-k=amount]', '2000'); await settle(page);
  await clickGo(page); await modalPrimary(page);
  await waitModal(page, /Bought/);
  await page.keyboard.press('Escape'); await settle(page, 100);
  assert.equal(await page.$$eval('.bm-modal', (n) => n.length), 0);
});

await b.close();
srv.close();
console.log(`btc-market flows: ${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
