# SPEC Amendment — Controller Vault: farms / staking / vesting as CDP-controller reuse

> **STATUS: shipped** (the fair-farm fold lifecycle is live across the settle + reflection guests and
> `dapp/confidential-farm.js`; controller-vault is the satellite). The **scrappy** generalization: farms, staking, vesting, and escrowed
> rewards ship as **just a new `ICdpController`**, reusing the already-built CDP position primitive **almost
> verbatim**. The immutable **pool gains one branch** (~tens of bytes — fits the EIP-170 edge); everything
> else is **guest-only assert relaxations** (free in the re-prove) + a **mutable controller**. Same spirit as
> the Bitcoin-hook satellite: keep the frozen core to the minimum, push all policy out.
>
> Builds on: `DESIGN-confidential-defi-v1.md` §4 (the CDP position primitive, `derive(controller)`,
> `ICdpController.onCdpMint/Close`) — reused, not extended; `SPEC-BITCOIN-HOOK-AMENDMENT.md` (the
> minimal-core / mutable-policy discipline).

## 0. The whole delta

A vault primitive needs three motions: **lock** a confidential position, **gate its release** over time, and
**pay out** a reward. The CDP ops already do two of the three, and the third is a one-line reuse:

| Motion | Mechanism | Core change |
|---|---|---|
| **Bond** (lock) | `OP_CDP_MINT` with the staked basket + `debt_value = 0` | guest: allow `debt_value == 0`, skip the debt-note mint |
| **Unbond** (gated release) | `OP_CDP_CLOSE`; the controller's `onCdpClose` **reverts during the lock-up** | **none** — the contract already calls `onCdpClose` and lets it revert |
| **Payout** (harvest / stream) | `OP_CDP_MINT` with an **empty basket** + `positionLeaf = 0` (sentinel) | guest: allow `n_legs == 0` + emit `0` leaf; pool: skip the position insert when leaf is `0` |

So the **pool** delta is exactly one guard around the existing insert; the **guest** relaxes two anti-bloat
asserts; the **callbacks, the `derive` gate, the position tree, the note tree** are reused untouched. No new
op, no new struct, no new interface, no `position_kind`.

## 1. Payout = `cdpMint` with `positionLeaf == 0`

A harvest/stream is a controller-authorized mint of `derive(controller)` to a confidential recipient — **no
collateral, no position**. It rides the **existing `cdpMints` path**:

- **Guest:** for a payout, spend nothing, mint a note of asset `derive(controller)` + value `payout_value` to
  the recipient (confidential owner; `payout_value` public — same boundary as CDP), and emit a
  `CdpMint { controller, debtAsset, legs: [], debtValue: payout_value, positionLeaf: 0 }`. The current
  `assert!(n_legs > 0)` is relaxed to permit the empty basket; `positionLeaf = 0` flags "no position."
- **Pool:** the existing `cdpMints` loop is unchanged except the insert is guarded:

```solidity
for (uint256 i; i < pv.cdpMints.length; ++i) {
    CdpMint memory m = pv.cdpMints[i];
    if (m.controller.code.length == 0) revert BadCdpController();
    if (m.debtAsset != keccak256(abi.encodePacked("tacit-cdp-debt-v1", m.controller))) revert BadCdpController();
    if (m.positionLeaf != bytes32(0)) _insertCdpPositionLeaf(m.positionLeaf); // ← the only new line
    ICdpController(m.controller).onCdpMint(m.legs, m.debtValue, m.positionLeaf);
}
```

The controller's `onCdpMint([], payout_value, 0)` is where the **emission schedule** lives ("this farm/grant
has accrued `payout_value` at the governed rate since the last harvest — approved"); it reverts to deny. The
minted reward note rides `pv.leaves` like every mint. The `derive` gate already guarantees the controller can
mint **only its own** token — so a payout has the **identical** conservation/blast-radius story as CDP debt
(an own-asset mint, bounded to the controller's holders), with **zero** new inflation surface.

## 2. Bond / unbond = `cdpMint(debt = 0)` / `cdpClose`

- **Bond:** `OP_CDP_MINT` with the staked notes as the basket and `debt_value = 0` — lock the basket into a
  controller-bound position, mint nothing. The guest's `assert!(debt_value > 0)` is relaxed (skip the
  debt-note mint when zero). `onCdpMint(legs, 0, positionLeaf)` records the bond (start time, weight). A
  controller that prefers a **receipt** can instead use `debt_value > 0` to mint `derive(controller)` shares.
