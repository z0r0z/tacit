#!/usr/bin/env node
// Checks the community ops page (dapp/weld/keeper) in a real browser with the chain, the API and the wallet stubbed:
//   ready    a published proof that builds on the pool's digest shows as ready; submitting it sends exactly
//            attestBitcoinStateProven(publicValues, proof) to the pool and reports it landed
//   spent    a published proof whose prior the pool has moved past is not offered
//   none     no published proof says so
//   refused  the pool's own check rejects the proof (stale digest): nothing is sent, and the page says why in words
//   chain    a wallet that reports a switch to Ethereum without making it: nothing is sent, and the page says to switch
//   race     the minute's refresh runs while a submitted proof is still confirming: the proof lands as landed, not as an error
//   ancestry a reflection more than 2,016 blocks behind: advanceReflectionAncestry() is run first, sent with the node's
//            gas estimate, and a reverted receipt reads as reverted
// Nothing reaches a live service.
//   PLAYWRIGHT=<path to playwright-core> node tools/keeper-check.mjs [scenario,…]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const WEB = 8890 + Math.floor(Math.random() * 90);
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const WALLET = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';
const DIGEST = '0x' + 'aa'.repeat(32);
const NEXT = '0x' + 'bb'.repeat(32);
const PV = '0x' + 'ab'.repeat(1120), PROOF = '0x' + 'cd'.repeat(260);
const want = (process.argv[2] || 'ready,spent,none,refused,chain,race,ancestry').split(',');

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let failed = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${extra ? ` (${extra})` : ''}`); if (!c) failed++; };
const hex = (n) => '0x' + n.toString(16);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

async function run(name, { proof, simulateRevert = null, chain = '0x1', attested = 970100, receipt = '0x1', slowReceipt = 0, clock = false }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const calls = [];
  const st = { digest: DIGEST, polls: 0 };
  // A sent proof moves the pool's digest on, as landing it would.
  await ctx.exposeBinding('__sent', (_src, data) => { if (String(data).startsWith('0x0b36171c')) st.digest = NEXT; });
  await ctx.addInitScript(({ WALLET, chain }) => {
    window.__txs = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [WALLET];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') return null;   // reports the switch; `chain` says whether it happened
        if (method === 'eth_sendTransaction') { window.__txs.push(params[0]); await window.__sent(params[0].data); return '0x' + 'ee'.repeat(32); }
        throw new Error('unstubbed wallet method ' + method);
      },
      on() {}, removeListener() {},
    };
  }, { WALLET, chain });
  const answer = (m, params) => {
    calls.push({ m, params });
    if (m === 'eth_chainId') return '0x1';
    if (m === 'eth_call') {
      const { to, data, from } = params[0];
      if (data === '0xb909cdaf') return st.digest;                    // attestedReflectionDigest()
      if (data === '0x1fd4827a') return word(970100);                 // tipHeight()
      if (data === '0x2755cd2d') return '0x' + '11'.repeat(32);       // tip()
      if (data && data.startsWith('0x0b36171c') && from) {
        if (simulateRevert) throw Object.assign(new Error('execution reverted'), { data: simulateRevert });
        return '0x';
      }
      return '0x';
    }
    if (m === 'eth_estimateGas') return params[0].data === '0xaa9e6609' ? hex(6400000) : hex(524288);   // advanceReflectionAncestry() walks up to 2,016 parents
    if (m === 'eth_getTransactionReceipt') return ++st.polls <= slowReceipt ? null : { status: receipt, transactionHash: params[0], blockNumber: '0x1' };
    if (m === 'eth_blockNumber') return hex(26139000);
    if (m === 'eth_gasPrice') return hex(150000000);
    if (m === 'eth_getBalance') return hex(10n ** 18n);
    return null;
  };
  for (const host of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'cloudflare-eth.com']) {
    await ctx.route(`https://${host}/**`, async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      const one = (b) => { try { return { jsonrpc: '2.0', id: b.id, result: answer(b.method, b.params || []) }; } catch (e) { return { jsonrpc: '2.0', id: b.id, error: { code: 3, message: e.message, data: e.data } }; } };
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
    });
  }
  await ctx.route('https://api.tacit.finance/**', async (route) => {
    const u = new URL(route.request().url());
    const send = (b) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (u.pathname === '/reflection/proof') return send({ ok: true, proof });
    if (u.pathname === '/reflection/status') return send({ network: 'mainnet', attestedHeight: attested, tipHeight: 970100, lagBlocks: 0, confirmations: 24, burnDeposits: 0 });
    return send({});
  });
  for (const host of ['blockstream.info', 'mempool.space', 'mempool.emzy.de', 'mempool.bitaroo.net']) {
    await ctx.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '970124' }));
  }
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  page.on('pageerror', (e) => { console.log('     page error:', e.message); });
  await page.goto(`http://127.0.0.1:${WEB}/weld/keeper/`);
  await page.waitForFunction(() => !/Reading the latest proof/.test(document.querySelector('#proof-box')?.textContent || 'Reading'), null, { timeout: 15000 });
  return { browser, page, calls };
}

const rec = (over = {}) => ({ priorDigest: DIGEST, newDigest: NEXT, attestedTo: 970110, publicValues: PV, proof: PROOF, at: Date.now() - 4 * 60000, ...over });

