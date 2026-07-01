# PLAN — shipping the Bitcoin↔Ethereum abstraction (the critical path)

> **The abstraction:** a Tacit asset (TAC, tETH, …) is one object you spend, trade, and extract on whichever
> chain you're on — instantly on Ethereum, confidentially, with native-ETH exit — Bitcoin and Ethereum as a
> single surface. This is the one roadmap tying the five design docs into an ordered, executable path with
> honest tags: **DONE** (host-verified, on-branch), **OFF-BOX** (needs the prover host — can't be done from a
> dev box), **REVIEW** (fund-critical, needs the REFLECT-1 pass before deploy).
>
> Two gates recur and cannot be skipped: **(G1) the re-prove** rotates the SP1 vkeys and is OFF-BOX; **(G2)
> every fund-critical relaxation gets an adversarial review** (the bar/escrow/backing changes reduce
> defense-in-depth, so they are not "mechanical").

## Stage 0 — the fast-lane FOUNDATION (send / withdraw)  ·  CODE-COMPLETE
A Bitcoin-homed note spent directly on Ethereum (→ a leaf, withdrawal, or fee), reflected back so it can't
double-spend. **All host-verifiable pieces DONE + green on-branch:**
- Contract: relaxed `btcHomed` bar (leaf/withdrawal/fee), `bitcoinConsumed` (slot 119), the escrow-drain
  defense, the **freshness gate** (`bitcoinConsumedCount` slot 120 + the attest `consumedCount` gate), the
  `consumedCount` public-values field. 102+ pool suite green.
- ABI: `EthConsumed`. Guests: eth-reflection consumed-set fold + `reflect.rs` senior-fold + completeness +
  `ScanReflection.consumed_count` + digest re-pin (`c5b5d994…`). JS mirror: `foldConsumed` + `setConsumedCount`.
- **eth_getProof witness DONE** (`eth_prove.rs` proves the consumed mapping slots + always the slot-120
  freshness anchor).
- **Generational anchoring DONE** (`reflectionResumeDigest_` ctor param — a fresh gen near-tip-joins the
  shared reflection; `PLAN-pool-generations.md`).

**Remaining for Stage 0 → SHIPS the send/withdraw abstraction:**
- [ ] **(G1) Re-prove both ELFs** on the prover host → rotate `PROGRAM_VKEY`/`BITCOIN_RELAY_VKEY`/
  `ETH_REFLECTION_VKEY`; re-pin `elf-vkey-pin.json`, the `reflect.rs` recursion `[u32;8]`, `DEFAULT_VKEY`. **OFF-BOX.**
- [ ] **KAT:** a `reflect-exec` fixture — a consume fold + a voided racing Bitcoin spend + a stale-proof
  rejection (host-verifiable once the re-proven artifacts exist).
- [ ] **(G2) Foundation review** is essentially done (freshness gate closed, escrow-drain defense shipped);
  re-confirm against the re-proven vkeys.

## Stage 1 — tETH subsumption (Bitcoin TAC → real ETH)  ·  contract-only, MOSTLY DONE
tETH becomes shielded ETH in the pool; unwrap → native ETH (`PLAN-teth-subsumption.md`). **No re-prove.**
- [x] **DONE + tested:** `CrossChainEscrow` relaxed for native ETH (`address(0)` escrow may carry a link;
  foreign-ERC20 escrow + link still barred) + the `escrow == supply` invariant test
  (`test_teth_native_eth_link_and_escrow_supply_invariant`: wrap/unwrap conserve, fail-closed
  `InsufficientEscrow`). Full pool suite green.
- [x] **Review finding — the escrow-drain narrowing is NOT needed; the strong defense stays.** "Bitcoin TAC
  → ETH" is two settles (btcHomed fast-spend → tETH *leaf*; then a normal non-btcHomed unwrap → ETH, which
  the defense doesn't gate). No defense-in-depth reduction. A one-settle btcHomed→ETH would be the only thing
  needing the narrowing — deferred UX sugar, not worth widening the compromised-guest surface.
- [ ] Register the real tETH asset (native-ETH + the canonical Bitcoin link) at deploy (atomic, no
  front-run window); wire the dapp wrap/unwrap ETH↔tETH UX.
- [ ] Migrate the pilot mixer (~0.003 ETH) — gen-0 → gen-1.

