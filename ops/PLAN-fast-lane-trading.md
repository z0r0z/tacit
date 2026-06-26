# PLAN — fast-lane trading (swap + orderbook from a Bitcoin holding, on Ethereum)

> Follow-up to [`PLAN-fast-lane-shared-nullifier.md`](./PLAN-fast-lane-shared-nullifier.md). The fast lane
> there is the **settlement primitive** — a Bitcoin-homed note spent directly on Ethereum. This plan is the
> **applications**: spend that note *into* an Ethereum confidential operation — an AMM swap, an LP add, or
> an orderbook fill — so a Bitcoin holder trades on Ethereum in one tx. The hard part (consumed-ν reverse
> reflection + the freshness gate + the Ethereum-senior void) is DONE; this is additive — widen the
> `btcHomed` value-exit bar op-by-op, each with one backing check + a soundness review. Do this AFTER the
> send/withdraw bundle ships.

## ⚑ KEY FINDING (2026-06-17) — every trading flow has a TWO-SETTLE form; the one-settle bar relaxation is now DONE on-branch (swap/LP/OTC/BID)
Two layers, both true:

**(a) The two-settle on-ramp makes every flow FREE.** The foundation's **leaf exit is a universal on-ramp**:
a btcHomed fast-spend produces an Ethereum *note*, then **any normal, non-btcHomed Ethereum op** — swap, LP,
orderbook fill, send, withdraw — works on that note. So every flow is achievable in **two settles** with
**zero bar relaxation, zero defense-in-depth reduction**:
- **Swap** (Flow B): (1) btcHomed fast-spend → TAC leaf; (2) a normal swap of that note → tETH. Verified:
  `test_stage2_swap_via_two_settle_no_bar_change`.
- **Orderbook fill** (Flow A, mixed-lane): the ONLY form for a Bitcoin-party-fills-Ethereum-party match —
  it can't be one batch (single `spend_root`, §3). (1) Alice fast-spends Bitcoin TAC → a leaf; (2) a normal
  fill of Bob's resting order. — **LP / anything else:** same shape.

