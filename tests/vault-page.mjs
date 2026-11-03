#!/usr/bin/env node
// dapp/vault/ in a real browser, under its own CSP, against two TacVaults (a dollar vault and an ETH vault) deployed on a local anvil with
// the test price oracle: the room to borrow, a position and its health bar, the top-up prompt, deposit (a permit, and the approval it falls back to),
// borrow with its fee, repay (short of the fee, then all), withdraw, the paused state, an auction, a read-only account, and the opens-soon state of
// the page as deployed (no addresses). Every limit the page offers is checked against the contract itself: the amount is accepted by an eth_call, one
// wei more is refused.
//
//   1. build the three contracts it deploys (about 5 seconds; contracts/out is git-ignored build output):
//        cd contracts && forge build src/TacVault.sol src/FixedFeed.sol test/TacVaultMocks.sol
//      This needs contracts/lib (solady); in a git worktree, which has none: ln -s <main checkout>/contracts/lib contracts/lib
//   2. run it (needs anvil and cast on PATH, and playwright-core):
//        VAULT_OUT=<forge out dir> PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/vault-page.mjs        (SHOTS=dir saves screenshots)
//
// VAULT_OUT holds the compiled TacVault, the test mocks (contracts/test/TacVaultMocks.sol) and FixedFeed; it defaults to contracts/out. If an artifact
// is missing, or is there without bytecode (output left by an older build of the repo), the test says "skipped" and why, and stops with status 0; rebuild
// with the command above.
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname, DAPP = join(REPO, 'dapp'), FX = join(REPO, 'tests/fixtures');
const OUT = process.env.VAULT_OUT || join(REPO, 'contracts/out'), SHOTS = process.env.SHOTS || null;
const need = ['TacVault.sol/TacVault', 'TacVaultMocks.sol/TestTac', 'TacVaultMocks.sol/MockOracle', 'TacVaultMocks.sol/LiveFeed', 'FixedFeed.sol/FixedFeed'];
const BUILD = 'cd contracts && forge build src/TacVault.sol src/FixedFeed.sol test/TacVaultMocks.sol';
const bytecodeOf = (f) => { try { return JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode?.object || ''; } catch { return ''; } };
const absent = need.filter((f) => !existsSync(join(OUT, `${f}.json`))), stale = need.filter((f) => !absent.includes(f) && !/^(0x)?([0-9a-f]{2})+$/i.test(bytecodeOf(f)));
if (absent.length) { console.log(`skipped: ${OUT} has no compiled ${absent.join(', ')} (${BUILD}, or set VAULT_OUT)`); process.exit(0); }
if (stale.length) { console.log(`skipped: ${OUT} is stale, ${stale.join(', ')} has no bytecode; rebuild: ${BUILD}`); process.exit(0); }
const PW = process.env.PLAYWRIGHT || (existsSync('/Users/z/zFi/node_modules/playwright-core') ? '/Users/z/zFi/node_modules/playwright-core' : 'playwright-core');
const { chromium } = createRequire(import.meta.url)(PW);
const PORT = Number(process.env.ANVIL_PORT) || 21000 + Math.floor(Math.random() * 1000), WEB = Number(process.env.WEB_PORT) || PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', '1', '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
let server;
const finish = (code) => { anvil.kill('SIGKILL'); server?.close(); process.exit(code); };
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(250); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const lost = async (page, e) => { const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700)).catch(() => ''); e.message += `\n  page said: ${t}`; throw e; };
const until = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).catch((e) => lost(page, e));
const untilText = (page, sel, re, timeout = 30000) => page.waitForFunction(([s, src, fl]) => new RegExp(src, fl).test((document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ')), [sel, re.source, re.flags], { timeout }).catch((e) => lost(page, e));

// ── the chain ──
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
const ACC = {
  deployer: { a: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', k: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  owner: { a: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', k: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  user: { a: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', k: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  bob: { a: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', k: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
  carol: { a: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', k: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' },
};
const PF = '0x000000Eb27B557aB426d9E99cFd54EC455799e81';                                                        // the Precision pool factory, where the page expects it
const FEE_TO = '0x00000000000000000000000000000000000000Fe', SINK = '0x000000000000000000000000000000000000dEaD';
const E18 = 10n ** 18n, MAXU = (1n << 256n) - 1n;
const art = (f) => JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode.object;
const create = (data) => JSON.parse(cast('send', '--private-key', ACC.deployer.k, '--rpc-url', ANVIL, '--json', '--create', data)).contractAddress;
const send = (who, to, sig, ...args) => cast('send', to, sig, ...args, '--private-key', ACC[who].k, '--rpc-url', ANVIL, '--json');
const view = (to, sig, ...args) => cast('call', to, sig, ...args, '--rpc-url', ANVIL).split('\n').map((l) => l.trim().split(/\s+/)[0]);
const big = (to, sig, ...args) => BigInt(view(to, sig, ...args)[0]);
const reverts = (fn) => { try { fn(); return false; } catch { return true; } };
const asCall = (who, to, sig, ...args) => cast('call', to, sig, ...args, '--from', ACC[who].a, '--rpc-url', ANVIL);

// Multicall3 is where the page expects it; two vaults share one test oracle and TAC; the dollar vault prices through a feed that says 2,500, the
// ETH vault through the fixed feed (1.0).
await rpcA('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', readFileSync(join(FX, 'multicall3-runtime.hex'), 'utf8').trim()]);
// The Precision pool factory (and the data contract its pool creation code comes from) are the live ones' code at their mainnet addresses, as the pools section below needs.
await rpcA('anvil_setCode', ['0x000000Eb27B557aB426d9E99cFd54EC455799e81', readFileSync(join(FX, 'precision/factory.hex'), 'utf8').trim()]);
await rpcA('anvil_setCode', [readFileSync(join(FX, 'precision/poolcode.addr'), 'utf8').trim(), readFileSync(join(FX, 'precision/poolcode.hex'), 'utf8').trim()]);
const TAC = create(art('TacVaultMocks.sol/TestTac')), ORACLE = create(art('TacVaultMocks.sol/MockOracle'));
const FEED = create(art('TacVaultMocks.sol/LiveFeed')), FIXED = create(art('FixedFeed.sol/FixedFeed'));
const noLimit = MAXU.toString();
const makeVault = (feed, name, symbol, minDebt, oracle = ORACLE) => {
  const cfg = `(${TAC},${oracle},${feed},${ACC.owner.a},35000,20000,2500,5400,1200,${minDebt},3900,${noLimit},500,50,100,${FEE_TO},${SINK},${name},${symbol})`;
  const enc = cast('abi-encode', 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))', cfg);
  return create(art('TacVault.sol/TacVault') + enc.slice(2));
};
const USD = makeVault(FEED, 'TAC Dollar', 'TACD', (100n * E18).toString()), ETH = makeVault(FIXED, 'TAC Ether', 'TACE', (E18 / 25n).toString());
const SYN = { usd: view(USD, 'SYNTH()(address)')[0], eth: view(ETH, 'SYNTH()(address)')[0] };
const P0 = 10n ** 14n;                                                                                  // 0.0001 ETH per TAC: $0.25 at 2,500
const setPrice = (p) => send('deployer', ORACLE, 'set(uint256)', String(p));
setPrice(P0); send('deployer', ORACLE, 'setDepth(uint256)', String(2000n * E18));                      // 2,000 ETH deep: room is 5% of it in each synth
const mintTac = (to, amount) => send('deployer', TAC, 'mint(address,uint256)', to, String(amount));
mintTac(ACC.user.a, 1_000_000n * E18); mintTac(ACC.bob.a, 1_000_000n * E18); mintTac(ACC.carol.a, 1_000_000n * E18);
const vaultOf = (v, who) => { const [c, d, a] = view(v, 'vaults(address)(uint256,uint256,uint256)', ACC[who].a); return { c: BigInt(c), d: BigInt(d), a: BigInt(a) }; };
const snap = async () => (await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp;

// ── the page ──
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', 'rpc.mevblocker.io', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io', 'eth.rpc.blxrbdn.com', '1.rpc.thirdweb.com', '1rpc.io', 'mainnet.gateway.tenderly.co', 'eth-mainnet.nodereal.io', 'rpc.flashbots.net'];
// `batch`: a wallet that is a smart account and sends several calls as one transaction (EIP-5792): its account is given BatchRun's code (a 7702-style delegation), so each call
// comes from the account, as it would from a real one.
const BATCH_RUN_HEX = /BATCH_RUN = '(0x[0-9a-f]+)'/.exec(readFileSync(join(DAPP, 'vault/batch.js'), 'utf8'))[1];
const DELEGATE = '0x' + 'b47c0001'.padStart(40, '0');
async function stubWallet(ctx, { who, noTyped = false, batch = false }) {
  const log = { sends: [], signs: 0, bundles: [], bundleIds: {} };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    const a = ACC[who].a;
    if (method === 'eth_requestAccounts') return [a];
    if (method === 'eth_accounts') return [a];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'wallet_getCapabilities') { if (!batch) throw Object.assign(new Error('Method not found'), { code: -32601 }); return { '0x1': { atomic: { status: 'supported' } } }; }
    if (method === 'wallet_sendCalls') {
      if (!batch) throw Object.assign(new Error('Method not found'), { code: -32601 });
      const q = params[0]; log.bundles.push(q);
      await rpcA('anvil_setCode', [DELEGATE, BATCH_RUN_HEX]); await rpcA('anvil_setCode', [a, '0xef0100' + DELEGATE.slice(2)]);
      const data = cast('calldata', 'run(address[],bytes[])', `[${q.calls.map((c) => c.to).join(',')}]`, `[${q.calls.map((c) => c.data).join(',')}]`);
      const hash = await rpcA('eth_sendTransaction', [{ from: a, to: a, data, gas: '0x1c9c380' }]);
      log.bundleIds[hash] = hash; return { id: hash };
    }
    if (method === 'wallet_getCallsStatus') {
      const hash = log.bundleIds[params[0]], rc = await rpcA('eth_getTransactionReceipt', [hash]);
      return { version: '2.0.0', id: params[0], chainId: '0x1', atomic: true, status: rc ? (rc.status === '0x1' ? 200 : 500) : 100, receipts: rc ? [{ transactionHash: hash, status: rc.status, blockNumber: rc.blockNumber, blockHash: rc.blockHash, gasUsed: rc.gasUsed, logs: [] }] : [] };
    }
    if (method === 'wallet_watchAsset') { (log.watched ||= []).push(params); return true; }
    if (method === 'eth_signTypedData_v4') { if (noTyped) throw Object.assign(new Error('Method not supported'), { code: -32601 }); log.signs++; return cast('wallet', 'sign', '--private-key', ACC[who].k, '--data', params[1]); }
    if (method === 'eth_sendTransaction') { if (log.stall) return new Promise(() => {}); log.sends.push(params[0]); return rpcA('eth_sendTransaction', [{ ...params[0], gas: String(params[0].to).toLowerCase() === PF.toLowerCase() ? '0x1c9c380' : '0x3d0900' }]); }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}
// The page opens on Borrow; these tests open it on Deposit unless a hash says otherwise (`&t=borrow` for the default).
const M_OUT = (txt) => { const [a, b = ''] = txt.split('.'); return BigInt(a) * E18 + BigInt((b + '0'.repeat(18)).slice(0, 18)); };
const hashFor = (extra = '') => `#vusd=${USD}&veth=${ETH}&t=deposit${extra}`;
// `bare`: the page served with a deployments module that names no vault, as it was before the vaults existed (the opens-soon state).
// `limited`: hosts that answer every call as a node that has run out of its free requests does.
// `lp`: what the points service answers to /lp (the liquidity campaign); null is a service with the campaign off. The page never reaches the real one.
// `hold`: { re, gate }: a call whose body matches `re` waits for the promise `gate` before it is answered (a slow node, or a router not yet asked).
// `rpcLog`: an array that gets the body of every request the page sends to a node, from the first.
async function openPage({ viewport = { width: 1280, height: 900 }, who = null, noTyped = false, batch = false, hash = hashFor(), host = '127.0.0.1', scheme = 'light', args = [], bare = false, limited = [], hold = null, lp = null, rpcLog = null } = {}) {
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  if (bare) await ctx.route('**/vault/deployments.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const DEPLOYMENTS = Object.freeze({ chainId: 1, vaults: Object.freeze([]) });' }));
  await ctx.route('https://tacit-points.onrender.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(lp ?? { enabled: false }) }));
  const walletLog = who ? await stubWallet(ctx, { who, noTyped, batch }) : null;
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    if (limited.includes(h)) return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'You reached Public endpoint rate limit, please upgrade to paid plan' } }) });
    try {
      if (hold && hold.re.test(route.request().postData() || '')) await hold.gate;
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => { if (process.env.DEBUG) console.log('[pageerror]', e.message, String(e.stack || '').split('\n').slice(1, 4).join(' | ')); errors.push(String(e.message || e)); });
  if (process.env.DEBUG) page.on('requestfailed', (q) => console.log('[requestfailed]', q.url().slice(0, 100), q.failure()?.errorText));
  page.on('console', (m) => { if (process.env.DEBUG) console.log('[page]', m.type(), m.text()); if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  if (rpcLog) page.on('request', (q) => { if (q.method() === 'POST' && RPC_HOSTS.some((h) => q.url().includes(h))) rpcLog.push(q.postData() || ''); });
  await page.goto(`http://${host}:${WEB}/vault/${hash}`);
  return { browser, ctx, page, errors, blocked, walletLog };
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }) : null);
const closeAll = async (...rs) => { for (const r of rs) await r?.browser.close().catch(() => {}); };
const money = (s) => BigInt(Math.round(Number(s.replace(/,/g, '')) * 100)) * (E18 / 100n);                // "1,234.56" → wei, for what the page writes to two places
const typed = async (p, v) => { await p.fill('#amt', v); await sleep(60); };
// The most a vault takes from an account as a plain borrow, from the contract's own figures: the debt at most at most 1/3.5 of the collateral's value at the borrow view over 3.5), the the 1% fee on top.
const directLimit = (vault, who) => {
  const v = vaultOf(vault, who), pB = big(vault, 'valueOf(uint256,bool)(uint256)', String(E18), 'true'), room = v.c * pB / E18 * 10000n / 35000n - v.d;
  let lo = 0n, hi = room > 0n ? room : 0n;
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (mid + mid * 100n / 10000n <= room) lo = mid; else hi = mid - 1n; }
  return lo;
};
const chipMax = async (p) => { await p.click('#chips [data-pct="100"]'); await sleep(60); return BigInt(cast('to-wei', await p.inputValue('#amt'))); };
// Connect the stub wallet once the page has read the vaults (a click before its script has run does nothing).
const connect = async (p) => { await until(p, () => !!document.querySelector('#board table') && /Room to borrow/.test(document.querySelector('#board')?.textContent || '')); await p.click('#go'); await until(p, () => /^0x/.test(document.querySelector('#wallet-label')?.textContent || '')); };
const tab = async (p, t) => { await p.click(`#acts [data-t="${t}"]`); await sleep(60); };

