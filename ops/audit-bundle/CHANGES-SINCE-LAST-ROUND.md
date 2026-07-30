# Changes since the last review round

This records what changed since the previous bundle so a returning reviewer can focus. Audit the code
independently — this is a map, not a substitute for review. Nothing here is a claim of correctness, and a
remediation is not correct because it is listed here.

## Latest round — audit-response round 5: LP-add refund atomicity, cUSD fee base-unit accounting, Bitcoin farm schedule bounds, variable atomic-settlement disable, LP-remove zero-leg refund, storage-slot gate (commit range `6c2c5ff4..d30b24ad`)

This round answers a fifth review pass on top of the four below. Each item is an independent change; audit each on
its own. Finding labels are review-map handles here, not correctness claims. Nothing here is a claim of
correctness, and a remediation is not correct because it is listed here.

**Deploy-vkey note:** the vkeys in `pins/elf-vkey-pin.json` remain the **prior round's** and the reprove stays
**HELD pending this audit**. This round's LP-add refund staging, Bitcoin farm-init schedule bounds, variable
atomic-settlement removal, and LP-remove zero-leg share re-mint are all reflection-fold changes, so the reflection
vkey rotates again on the held reprove (the settle `program_vkey`, the eth-reflection vkey, and the reflection vkey
were already rotating across the prior rounds). Rebuild per `BUILD-AND-VALIDATE.md`; no new vkeys are invented in
this bundle.

### LP-add refund atomicity — half-applied two-asset refund

The two-asset Bitcoin LP-add refund appended note A and then note B through a skippable path: a bad note-B append
witness returned an error the reflection fold skipped, but only after note A had already mutated the note-tree root
and both funding notes had been retired. The result was a half-applied refund — one leg re-minted, the other
destroyed with its input already spent. The refund is now staged: both appends are computed first and the
root/count/live-set commit only once both succeed. A bad refund witness now panics (proof-fatal) rather than being
skipped — not a liveness risk, because a bad refund path has a unique honest alternative, so an honest prover can
always produce the valid proof — matching the single-note refund discipline already used elsewhere.
Reflection-fold change; rotates the reflection vkey on the held reprove. Files: `cxfer-core/src/lib.rs`.

### cUSD stability-fee base-unit accounting

The stability fee accrues aggregate interest at RAY granularity while an individual position is charged its owed at
base-unit ceil. At the single-base-unit boundary the two disagree: a positive fee can leave the last fee-bearing
position owing one base unit more than the aggregate authorized — a fund-safe collateral lock rather than a loss —
and a zero-normalized-debt position could book its principal as drawable surplus. This round fixes the inflation
path: a zero-normalized-debt position is rejected at mint, in both the engine and the settle guest. The stranding
path is fund-safe and documented; exact per-position solvency needs per-position fee accounting, deferred to a
future generation (`ops/DESIGN-fee-per-position-redesign.md`). The fee ships dormant. Contract + settle-guest
change. Files: `CollateralEngine.sol`, `src/main.rs`.

### Bitcoin farm schedule bounds

Farm-init set no bound on the reward rate. The per-share accumulator could therefore saturate, and a later bond's
`shares*rps` could overflow a checked multiply the fold skipped after retiring the bonder's LP-share inputs —
destroying the bonded principal; separately, a fixed-funded schedule could promise more rewards than its treasury
holds. Farm-init now rejects, at init: a perpetual (`end==0`) or empty fixed-funded window, a rate or window over
2^32-1, `rate*window >= 2^63` (so `shares*rps` stays under u128 for any bondable shares — the overflow paths are
dead), and `rate*window` over the funded `reward_total`. Reflection-fold change; rotates the reflection vkey on the
held reprove. Files: `cxfer-core/src/lib.rs`, `src/reflect.rs`, dapp assembler, worker.

### Variable atomic-settlement disabled

The variable-amount atomic settlement (envelopes `0x37`/`0x3D`) left the maker's asset-change output script unbound
by the maker signature: `SIGHASH_SINGLE|ANYONECANPAY` pins only the maker payment vout, so a taker could substitute
the change output and the fold would reflect the retired change to an attacker-chosen or unspendable key. A
destination-binding fix would touch the settlement path shared with plain transfers and risks a fold that aborts on
crafted input, so instead the two variable variants are dropped from the accepted envelope set: they parse as
unsupported and are skipped. The fixed-amount atomic settlement (`0x26`/`0x3C`) and plain transfers (`0x22`/`0x23`)
are intact, and emission defaults off. Reflection-fold change; rotates the reflection vkey on the held reprove.
Files: `cxfer-core/src/bitcoin.rs`, dapp.

### LP-remove zero-leg refund

A proportional Bitcoin LP-remove withdrawal that floored either asset leg to zero returned an error the reflection
fold skipped after the LP-share input had already been retired — burning the share. On a zero leg the fold now
re-mints the share note (its own amount, opened by the on-chain canonical-first recv blinding, owner-bound to a
dedicated vout-2 key) instead of touching the pool. The remove opcode always reads three append paths so the
accept-vs-refund branch cannot desync the witness stream; the kernel binds the refund destination; the refund note
is mapped so it stays spendable. Reflection-fold change; rotates the reflection vkey on the held reprove. Files:
`cxfer-core/src/lib.rs`, `src/reflect.rs`, `reflect-stdin/src/lib.rs`, dapp assembler + signer, worker.

### Storage-slot gate — per-reader body check

The storage-slot build gate's reader check was set-based: a slot permutation across the reader functions could
still pass. It now checks that each reader function's own body carries its field's current slot, so a permutation
fails closed. Gate-only; no guest or contract change. Files: `gates/verify-storage-slots.sh`.

### Note — cross-generation resume reworked to a curated seed

