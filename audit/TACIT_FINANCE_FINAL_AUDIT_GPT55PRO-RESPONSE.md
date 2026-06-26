# Maintainer response — GPT-5.5 Pro final readiness audit (conclusive GPT round)

Holistic pre-lock audit at commit **`034308ecec70a4f8607c0cd02e4559d4ac3e1f71`**. Public transcript:
https://chatgpt.com/share/6a3d6968-5e2c-83ec-ad1b-535279feeccc — this is the **conclusive GPT-5.5 Pro
audit** for the v1 immutable surface. Each finding independently re-verified against the live tree.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| F-01 | Critical | ETH-reflection slot drift (+2) | **False positive** — slots verified correct against the compiled layout |
| Q-01 | Medium | TSR same-settle fee capture | Real but **dormant**; engine-side pre-arming gate (pool lock not blocked) |
| Q-02 | Medium | BtcCall callId not one-shot | Cross-executor claim **moot**; residual self-inflicted/Low — documented |
| Q-03 | Low | TWAP decimals unbounded | **Fixed** (engine) |

## F-01 — ETH-reflection slot drift — FALSE POSITIVE (verified)

The auditor flagged this **"needs confirmation"** because the bundle imports (not vendors) Solady's
`ReentrancyGuardTransient`, so they couldn't see the real storage layout and *assumed* `nextLeafIndex` sits at
slot 0 — deriving 74/117/118/161 vs the guest's 76/119/120/163. Checked against the **compiled** layout
(`forge inspect ConfidentialPool storageLayout`): the guest constants are **exactly correct** —
`crossOutCommitment` 76, `bitcoinConsumed` 119, `bitcoinConsumedCount` 120, `bitcoinConsumedAt` 163. The
`+2` is real (there are two persistent slots before `nextLeafIndex`, which lands at slot 2) — exactly the case
the auditor hypothesized — so the guest is aligned, not drifted. The CI layout-assertion they recommend
already exists and runs every build: `contracts/sp1/confidential/verify-reflection-slots.sh` emits
`forge inspect ... storageLayout` and fails on any drift; the readiness gate's "Reflection storage slots ==
compiled ConfidentialPool layout" gate is green. No code change; the headline blocker dissolves.

## Q-01 — TSR same-settle savings-bond fee capture — REAL, DORMANT (pre-arming gate)

Confirmed: `_settle` runs all `pv.cdpMints` (incl. TSR savings bonds → `totalSavingsShares +=`) before any
`pv.cdpClose`/`cdpLiquidation` (which accrue the stability fee over `totalSavingsShares`), so a same-settle
bond can share in a fee generated later in that settle. **But the stability fee / TSR is shipped DORMANT**
(`stabilityFeePerSecond == 0`; `_accrueFee` returns at fee 0), so no fee is generated and there is nothing to
dilute at launch — it is reachable only after governance arms it via `setStabilityFee`. It is also a
yield-*redistribution* among savers, never insolvency (harvests are fee-budget-bounded). The fix lives
entirely in the **mutable** `CollateralEngine` (an activation checkpoint so a bond can't share in same-settle
fees), so the **immutable pool lock is not blocked**. Captured as a hard **pre-arming gate** in
`ops/CHECKLIST-mainnet-reprove.md`: resolve before TSR/stability-fee is ever activated.

## Q-02 — Bitcoin-call `callId` not globally one-shot — CROSS-EXECUTOR MOOT, residual Low

The auditor's primary concern (same `callId` firing across two executors) is **moot**: `recordHash` binds the
executor's own address and `BtcCallExecutor` recomputes it with `address(this)`, so a `callId` can only ever
fire on the named executor — and v1 deploys exactly one canonical executor. The residual is that a later
same-nonce reflection can overwrite a *pending* (un-fired) `pendingBtcCall` record — but only the
`caller_pubkey` owner can produce that second BIP-340-signed envelope, and the call is value-free, so it is
self-inflicted "latest-wins per nonce," not third-party griefable. A strict first-write-wins guard was
prototyped but pushed the immutable pool past EIP-170 (it is at the ceiling), and the finding is Low and
self-inflicted, so we **accept it** and documented the executor-binding rationale inline at the
`pendingBtcCall` write. No fund path.

## Q-03 — TWAP feed decimals unbounded — FIXED

Confirmed: the earlier oracle-decimals fix bounded only the Chainlink feeds; `_price` still computed
`10 ** ammDec` on the TWAP's runtime decimals unbounded, so a miswired/hostile TWAP could overflow and revert
every priced path (CDP mint/close/liquidate, cBTC escrow) once a TWAP + deviation bound are armed. Added
`if (ammDec > 18) revert BadFeed();` in `_price` right after the `twap()` read (TWAP decimals are a runtime
return, not knowable at `setFeeds`), matching the Chainlink bound. Engine is mutable → no re-prove. Dormant
at launch (deviation bound 0), but completes the hardening. CollateralEngine + CDP/cBTC suites: 107/107.

## Net
No fund-critical finding stands. The pool is lock-ready (F-01 false, Q-02 accepted-Low, Q-01/Q-03 are
engine-side/dormant). Q-03 fixed in the mutable engine; Q-01 gated before TSR arming. Verified: forge build
clean, ConfidentialPool 24,550/24,576, engine suites green.
