# Maintainer response — GPT greenlight audit, round 3 (bundle @ `3b2ecfc`)

Third pre-reprove greenlight pass. Three findings: one fund-critical (fixed), one delegated-prover
defense-in-depth (fixed), one by-design.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | Duplicate CDP position leaves permanently lock one position | High | **Real** | **Fixed** (contract-only — no re-prove) |
| Q-02 | `OP_LP_BOND` doesn't bind the derived pool id / LP asset | Medium | **Real** | **Fixed** (guest + JS + fixture) |
| Q-01 | Route authorization omits the concrete path / fee tiers | Medium | **By design** | No change — see below |

Commit: `ab73619`. F-01 is a pure contract change (the guest-pinned reflection slots are unchanged, so it
does **not** rotate the settle vkey). Q-02 changes the settle guest transcript and rides the re-prove.
`cxfer-core` 151/151; 430 contract tests + the new regression + the affected JS suites all green; the pool
stays under the 24,576-byte limit (margin **+21**, up from +17 at HEAD).

## F-01 — Duplicate CDP position leaves — FIXED

Confirmed and correct. `OP_CDP_MINT` / `OP_WRAP_CDP_MINT` / `OP_CDP_TOPUP` force the position nonce to 0 and
depend on a fresh per-position owner for leaf uniqueness, but `_insertCdpPositionLeaf` appended any leaf
without a duplicate check while close/liquidate/top-up spend only the shared `cdp_position_nullifier(leaf)`.
Two CDPs with identical (controller, basket, debt, rate, owner, nonce=0) produce one leaf and one nullifier:
once either is spent, the other is permanently unspendable — locked collateral + stale debt. (The shipped
dapp already requires a fresh `positionOwner`, so this is a footgun rather than a routine path, but it is a
permanent fund-lock in immutable code.) **Fixed:** a `cdpPositionLeafInserted` guard in
`_insertCdpPositionLeaf` rejects any leaf ever inserted (never cleared — a spent leaf's nullifier is already
consumed, so re-inserting it would be unspendable). The mapping is declared **after** the guest-pinned
reflection slots (`crossOutCommitment`=76 / `bitcoinConsumed`=119 / `bitcoinConsumedCount`=120 /
`bitcoinConsumedAt`=163 are unchanged; the new mapping lands at slot 164), so the eth-reflection guest's
storage proofs are unaffected and **no re-prove is needed for this fix**. The slot-layout CI
(`verify-reflection-slots.sh`) confirms. Regression tests assert the duplicate reverts and a unique leaf
inserts cleanly.

Bytecode: the new guard pushed the pool ~43 bytes over the 24,576 limit, reclaimed without losing any
feature — a shared `_registerDeposit` helper (deduping the wrap + shieldShares deposit-register, the one
extraction the size-optimizer didn't inline back), reusing `CdpPositionAlreadySpent` instead of a new error,
and `encodePacked` for the all-32-byte deposit-id hashes (byte-identical to `encode`). Net **+21** margin.

## Q-02 — `OP_LP_BOND` pool-identity binding — FIXED

Confirmed, same class as the round-2 `LP_ADD` fix. The `tacit-lp-bond-v1` context bound the notes + bond
target + deltas but not `pid` / `lp_asset`. A first-add bond's `d_shares` is pool-independent
(`isqrt(d_a·d_b)`), so a delegated box could route the added liquidity into a different same-pair fee tier —
previously contained only by the FarmController's downstream `STAKE_ASSET` check (fail-closed config, not ZK
authorization). **Fixed:** bound a synthetic `(lp_asset, pid, owner)` tuple into the context (mirroring
`LP_ADD`), so the authorization itself pins the pool. JS mirrors via new `pool.evmPoolId`/`evmLpShareId`
(exact `pool_id`/`lp_share_id` byte-parity); the `lpbond` fixture is regenerated.

## Q-01 — Route authorization omits the path / fee tiers — BY DESIGN

The route output opening binds the **exact** `amount_out` (not just `min_out`), so the user receives exactly
the amount they authorized regardless of which path the relay takes — there is no value leak (the auditor
agrees "direct value theft appears blocked"). The path is the relay's optimization, which is the point of
delegated routing: binding a concrete route would force the user to pre-commit a path and defeat
best-execution. The residual concerns (which pools earn the fee, MEV) are inherent to delegated routing and
cost the user nothing beyond the signed outcome. We are treating route authorization as outcome-authorized
(sign the result, not the path) and making no change.

## Net
F-01 is closed contract-side with no re-prove and the pool still fits; Q-02 folds into the coordinated
re-prove with the rest of the guest fixes. Surface is greenlight-ready pending that re-prove.
