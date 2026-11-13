#!/usr/bin/env node
// dapp/farm/: the farms' menu and a deposit into the one picked, in a real browser under the page's own CSP. Ethereum, the farm program
// and the points service's liquidity campaign are stubbed with fixed answers, so every figure on a tile is checked against arithmetic
// done here: each farm's APR, what it pays a day, what a tenth of an ETH gives up on its way in, and which farm the chef picks. Then
// the page's ways through: a tile opens its farm in place and the way back restores the menu; a link to a farm opens on it; the
// TAC/ETH farm's form (trade/farm.js) takes an amount from a press and sends one transaction; a private farm's form prices a deposit,
// holds one that loses 15% or more to an acknowledgement, and runs the deposit's three steps (the proof, the one transaction, the farm
// entry) with the real farm/zap.js and lp-zap.js over a stand-in pool module and key: a wallet that says no keeps the proof for the
// next press, a prover that is not proving sends nothing, a farm entry that fails leaves a share with Farm it. And the layout, three
// tiles to a row on a desktop and two on a phone, with nothing wider than the screen.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/farm-page.mjs        (SHOTS=dir saves screenshots; ONLY=menu,route,public,private,phone)
import { register, createRequire } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { privateFarms, aprText } = await import('../dapp/trade/farm-read.js');
const { campaignRate, campaignApr } = await import('../dapp/trade/lp-campaign.js');
const { zapMath, marketOf } = await import('../dapp/farm/zap.js');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, SHOTS = process.env.SHOTS || null, WEB = 24000 + Math.floor(Math.random() * 1000);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null, runs = (k) => !ONLY || ONLY.has(k);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const until = (page, fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

const W = (v) => BigInt(v).toString(16).padStart(64, '0'), E18 = 10n ** 18n, lc = (s) => String(s).toLowerCase();
const PRECISION_POOL = '0x0155358241411db868ba714ae7c83a27087e3d6e', PRECISION_FARM = '0x0000003bf4ba0b21f5e0d35119b337f4d4cf82e0', LENS = '0x000000956bf20a41c54bae4a4b6f5c8a166dab4e';
const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', MC3 = '0xca11bde05977b3631167028862be2a173976ca11';
const POOL = '0x000000000ed1eabd231be41d93b719056f7febfc', ROUTER = '0x000000005da3e3b73726af3c774deeb9472d4992';
const CHAINLINK_ETH = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', CHAINLINK_BTC = '0xf4030086522a5beea4988f8ca5b36dbc97bee88c';
const TACD = '0xa0f6b02561c8ef08335b69ad25e022c0b342147c', TACE = '0x9de27883c5dc9db47be12e595d59b8f1abec8570', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x' + '0'.repeat(40);
const LP = { tacdPeg: '0xdfee03499f65e56d54aceeedc6f41a09fbeb94b3', tacdBack: '0x867918fd7b6d4f13a20048485147867b9a597534', tacePeg: '0x386627b60cd2a11365e653f0382d92421fddf7a1', taceBack: '0xe1e317700589f3eafca20ac9408c97fe700fc1c1' };
const TOKENS = { [LP.tacdPeg]: [TACD, USDC], [LP.tacdBack]: [USDC, TACD], [LP.tacePeg]: [TACE, ZERO], [LP.taceBack]: [ZERO, TACE] };
const ACCT = '0x00000000000000000000000000000000000fa2e5';

// Prices: ETH $2,400 and BTC $60,000 (Chainlink, 8 decimals); the TAC/ETH pool's sqrt price is 100, so one TAC is 0.0001 ETH = $0.24.
const ETH_USD = 2400, BTC_USD = 60000, SQRT = 100n, TAC_ETH = 1 / (100 * 100), TAC_USD = ETH_USD * TAC_ETH, PX = { ethUsd: ETH_USD, btcUsd: BTC_USD };
// The public farm: 6 ETH-worth of pool (3 ETH and 30,000 TAC), half of it staked, 100 TAC a day over a year-long period.
const R0 = 3n * E18, RATE_PER_SEC = 1157407407407407n, PER_DAY = Number(RATE_PER_SEC * 86400n) / 1e18, PUBLIC_APR = PER_DAY * 365 * TAC_ETH / 3 * 100;
// The private farms: tETH/TAC at the market's price; tETH/cUSD pricing cUSD 43% over a dollar (so ETH put in loses about 15% of itself
// on the half it swaps); tETH/cBTC at the market's price and small.
const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', A_TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const A_CUSD = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d', A_CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
const PID = ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), '0x' + '03'.repeat(32)], LPA = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32), '0x' + 'a3'.repeat(32)];
const FINISH = Math.floor(Date.now() / 1000) + 30 * 86400;
const program = ({ active = true, extra = [] } = {}) => ({
  network: 'mainnet', manager: '0x000031C47Cb61faB1CE2790a69625FABB71EDE24', rewardAsset: '0x' + '10'.repeat(32), epoch: { active, periodFinish: FINISH, ratePerDayTac: '1000' },
  pools: [
    { pid: 0, pair: 'TAC/cETH', poolId: PID[0], lpAsset: LPA[0], feeBps: 30, lockSeconds: 0, tacPerDayForPool: '500', totalShares: '90000000000', reserves: { assetA: CETH, assetB: A_TAC, reserveA: '1000000000', reserveB: '10000000000000', lpTotalShares: '100000000000' } },
    { pid: 1, pair: 'cETH/cUSD', poolId: PID[1], lpAsset: LPA[1], feeBps: 30, lockSeconds: 0, tacPerDayForPool: '300', totalShares: '8000000000', reserves: { assetA: CETH, assetB: A_CUSD, reserveA: '200000000', reserveB: '336000000000', lpTotalShares: '8197560612' } },
    { pid: 2, pair: 'cETH/cBTC', poolId: PID[2], lpAsset: LPA[2], feeBps: 30, lockSeconds: 0, tacPerDayForPool: '200', totalShares: '20000000', reserves: { assetA: CETH, assetB: A_CBTC, reserveA: '100000000', reserveB: '4000000', lpTotalShares: '20000000' } },
    ...extra,
  ],
});
const resOf = (p) => ({ reserveA: BigInt(p.reserves.reserveA), reserveB: BigInt(p.reserves.reserveB), totalShares: BigInt(p.reserves.lpTotalShares), feeBps: p.feeBps });
const marketFor = (p) => marketOf(p.pair, { tacEth: TAC_ETH, ...PX });
const costOf = (p, wei = 10n ** 17n) => zapMath({ res: resOf(p), wei, market: marketFor(p) });
const pctTxt = (x) => `${x.toFixed(x < 10 ? 1 : 0)}%`;
// The campaign: 25 TAC a day, 0.05 TAC at most for a dollar, four pools of about $30.
const campaign = (over = {}) => ({
  enabled: true, endSec: Math.floor(Date.now() / 1000) + 30 * 86400,
  terms: { fromDay: 20745, dailyWei: String(25n * E18), createWei: '0', capWeiPerUsdDay: String(E18 / 20n) }, next: { fromDay: 20775, dailyWei: null, createWei: null, capWeiPerUsdDay: null },
  pools: [[LP.tacdPeg, 10000, 31], [LP.tacdBack, 5000, 31], [LP.tacePeg, 10000, 25], [LP.taceBack, 5000, 31]].map(([pool, w, usd]) => ({ pool, weightBps: String(w), valueUsdWei: String(BigInt(usd) * E18), opened: true, openPaid: true })),
  ...over,
});

