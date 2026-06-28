# Tacit — Security Audits

Tacit's confidential-pool + Bitcoin↔Ethereum cross-chain core was put through **multiple independent,
adversarial AI-model audits** (GPT-5.5 Pro and Claude Opus 4.8, Max mode) across several rounds before the code was
frozen for immutable deployment. Every report and a point-by-point maintainer response is committed in this
`audit/` directory and pinned to the exact commit reviewed, so anyone can trace a finding to the line of code
and to its resolution.

## Conclusive GPT-5.5 Pro audit (public transcript)

The final holistic readiness review, at commit `034308e`, is publicly readable in full:

**→ https://chatgpt.com/share/6a3d6968-5e2c-83ec-ad1b-535279feeccc** — GPT-5.5 Pro, full-scope, pre-lock.

Maintainer response: [`TACIT_FINANCE_FINAL_AUDIT_GPT55PRO-RESPONSE.md`](./TACIT_FINANCE_FINAL_AUDIT_GPT55PRO-RESPONSE.md).

A conclusive **Claude Opus 4.8 (Max mode)** pass ran the same full surface in parallel and returned the same verdict —
**lockable, no fund-critical and no High** — conditional only on the documented deploy-time gates. Response:
[`TACIT_FINANCE_FINAL_AUDIT_OPUS48-RESPONSE.md`](./TACIT_FINANCE_FINAL_AUDIT_OPUS48-RESPONSE.md).

## Follow-up hardening run — Opus 4.8 Ultracode (2026-06-27)

A later **multi-agent fan-out** pass (Claude **Opus 4.8, Ultracode** mode — parallel finder → adversarial
verifier → synthesizer workflows, ~75 sub-agents) re-audited the newest immutable work: the trustless
Bitcoin-lane farm (LP_BOND/HARVEST/UNBOND), cross-chain OTC/AMM/LP/farm parity, and the relay-fee surface.
It caught **two lock-blockers introduced by the in-flight farm work** (a receipt-spend authorization gap and
a resume-stream desync) plus several guest↔mirror parity gaps — all fixed and re-verified. Report, with the
findings table and a hand-off prompt for the next fresh-context round:

**→ [`AUDIT-2026-06-27-ultracode-opus48-farm-hardening.md`](./AUDIT-2026-06-27-ultracode-opus48-farm-hardening.md).**

## Greenlight pass round 1 — GPT-5.5 Pro (2026-06-27)

A pre-reprove pass over the frozen immutable surface, scoped to greenlight the re-prove + testnet
launch. Publicly readable in full:

**→ https://chatgpt.com/share/6a3fdedd-ac54-83ec-ada0-27b4a6d1875d** — GPT-5.5 Pro, immutable-surface, pre-reprove.

It caught **two real delegated-proving authorization gaps** — economically-meaningful witness fields not
bound into a per-op opening-sigma context: `rate_snapshot` in the CDP-mint family (a box could substitute a
stale snapshot to overcharge a borrower once a stability fee arms — High, dormant) and `rps_entry` in the
farm/LP-bond family (a box could future-date a receipt and grief yield — Medium). **Both fixed** (bound into
the guest contexts, JS mirrors + fixtures regenerated in lockstep). It also raised two non-issues we
dispositioned: the CDP-liquidation recipient binding (permissionless; the burned debt notes are the
liquidator's own) and the ETH-reflection storage-slot offset (false positive — the guest constants match the
compiled layout). Response, with all four dispositions:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE.md).**

## Greenlight pass round 2 — GPT-5.5 Pro (2026-06-27)

A second pre-reprove pass at commit `e90a1ba`, focused on the delegated-proving authorization seam, publicly
readable in full:

**→ https://chatgpt.com/share/6a3ff1d2-f85c-83ec-9e3a-60ab97fff599** — GPT-5.5 Pro, EVM farm + cross-lane.

