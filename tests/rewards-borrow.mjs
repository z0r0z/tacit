#!/usr/bin/env node
// dapp/rewards/: the Borrow card under a result that shows TAC claimed. Ethereum is an anvil fork of mainnet (the airdrop, the distributor and the two vaults are
// the chain's own); the points service is stubbed. An address on the airdrop list is looked up (nothing claimed: no card), its airdrop is claimed through the page
// with a stub wallet (the card appears, sized to the TAC claimed), and the same address looked up again in a fresh page (the card is there from the reading alone).
// The figure must be the vault's own: within what that much TAC backs at the vault's price, line and fee, and the link opens /vault/ with exactly it.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/rewards-borrow.mjs        (SHOTS=dir saves screenshots, FORK=url picks the upstream node)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', SHOTS = process.env.SHOTS || null;
const PORT = 22000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
let server;
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data }); return j.result; };
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });

const LISTED = '0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20', E18 = 10n ** 18n;
const USD = '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9';
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.mevblocker.io', 'eth-mainnet.nodereal.io', '1.rpc.thirdweb.com', 'rpc.flashbots.net', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io'];
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const vaultView = async (v, data) => BigInt(await rpcA('eth_call', [{ to: v, data }, 'latest']));

async function openPage({ wallet = false, viewport = { width: 1000, height: 900 } } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const seen = { quoteJs: 0, vaultReads: 0 };
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    const body = route.request().postData() || '';
    if (/fc7b9c18/.test(body) && /16275096/.test(body)) seen.vaultReads++;                     // totalDebt() and depthCeiling() in one Multicall3 read: the quote
    try { const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() }); }
    catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  await ctx.route(/api\.tacit\.finance\/(points|claim)\/0x/, (route) => (/\/claim\//.test(route.request().url())
    ? json(route, { cumulativeAmount: '0', claimedWei: '0', unclaimedWei: '0', proof: null })
    : json(route, { address: LISTED, points: 0, deposit_count: 0, deposits: [] })));
  await ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => json(route, []));
  await ctx.route(/api\.tacit\.finance\//, (route) => json(route, null));
  if (wallet) {
    // A browser wallet on the listed account: accounts and sends are answered here (the fork sends for the impersonated account), every read goes to the fork.
    await ctx.exposeFunction('__wallet', async (method, params) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [LISTED];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_watchAsset') return null;
      if (method === 'eth_sendTransaction') return rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x3d0900' }]);
      return rpcA(method, params);
    });
    await ctx.addInitScript(() => { window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} }; });
  }
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('request', (rq) => { if (/\/vault\/quote\.js/.test(rq.url())) seen.quoteJs++; });
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  return { browser, page, errors, blocked, seen };
}

// What the card must say for `wei` of TAC: a figure within what that TAC backs at the vault's own price, line and fee (or no figure when the vault cannot lend).
async function checkCard(page, wei, label) {
  await until(page, () => /\d/.test(document.querySelector('#bw')?.textContent || '') || /not open/.test(document.querySelector('#bw')?.textContent || ''), null, 60000).catch(() => {});
  await sleep(300);
  const c = await page.$eval('#bw', (e) => ({ t: e.textContent.replace(/\s+/g, ' ').trim(), go: e.querySelector('.bw-go')?.getAttribute('href') || e.querySelector('a')?.getAttribute('href'), alt: e.querySelector('.bw-alt')?.getAttribute('href') }));
  const m = c.t.match(/^Borrow up to ([\d,.]+) TACD against the TAC you claimed →(?:or ([\d,.]+) TACE)?$/);
  if (!m) { ok(c.go === '/vault/' && /^(Borrowing against TAC is not open right now\. See the vaults →|Borrow TACD or TACE against the TAC you claimed →)$/.test(c.t), `${label}: the dollar vault cannot lend on this fork: the card says so or only links, with no figure (${c.t})`); return; }
  const x = m[1].replace(/,/g, ''), amt = BigInt(Math.round(Number(x) * 100)) * (E18 / 100n);
  const pB = await vaultView(USD, '0x195168b6' + w(E18) + w(1)), mint = await vaultView(USD, '0x347bbf43'), fee = await vaultView(USD, '0xb76b0aa7');
  const own = wei * pB / E18 * 10000n / mint;
  ok(c.go === `/vault/#v=usd&amt=${x}` && (!m[2] || c.alt === `/vault/#v=eth&amt=${m[2].replace(/,/g, '')}`), `${label}: “${c.t}”, linking to ${c.go}${c.alt ? ` and ${c.alt}` : ''}`);
  ok(amt > 0n && amt + amt * fee / 10000n <= own, `${label}: the figure is within what the claimed TAC backs at the vault’s price, line and fee (${x} TACD, limit ${Number(own / 10n ** 16n) / 100})`);
}

