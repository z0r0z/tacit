# Tacit Finance Cross-Chain Reflection / Bridging Audit — Bundle 2

**Auditor:** GPT-5.5 Pro  
**Date:** 2026-06-24  
**Scope artifact:** `tacit-crosschain-audit-bundle.zip`  
**Scope artifact SHA-256:** `af33083a7c7e0b4d769ad003bb012cf3f2a0901a0262e89d5c20bef55e489076`  
**Audit signature SHA-256:** `59076eaea0ba878071f5055e3d3165344b85f353dea6f9aaefe4b59f1ce80120`

## Verdict

**Do not enable production/mainnet cross-chain V1 until C-01 and H-01 are fixed.** The non-coinbase BIP-141 witness-binding remediation is present and materially improves the Bitcoin authenticity layer, and the burn-deposit and consumed-nullifier accounting paths show strong positive controls. However, the full-block scanner still accepts Tacit envelopes from the coinbase witness even though BIP-141 deliberately excludes the coinbase wtxid from the witness merkle tree. That leaves a prover-chosen witness-data injection path for spendless opcodes. Separately, Mode-B Ethereum reflection is still Sepolia/re-anchor dependent and lacks an explicit source-domain field. Batch swaps should also remain disabled until the embedded Groth16 VK and a known-good/known-bad vector are included and tested.

## Severity summary

| Severity | Count | IDs |
|---|---:|---|
| Critical | 1 | C-01 |
| High | 1 | H-01 |
| Medium | 2 | M-01, M-02 |
| Low | 1 | L-01 |
| Informational / seam | 3 | I-01, I-02, N-01 |

## Fund-critical vs. quality findings

**Fund-critical / production blockers:** C-01, H-01, M-01 if `T_SWAP_BATCH` is enabled, and M-02 as a consensus-authenticity hardening item whose downstream impact needs confirmation against the omitted `ScanReflection` internals.

**Quality / defensive hardening:** L-01 and the seam notes I-01, I-02, N-01.

## Scope and hashes

| File | SHA-256 |
|---|---|
| `README.md` | `abfe61d8bac25e6c90966f66bf59484512d526282709fe5c28056525c4dc67d0` |
| `MANIFEST.txt` | `4819e13f61ca3c291cbe4cb32d50f3360352ad7ea84e9c369064a945ead93a4e` |
| `guest-bitcoin/bitcoin.rs` | `c2d0f00cd648a56fb6c2f164956eb6b9bd063fba7fe961d27a068d2208a56a5d` |
| `guest-bitcoin/burn_deposit.rs` | `021021feeff8dd763edf4007a8097652400a43d2ef2d7c1d98c7cc4d7cb92b62` |
| `eth-reflection-guest/eth_reflection_guest_main.rs` | `7e9da2021eaba5f57b429d79551eb4d46d7f9b7419a3675b7f69b2446f8efb55` |
| `guest-batch/swap_batch.rs` | `326fb2f1e96dd1bc609e418332e40f3353981a2987c6d27692293644e5690b52` |
| `guest-batch/groth16.rs` | `47bbb93de532bcb267e27bd50a7a27a85f29e340da088064a01b01e358148058` |
| `guest-batch/bjj.rs` | `9b21789d397859e8995a90c06e3185a61eb0115d20ace0b85e1f25bde2f6ded1` |
| `guest-batch/babyjubjub.rs` | `17b36a467facebdf3b1e114f78846b2023bc55cdbbdfe25f7cc334f6ff1b380c` |
| `context/reflect.rs` | `56a40534d24f7d7745b8d10116f2a769d3461b2f036ad7803182797ff4961edb` |
| `context/eth_reflection.rs` | `0421f65d866595fcf55bf5b7fc60ce0a5693d004000093dadb94109e4e584c10` |
| `context/sigma.rs` | `0ccced2b6310c63ed599e47402cacf4536ded3a69370a76a680a7d19671dd0e0` |
| `context/elf-vkey-pin.json` | `78e19f2cf2215f4befeba32bcba5d3177b45446ce372a7f578dabebe5d4f07bf` |
| `context/BitcoinLightRelay.sol` | `e0fd0ff8f59fffa0aea8540bbfebf20ae027cee665ee5fe95711a1f59130d377` |