It found **two real cross-component launch-blockers** in the EVM-lane farm receipt spends: harvest/unbond
omitted the Bitcoin spent-set nonmembership check on the cross-lane receipt nullifier (a cross-chain
double-spend path), and lacked the receipt-owner BIP-340 authorization the Bitcoin lane already requires (a
delegated box could capture the reward/principal). Both **fixed**, plus a Medium `LP_ADD` pool-identity
binding and a Low protocol-fee-recipient validation. Response, with all four dispositions:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2.md).**

## Greenlight pass round 3 — GPT-5.5 Pro (2026-06-28)

A third pre-reprove pass at commit `3b2ecfc`, publicly readable in full:

**→ https://chatgpt.com/share/6a4008a8-37d4-83ec-a251-4bdae6706e13** — GPT-5.5 Pro, CDP uniqueness + lp-bond.

It found **one fund-critical lock**: duplicate CDP position
leaves share one position nullifier, so spending one permanently locks the other's collateral — fixed
contract-side with a duplicate-leaf guard (no re-prove; the guest-pinned reflection slots are unchanged, and
the pool stays under the bytecode limit). Plus a Medium `OP_LP_BOND` pool-identity binding (mirroring the
round-2 `LP_ADD` fix, **fixed**), and a route path-binding flagged as by-design (the output opening binds the
exact `amount_out`, so the user gets what they authorized regardless of the relay's path). Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-3.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-3.md).**

## Greenlight pass round 4 — GPT-5.5 Pro (2026-06-28)

A fourth pre-reprove pass at commit `90fbd7e`, into the Bitcoin-reflection / reverse-bridge composition,
publicly readable in full:

**→ https://chatgpt.com/share/6a401e89-654c-83ec-b7b4-fa6858a88bde** — GPT-5.5 Pro, reflection atomicity + cross-out.

It found a class of reflection-fold atomicity bugs (a fold mutates value-bearing state, then can fail on a
prover-controlled append path while the caller ignores the error) plus a `T_CROSSOUT_MINT` replay
(ETH→BTC) with no consumed-claim gate (one ETH cross-out could mint N Bitcoin notes → cross-chain
inflation). **All fixed:** `fold_lp_remove` + `fold_swap_var` made atomic (byte-parity, guest-only);
`fold_lp_add` / `fold_lp_harvest` made atomic via a dispatcher snapshot/restore; and a consumed-cross-out
IMT added to the reflection state (committed in the digest + resume handoff) so a replayed claim has no
valid insert witness and the duplicate mint skips. The reflection genesis digest rotates with the new
state field; the guest↔JS DIGEST_MATCH gate passes for every fixture (incl. the replay-gate end-to-end).

## Greenlight pass round 5 — GPT-5.5 Pro (2026-06-28)

A fifth pre-reprove pass at commit `7b5dc2c`, into the Bitcoin-reflection / farm composition, publicly
readable in full:

**→ https://chatgpt.com/share/6a4046b3-3ca0-83ec-a1c7-48ae60273d01** — GPT-5.5 Pro, reflection/farm.

It found **two fund-critical issues**: a zero-share `T_LP_BOND` that panics the SP1 guest and permanently
stalls the forward-only Bitcoin reflection (a confirmed-tx DoS), and an unenforced farm refund/timing path
(launcher can refund mid-farm; the campaign window `start/end` was parsed-over). **All fixed:** the
zero-share bond (and a forged zero-share harvest) are rejected skip-not-panic; `fold_farm_refund` is gated on
no live stakers (no mid-farm rug); and the campaign window is now threaded through the farm state (parser →
`FarmRewardState` + `accrue` clamp → digest/resume → serializer → JS attester), so accrual is clamped to
`[start, end]` (EVM `periodStart/periodFinish` parity). Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-5.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-5.md).**

## Greenlight pass round 6 — GPT-5.5 Pro (2026-06-28)

A sixth pre-reprove pass at commit `bee4c88`, publicly readable in full:

**→ https://chatgpt.com/share/6a40ef2b-ab0c-83ec-8de7-2a7d2b4ca772** — GPT-5.5 Pro, protocol-fee claim auth.

