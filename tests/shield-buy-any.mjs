#!/usr/bin/env node
// The front page's Shield tab, paid in ETH: the To coin opens a picker, and any listed token (or a pasted address) is bought on the open market and shielded
// ("Buy and shield"), the flow the /spx/ page has for SPX alone. Browser, no wallet, the quote read over the public RPCs.
//   - ETH is the default (the plain shield, to private ETH) and the To coin is a button
//   - the picker lists ETH and tokens, not TAC, WETH or a private-only coin, and searches
//   - picking PEPE prices ETH -> private PEPE ("swap, then shield"), the button says what it is, a link to share is not offered
//   - picking ETH again is the plain shield; Withdraw's To coin is not a button; paying with a token (DAI) goes back to shielding it as it is
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/shield-buy-any.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch();
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage(), bad = [];
p.on('pageerror', (e) => bad.push('script error: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); if (/Content Security Policy/.test(m.text())) bad.push('CSP: ' + m.text().slice(0, 160)); });
{
  // a swap's output is rarely a whole number of the pool's units for an 18-decimal token: the shield rounds it down (AAVE canary: 'amount not aligned to unitScale')
  const fn = readFileSync(join(DAPP, 'index.html'), 'utf8'), body = fn.slice(fn.indexOf('async function xtShieldRaw('), fn.indexOf('async function xtZapShield(') > 0 ? fn.indexOf('// The deposit of the one-transaction buy') : undefined);
  ok(/if \(r\.scale > 1n\) wei -= wei % r\.scale;/.test(body), 'the shield of a bought token rounds the amount down to the pool\'s unit scale');
}
{
  // a token the pool does not hold yet: the one-transaction buy adds it first, together with the buy when the wallet batches, else as its own confirmation
  const fn = readFileSync(join(DAPP, 'index.html'), 'utf8'), dep = fn.slice(fn.indexOf('async function xtZapDeposit('), fn.indexOf('async function xtZapShield('));
  ok(/if \(r\.registered !== true\) \{\s+if \(await canBatch\(\)\)/.test(dep) && /sendBatch\(\[t\.registerTokenCall\(r\.addr\), \{ to: router, data, value: plan\.value \}\]/.test(dep) && /await xtRegister\(run, t, r, 'wallet', status\);/.test(dep), 'the one-transaction buy registers a new token with the buy (batched) or just before it');
  ok(/r\.registered == null \|\| r\.err/.test(fn.slice(fn.indexOf('async function xtZapShield('), fn.indexOf('async function hxXOutGo('))), 'it is offered for a token the pool has not got yet, not only a registered one');
}
// the Privacy row: the page asks GET /pool/anonymity (mocked here: the real API answers tacit.finance only) and says how many deposits of the asset the pool took in 30 days
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const aid = (a) => { const b = Buffer.alloc(46); b.write('tacit-evm-token-v1'); b.writeBigUInt64BE(1n, 18); Buffer.from(a.slice(2), 'hex').copy(b, 26); return '0x' + createHash('sha256').update(b).digest('hex'); };
let asked = 0;
await p.route('https://api.tacit.finance/pool/anonymity', (r) => { asked++; r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ asOf: 1, synced: true, windowDays: 30, dayBlocks: 7200, assets: { ['0x' + 'ee'.repeat(32)]: { total: 900, d30: 250, d7: 60, ticker: 'cETH' }, [aid(PEPE)]: { total: 4, d30: 3, d7: 1 } } }) }); });
await p.goto(BASE + '/', { waitUntil: 'load' });
await p.waitForSelector('#hx .go', { timeout: 40000 });
const tile = () => p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' '));
const waitFor = async (re, ms = 30000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(); if (re.test(t)) return t; await p.waitForTimeout(400); } return t; };
const tab = async (name) => { for (const x of await p.$$('#hx button')) if ((await x.textContent()).trim() === name) { await x.click(); return; } };
const rows = () => p.evaluate(() => [...document.querySelectorAll('#pk .pk-r')].filter((x) => !x.hidden).map((x) => ({ k: x.dataset.k, t: x.innerText.replace(/\s+/g, ' ') })));
const clickable = () => p.evaluate(() => getComputedStyle(document.querySelector('#get-coin')).pointerEvents !== 'none');

