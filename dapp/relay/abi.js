// The relay page's encodings: a proof's public values read for the fee it pays its sender, the settle() call anyone can send, an ERC-20
// transfer, and zQuoter's swap builder. Plain functions of hex, so a test can pin them.

import { checkZRouterCall, decodeZRouterCall } from '../zrouter-guard.js';

export const PROVER = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7';                  // the Succinct network requester whose credit pays every relay proof
export const PROVE = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29';                   // PROVE, 18 decimals
export const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
export const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
export const ETH = '0x0000000000000000000000000000000000000000';
export const PROVE_PER_PROOF = 0.4;                                                     // about what one proof costs (the relay counts 0.39)
export const SETTLE = '0x717fd7f2';                                                     // settle(bytes publicValues, bytes proof, bytes[] memos)
const TRANSFER = '0xa9059cbb', BALANCE_OF = '0x70a08231', BUILD_BEST_SWAP = '0xe7798987';

export const strip = (h) => String(h ?? '').replace(/^0x/, '').toLowerCase();
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => strip(a).padStart(64, '0');
const at = (hex, i) => {
  const w = hex.slice(i * 64, i * 64 + 64);
  if (w.length !== 64) throw new Error('too short');
  return BigInt('0x' + w);
};

// ── a proof's public values ──
// abi.encode(PublicValues) of the struct in contracts/src/ConfidentialPool.sol: word 0 is the tuple's offset (0x20), then one head word per field
// in declaration order, so `fees` (an offset from the tuple's start) is word 8 and `deadline` (a uint64) word 16, counting the offset as word 0.
const WORD_FEES = 8, WORD_DEADLINE = 16;
function tuple(publicValues) {
  const h = strip(publicValues);
  if (at(h, 0) !== 32n) throw new Error('not a PublicValues encoding');
  return h;
}
// The fee legs the proof binds, paid to whoever sends its settle: [{ assetId, value }], value in the pool's units (an asset's tacit decimals).
export function pvFees(publicValues) {
  const h = tuple(publicValues), off = at(h, WORD_FEES);
  if (off % 32n) throw new Error('fees offset not word aligned');
  const i = 1 + Number(off / 32n), n = Number(at(h, i));
  if (n > 64) throw new Error('too many fee legs');
  return Array.from({ length: n }, (_, k) => ({ assetId: '0x' + h.slice((i + 1 + 2 * k) * 64, (i + 2 + 2 * k) * 64), value: at(h, i + 2 + 2 * k) }));
}
// The settle deadline the proof commits to, in unix seconds (0 = none).
export const pvDeadline = (publicValues) => Number(at(tuple(publicValues), WORD_DEADLINE));

// settle(publicValues, proof, memos), for any account to send to the pool with no value.
export function settleCalldata({ publicValues, proof, memos = [] }) {
  const pad = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);
  const bytes = (hex) => word(hex.length / 2) + pad(hex);
  const pv = bytes(strip(publicValues)), pf = bytes(strip(proof)), ms = memos.map((m) => bytes(strip(m)));
  let offs = '', body = '', o = ms.length * 32;
  for (const m of ms) { offs += word(o); body += m; o += m.length / 2; }
  return SETTLE + word(96) + word(96 + pv.length / 2) + word(96 + pv.length / 2 + pf.length / 2) + pv + pf + word(ms.length) + offs + body;
}

// ── tokens ──
export const transferData = (to, amount) => TRANSFER + addr(to) + word(amount);
export const balanceOfData = (who) => BALANCE_OF + addr(who);

// ── zQuoter ──
// buildBestSwap(to, exactOut, tokenIn, tokenOut, swapAmount, slippageBps, deadline) → (Quote{source,feeBps,amountIn,amountOut}, bytes callData,
// uint256 amountLimit, uint256 msgValue): the call to send to zRouter, with `to` as the recipient of what it buys and amountLimit the least it may.
export const buildBestSwapData = ({ to, tokenIn, tokenOut, amount, slippageBps, deadline, exactOut = false }) =>
  '0x' + BUILD_BEST_SWAP.slice(2) + addr(to) + word(exactOut ? 1 : 0) + addr(tokenIn) + addr(tokenOut) + word(amount) + word(slippageBps) + word(deadline);
export function decodeBestSwap(raw) {
  const h = strip(raw);
  if (h.length < 7 * 64) return null;
  const amountIn = at(h, 2), amountOut = at(h, 3), o = Number(at(h, 4)) / 32, len = Number(at(h, o));
  const callData = '0x' + h.slice((o + 1) * 64, (o + 1) * 64 + len * 2);
  if (callData.length !== 2 + len * 2) return null;
  return { amountIn, amountOut, callData, amountLimit: at(h, 5), msgValue: at(h, 6) };
}

