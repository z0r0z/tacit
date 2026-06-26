# tETH Bridge Mixer — Production-Readiness Security Audit

_Date: 2026-05-29 · Scope: ETH↔Tacit trustless bridge (Ethereum escrow, SP1 verifier + guest, Groth16/circuit, Bitcoin light relay, Poseidon parity, worker/prover, end-to-end fungibility)._

Method: 13-dimension multi-agent audit with adversarial verification of every finding, a dedicated conservation-invariant cross-check, and a completeness critic. Headline findings were re-verified by hand against the source.

---

## Bottom line

**Fund safety against inflation / drain / double-spend (your T1–T4) holds by design and is well defended.** The global value-conservation invariant cannot be broken: total ETH redeemable via `withdrawFromBurn` can never exceed total genuinely deposited — in aggregate *and* per pool — and no honest depositor's collateral is claimable by anyone who did not legitimately receive that value on Tacit. Two independent guards enforce this: the per-pool on-chain balance backstop, and the SP1 value chain (mint backed 1:1 by a real deposit; export/CXFER/import value-conserving; burn destroys tETH).

**But the bridge is NOT production-ready as deployed.** There is **one CRITICAL deploy defect that bricks every withdrawal** (funds escrow forever — a fund-*lock*, not a drain), one HIGH liveness defect (deep reorg permanently wedges the state machine with no recovery), and the **fungibility promise (T5) does not hold for the realistic cross-denomination case** — your exact "Alice→Bob 0.1→redeem" scenario reverts on-chain today.

| Requirement | Verdict |
|---|---|
| **T1** no drain / double-spend / fund loss | ✅ Safe (conservation proven). One CRITICAL causes fund-*lock*, not loss-to-attacker. |
| **T2** no fake tETH inflating Tacit markets | ✅ Safe. Mint is 1:1 bound to a real per-denomination Ethereum deposit via the root-accumulator. |
| **T3** no fake tETH redeeming real ETH | ✅ Safe. Withdrawal needs *both* an SP1-accepted burn of a real leaf *and* an on-chain Groth16 pass. |
| **T4** funds escrowed, only claimable by depositors/valid-tETH holders | ⚠️ Escrow accounting is correct, but the CRITICAL VK bug currently makes funds claimable by **no one**. |
| **T5** fungibility works in practice (1 ETH → send 0.1 → redeem 0.1) | ❌ Breaks for cross-denomination redemption; the UI even offers denominations Bob cannot withdraw, consuming his burn first. |

---

## Remediation status (updated 2026-05-29, session 2)

All blockers addressed; with the changes below built + redeployed, T1–T5 hold. Three layers of new regression tests lock the fixes in.

**Verifying-key CRITICAL — FIXED & verified.** `Groth16Verifier.sol` regenerated from the finalized ceremony zkey (commit `84efc6b`). Re-checked by hand: all 26 VK constants (α, β, γ, δ with the G2 c0/c1 swap, IC0–IC5) byte-match `ceremony-bundle/verification_key.json` and the guest `vk.json`; dev key absent. New `tests/ceremony-vk-pin.test.mjs` assertion pins this so a foreign key can never ship again.

**NEW HIGH found while building the real-proof round-trip — G2 coordinate order in the mixer — FIXED.** The audit's #1 follow-up (a real, non-mock withdraw proof) surfaced a *second*, independent withdrawal-brick: `TacitBridgeMixer._verifyProof` read the envelope's G2 `b` element in snarkjs-native `(c0,c1)` order and forwarded it to the verifier, but the bn254 pairing precompile requires the swapped `(c1,c0)` order. A real ceremony proof was therefore *rejected on-chain even with the correct key*. Proven by `contracts/test/Groth16VerifierReal.t.sol` (real ceremony proof: native order rejected, swapped order accepted) and fixed by swapping the halves in `_verifyProof` (guest is unchanged — arkworks reads native correctly; only the on-chain extraction needed the swap). This was invisible to the prior mock-verifier e2e. **Requires a mixer redeploy.**

**Per-denomination balance HIGH — FIXED (commit `a038d36`).** Single per-asset `totalBalance`; cross-denomination redemption no longer reverts. T5 now holds at the contract level (the deployed denom set includes 0.1 ETH).

