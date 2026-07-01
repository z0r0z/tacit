# Maintainer response — GPT greenlight audit, round 8 (bundle @ `8c066af`)

Eighth pre-reprove pass. The relayer/relay-fee threat model came back clean (the auditor independently
confirmed our full fee-binding sweep: no fee-inflation / payout-redirection break on any op). One Critical
cross-chain liveness bug and one Medium authorization-expiry bug, both fixed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| C-01 | A consensus-valid 64-byte Bitcoin tx panics the reflection full-scan → permanent forward-chain stall | Critical (liveness) | **Real** | **Fixed** (adversarially reviewed) |
| M-01 | `OP_STEALTH_LOCK` deadline bound in proof but not surfaced to the contract → expired lock still settles | Medium | **Real** | **Fixed** |
| — | Relay-fee binding sweep: no new fee-inflation / payout-redirection break | Informational | **Confirmed** | — |

## C-01 — 64-byte-transaction reflection stall — FIXED

Confirmed and serious for an immutable deployment. `compute_txid` blanket-rejected any 64-byte non-witness
serialization (and any segwit tx whose witness-stripped form is 64 bytes) as a BIP-141 anti-merkle-collision
mitigation — a 64-byte blob can equal a merkle internal node `txid_L‖txid_R`, which a "merge" prover could
swap in for the real `[L,R]` subtree to hide a tx from the full-scan completeness check. But 64-byte txs are
only *nonstandard*, not consensus-invalid: a miner can mine one. Once the relay anchors past that block,
every honest reflection proof of the canonical block hits `None` and panics (`reflect.rs` full-scan
`.collect::<Option<_>>().expect(...)`) before the merkle check — a **permanent** stall of the whole
Bitcoin→Ethereum reflection lane (BTC nullifier freshness, burns, cBTC lock/redeem, reflected calls),
unfixable under an immutable vkey.

**Fixed** without weakening the anti-merge guarantee: a 64-byte blob is now admitted **iff it parses as a
complete, well-formed transaction** (`nonwitness_tx_exact_len`: `version‖in_count≥1‖inputs‖out_count≥1‖
outputs‖locktime`, consuming exactly 64 bytes). A genuine consensus-valid 64-byte tx flows (liveness
restored); the merge blob is still rejected (soundness). The key soundness argument: the merge only hides a
victim tx when reconstructing a block whose merkle root is fixed by **foreign** proof-of-work, where the
attacker has **zero** control over `txid_L/txid_R` — so the substituted leaf is ≈random bytes that parse only
by uncontrollable coincidence (~2⁻²⁸ per node, un-steerable). (A block the attacker mines himself he could
grind, but then there is no foreign tx to hide.) Mirrored byte-for-byte in the JS attester
(`nonwitnessTxExactLen`, incl. the segwit stripped-form-64 path). **Adversarially reviewed** (merge-grind
work, split/leaf-count games, liveness completeness over all consensus-valid 64-byte txs, parser
panic-safety, guest↔JS parity) — verdict SOUND. cxfer-core 152/152 incl. a new disambiguation test (a valid
64-byte tx is admitted; a non-parseable blob rejected); the reflection DIGEST_MATCH gate is green.

## M-01 — Expired `OP_STEALTH_LOCK` still settles — FIXED

`OP_STEALTH_LOCK` requires + binds a nonzero `deadline` in its opening-sigma context, but — unlike
`OP_ADAPTOR_LOCK` and `OP_STEALTH_CLAIM` — it never folded the deadline into `min_deadline`, so the public
value the contract's `_checkDeadline` enforces (`pv.deadline`) was never set for it. A hostile
relayer/delegated prover could hold a user-authorized stealth-lock witness past the intended expiry and settle
it anyway, nullifying the sender's note into a lock the recipient can no longer claim (a dead-on-arrival
payment; the sender can still refund, so not direct theft, but an authorization-expiry violation). **Fixed**
by folding the lock's deadline into `min_deadline` exactly as `OP_ADAPTOR_LOCK` does, so the contract reverts
an expired lock.

## Relay-fee sweep — confirmed clean
The auditor re-ran the delegated-prover threat model across the full settle opcode table and found no new
relayer ability to inflate a fee or redirect a payout — matching our own post-round-7 uniformity audit (every
fee-carrying op binds `fee` + the recipient into the user authorization, guest↔dapp byte-parity, strict
`fee < carried value`). Their suggested standing invariant — a per-opcode mutation matrix (mutate only fee /
recipient / owner / deadline and assert rejection) — is now partially realized by the hardened local exec
harnesses (they assert the guest exit code; a tampered liquidator is proven-rejected).

## Net
C-01 (the Critical liveness stall) and M-01 (the expiry bug) are closed; the relayer fee surface is
confirmed sound. cxfer-core 152/152; the reflection DIGEST_MATCH gate is green (only the ceremony-zkey
`swapbatch` regenerates on the box). Surface is greenlight-ready for the re-prove.
