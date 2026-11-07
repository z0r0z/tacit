// The leader's fee: every spend pays the leader that lands it a note to the leader's chain address, worth at least the fee the leader
// quotes (GET /fee on its node). The leader opens each waiting spend's memos with its own keys, sums what is its own, and builds blocks of
// the spends that pay.
//
//   fee (units of 1e-8 TAC) = max(FEE_MIN, (FEE_SPEND_GAS + FEE_BLOCK_GAS / FEE_BATCH) × (base fee + FEE_TIP_WEI) × TAC per wei
//                                          × (1 + FEE_MARGIN_BPS / 10,000))
//
// TAC per wei is the confidential pool's TAC/tETH pair (`pools(id)` on the pool contract: both reserves in units of 1e-8, a tETH unit
// being 1e10 wei), the median of the last FEE_PRICE_READS reads, so one moved price does not set the fee; FEE_TAC_PER_ETH stands in while
// the pool cannot be read. A spend pays if its notes to the leader are worth at least the lowest fee quoted in the last FEE_WINDOW_SECS,
// so a wallet that proved against a quote a minute old is not refused.
//
//   LEADER_CHAIN_SEED  32 bytes (hex): the leader's chain keys; with none, no fee is asked
//   FEE_SPEND_GAS (45000)  FEE_BLOCK_GAS (300000)  FEE_BATCH (8)  FEE_TIP_WEI (default: the tip the leader offers, its node's suggestion)  FEE_MARGIN_BPS (2000)
//   FEE_MIN (100000 units, 0.001 TAC)  FEE_TAC_PER_ETH (none)  FEE_WINDOW_SECS (600)  FEE_PRICE_READS (5)

import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeChainWallet, worthOf } from '../dapp/tacit-chain-wallet.js';
import { openMemo, MEMO_LEN } from '../dapp/tacit-chain-memo.js';

export const PRICE_POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
/// The TAC/tETH pair on it (0.3%): keccak(tETH ‖ TAC ‖ be32(30)), lower id first (dapp/community-ops.js).
export const TAC_ETH_POOL_ID = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
export const ETH_ASSET_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const SEL_POOLS = '0xb5217bb4'; // pools(bytes32) → init, assetA, assetB, reserveA, reserveB, feeBps, totalShares
const ETH_UNIT_WEI = 10n ** 10n;
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (xs) => POSEIDON[xs.length](xs);
const bytesOf = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g) || [], (x) => parseInt(x, 16));
const ceilDiv = (a, b) => (a + b - 1n) / b;

/// The fee's terms from the environment.
export function feeTerms(env = {}) {
  const n = (k, d) => BigInt(env[k] || d);
  let fallback = null;
  if (env.FEE_TAC_PER_ETH) {
    const [i, f = ''] = String(env.FEE_TAC_PER_ETH).split('.');
    fallback = [BigInt(i || 0) * 10n ** 8n + BigInt((f + '00000000').slice(0, 8)), 10n ** 18n];   // TAC units per wei, as a fraction
  }
  return {
    spendGas: n('FEE_SPEND_GAS', 45000), sweepGas: n('FEE_SWEEP_GAS', 150000), blockGas: n('FEE_BLOCK_GAS', 300000), batch: n('FEE_BATCH', 8), tipWei: env.FEE_TIP_WEI ? n('FEE_TIP_WEI', 0) : null,
    marginBps: n('FEE_MARGIN_BPS', 2000), min: n('FEE_MIN', 100_000), fallback, window: Number(env.FEE_WINDOW_SECS || 600), reads: Number(env.FEE_PRICE_READS || 5),
    pool: env.FEE_POOL || PRICE_POOL, poolId: env.FEE_POOL_ID || TAC_ETH_POOL_ID,
  };
}

/// TAC units per wei from the pair's reserves, as a fraction [tac units, wei]; null when the pair cannot be read or is empty.
export async function readPrice(call, terms) {
  const h = String(await call(terms.pool, SEL_POOLS + terms.poolId.slice(2))).replace(/^0x/, '');
  const w = (i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));
  if (h.length < 64 * 7 || w(0) === 0n) return null;
  const aIsEth = '0x' + h.slice(64, 128) === ETH_ASSET_ID;
  const [eth, tac] = aIsEth ? [w(3), w(4)] : [w(4), w(3)];
  return eth > 0n && tac > 0n ? [tac, eth * ETH_UNIT_WEI] : null;
}

/// The fee in units for a base fee (wei) and a price (TAC units per wei, a fraction), at least the minimum.
/// What sending a holder's permit sweep costs the leader, in token wei (the permit's `fee` is in the token's units): FEE_SWEEP_GAS at the
/// base fee and tip, at TAC's price, with the margin; the spend fee's minimum (in units) when there is no price.
export function sweepFeeOf(terms, baseFee, price, tip = null) {
  if (!price) return terms.min * 10n ** 10n;
  const wei = terms.sweepGas * (BigInt(baseFee) + BigInt(tip ?? terms.tipWei ?? 100_000_000n));
  const units = ceilDiv(ceilDiv(wei * price[0], price[1]) * (10_000n + terms.marginBps), 10_000n);
  return (units > terms.min ? units : terms.min) * 10n ** 10n;
}

