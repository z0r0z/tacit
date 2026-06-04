# tETH Bridge — Mainnet Security Audit (final report)

**Scope:** the tETH bridge ONLY (TacitBridgeMixer, SP1PoolRootVerifier, BitcoinLightRelay, the SP1 guest + tree crate, the prover host, the worker bridge code, and the dapp bridge flow). Not the AMM, generic cBTC mixer, or orderbook.
**Target:** live Ethereum mainnet (chain id 1), 2026-06-03. Verified against committed source and on-chain state.
**Method:** 12-dimension parallel review, finding triage/dedup, and 3-lens adversarial verification (exploitability / code-reality / defense-in-depth) per finding, plus direct `cast` reads against mainnet. 54 raw findings → 13 unique → 13 surviving (all low/info), 0 fund-critical.

---

## 1. Bottom line

The four maintainer concerns resolve as follows.

**(1) Draining of locked ETH collateral — HOLDS (no theft path found).**
ETH leaves escrow only through `withdrawFromBurn`, which conjunctively requires PoW-validated, finality-anchored, burial-deep Bitcoin inclusion of the burn tx; an SP1-guest-registered `burnClaimId`; a Groth16 burn proof over the real ceremony key with on-chain `bindHash` recompute over the full domain preimage; and per-asset `totalBalance` solvency, paying exactly `p.denomination` to the proof-bound recipient (`TacitBridgeMixer.sol:294-323, 358-374`). The single strongest reason it holds: the authorization root is the SP1-accepted burn registry, not the relay inclusion proof — `verifier.isAcceptedBurn(burnClaimId)` at `TacitBridgeMixer.sol:371` is populated only by the immutable-VKEY-gated guest, so no forged inclusion, forged note, or malicious prover can manufacture a withdrawal. The live round-trip on the 0.001 ETH pool released exactly `1e15` wei (the pool denomination) and netted balance back to 0 — perfectly value-conserving on real data.

**(2) Double-spend — HOLDS.**
Two independent monotonic guards: the guest's single shared global nullifier set consumed before any claim is emitted (`main.rs:399`, `merkle.rs:112-117`), and the on-chain per-pool `burnNullifiers` map under `nonReentrant` (`TacitBridgeMixer.sol:311,315`). `acceptedBurns` is set-only and never cleared (`SP1PoolRootVerifier.sol:242`). Strongest reason: a second burn of any already-spent nullifier (even cross-denom) short-circuits in-guest before its `claimId` is ever produced, so `isAcceptedBurn` returns false and the second withdraw reverts `UnprovenRoot`. Minting twice from one deposit is blocked by the same global set consuming the deposit nullifier once.

**(3) Other fund-lock / user-safety — HOLDS, with bounded, documented tail risks.**
No inflation path (mint is on-chain-gated 1:1 to a real deposit-root accumulator at `SP1PoolRootVerifier.sol:222-227`, tETH etched supply 0). No DoS that strands funds within reach at pilot scale. The residual locks are all (a) self-inflicted by a non-conforming client, (b) gated behind extreme near-`MAX_LEAVES` preconditions, or (c) a >6-block Bitcoin reorg — none reachable under the pilot caps, and the worst case is value stranded in escrow, never stolen. See the residual-risk register (§6).