const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'mainnet.rpc.buidlguidl.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.mevblocker.io', 'eth-mainnet.nodereal.io', '1.rpc.thirdweb.com', 'rpc.flashbots.net', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io'];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

// What the chain answers. `st` is a scenario's own state: the program (the pools' reserves are read from it, so a scenario can move a
// pool), the wallet's balance and stake, the transactions sent.
function chain(st) {
  const t = BigInt(Math.floor(Date.now() / 1000)), round = (price) => '0x' + W(1) + W(BigInt(price) * 10n ** 8n) + W(t) + W(t) + W(1);
  const table = {
    [`${PRECISION_POOL}:0x443cb4bc`]: '0x' + W(R0), [`${PRECISION_POOL}:0x5a76f25e`]: '0x' + W(30000n * E18), [`${PRECISION_POOL}:0x18160ddd`]: '0x' + W(1000n * E18), [`${PRECISION_POOL}:0x2af1f249`]: '0x' + W(SQRT * E18),
    [`${PRECISION_FARM}:0x817b1cd2`]: '0x' + W(500n * E18), [`${PRECISION_FARM}:0x7b0a47ee`]: '0x' + W(RATE_PER_SEC), [`${PRECISION_FARM}:0xebe2b12b`]: '0x' + W(t + 365n * 86400n),
    [`${MC3}:0x0f28c97d`]: '0x' + W(t), [`${CHAINLINK_ETH}:0xfeaf968c`]: round(ETH_USD), [`${CHAINLINK_BTC}:0xfeaf968c`]: round(BTC_USD),
    ...Object.fromEntries(Object.entries(TOKENS).flatMap(([pool, [a, b]]) => [[`${pool}:0x0dfe1681`, '0x' + W(BigInt(a))], [`${pool}:0xd21220a7`, '0x' + W(BigInt(b))]])),
    ...(st.table || {}),
  };
  function call(c) {
    const to = lc(c.to), data = lc(c.data || '0x'), sel = data.slice(0, 10), arg = (i) => BigInt('0x' + (data.slice(10 + i * 64, 74 + i * 64) || '0'));
    if (to === MC3 && sel === '0x82ad56cb') {                                          // aggregate3: each call answered as it would be alone
      const h = data.slice(10), at = (i) => Number(BigInt('0x' + h.slice(64 * i, 64 * (i + 1)))), k = at(1), items = [];
      for (let i = 0; i < k; i++) {
        const e = 2 + at(2 + i) / 32, target = '0x' + h.slice(64 * e + 24, 64 * (e + 1)), b = e + at(e + 2) / 32, len = at(b), d = '0x' + h.slice(64 * (b + 1), 64 * (b + 1) + len * 2);
        let out = null; try { out = call({ to: target, data: d }); } catch { out = null; }
        items.push(out);
      }
      let head = '', tail = '', off = k * 32;
      for (const out of items) { const d = out ? out.slice(2) : '', body = W(out ? 1 : 0) + W(64) + W(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); head += W(off); tail += body; off += body.length / 2; }
      return '0x' + W(32) + W(k) + head + tail;
    }
    if (to === POOL && sel === '0xb5217bb4') {                                         // pools(bytes32): a private pool's reserves, as the program has them
      const p = st.prog.pools.find((x) => lc(x.poolId) === '0x' + data.slice(10, 74));
      if (!p) return '0x' + W(0).repeat(7);
      return '0x' + W(1) + p.reserves.assetA.slice(2) + p.reserves.assetB.slice(2) + W(p.reserves.reserveA) + W(p.reserves.reserveB) + W(p.feeBps) + W(p.reserves.lpTotalShares);
    }
    if (to === POOL && sel === '0x7da9874f') return '0x' + W(0);                       // depositStatus: none made
    if (to === ROUTER && sel === '0xc4294fac') return '0x' + W(arg(4));                // the zap run as a call: it mints the share count it names
    if (to === LENS && sel === '0xe7cddab0') return '0x' + W(1) + W(0) + W(arg(2) * 1000n * E18 / (6n * E18) * 99n / 100n);       // previewZap: the shares of a deposit, 1% under the pool's price
    if (to === PRECISION_FARM && sel === '0x8703a0d8') return '0x' + W(1);             // zapETH run as a call
    if (to === PRECISION_FARM && (sel === '0x98807d84' || sel === '0x008cc262')) return '0x' + W(sel === '0x98807d84' ? st.staked || 0n : st.earned || 0n);
    if ((to === TAC || to === PRECISION_POOL) && (sel === '0x70a08231' || sel === '0xdd62ed3e')) return '0x' + W(0);
    const hit = table[`${to}:${sel}`];
    if (!hit) throw Object.assign(new Error('execution reverted'), { code: 3 });
    return hit;
  }
  return (method, params) => {
    if (method === 'eth_call') return call(params?.[0] || {});
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_getBalance') return '0x' + (st.bal ?? 5n * E18).toString(16);
    if (method === 'eth_blockNumber') return '0x1700000';
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber') return { number: '0x1700000', timestamp: '0x' + t.toString(16) };
    if (method === 'eth_getTransactionReceipt') return st.sent.some((x) => x.hash === params?.[0]) ? { status: '0x1', transactionHash: params[0], blockNumber: '0x1700001', logs: [] } : null;
    throw Object.assign(new Error(`the stub has no ${method}`), { code: -32601 });
  };
}

