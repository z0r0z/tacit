# SPEC — MasterChef-style stake-anytime confidential farms (execution-stamped entry)

**Status:** design, ready to implement. Reprove-coupled (guest change → new ELF/vkey). Fold into the pending
reprove cycle. **Nothing is unsafe in the interim** — the currently-shipped H-01 `==` fix is *safe*, just
join-limited (see §1); this spec upgrades farms from "cohort-only" to "stake-anytime" and **subsumes the H-01
fix entirely** (the `==` bond check is removed).

Work in `/Users/z/tacit`. Contracts `contracts/`, guests `contracts/sp1/confidential/`. Build: `forge build`;
guests `cargo build --release` in `contracts/sp1/confidential/`. Test: `forge test`; cxfer `cargo test` in
`cxfer-core/`.

## 1. Why

The confidential farm is Synthetix/MasterChef-style: a staker bonds shares and earns `reward =
shares·(rps − rps_entry)`, where `rps` is the reward-per-share accumulator. Today the per-position checkpoint
`rps_entry` is **committed inside the shielded receipt note** (`farm_receipt_leaf`) at proof-build time, and the
controller binds it to the live `rps` at settle.

H-01 (audit) forced that bind to be exact-equality (`rps_entry == liveRps`) to stop a future-dated checkpoint
from freezing the escrow budget. But an `OP_FARM_BOND` is a minutes-long SP1 proof, and on an actively-accruing
farm `rps` (2^64 precision) moves every second, so at execution `liveRps != rps_entry` → **bond reverts**. Net
effect: only the *first* staker (empty farm, `rps == 0`) or post-campaign bonds succeed. That is useless for an
open "stake anytime" farm.

Root tension: the entry checkpoint must equal the **execution-time** `rps`, which is unknowable at proof-build
time. The only actor that knows it is the settling contract (ETH lane) / the reflection fold (BTC lane), at
execution. **Fix: stamp the entry at execution instead of pre-committing it in the note.** This is exactly
MasterChef's `user.rewardDebt = amount·accRewardPerShare` set on deposit. It removes drift, removes the freeze,
removes any over/under-claim, and makes joins work at any time.

Privacy note (acceptable, and consistent with existing design): farm `shares` are **already public** (a settle
leg the controller reads), and CDP positions already use public position leaves with signature-proven hidden
owners. This redesign makes the receipt leaf a **stable public position id** (harvests reuse it in place rather
than consume-and-remint), so an observer can link a position's bond → harvests → unbond by timing — but the
**owner stays hidden** (proven by BIP-340/opening signature) and amounts were already public. This is the same
posture as CDP positions.

## 2. Design (both lanes)

- **Receipt leaf becomes the stable position id.** Drop `rps_entry` from `farm_receipt_leaf`:
  `farm_receipt_leaf(farm, asset, shares, owner, nonce)` — bump the domain tag to `"tacit-farm-receipt-v3"`.
  It no longer encodes the checkpoint, so it is stable across harvests.
- **Entry is stamped at execution, keyed by the receipt leaf:**
  - **Bond:** stamp `entryRps[leaf] = liveRps`; `totalShares += shares`; `totalRewardDebt += shares·liveRps`.
  - **Harvest:** `reward ≤ shares·(liveRps − entryRps[leaf])`; then re-stamp `entryRps[leaf] = liveRps` and
    `totalRewardDebt += shares·(liveRps − oldEntry)`. **No consume-and-remint** — the leaf stays; the re-stamp
    is what prevents double-harvest (a replay computes `shares·(liveRps − liveRps) = 0`). `totalShares`
    unchanged (principal stays staked).
  - **Unbond:** require the leaf's stamp exists; `reward ≤ shares·(liveRps − entryRps[leaf])` (final harvest,
    optional); `totalShares −= shares`; `totalRewardDebt −= shares·entryRps[leaf]`; delete `entryRps[leaf]`;
    return principal.
- **Recover reservation becomes exact, not an upper bound:** total outstanding claimable is
  `(rps·totalShares − totalRewardDebt) / PRECISION`. Reserve exactly that; `recover` releases
  `treasury − that`. This **replaces** the current `accrued` upper-bound accumulator and the H-01
  clear-on-zero. It is safe *because entries can no longer be future-dated* (the aggregate that was unsafe for
  future entries is exact once every entry is a stamped live value). When `totalShares == 0`, `totalRewardDebt`
  is also 0, so the reservation is 0 (sponsor recovers everything) — no residual dust.
- **Double-spend / replay safety:** the receipt leaf is NOT nullified on harvest (it must persist), so harvest
  must be idempotent-safe. The re-stamp guarantees a replayed harvest pays 0. Unbond DOES nullify the leaf
  (spend-once) and deletes the stamp, so it cannot be replayed. The owner authorizes every harvest/unbond by
  signature (unchanged), so a third party cannot harvest/unbond someone's position.

## 3. Ethereum lane changes

