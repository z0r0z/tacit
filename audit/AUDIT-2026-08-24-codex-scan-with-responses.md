# Tacit V1 — external scan (codex, 2026-08-24) — findings triage + Tacit responses

A 12-review automated scan of the confidential rails returned **16 findings (1 Critical, 3 High, 8 Medium, 4 Low)** and a NO-GO verdict. This is the per-finding triage, with what we changed.

**Outcome: 2 findings were real, previously-unknown defects and are FIXED. 2 more are real hardening gaps and are FIXED. 9 restate trust postures or limitations already recorded (and in most cases already documented in the frozen source itself). 3 are factually incorrect about the code as written.** Nothing in this scan changes the freeze verdict on source correctness, but it does add work to the held reprove: the reflection guest's overflow encoding changed, so the reflection vkey rotates with it.

The scan's own coverage note applies: it read no proofs, ran no gas benchmarks, and executed nothing. Several findings assert gas-limit or economic outcomes that were not measured.

---

## Fixed — real defects

### F-3 (their #3) — deferred spent cBTC locks could be resurrected and minted — **REAL, CRITICAL-class, FIXED**

Confirmed exactly as described, and this is the one genuinely dangerous finding in the set.

`attestBitcoinStateProven` applied the terminal arrays with a *tracked-lock* guard: `if (cbtcLockVBtc[outpoint] == 0) continue`. A lock whose **registration** was deferred past the 16-entry surfacing cap is not in `cbtcLockVBtc` yet, so its **spend** was silently discarded. `drainOverflow` later installed the historical registration as live, and `OP_CBTC_MINT` — which checks only value/commitment/not-spent/not-redeemed/not-minted — would then mint cBTC against a Bitcoin UTXO that no longer exists. Escrow does not save it: escrow is posted by the locker, and the CollateralEngine's slash path keys off the very `cbtcLockSpent` flag that was dropped.

**Fix (contract):** terminals are now **tombstones**, recorded unconditionally for any outpoint — tracked or not:

```solidity
if (outpoint == bytes32(0) || cbtcLockSpent[outpoint] || cbtcLockRedeemed[outpoint]) continue;
cbtcLockSpent[outpoint] = true;
```

Both registration paths (the attest fold loop and `drainOverflow`) already skip an outpoint that is flagged spent or redeemed, so a retired lock can no longer be installed live from any ordering — same batch, later batch, or a drain. A tombstone for an outpoint this pool never tracked is inert (no escrow, no commitment, nothing to mint against).

### F-2 / F-10 (their #2, #10) — unbounded terminal arrays and an atomically-undrainable overflow bundle — **REAL, FIXED**

Both halves are correct as stated:

- The per-cycle surfacing caps covered creations, metas, and calls, but **not** `cbtcLocksSpent` / `cbtcLocksRedeemed`. A block retiring thousands of tracked locks would surface all of them inline, and attest must process the whole array or not at all — the digest chain forbids splitting or skipping the block, so a large enough block halts reflection permanently.
- The deferred remainder went into a **single running-hash bundle** the contract could only drain atomically. A sufficiently large bundle can never fit in an Ethereum block, and its effects are then never surfaced again.

**Fix (guest + contract), one coherent change:**

1. **Terminals are capped and deferrable** like every other effect (`MAX_CBTC_SPENT_SURFACED` / `MAX_CBTC_REDEEMED_SURFACED` = 32). Every array attest touches is now bounded.
2. **Deferral is chunked at the source.** The guest splits deferred leaves into groups of `OVERFLOW_CHUNK = 8` and surfaces **one running-keccak root per chunk** (`overflowRoots[]`) instead of one unbounded root. Each chunk is an independent, fixed-size `drainOverflow` transaction, so an arbitrarily large bundle always drains. The running hash commits to a chunk's exact ordered leaves *and* its length, so the root alone authenticates a drain — no count is stored or trusted.
3. **Leaf order is terminals-first** (`0x04` spends, `0x05` redemptions, then `0x01` locks, `0x02` metas, `0x03` calls), within and across chunks. Draining in order therefore applies every deferred retirement before any deferred registration.
4. **cBTC minting fails closed while any chunk is outstanding** (`pendingOverflowChunks != 0` → `CbtcOverflowPending`). This covers the cross-batch case the ordering alone cannot: a lock registered in batch *n* whose spend was deferred in batch *n+1*. Draining is permissionless and each chunk is bounded, so this is a self-clearing pause, not a freeze — and every other deferred effect is already inert until drained.

