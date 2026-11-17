#!/usr/bin/env node
// The shop page (dapp/shop/) in a real browser under the page's own CSP, against an anvil fork of mainnet that holds the live shop, the vanity market and TAC: the
// shelf (read from the shop's events, the rarest first), a buy with TAC's permit, a buy with an allowance already in place, the refusals the page makes before anything is
// signed, a price that changed or an address that went while the page was open, a wallet that cannot sign a permit (approval first), a wallet that says no, a sale lost in
// the moment of signing, a shelf that cannot be read, and a phone. The ops multisig is impersonated on the fork to list and unlist.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/vanity-page.mjs        (Node 22; needs anvil and cast; SHOTS=<dir> saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { marketAddress } from '../worker/src/salt-pool.js';
import { encodeList } from '../tools/vanity-shop-list.mjs';
import { foldShelf, TOPICS, FROM_BLOCK, forwarderRuntime, zerosOf } from '../dapp/shop/shelf.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', SHOTS = process.env.SHOTS || null;
const PORT = 22000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
let server;
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; }
  catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');     // as the host does: a directory is served at its address with the slash
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout });
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const rpcA = async (method, params = []) => {
  const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpc: j.error });
  return j.result;
};
const SHOP = '0x00000000000785882df83d4cC6ED45c21eB1176C', MARKET = '0x000000000000b361194cfe6312EE3210d53C15AA', TACADDR = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', E18 = 10n ** 18n;
const POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', CHAINLINK_ETH_USD = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', ETH_USD = 2000n;     // the price of ETH is set here, so the dollars on the page are known
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), aw = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const read = async (to, data) => BigInt(await rpcA('eth_call', [{ to, data }, 'latest']));
const tacBal = (a) => read(TACADDR, '0x70a08231' + aw(a));
const allowance = (o, s) => read(TACADDR, '0xdd62ed3e' + aw(o) + aw(s));
const ownerOf = async (id) => { try { return '0x' + (await rpcA('eth_call', [{ to: MARKET, data: '0x6352211e' + id.slice(2) }, 'latest'])).slice(-40); } catch { return null; } };
const setTac = (who, amount) => rpcA('anvil_setStorageAt', [TACADDR, cast('keccak', '0x' + who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2'), '0x' + word(amount)]);

// a transaction from an impersonated account, mined at once (a forked anvil can leave one pending with automine on)
async function sendAs(from, to, data, value = 0n) {
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, gas: '0x4c4b40', ...(value ? { value: '0x' + value.toString(16) } : {}) }]);
  for (let i = 0; i < 60; i++) {
    await rpcA('evm_mine', []).catch(() => {});
    const r = await rpcA('eth_getTransactionReceipt', [h]);
    if (r) { if (r.status !== '0x1') throw new Error(`${to} ${data.slice(0, 10)} reverted: ${h}`); return r; }
    await sleep(250);
  }
  throw new Error('not mined: ' + h);
}
async function fundedWallet(eth, tac) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], who = j.address;
  await rpcA('anvil_setBalance', [who, '0x' + eth.toString(16)]);
  if (tac) await setTac(who, tac);
  await rpcA('anvil_impersonateAccount', [who]);
  return { account: who, key: j.private_key };
}