**Deep-reorg HIGH — WON'T-FIX (accepted).** Left immutable for zero-admin; deep reorgs judged exceedingly rare. Documented limitation.

**Worker-poison MEDIUM — FIXED.** `dapp/tacit.js` now gates leaf application on `_verifyBridgeDepositProof`'s result (`tacit.js:38893`).

**Guest + Solidity hardening (source done; needs ELF rebuild + coordinated redeploy):**
- Constructor rejects an empty denomination set (`TacitBridgeMixer.sol`).
- Guest asserts every denomination fits in u64 (high-24-bytes zero) and that denominations are pairwise distinct — closes the low-64-bit collision footgun (`main.rs`).
- CXFER input-sum uses `checked_add`, matching the output side (`main.rs`).
- Documented-with-reasoning, deliberately *not* code-changed (LOW/non-exploitable, and a change risks a liveness regression in proven consensus code): the network-specific `MAX_TARGET` clamp (delegated to the relay, the chain authority), the merkle CVE-2012-2459 residual (mitigated by nullifier uniqueness + the PoW-committed root + full-list processing), the EXPORT Pedersen-opening check (conservation is governed by the denom-pinned tracked amount, not the commitment), the EXPORT/CXFER `vout` single-operation-per-tx invariant, and the burn-envelope first-only rule (already aligned with the on-chain extractor). Comments added at each site.

**New regression tests:** `contracts/test/Groth16VerifierReal.t.sol` (4 — real-proof ordering + soundness); `contracts/test/BridgeWithdrawRealProof.t.sol` (2 — full `withdrawFromBurn` driven by a real ceremony proof + real burn envelope through the G2-fixed mixer + real verifier, releasing escrowed ETH; fixtures from `tests/gen-withdraw-flow-fixture.mjs`); `contracts/sp1/tree/src/tests.rs` (12 — Poseidon parity vectors, frontier-soundness gate, nullifier dedup/order-independence); on-chain VK pin in `tests/ceremony-vk-pin.test.mjs`. Full suite: **86 forge + 12 tree + ceremony pin, all green**.

