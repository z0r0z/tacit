# Ethereum L1 — shielded pools + asset factory

Design and sequencing for a standalone Ethereum L1 surface built from the Tacit
cryptography already live on mainnet: (1) a native ETH shielded pool — deposit
and withdraw entirely on Ethereum, no Bitcoin round-trip; (2) an ERC20 factory
with Tacit asset semantics and per-token shielded pools; (3) bridged Tacit
assets as ERC20s (follow-up design pass). Target chain: Ethereum L1.

**No new trusted setup.** Every pool verifies withdrawals against the finalized
mixer ceremony. The withdraw circuit is domain-generic by construction:
`denomination` is a public input (one ceremony covers every pool size) and
`bind_hash` is constrained only as `bind_squared == bind_hash²` — the preimage
layout is the verifier's choice. The bridge already uses this
(`TacitBridgeMixer.sol` binds `"tacit-bridge-burn-v1" ‖ chainid ‖ mixer ‖ …`);
each new surface picks its own domain string and the same proof system carries
it.

## What is already deployed and reused

| Component | Where | Reuse |
|---|---|---|
| Burn Groth16 verifier (canonical ceremony VK) | `0x031b22ba49e38212fdeB92b31fe2f718567Ab2ca`, mainnet | Stateless `view`; one instance serves every pool and every bridge generation (it is already generation-legitimacy check 4) |
| Poseidon T3 (BN254) | `contracts/src/lib/PoseidonT3.sol`, parity-tested (`PoseidonParity.t.sol`) | Tree hashing, unchanged |
| Deposit tree implementation | `TacitBridgeMixer.sol` `_insertDeposit` + pool storage | Extracted into the new pool contract: per-denom frontier (depth 20), permanent root history, commitment dedup, `batchDeposit` |
| Note format + prover | `leaf = Poseidon₃(secret, ν, denom)`, `nullifier_hash = Poseidon₁(ν)`; in-browser snarkjs + canonical cached zkey | Identical notes across Bitcoin pools, the bridge, and these pools; only the `bind_hash` preimage differs |
| Denomination ladder | gen-0 mixer: 1e13 … 1e20 wei (0.00001 – 100 ETH, 8 denoms) | Mirrored for the native ETH pool |
| Decimal alignment | `UNIT_SCALE` constructor logic in the mixer | Reused for ERC20 pools with arbitrary decimals |

---

## 1. Relationship to the tETH gen-1 redeploy (settled: fully decoupled)

The native pool requires **no change to the gen-1 mixer, guest, or verifier**.
The only shared object is the canonical burn Groth16 verifier, which is
stateless and already pinned as a client constant. The `teth-gen1` scope
(LOCK-4 root window, LOCK-3 denom-scoped nullifier) ships exactly as planned.

The richer variant — one shared deposit tree where a note can either
bridge-mint on Bitcoin or withdraw natively on Ethereum, with the two
indistinguishable at deposit time — requires the two spend surfaces to be
mutually visible: the guest would consume an Ethereum-side native-spend
accumulator (committed in public values and checked at submission, exactly as
deposit accumulators are today) and expose mint nullifiers in the public-values
tail so the contract can refuse a native withdraw of a bridged note. That is a
vkey-changing guest edit — i.e. a **future generation's feature**, cleanly
absorbed by the multi-generation accounting in `PLAN-teth-fresh-deployment.md`
§2. Nothing needs to be pre-wired in gen-1 to keep that door open; the
generation mechanism is the door.

---

## 2. Phase 1 — `ShieldedPool` (native ETH)

A single contract, immutable and ownerless (no admin, no pause, no upgrade
pointer — same posture as the bridge mixer).

### Structure
- Pools keyed `poolId = keccak256(abi.encode(ASSET_ID, denomination))`, one
  Poseidon tree (depth 20, ~1.05M leaves) per denomination — lifted from
  `TacitBridgeMixer` unchanged, including permanent root history
  (`isKnownDepositRoot`) and commitment dedup.
- `ASSET_ID = SHA256("tacit-evm-token-v1" ‖ chainid_be8 ‖ address(0))` — the
  uniform EVM asset-id rule (§3), domain-separated from Bitcoin asset ids.
- Denominations: the gen-0 8-denom ladder (1e13 … 1e20 wei). Ladder parity
  keeps notes uniform across surfaces and leaves nothing to reconcile if a
  later generation unifies the deposit trees (§1).
- No SP1 verifier coupling: capacity gate is local
  (`nextLeafIndex < 2^20`; there is no rotate/import surface, so no reserve
  band is needed).
- `deposit(commitment, denomination)` payable, plus `batchDeposit`.

### Withdraw (the new entry)
```
withdraw(
  uint[2] a, uint[2][2] b, uint[2] c,
  bytes32 root, bytes32 nullifierHash,
  uint256 denomination, uint256 rLeaf,
  address recipient, address relayer, uint256 fee
)
```
1. `root` must be a known historical root of the denomination's tree.
2. `nullifierHash` unspent in the pool's nullifier map → mark spent.
3. Recompute on-chain:
   `bindHash = SHA256("tacit-eth-withdraw-v1" ‖ chainid ‖ address(this) ‖
   ASSET_ID ‖ denomination ‖ recipient ‖ relayer ‖ fee) mod r`.
