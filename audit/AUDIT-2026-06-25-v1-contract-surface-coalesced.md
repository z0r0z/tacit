# Tacit v1 — Contract-Surface Security Review (Coalesced)

**Scope:** value preservation, double-spend, inflation, drain, bricking, griefing, math/economics, and
cross-contract / contract↔prover integration across the Tacit v1 confidential-pool and cross-chain
protocol, ahead of the Sepolia launch and mainnet greenlight.

| | |
|---|---|
| **Protocol** | Tacit — confidential DeFi + trustless BTC↔ETH bridge |
| **Repository** | `tacit` |
| **Branch** | `confidential-relay-fees` |
| **Base commit** | `4d53bb97edbd6775bb8db2bab2c1097d90f7967e` (`4d53bb9`, 2026-06-25) |
| **Review date** | 2026-06-25 |
| **Reviewer** | Claude Code — Opus 4.8 (1M context) |
| **Method** | Parallel per-cluster review (5 streams) + targeted re-verification of each flagged item and of the two flagship cross-chain questions, against the Solidity sources and the SP1 guest/reflection code they integrate with. |

---

## 1. Executive summary

This is a holistic review of the twelve core v1 contracts and their integration with each other and with
the SP1 guest/reflection prover, focused on the **sanctity of user funds and accounting**: no path may
inflate supply, drain backing or escrow, double-spend a note (including the cross-lane case), double-count a
leaf / share / debt, redirect a payout, or forge a cross-chain event — and the only trusted surface is the
clearly-scoped DAO governance of the collateral engine.

**Result:** no fund-critical defect was found on any reviewed surface. Value preservation against
double-spend, inflation, drain, and redirection is enforced in-proof and re-checked on-chain; decimal
conversion (8-dec Bitcoin-native ↔ 18-dec Ethereum ↔ 6-dec stablecoins) is exact and dust-rejecting in both
directions; and the historically-tracked risk classes (cross-chain event authenticity, the relay-fee legs,
unfunded-reward issuance, cross-asset registration) are confirmed closed in source. The items below are
operational, governance, and minor-robustness findings; one small contract hardening and two regression
tests were added in this review.

**Readiness:** sound for the capped v1 launch with no fund-critical blockers on source value-conservation,
conditional on the project's already-planned **coordinated re-prove + redeploy** — the guest-resident gates
are enforced on-chain only once the new verification keys are pinned to the committed ELF and the pool is
redeployed (a mechanical proving step, no new trusted setup).

**Findings at a glance**

| ID | Severity | Area | Status |
|----|----------|------|--------|
| M-1 | Medium | TacitRelayer — stranded-balance routing semantics | ◻ Documented (by design; warning already in source) |
| M-2 | Medium | Reflection attest — per-batch array width vs block gas | ◻ Bounded prover-side (batch-width cap) + documented |
| M-3 | Medium | Farm reward notify vs treasury funding (ESCROW mode) | ◻ Documented (fail-closed pool-side; funder responsibility) |
| M-4 | Medium | Collateral engine — dormant deviation guard / escrow margin call | ◻ Documented (arm post-launch; dormant ≡ audited path) |
| M-5 | Medium | MerkleDistributor — under-funding surfaced late | ✅ Resolved (one-shot funding latch) |
| L-1 | Low | Auto-register unit-scale heal edge | ◻ Accepted (sound by construction; documented in source) |
| L-2 | Low | LP-operator approval is all-or-nothing | ◻ Documented (standard operator-approval model) |
| L-3 | Low | Router CDP-intent calldata offset is layout-coupled | ✅ Resolved (regression test pinning the offset) |
| — | Info | Engine view-revert, executor record idempotency, Permit2 default, sweep clawback | ◻ Accepted / documented |

---

## 2. Scope — surfaces reviewed

