# Tacit — Closing Pre-Release Review, v1 immutable surface (Claude Fable 5.1 → Claude Opus 5)

**Model / mode:** one continuous review session: Claude **Fable 5.1**, continued on Claude **Opus 5** after a
restart. It ran eleven independently scoped adversarial sub-reviews, each told to refute before reporting and
cite `file:line` on both sides. The coordinating reviewer then reconciled and re-verified every claim, reproducing
by test where it could. A fix round followed, then a fresh three-reviewer re-audit of the fixed tree, and a
second fix round for what that found.
**Dates:** 2026-09-16 → 2026-09-17 · **Branch:** `main`, working tree on top of `faa44f1f` (uncommitted, for maintainer
review) · **Posture:** closing review before the v1 immutable surface is locked and deployed.

**This review supersedes the "lockable" verdict of the 2026-09-16 pre-lock review.** That review missed a
Critical in the settle guest and several Highs, listed below.

## Scope

- **Solidity:** `contracts/src` — the pool and `ReflectionLib`, the collateral engine, the escrow helper, feeds,
  the router and periphery, deploy scripts.
- **SP1 settle guest:** `contracts/sp1/confidential/src/main.rs`, `swap_blind.rs`, `groth16.rs`.
- **Bitcoin reflection guest:** `reflect.rs`, `swap_batch.rs`; the shared `cxfer-core` crate; the eth-reflection
  guest and its prover host.
- **Mirrors and relays:** every guest↔JS wire pair on both lanes — the dapp builders, the reflection mirror and
  indexer, the worker attester, the relay feeder and prover wrapper — and the prover harnesses.

**Soundness bar:**
- No value is created or destroyed across Bitcoin↔Ethereum without its counterpart.
- No one can take, redirect or double-spend another holder's balance.
- No two generations can originate value from the same state.
- A holder with only their keys can always exit.
- Confidentiality claims hold exactly as stated.
- No privileged party can freeze or redirect funds beyond a narrow, stated scope.

## Verdict

**Go for freeze and re-prove, not yet for deploy.**

Every finding is fixed, or recorded below as a design decision with a mitigation. The re-audit of the fixed tree
found **no Critical or High in the fixes**. It did find three older High halt paths in the JS reflection mirror;
all three are fixed.

Deploy is gated on work that has not happened yet (see *Deploy gates*):
- **Rebuild the ELFs:** all three guests change. The eth-reflection guest depends on `cxfer-core`, so its ELF
  moves too.
- **Rotate and pin the vkeys.**
- **Prove against the new ELFs:** regenerate the settle Groth16 fixtures and replay every reflection fixture to a
  digest match.

The deployed binaries must not be the current pinned ELFs.

**Live exposure.** Finding C-1 below is in the pinned settle guest this review started from. Its kernel transcript
comes from the same lineage the live generation runs, so until cutover, treat any party that receives a user's
settle witness (the relay operator, or a compromised proving box) as able to exploit it. Expedite the cutover.

## Method

- **Direct review** of the pool settle and attest paths, the lineage mechanism, `reflect.rs` end to end, and the
  settle guest's authorization handlers.
- **Eleven sub-reviews:** pool settle path · attest + lineage · settle guest ops (value) · settle guest ops (DeFi) ·
  reflection guest · eth-reflection + cross-out · JS parity (settle lane) · JS parity (reflection lane) · engine /
  farm / periphery · light relay + exit recoverability · cryptography + confidentiality.
- **Reproduction:**
  - C-1 was replayed against the real `cxfer-core` checks on the committed `sendunwrap_op.json` fixture
    (`RE-TYPE ACCEPTED`, and `RE-TYPE REJECTED` after the fix).
  - The engine lever findings were proven by Foundry tests.
  - The JS halt paths were run against predicted guest digests.
  - The OP_SWAP_BLIND kernel was checked JS→Rust.
- **Re-audit:** three fresh reviewers, each with the diff as scope and no knowledge of the original findings'
  reasoning beyond the fix intent. One covered the reflection guest, one the settle guest plus contracts, one the
  JS and worker mirrors.

## Findings → fixes

Severity is the finding's own, before the fix. "Guest" means the fix changes an SP1 ELF, so it takes effect only
once the ELFs are rebuilt and the vkeys rotated.