It found a **High fund-loss**: the Bitcoin
`T_PROTOCOL_FEE_CLAIM` discarded the claimer pubkey + signature, so any prover could claim a pool's accrued
protocol-fee LP shares to their own note (the recipient authorization had been left to the off-chain worker,
which the trustless reflection proof doesn't run). Plus a **Medium** non-atomic `T_FARM_INIT` (a malformed
campaign window committed the treasury but not the reward state, stranding a funded farm) and a **Low** latent
panic-after-append in `fold_lp_unbond`. **All fixed:** the claim now authorizes in-guest by re-deriving
`pool_id` to prove the claimer is the bound recipient + a BIP-340 sig binding the claim and the vout-0
destination (no pool-root digest cascade); farm-init pre-validates the window so it's all-or-nothing; and the
unbond shares are guarded before the note append. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-6.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-6.md).**

## Greenlight pass round 7 — GPT-5.5 Pro (2026-06-28)

A seventh pre-reprove pass at commit `37b94da`, publicly readable in full:

**→ https://chatgpt.com/share/6a40ef21-05e0-83ec-914b-294cbac50ec0** — GPT-5.5 Pro, CDP-liquidation auth.

It found a **High fund-loss**: `OP_CDP_LIQUIDATE` burned the keeper's debt notes but the debt-note
authorization did not bind the public seized-collateral recipient (`liquidator`) or `fee`, so a delegated
prover could redirect the proceeds while reusing the keeper's witnesses (the same authorization-binding class
as the round-4 transfer-owner and round-6 fee-claim findings). Plus a Low off-curve protocol-fee recipient
(trap pool) and a Medium relay genesis-MTP deploy invariant. **Fixed:** the liquidation now binds
`liquidator` + `fee` into every debt note's opening-sigma context (verified guest-level: accepts the bound
witness, rejects a tampered liquidator); `OP_LP_ADD` rejects an off-curve fee recipient at the funding
boundary; the relay genesis is a documented epoch-aligned deploy invariant. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-7.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-7.md).**

## Greenlight pass round 8 — GPT-5.5 Pro (2026-06-28)

An eighth pre-reprove pass at commit `8c066af`, with the relayer/relay-fee threat model as the focus,
publicly readable in full:

**→ https://chatgpt.com/share/6a41141d-be98-83ec-b446-628648aed2a9** — GPT-5.5 Pro, relayer + Bitcoin reflection.

The
relay-fee sweep came back **clean** (the auditor independently confirmed every fee-carrying op binds the fee +
recipient into the user authorization — matching our post-round-7 uniformity audit). It found one **Critical
liveness** bug: a consensus-valid (but nonstandard) 64-byte Bitcoin transaction panics the reflection
full-scan (`compute_txid` blanket-rejected 64-byte serializations as an anti-merkle-collision mitigation), so
one mined block could permanently stall the Bitcoin→Ethereum reflection lane under the immutable vkey. Plus a
**Medium**: `OP_STEALTH_LOCK` bound its deadline in-proof but never surfaced it to the contract, so an expired
lock could still settle. **Fixed:** a 64-byte blob is now admitted iff it parses as a complete well-formed tx
(real txs flow, the merge-collision blob stays rejected — adversarially reviewed SOUND, guest↔JS parity); and
the stealth-lock deadline is folded into `min_deadline` so the contract reverts an expired lock. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-8.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-8.md).**

## Greenlight pass round 9 — GPT-5.5 Pro (2026-06-28)

A ninth holistic production-readiness pass at commit `8170004` (code `817000400fa4`), with Bitcoin-consensus ×
reflection-liveness as the priority vein, publicly readable in full:

**→ https://chatgpt.com/share/6a411bd1-9138-83ec-8772-9107cb907720** — GPT-5.5 Pro, holistic readiness.

