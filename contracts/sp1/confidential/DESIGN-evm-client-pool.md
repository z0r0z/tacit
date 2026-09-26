# EVM client-proved pool: a Secret Sats-shaped special-purpose pool on Ethereum

Status: DESIGN. No code deployed; nothing in this document touches `ConfidentialPool.sol`, the settle
guest or its pinned `PROGRAM_VKEY`. Companion: `contracts/sp1/confidential/DESIGN-btc-shielded-pool.md`
(the Bitcoin analogue), `ops/research-btc-pool-client-proving.md` (the study this reuses), SPEC §2.8 and
§3.10.

A special-purpose pool for one Tacit asset (cBTC first) on Ethereum, proved by the user's own device, the
same relation as the Bitcoin shielded pool. It is a new, additional contract alongside the immutable
`ConfidentialPool.sol` — not a replacement, not an upgrade path, not a dependency. V1's general DeFi and
bridge surface stays exactly where it is: the SP1 zkVM, one program, one pinned vkey (README "Secret Sats:
special-purpose pools").

## 1. Why this is simpler than the Bitcoin version

The Bitcoin pool's hard constraint was proving on a wasm32 device against a relation built from
Bitcoin-native primitives (keccak, secp256k1, BIP-340) — measured at ≈17M R1CS, a ~10 GB key, infeasible
in a browser (`ops/research-btc-pool-client-proving.md` §1). The fix was redesigning the relation entirely
in BN254-native arithmetic (Poseidon, BabyJubJub, EdDSA-Poseidon), which cost ≈30k constraints, and then
proving that relation off-chain and shipping the proof to a Bitcoin transaction, where *nothing* checks
it in-band — acceptance is whatever the indexer network converges on by replaying Bitcoin and verifying
locally. There is no on-chain verifier because there is no “chain” with programmability to put one on.

On Ethereum this constraint doesn't exist at all, in either direction:

- **The circuit is already BN254.** `spend.circom`'s relation (Poseidon tree, BabyJubJub notes and keys,
  EdDSA-Poseidon signatures, BabyJub Pedersen commitments) is native to the same scalar field Ethereum's
  precompiled pairing curve uses. Nothing about the relation needs to change to move it on-chain.
