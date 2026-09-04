# Self-hosted SP1 proving: Hierophant evaluation & integration approach

Status: **evaluation complete, integration not started.** This is a briefing for whoever picks up the
integration. Nothing here has been built or tested against our stack.

## 1. The idea

Every live op currently proves on Succinct's hosted network:

```
relay → dist/exec-<op> (SP1_PROVER=network) → rpc.mainnet.succinct.xyz → Groth16 → settle onchain
```

That makes pool liveness depend on one company's API endpoint and one funded account key. Not a cost
problem — a single-point-of-failure problem in a system otherwise built to be immutable and
uncensorable.

[Hierophant](https://github.com/unattended-backpack/hierophant) is that hosted network,
open-sourced: a dispatcher (`hierophant`) plus GPU workers (`contemplant`). Run both, repoint
`NETWORK_RPC_URL` at your own box, and the rest of the stack is unchanged.

**The load-bearing claim to verify first:** the contemplant wraps to Groth16 using Succinct's own
vendored circuit artifacts (`groth16.tar.gz` at an operator-supplied `SP1_CIRCUITS_VERSION`) via
`sp1-sdk`'s native-gnark path. If true, the proof is accepted by the SP1 verifier **already
deployed** — no new generation, no vkey rotation, no change to the immutable surface. If false, this
whole line of work is dead; stop and report.

## 2. Where it plugs into our stack

Small surface. Three files, all relay-side:

| File | Today | Change |
|---|---|---|
| [config.js:129-132](../worker-relay/src/lib/config.js#L129-L132) | `networkRpcUrl` defaults to `rpc.mainnet.succinct.xyz` | point at self-hosted endpoint |
| [prover.js:15-26](../worker-relay/src/lib/prover.js#L15-L26) | injects `SP1_PROVER` / `NETWORK_RPC_URL` / `NETWORK_PRIVATE_KEY` | unchanged mechanically |
| [harnesses/Cargo.toml:26](../contracts/sp1/confidential/harnesses/Cargo.toml#L26) | `sp1-sdk = { version = "=6.2.3", features = ["blocking", "network"] }` | **must add `reserved-capacity`** — see §3.1 |

Guest ELFs and vkeys are **not** in scope. Only the host harness binaries change.

## 3. Known blockers, in priority order

### 3.1 Reserved mode — every harness binary must be rebuilt

sp1-sdk 6.x defaults `NetworkProver` to Mainnet's *auction* flow. Hierophant deliberately does not
implement the bidding RPCs, so a default-mode client's request **auto-cancels after ~30 seconds** —
it will look like a mysterious timeout, not a config error.

Fix: add the sdk's `reserved-capacity` cargo feature (which flips the default), or construct via
`ProverClient::builder().network_for(NetworkMode::Reserved)`. Then rebuild and re-upload all
`dist/exec-*` via [build-all-network.sh](../contracts/sp1/confidential/build-all-network.sh) and
refresh `worker-relay/prover/bin/SHA256SUMS`.

Note: `reserved-capacity` changes the default *network mode only*. Confirm it does not perturb the
Groth16 wrap path before trusting the rebuilt bins.

### 3.2 Version skew

Hierophant pins `sp1-sdk =6.2.1`; we pin `=6.2.3` across
[harnesses](../contracts/sp1/confidential/harnesses/Cargo.toml#L26) and
[prover-host](../contracts/sp1/eth-reflection/prover-host/Cargo.toml#L28). Same 6.2 Hypercube
generation, so this is probably benign — but the **circuit artifact version is what binds to the
deployed verifier**, so confirm equality explicitly rather than reasoning from the patch number.
5.x and 6.x clients cannot share a Hierophant instance.

### 3.3 Hardware

`sp1-gpu-server` 6.x refuses GPUs with <24 GB VRAM at startup. Our RTX 4090 box is exactly at the
floor with zero headroom. Assume one op at a time per worker (a contemplant proves one proof at a
time regardless of how many VMs it declares).

### 3.4 No progress signal

Cycle-accurate progress tracking is dead for all VMs in current Hierophant (moongate was removed in
sp1-sdk 6.x). Keep `worker_required_progress_interval_mins = 0` or workers get dropped spuriously.
Consequence: we lose the stall signal, which matters most for the long reflection catch-up lane.
Plan a relay-side timeout instead — `prover.js` already hard-kills on `timeoutMs`.

### 3.5 Maturity and license

Single contributor, ~276 commits, ~13 stars, no known production users. Bus factor 1. Licensed
**VPL + AGPL-3.0-only**, explicitly chosen for aggressive copyleft; we would be running it as a
network-facing service. Both facts argue for "second lane," not "replacement," and the license needs
a human read before production.

## 3.6 Hierophant vs. plain local proving — what it actually buys you

Running your own hardware does not require hierophant. `prover.js` already documents this fallback:
point `BITCOIN_PROVE_BIN` / `EXEC_BIN` at a box-built binary, unset `SP1_PROVER`, and prove locally
via `sp1-gpu-server` — no dispatcher, no worker-registration protocol, no AGPL/VPL dependency.

For a single operator with a single GPU box, hierophant adds a dispatcher-and-worker layer around
something that plain local proving already does, without removing the single-point-of-failure
problem — it just relocates it from "Succinct's endpoint" to "your one box," the same relocation
plain local proving achieves on its own with far less unproven software (bus factor 1, ~13 stars, no
known production users — see §3.5) sitting in the critical path.

Where hierophant's dispatcher-plus-workers shape actually pays for itself is a **multi-operator**
future: more than one contemplant (ours, plus eventually anyone else willing to run proving capacity
for the pool) behind one endpoint the relay talks to, load-balanced, swappable without relay code
changes. That is a decentralization argument, not a cost or hardware-avoidance one — it only
justifies the extra complexity if the plan is to grow past one box, or to open proving capacity to
other operators.

Practical read: if the near-term goal is just liveness insurance against Succinct going down, skip
hierophant and use the existing local-proving fallback directly. Only bring in hierophant when a
second (or third-party) prover behind a shared endpoint is actually on the roadmap.

**Speculative — a possible tokenomics angle, not evaluated.** The relay pays Succinct's `$PROVE` per
op today (see proving-economics work). If hierophant's multi-operator shape is ever pursued, that fee
is a candidate to redirect: pay third-party contemplant operators in TAC (or a cut of relay op fees)
instead of it leaving the system to Succinct. This has not been checked against whether hierophant
has any built-in payment/staking mechanism for contemplants — plausibly none exists and any reward
layer would need to be built on our side. Treat as a roadmap idea to think through deliberately, not
a proposal.

## 4. Proposed approach: shadow lane, then failover

Do **not** cut over. Build it as a lane that proves the same work in parallel and is compared, not
trusted.

**Phase 0 — verify the load-bearing claim (do this before anything else).**
Stand up hierophant + one contemplant on the existing GPU box. Run their `make test-sp1` Groth16
path. Confirm it emits a Groth16 proof and that the circuit artifact version matches what our
deployed verifier expects. If it doesn't, stop here.

**Phase 1 — one op, offchain, verify-compare.**
Rebuild a single harness (`wrap` is the simplest) with `reserved-capacity`. Prove one real op
*both* ways — hosted Succinct and self-hosted — from identical `OP_FILE` input. Do not submit either
onchain. **This is the go/no-go gate: both proofs must independently verify against our pinned SP1
verifier/vkey, and public values must match exactly.** Do not expect the Groth16 proof bytes
themselves to match — Groth16 proving uses random blinding factors (r, s) for zero-knowledge, so a
correct prover legitimately emits different bytes for the same witness on every run (the same
re-randomizability property documented in Groth16 malleability writeups). Byte equality was never
the right test; verified confirms this before starting.

**Phase 2 — shadow the full op set.**
Rebuild all harnesses. Run the self-hosted lane in shadow: every op proves on Succinct (authoritative,
settles) and self-hosted (compared, discarded). Log divergence and wall-clock. Let it run long
enough to see real load, including a reflection fold.

**Phase 3 — failover, not cutover.**
Make `networkRpcUrl` a prioritized list, mirroring the pattern already used for the RPC endpoints in
worker-relay (see commit `4efea8cd`). Self-hosted primary, Succinct fallback, or the reverse —
either ordering is a strict liveness improvement over a single endpoint. Never remove the second.

## 5. What would make this a no-go

- Groth16 output not accepted by the deployed verifier (Phase 0/1 failure).
- Circuit artifact version cannot be matched to our `=6.2.3` verifier.
- `reserved-capacity` perturbs the proof or the wrap path.
- Reflection-fold-sized proofs OOM or exceed the 24 GB floor on our box.

## 6. Open questions for the integrator

1. ~~Is SP1's Groth16 wrap byte-deterministic for fixed input+vkey?~~ **Resolved: no.** Groth16
   proving draws fresh random blinding factors (r, s) per run for zero-knowledge — proofs are
   re-randomizable by construction, so identical witnesses correctly yield different proof bytes.
   Phase 1's gate is "both verify against the pinned vkey, public values match," never byte equality.
2. ~~Does hierophant verify SP1 proofs server-side before returning them?~~ **Resolved: not
   documented, treat as no.** The README's full-verification-plus-worker-dropping language is scoped
   explicitly to `app`/`stark` (RISC Zero/OpenVM) and is never restated for SP1's `core`/`compressed`/
   `plonk`/`groth16` modes. Assume hierophant does not vet SP1 output. This is lower-risk than it
   sounds: our own deployed SP1 verifier rejects a bad proof on submission regardless, so an
   unverified proof from this lane costs wasted gas on a bad settlement attempt, not an accepted bad
   proof — but never let the *relay* skip its own check and settle blind on this lane's output.
3. What is the actual cost crossover (GPU rent vs per-proof fee) at our observed op rate? Ties into
   the existing proving-economics work.
4. Does the auction-vs-reserved distinction have any bearing on our *hosted* Succinct usage today —
   i.e. are we already implicitly on the auction path, and is that a latency risk we haven't noticed?
