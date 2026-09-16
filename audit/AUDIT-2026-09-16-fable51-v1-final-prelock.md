# Tacit — Conclusive Pre-Lock Review, v1-final (Claude Fable 5.1)

**Model / mode:** Claude **Fable 5.1** — direct line-by-line review of the highest-novelty surfaces plus nine
parallel, independently-scoped sub-reviews (each with a refute-before-report brief), reconciled and re-verified by
the coordinating reviewer before anything was accepted or changed.
**Date:** 2026-09-16 · **Branch:** `main` (v1-final working tree) · **Posture:** conclusive, pre-lock — the last
review before the v1 immutable surface (Solidity + two SP1 guests) is locked and deployed for real.

This review was scoped as *adversarial and complete*: every file in the immutable surface, every guest↔JS
wire-format and signed-message pair, and the surfaces new this round (the cross-generation retirement handshake,
the relaxed reflection catch-up bound, the burn-deposit completeness gate, and the swap-batch range binding). It
found and fixed **one Critical in the reflection guest**, **a cluster of retirement-mechanism defects on the pool**,
**twelve further instances of the guest↔JS drift class** (two of which would have cost users principal), and **one
owner-side lever in the collateral engine** — and it confirms the cryptographic core, the cross-chain conservation
gates, the periphery, and the light relay sound.

## Verdict

**Lockable — no theft, no redirected payout, no double-spend and no cross-generation double-mint path on the
audited surface as it now stands.** Both guests were rebuilt, re-proved and re-pinned the same day (settle
`program_vkey 0x0024bd06…`, reflection `bitcoin_relay_vkey 0x004002de…`; every fixture binds to those keys and the
lockstep check passes), so the deploy gate this review opened is closed; every other fix is Solidity, JavaScript
or prover-harness code. A second, independent pass later the same day (the follow-up section below) found one
further Medium on the redesigned lineage — a retired generation refused its own canonical-token wraps, which
would have made cUSD repayment and liquidation impossible after a handoff — and fixed it. The design points this
review raised were resolved in the same pass (below); what remains for the maintainers is operational.

## Method

- **Direct review** of `ConfidentialPool.sol`, `ReflectionLib.sol`, the lineage mechanism, `reflect.rs`,
  `swap_batch.rs`, `swap_blind.rs` and this round's full diff; every claim below was traced to the line on every
  side of the invariant it touches.
- **Nine parallel sub-reviews:** EVM-lane value ops parity · EVM-lane DeFi ops parity · Bitcoin-lane envelope
  parity · cxfer-core cryptographic kernel · CollateralEngine / oracle / farm · periphery (router, AMM, relayer,
  canonical tokens, executors) · BitcoinLightRelay + anchor · burn-deposit + eth-reflection · pin / deploy
  coherence. Each was instructed to refute before reporting and to cite `file:line` on both sides of any cross-file
  claim.
- **Mechanical evidence:** the full Solidity suite (88 suites, 879 tests, 0 failures, on the fixed tree), the
  cxfer-core suite (211/211), the in-guest Groth16 swap-batch verifier tests, the confidential node suites and every
  parity script touched by a fix; all three guest vkeys were **re-derived locally from the pinned ELFs** and match the
  pin byte-for-byte; the pool's runtime was re-measured and re-pinned (23,720 B after this pass, 23,905 B — 671 B
  under EIP-170 — after the follow-up fixes); the storage layout was re-read and no guest-pinned slot moved.

