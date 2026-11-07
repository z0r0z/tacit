// The page side of TacitGasRelay (contracts/src/TacitGasRelay.sol): a wallet with no ETH swaps a token (or enters a Tacit pool) by signing ONE order,
// and pays whoever sends it in TAC or in the token spent. The order authorises exactly one call (hash-bound), once, from this wallet; the relay
// contract pulls the input and the fee with the wallet's permits, makes the call and pays the output to `recipient`, or reverts it all (the wallet
// pays nothing then). This module builds and signs; the page posts the order to the board (POST /gas/order) and the settle relay sends it.
import { keccak_256 } from './vendor/tacit-deps.min.js';

export const GAS_RELAY = { 1: '0x000000197E8f0B64463B2010e568fF42090Af88d' };
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZERO = '0x0000000000000000000000000000000000000000';
// tokens that take an ERC-2612 permit (name and version of their domain); any other token goes through Permit2 once the wallet has approved it
export const PERMIT_TOKENS = {
  [TAC.toLowerCase()]: { name: 'Tacit Token', version: '1' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USD Coin', version: '2' },
};
// a safe upper estimate of what the relay's transaction costs: a snwap swap is about 350k gas, a pool entry about 450k
export const GAS_UNITS = 450000n;
const lc = (s) => String(s || '').toLowerCase();
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

export const ORDER_TYPES = {
  Order: [
    { name: 'payer', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'feeToken', type: 'address' },
    { name: 'fee', type: 'uint256' }, { name: 'tokenOut', type: 'address' }, { name: 'minOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
    { name: 'target', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
  ],
};
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];

/// The order a wallet signs for the call `data` to `target`. `tokenOut` is address(0) for ETH. Everything is a string (JSON-safe).
export function buildOrder({ payer, tokenIn, amountIn, feeToken, fee, tokenOut = ZERO, minOut, recipient, target, data, ttlSecs = 600, now = Math.floor(Date.now() / 1000),
  nonce = BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(8))).slice(2)) }) {
  if (lc(feeToken) !== lc(tokenIn) && lc(feeToken) !== lc(TAC)) throw new Error('the fee is paid in TAC or the token spent');
  if (lc(tokenIn) === lc(tokenOut)) throw new Error('nothing to swap');
  return {
    order: { payer, tokenIn, amountIn: String(amountIn), feeToken, fee: String(fee), tokenOut, minOut: String(minOut), recipient, target, dataHash: hex(keccak_256(bytesOf(data))),
      deadline: String(now + ttlSecs), nonce: String(nonce) },
    data,
  };
}
export const orderTypedData = (order, chainId = 1, relay = GAS_RELAY[chainId]) => ({
  types: { EIP712Domain: DOMAIN, ...ORDER_TYPES }, primaryType: 'Order', domain: { name: 'TacitGasRelay', version: '1', chainId, verifyingContract: relay }, message: order,
});

/// The ERC-2612 permit typed data for `token` (the relay spends up to `value` until `deadline`), or null when the token is not one that takes it here.
export function permitTypedData({ token, owner, value, nonce, deadline, chainId = 1, relay = GAS_RELAY[chainId] }) {
  const t = PERMIT_TOKENS[lc(token)];
  if (!t) return null;
  return {
    types: { EIP712Domain: DOMAIN, Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', domain: { name: t.name, version: t.version, chainId, verifyingContract: token },
    message: { owner, spender: relay, value: String(value), nonce: String(nonce), deadline: String(deadline) },
  };
}
/// The Permit2 batch (one signature for the input and a fee in another token) the relay uses for a token with no ERC-2612.
export function permit2TypedData({ details, owner, deadline, chainId = 1, relay = GAS_RELAY[chainId] }) {
  const batch = { details: details.map((d) => ({ token: d.token, amount: String(d.amount), expiration: String(d.expiration ?? deadline), nonce: String(d.nonce) })), spender: relay, sigDeadline: String(deadline) };
  return {
    batch,
    typed: {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
        PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
      primaryType: 'PermitBatch', domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 }, message: batch,
    },
  };
}
export const splitSig = (sig) => { const h = String(sig).replace(/^0x/, ''); let v = parseInt(h.slice(128, 130), 16); if (v < 27) v += 27; return { v, r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128) }; };
export const NO_PERMIT = { value: '0', deadline: '0', v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32) };
export const NO_P2 = { use: false, batch: { details: [], spender: ZERO, sigDeadline: '0' }, sig: '0x' };

