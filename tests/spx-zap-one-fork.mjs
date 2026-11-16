// The SPX page's "Buy and shield" as ONE transaction (card.js zapOne, index.html xtZapShield / xtZapDeposit, route.js zapShieldPlan, confidential-router.js
// zapETHToShieldedNoteCalldata), checked on an anvil fork of mainnet with the real deployment and the calls the page makes:
//   - zQuoter's route for ETH into SPX, paid to the ROUTER, is read by zapShieldPlan; the note is the swap's least; the exact call is run as a call first, from the account
//   - sent, the one transaction lands: the pool escrows exactly the note under SPX's own asset id, its Wrap event carries the deposit id this key's note has (so the relay's
//     settle finds it, and depositStatus says pending as after a plain shield), what the swap paid above the note comes back to the account, and the router keeps nothing
//   - a note above what the swap can pay reverts as ShortSwapOutput, as a call, so a send is never made; a swap that pays the account instead of the router is refused
// The outside swap is quoted on mainnet itself (QUOTE_RPC, default publicnode): zQuoter's scan reads many venues, too slow to fault into a fork.
// Run: anvil --fork-url <mainnet rpc> --port 8547 --chain-id 1 & node tests/spx-zap-one-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { setActiveNetwork } from '../dapp/confidential-deployments.js';
import { quoteEthToToken, zapShieldPlan, CONF_ROUTER } from '../dapp/swap/route.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const QUOTE_RPC = process.env.QUOTE_RPC || 'https://ethereum-rpc.publicnode.com';
const SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';
const rpcAt = (url) => async (method, params) => {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { data: r.error.data });
  return r.result;
};
const call = rpcAt(ANVIL), quote = rpcAt(QUOTE_RPC);
const hexv = (v) => '0x' + BigInt(v).toString(16);
const quoteCall = (to, data, block = 'latest', o = {}) => quote('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: hexv(o.gas) } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, block]);
const fetchImpl = (url, opts) => (/^https?:\/\/[^/]*(rpc|node|gateway|eth|llama|ankr|drpc|merkle|infura|alchemy|cloudflare)/i.test(String(url)) ? fetch(ANVIL, opts) : fetch(url, opts));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl, network: 'mainnet' });
const priv = '0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const acct = ux.account(priv), POOL = ux.cfg.pool, ROUTER = ux.cfg.router;
const w32 = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0'), hx = (b) => Buffer.from(b).toString('hex');
const balOf = async (t, a) => BigInt(await call('eth_call', [{ to: t, data: '0x70a08231' + w32(a) }, 'latest']));
const ethOf = async (a) => BigInt(await call('eth_getBalance', [a, 'latest']));
const WRAP_TOPIC = '0x' + hx(keccak_256(new TextEncoder().encode('Wrap(bytes32,bytes32,uint256)')));
const STATUS = '0x' + hx(keccak_256(new TextEncoder().encode('depositStatus(bytes32)')).subarray(0, 4));
const SHORT_SWAP_OUTPUT = '0x38be3529';
async function receipt(h) {
  for (let i = 0; i < 120; i++) { const r = await call('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 500)); }
  throw new Error(`no receipt for ${h}`);
}
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
assert.equal(ROUTER.toLowerCase(), CONF_ROUTER.toLowerCase(), 'the router the swap pays is the router the page sends to');
await call('anvil_setBalance', [acct.address, '0x' + (5n * 10n ** 18n).toString(16)]);
await call('anvil_impersonateAccount', [acct.address]);
const chainNow = async () => Number(BigInt((await call('eth_getBlockByNumber', ['latest', false])).timestamp));
const WEI = 2n * 10n ** 16n;                                   // 0.02 ETH
const { row, registered } = await ux.externalAsset(SPX);
assert.equal(registered, true);
assert.equal(BigInt(row.unitScale), 1n);
const dl = BigInt(Math.ceil(((await chainNow()) + 1200) / 60) * 60);
const q = await quoteEthToToken({ ethCall: quoteCall, to: CONF_ROUTER, tokenOut: SPX, amount: WEI, slippageBps: 50, deadline: dl });
assert.ok(q, 'zQuoter answered');
const plan = zapShieldPlan({ quote: q, tokenOut: SPX, wei: WEI, scale: row.unitScale, deadline: dl });
assert.ok(!plan.why, `a plan (${plan.why})`);
const w = ux.buildWrap({ walletPriv: priv, amountWei: plan.wrapAmount.toString(), ticker: row.ticker, index: 0 });
const tx = ux.router.buildZapETHToShieldedNote({ tokenOut: SPX, wrapAmount: plan.wrapAmount, commit: w.commit, zrSwapData: plan.zrSwapData, amount: plan.value });
const status = async (id) => BigInt(await call('eth_call', [{ to: POOL, data: STATUS + w32(id) }, 'latest']));

await test('the plan: the note is the swap\'s least, all the ETH is sent, the swap pays the router', async () => {
  assert.equal(plan.wrapAmount, q.amountLimit);
  assert.equal(plan.value, WEI);
  assert.equal(plan.to.toLowerCase(), ROUTER.toLowerCase());
  assert.ok(plan.rest > 0n && plan.rest < plan.wrapAmount);
  assert.equal(tx.to.toLowerCase(), ROUTER.toLowerCase());
});
await test('a note above what the swap can pay reverts as ShortSwapOutput when run as a call, so the page sends nothing', async () => {
  const data = ux.router.zapETHToShieldedNoteCalldata({ tokenOut: SPX, wrapAmount: q.amountOut + 1n, commit: w.commit, zrSwapData: plan.zrSwapData });
  await assert.rejects(call('eth_call', [{ from: acct.address, to: ROUTER, data, value: hexv(WEI) }, 'latest']), (e) => JSON.stringify(e.data || e.message).includes(SHORT_SWAP_OUTPUT.slice(2)));
});
await test('a swap that pays the account, not the router, is refused before anything is run', async () => {
  const bent = q.callData.replaceAll(w32(CONF_ROUTER), w32(acct.address));
  assert.notEqual(bent, q.callData);
  assert.match(zapShieldPlan({ quote: { ...q, callData: bent }, tokenOut: SPX, wei: WEI, scale: row.unitScale, deadline: dl }).why, /recipient/);
});
let pool0, acct0, eth0, rc;
await test('the exact call runs as a call from the account, then lands as one transaction', async () => {
  await call('eth_call', [{ from: acct.address, to: tx.to, data: tx.calldata, value: hexv(tx.value) }, 'latest']);
  [pool0, acct0, eth0] = [await balOf(SPX, POOL), await balOf(SPX, acct.address), await ethOf(acct.address)];
  assert.equal(await status(w.depositId), 0n, 'no deposit yet');
  const h = await call('eth_sendTransaction', [{ from: acct.address, to: tx.to, data: tx.calldata, value: hexv(tx.value), gas: '0x7a120' }]);
  rc = await receipt(h);
  assert.equal(rc.status, '0x1');
});
await test('the pool escrowed exactly the note, under SPX\'s own asset id, and its Wrap event is the deposit id of this key\'s note, pending as after a plain shield', async () => {
  assert.equal((await balOf(SPX, POOL)) - pool0, plan.wrapAmount, 'the pool holds exactly the note');
  const ev = rc.logs.find((l) => l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === WRAP_TOPIC);
  assert.ok(ev, 'the pool emitted Wrap');
  assert.equal(ev.topics[2], row.assetId);
  assert.equal(BigInt(ev.data), plan.wrapAmount);
  assert.equal(ev.topics[1], w.depositId, 'the deposit id the engine\'s note has, which the relay\'s proof consumes (and which the key\'s note-index scan reads off a Wrap event: this index is used)');
  assert.equal(await status(w.depositId), 1n, 'pending: the proof that makes it private settles it');
});
await test('what the swap paid above the note came back to the account, and the router keeps nothing', async () => {
  const back = (await balOf(SPX, acct.address)) - acct0;
  assert.ok(back >= 0n && back <= q.amountOut - plan.wrapAmount + (q.amountOut / 100n), `the rest came back (${back}, about ${plan.rest})`);
  assert.equal(await balOf(SPX, ROUTER), 0n, 'no SPX left in the router');
  assert.equal(await ethOf(ROUTER), 0n, 'no ETH left in the router');
  const spent = eth0 - (await ethOf(acct.address));
  assert.ok(spent >= WEI && spent < WEI + 10n ** 16n, 'the ETH typed went, and a network fee, no more');
  assert.ok(BigInt(rc.gasUsed) < 400000n, `gas ${BigInt(rc.gasUsed)}`);
});
console.log(`\n${n} spx one-transaction zap checks passed`);
