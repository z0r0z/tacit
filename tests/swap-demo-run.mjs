#!/usr/bin/env node
// The private swap, end to end, in a real browser on the front page's Swap tile, with Ethereum an anvil fork of mainnet and the REAL pool keeper
// (worker-relay/src/evm-pool-keeper.js, a process of its own with the live pool's ceremony key): what a person does, press by press, and what the
// chain shows after. It is both the check that each use case works and the demo, since it can record the browser (VIDEO=dir) and screenshot each stage
// (SHOTS=dir), slowed (SLOW=ms between stages) for narrating over, or watched (HEADED=1).
//
//   eth   Alice, ETH → USDC to a fresh address: the Pay pool hop is on by itself, the deposit's gas is her ETH, the keeper sends the swap out
//   usdc  Bob, 1,000 USDC and no ETH at all, USDC → DAI to a fresh address: the relay pays the deposit's gas in USDC (one signed order sells the USDC for
//         a deposit box of the ETH pool, the keeper completes it); Bob's wallet sends no transaction and never holds ETH
//   tac   Carol, TAC and no ETH, TAC → DAI: the same, the fee in TAC
//   pick  Erin, ETH and USDC and TAC: the card pays in ETH by itself and she picks TAC for the deposit's gas: no ETH leaves her wallet
//   zap   Frank, USDC and ETH: the unchanged way in, his own transaction to the zap
//   priv  Gina, USDC and no ETH, USDC → TAC into her private balance: the relay's way pays an address only, so it is not offered
//
//   export PATH="$PATH:/Users/z/.foundry/bin"; node build/build.mjs
//   node tools/fork-proxy.mjs &              (eight free archive nodes behind one caching URL, http://127.0.0.1:8590)
//   FORK=http://127.0.0.1:8590 QUOTE_RPC=http://127.0.0.1:8590 FORK_BLOCK=<a block a little back> \
//   SHOTS=/tmp/demo VIDEO=/tmp/demo node tests/swap-demo-run.mjs [eth,usdc,tac,pick,zap,priv]
//
// The gas relay's order board (api.tacit.finance/gas/order) is stood in for by this run, which sends each order as the settle relay would; the keeper
// is the real one; everything else is the page's own code.
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('../', import.meta.url).pathname, DAPP = join(ROOT, 'dapp/');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || join(ROOT, 'node_modules/playwright-core'));
const { encodeExecute } = await import('../worker-relay/src/lib/gas-calls.js');
const { checkGasOrder } = await import('../worker/src/gas-relay-queue.js');
const { privateKeyToAccount } = createRequire(new URL('../worker-relay/package.json', import.meta.url))('viem/accounts');

const FORK = process.env.FORK || 'https://rpc.mevblocker.io', UP = process.env.QUOTE_RPC || 'https://rpc.mevblocker.io';
const SHOTS = process.env.SHOTS || null, VIDEO = process.env.VIDEO || null, SLOW = Number(process.env.SLOW || 0), HEADED = !!process.env.HEADED;
const WANT = (process.argv[2] || 'eth,usdc').split(',');
for (const d of [SHOTS, VIDEO]) if (d) mkdirSync(d, { recursive: true });
const PORT = 25000 + Math.floor(Math.random() * 500), ANVIL = `http://127.0.0.1:${PORT}`, WEB = PORT + 500, KPORT = PORT + 1000, KEEPER = `http://127.0.0.1:${KPORT}/evm-pool/keeper`;
const ZERO = '0x0000000000000000000000000000000000000000', USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', TAC_HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', RELAY = '0x000000197E8f0B64463B2010e568fF42090Af88d';
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', ZQUOTER = '0x000000bd2db80567c23e353ca95a251c573cbf9b';
const SENDER = '0x000000000000000000000000000000000007a0f0', DEPLOY_BLOCK = 26069245;
const keeperKey = '0x' + '5b'.repeat(32), keeperAddr = privateKeyToAccount(keeperKey).address;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16);
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const rpcA = (method, params = []) => post(ANVIL, method, params);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])));

// ── the fork, pinned a few blocks back ──
// FORK_BLOCK pins it, so a run asks the questions an earlier one did and a caching proxy in front of the node answers them (a cold fork's log scan over the pool's whole history can take minutes)
const head = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : BigInt(await post(UP, 'eth_blockNumber', [])) - 4n, BLOCK = '0x' + head.toString(16);
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'swap-demo-run-'));
const stop = () => { try { clearInterval(ticker); } catch { /* not yet made */ } for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } try { rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', stop);
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit', '--timeout', '240000', '--retries', '10'], { stdio: 'ignore' }));       // a cold archive node behind a proxy answers a log scan in minutes: the fork waits for it
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 200) throw new Error('anvil did not start'); await sleep(250); } }
for (const a of [keeperAddr, SENDER]) { await rpcA('anvil_setBalance', [a, hex(10n ** 19n)]); }
await rpcA('anvil_impersonateAccount', [SENDER]);
// a fork pinned back keeps that block's time, and the keeper judges a call's deadline by the clock on the wall: the fork's clock is set to it (the state stays the pinned block's)
await rpcA('anvil_setTime', [Math.floor(Date.now() / 1000)]);
await rpcA('anvil_mine', ['0x1']);
// The pinned block's Chainlink rounds are as old as the block, and the page drops a price older than six hours: each feed answers its own price, updated now.
for (const feed of ['0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c']) {
  const answer = (await rpcA('eth_call', [{ to: feed, data: '0xfeaf968c' }, 'latest'])).slice(2 + 64, 2 + 128);
  await rpcA('anvil_setCode', [feed, '0x6001600052' + '7f' + answer + '602052' + '42604052' + '42606052' + '6001608052' + '60a06000f3']);       // (roundId 1, the answer, now, now, 1)
}
// a block every two seconds, as the chain makes them, for the pages' three confirmations (a transaction is still mined as it is sent)
const ticker = setInterval(() => { rpcA('anvil_mine', ['0x1']).catch(() => {}); }, 2000);
ok(String(await rpcA('eth_getCode', [RELAY, 'latest'])).length > 2, 'the gas relay is on the fork');

