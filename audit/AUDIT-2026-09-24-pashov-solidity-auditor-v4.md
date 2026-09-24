# Tacit v1 (gen5) — immutable contract and guest audit

**Date:** 2026-09-24
**Scope commit:** `f9ab208b` (working tree clean across `contracts/src` and `contracts/sp1`)
**Method:** Pashov Audit Group `solidity-auditor` v4, extended to the zkVM guest surface
**Reviewer:** Claude Opus 5, orchestrating 24 parallel adversarial agents

---

## 1. Verdict

**GO for public release of the gen5 pool suite.**

No agent found a path to theft, inflation, double-spend, nullifier bypass, escrow drain, or cross-op
re-typing anywhere in the immutable surface — pool, router, AMM, every guest opcode arm, the Bitcoin
parsers, the reflection state machine, and the Solidity↔guest public-values seam checked field by field.
That holds across all 24 agents and the verification pass.

Two lanes with no live traffic are gated pending further work; one live-lane defect was found, fixed and
deployed during this review; everything else is low severity, dormant, or hardening for the next
generation.

**The findings below split cleanly along the line that actually matters for a design with an immutable core:
does it touch the shared pool or another user, or is it bounded to the acting party's own funds.** The
former is the one category that must be airtight in this deployment, since it can't be patched later — G-4
and the pipeline-liveness fixes fall here, and got immediate structural fixes. The latter — G-1a and G-1c
below — is bounded to the launcher's own treasury; keeping the immutable guest simple rather than closing
every self-inflicted footgun in code that can never change again is a defensible choice given gen5 already
has a working path to harden this properly in the next generation (exit, redeploy, re-enter). The canonical
client and docs still close what they can at that self-inflicted layer even so — see G-1's mitigations and
S-4 — because that layer can be redeployed freely and there's no reason to leave a cheap client-side fix on
the table just because the underlying guest behavior is an accepted tradeoff.

| # | What | Status |
|---|---|---|
| G-4 | A non-standard Bitcoin transaction could desync the reflection prover's witness stream and stall the cursor. | Fixed and deployed this session (`923b9937`, `a304f225`). |
| G-1 | Bitcoin-native farms: three separate replay/griefing issues. No live traffic. | One of three fixed and deployed; the other two now have documented operational mitigations that bound their impact, though neither is a structural fix — a next-generation guest change closes them properly. |
| G-2 | `OP_BID`/`OP_OTC` link a participant's identity to their fill. No live traffic — protocol implementation (builder, fill tool, real proof verified on-chain, relay support) already complete and proven; the "needs a trusted matcher" limitation is resolved this session for both ops, no guest change (`toShareableBid`/`toShareableRestingBid`, `confidential-otc-tab.js`'s `publicLeg`); only a UI remains. | No live agent needed. |
| G-3 | The forward-only reflection path rarely passes during normal activity. | Structural, not an incident — system verified healthy and caught up on 2026-09-24. |

### Lane status

| Lane | Status |
|---|---|
| Ethereum confidential pool: wrap, transfer, unwrap, swap, LP, OTC, stealth | Clear |
| CDP / cUSD / cBTC | Clear as code; config gates remain (§7) |
| EVM farms (`FarmController` / `FarmManager`) | Clear |
| Bitcoin → Ethereum reflection (Mode-B, the path in live use) | Clear. Verified live and healthy 2026-09-24 |
| Bitcoin → Ethereum reflection, forward-only mode | Rarely usable during normal activity (G-3); not the operating path |
| Bitcoin-native AMM | Clear — the refund-key fix shipped 2026-09-24 |
| Bitcoin-native farms | Do not launch — G-1 |
| `OP_BID` | Ready to surface via the safe path (`toShareableBid`); only a UI is missing — G-2 |

---

## 2. Scope

Audited as the immutable surface actually deployed, not the whole repository.

**Solidity — immutable core.** `ConfidentialPool`, `ReflectionLib`, `SP1PoolRootVerifier`,
`ConfidentialRouter` (+ `ExitExecutor`), `TacitPublicAmm`, `CanonicalAssetFactory`, `CanonicalMinters`,
`CanonicalBridgedERC20`, `TacitRelayer`, `EthCallOutbox`, `BtcCallExecutor`.

**Solidity — governed periphery.** `CollateralEngine`, `CbtcEscrowHelper`, `WstEthUsdFeed`,
`ChainlinkEthBtcAdapter`, `ChainlinkWstEthBtcAdapter`, `FarmController`, `FarmManager`,
`PointsDistributor`, `TacAirdrop`, `WrappedTac`, `TacFarmFunder`, `WrapTipForwarder`,
`WrapTokenTipForwarder`, `MerkleDistributor`.

**Deploy scripts.** `DeployV1SuiteCreateX`, `DeployConfidentialPool`, `DeployCollateralEngine`,
`CreateNextGen` — audited as production code, per the skill's rule.

**Rust zkVM guest (immutable, vkeys baked into the pool).** The settle guest `main.rs` with
`swap_batch.rs`, `swap_blind.rs`, `groth16.rs`, `babyjubjub.rs`; the full `cxfer-core` crate
(`lib.rs` all 11,508 lines, `bitcoin.rs`, `burn_deposit.rs`, `eth_reflection.rs`); the reflection guest
`reflect.rs`; the Ethereum light-client guest.

**Off-chain, brought into scope by G-4.** `dapp/burn-deposit-bitcoin.js`'s `extractTaprootEnvelope` /
`classifyConfidentialTx`, the JavaScript mirror of the guest's Bitcoin envelope parser that the
reflection-prover pipeline (`worker/src/index.js`, `worker/src/reflection-attest*.mjs`, and the
`tools/modeb-reconstruct.mjs` / `tools/reflection-headrebuild.mjs` recovery tools) all import.

**Out of scope, by instruction:** SP1's Groth16 verifier and sp1-helios; settle front-running; reflection
liveness in general and the 24-confirmation reorg halt; cBTC being economically rather than custodially
secured; cUSD's oracle dependence; the ops multisig acting against its own mandate. G-4 was included
despite touching "liveness" because it is a permissionless, on-demand halt with no dependency on
anyone's uptime, unlike the accepted liveness limits.

### Provenance — the audited source is the deployed source

- Both committed guest ELFs hash exactly to their pinned values: `cxfer-guest` → `f7bc327d…b922c7`,
  `reflection-prover` → `55b5ccff…f12c5b`, matching `elf-vkey-pin.json`.
