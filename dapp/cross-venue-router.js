// Cross-venue router — dapp-side best-execution planner across Tacit settlement venues.
//
// This is intentionally pure quote orchestration. It does not sign, prove, settle, or mutate books/pools.
// Execution layers consume the returned `plan`:
//   - same-lane AMM venues build swap/route ops;
//   - cross-chain-orderbook venues drive adaptor-swap fills;
//   - public EVM venues hand calldata to ConfidentialRouter/zRouter.
//
// Unit contract: all amounts are in Tacit's in-system base units for the asset. Venue adapters are
// responsible for scaling public ERC20 or underlying units before calling this router.

const lc = (h) => String(h == null ? '' : h).toLowerCase().replace(/^0x/, '');
const _big = (x) => (typeof x === 'bigint' ? x : BigInt(x));

export const VENUE_KINDS = Object.freeze({
  BTC_AMM: 'btc-amm',
  EVM_CONFIDENTIAL_AMM: 'evm-confidential-amm',
  EVM_PUBLIC_AMM: 'evm-public-amm',
  CROSS_CHAIN_ORDERBOOK: 'cross-chain-orderbook',
  CROSS_VENUE_ROUTE: 'cross-venue-route',
});

export const LANES = Object.freeze({ BITCOIN: 'bitcoin', ETHEREUM: 'ethereum' });

function assertPositiveAmount(name, amount) {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error(`${name}: amount must be a positive bigint`);
}