try {
  // The listed account, impersonated on the fork (the stub wallet sends for it).
  await rpcA('anvil_impersonateAccount', [LISTED]); await rpcA('anvil_setBalance', [LISTED, '0x' + E18.toString(16)]);
  const tacOf = async (a) => BigInt(await rpcA('eth_call', [{ to: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', data: '0x70a08231' + w(a) }, 'latest']));

  // 1. Looked up before the claim: nothing claimed (the points distributor is the chain's own; if this account has claimed points, the card is there for them).
  let r = await openPage({ wallet: true });
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/rewards/?q=${LISTED}`);
    await until(r.page, () => !!document.querySelector('#c-air .rw .st') && !document.querySelector('#out .sk'), null, 180000);
    const airText = await text(r.page, '#c-air');
    const canClaim = !!(await r.page.$('[data-claim="airdrop"]'));
    await sleep(1500);
    const before = await r.page.$('#bw');
    if (canClaim) {
      const ptsClaimed = BigInt(await rpcA('eth_call', [{ to: DISTRIBUTOR, data: '0xc884ef83' + w(LISTED) }, 'latest']));
      ok(ptsClaimed > 0n ? !!before : !before && r.seen.quoteJs === 0, `before the claim: ${ptsClaimed > 0n ? 'the card is there for the points already claimed' : 'no TAC claimed, no card, and the quote module is not loaded'} (${airText.slice(0, 60)})`);
      // 2. The airdrop claimed through the page.
      const tac0 = await tacOf(LISTED);
      const pick = r.page.waitForSelector('.bsheet .way', { timeout: 8000 }).then(() => r.page.click('.bsheet .way:has-text("Browser wallet")')).catch(() => {});
      await r.page.click('[data-claim="airdrop"]');
      await pick;
      await until(r.page, () => !!document.querySelector('#done .done a[href^="https://etherscan.io/tx/0x"]'), null, 180000);
      const got = (await tacOf(LISTED)) - tac0;
      ok(got > 0n, `the airdrop is claimed through the page (${Number(got / 10n ** 16n) / 100} TAC)`);
      await until(r.page, () => !!document.querySelector('#bw'), null, 60000);
      const total = got + ptsClaimed;
      await checkCard(r.page, total, 'after the claim');
      ok(r.seen.quoteJs === 1, `the quote module is loaded once (${r.seen.quoteJs})`);
      if (SHOTS) await r.page.screenshot({ path: join(SHOTS, 'rewards-borrow-claimed.png'), fullPage: true });
      ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
    } else ok(/Claimed/.test(airText), `the listed account’s airdrop is already claimed on this fork (${airText.slice(0, 60)}): the second lookup checks the card`);
  } finally { await r.browser.close(); }

  // 3. Looked up again, in a fresh page: the card is there from the reading alone, sized to the TAC claimed.
  r = await openPage({ viewport: { width: 390, height: 900 } });
  try {
    await r.page.goto(`http://127.0.0.1:${WEB}/rewards/?q=${LISTED}`);
    await until(r.page, () => /Claimed/.test(document.querySelector('#c-air .st')?.textContent || ''), null, 180000);
    await until(r.page, () => !!document.querySelector('#bw'), null, 60000);
    const air = [(await r.page.$eval('#c-air .cu', (e) => e.dataset.text).catch(() => '')).match(/([\d,.]+)/)].filter(Boolean)[0];          // the figure's final text (it counts up)
    const airWei = air ? BigInt(Math.round(Number(air[1].replace(/,/g, '')) * 100)) * (E18 / 100n) : 0n;
    const pts = BigInt(await rpcA('eth_call', [{ to: DISTRIBUTOR, data: '0xc884ef83' + w(LISTED) }, 'latest']));
    await checkCard(r.page, airWei + pts, 'a lookup that shows the airdrop claimed (phone width)');
    ok(r.seen.vaultReads >= 1 && !(await r.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `one read of the vaults (${r.seen.vaultReads}), and no sideways scroll at 390 px`);
    ok(!!(await r.page.$('.uses a[href="/vault/"]')), 'the line under the bar keeps its Borrow link');
    if (SHOTS) await r.page.screenshot({ path: join(SHOTS, 'rewards-borrow-lookup.png'), fullPage: true });
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  } finally { await r.browser.close(); }

  // 4. A vault that lends (the fork's vaults may wait for price records): the quote module's own limitOf, served with figures of its own in place of its chain read.
  r = await openPage();
  try {
    await r.page.context().route(/\/vault\/quote\.js/, async (route) => {
      const src = readFileSync(join(DAPP, 'vault/quote.js'), 'utf8').replace('export async function quoteBorrow', 'async function quoteChain');
      const f = '{ mint: 30000n, minDebt: 10n * 10n ** 18n, totalDebt: 0n, debtCeiling: 10n ** 24n, depthCeiling: 10n ** 24n, feeBps: 50n, pB: 2n * 10n ** 17n }', g = '{ mint: 30000n, minDebt: 10n ** 30n, totalDebt: 0n, debtCeiling: 10n ** 24n, depthCeiling: 10n ** 24n, feeBps: 50n, pB: 8n * 10n ** 13n }';
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${src}\nexport async function quoteBorrow({ tac }) { window.__bwTac = String(tac); return { usd: limitOf('usd', ${f}, tac), eth: limitOf('eth', ${g}, tac) }; }\n` });
    });
    await r.page.goto(`http://127.0.0.1:${WEB}/rewards/?q=${LISTED}`);
    await until(r.page, () => /can|claimed →/.test(document.querySelector('#bw')?.textContent || '') && /\d/.test(document.querySelector('#bw .bw-go')?.textContent || ''), null, 180000);
    const c = await r.page.$eval('#bw', (e) => ({ t: e.textContent.replace(/\s+/g, ' ').trim(), go: e.querySelector('.bw-go')?.getAttribute('href'), alt: !!e.querySelector('.bw-alt') }));
    const wei = BigInt(await r.page.evaluate(() => window.__bwTac));
    const want = (wei * 2n / 10n / 3n) * 10000n / 10050n / 10n ** 16n, txt = `${want / 100n}.${String(want % 100n).padStart(2, '0')}`;
    ok(c.t === `Borrow up to ${Number(txt).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} TACD against the TAC you claimed →` && c.go === `/vault/#v=usd&amt=${txt.replace(/\.?0+$/, '')}` && !c.alt, `a vault that lends, the other not: “${c.t}” (${c.go}, sized to ${Number(wei / 10n ** 16n) / 100} TAC claimed)`);
    ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  } finally { await r.browser.close(); }
} catch (e) { fails++; console.log('FAIL   ' + (e.stack || e.message)); }
finally { anvil.kill('SIGKILL'); server.close(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} rewards-borrow checks passed`);
process.exit(fails ? 1 : 0);
