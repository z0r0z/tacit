# Maintainer response — GPT greenlight audit, round 23 (bundle @ `3ba32f7`)

**Clean lock on the audited code surface.** The round-23 pass confirmed the two round-22 prover-blind blockers
are correctly and completely fixed, found **0 active fund-impacting code findings**, and saw no regression
across the whole confirmed-tx fold / prover-supplied-witness sweep. The two open items are deployment/readiness,
not code defects.

| ID | Finding | Severity | Disposition |
|----|---------|----------|-------------|
| F-01 | `BRIDGE_STEALTH_MINT` blind `L` range-bound on the fee path | Resolved Critical | **Confirmed fixed** |
| F-02 | blind `STEALTH_REFUND` locker-authorized + non-replayable | Resolved High | **Confirmed fixed** |
| Q-01 | eth-reflection anchor still Sepolia-pinned | High *iff mainnet* | **Inapplicable — this reprove is Sepolia** |
| Q-02 | worker/fixture ladder for the live blind ops | Low (liveness) | **Known follow-up (guest authoritative)** |

## F-01 / F-02 — confirmed fixed
The auditor verified F-01 end-to-end: the same `l_pt` is the burn-set destination, the fee-bearing kernel
output, and the range-proven commitment — no alternate ranged commitment can be swapped in, so `v_L < 2^64`
forces `fee = v_in − v_L ≤ v_in`. And F-02: the refund requires a BIP-340 signature under `locker` over a
domain-separated message (`tacit-stealth-refund-auth-v1`, binding the lock leaf + exact `O` + fee), output owner
hardcoded to `locker`, so a memo-holder who learns `r_L` can neither steal via the fee leg nor grief an
unspendable output, and a blind-claim signature cannot replay as a refund.

## Q-01 — Sepolia anchor: inapplicable for this rehearsal
The eth-reflection weak-subjectivity anchor is the documented Sepolia rehearsal anchor, and **this reprove
targets Sepolia**, so it is correct as-is — no re-anchor. The immutable `ETH_REFLECTION_VKEY` binds the chain
(a Sepolia-anchored proof can't verify under a mainnet vkey), so for the eventual mainnet deploy this is the
standing re-anchor + re-prove step (recompute `ETH_REFLECTION_VKEY` against the freshly-built eth-reflection ELF
and re-pin it in the reflection guest **before** that guest is proven — the recursive-vkey coherence order).
Not a code defect.

## Q-02 — worker ladder for the live blind ops
The bake-in blind ops (STEALTH_LOCK/CLAIM/REFUND, SEND_AND_UNWRAP, BRIDGE_STEALTH_MINT) are live, so their JS
witness builders + fixtures + DIGEST-gate parity must land before they can be driven — the same guest-first /
mirror-follows pattern used for the prior cross-out-IMT and burn-deposit work. A wrong builder cannot make an
invalid proof pass (the guest is authoritative); it only affects honest-user liveness. `SWAP_BLIND` stays
dormant (un-emitted) until its in-zkVM Groth16 acceptance lands post-launch.

## Verification
cxfer-core 156/156; all three guests build; the reflection ELF rebuilds from current source. Pool unchanged at
24,566 / 24,576 under EIP-170.

## Net
On the audited immutable surface the verdict is **lock** for the Sepolia rehearsal. Remaining before the live
blind ops are usable: the Q-02 worker ladder (JS builders/fixtures → DIGEST gate green) and the standing reprove
integration (rotated `PROGRAM_VKEY`/deploy default vkey). The mainnet re-anchor (Q-01) is a later, separate gate.
