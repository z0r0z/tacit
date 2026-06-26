# PLAN — fast lane (Bitcoin-homed note spent directly on Ethereum)

> The shared-nullifier reverse path of `SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md` §8.
> Companion to [`PLAN-eth-reflection-modeB.md`](./PLAN-eth-reflection-modeB.md) +
> [`DESIGN-mode-b-recursion.md`](./DESIGN-mode-b-recursion.md). This is an **extension of the
> existing Mode-B reverse reflection**, not a new prover — it reflects a second storage slot
> through the same `eth-reflection` guest + recursion that already reflects `crossOutCommitment`.
> Post-launch milestone; the slow `bridge_burn → bridge_mint` path stays the race-free default.

## Status (2026-06-16)

**No deploy flag.** Pre-launch, every `ConfidentialPool` is a fresh immutable bundle, and the coherence
gate is already the pinned `BITCOIN_RELAY_VKEY` (the reflection guest a deploy is paired with). The fast
lane is just the contract's behavior; it is **safe iff deployed with the reflection guest that folds the
consumed-ν set** — the same vkey⇄guest discipline as everything else. A boolean would be cruft.

**Landed + verified (no vkey impact):**
- Contract — `bitcoinConsumed` map at **storage slot 119** (`crossOutCommitment` stays at 76), the
  `BitcoinNotesConsumed` event, the relaxed `btcHomed` bar (plain spend → {leaf, withdrawal, fee} allowed;
  AMM / locks / onward crossOut / EVM-deposit still bridge-only), and the **escrow-drain defense** (a
  btcHomed withdrawal/fee MUST target a pool-minted/bridged asset, never escrow — a real gap surfaced
  when `test_btc_homed_withdrawal_reverts` started failing with `InsufficientEscrow`). 8/8 btcHomed +
  full pool suite green.
- ABI — `EthConsumed` / `eth_consumed_leaf` / `eth_consumed_member` in `cxfer-core::eth_reflection`
  (pure additions, no guest behavior/vkey change), unit-tested.

**Guest bundle WRITTEN + compiles (host type-check; no re-prove yet):**
- `cxfer-core` — `ScanReflection.consumed_count` (state + `digest()` + resume), `fold_consumed` (membership
  at `consumed_count` → `Err`-on-miss; verify `ν==nullifier(Cx,Cy)` + `live[outpoint]==hash`; **remove the
  outpoint from `live`** = the Ethereum-senior void; then `fold_spent`). Genesis digest re-pinned
  `0dd951a9…→ c5b5d994…` in cxfer-core (test + JS-mirror test) and `ConfidentialPool.REFLECTION_GENESIS_DIGEST`.
- `eth-reflection/src/main.rs` — `consumedNuSetRoot`+`consumedNuCount` appended to `EthReflectionPublicValues`
  (fields 9/10), `CONSUMED_SLOT_INDEX=119`, key-matched slot fold, `eth_refl_digest` chains the consumed set.
- `reflect.rs` — Mode-B extraction of fields 9/10 (eth_pv now ≥ 11 words), the **senior-fold loop before the
  block scan** (panic-on-miss completeness: `consumed_count == consumed_nu_count`), resume reads `consumed_count`.
- cxfer-core + both guest crates compile; cxfer-core ABI/genesis tests + the 142-test forge pool suite green.

**Still PENDING (the atomic re-proven bundle + the open safety item):**
- **Re-prove on the prover host** (rotates BOTH `ETH_REFLECTION_VKEY` and `BITCOIN_RELAY_VKEY`) + re-pin:
  `elf-vkey-pin.json`, the `reflect.rs` `ETH_REFLECTION_VKEY [u32;8]` recursion digest (currently the OLD
  eth-reflection guest — the bundle is INCOHERENT until re-pinned), the contract `DEFAULT_VKEY`.
- **JS mirror** — `confidential-pool.js` `digest()` must add `consumed_count` + a `fold_consumed` port +
  `read_scan_prior_state` consumed read. **This is the parallel session's active fold-mirror work** (cBTC/
  swap_var/lp_* JS↔guest mirrors + `reflect-exec DIGEST_MATCH`): the fast-lane fold is another fold in that
  framework — land it in the SAME pass (one digest, one re-prove, one mirror update), not racing it.
