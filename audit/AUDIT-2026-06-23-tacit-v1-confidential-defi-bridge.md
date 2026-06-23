# Tacit v1 — Confidential DeFi & Bitcoin↔Ethereum Bridge Security Audit

**Scope:** value conservation, double-spend, inflation, and value-drain safety across the Tacit
confidential-pool contracts, the SP1 guest/prover code, the Bitcoin↔Ethereum reflection bridge, and the
JS assembler/indexer mirror that must agree with the guest byte-for-byte.

| | |
|---|---|
| **Protocol** | Tacit — confidential DeFi + trustless BTC↔ETH bridge (~26 confidential ops) |
| **Repository** | `tacit` |
| **Branch** | `confidential-relay-fees` |
| **Base commit** | `76625c07ca778c06049771815ae5e1d10637563f` (`76625c0`, 2026-06-23) |
| **Audit date** | 2026-06-23 |
| **Auditor** | Claude Code — model **Opus 4.8 (1M context)** (`claude-opus-4-8[1m]`), effort setting **`ultracode`** (multi-agent workflow orchestration, adversarial verification) |
| **Method** | 5 sequential multi-agent passes (137 sub-agents total): broad finding → adversarial per-finding verification → synthesis with a completeness critic. See *Methodology* and *Proof of Agents*. |

---

## 1. Executive summary

This was a holistic, multi-file audit focused on the **sanctity of user funds and accounting**: no path may
inflate supply, drain backing/escrow, double-spend a note (including the cross-lane case — a note spent on
Bitcoin and re-credited on Ethereum), double-count a leaf/share/debt, or forge a cross-chain event.

The review identified **two systemic defect classes** and several individual issues; all fund-critical
findings are **resolved in source**, and a final comprehensive accounting pass over eleven value surfaces
found **no remaining double-spend, inflation, drain, or conservation defect**.

**Readiness:** sound for a hardened v1, with **no fund-critical blockers on source value-conservation**,
conditional on the project's already-planned **coordinated re-prove + redeploy** (the guest-resident fixes
are enforced on-chain only once the new verification keys are pinned and the pool is redeployed — a
mechanical proving step, no new trusted setup).

**Findings at a glance**

| ID | Severity | Area | Status |
|----|----------|------|--------|
| F-1 | Critical | Adaptor/stealth refund — relay-fee bound | ✅ Resolved in source |
| F-2 | High | Burn-deposit provenance — output vout binding | ✅ Resolved in source |
| F-3 | High | Reflection cxfer/bid fold — note outpoint keying | ✅ Resolved in source |
| F-4a/b/c | Critical ×3 | AMM reflection folds (LP add / LP remove / fee-claim) — note outpoint keying | ✅ Resolved in source |
| F-5 | High | Farm bond/unbond — guest/JS classification parity | ✅ Resolved (fail-closed); full parser is a pre-enablement follow-up |
| A-1 | Low | CDP host serializer numeric precision | ✅ Resolved in review (fail-closed) |
| A-2..A-6 | Info | Defense-in-depth / dormant / operational | ◻ Accepted / documented |
| A-7 | Info | Deep-reorg-across-retarget (relay) | ◻ Accepted (SPV trust assumption) |

The two systemic classes were **(1)** an under-constrained relay-fee leg on two refund ops, and **(2)** a
note-to-Bitcoin-outpoint *keying* convention that was applied inconsistently across the reflection folds.
Both are now closed through a single, shared source of truth and locked with regression tests.

---

## 2. Scope — files reviewed

**Smart contracts**
- `contracts/src/ConfidentialPool.sol` — the on-chain value engine (settle, payouts, escrow, nullifier set, reserve floor, AMM/LP loops, bridge gates, lock/CDP trees)
- `contracts/src/CollateralEngine.sol` — cBTC escrow gate + cUSD CDP controller + (dormant) stability fee / savings rate
- `contracts/src/FarmController.sol` — reward-per-share farm controller
- `contracts/src/CanonicalAssetFactory.sol`, `contracts/src/CanonicalBridgedERC20.sol` — canonical token issuance / mint authority
- `contracts/src/lib/BitcoinLightRelay.sol` — Bitcoin header-chain finality root
- `contracts/src/BtcCallExecutor.sol` (call-execution boundary)