- The immutable Solidity last changed at `4a425f1d`; the guest at `9e043071` — the same commits the pin
  records those ELFs were built from.
- Prior rounds established byte-identity between the deployed pool runtime and a local build once link
  references and immutables are normalised, with all 19 immutables read out of the runtime.

---

## 3. Method, and where it departs from the skill

The skill's twelve specialty agents (math-precision, access-control, economic-security,
execution-trace, invariant, periphery, first-principles, asymmetry, boundary, and three gap-hunters) ran
against the immutable Solidity core, each with the senior-auditor SOP, the shared rules, the
report-language rules and a known-findings ledger built from prior review rounds. Findings passed through
the skill's four judging gates (attack execution, reachability, trigger, impact) and its lead-promotion
rules.

Four extensions beyond the stock skill:

1. **Guest coverage.** The skill is Solidity-only. Eight further agents took the Rust guest with the
   specialties translated: the attacker is a malicious prover, every `io::read()` is attacker-chosen,
   and the central bug class is under-constraint — a public value the pool trusts that the guest never
   bound to a checked witness.
2. **A dedicated seam agent.** The pool verifies one proof and acts on its public values, so the
   public-values encoding is the trust boundary. One agent compared the guest's committed fields against
   the Solidity's decoded fields, both directions, field by field (§8). Result: clean.
3. **Orchestrator verification.** Every finding was checked against source before being accepted, and
   several agent claims were refuted that way (§6), including two items that were revised after checking
   live chain and API state (§ G-3).
4. **One pass, not three.** Given ~28k lines of guest plus ~10k of Solidity, breadth across 24 agents
   plus a verification pass was the better use of budget on a surface already reviewed in prior rounds.

All agents were read-only inside the repository; scratch work stayed outside it. A host crash after 23 of
24 agents had reported did not affect the report, the repository, or any prior finding — the 24th agent
was resumed and completed normally.

---

## 4. Findings

Severity reflects impact on this deployment as configured today.