It found **no fund-critical path** (the reflection-liveness vein held up: full txid/wtxid reconstruction,
witness commitment, duplicate-tail rejection, the round-8 64-byte fix, resume digests, and guest↔contract
ordering all line up). It flagged one **Medium** mode-boundary defect — a `receiptMode=false` plain-vault
`FarmController` still accepted receipt bond/harvest ops — plus four defensive items (lock the 64-byte CVE
invariant in tests; add `OP_PUSHDATA4` to the Taproot envelope parser; make LP envelope parsing exact-length;
document the deep-reorg-across-retarget relay limitation). **Fixed:** the receipt branch now mirrors the
bare-bond gate (`if (!RECEIPT_MODE) revert NotSupported()` — V1-safe, all V1 farms are receiptMode=true);
`OP_PUSHDATA4` is supported (guest + JS); LP_ADD/LP_REMOVE enforce exact lengths; the CVE invariant + relay
limitation are documented. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-9.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-9.md).**

## Greenlight pass round 10 — GPT-5.5 Pro (2026-06-28)

A tenth (confirmatory) pass at commit `1f7c7d3`, publicly readable in full:

**→ https://chatgpt.com/share/6a4132ff-a9b0-83ec-a5d6-e4356a3f2ee4** — GPT-5.5 Pro, reflection block-authn.

It did **not** come back clean: it reopened the round-8 64-byte reflection fix and found it **incomplete**
(F-01, Critical) — a miner can mine a real `[coinbase L, spend R]` block, then present a fake one-tx
reflection whose sole "tx" `C = txid_L‖txid_R` (ground to parse as a 64-byte tx) matches the header root and
masquerades as the coinbase, hiding `R`'s spend → cross-chain double-spend. The round-9 fixes (OP_PUSHDATA4,
LP exact-length, FarmController receipt-mode) were independently re-verified safe. **Fixed:** the full-scan now
authenticates the block-body shape — `tx[0]` must be a real coinbase (null prevout), no later tx may be —
which rejects the fake (its prevout isn't null); the complementary n_tx≥2 merge is caught by the BIP-141
witness commitment (a kept coinbase pins the wtxid root). Adversarially reviewed SOUND. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-10.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-10.md).**

## Greenlight pass round 11 — GPT-5.5 Pro (2026-06-28)

An eleventh (re-confirmation) pass at commit `bd83e5e`, publicly readable in full:

**→ https://chatgpt.com/share/6a4140d7-fd38-83ec-bbc3-2fcbd96281d1** — GPT-5.5 Pro, lock verdict.

**Verdict: LOCK — 0 fund-critical.** The auditor specifically re-attacked the round-10 reflection fix (the
one-tx coinbase merge, the kept-coinbase `n_tx≥2` merge vs the witness commitment, duplicate-tail on the txid
*and* wtxid trees, honest-prover panic surfaces) and swept the whole system (relayer threat model, ETH
reflection recursion + consumed-root freshness, cBTC backing/escrow, in-guest authorization + contract
surfacing, conservation, identity) — all held. Two non-fund-critical items only: a stale `nonwitness_tx_exact_len`
comment still stating the disproven round-8 foreign-block rationale (**fixed**), and an `assert!` in
`verify_tx_witness_committed` that the auditor confirms is a deliberate, honest-prover-unreachable rejection
boundary (**clarified**). Unlike round 9's clean result (on code that still had the round-10 Critical), this
clean is on the *fixed* code with the fix itself stress-tested. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-11.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-11.md).**

## Greenlight pass round 12 — GPT-5.5 Pro (2026-06-28)

A twelfth (final belt-and-suspenders) pass at commit `82ea3bf`, publicly readable in full:

**→ https://chatgpt.com/share/6a414883-ea9c-83ec-8996-ac52eeac97fc** — GPT-5.5 Pro, LP-add pid + parser.

