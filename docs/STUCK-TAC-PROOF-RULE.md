# Stuck TAC: segmented provenance with deposit-leaf anchors

Status: design entry (bounty option D) — implemented and tested at the cxfer-core layer, no deploy.
The live pool, the proof's verifying key and every deployed contract stay as they are; this entry
ships as a successor-generation design (SPEC §8 lineage) plus the pure verification core the guest
will link.

## What it does

Two edges stop a burn-deposit's provenance walk today (STUCK-TAC-BOUNTY.md §1): a note that left
Bitcoin's shielded pool (a `T_BTC_SPEND` exit, opcode 0x6D) has no `T_CXFER` history behind it, and
a note with more than 255 transfers fails the `ncx > 256` blob cap. This entry removes BOTH with one
rule: **a provenance lineage may split into SEGMENTS at anchor points the reflection itself has
proven.**

An anchor is an `(outpoint, commitment_hash)` pair backed by one of:

1. the etch supply note `C_0` (as today) — the walk bottoms out at real supply;
2. a **deposit-leaf anchor** — a pair proven by MEMBERSHIP in a new accumulator
   (`depositLeavesRoot`) that the reflection fold itself writes every time it onboards a note (a
   conserving CXFER output, a proven cross-out mint, a verified burn-deposit deposit, or a verified
   shielded-pool exit). The outpoint is the IMT key and the commitment hash the value, both derived
   from the fold's own verification — never witnessed freely;
3. a pool-membership leaf (the existing `verify_pool_membership_leaf` shortcut, now actually usable).

A lineage of any age then verifies as ≤256-hop segments stitched at anchors, and a note born in the
shielded pool starts its lineage at its exit's deposit leaf — no `C_0` needed, because the exit
proof (`verify_btc_pool_spend`) is itself the fact that anchors it.

## Why it is sound (the same trust level as `C_0`)

The existing refusal of pool-membership leaves (reflect.rs, `fold_burn_deposit` step 4) exists
because `verify_pool_membership_leaf` proves only that (asset, cx, cy, owner) sits in the note tree
— the OUTPOINT is an unbound witness field, so a holder of any tracked note's opening could spend a
dust UTXO "as" that note, burn the hop's output and mint the note's value here, repeatably, while
the real note stays live on Bitcoin.

The deposit-leaf accumulator closes exactly that gap: its key IS the outpoint, inserted once by the
fold's own onboarding path (`fold_deposit_leaf_auto`), committed in the resume digest, and never
removed. A membership proof over it is therefore the statement "the reflection onboarded THIS note
at THIS outpoint" — the same class of fact as "the etch produced C_0". The live UTXO set carries the
same keying but is spent-state (removed on spend); the accumulator is append-only, so an anchor
stays valid across a note's whole history — including the burned note itself, which is spent by the
burn tx and could never anchor against `live`.

The per-segment invariants are the single-DAG ones applied again: every input resolves inside its
segment or at a proven anchor (commitment-hash matched, so no value-swapping seam); one outpoint,
one producer across the whole lineage; no in-lineage double-spend; the burned note must be PRODUCED
by a segment (never merely anchored — the self-inflation shape keeps its test) and never consumed
inside one.

## Pool exits (opcode 0x6D)

A successor generation's reflection guest mirrors the shielded pool's own state (`btc_pool_root`,
`pool_spent_root` — both resumed + digest-pinned) and, for each confirmed carrier whose witness
holds a `T_BTC_SPEND` body with `has_exit = 1`:

1. verifies the spend relation natively (`btc_pool_core::verify_btc_pool_spend`, linked into the
   guest — its only dependencies are cxfer-core + k256): inputs are real tree members against
   `btc_pool_root`, nullifiers are fresh, conservation holds;
2. folds the nullifiers into `pool_spent_root` (a replay gate: the same pool note cannot exit
   twice);
3. onboards the exit note at `(carrier_txid, exit_vout)` — DESIGN-btc-shielded-pool.md §5's rule
   ("an output is a transparent note iff the pool recorded an accepted exit at it") — appending its
   transparent leaf, marking the outpoint live, and recording its deposit leaf.

From there the exit note is an ordinary reflected note: it can be spent, burned for the bridge, and
its holder's later provenance bottoms out at the exit's deposit leaf. `T_BTC_SHIELD` folds the same
way (a shield's output notes are pool leaves; a later spend's nullifier proves membership through
the spend relation — no separate provenance needed, since a pool spend IS the history).

