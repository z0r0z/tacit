#!/usr/bin/env node
// The bridge page's "Another token" picker, in a real browser (dapp/bridge/index.html, app.js, token-pick.js; the front page's #card=bridge:xw0x… link in dapp/index.html).
//
// 2026-11-19: JPYC went from Ethereum to Bitcoin through the front page (the pool escrows any token), while the bridge page offered five fixed tabs. A token is named by its address, read
// from the chain, and the tile's button opens the front page on that token's bridge. Nothing leaves the machine: the page is served from dapp/, the Ethereum node is a stand-in that
// answers symbol(), name() and decimals() for two tokens (and nothing for an address with no code), and every other host is refused.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/bridge-token-picker.mjs      (DAPP=<dir> to load another copy of dapp/)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = process.env.DAPP || join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  ok   ${label}`); pass++; } catch (e) { console.log(`  FAIL ${label}: ${e.message}`); fail++; } };

const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29', WEIRD = '0x1111111111111111111111111111111111111111', NONE = '0x2222222222222222222222222222222222222222', KEPT = '0x3333333333333333333333333333333333333333';
const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const abiString = (s) => '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex(s).padEnd(Math.ceil(s.length / 32) * 64, '0');
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const TOKENS = { [JPYC]: ['JPYC', 'JPY Coin', 18], [WEIRD]: ['<img src=x onerror=alert(1)>', 'Evil', 6] };
const asked = [];
const answer = (to, data) => {
  const t = TOKENS[String(to).toLowerCase()];
  if (!t) return '0x';
  if (data === '0x95d89b41') return abiString(t[0]);
  if (data === '0x06fdde03') return abiString(t[1]);
  if (data === '0x313ce567') return word(t[2]);
  return '0x';
};

const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  let f = join(DAPP, u);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!f.startsWith(DAPP) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); r.end(readFileSync(f));
});
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ headless: true });

async function open(hash = '', { kept = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
  if (kept) await ctx.addInitScript((e) => { try { localStorage.setItem('tacit-bridge-runtime-v1', JSON.stringify([e])); } catch { } }, kept);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route((u) => !u.href.startsWith(base), async (route) => {
    const req = route.request(), url = req.url();
    if (/ethereum-rpc\.publicnode\.com/.test(url) && req.method() === 'POST') {
      let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { }
      if (b.method === 'eth_call') { const c = b.params?.[0] || {}; asked.push([String(c.to).toLowerCase(), c.data]); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: answer(c.to, c.data) }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: '0x0' }) });
    }
    return route.abort();
  });
  await page.goto(`${base}/bridge/${hash}`, { waitUntil: 'load' });
  await page.waitForSelector('#bt-more', { timeout: 15000 });
  return { page, ctx, errors };
}
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const attr = (page, sel, a) => page.evaluate(([s, n]) => document.querySelector(s)?.getAttribute(n), [sel, a]);
const settle = (page, ms = 700) => page.waitForTimeout(ms);

await test('the page opens on TAC with the five tabs, an "Another token" button, and its panel shut', async () => {
  const { page, ctx, errors } = await open();
  ok(await txt(page, '#bt-more-t') === 'Another token', 'label');
  ok(await attr(page, '#bt-pop', 'hidden') !== null && await attr(page, '#bt-more', 'aria-expanded') === 'false', 'the panel should start shut');
  ok(await page.evaluate(() => document.querySelectorAll('#bt-assets [data-asset]').length) === 5, 'the five tabs');
  ok(await attr(page, '#bt-assets [data-asset="tac"]', 'aria-selected') === 'true', 'TAC selected');
  ok(errors.length === 0, `page errors: ${errors}`);
  await ctx.close();
});

await test('the button opens the panel and puts the cursor in the address box; Escape shuts it', async () => {
  const { page, ctx } = await open();
  await page.click('#bt-more');
  ok(await attr(page, '#bt-pop', 'hidden') === null && await attr(page, '#bt-more', 'aria-expanded') === 'true', 'open');
  ok(await page.evaluate(() => document.activeElement?.id) === 'bt-addr', 'the address box has focus');
  await page.keyboard.press('Escape');
  ok(await attr(page, '#bt-pop', 'hidden') !== null && await page.evaluate(() => document.activeElement?.id) === 'bt-more', 'shut, focus back on the button');
  await ctx.close();
});

