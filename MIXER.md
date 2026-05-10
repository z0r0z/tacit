# tacit mixer — approach

> A **Runes-style indexer-validated meta-protocol** that adds **confidential
> amounts (Pedersen)** and a **Tornado-style shielded pool (Groth16 +
> nullifiers)** — all anchored to Bitcoin L1 data availability. No bridges,
> no sidechains, no federation. The cryptographic primitives are
> well-established; the *composition* of these three specific things on
> Bitcoin L1 has no live production peer that we know of.

This document is a short positioning + architecture summary. The normative
spec lives in [`SPEC.md` §5.10–§5.11 and §11](./SPEC.md).

## What it is

A privacy layer for **tacit-native confidential assets**. Users deposit a
fixed-denomination asset UTXO into a per-`(asset_id, denomination)` pool;
later, anyone holding the mixer note — `(secret, ν)` — can withdraw to a
fresh address with a zero-knowledge proof that breaks the on-chain link
to the deposit.

The on-chain footprint is two new envelope opcodes — `T_DEPOSIT` (`0x29`)
and `T_WITHDRAW` (`0x2A`) — riding on regular Bitcoin commit + reveal taproot
transactions. Bitcoin nodes don't interpret the envelopes; indexers
(reference: tacit's worker + every dapp client) reconstruct pool state from
chain alone and enforce the protocol's rules client-side.

### At a glance

```
  WITHOUT MIXER                          WITH TACIT MIXER

  Alice                                  Alice ──┐
    │                                            │  deposit
    │  transfer                                  ▼
    ▼                                  ┌─────────────────────────┐
  Bob                                  │   POOL                  │
                                       │                         │
                                       │   ●  ●  ●  ●  ●  ●  ●   │
  observer sees:                       │   opaque deposit slips  │
  Alice ───→ Bob                       │   (all look identical)  │
  (clearly linked)                     │                         │
                                       │   ●  ●  ●  ●  ●  ●  ●   │
                                       └─────────────────────────┘
                                                 ▲
                                                 │  withdraw +
                                                 │  zero-knowledge proof
                                                 │
                                                Bob

                                       observer sees:
                                         Alice deposited (somewhere)
                                         Bob withdrew (somewhere)
                                         ✗ no link between them
```

That's the whole idea. Bitcoin carries the deposit slips and the withdraw
proofs as opaque taproot envelope data; indexers reconstruct the pool;
zero-knowledge cryptography makes the deposit→withdraw link unprovable
even though everything is on a public chain.

## What it is not

- **Not a native-BTC mixer.** The pool key is `(asset_id, denomination)` where
  `asset_id` is a tacit token's identifier. Native sats don't have an
  `asset_id`. To mix BTC value, BTC must first be wrapped into a tacit asset,
  and that wrapping step has its own trust model (single-issuer wBTC,
  federated mint, sidechain peg) independent of the mixer.
- **Not novel cryptography.** The circuit (Tornado-derived, Poseidon merkle
  tree + Groth16), the curve (BN254 / alt_bn128), the commitment scheme
  (secp256k1 Pedersen), the meta-protocol pattern (Runes / Ordinals indexer
  validation), and the taproot envelope wire format are all prior art. The
  contribution is in composition + shipping.
- **Not an L2.** Pool state is reconstructed from confirmed Bitcoin
  transactions; no sidechain, no bridge, no federation operates the pool.

## How it works (architectural)

Tornado Cash on Ethereum is a smart contract: deposit slips live in
contract storage, the SNARK verifier is an EVM opcode, conditional payouts
are EVM transfers. Bitcoin has none of those. Each Tornado-required
function maps to a different layer in tacit:

| Tornado needs | On Ethereum | In tacit |
|---|---|---|
| Place to publish deposit slips | Contract storage | Taproot envelope payload (`T_DEPOSIT`) |
| Per-pool merkle tree of deposits | EVM-computed, contract-stored | Reconstructed by indexers from chain in canonical `(height, tx_index, txid)` order |
| SNARK verifier | EVM opcode | snarkjs in the dapp browser; indexer optional cross-check |
| Conditional payout (only if proof valid) | EVM transfer | Fresh tacit UTXO whose ownership is asserted by indexer rules; an invalid proof's UTXO is never credited as spendable |

Why it composes: every primitive a Tornado-style mixer needs was already
shipped in tacit for non-mixer flows. Pedersen
amount commitments were already there for `CXFER`. Taproot envelope
payloads were already the wire format for every tacit operation. Indexer-
validated rules are how tacit's whole protocol works. Asset-level identity
(`asset_id` = sha256 of an etch tx) was already there. The mixer adds two
envelope opcodes and a Groth16 circuit; everything else recombines existing
machinery.

### Cryptographic flow (deposit → withdraw)

```
┌─── ALICE (depositor) ──────────────┐  ┌─── BOB (withdrawer) ─────────────────────────┐
│                                    │  │                                              │
│  secret, ν  ← random 32 B each     │  │  secret, ν  (shared out-of-band by Alice)    │
│      │                             │  │      │                                       │
│      ▼                             │  │      ▼                                       │
│  leaf = Poseidon₃(s, ν, denom)     │  │  r_leaf         = Poseidon₂(s, ν)            │
│      │       (BN254 field)         │  │  nullifier_hash = Poseidon₁(ν)               │
│      ▼                             │  │  recipient_commit = denom·H + r_leaf·G       │
│  T_DEPOSIT envelope                │  │      │             (Pedersen / secp256k1)    │
│  (taproot script-path)             │  │      ▼                                       │
│      │                             │  │  merkle proof against pool root              │
│      │ consumes Alice's            │  │      │  (Poseidon merkle tree, depth 20)     │
│      │ asset UTXO via              │  │      ▼                                       │
│      │ BIP-340 Schnorr             │  │  Groth16.prove(witness, zkey)                │
│      │ kernel signature            │  │      │  (BN254 / alt_bn128, snarkjs)         │
│      ▼                             │  │      ▼                                       │
└──── broadcast to Bitcoin ──────────┘  │  bind_hash = SHA-256("tacit-withdraw-bind-v1"│
                                        │      │      ‖ asset_id ‖ denom_LE            │
                                        │      │      ‖ nullifier_hash                 │
                                        │      │      ‖ recipient_commit ‖ r_leaf)     │
                                        │      ▼                                       │
                                        │  T_WITHDRAW envelope (taproot script-path)   │
                                        │      │  recipient = Bob's P2WPKH at vout[0]  │
                                        └──── broadcast to Bitcoin ────────────────────┘
                                                       │
                ┌──────────────────────────────────────┴──────────────────────────────┐
                ▼                                                                     ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │                                BITCOIN L1                                           │
   │                                                                                     │
   │   • orders transactions in blocks                                                   │
   │   • carries envelope payloads in taproot witness (BIP-341 script-path)              │
   │   • verifies BIP-340 Schnorr signatures on tx inputs                                │
   │   • does NOT interpret envelope contents                                            │
   └────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            │  indexers scan in canonical
                                            │  (height, tx_index, txid) order
                                            ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │              CONFORMING VERIFIER  (dapp client — authoritative for spend)           │
   │              Reference worker performs 1–4, 6; Groth16 (5) is dapp-side             │
   │              (three-verifier model — SPEC §5.11.4)                                  │
   │                                                                                     │
   │   T_DEPOSIT path:                                                                   │
   │     • append Poseidon₃(s, ν, denom) to per-(asset_id, denom) pool tree              │
   │     • only at depth ≥ 3 (MIXER_DEPOSIT_CONFIRMATION_DEPTH — reorg-safety gate)     │
   │     • root recorded in 32-deep ring buffer (POOL_RECENT_ROOTS_WINDOW)               │
   │                                                                                     │
   │   T_WITHDRAW path: REJECT unless ALL six hold —                                     │
   │     1. pool registered for (asset_id, denomination)                                 │
   │     2. claimed merkle_root ∈ recent-roots window                                    │
   │     3. nullifier_hash ∉ spent-set for this pool                                     │
   │     4. SHA-256(domain ‖ … ‖ r_leaf) == envelope.bind_hash                           │
   │     5. snarkjs.groth16.verify(vk, [root, nullifier_hash, denom, r_leaf,             │
   │                                    bind_hash], proof)         ← dapp-authoritative  │
   │     6. denom·H + r_leaf·G == recipient_commit (Pedersen on secp256k1)               │
   │                                                                                     │
   │   → on accept: credit Bob's UTXO at vout[0] as a spendable tacit asset opening      │
   │     to (denom, r_leaf). Insert nullifier_hash into the spent-set.                   │
   └─────────────────────────────────────────────────────────────────────────────────────┘
```

**Cryptographic primitives, by where they're used**

| Primitive | Curve / Field | Where in the flow |
|---|---|---|
| **Poseidon** (Grassi et al. 2020; circomlib parametrization, BN254 Fr; capacity 1, rate = arity) | BN254 scalar field (Fr) | Leaf commitment (arity-3); nullifier hash (arity-1); merkle inner nodes (arity-2); `r_leaf` derivation (arity-2) |
| **Groth16** (zk-SNARK) | BN254 / alt_bn128 G1 + G2 + pairing | Withdraw proof of membership + nullifier consistency + `r_leaf` binding |
| **Pedersen commitment** (additively homomorphic) | secp256k1 (G + NUMS H) | `recipient_commit = denom·H + r_leaf·G`; validator checks the opening externally |
| **SHA-256** (domain-separated) | n/a | `bind_hash` over the public input tuple — squared into the proof's polynomial system to bind `recipient_commit` and defeat substitution attacks |
| **BIP-340 Schnorr** | secp256k1 | Kernel signature on `T_DEPOSIT` consume; envelope-script taproot script-path signature |
| **BIP-341 Taproot** | secp256k1 + tweaked output keys | Commit + reveal carrier txs; envelope payload sits in the script-path witness |

`H` is a NUMS generator with no known discrete log w.r.t. `G`, derived
deterministically by hash-to-curve from the seed `tacit-generator-H-v1`
(SPEC §3.1). Pedersen binding is computationally infeasible to forge for
fixed `(denom, r_leaf)`, which is what closes the inflation-attack vector
when paired with the circuit's `r_leaf == Poseidon₂(s, ν)` constraint
(SPEC §3.8 / §5.11.1).

## Trust model

**Soundness** (= "is the rule enforced correctly when used?") is **trustless
under standard cryptographic assumptions**:

- Groth16 proof verifies under the published `vk` regardless of who runs the
  verifier; the dapp re-runs verification client-side.
- Merkle tree reconstruction is byte-deterministic from chain. Every indexer
  arrives at the same root.
- Nullifier set is content-addressable. Worker, dapp, third-party indexers
  arrive at the same spent-set if they enforce the same rejection-path
  determinism (SPEC §11).
- Pedersen commitments are publicly checkable.

The reference worker can DoS users (refuse to respond) but cannot cheat
them. Anyone can run their own indexer from chain data alone.

**Liveness** (= "can you use the system at all?") depends on at least one
working indexer + an IPFS gateway. The reference worker is one such
indexer; the dapp's `WORKER_BASE` constant points at it. Switching to
self-hosted is a one-line edit. All on-chain state is reproducible from
Bitcoin alone.

## Privacy model

- **Cryptographic unlinkability** follows from Groth16's zero-knowledge
  property and the hiding/binding assumptions of the commitment + hash
  construction; trusted setup affects soundness, not privacy (SPEC §5.11.3).
  An observer reading on-chain `T_WITHDRAW` envelopes learns no information
  about which deposit funded which withdraw, beyond the count of currently-
  unspent leaves in the pool.
- **Operational privacy** depends on three things outside the protocol's
  control: anonymity-set size (live count surfaced in the dapp), Bitcoin-
  level fee linkage (pay-to-other has no chain-graph link to the depositor;
  self-mix requires a fresh BTC wallet OR a relayer), and network-level
  correlation (Tor + timing discipline).

Full threat model + the five-invariant table + three-verifier model in
SPEC §5.11.4. Post-withdraw privacy via CXFER chaining in §5.11.5.

## What's novel here

The novelty is the **composition**, not any single piece. Each piece is
prior art and we concede that immediately:

- **Pedersen on Bitcoin envelopes**: not new (MimbleWimble 2016, RGB,
  tacit's own pre-mixer CXFER flow).
- **Groth16 mixers**: not new (Tornado Cash 2019, Aztec, Penumbra, Railgun).
- **Indexer-validated meta-protocols on Bitcoin**: not new (Ordinals 2023,
  BRC-20, Runes, STAMPS, Alkanes, OP_NET).

The claim — narrower and harder to attack than "novel cryptography" or
"first mixer" — is that **these three specific things composed together on
Bitcoin L1** don't have a live production peer:

- Indexer-validated Bitcoin meta-protocols so far have been **transparent**
  (Runes, BRC-20, Ordinals, STAMPS, Alkanes, OP_NET all show amounts in the
  clear). No confidential layer to graft a mixer onto.
- Privacy on Bitcoin so far has come from CoinJoin variants (Wasabi,
  Whirlpool, JoinMarket — cooperative-spend, no anonymity set growing over
  time, no zero-knowledge), or from leaving L1 entirely (Liquid federation,
  Cashu / Fedimint mints, Lightning channels, sidechain rollups).
- Other zk-mixers (Aztec, Penumbra, Railgun) live on Ethereum / Cosmos /
  their own L1, not Bitcoin.
- Bitcoin sidechains and rollups (Citrea, Botanix, Alpen, BOB) can host
  Tornado-style mixers but execute off-chain with L1 verification — not
  indexer-validated meta-protocols on L1.

The achievement is the assembly: shipping a working integration on Bitcoin
L1 with closed soundness gates, indexer-determinism guarantees, browser-
side proof generation + verification, and a coordinated Phase 2 ceremony
pipeline.

### Adjacent designs reviewers will bring up

When this hits an informed audience, expect these three to come up. Each
is real and adjacent, none is the same composition:

- **Citrea, BitVM, BitVMX, Strudel, Alpen.** Bitcoin rollups / optimistic
  SNARK-verification proposals. Different category: *off-chain execution
  with L1 dispute resolution*, not indexer-validated meta-protocols. A
  Tornado-style mixer can be (and likely will be) built on these, but it
  inherits the rollup's trust model (challenge-game operator set, fraud
  proofs, BitVM's 1-of-n assumption). Tacit's mixer doesn't need any of
  that — it reads from L1 envelope data and computes the answer
  deterministically.
- **Ark, Spark, Lava.** Shared off-chain UTXO pools with periodic L1
  settlements. Provide some privacy properties via UTXO virtualization,
  but require an Ark Service Provider (ASP) federation; not L1, not
  trustless. Different mechanism (off-chain virtual UTXOs with a
  coordinator), not zero-knowledge anonymity sets.
- **Taproot Assets (Lightning Labs).** Currently transparent — same shape
  as Runes for amount disclosure. Research on adding confidentiality
  exists but isn't shipped. If/when Taproot Assets ships a confidential
  amount layer + a mixer on top, that would be a direct peer to this
  composition.

## What's not novel

- The Tornado Cash circuit design (Pedersen leaves + merkle tree + Groth16
  unlinkability + nullifier set) is from 2019. tacit's `withdraw.circom`
  adapts it.
- Indexer-validated meta-protocols on Bitcoin (Runes, BRC-20, Ordinals,
  STAMPS, OP_NET, Alkanes) are well-established 2023–2026 design space.
- Confidential amounts via Pedersen + Bulletproofs trace to Maxwell's CT
  proposal (2015), MimbleWimble (2016), and Liquid (mainnet 2018).
- Taproot envelope binary payloads are Ordinals (2023).
- The conceptual idea of Tornado-on-Bitcoin via meta-protocol has been
  discussed in cypherpunk and crypto-research circles for years.

## Differences from Tornado Cash's circuit

Three deliberate divergences (SPEC §3.8):

1. **Leaf includes denomination.** `leaf = poseidon(secret, ν, denom)` —
   one circuit serves all pool sizes; denomination is a public input.
2. **Poseidon nullifier hash.** `nullifier_hash = poseidon(ν)` — replaces
   Tornado's Pedersen-on-Baby-Jubjub with the same single-arity Poseidon
   already used for the leaf. Smaller circuit.
3. **Deterministic `r_leaf` binding + external Pedersen check.** The circuit
   constrains `r_leaf == poseidon(secret, ν)` and exposes it as a public
   input; the validator separately checks
   `pedersenCommit(denomination, r_leaf) == recipient_commitment` outside
   the circuit on secp256k1. Together they close the inflation-attack
   vector at ~100× lower in-circuit cost than an in-circuit secp256k1
   multi-scalar multiplication.

Plus a `bind_hash` covering all public inputs, squared into the constraint
system to defeat proof-substitution attacks (SPEC §5.11.4).

## Trusted setup

- **Phase 1 (Powers of Tau)**: the Polygon Hermez ceremony's pot14 file
  (~71 contributors, Bitcoin-block-hash beacon, 2020–2022). `dapp/circuits/
  build.sh` downloads + dual-hash-checks the file (SHA256 + BLAKE2b
  matching the snarkjs README); refuses to proceed on mismatch.
- **Phase 2 (per-circuit)**: coordinator endpoints (`/ceremony/init`,
  `/ceremony/:circuit_hash/contribute`, `/ceremony/:circuit_hash/finalize`)
  are shipped, behind admin-auth for init + finalize. The contribute
  endpoint was publicly reachable during the contribution window;
  client-side `verifyFromInit` walked the contribution chain + content-
  checked IPFS-fetched r1cs/ptau before accepting any contribution to
  extend. For the live circuit, the contribute endpoint now returns HTTP
  409 (`ceremony has been finalized; chain is locked`) — the chain is
  immutable.
- **Beacon finalization**: applied a public-randomness beacon (Bitcoin
  block 948824 hash, 10 MiMC iterations) at the end of the contribution
  window — closes the late-Sybil collusion window per SPEC §5.11.3. The
  finalize coordinator script cross-checks the block hash against
  mempool.space and blockstream.info before applying the beacon and
  refuses to finalize if confirmation depth is < 12 blocks.

## Status

- ✅ Wire format + envelope opcodes (`T_DEPOSIT`, `T_WITHDRAW`)
- ✅ Worker indexing + KV state (per-pool init, leaves, nullifiers)
- ✅ Browser-side Groth16 prover + verifier (snarkjs vendored)
- ✅ Deposit + withdraw broadcast flows
- ✅ Indexer rejection-path determinism (worker `bind_hash` recompute matches
  dapp; SPEC §11 normative)
- ✅ Reorg safety (`MIXER_DEPOSIT_CONFIRMATION_DEPTH = 3` gate)
- ✅ Recent-roots ring buffer (`POOL_RECENT_ROOTS_WINDOW = 32`)
- ✅ Anonymity-set warning UI in withdraw confirm
- ✅ Privacy-hygiene UX nudges (self-mix vs pay-to-other detection)
- ✅ Deposit auto-split for non-exact denominations
- ✅ Deposit-record export / import
- ✅ vk content-hash check against IPFS CID
- ✅ Phase 1 ptau swapped to verified Hermez ceremony
- ✅ Phase 2 ceremony coordinator (init / contribute / finalize) + auth
- ✅ Client-side `verifyFromInit` before contribute
- ✅ 108 mixer tests across 7 test files
- ✅ **Phase 2 ceremony finalized** — 2,227 community contributions +
  Bitcoin-block-948824 beacon (10 MiMC iterations). Canonical bundle
  pinned to IPFS as a directory under
  `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u`;
  contains `withdraw_final.zkey`, `verification_key.json`,
  `withdraw_pre_beacon.zkey`, `withdraw.r1cs`, `pot14_final.ptau`, and
  the full 21,931-record attestation chain (2,229 canonical: genesis +
  2,227 contribs + beacon). Dapp hardcodes the bundle CID as
  `CANONICAL_CEREMONY_CID` so every pool init binds to the same trust
  anchor — operator typo is impossible.
- ⏸ Deterministic `(secret, ν)` derivation from privkey (UX improvement;
  current behavior matches Tornado / Privacy Pools — secrets must be
  backed up out-of-band)

## Open / honest caveats

- **Ceremony trust anchor.** The Phase 2 ceremony finalized at 2,227
  contributions with a Bitcoin-block beacon — ~2× Tornado.cash's
  Phase 2 (1,114 contributors), with a public-randomness final round
  that closes the late-Sybil window per SPEC §5.11.3. Pool soundness
  holds as long as ≥1 of those contributors was honest. Contributor
  diversity is openly observable — the chain-walk in the bundle's
  `attestations.json` shows every contributor name + Bitcoin block hash
  the contribution committed to. Any party who finds a sole-honest
  participant in the chain can re-derive the security claim.
- **Anonymity-set strength scales with per-pool volume.** A pool that sees
  40 deposits a year is structurally sound but practically not private.
  The dapp surfaces a warning; users should heed it.
- **Mixer mixes tacit assets.** Native BTC mixing requires wrapping into a
  tacit asset, and that wrapping step is a separate trust assumption.
- **Operational privacy is user-discipline-dependent for self-mix.**
  Pay-to-someone-else has no chain-graph link between depositor and
  recipient; self-mix requires a fresh wallet for the withdraw OR a relayer
  to break the BTC fee-source chain-graph link.
- **Indexer-validated, not Bitcoin-consensus-enforced.** Same trust model
  as Runes / Ordinals — well-established, but readers should understand it.
- **Mixer notes are minted in your browser.** `(secret, ν)` are 32 CSPRNG
  bytes drawn locally; the reference dapp keeps them local and ships no
  network call carrying them. Same property as Tornado's UI and every
  browser-side mixer: whichever bytes mint the note are in the trust path,
  so load from a pinned IPFS CID you've verified (or self-host) and
  you're running audited bytes rather than a fork or typo-squat.

## Defensible one-paragraph summary

> A Runes-style indexer-validated meta-protocol on Bitcoin L1 that adds
> confidential amounts (Pedersen commitments) and a Tornado-style shielded
> pool (Groth16 + nullifiers + Poseidon merkle tree). No bridges, no
> sidechains, no federation — pool state is reconstructed from L1 envelope
> data; proofs are verified client-side. The cryptographic primitives are
> well-known; the *composition* of these three specific things on Bitcoin
> L1 doesn't appear to have a live production peer. Phase 1 trusted setup
> is the verified Polygon Hermez ceremony output; Phase 2 is finalized
> with 2,227 community contributions and a Bitcoin-block beacon, pinned
> to IPFS at
> `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u`.
> Engineering and integration achievement, not cryptographic invention.

## References

- SPEC: [`SPEC.md`](./SPEC.md) — normative
- Tornado Cash whitepaper: <https://tornado.cash/Tornado.pdf>
- Powers of Tau (Polygon Hermez): <https://github.com/iden3/snarkjs#7-prepare-phase-2>
- Indexer-validated meta-protocol pattern: <https://docs.ordinals.com/>
- BIP-340 / 341 (Schnorr / Taproot): the BIPs themselves