function ratioCmp(aNum, aDen, bNum, bDen) {
  const d = aNum * bDen - bNum * aDen;
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

function constantProductOut(amountIn, reserveIn, reserveOut, feeBps = 30) {
  const ain = _big(amountIn), rin = _big(reserveIn), rout = _big(reserveOut);
  assertPositiveAmount('constantProductOut', ain);
  if (rin <= 0n || rout <= 0n) return 0n;
  const fee = BigInt(feeBps);
  if (fee < 0n || fee >= 10000n) throw new Error('constantProductOut: feeBps out of range');
  const inAfterFee = ain * (10000n - fee);
  return (rout * inAfterFee) / (rin * 10000n + inAfterFee);
}

// Generic constant-product venue adapter. Use this for Bitcoin AMM, EVM confidential AMM, or public
// EVM AMM snapshots by setting `kind`/`lane`/`id`.
//
// pools: [{ id?, assetA, assetB, reserveA, reserveB, feeBps }]
export function makeConstantProductVenue({ id, kind = VENUE_KINDS.BTC_AMM, lane = LANES.BITCOIN, pools = [] }) {
  const venueId = id || `${kind}:${lane}`;
  const normPools = pools.map((p, i) => ({
    id: p.id || p.poolId || p.pool_id || `${venueId}-pool-${i + 1}`,
    assetA: lc(p.assetA || p.asset_A || p.asset_a),
    assetB: lc(p.assetB || p.asset_B || p.asset_b),
    reserveA: _big(p.reserveA ?? p.R_A ?? p.reserve_a),
    reserveB: _big(p.reserveB ?? p.R_B ?? p.reserve_b),
    feeBps: Number(p.feeBps ?? p.fee_bps ?? 30),
    raw: p,
  }));
  return {
    id: venueId,
    kind,
    laneIn: lane,
    laneOut: lane,
    quoteHops({ assetIn, laneIn, amountIn }) {
      const ain = lc(assetIn), amt = _big(amountIn);
      assertPositiveAmount('venue.quoteHops', amt);
      if (laneIn !== lane) return [];
      const out = [];
      for (const p of normPools) {
        const dirs = [
          { ok: p.assetA === ain, assetOut: p.assetB, reserveIn: p.reserveA, reserveOut: p.reserveB, direction: 'A_TO_B' },
          { ok: p.assetB === ain, assetOut: p.assetA, reserveIn: p.reserveB, reserveOut: p.reserveA, direction: 'B_TO_A' },
        ];
        for (const d of dirs) {
          if (!d.ok) continue;
          const amountOut = constantProductOut(amt, d.reserveIn, d.reserveOut, p.feeBps);
          if (amountOut <= 0n) continue;
          out.push({
            venueId,
            kind,
            laneIn: lane,
            laneOut: lane,
            assetIn: ain,
            assetOut: d.assetOut,
            amountIn: amt,
            usedIn: amt,
            unusedIn: 0n,
            amountOut,
            plan: {
              type: 'constant-product-swap',
              poolId: p.id,
              direction: d.direction,
              feeBps: p.feeBps,
              assetA: p.assetA,
              assetB: p.assetB,
              reserveAPre: p.reserveA,
              reserveBPre: p.reserveB,
            },
          });
        }
      }
      return out;
    },
    quoteExactIn({ assetIn, laneIn, assetOut, laneOut, amountIn }) {
      const ain = lc(assetIn), aout = lc(assetOut), amt = _big(amountIn);
      assertPositiveAmount('venue.quoteExactIn', amt);
      if (laneIn !== lane || laneOut !== lane || ain === aout) return null;
      let best = null;
      for (const p of normPools) {
        const forward = p.assetA === ain && p.assetB === aout;
        const reverse = p.assetB === ain && p.assetA === aout;
        if (!forward && !reverse) continue;
        const reserveIn = forward ? p.reserveA : p.reserveB;
        const reserveOut = forward ? p.reserveB : p.reserveA;
        const amountOut = constantProductOut(amt, reserveIn, reserveOut, p.feeBps);
        if (amountOut <= 0n) continue;
        const q = {
          venueId,
          kind,
          laneIn: lane,
          laneOut: lane,
          assetIn: ain,
          assetOut: aout,
          amountIn: amt,
          usedIn: amt,
          unusedIn: 0n,
          amountOut,
          plan: {
            type: 'constant-product-swap',
            poolId: p.id,
            direction: forward ? 'A_TO_B' : 'B_TO_A',
            feeBps: p.feeBps,
            assetA: p.assetA,
            assetB: p.assetB,
            reserveAPre: p.reserveA,
            reserveBPre: p.reserveB,
          },
        };
        if (!best || q.amountOut > best.amountOut) best = q;
      }
      return best;
    },
  };
}

// Cross-chain orderbook venue adapter. It wraps dapp/cross-chain-orderbook.js `quoteExactIn()`.
export function makeOrderbookVenue({ id = 'cross-chain-orderbook', orderbook }) {
  if (!orderbook || typeof orderbook.quoteExactIn !== 'function') {
    throw new Error('makeOrderbookVenue: orderbook with quoteExactIn required');
  }
  return {
    id,
    kind: VENUE_KINDS.CROSS_CHAIN_ORDERBOOK,
    quoteExactIn({ assetIn, laneIn, assetOut, laneOut, amountIn, nowTs = Infinity, requireFullFill = true }) {
      if (laneIn === laneOut) return null;
      const q = orderbook.quoteExactIn({
        giveAsset: assetIn,
        wantAsset: assetOut,
        amountIn,
        giveLane: laneIn,
        wantLane: laneOut,
        nowTs,
        requireFullFill,
      });
      if (!q) return null;
      return {
        venueId: id,
        kind: VENUE_KINDS.CROSS_CHAIN_ORDERBOOK,
        laneIn,
        laneOut,
        assetIn: lc(assetIn),
        assetOut: lc(assetOut),
        amountIn: _big(amountIn),
        usedIn: q.usedIn,
        unusedIn: q.unusedIn,
        amountOut: q.amountOut,
        plan: { type: 'orderbook-sweep', fills: q.fills },
      };
    },
  };
}

function routeKind(hops) {
  const k = new Set(hops.map((h) => h.kind));
  return k.size === 1 ? hops[0].kind : VENUE_KINDS.CROSS_VENUE_ROUTE;
}

function composeHopRoute({ start, targetAsset, targetLane, hops }) {
  const last = hops[hops.length - 1];
  if (!last || last.assetOut !== targetAsset || last.laneOut !== targetLane) return null;
  return {
    venueId: hops.map((h) => h.venueId).join('>'),
    kind: routeKind(hops),
    laneIn: start.laneIn,
    laneOut: targetLane,
    assetIn: start.assetIn,
    assetOut: targetAsset,
    amountIn: start.amountIn,
    usedIn: start.amountIn,
    unusedIn: 0n,
    amountOut: last.amountOut,
    plan: {
      type: 'constant-product-route',
      hops: hops.map((h) => ({
        venueId: h.venueId,
        kind: h.kind,
        laneIn: h.laneIn,
        laneOut: h.laneOut,
        assetIn: h.assetIn,
        assetOut: h.assetOut,
        amountIn: h.amountIn,
        amountOut: h.amountOut,
        poolId: h.plan.poolId,
        direction: h.plan.direction,
        feeBps: h.plan.feeBps,
        assetA: h.plan.assetA,
        assetB: h.plan.assetB,
        reserveAPre: h.plan.reserveAPre,
        reserveBPre: h.plan.reserveBPre,
      })),
    },
  };
}

function multihopQuotes({ venues, req, maxHops }) {
  if (maxHops <= 1 || req.laneIn !== req.laneOut) return [];
  const out = [];
  const start = { assetIn: req.assetIn, laneIn: req.laneIn, amountIn: req.amountIn };
  const q = [{ asset: req.assetIn, lane: req.laneIn, amount: req.amountIn, hops: [], seenAssets: new Set([req.assetIn]), seenPools: new Set() }];
  while (q.length) {
    const st = q.shift();
    if (st.hops.length >= maxHops) continue;
    for (const v of venues) {
      if (typeof v.quoteHops !== 'function') continue;
      for (const hop of v.quoteHops({ assetIn: st.asset, laneIn: st.lane, amountIn: st.amount })) {
        const poolKey = `${hop.venueId}:${hop.plan.poolId}`;
        if (st.seenPools.has(poolKey)) continue;
        if (st.seenAssets.has(hop.assetOut) && hop.assetOut !== req.assetOut) continue;
        const hops = [...st.hops, hop];
        if (hop.assetOut === req.assetOut && hop.laneOut === req.laneOut) {
          if (hops.length > 1) out.push(composeHopRoute({ start, targetAsset: req.assetOut, targetLane: req.laneOut, hops }));
          continue;
        }
        const seenAssets = new Set(st.seenAssets); seenAssets.add(hop.assetOut);
        const seenPools = new Set(st.seenPools); seenPools.add(poolKey);
        q.push({ asset: hop.assetOut, lane: hop.laneOut, amount: hop.amountOut, hops, seenAssets, seenPools });
      }
    }
  }
  return out.filter(Boolean);
}

export function makeCrossVenueRouter({ venues = [], maxHops = 4 } = {}) {
  const list = [...venues];
  function addVenue(v) {
    if (!v || typeof v.quoteExactIn !== 'function') throw new Error('router: venue must implement quoteExactIn');
    list.push(v);
    return v;
  }
  function quoteExactIn({ assetIn, laneIn, assetOut, laneOut, amountIn, nowTs = Infinity, requireFullFill = true }) {
    const amt = _big(amountIn);
    assertPositiveAmount('router.quoteExactIn', amt);
    const req = { assetIn: lc(assetIn), laneIn, assetOut: lc(assetOut), laneOut, amountIn: amt, nowTs, requireFullFill };
    const quotes = [];
    for (const v of list) {
      const q = v.quoteExactIn(req);
      if (q && q.amountOut > 0n) quotes.push(q);
    }
    quotes.push(...multihopQuotes({ venues: list, req, maxHops }));
    return rankQuotes(quotes);
  }
  function bestExactIn(req) {
    return quoteExactIn(req)[0] || null;
  }
  return { addVenue, venues: () => [...list], quoteExactIn, bestExactIn };
}

export function rankQuotes(quotes) {
  return [...(quotes || [])].sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    const au = a.unusedIn ?? 0n, bu = b.unusedIn ?? 0n;
    if (au !== bu) return au < bu ? -1 : 1;
    const av = a.venueId || '', bv = b.venueId || '';
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

export function quoteRate(q) {
  if (!q) return null;
  const used = q.usedIn ?? q.amountIn;
  if (used <= 0n) return null;
  return { num: q.amountOut, den: used, cmp: (other) => ratioCmp(q.amountOut, used, other.amountOut, other.usedIn ?? other.amountIn) };
}

export { constantProductOut };