**(4) Trustless end-to-end coherence — HOLDS.**
Contracts, guest, prover, worker, and dapp compose into an attestor-free, owner-less bridge. The verifier calls the immutable SP1 Groth16 leaf `0xb69f2584` directly (not Succinct's upgradeable gateway); `PROGRAM_VKEY` and `GROTH16_VK_HASH` are immutable and match the pin byte-for-byte on-chain; the committed ELF sha256 matches `elf-vkey-pin.json` and CI rebuilds it byte-for-byte in official SP1 Docker; the mixer is a genuine non-proxy immutable with no owner/admin/pause/upgrade and a reverting `receive()`. The prover and worker are permissionless and not in the trust path — at worst they withhold service, recoverable by anyone.

**Overall production-readiness verdict: SOUND for the gated pilot, with no fund-critical defect.** Against the stated trust model, no confirmed finding lets value leave escrow without a conserving burn, enables a double-spend, or causes inflation. Every surviving finding is either liveness (recoverable by any permissionless party), an operator-error / future-deploy hardening gap (live instance unaffected), or a documented tail-risk fund-lock that no party can induce at will. The recommendations in §7 are hardening, not blockers.

---

## Resolution status — post-audit (updated 2026-06-03)

The mainnet pilot is live (capped: 0.001 ETH/deposit, 10 ETH total backing). Disposition of the surviving findings:

**Resolved + deployed (no contract redeploy — scripts / dapp / deploy-script / worker only):**
- **LIVE-2** — canonical 8-denom `DENOMINATIONS` default set in `scripts/sp1-prover-loop.sh` (commit `3ad6226`).
- **COH-1** — `Deploy.s.sol` now asserts `chainid == 1` and env `programVKey`/`groth16VkHash` == the committed pin; `deploy-mainnet.sh` cross-checks `GROTH16_VK_HASH` (commit `3ad6226`).
- **LIVE-1** — burn pre-flight fails closed when all Ethereum RPCs are unreachable, instead of degrading to local-only (commit `3ad6226`).
- **QUAL-2** — worker pool `leaf_count` is now append-only; the `T_BRIDGE_BURN` decrement was removed (commit `de7478e`; worker deployed, wrangler version `17dafca2`).

**Deferred to the next contract redeploy (none reachable at pilot scale):**
- **LOCK-2** — make the deposit-capacity gate backlog-aware before un-gating any high-volume pool.
- **LOCK-3** — bind `denom` into `nullifierHash` (the shipped dapp is already immune; this closes a third-party-client footgun).
- **QUAL-1** — add the 64-byte BIP141 reject + merkle-depth bound to the mixer's tx-inclusion (parity only; the SP1-accepted-burn registry, not the inclusion proof, is the authorization root).
- **TRUST-1** — optional asset-global on-chain spent-nullifier set to move cross-denom uniqueness off the guest.

**Accepted + documented:** **LOCK-1** — a deep (>`FINALITY_WINDOW`=6) Bitcoin reorg is the accepted cost of light-client finality (never observed on mainnet; deepest ever was 4 blocks, 2013). Recovery is a full-suite redeploy.

**Post-audit finding (2026-06-05):**
- **LOCK-4 — Burn/deposit interleave across a proof-cycle boundary self-locks the burn.** The guest seeds `known_pool_roots` on each non-genesis cycle with only the resumed root (`main.rs`, non-genesis branch), growing it with intra-cycle appends. A burn binds the pool root the dapp observed at build time; if a third-party deposit to the same pool confirms in a block strictly before the burn's block, the prover's confirmation-gated scan proves the deposit's block in an earlier cycle than the burn's, after which the burn's bound root is no longer seeded and the claim is rejected (note spent on the Bitcoin side, no claim registered on Ethereum). Exposure is roughly one block of interleave per burn and requires concurrent activity in the same pool — not reachable at pilot cadence, material under load. Same mechanism applies to rotate (0x62) and export (0x63). **Mitigation shipped (dapp):** the pre-burn gate defers while the worker reports `pending_leaf_count > 0` for the pool, folding into the existing sync-wait retry ladder. **Fix (next ELF):** persist a K-deep per-pool root window across cycles in the committed state and seed `known_pool_roots` from it — this also makes the proven-root equality gate relaxable to prefix membership, so withdrawals of already-proven leaves stop waiting on unrelated pending deposits. Until then, binding burns to any root other than the one the processing cycle seeds (e.g. an older proven root) widens the lock window and must not be implemented client-side.

---

## 2. Trust model & what you'd have to break

To steal, double-spend, inflate, or permanently lock funds, an attacker must defeat one of these irreducible roots — all of which the design correctly isolates as the *only* things it trusts:

- **Bitcoin proof-of-work.** The relay enforces full real epoch difficulty on every header (`BitcoinLightRelay.sol:169-170`) and the guest re-derives every processed block's prev-hash linkage backward from the immutable relay tip (`main.rs:213-216`). Defeating inclusion/finality requires out-running global Bitcoin hashrate. The deep-reorg fund-lock (LOCK-1) is the cost of relying on this root, not a code defect.
- **Ethereum consensus.** Escrow, the burn-claim registry, and state continuity all live in immutable mainnet bytecode.
- **SP1 / Groth16 soundness.** The guest's value-conservation, nullifier-uniqueness, and known-pool-root membership all reduce to the soundness of the SP1 STARK→Groth16 proof and the burn circuit's BN254 Groth16 verification (real ceremony VK, `nPublic=5`, non-canonical field rejection). TRUST-4 records the one circuit invariant this leans on (the burn circuit must reject zero-subtree leaf values as note commitments).
- **Immutable bytecode + the committed ELF↔vkey binding.** `PROGRAM_VKEY`/`GROTH16_VK_HASH` are immutable with no setter; the deployed values match `elf-vkey-pin.json`; `vkey.rs` and the prover host `include_bytes!` the same committed ELF; `canonical-elf.yml` asserts a Docker byte-equality rebuild and `bridge-guards.yml` runs `verify-vkey-pin.sh` per `contracts/**` PR. A guest rebuild that desyncs the vkey turns CI red and, if shipped anyway, only produces rejected proofs (liveness), never theft.
- **The Succinct toolchain (stated honestly).** The trust here is reduced to the *bytecode* of the immutable Groth16 leaf `0xb69f2584` (v6.1.0) and the SP1 prover/recursion soundness — NOT to Succinct's owner-upgradeable gateway, which is deliberately bypassed. Succinct cannot retarget the verifier post-deploy.

Everything else — the prover host, the Cloudflare worker, operational keys (`ETH_PK`/`RELAY_PK` are pure gas-payers; `advanceTip`/`retarget`/`verifyBlock`/`proveStateTransition` are permissionless), and the relay `DEPLOYER` (whose sole power, the one-shot `genesis()`, is already irreversibly consumed) — is untrusted by construction.

---

## 3. Confirmed / surviving findings (ranked by severity)

No fund-critical (high/medium) finding survived verification. All survivors are **low** or **info**. They are grouped below as fund-safety-adjacent locks first, then liveness, then code-quality, then recorded trust assumptions.

### Fund-safety-adjacent (permanent-lock class — none reachable at pilot scale)

---

**LOCK-1 — Deep (>FINALITY_WINDOW=6) Bitcoin reorg permanently bricks `proveStateTransition`**
Severity: **low** · Category: fund-lock · Status: confirmed (3/3)
`SP1PoolRootVerifier.sol:183-207, 270-276`; `TacitBridgeMixer.sol:215, 344, 371`; `BitcoinLightRelay.sol:23-26, 203-212, 320-325`

*What it is:* `proveStateTransition` gates the new proof on two relay-anchored windows — `prevBlockHash` within 6 ancestors of the stored `currentState.lastBlockHash`, and `lastBlockHash` equal to `RELAY.tip()` or within 6 ancestors of it. The guest binds the two commits together via strict forward header continuity (`main.rs:213-219`), so a prover cannot decouple them. After a Bitcoin reorg deeper than 6 past the last-proven block, the relay re-orgs to the heaviest chain (cumulative-work fork choice) and the stored anchor sits on an orphaned branch unreachable within 6 ancestors of the new tip. Every subsequent proof reverts forever — the dominant revert is **`NotRelayTip` (Gate 2)**, not `StalePrevBlock` (a precision correction from verification). There is no owner/admin/re-anchor on the verifier, and the mixer's `poolVerifiers[pid]` is set only in the constructor (`TacitBridgeMixer.sol:215`) with no setter, so a redeployed verifier cannot be rewired into the live mixer.

*Realistic impact:* Permanent, on-chain-unrecoverable lock of ETH backing burns **not yet SP1-proven at the moment of the reorg**, plus any post-reorg deposits. Already-accepted burns survive (`acceptedBurns` is permanent; `withdrawFromBurn` needs only `isAcceptedBurn` + a fresh relay inclusion proof at `TacitBridgeMixer.sol:303,371`) — orphaned burn txs that get re-mined into the canonical chain re-anchor and remain withdrawable. Recovery requires redeploying the whole suite and abandoning the live instance.

*Why it survived:* All three lenses confirmed the mechanism end-to-end in current source, including that `blockParent` is write-only and orphan links never become reachable from the canonical tip, and that no on-chain layer reverses the lock for the affected subset. It stays **low** because triggering it requires a natural >6-block Bitcoin reorg (deepest historical mainnet reorg is 4 blocks, 2013) — i.e. a violation of the Bitcoin-PoW trust root, not an attacker-inducible flaw. Blast radius is bounded and the maintainer's documented out-of-scope status is accurate.

*Fix:* This is the accepted cost of light-client finality. The only meaningful mitigations are operational: keep the prover cadence tight (minimize the unproven-burn window), and — for a future, un-gated, higher-value deployment — consider an upgrade-free re-anchor path that itself requires an SP1 proof of the new canonical chain (so it adds no trust root), or accept and document the deep-reorg redeploy procedure as the recovery plan.

---

**LOCK-2 — Deposit capacity gate reads the proven pool index, not the deposit-tree pending backlog**
Severity: **low** · Category: fund-lock · Status: confirmed (split: 1 confirmed / 1 refuted / 1 confirmed)
`TacitBridgeMixer.sol:257, 266-267`; `main.rs:351-355`; `merkle.rs:87-94`

*What it is:* `_insertDeposit` gates on the deposit tree's own fullness (`p.nextLeafIndex >= MAX_LEAVES`, line 257) and the pool-tree reserve (`poolIdx + POOL_TREE_RESERVE >= MAX_LEAVES`, lines 266-267), where `poolIdx = lastProvenPoolIndex` — which advances only when a proof lands. Mint inserts via the full `can_insert()` and silently `break 'mint` on overflow; rotate/import self-limit via `can_insert_with_reserve(1024)`, keeping the top 1024 slots mint-only (the F-2 fix, which holds). The reserve bounds the *proven index*, not the deposit *backlog*.

*Realistic impact:* If a single denom pool sits within ~1024 of `MAX_LEAVES` and the prover stalls while deposits flood (or rotate-inflation drives `next_index` to the reserve boundary while the deposit tree still has headroom), mints beyond the cap are silently skipped and that ETH is permanently locked (no reclaim path). Value never leaves escrow — it is stranded, not stolen.

*Why it survived (and why it's only low):* The exploitability and defense-in-depth lenses confirmed the mechanism is real and that no layer reverses a stranded mint. **The code-reality lens refuted the simple stalled-prover-flood variant**: line 257 hard-caps the deposit tree at `MAX_LEAVES`, so once `P` crosses into the reserve, deposits stop and the maximum backlog is exactly `MAX_LEAVES − P ≤ 1025`, which the mint-only reserve + boundary slot exactly cover — no strand in a kept-in-sync pure-mint workload. The surviving variant requires rotate/import to consume the pool's lower slots while the deposit tree independently fills, at a single denom pool near 1,048,576 leaves — categorically unreachable under the 10 ETH / 0.001 ETH-per-deposit pilot (~10k deposits across 8 pools, ~5 orders of magnitude below 1M in any one pool). Not a profit path; griefer strands their own deposits.

*Fix:* Make the deposit gate backlog-aware before un-gating any high-volume pool: gate on `(p.nextLeafIndex − lastProvenPoolIndex) + reserve_needed`, or have the guest mint with a lock-aware fallback rather than silently skipping. Lowest-effort interim: keep the per-denom cap well under `MAX_LEAVES` administratively (already true at pilot).

---

**LOCK-3 — Cross-denom nullifier-preimage reuse self-locks the second deposit**
Severity: **low** · Category: fund-lock · Status: confirmed (split: 1 refuted / 1 confirmed / 1 uncertain)
`main.rs:352, 399`; `merkle.rs:112-117`; `TacitBridgeMixer.sol:269, 311`; `dapp/tacit.js:5386-5397, 10045-10054`

*What it is:* The pool-note `nullifierHash = poseidon(nullifier_preimage)` omits the denomination, while the leaf commitment binds it; on-chain `deposit()` rejects only identical commitments (`DuplicateCommitment`, line 269), not two distinct commitments sharing one preimage. The guest's single global nullifier set is the cross-denom defense. If a client reuses the same `ν_pool` across two *different-denom* notes, both deposits lock ETH but only the first burn succeeds; the second `null_set.insert` returns false, no `claimId` is emitted, and `withdrawFromBurn` reverts `UnprovenRoot` forever.

*Realistic impact:* Self-inflicted permanent lock of the second deposit's ETH. Value-conserving — the shared set is exactly what blocks the double-spend; there is no theft, inflation, or impact on any other user.

*Why it survived (and why it's only low):* Confirmed in code by the code-reality lens; the exploitability lens **refuted it as a bridge bug** and the defense-in-depth lens marked it **uncertain**, both because the shipped honest dapp makes it unreachable by construction — `ν_pool = HMAC(priv, domain || monotonic_index)` with a persisted, recovery-safe per-deposit index and distinct HMAC domains for `ν_eth` vs `ν_pool` (`dapp/tacit.js:10045-10054, 10116, 10196`). Same-denom reuse is rejected at `deposit()` (identical commitment); only cross-denom reuse by a *non-conforming* client triggers it. Verification also corrected the finding's "same denom" phrasing.

*Fix:* Bind `denom` into `nullifierHash` (so the on-chain per-pool guard + the guest set both key on denom), or have the dapp/guest reject reuse of a `ν_pool` across denoms. Either removes the footgun for third-party clients without weakening double-spend protection.

---

### Liveness (recoverable by any permissionless party — not fund-safety)

**LIVE-1 — Burn pre-flight pool-root cross-check no-ops when all Ethereum RPCs are unreachable**
Severity: **low** · Category: liveness · Status: confirmed (split: 1 uncertain / 1 confirmed / 1 refuted)
`dapp/tacit.js:10708-10770, 10784-10858, 14235-14256`

*What it is:* `ensurePoolViewMatchesVerifier` returns `'noop'` on any `eth_call` failure, the aggregate fallback returns early, and the `isKnownDepositRoot` check swallows all-RPC-failure without rejecting the leaf (`14250-14252`). If every configured public Ethereum RPC is simultaneously down at burn time, the strongest omitted-middle-leaf defense (local root == SP1 last-proven root) degrades to local-only checks, and a hostile worker's omitted-middle-leaf could let a burn spend the irreversible Bitcoin nullifier into a root SP1 never proved.

*Why it survived / its true impact:* The fail-open mechanism is real and confirmed; an omitted middle leaf is genuinely invisible to local-only checks. **But the defense-in-depth lens refuted it as a fund-safety issue, and verification corrected the finding's recovery claim in the *safer* direction:** the doomed burn's nullifier is *never consumed* (the guest breaks at the `known_pool_roots` check *before* `null_set.insert`, and on-chain `burnNullifiers` is set only inside a successful withdraw), so the note is **not bricked** — after re-indexing from any honest worker the user builds a fresh, correct burn and withdraws in full. Net cost: one wasted Bitcoin burn-tx fee + delay. Preconditions are stringent (hostile worker AND simultaneous failure of all 4 independent public RPCs at the burn moment), and the attacker controlling the worker cannot induce the RPC outage.

*Fix:* Fail closed — refuse to broadcast a burn when `_bridgeConfigured()` is true but every RPC fails during pre-flight.

---

**LIVE-2 — Prover liveness coupling (strict deposit-accumulator equality, tip mismatch, wrong DENOMINATIONS default)**
Severity: **low** · Category: liveness · Status: confirmed (3/3)
`SP1PoolRootVerifier.sol:173, 195-207, 220-227`; `scripts/sp1-prover-loop.sh:33-44, 56`; `contracts/sp1/script/src/main.rs:231-236`; `contracts/script/Deploy.s.sol:29-37, 53`

*What it is:* Three fail-closed couplings, all reverting *before* any state mutation and recoverable by any permissionless prover: (1) each committed deposit accumulator must equal the current `MIXER_CONTRACT.getRootAccumulator(poolIds[i])`, so a deposit landing mid-proof reverts `InvalidDepositRoot` (a griefer must lock real ETH per spam and the effect stops when they stop); (2) `lastBlockHash` must be the relay tip or within 6 ancestors, so a >6-block tip advance during proving stales the proof; (3) **the shipped default `DENOMINATIONS` lists only the top 6 of the 8 live mainnet denoms** — it omits the two smallest pools (0.00001 / 0.0001 ETH), and the mainnet branch never sets `DENOMINATIONS`, so a naive operator builds a 6-tree state whose `denoms_hash != DENOMS_HASH` and every proof reverts `DomainMismatch`. (Verification corrected the finding's "testnet denoms" label — they are the upper 6 of the 8 real denoms.)

*Why it survived:* All three exist exactly as described and all are fail-closed liveness — no theft/inflation/lock, automatically recoverable. The mainnet record (≥2 proves accepted) empirically demonstrates recoverability.

*Fix:* Set the canonical 8-entry `DENOMINATIONS` in the mainnet branch of `sp1-prover-loop.sh` (or derive it from the verifier's `denominations()`/`NUM_DENOMS` at startup). Optionally accept a deposit-accumulator prefix rather than strict equality to reduce griefing-induced staling.

---

### Code-quality / defense-in-depth gaps (live instance unaffected)

**COH-1 — `GROTH16_VK_HASH`/chainid/vkey not cross-checked inside `Deploy.s.sol` (only the bash wrapper)**
Severity: **low** · Category: code-quality · Status: confirmed (3/3)
`contracts/deploy-mainnet.sh:47, 99-109, 174`; `contracts/script/Deploy.s.sol:11-23, 56-69`; `elf-vkey-pin.json:5`; `SP1PoolRootVerifier.sol:174`

*What it is:* The wrapper hard-checks `SP1_PROGRAM_VKEY` against the pin but performs **no** analogous check of `GROTH16_VK_HASH` against the pin's `groth16_vk_hash`, and `Deploy.s.sol` itself asserts nothing (no pin/vkey/chainid `require`s). Invoking `forge script` directly with stale env bypasses all guards. A wrong `GROTH16_VK_HASH` on a *fresh* deploy makes every `proveStateTransition` revert `InvalidVkHash` (fully fail-closed, no theft), but ETH deposited into that bad instance before discovery is locked.

*Why it survived:* Confirmed by all three lenses as an accurate operator-error / defense-in-depth gap. **Not a defect of the live instance** — its values match the pin and it has accepted proofs on-chain; the first proof attempt on a mis-deploy surfaces the brick immediately.

*Fix:* Mirror the vkey preflight for `GROTH16_VK_HASH`, and embed the pinned constants + `require(block.chainid == 1)` inside `Deploy.s.sol` so the artifact fails closed even when the wrapper is bypassed.

---

**QUAL-1 — Mixer `_computeTxid`/`_verifyTxInclusion` lack the guest's 64-byte BIP141 guard and a Merkle-proof depth bound**
Severity: **info** · Category: code-quality · Status: confirmed (split: 2 confirmed / 1 refuted)
`TacitBridgeMixer.sol:364, 371, 444-452, 508-515`; `contracts/sp1/program/src/bitcoin.rs:24-25`

*What it is:* The guest rejects 64-byte non-witness txs (CVE-2012-2459 anti-collision); the mixer's on-chain `_computeTxid` has no such guard, and `_verifyTxInclusion` folds an attacker-controlled `proof[]`/`idx` with no depth bound.

*Why it's info (not fund-critical):* The relay inclusion proof is **not** the authorization root. `withdrawFromBurn` additionally requires the recomputed `bindHash` and `isAcceptedBurn(burnClaimId)` (`TacitBridgeMixer.sol:364, 371`), and that registry is populated only by the guest, which *does* enforce the 64-byte guard plus full Groth16/deposit-root authentication. A forged interior-node inclusion has no matching accepted claim and reverts `UnprovenRoot`; turning it into an accepted claim would need a double-SHA256 second preimage (infeasible).

*Fix (parity hardening):* Add a `tx_.length != 64` reject in `_computeTxid` and bound `proof.length`/assert residual `idx == 0` in `_verifyTxInclusion`.

---

**QUAL-2 — Worker decrements pool `leaf_count` on `T_BRIDGE_BURN`**
Severity: **info** · Category: code-quality · Status: confirmed (split: 2 confirmed / 1 refuted)
`worker/src/index.js:24661, 24703-24704, 24729, 24778, 4080-4084`

*What it is:* A burn nullifies a note but does not remove a leaf; the cron decrement makes the advisory counter drift below the true append-only total.

*Why it's info:* The counter feeds only the advisory `/pools` `leaf_count` (a zero/non-zero skip gate; the dapp rebuilds trees from the ordered leaf list, never from the counter) and the worker's own `cnt >= POOL_LEAF_CAP` headroom guard, which under-counting only makes fire *later*. Crucially, any burned pool also has `nullifier_count > 0`, so the dapp's `&&` skip-gate (`dapp/tacit.js:39304`) never fires for it — no leaf-omission/`UnprovenRoot` lock is reachable. The worker is not in the on-chain trust path.

*Fix:* Drop the decrement so `leaf_count` monotonically tracks appended leaves; derive live-note-count as `leaf_count − nullifier_count`.

---

**QUAL-3 — Untracked AXFER-family outputs and unbound-import are conservative-by-design but undocumented**
Severity: **info** · Category: code-quality · Status: confirmed (3/3)
`contracts/sp1/program/src/main.rs:431-458, 628-666`

*What it is:* (1) The guest's conservation parser recognizes only CXFER `0x22`/`0x23`; the dapp's AXFER opcodes (`0x26`/`0x37`/`0x3C`/`0x3D`) are never parsed, so AXFER-moved tETH is invisible to the bridge ledger (a recovery/UX trap, self-strand only). (2) Import `0x64` carries no Groth16 — authority is the Bitcoin UTXO spend plus an exact `amount == denom` check; an importer choosing an unopenable commitment bricks only their own note.

*Why it's info:* No value can enter the backed set via an unverified path; both surfaces are conservative (self-loss only). Verified that the shipped dapp routes bridged-tETH transfers exclusively through CXFER + bridge ops, never AXFER.

*Fix (documentation/refactor-guard):* Document the supported transfer opcodes and confirm the dapp routes bridged-tETH only through `0x22`/`0x23`; document in SPEC that import authority is the Bitcoin UTXO spend (not a circuit) so a future maintainer does not "add a proof" and silently change the trust model.

---

### Recorded trust assumptions (positive verifications — info)

- **TRUST-1** (info, confirmed 3/3) — Cross-denom double-withdraw uniqueness rests *solely* on the guest's single global nullifier set, not on any on-chain invariant (the on-chain `burnNullifiers` map is per-pool, and `claimId` binds `denomTacit`). It composes correctly today; recorded so a future guest refactor to a per-denom set is recognized as a silent double-spend regression. Defense-in-depth recommendation: an asset-global on-chain spent-nullifier set would remove the reliance on the guest for the cross-denom case. `TacitBridgeMixer.sol:311,315,370`; `main.rs:399`; `merkle.rs:112-117`; `SP1PoolRootVerifier.sol:240-243`.
- **TRUST-2** (info, confirmed 3/3) — The relay's one-shot `genesis()` is the only privileged action and is already irreversibly consumed (`initialized = true`); `DEPLOYER == operator == test-withdrawal recipient` is optics-only and confers no privilege (the test withdraw passed the identical SP1+Groth16+inclusion gauntlet). `BitcoinLightRelay.sol:21,43,89,93-102,137,220,279`.
- **TRUST-3** (info, confirmed 3/3) — Trust roots verified and correctly minimized: immutable SP1 Groth16 leaf (not gateway), immutable `PROGRAM_VKEY`/`GROTH16_VK_HASH` matching the pin on-chain, ELF↔vkey Docker-rebuild pin, no owner/admin/pause/upgrade anywhere, operational keys are gas-payers only. One minor CI hardening: `canonical-elf.yml`'s "derive vkey from rebuilt ELF" step is informational — make it hard-fail on `vkey != pin` (belt-and-suspenders; the load-bearing ELF byte-equality check already hard-fails). `SP1PoolRootVerifier.sol:30-40,104-113,136,174`; `elf-vkey-pin.json:3-5`; `verify-vkey-pin.sh:22-57`; `vkey.rs:4-11`; `canonical-elf.yml:62-105`; `bridge-guards.yml:91-92`.
- **TRUST-4** (info, confirmed 3/3) — `known_pool_roots` gates burn/export/rotate/withdraw to roots the guest actually produced, closing fabricated-root membership; the only residual is the seeded empty root, whose safety depends on the trusted burn circuit rejecting zero-subtree leaf values as note commitments (the leaf is a circuit-constrained `poseidon(secret, ν, denom)`, so the attack reduces to a Poseidon preimage of zero — infeasible). Recorded to preserve that circuit invariant across any circuit change. `main.rs:96-128,283,354,360,377,383,412,456`.

---

## 4. Refuted / downgraded

The triage produced no findings that adversarial verification knocked down to "refuted" overall. However, several findings were **downgraded or had a specific exploit variant neutralized by a backstop within their multi-lens verification** — this is the defense-in-depth evidence worth surfacing:

- **LOCK-2 (stalled-prover deposit-flood variant)** — neutralized by the deposit-tree hard cap `p.nextLeafIndex >= MAX_LEAVES` (`TacitBridgeMixer.sol:257`): the max backlog above the stall point is ≤1025, exactly covered by the mint-only reserve + boundary slot, so the simple variant strands nothing. Only the rotate/import-driven near-capacity variant survives, and only above pilot scale.
- **LOCK-3 (as a bridge fund-safety bug)** — neutralized by the dapp's HMAC+monotonic-index key derivation (`dapp/tacit.js:10045-10054, 10116, 10196`) and the on-chain `DuplicateCommitment` reject (`TacitBridgeMixer.sol:269`): unreachable by any conforming client, and same-denom reuse is rejected outright. Downgraded to a client-robustness footgun.
- **LIVE-1 (as a fund-safety bug, and the "permanent lock" reading)** — neutralized by the fact that a failed burn never consumes the nullifier (guest breaks before `null_set.insert`; on-chain `burnNullifiers` set only on success) plus the guest's `known_pool_roots` gate + `isAcceptedBurn`: the user re-burns after re-indexing and withdraws in full. Downgraded from "possible nullifier-into-unproven-root strand" to "one wasted burn-tx fee + delay."
- **QUAL-1 (as a forged-inclusion theft path)** — neutralized by the SP1-accepted-burn registry being the authorization root (`TacitBridgeMixer.sol:371`), the guest's full-txid-set merkle-root recompute (`main.rs:234`), and per-tx `compute_txid == txids[idx]` pinning (`main.rs:242-243`): a 64-byte interior node can never become an accepted claim. Downgraded to info parity-hardening.
- **QUAL-2 (as a leaf-omission lock)** — neutralized by the dapp skip-gate being an AND of `leaf_count==0 && nullifier_count==0` (`dapp/tacit.js:39304`): a burned pool always has `nullifier_count > 0`, so detail is always fetched and the full ordered leaf list rebuilt. Downgraded to info accounting wart.

---

## 5. Live on-chain state

Confirmed against mainnet (chain id 1) via `cast`; reachable RPC `ethereum-rpc.publicnode.com`, tip ~25,236,007. **No mismatch found between live state and committed source.**

- **TacitBridgeMixer `0x6929acf0…FECbf`** — `TOKEN=0x0` (native ETH), `ASSET_ID=0x3cba71e1…126f34`, `HEADER_RELAY`, `BURN_VERIFIER`, `UNIT_SCALE=1e10`, `NETWORK_TAG=0`, `CONFIRMATION_DEPTH=6`, `TREE_LEVELS=20`/`MAX_LEAVES=1,048,576`, `POOL_TREE_RESERVE=1024` — all match. All 8 pools wired (`0.00001…100 ETH`), each routed to verifier `0x19CC65a1`; `poolIds[8]` reverts (exactly 8). No owner/admin/paused/pause/implementation/upgradeTo/pendingOwner selectors; `receive()` reverts; no EIP-1967 slots; no SELFDESTRUCT/CALLCODE. (A single `DELEGATECALL` opcode exists, traced to solady `SafeTransferLib.forceSafeTransferETH` `create()` force-send — not a proxy/upgrade vector; `contracts/src` has zero `delegatecall`.) Genuine non-proxy immutable.
- **SP1PoolRootVerifier `0x19CC65a1…A701`** — `PROGRAM_VKEY=0x003e5d74…`, `SP1_VERIFIER=0xb69f2584…` (the immutable Groth16 leaf, not a gateway; `owner()`/`admin()` revert, real verifier bytecode), `GROTH16_VK_HASH=0x0eabe508…` (matches pin), `NUM_DENOMS=8`, `FINALITY_WINDOW=6`, `denominations[]`/`poolIds[]` byte-identical to the mixer. `currentState.stateHeight=2` (≥2 proofs accepted).
- **BitcoinLightRelay `0x45AA7939…0951`** — `initialized=true` (genesis one-shot, consumed), `genesisEpoch=currentEpoch=472` (epoch start 951552), `tipHeight=952196`. `DEPLOYER=0x42E7b9E9…483c`; `advanceTip`/`retarget`/`verifyBlock` permissionless. Genesis anchor → BTC 952127; `currentState.lastBlockHash` → 952190; relay tip → 952196 (exactly 6 above the proven anchor — the sub-finality reorg-tolerance window operating as designed on live data).
- **Groth16 burn verifier `0x031b22ba…b2ca`** — has code, no `owner()`; deployed bytecode contains the ceremony-specific `IC0x`/`IC1x`/`deltax2` constants from `Groth16Verifier.sol` (real ceremony VK, not a dev key).
- **Conservation sanity** — `totalBalance=0` and ETH balance=0 currently; live event history shows a complete deposit→SP1-prove→burn-withdraw round-trip on the 0.001 ETH pool releasing exactly `1e15` wei (= pool denomination), netting balance back to 0 — perfectly value-conserving.

Two info-level on-chain observations (both already captured as TRUST-2 and the path-drift note): the `DEPLOYER == operator == test-withdrawal recipient` overlap is optics-only; and `verify-vkey-pin.sh` lives at `contracts/sp1/` rather than the scope-documented `scripts/` path (pin contents are correct and match on-chain).

---

## 6. Residual-risk register (accepted/known limitations)

| Risk | Trigger | Blast radius | Recovery |
|---|---|---|---|
| **Deep-reorg brick (LOCK-1)** | Natural Bitcoin reorg >6 blocks (never observed on mainnet) | ETH backing burns unproven at reorg time + post-reorg deposits; accepted burns survive | Redeploy the full suite; abandon the live instance. Re-mined orphaned burn txs re-anchor and remain withdrawable. |
| **Near-capacity strand (LOCK-2)** | Single denom pool within ~1024 of `MAX_LEAVES` + prover stall / rotate-import-driven boundary fill | Excess deposits in that one pool stranded (self-griefing; value never leaves escrow) | Avoid by keeping per-denom occupancy well below `MAX_LEAVES`; add a backlog-aware gate before un-gating a high-volume pool. Unreachable at pilot scale. |
| **Client nullifier-reuse self-lock (LOCK-3)** | Non-conforming client reuses `ν_pool` across denoms | The reusing wallet's second deposit only | Use the shipped dapp (HMAC+monotonic-index derivation). Bind `denom` into `nullifierHash` to remove the footgun. |
| **Prover liveness / censorship (F-1, LIVE-2)** | Prover stops, is censored, or runs wrong config | Withdrawal delay only; no funds at risk | Anyone runs the permissionless prover with the canonical 8-denom config; `proveStateTransition` is open. |
| **Total RPC outage at burn (LIVE-1)** | All 4 public RPCs down + hostile worker at the burn moment | One wasted Bitcoin burn-tx fee + delay; note not bricked | Re-index from any honest worker, re-burn against the correct root, withdraw in full. Fail-closed burn pre-flight removes even the wasted fee. |
| **Pilot caps** | By design | Bounds total exposure to 10 ETH backing, 0.001 ETH/deposit; bridge dapp-gated (`live:false`) | N/A — intentional. Caps keep all near-capacity locks unreachable. |
| **Succinct toolchain / immutable leaf** | SP1 recursion or Groth16-leaf bytecode soundness break | Catastrophic, but is an explicitly accepted trust root | N/A — verifier pinned to the immutable leaf, not the upgradeable gateway, so no live retarget surface. |

---

## 7. Prioritized recommendations (fund-safety first)

1. **(Fund-safety, before un-gating high-volume pools)** Make the deposit capacity gate backlog-aware (LOCK-2): gate on `nextLeafIndex − lastProvenPoolIndex + reserve`, or have the guest mint with a lock-aware fallback instead of silently skipping. Until then, keep per-denom occupancy far below `MAX_LEAVES`.
2. **(Fund-safety, client hardening)** Bind `denom` into `nullifierHash`, or reject cross-denom `ν_pool` reuse in dapp + guest, to eliminate the LOCK-3 self-lock footgun for third-party clients.
3. **(Deploy safety)** Mirror the vkey preflight for `GROTH16_VK_HASH` and embed the pinned constants + `require(block.chainid == 1)` inside `Deploy.s.sol` so a future mis-deploy fails closed even when the bash wrapper is bypassed (COH-1).
4. **(Liveness)** Set the canonical 8-entry `DENOMINATIONS` in the mainnet branch of `sp1-prover-loop.sh` (or derive from the verifier's `denominations()` at startup) so a naive mainnet prover does not silently produce `DomainMismatch`-rejected proofs (LIVE-2).
5. **(Liveness/UX)** Fail closed in the burn pre-flight: refuse to broadcast when `_bridgeConfigured()` but all RPCs fail (LIVE-1).
6. **(Defense-in-depth)** Add the guest's 64-byte BIP141 reject and a Merkle-proof depth bound to the mixer's `_computeTxid`/`_verifyTxInclusion` for parity (QUAL-1); consider an asset-global on-chain spent-nullifier set to move cross-denom uniqueness off the guest (TRUST-1).
7. **(Hygiene/docs)** Make `canonical-elf.yml`'s vkey-derive step hard-fail on `vkey != pin`; fix the `verify-vkey-pin.sh` path drift (add a `scripts/` wrapper); remove the worker `T_BRIDGE_BURN` `leaf_count` decrement (QUAL-2); document the supported transfer opcodes and that import authority is the Bitcoin UTXO spend (QUAL-3); publish the genesis checkpoint values and use a disposable deployer key distinct from the operator recipient (TRUST-2). For deep-reorg recovery, document the redeploy procedure as the accepted recovery plan (LOCK-1).

**Summary:** The tETH bridge is fundamentally sound. No path was found to drain escrowed ETH, double-spend a burn or note, or inflate tETH; the trustless, owner-less, attestor-free claim holds against live mainnet state. The only caveats are recoverable liveness items, operator-error / future-deploy hardening gaps that leave the live instance unaffected, and bounded fund-locks that are either self-inflicted by non-conforming clients or require violating the Bitcoin-PoW trust root (deep reorg) — none reachable under the current pilot caps. The punch-list above is hardening for the path to un-gating, not a set of blockers for the gated pilot.