// ── the pool's real keeper: its own process against the fork's pool and router ──
const ART = join(ROOT, 'dapp/evm-pool/'), klog = [];
const keeper = spawn('node', ['src/evm-pool-keeper.js'], {
  cwd: join(ROOT, 'worker-relay'),
  env: { ...process.env, EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: ANVIL, EVM_POOL_CHAIN_ID: '1', EVM_POOL_KEEPER_PRIV: keeperKey, EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'),
    PORT: String(KPORT), EVM_POOL_START_BLOCK: String(DEPLOY_BLOCK), EVM_POOL_LOG_CHUNK: '50000', EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_KEEPER_MIN_FEES: 'eth:1000',
    EVM_POOL_KEEPER_SEND_RPC_URLS: ANVIL, EVM_POOL_KEEPER_POINTS: '0', EVM_POOL_KEEPER_FACTS: '0', EVM_POOL_RPC_TIMEOUT_MS: '90000',
    EVM_POOL_WASM: ART + 'transact.wasm', EVM_POOL_ZKEY: ART + 'transact_final.zkey', EVM_POOL_VK: ART + 'transact_vk.json' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(keeper); keeper.stdout.on('data', (d) => klog.push(String(d))); keeper.stderr.on('data', (d) => klog.push(String(d)));
{ const t0 = Date.now(); for (let i = 0; ; i++) { try { if ((await fetch(`http://127.0.0.1:${KPORT}/health`)).ok) break; } catch { /* not yet */ } if (i > 900) { console.error(klog.join('').split('\n').slice(-20).join('\n')); throw new Error('the keeper did not become ready'); } await sleep(500); } ok(true, `the keeper is up on the fork's pool (${Math.round((Date.now() - t0) / 1000)} s)`); }

// ── the page: the dapp served as it is, the RPC hosts answered by the fork, the keeper's routes by the real keeper, the relay's board by this run ──
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zkey': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(WEB);
// every node the pages read through (dapp/eth-nodes.js), as hosts, so the fork answers all of them and none reaches the live chain; and the older ones a page may still name
const { ETH_NODES, ETH_LOG_NODES, ETH_ARCHIVE_NODES } = await import('../dapp/eth-nodes.js');
const RPC_HOSTS = [...new Set([...ETH_NODES, ...ETH_LOG_NODES, ...ETH_ARCHIVE_NODES].map((u) => new URL(u).host).concat(['mainnet.gateway.tenderly.co', 'cloudflare-eth.com']))];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const J = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

async function openPage({ account, key, viewport = { width: 1280, height: 1100 }, name }) {
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport, colorScheme: 'light', ...(VIDEO ? { recordVideo: { dir: VIDEO, size: viewport } } : {}) });
  const log = { sends: [], typed: [], personal: 0, orders: [] };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'net_version') return '1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_signTypedData_v4') { log.typed.push(JSON.parse(params[1])); return cast('wallet', 'sign', '--private-key', key, '--data', params[1]); }
    if (method === 'personal_sign') { log.personal++; return cast('wallet', 'sign', '--private-key', key, params[0]); }
    if (method === 'eth_sendTransaction') { log.sends.push(params[0]); return rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x7a1200' }]); }
    if (/^eth_(call|getBalance|getTransactionReceipt|blockNumber|estimateGas|gasPrice|getCode|getTransactionByHash)$/.test(method)) return rpcA(method, params);
    throw Object.assign(new Error(`the stub wallet does not do ${method}`), { code: 4200 });
  });
  await ctx.addInitScript(() => {
    const provider = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} };
    window.ethereum = provider;
    const detail = Object.freeze({ info: Object.freeze({ uuid: 'stub-1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    try { localStorage.setItem('tacit-trade-hedge-ms', '0'); localStorage.removeItem('tacit-swap-hop'); } catch { /* storage is a convenience */ }
  });
  // the fork answers the chain; zQuoter's scan of every pool is a read a fork makes slowly, so the upstream node answers it at the fork's block
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    try {
      const body = route.request().postData() || '{}', j = JSON.parse(body);
      const one = Array.isArray(j) ? j : [j];
      const toZq = one.some((x) => x.method === 'eth_call' && (String(x.params?.[0]?.to || '').toLowerCase() === ZQUOTER || BigInt(x.params?.[0]?.gas || 0) > 60_000_000n));
      if (toZq && !Array.isArray(j)) return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ...(await (await fetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...j, params: [j.params[0], BLOCK] }) })).json()), id: j.id }) });
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), txt = await r.text();
      // an RPC the fork answered with an error is said (the page may swallow it): which call, and what the fork said
      if (txt.includes('"error"')) { try { const rs = [].concat(JSON.parse(txt)); rs.forEach((x, k) => { if (x.error) console.log(`  ..     fork error for ${one[k]?.method}${one[k]?.params?.[0]?.to ? ' to ' + String(one[k].params[0].to).slice(0, 10) : ''}: ${String(x.error.message).slice(0, 140)}`); }); } catch { /* not JSON */ } }
      await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: txt });
    } catch (e) { await route.fulfill({ status: 502, headers: CORS, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  // the pool's keeper: its ETH-pool routes go to the real one; a token pool's route and the point of its events feed are absent (the wallet reads the fork's own logs)
  await ctx.route(/tacit-evm-pool-keepers\.onrender\.com\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (/^\/token-pools/.test(u.pathname)) return J(route, 200, { status: 'added', serving: false });
    const m = u.pathname.match(/^\/1\/evm-pool\/keeper(\/.*)?$/);
    if (!m || /\/events$/.test(u.pathname)) return J(route, 404, { error: 'no such route here' });
    try {
      const r = await fetch(`${KEEPER}${m[1] || ''}${u.search}`, { method: req.method(), headers: { 'content-type': req.headers()['content-type'] || 'application/json' }, body: req.method() === 'GET' ? undefined : req.postData() }), txt = await r.text();
      if (r.status >= 400) console.log(`  ..     keeper ${req.method()} ${m[1]} answered ${r.status}: ${txt.slice(0, 160)}`);
      await route.fulfill({ status: r.status, contentType: 'application/json', headers: CORS, body: txt });
    } catch (e) { await J(route, 502, { error: e.message }); }
  });
  await ctx.route(/^https:\/\/api\.tacit\.finance\/(?!gas\/)/, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    try { const res = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://tacit.finance' } }); await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } }); }
    catch { await route.fulfill({ status: 503, headers: CORS, body: '{}' }).catch(() => {}); }
  });
  // the gas relay's board: an order is checked as the board checks it and sent as the settle relay sends it
  await ctx.route(/api\.tacit\.finance\/gas\/(order|orders)/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (req.method() === 'GET') return J(route, 200, { relay: RELAY, orders: [] });
    const x = JSON.parse(req.postData()).order; log.orders.push(x);
    const why = checkGasOrder(x);
    if (why) return J(route, 400, { ok: false, error: why });
    try { log.relayTx = await rpcA('eth_sendTransaction', [{ from: SENDER, to: RELAY, data: encodeExecute(x), gas: '0x7a1200' }]); }
    catch (e) { return J(route, 400, { ok: false, error: e.message.slice(0, 160) }); }
    return J(route, 200, { ok: true });
  });
  // KyberSwap prices the relay's fee: asked from here as tacit.finance asks it
  await ctx.route(/^https:\/\/(api\.zfi\.wei\.is|api\.paraswap\.io|aggregator-api\.kyberswap\.com)\//, async (route) => {
    try { const res = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://tacit.finance' } }); await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } }); }
    catch { await route.fulfill({ status: 503, headers: CORS, body: '{}' }).catch(() => {}); }
  });
  const page = await ctx.newPage(), errors = [];
  page.setDefaultTimeout(240000);                      // the key's sign-in reads the pool through a cold fork before its sheet closes: a press waits for it
  // the sheet that opens the Tacit key (one signature) opens by itself once the card has been left alone, over whatever is pressed next: it is signed in as it appears
  await page.addLocatorHandler(page.locator('#sheet-wallet[open] [data-in="eth"]'), async (el) => { await el.click(); });
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  // a third party's own page-origin rules (a Bitcoin explorer, the live API) refuse a local origin: that is this run's, not the page's
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404|Failed to load resource|net::ERR|blocked by CORS policy/.test(m.text())) errors.push(m.text()); });
  return { browser, page, log, errors, name };
}
// the tile and what it keeps below it (the steps), not the whole page: the card's own box, else the viewport
const shot = async (r, s) => {
  if (SHOTS) { const el = await r.page.$('#hx-swap .swc'); await (el || r.page).screenshot({ path: join(SHOTS, `${r.name}-${s}.png`) }).catch(() => {}); }
  if (SLOW) await sleep(SLOW);
};
const until = (page, fn, arg, timeout = 180000) => page.waitForFunction(fn, arg, { timeout }).catch(async (e) => {
  const seen = await page.evaluate(() => ({ go: document.querySelector('#hx-swap #go')?.textContent, q: document.querySelector('#hx-swap #q')?.textContent?.replace(/\s+/g, ' ').slice(0, 200), steps: document.querySelector('#hx-swap #steps')?.innerText?.replace(/\s+/g, ' ').slice(0, 300), later: document.querySelector('#hx-swap #later')?.innerText?.replace(/\s+/g, ' ').slice(0, 260), bal: document.querySelector('#hx-swap #pay-side')?.innerText?.replace(/\s+/g, ' '), sheet: [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join(), rcpt: document.querySelector('#hx-swap #rcpt')?.innerText?.replace(/\s+/g, ' ').slice(0, 300), pills: [...document.querySelectorAll('#hx-swap [data-dg]')].map((b) => b.dataset.dg).join() })).catch(() => ({}));
  console.log('  ..     the card said: ' + JSON.stringify(seen));
  throw e;
});
const sel = (s) => `#hx-swap ${s}`, lc = (x) => String(x || '').toLowerCase();
const plan = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tacit-swap-later-v1') || '[]')[0] || null);
const fund = async (who, { eth = 0n, usdc = 0n, tac = 0n }) => {
  await rpcA('anvil_setBalance', [who, hex(eth)]);
  if (usdc) await rpcA('anvil_dealERC20', [who, USDC, hex(usdc)]);
  if (tac) { await rpcA('anvil_impersonateAccount', [TAC_HOLDER]); await rpcA('anvil_setBalance', [TAC_HOLDER, hex(10n ** 18n)]);
    await rpcA('eth_sendTransaction', [{ from: TAC_HOLDER, to: TAC, data: '0xa9059cbb' + who.slice(2).toLowerCase().padStart(64, '0') + tac.toString(16).padStart(64, '0') }]); await sleep(2500); }
  await rpcA('anvil_impersonateAccount', [who]);
};
const newWallet = () => { const j = JSON.parse(cast('wallet', 'new', '--json'))[0]; return { account: j.address, key: j.private_key }; };

// The Swap privately box is hidden while the card has no price for the pair (a first quote, or one a slow node left unanswered): it is waited for, and the amount entered again as a
// person would press Try again, before the switch is pressed
async function laterVisible(r) {
  for (let i = 0; ; i++) {
    try { await r.page.waitForFunction(() => { const l = document.querySelector('#hx-swap #later'); return l && !l.hidden && !!document.querySelector('#hx-swap #later-on'); }, null, { timeout: 90000 }); return; }
    catch (e) {
      const said = await r.page.evaluate(() => `${document.querySelector('#hx-swap #go')?.textContent} | ${document.querySelector('#hx-swap #q')?.textContent?.replace(/\s+/g, ' ')}`);
      console.log(`  ..     waiting for a price (try ${i + 1}): ${said.slice(0, 140)}`);
      if (i >= 5) throw e;
      await sleep(20000);
      const a = await r.page.inputValue(sel('#amt')); await r.page.fill(sel('#amt'), ''); await sleep(400); await r.page.fill(sel('#amt'), a);
    }
  }
}
async function turnOn(r) {
  for (let i = 0; i < 6; i++) {
    await laterVisible(r);
    if ((await r.page.getAttribute(sel('#later-on'), 'aria-checked')) === 'true') return;
    await r.page.click(sel('#later-on'), { timeout: 15000 }).catch(() => {});
    await sleep(800);
  }
  throw new Error('Swap privately could not be turned on');
}
// ── the stages every swap shares: connect, address, deposit, wait, price, confirm ──
async function connect(r) {
  await r.page.waitForSelector(sel('#amt'), { timeout: 120000 });
  await until(r.page, () => /Connect wallet/.test(document.querySelector('#hx-swap #go')?.textContent || ''), null, 120000);
  await r.page.click(sel('#go'));
  await r.page.click('#sheet-pick button:has-text("Test Wallet")');
  await until(r.page, () => !/Connect wallet/.test(document.querySelector('#hx-swap #go')?.textContent || ''), null, 60000);
}
async function signKeyIn(r, ms = 6000) {
  // or it opens at the press: signed in if it does (the locator handler above has it when a click is waiting)
  try { const el = await r.page.waitForSelector('#sheet-wallet[open] [data-in="eth"]', { timeout: ms }); await el.click(); } catch { /* not asked, or already signed */ }
}
async function deposit(r, dest, label) {
  await r.page.fill(sel('#to-in'), dest);
  // zQuoter's scan of every pool, asked of an upstream node through a caching proxy, can run past the card's limit the first time and answers from the cache after: the amount is
  // entered again, as a person would press Try again
  for (let i = 0; ; i++) {
    try { await r.page.waitForFunction(() => /^Deposit [\d.,]+ (ETH|USDC|TAC)/.test(document.querySelector('#hx-swap #go')?.textContent || ''), null, { timeout: 90000 }); break; }
    catch (e) {
      const said = await r.page.evaluate(() => `${document.querySelector('#hx-swap #go')?.textContent} | ${document.querySelector('#hx-swap #q')?.textContent?.replace(/\s+/g, ' ')}`);
      console.log(`  ..     waiting for the price (try ${i + 1}): ${said.slice(0, 160)}`);
      // a button that says the wallet cannot afford it is the card's answer, not a quote that is slow
      if (i >= 5 || /Not enough|Leave about|Leave some ETH/.test(said)) throw e;
      await sleep(20000);
      const a = await r.page.inputValue(sel('#amt')); await r.page.fill(sel('#amt'), ''); await sleep(400); await r.page.fill(sel('#amt'), a);
    }
  }
  await sleep(1500); await shot(r, '1-ready');
  const btn = (await r.page.textContent(sel('#go'))).trim(), rcpt = (await r.page.textContent(sel('#rcpt'))).replace(/\s+/g, ' ');       // before the press: the card clears it once it is made
  const tPress = Date.now(), endLine = timeline(r, 'deposit');
  // a fork slowed by a cold node can make the keeper's quote fail once ("internal error"), a scan run past the card's limit, or a price grow older than the minute the card trusts ("read again"): the button is pressed again, as a person would, up to three times
  let msg = '';
  for (let k = 0; k < 3; k++) {
    await r.page.click(sel('#go'));
    await signKeyIn(r);
    await until(r.page, () => /Deposited\.|did not|failed|revert|Not enough|moved|Nothing was (sent|spent)|too high|internal error|could not quote|Try again|read again|fee moved/i.test(document.querySelector('#hx-swap #q')?.textContent || ''), null, 600000).catch(() => {});
    msg = (await r.page.textContent(sel('#q'))).replace(/\s+/g, ' ').trim();
    if (!/internal error|could not quote|Try again|read again|fee moved/i.test(msg)) break;
    console.log(`  ..     the card said "${msg.slice(0, 80)}": pressing again`);
    await sleep(15000);
    await until(r.page, () => /^Deposit [\d.,]+ (ETH|USDC|TAC)/.test(document.querySelector('#hx-swap #go')?.textContent || ''), null, 120000);
  }
  endLine();
  console.log(`  ..     the deposit, from the press to the plan waiting: ${Math.round((Date.now() - tPress) / 1000)} s`);
  await shot(r, '2-deposited');
  return { btn, rcpt, msg, plan: await plan(r.page) };
}
async function swapOut(r) {
  await until(r.page, () => !!document.querySelector('#hx-swap [data-later-go]'), null, 120000);
  await sleep(1000); await shot(r, '3-waiting');
  await r.page.click(sel('[data-later-go]'));
  await until(r.page, () => !!document.querySelector('#hx-swap [data-later-ok]'), null, 180000);
  await shot(r, '4-price');
  const tOk = Date.now(), endSwap = timeline(r, 'swap out');
  await r.page.click(sel('[data-later-ok]'));
  await signKeyIn(r).catch(() => {});
  await until(r.page, () => /Swapped\.|did not|failed|revert|moved|Nothing was (sent|spent)|refus/i.test(document.querySelector('#hx-swap #q')?.textContent || ''), null, 900000).catch(() => {});
  const msg = (await r.page.textContent(sel('#q'))).replace(/\s+/g, ' ').trim();
  endSwap();
  console.log(`  ..     the swap out, from Confirm to Swapped: ${Math.round((Date.now() - tOk) / 1000)} s`);
  await sleep(6000); await shot(r, '5-done');
  return { msg, plan: await plan(r.page) };
}
// What the card says as a stage goes on, with the seconds it took to say it: the timeline of a press, printed as it changes
function timeline(r, label) {
  const t0 = Date.now(); let last = '', live = true;
  (async () => {
    while (live) {
      const now = await r.page.evaluate(() => { const q = document.querySelector('#hx-swap #q')?.textContent?.replace(/\s+/g, ' ').trim() || '', st = document.querySelector('#hx-swap #steps .st li.now .t')?.innerText?.replace(/\s+/g, ' ').trim() || ''; return [q, st].filter(Boolean).join(' | '); }).catch(() => '');
      if (now && now !== last) { last = now; console.log(`  ..     ${label} +${String(Math.round((Date.now() - t0) / 1000)).padStart(3)} s  ${now.slice(0, 150)}`); }
      await sleep(1500);
    }
  })();
  return () => { live = false; };
}
const txOf = (h) => rpcA('eth_getTransactionByHash', [h]);

// ── Alice: ETH → USDC ──
async function eth() {
  console.log('\nAlice: ETH → USDC, a fresh address, the deposit\'s gas her own ETH');
  const w = newWallet(), DEST = '0x' + '4a'.repeat(20);
  await fund(w.account, { eth: 3n * 10n ** 18n });
  const r = await openPage({ ...w, name: 'alice', viewport: { width: 1280, height: 1300 } });
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/?to=USDC&amt=0.05`);
    await connect(r);
    await until(r.page, () => document.querySelector('#hx-swap #later-on')?.getAttribute('aria-checked') === 'true', null, 60000);
    ok(true, 'the Pay pool hop is on by itself for ETH → USDC');
    const d = await deposit(r, DEST, 'eth');
    const rc = d.rcpt;
    ok(/^Deposit [\d.]+ ETH/.test(d.btn), `the button deposits ETH (${d.btn})`);
    ok(/Deposit gas\s*[\d.]+ ETH/.test(rc), `the receipt names the deposit's gas, in ETH (${(rc.match(/Deposit gas[^R]*/) || [''])[0].trim()})`);
    ok(/Deposited\./.test(d.msg) && d.plan?.state === 'waiting', `the deposit landed and the plan waits (${d.msg.slice(0, 90)})`);
    ok(r.log.sends.length === 1 && [POOL, ROUTER].some((a) => r.log.sends[0].to.toLowerCase() === a.toLowerCase()), `one transaction, from Alice's wallet, to the pool (${r.log.sends.map((s) => s.to.slice(0, 10)).join(',')})`);
    const u0 = await bal(USDC, DEST);
    const s = await swapOut(r);
    ok(/Swapped\./.test(s.msg) && s.plan?.state === 'done', `the swap out was relayed (${s.msg.slice(0, 100)})`);
    const got = (await bal(USDC, DEST)) - u0;
    ok(s.plan?.min && got >= BigInt(s.plan.min), `the fresh address got ${Number(got) / 1e6} USDC, at least the ${Number(BigInt(s.plan?.min || 0)) / 1e6} shown`);
    const tx = s.plan?.swapTx ? await txOf(s.plan.swapTx) : null;
    ok(tx && tx.from.toLowerCase() === keeperAddr.toLowerCase() && !tx.input.toLowerCase().includes(w.account.slice(2).toLowerCase()), 'the swap out was sent by the keeper and does not name Alice');
    ok(r.log.sends.length === 1, 'Alice\'s wallet sent nothing after the deposit');
    ok(/received/.test(await r.page.textContent(sel('#steps'))), `the done step says what arrived (${(await r.page.textContent(sel('#steps'))).match(/[\d.,]+ USDC received/)?.[0] || '?'})`);
    ok(!r.errors.length, `no page errors${r.errors.length ? ': ' + r.errors.slice(0, 3).join(' | ') : ''}`);
  } finally { await r.browser.close(); }
}

