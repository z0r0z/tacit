#!/usr/bin/env node
// The shop page paying with ETH (dapp/shop/app.js with contracts/src/ShopZap.sol) in a real browser, against an anvil fork of mainnet with the live pool, zRouter, TAC, vanity market and
// shop. With no zap named in the page there is no ETH offer; with the zap named in shelf.js (deployed on mainnet, so on the fork too) a wallet that holds ETH and no TAC buys an address in
// ONE transaction (the swap into TAC through the live pool, and the purchase), keeps nothing of the swap but the TAC dust over the price, and is not offered the way when its ETH would not cover it.
// The repo's source is also deployed on the fork the way the live one was (an address bought from the shop, the market's deploy, a wei at its deploy address first), and the live one is
// checked to hold exactly that code. While shelf.js names no zap, the page is run against that deployment instead.
//
//   FORK=https://ethereum-rpc.publicnode.com PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/shop-zap-page.mjs      (Node 22; needs anvil, cast and forge)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { marketAddress } from '../worker/src/salt-pool.js';
import { encodeList } from '../tools/vanity-shop-list.mjs';
import { foldShelf, TOPICS, FROM_BLOCK, deployData, ZAP as SHIPPED } from '../dapp/shop/shelf.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const REPO = new URL('..', import.meta.url).pathname, DAPP = join(REPO, 'dapp/');
const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com';
const PORT = 25000 + Math.floor(Math.random() * 900), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit', '--retries', '40', '--fork-retry-backoff', '1500', '--timeout', '60000'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcA = async (method, params = []) => {
  for (let attempt = 0; ; attempt++) {
    const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    // the public node answers "archive" now and then to a range it serves a moment later (one of its backends keeps no old logs); asked again, it answers
    if (j.error && attempt < 8 && /Archive requests require a personal token/.test(JSON.stringify(j.error))) { await sleep(1500); continue; }
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpc: j.error });
    return j.result;
  }
};
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

const SHOP = '0x00000000000785882df83d4cC6ED45c21eB1176C', MARKET = '0x000000000000b361194cfe6312EE3210d53C15AA', TACADDR = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', E18 = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), aw = (a) => a.slice(2).toLowerCase().padStart(64, '0'), hex = (n) => '0x' + n.toString(16);
const read = async (to, data) => BigInt(await rpcA('eth_call', [{ to, data }, 'latest']));
const tacBal = (a) => read(TACADDR, '0x70a08231' + aw(a));
const ethBal = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));
const ownerOf = async (id) => { try { return '0x' + (await rpcA('eth_call', [{ to: MARKET, data: '0x6352211e' + id.slice(2) }, 'latest'])).slice(-40); } catch { return null; } };
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout });
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

async function mined(h) { for (let i = 0; i < 60; i++) { await rpcA('evm_mine', []).catch(() => {}); const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(250); } throw new Error('not mined'); }
async function sendAs(from, to, data) {
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, gas: '0x4c4b40' }]);
  const r = await mined(h);
  if (r.status !== '0x1') throw new Error(`${to} ${data.slice(0, 10)} reverted: ${h}`);
  return r;
}
async function fundedWallet(eth) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], who = j.address;
  await rpcA('anvil_setBalance', [who, hex(eth)]); await rpcA('anvil_impersonateAccount', [who]);
  return { account: who, key: j.private_key };
}

