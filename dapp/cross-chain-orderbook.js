// Cross-chain confidential orderbook (ops/PLAN-confidential-adaptor-swap.md, the second product of the
// adaptor primitive; ops/ARCH-tacit-chain-abstraction.md §"Confidential trading"). A resting offer is
// a maker's willingness to swap one asset's lane for another's; a taker discovers + fills it, and the
// FILL is executed as an adaptor swap (dapp/adaptor-swap.js) — so a cross-chain order is a posted
// adaptor offer a taker completes. Same-chain fills stay native (OP_OTC/OP_BID); this module is the
// CROSS-CHAIN book + matching, with the on-chain fill legs (the guest ops) plugged in at execution.
//
// Offer (maker GIVES `give` to GET `want`):
//   { id, maker, giveAsset, giveAmount, giveLane, wantAsset, wantAmount, wantLane, expiry, remaining }
// `remaining` is in giveAsset units; price = wantAmount/giveAmount (want per give). Partial fills take
// `takeGive ≤ remaining` of the maker's give and pay `takeGive·wantAmount/giveAmount` of want — exact
// multiples only (the OP_BID chunk convention), so no rounding leaks value.

import { makeAdaptorSwap } from './adaptor-swap.js';

const _big = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const lc = (h) => String(h == null ? '' : h).toLowerCase().replace(/^0x/, '');

export function makeCrossChainOrderbook({ swap = makeAdaptorSwap(), resolver = null } = {}) {
  const offers = new Map(); // id -> offer
  let seq = 0;

  // Post a resting cross-chain offer. Validates positivity, distinct lanes (this book is cross-chain),
  // and — if a resolver is wired — that both assets are recognized and live on the declared lanes.
  function post(o) {
    const give = _big(o.giveAmount), want = _big(o.wantAmount);
    if (give <= 0n || want <= 0n) throw new Error('orderbook: amounts must be positive');
    if (o.giveLane === o.wantLane) throw new Error('orderbook: cross-chain offer needs distinct lanes');
    if (resolver) {
      for (const [asset, lane] of [[o.giveAsset, o.giveLane], [o.wantAsset, o.wantLane]]) {
        const d = resolver.resolve(asset);
        if (!d || !d.lanes.includes(lane)) throw new Error(`orderbook: ${lc(asset)} not recognized on lane ${lane}`);
      }
    }
    const id = `xo-${++seq}`;
    offers.set(id, {
      id, maker: o.maker,
      giveAsset: lc(o.giveAsset), giveAmount: give, giveLane: o.giveLane,
      wantAsset: lc(o.wantAsset), wantAmount: want, wantLane: o.wantLane,
      expiry: o.expiry ?? null, remaining: give, status: 'open',
    });
    return id;
  }

  const _live = (o, nowTs) => o.status === 'open' && o.remaining > 0n && (o.expiry == null || nowTs < o.expiry);
  function book(nowTs = Infinity) { return [...offers.values()].filter((o) => _live(o, nowTs)); }
  function get(id) { return offers.get(id) || null; }

  // Quote a taker intent: the taker GIVES `giveAsset` to GET `wantAsset`. Match offers on the opposite
  // pair (maker.give == taker.want AND maker.want == taker.give), ranked by best price FOR THE TAKER
  // (most want received per give paid = highest maker giveAmount/wantAmount). Each match notes the
  // fillable give and the price.
  function quote({ giveAsset, wantAsset, nowTs = Infinity }) {
    const g = lc(giveAsset), w = lc(wantAsset);
    return book(nowTs)
      .filter((o) => o.giveAsset === w && o.wantAsset === g)
      // taker receives `o.giveAsset` (=w); pays `o.wantAsset` (=g). taker's rate = received/paid =
      // o.giveAmount/o.wantAmount → higher is better for the taker.
      .map((o) => ({ offer: o, takerReceivesPerPaid: { num: o.giveAmount, den: o.wantAmount }, fillableReceive: o.remaining }))
      .sort((a, b) => {
        const l = a.takerReceivesPerPaid, r = b.takerReceivesPerPaid;
        const d = r.num * l.den - l.num * r.den; // r > l ?
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      });
  }

  // Fill `takeGive` units of the maker's give (= what the taker RECEIVES), composing an adaptor swap.
  // The taker is the swap INITIATOR (holds `t`, claims first); the maker is the responder. Returns the
  // swap context to drive (lock/verify/claim/counterclaim) + the per-fill leg amounts. Partial-fill:
  // takeGive ≤ remaining and must divide evenly into the price so payWant is exact.
  function fill(offerId, { taker, takeGive, t, nearDeadline, farDeadline, nowTs = Infinity }) {
    const o = offers.get(offerId);
    if (!o || !_live(o, nowTs)) throw new Error('orderbook: offer not fillable');
    const take = _big(takeGive);
    if (take <= 0n || take > o.remaining) throw new Error('orderbook: takeGive out of range');
    if ((take * o.wantAmount) % o.giveAmount !== 0n) throw new Error('orderbook: fill must be an exact price multiple');
    const payWant = (take * o.wantAmount) / o.giveAmount;
    const ctx = swap.open({ t, nearDeadline, farDeadline });
    o.remaining -= take;
    if (o.remaining === 0n) o.status = 'filled';
    return {
      swap: ctx,
      // the taker (initiator) gives `payWant` of wantAsset on wantLane; receives `take` of giveAsset on giveLane
      legs: {
        initiator: { party: taker, asset: o.wantAsset, amount: payWant, lane: o.wantLane }, // taker pays
        responder: { party: o.maker, asset: o.giveAsset, amount: take, lane: o.giveLane },  // maker pays
      },
      offer: o,
    };
  }

  function cancel(offerId, maker) {
    const o = offers.get(offerId);
    if (!o) return false;
    if (o.maker !== maker) throw new Error('orderbook: only the maker can cancel');
    o.status = 'cancelled';
    return true;
  }
  function expireSweep(nowTs) {
    let n = 0;
    for (const o of offers.values()) if (o.status === 'open' && o.expiry != null && nowTs >= o.expiry) { o.status = 'expired'; n++; }
    return n;
  }

  return { post, book, get, quote, fill, cancel, expireSweep };
}