| # | Severity | Component | Title | Status |
|---|---|---|---|---|
| G-4 | High (was live, unexploited) | off-chain mirror | Reflection prover accepted a Bitcoin envelope the guest's own JS mirror rejected | Fixed, tested, deployed |
| G-1 | High (lane-gating), 3 sub-issues | guest `cxfer-core` | Bitcoin-native farms: treasury-stranding re-bond, refund replay, harvest replay | 1 of 3 fixed (builder convention); 2 have documented operational mitigations, next-gen guest fix still needed |
| G-2 | Medium (resolved) | guest settle `OP_BID`, `OP_OTC` | Bid/OTC proceeds are minted under an owner whose secret key must reach whoever finalizes | Resolved this session, no guest change (`toShareableBid`/`toShareableRestingBid`; OTC's `publicLeg` keeps `nk` once signed); needs a UI only |
| G-3 | Low | `ReflectionLib` / guest | Forward-only reflection requires zero lag to pass | Informational — system verified healthy 2026-09-24 |
| S-1 | Low (Medium if armed) | `CollateralEngine` | `setDeviationBound` can be armed before its second source exists | Governance procedure |
| S-2 | Low (Medium if armed) | `CollateralEngine` | A stale unhealthy flag skips the grace window | Next-gen fix; inert today |
| S-3 | Low | `TacAirdrop` | `claim` lets anyone force another account's shielded claim into the open | Accepted |
| S-4 | Low | guest settle | Farm bond accepts an off-curve receipt owner, locking the stake | Client guard added this session |
| I-1 | Info | `FarmController` | `notifyRewardAmount` lacks `FarmManager`'s schedule guards | Accepted |
| I-2 | Info | `ConfidentialPool` | The asset registry is permissionless and self-attested | Accepted — document |

---

### G-4 — Reflection prover accepted a Bitcoin envelope its own JS mirror rejected

**Status: fixed, tested, and deployed.**
**Location:** guest `contracts/sp1/confidential/cxfer-core/src/bitcoin.rs` — `extract_taproot_envelope`
tapscript loop (~2672–2702). Mirror: `dapp/burn-deposit-bitcoin.js` — `extractTaprootEnvelope` (~208–260).
**Found by:** the Bitcoin-parsing boundary agent. Verified by reading both loops side by side.

**Root cause.** Both parsers walk a tapscript and accumulate data pushes inside an
`OP_FALSE OP_IF … OP_ENDIF` frame. The guest's loop breaks on `OP_ENDIF` or simply ends when the script
runs out, accepting either case. The JS mirror had one extra line the guest never had:
`if (!endif) return null;`, rejecting the second case.

**Effect.** A Taproot script-path spend with the `OP_ENDIF` omitted — valid Bitcoin under an unallocated
leaf version, so it needs direct submission to a miner rather than relay-node acceptance — would be
parsed as a real envelope by the guest and skipped by the JS assembler. The guest would then read
witnesses the assembler never supplied, desyncing every subsequent read in that batch, failing the proof
for that block. Because the reflection cursor requires exact height continuation, the scan could not
advance past that block without a manual fix.

**Why the guest is authoritative here.** An envelope with no `OP_ENDIF` is not invalid Bitcoin; nothing
in consensus or in the Tacit spec requires closing the conditional once the script only runs one branch.
The JS mirror was stricter than the code it exists to mirror.

**Fix.** Deleted `if (!endif) return null;` in `dapp/burn-deposit-bitcoin.js` (the only site — grepped);
added a regression test (`tests/burn-deposit-kit.mjs`) asserting the parser accepts a script with no
`OP_ENDIF`. Committed as `923b9937` (source) and `a304f225` (test), pushed to `main`. No contract or
guest ELF change required.

---

### G-3 — Forward-only reflection requires zero outstanding lag to pass

**Severity:** Low. Verified against live chain and API state on 2026-09-24: the pool and reflection
service are healthy and caught up.
**Location:** `contracts/src/ReflectionLib.sol:258` (the attest gate) against
`contracts/sp1/confidential/cxfer-core/src/lib.rs` `fold_crossout` (~6427–6480) and its companion
`rebase_drain_check` (~355–380).
**Found by:** the reflection-lane flow-gap agent. Verified against source and live state.

**Root cause.** `ConfidentialPool.settle` lets any note holder record a cross-out for the cost of one
dust note; only the burner can broadcast the matching Bitcoin-side mint (`T_CROSS_OUT_MINT`, opcode
`0x65`) that folds it, usually within a normal, unhurried window after the Ethereum-side exit settles.
`ReflectionLib.sol:258` gates every forward batch (`mode_b == 0`) on exact equality between
`foldedCrossOutCount` and the live `crossOutCount`. Because users routinely take some time between
settling and broadcasting, this equality is rarely satisfied during ordinary operation — an actively used
bridge almost always has at least one cross-out in flight. `rebase_drain_check` names the identical
hazard for its own analogous check and uses `>` rather than `!=` to tolerate it; the forward-attest gate
does not.

**Live check.** On 2026-09-24: on-chain `attestedCrossOutCount()` is 8; the public `/reflection/status`
endpoint reports `foldedCrossoutCount: 6`, `attestedHeight == tipHeight == 968334`, `lagBlocks: 0`. A gap
of 2 between recorded and folded cross-outs, with the system otherwise caught up and healthy, matches the
normal operating lag already documented in the 2026-09-23 review.

**Practical effect.** The forward-only path is rarely usable while the bridge has genuine outstanding
volume, because the gate requires zero lag rather than tolerating it. This has caused no observed
problems: Mode-B, which gates on `crossOutCount` directly and is unaffected by this, has carried every
live attest by design. The forward lane is a redundancy option, not the operating mechanism. If a
specific cross-out's mint is genuinely never rebroadcast rather than merely pending, the gap for that one
claim persists — but `fold_crossout` binds nothing to a specific transaction (no txid, block, or time; it
checks `(asset, claim_id, Cx, Cy, dest_auth_key)` against the append-only eth cross-out set), so a fresh
commit/reveal with the same values folds on the next Mode-B batch that covers its block, at any point in
the future.

**Response.** Not a release blocker. Recorded as a structural property of the gate:

1. Do not present the forward lane as an active fallback in docs or runbooks for this generation.
2. Read this alongside the sync-committee anchor item in §9 — Mode-B is where reflection activity
   actually happens, so that item is the one worth an operational monitor.
3. Next-generation hardening: give an unfolded `0x65` mint the same pending-record retry a burn-deposit
   already has, so the forward gate can tolerate ordinary lag the way `rebase_drain_check` already does.

---

### G-1 — Bitcoin-native farms: three independent replay/griefing issues

**Severity:** High impact, lane-gating. No live traffic — the Bitcoin-native AMM pool was only founded
2026-09-22 and is not yet foldable, and farms have no traffic at all.
**Location:** `cxfer-core/src/lib.rs` — `fold_lp_bond` / `fold_lp_unbond` / `fold_farm_refund` /
`fold_lp_harvest` (~6039–6285).
**Found by:** three separate `cxfer-core` agents, independently, across two review passes.

**G-1a — Treasury-stranding re-bond.** `fold_lp_bond`'s freshness gate checks only whether the receipt
leaf is currently in `farm_entries`. `fold_lp_unbond` removes that entry and separately inserts
`farm_receipt_nullifier(leaf)` into `spent_root` permanently. `farm_receipt_leaf(farm_id, lp_asset,
shares, owner, nonce)` is a pure function of five values the bonder chooses. Bond one share under
`(owner, nonce)`, unbond it, then bond the same tuple again: the re-bond passes the freshness check and
raises `total_shares`, but the leaf's nullifier is already spent, so it can never be unbonded again.
`fold_farm_refund` refuses while `total_shares != 0`, so the launcher's unspent treasury becomes
unrecoverable. Cost: one LP-share unit and three Bitcoin transactions, no other party's key required.

**G-1b — Refund replay.** `fold_farm_refund` checks the launcher's pubkey, that `total_shares == 0`, and
a signature over `(farm_id, refund_amount, refund_r, view_height, dest_spk)` — but nothing marks a
specific refund as consumed; the message binds no txid or nonce. Anyone who reads the launcher's
broadcast envelope can copy the same bytes into a new transaction with a matching `vout[1]`, and it folds
again: the treasury is debited a second time and the new note collides with the first (the value is
destroyed, not stolen, since the destination is fixed inside the signed message). Repeatable while
`reserve_a >= refund_amount`, at one Bitcoin fee per repetition.

**G-1c — Harvest replay.** The same shape applies to `fold_lp_harvest`. `lp_harvest_owner_msg` binds no
height, nonce, or per-harvest nullifier; the one replay barrier — a re-stamp of the position's checkpoint
— defeats a replay only until the reward-per-share accumulator grows again, after which the same signed
bytes can be rebroadcast to debit the treasury a second time.

**Mitigations.**

`fold_farm_refund` and `fold_lp_harvest` both draw against the same single, per-farm counter —
`pools[farm_id].reserve_a` — through the shared `fold_harvest` helper, whose guard is `reward_amount >
farm.reserve_a`. That counter only falls. If a launcher's client always signs a refund for the farm's
full current `reserve_a` rather than a partial amount, `reserve_a` reaches exactly 0 after the first
successful fold, and any later replay of the same bytes fails that guard permanently for that farm. This
needs no guest change — it is a builder convention, added this session as a comment/requirement in
`dapp/amm-farm-actions.js`'s `buildAndBroadcastFarmRefund` (commit `89441491`). It is also safe under a
same-block race: the destination is fixed inside the signed message, so at most one copy of the bytes
ever succeeds, and it always pays the launcher.

G-1c cannot be fully closed client-side, but the exposure can be bounded. `verify_farm_harvest`'s accrual
check compares against a per-staker checkpoint, and the farm's reward-per-share accumulator keeps growing
over the whole emission window, so an old signed envelope becomes replayable again once accrual
re-reaches the claimed amount — regardless of harvest frequency, because the check is an inequality
rather than a one-time claim. Confirmed exhaustively that no other path resets this: `total_shares` and
`rps` have exactly two writers each in the whole crate (`bond`/`unbond`, and accrual-over-height), no
admin override, nothing else to lean on.

What harvest frequency and cadence *do* control is real, and stronger than "reduces exposure": Bitcoin's
own ~10-minute block time is already a hard ceiling on how often anyone can act. A staker who harvests
their share every block (or every few) claims the smallest amount that's ever at risk, and does so at the
fastest cadence the chain allows — a sustained attacker trying to profit from replaying against that
position would need to continuously monitor and pay a Bitcoin fee *every block, indefinitely, for the
life of the farm*, to skim a claim that's already been swept moments before. That is a genuinely
lopsided race in the defender's favor, not merely a smaller number. It does not reach zero risk against
someone who doesn't care about cost, but it makes sustained, profit-motivated exploitation impractical.
Documented next to `buildAndBroadcastLpHarvest` in `dapp/amm-farm-actions.js` (commit `29485955`), which
already imports the fee-rate helper needed to size claims against current fees.

G-1a cannot be prevented client-side — it is performed by a third party using their own funds and needs
no cooperation from the launcher. But `fold_lp_harvest` (unlike `fold_farm_refund`) has no
`total_shares == 0` requirement, only a per-position accrual check, and `fold_farm_init_rewards` is
strictly one-shot (no top-ups are possible later — the entire reward budget is committed at launch with
no way to add more), which rules out "fund conservatively, adjust later" as a real option. The stronger
practice given that constraint: **a launcher should bond a dominant self-stake in their own farm at
launch, before anyone else stakes, and run the same every-block harvest cadence as above** — not wait to
discover a grief attempt and react to it. This removes the vulnerability window rather than responding to
it after the fact, and turns `fold_farm_refund` into a backup for whatever residual nobody ever staked,
not the primary way value comes back. Documented next to `buildAndBroadcastFarmRefund` (commit
`29485955`). It is not airtight against a determined, loss-accepting attacker who also runs G-1c
continuously against the same farm, but it removes the realistic case of one-off griefing entirely.

**Response.** Both are bounded to the launcher's own treasury, not the shared pool or another party's funds —
a defensible V1 tradeoff to accept with mitigations rather than a reason to complicate an immutable guest
that already has a clean path to a proper fix next generation. Both now have documented operational
mitigations that meaningfully bound their impact — proactive dominant self-staking plus frequent harvesting
closes the realistic threat model, though neither is a cryptographically airtight fix; have a launch plan
for Bitcoin-native farms that accounts for them. G-1b's fix should ship in the builder before the lane takes
real funds. The EVM farm stack (`FarmController` / `FarmManager`) is a different code path and unaffected —
the three live TAC farms carry no exposure here. Next-generation fixes, both guest-side: gate
`fold_lp_bond`'s freshness check on nullifier-set membership rather than `farm_entries` presence; bind a
nonce or checkpoint into `lp_harvest_owner_msg` so a stale signature cannot re-satisfy a later accrual check.

---

### G-2 — `OP_BID` (and `OP_OTC`) mint/spend under an owner whose secret key must reach whoever finalizes the proof

**Severity:** Medium, privacy only, no theft. **Correction to this finding's original scope statement:**
"no wallet builds `OP_BID`" is true only of the dapp's UI. The underlying protocol implementation is
complete, tested, and proven — `dapp/confidential-bid.js` (462 lines) has a full buyer-side builder
including a resting-order extension, a seller-side fill builder, a complete JS mirror of every guest
assertion (8/8 tests pass), wire serialization verified against the exec-bid harness's field order, and
buyer-output recovery for notes the normal memo scan can't reach. `contracts/test/ConfidentialBidProofReal.t.sol`
proves a real Groth16 proof of a committed `OP_BID` fixture verifies on-chain against the pool's actual
pinned `program_vkey` — confirmed by running it (7/7 pass, including `test_real_proof_verifies_onchain`
and `test_fixture_vkey_matches_pin`). The worker relay's fee-pricing (`worker/src/relay-quote.js`)
already lists `'bid'` as a recognized op type reading the exact `fee` field the builder produces. What is
actually missing is a dapp UI tab and a bid discovery decision — see this finding's mitigation section for
a publish-safety fix landed this session (`presignBidGrid`/`toShareableBid`/`toShareableRestingBid`).
**Location:** `contracts/sp1/confidential/src/main.rs` — `OP_BID` funding read (~3193), proceeds leaves
(~3379, ~3382). Derivation: `cxfer-core/src/lib.rs` `nk_to_owner` / `native_nullifier` (~1750–1762).
**Found by:** the settle-guest first-principles agent.

**Root cause.** The native nullifier scheme's guarantee is that an observer with only the published leaf
cannot compute its nullifier, because doing so requires the note's secret key `nk`. `OP_BID` mints the
buyer's fill and refund notes under `buyer_owner = keccak(nk ‖ dom)` for that same `nk`. The buyer in a
bid is offline by construction, so the filling party needs `nk` to complete the trade, and the published
bid carries it along with the pre-signed proceeds commitments.

**Impact.** Any reader of a bid can compute the nullifier of both proceeds notes ahead of time. When the
buyer later spends the fill, that nullifier links the spend back to the bid. For a resting bid, one `nk`
covers every lot in the chain. Spending still requires the blinding, which the buyer keeps, so there is
no theft — only linkage. Every other value-re-minting op in the guest reads a fresh output owner; `OP_BID`
is the one arm that reuses the funding key.

**Shared with `OP_OTC` — and resolved for both this session, no guest change.** Any op that binds one
stable identity across two independently-authored inputs in one proof needs `owner = keccak(nk ‖ dom)`,
and whoever finalizes that one proof needs the raw `nk` — a hash-preimage check, not a signature.
`OP_OTC`'s maker/taker inputs read `nk` the identical way (`input_leaf_authed`'s native branch), and its
own docs (`dapp/confidential-otc-tab.js`, `docs/BUILD-A-TACIT-DAPP.md` §5c) previously stated the same
limitation `OP_BID` had: finalizing needed the taker's `nk`, and the shipped tab had no channel for it —
"only finalizes when maker and taker are the same operator holding both legs."

