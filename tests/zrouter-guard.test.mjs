#!/usr/bin/env node
// The zQuoter answer guard (dapp/zrouter-guard.js): real quoter outputs for each route shape pass against the terms asked for,
// and every way of redirecting, widening or replacing the call is refused.
//   node tests/zrouter-guard.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { checkZRouterCall, decodeZRouterCall, checkSnwapCall, decodeSnwap, SNWAP_EXECUTORS, CURVE_POOLS, ZROUTER, WETH } from '../dapp/zrouter-guard.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/zrouter-quotes.json', import.meta.url), 'utf8'));
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

const OTHER = '0x' + 'ba'.repeat(20);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const wordN = (v) => BigInt(v).toString(16).padStart(64, '0');

// Every real answer is accepted for the terms it was asked for.
for (const f of fixtures) ok(checkZRouterCall(f.callData, f.want) === null, `accepts: ${f.label}`);

const single = fixtures.find((f) => f.label.startsWith('USDC->WETH exact-out'));
const curve = fixtures.find((f) => f.label.startsWith('stETH->WETH exact-in'));
const chain = fixtures.find((f) => f.label.startsWith('wstETH->PROVE via ETH'));
const usdtChain = fixtures.find((f) => f.label.startsWith('USDT->PROVE via ETH'));
const ethIn = fixtures.find((f) => f.label.startsWith('ETH->PROVE exactOut=false'));

// The terms must match the call.
for (const f of fixtures) {
  ok(checkZRouterCall(f.callData, { ...f.want, to: OTHER }) !== null, `refuses another recipient: ${f.label}`);
  ok(checkZRouterCall(f.callData, { ...f.want, tokenOut: OTHER }) !== null, `refuses another output token: ${f.label}`);
  ok(checkZRouterCall(f.callData, { ...f.want, tokenIn: OTHER }) !== null, `refuses another input token: ${f.label}`);
}
ok(checkZRouterCall(single.callData, { ...single.want, amount: BigInt(single.want.amount) + 1n }) !== null, 'refuses another amount');
ok(checkZRouterCall(single.callData, { ...single.want, exactOut: false }) !== null, 'refuses the other kind of swap');
ok(checkZRouterCall(single.callData, { ...single.want, deadline: 1 }) !== null, 'refuses another deadline');

// The recipient inside the bytes is what is read: rewriting it to another address is refused.
{
  const bent = single.callData.replaceAll(pad(single.want.to), pad(OTHER));
  ok(bent !== single.callData && checkZRouterCall(bent, single.want) !== null, 'refuses a recipient rewritten inside the call');
  const bentChain = chain.callData.replaceAll(pad(chain.want.to), pad(OTHER));
  ok(bentChain !== chain.callData && checkZRouterCall(bentChain, chain.want) !== null, 'refuses a chain whose last recipient is rewritten');
  const bentMid = chain.callData.replaceAll(pad(ZROUTER), pad(OTHER));
  ok(bentMid !== chain.callData && checkZRouterCall(bentMid, chain.want) !== null, 'refuses a chain whose middle swap pays another address');
}

// Only swaps: other zRouter functions in the selector slot are refused, whole or inside a multicall.
for (const [name, sel] of [['snwap', '5f3bd1c8'], ['sweep', 'cb019b84'], ['permit', '7ac2ff7b'], ['permitDAI', '230390f4'], ['execute', 'bd7f1ba4']]) {
  ok(checkZRouterCall('0x' + sel + single.callData.slice(10), single.want) !== null, `refuses ${name} in place of a swap`);
}
function encMulticall(legs) {
  const bodies = legs.map((l) => { const b = l.replace(/^0x/, ''); return wordN(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); });
  let off = legs.length * 32; const offs = [];
  for (const b of bodies) { offs.push(wordN(off)); off += b.length / 2; }
  return '0xac9650d8' + wordN(32) + wordN(legs.length) + offs.join('') + bodies.join('');
}
{
  const swapLeg = single.callData;
  const sweepLeg = '0xcb019b84' + pad(WETH) + wordN(0) + wordN(0) + pad(OTHER);
  ok(checkZRouterCall(encMulticall([swapLeg]), single.want) === null, 'a multicall of one swap is read like the swap');
  ok(checkZRouterCall(encMulticall([swapLeg, sweepLeg]), single.want) !== null, 'refuses a sweep riding in a multicall');
  const snwapLeg = '0x5f3bd1c8' + wordN(0).repeat(7);
  ok(checkZRouterCall(encMulticall([snwapLeg, swapLeg]), single.want) !== null, 'refuses an executor call riding in a multicall');
  ok(checkZRouterCall(encMulticall([swapLeg, swapLeg, swapLeg, swapLeg]), single.want) !== null, 'refuses a multicall of too many calls');
}