Deferring a retirement delays the CollateralEngine's rug slash by however long the drain takes; that is bounded by `MIN_ESCROW_GRACE_WINDOW` (3 days) with a wide margin, and anyone can drain.

This changes the reflection public-values ABI (`bytes32 overflowRoot` → `bytes32[] overflowRoots`) and the guest's leaf encoding, so **the reflection ELF and vkey rotate with the held reprove.**

### F-14 (their #14) — incomplete checkpoint history admits Bitcoin-invalid timestamp forks — **REAL (known, low), NOW FIXED rather than accepted**

Correct, and already recorded in `BitcoinLightRelay.genesis` as a near-genesis operational caveat: `genesis` has to seed `blockTimestamp[anchor]` with the *epoch-first* timestamp (the first retarget needs that value and it has no other home), so the median-time-past window for the first ≤11 descendants runs on a baseline at or below the anchor's real time — more permissive than Bitcoin's rule. A real-PoW header with a below-true-MTP timestamp is rejected by Bitcoin and would have been accepted here.

We took the fix rather than leaving it as a deploy note. New one-shot, deployer-only `seedAnchorHistory(anchorTimestamp, ancestorHashes[], ancestorTimestamps[])`, valid only before the relay has advanced:

- separates the two timestamps — `anchorTimestamp` is the anchor's own header time and feeds MTP only; retargeting still reads `epochStartTs`, untouched;
- installs up to ten canonical ancestors as `(parent, timestamp)` pairs, completing the 11-block window from the very first submitted header.

Ancestors carry no work or height, so they can never be a fork-choice input; they are checkpoint data at exactly the trust level of the anchor itself. Both deploy scripts now call it (`ANCHOR_TIMESTAMP` / `ANCHOR_ANCESTOR_HASHES` / `ANCHOR_ANCESTOR_TIMESTAMPS`), and the values join the anchor in the deploy artifact's two-explorer cross-check.

### F-16 (their #16) — `ETH_CALL_OUTBOX` hard-coded to zero — **the risk is REAL; a gate is now enforced**

The characterization "permanently disables authenticated ETH→BTC messages" is right about the *effect* but not about the *defect*: zero is the deliberate pre-cutover placeholder, fail-closed by construction, and the launch runbook already orders the CREATE3 salt grind before the ELF build. The real exposure is the one the scan names last — **a rebuild and a vkey rotation do not replace a source constant**, so a forgotten fill ships silently.

`verify-lockstep-pins.sh` (the existing gate for exactly this class of pinned constant) now **hard-fails on the all-zero placeholder**, overridable with `ALLOW_UNPINNED_OUTBOX=1` for a pre-cutover build, and the constant's comment points at the gate. A production build can no longer ship messaging permanently disabled by omission.

---

## Already-recorded trust postures — no change

### F-1 (their #1) — "retained owner can create unbacked cUSD and seize collateral"

This is the CollateralEngine governance posture, documented in full at `v1-audit/collateral-engine-trust-boundary.md` and accepted as finding A4 of the prior external review. The engine is **DAO-governed by design**; there is no non-governance inflation path. The immutable floors are in frozen code (`MAX_FEE_PER_SECOND`, `FEED_CHANGE_LIQ_GRACE` = 6h, `MIN_ESCROW_GRACE_WINDOW` = 3d, the `setParams` ratio bounds, non-disableable `setDeviationBound`, one-time reciprocal `setPool`), and `OP_SURPLUS_DRAW` was independently re-traced end-to-end: one-shot governance pre-authorization, exact amount **and** destination-commitment match, re-bounded at draw time to realized accrued surplus.

Calling this "Critical" is a framing disagreement, not a new finding: the scan is measuring an oracle-priced CDP against a no-governance standard. The launch conditions are unchanged and remain hard requirements — **owner is a timelock/multisig, feed set and `maxDeviationBps` published, `maxDeviationBps` armed before the stability fee is ever enabled.**

