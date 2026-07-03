# Greenlight request — classic-Bulletproofs range verifier added to the immutable guest

You are performing a **fund-safety greenlight** of a single, targeted change to the Tacit
confidential-pool + BTC↔ETH bridge. The immutable surface (SP1 zkVM guests in Rust + the Solidity
contracts) has already passed 20+ prior greenlight rounds and was clean-locked. This is a **new cut**
that adds exactly one capability, and I need you to greenlight (or block) *this delta* re: re-prove +
mainnet, and confirm it introduces no fund-impacting regression.

Attached bundle `tacit-final-audit-bundle.zip`:
- `guest/` — the full SP1 guest source (settle guest `settle-guest-main.rs`, reflection guest
  `reflection-guest-reflect.rs`, eth-reflection guest, and the shared `cxfer-core-*.rs` crate). The
  change lives in `guest/cxfer-core-lib.rs`.
- `contracts/` — the full immutable Solidity surface (ConfidentialPool + bridge/relay/canonical
  asset contracts).
- `tests/` — the JS mirror (`dapp-bulletproofs.js`), the reference prover/verifier
  (`reference-bulletproofs.mjs`), the parity + adversarial tests, the vector generator, and the
  fixtures (real mainnet TAC vector + generated boundary/tamper/out-of-range vectors).

## The change under review (the only functional delta)

**Problem it fixes (fund-critical):** native mainnet TAC (asset `f0bbe868…`, 1500+ wallets) is a
**classic Bulletproofs** asset (transfer opcode `0x23`, `T_CXFER`). The deployed guest's
`verify_range` accepted **Bulletproofs+ only**. So a burn-deposit / bridge of a legacy classic-BP TAC
note would have failed range verification and **stranded the asset** — value in, nothing out.

**The fix:** `verify_range` is now a **length-dispatching wrapper** that accepts BOTH schemes:
- `verify_range_bpp` — the prior BP+ verifier (unchanged, just renamed from `verify_range`).
- `verify_range_classic` — new: an aggregated classic-Bulletproofs range verifier, a deterministic
  port of the JS `dapp/bulletproofs.js::bpRangeVerify` / `reference-bulletproofs.mjs`
  `bpRangeAggProve`/`bpRangeAggVerify`.

Because every caller routes through `verify_range` (plain cxfer, the AXFER atomic family, preauth
bids, cmint, **and burn-deposit provenance**), all of them now accept a classic-BP proof with no
per-opcode branching. No other guest or contract logic changed in this cut.

### Facts to check against
- `N_BITS = 64` for BOTH schemes ⇒ both prove each committed value ∈ **[0, 2⁶⁴)**. Confirm the
  classic path enforces the SAME range (via its δ and the `2ᵏ` terms), not a wider one.
- Supported aggregation `m ∈ {1,2,4,8}`. Proof lengths:
  `bpp = 99 + 96 + log₂(64m)·66`; `classic = 132 + 96 + log₂(64m)·66 + 64`. They differ by 97 for
  every m, and the 8 values are pairwise distinct (bpp: 591/657/723/789; classic: 688/754/820/886).
  `verify_range` computes `m` from `commitments.len()`, then matches the proof length to that m's bpp
  or classic length. **Scrutinize the dispatch for scheme-confusion / length-collision / m-mismatch
  abuse.**
- The JS batches the two verification relations with random weights `α,β`; the zkVM has no RNG, so
  `verify_range_classic` checks each relation as its own `Σ = 𝟘` group identity (t-polynomial check,
  then the collapsed inner-product check). **Confirm this is equivalent-or-stronger** for a single
  proof (i.e., checking both identities exactly, not a random linear combination, cannot admit a
  proof the batched form would reject).
- Generators: the classic path reuses the validated `bpp_gens` (G/H vectors) and `gen_h`; only `Q`
  (`hash_to_curve("tacit-bp-Q-v1")`) is new. Transcript domain is `"tacit-bp-v1"`. **Confirm
  transcript byte-layout + generator derivation match the JS prover exactly** (a mismatch that still
  self-verifies could hide a forgery surface).

## What I need you to focus on (ranked by what would be fund-fatal)

1. **Soundness of `verify_range_classic`.** Does it accept *only* valid aggregated range proofs for
   values in [0, 2⁶⁴)? Look for any missing check that admits a forgery or an out-of-range value:
   point-on-curve / non-identity validation on parsed points, canonical scalar reduction, `off ==
   proof.len()` exactness, that *every* parsed field (A,S,T1,T2, t̂,τx,μ, each L/R, a,b) is actually
   *bound* by one of the two identities (an ignored field = malleability), and that the s-vector /
   inverse construction matches the IPA challenge folding. A false-accept here = **forged-value
   bridge mint / inflation.**
2. **Scheme-dispatch abuse.** Any way a proof of one scheme (or a truncated/padded blob) is routed to
   the wrong verifier and spuriously accepted; any m for which the two scheme lengths collide; any
   cross-`m` confusion.
3. **Blast radius of making every caller accept classic.** Is accepting a classic-BP proof safe for
   *every* opcode that calls `verify_range` — especially burn-deposit provenance and cmint, where
   value conservation / supply descent is what stops inflation? Does the scheme choice interact with
   any value-binding elsewhere (the kernel/opening-sigma, the Pedersen base convention V = v·H + r·G)?
4. **JS ↔ guest divergence.** Any input on which the JS prover and the guest verifier disagree, or a
   malicious proof the guest accepts that the reference rejects.
5. **Regression check.** Confirm the rename + dispatch didn't weaken `verify_range_bpp` or any other
   part of the immutable surface (full cut is in the bundle).

## Test evidence already in the bundle (verify it's sufficient, extend if not)
- Guest KAT: `verify_range` accepts the **real 754-byte mainnet TAC** classic proof (m=2) and rejects
  a tampered copy; plus new guest KATs accepting boundary proofs at **m=1,4,8** (values 0 and 2⁶⁴−1)
  and rejecting tampered-field / wrong-commitment / out-of-range fixtures.
- JS parity + adversarial: reference and dapp verifiers agree on all valid vectors; every single-field
  mutation, wrong-commitment, truncation/padding, and out-of-range attempt **rejects**; out-of-range
  is refused by the prover guard and rejected by the 64-bit verifier.

## Deliverable
Return fund-impacting findings **ranked most-severe first** (severity, `file:line`, concrete exploit
path, minimal fix). If you believe the coverage is insufficient to be confident of soundness, say so
and specify the exact additional test/vector you'd want. Finish with an explicit **GREENLIGHT** or
**NO-GO** verdict for this cut proceeding to re-prove + mainnet, and — separately — whether the
change is safe to fold into the immutable guest (i.e., does it belong behind the vkey pin as-is).