**SP1 guest / prover**
- `contracts/sp1/confidential/src/main.rs` — all confidential op handlers
- `contracts/sp1/confidential/src/reflect.rs` — reflection fold + scan
- `contracts/sp1/confidential/src/swap_batch.rs` — in-guest batch verifier
- `contracts/sp1/confidential/cxfer-core/src/{lib.rs,bitcoin.rs,burn_deposit.rs,eth_reflection.rs,bjj.rs,sigma.rs}` — crypto primitives, folds, accumulators, Bitcoin parsing, burn-deposit provenance
- `contracts/sp1/eth-reflection`, `contracts/sp1/reflect-exec`, `contracts/sp1/reflect-stdin` — host/exec mirrors

**JS assembler / indexer (must mirror the guest)**
- `dapp/confidential-pool.js`, `dapp/burn-deposit-bitcoin.js`, `dapp/confidential-reflection-scan-indexer.js`, `dapp/burn-deposit-provenance.js`, `dapp/confidential-relay.js`, and the authoritative outpoint resolver in `dapp/tacit.js`

---

## 3. Methodology

The audit was run as five sequential multi-agent passes under Claude Code (`ultracode`). Each pass fans a
set of independent finder agents across the surface, pipelines every candidate finding into an **adversarial
verifier** (whose default is to refute), then synthesizes with a **completeness critic**. Findings were only
accepted after a verifier confirmed reachability and the absence of a missed guard, and every fix was
re-verified by a later pass.

| Pass | Focus | Sub-agents |
|------|-------|-----------|
| 1 | Broad fund-conservation / drain / double-spend / inflation / cross-chain audit (14 components) | 87 |
| 2 | Adversarial re-verification of the first fixes + relayer-fee-throughout + conservation/privacy/bridge sweep | 15 |
| 3 | Deep hunt on the outpoint/vout-keying class + double-spend angles | 12 |
| 4 | Convergence check — keying class fully closed across every fold site | 5 |
| 5 | Holistic accounting audit over 11 value surfaces + completeness critic | 18 |

The protocol's trust model — the contract trusts the SP1 proof for hidden-amount conservation, ranges,
nullifier correctness, and opening-sigma bindings, and enforces only *structural* anti-replay on-chain
(nullifier uniqueness, the `#spent ≤ #leaves` reserve floor, AMM pre==live + constant-product floor,
per-asset escrow caps, value bounds, and payout scaling by a trusted unit-scale the guest never sees) —
was used as the lens for every finding: a defect is a place where **neither** the guest **nor** the contract
enforces a needed invariant, or where a public value the contract acts on is not bound by the proof.

---

## 4. Resolved findings

> Findings are described by the invariant that was under-constrained and the change that restores it.
> Severity reflects the value impact were the invariant left unenforced once the guest is live on-chain.

### F-1 — Critical — Relay fee on adaptor & stealth *refund* was not bounded by the locked value
**Where:** `contracts/sp1/confidential/src/main.rs` — `OP_ADAPTOR_REFUND`, `OP_STEALTH_REFUND`.
**Invariant:** a public relay-fee leg must be bounded by the value of the note it is carved from.
**Detail:** both refund handlers carved a public `FeePayment` using only the fee-aware conservation kernel,
which fixes the relation between the input and output commitments over the scalar field but does **not**
bound the fee against the (u64) note value, and neither handler range-bound or opening-bound the refund
output. Every *other* fee-bearing op already enforced a `fee < value` bound (or bounded the fee structurally
via an all-outputs range proof). The two refund ops were the sole exception.
**Resolution:** the locked value is now pinned to a u64 before the fee is carved — `OP_STEALTH_REFUND` uses
the leaf-pinned `amount` (bound to the note at lock time), and `OP_ADAPTOR_REFUND` re-opens the locked note
to its u64 value via an added opening sigma (domain `tacit-adaptor-refund-v1`) — followed by
`assert!(fee < amount)`. A `cxfer-core` regression test (`refund_fee_must_be_bounded_by_the_locked_value`)
exhibits the kernel-only gap and the restored bound.
**Re-prove:** yes (guest change; rides the pending coordinated re-prove). The refund witness gained an
opening field, mirrored in the box harness; no live dapp adaptor-refund serializer exists, and the stealth
refund builder already derives `net = amount − fee`.