**Smart contracts**
- `contracts/src/ConfidentialPool.sol` — the on-chain value engine (settle, payouts, escrow, nullifier set, reserve floor, AMM/LP loops, bridge + cBTC gates, lock/CDP trees, reflection attest)
- `contracts/src/ConfidentialRouter.sol` — non-custodial single-tx zap / wrap-permit / LP router
- `contracts/src/TacitRelayer.sol` — optional permissionless batching + fee-forwarding utility
- `contracts/src/CollateralEngine.sol` — cBTC escrow gate + cUSD CDP controller + (dormant) stability fee / savings rate
- `contracts/src/FarmController.sol` — reward-per-share LP farm controller
- `contracts/src/ChainlinkEthBtcAdapter.sol` — ETH/BTC price adapter (derived from ETH/USD ÷ BTC/USD)
- `contracts/src/lib/BitcoinLightRelay.sol` — Bitcoin header-chain finality root
- `contracts/src/BtcCallExecutor.sol` — value-free Bitcoin-authorized EVM call executor
- `contracts/src/CanonicalAssetFactory.sol`, `contracts/src/CanonicalBridgedERC20.sol`, `contracts/src/CanonicalMinters.sol` — canonical token issuance + mint authority
- `contracts/src/MerkleDistributor.sol` — public-ERC20 airdrop distributor

**Prover / integration (read for contract↔guest coherence)**
- `contracts/sp1/confidential/src/{main.rs,reflect.rs}` — settle + reflection guests
- `contracts/sp1/confidential/cxfer-core/src/{lib.rs,bitcoin.rs,burn_deposit.rs}` — shared kernel, header/witness verification, burn-deposit provenance
- `contracts/sp1/confidential/elf-vkey-pin.json` — ELF ↔ verification-key pinning

Out of scope (per request): the tETH alpha bridge mixer (`sp1/program`, `sp1/tree`).

---

## 3. Value-preservation properties confirmed

The following are enforced by construction and were re-verified in source; they are the backbone of the
greenlight:

- **No inflation on wrap / mint.** A wrap binds the deposit id to `value = amount / unitScale`, and the
  guest re-derives the same id and proves the commitment opens to `value`; the guest never sees `unitScale`,
  so it cannot inflate. Cross-chain mints can only create a note against a proven, consumed Bitcoin burn.
- **No drain on unwrap / payout.** Payout scales by the trusted on-chain `unitScale`, is fail-closed on
  escrow, and is checks-effects-interactions ordered with a non-reverting transfer so one recipient cannot
  stall a batch.
- **Fees are bound in the proof.** Settler/relayer fees are committed in-proof with `fee ≤ value` and the
  recipient bound into the opening context; an untrusted relayer or settler cannot redirect a recipient or
  inflate a fee.
- **Double-spend prevention** across namespaced nullifier / lock / position / bridge / cBTC sets, with the
  cross-lane spent-root pin and a consume-count freshness gate, plus a global no-inflation reserve floor
  (`evmNullifiersSpent ≤ nextLeafIndex`).
- **Cross-chain event authenticity.** Folded Bitcoin effects are gated by full-block txid completeness
  **and** BIP-141 witness-commitment verification before any envelope is trusted, then anchored to a matured
  canonical relay tip. This closes the witness-substitution class for burns, mints, cBTC locks, and
  value-free calls.
- **Decimal correctness.** `unitScale = 10^(18 − tacitDecimals)`; 8-dec native and cBTC use `10^10`, 6-dec
  stablecoins use `1`; registration rejects any scale that disagrees with the token's on-chain `decimals()`,
  and wraps reject non-multiples (dust) of the scale. Round trips are lossless both ways.
- **Canonical-asset authority.** Each canonical ERC20's `MINTER` is immutable to the pool; the factory's
  CREATE2 salt binds the full identity tuple so an impostor deploys at a different address; the pool's
  shared-id link is first-write-locked. A non-canonical token cannot be resolved as backing.

---

## 4. Findings

### M-1 — TacitRelayer stranded-balance routing *(documented; by design)*

The relayer keeps no per-account accounting and custodies nothing — its entire balance is treated as
distributable relay fees, forwarded to the recipients of the next caller. This is the intended model: it
enables batching, atomic profitability, and a free-rescue path for any stranded balance, and it cannot touch
user value (fees are proof-bound). The single operational caution — never address an in-system *withdrawal*
recipient to the relayer — is already documented prominently in the contract header. **No code change;**
confirm the launch dapp never routes a withdrawal recipient to the relayer.