- **Witness-stream wiring** — the assembler must emit the consumed witnesses (ν, spendRoot, Cx, Cy, source
  outpoint, set-path, spent-insert) in the senior-fold position (ahead of the per-block tx witnesses).
- **KAT** — a `reflect-exec` fixture exercising a consume fold + a voided racing Bitcoin spend.
- **Freshness gate — DESIGN RESOLVED + BUILT IN CODE (re-prove pending).** `fold_consumed` is sound only
  if the eth proof covers EVERY recorded consume; a stale/incomplete eth proof would leave a consumed
  note's outpoint live → double-credit. Enforcement is anchored in the eth-reflection GUEST, not the
  Bitcoin contract — because the eth-reflection reads FINALIZED Ethereum, and the completeness must be
  measured against the counter as of that same finalized block (comparing against the Bitcoin contract's
  current count would race finality). Landed:
  - `ConfidentialPool.bitcoinConsumedCount` (slot 120, appended last) — a monotone count of distinct
    `bitcoinConsumed` entries, advanced by exactly the batch's consumed count on each fast-lane value-exit
    (every ν is new — the nullifierSpent gate bars repeats). Forge: `test_fast_lane_consumed_count_advances`,
    `test_fast_lane_consumed_count_tracks_only_value_exits`.
  - `eth-reflection` guest reads slot 120 via the SAME finalized storage proof it already uses for the
    entries (`CONSUMED_COUNT_SLOT_INDEX = 120`, `plain_slot_key`), and asserts `consumed_count ==
    bitcoinConsumedCount` after the fold (MANDATORY — a missing counter slot fails the proof, fail-closed).
    So advancing the finalized slot REQUIRES folding every consume recorded as of it; the worker can no
    longer witness a subset. The Bitcoin guest's existing completeness (`consumed_count == consumed_nu_count`,
    `reflect.rs:245`) then transitively guarantees fold-all-recorded. No public-values-layout or Bitcoin-guest
    change — only the eth-reflection vkey rotates.
  - **Host wiring still pending (box step):** the eth-reflection witness builder must add slot 120
    (`bitcoinConsumedCount`, key = the slot index left-padded to 32 bytes — a plain var, not a mapping) to the
    `eth_getProof` request, alongside the crossOut + consumed mapping slots. Confirm the helios storage
    primitive returns an exclusion proof (value 0) for the slot while the count is still 0.
  - **Still gates deploy on the re-prove (vkey coherence):** the relaxed-bar contract must reach a live
    deploy only once the freshness-asserting eth-reflection guest is the pinned `ETH_REFLECTION_VKEY` and the
    consumed-ν fold is in `BITCOIN_RELAY_VKEY`. Until the atomic re-prove + re-pin ships, the §A checklist
    no-deploy holds (a non-folding/stale guest + the relaxed bar is a guaranteed double-spend).

## Goal

A note homed on Bitcoin (membership in the reflected Bitcoin pool tree) should be spendable on
Ethereum in **one tx**, without the `bridge_burn → bridge_mint` round-trip latency. Today
`ConfidentialPool` accepts a Bitcoin root as a `spendRoot` (`btcHomed`) and the settle guest already
proves each spent `ν` absent from the Bitcoin spent set (`check_btc_nonmembership`), but the value
exit is hard-barred (`BtcHomedValueExitMustBridge`) because reflection is one-directional: an
Ethereum-side spend of a Bitcoin-homed `ν` is never seen on Bitcoin, so the Bitcoin UTXO stays live.

## The one insight that makes this tractable

A note is a **bearer secret** — only the holder of its opening can produce a valid spend. So the
only party who can spend the same note on both chains is the **owner**. We therefore do not need to
*prevent* the cross-chain race (impossible — Bitcoin cannot lock a `ν` pending an Ethereum spend).
We need the authoritative reflected state to **credit the value at most once** and deterministically
**void the loser** — which is self-inflicted on the owner, never a third party. Inflation against
the pool is what must be prevented; that reduces to "the reflected spent set is the single arbiter."

## What already exists (reuse verbatim)

