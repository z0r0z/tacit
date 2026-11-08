// "Swap privately" on the swap card: the wallet's ETH is deposited now into the private ETH pool (TacitEvmPool, proved on this device, the pool
// /pay/eth and anon.wei use), with an extra amount on top so the deposit is not the swap; later, after other deposits have landed, a withdrawal
// pays exactly the swap's ETH into a call intent's escrow (router.withdrawAndCall) whose one call swaps it on zRouter and pays the token to the
// address given, so nothing on chain ties the deposit to where the token goes. The pool's keeper sends the withdrawal (no wallet is seen); the
// signer can send it instead. What is left of the deposit stays a private note in the pool. Each swap's plan is kept in this browser until done.
// A wallet that starts from a token (any listed token, or TAC) deposits through the zap (TacitEvmPoolZap): one transaction sells the token on
// zRouter for exactly the deposit's ETH and deposits it with this device's proof; from there the swap is the same. (The TAC pool deployed with
// the TAC vaults could hold TAC itself, but nothing is in it yet and no keeper sends for it, so a hop through it would hide nothing.)
import { hexToBytes, keccak_256 } from '/vendor/tacit-deps.min.js';
import { ETH_NODES } from '/eth-nodes.js';
import { calmText } from '/relay-outcome.js?cb=9db7155a';
import { bestRoute } from '/swap/aggregate.js?cb=a7a503af';
import { checkRoute, readAccess, readToken, permitTyped, permit2Typed, splitSig, randomNonce as permit2Nonce, encApprove, quoteTacitToToken, buildTacitToToken, quoteAnyToTac, buildAnyToTac } from '/swap/route.js?cb=45fd31f8';
import { makeTokenPools, poolState, RELAYER, KEEPERS, SERVED } from '/evm-pool-tokens.js?cb=a3c182f7';
export { SERVED };

