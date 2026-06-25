# Tacit Finance — Cross-Chain Reflection & Bridging Path
## Security & Accounting Production-Readiness Audit (Bundle 2 of 2)

**Auditor model:** Claude Opus 4.8 (Anthropic)
**Audit date:** 2026-06-25
**Scope:** The cross-chain (Bitcoin ↔ Ethereum) trust path not covered by bundle 1 — the SP1 Bitcoin-consensus guest (`bitcoin.rs`), the burn→mint bridge (`burn_deposit.rs`), the inner Ethereum reflection guest (`eth_reflection_guest_main.rs`), and the box-assembled AMM batch path (`swap_batch.rs`, `groth16.rs`, `bjj.rs`, `babyjubjub.rs`), with bundle-1 files (`reflect.rs`, `eth_reflection.rs`, `sigma.rs`, `BitcoinLightRelay.sol`, `elf-vkey-pin.json`) re-read as context to trace the trust boundary. Per package `README.md`.
**Method:** Static adversarial review — full reads of all in-scope guests, witness-commitment and merkle-binding reconstruction, provenance-DAG reachability tracing, per-leg conservation tracing, and a computational check that the pinned BabyJubJub generators are genuine NUMS. `SP1VerifierGroth16`, `helios-consensus-core` 0.11.1 (Zellic-audited), and `sp1_helios_primitives::verify_storage_slot_proofs` (reused verbatim) treated as sound, per scope.
**Companion audits:** Cross-referenced and de-duplicated against bundle 1 (`TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_CLAUDE_OPUS_2026-06-25.md`) and the GPT-5.5 Pro audit (`…GPT55PRO_2026-06-24.md`). This bundle is a **distinct package** (`SHA-256 af33083a…9076`; see Attestation) — not byte-identical to bundle 1.

> **Finding-ID convention.** `H-01` is the single cross-audit release-blocker also tracked in bundle 1 and the GPT-5.5 audit; it is **refined** here. New findings from this cross-chain bundle are prefixed `X-` (X-01 … X-04) so they never collide with the identically-numbered bundle-1 items.

---

## Verdict

**Do not ship cross-chain V1 until the Ethereum reflection is re-anchored from Sepolia to mainnet (H-01) and the box-assembled batch path is validated end-to-end against real proof vectors on the SP1 box (X-01). The Bitcoin-data-authenticity and bridge-conservation layers are sound and ready.** After an exhaustive adversarial read I found **no new Critical or High exploitable single-component bug** in the cross-chain path. The headline concern — the BIP-141 witness-commitment binding that a prior internal review flagged for the "swap the witness, keep the txid valid → forge a burn envelope → inflate" class — is **present, sound, and wired into all three provenance paths with the witness checked *before* any envelope is parsed**; the round-trip test suite even ships explicit swapped-witness rejection tests. The burn→mint provenance DAG enforces one-time, reachable-from-real-supply, not-already-consumed spends with a reachability fixpoint that closes fabricated-cycle and value-rekeying attacks; the inner Ethereum reflection proves storage slots against the *finalized* execution state root, forces completeness via an on-chain consumed-count freshness anchor, and binds each cycle to the prior accumulator with a cross-cycle digest anchor; and the batch path's no-inflation rests on authoritative (non-witnessed) reserves, an aggregate Pedersen identity, distinct-real-spend matching, and a cross-curve BabyJubJub↔secp equality proof whose generators I verified are genuine NUMS. The two release blockers are both **operational/validation gates, not logic defects**: H-01 is a testnet→mainnet re-anchor (which also re-pins the eth vkey and regenerates the ELF), and X-01 is the still-unexecuted in-zkVM Groth16 verifier the README explicitly solicits a box-test for. Resolve both before enabling reflection, Mode-B, fast-lane btcHomed exits, or the batch path.

### Severity summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 1 | H-01 (confirmed & refined from bundle 1 / GPT-5.5) |
| Medium | 1 | **X-01 (new)** |
| Low | 2 | **X-02, X-03 (new)** |
| Info | 1 | **X-04 (new)** |
| **Total** | **5** | 1 carried · 4 new |

