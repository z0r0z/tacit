# Audit Prompt — Tacit V1 Mainnet Bug-Hunt (Security & Privacy)

**Goal:** Find fund-critical and privacy-critical defects that must block a V1 mainnet
launch. You are gating real user funds. Bias toward concrete, exploitable findings over
style nits. Read the code; do not assume the comments or test names are correct.

---

## 1. What the system does (threat model in one paragraph)

Tacit is a confidential cross-chain DeFi suite spanning **Ethereum and Bitcoin**. Users
trustlessly bridge assets both directions, then transact privately: p2p transfers, LP,
yield farming, CDP vaults, OTC, and AMM trading. Value is held as **bearer notes**
(commitments in a Merkle note tree; spending = knowledge of a blinding factor `r` proven
by an opening sigma, *not* an on-chain owner check). State transitions are validated by an
**SP1 (RISC-V zk) guest** whose proof the on-chain contracts verify; cross-chain events
are folded in via a **reflection** mechanism anchored to a **Bitcoin light client**. The
adversary may be: any user, a malicious **relayer/box/settler** (sees note blindings for
gasless ops), a malicious **prover** (controls guest witness inputs), or a chain
reorg/finality attacker. Assume all off-chain actors are hostile and all public calldata
is observable.

## 2. Primary attack questions

For every finding, answer: *who profits, how much, and what exact call sequence?*

1. **Inflation / unbacked mint** — can any path mint a note, ERC-20, cUSD, cBTC, or
   reward whose value is not backed by an equal debit/escrow? (historic bug class here)
2. **Double-spend / nullifier bypass** — can a note/UTXO/Bitcoin-burn be consumed twice,
   across lanes, or across pool generations? Is every nullifier `ν` bound to exactly what
   it should be (asset, outpoint/vout, commitment)?
3. **Theft / redirection** — can a relayer, settler, or third party redirect a recipient,
   inflate a fee, or spend a note without the opening sigma? Are *all* opening sigmas
   present on outputs (claim, unwrap, swap, LP, OTC, bid, CDP, farm)?
4. **Reflection / bridge forgery** — can a malicious prover forge a folded Bitcoin or
   Ethereum event (fake burn→mint, forged prior-consumed root, witness/wtxid swap that
   keeps txid)? Is block inclusion bound to the *witness-committed* tx, not just txid?
5. **Reorg / finality** — what depth of reorg breaks custody or unlocks double-credit?
   Distinguish accept-and-document from genuine fund-locks/-thefts.
6. **Accounting conservation** — for each lane (pool, engine, farm, AMM, CDP, bridge):
   does Σ(credits) == Σ(debits) under partial fills, fees, refunds, and failure paths?
