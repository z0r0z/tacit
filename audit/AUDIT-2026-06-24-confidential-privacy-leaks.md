# Tacit v1 — Confidential Pool Privacy / Information-Leak Audit

**Scope:** information disclosure — what a chain observer, RPC operator, or relayer can learn about a user's
identity, amounts, assets, and the links between their operations across the Tacit confidential pool, the SP1
guest/prover, the note crypto, and the off-chain dapp/indexer/relay. This is a **privacy** review (leaks,
linkability, deanonymization); fund-safety/double-spend/inflation was covered separately in
`AUDIT-2026-06-23-tacit-v1-confidential-defi-bridge.md` and is out of scope here.

| | |
|---|---|
| **Protocol** | Tacit — confidential DeFi + trustless BTC↔ETH bridge (~26 confidential ops) |
| **Repository** | `tacit` |
| **Branch** | `confidential-relay-fees` |
| **Base commit** | `e40f438c3731c20401e559c0511a5a0068ce64dd` (`e40f438`, 2026-06-24) |
| **Audit date** | 2026-06-24 |
| **Auditor** | Claude Code — model **Opus 4.8 (1M context)** (`claude-opus-4-8[1m]`) |
| **Method** | Four parallel leak-class sweeps (guest public values, on-chain Solidity events/calldata, off-chain dapp/relay/indexer, note crypto/linkability), each cross-checked against the others and against the guest public-values struct. |

---

## 1. Executive summary

The review asked a single question per surface: *given everything an adversary can already see, what extra does
this code reveal about who did what?* The **cryptographic core is sound** — the nullifier, leaf, and commitment
constructions are hash-hiding, the sigma / BIP-340 / cross-curve challenges bind correctly, and the deliberate
`nullifier = f(Cx,Cy)` does **not** link two notes of the same owner. The pure-shielded operations
(TRANSFER without a fee, OTC, adaptor claim) leak no amount or asset.

The real disclosure surface is **public-state DeFi metadata and network-layer correlation**, not a crypto
defect. Where amounts are visible (AMM reserve deltas, CDP debt) it is **load-bearing by design** — the
constant-product check and permissionless liquidation require those values on-chain — and the correct mitigation
is *unlinkability* (a fresh, key-recoverable per-position owner) and *batching* (many intents behind one reserve
delta), both of which the architecture already supports.

**Headline result:** the slow-start launch ships some operations transparently (a solo AMM swap is a batch-of-1
whose reserve delta equals its exact size), but the path to amount-hiding is an **off-chain change only** — the
guest's OP_SWAP already clears N intents at a uniform price behind one aggregate delta, so enabling batching needs
**no contract redeploy and no guest re-prove**. No accidental plaintext-amount leak was found in any operation
that is meant to be shielded.

During the review one **latent functional bug** was found and fixed (the EVM transfer/route assembler sealed an
`undefined` note secret, which would throw on every confidential send/swap), and two privacy invariants that had
been *trusted but untested* were pinned with regression tests.

**Findings at a glance**

| ID | Severity | Area | Status |
|----|----------|------|--------|
| P-1 | Info | CDP event amounts duplicate the public proof journal | ◻ No change (load-bearing, already public) |
| P-2 | Medium | Self-relay reveals the user EOA as `msg.sender` | ✅ Mitigated (relay default; opt-in toggle, labeled) |
| P-3 | Structural | AMM swap/LP reserve & share deltas reveal trade size | ✅ Batch-ready (off-chain coordinator scaffolded) |
| P-4 | Info | CDP/farm position publishes legs + debt + per-position owner | ✅ Sound (fresh key-recoverable owner confirmed) |
| P-5 | Low | Relay fee leg exposes fee asset + value | ◻ Documented (flat gas-denominated fee policy) |
| P-6 | Low | Op-type / transaction-shape distinguishability | ◻ Accepted (mitigate via padding/batching) |
| P-7 | Low | Cross-out publishes asset + dest chain | ◻ Accepted (redemption binding) |
| C-1 | — | EVM note crypto linkability (ν / leaf / sigma / stealth) | ✅ Sound; F2/F4 invariants now tested |
| B-1 | Medium (bug) | Transfer/route sealed an `undefined` note secret | ✅ Fixed in source |

---

## 2. Scope — files reviewed

**SP1 guest / prover (public-values disclosure)**
- `contracts/sp1/confidential/src/main.rs` — all op handlers + the `PublicValues` journal committed on-chain
- `contracts/sp1/confidential/src/reflect.rs` — reflection fold/scan public outputs
- `contracts/sp1/confidential/cxfer-core/src/{lib.rs,sigma.rs,bjj.rs,bitcoin.rs,eth_reflection.rs}`, `src/babyjubjub.rs` — note crypto, nullifier/leaf/commitment, sigma protocols, stealth one-time keys, outpoint keying

