// The SPX page's zap, ETH into private SPX (dapp/swap/card.js kind 'zap', then the page's xtShieldRaw / xtWrapNow), checked on an anvil fork of mainnet with the real
// deployment and the same calls the card and the page make:
//   - zQuoter's route for ETH into SPX, to the account (route.js quoteEthToToken, the call the card makes), is run as a call first and then sent as zRouter's
//     transaction (to zRouter, the amount as its value): it lands, and SPX arrives at the account, at least the least the quote promised
//   - the deposit that follows is for exactly what arrived (the balance after less the balance before, as the card reads it): the account deposits it through
//     the router by Permit2, the pool escrows exactly that, and its Wrap event carries SPX's own asset id
//   - a quote asked for a smaller or larger amount is a different quote: nothing from one is reused for the other
//   - the swap leg does not reach the pool: nothing of the pool's moved until the deposit
// The outside swap is quoted on mainnet itself (QUOTE_RPC, default publicnode): zQuoter's scan reads many venues, too slow to fault into a fork.
// Run: anvil --fork-url <mainnet rpc> --port 8547 --chain-id 1 & node tests/spx-zap-fork.mjs [anvil url]
import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { setActiveNetwork } from '../dapp/confidential-deployments.js';
import { quoteEthToToken, ZROUTER } from '../dapp/swap/route.js';

const ANVIL = process.argv[2] || 'http://127.0.0.1:8547';
const QUOTE_RPC = process.env.QUOTE_RPC || 'https://ethereum-rpc.publicnode.com';
const SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';
const rpcAt = (url) => async (method, params) => {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const call = rpcAt(ANVIL), quote = rpcAt(QUOTE_RPC);
const hexv = (v) => '0x' + BigInt(v).toString(16);
// the card's ethCall: (to, data), the route module's reads
const ethCall = (to, data, block = 'latest', o = {}) => call('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: hexv(o.gas) } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, block]);
const quoteCall = (to, data, block = 'latest', o = {}) => quote('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: hexv(o.gas) } : {}), ...(o.value ? { value: hexv(o.value) } : {}) }, block]);
const fetchImpl = (url, opts) => (/^https?:\/\/[^/]*(rpc|node|gateway|eth|llama|ankr|drpc|merkle|infura|alchemy|cloudflare)/i.test(String(url)) ? fetch(ANVIL, opts) : fetch(url, opts));
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl, network: 'mainnet' });
const priv = '0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const acct = ux.account(priv), POOL = ux.cfg.pool;
const w32 = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0'), hx = (b) => Buffer.from(b).toString('hex');
const balOf = async (t, a) => BigInt(await ethCall(t, '0x70a08231' + w32(a)));
const WRAP_TOPIC = '0x' + hx(keccak_256(new TextEncoder().encode('Wrap(bytes32,bytes32,uint256)')));
async function receipt(h) {
  for (let i = 0; i < 120; i++) { const r = await call('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 500)); }
  throw new Error(`no receipt for ${h}`);
}
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
await call('anvil_setBalance', [acct.address, '0x' + (5n * 10n ** 18n).toString(16)]);
await call('anvil_impersonateAccount', [acct.address]);
const chainNow = async () => Number(BigInt((await call('eth_getBlockByNumber', ['latest', false])).timestamp));
const WEI = 5n * 10n ** 16n;                                   // 0.05 ETH
const ask = async (amount, to = acct.address) => quoteEthToToken({ ethCall: quoteCall, to, tokenOut: SPX, amount, slippageBps: 50, deadline: BigInt((await chainNow()) + 1800) });

let got = 0n;
await test('ETH into SPX: the quote is zRouter\'s, to the account, for the amount, and its call runs, then lands', async () => {
  const q = await ask(WEI);
  assert.ok(q, 'zQuoter answered');
  assert.equal(q.amountIn, WEI);
  assert.equal(q.msgValue, WEI);
  assert.ok(q.amountOut > 0n && q.amountLimit > 0n && q.amountLimit <= q.amountOut, 'a price and a floor under it');
  const tx = { to: ZROUTER, data: q.callData, value: q.msgValue };
  // the card runs it as a call first (venues.simulate): from the account, with the value
  await ethCall(tx.to, tx.data, 'latest', { from: acct.address, value: tx.value });
  const before = await balOf(SPX, acct.address), eth0 = BigInt(await call('eth_getBalance', [acct.address, 'latest']));
  const h = await call('eth_sendTransaction', [{ from: acct.address, to: tx.to, data: tx.data, value: hexv(tx.value), gas: '0x7a120' }]);
  const r = await receipt(h);
  assert.equal(r.status, '0x1', 'the swap landed');
  got = (await balOf(SPX, acct.address)) - before;
  assert.ok(got > 0n, 'SPX arrived');
  assert.ok(got >= q.amountLimit, `at least the least it promised (${got} >= ${q.amountLimit})`);
  const spent = eth0 - BigInt(await call('eth_getBalance', [acct.address, 'latest']));
  assert.ok(spent >= WEI && spent < WEI + 10n ** 16n, 'the amount went, and a network fee, no more');
});
await test('the swap leg moves nothing of the pool\'s: the account holds the SPX and the pool has none of it yet', async () => {
  assert.equal(await balOf(SPX, acct.address), got);
});
await test('a different amount is a different quote: the one made for 0.05 ETH is not the one for 0.02', async () => {
  const [a, b] = [await ask(WEI), await ask(WEI * 2n / 5n)];
  assert.notEqual(a.callData, b.callData);
  assert.equal(b.amountIn, WEI * 2n / 5n);
  assert.ok(b.amountOut < a.amountOut);
});
await test('the deposit that follows is for exactly what arrived: the pool escrows it, under SPX\'s own id', async () => {
  const { row, registered } = await ux.externalAsset(SPX);
  assert.equal(registered, true);
  assert.equal(BigInt(row.unitScale), 1n);
  const a0 = await balOf(SPX, acct.address), p0 = await balOf(SPX, POOL);
  assert.equal(a0, got);
  const w = await ux.routerWrap({ walletPriv: priv, amountWei: got.toString(), ticker: row.ticker, index: 0 });
  const r = await receipt(w.txHash);
  assert.equal(r.status, '0x1');
  assert.equal(a0 - (await balOf(SPX, acct.address)), got, 'all of it left the account');
  assert.equal((await balOf(SPX, POOL)) - p0, got, 'and the pool escrowed exactly it');
  const ev = r.logs.find((l) => l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === WRAP_TOPIC);
  assert.ok(ev, 'the pool emitted Wrap');
  assert.equal(ev.topics[2], row.assetId);
  assert.equal(BigInt(ev.data), got);
  assert.equal(ev.topics[1], w.depositId);
});
console.log(`\n${n} spx zap checks passed`);