| Piece | Where | Role in the fast lane |
|---|---|---|
| Cross-lane non-membership | `confidential/src/main.rs` `check_btc_nonmembership(ν, bitcoin_spent_root)` — already called for **every** spent `ν` of every op | the fast-spend's "not yet spent on Bitcoin as of the last reflection" gate |
| `btcHomed` classification | `ConfidentialPool.sol:838` (`spendRoot ∈ knownBitcoinRoot`, not an EVM root) | identifies a fast-lane batch |
| Mode-B recursion | `confidential/src/reflect.rs:149-195` (`verify_sp1_proof(ETH_REFLECTION_VKEY, …)`, `mode_b` sentinel) | the engine that admits Ethereum-finalized state into the Bitcoin guest |
| `eth-reflection` guest | `eth-reflection/src/main.rs` (helios finality + `verify_storage_slot_proofs` + append-only set) | proves Ethereum storage slots; already pinned (`ETH_REFLECTION_VKEY`) |
| Reflected spent set | `reflect.rs` `spent_root`/`spent_count` (IMT), committed as `bitcoinSpentRoot` | the set the consumed-`ν` fold targets |

## The delta (5 pieces)

### 1. Contract — a dedicated consumed-`ν` accumulator + relax the bar  ✅ DONE + tested
- `mapping(bytes32 => bytes32) public bitcoinConsumed;` — `ν → spendRoot` (non-zero = consumed). A
  **dedicated** map, NOT `nullifierSpent` (which holds native EVM spends — reflecting those to Bitcoin's
  spent set is wrong + bloat). Mirror of `crossOutCommitment`; **`CONSUMED_SLOT_INDEX = 119`** (confirmed
  via `forge inspect`; `crossOutCommitment` stays at 76). Declared at end of storage.