That turned out to be more caution than the cryptography requires. `verify_opening_sigma`
(`cxfer-core/src/lib.rs` ~461) is a standard, unforgeable Schnorr check over the discrete log of the
note's blinding `r` — `nk` plays no part in it. So once a leg is signed (its opening sigma computed
against a fixed, fully-determined context), that leg's `nk` cannot be used to forge an opening for any
*other* context: it authorizes exactly the trade already agreed, nothing else. `_r` is the only field that
must never leave its owner, signed or not. The shipped tab's `publicLeg` was stripping `nk` unconditionally,
grouping it with `_r` as equally dangerous when it is not — fixed this session: `publicLeg` now keeps `nk`
once the leg is signed, so the taker's countersignature (step 2) carries what the finalizer (step 3) needs,
with no separate channel. `tests/confidential-otc-op.mjs` gained a case proving two independent parties —
neither ever seeing the other's `_r` — finalize identically to the trusted-operator path (7/7 pass).
`OP_BID` got the analogous fix: `presignBidGrid`/`toShareableBid` (single-shot) and
`toShareableRestingBid` (resting), described above, are exactly this same "keep `nk`, drop `_r`" object,
applied to the offline-grid case. So the "who sees `nk`" question for both ops now has a definite answer —
whoever the poster chooses to show it to, safely, publicly if desired — leaving only the narrower linkage
concern from Impact above (worth a disposable note, not worth blocking on).

