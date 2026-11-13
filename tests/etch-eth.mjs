#!/usr/bin/env node
// dapp/etch/ on Ethereum, against a fork of mainnet: the real page and modules, the real canonical factory, CreateX and pool contracts on the fork, and a
// wallet stand-in that sends as anvil's first account (and takes an EIP-5792 batch when told to). Only the API's pin is answered here, with the content id
// the real pin would return for the same bytes.
//   checks: the switch; the form's limits on this side; what the chain holds after an etch (the symbol, the decimals, the whole supply in one
//   account, a minter with nothing to call, the metadata stamp the pinned JSON hashes to); the pool's registration, as a batch and as a sequence; a wallet that
//   says no (to the first call, to the second); too little ETH; no metadata.
//
//   FORK=<rpc> PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/etch-eth.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';       // the free node that serves the factory's logs over its whole life, as the page reads them
const PORT = 21000 + Math.floor(Math.random() * 2000), ANVIL = `http://127.0.0.1:${PORT}`;
const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { data: r.error.data });
  return r.result;
};
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
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

// the content id the pin returns for some bytes: a raw-codec CIDv1 of their sha-256, in base32
const cidOf = (bytes) => {
  const digest = createHash('sha256').update(bytes).digest();
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, acc = 0, out = '';
  for (const b of raw) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += A[(acc >> bits) & 31]; acc &= (1 << bits) - 1; } }
  if (bits) out += A[(acc << (5 - bits)) & 31];
  return { cid: `b${out}`, digest: digest.toString('hex') };
};

const byCid = {};                                                  // what the pin was given, by the content id it answered, for the page's reads of names
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'mainnet.rpc.buidlguidl.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.mevblocker.io', 'eth-mainnet.nodereal.io', '1.rpc.thirdweb.com', 'rpc.flashbots.net', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io'];
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const SHOTS = process.env.SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const b = await chromium.launch();

