# Maintainer response — GPT greenlight audit, round 17 (bundle @ `ce60133`)

Seventeenth pass. One **High, cross-component** finding — the first that crosses the immutable contract + the
eth-reflection guest, not a guest-only fix. Confirmed and closed end-to-end.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | ETH→BTC cross-out set is subset-/stale-provable, so a valid `T_CROSSOUT_MINT` can be permanently censored | High (lock/censor) | **Real** | **Fixed** |

## F-01 — cross-out completeness + freshness — FIXED

The fast-lane consumed-ν set is hardened against subset/stale proofs by an enumerable on-chain log
(`bitcoinConsumedCount` + `bitcoinConsumedAt`): the eth-reflection guest proves the **full** index range and
asserts `consumed_count == on-chain count`, and the contract attest ties that to **now**
(`r.consumedCount != bitcoinConsumedCount` reverts). The cross-out set had **neither** — the eth-reflection
guest folded only the prover-supplied `crossouts` subset (no count/enumeration), and nothing tied the proof's
finalized slot to now. So a malicious prover could (a) omit a finalized `claimId` from the subset, or (b) use a
stale eth proof whose finalized slot predates the cross-out, and the Bitcoin guest's `fold_crossout` would fail
membership and skip the confirmed 0x65 mint; the forward-only digest advances past it → the confirmed ETH→BTC
mint is permanently censored. (Not inflation/double-mint — settle still gates burn-root membership +
one-mint-per-ν — but fund-impacting lock/censor of the reverse lane.)

**Fixed** by giving the cross-out set the exact consumed-ν treatment, end-to-end:
- **Contract** (`ConfidentialPool.sol`): added `crossOutCount` + `crossOutAt` (appended at end of storage —
  slots 169/170 — so the guest-pinned slots 76/120/163 are unchanged), recorded on each cross-out write; and
  an attest freshness gate `r.crossOutCount != crossOutCount` (reusing `ConsumedCountStale`). Once any
  cross-out is recorded, a forward batch (committed `crossOutCount` 0) can no longer attest.
- **eth-reflection guest**: reads the on-chain `crossOutCount` freshness anchor, proves the full contiguous
  `crossOutAt[index]` range, and asserts `count == on-chain count` (completeness).
- **Bitcoin guest**: exposes the eth proof's `crossOutCount` in the reflection public values (so the contract
  gate can tie it to now), mirroring `consumedCount`.

The "force Mode-B on any 0x65" guest assertion I first wrote was **removed** as both redundant and harmful:
the contract freshness gate already forbids a forward batch once cross-outs exist, while a 0x65 seen when
`crossOutCount == 0` is necessarily a fake (no recorded cross-out) and must skip-not-panic — asserting there
would stall the forward scan on attacker-injected fake 0x65s. The contract gate is the single, correct choke
point.

## Codesize (EIP-170)
The new storage write + freshness gate + PV field pushed `ConfidentialPool` over the 24,576-byte limit. Reclaimed
under it (**24,566 / +10**, at the launch `runs=1`) by: internalizing the `nullifierSpent` public auto-getter
(read off-chain by storage slot now) and folding the cross-out stale-count revert into the existing
`ConsumedCountStale` error. The `nullifierSpent` readers were migrated to `eth_getStorageAt(keccak256(ν ‖ 69))`:
the cross-lane double-spend guard (`confidential-crosslane-guard.js`, dapp `tacit.js`) and the worker
governance evm-weight gate (`worker/src/governance.js` + a new `_ethGetStorageAt` helper) — slot KAT-pinned, all
guard/governance JS tests green.

## Verification
cxfer-core 154/154 (eth_reflection slot-layout KAT now pins slots 169/170 against `cast index`); the full forge
suite green (`ConfidentialPool` + Router/Fuzz/Invariant/RegisterHeal/TacWalkthrough/CollateralEngine/FarmEscrow/
FarmController/V1Day1/PublicAmm/Zap — the `BitcoinRelayPublicValues` `crossOutCount` field + `nullifierSpent`
internalization threaded through every test PV constructor + a PoolStateReader helper); `ConfidentialPool`
**24,566 / +10** under EIP-170; the reflection DIGEST_MATCH gate green (crossout + burn-deposit + mode-b
fixtures byte-identical; only the box-gated `swapbatch` outstanding); JS — guard + governance-evm (5/0) +
governance-worker (2/0) + crosslane-roundtrip (6/6).

## Re-prove + deploy footprint (bigger than prior rounds)
Unlike the guest-only rounds, this rotates **all three** verifying keys (`PROGRAM_VKEY` /
`BITCOIN_RELAY_VKEY` / `ETH_REFLECTION_VKEY` — the BitcoinRelayPublicValues layout + the eth-reflection guest
both changed) **and redeploys `ConfidentialPool`** (new storage). The genesis Bitcoin-reflection digest is
unchanged (no new committed reflected state). This is the re-prove/redeploy set to carry into the lock.

## Net
F-01 (the High cross-out censorship) is closed by the contract freshness gate + the eth-reflection completeness
proof — the cross-out set now has the same subset-and-stale resistance the consumed-ν set has had. The pool
remains under EIP-170. Because this pass again surfaced a real fund-impacting finding (the seventh "final" round
to do so) — and it was the first architectural/cross-component one — a further confirmatory round on this commit
is warranted before the re-prove + immutable lock.
