#!/usr/bin/env node
// Checks the node jobs on /prove/ (dapp/prove/ops.js: the Relay and Bitcoin tabs, moved there from the community ops page) in a real browser with the chain, the API and the wallet stubbed:
//   ready    a published proof that builds on the pool's digest shows as ready; submitting it sends exactly
//            attestBitcoinStateProven(publicValues, proof) to the pool and reports it landed
//   spent    a published proof whose prior the pool has moved past is not offered
//   none     no published proof says so
//   refused  the pool's own check rejects the proof (stale digest): nothing is sent, and the page says why in words
//   chain    a wallet that reports a switch to Ethereum without making it: nothing is sent, and the page says to switch
//   race     the minute's refresh runs while a submitted proof is still confirming: the proof lands as landed, not as an error
//   ancestry a reflection more than 2,016 blocks behind: advanceReflectionAncestry() is run first, sent with the node's
//            gas estimate, and a reverted receipt reads as reverted
//   wc       no wallet in the browser: WalletConnect is the one on offer (a stand-in for its bundle, tests/wc-fake.mjs); a wallet app
//            pairs, sends the proof with no request to switch networks, and Disconnect puts the page back to asking
//   board    the open board's figures; Send one runs the settle first, then sends exactly settle(publicValues, proof, memos) of the
//            job paying the most to the pool, and reports it landed to the API
//   boardno  a settle the pool refuses in the run first: nothing is sent, and the job is not offered again; an empty board says so
// Nothing reaches a live service.
//   PLAYWRIGHT=<path to playwright-core> node tools/keeper-check.mjs [scenario,…]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { useWcFake } from '../tests/wc-fake.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp');
const WEB = 8890 + Math.floor(Math.random() * 90);
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const WALLET = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20';
const DIGEST = '0x' + 'aa'.repeat(32);
const NEXT = '0x' + 'bb'.repeat(32);
const PV = '0x' + 'ab'.repeat(1120), PROOF = '0x' + 'cd'.repeat(260);
const want = (process.argv[2] || 'ready,spent,none,refused,chain,race,ancestry,wc,board,boardno').split(',');
// A PublicValues encoding with one tETH fee leg of `units` (head word 8 the fees offset), and an open board job carrying it.
const ETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const pvWithFee = (units) => '0x' + [32, ...Array.from({ length: 19 }, (_, i) => (i === 7 ? 19 * 32 : 0)), 1].map((v) => BigInt(v).toString(16).padStart(64, '0')).join('') + ETH_ID + BigInt(units).toString(16).padStart(64, '0');
const boardJob = (id, units) => ({ jobId: '0x' + String(id).repeat(64).slice(0, 64), type: 'transfer', status: 'open', posted: false, publicValues: pvWithFee(units), proof: '0x' + 'cd'.repeat(260), memos: ['0x' + 'ee'.repeat(40)], openSince: Date.now() - 60000, expiresAt: 0, feeUsd: 1 });

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
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

