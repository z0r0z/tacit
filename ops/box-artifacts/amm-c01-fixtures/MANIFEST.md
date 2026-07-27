# C-01 Bitcoin-AMM current-price + refund — box execute-mode fixtures

Each fixture is an `assembleReflectionScanInput`-shaped reflection input (prior + block + witnesses) whose
`newDigest` the JS assembler (dapp) produced by folding the C-01 redesign. `reflect-exec` on the box builds the
ELF, re-folds the same block in-guest, and MUST land on the listed `newDigest` (DIGEST_MATCH). Every fixture is
self-checked at the JS level by its generator (the onboarded leaf + the reserve outcome are asserted before the
input is emitted). Assembler port + guest reference: `contracts/sp1/.../cxfer-core/src/lib.rs` (fold_swap_var /
fold_swap_route / fold_lp_add / fold_lp_remove), `.../src/swap_batch.rs` (fold_swap_batch); JS mirror:
`dapp/confidential-pool.js` + `dapp/confidential-swapbatch.js`.

The C-01 property under test: a swap/route/LP op that spends a note UTXO but prices against VIRTUAL registry
state no longer SKIPS (and destroys the nullified input) when the pool moved between signing and reflection.
Instead it clears at the CURRENT price bounded by `min_out`, and on a stale/over-slipped/expired op it onboards a
REFUND note of the exact input. Run each against the OLD (pre-C-01) ELF once to confirm it reproduces the
principal loss (the negative-control the vector exists to catch).

## Expected-outcome legend
- **DIGEST_MATCH-with-receipt** — the op cleared; a receipt/shares note onboarded; reserves advanced. OLD ELF:
  matches only for `fresh` (where declared == current); for `stale` the OLD ELF SKIPS (loses the input).
- **DIGEST_MATCH-with-refund** — the op did not execute; a refund note of the exact input onboarded at the
  signed refund vout; reserves untouched. OLD ELF: SKIPS (principal destroyed) — must-FAIL-on-old-ELF.

| Fixture | Op | Scenario | Generator (env) | Expected execute outcome | newDigest |
|---|---|---|---|---|---|
| swapvar-fresh.json | T_SWAP_VAR 0x32 | fresh (reserves == snapshot) | `SWAPVAR_SCENARIO=fresh` | DIGEST_MATCH-with-receipt | 0x6aa13e6b… |
| swapvar-fresh-change.json | T_SWAP_VAR 0x32 | fresh + non-sentinel change (vout 2) | `SWAPVAR_SCENARIO=fresh SWAPVAR_CHANGE=500` | DIGEST_MATCH-with-receipt (+change) | 0x49f21b73… |
| swapvar-stale.json | T_SWAP_VAR 0x32 | stale (pool advanced, min_out met) | `SWAPVAR_SCENARIO=stale` | DIGEST_MATCH-with-receipt (moved price) — **must-FAIL-on-old-ELF (skips+loses)** | 0x87907309… |
| swapvar-overslip.json | T_SWAP_VAR 0x32 | over-slippage (min_out > cleared) | `SWAPVAR_SCENARIO=overslip` | DIGEST_MATCH-with-refund (vout 3) — **must-FAIL-on-old-ELF** | 0x8391fd93… |
| swapvar-expired.json | T_SWAP_VAR 0x32 | expired (expiry < height) | `SWAPVAR_SCENARIO=expired` | DIGEST_MATCH-with-refund (vout 3) — **must-FAIL-on-old-ELF** | 0x8391fd93… |
| swaproute-fresh.json | T_SWAP_ROUTE 0x33 | fresh 2-hop A→B→C | `SWAPROUTE_SCENARIO=fresh` | DIGEST_MATCH-with-receipt | 0xfd649ca9… |
| swaproute-stale.json | T_SWAP_ROUTE 0x33 | stale (spanned pool1 moved) | `SWAPROUTE_SCENARIO=stale` | DIGEST_MATCH-with-receipt (re-cleared) — **must-FAIL-on-old-ELF (strands route)** | 0xadb6ba52… |
| swaproute-overslip.json | T_SWAP_ROUTE 0x33 | over-slippage | `SWAPROUTE_SCENARIO=overslip` | DIGEST_MATCH-with-refund (vout 2, no pool moves) — **must-FAIL-on-old-ELF** | 0x0cc4edc8… |
| swaproute-expired.json | T_SWAP_ROUTE 0x33 | expired | `SWAPROUTE_SCENARIO=expired` | DIGEST_MATCH-with-refund (vout 2) — **must-FAIL-on-old-ELF** | 0x0cc4edc8… |
| lp-poolinit.json | T_LP_ADD 0x2D variant 1 | POOL_INIT (fee_bps as registry state) | `gen-reflection-lp-poolinit-synth` | DIGEST_MATCH-with-receipt (share note FORMED, vout 0) | 0x23d6d081… |
| lp-add.json | T_LP_ADD 0x2D variant 0 | grow existing pool | `gen-reflection-lp-add-synth` | DIGEST_MATCH-with-receipt (share FORMED from minted) | 0x45a184bc… |
| lpremove.json | T_LP_REMOVE 0x2E | proportional withdraw | `gen-reflection-lpremove-synth` | DIGEST_MATCH-with-receipt (recvA/recvB FORMED from current-state payout) | 0x3d0ce650… |