**Smart contracts (events / calldata / storage visible to observers)**
- `contracts/src/ConfidentialPool.sol`, `contracts/src/ConfidentialRouter.sol`, `contracts/src/TacitRelayer.sol`
- `contracts/src/CollateralEngine.sol`, `contracts/src/BtcCallExecutor.sol`, `contracts/src/SP1PoolRootVerifier.sol`

**Off-chain dapp / relay / indexer (client + network metadata)**
- `dapp/confidential-relay.js`, `dapp/confidential-indexer.js`, `dapp/confidential-reflection-indexer.js`
- `dapp/confidential-pool.js`, `dapp/confidential-pool-ux.js`, `dapp/confidential-stealth.js`, `dapp/confidential-invoice.js`
- `dapp/confidential-transfer.js`, `dapp/confidential-router.js`, `dapp/confidential-defi-actions.js`, `dapp/confidential-defi-tab.js`, `dapp/confidential-swap.js`

---

## 3. Methodology

Four independent leak-class sweeps ran in parallel, each instructed to report only information-disclosure issues
(not fund safety) with a concrete observer and severity:

1. **Guest public values** — what the proof journal (`pv.abi_encode()`, the on-chain settle calldata) reveals per op.
2. **On-chain Solidity** — events, calldata fields, fee transfers, and `msg.sender` linkage visible to any observer.
3. **Off-chain dapp/relay/indexer** — RPC/relay calls, submission payloads, scan patterns, timing correlation, storage/logging.
4. **Note crypto / linkability** — nullifier/leaf/commitment structure, sigma-protocol soundness, blinding entropy, stealth unlinkability, outpoint keying.

Each finding was cross-checked against the guest public-values struct — the single source of truth for what is
ultimately public — to avoid reporting an "event leak" for a value the proof already publishes (this caught P-1).
Two crypto invariants that live in the out-of-scope dapp prover (asset-keyed blinding; fresh stealth ephemeral)
were pinned as executable regression tests rather than asserted on inspection.

---

## 4. Findings

### P-1 — Info — CDP event amounts duplicate the already-public proof journal (no change)

`CollateralEngine` emits `CdpMinted(positionLeaf, debtValue, collateralUsd)` and siblings
(`CollateralEngine.sol:489/525/552/627`) with cleartext debt and collateral. An initial read flagged this as a
leak to trim. **Cross-checking the guest disproved it:** `debtValue` and the per-leg `(asset, value)` are
committed in the `CdpMint`/`CdpClose`/`CdpLiquidate` public-values structs (`main.rs:101-106`) and travel as
public `settle()` calldata regardless of the event. They are **load-bearing**: permissionless liquidation
reconstructs `positionLeaf = H(controller, debtAsset, basketRoot, debtValue, rateSnapshot, owner, nonce)`, so
`debtValue` cannot be hidden without breaking liquidation. `collateralUsd` is the public legs valued at the public
oracle price — derivable, not incremental. **Disposition:** no change; trimming the events would break keepers for
zero privacy gain. The real CDP privacy property is unlinkability, covered in P-4.

### P-2 — Medium — Self-relay reveals the user EOA as `msg.sender` (mitigated)

A relayed op hides the user because the relayer (or the `ConfidentialRouter`) is `msg.sender` and the fee
recipient is bound inside the proof (`ConfidentialPool.sol:2006`, `TacitRelayer.sol`). If a user calls `settle()`
directly, `msg.sender` is their own EOA, linking them to the op. **Disposition:** the dapp routes ops through the
`api.tacit.finance` relay by default (the privacy path). Self-relay is retained as an explicit, **labeled opt-in**
fallback for when relayers are unavailable (relevant during launch provisioning) — the box proves fee-less and the
user broadcasts `settle()` from their own account. Wired as an optional `selfRelay` flag through `transfer`/`route`
with a UI toggle stating it "reveals that account on-chain"
(`dapp/confidential-pool-ux.js`, `dapp/confidential-send-tab.js`, `dapp/confidential-swap-tab.js`).

### P-3 — Structural — AMM swap/LP reserve & share deltas reveal trade size (batch-ready)

