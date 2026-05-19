# tacit circuits — how the ZK stack composes

One shared cryptographic stack, two circuit families, applied
across every privacy-bearing surface in the protocol. This
document is the canonical reference for what each circuit
proves, where it is reused, and how the families compose.

Companion to [`SPEC.md`](../SPEC.md) (wire-format authority),
[`MIXER.md`](../MIXER.md), [`AMM.md`](../AMM.md), and the
cBTC.zk / cBTC.tac amendments under
[`spec/amendments/`](./amendments/).

## Shared foundation

| Layer | Primitive |
|---|---|
| Proof system | Groth16 over BN254 |
| Phase 1 (powers of tau) | Polygon Hermez ceremony output — `pot14` for mixer, `pot18` for AMM batch |
| In-circuit set membership | Poseidon hashes (BN254-native) |
| In-circuit amount commitments | BabyJubJub Pedersen (embedded curve over BN254 Fr) |
| Chain-side amount commitments | secp256k1 Pedersen (Bitcoin's curve) |
| Cross-curve binding (out-of-circuit) | Camenisch–Stadler sigma proof, 169 B, no setup |
| Range proofs | Bulletproofs (CXFER, T_SWAP_VAR, T_AXFER_VAR) |
| Authentication | BIP-340 Schnorr |

Doing secp256k1 EC inside a BN254 circuit costs ~1M constraints
per opening. The protocol avoids that entirely: chain commitments
live on secp256k1, in-circuit work lives on BabyJubJub, and a
~169-byte sigma proof binds them out-of-circuit. Every circuit in
the protocol inherits this discipline.

## Circuit family 1 — anonymous unique-spend

**The primitive:** prove "I know `(secret, ν)` such that
`Poseidon₃(secret, ν, denomination)` is a leaf in the pool's
Merkle tree, and `Poseidon₁(ν)` has not been used."

**The shape:** set membership via Poseidon-Merkle path verification
+ nullifier reveal. Anonymity set is the leaves in the pool;
double-spend defense is the nullifier set.

**The circuit:** `withdraw.circom` (mixer). ~3K constraints,
verifies against `pot14`.

**Where it is reused, without modification:**

- **Mixer `T_WITHDRAW`** (`0x2A`) — anonymous mint from
  `(asset_id, denomination)` pool. The original use case.
- **cBTC.zk slot ops** (`T_SLOT_BURN` `0x44`, `T_SLOT_ROTATE`
  `0x45`, `T_SLOT_SPLIT` `0x46`, `T_SLOT_MERGE` `0x47`) — every
  cBTC.zk slot **is** a mixer leaf. The slot's spending key
  `K_btc = r_leaf · G_secp256k1` is derived from the leaf's own
  `r_leaf = Poseidon₂(secret, ν)`, so the same secret that
  proves mixer-set membership also signs the backing BTC UTXO at
  L1. One leaf, two locks.

The reuse is the design: cBTC.zk doesn't introduce its own ZK
primitive. It takes the mixer's `withdraw.circom`, applies it to
slots, and gets trustless self-custody wrapping with no new
ceremony, no new R1CS, no new verifying key.

## Circuit family 2 — amount confidentiality (AMM)

**The primitive:** prove "hidden per-trader / per-LP amounts open
these BabyJubJub Pedersen commitments and satisfy these AMM-
specific constraints against the public pool state."

**The shape:** BJJ Pedersen openings + AMM-specific arithmetic
(at-the-ratio share formula for LP_ADD, proportional withdrawal
for LP_REMOVE, in-circuit clearing-price derivation for
SWAP_BATCH).

**Three sub-circuits, sized to the work each one actually does:**

| Circuit | Opcode | Constraints | What it proves |
|---|---|---|---|
| `amm_lp_add` | `T_LP_ADD` (`0x2D`) | 5,153 | New LP-share commitment opens to the public `share_amount` with hidden blinding. |
| `amm_lp_remove` | `T_LP_REMOVE` (`0x2E`) | 10,369 | Two receipt commitments (asset A leg + asset B leg) open to the declared public deltas. |
| `amm_swap_batch` | `T_SWAP_BATCH` (`0x2F`) | 171,162 (N ≤ 16) | N input + N output BJJ openings; `P_clear` derived in-circuit from private aggregates `(X, Y)` and public deltas; per-trader fill via division-with-remainder against `P_clear`; `min_out` enforcement; range proofs on every amount; tip binding. |

Shared Phase 1 is `pot18` (262K constraint ceiling, sized for the
batch circuit). All three circuits run independent Phase 2 chains
anchored to one shared Bitcoin-block beacon at finalization; see
[`spec/amm/ceremony.md`](./amm/ceremony.md).

**Where each circuit is used:**

- LP_ADD / LP_REMOVE — every liquidity event on every AMM pool,
  including LP shares used as collateral for cBTC.tac (via lien
  on the LP-share UTXO).
- SWAP_BATCH — privacy-mode swaps (hidden per-trader amounts
  with uniform clearing price across the batch). Public-amount
  swaps route through `T_SWAP_VAR` (`0x32`), which uses no
  Groth16 at all — only Pedersen + bulletproof + kernel sig.

## Out-of-circuit primitives both families use

- **Sigma cross-curve binding** (169 B, microseconds, no setup) —
  proves a secp256k1 Pedersen commitment and a BabyJubJub
  Pedersen commitment share the same hidden amount. Used by
  every AMM swap intent/receipt; the standard bridge between
  Bitcoin's commitment layer and the in-circuit BN254 world.
- **BIP-340 Schnorr** — every `intent_sig`, `kernel_sig`, slot
  signature. Microseconds; native secp256k1.
- **secp256k1 Pedersen openings** — every tacit asset UTXO's
  commitment, verified out-of-circuit by the indexer when amounts
  are public (T_DEPOSIT, T_LP_ADD/REMOVE, T_PROTOCOL_FEE_CLAIM).
- **Bulletproofs aggregated range proofs** — used by `CXFER`,
  `T_SWAP_VAR`, `T_AXFER_VAR` where amounts are confidential per
  UTXO but not bound to a uniform-price multi-party proof.

## How the families compose

```
   BTC (Bitcoin L1)
       │
       │  T_SLOT_MINT — anchors backing BTC at K_btc = r_leaf · G
       ▼
   cBTC.zk slot UTXO                   ◄── mixer-circuit family
       │                                   (anonymous unique-spend
       │                                    for slot burn/rotate/
       │                                    split/merge)
       │
       │  T_LP_ADD — mints LP-share of (cBTC.zk, TAC) pool
       ▼
   LP-share UTXO                       ◄── AMM-circuit family
       │                                   (amount confidentiality
       │                                    on share commitments)
       │
       │  T_CBTC_TAC_DEPOSIT — attaches lien on the LP shares,
       │                       mints fungible cBTC.tac
       ▼
   cBTC.tac UTXO                       ◄── composed primitive:
       │                                   cBTC.zk anchor +
       │                                   AMM LP-share lien
       │
       │  CXFER / T_SWAP_VAR / mixer pool deposit
       ▼
   fungible BTC-backed DeFi
```

`T_CBTC_TAC_DEPOSIT_ATOMIC` (`0x57`) splices the LP_ADD and the
cBTC.tac mint into one envelope, so the AMM circuit and the lien
attachment happen in the same atomic step.

## Why this matters

**Both families pay rent across multiple surfaces.** The mixer
circuit is reused for cBTC.zk slot semantics with no
modification; the AMM circuits underpin both AMM trading and the
LP-share collateral substrate that cBTC.tac depends on. The two
families are not parallel "one for mixer, one for AMM" — they
are the protocol's two ZK primitives, picked up wherever the
property each provides is load-bearing.

**The stack stays uniform.** Every circuit verifies against
Groth16 / BN254. Every chain commitment uses secp256k1 Pedersen.
Every cross-boundary binding uses the same 169-byte sigma proof.
A new surface that needs anonymous unique-spend reuses
`withdraw.circom`; one that needs amount confidentiality reuses
the BJJ-Pedersen + sigma-binding pattern. The protocol grows by
applying these two primitives to new opcodes, not by adding new
cryptographic stacks.

**Circuits are tools, not virtue.** Where a property is
checkable from public data (curve arithmetic at a known
pre-state, proportional withdrawal at known reserves), the
indexer checks it out-of-circuit. `T_SWAP_VAR` carries no
Groth16 because variable-amount fills against a known curve
don't need one. Circuits show up where set-membership privacy or
multi-party amount confidentiality demands them, and stay out of
the way elsewhere.

**Indexer consensus is the substrate, not a workaround.** The
Runes/Ordinals trust model — anyone runs an indexer, all reach
the same verdict from chain data alone — already underwrites
real market value at scale. Tacit takes that same substrate and
layers two things on top: cryptographic primitives where they
must be cryptographic (custody of real BTC at L1, amount
confidentiality, anonymous spend), and economic discipline where
indexer-validated value can carry it (cBTC.tac's LP-share lien
mechanism, the protocol-fee insurance sentinel, future
`T_EXCLUSION_CLAIM` slashing). Circuits enable the privacy
properties; indexer consensus + market-validated collateral
enables the smart-contract-shaped properties (AMM,
collateralized wrapping, batched settlement). Neither leg is
federated; neither requires a sidechain or rollup. The
composition is the architecture.

## References

- [`spec/GLOSSARY.md`](./GLOSSARY.md) — term definitions that
  overlap across surfaces (shielded amount vs shielded address;
  leaf vs slot; lien vs bond).
- [`MIXER.md`](../MIXER.md) — mixer architecture; original
  `withdraw.circom` use case.
- [`AMM.md`](../AMM.md) — AMM architecture; three circuit roles
  and the two trader surfaces.
- [`SPEC.md`](../SPEC.md) §3 — cryptographic primitives (curve
  parameters, Poseidon, BJJ NUMS generators, sigma binding).
- [`SPEC.md`](../SPEC.md) §3.8 — mixer withdraw circuit reference.
- [`spec/amm/wire-formats.md`](./amm/wire-formats.md) — AMM
  Groth16 public-input vectors.
- [`spec/amm/ceremony.md`](./amm/ceremony.md) — AMM Phase 2
  ceremony spec.
- [`spec/amendments/SPEC-CBTC-ZK-AMENDMENT.md`](./amendments/SPEC-CBTC-ZK-AMENDMENT.md) —
  cBTC.zk slot wrapper; mixer-circuit reuse.
- [`spec/amendments/SPEC-CBTC-TAC-AMENDMENT.md`](./amendments/SPEC-CBTC-TAC-AMENDMENT.md) —
  cBTC.tac LP-share lien composition.