Cross-generation resume is being reworked to a curated seed — empty notes, a near-tip height, and inherited
reject-only Bitcoin accumulators (`ops/DESIGN-multigen-safe.md`) — which closes the cross-generation double-mint by
construction with no immutable-code change. Reviewers should treat the earlier near-tip note resume as superseded.

## Round 4 — audit-response round 4: stability-fee solvency completion, Bitcoin LP-add min-shares/expiry/refund, protocol-fee claim pool-id, escrow cure-clear, storage-slot KAT (commit range `9efd068d..851ea04d`)

This round answers a fourth review pass on top of the three below. Each item is an independent change; audit each
on its own. Finding labels are review-map handles here, not correctness claims. Nothing here is a claim of
correctness.

**Deploy-vkey note:** the vkeys in `pins/elf-vkey-pin.json` remain the **prior round's** and the reprove stays
**HELD pending this audit**. This round's Bitcoin LP-add and protocol-fee claim changes are reflection-fold
consensus changes, so the reflection vkey rotates again on the held reprove (the settle `program_vkey`, the
eth-reflection vkey, and the reflection vkey were already rotating across the prior rounds). Rebuild per
`BUILD-AND-VALIDATE.md`; no new vkeys are invented in this bundle.

### cUSD stability-fee solvency completion — stale-snapshot instant interest

The prior round's accrue-on-drip fee (see Round 3) budgeted interest only through `drip`, which advances the fee
budget from the last drip's rate to the current one. A CDP minted at a rate snapshot **below** the current rate —
the ordinary prove→settle band, or a deliberately stale snapshot — therefore owes instant interest the moment it
mints (its debt is `principal·currentRate/snap > principal`), and that instant interest was never added to the fee
budget. Collateralization was also gated on `principal`, not on the accrued owed, so a stale-enough snapshot could
settle a position that is already under-collateralized at current-rate debt. The combined effect: circulating cUSD
could exceed `fee budget + drip-accrued interest`, and the last fee-bearing position could again strand — the same
insolvency class the prior round closed for the drip path but left open on the mint edge.

Fixed: `onCdpMint` now computes the accrued owed at the mint snapshot, gates collateralization on that owed (not
principal), and credits the exact instant interest — the debt added beyond principal — to the fee budget. The
invariant `circulating cUSD + fee budget == aggregate debt` then holds for any snapshot, stale or current. Adds
stale-snapshot, max-stale, and dust tests plus an arbitrary-snapshot / drip-partition / close-order invariant
fuzz. Contract-only; no guest change. Files: `CollateralEngine.sol`.

### Bitcoin LP-add min-shares floor, expiry, and atomic refund

The variant-0 Bitcoin LP-add fold minted shares recomputed from the pool's current reserves and never constrained
them to the LP's signed share amount, carried no expiry, and had no refund path. An incumbent LP could therefore
sandwich a balanced deposit — skew the reserves so the add mints far fewer shares than intended, then reverse the
skew — and a zero-share outcome self-burned the LP's already-spent input notes. The add now treats the signed
share amount as a **minimum**, binds an `expiry_height`, and on a shortfall or past-expiry refunds the exact
contributed A and B as two owner-bound notes at fixed vouts instead of touching the pool; `POOL_INIT` still
requires the deterministic first mint exactly. The LP-add opcode always emits two append paths so the
accept-vs-refund branch cannot desync the reflection witness stream. The rule is mirrored byte-exact across the
guest fold, the signed kernel message, the envelope, the serializer, the dapp assembler and signer, and the
worker decoder (the refund vouts are mapped so the notes stay spendable). Reflection-fold consensus change;
rotates the reflection vkey on the held reprove. Files: `cxfer-core/src/lib.rs`, `cxfer-core/src/bitcoin.rs`,
`src/reflect.rs`, `reflect-stdin/src/lib.rs`, dapp assembler.

### Bitcoin protocol-fee claim pool-id domain

Fee-enabled Bitcoin pools are keyed in the reserve registry by a SHA-256 pool id, but the protocol-fee claim
re-derived a **keccak** id and compared it against that SHA-256 key. The comparison could never match, so every
fee-enabled pool's claim reverted permanently while its crystallized virtual shares kept diluting LPs — fees were
accruable but unclaimable. The claim now re-derives the canonical SHA-256 id with the claimer as candidate
recipient over the pool's stored identity, so a match proves recipient identity; the pool capability byte is
carried in the reserve registry in lockstep across the guest, the serializer, and the assembler. A real
`POOL_INIT`→claim test replaces the previous synthetic-insert one. Resume-format change and reflection-fold
consensus change; rotates the reflection vkey on the held reprove. Files: `cxfer-core/src/lib.rs`,
`src/reflect.rs`, `reflect-stdin/src/lib.rs`, dapp assembler.

### cBTC escrow cure-clear (low)

A cured cBTC escrow retained its old grace timestamp, so a later, independent unhealthy episode could be enforced
immediately against the already-elapsed clock rather than a fresh grace window. Adds a permissionless
`clearEscrowFlagIfHealthy`, gated on an on-chain health re-check, so a genuine cure resets the grace clock; because
the clear requires present health, a dust top-up cannot abuse it to dodge a real liquidation. Contract-only; no
guest change. Files: `CollateralEngine.sol`.

### Storage-slot KAT correction (note)

The Rust known-answer test that pins the eth-reflection guest's `ConfidentialPool` storage slots still encoded the
pre-shift slots. It is recomputed to match the corrected slot constants from Round 3. The shell build gate
(`verify-storage-slots.sh`) already covered this class of drift; the Rust KAT is now consistent with it rather
than a second, stale source of truth. No behavior change beyond the test. Files: `cxfer-core/src/eth_reflection.rs`.