`guest-batch/batch_vk.bin` is referenced by source but was **not present** in the bundle or `flat-for-upload` mirror.

---

## Findings

### C-01 — Coinbase witness can carry forged Tacit envelopes because it is not BIP-141 committed

**Severity:** Critical  
**Category:** Fund-critical Bitcoin data authenticity / cross-chain lock or unauthorized action  
**Files:** `guest-bitcoin/bitcoin.rs:1396-1405`, `guest-bitcoin/bitcoin.rs:1415-1450`, `guest-bitcoin/bitcoin.rs:1563-1623`, `context/reflect.rs:482-497`, `context/reflect.rs:930-989`

**Claim:** The full-block scan treats every transaction, including `txs[0]` coinbase, as eligible for `extract_taproot_envelope`. BIP-141 sets the coinbase wtxid to zero, so the coinbase witness stack itself is not in the witness merkle root. The code also accepts a coinbase witness stack with more than the single 32-byte reserved value. A malicious prover can therefore attach an arbitrary Tacit envelope to the coinbase witness while preserving the real txid merkle root and the real witness commitment.

**Why this is exploitable:**

1. Start with a real SegWit block and its real coinbase transaction.
2. Keep the coinbase stripped serialization and outputs unchanged, including the `6a24aa21a9ed || commitment` output, so `compute_txid(modified_coinbase)` remains the real coinbase txid and the block txid merkle root still matches `header[36..68]`.
3. Keep witness item 0 equal to the real 32-byte reserved value, but add item 1 shaped as a Taproot script carrying `TACIT || v1 || <fake envelope>`.
4. `verify_witness_commitment` still passes because it pushes `[0u8; 32]` for the coinbase wtxid and only hashes non-coinbase full transactions into the witness tree.
5. `extract_taproot_envelope(modified_coinbase)` then reads the uncommitted item-1 script and returns the fake envelope.
6. The reflection loop can process that fake envelope as a confirmed Bitcoin event. Spendless or value-free branches are the highest-risk examples: `T_CROSSOUT_MINT` at `context/reflect.rs:930-954`, `T_CBTC_LOCK` at `context/reflect.rs:957-973`, and `T_BTC_CALL` at `context/reflect.rs:976-989`.

The immediate fund impact depends on the downstream opcode. For `T_CROSSOUT_MINT`, a malicious prover can place an Ethereum→Bitcoin cross-out into an outpoint that was not created by a real Tacit Bitcoin marker transaction, causing lock or capture conditions depending on who controls the underlying coinbase output and who knows the destination opening. For `T_BTC_CALL`, the proof can surface a Bitcoin-authorized call record without any real Bitcoin transaction carrying that authorization. In all cases, the core invariant “Tacit witness envelope was consensus-published on Bitcoin” is false for coinbase.

**Minimal fix:**

- In the full-block scan, never extract or process Tacit envelopes from `ti == 0`; coinbase cannot be a Tacit Taproot marker under the BIP-141 reserved-value rule.
- Add an `is_coinbase_tx` helper and reject all Tacit opcode parsing for coinbase transactions.
- Tighten `parse_coinbase_commitment` to enforce the consensus coinbase witness shape: exactly one witness item, exactly 32 bytes, then a valid locktime/end-of-transaction. Do not accept extra coinbase witness stack items or trailing bytes.
- Keep the existing `coinbase wtxid := 0` behavior for witness-root calculation, but treat the coinbase witness as a reserved-value-only structure, never as an envelope source.

**Check:**

Add a regression fixture where a real coinbase tx is modified to `wit_count = 2`, item 0 is the correct reserved value, and item 1 contains a valid-looking `T_CROSSOUT_MINT` or `T_BTC_CALL` Taproot envelope. Current code should accept `verify_witness_commitment` and extract the envelope; fixed code must either return no envelope for coinbase or reject the coinbase commitment parse. Also add a positive fixture proving non-coinbase witness envelopes still verify.

---

### H-01 — Mode-B Ethereum reflection remains Sepolia-anchored and lacks an explicit source-domain public value