/// The fee, in `feeToken`, that pays for the relay's transaction with a margin: the ETH it costs, sold for the token at `ethToToken(wei)` (a quote
/// of that many wei into the token, a route the page already reads). Rounded up, and never below `floor`.
export async function feeFor({ gasPriceWei, ethToToken, units = GAS_UNITS, marginBps = 15000, floor = 0n }) {
  const wei = (BigInt(gasPriceWei) * units * BigInt(marginBps)) / 10000n;
  const out = await ethToToken(wei);
  if (out == null || out <= 0n) return null;
  return out > floor ? out : floor;
}
/// Whether a wallet should go through the relay: it holds an ERC-20 to spend and not enough ETH to send the swap itself.
export const needsRelay = ({ ethWei, gasPriceWei, units = 300000n }) => BigInt(ethWei) < (BigInt(gasPriceWei) * units * 12n) / 10n;

/// The board calls. `post(path, body)` and `get(path)` are the page's own API helpers.
export const submitOrder = (post, order) => post('/gas/order', { order });

// ── the relay's execute(...) call, encoded here so the page can simulate an order (eth_call) before it is posted ──
const W32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const A32 = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const BYTES = (h) => { const x = String(h).replace(/^0x/, ''); return W32(x.length / 2) + x.padEnd(Math.ceil(x.length / 64) * 64, '0'); };
/// The calldata of TacitGasRelay.execute for a posted order { order, signature, data, inPermit, feePermit, p2 }.
export function encodeExecute(x) {
  const o = x.order, permit = (p) => W32(p.value) + W32(p.deadline) + W32(p.v) + String(p.r).replace(/^0x/, '') + String(p.s).replace(/^0x/, '');
  const head = [A32(o.payer), A32(o.tokenIn), W32(o.amountIn), A32(o.feeToken), W32(o.fee), A32(o.tokenOut), W32(o.minOut), A32(o.recipient), A32(o.target), String(o.dataHash).replace(/^0x/, ''), W32(o.deadline), W32(o.nonce)];
  const p2 = x.p2 && x.p2.use ? x.p2 : { use: false, batch: { details: [], spender: '0x0000000000000000000000000000000000000000', sigDeadline: '0' }, sig: '0x' };
  const batch = W32(96) + A32(p2.batch.spender) + W32(p2.batch.sigDeadline) + W32(p2.batch.details.length) + p2.batch.details.map((d) => A32(d.token) + W32(d.amount) + W32(d.expiration) + W32(d.nonce)).join('');
  const p2enc = W32(p2.use ? 1 : 0) + W32(96) + W32(96 + batch.length / 2) + batch + BYTES(p2.sig);
  const sig = BYTES(x.signature), data = BYTES(x.data);
  const base = 25 * 32;                                                   // 12 (order) + 2 offsets + 10 (two permits) + 1 offset
  const offSig = base, offData = offSig + sig.length / 2, offP2 = offData + data.length / 2;
  return '0x' + SEL_EXECUTE + head.join('') + W32(offSig) + W32(offData) + permit(x.inPermit) + permit(x.feePermit) + W32(offP2) + sig + data + p2enc;
}
const SEL_EXECUTE = '7e75f5be';

