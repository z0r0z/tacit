// A tETH pool started from BOTH sides a wallet already holds (ETH and the token), with no swap: on an anvil fork of mainnet with the real router, public AMM and pool.
// The composition the page makes, with existing contracts only:
//   1. the token's Permit2 approval (once), then addLiquidityPublicETHWithPermit2: the ETH and the token go in as the founding add, the pool is created lazily, and the
//      public LP shares are credited to the wallet (the router keeps nothing)
//   2. the wallet's own shieldShares on the POOL: it burns exactly those public shares and records the deposit the page's share note (buildShareWrap) is built for,
//      which an ordinary wrap settle then consumes
// Checked: the founding add mints exactly foundingPlan's shares (isqrt(vA·vB) less the 1000 it locks), the pool's reserves are the two legs, shieldShares of exactly that
// count succeeds and leaves the pending deposit of the share note, and the wallet holds no public shares after it. The settle of the note's proof needs a prover and is not run here.
// Run: anvil --fork-url <mainnet rpc> --port 8547 --chain-id 1 & node tests/pool-start-both-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialRouter } from '../dapp/confidential-router.js';
import { setActiveNetwork } from '../dapp/confidential-deployments.js';
import { foundingPlan } from '../dapp/lp-zap.js';
import { quoteEthToToken } from '../dapp/swap/route.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// WBTC's asset id sorts below tETH's: its pool holds the token as asset A
const TOKENS = [['AAVE', '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'], ['WBTC', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599']];
const call = async (method, params) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}${r.error.data ? ` ${JSON.stringify(r.error.data).slice(0, 200)}` : ''}`);
  return r.result;
};
const hexv = (v) => '0x' + BigInt(v).toString(16);
const ethCall = (to, data, block = 'latest', o = {}) => call('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, block]);
// the outside swap that buys the wallet's tokens is quoted on mainnet itself (zQuoter's scan is too slow to fault into a fork), then executed on the fork
const QUOTE_RPC = process.env.QUOTE_RPC || 'https://ethereum-rpc.publicnode.com';
const quoteCall = async (to, data, block = 'latest', o = {}) => {
  const r = await (await fetch(QUOTE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: hexv(o.gas) } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, block] }) })).json();
  if (r.error) throw new Error(`quote eth_call: ${r.error.message}`);
  return r.result;
};
const fetchImpl = (url, opts) => (/^https?:\/\/[^/]*(rpc|node|gateway|eth|llama|ankr|drpc|merkle|infura|alchemy|cloudflare)/i.test(String(url)) ? fetch(ANVIL, opts) : fetch(url, opts));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl, network: 'mainnet' });
const router = makeConfidentialRouter({ secp, keccak256: keccak_256, sha256, cfg: ux.cfg });
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
const send = async (to, data, value = 0n, gasLimit = 1500000n) => { const r = await receipt((await ux.sendPreparedTx({ walletPriv: priv, to, value, calldata: data, gasLimit })).txHash); assert.equal(r.status, '0x1', `tx to ${to} reverted`); return r; };

for (const [name, token] of TOKENS) {
  let { row, registered } = await ux.externalAsset(token);
  const scale = BigInt(row.unitScale), id = String(row.assetId).toLowerCase(), poolId = ux.routePoolId(ETH_ID, id, 30);
  const has = (await ux.poolReserves(poolId))?.totalShares > 0n;
  if (has) { console.log(`skip ${name}: a pool already exists on this fork's block`); continue; }
  await test(`${name}: the wallet holds the token (bought on the fork), and the pool holds it (registered here first when it is not)`, async () => {
    const q = await quoteEthToToken({ ethCall: quoteCall, to: acct.address, tokenOut: token, amount: 3n * 10n ** 17n, slippageBps: 100, deadline: head + 1800n });
    assert.ok(q && q.callData, 'a route for the wallet\'s tokens');
    console.log('quote keys', Object.keys(q).join(','), 'msgValue', String(q.msgValue), 'out', String(q.amountOut));
    await send('0x000000000000FB114709235f1ccBFfb925F600e4', q.callData, q.msgValue ?? 3n * 10n ** 17n);
    assert.ok((await balOf(token, acct.address)) > 0n, 'the wallet holds the token');
    if (!registered) { const c = ux.registerTokenCall(token); await send(c.to, c.data, 0n, 200000n); ({ row, registered } = await ux.externalAsset(token)); assert.equal(registered, true); }
  });
  await test(`${name}: ETH and the held token found the pool with no swap; the wallet then shields exactly the founding shares`, async () => {
    const eth = 2n * 10n ** 16n;
    const q = await quoteEthToToken({ ethCall: quoteCall, to: ROUTER, tokenOut: token, amount: eth, slippageBps: 100, deadline: head + 1800n });
    const plan = foundingPlan({ swapIn: eth, amountOut: q.amountOut, amountLimit: q.amountOut, unitB: scale });
    assert.ok(plan && plan.shares > 0n && plan.bLeg % scale === 0n && plan.ethLeg % 10n ** 10n === 0n, 'a founding plan from the market rate, legs on the pool\'s units');
    const held = await balOf(token, acct.address);
    assert.ok(held >= plan.bLeg, `the wallet holds the token leg (${held} >= ${plan.bLeg})`);
    // the token's one approval to Permit2, then the ETH + token add with a Permit2 signature for the token leg
    await send(token, '0x095ea7b3' + w32(PERMIT2) + 'f'.repeat(64), 0n, 200000n);
    const al = String(await ethCall(PERMIT2, '0x927da105' + w32(acct.address) + w32(token) + w32(ROUTER))).replace(/^0x/, '');
    const nonce = BigInt('0x' + al.slice(128, 192));
    const built = router.buildAddLiquidityPublicETHWithPermit2({ priv: acct.priv, token, ethAmount: plan.ethLeg, tokenAmount: plan.bLeg, feeBps: 30, minSharesOut: plan.shares, deadline: head + 1800n, to: acct.address, permit2Nonce: nonce, expiration: head + 1800n, sigDeadline: head + 1800n });
    const t0 = held, e0 = BigInt(await call('eth_getBalance', [acct.address, 'latest']));
    await send(built.to, built.calldata, built.value);
    const res = await ux.poolReserves(poolId);
    const [rEth, rTok] = String(res.assetA).toLowerCase() === ETH_ID ? [res.reserveA, res.reserveB] : [res.reserveB, res.reserveA];
    assert.equal(rEth, plan.ethLeg / 10n ** 10n, 'the ETH reserve is the ETH leg');
    assert.equal(rTok, plan.bLeg / scale, 'the token reserve is the token leg');
    assert.equal(res.totalShares, plan.shares + 1000n, 'the founding add mints exactly the plan\'s shares, and locks 1000');
    assert.equal(t0 - (await balOf(token, acct.address)), plan.bLeg, 'the token leg left the wallet, no more');
    assert.ok(e0 - BigInt(await call('eth_getBalance', [acct.address, 'latest'])) >= plan.ethLeg, 'the ETH leg left the wallet');
    assert.equal(await balOf(token, ROUTER), 0n, 'the router keeps nothing');
    // the wallet's own shieldShares, for the page's share note
    const note = ux.buildShareWrap({ walletPriv: priv, poolId, shares: plan.shares, index: 0 });
    await send(POOL, router.shieldSharesCalldata({ poolId, shares: plan.shares, commit: note.commit }), 0n, 400000n);
    assert.equal(BigInt(await ethCall(POOL, '0x7da9874f' + w32(note.depositId))), 1n, 'the share note\'s deposit waits for its proof');
    const again = await ethCall(POOL, router.shieldSharesCalldata({ poolId, shares: 1n, commit: note.commit }), 'latest', { from: acct.address }).then(() => false, () => true);
    assert.ok(again, 'no public shares are left to shield (all of them went into the note)');
  });
}
console.log(`\n${n} passed`);
