# RUNBOOK — Resume the Sepolia-freeze coordinated re-prove

Checkpoint of the in-progress full box re-prove (paused: prover box out of credit / exited). Everything
local is staged in the working tree; the box disk persists the synced source + rebuilt ELFs. This is the
exact path to finish.

## State at pause

- **New PROGRAM_VKEY (derived, settle guest):** `0x00fdf97302e3224c4574fa12edc463c8163b4715bcc44ada457499d31e4d5f1a`
  (rotates from the pinned `0x00bf15b2…`). The BITCOIN_RELAY_VKEY rotates too but wasn't captured yet —
  it prints from the first reflection prove (`BITCOIN_RELAY_VKEY=…`).
- **New ELF shas (rebuilt on box from the current source):** settle `cxfer-guest` =
  `fdeeb7d95eca08136e56ec37a09fe3b50c8fd5e707d7704f4883844d028d7334`; reflection `reflection-prover` =
  `1173ede85b00fcbbc5ff66200e82d9a270ada34ad9f9c55db1642b74f070900f`.
- **Box:** vast id `38922877` (RTX 4090), SSH `root@ssh9.vast.ai:12876`, key `~/.ssh/vast_prover`. Disk
  persists `/root/work/cxfer/{cxfer-core,guest,exec,harnesses,fixtures}` with the CURRENT source (shas
  verified == local). The apply-script default `ssh8:27240` box has exited — override BOX/PORT to the live one.
- **Done:** source synced + verified, ELFs rebuilt, program vkey derived, driver mechanism debugged.
- **Workaround baked in:** this box's **sp1-cuda 6.2.3 returns empty `public_values` from the GPU groth16
  proof**. The harnesses are patched to capture the (deterministic) PV via a `client.execute(stdin.clone())`
  pass written to `/root/work/cxfer/exec/pv_override.hex`; the driver sources PV from there and proofBytes
  from the groth16 output. (Search `pv_override.hex` in `contracts/sp1/confidential/harnesses/exec-*.rs`.)

## Staged in the working tree (uncommitted)

- `scripts/full-reprove-v1.sh` — the box-native driver, **22 ops** (19 settle + 2 reflection + the new
  `bridge_stealth_mint`), per-op GPU/shm reset, EXPECT_VKEY guard handled, dual-pass PV.
- Patched harnesses: every `contracts/sp1/confidential/harnesses/exec-*.rs` the driver uses (+ parent
  `exec-{crosslane,gap,farm,reflect-prove}.rs`) carries the `pv_override` PV-extract.
- `contracts/sp1/confidential/fixtures/bridgestealthmint_op.json` + `tests/gen-bridgestealthmint-fixture.mjs`
  (the new op-input fixture + its generator — real pool + bridge-burn-set membership).
- `contracts/test/ConfidentialBridgeStealthMintProofReal.t.sol` — gated forge test (self-skips until the
  fixture lands; auto-verifies after apply).

## Resume steps

1. **Restart the box** (billable): `PUT /api/v0/instances/38922877/` `{"state":"running"}`; read the
   reassigned `ssh_host:ssh_port`. Confirm `df -h /dev/shm` (0%) + `nvidia-smi` (no VRAM orphan); if dirty,
   `pkill -9 sp1-native-runn; rm -f /dev/shm/sp1* /dev/shm/sem.sp1*`.
