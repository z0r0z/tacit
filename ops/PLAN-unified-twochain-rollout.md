# PLAN — unified single-wallet / two-chain rollout (+ Bitcoin fast-lane)

Sequenced punch-list from today's state (~25-30% of the unified experience) to (Phase A) one wallet
showing one portfolio over Bitcoin + Ethereum with round-trip bridging from a single UI, and (Phase B)
Bitcoin traders getting fast Ethereum settlement of *value* (the Mode-B fast lane).

The cryptographic spine is already built and largely tested — shared identity, shared secp256k1 note,
shared `asset_id`, the source-consuming bridge, the cross-lane gates, and the Mode-B recursion in the
guest. What remains is **one operational milestone + last-mile wiring**, not new crypto.

References: `ARCH-tacit-chain-abstraction.md` (design + gaps), `CHECKLIST-mainnet-reprove.md`,
`CHECKLIST-tac-sepolia-roundtrip.md` (+ `scripts/tac-roundtrip-verify.sh`),
`PLAN-eth-reflection-modeB.md`, `DESIGN-mode-b-recursion.md`,
`DESIGN-trustless-asset-onboarding.md` (forward bridge / provenance),
`DESIGN-bridge-multiasset-provenance.md` (any-asset-any-mutation onboarding).

## Already shipped (the baseline — don't redo)
- **One seed → both identities.** `dapp/evm-account.js` `deriveEvmAccount(tacitPriv, network)` (domain-
  separated, network-bound). Live in the Sepolia Shielded Pool tab. Note = shared secp256k1 commitment,
  chain-independent ν.
- Sepolia `ConfidentialPool` (`0x991726A5…`) live + attesting; deployed circuit == pinned vkeys.
- tETH Bitcoin↔ETH bridge (asset-specific mixer) live; Sepolia Shielded Pool tab (native cETH) live.
- The merge layer exists + is tested but is inert: `unified-holdings.js`, `cross-chain-asset-resolver.js`,
  `evm-lane-reader.js`, `scanHoldingsCrossChain()`; reverse-bridge `crossout-broadcast.js`; worker
  cross-out consumer (signet-active). All gated on a non-null pool.

---

## Phase A — unified experience (bridge-gated value movement)

### A0 — Re-prove + deploy the production ConfidentialPool  ⟵ FOUNDATION, gates everything below
- Re-prove both guest ELFs with the full accumulated reflection-guest scope:
  - burn-deposit + cmint onboarding dispatch (`7fb1f07`/`4227a5d`/`7b46af3`/`04151a4`/`be94d2e`)
  - **CBURN-through-change** follow-up (`ac7b514`) — a note whose lineage passes through a supply-burn bridges
  - **multiasset provenance** generalization (`DESIGN-bridge-multiasset-provenance.md`, design `b2f54f3`;
    guest impl pending) — a note received from a swap / LP-remove / OTC / bid fill bridges, not just a
    plain-transferred one. Folding it into THIS rotation makes A1's onboarding cover every asset through
    every Tacit mutation (else the unified portfolio / fast lane only works for plain-transferred notes).
  - the `eth_pv` Mode-B prove-harness fix (`2ec31c1`) — without it the reflection prove desyncs (`pv=0`)
  - `get_amount_out` BigUint fix + AMM constant-product check (`2c4184a`)
  - mainnet config (`ETH_GENESIS_SYNC_COMMITTEE`, `ETH_REFLECTION_VKEY`, Bitcoin genesis anchor)
  Reflection vkey rotates (settle vkey `0x00d5b572` stays frozen — settle source is unchanged).
- Deploy a fresh `ConfidentialPool` at the new immutable vkeys (+ factory, header relay, genesis anchor);
  bootstrap reflection (first `attestBitcoinStateProven`).
- Verify: `scripts/tac-roundtrip-verify.sh state` (Phase 0/1 green).
- Status: **blocked on the prove, root-caused (2026-06-15).** Source synced + new reflection ELF builds on
  the box; new `BITCOIN_RELAY_VKEY = 0x00970105…` derived (PROVISIONAL — toolchain-dependent). Blocker: the
  groth16 **reduction** field-divides (`196177702/0`, `Fatal(Reduction task)`) deterministically for ANY
  reflection fixture (burn-deposit AND a plain CXFER), so it's toolchain/ELF-level, not data-specific. NOT a
  regression — the box is on the *documented* toolchain (`cargo-prove sp1 150e629` / `sp1 6.2.3`); the prior,
  smaller reflection ELF (`0x005e6adc`) is what produced the committed fixtures. Next diagnostic (one box
  session): groth16-prove the **settle** guest on the box → if it proves, the bigger reflection ELF trips a
  `6.2.3` reduction edge; if it also field-divides, reinstall the `sp1-gpu-server` binary to match `6.2.3`
  exactly (box's is a Jun-1 build vs cargo-prove's May-23). Box stopped between attempts (funds). Owner:
  re-prove session.