### Critical

| # | Finding | Resolution |
|---|---|---|
| C-1 | **A relay could re-type a user's witness as OP_TRANSFER and keep the public amount as its "fee".** The conservation kernel's transcript was `domain ‖ C_in ‖ C_out ‖ output leaves ‖ R`, with the same domain for every kernel op. It did not bind the op type or what `fee·H` meant. A send-unwrap, a swap or route with change, or an LP-add with one-leg change therefore produced a kernel that also verified as an OP_TRANSFER of the same inputs to the same change leaves, with `fee` set to the op's public amount (any amount on the relay-fee ladder). OP_TRANSFER authorizes native inputs with the nullifier key plus the kernel alone, and the relay receives both in every relayed witness. The relay could settle the transfer, collect the user's public amount as its fee, and burn the user's nullifiers so the real op could never settle. | **Fixed (guest).** OP_TRANSFER's kernel now uses its own transcript domain (`tacit-evm-transfer-kernel-v1`, `verify_transfer_kernel`). A kernel for any other op cannot verify as a transfer, and a transfer kernel cannot verify elsewhere; a parity test asserts both directions. The JS transfer builder, the airdrop funding split and the fast-lane exit sign under the transfer domain. Fixtures were regenerated. The re-audit enumerated every kernel op: only OP_TRANSFER and OP_BRIDGE_BURN authorize tree inputs by nullifier key + kernel alone, and OP_BRIDGE_BURN's kernel binds Bitcoin-note leaves no other op produces. The op-review checklist now requires a per-op kernel domain. |

### High

