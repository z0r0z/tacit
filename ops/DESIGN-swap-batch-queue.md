# Batching confidential swaps: the intent queue

How `OP_SWAP` batching and `OP_SWAP_BLIND` get to production across the API, the relayer, the dapp and
integrations — and why the two kinds of batching in this codebase are not the same thing.

Status: design. Most of the machinery already exists and is unwired; this says what to connect and in
what order. Measurements are from 2026-09-20 against the deployed guest.

---

## 1. Two batchings, often confused

| | what it groups | what it amortises | where it lives |
|---|---|---|---|
| **Intent batching** | N traders' swaps inside **one op** | the **proof** — one Groth16 verify, one clearing | `dapp/confidential-swap-coordinator.js` |
| **Job batching** | N independent ops inside **one settle tx** | **gas** only | `worker/src/confidential-settle.js` `nextBatch()` |

They compose, but they solve different problems. For `OP_SWAP_BLIND` it is **intent batching that matters**,
because the expensive thing — the in-guest BN254 pairing — is paid once *per op*, not per transaction. Job
batching cannot help it at all.

This distinction is the whole reason the economics work out, so it is worth being explicit about.

## 2. Why batching is required for `OP_SWAP_BLIND`, not just nice

`OP_SWAP` is transparent to the prover: the guest computes the clearing, so it reads every intent's
`amount_in` / `amount_out` in cleartext. Batching there is a **privacy improvement** — the public reserve
delta covers N traders instead of one, so individual sizes hide in the aggregate. It is optional.

`OP_SWAP_BLIND` is prover-blind: clearing correctness comes from an in-guest `amm_swap_batch` Groth16 proof,
so the box never reads a cleartext amount. That is the product. It costs:

```
EXECUTE_OK cycles=7,611,678,765   (one-intent batch, against the deployed PROGRAM_VKEY)
```

`swap_blind.rs` calls `groth16_bn254_verify` **once over the whole envelope**; only the per-intent loop
(membership, cross-curve sigma, blind PoK, BP+ range) scales. So:

```
cost per trader  ≈  fixed_pairing / n_intents  +  marginal_per_intent
```

The guest caps `n_intents` at 16. A full batch therefore amortises one pairing across sixteen traders rather
than one — an order of magnitude on the dominant term. **Batching is what makes the op economic**, which is
why it should ship with a coordinator rather than as a solo path someone flips on.

## 3. What already exists

**Dapp — `dapp/confidential-swap-coordinator.js`.** A working intent coordinator for `OP_SWAP`: buffers
intents per pool, flushes on `minIntents` (default 4) or `maxWaitMs` (default 6000), solves one uniform
clearing price, assembles a single op through the proven assembler, self-checks with `verifyBatch`, and
submits one settle. Its own header says it is "NOT wired into the live path yet (slow-start ships
solo/transparent)". Everything is injected, so it is testable unmounted.

**Relay — `nextBatch({ max, types })`.** Claims up to `max` pending jobs that share a `spendRoot` and
`chainBinding` so they can ride one settle. Today `types` defaults to `['transfer']`.

**Guest.** `OP_SWAP` clears up to `MAX_ITEMS_PER_OP` intents; `OP_SWAP_BLIND` up to 16 and is **proven
correct against the deployed ELF** by execute (see `harnesses/exec-swapblind.rs`).

So the shape is built. What is missing is the wiring and the pricing.

## 4. What to connect

### 4.1 API (`worker/src/`)

- Add `'swapblind'` to `submitJob`'s type allowlist in `confidential-settle.js`.
- **Add an intent-submission path distinct from op submission.** Today `/confidential/submit` takes a
  *finished op*. Batching needs a queue of *intents* that something later assembles:

  ```
  POST /confidential/intent   { poolId, direction, inNote, outOwner, minOut, tip, deadline, … }
                              → { intentId, status: 'queued' }
  GET  /confidential/intent?id=…  → queued | batched(jobId) | settled | expired
  ```

  Keep the existing op path untouched — an integrator that wants to self-assemble still can.