async function run(name, { proof, simulateRevert = null, chain = '0x1', attested = 970100, receipt = '0x1', slowReceipt = 0, clock = false, wc = false, jobs = [], boardRevert = false }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const calls = [], landed = [];
  const st = { digest: DIGEST, polls: 0 };
  // A sent proof moves the pool's digest on, as landing it would.
  await ctx.exposeBinding('__sent', (_src, data) => { if (String(data).startsWith('0x0b36171c')) st.digest = NEXT; });
  const wcAsked = [];
  if (wc) {
    // No wallet in the browser: the wallet app answers through WalletConnect's stand-in.
    await useWcFake(ctx, { account: WALLET });
    await ctx.exposeFunction('__wcRequest', async (method, params) => {
      wcAsked.push({ method, params });
      if (method === 'eth_sendTransaction') { await __sentNode(params[0].data); return '0x' + 'ee'.repeat(32); }
      return undefined;
    });
  }
  const __sentNode = async (data) => { if (String(data).startsWith('0x0b36171c')) st.digest = NEXT; };
  if (!wc) await ctx.addInitScript(({ WALLET, chain }) => {
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
      if (data && data.startsWith('0x717fd7f2') && from && boardRevert && (boardRevert === true || boardRevert(data.toLowerCase()))) throw Object.assign(new Error('execution reverted'), { data: '0x2fb0e3e0' });
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
    if (u.pathname === '/confidential/open') return send({ pool: POOL, jobs });
    if (u.pathname === '/confidential/landed') { landed.push(JSON.parse(route.request().postData() || '{}')); return send({ ok: true, status: 'settled' }); }
    return send({});
  });
  for (const host of ['blockstream.info', 'mempool.space', 'mempool.emzy.de', 'mempool.bitaroo.net']) {
    await ctx.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '970124' }));
  }
  const page = await ctx.newPage();
  // The public Nostr relays are the outside world: a page under test must never post its stand-in jobs to them or read other people's, so
  // each is an empty relay (it ends every read at once and takes every post).
  await page.routeWebSocket(/^wss:\/\//, (ws) => ws.onMessage((m) => {
    let d; try { d = JSON.parse(String(m)); } catch { return; }
    if (d[0] === 'REQ') ws.send(JSON.stringify(['EOSE', d[1]]));
    else if (d[0] === 'EVENT') ws.send(JSON.stringify(['OK', d[1]?.id, true, '']));
  }));
  if (clock) await page.clock.install();
  page.on('pageerror', (e) => { console.log('     page error:', e.message); });
  await page.goto(`http://127.0.0.1:${WEB}/prove/#tab=${name.startsWith('board') ? 'relay' : 'bitcoin'}`);
  await page.waitForFunction(() => !/Reading the latest proof/.test(document.querySelector('#proof-box')?.textContent || 'Reading'), null, { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#board-box .sk'), null, { timeout: 15000 });
  return { browser, page, calls, wcAsked, landed };
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
if (want.includes('wc')) {
  console.log('== wc');
  const { browser, page, wcAsked } = await run('wc', { proof: rec(), wc: true });
  ok(/Connect/.test(await page.textContent('#wallet-label')), 'with no wallet in the browser the chip asks to connect');
  await page.click('#wallet');
  await page.waitForSelector('#sheet-wc[open] .wc-qr svg', { timeout: 15000 });
  ok(/Connect a wallet app/.test(await page.textContent('#wc-h')), 'it opens WalletConnect’s pairing sheet');
  await page.evaluate(() => window.__wcfake.approve());
  await page.waitForFunction((w) => document.querySelector('#wallet-label')?.textContent === w, `${WALLET.slice(0, 6)}…${WALLET.slice(-4)}`, { timeout: 15000 });
  ok(!(await page.$('#sheet-wc[open]')), 'the wallet app connects and the sheet goes');
  await page.click('#btn-proof');
  await page.waitForFunction(() => /Landed/.test(document.querySelector('#proof-status')?.textContent || ''), null, { timeout: 15000 });
  const sent = wcAsked.filter((r) => r.method === 'eth_sendTransaction');
  ok(sent.length === 1 && sent[0].params[0].to.toLowerCase() === POOL.toLowerCase() && sent[0].params[0].from.toLowerCase() === WALLET, 'the proof goes to the pool from the wallet app’s account');
  ok(!wcAsked.some((r) => r.method === 'wallet_switchEthereumChain'), 'the wallet app on Ethereum is not asked to switch to it');
  await page.click('#wallet');
  await page.waitForSelector('#sheet-wc[open] [data-off]');
  ok(/WalletConnect · Test Phone Wallet/.test(await page.textContent('#wc-body')), 'the chip opens the account sheet, naming the wallet app');
  await page.click('#sheet-wc [data-off]');
  await page.waitForFunction(() => /Connect/.test(document.querySelector('#wallet-label')?.textContent || '') && !/0x/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 15000 });
  ok((await page.evaluate(() => window.__wcfake.disconnected)) === 1, 'Disconnect ends the session and puts the page back to asking for a wallet');
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
if (want.includes('board')) {
  console.log('== board');
  const jobs = [boardJob('1', 41000), boardJob('2', 200000)];                     // 0.00041 and 0.002 ETH
  const { browser, page, calls, landed } = await run('board', { proof: null, jobs });
  const box = await page.textContent('#board-box');
  ok(/2 settles waiting · 0\.0024 ETH in fees · network fee <0\.0001 ETH each/.test(box), 'the board in figures', box.trim());
  ok(!(await page.isDisabled('#btn-board')) && (await page.textContent('#btn-board')) === 'Send one', 'Send one is offered');
  await page.click('#btn-board');
  await page.waitForFunction(() => /Landed/.test(document.querySelector('#board-status')?.textContent || ''), null, { timeout: 15000 });
  const txs = await page.evaluate(() => window.__txs);
  const j = jobs[1];
  const expected = execFileSync('cast', ['calldata', 'settle(bytes,bytes,bytes[])', j.publicValues, j.proof, `[${j.memos.join(',')}]`]).toString().trim();
  ok(txs.length === 1 && txs[0].to.toLowerCase() === POOL.toLowerCase() && txs[0].from.toLowerCase() === WALLET, 'one transaction, from the wallet to the pool');
  ok(txs[0].data.toLowerCase() === expected.toLowerCase(), 'its data is settle(publicValues, proof, memos) of the job paying the most, byte for byte');
  ok(BigInt(txs[0].gas) === (524288n * 125n) / 100n, 'with gas from the node’s estimate plus a quarter', txs[0].gas);
  ok(calls.some((c) => c.m === 'eth_call' && c.params[0].from && c.params[0].data.startsWith('0x717fd7f2')), 'it ran the settle against the pool first');
  ok(landed.length === 1 && landed[0].jobId === j.jobId && landed[0].txHash === '0x' + 'ee'.repeat(32), 'and told the API it landed');
  ok(/0\.0020 ETH went to 0x1c0a…5a20/.test(await page.textContent('#board-status')), 'the status says what the wallet was paid', (await page.textContent('#board-status')).trim());
  await browser.close();
}
if (want.includes('boardno')) {
  console.log('== boardno');
  // The board is read through the pool: a settle it would refuse (sent already, or no longer valid) is not listed, so nothing waits and nothing is offered.
  const { browser, page, landed } = await run('boardno', { proof: null, jobs: [boardJob('3', 200000)], boardRevert: true });
  ok(/Nothing waiting/.test(await page.textContent('#board-box')) && await page.isDisabled('#btn-board') && (await page.textContent('#btn-board')) === 'Nothing to send', 'a settle the pool would refuse is left off the board', (await page.textContent('#board-box')).trim());
  ok((await page.evaluate(() => window.__txs)).length === 0 && landed.length === 0, 'and nothing was sent');
  await browser.close();
  // One refused and one taken: only the taken one is counted, offered and sent.
  const dead = pvWithFee(200000).slice(2).toLowerCase();
  const mixed = [boardJob('4', 41000), boardJob('5', 200000)];
  const m = await run('boardmix', { proof: null, jobs: mixed, boardRevert: (data) => data.includes(dead) });
  const mbox = await m.page.textContent('#board-box');
  ok(/1 settle waiting · 0\.00041 ETH in fees/.test(mbox), 'of two settles the pool takes one: one waits, with its fee', mbox.trim());
  await m.page.click('#btn-board');
  await m.page.waitForFunction(() => /Landed/.test(document.querySelector('#board-status')?.textContent || ''), null, { timeout: 15000 });
  const mtx = await m.page.evaluate(() => window.__txs);
  const mj = mixed[0];
  const mexpected = execFileSync('cast', ['calldata', 'settle(bytes,bytes,bytes[])', mj.publicValues, mj.proof, `[${mj.memos.join(',')}]`]).toString().trim();
  ok(mtx.length === 1 && mtx[0].data.toLowerCase() === mexpected.toLowerCase() && m.landed.length === 1 && m.landed[0].jobId === mj.jobId, 'and it is the one that is sent');
  await m.browser.close();
  const empty = await run('boardno-empty', { proof: null, jobs: [] });
  ok(/Nothing waiting/.test(await empty.page.textContent('#board-box')) && await empty.page.isDisabled('#btn-board'), 'an empty board says so');
  await empty.browser.close();
}
server.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