4. `BURN_VERIFIER.verifyProof(a, b, c, [root, nullifierHash, denomination,
   rLeaf, bindHash])` — the deployed canonical instance, same `uint[5]` layout
   as the bridge burn path.
5. Pay `denomination − fee` to `recipient`, `fee` to `relayer`.

`recipient`/`relayer`/`fee` are inside `bindHash`, so they are proof-bound and
not malleable in the mempool. `rLeaf` is constrained in-circuit as
`Poseidon₂(secret, ν)`; the native surface carries it as a public input and
does not otherwise use it. Distinct domain strings make bridge-burn proofs and
native-withdraw proofs mutually unusable across surfaces.

### Relayer (day one)
Withdrawals ship relayer-first: a worker endpoint quotes a fee, receives the
proof + public inputs, and broadcasts the withdrawal from its funded key. The
relayer address and fee are inside `bindHash`, so the endpoint can neither
redirect a payout nor change its fee; the key carries only a gas float, which
the bound fees replenish. If gas moves between proving and broadcast, the
endpoint re-quotes and the user re-proves — the nullifier is spent only on
inclusion. Self-withdraw stays available; the dapp defaults to the relayer so
a fresh recipient address needs no funding history.

### Invariants (structural, single-contract custody)
- Per pool: `#spent nullifiers ≤ #leaves`, and escrow ≥ Σ unspent
  denominations — the contract holds the ETH and each withdraw spends one
  nullifier against one known root.

### Notes and recovery
Same bearer-note format as the bridge. New for this surface: the dapp derives
notes deterministically — `(secret_i, ν_i)` expanded from
`HMAC-SHA256(wallet.priv, "tacit-eth-note-v1" ‖ chainid ‖ pool ‖ index)` — so
a wallet recovers its open notes from the seed plus a chain scan of its own
deposit events, matching the recover-from-privkey-alone property the Bitcoin
surfaces have. Notes store under the existing `network:contractAddress` keying,
so the pool slots into the same routing the generation registry uses; its
redeem path is an Ethereum transaction instead of a Bitcoin burn.

### Cost profile (L1, measured)
- Deposit: ~1.48M gas — 20 × `PoseidonT3` in pure Solidity dominates (the
  same insertion cost the bridge mixer already pays). The notable L1 number;
  a Poseidon precompile or an SSTORE2-cached frontier could cut it later.
- Withdraw: field checks + SHA256 bindHash + one BN254 pairing (~230k via the
  canonical verifier) + transfers ≈ 300–350k.

Status: `contracts/src/ShieldedPool.sol` + `test/ShieldedPool.t.sol` (22) +
`test/ShieldedPoolRealProof.t.sol` (3, real ceremony proof) +
`tests/gen-native-withdraw-fixture.mjs` landed. Full suite 121/121. The §5
Stage 1 real-proof gate is green: a real ceremony proof round-trips
(deposit → on-chain root → withdraw) through the `"tacit-eth-withdraw-v1"`
domain on the real `Groth16Verifier`, the relayer-fee split pays out, and a
tampered recipient is rejected (bindHash mismatch).

---

## 3. Phase 2 — `TacitConfidentialFactory` (confidential ERC20s + wrapper)

The headline surface, and the part of "Tacit on Ethereum" that no other system
can copy: a factory for ERC20s with **blinded balances** built on Tacit's
secp256k1 notes — the same curve as Bitcoin, so a note is one cross-chain
object verifiable on the EVM via the `ecrecover` trick. Normative construction:
[`SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md`](../spec/amendments/SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md).
This replaces the earlier transparent-factory sketch. It composes with the §2
`ShieldedPool` as the two halves of the privacy stack: pools hide **who**
(unlinkability, fixed denominations), confidential tokens hide **how much**
(amounts) — mirroring mixer + CXFER on Bitcoin.

### Why this is the splash, not "another privacy token"
Confidential ERC20s already exist (Railgun-style, BN254 notes; Aztec as a
separate rollup). The distinction here is the curve: Tacit's notes are
secp256k1, so the same secret, the same 33-byte commitment, the same range
disclosure, and the same stealth address are valid on Bitcoin **and** Ethereum
— one wallet seed, both chains. The amount/range layer reuses a Bitcoin-block-
beacon'd ceremony and the existing secp Bulletproofs tooling unchanged.

### Asset identity
- Etched: `asset_id = SHA256("tacit-evm-etch-v1" ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher)`.
- Wrapped/native: `asset_id = SHA256("tacit-evm-token-v1" ‖ chainid_be8 ‖ underlying)`.
Domain-separated from the Bitcoin `SHA256(reveal_txid ‖ vout)` namespace and
from the §2 pool asset-id rule.

### Launch surface (no new trusted setup)
- `etch` / `petch` — confidential token with fixed or mintable supply; supply
  public and exact, allocation across notes blinded (amendment §3).