Fund-critical (loss / lock / inflation / cross-chain double-spend): **H-01, X-01.**
Quality / defensive: **X-02, X-03, X-04.**

---

## A. Fund-critical findings

### H-01 — Ethereum reflection is anchored to Sepolia (testnet), not mainnet · **High** · *confirmed & refined from bundle 1 / GPT-5.5 Pro*

- **Files:** `reflect.rs:277-290` (`ETH_REFLECTION_VKEY` + `ETH_GENESIS_SYNC_COMMITTEE`), `:316-326` (genesis-committee word-8 pin), `:344-362` (cross-cycle prior anchor); `eth_reflection_guest_main.rs:108-169` (genesis bootstrap + freshness anchor); `eth_reflection.rs:17-30`.
- **Claim:** The Mode-B Ethereum reflection's two immutable anchors — the inner eth-reflection vkey and the genesis sync-committee — are pinned to a **Sepolia** finalized checkpoint (`finalizedSlot 10462624`), with the source comment "*Re-anchor for a production deploy*" (`reflect.rs:285`). Testnet beacon state is cheap to influence and economically worthless, so any pool value whose safety depends on reflected Ethereum state is unprotected on mainnet until this is re-anchored.
- **Refinement of the bundle-1 / GPT-5.5 finding (the domain-binding *mechanism* is actually sound):** Both prior audits rated this High partly on the basis that `EthReflectionPublicValues` carries no explicit `sourceChainId` / fork-digest, so a proof from the "wrong domain" might be accepted. On a full read of the recursion I find the **domain is bound transitively and soundly**, so the residual risk is the *anchor*, not a domain-collision hole: the genesis sync-committee is pinned (`reflect.rs:316-326`, word 8 of the eth public values must equal `ETH_GENESIS_SYNC_COMMITTEE`), and that committee's validators only ever produced signatures under the *real* beacon signing domain (which mixes in `genesis_validators_root` and the fork version). A forged `genesis_root` therefore breaks the **first** `verify_update` signature check inside the eth guest — there is no second-preimage-free way to make a foreign-domain proof satisfy the pinned committee. So the exploitable gap is specifically that the pinned committee/vkey are **Sepolia's**, and re-anchoring to mainnet closes it; an explicit domain field is *hardening*, tracked separately as X-02.
- **Why this gates more than reflection:** This is the same seam bundle-1 N-01 identified as making the fast-lane btcHomed exit fund-critical. That mechanism is now **implemented soundly in this bundle** — the cross-cycle anchor at `reflect.rs:344-362` binds each Mode-B cycle's `priorDigest` (word 0) to the digest the last cycle committed (`state.eth_refl_digest`, itself pinned by the contract's `knownReflectionDigest` chain), closing the forged-prior bypass that the consumed-count gate alone could not. But every guarantee it provides is denominated in **testnet** Ethereum state until H-01 is fixed.
- **Minimal fix:** Re-anchor to mainnet: re-pin `ETH_GENESIS_SYNC_COMMITTEE` to a chosen mainnet finalized checkpoint, re-pin `ETH_REFLECTION_VKEY` to the rebuilt eth-reflection ELF, and regenerate the outer ELF so `BITCOIN_RELAY_VKEY` commits to the production program. Do **not** arm reflection / Mode-B / fast-lane btcHomed exits / the batch path until all three pins are the production values and a first valid mainnet reflection has advanced the spent set (the bundle-1 N-01 enable-ordering invariant).
- **Confirm-the-fix check:** Diff the regenerated genesis-committee pin against the mainnet `genesis_validators_root`-derived bootstrap and confirm equality; attempt a Mode-B settle carrying any Sepolia-domain reflection proof and confirm it reverts (wrong genesis committee → `eth-reflection: wrong genesis sync-committee` at `reflect.rs:323`). Confirm `elf-vkey-pin.json` pins the rebuilt program.

---

### X-01 — Box-assembled batch path (Groth16 + cross-curve verify) is unvalidated in-zkVM · **Medium** · *new* · **needs confirmation (box-test)**

