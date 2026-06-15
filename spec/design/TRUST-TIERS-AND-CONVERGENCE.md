# Trust Tiers & Convergence

Status: design note (architecture + roadmap). Non-normative — it organizes
the existing spec; it does not change any opcode or invariant.

## Why this note

The protocol has grown by amendment. The core confidential-UTXO model
(Pedersen commitments + BP+ range proofs + Mimblewimble kernel signatures +
`asset_id = SHA256(reveal_txid ‖ vout)`) is one coherent, self-consistent
system. Around it, several features have been added with **different trust
models** and, in a few cases, **overlapping scope**. This note makes the trust
tier of each feature explicit so nothing reads as trustless that isn't, and
sketches the convergence path that would collapse the redundancy.

## The three tiers

**Tier 0 — trustless, proven.** Correctness follows from on-chain verification
(an SP1 Groth16 proof and/or a Bitcoin kernel signature) plus the relay
anchoring. No off-chain party is trusted for soundness. Liveness may still
depend on a prover/relay being run.

**Tier 1 — indexer-attested (pilot).** A single non-consensus worker maintains
authoritative state (e.g. AMM pool reserves/shares). Soundness of *value
conservation* may be proven, but at least one binding or the aggregate state is
worker-attested or client-only. Gated off mainnet until the consensus path
closes.

**Tier 2 — self-custody / externally-insured.** The protocol cannot *prevent*
the failure mode at its own layer; it *detects* it and pushes *coverage* to an
external, governable mechanism. Trustlessness is conditional on that mechanism.

## Feature → tier

