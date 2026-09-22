# Tacit Groth16 circuits

Circom sources, build scripts and ceremony tooling for the two Groth16 circuit sets Tacit uses. Most of
Tacit needs no trusted setup; see [SPEC §2.8](../../SPEC.md#28-circuits-and-ceremonies) for where these
keys are used.

- **AMM** (`amm/`): `amm_swap_batch`, `amm_lp_add`, `amm_lp_remove`. The `amm_swap_batch` verifying key
  is compiled into the settle guest (`OP_SWAP_BLIND`, SPEC §5.6) and the Bitcoin reflection guest
  (`T_SWAP_BATCH`, SPEC §3.5).
- **Mixer** (`withdraw.circom`, `merkleTree.circom`): the legacy fixed-denomination Bitcoin mixer
  (`T_DEPOSIT` / `T_WITHDRAW`, SPEC §3.8). Derived from
  [Tornado Cash](https://github.com/tornadocash/tornado-core) (MIT); see the header in `withdraw.circom`.

Both Phase-2 ceremonies are finalized. The build scripts' single-contributor zkeys are for local
development only; the dapp uses the ceremony keys, pinned by CID and hash in `dapp/tacit.js`
(`CANONICAL_CEREMONY_CID`, `CANONICAL_VK_CID`, `CANONICAL_VK_SHA256`, `CANONICAL_AMM_VK_CID`). Every finalized
zkey, verifying key and witness generator is listed with its CID and hash in
[`docs/CEREMONY.md`](../../docs/CEREMONY.md).

## Toolchain

```sh
# circom 2.1.6+
git clone https://github.com/iden3/circom.git
cd circom && cargo install --path circom

# this directory's deps
cd dapp/circuits
npm install
```

## Build and sample proof

```sh
npm run build          # mixer: compile, dev Groth16 setup, vk export → artifacts/
npm run prove:sample   # 4-deposit tree, prove leaf #2, verify → artifacts/sample_proof.json
bash amm/build.sh      # AMM: compile the three circuits → amm/build/, check constraint budgets
```

`amm/witness-test.mjs`, `amm/adversarial-test.mjs`, `amm/drift-guard.test.mjs` and the
`amm/dev-zkey/` round-trip tests exercise the AMM circuits against the JS reference builders.

## Mixer public inputs

In order, as the dapp's `verifyMixerProof` passes them. All values are reduced into BN254's scalar field.

| # | Name | Source on chain |
|---|---|---|
| 1 | `root` | `T_WITHDRAW.merkle_root` |
| 2 | `nullifier_hash` | `T_WITHDRAW.nullifier_hash` |
| 3 | `denomination` | `T_WITHDRAW.denomination` |
| 4 | `r_leaf` | `T_WITHDRAW.r_leaf` (32-byte BE) |
| 5 | `bind_hash` | `T_WITHDRAW.bind_hash` |

## Mixer ceremony

2,227 contributions plus a Bitcoin-block-948824 beacon (10 MiMC iterations).

| Artifact | IPFS CID |
|---|---|
| Ceremony bundle (zkey + attestation chain) | `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u` |
| Verifying key (`verification_key.json`) | `bafkreidwbautgstcnl54oszez7yqlc7mr5lrj6ac65h3p5sjw2rgz2jtv4` |

Groth16 needs at least one honest contributor to have discarded their entropy. Anyone can walk the
bundle's `attestations.json` via `prev_cid` from the beacon back to genesis and check that each
contribution's CID content-addresses the previous zkey. The bundle is in `ceremony-bundle/`.

## Mixer soundness: the r_leaf binding

A withdrawal's recipient commitment opens to exactly the pool denomination:

- The circuit forces `r_leaf == poseidon(secret, nullifier_preimage)` (constraint 4 in `withdraw.circom`).
- The validator checks, outside the circuit, `recipient_commitment == denomination · H + r_leaf · G` on
  secp256k1.

Since `r_leaf` is fixed by the circuit and the commitment is fixed by the validator, Pedersen binding
leaves `(denomination, r_leaf)` as the only opening. This gives the same guarantee as an in-circuit
secp256k1 check at about 1/100 of the constraints.

`r_leaf` is public on chain. It does not reveal which deposit a withdrawal spends: `r_leaf =
poseidon(secret, ν)` is one-way, and a deposit leaf is `poseidon(secret, ν, denom)`.

## Files

```
circuits/
├── withdraw.circom          mixer withdrawal circuit
├── merkleTree.circom        Poseidon Merkle inclusion proof
├── build.sh                 mixer compile + dev Groth16 setup + vk export
├── prove-sample.mjs         mixer sample prover
├── finalize.sh              mixer ceremony finalize + bundle staging
├── ceremony-bundle/         mixer ceremony attestations
├── amm/                     AMM circuits, build, tests, dev zkeys
├── amm-ceremony-init.sh     AMM ceremony chain init
├── amm-ceremony-verify.sh   AMM ceremony verify
├── finalize-amm.sh          AMM ceremony finalize + bundle staging
├── pin-*.sh                 IPFS pinning for ptau and ceremony bundles
└── package.json
```