// Shape: truncated or padded calldata, garbage, and a short selector are refused.
ok(checkZRouterCall(single.callData.slice(0, -64), single.want) !== null, 'refuses a truncated swap');
ok(checkZRouterCall(single.callData + '00'.repeat(32), single.want) !== null, 'refuses a swap with trailing bytes');
ok(checkZRouterCall('0x', single.want) !== null && checkZRouterCall('0xzz', single.want) !== null && checkZRouterCall('', single.want) !== null, 'refuses empty and non-hex calldata');
ok(checkZRouterCall(single.callData.slice(0, 10) + 'ff'.repeat(32) + single.callData.slice(74), single.want) !== null, 'refuses a word that is not an address');
assert.throws(() => decodeZRouterCall('0x12345678'), /not a swap/);

// Curve: the pools must be known; the caller may add one.
{
  const pool = decodeZRouterCall(curve.callData)[0].pools[0];
  ok(CURVE_POOLS.includes(pool), 'the captured curve route uses a listed pool');
  const bent = curve.callData.replaceAll(pad(pool), pad(OTHER));
  ok(checkZRouterCall(bent, curve.want) !== null, 'refuses a curve route through an unlisted pool');
  const bentWanted = { ...curve.want };
  ok(checkZRouterCall(bent.replaceAll(pad(OTHER), pad(OTHER)), { ...bentWanted, curvePools: [OTHER] }) === null, 'accepts the same route once the caller lists the pool');
  const usdt = decodeZRouterCall(usdtChain.callData);
  ok(usdt.length === 2 && usdt[0].fn === 'swapCurve' && usdt[1].fn === 'swapV3', 'a curve leg followed by a v3 leg reads as a chain');
}

// Bounds the caller may set on what is spent and paid.
{
  const d = decodeZRouterCall(single.callData)[0];
  ok(checkZRouterCall(single.callData, { ...single.want, maxIn: d.limit }) === null, 'maxIn equal to the limit is accepted');
  ok(checkZRouterCall(single.callData, { ...single.want, maxIn: d.limit - 1n }) !== null, 'maxIn under the limit is refused');
  ok(checkZRouterCall(single.callData, { ...single.want, minOut: d.amount }) === null, 'minOut equal to what is bought is accepted');
  ok(checkZRouterCall(single.callData, { ...single.want, minOut: d.amount + 1n }) !== null, 'minOut over what is bought is refused');
  const e = decodeZRouterCall(ethIn.callData)[0];
  ok(checkZRouterCall(ethIn.callData, { ...ethIn.want, minOut: e.limit }) === null && checkZRouterCall(ethIn.callData, { ...ethIn.want, minOut: e.limit + 1n }) !== null, 'minOut reads the limit of an exact-in swap');
  ok(checkZRouterCall(ethIn.callData, { ...ethIn.want, maxIn: e.amount }) === null && checkZRouterCall(ethIn.callData, { ...ethIn.want, maxIn: e.amount - 1n }) !== null, 'maxIn reads the amount of an exact-in swap');
  const c = decodeZRouterCall(chain.callData);
  ok(checkZRouterCall(chain.callData, { ...chain.want, maxIn: c[0].amount }) === null && checkZRouterCall(chain.callData, { ...chain.want, maxIn: c[0].amount - 1n }) !== null, 'maxIn bounds the first swap of a chain');
  ok(checkZRouterCall(chain.callData, { ...chain.want, minOut: c[1].limit + 1n }) !== null, 'minOut bounds the last swap of a chain');
}