- **Files:** `groth16.rs:8-13` (BOX-ONLY banner + three required checks), `swap_batch.rs:14-16` (BOX-ONLY assembly banner), `babyjubjub.rs:8-12` (BOX-ONLY banner).
- **Claim:** `groth16.rs`, `swap_batch.rs`, and `babyjubjub.rs` link the SP1-precompile `bn` crate and so cannot be `cargo`-tested in the repo; they are explicitly marked **BOX-ONLY** and have **never been executed end-to-end inside the zkVM**. The README solicits exactly this validation. Because the in-guest Groth16 verifier is the root of the batch path's no-inflation guarantee, it must be run against real proof vectors at least once before the batch path is armed.
- **Static read is clean — the residual risk is execution, not logic:** On read the verifier is sound (see §C-7): the verifying key is SHA-256-pinned for provenance (`groth16.rs:26-29`, `BATCH_VK_SHA256`), G2 points get a subgroup check, A/C reject infinity, the public-input count is exact (`BATCH_NPUBLIC = 123`), and it fails closed. The three flagged box checks are (a) the snarkjs↔`bn` G2 `Fq2` limb order in `g2()`, (b) that `bn` resolves to the SP1-accelerated build, and (c) that `Gt::one()` is the correct multi-pairing target. Notably, the **failure mode of the limb-order gotcha is liveness, not a forgery window**: a wrong `[c0,c1]` order makes the pairing reject *valid* proofs (fail-closed), it does not validate an invalid one — but "valid proofs verify" and "the precompile is the accelerated build" are properties only an execution can establish, and an un-executed cryptographic verifier cannot be called production-ready.
- **Exploit framing:** No concrete exploit on the current code; this is a release-gate. If shipped un-executed and the precompile/limb wiring is subtly wrong, the most likely outcome is a stuck batch lane (fail-closed); a remaining-but-unverified concern is whether any inputs-not-checked-here assumption (e.g. `Gt::one()` target) could mis-validate, which is precisely what the box-test rules out.
- **Minimal fix:** Before enabling the batch path in production, run on the box: (1) verify a real `swap_batch` proof produced from the ceremony zkey against `groth16.rs` (a known-good vector must verify; if it fails, swap the `Fq` limbs in `g2()` per the source note); (2) confirm the `bn` package resolves to the SP1-accelerated build; (3) validate `babyjubjub.rs` `verify_xcurve` against real dapp-produced cross-curve vectors; (4) run a full envelope+proof `swap_batch` vector through `verify_swap_batch` end-to-end.
- **Confirm-the-fix check:** A committed test artifact showing a real ceremony-produced batch proof verifying in-zkVM, plus a negative vector (tampered proof / wrong public signal) rejecting. Re-confirm `BATCH_VK_SHA256` matches the deployed `batch_vk.bin`.

---

## B. Defensive / quality findings

### X-02 — No explicit Ethereum source-domain commitment (binding is transitive) · **Low** · *defensive*

- **Files:** `eth_reflection.rs:17-30` (`EthReflectionPublicValues` layout); `reflect.rs:316-326`.
- **Claim:** `EthReflectionPublicValues` commits `prevSyncCommitteeRoot` (word 8) but no explicit `sourceChainId`, fork-digest, or `genesis_validators_root`. As established in H-01 the domain *is* bound — transitively, via the pinned genesis committee that only signs under the real domain — so this is not a soundness gap. It is an auditability/defense-in-depth gap: the binding is implicit and a future refactor that loosened the genesis-committee pin could silently remove it.
- **Minimal fix:** Have the eth guest commit an explicit `compute_fork_digest(fork_version, genesis_validators_root)` (or `sourceChainId`) word and have `reflect.rs` assert it equals the pinned production value, in addition to the existing committee pin. Defense-in-depth, not required for soundness.
- **Confirm-the-fix check:** A reflection proof with a mismatched fork-digest reverts even if (hypothetically) the committee check were bypassed.

### X-03 — `compute_txid` 64-byte guard checks full length, not the stripped length · **Low** · *new* · **needs confirmation — NOT exploitable**