### 3a. Settle guest (`contracts/sp1/confidential/src/main.rs`)
- `OP_FARM_BOND` (arm at `:4567`): stop reading/committing `rps_entry` (`:4576`, `:4617`, `:4631-4655`). Build
  the v3 leaf without `rps_entry`. Emit the bond CdpMint with the **receipt leaf** carried to the controller
  (see plumbing §3c); legs become `[shares]` (drop the `rps_entry` leg).
- `OP_FARM_HARVEST` (arm at `:4665`): the receipt leaf is stable — prove membership of the SAME leaf, do NOT
  nullify it and do NOT re-mint an advanced receipt (remove the `farm_harvest_new_entry` advance at `:4712`).
  Emit a harvest CdpMint carrying the receipt leaf + `reward`. `farm_harvest_new_entry` (`cxfer-core/src/
  lib.rs:5156`) becomes dead — remove it.
- `OP_FARM_UNBOND` (arm at `:4785`): nullify the receipt leaf (spend-once, unchanged) and carry the leaf to
  `onCdpClose` so the controller clears the stamp; re-mint the LP-share notes (unchanged).
- `OP_LP_BOND` (arm at `:2436`, the LP_ADD+FARM_BOND fusion): mirror the bond change — drop `rps_entry`
  (`:2443`, `:2550`, `:2573`, `:2597`), carry the receipt leaf to the controller.
- `farm_receipt_leaf` (`cxfer-core/src/lib.rs`, def ~`:3583`/the `pub fn`, uses `:4584`, `:4707`, `:2573`):
  drop the `rps_entry` param, bump domain to v3.

### 3b. `FarmController.sol` (`contracts/src/FarmController.sol`)
- Replace `accrued` (`:77`) with `uint256 public totalRewardDebt` and add
  `mapping(bytes32 => uint256) public entryRps` (keyed by receipt leaf).
- `_accrue()` (`:190`) keeps updating `rps`/`lastUpdate`; drop the `accrued += rate·dt` line.
- `onCdpMint` bond branch (`:246-251`): remove the `rps_entry != liveRps` check entirely (H-01 goes away).
  Stamp `entryRps[leaf] = rps`; `totalShares += shares`; `totalRewardDebt += shares·rps`.
- `onCdpMint` harvest branch (`:253-261`): `require(entryRps[leaf] != 0)`;
  `require(reward·PRECISION ≤ shares·(rps − entryRps[leaf]))`; `totalRewardDebt += shares·(rps − entryRps[leaf])`;
  `entryRps[leaf] = rps`.
- `onCdpClose` unbond (`:278-294`): `totalShares −= shares`; `totalRewardDebt −= shares·entryRps[leaf]`;
  `delete entryRps[leaf]`. (Optionally allow a final harvest in the same op.)
- `recover` (`:173`): reserve `(rps·totalShares − totalRewardDebt)/PRECISION`; release `treasury − reserve`.
- `notify` funding check (`:161`): fund against `(rps·totalShares − totalRewardDebt)/PRECISION + newRate·duration`
  instead of `accrued + newRate·duration`.
- The controller now needs the **receipt leaf** as an argument. Remove `EntryNotLive`/`EntryAheadOfRps` errors.

### 3c. Pool → controller plumbing (`contracts/src/ConfidentialPool.sol`)
The controller callbacks (`onCdpMint` `:2092`, `onCdpClose` `:2114`) must receive the receipt leaf for farm
receipts. Today they get the `positionLeaf == 1` sentinel (`:2083`, `:2075`) and a nullifier. Cleanest option:
- For a farm receipt CdpMint, pass the receipt leaf via a dedicated argument. `rateSnapshot` is **inert for
  farms** (a farm accrues no cUSD debt) — repurpose it to carry the receipt leaf, OR (preferred) extend the
  `ICdpController.onCdpMint`/`onCdpClose` signatures with an explicit `bytes32 receiptLeaf` and thread the
  guest-provided leaf through. Keep `positionLeaf == 1` as the sentinel that still skips the CDP position
  insert (`:2075`). The receipt leaf itself is one of `pv.leaves` (already appended to the note tree), so it is
  guest-authenticated; the guest must place it where the CdpMint carries it and the pool must pass THAT value
  (assert it is a member of the appended leaves for this op, so a prover can't key the stamp on an
  unrelated/forged leaf).
- Update `ICdpController` interface (`:70-72`) accordingly.

### 3d. `CollateralEngine.sol` TSR savings (the analogue)
Mirror the same change for the cUSD savings receipts (`_savingsReceipt` `:736`, `savingsRps` `:169`,
`totalSavingsShares` `:170`, `feeBudgetCusd` `:159`, `onCdpClose` `:662`): drop the `rps_entry != savingsRps`
check, stamp `savingsEntryRps[leaf]` at execution, track `totalSavingsRewardDebt`, bound harvest against the
stamp, clear on unbond. `feeBudgetCusd` remains the fee-backing cap (unchanged).