export function feeOf(terms, baseFee, price, tip = null) {
  if (!price) return terms.min;
  const gas = terms.spendGas + ceilDiv(terms.blockGas, terms.batch);
  const wei = gas * (BigInt(baseFee) + BigInt(tip ?? terms.tipWei ?? 100_000_000n));
  const units = ceilDiv(ceilDiv(wei * price[0], price[1]) * (10_000n + terms.marginBps), 10_000n);
  return units > terms.min ? units : terms.min;
}

/// The units of `notes` (as a waiting spend's detail gives them: each output slot's leaf and memo) that are this leader's, by opening each
/// memo with its keys and checking the leaf it gives is the slot's.
export function paidIn(desk, detail) {
  let got = 0n;
  (detail.memos || []).forEach((m, i) => {
    if (!m) return;
    const memo = bytesOf(m);
    if (memo.length !== MEMO_LEN) return;
    const opened = openMemo(memo, desk.keys.memo.secret);
    if (!opened) return;
    const own = desk.wallet.Z.ownedKeys(desk.keys.zk, opened.s);
    if (desk.wallet.Z.leafOf(desk.asset, opened.value, own.npk, own.rho) === BigInt(detail.leaves[i])) got += opened.value;
  });
  return got;
}

/// The leader's fee desk: its chain keys and address, the fees it has quoted, and whether a spend pays.
///   desk.quote({ now, baseFee, price }) → the quote GET /fee serves      desk.check(detail, rate, now) → { ok, paid, need }
export function makeFeeDesk({ seed, chain, asset, terms }) {
  const wallet = makeChainWallet({ poseidon, prover: null, chain, asset: BigInt(asset) });
  const keys = wallet.keys(bytesOf(seed));
  if (keys.seed.length !== 32) throw new Error('LEADER_CHAIN_SEED is 32 bytes');
  const address = wallet.encodeAddress(wallet.address(keys));
  const quoted = [];   // [{ fee, at }], the last FEE_WINDOW_SECS
  const prices = [];
  const desk = { wallet, keys, address, asset: BigInt(asset), terms, quoted };

  /// The fee now, from a fresh price read (null when none could be made: the median of what was read before, else the fallback).
  desk.quote = ({ now, baseFee, price, tip = null }) => {
    if (price) { prices.push(price); while (prices.length > terms.reads) prices.shift(); }
    const sorted = [...prices].sort((a, b) => (a[0] * b[1] < b[0] * a[1] ? -1 : a[0] * b[1] > b[0] * a[1] ? 1 : 0));
    const use = sorted.length ? sorted[(sorted.length - 1) >> 1] : terms.fallback;
    const fee = feeOf(terms, baseFee, use, tip);
    const sweepFee = sweepFeeOf(terms, baseFee, use, tip);
    quoted.push({ fee, sweepFee, at: now });
    while (quoted.length && quoted[0].at < now - terms.window) quoted.shift();
    return { address, fee: String(fee), sweepFee: String(sweepFee), at: now, window: terms.window };
  };
  /// The least a holder's permit may pay for its sweep now (token wei): the lowest quoted in the window (null before the first quote).
  desk.sweepAccepted = (now) => {
    const live = quoted.filter((q) => q.at >= now - terms.window);
    return live.length ? live.reduce((m, q) => (q.sweepFee < m ? q.sweepFee : m), live[0].sweepFee) : null;
  };
  /// The least a spend may pay now: the lowest fee quoted in the window (null before the first quote).
  desk.accepted = (now) => {
    const live = quoted.filter((q) => q.at >= now - terms.window);
    return live.length ? live.reduce((m, q) => (q.fee < m ? q.fee : m), live[0].fee) : null;
  };
  /// Whether a waiting spend pays: what its notes to the leader are worth at `rate` against the least accepted now.
  desk.check = (detail, rate, now) => {
    const need = desk.accepted(now);
    const shares = paidIn(desk, detail);
    const paid = worthOf(shares, rate);
    return { ok: need != null && paid >= need, paid, need, shares };
  };
  return desk;
}

/// Checks the waiting spends `ids` the leader has not seen pay yet: each that pays joins `paying`; each that pays less is dropped from the
/// node's mempool, refused for good with its receipt saying why. `node(method, path, body)` calls the leader's node (its own routes).
export async function admitPaying({ desk, node, paying, ids, now = Math.floor(Date.now() / 1000), log = () => {} }) {
  for (const id of [...paying]) if (!ids.includes(id)) paying.delete(id);
  const fresh = ids.filter((id) => !paying.has(id));
  if (!fresh.length) return [];
  const [detail, st] = await Promise.all([node('POST', '/pending', { memos: fresh }), node('GET', '/state')]);
  const rate = { pool: BigInt(st.pool), shares: BigInt(st.shares) };
  const refused = [];
  for (const s of detail.spends.filter((x) => fresh.includes(x.id) && x.memos)) {
    const r = desk.check(s, rate, now);
    if (r.need == null) continue;
    if (r.ok) { paying.add(s.id); continue; }
    await node('POST', '/drop', { ids: [s.id], reason: `it pays this leader ${r.paid} units, less than its fee of ${r.need}: ask for the fee again (GET /fee) and add it` });
    refused.push(s.id);
    log({ refused: s.id, paid: String(r.paid), fee: String(r.need) });
  }
  return refused;
}