## Findings → fixes

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **Critical** (guest) | **Burn-deposit provenance shortcut admitted a prover-asserted outpoint.** A "pool-membership" leaf lets an onboarding lineage terminate at an already-tracked note instead of the asset's etch. A note-tree leaf commits no outpoint, so the shortcut handed the provenance DAG a `(outpoint, commitment)` pair the prover chose; the DAG's reachability check then accepted a real, conserving hop whose input was that pair, and a hop's conservation kernel needs nothing but the note's opening. The owner of any tracked note could therefore have onboarded its value on Ethereum while the note stayed live on Bitcoin — repeatably. An earlier fix had closed only the shape where the burned note *is* the leaf. The production tracer never emitted such leaves, but the attest entrypoint is permissionless, so that was not a defense. | **Fixed (source; ELF re-pin pending).** The reflection guest now refuses any provenance blob that carries pool-membership leaves (a deterministic skip, never an abort, so no stall vector); a lineage must bottom out at a transaction-derived leaf (the etch's or a mint reveal's output). The JS attester mirrors the refusal and a regression case was added. A sound shortcut needs an outpoint→leaf accumulator the reflection does not keep — a later-generation feature. |
| 2 | **High** (fund-strand) | **A retired generation stranded value it alone could release.** The post-retirement exit filter barred bridge mints — but a Bitcoin burn's id carries the *target* generation's chain binding, so only that generation can ever pay it; barring it stranded a note already destroyed on Bitcoin, and no successor could pay it instead. It also barred stealth/adaptor locks (which a stealth bridge mint rides), farm harvests (earned rewards, recoverable by nobody), collateral top-ups, and the deferred-effect drains that carry the lock redemptions an escrow reclaim depends on. It also closed the retired generation's *reflection*, so a burn targeting it that confirmed after the handoff, and a cBTC lock redemption after it, could never land where they were needed. | **Fixed.** The filter now bars only the cross-generation primitives (Bitcoin-homed spends, cross-outs, swaps, liquidity adds, cBTC mints, new positions/bonds/draws); bridge mints, locks, claims/refunds, closes, top-ups, harvests and drains stay open, and so does the retired generation's reflection — a Bitcoin-authorized call is bound to its executor and a burn to its target generation, so two generations reflecting the same history cannot double-deliver anything. Pinned by tests. |
| 3 | **Medium** (griefing → a dead generation could never be retired; capture) | **The retirement handoff was authenticated by inactivity and a shared registry pointer.** A proposal could be overwritten by any later valid proposal, resetting its clock; more fundamentally, anyone able to produce a reflection proof could block a migration indefinitely with one forward attest per fortnight, and a rogue proposal on a generation left idle captured the lineage pointer for an address nobody controlled. | **Redesigned.** The pool is now the factory of its own successor: `createNextGen` (steward-only, one-shot) CREATE2-deploys the next generation from the pool's own context, and a successor's constructor accepts a predecessor only when that predecessor is its deployer. The lineage authenticates itself by construction, so the shared registry, the proof-carrying proposal and the fourteen-day idle window are gone, and nothing about the handoff can be griefed or captured. The only privileged act in the lineage — choosing the successor's code — is explicit, bounded (it cannot touch escrow, freeze an exit or redirect a payout) and held by the ops multisig. |
| 4 | **Medium** (migration liveness) | **A successor pinned the predecessor's final reflected state at deploy.** Any attest or user cross-out on the predecessor after that pin — including a bystander's — invalidated the successor and required redeploying it (and re-mining its address). | **Fixed.** Nothing is pinned. The successor's first attest proves a rebase of the predecessor's *live* digest, drained counters and tip, all read at that moment; a rebase built against an older state is simply re-proven. The predecessor is free to keep reflecting throughout. |
| 5 | **High** (user principal, fail-closed) | **Two Bitcoin-lane builders diverged from the guest in a way that destroyed the trader's input.** The dapp's variable-amount swap built an aggregated two-commitment range proof where the guest verifies a single-commitment proof over the change; the route builder signed a superseded kernel message and omitted the refund output the guest reads. In both cases the confirmed transaction's input was nullified by the scan and the fold skipped — the inputs were lost, not stolen. Same class as the LP-add tail found earlier this round. | **Fixed (JS + worker validator only; no vkey change).** Both builders now produce exactly the guest's shapes; the route parity test pins the hop-0 kernel message on both sides. |
| 6 | **Medium** (attester halt from one transaction) | **Three JS-mirror predicates disagreed with the guest** (the LP-remove share-burn kernel over all detected spends instead of the pool's share asset; the legacy-asset allowlist applied to bid fills the guest folds regardless; a swap batch's tip-commitment openings not checked). A single crafted or even accidental Bitcoin transaction would have desynchronized the attester's digest and halted reflection until patched. | **Fixed.** Each mirror now applies the guest's predicate; the swap-batch parser surfaces the tip blindings. |
| 7 | **Medium** (fail-closed) | **Four Bitcoin-lane builders paid a value note to a P2WPKH output** where the guest onboards under the output's Taproot key (protocol-fee claim, farm harvest, farm unbond, farm refund). Every such op would have been skipped; nothing was consumed. | **Fixed.** The destinations are the same key-path P2TR the swap receipts already use. |
| 8 | **Medium** (fail-closed) | **EVM-lane wires had drifted from the prover harness** in the layers that reshape builder output: the wrap-LP and wrap-swap wires carried undefined signatures and lacked the spend-root the harness reads; the LP-bond context bound two words the guest dropped and the wrong note owners; the CDP mint/close callers omitted note owners and nullifier keys; farm fees were strings where the harness reads numbers; the bridge-stealth-mint builder emitted raw bytes; the prover-blind batch harness and builder did not carry the per-receipt range proof the guest now reads. | **Fixed** on the JS/harness side; no guest change. |
| 9 | **Medium** (owner-trust, mutable engine) | **The engine owner could raise the liquidation threshold and liquidate the whole book in the same block**, defeating the notice the feed-change grace promises borrowers; a feed swap also priced mints and top-ups immediately. | **Fixed.** Raising the liquidation ratio re-arms the 6-hour grace; mints and top-ups wait it out after a feed change; closes are never gated. Tests added. |
| 10 | Low | **A settler-malformed swap-batch receipt** (bad cross-curve proof or range proof) skipped the batch after the vin scan had nullified every trader's input. | **Fixed (guest + mirror, riding the same rebuild).** It now refunds each trader's exact input, the discipline every other post-authorization failure already had. |
| 11 | Low | A migrating generation could be deployed directly, independent of the generation it claimed to succeed, leaving both active over one reflected state. | **Fixed.** A migrating generation can only be created by its predecessor (`msg.sender` must be the predecessor it names) and must leave both reflected-genesis inputs zero; every other shape fails closed at construction. |
| 12 | Low | Deploy scripts did not assert the public-AMM back-pointer; router documentation mis-stated who receives the off-ratio refund; the wire-format spec omitted three fields the guest reads; two tests encoded superseded shapes. | **Fixed.** |