2. **Re-sync the staged prep** (the last sync didn't land before the exit):
   ```
   cd contracts/sp1/confidential
   tar czf /tmp/sync.tgz harnesses/exec-*.rs exec-crosslane.rs exec-gap.rs exec-farm.rs exec-reflect-prove.rs fixtures/bridgestealthmint_op.json
   scp -P <port> -i ~/.ssh/vast_prover /tmp/sync.tgz scripts/full-reprove-v1.sh root@<host>:/root/work/cxfer/
   ssh … 'cd /root/work/cxfer && mkdir -p /tmp/s && tar xzf sync.tgz -C /tmp/s && cp -f /tmp/s/harnesses/*.rs /tmp/s/exec-*.rs harnesses/ && cp -f /tmp/s/fixtures/*.json fixtures/'
   ```
3. **Smoke ONE op** to confirm the dual-pass writes non-empty PV:
   `ONLY=swap TO=540 bash full-reprove-v1.sh` → expect `out-v1/swap_pv.hex` non-zero + manifest `swap … OK`.
4. **Launch the full run detached:** `REBUILD=1 setsid nohup bash /root/work/cxfer/full-reprove-v1.sh > /root/full-reprove.out 2>&1 < /dev/null &`
   (REBUILD=1 only if the ELFs need rebuilding; they're current now so REBUILD is optional). Poll:
   `grep -E 'OK|FAIL|REPROVE_DONE' /root/work/cxfer/reprove-v1.status`. ~2–4h GPU.
5. **Capture the relay vkey** from the reflection op log (`BITCOIN_RELAY_VKEY=…`), and confirm the settle
   vkey in the manifest == `0x00fdf973…`.
6. **Pull + apply.** `out-v1/<tag>_{pv,pb}.hex` per op. Use `scripts/confidential-reprove-apply.sh` with
   BOX/PORT overridden, and **extend its `MAP`** (currently only 8 ops) to all 22 (each `tag:<fixture>_groth16.json:settle|reflection`).
   Apply updates the committed ELFs, `elf-vkey-pin.json` (4 fields), `verify-vkey-pin.sh` FROZEN guards,
   `DeployConfidentialPool.s.sol` + `DeployV1Suite.s.sol` `DEFAULT_VKEY`, and every `*_groth16.json` fixture.
7. **Verify:** `bash contracts/sp1/confidential/verify-vkey-pin.sh` (green) → `forge test --match-contract 'ProofReal'`
   (all green, incl. the now-active `ConfidentialBridgeStealthMintProofReal`) → `bash contracts/sp1/confidential/readiness-gate.sh`
   (POOL+BRIDGE+DAY1). Then the freshly-pinned pool is the Sepolia/mainnet candidate.

## BLOCKER found on resume (2026-06-23): sp1-cuda 6.2.3 strips public_values

The guest runs correctly (gpu-server logs nbConstraints≈15.97M — a real proof) and the proof is valid
(server-side `verifier done`), but **every** client path on this box returns EMPTY `proof.public_values`:
groth16, compressed, AND `execute()`. sp1-sdk/sp1-cuda is pinned to **6.2.3**; **6.2.2 is also cached**
(`~/.cargo/registry/src/*/sp1-cuda-6.2.2`). The Jun-10 fixtures (non-empty PV) were built on the older sp1,
so this is a 6.2.x regression — the dual-pass (PV from a non-groth16 proof) CANNOT work on 6.2.3 because no
proof type exposes the PV. The new PROGRAM_VKEY (0x00fdf973…) was still derived fine (vkey doesn't need PV).

Confirmed empty PV on groth16 AND compressed AND `execute()` — across every client path. The PV is NOT
needed to derive the vkey (already have it), only to assemble the `*_groth16.json` fixtures.

**Candidate fixes:**
1. ~~Partial 6.2.2 pin~~ — **TRIED, FAILS:** pinning only sp1-sdk+sp1-cuda to 6.2.2 leaves sp1-prover/
   recursion at 6.2.3 and `sp1-recursion-gnark-ffi v6.2.3`'s build script errors (version mix). A CLEAN 6.2.2
   would need every sp1 crate at 6.2.2 + gnark artifacts (network) + a 6.2.2 gpu-server (box has 6.2.3) +
   likely a guest rebuild on the 6.2.2 toolchain → a NEW vkey. Cascading; not a quick fix. (Box reverted to
   the known-good 6.2.3 build.)
2. ~~JS-derived PV~~ — **INVALID.** The dapp does NOT compute `publicValues` itself; `confidential-relay.js`
   gets `{publicValues, proof}` BACK FROM THE BOX (the guest commit). There is no JS source of the PV. (This
   also means the 6.2.3 empty-PV is a latent risk for the box's PRODUCTION settle loop — verify whether the
   live cps loop currently returns non-empty PV; if it does, its exec binary was built with the working sp1
   and that build/lock is the fix.)
3. **Resolve the box sp1 toolchain to the working version (the real fix).** The guest commits correctly
   (`main.rs:3151 io::commit_slice(&pv.abi_encode())`); the box's **sp1-cuda 6.2.3 client returns 0-byte
   `public_values`** despite the commit. The Jun-10 fixtures (non-empty PV) were built before the lock moved
   to 6.2.3. Fix = a CONSISTENT sp1 downgrade to the Jun-10 version across: the guest build toolchain
   (`cargo prove`), the exec + prover-host crates (Cargo.lock — all sp1 crates incl. sp1-recursion-gnark-ffi),
   and the `sp1-gpu-server` binary (box has 6.2.3). Then re-derive the vkey (a toolchain change MAY move it),
   confirm v6.1.0-groth16-verifier compatibility (the on-chain verifier is vendored v6.1.0), and resume from
   step 3. This is focused prover-infra work for a dedicated session, not a quick patch. (Partial 6.2.2 pin
   fails to build — must be consistent.)

## Gotchas (from this run)

- Settle harnesses have a vkey **drift guard** requiring `EXPECT_VKEY`; the driver sets it to the new
  `0x00fdf973…`. Reflection uses `SKIP_VKEY_ASSERT=1` (it ESTABLISHES the new relay vkey).
- The cuda client **panics in a destructor during cleanup** AFTER writing artifacts — harmless; the driver
  checks artifacts + `LOCAL_VERIFY_OK`, not the exit code.
- `cdp_liquidate` has no per-op harness → proven via `exec-gap.rs GAP_OP=17`. Farm ops via `exec-farm.rs`.
- Op-input fixtures are NOT stale (the guest accepts them; the only issue was the groth16 PV).
