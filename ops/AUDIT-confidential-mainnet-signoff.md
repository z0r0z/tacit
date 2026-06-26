# Confidential Asset + Shielded Pool + Cross-Chain — Mainnet Sign-Off Audit Brief

> **Status note (2026-06-21):** historical audit brief. It preserves the review context from an
> earlier pinned generation. For current Sepolia full-suite testing, use
> `ops/STATUS-confidential-system.md`, `ops/RUNBOOK-confidential-pool-deploy.md`,
> `ops/CHECKLIST-sepolia-full-suite.md`, and the top-level authoritative pins in
> `contracts/sp1/confidential/elf-vkey-pin.json`.

> **For the reviewing agent — context + mandate.** Tacit is an open-source, publicly deployed
> confidential-transaction protocol giving on-chain assets the standard *confidentiality* and
> *unlinkability* properties from the zero-knowledge literature and shipped by widely used systems
> (Zcash shielded pools, Aztec, Monero / Bulletproofs, the confidential-transactions line). Owners
> always retain sole control of their own funds; "privacy" means amounts and the sender↔note
> association are hidden from third parties via Pedersen commitments + zero-knowledge proofs.
>
> **Your task is a code-correctness / soundness review and hardening of this developer's own
> open-source code, to sign it off for mainnet.** The properties are *safety* properties — no token
> inflation, no double-spend, no fund drain, value conservation, escrow solvency, proof↔verifying-key
> coherence. This is defensive security engineering: surface and **fix** soundness bugs so the
> protocol cannot mint value from nothing or lose user funds. It is ordinary cryptographic-protocol
> review (the same done on any open-source L1/L2) and the right thing to do thoroughly. Nothing here
> asks you to attack a live third-party system; it asks you to verify a public protocol is sound and
> repair it where it isn't.

This is the **one document to one-shot the full review**: the new-generation contracts, their shared
on-chain dependency, the off-chain prover that carries the validity logic, the vkey/ELF pin
discipline, the client↔guest parity, and the relay trust surface. Deliver findings **and fixes** (a
failing regression test that passes after the fix), then a sign-off verdict.

Companion depth (read as needed, do not re-derive): `ops/RUNBOOK-confidential-pool-readiness.md`
(property→test matrix + the runnable gate), `spec/SPEC-CONFIDENTIAL-POOL.md` §7.1 (the normative
in-guest validity bindings B1–B6), `spec/amendments/SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md`,
`ops/AUDIT-confidential-bridge-and-pool.md` (the orientation file map).

---

## 1. The system in one screen

A multi-asset **shielded pool on Ethereum** (`ConfidentialPool`) over secp256k1 Pedersen notes
`C = v·H + r·G` (the same note object as the Bitcoin layer). Validity of every state transition is
**proven by an SP1 zkVM guest** and verified on-chain through the genuine SP1 Groth16 verifier —
there is no per-circuit trusted setup; the guest is pinned by `PROGRAM_VKEY`. The contract sees only
**hashes** (commitments, nullifiers, roots): it maintains the commitment tree, the nullifier set,
per-asset escrow, the AMM pool reserves, and pays the public boundary (withdrawals). A canonical
**ERC20 layer** (`CanonicalAssetFactory` + `CanonicalBridgedERC20`) gives every Tacit-recorded asset
a deterministic public face (Uniswap-tradeable) with the pool as its sole minter. **Cross-chain** is
self-contained: a `reflection prover` re-derives confirmed Bitcoin confidential-pool state and
attests it on-chain (anchored to a `BitcoinLightRelay`), so the guest can gate cross-chain spends
with no trusted oracle.

**Trust model — the single most important framing.** Because the contract sees only hashes, it can
enforce escrow, nullifier-uniqueness, accepted-root validity, and the swap/LP reserve pre-gates —
but the **value / amount / membership logic that prevents inflation lives in the SP1 guest and the
vkey/ELF pin**. So the **guest + the pin carry the load**. Treat any property the contract cannot
see as guest-critical, and treat the pin discipline (the deployed vkey == the reviewed ELF) as
fund-critical infrastructure.

**Bearer model (note it explicitly).** Spend authorization is *opening secrecy* `(v, r)` — the
`owner` field never gates a spend (`SPEC-CONFIDENTIAL-POOL.md` §2). Whoever knows a note's `(v, r)`
can spend it. The privacy/binding work is done by the proofs, not an owner signature. This is
deliberate and matches the Bitcoin layer; the off-line-recipient ops (`OP_BID`) are designed around
it (see §6).

