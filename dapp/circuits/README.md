# tacit mixer-pool circuits

Forked from [Tornado Cash](https://github.com/tornadocash/tornado-core) (MIT) and
adapted to tacit's SPEC §3.6 / §3.8 / §5.11. See the inline header in
`withdraw.circom` for what changed and why.

## Status

**v1 dev preview.** Compiles, generates proofs, verifies. Soundness against
the inflation-attack vector is closed by the deterministic r_leaf binding
(constraint 4 — see **Soundness note** below). Not yet hooked to
`MIXER_ALLOW_STUB_VERIFY` in the dApp; flip that to `true` after running
`build.sh` and pinning the verifying-key CID into a real `POOL_INIT`.

## Toolchain setup

One-time install:

```sh
# circom 2.1.6+
git clone https://github.com/iden3/circom.git
cd circom && cargo install --path circom

# this directory's deps
cd dapp/circuits
npm install
```

## Build

```sh
npm run build
```

Outputs:

- `artifacts/withdraw.wasm` — witness generator (browser-loadable)
- `artifacts/withdraw_final.zkey` — Groth16 proving key
- `artifacts/verification_key.json` — Groth16 verifying key (pin to IPFS, reference by CID in `POOL_INIT`)
- `artifacts/Verifier.sol` — Solidity verifier (reference / cross-check, not used on Bitcoin)

## Run a sample proof

```sh
npm run prove:sample
```

Builds a tree with 4 random deposits, generates a proof for leaf #2, verifies
it. Writes `artifacts/sample_proof.json`. This is the signal that the
toolchain is wired up correctly.

## Wire format / public inputs

The circuit's public inputs match (in order) what the dApp's
`verifyMixerProof` passes:

| # | Name | Source on chain |
|---|---|---|
| 1 | `root` | `T_WITHDRAW.merkle_root` |
| 2 | `nullifier_hash` | `T_WITHDRAW.nullifier_hash` |
| 3 | `denomination` | `T_WITHDRAW.denomination` |
| 4 | `r_leaf` | `T_WITHDRAW.r_leaf` (32-byte BE) |
| 5 | `bind_hash` | `T_WITHDRAW.bind_hash` |

All values are reduced into BN254's scalar field `Fr` (~254 bits). The dApp
performs the field-injection in `verifyMixerProof`.

## Trusted setup

The build script runs a **single-contributor demo ceremony**. This is fine
for development but **does not provide production soundness** — Groth16's
toxic-waste assumption requires that at least one honest contributor across
the ceremony's contributors discarded their entropy. A single-contributor
ceremony where that contributor knows the entropy can forge proofs.

For a production pool:

1. Run a multi-party Powers-of-Tau Phase 2 ceremony with credible contributor
   diversity (Tornado's reference: 1100+ contributors over a public window).
   `snarkjs zkey contribute` is the per-contributor command; chain
   contributions in sequence.
2. Apply a public beacon (a recent Bitcoin block hash, NIST randomness
   beacon, etc.) to the final `.zkey` via `snarkjs zkey beacon`. This makes
   the final entropy publicly anchored.
3. Pin all intermediate `.zkey` files + the contributor list + the final
   beacon hash to IPFS as the **ceremony transcript**. Any third party
   should be able to verify the chain of contributions.
4. Pin the `verification_key.json` to IPFS. The `POOL_INIT` envelope on chain
   carries `vk_cid` (this verifying key's CID) + `ceremony_cid` (the
   transcript's CID).

## Soundness note

The classic inflation-attack vector ("malicious withdrawer publishes a
recipient_commitment for an amount larger than the pool's denomination") is
closed by the **deterministic r_leaf binding** (constraint 4 in
`withdraw.circom`):

- The circuit forces `r_leaf == poseidon(secret, nullifier_preimage)`.
- The validator does an external secp256k1 Pedersen check:
  `recipient_commitment == denomination · H + r_leaf · G`.

A malicious withdrawer cannot pick `r_leaf` freely (the circuit constrains
it) and cannot pick `recipient_commitment` freely (the validator forces
equality with `denomination · H + r_leaf · G`). Pedersen binding is
computationally infeasible to forge for a fixed `(denomination, r_leaf)`
pair, so the only opening of the on-chain commitment is `(denomination,
r_leaf)` — exactly the pool's denomination, no more.

**Equivalent guarantee to an in-circuit secp256k1 multi-scalar mult, at
~100× lower constraint cost.** The naïve "compute denomination·H + r·G
in-circuit on secp256k1" approach would balloon the circuit to ~300k
constraints (dominated by two non-native scalar mults). The deterministic
r_leaf approach achieves the same soundness with the same Pedersen check
moved off-circuit, where the validator already has secp256k1 primitives
from the rest of tacit.

**Trade:** `r_leaf` is published in cleartext on chain. This is the same
privacy posture as T_PMINT (`(amount, blinding)` are public). It does NOT
leak which deposit a withdraw corresponds to — `r_leaf = poseidon(secret,
ν)` is one-way, and an observer cannot match `r_leaf` to a deposit's leaf
`poseidon(secret, ν, denom)` without inverting Poseidon.

## File map

```
circuits/
├── withdraw.circom        — main withdrawal circuit (Tornado fork + adaptations)
├── merkleTree.circom      — Poseidon-hash merkle inclusion proof
├── prove-sample.mjs       — sample prover: build tree, prove, verify
├── build.sh               — circom compile + Groth16 setup + vk export
├── package.json
└── README.md              — this file
```