| Feature | Tier | Basis |
|---|---|---|
| CETCH / T_MINT (confidential etch + mintable supply) | 0 | range proof + issuer Schnorr over an anchored message; asset_id = f(txid) |
| T_PETCH / T_PMINT (fair-launch) | 0 | cap counted at depth ≥ 3 in canonical order; envelope-level invariants |
| T_DROP / T_DCLAIM (claim pool) | 0 | kernel sig (deposit) + depth-3 canonical cap count (credit set) |
| T_DEPOSIT / T_WITHDRAW (mixer) | 0 | kernel sig + nullifier set + reserve floor (#spent ≤ #leaves) |
| Confidential pool settle (CXFER/AXFER/SWAP/LP/OTC/BID) on EVM | 0 | SP1 proof of the op loop; amounts bound by opening sigmas |
| Reflection bridge mint (Bitcoin burn → EVM supply) | 0 | dedicated burn set + `v_mint == v_burn` kernel + relay-anchored confirmation ≥ `REFLECTION_CONFIRMATIONS` |
| EVM-AMM LP add (`OP_LP_ADD`) | 0 | share derived in-guest; deposits membership- + opening-bound; floor-rounded |
| cBTC.zk mint (`fold_cbtc_lock`) | 0 (mint) | note Pedersen-bound to the confirmed lock's real `v_btc`, 1:1 |
| Bitcoin-side AMM (`T_LP_ADD 0x2D` …) | 1 | deposit conservation proven by kernel sigs, but pool reserves/shares are worker-attested and the share-commitment value-binding + range are client-Groth16 only |
| tETH bridge (`0x60–0x65`) | 0/1 | Tornado-shape mixer with its own circuit/verifier/relay; separate set + trust surface from the confidential pool |
| cBTC.zk peg (the *backing*, not the mint) | 2 | self-custody lock is the locker's own key-path UTXO; a reclaim is detected (backing decremented, INV-1 flagged), coverage via the cBTC.tac bond |
| cBTC.tac bond | 2 | over-collateralized, governable; explicitly not trustless (MakerDAO-shape) |

Each Tier-1/Tier-2 feature is already gated off mainnet or labeled
non-trustless in its amendment. The point of the table is that the
*system-level* trust story is **feature-dependent**, and should be read tier by
tier rather than as a single "trustless" claim.

## Redundancy & convergence

Three feature pairs overlap. In each, the more general system functionally
subsumes the special-purpose one; keeping both means two soundness surfaces,
two circuits/verifiers, and two recovery paths.

1. **tETH bridge ↔ confidential-pool reflection bridge.** The pool is
   multi-asset with arbitrary confidential amounts; the tETH bridge is
   single-asset, fixed-denomination, Tornado-shape. The pool generalizes the
   *function*. They already share the burn verifier. They remain complementary
   while the tETH set is the mainnet-proven ETH path and the pool bridge is on
   the pilot deployment, because the Tornado *fixed-denomination anonymity set*
   is a distinct privacy property the pool's amount-hiding does not directly
   replicate. **Convergence target:** re-express ETH as a confidential-pool
   asset (optionally over a denomination ladder to preserve the set property),
   then retire `0x60–0x65`.

2. **Bitcoin-side AMM (`0x2D…`, Tier 1) ↔ EVM-AMM (`OP_LP_ADD`, Tier 0).** Same
   constant-product math (`isqrt` first-mint, min-share, `MINIMUM_LIQUIDITY =
   1000` on both sides). The EVM path proves it; the Bitcoin path defers the
   value-binding + range to a client Groth16 and trusts the worker for pool
   state. **Convergence target:** route AMM through the proven (Tier-0) path, or
   bring the Bitcoin AMM's pool state under a proof so it reaches Tier 0.

3. **cBTC.tac (Tier 2 bond) ↔ cBTC.zk (Tier 0 mint / Tier 2 peg).** These are
   complementary by design (one is TAC-collateralized, one is real-BTC
   self-custody) rather than redundant, but they should be presented as the two
   halves of one peg story with their tiers stated, since cBTC.zk's
   trustlessness is conditional on the cBTC.tac buffer's adequacy.

## tETH → confidential-pool migration readiness

The migration target is **already built and sound** — no new protocol code is
required to move the tETH concept from the dedicated mixer into the pool:

- **Raw-ETH support exists and is audited.** `underlying == address(0)` is the
  native-ETH sentinel; `wrap` is `payable` and escrows `msg.value`, binding the
  note to `value = amount / unitScale` (so a note can never claim more than was
  escrowed); `_payout` releases ETH via `forceSafeTransferETH` under an escrow
  floor + checks-effects-interactions + the settle reentrancy guard. Fee-on-
  transfer ERC20s are rejected at the boundary.
- **Bidirectional bridging exists.** ETH in via `wrap`, out via unwrap/`_payout`,
  Ethereum↔Bitcoin via the reflection bridge + `crossChainLink`/`localAssetOf`
  resolution (all proven paths).
- **Registration is permissionless** (the pool has no owner). Migration is an
  operational flow: register native ETH (and/or the tETH ERC20) once, then users
  `wrap` (or redeem tETH → ETH → `wrap`). The Tornado fixed-denomination
  anonymity set is the one privacy property to preserve in the move (optionally
  run ETH over a denomination ladder).

Operational note (one-time, low severity): the wrapped-asset id is
`sha256("tacit-evm-token-v1" ‖ chainid ‖ underlying)` — a function of
`underlying` only — and registration is **first-write-wins on `unitScale`**. A
front-run can lock a suboptimal-but-bounded granularity for native ETH (not
fund-losing: `unitScale ∈ (0, 10^18]`). Register native ETH at the intended
scale early; a future redeploy should fix `unitScale` to a constant for
`address(0)` to remove the front-run entirely.

## Correctness items to close before promotion

These are tracked items, not live exploits. Each should be closed before the
relevant feature moves from a gated/draft state toward mainnet. The slot/cBTC
items are NOT drop-in fixes — each has a design dependency, noted inline.

- **AMM (Bitcoin path) → Tier 0:** bring pool reserves/shares under a proof (or
  a consensus indexer), and move the share-commitment value-binding + the
  `[0, 2^64)` range check from the client Groth16 into the consensus path.
- **cBTC.zk fungibility — enforce §5.24.6.** The `T_SLOT_SPLIT` / `T_SLOT_MERGE`
  cross-asset rule (an output wrapper may differ from the input only if both
  declare the same `underlying` + `peg`, with `denom_new ==
  metadata.custody.denom_sats`) is emitted by the encoder but enforced by no
  validator. Value is Bitcoin-conserved, so it is neutral while every
  `self_custody_slot` wrapper shares the BTC underlying. **Dependency:** a slot's
  `asset_id` is caller-supplied at mint (not derived from `denom`), so the rule
  needs a general `self_custody_slot` wrapper registry ({underlying, peg,
  denom_sats}) to validate against — only a hardcoded cBTC.tac tier list
  (`ctacVariantAssetId`) exists today. **Safe interim:** restrict SPLIT/MERGE to
  same-`asset_id` outputs (rejects every cross-wrapper relabel; re-open cross-
  tier splits once the registry lands). Must be enforced before any non-BTC
  wrapper is registered and before cBTC.zk mainnet.
- **cBTC.zk peg — backing coverage.** There is no hard `supply ≤ backing` rule
  (it is detection-time only). **Design reality:** cBTC.zk is self-custody — the
  backing is the locker's own key-path UTXO, so a reclaim happens on Bitcoin and
  **cannot be prevented on the EVM side**; a settle-side floor cannot stop it.
  The meaningful guarantee is a **buffer-coverage invariant** (`supply ≤ backing
  + buffer_capacity`) enforced in the cBTC.tac buffer layer, with a sized,
  governable policy. Promotion past the pilot should make that coverage explicit
  rather than detection-only.

## Reading guide

When evaluating a claim about the protocol, resolve it to a tier first:
- a Tier-0 claim is enforced by a proof/signature on chain;
- a Tier-1 claim trusts the worker for the attested aggregate;
- a Tier-2 claim is insured, not prevented.

The trustless core (Tier 0) is the foundation; the convergence work above is
about pulling the periphery toward it and shrinking the surface, rather than
adding more parallel systems.