- Relaxed `btcHomed` bar: a plain spend → **{leaf, withdrawal, fee}** is allowed and writes
  `bitcoinConsumed[ν] = pv.spendRoot` for every `ν` + emits `BitcoinNotesConsumed(ν[], spendRoot)`.
  **AMM (swaps/liquidity), locks, onward crossOut, EVM-deposit consumption stay bridge-only** (they
  compose with a lane the consumed-ν reflection doesn't cover — first-cut scope).
- **Escrow-drain defense (new finding):** a btcHomed withdrawal/fee MUST target a **pool-minted/bridged**
  asset (`assets[_resolveAsset(id)].poolMinted`), never an escrow asset — else a compromised guest could
  drain escrow funded by Ethereum wraps against a Bitcoin note that never funded it. Leaves are opaque
  (guest-bound to the note's bridged asset). Surfaced because the old withdrawal test began failing with
  `InsufficientEscrow` rather than the bar.

### 2. `eth-reflection` guest — reflect a second slot  (ABI ✅ done; guest pending re-prove)
- ABI landed: `EthConsumed { nullifier, spend_root }`, `eth_consumed_leaf = keccak(ν ‖ spendRoot)`,
  `eth_consumed_member` (`cxfer-core::eth_reflection`, unit-tested). `ν` is the key — no claimId binding.
- Guest (`eth-reflection/src/main.rs`): **append** `consumedNuSetRoot` + `consumedNuCount` to
  `EthReflectionPublicValues` **at the END** (so reflect.rs's existing by-offset reads of fields 2/3/8
  stay valid; the new fields are offsets 9/10). Verify each `bitcoinConsumed[ν]` slot (key
  `keccak256(ν ‖ 119)`, value `!= 0`), fold `ν` into a `KeccakTreeAccumulator`. Extend `eth_refl_digest`
  to chain the consumed set too. Changes `ETH_REFLECTION_VKEY` ⇒ re-prove.

### 3. Bitcoin reflection guest — fold consumed-`ν` Ethereum-senior, void via live-removal
- Read `consumed_nu_set_root` + `consumed_nu_count` from the verified eth public values (offsets 9/10).
- **BEFORE the Bitcoin block scan** (seniority), for each NEW consumed `ν` (`prior_consumed_count ..
  consumed_nu_count`): the prover witnesses `(Cx, Cy, outpoint)` + the set-membership path + the
  spent-IMT insert. Verify `ν == nullifier(Cx,Cy)`, `eth_consumed_member(ν, …)`, and
  `live[outpoint] == commitment_hash(Cx,Cy)`; then **remove `outpoint` from `live`** AND `fold_spent(ν)`.
- **Void mechanism = the live-removal, NOT a vin-scan skip.** `fold_spent` uses `.expect` (panics on a
  double-insert), so a racing Bitcoin spend must never reach it. Removing the consumed UTXO from `live`
  first means `scan_tx_spends` no longer sees it as a pool spend → the racing tx's CXFER outputs fail
  conservation → voided (skip-not-panic), with no double-insert.
- **Completeness is PANIC-on-invalid, not skip-not-panic** (the one place the discipline inverts): an
  omitted consumed `ν` leaves the note live on Bitcoin = double-spend, so the guest MUST fold the whole
  `[prior_count, consumed_nu_count)` range. `consumed_count` lives in `ScanReflection` + `digest()` (the
  resume pin) — this is the field that rotates `REFLECTION_GENESIS_DIGEST` (coordinate with the parallel
  session's `pools`/digest work). A note in a `knownBitcoinRoot` is always in `live` (its creation was
  scanned) + the fast-spend gate guarantees it wasn't yet Bitcoin-spent, so a valid witness always exists.
- Sentinel parity: `mode_b == 0 ⇒ consumed_nu_set_root = 0, consumed count unchanged` — a forward-only
  batch folds none, the same decoupling that lets the forward bridge re-prove without Mode-B.

### 4. Seniority / maturity rule (the race resolution)
- **Bitcoin spend reflected first** → `knownBitcoinSpentRoot` already holds `ν` → the Ethereum
  fast-spend's `check_btc_nonmembership` fails → fast-spend **rejected**. Bitcoin wins. (No contract change — the existing gate does this.)
- **Ethereum fast-spend first** → it is final on Ethereum immediately; the consumed `ν` is reflected
  (Ethereum-senior) and any racing Bitcoin spend in the lag is **voided** by §3.
- **Bitcoin-side recipients wait the maturity window** before treating a received note as final — the
  same reflection-finality wait every confidential note already requires. The Ethereum fast-lane
  recipient gets instant finality; the Bitcoin side has normal finality. Documented, not a defect.

### 5. Vkey cascade
- Rebuilding the `eth-reflection` ELF rotates **both** its on-chain `bytes32` `ETH_REFLECTION_VKEY`
  and its recursion `[u32;8]` digest (`reflect.rs:158`). Rebuilding the reflection ELF rotates
  `BITCOIN_RELAY_VKEY`. Recompute both via `prover-host/eth_vkey`, re-pin in `elf-vkey-pin.json` +
  the contract constructor + `reflect.rs`, in lockstep (the §5 cascade of `DESIGN-mode-b-recursion.md`).

## Why it's sound (design rationale)

- **At most one credit.** A given `ν` enters the authoritative reflected spent set exactly once
  (first-reflected wins; the Ethereum-direct fold is senior within a cycle). The EVM `nullifierSpent`
  gate already bars a second Ethereum fast-spend of the same `ν`. So total credited value ≤ note value.
- **No third-party harm.** Only the owner can produce the second spend; the voided side is the owner's
  own Bitcoin output. A counterparty is exposed only if it accepts a *pre-maturity* note — the same
  finality discipline as any confidential note.
- **Finalized-only reflection.** The `eth-reflection` guest reflects **finalized** Ethereum (helios), so
  a reorged-out fast-spend is never reflected. The maturity window = Ethereum finality (~13 min) + one
  Bitcoin reflection cycle (≥ `REFLECTION_CONFIRMATIONS` burial).
- **Forward bridge unaffected.** `bridge_mint` (BTC→ETH, race-free) and crossOut (ETH→BTC) are
  untouched; the fast lane is an overlay that reuses their sets with the ordering inverted
  (spend-then-reflect instead of consume-then-spend).

## Scope / phasing
1. Contract: `bitcoinConsumed` map + bar relaxation + slot-index pin. Unit-test the relaxed bar
   (a `btcHomed` value-exit reverts unless every `ν` is recorded).
2. `eth-reflection` guest: the second set + public-values fields + digest. Re-prove, re-pin both vkeys.
3. Reflection guest: senior consumed-`ν` fold + racing-spend void. KAT against a JS mirror.
4. Maturity-window doc + the seniority rule in the spec amendment (§8).
5. Sepolia round-trip: fast-spend a Bitcoin-homed note → fast-spend reflected → racing Bitcoin spend voided.

## Open decisions
- **First cut excludes** `lockLeaves`/`lockNullifiers`/`crossOuts` from a `btcHomed` batch (keep those
  bars). Revisit if the fast lane needs adaptor-swap or onward-bridge composition in one tx.
- Whether to bind `bitcoinConsumed[ν]` to the spendRoot (extra audit trail) or just a bool. Spend-root
  binding lets a later audit tie each consumed `ν` to the exact Bitcoin root it was proven against.
- Maturity-window length: tie to `REFLECTION_CONFIRMATIONS` (the deploy knob) so it scales with backing.

## Live Mode-B drive (2026-06-18) — what blocks the first real reverse-bridge fold

Driving `wrap → crossOut → 0x65 → fold` live on the canonical-signet pool `0x3D38a004` got steps 1–3
on-chain (crossOut `crossOutCommitment[0x64beaad5…]=0xb588cd2b…`, `0x65` reveal `c5142fbd…` @ signet 309292)
but surfaced three things in step 4 (the eth-reflection prove + the Bitcoin Mode-B fold):

1. **eth_prove stale-block bug — FIXED in source.** `eth_prove.rs` read `exec_block` from the pinned-genesis
   bootstrap store, not the advanced finalized header, so `eth_getProof`/`eth_getLogs` hit a block thousands
   of slots before the crossOut. Now reads it from `finality_update.finalized_header()` (the block the guest
   advances to + verifies storage against). Confirmed: getLogs then finds the crossOut.

2. **Beacon update/finality period gap — config.** `get_updates(genesis_period, 128)` returned only periods
   1277–1279 while finality was period 1281, so the guest's `verify_finality_update` can't reach the
   finality committee. Need a consensus RPC that serves the full update chain through `finality_period − 1`
   (publicnode lagged). No code change; pick the RPC / retry until the update set bridges to finality.

3. **🔴 `bitcoinConsumedCount` (slot 120) is never seeded — requires a fresh deploy.** At count 0 the slot is
   absent from the storage trie, so `eth_getProof` returns an **exclusion** proof and the guest's
   `verify_storage_slot_proofs` rejects it (`main.rs:130`; the guest then `expect`s the slot at `main.rs:154`).
   Seeding 0 in the ctor is impossible (a zero slot is deleted, never stored). The two coherent fixes, both
   rotating the eth-reflection vkey → reflection-prover → BITCOIN_RELAY_VKEY (so they fold into the alpha
   re-prove + a fresh pool deploy):
   - **(preferred) handle the exclusion proof:** extend `sp1_helios_primitives::verify_storage_slot_proofs`
     (vendored at `/root/sp1-helios/primitives`, NOT in this repo) to verify an exclusion proof and yield
     value 0, then let the guest read `bitcoinConsumedCount` as 0 when provably absent. Keeps count/set at 0,
     no sentinel. Soundness is preserved — a verified exclusion proves the slot is genuinely 0, so the
     freshness invariant (fold every recorded consume) still holds (there are none).
   - **(alt) non-zero sentinel:** ctor seeds `bitcoinConsumedCount = 1` (writes the slot → inclusion proof),
     mirror the existing spent-set `imt_leaf(0,0)` sentinel by genesis-seeding the eth + Bitcoin consumed
     sets with one sentinel leaf (`prior_consumed_count = 1`), and real consumes increment from 1. Coherent
     but spans contract + cxfer-core + reflect.rs + eth-reflection guest + the JS mirrors — implement in ONE
     pass; a contract-only seed makes the repo incoherent-if-deployed.

   Do NOT land a partial slot-120 change: it rotates vkeys and can't be validated without the full re-prove.

**Also fold into the same cycle:** re-pin a fresher `GENESIS_SLOT` / `ETH_GENESIS_SYNC_COMMITTEE` (the pinned
slot 10462624 is ~4 periods back; it still works but the older it gets the more updates the guest must verify
in-circuit), and re-pin `reflect.rs ETH_REFLECTION_VKEY` to the rebuilt eth-reflection vkey (the local
committed value is the reverted mainnet placeholder; the box build pins the Sepolia recursion vkey
`[316051978, 39823114, …]` / on-chain `0x0025ad24…`).
