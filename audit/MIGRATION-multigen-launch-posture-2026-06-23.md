# Tacit — Multi-Generational Deployment & Capped-Launch Posture

**Companion to** `AUDIT-2026-06-23-tacit-v1-confidential-defi-bridge.md`.
**Question addressed:** can the immutable ConfidentialPool + immutable SP1 prover launch as a **capped pilot**,
and can intact value (Tacit assets + notes) later **migrate into a second, patched pool generation**, so the
protocol iterates generationally without stranding funds?

**Verdict: yes — with constraints, and no new on-chain hook is required for fund safety.** Caps are dapp /
convention / social, by design (no on-chain cap or pause). This document records the migration model, the
per-asset verdicts, the iteration playbook, the gen-2 deploy-coherence checklist, and the pilot's
known-unknowns.

---

## 1. Why it works: durable state on Bitcoin, disposable execution on Ethereum

The design treats an **Ethereum pool generation as a disposable execution layer** and **Bitcoin/Tacit as the
durable state layer**. Two structural properties make generational iteration safe:

- **Exits are permissionless and ungated.** `settle()` / `_payout()` carry no owner, pause, cap, or live-flag
  on-chain (`ConfidentialPool.sol`), so no operator can ever trap funds, and a deprecated generation stays
  **self-custodially redeemable forever** ("deprecate-don't-brick" — already proven live by the multi-generation
  tETH mixer). Escrow is 1:1 reserved and fail-closed.
- **A fresh generation can join the shared Bitcoin reflection near-tip without replaying history**, via the
  `reflectionResumeDigest_` constructor parameter (`ConfidentialPool.sol`), with a passing
  `test_generational_reflection_resume_digest`. This is the generational enabler, and it is already shipped.

Migration therefore reduces to **exit pool-v1 → re-enter pool-v2**; the exit half is contract-guaranteed.

## 2. What migrates, by asset class

| Asset class | Verdict | Mechanism |
|---|---|---|
| Escrow-backed **native ETH / external ERC20** (incl. real tETH) | **Migrates cleanly** | The underlying is exogenous (the pool never mints it); the local asset id `keccak(tag‖chainid‖underlying)` and the decimals-derived scale are pool-independent, and notes are seed/key-recoverable. Unwrap from v1, wrap into v2 — same token, same id. |
| **Pool-minted canonical ERC20** (TAC.tac, tacBTC/cBTC.tac, bridged) | **Migrates with constraint** | The *confidential* value + asset id are continuous via the Bitcoin hub (fixed asset-id constants; `localAssetOf` re-resolves the shared id in any generation). But the **public ERC20 forks to a new address per generation** — `CanonicalBridgedERC20.MINTER` is immutable and folded into the CREATE2 salt, so pool-v2 cannot mint/burn pool-v1's token. Confidential value migrates by `crossOut → bridge_mint`; public-token continuity (Uniswap LPs, integrators) is a market/swap event, not a contract no-op. |
| **cUSD CDP debt + cBTC engine collateral** | **Close-and-reopen** | The CollateralEngine binds set-once to one pool and cUSD's id is engine-derived, so pool-v2 needs a new engine + new cUSD. Close the v1 CDP (repay, reclaim the cBTC basket), migrate the freed cBTC via the hub, reopen against v2's engine. The per-locker native-ETH escrow stays at the v1 engine and is reclaimed there. No funds stranded — the v1 engine keeps closing/liquidating and releasing escrow indefinitely. |
| **cBTC.zk / Bitcoin-homed notes** | **Migrates with constraint** | Value lives on the durable Bitcoin layer and is re-reached by v2 via `bridge_mint` membership against the near-tip resume digest. The `BitcoinLightRelay` is standalone (no pool binding) and reused verbatim. Migration is a Bitcoin round-trip (costs confirmations). |

Inherent to *any* note migration: a public exit resets the migrated value's anonymity set into the new
generation's fresh tree.

## 3. Concurrent-generation accounting constraint (operational, not pre-launch-blocking)

Bitcoin-homed fast-lane value requires a **single authoritative spent set**. Each pool generation maintains an
*independent* reflected spent set (it folds only its own consumed nullifiers), while a Bitcoin-homed note's
nullifier is intentionally chain/pool-independent (so it matches across lanes). Consequently, **two generations
that are simultaneously live against the same Bitcoin chain do not share a spent set for Bitcoin-homed value.**

This does **not** affect a single-generation capped pilot. The recommended posture, which is also the natural
patching flow, is **migrate-then-open**: drain pool-v1's Bitcoin-homed notes before pool-v2 begins reflecting —
keeping one spent set authoritative at a time — rather than running two generations concurrently for that value.
If concurrent operation is ever required, the alternative is a shared cross-generation spent set that the
eth-reflection folds across sibling generations (a guest change + coordinated re-prove). **Decide this posture
explicitly before any two generations run concurrently.**

## 4. Generational-iteration playbook

1. **Launch gen-1** as the immutable ConfidentialPool with `reflectionResumeDigest_ = 0` (genesis anchor) and
   the immutable SP1 prover. Gate the confidential-pool surface behind the existing `live` flag, and enforce the
   pilot exposure **socially / in the dapp** (per-deposit + aggregate, reading on-chain `escrow[]` totals for the
   aggregate), exactly as the tETH pilot does. No on-chain cap by design.