// A stand-in for the pool module's loader (trade/poolux.js) and the key session (trade/key.js): what the page and farm/zap.js call of
// them, answering from the page's own `window.__t` switches, each call noted in `window.__ux`.
const FAKE_POOLUX = `
const note = (k, v) => { (window.__ux ||= []).push(v === undefined ? k : k + ':' + v); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = () => (window.__t ||= {});
const LEAF = '0x' + 'ee'.repeat(32);
const t = {
  cfg: { router: '${ROUTER}', pool: '${POOL}', farm: { manager: '0x000031C47Cb61faB1CE2790a69625FABB71EDE24' },
    assets: [{ ticker: 'cTAC', assetId: '${A_TAC}', underlying: '${TAC}' }, { ticker: 'cUSD', assetId: '${A_CUSD}', underlying: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564' }, { ticker: 'cBTC', assetId: '${A_CBTC}', underlying: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696' }] },
  async poolReserves(id) {
    const r = await (await fetch('https://ethereum-rpc.publicnode.com/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '${POOL}', data: '0xb5217bb4' + String(id).slice(2) }, 'latest'] }) })).json();
    const h = r.result.slice(2), w = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
    return w(0) ? { init: true, assetA: '0x' + h.slice(64, 128), assetB: '0x' + h.slice(128, 192), reserveA: w(3), reserveB: w(4), feeBps: Number(w(5)), totalShares: w(6) } : null;
  },
  relay: {
    state: async () => ({ state: T().proving === false ? 'paused' : 'ok', proving: T().proving !== false, settling: true, board: true }),
    async prove(spec, w) { note('prove', spec.type); w?.onJob?.('job-prove'); await sleep(T().proveMs ?? 250); if (T().proveFail) throw new Error('prove failed: the guest rejects this input'); return { status: 'proven', jobId: 'job-prove', publicValues: '0x' + '11'.repeat(64), proof: '0x' + '0b'.repeat(32), memos: spec.memos }; },
    landed: async () => ({ ok: true }),
  },
  nextShareIndex: () => { note('index'); return 3; },
  releaseShareIndex: ({ index }) => note('release', index),
  buildShareWrap: ({ poolId, shares, index }) => { note('build', shares); return { leaf: LEAF, depositId: '0x' + 'dd'.repeat(32), commit: '0x' + 'cc'.repeat(32), wrapOp: { value: String(shares) }, outputs: [], memos: ['0x01'], ephRand: '0x02', index, wrapArgs: { assetId: poolId } }; },
  wrapProofFits: () => T().wrongProof !== true,
  async balance() {
    note('balance');
    const loose = T().loose ? [{ leaf: '0x' + 'ab'.repeat(32), asset: T().loose, value: '1000', owner: '0x01' }] : [];
    const made = window.__zapSent && !T().bonded ? [{ leaf: LEAF, asset: T().lpAsset || '${LPA[0]}', value: '1', owner: '0x02' }] : [];
    return { notes: [...loose.filter(() => !T().bonded), ...made], spentNotes: [] };
  },
  async farmBond({ lpNote }) { note('bond', lpNote.leaf.slice(0, 6)); await sleep(T().bondMs ?? 200); if (T().bondFail) throw Object.assign(new Error('relay 503: temporarily unavailable'), { code: 'relay_held' }); T().bonded = true; return { jobId: 'job-bond', txHash: '0x' + '22'.repeat(32) }; },
  farmPositions: async () => (T().bonded ? [{ pid: 0, receiptLeaf: '0x' + '77'.repeat(32), pendingUnits: '0', pendingTac: '0', shares: '1' }] : (T().positions || [])),
  ethCall: async () => '0x' + '0'.repeat(64), identity: () => ({ pubHex: '02' + 'ab'.repeat(32) }), poolTickerOf: () => 'cETH', quoteOpFee: async () => 0n, quoteUnwrapFee: () => ({ net: 1n, fee: 0n }),
};
export const getUx = async () => t;
export const forgetUx = async () => { note('forget'); };
`;
const FAKE_KEY = `
export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }
export function makeKeySession() {
  let on = !!(window.__t ||= {}).keyOpen; const ls = new Set(), emit = () => ls.forEach((f) => f());
  const open = async () => { if (window.__t.noKey) throw new Cancelled(); window.__keyOpens = (window.__keyOpens || 0) + 1; on = true; emit(); };
  return { open: { eth: open, passkey: open }, get unlocked() { return on; }, get key() { return on ? { mode: 'eth', pubHex: '02' + 'ab'.repeat(32), address: '${ACCT}' } : null; },
    priv: () => new Uint8Array(32).fill(7), known: () => null, other: () => null, elsewhere: () => null, passkeyAvailable: () => false, ethAvailable: () => true, warm() {}, walletProvider: () => null,
    ready: async () => {}, lock() { on = false; emit(); }, onChange(f) { ls.add(f); return () => ls.delete(f); } };
}
export const signInSheet = async (s) => { window.__sheets = (window.__sheets || 0) + 1; await s.open.eth(); };
export const pickWalletSheet = async (l) => l[0]?.uuid;
`;

