#!/usr/bin/env node
// dapp/cbtc/ in a real browser, under the page's own CSP: what backs cBTC (the locks, the bond, what was minted, what was lent), the engine's
// price and loan lines, the private pools that hold it with their prices and farms, the ticket that sizes a bond for an amount, and, for a Tacit key
// opened from a stub Ethereum wallet's real signature, that key's locks, private cBTC and loans. The API's answers are fixtures captured on
// 2026-10-14/15, the chain's reads (Multicall3 carrying the engine, the pool and the feeds) are answered here, and the pool module and the key's
// Bitcoin history are stand-ins that record what they are asked: both are tested on their own elsewhere.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-cbtc.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const WEB = 24100 + Math.floor(Math.random() * 800);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const json = (n) => JSON.parse(readFileSync(join(FX, n), 'utf8'));
const stats = json('cbtc-stats-2026-10-15.json'), program = json('teth-program-2026-10-14.json'), engineLogs = json('cbtc-engine-logs-2026-10-15.json');
const nowS = () => Math.floor(Date.now() / 1000);
const BTC_USD = 81500, ETH_USD = 2441, WST = 1.2, PER_ETH = 11000, RATIO = 15000, LIQ = 13000;
const CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8', CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', CUSD = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d';

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout });
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// ── the chain: Multicall3 carrying the engine, the pool and the feeds ──
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
function aggregate3Result(datas) {
  const tuples = datas.map((d) => { const h = d ? d.replace(/^0x/, '') : ''; return w32(d ? 1 : 0) + w32(64) + w32(h.length / 2) + pad(h); });
  let off = datas.length * 32, offs = '';
  for (const t of tuples) { offs += w32(off); off += t.length / 2; }
  return '0x' + w32(32) + w32(datas.length) + offs + tuples.join('');
}
// aggregate3((address,bool,bytes)[]) calldata → [{ to, data }]
function decodeAggregate3(hex) {
  const h = hex.replace(/^0x/, '').slice(8), word = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64)), count = Number(word(1)), out = [];
  for (let i = 0; i < count; i++) {
    const start = 2 + Number(word(2 + i)) / 32, to = '0x' + h.slice(start * 64 + 24, start * 64 + 64), len = Number(word(start + 3));
    out.push({ to: to.toLowerCase(), data: '0x' + h.slice((start + 4) * 64, (start + 4) * 64 + len * 2) });
  }
  return out;
}
const round = (answer) => '0x' + w32(1) + w32(BigInt(Math.round(answer * 1e8))) + w32(nowS()) + w32(nowS()) + w32(1);
const hexBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const poolId = (a, b, fee) => { const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a], u = new Uint8Array(96); u.set(hexBytes(lo), 0); u.set(hexBytes(hi), 32); u.set(hexBytes(w32(fee)), 64); return Buffer.from(keccak_256(u)).toString('hex'); };
// the pools the chain has (the live ones on 2026-10-14): [assetA, assetB, reserveA, reserveB, lpTotal] at the 30 bp tier, A the lower id
const POOLS = new Map([[poolId(CBTC, CETH, 30), [CETH, CBTC, 63593972n, 730828n, 6810283n]], [poolId(CBTC, TAC, 30), [CBTC, TAC, 2n, 762494n, 1000n]]]);
const seenOps = new Map();                                                                     // outpoint → what the pool says of it, in the order they are first asked about: 20 live locks of equal size and one spent on Bitcoin (the pool keeps its sats on record)
const lockOf = (op) => { if (!seenOps.has(op)) { const k = seenOps.size; seenOps.set(op, { sats: 569540n, spent: k >= 20, minted: k !== 19, bond: k >= 20 ? 800000000000000n : 240000000000000000n }); } return seenOps.get(op); };
const chain = { lockStates: new Map(), engine: true, logs: true };                                 // lockStates: outpoint word → { recorded, bonded, minted }
const SEL = { latest: '0xfeaf968c', sqrt: '0x2af1f249', ratio: '0x4827ecb3', liq: '0x1432d93f', usd: '0xd5901347', wstForBtc: '0x7dd55c2b', perWst: '0xbb2952fc', req: '0x034448ed', pools: '0xb5217bb4',
  lockV: '0x7cea1c1a', escrowOk: '0x058e18b0', minted: '0xe2c2a40c', spent: '0x993ed045', redeemed: '0xb5229671', escrowTotal: '0xe06e89c9' };