**On-chain withdrawal path validated end-to-end (sandbox).** `BridgeWithdrawRealProof.t.sol` runs the complete on-chain release — envelope parse → `bind_hash` recompute (matching the dapp's exact formula) → burn claim id → real Groth16 verify through the G2-fixed extraction → escrow release to the recipient → double-spend rejection — with **real cryptography**, stubbing only the two cross-chain consensus inputs (Bitcoin block inclusion, SP1 burn-acceptance). Proven to guard the G2 fix: reverting the swap makes the test fail with `InvalidGroth16Proof()` (the exact withdrawal-brick), and restoring it passes. This is the strongest validation achievable without a funded key + Docker + the live SP1 prover; a live testnet `withdrawFromBurn` is still recommended once the redeploy below is done.

> Note: as of this session, the *deployed* Sepolia mixer (`0xc603…79bBF`) predates the G2 fix (which is uncommitted), so live withdrawals would still brick until the redeploy. The deployed verifier (`0x3BF9…4806`) already has the correct ceremony key.

**Coordinated redeploy required (the G2 fix + guest changes):**
1. `./contracts/sp1/build-guest.sh` (Docker) → canonical ELF + new `PROGRAM_VKEY`; commit the ELF.
2. Deploy `SP1PoolRootVerifier` with the new `PROGRAM_VKEY` (its state resets to genesis).
3. Deploy `TacitBridgeMixer` (with the G2 fix) wired to the new verifier; the verifier's immutable `MIXER` must equal the new mixer (they are mutually address-bound, so both redeploy together).
4. Re-run the prover from genesis to the relay tip.
5. Deploy `Groth16Verifier` from the ceremony zkey as the burn verifier (already correct in source).
6. Prove **one** real `withdrawFromBurn` end-to-end against the real verifier before mainnet value.

**Remaining follow-up (not a blocker):** an offline SP1-`execute` guest test harness with committed Bitcoin block fixtures — covers `main.rs`/`bitcoin.rs` (mint/burn/cxfer/PoW/merkle) end-to-end, which the tree-crate tests don't reach. Deferred because it needs block fixtures + stdin serialization, not because of a known defect.

---

## CRITICAL — On-chain burn verifier uses the wrong (pre-ceremony dev) verifying key → all withdrawals brick

**Verified by hand.** `withdrawFromBurn` requires the same 256-byte Groth16 burn proof to satisfy *both* the SP1 guest (verifies in-zkVM against `contracts/sp1/vk.json`) *and* the on-chain `BURN_VERIFIER` (`Groth16Verifier.sol`). These embed **different verifying keys**:

| Artifact | `alpha.x` | `IC[0].x` | Setup |
|---|---|---|---|
| `Groth16Verifier.sol:30,46` (on-chain) | `19879747…278247` | `18289282…503356` | **pre-ceremony dev** |
| `dapp/circuits/artifacts/verification_key.json` (May 9) | `19879747…278247` | `18289282…503356` | dev (matches on-chain) |
| `contracts/sp1/vk.json` (guest) | `20491192…763042` | `19764598…719239` | **finalized ceremony** |
| `ceremony-bundle/verification_key*.json` + dapp prover | `20491192…763042` | `19764598…719239` | finalized ceremony |

A Groth16 proof is bound to the whole VK; a proof valid under the ceremony key fails the pairing under the dev key. So: Alice mints fine (guest = ceremony key); Bob produces a real ceremony-key burn proof; the SP1 burn-claim check passes; then `_verifyProof → BURN_VERIFIER.verifyProof` checks the pairing against the **dev** key and returns false → `revert InvalidGroth16Proof()`. **No holder can ever withdraw; escrowed ETH is permanently locked.**

- **Deploy wiring confirmed:** `DeployTestnet.s.sol:72` deploys `new Groth16Verifier()` (the dev-key contract) as the real burn verifier; the latest Sepolia broadcast deployed exactly this.
- **Why it slipped through:** the Sepolia e2e (`tests/bridge-sepolia-signet-e2e.mjs`) used `MockBurnVerifier` ("proofs can be zeros"), so the real verifier was never exercised with a real burn proof. The "real proof accepted on-chain" milestone was the **SP1 state-transition** path (a different verifier, `SP1_VERIFIER`), not `withdrawFromBurn`.
- **Drain risk is neutralized, not open:** even if the dev key's toxic waste is known, an attacker still cannot drain — `withdrawFromBurn` also requires `isAcceptedBurn(claimId)`, which only the SP1 guest sets, and only after verifying a real ceremony-key proof of a real spent leaf. So the certain impact is **total loss of redeemability (fund-lock)**, not theft.

**Fix:** regenerate `Groth16Verifier.sol` from the finalized ceremony zkey (`snarkjs zkey export solidityverifier` on the beacon-applied `withdraw_final.zkey` behind the canonical ceremony CID), redeploy, re-wire the mixer's `BURN_VERIFIER`, then run an end-to-end `withdrawFromBurn` with a **real** ceremony proof against the **real** verifier. Add a CI assertion (extend `tests/ceremony-vk-pin.test.mjs`) that the on-chain verifier's `alpha`/`IC0..IC5` constants equal `ceremony-bundle/verification_key.json`, and quarantine the dev `artifacts/verification_key.json` + `withdraw_final.zkey` from every deploy path.

---

## HIGH — Deep Bitcoin reorg permanently bricks the SP1 verifier (no re-anchor path)

**2026-06-20 supersession note:** current `SP1PoolRootVerifier` no longer accepts
the fresh relay tip directly; it walks the relay tip back by `CONFIRMATION_DEPTH`
and accepts that mature anchor (or a recent ancestor). This section documents
the older deployed-alpha behavior and the rationale for the mature-anchor
hardening.

The older deployed-alpha `proveStateTransition` required both `prevBlockHash == currentState.lastBlockHash` and relay-tip equality for the newly committed block (`SP1PoolRootVerifier.sol:155,160`); the guest extends from the previously-proven block (`main.rs:193-195`). If a reorg deeper than `CONFIRMATION_DEPTH` orphans the proven tip `H`, the relay recovers to a heavier branch `H_new` that does **not** descend from `H` — so no header chain can simultaneously start at a child of `H` and end at `H_new`. The contract is immutable with **no owner, pause, reset, or re-anchor function** (confirmed by full grep). Every future `proveStateTransition` reverts forever; all subsequent burns become unwithdrawable (`withdrawFromBurn` depends on `isAcceptedBurn`).

- On **mainnet** this needs a >`CONFIRMATION_DEPTH` reorg (rare, but unrecoverable if it happens).
- On **signet** — where the bridge actually settles — signers can produce arbitrarily deep reorgs on demand. A single deep signet reorg bricks the deployed verifier with no remediation short of redeploying the entire suite. This also interacts with the known signet cron-freeze pattern.

**Fix:** add a guarded re-anchor path (timelocked / deployer-gated for a launch window) that resets `currentState` to a checkpoint consistent with the post-reorg relay tip; *or* require the SP1-proven tip to be buried N blocks below `RELAY.tip()` and let the guest prove from an ancestor so sub-N reorgs never orphan the proven point. At minimum, document the failure mode and pre-stage a signet migration runbook.

---

## HIGH — Per-denomination balance gate breaks T5 fungibility (cross-denomination redemption reverts)

`withdrawFromBurn` enforces `p.balance >= p.denomination` **per pool** (`TacitBridgeMixer.sol:259`), and `p.balance` only grows from `deposit()` of *that exact denomination* (`:231`). Imports that create a matching pool leaf on the Tacit side (`main.rs:363`) never credit Ethereum balance, and there is **no aggregate-liquidity or rebalancing mechanism anywhere**.

Your exact T5 scenario fails: Alice deposits 1 ETH (1-ETH pool balance = 1, 0.1-ETH pool balance = 0), exports → CXFERs 0.1 to Bob (fully legitimate) → Bob imports into the 0.1-ETH pool and burns. SP1 accepts, the on-chain claim check and Groth16 both pass — then `withdrawFromBurn` reverts `InsufficientPoolBalance` because the 0.1-ETH pool holds no real ETH. Bob's tETH is valid but **non-redeemable at his denomination** until some unrelated party deposits ≥0.1 ETH directly into that pool. Worse: his burn nullifier is already consumed on Bitcoin, so the note is marked spent with no ETH released.

This is a **liveness/fungibility defect, not a loss to an attacker** — aggregate ETH is conserved, and the value is recoverable in principle. But it directly contradicts "behaves like any other Tacit asset," and `BRIDGE.md:185` advertises this cross-denomination path with no mention of the destination-pool-solvency precondition.

Two satellite findings compound it:
- **MEDIUM** — the quick-burn UI offers a "0.1 ETH" button gated only on `tethHolding.balance >= d` (`tacit.js:47607`), not on `getPoolBalance(pid) >= weiDenom`, so it lets Bob burn into an insolvent pool and only fails with a generic "Withdrawal failed" *after* the nullifier is spent.
- **LOW** — tETH received as a non-denomination amount (e.g. 0.05) cannot be imported/redeemed at all (`tacit.js:10584`, `main.rs:354`).

**Fix — pick one and document it:**
- **Option A (true fungibility):** make the balance gate aggregate per-asset (one wei balance, not per-pool). This is sound because SP1 + Groth16 + the nullifier set already cap total redeemable at total minted value; the per-pool gate is redundant defense-in-depth that costs fungibility.
- **Option B (keep per-pool):** the dapp MUST gate redemption-denomination buttons on the live `getPoolBalance`, surface "no redeemable liquidity at this denomination" **before** Bob burns, and `BRIDGE.md`/`SPEC` must state the precondition. Never let a user consume a burn nullifier when the destination pool is known insolvent.

---

## MEDIUM — Malicious/compromised worker can poison the dapp's local tree (griefing + nullifier burn)

The worker indexes bridge-mint leaves **structurally only** (`worker/src/index.js:24442`), explicitly deferring Groth16/root validation to the client. The client's defense is `_verifyBridgeDepositProof` (`tacit.js:13671`) — but **its result is discarded at the only call site**: `const _bpOk = await _verifyBridgeDepositProof(...); kernelOk = true;` (`tacit.js:38897-38898`). Every other leaf kind gates on its verifier (`if (kernelOk !== true) break;`); only the bridge branch hardcodes `kernelOk = true`.

A worker the victim points at can serve a fabricated bridge-deposit leaf; the dapp appends it to its **local** pool tree regardless of proof validity. The victim's later burn of a *real* note positioned at/after the bogus leaf computes a root the SP1 prover (operating on the real tree) never produces → `withdrawFromBurn` reverts `UnprovenRoot` forever, *after* the burn is broadcast (nullifier spent, BTC fees paid, note unredeemable). This does **not** inflate tETH or steal ETH (the SP1 guest re-verifies everything), but it's a denial-of-withdrawal / nullifier-burn griefing vector.

**Fix (one line):** `kernelOk = await _verifyBridgeDepositProof(...);` so a `false` result stops leaf application like every other leaf kind.

---

## MEDIUM — Other notable items

- **`scanForEtches` throw freezes a network's whole cron tick for the interval** (`worker/src/index.js:27911,20034`). Alertable (`_logCronError`) but not self-healing; matches the known signet freeze. Liveness only.
- **Redemption is liquidity-fragmented per pool** (same root cause as the HIGH fungibility item): a fast redeemer in a thin pool can strand another valid same-pool holder's leaf until the pool is replenished. No value lost; order/liquidity-dependent.

---

## LOW / INFO (hardening — none are exploitable for loss)

- **Two burn-shaped OP_RETURNs in one tx**: the guest honors only the first burn envelope (`main.rs:215`) while on-chain `_extractEnvByOpcode` returns the first by opcode — a crafted second envelope can suppress a valid burn claim (DoS of one's own burn; retryable). Align the selection rules.
- **EXPORT `vout=1` hardcode** can collide with the CXFER output base, creating duplicate `(txid,vout)` UTXO entries / a phantom entry (`main.rs:335` vs `:397`). Strand-value edge case; make vouts disjoint.
- **IMPORT/EXPORT denom equality compares only the low 64 bits** of the 32-byte denomination (`main.rs:25,335,354`). Safe with current denoms; would enable cross-denom movement if u64-colliding denoms were ever configured. Compare full 32 bytes.
- **CXFER unconditionally removes tracked inputs even when conservation doesn't run** (`main.rs:404-408` vs `:384-403`) — "spend-or-lose" if a wallet co-spends a tracked tETH UTXO with an unrelated input. Confirm the wallet never constructs such a spend; ideally make removal conditional on conservation success.
- **CXFER input-sum uses unchecked `+=`** (`main.rs:378`) while outputs use `checked_add` (`:393`); release profile has no `overflow-checks`. Not reachable with real value (total ≪ 2⁶⁴) but set `overflow-checks = true` for the guest profile.
- **Pedersen opening of `env_recip_commit` unverified on EXPORT** (`main.rs:316-337`). Proven harmless (the tracked amount is pinned to the pool denom, and CXFER conserves on the tracked amount, not the commitment) — but the commit/amount divergence is a latent inconsistency worth closing.
- **Guest `bits_to_target` lacks the MAX_TARGET clamp / zero-target rejection** the relay enforces (`bitcoin.rs:63-88` vs `BitcoinLightRelay.sol:307-321`). Decoder divergence; non-exploitable because the relay tip is the chain authority, but should match.
- **Merkle-root recomputation is CVE-2012-2459-malleable** (duplicate-last-node, 64-byte-tx) (`bitcoin.rs:99-118`) — the "complete block" completeness claim isn't strictly enforced. Adversarial-verification split decision; low risk given PoW + relay anchoring, but harden.
- **Relay**: no header timestamp / median-time-past validation (time-warp surface on retarget); global epoch targets make cross-retarget reorgs unsupported; exact-tip requirement in `verifyBlock` lets cheap signet tip-churn grief withdrawals. Liveness, low.
- **`from_frontier` accepts an ambiguous `next_index` for the same root** (`merkle.rs:23-67`). Non-exploitable (the frontier is anchored by the state-commitment chain), defense-in-depth.
- **Deploy/config hardening:** constructor accepts an empty denomination set (`TacitBridgeMixer.sol:142`); no in-repo binding between deployed `PROGRAM_VKEY`/`GROTH16_VK_HASH` and the committed ELF/`vk.json` (`#24`) — this is *how the CRITICAL VK divergence went unnoticed*. Add a deploy preflight that recomputes both hashes from the committed artifacts and fails the broadcast on mismatch.
- **Whole-system trust note:** security reduces to the deployed `SP1_VERIFIER` being the genuine Succinct verifier (revert-on-invalid). Verify this address at deploy.

> Note on a reported "third VK divergence" (`sha256(vk.json) ≠ deployed GROTH16_VK_HASH`): not a confirmed separate bug. The guest hashes the **arkworks-binary** serialization of the VK (`main.rs:142`), not the snarkjs **JSON text**, so a JSON-file sha256 is not a valid comparison. The real gap is the missing deploy-time binding check (above).

---

## Conservation invariant — independently confirmed safe (T1–T4)

Walked deposit → mint → cxfer → export → import → burn → withdraw across the contracts, the guest, `merkle.rs`, `secp.rs`, and `withdraw.circom`:

- **Mint is 1:1 backed.** The guest only accepts `env_eth_root` ∈ `all_valid_deposit_roots[di]`, and the on-chain verifier forces `deposit_root_accumulators[i] == MIXER.getRootAccumulator(poolId)` per denom (`SP1PoolRootVerifier.sol:176-180`). The accumulator is an order-sensitive SHA256 chain the guest rebuilds (`main.rs:125-135`), so a fabricated root list can't reproduce the real accumulator. The circuit binds `denomination` into the leaf preimage, so a 1-ETH leaf needs a real 1-ETH deposit. One deposit → one mint via the global nullifier set.
- **Export/CXFER/import conserve value.** Export pins the UTXO amount to the pool denom; CXFER verifies every Pedersen opening and enforces `out_sum == tracked_input_sum`; import requires the UTXO amount to equal the target denom. The whole UTXO set is private witness but bound by the state-commitment hash chain (`prevStateCmt == currentStateCommitment`, anchored at genesis `[0;32]`), so no fake/over-valued UTXO can be injected and genesis can't be re-entered.
- **Merkle frontier is sound.** `from_frontier` recomputes and asserts the root, and the frontier is itself committed in the state-commitment chain — a prover cannot forge a pool root or a `known_pool_root`.
- **No double-spend.** The global `NullifierSet` enforces strict sorted+unique ordering and de-dups across batches; the on-chain `burnNullifiers` map caps payout to once per nullifier.
- **Reorg-after-withdraw is safe.** `withdrawFromBurn` re-anchors to the live tip at `CONFIRMATION_DEPTH`, so an orphaned burn is unwithdrawable even if `acceptedBurns` was set — it strands, never over-pays.
- **Aggregate:** `sum(p.balance) == deposits − withdrawals == actual escrowed ETH` (balance written only at deposit `+denom` and withdraw `−denom`; force-fed ETH never credited). Aggregate redeemable ≤ aggregate deposited, unconditionally.

**The CRITICAL VK bug strands value (fund-lock); it never creates or removes it.**

---

## Test-coverage gaps the audit considers launch-blocking process work

1. **No SP1-guest test vectors.** The guest enforces all of T2/T3 yet has no Rust test module. The Solidity `SP1PoolRootVerifier.t.sol` feeds hand-built public values through a `MockSP1Verifier` that accepts everything — it never runs the real guest. Add vectors for: deposit→mint→burn round-trip whose public values the real verifier accepts; rejection of a mint at an unknown `eth_root`; rejection of a double-spent nullifier; the export/import edge cases.
2. **No end-to-end `withdrawFromBurn` against the real `Groth16Verifier`** with a real ceremony proof (this is exactly what hid the CRITICAL).
3. **No CI pin** asserting on-chain verifier VK == ceremony VK == guest vk.json (in their respective serializations), and deployed `PROGRAM_VKEY`/`GROTH16_VK_HASH` == committed ELF/vk.

---

## Go / no-go before mainnet

**Blockers (must fix):**
1. Redeploy `Groth16Verifier` from the finalized ceremony zkey + re-wire `BURN_VERIFIER`; prove one real withdrawal end-to-end against the real verifier.
2. Add a re-anchor / recovery path for deep reorgs (or accept + document the signet redeploy runbook).
3. Resolve the T5 fungibility model (aggregate balance gate, or UI/Spec gating + precondition docs) so legitimate cross-denomination redemption never silently burns a nullifier.

**Should fix:** worker-poison gate (one-line), VK/ELF deploy-binding CI check, SP1-guest test vectors, the burn-envelope selection alignment, and the LOW hardening items.

**Confirmed sound:** the core conservation guarantees — no inflation, no drain, no double-spend, no fake-tETH redemption.
