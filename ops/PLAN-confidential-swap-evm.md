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
  trivial in-guest. The guest needs **no new curve crypto**: because it computes the clearing
  it already holds the amounts in cleartext, so it binds each amount to its note with the
  existing secp Pedersen opening (`C == amount·H + r·G`, precompile-accelerated, the same
  primitive `wrap`/`unwrap` use). Measured: ~513K cycles/intent. (A cross-curve BabyJubJub +
  secp↔BJJ sigma binding — `dapp/amm-bjj.js`, `dapp/amm-sigma.js` — is only required when the
  amounts must be hidden from the *prover* itself, i.e. the homomorphic batch-aggregation
  follow-up; it cost ~6.06B cycles/intent in-guest and is intentionally NOT in the base op.)

## The model (mirrors `amm_swap_batch.circom`)

- **Pool reserves are public on-chain state** (per `AMM.md`): `pools[poolId] = (assetA,
  assetB, R_A, R_B, feeBps)`. A swap reads `R_A_pre/R_B_pre`, applies the net deltas.
- **Deterministic clearing:** `P_clear = |delta_A_net| / |delta_B_net|` (A-dom/B-dom) or
  the spot ratio `R_A/R_B`; one uniform price for the whole batch.
- **Per intent (hidden amount):** the trader's **secp note** in the pool tree is nullified and
  its `C_in` opened to `amount_in`; `amount_out = floor(amount_in · P_clear)`, `≥ min_out`; a
  **new secp note** whose `C_out` opens to `amount_out` is inserted as a leaf. So a confidential
  note swaps with pooled liquidity at a uniform price, amount hidden from PublicValues readers,
  within batch-anonymity — and the output is a fresh confidential note.

## What `OP_SWAP` proves in-guest, per batch

Reads: `assetA`, `assetB`, `R_A_pre`, `R_B_pre`, `price_num`/`price_den` (B per A), `n_intents`,
and per intent `{direction, in-note (cx,cy,owner,leafIndex,path), amount_in, amount_out, rem,
r_in, min_out, out-note (cx,cy,owner), r_out}`. Asserts: `poolId == keccak(assetA‖assetB)`; each
input note's membership against `spendRoot` + note-bound nullifier (+ the cross-lane gate); the
two secp Pedersen openings (`C_in` to `amount_in`, `C_out` to `amount_out` — the typed u64 + the
opening is the range check); `amount_out = floor(amount_in·P_clear)` with `rem`; `amount_out ≥
min_out`; net reserve move with no underflow + the constant-product non-decrease `k_post ≥ k_pre`.
Exposes in `PublicValues`: the input nullifiers, the output leaves, and a `SwapSettlement[]`
(`poolId`, `reserveAPre/Post`, `reserveBPre/Post`).

## Contract changes (pool)

- `mapping(bytes32 => Pool) public pools;` + `Pool{assetA, assetB, R_A, R_B, feeBps, init}`.
- `PublicValues` gains `SwapSettlement[] swaps` (poolId + signed reserve deltas). `settle`
  applies each: assert `pools[poolId]` reserves equal the proven `_pre`, then move them by
  the deltas (the nullifiers/leaves flow through the existing settle paths).
- Pool reserves are initialized by `POOL_INIT` — Ethereum-origin (an LP-funded init) or
  relay-reflected from Bitcoin (the same `attestBitcoinStateProven` trust root).

## Build sequence — status

1. ✅ **Pool** reserve state + `settle` swap-delta application + tests (C-1, `e9d699e`): 8 swap
   tests + 93 confidential green.
2. ✅ **Guest `OP_SWAP`** + `PublicValues.swaps[]` (C-2, `f8fa108`; simplified `b53a3bc`). Binds
   amounts with direct secp Pedersen openings (not BJJ+sigma): 6.06B → 513K cycles/intent.
   `dapp/confidential-swap.js` assembler + 6-check node test + `swap_op.json` + `exec-swap.rs`.
3. ✅ **Re-prove** → vkey `0x00bc5661…4c93d`; box **EXECUTE_OK** on the rebuilt ELF (C-3).
4. ⏳ **groth16 on-chain proof** — now economical (513K cycles); blocked only by a box-VRAM
   orphan (reboot to reclaim), then pin the vkey + commit the canonical ELF + redeploy.
5. ⏳ **POOL_INIT relay-reflected** (Bitcoin-origin pools) — only Ethereum-origin `initPool` today.

Reuses: the secp Pedersen opening + cxfer-core crypto, the SP1 stack, the pool's tree +
nullifier set. No new ceremony. The `bjj`/`sigma` modules (built + KAT-tested, commits
`8eb906b`/`b739e97`) are retained as the foundation for the hide-from-prover homomorphic-
aggregation follow-up, not the base op.
