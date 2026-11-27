#!/usr/bin/env node
// The front page's Earn tab, paid in ETH: a token's own farm (the tETH / SPX stream) is offered on every page, not only /spx/. The zap buys the token's leg where it is cheaper
// (xtAddPlan: the pool's price or the open market, whichever gives the deposit more) and puts the share in the farm. Browser, no wallet; the pool and farm program are read live.
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/earn-token-farm.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { frontPage } from './lib/front-page.mjs';

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
const b = await chromium.launch(), p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(), bad = [];
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
p.on('pageerror', (e) => bad.push('script error: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); });
await p.goto(BASE + '/', { waitUntil: 'load' });
await p.waitForSelector('#hx .go', { timeout: 40000 });
const tile = () => p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' '));
const waitFor = async (re, ms = 40000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(); if (re.test(t)) return t; await p.waitForTimeout(500); } return t; };
await p.evaluate(() => [...document.querySelectorAll('#hx button')].find((e) => e.innerText.trim() === 'Earn')?.click());
await p.waitForTimeout(2000);
await p.fill('#hx-amt, #amt', '0.05');
const t = await waitFor(/tETH \/ SPX/);
ok(/tETH \/ SPX\s+private/.test(t), 'the front page offers the tETH / SPX farm to an ETH source');
ok(/Zap into the farm/.test(t) && /on the open market, then both go in|swapped in the pool, then both go in/.test(t), 'it is a zap into the farm, and says where the token leg comes from');
ok(/You hold private tETH \/ SPX liquidity, in the farm/.test(t) && /TAC streams to it/.test(t), 'the share goes in the farm and its stream is shown');
ok(!(await p.evaluate(() => document.documentElement.dataset.page)), 'on the front page itself, not the SPX page');
// a token with no pool, asked for by its address (the link the buy card offers): the start card says what goes in, and a token the pool has never held is added with it
const link = (addr) => p.evaluate((x) => { const l = document.createElement('a'); l.href = '#'; l.dataset.hx = `earn:ether:${x}`; l.dataset.amt = '0.01'; document.body.append(l); l.click(); l.remove(); }, addr);
await link('0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9');      // AAVE
const u = await waitFor(/tETH \/ AAVE/);
const started = /Start the tETH \/ AAVE pool/.test(await waitFor(/Start the tETH \/ AAVE pool|Add as private LP/));
const card = await tile();
ok(/tETH \/ AAVE/.test(card) && /Puts in [\d.]+ ETH and [\d.]+ AAVE/.test(card), 'a token linked by address shows its tETH row and what goes in');
ok(!started || (/no pool yet/.test(card) && /Pool new: it holds only your deposit/.test(card)), 'when it has no pool, the card offers to start it and warns that a new pool holds only the deposit');
// deep links with custom inputs (a farm by its number, LP only, a token by its address) and the TAC farm's zap sourcing TAC from the public pool when that is better
{
  const open = async (hash, wait) => {
    const pg = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    pg.on('pageerror', (e) => bad.push('script error: ' + e.message));
    await pg.goto(BASE + '/' + hash, { waitUntil: 'load' });
    await pg.waitForSelector('#hx .go', { timeout: 40000 });
    const t0 = Date.now(); let t = '';
    while (Date.now() - t0 < 45000) { t = await pg.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' ')); if (wait.test(t)) break; await pg.waitForTimeout(600); }
    const amt = await pg.evaluate(() => document.querySelector('#hx-amt, #amt')?.value);
    await pg.close();
    return { t, amt };
  };
  let r = await open('#card=earn:ether:p0&amt=0.05', /tETH \/ TAC/);
  ok(/Earn/.test(r.t) && /tETH \/ TAC/.test(r.t) && r.amt === '0.05' && /Zap into the farm/.test(r.t), 'a link to the TAC farm (earn:ether:p0) with an amount opens the Earn tab on it, amount filled, as a zap into the farm');
  r = await open('#card=earn:ether:p0&amt=0.05&lp=1', /Add as private LP/);
  ok(/tETH \/ TAC/.test(r.t) && /Add as private LP/.test(r.t) && !/Zap into the farm/.test(r.t), 'with &lp=1 it opens as liquidity alone');
  r = await open('#card=earn:ether:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9&amt=0.01', /tETH \/ AAVE/);
  ok(/tETH \/ AAVE/.test(r.t) && r.amt === '0.01', 'a link naming a token by its address opens that token\'s row with the amount');
  r = await open('#card=earn:ether:p0&amt=3', /Where \d+% in this pool/);
  ok(/Where \d+% in this pool, the rest in the Precision pool/.test(r.t), 'a large TAC zap (3 ETH) is split: part of the TAC is bought in the public Precision pool, the rest in this one, still one transaction');
  r = await open('#card=earn:ether:p0&amt=0.05', /Zap into the farm/);
  ok(!/Where \d+% in this pool/.test(r.t), 'a small one is not split: the pool\'s own price is better than the cost of a second venue');
}
// a payer who holds the token starts the pool from both sides, with no swap (the contracts' composition is proved on a fork: tests/pool-start-both-fork.mjs)
{
  const fn = frontPage(join(DAPP, 'index.html')), body = fn.slice(fn.indexOf('async function xtBothUse('), fn.indexOf("// Liquidity added to a token's tETH pool"));
  ok(/foundingPlan\(\{ swapIn: x, amountOut: q\.amountOut, amountLimit: q\.amountOut/.test(body) && /held >= plan\.bLeg/.test(body), 'the both-sides plan is the market rate of the ETH entered, and only offered when the payer holds the token leg');
  ok(/addLiquidityPublicETHWithPermit2Calldata/.test(body) && /shieldSharesCalldata\(\{ poolId, shares: plan\.shares, commit: built\.commit \}\)/.test(body) && /to: plan\.owner/.test(body), 'it founds the pool with the payer as the share holder, then shields exactly the planned shares');
  ok(/sendBatch\(\[\.\.\.\(r\.registered !== true \? \[t\.registerTokenCall\(r\.addr\)\] : \[\]\), \{ to: router, data, value: plan\.ethLeg \}, \{ to: t\.cfg\.pool, data: shield, value: 0n \}\]/.test(body), 'a wallet that batches sends the registration, the add and the shield as one confirmation');
  ok(/const both = await xtBothUse\(r, wei\)\.catch\(\(\) => null\); hash = both \? await xtStartBoth/.test(fn), 'the start press uses it when the payer holds the token');
}
// a key that holds the private tETH and the private token starts the pool from those notes: nothing public about the amounts
{
  const fn = frontPage(join(DAPP, 'index.html')), body = fn.slice(fn.indexOf('async function xtPrivBothUse('), fn.indexOf("// Liquidity added to a token's tETH pool"));
  ok(/spendable\('eth'\) >= ethUnits && spendable\(`xp\$\{r\.addr\}`\) >= tokUnits/.test(body), 'the private start is only offered when both private balances cover their leg');
  ok(/noteFor\(run, t, priv, plan\.ethUnits/.test(body) && /noteFor\(run, t, priv, plan\.tokUnits/.test(body) && /t\.lpAdd\(\{ walletPriv: priv, aNote: nE, bNote: nT, feeBps: POOL_START_FEE, selfSettle/.test(body), 'it cuts a note of each size and adds them as the first liquidity (the module creates the pool)');
  ok(/if \(HX\.from === 'eth'\) \{ const pb = await xtPrivBothUse\(r, wei\)/.test(fn) && /src === 'eth' && !lpOnly\) out\.push\(\.\.\.xtEarnRows\(\)\.filter\(\(x\) => x\.k\.startsWith\('xs:'\)/.test(fn), 'private tETH, as the Earn source, lists the starts its private coins can fund, and the press uses the private start');
}
// a share proof slow to come back says so after 90 seconds and offers the own-device choice, as the farm zap does; the wait itself is unchanged
{
  const fn = frontPage(join(DAPP, 'index.html')), body = fn.slice(fn.indexOf('async function xtShareProof('), fn.indexOf('// One transaction from the wallet: the ETH\'s swap half'));
  ok(/sleep\(90e3\)\.then\(async \(\) => \{\s+if \(over\) return null;/.test(body) && /inflight: proving, down: false/.test(body) && /const proven = await proving;/.test(body), 'a share proof slow past 90 seconds offers to keep waiting or prove on this device, and is still awaited the same way');
  ok(/if \(way === 'own'\) \{ try \{ t\.releaseShareIndex/.test(body), 'choosing to prove on the device frees the share index and sends nothing');
  ok(/\/confidential\/relay`\)/.test(body) && /tacit-proof-slow-v1/.test(body) && /opts\.onUpdate = \(u\) =>/.test(body), 'the notice carries the relay\'s own queue gauge and the job\'s status trail, and keeps them for tracing');
}
// the Privacy row's count is read again while the page is open (it said "0 deposits" for a token just deposited, until the page was reloaded)
{
  const fn = frontPage(join(DAPP, 'index.html')), body = fn.slice(fn.indexOf('const ANON = {'), fn.indexOf('var TACP = {'));
  ok(/Date\.now\(\) - ANON\.at > 60e3/.test(body) && /\.finally\(\(\) => \{ ANON\.p = null; ANON\.at = Date\.now\(\); \}\)/.test(body), 'the deposit count is asked again once a minute, and a failed read waits the minute');
  ok(/const changed = JSON\.stringify\(j\.assets\) !== JSON\.stringify\(ANON\.v\?\.assets\)/.test(body) && /if \(changed\)/.test(body), 'the card and tile are painted again only when a count has changed');
}
await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