await tab('Shield');
await waitFor(/Shield ETH/);
ok(await clickable(), 'Shield, paid in ETH: the To coin is a button');
await p.click('#get-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { timeout: 10000 });
const all = await rows(), keys = all.map((r) => r.k);
ok(keys.includes('0x0000000000000000000000000000000000000000') && all.length > 20, `the picker lists ETH and tokens (${all.length})`);
ok(!keys.some((k) => /^0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2$/i.test(k)) && !keys.some((k) => /^@/.test(k)), 'WETH and the private-only coins are not offered');
await p.fill('#pk-q', 'pepe');
await p.waitForTimeout(600);
const found = await rows();
ok(found.length > 0 && /PEPE/.test(found[0].t), 'it searches');
await p.click('#pk .pk-r:not([hidden])');
await p.fill('#amt', '0.01');
const t = await waitFor(/swap, then shield/i, 40000);
ok(/PEPE/.test(t) && /private PEPE/.test(t) && /swap, then shield/i.test(t), 'picking PEPE prices ETH into private PEPE: swap, then shield');
const tp = await waitFor(/Privacy 3 deposits in 30 days · low/, 20000);ok(/Privacy 3 deposits in 30 days · low/.test(tp) && asked === 1, 'the PEPE buy says how crowded its private side is: 3 deposits in 30 days, low (the endpoint is asked once)');
const hint = await waitFor(/Pool none for tETH \/ PEPE yet · start one/, 25000);
ok(/Pool none for tETH \/ PEPE yet · start one/.test(hint), 'the buy says the token has no tETH pool yet, and offers to start one');
ok(!(await p.evaluate(() => { const c = document.querySelector('#copy'); return !!c && !c.hidden; })), 'no share link is offered for it (a link opens the Swap tab)');
const go = await p.evaluate(() => document.querySelector('#go')?.innerText);
ok(/Connect wallet/.test(go), 'with no wallet the button asks to connect');
await p.click('#get-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { timeout: 10000 });
await p.click('#pk .pk-r[data-k="0x0000000000000000000000000000000000000000"]');
await waitFor(/To DeFi pool [\d.]+ ETH/);
ok(/Privacy 250 deposits in 30 days · strong/.test(await waitFor(/Privacy 250 deposits/, 20000)), 'the plain ETH shield says it too: 250 deposits in 30 days, strong');
ok(/To DeFi pool [\d.]+ ETH/.test(await tile()) && !/PEPE/.test(await tile()), 'picking ETH again is the plain shield (private ETH)');
await p.click('#get-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { timeout: 10000 });
await p.fill('#pk-q', 'pepe');
await p.click('#pk .pk-r:not([hidden])');
await p.waitForTimeout(800);
await tab('Swap');
await p.waitForTimeout(800);
await tab('Shield');
await waitFor(/Shield/);
await p.waitForTimeout(800);
ok(await clickable(), 'back on Shield the To coin is still a button');
// the flip is Withdraw, whose To coin is not a button and which forgets the token
await p.click('#flip');
await waitFor(/Withdraw/i, 15000);
await p.waitForTimeout(800);
ok(!(await clickable()) && !/PEPE/.test(await tile()), 'Withdraw: the To coin is not a button and the chosen token is forgotten');
await p.click('#flip');
await p.waitForTimeout(1200);
// paying with a token you hold goes back to shielding it as it is
await p.click('#pay-coin');
await p.waitForSelector('#pk:not([hidden]) .pk-r', { timeout: 10000 });
await p.fill('#pk-q', 'dai');
await p.waitForTimeout(500);
const dai = await p.$('#pk .pk-r:not([hidden])');
if (dai) await dai.click();
await p.waitForTimeout(1500);
ok(!(await clickable()) && /DAI/.test(await tile()), 'paying with DAI is the plain shield of DAI: the To coin is not a button');
await b.close();
server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