if (want.includes('ready')) {
  console.log('== ready');
  const { browser, page, calls } = await run('ready', { proof: rec() });
  const box = await page.textContent('#proof-box');
  ok(/A proof is ready/.test(box) && /970,110/.test(box) && /4 min ago/.test(box), 'a published proof on the pool’s digest shows as ready', box.trim().slice(0, 110));
  ok(!(await page.isDisabled('#btn-proof')), 'its button is enabled');
  await page.click('#btn-proof');
  await page.waitForFunction(() => /Landed/.test(document.querySelector('#proof-status')?.textContent || ''), null, { timeout: 15000 });
  const txs = await page.evaluate(() => window.__txs);
  const expected = execFileSync('cast', ['calldata', 'attestBitcoinStateProven(bytes,bytes)', PV, PROOF]).toString().trim();
  ok(txs.length === 1 && txs[0].to.toLowerCase() === POOL.toLowerCase() && txs[0].from.toLowerCase() === WALLET, 'exactly one transaction, from the wallet to the pool');
  ok(txs[0].data.toLowerCase() === expected.toLowerCase(), 'its data is attestBitcoinStateProven(publicValues, proof), byte for byte');
  ok(BigInt(txs[0].gas) === (524288n * 125n) / 100n, 'with gas from the node’s estimate plus a quarter', txs[0].gas);
  ok(calls.some((c) => c.m === 'eth_call' && c.params[0].from && c.params[0].data.startsWith('0x0b36171c')), 'it ran the call against the pool first');
  ok(/Landed/.test(await page.textContent('#proof-status')) && /970,110/.test(await page.textContent('#proof-status')), 'and says which block Bitcoin is attested to');
  await browser.close();
}
if (want.includes('spent')) {
  console.log('== spent');
  const { browser, page } = await run('spent', { proof: rec({ priorDigest: '0x' + '99'.repeat(32) }) });
  ok(/already landed|moved past/.test(await page.textContent('#proof-box')) && await page.isDisabled('#btn-proof'), 'a proof built on a state the pool has left is not offered');
  await browser.close();
}
if (want.includes('none')) {
  console.log('== none');
  const { browser, page } = await run('none', { proof: null });
  ok(/No proof is waiting/.test(await page.textContent('#proof-box')) && await page.isDisabled('#btn-proof'), 'with nothing published the page says so');
  await browser.close();
}
if (want.includes('refused')) {
  console.log('== refused');
  const { browser, page } = await run('refused', { proof: rec(), simulateRevert: '0xe677decb' });
  await page.click('#btn-proof');
  await page.waitForSelector('.toast.bad', { timeout: 15000 });
  const t = await page.textContent('.toast.bad');
  ok(/already moved past this batch/.test(t), 'the pool’s stale-digest rejection reads in words', t.slice(0, 100));
  ok((await page.evaluate(() => window.__txs)).length === 0, 'and no transaction was sent');
  await browser.close();
}
if (want.includes('chain')) {
  console.log('== chain');
  const { browser, page } = await run('chain', { proof: rec(), chain: '0x2105' });
  await page.click('#btn-proof');
  await page.waitForSelector('.toast.bad', { timeout: 15000 });
  const t = await page.textContent('.toast.bad');
  ok((await page.evaluate(() => window.__txs)).length === 0, 'a wallet still on Base after a reported switch sends nothing');
  ok(/Switch your wallet to Ethereum/.test(t), 'and the page says to switch', t.slice(0, 100));
  await browser.close();
}
if (want.includes('race')) {
  console.log('== race');
  const { browser, page } = await run('race', { proof: rec(), slowReceipt: 3, clock: true });
  await page.click('#btn-proof');
  await page.waitForFunction(() => /Sent/.test(document.querySelector('#proof-status')?.textContent || ''), null, { timeout: 15000 });
  await page.clock.fastForward(61000);   // the minute's refresh: the pool's digest has moved, so it clears the ready proof
  await page.waitForFunction(() => /Landed/.test(document.querySelector('#proof-status')?.textContent || '') || document.querySelector('.toast.bad'), null, { timeout: 30000 });
  const bad = await page.$('.toast.bad');
  ok(!bad && /970,110/.test(await page.textContent('#proof-status')), 'a proof that lands during a refresh reads as landed', bad ? await bad.textContent() : '');
  await browser.close();
}
if (want.includes('ancestry')) {
  console.log('== ancestry');
  const { browser, page, calls } = await run('ancestry', { proof: null, attested: 960000, receipt: '0x0' });
  await page.waitForSelector('#ancestry-callout:not([hidden])', { timeout: 15000 });
  ok(/4 calls/.test(await page.textContent('#ancestry-callout')), 'the callout says how many calls the gap takes');
  await page.click('#btn-ancestry');
  await page.waitForSelector('.toast.bad', { timeout: 15000 });
  const txs = await page.evaluate(() => window.__txs);
  ok(txs.length === 1 && txs[0].to.toLowerCase() === POOL.toLowerCase() && txs[0].data === '0xaa9e6609' && txs[0].chainId === '0x1', 'advanceReflectionAncestry() goes to the pool on Ethereum');
  ok(BigInt(txs[0].gas) === (6400000n * 125n) / 100n, 'with gas from the node’s estimate plus a quarter', txs[0].gas);
  ok(calls.some((c) => c.m === 'eth_call' && c.params[0].from && c.params[0].data === '0xaa9e6609'), 'it ran the call first');
  ok(/reverted/.test(await page.textContent('.toast.bad')) && /Reverted/.test(await page.textContent('#anc-status')), 'a reverted receipt reads as reverted');
  await browser.close();
}
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
