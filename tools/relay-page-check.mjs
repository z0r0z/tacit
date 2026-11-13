// Checks the relay page (dapp/relay/) in a real browser with the API's /relay/economics stubbed: the buyback's totals and the commitment, the
// fee table, the costs, the tips and the splitter's shares; then the states with no books yet, an API that fails, and a phone.
// Then what a visitor's wallet can do there, with the API's /confidential/open and /confidential/landed, the chain's reads and a stub
// EIP-6963 wallet answered by the test: the open board lists each job with the fee read from its proof's public values, Send it tries the
// settle with eth_call and then sends it to the pool and reports it landed, and paying for proofs sends PROVE to the prover account or pays
// ETH through zQuoter's swap to zRouter with the prover account as the recipient.
//
//   PLAYWRIGHT=<path to playwright-core> node tools/relay-page-check.mjs   (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { RPC_HOSTS } from '../tests/eth-hosts.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const WEB = 24000 + Math.floor(Math.random() * 2000), ROOT = `http://127.0.0.1:${WEB}`;
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, ROOT).pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(WEB, r));

const day = (date, o = {}) => ({ date, settled: 40, priced: 25, unpriced: 12, proveOnly: 3, gasEth: 0.012, proveIn: 30, buybackEth: 0.0004, splitterSends: 1, feeUsd: { eth: 14, converted: 3, convertible: 17 }, ...o });
const FULL = {
  updatedAt: new Date().toISOString(),
  ledger: {
    since: '2026-10-12T09:00:00.000Z', stale: false, owedEth: 0.0003,
    cfg: { buybackBps: 1000, buybackKeepEth: 0.002, buybackMinSendEth: 0.0002, splitter: '0x' + '5'.repeat(40), buyback: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250' },
    recent: [day('2026-10-14'), day('2026-10-15', { settled: 22, buybackEth: 0.0002 })],
    week: { days: 2, settled: 62, priced: 40, unpriced: 20, proveOnly: 5, gasEth: 0.02, proveIn: 55, buybackEth: 0.0006, splitterSends: 2, feeUsd: { eth: 24, converted: 5, convertible: 29 } },
  },
  chain: {
    head: 26_200_000, wallets: { settle: { address: '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', eth: 0.003 }, relay: { address: '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', eth: 0.001, prove: 4 } },
    buyback: { address: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250', ethHeld: 0.0004, buys: 3, ethSpent: 0.0123, tacBought: 187.4, lastBuyBlock: 26_199_000, complete: true },
    tips: { at: 1, days: 30, wraps: 122, eth: 0.032, byRecipient: [{ to: '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2', eth: 0.031 }, { to: '0x' + '5'.repeat(40), eth: 0.001 }, { to: '0x' + '0'.repeat(40), eth: 0 }], complete: true },
    splitter: { address: '0x' + '5'.repeat(40), ethHeld: 0.0002, shares: [{ to: '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', weight: '63', percent: '63' }, { to: '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', weight: '27', percent: '27' }, { to: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250', weight: '10', percent: '10' }] },
  },
  prices: { ethUsd: 2400, proveUsd: 0.18 },
  sponsorship: { day: '2026-10-15', total: { used: 20, cap: 300 }, classes: { onboard: { used: 3, cap: 12 }, farm: { used: 17, cap: 8 }, wrap: { used: 2, cap: null }, other: { used: 1, cap: 4 } } },
};
// ── the open board: a proof's public values, made as the pool encodes them (word 0 the tuple's offset, `fees` an offset at word 8, `deadline` word 16) ──
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', PROVER = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', PROVE = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29';
const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
function pvOf(fees, deadline = 0) {
  const heads = Array(40).fill(0n);
  heads[7] = 40n * 32n; heads[15] = BigInt(deadline);
  return '0x' + w32(32) + heads.map(w32).join('') + w32(fees.length) + fees.map(([id, v]) => id.slice(2) + w32(v)).join('');
}
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const nowMs = Date.now();
const JOBS = [
  { jobId: 'j-wrap', type: 'wrap', status: 'open', posted: false, publicValues: pvOf([[CETH, 20486n]]), proof: '0x' + 'cd'.repeat(260), memos: ['0x' + 'ee'.repeat(40)], openSince: nowMs - 4 * 60e3, expiresAt: 0, feeUsd: 0.5, feeAsset: 'cETH' },
  { jobId: 'j-unwrap', type: 'unwrap', status: 'open', posted: true, publicValues: pvOf([[TAC, 150000000n]], Math.floor(nowMs / 1000) + 3600), proof: '0x' + 'ab'.repeat(260), memos: [], openSince: nowMs - 30e3, expiresAt: nowMs + 3600e3, feeUsd: null, feeAsset: 'TAC' },
  { jobId: 'j-sending', type: 'swap', status: 'sending', posted: false, publicValues: pvOf([[CETH, 30000n]]), proof: '0x' + 'ab'.repeat(260), memos: ['0x' + 'aa'.repeat(40)], openSince: nowMs - 90 * 60e3, expiresAt: 0, feeUsd: 0.7, feeAsset: 'cETH' },
  { jobId: 'j-free', type: 'farmharvest', status: 'open', posted: false, publicValues: pvOf([]), proof: '0x' + 'ab'.repeat(260), memos: ['0x' + 'bb'.repeat(40)], openSince: nowMs - 2 * 60e3, expiresAt: 0, feeUsd: null, feeAsset: null },
];
const PROVE_BAL = 25n * 10n ** 18n, ETH_BAL = 15n * 10n ** 17n;
// zQuoter's answer is made from the request: one swapV2 through zRouter that takes the ETH asked, pays the prover account and carries the request's
// deadline, so it passes the checks the page runs on a quote (dapp/zrouter-guard.js) before it shows or sends it.
let SWAP_CALL = '';
function makeQuote(data) {
  const q = data.slice(10), wd = (i) => q.slice(i * 64, i * 64 + 64);
  const amount = BigInt('0x' + wd(4)), deadline = BigInt('0x' + wd(6));
  SWAP_CALL = '0x6e0a4f98' + wd(0) + w32(0) + w32(0) + PROVE.slice(2).toLowerCase().padStart(64, '0') + w32(amount) + w32(247500000000000000000n) + w32(deadline);
  return cast('abi-encode', 'f((uint8,uint256,uint256,uint256),bytes,uint256,uint256)', `(1,30,${amount},250000000000000000000)`, SWAP_CALL, '247500000000000000000', String(amount));
}
const events = [], landed = [], quoted = [];
let boardMode = 'jobs';
function rpcAnswer({ id, method, params }) {
  const res = (result) => ({ jsonrpc: '2.0', id, result }), err = (message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'eth_call') {
    const to = String(params[0].to).toLowerCase(), data = String(params[0].data);
    if (to === PROVE.toLowerCase() && data.startsWith('0x70a08231')) return res('0x' + w32(PROVE_BAL));
    if (to === ZQUOTER.toLowerCase()) { quoted.push(data); return res(makeQuote(data)); }
    // A read the page makes for itself is not a trial of a send: the header's rewards dot asks the points distributor and the airdrop about the account once a
    // wallet connects. A trial carries the account that will send.
    if (!params[0].from) return res('0x' + w32(0));
    events.push(['sim', params[0]]);
    return res('0x');
  }
  if (method === 'eth_getBalance') return res('0x' + ETH_BAL.toString(16));
  if (method === 'eth_getTransactionReceipt') return res(events.some((e) => e[0] === 'send' && e[2] === params[0]) ? { status: '0x1', logs: [] } : null);
  if (method === 'eth_chainId') return res('0x1');
  if (method === 'eth_blockNumber') return res('0x1000000');
  return err(`stub: ${method}`);
}

let mode = 'full';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const CORS = { 'access-control-allow-origin': '*' };
await ctx.route('https://api.tacit.finance/confidential/open*', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ pool: POOL, jobs: boardMode === 'jobs' ? JOBS : [] }) }));
await ctx.route('https://api.tacit.finance/confidential/landed', (route) => {
  const b = JSON.parse(route.request().postData() || '{}'); landed.push(b);
  route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true, status: 'settled', txHash: b.txHash }) });
});
// every Ethereum node the page may ask, so a read that is slow here is never answered by a real node instead
for (const host of RPC_HOSTS) await ctx.route(`https://${host}/**`, (route) => {
  const q = JSON.parse(route.request().postData() || '{}');
  route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(Array.isArray(q) ? q.map(rpcAnswer) : rpcAnswer(q)) });
});
await ctx.route('**/walletconnect.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const WC_PROJECT_ID = "test"; export function announceWalletConnect() { return { provider: null, disconnect: async () => {} }; } export function wcSheets() { return { onPair() {}, onAsk() {} }; } export function dialogHost() { return () => ({}); }' }));
// A wallet announced through EIP-6963 that records what it is asked to send.
const ACCOUNT = '0x1111111111111111111111111111111111111111';
await ctx.exposeFunction('__wallet', async (method, params) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
  if (method === 'eth_chainId') return '0x1';
  if (method === 'eth_sendTransaction') { const hash = '0x' + (events.length + 1).toString(16).padStart(64, 'a'); events.push(['send', params[0], hash]); return hash; }
  throw new Error(`the stub wallet does not do ${method}`);
});
await ctx.addInitScript(() => {
  const provider = { request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} };
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'stub-1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
});
await ctx.route('https://api.tacit.finance/relay/economics', (route) => {
  if (mode === 'down') return route.fulfill({ status: 503, headers: CORS, body: 'down' });
  const body = mode === 'empty' ? { updatedAt: new Date().toISOString(), ledger: null, chain: { ...FULL.chain, tips: null, splitter: null, buyback: { ...FULL.chain.buyback, buys: 1, tacBought: 19.93, ethSpent: 0.00123, complete: false } }, prices: null } : FULL;
  route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const text = (s) => page.$eval(s, (e) => e.textContent).catch(() => '');
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/relay-${n}.png`, fullPage: true }); };

try {
  await page.goto(`${ROOT}/relay/`);
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  let t = await text('#p-buyback');
  ok(/187\.4TAC bought/.test(t) && /3 buys for 0\.0123 ETH/.test(t) && /the last 3 hours ago/.test(t), `buyback: what it bought and when (${t.slice(18, 120)})`);
  ok(/10% of the relay’s fee income/.test(t) && /Sent in the last 2 days0\.0006 ETH/.test(t) && /Carried to the next pass0\.0003 ETH/.test(t) && /Waiting in the contract0\.0004 ETH/.test(t), 'buyback: the commitment, what was sent, what is carried, what waits');
  t = await text('#p-fees');
  ok(/\$29in ETH and converted tokens/.test(t) && /Settled for a fee40/.test(t) && /Settled with no fee20/.test(t) && /Proved for the sender to settle5/.test(t) && /Paid in ETH\$24/.test(t), `fees: the week's income and the job counts (${t.slice(0, 110)})`);
  ok(/10-15/.test(t) && /10-14/.test(t) && /Counted from 2026-10-12 09:00 UTC/.test(t), 'fees: the daily table and where the books start');
  const tacNote = await page.$$eval('#p-fees .note', (els) => els.map((e) => e.textContent).find((x) => /paid in TAC/.test(x)) || '');
ok(/Fees paid in TAC are kept, not sold/.test(tacNote) && !/\$/.test(tacNote), 'fees: a fee paid in TAC is said to be kept, with no dollar value put on it');
  t = await text('#p-costs');
  ok(/Network fees to settle0\.02 ETH · \$48/.test(t) && /PROVE put into the prover55 PROVE · \$9\.9/.test(t), `costs: network fees and PROVE, in ETH and dollars (${t.slice(0, 120)})`);
  ok(/Fees pay part of all this; the team funds the rest/.test(t), 'costs: says the team funds the rest');
  ok(/Settles the relay pays for today/.test(t) && /Bridge and cBTC mints3 of 12/.test(t) && /Farm harvests and unbonds17 so far/.test(t) && /Wraps with no tip2 so far/.test(t) && /Other requests with no fee1 of 4/.test(t) && /the sender settles it from their own account/.test(t), `costs: today's sponsored settles against each limit (${t.slice(-330)})`);
  t = await text('#p-tips');
  ok(/122wraps tipped, 0\.032 ETH/.test(t) && /To Ops multisig0\.031 ETH/.test(t) && /Prover account63%/.test(t) && /Settle wallet27%/.test(t) && /TAC buyback10%/.test(t), `tips: the month's tips, where they went and who the splitter pays (${t.slice(0, 130)})`);
  ok(!/To 0x0+…0+/.test(t), 'tips: a recipient that was paid nothing is not listed');
  ok(/^0x6919cb/.test(await page.innerText('#p-buyback .eyebrow a')), 'buyback: the contract link keeps its 0x in lower case');
  ok(/send it to a splitter/.test(await text('#flow-tips')), 'flow: with a splitter set, the tip line names it');
  const all = await page.evaluate(() => document.body.textContent);
  ok(!/0\.003 ETH|0\.001 ETH.*4 PROVE|runway|low on gas|running low/i.test(all) && !/68575b073de49a94e3e3acf6f3a0d6e3b66267c7.*\bETH\b.*held/i.test(all), 'no wallet balance or runway is shown on the public page');
  await shot('full');

  mode = 'empty';
  await page.reload();
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  ok(/goes to the ops multisig/.test(await text('#flow-tips')), 'flow: with no splitter, the tip line says the multisig gets the tips');
  ok(/not reported its books yet/.test(await text('#p-fees')) && /not reported its books yet/.test(await text('#p-costs')), 'no books yet: fees and costs say so instead of showing zeros');
  ok(/19\.93TAC bought/.test(await text('#p-buyback')) && /Still reading the contract/.test(await text('#p-buyback')) && /not set/.test(await text('#p-buyback')), 'no books yet: the buyback still shows what it bought, says it is still reading, and says no commitment is set');

  mode = 'down';
  await page.reload();
  await page.waitForFunction(() => /Could not read the relay/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  ok(true, 'an API that fails is said plainly, on every panel');

  // ── the open board ──
  mode = 'full';
  await page.goto('about:blank');
  await page.goto(`${ROOT}/relay/#open`);
  await page.waitForFunction(() => document.querySelectorAll('#open-list .job').length === 4 && /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  const rows = await page.$$eval('#open-list .job', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(/Making a deposit private/.test(rows[0]) && /0\.00020486 tETH/.test(rows[0]) && /≈ \$0\.50/.test(rows[0]) && /waiting 4 min · no deadline/.test(rows[0]) && /Send it/.test(rows[0]), `board: a wrap, its fee read from its proof as tETH, its age and no deadline (${rows[0]})`);
  ok(/A withdrawal/.test(rows[1]) && /posted/.test(rows[1]) && /1\.5 TAC/.test(rows[1]) && /expires in 60 min/.test(rows[1]), `board: a posted withdrawal paying TAC, with its expiry (${rows[1]})`);
  ok(/being sent/.test(rows[2]) && !(await page.$('#open-list [data-send="j-sending"]')), 'board: a job a relayer is sending offers no button');
  ok(/A farm harvest/.test(rows[3]) && /no fee/.test(rows[3]), 'board: a job whose proof binds no fee says so');
  ok(await page.evaluate(() => { const r = document.querySelector('#open').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }), '/relay/#open brings the board into view');
  const boardNote = await text('#open .note');
  ok(/Anyone can send these/.test(boardNote) && /paid the fee its proof binds/.test(boardNote) && (await page.$eval('#open .note a', (a) => a.href)).endsWith('/docs/OPEN-RELAYER.md'), 'board: says anyone can send them and who is paid, and links how to run a relayer');
  await shot('board');
  events.length = 0;
  await page.click('#open-list [data-send="j-wrap"]');
  await page.waitForFunction(() => /Sent\./.test(document.querySelector('#open-status')?.textContent || ''), null, { timeout: 20000 });
  const want = cast('calldata', 'settle(bytes,bytes,bytes[])', JOBS[0].publicValues, JOBS[0].proof, `[${JOBS[0].memos.join(',')}]`);
  const sim = events.find((e) => e[0] === 'sim'), sentTx = events.find((e) => e[0] === 'send');
  ok(events.map((e) => e[0]).join() === 'sim,send', `Send it: the settle is tried with eth_call before the wallet is asked (${events.map((e) => e[0]).join()})`);
  ok(sim && sim[1].to.toLowerCase() === POOL.toLowerCase() && sim[1].data === want && sim[1].from.toLowerCase() === ACCOUNT, 'Send it: the eth_call is settle(publicValues, proof, memos) to the pool, from the wallet');
  ok(sentTx && sentTx[1].to.toLowerCase() === POOL.toLowerCase() && sentTx[1].data === want && !sentTx[1].value && sentTx[1].from.toLowerCase() === ACCOUNT, 'Send it: the wallet sends the same call to the pool, with no value');
  ok(landed.length === 1 && landed[0].jobId === 'j-wrap' && landed[0].txHash === sentTx[2], `Send it: /confidential/landed is told the job and the hash (${JSON.stringify(landed[0])})`);
  ok(/Its fee, 0\.00020486 tETH, went to 0x1111…1111/.test(await text('#open-status')), `Send it: it says the fee went to the sender (${await text('#open-status')})`);

  // ── paying for proofs ──
  await page.waitForFunction(() => /Balance 25 PROVE/.test(document.querySelector('#pv-bal')?.textContent || ''), null, { timeout: 15000 });
  let pv = await text('#prove');
  ok(/paid in PROVE/.test(pv) && /within a few minutes/.test(pv) && /About 0\.4 PROVE pays for one proof/.test(pv), 'prove: says what PROVE pays for, how soon it is used, and what one proof costs');
  ok(/Prove your own actions with your own PROVE, privately/.test(await text('#prove-self')) && (await page.$eval('#prove-self a', (a) => a.getAttribute('href'))) === '/#prove-self', 'prove: one line points holders to proving their own actions, at /#prove-self');
  await page.click('#pv-max');
  ok((await page.inputValue('#pv-amt')) === '25' && /Pays forabout 62 proofs/.test(await text('#pv-quote')), `prove: Max takes the wallet's PROVE, and it says how many proofs that pays for (${await text('#pv-quote')})`);
  events.length = 0;
  await page.click('#pv-go');
  await page.waitForFunction(() => /Landed\./.test(document.querySelector('#pv-status')?.textContent || ''), null, { timeout: 20000 });
  const tsend = events.find((e) => e[0] === 'send'), tsim = events.find((e) => e[0] === 'sim');
  const wantTransfer = cast('calldata', 'transfer(address,uint256)', PROVER, PROVE_BAL.toString());
  ok(tsim && tsend && events.indexOf(tsim) < events.indexOf(tsend) && tsend[1].to.toLowerCase() === PROVE.toLowerCase() && tsend[1].data === wantTransfer && !tsend[1].value, 'prove: Send PROVE is a transfer of the amount to the prover account, tried first');
  ok(/It reaches the prover within a few minutes/.test(await text('#pv-status')) && (await page.$('#pv-status a[href*="etherscan.io/tx/"]')), 'prove: after sending, the transaction and when it reaches the prover');
  await page.click('[data-pay="eth"]');
  await page.fill('#pv-amt', '0.1');
  await page.waitForFunction(() => /At least/.test(document.querySelector('#pv-quote')?.textContent || ''), null, { timeout: 15000 });
  const q = quoted.at(-1).slice(10), wordAt = (i) => q.slice(i * 64, i * 64 + 64);
  ok(quoted.at(-1).startsWith('0xe7798987') && BigInt('0x' + wordAt(0)) === BigInt(PROVER) && BigInt('0x' + wordAt(1)) === 0n && BigInt('0x' + wordAt(2)) === 0n && BigInt('0x' + wordAt(3)) === BigInt(PROVE) && BigInt('0x' + wordAt(4)) === 10n ** 17n && BigInt('0x' + wordAt(5)) === 100n, 'prove: zQuoter is asked for ETH to PROVE, exact in, 1% slippage, with the prover account as the recipient');
  const qt = await text('#pv-quote');
  ok(/You get about250 PROVE/.test(qt) && /At least247\.5 PROVE · 1% slippage guard/.test(qt) && /about 625 proofs/.test(qt), `prove: the quote shows what it buys and the least it may (${qt})`);
  events.length = 0;
  await page.click('#pv-go');
  await page.waitForFunction(() => /Landed\./.test(document.querySelector('#pv-status')?.textContent || ''), null, { timeout: 20000 });
  const esend = events.find((e) => e[0] === 'send'), esim = events.find((e) => e[0] === 'sim');
  ok(esim && esend && events.indexOf(esim) < events.indexOf(esend) && esend[1].to.toLowerCase() === ZROUTER.toLowerCase() && esend[1].data === SWAP_CALL && BigInt(esend[1].value) === 10n ** 17n && BigInt(esim[1].value) === 10n ** 17n, 'prove: Pay with ETH sends zQuoter\'s call to zRouter with the ETH, tried first');
  const all2 = await page.evaluate(() => document.body.textContent);
  ok(!/runway|low on gas|running low|out of gas|credit left/i.test(all2), 'nothing on the page speaks of the relay\'s balances or runway');
  await shot('prove');

  boardMode = 'empty';
  await page.click('#open-re');
  await page.waitForFunction(() => /Nothing is waiting\./.test(document.querySelector('#open-list')?.textContent || ''), null, { timeout: 15000 });
  ok(true, 'board: an empty board is calm');
  boardMode = 'jobs';

  mode = 'full';
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || '') && document.querySelectorAll('#open-list .job').length === 4, null, { timeout: 15000 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no sideways scroll, with the board and the proofs panel');
  await shot('phone');
  ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
} catch (e) { fails++; console.log('FAIL', e.message.split('\n')[0]); await shot('failure').catch(() => {}); }
finally { await browser.close(); server.close(); }
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