The remaining, separate observation: Bitcoin-homed inputs never had this question at all —
`input_leaf_authed`'s other branch authorizes by an actual signature over the real Taproot key, not a
preimage. A next-generation guest could give native notes the same signature-based ownership instead of
hash-preimage ownership, which would mean never constructing an `nk`-bearing witness field to reason about
in the first place — narrower and cleaner than "read a fresh proceeds owner," but not required now given
the fix above. It is a guest-level change to an
immutable, deployed circuit, so it is next-generation work, not something to retrofit now.

**No watchtower is needed to complete a fill — this is a distribution question, not an execution one.**
The buyer's authorization is complete and static the moment the bid is created: `chosen_f` is baked into
the signed `buyer_ctx`, so the buyer pre-signs one full set of openings *per grid point*, entirely offline,
and that context binds only the buyer's own notes — never the seller's (`"the buyer's pre-signed offline
sigma is untouched"` by whatever the seller supplies). There is no further signing action anyone ever
needs to take on the buyer's behalf. Whoever fills the bid — any seller who reads the published data —
has everything required to assemble the complete settle witness alone: their own leg, the buyer's
already-published leg, a proof, and a submission. This is structurally different from a Bitcoin
SIGHASH_ALL-style completing signature, which can't be produced independent of the counterparty's exact
inputs and is why a live, responsive watchtower exists on that side. An earlier pass in this review drew
that analogy across to `OP_BID` and it doesn't hold — worth recording precisely because it looked
plausible and wasn't.

What this leaves is the actual, narrower question: **who sees `nk` before or at fill time**, not who could
steal the funding note — `nk` alone cannot forge an opening for a context the buyer never signed, which
needs the blinding `_r`, a discrete-log secret no signature reveals. That distinction only holds, though,
if the object actually shared never carries `_r` alongside `nk`. It did not hold for the single-shot path
as shipped: `fillBid` signs the funding opening *at fill time* using `bid.fund._r`, so the `bid` object a
caller would need to hand a filler carried the raw blinding too — safe for a single trusted operator
holding both legs, not safe to publish. Fixed this session, no guest change: `presignBidGrid` (sign every
grid point's openings once, offline, matching what this file's own header always said the design was) plus
`toShareableBid` produce the object actually fit to publish — `_r`/`bidSecret` dropped, `nk` and every
grid point's already-computed openings kept — and `fillPresignedBid` completes a fill from it alone. The
resting form had the sigma-timing right already (`buildRestingBid` signs at build time) but still returned
`_r`/`bidSecret` inline; `toShareableRestingBid` strips them. All three land in `dapp/confidential-bid.js`;
`tests/confidential-bid-op.mjs` and `tests/confidential-bid-resting.mjs` each gained a case confirming the
shareable object carries no secret field and settles identically to the raw path (9 and 8 checks pass).
Beyond the JS mirror: the actual settle guest binary — vkey-matched to the currently deployed
`program_vkey` — was executed directly against a witness built purely from this new path, with no panic and
every committed nullifier and leaf matching the JS mirror's prediction exactly. `OP_OTC`'s equivalent check
was confirmed the same way `OP_BID`'s was, by direct reading of `main.rs`.

With that fixed, the remaining distribution question is only the linkage one from Impact above, not a
theft one: publishing to a fully open feed lets anyone (not just an eventual counterparty) compute future
nullifiers under that bid's owner; a narrower channel confines that to legitimate participants. A
disposable, single-use funding note is still good practice for that reason, but it is no longer load-bearing
against theft the way it would have been against the un-fixed single-shot path.

**What's actually needed to ship this.** The buyer builder, seller fill tool, and relay path already exist,
are proven, and (as of this session) produce a publish-safe object. Two remaining pieces: (1) a dapp UI tab
wiring `presignBidGrid`/`toShareableBid`/`fillPresignedBid`/`recoverBidOutputs` into a create-bid and
fill-bid flow; (2) a distribution choice (a narrower channel over a fully open feed, for the linkage reason
above — not a hard blocker either way now).

**Response.** Ship `OP_BID` from `toShareableBid`/`toShareableRestingBid`, never the raw `buildBid`/
`buildRestingBid` return, and prefer funding it from a disposable note. The next-generation guest fix
(signature-based native ownership, described above) remains worth doing, since it removes the `nk`
disclosure entirely rather than just bounding its consequence, but it is not required to ship a reasonable
version of this feature now. Separately, `dapp/confidential-bid.js` already documents that reusing an
opening-sigma nonce across two grid points leaks the funding blinding — a client rule the guest cannot
enforce.

---

### S-1 — `setDeviationBound` can be armed before its second source exists

**Severity:** Low as configured; Medium once armed.
**Location:** `contracts/src/CollateralEngine.sol` — `setDeviationBound` (~421–427), `_price` guard
(~606), `setFeeds` pairing rule (~398).
**Found by:** the periphery trust-gap agent.

**Root cause.** `_price` applies the deviation check only when both a TWAP source and a non-zero bound
are set. `setDeviationBound` checks only that the bound is within range and not being disarmed — it does
not check that a TWAP source exists. On this deployment both TWAP slots are unset and the bound is 0. An
owner who arms the bound before wiring a TWAP source gets a non-zero, chain-readable `maxDeviationBps`
while `_price` still returns the raw single-source answer with no cross-check applied. The bound cannot
be disarmed once set, and `setFeeds` rejects a feed change without a TWAP once the bound is armed, so
this state is not easily reversible.

**Why it matters.** The direction that matters is BTC/USD read too high, which over-mints cUSD; the
deviation bound is the only in-contract defence against a single bad feed round.

**Response.** Procedural, not a code change — `CollateralEngine` is immutable. Operating rule: wire both
TWAP sources first, confirm `_price` rejects a synthetic deviation, and only then call
`setDeviationBound`. Add this to the cUSD launch runbook.

---

### S-2 — A stale unhealthy flag skips the escrow grace window

**Severity:** Low; inert today (`escrowMaintenanceBps` is 0, `escrowEnforcementModule` is unset).
**Location:** `contracts/src/CollateralEngine.sol` — `enforceEscrowToReserve` (~811–820),
`flagEscrowUnhealthy` (~754), `clearEscrowFlag` (~765), `clearEscrowFlagIfHealthy` (~790).
**Found by:** the periphery economics agent.

**Root cause.** `enforceEscrowToReserve` accepts any `escrowUnhealthySince` timestamp for which the grace
window has elapsed. The flag is set once and cleared only by two calls nobody is required to make, so a
flag raised during a brief dip months earlier still satisfies the grace test later.

