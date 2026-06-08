# SPEC — The Confidential Pool (Tacit's privacy primitive)

> **STATUS: DRAFT** (2026-06-08). The canonical privacy primitive the whole protocol
> hangs off of: a **confidential, multi-asset, cross-chain shielded pool**. One design
> on both surfaces — Bitcoin and Ethereum — unified by the cross-lane gate (platinum).
>
> This **supersedes and unifies** three earlier, separate constructions:
> - the **Tornado-style mixer** (`T_DEPOSIT`/`T_WITHDRAW`, Poseidon-Merkle + Groth16) —
>   its *anonymous-spend* (address-link unshielding) property is a property the pool has
>   **by construction** (§4), at a larger anonymity set and with amount privacy too;
> - the **Tier-A denominated confidential-token factory** — the pool's arbitrary-amount
>   notes make a denomination ladder unnecessary;
> - the **standalone tETH bridge** (separate mixer + relay) — tETH is just a pool asset,
>   moved cross-chain by `bridge_mint`/`bridge_burn` (§6) like any other.
>
> Companions: `SPEC-CXFER-BPP-AMENDMENT.md` (the Bitcoin transfer envelope + BP+ range),
> `SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md` (the Ethereum instance + ERC20 hub),
> `SPEC-BITCOIN-REFLECTION-AMENDMENT.md` (the cross-lane reflection prover),
> `ops/PLAN-confidential-cross-chain.md` (the cross-chain model). Implementation:
> `contracts/src/ConfidentialPool.sol`, `contracts/sp1/confidential/` (the SP1 guest +
> `cxfer-core`).

## 1. One primitive, two properties

A confidential pool is a set of **notes**. A note is a hidden amount owned by a key.
The pool gives both privacy properties in a single object:

- **Amount privacy** — a note's value is a Pedersen commitment; only its owner knows it.
- **Unlinkability (address-link shielding)** — a spend proves the note exists without
  revealing *which* note, so a deposit and its later spend are unlinkable.

Tacit assets — TAC, tETH, cBTC, cUSD — are **assets in the pool**, not bespoke
subsystems. "Shield my TAC against address linking" and "send hidden-amount TAC" are the
same operation on the same object.

## 2. The note

A note is `(asset_id, C, owner, secret)` where the **commitment** is a secp256k1
Pedersen commitment

```
C = v·H + r·G ,   v ∈ [0, 2⁶⁴) ,   H = NUMS(sha256("tacit-generator-H-v1"))
```

`v` is the value, `r` the blinding, `G` the secp generator. The same curve and the same
`H` are used on Bitcoin and Ethereum — this is what lets **one note live on both chains**
(no BN254 system can: it requires the same curve on both surfaces).

Derived, deterministic identifiers (one keccak scheme, both chains):

| | definition | role |
|---|---|---|
| **leaf** | `keccak(asset_id ‖ Cx ‖ Cy)` | the commitment-tree leaf (public) |
| **nullifier ν** | `keccak(Cx ‖ Cy ‖ "spent")` | the spend marker (public on spend) |

The nullifier is **note-bound** (a function of the commitment, not a free secret), so a
note has exactly one ν, and **chain-independent**, so the *same* note yields the *same* ν
on both surfaces — the identifier both chains agree is spent. The leaf is **owner-free**:
the owner/recipient is recovery metadata carried in the note's encrypted memo, not in the
leaf, because the cross-lane reflection prover is a public prover that cannot know a
private owner (see `SPEC-BITCOIN-REFLECTION-AMENDMENT.md` §7.1). Spend authorization is
opening-secrecy (`v`, `r`), which `owner` never gated.

## 3. The pool state

- **Commitment tree** — a depth-32 Keccak incremental Merkle tree of leaves. New notes
  append; the root is the membership anchor.
- **Nullifier set** — the set of spent ν. A ν may enter once, ever.
- **Per-asset backing** — each asset's escrow (Ethereum) / supply (Bitcoin) ≥ the value
  of its unspent notes. Boundary effects speak the note's **in-system value `v`**; a
  deployment scales to underlying units by the asset's trusted `unitScale`
  (`v·unitScale`), so an 8-decimal Bitcoin asset and an 18-decimal ERC20 are the same
  note.

## 4. Validity (the SP1 guest) and the privacy properties

Every state transition is one **SP1 proof** (one universal verifier, no per-feature
ceremony). The guest enforces, per operation:

- **Membership** — each spent note's leaf is in the tree (`keccak_merkle_verify`), the
  leaf index + path are **private** → the spend is **unlinkable** to its deposit.
- **Range** — each output value ∈ `[0, 2⁶⁴)` via an aggregated Bulletproofs+ proof → no
  negative/overflow value is created.
- **Conservation** — Σ input value = Σ output value per asset (a Mimblewimble-style
  kernel: `verify_kernel` on Ethereum, a BIP-340 `kernel_sig` on Bitcoin) → no value is
  minted.
- **Opening** — public boundary notes open to their stated value (`verify_pedersen_opening`).

