# STATUS — prover-blind ops (the cheap-class sweep + swap)

Master reference for the prover-privacy work folded toward this reprove. "Prover-blind" = the box that
assembles the SP1 witness never learns the amount (vs. chain-blind, which the protocol already had).

## Design principle (why each op is shaped the way it is)

- **Cost decides tweak-vs-new-op.** Cheap to blind (≈ cleartext cost: kernel + BP+ + value-hiding PoK) ⇒
  bake into the existing op, blind by default. Expensive (BN254 Groth16, ~5–9e9 cycles) ⇒ new opt-in op,
  keep cleartext default.
- **Conservation structure decides feasibility.** Single-party (one signer knows all blindings) ⇒ cheap.
  Two-party (kernel spans both parties' secrets — OTC, adaptor) ⇒ needs MuSig-style 2-party co-signing =
  the MPC track, deferred. Amount-public-by-mechanics (LP/CDP/farm/reserves) ⇒ nothing to blind.
- **MPC + self-prove are the universal backstop** — both off-chain, vkey-agnostic, **no pool redeploy** —
  so anything not baked in here is still prover-private via self-prove today / MPC later.

## Op-by-op

| Op | Tag | Class | Shape | Guest | JS prim | Builder/fixtures | Box |
|---|---|---|---|---|---|---|---|
| SWAP_BLIND | 31 | Groth16 (opt-in) | new op, dormant | ✅ compiles | ✅ pok | ⬜ swap witness + fixture | ⬜ zkVM Groth16 accept |
| STEALTH_LOCK | 23 | cheap single-party | bake-in | ✅ | ✅ leaf | ✅ builder (consistency-tested) | n/a |
| STEALTH_CLAIM | 24 | cheap single-party | bake-in (+skim flag) | ✅ | ✅ msg | ✅ builder (consistency-tested) | n/a |
| STEALTH_REFUND | 25 | cheap single-party | bake-in | ✅ | ✅ | ✅ builder (consistency-tested) | n/a |
| SEND_AND_UNWRAP | 28 | cheap single-party | bake-in | ✅ | ✅ pok | ⬜ send-unwrap blind builder | n/a |
| BRIDGE_STEALTH_MINT | 26 | cheap single-party (x-chain) | bake-in | ✅ | ✅ leaf | ✅ builder + ⬜ BTC declares blind leaf | n/a |

**Builders validated:** `tests/blind-stealth-builders.test.mjs` (4/4) — each blind stealth builder produces a
witness the guest re-accepts (kernel conserves + binds the correct leaf, claim/refund BP+ range verifies, the
one-time claim sig verifies). New JS helpers: `transfer.kernelSign` / `transfer.verifyKernel` (custom-leaf /
range-less kernels). Still ⬜: harness witness-writers (io field order) + `gen-*-fixture.mjs` → settle-exec
DIGEST; the send-unwrap + swap-blind JS builders.
| TRANSFER / BRIDGE_BURN / BRIDGE_MINT | 1/3/4 | already kernel-blind | — | ✅ pre-existing | — | — | — |
| OTC / BID / ADAPTOR | 9/10/12-14 | **2-party → MPC track** | deferred | — | — | — | — |
| WRAP/UNWRAP/LP/CDP/FARM/CBTC/… | — | public-by-design | not applicable | — | — | — | — |

## Landed + validated this pass

- **cxfer-core primitives** (KAT'd, 156/156): `verify_opening_pok_blind` (value-hiding opening PoK),
  `stealth_lock_leaf_blind`, `stealth_claim_msg_blind`.
- **Guest** (all `cargo prove build` clean): the six ops above. Stealth lock=N→L kernel (value-equal),
  claim=L→M+fee kernel + BP+ range on M (fee bound w/o cleartext amount) + owner sig, refund=L→O+fee
  kernel + BP+ range on O. Claim keeps a `blind` flag: 1 = blind user send, 0 = AMM protocol-fee skim
  (amount public, unchanged). Send-unwrap swaps the cleartext-value opening sigma for the value-hiding PoK
  (kernel + change range were already there). Bridge-stealth drops the L opening sigma (burn-set membership
  pins the blind leaf; kernel carries conservation) — reflection unchanged (`fold_burn` treats
  destCommitment opaque).
- **JS mirrors** (node `tests/blind-primitives.test.mjs` 2/2): `openingPokBlind`/`verifyOpeningPokBlind`
  (confidential-pool.js), `stealthLockLeafBlind`/`stealthClaimMsgBlind` (confidential-stealth.js).
- `src/swap_blind.rs`, `ops/DESIGN-op-swap-blind.md`.

## Remaining ladder to reprove-ready (NOT done)

1. **JS witness builders** — rewrite `buildStealthLock/Claim/Refund/buildBridgeStealthMint` to the blind
   shapes (kernel via `transfer.buildTransfer` for claim/refund — its outLeaves+rangeProof match; lock binds
   the blind LOCK leaf so its kernel needs a custom transcript); add a blind send-unwrap builder; add the
   swap-blind witness builder (Groth16 path). Claim now needs `r_L` (memo) to build the L→M kernel.
2. **Fixtures + parity** — regenerate `tests/gen-confidential-stealth{lock,claim,refund}-fixture.mjs`,
   `gen-bridgestealthmint-fixture.mjs`, a send-unwrap fixture, a swap-blind fixture → settle-exec
   DIGEST/accept; update `tests/dapp-stealth-parity.test.mjs`.
3. **Box** — swap-blind: real ceremony-zkey Groth16 in-zkVM accept + forgery rejects (5–9e9 cycles, vast
   box). The cheap ops have no box step.
4. **Memo/UX/worker** — stealth memo carries `r_L`; claim `blind` flag; bridge burner declares the blind
   destCommitment; worker decoders.
5. **Reprove integration** — the new `PROGRAM_VKEY` (these rotate it) + `DeployConfidentialPool`
   `DEFAULT_VKEY`; fold into the launch bundle; `readiness-gate.sh` → GOLD.

## Audit findings fixed (external review of the frozen-bundle delta)

- **F-01 (Critical) — `BRIDGE_STEALTH_MINT` un-ranged `L` + public fee → cross-chain inflation.** Dropping
  the L opening sigma removed the implicit `v_L < 2^64` bound, so a burner could commit a wrapped
  `v_L = v_in − fee (mod n)` with `fee > v_in` (u64) and the kernel still verified — paying out a fee larger
  than the burned value. FIX: `verify_range(&[l_pt], &l_bp)` at mint (main.rs); with `v_L,v_in < 2^64` the
  kernel forces `fee = v_in − v_L ≤ v_in`. JS builder emits the L range proof. (Independently found + fixed.)
- **F-02 (High) — blind `STEALTH_REFUND` not locker-authorized once `r_L` is shared.** The prover-blind CLAIM
  conveys `r_L` to the claimant, so "knows `r_L`" no longer identifies the locker — a memo-holder could build
  the refund kernel after the deadline and steal the value via the fee leg or grief an unspendable output.
  FIX: blind refund now requires a **BIP-340 signature under `locker`** (an x-only refund pubkey) over the
  exact output + fee (`stealth_refund_msg`); `STEALTH_LOCK`/`BRIDGE_STEALTH_MINT` validate `locker` on-curve so
  a refund is always possible. CLAIM stays `owner_pub`-gated; only refund needed the change. Tested in
  `tests/blind-stealth-builders.test.mjs` (the locker sig verifies; a claimant without the locker key can't
  forge it). **Design note:** `locker` is now a refund pubkey, and the memo conveys `r_L` for the claim only.

## Notes for the audit

- The cheap-class blind paths are the OP_TRANSFER pattern (kernel + BP+) — the most-validated primitive in
  the guest — applied to the lock-set / exit. The only *new* crypto is the value-hiding PoK (one two-base
  Schnorr, KAT'd) used by swap-blind input authz + send-unwrap.
- Bake-in = the live path, so the cheap ops MUST clear the JS-builder + fixture ladder before the reprove
  (no dormant fallback). Swap-blind is dormant ⇒ its box step can land post-launch.
