# Redeploy v3 runbook — reprove (guest bug fix) → redeploy (near-tip seed)

Push-button sequence for after the guest bug fix lands. Goal: new vkeys from the fixed guest,
new pool seeded NEAR-TIP (no big fold), nothing drifting between ELF / prover-bins / fixtures / deploy.

## State already staged (done before "go")
- **Deploy env**: `contracts/deployments/redeploy-v3.env` — near-tip reflection seed baked in:
  `REFLECTION_RESUME_DIGEST=0x0df5dd17` (@958735, VERIFIED == c5B537 on-chain), `GENESIS_REFLECTION_ANCHOR=0x52bb4d1f…` (block 958735 = relay tip−6). Reused externals + engine-admin + verifier-codehash filled. **Pending: vkeys + salts.**
- **Near-tip folder seed**: `nearseed-kv-958735.json` (scratchpad) — `{snapshot,attestedHeight,tipHeight}` @958735, 7578 notes. Upload to the folder/worker at cutover so the first attest is a ≤6-block incremental fold, NOT the 584-block trap.
- **Vanity salts**: mining on box (`createXcrunch create3 --caller 0x68575B --leading 5`), permissioned/front-run-proof, → `/workspace/salts-round3.txt`. Assign any 6 to POOL/ENGINE/ADAPTER/ROUTER/RELAYER/BTC_CALL_EXECUTOR (interchangeable; factory reused).
- **SP1 toolchain**: v6.2.x on box at `/workspace/.sp1/bin` (matches guest `sp1-zkvm 6.2.3`).

## Toolchain reality (why this is safe without byte-reproduction)
SP1 ELF builds are non-deterministic without `--docker` (no docker on this box), so a rebuild will NOT
reproduce the old `37b2a233`. That's fine: on-chain verify by `0xb69f2584` depends on the SP1 **version**
(v6.2.x circuit), not ELF bytes. Safety comes from **one ELF build used everywhere** + the on-chain gate below.