export const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
export const CHAIN = { chainId: 1, rpc: ETH_NODES,
  keeper: 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', deployBlock: 26069245, confirmations: 3 };
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', DAI = '0x6b175474e89094c44da98b954eedeac495271d0f', PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// TacitEvmPoolZap: shields a token into the ETH pool above in one transaction (contracts/src/TacitEvmPoolZap.sol; docs/EVM-POOL.md)
export const ZAP = '0x0000008EbBF2323f95c4fBc18254f3D65C53998c';
const PLANS_KEY = 'tacit-swap-later-v1', ARTIFACT_CACHE = 'tacit-evm-pool-artifacts-v1';
// The token pools a swap here has gone through (dapp/evm-pool-tokens.js): kept so the front page shows what is left in them, and lets it out.
export const TOKEN_POOLS_KEY = 'tacit-token-pools-v1';
// No token pool under these salts is older than this block, where a wallet reads one from (the fixed pools carry their own first block).
const TOKEN_POOLS_FROM = 26262000;
const lc = (s) => String(s || '').toLowerCase();
const word = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// The router's event for a call that ran, with the call's escrow as its first topic: how a plan knows its swap went out
const CALL_EXECUTED = '0x' + hexOf(keccak_256(new TextEncoder().encode('CallExecuted(address,address)')));
// How long the swap's route may take to run once quoted, and the gas the relay is asked to price beyond the route's own: the withdrawal and its escrow.
const DEADLINE_S = 1200, BASE_GAS = 520_000n;
// How long a deposit from the wallet that the pool does not show yet is still looked for, before the plan is called stopped.
const LATE_MS = 30 * 60e3;
// The swap card keeps no ETH-pool note worth less than a millionth of an ETH (see makeEvmPoolWallet's dustFloor): none is worth spending, and dust paid to a public address would otherwise grow what this device saves and reads.
const DUST_ETH = 10n ** 12n;
// The router's deposit intent (a static tuple, so it sits in a call's head as it is) and the two reasons its reclaim refuses
const DEPOSIT_TUPLE = ['uint256', 'uint256', 'uint256', 'bytes32', 'bytes32', 'address', 'uint64', 'uint256'], DEPOSIT_SIG = `(${DEPOSIT_TUPLE.join(',')})`;
const errSel = (sig) => '0x' + hexOf(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const NOT_EXPIRED = errSel('NotExpired()'), NOTHING_TO_RECLAIM = errSel('NothingToReclaim()');
const revertData = (e) => { for (let x = e; x; x = x.cause) { const d = x.rpc?.data?.data ?? x.rpc?.data ?? x.data?.data ?? x.data; if (typeof d === 'string' && d.startsWith('0x')) return d.toLowerCase(); } return ''; };

// The plans kept in this browser: amounts, the token, the address it goes to, the deposit and swap transactions, and (while one waits) the wallet
// that deposited, so a swap out is never sent from it; that is dropped once the swap is done.
export const readPlans = (store = globalThis.localStorage) => { try { return (JSON.parse(store.getItem(PLANS_KEY) || '[]') || []).filter((p) => p && p.id).slice(0, 20); } catch { return []; } };
// Twenty are kept, the oldest finished ones leaving first and then the oldest stopped, so a swap still waiting is not pushed out by newer ones. → whether the browser kept them
const trimPlans = (ps) => { const out = ps.slice(); for (const gone of ['done', 'stopped']) for (let i = out.length - 1; i >= 0 && out.length > 20; i--) if (out[i].state === gone) out.splice(i, 1); return out.slice(0, 20); };
const keepPlans = (ps, store = globalThis.localStorage) => { try { store.setItem(PLANS_KEY, JSON.stringify(trimPlans(ps))); return true; } catch { return false; } };

// The route for `amount` wei of ETH into `token`, paid to `to`, asked of the nodes with a random stand-in in place of `to` (so no node sees where
// the tokens go), then written with `to` and held to the guard again: exactly the ETH it is sent, the token to `to`, at least its floor.
export async function routeOut({ ethCall, token, amount, to, slippageBps, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = '0x' + hexOf(random(20)), q = await bestRoute({ ethCall, to: stand, refundTo: stand, tokenIn: ZERO, tokenOut: token, amountIn: amount, slippageBps, deadline });
  if (!q) return null;
  const data = q.callData.split(word(stand)).join(word(to));
  if (data === q.callData) return null;
  if (checkRoute(data, { to, tokenIn: ZERO, tokenOut: token, exactOut: false, amount, maxIn: amount, minOut: q.min, deadline, curvePools: q.curvePools || [] }) !== null) return null;
  // `standData`: the route as the nodes saw it, for any later read (a gas estimate) that should not name `to` either
  return { ...q, callData: data, standData: q.callData, to };
}
// The route for `amount` wei of ETH into TAC, paid to `to`: the Precision pool or the Tacit pool, as the swap page's own ticket picks between
// them (`venues`, evm-trade-venues.js), built here as zRouter's own calls with `to` as the recipient, the escrow's ETH as the value and the floor
// asked. zQuoter does not route TAC, and the guard reads only zRouter's swaps, so this is checked another way: the same calls built for a random
// stand-in must differ from the real ones in nothing but that address, and the stand-in's copy is what any later read (a gas estimate) sees.
export async function routeOutTac({ venues, amount, to, slippageBps, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  if (!venues) throw new Error('TAC swaps need the page\'s venues.');
  const rt = await venues.route({ dir: 'ETH_TO_TAC', amountIn: BigInt(amount) });
  const q = rt?.single;
  if (!q || (q.venue !== 'precision' && q.venue !== 'tacit-amm') || BigInt(q.amountIn) !== BigInt(amount)) return null;      // the Tacit pool trims an amount to its unit: dust would stay with zRouter
  const min = (BigInt(q.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
  if (min <= 0n) return null;
  const mk = (rcpt) => venues.build({ quote: q, dir: 'ETH_TO_TAC', account: rcpt, to: rcpt, minOut: min, deadline: BigInt(deadline) });
  const stand = '0x' + hexOf(random(20)), real = mk(to), copy = mk(stand);
  if (lc(real.to) !== lc(ZROUTER) || BigInt(real.value || 0) !== BigInt(amount) || real.approval) return null;
  if (copy.data === real.data || copy.data.split(word(stand)).join(word(to)) !== real.data) return null;
  return { kind: 'tac', callData: real.data, standData: copy.data, min, out: BigInt(q.amountOut), amountIn: BigInt(q.amountIn), name: q.venue === 'precision' ? 'Precision pool' : 'Tacit pool', to, deadline: BigInt(deadline) };
}
// The deposit's route for a token: `amountIn` of it sold on zRouter for ETH paid to the zap, which deposits the ETH with this device's proof in
// the same transaction. A listed token goes by zQuoter's best route, held to the guard by bestRoute (exactly `amountIn`, the zap paid, at least
// its floor); TAC, which zQuoter does not route, by the Precision pool, built as zRouter's calls (the Tacit pool's own door is not a zRouter call,
// so it cannot run inside the zap). `from` gets back what a route leaves unspent. → { callData, out, min, name, amountIn } or null.
export async function routeIn({ ethCall, venues, token, amountIn, from, slippageBps = 50, deadline }) {
  const amt = BigInt(amountIn);
  if (lc(token) === TAC) {
    if (!venues) throw new Error('TAC swaps need the page\'s venues.');
    const q = (await venues.route({ dir: 'TAC_TO_ETH', amountIn: amt, account: from }))?.r?.precision;
    if (!q || BigInt(q.amountIn) !== amt) return null;
    const out = BigInt(q.amountOut), min = (out * BigInt(10000 - slippageBps)) / 10000n;
    if (min <= 0n) return null;
    const tx = venues.build({ quote: q, dir: 'TAC_TO_ETH', account: from, to: ZAP, minOut: min, deadline: BigInt(deadline) });
    if (lc(tx.to) !== lc(ZROUTER) || BigInt(tx.value || 0) !== 0n || !lc(tx.data).includes(word(ZAP))) return null;
    return { callData: tx.data, out, min, name: 'Precision pool', amountIn: amt };
  }
  const q = await bestRoute({ ethCall, to: ZAP, refundTo: from, tokenIn: token, tokenOut: ZERO, amountIn: amt, slippageBps, deadline });
  return q && q.min > 0n ? { callData: q.callData, out: q.out, min: q.min, name: q.name, amountIn: amt } : null;
}
// The amount of a token whose route pays the zap at least `depositWei`: `amountIn` (whose route's floor is `min`) scaled up to the deposit with
// a little over, and asked again while its floor still falls short (a route pays less per token as it grows). → that route, or null.
export async function sizeIn({ route, amountIn, min, depositWei, tries = 3 }) {
  let a = BigInt(amountIn), m = BigInt(min);
  const d = BigInt(depositWei);
  if (a <= 0n || m <= 0n || d <= 0n) return null;
  for (let i = 0; i < tries; i++) {
    a = (a * d * 10020n + m * 10000n - 1n) / (m * 10000n);
    const r = await route(a);
    if (!r) return null;
    if (r.min >= d) return r;
    m = r.min;
  }
  return null;
}
// A token start whose gas the relay pays (no ETH in the wallet, or the token or TAC chosen): the gas relay's order sells the token for ETH straight into a deposit
// box of the ETH pool for this key, and the pool's keeper completes the box into the deposit's note. The box holds exactly what the plan's deposit needs (the note and
// the keeper's fee for completing it), so the token sold is sized to its route's expected output, a little over, not to a floor: the order's signed minimum is the box's
// amount, and what the sale pays above it stays in the box, refundable to the key's own address after its deadline.
// The gas a keeper that does not say what it prices a deposit box's completion at is asked to quote for: its default (EVM_POOL_KEEPER_DEPOSIT_GAS, 500,000). A keeper that
// does says it, with its fee (`depositFee` on its /quote), and that is the fee used.
export const BOX_GAS = 500_000;
// The least fee a keeper takes for completing a deposit box, from its /quote: its own `depositFee`, else its quote for BOX_GAS. → wei as a string, or null
export const depositFeeOf = (q) => [q?.depositFee, q?.fee].map((x) => String(x ?? '')).find((x) => /^\d+$/.test(x)) ?? null;
// What the sale's expected output may fall short of the box by before the order's minimum refuses it (the order reverts, nothing is spent), in basis points.
export const BOXED_MARGIN_BPS = 40n;
// The keeper's fee for completing a box, a half over its quote so a rise in gas before it is completed does not strand the box. → wei
export const boxFeeOf = (quoted) => (BigInt(quoted) * 3n) / 2n;
// The amount of a token whose sale is expected to pay `needWei` of ETH with the margin to spare: `amountIn` (whose route is expected to pay `out`) scaled to it, and
// asked again while its expected output still falls short (a route pays less per token as it grows). `route(amount)` → { out, … } or null. → that route with its
// `amountIn`, or null.
export async function sizeBoxed({ route, amountIn, out, needWei, tries = 3 }) {
  let a = BigInt(amountIn), o = BigInt(out);
  const keep = 10000n - BOXED_MARGIN_BPS, want = (BigInt(needWei) * 10000n + keep - 1n) / keep;
  if (a <= 0n || o <= 0n || want <= 0n) return null;
  for (let i = 0; i < tries; i++) {
    a = (a * want * 10005n + o * 10000n - 1n) / (o * 10000n);
    const r = await route(a);
    if (!r) return null;
    if (BigInt(r.out) >= want) return { ...r, amountIn: a };
    o = BigInt(r.out);
  }
  return null;
}
// The swap's ETH, from what a token's route into the pool pays: three significant figures, rounded down (the rest stays in the pool with the
// buffer), so the swap out is no exact image of the deposit.
export const swapOf = (wei) => { const v = BigInt(wei), unit = 10n ** BigInt(Math.max(0, v.toString().length - 3)); return (v / unit) * unit; };
// What a swap that starts from a token comes to, for the card: `amountIn` of `pay` sold for ETH by the route into the pool, and the swap's share
// of that ETH sold for `get` on the way out (ETH itself when `get` is ETH), each quoted for a random stand-in, so no node is shown the wallet or
// the address. → { r0 (the route in), ethWei (the swap), r1 (the route out) } or null.
export async function quoteThrough({ ethCall, venues, pay, get, amountIn, slippageBps = 50, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = () => '0x' + hexOf(random(20));
  const r0 = await routeIn({ ethCall, venues, token: pay, amountIn, from: stand(), slippageBps, deadline });
  if (!r0) return null;
  const x = swapOf(r0.out);
  if (x <= 0n) return null;
  const r1 = lc(get) === ZERO ? { out: x, min: x, name: 'ETH' }
    : lc(get) === TAC ? await routeOutTac({ venues, amount: x, to: stand(), slippageBps, deadline, random })
      : await routeOut({ ethCall, token: get, amount: x, to: stand(), slippageBps, deadline, random });
  return r1 ? { r0, ethWei: x, r1 } : null;
}
// A wallet's own stop (declined in the wallet), as against a signature that would not check out.
// The token pools' creation code, fetched once, from which a token's pool and router are found (a test hands its own to makeLater).
let TP = null;
export const tokenPools = () => (TP ||= globalThis.fetch('/evm-pool/token-pool-code.json').then((r) => { if (!r.ok) throw new Error(`token pools: HTTP ${r.status}`); return r.json(); })
  .then((code) => makeTokenPools({ code, keccak256: keccak_256 })).catch((e) => { TP = null; throw e; }));
// The route that sells `amount` of a token pool's token (`tokenIn`) for `token` (ETH as the zero address), paid to `to`, from a withdrawal's
// escrow (it approves zRouter for exactly `amount`): asked of the nodes with a random stand-in in place of `to`, then written with `to`.
// zQuoter's best route held to the guard, or where TAC is on either side, the swap page's own routes through the Precision pool.
// → { callData, standData, min, out, name, deadline } or null.
export async function routeFrom({ ethCall, venues, tokenIn, token, amount, to, slippageBps = 50, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = '0x' + hexOf(random(20)), amt = BigInt(amount), dl = BigInt(deadline), write = (d) => d.split(word(stand)).join(word(to));
  let q = null;
  // A Precision route from a token is checkpointed: PrecisionRoute holds the call to a hash of its route, which names the recipient, so the
  // stand-in cannot be written over afterwards. It is quoted for the stand-in (the node sees no more), and the call built here, for the address.
  if (lc(tokenIn) === TAC && lc(token) === ZERO) {
    // TAC for ETH: the Precision pool, as the deposit's own route in reverse, paying the address
    const rt = (await venues.route({ dir: 'TAC_TO_ETH', amountIn: amt, account: stand }))?.r?.precision;
    if (!rt || BigInt(rt.amountIn) !== amt) return null;
    const min = (BigInt(rt.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
    const build = (who) => venues.build({ quote: rt, dir: 'TAC_TO_ETH', account: who, to: who, minOut: min, deadline: dl });
    const tx = build(stand), real = build(to);
    if ([tx, real].some((t) => lc(t.to) !== lc(ZROUTER) || BigInt(t.value || 0) !== 0n)) return null;
    return { callData: real.data, standData: tx.data, min, out: BigInt(rt.amountOut), name: 'Precision pool', deadline: dl };
  } else if (lc(tokenIn) === TAC) {
    const r = await quoteTacitToToken({ ethCall, venues, tokenIn, tokenOut: token, amountIn: amt, account: stand, to: stand, slippageBps, deadline: dl });
    if (!r || r.amountIn !== amt) return null;
    q = { callData: buildTacitToToken({ quote: r, account: stand, to: stand, venues, access: { kind: 'approved' } }).data, min: r.min, out: r.out, name: r.hop ? `Precision pool → ${r.hop.name}` : 'Precision pool' };
  } else if (lc(token) === TAC) {
    const r = await quoteAnyToTac({ ethCall, venues, token: tokenIn, amountIn: amt, account: stand, slippageBps, deadline: dl });
    if (!r) return null;
    const min = (BigInt(r.tacOut) * BigInt(10000 - slippageBps)) / 10000n;
    const build = (who) => buildAnyToTac({ quote: r, account: who, to: who, minOut: min, keccak256: keccak_256, access: { kind: 'approved' } }).data;
    return { callData: build(to), standData: build(stand), min, out: BigInt(r.tacOut), name: r.hop ? `${r.hop.name} → Precision pool` : 'Precision pool', deadline: dl };
  } else {
    const r = await bestRoute({ ethCall, to: stand, refundTo: stand, tokenIn, tokenOut: token, amountIn: amt, slippageBps, deadline: dl });
    if (!r) return null;
    const data = write(r.callData);
    if (data === r.callData || checkRoute(data, { to, tokenIn, tokenOut: token, exactOut: false, amount: amt, maxIn: amt, minOut: r.min, deadline: dl, curvePools: r.curvePools || [] }) !== null) return null;
    return { callData: data, standData: r.callData, min: r.min, out: r.out, name: r.name, deadline: dl };
  }
  const data = write(q.callData);
  if (data === q.callData) return null;
  return { ...q, callData: data, standData: q.callData, deadline: dl };
}
const declined = (e) => e?.code === 4001 || e?.userStopped || e?.name === 'UserStopped' || /reject|denied|cancel/i.test(String(e?.message || ''));
// USDT's allowance is set to zero before it is raised, a transaction of its own: an error from the step after it says that was sent (`zeroed`, for a page that words a decline itself).
const afterReset = (e) => {
  try { if (e && typeof e === 'object') { e.zeroed = 'USDT'; if (typeof e.message === 'string' && !/allowance was set to zero/.test(e.message)) e.message += ' Your USDT allowance was set to zero first; nothing else was sent.'; } } catch { /* a frozen error keeps its words */ }
  return e;
};
// `fn` called one at a time, in the order asked: the prover holds a wasm heap for each thread it proves with, so two proofs at once slow each other and
// can run a small device out of memory.
export function oneAtATime(fn) {
  let tail = Promise.resolve();
  return (...args) => { const run = tail.then(() => fn(...args)); tail = run.catch(() => {}); return run; };
}

// A deposit that is not an amount of its own: the swap, the relay's fee twice and an extra (the slider's share of the swap, drawn at random
// between three quarters and one and a quarter of it, never under a twentieth), rounded up to two significant figures.
// `gasWei`: for a swap into a private balance, the gas the key's own account is handed with the TAC, to make it private from there.
export function depositFor({ swapWei, feeWei, pct, rand = Math.random, gasWei = 0n }) {
  const swap = BigInt(swapWei), share = Math.max(5, Math.round(pct * (0.75 + rand() * 0.5))), fixed = 2n * BigInt(feeWei) + BigInt(gasWei);
  const total = swap + fixed + (swap * BigInt(share)) / 100n;
  const unit = 10n ** BigInt(Math.max(0, total.toString().length - 2)), dep = ((total + unit - 1n) / unit) * unit;
  return { depositWei: dep, extraWei: dep - swap - fixed };
}
// The largest swap whose deposit (as depositFor draws it, with the same draw) is at most `capWei`: the cap is rounded down to two significant
// figures, so the total under it rounds up to no more than it.
export function swapFor({ capWei, feeWei, pct, rand = Math.random, gasWei = 0n }) {
  const cap = BigInt(capWei), share = Math.max(5, Math.round(pct * (0.75 + rand() * 0.5))), fixed = 2n * BigInt(feeWei) + BigInt(gasWei);
  const unit = 10n ** BigInt(Math.max(0, cap.toString().length - 2)), top = (cap / unit) * unit;
  return top > fixed ? ((top - fixed) * 100n) / (100n + BigInt(share)) : 0n;
}
// The most a pool balance can swap out: what is left of it after the relay's fee, set aside twice as a deposit sets it.
export const heldSwapMax = (balance, feeWei) => { const b = BigInt(balance), keep = 2n * BigInt(feeWei); return b > keep ? b - keep : 0n; };
const randomNonce = () => BigInt('0x' + hexOf(crypto.getRandomValues(new Uint8Array(16))));
// What the relay's answer leaves open: the swap out may have been sent (no answer, or no receipt in time), so it is checked before another.
// (A read that timed out is not here: the price and the fee are read before anything is built or sent, and a wait on an earlier transaction ends before this one.)
const unsure = (e) => /may still have sent|did not answer|already on its way|waiting for it to be mined|already spent|kept moving/i.test(String(e?.message || e));
// What a deposit's failure says when nothing went: a refusal, a wallet that declined, or the check before the wallet that found it would revert.
const notSent = (e) => /cancel|rejected|denied|nothing was sent|would revert|does not send calls together|could not check/i.test(String(e?.message || e));
// Digits of a base-unit amount for a message (a token's own decimals), not the raw integer.
const units = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'), f = s.slice(s.length - d).replace(/0+$/, ''); return s.slice(0, s.length - d) + (f ? `.${f.slice(0, 6)}` : ''); };
// What a deposit box is made for, of the floor its swap is sure to pay: what the swap pays above it stays in the box, to be reclaimed after its deadline.
const BOX_MARGIN = 997n;
// A refusal by the relay itself (nothing sent): the one case a swap out may be sent from a wallet instead.
// (the keeper's own words for a relay that will not send: busy, cannot price the token's fee, today's gas spent, relaying off, a gas cap; the first three also say the wallet works)
const refused = (e) => /relay(er)? returned|relay could not|cannot front|too low|fee went up|is full|refus|own wallet|relaying is off|price its fee|used today|gas above/i.test(String(e?.message || e));

// Names a token's open pool to the relay (POST /token-pools), which keeps it and serves it: a listed token's at once, any other's on a day's
// allowance of gas. Plain text, so the browser sends it without asking first. → the relay's answer ({ status, serving, … }) or null
export async function notifyPool(token, get = globalThis.fetch, keepers = KEEPERS) {
  const r = await get(`${keepers}/token-pools`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(20_000) });
  return r.ok ? r.json().catch(() => null) : null;
}
// The gas a swap out of a token pool is quoted and sent with: the withdrawal, its escrow's approval and the route.
export const HOP_GAS = BASE_GAS + 900_000n;
// (A deposit box into another pool is also priced at HOP_GAS, though its completion uses about a third of that: the keeper completes a box only while the fee still covers its gas at the
// price then, and a box it will not complete is not reclaimed unless the keeper's reclaim is on, so the extra is the margin against a rise in gas between the swap and the completion.)
// The keeper's fee for a withdrawal into a swap, read without a key (the card quotes the deposit before the key is open). → wei, or for a
// token pool's keeper (`keeper`, its route; `pool`, the pool it must answer for) the token's base units.
export async function relayFee(gas = Number(BASE_GAS + 400_000n), get = globalThis.fetch, keeper = CHAIN.keeper, pool = null) {
  const r = await get(`${keeper}/quote?gas=${gas}`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !/^\d+$/.test(String(j.fee ?? '')) || (pool && lc(j.pool) !== lc(pool))) throw new Error('The relay could not quote its fee right now. Try again in a moment.');
  return BigInt(j.fee);
}
// The keeper's fee for completing a deposit box, read the same way (see depositFeeOf). → wei
export async function depositFee(get = globalThis.fetch, keeper = CHAIN.keeper) {
  const r = await get(`${keeper}/quote?gas=${BOX_GAS}`, { signal: AbortSignal.timeout(10_000) });
  const least = depositFeeOf(await r.json().catch(() => ({})));
  if (!r.ok || least == null) throw new Error('The relay could not quote its fee right now. Try again in a moment.');
  return BigInt(least);
}

// `keyHex()` opens the Tacit key and gives its private key (hex); `signer` sends from the connected wallet ({ address, ready, send, rpc }, and for
// a deposit from a token `signTyped(typed)` for a permit, `receipt(hash)` for an approval it waits on, `canBatch()` and `batch(calls, sent)` for an
// approval and the zap in one confirmation);
// `ethCall(to, data, block, { gas })` is the page's (zQuoter's scans need a node that allows a large call).
// `chain` and `prove` are for tests (another chain's nodes and keeper, a prover that needs no worker).
// `venues` is the swap page's evm-trade-venues instance, for a swap into TAC; `ux()` gives the pool module (confidential-pool-ux.js) and
// `sendPrivate` the page's send of a private note to a Tacit address (swap/private.js), both for a swap that ends in a private balance.
// `tokens` (a makeTokenPools instance), `chain.keepers` (the keeper service's base) and `chain.tokenRelayer` (its address) are for tests, as
// `chain` is.
export function makeLater({ keyHex, signer, ethCall, venues = null, ux = null, sendPrivate = null, store = globalThis.localStorage, chain = CHAIN, prove: proveWith = null, tokens = null, walletOf = null, routes = {}, knows = null, callRan = null, now = Date.now }) {
  // `walletOf(hop)`, `routes` ({ routeOut, routeFrom, routeOutTac }) and `knows(hash)` (→ true, false or undefined) and `callRan(plan)` (→ { tx }, null or undefined) are for tests: a pool's wallet, the swap routes and the chain's receipts without a chain
  // `now()` is the time in ms the deadlines are counted from: the card passes the chain's, so a device clock that is slow cannot make them past
  const rt = { routeOut, routeFrom, routeOutTac, ...routes };
  const secs = () => Math.floor(now() / 1000);
  let modsP = null, proverP = null, rpc = null, keyAddr = null;
  const wallets = new Map();      // pool → the key's wallet for it (the ETH pool's, and each token pool a swap goes through)
  // A plan's destination: { kind: 'address' } pays `to`; { kind: 'me' } pays the key's own Tacit account and makes the TAC private there;
  // { kind: 'tacit', pubHex, name } does that and sends the note on to that Tacit address. Only TAC is a pool asset this flow makes private.
  const poolDest = (plan) => !!plan?.dest && plan.dest.kind !== 'address';
  // The key's own Tacit account: the Ethereum account the pool module derives from the key alone (nothing but the key knows it), from which it
  // deposits into the private pool. The TAC lands there first, with the gas to make it private.
  async function tacitAccount() {
    if (!ux) throw new Error('A private destination needs the pool module.');
    const t = await ux(), priv = hexToBytes(await keyHex());
    const tk = t.assetByTicker.TAC ? 'TAC' : 'cTAC', meta = t.assetByTicker[tk];
    if (!meta?.assetId) throw new Error('TAC is not a pool asset on this network.');
    return { t, priv, acct: t.account(priv), tk, meta };
  }
  const prover = { ms: null, ready: false };
  const mods = () => (modsP ||= (async () => {
    const [zkm, wm, gw, pm, pos] = await Promise.all([import('/evm-pool-zk.js'), import('/evm-pool-wallet.js?cb=815abda7'), import('/evm-pool-gateway.js'), import('/evm-pool-zk-prover.js?cb=00ff69c2'), import('/vendor/tacit-poseidon.min.js')]);
    const PO = { 2: pos.poseidon2, 3: pos.poseidon3, 4: pos.poseidon4, 5: pos.poseidon5, 7: pos.poseidon7 };
    return { zk: zkm.makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) }), wm, gw, vkHash: pm.vkHash };
  })().catch((e) => { modsP = null; throw e; }));

  // The ceremony's proving key and circuit, fetched once (kept in the cache /pay/eth keeps them in, so either page's download serves the other)
  // and checked against their pinned hashes, then loaded into a worker that stays warm: what makes the proof start the moment the swap is sent.
  async function artifact(name, sha) {
    const url = '/evm-pool/' + name, key = `${url}?sha256=${sha}`;
    let cache = null; try { cache = await caches.open(ARTIFACT_CACHE); } catch { }
    const hit = cache ? await cache.match(key).catch(() => null) : null;
    const bytes = new Uint8Array(await (hit || await fetch(url).then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r; })).arrayBuffer());
    if (hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== lc(sha).replace(/^0x/, '')) { if (hit) await cache.delete(key).catch(() => {}); throw new Error(`${name} does not match the ceremony’s pinned hash`); }
    if (!hit && cache) await cache.put(key, new Response(bytes)).catch(() => {});
    return bytes;
  }
  function warm() {
    if (proveWith) return Promise.resolve(proveWith);
    return (proverP ||= (async () => {
      const [{ vkHash }, p] = await Promise.all([mods(), fetch('/evm-pool/pin.json', { cache: 'no-store' }).then((r) => r.json())]);
      const [vkB, wasm, zkey] = await Promise.all([artifact(p.vk, p.vk_sha256), artifact(p.wasm, p.wasm_sha256), artifact(p.zkey, p.zkey_sha256)]);
      const vk = JSON.parse(new TextDecoder().decode(vkB));
      if (vkHash(vk) !== lc(p.vk_hash).replace(/^0x/, '')) throw new Error('The verification key does not match the ceremony pin.');
      const worker = new Worker('/evm-pool-prove-worker.js?cb=7f41e5e0', { type: 'module' });
      let id = 0; const waiting = new Map();
      worker.onmessage = ({ data }) => { const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
      // A worker that stopped is ended and the next try starts a new one: the page's memory is not held by a second worker beside a dead one.
      const stop = (why) => { worker.terminate?.(); for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); proverP = null; prover.ready = false; };
      worker.onerror = (ev) => { ev.preventDefault?.(); stop('Proving stopped on this device, likely short of memory. Close other tabs and try again.'); };
      // A load or a proof that has not answered in this long is not coming (a worker the system ended raises no event), and every proof waits in line behind it.
      const call = (msg, transfer = [], ms = 0) => new Promise((resolve, reject) => {
        const i = ++id, t = ms ? setTimeout(() => stop('Proving took too long on this device. Close other tabs and try again.'), ms) : 0;
        waiting.set(i, { resolve: (d) => { clearTimeout(t); resolve(d); }, reject: (e) => { clearTimeout(t); reject(e); } });
        worker.postMessage({ ...msg, id: i }, transfer);
      });
      await call({ op: 'init', wasm, zkey, vk }, [wasm.buffer, zkey.buffer], 5 * 60e3);
      prover.ready = true;
      return async (input) => { const t = performance.now(), r = await call({ op: 'prove', input }, [], 8 * 60e3); prover.ms = performance.now() - t; return { proof: r.proof, publicSignals: r.publicSignals }; };
    })().catch((e) => { proverP = null; throw e; }));
  }
  const prove = oneAtATime(async (input) => (await warm())(input));

  // The address of the key's pool wallet: a plan is kept with it, and only the key that made the plan swaps it. A browser keeps plans for every Tacit key opened in it, and another
  // key's wallet that held enough would otherwise send its own funds to this plan's address.
  async function keyId() {
    const priv = await keyHex();
    if (keyAddr?.priv !== priv) { const m = await mods(); keyAddr = { priv, address: m.wm.evmPoolKeys(m.zk, hexToBytes(priv)).address }; }
    return lc(keyAddr.address);
  }
  // (recorded when the key can be read: a flow that never opens it, a box made for the first hop, leaves no key, and such a plan is anyone's as plans were)
  const keyIdIfOpen = () => keyId().catch(() => undefined);
  const mine = async (plan) => !plan.key || plan.key === await keyId();         // (a plan from before plans kept their key has none, and is anyone's)
  const OTHER_KEY = 'This swap was made with another Tacit key. Open that key to use it.';
  // The key's pool wallet, its state kept where /pay/eth keeps it, so either page sees the same notes: the ETH pool's, or with `hop` (a plan's
  // token pool) that pool's, its fees in the token and sent by the same relay.
  async function wallet(hop = null) {
    if (walletOf) return walletOf(hop);
    // the key's address is derived once per key (about 70 ms of the page's thread each time), the wallets then found by it
    const priv = await keyHex(), m = await mods(), cached = keyAddr?.priv === priv;
    let keys = cached ? null : m.wm.evmPoolKeys(m.zk, hexToBytes(priv));
    if (!cached) keyAddr = { priv, address: keys.address };
    const key = `${keyAddr.address}:${lc(hop?.pool || POOL)}`;
    if (wallets.has(key)) return wallets.get(key);
    keys ||= m.wm.evmPoolKeys(m.zk, hexToBytes(priv));
    const kv = { open: true, get: (k) => { try { return store.getItem(k); } catch { return null; } }, set: (k, v) => { try { store.setItem(k, v); } catch { } } };
    rpc ||= m.wm.jsonRpc(chain.rpc);
    const base = { chainId: chain.chainId, rpc, confirmations: chain.confirmations, logChunk: chain.logChunk };
    const w = hop
      ? m.wm.makeEvmPoolWallet({ zk: m.zk, keys, keeper: keeperOf(hop), store: kv, feed: true, prove,
        chain: { ...base, pool: hop.pool, router: hop.router, token: hop.token, deployBlock: hop.from || TOKEN_POOLS_FROM, relayer: chain.tokenRelayer || RELAYER, maxRelayFee: SERVED[lc(hop.token)]?.maxRelayFee ?? 10n ** 36n } })
      : m.wm.makeEvmPoolWallet({ zk: m.zk, keys, keeper: chain.keeper, store: kv, feed: true, prove, chain: { ...base, pool: POOL, router: ROUTER, deployBlock: chain.deployBlock, dustFloor: DUST_ETH } });
    w.connect(signer);
    wallets.set(key, w);
    return w;
  }
  const keeperOf = (hop) => (chain.keepers ? `${chain.keepers}/${hop.id}/evm-pool/keeper` : hop.keeper || `${KEEPERS}/${hop.id}/evm-pool/keeper`);
  const tps = () => (tokens ? Promise.resolve(tokens) : tokenPools());
  // A token's own pool: where it is and whether it is open (pool and router on chain). → poolOf's fields, `keeper`, and `state`
  async function hopOf(token) {
    const tp = await tps(), p = tp.poolOf(token);
    return { ...p, keeper: keeperOf(p), state: await poolState(tp, token, (to, data) => ethCall(to, data, 'latest')) };
  }
  // Opens a token's pool: the one transaction (both contracts, or what is missing), from the connected wallet, then names it to the relay
  // (notifyPool), which serves it. → { hash, block } or null when open
  async function openPool(token, { onStep = () => {} } = {}) {
    const tp = await tps(), have = await poolState(tp, token, (to, data) => ethCall(to, data, 'latest')), tx = tp.openTx(token, have);
    if (!tx) return null;
    if (signer.ready) await signer.ready();
    onStep('open the pool');
    const h = await signer.send({ to: tx.to, data: tx.data, value: 0n });
    onStep('waiting for it to be mined');
    const rc = await mined(h, 'The pool was not opened.');
    notifyPool(token, globalThis.fetch, chain.keepers || KEEPERS).catch(() => {});
    return { hash: h, block: Number(BigInt(rc?.blockNumber ?? 0)) };
  }


  // Whether the chain has a transaction: true, false (no node has it, asked of every node), or undefined when no node could be asked. A test's wallet has no chain, so its hash is taken as known.
  async function chainKnows(h) {
    if (knows) return knows(h);
    if (walletOf) return true;
    if (!h) return undefined;
    try { rpc ||= (await mods()).wm.jsonRpc(chain.rpc); return (await rpc('eth_getTransactionReceipt', [h], { found: true })) != null; } catch { return undefined; }
  }
  // A transaction's receipt: the receipt, null (no node has it yet), or undefined when it could not be asked.
  async function receiptOf(h) {
    try { rpc ||= (await mods()).wm.jsonRpc(chain.rpc); return await rpc('eth_getTransactionReceipt', [h], { found: true }); } catch { return undefined; }
  }
  // The transaction in which a plan's call ran: the router's CallExecuted for the plan's escrow, read from the block the plan was sent at. → { tx }, null (it has not
  // run), or undefined when that cannot be read (a plan from before the escrow was kept, or no chain), which leaves the caller to judge by the pool's balance.
  async function ranCall(plan) {
    if (!plan.escrow) return undefined;
    if (callRan) return callRan(plan);
    if (!plan.swapBlock || walletOf) return undefined;
    try {
      rpc ||= (await mods()).wm.jsonRpc(chain.rpc);
      const logs = await rpc('eth_getLogs', [{ address: plan.hop?.router || ROUTER, topics: [CALL_EXECUTED, '0x' + word(plan.escrow)], fromBlock: '0x' + Math.max(0, Number(plan.swapBlock) - 2).toString(16), toBlock: 'latest' }]);
      return Array.isArray(logs) && logs.length ? { tx: logs[0].transactionHash } : null;
    } catch { return undefined; }
  }
  // A transaction the wallet sent, until it is in a block (an approval that must land before the call that uses it). → its receipt
  async function mined(h, failed = 'The approval did not go through. Nothing was deposited.') {
    rpc ||= (await mods()).wm.jsonRpc(chain.rpc);
    const rc = signer.receipt ? await signer.receipt(h) : await (async () => { for (let i = 0; i < 80; i++) { const r = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); if (r) return r; await sleep(3000); } return null; })();
    if (!rc) throw new Error('It has not confirmed yet. Check your wallet before sending anything again.');   // a slow transaction is not a failed one
    if (rc.status !== '0x1') throw new Error(failed);
    return rc;
  }
  // How a token pool's router takes `amount` of its token from the wallet: an allowance it has; an EIP-2612 permit signed for it (checked on
  // chain first; not DAI's); the approval and the deposit in one batch where the wallet sends batches; else an approval of exactly the amount,
  // mined first (USDT's set to zero before). → the pull routerDeposit takes.
  async function routerPull({ token, router, sym, amount, deadline, onStep }) {
    const owner = signer.address, acc = await readAccess({ ethCall, token, owner, spender: router });
    if (acc.balance < amount) throw new Error(`Not enough ${sym} in the wallet for the deposit. Nothing was sent.`);
    if (acc.allowed >= amount) return { kind: 'allowance' };
    if (signer.signTyped) {
      const t = await readToken({ ethCall, keccak256: keccak_256, address: token }).catch(() => null);
      if (t?.permit && acc.nonce != null && lc(token) !== DAI) {
        try {
          onStep('sign the permit');
          const p = splitSig(await signer.signTyped(permitTyped({ token, name: t.name, version: t.permit, owner, spender: router, value: amount, nonce: acc.nonce, deadline })));
          await ethCall(token, '0xd505accf' + word(owner) + word(router) + amount.toString(16).padStart(64, '0') + BigInt(deadline).toString(16).padStart(64, '0') + p.v.toString(16).padStart(64, '0') + word(p.r) + word(p.s), 'latest');
          return { kind: 'permit', value: amount, deadline: BigInt(deadline), ...p };
        } catch (e) { if (declined(e)) throw e; }
      }
    }
    let zeroed = false;
    if (acc.allowed > 0n && lc(token) === USDT) { onStep('reset the allowance'); await mined(await signer.send({ to: token, data: encApprove(router, 0n), value: 0n })); zeroed = true; }
    try {
      if (signer.batch && signer.canBatch && await Promise.resolve(signer.canBatch()).catch(() => false)) return { kind: 'batch', token };
      onStep('approve');
      await mined(await signer.send({ to: token, data: encApprove(router, amount), value: 0n }));
    } catch (e) { throw zeroed ? afterReset(e) : e; }
    return { kind: 'allowance' };
  }
  // The token pools a swap here has gone through, for the front page (TOKEN_POOLS_KEY).
  const keepPool = (hop, sym, dec) => {
    try {
      const all = (JSON.parse(store.getItem(TOKEN_POOLS_KEY) || '[]') || []).filter((x) => x?.pool && lc(x.pool) !== lc(hop.pool));
      store.setItem(TOKEN_POOLS_KEY, JSON.stringify([{ token: lc(hop.token), sym, dec, pool: hop.pool, router: hop.router, id: hop.id, from: hop.from || TOKEN_POOLS_FROM }, ...all].slice(0, 40)));
    } catch { }
  };
  // The approvals of exactly `amount` to the zap (USDT's set to zero first where it has one, as USDT asks).
  const approvals = (token, amount, had) => [...(had > 0n && lc(token) === USDT ? [{ to: token, data: encApprove(ZAP, 0n), value: 0n }] : []), { to: token, data: encApprove(ZAP, amount), value: 0n }];
  // How the zap takes `amount` of a token from the wallet, asking the least of it (as the page's own swaps do): an allowance it has already; an
  // EIP-2612 permit signed for it (not DAI's, whose own permit the zap has no door for); a Permit2 transfer signed for it, where the token allows
  // Permit2; the approval and the zap in one batch, where the wallet sends batches (`before`); else an approval of exactly the amount, mined first.
  // A signature is checked on chain as the zap would use it before it is, and one that does not check out falls through to the next way. Either
  // way the deposit is one transaction.
  async function zapPull({ token, sym, amount, deadline, onStep }) {
    const owner = signer.address, acc = await readAccess({ ethCall, token, owner, spender: ZAP });
    if (acc.balance < amount) throw new Error(`Not enough ${sym} in the wallet for the deposit. Nothing was sent.`);
    if (acc.allowed >= amount) return { kind: 'allowance' };
    if (signer.signTyped) {
      const t = await readToken({ ethCall, keccak256: keccak_256, address: token }).catch(() => null);
      if (t?.permit && acc.nonce != null && lc(token) !== DAI) {
        try {
          onStep('sign the permit');
          const p = splitSig(await signer.signTyped(permitTyped({ token, name: t.name, version: t.permit, owner, spender: ZAP, value: amount, nonce: acc.nonce, deadline })));
          await ethCall(token, '0xd505accf' + word(owner) + word(ZAP) + amount.toString(16).padStart(64, '0') + BigInt(deadline).toString(16).padStart(64, '0') + p.v.toString(16).padStart(64, '0') + word(p.r) + word(p.s), 'latest');
          return { kind: 'permit', value: amount, deadline: BigInt(deadline), ...p };
        } catch (e) { if (declined(e)) throw e; }
      }
      if (acc.permit2 >= amount) {
        try {
          onStep('sign the permit');
          const nonce = permit2Nonce(), sig = await signer.signTyped(permit2Typed({ token, amount, nonce, deadline, spender: ZAP }));
          // as the zap calls it: Permit2 pays the zap, from the zap
          const { gw } = await mods();
          await ethCall(PERMIT2, gw.calldata('permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)', [{ tuple: [{ tuple: ['address', 'uint256'] }, 'uint256', 'uint256'] }, { tuple: ['address', 'uint256'] }, 'address', 'bytes'],
            [[[token, amount], nonce, BigInt(deadline)], [ZAP, amount], owner, sig]), 'latest', { from: ZAP });
          return { kind: 'permit2', nonce, deadline: BigInt(deadline), sig };
        } catch (e) { if (declined(e)) throw e; }
      }
    }
    const ask = approvals(token, amount, acc.allowed);
    if (signer.batch && signer.canBatch && await Promise.resolve(signer.canBatch()).catch(() => false)) return { kind: 'allowance', before: ask };
    let zeroed = false;
    try { for (const c of ask) { const reset = c.data === encApprove(ZAP, 0n); onStep(reset ? 'reset the allowance' : 'approve'); await mined(await signer.send(c)); if (reset) zeroed = true; } }
    catch (e) { throw zeroed ? afterReset(e) : e; }
    return { kind: 'allowance' };
  }

  // The deposit: a plan is kept before anything is sent, so a closed tab finds it again; the prover starts loading at once.
  // `pay`, for a deposit from a token: { token, sym, dec, amountIn, min, most, slippageBps }: the amount the card quoted and its route's floor,
  // from which the amount sold for exactly the deposit is found again here (refused above `most`, the most the card showed); then the zap's pull,
  // and the zap's one transaction with the proof in it.
  // `hop`, for a deposit of a token into its own pool (hopOf, open): the token goes in as it is, `depositWei` of it, and the swap out sells
  // `swapWei` of it; `pay` names the token ({ token, sym, dec }).
  async function start({ swapWei, extraWei = 0n, token, sym, dec, to, toName = null, depositWei, dest = { kind: 'address' }, gasWei = 0n, pay = null, hop = null, onStep = () => {} }) {
    if (hop) return startHop({ swapWei, extraWei, token, sym, dec, to, toName, depositWei, pay, hop, onStep });
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (dest.kind !== 'address') {
      if (lc(token) !== TAC) throw new Error(`Only TAC can go to a private balance from here: ${sym} is not a pool asset.`);
      to = (await tacitAccount()).acct.address;
    }
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    if (pay && (lc(pay.token) === ZERO || lc(pay.token) === lc(token))) throw new Error('Pay with another token than the one it buys.');
    const w = await wallet(), m_ = await mods();
    warm().catch(() => {});
    // the pool is read while the permit is signed and the route priced, so the deposit's prompt does not wait on it (a failure here shows at the read below)
    const readAt = Date.now(), synced = w.sync();
    synced.catch(() => {});
    let selfCall = null, paid = null, batched = null;
    if (pay) {
      onStep('reading the price again');
      const deadline = BigInt(secs() + DEADLINE_S), slippageBps = pay.slippageBps ?? 50;
      const size = () => sizeIn({ route: (a) => routeIn({ ethCall, venues, token: pay.token, amountIn: a, from: signer.address, slippageBps, deadline }), amountIn: pay.amountIn, min: pay.min, depositWei });
      // a node that failed a heavy read looks like no route: asked once more before saying so
      const r = (await size().catch(() => null)) || (await sleep(1500), await size());
      if (!r) throw new Error(`No onchain route sells ${pay.sym} for the deposit right now. Nothing was sent.`);
      if (pay.most != null && r.amountIn > BigInt(pay.most)) throw Object.assign(new Error(`The price moved: the deposit takes more ${pay.sym} than was shown. Nothing was sent; check it and press again.`), { moved: true, amountIn: r.amountIn });
      const pull = await zapPull({ token: pay.token, sym: pay.sym, amount: r.amountIn, deadline, onStep });
      const zap = (tx) => m_.wm.zapDeposit(ZAP, tx, { token: pay.token, amountIn: r.amountIn, swap: r.callData, pull });
      selfCall = (tx) => ({ ...zap(tx), ...(pull.before?.length ? { before: pull.before } : {}) });
      // a wallet that said it batches and then will not: the approvals are sent one by one, then the deposit alone
      batched = pull.before?.length ? { calls: pull.before, alone: zap } : null;
      paid = { token: lc(pay.token), sym: pay.sym, dec: pay.dec, amountWei: String(r.amountIn), typed: String(pay.amountIn), route: r.name };      // `typed`: the amount asked for, which the plan's header names
    }
    const s0 = await synced;
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}), ...(paid ? { pay: paid } : {}), dest, gasWei: String(gasWei), state: 'depositing', leaves0: s0.leaves };
    keptOrStop(plan);
    try {
      plan.depositTx = await w.deposit({ amount: BigInt(depositWei), selfCall, onStep, readAt }).catch(async (e) => {
        if (!e?.noBatch || !batched) throw e;
        let zeroed = false;
        try { for (const c of batched.calls) { const reset = c.data === encApprove(ZAP, 0n); onStep(reset ? 'reset the allowance' : 'approve'); await mined(await signer.send(c)); if (reset) zeroed = true; } }
        catch (x) { throw zeroed ? afterReset(x) : x; }
        return w.deposit({ amount: BigInt(depositWei), selfCall: batched.alone, onStep });
      });
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.err = null;
      plan.leaves0 = (await w.sync(5000).catch(() => s0)).leaves;      // the deposit is in the pool whatever this read says: a read that fails keeps the count from before it
    } catch (e) {
      // declined or refused before it was sent: nothing went; anything else may have landed, and is checked against the pool
      plan.state = notSent(e) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  async function startHop({ swapWei, extraWei, token, sym, dec, to, toName, depositWei, pay, hop, onStep }) {
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    if (!hop.state?.pool || !hop.state?.router) throw new Error(`The private ${pay.sym} pool is not open yet.`);
    const w = await wallet(hop), m_ = await mods(), amount = BigInt(depositWei);
    warm().catch(() => {});
    const deadline = BigInt(secs() + DEADLINE_S);
    const readAt = Date.now(), synced = w.sync();
    synced.catch(() => {});
    const pull = await routerPull({ token: hop.token, router: hop.router, sym: pay.sym, amount, deadline, onStep });
    const s0 = await synced;
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}), dest: { kind: 'address' }, gasWei: '0',
      hop: { token: lc(hop.token), pool: hop.pool, router: hop.router, id: hop.id, from: hop.from || TOKEN_POOLS_FROM, sym: pay.sym, dec: pay.dec }, state: 'depositing', leaves0: s0.leaves };
    keptOrStop(plan);
    keepPool(hop, pay.sym, pay.dec);
    try {
      plan.depositTx = await w.deposit({ amount, selfCall: (tx) => m_.wm.routerDeposit(hop.router, tx, pull), onStep, readAt }).catch(async (e) => {
        if (!e?.noBatch || pull.kind !== 'batch') throw e;
        onStep('approve');
        await mined(await signer.send({ to: hop.token, data: encApprove(hop.router, amount), value: 0n }));
        return w.deposit({ amount, selfCall: (tx) => m_.wm.routerDeposit(hop.router, tx, { kind: 'allowance' }), onStep });
      });
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.err = null;
      plan.leaves0 = (await w.sync(5000).catch(() => s0)).leaves;      // the deposit is in the pool whatever this read says: a read that fails keeps the count from before it
    } catch (e) {
      plan.state = notSent(e) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  // A token start with the relay paying the deposit's gas (see BOX_GAS above): a deposit box of the ETH pool is made for this key, for the deposit and the keeper's fee,
  // and given to the pool's keeper; `fund({ box, amount, fee })` is the page's: it has the gas relay sell the token for the ETH the box holds and gives the relay's
  // transaction hash. The keeper then completes the box, and the deposit is the note it makes, found here. `pay`: { token, sym, dec, amountIn, route } as sold.
  // `refund`: where what the sale pays above the box goes after its deadline (an address only this key knows, by default).
  async function startBoxed({ swapWei, extraWei = 0n, token, sym, dec, to, toName = null, depositWei, pay, fund, refund = null, waitMs = 600_000, pollMs = 3000, onStep = () => {} }) {
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    if (lc(pay.token) === ZERO || lc(pay.token) === lc(token)) throw new Error('Pay with another token than the one it buys.');
    // this way pays an address: a private destination (the key's own balance, a Tacit address) is made by `start`, which hands the gas it needs to the key's account
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw Object.assign(new Error('Add the address it goes to. Nothing was sent.'), { nothingSpent: true });
    // what the sale pays above the box is returned to `refund` after the box's deadline (anyone may send it): by default a fresh receive box of this key, an address nothing else
    // names (the intent is public once the box is completed, so a stable address there would tie this key's deposits together) and only the key can sweep.
    // It goes to the keeper in lower case: it takes an address in no case or its own checksum's, and a wrongly cased one is refused.
    const w = await wallet(), back = lc(refund || (await w.refundBox()));
    const least = depositFeeOf(await w.quote(BOX_GAS).catch(() => null));
    if (least == null) throw Object.assign(new Error('The pool’s keeper could not quote its fee right now. Nothing was sent. Try again in a moment.'), { nothingSpent: true });
    const fee = boxFeeOf(least), amount = BigInt(depositWei) + fee;
    const s0 = await w.sync();
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}),
      pay: { token: lc(pay.token), sym: pay.sym, dec: pay.dec, amountWei: String(pay.amountIn), ...(pay.typed != null ? { typed: String(pay.typed) } : {}), route: pay.route || 'relay' }, dest: { kind: 'address' }, gasWei: '0',
      boxed: true, state: 'depositing', leaves0: s0.leaves };
    keptOrStop(plan);                                 // before the box is made: a sale whose plan could not be kept would have nothing to find its deposit again
    let ran = false;                                  // whether the relay's order has run: from then on nothing is called stopped, however the wait ends
    try {
      onStep('opening your deposit box');
      const box = await w.depositBox({ amount, fee, refund: back, deadline: secs() + 2 * DEADLINE_S });       // counted from the chain's time, as every deadline here is
      plan.box = box.box; plan.boxWei = String(amount); plan.boxIntent = box.intent ?? null; plan.boxDeadline = box.deadline ?? null; save(plan);      // (the intent is what sending the box's balance back needs: the keeper has it too)
      // `fund` gives the relay's transaction hash, or { hash, amountIn, route } where the amount sold is found only now (the box did not exist when the page sized it)
      const sold = await fund({ box: box.box, amount, fee, onStep });
      ran = true; plan.soldAt = Date.now();             // kept: the order ran and the box is funded, with or without the transaction's hash
      plan.depositTx = typeof sold === 'string' ? sold : sold?.hash || null;
      if (sold?.amountIn != null) plan.pay.amountWei = String(sold.amountIn);
      if (sold?.route) plan.pay.route = sold.route;
      save(plan);
      // the hash is for the step's link alone: `fund` returns only once the order has run, so the box is funded and the wait for the keeper goes on without it
      onStep('making your deposit private');
      const end = Date.now() + waitMs;
      for (;;) {
        const s = await w.sync();
        if (w.notes().some((n) => BigInt(n.v) === BigInt(depositWei) && Number(n.index) >= Number(s0.leaves))) { plan.leaves0 = s.leaves; break; }
        if (Date.now() > end) throw Object.assign(new Error('The swap went through and its deposit is on its way. It is checked again below; nothing is lost.'), { pending: true });
        await sleep(pollMs);
      }
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.err = null;
    } catch (e) {
      // a relay order that ran leaves the box funded: the keeper completes it, and the plan is checked again; before that, a no or a refusal left nothing spent
      plan.state = ran ? 'depositing'
        : e?.nothingSpent || declined(e) || /cancel|rejected|denied|nothing was (sent|spent)|did not take|price moved/i.test(String(e?.message || e)) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  // The deposit that start (or startHop) will make is proved while its button waits to be pressed (the pool wallet's prepareDeposit), so the press
  // finds the proof made. One at a time, and the latest asked for: a figure the card has moved on from while one is being proved is not proved after
  // it. `hop` is the token pool the deposit goes into, else the ETH pool's. Opens the key first if it is not open.
  let aheadWant = null, aheadRun = null;
  function ahead({ depositWei, hop = null }) {
    aheadWant = { depositWei, hop };
    return (aheadRun ||= (async () => {
      try {
        for (let want; (want = aheadWant); ) {
          aheadWant = null;
          // a figure that failed does not stop a newer one asked for meanwhile, unless the key could not be opened
          try {
            const w = await wallet(want.hop);
            if (!aheadWant) await w.prepareDeposit(BigInt(want.depositWei));
          } catch (e) { if (e?.unlockCancelled || !aheadWant) { aheadWant = null; throw e; } }
        }
      } finally { aheadRun = null; }
    })());
  }
  // A swap out of what a pool already holds for the key (paid to it, or left from an earlier deposit), so there is no deposit now: the plan
  // starts at its wait with the deposit done, and its swap out goes as any plan's (offer, then the confirmed price). `hop` is a token pool
  // (hopOf, open; `pay` names its token), else the ETH pool's. The balance must cover the swap and the relay's fee twice, as a deposit
  // sets it aside, for a fee that rises while it waits. A token that is the pool's own is paid out as it is.
  // `into` ({ hop, refund }): the swap pays another pool's deposit box for this key (hop: that pool's, else the ETH pool's) and `to` is not an
  // address of anyone's: what the box holds above its floor goes to `refund` after its deadline, an address only this key knows.
  async function adopt({ swapWei, token, sym, dec, to = null, toName = null, hop = null, pay = null, feeWei, into = null }) {
    const swap = BigInt(swapWei), fee = BigInt(feeWei), unit = hop ? pay.sym : 'ETH';
    if (swap <= 0n) throw new Error('enter an amount');
    if (into) { into = { ...into, refund: into.refund || (await tacitAccount()).acct.address }; to = into.refund; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('Add the address it goes to.');
    if (into?.hop && !(into.hop.state?.pool && into.hop.state?.router)) throw new Error(`The private ${sym} pool is not open yet.`);
    // the box the swap pays is the pool's own token's: another token would pay a box that can never be completed
    if (into?.hop && into.hop.token && lc(into.hop.token) !== lc(token)) throw new Error(`The private ${sym} pool takes another token than ${sym}. Nothing was sent.`);
    if (hop && !(hop.state?.pool && hop.state?.router)) throw new Error(`The private ${unit} pool is not open yet.`);
    const w = await wallet(hop), s = await w.sync();
    if (s.balance < swap + 2n * fee) throw new Error(`Your private ${unit} balance holds less than the swap and the relay’s fee. Nothing was sent.`);
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), key: await keyIdIfOpen(), held: true, swapWei: String(swap), extraWei: '0', depositWei: String(swap + 2n * fee),
      token: lc(token), sym, dec, to: lc(to), ...(toName ? { toName: String(toName) } : {}), dest: { kind: 'address' }, gasWei: '0',
      ...(hop ? { hop: { token: lc(hop.token), pool: hop.pool, router: hop.router, id: hop.id, from: hop.from || TOKEN_POOLS_FROM, sym: pay.sym, dec: pay.dec } } : {}),
      ...(into ? { into: { refund: lc(into.refund), hop: into.hop ? { token: lc(into.hop.token), pool: into.hop.pool, router: into.hop.router, id: into.hop.id, from: into.hop.from || TOKEN_POOLS_FROM, sym, dec } : null } } : {}),
      state: 'waiting', depositedAt: Date.now(), leaves0: s.leaves };
    keptOrStop(plan);
    if (hop) keepPool(hop, pay.sym, pay.dec);
    if (into?.hop) keepPool(into.hop, sym, dec);
    return plan;
  }
  // The wallet's ETH swapped into a private balance in another coin, in one transaction: a deposit box of that pool for this key is made (a
  // little under the route's floor, given to that pool's relay, which completes it once paid) and the wallet's swap pays it. The wallet and the
  // swap show on chain, whose balance it lands in does not. `into.hop` is that pool (hopOf, open); the leftover above the box is refundable to
  // an address only this key knows. → the transaction hash
  // A deposit box for this key in a pool, for a swap that will pay it: made for a little under `floor` (what the swap is sure to pay), given to
  // that pool's relay, and refundable above that to `refund` (an address only this key knows, by default). → { box, amount, value }
  async function depositBoxFor({ into, floor, refund = null }) {
    if (!into?.hop?.state?.pool || !into.hop.state.router) throw new Error('The private pool is not open yet.');
    const w = await wallet(into.hop), back = refund || (await tacitAccount()).acct.address;
    const fee = BigInt((await w.quote(Number(HOP_GAS))).fee), amount = (BigInt(floor) * BOX_MARGIN) / 1000n;
    if (amount <= fee * 2n) throw new Error('Too small to go into that pool: its relay\u2019s fee takes too much of it. Nothing was sent.');
    return w.depositBox({ amount, fee, refund: back, deadline: secs() + 2 * DEADLINE_S });
  }
  async function swapIntoPool({ swapWei, token, into, refund = null, shownMin = null, slippageBps = 50, onStep = () => {}, onBox = null }) {
    const swap = BigInt(swapWei);
    if (!signer.address) throw new Error('Connect a wallet to swap from.');
    if (!into?.hop?.state?.pool || !into.hop.state.router) throw new Error('The private pool is not open yet.');
    if (into.hop.token && lc(into.hop.token) !== lc(token)) throw new Error('That private pool takes another token than this swap pays. Nothing was sent.');
    const w = await wallet(into.hop), back = refund || (await tacitAccount()).acct.address;
    onStep('reading the price again');
    const deadline = BigInt(secs() + DEADLINE_S);
    const route = (to) => (lc(token) === TAC ? rt.routeOutTac({ venues, amount: swap, to, slippageBps, deadline }) : rt.routeOut({ ethCall, token, amount: swap, to, slippageBps, deadline }));
    const first = await route('0x' + hexOf(crypto.getRandomValues(new Uint8Array(20))));
    if (!first) throw new Error('No onchain route for this right now. Nothing was sent.');
    const fee = BigInt((await w.quote(Number(HOP_GAS))).fee), amount = (BigInt(shownMin ?? first.min) * BOX_MARGIN) / 1000n;
    if (amount <= fee * 2n) throw new Error('Too small to go into that pool: its relay\u2019s fee takes too much of it. Nothing was sent.');
    if (shownMin != null && first.min * 10000n < BigInt(shownMin) * 9990n) throw Object.assign(new Error('The price moved since it was shown. Nothing was sent; check the new one and press again.'), { moved: true });
    const box = await w.depositBox({ amount, fee, refund: back, deadline: secs() + 2 * DEADLINE_S });
    const r = await route(box.box);
    if (!r || r.min < amount) throw Object.assign(new Error('The price moved while the deposit box was made. Nothing was sent; press again.'), { moved: true });
    // the box is the page's to keep before the swap goes out: what pays it can only be taken back through its intent
    onBox?.({ box: box.box, intent: box.intent ?? null, deadline: box.deadline ?? null, arrives: box.value });
    if (signer.ready) await signer.ready();
    onStep('confirm in your wallet');
    const h = await signer.send({ to: ZROUTER, data: r.callData, value: swap });
    onStep('waiting for the block');
    const rc = signer.receipt ? await signer.receipt(h).catch(() => null) : null;
    if (rc && !(rc.status === '0x1' || rc.status === 1 || rc.status === 'success')) throw new Error('The swap was sent but failed on chain, so nothing reached the deposit box.');
    return { hash: h, box: box.box, arrives: box.value, intent: box.intent ?? null, deadline: box.deadline ?? null };
  }
  function save(plan) { keepPlans([plan, ...readPlans(store).filter((p) => p.id !== plan.id)], store); }
  // A deposit with no plan to find it again is a swap that waits for nobody: a browser that cannot keep the plan (full, blocked) stops it before anything is sent.
  function keptOrStop(plan) {
    if (!keepPlans([plan, ...readPlans(store)], store) || !readPlans(store).some((x) => x.id === plan.id)) throw new Error('This browser could not keep the swap’s plan, so nothing was sent. Free some browser storage and try again.');
  }
  const forget = (id) => keepPlans(readPlans(store).filter((p) => p.id !== id), store);
  // A plan left in doubt (a closed tab, an unclear answer) read against the pool: its deposit is a new note of exactly its amount; its swap out
  // spent the swap's ETH, so the balance is at least that much under what it was before.
  async function check(plan) {
    if (!(await mine(plan))) return { ...plan, err: OTHER_KEY };                       // read against another key's pool it would say nothing true of this plan: left as it is
    if (poolDest(plan) && (plan.state === 'shielding' || plan.state === 'held')) return plan;        // its swap is done: what is left is the making private, pressed again
    const w = await wallet(plan.hop), s = await w.sync(), notes = w.notes();
    let verdict = null;                                  // a direct payout's own transaction: 'sent' (not mined yet) or 'failed' (reverted)
    if (!plan.depositedAt) {
      // a note of exactly its amount that the pool made after the plan began: an older note of the same size is some other money
      const found = notes.filter((n) => BigInt(n.v) === BigInt(plan.depositWei) && Number(n.index) >= Number(plan.leaves0 || 0)).map((n) => Number(n.index));
      if (found.length) {
        // the mix is counted from after the deposit's own pair of leaves (the pool takes them in pairs), as a start counts it
        plan.state = 'waiting'; plan.depositedAt = plan.at; plan.err = null; plan.leaves0 = plan.boxed ? s.leaves : Math.min(...found) - (Math.min(...found) % 2) + 2;
      }
      // through a deposit box: the relay's order ran and the keeper has the box to complete (until the box's deadline), or the order was posted and may still run (its own is ten minutes)
      else if (plan.boxed && plan.box && Date.now() - plan.at < 2 * DEADLINE_S * 1000) {
        const sold = !!(plan.depositTx || plan.soldAt);
        plan.state = sold ? 'depositing' : 'unsure';
        plan.err = sold ? null : 'The relay may still send the swap, and the pool’s keeper may still complete the box. Check again in a few minutes.';
      }
      // a deposit sent from the wallet may be slow to be mined, or to be read: it stays in doubt, with Check offered, for half an hour
      else if (!plan.boxed && Date.now() - plan.at < LATE_MS) { plan.state = 'unsure'; plan.err = 'The deposit is not in the pool yet. If it was sent, it may still be on its way: check again in a few minutes.'; }
      else { plan.state = 'stopped'; plan.err = plan.boxed ? 'The deposit did not reach the pool before its box’s deadline. If the relay’s swap ran, what it paid is still in the box, which anyone can send back to an address your key owns.' : 'The deposit did not reach the pool. If your wallet shows it as sent, check it there before swapping again.'; }
    } else if (await (async () => {
      // Did the swap go out? The router says so for a plan that kept its escrow (an unrelated spend from the pool cannot be taken for it). A direct payout is judged by its own
      // transaction, else by whether the notes it was built from are spent; only a plan that kept neither is judged by the pool's balance, which another deposit or spend also moves.
      const ran = await ranCall(plan);
      if (ran !== undefined) { if (ran && ran.tx && !plan.swapTx) plan.swapTx = ran.tx; return ran !== null; }
      const rc = plan.outTx ? await receiptOf(plan.outTx) : undefined, fresh = plan.swapAt && Date.now() - plan.swapAt < 20 * 60e3;
      if (rc && (rc.status === '0x1' || rc.status === 1 || rc.status === 'success')) { plan.swapTx ||= plan.outTx; return true; }
      if (plan.outIns?.length) {
        if (plan.outIns.every((i) => !notes.some((n) => Number(n.index) === Number(i)))) return true;       // (a payout replaced by another transaction spent them too)
        verdict = rc ? 'failed' : plan.outTx && rc === null && fresh ? 'sent' : null;
        return false;
      }
      if (rc) { verdict = 'failed'; return false; }
      if (plan.outTx && rc === null && fresh) { verdict = 'sent'; return false; }
      return plan.balBefore != null && s.balance + BigInt(plan.swapWei) <= BigInt(plan.balBefore);
    })()) {
      if (poolDest(plan)) { plan.state = 'shielding'; plan.swapDoneAt = Date.now(); } else { plan.state = 'done'; plan.doneAt = Date.now(); }
      plan.err = null; delete plan.from;
    } else if (verdict === 'sent') { plan.state = 'unsure'; plan.err = 'The payout was sent and is not mined yet. Check again in a few minutes.'; }
    else if (verdict !== 'failed' && (plan.state === 'unsure' || plan.state === 'swapping') && plan.swapAt && Date.now() - plan.swapAt < 20 * 60e3) {
      // sent a moment ago and not seen yet, or still on its way out (here, or in a tab that holds the job): it stays in doubt, never offered again
      if (plan.state === 'swapping') plan.err = 'The swap was sent and is not in a block yet. Check again in a few minutes.';
    }
    else { plan.state = 'waiting'; plan.err = null; plan.outIns = null; plan.outTx = null; }      // (offered again: the last try's notes and hash are not this one's)
    save(plan);
    return plan;
  }

  // A deposit box that never reached the pool, sent back. Once its deadline has passed the router lets anyone return a deposit box's whole balance to its intent's refund address (for a
  // swap started here, a receive box only this key can sweep into a note), so the page's wallet sends it. The intent is the plan's: sealed with the box, it cannot be rebuilt from the keys.
  // The hash is kept before the wait, so a second press looks at that send and never makes another.
  const boxRead = async (method, params, opts) => { rpc ||= (await mods()).wm.jsonRpc(chain.rpc); return rpc(method, params, opts); };
  const boxArgs = (plan) => {
    const i = plan.boxIntent || {};
    try { return [BigInt(i.amount), BigInt(i.outLeaf0), BigInt(i.outLeaf1), String(i.memo0Hash), String(i.memo1Hash), String(i.refund), BigInt(i.deadline), BigInt(i.nonce)]; }
    catch { throw new Error('This swap’s deposit box record is incomplete. Nothing was sent.'); }
  };
  // What the plan's box holds now (ETH, wei), or null for a plan that made no box.
  async function boxHolds(plan) {
    if (!plan.boxed || !plan.box || !plan.boxIntent) return null;
    return BigInt(await boxRead('eth_getBalance', [plan.box, 'latest']));
  }
  async function reclaimBox(plan, { onStep = () => {} } = {}) {
    const p = readPlans(store).find((x) => x.id === plan.id) || plan;
    if (p.state !== 'stopped' || !p.boxed || !p.box || !p.boxIntent) throw new Error('This swap has no deposit box to send back. Nothing was sent.');
    // a send made before: mined, it stands; failed, it is made again; not seen yet, nothing is sent twice
    if (p.reclaimTx) {
      const rc = p.reclaimedAt ? { status: '0x1' } : await boxRead('eth_getTransactionReceipt', [p.reclaimTx], { found: true }).catch(() => null);
      if (rc && rc.status === '0x1') { p.reclaimedAt ||= Date.now(); save(p); return { plan: p, hash: p.reclaimTx, wei: BigInt(p.reclaimWei || 0), to: lc(p.boxIntent.refund), again: true }; }
      if (!rc && Date.now() - (p.reclaimAt || 0) < 30 * 60e3) throw new Error('The send-back is still being mined. Check again in a few minutes; nothing more was sent.');
      p.reclaimTx = null; p.reclaimAt = null; save(p);
    }
    const m = await mods(), args = boxArgs(p), refund = lc(p.boxIntent.refund), deadline = Number(p.boxIntent.deadline);
    // the intent must make the plan's box: a record that names another is not sent
    const at = '0x' + String(await boxRead('eth_call', [{ to: ROUTER, data: m.gw.calldata(`depositBoxOf(${DEPOSIT_SIG})`, [{ tuple: DEPOSIT_TUPLE }], [args]) }, 'latest'])).slice(-40);
    if (lc(at) !== lc(p.box)) throw new Error('This swap’s deposit box record does not match its box. Nothing was sent.');
    const held = BigInt(await boxRead('eth_getBalance', [p.box, 'latest']));
    if (held === 0n) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
    if (secs() <= deadline) throw new Error(`The box can be sent back once its deadline has passed, in about ${Math.ceil((deadline - secs()) / 60) + 1} min. Nothing was sent.`);
    const data = m.gw.calldata(`reclaimDeposit(${DEPOSIT_SIG},address)`, [{ tuple: DEPOSIT_TUPLE }, 'address'], [args, ZERO]);
    if (signer.ready) await signer.ready();
    if (!signer.address) throw new Error('Connect a wallet to send it from.');
    // checked as the wallet would send it: the router's own refusals are said in words
    try { await (signer.rpc || boxRead)('eth_call', [{ from: signer.address, to: ROUTER, data }, 'latest']); }
    catch (e) {
      const d = revertData(e);
      if (d.startsWith(NOT_EXPIRED)) throw new Error('The box’s deadline has not passed yet. Nothing was sent; try again in a few minutes.');
      if (d.startsWith(NOTHING_TO_RECLAIM)) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
      if (!d && !e?.rpc) throw new Error('Could not check the send-back just now, so nothing was sent. Try again in a moment.');
      throw new Error(`The router would refuse it: ${String(e?.message || e).slice(0, 120)}. Nothing was sent.`);
    }
    onStep('confirm in your wallet');
    const h = await signer.send({ to: ROUTER, data, value: 0n });
    p.reclaimTx = h; p.reclaimAt = Date.now(); p.reclaimWei = String(held); save(p);
    onStep('waiting for the block');
    const failed = 'The send-back failed on chain, so the box still holds it. Nothing was returned.';
    try { await mined(h, failed); }
    catch (e) { if (e?.message === failed) { p.reclaimTx = null; p.reclaimAt = null; save(p); } throw e; }
    p.reclaimedAt = Date.now(); p.err = 'The deposit box was sent back to an address only your key controls.'; save(p);
    return { plan: p, hash: h, wei: held, to: refund };
  }
  // A deposit box the card paid from the wallet into a pool's private balance (walletIntoGo), sent back once its deadline has passed: the router
  // returns all of `token` it still holds (what is left above what the pool took; all of it, for a box the pool's relay never completed) to the
  // intent's refund, the key's Tacit account. `rec`: { router, box, intent, token, reclaimTx?, reclaimAt? } as the card keeps it; `onSent(hash)`
  // lets the card keep the hash before the wait, so a second press looks at that send and makes no other. → { hash, held, to }
  async function reclaimIntoBox(rec, { onStep = () => {}, onSent = () => {} } = {}) {
    const router = rec?.router, token = lc(rec?.token || ZERO);
    if (!router || !rec?.box || !rec?.intent) throw new Error('This deposit box record is incomplete. Nothing was sent.');
    if (rec.reclaimTx) {
      const rc = await boxRead('eth_getTransactionReceipt', [rec.reclaimTx], { found: true }).catch(() => null);
      if (rc && rc.status === '0x1') return { hash: rec.reclaimTx, held: BigInt(rec.reclaimHeld || 0), to: lc(rec.intent.refund), again: true };
      if (!rc && Date.now() - (rec.reclaimAt || 0) < 30 * 60e3) throw new Error('The send-back is still being mined. Check again in a few minutes; nothing more was sent.');
    }
    const m = await mods(), args = boxArgs({ boxIntent: rec.intent }), refund = lc(rec.intent.refund), deadline = Number(rec.intent.deadline);
    const at = '0x' + String(await boxRead('eth_call', [{ to: router, data: m.gw.calldata(`depositBoxOf(${DEPOSIT_SIG})`, [{ tuple: DEPOSIT_TUPLE }], [args]) }, 'latest'])).slice(-40);
    if (lc(at) !== lc(rec.box)) throw new Error('This deposit box record does not match its box. Nothing was sent.');
    const held = token === ZERO ? BigInt(await boxRead('eth_getBalance', [rec.box, 'latest']))
      : BigInt(await boxRead('eth_call', [{ to: token, data: '0x70a08231' + lc(rec.box).replace(/^0x/, '').padStart(64, '0') }, 'latest']));
    if (held === 0n) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
    if (secs() <= deadline) throw new Error(`The box can be sent back once its deadline has passed, in about ${Math.ceil((deadline - secs()) / 60) + 1} min. Nothing was sent.`);
    const data = m.gw.calldata(`reclaimDeposit(${DEPOSIT_SIG},address)`, [{ tuple: DEPOSIT_TUPLE }, 'address'], [args, token]);
    if (signer.ready) await signer.ready();
    if (!signer.address) throw new Error('Connect a wallet to send it from.');
    try { await (signer.rpc || boxRead)('eth_call', [{ from: signer.address, to: router, data }, 'latest']); }
    catch (e) {
      const d = revertData(e);
      if (d.startsWith(NOT_EXPIRED)) throw new Error('The box’s deadline has not passed yet. Nothing was sent; try again in a few minutes.');
      if (d.startsWith(NOTHING_TO_RECLAIM)) throw new Error('The deposit box holds nothing, so there is nothing to send back. Nothing was sent.');
      if (!d && !e?.rpc) throw new Error('Could not check the send-back just now, so nothing was sent. Try again in a moment.');
      throw new Error(`The router would refuse it: ${String(e?.message || e).slice(0, 120)}. Nothing was sent.`);
    }
    onStep('confirm in your wallet');
    const h = await signer.send({ to: router, data, value: 0n });
    onSent(h, held);
    onStep('waiting for the block');
    await mined(h, 'The send-back failed on chain, so the box still holds it. Nothing was returned.');
    return { hash: h, held, to: refund };
  }

  // How the wait goes: the notes the pool has made since the deposit (each deposit, payment, change and withdrawal makes one or two) and the time since.
  async function blend(plan) {
    if (!(await mine(plan))) throw new Error(OTHER_KEY);                               // (the card shows no mix for it)
    // (a read a few seconds old serves every waiting plan of a pool: the card asks once per plan, every half minute)
    const w = await wallet(plan.hop), s = await w.sync(15000);
    // a swap's deposit is counted from its own; a held balance's from its latest note, the one that has mixed least
    // (the pool takes leaves in pairs, so a note's own pair is not another deposit)
    const last = Math.max(-1, ...w.notes().map((n) => Number(n.index)));
    const since = plan.held ? Math.max(0, s.leaves - (last < 0 ? 0 : last - (last % 2) + 2)) : Math.max(0, s.leaves - Number(plan.leaves0 || 0));
    return { since, mins: Math.floor((Date.now() - (plan.depositedAt || plan.at)) / 60000), balance: s.balance };
  }

  // The deposit box the last price read made for a plan into another pool (each is registered with that pool's relay, which then watches it): reused by the next read while the swap still pays it.
  const boxesOffered = new Map();
  // The swap out in two presses: the route quoted now (with the stand-in) and shown, then sent only while it still pays at least what was shown.
  async function offer(plan, { slippageBps = 50 } = {}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(plan.to || ''))) throw new Error('This swap has no address to pay. Remove it and start again.');
    // out of a token pool: the same token is paid out as it is; anything else is the token sold on the way out
    const same = !plan.into && (plan.hop ? lc(plan.token) === lc(plan.hop.token) : plan.token === ZERO);
    if (same) return { min: BigInt(plan.swapWei), out: BigInt(plan.swapWei), name: plan.hop ? `${plan.hop.sym} itself` : 'ETH itself', at: Date.now() };
    const deadline = BigInt(secs() + DEADLINE_S);
    const route = async (to) => {
      if (plan.hop) {
        const r = await rt.routeFrom({ ethCall, venues, tokenIn: plan.hop.token, token: plan.token, amount: BigInt(plan.swapWei), to, slippageBps, deadline });
        if (!r) throw new Error(`No onchain route sells ${plan.hop.sym} for ${plan.sym} right now. Nothing was sent; try again in a while.`);
        return r;
      }
      const r = lc(plan.token) === TAC
        ? await rt.routeOutTac({ venues, amount: BigInt(plan.swapWei), to, slippageBps, deadline })
        : await rt.routeOut({ ethCall, token: plan.token, amount: BigInt(plan.swapWei), to, slippageBps, deadline });
      if (!r) throw new Error(`No onchain route sells ETH for ${plan.sym} right now. Nothing was sent; try again in a while.`);
      return r;
    };
    if (!plan.into) return { ...(await route(plan.to)), at: Date.now() };
    // into another pool: priced once for a stand-in to learn its floor, then a deposit box for this key is made for a little under that floor
    // (given to that pool's relay, which completes it once the swap has paid it) and the swap priced again paying the box
    const w = await wallet(plan.into.hop), stand = '0x' + hexOf(crypto.getRandomValues(new Uint8Array(20)));
    const first = await route(stand), q = await w.quote(Number(plan.into.hop ? HOP_GAS : BASE_GAS + 200_000n));
    const fee = BigInt(q.fee), amount = (first.min * BOX_MARGIN) / 1000n;
    if (amount <= fee * 2n) throw new Error(`Too small to go into the ${plan.sym} pool: the relay's fee there is ${units(fee, plan.dec)} ${plan.sym} of it. Nothing was sent.`);
    // the box of the last read stands while the price still pays it (the same, or better by under a percent: the difference stays in the box with the surplus the sale pays above it),
    // its fee still covers the relay's, and its deadline is well past the swap's own; else a new one is made
    const last = boxesOffered.get(plan.id);
    const box = last && last.amount <= amount && last.amount * 1000n >= amount * 990n && last.fee >= fee && last.deadline > secs() + DEADLINE_S * 3 / 2 ? last
      : { ...(await w.depositBox({ amount, fee, refund: plan.into.refund, deadline: secs() + 2 * DEADLINE_S })), fee };
    boxesOffered.set(plan.id, box);
    const r = await route(box.box);
    if (r.min < box.amount) throw Object.assign(new Error('The price moved while the deposit box was made. Nothing was sent; read it again.'), { moved: true });
    return { ...r, at: Date.now(), intoBox: box, arrives: box.value };
  }
  // `via: 'self'` sends it from the connected wallet, refused when that is the wallet that deposited (it would tie the two together).
  async function swapOut(plan, { shown, slippageBps = 50, via = 'relay', onStep = () => {} } = {}) {
    if (!shown) throw new Error('Read the price first.');
    // Only a swap that waits is sent: one already made, being sent, or in doubt (here or in another tab, whose copy is the one kept) is not sent again
    const now_ = readPlans(store).find((x) => x.id === plan.id) || plan;
    if (now_.state !== 'waiting') throw new Error(`This swap is not waiting to be sent (${now_.state}). Check it first. Nothing was sent.`);
    if (!(await mine(plan))) throw new Error(`${OTHER_KEY} Nothing was sent.`);
    if (via === 'self' && plan.from && lc(signer.address) === plan.from) throw new Error('Not from the wallet that deposited: that would tie the deposit to the swap. Connect another wallet, or let the relay send it.');
    const w = await wallet(plan.hop), amount = BigInt(plan.swapWei), gas = BigInt(plan.gasWei || 0);
    // from a token pool the relay's fee is the token's, at a price that moves: never more than the deposit set aside for it (twice the fee shown)
    const aside = plan.hop ? BigInt(plan.depositWei) - amount - BigInt(plan.extraWei || 0) : null, maxFee = aside != null && aside > 0n ? aside : null;
    const s = await w.sync();
    if (s.balance < amount + gas) throw new Error(`The deposit is not in the pool yet, or was spent. Check it on ${plan.hop ? 'the front page' : 'the private ETH page'}.`);
    const same = !plan.into && (plan.hop ? lc(plan.token) === lc(plan.hop.token) : plan.token === ZERO);
    let r = shown;
    if (!same && (Date.now() - shown.at > 60e3 || !shown.callData)) {
      onStep('reading the price again');
      r = await offer(plan, { slippageBps });
      if (r.min < shown.min) throw Object.assign(new Error(`The price moved: it now pays at least ${units(r.min, plan.dec)} ${plan.sym} where ${units(shown.min, plan.dec)} was shown. Nothing was sent; read it again.`), { moved: true });
    }
    // Everything a later check or the making private reads is kept with the plan BEFORE the send, so a tab closed during it leaves them behind
    // (the TAC the account held before, so only this swap's is taken; the floor and the route)
    if (poolDest(plan) && !plan.hop && !same) { const { t, acct } = await tacitAccount(); plan.tacBefore = String(BigInt(await t.ethCall(TAC, '0x70a08231' + word(acct.address)) || '0x0')); }
    plan.min = String(r.min); plan.route = r.name;
    plan.state = 'swapping'; plan.balBefore = String(s.balance); plan.swapBlock = s.block ?? null; plan.swapAt = Date.now(); plan.err = null; plan.outIns = null; plan.outTx = null; save(plan);
    boxesOffered.delete(plan.id);                         // (a box this send may pay is not offered again)
    try {
      warm().catch(() => {});
      let h;
      // a direct payout has no escrow for the router to answer for, so what it is judged by is kept as the wallet knows it: the leaves of the notes it spends (before it is proved) and its hash (before the wait for the block)
      if (same) h = await w.withdraw({ to: plan.to, amount, via: via === 'self' ? 'self' : null, maxFee, onStep, onSend: (ins) => { plan.outIns = ins; save(plan); }, onSent: (x) => { plan.outTx = x; save(plan); } });
      else if (plan.hop) {
        // the escrow holds the token: one call approves zRouter for exactly the swap's amount and runs the route, which pays the address
        const m = await mods(), refund = (plan.callRefund ||= await w.refundBox());      // one for the plan, kept: each is an index a restore from the seed must reach
        const intent = m.gw.callIntent({ calls: [{ target: ZROUTER, value: 0n, token: plan.hop.token, amount, push: false, data: r.callData }], refund, deadline: r.deadline, nonce: randomNonce() });
        plan.escrow = m.gw.callEscrowAddress(intent, plan.hop.router); save(plan);          // kept before the send: a check asks the router whether this call ran
        h = await w.withdrawAndCall({ intent, amount, gas: Number(HOP_GAS), maxFee, via, onStep });
      } else {
        const m = await mods(), refund = (plan.callRefund ||= await w.refundBox());      // one for the plan, kept: each is an index a restore from the seed must reach
        // a swap into a private balance pays the key's own account, and hands it the gas to make the TAC private from there, in the same withdrawal
        const calls = [{ target: ZROUTER, value: amount, data: r.callData }, ...(gas > 0n ? [{ target: plan.to, value: gas }] : [])];
        const intent = m.gw.callIntent({ calls, refund, deadline: r.deadline, nonce: randomNonce() });
        plan.escrow = m.gw.callEscrowAddress(intent, ROUTER); save(plan);
        // the relay is paid for the gas it buys: the withdrawal and its escrow, and the route as sent from the pool (which holds the ETH), estimated
        // with the stand-in still in it, so the node never sees where the tokens go
        const multi = r.standData.startsWith('0xac9650d8');
        const routeGas = BigInt(await rpc('eth_estimateGas', [{ from: POOL, to: ZROUTER, value: '0x' + amount.toString(16), data: r.standData }]).catch(() => (multi ? '0xaae60' : '0x61a80')));
        h = await w.withdrawAndCall({ intent, amount: amount + gas, gas: Number(BASE_GAS + (routeGas * 3n) / 2n + (gas > 0n ? 40_000n : 0n)), via, onStep });
      }
      plan.swapTx = h; plan.proveMs = prover.ms; delete plan.from;
      if (plan.into && r.intoBox) { plan.intoBox = r.intoBox.box; plan.intoIntent = r.intoBox.intent ?? null; plan.intoDeadline = r.intoBox.deadline ?? null; }      // (the intent a reclaim of the surplus needs)
      // The wallet lets a send stand when no receipt shows in three minutes (it may yet land). A hash that no node has, or that no node could be asked about, is not a swap
      // that was made: it is kept in doubt, with its hash, for a check against the pool, and never shown as done.
      if (await chainKnows(h) !== true) throw new Error('The swap was sent but is not in a block yet; it may still have sent. Check it in a few minutes before swapping again.');
      if (poolDest(plan)) { plan.state = 'shielding'; plan.swapDoneAt = Date.now(); }
      else { plan.state = 'done'; plan.doneAt = Date.now(); }
      return plan;
    } catch (e) {
      plan.state = unsure(e) ? 'unsure' : 'waiting'; plan.refused = refused(e); plan.err = calmText(String(e?.message || e)).slice(0, 200);
      if (plan.state === 'waiting') { plan.outIns = null; plan.outTx = null; }          // nothing went: the notes it was built from are free to be spent by anything else
      throw e;
    } finally { save(plan); }
  }

  // After the swap: the TAC it paid the key's own account is made private from there (the pool's wrap, signed by that account with the gas the
  // swap handed it; no wallet is asked), and for a Tacit address the new note is then sent on with a stealth send. Only what this swap paid is
  // taken (what the account held before stays), rounded down to the pool's unit.
  async function shield(plan, { onStep = () => {}, waitOpts } = {}) {
    if (!poolDest(plan)) throw new Error('This swap pays an address.');
    if (!(await mine(plan))) throw new Error(OTHER_KEY);
    // a swap that went out while the tab was closed has no hash here, but a check against the pool found it made (swapDoneAt)
    if (!plan.swapTx && !plan.swapDoneAt) throw new Error('The swap out has not been made yet.');
    const { t, priv, acct, tk, meta } = await tacitAccount();
    if (lc(acct.address) !== lc(plan.to)) throw new Error('Another Tacit key is open than the one this swap pays. Open that one and press again.');
    const scale = BigInt(meta.unitScale || 10n ** 10n);
    await wallet();
    // a wrap sent before: mined, it stands and only the send-on is left; reverted, it is made again; not mined yet, nothing is sent twice
    if (plan.shieldTx) {
      const rc = await rpc('eth_getTransactionReceipt', [plan.shieldTx]).catch(() => null);
      if (!rc) throw new Error('Making it private is still being mined. Press again in a minute.');
      if (rc.status !== '0x1') { plan.shieldTx = null; plan.shielded = null; plan.shieldIndex = null; save(plan); }
    }
    let amount = plan.shieldTx ? BigInt(plan.shielded || 0) : 0n;
    if (!plan.shieldTx) {
      // what the swap paid the account, read from its own transaction: other TAC the account holds or receives is not this plan's
      const rc = plan.swapTx ? await rpc('eth_getTransactionReceipt', [plan.swapTx]).catch(() => null) : null;
      const paid = (rc?.logs || []).filter((l) => lc(l.address) === TAC && l.topics?.[0] === TRANSFER && lc('0x' + String(l.topics[2] || '').slice(26)) === lc(acct.address))
        .reduce((a, l) => a + BigInt(l.data), 0n);
      const held = async () => BigInt(await t.ethCall(TAC, '0x70a08231' + word(acct.address)) || '0x0');
      // known what it paid, the account need only hold that much (another swap's wrap may have moved the balance since); else what came in since the swap
      const before = paid ? 0n : BigInt(plan.tacBefore || 0), least = paid || BigInt(plan.min || 1);
      onStep('waiting for the TAC');
      let got = (await held()) - before;
      for (let i = 0; i < 30 && got < least; i++) { await sleep(4000); got = (await held()) - before; }
      if (got <= 0n || (paid && got < paid)) throw new Error('The TAC has not reached this key’s address yet. Press again in a minute.');
      const take = paid || got;
      amount = take - (take % scale);
      if (amount <= 0n) throw new Error('Too little TAC to make private.');
    }
    plan.state = 'shielding'; plan.err = null; save(plan);
    try {
      if (!plan.shieldTx) {
        onStep('making it private');
        const w = await t.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: tk });
        // kept before the wait, so a wait that runs out is followed by a check of this transaction, not by a second wrap
        // (and with the wrap's index, from which a later press builds the same deposit again to settle it)
        plan.shieldTx = w?.txHash || null; plan.shielded = String(amount); plan.shieldIndex = w?.index ?? null; save(plan);
        onStep('waiting for it to be mined');
        if (w?.txHash) await t.waitReceipt(w.txHash);
      }
      // the wrap only registers a pending deposit: the relay's settle makes it the note the balance holds and the send-on spends. One already settled is left
      // (a wrap kept by an earlier page has no index, and is as it was)
      if (plan.shieldIndex != null) {
        const built = t.buildWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: tk, index: plan.shieldIndex });
        // the pool's status for the deposit: 1 pending, 2 settled
        const state = Number(BigInt(await t.ethCall(t.cfg.pool, '0x7da9874f' + String(built.depositId).replace(/^0x/, '').padStart(64, '0'))));
        if (state !== 1 && state !== 2) throw new Error('The pool does not show the deposit yet. Press again in a minute.');
        if (state === 1) {
          onStep('the relay is settling it');
          await t.submitWrapSettle({ built, depositTx: plan.shieldTx, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000, viaRelay: true } });
        }
      }
      if (plan.dest.kind === 'tacit') {
        if (!sendPrivate) throw new Error('Private now, in your balance; sending it on needs the page.');
        onStep('sending it on');
        const r = await sendPrivate({ asset: String(meta.assetId).toLowerCase(), units: amount / scale, ticker: tk, sendTo: { pubHex: plan.dest.pubHex, name: plan.dest.name || null }, label: `Send ${plan.sym} privately`, say: (k) => onStep(k === 'send' ? 'the relay is sending it on' : k === 'note' ? 'finding the note' : k), waitOpts });
        plan.sendTx = r?.sent?.txHash || null;
      }
      plan.state = 'done'; plan.doneAt = Date.now();
      return plan;
    } catch (e) {
      // wrapped already: a stop in the send-on leaves the TAC private, in the balance
      plan.state = 'held'; plan.err = String(e?.message || e).slice(0, 220); throw e;
    } finally { save(plan); }
  }

  return { start, startBoxed, ahead, adopt, swapIntoPool, depositBoxFor, blend, offer, swapOut, shield, check, reclaimBox, reclaimIntoBox, boxHolds, forget, warm, modules: mods, hopOf, openPool, plans: () => readPlans(store), get proveMs() { return prover.ms; }, get proverReady() { return prover.ready; } };
}