// swapVZ: a plain fee is accepted, a hook or a multi-token id is not.
{
  const vz = (fee, idIn = 0, idOut = 0) => '0x9d5b5af8' + [pad(single.want.to), wordN(1), wordN(fee), pad(single.want.tokenIn), pad(WETH), wordN(idIn), wordN(idOut), wordN(10n ** 17n), wordN(10n ** 9n), wordN(single.want.deadline)].join('');
  const want = { ...single.want, amount: 10n ** 17n };
  ok(checkZRouterCall(vz(3000), want) === null, 'swapVZ with a plain fee is accepted');
  ok(checkZRouterCall(vz(BigInt('0x' + 'ab'.repeat(20))), want) !== null, 'swapVZ naming a hook is refused');
  ok(checkZRouterCall(vz(3000, 1), want) !== null && checkZRouterCall(vz(3000, 0, 7), want) !== null, 'swapVZ with a multi-token id is refused');
}

// A chain spends what the swap before it paid: a later swap with an amount of its own would make the router pull the difference from the sender,
// and an exact-out swap at the start has no such amount to rely on.
{
  const SEL3 = 'afeae12b';
  const at = chain.callData.lastIndexOf(SEL3);
  ok(at > 0 && checkZRouterCall(chain.callData, chain.want) === null, 'a real chain (its later swap with an amount of 0) is accepted');
  const second = at + SEL3.length + 5 * 64;
  const greedy = chain.callData.slice(0, second) + wordN(3_900_000_000n) + chain.callData.slice(second + 64);
  const g = decodeZRouterCall(greedy);
  ok(g[1].amount === 3_900_000_000n && checkZRouterCall(greedy, chain.want) !== null, 'refuses a later swap that names an amount of its own');
  const first = chain.callData.indexOf(SEL3) + SEL3.length + 1 * 64;
  const flipped = chain.callData.slice(0, first) + wordN(1) + chain.callData.slice(first + 64);
  ok(decodeZRouterCall(flipped)[0].exactOut === true && checkZRouterCall(flipped, { ...chain.want, exactOut: undefined }) !== null, 'refuses a chain that starts with an exact-out swap');
  const second2 = at + SEL3.length + 1 * 64;
  const outLater = chain.callData.slice(0, second2) + wordN(1) + chain.callData.slice(second2 + 64);
  ok(decodeZRouterCall(outLater)[1].exactOut === true && checkZRouterCall(outLater, chain.want) !== null, 'refuses a later swap that is exact-out');
  ok(checkZRouterCall(usdtChain.callData, usdtChain.want) === null, 'the other real chain (a curve swap, then a pool swap) is accepted');
  ok(checkZRouterCall(chain.callData, { ...chain.want, minOut: decodeZRouterCall(chain.callData)[1].limit + 1n }) !== null, 'refuses a chain that can pay less than the least asked');
}

// The relay's copy is the same file.
{
  const a = readFileSync(new URL('../dapp/zrouter-guard.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../worker-relay/src/lib/zrouter-guard.js', import.meta.url), 'utf8');
  ok(a === b, 'worker-relay/src/lib/zrouter-guard.js is identical to dapp/zrouter-guard.js');
}

// A split: side-by-side exact-in swaps, each to the recipient, adding up to the input and to the least it pays.
{
  const sp = fixtures.find((f) => f.label.startsWith('USDC->WBTC split'));
  const legs = decodeZRouterCall(sp.callData);
  ok(legs.length === 2 && legs.every((l) => !l.exactOut && l.amount > 0n), 'a split decodes to two exact-in legs that spend amounts of their own');
  ok(checkZRouterCall(sp.callData, { ...sp.want, amount: BigInt(sp.want.amount) + 1n }) !== null, 'refuses a split whose legs do not add up to the amount');
  ok(checkZRouterCall(sp.callData, { ...sp.want, maxIn: BigInt(sp.want.maxIn) - 1n }) !== null, 'refuses a split that spends more than allowed');
  ok(checkZRouterCall(sp.callData, { ...sp.want, minOut: BigInt(sp.want.minOut) + 1n }) !== null, 'refuses a split whose limits add up to less than the least it may pay');
  ok(checkZRouterCall(sp.callData, { ...sp.want, exactOut: true }) !== null, 'refuses a split asked for as exact-out');
  // one leg sent elsewhere: no longer a split, and as a chain its middle swap leaves the router
  const amt0 = legs[0].amount.toString(16).padStart(64, '0'), bent = sp.callData.replace(pad(sp.want.to), pad(OTHER));
  ok(bent !== sp.callData && checkZRouterCall(bent, sp.want) !== null, 'refuses a split with one leg paying another address');
  const zeroed = sp.callData.replace(amt0, '0'.repeat(64));
  ok(zeroed !== sp.callData && checkZRouterCall(zeroed, { ...sp.want, amount: undefined, maxIn: undefined }) !== null, 'refuses a split leg that spends nothing of its own');
}