| # | Finding | Resolution |
|---|---|---|
| H-1 | **One unminted cross-out made every generational rebase unprovable.** The successor's drain gate required every recorded cross-out's Bitcoin mint to be folded. Only the burner can broadcast that mint, since the chain holds only a hash of the destination. One cross-out, never minted, made the successor's first attest impossible after `createNextGen` had already retired the predecessor, which is irreversible. | **Fixed (guest).** `rebase_drain_check`: fast-lane consumes must be fully folded; cross-out mints may lag. A pending claim is a member only of the predecessor's cross-out set, so its mint folds only in the predecessor's reflection, which keeps running. Unit-tested; runbook updated. |
| R1 | **The Mode-B light client re-trusted one fixed sync committee on every cycle, forever.** `reflect.rs` required every eth-reflection proof to start from the pinned genesis committee. Two consequences: (a) a key-compromise forgery surface that never ages out, since two thirds of one 512-key committee could sign finalized state indefinitely; (b) a liveness deadline around 2026-12-03, after which the update chain from the pinned period is no longer served, so Mode-B, the fast lane and successor rebases would halt. | **Fixed (guest + host).** The scan state carries `eth_sync_committee`, committed in the resume digest and preserved across a rebase. Each Mode-B proof must start from the committee the previous cycle ended on (the pinned genesis committee only for the first cycle), and its end committee becomes the next anchor. `eth_prove` bootstraps from the finalized slot of the last landed proof when `SYNC_COMMITTEE_MODE=chained`; the default keeps the pinned behaviour for the live generation. `EXPECT_SYNC_COMMITTEE` refuses a mismatched start before proving. **Recommended before the rebuild:** re-pin the genesis committee to a recent checkpoint (below). |
| R2 | **Burn-deposit folding was at the prover's discretion.** The provenance DAG and its header chain are prover-supplied stdin. A prover could omit them, the deposit would skip, the proof stayed valid, and attest is permissionless. The reflection only moves forward, so the confirmed Bitcoin burn (value already destroyed) could never be onboarded. | **Fixed (guest).** A scanned deposit that does not verify is recorded in a new **pending set**, committed in the digest. Any later batch may complete it: membership proves the burn was scanned as a deposit with exactly these envelope fields, the same verification runs, and the burn id is the replay gate. A prover who withholds provenance now only delays. The reflection genesis digest changed to `0x76cd653a…9ce5` (Rust, Solidity, tests). The worker extends a pending bundle's header chain to each batch's anchor and keeps bundles for 90 days. |
| M-2 | **OP_SWAP_BLIND handed the prover each batch's aggregate input blinding.** Per-asset conservation was checked from `r_net` values read in the clear. For a one-directional batch that reveals `Σ r_in`, and with the input nullifier keys (also in the witness) a delegated prover could sign a fresh transfer of every input to itself. The C-1 fix does not close this. | **Fixed (guest).** Conservation is now a Schnorr signature over the per-asset blinding excess (`swap_blind_aggregate_kernel`). The challenge binds domain, chain, pool, side, excess and nonce, and rejects an identity excess and a non-canonical `z`; the prover never receives a blinding. JS builder, harness stdin and tests updated. The coordinator that assembles the Groth16 witness still sees per-trader openings (documented, CC-M1). |
| E-H1 | **The collateral engine's owner could confiscate a cBTC locker's wstETH escrow in about three days.** The owner could arm an arbitrary enforcement module, set the escrow health parameters or swap in a hostile feed, and move the escrow to the reserve once the minimum grace passed, with no notice tied to the change. | **Fixed.** A change to the escrow policy, the enforcement module or the feeds now starts a notice window that must elapse before any flag or enforcement. Shortening the grace window also gives notice (re-audit RA-5). Tests added. Residual trust, documented: after notice the owner can still enforce against a hostile mark, and `drawInsurance` has no delay. |
| E-H2 | **A retired generation had no Bitcoin exit.** Retirement barred cross-outs. Holders of bridged assets and cBTC on the retired generation could never return value to Bitcoin, and lockers whose locks backed that generation's cBTC could only redeem with Bitcoin-lane cBTC that already existed at handoff (relay F-7). | **Fixed.** A retired generation permits cross-outs once its handoff record exists. A cross-out after the rebase point mints only in that generation's reflection, so its value stays one generation's. The handoff record stores the counters it was attested at (`handoffCounts`), so later cross-outs cannot stale a rebase built against it. Cross-outs wait for the record (re-audit RA-1), so they cannot stall it. |
| CC-H1 | **CDP and farm memos were sealed with the wallet's nullifier key as a constant ephemeral.** Every such memo was publicly linkable, reused one XOR keystream, and was decryptable by anyone who learned that key, which every relay does. | **Fixed (JS).** A fresh ephemeral per memo and a fresh per-note nullifier key for every minted output; no builder mints to the wallet-constant owner any more. Operators note: memos already on chain under the old scheme stay exposed; affected wallets should self-transfer. |
| RX-F2 | **One-click farm entry would have locked LP principal.** (Latent; failed closed only because of a memo-count bug.) The receipt owner was a hash rather than a BIP-340 key, the nonce was random and never saved, and no memo was sent. Fixing the memo count alone would have turned the button into a permanent-loss path. | **Fixed (JS).** The receipt key and nonce are derived from the wallet key and the spent note, the owner is a real x-only key, and one memo is sent. A bond → harvest → unbond witness test was added. |
| P-1, P-3, P-5, P-6, P-7, P-9, P-10 | **Seven JS reflection-mirror divergences, each of which halts the attester** (a digest drift or a crash the guest does not share), each triggerable by one Bitcoin transaction. Cases: a crash on non-P2TR optional outputs; a swap_var refund where the guest needs a registered pool; harvest and unbond mutating before failing; a non-canonical Groth16 coordinate; an LP-bond overflow branch; a BP+-only change proof where the guest accepts both schemes. | **Fixed (JS).** Each mirror applies the guest's exact predicate and ordering. Scenario fixtures A–G were added to the fixture generator and verifier. |
| A-H1..H3 (re-audit) | **Three older JS mirror halt paths:** (1) the classic-Bulletproofs verifier reduced scalars ≥ n, which the guest rejects; (2) the swap-batch cross-curve check threw on `z_a ≡ 0 mod n`, where the guest returns false; (3) unbonding a re-bonded identical receipt folded in JS while the guest's strict nullifier insert skips it. | **Fixed (JS).** Canonical scalars (test added), identity for a zero reduced scalar, and an early skip on an already-spent receipt nullifier. |

### Medium