- **Unbond:** `OP_CDP_CLOSE` against the position. The contract **already** calls
  `onCdpClose(debtValue, legs, positionNullifier)` and reverts the whole settle if it reverts — so a farm
  controller enforces a **lock-up / vesting cliff** simply by reverting `onCdpClose` until the gate passes.
  This needs **no core change**.

> Honest note: a CDP's "you can always repay and reclaim" guarantee was already only a *controller
> convention* — the core has always called `onCdpClose` and let it revert. So a **bond is a trust in the
> controller you bond into** (it could refuse release), exactly like any DeFi farm/lock — and the blast radius
> is bounded to that controller's participants. A sovereign primitive (a controller that never vetoes close)
> and a governed one (a farm with a lock-up) are both **just controllers**; the core enforces neither, which
> is why no `position_kind` is needed.

## 3. The four primitives, as `ICdpController`s

| Primitive | Bond | Release gate (`onCdpClose` reverts) | Payout (`cdpMint`, leaf=0) |
|---|---|---|---|
| **Farm** | lock LP-share notes (`debt=0`) | until the unbond rules pass | accrued LP emission |
| **Staking** | lock the staked asset | during the unstake cooldown | staking yield |
| **Vesting** | lock the grant (by the granter) | before the cliff | the time-unlocked amount |
| **Escrowed reward** | lock the escrow | until the unlock condition | the released reward |

Real-asset rewards (pay TAC, not the controller's token) = the controller's derived token redeems 1:1 from
its treasury — a controller-side layer, not a core concern. All emission/lock-up/eligibility logic is mutable
Solidity, DAO-tunable, per-controller.

## 4. Farm harvest — the reward-per-share checkpoint

§1's payout is **controller-decided** (a faucet / a stream the controller meters). For a **per-stake
farm** — reward ∝ your stake × time — the per-staker checkpoint can't live in the controller (owner hidden,
positions unlinkable across bond→close). Put it in the **confidential note** instead: the canonical
reward-per-share accumulator (MasterChef / Synthetix `StakingRewards`), with the per-user record as a
**shielded receipt**. This is additive on top of §§1–2.

**State split (the trick):**
- **Controller (global only):** `rps` (reward-per-share, scaled by a fixed `PRECISION`), `totalShares`,
  `rate`, `lastUpdate`. Lazily accrues `rps += rate·(now − lastUpdate)·PRECISION / totalShares` on each
  interaction. **No per-user state** — nothing to deanonymize.
- **Receipt note (confidential):** commits `(shares, rps_entry)` — the staker's checkpoint — beside the usual
  owner/blinding.

**Ops:**
- **Bond:** lock basket → mint a receipt committing `(shares = basket weight, rps_entry = rps_live)`;
  `totalShares += shares`.
- **Harvest:** prove the receipt, **reveal `(shares, rps_entry)`** (boundary-public), mint `R` of
  `derive(controller)`, nullify the old receipt, mint a **new** receipt committing
  `(shares, rps_entry + R·PRECISION/shares)`.
- **Unbond:** as harvest + release the basket + `totalShares −= shares` (no new receipt).

**The two enforcement points:**
- **Contract (settle):** `R·PRECISION ≤ shares·(rps_live − rps_entry)`, where `rps_live` is read from the
  **controller's own state** — never a prover input. Caps the claim to real accrual.
- **Guest (proof):** the receipt **opens** to the revealed `(shares, rps_entry)` (no lying about the
  checkpoint); the **new** receipt commits `rps_entry' = rps_entry + R·PRECISION/shares` (the checkpoint
  advances by exactly the claim); the old receipt's nullifier is spent; the reward note is `R` of
  `derive(controller)`; at bond `rps_entry == rps_live`.

