# tacit AMM — dapp implementer's checklist

Every `MUST` / `SHOULD` requirement the spec places on the
trader-facing dapp, consolidated. Implementers building a V1 dapp
use this as their acceptance checklist. Companion to
[`AMM.md`](../../AMM.md).


Every `MUST` / `SHOULD` requirement the spec places on the trader-facing
dapp, consolidated. Implementers building a V1 dapp use this as their
acceptance checklist.

## Pool browser / discovery

- [ ] **MUST** surface `pool_id`, `asset_A`, `asset_B`, `fee_bps`,
      `reserve_A`, `reserve_B`, `lp_total_shares` at minimum.
- [ ] **MUST** show `init_height` and "minutes until LP unlock" countdown
      for pools younger than `AMM_INITIAL_LP_LOCK_BLOCKS` (~1 hour).
- [ ] **SHOULD** parse and surface `pool_meta_uri` if present (name,
      description, logo, website — informational only).
- [ ] **SHOULD** surface protocol-fee status: if `protocol_fee_bps > 0`,
      show the recipient and accrued amount.
- [ ] **SHOULD** display pool age, recent volume, recent settler-tip
      averages (if known to indexer).
- [ ] **SHOULD** render an "Amounts public" badge on any pool whose
      `capability_flags & POOL_CAP_SOLO_INTENT_ALLOWED` is set — these
      pools accept N=1 batches whose declared `(Δa_net, Δb_net)` reveal
      the lone trader's exact amount.

## Pool creation (`POOL_INIT`)

- [ ] **MUST** explain `AMM_INITIAL_LP_LOCK_BLOCKS` to the founder (no
      external LPs for the first ~1 hour).
- [ ] **SHOULD** call `assessMinLiqLockFraction(Δa_init, Δb_init)` and
      surface the returned severity (`warn` at ≥ 1% locked, `high` at
      ≥ 10% locked) — thin pools with low-decimal assets can have a
      meaningful fraction of founder shares locked.
- [ ] **SHOULD** offer `pool_meta_uri` field for cosmetic metadata.

## Intent posting (`T_SWAP_BATCH` trader path)

- [ ] **MUST** surface the chosen settler's operator identity (pubkey +
      human-readable label) before the trader signs RTT-1.
- [ ] **MUST** surface a hard warning if the chosen settler's operator
      matches the worker operator the trader is connected to ("this settler
      can see your cleartext amount") and require explicit confirmation.
- [ ] **MUST** prefer a settler distinct from the worker operator as
      the default selection when ≥ 2 settlers are registered. **When only
      one settler is registered, the dapp MUST refuse the submission
      unless the user toggles explicit `acknowledge_no_settler_diversity`
      consent**: the SHOULD-prefer rule has nothing to choose from, so the
      privacy-via-operator-split property collapses and the trader must
      affirmatively accept routing-through-worker operator visibility.
- [ ] **MUST** surface a hard warning when the candidate batch's
      `n_intents == 1` (solo-batch privacy collapse — trader's amount is
      publicly inferable from batch deltas). For pools without
      `POOL_CAP_SOLO_INTENT_ALLOWED` the indexer also rejects N=1 batches;
      the warning is the dapp-side belt-and-suspenders.
- [ ] **MUST** surface a "weak privacy" warning when the candidate batch's
      `n_intents == 2`. Each of the two traders deduces the other's amount
      from their own knowledge of their own intent + the public batch
      deltas. N=2 prevents zero-effort observer recovery but not two-party
      deanonymization; full amount confidentiality requires `n_intents ≥ 3`.
- [ ] **MUST** display `min_out` and the expected fill at current
      `P_clear`; offer slippage tolerance input.
- [ ] **SHOULD** render the worst-case fill at `min_out` and the actual
      observed-spot fill side-by-side in the swap confirm.
- [ ] **SHOULD** offer settler-tip input with a recommended default
      based on indexer-tracked recent tip-revenue averages.
- [ ] **MUST** enforce that trader's input UTXOs sum exactly to
      `amount_in_swap + tip_amount` (no change-output support in
      `T_SWAP_BATCH`). If trader's available UTXO is larger, dapp **MUST**
      pre-split via CXFER before posting.
- [ ] **SHOULD** respect dapp-level pool-maturity filter (don't surface
      low-TVL or pre-mature pools by default; warn if user navigates to
      one).
- [ ] **SHOULD** surface low-TVL warning ("initial price may be
      mispriced; check against orderbook/oracle") below dapp-configured
      threshold.

## Intent posting (`T_SWAP_VAR` trader path)

- [ ] **MUST** surface "amounts public" framing — `delta_in` and
      `delta_out` are cleartext in the envelope.
- [ ] **MUST** display the curve-derived `delta_out_expected` (which the
      indexer enforces by strict equality) alongside the trader's
      `min_out` slippage floor.
- [ ] **SHOULD** support whole-input consumption via the
      `NO_CHANGE_SENTINEL` mode when the trader's input UTXO equals
      `delta_in + tip_amount`.

## LP_ADD / LP_REMOVE

- [ ] **MUST** reject `LP_ADD variant=0` against a pool where
      `currentHeight < init_height + AMM_INITIAL_LP_LOCK_BLOCKS`. The
      indexer will reject too; the dapp **MUST** surface this clearly to
      avoid wasted Bitcoin fees.
- [ ] **MUST** show the at-the-ratio share calculation and the resulting
      `lp_asset_id` UTXO before submission.
- [ ] **SHOULD** offer mixer composability prompt: "anonymize your LP
      shares before withdrawal" (deposit `lp_asset_id` UTXO into the
      mixer pool of matching denomination).
- [ ] **MUST** warn LPs joining pools with protocol fees that they must
      query the indexer's current `k_last` and `protocol_fee_accrued`
      pre-compute the crystallized `S` themselves.

## T_INTENT_ATTEST consumption

- [ ] **SHOULD** maintain a "trusted workers" list (user-configurable);
      reject attestations from non-trusted workers.
- [ ] **MUST** track equivocator-flagged workers and reject their
      attestations.
- [ ] **MUST** check attestation timestamp freshness against a
      configurable TTL (default 30 s — reflects the soft-confirm UX
      target; raise only for low-volume pools where attestation
      cadence is intentionally slow); surface "stale" status if older.
- [ ] **SHOULD** verify membership inclusion via the sorted intent-id
      list fetched from the worker's `snapshot_uri`; hash to confirm
      against on-chain `intent_pool_hash`.

## T_RANGE_ATTEST production (optional power-user feature)

- [ ] **SHOULD** offer a "publish range attestation" UI for advanced users
      who want to build reputation, KYC tier proofs, etc.
- [ ] **MUST** explain the privacy trade-off: `commitment_outpoints` link
      the holder's UTXOs to the attestation publisher. Users wanting
      unlinkable attestations should mix UTXOs first.

## Settler selection

- [ ] **SHOULD** auto-rotate the default settler across batches to avoid
      single-operator concentration.
- [ ] **SHOULD** show settler reputation indicators (recent fill rate,
      published `settler_meta_uri` metadata, batches settled in last
      24 h) if indexer surfaces them.

