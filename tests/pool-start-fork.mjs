// A tETH pool for a token that has none, founded the way the front page founds it (index.html xtPoolStart), on an anvil fork of mainnet with
// the real router, public AMM and pool, and an outside swap leg quoted by the swap card's own route module:
//   - foundingPlan (lp-zap.js) sizes the two legs from the quote: the token leg is what the swap surely brings, the ETH leg matches it at
//     the quoted rate, and the share note is for isqrt(vA·vB) less the 1000 shares the founding add locks
//   - the router call (zapETHIntoShieldedLP) mints exactly the planned shares and shields them into the very deposit the page's share note
//     (buildShareWrap) is built for, so its proof settles it
//   - the pool's reserves are the two legs, its shares the plan's plus the locked 1000, and it opens within the slippage of the market's rate
//   - nothing is left with the router; whatever the swap brought beyond the token leg goes back to the sender
// for SPX (8 decimals, registered) and LINK (18 decimals, registered here first). The settle of the share note's proof is the farm zap's own
// (zapSettleCalldata), unchanged; it needs a prover, so it is not run here.
// Run: anvil --fork-url <mainnet rpc> --port 8547 --chain-id 1 & node tests/pool-start-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { setActiveNetwork } from '../dapp/confidential-deployments.js';
import { foundingPlan, zapCalldata } from '../dapp/lp-zap.js';
import { quoteEthToToken } from '../dapp/swap/route.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
const TOKENS = [['SPX', '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c'], ['LINK', '0x514910771af9ca656af840dff83e8264ecf986ca']];
const call = async (method, params) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}${r.error.data ? ` ${JSON.stringify(r.error.data).slice(0, 200)}` : ''}`);
  return r.result;
};
const hexv = (v) => '0x' + BigInt(v).toString(16);
const ethCall = (to, data, block = 'latest', o = {}) => call('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: hexv(o.gas) } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, block]);
// The outside swap is quoted on mainnet itself (QUOTE_RPC): zQuoter's scan reads many venues, too slow to fault into a fork; the route it
// returns is checked by the route module and then executed on the fork, a few blocks later, within its slippage.
const QUOTE_RPC = process.env.QUOTE_RPC || 'https://rpc.mevblocker.io';
const quoteCall = async (to, data, block = 'latest', o = {}) => {
  const r = await (await fetch(QUOTE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: hexv(o.gas) } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, 'latest'] }) })).json();
  if (r.error) throw new Error(`quote eth_call: ${r.error.message}`);
  return r.result;
};
const fetchImpl = (url, opts) => (/^https?:\/\/[^/]*(rpc|node|gateway|eth|llama|ankr|drpc|merkle|infura|alchemy|cloudflare)/i.test(String(url)) ? fetch(ANVIL, opts) : fetch(url, opts));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl, network: 'mainnet' });
const priv = '0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const acct = ux.account(priv), POOL = ux.cfg.pool, ETH_ID = String(ux.assetByTicker.cETH.assetId).toLowerCase();
const w32 = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const balOf = async (t, a) => BigInt(await ethCall(t, '0x70a08231' + w32(a)));
async function receipt(h) {
  for (let i = 0; i < 120; i++) { const r = await call('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 500)); }
  throw new Error(`no receipt for ${h}`);
}
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
await call('anvil_setBalance', [acct.address, hexv(10n ** 19n)]);
const head = BigInt(Math.max(Number(await call('eth_getBlockByNumber', ['latest', false]).then((b) => BigInt(b.timestamp))), Math.floor(Date.now() / 1000)));

for (const [name, token] of TOKENS) {
  let { row, registered } = await ux.externalAsset(token);
  if (!registered) {
    await test(`${name} is registered with the pool first (once, for everyone)`, async () => {
      const c = ux.registerTokenCall(token);
      assert.equal((await receipt((await ux.sendPreparedTx({ walletPriv: priv, to: c.to, calldata: c.data, gasLimit: 200000n })).txHash)).status, '0x1');
      ({ row, registered } = await ux.externalAsset(token));
      assert.equal(registered, true);
    });
  }
  const scale = BigInt(row.unitScale), id = String(row.assetId).toLowerCase(), poolId = ux.routePoolId(ETH_ID, id, 30);
  await test(`${name} has no tETH pool yet at any tier`, async () => {
    for (const f of [30, 5, 100, 1]) assert.ok(!((await ux.poolReserves(ux.routePoolId(ETH_ID, id, f)))?.totalShares > 0n), `a ${f}bp pool`);
  });
  await test(`a ${name} pool is founded from 0.1 ETH: exactly the planned shares, shielded into the page's share note's deposit`, async () => {
    const swapIn = 5n * 10n ** 16n, deadline = head + 1800n;
    const q = await quoteEthToToken({ ethCall: quoteCall, to: ROUTER, tokenOut: token, amount: swapIn, slippageBps: 100, deadline });
    assert.ok(q && q.callData && q.amountLimit > 0n, 'the route module quotes ETH for the token, paid to the router');
    const plan = foundingPlan({ swapIn, amountOut: q.amountOut, amountLimit: q.amountLimit, unitB: scale });
    assert.ok(plan && plan.shares > 0n, 'a founding plan');
    assert.equal(plan.bLeg % scale, 0n); assert.equal(plan.ethLeg % 10n ** 10n, 0n);
    const built = ux.buildShareWrap({ walletPriv: priv, poolId, shares: plan.shares, index: 0 });
    const data = zapCalldata({ plan, router: ROUTER, amm: AMM, tokenB: token, assetA: ETH_ID, assetB: id, feeBps: 30, deadline, commit: built.commit, swapData: q.callData });
    const sim = String(await ethCall(ROUTER, data, 'latest', { from: acct.address, value: plan.value })).replace(/^0x/, '');
    assert.equal('0x' + sim.slice(0, 64), String(built.depositId).toLowerCase(), 'the deposit is the share note\'s');
    assert.equal(BigInt('0x' + sim.slice(64, 128)), plan.shares, 'exactly the planned shares');
    const e0 = BigInt(await call('eth_getBalance', [acct.address, 'latest'])), t0 = await balOf(token, acct.address);
    const r = await receipt((await ux.sendPreparedTx({ walletPriv: priv, to: ROUTER, value: plan.value, calldata: data, gasLimit: 1500000n })).txHash);
    assert.equal(r.status, '0x1');
    const res = await ux.poolReserves(poolId);
    const [rEth, rTok] = String(res.assetA).toLowerCase() === ETH_ID ? [res.reserveA, res.reserveB] : [res.reserveB, res.reserveA];
    assert.equal(rEth, plan.ethLeg / 10n ** 10n, 'the ETH reserve is the ETH leg');
    assert.equal(rTok, plan.bLeg / scale, 'the token reserve is the token leg');
    assert.equal(res.totalShares, plan.shares + 1000n, 'the plan\'s shares and the 1000 locked');
    const poolRate = Number(rTok * scale) / Number(rEth * 10n ** 10n), marketRate = Number(q.amountOut) / Number(swapIn);
    assert.ok(Math.abs(poolRate / marketRate - 1) < 0.02, `opens at the market's rate (pool ${poolRate}, market ${marketRate})`);
    const st = BigInt(await ethCall(POOL, '0x7da9874f' + w32(built.depositId)));
    assert.equal(st, 1n, 'the share deposit waits for its proof');
    assert.equal(await balOf(token, ROUTER), 0n, 'nothing is left with the router');
    assert.ok((await balOf(token, acct.address)) >= t0, 'what the swap brought beyond the leg went back to the sender');
    const spent = e0 - BigInt(await call('eth_getBalance', [acct.address, 'latest']));
    assert.ok(spent >= plan.value && spent < plan.value + 10n ** 16n, `the ETH spent is the plan's and the gas (${spent})`);
  });
}
console.log(`\n${n} passed`);
