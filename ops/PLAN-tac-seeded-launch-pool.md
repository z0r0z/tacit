# PLAN — TAC seeded-genesis launch pool (cheap native-TAC bridging, no guest change)

## Problem
Native `f0bbe868` (OG TAC) has an etch at block **948242**, ~8,000 blocks before the current
reflection genesis (956223). Onboarding a native TAC note via burn-deposit requires a contiguous
header chain etch→anchor in the burn tx witness (~680KB) — non-standard-size, and it *grows* as the
anchor advances (a fixed checkpoint just defers the growth). So per-note burn-deposit is unsustainable
for the flagship coin.

## Solution — seed the TAC supply into a new pool's reflection genesis; bridge via near-tip
A new immutable `ConfidentialPool` generation whose reflection **resume digest is pre-seeded with the
live TAC supply**. Once seeded, every post-genesis TAC transfer folds normally (its inputs trace to
seeded supply → conservation passes → the note becomes a live reflected pool note). A live note bridges
out via the **near-tip path** — zero provenance, zero headers, standard-size cheap tx, and it **never
grows** (reflection is always near-tip). One-time seed cost; cheap forever after.

**No guest change, no re-prove.** `read_scan_prior_state` (reflect.rs:129) reads the full handed
resume state — including an arbitrary `live` UTXO set — and derives the digest the contract chains
against `priorDigest`. There is no empty-genesis assumption; a seeded state is just a non-empty handed
set. The settle + reflection ELFs are byte-identical → vkeys unchanged → the launch pool **reuses the
current audited artifacts**. This is the generational-resume mechanism of PLAN-pool-generations.md.

## Steps

### 1. Build the seed state (one-time, offline)
Construct the reflection resume state at anchor **956223** with TAC supply folded in:
- Walk `f0bbe868` from the etch (948242) forward to 956223 using the JS reflection state machine
  (confidential-pool.js), **injecting C₀** via `foldOutput` (the normal fold skips the etch — anti-inflation
  conservation-closure — so C₀ is injected explicitly here as the one authorized supply entry), then
  folding every CXFER hop (now each has a reflected input) and removing spent notes.
- Output: the live TAC supply set at 956223 + the full `ScanReflection` resume state (roots, counts,
  sorted `live_triples`) + its `digest()` → **SEED_DIGEST**.
- **Trustless:** the walk is SP1-proven (binds etch→956223 history to the output), and it is independently
  re-runnable — anyone recomputes SEED_DIGEST from public Bitcoin, exactly like the current genesis is
  explorer-verifiable.
- Scope note: for the pilot, the seed need only be COMPLETE for TAC (`f0bbe868`); other pre-genesis assets
  onboard as before. A full launch seed folds all pre-genesis confidential supply.

### 2. Dry-run the first attest against the seed (de-risk, before any on-chain action)
- Feed the constructed seed as `priorState`, run the deployed reflection guest (EXECUTE) over 956224→tip.
- Confirm: digest(seed) == SEED_DIGEST; the first batch attests; **my note (6bb5c8cd:0) folds to live**
  as the guest processes 956710. If it reverts, fix the seed — nothing on-chain touched.

### 3. Deploy the launch-candidate pool
- Remine 5-byte vanity salts for the new suite (CreateX; new addresses since genesis-digest changes initcode).
- Deploy via DeployV1SuiteCreateX with `GENESIS_REFLECTION_ANCHOR` = 956223 block hash (LE internal),
  `REFLECTION_RESUME_DIGEST` = **SEED_DIGEST**, reusing the **current** PROGRAM_VKEY + BITCOIN_RELAY_VKEY
  (no re-prove). Etherscan-verify + pin-coherence check.
- The live cUSD-CDP pool (0x49Cc3f) is untouched and stays live.

### 4. Run reflection from the seed + confirm TAC live
- Box loads the seed state, runs relayer.sh forward. Confirm `noteLeaves`/`live` now include TAC and that
  `6bb5c8cd:0` is a live reflected note in the new pool.

### 5. Bridge TAC (near-tip) + exercise the surface
- Broadcast a standard-size `0x2b` burn spending `6bb5c8cd:0` (129-byte envelope, `env_nu` = ν(note),
  `dest_leaf` = leaf(f0bbe868, out_cx, out_cy, my_xonly) — no provenance blob). Reflection folds it near-tip.
- `OP_BRIDGE_MINT` → 100 tacTAC into a pool note. Then: unwrap 10 to z0r0z.eth via the relayer (gasless),
  keep 90, a confidential transfer, and a crossOut back to Bitcoin.
- If this works, the seeded pool becomes the **launch pool**.

## What this is NOT
- Not a guest change, not a re-prove, not a vkey rotation. Reuses current audited ELFs.
- Not a fixed burn-deposit checkpoint (that regrows). Near-tip carries zero headers → no growth, ever.
- Does not touch/degrade the live cUSD-CDP pool or any other op (proving artifacts identical).

See [[project_native_tac_bridge_limitation]], PLAN-pool-generations.md.