It did **not** stay clean: it found a **Medium fund-loss** in the Bitcoin variant-0 `T_LP_ADD`
pool-disambiguation (it resolved the FIRST same-pair pool via `.first()` instead of the kernel-bound one, so a
victim's add to a non-first same-pair pool fails the kernels *after* its input notes were nullified → user
fund loss). The reflection block-authentication, cross-chain conservation, relayer, cBTC, and ETH-recursion
surfaces were all re-confirmed safe. Plus two no-exploit defensive items. **Fixed:** variant-0 LP-add now
mirrors LP-remove's disambiguation (select the unique candidate whose both kernels verify; guest + JS); the
segwit `compute_txid` parser gained the safe exactness checks (nonzero vin/vout + exact consumption); the cBTC
backing `saturating_*` is kept (a tracking value, provably non-overflowing/underflowing — converting to a
panic would add a forward-scan stall vector) and documented. The M-01 class was swept — it was the only
position-based pool selection; every other op carries an explicit/derived `pool_id`. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-12.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-12.md).**

## Greenlight pass round 13 — GPT-5.5 Pro (2026-06-29)

A thirteenth pass at commit `10c02ae`, publicly readable in full:

**→ https://chatgpt.com/share/6a4156a4-a210-83ec-848e-fca983ded418** — GPT-5.5 Pro, fold-atomicity.

It found one **High fund-impacting** issue — the reflection
fold-atomicity class (round 4's class), broadened from round 12's positional-selection finding to
witness-append atomicity: for the five `scan_tx_spends`-based AMM ops (`T_SWAP_VAR`/`T_SWAP_ROUTE`/`T_LP_ADD`/
`T_LP_REMOVE`/`T_LP_BOND`), the per-tx scan nullifies the victim's input + commits the spent root *before* the
op onboards its output, and the dispatcher consumed a witness-append failure with `.is_ok()`/`let _ =` — so a
malicious prover could attest a real block, let the input be nullified, then supply a bad append path → input
spent, output never minted → permanent lock/loss. **Fixed:** once an op's in-fold auth verifies, the
deterministic note append now **aborts** on failure (an honest prover never fails it) instead of skipping; the
LP-add round-4 partial-restore is replaced by the abort. **Class swept:** the sibling note-onboarding folds
(farm harvest/unbond/refund, protocol-fee claim, cross-out) consume their input atomically inside the fold, so
they can't strand. cxfer-core 154/154; DIGEST_MATCH gate green. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-13.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-13.md).**

## Greenlight pass round 14 — GPT-5.5 Pro (2026-06-29)

A fourteenth pass at commit `74ec0e1`, publicly readable in full:

**→ https://chatgpt.com/share/6a41604e-de08-83ec-8a30-671c74ab8655** — GPT-5.5 Pro, LP-add stall + atomicity.

Three fund-impacting findings: **F-01 (Critical)** — a regression of the round-13 fix: the LP-share-mint abort
boundary was too wide, catching tx-controlled SEMANTIC failures (a malformed share commitment) not just the
deterministic append, so a griefer's funding-valid LP-add with a bad share made every honest prover panic →
permanent stall; **F-02 (High)** — a verified scan-free burn-deposit could be silently omitted by a bad fresh
spent-set witness (`.is_ok()` skip) → bridge mint permanently blocked; **F-03 (Medium)** — farm-init accepts a
non-sentinel change the kernel permits but never onboards → launcher loses the residual. **Fixed:** LP-add
validates the share semantics BEFORE the abort (skip+restore on a bad share, abort only on a post-validation
append failure); burn-deposit adopts the main loop's duplicate-vs-fresh discipline (abort on a bad fresh
witness); farm-init rejects non-sentinel change (exactly-funded by design). JS attester mirrored; cxfer-core
154/154; DIGEST_MATCH gate green (affected fixtures digest-neutral). Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-14.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-14.md).**

## Greenlight pass round 15 — GPT-5.5 Pro (2026-06-29)

A fifteenth pass at commit `3421640` — the tightest yet (no Critical/High), publicly readable in full:

**→ https://chatgpt.com/share/6a416d33-1c74-83ec-b2be-57763f0b0d8c** — GPT-5.5 Pro, cross-out omit + atomicity.