### F-2 — High — Burn-deposit provenance trusted a witnessed output→vout mapping
**Where:** `contracts/sp1/confidential/cxfer-core/src/burn_deposit.rs` — `verify_cxfers`.
**Invariant:** a producer transaction's confidential output must be keyed at the Bitcoin vout its opcode's
layout dictates, not at a value supplied in the witness.
**Detail:** the scan-free provenance DAG paired each envelope-canonical output commitment with a *witnessed*
`output_vouts[i]`, length-checked only. The "confidential-output-index → Bitcoin-vout" convention enforced
elsewhere was not enforced here, so the mapping between a producer's output commitments and their on-chain
positions was attacker-controllable.
**Resolution:** the vout is now derived from the envelope opcode via a shared `canonical_output_vout`
(identity for `T_CXFER`/`T_CXFER_BPP`/`T_AXFER`/`T_AXFER_BPP`; the interleaved `{0→0, 1→2}` for the
variable-amount atomic-settlement `T_AXFER_VAR`/`T_AXFER_VAR_BPP`), exactly mirroring the authoritative
`commitmentForUtxo` resolver; the witnessed value must equal it (fail-closed). Unit + rejection tests added.
**Note:** the initial fix used a blanket identity mapping; review caught that `T_AXFER_VAR` is *interleaved*
and the fix was corrected before merge so legitimate variable-amount settlement provenance is preserved.
**Re-prove:** yes (guest change).

### F-3 — High — Reflection cxfer/bid fold keyed notes at the output index, not the real Bitcoin vout
**Where:** `contracts/sp1/confidential/src/reflect.rs` — cxfer fold and preauth-bid fold.
**Invariant:** an onboarded note must be inserted into the live UTXO set at its **real** Bitcoin outpoint, so
a later spend of that note is detected.
**Detail:** the live reflection fold keyed `T_AXFER_VAR`/`T_AXFER_VAR_BPP` outputs (and preauth-bid outputs)
at the output index plus a uniform offset, which does not match the interleaved on-chain layout. A note keyed
at the wrong outpoint is not matched when later spent — a cross-lane spend-detection gap.
**Resolution:** both folds now derive each note's vout from the shared `canonical_output_vout` /
`canonical_bid_output_vout` (the latter accounts for the buyer-refund branch via a new
`preauth_bid_var_has_refund` helper); an unmapped layout skips-not-panics, keeping the witness stream in sync
with the JS assembler. The JS classifier (`burn-deposit-bitcoin.js`) and indexer
(`confidential-reflection-scan-indexer.js`) were updated to emit/key the identical per-opcode vouts.
**Re-prove:** yes (guest change; JS mirror deploys in lockstep).

### F-4a / F-4b / F-4c — Critical (×3) — AMM reflection folds keyed witness-envelope notes one vout too high
**Where:** `contracts/sp1/confidential/src/reflect.rs` — `T_LP_ADD`/`POOL_INIT` (share note), `T_LP_REMOVE`
(both withdrawn notes), `T_PROTOCOL_FEE_CLAIM` (claim note); mirrored in `dapp/confidential-pool.js`.
**Invariant:** same as F-3 — onboarded notes must be keyed at their real Bitcoin outpoint.
**Detail:** these three ops carry their envelope in the Taproot **witness** (no `OP_RETURN` at vout 0), so
their tacit notes begin at **vout 0** — but the folds keyed them one vout higher (matching the convention of
the `OP_RETURN`-prefixed ops, which legitimately start at vout 1). The mis-keyed notes would not be matched
when later spent — the same cross-lane spend-detection class as F-3, on the AMM lane.
**Resolution:** a shared `canonical_amm_output_vout` now supplies the correct vout (`T_LP_ADD` share → 0,
`T_LP_REMOVE` recvA → 0 / recvB → 1, `T_PROTOCOL_FEE_CLAIM` claim → 0), matching `commitmentForUtxo`; applied
in the guest folds and the JS state machine, with a unit test locking the convention. The `OP_RETURN`-prefixed
AMM/farm ops (swap-var, swap-route, harvest, farm-refund, unbond) were independently confirmed correct.
**Re-prove:** yes (guest change; JS mirror in lockstep).