| # | Finding | Resolution |
|---|---|---|
| R3 | The deposit-class note leaf used a zero owner, so its nullifier ignored the outpoint. A payer who knew an opening could deposit a same-commitment clone first and make the recipient's recorded burn unmintable. | **Fixed (guest + JS).** The deposit leaf's owner is the burned outpoint key, in the reflection and in OP_BRIDGE_MINT / OP_BRIDGE_STEALTH_MINT class 0. |
| P-2 | T_AXFER / T_AXFER_BPP (OTC) envelopes were parsed without their `asset_input_count` byte, so OTC outputs were never reflected (bridgeability loss, no value change). | **Fixed (guest + JS).** The parser reads the count, and the kernel's inputs are exactly the live spends at `vin[1..1+count]`, so a taker cannot keep the maker's outputs from onboarding with an extra input. The provenance walker uses the same positions. Encoder KAT on both sides. |
| G4 (ops-B M-1) | OP_SWAP's protocol-fee cut was taken on gross per-leg flow while LP fees clear on net, so on two-sided batches the fee recipient took up to 0.8 of k-growth instead of φ, and fully balanced batches reverted. | **Fixed (guest).** A protocol-fee pool clears one-sided batches only (fail-closed guard); correct two-sided accounting is a later-generation item. |
| E-M1 / E-M2 | `setFeeds(…, twap = 0)` silently disabled an armed deviation bound. The feed-change grace froze top-ups, opened top-ups and liquidations in the same second, and could be re-armed forever with unchanged feeds. | **Fixed.** A TWAP cannot be dropped while the bound is armed; grace re-arms only on a real change; top-ups are exempt. Tests added. |
| RX-F1 | With the header feeder idle, reflected effects were final after 7 privately mined headers (confirmations = 6, immutable per generation); the feeder was the only submitter and stopped when the worker was unreachable. | **Fixed.** `REFLECTION_CONFIRMATIONS=24` in the launch config, script defaults 24, and a mainnet floor in the deploy scripts. The feeder keeps following the explorer tip when reflection's height is unknown. Running a second submitter is an ops recommendation. |
| RX-F3 | A generation whose reflection fell more than 2,016 blocks behind the relay could never recover in practice: one proof had to span the whole excess. | **Fixed.** Permissionless `advanceReflectionAncestry()` walks a canonical checkpoint toward `height(last reflected) + 2016`, at most 2,016 parents per call, keeping progress in a cursor. It promotes only on arrival, so no caller can swap a usable checkpoint for a worse one (re-audit RA-2/3). Batches anchor to the checkpoint while the anchor it was walked from is still canonical, and heights pick the single walk that can succeed (RA-4). Tests cover recovery, a caller advancing mid-recovery, and an orphaned anchor. |
| RX-F6 | Lock-set leaves were emitted in no event, so any router- or helper-routed lock broke lock-set reconstruction for later claims and refunds. | **Fixed.** `LockLeavesInserted(firstLockIndex, lockLeaves)`. |
| RX-F7 | See E-H2 (same root cause, relay-slice framing). | **Fixed** with E-H2. |
| P-4 / P-8 | Junk 0x2B envelopes forced a manual unblock per transaction; the burn-deposit admission mirror missed eight guest checks. | **Fixed** by R2 (unverified deposits go pending instead of halting the attester) and a full admission mirror. |
| CC-M1 | OP_SWAP_BLIND's "solver-blind" claim overstated: the batch coordinator necessarily learns per-trader openings. | **Documented** accurately (design doc and guest comments). |
| CC-M2 | Per-intent `min_out`, tip and direction are public next to `trader_pubkey` in T_SWAP_BATCH, so a tight `min_out` discloses the trader's amount to within its slippage. | **Documented** in `AMM.md`'s public list, with emitter guidance (coarse `min_out` ladder, batch-uniform tip). |
| CC-M3 | The swap tile said amounts stay private, while every solo swap publishes its exact amounts. | **Fixed (UI copy).** |
| Pool F-2 | **tETH escrow is per generation, but Bitcoin-side tETH can exit through any generation.** A successor pays out ETH its predecessor holds, so its own depositors can find its escrow short until someone makes the round trip. | **Open design decision** (below). |
| RR-1 (re-audit) | The chained-committee `eth_prove` would have broken Mode-B for the live generation, whose guest still pins the genesis committee. | **Fixed:** opt-in `SYNC_COMMITTEE_MODE=chained` plus the fail-fast committee check. |
| C-1/C-2/A-M1 (re-audit, JS) | The relay Dockerfile fetched a binary the current release lacks; self-relay re-sealed memos so settle reverted; the pending set cost one KV read per record per batch and kept raw burn txs. | **Fixed:** Dockerfile reverted until the release ships `exec-fastlane`; self-relay passes the sealed memos; one KV listing per batch; completed records drop their raw tx. |

