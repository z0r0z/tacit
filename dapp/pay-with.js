// Paying a deposit into the private ETH balance with a token (Ethereum only): zRouter sells the token for at least the deposit's ETH, paid to the zap
// (TacitEvmPoolZap), which deposits exactly the proof's amount in the same transaction and sends what the sale leaves back to the wallet. The route is
// found onchain (zQuoter through eth_call), so no outside service is asked. A token the page cannot price this way, or one whose balance moves on its own
// (stETH: a transfer can arrive a wei or two short), is not offered.

import { routeIn, routeOut, sizeIn, zapPullWith, ZAP, POOL } from '/swap/later.js?cb=3810fde5';
export { zapPullWith, ZAP };

const ZERO = '0x0000000000000000000000000000000000000000';
const NOT_OFFERED = new Set(['eth', 'tac', 'steth']);      // ETH is the deposit itself; TAC sells through its own venues (the swap card); stETH rebases

// A public node sometimes turns a heavy quote down: asked again once, a moment later, before saying there is no route.
const twice = async (f, wait = 1200) => (await f()) || (await new Promise((r) => setTimeout(r, wait)), await f());

// The token list's Ethereum rows a deposit can be paid with: { a, s, d, l }.
export const payTokens = (list) => (list || []).filter((t) => t && t.c === 1 && t.v !== false && /^0x[0-9a-fA-F]{40}$/.test(t.a) && t.a !== ZERO && Number.isInteger(t.d) && t.d >= 0 && t.d <= 36 && !NOT_OFFERED.has(String(t.s || '').toLowerCase()));

// How much of `token` pays for `depositWei` of ETH, the sale's minimum covering it at `slippageBps`: { amountIn, callData, min, out, name } or null when
// no onchain route sells it. A first quote of one whole token gives the price, which sizeIn then scales (and checks again) to the deposit.
export async function quoteDeposit({ ethCall, token, dec, depositWei, from, slippageBps = 50, deadline, route = routeIn, wait = 1200 }) {
  const d = BigInt(depositWei);
  if (d <= 0n) return null;
  const at = (amountIn) => route({ ethCall, token, amountIn, from, slippageBps, deadline }).catch(() => null);
  return twice(async () => {
    const probe = await at(10n ** BigInt(dec));
    if (!probe || !(probe.min > 0n)) return null;
    return sizeIn({ route: at, amountIn: probe.amountIn, min: probe.min, depositWei: d }).catch(() => null);
  }, wait);
}

// The most the person agreed to: what was shown, and 1% over it for the price to move before the wallet signs.
export const mostOf = (shown) => (BigInt(shown) * 101n + 99n) / 100n;

// A withdrawal received as a token (Ethereum): the pool pays `amount` of ETH into a call escrow that sells it through zRouter for at least the quote's
// minimum of `token`, paid straight to `to`, in the withdrawal's own transaction; if the sale cannot pay that, the call reverts and the ETH goes back to a
// receive box of the person's own (the intent's refund). → { r (the route: callData, min, out, name, deadline), gas } or null with no route.
// `rpc`: a JSON-RPC function for the gas estimate (the sale as the pool would send it), with a fallback when the node will not say.
export const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
export const OUT_BASE_GAS = 520_000n;
export async function quoteOut({ ethCall, rpc, token, amount, to, slippageBps = 50, deadline, route = routeOut, wait = 1200 }) {
  const a = BigInt(amount);
  if (a <= 0n) return null;
  const r = await twice(() => route({ ethCall, token, amount: a, to, slippageBps, deadline }).then((x) => (x && x.min > 0n ? x : null), () => null), wait);
  if (!r || !(r.min > 0n)) return null;
  const multi = String(r.standData || '').startsWith('0xac9650d8');
  const est = await Promise.resolve(rpc?.('eth_estimateGas', [{ from: POOL, to: ZROUTER, value: '0x' + a.toString(16), data: r.standData }])).then((g) => BigInt(g)).catch(() => null);
  const routeGas = est && est > 0n && est < 3_000_000n ? est : multi ? 700_000n : 400_000n;
  return { r, gas: Number(OUT_BASE_GAS + (routeGas * 3n) / 2n) };
}
// The call intent for it: one call, to zRouter, with the withdrawal's ETH; `refund` a receive box of the person's own, `nonce` fresh.
export const outIntent = (gw, { r, amount, refund, nonce }) => gw.callIntent({ calls: [{ target: ZROUTER, value: BigInt(amount), data: r.callData }], refund, deadline: r.deadline, nonce });