function answerCall({ to, data }) {
  const sel = data.slice(0, 10), arg = (i) => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));
  if (sel === SEL.latest) return round(to === '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' ? ETH_USD : BTC_USD);
  if (sel === SEL.sqrt) return '0x' + w32(BigInt(Math.round(Math.sqrt(PER_ETH) * 1e6)) * 10n ** 12n);
  if (to === '0x000000003f608bddf0ca45934003ffb9dbdf70db' && !chain.engine) return null;
  if (sel === SEL.ratio) return '0x' + w32(RATIO);
  if (sel === SEL.liq) return '0x' + w32(LIQ);
  if (sel === SEL.usd) return '0x' + w32(BigInt(Math.round(BTC_USD * 1e8)) * arg(0) / 10n ** 8n);
  if (sel === SEL.wstForBtc) return '0x' + w32(BigInt(Math.round(BTC_USD / ETH_USD / WST * 1e12)) * 10n ** 6n * arg(0) / 10n ** 8n);
  if (sel === SEL.perWst) return '0x' + w32(BigInt(Math.round(WST * 1e9)) * arg(0) / 10n ** 9n);
  if (sel === SEL.req) return '0x' + w32(BigInt(Math.round(BTC_USD / ETH_USD / WST * 1.5 * 1e9)) * 10n ** 9n * arg(0) / 10n ** 8n);                    // 1.5x, in wstETH wei, for `arg` sats
  if (sel === SEL.pools) {
    const p = POOLS.get(data.slice(10, 74));
    return p ? '0x' + [1n, 0n, 0n, p[2], p[3], 30n, p[4]].map(w32).join('') : '0x' + '0'.repeat(64 * 7);
  }
  if (sel === SEL.spent || sel === SEL.redeemed) return '0x' + w32(sel === SEL.spent && lockOf(data.slice(10, 74)).spent && !chain.lockStates.has(data.slice(10, 74)) ? 1n : 0n);
  if (sel === SEL.escrowTotal) return '0x' + w32(lockOf(data.slice(10, 74)).bond);
  if ([SEL.lockV, SEL.escrowOk, SEL.minted].includes(sel)) {
    const op = data.slice(10, 74), s = chain.lockStates.get(op) || { recorded: true, bonded: true, minted: lockOf(op).minted, sats: lockOf(op).sats };
    return '0x' + w32(sel === SEL.lockV ? (s.recorded ? s.sats : 0n) : sel === SEL.escrowOk ? (s.bonded ? 1n : 0n) : (s.minted ? 1n : 0n));
  }
  return null;
}
function rpcAnswer(req) {
  const { id, method, params } = req, res = (result) => ({ jsonrpc: '2.0', id, result }), err = (message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'eth_call') {
    if (String(params[0].to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return res(aggregate3Result(decodeAggregate3(params[0].data).map(answerCall)));
    return err('stub: eth_call', 3);
  }
  if (method === 'eth_getBalance') return res('0x' + (5n * 10n ** 18n).toString(16));
  if (method === 'eth_getTransactionReceipt') return res(params[0] === SENT ? { status: '0x1', transactionHash: SENT, blockNumber: '0x1', logs: [] } : null);
  if (method === 'eth_getLogs') return chain.logs && String(params[0].address).toLowerCase() === '0x000000003f608bddf0ca45934003ffb9dbdf70db' ? res(engineLogs) : err('stub: no logs');
  return err(`stub: ${method}`);
}

// ── the wallet that signs for real (the key opens from its signature) ──
// the hash the stub wallet answers with once a test lets it send, and the chain's receipt for it
const SENT = '0x' + 'aa'.repeat(32);
let walletAccepts = false;
async function stubWallet(ctx) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], account = j.address, log = { account, signs: 0, sends: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') { log.signs++; return cast('wallet', 'sign', '--private-key', j.private_key, params[0]); }
    if (method === 'eth_sendTransaction') { log.sends++; log.lastSend = params[0]; if (walletAccepts) return SENT; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => {
    const provider = { request: ({ method, params }) => window.__wallet(method, params).catch((e) => { throw Object.assign(new Error(String(e?.message || e).replace(/^.*Error: /, '')), { code: /rejected/i.test(String(e?.message)) ? 4001 : undefined }); }), on(ev, f) { ((window.__wl ||= {})[ev] ||= []).push(f); }, removeListener() {} };
    window.__walletEmit = (ev, ...a) => ((window.__wl || {})[ev] || []).forEach((f) => f(...a));              // the wallet moves to another account
    const detail = Object.freeze({ info: Object.freeze({ uuid: 'stub-1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });
  return log;
}
// ── the pool module and the key's Bitcoin history, as stand-ins that record what they are asked ──
// the key's deposit address and what it holds, as the explorer answers; and the lock maker, a stand-in that records the lock it is asked for
const DEPOSIT = { utxos: [{ txid: '77'.repeat(32), vout: 0, value: 60000, status: { confirmed: true } }, { txid: '78'.repeat(32), vout: 1, value: 5000, status: { confirmed: false } }] };
const LOCK_STUB = `
export function makeCbtcLockMint(o) {
  const ux = (window.__ux ||= { calls: [], cfg: {} });
  return {
    wallet: { address: () => 'bc1qdeposit0000000000000000000000000000000' },
    async lock(a) {
      ux.calls.push(['lock', String(a.amountSats), (o.excludeOutpoints || []).join()]);
      return { lockTxid: '9a'.repeat(32), lockVout: 7, vBtc: a.amountSats, anchor: { txid: '77'.repeat(32), vout: 0 } };
    },
  };
}`;
const UX_STUB = `
const ux = (window.__ux ||= { calls: [], cfg: {} });
export function setExternalTacHolders() {}
export function forgetKeys() { ux.forgot = (ux.forgot || 0) + 1; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function makeConfidentialPoolUx() {
  return {
    pool: { outpointKey: (txid, vout) => '0x' + '00'.repeat(31) + vout.toString(16).padStart(2, '0'), CBTC_ZK_ASSET_ID: '0xcb' },
    async syncCbtcLockReservations() { ux.calls.push(['syncCbtcLockReservations']); },
    async cbtcLockState(txid, vout) { ux.calls.push(['cbtcLockState', vout]); return ux.cfg.states?.[vout] || { spent: false, redeemed: false }; },
    async ethCall(to, data) {
      const w = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0'), s = data.slice(2, 10);
      ux.calls.push(['ethCall', s]);
      if (s === '034448ed') return w(10n ** 15n);                                                   // requiredEscrow: 0.001 wstETH
      if (s === 'e06e89c9') return w(ux.cfg.bondHave || 0);                                         // escrowTotal
      if (s === 'bb2952fc') return w(BigInt('0x' + data.slice(10)) * 117n / 100n);                  // stEthPerWst: 1.17
      return w(0);
    },
    async mintCbtc(a) { ux.calls.push(['mintCbtc', a.outpoint, String(a.vBtc), a.blinding, typeof a.waitOpts?.onJob]); a.waitOpts?.onJob?.('mint-1'); if (ux.cfg.mintFail) throw new Error(ux.cfg.mintFail); return { jobId: 'mint-1', txHash: '0x' + 'cc'.repeat(32) }; },
    async recoverCdpPositions(a) { ux.calls.push(['recoverCdpPositions', a.walletPriv.length]); if (ux.cfg.loansFail) throw new Error('cdp read failed'); return { positions: ux.cfg.loans || [] }; },
    async balance(priv, o) {
      ux.calls.push(['balance', priv.length, JSON.stringify(o)]); await wait(ux.cfg.balanceMs || 0);
      const g = (id, v) => (v ? { [id]: { asset: id, value: BigInt(v), notes: [{ value: String(v) }] } } : {});
      return { byAsset: { ...g(${JSON.stringify(CBTC)}, ux.cfg.cbtc), ...g(${JSON.stringify(CUSD)}, ux.cfg.cusd) }, notes: [], diag: { errors: {} }, farmPositions: ux.cfg.positions || [] };
    },
  };
}`;
const HIST_STUB = `
export function makeBtcHistoryProvider(o) { return { locks: async (priv) => { (window.__ux ||= { calls: [], cfg: {} }).calls.push(['locks', priv.length, o.hrp]); if (window.__ux.cfg.locksFail) throw new Error('esplora is down'); return window.__ux.cfg.locks || []; } }; }`;

async function openPage(viewport, { wallet = false, scheme = 'light', hash = '' } = {}) {
  const browser = await chromium.launch(), ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const log = wallet ? await stubWallet(ctx) : null;
  const ok200 = (body) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co']) await ctx.route(`https://${h}/**`, (r) => { const q = JSON.parse(r.request().postData() || '{}'); return r.fulfill(ok200(Array.isArray(q) ? q.map(rpcAnswer) : rpcAnswer(q))); });
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/stats') return r.fulfill(chain.stats === 'down' ? { status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' } : ok200(stats));
    if (u.pathname === '/farm/program') return r.fulfill(ok200(program));
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await ctx.route('**/confidential-pool-ux.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: UX_STUB }));
  await ctx.route(/\/cbtc-lock-mint\.js(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: LOCK_STUB }));
  await ctx.route(/^https:\/\/(mempool\.space|blockstream\.info)\/api\//, (r) => {
    const u = new URL(r.request().url()), ok200 = (b) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (/\/address\/bc1qdeposit[a-z0-9]*\/utxo$/.test(u.pathname)) return ok200(DEPOSIT.utxos);
    if (u.pathname.endsWith('/v1/fees/recommended')) return ok200({ fastestFee: 3, halfHourFee: 2, hourFee: 1 });
    if (/\/tx\/[0-9a-f]{64}\/status$/.test(u.pathname)) return ok200({ confirmed: true, block_height: 970000 });
    return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  await ctx.route('**/confidential-recovery-btc.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: HIST_STUB }));
  await ctx.route('**/walletconnect.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const WC_PROJECT_ID = "test"; export function announceWalletConnect() { return { provider: null, disconnect: async () => {} }; } export function wcSheets() { return { onPair() {}, onAsk() {} }; } export function dialogHost() { return () => ({}); }' }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource/.test(t)) errors.push(t.slice(0, 200)); } });
  await page.goto(`http://127.0.0.1:${WEB}/cbtc/${hash}`);
  await page.waitForSelector('#wallet-chip');
  return { browser, page, errors, blocked, log };
}
const cfg = (page, o) => page.evaluate((x) => { (window.__ux ||= { calls: [], cfg: {} }); Object.assign(window.__ux.cfg, x); }, o);
const ux = (page) => page.evaluate(() => window.__ux);
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

const T = { locked: 11390800n, minted: 11312800n, bond: 4979121383955830640n, out: 444386815650n };
let r, p;
try {
  // ── the page on its own: what backs cBTC, the pools, the farms ──
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$') && document.querySelectorAll('#lanes .lane').length === 3 && document.querySelectorAll('.pf').length === 1 && document.querySelector('#cov .cov-row:nth-child(2)') && document.querySelector('#chart .line') && /0\.113908 BTC/.test(document.querySelector('#px-sub').textContent));
  ok((await text(p, '#px-usd')) === `$${BTC_USD.toLocaleString('en-US')}` && (await p.title()) === `cBTC $${BTC_USD.toLocaleString('en-US')} · tacit`, `the headline is the engine's price of bitcoin (${await text(p, '#px-usd')})`);
  const sub = await text(p, '#px-sub');
  ok(/1 cBTC = 1 BTC/.test(sub) && /0\.113908 BTC \(\$[\d.,]+k?\) locked/.test(sub) && /20 locks · 13 loans open/.test(sub), `the line under it: the BTC locked (the figure the stats and the per-lock reads agree on), how many locks and loans (${sub})`);
  await p.evaluate(() => { document.querySelector('#hints').open = true; });                   // the lanes sit in a closed dropdown, whose text is not drawn
  const heads = await p.$$eval('#fm-h, #i-h, #lanes .lane .k', (els) => els.map((e) => e.innerText));
  await p.evaluate(() => { document.querySelector('#hints').open = false; });
  ok(heads.some((h) => /cBTC/.test(h)) && !heads.some((h) => /CBTC|TETH|CUSD/.test(h)), `the label capitals leave the tokens' own spelling alone (${heads.join(' | ').replace(/\n/g, ' ')})`);
  const assets = await p.$$eval('.assets a', (a) => a.map((x) => `${x.textContent.trim()}:${x.getAttribute('href')}:${x.getAttribute('aria-current') || ''}`));
  ok(assets.join() === 'TAC:/trade/tac/:,tETH:/teth/:,cBTC:/cbtc/:page', `the switch names the three markets and marks this one (${assets.join(' ')})`);
  const rows = await p.$$eval('#cov .cov-row', (rs) => rs.map((x) => ({ h: x.querySelector('.cov-h').textContent.replace(/\s+/g, ' ').trim(), s: x.querySelector('.cov-s').textContent.replace(/\s+/g, ' ').trim(), bar: x.querySelector('.cov-bar i')?.style.width || null, tick: x.querySelector('.cov-bar u')?.style.left || null })));
  ok(rows.length === 4 && /Bitcoin locked/.test(rows[0].h) && /0\.113908 BTC/.test(rows[0].h), `the locks: the sats locked (${rows[0].h})`);
  const liveBond = 20 * 0.24, bondUsd = liveBond * WST * ETH_USD, lockUsd = Number(T.locked) / 1e8 * BTC_USD, cover = Math.round(bondUsd / lockUsd * 100);
  ok(rows[1].h.includes(`${cover}% of locked BTC`) && /4\.8 wstETH/.test(rows[1].s) && /20 bonds/.test(rows[1].s) && rows[1].tick, `the bond of the LIVE locks covers them ${cover}% with the 1.5× line marked, a spent lock's bond left out (${rows[1].h})`);
  ok(/0\.108213 of 0\.113908/.test(rows[2].h) && /19 of 20 live locks minted/.test(rows[2].s) && /0\.00019 BTC/.test(rows[2].s), `what is minted of the live locks only (19 of 20), and the public tacBTC (${rows[2].h} · ${rows[2].s.slice(0, 80)})`);
  ok(/4,444 out/.test(rows[3].h) && /13 open loans/.test(rows[3].s) && /4,486 borrowed · 41\.89 repaid · 0 liquidated/.test(rows[3].s) && /150% to borrow, liquidated under 130%/.test(rows[3].s), `the loans, with the engine's own lines (${rows[3].s.slice(0, 120)})`);
  const tethPerCbtc = 63593972 / 730828, usdCbtc = tethPerCbtc * ETH_USD;
  ok(!(await p.$('#pl-table')), 'no pools table: the farms list the pools, and the dropdown prices them');
  const lanes = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes.length === 3 && /Bitcoin/.test(lanes[0]) && /cBTC \/ tETH/.test(lanes[1]) && lanes[1].includes(`$${Math.round(usdCbtc).toLocaleString('en-US')}`) && /1 cBTC = [\d.]+ tETH/.test(lanes[1]) && /1\d\d% above BTC · \$[\d.,]+k? deep/.test(lanes[1]) && /too small to price/.test(lanes[2]), `the dropdown: bitcoin's price, cBTC's price in the tETH pool from its reserves and how far that is from bitcoin's, and the dust pool unpriced (${lanes.join(' | ').slice(0, 200)})`);
  const sum = await text(p, '#hints-sum');
  ok(/Bitcoin \$[\d,]+/.test(sum) && /cBTC in pools \$[\d,]+/.test(sum) && /1\d\d% over BTC/.test(sum) && !/off|under|apart/.test(sum), `the line above the dropdown says what the second price is and which way it is skewed: the pool is over bitcoin (${sum})`);
  ok(/sit far from BTC/.test(await text(p, '#gapnote')), 'and the note names the skew');
  if (process.env.SHOTS) { await p.click('#hints summary'); const bb = await p.evaluate(() => { const a = document.querySelector('#hints').getBoundingClientRect(), b = document.querySelector('.hints-pop').getBoundingClientRect(); const x = Math.max(0, Math.min(a.left, b.left) - 8), y = Math.max(0, a.top - 8); return { x, y, width: Math.max(a.right, b.right) + 8 - x, height: b.bottom + 8 - y }; }); await p.screenshot({ path: `${process.env.SHOTS}/cbtc-hints.png`, clip: bb }); await p.click('#hints summary'); }
  const farm = await p.$$eval('.pf', (a) => a.map((x) => ({ href: x.getAttribute('href'), t: x.textContent.replace(/\s+/g, ' ').trim() })));
  const fp = program.pools.find((x) => x.pair === 'cETH/cBTC'), depthUsd = 63593972 / 1e8 * ETH_USD + 730828 / 1e8 * BTC_USD, bonded = depthUsd * Number(fp.totalShares) / Number(fp.reserves.lpTotalShares), wantApr = Number(fp.tacPerDayForPool) * 365 / PER_ETH * ETH_USD / bonded * 100;
  const gotApr = parseInt(farm[0].t.replace(/,/g, '').match(/(\d+)%/)[1]);
  ok(farm[0].href === '/#farm/private-2' && Math.abs(gotApr - wantApr) <= Math.max(2, wantApr * 0.01), `the farm's APR is a year of its TAC over what the farm holds of the pool, both sides at market (what the front page works out too): ${gotApr}% (${wantApr.toFixed(1)}%)`);
  ok(/\$2\.1k deep/.test(farm[0].t), `and its depth counts both sides at market, $${Math.round(depthUsd)}, not twice the tETH side (${farm[0].t.slice(-70)})`);
  ok(/222 TAC/.test(await text(p, '#fm-stats')), 'the farms\' rewards add up');
  ok(await p.$eval('#locks', (s) => s.hidden) && /Sign in to see your cBTC, locks and loans/.test(await p.$eval('#held', (e) => e.textContent)), 'signed out there is no locks panel (the backing counts every lock), and the ticket offers to show yours');
  // the history: the locked bitcoin and the cUSD out, from the engine's events
  const kinds = await p.$$eval('#lane-seg button', (b) => b.map((x) => x.textContent));
  ok(kinds.join() === 'BTC locked,cUSD out' && /past|all time/.test(await text(p, '#ch-read')), `the chart offers the locked bitcoin and the cUSD out (${kinds.join(' | ')})`);
  const rd = await text(p, '#ch-read');
  ok(rd.startsWith('0.1139 BTC') && /all time|past month/.test(rd), `its right edge is what is locked now, and the events add up to it (${rd.slice(0, 80)})`);
  ok(!/do not add up/.test((await p.$eval('#chart-note', (e) => e.textContent))) && (await p.$$eval('#range-seg button', (b) => b.map((x) => x.textContent))).includes('All'), 'the history says nothing of a mismatch, and offers ranges');
  const box = await (await p.$('#chart svg')).boundingBox();
  let hover = '';
  for (let k = 8; k < 90 && !/BTC locked in/.test(hover); k += 2) { await p.mouse.move(box.x + box.width * k / 100, box.y + box.height / 2); await p.waitForTimeout(40); hover = await text(p, '#ch-read'); }
  ok(/0\.\d{4} BTC locked in \d+ step/.test(hover) && !/\b0 BTC/.test(hover), `a bar's hover reads the bitcoin it locked in the digits a lock needs (${hover.slice(0, 90)})`);
  await p.mouse.move(5, 5);
  await p.click('#view-seg [data-unit="usd"]');
  ok(/^\$9,\d{3}/.test(await text(p, '#ch-read')), `in dollars at bitcoin's price (${(await text(p, '#ch-read')).slice(0, 40)})`);
  await p.click('#lane-seg [data-chart="out"]');
  await until(p, () => /cUSD lent/.test(document.querySelector('#chart-name').textContent));
  const rd2 = await text(p, '#ch-read');
  ok(/^\$4,444/.test(rd2) && !(await p.$('#view-seg button')), `the cUSD out ends on what the engine says is out (${rd2.slice(0, 60)})`);
  await p.click('#lane-seg [data-chart="locked"]');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error and nothing blocked by the CSP (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  await shot(p, 'cbtc-public');
  // the ticket: sizing a bond
  await p.fill('#amt', '0.01');
  await until(p, () => /ETH bond, at least/.test(document.querySelector('#route').textContent));
  const route = await text(p, '#route');
  const needEth = 0.01 * BTC_USD / ETH_USD * 1.5;
  ok(/You get\s*0\.01 cBTC/.test(route) && route.includes(needEth.toFixed(4).slice(0, 5)) && /Borrow up to\s*about 543 cUSD at the 150% floor/.test(route), `an amount sized: the cBTC, the bond of 1.5× at least (${needEth.toFixed(3)} ETH) and what can be borrowed (${route.slice(0, 160)})`);
  ok((await p.$eval('#go', (a) => a.getAttribute('href'))) === '/vault/#btc' && /Lock BTC/.test(await text(p, '#go')), 'the button opens the Borrow page\'s Bitcoin side, where BTC is locked, bonded and minted');
  await until(p, () => /ETH bond, at least/.test(document.querySelector('#route').textContent));
  await p.click('#mode-seg [data-mode="use"]');
  const uses = await p.$$eval('#uses a.use', (a) => a.map((x) => [x.querySelector('b').textContent, x.getAttribute('href')]));
  ok(uses.map((u) => u[1]).join() === '/vault/#btc,/#private/swap,#farm,/#lock' && /Borrow cUSD/.test(uses[0][0]) && /bond back/.test(uses[3][0]), `use cBTC: borrow on the Borrow page; swap, farm and take a bond back on the front page (${uses.map((u) => u[1]).join(' ')})`);
  ok(/Sign in/.test(await text(p, '#held')), 'its private balance waits for a key');
  await r.browser.close();

  // ── a key: its locks, its cBTC and its loans ──
  r = await openPage({ width: 1280, height: 1000 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  const lockA = { lockTxid: 'ab'.repeat(32), lockVout: 1, vBtc: '5000000', anchor: { txid: 'cd'.repeat(32), vout: 0 }, at: Date.now() }, lockB = { lockTxid: 'ef'.repeat(32), lockVout: 2, vBtc: '1000000', anchor: { txid: '12'.repeat(32), vout: 0 }, at: Date.now() }, lockC = { lockTxid: '34'.repeat(32), lockVout: 3, vBtc: '200000', anchor: { txid: '56'.repeat(32), vout: 0 }, at: Date.now() };
  const op = (v) => '00'.repeat(31) + v.toString(16).padStart(2, '0');
  chain.lockStates.set(op(1), { recorded: true, bonded: true, minted: true, sats: 5000000n });
  chain.lockStates.set(op(2), { recorded: true, bonded: true, minted: false, sats: 1000000n });
  chain.lockStates.set(op(3), { recorded: false, bonded: false, minted: false, sats: 200000n });
  const mineCfg = { positions: [{ pid: 2, shares: String(6810283 / 4), pendingTac: '1.5', unlockAt: 0 }], locks: [lockA, lockB, lockC], cbtc: 4200000, cusd: 123400000000, loans: [{ live: true, debtValue: '90000000000', basket: [{ asset: CBTC, value: '5000000' }] }, { live: false, debtValue: '5', basket: [] }], states: { 3: { spent: true } } };
  await cfg(p, mineCfg);
  await p.click('#mode-seg [data-mode="use"]');
  await p.click('#signin');
  await p.waitForSelector('.bsheet.top [data-in="eth"]');
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => document.querySelectorAll('#lk-mine table tbody tr').length === 2, null, 30000);
  const mine = await p.$$eval('#lk-mine tbody tr', (rs) => rs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(r.log.signs === 2, 'the wallet signed the identity message twice, as a first derivation does');
  ok(mine.length === 2 && /0\.05 BTC/.test(mine[0]) && /minted/.test(mine[0]) && /0\.01 BTC/.test(mine[1]) && /ready to mint/.test(mine[1]), `the key's live locks, each with its step (${mine.join(' | ')})`);
  ok(!/0\.002 BTC/.test(mine.join()), 'a lock the pool has retired is not listed');
  const links = await p.$$eval('#lk-mine tbody a', (a) => a.map((x) => x.getAttribute('href')));
  ok(links[0] === `https://mempool.space/tx/${lockA.lockTxid}` && links[1].endsWith(lockB.lockTxid), 'each lock links to its transaction');
  let u = await ux(p);
  ok(u.calls.some((c) => c[0] === 'locks' && c[1] === 32 && c[2] === 'bc') && u.calls.some((c) => c[0] === 'balance' && /"cbtc":true/.test(c[2])) && u.calls.some((c) => c[0] === 'recoverCdpPositions'), 'the locks come from the key\'s own Bitcoin history (mainnet addresses), the cBTC from a scan that reads it, the loans from the pool module');
  await p.click('#mode-seg [data-mode="use"]');
  await until(p, () => /cBTC, private/.test(document.querySelector('#held').textContent));
  const held = await text(p, '#held');
  ok(/0\.042 .*cBTC, private/.test(held) && /900 cUSD in 1 loan/.test(held) && /Private cUSD1,234/.test(held), `use cBTC: the key's private cBTC, what it owes in its one live loan, and its cUSD (${held})`);
  await until(p, () => document.querySelector('.pf .tag'));
  const mineFarm = await text(p, '.pf .sb.mine');
  ok(/Yours: 0\.001827 cBTC \+ 0\.159 tETH · 1\.5 TAC earned/.test(mineFarm), `the key's position shows on its farm: what it holds and has earned (${mineFarm})`);
  await shot(p, 'cbtc-mine');
  // a failing read is said, and the others still show
  await cfg(p, { locksFail: true });
  await p.click('#lk-re');
  await until(p, () => /Could not read your locks: esplora is down/.test(document.querySelector('#lk-mine').textContent), null, 20000);
  ok(/0\.042/.test(await text(p, '#held')) && !/Reading/.test(await text(p, '#lk-mine')), 'a Bitcoin history that cannot be read says so, and the cBTC and loans still show');
  // the wallet that opened the key moves to another account: the key locks, as it does on every other page of the site; opening it again works
  await p.evaluate(() => window.__walletEmit('accountsChanged', ['0x' + '99'.repeat(20)]));
  await until(p, () => document.querySelector('#locks').hidden, null, 10000);
  u = await ux(p);
  ok((u.forgot || 0) >= 1 && /Sign in/.test(await text(p, '#held')), `a wallet that moves to another account locks the key it opened (${u.forgot}; ${(await text(p, '#held')).slice(0, 60)})`);
  await cfg(p, { locksFail: false });
  await p.click('#signin');
  await p.waitForSelector('.bsheet.top [data-in="eth"], .bsheet.top [data-in="known"]');
  await p.click('.bsheet.top [data-in="eth"], .bsheet.top [data-in="known"]');
  await until(p, () => document.querySelectorAll('#lk-mine table tbody tr').length === 2, null, 30000);
  await p.click('#held-lock').catch(() => {});
  await p.click('#mode-seg [data-mode="use"]');
  await p.click('#held-lock').catch(() => {});
  await until(p, () => !document.querySelector('#held-lock'), null, 5000).catch(() => {});
  u = await ux(p);
  ok((u.forgot || 0) >= 1 && /Sign in/.test(await text(p, '#held')) && await p.$eval('#locks', (s) => s.hidden), 'Lock drops the key and the pool module\'s copies of it, and its locks with it');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error with a key (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  // ── the Borrow page's Bitcoin side: the same key's locks, loans and cBTC, read only when the holder asks ──
  await p.goto(`http://127.0.0.1:${WEB}/vault/#btc`);
  await p.waitForSelector('#btc-mine [data-mine="open"]');
  await p.waitForTimeout(1500);
  ok(await p.evaluate(() => !window.__ux), 'the Borrow page loads nothing of a key until it is asked to');
  const lockD = { lockTxid: '34'.repeat(32), lockVout: 4, vBtc: '300000', anchor: { txid: '56'.repeat(32), vout: 0 }, at: Date.now() };
  chain.lockStates.set(op(4), { recorded: false, bonded: false, minted: false, sats: 300000n });
  await cfg(p, { ...mineCfg, locks: [...mineCfg.locks, lockD] });
  await p.click('#btc-mine [data-mine="open"]');
  await p.waitForSelector('.bsheet.top [data-in="eth"], .bsheet.top [data-in="known"]');
  await p.click('.bsheet.top [data-in="known"], .bsheet.top [data-in="eth"]');
  await until(p, () => /Lock /.test(document.querySelector('#btc-mine')?.textContent || ''), null, 30000);
  const vm = (await text(p, '#btc-mine')).replace(/\s+/g, ' ');
  ok(/cBTC, private0\.042/.test(vm) && /cUSD, private1,234/.test(vm) && /Loan900 cUSD/.test(vm) && /0\.05 BTC/.test(vm) && /0\.01 BTC/.test(vm) && !/0\.002 BTC/.test(vm),
    `vault: the key's private cBTC and cUSD, its loan and its two live locks (${vm.slice(0, 220)})`);
  const vlinks = await p.$$eval('#btc-mine a', (a) => a.map((x) => `${x.textContent}:${x.getAttribute('href')}`));
  ok(vlinks.join() === 'Send from a wallet in this browser →:/#lock' && !!(await p.$('#btc-mine [data-mine="mint"]')) && !!(await p.$('#btc-mine [data-mine="bond"]')) && !!(await p.$('#btc-mine [data-mine="repay"]')), `vault: each lock's next step and the loan are done from here (${vlinks.join(' ') || 'no links'})`);
  // a lock ready to mint is minted from here, relayed, its blinding from the key and the anchor
  await p.click('#btc-mine [data-mine="mint"]');
  await until(p, () => /cBTC minted/.test(document.querySelector('#bm-status')?.textContent || ''), null, 30000);
  const mintCall = (await ux(p)).calls.find((c) => c[0] === 'mintCbtc');
  ok(mintCall && mintCall[1] === '0x' + '00'.repeat(31) + '02' && mintCall[2] === '1000000' && /^0x[0-9a-f]{64}$/.test(mintCall[3]) && mintCall[4] === 'function', `vault: Mint cBTC asks the pool for the lock's mint, its blinding derived here (${JSON.stringify(mintCall)})`);
  const jl = await p.evaluate(() => (JSON.parse(localStorage.getItem('tacit-lite-activity-v1') || '{}').items || []).map((x) => `${x.label}:${x.status}`));
  ok(jl.includes('Mint 0.01 cBTC:settled'), `vault: and the mint is in the Activity journal, settled (${jl.join(' | ')})`);
  // a lock waiting for its bond: the bond is sized as the front page sizes it and paid in ETH from the connected wallet
  walletAccepts = false;
  await p.click('#btc-mine [data-mine="bond"]');
  await until(p, () => /Cancelled in your wallet/.test(document.querySelector('#bm-status')?.textContent || ''), null, 30000)
    .catch(async (e) => { throw new Error(`${e.message.split('\n')[0]} | status: ${await text(p, '#bm-status').catch(() => '?')} | sheets: ${await p.evaluate(() => [...document.querySelectorAll('.bsheet')].map((x) => x.textContent.replace(/\s+/g, ' ').slice(0, 80)).join(' || '))}`); });
  const asked = r.log.lastSend || {};
  ok(String(asked.to).toLowerCase() === '0x000000008ecd09f922c9fbbdd9aca5ae8f0bebfa' && String(asked.data).toLowerCase() === '0xc0e2d9a1' + '00'.repeat(31) + '04' && BigInt(asked.value) === 1287000000000000n,
    `vault: Post the bond asks the wallet for postEscrowWithETH on the lock, 1.1× the required wstETH in ETH (${JSON.stringify(asked)})`);
  ok(/Cancelled in your wallet\. Nothing was sent/.test(await text(p, '#bm-status')) && !(await p.evaluate(() => (JSON.parse(localStorage.getItem('tacit-lite-activity-v1') || '{}').items || []).some((x) => /Post the bond/.test(x.label)))), 'vault: declined in the wallet, nothing is posted or journaled');
  walletAccepts = true;
  await p.click('#btc-mine [data-mine="bond"]');
  await until(p, () => /Bond posted/.test(document.querySelector('#bm-status')?.textContent || ''), null, 30000);
  const jb = await p.evaluate(() => (JSON.parse(localStorage.getItem('tacit-lite-activity-v1') || '{}').items || []).map((x) => `${x.label}:${x.status}`));
  ok(jb.includes('Post the bond for 0.003 BTC:confirmed'), `vault: sent, the bond is followed to its receipt and journaled (${jb.join(' | ')})`);
  walletAccepts = false;
  // BTC sent to the key's deposit address from any wallet is locked from here, keeping what the lock's fees need
  const dep = (await text(p, '#btc-mine .bm-lock')).replace(/\s+/g, ' ');
  ok(/Deposit addressbc1qde/.test(dep) && /It holds0\.0006 BTC/.test(dep) && /0\.00005 on its way/.test(dep) && /keeping about 0\.0000199 BTC for fees/.test(dep), `vault: the deposit address, what it holds and what is on its way, and the fees a lock keeps back (${dep.slice(0, 220)})`);
  await p.fill('#bm-lock', '0.0006');
  await p.click('#btc-mine [data-mine="lockbtc"]');
  await until(p, () => /Wait for the deposit to confirm/.test(document.querySelector('#bm-status')?.textContent || ''), null, 20000);
  ok(true, 'vault: a lock its fees would take past what is confirmed, with the rest on its way, waits for it to confirm');
  await p.fill('#bm-lock', '0.0007');
  await p.click('#btc-mine [data-mine="lockbtc"]');
  await until(p, () => /Not enough BTC at the deposit address/.test(document.querySelector('#bm-status')?.textContent || ''), null, 20000);
  ok(!(await ux(p)).calls.some((c) => c[0] === 'lock'), 'vault: and more than the address will hold is refused, both before anything is signed');
  await p.fill('#bm-lock', '0.0005');
  await p.click('#btc-mine [data-mine="lockbtc"]');
  await until(p, () => /Locked/.test(document.querySelector('#bm-status')?.textContent || ''), null, 30000);
  const lk = (await ux(p)).calls.filter((c) => c[0] === 'lock' || c[0] === 'syncCbtcLockReservations').map((c) => c.join('|'));
  ok(lk.join(' ') === `syncCbtcLockReservations lock|50000|${'78'.repeat(32)}:1`, `vault: the pool's reservations are read first, then 0.0005 BTC is locked, the coin not yet confirmed left alone (${lk.join(' ')})`);
  const kept = await p.evaluate(() => ({ prot: Object.keys(JSON.parse(localStorage.getItem('tacit-protected-outpoints-v1') || '{}')), rec: Object.entries(localStorage).filter(([k]) => k.startsWith('tacit-lite-cbtc-v1:')).map(([, v]) => JSON.parse(v)), act: (JSON.parse(localStorage.getItem('tacit-lite-activity-v1') || '{}').items || []).map((x) => `${x.label}:${x.kind}`) }));
  ok(kept.prot.some((x) => x.startsWith('9a'.repeat(32))) && kept.rec.some((x) => x.lockTxid === '9a'.repeat(32) && x.vBtc === '50000' && x.anchor?.txid === '77'.repeat(32)) && kept.act.includes('Lock 0.0005 BTC:btc'),
    `vault: the lock's outpoint is protected, its record kept where the front page keeps it, and it is in the journal (${JSON.stringify(kept).slice(0, 200)})`);
  await until(p, () => /Lock 9a9a9a/.test(document.querySelector('#btc-mine')?.textContent || ''), null, 30000);
  ok(true, 'vault: and the new lock is listed before Bitcoin\'s history has it');
  await p.click('#btc-mine [data-mine="lock"]');
  await until(p, () => !!document.querySelector('#btc-mine [data-mine="open"]'), null, 10000);
  ok(true, 'vault: Lock your key puts the panel back to asking');
  ok(r.errors.length === 0 && r.blocked.length === 0, `vault: no page error or blocked request with a key (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  await r.browser.close();

  // ── what cannot be read ──
  chain.logs = false;
  r = await openPage({ width: 1280, height: 900 });
  await until(r.page, () => /Could not read the history/.test(document.querySelector('#chart').textContent), null, 30000);
  ok(!(await r.page.$('#chart .line')) && (await r.page.$$eval('#cov .cov-row', (a) => a.length)) === 4, 'a node that does not serve the events leaves the chart saying so, and everything else stands');
  await r.browser.close();
  chain.logs = true;
  chain.engine = false; chain.stats = 'down';
  r = await openPage({ width: 1280, height: 900 });
  p = r.page;
  await p.waitForTimeout(2500);
  ok(!/\$\d/.test(await text(p, '#px-usd')) || /\$81,500/.test(await text(p, '#px-usd')), 'without the engine the headline falls back to the feed\'s price of bitcoin, or waits');
  ok(/Loading|could not/i.test(await text(p, '#cov')) || (await p.$$eval('#cov .cov-row', (a) => a.length)) === 0, 'with no totals nothing is invented');
  await r.browser.close();
  chain.engine = true; chain.stats = null;

  // ── a phone, in the dark ──
  r = await openPage({ width: 390, height: 800 }, { scheme: 'dark' });
  p = r.page;
  await until(p, () => document.querySelectorAll('.pf').length === 1 && document.querySelector('#cov .cov-row'));
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'a phone has no sideways scroll');
  const order = await p.evaluate(() => ['.p-ticket', '.p-chart', '.p-farm', '.p-info'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top + scrollY)));
  ok(order.every((v, i) => i === 0 || v > order[i - 1]), `the ticket first, then what backs it, the farms and about (${order.join(' ')})`);
  await shot(p, 'cbtc-phone');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error on a phone in the dark (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  // cBTC's old address (/trade/cbtc/) is a stub that sends on, the query and the fragment with it, under its own CSP
  for (const [from, want] of [['/trade/cbtc/', '/cbtc/'], ['/trade/cbtc/#mode=use', '/cbtc/#mode=use'], ['/trade/cbtc/?x=1#amount=0.1', '/cbtc/?x=1#amount=0.1']]) {
    await r.page.goto(`http://127.0.0.1:${WEB}${from}`);
    await r.page.waitForSelector('#wallet-chip');
    const u = new URL(r.page.url());
    ok(u.pathname + u.search + u.hash === want, `the old address ${from} lands on ${want} (${u.pathname + u.search + u.hash})`);
  }
  ok(r.blocked.length === 0, `and the stub's own script ran under its CSP (${r.blocked.join(' | ').slice(0, 160)})`);
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 8).join('\n'));
  try { await r?.browser?.close(); } catch { /* it may be gone */ }
}
server.close();
console.log(`\n${n} passed${fails ? `, ${fails} failed` : ''}`);
process.exit(fails ? 1 : 0);