**No ability to forge — every vector closed:**
| Attack | Why it fails |
|---|---|
| Mint a receipt without staking | a receipt is only created by a proof-gated bond that locks a real basket; `shares` = the conservation-proven basket weight |
| Backdate `rps_entry` (claim pre-bond reward) | bond reveals `rps_entry`; the contract requires `rps_entry == rps_live` |
| Over-claim `R` | capped by `shares·(rps_live − rps_entry)`; `shares`/`rps_entry` are proof-bound to the receipt, `rps_live` is the contract's own state |
| Replay a receipt | harvest spends its nullifier |
| **Re-claim by not advancing the checkpoint** | the guest binds `rps_entry' = rps_entry + R·PRECISION/shares`; with `PRECISION ≥ max shares` (e.g. `2^96`), **any `R ≥ 1` advances the checkpoint by ≥ 1** — the "claim a sub-`shares` amount so the rounded checkpoint doesn't move" trick is impossible (rounding only ever costs the *staker* sub-unit dust) |
| Forge `rps_live` | the contract reads its **own** controller's `rps`; the prover supplies none |
| Inflate the reward asset | `R` is a mint of `derive(controller)` only — a controller can inflate solely its own token, bounded blast radius, total emission ≤ `rate·time` |

**No prove-vs-settle freshness gate.** `rps_live` only grows, so a prove-time `R` stays `≤` the settle-time
bound — you simply under-claim the drift and take it next harvest, and the checkpoint advances by exactly what
you claimed. **No re-prove**, unlike an oracle-pinned scheme. (Bond's `rps_entry == rps_live` is the one spot
that can need a retry if someone else bonds between your prove and settle — rare, worker-sequenced.)

**Privacy:** owner hidden; `(shares, rps_entry, R)` public at the boundary (same model as everywhere). Each
harvest spends the old receipt and mints a fresh one (new blinding), so positions stay unlinkable — modulo the
usual unique-`shares` fingerprint caveat.

## 5. Cross-chain farm parity (Bitcoin ⇄ EVM, one primitive)

Tacit already has **Bitcoin-native** farms (the five Taproot opcodes `T_FARM_INIT` / `T_LP_BOND` /
`T_LP_UNBOND` / `T_LP_HARVEST` / `T_FARM_REFUND`, reflected via `fold_farm_init` / `fold_harvest`). Before
adopting §4 on EVM, note that the two are **not at parity today — and the gap favors §4**:

`fold_harvest` (cxfer-core `lib.rs:3201–3228`) derives the reward note from a **public `reward_amount`** the
harvest envelope carries and validates **only** `reward_amount ≤ treasury_remaining` — no-inflation, nothing
more. The guest says so directly (`:3204`): *"the accrual/entitlement (is `reward_amount` the harvester's
legit share?) is the **worker's FAIRNESS gate, not a bridge-soundness one**."*

| | Bitcoin farm (live) | EVM farm harvest (§4) |
|---|---|---|
| No-inflation | proven (`reward ≤ treasury`) | proven (`R` mints `derive(controller)`, capped) |
| **Fairness** (is this your real share?) | **worker-trusted** — over-claim is not proof-blocked | **trustless on-chain** — `R·PRECISION ≤ shares·(rps − rps_entry)` against the receipt checkpoint |
| Rate | fixed at `FARM_INIT` | governable (mutable controller) |

So building §4 on EVM **in isolation would make EVM strictly more trustless than Bitcoin** — a real soundness
asymmetry, not parity.

**The fix unifies them, because the reward-per-share + shielded-receipt-checkpoint trick is chain-agnostic.**
Port §4's accumulator to Bitcoin:
- The per-farm `rps` / `totalShares` / `lastHeight` accumulator lives in the **reflection state** — a natural
  extension, since the reflection already tracks each farm as a degenerate pool (the treasury keyed by
  `farm_id`, `lib.rs:3166–3192`); accrue `rps` over **Bitcoin block height**.
- `T_LP_BOND` mints a **receipt committing `(shares, rps_entry)`**; `T_LP_HARVEST` proves
  `reward ≤ shares·(rps − rps_entry)` **in-guest** — the same check, with `rps` read from the reflection
  state instead of a controller. This **replaces** the worker-trusted `reward_amount` with a proven bound.

That collapses both chains onto **one farm-harvest primitive** with identical receipt-checkpoint math and the
identical forge-resistance (§4): the accumulator lives in the **controller** on EVM (rate governable) and in
the **reflection state** on Bitcoin (rate fixed at `FARM_INIT`, accrued over height). A bonus: a farm position
can then bridge between chains coherently, since the receipt semantics match.

