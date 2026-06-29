# Maintainer response — GPT greenlight audit, round 18 (bundle @ `fc96f7d`)

Eighteenth pass. Three fund-impacting findings (2 Critical, 1 High), all in the prover-supplied-witness
censorship class. One is a direct regression of round 17 and is **fixed**; the other two are deep,
soundness-critical reworks that are **contained for V1** + designed for the feature-enablement gen.

| ID | Title | Severity | Verdict | Disposition |
|----|-------|----------|---------|-------------|
| F-01 | Duplicate cross-out claimIds brick all future attestations | Critical (forward-stall) | **Real (round-17 regression)** | **Fixed** |
| F-02 | A bad cross-out membership path skips a confirmed 0x65 mint | High (retryable censor) | **Real** | **Contained (Mode-B off) + designed** |
| F-03 | A bad burn-deposit provenance witness skips a real burn | Critical (permanent lock) | **Real** | **Contained + designed** |

## F-01 — duplicate-claimId attestation brick — FIXED

My round-17 enumerable cross-out log assumed claimId uniqueness, and for codesize I removed the
`crossOutCommitment[claimId] == 0` write guard "because claimId binds a spent-once ν." The auditor found the
hole: a single `OP_BRIDGE_BURN` with two **identical destination commitments** emits two `CrossOut`s with the
same (destChain, destCommitment, ν, asset) → the **same claimId** → the contract records `crossOutAt` twice +
increments `crossOutCount` twice. The eth-reflection guest then can't produce a valid proof (duplicate-claimId
assert vs the exact-count completeness gate are mutually unsatisfiable), and the attest `r.crossOutCount ==
crossOutCount` gate blocks every future attestation → a user-triggerable permanent brick.

**Fixed** at the source: the settle guest now asserts the bridge-burn's destination commitments are **distinct**
before emitting any `CrossOut` (`contracts/sp1/confidential/src/main.rs`), so the contract never records a
duplicate claimId. Within the SP1 trust model (the settle guest is vkey-pinned) this guarantees the cross-out
log stays unique; no contract bytecode added (the pool stays at 24,566 / +10). Committed `a2f17b8`.

## F-02 + F-03 — the prover-supplied-witness censorship class

Both share one shape: a confirmed Bitcoin op folds **only if the prover supplies a valid witness** (cross-out
membership path / burn-deposit provenance DAG), and a bad witness makes the op `skip` — the forward-only digest
advances past it → censorship. F-02 leaves the claimId unconsumed (retryable reissue, dust loss); **F-03's burn
is already spent on Bitcoin → permanent loss** (Critical). `attestBitcoinStateProven` is permissionless, so a
griefer running a box can do this — it is not merely a trust assumption.

The robust fixes are structural and soundness-critical (they touch the Mode-B recursion accumulator and the
burn-deposit onboarding protocol), and each is a round-17-scale change with its own re-prove. Given that every
large change this session has surfaced the next round's finding (F-01 being a round-17 regression), forcing both
through at once is how the next Critical gets manufactured. So for V1 they are **contained**, with the full
hardenings designed + queued for the gen that enables the affected (currently §A-gated / not-day-1) features.

### F-02 — contained: Mode-B off for V1; designed: cross-out key-value IMT
The cross-out fold is only reachable under **Mode-B** (`mode_b != 0`, a verified eth-reflection recursion).
Mode-B (ETH→BTC reverse bridge) is **not a day-1 feature** ([[project_modeb_day1_gap]]) — V1 deploys with it
disabled (the forward-only onboarding path uses `mode_b == 0`, under which `crossOutSetRoot` is the zero
sentinel and no 0x65 folds). With Mode-B off, F-02 is unreachable.
**Hardening (ships when Mode-B is enabled):** replace the cross-out set's keccak append-tree with a
**claimId-keyed key-value IMT** (`claimId → destCommitment`), reusing `utxo_insert_transition` /
`utxo_membership` / `imt_non_membership`. `fold_crossout` then requires, per 0x65, either membership (→ fold)
or a non-membership straddle proof (→ skip a fake) — a prover can no longer fake "non-member" for a real member.
Mode-B is not yet live, so the eth-reflection genesis set-root (`utxo_empty`) + `eth_refl_genesis_digest` change
freely. Touch points: `eth_reflection.rs` (IMT leaf/member/non-member), the eth-reflection guest crossout loop
(`utxo_insert_transition`, `CrossOutWitness` insert fields), `fold_crossout` + the reflection dispatcher
(member flag + witness), the JS eth-reflection consumer + `foldCrossout`, the crossout fixture, re-prove.

### F-03 — contained + designed: tx-bound provenance
The burn-deposit provenance is a full CXFER **DAG** (up to 1024 txs, each BIP-141-authenticated) supplied
discretionarily by the prover; a bad DAG → the real (already-burned) note is skipped → permanent loss.
**Hardening:** bind a canonical **provenance-DAG digest** into the burn-deposit tx envelope (txid/wtxid
authenticated). The guest re-hashes the supplied DAG and `abort`s on a mismatch for a committed burn (a prover
withholding the committed provenance), while a fake burn commits its own bogus DAG → fails verification → skips
(no fake-burn stall). Touch points: a 32-byte `provenanceCommitment` envelope field + parser
(`cxfer-core/bitcoin.rs`), the dapp burn-deposit builder (compute the canonical digest), the guest
provenance read + abort-on-mismatch, every burn-deposit fixture, re-prove. This is a coherent protocol change
(cannot be partial) and the byte-exact dapp↔guest DAG-digest is precisely the soundness detail not to rush — it
warrants its own focused, fully-verified pass. For V1, burn-deposit onboarding ([[project_bridge_asset_onboarding]],
known HOLE A) is gated off until this lands.

## Verification (F-01)
cxfer-core 154/154; the settle guest builds; the pool stays at 24,566 / +10 under EIP-170 (no bytecode added).
The reflection DIGEST gate + forge suite are unaffected by the settle-guest assert (it rejects only the
malformed dup-dest op, which no fixture contains).

## Net
F-01 (the user-triggerable Critical brick) is closed. F-02 + F-03 are contained for V1 by gating the affected
not-day-1 lanes (Mode-B cross-out; burn-deposit onboarding), with complete, locked hardening designs for the
gen that enables them. The repeated-regression pattern is the explicit reason the two soundness reworks are
sequenced as focused passes rather than crammed here. A further confirmatory round on the F-01-fixed commit —
and a dedicated audited implementation of each hardening as its lane is enabled — is the path to lock.