**Severity:** High  
**Category:** Fund-critical cross-chain source-domain binding  
**Files:** `context/reflect.rs:277-285`, `context/reflect.rs:313-325`, `context/reflect.rs:344-363`, `eth-reflection-guest/eth_reflection_guest_main.rs:33-51`, `eth-reflection-guest/eth_reflection_guest_main.rs:101-119`, `context/elf-vkey-pin.json:15-31`

**Claim:** The outer Bitcoin reflection guest recursively verifies the inner Ethereum proof with a pinned `ETH_REFLECTION_VKEY` and asserts `prevSyncCommitteeRoot == ETH_GENESIS_SYNC_COMMITTEE`, but the checked anchor is explicitly documented as Sepolia and the public values do not carry an explicit `sourceChainId`, fork digest, or deployment-domain field. The current mechanism can be correct only after a target-production re-anchor and vkey re-pin.

**Exploit / failure walkthrough:**

1. Mode-B accepts `eth_pv` after `verify_sp1_proof(&ETH_REFLECTION_VKEY, sha256(eth_pv))`.
2. The outer guest checks word 8 against `ETH_GENESIS_SYNC_COMMITTEE`, documented as a Sepolia sync-committee anchor captured at finalized slot 10462624.
3. The inner guest takes `genesis_root` and `forks` from the proof input and emits public values with accumulator roots and sync-committee roots, but no explicit chain-id or fork-domain word is consumed by the outer guest.
4. If these constants/vkeys are deployed for production without re-anchoring, a proof over the wrong Ethereum domain can satisfy the recursive check and feed cross-out / consumed-nullifier roots into the Bitcoin reflection path.

The accumulator chaining at `context/reflect.rs:344-363` is a strong positive control against forged prior app state, but it does not by itself identify the Ethereum network. The chain identity is currently implicit in the pinned inner vkey and sync-committee anchor.

**Minimal fix:**

- Rebuild/re-prove the eth-reflection guest for the intended production Ethereum domain and update both `ETH_REFLECTION_VKEY` and `ETH_GENESIS_SYNC_COMMITTEE` in the same release commit.
- Add explicit immutable domain fields to `EthReflectionPublicValues`, at minimum `sourceChainId` and a fork/genesis/domain digest, and have the outer guest assert them against constants.
- Include the domain fields in `eth_refl_digest` or in a separately checked domain digest so future public-value layout changes cannot leave the outer guest trusting a stale implicit domain.
- Update `elf-vkey-pin.json` so live deployment records cannot be confused with authoritative production pins.

**Check:**

A Sepolia eth-reflection proof must fail against a mainnet-configured Bitcoin reflection guest. CI should assert: expected `sourceChainId`, expected fork/genesis digest, expected sync-committee anchor, expected recursive vkey, and rejection of any proof whose public values omit or mismatch those fields.

---

### M-01 — Batch Groth16 verifying key and proof-vector evidence are absent from the audit bundle

**Severity:** Medium, High if `T_SWAP_BATCH` is enabled before confirmation  
**Category:** Fund-critical batch path / proof-system configuration  
**Files:** `guest-batch/groth16.rs:8-14`, `guest-batch/groth16.rs:19-31`, `guest-batch/groth16.rs:117-168`, `guest-batch/swap_batch.rs:14-18`, missing `guest-batch/batch_vk.bin`

**Claim:** `groth16.rs` embeds `include_bytes!("batch_vk.bin")` and pins the blob by SHA-256, but the blob is not in this bundle. The source comments also state that the assembled fold still needs a real swap-batch proof vector / box run to confirm snarkjs G2 limb order, SP1-accelerated `bn` linkage, and pairing target semantics.

**Exploit / failure walkthrough:**

- If the embedded VK is wrong, the guest may either reject all valid batch proofs, locking the batch path, or accept proofs for the wrong circuit, which would make per-receipt split correctness untrusted.
- If G2 limb order is wrong, known-good proofs fail; if the pairing equation or public-signal order is wrong, the proof system can silently enforce a different statement than the reflection fold assumes.
- The aggregate Pedersen identity and per-receipt cross-curve sigma checks are good controls, but they rely on the Groth16 proof to enforce the batch clearing allocation. Without the actual VK artifact and a vector, this audit cannot independently confirm the enabled circuit.

**Minimal fix:**