// ── Bob (USDC) and Carol (TAC): no ETH at all, the relay pays the deposit's gas ──
async function noEth(who, token, sym, amt, perUnit) {
  console.log(`\n${who}: ${sym} → DAI, no ETH in the wallet, the relay pays the deposit's gas in ${sym}`);
  const w = newWallet(), DEST = '0x' + (sym === 'USDC' ? '4b' : '4c').repeat(20);
  await fund(w.account, sym === 'USDC' ? { usdc: 1000n * 10n ** 6n } : { tac: 1000n * 10n ** 18n });
  const r = await openPage({ ...w, name: who.toLowerCase(), viewport: { width: 1280, height: 1500 } });
  const start = { usdc: await bal(USDC, w.account), tac: await bal(TAC, w.account) };
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/?from=${sym}&to=DAI&amt=${amt}`);
    await connect(r);
    await turnOn(r);
    // the card first reads the deposit's gas as ETH, until it has the wallet's balance and the relay's fee: the receipt is read once it says the relay pays
    // (a fresh wallet's balances are cold reads through the proxy and can take minutes the first time)
    await until(r.page, () => /Deposit gas[^R]*no ETH needed/.test((document.querySelector('#hx-swap #rcpt')?.textContent || '').replace(/\s+/g, ' ')), null, 300000).catch(() => {});
    const rc0 = (await r.page.textContent(sel('#rcpt'))).replace(/\s+/g, ' ');
    ok(new RegExp(`Deposit gas\\s*about \\$[\\d.,]+ in ${sym}, no ETH needed`).test(rc0), `the receipt says the deposit's gas is paid in ${sym}, no ETH needed (${(rc0.match(/Deposit gas[^R]*/) || [''])[0].trim()})`);
    await until(r.page, () => document.querySelector('#hx-swap [data-dg="eth"]')?.disabled === true, null, 20000).catch(() => {});
    ok(await r.page.evaluate(() => document.querySelector('#hx-swap [data-dg="eth"]')?.disabled === true), 'the ETH pill is off: this wallet holds none');
    const d = await deposit(r, DEST, sym);
    ok(/^Deposit [\d.,]+ (USDC|TAC)/.test(d.btn), `the button deposits ${sym} (${d.btn})`);
    ok(/Deposited\./.test(d.msg) && d.plan?.state === 'waiting' && d.plan.boxed === true, `the relay's order sold the ${sym} into the deposit box and the keeper completed it (${d.msg.slice(0, 80)})`);
    ok(r.log.sends.length === 0, `the wallet sent no transaction (${r.log.sends.length})`);
    ok(r.log.orders.length === 1 && r.log.orders[0].order.recipient.toLowerCase() === d.plan.box.toLowerCase() && r.log.orders[0].order.tokenOut === ZERO, 'one order was signed, selling the token for ETH into the deposit box');
    ok(BigInt(r.log.orders[0].order.minOut) === BigInt(d.plan.boxWei) && lc(r.log.orders[0].order.target) === lc('0x000000000000FB114709235f1ccBFfb925F600e4'), `its signed minimum is exactly what the box needs (${r.log.orders[0].order.minOut}) and its call goes to zRouter`);
    ok((await bal(ZERO, w.account)) === 0n, 'the wallet still holds no ETH');
    const spent = sym === 'USDC' ? start.usdc - (await bal(USDC, w.account)) : start.tac - (await bal(TAC, w.account));
    ok(spent > BigInt(d.plan.pay.amountWei) && spent <= BigInt(d.plan.pay.amountWei) * 1030n / 1000n, `it paid ${Number(spent) / perUnit} ${sym}: the sale and the relay's fee`);
    const note = Number(BigInt(d.plan.depositWei)) / 1e18, boxEth = BigInt(await rpcA('eth_getBalance', [d.plan.box, 'latest']));
    ok(boxEth < BigInt(d.plan.boxWei) / 100n, `what the sale paid above the box is under one percent of it: ${Number(boxEth) / 1e18} ETH of ${Number(BigInt(d.plan.boxWei)) / 1e18}`);
    ok(new RegExp(`${amt} ${sym} → DAI`).test(await r.page.textContent(sel('#steps'))), `the plan is named in the coin it started with (${(await r.page.textContent(sel('#steps'))).match(/[\d.,]+ \w+ → DAI/)?.[0] || '?'})`);
    ok(note > 0, `the pool holds the deposit as a note of ${note} ETH`);
    const dai0 = await bal(DAI, DEST);
    const s = await swapOut(r);
    ok(/Swapped\./.test(s.msg) && s.plan?.state === 'done', `the swap out was relayed (${s.msg.slice(0, 100)})`);
    const got = (await bal(DAI, DEST)) - dai0;
    ok(s.plan?.min && got >= BigInt(s.plan.min), `the fresh address got ${Number(got) / 1e18} DAI, at least the ${Number(BigInt(s.plan?.min || 0)) / 1e18} shown`);
    const tx = s.plan?.swapTx ? await txOf(s.plan.swapTx) : null;
    ok(tx && tx.from.toLowerCase() === keeperAddr.toLowerCase() && !tx.input.toLowerCase().includes(w.account.slice(2).toLowerCase()), `the swap out was sent by the keeper and does not name ${who}`);
    ok((await bal(ZERO, w.account)) === 0n && r.log.sends.length === 0, `${who} never held ETH and sent no transaction, from the deposit to the DAI`);
    ok(!r.errors.length, `no page errors${r.errors.length ? ': ' + r.errors.slice(0, 3).join(' | ') : ''}`);
  } finally { await r.browser.close(); }
}

