# Greenlight response 24 — legacy classic-Bulletproofs verifier

**Reviewed commit:** `4b3247c` · **Model:** GPT-5.5 Pro · **Verdict: GREENLIGHT — 0 fund-impacting findings.**
Transcript: https://chatgpt.com/share/6a4774a7-aa6c-83ec-b583-ece3ce6cfd78

## The change
`verify_range` in the confidential guest (`cxfer-core/src/lib.rs`) became a length-dispatching wrapper that
accepts BOTH Bulletproofs+ (`verify_range_bpp`, the prior verifier, renamed) and classic Bulletproofs
(`verify_range_classic`, new). This lets legacy classic-BP-originated assets — native mainnet TAC — be
range-verified and bridged; the prior guest accepted BP+ only and would have stranded a classic-BP note on
burn. Every value-bearing caller (cxfer, the AXFER family, preauth bids, cmint, burn-deposit provenance)
routes through `verify_range`, so all accept both schemes with no per-opcode branching. No other guest or
contract logic changed.

## Independent verdict
No exploitable gap in `verify_range_classic`: parse is length-exact (`off == proof.len()`), all points are
SEC1-decompressed (malformed points fail closed), and both verification relations bind every field — the
t-polynomial identity and the collapsed inner-product identity (A, S, μ, t̂, a, b, every L/R, Q, all G/H
coefficients, the s-vector and inverse folding). Checking the two relations separately is stronger than the
JS random linear combination for a single proof. Length dispatch is non-colliding and transcript-bound across
`m ∈ {1,2,4,8}` (BP+ 591/657/723/789 vs classic 688/754/820/886). All value-bearing callers still gate on
range **and** conservation. The Pedersen base convention (`V = v·H + r·G`) is consistent JS↔guest. The
contracts still pin SP1 proofs to the immutable `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY`, and the BP+ path is
preserved and selected only by BP+ lengths. The reviewer replayed the bundled fixtures with a separate
secp256k1 verifier — the real mainnet TAC proof and all valid vectors accept; every adversarial vector rejects.

## Disposition of the three non-blocking coverage suggestions
1. **Cross-width length-alias negative — ADDED** (`length_alias_m2.json`): the honest 128-bit/`m=1` proof
   (754 bytes, which aliases the 64-bit classic `m=2` length) handed to the 64-bit verifier rejects on the
   transcript `n`/`m` binding, not merely the length gate. Locked in JS (reference + mirror) and a guest KAT.
2. **Malformed compressed-point per field — ADDED** (`badpoint_{A,S,T1,T2,L0,R0}.json`): each field replaced
   by an invalid compressed point (field-modulus `x` / bad prefix) rejects at SEC1 decompression. Locked in
   JS + guest KAT.
3. **Byte-canonical scalars — OPTIONAL FOLLOW-UP, not applied.** The classic parser reduces scalars mod n
   (matching the JS mirror). This is not a fund-soundness issue — replay protection keys on **nullifiers, not
   proof bytes**, so a re-encoded (`s+n`) proof cannot bypass anything, and the real TAC scalars are canonical.
   Tightening to reject non-canonical encodings is a guest logic change (→ a reprove), so it is deferred to be
   folded in only when a reprove is already scheduled.

## Coverage now locked in the suite
- **JS** `tests/bulletproofs-classic-adversarial.test.mjs`: 9/9 — valid `m=1/2/4/8` accept via reference +
  mirror (agreeing); tamper-per-field, wrong-commitment, padded/truncated, out-of-range, length-alias, and
  malformed-point all reject.
- **JS** `tests/bulletproofs-classic-dapp.test.mjs`: real mainnet TAC parity (accept + tamper reject).
- **Guest** `cxfer-core` KATs: 4/4 — real TAC accept; boundaries `m=1/4/8` accept; tampered/out-of-range
  reject; length-alias/malformed-point reject.
- **Generator** `tests/gen-classic-bp-vectors.mjs`: 34 deterministic fixtures with a self-check that hard-fails
  if any adversarial vector is ever accepted by the reference verifier.

## Reprove note
The verifier itself (`verify_range` dispatch + `verify_range_classic`) is guest logic and rides the reprove
already in flight for this cut. Every test/fixture addition above is `#[cfg(test)]` / host JS and does not
enter the proven ELF — no additional reprove.