await test('a pasted token address is read from the chain, and the tile becomes the token\'s, going to Bitcoin', async () => {
  const { page, ctx, errors } = await open();
  await page.click('#bt-more');
  await page.fill('#bt-addr', JPYC.toUpperCase().replace('0X', '0x'));
  await page.waitForFunction(() => document.querySelector('#bt-more-t')?.textContent === 'JPYC', null, { timeout: 8000 });
  ok(await attr(page, '#bt', 'data-asset') === 'token' && await attr(page, '#bt', 'data-dir') === 'out', 'the tile is a token tile, to Bitcoin');
  ok(await attr(page, '#bt-go', 'href') === `/#card=bridge:xw${JPYC}`, `button ${await attr(page, '#bt-go', 'href')}`);
  ok((await txt(page, '#bt-go')).startsWith('Bridge JPYC'), `go text ${await txt(page, '#bt-go')}`);
  ok(await page.evaluate(() => location.hash) === `#${JPYC}/out`, `hash ${await page.evaluate(() => location.hash)}`);
  ok(/Burned on Ethereum/.test(await txt(page, '#bt-steps')) && /Arrived/.test(await txt(page, '#bt-steps')), 'the steps to Bitcoin');
  ok(/JPYC, JPY Coin: 18 decimals/.test(await txt(page, '#bt-addr-say')), await txt(page, '#bt-addr-say'));
  ok(/No fixed minimum/.test(await txt(page, '#bt-limit')) && await page.evaluate(() => document.querySelector('#bt-cost').hidden), 'limit and cost lines');
  ok(await page.evaluate(() => [...document.querySelectorAll('#bt-assets [data-asset]')].every((b) => b.getAttribute('aria-selected') === 'false')), 'no built-in tab is selected');
  ok(await page.evaluate(() => document.getElementById('bt-more').classList.contains('on')), 'the button shows it is chosen');
  ok(errors.length === 0, `page errors: ${errors}`);
  await ctx.close();
});

await test('the flip button turns it round: back from Bitcoin, to the token\'s other link', async () => {
  const { page, ctx } = await open();
  await page.click('#bt-more'); await page.fill('#bt-addr', JPYC);
  await page.waitForFunction(() => document.querySelector('#bt-more-t')?.textContent === 'JPYC');
  ok(!(await page.evaluate(() => document.querySelector('#bt-flip').disabled)), 'flip is enabled for a token');
  await page.click('#bt-flip'); await settle(page, 300);
  ok(await attr(page, '#bt-go', 'href') === `/#card=bridge:xb${JPYC}` && await attr(page, '#bt', 'data-dir') === 'in', 'back from Bitcoin');
  ok((await txt(page, '#bt-go')).startsWith('Bring JPYC back') && await page.evaluate(() => location.hash) === `#${JPYC}`, 'label and hash');
  ok(/Burned on Bitcoin/.test(await txt(page, '#bt-steps')), 'the steps from Bitcoin');
  await ctx.close();
});

await test('a built-in tab takes the tile back, and the button reads "Another token" again', async () => {
  const { page, ctx } = await open();
  await page.click('#bt-more'); await page.fill('#bt-addr', JPYC);
  await page.waitForFunction(() => document.querySelector('#bt-more-t')?.textContent === 'JPYC');
  await page.click('#bt-assets [data-asset="teth"]'); await settle(page, 300);
  ok(await txt(page, '#bt-more-t') === 'Another token' && await attr(page, '#bt', 'data-asset') === 'teth', 'back on tETH');
  ok(await attr(page, '#bt-assets [data-asset="teth"]', 'aria-selected') === 'true', 'tETH selected');
  ok(await attr(page, '#bt-go', 'href') !== `/#card=bridge:xw${JPYC}`, 'the old token\'s button must go');
  ok(!(await page.evaluate(() => document.getElementById('bt-more').classList.contains('on'))), 'not chosen any more');
  await ctx.close();
});

await test('an address that is not a token is said so, and the tile stays where it was', async () => {
  const { page, ctx } = await open();
  await page.click('#bt-more'); await page.fill('#bt-addr', NONE);
  await page.waitForFunction(() => /not an ERC-20/.test(document.querySelector('#bt-addr-say')?.textContent || ''), null, { timeout: 8000 });
  ok(await attr(page, '#bt-addr', 'aria-invalid') === 'true' && await txt(page, '#bt-more-t') === 'Another token' && await attr(page, '#bt', 'data-asset') === 'tac', 'nothing chosen');
  await ctx.close();
});

