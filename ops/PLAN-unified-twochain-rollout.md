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
- Status: **root-caused → A0's reflection groth16 is coupled to Mode-B (2026-06-15).** Source synced + new
  reflection ELF builds; `BITCOIN_RELAY_VKEY = 0x00970105…` derived (PROVISIONAL — toolchain-dependent).
  Diagnostic DONE (decisive): the reflection groth16 field-divides (`196177702/0`, `Fatal(Reduction task)`)
  but the **settle** guest groth16 **proves clean on the same `150e629/6.2.3` toolchain** (`LOCAL_VERIFY_OK`,
  real artifacts) — so the toolchain is healthy and it is NOT a regression / not a gpu-server mismatch. The
  field-division is **reflection-specific**: `verify_sp1_proof` (the Mode-B recursion, `reflect.rs:137`) is
  **unconditional** — every reflection prove (even a forward-only burn-deposit/CXFER batch) creates a
  deferred-proof obligation, and proving with NO inner eth-reflection proof supplied → empty deferred set →
  the `6.2.3` recursion reduction divides by zero. (The settle guest has no recursion, so it's unaffected.)
- **Fix (decouples A0 from B1) — preferred:** gate `verify_sp1_proof` on the batch actually folding a
  crossOut. A forward-only batch (burn-deposit / multiasset onboarding / plain CXFER) has no crossOut →
  skip the recursion → no deferred obligation → groth16 proves WITHOUT the eth-reflection guest. Sound: the
  ETH state is only needed to validate crossOuts (reverse bridge); a forward batch never consumes it.
  Reverse-bridge (crossOut) batches still require the inner proof = B1. **This is a guest change (conditional
  gate + coherent eth-field commitment when skipped) + re-prove** — it unblocks A0 / the forward bridge
  independently of standing up the eth-reflection guest. Alternative: do B1 now (supply the inner compressed
  proof so the deferred set is non-empty). Box stopped between attempts (funds). Owner: re-prove session.

### A1 — Onboard Bitcoin assets to the new pool (TAC first)  [dep: A0]
- `attest_meta` → canonical ERC20 deploys at `f(asset_id)` (pool = MINTER) → bridge a TAC note in →
  unwrap to the public ERC20. Drive + verify with `CHECKLIST-tac-sepolia-roundtrip.md`.
- Coverage rides A0's reflection scope: fixed-supply + mintable (cmint) assets; a note that was
  transferred, burned-through (CBURN), OR received from a swap/LP/OTC/bid (the multiasset generalization).
  So onboarding is any Tacit asset through any Tacit mutation, not just plain transfers.
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

### A6 — Gas-abstract settler (launch trading without ETH)  [dep: A0, A1]
The trading layer is gas-abstract **by design and the mechanism is on-chain today** — this is a launch
target, gated only on running the settler, not on new crypto:
- **On-chain (verified):** `settle()` is permissionless (`ConfidentialPool.sol:763`); `pv.fees[i]` is paid
  to `msg.sender` in the **traded asset** (`FeePayment{assetId,value}` :260, `_payout(assetId, msg.sender,…)`
  :914). Orders are offline-signed intents — OP_OTC binds both parties with no on-chain action; OP_BID is
  buyer-prefunds + pre-signs K grid fills + walks away. So a user holding ONLY the asset (no ETH) signs an
  intent; a relayer fronts ETH gas and is reimbursed in-asset.
- **Worker (wired):** `worker/src/confidential-settle.js` is a prove/settle job queue (`buildConfidentialSettler`;
  `/confidential/{submit,job,ack}`; box-poll, same box shape as the reflection relay). The settle-guest
  groth16 **proves clean on the current toolchain** (verified 2026-06-15, `LOCAL_VERIFY_OK`) — the relayer's
  prove path is healthy; it's the SETTLE guest, not the recursion-blocked reflection guest.
- **Launch gap (operational only):** run a live settler — a box polling `ops/scripts/confidential-settle-loop.sh`,
  funded with ETH gas, submitting `settle()`; plus a minimal in-asset fee policy (cover gas + margin). Rides
  A0 (a live pool) + A1 (an onboarded asset to price/denominate fees in, e.g. tETH).
- Gate opened: **same-chain gas-free trading at launch** — list/fill priced in any onboarded asset; neither
  maker nor filler needs ETH. (Cross-chain, no-bridge atomic fills = the Phase C adaptor swaps.)

**End of Phase A:** unified portfolio + one-UI round-trip + one identity + gas-free same-chain trading.
Value still crosses chains via the finality-gated bridge (not "fast"), which is correct and safe.

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

## Phase C — unified AMM + one LP + cross-chain orderbook (the convergence)  [dep: B]

The destination: **one canonical pool per (asset pair, fee tier), one LP-share set, one orderbook,
reachable from either chain** — no liquidity fragmentation. A deliberate convergence from "two parallel
AMMs" to "one canonical AMM + cross-lane access," landing after the fast lane (B). Trade-off to decide
explicitly: you gain unified liquidity + a single LP, but the Bitcoin pool stops being a standalone
on-Bitcoin venue (it becomes an access lane onto the canonical pool).

### C1 — Wire the adaptor-swap cross-chain orderbook  [dep: B (crypto layer is earlier)]
- Implement the EVM `OP_ADAPTOR_{LOCK,CLAIM,REFUND}` guest ops (ride a settle re-prove; only the
  lock-set leaf primitive exists in `cxfer-core` today) + Bitcoin Taproot timeout-refund recognition.
- Wire the already-built+tested off-UI modules — `dapp/adaptor-signature.js`, `dapp/adaptor-swap.js`,
  `dapp/cross-chain-orderbook.js`, `dapp/cbtc-redemption.js` — plus a worker quote-discovery/relay
  endpoint + the dapp orderbook view.
- Gate opened: a Bitcoin maker and an Ethereum taker fill the SAME asset atomically WITHOUT bridging
  (Route B) — e.g. "list a token for tETH; a tETH holder on the other chain fills it scriptlessly."

### C2 — Designate the canonical pool  [dep: B, C1]
- Make the Ethereum on-chain pool the authoritative AMM for a (pair, fee): one `pool_id`, one reserve
  set, one LP-share note. Harmonize / map the Bitcoin `pool_id` (SHA256+flags) onto the canonical
  keccak id so both lanes address the same pool object.

### C3 — Cross-lane LP + trade against the canonical pool  [dep: C2]
- Bitcoin LPs/traders add liquidity / swap against the canonical Ethereum pool via the fast lane (B) /
  adaptor swaps, so a single LP position backs fills originating from both chains.
- Gate opened: **one LP, one book, both chains** — unified liquidity, no fragmentation.

---

## Gas / relayer reality (sanity-checked 2026-06-15)

Gas-abstraction is **live, not just contract-supported** — but operator-subsidized and single-settler:
- A settler IS running: the GPU box runs `scripts/confidential-settle-loop.sh`, polling the worker's
  `/confidential/job` queue (`worker/src/confidential-settle.js`), GPU-Groth16-proving each op, and
  submitting `ConfidentialPool.settle(pv, proof, memos)` paying gas from its own `ETH_PK`. So a user
  trades on Ethereum holding only the asset (no ETH) — they sign an offline intent (OP_OTC / OP_BID),
  the box settles.
- BUT it is ONE operator-run settler (FIFO, shares the box's single GPU with the tETH loop), and in the
  pilot it self-proves with **no fee taken** (the `ConfidentialPool` "self-prove sets no fees, pays only
  gas" path) — the operator eats the gas.

Compensating the settler has TWO paths:
- **Tip-output — no re-prove, shippable now.** The user adds a normal settler-fee OUTPUT note to their
  own trade; the deployed guest already conserves all outputs (`Σin = Σout`), so it is sound on the
  current ELF — the settler is just another recipient. The box (prover+settler) enforces it as policy:
  prove+settle only intents that tip ≥ the schedule to its address (it sees the witness amounts). Pure
  dapp + worker/box change — no guest, contract, or vkey change. See the near-term item below.
- **In-proof `FeePayment` — needs a re-prove.** The elegant form: the proof commits `pv.fees` →
  `_payout(msg.sender)` (`ConfidentialPool.sol:914`). Doubly gated on the guest: the deployed ELF
  hardcodes `fees = []` (`main.rs:134`) AND lacks the kernel `−fee·H` conservation term (without it the
  payout is unbacked = a drain). Fold both into the A0 re-prove; then the fee rides in the proof instead
  of as a separate output and supersedes the tip-output cleanly.
- Follow-up (off the A/B/C critical path): open the settler beyond the single box — that turns
  "operator-subsidized" into a sustainable, decentralized relayer market.

### Near-term, no-re-prove: settler-fee tip-output (self-sustaining relaying today)
Shippable against the LIVE Sepolia pool — **no A0 dependency**:
1. **dapp:** when building a trade intent (OP_TRANSFER / OP_SWAP / OP_OTC / OP_BID), add an extra OUTPUT
   note to the settler's published confidential address for the fee (flat or % of the traded asset).
   Conservation already covers it — it is just another output of the same op.
2. **worker/box:** publish the settler fee address + schedule; the settle loop
   (`scripts/confidential-settle-loop.sh` / `worker/src/confidential-settle.js`) verifies the intent
   includes the tip output (witness amounts are box-visible) and refuses to prove+settle intents that do
   not pay it.
3. **(optional) dapp quote:** surface "settler fee: X" so the user sees the cost up front.
No guest / contract / vkey change. Makes the operator-subsidized settler fee-funded immediately; the
in-proof `pv.fees` form replaces it at the A0 re-prove.

---

## Critical path
```
A0 ─┬─ A1 (onboard)
    ├─ A2 (flip pool) ─┬─ A3 (unified portfolio) ─ A5 (network UX)
    │                  └─ A4 (bridge-out UI)
    └─ B1 (eth-reflection) ─ B2 (loop) ─ B3 (fast lane) ─ C1 (x-chain book) ─ C2 (canonical pool) ─ C3 (one LP, one book, both chains)
```
A0 is the shared root and is in flight. Phase A (A1–A5) is mostly **last-mile wiring of code that already
exists + tests** — low/medium effort, client-side, once A0 lands. Phase B is the heavy lift (recursive
proving + a second re-prove for B3) and delivers the fast lane.

Smallest first visible win after A0: **A2 + A3** (flip the pool, wire `scanHoldingsCrossChain` into
`renderHoldings`) — that alone turns two adjacent tabs into one cross-chain portfolio.