---

## 2. Scope

### In scope — review and sign off

| Layer | Path | Role |
|---|---|---|
| **Contract** | `contracts/src/ConfidentialPool.sol` | the pool: tree + nullifiers + escrow + `settle` (applies a proof) + wrap/unwrap (incl. native ETH) + `initPool` + swap/LP reserve state + `bridge_mint`/`bridge_burn` + `attestBitcoinStateProven` (reflection). **Start here.** |
| **Contract** | `contracts/src/CanonicalAssetFactory.sol` | deterministic public ERC20 from `assetId` (CREATE2, constant init code). |
| **Contract** | `contracts/src/CanonicalBridgedERC20.sol` | the canonical ERC20 the pool mints/burns; `contractURI` from the etch-bound metadata CID. |
| **Shared dep** | `contracts/src/lib/BitcoinLightRelay.sol` | the relay the reflection anchor pins to (cross-chain only; `address(0)` ⇒ Ethereum-only). Reused from the tETH bridge; review the `tip()`/`blockParent()` surface the pool consumes. |
| **Off-chain prover (load-bearing)** | `contracts/sp1/confidential/src/main.rs` | the **settle guest** — the in-guest validity checks for every op. **Start here for proving logic.** |
| **Off-chain prover** | `contracts/sp1/confidential/src/reflect.rs` | the **reflection prover** (Bitcoin state → attested roots). |
| **Crypto core** | `contracts/sp1/confidential/cxfer-core/src/{lib,bitcoin,bjj,sigma}.rs` | `verify_pedersen_opening`, `verify_kernel`, `verify_opening_sigma`, `intent_context`, nullifier, keccak Merkle, IMT (non-)membership, `verify_range` (BP+), Bitcoin header/tx/PoW, the scan model. |
| **Pin discipline** | `contracts/sp1/confidential/elf-vkey-pin.json` + `verify-vkey-pin.sh` + `contracts/script/DeployConfidentialPool.s.sol` | binds the committed ELF bytes ↔ vkeys; the deploy reverts a vkey ≠ the pin. |
| **Client ↔ guest parity** | `dapp/confidential-{pool,transfer,swap,lp,otc,bid,relay}.js` + `confidential-{memo,indexer,reflection-scan-indexer}.js` | each op assembler's `verify*` must mirror every guest assert; memo seal/open; seed-only recovery. |
| **Relay trust surface** | `worker/src/confidential-settle.js`, `worker/src/reflection-attest.js`, routes in `worker/src/index.js` | the worker queues/relays a proof the contract independently verifies; it never proves and never holds funds. |

### Trusted / out of scope (state the assumption, don't audit the internals)

- **The SP1 Groth16 verifier** — Succinct's deployed, immutable verifier leaf (e.g. Sepolia
  `0x6F9a1D26e398295129bd523748b7fC7e3d801d68`, selector `VERIFIER_HASH 0x4388a21c`). The trust root
  is Succinct's verifier + ceremony. **Confirm** the pool pins the immutable leaf (not the
  owner-upgradeable gateway) and that the `*ProofReal` tests verify through that exact leaf — do not
  audit the bn254 pairing math.
- **The tETH bridge stack** (`TacitBridgeMixer`, `SP1PoolRootVerifier`, `Groth16Verifier`,
  `PoseidonT3`) — the *prior-generation* ETH↔Bitcoin bridge, a separate live system. The confidential
  pool's own bridge (`bridge_mint`/reflection) does **not** use it. Only `BitcoinLightRelay` is shared.
- **The Bitcoin-side circuits** (the mixer/AMM/CXFER provers) — the reflection prover is the seam;
  audit that the *reflected* Bitcoin state is sound, not the Bitcoin circuits themselves.

---

## 3. Deployment surface + the two layers

`DeployConfidentialPool.s.sol` deploys `ConfidentialPool(sp1Verifier, programVKey, bitcoinRelayVKey,
canonicalFactory, headerRelay, genesisReflectionAnchor)` and `CanonicalAssetFactory`; ERC20s are
CREATE2'd by the factory on demand. Live pilot: Sepolia `ConfidentialPool`
`0x445031c4ee0CdcBDb8c92a6CBBB4639D20cC75A9`.