- `mint` / `burn` — public-amount supply ops with a PoK binding the note
  commitment; fixed supply = `mintAuthority == address(0)`.
- `wrap(token, amount)` / `unwrap(note, amount, to)` — confidential wrapper for
  any existing ERC20; amount visible only at the wrap boundary (amendment §5).
- **Balance + range attestation** — reuses `SPEC-RANGE-PROOF-PRIMITIVE`
  (`bpRangeAggProve` / `bpRangeAggVerify`) verbatim, off-chain, day one; an
  on-chain `T_RANGE_ATTEST`-shaped event anchors predicates for consumer
  contracts.
- **Tier A confidential transfer** — denominated OR-notes: synchronous,
  inflation-proof without a range proof, no ceremony (amendment §4 Tier A).
- **Stealth recipients** — the blinded-pubkey commit in ERC-5564 form; one seed
  scans both chains (amendment §6).

### Follow-up
- **Tier B** exact-amount transfers — SP1-batched verification of the unchanged
  secp Bulletproofs+, reusing the bridge prover discipline; a separate news
  beat (amendment §4 Tier B).

### Indexing
Factory and asset events are sufficient for discovery. The worker extends its
existing Ethereum scan to confidential-asset note leaves and spent-markers; the
dapp verifies reconstructed state against the contract before proving, so the
worker stays a convenience, not trust-bearing. Direct RPC reconstruction is the
recovery fallback.

---

## 4. Phase 3 — bridged Tacit assets as ERC20s (follow-up design pass)

The mirror of tETH: an asset native to Bitcoin (TAC, cBTC.tac, LP shares)
represented as an ERC20 on Ethereum. The components largely exist — the SP1
guest already computes Tacit pool trees and verifies withdraw proofs in-zkVM,
and `SP1PoolRootVerifier` already lands proven per-denom Bitcoin pool roots on
Ethereum. New pieces: an ERC20 mint path gated by a withdraw proof against a
proven Bitcoin pool root plus an Ethereum-side nullifier set, and the reverse
path (ERC20 burn honored by the indexer for a Bitcoin-side withdraw). The two
directions are asymmetric and the reverse path defines the trust surface, so
this phase gets its own plan doc when taken up. Deployment shape is
per-generation, identical to tETH.

---

## 5. Verification

Two stages, mirroring the tETH plan.

### Stage 1 — off-chain gate
- Forge: note-parity KATs (leaf / nullifier / root vectors generated by the
  dapp prover, asserted against `PoseidonT3` tree insertion), withdraw
  accounting, batch deposits, capacity edge.
- Real-proof suite (canonical zkey, real Groth16 proofs):
  - a deposit → native withdraw round-trip is accepted;
  - a proof with a tampered `recipient`/`relayer`/`fee` is rejected
    (`bindHash` mismatch);
  - a reused nullifier is rejected; an unknown root is rejected;
  - cross-surface: a bridge-burn proof is rejected by the native pool and a
    native proof by the bridge (domain strings differ).

### Stage 2 — mainnet, dapp-gated tiny caps
- Deploy; verify on Etherscan; cap deposits in the dapp while unproven.
- Live: deposit → withdraw to a fresh address; relayer-fee withdraw; batch
  deposit. Raise caps after green.

---

## 6. Sequencing

1. `ShieldedPool` contract + Stage 1 suite. Independent of the `teth-gen1`
   track; only touchpoint is reading the canonical burn-verifier constant.
2. Worker: extend the Ethereum leaf scan to the new pools; relayer endpoint
   (quote + broadcast).
3. Dapp: shield tile (deposit / relayer withdraw), deterministic note
   derivation, notes routing entry, deposit caps.
4. Mainnet deploy + Stage 2; raise caps.
5. Confidential factory (§3): `Secp256k1.sol` primitives + `TacitConfidential{Factory,ERC20}`;
   launch surface (etch/petch/mint/burn, wrap/unwrap, attestation, Tier A
   transfer, stealth) per the amendment. Tier B (SP1-batched) follows.
6. Phase-3 plan doc (bridged assets), scheduled after the gen-1 alpha settles.

## Settled decisions

- Relayer: worker relayer from day one (§2); self-withdraw remains available.
- ETH ladder: mirror the gen-0 8-denom ladder — parity with the bridge keeps
  notes uniform and aligns the trees with any future unified-surface
  generation.
- Indexing: the worker extends its existing Ethereum scan; the dapp verifies
  state on-chain; direct RPC is the recovery fallback.
- Factory model: **confidential** (blinded balances on secp256k1 notes), not a
  transparent ERC20 factory — the secp note is the cross-chain differentiator
  (amendment). Deployed complete and permissionless; the dapp curates the
  surfaced assets.
- Confidential transfers: Tier A (denominated OR-notes) at launch — synchronous,
  no trusted setup; Tier B (SP1-batched exact-amount BP+) as the follow-up beat.
- No new trusted setup on the launch path: pool reuses the mixer ceremony VK;
  factory reuses the secp Bulletproofs tooling + range primitive; Tier B reuses
  the bridge SP1 trust root.