- Add `guest-batch/batch_vk.bin` to the committed source bundle or to an auditable artifact directory with a ceremony manifest and CID/provenance record.
- Add at least one known-good full `T_SWAP_BATCH` envelope+proof vector and at least two known-bad vectors: swapped G2 limbs and altered public signal.
- CI must compile the reflection guest with the embedded VK, assert `sha256(batch_vk.bin) == BATCH_VK_SHA256`, and run the known-good/known-bad verifier tests on the proving box.
- Keep `T_SWAP_BATCH` disabled until this is green.

**Check:**

`sha256sum guest-batch/batch_vk.bin` equals `31fd05cc1b3d1f7df0459a321eaaf1d7f8bed702a4bc402787eef16ca16bbc7c`, a known-good proof verifies, a proof with one public input altered fails, and a proof with G2 `c0/c1` swapped fails.

---

### M-02 — Bitcoin merkle routines accept duplicate-tail “mutated” block aliases

**Severity:** Medium  
**Category:** Bitcoin authenticity hardening; downstream fund impact needs confirmation  
**Files:** `guest-bitcoin/bitcoin.rs:118-137`, `guest-bitcoin/bitcoin.rs:139-160`, `context/reflect.rs:451-459`, `guest-bitcoin/burn_deposit.rs:225-239`

**Claim:** `compute_merkle_root` implements Bitcoin’s odd-node duplication rule but does not reject mutated duplicate-tail inputs. A malicious prover can present `[A, B, C, C]` for a real three-transaction block `[A, B, C]` and obtain the same merkle root. The same structural ambiguity exists for compact merkle paths because the verifier has no transaction count or mutation check.

**Exploit / failure walkthrough:**

1. For an odd-leaf block, Bitcoin merkle construction computes `H(H(A,B), H(C,C))`.
2. The supplied vector `[A,B,C,C]` computes the same root.
3. The full scan treats the supplied `txs` as “the complete block” once `compute_merkle_root(&txids) == header.merkle_root`.
4. Witness commitment does not close this alias when the duplicate is the last transaction: the witness tree for `[coinbase, tx1, tx2]` and `[coinbase, tx1, tx2, tx2]` can also collide under the same duplicate-tail rule.

Most duplicate processing appears likely to fail closed because duplicated outpoints, produced notes, burns, and local replay guards should reject or no-op on the second pass. However, the key production claim “the provided txs are the exact block” is not true, and the full downstream impact depends on `ScanReflection` insertion / skip semantics outside this bundle. Treat this as needs confirmation, not as a style issue.

**Minimal fix:**

- Replace `compute_merkle_root` in consensus-admission paths with a checked variant that rejects mutated merkle trees: at each level, if two adjacent supplied hashes are equal where they are not the algorithm’s synthetic odd-node duplicate, return `None`.
- For compact proofs, include and validate the block transaction count where possible, or reject proofs that rely on ambiguous self-sibling positions without a count-derived last-node rule.
- Add explicit tests for `[A,B,C]` accepted and `[A,B,C,C]` rejected for both txid and wtxid trees.

**Check:**

A full-scan fixture of an odd-count block with the last tx duplicated must fail before any per-tx fold. A compact provenance proof with a phantom duplicate last-index path must fail unless the path is consistent with the real transaction count.

---

### L-01 — Several fixed-layout envelope parsers accept trailing bytes

**Severity:** Low  
**Category:** Defensive parser canonicality  
**Files:** `guest-bitcoin/bitcoin.rs:381-394`, `guest-bitcoin/bitcoin.rs:589-617`, `guest-bitcoin/bitcoin.rs:942-961`

**Claim:** Several parsers read all security-relevant fields but do not require `env.len()` to equal the fixed-layout end. Examples include `parse_cmint`, `parse_swap_var_envelope`, and `parse_farm_init_envelope`. This creates non-canonical encodings where the guest, worker, dapp, or future parser versions may disagree about the same witness payload.

**Exploit / failure walkthrough:**

No direct inflation path was identified because the relevant witness bytes are BIP-141 committed and the parsed fields are still signature/range/conservation checked. The risk is parser drift: one component may sign or display the full payload while the guest ignores trailing data, or a future extension may accidentally become valid under old guest semantics.

**Minimal fix:**

- For fixed-layout opcodes, require exact end offsets after the final signature/rangeproof field.
- For intentionally extensible envelopes, include an explicit version/extension length and commit the extension to the signed message.
- Add parser tests that append one byte to each fixed-layout envelope and expect rejection.

