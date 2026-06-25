# Maintainer response — Claude Opus 4.8 (Max mode) final readiness audit (+ Opus 4.8 Max deep pass)

Holistic pre-lock audit at commit **`034308ecec70a4f8607c0cd02e4559d4ac3e1f71`**, the conclusive Opus round
running alongside the GPT-5.5 Pro final pass. Verdict: **LOCKABLE — no fund-critical (loss / lock / inflation /
cross-chain double-spend) and no High finding** in the immutable surface, conditional only on the two
already-known deploy-time gates. A parallel deeper Opus 4.8 pass independently traced the conservation
cryptography, all 31 settle ops, `bitcoin.rs`, the recursive reflection, the router, and the swap-batch
Groth16 verifier, and concluded its open leads were non-issues (below).

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| L-1 | Low | BP+ aggregation accepts only m∈{1,2,4,8} vs the looser per-op cap | Fail-closed + dapp-enforced — accepted |
| L-2 | Low (confirm) | swap-batch fold end-to-end is box-validated, not native-tested | Already the X-1 box gate |
| I-1 | Info | Two deploy-time gates are load-bearing | Documented gates (checklist) |
| I-2 | Info | TacitRelayer residue sweepable by design | By-design; SDK note added |
| Q-1 | Quality | Mutable CollateralEngine is the governance trust surface | By-design; timelock + oracle gates in checklist |

## L-1 — BP+ aggregation accepts only m ∈ {1,2,4,8} — ACCEPTED (fail-closed, dapp-enforced)

Confirmed: `verify_range` accepts only `m ∈ {1,2,4,8}` while the hidden-output ops assert the looser
`m_out ≤ MAX_ITEMS_PER_OP` (256), so a 3/5/6/7/>8-output op passes the count assert then **fails the range
check and reverts** — fail-closed, no unbacked or out-of-range note is ever created (the auditor agrees this
is not fund-critical). The usability concern ("does the dapp surface a clean error rather than a raw revert?")
is closed: the dapp enforces the bound *before* proving — `bulletproofs-plus.js` throws
`bpp: unsupported aggregation m=${m}` for any `m ∉ {1,2,4,8}`, and the `{1,2,4,8}` output bound is documented
at the transfer builders. So users never reach the opaque guest revert. The guest assertion is left as-is
(tightening it to a precise message is cosmetic and would churn four ops + a re-prove for no behavioral gain).

## L-2 — swap-batch fold end-to-end box-validated — ALREADY THE X-1 BOX GATE

This restates the documented batch-path gate (`ops/CHECKLIST-mainnet-reprove.md` X-1): the in-guest BN254
Groth16 verifier's **logic** is covered by a native accept-real/reject-tamper/reject-G2-limb-swap test against
the dev VK, but the *assembled* fold on the SP1-accelerated `bn` build against a **ceremony-zkey** proof must
be validated on the box before the `T_SWAP_BATCH` lane is armed (G2 Fp2 limb order, accelerated `bn`
resolution, `Gt::one()` target). It is reflection-only and fail-closed, and arming is a free off-chain flip.
No new action; the gate already captures it.

## I-1 — Two load-bearing deploy-time gates — DOCUMENTED

Both are operational choices, not code defects, and both are tracked in `ops/CHECKLIST-mainnet-reprove.md`:
(a) the reflection guest's Sepolia anchors (`ETH_GENESIS_SYNC_COMMITTEE`, `ETH_REFLECTION_VKEY`) must be
re-anchored + re-proven to production and the deployed `BITCOIN_RELAY_VKEY` must commit to that production
guest (the H-01 mainnet re-anchor gate); (b) `REFLECTION_CONFIRMATIONS` (ctor immutable, bounded ≤144) is the
Bitcoin reorg-finality margin for the burn→mint path and must be set to a production depth, not a test value.
Added an explicit pre-deploy assertion for the confirmations depth to the checklist.

## I-2 — TacitRelayer residue sweepable — BY DESIGN, SDK note

`TacitRelayer` holds no per-account state and treats its whole balance as distributable relay fees, so any
value addressed *to* it is swept by the next caller. It is opt-in periphery, cannot alter a proof-bound fee,
and no honest flow ever sets a withdrawal/fee recipient to the relayer or router address. Not exploitable
against an honest user; a sharp edge for integrators only. Captured as an SDK guardrail (never set a
withdrawal/fee recipient to the `TacitRelayer` / `ConfidentialRouter` address).

## Q-1 — Mutable CollateralEngine is the governance trust surface — BY DESIGN

The engine is correctly *outside* the immutable trust core — it can never mint a confidential asset, move
backing, or break a peg (all proof-enforced in the pool: cUSD is the controller's own derived debt, cBTC's
peg is oracle-free conservation, the farm mint is guest-leg + `farmTreasury`-gated). The residual is the
expected mutable-layer governance risk: the owner must be a timelock/DAO, and the second-source
`maxDeviationBps` should be wired once the AMM TWAP has depth (until then cUSD is single-source Chainlink).
Both are deploy/governance posture, captured in the checklist; no code change.

## Net
Two independent conclusive audits (Opus 4.8 + the deep Opus 4.8 pass) confirm **no fund-critical and no High**
in the immutable surface — matching the GPT-5.5 Pro final round. Every remaining item is fail-closed/by-design
(L-1, I-2, Q-1), an already-tracked box gate (L-2), or a documented deploy-time gate (I-1). The immutable code
is lock-ready conditional on the deploy gates being satisfied at deploy.
