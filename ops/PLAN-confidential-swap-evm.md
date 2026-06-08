# C — Confidential swaps on Ethereum (`OP_SWAP`)

Settle the AMM's batched, uniform-price, hidden-amount swap (`T_SWAP_BATCH`) on Ethereum's
fast lane, the same model as Bitcoin. The last contract piece of the confidential system.

## Architecture decision: an SP1 guest op, not a separate AMM verifier

The Bitcoin AMM proves a swap with a BabyJubJub Groth16 (ceremony-gated). On Ethereum we
do **not** deploy that circuit's verifier + run a dual proof. Instead the swap is a new op
in the existing confidential SP1 guest. Why:

- **One proof, one verifier.** A confidential swap needs both the **secp note** side
  (membership in the pool tree, nullifier, the sigma binding) *and* the **BJJ swap** side
  (clearing, conservation, ranges). A standalone BabyJubJub Groth16 only proves the BJJ
  half — it knows nothing about the pool's secp notes — so it would force a dual proof
  (SP1 for notes + AMM-Groth16 for the swap) tied together on-chain. `OP_SWAP` does both
  in one SP1 proof.
- **No new ceremony / verifier on Ethereum.** SP1's verifier is universal; adding `OP_SWAP`
  only changes the guest vkey (a re-prove), not the on-chain verifier. Consistent with
  wrap/transfer/unwrap/bridge/attest.
- **The clearing math is cheap arithmetic.** `P_clear` is a deterministic ratio of public
  reserves/deltas; per-intent `amount_out = floor(amount_in · P_clear)` is integer math —
  trivial in-guest. The only new crypto the guest needs is **BabyJubJub** (for the
  `C_in_BJJ`/`C_out_BJJ` Pedersen openings) and the **secp↔BJJ sigma** check (already
  built + tested: `dapp/amm-sigma.js`, `tests/amm-sigma-xcurve.mjs`).

## The model (mirrors `amm_swap_batch.circom`)

- **Pool reserves are public on-chain state** (per `AMM.md`): `pools[poolId] = (assetA,
  assetB, R_A, R_B, feeBps)`. A swap reads `R_A_pre/R_B_pre`, applies the net deltas.
- **Deterministic clearing:** `P_clear = |delta_A_net| / |delta_B_net|` (A-dom/B-dom) or
  the spot ratio `R_A/R_B`; one uniform price for the whole batch.
- **Per intent (hidden amount):** the trader's **secp note** in the pool tree is nullified
  and sigma-bound to `C_in_BJJ`; `amount_out = floor(amount_in · P_clear)`, `≥ min_out`;
  `C_out_BJJ` opens to `amount_out` and is sigma-bound to a **new secp note** inserted as a
  leaf. So a confidential note swaps with pooled liquidity at a uniform price, amount
  hidden, within batch-anonymity — and the output is a fresh confidential note.

## What `OP_SWAP` proves in-guest, per batch

Reads: `poolId`, `R_A_pre`, `R_B_pre`, net deltas, `feeBps`, `n_intents`, and per intent
`{direction, secp-note (cx,cy,owner,leafIndex,path,secret), C_in_BJJ, C_out_BJJ, amount_in,
amount_out, rem, r_in_BJJ, r_out_BJJ, min_out, sigma_in, sigma_out}`. Asserts: each input
note's membership against `spendRoot` + nullifier; the secp↔BJJ sigma bindings; `C_in_BJJ`
opens to `amount_in`, `C_out_BJJ` to `amount_out`; `amount_out = floor(amount_in·P_clear)`
with `rem`; `amount_out ≥ min_out`; ranges; reserve conservation (`Σ` matches the net
deltas). Exposes in `PublicValues`: the input nullifiers, the output leaves, and a
`SwapSettlement[]` (`poolId`, signed `reserveADelta`, `reserveBDelta`).

## Contract changes (pool)

- `mapping(bytes32 => Pool) public pools;` + `Pool{assetA, assetB, R_A, R_B, feeBps, init}`.
- `PublicValues` gains `SwapSettlement[] swaps` (poolId + signed reserve deltas). `settle`
  applies each: assert `pools[poolId]` reserves equal the proven `_pre`, then move them by
  the deltas (the nullifiers/leaves flow through the existing settle paths).
- Pool reserves are initialized by `POOL_INIT` — Ethereum-origin (an LP-funded init) or
  relay-reflected from Bitcoin (the same `attestBitcoinStateProven` trust root).

## Build sequence (batches the guest re-prove with A)

1. **cxfer-core `bjj`** — port BabyJubJub (twisted Edwards over BN254 Fr) + Pedersen +
   pack from `tests/amm-bjj.mjs`; native KAT vs JS. (No guest/PublicValues change → safe
   to build now, alongside A's in-flight re-prove.)
2. **cxfer-core `sigma`** — the secp↔BJJ Camenisch-Stadler verify (port `amm-sigma`),
   native KAT.
3. **Guest `OP_SWAP`** + `PublicValues.swaps[]` (after A's re-prove + fixture land, so one
   combined re-prove → next vkey).
4. **Pool** reserve state + `settle` swap-delta application + tests (mock verifier).
5. **Re-prove** the guest (A+C op set) → new vkey → redeploy.

Reuses: the sigma binding (built), cxfer-core crypto, the SP1 stack, the pool's tree +
nullifier set. No new ceremony.