### F-5 — High — Farm bond/unbond folded by the guest but not classified by the JS scan
**Where:** `dapp/burn-deposit-bitcoin.js` — `classifyConfidentialTx`.
**Invariant:** the JS assembler and the guest must agree on which transactions are folded, so the witness
stream stays in sync (the on-chain digest chain attests continuity, not fold correctness).
**Detail:** the guest reflection folds `T_LP_BOND`/`T_LP_UNBOND` (reading a per-op receipt witness), but the
JS classifier had no parser for them, so such a transaction would desync the assembler from the guest.
**Resolution (interim, applied):** the classifier now flags `T_LP_BOND`/`T_LP_UNBOND` as `unsupported`, which
makes the attester **refuse** the batch rather than mis-attest — the fail-closed, sound state.
**Correction to the full-fix scope (found while implementing it):** a JS envelope parser alone is *not*
sufficient. The `0x35`/`0x36` envelopes do not carry the receipt's `owner`/`nonce` — those are the bonder's
blinded values that the guest reads as *witnesses* (`reflect.rs`), so the worker reflection scan cannot
reconstruct them from on-chain bytes. The real fix is therefore a worker-side design that sources the
bonder's receipt data (or, cleaner for launch if the Bitcoin farm-reflection lane is deferred, a guest change
that simply does **not** fold `0x35`/`0x36` in the reflection scan so the worker skips them too — a re-prove,
but it retires the residual halt-on-broadcast entirely). Until one of those ships, the fail-closed throw is
the correct state and the Bitcoin farm-bond lane stays gated. A parser without `owner`/`nonce` sourcing was
deliberately **not** shipped, as it would re-introduce a desync.

#### Cleanups & hardening applied in this review (no re-prove)
- **`[7]` Prover-host vkey-drift abort (all groth16 box bins).** Factored `exec_confidential.rs`'s
  `assert_vkey` into the shared `prover_host` lib and made it **mandatory** in `exec_crosslane{,_swap,_lp,_otc,
  _bid}`, `exec_crossout`, `exec_swap/lp/otc/bid`, and `exec_route` — a drifted ELF now aborts before the GPU
  spend instead of producing a late on-chain-rejected proof. (Box-built; the crate is box-only by design.)
- **`A-1` CDP serializer precision.** `confidential-cdp.js` now serializes u64 amounts (`debtValue`/`value`/
  `fee`/`vBtc`) as decimal strings; the `exec-cdp{mint,close,topup}`/`exec-cbtcmint` box harnesses read them
  via a number-or-string helper (indices stay numeric). Removes the >2^53 float truncation; CDP JS tests pass.
- **`[32]` Generated-from-source storage-slot check.** Added `verify-reflection-slots.sh` (wired into
  `readiness-gate.sh`) pinning the eth-reflection `*_SLOT_INDEX` constants to the compiled `ConfidentialPool`
  layout; it skips gracefully where the current `via_ir` solc omits the layout and auto-activates (failing on a
  real drift) once a solc that emits it is used. `extra_output = ["storageLayout"]` declared in `foundry.toml`.
- **`[31]` De-tautologized the `bitcoinConsumedAt` slot test** (it read back the same computed slot); it now
  reads the literal slot, so a constant drift off 163 fails. 4/4 pass.
- Gated the dead cross-curve sigma reference implementation (`cxfer-core/src/sigma.rs`) behind `#[cfg(test)]`
  so it cannot drift into the proving build (the live verifier is `babyjubjub::verify_xcurve`).
- Corrected a stale comment that described the in-guest batch verifier glue as unfinished (it is implemented
  and wired); added a maintainer-invariant comment on the btcHomed value-exit guard's hand-maintained field
  enumeration.
