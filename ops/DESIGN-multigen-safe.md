# DESIGN — Safe multi-generation launch (cheap TAC bridging, no cross-gen double-mint/spend)

Status: design-for-review. No production code changed by this document.
Author context: written against `relay-boundary-reorg-forkchoice` @ 6c2c5ff4.

## Purpose

Let a new immutable ConfidentialPool generation launch that (1) keeps TAC bridging cheap/fast/easy, (2) leaves
the owner's old demo pools live and un-destroyed while preventing them from subverting the new pool, and (3) is
provably safe against cross-generation double-spend, double-mint, and bad accounting. The recommendation is a
seed-construction change only — no guest edit, no vkey rotation.

---

## Part 1 — Investigation (answered, with file:line)

### 1. What the reflection resume seed (`ScanReflection`) contains

Struct: `contracts/sp1/confidential/cxfer-core/src/lib.rs:3701-3778`. Read from stdin in
`read_scan_prior_state()` `contracts/sp1/confidential/src/reflect.rs:143-320`; the resume digest is a keccak
chain over every field in `digest()` `lib.rs:3824-3868`. The on-chain pin is `knownReflectionDigest`
(`contracts/src/ConfidentialPool.sol:867-868`), enforced at the first attest by
`if (r.priorDigest != knownReflectionDigest) revert StaleReflectionDigest;` (`ConfidentialPool.sol:1789`).

Classifying every field as **(a)** spendable note balances, **(b)** asset-level state, **(c)** anti-double-spend
accumulator:

| # | field | type | lib.rs | class | role |
|---|-------|------|--------|-------|------|
| 1 | `pool_root` | `[u8;32]` | 3702 | a | note-tree (all appended note commitments) root — membership target for spends |
| 2 | `note_count` | `u64` | 3703 | a | note-tree size |
| 3 | `spent_root` | `[u8;32]` | 3704 | **c** | global spent/nullifier IMT root (sentinel-seeded) |
| 4 | `spent_count` | `u64` | 3705 | **c** | spent-set size |
| 5 | `live` | `LiveUtxoSet` | 3706 | **a** | the SPENDABLE UTXO note set (outpoint key, commitment hash, asset, auth_key) |
| 6 | `burn_root` | `[u8;32]` | 3707 | **c** | bridge-burn (burnId) IMT root — the one-mint gate |
| 7 | `burn_count` | `u64` | 3708 | **c** | burn-set size |
| 8 | `height` | `u64` | 3709 | b | Bitcoin scan height |
| 9 | `cbtc_locks` | `LiveUtxoSet` | 3715 | b | self-custody cBTC.zk lock set |
| 10 | `cbtc_backing_sats` | `u64` | 3716 | b | Σ live cBTC peg backing |
| 11 | `pools` | `PoolReserveSet` | 3719 | b | per-pool AMM reserve registry |
| 12 | `consumed_count` | `u64` | 3723 | **c** | count of eth-fast-consumed ν folded into the spent set |
| 13 | `eth_refl_digest` | `[u8;32]` | 3729 | **c** | eth-reflection anchor (binds crossOut + consumed-ν roots/counts) |
| 14 | `farm_rewards` | `FarmRewardSet` | 3736 | b | per-farm reward-per-share accumulator |
| 15 | `farm_entries` | `FarmEntrySet` | 3741 | b | per-position entry-rps stamps |
| 16 | `consumed_crossout_root` | `[u8;32]` | 3748 | **c** | ETH→BTC cross-out (claim_id) replay gate |
| 17 | `consumed_crossout_count` | `u64` | 3749 | **c** | " |
| 18 | `honored_msg_root` | `[u8;32]` | 3757 | **c** | honored eth msg_id one-shot gate |
| 19 | `honored_msg_count` | `u64` | 3758 | **c** | " |
| 20 | `folded_crossout_count` | `u64` | 3766 | **c** | real cross-out mints folded (forward catch-up pin) |
| 21 | `consumed_outpoints_root` | `[u8;32]` | 3776 | **c** | **cross-lane double-mint gate**: fast-consumed Bitcoin outpoints IMT |
| 22 | `consumed_outpoints_count` | `u64` | 3777 | **c** | " |

