#!/usr/bin/env node
// The Precision pool's farm on dapp/trade/tac/, in a real browser under the page's own CSP, against an anvil fork of mainnet: the farm's
// figures and the farming program's stream, a deposit of ETH alone (zapped into the pool and staked in one transaction), of TAC alone
// (by permit), of both at the pool's ratio, what a deposit would earn before it is made, a claim, and a withdrawal of all of it as ETH.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-farm.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', SHOTS = process.env.SHOTS || null;
const PORT = 21000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
let server;
const done = () => { anvil.kill('SIGKILL'); server?.close(); };
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  // As the host does: a directory is served at its address with the slash; without it, or with no file at all, the front page answers and its head script sends the visitor on.
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');            // as the host does: an address with no file of its own is the front page, which sends it on
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const asset = JSON.parse(readFileSync(join(FX, 'tac-asset-2026-10-12.json'), 'utf8')), sales = JSON.parse(readFileSync(join(FX, 'tac-sales-2026-10-12.json'), 'utf8'));
const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
sales.sales = sales.sales.map((x) => ({ ...x, expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) }));
const bids = JSON.parse(readFileSync(join(FX, 'tac-bids-2026-10-12.json'), 'utf8'));              // the 14 standing bids the API listed, their expiry moved forward
bids.intents = bids.intents.map((x) => ({ ...x, expiry: soon }));
const apiBody = (url) => (/preauth-sales/.test(url) ? sales : /bid-intents/.test(url) ? bids : asset);
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co'];

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });

const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
const TACADDR = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', ROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const tacBal = async (a) => BigInt(await rpcA('eth_call', [{ to: TACADDR, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const ethBal = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));

// A wallet in the page: window.ethereum answers as an EIP-1193 provider, signs TAC's permit with a real key and sends through the fork.
async function stubWallet(ctx, { account, key, refuseSends = false, noPermit = false }) {
  const log = { sends: [], signs: 0, signAttempts: 0, connects: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts') { log.connects++; return [account]; }
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') { if (log.onChainId) { const f = log.onChainId; log.onChainId = null; await f(); } return '0x1'; }
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_signTypedData_v4') {
      log.signAttempts++;
      if (noPermit) throw Object.assign(new Error('The method eth_signTypedData_v4 is not supported by this account.'), { code: -32601 });
      log.signs++; return cast('wallet', 'sign', '--private-key', key, '--data', params[1]);
    }
    if (method === 'eth_sendTransaction') {
      if (refuseSends) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      log.sends.push(params[0]);
      const h = await rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x3d0900' }]);
      // A forked anvil can leave a send pending with automine on; a block mined by hand takes it in.
      (async () => { for (let i = 0; i < 40; i++) { await sleep(3000); if (await rpcA('eth_getTransactionReceipt', [h]).catch(() => null)) return; await rpcA('evm_mine', []).catch(() => {}); } })();
      return h;
    }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}
async function fundedWallet(eth, tac, extra = {}) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], who = j.address;
  await rpcA('anvil_setBalance', [who, '0x' + eth.toString(16)]);
  if (tac) {
    const slot = cast('keccak', '0x' + who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2');     // Solady's balance slot
    await rpcA('anvil_setStorageAt', [TACADDR, slot, '0x' + tac.toString(16).padStart(64, '0')]);
  }
  await rpcA('anvil_impersonateAccount', [who]);
  return { account: who, key: j.private_key, ...extra };
}

