#!/usr/bin/env node
// The front page's Bridge tab, bridging back from Bitcoin, in a real browser under the page's own CSP, with a pasted key. The Bitcoin read is the page's own
// (loadBtc -> scanHoldings) with the holdings the scan would return put in its place (tacit.js has a hook for it, and this test appends the line that reaches
// it), and the bridge's check of a note (preflight, which reads the note's history from Bitcoin) answers that it burns in one Bitcoin transaction; the Bitcoin
// address's coins are answered here and every other host refused:
//   · with no Tacit wallet open, the From field asks for it (a button that opens it) and so does the main button;
//   · with the wallet open and TAC from Bitcoin picked, the From field says how much TAC the key holds on Bitcoin, at TAC's 4 places as the wallet sheet
//     does, and offers no Max (notes go whole);
//   · a bridge takes a note of any size: the one note, of millions of TAC, is picked, the card quotes bridging all of it, and a first press asks for a second;
//   · the From picker gives the amount beside "TAC, on Bitcoin", and beside tETH on Bitcoin when that way is offered.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/bridge-btc-balance.mjs      (DAPP=<dir> to try another build, INDEX=<file> another front page)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = process.env.INDEX && (path === '/' || path === '/index.html') ? process.env.INDEX : join(DAPP, path);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const KEY = '11'.repeat(31) + '22';
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const COIN = [{ txid: 'aa'.repeat(32), vout: 0, value: 250000, status: { confirmed: true, block_height: 900000, block_time: 1700000000 } }];
const STUBS = `
_testSetScanHoldingsOverride(() => (globalThis.__held ? globalThis.__held() : new Map()));
{
  const ux = _burndepUxSingleton;
  _burndepUxSingleton = function () {
    const u = ux.apply(this, arguments);
    u.preflight = async () => ({ ok: true, path: 'reflected', burnFeeRate: 5, steps: [{ name: 'reflected', ok: true }, { name: 'fee-estimate', ok: true }] });
    return u;
  };
}
`;
const TACIT_JS = readFileSync(join(DAPP, 'tacit.js'), 'utf8') + '\n' + STUBS;

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
// a fresh browser context whose Bitcoin address holds `spec` ([{ asset, id, amount }], amount in the asset's smallest unit, as a string)
async function contextWith(spec) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, serviceWorkers: 'block' });
  await ctx.addInitScript((spec) => {
    const by = new Map();
    for (const s of spec) {
      const g = by.get(s.asset) || { assetIdHex: s.asset, ticker: 'TAC', decimals: 8, balance: 0n, utxos: [], unverified: [] };
      g.utxos.push({ utxo: { txid: s.id.repeat(32), vout: 0, status: { confirmed: true } }, amount: BigInt(s.amount) });
      g.balance += BigInt(s.amount);
      by.set(s.asset, g);
    }
    window.__held = () => new Map(by);
  }, spec);
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE)) {
      if (new URL(u).pathname === '/tacit.js') return r.fulfill({ status: 200, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }, body: TACIT_JS });
      return r.continue();
    }
    if (/\/address\/[^/]+\/utxo/.test(u)) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(COIN) });
    return r.abort();
  });
  return ctx;
}
try {
  const ctx = await contextWith([
    { asset: TAC, id: 'cc', amount: '638843749052500' },
    { asset: TETH, id: 'dd', amount: '150000000' },
  ]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const shot = async (name) => { if (process.env.SHOT) await page.locator('#hx').screenshot({ path: process.env.SHOT.replace(/\.png$/, `-${name}.png`) }); };
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#hx [data-hxm="more"]', { timeout: 30000 });

  // no Tacit wallet open yet
  await page.click('#hx [data-hxm="more"]');
  await page.click('#hx [data-hxm="bridge"]').catch(() => {});
  await page.waitForSelector('#hx-tab-bridge[aria-selected="true"]', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('#hx-bal [data-signin]', { timeout: 10000 }).catch(() => {});
  ok(/Open your Tacit wallet to see it/.test(await text('#hx-bal [data-signin]')), `with no wallet open the From field asks for it: "${await text('#hx-bal')}"`);
  await page.waitForFunction(() => /Open your Tacit wallet/.test(document.querySelector('#hx-go')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  ok(/Open your Tacit wallet to bridge/.test(await text('#hx-go')), `and so does the button: "${await text('#hx-go')}"`);
  await shot('out');
  await page.click('#hx-bal [data-signin]');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  ok(true, 'that button opens the wallet sheet');

  await page.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.click('#wallet'); if (await page.$('#acct-pop:not([hidden])')) await page.click('#acct-pop [data-acct="wallet"]');      // (with a key open the chip is the account's menu, and the wallet sheet its first entry)
  await page.waitForSelector('#wbal-re:not([disabled])', { timeout: 30000 });
  await page.click('#wbal-re');
  await page.waitForFunction(() => /6,388,437\.49/.test(document.querySelector('#wbal-box')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
  ok(/6,388,437\.49/.test(await text('#wbal-box')), 'the wallet sheet shows the TAC held on Bitcoin');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});

  // the wallet open, TAC from Bitcoin
  const from = await page.$eval('#hx-from', (s) => s.value).catch(() => '');
  ok(from === 'btc', `the Bridge tab is on TAC from Bitcoin (${from})`);
  await page.waitForFunction(() => /6,388,437/.test(document.querySelector('#hx-bal')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const bal = await text('#hx-bal');
  ok(/^Balance 6,388,437\.4905 · See notes$/.test(bal), `the From field says how much TAC is on Bitcoin, to 4 places: "${bal}"`);
  const max = await page.$eval('#hx-max', (b) => ({ off: b.disabled, t: b.textContent })).catch(() => null);
  ok(!!max && !max.off && !/Max/.test(max.t), 'and offers no Max, since notes bridge whole, but a way to the notes instead of a dead button');
  ok(!(await page.$('#hx-bal .quick')), 'and no quick amounts');
  ok(/whole notes, picked below/.test(await text('#hx .f .say')), `the From field points to where the note is picked: "${await text('#hx .f .say')}"`);

  // the one note, of millions of TAC, bridges whole: it is picked and the card quotes all of it
  await page.waitForFunction(() => /Bitcoin fee\s*about/.test(document.querySelector('#hx-receipt')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const row = await page.$eval('#hx-routes [data-hxr]', (b) => ({ off: b.disabled, on: b.getAttribute('aria-checked'), t: b.textContent.replace(/\s+/g, ' ').trim() })).catch(() => null);
  ok(!!row && !row.off && row.on === 'true' && /ready to bridge/.test(row.t) && !/split/i.test(row.t), `the note is picked and ready to bridge, with no split asked: ${row && row.t}`);
  ok(/^Bridge TAC from Bitcoin$/.test(await text('#hx-go')), `the button bridges it: "${await text('#hx-go')}"`);
  const rc = await text('#hx-receipt');
  ok(/Arrives\s*6,388,437\.4905 private TAC on Ethereum/.test(rc) && /Bitcoin fee\s*about [\d,]+ sats/.test(rc) && !/Splits off|Keeps/.test(rc), `the receipt says all of it arrives, and the Bitcoin fee: ${rc}`);
  await shot('whole');
  await page.click('#hx-max');
  ok(await page.evaluate(() => !!document.activeElement?.matches('#hx-routes [data-hxr]')), 'pressing Balance goes to the notes list and lands on the note');
  await page.click('#hx-go');
  await page.waitForFunction(() => /Press again to bridge it/.test(document.querySelector('#hx-ss')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const ask = await text('#hx-ss');
  ok(/^Bridging 6,388,437\.4905 TAC costs about [\d,]+ sats from your Bitcoin address\. .*Press again to bridge it\.$/.test(ask), `a first press asks for a second, naming all of it: "${ask}"`);

  await page.click('[data-pk="hx-from"]');
  await page.waitForSelector('.pk .pk-r[data-v="btc"]', { timeout: 10000 });
  await page.waitForFunction(() => /6,388,437/.test(document.querySelector('.pk .pk-r[data-v="btc"] em')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const pk = await text('.pk .pk-r[data-v="btc"] em');
  ok(pk === '6,388,437.4905', `the From picker gives the amount beside TAC on Bitcoin: "${pk}"`);
  if (await page.$('.pk .pk-r[data-v="tb"]')) {
    const tb = await text('.pk .pk-r[data-v="tb"] em');
    ok(/^1\.5/.test(tb), `and beside tETH on Bitcoin: "${tb}"`);
  }
  await page.keyboard.press('Escape');
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
  await ctx.close();

  // 2,000 TAC in two notes of 1,000 each, both under the cap: Balance leads to the notes and each note can be picked
  {
    const c2 = await contextWith([{ asset: TAC, id: 'cc', amount: '100000000000' }, { asset: TAC, id: 'dd', amount: '100000000000' }]);
    const p2 = await c2.newPage();
    const errs2 = []; p2.on('pageerror', (e) => errs2.push(String(e.message || e)));
    const t2 = (sel) => p2.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    await p2.goto(BASE + '/', { waitUntil: 'commit' });
    await p2.waitForSelector('#wallet', { timeout: 30000 });
    await p2.click('#wallet'); if (await p2.$('#acct-pop:not([hidden])')) await p2.click('#acct-pop [data-acct="wallet"]');
    await p2.waitForSelector('#ws-in', { timeout: 15000 });
    await p2.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
    await p2.click('#ws-in [data-in="paste"]');
    await p2.fill('#ws-hex', KEY);
    await p2.click('#ws-in [data-in="key"]');
    await p2.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
    await p2.click('#wallet'); if (await p2.$('#acct-pop:not([hidden])')) await p2.click('#acct-pop [data-acct="wallet"]');
    await p2.waitForSelector('#wbal-re:not([disabled])', { timeout: 30000 });
    await p2.click('#wbal-re');
    await p2.waitForFunction(() => /2,000/.test(document.querySelector('#wbal-box')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
    await p2.keyboard.press('Escape');
    await p2.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});
    await p2.click('#hx [data-hxm="more"]');
    await p2.click('#hx [data-hxm="bridge"]').catch(() => {});
    await p2.waitForFunction(() => document.querySelectorAll('#hx-routes [data-hxr]').length === 2, null, { timeout: 40000 }).catch(() => {});
    ok(/^Balance 2,000 · See notes$/.test(await t2('#hx-bal')), `two notes of 1,000: "${await t2('#hx-bal')}"`);
    const rows = await p2.$$eval('#hx-routes [data-hxr]', (bs) => bs.map((b) => ({ off: b.disabled, on: b.getAttribute('aria-checked') })));
    ok(rows.length === 2 && rows.every((r) => !r.off && r.on === 'false'), `both can be picked and none is yet: ${JSON.stringify(rows)}`);
    await p2.click('#hx-max');
    ok(await p2.evaluate(() => document.activeElement === document.querySelector('#hx-routes [data-hxr]')), 'Balance lands on the first note');
    await p2.click('#hx-routes [data-hxr]:nth-of-type(2)');
    const after = await p2.$$eval('#hx-routes [data-hxr]', (bs) => bs.map((b) => b.getAttribute('aria-checked')));
    ok(after.join() === 'false,true', `picking the second note picks it: ${after}`);
    ok(errs2.length === 0, `no page errors${errs2.length ? ': ' + errs2.slice(0, 2).join(' | ') : ''}`);
    await c2.close();
  }

  // notes of 0 TAC (the change and padding a transfer leaves): not listed in the Bridge tab, not counted, and the one note that holds TAC still is
  for (const [label, spec, want] of [
    ['a 1,000 TAC note and two of 0 TAC', [{ asset: TAC, id: 'cc', amount: '100000000000' }, { asset: TAC, id: 'ee', amount: '0' }, { asset: TAC, id: 'ff', amount: '0' }], 1],
    ['only notes of 0 TAC', [{ asset: TAC, id: 'ee', amount: '0' }, { asset: TAC, id: 'ff', amount: '0' }], 0],
  ]) {
    const c3 = await contextWith(spec);
    const p3 = await c3.newPage();
    const errs3 = []; p3.on('pageerror', (e) => errs3.push(String(e.message || e)));
    const t3 = (sel) => p3.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    await p3.goto(BASE + '/', { waitUntil: 'commit' });
    await p3.waitForSelector('#wallet', { timeout: 30000 });
    await p3.click('#wallet'); if (await p3.$('#acct-pop:not([hidden])')) await p3.click('#acct-pop [data-acct="wallet"]');
    await p3.waitForSelector('#ws-in', { timeout: 15000 });
    await p3.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
    await p3.click('#ws-in [data-in="paste"]');
    await p3.fill('#ws-hex', KEY);
    await p3.click('#ws-in [data-in="key"]');
    await p3.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
    await p3.keyboard.press('Escape');
    await p3.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});
    await p3.click('#hx [data-hxm="more"]');
    await p3.click('#hx [data-hxm="bridge"]').catch(() => {});
    await p3.waitForFunction(() => /Bitcoin/.test(document.querySelector('#hx-have')?.textContent || ''), null, { timeout: 40000 }).catch(() => {});
    await p3.waitForTimeout(1500);
    const rows3 = await p3.$$eval('#hx-routes [data-hxr]', (bs) => bs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
    ok(rows3.length === want && !rows3.some((r) => /Holds no TAC|^0 TAC/.test(r)), `${label}: ${want} row${want === 1 ? '' : 's'} in the note list, none of 0 TAC: ${JSON.stringify(rows3)}`);
    const have = await t3('#hx-have');
    ok(want ? /in 1 note(?!s)/.test(have) && !/cannot be bridged/.test(have) : /No TAC on this key/.test(have), `${label}: the line over the button counts only what holds TAC: "${have}"`);
    ok(errs3.length === 0, `no page errors${errs3.length ? ': ' + errs3.slice(0, 2).join(' | ') : ''}`);
    await c3.close();
  }
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nbridge Bitcoin balance checks passed (${n})`);
process.exit(fails ? 1 : 0);