- **POOL layer** (`bitcoinRelayVKey == 0`, `headerRelay == address(0)`): Ethereum-only confidential
  pool — wrap / transfer / unwrap / swap / lp / otc / bid / canonical ERC20. No cross-chain.
- **BRIDGE layer** (relay + reflection vkey wired): adds `bridge_mint`/`bridge_burn`, the cross-lane
  non-membership gate, and trustless first-mint metadata. The deploy script gates activation
  (`ACK_REFLECTION_ANCHORED`).

**Pin coherence is fund-critical.** The deployed `PROGRAM_VKEY` MUST equal
`elf-vkey-pin.json.program_vkey`, which MUST equal the vkey every settle `*ProofReal` fixture
verifies against, which MUST be the vkey of the committed `elf/cxfer-guest`. `verify-vkey-pin.sh`
and the deploy coherence guards enforce this. **Audit the source** (`main.rs` + `cxfer-core` +
`reflect.rs`); the committed ELF is the canonical build of exactly that source. *The current op set
(`OP_OTC`/`OP_BID`, the metadata-CID `AssetMeta` field, and the reflection full-scan) is GPU-re-proven:
the pinned vkeys are settle `0x00bb82ef…` / reflection `0x0099e1c7…`, and all 7 `*ProofReal` fixtures
verify a real Groth16 of these ELFs on-chain. **The settle guest (`0x00bb82ef`) is sound. The pinned
reflection guest (`0x0099e1c7`) carries REFLECT-1 (§7, fund-critical) — a corrected re-prove is
required before BRIDGE can activate; the settle ELF re-pins mechanically when the shared cxfer-core
fix lands.***

---

## 4. The op set (settle guest, `main.rs`) — value in vs value out

For each op, trace value-in vs value-out and confirm the cited binding actually holds at that spot
(don't trust the comment). All amounts are typed `u64` and bound to their note commitment; products
use `u128` to guard the equality asserts.

| Op | Moves | Conservation / binding to verify |
|---|---|---|
| `OP_WRAP` (0) | escrow → note | `value·unitScale == amount` via `deposit_id`; the contract re-derives the same `value = amount/unitScale`, so the note can't claim more than escrowed (the guest never sees `unitScale`). `value ≤ u64::MAX`. |
| `OP_TRANSFER` (1) | notes → notes (1 asset) | Mimblewimble kernel `verify_kernel`: Σin = Σout via the BIP-340 kernel signature; BP+ `verify_range` on outputs; note-bound ν. |
| `OP_UNWRAP` (2) | note → escrow payout | the contract scales `value·unitScale` on payout; `value` is opening-bound; escrow ≥ payout. |
| `OP_BRIDGE_BURN` (3) | note → Bitcoin (crossOut) | conservation crosses the boundary (Σ burned = Σ minted on Bitcoin); `claimId = keccak(destChain‖destCommitment‖ν‖assetId)` re-derived on-chain (non-malleable). |
| `OP_BRIDGE_MINT` (4) | Bitcoin burn → note | minted value bound to a proven Bitcoin **burn** — membership in the dedicated `bitcoinBurnRoot` (NOT the general spent set), one-mint-per-ν, the burned ν pushed into the Ethereum nullifier set. |
| `OP_ATTEST_META` (5) | — (registers metadata) | proves `(assetId, ticker, decimals, cid)` from a confirmed etch (asset_id ← txid; note-membership ∈ a relay-attested pool root); lazy-deploys the canonical ERC20 with the proven metadata + derived scale. The metadata `cid` is bound into `asset_id` (trustless `contractURI`). |
| `OP_SWAP` (6) | notes ↔ pool reserves | constant-product non-decrease `k_post ≥ k_pre`; net reserve delta == net of the openings; per-intent `min_out`; each amount bound by an **opening sigma** under a shared `intent_context` (no redirect / no re-price — the settle prover never learns `r`). |
| `OP_LP_ADD`/`REMOVE` (7/8) | notes ↔ pool reserves + LP-share note | in-ratio add `dA·R_B == dB·R_A`; proportional shares/withdrawal floored *toward the pool*; openings bind `dA`/`dB`/`dShares`; reserves + `totalShares` move together. |
| `OP_OTC` (9) | notes ↔ notes (2 assets, 2 parties) | per-asset conservation `in == counterparty-recv + change`; every output owner + both amounts in the shared `intent_context` (no redirect / no re-price); atomic (one op = one proof). |
| `OP_BID` (10) | buyer-offline partial-fill | grid `chosen_f ∈ [min,max]` increment-aligned; `V_fund = max·price` funded + opening-bound; `pay = chosen_f·price`, `refund = V_fund−pay` opening-bound (refund **enforced**, not conventional). Buyer openings are **pre-signed offline** so their context binds NO seller notes; the buyer's received-note blindings are `deriveNote(bid_secret,·)` (the seller never learns them → can't re-spend the fill). |