`reservePost − reservePre` (swap/route) and `sharesPost − sharesPre` (LP) are public and equal the exact
trade/contribution size (`ConfidentialPool.sol` AMM loops; `main.rs:986`, `main.rs:1159`). The note commitments
hide *who*, not *how much*; a solo swap is a batch-of-1 and is fully transparent, and a wrap→swap→unwrap of one
value is linkable by amount. **This is structural to a public-reserve AMM, but the fix is free:** the guest's
OP_SWAP handler already iterates over **N intents** accumulating gross flows into **one** aggregate
`SwapSettlement` at a uniform clearing price (`main.rs:870-892`). Batching solo→N is therefore a purely off-chain
coordination change — **no contract redeploy, no guest re-prove, no new ceremony**. The live dapp assembler
currently builds a single intent (transparent slow-start); a coordinator scaffold
(`dapp/confidential-swap-coordinator.js`, dependency-injected, **not wired** into the live path) buffers
per-pool intents, solves one clearing price, assembles a single OP_SWAP via the existing proven `buildBatch`, and
self-checks with the guest-mirror `verifyBatch`. **Disposition:** flip per-pool when intent volume justifies it.
LP add/remove do not net as naturally (shares are per-provider); their amount-hiding lever is standard-denomination
intents.

### P-4 — Info — CDP/farm position publishes legs + debt + a per-position owner (sound)