2. **Pilot** capped, operator-monitored. Scout the known-unknowns (§6). Exits stay permissionless — they are the
   safety floor.
3. **Patch** the guest/relay/contract as the pilot surfaces issues; re-prove (a mechanical box step, no new
   ceremony). Decide the concurrent-generation posture (§3) before any two-generations-live scenario.
4. **Deploy gen-2** with: `reflectionResumeDigest_` = the current near-tip reflected digest (+ matching
   `genesisReflectionAnchor_`) so it joins the shared reflection with no history replay; the **same**
   `BitcoinLightRelay`; the **same** tETH Bitcoin link + canonical factory so escrow links + shared ids land
   identically; a **new** CollateralEngine (set-once to gen-2). Pool-minted ERC20s get new per-generation
   addresses.
5. **Flip the control plane (dapp-only):** mark gen-2 assets live (new wraps route to v2), mark gen-1 assets
   exit/recovery-only, and add gen-1 to a generations registry so it stays reachable. No contract interaction
   retires a generation.
6. **User-paced migration, never forced; deprecate-don't-brick.** Escrow assets: redeem-from-v1 +
   deposit-into-v2. Pure-Tacit / cBTC confidential value: `crossOut` → `bridge_mint` via the Bitcoin hub. cUSD
   CDPs: close on v1, migrate freed cBTC, reopen on v2. gen-1 remains self-custodially redeemable indefinitely.

## 5. Gen-2 deploy-coherence checklist (capture now, while gen-1 params are fresh)

A mismatch here is fail-closed (a wrong `reflectionResumeDigest_`/anchor pair bricks bootstrap at first attest;
a wrong tETH link breaks bridged-shared-id continuity) — no fund risk, but it blocks a clean generation. The
documented failure mode from past deploys is ELF/genesis/vkey **drift**, so codify the inputs:

- [ ] **Reuse the exact same `BitcoinLightRelay`** address (it is pool-independent and shared across generations).
- [ ] **Reuse the same tETH Bitcoin link + tETH asset id** so bridged-tETH shared-id resolution is continuous.
- [ ] **Reuse the same CanonicalAssetFactory** so shared/canonical ids resolve identically.
- [ ] Supply a **matched `(reflectionResumeDigest_, genesisReflectionAnchor_)`** near-tip pair from the live
      reflected state at cutover.
- [ ] Deploy a **fresh CollateralEngine** and wire it set-once to gen-2 (new cUSD id by construction).
- [ ] Confirm the deployed prover runs the **exact committed canonical ELF** (no native rebuild) so the pinned
      `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY` match — the standing ELF-drift discipline from the audit's pre-launch
      checklist.
- [ ] Re-run the readiness gate (vkey coherence, the reflection storage-slot check, the structural
      spend-detection tests) against the gen-2 build before flipping the control plane.

## 6. Known-unknowns the capped pilot is meant to surface

- **Self-exit prover availability.** A holder must mint an SP1 proof against the immutable vkey to exit; the
  contract accepts it permissionlessly, but the holder depends on the prover toolchain. Recoverable (the ELF is
  committed, self-provable in principle) and not a contract trap — validate that a user can self-prove an exit
  with no operator cooperation.
- **Path-A first-hop reflection liveness.** Evacuating Bitcoin-homed value out of v1 needs a v1-bound reflection
  cycle to fold the `crossOut` onto Bitcoin. If v1's reflection/prover is the abandoned subsystem, stress what
  happens when it stalls (cf. the known signet cron-freeze pattern).
- **btcHomed two-step exit UX.** Bitcoin-homed escrow-backed assets (tETH) exit as a leaf then a separate
  non-btcHomed unwrap — confirm wallets/UI handle the two steps without implying value is stuck.
- **Escrow accounting + recovery under real load.** Validate the escrow == supply invariant and seed-only /
  scan-based recovery across a capped live pool with concurrent wraps/unwraps/LP/locks.
- **Cap enforcement is social/dapp.** A direct `wrap()` bypasses the UI cap; the pilot validates that monitoring
  on-chain `escrow[]` totals is sufficient (it cannot inflate — escrow is 1:1 backed).
- (Inherited, not migration-specific) the accepted deep-reorg-across-retarget posture on the shared relay.

## 7. Recommended follow-ups (deferred — gen-2-time, not pre-launch)

These are real and recommended, but deliberately **not** built speculatively now (gen-2 does not exist yet, and
they depend on §3's posture + the public-token adoption decision; building them unvalidated would bake in
assumptions). They are all **dapp-only, no re-prove**, and should be built when pool-v2 is concretely planned:

- A confidential-pool **generations registry** (ordered immutable generations; active = new wraps; older =
  redeemable; a per-generation token-address map so the public-ERC20 fork is invisible to users) — generalizing
  the working tETH mixer registry, so gen-2 is a config append and cross-generation recovery is first-class.
- A **migrate-to-gen-N driver** and a **CDP wind-down flow** (detect open v1 CDPs → close → migrate collateral →
  reopen), with the dapp cap gating **entry only, never exit**.

On-chain caps/pauses are intentionally **not** added — the immutability + permissionless-exit story is cleaner
without them, and the exposure bound is dapp/convention/social for the pilot.