- **Files:** `bitcoin.rs:28-37` (`compute_txid` BTC-1 guard).
- **Claim:** The CVE-2012-2459 / 64-byte anti-merkle-collision guard tests `tx_data.len() == 64` on the **full** serialization with a segwit exception (`bitcoin.rs:31`). Bitcoin consensus applies the 64-byte rejection to the **stripped** (non-witness) serialization — the bytes a txid is actually hashed over. A segwit transaction whose *stripped* form is 64 bytes (e.g. one empty-scriptSig input + one output with a 4-byte script) has a longer *full* length, so the segwit branch is taken and `compute_txid` returns `double_sha256(stripped_64)` — a 64-byte preimage that could in principle be confused with a merkle internal node.
- **Why it is not exploitable here (the load-bearing reasoning):** Every txid merkle path in this codebase is proven into a `txid_root` taken from a **real, PoW-anchored** block header (provenance chains are linked to a relay-pinned tip; see §C-2/§C-3). To weaponize the 64-byte ambiguity an attacker would have to either (i) get the crafted 64-byte-stripped transaction actually mined into a real block at the right tree position, or (ii) find a `double_sha256` collision between the crafted tx and an existing internal node — both infeasible. Independently, the burn path requires the transaction's witness to be genuinely committed in a real block's witness tree (`verify_tx_witness_committed`, §C-1), which a fabricated internal-node "transaction" cannot satisfy. So this is a consensus-faithfulness completeness nit, not a fund risk.
- **Minimal fix:** For completeness, also compute the stripped serialization length for segwit transactions and reject when it equals 64, matching Bitcoin Core exactly.
- **Confirm-the-fix check:** A unit test feeding a segwit tx with a 64-byte stripped form returns `None` from `compute_txid`.

### X-04 — Production re-anchor rotates multiple pins in lockstep · **Info** · *new*

- **Files:** `groth16.rs:21-29` (`batch_vk.bin` SHA-256 pin, committed via `BITCOIN_RELAY_VKEY`); `reflect.rs:277-290` (`ETH_REFLECTION_VKEY` + genesis-committee anchor).
- **Claim:** The production cutover for H-01 touches several pinned constants that must move together and be re-proven: the eth-reflection vkey, the genesis sync-committee anchor, the batch VK SHA-256 (if the ceremony rotates), and the outer ELF/vkey. A partial rotation (e.g. new genesis committee but stale vkey) is a fail-closed mismatch rather than a silent fault, but the coupling should be an explicit checklist item, not tribal knowledge.
- **Minimal fix:** Document the lockstep rotation set and gate it in build/release CI (assert the pinned eth vkey, genesis committee, batch VK SHA-256, and outer ELF were all regenerated from the same production checkpoint).
- **Confirm-the-fix check:** A CI job that fails if any one of the four pins is stale relative to the others.

---

## C. Positive checks — paths verified sound

The README asks for a one-line statement where a path is safe and explicit confirmation that the witness-commitment fix is present and sound. Each item below was confirmed by full read (and, where noted, by computation).

**C-1 · BIP-141 witness-commitment binding — the #1 concern — is SOUND and wired into every provenance path.** `verify_tx_witness_committed` (`bitcoin.rs:1464-1486`) pins the coinbase commitment to the *same* block as the target tx by proving the coinbase txid at index 0 into the identical `txid_root`, then recomputes the witness root from the tx's wtxid at its txid-tree index and checks `double_sha256(witness_root ‖ reserved) == commitment`. Forging a tx's witness changes its wtxid; matching the now-fixed commitment via chosen siblings/reserved is a SHA-256 preimage problem → infeasible. The full-block variant `verify_witness_commitment` (`bitcoin.rs:1396-1409`) is sound for the same reason. It is wired in all three paths **with the witness checked before any envelope is parsed**: per-CXFER burn (`burn_deposit.rs:231-242`), full-block scan (`reflect.rs:446-494`, envelope read only if `witness_committed`), and etch/cmint reveals (`reflect.rs:701-832`). The round-trip suite ships explicit regression tests for the exact attack class — `witness_commitment_detects_swapped_witness` (`bitcoin.rs:2526`), `tx_witness_committed_via_path_detects_swap` (`:2568`). **The prior-review inflation class is closed.**