### F-5, F-6, F-7, F-9 (their #5, #6, #7, #9) — privacy scope

These describe the system's **stated** confidentiality boundary, not deviations from it:

- **F-6/F-7 (singleton swap/LP and CDP public values):** a singleton settlement against public reserves reveals its own reserve delta — that is inherent to a confidential AMM over a public curve, and the anonymity comes from batching and the shared anonymity set, not from a single op. CDP mint/close/liquidation legs are public by design because the *engine* must price and enforce them on-chain.
- **F-9 (prover sees clear swap amounts):** correct and stated: the relayed prover is trusted with witness contents this generation. The prover-blind path (`OP_SWAP_BLIND`) is **hard-disabled** — proof-fatal at dispatch, folds nothing — and its internals are explicitly out of scope until a generation enables and separately audits them. The scan's "the prover-blind opcode is nonfunctional" is a restatement of that documented posture.
- **F-5 (cBTC lock data predicts the later nullifier):** the most substantive of the four. It is a self-custody linkability property of the cBTC lock, not a spend-authority break: knowing the leaf and `keccak(leaf ‖ "spent")` lets an observer *recognize* the retirement they can already see on Bitcoin, since the lock outpoint is public on-chain in both places. Binding a secret-derived owner into the Bitcoin lock is a sound improvement and is recorded for the next generation; it is a Bitcoin-script + guest change, not a contract change, and it does not affect backing or authorization.

We are **not** removing the confidentiality claims, because the claims already scope to note values, note ownership, and onward spends — all of which hold. The follow-up item is a doc one: state the per-op disclosure surface explicitly in user-facing material.

### F-8 (their #8) — fee rounding can make cUSD debt unrepayable

Real, known, and documented **in the frozen source** at `setStabilityFee`: aggregate authorization floors while per-position `_owed` ceils, so on a full wind-down the last fee-bearing position can owe one unit more than was ever authorized. It is fund-safe — no cUSD is created or stolen, and retirement books only the burn above accrued `owed`, so the gap can never surface as drawable surplus. The scan's "both close and liquidation can become impossible" overstates it: it takes hold only at the last fee-bearing position in a wind-down, since cUSD is fungible and one unit is obtainable while any supply exists.

Position unchanged: the stability fee is **dormant at launch**, and exact per-position fee accounting is a next-generation redesign (`ops/DESIGN-fee-per-position-redesign.md`). Governance should not activate the fee before that lands.

### F-11, F-13 (their #11, #13) — deep-reorg behavior

Both restate the R-2 limitation documented at length in `ConfidentialPool._anchorReflection`, including the reasoning the scan reaches independently: an attest performs irreversible effects (monotone `knownBitcoinRoot`, lock lifecycle flags, lazily-registered assets, and above all bridge mints already paid out), so a "rewind and re-fold" re-anchor would resume onto state containing orphaned burns — **turning a halt into silent inflation.** Halting is the correct response to a reorg deeper than the confirmation depth, which is already a fund-safety event.

One correction: **"no recovery transition is enabled" is factually wrong.** The generational rebase *is* the retirement mechanism — a successor pool resumes from the drained predecessor's digest and counters (`rebasedFromDigest`, verified against the predecessor's own getters on the successor's first attest), which is exactly the "safe retirement/reconciliation generation mechanism" the finding asks for. The mitigation for the depth itself is the deploy knob the source already names: set `REFLECTION_CONFIRMATIONS` deep enough that such a reorg is infeasible (deepest Bitcoin reorg since 2015: 4 blocks; the cap here is 144).

### F-15 (their #15) — router refunds award pre-existing residue to the next caller

Correct mechanically, Low, and deliberate. `ConfidentialRouter` is non-custodial and holds no balance across calls; a residue can only arise from a mistaken or forced transfer to the router. The sweep is what makes the pool's off-ratio refunds and multi-hop dust reach the user in the same transaction. Refunding only the current-call delta would strand mistaken residue **permanently** instead of leaving it recoverable — a strictly worse outcome for the same non-user funds. No user funds are at risk in either design. No change; noted so the choice is on the record.

---

## Disputed

### F-4, F-12 (their #4, #12) — reflection starvation / front-run censorship via live counters

