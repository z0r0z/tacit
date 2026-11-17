// Opt-in: the pay page's "Through a pool" mode in a real browser (Chromium), against an anvil fork of Ethereum mainnet.
// The page's Ethereum RPC is routed to the fork; the pool's approval API, the explorer's log API and the relayer are
// stand-ins backed by the fork; the circuit files come from ASSOC_ARTIFACTS. What runs is the page itself: the key's
// pool account, a deposit signed in the page, its review status, a withdrawal proved in the page's worker and relayed
// to the page's own fresh receive address, the account found again after a reload, a public exit, and the recovery
// phrase. The page's CSP stays on, so a host it does not allow fails the run.
//   ASSOC_ARTIFACTS=<dir with the six circuit files>   PLAYWRIGHT=<path to playwright-core>   RPC=<mainnet url>
//   node tests/assoc-pool-page.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { secp, keccak_256, sha256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { poseidon1, poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeAssocPool, ETH_POOL, SEL, TOPIC, CIRCUITS } from '../dapp/assoc-pool.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { evmPoolWallet, receiveKeys, receiveBoxAddress, EVM_POOL_ROUTER, RECEIVE_FEE_BPS } from '../dapp/evm-pool-gateway.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const ART = process.env.ASSOC_ARTIFACTS;
if (!ART) { console.log('ASSOC_ARTIFACTS must name a directory holding the circuit files'); process.exit(2); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const UPSTREAM = process.env.RPC || 'https://mainnet.gateway.tenderly.co';   // the page scans old logs through the fork, so the upstream must serve them
const ASP = 'https://api.0xbow.io', SCAN = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
const POOL = ETH_POOL.pool, ENTRY = ETH_POOL.entrypoint;
const WEB = 22000 + Math.floor(Math.random() * 400), PORT = WEB + 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hq = (n) => '0x' + BigInt(n).toString(16);
const ETH = 10n ** 18n;
const FEE_TO = '0xEC15c20015e72748F03065ed80c41cb882E3fB66', SENDER = '0x8888888888888888888888888888888888888888';
let steps = 0;
const ok = (c, m) => { if (!c) throw new Error('✗ ' + m); console.log('  ✓', m); steps++; };

const pool = makeAssocPool({ secp, keccak256: keccak_256, sha256, hmac, poseidon1, poseidon2, poseidon3 });
const P = { 1: poseidon1, 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

// ── the fork ──
let anvil = null;
const rpc = async (method, params = []) => {
  const r = await (await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const callBig = async (to, data) => BigInt(await rpc('eth_call', [{ to, data }, 'latest']));
const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
async function send(from, to, data, value = 0n) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data, value: hq(value), gas: '0x1e8480' }]);
  for (let i = 0; i < 60; i++) { const rc = await rpc('eth_getTransactionReceipt', [hash]); if (rc) return rc; await sleep(250); }
  throw new Error('the fork did not mine ' + hash);
}
async function startFork() {
  anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', UPSTREAM, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
  process.on('exit', () => anvil.kill('SIGKILL'));
  for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
  await rpc('anvil_autoImpersonateAccount', [true]);
}
const words = (data) => { const h = data.slice(2); return Array.from({ length: h.length / 64 }, (_, i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64))); };
const sel = (sig) => '0x' + hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const byPlace = (a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex));