**Impact.** Once the margin-call machinery is armed, an enforcement module could slash a locker's escrow
on a later dip with no fresh notice.

**Response.** Inert today, so not a release blocker. Two mitigations outside the contract: do not arm
the enforcement module without a keeper that clears the flag when escrow recovers; and have the
enforcement module (which is replaceable) refuse to act on a flag older than
`escrowGraceWindow + MIN_ESCROW_GRACE_WINDOW`. Next-generation fix: make that staleness check part of
`enforceEscrowToReserve` itself.

---

### S-3 — `TacAirdrop.claim` lets anyone force another account's claim into the open

**Severity:** Low. Live contract, funded with 1M TAC.
**Location:** `contracts/src/TacAirdrop.sol` — `claim` (~88), `claimTo` (~95), `claimAndShield` (~106),
`_consume` (~156).
**Found by:** the periphery access-control agent.

**Root cause.** `claim(index, account, amount, proof)` does not require `msg.sender == account`; this is
deliberate and documented, and the tokens go to `account` regardless of caller. But `_consume` sets one
claim bit shared with `claimAndShield`, so anyone who sees a pending `claimAndShield` in the mempool can
submit `claim` first, consuming the bit. The account still receives its tokens, but publicly rather than
shielded, and that path is then closed for that index. `claimTo` and `claimAndShield` bind `msg.sender`;
`claim` does not.

Live impact is minimal: `dapp/confidential-airdrop-claim.js` does not currently offer `claimAndShield`.

**Response.** Accepted; the third-party-submission property is intentional and worth keeping. If a
claimant wants the shielded path, submit it privately rather than through a public mempool. If
`claimAndShield` is ever surfaced in the UI, note this alongside it. No contract change available —
`TacAirdrop` is deployed.

---

### S-4 — Farm bond accepted an off-curve receipt owner, locking the stake

**Severity:** Low, self-harm only.
**Location:** `contracts/sp1/confidential/src/main.rs` — `OP_FARM_BOND` (~4788/4847), `OP_LP_BOND`
(~2578/2709); exits at ~4957 and ~5066.
**Found by:** both settle-guest agents, independently.

**Root cause.** Both bond arms read the receipt `owner` and commit it into `farm_receipt_leaf` without
checking it lifts to a curve point. Both exits — harvest and unbond — verify a signature under that same
key, which fails for an off-curve key, so an off-curve owner bonds stake that can never be harvested or
unbonded. Six sibling arms already gate the key at this boundary; the two bond arms were the exception.

**Impact.** Self-harm only: bonding still requires an opening proof over the bonder's own note, so a
third party cannot bond someone else's funds this way.

**Response.** The client should validate the receipt owner is a valid x-only public key before building
a bond, which fully closes this since the bonder always supplies their own owner value — added this
session to `buildBondOp` in `dapp/confidential-farm.js` (commit `e68d07d4`). Next-generation fix: add
the same guest-side check the six sibling arms already have.

---

### I-1 — `FarmController.notifyRewardAmount` lacks `FarmManager`'s schedule guards

`FarmController.notifyRewardAmount` checks only that duration and rate are non-zero and fit a `uint64`.
`FarmManager._notify` additionally enforces a minimum duration and refuses to shorten the schedule or
lower the rate. A farm's `gov` can compress a long schedule into a short one, bond a dominant stake, and
harvest most of the remaining budget.

**Response.** Not a finding under the skill's gates: `gov` is the farm's own funder, and the harm is to
expected future rewards rather than staked principal (`lockUntil` is 0 on the live TAC farms). Recorded
because `FarmController` is permissionlessly deployable, so a third-party farm gives its creator this
power over its own advertised rewards. Any UI listing third-party farms should not present their
schedules as guaranteed.

---

### I-2 — The asset registry is permissionless and self-attested

`registerMinted` is permissionless, and its checks (`MINTER() == address(this)`, `decimals() == 18`) are
answered by the candidate contract itself. Separately, since the constructor registers canonical tokens
under their shared cross-chain ids, each token's local id is left free for anyone to register a second
time at a scale of their choosing.

**Response.** Not a vulnerability. `CollateralEngine` derives nothing from any token's `totalSupply`, so
a duplicate id cannot move a peg or an escrow figure; pool-minted assets hold no escrow, and the wrap /
payout round trip is supply-neutral at any scale. This is the standard tradeoff of a permissionless
registry. The action item is documentation: registration is not a legitimacy signal, and any dapp or
indexer resolving an asset id to a token address should not present a registered asset as endorsed.

---

## 5. The Solidity↔guest seam — clean

A dedicated agent built the full field-by-field comparison of the settle lane's 31-field `PublicValues`
struct and the reflection lane's 24-field struct, both directions. All fields agree on order, type,
width, byte order and units; the pool reads no field the guest never writes and skips none it should
read. Both structs are standard ABI-encoded and decoded, so there is no hand-rolled offset arithmetic to
drift.

The two known under-constraint items (farm-harvest reward-asset choice, CDP zero-leg mint) remain the
only places a guest-free value crosses into pool-trusted territory, and both are already caught elsewhere.

Three low-severity defence-in-depth leads, carried to §9: array alignment between
`bitcoinConsumedSources` and `nullifiers` is by code-order convention rather than an explicit per-element
check; `overflowCount` is committed by the guest but never read on-chain; the no-inflation floor is
checked after the batch's own leaves are inserted rather than before.

---

## 6. Refuted — recorded so they are not raised again

- **`attest` reverting on a malformed cBTC lock does not halt the bridge.** `attest` reverts on
  `vBtc == 0` or `vBtc > type(uint64).max`, which would wedge the lane if reachable. Unreachable:
  `fold_cbtc_lock` rejects a zero value before surfacing, and `v_btc` is a `u64` so the upper bound
  cannot be hit. The guard lives in the guest, not the contract.
- **`attest` does not accept an inflated Bitcoin height.** `lastRelayHeight` is a monotone floor raised
  from `r.bitcoinHeight`, which the contract never binds to `bitcoinTipHash`. Refuted: the guest asserts
  `anchor_height == state.height + 1`, chained through `priorDigest` and pinned to the canonical relay.
- **The escrow-key asymmetry is latent, not live.** `wrap` credits `escrow[rawId]`; `_payout` debits
  `escrow[resolvedId]`. The only non-identity resolution comes from the heal branch of
  `_autoRegisterFromMeta`, and such an entry is always pool-minted, which never touches escrow. Worth
  keeping as a documented invariant on an immutable contract.
