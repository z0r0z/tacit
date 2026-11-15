#!/usr/bin/env node
// The front page opened from the etch page's "Shield it" link (#card=shield:<token>), against a fork of mainnet: the real page and modules, a token etched on
// the fork by the etch page's own plan (dapp/etch/eth.js), and every RPC host answered by the fork. No wallet: what is checked is where the link lands.
//   checks: the Shield tab opens on the etched token, paid from the wallet and landing as its own private form in the DeFi pool (the button names it); the
//   link is taken out of the address bar; a checksummed address works; a token the pool already registered (etched with its registration) lands the same;
//   an address that is no token, and TAC's own (which has its own way in), leave the card on its ordinary ETH shield; no script errors.
//
//   FORK=<rpc> PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/etch-shield-page.mjs      (or ANVIL=<a running fork's url> to use one)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://rpc.mevblocker.io';
const PORT = 21000 + Math.floor(Math.random() * 2000), ANVIL = process.env.ANVIL || `http://127.0.0.1:${PORT}`;
const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.ANVIL) {
  const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
  process.on('exit', () => anvil.kill('SIGKILL'));
}
const rpc = async (method, params = []) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

// eth.js names its two imports by site path; the test names them by file
const ETCH = new URL('../dapp/etch/', import.meta.url);
const E = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('eth.js', ETCH), 'utf8')
  .replace(/'\/etch\/minter\.js[^']*'/, `'${new URL('minter.js', ETCH).href}'`)
  .replace(/'\.\.\/trade\/batch\.js'/, `'${new URL('../trade/batch.js', ETCH).href}'`)).toString('base64'));
async function etch(symbol, decimals, register) {
  const plan = await E.plan({ account: ACCOUNT, symbol, decimals, supply: 1_000_000n * 10n ** BigInt(decimals), register }, rpc);
  for (const c of plan.calls) {
    const h = await rpc('eth_sendTransaction', [{ from: ACCOUNT, to: c.to, data: c.data, gas: '0x1e8480' }]);
    let r = null;
    for (let i = 0; i < 60 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [h]); if (!r) await sleep(500); }
    if (r?.status !== '0x1') throw new Error(`${c.label} failed`);
  }
  return plan.token;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp' };
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
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'mainnet.rpc.buidlguidl.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.mevblocker.io', 'eth-mainnet.nodereal.io', '1.rpc.thirdweb.com', 'rpc.flashbots.net', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io'];

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch();
// The front page, opened on a hash; its Shield card's text once the card has settled on `want` (or the wait is over).
async function open(hash, want) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 1300 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' } });
    const out = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() || '{}' })).text();
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out });
  });
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#hx-swap #amt', { timeout: 90000 });
  const read = () => page.evaluate(() => ({ card: (document.querySelector('#hx-swap')?.innerText || '').replace(/\s+/g, ' '), hash: location.hash, go: document.querySelector('#hx-swap #go')?.innerText.trim() || '' }));
  let s = await read();
  for (let i = 0; i < 40 && want && !want.test(s.go); i++) { await sleep(500); s = await read(); }
  await sleep(1500);                                  // a late answer that would move the card off it
  s = await read();
  await ctx.close();
  return { ...s, errs };
}

const six = await etch('LINKT', 6, false), batched = await etch('BATCHT', 18, true);
{
  const s = await open(`#card=shield:${six}`, /Shield LINKT/);
  ok(/^Shield LINKT\b/.test(s.go), `the card's button names the token (“${s.go}”)`);
  ok(/From Wallet\b.*\bLINKT\b.*To DeFi pool\b.*\bLINKT\b/.test(s.card), `paid from the wallet, landing in the DeFi pool as the token itself (${s.card.slice(0, 90)})`);
  ok(s.hash === '', 'the link is taken out of the address bar');
  ok(s.errs.length === 0, 'no script errors' + (s.errs[0] ? `: ${s.errs[0]}` : ''));
}
{
  const s = await open(`#card=shield:${batched.replace(/^0x/, '0x').replace(/[a-f]/g, (c, i) => (i % 2 ? c.toUpperCase() : c))}`, /Shield BATCHT/);
  ok(/^Shield BATCHT\b/.test(s.go), `an address in mixed case lands the same, and so does a token registered when it was etched (“${s.go}”)`);
  ok(s.errs.length === 0, 'no script errors' + (s.errs[0] ? `: ${s.errs[0]}` : ''));
}
for (const [what, token] of [['an address that is no token', ACCOUNT], ['TAC’s own address, which has its own way in', TAC]]) {
  const s = await open(`#card=shield:${token}`);
  ok(/^Shield ETH\b/.test(s.go) && /To DeFi pool\b.*\bETH\b/.test(s.card), `${what} leaves the card on its ordinary ETH shield (“${s.go}”)`);
  ok(s.errs.length === 0, 'no script errors' + (s.errs[0] ? `: ${s.errs[0]}` : ''));
}
await b.close(); server.close();
console.log(`\n${n} passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
