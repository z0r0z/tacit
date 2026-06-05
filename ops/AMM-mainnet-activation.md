# AMM mainnet activation — status & checklist

Engineering status for opening the AMM on mainnet (first pool: TAC / tETH).

## Shipped
- **Per-network deployment switch** (`AMM_DEPLOYMENTS` in dapp): `pools` / `mixerPoolOps` flags decouple the pool tab from the cBTC.tac / slot-ops / farms surfaces, so pools can activate on a network without dragging those along. Provers key on ceremony finality, so any pre-activation broadcast carries a real proof. (4bd7862)
- **Swap-receipt crediting**: the holdings validator confirms a T_SWAP_VAR / T_SWAP_ROUTE receipt was accepted by the worker (accepted-swap registry `ammswapok:*` + `GET /amm/swap-accepted`) before crediting it, since reserve backing isn't reconstructable from local ancestry. Offline falls back to optimistic credit, matching the T_PMINT / T_DCLAIM model. (53f460e + 7e8a058)
- **Mainnet POOL_INIT** pins the canonical ceremony vk_cid; signet is exempt (per-harness placeholder cids, no real value). (e5a90e7)

## Remaining before the mainnet pool
- **Reorg-safe AMM indexing**: the indexer applies AMM reserve deltas at 0-conf with no rollback. Needs a confirmation-depth cursor for AMM ops with idempotent reprocessing. The reserve-freshness gate already prevents re-mine double-apply; the residual is bounded reserve drift from permanently-orphaned blocks, low-likelihood on mainnet. Reasonable to document and defer for the gated pilot (same posture as the bridge's deep-reorg item) and build alongside the scan rewrite.
- **Pool-form UX**: inputs parse raw base units and show no human-readable price; add decimals + price display before users touch the pool.
- **Recovery fallback**: variant-0 LP and swap-receipt pool-id resolution depends on the worker pool registry; add a worker-independent fallback for the canonical pool.
- **Network byte** in the AMM kernel / launcher-gate signed messages (house style; the rest of the codebase binds it).
- **CI assert** binding the pinned vk_cid to the current circuits before any `pools: true` flip.

## Phase-3 (bond) — separate from pool launch
- **TWAP wiring**: AMM swaps emit no price observations and the LP-share valuation reads the tETH leg as sats; both are the §5.52.11 follow-up.
- Reconcile the worker bond-ratio default (2.0×) with the amendment default (2.5×).

## Activation sequence
1. Land the remaining pool items above.
2. Decide genesis parameters (seed amounts, fee_bps, fee address, founder-share custody); accumulate the tETH side (pilot cap permitting).
3. Broadcast the canonical TAC/tETH POOL_INIT + seed (real proofs guaranteed; mind the 6-block initial-LP lock).
4. Flip `AMM_DEPLOYMENTS.mainnet.pools`; smoke a small LP_ADD → swap → LP_REMOVE round-trip. `mixerPoolOps` stays off until cBTC.tac's phase.