## 4. Bitcoin lane — reflection parity (`contracts/sp1/confidential/src/reflect.rs`)
The farm also lives on the Bitcoin lane via reflection folds: `fold_lp_bond` (`:1664`), `fold_lp_harvest`
(`:1669`), `fold_lp_unbond` (`~:1787`), guarded by `cxfer_core::lp_bond_kernel_verify` /
`parse_lp_bond_fields_full`. There is no contract here — the **reflection guest state is the "controller."**
Apply the same stamp model in the reflection farm state:
- The reflection farm state must track `entry_rps` per receipt leaf and a `total_reward_debt` per farm, exactly
  like the contract. `fold_lp_bond` stamps `entry_rps[leaf] = farm.rps` at fold time; `fold_lp_harvest` bounds
  `reward ≤ shares·(rps − entry_rps[leaf])` and re-stamps; `fold_lp_unbond` clears. The v3 `farm_receipt_leaf`
  (no `rps_entry`) is shared with the ETH lane byte-for-byte.
- The two lanes must stay digest-identical for the same farm history (the reflection `digest()` invariants).
  This is the subtle part: verify a bond→harvest→unbond sequence produces the same farm state on both lanes.

## 5. Fixtures, tests, dapp, reprove
- **Guest tests (`cxfer-core`):** unit-cover `farm_receipt_leaf` v3 and the reflection stamp folds; a
  bond→accrue→harvest→accrue→harvest→unbond sequence with digest checks; a replayed harvest pays 0; recover
  returns exactly `treasury − outstanding`.
- **Solidity tests:** rewrite `contracts/test/FarmController.t.sol` and the TSR tests in
  `CollateralEngine.t.sol` for the stamp model. MUST include: mid-campaign join succeeds at an arbitrary live
  `rps` (the whole point); two stakers joining at different `rps` each harvest exactly their entitlement;
  unbond-without-harvest forfeits and the sponsor recovers it; a replayed harvest pays 0; `totalRewardDebt`
  invariant `reserve == Σ shares_i·(rps − entry_i)`. Delete the H-01 `==` tests (they encoded the removed
  behavior) — the `test_recover_returns_forfeited_budget_after_full_unbond` regression should survive in
  spirit (recover returns the full abandoned budget).
- **Harnesses:** update `harnesses/exec-lpbond.rs` (and any farm exec-*.rs) for the new witness layout.
- **Fixtures:** regenerate `fixtures/lpbond_op.json`, `fixtures/reflection_lpbond.json`, the farm
  ProofReal fixtures, and any `gen-*farm*/gen-*lpbond*.mjs` outputs.
- **dapp mirror:** `dapp/amm-envelope.js` (`encodeLpBond`/`decodeLpBond`), `dapp/amm-farm-actions.js`
  (`buildAndBroadcastLpBond` + the plain farm bond/harvest/unbond builders), `dapp/confidential-farm.js`,
  `dapp/confidential-earn-tab.js` — drop `rps_entry` from the built ops; the dapp no longer needs to read live
  `rps` to build a bond (a real UX win — no more just-in-time `rps` fetch).
- **Reprove:** this changes the settle ELF **and** the reflection ELF → both vkeys rotate. Coordinate with the
  reprove owner: regenerate all farm/lpbond fixtures, rebuild + re-pin ELFs/vkeys, `MODE=execute` parity per
  changed op, update `elf-vkey-pin.json` and the deploy scripts' `DEFAULT_VKEY`.

## 6. Invariants to preserve (do not regress)
1. Only the owner can harvest/unbond a position (signature bind — unchanged).
2. A harvest can never pay more than `shares·(rps − entry)` and never more than the treasury can back
   (ESCROW mode) or the emission schedule allows (MINT mode).
3. `recover` can never reclaim reward a live position has earned; when `totalShares == 0` it returns everything.
4. ETH-lane and BTC-lane farm state stay digest-identical for the same history.
5. A replayed/duplicated harvest pays 0; unbond is spend-once (leaf nullified).
6. `totalRewardDebt` never underflows (unbond subtracts exactly the stamped `shares·entry`).
7. EIP-170: `ConfidentialPool` (+92 B) and `ConfidentialRouter` (+29 B) headroom — the pool plumbing change
   must stay byte-frugal (prefer repurposing `rateSnapshot` over adding a struct field if bytes are tight).

## 7. Acceptance
Mid-campaign bond at an arbitrary live `rps` succeeds; multi-staker harvests are each exactly fair; recover is
exact; both lanes digest-match; full non-fork forge suite + cxfer green; reprove artifacts regenerated with
`MODE=execute` parity. Then the H-01 `==` stopgap is fully removed and farms are stake-anytime.

## 8. Interim posture (until this lands)
The shipped `==` fix is SAFE — no freeze, no overclaim — just join-limited. Farms are correct-but-cohort-only
in the interim. The refreshed audit bundle should note "farm entry is exact-live (`==`); a stake-anytime
MasterChef upgrade (execution-stamped entry) is specified and lands with the reprove."