// ShopZap, built from the repo's source with the repo's compiler settings (contracts/foundry.toml), so that what is tested is the code that is deployed
const proj = mkdtempSync(join(tmpdir(), 'shopzap-'));
writeFileSync(join(proj, 'foundry.toml'), '[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\nsolc = "0.8.37"\nvia_ir = true\noptimizer = true\noptimizer_runs = 1\nbytecode_hash = "none"\ncbor_metadata = false\n');
// the libraries: the repo's own when its submodules are there (a git worktree has them empty), else CONTRACT_LIBS or the main checkout's
const LIB = [process.env.CONTRACT_LIBS, join(REPO, 'contracts/lib'), '/Users/z/tacit/contracts/lib'].filter(Boolean).find((d) => existsSync(join(d, 'solady/src/utils/SafeTransferLib.sol')));
if (!LIB) throw new Error('no contracts/lib with solady in it: set CONTRACT_LIBS=<path to contracts/lib>');
mkdirSync(join(proj, 'src')); symlinkSync(LIB, join(proj, 'lib')); symlinkSync(join(REPO, 'contracts/src/ShopZap.sol'), join(proj, 'src/ShopZap.sol'));
execFileSync('forge', ['build', '--root', proj, '--silent'], { stdio: 'inherit' });
const art = JSON.parse(readFileSync(join(proj, 'out/ShopZap.sol/ShopZap.json'), 'utf8'));
// the creation code with the three addresses the contract is built with on the end: what a buyer pastes into the shop page's own form
const initcode = art.bytecode.object + aw(ZROUTER) + aw(TACADDR) + aw(SHOP);
console.log(`  ShopZap creation code: ${(initcode.length - 2) / 2} bytes, keccak256 ${cast('keccak', initcode)}; runtime: ${(art.deployedBytecode.object.length - 2) / 2} bytes, keccak256 ${cast('keccak', art.deployedBytecode.object)} (the three addresses are filled in on deployment)`);
let ZAP = null;   // the repo's source, deployed on the fork by this run
let USE = null;   // the zap the page is given when a run says so: the one shelf.js names, else ZAP
const setTac = (who, amount) => rpcA('anvil_setStorageAt', [TACADDR, cast('keccak', '0x' + who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2'), '0x' + word(amount)]);

// the page's files, from the repo; shelf.js names a zap only when a run says so
const flags = { zap: false };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  let body = readFileSync(f);
  if (p === '/shop/shelf.js') body = Buffer.from(String(body).replace(/export const ZAP = [^;]*;/, `export const ZAP = ${flags.zap ? `'${USE}'` : 'null'};`));
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(body);
}).listen(WEB);

async function stubWallet(ctx, w) {
  const log = { account: w.account, sends: [], signs: 0, signAttempts: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts') return [log.account];
    if (method === 'eth_accounts') return [log.account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_signTypedData_v4') { log.signAttempts++; throw Object.assign(new Error('not asked for in this test'), { code: -32601 }); }
    if (method === 'eth_sendTransaction') {
      log.sends.push(params[0]);
      const h = await rpcA('eth_sendTransaction', [{ ...params[0], gas: '0xb71b00' }]);
      (async () => { for (let i = 0; i < 40; i++) { await sleep(2000); if (await rpcA('eth_getTransactionReceipt', [h]).catch(() => null)) return; await rpcA('evm_mine', []).catch(() => {}); } })();
      return h;
    }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}
const stray = [];
async function openPage(wallet) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  const walletLog = await stubWallet(ctx, wallet);
  await ctx.route(/^https:\/\//, async (route) => {
    const req = route.request(), cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() || '';
    if (req.method() !== 'POST' || !/"jsonrpc"/.test(body)) { stray.push(req.url()); return route.fulfill({ status: 404, headers: cors, body: '' }); }
    try { const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: await r.text() }); }
    catch (e) { await route.fulfill({ status: 502, headers: cors, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon/i.test(t)) return; (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}/shop/`);
  return { browser, page, errors, blocked, walletLog };
}

// one address for sale at 30 TAC (the fork's shelf is emptied of the live listings first)
const idFor = (k) => '0x' + SHOP.slice(2).toLowerCase() + '00' + '5125' + k.toString(16).padStart(18, '0');
let cursor = 900;
function findId(nonce) { for (;;) { const id = idFor(cursor++), { address, bits } = marketAddress(id, nonce, { market: MARKET }); if (bits >= 6) return { id, nonce, address, bits }; } }
const listAs = (items) => sendAs(OPS, SHOP, encodeList(items.map((x) => ({ id: x.id, price: x.price, nonce: x.nonce }))));

let r1, r2, r3, r4;
try {
  await rpcA('anvil_setBalance', [OPS, hex(50n * E18)]); await rpcA('anvil_impersonateAccount', [OPS]);
  const head = Number(BigInt(await rpcA('eth_blockNumber')));
  let live = [];
  for (let from = FROM_BLOCK; from <= head; from += 2000) live = live.concat(await rpcA('eth_getLogs', [{ address: SHOP, fromBlock: hex(from), toBlock: hex(Math.min(from + 1999, head)), topics: [Object.values(TOPICS)] }]));
  const onShelf = foldShelf(live);
  if (onShelf.length) await sendAs(OPS, SHOP, cast('calldata', 'unlist(uint256[])', `[${onShelf.map((x) => x.id).join(',')}]`));
  // ---- the zap, put where it is meant to go: an address bought from the shop with TAC, then the market's deploy with the creation code
  {
    const Z = { ...findId(3), price: 20n * E18 };
    await listAs([Z]);
    const owner = await fundedWallet(E18);
    await setTac(owner.account, 25n * E18);
    await sendAs(owner.account, TACADDR, '0x095ea7b3' + aw(SHOP) + word(Z.price));
    await sendAs(owner.account, SHOP, cast('calldata', 'buy(uint256,address,uint8,uint256,uint256)', BigInt(Z.id).toString(), owner.account, String(Z.nonce), Z.price.toString(), String(Math.floor(Date.now() / 1000) + 3600)));
    ok((await ownerOf(Z.id))?.toLowerCase() === owner.account.toLowerCase(), `the address ${Z.address} is bought from the shop`);
    // anyone can put a wei at the address the market deploys from before the deploy, and the market hands that balance to the constructor: the zap's constructor takes it
    const initHash = await rpcA('eth_call', [{ to: MARKET, data: cast('sig', 'DEPLOY_PROXY_INITHASH()') }, 'latest']);
    const deployProxy = '0x' + cast('keccak', '0xff' + MARKET.slice(2).toLowerCase() + word(BigInt(Z.id)) + initHash.slice(2)).slice(-40);
    await rpcA('anvil_setBalance', [deployProxy, '0x1']);
    await sendAs(owner.account, MARKET, deployData(Z.id, initcode));
    ZAP = Z.address;
    ok((await ethBal(ZAP)) === 1n, 'a wei put at the address the market deploys from does not stop the deploy: the constructor takes it');
    const code = await rpcA('eth_getCode', [ZAP, 'latest']);
    ok((code.length - 2) / 2 === (art.deployedBytecode.object.length - 2) / 2 && (await ownerOf(Z.id)) === null, 'the market\'s deploy puts the zap at that address, the same length as its runtime code, and the token is used up');
    ok((await read(ZAP, cast('sig', 'ZROUTER()'))) === BigInt(ZROUTER) && (await read(ZAP, cast('sig', 'TAC()'))) === BigInt(TACADDR) && (await read(ZAP, cast('sig', 'SHOP()'))) === BigInt(SHOP), 'built with the router, TAC and the shop it is meant for');
    const refused = {};
    for (const [name, to] of [['the zap itself', ZAP], ['the router', ZROUTER]]) {
      try { await rpcA('eth_call', [{ to: ZAP, from: owner.account, value: '0x1', data: cast('calldata', 'buyWithEth(bytes,uint256,address,uint8,uint256,uint256)', '0x', '1', to, '0', '1', '1') }, 'latest']); refused[name] = false; }
      catch (e) { refused[name] = JSON.stringify(e.rpc || e.message).includes(cast('sig', 'BadRecipient()')); }
    }
    ok(refused['the zap itself'] && refused['the router'], `a purchase that would send the token to the zap itself or to the router is refused on the deployed code (${JSON.stringify(refused)})`);
    // the zap named in shelf.js is what the repo's source deploys: the same creation code and the same three addresses leave the same runtime code
    if (SHIPPED) ok((await rpcA('eth_getCode', [SHIPPED, 'latest'])) === code, `the zap named in shelf.js (${SHIPPED}) holds exactly the code the repo's source deploys`);
  }
  USE = SHIPPED || ZAP;
  const H = { ...findId(2), price: 30n * E18 };
  await listAs([H]);
  const treasury0 = await tacBal(OPS);

  // ---- no zap named: the page can only point to where TAC is got
  const eth1 = await fundedWallet(5n * E18);
  r1 = await openPage(eth1);
  await until(r1.page, (id) => !!document.querySelector(`[data-buy="${id}"]`), H.id, 180000);
  await r1.page.click(`[data-buy="${H.id}"]`);
  await until(r1.page, () => document.querySelector('[data-buy]')?.textContent.trim() === 'Buy', null, 60000);
  await r1.page.click(`[data-buy="${H.id}"]`);
  await until(r1.page, () => /You hold 0 TAC/.test(document.querySelector('#note')?.textContent || ''), null, 120000);
  ok(!(await r1.page.$('[data-zap]')) && !!(await r1.page.$('#note a[href="/?from=ETH&to=TAC"]')) && r1.walletLog.sends.length === 0, 'with no zap named, a wallet with no TAC is told what it holds and where to get TAC, and offered no way to pay with ETH');
  await r1.browser.close(); r1 = null;

  // ---- a zap named and deployed: the ETH way, in one transaction
  flags.zap = true;
  r2 = await openPage(eth1);
  const p = r2.page, W = r2.walletLog;
  await until(p, (id) => !!document.querySelector(`[data-buy="${id}"]`), H.id, 180000);
  await p.click(`[data-buy="${H.id}"]`);
  await until(p, () => document.querySelector('[data-buy]')?.textContent.trim() === 'Buy', null, 60000);
  await p.click(`[data-buy="${H.id}"]`);
  await until(p, () => !!document.querySelector('[data-zap]'), null, 180000);
  const offer = await text(p, '#note');
  const quoted = Number((offer.match(/Pay about ([\d.]+) ETH/) || [])[1]);
  ok(/You hold 0 TAC\. This one costs 30\./.test(offer) && /Pay about [\d.]+ ETH/.test(offer) && /One transaction/.test(offer) && quoted > 0 && W.sends.length === 0, `a wallet with ETH and no TAC is offered to pay with ETH, with the amount (${offer.slice(0, 150)})`);
  const shape = await p.evaluate((id) => {
    const note = document.querySelector('#note');
    return { under: note?.previousElementSibling?.dataset.id === id, ethMark: !!note?.querySelector('button[data-zap] svg use[href="#tk-eth"]'), asError: !!note?.classList.contains('err'), marks: document.querySelectorAll('.row .price svg use[href="#tk-tac"]').length, rows: document.querySelectorAll('.row').length };
  }, H.id);
  ok(shape.under && shape.ethMark && !shape.asError && shape.rows > 0 && shape.marks === shape.rows, `the offer is under the row that was pressed, a button with the ETH mark and not in the colour of an error, and every price wears the TAC mark (${JSON.stringify(shape)})`);
  const eth0 = await ethBal(eth1.account);
  await p.click('[data-zap]');
  await until(p, () => /It is yours/.test(document.querySelector('#after')?.textContent || ''), null, 240000);
  const tx = W.sends[0], valueEth = Number(BigInt(tx.value)) / 1e18;
  ok(W.sends.length === 1 && W.signAttempts === 0 && tx.to.toLowerCase() === USE.toLowerCase() && tx.data.startsWith('0x01d351d9'), 'one transaction, to the zap: buyWithEth, and no signature asked for');
  ok(Math.abs(valueEth - quoted) <= Math.max(quoted * 0.05, 0.00006), `it sends about the ETH the page said (${valueEth} against ${quoted})`);
  ok((await ownerOf(H.id))?.toLowerCase() === eth1.account.toLowerCase(), 'the token is the buyer\'s');
  ok(await tacBal(OPS) - treasury0 === 30n * E18, 'the shop was paid exactly its price in TAC, which the swap bought in the same transaction');
  const dust = await tacBal(eth1.account);
  ok(dust >= 0n && dust < (30n * E18 * 25n) / 1000n, `what the swap paid beyond the price comes back as TAC, under 2.5% of it: the margin is 1.5% and the quote is brought to within half a percent of it (${Number(dust) / 1e18} TAC)`);
  ok((await ethBal(USE)) === 0n && (await tacBal(USE)) === 0n && (await read(TACADDR, '0xdd62ed3e' + aw(USE) + aw(SHOP))) === 0n, 'the zap keeps no ETH, no TAC and no allowance');
  ok(eth0 - (await ethBal(eth1.account)) >= BigInt(tx.value) - 1n * E18 / 1000n && eth0 - (await ethBal(eth1.account)) < BigInt(tx.value) + E18 / 100n, 'the buyer paid the ETH it sent (less any the router gave back) and the gas, nothing more');
  ok(/Deploy to it/.test(await text(p, '#after')), 'and the address is offered for use at once');
  ok(r2.errors.length === 0 && r2.blocked.length === 0, `no page errors and nothing blocked by the page's policy (${[...r2.errors, ...r2.blocked].join(' | ').slice(0, 300)})`);
  await r2.browser.close(); r2 = null;

  // ---- ETH that would not cover it: no offer
  const poor = await fundedWallet(E18 / 100000n);
  const H2 = { ...findId(1), price: 30n * E18 };
  await listAs([H2]);
  r3 = await openPage(poor);
  await until(r3.page, (id) => !!document.querySelector(`[data-buy="${id}"]`), H2.id, 180000);
  await r3.page.click(`[data-buy="${H2.id}"]`);
  await until(r3.page, () => document.querySelector('[data-buy]')?.textContent.trim() === 'Buy', null, 60000);
  await r3.page.click(`[data-buy="${H2.id}"]`);
  await until(r3.page, () => /You hold 0 TAC/.test(document.querySelector('#note')?.textContent || ''), null, 120000);
  ok(!(await r3.page.$('[data-zap]')) && r3.walletLog.sends.length === 0, 'a wallet whose ETH would not cover the price is not offered the ETH way');
  await r3.browser.close(); r3 = null;
  // ---- a long shelf, as the live one is (sixty rows): what a press says is under the row that was pressed, in view without scrolling to it; and when that row has been taken down
  // meanwhile, the note is at the foot of the list and the page is taken there
  const many = [];
  for (let k = 0; k < 14; k++) many.push({ ...findId(k % 3), price: BigInt(14 + k) * E18 });
  await listAs(many);
  r4 = await openPage(await fundedWallet(5n * E18));
  const q = r4.page;
  await until(q, () => document.querySelectorAll('[data-buy]').length >= 14, null, 180000);
  const ids = await q.$$eval('[data-buy]', (bs) => bs.map((b) => b.dataset.buy));
  const noteInView = () => q.evaluate(() => { const n = document.querySelector('#note'), r = n?.getBoundingClientRect(); return !!r && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; });
  const mid = ids[Math.floor(ids.length / 2)];
  await q.click(`[data-buy="${mid}"]`);
  await until(q, () => document.querySelector('[data-buy]')?.textContent.trim() === 'Buy', null, 60000);
  await q.click(`[data-buy="${mid}"]`);
  await until(q, () => !!document.querySelector('[data-zap]'), null, 180000);
  const under = await q.evaluate((id) => document.querySelector('#note')?.previousElementSibling?.dataset.id === id, mid);
  ok(under && ids.length >= 14 && await noteInView(), `on a shelf of ${ids.length} rows the offer is under the row that was pressed and in view, with no scrolling to it`);
  const away = ids.find((id) => id !== mid);
  await sendAs(OPS, SHOP, cast('calldata', 'unlist(uint256[])', `[${away}]`));
  await q.evaluate(() => window.scrollTo(0, 0));
  await q.click(`[data-buy="${away}"]`);
  await until(q, () => /That one is gone/.test(document.querySelector('#note')?.textContent || ''), null, 120000);
  await until(q, () => { const n = document.querySelector('#note'), r = n?.getBoundingClientRect(); return !!r && n.tagName === 'DIV' && r.top >= 0 && r.bottom <= innerHeight; }, null, 30000);
  ok(await noteInView(), 'a row taken down while the page was open: the press says it is gone, the note is at the foot of the list, and the page is taken to it');
  // a purchase made from far down the list ends with the result in view, not at the top of a page the buyer has scrolled away from
  await q.click(`[data-buy="${mid}"]`);
  await until(q, () => !!document.querySelector('[data-zap]'), null, 180000);
  await q.click('[data-zap]');
  await until(q, () => /It is yours/.test(document.querySelector('#after')?.textContent || ''), null, 240000);
  await until(q, () => { const r = document.querySelector('#after')?.getBoundingClientRect(); return !!r && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; }, null, 30000);
  ok(await q.evaluate(() => { const r = document.querySelector('#after').getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; }), 'a purchase made from far down a long list ends with "It is yours" in view');
  ok(r4.errors.length === 0 && r4.blocked.length === 0, `no page errors on the long shelf (${[...r4.errors, ...r4.blocked].join(' | ').slice(0, 300)})`);
  await r4.browser.close(); r4 = null;
  ok(stray.length === 0, `the page asked nothing of anyone but Ethereum nodes (${stray.slice(0, 3).join(', ')})`);
} catch (e) {
  fails++; console.log('FAIL   ' + (e?.stack || e));
  for (const r of [r1, r2, r3, r4]) if (r) { try { console.log('  page note:', await text(r.page, '#note')); } catch { /* the page is gone */ } }
} finally {
  for (const r of [r1, r2, r3, r4]) await r?.browser.close().catch(() => {});
  anvil.kill('SIGKILL'); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nall ${n} ok`);
process.exit(fails ? 1 : 0);