- **Ethereum has the pairing precompile.** EIP-197 ships `ecAdd` (0x06), `ecMul` (0x07) and `ecPairing`
  (0x08) over exactly this curve. A Groth16 or Halo2-KZG-BN254 proof verifies in one `staticcall`, with a
  deterministic, synchronous, in-protocol result. Tacit already has a live example of this
  (`contracts/src/Groth16Verifier.sol`, the mixer's snarkjs-generated verifier, §3 below) — the precedent
  is not hypothetical.
- **No off-chain indexer consensus is needed for acceptance.** The Bitcoin pool's proof is meaningless
  to Bitcoin consensus; every indexer must independently verify it and agree, and a spend is “accepted”
  only by social/software convergence on that replay. On Ethereum, `verifyProof` returning `true` inside
  `spend()` **is** acceptance — enforced by the EVM itself, at the moment of inclusion. This removes an
  entire category of engineering (indexer replay, undo logs, reorg handling for pool state, halting
  behavior on stale keys) that §3.10 needs and this design does not.
- **No cross-curve boundary proof.** The Bitcoin pool needs the sigma + BP+ boundary of SPEC §2.8 / design
  §3 because its transparent layer is secp256k1 and its pool is BabyJubJub — two different note formats
  for the same value, needing a proof that they open to the same amount. On Ethereum there is no second,
  pre-existing curve to bridge from: an ERC-20/ETH deposit is an amount transferred by `transferFrom`, not
  a value committed on a different curve. The pool's own BabyJubJub commitment is the *only* representation
  the deposited value ever takes. Section 2 makes this precise.

Net effect: this pool needs one relation (already frozen and measured), one setup (already pinned, no new
ceremony — §3), and one small immutable contract. It has no boundary lemma to prove, no indexer software
to write, and no consensus-acceptance question to answer.

## 2. The relation: what's identical, what changes

Reused exactly, byte-for-byte the same circuit and reference model:

- **Circuit.** `dapp/circuits/btc-pool/spend.circom` (`BtcPoolSpend(depth=32, nIn=2, nOut=3)`) and
  `dapp/circuits/btc-pool/btc_pool_templates.circom` (`CanonicalKeyMul`, `MerkleRoot`, `NoteLeaf`). Same
  12 public inputs, same order: `root, bodyHash, asset, nf[2], outLeaf[3], exitC[2], depC[2]`.
- **Note/key model.** `dapp/btc-pool-zk.js`: BabyJubJub spend/nullifier keys at circomlib `Base8`,
  `npk = Poseidon(Ak.x, Ak.y, NK.x, NK.y)`, `leaf = Poseidon(asset, v, npk, rho)`,
  `nf = Poseidon(nk_note, leaf, index)`, EdDSA-Poseidon spend authorization over `bodyHash`, BabyJub
  Pedersen openings for `exitC`/`depC` (`pedersenBJJ`, Tacit's NUMS `H`/`G` generators). The Rust twin is
  `contracts/sp1/confidential/btc-pool-core/src/lib.rs`.
- **Proof system.** Either of the two already-built and measured options (§3), no new one.
- **Trees, nullifiers, membership rule.** Identical depth-32 Poseidon(2) tree, identical empty-slot
  convention (`nf[i] = 0` ⇒ empty; a real zero-value input skips membership only, per `spend.circom`
  lines 93–95).

What changes is only the boundary — deposit/withdraw semantics replace shield/exit's cross-curve step:

| | Bitcoin pool (§3.10) | This pool |
|---|---|---|
| Value enters | Spend a transparent secp256k1 UTXO note (`T_BTC_SHIELD`); kernel-signed, cross-curve sigma binds `C_secp` to `depC`, plus a 591 B BP+ range proof on the secp side | `Pool.deposit(asset, amount, commitment, …)`: an ERC-20/ETH `transferFrom`/`msg.value` for `amount`, and the depositor opens the *same* `depC` BabyJub Pedersen commitment the circuit already range-checks, in the same transaction. No second curve, so no sigma, no second range proof. |
| Value leaves | `T_BTC_SPEND` publishes `exitC`; boundary carries `sigma(C_secp, C_exit_bjj)` + BP+; a maker checks the opening off-chain before broadcasting its own coins | `spend()` verifies the proof, then transfers `exitV` of `asset` to the exit recipient directly — the contract reads `exitV`/`exitR` from a plaintext opening argument (not hidden on-chain at the exit, exactly as `T_BTC_SPEND`'s exit is: the destination note's amount is publicly openable once it leaves the pool) and checks it against `exitC` with the same `PedersenBJJ` equation the circuit enforces, so the withdrawn amount is exactly what the proof committed to. |
| Acceptance | Indexer replay convergence, no consensus primitive | `ecPairing`/`ecMul`/`ecAdd` under `spend()`, inside the transaction, final at inclusion |
| Bind/relay carrier | A confirmed Bitcoin UTXO the carrier must spend (`bind`) | Ordinary Ethereum tx origination — no `bind` needed; an EVM transaction cannot be front-run into existence the way a UTXO carrier can be raced, and `spend()`'s nullifier check is atomic with proof verification in the same call |

Everything downstream of "hidden amounts, fungible single-asset notes, 2-in/3-out, pay + exit with change
in one spend, relayed fee note" carries over unchanged, because it's a property of the circuit, not of
which chain verifies it.

## 3. Solidity verifier

Two already-built options, both over the **same pinned Hermez pot18** (`bafybeigb43f…sizri` /
`powersOfTau28_hez_final_18.ptau`, BLAKE2b `7e6a9c2e…b95b13e`) — no new ceremony either way.

### 3a. Halo2-KZG (recommended)

The circuit as already ported and pinned: `contracts/sp1/confidential/btc-pool-halo2`, k = 13 (commit
`e3be20e1`), 2,080 B proof, `vk.bin` (BLAKE2b `bd1d3ebb…`), `params-k13.bin` derived from pot18 with no new
randomness (`dapp/btc-pool/pin.json`).

- **Tooling survey.** PSE's `snark-verifier` (the halo2-ecosystem project, `privacy-scaling-explorations/
  snark-verifier`) generates a Solidity verifier for a Halo2-KZG proof by way of a "verifier circuit" plus
  a codegen step (`SolidityGenerator`), used in production by projects like Scroll and Taiko for their
  Halo2-KZG rollup proofs. It is not vendored in this repo (`btc-pool-halo2/Cargo.toml` has no
  `snark-verifier` dependency) and integrating it is real, non-trivial work: it wants the circuit
  expressed against its own `halo2_proofs`/`halo2curves` fork versions, and the generated Solidity is a
  single large contract with inline assembly comparable in shape to the mixer's `Groth16Verifier.sol` but
  built around SHPLONK's multi-open argument rather than a fixed 3-pairing Groth16 check.
  - **Gas — measured, not estimated (2026-09-26 spike, `contracts/sp1/confidential/evm-client-pool-spike/`).**
    `snark-verifier` v0.1.1 / `snark-verifier-sdk` v0.1.2 pin `halo2_proofs` at git tag `v0.3.0`, commit
    `73408a1…` — the *exact same commit* `btc-pool-halo2/Cargo.lock` pins. `halo2curves` (0.6.0 required vs
    0.6.1 pinned) resolves under ordinary semver. No shim, no fork, no version bump needed: this was the
    smaller of the two real risks and it is fully closed.
    The real blocker is a different one the survey didn't anticipate: the pinned prover writes a Blake2b
    transcript; an EVM verifier needs a Keccak transcript for cheap on-chain Fiat-Shamir replay. Same
    `params`/`vk`/circuit, different proving call — `snark_verifier_sdk::evm::gen_evm_proof_shplonk`
    instead of `btc_pool_halo2::prove`, no vk repin. Generated a real proof (2,720 B, EVM transcript) over a
    real witness (`Fixture::pay()`, the same fixture `tests/spend.rs` uses), generated the actual Solidity
    verifier via `snark-verifier`'s codegen (`compile` + `EvmLoader` + `PlonkVerifier::<SHPLONK>`) against
    the real pinned `vk.bin`/`params-k13.bin` and the real 12-instance protocol (12 advice + 1 permutation +
    1 random + 4 quotient + 2 SHPLONK = 21 commitments, standalone decider — no accumulator), and measured
    the call with `revm` (the same in-memory EVM `snark-verifier-sdk`'s own `evm_verify` uses):
    **504,095 gas, execution only, real proof, real pinned vk — verified true.** That is ~2× the doc's
    prior 300–450k estimate and ~2× Groth16's 255k (below).
    A second, independent blocker showed up alongside the gas number: the generated contract is 35,645
    bytes unoptimized — over EIP-170's 24,576-byte cap — and **no working codegen path was found to bring
    it under the cap**: legacy codegen with the optimizer on (any `runs` value tried) fails to compile at
    all (`Stack too deep` inside the raw assembly, a Solidity compiler limitation, not a tuning problem);
    `--via-ir` compiles cleanly on solc 0.8.19, 0.8.20, and 0.8.37 alike, but produces a **dead contract**
    — decoded runtime bytecode is exactly `PUSH0 DUP1 REVERT` plus metadata. Root cause, confirmed by
    reading the generated source: it opens with `if iszero(eq(mload(0x40), 0x80)) { revert(0,0) }` and then
    uses hundreds of hardcoded absolute memory offsets (`mstore(0x80, …)`, `mstore(0x800, …)`) as its
    working registers — a legacy-codegen-only assumption about where Solidity's free memory pointer sits at
    function entry. `--via-ir` doesn't guarantee that address, so the guard trips (or, if patched out, the
    hardcoded stores would corrupt whatever via-IR actually put there instead). This is `snark-verifier`'s
    own codegen doing exactly what it's built to do — it is simply not via-IR-safe, and this circuit's
    protocol is too large for legacy codegen's stack allocator once the optimizer is asked to help. Fixing
    it needs splitting the verify logic across multiple contracts/libraries — real, unscoped engineering
    this `snark-verifier` version doesn't do for you — before Halo2-KZG is even deployable, on top of
    already costing 2× Groth16 to run.
  - **Benefit kept, cost revised:** no ceremony, ships the exact proving artifact already pinned for the
    Bitcoin pool (only the on-chain-targeted *proving call* differs, not the vk or circuit) — but the
    verifier itself is neither cheaper nor, in its current form, deployable, so this benefit no longer
    outweighs 3b. See the revised recommendation below.

### 3b. Groth16 (mature tooling, needs its own ceremony)

`spend.circom` compiled with circom/snarkjs the way the mixer and AMM circuits already are
(`docs/CEREMONY.md`), verified by an `exportSolidityVerifier`-generated contract in the exact shape of
`contracts/src/Groth16Verifier.sol` (the live mixer verifier — see below).

- **Tooling is the most mature available.** snarkjs's Solidity codegen is what already produced Tacit's
  one live on-chain ZK verifier. No new integration work; the same `zkey export solidityverifier`
  command that made `Groth16Verifier.sol`.
  - **Cost.** Groth16 verification is always exactly one `ecPairing` call over 4 point pairs (−A/B,
    α/β, vk_x/γ, C/δ) plus one `ecMul`+`ecAdd` per public input to build `vk_x`. `spend.circom`'s
    production estimate is ~30k constraints with **12 public inputs** (root, bodyHash, asset, nf[2],
    outLeaf[3], exitC[2], depC[2]), vs. the mixer's 5. Gas: `45,000 + 34,000×4 = 181,000` for the pairing,
    plus `12 × (6,000 + 150) = 73,800` for the public-input MSM ⇒ **≈255k gas**, close to `Groth16Verifier.
    sol`'s own shape scaled up from 5 to 12 signals (that contract: `181,000 + 5×6,150 = 211,750` gas for
    its `verifyProof`, matching the fixed cost anyone can re-derive from EIP-197's schedule).
  - **Cost is a known quantity, not a survey.** Unlike 3a, this number needs no new integration to
    validate — it follows directly from the EIP-197 schedule and the circuit's already-measured public
    input count.
  - **The catch: a new phase-2 ceremony — concretely scoped, not just restated.** Phase 1 (pot18) is
    reused, but Groth16's proving/verifying key is circuit-specific. Tacit's existing coordinator
    (`dapp/circuits/amm-ceremony-init.sh` → the worker's `/ceremony/init`/`/ceremony/contribute`, pot18
    pre-pinned by `dapp/circuits/pin-pot18.sh`) is the *same* infrastructure the AMM's three chains already
    ran on, unmodified — no new coordinator code, no new pinning path, no new beacon mechanism. What's
    genuinely new: (1) compile `spend.circom` to r1cs and a genesis zkey for *this* relation — minutes of
    local work, not previously done for this circuit; (2) `curl -F` the genesis zkey/r1cs (or their CIDs,
    for the larger files, exactly as `amm-ceremony-init.sh` already branches) to `/ceremony/init`; (3) open
    the chain for public sequential contributions; (4) finalize with the same Bitcoin-block-beacon
    convention (`docs/CEREMONY.md`'s AMM/mixer ceremonies both used this, 10 iterations). Steps 1–2 and 4
    are mechanical, hours not days. Step 3 is the real cost and it is a calendar-time cost, not an
    engineering one: the precedent chains ran 5,018 (`amm_swap_batch`) to 13,703 (`amm_lp_remove`)
    contributions before finalizing, which took weeks of public participation. A circuit-distinct
    proving/verifying key from the Bitcoin pool's Halo2 artifacts is produced either way — the two pools
    never shared a key even though they share a relation and a phase-1 SRS — so this is the same shape of
    cost §7's Bitcoin-pool recommendation already accepted, reusing the identical rollout mechanism.
    A meaningfully smaller, still-decentralized contribution set (tens, not thousands) can close in days if
    urgency justifies a thinner trust set than the AMM ceremony's — a real, explicit trade, not a free
    shortcut, but the point stands: **the only new work is compiling one circuit and running a chain that
    already exists; there is no new ceremony *software* to build.**

**Recommendation (revised after the 2026-09-26 measurement, see 3a): 3b (Groth16), despite the new
ceremony.** The Halo2-KZG path's benefit (no ceremony) no longer clears its cost: real measured gas is
504,095 — 2× this estimate, not the doc's earlier 300–450k guess — and the generated verifier does not fit
under EIP-170 in any codegen configuration tried (§3a), which is a second, independent, currently-unscoped
blocker on top of the gas number. Groth16's 255k is half the real Halo2-KZG cost, its tooling is the most
mature available and already shipped once in this exact repo (`Groth16Verifier.sol`), and its "catch" — a
new phase-2 ceremony — is mechanical infrastructure reuse whose only true cost is calendar time for public
contributions, not new engineering. Ship 3b.

## 4. Contract sketch

New file, matching the repo's existing single-directory Solidity layout (`contracts/src/*.sol`,
`contracts/foundry.toml` with `src = "src"`). Sketch only — see §7 for what's prototyped.

```solidity
interface IEvmClientPoolVerifier {
    // Halo2-KZG (3a) or Groth16 (3b) — either compiles to this shape from the wallet's perspective.
    function verifySpendProof(uint256[12] calldata publicInputs, bytes calldata proof)
        external view returns (bool);
}

contract EvmClientPool {
    IEvmClientPoolVerifier internal immutable VERIFIER;
    address internal immutable ASSET;           // the one Tacit asset this pool holds (cBTC first)
    bytes32 internal immutable CHAIN_BINDING;    // keccak(chainid, address(this)) — same convention as
                                                  // ConfidentialPool.sol's CHAIN_BINDING (SPEC §4.3)

    bytes32 public root;
    mapping(bytes32 => bool) public nullified;
    mapping(bytes32 => bool) public everKnownRoot;

    event LeavesInserted(uint256 firstIndex, bytes32[3] leaves, bytes[] memos);

    // asset.transferFrom(msg.sender, address(this), amount); inserts one leaf whose Pedersen opening
    // (amount, r) the depositor supplies and the contract checks against `commitment` with the same
    // PedersenBJJ equation spend.circom enforces on depC — no proof needed for a deposit, exactly as
    // T_BTC_SHIELD's depC is an opened commitment, not a hidden one, at the moment it's created.
    function deposit(uint256 amount, uint256[2] calldata commitment, uint256 r, bytes calldata memo)
        external;

    // Verifies the proof against {root, bodyHash, asset, nf, outLeaf, exitC, depC}; on success, marks
    // nullifiers spent, appends outLeaf entries, and if exitC opens (opening supplied alongside, checked
    // on-chain the same way deposit's commitment is) pays `asset.transfer(exitRecipient, exitV)`. A
    // relayer fee is just one more output leaf — an ordinary in-pool note the relayer's own key later
    // spends — so gas can be sponsored the same way the Bitcoin pool's relayer is paid, but proving is
    // always free and any wallet can call this directly with its own transaction.
    function spend(
        uint256[12] calldata publicInputs,
        bytes calldata proof,
        bytes[] calldata memos,
        address exitRecipient,
        uint256 exitOpeningR
    ) external;
}
```

Relaying support mirrors the Bitcoin design directly: a fee is an ordinary output leaf paid to the
relayer's own note, checked and collected the same way any output is — there is no separate fee
mechanism to build, because "pay someone inside the pool" and "pay the relayer" are the same primitive.
Unlike the Bitcoin carrier, there is no `bind` UTXO to race for: an Ethereum relayer just submits the
transaction, and `nullified[nf]` plus proof verification are checked atomically in the same call, so two
relayers racing the same spend simply have one transaction revert, with no fee paid to either.

**Immutability stance: immutable, matching V1.** SPEC §8 ("Deployment lineage") states the precedent
explicitly: *"A pool is immutable, so the protocol evolves by deploying a successor... `createNextGen`...
callable once, only by `LINEAGE_STEWARD`."* `ConfidentialPool.sol`'s own header states the same design
target for the general pool. This special-purpose pool should follow the identical shape: no owner, no
pause, no admin function, and if the relation or verifier ever needs to change, ship a new contract at a
new address the way `ConfidentialPool.sol` itself would grow a successor — never a proxy, never a rotation
path on this contract. The V1 security-philosophy pattern already established in this codebase (immutable
core protects the pot and other users; canonical client + docs protect against self-inflicted footguns)
applies unchanged: this pool's core guarantee (funds can only leave via a verified proof or a checked
deposit-commitment opening) must be as immovable as `ConfidentialPool.sol`'s settle path.

## 5. Relationship to V1

This is a **new, additional** special-purpose pool, exactly the shape README's "Secret Sats: special-purpose
pools" section already describes and does not contradict: *"The confidential pool runs open-ended DeFi and
the bridge, so it uses the SP1 zkVM... A pool that does one thing, such as private payments, uses a small
fixed circuit."* That section was written about the Bitcoin pool; this design is the same sentence applied
to Ethereum.

- It does not touch, upgrade, extend, or depend on `ConfidentialPool.sol`, its settle guest, or
  `PROGRAM_VKEY`.
- V1's general DeFi surface (swaps, LP, CDPs, farms) and its bridge/reflection lane stay on SP1 exactly as
  today. Nothing here proposes moving any of that to a client-proved circuit — SP1 remains the right tool
  for an open-ended, many-op, batched-proof system; a fixed circuit is only right for a fixed relation.
- It is isolated the same way any two Tacit pools are isolated (SPEC §8): its own tree, its own nullifier
  set, its own `CHAIN_BINDING`. A bug or a compromised verifying key in this pool cannot touch V1's pot,
  and vice versa.

## 6. Entering from V1: composing the existing relay-withdraw primitive, no core change

V1 already has a gasless relay path where a settle proof names an arbitrary payout address:
`ConfidentialPool.sol`'s `Withdrawal{bytes32 assetId; address recipient; uint256 value;}` (line 570), paid
out inside `settle()` by `_payoutCk(w.assetId, w.recipient, w.value)` (line 2177) — `recipient` is
whatever address the withdrawal was proven against, not necessarily `msg.sender`, and any relayer can be
the one who calls `settle()` and collects the batch's `pv.fees` (line 2181). This is the same "gasless
exit, ~14 ops" mechanism already in production (`project_confidential_gasless_exit.md`), and it already has
a live composition precedent in this exact position: `contracts/src/SettleTipForwarder.sol` calls
`pool.settle(...)` unchanged and then, in the same transaction, forwards the payout it just received to a
caller-named recipient — "no extra signature, no extra transaction," per that contract's own comment.

**Entry path for any V1 confidential-pool asset (tETH, ETH, cUSD, cBTC).** A small forwarder contract,
external to V1's core, does exactly what `SettleTipForwarder` already does, but forwards into
`EvmClientPool.deposit(...)` instead of to a tip address:

1. The user (or their relayer) submits a settle batch whose `Withdrawal.recipient` is the forwarder's
   address, for the asset and amount they intend to move into the special pool.
2. `ConfidentialPool.settle()` runs completely unchanged — nothing added, nothing new checked, the same
   call every other relayed withdrawal makes.
3. In the *same transaction*, the forwarder — having just received the withdrawn tokens — calls
   `EvmClientPool.deposit(amount, commitment, r, memo)`, opening the BabyJub Pedersen commitment for the
   note the user wants inside the new pool.

One relay/SP1 fee is paid, at the same cost any V1 withdrawal costs today — nothing new is priced in.
This is buildable without touching V1 for the identical reason the Bitcoin buy-and-shield pattern
(SPEC §3.10) is buildable without touching Bitcoin's protocol rules: both compose an *existing*, unmodified
primitive (a pre-authorized sale; a relayed withdrawal-to-arbitrary-recipient) with a *new* contract call in
the same transaction, rather than adding a new opcode or a new guest check. No new opcode. Nothing added to
the settle guest. `ConfidentialPool.sol`'s bytecode does not change.

**Why this matters: it inherits V1's anonymity set for free.** A brand-new client-proved pool has a
cold-start problem — a handful of early depositors give a thin anonymity set, and the deposit's very
existence (a call into a pool nobody's heard of yet) may itself be a fingerprint. Composed this way, the
deposit transaction is, on its face, *indistinguishable from any other V1 relayed withdrawal* — the same
`settle()` call, the same event shape, the same relayer traffic V1 already has at volume. The special pool's
entry point rides V1's large, mature set of possible withdrawal recipients instead of starting from zero.

**This path is optional, not required.** An asset that never touched V1 — raw ETH, or any ERC-20, held
directly in a wallet — deposits into `EvmClientPool` directly via `deposit()`, with no V1 detour, no relay
fee, and no forwarder in the loop. The V1-entry path exists specifically for users who already hold value
in V1 and want to bring it into the special pool while inheriting V1's anon set; someone with no reason to
route through V1 loses nothing by skipping it.

**The asymmetry that makes this worth doing.** Entry costs one relay/SP1 fee, paid once, only if arriving
via V1. Every transfer *inside* the special pool afterward is a client-proved `spend()` call — free to
prove (§1), and the only cost is the on-chain verify gas of §3. The expensive, ceremony-and-zkVM-shaped
proving cost is paid exactly once, at the door; everything after that is the cheap, user-proved relation
this whole design is built around.

## 7. Cost, gas and comparison to relayer+SP1

| | This pool (Halo2-KZG, §3a) | This pool (Groth16, §3b) | Existing SP1 relay path |
|---|---|---|---|
| Prove | User's device, ~1–4 s (measured, `ops/research-btc-pool-client-proving.md` §8–9: 0.76–3.7 s native, ~6–14 s wasm single-thread) | Same order, snarkjs (measured 2.2–3.8 s) | Succinct network, ~96 s observed for a comparable pay/exit program (§6 of the research note) |
| Prover sees | Nobody but the user | Nobody but the user | The hosted prover sees every amount and leaf-to-spend link (the G8 privacy hole the research note flags) |
| Proof bytes | 2,080 B | 128–256 B | 256 B (SP1 Groth16-wrapped) |
| On-chain verify | **504,095 gas — measured** (`contracts/sp1/confidential/evm-client-pool-spike/`, 2026-09-26: real proof, real pinned vk, real `snark-verifier` codegen, `revm`-executed), and the generated contract does not fit EIP-170 in any codegen path tried — a second, open blocker | ~255k gas (`45,000 + 34,000×4 + 12×6,150`, directly from the EIP-197 schedule and the circuit's 12 public inputs) | `ISP1Verifier.verifyProof` — SP1's own Groth16-wrapped verify, same order as 3b's pairing cost, plus the settle batch's own per-op checks |
| Deposit cost | One `transferFrom`/`msg.value` + one `PedersenBJJ` check on-chain (2 `ecMul`+`ecAdd` pairs ≈ 12,300 gas) + one leaf append — materially cheaper than a proof-gated deposit | same | An SP1 batch settle amortizes its fixed proving cost over up to 256 ops, but each op still pays its share of that fixed cost even for a single wrap |
| Who pays for proving | Nobody — the device proves for free | Nobody | A PROVE treasury, `PROVER_DAILY_BUDGET`, request-priced (`base fee + PGU × bid`), 1–2 min latency |

**Comparison to relayer+SP1.** The existing path amortizes one expensive zkVM proof over a whole batch, but
that proof is not free to produce (Succinct network fee, ~96 s latency for a comparable-shaped op) and its
privacy cost is real (the hosted prover sees the batch's contents). This pool's marginal cost per spend, once
the depositor has entered (§6), is one `staticcall` at inclusion time and zero proving cost or latency
beyond what the user's own device takes. The trade is opposite: SP1 batches cost is shared but proving needs
a paid, semi-trusted network; this pool's proving is free and private but its per-spend on-chain gas (255k,
Groth16, §3b — the measured Halo2-KZG number is 504k and its verifier doesn't fit EIP-170 as-is, §3a) is
paid every time, not spread.

## 8. Prototype status

**§3a's open gas question is now resolved (2026-09-26 spike, `contracts/sp1/confidential/evm-client-pool-spike/`,
scratch — not wired into any product path):**

1. Confirmed `snark-verifier` v0.1.1 / `snark-verifier-sdk` v0.1.2 pin `halo2_proofs` at the exact same git
   commit (`73408a1…`, tag `v0.3.0`) `btc-pool-halo2` pins — no version shim needed.
2. Re-proved a real fixture witness (`Fixture::pay()`) with the EVM-targeted Keccak transcript
   (`gen_evm_proof_shplonk`, same pinned `params`/`vk`, no repin) — 2,720 B proof.
3. Generated the actual Solidity verifier via `snark-verifier`'s real codegen against the real pinned
   `vk.bin`/`params-k13.bin` and the real 12-instance protocol — not a mock, not a stub.
4. Measured the real call in `revm`: **504,095 gas, execution only, proof verified true.**
5. Found a second, independent blocker: the generated contract (35,645 B) does not fit under EIP-170 in
   any codegen path tried (legacy+optimizer: `Stack too deep`; `--via-ir` on solc 0.8.19/0.8.20/0.8.37: compiles
   to a dead, always-reverting contract — a hardcoded-memory-layout incompatibility in `snark-verifier`'s
   codegen itself, not a version fluke).

**Recommendation, revised: ship 3b (Groth16), not 3a.** The gas number is now real, not estimated, and it
does not clear the bar the design hoped for: 504k is 2× Groth16's 255k, and the packaging blocker (item 5)
means Halo2-KZG isn't even deployable as generated — fixing that needs splitting the verifier across
multiple contracts, unscoped further engineering with no guaranteed outcome yet. Groth16's ceremony "catch"
is real but bounded and mechanical (§3b): the coordinator, pinning and beacon-finalize flow all already
exist and run unmodified; the only new work is compiling `spend.circom` once and running the existing
public-contribution flow, whose cost is calendar time, not new software.

**Still not attempted in this pass — real remaining work before ship:**
1. Run the phase-2 ceremony for `spend.circom` on the existing coordinator (§3b) and export
   `Groth16Verifier.sol`'s equivalent for this circuit via `zkey export solidityverifier` — the identical
   toolchain that produced the mixer's verifier.
2. A round-trip Foundry test (`deposit → prove a spend natively via spend.circom's snarkjs prover → verify
   on anvil`) against the finalized key — the spike above proved the Halo2-KZG path's gas/deployability
   question is answered (unfavorably), not that a Groth16 contract has been built yet.
3. Ship `EvmClientPool.sol` as new, immutable, standalone bytecode targeting the Groth16 verifier; wire the
   §6 forwarder as a second small, unmodified-V1-composing contract.

**Methodology note, stated plainly:** the 504,095 gas figure and the EIP-170 finding are both measured, not
estimated — real proof, real pinned vk, real codegen, real compiler, real in-memory EVM execution, high
confidence. The Groth16 255k figure is unchanged from the original design pass: it is *derived*, not
separately re-measured this round, directly from the EIP-197 gas schedule and this circuit's already-known
public-input count (12) — the same derivation `Groth16Verifier.sol`'s own live, deployed gas cost already
confirms at a smaller scale (5 inputs). High confidence, but derivation rather than a fresh on-chain
measurement of *this* circuit's own Groth16 verifier, since that verifier does not exist yet (item 1 above).

## 9. Ceremony-free research pass (2026-09-26): does anything beat Groth16?

Four leads, run to ground before accepting §3b/§8's Groth16 call as final. Short answer up front:
**no — nothing found here beats Groth16's 255k gas + one-time ceremony, and the strongest evidence is that
the two production teams who tried hardest to make bespoke Halo2-on-EVM verification work at scale have
since moved away from it, converging on exactly the "one small fixed outer proof, arbitrary inner relation"
shape Tacit already built for the Bitcoin pool (`btc-pool-agg`) and already uses for V1's settle path
(SP1 → Groth16-wrapped → `ISP1Verifier`).**

### 9.1 Real production precedent — the industry moved away from bespoke Halo2-on-EVM, not toward it

**Scroll.** Scroll's original zkEVM proved with a two-layer KZG Halo2 stack and verified on Ethereum through
a small dispatcher contract, `Scroll: zkEVM Verifier V1`
(`0x585DfaD7bF4099E011D185E266907A8ab60DAD2D`, verified, Solidity 0.8.16, 1,036 B deployed bytecode) that
holds an immutable `plonkVerifier` address and delegates the actual check to a separate, large,
hand-optimized `PlonkVerifier` logic contract
(`0x4b8aa8a96078689384dab49691e9ba51f9d2f9e1`) — i.e., Scroll's own production answer to "the generated
verifier is too big for one contract" was exactly lead 3's split-across-contracts pattern (a thin
dispatcher + a separate monolithic verifier library), not a smaller codegen. That confirms the split is
real, load-bearing prior art, not a hypothetical.

But Scroll no longer runs that stack. Its **April 2025 "Euclid" upgrade deprecated the bespoke Halo2 zkEVM
circuits entirely** and replaced them with **OpenVM**, a Plonky3-based general-purpose STARK zkVM (built by
Axiom) — 90% lower batch-commitment cost, 4x throughput, and prover code the team says is easier to audit
than the hand-written Halo2 circuits it replaced (docs.scroll.io "Euclid Upgrade";
github.com/scroll-tech/scroll PR #1816, "upgrade zkvm-prover to … OpenVM v2.0 … halo2-gpu"). Crucially, the
*outer* on-chain check is still a Halo2-KZG-BN254 SNARK — but now it's a single, fixed, hand-built
aggregation/wrapping circuit around the STARK, not a bespoke verifier generated per zkEVM-circuit-shape.

**Taiko.** Same direction: Taiko has deprecated its own bespoke Halo2-KZG zk-EVM circuits in favor of a
multi-prover design running SGX plus general-purpose zkVMs (SP1, RISC Zero) that each independently attest
to the same state transition (docs.taiko.xyz FAQ; multiple 2025 Taiko architecture write-ups). Same move as
Scroll, same reason: a hand-written circuit shape you must re-verify on-chain per shape is worse than one
fixed outer verifier wrapping a general-purpose inner prover.

**Axiom.** Axiom is the one team still doing client-facing, circuit-shape-specific Halo2 work on Ethereum
(`axiom-crypto/axiom-eth`, built on `halo2-lib` + `snark-verifier`, "onchain computation proofs for EVM").
Its own public number for a query/aggregation proof verify is **"a fixed gas cost of around 300–500k"**
(per Axiom's own docs, restated in third-party summaries) — for a proof that itself already *aggregates*
many storage-slot/computation claims into one on-chain check. That is Axiom running the exact aggregation
shape lead 2 asks about, at a gas cost in the same band as Groth16, not meaningfully below it, and Axiom is
the party that built `halo2-lib`/`snark-verifier` and therefore had every opportunity to hand-tune the
codegen path Tacit's spike hit — the 300–500k figure is the ceiling of what that tooling gets you even in
its authors' own hands, not a floor Tacit's circuit failed to reach.

**Reading across all three:** the two teams running Halo2-on-EVM at the largest scale and for the longest
time (Scroll, Taiko) have both since routed around bespoke per-circuit Halo2 Solidity verifiers, converging
on "one fixed, hand-built outer wrap around a general-purpose inner prover" — the same shape as Tacit's
existing SP1-Groth16 settle path and the already-built `btc-pool-agg` pattern (§9.2). Axiom, the team still
doing it the "generic codegen against a specific circuit" way, reports gas in the same 300–500k band the
spike measured, not below it. This is a real, sourced signal that the spike's 504,095 gas number and
EIP-170 miss are not a Tacit-specific integration mistake — they're the same wall the best-funded teams in
this exact space hit, and the industry's fix was architectural (change what gets verified on-chain), not a
better codegen flag.

Sources: Scroll verifier contracts, Etherscan
(`etherscan.io/address/0x585DfaD7bF4099E011D185E266907A8ab60DAD2D`,
`etherscan.io/address/0x4b8aa8a96078689384dab49691e9ba51f9d2f9e1`); Scroll Euclid upgrade,
`docs.scroll.io/en/technology/overview/scroll-upgrades/euclid-upgrade/`; Scroll OpenVM/halo2-gpu PR,
`github.com/scroll-tech/scroll/pull/1816`; Taiko FAQ, `docs.taiko.xyz/resources/faq`; Axiom,
`github.com/axiom-crypto/axiom-eth`, `ethereum.org/developers/tools/snark-verifier-axiom`.

### 9.2 Aggregation — the highest-leverage lead, and it's already half-built in this repo

Halo2-KZG does have a native accumulation primitive that needs no new ceremony: **SHPLONK's multi-open
argument already produces a KZG accumulator** (a pair of G1 points that stand in for "these openings are
correct against this SRS"), and `snark-verifier`'s own purpose in the Scroll/Taiko/Axiom stacks is to
*consume* exactly that accumulator inside a **verifier circuit** — a Halo2 circuit whose statement is "N
inner Halo2-KZG proofs, all against the same pinned pot18-derived params, all verify" — so that N inner
proofs collapse to one accumulator check, still over the same SRS, no new randomness. This is the real
mechanism behind Axiom's 300–500k "many storage slots for one gas cost" number in §9.1: it is not free, but
it is genuinely sub-linear in N once N is large enough to amortize the ~300–500k fixed cost of the one
aggregation proof's own on-chain check.

**Tacit does not need to build this from scratch — a materially easier version of the same idea is already
built for the Bitcoin pool.** `contracts/sp1/confidential/btc-pool-agg/` (untracked, in progress) is an SP1
guest/host pair that:
- natively verifies N `btc-pool-halo2` (this exact circuit, same k=13, same 12 public inputs) proofs inside
  the zkVM, against the pinned `vk.bin`/`params-k13.bin` (`btc-pool-agg/guest/Cargo.toml`: vendors
  `halo2_proofs` v0.3.0 with a verifier-only fast-vk-read path, and routes the BN254 field arithmetic and
  final pairing through SP1's precompiles — `zkvm-mulmod`, the `sp1-patches/bn` substrate-bn fork);
- commits one aggregate statement over all N spends;
- wraps that guest proof to PLONK or Groth16 (`AGG_WRAP=plonk|groth16`) via the Succinct network, the same
  wrap Tacit's V1 settle path already produces and already verifies on Ethereum through the existing,
  live, immutable `ISP1Verifier` — no new on-chain verifier contract needed at all for this path, because
  the wrap target already has one.

This is a *stronger* answer than a hand-rolled Halo2 KZG-accumulator verifier circuit: it reuses
infrastructure Tacit has already built, pinned and (for the Bitcoin pool) is already wiring up, rather than
integrating a second unaudited piece of `snark-verifier` machinery (the "verifier circuit" + `AggregationCircuit`
API) on top of the one that already broke on codegen. The per-user marginal on-chain cost is the aggregate
wrap's fixed verify cost (SP1's own Groth16-wrap verify, same order as §3b's ~255k, per §7's existing table)
divided by N — at N = 10 that is already ~25k gas/user, well under Groth16's 255k; at N = 100 it is ~2.5k;
the fixed cost does not grow with N until SP1's own per-op/cycle cost for verifying N Halo2 proofs inside
the guest starts to dominate the batch's proving time (not its on-chain cost), the same batching trade-off
the existing swap-batch/relay design already lives with.

**No real measurement was taken in this pass** — `btc-pool-agg` is untracked, in-progress work for a
different pool (Bitcoin, off-chain acceptance by indexer replay, not an EVM contract), and its host/guest
have not been run end-to-end or profiled for cycle count at any N. Building the EVM-side analogue (same
guest pattern, but the wrap target is `EvmClientPool.sol`'s own `spend()` via `ISP1Verifier`, called by a
relayer with N spends' worth of nullifiers/leaves as the aggregate's public commitment) is real but
substantially *de-risked* engineering — the vendored halo2 verifier-in-SP1 crate, the pinning, the wrap
tooling and the on-chain SP1 verifier all already exist; what's new is one more guest statement (verify N
`btc-pool-halo2` proofs against the *EVM* pool's tree/nullifier state instead of the Bitcoin pool's) and the
relayer-side batching logic.

**Non-negotiable, restated for this pool exactly as for the Bitcoin one:** aggregation is optional relayer
compression only. A user must always be able to call `EvmClientPool.spend()` directly with their own single
proof and pay the full Groth16 (or, if ever shipped, Halo2-KZG) verify cost themselves — nothing about this
pool ever requires routing through a relayer or an aggregator to get a valid spend included.

### 9.3 A purpose-built (non-generic) verifier — real prior art exists, but it's archived and unaudited

`privacy-scaling-explorations/halo2-solidity-verifier` (now moved to `privacy-ethereum/halo2-solidity-verifier`)
is exactly the kind of non-generic tool lead 3 asked about: a from-scratch Rust codegen for Halo2-KZG
Solidity verifiers, explicitly built to fix `snark-verifier`'s problem — its own README states the reason
for existing is that `snark-verifier`'s Solidity generator "receives only unoptimized, low-level operations"
and "currently unrolls all assembly codes," which is the same root cause the spike found (hardcoded absolute
memory offsets, no via-IR path). This tool generates cleaner, higher-level Solidity, explicitly supports
splitting the verifier and verifying-key into separate contracts (directly addressing the size problem via
the same split-contract pattern Scroll's production verifier already uses, §9.1), and claims comparable or
slightly better gas than `snark-verifier`.

**It is not viable for Tacit today.** As of this pass the repository is **archived (read-only since
2026-08-17)**, its own README states it was "not yet intended for a production environment," it is
**unaudited**, and its maintainers' own recommendation for production use is to fall back to the audited
`snark-verifier` — the exact tool whose codegen already failed the EIP-170/via-IR test in the spike. It also
supports only KZG (matching this circuit) but is limited to "≤1 instance column, no rotated queries to it" —
worth checking against `btc-pool-halo2`'s actual instance-column shape if this were ever revisited, but moot
given the archival status.

**Hand-writing a bespoke verifier for this one fixed circuit (12 public inputs, k=13, never changes) is not
a small, well-scoped task** — it is real cryptographic-Solidity engineering: correctly implementing SHPLONK's
multi-open argument, the Fiat-Shamir transcript, the permutation/lookup argument evaluations and a
BN254 MSM, by hand, for a protocol whose own reference implementation needs ~2,000 lines of generated Yul
per the spike's own 35,645-byte output. This is a multi-week project with real correctness risk (an
under-constrained hand-written verifier is exactly the kind of bug class audits exist to catch), not a
quick win, and the realistic payoff — even a well-executed hand verifier — is unlikely to beat Groth16's
255k by enough to justify the risk and audit cost, since Halo2-KZG's SHPLONK check is inherently a bigger
on-chain object than Groth16's fixed 4-pairing check (more commitments, more field evaluations) regardless
of how tightly the Solidity is written. **Verdict: not attempted, correctly out of scope for this pass, and
not recommended as a near-term follow-up either.**

Sources: `github.com/privacy-scaling-explorations/halo2-solidity-verifier` (archived; also mirrored at
`privacy-ethereum/halo2-solidity-verifier`).

### 9.4 Halo2-IPA — derived, not measured, and it is not close

No IPA-based on-chain Halo2 verifier for a circuit this shape was found measured anywhere (Zcash Orchard's
own IPA verifier runs client-side, never on Ethereum — Orchard's own transparent design target was a chain
with no pairing precompile at all, i.e. not this one). The reason nobody has measured it is structural, and
derivable directly from how Bulletproofs-style IPA verification works, which Halo2-IPA inherits unchanged:

- The verifier folds the proof over k = log2(n) rounds (k = 13 for this circuit's 2^13-row domain), each
  round costing O(1) group operations to derive a challenge and combine `L_i`/`R_i` — cheap, and this part
  *is* genuinely logarithmic.
- But the final check requires evaluating a linear combination over the *original* n = 2^13 = 8,192 basis
  generators, with coefficients (`s_i`, products of the round challenges) that are known at verify time but
  still require an n-term multi-scalar multiplication to actually check the opening — there is no pairing
  trick (as KZG has) to collapse this to a handful of pairings, because IPA's whole point is to avoid needing
  a pairing-friendly curve or a trusted setup. This is exactly what the community consensus found in §research
  states plainly: Halo2-IPA's "verifier's work is not polylogarithmic," which is precisely this n-term MSM.
- Costing that MSM on Ethereum with the EIP-197 precompiles (`ecMul` 6,000 gas, `ecAdd` 150 gas, per
  EIP-1108's post-Istanbul repricing) gives **8,192 × (6,000 + 150) ≈ 50.4M gas** for the final check alone,
  before the k = 13 rounds' own group operations or the rest of the protocol (permutation argument,
  lookups). That is roughly **2x Ethereum's entire per-block gas limit** (~30–45M as of 2026) for one
  proof — not "more expensive than Groth16," but categorically infeasible for a single transaction,
  regardless of how the rest of the protocol is optimized.
- This matches why PSE's own Halo2 fork (the one this circuit already uses) swapped Orchard's IPA backend
  for KZG specifically for EVM verifiability — a design decision already made by the tooling this repo
  depends on, for exactly this reason, before Tacit ever touched it.

**This estimate is derived, not measured** — no IPA verifier for this circuit was built or run in this pass,
and it did not need to be: the gap between ~50M gas and a 30–45M gas block limit is large enough that no
plausible optimization (better MSM batching, Ethereum's variable EIP-1108 pricing, precompile improvements)
closes it by 2x, let alone brings it near Groth16's 255k. Zero-ceremony is real, but it buys nothing if the
proof cannot be verified in a single Ethereum block at all.

Sources: EIP-197 (`eips.ethereum.org/EIPS/eip-197`) and EIP-1108 (`eips.ethereum.org/EIPS/eip-1108`) for the
`ecMul`/`ecAdd` gas schedule; Bulletproofs (Bünz, Bootle, Boneh, Poelstra, Wuille, Maxwell, 2017) and the
Halo2 book for the IPA verifier's O(n) final-check structure; community summary on Halo2-IPA's on-chain
infeasibility (search result, §9.1's sources).

### 9.5 Final recommendation

**Groth16 (§3b) remains the right call. Nothing found in this pass beats it, and the research raises the bar
for confidence rather than lowering it:**

1. Halo2-KZG's generic-codegen path (§3a/§8) is confirmed dead on two independent axes (gas, EIP-170), and
   the production precedent (§9.1) shows the two teams who scaled bespoke Halo2-on-EVM the hardest have
   since abandoned that exact shape for the same reasons.
2. The one real lever that could beat Groth16 — aggregation (§9.2) — is real, has a KZG-native mechanism,
   and is genuinely sub-linear per user at scale, but Tacit's fastest, lowest-risk path to it is *not* a new
   Halo2 aggregation circuit — it is the SP1-guest aggregation pattern already half-built for the Bitcoin
   pool (`btc-pool-agg`), reusing V1's live `ISP1Verifier` instead of adding a second on-chain verifier
   contract. This is real future work, clearly scoped, and strictly optional relayer compression — a single
   user's own proof must always verify alone, at the Groth16 cost, with no aggregator required.
3. A purpose-built verifier (§9.3) has real prior art, but that prior art is archived, unaudited, and its own
   maintainers recommend against it for production; hand-writing one is multi-week, real-risk work unlikely
   to beat Groth16 by enough to matter.
4. Halo2-IPA (§9.4) is not a cost trade-off question at all — it is roughly 2x Ethereum's block gas limit
   for one proof, derived directly from IPA's O(n) final multi-scalar-multiplication and the EIP-197/1108
   precompile schedule. Zero ceremony, but unusable at any price.

**Ship §3b/§8's plan (Groth16, own phase-2 ceremony, reusing Tacit's existing coordinator) as the pool's
launch verifier.** Track §9.2's SP1-aggregation path as real, concrete follow-up work — worth building once
the Bitcoin pool's `btc-pool-agg` pattern is proven end-to-end, since it would let a relayer optionally
amortize verify cost across users without touching `EvmClientPool.sol`'s core guarantee that a lone user's
own proof is always sufficient on its own.