**C-2 · Bitcoin primitives are hardened.** `compute_txid` carries the BTC-1 64-byte guard (`bitcoin.rs:28-37`; full-length caveat is X-03, non-exploitable); `read_varint` is total and non-panicking; `bits_to_target` fails closed (zero/out-of-range exponent → unsatisfiable target); merkle path/root are standard; `verify_header_chain` (`bitcoin.rs:1487+`) checks per-header PoW and prev-hash linkage. Arithmetic uses `checked_add` throughout, so hostile input is a clean `None`, never a panic.

**C-3 · Not enforcing retarget difficulty *inside* the guest is safe.** Provenance chains are anchored at real relay endpoints on both ends (the contract pins `prev_hash` to the relay tip and the tip to a matured relay ancestor; the provenance chain's tip must equal `prev_hash`), and `BitcoinLightRelay.sol` enforces retarget on-chain. PoW prev-linkage then forces the canonical chain — substituting low-difficulty headers requires a hash collision with a fixed relay endpoint. The classic low-difficulty-header attack is ruled out.

**C-4 · Burn→mint conservation and provenance DAG are rigorous.** `verify_provenance_dag_leaves` (`burn_deposit.rs:69-148`) dedups produced outputs, rejects in-DAG double-spends (`:93`), and — critically — computes a **reachability fixpoint** from value-matched real supply leaves (`:108-139`), so a fabricated cycle / disconnected component / future-output dependency never becomes reachable and is rejected (every CXFER must be accepted). The burned note must be reachable and not consumed in-DAG (`:141-147`). `verify_cxfers` binds the witness before parsing the envelope and resolves the burn against `canonical_output_vout` (`burn_deposit.rs:294`) — not a freely-witnessed vout — preventing value-rekeying of which output the burn settles. `verify_cmint_authorized` (`:324`) binds the issuer's BIP-340 signature to the exact commit/reveal pair via the commit anchor (no re-wrap), and `reflect.rs:744-771` adds a one-commit-one-leaf replay guard (`seen_commits`) that closes the documented gap the signature alone left open. `confirmed_block_root` is freely witnessed (`reflect.rs:630`) but bound to a PoW-anchored canonical header (`reflect.rs:728-732`).

**C-5 · Inner Ethereum reflection is sound (modulo the H-01 anchor).** `eth_reflection_guest_main.rs` proves its four storage slots against the **finalized** execution state root; the freshness anchor reads `bitcoinConsumedCount` at the finalized block and asserts `consumed_count == on-chain` (`:154-169`), forcing completeness and closing the subset-witness double-spend; entry-slot-count reconciliation rejects stray/unproven entries; duplicate witnesses and the zero-pool are rejected; and the accumulator is append-only. The Mode-B recursion (`reflect.rs:295-365`) layers `verify_sp1_proof(ETH_REFLECTION_VKEY)` + the genesis-committee pin + the cross-cycle prior anchor (`:344-362`) that binds `priorDigest` to the last committed digest — closing the forged-prior bypass.

**C-6 · Batch path cannot inflate.** In `swap_batch.rs` the Groth16 reserves are **authoritative** — taken from `state.pools`, not witnessed, and re-derived in `swap_batch_public_signals` so the public signals are unforgeable. An aggregate Pedersen identity binds Σreceipts to Σinputs + reserve + delta; step 5 (`swap_batch.rs:246-283`) ties each intent input to a **distinct** real spent UTXO of the **correct asset** (the `used` array blocks double-count; the asset check blocks relabel; the final "every spend used" check blocks unaccounted spends); a constant-product floor adds defense-in-depth; and each receipt's cross-curve sigma ties the secp note to the Groth16-proven value.

**C-7 · In-guest Groth16 verifier is sound on read.** `groth16.rs`: VK SHA-256-pinned for provenance (`:26-29`), G2 subgroup check (`check_order = true`), A/C reject infinity, exact public-input count, fail-closed. (Execution validation is the open gate X-01.)

**C-8 · Cross-curve BJJ↔secp binding is unforgeable, and the generators are genuine NUMS (verified by computation).** `verify_xcurve` (`babyjubjub.rs:230`) implements a Camenisch-Stadler equality proof; `unpack` (`:194`) enforces canonical-v, on-curve, and **prime-order subgroup** membership (`:218`, blocking torsion); a 128-bit Fiat-Shamir challenge binds both commitments and announcements; and a shared 320-bit `z_a` yields exact integer equality given the Groth16 range check (the load-bearing invariant, correctly documented at `babyjubjub.rs:130`). Twisted-Edwards addition is complete for validated points. **I re-derived the pinned generators `h_bjj`/`g_bjj` from the native NUMS construction (`bjj.rs` KAT) and all four coordinates match exactly** — the generators are genuine nothing-up-my-sleeve points with no embedded trapdoor.

**C-9 · Envelope parsers are safe-by-construction.** The `parse_*` family (`bitcoin.rs:381-429` and the wider parser block) is bounds-safe and returns `None` on malformed input (skip-not-panic); their outputs are bound downstream by conservation, signatures, and the DAG, so parser quirks are at worst a liveness issue, never a fund risk.

---

## D. Cross-reference to bundle 1 / GPT-5.5 Pro

- **H-01** is the same cross-audit release-blocker. This bundle lets me **refine** it: the domain-binding *mechanism* the prior audits worried about is sound (transitive via the pinned genesis committee, §C-1/H-01), so the residual exploitable risk is precisely the **Sepolia anchor** — re-anchoring to mainnet closes it. An explicit domain field is hardening only (X-02).
- **Bundle-1 N-01** (fast-lane btcHomed exit is double-spend-safe only while Mode-B reflection is operational and sound on the Bitcoin side) — the Mode-B reverse-fold mechanism it depended on is now **implemented soundly in this bundle** (cross-cycle anchor at `reflect.rs:344-362`), but remains gated on the H-01 mainnet re-anchor before it can be armed. N-01's enable-ordering invariant stands.
- No overlap with bundle-1 M-01/M-02/M-03 or L-01/L-02 (those are EVM-core / oracle / collateral items outside this bundle's surface). No bundle-1 finding is contradicted.
- The bundle hash differs from bundle 1 (`af33083a…` vs `14511596…`) — these are genuinely different packages, audited independently.

---

## Fix-priority punch-list

1. **H-01** — Re-anchor the Ethereum reflection to mainnet: re-pin `ETH_GENESIS_SYNC_COMMITTEE` + `ETH_REFLECTION_VKEY`, regenerate the outer ELF (`BITCOIN_RELAY_VKEY`). *Release blocker for reflection / Mode-B / fast-lane exits.*
2. **X-01** — Box-test the batch path against real ceremony proof vectors (Groth16 limb order + accelerated `bn` build + `Gt::one()` target + full `swap_batch` + cross-curve vectors) before arming it. *Release blocker for the batch lane.*
3. **Bundle-1 N-01 enable-ordering** — Keep fast-lane btcHomed exits reverting until the H-01 production pins are live and a first mainnet reflection has advanced the spent set. *Invariant, not a runbook step.*
4. **X-04** — Add CI asserting the four production pins (eth vkey, genesis committee, batch VK SHA-256, outer ELF) were regenerated in lockstep.
5. **X-02** — Commit an explicit eth fork-digest / `sourceChainId` as defense-in-depth.
6. **X-03** — Match Bitcoin consensus by also rejecting a 64-byte *stripped* segwit serialization in `compute_txid`. *Completeness; not exploitable.*

---

## Attestation — Proof of Audit

```
Audit ID:    tacit-crosschain-static-audit/2026-06-25/Claude-Opus-4.8/
             af33083a7c7e0b4d769ad003bb012cf3f2a0901a0262e89d5c20bef55e489076
Auditor:     Claude Opus 4.8 (Anthropic)
Date:        2026-06-25
Method:      Full-read static adversarial review; witness-commitment & merkle-binding
             reconstruction; provenance-DAG reachability tracing; per-leg conservation
             tracing; computational NUMS-generator verification.
Trusted (per scope): SP1VerifierGroth16; helios-consensus-core 0.11.1 (Zellic-audited);
             sp1_helios_primitives::verify_storage_slot_proofs (reused verbatim).
Companions:  Cross-referenced & de-duplicated vs bundle-1 Claude Opus 4.8 audit and the
             GPT-5.5 Pro audit (2026-06-24). This is a DISTINCT bundle (hash below).

Audited bundle:
  SHA-256(tacit-crosschain-audit-bundle.zip) = af33083a7c7e0b4d769ad003bb012cf3f2a0901a0262e89d5c20bef55e489076

Per-file SHA-256 (in-scope, canonical dirs):
  guest-bitcoin/bitcoin.rs                  c2d0f00cd648a56fb6c2f164956eb6b9bd063fba7fe961d27a068d2208a56a5d   2714 L
  guest-bitcoin/burn_deposit.rs             021021feeff8dd763edf4007a8097652400a43d2ef2d7c1d98c7cc4d7cb92b62    747 L
  eth-reflection-guest/eth_reflection_guest_main.rs
                                            7e9da2021eaba5f57b429d79551eb4d46d7f9b7419a3675b7f69b2446f8efb55    265 L
  guest-batch/swap_batch.rs                 326fb2f1e96dd1bc609e418332e40f3353981a2987c6d27692293644e5690b52    317 L
  guest-batch/groth16.rs                    47bbb93de532bcb267e27bd50a7a27a85f29e340da088064a01b01e358148058    169 L
  guest-batch/bjj.rs                        9b21789d397859e8995a90c06e3185a61eb0115d20ace0b85e1f25bde2f6ded1    292 L
  guest-batch/babyjubjub.rs                 17b36a467facebdf3b1e114f78846b2023bc55cdbbdfe25f7cc334f6ff1b380c    259 L

Context (re-read for trust-boundary tracing; reviewed in bundle 1):
  context/reflect.rs                        56a40534d24f7d7745b8d10116f2a769d3461b2f036ad7803182797ff4961edb   1576 L
  context/eth_reflection.rs                 0421f65d866595fcf55bf5b7fc60ce0a5693d004000093dadb94109e4e584c10    335 L
  context/sigma.rs                          0ccced2b6310c63ed599e47402cacf4536ded3a69370a76a680a7d19671dd0e0    138 L
  context/elf-vkey-pin.json                 78e19f2cf2215f4befeba32bcba5d3177b45446ce372a7f578dabebe5d4f07bf     32 L
  context/BitcoinLightRelay.sol             e0fd0ff8f59fffa0aea8540bbfebf20ae027cee665ee5fe95711a1f59130d377    547 L

Package docs:
  README.md                                 abfe61d8bac25e6c90966f66bf59484512d526282709fe5c28056525c4dc67d0
  MANIFEST.txt                              4819e13f61ca3c291cbe4cb32d50f3360352ad7ea84e9c369064a945ead93a4e
```

**Attestation statement.** I, Claude Opus 4.8, performed the static security and accounting review described above against the bundle whose SHA-256 hashes are recorded here. The findings reflect my analysis as of 2026-06-25. This is a model-authored attestation of work performed — not a cryptographic key signature — and verifies bundle identity by hash, mirroring the companion GPT-5.5 Pro audit's framing. A static review cannot prove the absence of all defects; in particular, the proof system and reused upstream primitives are trusted per scope, and items marked **needs confirmation** require operational verification the code alone cannot settle: **X-01** (the box-only batch path must be executed against real proof vectors on the SP1 box) and **X-03** (consensus-faithfulness of the stripped-length txid guard — assessed non-exploitable here, but the fix should be unit-tested). The two release blockers — H-01's mainnet re-anchor and X-01's box-validation — are operational/validation gates rather than logic defects; the Bitcoin-data-authenticity and bridge-conservation layers are sound. Re-running the hashes above against the delivered bundle reproduces this attestation's provenance.

— *End of report.*