The digest commits ALL 22 fields as a single hash. Consequence that shapes the design: **the resume seed is not
opaque catch-up data — it is a fully-specified `ScanReflection` value the worker reconstructs and whose digest
the constructor pins.** We are free to choose ANY internally-consistent value (e.g. empty class-a fields,
inherited class-c fields) and pin its digest. This is the lever the recommendation uses.

The only fields that carry **spendable value** are the class-(a) pair `pool_root`/`note_count` + `live` (and the
class-(b) `cbtc_locks`, `pools`, farms as protocol positions). The class-(c) fields carry NO value — they are
monotone, sentinel-seeded IMTs that only ever *reject* a replay.

### 2. What specifically makes bridging old TAC expensive without the seed

Two distinct costs, only one of which the seed ever addressed:

- **Historic pre-burn-deposit cost (the one the seed shortcut):** originally the ONLY way an old etched note
  became bridgeable was to fold the asset's whole Bitcoin history into the pool's `live` set via the reflection
  scan (the "7578 notes, TAC folded" seed at `redeploy-v3.env:23`). Bootstrapping that scan from genesis is the
  days-long full-scan; the near-tip seed pre-installed the already-folded live set so no bootstrap ran. This is
  the "catch-up data in the constructor" the owner remembers.

- **Big-fold liveness trap (a HEIGHT problem, not a note-set problem):** seeding a digest far *behind* the relay
  tip forces the first attest to fold hundreds of blocks in one ~1.5GB proof (`redeploy-v3.env:1-6`). This is
  fixed by seeding `height` near `relay.tip()-CONFIRMATIONS`, independent of what notes are in the set.

**Burn-deposit made the note-set seed unnecessary for bridging.** `burn_deposit::verify_provenance[_leaves]`
(`cxfer-core/src/burn_deposit.rs:375-411`) is SELF-PROVING: it proves the burned note descends from the etch
supply note `C_0` (or an authorized cmint leaf) through a holder-supplied, relay-confirmed provenance DAG. It
needs no pool-resident balances. The per-bridge cost is holder-borne (the provenance DAG + the pre-anchor header
chain) and is bounded by the note's own trading depth, NOT by the seed. The reflect.rs dispatch fires exactly
when the burned note is NOT in the live set (`spends.is_empty()`), i.e. a never-reflected note
(`ops/DESIGN-trustless-asset-onboarding.md` "Trigger" + reflect.rs:865-1140).

**Net:** cheap TAC bridging today requires only (i) a near-tip `height`/anchor to dodge the big fold, and (ii)
the etch/relay path the *holder* supplies. It does NOT require the old note set. Seeding balances buys nothing
for bridging cost — it only imports the cross-gen double-spend surface.

### 3. Is cheap-bridging state separable from the note set + shared state?

Yes — cleanly. Bridging cost lives in class-(b) `height`/anchor + holder-borne provenance. The spendable value
lives in class-(a) `live`/`pool_root`. The double-mint safety lives in the class-(c) accumulators. These are
three disjoint groups of fields in one struct, and because the seed is a chosen `ScanReflection` we can set each
group independently:

- Cheap bridging ⇐ `height` near relay tip. (No dependence on live notes.)
- Empty spendable value ⇐ `live = ∅`, `pool_root = EMPTY_TREE_ROOT`, `note_count = 0`.
- Double-mint safety ⇐ inherit the Bitcoin-side class-(c) accumulators (see #4).

The one real entanglement to be careful about: burn-deposit does `fold_note_append` into `pool_root`
(reflect.rs:1089-1091, append-only, "never live"), and the double-mint gate reads `spent_root` +
`consumed_outpoints_root` (reflect.rs:987-1020, 1053-1062). So safety needs the class-(c) *accumulators* seeded,
but NOT the class-(a) *live/tree*. They are separable: an inherited spent-ν whose tree note we drop simply can
never be re-spent (no tree membership possible) — safe, and even belt-and-braces.

### 4. Cross-gen double-mint/spend of TAC specifically — what stops it

Three independent facts, from the code:

**(i) A single Bitcoin burn is redeemable in EXACTLY ONE deployment.** `bridge_burn_id` folds
`target_chain_binding = keccak(chainid, poolAddress)` (`lib.rs:1586-1606`); the settle mint reconstructs the
burnId with its OWN binding, so "a burn that targeted generation G1 is absent from the burn set G2 recomputes
against" (`lib.rs:1588-1590`). So the SAME on-chain burn cannot pay out in two generations.

**(ii) Each Bitcoin UTXO can be burned once (Bitcoin consensus).** A fresh burn-deposit spends a distinct
Bitcoin outpoint. Two mints therefore need two burns of two UTXOs = two real supply units = legitimate, not
inflation.

**(iii) The dangerous residue — the SHARED RESUMED STATE — is what actually opens double-spend/mint:**
- *Shared live note (double-SPEND):* if the new pool RESUMES the old pool's `live` set, a note is live in both
  pools' independent forward evolution. It can be spent once in each (each records ν in its OWN `spent_root`),
  yielding two EVM effects for one Bitcoin-homed note. This is the C-01 surface
  (`ops/DESIGN-c01-generational-retirement.md`). Closed by starting with `live = ∅`.
- *Fast-consumed-then-burn-deposit (double-MINT of a Bitcoin-homed note):* the old pool may have fast-consumed
  an outpoint on the ETH lane (removed from `live` via `fold_consumed`, recorded in `consumed_outpoints_root`,
  reflect.rs:579-586) while its Bitcoin UTXO stayed unspent. A holder could then burn that Bitcoin UTXO into a
  FRESH-empty new pool via burn-deposit → a second mint. The intra-pool gate that closes this is the
  `consumed_outpoints_root` non-membership check (reflect.rs:987-1020) — but it only works if the new pool
  INHERITS the old pool's `consumed_outpoints_root`. With an empty gate it does not span generations.
- *Re-bridge of an already-bridged note:* a note bridged out of the old pool folded its ν into the old
  `spent_root` and its burnId into `burn_root`. Re-presenting the same burn is caught by the spent-set
  membership no-op (reflect.rs:1053-1057) — again only if the new pool inherits `spent_root`.

So double-spend of resumed notes is closed by an **empty live set**; Bitcoin-homed double-mint is closed by
**inheriting the Bitcoin-side class-(c) accumulators** (`spent_root`, `burn_root`, `consumed_outpoints_root`,
`consumed_count`). The chain-binding (i) already blocks the naive "replay one burn in two pools" path.

**On canonical tokens (why old pools can't mint into the new one):** each `CanonicalBridgedERC20` has an
immutable `MINTER` = the pool that deployed it (`CanonicalBridgedERC20.sol:41,62,101-104`), and the address is
`f(assetId, minter, …)` (`CanonicalAssetFactory.sol:9,26-28`). A different generation = different minter =
different token address. The new pool only registers tokens it itself mints
(`registerMinted` requires `MINTER() != address(this)` to revert, `ConfidentialPool.sol:1076`;
`_autoRegisterFromMeta` early-returns on foreign minter, `:2545`). So an old pool's canonical TAC token is a
distinct contract the new pool never mints or registers.

---

## Part 2 — Options evaluated

### Option A — asset-anchor seed + empty everything (empty class a, b, AND c)

Seed a near-tip `height`/anchor with a genesis-empty state (`reflectionResumeDigest_ = 0` → `REFLECTION_GENESIS_DIGEST`,
`ConfidentialPool.sol:867-868`). Bridging is cheap (self-proving + near-tip anchor). No shared live notes ⇒ no
double-spend of resumed notes.

**Gap:** the Bitcoin-homed double-mint of #4 (ii-b) is NOT closed. If any old pool fast-consumed a TAC outpoint
whose Bitcoin UTXO is still unspent, that UTXO can be burn-deposited fresh into the new pool for a second mint.
For the owner's inert test pools this is *probably* empty, but it rests on an operational check, not a proof.
**A is safe only if verified that no old pool holds a fast-consumed-but-Bitcoin-unspent TAC outpoint.**

### Option B — on-chain predecessor retirement (the DESIGN-c01 forward hook)

The new pool proves-retires the old pool so it can't subvert, then a bounded resume is safe. **Not available for
this launch:** the pool being superseded is already deployed and immutable — it has no `retire()` hook and
cannot be given one (`ops/DESIGN-c01-generational-retirement.md:48-61`). The current constructor already DISABLES
the authenticated non-zero-predecessor path (`if (predecessor_ != address(0)) revert
GenerationalMigrationDisabled();`, `ConfidentialPool.sol:887-888`, commit fd3bf1fc). B is the *forward* design
for how THIS generation can itself be retired by a FUTURE one; it costs a new immutable-core addition (freeze
gate on every value entrypoint + a successor-authenticated `retire()`), does not rotate a vkey if done
contract-side, and needs the B1/B2/B3 successor-binding decision. **Recommend building B into this generation for
the future, but it does not gate this launch.**

### Option C — inherit ONLY the anti-double-spend accumulators (empty class a/b, inherit class c)

Seed `live = ∅`, empty tree, empty pools/cbtc/farms, near-tip height, but carry the old pool's class-(c)
accumulators. Already-bridged / already-consumed TAC cannot re-bridge (inherited `spent_root` +
`consumed_outpoints_root`), and no spendable note carries (empty `live`). This closes double-mint WITHOUT
reintroducing double-spend, because the inherited fields are value-free monotone reject-only sets — importing
them can only *forbid* mints, never authorize a spend.

**Refinement — split class-(c) into Bitcoin-side vs ETH-side.** The ETH-side gates (`eth_refl_digest`,
`consumed_crossout_*`, `honored_msg_*`, `folded_crossout_count`) anchor the OLD pool's eth-reflection contract
and forward crossOut counters. The new pool ships its own eth-reflection; inheriting the old anchor would bind
the new pool to a foreign accumulator. These should start FRESH (sentinel-seeded). Only the Bitcoin-side gates
that guard Bitcoin-homed supply need inheriting.

---

## Part 3 — RECOMMENDATION: Option C (Bitcoin-side accumulator inheritance), + B as forward work

Adopt a **curated empty-note resume that inherits only the Bitcoin-side anti-double-spend accumulators.** This is
the smallest change that makes all three failure modes provably closed while keeping bridging cheap, and it needs
NO guest/vkey/contract change — it is a choice of seeded `ScanReflection` value plus the matching digest in the
existing constructor.

### Exact seed (the `ScanReflection` whose `digest()` becomes `reflectionResumeDigest_`)

Let `OLD` = the directly-superseded pool's final attested reflected-state JSON.

| field | seed value | rationale |
|-------|-----------|-----------|
| `pool_root` | `EMPTY_TREE_ROOT` | drop all inherited notes (re-bridgeable) |
| `note_count` | `0` | " |
| `live` | `∅` (empty set root) | **closes cross-gen double-SPEND** — no shared spendable note |
| `height` | `relay.tip() - REFLECTION_CONFIRMATIONS` at deploy | **keeps bridging cheap** — no big fold |
| `cbtc_locks` / `cbtc_backing_sats` | `∅` / `0` | new peg starts empty |
| `pools` | `∅` | new AMM registry |
| `farm_rewards` / `farm_entries` | `∅` / `∅` | new farms |
| `spent_root` / `spent_count` | **inherit `OLD`** | **closes re-bridge** — old spent ν reject a second bridge |
| `burn_root` / `burn_count` | **inherit `OLD`** | one-mint gate for already-paid burns |
| `consumed_outpoints_root` / `consumed_outpoints_count` | **inherit `OLD`** | **closes fast-consume→burn-deposit double-MINT** |
| `consumed_count` | **inherit `OLD`** | keep the fast-consumed-ν pin consistent with `spent_root` |
| `eth_refl_digest` | fresh (new pool's genesis eth-reflection anchor) | new ETH lane |
| `consumed_crossout_*` / `honored_msg_*` / `folded_crossout_count` | fresh sentinel | new ETH lane (see open Q3) |

`GENESIS_REFLECTION_ANCHOR` = the matured block hash at the seeded `height` (re-verify at deploy exactly as
`redeploy-v3.env:24-26` instructs). `reflectionResumeDigest_` = `digest()` of the above. `predecessor_ = 0` (the
existing guard is satisfied; no migration handshake needed — the `rebasedFromDigest == 0` / `priorDigest ==
knownReflectionDigest` path at `ConfidentialPool.sol:1786-1789` is exactly this resume).

### Why it is safe (all three closed)

- **Double-spend of resumed notes:** impossible — `live = ∅`, so no note exists in both generations' spendable
  sets. An inherited spent-ν with no tree note can never be spent (no `pool_root` membership).
- **Double-mint of Bitcoin-homed TAC:** the two cross-gen mint paths both hit an inherited reject: a re-presented
  bridge burn is a `spent_root` membership no-op (reflect.rs:1053-1057); a fast-consumed-then-burn-deposit hits
  `consumed_outpoints_root` membership → `return None` (reflect.rs:998-1009). A single Bitcoin burn is
  chain-bound to one pool (`lib.rs:1586-1606`), and each Bitcoin UTXO burns once. So supply is conserved: one
  Bitcoin burn ⇒ at most one EVM mint, across all generations.
- **Bad accounting:** the inherited accumulators are monotone, value-free, reject-only. Seeding them can only
  forbid a mint, never authorize a spend or a mint — so importing them cannot itself create value or inconsistency.

### Why TAC bridging stays cheap

Bridging is `burn_deposit::verify_provenance_leaves` (self-proving, holder-borne provenance + relay-confirmed
inclusion, `burn_deposit.rs:375-411`) firing on the empty-live-set branch (reflect.rs:865). Its cost is the
note's own provenance depth + the pre-anchor header chain the holder supplies — unchanged by the seed. The
near-tip `height` avoids the big single fold. The inherited accumulators add ZERO per-bridge cost (a
membership/non-membership witness is one IMT path, already part of every burn-deposit). TAC airdropped on EVM
bridges back via the same self-proving path with no per-deploy config.

### Code / process changes implied

- **Guest (reflect.rs / cxfer-core):** NONE. The seed is a different `ScanReflection` value; the read order,
  digest, and folds are unchanged. **No vkey rotation.**
- **Constructor (ConfidentialPool.sol):** NONE. `predecessor_ = 0`, `reflectionResumeDigest_ =` the curated
  digest. Uses the existing arbitrary-resume path.
- **Seed builder (`tools/reflection-bootstrap-v2.mjs`):** produce the curated state — empty class-a/b, inherited
  Bitcoin-side class-c from `OLD`, fresh ETH-side class-c — and emit its digest. This is the only real work item.
  Add a unit check that `digest(curated) == reflectionResumeDigest_` and that class-a fields are the canonical
  empty roots.
- **Worker (`worker-relay` / `worker`):** repoint `POOL_ADDR` to the new pool and seed the folder from the
  curated state JSON (not `OLD`), so future IMT insert witnesses are built against the inherited roots.
- **Dapp:** must not surface old-pool balances (they are intentionally dropped); the bridge UI already targets
  the new pool's CHAIN_BINDING via `bridge_burn_id`.

### How old demo pools are respected — and practically decommissioned

- **Left live, not destroyed:** the old pools are immutable and remain deployed. Their canonical tokens keep
  `MINTER = oldPool`, a different address from the new pool's tokens, so they cannot mint into or be registered
  by the new pool (`ConfidentialPool.sol:1076,2545`). Nothing about them is touched.
- **Cannot subvert the new launch:** any burn a user makes toward an old pool is chain-bound to it
  (`lib.rs:1586-1590`) and cannot pay out in the new pool; any TAC already bridged/consumed there is imported as
  a *reject* in the new pool's inherited accumulators. So the old pools can be used, ignored, or abandoned
  without endangering the new pool's supply accounting.
- **Practical decommission:** stop the old pools' workers (no further attests), point all infra at the new pool,
  and re-run the launch-checklist balance sweep from `ops/DESIGN-c01-generational-retirement.md:32-35` to confirm
  zero withdrawable escrow. Old user balances are abandoned by design (re-bridgeable via burn-deposit).

---

## Part 4 — Open questions for the owner

1. **Which old pool is `OLD`?** The lineage has ≥2 prior pools
   (`0x…0f5DE1` resumed last, predecessor `0x…c5B537`, and the reflection-live `0x…f88564`). Confirm which pool's
   final attested state is the one whose Bitcoin-side accumulators we inherit — it must be the pool that actually
   performed TAC bridges/fast-consumes on mainnet. If TAC was bridged across MORE than one old generation, the
   inherited accumulators must be the UNION of every prior pool's `spent_root`/`burn_root`/`consumed_outpoints_root`
   (an outpoint consumed in gen-1 but not gen-2 is still a double-mint risk). Enumerate the full lineage before
   building the seed.
2. **Is Option A acceptable instead?** If a deploy-time sweep proves NO old pool holds any fast-consumed-but-
   Bitcoin-unspent TAC outpoint AND no reflected TAC live note whose Bitcoin UTXO is unspent, then the empty
   genesis seed (Option A, `reflectionResumeDigest_ = 0`) is equally safe and simpler. Option C is the robust
   choice that does not depend on that sweep being (and staying) empty. Recommendation: C, unless the sweep is
   trivially and permanently empty.
3. **ETH-side accumulators fresh vs inherited.** The recommendation starts `eth_refl_digest`/`consumed_crossout`/
   `honored_msg`/`folded_crossout_count` fresh, since the new pool ships its own eth-reflection. Confirm the new
   pool's ETH-reverse lane genuinely starts empty (no in-flight ETH→BTC crossout from an old pool that could be
   honored twice). If any old ETH→BTC crossout is mid-flight, those gates must be inherited too.
4. **Ship the forward retirement hook (Option B) now?** It cannot be added after deploy (immutable). Building the
   `retire()` + freeze-gate into THIS generation is the only way a future migration can be closed on-chain rather
   than by the inert-pool invariant. Decide B1/B2/B3 (`ops/DESIGN-c01-generational-retirement.md:118-133`) before
   this immutable deploy if a funded future migration is ever wanted.

---

## Appendix — key evidence index

- Resume struct + digest: `cxfer-core/src/lib.rs:3701-3778` (fields), `:3824-3868` (digest).
- Resume read order: `reflect.rs:143-320`.
- Burn-deposit self-proving: `burn_deposit.rs:375-411`, `verify_provenance_dag_leaves` `:65-147`.
- Burn-deposit dispatch + double-mint gate: `reflect.rs:865-1140`, non-membership gate `:987-1020`, spent no-op
  `:1053-1062`, note append + burn `:1076-1094`.
- Fast-lane consume → `consumed_outpoints_root`: `reflect.rs:564-586`.
- Chain-bound burnId (one-deployment redemption): `lib.rs:1573-1606`.
- Constructor + resume pin + predecessor guard: `ConfidentialPool.sol:800-812, 843, 867-868, 887-888,
  1746-1790`.
- Canonical-token minter isolation: `CanonicalBridgedERC20.sol:41,62,101-104`; `CanonicalAssetFactory.sol:9,26-28`;
  `ConfidentialPool.sol:1076,2545`.
- Deploy env precedent: `contracts/deployments/redeploy-v3.env:1-47`.
- C-01 prior analysis / forward hook: `ops/DESIGN-c01-generational-retirement.md`.
- Onboarding cost model: `ops/DESIGN-trustless-asset-onboarding.md`.

## Launch input — the prior TAC-bridging pool set (owner-provided 2026-07-30)

The Option C seed must inherit the UNION of these five prior pools' reject-only Bitcoin accumulators
(`consumed_outpoints`, `spent`, `burn`), so no TAC outpoint any of them already consumed/fast-consumed can be
re-bridged into the launch pool. On-chain at record time each holds at most test dust (≤ ~$32 total), consistent
with demo/rehearsal pools.

**AUTHORITATIVE SET — 14 pools (owner's 5 + 9 found by deployer-wallet enumeration).** Blockscout full-history
scan of deployer 0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7: 85 CreateX deployCreate3 calls → 218 created
contracts → 14 confirmed ConfidentialPools (bytecode carries the attestBitcoinStateProven selector, cbtcBackingSats
responds, outstandingCusd reverts, codesize ~24.5KB). The launch seed inherits the union of ALL 14 (over-include
is safe; a missed pool is the bug). Owner's list was materially incomplete.
 1. 0x000000000049Cc3f65588E74d9c25B66781da8dB  (owner's; attest×9/settle×16/wrap×5; **cbtcBackingSats=10000 — live BTC backing**)
 2. 0x00000000002Ea3FE47221092e712A0fBC4a8A49d  (owner's; attest×5/settle×4/wrap×1)
 3. 0x0000000000846B447cab17D52425A5B214D4A072  (owner's; attest×2/settle×5/wrap×1)
 4. 0x0000000000f88564FCFe77d0D16c12dFdD7f717a  (owner's; attest×2/settle×4/wrap×1)
 5. 0x0000000000c5B537A7c3622d1418D5771914C03D  (owner's; attest×4/settle×31/wrap×12)
 6. 0x00000000002Cef2F3C5C9fA087C612c1f15860Da  (EXTRA; attest×2/settle×1)
 7. 0x0000000000dc5A8083a1E00363f2aCDAd9e6fFEd  (EXTRA; attest×3)
 8. 0x00000000000f5DE1295Ab2F0649fDE3855b66020  (EXTRA; attest×2; the "V2 redeploy" pool)
 9. 0x000000000013f1C523585cd98E527c7f9285a21C  (EXTRA; the "V1 mainnet" pool)
10. 0x000000000000557618Aa46429C12f5d60eb71Fb3  (EXTRA; deployed, idle from deployer)
11. 0x00000000002Af3e631ddC7c2CCebd97956d8bb0E  (EXTRA; deployed, idle from deployer)
12. 0x00000000004290D9aDaFdCd5540B1896E82B7E8b  (EXTRA; deployed, idle from deployer)
13. 0x0000000000630fC2DDc169Bc1862683577e9D610  (EXTRA; deployed, idle from deployer)
14. 0x00000000008E02B8b33cbb833D7B5C15e6ED28ad  (EXTRA; wrap×1)

COMPLETENESS: owner confirmed (2026-07-31) that 0x68575B is the SOLE pool-deployer wallet. The enumeration
paginated that deployer's full history to exhaustion, so this 14-pool set is provably complete — there is no
other EOA whose pools could be missed. The seed's inheritance union is therefore final.

### Seed-build recipe (deploy-time, needs each pool's reflection state)
For each pool, reconstruct its consumed-outpoints / spent / burn leaf sets from its attested reflection history
(worker DB / re-fold). Build a single curated `ScanReflection`:
- **empty** value: `note_root`/`note_count`/`live` = the empty-tree genesis values (no balances carry);
- **near-tip** `height` (relay tip − confirmations) so bridging incurs no big-fold catch-up;
- **unioned** reject-only accumulators: `consumed_outpoints_root` / `spent_root` / `burn_root` built from the
  union of all five pools' leaf sets (an IMT/tree over the combined leaves — union the LEAVES, then rebuild the
  root; roots can't be merged directly);
- ETH-side gates (crossout/honored/eth_refl) = fresh genesis.
Compute `digest()` → this is the launch `reflectionResumeDigest_` (with `predecessor_ = 0`). Publish the full
serialized seed + the per-pool leaf sources + a deterministic rebuild script (the R-01 attestation item), so the
seed is independently reproducible. The tool is `tools/reflection-bootstrap-v2.mjs`.