let r, r2;
try {
  // ── as deployed: the two mainnet vaults ──
  const { DEPLOYMENTS } = await import(new URL('../dapp/vault/deployments.js', import.meta.url).href);
  ok(DEPLOYMENTS.chainId === 1 && DEPLOYMENTS.vaults.map((v) => v.key).join() === 'usd,eth' && DEPLOYMENTS.vaults.every((v) => /^0x0{6}[0-9a-fA-F]{34}$/.test(v.vault)), `the page names the dollar and the ETH vault on mainnet (${DEPLOYMENTS.vaults.map((v) => v.vault).join(', ')})`);
  // ── with no addresses the page opens soon; an address in the bar is ignored away from this computer ──
  r = await openPage({ hash: '', bare: true });
  await until(r.page, () => !document.querySelector('#soon').hidden);
  const soon = await text(r.page, '#soon');
  ok(/Opens soon/.test(soon) && /TAC Dollar \(TACD\)/.test(soon) && /TAC Ether \(TACE\)/.test(soon) && (soon.match(/\./g) || []).length <= 3, `with no addresses the page says it opens soon, in two sentences (${soon.slice(0, 120)}…)`);
  ok(await r.page.$eval('#app', (e) => e.hidden) && await r.page.$eval('#wallet-chip', (e) => e.hidden), 'and shows no vault and no wallet button');
  ok(r.errors.length === 0 && r.blocked.length === 0, `with nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  await shot(r.page, 'soon');
  await closeAll(r);
  r = await openPage({ host: 'vault.localhost', bare: true });
  await sleep(1500);
  ok(!(await r.page.$eval('#soon', (e) => e.hidden)) && await r.page.$eval('#app', (e) => e.hidden), 'vault addresses in the address bar are ignored away from this computer: the page still opens soon');
  await closeAll(r);

  // ── the address without its slash goes to the page, the fragment kept ──
  r = await openPage({ hash: '' }); await r.page.goto(`http://127.0.0.1:${WEB}/vault${hashFor('&a=' + ACC.user.a)}`);
  await until(r.page, () => location.pathname === '/vault/' && !document.querySelector('#app').hidden);
  ok(r.page.url() === `http://127.0.0.1:${WEB}/vault/${hashFor('&a=' + ACC.user.a)}`, '/vault goes to /vault/ and keeps the #fragment');
  await closeAll(r);

  // ── borrowing against TAC and against Bitcoin have their own addresses: /vault/ and its #btc side ──
  r = await openPage({ hash: '' }); await r.page.goto(`http://127.0.0.1:${WEB}/vault/tac?x=1#a`);
  await until(r.page, () => location.pathname === '/vault/' && !document.querySelector('#app').hidden);
  ok(r.page.url() === `http://127.0.0.1:${WEB}/vault/?x=1#a`, '/vault/tac goes to /vault/ with its query and fragment');
  ok(await r.page.$eval('.via', (n) => [...n.querySelectorAll('a')].map((a) => `${a.textContent}:${a.getAttribute('href')}:${a.getAttribute('aria-current') || ''}`).join()) === 'TAC:/vault/:page,Bitcoin:/vault/#btc:', 'the page offers TAC and Bitcoin, TAC being the one it is');
  ok(await r.page.$eval('.via', (n) => [...n.querySelectorAll('a svg use')].map((u) => u.getAttribute('href')).join()) === '#tk-tac,#c-btc', 'each side carries its mark: TAC’s and Bitcoin’s');
  await r.page.goto(`http://127.0.0.1:${WEB}/vault/btc`, { waitUntil: 'domcontentloaded' });
  await until(r.page, () => location.pathname === '/vault/' && location.hash === '#btc' && document.documentElement.dataset.side === 'btc');
  ok(await r.page.$eval('.via a[aria-current="page"]', (a) => a.dataset.side) === 'btc', '/vault/btc opens this page’s Bitcoin side (/vault/#btc)');
  await r.page.goto(`http://127.0.0.1:${WEB}/vault/btc/`, { waitUntil: 'domcontentloaded' });
  await until(r.page, () => location.pathname === '/vault/' && location.hash === '#btc');
  ok(true, 'with or without its trailing slash');
  await closeAll(r);

  // ── a vault's hint (deployments.js) lets the first request read everything, and is checked against the vault ──
  {
    const hintOf = (v) => ['TAC()(address)', 'SYNTH()(address)', 'ORACLE()(address)', 'ETH_USD()(address)'].map((sig) => view(v, sig)[0]);
    const right = { usd: hintOf(USD).join(), eth: hintOf(ETH).join() };
    const staleOracle = (h) => h.split(',').map((a, i) => (i === 2 ? '0x000000000000000000000000000000000000dEaD' : a)).join();
    const staticOnly = (log) => log.filter((b) => b.includes('19f68523') && !b.includes('70a08231')).length;     // a request for the vaults' addresses and terms alone, with none of the figures that follow
    const board = async (p) => { await untilText(p, '#board', /Room to borrow/); await until(p, () => !/…/.test(document.querySelector('#board table')?.textContent || '…')); return text(p, '#board table'); };      // the markets row fills in a little after the rest
    const logs = { none: [], right: [], stale: [] };
    r = await openPage({ rpcLog: logs.none });
    const plain = await board(r.page);
    ok(staticOnly(logs.none) === 1, 'a vault with no hint is asked for its addresses first, then for everything (one request for the addresses alone)');
    await closeAll(r);
    r = await openPage({ hash: hashFor(`&husd=${right.usd}&heth=${right.eth}`), rpcLog: logs.right });
    const hinted = await board(r.page);
    ok(staticOnly(logs.right) === 0, 'a vault with a hint is read in one request: none asks for its addresses alone');
    ok(hinted === plain && /Room to borrow/.test(hinted), 'and the board is the one the vaults\' own answers give');
    ok(r.errors.length === 0 && r.blocked.length === 0, `with nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    await closeAll(r);
    r = await openPage({ hash: hashFor(`&husd=${staleOracle(right.usd)}&heth=${staleOracle(right.eth)}`), rpcLog: logs.stale });
    const stale = await board(r.page);
    ok(stale === plain, 'a hint that the vault does not bear out (its oracle was changed) is dropped and the board is read from the vault\'s answers: the same board');
    ok(staticOnly(logs.stale) >= 1 && r.errors.length === 0, 'by asking the vault for its addresses, with nothing logged');
    await closeAll(r);
  }

  // ── public numbers, no wallet ──
  r = await openPage();
  const p = r.page;
  await until(p, () => /250,000\s*TACD/.test(document.querySelector('#board')?.textContent || ''));
  const cap = await text(p, '#board');
  ok(/Borrowing is open on both vaults/.test(cap) && /Room to borrow\s*250,000 TACD\s*100 TACE/.test(cap) && /Borrowed so far\s*0 TACD\s*0 TACE/.test(cap) && /Fee\s*1%\s*1%/.test(cap) && /Smallest debt\s*100 TACD\s*0\.04 TACE/.test(cap), `the status board says both are open, with the room (the depth's 5% less the debt), the smallest debt, the fee and what is borrowed: ${cap.slice(0, 200)}`);
  ok(!/Pools’ depth|TAC price|Collateral ratio/.test(cap) && (await text(p, '#board [data-more]')) === 'More figures', 'the further figures wait behind More figures');
  await p.click('#board [data-more]');
  const more = await text(p, '#board');
  ok(/Pools’ depth\s*5,000,000 TACD.*2,000 TACE/.test(more) && /Share of depth lent\s*5%\s*5%/.test(more) && /Borrow \/ liquidate at\s*350% · 200%\s*350% · 200%/.test(more) && /TAC deposited\s*0 TAC\s*0 TAC/.test(more), 'and give the pools\' depth, the share of it lent, the TAC deposited and the ratios');
  ok(/TAC price\s*\$0\.25\s*0\.0001 ETH/.test(more) && /ETH\/USD price\s*\d+ (min|s|h)[^—]*—/.test(more) && (await text(p, '#board [data-more]')) === 'Fewer figures', 'the TAC price now in each vault\'s token, and how old the dollar feed is (TAC Ether has none)');
  ok(await p.evaluate(() => localStorage.getItem('tacit-vault-more')) === '1', 'the choice is kept in this browser');
  ok(await p.title() === 'tacit borrow' && /read (just now|\d+ s ago)/.test(await text(p, '#board .eyebrow')) && !!(await p.$('#board [data-refresh]')), 'the tab\'s title is the page\'s name, and the board says when it was read, with a Refresh');
  ok((await p.$$eval('#pick button', (b) => b.map((x) => x.textContent))).join('|') === 'TAC DollarTACD|TAC EtherTACE', 'two vaults to pick: TAC Dollar and TAC Ether');
  ok(/Connect a wallet to see your vault/.test(await text(p, '#pos')) && /Connect wallet/.test(await text(p, '#go')), 'with no wallet the position asks for one and the button connects');
  ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  // the ETH vault's own numbers: room 100 TACE, in ETH terms
  await p.click('#pick [data-v="eth"]');
  await until(p, () => /TAC Ether vault/.test(document.querySelector('#ticket')?.textContent || ''));
  ok(/Room to borrow\s*250,000 TACD\s*100 TACE/.test(await text(p, '#board')) && /Borrow TACE|TACE to deposit|TAC to deposit/.test(await text(p, '#ticket')), 'choosing the ETH vault leaves the board showing both, and the ticket speaks of TACE');
  await closeAll(r);

  // ── the nodes first in line are rate limited: the page reads from the one left, and its content policy allows every node it asks ──
  r = await openPage({ limited: RPC_HOSTS.slice(0, -1) });
  await until(r.page, () => /250,000\s*TACD/.test(document.querySelector('#board')?.textContent || ''));
  ok(/Borrowing is open on both vaults/.test(await text(r.page, '#board')), 'with every node but the last saying it is rate limited the page still reads both vaults');
  ok(r.errors.filter((e) => !/status of 429/.test(e)).length === 0 && r.blocked.length === 0, `and asked each of them without the content policy refusing any (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  await closeAll(r);

  // ── paused: no price recorded ──
  send('deployer', ORACLE, 'setBroken(bool)', 'true');
  r = await openPage();
  await until(r.page, () => /Could not read the prices/.test(document.querySelector('#board')?.textContent || ''));
  const pb = await text(r.page, '#board');
  ok(/Borrowing is not open yet/.test(pb) && /Borrowing\s*Not open.*Not open/.test(pb) && /Room to borrow\s*—\s*—/.test(pb) && !/error|revert/i.test(pb), 'with no price the board says borrowing is not open and that prices cannot be read, calmly, with no room shown');
  ok(r.errors.length === 0, 'and logs no error');
  await shot(r.page, 'paused');
  await closeAll(r);
  send('deployer', ORACLE, 'setBroken(bool)', 'false');

  // ── thin: the room is under the smallest debt ──
  send('deployer', ORACLE, 'setDepth(uint256)', String(E18 / 2n));                                       // 0.5 ETH deep: the room is 0.025 ETH, under each vault's smallest debt
  r = await openPage();
  await until(r.page, () => /under the smallest debt/.test(document.querySelector('#board')?.textContent || ''));
  const tb = await text(r.page, '#board');
  ok(/Borrowing is not open yet/.test(tb) && /Room to borrow\s*62\.5 TACD\s*0\.025 TACE/.test(tb) && /TAC Dollar: Room \(62\.5 TACD\) is under the smallest debt \(100 TACD\)/.test(tb) && /TAC Ether: Room \(0\.025 TACE\) is under the smallest debt \(0\.04 TACE\)/.test(tb), `a room under the smallest debt is said with both figures, and the vault is not open (${tb.slice(0, 160)})`);
  ok((await r.page.$eval('#board .needs a[href="/rewards/#farm"]', (a) => a.textContent)) === 'Add liquidity →' && await r.page.title() === 'tacit borrow', 'the way to more room is the TAC pools, and the tab\'s title stays the page\'s name');
  // an announced change to the share of depth lent opens it: the board says what the room becomes and from when
  send('owner', USD, 'queueParam(uint8,uint256)', '0', '1000'); send('owner', ETH, 'queueParam(uint8,uint256)', '0', '1000');
  await r.page.reload();
  await until(r.page, () => /borrowing opens from/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const ta = await text(r.page, '#board');
  ok(/The announced change makes the room 125 TACD \(smallest debt 100 TACD\): borrowing opens from \d+ \w+ \d+:\d+ UTC/.test(ta) && /makes the room 0\.05 TACE \(smallest debt 0\.04 TACE\): borrowing opens from/.test(ta), `an announced change that opens it says the room it makes and from when (${ta.replace(/\s+/g, ' ').slice(120, 330)})`);
  send('owner', USD, 'cancelParam(uint8)', '0'); send('owner', ETH, 'cancelParam(uint8)', '0');
  send('deployer', ORACLE, 'setDepth(uint256)', String(2000n * E18));
  await closeAll(r);

  // ── a wallet: deposit, by permit ──
  r = await openPage({ who: 'user' });
  const u = r.page, W = r.walletLog;
  await until(u, () => /250,000\s*TACD/.test(document.querySelector('#board')?.textContent || ''));
  await connect(u);
  await until(u, () => /Nothing deposited yet/.test(document.querySelector('#pos')?.textContent || ''));
  ok(/Nothing deposited yet\. Deposit TAC to borrow TACD against it\./.test(await text(u, '#pos')), 'connected, a new account has nothing in the vault');
  await until(u, () => /Balance 1,000,000/.test(document.querySelector('#bal')?.textContent || ''));
  await typed(u, '100000');
  ok(/Collateral after\s*100,000 TAC/.test(await text(u, '#info')) && /Deposit TAC/.test(await text(u, '#go')), 'typing a deposit shows the collateral after it, and the button');
  await u.click('#go');
  await untilText(u, '#status', /Deposited 100,000 TAC/, 60000);
  ok(W.signs === 1 && W.sends.length === 1 && W.sends[0].to.toLowerCase() === USD.toLowerCase(), `no allowance: one permit signed (no gas) and ONE transaction sent to the vault (${W.signs} signature, ${W.sends.length} sent)`);
  ok(vaultOf(USD, 'user').c === 100000n * E18 && big(TAC, 'allowance(address,address)(uint256)', ACC.user.a, USD) === 0n, 'the vault holds 100,000 TAC and no allowance is left over');
  await until(u, () => /100,000 TAC/.test(document.querySelector('#pos')?.textContent || ''));
  ok(/Collateral\s*100,000 TAC\s*25,000 TACD/.test(await text(u, '#pos')), `the position shows the collateral and its value at the liquidation view (${(await text(u, '#pos')).slice(0, 100)})`);

  // ── borrow: what the limit is, what the fee does, and what the contract says ──
  await tab(u, 'borrow');
  const L = directLimit(USD, 'user');                                                                    // the limit on the TAC already in the vault, exactly
  ok(L > 0n && !reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(L), '100')) && reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(L + 1n), '100')), `the limit the page gives (${L} wei) is accepted by the vault, one wei more is refused`);
  ok(/Up to 70,721\.\d\d · Max/.test(await text(u, '#bal')) && L >= 7072n * E18 && L < 7073n * E18, 'at 350% of $25,000 with a 1% fee on top the limit on the vault\'s own TAC is 7,072 TACD, and Max counts the 900,000 TAC in the wallet too: 70,721');
  await typed(u, String(cast('from-wei', String(L))));
  ok(/^Borrow TACD$/.test(await text(u, '#go')) && !/Deposit/.test(await text(u, '#info')) && !(await u.$eval('#go', (b) => b.disabled)), 'the vault\'s exact limit is a plain borrow, with no deposit');
  await typed(u, String(cast('from-wei', String(L + 1n))));
  ok(/^Deposit [\d,.]+ TAC and borrow$/.test(await text(u, '#go')) && /TAC added to your vault\s*[\d,.]+ TAC/.test(await text(u, '#info')) && !(await u.$eval('#go', (b) => b.disabled)), 'one wei over it the page offers to deposit TAC with the borrow, in the same transaction');
  await typed(u, '3000');
  const rows = await text(u, '#info');
  ok(/Fee \(1%\)\s*30 TACD/.test(rows) && /You receive\s*3,000 TACD/.test(rows) && /You owe after\s*3,030 TACD/.test(rows) && /Ratio after\s*825%/.test(rows), `the fee is shown before: ${rows}`);
  ok(await u.$$eval('#info svg use', (a) => a.map((x) => x.getAttribute('href'))).then((h) => h.length >= 3 && h.every((x) => x === '#tk-tacd' || x === '#tk-tac')), 'each amount in the receipt carries its token’s mark');
  ok(/825%/.test(await text(u, '#after .hb-val')) && /Open/.test(await text(u, '#tk-h')) && await u.$eval('#after .hb', (e) => e.getAttribute('aria-hidden') === 'true' && !e.hasAttribute('role')), 'the ticket says the vault is open, and draws the health bar for where the borrow would leave it (825%, the same as its row), once, for the eye');
  await typed(u, '8000');
  ok(/^Deposit [\d,.]+ TAC and borrow$/.test(await text(u, '#go')) && /You receive\s*8,000 TACD/.test(await text(u, '#info')) && /Ratio after\s*[4-9]\d\d%/.test(await text(u, '#info')), `over what the vault's own TAC allows it offers the deposit that makes it work, enough to stay at 400% (${(await text(u, '#info')).slice(0, 120)})`);
  await typed(u, '50');
  ok(/Smallest debt is 100 TACD: borrow at least 99(\.0\d)?\./.test(await text(u, '#hint')) && await u.$eval('#go', (b) => b.disabled), 'under the minimum debt it says what to borrow at least');
  await typed(u, '3000');
  W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Borrowed 3,000 TACD\. You owe 3,030/, 60000);
  ok(W.sends.length === 1 && vaultOf(USD, 'user').d === 3030n * E18 && big(SYN.usd, 'balanceOf(address)(uint256)', ACC.user.a) === 3000n * E18, 'borrowing sends one transaction: 3,000 received, 3,030 owed');
  ok(W.sends[0].data === cast('calldata', 'borrow(uint256,uint256)', String(3000n * E18), '100'), 'its maximum fee is the fee on the screen (100 basis points)');
  ok(big(SYN.usd, 'balanceOf(address)(uint256)', FEE_TO) === 30n * E18, 'and the 30 fee went to the fee address');
  // the owner raises the fee while a borrow sits on the screen: the page stops, with the new fee, and sends nothing
  await typed(u, '200'); W.sends.length = 0;
  send('owner', USD, 'setBorrowFee(uint256)', '200');
  await u.click('#go');
  await untilText(u, '#status', /The borrow fee is now 2%\. Nothing was sent/, 30000);
  ok(W.sends.length === 0 && vaultOf(USD, 'user').d === 3030n * E18, 'a borrow on the screen at a 1% fee is not sent at 2%: the page says the fee changed and sends nothing');
  await u.fill('#amt', ''); send('owner', USD, 'setBorrowFee(uint256)', '100');
  await until(u, () => /Ratio\s*825%/.test(document.querySelector('#pos')?.textContent || ''));
  const pos = await text(u, '#pos');
  ok(/Debt\s*3,030 TACD/.test(pos) && /Safe/.test(pos) && /You can borrow\s*4,0\d\d(\.\d+)? TACD/.test(pos) && /Liquidation price\s*\$0\.0\d+/.test(pos), `the position: ratio 825%, debt, what is still available and the liquidation price (${pos.slice(0, 260)})`);
  // the liquidation price is the price at which the vault is at 200%: 3,030 × 2 / 100,000 = $0.0606 per TAC, shown rounded up
  ok(/Liquidation price\s*\$0\.0606/.test(pos), 'the liquidation price is where the vault is at 200%: $0.0606 per TAC');
  const hb = await u.evaluate(() => { const f = (s) => parseFloat(document.querySelector(s)?.style.left || 'NaN'); return { pin: f('#pos .hb-pin'), tick: f('#pos .hb-tick'), on: [...document.querySelectorAll('#pos .hb-key span.on')].map((e) => e.textContent) }; });
  ok(Math.abs(hb.tick - 62.5) < 0.01 && hb.pin === 100 && hb.on.join() === 'Safe', `the health bar: the borrowing line is at 350% (${hb.tick}% across), the marker at the safe end (825% is off the bar's end), the Safe zone is the lit one`);
  await shot(u, 'safe-desktop');

  // ── a price fall: into redemption, the top-up prompt ──
  setPrice(P0 * 3n / 10n);                                                                               // $0.075 a TAC: $7,500 against 3,030 owed = 247%
  await u.reload(); await until(u, () => /Ratio\s*247%/.test(document.querySelector('#pos')?.textContent || ''));
  const pos2 = await text(u, '#pos');
  const need = (4n * 3030n * E18 - 7500n * E18) * E18 / (P0 * 3n / 10n * 2500n);                           // (4 × debt − value) / price, the formula, in TAC
  ok(/Redemption/.test(pos2) && /Open to redemption: a TACD holder can swap it for your TAC at its price, and your debt falls by as much/.test(pos2), 'between 200% and 400% the page says what redemption is');
  const topText = await text(u, '#pos .callout');
  const topFill = await u.$eval('#pos [data-fill]', (b) => b.dataset.fill);
  ok(/Add 61,600 TAC to reach 400%/.test(topText) && BigInt(cast('to-wei', topFill)) >= need && BigInt(cast('to-wei', topFill)) - need < E18 / 50n, `the top-up prompt says how much TAC reaches 400% (${topText}); the fill is the formula's figure rounded up to a cent (${topFill} vs ${need})`);
  const zonesNow = await u.$eval('#pos', (e) => [...e.querySelectorAll('.hb-key span.on')].map((x) => x.textContent).join());
  ok(zonesNow === 'Redemption', 'the redemption zone is the lit one');
  await shot(u, 'redemption-desktop');
  await u.click('#pos [data-fill]');
  ok(await u.inputValue('#amt') === topFill && (await u.$eval('#acts [aria-pressed="true"]', (e) => e.textContent)) === 'Deposit', 'one tap fills the deposit box with that amount');
  const ratioAfter = await text(u, '#info');
  ok(/Ratio after\s*4\d\d%/.test(ratioAfter), `and the ticket shows the ratio it leaves (${ratioAfter})`);
  const before = vaultOf(USD, 'user'); W.signs = 0; W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Deposited/, 60000);
  const after = vaultOf(USD, 'user');
  const safeNow = big(USD, 'valueOf(uint256,bool)(uint256)', String(after.c), 'false') * 10000n >= after.d * 40000n;
  ok(safeNow && after.c - before.c === BigInt(cast('to-wei', topFill)), 'depositing exactly the amount reaches 400% at the contract\'s own liquidation view');
  ok(!(big(USD, 'valueOf(uint256,bool)(uint256)', String(after.c - 10n ** 16n), 'false') * 10000n >= after.d * 40000n), 'and one cent of TAC less would not have');
  await until(u, () => /Safe/.test(document.querySelector('#pos')?.textContent || '') && !document.querySelector('#pos .callout'));
  ok(true, 'the prompt goes away once the vault is safe');
  ok(r.errors.length === 0 && r.blocked.length === 0, `deposit, borrow and top-up logged nothing and were blocked by nothing (${[...r.errors, ...r.blocked].join(' | ')})`);
  setPrice(P0);                                                                                          // the price recovers
  await u.reload(); await untilText(u, '#bal', /Balance/);

  // ── borrowing that leaves the vault exposed says so, and what to add ──
  await tab(u, 'borrow');
  const Lb = directLimit(USD, 'user');
  ok(!reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(Lb), '100')) && reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(Lb + 1n), '100')), 'after the top-up the limit is again exactly what the vault accepts');
  await typed(u, '7500');                                                                                // 3,030 + 7,575 owed against 40,400: 380%
  const hint = await text(u, '#hint');
  ok(/That leaves the vault at \d{3}%, open to redemption\. Add [\d,.]+ TAC to stay at 400% or more\./.test(hint), `a borrow that would leave the vault under 400% says what to add (${hint})`);
  await u.fill('#amt', '');

  // ── repay: short of the fee, then all ──
  await tab(u, 'repay');
  const dueNow = vaultOf(USD, 'user').d;                                                                // 3,030
  ok(/You hold 3,000 of the 3,030 TACD you owe\./.test(await text(u, '#hint')), 'the fee came out of what was lent, so the page says "You hold 3,000 of the 3,030 you owe" and nothing more');
  await typed(u, '3030');
  ok(/Not enough TACD/.test(await text(u, '#go')) && await u.$eval('#go', (b) => b.disabled), 'repaying all of it needs the fee: the button says so');
  await typed(u, '1000');
  W.signs = 0; W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Repaid\. You owe 2,030 TACD/, 60000);
  ok(W.signs === 1 && W.sends.length === 1 && vaultOf(USD, 'user').d === 2030n * E18, `a part-repayment uses the synth's permit and one transaction (${W.signs} signed, ${W.sends.length} sent)`);
  await typed(u, '1950');
  ok(/Debt left must be zero or at least 100 TACD\. Repay up to 1,930, or all 2,030\./.test(await text(u, '#hint')), 'a repayment that would leave less than the minimum is refused with the way out');
  // the fee, from the fee address
  await rpcA('anvil_impersonateAccount', [FEE_TO]); await rpcA('anvil_setBalance', [FEE_TO, '0x56bc75e2d63100000']);
  await rpcA('eth_sendTransaction', [{ from: FEE_TO, to: SYN.usd, data: '0xa9059cbb' + ACC.user.a.slice(2).toLowerCase().padStart(64, '0') + (30n * E18).toString(16).padStart(64, '0') }]);
  await u.reload(); await untilText(u, '#bal', /You hold 2,030/, 30000);
  await tab(u, 'repay'); await chipMax(u);
  ok(/Repay all TACD/.test(await text(u, '#go')) && /Owed after\s*0 TACD/.test(await text(u, '#info')), 'with the fee in hand Max repays all');
  W.signs = 0; W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Repaid\. Nothing owed now\./, 60000);
  ok(vaultOf(USD, 'user').d === 0n && big(USD, 'totalDebt()(uint256)') === 0n, 'repaying all clears the debt (the vault takes what is owed, whatever the amount asked)');

  // ── withdraw ──
  await tab(u, 'withdraw');
  const coll = vaultOf(USD, 'user').c;
  const Wm = await chipMax(u);
  ok(Wm === coll, 'with no debt Max is all the TAC in the vault');
  await u.click('#go');
  await untilText(u, '#status', /Withdrawn/, 60000);
  ok(vaultOf(USD, 'user').c === 0n && big(TAC, 'balanceOf(address)(uint256)', ACC.user.a) === 1_000_000n * E18, 'withdrawing all returns the TAC to the account and empties the vault');
  // a vault with debt: the withdraw limit
  await tab(u, 'deposit'); await typed(u, '100000'); await u.click('#go'); await untilText(u, '#status', /Deposited/, 60000);
  await tab(u, 'borrow'); await typed(u, '3000'); await u.click('#go'); await untilText(u, '#status', /Borrowed 3,000/, 60000);
  await tab(u, 'withdraw');
  const Wd = await chipMax(u);
  ok(Wd > 0n && !reverts(() => asCall('user', USD, 'withdraw(uint256)', String(Wd))) && reverts(() => asCall('user', USD, 'withdraw(uint256)', String(Wd + 1n))), `with a debt the withdraw limit (${Wd} wei) is accepted by the vault and one wei more is refused`);
  await typed(u, String(Number(cast('from-wei', String(Wd))) + 1000));
  ok(/You can withdraw up to [\d,.]+ TAC and stay at 350%\./.test(await text(u, '#hint')) && await u.$eval('#go', (b) => b.disabled), 'asking for more says how much is allowed');
  await u.fill('#amt', '');

  // ── paused with a position open: repaying and depositing go on, borrowing and withdrawing wait ──
  send('deployer', ORACLE, 'setBroken(bool)', 'true');
  await u.reload(); await until(u, () => /Borrowing is not open yet/.test(document.querySelector('#board')?.textContent || ''));
  await tab(u, 'borrow');
  ok(/Borrowing is paused/.test(await text(u, '#go')) && await u.$eval('#go', (b) => b.disabled), 'paused: the borrow button says borrowing is paused');
  await tab(u, 'withdraw');
  ok(/Withdrawing is paused/.test(await text(u, '#go')) && /With a debt, withdrawing waits until prices are recorded/.test(await text(u, '#hint')), 'and withdrawing with a debt waits too');
  await tab(u, 'deposit'); await typed(u, '10');
  ok(/Deposit TAC/.test(await text(u, '#go')) && !(await u.$eval('#go', (b) => b.disabled)), 'but a deposit goes on');
  await u.fill('#amt', '');
  ok(/The ratio shows once prices are recorded/.test(await text(u, '#pos')), 'and the position says its ratio waits for prices');
  send('deployer', ORACLE, 'setBroken(bool)', 'false');
  await closeAll(r);

  // ── an auction ──
  setPrice(P0 / 10n);                                                                                    // $0.025: $2,500 against 3,030 owed: under 200%
  send('bob', USD, 'liquidate(address)', ACC.user.a);
  await rpcA('evm_increaseTime', [300]); await rpcA('evm_mine', []);
  r = await openPage({ who: 'user' });
  const a = r.page;
  await until(a, () => !document.querySelector('#app').hidden && /Nothing|Collateral/.test(document.querySelector('#pos')?.textContent || '') || true, null, 15000);
  await connect(a); await until(a, () => /An auction is running/.test(document.querySelector('#pos')?.textContent || ''));
  const ac = await text(a, '#pos .callout.red');
  ok(/Only the vault’s owner can bid for \d{1,2}:\d\d, then anyone\./.test(ac) && /The offer is \$0\.0\d+ per TAC/.test(ac) && /a bid for all the debt takes [\d,.]+ TAC/.test(ac) && /Repay, or add TAC, to end it/.test(ac), `an auction shows the owner-only time left, the offer and the way out (${ac})`);
  ok(/Under 200%/.test(await text(a, '#pos')) && (await a.$eval('#pos', (e) => [...e.querySelectorAll('.hb-key span.on')].map((x) => x.textContent).join())) === 'Liquidation', 'the bar is in the liquidation zone');
  await shot(a, 'auction-desktop');
  await tab(a, 'borrow');
  ok(/In an auction/.test(await text(a, '#go')) && await a.$eval('#go', (b) => b.disabled) && /Borrowing waits until the auction ends/.test(await text(a, '#hint')), 'borrowing waits for the auction to end');
  await tab(a, 'withdraw');
  ok(/In an auction/.test(await text(a, '#go')), 'so does withdrawing');
  const cd1 = await text(a, '[data-cd]'); await sleep(2200); const cd2 = await text(a, '[data-cd]');
  ok(cd1 !== cd2, `the countdown runs (${cd1} then ${cd2})`);
  // add TAC to end it: the prompt's amount recovers the vault, which ends the auction
  setPrice(P0 / 4n);                                                                                     // $0.0625: $6,250 against 3,030: recovered at 200% (the test oracle's recovery view is its price)
  await a.reload();
  await until(a, () => /The vault has recovered/.test(document.querySelector('#pos')?.textContent || ''), null, 30000);
  ok(/End the auction/.test(await text(a, '#pos')), 'a vault that has recovered offers to end the auction');
  r.walletLog.sends.length = 0; await a.click('[data-cancel]'); await untilText(a, '#status', /The auction has ended/, 60000);
  ok(r.walletLog.sends.length === 1 && vaultOf(USD, 'user').a === 0n, 'ending it is one transaction, and the vault is out of the auction');
  await closeAll(r);

  // ── a pause: the owner stops liquidations, outside bids and redemptions for a while ──
  send('owner', USD, 'pauseAuctions(uint256)', '7200');
  r = await openPage({});
  await until(r.page, () => /Auctions paused/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const pz = await text(r.page, '#board');
  ok(/Auctions paused on TAC Dollar for \d{1,3}:\d\d:/.test(pz) && /no liquidations, outside bids or redemptions/.test(pz) && /Everything else works/.test(pz), `a pause is said, with its countdown and what still works (${pz.slice(0, 160).replace(/\s+/g, ' ')})`);
  await closeAll(r);
  send('owner', USD, 'resumeAuctions()');
  r = await openPage({});
  await until(r.page, () => /Room to borrow/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  await sleep(1500);
  ok(!/Auctions paused/.test(await text(r.page, '#board')), 'when the owner lifts the pause the notice is gone');
  await closeAll(r);

  // ── the owner changes a term, slowly: the page follows it ──
  r = await openPage({ hash: hashFor(`&a=${ACC.user.a}`) });
  await until(r.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''));
  const bar0 = await text(r.page, '#pos');
  await r.page.click('#board [data-more]');
  const held = await text(r.page, '#board');
  ok(/TAC deposited\s*[1-9][\d,.]* TAC\s*0 TAC/.test(held) && /Collateral ratio\s*\d+%/.test(held) && /Borrowed so far\s*[1-9][\d,.]* TACD/.test(held), `once an account has borrowed, the board shows the TAC deposited, the debt and the ratio the TAC backs it at (${held.replace(/\s+/g, ' ').slice(200, 420)})`);
  ok(/200%/.test(bar0) && /400%/.test(bar0) && !/300%/.test(bar0.replace(/350%/g, '')), 'the bar is drawn with the 200% line and the 400% line');
  send('owner', USD, 'queueParam(uint8,uint256)', '2', '15000');                                          // the liquidation ratio to 150%
  await r.page.reload();
  await until(r.page, () => /Changes announced by the owner/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const an = await text(r.page, '#board');
  // Liquidating later is easier for a borrower, so the notice says nothing is needed of them; it carries the wait and the date it lands.
  ok(/Liquidation ratio → 150% · from \d+ \w+ \d+:\d+ UTC \(in (2 days|1 day \d+ h)\)/.test(an) && /They make borrowing easier; nothing to do/.test(an) && !/repay or withdraw/.test(an), `an announced change is shown with its term, value, wait and date (${an.replace(/\s+/g, ' ').slice(-170)})`);
  // One that tightens is the one to act ahead of: a higher borrowing line means less can be borrowed against the same TAC.
  send('owner', USD, 'queueParam(uint8,uint256)', '1', '40000');                                          // the borrowing line to 400%
  await r.page.reload();
  await until(r.page, () => /Borrowing line → 400%/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const tight = await text(r.page, '#board');
  ok(/They tighten borrowing: repay or withdraw before then/.test(tight) && /Liquidation ratio → 150%/.test(tight), `a tightening change warns, alongside the easier one (${tight.replace(/\s+/g, ' ').slice(-170)})`);
  send('owner', USD, 'cancelParam(uint8)', '1');
  await r.page.reload();
  await until(r.page, () => { const b = document.querySelector('#board')?.textContent || ''; return /Changes announced by the owner/.test(b) && !/Borrowing line → 400%/.test(b); }, null, 30000);
  ok(/They make borrowing easier/.test(await text(r.page, '#board')), 'and the warning goes with it when it is cancelled');
  // the owner's tool (tools/tac-vault-admin.mjs, or VAULT_ADMIN) reads the same announcement from the chain, and builds the calldata that makes it
  const ADMIN = process.env.VAULT_ADMIN || join(REPO, 'tools/tac-vault-admin.mjs');
  if (existsSync(ADMIN)) {
    const adm = execFileSync('node', [ADMIN, 'status', USD, SYN.usd], { env: { ...process.env, RPC: ANVIL }, encoding: 'utf8' });
    ok(/\bliq\s+-> 15000\s+executable from/.test(adm) && /liquidation ratio \(bps\)\s+20000/.test(adm) && /announced minter 0x0+\b/.test(adm), `the admin tool shows the terms now and the announced change (${adm.replace(/\s+/g, ' ').slice(0, 700)})`);
    ok(execFileSync('node', [ADMIN, 'call', 'queue', 'liq', '15000'], { encoding: 'utf8' }).trim() === cast('calldata', 'queueParam(uint8,uint256)', '2', '15000'), 'and its calldata is the vault\'s own queueParam');
  }
  // a further synth minter the owner names is shown the same way, and goes when it is cancelled
  send('owner', SYN.usd, 'queueMinter(address)', TAC);
  await r.page.reload();
  await until(r.page, () => /Another contract may mint/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  ok(/Another contract may mint TACD · from \d+ \w+ \d+:\d+ UTC \(in (3 days|2 days \d+ h)\)/.test(await text(r.page, '#board')), 'an announced synth minter is shown with its wait');
  send('owner', SYN.usd, 'cancelMinter()');
  await rpcA('evm_increaseTime', [2 * 86400 + 60]); await rpcA('evm_mine', []);
  send('owner', USD, 'executeParam(uint8)', '2');
  await r.page.reload();
  await until(r.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''), null, 30000);
  const bar1 = await text(r.page, '#pos');
  ok(!/Changes announced by the owner/.test(await text(r.page, '#board')), 'once the change is made the notice is gone');
  ok(/150%/.test(bar1) && /300%/.test(bar1) && !/400%/.test(bar1), `the lines follow the new liquidation ratio: 150% and 300% (${bar1.replace(/\s+/g, ' ').slice(0, 120)})`);
  await closeAll(r);

  // ── a read-only look at another account ──
  setPrice(P0);
  r = await openPage({ hash: hashFor(`&a=${ACC.user.a}`) });
  await until(r.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''));
  const ro = await text(r.page, '#pos');
  ok(/Collateral\s*100,000 TAC/.test(ro) && /Debt\s*3,030 TACD/.test(ro) && /Use my wallet/.test(ro) && /Connect wallet/.test(await text(r.page, '#go')), `an address in the bar shows that account's vault with no wallet (${ro.slice(0, 120)})`);
  await closeAll(r);
  r = await openPage({ who: 'bob', hash: hashFor(`&a=${ACC.user.a}`) });
  await connect(r.page); await until(r.page, () => /Viewing another account/.test(document.querySelector('#go')?.textContent || ''));
  ok(await r.page.$eval('#go', (b) => b.disabled) && r.walletLog.sends.length === 0, 'viewing another account with a wallet connected cannot send anything');
  await closeAll(r);

  // ── a wallet with no TAC is pointed to where TAC is bought ──
  r = await openPage({ who: 'owner' });
  await connect(r.page); await r.page.click('#acts [data-t="deposit"]');
  await until(r.page, () => /holds no TAC/.test(document.querySelector('#hint')?.textContent || ''));
  ok(await r.page.$eval('#hint a', (a) => a.getAttribute('href')) === '/trade/tac/', 'a wallet with no TAC is pointed to where TAC is bought');
  await r.page.click('#acts [data-t="borrow"]'); await r.page.fill('#amt', '200');
  await until(r.page, () => /You hold 0/.test(document.querySelector('#hint')?.textContent || ''));
  ok(await r.page.$eval('#hint a', (a) => a.getAttribute('href')) === '/trade/tac/', 'and so is one that tries to borrow with none');
  await closeAll(r);

  // ── a wallet that cannot sign typed data: the exact approval, then the deposit ──
  r = await openPage({ who: 'bob', noTyped: true });
  const b = r.page;
  await connect(b); await until(b, () => /Balance 1,000,000/.test(document.querySelector('#bal')?.textContent || ''), null, 30000);
  await typed(b, '5000'); r.walletLog.sends.length = 0;
  await b.click('#go');
  await untilText(b, '#status', /Deposited 5,000 TAC/, 60000);
  const [s1, s2] = r.walletLog.sends;
  ok(r.walletLog.sends.length === 2 && s1.to.toLowerCase() === TAC.toLowerCase() && s1.data.startsWith('0x095ea7b3') && BigInt('0x' + s1.data.slice(-64)) === 5000n * E18 && s2.to.toLowerCase() === USD.toLowerCase(), 'without typed-data signing it approves exactly the amount, then deposits');
  ok(vaultOf(USD, 'bob').c === 5000n * E18 && big(TAC, 'allowance(address,address)(uint256)', ACC.bob.a, USD) === 0n, 'and the allowance is spent to nothing');
  await closeAll(r);

  // ── the ETH vault: borrowing TACE ──
  r = await openPage({ who: 'carol', hash: hashFor('&v=eth') });
  const c = r.page;
  await connect(c); await until(c, () => /Balance 1,000,000/.test(document.querySelector('#bal')?.textContent || ''), null, 30000);
  ok(/TAC Ether vault/.test(await text(c, '#tk-h')), 'the address bar can choose the ETH vault');
  await typed(c, '100000'); await c.click('#go'); await untilText(c, '#status', /Deposited 100,000 TAC/, 60000);
  await tab(c, 'borrow'); await typed(c, '3');                                                           // 100,000 TAC = 10 ETH; 3 TACE + 1% = 3.03 owed: 330%... that is under 350%: needs less
  ok(/up to \d\.\d+ TACE now/.test(await text(c, '#hint')) || /You receive/.test(await text(c, '#info')), 'the ETH vault answers in TACE');
  const Le = directLimit(ETH, 'carol');
  ok(!reverts(() => asCall('carol', ETH, 'borrow(uint256,uint256)', String(Le), '100')) && reverts(() => asCall('carol', ETH, 'borrow(uint256,uint256)', String(Le + 1n), '100')), `its limit (${Le} wei of TACE) is exactly what the ETH vault accepts`);
  await typed(c, '2'); await c.click('#go'); await untilText(c, '#status', /Borrowed 2 TACE\. You owe 2\.02/, 60000);
  ok(vaultOf(ETH, 'carol').d === 202n * E18 / 100n, 'borrowing 2 TACE owes 2.02');
  await closeAll(r);

  // ── deposit and borrow in one transaction: an account with no vault, TAC in its wallet and no allowance ──
  r = await openPage({ who: 'carol' });
  const k = r.page, K = r.walletLog;
  await connect(k); await until(k, () => /Balance 900,000/.test(document.querySelector('#bal')?.textContent || ''), null, 30000);
  await tab(k, 'borrow');
  ok(/Up to 63,649\.\d\d · Max/.test(await text(k, '#bal')), `with no vault yet Max counts the TAC in the wallet: 900,000 TAC (${await text(k, '#bal')})`);
  await typed(k, '1000');
  const crow = await text(k, '#info'), cgo = await text(k, '#go');
  ok(/^Deposit [\d,.]+ TAC and borrow$/.test(cgo) && /Fee \(1%\)\s*10 TACD/.test(crow) && /You receive\s*1,000 TACD/.test(crow) && /You owe after\s*1,010 TACD/.test(crow) && /Ratio after\s*[3-9]\d\d%/.test(crow), `typing the amount shows the deposit it takes, the fee and the ratio (${cgo}; ${crow.slice(0, 150)})`);
  const cadd = money(crow.match(/TAC added to your vault\s*([\d,.]+) TAC/)[1]);
  K.sends.length = 0; const sg0 = K.signs;
  await k.click('#go');
  await untilText(k, '#status', /Deposited [\d,.]+ TAC and borrowed 1,000 TACD\. You owe 1,010/, 60000);
  const cv = vaultOf(USD, 'carol');
  ok(K.signs - sg0 === 1 && K.sends.length === 1 && K.sends[0].to.toLowerCase() === USD.toLowerCase() && K.sends[0].data.startsWith(cast('sig', 'multicall(bytes[])')), `one permit signature (no gas) and one transaction, the vault's multicall (${K.signs - sg0} signature, ${K.sends.length} sent)`);
  ok(cv.c === cadd && cv.d === 1010n * E18 && big(SYN.usd, 'balanceOf(address)(uint256)', ACC.carol.a) === 1000n * E18, `the vault holds the ${cv.c / E18} TAC deposited, 1,010 is owed and 1,000 arrived`);
  const safeBps = 2n * big(USD, 'LIQ_RATIO_BPS()(uint256)');                                               // the owner's change earlier put the liquidation ratio at 150%, so the safe line is 300%
  ok(big(USD, 'valueOf(uint256,bool)(uint256)', String(cv.c), 'false') * 10000n >= cv.d * safeBps, `and the vault is at the safe line (${safeBps / 100n}%) or more, out of the redemption zone`);
  // with an allowance in place there is no signature at all
  send('carol', TAC, 'approve(address,uint256)', USD, String(MAXU));
  await k.reload(); await until(k, () => /(Balance|Up to) [\d,]+/.test(document.querySelector('#bal')?.textContent || ''), null, 30000);        // the tab is kept in the address, so it reopens on Borrow
  await tab(k, 'borrow'); await typed(k, '2000');
  await untilText(k, '#go', /^Deposit [\d,.]+ TAC and borrow$/, 30000);
  K.sends.length = 0; const sg1 = K.signs;
  await k.click('#go');
  await untilText(k, '#status', /borrowed 2,000 TACD\. You owe 3,030/, 60000);
  ok(K.signs === sg1 && K.sends.length === 1 && vaultOf(USD, 'carol').d === 3030n * E18, 'with an allowance already given it is one transaction and no signature');
  // a wallet that never answers: after twenty seconds the page offers to stop waiting, and the ticket is usable again
  K.stall = true; K.sends.length = 0;
  await tab(k, 'deposit'); await typed(k, '5');
  await k.click('#go');
  await untilText(k, '#status', /Waiting for your wallet\. Open it to answer, or stop waiting/, 40000);
  ok(await k.$eval('#go', (b) => b.disabled), 'a wallet that has not answered: the page says so after a while, and nothing else can be sent meanwhile');
  await k.click('#status [data-stop]');
  await untilText(k, '#status', /Stopped waiting\./, 20000);
  ok(!(await k.$eval('#go', (b) => b.disabled)) && (await k.$$('#status .err')).length === 0 && K.sends.length === 0, 'stopping the wait is not an error: the button works again and nothing was sent');
  K.stall = false;
  ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  await closeAll(r);

  // ── an amount from another page's Borrow box: #amt= fills the Borrow box once, instead of Max, and leaves the address bar ──
  mintTac(ACC.deployer.a, 50_000n * E18);
  r = await openPage({ who: 'deployer', hash: `#vusd=${USD}&veth=${ETH}&t=deposit&amt=125` });
  const am = r.page;
  await connect(am);
  await untilText(am, '#go', /^(Borrow TACD|Deposit [\d,.]+ TAC and borrow)$/, 30000);
  await sleep(400);
  ok(await am.$eval('#acts [data-t="borrow"]', (b) => b.getAttribute('aria-pressed')) === 'true' && (await am.$eval('#amt', (e) => e.value)) === '125', `#amt=125 opens Borrow with 125 in the box, not the Max (button: ${await text(am, '#go')})`);
  ok(!/amt=/.test(await am.evaluate(() => location.hash)) && /vusd=/.test(await am.evaluate(() => location.hash)), 'and the amount leaves the address bar (the rest of it stays)');
  ok(/You receive\s*125 TACD/.test(await text(am, '#info')), `the rows are for 125 TACD (${(await text(am, '#info')).slice(0, 120)}${await text(am, '#hint')})`);
  await am.reload();
  await until(am, () => !!document.querySelector('#board table'));
  await sleep(800);
  ok((await am.$eval('#amt', (e) => e.value)) !== '125', 'a refresh does not fill it again');
  ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  await closeAll(r);
  r = await openPage({ hash: `#vusd=${USD}&veth=${ETH}&v=eth&amt=0.01` });
  await until(r.page, () => !!document.querySelector('#board table'));
  ok(await r.page.$eval('#pick [data-v="eth"]', (b) => b.getAttribute('aria-pressed')) === 'true' && (await r.page.$eval('#amt', (e) => e.value)) === '0.01', '#v=eth&amt=0.01 fills the TAC Ether vault’s Borrow box with 0.01');
  ok(/v=eth/.test(await r.page.evaluate(() => location.hash)) && !/amt=/.test(await r.page.evaluate(() => location.hash)), 'the vault stays in the address bar, the amount does not');
  await closeAll(r);
  r = await openPage({ hash: `#vusd=${USD}&veth=${ETH}&amt=1,5x` });
  await until(r.page, () => !!document.querySelector('#board table'));
  await sleep(300);
  ok((await r.page.$eval('#amt', (e) => e.value)) === '' && !/amt=/.test(await r.page.evaluate(() => location.hash)), 'an amount that does not read is ignored (and dropped)');
  await closeAll(r);
  // ── one press: a wallet with TAC and no vault, the page as first opened ──
  mintTac(ACC.deployer.a, 50_000n * E18);
  r = await openPage({ who: 'deployer', hash: `#vusd=${USD}&veth=${ETH}` });
  const o1 = r.page, D = r.walletLog;
  await connect(o1);
  await untilText(o1, '#go', /^Deposit [\d,.]+ TAC and borrow$/, 30000);
  ok(await o1.$eval('#acts [data-t="borrow"]', (b) => b.getAttribute('aria-pressed')) === 'true', 'the page opens on Borrow');
  const pre = await o1.$eval('#amt', (e) => e.value);
  ok(Number(pre) > 0 && !(await o1.$eval('#go', (b) => b.disabled)), `the box already holds the most this wallet can borrow (${pre}), and the button is ready`);
  await shot(o1, 'one-press');
  D.sends.length = 0; const sgD = D.signs;
  await o1.click('#go');
  await untilText(o1, '#status', /Deposited [\d,.]+ TAC and borrowed [\d,.]+ TACD/, 60000);
  const dv = vaultOf(USD, 'deployer');
  ok(D.signs - sgD === 1 && D.sends.length === 1 && dv.d > 0n && big(SYN.usd, 'balanceOf(address)(uint256)', ACC.deployer.a) === M_OUT(pre), 'one press: one permit signature and one transaction, and the TACD arrived');
  ok((await o1.$$('#status [data-watch]')).length === 1 && (await o1.$eval('#amt', (e) => e.value)) === '', 'the box is empty again and the TACD can be added to the wallet');
  await o1.click('#status [data-watch]');
  await until(o1, () => true); await sleep(200);
  ok(D.watched?.length === 1 && D.watched[0].options.symbol === 'TACD' && D.watched[0].options.address.toLowerCase() === SYN.usd.toLowerCase() && D.watched[0].options.decimals === 18, 'which asks the wallet to list it with its address and symbol');
  ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  await closeAll(r);

  // ── the price records carried with the action ──
  // A vault that prices only once its venues have been recorded (MockPair; its venues take a record on a header alone), and the page's own record flow against it: headers and
  // proofs built from the chain, the records and the person's call in one confirmation, from a wallet that can batch and from one that cannot (through the router).
  const kit = ['TacVaultRouter.sol/TacVaultRouter', 'TacVaultMocks.sol/MockPair', 'TacVaultMocks.sol/MockVenue'].every((f) => existsSync(join(OUT, `${f}.json`)));
  if (!kit) console.log('skipped: the record tests need the compiled TacVaultRouter and MockPair (forge build)');
  else {
    const PAIR = create(art('TacVaultMocks.sol/MockPair')), VENUES = [view(PAIR, 'A()(address)')[0], view(PAIR, 'B()(address)')[0]];
    send('deployer', PAIR, 'set(uint256)', String(P0));                                                  // the pair prices like the first oracle once it is armed and recorded
    const VC = makeVault(FEED, 'TAC Dollar', 'TACD', (100n * E18).toString(), PAIR);
    const VD = makeVault(FIXED, 'TAC Ether', 'TACE', (E18 / 25n).toString(), PAIR);                      // a second vault on the same oracle
    const SYNC = view(VC, 'SYNTH()(address)')[0];
    const RT = create(art('TacVaultRouter.sol/TacVaultRouter') + cast('abi-encode', 'f(address,address)', VC, ETH).slice(2));
    const head = async () => Number(BigInt(await rpcA('eth_blockNumber')));
    const h0 = await head(), at = (Math.floor(h0 / 50) + 45) * 50 + 20;                                   // enough blocks for forty intervals (each block of history costs the test node disk)
    await rpcA('anvil_mine', ['0x' + (at - h0).toString(16)]);
    const top0 = Math.floor((at - 1) / 50) - 1;                                                          // the newest interval; the three newest of each venue are left to record
    for (const v of VENUES) send('deployer', v, 'fill(uint256,uint256)', String(top0 - 40), String(top0 - 3));
    const pending = async () => { const top = Math.floor((await head() - 1) / 50) - 1; let n = 0; for (const v of VENUES) for (let k = top - 30; k <= top; k++) if (big(v, 'sampleOf(uint256)(uint256,uint256)', String(k)) === 0n) n++; return n; };
    const arm = async (depthOnly = false) => { const n = await pending(); send('deployer', PAIR, depthOnly ? 'armDepth(uint256)' : 'arm(uint256)', String(n)); return n; };       // depthOnly: the price still reads, as on the live oracle while most intervals are recorded
    const more = async () => { await rpcA('anvil_mine', ['0x96']); return arm(); };                    // three more intervals, three more records of each venue
    const hashC = (extra = '') => `#vusd=${VC}${extra}`;
    const ready = (p, re) => untilText(p, '#go', re, 90000);

    // 1. a wallet that batches: one confirmation, one permit signature, no other transaction; the router is not needed
    let n = await arm(true);
    ok(n === 6, `six records are missing (three of each venue): ${n}`);
    // 0. while the router is still being asked the board is checking, not closed; then it is open
    let release; const gate = new Promise((res) => { release = res; });
    r = await openPage({ hash: `#vusd=${VC}&veth=${VD}&router=${RT}`, hold: { re: new RegExp(RT.slice(2), 'i'), gate } });
    await until(r.page, () => /Mint|TACD|Room to borrow/.test(document.querySelector('#board')?.textContent || '') && !document.querySelector('#board').classList.contains('loading'));
    await sleep(1500);
    const waitBoard = await text(r.page, '#board');
    ok(/Checking whether borrowing is open/.test(waitBoard) && /Borrowing\s*Checking\s*Checking/.test(waitBoard) && !/Borrowing\s*Not open|not open yet\./.test(waitBoard) && !/Borrowing is not open/.test(waitBoard) && await r.page.$eval('#board .verdict', (e) => e.classList.contains('wait')), 'while the router is being asked, the board says it is checking, and never that borrowing is closed');
    release();
    await until(r.page, () => /Borrowing is open on/.test(document.querySelector('#board')?.textContent || ''));
    ok(/The last 6 prices are recorded with your transaction/.test(await text(r.page, '#board')), 'and once the router answers, it is open, with the six prices to go with the transaction');
    await closeAll(r);
    r = await openPage({ who: 'bob', batch: true, hash: `#vusd=${VC}&veth=${VD}&router=${RT}` });
    const bb = r.page, BL = r.walletLog;
    await connect(bb);
    await ready(bb, /^Deposit [\d,.]+ TAC and borrow$/);
    ok(/Price records\s*6 included/.test(await text(bb, '#info')) && Number(await bb.inputValue('#amt')) > 0, 'the ticket reads the vault as it will be once the records are in: the amount is filled, and it says six records are included');
    const board1 = await text(bb, '#board');
    ok(/Borrowing is open/.test(board1) && /The last 6 prices are recorded with your transaction/.test(board1) && /Room to borrow\s*[\d,.]+ TACD\s*[\d,.]+ TACE/.test(board1), 'and the board calls borrowing open, says the six prices go with the transaction, and shows the room of both vaults as it will be');
    ok(await bb.$eval('#feed', (e) => e.hidden), 'with no separate price panel offering a step of its own');
    await shot(bb, 'records-bundle');
    const sg = BL.signs; BL.sends.length = 0;
    await bb.click('#go');
    await untilText(bb, '#status', /Deposited [\d,.]+ TAC and borrowed [\d,.]+ TACD\. You owe [\d,.]+\. Recorded 6 prices with it/, 120000);
    const bv = vaultOf(VC, 'bob');
    ok(BL.bundles.length === 1 && BL.bundles[0].calls.length === 3 && BL.bundles[0].atomicRequired === true && BL.bundles[0].calls[1].to.toLowerCase() === TAC.toLowerCase() && BL.bundles[0].calls[1].data.startsWith('0x095ea7b3') && BL.sends.length === 0, 'one atomic batch of three calls (the records, the approval of the TAC, the vault) and no other transaction');
    ok(BL.signs - sg === 0, 'and no signature at all: the approval is a call in the batch, not a permit');
    ok(bv.d > 0n && bv.c > 0n && view(PAIR, 'broken()(bool)')[0] === 'false' && big(PAIR, 'got()(uint256)') === 6n && (await pending()) === 0, 'the vault holds the deposit and the debt, and every missing record was made');
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    await closeAll(r);

    // 2. a wallet that cannot batch, with the router: two signatures (the borrow, the permit) and one transaction, to the router
    n = await more();
    r = await openPage({ who: 'carol', hash: hashC(`&router=${RT}`) });
    const cc = r.page, CL = r.walletLog;
    await connect(cc);
    await ready(cc, /^Deposit [\d,.]+ TAC and borrow$/);
    ok(new RegExp(`Price records\\s*${n} included`).test(await text(cc, '#info')), `through the router too the ticket says the ${n} records are included`);
    const sgc = CL.signs; CL.sends.length = 0;
    await cc.click('#go');
    await untilText(cc, '#status', new RegExp(`Recorded ${n} prices with it`), 120000);
    const cv2 = vaultOf(VC, 'carol');
    ok(CL.sends.length === 1 && CL.sends[0].to.toLowerCase() === RT.toLowerCase() && CL.sends[0].data.startsWith(cast('sig', 'multicall(bytes[])')) && CL.bundles.length === 0, 'one transaction, to the router, its multicall');
    ok(CL.signs - sgc === 2, 'with two signatures: the borrow for the vault and the permit for the router');
    ok(cv2.d > 0n && cv2.c > 0n && big(SYNC, 'balanceOf(address)(uint256)', ACC.carol.a) >= cv2.d * 99n / 100n && big(TAC, 'balanceOf(address)(uint256)', RT) === 0n, 'the debt and the deposit are carol\'s, the TACD reached her, and the router holds nothing');
    ok(big(TAC, 'allowance(address,address)(uint256)', ACC.carol.a, RT) === 0n && (await pending()) === 0, 'the permit was used up and no record is left');
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);

    // 3. the same wallet taking TAC out with a debt, when the prices have lapsed again: one signature and one transaction (it first repays some, as it borrowed all it could)
    send('carol', SYNC, 'approve(address,uint256)', VC, MAXU.toString());
    send('carol', VC, 'repay(address,uint256)', ACC.carol.a, String(vaultOf(VC, 'carol').d - 5000n * E18));
    n = await more();
    await cc.reload();                                                                                   // the wallet is remembered across a reload: no connecting again
    await until(cc, () => !!document.querySelector('#board table') && /^0x/.test(document.querySelector('#wallet-label')?.textContent || ''), null, 60000);
    await tab(cc, 'withdraw');
    await typed(cc, '1');
    await untilText(cc, '#go', /^Withdraw TAC$/, 90000);
    ok(new RegExp(`Price records\\s*${n} included`).test(await text(cc, '#info')), 'the withdraw tab carries the records too');
    const colBefore = vaultOf(VC, 'carol').c, sgw = CL.signs; CL.sends.length = 0;
    await cc.click('#go');
    await untilText(cc, '#status', new RegExp(`Recorded ${n} prices with it`), 120000);
    ok(vaultOf(VC, 'carol').c === colBefore - E18 && CL.signs - sgw === 1 && CL.sends.length === 1 && CL.sends[0].to.toLowerCase() === RT.toLowerCase(), 'one TAC left the vault for carol with one signature and one transaction to the router');
    await closeAll(r);

    // 4. a wallet that cannot batch, and no router: the page does what it always did (the button records the prices first), and builds nothing in the background
    n = await more();
    r = await openPage({ who: 'user', hash: hashC() });
    const uu = r.page;
    await connect(uu);
    await untilText(uu, '#go', new RegExp(`^Record ${n} prices to open borrowing$`), 60000);
    await sleep(1500);
    ok((await text(uu, '#info')) === '' && !(await uu.$$('#status .err')).length, 'with neither a batching wallet nor a router there is no price-record row, and the button is the old one');
    await closeAll(r);

    // 5. more than one batch can carry (20 missing): the ticket's button records the older ones in its own transaction, then the last ones go with the borrow
    await rpcA('anvil_mine', ['0x15e']);                                                                 // seven more intervals of each venue
    n = await arm();
    ok(n > 12, `more records are missing than one batch carries: ${n}`);
    mintTac(ACC.owner.a, 50_000n * E18);
    r = await openPage({ who: 'owner', batch: true, hash: hashC(`&router=${RT}`) });
    const oo = r.page, OL = r.walletLog;
    await connect(oo);
    await untilText(oo, '#go', new RegExp(`^Record ${n} prices to open borrowing$`), 60000);
    await sleep(1500);
    ok((await text(oo, '#info')) === '' && new RegExp(`Borrowing is not open yet`).test(await text(oo, '#board')) && new RegExp(`waits for ${n} prices`).test(await text(oo, '#board')), 'with that many missing nothing is prepared in the background, and the board says borrowing waits for them');
    // 16 records to a confirmation (the per-transaction gas cap allows about 17); the ticket counts only the ones before the borrow, which carries the last 12
    const confsTicket = Math.ceil((n - 12) / 16), confsFeed = Math.ceil(n / 16);
    const hint = await text(oo, '#hint'), feedTxt = await text(oo, '#feed');
    ok(new RegExp(`Takes ${confsTicket} wallet confirmations?`).test(hint) && /The last 12 then go with your borrow/.test(hint) && new RegExp(`Takes ${confsFeed} wallet confirmations?`).test(feedTxt) && (await oo.$$('#feed .mt b')).length === 2,
      `the button says how many confirmations come before the borrow (${confsTicket}) and that the last 12 go with it, the price feed how many all ${n} take (${confsFeed}), and each venue has its meter (${hint})`);
    OL.sends.length = 0;
    await oo.click('#go');
    await untilText(oo, '#go', /^Deposit [\d,.]+ TAC and borrow$/, 240000);
    const left = await pending(), shown = Number(/Price records\s*(\d+) included/.exec(await text(oo, '#info'))?.[1]);
    ok(OL.sends.length === 1 && shown === left && left > 0 && left <= 12, `the button recorded the older ones in one transaction and left ${left} for the borrow`);
    ok(new RegExp(`The older prices are recorded\\. The last ${left} go with your borrow`).test(await text(oo, '#status')) && (await oo.evaluate(() => document.activeElement?.id)) === 'amt', `the ticket said what it did and handed back to the amount (${(await text(oo, '#status')).slice(0, 120)})`);
    await oo.click('#go');
    await untilText(oo, '#status', new RegExp(`Recorded ${left} prices with it`), 120000);
    ok(OL.bundles.length === 1 && vaultOf(VC, 'owner').d > 0n && (await pending()) === 0, 'which went through in one batch: the vault holds a debt and nothing is missing');
    await closeAll(r);

    // 6. an auction on the account's vault while the prices have lapsed: the callout offers to record them and end the auction in one transaction (any wallet, through Multicall3)
    const auction = (who, div) => { send('deployer', PAIR, 'set(uint256)', String(P0 / div)); send('deployer', VC, 'liquidate(address)', ACC[who].a); send('deployer', PAIR, 'set(uint256)', String(P0)); };
    auction('bob', 4n);
    ok(vaultOf(VC, 'bob').a > 0n, 'an auction is open on bob\'s vault');
    n = await more();
    r = await openPage({ who: 'bob', hash: hashC() });
    const ba = r.page, AL = r.walletLog;
    await connect(ba);
    await untilText(ba, '#pos', new RegExp(`Record ${n} prices and end the auction`), 120000);
    AL.sends.length = 0;
    await ba.click('#pos [data-cancel]');
    await untilText(ba, '#status', new RegExp(`The auction has ended\\. Recorded ${n} prices with it`), 120000);
    ok(vaultOf(VC, 'bob').a === 0n && AL.sends.length === 1 && AL.sends[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' && (await pending()) === 0, 'one Multicall3 transaction recorded the prices and ended the auction');
    await closeAll(r);

    // 7. adding TAC to a vault in an auction whose prices have lapsed: with a wallet that batches, the records go with the deposit and the auction ends in it
    auction('bob', 4n);
    mintTac(ACC.bob.a, 1_000n * E18);                                                                    // bob put all of his TAC in the vault earlier
    n = await more();
    r = await openPage({ who: 'bob', batch: true, hash: hashC('&t=deposit') });
    const bd = r.page, DL = r.walletLog;
    await connect(bd);
    await typed(bd, '100');
    await untilText(bd, '#go', /^Deposit TAC$/, 120000);
    await until(bd, () => /Price records\s*\d+ included/.test(document.querySelector('#info')?.textContent || ''), null, 120000);
    await bd.click('#go');
    await untilText(bd, '#status', /Deposited 100 TAC\. Recorded \d+ prices with it/, 120000);
    ok(vaultOf(VC, 'bob').a === 0n && DL.bundles.length === 1 && (await pending()) === 0, 'the deposit and the records went in one batch, and the auction is over');
    await closeAll(r);

    // 8. repaying part of the debt of a vault in an auction, from a wallet that cannot batch: through the router, the records, the permit for the TACD and the repayment in one transaction
    auction('carol', 100n);
    n = await more();
    r = await openPage({ who: 'carol', hash: hashC(`&t=repay&router=${RT}`) });
    const cr = r.page, RL = r.walletLog;
    await connect(cr);
    await typed(cr, '1000');
    await until(cr, () => /Price records\s*\d+ included/.test(document.querySelector('#info')?.textContent || ''), null, 120000);
    RL.sends.length = 0;
    const debt0 = vaultOf(VC, 'carol').d;
    await cr.click('#go');
    await untilText(cr, '#status', /Repaid\. You owe [\d,.]+ TACD\. Recorded \d+ prices with it/, 120000);
    ok(RL.sends.length === 1 && RL.sends[0].to.toLowerCase() === RT.toLowerCase() && vaultOf(VC, 'carol').d === debt0 - 1000n * E18 && vaultOf(VC, 'carol').a === 0n && (await pending()) <= 2, 'one transaction to the router repaid 1,000 and, with the records before it, ended the auction (at most the newest interval, which began meanwhile, is left)');
    ok(big(SYNC, 'balanceOf(address)(uint256)', RT) === 0n && big(SYNC, 'allowance(address,address)(uint256)', RT, VC) === 0n, 'and the router holds no TACD and leaves no approval');
    await closeAll(r);

    // 9. a wallet that batches and nothing to record: the approval is still a call in the batch (no permit to sign), so there is no signature at all
    mintTac(ACC.deployer.a, 20_000n * E18);
    for (let i = 0; i < 3 && (await pending()) > 0; i++) { const top = Math.floor((await head() - 1) / 50) - 1; for (const v of VENUES) send('deployer', v, 'fill(uint256,uint256)', String(top - 6), String(top)); }
    ok((await pending()) === 0 && view(PAIR, 'broken()(bool)')[0] === 'false', 'the oracle is current and prices');
    r = await openPage({ who: 'deployer', batch: true, hash: hashC() });
    const dp = r.page, DP = r.walletLog;
    await connect(dp);
    await untilText(dp, '#go', /^Deposit [\d,.]+ TAC and borrow$/, 90000);
    ok(!/Price records/.test(await text(dp, '#info')), 'nothing to record: the ticket does not mention records');
    DP.sends.length = 0; const sgd = DP.signs;
    await dp.click('#go');
    await untilText(dp, '#status', /Deposited [\d,.]+ TAC and borrowed [\d,.]+ TACD/, 120000);
    const q = DP.bundles.at(-1);
    ok(DP.bundles.length === 1 && q.calls.length === 2 && q.calls[0].to.toLowerCase() === TAC.toLowerCase() && q.calls[0].data.startsWith('0x095ea7b3') && DP.signs === sgd && DP.sends.length === 0, 'one atomic batch of the approval and the vault call: no signature and no other transaction');
    ok(big(TAC, 'allowance(address,address)(uint256)', ACC.deployer.a, VC) === 0n, 'and the approval was used up exactly');
    await closeAll(r);
  }

  // ── the pools: where the tokens sell ──
  {
    // A six-decimal USDC; TACD, TACE and USDC for the accounts.
    const USDC = create(art('TacVaultMocks.sol/TestUsdc'));
    const mintSyn = async (key, to, amt) => {
      const vault = key === 'usd' ? USD : ETH;
      await rpcA('anvil_setBalance', [vault, '0xde0b6b3a7640000']); await rpcA('anvil_impersonateAccount', [vault]);
      cast('send', SYN[key], 'mint(address,uint256)', to, String(amt), '--from', vault, '--unlocked', '--rpc-url', ANVIL, '--json');
      await rpcA('anvil_stopImpersonatingAccount', [vault]);
    };
    for (const w of ['user', 'bob']) {
      await mintSyn('usd', ACC[w].a, 50_000n * E18); await mintSyn('eth', ACC[w].a, 50n * E18);
      send('deployer', USDC, 'mint(address,uint256)', ACC[w].a, String(50_000n * 10n ** 6n));
    }
    const hashP = (extra = '') => `#vusd=${USD}&veth=${ETH}&usdc=${USDC}${extra}`;
    const panel = (p) => text(p, '#pools');
    const sends = (L) => L.sends.map((t) => ({ to: t.to.toLowerCase(), data: t.data, value: t.value ? BigInt(t.value) : 0n }));
    const poolsOf = (token) => cast('call', PF, 'poolsForTokenSlice(address,uint256,uint256)(address[])', token, '0', '20', '--rpc-url', ANVIL).match(/0x[0-9a-fA-F]{40}/g) || [];
    const isqrt = (n) => { if (n < 2n) return n; let x = 1n << BigInt((n.toString(2).length + 1) >> 1); for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; } };
    const near = (a, b, rel = 1e-6) => Math.abs(Number(a - b)) <= rel * Math.abs(Number(b));

    // The address the factory gives a pool of this token against the test USDC, for a band and a fee (what deployments.js names, which the points service is told).
    const bandPool = (ln, ld, hn, hd, fee) => {
      const sIs1 = BigInt(SYN.usd) > BigInt(USDC), rw = (pn, pd) => (sIs1 ? [pn * E18, pd * 10n ** 6n] : [pd * 10n ** 6n, pn * E18]);
      const [lo, hi] = sIs1 ? [rw(ln, ld), rw(hn, hd)] : [rw(hn, hd), rw(ln, ld)], sq = ([n, d]) => isqrt(n * 10n ** 36n / d);
      return cast('call', PF, 'poolFor((address,address,uint256,uint256,uint256,address,address,uint256))(address)', `(${sIs1 ? USDC : SYN.usd},${sIs1 ? SYN.usd : USDC},${sq(lo)},${sq(hi)},${fee},0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,0)`, '--rpc-url', ANVIL).toLowerCase();
    };
    const pegPool = bandPool(9n, 10n, 10n, 9n, 500), stopPool = bandPool(1n, 2n, 2n, 1n, 3000);

    // 0. the campaign is on and nothing is open yet: it is said under the title, on the board and in the pool's card
    {
      const camp0 = {
        enabled: true, endSec: 9_999_999_999, pocket: { totalWei: String(1500n * E18), creditedWei: '0', remainingWei: String(1500n * E18) },
        terms: { fromDay: 1, dailyWei: String(25n * E18), createWei: String(150n * E18), capWeiPerUsdDay: String(E18 / 20n) }, next: null, minUsdWei: String(20n * E18), minSamples: 12,
        pools: [{ pool: pegPool, weightBps: '10000', opened: false, opener: null, openPaid: false }, { pool: stopPool, weightBps: '5000', opened: false, opener: null, openPaid: false }],
        today: { day: 1, samples: 0, hour: 0 },
      };
      r = await openPage({ hash: hashP(), lp: camp0 });
      await until(r.page, () => ['#promo', '#pl-reward'].every((q) => { const e = document.querySelector(q); return !!e && getComputedStyle(e).display !== 'none'; }));
      const pr = await text(r.page, '#promo');
      ok(/^Earn 150 TAC for opening a TACD or TACE market, and 25 TAC a day for supplying one\. See the markets ↓$/.test(pr), `one line under the title says what it pays (${pr})`);
      await untilText(r.page, '#board', /Trades at\s*Not open yet\s*opening earns 150 TAC/);
      ok(true, 'the board says on the unopened token that opening it earns 150 TAC');
      const rw = (await r.page.$eval('#pl-reward', (e) => e.innerText)).replace(/\s+/g, ' ').trim();           // what is shown, not what is merely in the markup
      ok(/^EARN TAC HERE Opening bonus 150 TAC to the first in with \$20 for a day Daily rewards 25 TAC a day to those who hold it all day · up to 0\.05 per \$1$/i.test(rw), `the card has one block for it, short enough to read (${rw})`);
      const y0 = await r.page.evaluate(() => scrollY);
      await r.page.click('[data-to-pools]'); await sleep(900);
      ok((await r.page.evaluate(() => scrollY)) > y0, 'and the line takes you to the markets');
      ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
      await shot(r.page, 'pools-advert');
      await closeAll(r);
      // a link ending in &pools opens on the markets of the vault it names, and the address then drops it
      r = await openPage({ hash: hashP('&v=eth&pools'), lp: camp0 });
      await until(r.page, () => { const e = document.querySelector('#pools'); return !!e && !e.hidden && /Where TACE sells/.test(e.textContent) && scrollY > 0 && e.getBoundingClientRect().top < innerHeight; });
      ok(/v=eth/.test(await r.page.evaluate(() => location.hash)) && !/(^|[#&])pools(&|$)/.test(await r.page.evaluate(() => location.hash)), '#…&v=eth&pools opens on the TACE markets, and the address keeps the vault and drops the flag');
      ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
      await closeAll(r);
    }

    // 1. nothing is open: the templates are listed, with where each opens and its range, and anyone may create one
    r = await openPage({ hash: hashP() });
    await until(r.page, () => (document.querySelectorAll('#pl-pick button').length === 2));
    const lab = await r.page.$$eval('#pl-pick button', (bs) => bs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
    ok(lab.join('|') === 'TACD / USDCPeg · 0.05%|TACD / USDCBackstop · 0.3%', `the dollar token lists two markets and no more, each with an icon pair (${lab.join(' | ')})`);
    ok((await r.page.$$eval('#pl-pick button .pair .tk', (n) => n.length)) === 4 && /Peg · 0\.05% fee/.test(await panel(r.page)) && /Opens at\s*1 TACD = 1 USDC/.test(await panel(r.page)) && /Range\s*0\.9 – 1\.111 USDC/.test(await panel(r.page)), 'the first is open to read: the peg band, 0.05%, opening at 1 TACD = 1 USDC');
    await r.page.click('#pl-pick button:nth-child(2)'); await sleep(100);
    ok(/Backstop · 0\.3% fee/.test(await panel(r.page)) && /Range\s*0\.5 – 2 USDC/.test(await panel(r.page)), 'the backstop is wider: 0.5 to 2 USDC at 0.3%');
    await untilText(r.page, '#board', /Trades at\s*Not open yet\s*Not open yet/);
    ok((await text(r.page, '#pl-go')) === 'Connect wallet', 'with no wallet the button asks for one');
    ok(await r.page.$$eval('#pl-kb, #pl-ke, #pl-km, #pl-reward, #promo', (els) => els.length === 5 && els.every((e) => getComputedStyle(e).display === 'none')), 'with the campaign off the page advertises nothing for it (the rows, their block and the line under the title are not shown, not merely marked hidden)');
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    await shot(r.page, 'pools-list');
    await closeAll(r);

    // 2. one click creates the pool: no tokens, no approvals, one transaction. Then it is seeded.
    r = await openPage({ who: 'user', hash: hashP() });
    const up = r.page, UL = r.walletLog;
    await connect(up);
    await until(up, () => /^Create pool$/.test(document.querySelector('#pl-go')?.textContent || ''));
    await up.click('#pl-go');
    await untilText(up, '#pl-status', /pool is created\./, 120000);
    const S1 = sends(UL), pool1 = poolsOf(SYN.usd)[0];
    ok(S1.length === 1 && S1[0].to === PF.toLowerCase() && S1[0].data.startsWith('0xb18a0dcf') && S1[0].value === 0n, 'creating is one transaction to the factory (createPool) and nothing else');
    ok(view(PF, 'isPool(address)(bool)', pool1)[0] === 'true' && big(pool1, 'totalSupply()(uint256)') === 0n && big(pool1, 'fee()(uint256)') === 500n && view(pool1, 'feeRecipient()(address)')[0] === '0x0000000000000000000000000000000000000000', 'the pool exists, holds nothing, charges 500 pips and is not named to anyone');
    const t0 = view(pool1, 'token0()(address)')[0].toLowerCase(), t1 = view(pool1, 'token1()(address)')[0].toLowerCase();
    const sIs1 = t1 === SYN.usd.toLowerCase(), sl = big(pool1, 'sqrtPLow()(uint256)'), sh = big(pool1, 'sqrtPHigh()(uint256)'), prod = sl * sh, want = sIs1 ? 10n ** 48n : 10n ** 24n;
    ok(BigInt(t0) < BigInt(t1) && [t0, t1].sort().join() === [SYN.usd.toLowerCase(), USDC.toLowerCase()].sort().join() && near(prod, want, 1e-9), 'it holds TACD and USDC in the factory’s order, with the band 0.9 to 1.111 (in raw units, with the six-decimal USDC)');
    await until(up, () => /Add the first liquidity/.test(document.querySelector('#pl-go')?.textContent || ''));
    ok(/Created\. Add liquidity to open it/.test(await text(up, '#pl-hint')) && await up.$eval('#pl-go', (b) => b.disabled), 'the page now says it is created and asks for the first liquidity');
    UL.sends.length = 0;
    await up.fill('#pl-s', '1000'); await sleep(100);
    const q1 = Number(await up.inputValue('#pl-q'));
    ok(q1 > 999.9 && q1 < 1000.1 && /2 approvals first/.test(await text(up, '#pl-hint')), `typing 1,000 TACD fills about 1,000 USDC at the opening price (${q1}), and says two approvals come first`);
    await shot(up, 'pools-form');
    await up.click('#pl-go');
    await untilText(up, '#pl-status', /market is open\./, 120000);
    const S2 = sends(UL);
    ok(S2.length === 3 && S2[0].data.startsWith('0x095ea7b3') && S2[1].data.startsWith('0x095ea7b3') && S2[2].data.startsWith('0x7163352a'), 'two approvals, then the first liquidity (createAndSeed, which seeds a pool created empty)');
    const rS = sIs1 ? big(pool1, 'reserve1()(uint256)') : big(pool1, 'reserve0()(uint256)'), rQ = sIs1 ? big(pool1, 'reserve0()(uint256)') : big(pool1, 'reserve1()(uint256)');
    ok(rS <= 1000n * E18 && rS >= 1000n * E18 - 10n ** 12n && rQ >= 999_999_000n && rQ <= 1_000_001_000n && big(pool1, 'balanceOf(address)(uint256)', ACC.user.a) > 0n, `the pool holds the 1,000 TACD and about 1,000 USDC (${rS}, ${rQ}), and the account holds the shares`);
    await until(up, () => /In the pool/.test(document.querySelector('#pools')?.textContent || ''));
    const pt = await panel(up);
    ok(/Price\s*1 TACD = 1 USDC/.test(pt) && /In the pool\s*1,000 USDC · 1,000 TACD/.test(pt) && /Yours\s*100%/.test(pt), `the panel shows the price, the depth and the share (${pt.slice(0, 200)})`);
    await untilText(up, '#board', /Trades at\s*1 USDC\s*1,000 USDC in the pool/);
    ok(true, 'and the board row shows the depth');
    await shot(up, 'pools-open');
    ok(UL.sends.length === 3 && r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    await closeAll(r);

    // 3. anyone adds to it, in the pool's proportions, and takes some out
    r = await openPage({ who: 'bob', hash: hashP() });
    const bp = r.page, BL = r.walletLog;
    await connect(bp);
    await until(bp, () => /Price/.test(document.querySelector('#pools')?.textContent || '') && !!document.querySelector('#pl-go'));
    ok(!/Opens at/.test(await panel(bp)), 'a market that is open shows no opening price');
    ok(!(await bp.$eval('#pl-add', (d) => d.open)) && await bp.isVisible('#pl-add summary'), 'an open market folds its add-liquidity form under one line for someone with none in it');
    await bp.click('#pl-add summary');
    await bp.click('#pl-bq'); await sleep(150);
    const maxQ = Number(await bp.inputValue('#pl-q')), maxS = Number(await bp.inputValue('#pl-s'));
    ok(maxQ > 0 && maxS > 0 && maxQ <= 50000 && maxS <= 50000 && Math.abs(maxQ - maxS) / maxQ < 0.01, `Max fills both boxes in proportion (${maxS} TACD, ${maxQ} USDC)`);
    await bp.fill('#pl-q', '100'); await sleep(100);
    const s100 = Number(await bp.inputValue('#pl-s'));
    ok(s100 > 99.9 && s100 < 100.1, `100 USDC asks for about 100 TACD (${s100})`);
    await shot(bp, 'pools-add');
    const lp0 = big(pool1, 'totalSupply()(uint256)'), px0 = big(pool1, 'sqrtPriceCurrent()(uint256)');
    await bp.click('#pl-go');
    await untilText(bp, '#pl-status', /Added\./, 120000);
    const S3 = sends(BL);
    ok(S3.length === 3 && S3[2].to === PF.toLowerCase() && S3[2].data.startsWith('0xbdc5ef29'), 'two approvals, then seed on the open market');
    const lp1 = big(pool1, 'totalSupply()(uint256)'), px1 = big(pool1, 'sqrtPriceCurrent()(uint256)'), mine = big(pool1, 'balanceOf(address)(uint256)', ACC.bob.a);
    ok(lp1 > lp0 && mine > 0n && lp1 - lp0 === mine && (px1 > px0 ? px1 - px0 : px0 - px1) * 10_000_000n < px0, 'it minted shares to the account in proportion, without moving the price');
    await until(bp, () => /Yours/.test(document.querySelector('#pools')?.textContent || ''));
    BL.sends.length = 0;
    await bp.click('#pl-rm [data-rm="50"]');
    await untilText(bp, '#pl-status', /Taken out\./, 120000);
    const S4 = sends(BL), mine2 = big(pool1, 'balanceOf(address)(uint256)', ACC.bob.a);
    ok(S4.length === 1 && S4[0].to === pool1.toLowerCase() && S4[0].data.startsWith('0xe39b0eb5') && mine2 === mine - mine / 2n, `taking half out is one transaction to the pool, and burns half the shares (${mine} → ${mine2})`);
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    await closeAll(r);

    // 4. TACE against ETH, created and seeded in one click: the ETH goes with the transaction, so only TACE needs approving
    r = await openPage({ who: 'user', hash: hashP('&v=eth') });
    const ep = r.page, EL = r.walletLog;
    await connect(ep);
    await until(ep, () => !!document.querySelector('#pl-go') && /Where TACE sells/.test(document.querySelector('#pools')?.textContent || ''));
    ok(/Opens at\s*1 TACE = 1 ETH/.test(await panel(ep)) && /Range\s*0\.9 – 1\.111 ETH/.test(await panel(ep)), 'the ether token’s first market opens at 1 TACE = 1 ETH, between 0.9 and 1.111');
    await ep.fill('#pl-q', '2'); await sleep(100);
    const sE = Number(await ep.inputValue('#pl-s'));
    ok(sE > 1.99 && sE < 2.01 && (await text(ep, '#pl-go')) === 'Create and add liquidity' && /1 approval first, then the pool and the deposit/.test(await text(ep, '#pl-hint')), `2 ETH asks for about 2 TACE (${sE}); one approval, then the pool and the deposit in one transaction`);
    await ep.click('#pl-go');
    await untilText(ep, '#pl-status', /market is open\./, 120000);
    const S5 = sends(EL), pool2 = poolsOf(SYN.eth)[0];
    ok(S5.length === 2 && S5[0].data.startsWith('0x095ea7b3') && S5[0].to === SYN.eth.toLowerCase() && S5[1].to === PF.toLowerCase() && S5[1].data.startsWith('0x7163352a') && S5[1].value >= 2n * E18 - 10n ** 9n && S5[1].value <= 2n * E18 + 10n ** 9n, 'one approval for TACE, then createAndSeed carrying about 2 ETH');
    ok(view(pool2, 'token0()(address)')[0] === '0x0000000000000000000000000000000000000000' && big(pool2, 'reserve0()(uint256)') >= 2n * E18 - 10n ** 9n && big(pool2, 'reserve1()(uint256)') >= 2n * E18 - 10n ** 9n, 'ETH is the pool’s first token, and it holds about 2 ETH and 2 TACE');
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    await closeAll(r);

    // 5. the other token order: a USDC whose address is above the token's puts the token first in the pool, and every figure turns over
    {
      const LOW = '0xfFfFffFFffFFFFFfFfFFFFFFfFFfFfFfFFFF1234', code = (await rpcA('eth_getCode', [USDC, 'latest']));
      await rpcA('anvil_setCode', [LOW, code]);
      send('deployer', LOW, 'mint(address,uint256)', ACC.user.a, String(50_000n * 10n ** 6n));
      r = await openPage({ who: 'user', hash: `#vusd=${USD}&veth=${ETH}&usdc=${LOW}` });
      const lp = r.page, LL = r.walletLog;
      await connect(lp);
      await until(lp, () => /Opens at/.test(document.querySelector('#pools')?.textContent || '') && !!document.querySelector('#pl-go'));
      const lt = await panel(lp);
      ok(/Opens at\s*1 TACD = 1 USDC/.test(lt) && /Range\s*0\.9 – 1\.111 USDC/.test(lt), `with the token first in the pool the page reads the same market: opens at 1 TACD = 1 USDC, 0.9 to 1.111 (${lt.slice(0, 150)})`);
      await lp.fill('#pl-q', '300'); await sleep(100);
      const sL = Number(await lp.inputValue('#pl-s'));
      ok(sL > 299.9 && sL < 300.1, `300 USDC asks for about 300 TACD (${sL})`);
      await lp.click('#pl-go');
      await untilText(lp, '#pl-status', /market is open\./, 120000);
      const poolL = poolsOf(SYN.usd).find((p) => view(p, 'token1()(address)')[0].toLowerCase() === LOW.toLowerCase());
      ok(!!poolL && view(poolL, 'token0()(address)')[0].toLowerCase() === SYN.usd.toLowerCase(), 'the pool has TACD first and the high USDC second');
      const lS = big(poolL, 'reserve0()(uint256)'), lQ = big(poolL, 'reserve1()(uint256)');
      ok(lQ >= 299_999_000n && lQ <= 300_001_000n && near(lS, 300n * E18, 1e-5), `it holds about 300 TACD and 300 USDC (${lS}, ${lQ})`);
      await until(lp, () => /In the pool/.test(document.querySelector('#pools')?.textContent || ''));
      const lt2 = await panel(lp);
      ok(/Price\s*1 TACD = 1 USDC/.test(lt2) && /In the pool\s*300 USDC · 300 TACD/.test(lt2), `and shows it the same way (${lt2.slice(0, 200)})`);
      ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
      await closeAll(r);
    }

    // 6. a pool someone else opened for the token is found and listed
    {
      const ssl = (n, d) => isqrt(n * 10n ** 36n / d), synthIs1 = BigInt(SYN.usd) > BigInt(USDC);
      const raw = (pn, pd) => (synthIs1 ? [pn * E18, pd * 10n ** 6n] : [pd * 10n ** 6n, pn * E18]);
      const [lo, hi] = synthIs1 ? [raw(99n, 100n), raw(100n, 99n)] : [raw(100n, 99n), raw(99n, 100n)];
      const tuple = `(${synthIs1 ? USDC : SYN.usd},${synthIs1 ? SYN.usd : USDC},${ssl(...lo)},${ssl(...hi)},100,0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,0)`;
      cast('send', PF, 'createPool((address,address,uint256,uint256,uint256,address,address,uint256))', tuple, '--private-key', ACC.deployer.k, '--rpc-url', ANVIL, '--gas-limit', '30000000', '--json');
      r = await openPage({ hash: hashP() });
      await until(r.page, () => document.querySelectorAll('#pl-pick button').length === 3);
      const lab2 = await r.page.$$eval('#pl-pick button', (bs) => bs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
      ok(lab2.length === 3 && lab2[2] === 'TACD / USDC0.01%', `a pool someone else opened (±1%, 0.01%) is listed after the templates (${lab2.join(' | ')})`);
      await closeAll(r);
      // 7. the liquidity campaign, as the points service says it: the rows it adds to a pool's card
      const synthIs1c = BigInt(SYN.usd) > BigInt(USDC);
      const bandTuple = (ln, ld, hn, hd, fee) => {
        const rw = (pn, pd) => (synthIs1c ? [pn * E18, pd * 10n ** 6n] : [pd * 10n ** 6n, pn * E18]);
        const [lo2, hi2] = synthIs1c ? [rw(ln, ld), rw(hn, hd)] : [rw(hn, hd), rw(ln, ld)];
        return `(${synthIs1c ? USDC : SYN.usd},${synthIs1c ? SYN.usd : USDC},${ssl(...lo2)},${ssl(...hi2)},${fee},0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,0)`;
      };
      const backstop = cast('call', PF, 'poolFor((address,address,uint256,uint256,uint256,address,address,uint256))(address)', bandTuple(1n, 2n, 2n, 1n, 3000), '--rpc-url', ANVIL).toLowerCase();
      const camp = {
        enabled: true, endSec: 9_999_999_999, pocket: { totalWei: String(1500n * E18), creditedWei: '0', remainingWei: String(1500n * E18) },
        terms: { fromDay: 1, dailyWei: String(25n * E18), createWei: String(150n * E18), capWeiPerUsdDay: String(E18 / 20n) }, next: null, minUsdWei: String(20n * E18), minSamples: 12,
        pools: [
          { pool: pool1.toLowerCase(), weightBps: '10000', opened: true, opener: ACC.user.a.toLowerCase(), openPaid: true },
          { pool: backstop, weightBps: '5000', opened: false, opener: null, openPaid: false },
        ],
        today: { day: 1, samples: 5, hour: 5 }, mine: { address: ACC.user.a.toLowerCase(), creditedWei: String(12n * E18), opened: [pool1.toLowerCase()] },
      };
      r = await openPage({ who: 'user', hash: hashP(), lp: camp });
      await connect(r.page);
      await until(r.page, () => !document.querySelector('#pl-ke')?.hidden);
      ok(await r.page.$$eval('#pl-kb, #pl-ke, #pl-km', (els) => els.every((e) => getComputedStyle(e).display !== 'none')), 'with the campaign on the three rows are shown');
      const cp = await panel(r.page);
      ok(/Earn TAC here/.test(cp) && /Opening bonus\s*Paid/.test(cp) && /Daily rewards\s*25 TAC a day\s*to those who hold it all day · up to 0\.05 per \$1/.test(cp) && /Earned so far\s*12 TAC/.test(cp), `an opened pool shows its bonus paid, what holding earns and what the account has earned (${cp.slice(0, 330)})`);
      await r.page.click('#pl-pick button:nth-child(2)'); await sleep(150);
      const cb = await panel(r.page);
      ok(/Opening bonus\s*150 TAC\s*to the first in with \$20 for a day/.test(cb) && /counts ×0\.5/.test(cb), `a pool nobody has opened shows the bonus for the first, and that the backstop counts at half (${cb.slice(0, 330)})`);
      ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
      await shot(r.page, 'pools-campaign');
      await closeAll(r);

    }
  }

  // ── the order the page is read in: a phone puts the ticket before the figures, a wide screen keeps it beside them ──
  for (const [width, phone] of [[390, true], [1280, false]]) {
    const x = await openPage({ viewport: { width, height: 900 }, who: 'user' });
    await connect(x.page); await until(x.page, () => /Borrowing is open/.test(document.querySelector('#board')?.textContent || ''));
    const at = await x.page.evaluate(() => Object.fromEntries(['#pos', '#ticket', '#board'].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [q, { top: r.top + scrollY, left: r.left, right: r.right }]; })));
    ok(phone ? at['#ticket'].top < at['#board'].top && at['#pos'].top < at['#ticket'].top : at['#ticket'].left >= at['#board'].right, phone ? 'on a phone the vault and the ticket come before the board' : 'on a wide screen the ticket sits beside the board');
    await closeAll(x);
  }

  // ── screenshots, phone and dark, one per zone ──
  if (SHOTS) {
    for (const [name, price] of [['safe', P0 * 55n / 100n], ['redemption', P0 * 36n / 100n], ['liquidation', P0 * 21n / 100n]]) {
      setPrice(price); mintTac(ACC.user.a, 0n);
      for (const [vp, scheme] of [[{ width: 390, height: 844 }, 'light'], [{ width: 390, height: 844 }, 'dark'], [{ width: 1280, height: 900 }, 'dark']]) {
        const x = await openPage({ viewport: vp, who: 'user', scheme });
        await connect(x.page); await until(x.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''), null, 30000);
        await sleep(300); await shot(x.page, `${name}-${vp.width}-${scheme}`);
        await x.page.locator('#pos').screenshot({ path: join(SHOTS, `${name}-${vp.width}-${scheme}-pos.png`) });
        await closeAll(x);
      }
    }
  }
} catch (e) { fails++; console.log('FAIL   ' + String(e.message || e).split('\n').slice(0, 4).join('\n') + '\n' + String(e.stack || '').split('\n').filter((l) => /vault-page/.test(l)).slice(0, 2).join('\n')); }
if (process.env.HOLD) { console.log(JSON.stringify({ ANVIL, WEB, TAC, ORACLE, USD, ETH, FEED, FIXED })); await sleep(Number(process.env.HOLD) * 1000); }
console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
finish(fails ? 1 : 0);