### M-2 — Reflection attest per-batch array width *(bounded prover-side)*

`attestBitcoinStateProven` iterates over the proven per-batch arrays (folded/spent/redeemed cBTC locks,
attested metas, folded calls). The proof is verified before the loops run, so contents are honest; the
residual is liveness only — a very wide legitimately-proven batch could approach the block gas limit. The
pool is at its EIP-170 size budget, so the appropriate control is a **batch-width cap in the prover/box**
(the party that chooses batch width) plus this note, rather than added on-chain bounds. Fail-closed: an
oversized batch reverts, it cannot mis-account.

### M-3 — Farm reward notify vs treasury funding *(documented; fail-closed)*

In ESCROW-mode farms, governance sets the reward rate; the harvest path debits the per-controller farm
treasury on the pool side and reverts if it is insufficient, keyed off the guest-bound reward leg rather
than controller state. So an over-notified, under-funded farm cannot mint unbacked rewards or reach another
farm's treasury — the blast radius is limited to that farm's own undistributed rewards, with staker
principal recoverable via unbond. Governance is the farm's funder; the fund-before-notify expectation is the
documented operator responsibility. **No code change.**

### M-4 — Dormant deviation guard / escrow margin call *(documented; arm post-launch)*

The collateral engine ships with the second-source price-deviation guard and the escrow margin-call
enforcement **dormant** by default. Verified: both are owner/DAO-gated, each is independently fail-closed,
and there is no half-armed state (the margin-call path requires both a non-zero maintenance ratio and a wired
enforcement module, with cross-invariant guards against arming an instantly-enforceable ratio). Dormant is
equivalent to the audited single-source path. These are post-launch hardening toggles (a deep TWAP pool /
audited enforcement module are prerequisites); capture arming in the launch runbook. **No code change.**

### M-5 — MerkleDistributor under-funding surfaced late *(resolved)*

The distributor committed an allocation total but had no on-chain check that it was funded to that total, so
an under-funded or over-allocated drop would only surface when a later claim ran the balance dry. **Fix:** an
immutable `EXPECTED_TOTAL` plus a one-shot `opened` latch — the first claim opens the drop only when the
contract holds at least the committed total; until then every claim reverts `NotFunded`, so a misfunded drop
fails deterministically up front. After opening, the balance falls normally as recipients claim. The deploy
script threads the committed total into the constructor. Locked with tests (under-funded → top-up → opens;
latch stays open as balance falls; zero-total guard). Distributor suite 14/14 + parity green.

### L-1 — Auto-register unit-scale heal edge *(accepted; sound by construction)*

When guest-proven metadata heals the cross-chain link of a canonical token that was previously
self-registered, it adopts the guest-proven scale. This is safe because the canonical token is pool-minted
(its only mint authority is the pool) and holds no escrow, so a self-registrant holds zero balance and no
outstanding value exists at the prior scale. The rationale is documented inline; the heal cannot enable a
scale-mismatch drain. **No code change.**

### L-2 — LP-operator approval is all-or-nothing *(documented)*

An owner who approves an LP operator (e.g. the router) grants standing authority to remove their public LP
shares until revoked — the standard operator-approval model, already documented. Surface the revoke in the
launch UX. **No code change.**

### L-3 — Router CDP-intent calldata offset is layout-coupled *(resolved)*

`ConfidentialRouter._requireCdpMintIntent` reads the `cdpMints` array by hardcoded calldata offset (field
index 22, `27 × 32` head width) rather than `abi.decode`, so a reorder of the `PublicValues` struct would
silently validate the wrong field. This is a guard, not a value path (the pool + proof do full validation),
but it is now pinned by a regression test that exercises the real internal function via a harness and
asserts both that a non-empty `cdpMints` satisfies it and that a neighboring CDP array does not. 3/3 green.

### Informational *(accepted / documented)*
- Engine `currentDebt` / `_owed` revert on a malformed snapshot — a view-only condition; the real
  close/liquidate paths pin a leaf snapshot against a monotonic rate, so it cannot brick.
- `BtcCallExecutor` one-shot `fired` set is the authoritative replay guard; the pool-side
  `pendingBtcCall` last-write is idempotent in the call id and carries no fund risk.
