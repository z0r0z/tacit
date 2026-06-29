# DESIGN — OP_SWAP_BLIND (31 / 0x1F): prover-blind confidential AMM batch on the EVM settle lane

Status: **guest implemented + compiles, dormant**; arming ladder (JS mirror + parity + box) pending.

## BUILD STATUS (guest side landed)
- DONE: `verify_opening_pok_blind` (cxfer-core) — the value-hiding, context-bound opening PoK; Rust
  KAT `opening_pok_blind_roundtrip_and_tamper` passes (155/155 cxfer-core).
- DONE: `src/swap_blind.rs` — pure clearing validator (Groth16 + tip openings + aggregate identity +
  k-non-decrease + per-receipt xcurve), mirrors `swap_batch::fold_swap_batch` steps verbatim.
- DONE: `main.rs` — `mod babyjubjub/groth16/swap_batch/swap_blind`, `OP_SWAP_BLIND = 31`, dispatch
  arm with the EVM-specific input authorization (membership + nullifier + input xcurve + the blind
  PoK binding out_owner/min_out/direction). Circuit pool_id = `amm_derive_pool_id_v1`; EVM slot id =
  `pool_id_with_protocol_fee` (pf==0). v1 carries NO relay tip (tips==0).
- DONE: settle guest `cargo prove build` is clean; the op ships dormant (no dapp/worker emitter).
- REMAINING (arming gate — none on-chain, all off-chain): JS mirror of `openingPokBlind` + the op
  witness builder + worker decoder; a self-constructible 1-intent settle-exec accept/DIGEST fixture;
  the box ceremony-zkey Groth16 in-zkVM accept + forgery rejects; rotate PROGRAM_VKEY into the launch
  re-prove bundle. Until those pass, the op stays dormant — present in the vkey, not user-reachable.
- FOLLOW-UP: gasless-relay blind swap (non-zero tip → FeePayment); protocol-fee (skim) blind pools.

## 1. Why this exists, and why now

`OP_SWAP` (6) hides per-trade amounts from **chain observers** (only the net reserve move is
public) but the SP1 box/prover reads each amount in cleartext. The prover-blind variant — amounts
hidden from the prover/solver too — is the Bitcoin lane's `T_SWAP_BATCH` (0x2F, `swap_batch.rs`):
Groth16(BN254) over the uniform clearing + a per-asset aggregate Pedersen identity + a per-receipt
cross-curve sigma. `OP_SWAP_BLIND` is the EVM **settle** port of that scheme.