### Low

| # | Finding | Resolution |
|---|---|---|
| G1 | A multi-destination OP_BRIDGE_BURN was guest-valid but could never settle. | Fixed (guest): exactly one destination. |
| G2 | OP_OTC inside a Bitcoin-homed batch minted unspendable outputs. | Fixed (guest): refused. |
| G3 | A zero-debt CDP bond could never be closed. | Fixed (guest): zero debt notes iff zero debt. |
| L-1 / I-5 | CDP, wrap-CDP and farm-bond leg signatures did not bind the leg count, so a basket could be split. | Fixed (guest + JS). |
| eth L-1 | Bitcoin-authorized calls carried no chain binding and could replay onto a same-address deployment elsewhere. | Fixed (guest + JS): message v2 binds the deployment. |
| eth L-2 | The worker's cross-out mint leaf used a superseded shape, so every real 0x65 mint was marked rejected. | Fixed (worker). |
| RX-F4 | The header feeder threw forever after a relay fork deeper than 12 blocks. | Fixed: walks back any depth, alerts, restores. |
| F-5 | An extra live input made a swap batch skip with every trader's input destroyed; swap_var, route and farm-init required exactly one spend. | Fixed (guest + JS): matched by signature; an unclaimed spend refunds the batch; the authorized candidate is selected. |
| E-L1 | `maxStaleness` had no floor. | Fixed: at least one hour. |
| E-L2 | One escrow-helper co-funder's reclaim pulled every co-funder's escrow and cancelled a mint the rest still funded. | Fixed: the remainder is re-posted while the lock is still mintable (fork tests). |
| E-L3 | A liquidation seizes the whole collateral basket; the owner could raise the threshold toward 10×. | Bounded: `MAX_LIQ_RATIO_BPS = 15000`. Surplus return is a recorded design decision. |
| E-L4 | The wstETH feed prices at Lido's protocol rate, not the market. | Documented; mitigated by the escrow ratio and an armed TWAP deviation bound (configuration). |
| L-5 | `createNextGen` accepted a successor with no runtime code. | Fixed. |
| CC-L1 / ops-A L-1 | The relay chooses memo hashes; memos were unauthenticated. | Client-side: after settle the dapp compares emitted memos byte-for-byte, saves the sealed memos on a mismatch, and `openMemo` rejects an nk that does not hash to the owner. A guest binding is a later-generation item. |
| CC-L2 | A relay that saw one wallet-constant nk could link every spend of that wallet's notes. | Fixed with CC-H1. |
| RA-6 / RA-10 (re-audit) | Deploy scripts lacked a mainnet steward check and a confirmations floor. | Fixed. |
| A-L1, A-L3, A-L4 (re-audit, JS) | Completion bundles could not reach the anchor; a malformed stored header, or an old record shape, threw on every batch. | Fixed (see R2; hardened builders). |
| Engine I-4 | `renounceOwnership` would freeze feeds and parameters forever. | Fixed: disabled. |
| Pool I-4 | Fast-lane swaps on protocol-fee pools always revert (their fee locks hit the fast-lane lock bar). | Liveness only; recorded. The dapp should fast-lane transfer first. |
| RR-3 (re-audit) | Swap-batch signature matching can cost up to 16 × same-commitment spends in BIP-340 verifications. | Accepted: bounded by transaction size, paid by the attacker, no fund effect. |
| B-L2 (re-audit) | LP-bond receipt keys are re-derivable after a wipe, but no scanner or UI finds and exits the position. | Recorded (tooling). |

Deploy-script arity (two stale scripts that would have failed closed), stale comments and docs,
`groth16.rs` status, the op-review checklist, and the trust register were also corrected.