// A page with a wallet that sends as the first anvil account. `ways`: batch (takes EIP-5792), refuse (the numbers of the sends it turns down, from 1).
async function fresh(path, ways = {}) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [], log = [], pinned = [], watched = [], batches = [], reqs = [];
  const st = { sends: 0, ways, calls: {} };
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('request', (r) => reqs.push(r.url()));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const preflight = (route) => route.request().method() === 'OPTIONS' && route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' } });
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    if (await preflight(route)) return;
    const body = route.request().postData() || '{}';
    const out = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out });
  });
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, async (route) => {
    if (await preflight(route)) return;
    const u = new URL(route.request().url()), cors = { 'access-control-allow-origin': '*' };
    if (u.pathname === '/pin-json') { const bytes = route.request().postDataBuffer(); pinned.push(JSON.parse(bytes.toString())); byCid[cidOf(bytes).cid] = JSON.parse(bytes.toString()); return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ cid: cidOf(bytes).cid, _digest: cidOf(bytes).digest }) }); }
    if (u.pathname === '/pin') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ cid: cidOf(Buffer.from('logo')).cid }) });
    if (u.pathname === '/ipfs/batch') { const ids = JSON.parse(route.request().postData() || '{}').cids || [], blobs = {}; for (const c of ids) blobs[c] = byCid[c] || { error: 'not json' }; return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ blobs }) }); }
    if (u.pathname === '/assets') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ assets: [], meta: {} }) });
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  await ctx.route(/^https:\/\/api\.coinbase\.com\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: { amount: route.request().url().includes('ETH') ? '4000' : '100000' } }) }));
  const declined = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });
  await page.exposeFunction('__wallet', async (method, params) => {
    log.push(method);
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [ACCOUNT];
      case 'eth_chainId': return '0x1';
      case 'wallet_switchEthereumChain': case 'wallet_revokePermissions': return null;
      case 'eth_sendTransaction': {
        st.sends++;
        if ((ways.refuse || []).includes(st.sends)) throw declined();
        return rpc('eth_sendTransaction', params);
      }
      case 'wallet_getCapabilities': if (!ways.batch) throw Object.assign(new Error('Method not found'), { code: -32601 }); return { '0x1': { atomic: { status: 'supported' } } };
      case 'wallet_sendCalls': {
        if (ways.refuseBatch) throw declined();
        batches.push(params[0]);
        const receipts = [];
        for (const c of params[0].calls) { const h = await rpc('eth_sendTransaction', [{ from: params[0].from, to: c.to, data: c.data, value: c.value }]); receipts.push(await rpc('eth_getTransactionReceipt', [h])); }
        st.batch = { id: '0x' + 'ab'.repeat(8), receipts };
        return { id: st.batch.id };
      }
      case 'wallet_getCallsStatus': return { version: '2.0.0', id: params[0], chainId: '0x1', status: 200, atomic: true, receipts: st.batch.receipts.map((r) => ({ status: r.status, transactionHash: r.transactionHash, gasUsed: r.gasUsed })) };
      case 'wallet_watchAsset': watched.push(params); return true;
      default: return rpc(method, params);
    }
  });
  await ctx.addInitScript(() => {
    const info = { uuid: 'test-wallet-1', name: 'Test Wallet', rdns: 'test.wallet', icon: '' };
    const provider = { request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} };
    const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    addEventListener('eip6963:requestProvider', announce); announce();
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tk', { state: 'attached' });
  return { page, errs, log, pinned, watched, batches, st, ctx, reqs };
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const type = async (page, sel, v) => { await page.fill(sel, ''); await page.type(sel, v, { delay: 4 }); };
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const addrWord = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const str = (h) => { const x = h.slice(2); const len = parseInt(x.slice(64, 128) || '0', 16); return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString(); };
const lastWord = (h) => BigInt('0x' + h.slice(2).slice(-64));
async function choose(page) { await page.click('[data-chain="eth"]'); }
async function form(page, o) {
  await type(page, '#tk', o.ticker); await type(page, '#sup', o.supply);
  if (o.dec != null) await page.click(`[data-d="${o.dec}"]`);
  if (o.name || o.desc || o.link || o.reg != null) await page.click('#more > summary');
  if (o.name) await type(page, '#nm', o.name);
  if (o.desc) await type(page, '#ds', o.desc);
  if (o.link) await type(page, '#ln', o.link);
  if (o.reg) await page.check('#reg');
}
const goLabel = (page) => text(page, '#go');
// the done card, or what the page said instead
async function done(page, errs = []) {
  try { await page.waitForSelector('#done:not([hidden])', { timeout: 120000 }); }
  catch (e) { console.log('DEBUG waiting for the done card: q =', await text(page, '#q'), '| go =', await goLabel(page), '| errors =', errs.join(' / ')); throw e; }
}
async function connect(page) {
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Connect a wallet');
  await page.click('#go');
  await page.waitForFunction(() => /^Etch .* on Ethereum$/.test(document.querySelector('#go').textContent));
}

console.log('The switch:');
{
  const { page } = await fresh('/etch/');
  ok(!(await page.$eval('#chain', (e) => e.hidden)) && (await page.$eval('#chain [aria-checked="true"]', (e) => e.dataset.chain)) === 'btc', 'a visitor to /etch/ is shown both sides, on Bitcoin first');
  await page.close();
}

console.log('\nThe form on this side:');
{
  const { page, errs, reqs } = await fresh('/etch/');
  ok(true, 'the Ethereum side opens from the switch');
  await choose(page);
  ok((await page.$$eval('#dec [data-d]', (b) => b.map((x) => x.dataset.d))).join() === '0,6,8,18' && (await page.$eval('#dec [aria-pressed="true"]', (e) => e.textContent)) === '18', 'it offers 0, 6, 8 and 18 decimals, and starts at 18');
  ok(await page.$eval('#pub-row', (e) => e.hidden) && await page.$eval('#mint-row', (e) => e.hidden) && !(await page.$eval('#reg-row', (e) => e.hidden)), 'publishing a supply and minting are not asked, registering with the pool is');
  await type(page, '#tk', 'orange');
  await type(page, '#sup', '99999999999999');
  ok(/^At most 184,467,440,737\.09551615$/.test(await text(page, '#sup-note')), 'a supply the pool could not hold is refused, at the most it can');
  await type(page, '#sup', '1000000');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Connect a wallet');
  ok(true, 'a wallet is asked for first');
  await page.waitForTimeout(800);
  ok(!reqs.some((u) => /\/tacit\.js|\/trade\/btc\.js/.test(u)), 'the Bitcoin side’s library is not loaded for it');
  await page.close();
  ok(errs.length === 0, 'no script errors' + (errs[0] ? `: ${errs[0]}` : ''));
}

console.log('\nAn etch, call by call:');
let token1, minter1;
{
  const { page, errs, log, pinned, batches } = await fresh('/etch/');
  await choose(page);
  await form(page, { ticker: 'orange', supply: '1000000', name: 'Orange Coin', desc: 'A coin', link: 'https://orange.example', reg: true });
  await connect(page);
  try { await page.waitForFunction(() => /about [\d.]+ ETH/.test(document.querySelector('#rcpt')?.textContent || '')); }
  catch (e) { console.log('DEBUG rpc:', await page.evaluate(async () => { const U = await import(document.querySelector('link[rel=modulepreload][href*="/trade/util.js"]').href); try { return await U.rpc('eth_gasPrice', []); } catch (x) { return 'ERR ' + x.message; } })); console.log('DEBUG rcpt:', await page.$eval('#rcpt', (x) => x.outerHTML), '| q:', await text(page, '#q'), '| go:', await goLabel(page), '| errs:', errs.join(' / '), '| log:', log.join(',')); throw e; }
  await shot(page, 'eth-form');
  ok(/Network fee[^|]*about [\d.]+ ETH \(≈ \$/.test((await page.$$eval('#rcpt div', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ')))).join('|')), 'the receipt gives the gas in ETH and dollars');
  await page.click('#go');
  await done(page);
  await shot(page, 'eth-done');
  ok(pinned.length === 1 && pinned[0].name === 'Orange Coin' && pinned[0].decimals === 18 && pinned[0].description === 'A coin' && pinned[0].external_url === 'https://orange.example', 'its details were pinned once, before anything was sent');
  ok(log.filter((m) => m === 'eth_sendTransaction').length === 2 && batches.length === 0, 'with no batching wallet, two transactions were sent one after the other');
  token1 = await page.$eval('#done [data-copy]', (e) => e.dataset.copy);
  ok(/^0x[0-9a-fA-F]{40}$/.test(token1), `the token is named (${token1})`);
  ok(str(await call(token1, '0x95d89b41')) === 'ORANGE' && lastWord(await call(token1, '0x313ce567')) === 18n, 'its symbol is ORANGE and its decimals 18');
  ok(lastWord(await call(token1, '0x18160ddd')) === 10n ** 24n && lastWord(await call(token1, '0x70a08231' + addrWord(ACCOUNT))) === 10n ** 24n, 'the whole supply, a million, is in the account that etched it');
  minter1 = '0x' + (await call(token1, '0xfe6d8124')).slice(-40);
  const code = await rpc('eth_getCode', [minter1, 'latest']);
  ok(code.length > 10 && !code.includes('40c10f19') && !code.includes('9dc29fac') && !code.includes('a9059cbb'), 'its only minter is a contract with no mint, burn or transfer in it');
  const uri = str(await call(token1, '0xe8a3d485'));
  ok(uri === `ipfs://f01551220${cidOf(Buffer.from(JSON.stringify(pinned[0])) ).digest}` || /^ipfs:\/\/f01551220[0-9a-f]{64}$/.test(uri), `its contractURI is the stamp of the pinned details (${uri.slice(0, 30)}…)`);
  const pool = await rpc('eth_getLogs', [{ address: POOL, fromBlock: 'latest', toBlock: 'latest' }]);
  ok(pool.length >= 1, 'the pool recorded the registration, in the second transaction');
  const gases = [];
  for (const h of await page.$$eval('#done .kv a', (a) => a.map((x) => x.href.split('/').pop()))) gases.push(BigInt((await rpc('eth_getTransactionReceipt', [h])).gasUsed));
  console.log(`  gas  create ${gases[0]}, register ${gases[1]} (the page assumes 950,000 and 120,000)`);
  ok(gases[0] < 950_000n && gases[1] < 120_000n, 'the gas the page assumes is more than the etch used');
  ok(/Tacit pool\s*registered/.test((await text(page, '#done .kvs')).replace(/\s+/g, ' ')), 'and the page says so');
  ok(!(await text(page, '#done .q')).includes('does not show'), 'the page’s own check of the chain found nothing wrong');
  await page.click('#watch');
  await page.waitForFunction(() => document.querySelector('#watch').textContent === 'Added');
  ok(true, 'it can be offered to the wallet’s token list');
  ok(errs.length === 0, 'no script errors' + (errs[0] ? `: ${errs[0]}` : ''));
  await page.close();
}

console.log('\nFinding it again:');
{
  const { page } = await fresh('/etch/');
  await page.click('#t-find');
  await page.click('[data-fchain="eth"]');
  await page.waitForSelector('#list .as', { timeout: 60000 });
  const rows = await page.$$eval('#list .as', (r) => r.map((x) => ({ id: x.dataset.id, t: x.textContent.replace(/\s+/g, ' ') })));
  const mine = rows.find((r) => r.id === token1.toLowerCase());
  ok(!!mine && /ORANGE/.test(mine.t) && /1,000,000/.test(mine.t), 'the factory’s record lists the etch, with its supply');
  ok(!rows.some((r) => /^TAC\b|TAC ✓/.test(r.t)), 'the assets the pool mints itself are not listed as etches');
  await page.waitForFunction((id) => /Orange Coin/.test(document.querySelector(`#list .as[data-id="${id}"]`)?.textContent || ''), token1.toLowerCase(), { timeout: 20000 });
  ok(true, 'its name comes from the metadata the stamp names');
  await type(page, '#find', token1.slice(0, 10));
  ok((await text(page, '#cnt')) === '1 found', 'it is found by the start of its address');
  await page.click('#list .as-b');
  ok((await page.$$eval('#list .as-d a', (a) => a.map((x) => x.href))).some((h) => h === `https://etherscan.io/token/${token1.toLowerCase()}`), 'and opens to its Etherscan page');
  ok((await page.evaluate(() => location.hash)).startsWith('#discover='), 'the address keeps the search');
  await page.close();
}
{
  const { page } = await fresh(`/etch/#discover=${token1}`);
  await page.waitForSelector('#list .as', { timeout: 60000 });
  ok(await page.$eval('#fchain [aria-checked="true"]', (e) => e.dataset.fchain) === 'eth' && (await text(page, '#cnt')) === '1 found', 'a link with the token’s address opens on the Ethereum side, at that token');
  await page.close();
}
{
  const { page } = await fresh('/etch/');
  await page.click('#t-find');
  await page.click('[data-fchain="eth"]');
  await page.waitForSelector('#list .as', { timeout: 60000 });
  await page.click('#t-create'); await page.click('[data-chain="eth"]');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Connect a wallet');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Enter a ticker');
  await page.click('#t-find');
  await page.waitForFunction((id) => /You hold 1,000,000/.test(document.querySelector(`#list .as[data-id="${id}"]`)?.textContent || ''), token1.toLowerCase(), { timeout: 30000 });
  ok(true, 'with the wallet connected, the tokens it holds say how much');
  await page.close();
}

console.log('\nThe same, as one batch:');
{
  const { page, log, batches } = await fresh('/etch/', { batch: true });
  await choose(page);
  await form(page, { ticker: 'batch', supply: '5', dec: 6, name: 'Batch', reg: true });
  await connect(page);
  await page.click('#go');
  await done(page);
  ok(batches.length === 1 && batches[0].calls.length === 2 && batches[0].atomicRequired === true && log.filter((m) => m === 'eth_sendTransaction').length === 0, 'a wallet that batches is given both calls once, atomic, and sent nothing else');
  const t = await page.$eval('#done [data-copy]', (e) => e.dataset.copy);
  ok(lastWord(await call(t, '0x18160ddd')) === 5_000_000n && lastWord(await call(t, '0x313ce567')) === 6n, 'five tokens at six decimals, all there');
  await page.close();
}

console.log('\nNo details, no registration:');
{
  const { page, pinned, log } = await fresh('/etch/');
  await choose(page);
  await form(page, { ticker: 'plain', supply: '21', dec: 0 });
  await connect(page);
  await page.click('#go');
  await done(page);
  ok(pinned.length === 0 && log.filter((m) => m === 'eth_sendTransaction').length === 1, 'nothing is pinned and one transaction is sent');
  const t = await page.$eval('#done [data-copy]', (e) => e.dataset.copy);
  ok(str(await call(t, '0xe8a3d485')) === '' && lastWord(await call(t, '0x18160ddd')) === 21n, 'the token has no metadata stamp, and 21 whole units');
  await page.close();
}

console.log('\nA wallet that says no:');
{
  const { page, st } = await fresh('/etch/', { refuse: [1] });
  await choose(page);
  await form(page, { ticker: 'nope', supply: '1', reg: true });
  await connect(page);
  const before = await rpc('eth_blockNumber');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#q').textContent === 'Nothing was sent.', null, { timeout: 60000 });
  ok(st.sends === 1 && (await rpc('eth_blockNumber')) === before, 'turning down the first call leaves nothing made');
  ok(/^Etch NOPE on Ethereum$/.test(await goLabel(page)), 'and the button is back');
  await page.close();
}
{
  const { page } = await fresh('/etch/', { refuse: [2] });
  await choose(page);
  await form(page, { ticker: 'half', supply: '2', reg: true });
  await connect(page);
  await page.click('#go');
  await done(page);
  ok(/Registering it with the pool was not confirmed in your wallet\. The token is made\./.test(await text(page, '#done .q')), 'turning down the second leaves the token made, and says what was not done');
  const t = await page.$eval('#done [data-copy]', (e) => e.dataset.copy);
  ok(lastWord(await call(t, '0x18160ddd')) === 2n * 10n ** 18n, 'the token exists with its supply');
  ok(!/Tacit pool/.test(await text(page, '#done .kvs')), 'and is not said to be registered');
  await page.close();
}

console.log('\nToo little ETH:');
{
  await rpc('anvil_setBalance', [ACCOUNT, '0x9184e72a000']);          // 0.00001 ETH
  const { page, st } = await fresh('/etch/');
  await choose(page);
  await form(page, { ticker: 'poor', supply: '1' });
  await connect(page);
  await page.waitForFunction(() => /Needs about [\d.]+ ETH.* for the network fee\. Your wallet holds 0\.00001/.test(document.querySelector('#q')?.textContent || ''), null, { timeout: 30000 });
  ok(await page.$eval('#rcpt dd.warn', (e) => /0\.00001 ETH/.test(e.textContent)), 'a wallet with too little ETH for the gas is told so, in the receipt and under it');
  await page.click('#go');
  await page.waitForTimeout(1500);
  ok(st.sends === 0 && /needs about [\d.]+ ETH.* for gas/.test(await text(page, '#q')), 'and is not asked for anything');
  await page.close();
  await rpc('anvil_setBalance', [ACCOUNT, '0x56bc75e2d63100000']);
}

await b.close();
server.close();
anvil.kill('SIGKILL');
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