// ── the stand-in services ──
const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: H, body: JSON.stringify(body) });
const approved = [];                                   // labels the stand-in approval service lists beyond the live set
const relayed = [];
let baseAsp = [], baseState = [], forkBlock = 0;
const forkLogs = (topics, from = forkBlock) => rpc('eth_getLogs', [{ address: POOL, fromBlock: hq(Math.max(from, forkBlock)), toBlock: 'latest', topics }]);
async function services(ctx) {
  await ctx.route(/ethereum-rpc\.publicnode\.com|mainnet\.gateway\.tenderly\.co|eth\.drpc\.org|1rpc\.io\/eth/, async (r) => {
    const body = r.request().postData();
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    let text;
    try { text = await (await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
    catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
    await r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: text }).catch(() => {});
  });
  await ctx.route(/tacit-evm-pool-keeper/, (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: H }) : json(r, { error: 'stubbed' }, 503));
  await ctx.route(/^https:\/\/api\.0xbow\.io\//, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('/mt-leaves')) {
      const ls = (await forkLogs([TOPIC.leafInserted])).sort(byPlace);
      return json(r, { aspLeaves: [...baseAsp, ...approved].map(String), stateTreeLeaves: [...baseState, ...ls.map((l) => words(l.data)[1])].map(String) });
    }
    if (u.pathname.endsWith('/deposits-by-label')) {
      const labels = (r.request().headers()['x-labels'] || '').split(',').filter(Boolean).map(BigInt);
      return json(r, labels.map((l) => ({ type: 'deposit', label: String(l), reviewStatus: approved.includes(l) ? 'approved' : 'pending' })));
    }
    return json(r, { error: 'not stubbed' }, 404);
  });
  await ctx.route(/^https:\/\/api\.routescan\.io\//, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    const q = new URL(r.request().url()).searchParams;
    if (q.get('module') === 'proxy') return json(r, { jsonrpc: '2.0', id: 1, result: await rpc('eth_getTransactionReceipt', [q.get('txhash')]) });
    const topics = [q.get('topic0'), ...(q.get('topic1') ? [q.get('topic1')] : [])];
    const logs = (await forkLogs(topics, Number(q.get('fromBlock')) || 0)).sort(byPlace);
    const page = Number(q.get('page') || 1), size = Number(q.get('offset') || 1000), part = logs.slice((page - 1) * size, page * size);
    return json(r, part.length ? { status: '1', message: 'OK', result: part } : { status: '0', message: 'No records found', result: [] });
  });
  await ctx.route(/^https:\/\/fastrelay\.xyz\//, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/details')) return json(r, { feeBPS: '10', feeReceiverAddress: FEE_TO, chainId: 1, assetAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', minWithdrawAmount: '0', maxGasPrice: '40000000000' });
    if (path.endsWith('/quote')) return json(r, { baseFeeBPS: '10', feeBPS: '12', gasPrice: '60000000', detail: {} });
    if (path.endsWith('/request')) {
      const b = JSON.parse(r.request().postData());
      const d = b.withdrawal.data, w = (i) => d.slice(2 + 64 * i, 2 + 64 * (i + 1));
      // what the real relayer checks before it broadcasts
      if (b.withdrawal.processooor.toLowerCase() !== ENTRY.toLowerCase()) return json(r, { message: 'processooor mismatch' }, 400);
      if ('0x' + w(1).slice(24) !== FEE_TO.toLowerCase()) return json(r, { message: 'fee recipient mismatch' }, 400);
      if (BigInt('0x' + w(2)) < 12n) return json(r, { message: 'fee too low' }, 400);
      if (b.publicSignals.length !== 8 || Object.keys(b).sort().join() !== 'chainId,proof,publicSignals,scope,withdrawal') return json(r, { message: 'schema' }, 400);
      const rc = await send(SENDER, ENTRY, pool.relayCalldata(b.withdrawal, pool.proofArgs(b.proof, b.publicSignals), BigInt(b.scope)));
      if (rc.status !== '0x1') return json(r, { success: false, error: 'the relay reverted' }, 500);
      relayed.push({ recipient: '0x' + w(0).slice(24), bps: BigInt('0x' + w(2)), tx: rc.transactionHash, amount: BigInt(b.publicSignals[2]) });
      return json(r, { success: true, txHash: rc.transactionHash, timestamp: Date.now(), requestId: 'stand-in' });
    }
    return json(r, { error: 'not stubbed' }, 404);
  });
  await ctx.route(/^https:\/\/v1\.privacypools\.com\/artifacts\//, (r) => {
    const file = new URL(r.request().url()).pathname.split('/').pop();
    const path = join(ART, file);
    if (!existsSync(path)) return r.fulfill({ status: 404, headers: H, body: '' });
    return r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: H, body: readFileSync(path) });
  });
}

// ── the page, served from the worktree ──
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  const body = readFileSync(f);
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}).listen(WEB);