The contract applies `pv.nullifiers` + `pv.leaves` generically for every op (`OP_OTC`/`OP_BID`/
transfer carry no contract-specific state); `OP_SWAP`/`OP_LP` additionally gate `reservePre == live`
then move the pool. Confirm there is no op whose emitted leaves/nullifiers are unbacked by a guest
conservation check.

---

## 5. Safety properties to certify (the sign-off bar)

Ordered by blast radius. Each must hold; cite where and confirm a negative test exists (a missing
reject-branch test is itself a finding to add).

**A. No token inflation / value conservation — [fund-critical].** Per op (§4): every cleartext
amount bound to its commitment by `verify_pedersen_opening` / `verify_opening_sigma` / the kernel;
`u128` products cannot overflow the equality asserts; an unopened/forged amount is rejected. The
no-inflation invariant `#spent ≤ #leaves` and escrow solvency `escrow[asset] ≥` all outstanding
redeemable value + pool reserves; escrow moves only with conserved value.

**B. No double-spend / nullifier integrity — [fund-critical].** ν = `keccak(Cx‖Cy‖"spent")` is the
**same** derivation in guest, dapp, and worker (B3). The contract consumes each ν once and rejects a
repeated ν **including within one batch** (the `settle` loop sets-then-checks). Cross-lane
non-membership is **mandatory and fail-closed** for a Bitcoin-homed spend: it must pin the current,
**non-zero** reflected spent root (the empty set is a non-zero IMT sentinel; a zero/omitted root must
not bypass the gate).

**C. No fund drain / escrow solvency — [fund-critical].** `_payout` scales `value·unitScale`,
checks-effects-interactions (escrow decremented before transfer), `forceSafeTransferETH` for native
ETH, mints for pool-minted assets (no escrow). Withdrawals never exceed escrow; `initPool`/wrap only
add escrow with conserved value; `receive()` rejects stray ETH; `nonReentrant` on the
state-mutating entrypoints.

**D. Proof ↔ vkey ↔ ELF coherence — [fund-critical].** Deployed `PROGRAM_VKEY` == the committed
`elf/cxfer-guest` vkey; `BITCOIN_RELAY_VKEY` == the committed `elf/reflection-prover` vkey
(`verify-vkey-pin.sh`). The `*ProofReal.t.sol` tests verify a **real** Groth16 of those exact ELFs
on-chain through the genuine verifier. `chainBinding = keccak(chainid‖pool)` + the PV version gate
block cross-chain / cross-contract / version replay.

**E. Membership & Merkle integrity.** `keccak_merkle_verify` against a non-zero accepted root
(`everKnownRoot` or a relay-attested `knownBitcoinRoot`); depth-32 bound (`MAX_LEAVES`); append-only
insertion; the accepted-root window. IMT non-membership soundness (low-key ordering + sentinel).

**F. Cross-chain / reflection soundness — `reflect.rs` + the anchor (§6).**

**G. Contract state machine & escrow — `ConfidentialPool.sol`.** `settle` order: decode → version +
chainBinding → root validity → cross-lane/burn-root freshness → nullifiers → deposits → bridge-mint
dedup → leaves → attest_meta auto-register → withdrawals → fees → crossOuts → swaps → liquidity.
Native ETH (`address(0)` sentinel) end-to-end. Registration: cross-chain links established **only**
via guest-proven `attest_meta`; `registerWrapped`/`registerMinted` are local-only; `unitScale`
derivation; pool-minted assets require `decimals == ETH_DECIMALS`; the canonical-asset / shared-id
guards (an external/escrow token can never claim a shared id; first-write-wins on `localAssetOf`).

**H. Client ↔ guest parity.** Each `dapp/confidential-*.js` `verify*` mirrors **every** guest assert
(the `tests/confidential-*-op.mjs` round-trips emit the same vectors all three implementations
consume). A gap means the client and guest disagree on what's valid — diff field order + every
assertion across `ConfidentialPool.sol` ↔ `main.rs` ↔ `confidential-*.js`.