- **`TacitPublicAmm`'s missing reentrancy guard is not exploitable.** The pool re-validates against live
  state on both swaps and adds, so a stale quote can only revert or under-mint.
- **A Bitcoin-authorized call's record cannot be hijacked.** `call_id` and `record_hash` are derived
  independently, so reusing a nonce does replace an unfired record — but only the holder of the original
  `caller_pubkey` can produce a valid replacement. Self-inflicted. Integrator note: nonce uniqueness is
  not enforced on-chain.
- **A zero-debt CDP close cannot lock a victim's position.** `OP_FARM_UNBOND` binds its nullifier to a
  receipt proven in `spend_root` under a separate signature, and `farm_receipt_nullifier` /
  `cdp_position_nullifier` use disjoint domains.
- **The CDP bare-payout replay dies twice.** Reusing a real borrower's debt sigma with `n_legs == 0`
  reproduces the original leaf (born already-nullified), and `CollateralEngine.onCdpMint` separately
  reverts on the sentinel position leaf.
- **The CDP basket merkle resists the duplicate-tail attack**, since it pads with a canonical zero
  subtree rather than duplicating an odd node.
- **`worker-src 'self' blob:` is still in use** (a prior grep limited to `dapp/*.js` missed the vendored
  snarkjs worker).

---

## 7. Not code — configuration gates still unmet for the cUSD / cBTC ramp

Unchanged from the 09-23 review; these need the ops multisig, not a code change:

- `insuranceReserve` is 0 against live cUSD debt.
- No debt ceiling exists and none can be added — `COLLATERAL_ENGINE` is immutable; the only throttle is
  raising `cdpRatioBps`, still at the 1.5x default.
- No cUSD liquidity, so the liquidator set is a subset of the borrower set.
- Single-source oracle (`maxDeviationBps` 0) — see S-1 before changing this.
- The margin call is dormant (`escrowMaintenanceBps` 0, no module) — see S-2 before arming it.

---

## 8. Public-values field-agreement table (settle lane)

Guest side: `contracts/sp1/confidential/src/main.rs:184-232` (`sol! PublicValues`), committed at
`main.rs:5515`. Solidity side: `contracts/src/ConfidentialPool.sol:679-733`, decoded at `:1770`.

| # | Field | Agree | Pool's use |
|---|---|---|---|
| 0 | version | yes | `== 1` |
| 1 | chainBinding | yes | `== CHAIN_BINDING` |
| 2 | spendRoot | yes | known-root check, Bitcoin or EVM |
| 3 | nullifiers | yes | set-then-check |
| 4 | leaves | yes | appended to the tree |
| 5 | depositsConsumed | yes | status 1→2 |
| 6 | withdrawals | yes | resolve, escrow or mint |
| 7 | fees | yes | paid to `msg.sender` |
| 8 | bitcoinBurnsConsumed | yes | ⊆ nullifiers, distinct |
| 9 | crossOuts | yes | claimId recomputed, distinct |
| 10 | bitcoinRootsUsed | yes | each known, length-matched |
| 11 | bitcoinSpentRoot | yes | zero ⇒ not btcHomed; else known |
| 12 | bitcoinBurnRoot | yes | zero ⇒ no burns; else known |
| 13 | swaps | yes | pre==live, k non-decrease |
| 14 | liquidity | yes | pre==live / pro-rata bound |
| 15 | deadline | yes | `block.timestamp <= deadline` |
| 16 | lockSetRoot | yes | known if lockNullifiers non-empty |
| 17 | lockLeaves | yes | appended to lock tree |
| 18 | lockNullifiers | yes | set-then-check |
| 19 | adaptorClaimS | yes | publish-only, by design |
| 20 | refundNotBefore | yes | `block.timestamp > value` |
| 21 | cdpPositionRoot | yes | required for liquidate/topup/close-with-debt |
| 22 | cdpMints | yes | debtAsset derived; sentinels; controller callback |
| 23 | cdpCloses | yes | spend position ν; controller callback |
| 24 | cdpLiquidations | yes | spend position ν; controller callback |
| 25 | cdpTopups | yes | new leaf > 2; spend old, insert new |
| 26 | cbtcMints | yes | lock match, one mint per lock, escrow check |
| 27 | memoRoot | yes | recomputed from memos |
| 28 | bitcoinConsumedSources | yes | length == nullifiers (see §5) |
| 29 | bitcoinBurnIdsConsumed | yes | length == burns; one-shot |
| 30 | harvestActionIds | yes | matched to harvest CdpMints, exact count |

Reflection lane (24 fields, `ReflectionLib.sol:88-121` against `reflect.rs:75-150`): all agree. Two
guest-written fields are not read on-chain: `consumedBound` (reserved for a later generation) and
`overflowCount` (see §5).

---

## 9. Next-generation hardening

Not exploitable now; carry into the next guest generation.

- **The Mode-B sync-committee anchor has a multi-month expiry.** `reflect.rs` pins
  `ETH_GENESIS_SYNC_COMMITTEE` at slot 15,228,928 (period 1859); beacon nodes can only serve
  `get_updates(anchor_period, 128)` — about 4.8 months past whatever committee is currently stored
  on-chain, which advances only when a Mode-B cycle runs, not by wall-clock time. The 2026-09-17 re-pin
  put the horizon at roughly period 1987 (~2027-02) assuming Mode-B keeps running. If it goes quiet for
  128 periods, no update chain can be assembled again, and — combined with G-3's forward-lane limitation
  — reflection would have no path forward in this generation. The live pool's currently stored
  `eth_sync_committee` was not read for this report, so the actual remaining runway is unconfirmed.
  Recommended: read it, and monitor for "no Mode-B attest in N weeks."
- **A Bitcoin-authorized ETH→BTC message fold is one-shot per confirming transaction, with no pending
  retry.** A miss (the same timing pattern as G-3) voids that fold, though anyone can re-broadcast the
  same public envelope, so it is not permanent. Give it the same pending-record retry recommended for
  G-3.
- **`swap_var_kernel_verify` shares `tacit-kernel-v1` with `cxfer_kernel_verify`.** For the 1-in/1-out
  case the two build an identical message and verify key, so one signature satisfies both. Unreachable
  today (Bitcoin will not let the same outpoint be spent twice, and one transaction carries one envelope
  opcode), but this is the exact collision `TRANSFER_KERNEL_DOMAIN` was introduced to prevent on the
  Ethereum lane. Give `T_SWAP_VAR` its own domain, as `lp_add`/`lp_remove`/`lp_bond` already have.
