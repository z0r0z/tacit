# Maintainer response — GPT greenlight audit, round 9 (bundle @ `8170004` / code @ `817000400fa4`)

Ninth pre-reprove pass — a holistic production-readiness sweep with Bitcoin-consensus × reflection-liveness
as the priority vein. **No fund-critical finding** (no permanent forward-stall, double-spend, inflation,
authorization-bypass, relay-fee theft, or conservation break). One Medium mode-boundary defect + four
defensive/canonicality items, all addressed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| Q-01 | Plain-vault `FarmController` (receiptMode=false) still accepted receipt bond/harvest ops | Medium | **Real** | **Fixed** |
| Q-02 | 64-byte CVE-2017 invariant should be locked in tests | Low | **Already safe** | **Test/doc** |
| Q-03 | Taproot envelope parser missing `OP_PUSHDATA4` | Low | **Real** | **Fixed** |
| Q-04 | LP envelope parsers accepted trailing bytes (non-canonical) | Low | **Real** | **Fixed** |
| Q-05 | Relay can't follow a heavier fork crossing a retarget boundary from a non-tip branch | Low/operational | **Real** | **Accepted + documented** |

## Q-01 — Plain-vault receipt-op gate — FIXED

`FarmController.onCdpMint` gated bare bonds in `RECEIPT_MODE` (to stop bare weight diluting receipt holders'
rps) but never gated the inverse: a `receiptMode=false` plain-vault controller still entered the receipt
(positionLeaf==1) branch, so a receipt bond/harvest could drive rps/reward accounting on a controller meant
only for bare position locks. **Fixed** with the mirror gate `if (!RECEIPT_MODE) revert NotSupported();` at
the top of the receipt branch. **V1-safe:** every V1 farm deploys `receiptMode=true` (`DeployV1Suite`,
`SeedV1Pools`, `DeployFarmController` default), so no deployed reward farm is affected; the gate is
defense-in-depth for the immutable contract against a misconfigured/future false-mode controller. The
FarmController test suite was realigned to the real deploy config (receipt ops on a `receiptMode=true` farm,
bare bonds on a `receiptMode=false` vault) + a new `test_plain_vault_rejects_receipt_ops`. Forge full suite
752/0.

## Q-03 — `OP_PUSHDATA4` in the Taproot envelope parser — FIXED

The envelope extractor supported direct pushes, `OP_PUSHDATA1`, and `OP_PUSHDATA2` but not `OP_PUSHDATA4`,
which is consensus-valid in a Taproot script. A user could create a consensus-valid Tacit reveal encoded with
`OP_PUSHDATA4` that reflection would silently ignore (returning the action's semantics dead-on-arrival).
**Fixed** by implementing `OP_PUSHDATA4` (4-byte LE length, `checked_add` bounds) in `extract_taproot_envelope`,
mirrored in the JS attester, with a new extraction KAT.

## Q-04 — LP envelope canonicality (exact length) — FIXED

`parse_lp_add_envelope` v0 required only `len >= TAIL` and v1 didn't require the walked tail to consume the
envelope; `parse_lp_remove_envelope` read `proof_len` but didn't bind the total length — so two byte-distinct
Bitcoin txs could decode to the same LP action (a guest↔JS/indexer determinism + canonical-wire risk; no
conservation break, since kernels/sigs bind the semantic fields). **Fixed** by enforcing exact lengths: LP_ADD
v0 `== TAIL`, v1 tail `p == env.len()`, LP_REMOVE `== R_OFF + 66 + proof_len` — guest + JS mirror, with
trailing-byte rejection tests.

## Q-02 — 64-byte CVE invariant — already safe, locked in tests

No fund path. The round-8 fix admits well-formed 64-byte legacy txs and rejects the merge blob; for any
Tacit-relevant spend/envelope (Taproot/SegWit), the independent BIP-141 witness-commitment check is what makes
hiding impossible (swapping leaves changes the wtxid tree → the commitment fails). The invariant is exercised
by the round-8 disambiguation test + the witness-commitment tests; the comment now states the soundness
argument (foreign-PoW blocks give the attacker no control over the substituted leaf).

## Q-05 — Deep-reorg-across-retarget relay limitation — accepted + documented

The relay does heaviest-chain fork choice within an epoch but ties the retarget transition to the current tip,
so it cannot adopt a heavier branch that forked before a retarget boundary and crosses it. This requires a
deep retarget-boundary reorg outside normal confirmation assumptions; it is the already-documented
catastrophic-reorg limitation (the genesis anchor + `REFLECTION_CONFIRMATIONS` finality depth are the
operational mitigations, with a monitored redeploy path). No code change to the immutable contract.

## Net
Q-01 (the Medium mode-boundary), Q-03, and Q-04 are closed; Q-02/Q-05 are confirmed-safe/accepted. Forge
752/0; cxfer-core 153/153 (incl. the new PUSHDATA4 + LP-trailing-byte tests); the reflection DIGEST_MATCH gate
is green (only the ceremony-zkey `swapbatch` regenerates on the box). Surface is greenlight-ready for the
re-prove.