## REPROVE (once the fixed source is final)
Run in `contracts/sp1/confidential/` on the box (`export PATH=/workspace/.sp1/bin:/workspace/cargo/bin:$PATH`).
1. **Sync the final source to the box** (it's a source copy, not git — rsync the exact committed tree).
2. **Build the ELFs ONCE** (this exact binary is authoritative for all downstream):
   - settle:      `cargo prove build --bin confidential-pool-prover` → copy to `elf/cxfer-guest`
   - reflection:  `cargo prove build --bin reflection-prover`        → copy to `elf/reflection-prover`
   - eth-reflection (only if the reflection/eth guest changed): `cd ../eth-reflection && cargo prove build --bin eth_reflection`. If rebuilt, its recursion vkey changes ⇒ update `ETH_REFLECTION_VKEY` in `reflect.rs` and **rebuild reflection-prover in lockstep** (per CHECKLIST-mainnet-reprove.md items 1–2).
3. **Derive vkeys** from the just-built ELFs (copy ELF to the harness include path first, then run an exec harness which prints `PROGRAM_VKEY`; eth recursion vkey via `eth-reflection/prover-host/eth_vkey`).
4. **Re-pin ATOMICALLY**: update `elf-vkey-pin.json` (program_vkey, bitcoin_relay_vkey, eth_reflection_vkey + all three `elf_sha256`) **in the same commit as the ELF binaries** (the process rule that was violated last round). Run `./verify-vkey-pin.sh`.
5. **Regenerate fixtures** at the new vkeys: `./build-all-network.sh` (prover-bins) + `./gen-all-reflection-fixtures.sh`; then MODE=execute smoke on changed ops (serializer/witness parity).
6. **ON-CHAIN GATE (do not skip):** run the `*ProofReal` forge suites — they verify a real Groth16 proof of the new ELF against `0xb69f2584`. GREEN ⇒ toolchain+vkey are deployable. RED ⇒ STOP (toolchain/circuit mismatch — need the exact prod toolchain or `--docker`).

## REDEPLOY
7. Fill `redeploy-v3.env`: `PROGRAM_VKEY`/`BITCOIN_RELAY_VKEY` from the new pin; 6 salts from the mine.
8. **Re-verify the anchor**: if relay advanced past 958741, walk `relay.tip()−6` for the new matured hash and fold `nearseed-kv-958735.json` forward that SMALL delta; update `GENESIS_REFLECTION_ANCHOR` + `REFLECTION_RESUME_DIGEST` to match. (If reflection guest logic changed, re-derive the seed digest against the updated JS indexer first.)
9. **Dry-run** (no broadcast): `forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX --rpc-url $RPC --sender 0x68575B…` → must print all vanity addresses + "Script ran successfully."
10. **Broadcast** with the deployer key: `--broadcast --slow --private-key <box NETWORK_PRIVATE_KEY>`. Verify on Etherscan.
11. Confirm on-chain: new pool `knownReflectionDigest` (slot 80) == `REFLECTION_RESUME_DIGEST`.

## POST-DEPLOY
12. Publish **prover-bins-v3** (new-vkey exec-* + bitcoin_prove; keep bitcoin_prove at cycle_limit 4B), update `worker-relay/prover/bin/SHA256SUMS` + Dockerfile `PROVER_RELEASE`.
13. Seed the folder from `nearseed-kv-958735.json`; repoint worker `POOL_ADDR` to the new pool; resume folding (first attest = small incremental batch).
14. Update `deployments/1.json` + `dapp/confidential-deployments.generated.js` (pool/router/engine/deployBlock) + docs; commit.

## Safety gates (all must be green before broadcast)
`verify-vkey-pin.sh` · `*ProofReal` on-chain verify · deploy dry-run vanity assertions · slot-80 digest check post-deploy.

### Audit-response gates (Opus 5 r2)
- **F-1 LAUNCH-BLOCKER — OP_SWAP_BLIND end-to-end validation.** The op-31 dispatch arm is live in the immutable
  vkey and is armable off-chain later (no redeploy). It must NOT reach a live emitter until its groth16.rs gate
  **item 3** is closed: an end-to-end `MODE=execute` OP_SWAP_BLIND run over a full real envelope against the new
  ELF (arming ladder step 5 below). Items 1/2/4 are DONE against the burned key. Until step 5 is GREEN, ship NO
  op-31 emitter (dapp/worker). Conservation is Rust-enforced and tips fail-closed regardless, so an un-emitted
  live arm is bounded — but the emitter is gated on step 5.
- **O-1 deploy check.** `BitcoinLightRelay._verifyPow`/`_bitsToTarget` are `virtual` (test-mock hook). Confirm the
  DEPLOYED bytecode is `BitcoinLightRelay` itself, not a PoW-disabling subclass — assert in the deploy dry-run.
- **L-1 irreversible relay params (verify before broadcast, un-fixable after).** `genesis(startTimestamp)` off by
  one second permanently mis-targets the first retarget — derive from the real first-block header, cross-check
  two explorers. `MAX_TARGET` is network-specific — confirm the mainnet value. Confirm EIP-170 headroom (pool
  bytecode pin shows a thin margin) so the deployed bytecode is under 24,576 B.
- **H-2 (optional, blind-swap defense-in-depth).** `groth16.rs` `g2()` trusts the `bn` dependency's
  `check_order()` default for G2 subgroup safety. If the op-31 path arms (item-3 GREEN), consider an explicit
  in-guest `is_in_subgroup`/cofactor check in `g2()` rather than delegating to the dependency default. Dormant
  until armed; not a blocker.

### GPT-round findings (reflection guest — ride this reprove)
- **C-01 (was Critical) FIXED — scan-free burn censorship.** The burn-deposit consumed-outpoint gate now proves
  its presence verdict (member→skip, non-member→fold, lying witness→ABORT) instead of silently skipping on a
  prover-supplied bad path. **Box work:** the reflection witness emitters must supply the new `co_is_member`
  bit + the matching membership/non-membership witness per burn-deposit; add the negative vectors (absent+bad
  path → abort; present+claimed-absent → abort; competing malicious/honest proofs → only the valid one accepted).
- **H-01 (was High) FIXED — Bitcoin AMM intent authorization.** T_SWAP_VAR / T_SWAP_ROUTE / T_SWAP_BATCH folds
  now BIP-340-verify the trader's intent (destination, min_out, tip, expiry, input cross-curve for batch) with
  builders KAT-pinned to the worker. **Box work:** end-to-end MODE=execute vectors per opcode (valid folds;
  bad-sig / expired / substituted-c_in_bjj / redirected-receipt all abort). The T_SWAP_ROUTE destination binding
  is RESOLVED (the route intent binds the receipt P2TR dest; guest+worker+dapp) — no SIGHASH
  dependency. See ops/SPEC-btc-amm-intent-auth.md.

### C-01 GATE — predecessor drain (generational deploy only; the ONE-FUNDED-GENERATION invariant)

This deploy is a **generational resume** (non-zero reflection genesis digest joining the SHARED Bitcoin
lineage — `ConfidentialPool.sol:827`). Single-use claim state is per-pool, so the same Bitcoin source can be
honored by two pools that share a lineage. The invariant is **at most one funded generation live per lineage**;
the successor accepts value only after the predecessor is drained. "Drained" is publicly checkable — you do NOT
need to see any private notes, only the on-chain **backing**:

**Assert on the PREDECESSOR pool, before the successor accepts any value (deposit / wrap / bridge-mint):**
1. `escrow[assetId] == 0` for EVERY registered asset id (the `escrow` mapping, `ConfidentialPool.sol:261` — the
   underlying that unwraps/mints redeem against). Enumerate the predecessor's registered assets and read each
   slot; any non-zero balance = NOT drained.
2. Every **pool-minted** canonical token's `totalSupply() == 0` (bridged/CDP assets minted by the predecessor
   — a live supply is redeemable liability). cUSD is engine-keyed, so check the predecessor engine's cUSD too.