### A1 — Onboard Bitcoin assets to the new pool (TAC first)  [dep: A0]
- `attest_meta` → canonical ERC20 deploys at `f(asset_id)` (pool = MINTER) → bridge a TAC note in →
  unwrap to the public ERC20. Drive + verify with `CHECKLIST-tac-sepolia-roundtrip.md`.
- Gate opened: a Bitcoin asset has a live Ethereum face.

### A2 — Flip the cross-lane pool config  [dep: A0]
- Set `CROSSLANE_DEPLOYMENTS[net].pool` to the deployed pool (and `live:true`) in `dapp/tacit.js`;
  `_crosslaneConfigured()` then returns true and `evm-lane-reader` / the cross-lane guard activate.
- Gate opened: the inert merge layer can read the EVM lane.

### A3 — Wire the unified portfolio  [dep: A2]
- Call `scanHoldingsCrossChain()` from `renderHoldings()` (today it calls Bitcoin-only `scanHoldings()`),
  and pass `evmAddress = deriveEvmAccount(priv, net).address` (today hardcoded null). 
- Gate opened: **one holdings view, one row per asset_id, lane breakdown secondary** — the core of
  "single wallet, two chains."

### A4 — Wire bridge-out (ETH→BTC) into the UI  [dep: A0, A2]
- Import `dapp/crossout-broadcast.js` into `tacit.js`; add a bridge-out action (EVM `bridge_burn` →
  `CrossOutRecorded` → the already-wired worker consumer mints the Bitcoin note past finality).
- Gate opened: full Bitcoin↔Ethereum round-trip from one interface (bridge-gated, ~6 conf).

### A5 — Network/account unification (UX polish)  [dep: A3]
- Present Bitcoin + Ethereum as one app: single connect/unlock (already one seed), chain-agnostic ops on
  the unified holdings, lane shown as a secondary attribute rather than a separate tab/selector.
- Gate opened: the "chain recedes" experience — the user thinks in assets, not chains.

**End of Phase A:** unified portfolio + one-UI round-trip + one identity. Value still crosses chains via
the finality-gated bridge (not "fast"), which is correct and safe.

---

## Phase B — the fast lane (Bitcoin value settles fast on Ethereum)

Today a Bitcoin-homed note CAN be spent on the Ethereum lane (cross-lane membership + non-membership gate
are deployed), but `BtcHomedValueExitMustBridge` bars moving its *value* off-Ethereum until Bitcoin learns
the note was consumed. Closing that loop is Mode B.

### B1 — Stand up the eth-reflection guest  [dep: A0]
- Deploy + prove the eth-reflection guest (Helios light-client + the `crossOutCommitment` set); obtain its
  recursion vk digest and set `ETH_REFLECTION_VKEY` (+ genesis sync-committee) in the reflection guest's
  `verify_sp1_proof` path (`reflect.rs` Mode-B block). Refs: `PLAN-eth-reflection-modeB.md`,
  `DESIGN-mode-b-recursion.md`. **Hardest item — recursive proving infra.**

### B2 — Run the ETH↔BTC reflection loop both directions  [dep: B1]
- The eth-reflection attests EVM cross-outs; the Bitcoin reflection folds them via Mode B. The shared
  nullifier set becomes finality-consistent across lanes.

### B3 — Relax the value-exit gate → enable the fast lane  [dep: B2]
- Permit a btcHomed note's value-exit once it is proven consumed in the finality-gated shared nullifier
  set (relax `BtcHomedValueExitMustBridge` accordingly). **Guest + contract change → another re-prove +
  redeploy.**
- Gate opened: a Bitcoin trader spends a Bitcoin-homed note and settles on Ethereum at Ethereum speed,
  reconciled to Bitcoin asynchronously — the fast lane.

---

## Critical path
```
A0 ─┬─ A1 (onboard)
    ├─ A2 (flip pool) ─┬─ A3 (unified portfolio) ─ A5 (network UX)
    │                  └─ A4 (bridge-out UI)
    └─ B1 (eth-reflection) ─ B2 (loop) ─ B3 (relax gate = fast lane)
```
A0 is the shared root and is in flight. Phase A (A1–A5) is mostly **last-mile wiring of code that already
exists + tests** — low/medium effort, client-side, once A0 lands. Phase B is the heavy lift (recursive
proving + a second re-prove for B3) and delivers the fast lane.

Smallest first visible win after A0: **A2 + A3** (flip the pool, wire `scanHoldingsCrossChain` into
`renderHoldings`) — that alone turns two adjacent tabs into one cross-chain portfolio.