## Round 3 — audit-response round 3: eth-reflection storage-slot pins, solvent stability fee, inert-predecessor evidence (commit range `4bb77b11..15efe75e`)

This round answers a third review pass on top of the two below. Each item is an independent change; audit each on
its own. Finding labels (C-01, R-01…) are review-map handles here, not correctness claims. Nothing here is a claim
of correctness.

**Deploy-vkey note:** the vkeys in `pins/elf-vkey-pin.json` remain the **prior round's** and the reprove stays
**HELD pending this audit**. This round's storage-slot correction changes the eth-reflection guest's proven-field
set, so both the eth-reflection vkey and — because it folds the eth-reflection recursion digest — the reflection
vkey rotate on the held reprove (the settle `program_vkey` already rotated last round for the harvest one-shot).
Rebuild per `BUILD-AND-VALIDATE.md`; no new vkeys are invented in this bundle.

### eth-reflection stale storage-slot pins (Critical — was a real cross-lane double-spend)

The eth-reflection guest (`cxfer-core/src/eth_reflection.rs`) proves six `ConfidentialPool` fields —
`crossOutCommitment`, `bitcoinConsumed`, `bitcoinConsumedCount`, `bitcoinConsumedAt`, `crossOutCount`,
`crossOutAt` — via `eth_getProof` against hardcoded storage-slot indices. Two prior-round storage additions (a
`bool` placed ahead of ordinary state, and `harvestConsumed` placed ahead of the consumed-at log) shifted every
proven field by +1/+2, so the guest proved **stale** slots: the count anchors read a mapping's zero declaration
slot rather than the live counter. The consequence was not merely a liveness stall — the first real cross-out or
fast-lane consume would fail the contract's live-counter gate permanently **and** leave the consume un-reflected,
so a Bitcoin-homed note could be spent once on Ethereum and again on Bitcoin (a cross-lane double-spend).

Fixed: the slots are corrected to `77/120/121/165/171/172` (derived from `forge inspect` storage layout). The
durable defense is a new build gate, `contracts/sp1/confidential/verify-storage-slots.sh` (bundled at
`gates/verify-storage-slots.sh`), which fails closed on any future drift — it cross-checks the guest constants and
the test reader against the compiler's storage layout. The eth-reflection and reflection vkeys rotate in lockstep
on the held reprove (recursion digest). Files: `cxfer-core/src/eth_reflection.rs`,
`contracts/sp1/confidential/verify-storage-slots.sh`.

### cUSD stability fee made solvent (accrue-on-drip)

The stability fee was realized only at close (`_accrueFee(repaid − principal)`), so the fee cUSD a borrower must
burn to close never existed until a close created it — the last fee-bearing position could not close or be
liquidated, and its collateral stranded. The fix accrues the fee as interest compounds: the engine tracks
aggregate normalized debt (`normalizedDebtRay = Σ principal·RAY/snap`), and `drip` accrues the exact aggregate
delta (`normalizedDebtRay·Δrate/RAY`) into the fee budget and savers, so the fee cUSD is claimable and drawable
before any borrower repays. Close and liquidate retire the position's normalized debt and book only the
over-repay / ceil dust as surplus — the fee is already accrued, so there is no double count. The invariant
`feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd` is preserved, and the dormant path (fee off) is
byte-identical to the interest-free path. Contract-only; no guest change. Files: `CollateralEngine.sol`.

### Cross-generation inert-predecessor evidence (R-01)

The near-tip resume's cross-generation safety (see C-01 below) rests on an operational invariant: every superseded
pool holds no withdrawable escrow. This round adds `ops/verify-predecessor-inert.sh` (bundled at
`gates/verify-predecessor-inert.sh`) — a block-tagged, reproducible gate that checks every superseded pool's ETH
and underlying-token balances and fails closed above dust. Measured at the deploy block: the resumed pool holds
zero; the older, not-resumed pool holds only ~test dust. Run at the deploy block and publish the output hash.
Files: `ops/verify-predecessor-inert.sh`.

## Round 2 — audit-response round 2: genesis-only launch, harvest one-shot, savings surplus rounding, Mode-B anchor, test-slot re-derive (commit range `cf400b13..f1b85ec3`)

This round answers a second review pass on top of the previous one below. Each item is an independent change;
audit each on its own. Finding labels (C-01, H-01…) are review-map handles here, not correctness claims.

**Deploy-vkey note:** the vkeys in `pins/elf-vkey-pin.json` remain the **prior round's** and the reprove stays
**HELD pending this audit**. This round's harvest one-shot binds a new owner-signed action id into the settle
PublicValues, so the settle `program_vkey` rotates on the held reprove (in addition to the previous round's
rotations). Harvest is settle-only (not reflected), so the reflection serializer/assembler parity is unchanged by
it. Rebuild per `BUILD-AND-VALIDATE.md`; no new vkeys are invented in this bundle.

### C-01 — cross-generation double-spend (near-tip resume under the inert-predecessor invariant)

A generation that resumes a prior reflected state does not retire the predecessor on-chain: the predecessor
stays permissionlessly callable (immutable `settle`) with its own per-generation nullifier / consumed maps, so a
Bitcoin-homed note in the shared reflected state could be spent once through the predecessor and once through the
successor. The extractable value of that double-spend is whatever **withdrawable EVM escrow** the predecessor
still holds for the note's asset — the drain is empty against an inert predecessor.