**I. Relay trust surface.** The worker never proves and never holds funds; submit is permissionless
(a bad witness simply fails to prove); a re-served job's re-submit reverts (ν spent) and is acked
failed (no double-apply); box-only routes are Bearer-gated (liveness, not fund-soundness).

---

## 6. Cross-chain — the reflection seam (`reflect.rs` + `attestBitcoinStateProven`)

`attestBitcoinStateProven` is the ONLY way to advance the reflected Bitcoin roots (no oracle). It
verifies an SP1 proof against `BITCOIN_RELAY_VKEY`, then: requires `priorDigest ==
knownReflectionDigest` (an append-only digest chain — no fork/restart/rollback), a non-zero
`newDigest`, non-decreasing height, non-zero sentinel spent + burn roots, and **anchors** the
batch's `prev`/`tip` to the relay (`_anchorReflection`: `prev` == the prior attested tip or a recent
ancestor; `tip` == `RELAY.tip()` or a recent ancestor, each within `REFLECTION_FINALITY_WINDOW = 6`).

Verify on the prover side:
- **Header chain + anchor (F1/F2/F3):** `verify_header_chain` links each header (prev_hash + PoW);
  the guest commits `bitcoinPrevHash`/`bitcoinTipHash` and the contract pins them to the canonical
  relay — so the proven chain is forced to be canonical Bitcoin (self-declared difficulty is moot;
  the finality window is the confirmation/reorg guard).
- **Completeness (F4 — the full-scan model):** the guest walks **every tx of every block** (the
  provided txs must re-hash to the header's merkle root — no tx omitted) and **every vin** against
  the handed live UTXO set (`scan_tx_spends`/`LiveUtxoSet`), so no pool-note spend — even a plain,
  non-protocol spend of a pool UTXO — can be silently omitted. The handed live set is pinned by the
  resume digest (`priorDigest == knownReflectionDigest`); the full-scan genesis digest is three-way
  pinned (Rust prover == JS indexer == contract `REFLECTION_GENESIS_DIGEST`). Confirm the spent-set
  emitted by the scan is what the cross-lane gate later consumes, and that an output note leaf is
  **derived** from the envelope (asset + commitment), never a free witness.
- **bridge_mint authority:** the burned note proves membership in the **dedicated** `bitcoinBurnRoot`
  (a real bridge-out), not the general spent set — confirm an ordinarily-spent Bitcoin note cannot be
  minted on Ethereum (the value-duplication path).
- **destCommitment / claimId binding:** a reflected bridge-out's destCommitment + ν are bound to the
  burn envelope (no mint redirection).

---

## 7. Known boundaries (accept-and-document for the pilot — not findings)

State these as residual posture, not bugs; flag only if you find them *exploitable* within the stated
bounds.

- **SP1 verifier trust root** — Succinct's verifier + ceremony; the pool pins the immutable Groth16
  leaf (verify it pins the leaf, not the upgradeable gateway).
- **`BitcoinLightRelay` is mainnet-specific** — `MAX_TARGET` is mainnet's powLimit, so it validates
  **mainnet** Bitcoin (signet uses signature-PoW, not difficulty). The BRIDGE-layer reflection must
  therefore be mainnet; the repo's signet fixtures are prover test vectors, not the live source.
  Confirm the cross-chain deploy wires a mainnet relay + mainnet reflection. Deep reorgs crossing a
  retarget boundary are out of scope (global epoch targets), bounded for the pool by the finality
  window. The genesis checkpoint is a deployer-set, independently-verifiable trusted seed.
- **Deep reorg** beyond `REFLECTION_FINALITY_WINDOW` — accept-and-document (as on the tETH bridge /
  AMM); a sub-window reorg is tolerated by the ancestor walk.
- **REFLECT-1 (FUND-CRITICAL, BRIDGE) — open in the pinned guest.** The pinned reflection vkey
  (`0x0099e1c7…`) is the full-scan model (F4 completeness closed) BUT folds CXFER outputs into
  `bitcoinPoolRoot` with **no value-conservation check** — a confirmed Bitcoin tx spending no pool
  UTXO can inject a phantom inflated note → drain on the Ethereum cross-lane. The fix
  (`verify_cxfer_conservation` in `fold_cxfer`, + regression) is in source; BRIDGE must not activate
  until the corrected guest is GPU-re-proven + re-pinned (gate layer 9 is a fail-closed allowlist).
  **RESOLVED in the working tree (2026-06-10):** the corrected re-prove landed (reflection
  `0x00e593b0`) and is **confirmed conservation-enforcing** by a reflect-exec negative test over the
  pinned ELF — the guest SKIPS a non-conserving CXFER (0 inputs vs its kernel) and folds only the
  conserving control (reproducing the on-chain digest); `0x00e593b0` is allowlisted. Worker liveness
  mirror: `dapp verifyCxferConservation` (`tests/confidential-reflection-conservation.mjs`). Residual
  is operational: commit the re-prove artifacts, deep reorg + relay liveness + the
  `ACK_REFLECTION_ANCHORED` deploy gate.
- **Reflection + settle relays not yet running continuously** — cross-chain is interim-trusted until
  they are; the contract verification is independent of the relay's honesty (the relay only relays a
  proof the contract checks).
