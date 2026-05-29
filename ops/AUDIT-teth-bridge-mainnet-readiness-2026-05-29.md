# tETH Bridge Mixer — Production-Readiness Audit (Lead Auditor Synthesis)

**Date:** 2026-05-29 · **Scope:** trustless ETH↔Tacit wrapper (TacitBridgeMixer + SP1PoolRootVerifier + Groth16 burn verifier + SP1 guest + BitcoinLightRelay + worker/dapp) · **Network as deployed:** Sepolia (11155111) ↔ signet.

_Method: 49-agent multi-dimension review + dedicated red-team (inflation / double-spend / drain / fund-lock) + empirical verification (forge & cargo suites, VK parity recompute, on-chain bytecode disassembly, deploy-gap analysis), with adversarial verification of every finding. Headline claims re-checked by hand. This is a second, independent pass over `AUDIT-teth-bridge-2026-05-29.md` and revises several of its conclusions._

## Bottom line

**NOT production-ready for mainnet.**

The four fund-safety invariants (T1 no-loss, T2 no-inflation, T3 no-fake-redeem, T4 escrow-correct) **hold by design** in the current source, and no red-team broke the mint, double-spend, or drain paths. The verifying key is genuinely the finalized ceremony key (on-chain == guest == ceremony; dev key gone). **But the system is not safely deployable yet**, for three independent reasons, each of which permanently strands user deposits (fund-LOCK, which this review treats as a fund-safety blocker):