This generation resumes via a **near-tip reflection seed** (`reflectionResumeDigest_`) so old etched assets
(e.g. TAC) stay bridgeable without replaying history — it is deliberately a multi-generation resume, NOT empty
genesis. An already-deployed predecessor is immutable and cannot be given a retirement hook, so C-01 is **not
closed by an on-chain gate**; cross-generation safety rests on a documented **operational invariant: every
superseded pool is inert (holds no withdrawable escrow)**. The seeded assets (TAC / bridged-Bitcoin) are
Bitcoin-homed — their backing lives in Bitcoin UTXOs under the shared spent-set, not as old-pool EVM escrow — so
there is no prior-pool escrow to drain. The load-bearing launch precondition (checklist, not code): verify every
superseded mainnet pool holds zero withdrawable EVM escrow and the seed carries no wrapped-ERC20/ETH position
backed by a still-live pool. Reviewers should scrutinise this invariant directly — it is the control standing in
for the absent on-chain retirement. It is verified on-chain, not just asserted: the directly-superseded pool
`0x…0f5DE1` (the resumed state) holds zero withdrawable escrow (0 ETH; 0 WETH/USDC/USDT/wstETH/cbBTC/tBTC/WBTC);
its own predecessor `0x…c5B537` (a generation further back, not resumed) holds only ~$32 of test dust. Maximum
lineage-wide C-01 extractable value is that dust; the resumed pool is empty. Re-checked at deploy time.

Enforced in code: the AUTHENTICATED non-empty-`predecessor_` migration path is disabled — the constructor
reverts `GenerationalMigrationDisabled` on a non-zero predecessor (it carried the same un-retired-predecessor
exposure with more surface and no added safety over the inert-pool invariant), forcing `PREDECESSOR=0` and
holding every proof to a zero rebase digest. On-chain generational retirement (for a future generation that
needs a live, funded migration) is designed in `ops/DESIGN-c01-generational-retirement.md`, not shipped here.
Files: `ConfidentialPool.sol` (constructor guard + `GenerationalMigrationDisabled`), `DeployV1SuiteCreateX.s.sol`.

### Farm / TSR harvest replay — one-shot action id