// A wallet in the page: window.ethereum answers as an EIP-1193 provider, signs TAC's permit with a real key and sends through the fork. The flags can be changed between presses.
async function stubWallet(ctx, w) {
  const log = { account: w.account, key: w.key, sends: [], typed: [], signs: 0, signAttempts: 0, connects: 0, refuseSends: false, noPermit: false, onSign: null };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts') { log.connects++; return [log.account]; }
    if (method === 'eth_accounts') return [log.account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_signTypedData_v4') {
      log.signAttempts++;
      if (log.noPermit) throw Object.assign(new Error('The method eth_signTypedData_v4 is not supported by this account.'), { code: -32601 });
      log.typed.push(JSON.parse(params[1]));
      if (log.onSign) { const f = log.onSign; log.onSign = null; await f(); }
      log.signs++; return cast('wallet', 'sign', '--private-key', log.key, '--data', params[1]);
    }
    if (method === 'eth_sendTransaction') {
      if (log.refuseSends) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
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

// every https request the page makes is a node's: it is answered by the fork, and anything else is noted
const stray = [], flags = { failLogs: false };
async function openPage(viewport, wallet = null) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const walletLog = wallet ? await stubWallet(ctx, wallet) : null;
  await ctx.route(/^https:\/\//, async (route) => {
    const req = route.request(), cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() || '';
    if (req.method() !== 'POST' || !/"jsonrpc"/.test(body)) { stray.push(req.url()); return route.fulfill({ status: 404, headers: cors, body: '' }); }
    try {
      if (flags.failLogs && /"eth_getLogs"/.test(body)) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, error: { code: -32005, message: 'query timeout exceeded' } }) });
      const asked = JSON.parse(body), feed = (q) => q.method === 'eth_call' && String(q.params?.[0]?.to).toLowerCase() === CHAINLINK_ETH_USD && q.params[0].data === '0xfeaf968c';
      if (Array.isArray(asked) ? asked.some(feed) : feed(asked)) {
        const now = Math.floor(Date.now() / 1000), w = (v) => BigInt(v).toString(16).padStart(64, '0');
        const answer = async (q) => (feed(q) ? { jsonrpc: '2.0', id: q.id, result: '0x' + w(1) + w(ETH_USD * 10n ** 8n) + w(now) + w(now) + w(1) } : await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) })).json());
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(Array.isArray(asked) ? await Promise.all(asked.map(answer)) : await answer(asked)) });
      }
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: await r.text() });
    } catch (e) { await route.fulfill({ status: 502, headers: cors, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/favicon/i.test(t)) return; (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}/shop/`);
  return { browser, page, errors, blocked, walletLog };
}

// ---- ids of the shop's, found by their addresses (the same arithmetic as the pool's, here checked against the market itself when each is listed)
const idFor = (k) => '0x' + SHOP.slice(2).toLowerCase() + '00' + '5125' + k.toString(16).padStart(18, '0');
let cursor = 1;
function findId(nonce, want) {
  for (;;) {
    const id = idFor(cursor++), { address, bits } = marketAddress(id, nonce, { market: MARKET });
    if (want(bits)) return { id, nonce, address, bits };
  }
}
const itemOf = (x, price) => ({ ...x, price: BigInt(price) * E18 });
const listCall = (items) => sendAs(OPS, SHOP, encodeList(items.map((x) => ({ id: x.id, price: x.price, nonce: x.nonce }))));
const unlistCall = (items) => sendAs(OPS, SHOP, cast('calldata', 'unlist(uint256[])', `[${items.map((x) => x.id).join(',')}]`));

const rows = (p) => p.$$eval('#shelf .row', (a) => a.map((r) => ({ id: r.dataset.id, addr: r.querySelector('code').getAttribute('title'), shown: r.querySelector('code').textContent, zeros: r.querySelector('code b').textContent,
  meta: r.querySelector('small').textContent, price: r.querySelector('.price').textContent.replace(/\s+/g, ' ').trim(), label: r.querySelector('button').textContent.trim(), disabled: r.querySelector('button').disabled })));
const note = (p) => text(p, '#note');
const clickBuy = (p, x) => p.click(`[data-buy="${x.id}"]`);
const gone = (p, x) => until(p, (id) => !document.querySelector(`[data-buy="${id}"]`), x.id, 120000);
const noteHas = (p, re, timeout = 120000) => until(p, (s) => new RegExp(s, 'i').test(document.querySelector('#note')?.textContent || ''), re.source, timeout);

let r1, r2, r3;
try {
  // the fork starts with an empty shelf: whatever the live shop lists meanwhile is taken down here, first
  await rpcA('anvil_setBalance', [OPS, '0x' + (50n * E18).toString(16)]);
  await rpcA('anvil_impersonateAccount', [OPS]);
  const head = Number(BigInt(await rpcA('eth_blockNumber')));
  let live = [];
  for (let from = FROM_BLOCK; from <= head; from += 2000) live = live.concat(await rpcA('eth_getLogs', [{ address: SHOP, fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(from + 1999, head).toString(16), topics: [Object.values(TOPICS)] }]));
  const onShelf = foldShelf(live);
  if (onShelf.length) { await unlistCall(onShelf); console.log(`  (the live shop had ${onShelf.length} listed: taken down on the fork)`); }

  // ---- nothing for sale; a shelf that cannot be read; a visit with no wallet in the browser
  flags.failLogs = true;
  r1 = await openPage({ width: 1280, height: 900 });
  const p1 = r1.page;
  await until(p1, () => /could not be read/i.test(document.querySelector('#shelf')?.textContent || ''), null, 120000);
  ok(await p1.$('#again') !== null, 'a shelf that cannot be read says so, with a way to try again');
  flags.failLogs = false;
  await p1.click('#again');
  await until(p1, () => /Nothing for sale right now/.test(document.querySelector('#shelf')?.textContent || ''), null, 120000);
  ok(true, 'and when the nodes answer again, the retry shows an empty shelf as empty');
  ok(await p1.$('[data-buy]') === null && /Connect/.test(await text(p1, '#wallet-chip')), 'with nothing listed there is nothing to buy, and the wallet chip offers to connect');
  ok((await p1.$eval('#shelf .need a', (a) => a.getAttribute('href'))) === '/?from=ETH&to=TAC' && /Need TAC\? Buy it/.test(await text(p1, '#shelf .need')), 'the shelf says where to get TAC: "Need TAC? Buy it", to the front page\'s swap with ETH to TAC chosen');
  await r1.browser.close(); r1 = null;

  // ---- the ops multisig lists four: the rarest, two of equal rarity at two prices, and one at a high nonce
  const A = itemOf(findId(5, (b) => b >= 12), 250), B = itemOf(findId(0, (b) => b === 8), 40), C = itemOf(findId(126, (b) => b === 8), 25), D = itemOf(findId(200, (b) => b < 8), 5);
  console.log(`  ids: A ${A.bits} bits nonce ${A.nonce}, B ${B.bits} bits, C ${C.bits} bits nonce ${C.nonce}, D ${D.bits} bits nonce ${D.nonce}`);
  const rc = await listCall([A, B, C, D]);
  const listedEvents = rc.logs.filter((l) => l.topics[0] === TOPICS.listed);
  ok(listedEvents.length === 4 && [A, B, C, D].every((x) => listedEvents.some((l) => l.topics[1] === x.id && '0x' + l.topics[2].slice(-40) === x.address)),
    'the market itself gives each listed address the one the pool\'s arithmetic does, nonces 0, 5, 126 and 200 among them');

  const buyer = await fundedWallet(5n * E18, 1000n * E18), recip = await fundedWallet(1n * E18, 0n);
  r2 = await openPage({ width: 1280, height: 900 }, buyer);
  const p = r2.page, W = r2.walletLog;
  await until(p, () => document.querySelectorAll('#shelf .row').length >= 4, null, 180000);
  let list = await rows(p);
  ok(list.length === 4 && list.map((x) => x.id).join() === [A, C, B, D].map((x) => x.id).join(), `the shelf has the four, the rarest first and the cheaper first among equals (${list.map((x) => x.meta).join(', ')})`);
  ok(list.every((x, i) => x.addr === [A, C, B, D][i].address && x.shown === x.addr && x.shown.startsWith(x.zeros)), 'each address is shown whole, as the market gives it, with its zeros set apart');
  ok(list.every((x, i) => x.meta === `${zerosOf([A, C, B, D][i].bits)} ${zerosOf([A, C, B, D][i].bits) === 1 ? 'zero' : 'zeros'}`) && !list.some((x) => /bits|nonce/.test(x.meta)), `a row says its zeros in plain words, with no bits or nonce (${list.map((x) => x.meta).join(', ')})`);
  await until(p, () => !!document.querySelector('#shelf .usd'), null, 120000);
  list = await rows(p);
  ok(list.map((x) => x.price.split('≈')[0].trim()).join() === '250 TAC,25 TAC,40 TAC,5 TAC', `and its price in TAC (${list.map((x) => x.price).join(', ')})`);
  const sqrtP = BigInt(await rpcA('eth_call', [{ to: POOL, data: '0x2af1f249' }, 'latest'])) , tacUsd = Number(ETH_USD) / ((Number(sqrtP) / 1e18) ** 2);
  const dollars = list.map((x) => Number((x.price.match(/≈ \$([\d,]+(?:\.\d+)?)/) || [])[1]?.replace(/,/g, '')));
  ok(dollars.every((d, i) => Math.abs(d - [250, 25, 40, 5][i] * tacUsd) <= Math.max(0.01, [250, 25, 40, 5][i] * tacUsd * 0.005)), `each price carries its dollars at TAC's price on the pool and ETH's at $2,000 (TAC $${tacUsd.toFixed(4)}: ${list.map((x) => x.price.split('≈ ')[1]).join(', ')})`);
  ok(list.every((x) => x.label === 'Connect to buy' && !x.disabled), 'with no wallet connected, each button connects one');
  ok(/For sale · 4/.test(await text(p, '#shelf > .eyebrow')), 'the count of what is for sale is said');
  {
    const tiers = [...new Set([A, B, C, D].map((x) => zerosOf(x.bits)))].sort((a, b) => a - b), word = (z) => `${z} ${z === 1 ? 'zero' : 'zeros'}`;
    const chips = await p.$$eval('.zc', (a) => a.map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`));
    ok(chips.join() === ['All:true', ...tiers.map((z) => `${word(z)}:false`)].join(), `the list can be narrowed by zeros: ${chips.join(', ')}`);
    await p.click(`.zc[data-zeros="${zerosOf(B.bits)}"]`);
    list = await rows(p);
    ok(list.map((x) => x.id).join() === [C, B].map((x) => x.id).join() && /For sale · 2 of 4/.test(await text(p, '#shelf > .eyebrow')) && (await p.$eval(`.zc[data-zeros="${zerosOf(B.bits)}"]`, (b) => b.getAttribute('aria-pressed'))) === 'true', 'a count of zeros keeps just those, in the same order, and the count says how many of how many');
    await p.click('.zc[data-zeros=""]');
    ok((await rows(p)).length === 4, 'All shows them all again');
    const mid = A.address.slice(20, 26);
    await p.fill('#find', mid);
    list = await rows(p);
    ok(list.length === 1 && list[0].id === A.id && /For sale · 1 of 4/.test(await text(p, '#shelf > .eyebrow')) && (await p.evaluate(() => document.activeElement?.id)) === 'find', 'typing part of an address finds it, and the field keeps the cursor through the redraw');
    await p.fill('#find', '0X' + mid.toUpperCase());
    ok((await rows(p)).map((x) => x.id).join() === A.id, 'case and a 0x do not matter');
    await p.fill('#find', 'zz');
    ok((await rows(p)).length === 0 && /No address matches that/.test(await text(p, '#shelf')) && !!(await p.$('#clear')), 'what is not hex finds nothing, and says so, with a way back');
    await p.click('#clear');
    ok((await rows(p)).length === 4 && (await p.$eval('#find', (i) => i.value)) === '', 'Show them all clears both');
  }

  await p.click(`[data-buy="${D.id}"]`);
  await until(p, () => document.querySelector('[data-buy]')?.textContent.trim() === 'Buy', null, 60000);
  await until(p, () => /1,000 TAC/.test(document.querySelector('#shelf .who')?.textContent || ''), null, 60000);
  ok(W.connects === 1 && (await rows(p)).every((x) => x.label === 'Buy'), 'pressing Connect to buy connects the wallet and every button becomes Buy');
  ok(/1,000 TAC/.test(await text(p, '#shelf .who')) && (await p.$eval('#to', (i) => i.placeholder)) === buyer.account, 'the TAC the wallet holds is shown, and the token\'s recipient defaults to the wallet\'s own address');

  // ---- what is refused before anything is signed
  await setTac(buyer.account, 10n * E18);
  await clickBuy(p, A);
  await noteHas(p, /You hold 10 TAC\. This one costs 250\./);
  ok(W.signAttempts === 0 && W.sends.length === 0 && (await p.$eval('#note a', (a) => a.getAttribute('href'))) === '/?from=ETH&to=TAC' && /Buy TAC/.test(await text(p, '#note')), 'with too little TAC the page says what the wallet holds and what the address costs, with a Buy TAC link to the swap, and asks for nothing');
  await setTac(buyer.account, 1000n * E18);
  for (const bad of [SHOP, TACADDR, MARKET, 'hello', '0x1234']) {
    await p.fill('#to', bad);
    await clickBuy(p, A);
    await noteHas(p, /Name an address to send the token to/);
  }
  ok(W.signAttempts === 0 && W.sends.length === 0 && (await ownerOf(A.id)) === null, 'the shop, the market, TAC and what is not an address are refused as recipients, with nothing asked of the wallet');

  // ---- a buy with TAC's permit, to another address
  const opsBefore = await tacBal(OPS);
  await p.fill('#to', recip.account);
  await clickBuy(p, A);
  await until(p, () => /It is yours/.test(document.querySelector('#after')?.textContent || ''), null, 240000);
  const t = W.typed[0], m = t.message;
  ok(W.signs === 1 && W.sends.length === 1 && W.sends[0].to.toLowerCase() === SHOP.toLowerCase() && W.sends[0].data.startsWith('0xb6367954'), 'with no allowance the page asks for one signature and sends one transaction: buyWithPermit to the shop');
  ok(t.domain.name === 'Tacit Token' && t.domain.version === '1' && t.domain.chainId === 1 && t.domain.verifyingContract.toLowerCase() === TACADDR.toLowerCase()
    && m.owner.toLowerCase() === buyer.account.toLowerCase() && m.spender.toLowerCase() === SHOP.toLowerCase() && m.value === String(250n * E18), 'the permit is TAC\'s own, for the shop, for the price and not a unit more');
  ok((await ownerOf(A.id)).toLowerCase() === recip.account.toLowerCase(), 'the market\'s token is the recipient\'s, not the buyer\'s');
  ok(await tacBal(buyer.account) === 750n * E18 && await tacBal(OPS) - opsBefore === 250n * E18 && await tacBal(SHOP) === 0n && await allowance(buyer.account, SHOP) === 0n, 'the price moved from the buyer to the treasury, the shop holds nothing, and no allowance is left');
  const doneText = await text(p, '#after');
  ok(doneText.includes(A.address) && doneText.toLowerCase().includes(recip.account.toLowerCase()) && doneText.includes(BigInt(A.id).toString()) && /not the wallet connected now/.test(doneText) && (await p.$('#use-it')) === null, 'the page says what was bought, where its token is and the token\'s number, and offers no deploy when the token went to another address');
  await p.click('#copy-id');
  await until(p, () => /Copied|Select it/.test(document.querySelector('#copy-id')?.textContent || ''), null, 15000);
  ok(true, 'Copy answers when it is pressed');
  await until(p, () => document.querySelectorAll('#shelf .row').length === 3, null, 120000);
  ok(!(await rows(p)).some((x) => x.id === A.id) && /For sale · 3/.test(await text(p, '#shelf > .eyebrow')), 'and the address is off the shelf');
  await until(p, () => /750 TAC/.test(document.querySelector('#shelf .who')?.textContent || ''), null, 60000);
  ok(true, 'the buyer\'s balance is read again');

  // ---- a buy with an allowance already in place: no signature, to the buyer's own address
  await sendAs(buyer.account, TACADDR, '0x095ea7b3' + aw(SHOP) + word(25n * E18));
  await p.fill('#to', '');
  await clickBuy(p, C);
  await until(p, () => /It is yours/.test(document.querySelector('#after')?.textContent || '') && document.querySelectorAll('#shelf .row').length === 2, null, 240000);
  ok(W.signs === 1 && W.sends.length === 2 && W.sends[1].data.startsWith('0xb645f70b'), 'with the allowance in place the page asks for no signature and sends buy');
  ok((await ownerOf(C.id)).toLowerCase() === buyer.account.toLowerCase() && await tacBal(buyer.account) === 725n * E18, 'the token is the buyer\'s own when no other address is named');

  // ---- a price changed, and an address gone, while the page was open
  const F = itemOf(findId(3, (b) => b < 8), 7), B2 = { ...B, price: 55n * E18 };
  await listCall([B2, F]);
  await clickBuy(p, B);
  await noteHas(p, /Its price changed/);
  await until(p, () => document.querySelectorAll('#shelf .row').length === 3, null, 120000);
  list = await rows(p);
  ok(list.find((x) => x.id === B.id).price.split('≈')[0].trim() === '55 TAC' && list.some((x) => x.id === F.id) && W.sends.length === 2, 'a price the shop changed is refused as it was shown, and the list is read again with the new price and what was added');
  await unlistCall([B]);
  await clickBuy(p, B);
  await noteHas(p, /That one is gone/);
  await gone(p, B);
  ok(W.sends.length === 2, 'an address the shop took down is said to be gone, and leaves the list');

  // ---- a wallet that says no at the send, and one that cannot sign a permit
  W.refuseSends = true;
  const signsBefore = W.signs;
  await clickBuy(p, F);
  await noteHas(p, /Nothing was sent/i);
  ok(W.signs === signsBefore + 1 && W.sends.length === 2 && await tacBal(buyer.account) === 725n * E18 && (await ownerOf(F.id)) === null && !!(await p.$(`[data-buy="${F.id}"]`)), 'a wallet that says no at the send ends it: nothing was taken, and the address is still for sale');
  W.refuseSends = false; W.noPermit = true;
  await clickBuy(p, F);
  await until(p, () => /It is yours/.test(document.querySelector('#after')?.textContent || ''), null, 240000);
  ok(W.sends.length === 4 && W.sends[2].to.toLowerCase() === TACADDR.toLowerCase() && W.sends[2].data.startsWith('0x095ea7b3') && W.sends[3].to.toLowerCase() === SHOP.toLowerCase() && W.sends[3].data.startsWith('0xb645f70b'),
    'a wallet that cannot sign a permit approves the price first and then buys, with no signature');
  ok((await ownerOf(F.id)).toLowerCase() === buyer.account.toLowerCase() && await tacBal(buyer.account) === 718n * E18 && await allowance(buyer.account, SHOP) === 0n, 'and the price is paid and the allowance is used up');
  W.noPermit = false;
  ok(!!(await p.$('#use-it')), 'a token that went to the connected wallet comes with a button to deploy to it');
  await p.click('#use-it');
  ok((await p.$eval('#use-token', (e) => e.value)) === F.id, 'which picks that token in the section at the bottom');

  // ---- the one that goes while the wallet is being asked: the page's own check of the purchase says so, and nothing is sent
  const sends = W.sends.length;
  W.onSign = () => unlistCall([D]);
  await clickBuy(p, D);
  await noteHas(p, /just sold or taken down\. Nothing was sent/);
  await gone(p, D);
  ok(W.sends.length === sends && await tacBal(buyer.account) === 718n * E18 && (await ownerOf(D.id)) === null, 'an address lost while the permit was being signed is caught by the check before the send: nothing was sent');

  // ---- the section at the bottom: the contract that passes ETH on, custom bytecode, and what is refused
  {
    const recv2 = await fundedWallet(1n * E18, 0n), payer = await fundedWallet(5n * E18, 0n), sendsBefore = W.sends.length;
    const tokenOpts = () => p.$$eval('#use-token option', (a) => a.map((o) => o.textContent));
    await until(p, () => document.querySelectorAll('#use-token option').length >= 3, null, 60000);
    let opts = await tokenOpts();
    ok(opts.some((o) => o.includes(C.address)) && opts.some((o) => o.includes(F.address)) && !opts.some((o) => o.includes(A.address)), `it lists the addresses the wallet holds from the shop, and not the one that went to another wallet (${opts.length - 1} and the field for an id)`);
    await p.selectOption('#use-token', C.id);
    ok((await p.$eval('#use-kind', (e) => e.value)) === 'forward' && /ETH sent to the address goes straight on[\s\S]*cannot be changed[\s\S]*tokens sent to it would be stuck/.test(await text(p, '#use')), 'passing ETH on is what it offers first, with what it cannot do said plainly');
    for (const [bad, re] of [[C.address, /itself/], ['0x' + '0'.repeat(40), /empty address/], [SHOP, /shop, the market, TAC or the swap contracts/], ['0x000000000000FB114709235f1ccBFfb925F600e4', /swap contracts/], ['nonsense', /Name the address/]]) {
      await p.fill('#use-to', bad);
      await p.click('#use-go');
      await until(p, (s) => new RegExp(s).test(document.querySelector('#use-note')?.textContent || ''), re.source, 60000);
    }
    ok(W.sends.length === sendsBefore, 'an address it cannot pass ETH on to is refused, itself, the empty one, the shop and what is no address, with nothing sent');
    await p.fill('#use-to', recv2.account);
    await p.click('#use-go');
    await until(p, () => /Deployed at/.test(document.querySelector('#use')?.textContent || ''), null, 240000);
    const last = W.sends[W.sends.length - 1];
    ok(W.sends.length === sendsBefore + 1 && last.to.toLowerCase() === MARKET.toLowerCase() && last.data.startsWith('0x61ff715f'), 'one transaction, to the market: deploy');
    ok((await rpcA('eth_getCode', [C.address, 'latest'])) === forwarderRuntime(recv2.account) && (await ownerOf(C.id)) === null, 'the address now holds the 35-byte forwarder with the receiver inside, and the token is used up');
    const before = BigInt(await rpcA('eth_getBalance', [recv2.account, 'latest']));
    await sendAs(payer.account, C.address, '0x', 2n * E18);
    ok(BigInt(await rpcA('eth_getBalance', [recv2.account, 'latest'])) - before === 2n * E18 && BigInt(await rpcA('eth_getBalance', [C.address, 'latest'])) === 0n, '2 ETH sent to that address arrives at the receiver, and it keeps none');
    ok(/ETH sent to it now goes on to/.test(await text(p, '#use')) && new RegExp(recv2.account, 'i').test(await text(p, '#use')), 'the page says where ETH sent to it goes now');
    // reload: the wallet's addresses come from the shop's sales and the market, so the used one is gone and the unused one is there
    await p.reload();
    await until(p, () => !!document.querySelector('#use-token') || !!document.querySelector('#use-connect'), null, 120000);
    if (await p.$('#use-connect')) { await p.click('#use-connect'); await until(p, () => !!document.querySelector('#use-token'), null, 60000); }
    await until(p, () => document.querySelectorAll('#use-token option').length >= 2, null, 120000);
    opts = await tokenOpts();
    ok(opts.some((o) => o.includes(F.address)) && !opts.some((o) => o.includes(C.address)) && !opts.some((o) => o.includes(A.address)), 'after a reload it still lists the address not yet used, and not the used one');
    // custom bytecode, picked by token id
    await p.selectOption('#use-kind', 'custom');
    await p.fill('#use-init', 'xyz');
    await p.click('#use-go');
    await until(p, () => /creation bytecode/.test(document.querySelector('#use-note')?.textContent || ''), null, 60000);
    await p.fill('#use-init', '0x60006000fd');
    await p.click('#use-go');
    await until(p, () => /does not deploy[\s\S]*Nothing was sent/.test(document.querySelector('#use-note')?.textContent || ''), null, 120000);
    ok(W.sends.length === sendsBefore + 1, 'bytecode that is not hex, and bytecode that fails when it runs (the page tries it first), are refused with nothing sent');
    await p.selectOption('#use-token', 'other');
    await p.fill('#use-id', BigInt(A.id).toString());
    await p.fill('#use-init', '0x60016000f3');
    await p.click('#use-go');
    await until(p, () => /does not hold that token/.test(document.querySelector('#use-note')?.textContent || ''), null, 120000);
    await p.fill('#use-id', 'not an id');
    await p.click('#use-go');
    await until(p, () => /Enter the token id/.test(document.querySelector('#use-note')?.textContent || ''), null, 60000);
    ok(W.sends.length === sendsBefore + 1, 'a token held by another wallet, and a token id that is no number, are refused with nothing sent');
    await p.fill('#use-id', BigInt(F.id).toString());
    await p.click('#use-go');
    await until(p, () => /Deployed at/.test(document.querySelector('#use')?.textContent || ''), null, 240000);
    ok((await rpcA('eth_getCode', [F.address, 'latest'])) === '0x00' && (await ownerOf(F.id)) === null && W.sends.length === sendsBefore + 2, 'pasted bytecode, for a token entered by its number, deploys exactly that code at its address');
    // ETH at the address the market deploys from: code that refuses ETH cannot deploy there, and the page says that instead of blaming the code
    {
      await p.click('#use-again');
      await until(p, () => !!document.querySelector('#use-token'), null, 60000);
      const Y = findId(2, (b) => b >= 8);
      await sendAs(OPS, SHOP, cast('calldata', 'keep(uint256,uint8,address)', BigInt(Y.id).toString(), String(Y.nonce), W.account));
      const initHash = await rpcA('eth_call', [{ to: MARKET, data: cast('sig', 'DEPLOY_PROXY_INITHASH()') }, 'latest']);
      const proxy = '0x' + cast('keccak', '0xff' + MARKET.slice(2).toLowerCase() + word(BigInt(Y.id)) + initHash.slice(2)).slice(-40);
      await rpcA('anvil_setBalance', [proxy, '0x1']);
      await p.selectOption('#use-kind', 'custom');
      await p.selectOption('#use-token', 'other');
      await p.fill('#use-id', BigInt(Y.id).toString());
      await p.fill('#use-init', '0x34600b5760006000f3fefe5b60006000fd');          // a constructor that reverts when it is sent any ETH, and otherwise creates an empty contract
      const sendsNow = W.sends.length;
      await p.click('#use-go');
      await until(p, () => /Someone has sent ETH/.test(document.querySelector('#use-note')?.textContent || ''), null, 120000);
      ok(W.sends.length === sendsNow && (await ownerOf(Y.id))?.toLowerCase() === W.account.toLowerCase(), 'code that refuses ETH, with ETH at the address the market deploys from, is told so rather than blamed: nothing was sent and the token is still the wallet\'s');
      await rpcA('anvil_setBalance', [proxy, '0x0']);
      await p.click('#use-go');
      await until(p, () => /Deployed at/.test(document.querySelector('#use')?.textContent || ''), null, 240000);
      ok(W.sends.length === sendsNow + 1 && (await ownerOf(Y.id)) === null, 'and with nothing there the same code deploys');
    }
  }

  // ---- a change of account in the wallet
  const other = await fundedWallet(1n * E18, 500n * E18);
  W.account = other.account; W.key = other.key;
  const G = itemOf(findId(1, (b) => b < 8), 9);
  await listCall([G]);
  await p.evaluate((a) => window.__h.accountsChanged([a]), other.account);
  await until(p, (a) => /500 TAC/.test(document.querySelector('#shelf .who')?.textContent || '') && document.querySelector('#to')?.placeholder === a, other.account, 60000);
  ok(true, 'when the wallet changes account, the balance and the recipient are the new account\'s');
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'vanity-desktop.png'), fullPage: true });
  ok(r2.errors.length === 0 && r2.blocked.length === 0, `no page errors and nothing blocked by the page's policy (${[...r2.errors, ...r2.blocked].join(' | ').slice(0, 300)})`);
  await r2.browser.close(); r2 = null;

  // ---- a phone
  await listCall([itemOf(findId(7, (b) => b >= 8), 30)]);
  r3 = await openPage({ width: 390, height: 800 }, null);
  await until(r3.page, () => document.querySelectorAll('#shelf .row').length >= 2, null, 180000);
  const fit = await r3.page.evaluate(() => ({ page: document.documentElement.scrollWidth <= window.innerWidth + 1, rows: [...document.querySelectorAll('#shelf .row')].every((r) => r.getBoundingClientRect().right <= window.innerWidth + 1 && r.getBoundingClientRect().left >= -1),
    code: [...document.querySelectorAll('#shelf .row code')].every((c) => c.getBoundingClientRect().right <= window.innerWidth), use: (() => { const u = document.querySelector('#use')?.getBoundingClientRect(); return !!u && u.width > 0 && u.right <= window.innerWidth + 1; })() }));
  ok(fit.page && fit.rows && fit.code && fit.use, `on a phone the page does not scroll sideways and each address stays on the screen (${JSON.stringify(fit)})`);
  if (SHOTS) await r3.page.screenshot({ path: join(SHOTS, 'vanity-phone.png'), fullPage: true });
  ok(r3.errors.length === 0 && r3.blocked.length === 0, `and the phone page has no errors either (${[...r3.errors, ...r3.blocked].join(' | ').slice(0, 300)})`);
  await r3.browser.close(); r3 = null;

  ok(stray.length === 0, `the page asked nothing of anyone but Ethereum nodes (${stray.slice(0, 3).join(', ')})`);
} catch (e) {
  fails++; console.log('FAIL   ' + (e?.stack || e));
  for (const r of [r1, r2, r3]) if (r) { try { console.log('  page note:', await note(r.page), '| use note:', await text(r.page, '#use-note'), '| use:', (await text(r.page, '#use')).slice(0, 300)); if (SHOTS) await r.page.screenshot({ path: join(SHOTS, 'vanity-failure.png'), fullPage: true }); } catch { /* the page is gone */ } }
} finally {
  for (const r of [r1, r2, r3]) await r?.browser.close().catch(() => {});
  anvil.kill('SIGKILL'); server?.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nall ${n} ok`);
process.exit(fails ? 1 : 0);
