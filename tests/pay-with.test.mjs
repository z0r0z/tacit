// dapp/pay-with.js, a deposit paid with a token: which tokens it offers, how it sizes the sale to the deposit, the most the person agreed to, and how the
// zap takes the token (zapPullWith: an allowance in place, an approval batched with the deposit, or an approval first). With made-up routes and chain reads;
// LIVE=1 also prices USDC, WBTC and DAI for a 0.05 ETH deposit on Ethereum (read-only eth_call).
//   node --test tests/pay-with.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const PW = await import('../dapp/pay-with.js');
const { LIST } = await import('../dapp/swap/tokens.js');

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', E18 = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

test('the tokens offered: the list\'s Ethereum tokens, not ETH, TAC or stETH, nothing malformed', () => {
  const got = PW.payTokens(LIST).map((t) => t.s);
  for (const s of ['USDC', 'USDT', 'DAI', 'WBTC', 'wstETH']) assert.ok(got.includes(s), s);
  for (const s of ['ETH', 'TAC', 'stETH']) assert.ok(!got.includes(s), s);
  assert.deepEqual(PW.payTokens([{ a: '0x12', c: 1, s: 'X', d: 18 }, { a: USDC, c: 8453, s: 'USDC', d: 6 }, { a: USDC, c: 1, s: 'USDC', d: 6.5 }, null]), []);
});

test('the sale is sized so its minimum covers the deposit, through the price moving with size', async () => {
  // a pool whose price falls as more is sold: 3000 USDC an ETH for the first, 1% less for every 10 ETH
  const route = async ({ amountIn }) => {
    const a = BigInt(amountIn), eth = (a * E18) / 3000_000000n, out = eth - (eth * eth) / (1000n * E18), min = (out * 9950n) / 10000n;
    return { amountIn: a, callData: '0xfeed' + word(a), out, min, name: 'a pool' };
  };
  for (const d of [E18 / 100n, E18, 25n * E18]) {
    const r = await PW.quoteDeposit({ ethCall: null, token: USDC, dec: 6, depositWei: d, from: '0x' + '01'.repeat(20), deadline: 1n, route });
    assert.ok(r && r.min >= d, `min covers ${d}`);
    assert.ok(r.amountIn * 10000n <= ((d * 3000_000000n) / E18) * 10400n, `not much over the price for ${d}: ${r.amountIn}`);
    assert.equal(r.callData, '0xfeed' + word(r.amountIn), 'the calldata is the sized sale\'s');
  }
  assert.equal(await PW.quoteDeposit({ ethCall: null, token: USDC, dec: 6, depositWei: E18, from: '0x' + '01'.repeat(20), deadline: 1n, route: async () => null, wait: 1 }), null);
  assert.equal(await PW.quoteDeposit({ ethCall: null, token: USDC, dec: 6, depositWei: E18, from: '0x' + '01'.repeat(20), deadline: 1n, route: async () => { throw new Error('down'); }, wait: 1 }), null);
  assert.equal(await PW.quoteDeposit({ ethCall: null, token: USDC, dec: 6, depositWei: 0n, from: '0x' + '01'.repeat(20), deadline: 1n, route }), null);
});

test('a node that turns the first quote down is asked once more', async () => {
  let n = 0;
  const route = async ({ amountIn }) => (++n === 1 ? null : { amountIn: BigInt(amountIn), callData: '0x', out: BigInt(amountIn) * 10n ** 9n, min: BigInt(amountIn) * 10n ** 9n, name: 'p' });
  const r = await PW.quoteDeposit({ ethCall: null, token: USDC, dec: 6, depositWei: E18, from: '0x' + '01'.repeat(20), deadline: 1n, route, wait: 1 });
  assert.ok(r && r.min >= E18);
  let m = 0;
  const q = await PW.quoteOut({ ethCall: null, rpc: null, token: USDC, amount: E18, to: '0x' + '5a'.repeat(20), deadline: 1n, wait: 1, route: async ({ to }) => (++m === 1 ? null : { to, out: 1n, min: 1n, callData: '0x', standData: '0x', deadline: 1n }) });
  assert.ok(q && m === 2);
});