`OP_FARM_HARVEST` kept its receipt live and carried no on-chain one-shot or deadline; replay was blocked only by
the controller's reward-per-share re-stamp, which lapses once the reward window re-accrues — a copied proof could
then re-settle, re-paying the signed relay fee and consuming later yield into a duplicate leaf. The same
construction existed in `CollateralEngine` TSR savings. Fix: the guest binds a per-harvest action id
`evm_harvest_action_id = keccak(domain‖chain_binding‖controller‖receipt_leaf‖harvest_nonce‖reward_asset‖reward_be8‖fee_be8‖reward_leaf)`
over the owner-signed fields, surfaced as `bytes32[] harvestActionIds` appended **last** in the settle
PublicValues (preserving the router's field-22 `cdpMints` offset). `ConfidentialPool` spends one per harvest mint
(`positionLeaf==1 && debtValue>0`) before the controller callback via a `harvestConsumed` map plus a post-loop
cardinality check (`revert HarvestReplayed`). TSR savings is the same settle seam (controller bound in the id).
Harvest is settle-only (not reflected), so no assembler/serializer parity change. Rotates the settle
`program_vkey`. Files: `cxfer-core/lib.rs`, `main.rs`, `ConfidentialPool.sol`.

### Savings surplus rounding

`CollateralEngine` booked the fee surplus per-event via a floor while `outstandingSavingsReward()` is a single
aggregate floor; floor-of-sums overlap let a governance surplus draw eat saver entitlement. Fix: book surplus as
the exact change in aggregate `outstandingSavingsReward()`, and cap surplus draws by
`feeBudgetCusd − outstandingSavingsReward()`, so the fee-budget invariant holds exactly. Files:
`CollateralEngine.sol`.

### Synthetic Mode-B anchor

The `reflect-stdin` and dapp synthetic-Mode-B fallbacks pinned a testnet genesis sync-committee root while the
guest asserts the mainnet root at word 8, so a synthetic fixture aborted rather than exercising the fold. Both
fallbacks now use the mainnet anchor; the Mode-B and eth-message fixtures were regenerated. Files:
`reflect-stdin/lib.rs`, `dapp/confidential-pool.js`, fixtures.

### Test-harness storage slots (test-only, no production impact)

The direct-slot test reader (`PoolStateReader.sol`) hardcoded `ConfidentialPool` storage slots; this round's
storage additions shifted the layout, so the reader returned neighbouring slots and the pool fuzz invariants read
garbage. The 11 slots were re-derived. This is **test** code (reads via `vm.load`), not part of the immutable
surface — noted only so a reviewer running the suite is not surprised.

## Previous round — audit-response: cross-generation binding, authenticated resume, fee surplus, ETH→Bitcoin messages (commit range `c984b8f2..cf400b13`)

This round answers a review pass. Each item below is an independent change; audit each on its own. Finding
labels (C-01, H-02, H-03) are review-map handles here, not correctness claims. Sub-ranges: the C-01 burn work
lands `f2bf4be0..4781501e`; H-02 authenticated resume `d697b73e..5914e249`; H-03 fee surplus `37d7d1c1..eda53654`;
the ETH→Bitcoin message feature `993acefd`; the serializer + assembler + sentinel fixes `40400203..48210b69`.

**Deploy-vkey note:** the vkeys in `pins/elf-vkey-pin.json` are the **prior round's**. The reprove that folds
this round's guest changes (C-01 burn envelope, `OP_SURPLUS_DRAW`, H-02 resume, the `0x69` eth-call fold) is
**HELD pending this audit** — the settle `program_vkey` and reflection `bitcoin_relay_vkey` both rotate on that
reprove. The pinned values are left in place for reference only; rebuild per `BUILD-AND-VALIDATE.md` to derive
the vkeys the deployed pool must match. No new vkeys are invented in this bundle.

### C-01 — cross-generation burn replay

The confidential bridge-burn envelope grew from 129 to 161 bytes: a `target_chain_binding` is now folded into
the `bridge_burn_id`, and the one-mint gate is keyed on that `bridge_burn_id` rather than the bare nullifier.
The settle guest reconstructs the burn-id with its own `CHAIN_BINDING`, so a burn envelope that targets a
predecessor generation reconstructs a **non-member** id in a successor and cannot replay across generations.
The one-mint-per-nullifier regression guard and the router-offset-safe struct append are part of the same change.
Files: `cxfer-core/lib.rs`, `main.rs`, `ConfidentialPool.sol`.

### H-02 — authenticated generational resume

A new `rebasedFromDigest` public value carries the digest a resuming generation rebases from. The guest asserts
an in-guest drain of the predecessor before rebasing; the pool constructor gains a `predecessor_` parameter and a
one-shot migration-attest gate. Both replay roots are preserved across the rebase — only the generation-local
counters and `eth_refl_digest` reset. **Dormant at this launch** (the predecessor is empty). See
`ops/DESIGN-h02-authenticated-resume.md`. Files: `reflect.rs`, `cxfer-core/lib.rs`, `ConfidentialPool.sol`.

### H-03 — cUSD stability-fee surplus

The engine now tracks `surplusFeeCusd` across four fee-leak capture points, maintaining the invariant
`feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd`, so every realized fee cUSD is accounted for and
re-mintable. A **dormant** dedicated settle op `OP_SURPLUS_DRAW` (position-leaf sentinel `bytes32(2)`) mints the
accumulated surplus as a governance-authorized cUSD note. Files: `CollateralEngine.sol`, `main.rs`.

### ETH→Bitcoin authenticated messages (EthCallOutbox + `T_ETH_CALL` 0x69)

A new `EthCallOutbox.sol` contract records ETH-side message ids. The reflection fold records each `msg_id` in a
**one-shot honored-message set**, gated on eth-reflection set membership. The outbox is pinned by address in the
guests and is **fail-closed until the CREATE3 salt is mined** (no honored id can be produced against an
unpinned outbox). Reflect-exec DIGEST_MATCH fixtures for the fold live at `ops/box-artifacts/ethcall-fixtures/`.
Files: `EthCallOutbox.sol`, `reflect.rs`, `cxfer-core/eth_reflection.rs`, `cxfer-core/lib.rs`,
`reflect-stdin/lib.rs`, `confidential-pool.js`.

### Reflection serializer — 14-word fix

The eth-message fields grew `EthReflectionPublicValues` from 11 to 14 words in the guest, but `reflect-stdin`
was still serializing 11 words — which would abort every Mode-B proof at the read boundary. `reflect-stdin`
now serializes the full 14 words. File: `reflect-stdin/lib.rs`.

### Assembler routing fix + fail-loud guard

The reflection scan whitelist omitted the `eth_call`, `lp_bond`, and `lp_unbond` folds: with `env=null` the
guest would read a witness the assembler never emitted, desyncing the witness stream into a permanent halt. All
three are now routed, and a fail-loud guard surfaces any future unrouted-but-classified envelope as unsupported
rather than silently desyncing. `confidential-reflection-scan-indexer.js` is added to this bundle for the round
(it decides which folds the guest reads witnesses for and is therefore consensus-critical). Files:
`confidential-reflection-scan-indexer.js`, `confidential-pool.js`.

### Uniform positionLeaf sentinel

CDP top-up now rejects `newPositionLeaf <= 2` to match `cdpMint`'s reserved-sentinel range, closing an
asymmetry where the top-up path admitted a leaf value the mint path reserved. File: `ConfidentialPool.sol`.

## Prior round — Bitcoin-AMM execute-mode validation (commit range `1bb472eb..c984b8f2`)

This round ran the Bitcoin-AMM reflection folds end-to-end for the first time under the local execute-mode
validator (`reflect-exec` → `DIGEST_MATCH`) — the paths flagged in the prior round as "never executed
end-to-end." Running them surfaced one serializer bug, two immutable-guest edge-case bugs, and a set of
assembler↔guest mirror gaps. All are fixed in this source. The C-01 Bitcoin-AMM redesign these validate is
summarized below (current-price clearing + refund floor + `fee_bps` registry). Audit each independently.

### The C-01 Bitcoin-AMM redesign (current-price clearing + refund floor)

The Bitcoin-AMM reflection folds no longer pay out a trader's *declared* output; they clear each intent against
the pool's **current reserves** at fold time and pay a **refund floor** when the trade cannot clear as
requested. Applied across `T_SWAP_VAR`, `T_SWAP_ROUTE` (per hop), `T_SWAP_BATCH`, and LP add/remove:

- **swap-var / route** clear at the current price with a refund floor; a whole-input swap carries an all-zero
  **change sentinel** (no change note). LP add/remove pay from current pool state, not declared values.
- **Expiry → refund.** An expired or stale intent is **refunded** (a bound refund note at a fixed vout), never
  silently skipped; all folds reject `expiry_height == 0`.
- **`fee_bps` registry / resume-format change.** The pool's LP swap-fee tier is now stored in the reserve
  registry (a resume-format / consensus change; `1bb472eb`), so the fold reads the live fee rather than a
  declared one.
- **H-01 note-spend destination binding.** CXFER/AXFER + LP add/remove output destinations are bound in-guest
  (sighash enforcement on the confirmed tx), closing the settler-redirect gap flagged in prior rounds.

### Two immutable-guest bugs (found by execute-mode; both cause a reflection halt)

- **`compress()` panicked on the identity point (`91a62acc`).** The identity (point at infinity) SEC1-encodes
  to a single `0x00` byte, so `compress()` panicked copying it into `[u8; 33]`. A no-change swap-var carries the
  all-zero change sentinel, which decompresses to the identity; `verify_range` appends each commitment to its
  transcript via `compress()`, so verifying the sentinel's value-0 range proof aborted the guest — a reflection
  halt on a **canonical op**. The identity now maps to the all-zero 33-byte sentinel (the inverse of
  `decompress`'s identity fallback).
- **Redundant sentinel range-proof check (`9c8fbd94`).** `fold_swap_var` verified an `m=1` BP+ proof over the
  sentinel's identity/value-0 commitment unconditionally. A sentinel carries no change note, so there is nothing
  to range-prove — the same condition that already suppresses the change-SPK binding. Only a real change note
  now runs the range check, removing the identity-point edge case entirely. (The two fixes are complementary:
  the first makes the identity encodable, the second stops the guest from ever range-proving it.)

### reflect-stdin serializer bug (affects both the local validator and the box recursion prover)

- **Live-entry `auth_key` was not serialized (`c34226b3`).** Since the leaf-based-nullifier change the guest
  reads four fields per live entry (outpoint, commitment_hash, asset_id, `auth_key`) and the digest commits all
  four, but the shared stdin serializer wrote only three. Every fixture to date carried an empty live set, so
  the omission never desynced; a batch with a live note (the AMM swap/LP path) desyncs the stream by 32 bytes
  per entry. The serializer now writes `auth_key`.

### Assembler ↔ guest mirror gaps (the consensus-critical off-chain fold)

The reflection assembler (`dapp/confidential-pool.js` + `confidential-swapbatch.js` + `burn-deposit-bitcoin.js`)
must apply the exact accept/skip verdict the guest applies; a gate the guest enforces but the assembler skips
diverges the digest chain and halts reflection at the first divergent tx. Execute-mode surfaced four such gaps,
now closed (fixtures re-signed so a real intent_sig / BP+ proof rides the txid-excluded witness; digests
unchanged):

- **swap-var / route per-intent `intent_sig` (`4cf961b1`).** The guest reconstructs the trader's BIP-340 intent
  message and skips the fold on a bad signature; the assembler onboarded regardless. Added
  `swapVarIntentMsg` / `swapRouteIntentMsg` (byte-matched to the guest KATs) and the skip-on-failure check.
- **swap-batch per-intent `intent_sig` (`44b424e4`).** Same gap in `fold_swap_batch` (per-intent sig binds the
  matched spend, `c_in` secp+bjj cross-curve, receipt/refund destinations, min-out, tip, expiry). Added
  `swapBatchIntentMsg` and per-intent verification in the reordered auth loop.
- **swap-var change range proof + remaining gate parity (`0ffa82ae`, then `fac8857c`).** The guest range-checks
  a real change commitment; the assembler skipped it. Added `bppRangeVerify` over the decompressed change
  (`bppZero` for the sentinel), plus the swap-var/route in-reserve-overflow and direction guards and the
  swap-batch per-intent input cross-curve check. A follow-up (`fac8857c`) then made the assembler skip the range
  check for the no-change sentinel too, mirroring the guest fix above — otherwise a no-change swap with a
  bad/absent proof would onboard in the guest but fail in the assembler, re-diverging the digest.

**Residual:** the box `MODE=execute` recursion-prover vectors (as opposed to the local validator) remain the
final validation before reprove; they are out of source scope.

## Prior round — reflection-halt + admin disclosure

- **C-01 (was Critical) — permissionless reflection halt.** A reflected-note bridge-burn whose `0x2B` envelope
  declared an asset different from the actually-spent note tripped an `assert!` in the guest. The envelope asset
  is attacker-controlled and the tx sits in a canonical block, so every honest prover panicked on it and forward
  reflection halted permanently — a cheap, permissionless liveness kill. The mismatch now SKIPS the burn record
  (the note stays nullified; no bridge-out minted; no burn witness consumed), matching the skip-not-abort
  discipline the other folds use. A full sweep confirmed this was the ONLY unguarded tx-controlled abort in the
  reflection path — every other op fold already guards tx-content as a skip before its `expect`.
- **H-02 (High, trust-model) — CollateralEngine is DAO-governed, not adminless.** Its owner can set feeds/params
  and drive cBTC-escrow enforcement + insurance-reserve draws. The DAO role is retained (intentional), but the
  seizure power is capped by an immutable `MIN_ESCROW_GRACE_WINDOW` (3 days): enforcement cannot be armed with,
  or executed before, a shorter delay, so a locker always has a public, non-instant window to redeem out. The
  "no admin" claim is corrected throughout: the pool + guests are immutable; the CollateralEngine is a
  trusted-but-privileged (expected timelock/multisig) policy contract.
- **H-01 (High, sighash-dependent)** — unchanged from the prior round: CXFER/AXFER + LP add/remove destinations
  are Bitcoin-consensus-bound under the emitters' live SIGHASH_ALL; in-guest sighash enforcement remains a
  flagged reprove-cycle hardening.

## Prior round — farm/LP-bond authorization

A full-surface pass found (and this source fixes) a coordinator-assisted theft in the Bitcoin farm ops, plus a
deploy-wiring hazard. Audit these independently.

- **C-01 (was Critical) — discarded farm/LP-bond authorization signatures.** `T_FARM_INIT` and `T_LP_BOND`
  verified only their conservation kernel (funding) and *discarded* the trailing `launcher_sig` / `bonder_sig`,
  while registering the treasury / receipt from coordinator-supplied identity fields the kernel does not bind.
  A coordinator could reuse a victim's valid funding kernel under an attacker launcher key (or redirect the
  bonded LP receipt's ownership) and later drain it. Both folds now BIP-340-verify the authorization signature
  in-guest: `farm_init_msg` binds farm_id (⇒ pool/launcher/asset/nonce) + campaign terms; `lp_bond_msg` binds
  farm/bonder/amount/entry/view-height AND the receipt `owner_commit`+`nonce` (the emitter's own message did
  not bind ownership). Byte-identical to the worker/dapp signer, KAT-pinned in cxfer-core.
- **Sweep (clean).** Every other value-bearing op verifies its authorization in-guest — farm refund
  (`launcher_sig`, also matched to the farm's stored launcher), harvest/unbond (`owner_sig`), cmint
  (`issuer_sig`), adaptor (`claim_sig`), stealth-claim, BtcCall. The discarded-signature defect was confined to
  init/bond.
- **H-01 (High, sighash-dependent) — CXFER/AXFER + LP add/remove destination binding.** These fold the output
  destination auth from the confirmed tx without binding it in the signed kernel. Under the emitters' live
  SIGHASH_ALL policy the destinations are Bitcoin-consensus-bound on the confirmed tx (so not an active theft),
  but the guest does not itself enforce the sighash — a defense-in-depth gap to close by verifying the input
  sighash flag in-guest (a careful change, since CXFER's kernel is live + shared). Flagged; not yet in-guest.
- **M-01 (Medium) — engine/pool reciprocal binding.** `CollateralEngine.setPool` now requires the pool to
  point back to this engine, so the owner cannot wire the engine to a different pool than the one that
  immutably committed to it.

## Prior round — reflection + Bitcoin-AMM hardening

Focused adversarial review of the reflection guest and the Bitcoin-AMM reflection folds. Audit these
independently and hard — several were real fund-loss defects, and the Bitcoin-AMM folds (`T_SWAP_VAR`/
`T_SWAP_ROUTE`/`T_SWAP_BATCH`) are onboarding paths that had never run end-to-end.

- **C-01 (was Critical) — scan-free burn censorship.** The burn-deposit consumed-outpoints gate treated a
  *prover-supplied* non-membership witness failure as a silent skip, so a permissionless prover could feed a
  bad path for a genuinely-absent outpoint, drop an otherwise-valid burn, and permanently strand the burner's
  principal once the digest advanced. The gate now proves an explicit presence verdict (member → skip;
  non-member → fold; lying/malformed witness → ABORT), mirroring `fold_crossout`.
- **H-01 — Bitcoin-AMM trader authorization.** The reflection folds verified aggregate conservation but not
  the trader's per-intent authorization. They now reconstruct the trader's BIP-340 intent message (byte-exact
  to the worker/dapp, pinned by KATs run against the *real* emitter functions) and enforce it: destination
  script, min-out, tip, direction, expiry, the exact spent input, and — for `T_SWAP_BATCH` — the input
  cross-curve binding. A coordinator can no longer redirect a receipt, relabel/re-price a trade, replay an
  expired intent, or substitute `c_in_bjj` while aggregate conservation holds.
- **Receipts must be P2TR (spendable auth) + bind the real script.** A reflected note's spend authority is the
  output's x-only Taproot key; a non-P2TR receipt yields a zero-auth, unspendable note. The folds now bind the
  receipt/change scriptPubKey **verbatim from the confirmed tx** (never reconstruct an assumed shape) and fail
  closed on a zero auth key. Fail = skip (the input is nullified in the general scan before the fold, so a
  malformed swap self-strands its initiator rather than aborting/halting reflection).
- **VAR change destination + zero-expiry.** The var change note's destination is now bound in its intent
  (previously only its commitment was), closing a settler-redirect of the taker's change. All three folds
  reject `expiry_height == 0` (emitters had defaulted it, which the guest reads as expired → strand; a stated
  deadline also prevents settler replay).

A per-op destination/auth binding matrix (VAR/ROUTE/BATCH) is green; the residual is that the folds have never
executed end-to-end — the box `MODE=execute` vectors are the remaining validation (out of source scope).

## Prior round — cross-lane / latent / hardening

Two independent review passes on an earlier bundle raised the items below; all are remediated in this source.
None was an exploitable inflation/theft/double-spend at the time — they were latent, cross-lane, or hardening.
(The consumed-outpoints gate below is what the C-01 fix above later corrected to fail *closed*.)

- **Cross-lane double-mint gate (consumed outpoints).** The fast-lane retirement removed a spent Bitcoin
  outpoint from the live UTXO set before the scan-free burn-deposit path checked it, and the Bitcoin-homed vs
  native nullifier domains are disjoint for the same commitment — so a single UTXO could be retired on the
  fast lane and *also* onboarded through burn-deposit. The reflection scan now folds every retired outpoint
  into a dedicated IMT (`consumed_outpoints_root`/count, committed in `digest()`); burn-deposit proves
  **non-membership** against it. Guest read order, box serializer, and the reflection genesis digest are
  updated in lockstep; a regression test pins the double-mint block.
- **Stealth-lock input spend authority.** `OP_STEALTH_LOCK` proved input authority via the aggregate kernel
  only, which proves knowledge of the *excess* blinding, not the input note's own blinding — a k-offset
  construction could lock another holder's note (freeze). The op now additionally requires a per-input
  `verify_opening_pok_blind` over the input commitment (knowledge of its own blinding) before spending it.
- **Relay genesis-boundary anchor.** A `genesis()` anchor placed exactly on an epoch boundary produced a
  zero elapsed-time window and bricked the first retarget. The genesis range now rejects the boundary height;
  the near-genesis median-time-past baseline is documented.
- **Range-proof scalar canonicality.** The classic Bulletproofs path parsed response scalars by reducing
  mod n while the BP+ path rejected non-canonical encodings — a proof-malleability inconsistency across two
  equally load-bearing verifiers. The classic path now rejects non-canonical (`>= n`) encodings, matching BP+.
- **Provenance allowlist hardening.** The burn-deposit provenance walk admits only the CXFER/AXFER opcode
  allowlist (all ciphertext-opening). Two sibling allowlists in the same file — one of which admits a
  publicly-recomputable fee-claim opening — are now marked NOT-PROVENANCE-ELIGIBLE, and the design note that
  guards the invariant is corrected to cite the right function.

## Findings from the prior round — applied

- **Farm receipt accounting (was H-01, "future-checkpoint farm-budget freeze").** The stopgap exact-live
  `rps_entry` check has been **replaced** by an accumulator-per-share, execution-stamped entry: the controller
  (`FarmController`, ETH lane) and the reflection fold (BTC lane) stamp `entryRps` onto a **stable receipt
  leaf** at settle. `farm_receipt_leaf` dropped the checkpoint (v3, a stable position id); harvest bounds
  against the stamp and re-stamps in place (a replay pays 0), no consume-and-remint; unbond retires the stamped
  debt exactly and deletes the stamp. `recover`/`notify` reserve the exact
  `(rps·totalShares − totalRewardDebt)/PRECISION`. This structurally eliminates the freeze (entries can no
  longer be future-dated) and, as a side effect, makes farms **stake-anytime**. Mirrored for the cUSD savings
  (TSR) receipts in `CollateralEngine`. **Two implementation notes for reviewers** (see also the farm design):
  - `rateSnapshot` is **overloaded** — the CDP debt accumulator for CDP ops, the **receipt leaf** for
    farm/savings RECEIPT ops (inert in its CDP meaning there). Commented at each site.
  - The controller keys `entryRps` on the guest-supplied receipt leaf (via proof-committed `rateSnapshot`)
    without a pool-side re-derivation: the guest binds it to the receipt it proved membership + owner-signature
    over, so a valid proof already guarantees it is the authorized position. This trades a small amount of
    contract-independence defense-in-depth for zero pool-bytecode cost — **confirm the guest binding.**
- **Native-ETH delivery (was L-01).** `ExitExecutor._sweep` and `CollateralEngine.claimEscrow` use
  `forceSafeTransferETH`, so a non-payable bound recipient can no longer strand ETH.
- **`exitAndExecute` fee-delta (was F-1).** The router now binds every `PublicValues.withdrawals` recipient to
  the recipe escrow before settling, so a settle can only credit the router with its fee leg.
- **btcHomed consume (was F-2).** The pool records the Bitcoin consume for **any** btcHomed spend, not only
  value-bearing ones, so a source is always retired.
- **Nullifier definition (spec/code reconciliation, was B-4).** `ν = keccak(note_leaf ‖ "spent")` over the
  full authenticated leaf is now stated once and the design docs are reconciled to it (see
  `DESIGN-unified-source-identity.md` / `DESIGN-btc-note-authority.md`).
- **In-guest Groth16 verifier (was B-2).** The baked ceremony `batch_vk` now has a committed test vector
  (`fixtures/swapbatch_ceremony_vector.bin`) proving it verifies a **real finalized-ceremony** proof, plus
  tampered-public and G2-limb-swap negatives. `OP_SWAP_BLIND` and the `T_SWAP_BATCH` fold remain **dormant**;
  `groth16.rs` documents the activation gate. (A stake-anytime-farm-style follow-up may arm OP_SWAP_BLIND; it
  is not armed here.)

## Bitcoin light relay — now IN scope, and rewritten (was COV-01 + a new finding)

`BitcoinLightRelay.sol` was absent from the prior bundle; it is now included, and its fork choice was
rewritten in response to a reorg finding:

- **Per-branch retarget (R-1).** The relay previously stored one global `epochTarget[epoch]` and barred any
  non-tip branch from crossing a 2016-block boundary — so a reorg of a boundary-height tip permanently pinned
  the tip to the orphan (a permanent Bitcoin-lane freeze). It now stores the difficulty target **per block**
  (`blockTarget`): each block inherits its parent's target within an epoch and derives a fresh one at each
  boundary crossing from its own branch, and the boundary bar is removed. A boundary reorg is now an ordinary
  heaviest-chain reorg. Validated against the real mainnet 471→472 boundary and fork-choice isolation tests.
- **Reflection deep-reorg posture (R-2).** A reorg deeper than `REFLECTION_CONFIRMATIONS` halts reflection
  **fail-closed** by design — re-anchoring would resume onto already-paid-out orphaned bridge mints (silent
  inflation), so the halt is the correct response. `REFLECTION_CONFIRMATIONS` defaults to 6 (above any
  post-2015 reorg). Documented at `ConfidentialPool` `lastReflectionBlockHash`.
- **Genesis timestamp (R-3).** `genesis(startTimestamp)` is a DEPLOY-CRITICAL trusted input (a 1-second error
  bricks the first retarget); documented as a deploy-checklist item (derive from the real first-block header,
  cross-check two explorers).

## Router entrypoints

The public swap entrypoints were merged (`swapPublicExactIn` / `swapPublicExactOut`) to fit EIP-170 with all
features retained (exact-in, exact-out, ETH via `tokenIn == address(0)`, Permit2, EIP-2612). `ConfidentialPool`
and `ConfidentialRouter` deployed sizes are 24,484 B (+92) and 24,547 B (+29) under the 24,576 B limit.

## Standing (unchanged from the ground rules)

Bytecode/vkey reproducibility and the guest↔dapp mirror are a separate build/reprove step. The farm redesign
and the ν-leaf change rotate the settle **and** reflection ELF/vkeys and the reflection genesis digest; the
pinned artifacts under `pins/` and the fixtures are regenerated in that step, so the source here may be ahead
of any currently-deployed instance. Review the **source**; treat the pinned vkey/bytecode as informational.