await test('text that is not an address is said so while it is typed, and a long wrong one is refused', async () => {
  const { page, ctx } = await open();
  await page.click('#bt-more');
  await page.fill('#bt-addr', '0x12ab'); ok(/Keep typing/.test(await txt(page, '#bt-addr-say')), 'a short one asks for more');
  await page.fill('#bt-addr', '0x' + 'z'.repeat(40)); ok(/not a token address/.test(await txt(page, '#bt-addr-say')) && await attr(page, '#bt-addr', 'aria-invalid') === 'true', 'a long wrong one is refused');
  await page.fill('#bt-addr', ''); ok(/Any token the pool can hold/.test(await txt(page, '#bt-addr-say')) && await attr(page, '#bt-addr', 'aria-invalid') === null, 'cleared: the first line is back');
  await ctx.close();
});

await test('a token whose own symbol is markup is shown by its address, never as that text', async () => {
  const { page, ctx, errors } = await open();
  await page.click('#bt-more'); await page.fill('#bt-addr', WEIRD);
  await page.waitForFunction(() => document.querySelector('#bt-more-t')?.textContent !== 'Another token', null, { timeout: 8000 });
  ok(await txt(page, '#bt-more-t') === '0x1111…1111', `label ${await txt(page, '#bt-more-t')}`);
  ok(!(await page.evaluate(() => !!document.querySelector('img[src="x"]'))) && errors.length === 0, 'markup from a token must not run');
  await ctx.close();
});

await test('a link to the token (#0x…/out) opens its tile at once, with the address standing in until the name is read', async () => {
  const { page, ctx } = await open(`#${JPYC}/out`);
  await page.waitForFunction(() => document.querySelector('#bt-more-t')?.textContent === 'JPYC', null, { timeout: 8000 });
  ok(await attr(page, '#bt-go', 'href') === `/#card=bridge:xw${JPYC}` && await attr(page, '#bt', 'data-dir') === 'out', 'the button');
  const { page: p2, ctx: c2 } = await open(`#${JPYC}`);
  await p2.waitForFunction(() => document.querySelector('#bt-more-t')?.textContent === 'JPYC', null, { timeout: 8000 });
  ok(await attr(p2, '#bt', 'data-dir') === 'in' && await attr(p2, '#bt-go', 'href') === `/#card=bridge:xb${JPYC}`, 'from Bitcoin by default, as the built-in tabs');
  await ctx.close(); await c2.close();
});

await test('a token this browser has bridged is listed, and picking it needs no look at the chain', async () => {
  const before = asked.length;
  const e = { addr: KEPT, id: '0x' + 'ab'.repeat(32), ticker: 'KEPT', sym: 'KEPT', dp: 4, dec: 6, minRaw: '1', capRaw: '1000000000000000000' };
  const { page, ctx, errors } = await open('', { kept: e });
  await page.click('#bt-more');
  ok(await attr(page, '#bt-mine', 'hidden') === null && /KEPT/.test(await txt(page, '#bt-mine')), 'the kept token is listed');
  await page.click('#bt-mine button');
  await settle(page, 300);
  ok(await txt(page, '#bt-more-t') === 'KEPT' && await attr(page, '#bt-go', 'href') === `/#card=bridge:xw${KEPT}`, `button ${await attr(page, '#bt-go', 'href')}`);
  ok(asked.slice(before).every(([to]) => to !== KEPT), 'a kept token was read from the chain again');
  ok(errors.length === 0, `page errors: ${errors}`);
  await ctx.close();
});

await test('the built-in tabs still work as they did: the arrow keys move between them and a hash picks one', async () => {
  const { page, ctx } = await open('#cbtc/out');
  ok(await attr(page, '#bt', 'data-asset') === 'cbtc' && await attr(page, '#bt', 'data-dir') === 'out', 'a hash picks a tab');
  await page.focus('#bt-assets [data-asset="cbtc"]'); await page.keyboard.press('ArrowRight'); await settle(page, 200);
  ok(await attr(page, '#bt', 'data-asset') === 'cusd' && await txt(page, '#bt-more-t') === 'Another token', 'ArrowRight moves on');
  await ctx.close();
});

await browser.close(); srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