test('the most agreed to is what was shown and 1% over, rounded up', () => {
  assert.equal(PW.mostOf(100n), 101n);
  assert.equal(PW.mostOf(1n), 2n);
  assert.equal(PW.mostOf(150_000000n), 151_500000n);
});

// readAccess reads balanceOf, allowance (to the zap), Permit2's allowance and nonces in one Multicall3 aggregate3: answer it from `acc` (no nonces, no permit)
const chain = (acc) => async () => {
  const vals = [acc.balance, acc.allowed, acc.permit2 ?? 0n, null], els = vals.map((v) => (v == null ? word(0) + word(64) + word(0) : word(1) + word(64) + word(32) + word(v)));
  let off = vals.length * 32, heads = '';
  for (const e of els) { heads += word(off); off += e.length / 2; }
  return '0x' + word(32) + word(vals.length) + heads + els.join('');
};
const signer = (o = {}) => { const sent = []; return { sent, address: '0x' + '01'.repeat(20), send: async (c) => { sent.push(c); return '0x' + 'aa'.repeat(32); }, ...o }; };

test('the zap\'s pull: an allowance in place asks nothing', async () => {
  const s = signer();
  const p = await PW.zapPullWith({ ethCall: chain({ balance: 10n ** 9n, allowed: 10n ** 9n }), signer: s, mined: async () => {}, calldata: async () => null, token: USDC, sym: 'USDC', amount: 5n * 10n ** 8n, deadline: 9n });
  assert.deepEqual(p, { kind: 'allowance' });
  assert.equal(s.sent.length, 0);
});
test('the zap\'s pull: too little in the wallet is refused before anything is asked', async () => {
  await assert.rejects(PW.zapPullWith({ ethCall: chain({ balance: 1n, allowed: 0n }), signer: signer(), mined: async () => {}, calldata: async () => null, token: USDC, sym: 'USDC', amount: 5n, deadline: 9n }), /Not enough USDC/);
});
test('the zap\'s pull: a wallet that batches gets the approval of exactly the amount, to the zap, with the deposit', async () => {
  const s = signer({ batch: async () => {}, canBatch: async () => true });
  const p = await PW.zapPullWith({ ethCall: chain({ balance: 10n ** 9n, allowed: 0n }), signer: s, mined: async () => {}, calldata: async () => null, token: USDC, sym: 'USDC', amount: 123n, deadline: 9n });
  assert.equal(p.kind, 'allowance');
  assert.equal(p.before.length, 1);
  assert.equal(p.before[0].to, USDC);
  assert.equal(p.before[0].data, '0x095ea7b3' + PW.ZAP.slice(2).toLowerCase().padStart(64, '0') + word(123n));
  assert.equal(s.sent.length, 0);
});
test('the zap\'s pull: otherwise the approval goes first and is waited for; USDT with an allowance left is set to zero before', async () => {
  const mined = []; const s = signer();
  const p = await PW.zapPullWith({ ethCall: chain({ balance: 10n ** 9n, allowed: 7n }), signer: s, mined: async (h) => { mined.push(h); }, calldata: async () => null, token: USDT, sym: 'USDT', amount: 50n, deadline: 9n });
  assert.deepEqual(p, { kind: 'allowance' });
  assert.equal(s.sent.length, 2);
  assert.ok(s.sent[0].data.endsWith(word(0n)), 'zero first');
  assert.ok(s.sent[1].data.endsWith(word(50n)), 'then exactly the amount');
  assert.equal(mined.length, 2);
});