**(b) The one-settle bar relaxation was ALSO shipped on-branch (contract-only, no re-prove).** Beyond the
two-settle baseline, the `btcHomed` bar now allows a value-injecting op in one tx —
`ConfidentialPool.sol:944` permits `leaves/withdrawals/fees/swaps/liquidity` and records each consumed ν.
This delivers the *one-settle atomic* version where the trade has ONE Bitcoin-homed leg against an
EVM-resident counterparty: **swap/LP** (counterparty = pool reserves) and **both-Bitcoin OTC/BID**
(counterparty = another Bitcoin note). Verified: `test_btc_homed_swap_records_consumed`,
`test_btc_homed_lp_add_records_consumed`, `test_btc_homed_otc_records_consumed`. It is gated ONLY on the
Stage-0 re-prove + the reflection set-content anchoring (the audit's Finding 1) — NOT a separate bar review,
since the swap guest path is unchanged (op-agnostic cross-lane non-membership).

**What is NOT one-settle:** the mixed-lane orderbook fill (one Bitcoin party, one Ethereum party) — barred
by construction (the single `spend_root` can't span both lanes), so it is the two-settle on-ramp. See §3.
The deferred-sugar framing in `PLAN-abstraction-shipping.md` predates (b); the one-settle relaxation is now
on-branch and tested.

## The two target flows

**A. Cross-chain orderbook fill (Alice on Bitcoin fills Bob's Ethereum order).** Bob rests an order on the
Ethereum confidential pool — "give X tETH, want Y TAC" (OP_BID / OP_OTC, already shipped). Alice, holding
TAC as a confidential note on **Bitcoin**, fills it. **This is TWO settles, not one** (see §3 for why — a
batch proves membership against a single `spend_root`, so a mixed-lane match can't be one btcHomed batch):
(1) Alice fast-spends her Bitcoin TAC → an Ethereum TAC leaf (the Stage-0 on-ramp, consumed-and-reflected);
(2) a normal Ethereum fill of Bob's resting order with that leaf — Bob gets TAC, Alice gets tETH. **No HTLC,
no atomic-swap dance** — both the on-ramp and the match are on Ethereum. The one-settle atomic version exists
only when *both* legs are Bitcoin-homed (two Bitcoin holders matching); that is the both-legs extension, not
the mixed-lane fill. Instant on Ethereum either way.

**B. Cross-chain pool swap (Bob swaps Bitcoin TAC for tETH).** A TAC/tETH pool exists on Ethereum. Bob spends
his Bitcoin-homed TAC into it (TAC reserve up, backed by his consumed note) and extracts tETH (tETH reserve
down, backed by the pool's LP-funded reserve). One settle, instant on Ethereum.

**Extraction (both flows).** The tETH the filler/swapper receives is an Ethereum note. Unwrap it directly to
**native ETH** through the pinned native-ETH asset, keep it shielded, or send it back to **Bitcoin** via
`crossOut`. Detail in *Extraction — getting tETH out* below.

## The one soundness invariant (everything else follows)

> **A btcHomed batch must not create un-backed Ethereum value.** A consumed Bitcoin note (value `V`, asset
> `A`) is reflected as spent on Bitcoin, so `V` must materialize on Ethereum ONLY as: (a) an output of the
> same asset `A` — backed by the consumed note (a bridged/pool-minted asset mints `A`); or (b) injected into
> a pool/order as `A`, matched against value that is already backed on Ethereum (an LP-funded reserve, or a
> counterparty's spent note).

Trust split, unchanged: the **contract** checks the public side (the exit asset is pool-minted/bridged, the
reserve deltas, the lock-root); the **guest** enforces the hidden conservation (`consumed value == value
injected`, per asset). This is exactly the shape of the escrow-drain defense already shipped for
withdrawals/fees.

## The extension — widen the `btcHomed` allow-set, op by op

Today (`ConfidentialPool.sol`, the `btcHomed` branch): allows `{leaf, withdrawal, fee}` (withdrawal/fee
gated pool-minted); bars `{swaps, liquidity, depositsConsumed, lockLeaves, lockNullifiers}` and `crossOuts`.
Extend it as follows — each is a relaxation + a backing check, NOT a foundation change.

### 1. AMM swap (`OP_SWAP`, `pv.swaps`)
- **Relax:** allow `pv.swaps` in a btcHomed batch.
- **Backing (guest):** the consumed-ν value must equal the reserve increase on the side the btcHomed note
  funds — `reserveΔ_in == Σ consumed value (asset == reserve-in asset)`. The trader's output (the other
  reserve's asset) is a leaf, backed by the pool's existing (LP-funded) reserve.
- **Backing (contract, defense-in-depth):** the reserve-in asset must be pool-minted/bridged (a btcHomed
  note is always a bridged asset); the existing `pre == live` gate + CFMM floor (`reserveAPost*reserveBPost
  ≥ reserveAPre*reserveBPre`) + the `< 2^64` reserve bounds stay. So a btcHomed swap can only *add* its
  consumed value to a real reserve and extract along the curve.
- **Net:** Bob's Bitcoin TAC enters the TAC reserve (backed by his consume), he extracts tETH (backed by
  the pool). Flow B.
- **Acceptance artifacts (host-built, ready for the swap-cut re-prove):**
  `tests/gen-cxfer-crosslane-swap-fixture.mjs` → `fixtures/crosslane_swap_op.json` — the OP_SWAP witness in
  cross-lane mode (btcHomed input + per-intent non-membership + the consumed ν the contract records),
  validated host-side (k↑, consumed ν == swap nullifiers, spendRoot-bound). The box step that consumes it
  is `eth-reflection/prover-host/src/bin/exec_crosslane_swap.rs` (MODE=execute validates the read order +
  conservation; MODE=groth16 writes the cross-lane swap `*ProofReal`). **No swap-guest change is needed:** the
  guest already reads the per-intent `nonMember` in the swap loop right after the input's membership +
  nullifier and BEFORE `amount_in` (`main.rs:455`, op-agnostic on `bitcoin_spent_root != 0` — the same
  position the transfer's `exec_crosslane.rs` uses), so only `PROGRAM_VKEY` rotates with the Stage-0
  re-prove. (Earlier notes here mis-stated the order as "after the input sig, before minOut"; the harness +
  fixture were corrected 2026-06-17 to write `nonMember` after `inPath`.) The reflection-side consumed-set
  anchoring is tracked separately and lands in the same coordinated re-prove.
  - **Harness-drift fix (2026-06-17, gates the WHOLE settle re-prove):** the `prover-host` settle harnesses
    were last re-proven (commit `1434278`) BEFORE the adaptor-swap op-set (commit `7720405`) added a 5th
    unconditional header roots, `lock_set_root` / `cdp_position_root` (`main.rs:172-175`). Every settle harness wrote too few header
    roots → it would desync against the current `confidential-pool-prover` guest at re-prove time. **Fixed in
    ALL settle harnesses** (each now writes `lockSetRoot = 0` and `cdpPositionRoot = 0` after `bitcoinBurnRoot`): the cross-lane
    `exec_crosslane.rs` / `exec_crosslane_swap.rs` / `exec_crosslane_otc.rs` + the Ethereum-only
    `exec_swap.rs` / `exec_otc.rs` / `exec_lp.rs` / `exec_bid.rs` / `exec_confidential.rs`.

### 2. LP add / remove (`OP_LP_ADD/REMOVE`, `pv.liquidity`)
- **Relax:** allow `pv.liquidity`.
- **Backing:** an LP-add funds *both* reserves in ratio — a btcHomed LP-add funds them from the consumed
  note(s); the guest binds `reserveΔ == consumed value` per asset; the LP-share note is the output (backed
  by the reserves). LP-remove of a btcHomed-held share note: the share note is itself Bitcoin-homed
  (consumed), and the withdrawn reserves become Ethereum leaves (pool-minted assets) — same leaf/withdraw
  backing. So a Bitcoin holder can provide/withdraw Ethereum liquidity. (Lower priority than swap.)

### 3. Orderbook fill (`OP_OTC` direct, `OP_BID` resting) — CORRECTED 2026-06-17
Two corrections from reading the actual guest/contract (the prior lock-set-split framing was wrong on both
counts):

- **`OP_OTC`/`OP_BID` are leaf-shaped, NOT lock-set.** They emit only `nullifiers` + `leaves` (`main.rs`
  OP_OTC `836-841`, OP_BID `967-972`). The `lockLeaves`/`lockNullifiers` set belongs to the *adaptor-swap*
  ops 12-14 (`OP_ADAPTOR_LOCK/CLAIM/REFUND`, `main.rs:1113/1149/1180`), a separate atomic-swap mechanism —
  the orderbook never touches it. So there is **no lock-set split to make**: a btcHomed OTC/BID fill already
  rides the **already-relaxed `leaves` bar** (`ConfidentialPool.sol:944`), records each consumed ν, and
  advances the freshness count — no new bar relaxation. Verified: `test_btc_homed_otc_records_consumed`.
- **A one-settle btcHomed fill is BOTH-legs-Bitcoin only; the mixed-lane fill (Flow A) is TWO settles.** A
  batch proves every membership against a **single `spend_root`** (`main.rs` reads one root at `:128`; every
  op verifies against it — `453/748/772/872/912/…`). A btcHomed batch has `spend_root ∈ knownBitcoinRoot`, so
  *all* its input notes are Bitcoin-homed. The order-fill counterparty is itself a note (unlike a swap, whose
  counterparty is the pool's public reserves), so a one-settle btcHomed OTC/BID necessarily has **both legs
  Bitcoin-homed** — two Bitcoin holders matching directly on Ethereum (a real, additive capability). The
  headline cross-chain fill — *Alice on Bitcoin fills Bob's resting Ethereum order* — has one note per lane
  and therefore **cannot be a single batch** (the one `spend_root` can't be both a Bitcoin and an EVM root);
  it **fails closed by construction** (Bob's EVM note isn't a member of the Bitcoin root). It is delivered by
  the **two-settle on-ramp**: Alice fast-spends her Bitcoin TAC → an Ethereum leaf (Stage 0), then a normal
  non-btcHomed fill of Bob's order with that leaf. That path is already live with the foundation; no bar
  relaxation, no guest change.
- **Backing (guest), both-Bitcoin one-settle case:** value conserves across the match (each party's consumed
  TAC/tETH == the counterparty's received note), both inputs prove membership in the Bitcoin pool root, both
  ν get the per-input cross-lane non-membership (`main.rs:750/774`) and are recorded for the reverse
  reflection. Acceptance artifact: `tests/gen-cxfer-crosslane-otc-fixture.mjs` →
  `fixtures/crosslane_otc_op.json`; box step `exec_crosslane_otc.rs`.
- **Net:** the realistic Flow A is two-settle (works today); the one-settle OTC/BID fill is the both-Bitcoin
  match, additive and contract-ready.

### Scope of the first trading cut
- **One btcHomed leg per trade** (the Bitcoin-origin trader) against an EVM-resident pool/counterparty. A
  trade with *both* legs Bitcoin-homed (two consumes in one batch) is a further extension — both reflect,
  the freshness gate already counts them, but defer for review focus.
- `depositsConsumed` stays barred for btcHomed (an EVM deposit is EVM-homed; no reason to consume one in a
  btcHomed batch).
- Onward `crossOut` from a btcHomed batch stays barred (extraction-to-Bitcoin is a *separate* settle, the
  existing crossOut path).

## Extraction — getting tETH out (just unwrap to ETH)

The filler/swapper ends with a confidential **tETH note** on Ethereum.

1. **Unwrap → native ETH (default, instant).** Under subsumption (`PLAN-teth-subsumption.md`) tETH is
   **shielded ETH the pool custodies** — unwrapping a tETH note burns it and releases native ETH directly
   (the native-ETH escrow path that already exists). That unwrap *is* the redeem: no wrapped-ERC20 hop, no
   bridge round-trip. Bob's full path is "Bitcoin TAC → (fast-lane swap) → tETH note → (unwrap) → ETH."
2. **Keep it shielded.** Hold the tETH note and re-spend it confidentially on Ethereum, or `crossOut` it
   back to Bitcoin (Mode-B reverse reflection). The privacy lives in the note.

Because tETH redeems to ETH 1:1, **there is no separate public "tETH ERC20" in the path** — its public form
simply *is* ETH (use WETH for ERC20-land). The earlier WETH-style-redeem design was an artifact of tETH
living in a *separate* mixer; subsuming it into the pool makes "redeem" the unwrap that already exists. See
`PLAN-teth-subsumption.md` for the two gated contract refinements (native-ETH escrow may carry a cross-chain
link; the fast-lane escrow-drain defense narrows to "same-asset own backing") and the `escrow == supply`
invariant that keeps it sound — **no privacy loss** (shielding is the note phase; ETH is the public exit).

### Why it matters
This is what makes the headline literally true end to end: **"I held TAC on Bitcoin, and I got real ETH on
Ethereum, in basically one flow"** — one swap settle, one unwrap-to-ETH, nothing in between.

## Contract changes (small, mechanical)
- In the `btcHomed` branch, replace the blanket `{swaps, liquidity, locks}` revert with the granular rules
  above: allow `swaps`/`liquidity`/`lockNullifiers`/the OTC op; still revert `lockLeaves` and
  `depositsConsumed`; keep the crossOut bar.
- Extend the **pool-minted exit guard** beyond withdrawals/fees: for a btcHomed swap/LP, assert the
  reserve-in / funded asset is `poolMinted` (a bridged asset), so the consumed value can only fund a
  bridged reserve, never drain an escrow reserve.
- Keep recording every spent ν in `bitcoinConsumed` + advancing `bitcoinConsumedCount` (the freshness gate
  is asset/op-agnostic — it already covers these).
- No public-values-layout change beyond what already shipped → **the contract piece does not, by itself,
  force a re-prove** (it reads existing `pv.swaps`/`pv.liquidity`/`pv.lockNullifiers`).

## Guest changes (the real work — the per-op backing)
**SWAP needs NO guest change — it is CONTRACT-ONLY.** The settle guest already does the full btcHomed
handling for a swap input: it verifies membership against `spend_root` (which may be a Bitcoin root),
runs `check_btc_nonmembership` **per input** when `bitcoin_spent_root != 0` (op-agnostic, `main.rs:455`),
enforces conservation (constant-product non-decrease + fee-clearing price), and pushes the input ν into
`nullifiers` + the output into `leaves`. So a btcHomed swap proves today; only the contract bar blocked
it. The swap cut is therefore just the bar relaxation — **no re-prove of the settle guest.** (LP/OTC/BID
are different: their per-op consume binding is genuine guest work that *would* rotate `PROGRAM_VKEY`, so
they wait for that.) The **reflection** guest is unchanged either way (it folds the consumed ν via the
foundation's path).

## Review items (REFLECT-1 rigor, per op)
- **Swap/LP backing:** prove the consumed value can't exceed the reserve increase it claims to fund (no
  "inject 1, claim 10" — the CFMM floor + the in-guest conservation must compose with the consume binding).
- **Orderbook fill:** (lock-set split RETRACTED — OTC/BID are leaf-shaped, §3.) For the both-Bitcoin
  one-settle case, confirm both legs' membership is in the Bitcoin root, both ν get the per-input cross-lane
  non-membership + are recorded once each, and a partial fill (OP_BID's K-presig) conserves on each consumed
  side. For the realistic mixed-lane fill, confirm the two-settle on-ramp is the path (it can't be one batch).
- **Freshness still holds** for swap/LP/fill consumes (it's a count over `bitcoinConsumed`, op-agnostic —
  re-confirm every btcHomed *value-injecting* op increments the counter exactly once per consumed ν).
- **Asset isolation:** a btcHomed note's asset is the bridged asset; confirm it can only fund a reserve /
  match a leg of that asset (no cross-asset injection).

## What does NOT change
- The consumed-ν reverse reflection, the freshness gate (`bitcoinConsumedCount` + the attest `consumedCount`
  gate), the Ethereum-senior void (live-removal), the genesis-digest pin — all reused as-is.
- The slow `bridge_burn → bridge_mint` and `crossOut` paths stay the race-free defaults.
- Extraction on Ethereum is the existing `withdrawal` to native ETH for the pinned tETH asset; on Bitcoin the
  existing `crossOut`. The native-ETH path changes neither the trading bar nor the foundation.

## Phasing
1. **Ship the send/withdraw bundle first** (re-prove + the box steps in `PLAN-fast-lane-shared-nullifier.md`).
   Instant cross-chain payments/withdrawals of any Tacit token — the foundation in production.
2. **Swap cut** (Flow B): relax the bar for `swaps`/`liquidity` (CONTRACT-ONLY — the guest already enforces
   the per-input cross-lane non-membership + conservation, so **no re-prove**). DONE on-branch: the bar
   relaxation (`ConfidentialPool.sol:944` allows `leaves/withdrawals/fees/swaps/liquidity`) +
   `test_btc_homed_swap_records_consumed` / `test_btc_homed_lp_add_records_consumed` + the cross-lane swap
   acceptance fixture (§1). Gated on the reflection set-content anchoring landing in the foundation re-prove.
3. **Orderbook cut** (Flow A): NO new bar — OTC/BID are leaf-shaped, so a btcHomed fill already rides the
   relaxed `leaves` bar (§3). DONE on-branch: `test_btc_homed_otc_records_consumed` +
   `test_btc_homed_bid_records_consumed` + the cross-lane OTC/BID acceptance fixtures (`crosslane_otc_op.json`,
   `crosslane_bid_op.json`) + `exec_crosslane_otc.rs` / `exec_crosslane_bid.rs`. The realistic mixed-lane fill
   is the two-settle on-ramp (works with the foundation); the one-settle OTC/BID fill is the both-Bitcoin match.
4. **LP cut + both-legs-Bitcoin-homed**: LP-add one-settle is covered (relaxed `liquidity` bar +
   `test_btc_homed_lp_add_records_consumed` + cross-lane fixture `crosslane_lp_op.json` + `exec_crosslane_lp.rs`);
   both-legs-Bitcoin OTC/BID is the contract-ready case above. All four value-injecting ops (swap/LP/OTC/BID)
   now have a one-settle cross-lane acceptance fixture + box harness, ready for the Stage-0 re-prove.

**Parallel, independent track — the native-ETH bridge-side path.** The pinned tETH native-ETH unwrap + the
unified supply ledger ship against the bridge, not the trading bar, so they can land on their own schedule.
Sequence it to land with the **swap cut** — that's the moment the full "Bitcoin TAC → real ETH" demo becomes
one clean flow; until then the swap cut delivers a shielded tETH note that exits through the native unwrap
once the pool deployment is live.

Each trading cut is one bar relaxation + one backing assertion + one review — additive over a foundation
that's already built and (after the bundle) proven; the native-ETH shortcut is a bridge-side primitive
orthogonal to all of them.