- `CanonicalBridgedERC20` carries the canonical Permit2 default allowance (solady) — the pool never
  custodies its own canonical tokens, so there is no pool balance to move.
- MerkleDistributor `sweep` is an owner clawback that opens only after an immutable future deadline; deploy
  with a timelock/multisig owner and a generous deadline.

---

## 5. Flagship cross-chain questions

### 5.1 cUSD under a cBTC slash

cUSD (a DAI-model CDP collateralized by cBTC) and the cBTC backing are **decoupled by construction**, sharing
only the native-ETH reserve. A cBTC slash moves the rugged locker's escrow to the insurance reserve and
touches no cUSD position; the slash is permissionless and reflection-gated, and redeem-versus-rug is mutually
exclusive in the guest (an honest redeem retires the lock before the rug scan, so it can never be slashed).
cUSD prices cBTC collateral at the BTC/USD mark on the DAI model. In the normal regime — escrow (≥100%,
default 150%) plus reserve buy-and-burn keeping cBTC at peg — cUSD is correctly collateralized and a slash
has no effect on its solvency; a position whose specific collateral is devalued is handled by ordinary
liquidation.

**Tail observation (documented, not a v1 blocker):** the engine prices cBTC at the BTC/USD mark with no
cBTC-specific haircut, no peg oracle, and no global cUSD debt ceiling. If aggregate rug losses were ever to
exceed the reserve's buy-and-burn capacity so cBTC traded below peg, the engine would continue to mark cBTC
at full BTC value and accrue bad debt, with the discretionary reserve draw as the backstop. The
backing-aggregate signal that would drive an automatic shortfall haircut is present but reserved as a
post-v1 additive. For the capped launch this is bounded off-chain (exposure sizing); two in-scope follow-up
options are a global cUSD debt ceiling and wiring the existing backing-aggregate signal into a collateral
haircut.

### 5.2 TAC bridge integrity (no spoof, conservation, both-sides ownership)

- **No spoofing — confirmed.** Canonicity is backing-authority-first: immutable pool MINTER, identity-bound
  CREATE2 salt, first-write-locked shared-id link, and explicit rejection of pool-minted tokens on the
  escrow path. A counterfeit token cannot be resolved as the canonical TAC.
- **Supply conservation — confirmed.** Every leg is value-conserving in-proof (Bitcoin burn → ETH mint;
  note ↔ public ERC20; cross-out → Bitcoin), with exact 8↔18 scaling and dust rejection. There is no
  Ethereum-side supply cap because none is needed: the 21,000,000 fixed supply is inherited from Bitcoin —
  Ethereum can only mint against a proven, consumed Bitcoin burn — and a global no-inflation floor backstops
  the EVM lane.
- **Both-sides ownership — confirmed.** Minting on Ethereum requires a Bitcoin burn that is a member of the
  Bitcoin pool tree, whose nullifier is in the relay-attested bridge-burn set with value pinned to the
  destination, with the conservation kernel requiring knowledge of the burned note's blinding (only the
  owner can mint), one mint per nullifier. Exiting to Bitcoin requires owning the note (membership + opening
  + nullifier).

---

## 6. Changes made in this review

| Change | File(s) |
|--------|---------|
| MerkleDistributor `EXPECTED_TOTAL` + one-shot funding latch (M-5) | `contracts/src/MerkleDistributor.sol`, `contracts/script/DeployMerkleDistributor.s.sol`, `contracts/test/MerkleDistributor*.t.sol` |
| Router CDP-intent calldata-offset pinning test (L-3) | `contracts/test/RouterCdpIntentOffset.t.sol` |

All other findings are documented / accepted with no code change for the reasons stated above. Touched and
new tests pass (MerkleDistributor 14/14 + parity, RouterCdpIntentOffset 3/3); full build clean.

---

## 7. Release-gating item

The guest-resident gates that enforce cross-chain authenticity, the relay-fee binding, and the cross-lane
freshness checks are correct in source but become the on-chain authority only after the project's planned
**coordinated re-prove + redeploy** pins the new verification keys to the committed ELF and redeploys the
pool. This is the standing readiness item; it is a mechanical proving/deploy step and does not require a new
trusted setup.