Informational items, all recorded, no fund effect:
- The fast-lane race against Bitcoin-side recipients is by design.
- Consumed-source alignment is checked by count.
- The class-1 bridge-mint gate lives in the reflection.
- Wrap has no in-guest deposit dedupe (the contract dedupes).
- Fees go to `msg.sender`, so settles should use private submission.
- Any contract can be a CDP/farm controller, so the dapp must allowlist controllers.
- A compromised guest could sidestep the reserve floor (defense-in-depth only).
- A rebasing escrow token affects only its own asset.
- AXFER onboarding is now live, so output destinations rest on Bitcoin sighash discipline.
- Junk 0x2B envelopes grow the pending set; it is state, not a halt.
- A burn built under the old deposit ν rule and unreflected at cutover stays pending.
- A fast-lane consume whose ν a twin already spent cannot occur: settle pins the latest spent root, and the attest
  count gate folds consumes before any scan.

## Design decisions recorded, not code-fixed

- **tETH escrow across generations (pool F-2).** Every generation registers native ETH under the same Bitcoin tETH
  id but holds its own escrow, and a Bitcoin tETH note does not record which escrow backs it. The exact fix is
  custody shared across the lineage (one native-ETH vault every generation settles against), which only a
  successor's code can introduce.
  Until then (runbook), before any successor hosts tETH:
  - measure the Bitcoin-side tETH the predecessor backs;
  - route tETH burns to the generation holding the matching surplus;
  - keep predecessor lanes alive.

  This applies to the gen4 → v1-final cutover if gen4 has Bitcoin-side tETH outstanding.
- **Liquidation surplus return (E-L3).** Returning the borrower's equity above the debt needs an owner address in
  the position leaf (guest, JS and engine). It is bounded now by the 1.5× cap.
- **Memo authentication in-guest (CC-L1).** Binding memo hashes into the user's authorization is a
  later-generation transcript change; the client-side compare and save ship now.
- **Owner trust residue (engine).** After notice, the owner can still enforce escrow against a hostile mark, and
  `drawInsurance` has no delay. The engine owner is the ops multisig; its signer set and any timelock should be
  re-verified and published.

## Re-audit of the fixed tree

Three fresh reviewers read the diff against HEAD with the fix intents as scope.

| Slice | Critical | High | Medium | Low | Info | Outcome |
|---|---|---|---|---|---|---|
| Reflection guest + `cxfer-core` + eth host | 0 | 0 | 1 | 2 | 3 | All eight fixes sound. Medium fixed; one Low is the committee re-pin (deploy gate). |
| Settle guest + contracts | 0 | 0 | 0 | 6 | 4 | All twelve fixes sound. Lows fixed; Info recorded. |
| JS + worker mirrors | 0 | 3 | 3 | 6 | 7 | The fix batch matches the guest on every item. The Highs were older halt paths, all fixed; all Mediums fixed; Lows fixed except B-L2. |

The reviewers explicitly confirmed:
- **Drain gate:** no double origination.
- **Committee chaining:** word 7 is reachable from word 8 only through updates each signed by the prior committee.
- **Pending deposits:** a prover can delay but not drop a burn, and cannot double-fold it or complete a non-deposit.
- **Retried folds:** each returns every error before mutating state.
- **Swap-blind kernel:** sound.
- **Retired-generation cross-outs and handoff counts:** sound.
- **Storage layout:** appended only (the storage-slot script passes).
- **Witness streams:** JS and guest are byte-identical for the pending, completion, AXFER and extra-input branches.

## Evidence

- **Solidity:** `forge test` on the final tree — 88 suites, 884/884, 0 failed (retirement 10/10, pool reflection
  and ancestry recovery, engine, escrow helper 18/18 on a mainnet fork).
- **`cxfer-core`:** 214/214. **Reflection guest (native):** 4/4. **Settle guest (native):** 5/5. **Prover
  harnesses:** all 41 type-check.
- **Pool runtime:** 24,290 B, 286 B under EIP-170, re-pinned (`verify-pool-size.sh` OK). **Storage-slot pins:** OK.
- **Node suites:** every touched suite passes (reflection 14+, swap-batch, transfer, swap-blind, btc-call, CDP, farm
  parity, relay fee, relay quote, pool-ux 29/29, header-relay fork, classic Bulletproofs 10/10, settle, attester).
  One unrelated test (`amm-sigma-xcurve.test.mjs`) fails on a stale LP-add encoder call in files this review did
  not change.