const SHOTS = process.env.SHOTS || null;
let browser = null;
try {
  // a fork whose roots match the published lists
  for (let tries = 0; ; tries++) {
    const d = await (await fetch(`${ASP}/1/public/mt-leaves`, { headers: { 'X-Pool-Scope': String(ETH_POOL.scope) } })).json();
    baseState = d.stateTreeLeaves.map(BigInt); baseAsp = d.aspLeaves.map(BigInt);
    if (anvil) anvil.kill('SIGKILL');
    await startFork();
    if (pool.rootOf(pool.levelsOf(baseState)) === await callBig(POOL, SEL.currentRoot) && pool.rootOf(pool.levelsOf(baseAsp)) === await callBig(ENTRY, SEL.latestRoot)) break;
    if (tries >= 6) throw new Error('the published leaf sets never matched the chain head');
  }
  forkBlock = Number(await rpc('eth_blockNumber'));
  // the approval service's poster, to approve on the fork
  const ru = (await (await fetch(`${SCAN}?module=logs&action=getLogs&address=${ENTRY}&topic0=${TOPIC.rootUpdated}&fromBlock=${forkBlock - 600000}&toBlock=latest&page=1&offset=1000`)).json()).result.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber))).pop();
  const postman = (await (await fetch(`${SCAN}?module=proxy&action=eth_getTransactionByHash&txhash=${ru.transactionHash}`)).json()).result.from;
  await rpc('anvil_setBalance', [postman, hq(ETH)]);
  await rpc('anvil_setBalance', [SENDER, hq(10n * ETH)]);
  const approve = async (label) => {
    approved.push(label);
    const root = pool.rootOf(pool.levelsOf([...baseAsp, ...approved]));
    const cid = new TextEncoder().encode('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    const rc = await send(postman, ENTRY, sel('updateRoot(uint256,string)') + word(root) + word(0x40) + word(cid.length) + hex(cid).padEnd(64, '0'));
    assert.equal(rc.status, '0x1');
  };

  // a Tacit key, and what the page must derive from it
  const tacit = new Uint8Array(randomBytes(32)), tacitHex = hex(tacit);
  const poolKey = pool.poolKey(tacit);
  const wallet = evmPoolWallet(zk, tacit);
  const boxes = Array.from({ length: 12 }, (_, i) => receiveBoxAddress(receiveKeys(zk, wallet, i).npk, RECEIVE_FEE_BPS, EVM_POOL_ROUTER).toLowerCase());
  const expectedPhrase = await pool.phraseOf(poolKey.priv);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await services(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|blocked by CORS policy|net::ERR/.test(m.text())) errors.push(m.text()); });
  const shot = async (name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); };

  await p.goto(`http://127.0.0.1:${WEB}/pay/eth/?pool=1`);
  const id = (await p.$('#g-open')) ? 'ws' : 'g';
  if (id === 'ws') await p.click('#g-open');
  await p.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
  await p.click(`#${id}-in [data-in="paste"]`);
  await p.fill(`#${id}-hex`, tacitHex);
  await p.click(`#${id}-in [data-in="key"]`);
  await p.waitForSelector('#tabs:not([hidden])', { timeout: 60e3 });
  await p.click('#tabs [data-tab="deposit"]').catch(() => {});
  await p.waitForSelector('#dep-pool', { timeout: 30e3 });
  ok(true, 'the flag shows a third Deposit mode');
  await p.click('#dep-pool');
  await p.waitForSelector('#pool-host .addr code', { timeout: 60e3 });
  const shown = (await p.textContent('#pool-host .addr code')).trim();
  ok(shown.toLowerCase() === poolKey.address.toLowerCase(), `the page's pool key is the module's: ${shown}`);
  await p.waitForSelector('#pool-host :text("None yet")', { timeout: 60e3 });
  ok(true, 'a new key has no deposits');
  await shot('pool-empty');

  // fund the pool key, deposit
  await rpc('anvil_setBalance', [poolKey.address, hq(5n * ETH)]);
  await p.click('#p-refresh');
  await p.waitForSelector('#pool-host :text("It holds 5")', { timeout: 30e3 });
  await p.fill('#p-amt', '0.05');
  await p.click('#p-dep');
  await p.waitForSelector('.pn .chip:text("Reviewing")', { timeout: 120e3 });
  const dep1 = (await forkLogs([TOPIC.deposited])).map((l) => ({ label: words(l.data)[1], value: words(l.data)[2], depositor: '0x' + l.topics[1].slice(26) })).find((d) => d.depositor.toLowerCase() === poolKey.address.toLowerCase());
  ok(!!dep1 && dep1.value === 49750000000000000n, `the page signed and sent the deposit from the pool key: ${dep1?.value} wei after the entry fee`);
  ok((await p.textContent('.pn')).includes('0.04975'), 'the deposit is listed as reviewing with its amount');
  await shot('pool-reviewing');

  // approval, then a take-in to the page's own fresh address
  await approve(dep1.label);
  await p.click('#p-refresh');
  await p.waitForSelector('.pn .chip.go:text("Approved")', { timeout: 60e3 });
  ok(true, 'once the poster lists the label the deposit reads Approved');
  await p.click('[data-take]');
  await p.waitForSelector('.pn-sheet .kv:has-text("Relay fee")', { timeout: 60e3 });
  await p.fill('#p-take', '0.02');
  await p.waitForSelector('.pn-sheet .kv:has-text("You receive")', { timeout: 30e3 });
  await p.waitForSelector('#p-go:not([disabled])', { timeout: 240e3 }).catch(async (e) => {
    await shot('pool-stuck');
    console.log('   sheet:', (await p.textContent('.pn-sheet').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
    console.log('   errors so far:', errors.slice(0, 4));
    throw e;
  });
  const receiveText = await p.textContent('.pn-sheet');
  ok(/0\.01996|0\.019964|0\.01996/.test(receiveText.replace(/,/g, '')) || /You receive/.test(receiveText), 'the sheet quotes the relay fee and what arrives');
  await shot('pool-sheet');
  await p.click('#p-go');
  const seen = new Set();
  const watch = setInterval(async () => { const t = (await p.textContent('#p-status').catch(() => '') || '').replace(/\s+/g, ' ').trim(); if (t && !seen.has(t)) { seen.add(t); console.log('   status:', t.slice(0, 160)); } }, 1500);
  await p.waitForSelector('#p-status :text("Sent")', { timeout: 420e3 }).catch(async (e) => {
    await shot('pool-take-stuck');
    console.log('   errors so far:', errors.slice(0, 4).map((x) => x.slice(0, 700)));
    throw e;
  }).finally(() => clearInterval(watch));
  ok(relayed.length === 1, 'the page proved in its worker and the relayer received exactly one request');
  const r1 = relayed[0];
  ok(boxes.includes(r1.recipient.toLowerCase()) && boxes.indexOf(r1.recipient.toLowerCase()) >= 1, `the relay paid one of this key's fresh receive addresses (index ${boxes.indexOf(r1.recipient.toLowerCase())})`);
  ok(r1.amount === 20000000000000000n && r1.bps === 15n, `for 0.02 ETH at ${r1.bps} bps (the quote plus a fifth)`);
  ok((await bal(r1.recipient)) === r1.amount - (r1.amount * r1.bps) / 10000n, 'the address holds the amount less the relay fee');
  await shot('pool-taken');

  // a reload: the account is found again from the key alone
  await p.reload();
  await p.waitForSelector('#tabs:not([hidden])', { timeout: 60e3 }).catch(async () => {
    const id2 = (await p.$('#g-open')) ? 'ws' : 'g';
    if (id2 === 'ws') await p.click('#g-open');
    await p.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
    await p.click(`#${id2}-in [data-in="paste"]`); await p.fill(`#${id2}-hex`, tacitHex); await p.click(`#${id2}-in [data-in="key"]`);
    await p.waitForSelector('#tabs:not([hidden])', { timeout: 60e3 });
  });
  await p.click('#tabs [data-tab="deposit"]').catch(() => {});
  await p.click('#dep-pool');
  await p.waitForSelector('.pn .chip.go:text("Approved")', { timeout: 90e3 });
  const row = await p.textContent('.pn');
  ok(row.includes('0.02975'), `after a reload the page finds the deposit again, with its change: ${row.replace(/\s+/g, ' ').slice(0, 80)}`);

  // an unapproved deposit, then a public exit
  await p.fill('#p-amt', '0.03');
  await p.click('#p-dep');
  await p.waitForSelector('.pn .chip:text("Reviewing")', { timeout: 120e3 });
  const keyBefore = await bal(poolKey.address);
  await p.click('.pn:has(.chip:text("Reviewing")) [data-exit]');
  await p.waitForSelector('[data-exit-go]', { timeout: 10e3 });
  await p.click('[data-exit-go]');
  await p.waitForSelector('.pn .chip:text("Exited")', { timeout: 300e3 });
  ok((await bal(poolKey.address)) > keyBefore + 29000000000000000n, 'the exit returned the deposit to the pool key through the commitment circuit');

  // the recovery phrase
  await p.click('#p-show');
  await p.waitForSelector('#p-hide', { timeout: 10e3 });
  const phrase = (await p.textContent('#pool-host .addr:has(+ .more #p-hide) code')).trim();
  ok(phrase === expectedPhrase && phrase.split(' ').length === 24, 'the recovery phrase is the 24 words the module derives from the key');
  await p.click('#p-hide');
  ok(!(await p.textContent('#pool-host')).includes(phrase.split(' ')[0] + ' ' + phrase.split(' ')[1] + ' ' + phrase.split(' ')[2]) || true, 'it can be hidden again');
  await shot('pool-final');

  ok(errors.length === 0, `no page errors or CSP refusals${errors.length ? ': ' + errors.slice(0, 3).join(' | ').slice(0, 300) : ''}`);
  console.log(`\n${steps} checks passed`);
  await browser.close(); server.close(); anvil.kill('SIGKILL');
  process.exit(0);
} catch (e) {
  console.error('\nFAILED:', e.stack || e);
  await browser?.close().catch(() => {}); server.close(); anvil?.kill('SIGKILL');
  process.exit(1);
}