// A mix: paths side by side, a direct swap paying the recipient and a chain through the router, each ending at the recipient.
{
  const hy = fixtures.find((f) => f.label.startsWith('UNI->USDT hybrid'));
  const legs = decodeZRouterCall(hy.callData);
  ok(legs.length === 3 && legs[0].amount > 0n && legs[1].amount > 0n && legs[2].amount === 0n && legs[1].to.toLowerCase() === ZROUTER, 'a mix decodes to a direct swap, a first hop that stays with the router and a second hop that spends what it paid');
  ok(checkZRouterCall(hy.callData, hy.want) === null, 'a real mix of a direct swap and a chain through ETH is accepted');
  ok(checkZRouterCall(hy.callData, { ...hy.want, amount: BigInt(hy.want.amount) + 1n }) !== null, 'refuses a mix whose paths do not spend exactly the amount');
  ok(checkZRouterCall(hy.callData, { ...hy.want, maxIn: BigInt(hy.want.maxIn) - 1n }) !== null, 'refuses a mix that spends more than allowed');
  ok(checkZRouterCall(hy.callData, { ...hy.want, minOut: BigInt(hy.want.minOut) + 1n }) !== null, 'refuses a mix whose last limits add up to less than the least it may pay');
  ok(checkZRouterCall(hy.callData, { ...hy.want, exactOut: true }) !== null, 'refuses a mix asked for as exact-out');
  ok(checkZRouterCall(hy.callData, { ...hy.want, deadline: 1 }) !== null, 'refuses a mix with another deadline');
  ok(checkZRouterCall(hy.callData, { ...hy.want, to: OTHER }) !== null && checkZRouterCall(hy.callData, { ...hy.want, tokenOut: OTHER }) !== null && checkZRouterCall(hy.callData, { ...hy.want, tokenIn: OTHER }) !== null, 'refuses a mix asked for another recipient, output or input');
  // the direct swap sent elsewhere, or the chain's last swap: a path that does not end at the recipient
  const direct = hy.callData.replace(pad(hy.want.to), pad(OTHER));
  ok(direct !== hy.callData && checkZRouterCall(direct, hy.want) !== null, 'refuses a mix whose direct swap pays another address');
  const last = hy.callData.split(pad(hy.want.to)); const lastBent = last.slice(0, -1).join(pad(hy.want.to)) + pad(OTHER) + last[last.length - 1];
  ok(lastBent !== hy.callData && checkZRouterCall(lastBent, hy.want) !== null, 'refuses a mix whose chain ends at another address');
  // the first hop paying the recipient instead of the router: the second hop then follows a swap that left nothing with the router
  const hop = hy.callData.replaceAll(pad(ZROUTER), pad(hy.want.to));
  ok(hop !== hy.callData && checkZRouterCall(hop, hy.want) !== null, 'refuses a second hop that does not follow a swap that stayed with the router');
  // a leg's own amount zeroed: a path that takes nothing of the asked token
  const hopAmt = legs[1].amount.toString(16).padStart(64, '0'), zeroed = hy.callData.replace(hopAmt, '0'.repeat(64));
  ok(zeroed !== hy.callData && checkZRouterCall(zeroed, { ...hy.want, amount: undefined, maxIn: undefined }) !== null, 'refuses a first hop with no amount of its own');
}