3. `farmTreasury[controller] == 0` for any funded farm controllers (reward backing).

Only when 1–3 are all zero is a duplicate claim in the successor unbacked (`InsufficientEscrow` / no supply).
Record the predecessor address + the zeroed balances in the deploy log. A third party's shadow pool does NOT
trigger this gate (its value is its own, isolated) — the gate is purely about not funding two of OUR
lineage-sharing pools concurrently.

## Round-3 dormant-op arming (rides the reprove/box cycle — NO guest change)

Both are guest-complete and already in the vkey; arming is off-chain plumbing + fixture regen that
needs the box anyway. Neither rotates a vkey beyond the reprove itself.

### OP_SWAP_BLIND (31) — arm at tips=0 (self-settle)
Guest ships dormant but present in PROGRAM_VKEY; per-asset relay tips are FAIL-CLOSED at 0
(`swap_blind.rs`), so arming at tips=0 uses the already-validated zero-fee-floor path — no circuit or
guest change. Gasless-relay tips stay dormant (need a ceremony revision; self-settle is the v1 scope).
Feasibility confirmed: `dapp/circuits/ceremony-genesis-amm/amm_swap_batch_0000.zkey` + `dapp/vendor/amm_swap_batch.wasm` present.
Ladder (all off-chain):
1. **Emitter (JS)** — `openingPokBlind` JS mirror + 1-intent op-witness builder; generate the inner
   `amm_swap_batch` Groth16 via snarkjs.fullProve(wasm, zkey) (extend `dapp/confidential-swapbatch.js`,
   which today only verifies); assemble the OP_SWAP_BLIND settle stdin with tip_a=tip_b=0.
2. **Harness** — `harnesses/exec-swapblind.rs` (include_bytes the reprove ELF; feed the emitter's stdin).
3. **Worker decoder** — decode/classify OP_SWAP_BLIND (worker side).
4. **Fixture** — self-constructible 1-intent accept/DIGEST fixture (`fixtures/swapblind_op.json`).
5. **Box e2e (at reprove)** — build harness vs new ELF → prove tips=0 1-intent batch → on-chain accept
   + forgery-reject checks (tamper Groth16 / sigma / aggregate identity all reject). GREEN ⇒ armed.
   **CRITICAL zkey gate:** the inner amm_swap_batch Groth16 MUST be generated with the **FINALIZED ceremony
   zkey** (VK == guest's baked `fixtures/swap_batch_vk.json`, ceremony hash `2d9db81d…`, via
   `_fetchAmmZkey('swap_batch')`). The repo's genesis `amm_swap_batch_0000.zkey` has a DIFFERENT VK → a proof
   under it is guest-REJECTED. The emitter + parity test are zkey-agnostic (validate under any key); the box
   e2e is the first place the finalized zkey is required. Confirm it's available before the run.
DONE (agent, JS-mirror validated, 12 checks + forgery negatives): emitter `dapp/confidential-swapblind.js`
(+ prove side in `confidential-swapbatch.js`), test `tests/confidential-swapblind.mjs`; harness
`harnesses/exec-swapblind.rs` already exists (pins the write order to main.rs:1665). STILL TO PREP: worker
decoder. AT REPROVE: build harness vs new ELF + the box e2e with the FINALIZED zkey.

### LP_BOND — fixture regen only
Guest-complete + reprove-ready. Only needs the `protocolFeeBps`/recipient fixture regenerated
(`fixtures/lpbond_op.json`, `lp_protofee_op.json`, `reflection_lpbond.json`) — which
`gen-all-reflection-fixtures.sh` + the `*ProofReal` regen already do in the reprove. No new code.