**Recommendation:** build §4 on EVM **and** port the `rps` accumulator into the Bitcoin reflection **together**
— same trick on both sides — so the two land at parity rather than drifting. The interim alternative (ship EVM
trustless, document Bitcoin as worker-gated pending the port) is acceptable but should be an explicit,
recorded asymmetry, not silent.

## 6. Privacy / soundness (inherited from CDP)
- **Privacy:** owner/recipient **confidential** throughout (bond owner, released basket, reward note);
  amounts (`debt_value` / `payout_value` / leg values) **public** at the boundary — the same shielded-ownership
  model as CDP, load-bearing for the same reason (the controller enforces emission/capacity against public
  magnitudes). Full amount-privacy is the same later, additive option.
- **Conservation:** bond/unbond are pure note conservation (basket spent on lock, re-minted on release);
  payout is an own-asset mint, bounded by `derive(controller)`. No new inflation surface vs CDP.
- **Blast radius:** a rogue/buggy controller is bounded to **its own asset's holders** — it cannot mint
  cBTC/cUSD/TAC or move pool backing. A user only risks the controllers they bond into.

## 7. Surface + the re-prove

**Bare vault (§§1–3) — one pool branch + a guest relaxation:**
- **`ConfidentialPool`:** one line — `if (m.positionLeaf != bytes32(0))` around `_insertCdpPositionLeaf` in
  the existing `cdpMints` loop. ~tens of bytes; fits the current headroom. (`CdpClose`/`onCdpClose` already
  support the lock-up; `derive` gate, structs, callbacks all reused.)
- **Settle guest / `PROGRAM_VKEY`:** relax `assert!(debt_value > 0)` → allow `0` (skip the debt-note mint) and
  `assert!(n_legs > 0)` → allow the empty-basket payout, emitting `positionLeaf = 0`. The existing CDP
  behavior for `debt_value > 0` / non-empty baskets / non-zero leaves is **unchanged**.

**Farm harvest (§4) — additive, richer:**
- **Guest:** the **receipt-note shape** (a note that also commits `(shares, rps_entry)`); the harvest op
  (prove receipt opening, mint reward + the checkpoint-advanced new receipt, nullify the old); bond sets
  `rps_entry`. The arithmetic (`rps_entry' = rps_entry + R·PRECISION/shares`) is in-guest.