// ── Erin: ETH, USDC and TAC all in the wallet. The card starts on ETH (the cheaper way); she picks TAC for the deposit's gas and no ETH leaves her wallet ──
async function pick() {
  console.log('\nErin: USDC → DAI with ETH, USDC and TAC in the wallet: the deposit\'s gas is hers to choose');
  const w = newWallet(), DEST = '0x' + '4d'.repeat(20);
  await fund(w.account, { eth: 2n * 10n ** 18n, usdc: 1000n * 10n ** 6n, tac: 1000n * 10n ** 18n });
  const r = await openPage({ ...w, name: 'erin', viewport: { width: 1280, height: 1500 } });
  const eth0 = await bal(ZERO, w.account), tac0 = await bal(TAC, w.account);
  console.log(`  ..     she holds ${Number(eth0) / 1e18} ETH, ${Number(await bal(USDC, w.account)) / 1e6} USDC and ${Number(tac0) / 1e18} TAC`);
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/?from=USDC&to=DAI&amt=100`);
    await connect(r);
    await turnOn(r);
    await until(r.page, () => !!document.querySelector('#hx-swap [data-dg="tac"]') && /Deposit gas/.test(document.querySelector('#hx-swap #rcpt')?.textContent || ''), null, 180000);
    const pressed = () => r.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#hx-swap [data-dg]')].map((b) => [b.dataset.dg, b.getAttribute('aria-pressed') === 'true' && !b.disabled])));
    const p0 = await pressed(), rc0 = (await r.page.textContent(sel('#rcpt'))).replace(/\s+/g, ' ');
    ok(p0.eth && !p0.token && !p0.tac, `with ETH in the wallet the card pays the deposit's gas in ETH, the cheaper way, and offers the token and TAC (${JSON.stringify(p0)})`);
    ok(/Deposit gas[^R]*ETH[^R]*from|Deposit gas\s*[\d.]+ ETH/.test(rc0), `and the receipt says so (${(rc0.match(/Deposit gas[^R]*/) || [''])[0].trim()})`);
    await shot(r, '1a-eth-by-default');
    await r.page.click(sel('[data-dg="tac"]'));
    await until(r.page, () => /Deposit gas[^R]*in TAC[^R]*no ETH needed/.test((document.querySelector('#hx-swap #rcpt')?.textContent || '').replace(/\s+/g, ' ')), null, 60000);
    const p1 = await pressed();
    ok(p1.tac && !p1.eth, `picking TAC moves the choice to it (${JSON.stringify(p1)}) and the receipt says the relay is paid in TAC`);
    ok(await r.page.evaluate(() => document.querySelector('#hx-swap [data-via="token"]')?.disabled === true), 'and the swap goes through the ETH pool: the USDC pool\'s pill is off');
    await shot(r, '1b-tac-picked');
    const d = await deposit(r, DEST, 'pick');
    ok(/Deposited\./.test(d.msg) && d.plan?.state === 'waiting' && d.plan.boxed === true, `the deposit went through the relay's order and the keeper's box (${d.msg.slice(0, 70)})`);
    ok(r.log.sends.length === 0 && (await bal(ZERO, w.account)) === eth0, `no ETH left the wallet and it sent no transaction (${r.log.sends.length} sends)`);
    ok(r.log.orders.length === 1 && r.log.orders[0].order.feeToken.toLowerCase() === TAC.toLowerCase() && r.log.orders[0].order.tokenIn.toLowerCase() === USDC.toLowerCase(), 'the order sells USDC and takes its fee in TAC');
    ok(BigInt(r.log.orders[0].order.minOut) === BigInt(d.plan.boxWei), 'and its signed minimum is exactly what the box needs');
    ok(tac0 - (await bal(TAC, w.account)) > 0n, `the fee came out of the TAC (${Number(tac0 - (await bal(TAC, w.account))) / 1e18} TAC)`);
    ok(!r.errors.length, `no page errors${r.errors.length ? ': ' + r.errors.slice(0, 3).join(' | ') : ''}`);
  } finally { await r.browser.close(); }
}