async function openPage(viewport, wallet = null, hash = '', path = '/trade/') {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const walletLog = wallet ? await stubWallet(ctx, wallet) : null;
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    try {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  await ctx.route(/^https:\/\/api\.tacit\.finance\/farm\/program/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(program) }));
  await ctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(apiBody(route.request().url())) });
  });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}${path}${hash}`);
  return { browser, page, errors, blocked, walletLog };
}

const program = JSON.parse(readFileSync(join(FX, 'farm-program-2026-10-14.json'), 'utf8'));
const FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0', POOLADDR = '0x0155358241411dB868BA714aE7c83A27087e3D6E', E18 = 10n ** 18n;
const staked = async (a) => BigInt(await rpcA('eth_call', [{ to: FARM, data: '0x98807d84' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
let r;
try {
  const me = await fundedWallet(50n * E18, 30000n * E18);
  r = await openPage({ width: 1280, height: 900 }, me, '', '/trade/tac/');
  const p = r.page;
  await until(p, () => /Staked\s*\$/.test(document.querySelector('#fm-stats')?.textContent || '') && /Private farms/.test(document.querySelector('#fm-prog')?.textContent || ''), null, 240000);
  const stats = (await text(p, '#fm-stats')).replace(/\s+/g, ' ');
  ok(/APR now\s*[\d,]+%/.test(stats) && /Rewards\s*[\d,]+ TAC a day/.test(stats) && /Staked\s*\$[\d,]+/.test(stats) && /Stream ends\s*\d+ \w{3} \d{4}/.test(stats), `the farm says its APR, its stream in TAC a day, what is staked and when the stream ends (${stats})`);
  const pf = await p.$$eval('#fm-prog .fm-pf', (a) => a.map((x) => `${x.getAttribute('href')} ${x.textContent.replace(/\s+/g, ' ').trim()}`));
  ok(/1,108 TAC a day more/.test(await text(p, '#fm-prog')) && pf.length === 3 && /^\/#farm\/private-0 tETH \/ TAC\s*554 TAC a day\s*[\d,]+%/.test(pf[0]) && pf.every((x) => /%/.test(x)), `and the program's private farms, each with its stream, its APR and the way to it (${pf.join(' | ')})`);
  const box = await p.$eval('#farm', (e) => { const b = e.getBoundingClientRect(), t = document.querySelector('.p-ticket').getBoundingClientRect(); return { right: b.left > t.left - 5, below: b.top >= t.bottom }; });
  ok(box.right && box.below, `on a wide screen it sits under the ticket (${JSON.stringify(box)})`);
  ok(/Connect wallet/.test(await text(p, '#fm-go')), 'with no wallet its button connects one');
  // The page's first reads (the tape, the boards' paged views) go out to the fork's upstream; a block mined meanwhile waits behind them.
  await until(p, () => !!document.querySelector('#chart .line') && !!document.querySelector('#ladders .ob, #ladders .note'), null, 240000);
  await sleep(5000);

  // a quote before any wallet: what a deposit of ETH alone earns
  await p.fill('#fm-amt', '0.5');
  await until(p, () => /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 120000);
  const q = (await text(p, '#fm-rcpt')).replace(/\s+/g, ' ');
  ok(/Earns about\s*[\d.,]+ TAC a day/.test(q) && /APR\s*[\d,]+%/.test(q) && /[\d.]+% of the farm/.test(q), `0.5 ETH is quoted: TAC a day, APR, share (${q.slice(0, 160)})`);

  await p.click('#fm-go');
  await until(p, () => /Farm with ETH/.test(document.querySelector('#fm-go')?.textContent || '') && /Balance/.test(document.querySelector('#fm-emax')?.textContent || ''), null, 120000);
  ok(true, 'connecting from the farm connects the page\'s wallet and shows the balance');
  await until(p, () => !document.querySelector('#fm-go').disabled, null, 120000);
  // A new amount is typed: the button waits for its quote, so it can never send the amount before it.
  await p.fill('#fm-amt', '0.4');
  ok(await p.$eval('#fm-go', (b) => b.disabled), 'typing a new amount holds the button until that amount is quoted');
  await p.fill('#fm-amt', '1.2.3');
  await until(p, () => /Could not read that amount/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 30000);
  ok(await p.$eval('#fm-go', (b) => b.disabled) && (await p.$eval('#fm-amt', (i) => i.hasAttribute('aria-invalid'))), 'an amount that cannot be read is said and marked, and nothing can be sent');
  // A deposit whose swap costs 30% or more is accepted by typing its figure, not by ticking a box.
  await p.fill('#fm-amt', '20');
  await until(p, () => /Swap price impact/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !!document.querySelector('#fm-ack'), null, 120000);
  const big = await p.evaluate(() => { const a = document.querySelector('#fm-ack'); return { typed: a.type !== 'checkbox', n: (a.getAttribute('aria-label') || '').replace(/\D/g, ''), off: document.querySelector('#fm-go').disabled }; });
  ok(big.typed && Number(big.n) >= 30 && big.off, `a deposit that loses ${big.n}% to the swap asks for the figure to be typed, and waits for it`);
  if (SHOTS) await p.locator('#farm').screenshot({ path: join(SHOTS, 'farm-bigloss.png') });
  await p.fill('#fm-ack', String(Number(big.n) + 1));
  ok(await p.$eval('#fm-go', (b) => b.disabled), 'a wrong figure does not accept it');
  await p.fill('#fm-ack', big.n);
  ok(!(await p.$eval('#fm-go', (b) => b.disabled)), 'the figure typed accepts it');
  // More than the wallet holds is said so, even where the amount is too large for the pool to quote.
  await p.fill('#fm-amt', '999999999');
  await until(p, () => /Not enough ETH/.test(document.querySelector('#fm-rcpt')?.textContent || '') || /refuse/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 120000);
  ok(/Not enough ETH/.test(await text(p, '#fm-rcpt')) && (await p.$eval('#fm-go', (b) => b.disabled)), 'an amount far past the balance says the wallet does not hold it');
  await p.fill('#fm-amt', '0.4');
  await until(p, () => /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled && !document.querySelector('#fm-amt').hasAttribute('aria-invalid'), null, 120000);
  await p.click('#fm-go');
  await until(p, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '') || document.querySelector('#fm-status .err'), null, 240000);
  const s1 = await staked(me.account);
  ok(/Farming\./.test(await text(p, '#fm-status')) && s1 > 0n && r.walletLog.sends.length === 1 && r.walletLog.signs === 0, `ETH alone is zapped and staked in one transaction (${s1} shares, ${r.walletLog.sends.length} sent)`);
  await until(p, () => /Your stake/.test(document.querySelector('#fm-pos')?.textContent || '') && /Add more/.test(document.querySelector('#fm-add-h')?.textContent || ''), null, 120000);
  if (SHOTS) await p.locator('#farm').screenshot({ path: join(SHOTS, 'farm-staked.png') });
  ok(/Earning\s*[\d.,]+ TAC a day/.test((await text(p, '#fm-pos')).replace(/\s+/g, ' ')), 'the stake shows, with what it earns a day');

  // TAC alone, by permit
  await p.click('[data-fm="tac"]');
  await p.fill('#fm-tacamt', '2000');
  if (SHOTS) await p.locator('#farm').screenshot({ path: join(SHOTS, 'farm-quote.png') });
  await until(p, () => /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 120000);
  await p.click('#fm-go');
  await until(p, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '') || document.querySelector('#fm-status .err'), null, 240000);
  const s2 = await staked(me.account);
  ok(s2 > s1 && r.walletLog.signs === 1 && r.walletLog.sends.length === 2, `TAC alone goes in by a signed permit, no approval (${s2 - s1} more shares; ${await text(p, '#fm-status')})`.slice(0, 200));

  // both, at the pool's ratio
  await p.click('[data-fm="pair"]');
  // Max with both: the largest pair the two balances cover, neither side past its balance, so the button is ready
  await p.click('#fm-emax');
  await until(p, () => /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || '') && Number(document.querySelector('#fm-tacamt').value) > 0, null, 120000);
  const tacHeld = Number((await tacBal(me.account)) / 10n ** 16n) / 100, maxTac = Number(await p.inputValue('#fm-tacamt'));
  ok(maxTac <= tacHeld && maxTac > tacHeld * 0.98 && !/Not enough/.test(await text(p, '#fm-rcpt')) && !(await p.$eval('#fm-go', (b) => b.disabled)), `Max with ETH + TAC fills both within the balances and can be pressed (${maxTac} of ${tacHeld} TAC, ${await p.inputValue('#fm-amt')} ETH)`);
  await p.fill('#fm-amt', '0.1');
  await until(p, () => Number(document.querySelector('#fm-tacamt').value) > 0 && Number(document.querySelector('#fm-tacamt').value) < 5000 && /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 120000);
  ok(Number(await p.inputValue('#fm-tacamt')) > 100, `ETH + TAC fills the TAC at the pool's ratio (${await p.inputValue('#fm-tacamt')} TAC for 0.1 ETH)`);
  await p.click('#fm-go');
  await until(p, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '') || document.querySelector('#fm-status .err'), null, 240000);
  const s3 = await staked(me.account);
  ok(s3 > s2, `both go in together (${s3 - s2} more shares; ${(await text(p, '#fm-status')).slice(0, 80)})`);

  // a day later: claim, then withdraw all as ETH
  await rpcA('evm_increaseTime', [86400]); await rpcA('evm_mine', []);
  await p.evaluate(() => document.querySelector('[data-fm="eth"]').click());
  const t0 = await tacBal(me.account);
  await until(p, () => !!document.querySelector('#fm-claim'), null, 60000);
  await p.click('#fm-claim');
  await until(p, () => /Claimed/.test(document.querySelector('#fm-pos-status')?.textContent || '') || document.querySelector('#fm-pos-status .err'), null, 240000);
  const got = (await tacBal(me.account)) - t0;
  ok(got > E18 && /Claimed [\d.,]+ TAC/.test(await text(p, '#fm-pos-status')), `a day's rewards are claimed (${Number(got / 10n ** 16n) / 100} TAC)`);
  await until(p, () => !!document.querySelector('#fm-exit') && !document.querySelector('#fm-claim')?.hasAttribute('aria-busy'), null, 60000);   // the claim has ended and the stake is drawn again
  ok(!(await p.$eval('#fm-wd', (d) => d.open)) && !(await p.$eval('#fm-out-rcpt', (d) => d.textContent)), 'the withdrawal stays closed and unread until it is opened');
  await p.click('#fm-wd > summary');
  await p.click('[data-as="eth"]');
  await until(p, () => document.querySelector('[data-as="eth"]')?.getAttribute('aria-pressed') === 'true', null, 30000);
  await until(p, () => /Withdraw all/.test(document.querySelector('#fm-exit')?.textContent || '') && /You get about\s*[\d.]+ ETH/.test(document.querySelector('#fm-out-rcpt')?.textContent || ''), null, 120000);
  if (await p.$('#fm-out-ack')) {
    ok(await p.$eval('#fm-exit', (b) => b.disabled), 'a withdrawal as one asset with a large swap waits for its box to be ticked (or its figure typed)');
    if (await p.$eval('#fm-out-ack', (i) => i.type === 'checkbox')) await p.check('#fm-out-ack');
    else await p.fill('#fm-out-ack', await p.$eval('#fm-out-ack', (i) => (i.getAttribute('aria-label') || '').replace(/\D/g, '')));
  }
  const e0 = await ethBal(me.account);
  await p.click('#fm-exit');
  await until(p, () => /Withdrawn/.test(document.querySelector('#fm-pos-status')?.textContent || '') || document.querySelector('#fm-pos-status .err'), null, 240000);
  ok((await staked(me.account)) === 0n && (await ethBal(me.account)) > e0, `withdrawing all as ETH leaves nothing staked and pays ETH (${(await text(p, '#fm-pos-status')).slice(0, 60)})`);
  await until(p, () => document.querySelector('#fm-pos').hidden && /Farm TAC\/ETH/.test(document.querySelector('#fm-add-h').textContent), null, 120000);
  ok(true, 'and the stake leaves the panel');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page errors or blocked requests (${[...r.errors, ...r.blocked].slice(0, 3).join(' | ')})`);
  await r.browser.close();


  // the tabs and the button: an amount stays only where it means the same, the button says why it waits, a deposit says what the network takes
  {
    const tw = await fundedWallet(3n * E18, 20000n * E18);
    const t1 = await openPage({ width: 1280, height: 900 }, tw, '', '/trade/tac/'), tp = t1.page;
    await until(tp, () => /TAC a day/.test(document.querySelector('#fm-stats')?.textContent || ''), null, 240000);
    await tp.click('#fm-go');
    await until(tp, () => /Balance/.test(document.querySelector('#fm-emax')?.textContent || ''), null, 120000);
    ok(/^Enter an amount$/.test(await text(tp, '#fm-go')) && (await tp.$eval('#fm-go', (b) => b.disabled)), 'with a wallet and nothing typed the button asks for an amount');
    await tp.fill('#fm-amt', '0.3');
    await until(tp, () => /Network fee/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 120000);
    const fee = (await text(tp, '#fm-rcpt')).replace(/\s+/g, ' ');
    ok(/Network fee(≈ \$\d+\.\d\d|under \$0\.01)/.test(fee) && /gas at [\d.]+ gwei/.test(await tp.$eval('#fm-rcpt .kv b[title*="gas at"]', (b) => b.title)), `a deposit says what the network takes, at the gas price now (${(fee.match(/Network fee[^%]*?\$[\d.]+|Network fee under \$0\.01/) || [''])[0]})`);
    // ETH typed, then the TAC tab: those 0.3 ETH are not a TAC deposit, and do not come back as one under ETH + TAC
    await tp.click('[data-fm="tac"]');
    ok((await tp.inputValue('#fm-amt')) === '' && (await tp.inputValue('#fm-tacamt')) === '' && (await tp.$eval('#fm-rcpt', (e) => e.hidden)), 'another tab does not carry the amount typed in this one');
    await tp.fill('#fm-tacamt', '1000');
    await tp.click('[data-fm="pair"]');
    await until(tp, () => Number(document.querySelector('#fm-amt').value) > 0 && /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || ''), null, 120000);
    ok((await tp.inputValue('#fm-tacamt')) === '1000' && Number(await tp.inputValue('#fm-amt')) < 0.2, `ETH + TAC takes the TAC typed and fills the ETH to match it (${await tp.inputValue('#fm-amt')} ETH for 1000 TAC)`);
    await tp.click('[data-fm="eth"]');
    ok((await tp.inputValue('#fm-tacamt')) === '' && Number(await tp.inputValue('#fm-amt')) > 0, 'and back on ETH the ETH stays and the TAC does not');
    // Enter sends what is quoted
    await until(tp, () => /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 120000);
    await tp.press('#fm-amt', 'Enter');
    await until(tp, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '') || document.querySelector('#fm-status .err'), null, 240000);
    ok(/Farming\./.test(await text(tp, '#fm-status')) && (await staked(tw.account)) > 0n, 'Enter in the amount sends the deposit that is quoted');
    await until(tp, () => /Your stake/.test(document.querySelector('#fm-pos')?.textContent || ''), null, 120000);
    const pos = (await text(tp, '#fm-pos')).replace(/\s+/g, ' ');
    ok(/Worth\s*(about \$[\d,.]+ · )?[\d.]+% of the farm/.test(pos), `the stake says what it is worth and its share of the farm (${pos.slice(0, 150)})`);
    await tp.fill('#fm-amt', '0.1');
    ok((await text(tp, '#fm-status')) === '', 'a new amount clears what was said of the last deposit');
    ok(t1.errors.length === 0 && t1.blocked.length === 0, `no page errors or blocked requests there (${[...t1.errors, ...t1.blocked].slice(0, 3).join(' | ')})`);
    await t1.browser.close();
  }
  // an amount that leaves no ETH for the network fee waits and says so: the wallet is not left to refuse it
  {
    const tiny = await fundedWallet(5n * 10n ** 16n, 0n);
    const t2 = await openPage({ width: 1280, height: 900 }, tiny, '', '/trade/tac/'), tq = t2.page;
    await until(tq, () => /TAC a day/.test(document.querySelector('#fm-stats')?.textContent || ''), null, 240000);
    await tq.click('#fm-go');
    await until(tq, () => /Balance/.test(document.querySelector('#fm-emax')?.textContent || ''), null, 120000);
    await tq.fill('#fm-amt', '0.0499');
    await until(tq, () => /Leave ETH for the network fee/.test(document.querySelector('#fm-go')?.textContent || ''), null, 60000);
    ok(await tq.$eval('#fm-go', (b) => b.disabled), 'an amount that leaves no ETH for the network fee says so and cannot be sent');
    await tq.fill('#fm-amt', '0.04');
    await until(tq, () => /Farm with ETH/.test(document.querySelector('#fm-go')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 120000);
    ok(true, 'and an amount that leaves enough can');
    await t2.browser.close();
  }
  // LP shares held in the wallet are staked by a permit
  {
    const lpw = await fundedWallet(1n * E18, 0n);
    await rpcA('anvil_setStorageAt', [POOLADDR, cast('keccak', '0x' + lpw.account.slice(2).toLowerCase() + '0000000000000000' + '87a211a2'), '0x' + (10n ** 17n).toString(16).padStart(64, '0')]);   // the pool's shares are Solady's too
    const t3 = await openPage({ width: 1280, height: 900 }, lpw, '', '/trade/tac/'), tl = t3.page;
    await until(tl, () => /TAC a day/.test(document.querySelector('#fm-stats')?.textContent || ''), null, 240000);
    await tl.click('#fm-go');
    await until(tl, () => /LP shares not staked/.test(document.querySelector('#fm-pos')?.textContent || '') && !!document.querySelector('#fm-stake'), null, 120000);
    await tl.click('#fm-stake');
    await until(tl, () => /Staked\./.test(document.querySelector('#fm-pos-status')?.textContent || '') || document.querySelector('#fm-pos-status .err'), null, 240000);
    ok(/Staked\./.test(await text(tl, '#fm-pos-status')) && (await staked(lpw.account)) > 0n && t3.walletLog.signs === 1, `shares in the wallet are staked by a signed permit (${(await text(tl, '#fm-pos-status')).slice(0, 40)})`);
    await t3.browser.close();
  }
  // a wallet that cannot sign a permit (a smart-contract account) approves the TAC and farms it
  {
    const sw = await fundedWallet(1n * E18, 5000n * E18, { noPermit: true });
    const t4 = await openPage({ width: 1280, height: 900 }, sw, '', '/trade/tac/'), ts = t4.page;
    await until(ts, () => /TAC a day/.test(document.querySelector('#fm-stats')?.textContent || ''), null, 240000);
    await ts.click('#fm-go');
    await until(ts, () => /Balance/.test(document.querySelector('#fm-tmax')?.textContent || '') || /Balance/.test(document.querySelector('#fm-emax')?.textContent || ''), null, 120000);
    await ts.click('[data-fm="tac"]');
    await ts.fill('#fm-tacamt', '500');
    await until(ts, () => /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 120000);
    await ts.click('#fm-go');
    await until(ts, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '') || document.querySelector('#fm-status .err'), null, 240000);
    ok(/Farming\./.test(await text(ts, '#fm-status')) && t4.walletLog.signAttempts === 1 && t4.walletLog.signs === 0 && t4.walletLog.sends.length === 2 && (await staked(sw.account)) > 0n, `TAC goes in by an approval and a deposit when the wallet cannot sign a permit (${t4.walletLog.sends.length} sent, ${t4.walletLog.signAttempts} permit asked; ${(await text(ts, '#fm-status')).slice(0, 50)})`);
    await t4.browser.close();
  }

  // a wallet with ETH and no TAC: ETH + TAC takes both, so the form says so and offers ETH alone
  const bare = await fundedWallet(1n * E18, 0n);
  const nb = await openPage({ width: 1280, height: 900 }, bare, '', '/trade/tac/');
  await until(nb.page, () => /TAC a day/.test(document.querySelector('#fm-stats')?.textContent || ''), null, 240000);
  await nb.page.click('#fm-go');
  await until(nb.page, () => /Balance/.test(document.querySelector('#fm-emax')?.textContent || ''), null, 120000);
  await nb.page.click('[data-fm="pair"]');
  ok(/hold no TAC/.test(await text(nb.page, '#fm-how')), 'ETH + TAC with no TAC held says so');
  await nb.page.click('#fm-how [data-fm="eth"]');
  ok(await nb.page.$eval('[data-fm="eth"]', (b) => b.getAttribute('aria-pressed') === 'true') && !/hold no TAC/.test(await text(nb.page, '#fm-how')), 'and offers ETH alone, which opens that form');
  await nb.browser.close();

  // a phone: the farm follows the quotes, inside the width
  const ph = await openPage({ width: 390, height: 844 }, null, '', '/trade/tac/');
  await until(ph.page, () => /TAC a day/.test(document.querySelector('#fm-stats')?.textContent || ''), null, 240000);
  ok(await ph.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#farm').getBoundingClientRect().right <= innerWidth + 1), 'at a phone width the farm fits with no sideways scroll');
  await ph.browser.close();
} catch (e) { fails++; console.log('FAIL   ' + String(e.message || e).split('\n').slice(0, 4).join(' / ')); if (r) { console.log('     errors:', r.errors.slice(0, 3), 'blocked:', r.blocked.slice(0, 3)); console.log('     farm:', await r.page.evaluate(() => ['#fm-status', '#fm-rcpt', '#fm-go', '#fm-pos-status', '#fm-out-rcpt', '#fm-exit', '#fm-as'].map((s) => `${s}=${document.querySelector(s)?.disabled ? '[disabled]' : ''}${document.querySelector(s)?.textContent.replace(/\s+/g, ' ').slice(0, 200)}`).join(' | ')).catch(() => '')); } }
done();
console.log(`\n${fails ? `${fails} FAILED, ${n} ok` : `${n} trade-farm checks passed`}`);
process.exit(fails ? 1 : 0);
