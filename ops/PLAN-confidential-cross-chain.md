# PLAN — Confidential Cross-Chain (Phase 3: one balance, Bitcoin + Ethereum)

The endgame of the confidential token: a balance that is **one note** spendable
confidentially on Bitcoin *or* Ethereum, double-spend-safe across both, with the
amount hidden — and, in the strongest form, the origin chain indistinguishable.
No BN254-based system can build this; it requires the same curve on both chains,
which is what Tacit's secp256k1 notes give.

Foundation: [`PLAN-confidential-token-rollup.md`](./PLAN-confidential-token-rollup.md)
(Phase 1/2). Cross-chain transport substrate: the live tETH bridge
([`PLAN-teth-fresh-deployment.md`](./PLAN-teth-fresh-deployment.md),
[`PLAN-eth-native-privacy.md`](./PLAN-eth-native-privacy.md) Stage 2). This is a
**new generation** of the confidential-token system; it touches nothing in the
Phase-1/2 deployment beyond reusing it.

---

## 1. The one hard problem

Everything else is already in place by Phase 2 — same notes, same wallet, same
stealth, same range proofs on both chains. The single hard thing Phase 3 adds is
a **shared nullifier set**: a note can be spent on Bitcoin *or* Ethereum, exactly
once ever, so a spend on one chain must make it unspendable on the other.

Bitcoin and Ethereum share no consensus, so the two spend-surfaces need a way to
agree on "this note is spent." The Phase-1/2 tee-ups make the nullifier
**chain-independent** (`keccak(note_secret)`), so the same note already yields the
same nullifier on both chains — the global set is just a union, with no remapping.
What remains is keeping the two surfaces' views of that union consistent.

## 2. The asymmetry that makes it tractable

The two directions of "learn the other chain's spends" have very different cost,
and the easy split falls in our favor:

- **Ethereum learns Bitcoin spends — already solved by tETH.** The bridge's SP1
  stack verifies Bitcoin state (headers, pool trees) in-guest and lands it on an
  Ethereum contract (`SP1PoolRootVerifier`, the relay). That is precisely the
  primitive needed to fold Bitcoin-side spends into the Ethereum-anchored set. It
  runs in production today.
- **Bitcoin learns Ethereum spends — easy, because Bitcoin Tacit is off-chain-
  validated.** Validity is enforced by the indexer + clients, not by Bitcoin
  consensus, so "also read the Ethereum nullifier root" is a validator software
  change, not a consensus change. Ethereum is trivially queryable.

## 3. Architecture — Ethereum as the ordering anchor

The SP1 prover maintains one **global confidential state** (the indexed-Merkle
nullifier accumulator from Phase 2, now fed by both chains) and proves
transitions over inputs drawn from both:

- **Ethereum L1 is the linearization point.** Its contract verifies each proof
  on-chain and advances the canonical global root — so Ethereum's view is
  trustless and single-valued (one root chain, no fork).
- **Bitcoin defers to that root.** Bitcoin Tacit validators verify the same SP1
  proof off-chain (they already validate off-chain) and follow the
  Ethereum-anchored root. A Bitcoin spend is globally final once reflected in the
  anchored root.

This keeps consistency simple: there is exactly one ordering authority for the
shared set, and it is the chain that can verify the proof on-chain.

To keep same-chain activity fast, only notes that actually **cross** pay the
cross-chain consistency cost (§4); purely Bitcoin-side or purely Ethereum-side
spends settle on their own surface as in Phase 1/2.

## 4. Two strengths

- **Gold — seamless, finality-gated cross-chain spend.** Same-chain spends stay
  fast and independent. Moving a note to the other chain is a gated confidential
  operation transported on the **tETH rail**: it is tETH-style bridging at the
  *note* level — same security model, except the amount is hidden and there is no
  wrap/unwrap UX, because the note is the same object. The wallet hides the step:
  you "send," and if the recipient is on the other chain it performs the
  cross-chain claim under the hood. This is the realistic, high-value target and a
  clean extension of a live system.
- **Platinum — indistinguishable origin.** A unified deposit tree where it cannot
  be told at deposit which chain a note will be spent on (the "richer variant" in
  `PLAN-eth-shielded-pool-factory.md` §1). The strongest privacy form and the
  truly uncopyable moat; a step on top of the gold, eased by the
  Bitcoin-compatible leaf hashing teed up in Phase 1.

## 5. The finality gate

Cross-chain reflection waits for the source chain's finality so a reflected spend
cannot be undone:

- A Bitcoin spend is reflected into the Ethereum-anchored set only after
  sufficient Bitcoin confirmations, and only via an SP1 proof of Bitcoin state
  past that depth (the bridge's existing discipline).
- An Ethereum spend is followed by Bitcoin validators after Ethereum finality.

The gate adds latency to **cross-chain** transitions only; same-chain spends are
unaffected, and the §9 soft-finality of the foundation still gives the recipient
instant cryptographic assurance regardless of chain.

## 6. tETH's two roles

1. **Flagship asset.** Confidential **tETH** is private ETH that is fluid across
   both chains — hold it private on Bitcoin, spend it confidentially on Ethereum,
   one wallet. The demonstration that makes the offering legible.
2. **Substrate.** The cross-chain guest is a sibling of the tETH guest (shared
   crates for Bitcoin-state verification, secp, accumulators), reusing the pinned
   immutable SP1 Groth16 verifier, the relay, and the deposit/reorg discipline.
   One prover deployment serves the bridge and the confidential system.

## 7. Why this is a new generation, not a redeploy

The guest must consume a cross-chain spend accumulator and expose mint-nullifiers
in the public-values tail — a `vkey`-changing edit. The multi-generation
mechanism (as used for tETH gen-1) absorbs this cleanly: Phase 3 is generation-N,
deployed alongside the Phase-1/2 generation, sharing the immutable verifier. The
Phase-1/2 tee-ups (§11 of the foundation) mean nothing in the earlier generation
needs changing — the chain-independent nullifier, the global-set-shaped
accumulator, the versioned public values, and the cross-chain asset link are
already there.

## 8. Consistency and recovery posture

- **One ordering authority** (Ethereum L1) for the shared set; Bitcoin defers —
  no two-writer race for the canonical root.
- **Finality-gated reflection** (§5) keeps a reflected spend from being undone
  under normal conditions; deep reorgs are bounded by the confirmation depth, the
  same posture documented for the bridge.
- **Recovery** is unchanged from the foundation: seed-derived notes plus a scan
  of both chains; a note carries the same identity on both, so a wallet sees one
  balance.

## 9. Open decisions

- Gold vs platinum sequencing — ship gated cross-chain spend first, unified
  deposit tree second.
- Cross-chain asset binding mechanism (derive the EVM `asset_id` from the Bitcoin
  one for bridged assets vs an explicit registry link).
- Confirmation depths for the finality gate per direction, and the residual
  deep-reorg handling (accept-and-document vs an explicit unwind path).
- Whether the global accumulator lives canonically on Ethereum L1 storage or only
  as a root with the body reconstructed from both chains' DA.
- Relayer/settler economics for cross-chain transitions (fee paid in-asset, as in
  the foundation).