7. **DoS / fund-lock** — can an attacker permanently brick a pool, exhaust the note tree,
   lock principal, or grief escrow/refund paths? (griefing-only ≠ won't-fix; rank it)
8. **Privacy leaks** — what does on-chain calldata + event metadata + net value flow let
   an observer correlate (sender↔recipient, amount, position, cross-lane linkage)?
   Distinguish protocol leaks from unavoidable public-DeFi metadata.

## 3. Files in scope (the audit surface)

### Solidity — on-chain (read in this priority order)
- [ConfidentialPool.sol](../contracts/src/ConfidentialPool.sol) (2319 L) — **core**: note
  tree, nullifier set, proof verification, deposit/withdraw, settle/relay dispatch,
  reflection slots, AMM/swap, bridge mint. Highest fund-risk; spend the most time here.
- [ConfidentialRouter.sol](../contracts/src/ConfidentialRouter.sol) (1299 L) — op
  assembly, wrap-permit, zap, fee/affiliate routing, CDP-intent calldata offsets.
- [CollateralEngine.sol](../contracts/src/CollateralEngine.sol) (853 L) — CDP vaults:
  mint/topup/close/liquidate cUSD; stability-fee/TSR accumulators (dormant-by-design —
  verify they are truly inert and inflation-safe).
- [lib/BitcoinLightRelay.sol](../contracts/src/lib/BitcoinLightRelay.sol) (547 L) —
  finality root for both bridges; difficulty/retarget, reorg gate, genesis target guard.
- [FarmController.sol](../contracts/src/FarmController.sol) (282 L) — yield farm escrow,
  reward-rate accounting, harvest/unbond; confirm no unbacked-reward drain.
- [CanonicalAssetFactory.sol](../contracts/src/CanonicalAssetFactory.sol) (234 L) —
  deterministic asset registration; metadata-attestation / auto-register path.

Secondary (read if a primary file calls into them or trust crosses the boundary):
[TacitRelayer.sol](../contracts/src/TacitRelayer.sol),
[CanonicalMinters.sol](../contracts/src/CanonicalMinters.sol),
[CanonicalBridgedERC20.sol](../contracts/src/CanonicalBridgedERC20.sol),
[SP1PoolRootVerifier.sol](../contracts/src/SP1PoolRootVerifier.sol),
[BtcCallExecutor.sol](../contracts/src/BtcCallExecutor.sol),
[ChainlinkEthBtcAdapter.sol](../contracts/src/ChainlinkEthBtcAdapter.sol).

### Rust — SP1 guest & cross-chain core (the trust root for all value rules)
- [src/main.rs](../contracts/sp1/confidential/src/main.rs) (3274 L) — guest op dispatch
  (transfer/swap/LP/OTC/bid/CDP/farm/unwrap/claim/refund/stealth). Verify *every* op
  binds its outputs with an opening sigma and conserves value.
- [cxfer-core/src/lib.rs](../contracts/sp1/confidential/cxfer-core/src/lib.rs) (7072 L) —
  shared leaf/commitment/nullifier construction, canonical vout/outpoint helpers.
- [src/reflect.rs](../contracts/sp1/confidential/src/reflect.rs) — reflection fold; cross-
  cycle anchoring of consumed-root / finalized-slot (forged-prior attack lives here).
- [cxfer-core/src/eth_reflection.rs](../contracts/sp1/confidential/cxfer-core/src/eth_reflection.rs)
  — Ethereum-side reflection accumulator & freshness.
- [cxfer-core/src/bitcoin.rs](../contracts/sp1/confidential/cxfer-core/src/bitcoin.rs)
  (2714 L) — taproot envelope extraction, txid/merkle inclusion, **witness-commitment**
  (BIP141 wtxid) checks. Confirm inclusion binds the witnessed tx.
- [cxfer-core/src/burn_deposit.rs](../contracts/sp1/confidential/cxfer-core/src/burn_deposit.rs),
  [cxfer-core/src/sigma.rs](../contracts/sp1/confidential/cxfer-core/src/sigma.rs),
  [cxfer-core/src/bjj.rs](../contracts/sp1/confidential/cxfer-core/src/bjj.rs),
  [src/swap_batch.rs](../contracts/sp1/confidential/src/swap_batch.rs) — sigma/curve/batch
  primitives; check soundness of the opening-sigma and batch-aggregate logic.

**Critical cross-check:** the guest enforces the value rules; the contracts trust the
proof. A finding is only real if it survives *both* layers — verify the contract doesn't
re-check what you think the guest checks, and vice-versa. Confirm the on-chain
program/relay **vkey** is pinned to the committed ELF.

## 4. Method (token-efficient)

1. Build the value-flow map first: for each lane, list every credit and every debit and
   where each is authorized (contract vs guest). Conservation gaps fall out of this.
2. Trace nullifier/commitment construction end-to-end (guest build → contract store) for
   each op; tabulate exactly what each `ν` binds. Mismatches across ops = double-spend.
3. For each op, confirm an opening sigma binds *every* spendable output (recipient + fee).
4. Adversarially walk the reflection/bridge path: forge each witnessed input in turn.
5. Only after the above, sweep DoS/griefing and privacy/metadata leakage.

Tests are reference, not ground truth: [contracts/test/](../contracts/test/) has
per-op `*ProofReal.t.sol`, `ConfidentialPoolInvariant.t.sol`, fuzz, and KAT suites — use
them to confirm a suspected path, but assume coverage gaps exist.

## 5. Output format

Group findings by severity: **Critical** (fund loss / inflation / theft) → **High**
(lock/double-spend conditional) → **Medium** → **Low/Info** → **Privacy**. For each:

- **Title** — one line.
- **Location** — `file:line` (both layers if it spans guest+contract).
- **Class** — inflation / double-spend / theft / forgery / reorg / DoS / privacy.
- **Exploit** — concrete call sequence; who profits and how much.
- **Why it survives existing checks** — what the guest and contract each fail to enforce.
- **Fix** — minimal, correctness-first (re-prove is a mechanical box step; do not bias the
  fix toward proving convenience).
- **Confidence** — and what would falsify it.

End with a **launch verdict**: blockers only, or green-light. No external-audit-firm or
process recommendations — findings and fixes only.