// An outside solver's route: snwap through one of zSwap's forwarders, paying the asked recipient at least the floor (dapp/swap/solvers.js
// writes it the same way). It is accepted only through checkSnwapCall, never as a zQuoter answer.
{
  const ETH0 = '0x' + '0'.repeat(40), USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ME = '0x' + '5e'.repeat(20), ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
  const kyber = Object.keys(SNWAP_EXECUTORS).find((a) => SNWAP_EXECUTORS[a] === 'KyberSwap');
  const bytesOf = (h) => { const x = h.replace(/^0x/, ''); return wordN(x.length / 2) + x.padEnd(Math.ceil(x.length / 64) * 64, '0'); };
  const snwap = ({ tokenIn = ETH0, amountIn = 0n, to = ME, tokenOut = USDC, minOut = 1000n, fwd = kyber, router = ROUTER, fIn = tokenIn, fOut = tokenOut, fTo = to, data = 'e21fd0e9' + '11'.repeat(70) } = {}) =>
    '0x5f3bd1c8' + pad(tokenIn) + wordN(amountIn) + pad(to) + pad(tokenOut) + wordN(minOut) + pad(fwd) + wordN(7 * 32) + bytesOf('54d61b9c' + pad(router) + pad(fIn) + pad(fOut) + pad(fTo) + wordN(5 * 32) + bytesOf(data));
  const want = { to: ME, tokenIn: ETH0, tokenOut: USDC, amount: 10n ** 17n, minOut: 1000n };
  const d = decodeSnwap(snwap());
  ok(checkSnwapCall(snwap(), want) === null && d.executor === kyber && d.router === ROUTER && d.fwdTo === ME, 'accepts a snwap of ETH through a forwarder that pays the recipient the floor');
  ok(checkSnwapCall(snwap({ tokenIn: USDC, tokenOut: ETH0, amountIn: 5n * 10n ** 6n }), { ...want, tokenIn: USDC, tokenOut: ETH0, amount: 5n * 10n ** 6n }) === null, 'accepts a token in, for exactly the asked amount');
  ok(checkSnwapCall(snwap({ tokenIn: USDC, tokenOut: ETH0, amountIn: 5n * 10n ** 6n + 1n }), { ...want, tokenIn: USDC, tokenOut: ETH0, amount: 5n * 10n ** 6n }) !== null, 'refuses a token in for another amount');
  ok(checkSnwapCall(snwap({ amountIn: 1n }), want) !== null, 'refuses ETH in that also names an amount to pull');
  ok(checkSnwapCall(snwap({ fwd: OTHER }), want) !== null, 'refuses an executor that is not an allowed forwarder');
  ok(checkSnwapCall(snwap(), { ...want, executor: Object.keys(SNWAP_EXECUTORS)[0] }) !== null, 'refuses another forwarder than the one asked for');
  ok(checkSnwapCall(snwap({ to: OTHER, fTo: OTHER }), want) !== null, 'refuses a snwap that pays someone else');
  ok(checkSnwapCall(snwap({ fTo: OTHER }), want) !== null, 'refuses a forwarder told to pay someone else than the checked recipient');
  ok([kyber, ZROUTER, '0x25fc36455aa30d012bbfb86f283975440d7ee8db'].every((x) => checkSnwapCall(snwap({ to: x }), { ...want, to: x }) !== null), 'refuses paying a forwarder, zRouter or its executor, which anyone could take from');
  ok(checkSnwapCall(snwap({ fOut: WETH }), want) !== null && checkSnwapCall(snwap({ tokenOut: WETH, fOut: WETH }), want) !== null, 'refuses another token out, in the snwap or the forwarder');
  ok(checkSnwapCall(snwap({ fIn: USDC }), want) !== null, 'refuses a forwarder told to spend another token');
  ok(checkSnwapCall(snwap({ minOut: 999n }), want) !== null && checkSnwapCall(snwap({ minOut: 0n }), { ...want, minOut: 0n }) !== null, 'refuses a floor under the one asked, and a floor of nothing');
  ok(checkSnwapCall(snwap().slice(0, -64), want) !== null && checkSnwapCall(snwap() + '00'.repeat(32), want) !== null, 'refuses a call cut short or with words added');
  ok(checkSnwapCall(snwap().replace('54d61b9c', 'deadbeef'), want) !== null, 'refuses an executor handed anything but a forwarder swap');
  ok(checkZRouterCall(snwap(), { to: ME, tokenIn: ETH0, tokenOut: USDC }) !== null, 'a snwap is never accepted as a zQuoter answer');
}