## Stages 2–3 — SWAP + ORDERBOOK  ·  TWO-SETTLE is free; ONE-SETTLE bar relaxation now DONE on-branch
**Two layers (see `PLAN-fast-lane-trading.md` KEY FINDING):**
- [x] **Two-settle baseline (zero bar change):** the foundation's leaf exit is a universal on-ramp — a
  btcHomed fast-spend → an Ethereum note, then any normal non-btcHomed op (swap, LP, orderbook fill) works on
  it. Verified `test_stage2_swap_via_two_settle_no_bar_change`. This is the ONLY form of the mixed-lane
  orderbook fill (a Bitcoin party filling an Ethereum party can't be one batch — single `spend_root`).
- [x] **One-settle bar relaxation SHIPPED on-branch (contract-only, no extra re-prove):** the `btcHomed` bar
  now allows a value-injecting op in one tx for a single-Bitcoin-leg trade against an EVM counterparty —
  swap/LP (vs pool reserves) + both-Bitcoin OTC/BID (vs another Bitcoin note). Recorded consumed ν + tests:
  `test_btc_homed_swap_records_consumed`, `test_btc_homed_lp_add_records_consumed`,
  `test_btc_homed_otc_records_consumed`. The swap guest path is unchanged (op-agnostic cross-lane
  non-membership), so this rides the **same Stage-0 re-prove** — no separate bar-review gate, only the
  reflection set-content anchoring (the audit's Finding 1) must land in that re-prove.
- [ ] **Cross-lane acceptance artifacts ready for the box re-prove (all four value-injecting ops):**
  `crosslane_swap_op.json` / `exec_crosslane_swap.rs` (swap), `crosslane_otc_op.json` /
  `exec_crosslane_otc.rs` (OTC fill), `crosslane_lp_op.json` / `exec_crosslane_lp.rs` (LP-add),
  `crosslane_bid_op.json` / `exec_crosslane_bid.rs` (BID fill). All validated host-side (JS round-trip);
  they execute/prove on the box at re-prove time. **Harness drift fixed
  (all 8 settle harnesses):** each now writes the `lock_set_root` / `cdp_position_root` header words added after their last re-prove
  (commit 7720405, the adaptor-swap op-set) — see `PLAN-fast-lane-trading.md` §1.

## Stage 4 — follow-ups
Both-legs-Bitcoin-homed trades; a public tETH ERC20 only if there's real demand for tETH as a token distinct
from ETH (default: there isn't, since tETH unwraps to ETH 1:1).

## What gates what
- **OFF-BOX (you / the box):** the Stage-0 re-prove — the SINGLE highest-leverage action. It turns the whole
  built-and-verified foundation live, and because the trading layer is free via the two-settle on-ramp, that
  ONE re-prove + the Stage-1 deploy delivers **send, withdraw, swap, orderbook, and "Bitcoin TAC → real ETH"**
  — the full abstraction, in two-settle form.
- **Host-verified DONE (me):** Stage 0 (foundation), Stage 1 contract-side (tETH subsumption), the generational
  enabler, and the Stage-2 two-settle proof. No remaining fund-critical relaxation is required for the core.
- **Deferred sugar (G1+G2, never gating):** the one-settle atomic trading versions — relaxations that reduce
  defense-in-depth, so done only with their review, only if the one-tap UX is wanted.

## The honest sequence
1. **Re-prove Stage 0** (OFF-BOX) + **deploy Stage 1** (tETH = shielded ETH) → the **full abstraction is
   LIVE in two-settle form**: spend / send / withdraw / swap / fill Bitcoin value on Ethereum, extract to real
   ETH. This is the whole headline.
2. **One-settle atomic polish** (swap/orderbook), per-op, with reviews — pure UX, on its own clock.
Generations + the trust model (no operator/consensus for soundness) underpin all of it and are settled.
Nothing here needs an upgrade authority; every step is an immutable deploy + a re-prove + (only for the sugar)
a review.

## Dapp / UX follow-ups (frontend, config-gated)
- **`PLAN-shielded-swap-tile.md`** — surface the built-but-dormant `cross-venue-router` as the intent-first
  shielded swap tile; auto-routes within World B only, lights up with the pool deploy (config, no code change).
- **`PLAN-unified-send-execution.md`** — fold the Bitcoin lane into the dormant `confidential-unified-send.js`
  so one asset-first box executes every lane; driver-first (extract `sendSats`), signet-gated. Today the Send
  box is asset-first and routes Bitcoin to its mature surface via a handoff.
- **`PLAN-cbtc-cusd-easy.md`** — make the flagship pair one-amount guided flows (lock→mint cBTC;
  "borrow dollars" cUSD) that compose into "dollars against your bitcoin"; one new driver
  (`buildAndBroadcastCbtcLock`, signet-gated), the rest wiring. Deploy-gated.
- **Cross-lane flip-on checklist** lives inline at `dapp/confidential-deployments.js` (CONFIDENTIAL_DEPLOYMENTS).
