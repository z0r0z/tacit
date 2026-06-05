# Ethereum-native privacy — roadmap

Two stages, both decoupled from the tETH bridge generations so neither gates
nor is gated by alpha. The split is deliberate: stage 1 is simple and shippable
now; stage 2 is the genuinely hard piece and gets its own design pass.

## Stage 1 — standalone Ethereum-only mixer (shippable anytime)

A self-contained ETH mixer: deposit ETH → later submit a membership + nullifier
proof naming a fresh recipient → ETH out (gasless via an account-abstraction
paymaster; no in-protocol relayer fee needed).

It reuses what already exists:
- the canonical Groth16 membership + nullifier circuit and verifier — **no new
  ceremony**; the proof a user generates is the same shape used elsewhere;
- the mixer's on-chain deposit tree (`currentRoot` / `everKnownRoot` /
  `nextLeafIndex`) and its `nonReentrant` guard.

New pieces are small and well-understood (Tornado-shape):
- a direct withdraw function — verify the proof against a known deposit-tree
  root, check-and-set an on-chain nullifier mapping, pay the recipient;
- the `mapping(bytes32 => bool)` nullifier set itself.

Deployed as its **own pool / own deployment**, so it has its **own anonymity
set** (Ethereum-only) with zero interaction with the bridge. That isolation is
exactly what keeps it simple and low-risk. The trade is that the set is not
shared with tETH/Bitcoin depositors — which is stage 2.

## Stage 2 — shared anonymity set (a deliberate future generation)

Goal: one pool whose notes are redeemable via **either** the Ethereum-direct
path **or** the Bitcoin export/burn path, so Ethereum-only and tETH/Bitcoin users
draw on one larger anonymity set.

The whole difficulty is keeping **one authoritative nullifier set** consistent
across two timing models: the Ethereum-direct path consumes a nullifier
**synchronously** on chain, while the Bitcoin path consumes it
**asynchronously**, when the SP1 proof for that op lands. Consistency requires
both directions:
- the guest reads the on-chain nullifier set at prove time, so a note settled on
  chain is not also accepted on the Bitcoin side;
- the Ethereum-direct withdraw is **gated on proof finality** — it settles only
  once the guest has proven Bitcoin recent enough that no still-unproven
  Bitcoin-side spend of the same note can exist.

This is the standard synchronous/asynchronous bridge-state consistency problem.
It is solvable with the finality gate, but it is the centerpiece of this
generation and warrants its own design + review pass rather than being folded
into other work. It also gives TRUST-1 (an on-chain nullifier set) a concrete
purpose.

## Sequencing

- **Independent of alpha.** Alpha stays the lean fund-safety hardening; neither
  stage touches it.
- **Stage 1** ships on its own track whenever — separate deployment, no
  migration, reuses the alpha-era circuit and verifier.
- **Stage 2** rides a future bridge generation, designed deliberately with the
  finality-gated consistency model as its headline. The per-generation +
  standalone-deployment model is what lets the hard feature get the design it
  needs instead of being rushed.