## What is in this PR

- `cxfer-core/src/burn_deposit.rs` — `DepositLeafWitness` + `verify_deposit_leaf` (the anchor check,
  crypto-free, caller injects `imt_membership`), and `verify_provenance_segmented` (the multi-segment
  linkage check). Nine adversarial KATs mirror the single-DAG suite one-for-one (two-segment
  lineage, pool-exit anchor-only lineage, unproven anchor, anchor-without-producer self-inflation,
  cross-segment value seam, shared producer, cross-segment double-spend, consumed burned note,
  empty/wrong-commitment/island).
- `cxfer-core/src/lib.rs` — `ScanReflection.deposit_leaves_root` + `deposit_links` (the stateful
  indexer mirror), `fold_deposit_leaf_auto` / `fold_deposit_leaf` (stateful + witnessed forms), the
  hook in every onboarding path (`fold_output`, `fold_output_bound`, `onboard_btc_refund`,
  `onboard_lp_refund_pair`, `onboard_amm_refund_note`), the pool-side mirrors (`btc_pool_root`,
  `pool_spent_root` + links), and `fold_btc_pool_exit`. Everything rides `digest()`, so a resumed
  cycle can't roll back an anchor or replay a pool exit.
- `dapp/burn-deposit-provenance.js` + `tests/burn-deposit-provenance.mjs` — the JS mirror of
  `verifyProvenanceSegmented` with the same nine KATs (verdicts must match the Rust).
- `contracts/src/ConfidentialPool.sol` (+ test) — `REFLECTION_GENESIS_DIGEST` re-pinned: genesis now
  seeds the three new sentinel accumulators, so the digest changes (the first attestation continues
  the new genesis; a redeploy pins it, the live contract is untouched).
- This document.

## What a provider holds after N bridges (the numbers)

The count that matters is the share of a provider's taken TAC that can go home:

- Without the rule: every pool-exit note and every >255-transfer note a provider takes (5% of
  unspent notes were over the limit on 2026-11-22, pool exits uncounted) is stranded on Bitcoin —
  its Ethereum-side lending capacity shrinks by that amount, permanently.
- With the rule: 100% of taken TAC is bridgeable. A >256-hop note verifies as ceil(hops/256)
  segments — 2 blobs for a 500-hop note, plus one membership proof (a few hundred bytes) per
  anchor. A pool-exit note verifies as 1 segment + 1 anchor proof + the exit's own spend relation
  (already proven once when the reflection folded the exit).

Proving cost per burn stays O(segment) — the blob cap is unchanged per segment, so a hostile
prover's cost amplifier is bounded exactly as today (`ncx > 256` still rejects; a segmented blob
carries a segment count, each capped, and the caps multiply the bound linearly, not unboundedly).

## Compatibility

- The wire format gains an OPTIONAL trailing section (segment count + per-segment anchors), exactly
  like the existing `pool_memberships` extension: an older serializer produces bytes the new parser
  reads as zero segments; a new blob with zero segments is byte-identical to today's.
- Ads, quotes, requests and replies are untouched. Nothing deployed changes; pages and providers
  keep working unchanged.
- No new dependencies (`btc-pool-core` is already in-repo and depends only on cxfer-core + k256).

## Risks and what was NOT tested

- The guest wiring (reflect.rs stdin layout for the segmented blob + pool-exit witnesses, and the
  indexer's JS assembler for it) is specified here but NOT implemented — that is the successor
  deployment's work, with its own reproducible-build + vkey-pin ceremony. The verification core it
  will call is implemented and tested.
- The Halo2 shielded-pool spend proof is verified by `btc_pool_core` against a root the guest must
  mirror correctly; the mirror's resumption is digest-pinned in this PR's core but the end-to-end
  pool-exit fold has not been run against a real pool replay (no signet run in this entry).
- Genesis-digest re-pin: a successor deploy must re-pin `REFLECTION_GENESIS_DIGEST` (done here in
  source); the LIVE contract's genesis is immutable and unaffected — this rule activates only in a
  new pool generation, as the bounty's option D anticipates.
- Not tested: the JS assembler's segment emitter (the indexer side of building a segmented blob);
  multi-segment blobs beyond 2 segments (the check is segment-count-agnostic and tested at 1–2);
  behavior under a reorg that rewrites an anchored note's history (the anchor is a proven past
  fact — a deeper reorg halts reflection before it, as today).