**Confirmed sound** (independently, with the closing evidence recorded in the sub-reviews): the conservation
kernels and every output-binding variant; every opening-sigma and intent context (all domain tags enumerated,
no cross-op collision that authorizes value — one shared tag between the two wrap shapes is a downgrade only, see
below); the dual-scheme range verifier and every value-bearing callsite on both lanes; the nullifier and
generation-bound leaf domains; BIP-340; the cross-curve value binding for swap batches (both curves now
independently bounded, so the sigma's modular equality is an integer equality — the internal flag raised on this
point is resolved); the baked Groth16 verifier and public-signal derivation; the NUMS generators (recomputed);
the bridge-mint one-mint gate, burn-root freshness, consumed-set completeness and cross-out completeness; the
Mode-B recursion anchor and the mainnet weak-subjectivity pin; the eth-reflection guest (unchanged this round —
confirmed by a zero source diff, matching ELF hash and a locally re-derived vkey); the relay's fork choice,
retarget and maturity walk with the raised lag bound (worst case ≈5.8M gas, well inside a block; the walk only
ever descends the canonical chain); the periphery's exit escrow, Permit2 pull and relayed-fee handling; the
delegatecall extraction into `ReflectionLib` (semantics byte-identical); every `PublicValues` layout.

## Design points raised by this review and how they were resolved

- **Retirement authority.** The inactivity-authenticated, registry-backed handoff was griefable by anyone with a
  prover and capturable when idle, pinned the successor to a deploy-time state, and imposed a fortnight's bridge
  blackout. Resolved by making the pool the factory of its own successor (finding 3): the lineage authenticates
  itself by construction, nothing is pinned, no delay is needed, and a retired generation keeps reflecting so the
  blackout does not exist. The residual trust is one explicit, bounded act — the steward chooses the successor's
  code — and users are never obliged to follow a successor.
- **Unredeemed cBTC locks at retirement.** A lock minted before and redeemed after the handoff needed its
  redemption reflected on the generation whose engine holds the escrow. Resolved by keeping the retired
  generation's reflection open; the handoff runbook keeps that lane alive until the predecessor's lock set is
  fully resolved.
- **Terminal repayment floor (engine).** Reverted to the exact per-position ceiling. The surplus the fee budget is
  credited now never exceeds what borrowers burned, with no dust credit in either direction; the base-unit
  residue a full wind-down can leave is stated in the code and covered by the operational rule (a protocol-owned
  dust position plus protocol-held cUSD for base-unit shortfalls whenever the fee is enabled).
- **Amount-bearing stealth claim (protocol-fee skims).** The prover harness now serializes the guest's amount-
  bearing arm, matching the dapp's existing builder, so skims are claimable; no guest change.
- **Shared wrap opening-sigma tag (Low, would need a vkey rotation).** Left as recorded: a prover box could
  settle the plain wrap in place of a wrap-and-send, funds staying with the depositor. Not a blocker.
