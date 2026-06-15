# In-guest BN254 Groth16 verifier — scope (T_SWAP_BATCH bridge onboarding)

Companion to ops/DESIGN-bridge-multiasset-provenance.md. The one Tacit op the generalized conservation
kernel only HALF-covers is `T_SWAP_BATCH` (0x2F, the confidential AMM batch): its aggregate per-asset
conservation IS `asset_scoped_kernel_verify` on the net deltas, but the PER-RECEIPT split (per-trader
amounts hidden in BabyJubJub Pedersen) is bound only by a **BN254 Groth16** clearing proof. To onboard a
batch receipt as real (bridgeable), the reflection guest must verify that Groth16 — otherwise a trader could
over-state their receipt inside an aggregate-conserving batch and bridge unbacked value. This doc scopes
that verifier.

## What it proves + why it's needed

The batch Groth16 (snarkjs/circom, BN254) proves: given the intent input commitments + the pool reserves,
the receipt commitments are the correct uniform-price clearing (each trader gets exactly their cleared
amount). The reflection needs this so EACH receipt can be onboarded INDEPENDENTLY (one trader bridging
without the others' witnessed amounts). Without it, only whole-batch onboarding (all receipts + the
aggregate identity) would be sound — impractical for on-demand bridging.

## The verification (standard Groth16)

Proof `(A ∈ G1, B ∈ G2, C ∈ G1)`; vk `(α∈G1, β∈G2, γ∈G2, δ∈G2, IC[0..n]∈G1)`; public inputs `x[1..n]`.
```
vk_x = IC[0] + Σ x[i]·IC[i]
e(A, B) == e(α, β) · e(vk_x, γ) · e(C, δ)
```
One Miller-loop-heavy pairing check (4 pairings) on BN254 + an n-term G1 multiexp for `vk_x`.

## Dependency + cost

- **SP1 has BN254 precompiles** (it uses BN254 for its own recursion). The cleanest path is a no-std BN254
  Groth16 verifier built on the SP1-patched `bn` crate (the same machinery `sp1-verifier` uses for SP1's
  own Groth16), adapted to the **snarkjs** vk/proof encoding (snarkjs G2 Fp2 limb order + the
  `IC[0] + Σ x·IC` public-input convention differ from gnark). Alternative: SP1-patched `ark-bn254` +
  `ark-groth16`.
- **Cost:** a BN254 pairing is ~hundreds of K–low-millions of guest cycles even WITH precompiles; 4 pairings
  + the multiexp make this the single heaviest reflection operation. It runs once per batch folded (not per
  receipt), so it amortizes over the batch's receipts. Acceptable but must be measured on the box.
- Adding a BN254 curve dependency to `cxfer-core` (shared, no-std) is a real decision — it grows BOTH guest
  ELFs. Gate it behind a feature or keep the verifier in the reflection bin only if the settle guest never
  needs it (it doesn't — T_SWAP_BATCH is Bitcoin-side).

## Integration (`fold_swap_batch`, when the circuit lands)

1. **Aggregate conservation** — `asset_scoped_kernel_verify` on the batch's net `(Δa, Δb)` vs the
   intent/receipt commitments (HAVE this primitive).
2. **Groth16 verify** — `groth16_bn254_verify(BATCH_VK, proof, public_inputs)`, with `BATCH_VK` the
   ceremony-produced vk baked into the reflection guest (rotates `BITCOIN_RELAY_VKEY` on change), and
   `public_inputs` RE-DERIVED by the reflection from the on-chain batch envelope (net deltas, reserves,
   receipt commitments) so a prover can't feed forged signals.
3. **Per-receipt onboarding** — each receipt opens to its cleared amount under a reflection-witnessed
   blinding (the `fold_lp_remove` shape), then onboard it (real, live, bridgeable).
4. **Reserve update** — pool reserves move by the public net deltas; registry advanced.

## BLOCKER — the circuit doesn't exist yet (pre-ceremony)

`T_SWAP_BATCH`'s POOL_INIT references a `vk_cid` produced by the Phase-2 ceremony, which has not happened —
**no batch circuit, no vk, no public-signal layout exists today** (the worker's batch branch is inert by
design until the ceremony lands). So:

- **Buildable now (circuit-agnostic):** the general `groth16_bn254_verify` (the pairing equation + snarkjs
  format adaptation + the BN254 dependency wiring). This is the reusable core and the bulk of the lift.
- **Blocked on the ceremony (circuit-specific):** the exact public-input layout, how the reflection
  re-derives the public inputs from the envelope, and the baked `BATCH_VK`. These can only be pinned once
  the circuit is finalized.

So the honest plan: build + unit-test the general BN254 Groth16 verifier against a KNOWN snarkjs test vector
(any circom circuit) so the pairing path is proven; wire `fold_swap_batch`'s non-Groth16 parts (aggregate
kernel + reserve update + per-receipt openings, all already-built primitives); and leave the circuit-specific
public-input derivation + the baked vk as a one-function gap to close when the ceremony produces the circuit.
Until then T_SWAP_BATCH stays fail-closed (no live batch txs exist anyway), exactly as it is now.

## Skeleton

```rust
// cxfer-core (reflection-only / feature-gated): the general snarkjs-format BN254 Groth16 verifier.
pub struct G16Vk { pub alpha: G1, pub beta: G2, pub gamma: G2, pub delta: G2, pub ic: Vec<G1> }
pub struct G16Proof { pub a: G1, pub b: G2, pub c: G1 }

pub fn groth16_bn254_verify(vk: &G16Vk, proof: &G16Proof, public_inputs: &[Fr]) -> bool {
    if public_inputs.len() + 1 != vk.ic.len() { return false; }
    // vk_x = IC[0] + Σ x[i]·IC[i+1]   (snarkjs public-input convention)
    let mut vk_x = vk.ic[0];
    for (i, x) in public_inputs.iter().enumerate() { vk_x = vk_x + vk.ic[i + 1] * x; }
    // e(A,B) == e(α,β)·e(vk_x,γ)·e(C,δ)  — as a single multi-pairing product == 1 check:
    //   e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ) == 1
    pairing_product_is_one(&[(-proof.a, proof.b), (vk.alpha, vk.beta), (vk_x, vk.gamma), (proof.c, vk.delta)])
}
// G1/G2/Fr/pairing_product_is_one: from the SP1-patched bn (or ark-bn254) crate, BN254-precompile-accelerated.
```
