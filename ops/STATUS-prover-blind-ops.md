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
| STEALTH_LOCK | 23 | cheap single-party | bake-in | ✅ | ✅ leaf | ⬜ buildStealthLock blind | n/a |
| STEALTH_CLAIM | 24 | cheap single-party | bake-in (+skim flag) | ✅ | ✅ msg | ⬜ buildStealthClaim blind | n/a |
| STEALTH_REFUND | 25 | cheap single-party | bake-in | ✅ | ✅ | ⬜ buildStealthRefund blind | n/a |
| SEND_AND_UNWRAP | 28 | cheap single-party | bake-in | ✅ | ✅ pok | ⬜ send-unwrap blind builder | n/a |
| BRIDGE_STEALTH_MINT | 26 | cheap single-party (x-chain) | bake-in | ✅ | ✅ leaf | ⬜ builder + BTC declares blind leaf | n/a |
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

## Notes for the audit

- The cheap-class blind paths are the OP_TRANSFER pattern (kernel + BP+) — the most-validated primitive in
  the guest — applied to the lock-set / exit. The only *new* crypto is the value-hiding PoK (one two-base
  Schnorr, KAT'd) used by swap-blind input authz + send-unwrap.
- Bake-in = the live path, so the cheap ops MUST clear the JS-builder + fixture ladder before the reprove
  (no dormant fallback). Swap-blind is dormant ⇒ its box step can land post-launch.