// ── a token deposit into a Tacit device pool, sent by the relay and paid for in the token ──
const RACED_SELECTORS = ['607447de', 'a151b2a2', '26747c9d', 'efe99026'];   // StaleRoot, WrongInsertionIndex, UnknownMembershipRoot, BadIntent: the pool moved, prove again
const PROBE_FROM = '0x000000000000000000000000000000000007a0f0';
export const DEPOSIT_GAS = 600000n;
export const kyberEthTo = async (token, wei) => {
  const r = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?${new URLSearchParams({ tokenIn: '0xEeeeeEeeeEeEeeEeEeeEeEEEeeeeEeeeeeeeEEeE', tokenOut: token, amountIn: String(wei) })}`, { signal: AbortSignal.timeout(8000) }).then((q) => (q.ok ? q.json() : null)).catch(() => null);
  const o = r?.data?.routeSummary?.amountOut;
  return /^\d+$/.test(String(o ?? '')) ? BigInt(o) : null;
};
/// { fee, gasPrice } when the account holds too little ETH to send a deposit and the relay can pay for it in `token` (one that takes an ERC-2612 permit), else null.
/// `rpc(method, params)` reads Ethereum; `ethOf()` is the paying account's ETH balance (null when unknown).
export async function relayDepositPlan({ rpc, ethOf, token, chainId = 1 }) {
  if (chainId !== 1 || !PERMIT_TOKENS[lc(token)]) return null;
  if (String(await rpc('eth_getCode', [GAS_RELAY[1], 'latest']).catch(() => '0x')).length <= 2) return null;
  const [eth, gasPrice] = await Promise.all([ethOf(), rpc('eth_gasPrice', []).then(BigInt)]);
  if (eth == null || !needsRelay({ ethWei: eth, gasPriceWei: gasPrice, units: DEPOSIT_GAS })) return null;
  const fee = await feeFor({ gasPriceWei: gasPrice, units: DEPOSIT_GAS, ethToToken: (w) => kyberEthTo(token, w) });
  return fee == null ? null : { fee, gasPrice };
}
/// The signer a pool wallet (dapp/evm-pool-wallet.js) deposits through instead of the account's own transaction: `send` turns the router call into a relay
/// order and returns the relay's transaction hash once it has run (null when the pool moved since the proof: the wallet proves again).
/// sign.permit({ token, name, version, owner, spender, value, nonce, deadline }) → { v, r, s }; sign.order(order) → a 65-byte signature; guard() throws when the page moved on.
/// `now()` is the chain's time in seconds where the page keeps it; without it the latest block's time is read.
export function relaySigner({ address, token, router, symbol, amount, plan, rpc, step, sign, guard = () => {}, api = 'https://api.tacit.finance', decimals = 18, now = null }) {
  const relay = GAS_RELAY[1], meta = PERMIT_TOKENS[lc(token)];
  const fmt = (v) => { const d = 10n ** BigInt(decimals), w = BigInt(v) / d, f = (BigInt(v) % d).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, ''); return f ? `${w}.${f}` : String(w); };
  // the order's deadline, and the wait for it, go by the clock the contract reads (the chain's), never the device's: one that runs ahead would call a live order lapsed, one behind would sign a deadline already past
  const clockOf = async () => {
    if (now) return now();
    const b = await rpc('eth_getBlockByNumber', ['latest', false]).catch(() => null);
    if (b?.timestamp == null) throw new Error('The network’s time could not be read, so nothing was sent. Try again.');
    return Number(BigInt(b.timestamp));
  };
  return { address, relayed: true, send: async ({ to, data }) => {
    guard();
    if (lc(to) !== lc(router)) throw new Error('The relay only sends the deposit to the pool’s router.');
    const clock = await clockOf(), total = BigInt(amount) + plan.fee, dl = clock + 900;
    const { order } = buildOrder({ payer: address, tokenIn: token, amountIn: amount, feeToken: token, fee: plan.fee, tokenOut: ZERO, minOut: 0n, recipient: address, target: router, data, now: clock });
    step(`Sign the ${symbol} deposit and its ${fmt(plan.fee)} ${symbol} network fee. No ETH is needed`);
    const nonce = BigInt(await rpc('eth_call', [{ to: token, data: '0x7ecebe00' + A32(address) }, 'latest']));
    const p = await sign.permit({ token, name: meta.name, version: meta.version, owner: address, spender: relay, value: total, nonce, deadline: dl });
    const signature = await sign.order(order);
    const posted = { order, data, signature, inPermit: { value: String(total), deadline: String(dl), v: p.v, r: p.r, s: p.s }, feePermit: NO_PERMIT, p2: NO_P2 };
    // the order is run here first, as the relay would run it: a pool that moved since the proof is proved again, nothing else is posted
    try { await rpc('eth_call', [{ from: PROBE_FROM, to: relay, data: encodeExecute(posted) }, 'latest']); }
    catch (e) {
      const d = String(e?.data?.data ?? e?.data ?? e?.message ?? '');
      if (RACED_SELECTORS.some((x) => d.includes(x))) return null;
      throw new Error(`This deposit would not go through, so nothing was sent${d ? ` (${d.slice(0, 40)})` : ''}. Try again.`);
    }
    step('Sending it to the relay');
    const r = await fetch(`${api}/gas/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: posted }), signal: AbortSignal.timeout(15e3) }).then((q) => q.json()).catch(() => null);
    // an answer that refuses the order means nothing was posted; no answer at all (a timeout, a dropped line) may be an order the relay has, so it is waited for like one
    if (r && !r.ok) throw new Error(`The relay did not take the order${r.error ? `: ${r.error}` : ''}. Nothing was spent.`);
    if (!r) step('The relay did not answer. Checking whether it has the order');
    const usedSel = '0xad04dc3f' + A32(address) + W32(order.nonce), t0 = Date.now(), end = t0 + Math.max(60, Number(order.deadline) - clock + 15) * 1000;
    let done = false, read = false;
    while (Date.now() < end && !done) {
      await new Promise((q) => setTimeout(q, 3000));
      done = BigInt(await rpc('eth_call', [{ to: relay, data: usedSel }, 'latest']).then((x) => { read = true; return x; }, () => { read = false; return '0x0'; })) === 1n;
      if (!done) step(`Waiting for the relay to send it (${Math.round((Date.now() - t0) / 1000)} s). Nothing leaves your account unless the deposit lands`);
    }
    // (a last read that failed says nothing of whether the relay sent it: another try could send twice)
    if (!done && !read) throw new Error('The relay’s answer could not be read, so it may have sent the order. Check your balance before sending anything more.');
    if (!done) throw new Error(`The relay did not send it${r ? '' : ' (it never answered)'}, and the order has now lapsed, so nothing was spent. Try again.`);
    // the contract's Executed event for this payer and nonce, looked for a few times over: a node can answer a moment after the order ran with no log yet, or fail one read
    // (the lookup of its transaction is a courtesy: nothing in it may fail an order that ran)
    let hash = null;
    for (let i = 0; i < 5 && !hash; i++) {
      if (i) await new Promise((q) => setTimeout(q, 1000));
      hash = await rpc('eth_blockNumber', []).then((h) => rpc('eth_getLogs', [{ address: relay, topics: ['0x533053a5fad9470861fb5df750d47e5f011faa03daba05299fe4bdc65f52d519', '0x' + A32(address), null, '0x' + W32(order.nonce)], fromBlock: '0x' + (BigInt(h) > 200n ? BigInt(h) - 200n : 0n).toString(16), toBlock: 'latest' }])).then((l) => l?.[0]?.transactionHash || null, () => null);
    }
    if (!hash) throw new Error('The relay sent it, but its transaction could not be found. Check your balance in a moment.');
    return hash;
  } };
}