The mechanism is real; the cost model is not. Both freshness gates (`consumedCount == bitcoinConsumedCount`, `crossOutCount`) compare against a live counter, so an attacker who lands a state-advancing settlement between proof generation and attest makes that attest revert, and can repeat it. That is a genuine griefing surface and it is **not free**, which is where the scan's "permissionless", "indefinitely", and "zero-valued" framing breaks down:

- Every cross-out **burns a distinct Ethereum note**, bound on-chain: `claimId` commits to a nullifier that must be spent in the same batch (`CrossOutNullifierNotSpent`). "Many distinct zero-valued destinations" therefore means many distinct notes, each created by a prior settle. The cost is per-censored-attest and the capital is destroyed, not recycled.
- The same holds for `bitcoinConsumedCount`: each increment retires a real Bitcoin-homed note, one-shot.
- Each attempt also requires **winning a race** against the attest it is censoring, every round, forever.
- The eth-reflection's duplicate check is quadratic in the *batch*, not in the historical set, and each cross-out op is capped at 256 outputs.

The `==` gates are not incidental: they are what forces a reflection proof to have folded **every** recorded consume before it may advance the spent set (Ethereum-senior ordering). Relaxing them is a soundness change, not a tuning knob — which is why the epoch/high-watermark redesign the scan proposes is the right shape but a next-generation change, not a pre-freeze patch. **Recorded as an accepted, priced griefing surface**, in the same class as any bridge whose relayer can be raced; a sustained campaign is publicly visible, self-funding for no attacker gain, and ends when the attacker stops paying.

---

## Effect on the freeze checklist

- The reflection guest's overflow encoding changed → **the reflection ELF/vkey rotate**, and the pre-freeze box run must re-validate the reflection fixtures under the rotated pins (this rides the held reprove, it does not add a separate one).
- `ConfidentialPool` gained the tombstone rule, chunked drainage, and the fail-closed mint gate → **`pool-bytecode-pin.json` must be re-measured and re-pinned**, and the EIP-170 headroom re-confirmed. See the codesize note below — this is the one open engineering question the fix creates.
- `BitcoinLightRelay.seedAnchorHistory` is a new deploy step: its values are DEPLOY-CRITICAL checkpoint data and join the anchor's two-explorer cross-check.
- `verify-lockstep-pins.sh` now gates the outbox pin; the deploy build must run it **without** `ALLOW_UNPINNED_OUTBOX`.

### Codesize (open)

The pool ships ~20 bytes under EIP-170 at the pinned toolchain. The F-2/F-3/F-10 fix adds roughly **400 bytes** of runtime bytecode (measured as a delta on the local toolchain, which does not reproduce the pinned artifact size and so gives the delta, not the absolute). **It does not fit as-is.** The fix is not optional — F-3 is an unbacked-mint path — so the room has to come from somewhere: the candidates are moving a periphery surface behind the router, or dropping a public getter/convenience path from the pool. This needs a decision before the artifact can be re-pinned.

### Test status at this commit

`forge test`: **872 passed, 1 failed** (873 total). The single failure is `ConfidentialLpBondProofRealTest::test_lpbond_settlement_decodes` — `bond legs = [shares]: 2 != 1`. It is **pre-existing and unrelated**: the test `abi.decode`s a committed Groth16 fixture (`lpbond_groth16.json`) that predates the current guest, so it is stale in exactly the way the held reprove exists to fix. Nothing in this change touches settle public values or the LP-bond path. It regenerates with the reprove.

New/updated coverage in this change:
- `test_attest_tombstones_unknown_spent_or_redeemed_lock` — replaces the old skip-assertion; asserts a terminal for an unregistered outpoint is tombstoned, registers no value, and **survives a later fold of that same lock** (the resurrection path).
- `test_seed_anchor_history_completes_mtp_window` / `test_seed_anchor_history_rejects_bad_input` — the relay MTP seed, including that `epochStartTs` / `epochStartTimestamp` (the retarget inputs) are untouched.
- The overflow test now covers chunk-root queueing, `pendingOverflowChunks`, and drainage.
- `testFuzz_crossout_claimid_binding` was failing at HEAD (it fuzzed `destChain` after the `CrossOutUnsupportedDest` gate landed) — now bounded to the recordable domain.