- **C-1:** `RE-TYPE ACCEPTED` before the fix, `RE-TYPE REJECTED` after, on the real fixture.

## Deploy gates

1. **Optional but recommended, before freezing guest source:** re-pin `ETH_GENESIS_SYNC_COMMITTEE` in `reflect.rs`
   (and the host's `GENESIS_SLOT`) to a recent finalized checkpoint, so v1-final's first Mode-B cycle does not
   replay from period 1800.
2. **Rebuild in order:**
   1. the eth-reflection ELF, re-deriving `ETH_REFLECTION_VKEY`;
   2. pin that vkey in `reflect.rs`;
   3. the reflection ELF (`bitcoin_relay_vkey`);
   4. the settle ELF (`program_vkey`).

   Then update `elf-vkey-pin.json`, the lockstep checkpoint and the harness `PINNED_ELF_SHA256`.
3. **Prove against the new ELFs:**
   - regenerate every settle Groth16 fixture (including `farm_bond`);
   - replay every reflection fixture to `DIGEST_MATCH` (including `reflection_swapbatch` with the ceremony zkey and
     the new pending, completion and extra-input scenarios);
   - execute the h02 migration fixtures.
4. **Build and release the prover binaries:** `eth_prove` builds only on the prover box. Include `exec-fastlane`,
   then restore it to the relay Dockerfile.
5. **Commit together:** fixtures, ELFs, pins and source, then re-run the readiness gate and the strict vkey-pin
   check on the committed tree.
6. **v1-final operations:**
   - `REFLECTION_CONFIRMATIONS=24` in the worker and relay env (their defaults stay 6 for the live generation);
   - `SYNC_COMMITTEE_MODE=chained` with `GENESIS_SLOT` for the eth sidecar;
   - a second independent header submitter;
   - measure Bitcoin-side tETH before hosting it.
7. **Cutover:** expedite the gen4 cutover and drain (C-1).

## Files changed by this review

- **Settle guest:** `contracts/sp1/confidential/src/{main.rs,swap_blind.rs,groth16.rs}`.
- **Reflection guest and shared crate:** `contracts/sp1/confidential/src/{reflect.rs,swap_batch.rs}`,
  `contracts/sp1/confidential/cxfer-core/src/{lib.rs,bitcoin.rs,burn_deposit.rs}`.
- **Eth reflection:** `contracts/sp1/eth-reflection/src/main.rs` (comments only),
  `contracts/sp1/eth-reflection/prover-host/src/bin/eth_prove.rs`.
- **Prover tooling:** `contracts/sp1/reflect-stdin/src/lib.rs`, 41 prover harnesses,
  `contracts/sp1/confidential/OP-REVIEW-CHECKLIST.md`.
- **Solidity:** `contracts/src/{ConfidentialPool.sol,ReflectionLib.sol,CollateralEngine.sol,CbtcEscrowHelper.sol,WstEthUsdFeed.sol}`,
  `contracts/pool-bytecode-pin.json`.
- **Deploy config and scripts:** `contracts/deployments/launch-v1-final.env`,
  `contracts/script/{DeployV1SuiteCreateX,DeployV1Suite,DeployConfidentialPool,DeployV1PoolFinish,DeployRouterCreateX,CreateNextGen,ForkAttestGate}.s.sol`.
- **Solidity tests:** `contracts/test/{ConfidentialPool,ConfidentialRetirement,CollateralEngine,CbtcEscrowHelper}.t.sol`.
- **Fixtures:** regenerated settle and reflection fixtures, plus the new reflection scenario fixtures.
- **Dapp:** transfer, pool, pool-ux, airdrop, CDP, farm, LP, route, stealth, swap, swap-batch, swap-blind, btc-call,
  defi-actions, memo, relay, reflection indexer, burn-deposit, Bulletproofs, cross-curve sigma, adaptor signature
  and swap, earn and swap tabs.
- **Worker:** attester, cross-out consumer, settle queue, relay quote, bundle route.
- **Relay:** header feeder, prover wrapper, chain ABI.
- **Docs:** `AMM.md`, `ops/RUNBOOK-generation-handoff.md`, `ops/TRUST-REGISTER-production.md`, and the h02 fixture
  manifest.
- **Node tests:** new and updated suites under `tests/`.
