# AMM mainnet activation — status & checklist

Engineering status for opening the AMM on mainnet (first pool: TAC / tETH).

## Shipped
- **Per-network deployment switch** (`AMM_DEPLOYMENTS` in dapp): `pools` / `mixerPoolOps` flags decouple the pool tab from the cBTC.tac / slot-ops / farms surfaces, so pools can activate on a network without dragging those along. Provers key on ceremony finality, so any pre-activation broadcast carries a real proof. (4bd7862)
- **Swap-receipt crediting**: the holdings validator confirms a T_SWAP_VAR / T_SWAP_ROUTE receipt was accepted by the worker (accepted-swap registry `ammswapok:*` + `GET /amm/swap-accepted`) before crediting it, since reserve backing isn't reconstructable from local ancestry. Offline falls back to optimistic credit, matching the T_PMINT / T_DCLAIM model. (53f460e + 7e8a058)
- **Mainnet POOL_INIT** pins the canonical ceremony vk_cid; signet is exempt (per-harness placeholder cids, no real value). (e5a90e7)
- **§5.20 market-order + pass-through settlement**: T_SWAP_VAR resolves to execute-at-actual-reserves (within the trader's `min_out`) or pass-through-refund — never the strict-equality burn. Applies from genesis on every network (the unshipped strict draft was removed; no activation gate). Worker outcome records + `/amm/pool/:id/head` projected reserves + `POST /amm/swap-hint` feed the dapp's soft-finality ladder. On-chain validated on signet (the same-window race rehearsal: both-execute-at-walked-prices + stale-floor-refund, no burn). (45da794, 9dfd4ba)
- **Pool-form UX** (was remaining): the swap tile parses at the from-asset's decimals and renders every amount as whole tokens with a `1 from ≈ N to` price line. (c8e0be4)
- **CI assert** (was remaining): `tests/amm-vk-circuit-pin.test.mjs` binds the committed circuit r1cs hashes to `AMM_CEREMONY_CIRCUIT_HASHES` (parsed from source) + asserts the dev vkeys decode as Groth16/BN254 with the circuits' true public-signal counts. Run it in CI before any `pools: true` flip. (current)

## Remaining before the mainnet pool
- **Reorg-safe AMM indexing**: the indexer applies AMM reserve deltas at 0-conf with no rollback. Needs a confirmation-depth cursor for AMM ops with idempotent reprocessing. The reserve-freshness gate already prevents re-mine double-apply; the residual is bounded reserve drift from permanently-orphaned blocks, low-likelihood on mainnet. Reasonable to document and defer for the gated pilot (same posture as the bridge's deep-reorg item) and build alongside the scan rewrite. NOTE: pool records are KV read-modify-write with no CAS — a cron tick overlapping a manual `/scan` can drop a delta; fold a single-writer/idempotent-replay fix into the same rewrite.
- **Recovery fallback**: variant-0 LP and swap-receipt pool-id resolution depends on the worker pool registry. The swap-receipt path now recovers the two common cases worker-independently (executed-at-quote + pass-through refund, via on-chain `r_receipt` + commitment-match candidates); the residual gap is a *drift-filled* receipt (a race swap that settled at moved reserves), which needs the worker outcome record or a full local AMM replay — the latter is the real fallback feature, deferred with the scan rewrite.
- **Network byte** in the AMM kernel / launcher-gate signed messages (house style). LOWER priority than first assessed: pool_id (from network-specific asset_ids) and the `vin[1]` input-outpoint already pin every signed AMM message to one network — a cross-network replay would need the same UTXO to exist on both chains. Defense-in-depth, not a live gap.

## Phase-3 (bond) — separate from pool launch
- **TWAP wiring**: AMM swaps emit no price observations and the LP-share valuation reads the tETH leg as sats; both are the §5.52.11 follow-up.
- Reconcile the worker bond-ratio default (2.0×) with the amendment default (2.5×).

## Activation sequence
1. Land the remaining pool items above.
2. Decide genesis parameters (seed amounts, fee_bps, fee address, founder-share custody); accumulate the tETH side (pilot cap permitting).
3. Broadcast the canonical TAC/tETH POOL_INIT + seed (real proofs guaranteed; mind the 6-block initial-LP lock).
4. Flip `AMM_DEPLOYMENTS.mainnet.pools`; smoke a small LP_ADD → swap → LP_REMOVE round-trip. `mixerPoolOps` stays off until cBTC.tac's phase.