**Check:**

`parse_cmint(env || 0x00)`, `parse_swap_var_envelope(env || 0x00)`, and `parse_farm_init_envelope(env || 0x00)` must all return `None` unless the opcode is explicitly documented as extension-bearing and the extension is authenticated.

---

### I-01 — Positive assurance: non-coinbase witness binding is present and correctly placed

**Severity:** Informational / positive control  
**Files:** `context/reflect.rs:461-471`, `guest-bitcoin/bitcoin.rs:1396-1408`, `guest-bitcoin/bitcoin.rs:1464-1486`, `guest-bitcoin/burn_deposit.rs:235-239`, `context/reflect.rs:720-727`, `context/reflect.rs:774-781`

**Claim:** For non-coinbase transactions, the prior witness-swap class is materially fixed. The full scan recomputes the block witness root and compares it to the coinbase commitment before parsing Taproot witness envelopes, and the compact burn-deposit paths add same-block coinbase txid proof plus wtxid proof for etch, provenance CXFER, and cmint reveal transactions.

**Reasoning:** A non-coinbase Tacit envelope lives in witness data; txid merkle inclusion alone strips witness. The current code computes `wtxid = dsha256(full tx)` for non-coinbase transactions, folds it into the BIP-141 witness merkle root, and checks `dsha256(witness_root || reserved) == commitment`. That binds the exact witness bytes to the header-committed coinbase output. C-01 is the coinbase exception; the non-coinbase path is otherwise sound.

**Check:**

Keep the existing swapped-witness tests and add a test that changes one byte in a non-coinbase Tacit envelope. It must keep the same txid but fail the witness commitment.

---

### I-02 — Positive assurance: consumed-nullifier completeness closes the main cross-lane double-spend path, assuming the contract freshness gate is active

**Severity:** Informational / seam  
**Files:** `eth-reflection-guest/eth_reflection_guest_main.rs:154-166`, `eth-reflection-guest/eth_reflection_guest_main.rs:219-247`, `context/reflect.rs:396-431`, `context/eth_reflection.rs:89-111`

**Claim:** The inner Ethereum reflection guest proves `bitcoinConsumedCount`, proves every `bitcoinConsumedAt[index]` entry from the prior consumed count to the finalized count, and requires the folded consumed count to equal the on-chain count. The outer Bitcoin reflection guest then folds every newly reflected consumed nullifier into the spent set before scanning same-batch Bitcoin transactions.

**Reasoning:** This is the right accounting order for cross-lane double-spend prevention. Ethereum-recorded consumes are senior: once a Bitcoin-homed note exits on Ethereum, the next Mode-B Bitcoin reflection batch removes the source note from the live set before processing competing Bitcoin spends. The append-only consumed-set root plus count equality blocks subset proofs.

**Required seam:** The bundle relies on the contract-side gate described in comments: the submitted `consumedNuCount` must be current relative to `ConfidentialPool.bitcoinConsumedCount`. If the contract accepts stale eth-reflection public values, a worker could omit a recent Ethereum consume and leave the source note live on Bitcoin.

**Check:**

End-to-end test: consume a Bitcoin-homed note on Ethereum, then submit a Bitcoin transaction spending that same note in the next reflected Bitcoin block. With Mode-B enabled and current `bitcoinConsumedCount`, the Bitcoin spend must fail to create any new live note. A stale eth-reflection proof with lower `consumedNuCount` must be rejected by the contract before proof acceptance.

---

### N-01 — Operational seam: enable ordering and freshness gates are part of the security boundary

**Severity:** Informational / deployment requirement  
**Files:** `context/reflect.rs:292-307`, `context/reflect.rs:396-408`, `context/reflect.rs:930-954`, `context/BitcoinLightRelay.sol:4-27`, `context/BitcoinLightRelay.sol:170-257`

**Claim:** Cross-chain safety depends on enabling Mode-B only after all three anchors are correct: Bitcoin relay canonicality, Ethereum source-domain re-anchor, and contract freshness checks for consumed nullifiers.

**Seams:**