The spend-nullifying folds and the round-13/14 boundary fixes were re-confirmed correctly narrowed. **M-01
(Medium)** — `fold_crossout` gated its onboard on `imt_insert(...).ok_or(...)?`, which returns `None` for both a
genuine replay and a bad fresh witness, and the dispatcher skipped it → a fresh, ETH-authorized cross-out mint
could be silently omitted (strand/censor, not inflation — the claim stays unconsumed). Plus four **Low**
retryable-omissions (harvest / farm-refund / LP-unbond / protocol-fee-claim appends skipped on a bad witness —
atomic, so not lock-blocking). **Fixed:** the cross-out fold adopts the round-14 burn-deposit
duplicate-vs-fresh discipline (replay → repurposed-membership no-op; fresh bad witness → abort), worker mirror
included; the four entitlement note-appends abort on a bad witness (round-13 boundary, no over-abort exposure).
cxfer-core 154/154 (crossout test now asserts replay no-op + fresh-bad-witness abort); DIGEST_MATCH gate green
(crossout fixture byte-identical); forge unaffected. Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-15.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-15.md).**

## Rounds

| Round | Scope | Model(s) | Report + response |
|---|---|---|---|
| 1 | Confidential pool + EVM core | GPT-5.5 Pro · Opus 4.8 | `…CONFIDENTIAL_POOL_AUDIT_*` (+ `-RESPONSE`) |
| 2 | Bitcoin↔Ethereum cross-chain trust path | GPT-5.5 Pro · Opus 4.8 | `…CROSSCHAIN_*` (+ `-RESPONSE`) |
| 3 | Full immutable surface (new ops) | GPT-5.5 Pro | `…FULL_AUDIT_GPT55PRO-…-RESPONSE` |
| Final | Holistic production-readiness @ `034308e` | GPT-5.5 Pro + Opus 4.8 (conclusive) | this page + `…FINAL_AUDIT_{GPT55PRO,OPUS48}-RESPONSE` |
| Hardening | Newest farm / cross-chain work (multi-agent) | Opus 4.8 Ultracode | `AUDIT-2026-06-27-ultracode-opus48-farm-hardening` |
| Greenlight 1 | Frozen immutable surface, pre-reprove @ `af73a2e` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE` |
| Greenlight 2 | EVM farm + cross-lane, pre-reprove @ `e90a1ba` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2` |
| Greenlight 3 | CDP uniqueness + lp-bond, pre-reprove @ `3b2ecfc` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-3` |
| Greenlight 4 | Reflection atomicity + cross-out, pre-reprove @ `90fbd7e` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2`* |
| Greenlight 5 | Reflection / farm composition, pre-reprove @ `7b5dc2c` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-5` |
| Greenlight 6 | Protocol-fee claim auth + farm-init atomicity, pre-reprove @ `bee4c88` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-6` |
| Greenlight 7 | CDP-liquidation payout binding + protocol-fee recipient, pre-reprove @ `37b94da` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-7` |
| Greenlight 8 | Relayer/relay-fee threat model + Bitcoin reflection liveness, pre-reprove @ `8c066af` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-8` |
| Greenlight 9 | Holistic readiness (no fund-critical); farm mode-gate + envelope canonicality @ `8170004` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-9` |
| Greenlight 10 | Confirmatory; reopened the 64-byte reflection merge (Critical, fixed) @ `1f7c7d3` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-10` |
| Greenlight 11 | **LOCK** — re-confirmation, 0 fund-critical, round-10 fix stress-tested @ `bd83e5e` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-11` |
| Greenlight 12 | LP-add pool-disambiguation (Medium fund-loss, fixed) + parser exactness @ `82ea3bf` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-12` |
| Greenlight 13 | Reflection witness-append atomicity (High strand/loss, fixed) @ `10c02ae` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-13` |
| Greenlight 14 | LP-add abort regression (Critical) + burn-deposit omit (High) + farm-init change (Med), fixed @ `74ec0e1` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-14` |
| Greenlight 15 | Cross-out silent-omit (Medium strand/censor, fixed) + 4 entitlement-append retryable-omissions (Low, fixed) @ `3421640` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-15` |

\* Round-4 dispositions are recorded inline in the Greenlight pass round 4 section above (no separate `-4` file).

## Findings → what we did

Every finding across all rounds is **fixed, dispositioned as not-a-bug, or documented as a deploy-time
gate.** A summary (full reasoning + line citations in the per-round responses):

| Area | Finding | Resolution |
|---|---|---|
| Bitcoin data | Coinbase-witness envelope binding (the highest-severity item) | Fixed — coinbase is never an envelope source; commitment shape enforced |
| Bitcoin data | Duplicate-tail merkle alias; 64-byte stripped-txid guard | Fixed — checked merkle root; stripped-length guard |
| Wrap/send ops | Wrap-CDP-mint authorization could be reused across intents | Fixed — op-specific, intent-complete sigma context |
| Wrap/send ops | Transfer output owner not bound (delegated proving) | Fixed — output leaves bound into the conservation kernel |
| Wrap/send ops | Send-unwrap arithmetic hardening | Fixed — checked arithmetic |
| Batch path | In-guest Groth16 verifier validation | Validated — accepts real proofs, rejects forgeries (committed vector + test) |
| Collateral | Oracle/TWAP decimals; cBTC margin authority; farm funding | Fixed — bounds + authoritative pool reads + funding preflight |
| Router | Permit2 pull binding; relayed-settle fee handling | Fixed — bound to the exact transfer; fee-free relay enforced |
| Reflection | Source-domain anchoring; enable-ordering; storage-slot pinning | Deploy-gated (mainnet re-anchor) + CI layout assertion in place |
| Reflection (final) | Reported storage-slot drift | Not a bug — verified against the compiled layout; CI assertion confirms |
| CDP / farms (greenlight 1) | `rate_snapshot` (CDP mint) + `rps_entry` (bond) unbound in the opening-sigma context | Fixed — bound into the guest contexts so a delegated prover can't substitute them |
| Farms / cross-lane (greenlight 2) | EVM farm harvest/unbond missing the Bitcoin spent-set freshness gate + receipt-owner authorization | Fixed — cross-lane nonmembership check + BIP-340 owner sig on both spends (parity with the Bitcoin lane) |
| LP / swap (greenlight 2) | `LP_ADD` pool identity unbound (first-add fee-tier redirect); protocol-fee recipient not on-curve-validated | Fixed — bind `(lp_asset, pid)` into the lp-add context; reject an off-curve protocol-fee recipient |
| CDP / lp-bond (greenlight 3) | Duplicate CDP position leaves lock one position; `LP_BOND` pool identity unbound | Fixed — duplicate-leaf guard at insertion (contract-only); bind `(lp_asset, pid)` into the lp-bond context |
| Reflection folds (greenlight 4) | Fold atomicity (mutate-then-fail under ignored error); `T_CROSSOUT_MINT` replay | Fixed — folds made all-or-nothing; consumed-cross-out IMT replay gate committed in the digest/resume |
| Reflection / farm (greenlight 5) | Zero-share bond/harvest panics the reflection (DoS); farm refund mid-farm; accrual window unenforced | Fixed — skip-not-panic guards; refund gated on no live stakers; campaign window threaded through the farm state + clamp |

Confirmed sound by independent review (not exhaustive): the per-op conservation kernel and fee bounds, the
burn→mint provenance integrity, the cross-lane consumed-nullifier completeness with the on-chain freshness
gate, the cross-curve binding (with verified nothing-up-my-sleeve generators), the reserve floor, and the
encode↔decode trust boundary between the guest and the contracts.

## How verification works here

- **Reproducible:** each report pins the reviewed commit; findings cite `file:line`.
- **Mechanically gated:** a production-readiness gate (POOL / BRIDGE / DAY1 tiers) runs the full Solidity +
  guest + cross-impl suites, on-chain real-proof verification, a guest↔JS parity check, and a compiled
  storage-layout assertion — and is green across all tiers.
- **Trusted dependencies are scoped:** the SP1 Groth16 verifier and the Zellic-audited beacon light-client are
  treated as sound; the audits target the in-house logic around them.
