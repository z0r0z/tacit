# Relay economics — self-subsidizing proving service pricing

Goal: the relay charges a bound, dynamic fee per confidential op that covers (proving PROVE +
settle gas) plus a small ops margin, undercuts competitors, and funds itself. Data below is from
the live mainnet demo txs this session (2026-07-18) plus live PROVE/ETH prices.

## The flywheel
1. **Collect** — every relayed op carries a fee bound INSIDE the proof (opening sigma commits
   recipient + fee; the relayer cannot inflate or redirect it). Fee is paid in the op's asset
   (cUSDC / cETH / …) to `msg.sender` = the relayer.
2. **Replenish** — a periodic worker/job sweeps accumulated fee assets and swaps them → **PROVE**
   (top up the Succinct prover balance) + **ETH** (settle gas) via zRouter `multicall()`
   (pattern: the ETH→token multicall the operator already uses). Keeps both balances funded.
3. **Surplus → ops** — the margin above cost accrues to the ops budget.
4. **Quote** — the dapp frontend computes the fee at quote time from LIVE gas + PROVE price +
   margin, so pricing tracks conditions instead of a stale fixed bps.

Self-sustaining iff `fee_collected ≥ PROVE_cost + gas_cost` per op; the margin is the ops accrual.

## Cost anatomy (measured)
Prices: PROVE $0.1915, ETH $1840. Mainnet gas has been ~0.1–1 gwei lately — **realistic pricing
centers on the 0.5–1 gwei column**; the 5–20 gwei columns are stress cases for a fee cap.

| Op | settle gas | @0.5 gwei | @1 gwei | @5 gwei | @20 gwei |
|---|---|---|---|---|---|
| wrap (deposit+settle) | 593k | $0.58 | $1.12 | $5.49 | $21.87 |
| swap settle | 569k | $0.55 | $1.08 | $5.27 | $20.98 |
| LP add | 749k | $0.72 | $1.41 | $6.92 | $27.61 |
| unwrap settle | 323k | $0.33 | $0.62 | $3.00 | $11.93 |

**Key finding: PROVE is ~$0.03/op — negligible. Settle GAS dominates (100×+).** The 28.5 PROVE
monster was the 176-block reflection backlog, NOT a normal op; incremental reflection + settle
proofs are near the groth16 floor (~0.1–0.2 PROVE ≈ $0.02–0.04). So the relay fee is really a
**gas-abstraction fee**, and it MUST be dynamic in gas. **At today's ~1 gwei a swap relays for
~$1.08 all-in** — trivially cheap; the fee is comfortable across all trade sizes.

> Instrument in demos: replace the 0.15-PROVE placeholder with the ACTUAL per-op-type PROVE
> charge pulled from Succinct fulfillment records; log gas per op-type (have it). Then the model
> is fully empirical.

## bps is regressive — fixed cost / trade size
Break-even bps on a swap (569k gas + PROVE) by trade size × gas:

| trade $ | @0.1 gwei | @5 gwei | @20 gwei |
|---|---|---|---|
| $100 | 13.4 | 527 | 2098 |
| $1,000 | 1.3 | 52.7 | 210 |
| $10,000 | 0.13 | 5.3 | 21 |
| $100,000 | 0.01 | 0.5 | 2.1 |

A flat bps is unusable: a $100 trade at 20 gwei needs 2000 bps to break even; a $100k trade needs
2 bps. Pricing must be **cost-plus with a floor + cap**, not a flat bps.

## Pricing recommendation
```
per_op_cost = live_gas_cost(op) + live_PROVE_cost(op)      # both from live oracles at quote time
fee         = max(MIN_FLOOR, per_op_cost * (1 + OPS_MARGIN))
displayed_bps = fee / trade_size                            # shown to user, capped
```
- **OPS_MARGIN**: ~10–15% over cost (the "small amount toward ops" norm). Covers price slippage
  between fee collection and the PROVE/ETH replenish swap, plus ops accrual.
- **MIN_FLOOR**: a small absolute floor (e.g. $0.25–$0.75) so tiny trades still cover their own
  gas; below the floor, self-settle (user pays own gas) is the honest option.
- **BPS_CAP**: cap the displayed bps (e.g. ≤ 30 bps) so mid/large trades are never overcharged;
  above the size where cost/size < cap, the fee is just cost+margin (fractions of a bp).
- **Competitive position**: for $10k+ trades the break-even is ~5 bps even at 5 gwei — trivially
  undercuts 25–30 bps confidential competitors (Railgun ~25 bps, aggregator markups) WHILE adding
  gasless + privacy. Small trades carry a privacy premium (the floor); that's fair and disclosed.

## What makes it trustless / safe
- Fee is proof-bound (relayer can't overcharge) — see confidential-pool-ux buildUnwrap /
  confidential-swap buildIntent (fee carved from input, guest-enforced).
- Relayer never sees spending keys (blindings stay client-side; only opening sigmas in the
  witness) — it can't steal, only earn the bound fee.
- Prover (Succinct or box) sees amounts but not keys; TEE proving hides amounts too if desired.

## Demo instrumentation checklist (to make it empirical before go-live)
- [ ] Per-op-type actual PROVE charge (Succinct fulfillment) — replace placeholder.
- [ ] Per-op-type gas (have: wrap 593k, swap 569k, LP 749k, unwrap 323k).
- [ ] Fee-collected vs cost per op → confirm ≥ 1.0 coverage + margin.
- [ ] Replenish-swap slippage (fee-asset → PROVE/ETH via zRouter) → size the OPS_MARGIN buffer.
- [ ] Frontend dynamic-fee quote wired to live gas + PROVE price oracles.