- **Per-op proving latency** until batching — a liveness/UX property, not a fund property.

---

## 8. Build, run, reproduce

```
# Contracts: state machine + invariant/fuzz + KAT + real Groth16 (no mock) + factory
cd contracts && forge test --match-contract 'Confidential|CanonicalAsset'

# Guest crypto core: native KATs against the JS prover vectors
cargo test --manifest-path contracts/sp1/confidential/cxfer-core/Cargo.toml

# Off-chain dapp/prover round-trips (each mirrors the guest asserts)
for t in transfer-roundtrip swap-op lp-op otc-op bid-op settle relay \
         bridge-mint bridge-burn memo indexer canonical-asset-id \
         reflection-scan reflection-scan-indexer; do node tests/confidential-$t.mjs; done

# Pin discipline + tiered go/no-go
bash contracts/sp1/confidential/verify-vkey-pin.sh
bash contracts/sp1/confidential/readiness-gate.sh   # POOL + BRIDGE verdicts

# In-zkVM execute of a real op witness (acceptance, no GPU) — the gold-standard local check
cd contracts/sp1/reflect-exec && cargo run --release --bin otc-execute   # and bid-execute
```

The readiness gate is the operational sign-off harness: a green `POOL` verdict + a coherent
vkey/ELF pin + all `*ProofReal` suites passing is the on-chain-soundness bar; `BRIDGE` adds the
cross-chain gates. **`POOL` currently reports READY; `BRIDGE` reports NOT READY** — gate layer 9
blocks on REFLECT-1 (§7): the pinned reflection guest `0x0099e1c7` is unsound until the corrected
re-prove repins. Treat a `FAIL` as a regression; a `BLOCKED` gate is a tracked milestone, not a pass.

---

## 9. Method + deliverable + sign-off

**Method.** (1) Per op, trace value-in vs value-out in `main.rs`; list what the contract cannot see
(only hashes) and confirm the guest enforces each such property. (2) Cross-read the **three faces**
of every op — contract (`ConfidentialPool.sol`) ↔ guest (`main.rs`) ↔ client (`confidential-*.js`);
they must agree on field order and every assertion. (3) Run the suites, then hunt coverage gaps — an
op or reject-branch with no negative test is a finding. (4) Verify the pin/coherence discipline and
the relay trust surface.

**Deliverable.** For each issue: severity (**fund-critical / soundness / liveness**), `file:line`,
the property that breaks, and a **minimal failing regression test** (forge or node). Then **apply
the fix** and show the test passing. A failing-then-passing regression is the unit of work, not
prose. Keep changes minimal and in the style of the surrounding code; if a fix touches the guest's
`PublicValues` layout or a `cxfer-core` primitive, note that it requires a coordinated re-prove
(the ELF + pin + every fixture move together).

**Sign-off criteria.** Mainnet-ready when, for the POOL layer (and the BRIDGE layer if activating
cross-chain): every property in §5 holds with a confirming (and negative) test; the readiness gate
is green with no FAIL; the vkey/ELF pin coheres (deploy == pin == every `*ProofReal` fixture); the
client↔guest parity tests pass; and the residual boundaries in §7 are the *only* open items, each
documented and within its stated bound. Produce a one-paragraph verdict naming the layer signed off,
the residuals, and any deferred (non-fund-critical) items.