The `CdpMint` struct publishes every collateral leg `(asset, value)`, the debt value, and an explicit `owner`
(`main.rs:2296-2304`); farm bonds reuse it. Publishing the owner is required for permissionless liquidation. This
is safe **iff** the owner is fresh and unlinkable to the borrower's account. **Confirmed:** the assembler
generates the position owner with `rand32Hex()` (CSPRNG `getRandomValues`) per position
(`dapp/confidential-defi-tab.js:82`), distinct from the account owner; close/topup reuse the *recovered* owner to
reconstruct the position leaf. The value is **private-key recoverable** — it is sealed into the debt-note memo
(`value‖blinding‖secret‖asset‖owner`, ECDH-sealed to the borrower's pubkey, `dapp/confidential-memo.js:17`) and
read back on scan — so it satisfies "recover from your key alone" without being linkable on-chain. **Disposition:**
sound; no change.

### P-5 — Low — Relay fee leg exposes the fee asset + value (documented)

`FeePayment{assetId, value}` (TRANSFER/BRIDGE_BURN/UNWRAP/CDP_MINT) adds a public asset id + fee value to an
otherwise asset-and-amount-hidden op, and a constant fee value can fingerprint a wallet. `fee == 0` is
byte-identical to fee-free (`main.rs:375/459/712`), so the leg only appears when a fee is paid. **Disposition:**
the relay policy is a **flat, gas-denominated** per-op fee independent of trade size (documented in
`dapp/confidential-relay.js:10-15`), which removes the size signal; prefer a single common fee asset to avoid
revealing the transfer asset.

### P-6 — Low — Op-type / transaction-shape distinguishability (accepted)

The public-values journal uses typed per-op arrays and visible in/out leaf and nullifier counts, so an observer
learns which op types ran and the transaction shape (e.g. 2-in/3-out vs 1-in/1-out) even when amounts are hidden.
**Disposition:** structural; mitigate at the assembler with standard in/out-count padding and by batching mixed
ops so per-op cardinality is not isolatable.

### P-7 — Low — Cross-out publishes asset + destination chain (accepted)

`CrossOutRecorded(claimId, destChain, destCommitment, nullifier, assetId)` (`ConfidentialPool.sol:609`) and the
deterministic `claimId` link an Ethereum burn to its Bitcoin-side mint, and expose the bridged asset.
**Disposition:** the linkage and `claimId` are load-bearing for the redemption binding; the bridged asset being
public is accepted and documented.

### C-1 — Note crypto linkability — sound; invariants now tested

No exploitable linkability defect in the verifier-side crypto. `nullifier = keccak(Cx‖Cy‖"spent")` and
`commitment = keccak(Cx‖Cy)` are hash-hiding with no owner/asset in the preimage, so a nullifier links a note to
*its own* spend only, never two notes of one owner; the deliberate asset-omission keeps ν identical cross-lane.
The opening sigma, BIP-340, and cross-curve (secp↔BJJ) Fiat-Shamir challenges all bind both commitments and
nonce-points and never expose the witness. The reflected-note zero-owner sentinel is a deliberate anonymity-set
merge, not a leak. Two invariants live in the out-of-scope dapp prover and were **pinned as tests**
(`tests/confidential-privacy-invariants.mjs`, 5/5):
- **F2 — asset-keyed blinding:** `deriveNote` folds `b32(assetId)` into the blinding
  (`dapp/confidential-pool.js:51`), so two notes of different assets cannot collide to the same commitment /
  nullifier (a cross-asset linkage + lock surface).
- **F4 — stealth unlinkability:** a fresh ephemeral per send yields distinct one-time addresses, the recipient
  round-trips the correct spend key, and the key is unrecoverable without the recipient secret.
- One in-scope hygiene invariant noted: the raw commitment coordinates `(Cx,Cy)` must never reach public calldata
  (honored today via `deposit_commit`/`deposit_id`, which hash the coordinates first).

### B-1 — Medium (functional bug, found during review) — transfer/route sealed an `undefined` note secret (fixed)

`identity()` returned `{priv, pubHex, owner}` with no `secret`, but `buildTransferOp`
(`dapp/confidential-pool-ux.js:306-308`) and `route` (`:408-409`) read `id.secret` for the output recovery
descriptor and to derive the memo ephemeral — so `BigInt(undefined)` threw on every confidential send/swap memo
seal, breaking the live send and swap tabs. **Fix:** add a defined, wallet-deterministic, domain-separated
`secret` to `identity()` (`dapp/confidential-pool-ux.js:121-127`). It is vestigial for EVM notes (spend = knowledge
of the blinding; the leaf/commit/nullifier omit it), so there is no behavior change beyond making the seal
well-formed. Surfaced by the new `selfRelay` routing test.

---

## 5. Security posture — surface-by-surface verdict

| Surface | Verdict |
|---|---|
| Note crypto (ν / leaf / commitment / sigma / stealth) | **Sound** — hash-hiding, no same-owner linkage, witness never exposed (C-1) |
| Pure-shielded ops (TRANSFER no-fee / OTC / adaptor claim) | **Sound** — no amount or asset disclosed; OTC commits ν + leaves only |
| AMM swap / route / LP | **Transparent at launch, batch-ready** — amounts public per solo op; off-chain batching hides them with no re-prove (P-3) |
| CDP / farm positions | **Sound** — amounts public by design, unlinkable via a fresh key-recoverable owner (P-4) |
| Relay / fee leg | **Acceptable** — flat gas-denominated fee; user EOA hidden unless self-relay is opted into (P-2, P-5) |
| Cross-out / bridge | **Acceptable** — asset + dest chain public for the redemption binding (P-7) |
| Network layer (wrap on-ramp, scan→submit timing) | **Residual** — wrap is inherently EOA-public; scan(RPC)→submit(relay) is IP/timing-correlatable; mitigate via proxy/jitter (documented) |

---

## 6. Changes made during this review

All changes are off-chain (dapp/tests); **no contract or guest change**, so nothing requires a re-prove.

- **B-1 fix** — defined note `secret` in `identity()` (`dapp/confidential-pool-ux.js`).
- **P-2** — optional `selfRelay` path in `transfer`/`route` + labeled UI toggles
  (`dapp/confidential-pool-ux.js`, `dapp/confidential-send-tab.js`, `dapp/confidential-swap-tab.js`).
- **P-3** — swap-batch intent coordinator scaffold, dependency-injected and unwired
  (`dapp/confidential-swap-coordinator.js`).
- **C-1** — F2/F4 privacy invariants pinned (`tests/confidential-privacy-invariants.mjs`).
- **Tidy** — `tickerOf` null-asset guard (`dapp/confidential-pool-ux.js`) + stale-export repair of
  `tests/confidential-pool-ux.mjs` (now points at `getConfidentialDeployment('signet')`).

---

## 7. Verification performed

- `tests/confidential-privacy-invariants.mjs` — 5/5 (F2 asset-keyed blinding, F4 stealth unlinkability)
- `tests/confidential-swap-coordinator.mjs` — 6/6 (N intents → one OP_SWAP; passes the guest-mirror `verifyBatch`)
- `tests/confidential-pool-ux.mjs` — 16/16 (incl. `selfRelay` routing: prove + EOA broadcast vs default relay-settle)
- `tests/confidential-route-op.mjs`, `tests/confidential-transfer-roundtrip.mjs`, `tests/confidential-defi-actions.mjs` — green

---

## 8. Recommendations

1. **Document the public-fields-per-op table** for users — precisely which fields each op exposes (wrap amount,
   AMM delta, CDP debt, fee leg) so the privacy model is explicit.
2. **Enable swap batching** per-pool when intent volume supports it (off-chain only; the coordinator scaffold is
   ready to wire).
3. **Assembler hygiene** — standard-denomination intents (P-3 LP, P-5/P-6) and in/out-count padding (P-6) to
   reduce amount/shape fingerprinting.
4. **Network transport** — offer proxy/Tor for the RPC and relay legs and add jitter between scan and submit to
   blunt IP/timing correlation; document that wrap is an EOA-public on-ramp.