All fixtures carry the `fee_bps`-in-registry consensus change (the pool leaf order `.. c0_backed ‖ fee_bps ‖
protocol_fee_bps ‖ k_last ‖ accrued`), so a pre-C-01 handoff fails the priorDigest chain rather than being
silently accepted — this is the resume/registry vector (REPROVE box vector 20) exercised implicitly by every
fixture above.

## Intent authorization (swap-var / route)
The guest `fold_swap_var` / `fold_swap_route` reconstruct the trader's `intent_msg` from the confirmed tx (input
outpoint + the receipt/change/refund output scripts) and BIP-340-verify it against the envelope's `trader_pubkey`,
SKIPPING the whole fold on a bad signature. The JS assembler now mirrors this (`swapVarIntentMsg` /
`swapRouteIntentMsg` in `dapp/confidential-pool.js`, byte-checked against the guest KATs), and every swap fixture
carries a REAL BIP-340 `intent_sig` over the exact message the guest rebuilds — a dummy sig would make the guest
skip and the digests would diverge. (The `intent_sig` and `trader_pubkey` ride the taproot witness, which is
excluded from the txid, so the fixture `newDigest`s above are unaffected by adding them.)

## H-01 note-spend witness
The LP fixtures (0x2D / 0x2E) build each note-spend input with a conforming SIGHASH_ALL witness (a 64-byte
key-path signature = SIGHASH_DEFAULT), as commit 23fbc012 requires; without it the fold skips
(`note_spends_bind_outputs`). Swap-var/route are not in the 0x22/0x23/LP gate set, so they carry no such witness
requirement.

## Batch intent authorization
`fold_swap_batch` verifies a per-intent BIP-340 `intent_sig` (domain `tacit-amm-intent-v1`, binding the matched
spend outpoint, `c_in` secp+bjj + its cross-curve, the receipt destination at vout i+1, min_out, tip, expiry, and
the refund destination at vout n+1+i) and SKIPS the whole batch on any bad sig. The JS assembler now mirrors this
(`swapBatchIntentMsg` in `dapp/confidential-swapbatch.js`, byte-checked against the guest KAT); the dispatcher
passes the receipt/refund output scripts and the fold derives each note's authority. The batch generator
(`gen-reflection-swapbatch-synth.mjs`) signs a real per-intent `intent_sig` and emits P2TR receipt (vout 1) /
refund (vout 2) outputs — verified structurally here, but it needs the ceremony zkey to run fullProve end-to-end.

## Owed — needs the ceremony zkey / box run (NOT generated here)
- **swapbatch positive (n=1 / n=2 / n=16)** — REPROVE vectors 10, and the box positives at
  `ops/box-artifacts/swapbatch-positive/`. These need a real Groth16 proof from the ceremony HEAD zkey
  (`REFLECT_SWAPBATCH_ZKEY=… node tests/gen-reflection-swapbatch-synth.mjs`), which the E workstream owns; the
  generator's tx must additionally place receipts at vouts 1..n and (unused) refund P2TR outputs at vouts
  n+1..2n. Not runnable in this workspace (no zkey), so not emitted.
- **swapbatch stale-refund (vectors 16 / 30)** — the batch's proof is pinned to the reserves it was generated
  against; a concurrent op moves them, the Groth16 fails against current reserves, and ALL intents refund to
  their own vout n+1+i. The batch fold's refund path IS ported and unit-verified (`tests/confidential-swapbatch-fold.mjs`:
  stale-Groth16 / stale-aggregate / expired all onboard one refund per intent at vout n+1+i, reserves untouched).
  An end-to-end assembled fixture is owed: it needs the tx built with n receipt + n refund P2TR outputs and the
  batch_vk wired so the assembler's swapBatchFold hook runs (a garbage proof then fails → refund). The refund
  vout-index off-by-one (n+1+i) is the case to verify with n=2 and n=16.
