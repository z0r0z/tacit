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

const { privateFarms, aprText, poolWorthEth } = await import('../dapp/trade/farm-read.js');
const { usd } = await import('../dapp/trade/util.js');
const { campaignRate, campaignApr } = await import('../dapp/trade/lp-campaign.js');
const { zapMath, marketOf } = await import('../dapp/farm/zap.js');
const { zapPlanFor, payback, streamDays } = await import('../dapp/lp-zap.js');
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
// SPX, as the program lists its two standalone pools (real reserves): SPX / TAC, with no ETH side, and tETH / SPX, which prices a coin of SPX a sixth over its
// public market. The pool holds SPX in 8 decimals with a unit of 1 (TAC and tETH: 18 decimals, a unit of 1e10), and its token is in no deployment list.
const A_SPX = '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48', SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c', ZQUOTER = '0x000000bd2db80567c23e353ca95a251c573cbf9b';
const SPX_ETH = 0.000168;                                                              // the public market's price: ETH a coin
const SPX_POOLS = [
  { pid: 1000, standalone: true, pair: 'SPX/TAC', poolId: '0x' + '04'.repeat(32), lpAsset: '0x' + 'a4'.repeat(32), feeBps: 30, lockSeconds: 0, tacPerDayForPool: '66', totalShares: '111444012189', reserves: { assetA: A_SPX, assetB: A_TAC, reserveA: '94049805307', reserveB: '132059268180', lpTotalShares: '111444013189' } },
  { pid: 1001, standalone: true, pair: 'SPX/cETH', poolId: '0x' + '05'.repeat(32), lpAsset: '0x' + 'a5'.repeat(32), feeBps: 30, lockSeconds: 0, tacPerDayForPool: '33', totalShares: '858622147', reserves: { assetA: CETH, assetB: A_SPX, reserveA: '12108999', reserveB: '61218265385', lpTotalShares: '860869819' } },
];
const ROWS = {                                                                         // assets(bytes32): how the pool holds each coin
  [CETH]: { token: ZERO, unit: 10n ** 10n, minted: false, dec: 18 }, [A_TAC]: { token: TAC, unit: 10n ** 10n, minted: true, dec: 18 },
  [A_CUSD]: { token: '0x23cacffac2674514a6d4f6cd420b4cc2ac921564', unit: 10n ** 10n, minted: true, dec: 18 }, [A_CBTC]: { token: '0xdf1d99148beb7a9aff1d95c49b3d22b7ed90d696', unit: 10n ** 10n, minted: true, dec: 18 },
  [A_SPX]: { token: SPX, unit: 1n, minted: false, dec: 8 },
};
const spxOut = (wei) => BigInt(Math.floor(Number(wei) / SPX_ETH / 1e10));              // SPX (8 decimals) the public market gives for `wei`
const spxRate = (probe = 10n ** 16n) => Number(probe) / 1e18 / (Number(spxOut(probe)) / 1e8);       // the price the page reads from that answer: ETH a coin
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