- Fixed a host telemetry digest offset in `run-reflect-loop.sh` (dynamic-tuple offset word; telemetry only).
- Documented the relay-fee privacy posture (flat per-op fee) in `confidential-relay.js`.
- Clarified the dormant stability-fee parity comment and the reserved `cbtcBackingSats` interface member.

---

## 5. Accepted / documented findings (no fund-critical impact)

All items below are info/low and are **value-neutral, fail-closed, dormant, or operational** — none provides a
path to inflate supply, drain backing, or double-spend.

- **A-1 (Low) — CDP host serializer numeric precision. ✅ RESOLVED in this review** (see §4). Was: u64 amounts
  serialized through a 64-bit float, losing precision above ~2^53 base units — strictly fail-closed (the
  opening sigma binds value to the commitment, never a membership leaf), so it could never move value, only
  make very large CDPs unbuildable. Now serialized as decimal strings, read number-or-string in the box
  harness. No re-prove; box harness fixtures regenerate.
- **A-2 (Info) — btcHomed batch with nullifiers but no value output skips consumed-ν recording.** Value-neutral
  (no payout/leaf/escrow moves; the reserve floor is untouched) and only reachable by the note's own owner.
  Optional contract-side defense-in-depth.
- **A-3 (Info) — cBTC rug-slash liveness depends on reflection progress.** A reflection stall delays, never
  prevents, slashing; the escrow is structurally frozen while cBTC is outstanding, so no value is at risk.
  Post-launch: an engine-side freshness gate (the on-chain freshness signal already exists) + a slash keeper.
- **A-4 (Info) — Stability-fee accumulator overflow under extreme *activated* parameters.** Dormant in v1
  (the fee short-circuits at zero). If ever activated, saturate-rather-than-revert keeps closes/liquidations
  live. No re-prove.
- **A-5 (Info) — eth-reflection genesis sync-committee is statically pinned.** A stale anchor fails closed
  (no proof can be produced); fold contents are independently bound by the digest chain + freshness count.
  Operational re-anchor before the pinned genesis ages out of the light-client serve window.
- **A-6 (Info) — Router transit-dust attribution.** The periphery router is non-custodial (no storage, every
  entrypoint targets `msg.sender`, all `nonReentrant`); worst case is a careless caller's own dust. Pool
  backing/supply/reserve floor are unaffected.
- **A-7 (Info, accepted) — Deep reorg across a difficulty-retarget boundary.** A Bitcoin reorg deeper than the
  confirmation window and spanning a 2016-block boundary is the standard SPV trust assumption; documented in
  the relay NatSpec and accepted for the gated pilot.

---

## 6. Security posture — surface-by-surface verdict

The final holistic accounting pass returned **SOUND** on all surfaces:

| Surface | Verdict |
|---|---|
| Per-op note value conservation | Sound — kernel + all-outputs range + per-asset/dest binding; fees bounded |
| Nullifier / spent-set accounting | Sound — one-shot per set; reserve floor correct; cross-lane consume folded |
| Merkle / accumulator integrity | Sound — append-only, roots computed not witnessed; digest chain non-rollback |
| Escrow / backing | Sound — per-asset cap; pool-minted vs escrow split; unit-scale heal cannot poison |
| Cross-chain peg (mint/burn/stealth/fast-lane) | Sound — exact peg, one-mint-per-burn, source-consume, dest pinned |
| AMM (swap / LP / route / batch / fee-claim) | Sound — pre==live + constant-product floor; rounding favors the system |
| CDP / cUSD / TSR | Sound — full-lifecycle conservation; controller-derived sole-mint debt |
| cBTC peg / escrow / slash / redeem | Sound — conservation peg; escrow frozen while outstanding; one-mint-per-lock |
| Reflection / relay | Sound — BIP141 witness-commitment; freshness + digest anchoring; heaviest-chain relay |
| Contract arithmetic / ordering / reentrancy | Sound — value entrypoints `nonReentrant`; reserve accounting correct |
| Guest↔contract public-values binding | Sound — field-by-field binding complete; storage-slot constants match |

---

## 7. Pre-launch checklist

These are **process** requirements, not unresolved defects:

1. **Coordinated re-prove + redeploy.** The F-1..F-4 fixes are guest-resident; they are enforced on-chain only
   after the rebuilt ELF's verification keys are pinned and the pool is redeployed. The deployed prover **must
   run the exact committed canonical ELF** (an ELF/source drift produces on-chain-rejected proofs — a liveness
   brick, not a fund defect).
2. **Digest-match validation** of the JS↔guest fold mirror for the newer folds (stealth-receive, airdrop)
   before enabling those lanes, and — for the **F-5 farm bond/unbond lane** — design the worker-side sourcing
   of the receipt's blinded `owner`/`nonce` (a parser alone is insufficient; the values aren't on-chain) or
   take the guest-skip route, then validate. The farm-bond lane stays gated until then.
3. Regenerate the box prove fixtures for the changed ops (incl. the new adaptor-refund opening field and the
   string-serialized CDP amounts) and re-run the readiness gate (vkey coherence, the new storage-slot check,
   and the structural spend-detection tests — the only tests that catch the keying class).
4. Optional post-launch hardening: the remaining `A-2..A-6` items (all value-neutral / dormant / operational).
   The `A-1` serializer, `[7]` vkey-abort, `[31]/[32]` slot guards, and the cleanups were applied in this review.

## 8. Verification performed

- `cxfer-core` Rust unit/KAT suite: **145 tests pass** (incl. new fee-bound, canonical-vout, bid-layout, and
  AMM-vout regression tests).
- SP1 guest (`confidential-pool-prover` + `reflection-prover`): compiles clean.
- Foundry contract suites (CollateralEngine, FarmController, CanonicalAssetFactory, BitcoinLightRelay,
  ConfidentialPool KAT/Invariant/Fuzz): **136 tests pass, 0 failed**.
- JS reflection/burn-deposit suites (indexer, attest-scan, provenance, conservation, assembler): pass.
- Remaining box-proof fixtures (`*ProofReal`) regenerate during the coordinated re-prove.

---

## 9. Proof of agents

The audit ran as deterministic multi-agent workflows under Claude Code. Each run persisted a per-agent
transcript (`agent-*.jsonl`) plus a `journal.jsonl`. The SHA-256 below is taken over the sorted set of those
artifacts per run (hash-of-hashes), so the run is independently checkable.

| Run | Pass | Sub-agents | Artifacts | SHA-256 (transcript set) |
|-----|------|-----------|-----------|--------------------------|
| `wf_d8641af2-ef5` | 1 — broad audit | 87 | 88 files | `9202055e096377e2637f90af3c3d1c3a009b9b9dd8c43f226529f162bb4da8b0` |
| `wf_1c3ee76b-f9f` | 2 — verify + fee/conservation/privacy/bridge | 15 | 16 files | `39dc2f9551b6a225a55aab48f577d6d8505a49c928080af9313cf3c721a4c40a` |
| `wf_be6ec3bb-036` | 3 — keying-class hunt | 12 | 13 files | `e42316e6df61a08c93f4d8c90def76944cdd360d15c7f3dba6a4b821e6d70634` |
| `wf_b4743fa1-060` | 4 — keying convergence | 5 | 6 files | `159c61bcf90670b4dfdb7846715d0ea54aeaebd527f0503c7ed00e787a609f33` |
| `wf_60357e28-cf2` | 5 — holistic accounting | 18 | 19 files | `9f16c3fcfb4600042397d27d045b3cd36b180b75362c6ad005e12f228ac28eeb` |

**Combined proof-of-agents digest** (SHA-256 over the five run digests, in the order above):

```
75ba4469eea92fd1b08a12bef1f52efbeda3ae5969c471494394fb59e308f7a1
```

- **Total sub-agents:** 137 across five passes.
- **Model:** Claude Opus 4.8 (1M context), effort `ultracode`.
- **Base commit:** `76625c07ca778c06049771815ae5e1d10637563f`.

*(Transcript artifacts are retained in the audit run's session directory; the digests above bind the report to
those transcripts. Regenerating the hash over the same artifact set reproduces the digest.)*

---

*Report generated 2026-06-23 against branch `confidential-relay-fees`. Fund-critical fixes (F-1..F-5) are
applied in source on that branch and take effect on-chain with the coordinated re-prove + redeploy.*
