# RUNBOOK — Sepolia re-prove (fast-lane fold + Mode-B anchor)

Validates the fast-lane reverse-reflection fold + the Mode-B `eth_refl_digest` anchor on a fresh
**Sepolia** ConfidentialPool before the mainnet launch re-prove. Sepolia keeps the current config
(`ETH_GENESIS_SYNC_COMMITTEE`, Bitcoin anchor) — the only constant that MUST change is
`ETH_REFLECTION_VKEY` (the eth-reflection guest rotated when it gained the prior/new digest words).

Source base: commits `47c3888` (cross-lane artifacts) + `f3b26e3` (fold + anchor + relaxed bar +
genesis `eab17bcb…`). 364 forge tests + JS round-trips green. Branch `confidential-transfer-nm`.

## Pre-flight (dev-box, DONE)
- [x] `reflect.rs` carries the `consumedCount` PV field (11th) — the box must build this committed
      tree, not a clean checkout that drops it (else guest commits 10 / contract decodes 11 → every
      attest reverts on `abi.decode`).
- [x] Slot pins verified vs `forge inspect ConfidentialPool storageLayout`: `crossOutCommitment=76`,
      `bitcoinConsumed=119`, `bitcoinConsumedCount=120`.
- [x] `ETH_REFLECTION_VKEY` (reflect.rs:169) confirmed STALE — re-pin is load-bearing (step 2).
- [x] Cross-lane acceptance harnesses + fixtures present (swap/OTC/LP/BID); all 8 settle harnesses
      write the `lock_set_root` header word.

## Re-prove order (★ = box; ☆ = dev-box edit I make when you paste the value back)

1. ★ **Sync** the committed working tree to the box (settle → `/root/work/confidential`, cxfer-guest
   → `/root/work/cxfer`, eth-reflection guest → its sp1-helios build dir). Confirm `git diff` is clean
   vs `f3b26e3`.

2. ★ **eth-reflection ELF → recompute `ETH_REFLECTION_VKEY`.** Rebuild the eth-reflection guest
   (`cargo prove build`), then run the `eth_vkey` harness (point its `include_bytes!` at the freshly
   built `eth_reflection` ELF). It prints both `bytes32` (on-chain) and `hash_u32` (the recursion
   `[u32;8]`).
   - ☆ Paste me the `hash_u32` — I pin it into `reflect.rs:169 ETH_REFLECTION_VKEY` and re-sync.
   - Sanity: a drift here makes every reflection proof reject (`verify_sp1_proof` fails).

3. ★ **Build the canonical settle + reflection ELFs** (`cargo prove build`, the env the pin records as
   reproducible: Linux / `--docker` sp1 6.2.2). The prover box must run the committed `include_bytes!`
   ELF, never a native rebuild (drift → `ProofInvalid`).

4. ★ **Derive `PROGRAM_VKEY` (settle) + `BITCOIN_RELAY_VKEY` (reflection)** via the `exec-prove` /
   `exec-reflect-prove` `EXPECT_VKEY` guard (or `setup().verifying_key().bytes32()`).
   - ☆ Paste me both — I update `elf-vkey-pin.json` (`program_vkey`, `bitcoin_relay_vkey`, both
     `*_elf_sha256` + `*_bytes`), `verify-vkey-pin.sh` `FROZEN_*`, the readiness-gate layer-9 allowlist,
     and `DeployConfidentialPool` `DEFAULT_VKEY`. Cross-check `BITCOIN_RELAY_VKEY` against the staged
     prediction (`0x00d06eda` — expect a DIFFERENT value, since the staged ELF predates the anchor).

5. ★ **GPU: regenerate the real-proof fixtures** for the new vkeys:
   - `exec-prove` / `exec-reflect-prove` `MODE=groth16` → the `ConfidentialSwapProofReal` /
     `ConfidentialReflectionProofReal` fixtures.
   - `exec_crosslane{,_swap,_otc,_lp,_bid}` `MODE=execute` first (validates the read order +
     conservation against the new ELF — cheap), then `MODE=groth16` if producing on-chain artifacts.

6. ★ **Deploy ConfidentialPool (Sepolia)** with the new vkeys + a recent near-tip Sepolia
   `genesisReflectionAnchor_` + `reflectionResumeDigest_` (0 for a genesis-anchored gen, or the
   near-tip resume digest) + `HEADER_RELAY`. The deploy `require`s enforce vkey↔pin coherence + a wired
   relay. `REFLECTION_GENESIS_DIGEST` is already `eab17bcb…` and matches `ScanReflection::genesis()`.

7. ☆/★ **Validate against the pinned ELFs:** `readiness-gate.sh` + forge + cxfer-core suites (dev-box);
   then on the new deploy — one `attestBitcoinStateProven` + one **btcHomed fast-spend** settle
   (leaf exit, records `bitcoinConsumed` + bumps `bitcoinConsumedCount`), and confirm the next attest's
   `consumedCount` gate is satisfied. This is the end-to-end fast-lane proof on Sepolia.

## Notes / gotchas
- This rotates **all three** vkeys (`PROGRAM_VKEY`, `BITCOIN_RELAY_VKEY`, `ETH_REFLECTION_VKEY`). The
  staged `_staged_reprove_*` vkeys are a sanity-check prediction, NOT values to promote blind (see the
  `_caveat_finding1_anchor_2026_06_17` note in the pin).
- Mode-B eth-reflection chains from the genesis sync-committee each proof; proving cost grows with
  chain-age since genesis (~1 update / 27h). Fine on a recent Sepolia genesis; the per-period
  digest-chaining is a follow-up (`reflect.rs:200`).
- Box access: the vast key is passphrased + proxy propagation has been flaky — run the ★ steps on the
  box directly or via `! <cmd>`; the logs API gives shell-free visibility if SSH is down.