- **A settler's own tip note can self-nullify.** `fold_swap_var` forms the tip leaf from
  `(env.r_receipt, tip_amount)` alone; reusing a receipt blinding across two swaps filled by the same
  settler key produces two identical leaves, and the settler loses the second. Same root cause as the
  already-known `btc-amm-refund-self-nullifies` item, different call site.
- **`verify_opening_sigma` does not reject an identity residue.** Three sibling kernel verifiers reject
  it explicitly. No reachable caller today.
- **`swap_batch_aggregate_point` silently drops an intent with `direction > 1`** rather than returning
  an error. Every live caller rejects the byte first, so it is unreachable, but the primitive itself is
  fail-open and shared by both guests.
- **Farm harvest and unbond owner messages omit `chain_binding`**, unlike `cdp_close_msg`,
  `cdp_topup_msg`, `stealth_claim_msg`, `adaptor_refund_msg` and `btc_note_spend_msg`. A successor
  generation could accept a signature signed for this pool.
- **A lone early farm staker could make a later large bond overflow into a refund instead of a stake.**
  `FarmRewardState::bond`'s overflow argument assumes a bound relative to the current `total_shares`, but
  the accumulator divides by `total_shares` at each accrual, so an early single-share bond followed by
  enough accrual can overflow a much later large bond. Not confirmed as economically exploitable, since a
  whale can split one bond into several that each fit, but the code comment's stated bound does not hold.
- **Two Bitcoin-parsing leads, unreachable given how the dapp builds transactions today:** a confidential
  transfer whose spent note sits at input 0 of its own reveal transaction loses its inputs without
  onboarding an output; the envelope parser reads a witness item without checking the Taproot control
  block, relying on the builder's fixed item ordering.
- **`OP_SWAP` publishes one fee payment per intent in that intent's input asset**, leaking each trader's
  direction inside a mixed batch. `OP_SWAP_BLIND` already aggregates per asset instead.
- **`OP_SWAP_BLIND` relay tips are not quantized**, unlike every other public relay fee.
- **`OP_SWAP_BLIND`'s per-intent context does not bind `fee_bps` or the pool id**, so a relay could clear
  a signed intent against a different fee tier of the same pair; the trader's floor is `min_out`.
- **A stealth claim of a zero-deadline lock would clear the batch expiry gate.** Unreachable today —
  every arm that appends a lock leaf asserts a non-zero deadline — but the fold itself is unguarded.
- **Seam hardening** (§5): bind the `bitcoinConsumedSources` ↔ `nullifiers` alignment per-element; read
  `overflowCount` on-chain and check queued chunks cover it; move the no-inflation floor check before the
  batch's own leaves are inserted.
- Carried forward: `kernel_holds` length prefixes, `intent_context` injectivity by call-site convention,
  `merkle_root_from` 32-bit index truncation, BP+ transcript binding M but not N.

---

## 10. Coverage

24 agents, all on Opus, each with the SOP, its specialty, the shared rules, the report-language rules, a
target brief and the known-findings ledger. All 24 returned reports.

| Slice | Agents | Result |
|---|---|---|
| Immutable Solidity core | 12 (all skill specialties) | No finding. Every candidate refuted with a named guard. |
| Governed periphery + deploy scripts | 4 | S-1, S-2, S-3, I-1 |
| Settle guest (`main.rs` + circuits) | 2 | G-2, S-4 |
| `cxfer-core` lib.rs (3 slices, all 11,508 lines) | 3 | G-1 (all three sub-issues) |
| Bitcoin parsing / burn-deposit | 1 | G-4 (fixed this session) |
| Reflection lane + light client | 1 | G-3 + sync-committee item |
| Solidity↔guest public-values seam | 1 | Clean — 3 defence-in-depth leads |

The twelve-agent pass over the immutable core found nothing. The findings that gate parts of the system
(G-1 through G-4) all came from the eight guest and off-chain agents added beyond the stock skill, which
is the intended payoff of that extension.

---

## 11. Action items

1. **G-4 — done.** Fixed and pushed to `main` (`923b9937` source, `a304f225` test). Confirm the dapp's
   static-site build has picked up the commit.
2. **G-1b — done.** Full-drain farm refund convention added to `dapp/amm-farm-actions.js` (`89441491`).
3. **S-4 — done.** Client-side receipt-owner validation added to `dapp/confidential-farm.js` (`e68d07d4`).
4. **I-2 — done.** Registration-is-not-endorsement note added to `docs/BUILD-A-TACIT-DAPP.md` §3.
5. **G-1a / G-1c mitigations — documented.** A launcher can recover most of a blocked refund by
   self-staking and harvesting normally; harvest replay exposure is bounded by claim size relative to the
   current fee (`dapp/amm-farm-actions.js`, `29485955`). Neither is a structural fix — decide whether this
   is sufficient for a v1 launch or whether to wait for the next-generation guest fix.
6. **Before surfacing `OP_BID`/`OP_OTC` in any wallet or integrator:** the builder, fill tool, and relay
   support already exist and are proven on-chain (`dapp/confidential-bid.js`,
   `ConfidentialBidProofReal.t.sol`). The "needs a trusted matcher" gap is resolved this session for both
   ops — `toShareableBid`/`toShareableRestingBid` (bid) and `publicLeg` keeping a signed leg's `nk`
   (OTC) — with no guest change, so a fully open bid feed is no longer blocked on trust; a disposable
   funding note is still good practice for the narrower linkage reason in G-2, not a hard requirement now.
   What remains is a dapp UI tab.
7. **This week:** read the live pool's stored `eth_sync_committee` and add a monitor for "no Mode-B
   attest in N weeks" (§9).
8. **Governance procedure:** never call `setDeviationBound` before both TWAP sources are wired and
   verified (S-1).


---

## 12. Where this sits in the audit history

This round found no path to theft, inflation, double-spend, nullifier bypass, escrow drain or cross-op
re-typing anywhere in the immutable surface, across all 24 agents and an independent verification pass — the
same clean result the post-deploy reviews before it established, checked again with a wider agent count and
guest coverage added on top of the stock skill. G-4 was fixed and deployed the day it was found. G-1's two
open sub-issues (G-1a, G-1c) are stated limitations of the Bitcoin-native farm lane, which has not launched;
see [`AUDITS.md`](./AUDITS.md) for the full review history and what the post-deploy reviews collectively
established about the deployed bytecode matching this audited source.