It is a **settle-guest** op ⇒ it rotates `PROGRAM_VKEY`, which is immutable in the deployed
`ConfidentialPool`. Adding it post-launch would force a pool redeploy + user migration. The launch
re-prove already rotates `PROGRAM_VKEY` and deploys a fresh pool, so this is the **one free window**
to bake it into the immutable genesis. Therefore: implement + validate it into the launch ELF, ship
it **dormant** (dapp/worker don't emit it), and arm it later as a pure off-chain flip — exactly the
`swap_batch` "arming post-v1 is a free off-chain flip" precedent. No future migration to enable it.

## 2. Threat model

Solver-blind. The prover/solver who assembles the SP1 stdin never learns any trader's amount; the
guest never reads a cleartext swap amount. Correctness rests on:
- the **Groth16 proof** (the amm_swap_batch circuit) — each receipt's split is the uniform clearing,
  and each output amount is in range (the circuit's range constraints replace a per-output BP+);
- the **aggregate Pedersen identity** — Σ inputs − Σ outputs − tip − Δ·H = R_net·G per asset, so
  total value conserves without revealing individual amounts;
- the **cross-curve sigma** — each secp note's hidden value == its Groth16-proven BJJ value.

Chain observers and the solver both see only: net reserve deltas, nullifiers, output leaves, tips.

## 3. THE EVM-specific security requirement (the swap_batch trap)

`swap_batch.rs` does NOT check input-side spend authority — it relies on the **Bitcoin tx signature**
authenticating the spent UTXOs, and on the worker's settler-side intent-sig for fairness. On the EVM
there is no tx signature, and `nullifier(cx,cy)` is publicly computable. So `OP_SWAP_BLIND` MUST,
per intent, prove **spend authority** (knowledge of the input note's blinding `r_in`) AND **bind the
intent** (out commitment, out_owner, min_out, direction, chain_binding) so the box cannot redirect or
relabel. Without this, blindly mirroring swap_batch = unauthorized-spend / output-redirect theft.

This is the ONLY genuinely new logic vs. swap_batch, and the ONLY new crypto primitive (§5.1).
Everything else is reused verbatim from the box-validated swap_batch path.

## 4. What is emitted — NO contract change

`OP_SWAP_BLIND` produces exactly the existing settle effects, so the launch `ConfidentialPool` is
already forward-compatible (it cannot tell a blind swap from a cleartext one):
- `nullifiers` ← each input note's ν (on-chain dedup gives distinctness + double-spend protection);
- `leaves` ← each receipt's `leaf(out_asset, C_out_secp, out_owner)`;
- `swaps` ← one `SwapSettlement{poolId, reserveAPre, reserveBPre, reserveAPost, reserveBPost}`
  (the contract gates pre == live reserves, re-checks k-non-decrease + u64 bounds, sets post);
- `fees` / tips ← the per-asset settler tip, handled like `OP_SWAP`'s protocol-fee skim
  (stealth-lock leaf) OR carried as a `FeePayment` — see §7 open question.

No new `PublicValues` field. The encoded-width test stays green.

## 5. Validation sequence (the guest op body — all-or-nothing, no mutation until every check passes)

Read order mirrors `OP_SWAP` for the per-intent membership/auth, and `swap_batch.rs:fold_swap_batch`
for the aggregate/Groth16/xcurve. Canonical orientation `asset_a < asset_b && asset_a != asset_b`
asserted first (as `OP_SWAP`), so `direction` maps to the right reserve side.

Header: `asset_a, asset_b, fee_bps(≤1000), protocol_fee config, reserve_a_pre, reserve_b_pre,
delta_a(sign,mag), delta_b(sign,mag), r_net_a, r_net_b, tip_a(amount, C_secp, r_tip), tip_b(...),
n_intents (1..=MAX_ITEMS_PER_OP)`.

Per intent `i`:
1. `direction ∈ {0,1}`; `in_asset = dir==0 ? asset_a : asset_b`.
2. Read input note `(C_in_secp=(cx,cy)), owner, leaf_index, path`. `leaf(in_asset,cx,cy,owner)`,
   `keccak_merkle_verify(.., spend_root)` (spend_root ≠ 0). `nu = nullifier(cx,cy)`;
   `check_btc_nonmembership(nu, bitcoin_spent_root)` if set. Push `nu`. — this gives the
   "distinct real note of the right asset" property that swap_batch's one-to-one matcher provides,
   for free, plus on-chain ν-dedup.
3. Read `C_in_bjj`, the **input** cross-curve sigma, and the **intent-authorization** (§5.1). Verify
   both. (Spend authority + value-cross-bind + owner/min_out binding.) ← the EVM-specific gate.
4. Read receipt `C_out_secp, C_out_bjj, out_owner, out_xcurve_sigma`; `out_asset = dir==0 ? b : a`.
   Verify `verify_xcurve(out_xcurve_sigma, C_out_secp, C_out_bjj)` (reused verbatim).
   Push `leaf(out_asset, C_out_secp, out_owner)`.

Batch-level (reused verbatim from `swap_batch.rs`, same call shapes):
5. Re-derive the 123 public signals (`swap_batch_public_signals(env, pool_id, reserve_a_pre,
   reserve_b_pre)`); `groth16_bn254_verify(batch_vk(), proof, pubs)`.
6. `verify_pedersen_opening` for `tip_a`/`tip_b` against their Groth16-public amounts before their
   blindings enter R_net.
7. `swap_batch_aggregate_identity(...)` for asset A and asset B.
8. Compute post-reserves via signed deltas; `new_* != 0`; `k_post ≥ k_pre`; `new_* ≤ u64::MAX`.
9. Emit the `SwapSettlement` + the tip effect (§7). Fold `min_deadline` from per-intent deadlines.

### 5.1 The one new primitive — context-bound, value-hiding opening PoK

`OP_SWAP` uses `verify_opening_sigma(C, amount, ...)` whose challenge binds `intent_context`
(out_owner, min_out, direction, fee, chain_binding) — but it takes a **public** amount, which the
blind model must not reveal. We need a Pedersen-opening PoK of `C_in = v·H + r·G` that proves
knowledge of `(v, r)` (⇒ spend authority via `r`) with the challenge bound to the intent context,
WITHOUT revealing `v`. This is a textbook two-base Schnorr (announce `A = s_v·H + s_r·G`; `e =
H(ctx ‖ C_in ‖ A)`; responses `z_v = s_v + e·v`, `z_r = s_r + e·r`; check `z_v·H + z_r·G == A +
e·C_in`). It is small and standard, but it IS new crypto on the fund-critical path, so it is the
single item that must get its own KAT (Rust) + JS mirror + tamper test before arming.

Open consideration: the input `verify_xcurve` already proves knowledge of `r_in_secp` and binds
`C_in_secp ↔ C_in_bjj`. If we extend `xcurve_challenge` to also hash the intent context, the new
primitive collapses into a bound-xcurve variant (one sigma instead of two). That is more efficient
but changes a validated primitive — decide in §8 before coding. Default to the SEPARATE PoK (leaves
`verify_xcurve` untouched = smaller blast radius), optimize to bound-xcurve only if KAT'd.

## 6. Isolation — zero regression risk to live ops

- New module `contracts/sp1/confidential/src/swap_blind.rs`, mirroring `swap_batch.rs`'s structure,
  exposing one `fn` the dispatcher calls. Reuses `groth16`, `babyjubjub`, `cxfer_core` exactly as
  `swap_batch` does (these modules already compile into the guest dir).
- One new `match OP_SWAP_BLIND` arm in `main.rs`. No existing arm is touched ⇒ a dormant op that is
  never placed in a batch cannot affect any existing path.
- `groth16`/`babyjubjub` are currently DCE'd from the **settle** ELF; this arm links them in, adding
  the ~5–9e9-cycle BN254 verify cost ONLY to a batch that actually contains a blind swap. Normal
  settles are unchanged. Blind-swap settles are box-class proofs (document the settler economics).

## 7. Open questions to resolve BEFORE writing code

1. **Tip handling.** swap_batch's tips are protocol-fee skims subtracted from reserves into stealth
   locks. EVM `OP_SWAP` carves protocol fee per-swap into a `stealth_lock_leaf`. Decide: route
   `OP_SWAP_BLIND` tips through the same `lock_leaves` stealth path (preferred — consistent with
   `OP_SWAP`), or as plain `FeePayment` to the settler. Must conserve against the aggregate identity
   either way (the identity already subtracts the tip).
2. **§5.1 primitive form** — separate value-hiding PoK (smaller blast radius) vs. context-bound
   xcurve (one sigma). Default separate.
3. **Circuit interface** — confirm the deployed `amm_swap_batch` circom's public/private signal
   semantics (the 123 signals, the 6 private arrays) match a SETTLE batch 1:1, and that its range
   constraints fully bound every output amount (so no separate BP+ is needed). The same finalized
   ceremony zkey / `batch_vk.bin` is reused — NO new trusted setup.
4. **MAX intents** — `MAX_ITEMS_PER_OP` vs the circuit's `N_MAX=16`. Pin to `min(.., 16)`.

## 8. Validation ladder (must pass before ARMING — not before committing the dormant op)

1. Rust KAT for the §5.1 primitive (prove/verify/tamper) + a JS mirror with a domain pin.
2. `swap_blind.rs` unit-shaped checks for the reused calls (as swap_batch's components are tested).
3. JS mirror of the op (witness builder) + a `settle-exec`/reflect-exec-style DIGEST/accept fixture
   with a self-constructible 1-intent batch (the swap_batch precedent: a 1-intent batch is
   self-consistent, no solver needed).
4. Box: a real ceremony-zkey Groth16 + the full op accepted in-zkVM (the 5–9e9-cycle run, box-only),
   plus forgery rejects (tampered public input, tampered proof, tampered out_owner, reused input ν,
   wrong-asset input, off-curve out_owner).
5. `readiness-gate.sh` → GOLD with the op present (dormant) in the launch bundle.

## 9. Bug-trap checklist (review gates — every one is a known way to get this wrong)

- [ ] Input spend authority verified per intent (§3) — NOT inherited from swap_batch.
- [ ] out_owner + min_out + direction + chain_binding bound in the per-intent auth (no box redirect).
- [ ] Canonical `asset_a < asset_b` asserted (direction→reserve mapping; else high/low leg swap).
- [ ] `fee_bps ≤ 1000` asserted BEFORE any `10000 - fee_bps` math.
- [ ] Every input ν pushed to `nullifiers` (on-chain dedup = distinctness + double-spend bar).
- [ ] `spend_root != 0` and `bitcoin_spent_root` non-membership for btc-homed inputs.
- [ ] Groth16 over RE-DERIVED public signals (reserves from the op's pre, not prover-supplied raw).
- [ ] Tip commitments opened to their Groth16-public amounts BEFORE entering R_net.
- [ ] Post-reserves: `!=0`, `k_post ≥ k_pre`, `≤ u64::MAX` (mirrors contract-side floors).
- [ ] All-or-nothing: no `nullifiers`/`leaves`/`swaps` push survives a later failed check (build into
      locals, commit only after every assert — or rely on the whole-proof abort semantics, but keep
      the witness reads complete so a bad op can't desync the stream).
- [ ] Dormant: no dapp/worker emitter; arming is a separate, post-launch, off-chain change.