- **ETH→BTC outbox pin.** The reflection guest pins the new generation's predicted outbox address; the lockstep
  check confirms all four pins come from one recorded checkpoint. Nothing to decide before the rebuild.
- **Header-relay feeder.** Now walks the relay's tip back to the last block the explorer agrees on and
  resubmits from there, so an abandoned branch no longer stalls the relay indefinitely.

## Follow-up pass (same day, second reviewer session)

A second Fable 5.1 session re-read the fixed tree line by line — the pool (every entrypoint, the settle body, the
attest wrapper, the generation logic), `ReflectionLib` (delegatecall storage discipline, attest, drains, payout /
ingest, registration, pair creation, the anchor walk), the collateral engine (feeds, escrow lifecycle, CDP hooks,
the fee and savings accumulators), the router and exit executor, `reflect.rs` end to end, `swap_batch.rs`, and the
settle guest's Bitcoin-homed authorization and bridge-mint handlers — and re-paired the contract ↔ guest journal
field by field (the reflection public values, the overflow leaf / chunk / meta-root hashing with its tags and
widths, the successor rebase anchor, the burn-id domain on both lanes, the memo-root chain). Every guest-pinned
storage slot was re-verified (`verify-storage-slots.sh`, `verify-reflection-slots.sh`), the pool was re-measured
and re-pinned, and the pool file was scanned mechanically for unused errors, events, functions, constants and
state (none; one deliberate layout spacer; the unused `IAssetId` interface and `IMintBurn.mint/burn` members were
removed with a byte-identical runtime).

| # | Severity | Finding | Resolution |
|---|---|---|---|
| F-1 | **Medium** (fund-strand after a handoff) | **A retired generation refused every wrap, including its own canonical tokens.** Repaying or liquidating a cUSD position consumes shielded cUSD, and after `createNextGen` the only way to obtain it was to already hold it: a borrower who had exited to public tacUSD could not close, a keeper could not liquidate, and the cBTC collateral behind every such position had no release path. The same bar kept tacBTC / TAC minted on an earlier exit from re-entering the generation that alone can honor them. The intent — no *new* value after retirement — is right; a pool-minted token is not new value (it was minted here against a note that exited). | **Fixed.** `wrap` gates on `_isActiveGeneration()` for external assets only; a pool-minted asset burns back into a note on a retired generation exactly as before. `farmEscrow` funding and the public-AMM applicators keep the unconditional bar. Pinned by `test_retired_still_wraps_its_own_canonical_token` and the tightened new-entry test; runtime re-pinned (23,905 B after the handoff anchor below). |
| F-2 | Deploy gate (found open, closed the same day) | At the start of the pass both guest ELFs on disk differed from the pinned artifacts and from HEAD, so the pinned vkeys did not describe the binaries in the tree and `verify-vkey-pin.sh` failed. | **Reconciled** by the re-prove session at 18:22: settle ELF `3d173e8f…` ↔ `0x0024bd06…`, reflection ELF `51269e2f…` ↔ `0x004002de…`; both sha checks pass, all 35 settle + 2 reflection fixtures bind to the pinned keys, lockstep re-recorded, deploy default vkey matches. The regenerated `crosslane_groth16.json` lost the `.bitcoinSpentRoot` key its test's sanity check reads (one parse failure; the on-chain verification passes on every other real-proof suite, 173/174). |
| F-3 | Design (next migration) | **Canonical-token continuity across generations.** `CanonicalBridgedERC20.MINTER` is immutable and in the CREATE2 salt, so every generation mints a distinct tacBTC / tacUSD / TAC; a retired generation bars cross-outs, so a public holder of a retired generation's token can re-enter that generation (after F-1) but has no path to Bitcoin or the successor. | **Resolved as a successor-side design, no v1-final change.** Lineage-aware minting was considered and rejected: it would let the steward dilute existing holders through whatever code it names as successor, and would import a compromised predecessor's supply into the successor's shared asset. The sound shape is one-way escrow adoption chosen per migration: the successor records `PREDECESSOR.canonicalTokenFor(sharedId)` as an adopted underlying and offers a wrap that retires the old token into itself (it cannot mint it, so it is never released) while crediting a note under the shared id with the ordinary value binding — the guest consumes that deposit unchanged and supply is conserved. Everything the successor needs (`canonicalTokenFor`, `assets`, transferable tokens, open exits and pool-minted wraps on the predecessor) already exists in v1-final. Written into `ops/RUNBOOK-generation-handoff.md`. |
| F-4 | Low (migration liveness) | The successor's first attest binds the predecessor's live digest and attest is permissionless, so a predecessor attest landing between the successor's proof generation and submission forces a rebuild (`StaleReflectionDigest`), at most once per matured Bitcoin block. Counters are frozen at retirement, so only the digest moves. | **Fixed.** The predecessor now records a handoff anchor — the digest and tip of its first attest after retirement, written once (every attest is drained by the count gates and retirement freezes the counts, so the record is always a valid rebase point). `ReflectionLib.attest` accepts a rebase bound to either that record or the live state. A proof built against the record cannot be staled by any later attest; the live path keeps the freshest tip available. Two appended storage slots, two views, no guest change; pinned by `test_successor_rebases_from_the_handoff_record_after_later_predecessor_attests`. |
| F-5 | Info | A swap-batch refund note commits the input commitment verbatim; a refund output that reuses the input note's Taproot key yields the retired input's leaf and nullifier — still Bitcoin-spendable and bridgeable, but not fast-lane spendable. | Builder guidance: derive a fresh refund key per intent. |