- `context/reflect.rs` proves a header chain and exposes `prev_hash` / `tip_hash`; the Solidity relay must pin those to the canonical heaviest-chain relay state.
- The Ethereum reflection proof is trusted only through `ETH_REFLECTION_VKEY`, `ETH_GENESIS_SYNC_COMMITTEE`, and the app accumulator digest chain.
- `T_CROSSOUT_MINT` omission is liveness-only, but `bitcoinConsumed` omission is a double-spend risk. Consumed-count freshness must be mandatory.
- `mode_b == 0` intentionally disables Ethereum recursion and sets roots to sentinels; production runbooks must prevent accepting reverse-bridge actions while Mode-B is off.

**Check:**

Deployment checklist must contain hard assertions for: relay initialized to the intended Bitcoin network and `MAX_TARGET`, production eth source-domain constants, contract `ethPoolReflected == address(this)` gate, current consumed-count gate, and disabled batch path until M-01 is resolved.

---

## Additional accounting observations

- **Burn-deposit provenance is strongly structured.** `verify_provenance_dag_leaves` rejects empty DAGs, duplicate produced outpoints, duplicate consumed outpoints, unreachable cycles, disconnected components, and burned notes that are consumed inside the DAG. The caller binds each provenance transaction to a relay-confirmed block root and BIP-141 witness commitment before using its envelope.
- **CMINT authorization has good replay protection inside a witness.** The issuer signature binds the asset, commit input anchor, commitment, and encrypted-amount hint; `context/reflect.rs:763-771` rejects repeated commit txids within one burn-deposit proof. Global mint uniqueness is represented by the resulting outpoint/nullifier accounting rather than a standalone mint registry.
- **Batch aggregate accounting is well designed but not yet production-confirmed.** `fold_swap_batch` verifies post-reserve positivity, nondecreasing `k`, aggregate Pedersen identity for both assets, one-to-one matching between intents and real spent notes, asset labels, and output cross-curve sigmas. The missing VK/vector is the remaining blocker.
- **Storage-slot wiring is explicit and mostly fail-closed.** The inner eth guest filters proofs to `ethr.pool`, requires the consumed counter slot, accounts for every non-counter pool slot as either one cross-out or two consumed slots, rejects duplicate witnessed claim IDs/nullifiers, checks slot values, and binds `claimId` to the same preimage as the contract.

## Fix-priority punch-list

1. **Fix C-01 immediately:** skip coinbase envelope extraction and enforce exact coinbase witness reserved-value shape. Add a failing regression test for forged coinbase `T_BTC_CALL` / `T_CROSSOUT_MINT`.
2. **Resolve H-01 before any mainnet Mode-B:** re-anchor eth reflection to the production Ethereum domain, add explicit source-domain public values, and re-pin the recursive vkey.
3. **Keep `T_SWAP_BATCH` disabled until M-01 is resolved:** commit `batch_vk.bin`, ceremony metadata, and known-good/known-bad proof vectors; test on the proving box.
4. **Harden merkle verification:** reject mutated duplicate-tail aliases and add tx-count-aware compact proof checks.
5. **Tighten parser canonicality:** exact lengths for fixed-layout envelopes and exact transaction parsing where the guest treats bytes as consensus structures.
6. **Run cross-lane adversarial E2E tests:** Ethereum consume vs. same-batch Bitcoin spend, stale consumed-count proof rejection, cross-out omission liveness, and relay-tip reorg/finality-window behavior.

## Proof of audit / signature block

```text
artifact: tacit-crosschain-audit-bundle.zip
artifact_sha256: af33083a7c7e0b4d769ad003bb012cf3f2a0901a0262e89d5c20bef55e489076
auditor_model: GPT-5.5 Pro
audit_date: 2026-06-24
scope: Bitcoin authenticity, burn-deposit provenance, inner Ethereum reflection, batch Groth16/BJJ path, and relay/guest seams
method: static source audit of supplied bundle; no external web research; no end-to-end proof generation
limitations: bundle omits guest-batch/batch_vk.bin and a full Cargo/proving-box environment, so batch VK/proof behavior is not independently confirmed
finding_ids: C-01,H-01,M-01,M-02,L-01,I-01,I-02,N-01
audit_signature_sha256: 59076eaea0ba878071f5055e3d3165344b85f353dea6f9aaefe4b59f1ce80120
```
