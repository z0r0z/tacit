# PLAN — Shielded Swap Tile (within-World-B unified swap)

Status: design. No code yet. Scoped to the **shielded world only** (pool notes / EVM lane).
It does NOT touch the real-sats order book (World A). Crossing the real↔shielded
boundary stays an explicit bridge/exit, never a route hop.

## Why

`dapp/cross-venue-router.js` and `dapp/cross-venue-execution.js` already exist and are
tested, but no UI imports them. This plan surfaces that engine as an intent-first
From→To tile for the confidential pool — one asset picker, one amount, the router picks
the best EVM venue/route. It is the same "state an intent, the system picks the rail"
pattern the Send tab now uses for recipients.

## Boundary (the one hard rule)

The tile auto-routes ONLY across venues that settle into the **same value class** — a
shielded pool note. Concretely, in-scope venues:

- `EVM_CONFIDENTIAL_AMM` — the confidential pool, across fee tiers and multi-hop.
- `EVM_PUBLIC_AMM` — public EVM AMM legs the ConfidentialRouter can zap through, when the
  user opts in (leaks the public leg; see Privacy).

Explicitly OUT of scope for silent routing:

- `BTC_AMM`, `CROSS_CHAIN_ORDERBOOK` (World A — real settlement). The router *models*
  these, but the tile must not select them as an invisible hop. A user who wants real
  sats goes to the order book; a user who wants to move a note to Bitcoin uses the
  bridge. The tile may *link* to those, never route into them.

This keeps "what you end up holding" honest: every tile outcome is a shielded note.

## Router API (already built — this is the contract we consume)

From `cross-venue-router.js`:

- `makeCrossVenueRouter({ venues, maxHops })` → `{ addVenue, venues, quoteExactIn, bestExactIn }`
- `quoteExactIn({ assetIn, laneIn, assetOut, laneOut, amountIn, nowTs, requireFullFill })`
  → ranked `quote[]`; `bestExactIn(req)` → top quote or `null`.
- Venue adapters: `makeConstantProductVenue(...)` for AMM pools,
  `makeOrderbookVenue({ orderbook })` for the book (World A — we will NOT register this
  one in the tile's router instance).
- `VENUE_KINDS`, `LANES`, `rankQuotes` exported for display/scoping.

Unit contract: all amounts in Tacit in-system base units. The tile is responsible for
scaling display units → base units before calling `quoteExactIn`, mirroring the existing
swap tab's dec handling.

## UI — the tile

Reuse the From→To grammar so it reads like Send/Swap:

```
From  [asset ▾] [amount]        (balance: shielded holdings via unified-holdings)
To    [asset ▾] [~amountOut]    (quoted, read-only)
      route: <venue/hops>  ·  settles as a shielded note  ·  price impact  ·  min received
[ Swap ]
```

Rules:

1. **Asset pickers span shielded assets only** — cETH, cUSD, cBTC, cTAC, and any
   pool-registered asset. Sourced from the same registry the current swap tab uses.
2. **Route line always states the outcome class**: "settles as a shielded note · instant ·
   gasless" — the World-B settlement label, matching the copy we just shipped.
3. **Degrade by gate**, exactly like the bridge affordance: only venues whose deployment
   is live get registered into the router instance. With `pool:null` (today) the tile
   shows "Shielded swaps activate with the pool deploy" and stays inert — never a route
   into a nonexistent pool.
4. **Keep the current single-pair swap as the fallback / "1-hop" view.** The tile is a
   superset; if only one venue is live the tile == today's swap, no regression.
5. **No cross-world option in the picker.** Instead, a muted footer: "Want real sats?
   Order book →" and "Move a note to Bitcoin? Bridge →" — links, not routes.

## Execution binding

`cross-venue-execution.js` already turns a selected quote into a signed taker intent
(domain-separated, binds "what the user saw" to "what execution attempts"). The tile:

1. `bestExactIn(req)` on input change (debounced) → show route + min-received.
2. On Swap: re-quote, bind the chosen quote via the execution module, then hand off to the
   existing confidential-swap build/settle path (`confidential-swap.js` / coordinator) for
   each same-lane hop. Multi-hop within the pool is N settle ops or one fused route op —
   reuse whatever the swap coordinator already does for a single hop, iterated.
3. Slippage: `requireFullFill` + a min-out derived from the quote at click time; reject if
   the re-quote drifts past tolerance (the "bind what the user saw" guarantee).

No new proving surface: every hop is an existing confidential pool swap op. This is
orchestration + UI, not new crypto — consistent with the router/execution modules being
pure and unsigned.

## Privacy

- Quoting stays **client-side** (`cross-venue-router` is pure, no network). Do not move
  routing to the worker for "better quotes" — that would leak intent.
- A public-AMM leg (`EVM_PUBLIC_AMM`) leaks that leg on-chain. Gate it behind an explicit
  opt-in toggle with a one-line disclosure, off by default. Pure-pool routes leak nothing
  beyond the existing swap op's public metadata.

## Staging

- **Now (pre-deploy):** ship the tile shell + copy behind the same live-gate; with no live
  pool it renders the inert state. Pure IA/UX, no fund path. Optionally land it as the
  Swap tab's rendering with a single live venue so there's zero behavior change until more
  venues exist.
- **At pool deploy:** register the confidential-AMM venue(s) from the deploy config; the
  tile lights up with real routing, no code change (config-driven, like the bridge).
- **Later:** add public-AMM zap venue (opt-in), then multi-hop tuning (`maxHops`).

## Non-goals

- Not a real-sats venue. Not a bridge. Not a limit-order surface (that's the order book).
- No silent cross-world routing. No server-side quoting.
</content>
</invoke>
