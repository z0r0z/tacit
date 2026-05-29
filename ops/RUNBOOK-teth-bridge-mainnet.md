# tETH Bridge — Mainnet Deploy / Re-prove / Withdraw Runbook

Companion to `ops/AUDIT-teth-bridge-mainnet-readiness-2026-05-29.md`. This is the
ordered procedure to take the bridge from "code fixed on branch
`bridge-mainnet-readiness`" to a live, withdraw-validated deployment, plus the
two accepted-risk limitations and their recovery procedures.

The wrapper goal it must satisfy end to end: **Alice deposits 1 ETH → 1 tETH;
Alice sends Bob 0.1 tETH; Bob exits 0.1 tETH → 0.1 ETH on Ethereum.**

---

## What changed on this branch (and why it gates the deploy)

| Fix | File(s) | Why it gates deploy |
|---|---|---|
| G2 coordinate swap committed as source of record | `contracts/src/TacitBridgeMixer.sol:_verifyProof` | A clean checkout / CI / mainnet build must compile the swapped (precompile) order; the native order rejects every real ceremony burn proof → all withdrawals brick. |
| SP1 guest hardening committed | `contracts/sp1/program/src/main.rs` (u64-denom assert, pairwise-distinct denoms, `checked_add`), `bitcoin.rs` | Must be in the ELF that is built + pinned + deployed; an unhardened ELF allows the low-64-bit denom-collision and unchecked-add footguns. |
| `overflow-checks = true` (guest release profile) | `contracts/sp1/program/Cargo.toml`, `script/Cargo.toml` | Defense-in-depth: any non-`checked_*` arithmetic traps instead of wrapping in a proof. |
| Verifier `require(<=16)` denoms | `contracts/src/SP1PoolRootVerifier.sol` | Matches the guest's 1–16 bound; prevents a `NUM_DENOMS` (uint8) misconfig that would silently break proving. |
| Deploy fails closed without real verifiers | `contracts/script/DeployTestnet.s.sol` (`ALLOW_MOCK_VERIFIERS`) | A funded deploy that forgets `SP1_VERIFIER`/`BURN_VERIFIER` must revert, never silently wire a mock that accepts any proof. |
| ELF↔vkey pin + verifier | `contracts/sp1/elf-vkey-pin.json`, `verify-vkey-pin.sh` | Binds the committed ELF to `PROGRAM_VKEY`; a rebuild that desyncs them bricks `proveStateTransition`. |
| Dapp rotate/import leaf routing + integrity gate | `dapp/tacit.js` (`_verifyBridgeRotateImportLeaf`, apply loop, burn/export/rotate gate) | Without it, a transfer/import leaf truncated every user's local pool tree → redemption-after-transfer broke. The integrity gate refuses to spend a nullifier into a tree that failed re-verification. |
| Dapp fractional send (T5) | `dapp/tacit.js` (`bridgeSendFractional`, `_bridgeEthToWei`, send-UI branch), `dapp/index.html` (amount field) | Wires export(0x63)→CXFER-split→recipient so a fraction (Bob's 0.1) can be sent and redeemed. **Unvalidated in CI — requires the signet round-trip below.** |
| CI guards | `.github/workflows/bridge-guards.yml` | Runs the real-proof suites + ceremony VK pin + ELF pin on every PR. |

---

## Phase 0 — Pre-deploy (source of record + ELF)

1. **Commit the branch** so the source of record carries every fix:
   ```
   git checkout bridge-mainnet-readiness
   git add -A && git commit   # G2 swap, guest hardening, verifier/deploy/CI/dapp changes
   ```
2. **Rebuild the hardened guest ELF on the vast.ai prover host** (Docker or
   native-gnark toolchain present there; not available in the dev sandbox):
   ```
   cd contracts/sp1 && ./build-guest.sh        # → program/elf/teth-pool-prover
   (cd script && cargo run --release --bin vkey)   # → new PROGRAM_VKEY
   ```
3. **Update the pin in the same commit** and re-derive the burn VK hash:
   - set `elf_sha256` + `program_vkey` in `contracts/sp1/elf-vkey-pin.json` to the
     rebuilt ELF's values; flip `guest_state` to "HARDENED".
   - `GROTH16_VK_HASH` = `sha256(arkworks-uncompressed VK bytes)` (the guest's
     `vk_hash`); the host prints it. This is unchanged unless the ceremony key
     changes — and **the ceremony does not change** (no new ceremony).
   - commit the rebuilt ELF + updated pin together.
4. **Run the guards green** (locally and in CI):
   ```
   bash contracts/sp1/verify-vkey-pin.sh        # PASS sha256 + (on prover) vkey
   cd contracts && forge test --no-match-test invariant
   forge test --match-contract "Groth16VerifierReal|BridgeWithdrawRealProof" -vvv
   node ../tests/ceremony-vk-pin.test.mjs
   cd ../contracts/sp1/tree && cargo test
   ```
   All must pass. The CI workflow `bridge-guards.yml` runs the same on PR.

---

## Phase 1 — Deploy (atomic, fail-closed, real verifiers)

The mixer and the SP1 verifier are **mutually address-bound** (the verifier's
ctor takes the predicted mixer; the mixer ctor takes the verifier and checks
`coversPool`/`ASSET_ID`/`MIXER`). They MUST deploy together in one script run.

1. Export real-verifier env (NO mocks):
   ```
   export DEPLOYER_PRIVATE_KEY=0x...            # funded
   export SEPOLIA_RPC=<public RPC>
   export SP1_VERIFIER=<Succinct SP1 gateway, matching sp1-sdk 6.x>
   export SP1_PROGRAM_VKEY=<new PROGRAM_VKEY from Phase 0>
   export GROTH16_VK_HASH=<guest vk_hash>
   # BURN_VERIFIER unset → script deploys a fresh ceremony-key Groth16Verifier
   # Do NOT set ALLOW_MOCK_VERIFIERS.
   ```
2. Set the relay genesis anchor (`BTC_TIP_*`) to a **fresh** signet block so the
   prover has a short catch-up. The deploy preflight refuses a dirty bridge tree
   and re-checks the ELF pin before broadcasting.
3. Deploy:
   ```
   cd contracts && ./deploy-testnet.sh          # Sepolia + signet (TestnetLightRelay)
   ```
   Record the four addresses from `broadcast/DeployTestnet.s.sol/11155111/run-latest.json`.
4. **Verify on-chain wiring** (cast):
   - `mixer.BURN_VERIFIER()` == the deployed ceremony `Groth16Verifier`.
   - `verifier.PROGRAM_VKEY()` == `SP1_PROGRAM_VKEY`; `verifier.MIXER()` == mixer.
   - `verifier.SP1_VERIFIER()` == the genuine Succinct gateway (revert-on-invalid).
   - the deployed `Groth16Verifier` runtime VK == ceremony key (re-run the pin
     test against the on-chain bytecode, not just the source file).

---

## Phase 2 — Re-prove from genesis (vast.ai)

A new `PROGRAM_VKEY` invalidates any prior proven state. The verifier starts at
genesis (`currentState.lastBlockHash == GENESIS_ANCHOR_HASH`, `poolsHash` = empty
roots). The prover must advance it from there to the relay tip.

1. On the vast.ai box (working prover instance), point the prover at the new
   verifier + relay + the same `GENESIS_ANCHOR` the verifier was deployed with.
2. Run the supervised prover loop (`sp1-prover-loop.sh` / `run-prover.sh`):
   - it reads the relay tip, builds the guest stdin from genesis, proves, and
     submits `proveStateTransition`.
   - the verifier's genesis pool state MUST equal the prover's first
     `prev_pools_hash` (empty roots) or the first proof reverts `StateMismatch`.
3. Confirm `verifier.currentState()` advances and `stateHeight` climbs to the
   relay tip. Re-anchor cadence: the prover proves exactly to `RELAY.tip()`.

> Gotchas (see `reference_vast_prover_access` memory): the `id_ed25519` key has a
> passphrase; never delete the working vast key; logs API gives shell-free
> visibility if SSH/proxy propagation is flaky.

---

## Phase 3 — Validate (the two round-trips that gate mainnet value)

### 3a. The definitive deploy test — one real `withdrawFromBurn`
This is the single check that proves the G2 fix + the real verifier + the
re-proven state all line up on-chain (the audit's #1 outstanding item; never yet
done live):
1. Deposit one whole denomination (e.g. 0.001 ETH) → broadcast the 0x60 mint on
   signet → wait for the prover to accept it (`stateHeight`/`poolsHash` advance).
2. Burn that note (0x61) on signet → wait for the prover to mark the burn claim
   (`isAcceptedBurn(claimId)` true).
3. Call `withdrawFromBurn` from the dapp (`bridgeWithdrawETH`) after ≥6
   confirmations. **It must release exactly the denomination to the recipient.**
   If it reverts `InvalidGroth16Proof`, the deployed mixer has the wrong G2 order
   (re-check Phase 0/1). If `UnprovenRoot`, the prover hasn't accepted the burn.

### 3b. The T5 fractional round-trip (Alice→Bob 0.1) — gates the dapp send
With two wallets A (Alice) and B (Bob):
1. **A:** deposit 1 ETH → one 1-ETH pool note (mint accepted by the prover).
2. **A:** in the bridge Send box, recipient = B's tacit pubkey, amount = `0.1` →
   routes to `bridgeSendFractional`:
   - EXPORT (0x63) the 1-ETH note → A's tETH UTXO (confirm + appears in holdings).
   - CXFER-split → 0.1 to B + 0.9 change to A. Verify A now holds a 0.9 tETH UTXO.
3. **B:** scan / "Recover Notes" → discovers the 0.1 tETH UTXO from B's key alone.
4. **B:** redeem 0.1 via `bridgeQuickBurnFromHoldings(denom=0.1)` → import (0x64) →
   burn (0x61) → wait for prover acceptance → `withdrawFromBurn` → **0.1 ETH to B**.
5. **Conservation check:** A locked 1 ETH; after the round-trip B redeemed 0.1 and
   A holds 0.9 redeemable; no pool's escrow went negative; total released ≤ deposited.

Only after **both** 3a and 3b pass on signet should the same artifacts be
promoted to a mainnet deploy (real `BitcoinLightRelay` with full PoW via
`Deploy.s.sol` / `deploy-sepolia.sh`, which already fails closed on unset
verifiers).

---

## Accepted-risk limitations (documented, not code-gated)

### A. Deep Bitcoin/signet reorg permanently wedges state advancement
`proveStateTransition` requires the proven tip to chain from the prior anchor AND
equal `RELAY.tip()`. A reorg deeper than the proven point orphans the anchor, and
both contracts are immutable (no re-anchor/owner/pause). **Accepted as a rare
risk** per project decision (keeps zero-admin trustlessness). On signet a signer
*can* force this; on mainnet it requires a >confirmation-depth reorg.
- **Detection:** `proveStateTransition` begins reverting `StateMismatch`/`NotRelayTip`
  and never recovers; `verifier.stateHeight` stops advancing while the relay tip moves.
- **Recovery (no funds lost, but a redeploy):** redeploy the full suite
  (verifier + mixer, address-bound) anchored at a post-reorg block, and re-prove
  from genesis (Phase 1–2). Escrowed ETH in the *old* mixer is stranded — so on
  signet, prefer a fresh relay anchor and keep test value small until mainnet.
- **Pre-staged:** this runbook IS the recovery procedure; keep the deployer key
  + vast.ai prover ready to re-run Phase 1–2 on short notice.

### B. Pool-tree exhaustion (depth-20 capacity)
Each denomination's guest pool tree holds 2²⁰ (~1.05M) lifetime leaves
(mint + rotate + import; nothing frees a slot). The withdraw circuit's depth is
fixed at 20 and the ceremony is finalized — **raising it needs a new ceremony,
which we are not doing.** At ~1M lifetime ops/denomination this is a long-tail
limit, accepted like the reorg risk.
- **Safety property (verified in source):** a full-pool mint/rotate/import
  `continue`s *before* consuming the nullifier (`main.rs` mint 264<265, rotate
  289<290) or removing the UTXO (import 381<382) — so an exhausted pool never
  burns a nullifier or destroys a UTXO. The only loss mode is on-chain `deposit()`
  ETH that can't be minted post-exhaustion.
- **Monitoring:** alert when any denomination's proven leaf count approaches, say,
  90% of 2²⁰; at that point stop accepting new deposits for that denomination
  (off-chain/UI gate) and migrate to a fresh pool.
- **Follow-up (not launch-gating):** expose the proven per-pool leaf index
  on-chain and gate `deposit()` on it, so deposits hard-revert at capacity rather
  than relying on the off-chain monitor. (Requires a public-values layout change +
  ELF rebuild — schedule alongside the next planned guest rebuild.)

---

## Go / no-go

- [ ] Branch committed; `bridge-guards` CI green (real-proof suites, ceremony pin, ELF pin).
- [ ] Hardened ELF rebuilt on vast.ai; `elf-vkey-pin.json` updated + committed; `verify-vkey-pin.sh` passes the vkey leg on the prover host.
- [ ] Deployed with real `SP1_VERIFIER` + ceremony `Groth16Verifier` (no mocks); on-chain wiring verified by cast.
- [ ] Re-proven from genesis to the relay tip; `stateHeight` tracking the tip.
- [ ] **3a** real `withdrawFromBurn` released funds on signet.
- [ ] **3b** Alice→Bob 0.1 fractional round-trip released 0.1 ETH to Bob; conservation checked.
- [ ] Reorg + exhaustion monitoring/runbook in place.

Only with all boxes checked is the bridge ready for mainnet value.

---

## Handoff state (2026-05-29) — greenlight checklist

**Where things stand:**
- `main` @ `22086ad` (pushed): all bridge fixes + orderbook merged; 88 forge + 12 tree + 6 ceremony-pin green.
- Guest **source is hardened**; T5 fractional send wired; deploy/CI guards in place.
- The committed guest **ELF is still the OLD unhardened binary** (`dd37628d…`). The rebuilt hardened ELF exists on vast.ai but is **not yet committed** — Phase 0 below makes the hardening real.
- Fund safety: **T1–T4 sound by design**. T5 fractional send: code-complete, **never validated live**.

**Rebuilt-guest parameters (from vast.ai, to pin in Phase 0):**
- `PROGRAM_VKEY` = `0x00cb226ed9b6e565f1230f47da2b0a31cf961ae96b5b1a8f09ce8fc459e21243`
- ELF sha256 = `dfc84ff8…` (verify the full hash from the actual bytes on copy-in)
- `GROTH16_VK_HASH` = `0x0eabe508c630aea06f0db1f05dbd456e9f82df739bcc84d644a7533db0691edb` (unchanged — burn vk is the ceremony Groth16 key, untouched by guest hardening)

### Phase 0 — finish the ELF/pin commit (in flight)
- [ ] Copy the rebuilt ELF from vast.ai into `contracts/sp1/program/elf/teth-pool-prover`.
- [ ] Update `contracts/sp1/elf-vkey-pin.json`: `elf_sha256` = full `dfc84ff8…`, `program_vkey` = `0x00cb226e…21243`, `guest_state` → HARDENED.
- [ ] `bash contracts/sp1/verify-vkey-pin.sh` passes (sha256 + vkey legs).
- [ ] Commit the rebuilt ELF + pin **together**; push.

### Phase 1 — testnet deploy (Sepolia + signet)
- [ ] Deploy real verifiers, fail-closed (no `ALLOW_MOCK_VERIFIERS`): `SP1_VERIFIER`=Succinct gateway, `SP1_PROGRAM_VKEY`=`0x00cb226e…`, `GROTH16_VK_HASH`=`0x0eabe508…`, fresh ceremony `Groth16Verifier`. Mixer + verifier deploy atomically (address-bound).
- [ ] Verify on-chain wiring by cast (BURN_VERIFIER, PROGRAM_VKEY, MIXER, SP1_VERIFIER == genuine gateway; deployed Groth16Verifier runtime VK == ceremony key).
- [ ] Re-prove from genesis to the relay tip with the new ELF; `stateHeight` tracks tip.
- [ ] Update dapp `TETH_DEPLOYMENTS` + e2e `MIXER_ADDRESS`.

### Phase 2 — the two live validations (gate value; neither ever done live)
- [ ] **3a** real `withdrawFromBurn` releases the exact denomination (revert `InvalidGroth16Proof` ⇒ G2/deploy wrong; `UnprovenRoot` ⇒ prover hasn't accepted).
- [ ] **3b** Alice deposits 1 ETH → sends Bob 0.1 → Bob imports+burns → `withdrawFromBurn` releases 0.1 ETH; conservation checked.
- [ ] `bridge-guards` CI green on the deployed artifacts.

### Phase 3 — mainnet promotion (only after Phase 2)
- [ ] Deploy the mainnet variant: **real `BitcoinLightRelay` with full PoW** (not `TestnetLightRelay`), mainnet Bitcoin genesis anchor, tETH asset etched on the target Bitcoin network, prover pointed at it. ⚠️ Confirm "mainnet" = Ethereum mainnet + Bitcoin **mainnet** settlement and stage the relay genesis + asset accordingly.
- [ ] Re-run 3a + 3b with small real value on the mainnet stack.
- [ ] Operational readiness: prover liveness monitoring; reorg-recovery runbook staged; tree-exhaustion monitor (~90% of 2²⁰ per denom); signet cron-freeze awareness.

### Accepted risks (documented; sign off)
- [ ] Deep reorg wedges state advancement (recovery = redeploy + re-prove). Accepted as rare.
- [ ] Pool-tree exhaustion (depth-20, ~1M ops/denom — impractical to grief on mainnet; guest never burns a nullifier/UTXO on a full tree). Optional on-chain deposit-gate is a **post-launch** follow-up — NOT the timeout-reclaim, which can rug tETH (cross-chain mint-after-reclaim).
- [ ] WD-1 worker leaf-omission mitigated by the integrity gate; multi-indexer resistance is a follow-up.

**Greenlight = every box above checked.** The hard gates are Phase 0 (make the hardening real) and Phase 2 (the two live round-trips) — the things genuinely never exercised end to end.
