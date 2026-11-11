#!/usr/bin/env node
// dapp/teth/ in a real browser, under the page's own CSP: what it reads (the pool's totals and ETH history, the private farms that pair
// tETH, the dollar rates), what it draws, and what it does when ETH is made private: the Tacit key opened from a stub Ethereum wallet's real
// signature, one transaction to the wrap forwarder carrying the deposit and the relay's tip, the relay's half, and every way that can stop.
// The API's answers are fixtures captured on 2026-10-14 (the flows moved so the newest is two hours old), the chain's reads are answered by the
// test, and the pool module (confidential-pool-ux.js) is a stand-in that records what it is asked: it is tested on its own elsewhere.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-teth.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const WEB = 23100 + Math.floor(Math.random() * 800);
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
const stats = json('teth-stats-2026-10-14.json'), program = json('teth-program-2026-10-14.json'), quote = json('teth-quote-2026-10-14.json');
// tETH on Bitcoin: the API's answer for an asset with nothing on its book (the live one on 2026-10-14), and one with a book, made from TAC's fixtures of
// 2026-10-12 by moving them to tETH's id and price (a tETH is about 2.9 million sats, a TAC about 150) and size (a thousandth).
const BTC_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const idleAsset = { asset_id: BTC_ID, ticker: 'tETH', decimals: 8, trades: [], trades_cap: 1000, volume_24h_sats: 0, holder_count: 3, transfer_count: 2, listing_count: 0 };
function activeMarket() {
  const soon = nowS() + 7 * 86400, asset = json('tac-asset-2026-10-12.json'), sales = json('tac-sales-2026-10-12.json'), bids = json('tac-bids-2026-10-12.json'), P = 18.75, A = 1000;
  const shift = nowS() - 3600 - Math.max(...asset.trades.map((t) => t.ts));
  const trades = asset.trades.map((t) => ({ ...t, ts: t.ts + shift, price_sats: Math.round(t.price_sats * P), amount: String(BigInt(t.amount) / BigInt(A)) }));
  const last = trades.at(-1);
  return {
    asset: { ...asset, asset_id: BTC_ID, ticker: 'tETH', trades, last_trade: last, mark_price: { unit: asset.mark_price.unit * P * A, source: 'last_trade', ts: last.ts }, volume_24h_sats: 12345678, holder_count: 41, listing_count: sales.sales.length, price_first_trade_ts: trades[0].ts },
    sales: { ...sales, asset_id: BTC_ID, sales: sales.sales.map((x) => ({ ...x, asset_id: BTC_ID, asset_opening: { amount: String(BigInt(x.asset_opening.amount) / BigInt(A)) }, min_price_sats: Math.round(x.min_price_sats * P), expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) })) },
    bids: { ...bids, asset_id: BTC_ID, intents: bids.intents.map((x) => ({ ...x, asset_id: BTC_ID, amount: String(BigInt(x.amount) / BigInt(A)), price_sats: Math.round(x.price_sats * P), expiry: soon })) },
  };
}
const nowS = () => Math.floor(Date.now() / 1000);
// The fixture's flows, moved so the newest is two hours old.
{
  const f = stats.eth.series.flows, shift = nowS() - 7200 - Math.max(...f.map((x) => x[0]));
  stats.eth.series.flows = f.map(([t, v]) => [t + shift, v]); stats.eth.series.ins = stats.eth.series.ins.map(([t, v]) => [t + shift, v]); stats.eth.lastAt += shift;
}
const front = JSON.parse(JSON.stringify(stats)); delete front.eth.series.flows;
const HELD = BigInt(stats.eth.held.$n);
const WRAP_TIP = '0x000000D218B03db5837943b0b05DeA2965AE956e', RELAY = quote.recommendedTipRecipient, TIP = BigInt(quote.recommendedWrapTipWei);
const SPLITTER = '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9';
const ETH_USD = 2441, BTC_USD = 83000, PER_ETH = 11000, ACCOUNT_BAL = 5n * 10n ** 18n;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout });
// SHOTS=<dir> keeps a picture at the moments worth looking at.
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// ── what the chain says: Multicall3's answer for the rates, balances, and the receipts of what the wallet sent ──
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
function aggregate3Result(datas) {
  const tuples = datas.map((d) => { const h = d ? d.replace(/^0x/, '') : ''; return w32(d ? 1 : 0) + w32(64) + w32(h.length / 2) + pad(h); });
  let off = datas.length * 32, offs = '';
  for (const t of tuples) { offs += w32(off); off += t.length / 2; }
  return '0x' + w32(32) + w32(datas.length) + offs + tuples.join('');
}
const round = (answer) => '0x' + w32(1) + w32(BigInt(Math.round(answer * 1e8))) + w32(nowS()) + w32(nowS()) + w32(1);
const sqrtWord = '0x' + w32(BigInt(Math.round(Math.sqrt(PER_ETH) * 1e6)) * 10n ** 12n);
const sent = [];                                                                       // what the stub wallet was asked to send, in order
const chain = { rates: true, receipt: 'ok', quote: null, market: null, settleSim: 'ok', deposit: 'waiting', relay: null };    // `quote`: replaces the API's quote for a test
// `relay`: the API's answer for /confidential/relay (null: a 404, so the page cannot read it, as before the endpoint existed)
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992';
// The prover on this computer (tacit-prover on 127.0.0.1:47815): `up` answers its health check, and every request is kept with the page's origin.
const VKEY = '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3';
const devlog = [];
// Proving with the holder's own credit: the Tacit account (the prover account) the pool module derives from the key, PROVE, and the network's
// deposit contract. The chain's PROVE balances move with what the wallet sends.
const ACCT = JSON.parse(execFileSync('cast', ['wallet', 'new', '--json'], { encoding: 'utf8' }))[0];
const PROVE_TOKEN = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29', VAPP = '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F';
const DOMAIN_SEP = '0x' + '5d'.repeat(32), PERMIT_NONCE = 5n, E18N = 10n ** 18n;
const prove = { acct: 0n, wallet: 10n * E18N, deposited: 0n };
// zQuoter's answer for ETH to PROVE (0.1 ETH buys 250 PROVE, at least 247.5), its call carrying the Tacit account as the recipient.
const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
let lastExactIn = null;                                                                // the call of the latest exact-in answer: what the swap sends
// The stubbed zQuoter: a constant price of 2500 PROVE per ETH and the 1% guard, answering exact-in asks (what a quote is) and exact-out asks (what
// sizing is) in the layout of the real call. A 0.1 ETH ask buys 250 PROVE, at least 247.5.
const PRICE = 2500n, w64 = (v) => BigInt(v).toString(16).padStart(64, '0');
function swapQuote(data) {
  const d = String(data).slice(10), f = (k) => BigInt('0x' + d.slice(k * 64, k * 64 + 64));
  const exactOut = f(1) === 1n, amount = f(4), slip = f(5);
  const amountIn = exactOut ? (amount + PRICE - 1n) / PRICE : amount, amountOut = exactOut ? amount : amount * PRICE;
  const limit = exactOut ? amountIn * (10000n + slip) / 10000n : amountOut * (10000n - slip) / 10000n, msgValue = exactOut ? limit : amount;
  // The call is a real zRouter.swapV3 for the recipient, token pair, amount and deadline asked (the page reads it against them before it sends).
  const callData = '0xafeae12b' + [w64(f(0)), w64(exactOut ? 1 : 0), w64(10000), w64(f(2)), w64(f(3)), w64(amount), w64(limit), w64(f(6))].join('');
  if (!exactOut) lastExactIn = callData;
  const bytes = callData.slice(2);
  return '0x' + w64(1) + w64(30) + w64(amountIn) + w64(amountOut) + w64(7 * 32) + w64(limit) + w64(msgValue) + w64(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
}
const quoted = [];
const events = [];                                                                     // the settle's eth_call and the wallet's sends, in the order they came
const GAS_PRICE = 2n * 10n ** 9n;
function rpcAnswer(req) {
  const { id, method, params } = req;
  const res = (result) => ({ jsonrpc: '2.0', id, result }), err = (message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'eth_call') {
    if (!chain.rates) return err('stub: no rates');
    if (String(params[0].to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return res(aggregate3Result([round(ETH_USD), round(BTC_USD), sqrtWord]));
    if (String(params[0].to).toLowerCase() === POOL.toLowerCase()) {
      const data = String(params[0].data);
      if (data.startsWith('0x7da9874f')) return res('0x' + w32(chain.deposit === 'consumed' ? 2 : 1));      // depositStatus(id)
      if (data.startsWith('0x717fd7f2')) {                                                                   // settle(), tried before it is sent
        events.push(['sim', { from: params[0].from, data }]);
        if (chain.settleSim === 'revert') { chain.deposit = 'consumed'; return err('execution reverted', 3); }
        return res('0x');
      }
    }
    if (String(params[0].to).toLowerCase() === PROVE_TOKEN.toLowerCase()) {
      const data = String(params[0].data);
      if (data.startsWith('0x70a08231')) return res('0x' + w32(data.slice(-40).toLowerCase() === ACCT.address.slice(2).toLowerCase() ? prove.acct : prove.wallet));
      if (data.startsWith('0x7ecebe00')) return res('0x' + w32(PERMIT_NONCE));                  // nonces(account)
      if (data === '0x3644e515') return res(DOMAIN_SEP);                                        // DOMAIN_SEPARATOR()
      if (data.startsWith('0xa9059cbb')) { events.push(['sim', { from: params[0].from, to: params[0].to, data }]); return res('0x' + w32(1)); }
    }
    if (String(params[0].to).toLowerCase() === ROUTER.toLowerCase()) {                       // wrapAndSettleETH, tried before it is sent
      events.push(['sim', { from: params[0].from, to: params[0].to, data: String(params[0].data), value: params[0].value }]);
      return chain.routerSim === 'revert' ? err('execution reverted', 3) : res('0x');
    }
    if (String(params[0].to).toLowerCase() === ZQUOTER.toLowerCase()) { quoted.push(String(params[0].data)); return res(swapQuote(params[0].data)); }
    if (String(params[0].to).toLowerCase() === ZROUTER.toLowerCase()) { events.push(['sim', { from: params[0].from, to: params[0].to, data: String(params[0].data), value: params[0].value }]); return res('0x'); }
    if (String(params[0].to).toLowerCase() === VAPP.toLowerCase()) { events.push(['sim', { from: params[0].from, to: params[0].to, data: String(params[0].data) }]); return res('0x'); }
    return err('stub: eth_call', 3);
  }
  if (method === 'eth_gasPrice') return res('0x' + GAS_PRICE.toString(16));
  if (method === 'eth_getBalance') return res('0x' + ACCOUNT_BAL.toString(16));
  if (method === 'eth_getTransactionReceipt') { const t = sent.find((x) => x.hash === params[0]); return res(t && chain.receipt !== 'none' ? { status: chain.receipt === 'ok' ? '0x1' : '0x0', logs: [], gasUsed: '0x5208', effectiveGasPrice: '0x1' } : null); }
  if (method === 'eth_blockNumber') return res('0x1000000');
  return err(`stub: ${method}`);
}

// What a send does to the PROVE balances: a transfer to the Tacit account, and the network's permitAndDeposit taking what it names from it.
function onSend(tx) {
  const to = String(tx.to).toLowerCase(), d = String(tx.data || '');
  if (to === PROVE_TOKEN.toLowerCase() && d.startsWith('0xa9059cbb')) { const amt = BigInt('0x' + d.slice(74, 138)); prove.wallet -= amt; prove.acct += amt; }
  if (to === VAPP.toLowerCase() && d.startsWith('0x58981c7e')) { const amt = BigInt('0x' + d.slice(74, 138)); prove.acct -= amt; prove.deposited += amt; }
  if (to === ZROUTER.toLowerCase()) prove.acct += 250n * E18N;                                // the swap's PROVE reaches the Tacit account
}

// ── the wallet: an EIP-1193 provider announced through EIP-6963 that signs for real and records what it is asked to send ──
async function stubWallet(ctx, { reject = false } = {}) {
  sent.length = 0;
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], account = j.address, log = { account, signs: 0, sends: sent, requests: [], reject };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    log.requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') { log.signs++; return cast('wallet', 'sign', '--private-key', j.private_key, params[0]); }
    if (method === 'eth_sendTransaction') {
      if (log.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const hash = '0x' + (sent.length + 1).toString(16).padStart(64, 'a'); sent.push({ hash, tx: params[0] }); events.push(['send', params[0]]); onSend(params[0]); return hash;
    }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => {
    const provider = { request: ({ method, params }) => window.__wallet(method, params).catch((e) => { const m = String(e?.message || e); throw Object.assign(new Error(m.replace(/^.*Error: /, '')), { code: /rejected/i.test(m) ? 4001 : undefined }); }), on() {}, removeListener() {} };
    const detail = Object.freeze({ info: Object.freeze({ uuid: 'stub-1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });
  return log;
}

// ── the pool module, as a stand-in that records what it is asked and answers from `window.__ux.cfg` ──
const UX_STUB = `
const ux = (window.__ux ||= { calls: [], cfg: {} });
export function setExternalTacHolders() {}
export function forgetKeys() { ux.forgot = (ux.forgot || 0) + 1; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PV = '0x' + '20'.padStart(64, '0') + 'ab'.repeat(96), PROOF = '0x' + 'cd'.repeat(48);
const strip = (h) => String(h).replace(/^0x/, '');
const refusal = (c) => c === 'relay_paused' ? Object.assign(new Error('relay 503: the relay is not proving right now'), { code: c, httpStatus: 503 }) : Object.assign(new Error(c === 'free_budget' ? 'relay 429: free relayed settles for today are used up (40/40) — attach a fee above the floor, or prove-mode and settle it yourself'
  : c === 'relay_held' ? 'relay 429: the relay can’t take this one just now: it is catching up on settles. Send it from your own account instead; the relay still proves it for you'
  : 'relay 429: prove capacity for today is used up (9/9) — prove locally instead, or use a relayed settle'), { code: c, httpStatus: 429, retryAfter: 300 });
const openOf = (jobId, memos) => ({ jobId, type: 'wrap', publicValues: PV, proof: PROOF, memos });
// What would reach the relay is posted to the API, so a test can tell a proof of the holder's own (nothing posted) from the relay's.
const toRelay = (mode) => fetch('https://api.tacit.finance/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'wrap', mode }) }).catch(() => {});
export function makeConfidentialPoolUx() {
  return {
    account() { return { priv: '${ACCT.private_key}', address: '${ACCT.address}' }; },
    async nextWrapIndex(a) { ux.calls.push(['nextWrapIndex', a.ticker, a.walletPriv.length]); await wait(ux.cfg.indexMs || 0); if (ux.cfg.indexFails) throw new Error('nextWrapIndex: could not read this asset\\'s wrap deposits (stub); retry'); return ux.cfg.index ?? 7; },
    buildWrap(a) {
      ux.calls.push(['buildWrap', String(a.amountWei), a.ticker, a.index]);
      ux.builds = (ux.builds || 0) + 1;
      return { commit: '0x' + 'ab'.repeat(32), index: a.index, amount: String(a.amountWei), leaf: 'leaf' + a.index, depositId: '0x' + a.index.toString(16).padStart(64, '0'), wrapOp: {}, outputs: [], memos: ['0x' + 'ee'.repeat(40) + ux.builds.toString(16).padStart(2, '0')] };
    },
    // a note proved before its deposit: by the prover set with useProver, as confidential-relay.js's proveOwn hands it the op, or by the relay
    async proveWrap(a) {
      ux.calls.push(['proveWrap', String(a.amountWei), a.ticker, a.index, ux.own && !a.waitOpts?.viaRelay ? 'own' : 'relay']);
      const built = this.buildWrap(a);
      a.onBuilt?.(built);
      if (ux.own && !a.waitOpts?.viaRelay) {
        const r = await ux.own({ type: 'wrap', op: built.wrapOp, memos: built.memos, onUpdate: (u) => a.waitOpts?.onUpdate?.({ jobId: u.requestId ? 'spn:' + u.requestId : null, status: u.status, stage: u.stage, ...(u.public ? { inputPublic: true } : {}) }) });
        return { built, proven: { jobId: 'spn:' + r.requestId, publicValues: r.publicValues, proof: r.proof, memos: built.memos } };
      }
      // The relay refuses a prove-only job (no sponsored proofs left today, as the API answers then) unless relayFirst is set: the
      // scenarios after the first wrap test the deposit-first way that then follows, and the first wrap tests the relay proving first.
      if (ux.cfg.proveRefused ?? !ux.cfg.relayFirst) throw Object.assign(new Error('prove capacity for today is used up (150/150)'), { code: 'prove_budget', httpStatus: 429 });
      await toRelay('prove');
      return { built, proven: { jobId: 'job-p', publicValues: PV, proof: PROOF, memos: built.memos } };
    },
    wrapSettleCall(a) {
      const fee = BigInt(a.ethFeeWei || 0);
      ux.calls.push(['wrapSettleCall', a.built.index, String(fee), a.feeRecipient || null]);
      return { to: '${ROUTER}', value: BigInt(a.built.amount) + fee, data: '0x50de88e1' + strip(a.built.commit) + strip(a.proven.publicValues) + strip(a.proven.proof) + a.proven.memos.map(strip).join(''), gasLimit: 750000n };
    },
    releaseWrapIndex(a) { ux.calls.push(['releaseWrapIndex', a.index]); },
    async submitWrapSettle(a) {
      ux.calls.push(['submitWrapSettle', a.built.index, a.depositTx || null, a.waitOpts?.timeoutMs, a.selfSettle ? 'self' : 'relay']);
      await wait(ux.cfg.settleMs || 0);
      const jobId = 'job-' + (ux.jobs = (ux.jobs || 0) + 1);
      if (a.selfSettle) {
        // relay.prove with useProver set: the holder's own prover makes the proof, as confidential-relay.js's proveOwn hands it the op
        if (ux.own) {
          const r = await ux.own({ type: 'wrap', op: a.built.wrapOp, memos: a.built.memos, onUpdate: (u) => a.waitOpts?.onUpdate?.({ jobId: u.requestId ? 'spn:' + u.requestId : null, status: u.status, stage: u.stage, ...(u.public ? { inputPublic: true } : {}) }) });
          const sent = await a.selfSettle({ jobId: 'spn:' + r.requestId, publicValues: r.publicValues, proof: r.proof, memos: a.built.memos });
          return { jobId: 'spn:' + r.requestId, status: 'settled', ...sent };
        }
        await toRelay('prove');
        if (ux.cfg.proveRefuse) { const c = ux.cfg.proveRefuse === true ? 'prove_budget' : ux.cfg.proveRefuse; ux.cfg.proveRefuse = false; throw refusal(c); }
        const sent = await a.selfSettle({ jobId, publicValues: PV, proof: PROOF, memos: a.built.memos });
        return { jobId, status: 'settled', ...sent };
      }
      await toRelay('settle');
      if (ux.cfg.settleRefuse) { const c = ux.cfg.settleRefuse; ux.cfg.settleRefuse = null; throw refusal(c); }
      a.waitOpts?.onJob?.(jobId, 'wrap');
      // a relay that has the job and does not finish it: polled as the relay client polls, with the page's sleep, which ends it once the page stops waiting
      if (ux.cfg.settleHang) {
        try { for (let i = 0; i < 900 && ux.cfg.settleHang; i++) await (a.waitOpts?.sleep || wait)(100); }
        catch (e) { ux.calls.push(['waitEnded', jobId, e.code || null]); throw e; }
      }
      if (ux.cfg.settleOpen) { ux.cfg.settleOpen = false; throw Object.assign(new Error('settle held: proved and waiting for a sender (job ' + jobId + '); it can be sent from any account now'), { code: 'open', open: openOf(jobId, a.built.memos) }); }
      // an open job whose memos the relay kept from an earlier send of the same deposit: the pool module drops the proof, as its memos are not this call's
      if (ux.cfg.settleOpenElse) { ux.cfg.settleOpenElse = false; ux.lastMemos = ['0x' + 'dd'.repeat(41)]; throw new Error('settle held: proved and waiting for a sender (job ' + jobId + '); it can be sent from any account now'); }
      if (ux.cfg.settleFails > 0) { ux.cfg.settleFails--; ux.lastMemos = a.built.memos; throw new Error('settle timed out (box offline or backlogged)'); }
      return { status: 'settled' };
    },
    settleCalldata(p) {
      const data = '0x717fd7f2' + strip(p.publicValues) + strip(p.proof) + p.memos.map(strip).join('');
      ux.calls.push(['settleCalldata', data, p.memos.length]);
      return data;
    },
    relay: {
      useProver(fn) { ux.calls.push(['useProver', !!fn]); ux.own = fn || null; },
      ownProving() { return !!ux.own; },
      async waitForSettle(jobId, o) {
        ux.calls.push(['waitForSettle', jobId, o.openGraceMs]);
        if (ux.cfg.waitOpen) { ux.cfg.waitOpen = false; throw Object.assign(new Error('settle held'), { code: 'open', open: openOf(jobId, ux.lastMemos) }); }
        return { jobId, status: 'settled', txHash: '0x' + 'bb'.repeat(32) };
      },
      provenMemos(st, o, sealed) {
        ux.calls.push(['provenMemos', st.memos.length, sealed.length]);
        if (st.memos.length === sealed.length && st.memos.every((x, i) => x === sealed[i])) return sealed;
        if (ux.cfg.memosOpen) return st.memos;
        throw new Error('a memo does not open to this note');
      },
      async landed(jobId, txHash) { ux.calls.push(['landed', jobId, txHash]); return { ok: true, status: 'settled', txHash }; },
      async verifyEmittedMemos(st) { ux.calls.push(['verifyEmittedMemos', st.jobId, st.txHash]); return st; },
    },
    async balance(priv, o) {
      ux.calls.push(['balance', priv.length, JSON.stringify(o)]);
      await wait(ux.cfg.balanceMs || 0);
      if (ux.cfg.balanceFails) throw new Error('could not read the pool');
      const id = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
      const value = BigInt(ux.cfg.held || 0);
      return { byAsset: value ? { [id]: { asset: id, value, notes: [{ value: String(value) }] } } : {}, notes: [], diag: { wrap: { pending: (ux.cfg.pending || []).map((p) => ({ ...p, value: BigInt(p.value) })) }, errors: ux.cfg.farmError ? { farm: 'x' } : {} },
        farmPositions: ux.cfg.positions || [] };
    },
  };
}`;

// self-prover.js as it is, with sp1-stdin.js and succinct-net.js (the program input and the network client) replaced by a stand-in that answers
// from window.__spn.cfg: the credit (or a list of credits, one per read), a request that is not proved in time, and records what it is asked.
const SPN_STUB = `
const spn = (window.__spn ||= { calls: [], cfg: {} });
const SELF_PROVE_TYPES = ['wrap'];
const LIMITS = { wrap: { cycleLimit: 2000000000, gasLimit: 1000000000n } };
const stdinFor = (type, op) => { spn.calls.push(['stdin', type, (op.memoHashes || []).length]); return new Uint8Array([1, 2, 3]); };
const zstdFrame = (b) => b;
function makeSuccinctNetwork() {
  return {
    async balance(a) {
      spn.calls.push(['balance', a]);
      if (spn.cfg.balanceFails) throw new Error('the network did not answer');
      const c = Array.isArray(spn.cfg.credits) && spn.cfg.credits.length ? spn.cfg.credits.shift() : spn.cfg.credit;
      return BigInt(c ?? '0');
    },
    async needWei({ gasLimit }) { return 450000000000000000n; },
    // cfg.privateOff: the network refusing private inputs, as mainnet did from 2026-10-15 22:11 UTC; 'auto' then goes with a public one.
    async requestProof({ priv, stdinZstd, gasLimit, input = 'private', onPublic }) {
      if (spn.cfg.privateOff && input === 'auto') { onPublic?.(); await new Promise((r) => setTimeout(r, 300)); spn.calls.push(['request', priv, stdinZstd.length, String(gasLimit), 'public']); return { requestId: '0x' + 'ab'.repeat(32), private: false }; }
      spn.calls.push(['request', priv, stdinZstd.length, String(gasLimit)]); return { requestId: '0x' + 'ab'.repeat(32), private: true };
    },
    privateOff() { return !!spn.cfg.privateOff; },
    async waitProof(id, { onUpdate } = {}) {
      onUpdate?.({ status: 'assigned' });
      await new Promise((r) => setTimeout(r, spn.cfg.proveMs ?? 300));
      if (spn.cfg.notProved) { spn.cfg.notProved = false; throw Object.assign(new Error('the request was not fulfilled before its deadline'), { code: 'not_proved' }); }
      onUpdate?.({ status: 'proved' });
      spn.proved = (spn.proved || 0) + 1;
      return { publicValues: '0x' + '20'.padStart(64, '0') + '77'.repeat(96), proof: '0x' + '99'.repeat(48) };
    },
  };
}
`;
const SELF_PROVER = SPN_STUB + readFileSync(join(DAPP, 'self-prover.js'), 'utf8').split('\n').filter((l) => !/^import /.test(l)).join('\n');
// device-prover.js as it is, with sp1-stdin.js replaced by a stand-in that records what it builds.
const DEVICE_PROVER = `
const dev = (window.__dev ||= { calls: [] });
const SELF_PROVE_TYPES = ['wrap', 'wraptransfer', 'transfer', 'unwrap', 'sendunwrap', 'stealthlock', 'stealthclaim', 'stealthrefund'];
const stdinFor = (type, op) => { dev.calls.push(['stdin', type, (op.memoHashes || []).length]); return new Uint8Array([1, 2, 3]); };
` + readFileSync(join(DAPP, 'device-prover.js'), 'utf8').split('\n').filter((l) => !/^import /.test(l)).join('\n');

async function openPage(viewport, { wallet = false, reject = false, hash = '', scheme = 'light', api = true } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const log = wallet ? await stubWallet(ctx, { reject }) : null;
  const ok200 = (body) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co']) await ctx.route(`https://${h}/**`, (r) => {
    const q = JSON.parse(r.request().postData() || '{}');
    return r.fulfill(ok200(Array.isArray(q) ? q.map(rpcAnswer) : rpcAnswer(q)));
  });
  const seen = [];
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, (r) => {
    const u = new URL(r.request().url()); seen.push(u.pathname + u.search);
    if (!api) return r.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"down"}' });
    if (u.pathname === '/stats') return r.fulfill(ok200(u.searchParams.get('view') === 'front' ? front : u.searchParams.get('view') === 'eth' ? { eth: stats.eth, at: stats.at, block: stats.block } : stats));
    if (u.pathname === '/farm/program') return r.fulfill(ok200(program));
    if (u.pathname === `/assets/${BTC_ID}`) return r.fulfill(chain.market === 'down' ? { status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' } : ok200(chain.market === 'active' ? activeMarket().asset : chain.market === 'ask' ? { ...idleAsset, listing_count: 1 } : idleAsset));
    if (u.pathname === `/assets/${BTC_ID}/preauth-sales`) return r.fulfill(chain.market === 'partial' ? { status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' } : ok200(chain.market === 'active' ? activeMarket().sales : chain.market === 'ask' ? { ...activeMarket().sales, sales: activeMarket().sales.sales.slice(0, 1) } : { asset_id: BTC_ID, count: 0, sales: [] }));
    if (u.pathname === `/assets/${BTC_ID}/bid-intents`) return r.fulfill(ok200(chain.market === 'active' ? activeMarket().bids : { asset_id: BTC_ID, count: 0, intents: [] }));
    if (u.pathname === '/confidential/quote') return r.fulfill(ok200(chain.quote ? chain.quote(quote, u) : quote));
    if (u.pathname === '/confidential/relay') return r.fulfill(chain.relay ? ok200(chain.relay) : { status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    if (u.pathname === '/confidential/submit' && r.request().method() === 'POST') { posts.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill(ok200({ ok: true, jobId: 'job-x', status: 'pending' })); }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await ctx.route('**/confidential-pool-ux.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: UX_STUB }));
  await ctx.route('**/self-prover.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: SELF_PROVER }));
  await ctx.route('**/device-prover.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: DEVICE_PROVER }));
  await ctx.route('http://127.0.0.1:47815/**', (r) => {
    const q = r.request(), u = new URL(q.url()), origin = q.headers().origin || null;
    devlog.push({ path: u.pathname, origin });
    if (!chain.device?.up) return r.abort('connectionrefused');
    const cors = { 'access-control-allow-origin': origin || '*', 'access-control-allow-private-network': 'true' };
    const json = (body) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (u.pathname === '/health') return json({ ok: true, vkey: VKEY, busy: false, queued: 0, gpu: 'Apple M2' });
    if (u.pathname === '/prove') return json({ id: 'd' + devlog.filter((x) => x.path === '/prove').length });
    if (u.pathname === '/job') return json(chain.device.fail ? { status: 'failed', error: 'the guest rejects this input' } : { status: 'done', secs: 240, publicValues: '0x' + '20'.padStart(64, '0') + '55'.repeat(96), proof: '0x' + '66'.repeat(48) });
    return r.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  await ctx.route('**/walletconnect.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const WC_PROJECT_ID = "test"; export function announceWalletConnect() { return { provider: null, disconnect: async () => {} }; } export function wcSheets() { return { onPair() {}, onAsk() {} }; } export function dialogHost() { return () => ({}); }' }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource/.test(t)) errors.push(t.slice(0, 200)); } });
  await page.goto(`http://127.0.0.1:${WEB}/teth/${hash}`);
  await page.waitForSelector('#wallet-chip');
  return { browser, page, errors, blocked, log, seen };
}
const posts = [];                                                                      // what the page (through the pool module) posted to the relay
const ux = (page) => page.evaluate(() => window.__ux);
const spnCfg = (page, o) => page.evaluate((x) => { (window.__spn ||= { calls: [], cfg: {} }); Object.assign(window.__spn.cfg, x); }, o);
const cfg = (page, o) => page.evaluate((x) => { (window.__ux ||= { calls: [], cfg: {} }); Object.assign(window.__ux.cfg, x); }, o);
const money = (page) => page.evaluate(() => ({ route: document.querySelector('#route')?.textContent.replace(/\s+/g, ' ').trim(), go: document.querySelector('#go').textContent, disabled: document.querySelector('#go').disabled }));

let r;
try {
  // ── a visitor with no wallet, at a desktop: what the page says on its own ──
  r = await openPage({ width: 1280, height: 1000 });
  let p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$') && document.querySelectorAll('.pf').length === 3 && document.querySelectorAll('#moves tbody tr').length > 3 && document.querySelector('#chart .line'));
  ok((await text(p, '#px-usd')) === '$2,441', `the headline is a tETH's dollar value, ETH's price: ${await text(p, '#px-usd')}`);
  ok((await p.title()) === 'tETH $2,441 · tacit', 'the tab names it and its price');
  const sub = await text(p, '#px-sub');
  const heldTxt = (Number(HELD) / 1e18).toFixed(2);
  ok(/1 tETH = 1 ETH, private/.test(sub) && sub.includes(`${heldTxt} ETH`) && /ETH transacted in 187 deposits · 64 wallets/.test(sub) && /24h: .* ETH moved/.test(sub) && !/ in .* out /.test(sub.replace(/made private in/, '')), `the line under it says what the pool holds, what has been made private in how many deposits, and what moved in a day (${sub.slice(0, 160)})`);
  const asset = await p.$$eval('.assets a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]));
  ok(asset.length === 3 && asset[0][1] === '/trade/tac/' && asset[1][0] === 'tETH' && asset[1][2] === 'page' && asset[2][1] === '/cbtc/', 'a switch names the three markets and marks this one');
  const sum = await text(p, '#hints-sum');
  ok(/Redeems for \$2,441/.test(sum) && /private pools \$\d/.test(sum) && /up to \d+% under ETH/.test(sum), `the dropdown's line gives the redeem value, the pools' range and how far the worst sits under ETH (${sum})`);
  await p.click('#hints summary');
  const lanes = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  await shot(p, 'lanes');
  ok(lanes.length === 4 && /Redeems for/.test(lanes[0]) && /tETH \/ TAC/.test(lanes[1]) && /tETH \/ cUSD/.test(lanes[2]) && /tETH \/ cBTC/.test(lanes[3]) && !lanes.some((l) => /On Bitcoin|not listed yet/.test(l)), `one lane for the redeem value and one for each pool that pairs tETH, named as the farms are; a Bitcoin book with nothing on it has none (${lanes.length})`);
  ok(lanes.every((l) => /1 tETH = /.test(l)) && /1 tETH = 1 ETH/.test(lanes[0]) && /one for one/.test(lanes[0]), `every lane says what one tETH is, in the lane's own money (${lanes.join(' | ')})`);
  const icons = await p.$$eval('#lanes .lane .k use', (us) => us.map((u) => u.getAttribute('href')));
  ok(icons.join() === '#tk-eth,#tk-tac,#tk-cusd,#tk-cbtc', `each lane wears its own token's icon, no two alike (${icons.join()})`);
  ok(lanes.slice(1).every((l) => /(under|over) ETH|level with ETH/.test(l) && /\$[\d.]+k? deep/.test(l)) && !lanes.some((l) => /apart/.test(l)), `each pool lane says which way it sits from ETH and how deep it is (${lanes.slice(1).join(' | ')})`);
  // the depth is what both sides are worth, a tETH at ETH's price and the other side at its own: not twice the tETH side
  {
    const rx = program.pools.find((x) => x.pair === 'cETH/cUSD').reserves, worth = Number(rx.reserveA) / 1e8 * 2441 + Number(rx.reserveB) / 1e8, twice = 2 * Number(rx.reserveA) / 1e8 * 2441;
    const kk = (x) => `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k`;
    ok(worth < twice && lanes[2].includes(`${kk(worth)} deep`) && !lanes[2].includes(`${kk(twice)} deep`), `the cUSD pool's depth is ${kk(worth)} (both sides at market), not ${kk(twice)} (twice the tETH side)`);
  }
  // each pool's price is its reserves' ratio, checked against the fixture
  const cusd = program.pools.find((x) => x.pair === 'cETH/cUSD'), per = Number(cusd.reserves.reserveB) / Number(cusd.reserves.reserveA);
  ok(lanes.some((l) => /cUSD pool/.test(l) && l.includes(`$${Math.round(per)}`) || l.includes(`$${per.toFixed(2)}`)), `the cUSD pool's price is its reserves' ratio, ${per.toFixed(2)} cUSD a tETH`);
  await p.keyboard.press('Escape');
  // the farms
  const farms = await p.$$eval('.pf', (as) => as.map((a) => ({ href: a.getAttribute('href'), t: a.textContent.replace(/\s+/g, ' ').trim() })));
  ok(farms.map((f) => f.href).join() === '/#card=earn:ether:p0,/#card=earn:ether:p1,/#card=earn:ether:p2', 'each farm opens on the front page\'s Earn card at its own pool');
  ok(/tETH \/ TAC/.test(farms[0].t) && /554 TAC a day/.test(farms[0].t) && /\d+%/.test(farms[0].t) && /ETH deep/.test(farms[0].t), `a farm says its pool, what it pays and its APR, and its depth (${farms[0].t.slice(0, 120)})`);
  const stat = await text(p, '#fm-stats');
  ok(/Best APR now/.test(stat) && /1,108 TAC/.test(stat) && /Stream ends/.test(stat), `the farms' figures (${stat.slice(0, 100)})`);
  const aprs = await p.$$eval('.pf .rt', (rs) => rs.map((x) => parseInt(x.firstChild.textContent.replace(/[^\d]/g, '')) || 0));
  // The APR is a year of the pool's TAC at TAC's price over what the farm holds of the pool, each side at its own price (farm-read.js works it out
  // for every page that shows it): checked for all three pools, two of which sit far from the market, where twice the tETH side would be wrong.
  const unitEth = { TAC: 1 / PER_ETH, cUSD: 1 / ETH_USD, cBTC: BTC_USD / ETH_USD };
  for (const [i, [pair, other]] of [['TAC/cETH', 'TAC'], ['cETH/cUSD', 'cUSD'], ['cETH/cBTC', 'cBTC']].entries()) {
    const fp = program.pools.find((x) => x.pair === pair), a = Number(fp.reserves.reserveA) / 1e8, b = Number(fp.reserves.reserveB) / 1e8, share = Number(fp.totalShares) / Number(fp.reserves.lpTotalShares);
    const perYear = Number(fp.tacPerDayForPool) * 365 / PER_ETH, wantApr = perYear / ((a + b * unitEth[other]) * share) * 100, doubled = perYear / (2 * a * share) * 100;
    ok(Math.abs(aprs[i] - wantApr) <= Math.max(1.5, wantApr * 0.003), `the ${other} pool's APR is a year of its TAC over what is bonded, both sides at market: ${aprs[i]}% (${wantApr.toFixed(1)}%)`);
    if (i > 0) ok(Math.abs(aprs[i] - doubled) > 20, `and it is not the figure from twice the tETH side, ${doubled.toFixed(0)}%`);
  }
  ok(/Sign in to see yours/.test(await text(p, '#fm-note')), 'signed out, the farms offer to show your positions');
  // the chart and the movements
  const bars = await p.evaluate(() => document.querySelector('#chart svg')?.querySelectorAll('.line').length);
  ok(bars >= 1, 'the chart draws the ETH held as a line');
  const read = await text(p, '#ch-read');
  ok(read.startsWith(`${heldTxt} ETH`) && /all time|past/.test(read), `the line above the chart reads what is held now (${read.slice(0, 70)})`);
  const ranges = await p.$$eval('#range-seg button', (b) => b.map((x) => x.textContent));
  ok(ranges.includes('All') && ranges.includes('1D') && ranges.length >= 3, `the ranges offered are those the history can fill: ${ranges.join(' ')}`);
  await p.click('#range-seg [data-range="1"]');
  await until(p, () => /past day/.test(document.querySelector('#ch-read').textContent));
  ok(/past day/.test(await text(p, '#ch-read')), 'a range changes what the chart and its readout cover');
  await p.click('#view-seg [data-unit="usd"]');
  ok(/^\$24,/.test((await text(p, '#ch-read'))), `dollars: the held ETH at today's rate (${(await text(p, '#ch-read')).slice(0, 30)})`);
  const mv = await p.$$eval('#moves tbody tr', (rs) => rs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(mv.length === 10 && /ETH (in|out)/.test(mv[0]) && /2 h ago/.test(mv[0]), `the newest ten movements, the newest first (${mv[0]})`);
  ok(/24h .* ETH moved · 7d .* ETH moved/.test(await text(p, '#mv-sum')), 'a line sums the day and the week');
  ok((await text(p, '#about')).includes('earns privately, on either chain'), 'the about text says what tETH is');
  await p.evaluate(() => { document.querySelector('#hints').open = true; });                   // the lanes sit in a closed dropdown, whose text is not drawn
  const heads = await p.$$eval('#fm-h, #b-h, #i-h, #lanes .lane .k', (els) => els.map((e) => e.innerText));
  await p.evaluate(() => { document.querySelector('#hints').open = false; });
  ok(heads.some((h) => /tETH/.test(h)) && !heads.some((h) => /TETH/.test(h)), `the label capitals leave the token's own spelling alone (${heads.join(' | ').replace(/\n/g, ' ')})`);
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error and nothing blocked by the CSP (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  // the pool's figures that can be read here
  const calls = r.seen.join(' ');
  ok(/\/stats\?network=mainnet&view=eth/.test(calls) && !r.seen.some((x) => /^\/stats\?network=mainnet$/.test(x)), 'the pool\'s own reading (~6 KB) for the head and its history, never the whole 176 KB one');
  await p.fill('#amt', '0.5');
  ok((await text(p, '#go')) === 'Connect wallet', 'with no wallet connected the button asks for one');
  await r.browser.close();

  // ── the pure figures, in the page's own module ──
  r = await openPage({ width: 1280, height: 900 });
  p = r.page;
  await p.waitForSelector('#px-usd');
  const pure = await p.evaluate(async () => {
    const m = await import('/teth/read.js');
    const out = {};
    const flows = [[100, 5n], [200, -2n], [200, 3n], [300, 4n]];
    const h = m.heldHistory(flows, 10n);
    out.hist = h.pts.map((x) => String(x.held)).join(); out.exact = h.exact;
    out.inexact = m.heldHistory(flows, 9n).exact;
    const day = 86400, base = 1000 * day;
    const pts = [{ t: base, held: 10n ** 18n, move: 10n ** 18n }, { t: base + 3 * day + 10, held: 3n * 10n ** 18n, move: 2n * 10n ** 18n }, { t: base + 3 * day + 20, held: 2n * 10n ** 18n, move: -(10n ** 18n) }];
    const bars = m.heldBars(pts, { tf: day, since: 0, spot: 5n * 10n ** 18n, at: base + 5 * day + 5 });
    out.bars = bars.map((b) => [b.close, b.held ? 1 : 0, b.vol, b.n, b.live ? 1 : 0].join(':')).join(' ');
    out.from = m.heldBars(pts, { tf: day, since: base + 2 * day, at: base + 5 * day + 5 }).map((b) => b.close).join();
    out.moved = Object.fromEntries(Object.entries(m.movedSince(pts, 2 * day, base + 4 * day)).map(([k, v]) => [k, String(v)]));
    out.ranges = [m.rangesFor(26).map((x) => x[0]).join(), m.rangesFor(100).map((x) => x[0]).join(), m.rangesFor(0).map((x) => x[0]).join()];
    out.sizes = [m.barSize(1, 26), m.barSize(7, 26), m.barSize(0, 26), m.barSize(0, 80), m.barSize(90, 200)];
    out.wrapIssue = [m.POOL.length];
    return out;
  });
  ok(pure.hist === '5,3,6,10' && pure.exact === true && pure.inexact === false, `the history is the running sum of the flows, and says when it does not end on the balance (${pure.hist})`);
  ok(pure.bars === '1:0:1:1:0 1:1:0:0:0 1:1:0:0:0 2:0:3:2:0 2:1:0:0:0 5:1:0:0:1', `bars: a quiet bar holds what was held, vol is what moved, the last is the balance (${pure.bars})`);
  ok(pure.from === '1,2,2,2', `a range opens at what was held then (${pure.from})`);
  ok(pure.moved.in === String(2n * 10n ** 18n) && pure.moved.out === String(10n ** 18n), 'movedSince counts only what is inside the window');
  ok(pure.ranges.join('|') === '1D,1W,All|1D,1W,1M,3M,All|1D,1W,All', `the ranges offered follow the history's length (${pure.ranges.join(' | ')})`);
  ok(pure.sizes.join() === '3600,14400,14400,86400,86400', `bar sizes follow the range (${pure.sizes.join()})`);
  // the pools' rows and positions, against the front page's arithmetic
  const rows = await p.evaluate(async (prog) => {
    const m = await import('/teth/read.js');
    const rows = m.poolRows(prog, { tacEth: 1 / 11000, ethUsd: 2441, btcUsd: 83000 });
    const mine = m.positionsIn(rows, [{ pid: 0, shares: String(Number(prog.pools[0].reserves.lpTotalShares) / 10), pendingTac: '1.5', unlockAt: 5 }, { pid: 9, shares: '5' }]);
    return { rows, mine: [...mine.entries()] };
  }, program);
  ok(rows.rows.length === 3 && rows.rows.map((x) => x.other).join() === 'TAC,cUSD,cBTC', 'a pool is a row only when it pairs tETH, in pool order');
  ok(Math.abs(rows.rows[0].per - Number(program.pools[0].reserves.reserveB) / Number(program.pools[0].reserves.reserveA)) < 1e-9, 'the price in a pool is its reserves\' ratio');
  ok(rows.mine.length === 1 && rows.mine[0][0] === 0 && Math.abs(rows.mine[0][1].teth - Number(program.pools[0].reserves.reserveA) / 1e8 / 10) < 1e-9 && rows.mine[0][1].earned === 1.5, 'a position is a share of the pool\'s two sides and what it earned; a pool not listed is left out');
  // what the relay says it can do: each read from a fresh copy of the module, so its 15-second memory does not answer for the endpoint
  const relayRead = (answer) => { chain.relay = answer; return p.evaluate(async () => (await import(`/teth/wrap.js?fresh=${Math.random()}`)).relayState()); };
  const reads = [await relayRead({ state: 'held', proving: true, settling: false, board: true, ageSeconds: 12 }), await relayRead({ state: 'paused', ageSeconds: 40 }), await relayRead({ state: 'busy' }), await relayRead({ state: 'asleep' }), await relayRead(null)];
  ok(JSON.stringify(reads) === JSON.stringify([{ state: 'held', proving: true, settling: false, board: true }, { state: 'paused', proving: false, settling: false, board: false }, { state: 'busy', proving: true, settling: true, board: false }, null, null]), `the relay's state is read from its endpoint, and an unknown state or no answer is no state at all (${JSON.stringify(reads)})`);
  chain.relay = { state: 'ok' };
  const firstRead = await p.evaluate(async () => { window.__w = await import(`/teth/wrap.js?fresh=${Math.random()}`); return (await window.__w.relayState()).state; });
  chain.relay = { state: 'paused' };
  const againRead = await p.evaluate(async () => (await window.__w.relayState()).state);
  ok(firstRead === 'ok' && againRead === 'ok', 'it is read at most every 15 seconds');
  chain.relay = null;
  const kinds = await p.evaluate(async () => {
    const w = await import('/teth/wrap.js'), pv = await import('/teth/prover.js');
    const err = (m, o = {}) => Object.assign(new Error(m), o), E = 10n ** 18n;
    const refused = err('relay 503: the relay is not proving right now', { code: 'relay_paused', httpStatus: 503 });
    const stopped = err('The relay isn’t proving right now.', { code: 'relay_paused', queued: true, proving: false });
    const stillProves = err('The relay isn’t proving right now.', { code: 'relay_paused', queued: true, proving: true });
    const held = err('The relay can’t send this one right now.', { code: 'relay_held', queued: true, proving: true });
    const row = (e) => [w.ownable(e), w.selfable(e), w.relayWords(e)];
    return { refused: row(refused), stopped: row(stopped), stillProves: row(stillProves), held: row(held),
      failed: row(err('settle failed: prove failed: guest exited with code 1')), slow: row(err('prove timed out (box offline or backlogged)')),
      proofs: [pv.proofsFor({ PROVE_PER_PROOF: 0.4 }, 2n * E, 45n * E / 100n), pv.proofsFor({ PROVE_PER_PROOF: 0.4 }, 85n * E / 100n, 45n * E / 100n), pv.proofsFor({ PROVE_PER_PROOF: 0.4 }, 44n * E / 100n, 45n * E / 100n), pv.proofsFor({ PROVE_PER_PROOF: 0.4 }, E, 578n * E / 1000n), pv.proofsFor({ PROVE_PER_PROOF: 0.4 }, 2n * E)] };
  });
  ok(kinds.refused[0] && !kinds.refused[1] && kinds.refused[2] === 'The relay isn’t proving right now. Your deposit is safe and waits to be finished.', `a relay_paused refusal offers the holder's own credit and not the wallet (which needs the relay's proof) (${kinds.refused[2]})`);
  ok(kinds.stopped[0] && !kinds.stopped[1] && kinds.stopped[2] === 'The relay isn’t proving right now. Your deposit is safe and keeps its place in line: it goes through once the relay is back.', `a wait the relay's pause ended offers the holder's credit, and says the job keeps its place (${kinds.stopped[2]})`);
  ok(kinds.stillProves[0] && kinds.stillProves[1] && /^The relay can’t send this one right now\./.test(kinds.stillProves[2]), 'one that has stopped sending but still proves offers the wallet as well');
  ok(!kinds.held[0] && kinds.held[1] && kinds.held[2] === 'The relay can’t send this one right now. It still proves it, so your wallet can send the settle.', `a held relay offers the wallet only (${kinds.held[2]})`);
  ok(kinds.failed[0] && kinds.slow[0] && !kinds.slow[1], 'a relayed job whose proof failed ("settle failed: prove failed: …") and a proof that ran out of time offer the holder\'s own credit');
  ok(![kinds.refused, kinds.stopped, kinds.stillProves, kinds.held].some((x) => /low on|out of|\bgas\b|credit|running low/i.test(x[2]) || /\bPROVE\b/.test(x[2])), 'none of the relay\'s words says it is short of anything');
  ok(kinds.proofs.join() === '4,2,0,2,5', `proofs are counted from what a request needs on hand, then about 0.4 PROVE each (${kinds.proofs.join()})`);
  await r.browser.close();

  // ── the wrap: a wallet connects, the key opens from its signature, one transaction pays the deposit and the tip ──
  r = await openPage({ width: 1280, height: 1000 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  await cfg(p, { held: 0, relayFirst: true });
  await p.click('#go');                                                                  // connects the wallet
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on') && document.querySelector('#in-bal') && !document.querySelector('#in-bal').hidden);
  ok((await text(p, '#in-bal')) === 'Balance 5 ETH · Max' && (await text(p, '#go')) === 'Enter an amount', 'connected: the balance shows and the button asks for an amount');
  await p.fill('#amt', '0.1');
  await until(p, () => /Relay tip/.test(document.querySelector('#route').textContent) && !/reading/.test(document.querySelector('#route').textContent));
  let m = await money(p);
  const total = 10n ** 17n + TIP, f6 = (v) => { const s = v.toString().padStart(19, '0'), i = s.length - 18; return `${s.slice(0, i)}.${s.slice(i, i + 6)}`.replace(/^0+(?=\d)/, ''); };
  ok(m.route.includes(`Relay tip${f6(TIP)} ETH`) && m.route.includes(`Your wallet sends${f6(total)} ETH`), `the receipt shows the tip and what the wallet sends (${m.route.slice(0, 110)})`);
  ok(m.go === 'Sign in to make ETH private' && !m.disabled, 'with no key open the button says it signs in first');
  ok((await text(p, '#out')) === '0.1' && /≈ \$244/.test(await text(p, '#out-usd')), 'the output is the same amount, one for one, with its dollar value');
  await p.fill('#amt', '0.123456789');
  await until(p, () => /8 decimals/.test(document.querySelector('#go').textContent));
  ok((await text(p, '#go')) === 'Up to 8 decimals' && (await money(p)).disabled, 'an amount finer than the pool moves is refused before anything is asked');
  await p.fill('#amt', '99');
  await until(p, () => document.querySelector('#go').textContent === 'Not enough ETH');
  ok((await money(p)).disabled, 'more than the wallet holds is refused');
  await p.click('#in-bal');
  await until(p, () => document.querySelector('#amt').value !== '99');
  ok((await p.inputValue('#amt')) === '4.99567121', `Max keeps the network fee and the relay's tip back (${await p.inputValue('#amt')})`);
  await p.fill('#amt', '0.1');
  await until(p, () => document.querySelector('#go').textContent === 'Sign in to make ETH private');
  await shot(p, 'quote');
  await cfg(p, { indexMs: 300, settleMs: 1500, held: 10000000 });
  await p.click('#go');
  await p.waitForSelector('.bsheet.top .opts');
  const ways = await text(p, '.bsheet.top');
  ok(/Ethereum wallet/.test(ways) && /Open your Tacit wallet/.test(ways) && !/Bitcoin wallet/.test(ways), 'the key is offered from an Ethereum wallet or a passkey (no Bitcoin wallet: that is tacit.finance\'s)');
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => !document.querySelector('.bsheet'), null, 15000);
  await until(p, () => /Preparing your note|relay is proving|Confirm in your wallet/.test(document.querySelector('#status').textContent) || document.querySelector('#steps li[data-s="now"]'));
  await shot(p, 'steps');
  const steps = await p.$$eval('#steps li', (ls) => ls.map((l) => `${l.dataset.s}:${l.textContent}`));
  ok(steps.length === 5 && /^done:Open your Tacit wallet/.test(steps[0]) && steps.some((x) => /Tacit’s relay proves it/.test(x)), `the steps show, the key's already done, and the relay proves it first (${steps.map((x) => x.split(':')[0]).join(' ')})`);
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  ok(r.log.signs === 2, 'the wallet signed the identity message twice, as a first derivation does');
  ok(r.log.sends.length === 1, 'one transaction was sent');
  const tx = r.log.sends[0].tx;
  // The relay's sponsored proof comes first, then one transaction deposits and settles it, the tip riding on it to the relay's address.
  ok(tx.to.toLowerCase() === ROUTER.toLowerCase() && tx.data.startsWith('0x50de88e1'), 'it goes to the router as one wrapAndSettleETH');
  ok(BigInt(tx.value) === total, `it carries the deposit and the tip together (${BigInt(tx.value)} = ${total})`);
  ok(tx.from.toLowerCase() === r.log.account.toLowerCase(), 'it comes from the connected account');
  let u = await ux(p);
  const wc = u.calls.filter((c) => c[0] !== 'balance'), called = wc.map((c) => c[0]);
  ok(called.slice(0, 4).join() === 'nextWrapIndex,proveWrap,buildWrap,wrapSettleCall', `the module is asked for the next index, then the relay's proof, then the call (${called.join()})`);
  ok(u.calls.some((c) => c[0] === 'balance') && u.calls.findIndex((c) => c[0] === 'balance') < u.calls.findIndex((c) => c[0] === 'nextWrapIndex'), 'a key just opened is read before it is given a note');
  ok(wc[0][1] === 'cETH' && wc[0][2] === 32, 'the index is asked for tETH with the key as 32 bytes');
  ok(wc[1][1] === String(10n ** 17n) && wc[1][3] === 7 && wc[1][4] === 'relay', 'the relay proves the note for the amount at that index');
  ok(wc[3][2] === String(TIP) && String(wc[3][3]).toLowerCase() === RELAY.toLowerCase(), `the call pays the relay's tip to its address (${wc[3].slice(2).join(' ')})`);
  ok(r.seen.includes('/confidential/relay') && !/then the settle/.test(m.route), 'the relay\'s state is asked for, and with no answer (404) the relay proves it as before');
  ok(/tETH is private now/.test(await text(p, '#status')) && (await p.inputValue('#amt')) === '' , 'it says it is done and clears the amount');
  ok((await p.$$eval('#steps li', (ls) => ls.every((l) => l.dataset.s === 'done'))), 'every step shows done');
  // what the key holds shows in Use tETH
  await p.click('#mode-seg [data-mode="use"]');
  await until(p, () => /0\.1\b/.test(document.querySelector('#held')?.textContent || ''), null, 30000);
  ok(/0\.1 .*tETH, private/.test(await text(p, '#held')), `Use tETH shows the key's private tETH (${await text(p, '#held')})`);
  ok(!/on Bitcoin/.test(await text(p, '#held')), 'and no line about Bitcoin while the key is not known to hold any there');
  // What the front page last read on the key's Bitcoin address (kept in this browser) shows beside it, with the way to bring it back. The test cannot
  // name the key's public key, so the stored map answers for any.
  await p.evaluate(() => {
    const real = JSON.parse;
    JSON.parse = (t, r) => { const v = real(t, r); return v && typeof v === 'object' && v.__bridged_probe__ ? new Proxy({}, { get: () => ({ teth: { v: '700000', n: 2, ready: 1, at: Date.now() } }) }) : v; };
    localStorage.setItem('tacit-bridged-v1', '{"__bridged_probe__":1}');
  });
  await p.click('#mode-seg [data-mode="get"]'); await p.click('#mode-seg [data-mode="use"]');
  await until(p, () => /tETH on Bitcoin/.test(document.querySelector('#held')?.textContent || ''), null, 15000);
  ok(/0\.007\s+tETH on Bitcoin, in 2 notes/.test(await text(p, '#held')) && (await p.$eval('#held a.linkbtn', (a) => a.getAttribute('href'))) === '/#private/bitcoin/back', `a key that holds tETH on Bitcoin sees it beside its private balance, with a way to bring it back (${await text(p, '#held')})`);
  const links = await p.$$eval('#uses a.use', (as) => as.map((a) => [a.querySelector('b').textContent, a.getAttribute('href')]));
  ok(links.length === 6 && links[0][1] === '/#private/send' && links.find((l) => /Bridge/.test(l[0]))[1] === '/#private/bitcoin/out' && links.find((l) => /Bring tETH back/.test(l[0]))[1] === '/#private/bitcoin/back' && links.find((l) => /Back to ETH/.test(l[0]))[1] === '/#card=shield:eth:wallet', `six ways on, each a link that opens tacit.finance ready (${links.map((l) => l[1]).join(' ')})`);
  await p.fill('#use-amt', '0.05');
  const links2 = await p.$$eval('#uses a.use', (as) => as.map((a) => a.getAttribute('href')));
  ok(links2.filter((h) => h.includes('&amt=0.05')).length === 2 && !links2.some((h) => /private\/bitcoin.*amt/.test(h)), `the amount rides on the swap and take-out links (the bridge asks for its own) (${links2.filter((h) => h.includes('amt')).join(' ')})`);
  ok((await ux(p)).calls.some((c) => c[0] === 'balance' && /"positions":true/.test(c[2]) && /"cbtc":false/.test(c[2])), 'the key\'s balance and farm positions come from one scan');
  await shot(p, 'use');
  await p.click('#mode-seg [data-mode="get"]');

  // ── the same key, on a farm: positions show on their pool ──
  await cfg(p, { positions: [{ pid: 1, shares: String(Math.round(Number(program.pools[1].reserves.lpTotalShares) / 4)), pendingTac: '3.25', unlockAt: 0 }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelectorAll('.pf .tag').length === 1, null, 20000);
  await shot(p, 'position');
  const mine = await text(p, '.pf .sb.mine');
  ok(/Yours: .* tETH \+ .* cUSD · 3\.25 TAC earned/.test(mine) && (await p.$$eval('.pf', (as) => as.findIndex((a) => a.querySelector('.tag')))) === 1, `a position shows on its farm: what it holds and has earned (${mine})`);
  await p.click('#mode-seg [data-mode="get"]');

  // ── a rejected transaction, the relay failing after the deposit, and its retry ──
  // From here the relay has no sponsored proofs left today, so a wrap's deposit goes first and the relay proves and settles it after.
  await cfg(p, { settleMs: 0, indexMs: 0, settleFails: 0, proveRefused: true });
  r.log.reject = true;
  await p.fill('#amt', '0.02');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => /Cancelled in your wallet/.test(document.querySelector('#status').textContent));
  ok(/Nothing was sent/.test(await text(p, '#status')) && (await text(p, '#go')) === 'Shield ETH' && !(await money(p)).disabled && r.log.sends.length === 1, 'a refusal in the wallet sends nothing and leaves the ticket as it was');
  ok(r.log.signs === 2, 'the key was not asked for again');
  r.log.reject = false;
  await cfg(p, { settleFails: 1 });
  await p.click('#go');
  await until(p, () => /not private yet/.test(document.querySelector('#status').textContent), null, 20000);
  const st = await text(p, '#status');
  ok(/still working on it/.test(st) && /0\.02 ETH is in the Tacit pool, but it is not private yet/.test(st) && /no need to send it again/.test(st) && /Private ETH tab/.test(st), `a relay that fails after the deposit says where it is and that it is not asked for again (${st.slice(0, 140)})`);
  ok(r.log.sends.length === 2, 'one deposit went out, not two');
  const dep = r.log.sends[1].tx;
  ok(dep.to.toLowerCase() === WRAP_TIP.toLowerCase() && dep.data.startsWith('0xfc24c435') && dep.data.endsWith(RELAY.slice(2).toLowerCase().padStart(64, '0')),
    'with no sponsored proofs left, the deposit goes first: to the wrap forwarder, with the relay\'s tip');
  ok((await p.inputValue('#amt')) === '' && (await text(p, '#go')) === 'Finish the earlier deposit first' && (await money(p)).disabled, 'the form is cleared and cannot make the deposit again while it is unfinished');
  await p.fill('#amt', '0.02');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(600);
  ok(r.log.sends.length === 2, 'Enter on a refilled form sends nothing either');
  await p.fill('#amt', '');
  const built0 = (await ux(p)).calls.filter((c) => c[0] === 'nextWrapIndex' || c[0] === 'buildWrap').length;
  await p.click('#retry');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const subs = u.calls.filter((c) => c[0] === 'submitWrapSettle');
  ok(subs.length === 2 && subs[1][1] === subs[0][1] && subs[1][2] === r.log.sends[1].hash, 'finishing asks the relay for the same note from the same deposit');
  ok(u.calls.filter((c) => c[0] === 'nextWrapIndex' || c[0] === 'buildWrap').length === built0, 'and builds nothing new');
  ok((await text(p, '#go')) === 'Enter an amount', 'the ticket is free again');
  // Lock forgets what a retry holds
  await cfg(p, { settleFails: 1 });
  await p.fill('#amt', '0.02');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => document.querySelector('#retry'), null, 20000);
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-lock');
  await until(p, () => document.querySelector('#signin'));
  await p.click('#mode-seg [data-mode="get"]');
  ok(!(await p.$('#retry')) && (await text(p, '#status')) === '' && (await text(p, '#go')) !== 'Finish the earlier deposit first', 'Lock drops the unfinished deposit\'s retry (it holds the note\'s secrets)');
  // the key again, for what follows
  await p.fill('#amt', '0.03');
  await until(p, () => document.querySelector('#go').textContent === 'Sign in to make ETH private');
  await cfg(p, { pending: [{ index: 9, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 2000000, txHash: '0x' + 'ee'.repeat(32) }] });
  await p.click('#go'); await p.waitForSelector('.bsheet.top [data-in="known"], .bsheet.top [data-in="eth"]');
  await p.click('.bsheet.top [data-in="known"], .bsheet.top [data-in="eth"]');
  await until(p, () => /waiting to become private/.test(document.querySelector('#status').textContent), null, 30000);
  ok(r.log.sends.length === 3 && /Press Finish above/.test(await text(p, '#status')) && (await p.$('#finish')), `a key opened for a deposit looks for deposits waiting first, and stops to say so before it makes another (${r.log.sends.length} sends; ${await text(p, '#status')})`);
  await p.click('#mode-seg [data-mode="use"]');
  ok(!!(await p.$eval('#finish', (b) => b.offsetParent !== null)), 'and the Finish is in view from Use tETH too');
  await p.click('#mode-seg [data-mode="get"]');
  await cfg(p, { pending: [] });
  await p.click('#finish');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 20000);
  await p.fill('#amt', '0.02');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  ok(r.log.sends.length === 4, `with nothing waiting the deposit goes (${r.log.sends.length} sends; ${await text(p, '#status')})`);
  // the deposit reverted
  chain.receipt = 'revert';
  await p.fill('#amt', '0.03');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => /The transaction failed/.test(document.querySelector('#status').textContent), null, 20000);
  ok(!/not private yet/.test(await text(p, '#status')) && !(await p.$('#retry')) && (await text(p, '#go')) !== 'Finish the earlier deposit first', 'a deposit that reverted is not called waiting and offers no retry');
  chain.receipt = 'ok';
  // the index could not be read
  await cfg(p, { indexFails: true });
  await p.fill('#amt', '0.04');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled);
  const before = r.log.sends.length;
  await p.click('#go');
  await until(p, () => /could not read this asset/.test(document.querySelector('#status').textContent));
  ok(r.log.sends.length === before, 'a failure before the deposit sends nothing');
  await cfg(p, { indexFails: false });

  // ── a deposit that landed and was never settled is found from the key, and finished ──
  await cfg(p, { pending: [{ index: 3, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 10000000, txHash: '0x' + 'cd'.repeat(32) }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelector('#finish'), null, 20000);
  ok(/0\.1 ETH is waiting to become private/.test(await text(p, '#waiting')), `a waiting deposit shows with a Finish (${await text(p, '#waiting')})`);
  await p.click('#mode-seg [data-mode="get"]');
  await cfg(p, { pending: [] });
  await p.click('#finish');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const lastBuild = [...u.calls].reverse().find((c) => c[0] === 'buildWrap'), lastSub = [...u.calls].reverse().find((c) => c[0] === 'submitWrapSettle');
  ok(lastBuild[1] === String(10000000n * 10n ** 10n) && lastBuild[3] === 3 && lastSub[1] === 3 && lastSub[2] === '0x' + 'cd'.repeat(32), 'Finish rebuilds the note at its own index and amount, and gives the relay its deposit');
  // ── the relay refuses the settle: the deposit is finished from the wallet, which sends the relay's proof itself ──
  const deposit = async (amt) => {
    await p.fill('#amt', amt);
    await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled);
    await p.click('#go');
  };
  const lastCall = (u2, name) => [...u2.calls].reverse().find((c) => c[0] === name);
  const count = (u2, name, f = () => true) => u2.calls.filter((c) => c[0] === name && f(c)).length;
  const fee = (GAS_PRICE * 593000n).toString().padStart(19, '0'), feeTxt = `0.${fee.slice(1, 6).replace(/0+$/, '')}`;
  await cfg(p, { settleRefuse: 'free_budget' });
  events.length = 0;
  await deposit('0.05');
  await until(p, () => document.querySelector('#self'), null, 20000);
  await until(p, () => /about 0\.\d+ ETH/.test(document.querySelector('#status').textContent), null, 10000);
  let sst = await text(p, '#status');
  ok(/free settles for today are used up/.test(sst) && sst.includes(`Finish it from your wallet: Test Wallet pays the network fee (about ${feeTxt} ETH).`) && /ask the relay again/.test(sst) && /no need to send it again/.test(sst), `a refused settle offers to finish from the wallet, and says what the network fee is (${sst.slice(0, 260)})`);
  ok(!/low on|out of gas|running low|no gas/i.test(sst), 'nothing says the relay is short of anything');
  ok((await text(p, '#go')) === 'Finish the earlier deposit first', 'the ticket waits for the deposit to be finished');
  const depositHash = r.log.sends.at(-1).hash;
  await p.click('#self');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const stx = r.log.sends.at(-1).tx, cd = lastCall(u, 'settleCalldata');
  ok(stx.to.toLowerCase() === POOL.toLowerCase() && stx.data === cd[1] && cd[1].startsWith('0x717fd7f2') && !stx.value && stx.from.toLowerCase() === r.log.account.toLowerCase(), 'the wallet sends settle(publicValues, proof, memos) to the pool, with no value, from the connected account');
  const ord = events.map((x) => x[0]);
  ok(ord.join() === 'send,sim,send' && events[1][1].data === stx.data && events[1][1].from.toLowerCase() === r.log.account.toLowerCase(), `the settle is tried with eth_call from the wallet's account before the wallet is asked (${ord.join()})`);
  const selfSub = lastCall(u, 'submitWrapSettle');
  ok(selfSub[4] === 'self' && selfSub[2] === depositHash, 'with no proof held, the relay is asked to prove only, for the same deposit');
  const ld = lastCall(u, 'landed');
  ok(ld && ld[2] === r.log.sends.at(-1).hash && /^job-\d+$/.test(ld[1]), `the API is told the job landed, with the settle's hash (${ld && ld.slice(1).join(' ')})`);
  ok(/tETH is private now/.test(await text(p, '#status')) && /Settled from your wallet/.test(await text(p, '#status')) && (await text(p, '#go')) === 'Enter an amount', 'it says it is done, and the ticket is free again');

  // a job the relay proved and holds for a sender: the wallet sends that proof, and nothing is proved again
  await cfg(p, { settleOpen: true });
  await deposit('0.06');
  await until(p, () => document.querySelector('#self'), null, 20000);
  sst = await text(p, '#status');
  ok(/proved and waiting to be sent/.test(sst) && /Finish it from your wallet/.test(sst), `an open job says its note is proved and offers the wallet (${sst.slice(0, 120)})`);
  let before2 = await ux(p);
  const selfSubs = count(before2, 'submitWrapSettle', (c) => c[4] === 'self'), waits = count(before2, 'waitForSettle');
  await p.click('#self');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  ok(count(u, 'submitWrapSettle', (c) => c[4] === 'self') === selfSubs && count(u, 'waitForSettle') === waits, 'the proof the relay holds is sent at once: no new proof, no wait');
  ok(r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && r.log.sends.at(-1).tx.data === lastCall(u, 'settleCalldata')[1] && lastCall(u, 'settleCalldata')[1].includes('ab'.repeat(96)), 'the wallet sends that proof to the pool');
  ok(lastCall(u, 'provenMemos') && lastCall(u, 'landed')[1] === `job-${u.jobs}` && lastCall(u, 'verifyEmittedMemos')[2] === r.log.sends.at(-1).hash, 'its memos are checked against the note first, the job is reported landed, and the emitted memos are checked');

  // a relay sent it meanwhile: the try reverts, the pool says the deposit is consumed, and nothing is sent
  await cfg(p, { settleOpen: true });
  chain.settleSim = 'revert';
  await deposit('0.07');
  await until(p, () => document.querySelector('#self'), null, 20000);
  const sendsNow = r.log.sends.length;
  await p.click('#self');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  ok(r.log.sends.length === sendsNow && !/Settled from your wallet/.test(await text(p, '#status')), 'a settle that would revert because the deposit is already consumed is done, with nothing sent');
  chain.settleSim = 'ok'; chain.deposit = 'waiting';

  // the wait ran out: the relay's job is waited on until it is proved, then sent from the wallet
  await cfg(p, { settleFails: 1, waitOpen: true });
  await deposit('0.08');
  await until(p, () => document.querySelector('#self'), null, 20000);
  ok(/still working on it/.test(await text(p, '#status')), 'a wait that ran out offers the wallet too');
  await p.click('#self');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const wf = lastCall(u, 'waitForSettle');
  ok(wf[1] === `job-${u.jobs}` && wf[2] === 0 && lastCall(u, 'landed')[1] === wf[1] && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase(), `the same job is waited on (no grace once it is open) and its proof sent (${wf.join(' ')})`);

  // no proofs left today: said plainly, and the wallet is not offered (it needs the relay's proof too)
  await cfg(p, { settleRefuse: 'prove_budget' });
  await deposit('0.09');
  await until(p, () => document.querySelector('#retry'), null, 20000);
  sst = await text(p, '#status');
  ok(/as many proofs as it can for today\. Try again after midnight UTC\. Your deposit is safe and waits to be finished\./.test(sst) && !(await p.$('#self')), `a relay with no proofs left says so and offers no wallet finish (${sst.slice(0, 160)})`);
  ok(/Or prove it with your own credit\./.test(sst) && !!(await p.$('#status #own')), 'where the relay cannot prove, proving with your own credit is offered');
  await p.click('#retry');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);

  // a waiting deposit the relay will not take: Finish offers the wallet, which finishes it
  await cfg(p, { pending: [{ index: 5, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 3000000, txHash: '0x' + 'c5'.repeat(32) }], settleRefuse: 'relay_held' });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelector('#finish'), null, 20000);
  await p.click('#mode-seg [data-mode="get"]');
  await p.click('#finish');
  await until(p, () => document.querySelector('#self-pending'), null, 20000);
  sst = await text(p, '#status');
  ok(/can’t take this one right now/.test(sst) && /Finish from your wallet: Test Wallet pays the network fee/.test(sst), `a refused Finish offers the wallet (${sst.slice(0, 160)})`);
  await cfg(p, { pending: [] });
  const pendSends = r.log.sends.length;
  await p.click('#self-pending');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  ok(r.log.sends.length === pendSends + 1 && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && lastCall(u, 'submitWrapSettle')[2] === '0x' + 'c5'.repeat(32) && lastCall(u, 'submitWrapSettle')[4] === 'self' && lastCall(u, 'buildWrap')[3] === 5, 'the waiting deposit is rebuilt from the key and settled from the wallet');

  // a waiting deposit the relay proved earlier, with the memos it was first sent with: Finish's rebuilt note has others, so no proof comes back
  // with the refusal; the wallet waits on the job, checks the relay's memos open to the note, and sends the proof with them
  await cfg(p, { pending: [{ index: 6, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 4000000, txHash: '0x' + 'c6'.repeat(32) }], settleOpenElse: true, waitOpen: true, memosOpen: true });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelector('#finish'), null, 20000);
  await p.click('#mode-seg [data-mode="get"]');
  await p.click('#finish');
  await until(p, () => document.querySelector('#self-pending'), null, 20000);
  ok(/proved and waiting to be sent/.test(await text(p, '#status')), `a held job without its proof still offers the wallet (${(await text(p, '#status')).slice(0, 100)})`);
  await cfg(p, { pending: [] });
  await p.click('#self-pending');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const heldJob = lastCall(u, 'waitForSettle');
  ok(heldJob[2] === 0 && lastCall(u, 'landed')[1] === heldJob[1] && r.log.sends.at(-1).tx.data.includes('dd'.repeat(41)) && count(u, 'submitWrapSettle', (c) => c[2] === '0x' + 'c6'.repeat(32) && c[4] === 'self') === 0, 'the job Finish asked for is waited on, and its proof sent with the relay\'s memos once they open to the note; nothing is proved again');
  await cfg(p, { memosOpen: false });

  // ── proving it yourself: the prover account and its credit, PROVE added from the wallet, and the switch ──
  const { secp: nsecp, keccak_256: nkeccak } = await import(new URL('../dapp/vendor/tacit-deps.min.js', import.meta.url).href);
  const hexb = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
  const kec = (h) => '0x' + Buffer.from(nkeccak(typeof h === 'string' ? hexb(h) : h)).toString('hex');
  ok(/Proved byTacit’s relay · Prove it yourself/.test(await text(p, '#prover-line')), `the ticket says who proves the deposit, and offers to prove it yourself (${await text(p, '#prover-line')})`);
  await spnCfg(p, { credit: '0' });
  await p.click('#prover-line #ps-open');
  await until(p, () => /Credit/.test(document.querySelector('.bsheet #ps-acct')?.textContent || '') && !/reading/.test(document.querySelector('.bsheet #ps-acct').textContent), null, 20000);
  let sheet = await text(p, '.bsheet');
  ok(sheet.includes(`${ACCT.address.slice(0, 8)}…${ACCT.address.slice(-6)}`) && /your Tacit account/.test(sheet) && /Credit0 PROVE · enough for about 0 proofs/.test(sheet), `the sheet shows the prover account (the Tacit account) and its credit (${sheet.slice(0, 260)})`);
  ok(/go to Succinct’s own prover as a private input, passing through Tacit’s API without being kept/.test(sheet) && !/never sees|neither proves/.test(sheet) && /no relay tip/.test(sheet) && /about 0\.39 PROVE/.test(sheet) && !(await p.$eval('#ps-on', (x) => x.checked)), 'it says where the private input goes, what a failed request costs, and the switch starts off');
  await until(p, () => /Wallet 10 PROVE/.test(document.querySelector('#ps-bal')?.textContent || ''), null, 15000);
  ok((await p.inputValue('#ps-amt')) === '2' && (await text(p, '#ps-go')) === 'Add PROVE', 'Add PROVE starts at 2 PROVE, with the wallet\'s PROVE shown');
  events.length = 0;
  const fundFrom = r.log.sends.length;
  await p.click('#ps-go');
  await until(p, () => /Added\./.test(document.querySelector('#ps-status')?.textContent || ''), null, 20000);
  const fundTx = r.log.sends.slice(fundFrom).map((x) => x.tx);
  ok(fundTx.length === 2 && fundTx[0].to.toLowerCase() === PROVE_TOKEN.toLowerCase() && fundTx[0].data === cast('calldata', 'transfer(address,uint256)', ACCT.address, (2n * E18N).toString()) && !fundTx[0].value, 'the wallet sends 2 PROVE to the Tacit account');
  const pd = fundTx[1]?.data || '', pw = (i) => pd.slice(10 + i * 64, 10 + (i + 1) * 64);
  ok(fundTx[1]?.to.toLowerCase() === VAPP.toLowerCase() && pd.startsWith('0x58981c7e') && BigInt('0x' + pw(0)) === BigInt(ACCT.address) && BigInt('0x' + pw(1)) === 2n * E18N && !fundTx[1].value, 'then the network\'s permitAndDeposit for the Tacit account and 2 PROVE');
  {
    const deadline = BigInt('0x' + pw(2)), v = Number(BigInt('0x' + pw(3))), rr = BigInt('0x' + pw(4)), ss = BigInt('0x' + pw(5));
    const typeHash = kec(new TextEncoder().encode('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
    const struct = kec(typeHash + w32(BigInt(ACCT.address)) + w32(BigInt(VAPP)) + w32(2n * E18N) + w32(PERMIT_NONCE) + w32(deadline));
    const digest = kec('0x1901' + DOMAIN_SEP.slice(2) + struct.slice(2));
    const pub = new nsecp.Signature(rr, ss, v - 27).recoverPublicKey(hexb(digest).slice()).toRawBytes(false);
    const signer = '0x' + kec(pub.slice(1)).slice(-40);
    ok(signer === ACCT.address.toLowerCase() && deadline > BigInt(nowS()), `its permit recovers to the Tacit account (${signer})`);
  }
  ok(events.map((x) => x[0]).join() === 'sim,send,sim,send' && events[0][1].from.toLowerCase() === r.log.account.toLowerCase() && events[2][1].to.toLowerCase() === VAPP.toLowerCase(), `each is tried with eth_call from the wallet before it is sent (${events.map((x) => x[0]).join()})`);
  ok(/within about 5 minutes/.test(await text(p, '#ps-status')) && prove.deposited === 2n * E18N && prove.acct === 0n, 'it says the network shows the credit within about 5 minutes');
  await spnCfg(p, { credit: String(2n * E18N) });
  await p.click('.bsheet .x'); await p.click('#prover-line #ps-open');
  await until(p, () => /2 PROVE · enough for about 4 proofs/.test(document.querySelector('.bsheet #ps-acct')?.textContent || ''), null, 20000);
  ok(true, 'once the network shows it, the credit and the proofs it pays for: the first needs 0.45 PROVE on hand, each after it about 0.4');
  await shot(p, 'own-sheet');
  // the Tacit account already holds what is asked: only the deposit is sent
  prove.acct = 3n * E18N;
  await p.click('.bsheet .x'); await p.click('#prover-line #ps-open');
  await until(p, () => /your wallet sends only the deposit/.test(document.querySelector('.bsheet #ps-quote')?.textContent || ''), null, 20000);
  const onlyFrom = r.log.sends.length;
  await p.click('#ps-go');
  await until(p, () => /Added\./.test(document.querySelector('#ps-status')?.textContent || ''), null, 20000);
  ok(r.log.sends.length === onlyFrom + 1 && r.log.sends.at(-1).tx.to.toLowerCase() === VAPP.toLowerCase(), 'PROVE the Tacit account already holds is deposited with no transfer from the wallet');
  prove.acct = 0n;
  // ETH swapped to PROVE for the Tacit account, then deposited
  await p.click('.bsheet [data-ps-mode="eth"]');
  await p.fill('#ps-amt', '0.1');
  await until(p, () => /At least/.test(document.querySelector('#ps-quote')?.textContent || ''), null, 15000);
  const zq = quoted.at(-1).slice(10), zw = (i) => BigInt('0x' + zq.slice(i * 64, i * 64 + 64));
  ok(quoted.at(-1).startsWith('0xe7798987') && zw(0) === BigInt(ACCT.address) && zw(1) === 0n && zw(2) === 0n && zw(3) === BigInt(PROVE_TOKEN) && zw(4) === 10n ** 17n && zw(5) === 100n, 'zQuoter is asked for ETH to PROVE with the Tacit account as the recipient and a 1% guard');
  ok(/You get about250 PROVE/.test(await text(p, '#ps-quote')) && /At least247\.5 PROVE · 1% slippage guard/.test(await text(p, '#ps-quote')) && (await text(p, '#ps-go')) === 'Swap and add', `the quote says what it buys and the least it may (${await text(p, '#ps-quote')})`);
  const ethFrom = r.log.sends.length;
  await p.click('#ps-go');
  await until(p, () => /Added\./.test(document.querySelector('#ps-status')?.textContent || ''), null, 20000);
  const ethTx = r.log.sends.slice(ethFrom).map((x) => x.tx);
  ok(ethTx.length === 2 && ethTx[0].to.toLowerCase() === ZROUTER.toLowerCase() && ethTx[0].data === lastExactIn && BigInt(ethTx[0].value) === 10n ** 17n && ethTx[1].to.toLowerCase() === VAPP.toLowerCase() && BigInt('0x' + ethTx[1].data.slice(74, 138)) === 250n * E18N, 'the wallet sends the swap to zRouter with the ETH, then the deposit of all the PROVE it bought');
  // The quick sizes: the ETH that makes the credit enough for N proofs, from the quoter's price (2 PROVE held, 0.45 needed on hand, 0.4 spent a proof).
  const sizes = await text(p, '#ps-size');
  ok(/^Add enough for 5 proofs · 20 proofs$/.test(sizes), `the sheet offers the sizes the credit does not already cover (${sizes})`);
  for (const [n, want] of [[5, 205n * 10n ** 16n - 2n * E18N], [20, 805n * 10n ** 16n - 2n * E18N]]) {
    const at = quoted.length;
    await p.click(`#ps-size [data-ps-size="${n}"]`);
    await until(p, (k) => new RegExp(`then covers\\s*about ${k} proofs`).test(document.querySelector('#ps-quote')?.textContent || ''), n, 15000);
    const asks = quoted.slice(at).map((d) => ({ exactOut: BigInt('0x' + d.slice(10 + 64, 10 + 128)) === 1n, amount: BigInt('0x' + d.slice(10 + 4 * 64, 10 + 5 * 64)) }));
    const eth = await p.inputValue('#ps-amt'), box = await text(p, '#ps-quote');
    ok(asks[0]?.exactOut && asks[0].amount === want && asks.slice(1).every((a) => !a.exactOut), `${n} proofs: zQuoter is asked what ${Number(want) / 1e18} PROVE costs, then for the swap itself (${asks.length} asks)`);
    ok(Number(eth) > 0 && new RegExp(`then covers\\s*about ${n} proofs`).test(box) && (await text(p, '#ps-go')) === 'Swap and add', `${n} proofs: the ETH is filled in (${eth}) and the quote says ${box.slice(0, 120)}`);
  }
  await p.click('.bsheet [data-ps-mode="prove"]');
  ok(await p.evaluate(() => document.querySelector('#ps-size').hidden), 'the sizes belong to the ETH route only');

  // the switch on: the note is proved with the holder's own credit before any ETH moves, then one transaction deposits and settles it; nothing reaches the relay
  await p.check('#ps-on');
  await p.click('.bsheet .x');
  await until(p, () => /your own PROVE credit, enough for about 4 proofs/.test(document.querySelector('#prover-line').textContent), null, 10000);
  ok(await p.evaluate(() => /"[0-9a-f]{66}":true/.test(localStorage.getItem('tacit-trade-own-prover-v1') || '')), 'the choice is kept for this key, in this browser');
  const quotesBefore = r.seen.filter((x) => x.startsWith('/confidential/quote')).length, postsBefore = posts.length;
  await p.fill('#amt', '0.04');
  await until(p, () => /Relay tipnone: you prove it yourself/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Shield ETH', null, 10000);
  ok(/0\.04 ETH in one transaction/.test(await text(p, '#route')) && r.seen.filter((x) => x.startsWith('/confidential/quote')).length === quotesBefore, `the receipt has no relay tip, one transaction, and the relay is not asked for one (${await text(p, '#route')})`);
  await spnCfg(p, { proveMs: 600 });
  events.length = 0;
  const ownFrom = r.log.sends.length;
  await p.click('#go');
  await until(p, () => /Succinct’s prover/.test(document.querySelector('#status').textContent), null, 20000);
  const midSteps = await p.$$eval('#steps li', (ls) => ls.map((l) => l.textContent));
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  const ownTx = r.log.sends.slice(ownFrom).map((x) => x.tx);
  ok(ownTx.length === 1 && ownTx[0].to.toLowerCase() === ROUTER.toLowerCase() && BigInt(ownTx[0].value) === 4n * 10n ** 16n && ownTx[0].data.startsWith('0x50de88e1'), 'one transaction to the router deposits exactly the amount, with no tip');
  ok(ownTx[0].data.includes('77'.repeat(96)) && ownTx[0].data.includes('99'.repeat(48)) && events.findIndex((x) => x[0] === 'sim' && x[1].to?.toLowerCase() === ROUTER.toLowerCase()) < events.findIndex((x) => x[0] === 'send'), 'it carries the proof the holder\'s own prover made, and is tried with eth_call before it is sent');
  ok(posts.length === postsBefore, `nothing was posted to the relay (${posts.length - postsBefore} posts)`);
  const sp1 = await p.evaluate(() => window.__spn);
  const req = sp1.calls.filter((c) => c[0] === 'request').at(-1);
  ok(req && req[1] === ACCT.private_key && sp1.calls.some((c) => c[0] === 'stdin' && c[1] === 'wrap' && c[2] === 1), 'the request is signed by the Tacit account, with the note\'s memo hashed into the input');
  u = await ux(p);
  const ups = u.calls.filter((c) => c[0] === 'useProver').slice(-2).map((c) => c[1]);
  ok(ups.join() === 'true,false', 'the holder\'s prover is set for this proof only, then put back');
  ok(midSteps.join('|').includes('Prepare your note|Prepare the input for Succinct’s prover|Succinct’s prover proves it, about half a minute|Confirm in your wallet: one transaction deposits and settles it|It lands'), `the steps say what happens in plain words (${midSteps.join(' · ')})`);
  ok(/Proved with your own credit\./.test(await text(p, '#status')), 'it says it was proved with your own credit');

  // Succinct's network refusing private inputs: the proof goes with a public input, the steps say so as it goes and at the end, and the wallet
  // still sends the settle
  await spnCfg(p, { privateOff: true, proveMs: 600 });
  const pubFrom = r.log.sends.length;
  await p.fill('#amt', '0.04');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  const sawPub = p.waitForFunction(() => /goes with a public input, which anyone can read/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000, polling: 50 }).then(() => true, () => false);
  await p.click('#go');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  const pubReq = (await p.evaluate(() => window.__spn)).calls.filter((c) => c[0] === 'request').at(-1);
  ok(await sawPub && pubReq?.[4] === 'public' && r.log.sends.slice(pubFrom).length === 1, `with private inputs refused, the proof goes with a public input and the steps say so (${JSON.stringify(pubReq?.slice(2))})`);
  ok(/Proved with your own credit \(its input went public: Succinct’s network was not taking private inputs\)\./.test(await text(p, '#status')), `and the result says so (${(await text(p, '#status')).slice(0, 200)})`);
  await spnCfg(p, { privateOff: false });

  // too little credit, read before the deposit: nothing is sent
  await spnCfg(p, { credit: String(10n ** 17n) });
  const shortFrom = r.log.sends.length;
  await p.fill('#amt', '0.04');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  await p.click('#go');
  await until(p, () => /prover credit is/.test(document.querySelector('#status').textContent), null, 20000);
  sst = await text(p, '#status');
  ok(/Your prover credit is 0\.10 PROVE, and a proof needs about 0\.45 PROVE on hand\. Nothing was sent\./.test(sst) && !!(await p.$('#status #ps-open')) && r.log.sends.length === shortFrom, `too little credit is said in amounts, with Add PROVE, and nothing is sent (${sst})`);
  await until(p, () => document.querySelector('#go').textContent === 'Add PROVE to prove it yourself', null, 10000);
  ok(/not enough for a proof/.test(await text(p, '#prover-line')), 'the ticket then asks for PROVE before a deposit');

  // the credit runs short between the check and the request: nothing has moved, and with PROVE added the next press goes through
  await spnCfg(p, { credit: String(2n * E18N), credits: [String(2n * E18N), String(10n ** 17n)] });
  await p.evaluate(() => document.querySelector('#prover-line #ps-open').click());
  await until(p, () => /2 PROVE · enough/.test(document.querySelector('.bsheet #ps-acct')?.textContent || ''), null, 20000);
  await p.click('.bsheet .x');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  await spnCfg(p, { credits: [String(2n * E18N), String(10n ** 17n)] });
  const midFrom = r.log.sends.length;
  await p.click('#go');
  await until(p, () => /prover credit is 0\.10/.test(document.querySelector('#status').textContent), null, 30000);
  sst = await text(p, '#status');
  await shot(p, 'own-short');
  ok(/Your prover credit is 0\.10 PROVE/.test(sst) && /Nothing was sent\./.test(sst) && !!(await p.$('#status #ps-open')) && r.log.sends.length === midFrom && !(await p.$('#status #retry')), `a credit short at the request: nothing was sent, Add PROVE is offered, and no deposit waits (${sst.slice(0, 200)})`);
  ok(lastCall(await ux(p), 'releaseWrapIndex')?.[1] === lastCall(await ux(p), 'proveWrap')?.[3], 'the note\'s index is handed back, so recovery from the key does not skip it');
  await spnCfg(p, { credits: [], credit: String(2n * E18N) });
  await p.click('#go');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  ok(r.log.sends.length === midFrom + 1 && r.log.sends.at(-1).tx.to.toLowerCase() === ROUTER.toLowerCase(), 'the next press proves it and the one transaction goes');

  // Succinct's prover does not take it in time: said plainly, and nothing has moved
  await spnCfg(p, { notProved: true });
  const npFrom = r.log.sends.length;
  await p.fill('#amt', '0.04');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  await p.click('#go');
  await until(p, () => /did not take it/.test(document.querySelector('#status').textContent), null, 30000);
  sst = await text(p, '#status');
  ok(sst.includes('Succinct’s prover did not take it in time. Nothing was sent. The network kept its base fee (about 0.39 PROVE). Try again, or let the relay prove this one.') && r.log.sends.length === npFrom && !(await p.$('#status #retry')), `a request not proved in time is said plainly, and nothing was sent (${sst.slice(0, 200)})`);

  // with the switch on, Finish proves a waiting deposit with the holder's own credit too
  await cfg(p, { pending: [{ index: 8, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 5000000, txHash: '0x' + 'c8'.repeat(32) }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelector('#finish'), null, 20000);
  await p.click('#mode-seg [data-mode="get"]');
  await cfg(p, { pending: [] });
  const finPosts = posts.length, finSends = r.log.sends.length;
  await p.click('#finish');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 30000);
  u = await ux(p);
  ok(posts.length === finPosts && r.log.sends.length === finSends + 1 && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && lastCall(u, 'buildWrap')[3] === 8 && u.calls.filter((c) => c[0] === 'useProver').slice(-2).map((c) => c[1]).join() === 'true,false', 'Finish proves the waiting deposit with your own credit and the wallet sends its settle');
  // two waiting, and Succinct's prover does not take the first: Finish stops there, and asks for no second proof that would keep its base fee too
  const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
  await cfg(p, { pending: [{ index: 10, asset: CETH, value: 1000000, txHash: '0x' + 'ca'.repeat(32) }, { index: 11, asset: CETH, value: 2000000, txHash: '0x' + 'cb'.repeat(32) }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => /in 2 deposits/.test(document.querySelector('#waiting').textContent), null, 20000);
  await p.click('#mode-seg [data-mode="get"]');
  const requests = () => p.evaluate(() => window.__spn.calls.filter((c) => c[0] === 'request').length);
  const reqsBefore = await requests(), twoSends = r.log.sends.length;
  await spnCfg(p, { notProved: true });
  await p.click('#finish');
  await until(p, () => document.querySelector('#status #own-pending'), null, 30000);
  ok((await requests()) === reqsBefore + 1 && r.log.sends.length === twoSends && /did not take it in time/.test(await text(p, '#status')), `Finish on your own credit stops at the first proof not taken: the next deposit is not asked for (${(await requests()) - reqsBefore} request)`);
  await cfg(p, { pending: [] });
  await p.click('#status #own-pending');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 30000);
  u = await ux(p);
  ok((await requests()) === reqsBefore + 3 && r.log.sends.length === twoSends + 2 && u.calls.filter((c) => c[0] === 'buildWrap').slice(-2).map((c) => c[3]).join() === '10,11', 'trying again with the credit finishes both, the one that failed and the one left');

  // ── this computer: the switch finds tacit-prover on 127.0.0.1, the note is proved there before any ETH moves, and one transaction goes ──
  chain.device = { up: false };
  await p.evaluate(() => document.querySelector('#prover-line #ps-open').click());
  await p.waitForSelector('.bsheet #ps-dev');
  ok(!devlog.length, 'nothing reaches this computer\'s prover before the holder chooses it');
  await p.click('#ps-dev');
  await until(p, () => /isn’t running here/.test(document.querySelector('.bsheet #ps-dev-note')?.textContent || ''), null, 10000);
  ok(!(await p.isChecked('#ps-dev')) && /Get it/.test(await text(p, '.bsheet #ps-dev-note')), 'with nothing answering, the switch stays off and says where to get the prover');
  chain.device = { up: true };
  await p.click('#ps-dev');
  await until(p, () => /running here, hashing on Apple M2/.test(document.querySelector('.bsheet #ps-dev-note')?.textContent || ''), null, 10000);
  ok(await p.isChecked('#ps-dev') && !(await p.isChecked('#ps-on')), 'found, it is on and proving with your own credit is off');
  await p.click('.bsheet .x');
  await until(p, () => /Proved bythis computer/.test(document.querySelector('#prover-line').textContent), null, 10000);
  const devPosts = posts.length, devSends = r.log.sends.length, devReqs = await requests();
  events.length = 0;
  await p.fill('#amt', '0.06');
  await until(p, () => /Relay tipnone: this computer proves it/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Shield ETH', null, 10000);
  ok(/0\.06 ETH in one transaction/.test(await text(p, '#route')) && /This computer proves your note before any ETH moves/.test(await text(p, '#tk-note')), 'the receipt: no tip, the amount in one transaction, proved here first');
  await p.click('#go');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  const devTx = r.log.sends.slice(devSends).map((x) => x.tx);
  ok(devTx.length === 1 && devTx[0].to.toLowerCase() === ROUTER.toLowerCase() && BigInt(devTx[0].value) === 6n * 10n ** 16n && devTx[0].data.includes('55'.repeat(96)) && devTx[0].data.includes('66'.repeat(48)), 'one transaction to the router carries exactly the amount and the proof made on this computer');
  ok(posts.length === devPosts && (await requests()) === devReqs, 'nothing went to the relay or to Succinct');
  ok(devlog.filter((x) => x.path === '/prove').length === 1 && devlog.every((x) => x.origin === `http://127.0.0.1:${WEB}`) && (await p.evaluate(() => window.__dev.calls.filter((c) => c[0] === 'stdin' && c[1] === 'wrap' && c[2] === 1).length)) === 1, 'the page built the program input and asked the prover on this computer, from its own origin');
  ok(/Proved on this computer\./.test(await text(p, '#status')), `it says so (${(await text(p, '#status')).slice(0, 160)})`);
  await cfg(p, { held: 900000000 });                                                       // the note lands, so the page stops reading for it
  // the wallet declines: the proof is kept, and the next press sends it without proving again
  r.log.reject = true;
  await p.fill('#amt', '0.06');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  await p.click('#go');
  await until(p, () => /The proof is kept/.test(document.querySelector('#status').textContent), null, 30000);
  const provesBefore = devlog.filter((x) => x.path === '/prove').length;
  r.log.reject = false;
  await p.click('#go');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  ok(devlog.filter((x) => x.path === '/prove').length === provesBefore && r.log.sends.length === devSends + 2, 'declined in the wallet, the proof is kept and the next press sends it with no new proof');
  await cfg(p, { held: 1800000000 });
  // a failed proof on this computer: said, and nothing sent
  chain.device = { up: true, fail: true };
  const failFrom = r.log.sends.length;
  await p.fill('#amt', '0.06');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  await p.click('#go');
  await until(p, () => /rejects this input/.test(document.querySelector('#status').textContent), null, 30000);
  ok(/The prover on this computer: the guest rejects this input\. Nothing was sent\./.test(await text(p, '#status')) && r.log.sends.length === failFrom, `a proof this computer could not make is said, and nothing was sent (${(await text(p, '#status')).slice(0, 160)})`);
  // Finish proves a waiting deposit on this computer too, and the wallet sends its settle
  chain.device = { up: true };
  await cfg(p, { pending: [{ index: 12, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 3000000, txHash: '0x' + 'cc'.repeat(32) }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelector('#finish'), null, 20000);
  await p.click('#mode-seg [data-mode="get"]');
  await cfg(p, { pending: [] });
  const devFinSends = r.log.sends.length, devFinProves = devlog.filter((x) => x.path === '/prove').length;
  await p.click('#finish');
  await until(p, () => /proved on this computer/.test(document.querySelector('#status').textContent), null, 30000);
  ok(r.log.sends.length === devFinSends + 1 && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && devlog.filter((x) => x.path === '/prove').length === devFinProves + 1 && lastCall(await ux(p), 'buildWrap')[3] === 12, 'Finish proves the waiting deposit on this computer and the wallet sends its settle');
  await p.evaluate(() => document.querySelector('#prover-line #ps-open').click());
  await p.waitForSelector('.bsheet #ps-dev');
  await p.click('#ps-dev'); await until(p, () => !document.querySelector('.bsheet #ps-dev').checked); await p.click('.bsheet .x');

  // the switch off again, for what follows; where the relay cannot prove, the holder's own credit finishes it
  await p.evaluate(() => document.querySelector('#prover-line #ps-open').click());
  await p.waitForSelector('.bsheet #ps-on');
  await p.uncheck('#ps-on'); await p.click('.bsheet .x');
  await until(p, () => /Proved byTacit’s relay/.test(document.querySelector('#prover-line').textContent), null, 10000);
  await cfg(p, { settleRefuse: 'prove_budget' });
  await deposit('0.05');
  await until(p, () => document.querySelector('#status #own'), null, 20000);
  const ownPosts = posts.length, ownSends = r.log.sends.length;
  await p.click('#status #own');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  ok(posts.length === ownPosts && r.log.sends.length === ownSends + 1 && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && /Proved with your own credit/.test(await text(p, '#status')), 'a deposit the relay could not prove is proved with your own credit and settled from your wallet');
  await shot(p, 'own-done');

  // locking forgets the key
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-lock');
  await until(p, () => document.querySelector('#signin') && window.__ux.forgot >= 1);
  ok(((await ux(p)).forgot || 0) >= 1 && (await text(p, '#go')) !== '' && /Sign in to see yours/.test(await text(p, '#fm-note')), 'Lock drops the key and the pool module\'s copies of it');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error and nothing blocked (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  await r.browser.close();

  // ── tETH on Bitcoin: the quiet state until there is a book ──
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await until(p, () => document.querySelector('#btc-lead').textContent.length > 0 && document.querySelector('#px-usd').textContent.startsWith('$'));
  await shot(p, 'btc-idle');
  ok(/No tETH is listed on Bitcoin yet/.test(await text(p, '#btc-lead')) && /not listed yet/.test(await text(p, '#btc-sum')), 'with nothing on the Bitcoin book, the panel says so');
  const refTxt = (ETH_USD / 83000 * 1e8 / 1e6).toFixed(2);
  ok(!(await p.$('#btc-ladder .ob')) && (await p.$eval('#btc-ladder', (e) => e.innerHTML)) === '', 'no empty book is drawn while nothing is listed');
  ok(!(await p.$('#btc-actions button')) && !(await p.$('#btc-actions a')) && (await p.$eval('#btc-depth', (e) => e.hidden)), 'no way to trade is offered until there is something to trade');
  const facts = await text(p, '#btc-facts');
  ok(facts.includes(`≈ ${refTxt}M sats`) && /ETH’s price/.test(facts) && /3 holders on Bitcoin · 2 transfers/.test(facts), `what is known of tETH on Bitcoin: ETH's price in sats, its holders and transfers (${facts})`);
  ok(/Bridge tETH to Bitcoin/.test(await text(p, '#btc-note')) && (await p.$eval('#btc-note a', (a) => a.getAttribute('href'))) === '/#private/bitcoin/out', 'and where tETH on Bitcoin comes from');
  ok((await p.$$eval('#lane-seg button', (b) => b.map((x) => x.textContent))).join() === 'ETH held', 'the chart offers no Bitcoin price while there is none');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();

  // ── ... and when someone has listed: the book, the price against ETH's, and the way in ──
  chain.market = 'active';
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await r.page.route('**/trade/btc.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript', body: `export function makeBitcoin(o) { (window.__btc ||= { made: [], opened: [] }).made.push({ id: o.asset?.id, title: o.asset?.title, after: o.asset?.after }); return { open: async (prime) => { window.__btc.opened.push(prime); } }; }` }));
  await until(p, () => document.querySelectorAll('#btc-ladder .ob-row').length > 3 && document.querySelector('#btc-depth svg') && document.querySelector('#px-usd').textContent.startsWith('$'));
  await shot(p, 'btc-active');
  const btcSum = await text(p, '#btc-sum');
  const mark = activeMarket().asset.mark_price.unit, premiumPct = Math.abs((mark / (ETH_USD / 83000 * 1e8) - 1) * 100);
  ok(/sats/.test(btcSum) && /(under|over) ETH|level with ETH/.test(btcSum) && btcSum.includes(`${premiumPct.toFixed(premiumPct < 10 ? 1 : 0)}%`), `the panel's head gives the last price and how far it sits from ETH's (${btcSum})`);
  const obRows = await p.$$eval('#btc-ladder .ob-row', (rs) => rs.map((x) => ({ side: x.classList.contains('ask') ? 'ask' : 'bid', btn: x.tagName === 'BUTTON', t: x.textContent.replace(/\s+/g, ' ').trim() })));
  ok(obRows.some((x) => x.side === 'ask' && x.btn) && obRows.some((x) => x.side === 'bid') && obRows.every((x) => !x.btn || /\$/.test(x.t)), `asks and bids are rows, each a button that opens the market, priced in dollars (${obRows[0].t})`);
  ok(!(await p.$eval('#btc-depth', (e) => e.hidden)) && /listings/.test(await text(p, '#btc-note')), 'the depth chart and the count of listings show');
  const acts = await p.$$eval('#btc-actions button', (b) => b.map((x) => x.textContent));
  ok(acts.join() === 'Trade on Bitcoin,List a sale', `the way in: ${acts.join(' · ')}`);
  await p.click('#hints summary');
  const lanes2 = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes2.some((l) => /On Bitcoin/.test(l) && /\$/.test(l) && /1 tETH = .* sats/.test(l) && /last trade · .*(under|over) ETH/.test(l)), `the hero's dropdown has a Bitcoin lane with its price against ETH (${lanes2.find((l) => /On Bitcoin/.test(l))})`);
  await p.keyboard.press('Escape');
  await p.click('#btc-actions [data-btc="open"]');
  await until(p, () => window.__btc?.opened.length === 1);
  let bt = await p.evaluate(() => window.__btc);
  ok(bt.made[0].id === BTC_ID && bt.made[0].title === 'tETH on Bitcoin' && /Bridge/.test(bt.made[0].after) && bt.opened[0] === null, 'the market sheet is made for tETH\'s id and title, and opened as it is');
  await p.click('#btc-ladder .ob-row.ask[data-btc]');
  await until(p, () => window.__btc.opened.length === 2);
  bt = await p.evaluate(() => window.__btc);
  ok(bt.opened[1]?.side === 'buy' && bt.opened[1].type === 'market' && typeof bt.opened[1].receiveBase === 'bigint' || (bt.opened[1]?.side === 'buy' && bt.opened[1].type === 'market'), `a ladder row primes the ticket to buy up to it (${JSON.stringify(bt.opened[1], (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
  await p.click('#btc-actions [data-btc="list"]');
  await until(p, () => window.__btc.opened.length === 3);
  bt = await p.evaluate(() => window.__btc);
  ok(bt.opened[2].side === 'sell' && bt.opened[2].type === 'limit', 'List a sale primes a limit sell');
  // the chart gains a Bitcoin price
  const kindsNow = await p.$$eval('#lane-seg button', (b) => b.map((x) => x.textContent));
  ok(kindsNow.join() === 'ETH held,On Bitcoin', `with trades, the chart offers tETH's price on Bitcoin (${kindsNow.join(' | ')})`);
  await p.click('#lane-seg [data-chart="btc"]');
  await until(p, () => /price on Bitcoin/.test(document.querySelector('#chart-name').textContent) && document.querySelector('#chart .line'));
  await shot(p, 'btc-chart');
  const rd = await text(p, '#ch-read');
  ok(/\$/.test(rd) && /vs ETH/.test(rd) && /tETH traded/.test(rd), `the readout gives the price, the move, and how far it sits from ETH (${rd.slice(0, 120)})`);
  const tags = await p.$$eval('#chart .tagtext', (t) => t.map((x) => x.textContent));
  ok(tags.includes('ETH') && tags.includes('Bitcoin'), `ETH's own price is marked beside it on the chart (${tags.join(',')})`);
  await p.click('#view-seg [data-unit="sats"]');
  await until(p, () => /sats/.test(document.querySelector('#ch-read').textContent));
  ok(/M sats/.test(await text(p, '#ch-read')), 'the same in sats');
  await p.click('#lane-seg [data-chart="held"]');
  await until(p, () => /ETH held in the pool/.test(document.querySelector('#chart-name').textContent));
  ok(/ETH/.test(await text(p, '#ch-read')) && (await p.$$eval('#view-seg button', (b) => b.map((x) => x.textContent))).join() === 'ETH,USD', 'and back to the ETH held');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error with a book (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();
  // a book with one listing and no trade: the lane names the ask, not "not listed yet"
  chain.market = 'ask';
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await until(p, () => document.querySelectorAll('#btc-ladder .ob-row').length >= 1 && document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.click('#hints summary');
  const askLane = (await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()))).find((l) => /On Bitcoin/.test(l));
  ok(/cheapest ask · /.test(askLane) && /1 tETH = .* sats/.test(askLane) && /\$/.test(askLane) && !/not listed yet/.test(askLane), `one listing and no trade: the lane gives the cheapest ask (${askLane})`);
  ok(/1 listed · 0 bids · no trades yet/.test(await text(p, '#btc-sum')) && !/Could not read/.test(await text(p, '#btc-ladder')), `and the head agrees (${await text(p, '#btc-sum')})`);
  await r.browser.close();
  // the listings could not be read, the rest could: that is not an empty book
  chain.market = 'partial';
  r = await openPage({ width: 1280, height: 900 });
  p = r.page;
  await until(p, () => /Could not read the Bitcoin order book/.test(document.querySelector('#btc-ladder').textContent) && document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.click('#hints summary');
  const partLane = (await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()))).find((l) => /On Bitcoin/.test(l));
  ok(!/No tETH is listed/.test(await text(p, '#btc-lead')) && /book not read/.test(await text(p, '#btc-sum')) && !partLane && !(await p.$('#btc-actions button')), `holders and transfers known but no listings read: the panel says so and does not call the book empty, and no lane quotes a price (${partLane})`);
  await r.browser.close();
  // clicking a ladder row with the visitor's own order at the best price primes only what is cheaper than the row, theirs left out
  r = await openPage({ width: 1280, height: 900 });
  const prime = await r.page.evaluate(async () => {
    const m = await import('/teth/market.js');
    const row = (unit, mine) => ({ unit, amount: 10n ** 8n, sats: unit, mine, instant: true, whole: true });
    const book = { asks: [row(100, true), row(200, false), row(300, false)], bids: [{ ...row(90, true), auto: false }, { ...row(80, false), auto: false }, { ...row(70, false), auto: false }] };
    return { buy1: m.bookPrime({ book }, 'buy', 1).receiveBase, buy2: m.bookPrime({ book }, 'buy', 2).receiveBase, sell1: m.bookPrime({ book }, 'sell', 1).sellBase };
  });
  ok(prime.buy1 === 10n ** 8n && prime.buy2 === 2n * 10n ** 8n && prime.sell1 === 10n ** 8n, `a click counts the levels the ladder draws: the 200 row primes its own lot, not the next one too (${prime.buy1}, ${prime.buy2}, ${prime.sell1})`);
  await r.browser.close();
  // the book cannot be read
  chain.market = 'down';
  r = await openPage({ width: 1280, height: 900 });
  await until(r.page, () => /Could not read the Bitcoin order book/.test(document.querySelector('#btc-ladder').textContent), null, 20000);
  ok(!(await r.page.$('#btc-actions button')) && !/No tETH is listed/.test(await text(r.page, '#btc-lead')), 'a book that could not be read is not called empty');
  await r.browser.close();
  chain.market = null;

  // ── the relay's quote is checked before the wallet is asked ──
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.click('#go');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'));
  const sendsBefore = r.log.sends.length;
  for (const [name, mod, want] of [
    ['a tip address this page does not know', (q) => ({ ...q, recommendedTipRecipient: '0x' + '11'.repeat(20) }), /tip address this page does not know/],
    ['a splitter this page does not know', (q) => ({ ...q, tipSplitter: '0x' + '22'.repeat(20) }), /tip address this page does not know/],
    ['no tip at all', (q) => { const { recommendedWrapTipWei, ...rest } = q; return rest; }, /did not give a tip/],
    ['a tip of a tenth of the deposit', (q) => ({ ...q, recommendedWrapTipWei: String(10n ** 16n) }), /more than 5% of this deposit/],
  ]) {
    chain.quote = mod;
    await p.fill('#amt', '0.1');
    await until(p, (w) => new RegExp(w).test(document.querySelector('#route').textContent), want.source);
    const goText = await text(p, '#go');
    ok(want.test(await text(p, '#route')) && goText === 'Try again', `${name}: refused with the reason, and the button only asks again (${goText})`);
    await p.fill('#amt', '');
  }
  chain.quote = null;
  await p.fill('#amt', '0.1');
  await until(p, () => /Relay tip/.test(document.querySelector('#route').textContent) && /Private to/.test(document.querySelector('#route').textContent));
  const rt = await text(p, '#route');
  ok(/Private to\s*the Tacit wallet you open next/.test(rt), `before a key is open the receipt says whose key the note will be for (${rt.slice(0, 120)})`);
  ok(r.log.sends.length === sendsBefore, 'nothing was sent for any of them');
  await r.browser.close();

  // ── a deposit whose receipt does not come: it is not asked for again, and Check again finishes it ──
  chain.receipt = 'none';
  chain.quote = (q) => ({ ...q, tipSplitter: SPLITTER });                  // a quote that names the splitter: this deposit's tip goes to it
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.clock.install();
  await cfg(p, { held: 0 });
  await p.click('#go');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'));
  await p.fill('#amt', '0.07');
  await until(p, () => document.querySelector('#go').textContent === 'Sign in to make ETH private', null, 20000);
  await p.click('#go');
  await p.waitForSelector('.bsheet.top [data-in="eth"]');
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => /Deposit sent/.test(document.querySelector('#status').textContent), null, 30000);
  for (let i = 0; i < 6 && !/not confirmed yet/.test(await text(p, '#status')); i++) { await p.clock.fastForward('06:00'); await p.waitForTimeout(400); }
  const slow = await text(p, '#status');
  ok(/not confirmed yet/.test(slow) && /0\.07 ETH deposit was sent/.test(slow) && /no need to send it again/.test(slow) && /Check again/.test(slow), `a deposit that does not confirm is said to be sent, not safe, and not to be sent again (${slow.slice(0, 150)})`);
  ok(r.log.sends[0].tx.data.toLowerCase().endsWith(SPLITTER.slice(2).toLowerCase().padStart(64, '0')) && !r.log.sends[0].tx.data.toLowerCase().endsWith(RELAY.slice(2).toLowerCase().padStart(64, '0')), 'a quote that names the splitter has the deposit\'s tip sent to it, not to the ops address');
  chain.quote = null;
  ok(r.log.sends.length === 1 && (await text(p, '#go')) === 'Finish the earlier deposit first' && (await p.inputValue('#amt')) === '', 'the form is cleared and held');
  chain.receipt = 'ok';
  await p.click('#retry');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  u = await ux(p);
  const lastSub2 = [...u.calls].reverse().find((c) => c[0] === 'submitWrapSettle');
  ok(lastSub2[2] === r.log.sends[0].hash && r.log.sends.length === 1, 'once it lands the relay is given the same deposit, and no second one was sent');
  await r.browser.close();
  chain.receipt = 'ok';

  // ── what the relay says it can do, read before the deposit and while it is waited on ──
  // A fresh page whose relay endpoint answers `relay`, with a wallet connected and the prover credit set.
  const relayPage = async (relay, credit = String(2n * E18N)) => {
    chain.relay = relay;
    const rr = await openPage({ width: 1280, height: 1000 }, { wallet: true });
    await until(rr.page, () => document.querySelector('#px-usd').textContent.startsWith('$'));
    await cfg(rr.page, { held: 0 });
    await spnCfg(rr.page, { credit });
    await rr.page.click('#go');
    await until(rr.page, () => document.querySelector('#wallet-dot').classList.contains('on'));
    return rr;
  };
  const signInNow = async () => { await p.waitForSelector('.bsheet.top [data-in="eth"]'); await p.click('.bsheet.top [data-in="eth"]'); };
  const statusHas = (re, ms = 30000) => until(p, (s) => new RegExp(s).test(document.querySelector('#status').textContent), re.source, ms);

  // not proving at the press: said at once, with the holder's own credit or the deposit anyway, and nothing is sent
  r = await relayPage({ state: 'paused', proving: false, settling: false, board: false, ageSeconds: 40 }, '0');
  p = r.page;
  await p.fill('#amt', '0.05');
  await until(p, () => /Relay tip\d/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Sign in to make ETH private', null, 20000);
  await p.click('#go'); await signInNow();
  await until(p, () => document.querySelector('#status #own-now'), null, 30000);
  sst = await text(p, '#status');
  ok(sst === 'The relay isn’t proving right now. Prove it on this computer, prove it with your own credit or deposit anyway: it goes through once the relay is back, or you finish it from your wallet.' && !!(await p.$('#status #anyway')) && !!(await p.$('#status #dev-now')), `paused at the press: one sentence and three ways on (${sst})`);
  ok(r.log.sends.length === 0 && !(await ux(p)).calls.some((c) => c[0] === 'nextWrapIndex') && (await text(p, '#go')) === 'Shield ETH', 'no deposit was sent and no note was built; the ticket is as it was');
  await p.click('#status #own-now');
  await until(p, () => document.querySelector('.bsheet #ps-on') && /Credit0 PROVE/.test(document.querySelector('.bsheet #ps-acct')?.textContent || ''), null, 20000);
  ok((await p.$eval('#ps-on', (x) => x.checked)) && /Relay tipnone: you prove it yourself/.test(await text(p, '#route')) && r.log.sends.length === 0, 'Prove it with your own credit, with too little: the fund sheet opens first, the wrap is quoted with no relay tip, and nothing is sent');
  await spnCfg(p, { credit: String(2n * E18N) });
  await p.click('.bsheet .x'); await p.click('#prover-line #ps-open');
  await until(p, () => /2 PROVE · enough for about 4 proofs/.test(document.querySelector('.bsheet #ps-acct')?.textContent || ''), null, 20000);
  await p.click('.bsheet .x');
  await until(p, () => document.querySelector('#go').textContent === 'Shield ETH' && !document.querySelector('#go').disabled, null, 10000);
  let postsAt = posts.length;
  await p.click('#go');
  await statusHas(/Done\./);
  ok(r.log.sends.length === 1 && BigInt(r.log.sends[0].tx.value) === 5n * 10n ** 16n && r.log.sends[0].tx.to.toLowerCase() === ROUTER.toLowerCase() && posts.length === postsAt && /Proved with your own credit/.test(await text(p, '#status')), 'with the credit in, the wrap is proved on the holder\'s credit and goes in one transaction with no tip; nothing reaches the relay');
  ok(/Proved byTacit’s relay/.test(await text(p, '#prover-line')) && !(await p.evaluate(() => /true/.test(localStorage.getItem('tacit-trade-own-prover-v1') || ''))), 'for that wrap only: the switch is not kept');
  // deposit anyway: the deposit goes to the relay, and the page stops waiting at once with the holder's own credit offered
  await cfg(p, { settleHang: true });
  await p.fill('#amt', '0.03');
  await until(p, () => /Relay tip\d/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Shield ETH', null, 20000);
  await p.click('#go');
  await until(p, () => document.querySelector('#status #anyway'), null, 20000);
  const anyFrom = r.log.sends.length;
  postsAt = posts.length;
  await p.click('#status #anyway');
  await statusHas(/not private yet/, 20000);
  sst = await text(p, '#status');
  await until(p, () => window.__ux.calls.some((c) => c[0] === 'waitEnded'), null, 5000).catch(() => {});
  u = await ux(p);
  ok(r.log.sends.length === anyFrom + 1 && BigInt(r.log.sends.at(-1).tx.value) === 3n * 10n ** 16n + TIP && posts.length === postsAt + 1 && posts.at(-1).mode === 'settle', 'deposit anyway: the deposit goes with its tip and the relay is given the settle, which keeps its place in line');
  ok(sst.startsWith('The relay isn’t proving right now. Your deposit is safe and keeps its place in line: it goes through once the relay is back.') && /Try again with your credit\. Or finish it on tacit\.finance/.test(sst) && !!(await p.$('#status #own')) && !(await p.$('#status #self')), `and the page does not wait on it: the holder's own credit is offered, not the wallet (${sst.slice(0, 240)})`);
  ok(u.calls.some((c) => c[0] === 'waitEnded' && c[2] === 'relay_paused'), 'the relay client\'s own wait ends at its next poll');
  ok(!/low on|out of|gas|running low/i.test(sst), 'nothing says the relay is short of anything');
  await cfg(p, { settleHang: false });
  postsAt = posts.length;
  await p.click('#status #own');
  await statusHas(/Done\./);
  ok(r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && posts.length === postsAt && /Proved with your own credit/.test(await text(p, '#status')), 'Try again with your credit proves it on the holder\'s credit and the wallet sends the settle');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();

  // proving but not sending at the press: the quote says the wallet sends the settle, and it goes deposit → the relay's proof only → the wallet's settle
  r = await relayPage({ state: 'held', proving: true, settling: false, board: false, ageSeconds: 20 });
  p = r.page;
  await p.fill('#amt', '0.04');
  await until(p, () => /then the settle · network fee about/.test(document.querySelector('#route').textContent), null, 20000);
  // The relay only proves, so its tip is the one it asks for a proof alone.
  const heldRoute = await text(p, '#route'), heldTotal = 4n * 10n ** 16n + BigInt(quote.recommendedProveTipWei);
  ok(heldRoute.includes(`Your wallet sends${f6(heldTotal)} ETH, then the settle · network fee about ${feeTxt} ETH`) && heldRoute.includes('The relay can’t send this one right now, so your wallet sends the settle and pays its network fee.'), `held: the quote adds the settle and its network fee, with the relay's tip for a proof alone (${heldRoute})`);
  events.length = 0;
  postsAt = posts.length;
  await p.click('#go'); await signInNow();
  await statusHas(/Done\./);
  const heldTx = r.log.sends.map((x) => x.tx);
  ok(heldTx.length === 2 && heldTx[0].to.toLowerCase() === WRAP_TIP.toLowerCase() && BigInt(heldTx[0].value) === heldTotal && heldTx[1].to.toLowerCase() === POOL.toLowerCase() && heldTx[1].data.includes('ab'.repeat(96)), 'the deposit goes with its tip, then the wallet sends the settle with the relay\'s proof');
  u = await ux(p);
  ok(posts.length === postsAt + 1 && posts.at(-1).mode === 'prove' && count(u, 'submitWrapSettle', (c) => c[4] === 'relay') === 0 && events.map((x) => x[0]).join() === 'send,sim,send', `the relay is asked for a proof only, never the settle, and the settle is tried before it is sent (${posts.slice(postsAt).map((x) => x.mode).join()})`);
  const heldStepsSeen = await p.$$eval('#steps li', (ls) => ls.map((l) => l.textContent));
  ok(heldStepsSeen.join('|').includes('The relay proves your note|The settle is checked before it is sent|Confirm the settle in your wallet|The settle lands') && /Settled from your wallet/.test(await text(p, '#status')), `the steps say so (${heldStepsSeen.join(' · ')})`);
  // the relay stops proving before the wallet's settle (refused: relay_paused): the holder's own credit is offered, not the wallet
  await cfg(p, { proveRefuse: 'relay_paused' });
  await p.fill('#amt', '0.02');
  await until(p, () => /then the settle/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Shield ETH', null, 20000);
  await p.click('#go');
  await until(p, () => document.querySelector('#status #own'), null, 30000);
  sst = await text(p, '#status');
  ok(sst.startsWith('The relay isn’t proving right now. Your deposit is safe and waits to be finished.') && /Try again with your credit\. Or finish it on tacit\.finance/.test(sst) && !(await p.$('#status #self')), `a relay_paused refusal of the proof offers the holder's own credit (${sst.slice(0, 200)})`);
  postsAt = posts.length;
  await p.click('#status #own');
  await statusHas(/Done\./);
  ok(posts.length === postsAt && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase() && /Proved with your own credit/.test(await text(p, '#status')), 'which proves it and has the wallet send the settle');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();

  // the relay stops sending while the deposit waits on it: the page stops within about 15 seconds and offers the wallet
  r = await relayPage({ state: 'ok', proving: true, settling: true, board: false, ageSeconds: 5 });
  p = r.page;
  await cfg(p, { settleHang: true });
  await p.fill('#amt', '0.05');
  await until(p, () => /Relay tip\d/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Sign in to make ETH private', null, 20000);
  ok(!/then the settle/.test(await text(p, '#route')), 'a relay that sends quotes as before');
  await p.click('#go'); await signInNow();
  await statusHas(/The relay is finishing it/);
  chain.relay = { state: 'held', proving: true, settling: false, board: false, ageSeconds: 3 };
  const heldFrom = Date.now();
  await until(p, () => document.querySelector('#status #self'), null, 45000);
  const waited = (Date.now() - heldFrom) / 1000;
  sst = await text(p, '#status');
  await until(p, () => window.__ux.calls.some((c) => c[0] === 'waitEnded'), null, 5000).catch(() => {});
  u = await ux(p);
  ok(sst.startsWith('The relay can’t send this one right now. It still proves it, so your wallet can send the settle.') && /Finish it from your wallet: Test Wallet pays the network fee/.test(sst) && !(await p.$('#status #own')) && waited < 35, `held during the wait: the page stops within ${waited.toFixed(0)} s and offers the wallet (${sst.slice(0, 200)})`);
  ok(u.calls.some((c) => c[0] === 'waitEnded' && c[2] === 'relay_held'), 'and the relay client\'s own wait ends at its next poll');
  const waitsBefore = count(u, 'waitForSettle');
  postsAt = posts.length;
  await cfg(p, { settleHang: false });
  await p.click('#status #self');
  await statusHas(/Done\./);
  u = await ux(p);
  ok(count(u, 'waitForSettle') === waitsBefore && posts.length === postsAt + 1 && posts.at(-1).mode === 'prove' && r.log.sends.at(-1).tx.to.toLowerCase() === POOL.toLowerCase(), 'Finish it from your wallet asks for a proof at once (a held relay does not prove the relayed job) and the wallet sends the settle');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();
  chain.relay = null;

  // a wrap proved with the holder's own credit whose one transaction is not confirmed: the page waits on it, makes no other, and Check again ends it
  chain.receipt = 'none';
  r = await relayPage(null);
  p = r.page;
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#signin'); await signInNow();
  await until(p, () => document.querySelector('#held-lock'), null, 30000);
  await p.click('#mode-seg [data-mode="get"]');
  await p.click('#prover-line #ps-open');
  await until(p, () => document.querySelector('#ps-on') && !document.querySelector('#ps-on').disabled, null, 30000);
  await p.check('#ps-on'); await p.click('.bsheet .x');
  await p.fill('#amt', '0.06');
  await until(p, () => /Relay tipnone/.test(document.querySelector('#route').textContent) && document.querySelector('#go').textContent === 'Shield ETH', null, 20000);
  await p.clock.install();
  await p.click('#go');
  await statusHas(/Sent/);
  for (let i = 0; i < 6 && !/not confirmed yet/.test(await text(p, '#status')); i++) { await p.clock.fastForward('06:00'); await p.waitForTimeout(400); }
  ok(/not confirmed yet/.test(await text(p, '#status')) && r.log.sends.length === 1 && (await text(p, '#go')) === 'Finish the earlier deposit first', 'the transaction that does not confirm is waited on, and no other wrap can go while it is');
  chain.receipt = 'ok';
  postsAt = posts.length;
  await p.click('#status #retry');
  await statusHas(/Done\./);
  ok(posts.length === postsAt && r.log.sends.length === 1 && /private now/.test(await text(p, '#status')), 'once it lands, Check again says it is done: nothing more is proved or sent');
  await r.browser.close();

  // ── what the reads fail to give ──
  chain.rates = false;
  r = await openPage({ width: 1280, height: 900 }, { api: false });
  p = r.page;
  await p.waitForTimeout(2500);
  ok((await text(p, '#px-usd')) === 'tETH' && /Reading the pool/.test(await text(p, '#px-sub')), 'with nothing readable the headline waits and says so');
  ok(/Could not read the pool’s history/.test(await text(p, '#chart')), 'the chart says its history was not read');
  ok((await text(p, '#go')) === 'Connect wallet' && !(await p.$('.pf')), 'no farms are invented');
  await r.browser.close();
  chain.rates = true;

  // ── a phone: the ticket first, nothing sideways, the bar at the foot, dark ──
  r = await openPage({ width: 390, height: 800 }, { scheme: 'dark' });
  p = r.page;
  await until(p, () => document.querySelectorAll('.pf').length === 3 && document.querySelector('#chart .line'));
  await p.evaluate(() => { document.querySelector("#hints").open = true; }); await shot(p, 'phone-lanes'); await p.evaluate(() => { document.querySelector("#hints").open = false; });
  await shot(p, 'phone-dark');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'a phone has no sideways scroll');
  const order = await p.evaluate(() => ['.p-ticket', '.p-chart', '.p-farm', '.p-depth', '.p-info'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top + scrollY)));
  ok(order.every((v, i) => i === 0 || v > order[i - 1]), `the ticket comes first, then the chart, farms, movements and about (${order.join(' ')})`);
  await p.evaluate(() => scrollTo(0, document.querySelector('.p-info').offsetTop));
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#stick')).display === 'block'), 'the bar at the foot leads to the ticket once it is out of view');
  await p.click('#stick-go');
  await p.waitForTimeout(700);
  ok(await p.evaluate(() => Math.abs(document.querySelector('.p-ticket').getBoundingClientRect().top) < 140), 'and takes the visitor there');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error on a phone in the dark (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();

  // ── the other market names this one ──
  r = await openPage({ width: 1280, height: 900 });
  await r.page.goto(`http://127.0.0.1:${WEB}/trade/tac/`);
  await r.page.waitForSelector('.assets');
  const tac = await r.page.$$eval('.assets a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]));
  ok(tac.length === 3 && tac[0][2] === 'page' && tac[1][1] === '/teth/' && tac[2][1] === '/cbtc/', 'the TAC page carries the same switch, to the other two');
  // tETH's old address (/trade/teth/) is a stub that sends on, the query and the fragment with it, under its own CSP
  for (const [from, want] of [['/trade/teth/', '/teth/'], ['/trade/teth/#mode=use', '/teth/#mode=use'], ['/trade/teth/?x=1#amount=0.1', '/teth/?x=1#amount=0.1']]) {
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