test('the zap\'s pull: with Permit2 let take the token, a signature transfer naming the zap is signed and checked on chain, and no approval is sent', async () => {
  const { calldata } = await import('../dapp/evm-pool-gateway.js');
  const asked = [], typed = [], s = signer({ signTyped: async (t) => { typed.push(t); return '0x' + '55'.repeat(65); } });
  const multi = chain({ balance: 10n ** 9n, allowed: 0n, permit2: 10n ** 12n });
  const ethCall = async (to, data, block, o) => { asked.push({ to: to.toLowerCase(), sel: data.slice(0, 10), from: o?.from }); return to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' ? multi() : '0x'; };
  const p = await PW.zapPullWith({ ethCall, signer: s, mined: async () => {}, calldata: async () => calldata, token: USDC, sym: 'USDC', amount: 77n, deadline: 1_900_000_000n });
  assert.equal(p.kind, 'permit2'); assert.equal(p.sig, '0x' + '55'.repeat(65)); assert.equal(p.deadline, 1_900_000_000n);
  assert.equal(typed.at(-1).primaryType, 'PermitTransferFrom');
  assert.equal(typed.at(-1).message.spender, PW.ZAP); assert.equal(typed.at(-1).message.permitted.amount, '77');
  const check = asked.find((x) => x.to === '0x000000000022d473030f116ddee9f6b43ac78ba3');
  assert.ok(check && check.from === PW.ZAP, 'the transfer is tried on chain as the zap would make it');
  assert.equal(s.sent.length, 0);
});

test('a withdrawal received as a token: the route pays the address, the gas is the pool\'s base and half again the sale\'s estimate, with a fallback', async () => {
  const TO = '0x' + '5a'.repeat(20), route = async ({ to, amount }) => ({ to, out: amount * 3000n, min: amount * 2985n, callData: '0xbeef' + to.slice(2), standData: '0xbeef', deadline: 99n, name: 'a pool' });
  const est = [];
  const q = await PW.quoteOut({ ethCall: null, rpc: async (m, p) => { est.push(p[0]); return '0x30d40'; }, token: USDC, amount: 10n ** 17n, to: TO, deadline: 99n, route });
  assert.equal(q.r.to, TO); assert.equal(q.gas, 520_000 + 300_000);
  assert.equal(est[0].from.toLowerCase(), '0x000000c2a20657ce25f2ba99737933d031afbee9', 'estimated as the pool would send it');
  assert.equal(est[0].value, '0x' + (10n ** 17n).toString(16));
  const q2 = await PW.quoteOut({ ethCall: null, rpc: async () => { throw new Error('no'); }, token: USDC, amount: 10n ** 17n, to: TO, deadline: 99n, route });
  assert.equal(q2.gas, 520_000 + 600_000, 'the fallback when the node will not estimate');
  assert.equal(await PW.quoteOut({ ethCall: null, rpc: null, token: USDC, amount: 10n ** 17n, to: TO, deadline: 99n, route: async () => null, wait: 1 }), null);
  const gw = await import('../dapp/evm-pool-gateway.js');
  const it = PW.outIntent(gw, { r: q.r, amount: 10n ** 17n, refund: '0x' + 'ee'.repeat(20), nonce: 5n });
  assert.equal(it.calls.length, 1);
  assert.equal(it.calls[0].target.toLowerCase(), PW.ZROUTER.toLowerCase());
  assert.equal(BigInt(it.calls[0].value), 10n ** 17n);
  assert.equal(it.refund.toLowerCase(), '0x' + 'ee'.repeat(20));
});

test('LIVE: USDC, WBTC and DAI each price a 0.05 ETH deposit onchain', { skip: !process.env.LIVE }, async () => {
  const { jsonRpc } = await import('../dapp/evm-pool-wallet.js');
  const rpc = jsonRpc(['https://rpc.mevblocker.io', 'https://ethereum-rpc.publicnode.com']);
  const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.gas ? { gas: o.gas } : {}), ...(o.value != null ? { value: '0x' + BigInt(o.value).toString(16) } : {}) }, block, ...(o.state ? [o.state] : [])]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200), d = E18 / 20n;
  for (const s of ['USDC', 'WBTC', 'DAI']) {
    const t = PW.payTokens(LIST).find((x) => x.s === s);
    const r = await PW.quoteDeposit({ ethCall, token: t.a, dec: t.d, depositWei: d, from: '0x' + '01'.repeat(20), deadline });
    assert.ok(r && r.min >= d, `${s} priced`);
    console.log(`  ${s}: ${Number(r.amountIn) / 10 ** t.d} for 0.05 ETH through ${r.name}`);
    const o = await PW.quoteOut({ ethCall, rpc, token: t.a, amount: d, to: '0x' + '5a'.repeat(20), deadline });
    assert.ok(o && o.r.min > 0n && o.gas > 520_000, `0.05 ETH sells for ${s}`);
    console.log(`  0.05 ETH out: at least ${Number(o.r.min) / 10 ** t.d} ${s} through ${o.r.name}, gas ${o.gas}`);
  }
});