Confirmed sound by this pass, beyond the list above: the settle body's effect ordering and every on-chain floor
that bounds a compromised guest; the native-ETH force-send under the transient reentrancy guard; the library's
storage discipline; the attest gates and the successor rebase (drain gate + `rebasedFromDigest` binding + counters
frozen by the retirement filter); the engine's feed validation, grace re-arm and fee-budget invariant; the router's
recipe-bound escrow, fee isolation and executor bars; the reflection guest's coinbase / witness gates, spent-set
duplicate discipline, burn ids, burn-deposit gates and the swap-batch refund floor; the settle guest's bridge mint.
Evidence: retirement suite 8/8, pool unit suite 125/125, full Solidity suite green apart from the one fixture parse
in F-2.

## Deploy gates

1. Restore the `.bitcoinSpentRoot` field the cross-lane fixture generator dropped (or point the test's sanity
   check at the public values), then commit the reconciled ELFs, pins, fixtures and the Solidity changes together
   (the strict vkey-pin check fails on an uncommitted ELF/source pair by design).
2. Re-run the readiness gate on the committed tree; reuse the live header relay (its genesis seeds are proven
   on-chain).
3. Expedite the gen4 cutover and drain (the Critical above is live on gen4 until then).

## Files changed by this review

`contracts/src/ConfidentialPool.sol`, `contracts/src/ReflectionLib.sol`, `contracts/src/CollateralEngine.sol`,
`contracts/src/ConfidentialRouter.sol` (docs), `contracts/script/DeployV1Suite*.s.sol`,
`contracts/script/CreateNextGen.s.sol` (new), `contracts/pool-bytecode-pin.json`,
`contracts/sp1/confidential/src/reflect.rs`, `contracts/sp1/confidential/src/swap_batch.rs`,
`contracts/sp1/confidential/harnesses/exec-swapblind.rs`, `contracts/sp1/confidential/harnesses/exec-stealthclaim.rs`,
`contracts/sp1/confidential/elf-vkey-pin.json` (note), `worker-relay/src/header-relay.js`,
`dapp/tacit.js`, `dapp/confidential-pool.js`, `dapp/confidential-pool-ux.js`, `dapp/confidential-defi-tab.js`,
`dapp/confidential-farm.js`, `dapp/confidential-stealth.js`, `dapp/confidential-swapbatch.js`,
`dapp/confidential-swapblind.js`, `dapp/amm-farm-actions.js`, `dapp/amm-envelope.js`,
`dapp/burn-deposit-bitcoin.js`, `dapp/confidential-reflection-scan-indexer.js`, `worker/src/index.js`,
`spec/amm/wire-formats.md`, `ops/AUDIT-FLAG-swapbatch-value-bound.md`, `ops/RUNBOOK-generation-handoff.md` (new);
tests: `ConfidentialRetirement.t.sol`
(new), `ConfidentialPool.t.sol`, `CollateralEngine.t.sol`, `confidential-burn-deposit-wiring.mjs`,
`swap-route-dapp-worker-parity.test.mjs`, `confidential-pool-ux.mjs`, `amm-protocol-fee.test.mjs`,
`blind-stealth-builders.test.mjs`, `confidential-bridge-stealth-op.mjs`. Follow-up pass: `ConfidentialPool.sol`
(the `wrap` gate and retirement docs; `IAssetId` and `IMintBurn.mint/burn` removed), `pool-bytecode-pin.json`,
`ConfidentialRetirement.t.sol` (one test tightened, one added).
