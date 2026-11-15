#!/usr/bin/env node
// Splitting a TAC note on Bitcoin and bridging the two notes: what the front page's Bridge tab and TAC's page say before the split, while its two notes
// wait, and once they can go. In a real browser under the page's own CSP, with a pasted key. The Bitcoin read is the page's own (loadBridge -> scanHoldings)
// with the holdings the scan would return put in its place per phase (pre: one confirmed 2,000 TAC note the proof tracks; post: the split's two 1,000 TAC
// notes in the mempool; conf: both confirmed, Bitcoin's proof not at their block; ready: and the proof there), the fee rates are answered here, and the
// broadcast of the split is answered here (it moves the phase to post, after `lag` scans that still show nothing, as a slow indexer does):
//   · a bridge takes a note of any size, so the Bridge tab offers the 2,000 TAC note whole and no split, and says no Ethereum gas is needed;
//   · TAC's page splits it (Manage your TAC, tick the note, Split): the card says what stays and sends nothing until its own press;
//   · after the split both notes are named (what was split off, what was kept), both are listed once the indexer shows them, without a refresh,
//     and the page says each is waiting for the Bitcoin confirmation;
//   · once confirmed, a note Bitcoin's proof has not reached says so and cannot be picked; once it has, both can;
//   · TAC's page: "Getting ready" names both notes, and the page has a way to every address and says no Ethereum gas is needed.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/bridge-split-ux.mjs      (DAPP=<dir> to try another build)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 34000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, path);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const KEY = '11'.repeat(31) + '22';
const PUB = '02372e17b2c6239bd83517433b83aee90b84ab9c9ab21a40886e54bcbe6afbcc10';
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const SPLIT_TX = 'ee'.repeat(32);
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const COIN = [{ txid: 'aa'.repeat(32), vout: 0, value: 250000, status: { confirmed: true, block_height: 900000, block_time: 1700000000 } }];
const STUBS = `
_testSetScanHoldingsOverride(() => (globalThis.__held ? globalThis.__held() : new Map()));
{
  const real = buildAndBroadcastCXfer;
  buildAndBroadcastCXfer = async () => { sessionStorage.setItem('__phase', 'post'); sessionStorage.setItem('__lag', '2'); sessionStorage.setItem('__sent', String((Number(sessionStorage.getItem('__sent')) || 0) + 1)); return { revealTxid: '${SPLIT_TX}' }; };
  const ux = _burndepUxSingleton;
  _burndepUxSingleton = function () {
    const u = ux.apply(this, arguments);
    if (!u.__split) {
      u.__split = true;
      u.noteTracking = async (ns) => new Map(ns.map((x) => [x.txid + ':' + x.vout, /^(pre|ready)$/.test(sessionStorage.getItem('__phase') || 'pre') ? 'tracked' : 'new']));
    }
    return u;
  };
}
`;
const TACIT_JS = readFileSync(join(DAPP, 'tacit.js'), 'utf8') + '\n' + STUBS;

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W) || 1280, height: 1500 }, serviceWorkers: 'block' });
await ctx.addInitScript(({ TAC, SPLIT_TX }) => {
  window.__held = () => {
    const ph = sessionStorage.getItem('__phase') || 'pre';
    let rows = ph === 'pre' ? [{ id: 'cc', vout: 0, amount: '200000000000', conf: true }]
      : [{ id: SPLIT_TX.slice(0, 2), vout: 0, amount: '100000000000', conf: ph !== 'post' }, { id: SPLIT_TX.slice(0, 2), vout: 1, amount: '100000000000', conf: ph !== 'post' }];
    const lag = Number(sessionStorage.getItem('__lag')) || 0;
    if (ph === 'post' && lag > 0) { sessionStorage.setItem('__lag', String(lag - 1)); rows = []; }
    const g = { assetIdHex: TAC, ticker: 'TAC', decimals: 8, balance: 0n, utxos: [], unverified: [] };
    for (const s of rows) { g.utxos.push({ utxo: { txid: s.id.repeat(32), vout: s.vout, value: 546, status: s.conf ? { confirmed: true, block_height: 900100 } : { confirmed: false } }, amount: BigInt(s.amount) }); g.balance += BigInt(s.amount); }
    return rows.length ? new Map([[TAC, g]]) : new Map();
  };
}, { TAC, SPLIT_TX });
await ctx.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) {
    if (new URL(u).pathname === '/tacit.js') return r.fulfill({ status: 200, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }, body: TACIT_JS });
    return r.continue();
  }
  if (/\/address\/[^/]+\/utxo/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(COIN) });
  if (/\/reflection\/status/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ attestedHeight: globalThis.__refl || 899000 }) });
  if (/\/v1\/fees\/recommended/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ fastestFee: 4, halfHourFee: 3, hourFee: 2, economyFee: 1, minimumFee: 1 }) });
  if (/\/fee-estimates/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ 1: 4, 3: 3, 6: 2, 144: 1 }) });
  return r.abort();
});
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const rows = () => page.$$eval('#hx-routes [data-hxr]', (xs) => xs.map((e) => ({ t: e.innerText.replace(/\s+/g, ' ').trim(), off: e.disabled }))).catch(() => []);
const shot = async (sel, name) => { if (process.env.SHOT) await page.locator(sel).screenshot({ path: process.env.SHOT.replace(/\.png$/, `-${name}.png`) }).catch(() => {}); };
const phase = (p, extra = {}) => page.evaluate(({ p, extra, PUB, SPLIT_TX }) => {
  sessionStorage.setItem('__phase', p);
  const m = JSON.parse(localStorage.getItem('tacit-lite-bridge-prep-v1') || '{}');
  if (extra.prep === null) delete m[PUB]; else if (extra.prep) m[PUB] = [{ txid: SPLIT_TX, amount: '100000000000', keep: '100000000000', at: Date.now() - 3600e3, ...extra.prep }];
  localStorage.setItem('tacit-lite-bridge-prep-v1', JSON.stringify(m));
}, { p, extra, PUB, SPLIT_TX });