async function openPage({ hash = '', prog = program(), lp = campaign(), viewport = { width: 1280, height: 900 }, wallet = false, fake = false, scheme = 'light', st = {}, t = {} } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  Object.assign(st, { prog, sent: [], decline: 0, ...st });
  const answer = chain(st);
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, (route) => {
    const { id, method, params } = JSON.parse(route.request().postData() || '{}');
    try { return json(route, { jsonrpc: '2.0', id, result: answer(method, params) }); }
    catch (e) { return json(route, { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message } }); }
  });
  await ctx.route('https://api.tacit.finance/**', (route) => (/farm\/program/.test(route.request().url()) && st.prog ? json(route, st.prog) : json(route, null, 404)));
  await ctx.route('https://tacit-points.onrender.com/**', (route) => (lp ? json(route, lp) : json(route, { error: 'down' }, 503)));
  await ctx.route('https://ipfs.filebase.io/**', (route) => route.fulfill({ status: 404, body: '' }));
  if (fake) {
    await ctx.route(/\/trade\/poolux\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_POOLUX }));
    await ctx.route(/\/trade\/key\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_KEY }));
  }
  await ctx.exposeFunction('__walletAsk', async (method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_sendTransaction') {
      // a person's no takes a moment: one that comes back at once is asked again by the page's wallet guard (wallet-prompts.js)
      if (st.decline > 0) { st.decline--; await sleep(2300); return { __error: { code: 4001, message: 'User rejected the request.' } }; }
      const tx = params[0], hash = '0x' + W(st.sent.length + 1).slice(0, 62) + 'f1';
      st.sent.push({ ...tx, hash });
      return hash;
    }
    return { __error: { code: -32601, message: `the stub wallet has no ${method}` } };
  });
  await ctx.addInitScript(([on, tt, router]) => {
    window.__t = tt; window.__view0 = null;
    document.addEventListener('DOMContentLoaded', () => { window.__view0 = document.documentElement.dataset.view || ''; });
    if (!on) return;
    const provider = { isStub: true, on() {}, removeListener() {},
      async request({ method, params }) {
        const r = await window.__walletAsk(method, params);
        if (r && r.__error) throw Object.assign(new Error(r.__error.message), { code: r.__error.code });
        if (method === 'eth_sendTransaction' && String(params[0].to).toLowerCase() === router) window.__zapSent = true;
        return r;
      } };
    const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'stub-wallet-0001', name: 'Stub wallet', rdns: 'test.stub', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' }, provider }) }));
    addEventListener('eip6963:requestProvider', announce); announce();
  }, [wallet, t, ROUTER]);
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const x = m.text(); if (/Failed to load resource/.test(x)) return; (/Content Security Policy|Refused to/i.test(x) ? blocked : errors).push(x); } });
  await page.goto(`http://127.0.0.1:${WEB}/farm/${hash}`, { waitUntil: 'load' });
  if (wallet) {
    // the page offers the stub beside WalletConnect: the stub is chosen
    await page.click('#wallet-chip');
    await until(page, () => document.querySelector('#wallet-dot')?.classList.contains('on') || !!document.querySelector('.bsheet .picker .way'));
    const row = page.locator('.bsheet .picker .way', { hasText: 'Stub wallet' });
    if (await row.count()) await row.first().click();
    await until(page, () => document.querySelector('#wallet-dot')?.classList.contains('on') && !document.querySelector('.bsheet'));
  }
  return { browser, page, errors, blocked, st };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const tile = (page, id) => page.evaluate((i) => {
  const a = document.querySelector(`#d-${i}`);
  return a && { href: a.getAttribute('href'), name: a.querySelector('.nm').textContent, kind: a.querySelector('.kind').textContent, apr: a.querySelector('.apr').textContent, day: a.querySelector('.day')?.textContent || '',
    cost: a.querySelector('.cost')?.textContent || '', tag: a.querySelector('.tag')?.textContent || '', sel: a.querySelector('.sel').textContent, hidden: a.closest('li').hidden, top: Math.round(a.getBoundingClientRect().top), left: Math.round(a.getBoundingClientRect().left) };
}, id);
const settled = (page, id, want) => until(page, ([i, w]) => document.querySelector(`#d-${i} .apr`)?.textContent === w, [id, want]);
const wide = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
const clean = (r, what) => ok(!r.errors.length && !r.blocked.length, `${what}: no page errors and nothing blocked by the page's CSP${r.errors.length || r.blocked.length ? ` (${[...r.errors, ...r.blocked].slice(0, 3).join(' | ')})` : ''}`);
const quoted = (page) => until(page, () => !document.querySelector('#pz-rcpt').hidden && /Network fee|too small|Could not|decimals/.test(document.querySelector('#pz-rcpt').textContent));
const sayIs = (page, re, ms = 20000) => until(page, (s) => new RegExp(s).test(document.querySelector('#pz-say')?.textContent || ''), re.source, ms);