// ── ETH to PROVE ──
// The swap every page offers for adding PROVE: ETH in, PROVE out to `to`. `call({ to, data, gas })` is an eth_call returning hex (a revert
// carries `.revert`), so each page reads through its own nodes.
export const SLIPPAGE_BPS = 100n;                                                       // the least a swap may buy: 1% under its quote
const QUOTE_GAS = '0x5f5e100';
const NO_ROUTE = 'No route from ETH to PROVE was found. Try again in a moment, or add PROVE.';
// `now`: the chain's time in seconds where the page keeps it (a device clock that runs slow would otherwise set a deadline already past)
const deadlineIn = (secs, now) => BigInt((now ?? Math.floor(Date.now() / 1000)) + secs);
// zQuoter's best route from `wei` of ETH to PROVE for the recipient `to`, checked before it is shown or sent: it spends exactly what was asked,
// pays `to`, and guards a least amount out. → { wei, amountIn, amountOut, amountLimit, msgValue, callData, at, router }
export async function quoteEthToProve({ call, to, wei, slippageBps = SLIPPAGE_BPS, noRoute = NO_ROUTE, now }) {
  wei = BigInt(wei);
  const deadline = deadlineIn(600, now);
  const data = buildBestSwapData({ to, tokenIn: ETH, tokenOut: PROVE, amount: wei, slippageBps, deadline });
  let q;
  try { q = decodeBestSwap(await call({ to: ZQUOTER, data, gas: QUOTE_GAS })); }
  catch (e) { throw new Error(e?.revert ? noRoute : 'Could not read a quote.'); }
  if (!q || q.amountOut <= 0n) throw new Error(noRoute);
  // The bytes run as the sender: one swap of exactly `wei` of ETH into PROVE for `to`, with the guard the quote names.
  const mismatch = q.msgValue !== wei || q.amountLimit <= 0n || q.amountLimit > q.amountOut
    || checkZRouterCall(q.callData, { to, tokenIn: ETH, tokenOut: PROVE, exactOut: false, amount: wei, maxIn: wei, minOut: q.amountLimit, deadline }) !== null
    || decodeZRouterCall(q.callData)[0].limit !== q.amountLimit;
  if (mismatch) throw new Error('The quote did not match what was asked, so nothing will be sent.');
  return { wei, ...q, at: Date.now(), router: ZROUTER };
}
// The ETH to pay so that a swap buys at least `want` PROVE (its guard included), for the same quote quoteEthToProve gives. zQuoter prices `want`
// out first, for sizing only: sent as it is, an exact-out swap spends all of its maximum (the price plus the guard) and refunds none of it. The ETH
// is then quoted in, `headroomBps` over that price, so the least the swap may buy still covers `want` and the extra stays in the account as PROVE.
// Rounded up to a millionth of an ETH; a price that moves between the two reads is followed for up to two more.
const STEP = 10n ** 12n;
const roundUp = (v) => ((v + STEP - 1n) / STEP) * STEP;
export async function ethForProve({ call, to, want, headroomBps = 150n, slippageBps = SLIPPAGE_BPS, noRoute = NO_ROUTE, now }) {
  want = BigInt(want);
  if (want <= 0n) throw new Error('Enter how much PROVE to add.');
  const data = buildBestSwapData({ to, tokenIn: ETH, tokenOut: PROVE, amount: want, slippageBps, deadline: deadlineIn(600, now), exactOut: true });
  let size;
  try { size = decodeBestSwap(await call({ to: ZQUOTER, data, gas: QUOTE_GAS })); }
  catch (e) { throw new Error(e?.revert ? noRoute : 'Could not read a quote.'); }
  if (!size || size.amountOut !== want || size.amountIn <= 0n) throw new Error(noRoute);
  let wei = roundUp(size.amountIn * (10000n + BigInt(headroomBps)) / 10000n);
  for (let i = 0; i < 3; i++) {
    const q = await quoteEthToProve({ call, to, wei, slippageBps, noRoute, now });
    if (q.amountLimit >= want) return q;
    wei = roundUp(wei * want * 1005n / (q.amountLimit * 1000n));
  }
  throw new Error('The price moved while this was worked out. Try again.');
}

// ── what a job is, in words ──
const TYPES = {
  wrap: 'Making a deposit private', unwrap: 'A withdrawal', sendunwrap: 'A send to a public address', transfer: 'A private send', batchtransfer: 'Private sends',
  wraptransfer: 'A deposit sent privately', swap: 'A private swap', route: 'A private swap', wrapswap: 'A deposit swapped privately', lp: 'Adding to a private pool',
  wraplp: 'A deposit added to a private pool', lpbond: 'Joining a farm', lpremove: 'Leaving a private pool', farmbond: 'Joining a farm', farmharvest: 'A farm harvest',
  farmunbond: 'Leaving a farm', otc: 'A private trade', bid: 'A bid', bridgeburn: 'A bridge to Bitcoin', bridgemint: 'A bridge from Bitcoin', bridgestealthmint: 'A bridge from Bitcoin',
  stealthlock: 'A private payment', stealthlockbatch: 'Private payments', stealthclaim: 'A payment claimed', stealthrefund: 'A payment refunded',
  adaptorlock: 'A swap lock', adaptorclaim: 'A swap claim', adaptorrefund: 'A swap refund', cdpmint: 'A loan opened', wrapcdpmint: 'A loan opened', cdpclose: 'A loan closed',
  cdpliquidate: 'A loan liquidated', cdptopup: 'A loan topped up', cbtcmint: 'cBTC minted', fastlane: 'A fast exit',
};
export const typeWords = (t) => TYPES[String(t || '').toLowerCase()] || (t ? `A settle (${String(t).slice(0, 24)})` : 'A settle');