const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'mainnet.rpc.buidlguidl.com', 'tacit-node-gw.onrender.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.mevblocker.io', 'eth-mainnet.nodereal.io', '1.rpc.thirdweb.com', 'rpc.flashbots.net', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io'];
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
    if (st.noPrices && (to === CHAINLINK_ETH || to === CHAINLINK_BTC)) { st.pricesAsked = (st.pricesAsked || 0) + 1; throw Object.assign(new Error('execution reverted'), { code: 3 }); }      // the price feeds not answering
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
    if (to === POOL && sel === '0x7da9874f') return '0x' + W(st.consumed ? 2 : 0);     // depositStatus: none made (2: an earlier press made it)
    if (to === POOL && sel === '0x9fda5b66') {                                         // assets(bytes32): how the pool holds a coin
      const row = ROWS['0x' + data.slice(10, 74)];
      return row ? '0x' + W(1) + W(BigInt(row.token)) + W(row.unit) + W(1) + W(row.minted ? 1 : 0) + W(row.dec) : '0x' + W(0).repeat(6);
    }
    if (to === ZQUOTER && sel === '0xe7798987') {                                      // buildBestSwap: the best public route for ETH into SPX (a hundredth of an ETH is read for its price)
      if (st.noSpxMarket) throw Object.assign(new Error('execution reverted'), { code: 3 });
      st.spxReads = (st.spxReads || 0) + 1;
      const out = spxOut(arg(4));
      return '0x' + W(3) + W(30) + W(arg(4)) + W(out) + W(7 * 32) + W(out * 99n / 100n) + W(arg(4)) + W(0);
    }
    if (to === ROUTER && sel === '0xc4294fac') { if (st.routerRevert) throw Object.assign(new Error('execution reverted'), { code: 3 }); return '0x' + W(arg(4)); }      // the zap run as a call: it mints the share count it names
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
    if (method === 'eth_getTransactionReceipt') return st.sent.some((x) => x.hash === params?.[0]) ? { status: st.revert ? '0x0' : '0x1', transactionHash: params[0], blockNumber: '0x1700001', logs: [] } : null;
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
    async waitForSettle(id, o) { note('follow', id + '@' + o.openGraceMs); await sleep(T().sendMs ?? 600); T().bonded = true; T().joined = true; return { status: 'settled', jobId: id, txHash: '0x' + '44'.repeat(32) }; },
  },
  nextShareIndex: () => { note('index'); return 3; },
  releaseShareIndex: ({ index }) => note('release', index),
  buildShareWrap: ({ poolId, shares, index }) => { note('build', shares); return { leaf: LEAF, depositId: '0x' + 'dd'.repeat(32), commit: '0x' + 'cc'.repeat(32), wrapOp: { value: String(shares) }, outputs: [], memos: ['0x01'], ephRand: '0x02', index, wrapArgs: { assetId: poolId } }; },
  wrapProofFits: () => T().wrongProof !== true,
  async balance() {
    note('balance');
    const loose = T().loose ? [{ leaf: '0x' + 'ab'.repeat(32), asset: T().loose, value: '1000', owner: '0x01' }] : [];
    const made = window.__zapSent && !T().bonded ? [{ leaf: LEAF, asset: T().lpAsset || '${LPA[0]}', value: '1', owner: '0x02' }] : [];
    return { notes: [...loose.filter(() => !T().bonded), ...made, ...(T().joined ? [] : T().privNotes || [])], spentNotes: [] };
  },
  async lpBond({ aNote, bNote, controller, waitOpts }) { note('lpbond', aNote.value + '+' + bNote.value + '@' + controller.slice(0, 8)); await sleep(150);
    // a trade lands while it is proved: the relay holds the proof open and the pool refuses it as moved (rpc below), for the first bondMoved presses
    if (T().bondMoved > 0) { T().bondMoved--; T().deadProof = true; waitOpts?.onJob?.('job-dead', 'lpbond'); throw Object.assign(new Error('settle held: proved and waiting for a sender (job job-dead); it can be sent from any account now'), { code: 'open', open: { jobId: 'job-dead', publicValues: '0x01', proof: '0x02', memos: [] } }); }
    T().deadProof = false; if (T().joinFail) throw Object.assign(new Error('relay 503: temporarily unavailable'), { code: 'relay_held' }); T().joined = true; T().bonded = true; return { jobId: 'job-lpbond', txHash: '0x' + '33'.repeat(32) }; },
  async transfer() { note('transfer'); throw new Error('this stand-in does not cut notes'); },
  async farmBond({ lpNote, waitOpts, selfSettle }) { note(selfSettle ? 'bond-own' : 'bond', lpNote.leaf.slice(0, 6)); waitOpts?.onJob?.('job-bond', 'farmbond'); await sleep(T().bondMs ?? 200);
    // proved for the wallet to send (the relay's free sends for the day used up): the page's sender sends it
    if (selfSettle) { const r = await selfSettle({ jobId: 'job-bond-own', publicValues: '0x' + 'a1'.repeat(8), proof: '0x' + 'b2'.repeat(8), memos: [] }); T().bonded = true; return { jobId: 'job-bond-own', ...r }; }
    if (T().bondDay) throw Object.assign(new Error('free relayed settles for today are used up (8/8) — attach a fee above the floor, or prove-mode and settle it yourself'), { code: 'free_budget', class: 'farm' });
    if (T().bondOpen) throw Object.assign(new Error('settle held: proved and waiting for a sender (job job-bond); it can be sent from any account now'), { code: 'open', open: { jobId: 'job-bond', publicValues: '0x01', proof: '0x02', memos: [] } });
    if (T().bondFail) throw Object.assign(new Error('relay 503: temporarily unavailable'), { code: 'relay_paused' }); T().bonded = true; return { jobId: 'job-bond', txHash: '0x' + '22'.repeat(32) }; },
  settleCalldata: ({ publicValues, proof }) => '0x8b8c6b4b' + String(publicValues).slice(2) + String(proof).slice(2),
  rpc: async (m) => { note('rpc', m); if (m === 'eth_estimateGas') return '0x7a120'; if (m === 'eth_call' && T().deadProof) throw Object.assign(new Error('execution reverted'), { revert: true, data: '0x29b3c833' }); throw new Error('the stand-in has no ' + m); },
  farmPositions: async () => (T().bonded ? [{ pid: 0, receiptLeaf: '0x' + '77'.repeat(32), pendingUnits: '0', pendingTac: '0', shares: '1' }] : (T().positions || [])),
  ethCall: async () => '0x' + '0'.repeat(64), identity: () => ({ pubHex: '02' + 'ab'.repeat(32) }), poolTickerOf: (id) => ({ '${A_TAC}': 'TAC', '${A_CUSD}': 'cUSD', '${A_CBTC}': 'cBTC' })[String(id).toLowerCase()] || 'cETH', quoteOpFee: async () => { if (T().opFeeFail) throw new Error('relay fee unavailable'); return BigInt(T().opFee || 0); }, quoteUnwrapFee: () => ({ net: 1n, fee: 0n }),
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
    ready: () => (window.__t.readyHang ? new Promise(() => {}) : Promise.resolve()), lock() { on = false; emit(); }, onChange(f) { ls.add(f); return () => ls.delete(f); } };
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
  await ctx.route('https://api.tacit.finance/**', async (route) => { if (st.progDelay) await sleep(st.progDelay); return /farm\/program/.test(route.request().url()) && st.prog ? json(route, st.prog) : json(route, null, 404); });
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
  const costs = prog.pools.map((p) => costOf(p).cost), pubCost = 0.05 / (3 + 0.05) * 50;
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
    ok([p0, p1, p2].every((x, i) => x.apr === aprText(priv[i].apr) && x.kind === `Private pool · ${usd(poolWorthEth(prog.pools.find((q) => q.pid === priv[i].pid), TAC_ETH, PX) * ETH_USD)}` && x.day === `${Math.round(priv[i].perDay)} TAC a day`), `the private farms (each tile says what its pool holds, in dollars): ${[p0, p1, p2].map((x) => `${x.name} ${x.apr}, ${x.day}`).join('; ')}`);
    ok(costs[1] >= 14 && costs[1] < 16 && p1.cost === `Putting in 0.1 ETH costs about ${pctTxt(costs[1])} on the way in` && !p0.cost && !pub.cost, `a pool priced away from the market says what the way in costs (${p1.cost}; the arithmetic ${costs[1].toFixed(2)}%), and a pool at the market's price does not`);
    ok(costs[2] < 5 && !p2.cost, `a small pool under 5% says nothing (tETH / cBTC ${costs[2].toFixed(2)}%)`);
    const tags = { 'tac-eth': pub.tag, 'teth-tac': p0.tag, 'teth-cusd': p1.tag, 'teth-cbtc': p2.tag };
    ok(Object.entries(tags).every(([id, tag]) => (id === pick ? tag === 'Chef’s pick · most TAC for 0.1 ETH' : !tag)), `the chef's pick is the best week for 0.1 ETH after the way in: ${pick} (${nets.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})`);
    ok(te.kind === 'Borrow market' && te.href === '/vault/#v=eth&pools' && te.sel === 'Supply' && !te.hidden, `the TACE / ETH market's tile leads to the vault's pools (${te.apr})`);
    ok(td.hidden, 'TACD’s pools trade outside their range, so its tile is not offered');
    ok(pub.top === p0.top && p0.top === p1.top && p2.top > pub.top && pub.left < p0.left && p0.left < p1.left, 'three tiles to a row on a desktop');
    // the header's Farm link, or, in a header of sections, DeFi with its Farm tab (the section's head, #sec-head)
    ok(await page.evaluate(() => { const on = (s) => document.querySelector(s)?.getAttribute('aria-current') === 'page'; return on('header .sn a[href="/farm/"]') || (on('header .sn a[href="/#/defi"]') && on('#sec-head .sh-t a[href="/farm/"]')); }), 'the header’s Farm link (or DeFi and its Farm tab) is this page');
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
    await sleep(400);                                                                  // opening a farm focuses its amount a moment later
    await page.focus('#fm-amt');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.activeElement?.id !== 'fm-amt' && !document.querySelector('#station').hidden), 'Escape in the amount leaves the field and keeps the farm open');
    await page.keyboard.press('Escape');
    ok(await until(page, () => document.querySelector('#station').hidden), 'a second Escape closes it');
    clean(r, 'routes');
    await r.browser.close();

    {
      // a farm opened and closed again while the page's own transition is still running: the transition the next one skips is not a page error
      const q = await openPage(), { page } = q;
      await settled(page, 'teth-tac', aprText(priv[0].apr));
      // the way back is pressed in the very frame the farm is shown, which starts a second transition before the first has begun to animate: that one is skipped
      await page.evaluate(() => new Promise((resolve) => {
        const st = document.querySelector('#station');
        new MutationObserver((_, ob) => { if (!st.hidden) { ob.disconnect(); document.querySelector('#bk').click(); resolve(); } }).observe(st, { attributes: true, attributeFilter: ['hidden'] });
        document.querySelector('#d-teth-tac').click();
      }));
      ok(await until(page, () => !document.querySelector('#menu').hidden && document.querySelector('#station').hidden && location.hash === ''), 'the menu is back');
      await sleep(600);
      clean(q, 'a farm opened and closed in the same frame');
      await q.browser.close();
    }

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

    {
      // with no TAC in the wallet, ETH + TAC offers to buy some on the front page, and that link says which farm to come back to
      const b = await openPage({ hash: '#tac-eth', wallet: true }), q = b.page;
      await until(q, () => !!document.querySelector('#fm-mode [data-fm="pair"]'));
      await q.click('#fm-mode [data-fm="pair"]');
      ok(await until(q, () => document.querySelector('#fm-how a')?.getAttribute('href') === '/#card=swap:ether:tac&back=tac-eth'), `buying TAC leads to the front page's swap and says the way back (${await q.evaluate(() => document.querySelector('#fm-how a')?.getAttribute('href'))})`);
      await b.browser.close();
    }
    {
      // the farm page is where a way back goes: opening it spends the one the front page kept
      const b = await openPage({ hash: '#teth-cbtc' }), q = b.page;
      await q.evaluate(() => sessionStorage.setItem('tacit-farm-back-v1', JSON.stringify({ id: 'teth-cbtc', at: Date.now() })));
      await q.reload({ waitUntil: 'load' });
      ok(await q.evaluate(() => sessionStorage.getItem('tacit-farm-back-v1')) === null, 'opening the farm page clears the way back the front page kept');
      await b.browser.close();
    }

    const mine = await openPage({ wallet: true, st: { staked: 100n * E18, earned: 3n * E18 } });
    ok(await until(mine.page, () => document.querySelector('#d-tac-eth .sel')?.textContent === 'Manage' && document.querySelector('#d-tac-eth .yours')?.textContent === 'Yours'), 'a wallet with a stake sees its tile marked, with Manage');
    await mine.page.mouse.move(0, 0);                                                  // no tile under the pointer (a hovered one lifts)
    await sleep(900);                                                                  // the tiles have risen into place
    // a marked tile is laid out as an unmarked one: it fills its cell (the positions panel's .mine rule once gave it a margin and padding)
    const cells =await mine.page.evaluate(() => [...document.querySelectorAll('#dishes .dish')].filter((a) => a.offsetParent).map((a) => {
      const b = a.getBoundingClientRect(), c = a.parentElement.getBoundingClientRect(), s = getComputedStyle(a);
      return { id: a.id, top: b.top - c.top, bottom: b.bottom - c.bottom, pad: s.padding, margin: s.marginTop };
    }));
    ok(cells.length >= 4 && cells.every((x) => Math.abs(x.top) < 0.5 && Math.abs(x.bottom) < 0.5 && x.margin === '0px' && x.pad === cells[0].pad), 'a marked tile fills its cell like the others, with the same padding');
    await shot(mine.page, 'menu-held');
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
      ok(!/Price impact|Against the market|Rewards make it up/.test(rc), `a deposit that moves the pool ${m0.impact.toFixed(2)}% says nothing of it`);
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
      const back = payback({ cost: m1.cost, eth: Number(m1.plan.value) / 1e18, day: 300 * Number(m1.plan.shares) / (8000000000 + Number(m1.plan.shares)), tacEth: TAC_ETH, left: streamDays({ end: FINISH }) });
      ok(back && rc.includes(`Rewards make it up${back.text}`), `the receipt says how long the farm's TAC takes to make up the way in (${back?.text}): ${rc.slice(0, 400)}`);
      ok(new RegExp(`Against the market${pctTxt(m1.against)} of this deposit`).test(rc) && /price for cUSD is \d+% above the market’s/.test(await text(page, '#pz-off')), `what the pool’s price costs is said (${m1.against.toFixed(2)}%): ${rc.slice(0, 220)}`);      // a pool off the market says so above the form, before any amount
      ok(m1.cost >= 15 && await page.evaluate(() => document.querySelector('#pz-ack')?.type === 'text' && document.querySelector('#pz-go').disabled && document.querySelector('#pz-go').textContent === 'Farm privately'), 'in a pool off the market the button waits from 15% for the number of the loss to be typed');
      await page.fill('#pz-ack', String(Math.round(m1.cost)));
      ok(await until(page, () => !document.querySelector('#pz-go').disabled), 'and is ready once it is');
      ok(await page.evaluate(() => !!document.querySelector('#pz-rcpt [data-alt="both"]') && [...document.querySelectorAll('#pz-rcpt .getrow a')].map((a) => a.getAttribute('href')).join() === '/#card=borrow:cusd&back=teth-cusd'), 'a costly pool offers the way in that swaps nothing, and where to borrow the cUSD for it, with the way back to this farm');
      await shot(page, 'private-dear');
      await page.click('#pz-rcpt [data-alt="both"]');
      ok(await page.evaluate(() => !document.querySelector('#pz-join').hidden && document.querySelector('#pz-eth').hidden && document.querySelector('#pz-mode [data-pm="both"]').getAttribute('aria-pressed') === 'true'), 'and one press moves to tETH + cUSD');
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
      // the relay's free farm sends for the day are used up: the entry is proved for the wallet, which sends it as a second transaction
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { bondDay: true, bondMs: 600 } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /free relay sends for this are used up, so your wallet sends this one|Confirm in your wallet: this one puts your share in the farm/), `the page says the wallet sends the entry, and why: ${await text(page, '#pz-say')}`);
      ok(await sayIs(page, /In the farm/), `and it ends in the farm (${await text(page, '#pz-say')})`);
      const own = st.sent[1];
      ok(st.sent.length === 2 && lc(own?.to) === lc(POOL) && String(own?.data).startsWith('0x8b8c6b4b') && BigInt(own?.gas || 0) === 650000n,
        `two transactions: the deposit, then the farm entry to the pool with the node’s gas estimate and a margin (${own?.to} ${String(own?.data).slice(0, 10)} ${own?.gas})`);
      ok(await page.evaluate(() => window.__ux.filter((x) => x.startsWith('bond')).join() === 'bond:0xeeee,bond-own:0xeeee' && window.__ux.includes('rpc:eth_estimateGas')), 'the relay was asked first, then the wallet sent the same entry, estimated by the node first');
      ok(await page.evaluate(() => !document.querySelector('#pz-acts [data-act="farmit"]')), 'and nothing is left to farm');
      await shot(page, 'private-own-entry');
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
      // the relay proves the farm entry and sends it later: the page waits for it, and ends in the farm with no Farm it to press
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { bondOpen: true, sendMs: 1500 } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /Proved\. The relay sends it in turn: waiting for it to land/), `a farm entry proved and not sent yet is waited for: ${await text(page, '#pz-say')}`);
      ok(await page.evaluate(() => document.querySelector('#pz-go').disabled && !document.querySelector('#pz-acts [data-act="farmit"]')), 'nothing offers to farm it again meanwhile');
      ok(await sayIs(page, /In the farm/), `and it ends in the farm once the relay sends it (${await text(page, '#pz-say')})`);
      ok(await page.evaluate(() => window.__ux.filter((x) => x.startsWith('bond')).length === 1 && window.__ux.includes('follow:job-bond@Infinity') && /0x44444444/.test(document.querySelector('#pz-say').innerHTML)), 'one farm entry, followed to its transaction');
      ok(st.sent.length === 1, 'and one transaction from the wallet');
      await r.browser.close();
    }
    {
      // Farm it on a share the relay has meanwhile put in the farm: read afresh, said to be in, not entered twice
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { bondFail: true } }), { page } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      await sayIs(page, /Your share is private and safe/);
      await page.evaluate(() => { window.__t.bondFail = false; window.__t.bonded = true; });       // the relay sent it after all
      await page.click('#pz-acts [data-act="farmit"]');
      ok(await sayIs(page, /In the farm/), 'Farm it on a share already in the farm says so');
      ok(await page.evaluate(() => window.__ux.filter((x) => x.startsWith('bond')).length === 1), 'without a second farm entry');
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
    {
      // the transaction reverts: its fee is gone and no share was made, which is said (not "nothing was sent"); the proof is kept and the next press sends it
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, st: { revert: true } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      await until(page, () => /transaction failed/.test(document.querySelector('#pz-say')?.textContent || ''), null, 20000);
      const say = await text(page, '#pz-say');
      ok(/network fee/.test(say) && /proof is kept/.test(say) && !/Nothing was sent/.test(say), `a reverted deposit says the fee was spent and the proof is kept (${say})`);
      st.revert = false;
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /In the farm/), 'the next press sends the same proof');
      ok(await page.evaluate(() => window.__ux.filter((x) => x.startsWith('prove')).length === 1), 'without proving again');
      await r.browser.close();
    }
    {
      // a share an earlier press already made, which the balance does not show yet: it is said to be the key's, with Farm it, and the balance is read again by itself, so the
      // share shows over the positions once it appears, with no reload
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, st: { consumed: true, routerRevert: true } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await sayIs(page, /already made private/), `a share an earlier press made: ${await text(page, '#pz-say')}`);
      ok(st.sent.length === 0 && await page.evaluate(() => !!document.querySelector('#pz-acts [data-act="farmit"]') && /Your share is private and safe/.test(document.querySelector('#pz-say').textContent) && document.querySelector('#pz-steps li[data-s="farm"]').dataset.at === 'bad'),
        'nothing was sent, the share is said to be the key’s, the last step is marked and Farm it is offered');
      ok(await page.evaluate(() => document.querySelector('#pz-loose').textContent === ''), 'the balance does not show it yet');
      await page.evaluate((a) => { window.__t.loose = a; }, LPA[0]);                     // the balance shows it now
      ok(await until(page, () => /share of yours is private and not in the farm/.test(document.querySelector('#pz-loose')?.textContent || ''), null, 45000), 'read again, the share shows over the positions without a reload');
      await r.browser.close();
    }
    {
      // a small deposit, and the pool moves a few basis points while its share is proved: the exact legs for those shares no longer exist at the new
      // reserves, but the proof is not wasted: the one transaction is sent with legs that mint exactly the shares it names
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { proveMs: 3000 } }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.fill('#pz-amt', '0.001'); await quoted(page);
      await until(page, () => !document.querySelector('#pz-go').disabled);
      await page.click('#pz-go');
      ok(await until(page, () => (window.__ux || []).some((x) => x.startsWith('prove')), null, 20000), 'the proof is being made');
      const shares = BigInt((await page.evaluate(() => window.__ux)).find((x) => x.startsWith('build:')).slice(6)), pl = st.prog.pools[0];
      const was = { ra: BigInt(pl.reserves.reserveA), rb: BigInt(pl.reserves.reserveB), t: BigInt(pl.reserves.lpTotalShares) };
      pl.reserves.reserveA = String(was.ra * 9996n / 10000n); pl.reserves.reserveB = String(was.rb * 10004n / 10000n);          // a trade lands: 4 bp
      const args = { shares, ra: BigInt(pl.reserves.reserveA), rb: BigInt(pl.reserves.reserveB), total: was.t, maxEth: 10n ** 15n + 10n ** 15n / 50n };
      ok(zapPlanFor(args) === null && zapPlanFor({ ...args, settles: true }) !== null, 'at the new reserves there are no exact legs for the proved shares, and there are legs that mint exactly them');
      ok(await sayIs(r.page, /In the farm/), `the deposit is sent and ends in the farm (${await text(page, '#pz-say')})`);
      const tx = st.sent[0];
      ok(st.sent.length === 1 && lc(tx.to) === ROUTER && tx.data.startsWith('0xc4294fac') && BigInt('0x' + tx.data.slice(10 + 4 * 64, 10 + 5 * 64)) === shares, `one transaction, the router’s zap for exactly the ${shares} shares proved`);
      ok(BigInt(tx.value) <= 10n ** 15n + 10n ** 15n / 50n, `for no more than 2% over the ETH entered (${Number(BigInt(tx.value)) / 1e18} ETH)`);
      clean(r, 'a small deposit, pool moved');
      await r.browser.close();
    }
    {
      // the price feeds stop answering after the page has them: the last prices stand, and the pool is still held to the market's price
      const r = await openPage({ hash: '#teth-cusd', fake: true, wallet: true }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.waitForTimeout(600);
      st.noPrices = true;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
      for (let i = 0; i < 60 && !st.pricesAsked; i++) await sleep(100);
      await page.waitForTimeout(700);
      await page.click('#pz .quick [data-q="0.1"]'); await quoted(page);
      ok(st.pricesAsked > 0 && await page.evaluate(() => !!document.querySelector('#pz-ack') && /accept losing about/.test(document.querySelector('#pz-rcpt').textContent) && document.querySelector('#pz-go').disabled), 'after a refresh that read no prices, a pool priced far from the market still waits for the loss to be accepted');
      await r.browser.close();
    }
    {
      // no price was ever read: the pool’s price cannot be checked against the market, which is said and has to be accepted
      const r = await openPage({ hash: '#teth-cusd', fake: true, wallet: true, st: { noPrices: true } }), { page } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.click('#pz .quick [data-q="0.05"]'); await quoted(page);
      ok(await page.evaluate(() => /could not be read, so this pool’s price is not checked/.test(document.querySelector('#pz-ack')?.parentElement?.textContent || '') && document.querySelector('#pz-go').disabled), 'with no market price the card says so and waits for it to be accepted');
      await page.check('#pz-ack');
      ok(await until(page, () => !document.querySelector('#pz-go').disabled), 'and is ready once it is');
      await r.browser.close();
    }
    {
      // an amount typed before the farm’s pool is read is priced when it arrives
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, st: { progDelay: 1800 } }), { page } = r;
      await page.fill('#pz-amt', '0.1');
      ok(await until(page, () => !document.querySelector('#pz-rcpt').hidden && /Network fee/.test(document.querySelector('#pz-rcpt').textContent) && !document.querySelector('#pz-go').disabled, null, 15000), 'once the pool is read, the amount already typed is priced and the button is ready');
      await r.browser.close();
    }
    {
      // a link to a farm the program does not list: once the program is read the page goes back to the menu, not a farm that never loads
      const two = program(); two.pools = two.pools.slice(0, 2);
      const r = await openPage({ hash: '#teth-cbtc', prog: two }), { page } = r;
      ok(await until(page, () => !document.querySelector('#menu').hidden && document.querySelector('#station').hidden && location.hash === ''), 'a farm the program does not name leaves the menu showing');
      await r.browser.close();
    }
  }

  // 4b. Both coins from the private balance: the positions panel's join, drawn in the farm's card.
  if (runs('both')) {
    const a = 10000000n, b = a * 10000000000000n / 1000000000n;                         // 0.1 tETH and, at the pool's 1:10,000, 1,000 TAC
    const privNotes = [{ leaf: '0x' + 'c1'.repeat(32), asset: CETH, value: String(a), owner: '0x03' }, { leaf: '0x' + 'c2'.repeat(32), asset: A_TAC, value: String(b), owner: '0x04' }];
    {
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, privNotes } }), { page } = r;
      ok(await until(page, () => !document.querySelector('#pz-mode').hidden && document.querySelector('#pz-both').textContent === 'tETH + TAC'), 'a private farm offers ETH or tETH + TAC');
      ok(/Half is swapped inside the pool/.test(await text(page, '#pz-how')), `ETH is the first way in: ${await text(page, '#pz-how')}`);
      await page.click('#pz-both');
      ok(await until(page, () => !document.querySelector('#pz-join').hidden && document.querySelector('#pz-eth').hidden && !!document.querySelector('#pz-join #pf-a')), 'tETH + TAC shows the join in the card, in place of the ETH form');
      ok(/From your private tETH and TAC, at the pool’s ratio: nothing is swapped/.test(await text(page, '#pz-how')), `and says how it goes in: ${await text(page, '#pz-how')}`);
      ok(await page.evaluate(() => !document.querySelector('#pf-mine #pf-a') && !document.querySelector('#pf-mine .pf-join')), 'the positions panel no longer carries a second join form');
      ok(await until(page, () => /Max 0\.1/.test(document.querySelector('#pz-join [data-pf="max"]')?.textContent || '')), 'the most both sides cover is a press away');
      ok(/You hold\s*0\.1\s+tETH · 1,000\s+TAC/.test(await text(page, '#pz-join')), `and the card says what the key holds of each side: ${(await text(page, '#pz-join')).slice(0, 120)}`);
      await page.click('#pz-join [data-pf="max"]');
      ok(await until(page, () => document.querySelector('#pz-join #pf-a').value === '0.1' && /TAC, at the pool’s ratio\s*1,000/.test(document.querySelector('#pf-info').textContent)), `Held fills 0.1 and the second side is worked out: ${await text(page, '#pf-info')}`);
      ok(await until(page, () => !document.querySelector('#pz-join [data-pf="join"]').disabled), 'notes of exactly those sizes need no cut, and the button is ready');
      await shot(page, 'private-both');
      await page.click('#pz-join [data-pf="join"]');
      ok(await page.evaluate(() => { document.querySelector('#bk').click(); return !document.querySelector('#station').hidden; }), 'the way back to the menu is held while the join runs');
      ok(await until(page, () => /In the farm/.test(document.querySelector('#pj-said')?.textContent || ''), null, 20000), `the join ends in the farm, said in the card (${await text(page, '#pz-join')})`);
      const ux = await page.evaluate(() => window.__ux);
      ok(ux.filter((x) => x.startsWith('lpbond')).length === 1 && ux.includes(`lpbond:${a}+${b}@0x000031`) && !ux.includes('transfer'), `one proof adds both and farms the share, with nothing cut first (${ux.filter((x) => /^(lpbond|transfer)/.test(x)).join(', ')})`);
      ok(await until(page, () => document.querySelector('#chef').dataset.mood === 'up' || !!document.querySelector('#fx')), 'and the chef cheers');
      ok(await until(page, () => document.querySelector('#d-teth-tac .yours')?.textContent === 'Yours'), 'the farm’s tile is marked as yours');
      await page.click('[data-pm="eth"]');
      ok(await page.evaluate(() => !document.querySelector('#pz-eth').hidden && document.querySelector('#pz-join').hidden), 'ETH brings the one-transaction form back');
      clean(r, 'both coins');
      await r.browser.close();
    }
    for (const moves of [1, 3]) {
      // a trade lands while the entry is proved: the relay holds the proof open and the pool refuses it as moved. It is proved again (twice at most) and ends in the
      // farm; a pool that keeps moving says so after the third, and the proof that cannot be sent is never waited for
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, privNotes, bondMoved: moves } }), { page } = r;
      await until(page, () => document.querySelector('#pz-both')?.textContent === 'tETH + TAC');
      await page.click('#pz-both');
      await until(page, () => !!document.querySelector('#pz-join #pf-a'));
      await page.click('#pz-join [data-pf="max"]');
      await until(page, () => !document.querySelector('#pz-join [data-pf="join"]').disabled);
      await page.click('#pz-join [data-pf="join"]');
      ok(await until(page, (want) => new RegExp(want).test(document.querySelector('#pj-said')?.textContent || ''), moves === 1 ? 'In the farm' : 'three times running', 30000), `a pool that moved ${moves}x while it was proved: ${await text(page, '#pz-join')}`);
      const ux = await page.evaluate(() => window.__ux);
      ok(ux.filter((x) => x.startsWith('lpbond')).length === (moves === 1 ? 2 : 3) && !ux.some((x) => x.startsWith('follow')), `proved ${moves === 1 ? 'again once' : 'three times in all'}, and the dead proof was not waited for (${ux.filter((x) => /^(lpbond|follow)/.test(x)).length} calls)`);
      ok(moves === 1 ? await page.evaluate(() => window.__t.bonded === true) : await page.evaluate(() => !window.__t.bonded), moves === 1 ? 'and the share is in the farm' : 'and nothing was added');
      clean(r, `a pool that moved ${moves}x`);
      await r.browser.close();
    }
    {
      // the key not open: the card's way in opens it with the wallet connected here, then the join is drawn
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { privNotes } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      ok(await until(page, () => /Open your Tacit wallet/.test(document.querySelector('#pz-join')?.textContent || '')), 'with the key shut the card asks to open it');
      await page.click('#pz-join [data-pf="open"]');
      ok(await until(page, () => !!document.querySelector('#pz-join #pf-a')), 'and once it is open the join is there');
      ok(await page.evaluate(() => window.__keyOpens === 1 && !window.__sheets), 'opened by the wallet connected here, with no sheet');
      await r.browser.close();
    }
    {
      // holding tETH and none of the other coin: the card says so and where to get it (cBTC: lock bitcoin, or bridge it in), and Max waits
      const tethOnly = [privNotes[0]];
      const r = await openPage({ hash: '#teth-cbtc', fake: true, wallet: true, t: { keyOpen: true, privNotes: tethOnly } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      ok(await until(page, () => /No private cBTC right now/.test(document.querySelector('#pz-join')?.textContent || '')), `with no cBTC the card says so (${(await text(page, '#pz-join')).slice(0, 160)})`);
      const hrefs = () => page.evaluate(() => [...document.querySelectorAll('#pz-join .getrow a')].map((a) => a.getAttribute('href')));
      ok((await hrefs()).join() === `/#card=borrow:cbtc&back=teth-cbtc,/#card=bridge:kb&back=teth-cbtc,/#card=earn:eth:p${prog.pools[2].pid}`, `and links the lock and the bridge, each with the way back to this farm, and farming the tETH alone, which is the farm itself (${(await hrefs()).join(' ')})`);
      ok(await page.evaluate(() => !document.querySelector('#pz-join [data-pf="max"]')), 'with nothing to pair, there is no Max');
      await page.fill('#pz-join #pf-a', '0.05');
      ok(await until(page, () => /does not cover it/.test(document.querySelector('#pz-join #pf-info')?.textContent || '')) && (await hrefs()).length === 3 && await page.evaluate(() => document.querySelector('#pz-join [data-pf="join"]').disabled), 'an amount the notes cannot pair says so, keeps the links, and the press waits');
      await shot(page, 'private-both-short');
      clean(r, 'both coins, one short');
      await r.browser.close();
    }
    {
      // the same card on a phone: the links wrap, nothing is wider than the screen
      const r = await openPage({ hash: '#teth-cbtc', fake: true, wallet: true, viewport: { width: 375, height: 800 }, t: { keyOpen: true, privNotes: [privNotes[0]] } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      await until(page, () => /No private cBTC/.test(document.querySelector('#pz-join')?.textContent || ''));
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('#pz-join .getrow a')].every((a) => a.getBoundingClientRect().right <= innerWidth)), 'on a phone the links wrap and nothing is wider than the screen');
      await shot(page, 'private-both-short-phone');
      await r.browser.close();
    }
    {
      // a farm the program lists without its reserves cannot be joined from its own card, and must not be joined in another farm's pool
      const noRes = program(); noRes.pools[1] = { ...noRes.pools[1], reserves: null };
      const r = await openPage({ hash: '#teth-cusd', fake: true, wallet: true, prog: noRes, t: { keyOpen: true, privNotes } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      await until(page, () => /Reading your private balance|cannot be joined|You hold|tETH, private/.test(document.querySelector('#pz-join')?.textContent || ''));
      await page.waitForTimeout(800);
      const j = await text(page, '#pz-join');
      ok(!/\bTAC\b/.test(j) && !(await page.evaluate(() => !!document.querySelector('#pz-join [data-pf="join"]:not([disabled])'))), `the card of a farm with no reserves joins nothing, and shows no other farm's coin (${j.slice(0, 140)})`);
      await r.browser.close();
    }
    {
      // several tETH notes and a relay fee to cut one: the whole sum cannot go in (a note must be cut and the fee taken from it), so Max is the sum less the fee
      const pieces = [5000000n, 3000000n, 2000000n].map((v, i) => ({ leaf: '0x' + `d${i}`.repeat(32), asset: CETH, value: String(v), owner: '0x03' }));
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, privNotes: [...pieces, privNotes[1]], opFee: 1000 } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      ok(await until(page, () => /Max 0\.09999\b/.test(document.querySelector('#pz-join [data-pf="max"]')?.textContent || '')), `Max is the sum less the relay’s fee (${await text(page, '#pz-join [data-pf="max"]')})`);
      await page.click('#pz-join [data-pf="max"]');
      ok(await until(page, () => document.querySelector('#pz-join #pf-a').value === '0.09999' && !document.querySelector('#pz-join [data-pf="join"]').disabled && !/does not cover/.test(document.querySelector('#pf-info').textContent)), `and it is a join that can be made (${(await text(page, '#pf-info')).slice(0, 140)})`);
      await r.browser.close();
    }
    {
      // the pool's terms cannot be read: the card says so and asks again on a press, instead of waiting for ever
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, privNotes, opFeeFail: true } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      ok(await until(page, () => /The pool could not be read/.test(document.querySelector('#pz-join')?.textContent || '')), 'a pool that cannot be read is said, with Try again');
      await page.evaluate(() => { window.__t.opFeeFail = false; });
      await page.click('#pz-join [data-pf="retry"]');
      ok(await until(page, () => /Max 0\.1\b/.test(document.querySelector('#pz-join [data-pf="max"]')?.textContent || '')), 'and the press reads it again');
      await r.browser.close();
    }
    {
      // a share in no farm, farmed while the card shows tETH + TAC: its steps are said in the card on screen
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, loose: LPA[0] } }), { page } = r;
      await until(page, () => /share of yours is private and not in the farm/.test(document.querySelector('#pz-loose')?.textContent || ''));
      await page.click('#pz-both');
      await page.click('#pz-loose [data-loose="0"]');
      ok(await until(page, () => !document.querySelector('#pz-eth').hidden && !document.querySelector('#pz-cook').hidden || /In the farm/.test(document.querySelector('#pz-say')?.textContent || '')), 'Farm it brings the steps into view');
      ok(await sayIs(page, /In the farm/), 'and says where it ended');
      await r.browser.close();
    }
    {
      // the second side runs out first: Max is what both cover, not what the first side holds
      const half = [privNotes[0], { ...privNotes[1], value: String(b / 2n) }];
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { keyOpen: true, privNotes: half } }), { page } = r;
      await until(page, () => !document.querySelector('#pz-mode').hidden);
      await page.click('#pz-both');
      ok(await until(page, () => /Max 0\.05\b/.test(document.querySelector('#pz-join [data-pf="max"]')?.textContent || '')), `Max is 0.05, the half the TAC covers (${await text(page, '#pz-join [data-pf="max"]')})`);
      await page.click('#pz-join [data-pf="max"]');
      ok(await until(page, () => document.querySelector('#pz-join #pf-a').value === '0.05' && /TAC, at the pool’s ratio\s*500/.test(document.querySelector('#pf-info').textContent) && !document.querySelector('#pz-join [data-pf="join"]').disabled), `it fills 0.05 with 500 TAC beside it, ready (${await text(page, '#pf-info')})`);
      await r.browser.close();
    }
    {
      // the tab's key waiting on a wallet that never answers: the positions panel mounts at once, and Show mine opens the key with the
      // wallet connected here
      const r = await openPage({ hash: '#teth-tac', fake: true, wallet: true, t: { readyHang: true } }), { page } = r;
      ok(await until(page, () => /Your positions in the private farms/.test(document.querySelector('#pf-mine')?.textContent || '')), 'with the tab’s key still waiting on its wallet, the positions panel is mounted');
      await page.click('#pf-mine [data-pf="open"]');
      ok(await until(page, () => /No private farm positions yet/.test(document.querySelector('#pf-mine')?.textContent || ''), null, 10000), `Show mine opens the key and lists the positions (${(await text(page, '#pf-mine')).slice(0, 60)})`);
      ok(await page.evaluate(() => window.__keyOpens === 1 && !window.__sheets), 'with the wallet connected here, no sheet');
      clean(r, 'show mine');
      await r.browser.close();
    }
    {
      // a farm between reward periods takes no joins: no choice is offered
      const r = await openPage({ hash: '#teth-tac', fake: true, prog: program({ active: false }) }), { page } = r;
      await until(page, () => /Between reward periods/.test(document.querySelector('#k-kind')?.textContent || ''));
      ok(await page.evaluate(() => document.querySelector('#pz-mode').hidden && !document.querySelector('#pz-eth').hidden), 'between reward periods only the ETH form is there');
      await r.browser.close();
    }
    {
      // the rewards page mounts the same panel without a card: its join stays in the panel
      const r = await openPage({ fake: true, t: { keyOpen: true, privNotes } });
      await r.page.goto(`http://127.0.0.1:${WEB}/rewards/#farms`, { waitUntil: 'load' });      // the farms' part of the page, as tETH's, cBTC's and the vault's links name it (the Rewards section's view of /rewards/ leaves the farms to DeFi)
      await until(r.page, () => !!document.querySelector('#pf-mine [data-pf="open"]'));
      await r.page.click('#pf-row > summary').catch(() => {});
      await r.page.click('#pf-mine [data-pf="open"]');
      ok(await until(r.page, () => !!document.querySelector('#pf-mine details.pf-join #pf-a') && /No private farm positions yet/.test(document.querySelector('#pf-mine').textContent)), 'the rewards page’s panel still lists positions with its own join form');
      await r.page.evaluate(() => { document.querySelector('#pf-mine details.pf-join').open = true; });
      await r.page.fill('#pf-mine #pf-a', '0.1');
      ok(await until(r.page, () => /1,000/.test(document.querySelector('#pf-mine #pf-info')?.textContent || '') && !document.querySelector('#pf-mine [data-pf="join"]').disabled), 'and quotes the second side there');
      ok(!r.errors.length, `no page errors on the rewards page (${r.errors.slice(0, 2).join(' | ')})`);
      await r.browser.close();
    }
  }

  // 6. SPX's pools. SPX / TAC has no ETH side, so its card offers the two-coin deposit only (no ETH form, no ETH quote it cannot make). tETH / SPX is
  // priced against SPX's public market (read from the public pools through zQuoter) and sized in SPX's own units, with its token from the pool's own row.
  if (runs('spx')) {
    const sp = program({ extra: SPX_POOLS }), res = { reserveA: 12108999n, reserveB: 61218265385n, totalShares: 860869819n, feeBps: 30 }, rate = spxRate();
    {
      const r = await openPage({ hash: '#spx-tac', prog: sp, fake: true }), { page } = r;
      ok(await until(page, () => !document.querySelector('#k-priv')?.hidden && /no ETH side/.test(document.querySelector('#pz-how')?.textContent || '')), 'the SPX / TAC card says it has no ETH side');
      const v = await page.evaluate(() => ({ tabs: document.querySelector('#pz-mode').hidden, eth: document.querySelector('#pz-eth').hidden, join: document.querySelector('#pz-join').hidden, text: document.querySelector('#pz').textContent }));
      ok(v.tabs && v.eth && !v.join, 'with no ETH tab and no ETH form: the two-coin deposit is what it offers');
      ok(!/reads differently|Try again in a minute/.test(v.text), 'and none of the error an ETH deposit into it gave');
      const t = await tile(page, 'spx-tac');
      ok(t && t.cost === '' && t.tag === '', `its tile says no entry cost for ETH and is not the chef’s pick (${t?.cost || 'no cost'}, ${t?.tag || 'no tag'})`);
      clean(r, 'the SPX / TAC card');
      await r.browser.close();
    }
    {
      const r = await openPage({ hash: '#teth-spx', prog: sp, fake: true }), { page, st } = r;
      await until(page, () => document.querySelector('#pz-go').textContent === 'Connect wallet');
      ok(await page.evaluate(() => !document.querySelector('#pz-mode').hidden && !document.querySelector('#pz-eth').hidden), 'the tETH / SPX card keeps its ETH tab');
      await page.fill('#pz-amt', '0.002');
      ok(await quoted(page), 'a deposit is priced');
      const m = zapMath({ res, wei: 2n * 10n ** 15n, market: rate, unitB: 1n, decimals: 8 }), rc = await text(page, '#pz-rcpt');
      ok(m.checked && m.against > 5 && new RegExp(`Against the market${pctTxt(m.against)} of this deposit`).test(rc) && /price for SPX is \d+% above the market’s/.test(rc), `checked against SPX’s public market: the pool’s price is over it, and that is said (${m.against.toFixed(2)}%): ${rc.slice(0, 200)}`);
      ok(!/could not be read/.test(rc) && await page.evaluate(() => !document.querySelector('#pz-ack')), 'with the market read there is no “could not be read” tick');
      ok(/Your share\d+(\.\d+)?% of the pool/.test(rc), `the quote says what share of the pool the deposit would be: ${rc.match(/Your share[^A-Z]*/)?.[0]}`);
      ok(st.spxReads >= 1, `the price came from the public pools (${st.spxReads} read)`);
      const mm = zapMath({ res, wei: 10n ** 17n, market: rate, unitB: 1n, decimals: 8 });
      ok(mm && await until(page, (s) => document.querySelector('#d-teth-spx .cost')?.textContent === s, `Putting in 0.1 ETH costs about ${pctTxt(mm.cost)} on the way in`), `its tile says what a tenth of an ETH gives up, against the market (${mm?.cost.toFixed(1)}%: ${(await tile(page, 'teth-spx'))?.cost})`);
      clean(r, 'a tETH / SPX quote');
      await r.browser.close();
    }
    {
      // a standalone farm's stream is its own: its end date, and where what funds it runs out first, not the launch farms'
      const own = FINISH - 10 * 86400, funded = 4 * 86400;
      const sp2 = program({ extra: SPX_POOLS.map((q) => (q.pid === 1001 ? { ...q, epoch: { active: true, periodFinish: own, fundedRunwaySeconds: funded } } : q)) });
      const r = await openPage({ hash: '#teth-spx', prog: sp2, fake: true }), { page } = r;
      await until(page, () => /Stream ends/.test(document.querySelector('#pz-stats')?.textContent || ''));
      const day = (t) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t * 1000)), st = await text(page, '#pz-stats');
      ok(st.includes(`Stream ends${day(own)}`) && !st.includes(day(FINISH)), `the SPX farm ends on its own date, not the launch farms’ (${st})`);
      ok(st.includes(`funded until ${day(Math.floor(Date.now() / 1000) + funded)}`), 'and says where what funds it runs out first');
      const t = await tile(page, 'teth-spx');
      ok(/^Private pool · \$\d/.test(t?.kind || ''), `its tile says what the pool holds (${t?.kind})`);
      clean(r, 'the SPX stream');
      await r.browser.close();
    }
    {
      // no price from the public pools: the pool’s price is not checked, and the deposit asks for a tick, as before
      const r = await openPage({ hash: '#teth-spx', prog: sp, fake: true, st: { noSpxMarket: true } }), { page } = r;
      await until(page, () => document.querySelector('#pz-go').textContent === 'Connect wallet');
      await page.fill('#pz-amt', '0.002'); await quoted(page);
      ok(/market’s price for SPX could not be read/.test(await text(page, '#pz-rcpt')) && await page.evaluate(() => document.querySelector('#pz-ack')?.type === 'checkbox'), 'with the public price unreadable it says so and asks for a tick');
      await r.browser.close();
    }
    {
      // the deposit: SPX's token from the pool's own row, and its leg in SPX's own units
      const r = await openPage({ hash: '#teth-spx', prog: sp, fake: true, wallet: true }), { page, st } = r;
      await until(page, () => /Enter an amount/.test(document.querySelector('#pz-go').textContent));
      await page.fill('#pz-amt', '0.002'); await quoted(page);
      ok(await until(page, () => !document.querySelector('#pz-go').disabled && document.querySelector('#pz-go').textContent === 'Farm privately'), 'priced against the market, it needs no tick: the button is ready');
      await page.click('#pz-go');
      ok(await sayIs(page, /In the farm/), `the deposit ends in the farm (${await text(page, '#pz-say')})`);
      const tx = st.sent[0], word = (i) => BigInt('0x' + tx.data.slice(10 + i * 64, 74 + i * 64)), m = zapMath({ res, wei: 2n * 10n ** 15n, market: rate, unitB: 1n, decimals: 8 });
      const plan = zapPlanFor({ shares: m.plan.shares, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, feeBps: 30n, unitB: 1n, maxEth: 2n * 10n ** 15n + 2n * 10n ** 15n / 50n, settles: true });
      ok(st.sent.length === 1 && lc(tx.to) === ROUTER && tx.data.startsWith('0xc4294fac') && BigInt(tx.value) === plan.value, 'one transaction to the router, for the legs sized at the pool as it stands');
      ok(word(0) === BigInt(SPX) && word(3) === plan.bLeg && plan.bLeg < 10n ** 12n && word(4) === m.plan.shares, `it names SPX from the pool’s own row, with SPX’s leg in its own units (${plan.bLeg} of 1e-8 SPX) and exactly the shares proved`);
      clean(r, 'a tETH / SPX deposit');
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