- Bound the queue the way `MAX_PENDING_JOBS` bounds jobs, and expire intents past their deadline rather
  than letting them accumulate.

### 4.2 Relayer (`worker-relay/src/`)

- `PEROP['swapblind'] = 'exec-swapblind'` in `lib/prover.js`.
- **Per-type cycle limit.** Every settle harness proves under `cycle_limit(256_000_000)`; a swap-blind batch
  needs far more (`exec-swapblind.rs` already sets `16_000_000_000`). Make the limit a per-type value rather
  than one constant, so raising it for swapblind does not raise it for everything.
- **Per-type fee floor.** `relay-quote.js` prices a floor from gas. Swapblind's dominant cost is *proving*,
  not gas, so its floor needs a cycles term:

  ```
  floor_swapblind ≈ (settleGas × gasPrice + provePrice(cycles)) / n_intents × (1 + margin)
  ```

  Each trader's tip is already bound per-intent in the PoK context and summed by the circuit, so the split
  is enforced in-guest — the relay only has to *quote* it correctly.

### 4.3 Dapp

- Mirror the existing coordinator as a swapblind coordinator. The difference is that clearing is **proven by
  the circuit** rather than solved in cleartext, so the coordinator assembles the envelope
  (`confidential-swapblind.js` → `buildSwapBlindOp`) instead of solving a price itself.
- Trigger tuning matters more here: with a fixed pairing cost, flushing at 2 intents wastes most of the
  benefit. Prefer a higher `minIntents` and a longer `maxWaitMs` than the `OP_SWAP` defaults, and show the
  user the trade (`wait ~Ns for a cheaper, more private batch`).
- Fall back to `OP_SWAP` when a batch cannot fill before the deadline, and say so in the UI rather than
  silently downgrading the privacy the user selected.

### 4.4 Integrations

- Document the two entry points plainly: **submit an op** (you assemble, you control timing) versus
  **submit an intent** (we batch, cheaper and more private, arrives when the batch flushes).
- An intent is not a settle: its receipt is `queued`, and the integrator polls to `batched` → `settled`.
  Anything user-facing needs to model that extra state rather than treating submit as terminal.

## 5. Order to ship

1. **Per-type cycle limit and fee floor** on the relay. Without these a swapblind job is rejected by the
   256M ceiling or settled at a loss — so this comes first, before the type is reachable at all.
2. **Allowlist + `PEROP`**, making the op reachable for self-assembled envelopes. Exercise it with the
   committed fixture end to end (a real Groth16 prove, not just the execute that already passes).
3. **Intent queue** in the API, plus the swapblind coordinator in the dapp.
4. **Turn on batching for `OP_SWAP` too** — the coordinator is already written, and it is a pure privacy win
   with no proving-cost question attached.

Steps 1–2 make the op *possible*; step 3 makes it *economic*; step 4 is free privacy that has been sitting
unwired.

## 6. The Bitcoin lane

`swap_batch.rs`'s `fold_swap_batch` runs the **same** `groth16_bn254_verify` against the same baked
`batch_vk()` — but inside a reflection proof that is produced anyway for the lane to advance, and that lane
budgets `ETHPROVE_CYCLE_LIMIT = 3e9` rather than `256e6`. So a Bitcoin-side AMM batch is a verify added to an
existing proof rather than a proof needing its own fee, which is structurally the cheaper place for it.

Not free, though: a one-intent batch measured 7.6e9 cycles, above that 3e9 default, so the reflection budget
wants checking the first time a swap batch actually folds.

## 7. What this does not change

The guest. `OP_SWAP` and `OP_SWAP_BLIND` both already clear N intents; batching is entirely an off-chain
capability. No contract redeploy, no re-prove, no vkey rotation. That is what makes it safe to ship
incrementally — every step above is revertible config or off-chain code.