async function openWallet() {
  await page.waitForSelector('#wallet', { timeout: 45000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});
}
async function tileBridge() {
  await page.waitForSelector('#hx [data-hxm="more"]', { timeout: 45000 });
  await page.click('#hx [data-hxm="more"]');
  await page.click('#hx [data-hxm="bridge"]').catch(() => {});
  await page.waitForSelector('#hx-tab-bridge[aria-selected="true"]', { timeout: 10000 }).catch(() => {});
}
const until = (re, sel = '#hx', ms = 40000) => page.waitForFunction(({ re, sel }) => new RegExp(re).test(document.querySelector(sel)?.innerText || ''), { re, sel }, { timeout: ms }).then(() => true, () => false);
async function sheet(want = 'label.brn') {
  await page.goto(BASE + '/tac/#bridge', { waitUntil: 'commit' });
  await page.waitForSelector('#bridge-body', { timeout: 60000, state: 'attached' }).catch(() => {});
  await page.evaluate(() => { const d = document.querySelector('#tpg-where'); if (d) d.open = true; }).catch(() => {});
  await page.waitForSelector(`#bridge-body ${want}`, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

try {
  // ── the Bridge tab, one 2,000 TAC note: a bridge takes it whole
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await openWallet();
  await tileBridge();
  ok(await until('ready to bridge', '#hx-routes'), `tile: the 2,000 TAC note is ready to bridge (${JSON.stringify((await rows()).map((r) => r.t))})`);
  ok(/^Bridge TAC from Bitcoin$/.test(await text('#hx-go')) && !/split/i.test(await text('#hx-routes') + await text('#hx-go') + await text('#hx-receipt')), `tile: the button bridges it, and nothing offers a split (${await text('#hx-go')})`);
  let rc = await text('#hx-receipt');
  ok(/Ethereum gas\s*none: the relay sends it/.test(rc), 'tile: and no Ethereum gas is needed');
  await shot('#hx', 'tile-1-whole');

  // ── TAC's page splits it: a card that says what stays, then its press; the indexer shows nothing for the first two scans after
  await page.goto(BASE + '/tac/', { waitUntil: 'commit' });
  await page.waitForSelector('#tpg-notes:not([hidden]) [data-tn-open]', { timeout: 60000 }).catch(() => {});
  await page.click('#tpg-notes [data-tn-open]');
  await page.waitForSelector('#tac-notes[open] input[data-tn]:not([disabled])', { timeout: 30000 }).catch(() => {});
  await page.click('#tac-notes input[data-tn]');
  await page.click('#tac-notes [data-tn-act="split"]');
  await page.fill('#tn-amt', '1000');
  ok(/Split 2,000 TAC/.test(await text('#tn-cf')) && /^1,000 TAC$/.test(await text('#tn-keep')), `sheet: Split asks how much and says what stays (${(await text('#tn-cf')).slice(0, 160)})`);
  ok(await page.waitForSelector('#tn-go:not([disabled])', { timeout: 30000 }).then(() => true, () => false), `sheet: and its press opens once the Bitcoin fee is read (${await text('#tn-fee')})`);
  ok((await page.evaluate(() => Number(sessionStorage.getItem('__sent')) || 0)) === 0, 'sheet: nothing is sent before that press');
  await shot('#tac-notes', 'sheet-1-split');
  await page.click('#tn-go');
  ok(await until('Split: 1,000 TAC to your own address, 1,000 TAC kept in a note of its own', '#tn-st', 30000), `sheet: the split says both notes (${(await text('#tn-st')).slice(0, 220)})`);
  ok((await page.evaluate(() => Number(sessionStorage.getItem('__sent')) || 0)) === 1, 'sheet: and sent one transaction');
  ok(!/No TAC on this key’s Bitcoin address/.test(await text('#tac-notes')), `sheet: while the indexer shows nothing yet it does not say the key holds no TAC (${(await text('#tac-notes')).slice(0, 160)})`);
  ok(await page.waitForFunction(() => document.querySelectorAll('#tac-notes input[data-tn]').length === 2, null, { timeout: 60000 }).then(() => true, () => false), 'sheet: both notes are listed without a refresh, though the indexer showed nothing at first');
  const tn = await page.$$eval('#tac-notes label.tn-r', (xs) => xs.map((e) => ({ t: e.innerText.replace(/\s+/g, ' ').trim(), off: e.querySelector('input').disabled }))).catch(() => []);
  ok(tn.length === 2 && tn.every((r) => r.off && /1,000 TAC/.test(r.t) && /waiting for its confirmation/.test(r.t)), `sheet: each waits for the Bitcoin confirmation and cannot be ticked yet (${JSON.stringify(tn)})`);
  ok(/1 getting ready/.test(await text('#tac-notes')), `sheet: and the split is followed as getting ready (${(await text('#tac-notes')).slice(-160)})`);
  await shot('#tac-notes', 'sheet-2-after-split');
  await page.keyboard.press('Escape');

  // ── the Bridge tab, the split's two notes in the mempool
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await tileBridge();
  ok(await page.waitForFunction(() => document.querySelectorAll('#hx-routes [data-hxr]').length === 2, null, { timeout: 60000 }).then(() => true, () => false), 'tile: both notes are listed');
  ok(await until('Balance 2,000', '#hx-bal', 30000), `tile: and the From field's balance follows (${await text('#hx-bal')})`);
  let rs = await rows();
  ok(rs.length === 2 && rs.every((r) => /waiting for its Bitcoin confirmation/.test(r.t) && /from your split/.test(r.t) && !/unconfirmed/.test(r.t)), `tile: each says it waits for the confirmation and is from the split, in words (${JSON.stringify(rs.map((r) => r.t))})`);
  await shot('#hx', 'tile-2-after-split');
  const have = await text('#hx-have');
  ok(/2 notes waiting for the Bitcoin confirmation/.test(have) && !/the Bridge tab says why/.test(have), `tile: the line under says what they wait for, and sends nobody to the tab they are on (${have.slice(0, 200)})`);
  ok(!!(await page.$('#hx-have [data-hxaddr]')), 'tile: and has a way to the addresses');
  const callouts = await page.$$eval('.callout', (xs) => xs.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
  ok(callouts.some((c) => /1,000 TAC and 1,000 TAC from your split are getting ready to bridge/.test(c)), `tile: the callout names both notes (${JSON.stringify(callouts).slice(0, 200)})`);

  // ── confirmed on Bitcoin, Bitcoin's proof on Ethereum not there yet
  await phase('conf', { prep: { height: 900100 } });
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await tileBridge();
  ok(await until('waiting for Bitcoin’s proof on Ethereum', '#hx-routes'), 'tile: a confirmed note the proof has not reached says so');
  rs = await rows();
  ok(rs.length === 2 && rs.every((r) => !r.off && !/ready to bridge/.test(r.t) && /pick it to see if the fast bridge can take it now/.test(r.t)), `tile: it can be picked only to ask the fast bridge, which does not wait for that proof (${JSON.stringify(rs.map((r) => r.t))})`);
  await page.click('#hx-routes [data-hxr]');
  ok(await until('Confirmed, waiting for Bitcoin’s proof on Ethereum to reach it, usually a few hours\\. The fast bridge has no provider for it right now', '#hx', 30000), `tile: and with no provider it says what the note waits for, and sends nothing (${(await text('#hx-q')).slice(0, 200)})`);
  ok(/Bridge TAC from Bitcoin/.test(await text('#hx-go')), 'tile: and the button is the plain one');
  ok(/2 notes confirmed, waiting for Bitcoin’s proof/.test(await text('#hx-have')), 'tile: the line under counts them');
  await shot('#hx', 'tile-3-waiting-proof');
  await page.evaluate(() => localStorage.setItem('tacit-fast-route-off-v1', '1'));
  await page.reload({ waitUntil: 'commit' });
  await tileBridge();
  ok(await until('waiting for Bitcoin’s proof on Ethereum', '#hx-routes'), 'tile: with the fast bridge off the notes are listed the same');
  rs = await rows();
  ok(rs.length === 2 && rs.every((r) => r.off), `tile: and cannot be picked, the regular bridge has to wait for the proof (${JSON.stringify(rs)})`);
  await page.evaluate(() => localStorage.removeItem('tacit-fast-route-off-v1'));

  await sheet();
  let body = await text('#bridge-body');
  ok(/Getting ready 1,000 TAC and 1,000 TAC Split/.test(body), `sheet: Getting ready names both notes (${body.slice(0, 40)}…)`);
  ok(/Both notes can be bridged once Bitcoin’s proof on Ethereum reaches that block/.test(body), 'sheet: and says both wait for the proof');
  await shot('#bridge-body', 'sheet-3-waiting-proof');
  const lab = await page.$$eval('#bridge-body label.brn', (xs) => xs.map((e) => ({ t: e.innerText.replace(/\s+/g, ' ').trim(), off: e.querySelector('input').disabled })));
  ok(lab.length === 2 && lab.every((l) => l.off && /From your split · Confirmed, waiting for Bitcoin’s proof on Ethereum/.test(l.t)), `sheet: each note says it is from the split and what it waits for, and cannot be picked (${JSON.stringify(lab)})`);

  // ── the proof has reached them
  globalThis.__refl = 900200;
  await phase('ready', { prep: { height: 900100 } });
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await tileBridge();
  ok(await until('ready to bridge', '#hx-routes'), 'tile: once the proof has reached them both are ready');
  rs = await rows();
  ok(rs.length === 2 && rs.every((r) => !r.off && /ready to bridge · from your split/.test(r.t)), `tile: and can be picked (${JSON.stringify(rs.map((r) => r.t))})`);

  // ── TAC's page, the two notes ready
  await sheet();
  body = await text('#bridge-body');
  ok(/needs no Ethereum gas: the relay sends the Ethereum side/.test(body), 'sheet: says no Ethereum gas is needed');
  const lab2 = await page.$$eval('#bridge-body label.brn', (xs) => xs.map((e) => ({ t: e.innerText.replace(/\s+/g, ' ').trim(), off: e.querySelector('input').disabled })));
  ok(lab2.length === 2 && lab2.every((l) => !l.off && /From your split/.test(l.t)), `sheet: both notes from the split can be picked (${JSON.stringify(lab2)})`);

  // ── the way to the addresses
  await page.click('#br-addrs');
  ok(await page.waitForFunction(() => !!document.querySelector('#sheet-wallet[open] #w-keys details[open]'), null, { timeout: 15000 }).then(() => true, () => false), 'sheet: the link opens the wallet sheet with its addresses open');
  const keys = await text('#w-keys');
  ok(/Holds your TAC on Bitcoin, and pays Bitcoin fees in sats/.test(keys) && /A bridge from Bitcoin needs none/.test(keys), `wallet: each address says what it is for (${keys.slice(0, 160)})`);
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nbridge split checks passed (${n})`);
process.exit(fails ? 1 : 0);