Unlinkability is therefore not a separate mixer — it is the membership proof hiding the
spent leaf. Amount privacy is the Pedersen commitment + range proof. **One circuit, both
properties.** The anonymity set is *every note of the asset* (amounts are hidden, so the
set is not denomination-partitioned) — strictly larger than a Tornado denomination pool.

## 5. Operations

| op | effect |
|---|---|
| **wrap** | public deposit → a new note (escrow the underlying; bind a deposit id to `v`) |
| **transfer** | n notes → m notes, hidden amounts (membership + range + conservation) |
| **unwrap** | a note → a public payout (`v·unitScale` of the underlying) |
| **bridge_burn** | a note → a `cross_out` record destined for the other chain (§6) |
| **bridge_mint** | a confirmed burn on the other chain → a new note here (§6) |

A swap is a multi-asset `transfer` (per-asset conservation already holds), so OTC and
pooled-AMM swaps compose from the same ops.

## 6. Cross-chain — one note, Bitcoin *or* Ethereum (platinum)

A note is spendable on Bitcoin **or** Ethereum, exactly once ever, with the origin
hidden in the strongest form. The chain-independent ν is the linchpin: both surfaces
agree a note is spent iff its ν is consumed.

- **Same-chain spends** settle on their own chain's nullifier set, fast and sovereign.
- **Cross-lane** (improved platinum, asymmetric): Bitcoin is the canonical nullifier set
  and sole arbiter; Ethereum is a fast provisional cache. A Bitcoin-homed note fast-spent
  on Ethereum proves **non-membership** of its ν against the *reflected Bitcoin spent
  set* (a relay-attested IMT root), so a note already spent on Bitcoin cannot be
  re-spent on Ethereum. The reflection is a **trustless data relay** — an SP1 prover
  (`SPEC-BITCOIN-REFLECTION-AMENDMENT.md`) anchored to the live `BitcoinLightRelay` — not
  a capital/liquidity relayer; no third party learns an amount.
- **`bridge_mint`/`bridge_burn`** move value between the chains at the note level: burn on
  the source (nullify), mint on the destination gated one-per-`claimId`, value carried
  verbatim. tETH is the flagship two-sided asset; any two-sided asset crosses.

The cross-lane gate **fails closed**: a Bitcoin-homed spend must pin the *current,
non-zero* reflected spent-set root (an empty set has a non-zero empty-IMT sentinel), or
it reverts.

## 7. Two surfaces, one note (the model bridge)

The surfaces represent a note differently, and the reflection prover translates:

| | Bitcoin | Ethereum |
|---|---|---|
| note | a pool **UTXO** (`txid:vout`), commitment in the output | a **leaf** in the commitment tree |
| spend | consume the input UTXO | reveal ν, mark the nullifier set |
| conservation | BIP-340 `kernel_sig` | in-guest `verify_kernel` |

The reflection prover folds Bitcoin outputs → reflected leaves and Bitcoin inputs
(resolved to their commitment via the UTXO set) → the shared ν, committing
`(bitcoinPoolRoot, bitcoinSpentRoot, height)` that the Ethereum pool's gate consumes.

## 8. The asset layer

- **Asset id** identifies an asset across both chains. A two-sided asset is backed on its
  canonical chain; notes on the other chain are claims (`bridge_mint`/`bridge_burn`
  convert between directly-backed and claim notes without changing total backing).
- **Ethereum public face** — every Tacit asset has a canonical ERC20 at a deterministic
  address `f(asset_id)` (`CanonicalAssetFactory` / `CanonicalBridgedERC20`); the pool is
  its sole minter (mint on unwrap, burn on wrap). This is the Uniswap-tradeable face of a
  confidential balance.

## 9. What this subsumes (clean-launch consolidation)

Nothing is in production yet, so there is no backward compatibility to preserve. The
unified pool replaces:

- the **Poseidon/Groth16 mixer** (`T_DEPOSIT`/`T_WITHDRAW`, `SP1PoolRootVerifier`
  reflecting it) — its anonymous-spend property is §4 here, with amount privacy and a
  larger anonymity set; one SP1 circuit instead of a bespoke Groth16 + Poseidon stack +
  its ceremony;
- the **Tier-A denominated confidential-token factory** — arbitrary amounts make the
  ladder unnecessary;
- the **standalone tETH mixer bridge** — tETH is a pool asset (§6, §8).

The one trade-off retired with the mixer: a denominated pool is cheaper (membership-only,
no range proofs). For a single clean launch, one pool that does unlinkability + amounts +
cross-chain is the better surface than two circuits and two ceremonies.

## 10. Status of the pieces

Built + tested (`contracts/`, `cxfer-core` native KATs + on-chain proof): the pool
contract, the SP1 guest (wrap/transfer/unwrap/bridge_burn/bridge_mint + the cross-lane
gate), the secp/keccak/BP+/kernel core, the reflection prover's in-zkVM toolkit
(accumulators + fold + Bitcoin confirmation + the Bitcoin kernel verification), the
canonical ERC20 hub. Remaining for full cross-lane: the reflection prover binary + box
prove → its vkey, the relay-anchor contract binding, and the leaf-owner harmonization
(drop `owner` from the EVM leaf at the guest freeze, per §2). See
`ops/RUNBOOK-confidential-pool-deploy.md`.