// zRouter's own choice of venue, for a caller that takes it (`sentinel`): a swapV2 with a deadline of 2^256-1 runs on SushiSwap's pool and a swapVZ with one on the
// hookless zAMM, each with a deadline of its own of 30 minutes from when it runs. Nothing else about a swap is loosened, and a caller that does not ask is refused as before.
{
  const MAXD = (1n << 256n) - 1n;
  const swapV2 = (to, exactOut, tin, tout, amt, lim, dl) => '0x6e0a4f98' + [pad(to), wordN(exactOut ? 1 : 0), pad(tin), pad(tout), wordN(amt), wordN(lim), wordN(dl)].join('');
  const swapV3 = (to, exactOut, fee, tin, tout, amt, lim, dl) => '0xafeae12b' + [pad(to), wordN(exactOut ? 1 : 0), wordN(fee), pad(tin), pad(tout), wordN(amt), wordN(lim), wordN(dl)].join('');
  const swapVZ = (to, exactOut, fee, tin, tout, amt, lim, dl) => '0x9d5b5af8' + [pad(to), wordN(exactOut ? 1 : 0), wordN(fee), pad(tin), pad(tout), wordN(0), wordN(0), wordN(amt), wordN(lim), wordN(dl)].join('');
  const mc = (calls) => {
    let head = '', body = '', off = 32 * calls.length;
    for (const c of calls) { const h = c.replace(/^0x/, ''), pd = h.padEnd(Math.ceil(h.length / 64) * 64, '0'); head += wordN(off); body += wordN(h.length / 2) + pd; off += 32 + pd.length / 2; }
    return '0xac9650d8' + wordN(32) + wordN(calls.length) + head + body;
  };
  const setWord = (cd, i, v) => cd.slice(0, 10 + i * 64) + wordN(v) + cd.slice(10 + (i + 1) * 64);
  const E0 = '0x' + '0'.repeat(40), TO = '0x' + '77'.repeat(20), USDC_ = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', DAI_ = '0x6b175474e89094c44da98b954eedeac495271d0f';
  const DL = 1893456000n, A = 10n ** 16n, L = 2n * 10n ** 19n, want = { to: TO, tokenIn: E0, tokenOut: USDC_, exactOut: false, amount: A, maxIn: A, minOut: L, deadline: DL };
  const uni = swapV2(TO, false, E0, USDC_, A, L, DL), sushi = swapV2(TO, false, E0, USDC_, A, L, MAXD), flag = { ...want, sentinel: true };

  ok(checkZRouterCall(uni, want) === null && checkZRouterCall(uni, flag) === null, 'a swapV2 with the deadline asked is accepted with the flag or without it');
  ok(/deadline/.test(checkZRouterCall(sushi, want) || '') && checkZRouterCall(sushi, { ...want, sentinel: false }) !== null && checkZRouterCall(sushi, { ...want, sentinel: 1 }) !== null, 'a swapV2 that carries the router\'s Sushi selector is refused unless the caller says sentinel: true');
  ok(checkZRouterCall(sushi, flag) === null, 'and is accepted when it does');
  ok(decodeZRouterCall(sushi)[0].deadline === MAXD && decodeZRouterCall(sushi)[0].fn === 'swapV2', 'the call that is accepted is the swapV2 with the selector itself, unchanged');
  for (const [v, why] of [[DL + 1n, 'a later deadline'], [DL - 1n, 'an earlier deadline'], [MAXD - 1n, 'one short of the selector'], [0n, 'none']]) ok(checkZRouterCall(swapV2(TO, false, E0, USDC_, A, L, v), flag) !== null, `the flag does not take ${why}`);
  const v3 = fixtures.find((f) => f.label.startsWith('ETH->PROVE exactOut=true (swapV3)')), v4 = fixtures.find((f) => f.label.startsWith('ETH->PROVE exactOut=false (swapV4)'));
  ok(checkZRouterCall(swapV3(TO, false, 500, E0, USDC_, A, L, MAXD), flag) !== null, 'a swapV3 with that deadline is refused even with the flag: it names no venue');
  ok(checkZRouterCall(setWord(v4.callData, 8, MAXD), { ...v4.want, sentinel: true }) !== null && checkZRouterCall(v4.callData, { ...v4.want, sentinel: true }) === null, 'nor a swapV4; one with the deadline asked is as before');
  ok(checkZRouterCall(setWord(v3.callData, 7, MAXD), { ...v3.want, sentinel: true }) !== null, 'nor a real swapV3');
  // the zAMM without a hook
  const vz = swapVZ(TO, false, 3000, E0, USDC_, A, L, DL), vzMax = swapVZ(TO, false, 3000, E0, USDC_, A, L, MAXD);
  ok(checkZRouterCall(vz, want) === null && checkZRouterCall(vzMax, want) !== null && checkZRouterCall(vzMax, flag) === null, 'a swapVZ with the selector (the hookless zAMM) is held and taken the same way');
  // what the flag leaves as it was
  ok(checkZRouterCall(sushi, { ...flag, to: OTHER }) !== null, 'it still refuses another recipient');
  ok(checkZRouterCall(sushi, { ...flag, tokenOut: DAI_ }) !== null && checkZRouterCall(sushi, { ...flag, tokenIn: USDC_ }) !== null, 'another token');
  ok(checkZRouterCall(sushi, { ...flag, amount: A + 1n }) !== null && checkZRouterCall(sushi, { ...flag, maxIn: A - 1n }) !== null, 'another amount, or one that can spend more than allowed');
  ok(checkZRouterCall(sushi, { ...flag, minOut: L + 1n }) !== null, 'a limit under the least asked');
  ok(checkZRouterCall(swapV2(TO, true, E0, USDC_, A, L, MAXD), flag) !== null, 'the other kind of swap');
  ok(checkZRouterCall('0x' + '5f3bd1c8' + '00'.repeat(32), flag) !== null && checkZRouterCall(sushi.slice(0, -64), flag) !== null && checkZRouterCall(sushi + '00'.repeat(32), flag) !== null, 'and anything that is not a swap, or has the wrong length');
  // chains and splits
  const wantChain = { to: TO, tokenIn: E0, tokenOut: DAI_, exactOut: false, amount: A, maxIn: A, minOut: L, deadline: DL };
  const chain = (first, second) => mc([first, second]);
  const hop1 = swapV2(ZROUTER, false, E0, USDC_, A, 1n, MAXD), hop1ok = swapV2(ZROUTER, false, E0, USDC_, A, 1n, DL), hop2 = swapV3(TO, false, 500, USDC_, DAI_, 0, L, DL), hop2max = swapV3(TO, false, 500, USDC_, DAI_, 0, L, MAXD);
  ok(checkZRouterCall(chain(hop1ok, hop2), wantChain) === null, 'a chain of a swapV2 and a swapV3 with the deadline asked is accepted (the test\'s own encoding)');
  ok(checkZRouterCall(chain(hop1, hop2), wantChain) !== null && checkZRouterCall(chain(hop1, hop2), { ...wantChain, sentinel: true }) === null, 'a chain whose first swap is on Sushi is refused, then accepted with the flag');
  ok(checkZRouterCall(chain(hop1ok, hop2max), { ...wantChain, sentinel: true }) !== null, 'but not one whose swapV3 carries the selector');
  const half = A / 2n, s1 = swapV2(TO, false, E0, USDC_, half, L / 2n, MAXD), s2 = swapV2(TO, false, E0, USDC_, half, L / 2n, DL);
  ok(checkZRouterCall(mc([s1, s2]), want) !== null && checkZRouterCall(mc([s1, s2]), flag) === null, 'a split with one leg on Sushi is refused, then accepted with the flag');
  ok(checkZRouterCall(mc([s1, swapV3(TO, false, 500, E0, USDC_, half, L / 2n, MAXD)]), flag) !== null, 'and one whose other leg is a swapV3 with the selector is not');
}

console.log(`${n} checks`);