- **`ConfidentialPool`:** **no dedicated harvest seam — the controller does it peripherally.** The harvest is
  a `cdpMint` with `positionLeaf == 1` (sentinel), carrying `(shares, rps_entry)` as the two leg values and
  `reward` as `debtValue`; the pool **reuses the existing `onCdpMint` call**, and the controller (a plain
  `ICdpController`) branches on the leaf to bound `reward ≤ shares·(rps − rps_entry)` and revert on over-claim.
  The pool's **only** change is skipping the position insert for the sentinel leaves —
  `if (uint256(positionLeaf) > 1) _insertCdpPositionLeaf(...)` — **17 bytes, measured 2026-06-20**, landing the
  pool at **24,574 / +2 under EIP-170**. (My first attempt added a *separate* `onHarvest` call site = ~229 B
  and didn't fit; reusing `onCdpMint` collapses it.) The bound is enforced **synchronously in settle** via the
  controller's `onCdpMint` reverting — it cannot be a post-mint satellite, because the reward note is minted
  atomically in the proof and can't be clawed back. Reference: `FarmController.sol` (`ICdpController`) +
  `FarmController.t.sol` (7 green).

**Bitcoin parity (§5) — `BITCOIN_RELAY_VKEY` (reflection guest), no contract change:**
- **Built + tested:** `cxfer_core::FarmRewardState` — the per-farm `(rate, total_shares, rps, last_height)`
  accumulator accruing over Bitcoin **height**, with `bond` / `harvest_ok` (`reward·PRECISION ≤
  shares·(rps − rps_entry)`, fail-closed) / `unbond` / `farm_harvest_new_entry` (checkpoint advance). It is
  **byte-for-byte the EVM `FarmController` math** — KAT `farm_reward_state_proportional_and_forge_proof` proves the
  same proportionality + forge-resistance (over-claim, re-claim, double-claim, backdating all rejected).
  Because the clock is in-proof, the whole bound is in-guest with **no contract seam**.
- **Integration remaining (box-gated, rides the re-prove):** fold `T_LP_BOND` / `T_LP_UNBOND` into the
  reflection to track `total_shares` + mint/nullify the **receipt note** committing `(shares, rps_entry)`
  (the reflection folds neither today); persist `FarmRewardState` per `farm_id` (a new accumulator → genesis
  digest change); and rewire `fold_harvest` to call `harvest_ok` instead of its `reward ≤ treasury` check —
  retiring the worker-trusted `reward_amount`. After that, Bitcoin and EVM harvest math are identical.

All ride the same coordinated re-prove as the rest of the branch; no ceremony.

The net: a yield/lock-up/vesting engine where the **bare** form is one pool branch + a guest relaxation + a
mutable controller, and the **per-stake** form adds a shielded reward-per-share checkpoint that is forge-proof by
construction (§4) — the leanest expression of "lock a confidential position, let a controller pay out," and a
direct application of the same minimal-core discipline as the Bitcoin-hook work.

## 8. Rationalized v1 farm design (both chains, pre-freeze)

The re-prove freezes the vkeys, so v1 should freeze the **best** farm shape, not the most convenient. After
the work above, the rational design is **three unified invariants + chain-native ops + one trust model**:

### 8.1 The unified layer (shared, BUILT + tested in `cxfer-core`)
Both chains share exactly three primitives — the farm's *correctness* lives here, identically:
- **`FarmRewardState`** — the global reward-per-share accumulator (`rate`, `total_shares`, `rps`). The
  per-staker `userInfo` is **not** here (nothing to deanonymize).
- **`farm_receipt_leaf(farm, shares, rps_entry, owner, nonce)`** — the shielded stake checkpoint, domain-
  separated from notes/positions/locks. Appended at bond, consumed + re-appended (advanced) at harvest,
  consumed at unbond.
- **`verify_farm_harvest`** — `reward ≤ shares·(rps − rps_entry)` (fail-closed) + the checkpoint advance.

These are byte-for-byte equal across chains (mirrored tests), so the two farms **cannot drift**.

### 8.2 Chain-native ops (the syntax differs; the invariants don't)
Unifying the *op machinery* is the wrong goal — each chain expresses farms in its native way, both binding the
same receipt + bound:
- **EVM = contract-as-controller.** `FarmRewardState` lives in the mutable `FarmController`. Bond / harvest /
  unbond ride the existing CDP ops (`OP_CDP_MINT` with the `positionLeaf == 1` harvest sentinel /
  `OP_CDP_CLOSE`); the receipt is a `farm_receipt_leaf` in the position tree; the controller bounds the reward
  in `onCdpMint` reading the receipt's revealed `(shares, rps_entry)`. Pool cost: the **17-byte insert-guard**
  (fits, +2).
- **Bitcoin = proof-as-controller.** `FarmRewardState` lives per `farm_id` in the reflection state. The five
  dedicated Taproot ops stay (none are cruft); `T_LP_BOND` / `T_LP_UNBOND` gain folds (track `total_shares` +
  the receipt), `T_LP_HARVEST` swaps its `reward ≤ treasury` worker-gate for `verify_farm_harvest`. No
  contract change (the clock is in-proof).

Rate is governable on EVM (mutable controller), fixed-at-`FARM_INIT` on Bitcoin (no contracts) — the same
flexibility split as everything else. The treasury stays on both as the **no-inflation backstop** (`reward ≤
min(accrual, treasury)`).

### 8.3 Trust + privacy (identical on both)
- **Trustless fairness:** the bound is proof-enforced; the worker drops from "trusted fairness gate" to
  **untrusted accrual calculator** (it helps you compute your claim; it can't inflate it).
- **Privacy:** owner shielded; `(shares, rps_entry, reward)` boundary-public — so a harvest is linkable to its
  bond via `(shares, rps_entry)` (position-lifecycle linkability, not owner). Full amount-privacy is the same
  later additive option as for CDP.

### 8.4 The v1 freeze recommendation
**Freeze the unified trustless design in v1 — don't ship worker-trusted-then-upgrade.** Rationale:
1. The hard, error-prone part (the math + forge-resistance + the receipt primitive) is **already built,
   tested, and proven chain-equivalent** — low residual risk.
2. The remainder is **mechanical + symmetric**: fold `T_LP_BOND`/`T_LP_UNBOND`, the receipt set, and the EVM
   receipt-position path — all **locally testable before the re-prove** (cxfer-core KATs, contract tests, the
   JS reflect-exec DIGEST_MATCH mirror). The re-prove is the only irreversible step; everything before it is
   green-or-not on a laptop.
3. Freezing trustless **now** avoids a *second* coordinated re-prove later for the single most important farm
   property. Per "design for correctness, not proving convenience," do it right once.

**Solid-ground gate (all local, pre-re-prove):**
- ① **fold logic — PROVEN.** `cxfer_core::FarmRewardState` + `farm_receipt_leaf` + `verify_farm_harvest`, with
  the full-lifecycle KAT `farm_full_lifecycle_bond_harvest_unbond` (bond → accrue-over-height → harvest against
  the receipt set → double-harvest blocked by the spent nullifier → unbond → `Σ rewards == rate·blocks`
  conservation). The *behavior* the live folds must implement is verified end-to-end.
  ① **live wiring — fold methods + digest commitment DONE; dispatch REMAINING.**
  - **Accumulator + folds (green) — RECEIPT-IN-NOTE-TREE, parity with EVM:** the only per-farm committed
    state is the **global** `FarmRewardSet` (`farm_id → (rate, total_shares, rps, last_height)`, a witnessed
    map mirroring `PoolReserveSet`) — byte-for-byte the EVM `FarmController`'s `(rate, totalShares, rps)`. The
    per-staker checkpoint is **NOT** a global record; it is the owner-blinded **`farm_receipt_leaf(farm,
    shares, rps_entry, owner, nonce)`** riding the **note tree** (`pool_root`), nullified through the **spent
    set** — exactly as the EVM receipt rides the **position tree** + position-nullifier set. The folds:
    `fold_farm_init_rewards` (register the accumulator); `fold_lp_bond` (accrue, `total_shares += shares`,
    append the receipt committing the AUTHORITATIVE `rps_entry = live rps`); `fold_lp_harvest` (prove the
    old receipt's note-tree membership → bound `reward·PRECISION ≤ shares·(rps − rps_entry)` via
    `verify_farm_harvest` → nullify the old receipt → append the advanced one — all witnessed transitions
    pre-validated, then committed atomically); `fold_lp_unbond` (prove membership → nullify → `total_shares −=
    shares`). KAT `scan_reflection_farm_folds` runs the full lifecycle against **real** note-tree + spent-set
    transitions kept in lockstep with reference accumulators, and asserts the soundness crux: a **forged
    receipt** (valid `(shares, rps_entry)` that passes the bound but was never bonded) is rejected because it
    is **not in the note tree**. **136 cxfer-core tests green; guest + forge (111 pool / 7 farm) green.** The
    deanonymizing `bond_id → (amount, entry, bonder_pubkey)` map (`BondRewardSet`) is **removed**.
  - **Digest commitment + genesis recompute (DONE + cross-language-validated):** only `farm_rewards.root()` +
    len is pinned in `ScanReflection::digest()` (the receipts ride the already-pinned `pool_root`/`spent_root`,
    so they need no separate slot); genesis `0x7b058378…` (the `farm_rewards`-only value — removing the bond
    map reverted the digest to it). Recomputed in lockstep across **five** surfaces — the two guest genesis
    KATs, contract `REFLECTION_GENESIS_DIGEST`, the JS mirror (`confidential-pool.js`), and the JS-test
    `SCAN_GENESIS` — and **validated**: the JS full-scan `confidential-reflection-scan.mjs` reproduces
    `0x7b058378…` (JS↔guest parity holds). Safe to commit now because, with no dispatch yet, `farm_rewards` is
    always empty ⇒ resume-empty matches; the **witnessed resume reconstruction** lands with the dispatch.
  - **Dispatch — the one cost of choosing privacy over the bond-map shortcut:** the existing envelopes already
    carry the public magnitudes (`encodeLpBond` 0x35: `bondAmount`, `entryAccPerShare`, `bondViewHeight`;
    `parse_lp_harvest` 0x3B: `bond_id`, `exit_acc_per_share`, `reward`), and the reflection is the
    AUTHORITATIVE rps (the envelope's claimed `entry/exit_acc_per_share` is *ignored*, not trusted). The
    receipt design needs one thing the bond-map shortcut did not: the receipt commits an **owner** + **nonce**,
    and the bond/harvest must source a **blinded owner commitment** (the `pubkey + b·G` primitive — NOT the
    bare `bonder_pubkey`, which would re-deanonymize) and a receipt nonce. These can be **derived** in the
    dispatch (owner from the bonder key + a per-bond blinding, nonce from `bond_id` + a harvest counter) to
    avoid new envelope bytes, or carried — a dispatch decision, the only place a dapp/worker touch may be
    needed. `FarmRewardState` + the bound + the receipt primitive carry over verbatim.
  - **Field extractors — DONE + tested (136 cxfer-core green):** `parse_farm_init_envelope` exposes
    `reward_per_block` (the `rate`); `parse_lp_bond_fields` → `(farm_id, bonder_pubkey, bond_amount,
    entry_acc_per_share, bond_view_height)`; `parse_lp_harvest_fields` → `(farm_id, bond_id, exit_acc_per_share,
    reward_amount, reward_r)` — all from the **existing** envelope bytes (KAT
    `parse_lp_bond_and_harvest_fields_round_trip`; the legacy parser stays backward-compatible). So the whole
    cxfer-core layer (math + receipt-based fold methods + extractors + digest) is complete + green.
  - **Remaining = `reflect.rs` dispatch + the coupled resume/worker writes:** in the FARM_INIT branch call
    `fold_farm_init_rewards(reward_per_block)` (DONE); in LP_BOND derive `(owner, nonce)` + append the receipt
    via `fold_lp_bond`; in LP_HARVEST prove the receipt + bound via `fold_lp_harvest` (nullify old, append
    advanced), retiring the worker-trusted `fold_harvest`; in LP_UNBOND `fold_lp_unbond`. The witnessed
    `farm_rewards` resume (read + matching worker write) lands **together** with the dispatch — adding the
    stdin read alone would desync every batch, so it is intentionally deferred, not half-wired.
- ② **EVM settle-guest emission — WIRED + compiles (8 FarmController forge green, live CDP/pool unchanged).**
  Receipt-placement settled: the EVM receipt is the **same `farm_receipt_leaf`** as Bitcoin (byte-identical,
  shared `farm_receipt_nullifier`), riding the note tree (`pv.leaves`) + the nullifier set (`pv.nullifiers`) —
  so the **frozen pool needs zero change**. Three settle ops: `OP_FARM_BOND` (20, spend the LP basket → append
  the receipt committing `(shares, rps_entry)`), `OP_FARM_HARVEST` (21, prove receipt → nullify → append the
  advanced receipt + reward note), `OP_FARM_UNBOND` (22, prove receipt → nullify → re-mint the basket). All
  three emit a `positionLeaf == 1` sentinel CdpMint/CdpClose; the FarmController's `onCdpMint` now branches on
  `debtValue` under that sentinel — `== 0` ⇒ BOND (binds `rps_entry == rps` live, no backdating, `+= shares`),
  `> 0` ⇒ HARVEST (bounds `reward ≤ shares·(rps − rps_entry)`, totalShares untouched ⇒ principal stays staked);
  `onCdpClose` drops the shares + lock-up. The §§1-3 bare-vault relaxation (bond `debt==0` / payout `n_legs==0`)
  is also in. **Remaining (prove step):** the dapp/box settle-input builder must emit the farm-op witnesses
  (owner, nonces, receipt membership + the basket legs), then the settle round-trip fixture + the coordinated
  re-prove (new PROGRAM_VKEY).
- ③ **JS mirror — REMAINING:** the worker's reflection assembler must add the per-farm `rps` state to the
  pool root so worker↔guest digests still match (coupled to ①'s root change).
- ④ **worker — REMAINING:** recast from trusted fairness-gate to untrusted accrual calculator (it still
  computes `reward`; the proof now bounds it).

The hard, forge-prone half — the accumulator, the receipt, the bound — is proven on both chains; the remainder
is mechanical wiring against verified logic, the bulk of whose risk is the one invasive digest change in ①.
Only when ①–④ are green does the farm work join the coordinated re-prove.