1. The load-bearing G2-coordinate fix is **uncommitted source** — the live instance happens to carry it, but any clean redeploy (including mainnet) compiles a mixer that bricks every withdrawal.
2. A deep Bitcoin/**signet reorg permanently bricks** state advancement with no re-anchor — operator-triggerable on the actual settlement layer.
3. The **Tacit pool tree can exhaust** and the guest then silently skips minting while ETH keeps locking.

And the headline user flow is incomplete: **T5 (deposit 1 ETH → send Bob 0.1 → Bob redeems 0.1 ETH) does not work end-to-end** because the dapp never drives the cross-denomination split path the guest supports.

## A correction to the dimension reviews (verified by bytecode disassembly)

Four reviewers rated **critical/high** the claim that the *deployed* mixer `0x93c20b1c` uses native G2 order and therefore reverts every `withdrawFromBurn`, locking all deposits. **Disassembly of the live mixer's on-chain creation bytecode REFUTES this for the deployed instance.** Method and result:

- Committed `HEAD:contracts/src/TacitBridgeMixer.sol:353` uses **native** order `b[0][0]=_u(env,o+64); b[0][1]=_u(env,o+96)`; the working tree (`:359-360`) uses the **swapped** order. The swap is uncommitted (`git log -S` finds no commit introducing it).
- The deploy (`broadcast/.../run-latest.json`, commit `a038d36`) created the mixer. Both the committed-native and working-tree-swapped sources were compiled, CBOR metadata stripped, and each runtime compared against the deployed runtime extracted from the on-chain initcode.
- **At all four G2-discriminator byte offsets, the deployed bytecode is byte-identical to the SWAPPED (correct) build.** The *only* other difference is one contiguous 20-byte cluster (hex positions 14400–14439) — the PoseidonT3 **library-link address**, which differs only because the local link address differs.

So the deploy was performed from a dirty working tree that already had the fix; the live mixer accepts real ceremony proofs and the full withdraw round-trip works (the 6 real-proof forge tests pass). **The residual risk is deploy-hygiene, not a live brick** — but it is still a blocker, because the source-of-record (HEAD) and any clean checkout / CI / fresh clone compile the withdrawal-bricking native order.

> Caveat: no real on-chain `withdrawFromBurn` has ever executed (see Empirical evidence), and one empirical agent reasoning from file mtimes reached the opposite (live-brick) conclusion. The disassembly is the stronger evidence, but a single live testnet withdraw is the definitive tiebreaker and is on the go/no-go checklist regardless.

## T1–T5 status

| Invariant | Verdict | Basis / strongest counter-evidence considered |
|---|---|---|
| **T1 — no drain / double-spend / loss** | **Holds (by design)** | Aggregate `totalBalance` gate (`TacitBridgeMixer.sol:264,267`); global nullifier set (`main.rs:316`) caps one spend per leaf protocol-wide; per-pool `burnNullifiers` backstop. Red-teamed double-spend, reorg-replay, two-burns-in-one-tx, mint-twice — all blocked. The export+CXFER `vout=1` collision (DS-1/GC-2) traced to conserve value (stranding, not double-spend). |
| **T2 — no fake tETH inflation** | **Holds (by design)** | Order-sensitive deposit-accumulator SHA256 chain pinned to the live mixer (`SP1PoolRootVerifier.sol:177` vs guest `main.rs:137-147`); circuit binds denomination into the leaf (`withdraw.circom:67-71`); VK pinned (`GROTH16_VK_HASH`, `sha256(vk_bytes)`). No working inflation path found. |
| **T3 — no fake redeem of real ETH** | **Holds (by design)** | `withdrawFromBurn`→`isAcceptedBurn` (`TacitBridgeMixer.sol:322`); burnClaimId byte-parity guest↔contract; bind_hash domain-separated by chainId+mixer+networkTag; on-chain Groth16 re-verify with correct (swapped) G2 order on the live instance. |
| **T4 — escrow claimable only by valid holders** | **Holds (by design)** | CEI + `nonReentrant`; force-fed ETH not credited to `totalBalance`; `receive()` reverts; per-asset verifier scoping in constructor. |
| **T5 — fungibility (1 → send 0.1 → redeem 0.1)** | **Does NOT work end-to-end** | Accounting is sound and a depositor can redeem their own whole note 1:1, but the dapp never wires export 0x63 (zero callers, `tacit.js:10766`), the spendable-tETH UI emits guest-unhandled opcode 0x2A, and rotate/import leaves are misrouted and truncate the local tree (WD-2). |

## Confirmed blockers (ranked)

### 1. [HIGH · fund-LOCK · deploy-hygiene] Uncommitted G2 swap — clean redeploy bricks all withdrawals
`contracts/src/TacitBridgeMixer.sol:359-360` (working tree) vs committed `HEAD:353` (native). The real `Groth16Verifier` rejects native order (`forge test_nativeOrder_is_rejected` PASS). The **live** mixer carries the swapped order (verified by bytecode disassembly above), so the deployed instance is fine — **but the fix is not in source-of-record**, so a CI build / fresh clone / mainnet deploy compiles the native order and `withdrawFromBurn` reverts `InvalidGroth16Proof()` for every legitimate burn, permanently stranding all deposits with no admin recovery (both contracts immutable; grep confirms zero owner/pause/rescue/reanchor functions).
**Fix:** commit lines 359-360; add a CI gate that runs `Groth16VerifierReal.t.sol` + `BridgeWithdrawRealProof.t.sol` against the exact bytecode to be deployed; pin the deployed creation-bytecode hash and fail the deploy if `TacitBridgeMixer.sol` is dirty.

### 2. [HIGH · fund-LOCK · reorg] Deep Bitcoin/signet reorg permanently bricks `proveStateTransition`
`SP1PoolRootVerifier.sol:155` (`prevBlockHash==currentState.lastBlockHash`) **and** `:160` (`lastBlockHash==RELAY.tip()`), with no finality window and no admin/reset (verified immutable). The guest only proves a forward-extending PoW chain from the prior anchor (`main.rs:205-211`). `BitcoinLightRelay.advanceTip` is permissionless heaviest-chain fork choice (`:117-177`) and the relay validates only PoW, **not** the signet signer signature — so on signet (the actual settlement layer) any party can mine a heavier branch on demand. Orphaning the anchored tip makes both conditions jointly unsatisfiable forever → no future burn accepted; via `verifyBlock` re-anchoring (`TacitBridgeMixer.sol:254`) even already-accepted-but-orphaned burns become unwithdrawable. Fund-LOCK of all escrowed ETH; recovery requires full redeploy + re-prove.
**Fix:** accept `lastBlockHash` as `RELAY.tip()` OR a confirmed ancestor within N blocks (the relay already stores `blockParent`/`blockHeight`, and its own comment at `:16-20` anticipates this), and/or a timelocked guarded re-anchor. Pre-stage a signet redeploy+re-prove runbook regardless.

### 3. [MEDIUM · fund-LOCK · capacity] Pool-tree exhaustion silently skips mint
`main.rs:264` `if !trees[di].can_insert() { continue; }`; `MAX_LEAVES = 1<<20` (`merkle.rs:5,70`). mint (`:266`), rotate (`:291`), and import (`:383`) all add leaves; nothing frees a slot. The on-chain `deposit()` gates only on the *separate* deposit tree (`TacitBridgeMixer.sol:218`), so a popular (or attacker-spammed-via-rotate — one note can be rotated indefinitely, each adding a leaf) denomination's pool tree exhausts while deposits keep locking ETH. After exhaustion, deposited ETH mints no tETH and there is no reclaim. Permanent fund-LOCK of post-exhaustion deposits.
**Fix:** treat a full-pool mint as a hard guest error (or add a reclaim path) rather than a silent skip; share the deposit/pool index domain so `deposit()` can reject at capacity; raise `TREE_DEPTH` if monotonic rotate/import growth is expected.

### 4. [MEDIUM · fund-LOCK · deploy-config] No PROGRAM_VKEY↔committed-ELF binding
Deployed `PROGRAM_VKEY = 0x00ee623e…` (immutable, `SP1PoolRootVerifier.sol:82`) corresponds to the committed ELF, but nothing in CI/deploy recomputes `vkey(committed ELF)` and asserts equality. A guest rebuild (e.g. to include the uncommitted hardening) without a coordinated verifier redeploy makes every `proveStateTransition` revert at the SP1 verify step (`:111`) → no burns accepted → all withdrawals brick (LOCK-4).
**Fix:** deploy/CI preflight deriving vkey from the committed ELF (`contracts/sp1/script/src/vkey.rs`) and failing the broadcast on mismatch; pin the canonical vkey as a checked-in constant.

### 5. [MEDIUM · worker-omission fund-LOCK] No leaf-set completeness check
`dapp/tacit.js:38822-38944` enforces monotonic order + per-leaf crypto re-verify but **no contiguity/completeness** check against any on-chain Tacit-side leaf count/accumulator. A malicious or buggy worker that **omits a real middle leaf** yields a non-prefix local tree whose root the SP1 prover never held; the user's burn (`tacit.js:10650-10746`) then spends the Bitcoin nullifier against a root that reverts `UnprovenRoot` forever (`TacitBridgeMixer.sol:321-322`). Survives the prior "worker-poison FIXED" claim, which only blocks FAKE leaves, not OMITTED real ones. (Recoverable in principle at the consensus layer — the guest's `null_set.insert` is reached only *after* the known-root gate — but the shipped tooling marks the nullifier spent and blocks retry, so there is no in-product recovery.)
**Fix:** gate `mp.root` on an authenticated anchor (leaf-count == on-chain canonical count, or `mp.root` reproducible from the published `rootAccumulator`/known-roots set) before consuming the Bitcoin nullifier (WD-1).

### 6. [MEDIUM · functionality/T5] rotate/import leaves misrouted → local-tree truncation
`dapp/tacit.js:38885-38909` routes everything but `bridge_deposit`/`slot_*` to `verifyMixerDepositKernelOnChain`, which requires a Taproot `T_DEPOSIT` envelope (`:13752-13756`); `bridge_rotate`/`bridge_import` are bare-OP_RETURN, so the kernel check fails and the apply loop **breaks**, truncating every user's local pool tree at the first transfer/import leaf. Breaks the import→burn fungibility path for everyone after that point; triggered by ordinary protocol use (WD-2).
**Fix:** add `bridge_rotate`/`bridge_import` to the bridge-leaf dispatch with a dedicated bare-OP_RETURN verifier mirroring `_verifyBridgeDepositProof`.

### 7. [HIGH · functionality/T5] Third-party fractional redemption unimplemented
`buildAndBroadcastBridgeExport` (0x63 — the only hop that makes a guest-trackable, splittable tETH UTXO) has **zero callers** (`dapp/tacit.js:10766`; independently confirmed — defined once, never invoked). The only working "make tETH spendable" UI emits generic mixer `T_WITHDRAW` opcode 0x2A, which the bridge guest does not handle (`main.rs:387 _ => {}`), producing a UTXO that import (0x64) can never consume (`main.rs:372-374`). So a recipient of 0.1 tETH has no path back to 0.1 ETH. The protocol/guest supports the split (CXFER conserves on arbitrary amounts, 0.1 is a registered denom); the client never wires export→CXFER-split→import (T5-02).
**Fix:** wire export 0x63 → `buildAndBroadcastCXferMulti` split → recipient import → `bridgeQuickBurnFromHoldings`; or gate the send UI to whole-note granularity and document the limit. Then add a real end-to-end test (T5-03).

## Should-fix (not launch-gating on their own)

- **GC-1 [medium · assurance]:** zero test coverage of the fund-critical export/import/rotate/CXFER conservation logic (`main.rs:270-437`) and no CI `cargo test` on the SP1 crates. Refactor CXFER into a pure helper; add conservation round-trip, duplicate-`(txid,vout)`, and Pedersen-opening parity tests in CI.
- **T5-03 / LOCK-5 [medium · correctness]:** no real (non-stubbed) on-chain `withdrawFromBurn` round-trip has ever executed; both cross-chain seams are mocked. Make a real export→split→import→SP1-accept→withdraw round trip a release gate.
- **SP1V-2 / RELAY-2 / LOCK-6 [low · liveness]:** strict `RELAY.tip()` equality lets cheap signet tip churn / `advanceTip` front-running stale every proof and withdrawal-inclusion proof. Resolved by the same finality-window fix as blocker #2.
- **BTC-1 / BTC-2 [low · correctness]:** guest lacks "complete block" invariants (no 64-byte-tx reject, no coinbase check, no duplicate-txid bound) and several parsers panic on malformed bytes (would abort a whole block proof). Not exploitable on canonical data; make parsers total.
- **WD-3 [low · UX fund-LOCK]:** burn UI doesn't pre-check live `totalBalance()` before consuming the nullifier. Harmless under the conservation invariant; add an `eth_call` guard.
- **T3-03 / T2-INFO-2 / DS-2 [low · footgun]:** `nullifier_hash` omits denomination with a global guest set; reusing a preimage across denoms self-locks the second deposit, and the global-set invariant is the sole double-withdraw guard if ever refactored. Ensure fresh per-note preimage; consider binding denom into the nullifier.
- **GC-4 / T2-LOW-2 / SP1V-4 / T2-LOW-1 [low · deploy-config]:** commit + rebuild + re-pin the guest hardening (u64-denom assert, pairwise-distinct denoms `main.rs:35-39`, `checked_add`) before any denom reconfiguration; add `require(poolIds_.length<=16)`; self-derive `poolIds` from `denominations` in the verifier constructor; set `overflow-checks=true` in the guest release profile (empirically absent).
- **SP1V-3 [low · deploy-config]:** gate the Mock* verifier fallback in `DeployTestnet.s.sol` behind a chainid/test-only guard (mainnet `Deploy.s.sol` already fails closed).
- **RELAY-3 / RELAY-4 [low/info · correctness]:** no header timestamp/MTP validation; `testnetGenesis` drops the epoch-alignment assertion. Footguns for a mainnet promotion reusing the script shape.
- **BIND-01 [info]:** `bigintToBytes32` silently reduces mod the secp256k1 order; not exploitable today, use a non-reducing BE-32 serializer for protocol field encodings.

## Empirical evidence

**Forge suite:** clean build OK; `forge test --no-match-test invariant` → **86 passed, 1 failed** (the "86 green" count is literal but not 86/86). The one failure is a **false positive**: `testnetGenesis(...)` in `DeployTestnet.s.sol` is a deploy helper the fuzzer targets only because its name starts with `test`; its counterexamples trip `require(tipWork_>0)` / the `DEPLOYER` guard. Not in `forge test --list`; rename it to clear the noise.

**Audit-critical suites (re-run against current source):**
- `test/Groth16VerifierReal.t.sol` — **4/4 PASS** (native order rejected, swapped/precompile order accepted, tampered public input rejected, native-envelope→swapped-extraction accepted).
- `test/BridgeWithdrawRealProof.t.sol` — **2/2 PASS** (`test_realBurnProof_releasesEth` full round-trip releases ETH; `test_doubleWithdraw_reverts`).

**Guest tree-crate:** `cargo test` → **12/12 PASS** (Poseidon parity, frontier-soundness should-panics, nullifier soundness). CXFER `checked_add` confirmed at `main.rs:405,422`. **`overflow-checks` profile NOT set** in any guest manifest — defense-in-depth gap.

**VK parity (PASS):** on-chain `Groth16Verifier.sol` == guest `vk.json` == ceremony `verification_key.json` for alpha/beta/gamma/delta + IC0..IC5 (with the snarkjs→Solidity Fq2-half swap). The pre-ceremony **dev key is absent** from the verifier and the deploy path (gitignored, untracked, never read at deploy). `tests/ceremony-vk-pin.test.mjs` → 6/6 PASS and is not a no-op (mutation test correctly fails on a single-digit change); it pins the **source** file, not on-chain runtime bytecode.

**Deploy gap (FAIL — not production-ready):** live Sepolia stack (run `1780053770197`, commit `a038d36`): mixer `0x93c20B1c…74c4E`, verifier `0x3D395b83…1f5A`, real Groth16Verifier `0x346260631C…07Ed`, real SP1 verifier `0x397A5f…DA9B`, relay `0x55fEA1Fd…`, `PROGRAM_VKEY 0x00ee623e…`. **Live mixer bytecode = swapped/correct G2 (verified by disassembly).** Uncommitted: the mixer G2 swap and the guest `main.rs`/`bitcoin.rs` hardening; the committed ELF predates the hardening, so `PROGRAM_VKEY` corresponds to the unhardened guest. **No real on-chain `withdrawFromBurn` has ever executed** (e2e Phase-3 is manual/never run). Note: the live addresses here supersede the older `0xc603…79bBF` / `0x3BF9…4806` cited in the prior audit doc.

## Go / no-go checklist for mainnet

1. **Commit** the G2 swap (`TacitBridgeMixer.sol:359-360`); add a CI gate running the two real-proof suites against the to-be-deployed bytecode and pinning the creation-bytecode hash. *(blocker #1)*
2. **Add a finality-window or guarded re-anchor** to `SP1PoolRootVerifier` so a sub-N reorg cannot permanently brick state advancement; pre-stage a redeploy+re-prove runbook. *(blocker #2)*
3. **Fix pool-tree exhaustion**: hard-error or reclaim on full-pool mint instead of silent skip; reconcile deposit/pool capacity. *(blocker #3)*
4. **Add a deploy/CI vkey preflight** asserting `vkey(committed ELF) == PROGRAM_VKEY`; commit + rebuild + re-pin the guest hardening. *(blocker #4)*
5. **Gate the burn on an authenticated complete-leaf-set/root** before consuming the Bitcoin nullifier. *(blocker #5)*
6. **Route rotate/import leaves** to a correct bare-OP_RETURN verifier; **wire the export→split→import** flow (or gate+document whole-note redemption). *(blockers #6, #7 / T5)*
7. **Test coverage:** CI `cargo test` on SP1 crates; conservation/duplicate-vout/Pedersen tests; one **real on-chain** export→split→import→SP1-accept→`withdrawFromBurn` round trip releasing exactly 0.1 ETH. *(GC-1, T5-03, LOCK-5)*
8. Use the fail-closed mainnet `Deploy.s.sol`; redeploy mixer + verifier **atomically** (mutually address-bound); re-wire the ceremony-key Groth16Verifier; verify on-chain.

Only after 1–8 should real value be admitted. As of this review the bridge is **conditionally fixable but not deployable** to mainnet: T1–T4 are sound by design, but two confirmed permanent fund-LOCK paths, a deploy-state gap, and an incomplete T5 flow remain.