// ── Frank: USDC and ETH. The unchanged way in: the wallet's own transaction to the zap, its gas his ETH ──
async function zap() {
  console.log('\nFrank: USDC → DAI with ETH in the wallet: the deposit is his own transaction to the zap');
  const w = newWallet(), DEST = '0x' + '4e'.repeat(20), ZAP = '0x0000008EbBF2323f95c4fBc18254f3D65C53998c';
  await fund(w.account, { eth: 2n * 10n ** 18n, usdc: 1000n * 10n ** 6n });
  const r = await openPage({ ...w, name: 'frank', viewport: { width: 1280, height: 1500 } });
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/?from=USDC&to=DAI&amt=100`);
    await connect(r);
    await turnOn(r);
    await until(r.page, () => /Deposit gas[^R]*ETH/.test((document.querySelector('#hx-swap #rcpt')?.textContent || '').replace(/\s+/g, ' ')), null, 180000);
    const d = await deposit(r, DEST, 'zap');
    ok(/Deposited\./.test(d.msg) && d.plan?.state === 'waiting' && !d.plan.boxed && d.plan.pay?.sym === 'USDC', `the deposit landed and the plan waits (${d.msg.slice(0, 70)})`);
    ok(r.log.sends.length === 1 && r.log.sends[0].to.toLowerCase() === ZAP.toLowerCase(), `one transaction, from his wallet, to the zap (${r.log.sends.map((x) => x.to.slice(0, 10)).join(',')})`);
    ok(r.log.orders.length === 0, 'and no relay order: nothing about this way changed');
    ok(!r.errors.length, `no page errors${r.errors.length ? ': ' + r.errors.slice(0, 3).join(' | ') : ''}`);
  } finally { await r.browser.close(); }
}

// ── Gina: USDC and no ETH, USDC → TAC with no address typed, which ends in her private balance: the relay's way pays an address only, so it is not offered ──
async function priv() {
  console.log('\nGina: USDC → TAC into her private balance with no ETH: the relay\'s way is not offered');
  const w = newWallet();
  await fund(w.account, { usdc: 1000n * 10n ** 6n });
  const r = await openPage({ ...w, name: 'gina', viewport: { width: 1280, height: 1500 } });
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/?from=USDC&to=TAC&amt=100`);
    await connect(r);
    await turnOn(r);
    // the button reads "Try again" when the keeper's fee could not be read once (a slow fork): pressed, as a person would, until it says what is missing
    let go = '';
    for (let i = 0; i < 8; i++) {
      await until(r.page, () => /Deposit gas/.test(document.querySelector('#hx-swap #rcpt')?.textContent || '') && !/Finding the best price|Reading the relay/.test(document.querySelector('#hx-swap #go')?.textContent || ''), null, 180000);
      go = (await r.page.textContent(sel('#go'))).trim();
      if (!/Try again/.test(go)) break;
      await r.page.click(sel('#go')); await sleep(8000);
    }
    const pills = await r.page.evaluate(() => [...document.querySelectorAll('#hx-swap [data-dg]')].map((b) => b.dataset.dg).join());
    const rc = (await r.page.textContent(sel('#rcpt'))).replace(/\s+/g, ' ');
    ok(!/no ETH needed/.test(rc) && !/token|tac/.test(pills), `no way through the relay is offered (pills: ${pills || 'none'})`);
    ok(/Leave some ETH for the network fee/.test(go), `the button says what is missing, as before (${go})`);
    await shot(r, '1-no-relay');
    ok(r.log.orders.length === 0 && r.log.sends.length === 0, 'and nothing was signed or sent');
  } finally { await r.browser.close(); }
}

try {
  if (WANT.includes('priv')) await priv();
  if (WANT.includes('pick')) await pick();
  if (WANT.includes('zap')) await zap();
  if (WANT.includes('eth')) await eth();
  if (WANT.includes('usdc')) await noEth('Bob', USDC, 'USDC', '100', 1e6);
  if (WANT.includes('tac')) await noEth('Carol', TAC, 'TAC', '300', 1e18);
} catch (e) { fails++; console.log('FAIL   ' + (e?.stack || e)); }
if (fails) console.error(klog.join('').split('\n').slice(-25).join('\n'));
console.log(`\n${n} passed, ${fails} failed${SHOTS ? `; screenshots in ${SHOTS}` : ''}${VIDEO ? `; video in ${VIDEO}` : ''}`);
server.close(); stop();
process.exit(fails ? 1 : 0);