try {
  const prog = program(), priv = privateFarms(prog, TAC_ETH, PX);
  const costs = prog.pools.map((p) => costOf(p).cost), pubCost = 0.05 / (3 + 0.05) * 100;
  const nets = [['tac-eth', PUBLIC_APR * 7 / 365 - pubCost], ...priv.map((x, i) => [['teth-tac', 'teth-cusd', 'teth-cbtc'][i], x.apr * 7 / 365 - costs[i]])];
  const pick = nets.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0][0];

  // 1. The menu: every figure is the arithmetic's.
  if (runs('menu')) {
    const c = campaign(), total = c.pools.reduce((s, p) => s + Number(p.valueUsdWei) / 1e18 * Number(p.weightBps) / 1e4, 0), perUsd = Math.min(25 / total, 0.05), tace = campaignApr(perUsd, 10000, TAC_USD);
    // TACD's pools trade outside their range (the price under the low edge), TACE's inside it
    const band = (pool, now) => ({ [`${pool}:0x2af1f249`]: '0x' + W(now), [`${pool}:0x5c5ac485`]: '0x' + W(100), [`${pool}:0x87e43840`]: '0x' + W(200) });
    const r = await openPage({ lp: c, st: { table: { ...band(LP.tacdPeg, 50), ...band(LP.tacdBack, 50), ...band(LP.tacePeg, 150), ...band(LP.taceBack, 150) } } }), { page } = r;
    ok(await settled(page, 'tac-eth', aprText(PUBLIC_APR)), `the TAC / ETH tile settles on ${aprText(PUBLIC_APR)} (${PUBLIC_APR.toFixed(2)}%)`);
    ok(await settled(page, 'teth-cbtc', aprText(priv[2].apr)) && await settled(page, 'tace-eth', aprText(tace)), `the private tiles and the borrow market's settle (tETH / cBTC ${aprText(priv[2].apr)}, TACE / ETH ${aprText(tace)})`);
    await sleep(900);                                                                  // the tiles have risen into place
    const [pub, p0, p1, p2, te, td] = await Promise.all(['tac-eth', 'teth-tac', 'teth-cusd', 'teth-cbtc', 'tace-eth', 'tacd-usdc'].map((i) => tile(page, i)));
    ok(campaignRate(c).perUsd === 0.05, 'the campaign pays its cap at these depths');
    ok(pub.kind === 'Public pool' && pub.day === `${Math.round(PER_DAY)} TAC a day` && pub.href === '#tac-eth' && pub.sel === 'Select', `the public farm: ${pub.name}, ${pub.kind}, ${pub.apr}, ${pub.day}`);
    ok([p0, p1, p2].every((x, i) => x.apr === aprText(priv[i].apr) && x.kind === 'Private pool' && x.day === `${Math.round(priv[i].perDay)} TAC a day`), `the private farms: ${[p0, p1, p2].map((x) => `${x.name} ${x.apr}, ${x.day}`).join('; ')}`);
    ok(costs[1] >= 14 && costs[1] < 16 && p1.cost === `0.1 ETH entry −${pctTxt(costs[1])}` && !p0.cost && !pub.cost, `a pool priced away from the market says what the way in costs (${p1.cost}; the arithmetic ${costs[1].toFixed(2)}%), and a pool at the market's price does not`);
    ok(costs[2] < 5 && !p2.cost, `a small pool under 5% says nothing (tETH / cBTC ${costs[2].toFixed(2)}%)`);
    const tags = { 'tac-eth': pub.tag, 'teth-tac': p0.tag, 'teth-cusd': p1.tag, 'teth-cbtc': p2.tag };
    ok(Object.entries(tags).every(([id, tag]) => (id === pick ? tag === 'Chef’s pick' : !tag)), `the chef's pick is the best week for 0.1 ETH after the way in: ${pick} (${nets.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})`);
    ok(te.kind === 'Borrow market' && te.href === '/vault/#v=eth&pools' && te.sel === 'Supply' && !te.hidden, `the TACE / ETH market's tile leads to the vault's pools (${te.apr})`);
    ok(td.hidden, 'TACD’s pools trade outside their range, so its tile is not offered');
    ok(pub.top === p0.top && p0.top === p1.top && p2.top > pub.top && pub.left < p0.left && p0.left < p1.left, 'three tiles to a row on a desktop');
    ok(await page.evaluate(() => document.querySelector('header .sn a[href="/farm/"]')?.getAttribute('aria-current') === 'page'), 'the header’s Farm link is this page');
    ok(await wide(page) <= 0, 'nothing is wider than the screen');
    await shot(page, 'menu-1280');
    clean(r, 'menu');
    await r.browser.close();

    // between reward periods, and the campaign's service down
    const dry = await openPage({ prog: program({ active: false }), lp: null });
    ok(await until(dry.page, () => document.querySelector('#d-teth-tac .kind')?.textContent === 'Between reward periods'), 'between reward periods the private tiles say so');
    const d0 = await tile(dry.page, 'teth-tac'), dm = await tile(dry.page, 'tace-eth');
    ok(d0.apr === '' && d0.day === '' && !d0.tag, 'and show no APR, no daily figure and no pick');
    ok(await until(dry.page, () => document.querySelector('#d-tace-eth').closest('li').hidden) && dm !== null, 'with the campaign’s service not answering, the borrow markets’ tiles are not offered');
    clean(dry, 'menu, dry');
    await dry.browser.close();

    // a farm the page did not list is drawn like the others
    const more = await openPage({ prog: program({ extra: [{ pid: 3, pair: 'cETH/cTEST', poolId: '0x' + '04'.repeat(32), lpAsset: '0x' + 'a4'.repeat(32), feeBps: 30, lockSeconds: 0, tacPerDayForPool: '50', totalShares: '1000', reserves: { assetA: CETH, assetB: '0x' + '0f'.repeat(32), reserveA: '100000000', reserveB: '100000000', lpTotalShares: '100000000' } }] }) });
    ok(await until(more.page, () => !!document.querySelector('#d-teth-ctest')), 'a farm the program adds gets a tile');
    const x = await tile(more.page, 'teth-ctest');
    ok(x.name === 'tETH / cTEST' && x.href === '#teth-ctest' && x.day === '50 TAC a day', `drawn like the others (${x.name}, ${x.day})`);
    clean(more, 'menu, a new farm');
    await more.browser.close();
  }

  // 2. A tile opens its farm in place; the way back; a link to a farm.
  if (runs('route')) {
    const r = await openPage(), { page } = r;
    await settled(page, 'teth-tac', aprText(priv[0].apr));
    await page.evaluate(() => scrollTo(0, 120));
    await page.click('#d-teth-tac');
    ok(await until(page, () => !document.querySelector('#station').hidden && document.querySelector('#menu').hidden && location.hash === '#teth-tac'), 'a tile opens its farm in place, with its address');
    ok(await text(page, '#k-name') === 'tETH / TAC' && await text(page, '#k-kind') === 'Private pool' && await text(page, '#k-apr') === aprText(priv[0].apr) && await page.title() === 'tacit farm · tETH / TAC', `the farm’s head: ${await text(page, '#k-name')}, ${await text(page, '#k-kind')}, ${await text(page, '#k-apr')}; the tab says ${await page.title()}`);
    ok(await page.evaluate(() => !document.querySelector('#k-priv').hidden && document.querySelector('#k-pub').hidden && !document.querySelector('#k-mine').hidden), 'a private farm shows its own form and the key’s positions');
    ok(/Rewards500 TAC a dayabout \$120\.00 a dayIn the pool\$48,000tETH and TACStream ends\d/.test(await text(page, '#pz-stats')), `its facts: ${await text(page, '#pz-stats')}`);
    const sw = await page.evaluate(() => [...document.querySelectorAll('#sw a')].map((a) => a.getAttribute('href')));
    ok(sw.join() === '#tac-eth,#teth-cusd,#teth-cbtc', `the other farms are a press away (${sw.join(' ')})`);
    await page.click('#sw a[href="#tac-eth"]');
    ok(await until(page, () => location.hash === '#tac-eth' && document.querySelector('#k-name').textContent === 'TAC / ETH' && !document.querySelector('#k-pub').hidden && document.querySelector('#k-mine').hidden), 'another farm opens over it');
    ok(await until(page, () => /Farm TAC\/ETH/.test(document.querySelector('#farm-host')?.textContent || '') && !!document.querySelector('#farm-host .quick')), 'the public farm is the Precision farm’s own form, with amounts under its field');
    await page.click('#bk');
    ok(await until(page, () => document.querySelector('#station').hidden && !document.querySelector('#menu').hidden && location.hash === ''), 'the way back shows the menu again');
    ok(await page.title() === 'tacit farm', 'and the tab’s title is the page’s');
    await page.goBack();
    ok(await until(page, () => location.hash === '#tac-eth' && !document.querySelector('#station').hidden), 'the browser’s Back returns to the farm');
    await page.focus('#fm-amt');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.activeElement?.id !== 'fm-amt' && !document.querySelector('#station').hidden), 'Escape in the amount leaves the field and keeps the farm open');
    await page.keyboard.press('Escape');
    ok(await until(page, () => document.querySelector('#station').hidden), 'a second Escape closes it');
    clean(r, 'routes');
    await r.browser.close();

    const deep = await openPage({ hash: '#teth-cusd' });
    ok(await deep.page.evaluate(() => window.__view0) === 'farm', 'a link to a farm marks the page before its script runs, so the menu is never shown first');
    ok(await until(deep.page, () => !document.querySelector('#station').hidden && document.querySelector('#k-name').textContent === 'tETH / cUSD'), 'and opens on that farm');
    clean(deep, 'a link to a farm');
    await deep.browser.close();
    const none = await openPage({ hash: '#teth-nothing' });
    ok(await until(none.page, () => !document.querySelector('#menu').hidden && location.hash === '' && document.documentElement.dataset.view === 'menu'), 'a link to a farm that does not exist shows the menu');
    await none.browser.close();
  }

  // 3. The TAC/ETH farm: an amount from a press, one transaction.
  if (runs('public')) {
    const r = await openPage({ hash: '#tac-eth', wallet: true }), { page, st } = r;
    ok(await until(page, () => !!document.querySelector('#farm-host .quick [data-q="0.1"]') && /Farm with ETH|Enter an amount/.test(document.querySelector('#fm-go')?.textContent || '')), 'with a wallet the form is ready for an amount');
    ok(await page.evaluate(() => getComputedStyle(document.querySelector('#farm-host .fm-stats > div')).display === 'none' && document.querySelectorAll('#farm-host .fm-stats > div').length === 4), 'the farm’s APR is said once, in the card’s head');
    await page.click('#farm-host .quick [data-q="0.1"]');
    ok(await until(page, () => document.querySelector('#fm-amt').value === '0.1' && /Earns about/.test(document.querySelector('#fm-rcpt')?.textContent || '')), `a press fills the amount and the form prices it (${await text(page, '#fm-rcpt')})`);
    ok(await until(page, () => document.querySelector('#fm-go').textContent === 'Farm with ETH' && !document.querySelector('#fm-go').disabled), 'the button is ready');
    await shot(page, 'public-quote');
    await page.click('#fm-go');
    ok(await until(page, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || '')), `the deposit goes through (${await text(page, '#fm-status')})`);
    const tx = st.sent[0];
    ok(st.sent.length === 1 && lc(tx.to) === PRECISION_FARM && tx.data.startsWith('0x8703a0d8') && BigInt(tx.value) === 10n ** 17n, `one transaction: 0.1 ETH into the farm’s zap (${tx?.data?.slice(0, 10)})`);
    ok(await until(page, () => document.querySelector('#chef').dataset.mood === 'up' || !!document.querySelector('#fx')), 'and the chef cheers');
    clean(r, 'the public farm');
    await r.browser.close();

    const mine = await openPage({ wallet: true, st: { staked: 100n * E18, earned: 3n * E18 } });
    ok(await until(mine.page, () => document.querySelector('#d-tac-eth .sel')?.textContent === 'Manage' && document.querySelector('#d-tac-eth .yours')?.textContent === 'Yours'), 'a wallet with a stake sees its tile marked, with Manage');
    await mine.browser.close();
  }

  // 4. A private farm: the quote, the hold on a dear deposit, the three steps, and what each failure leaves.
  if (runs('private')) {
    const p0 = prog.pools[0], m0 = costOf(p0), value = m0.plan.value, day0 = 500 * Number(m0.plan.shares) / (90000000000 + Number(m0.plan.shares));
    {
      const r = await openPage({ hash: '#teth-tac', fake: true }), { page } = r;
      await until(page, () => document.querySelector('#pz-go').textContent === 'Connect wallet');
      await page.click('#pz .quick [data-q="0.1"]');
      ok(await quoted(page), 'with no wallet a deposit is still priced');
      const rc = await text(page, '#pz-rcpt');
      ok(new RegExp(`Earns about${day0.toFixed(2)} TAC a day`).test(rc) && /You holda private tETH \/ TAC position/.test(rc) && /Exitany time, as private tETH and TAC/.test(rc) && /Chain seesETH in, private after/.test(rc) && /Network fee≈ \$/.test(rc), `the receipt: ${rc}`);
      ok(!/Price impact|Against the market/.test(rc), `a deposit that moves the pool ${m0.impact.toFixed(2)}% says nothing of it`);
      ok(await text(page, '#pz-go') === 'Connect wallet', 'and the button connects');
      const rcptSays = (re) => until(page, (s) => new RegExp(s).test(document.querySelector('#pz-rcpt').textContent), re.source, 8000);
      await page.fill('#pz-amt', '0.123456789');
      ok(await rcptSays(/Up to 8 decimals/), 'an amount finer than the pool counts is said');
      await page.fill('#pz-amt', 'abc');
      ok(await rcptSays(/Could not read that amount/), 'and one that is not a number');
      await page.fill('#pz-amt', '0.000000001');
      ok(await rcptSays(/Up to 8 decimals|too small/), 'and one too small to make a share');
      await shot(page, 'private-quote');
      clean(r, 'a private quote');
      await r.browser.close();
    }
    {
      // the pool priced away from the market: the cost is said, and the press waits for it to be accepted
      const r = await openPage({ hash: '#teth-cusd', fake: true, wallet: true }), { page } = r, m1 = costOf(prog.pools[1]);
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      const rc = await text(page, '#pz-rcpt');
      ok(new RegExp(`Against the market${pctTxt(m1.against)} of this deposit`).test(rc) && /price for cUSD is \d+% above the market’s/.test(rc), `what the pool’s price costs is said (${m1.against.toFixed(2)}%): ${rc.slice(0, 220)}`);
      ok(m1.cost >= 15 && await page.evaluate(() => !!document.querySelector('#pz-ack') && document.querySelector('#pz-go').disabled && document.querySelector('#pz-go').textContent === 'Farm privately'), 'at 15% or more the button waits for the loss to be accepted');
      await page.check('#pz-ack');
      ok(await until(page, () => !document.querySelector('#pz-go').disabled), 'and is ready once it is');
      await shot(page, 'private-dear');
      await r.browser.close();
    }
    {
      // the whole deposit
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      ok(await until(page, () => /Balance 5 · Max/.test(document.querySelector('#pz-max')?.textContent || '')), 'the wallet’s balance stands over the field, with Max');
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      ok(await until(page, () => !document.querySelector('#pz-go').disabled && document.querySelector('#pz-go').textContent === 'Farm privately'), 'priced, the button says Farm privately');
      await page.evaluate(() => { window.__says = []; new MutationObserver(() => window.__says.push(document.querySelector('#pz-say').textContent)).observe(document.querySelector('#pz-say'), { childList: true, subtree: true, characterData: true }); });
      await page.click('#pz-go');
      ok(await sayIs(page, /In the farm/), `the deposit ends in the farm (${await text(page, '#pz-say')})`);
      const ux = await page.evaluate(() => window.__ux), says = await page.evaluate(() => window.__says);
      ok(await page.evaluate(() => window.__keyOpens === 1 && !window.__sheets), 'the wallet connected here opened the Tacit key, with no sheet');
      const order = ['index', 'build', 'prove:wrap', 'bond'].map((k) => ux.findIndex((x) => x.startsWith(k)));
      ok(order.every((i) => i >= 0) && order.join() === [...order].sort((a, b) => a - b).join() && ux.filter((x) => x.startsWith('prove')).length === 1 && ux.filter((x) => x.startsWith('bond')).length === 1, `one proof, then one farm entry (${ux.filter((x) => !/^balance|forget/.test(x)).join(', ')})`);
      const tx = st.sent[0];
      ok(st.sent.length === 1 && lc(tx.to) === ROUTER && tx.data.startsWith('0xc4294fac') && BigInt(tx.value) === value && BigInt('0x' + tx.data.slice(10 + 4 * 64, 10 + 5 * 64)) === m0.plan.shares, `one transaction between them: the router’s zap for exactly the ${m0.plan.shares} shares proved, ${Number(value) / 1e18} ETH`);
      const seen = (re) => says.findIndex((s) => re.test(s));
      ok(seen(/Nothing has left your wallet/) >= 0 && seen(/Confirm in your wallet/) > seen(/Nothing has left your wallet/) && seen(/putting your share in the farm/) > seen(/Confirm in your wallet/), 'the steps were said in order: the proof with nothing sent, the wallet, the farm');
      ok(await page.evaluate(() => [...document.querySelectorAll('#pz-steps li')].every((li) => li.dataset.at === 'done') && document.querySelector('#pz-amt').value === '' && document.querySelector('#pz-rcpt').hidden), 'all three steps are done and the form is clear');
      ok(await until(page, () => /0 TAC earned/.test(document.querySelector('#pf-mine')?.textContent || '')), `the new position is listed under Your private farms (${(await text(page, '#pf-mine')).slice(0, 80)})`);
      ok(await until(page, () => document.querySelector('#d-teth-tac .yours')?.textContent === 'Yours'), 'and its tile is marked');
      await shot(page, 'private-done');
      clean(r, 'a private deposit');
      await r.browser.close();
    }
    {
      // the wallet says no: nothing is sent, the proof is kept, and the next press sends it without another proof
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, st: { decline: 1 } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /Not sent\. Your share’s proof is kept/), `a no in the wallet: ${await text(page, '#pz-say')}`);
      ok(st.sent.length === 0 && await until(page, () => !document.querySelector('#pz-go').disabled && document.querySelector('#pz-go').textContent === 'Farm privately'), 'nothing was sent and the button is back');
      await page.click('#pz-go');
      ok(await sayIs(page, /In the farm/), 'the next press goes through');
      const ux = await page.evaluate(() => window.__ux);
      ok(ux.filter((x) => x.startsWith('prove')).length === 1 && st.sent.length === 1 && !ux.some((x) => x.startsWith('release')), `with the proof made the first time (${ux.filter((x) => /^(prove|release|bond)/.test(x)).join(', ')})`);
      await r.browser.close();
    }
    {
      // the prover is not proving: nothing is asked of the wallet
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { proving: false } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /not taking proofs right now\. Nothing was sent/), `a prover that is not proving: ${await text(page, '#pz-say')}`);
      ok(st.sent.length === 0 && await page.evaluate(() => /card=earn:ether:p0&amt=0\.1/.test(document.querySelector('#pz-acts a')?.getAttribute('href') || '')), 'nothing was sent, and the front page’s other ways to prove are a link away');
      ok(await page.evaluate(() => !(window.__ux || []).some((x) => x.startsWith('prove'))), 'and no proof was asked for');
      await shot(page, 'private-noprover');
      await r.browser.close();
    }
    {
      // the farm entry fails after the transaction: the share is the key's, and Farm it finishes
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { bondFail: true } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /Your share is private and safe/), `a farm entry the relay cannot take: ${await text(page, '#pz-say')}`);
      ok(st.sent.length === 1 && await page.evaluate(() => !!document.querySelector('#pz-acts [data-act="farmit"]') && document.querySelector('#pz-steps li[data-s="farm"]').dataset.at === 'bad'), 'the transaction landed, the last step is marked, and Farm it is offered');
      ok(await until(page, () => /share of yours is private and not in the farm/.test(document.querySelector('#pz-loose')?.textContent || '')), 'the share is also said over the positions');
      await shot(page, 'private-share');
      await page.evaluate(() => { window.__t.bondFail = false; });
      await page.click('#pz-acts [data-act="farmit"]');
      ok(await sayIs(page, /In the farm/), 'Farm it puts it in the farm');
      ok(st.sent.length === 1 && await page.evaluate(() => window.__ux.filter((x) => x.startsWith('bond')).length === 2 && window.__ux.filter((x) => x.startsWith('prove')).length === 1), 'with no second transaction and no second proof');
      ok(await until(page, () => document.querySelector('#pz-loose').textContent === ''), 'and the note over the positions goes');
      await r.browser.close();
    }
    {
      // the pool moves between the quote and the press: the new figures are shown and nothing is proved
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      st.prog = program(); st.prog.pools[0].reserves.reserveA = '1100000000';           // ETH is cheaper in the pool now: the same deposit makes fewer shares
      await page.click('#pz-go');
      ok(await until(page, () => /The price moved\. Nothing was sent/.test(document.querySelector('#pz-status')?.textContent || '')), `a pool that moved against the quote: ${await text(page, '#pz-status')}`);
      ok(st.sent.length === 0 && await page.evaluate(() => !(window.__ux || []).some((x) => x.startsWith('prove')) && document.querySelector('#pz-cook').hidden), 'nothing was proved or sent');
      await r.browser.close();
    }
    {
      // a key the tab already has open, holding a share that is in no farm
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, loose: LPA[0] } }), { page } = r;
      ok(await until(page, () => /A tETH \/ TAC share of yours is private and not in the farm/.test(document.querySelector('#pz-loose')?.textContent || '')), 'a share in no farm is said as soon as the key is open');
      await page.click('#pz-loose [data-loose="0"]');
      ok(await sayIs(page, /In the farm/), 'and its Farm it bonds it');
      ok(await page.evaluate(() => window.__ux.filter((x) => x.startsWith('bond')).length === 1 && !window.__keyOpens), 'with the key the tab had, no sign-in');
      clean(r, 'a share in no farm');
      await r.browser.close();
    }
  }

  // 5. A phone: two tiles to a row, nothing wider than the screen, in the dark too.
  if (runs('phone')) {
    const r = await openPage({ viewport: { width: 390, height: 844 }, scheme: 'dark' }), { page } = r;
    await settled(page, 'teth-cbtc', aprText(priv[2].apr));
    await sleep(900);
    const [a, b, c] = await Promise.all(['tac-eth', 'teth-tac', 'teth-cusd'].map((i) => tile(page, i)));
    ok(a.top === b.top && c.top > a.top && a.left < b.left, 'two tiles to a row on a phone');
    ok(await wide(page) <= 0, 'the menu is no wider than the screen');
    ok(await page.evaluate(() => { const t = document.querySelector('.dish .tag'), p = t?.closest('.dish').querySelector('.plate'); if (!t) return true; const x = t.getBoundingClientRect(), y = p.getBoundingClientRect(); return x.bottom <= y.top; }), 'the pick’s tag sits clear of its plate');
    await shot(page, 'menu-390-dark');
    await page.click('#d-teth-cusd');
    await until(page, () => !document.querySelector('#station').hidden);
    await page.fill('#pz-amt', '0.5'); await quoted(page);
    ok(await wide(page) <= 0, 'a private farm with its receipt is no wider than the screen');
    await shot(page, 'private-390-dark');
    await page.click('#sw a[href="#tac-eth"]');
    await until(page, () => !!document.querySelector('#farm-host .quick'));
    ok(await wide(page) <= 0, 'nor is the public farm');
    await shot(page, 'public-390-dark');
    clean(r, 'a phone');
    await r.browser.close();
  }
} catch (e) { fails++; console.log('FAIL   the run stopped: ' + (e?.stack || e)); }

server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