// ── an order the wallet signs for any call, sent by the relay and waited for ──
/// Signs `order` (buildOrder's, with its `data`) with the permits the relay pulls with, posts it to the board and waits until the contract has run it. The permits are an ERC-2612
/// permit for each token the relay pulls (the input, and TAC when the fee is TAC), or, for an input with none, one Permit2 batch for it (the wallet has approved Permit2 for it
/// already). The order is run here first as the relay will run it (an eth_call), so one that would revert is never posted. → the relay's transaction hash. Every refusal or lapse
/// says nothing was spent, and carries `nothingSpent`: a posted order that may still run is never called refused.
/// `sign.typed(typedData)` → a 65-byte signature; `rpc(method, params)` reads Ethereum; `step(text)` says each stage; `guard()` throws when the page moved on; `minWait` is the least
/// it waits for the relay, in seconds, however soon the order lapses, and `lookupMs` the pause between reads for the relay's transaction (a test shortens both); `post(body)` stands in for
/// the board's POST.
export async function placeOrder({ order, data, from, symbol = 'the token', sign, rpc, step = () => {}, guard = () => {}, api = 'https://api.tacit.finance', now = () => Math.floor(Date.now() / 1000), pollMs = 3000, minWait = 60, lookupMs = 1000, post = null }) {
  const relay = GAS_RELAY[1], tokenIn = order.tokenIn, feeToken = order.feeToken, fee = BigInt(order.fee), amountIn = BigInt(order.amountIn);
  const total = lc(feeToken) === lc(tokenIn) ? amountIn + fee : amountIn;
  const stopped = (m) => Object.assign(new Error(m), { nothingSpent: true });
  const dl = now() + 900, word = (a) => A32(a);
  let inPermit = NO_PERMIT, feePermit = NO_PERMIT, p2 = NO_P2;
  guard();
  if (PERMIT_TOKENS[lc(tokenIn)]) {
    const nonceOf = async (t) => BigInt(await rpc('eth_call', [{ to: t, data: '0x7ecebe00' + word(from) }, 'latest']));
    const sp = async (t, value) => ({ value: String(value), deadline: String(dl), ...splitSig(await sign.typed(permitTypedData({ token: t, owner: from, value, nonce: await nonceOf(t), deadline: dl }))) });
    inPermit = await sp(tokenIn, total);
    if (lc(feeToken) !== lc(tokenIn) && fee !== 0n) { if (!PERMIT_TOKENS[lc(feeToken)]) throw stopped('The fee token takes no permit. Nothing was spent.'); feePermit = await sp(feeToken, fee); }
  } else {
    if (lc(feeToken) !== lc(tokenIn)) throw stopped(`The fee is paid in ${symbol} here: ${symbol} takes no permit. Nothing was spent.`);
    const allow = BigInt(await rpc('eth_call', [{ to: tokenIn, data: '0xdd62ed3e' + word(from) + word(PERMIT2) }, 'latest']));
    if (allow < total) throw stopped(`${symbol} has not been approved for Permit2 from this wallet yet, which takes one transaction with a little ETH. Nothing was sent.`);
    const info = String(await rpc('eth_call', [{ to: PERMIT2, data: '0x927da105' + word(from) + word(tokenIn) + word(relay) }, 'latest'])).replace(/^0x/, '');
    const pn = BigInt('0x' + (info.slice(128, 192) || '0'));
    const b = permit2TypedData({ details: [{ token: tokenIn, amount: total, expiration: dl, nonce: pn }], owner: from, deadline: dl });
    p2 = { use: true, batch: b.batch, sig: await sign.typed(b.typed) };
  }
  guard();
  const signature = await sign.typed(orderTypedData(order));
  const posted = { order, data, signature, inPermit, feePermit, p2 };
  // the order is run here as the relay would run it: one that would revert is not posted, and costs nothing
  try { await rpc('eth_call', [{ from: PROBE_FROM, to: relay, data: encodeExecute(posted) }, 'latest']); }
  catch (e) {
    const d = String(e?.data?.data ?? e?.data ?? e?.message ?? '');
    throw stopped(`This would not go through, so nothing was sent${d ? ` (${d.slice(0, 40)})` : ''}. Try again.`);
  }
  // where the order's run can be looked for: no earlier than now (a short range, which the nodes that limit one will serve)
  const since = await rpc('eth_blockNumber', []).then((h) => BigInt(h), () => null);
  step('Sending it to the relay');
  const send = post || ((body) => fetch(`${api}/gas/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15e3) }).then((q) => q.json()).catch(() => null));
  const r = await send({ order: posted });
  // the relay saying no is final; no answer at all (a timeout, a dropped line) may be an order the relay has, so it is waited for like one
  if (r && !r.ok) throw stopped(`The relay did not take the order${r.error ? `: ${r.error}` : ''}. Nothing was spent.`);
  if (!r) step('The relay did not answer. Checking whether it has the order');
  const usedSel = '0xad04dc3f' + A32(from) + W32(order.nonce), t0 = Date.now(), end = t0 + Math.max(minWait, Number(order.deadline) - now() + 15) * 1000;
  let done = false, read = false;
  while (Date.now() < end && !done) {
    await new Promise((q) => setTimeout(q, pollMs));
    done = BigInt(await rpc('eth_call', [{ to: relay, data: usedSel }, 'latest']).then((x) => { read = true; return x; }, () => { read = false; return '0x0'; })) === 1n;
    if (!done) step(`Waiting for the relay to send it (${Math.round((Date.now() - t0) / 1000)} s). Nothing leaves your wallet unless it lands`);
  }
  // only the last read, taken once the order can no longer run, says it lapsed unsent; one that failed says nothing of whether the relay ran it in its final seconds (another try could send twice)
  if (!done && !read) throw new Error('The relay’s answer could not be read, so it may have sent the order. Check again in a moment before sending anything more.');
  if (!done) throw stopped(`The relay did not send it before the order lapsed${r ? '' : ' (it never answered)'}. Nothing was spent. Try again.`);
  // the contract's Executed event for this payer and nonce, a few times over: a node can answer a moment after the order ran with no log yet, or fail one read
  const head = since ?? (await rpc('eth_blockNumber', []).then((h) => BigInt(h) - 50n, () => null));
  let hash = null;
  for (let i = 0; head != null && i < 5 && !hash; i++) {
    if (i) await new Promise((q) => setTimeout(q, lookupMs));
    hash = await rpc('eth_getLogs', [{ address: relay, topics: ['0x533053a5fad9470861fb5df750d47e5f011faa03daba05299fe4bdc65f52d519', '0x' + A32(from), null, '0x' + W32(order.nonce)], fromBlock: '0x' + (head > 3n ? head - 3n : 0n).toString(16), toBlock: 'latest' }]).then((l) => l?.[0]?.transactionHash || null, () => null);
  }
  return hash;
}
