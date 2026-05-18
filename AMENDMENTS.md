# Tacit Spec Amendments — Index

> Living index of all draft amendments to the tacit protocol.
> Each entry tracks status, scope, dependencies, and merge criteria.
> Amendments live as standalone `SPEC-*-AMENDMENT.md` files until
> they meet their merge criteria, then are folded into `SPEC.md`.

---

## Status legend

| Status | Meaning |
|---|---|
| 📝 **Draft** | Initial author draft; no review yet |
| 🔍 **Round-N review** | Peer review iteration in progress (N = current round) |
| 🧠 **Crypto review** | Pending independent cryptographic review (FROST, DLC, novel primitives) |
| 🛠️ **Implementation** | Reference implementation in progress against the draft |
| 🚀 **Deployed** | Implementation deployed; mainnet activation in progress |
| ✅ **Merged** | Folded into SPEC.md; amendment file kept as historical record |

---

## Amendments at a glance

All amendment files live under [`spec/amendments/`](./spec/amendments/).
All design docs live under [`spec/design/`](./spec/design/).

| Amendment | Status | Opcodes / features added | Implementation | File |
|---|---|---|---|---|
| Variable-amount T_AXFER | ✅ Merged | `T_AXFER_VAR` (`0x37`); §5.7.6.1 coordination layer; OP_RETURN(80) dual-party recovery | dapp + worker shipped; signet-validated; SPEC.md §5.7.6.1 + §5.7.9 ✅ | [`spec/amendments/SPEC-VARIABLE-AMOUNT-AMENDMENT.md`](./spec/amendments/SPEC-VARIABLE-AMOUNT-AMENDMENT.md) |
| Variable-fill bid intents | ✅ Merged | §5.7.7 partial-fill bid coordination layer (no new opcode — settles via existing `T_AXFER_VAR` `0x37`); `min_fill_amount` on bid record; multi-seller fan-out per signed bid | dapp + worker shipped; signet-validated; SPEC.md §5.7.7 covers both whole-bid (`T_AXFER` `0x26`) and variable-fill (`T_AXFER_VAR` `0x37`) settlement paths | [`spec/amendments/SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md`](./spec/amendments/SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md) |
| Tacit wrapper convention | ✅ Merged | CETCH metadata `tacit_wrapper` field; `T_WRAPPER_ATTEST` (`0x38`); coverage check + open-issuer marketplace | SPEC.md §4.2 + §5.19 ✅; indexer + dapp work pending | [`spec/amendments/SPEC-WRAPPER-AMENDMENT.md`](./spec/amendments/SPEC-WRAPPER-AMENDMENT.md) |
| Per-trade variable-amount AMM swap | ✅ Merged | `T_SWAP_VAR` (`0x32`); per-fill against-curve settlement reusing CXFER N=2 crypto from `T_AXFER_VAR`; tick-fan coordination layer for settler-chosen Δ; opt-in alongside `T_SWAP_BATCH`. No new Groth16 circuit, no new ceremony — uses existing AMM pool state pinned at POOL_INIT. | Reference impl at `tests/swap-var.mjs` (44 tests); re-exported from `tests/amm-validator.mjs`; SPEC.md §5.20 ✅; spec-conformance pins 5 new domain tags + `OPCODE_T_SWAP_VAR == 0x32`. Extended-narrative draft preserved at the amendment file. | [`spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md`](./spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md) |
| Orderbook preconfirmation channel | 📝 Draft (round-1) | Orderbook scope schemas + usage conventions for the existing scope-generic `T_INTENT_ATTEST` (`0x30`) opcode — no new opcode, no new domain tag, no new crypto. Just `scope_id` derivation rules for orderbook intents (per-pair, per-worker-global) on top of SPEC.md §5.17. | Not started; ships independent of AMM ceremony | [`spec/amendments/SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md`](./spec/amendments/SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md) |
| Atomic cross-surface settlement (`T_TRADE_BATCH`) | 📝 Draft (round-1) | Opcode `0x39`; settles N AMM intents + K orderbook bilateral pairs atomically in one Bitcoin tx; no new cryptographic primitive, no new circuit, no new ceremony. Reuses existing AMM Groth16 vk + CXFER N=2 stack. | Reference impl deferred until cross-surface demand justifies engineering work; ships as a follow-up amendment after the AMM ceremony lands (soft-fork-additive under the §5.5 unknown-opcode rule). | [`spec/amendments/SPEC-TRADE-BATCH-AMENDMENT.md`](./spec/amendments/SPEC-TRADE-BATCH-AMENDMENT.md) |
| Atomic multi-hop AMM routing (`T_SWAP_ROUTE`) | ✅ Merged into SPEC.md §5.22 | Opcode `0x33`; settles a single trader's N-hop swap through up to `N_HOPS_MAX = 4` AMM pools atomically in one Bitcoin tx. Uniswap-V2-router parity for tacit. Pre-ceremony viable — reuses `T_SWAP_VAR`'s bulletproof rangeproof + kernel-sig stack; no Groth16, no ceremony coupling. Orthogonal to `T_TRADE_BATCH` (`0x39` — that opcode is cross-surface AMM↔orderbook; this one is multi-pool AMM↔AMM). | Reference impl: `tests/swap-route.mjs` (wire + msg builders + validator); `tests/swap-route.test.mjs` (24/24 passing — wire roundtrip, honest 2-hop A→B→C, adversarial: expiry, stale reserves, over-claimed delta, broken asset chain, broken amount chain, min_out, tampered sigs, drained pool, fee_bps mismatch, receipt opening). Re-exported from `tests/amm-validator.mjs`. Worker dispatch + dapp builder + UI tile + signet harness shipped (`tests/swap-route-dapp-worker-parity.test.mjs` 13/13, `tests/amm-router-preview.test.mjs` 13/13, `tests/amm-swap-route-onchain-e2e-signet.mjs` ready). SPEC.md §5.22 merged 2026-05-18. | [`spec/amendments/SPEC-SWAP-ROUTE-AMENDMENT.md`](./spec/amendments/SPEC-SWAP-ROUTE-AMENDMENT.md) |
| Cross-worker mesh attestation | 📝 Draft (phase 0) | Multi-worker BFT consensus on `T_INTENT_ATTEST` to remove the single-worker SPOF for soft-confirms. No new opcode or crypto; mesh is a coordination protocol over the existing attestation envelope. | Not started; V1.x track | [`spec/amendments/SPEC-TACIT-MESH-AMENDMENT.md`](./spec/amendments/SPEC-TACIT-MESH-AMENDMENT.md) |
| Tacit range-proof primitive (§3) | ✅ Reference impl shipped; SPEC.md merge pending | Bulletproof-derived range-proof primitive (`tests/range-proof.mjs`, 39 tests). Slated for SPEC.md §3 as a normative primitive when consumers land. | Lives in the amendment file until SPEC.md merge; no opcode coupling. | [`spec/amendments/SPEC-RANGE-PROOF-PRIMITIVE.md`](./spec/amendments/SPEC-RANGE-PROOF-PRIMITIVE.md) |
| Range-attestation opcode | ✅ Reference impl shipped; SPEC.md §5.21 merge pending | `T_RANGE_ATTEST` (`0x3A`); persistent on-chain range-attestation envelope binding a holder pubkey to a `commitment ≥ K` claim. Power-user feature (KYC tier proofs, reputation, governance weight). | Reference impl at `tests/range-attest.mjs` (23 tests); ships as V1.x amendment post-V1 ceremony. | [`spec/amendments/SPEC-RANGE-ATTEST-AMENDMENT.md`](./spec/amendments/SPEC-RANGE-ATTEST-AMENDMENT.md) |
| Batched preauth-take | ✅ Merged | No new opcode. Formalizes a property of existing `T_AXFER` (`0x26`) under §5.7.8: BIP-143 `SIGHASH_SINGLE_ACP` preimages are position-independent for matching payout content, so N preauth sales by N distinct sellers settle in one (commit, reveal) pair using `asset_input_count = N` (already permitted by the wire format). ~70% fee reduction for multi-fill buys. SPEC.md §5.7.8.1 carries the canonical text; amendment file kept as historical record. | Shipped at `dc7a48e` + `79763f5` + `6648e7d` (fill_count). `tests/preauth-take.test.mjs` 55/55 + `tests/bid-fulfil-batch.test.mjs` 13/13 + `tests/bid-fulfil-batch-e2e.test.mjs` 11/11 + `tests/preauth-recovery-banner.test.mjs` 17/17 + `tests/worker-batched-axfer-index.test.mjs` 24/24 = 120 batch tests. Worker redeploy required for `fill_count` storage (deployed at `b317006e`). | [`spec/amendments/SPEC-PREAUTH-BATCH-AMENDMENT.md`](./spec/amendments/SPEC-PREAUTH-BATCH-AMENDMENT.md) |
| Bulletproofs+ confidential transfer | ✅ Merged (signet bake in flight) | `T_CXFER_BPP` (`0x22`); byte-identical to `T_CXFER` (`0x23`) except the rangeproof is Bulletproofs+ instead of Bulletproofs. ~14% smaller witnesses across `m ∈ {1,2,4,8}`. Same kernel sig, same Pedersen commitments, same ECDH amount recovery, same `tacit-kernel-v1` domain tag, same NUMS generators (`tacit-bp-G-v1` / `tacit-bp-H-v1` / `tacit-bp-Q-v1` reused from §3.1). Universal fee cut across every CXFER edge — touches every transfer + AMM/orderbook follow-on consumption. No new domain tags. Mixed-ancestry walks recurse through both verifiers. Soft-fork-additive per §5.5 unknown-opcode rule. | Shipped: `dapp/bulletproofs-plus.js` (907 LOC BP+ prover/verifier + Pippenger MSM in `bppRangeVerify` closing perf parity to BP); `dapp/tacit.js` (encoder + decoder + validator dispatch + send-path `useBpp` flag); `worker/src/index.js` (decoder + ancestry-walk + canonical-order branches). Tests: 11 BP+ test files (roundtrip / adversarial / malicious-prover / monero-scenarios / pinned-fixtures / property-fuzz / symbolic-identity / witness-extractor / python-parity / bounded-exhaustive / prover-smoke) + `cxfer-bpp-wire.test.mjs` (136 wire-format tests) + `cxfer-bpp-integration.test.mjs` (full envelope → validator pipeline) + `bulletproofs-plus.bench.mjs` (verify-perf parity vs BP). On-chain harness `tests/cxfer-bpp-onchain-e2e-signet.mjs` exercises ≥5-hop mixed-ancestry CETCH → BPP → CXFER → BPP → BPP round-trip. Activation gated by `bppEnabled()` — default ON for signet, OFF for mainnet (`localStorage['tacit-bpp-enable-mainnet-v1']`). SPEC.md §5.21 ✅ + §1.1 opcode table row + §5.5 dispatch branch landed. | [`spec/amendments/SPEC-CXFER-BPP-AMENDMENT.md`](./spec/amendments/SPEC-CXFER-BPP-AMENDMENT.md) |
| Bulletproofs+ atomic OTC settlement | 📝 Draft (round-1) | `T_AXFER_BPP` (`0x3C`) + `T_AXFER_VAR_BPP` (`0x3D`); BP+ variants of `T_AXFER` (`0x26`) and `T_AXFER_VAR` (`0x37`) respectively. Byte-identical wire formats modulo opcode + rangeproof bytes. ~14% witness reduction on every atomic OTC settlement (listings, fills, variable-amount partial fills, batched preauth-take routes). Same kernel-msg construction (`tacit-kernel-v1`), same Pedersen, same OP_RETURN(80) dual-recovery for T_AXFER_VAR_BPP. No new domain tags. Reuses the production BP+ prover/verifier from `T_CXFER_BPP`. Mixed-ancestry walks across BP and BP+ AXFER variants. | Wire-format infra landed in `dapp/tacit.js` (encoders/decoders/validator dispatch/getParentEnvelopeData/scanHoldings) + `worker/src/index.js` (constants + decoders). `tests/axfer-bpp-wire.test.mjs` pins encode/decode roundtrip + rejection cases + byte-level structural invariants vs BP twins. Pending: worker scan-loop integration, signet on-chain harness, send-path `useBpp` flag on the AXFER builders. | [`spec/amendments/SPEC-AXFER-BPP-AMENDMENT.md`](./spec/amendments/SPEC-AXFER-BPP-AMENDMENT.md) |
| LP-bond yield farms | ✅ Reference impl shipped; SPEC.md merge pending | Five opcodes: `T_FARM_INIT` (`0x34`) + `T_LP_BOND` (`0x35`) + `T_LP_UNBOND` (`0x36`) + `T_LP_HARVEST` (`0x3B`) + `T_FARM_REFUND` (`0x3E`); plus farm-state attestation conventions for the existing scope-generic `T_INTENT_ATTEST` (`0x30`). MasterChef-style staked-LP rewards on tacit AMM pools. Permissionless launcher-funded reward treasuries via **virtual bookkeeping** (matches AMM reserves, mixer pool, cBTC.tac insurance — no on-chain treasury UTXOs); lazy per-Bitcoin-block accrual mirroring the protocol-fee `mintFee` Q.96 pattern; per-bond worker-indexed records keyed by `T_LP_BOND.vout[1].outpoint`. Bond receipts are plain P2WPKH dust markers (not a tacit asset class — bonds non-transferable in v1). Harvest claims reward without unbonding (entry_acc roll-forward); refund returns unspent treasury post-`end_height + 1008 blocks` (~7 days). Reuses kernel-sig + Pedersen + bulletproof stack from `T_SWAP_VAR`. No Groth16, no new ceremony. Bootstrap target: TAC/cBTC.tac and cBTC.tac/cBTC.zk pair pools. Total wire across the five opcodes: ~2.0 KB. | Reference impl shipped (`tests/amm-farm.mjs` — 101 tests + 10k-trace property fuzz + 6 cross-impl parity tests). Worker integration shipped (`worker/src/index.js` — full crypto-verifying chain-scan, KV state, emit-resolver, `/farm/:farm_id` + `/farms?pool=` endpoints). Dapp encoders/decoders + msg builders shipped (`dapp/amm-envelope.js`). Launcher CLI at `tests/tools/create-farm.mjs` with dry-run validator confirmation. Signet harness skeleton at `tests/amm-farm-e2e-signet.mjs` (FARM_INIT path dry-run verified). 119/119 spec-conformance pins green. Target SPEC.md §5.40–§5.44 + §5.45 (attestation conventions) merge. | [`spec/amendments/SPEC-AMM-FARM-AMENDMENT.md`](./spec/amendments/SPEC-AMM-FARM-AMENDMENT.md) |
| Protocol oracle + canonical cBTC + canonical cUSD | 🪦 Superseded by `SPEC-CBTC-TAC-AMENDMENT.md` + `SPEC-CUSD-TAC-AMENDMENT.md` (AMM-oracle architecture removes the need for FROST + dedicated price-attest opcodes). Earlier opcode reservations `0x39`–`0x42` are RETIRED and reusable; `0x39` is reassigned to `T_TRADE_BATCH`, `0x3A` to `T_RANGE_ATTEST`. | n/a — design path retired | [`spec/amendments/SPEC-CUSD-TAC-AMENDMENT.md`](./spec/amendments/SPEC-CUSD-TAC-AMENDMENT.md) |

### Supporting docs (not amendments, informative only)

| Document | Status | Purpose | File |
|---|---|---|---|
| cBTC reference issuer operational design | 📝 Round-1 fixes landed | One concrete application of the wrapper convention — TAC-operated federated 3-of-5 multisig cBTC variant | [`spec/design/CBTC-ISSUER-DESIGN.md`](./spec/design/CBTC-ISSUER-DESIGN.md) |
| Channel UX design | 📝 Draft | UX design for the trader-side preconfirmation channel and dapp soft-confirm rendering | [`spec/design/CHANNEL-UX-DESIGN.md`](./spec/design/CHANNEL-UX-DESIGN.md) |

---

## Variable-amount T_AXFER

### Summary

Adds continuous-amount partial-fill semantics to tacit's atomic-
intent flow via `T_AXFER_VAR` (`0x37`). Reuses the existing CXFER
N=2 cryptography. Maker posts one intent advertising "up to X tacit
at price P per unit, minimum Y"; takers fill any amount in
`[Y, X]`. Single Bitcoin tx per fill, atomic at the moment of trade.

### Key additions

- **Opcode `0x37`** `T_AXFER_VAR` — variable-amount atomic settlement
- **§5.7.6.1** coordination layer extending §5.7.6 atomic intents
- **OP_RETURN(80) dual-party recovery** — seed-only recovery for
  both recipient and maker change
- **3 new BIP-340 domain tags** (`tacit-axintent-publish-v1`,
  `tacit-axintent-claim-v3`, `tacit-axintent-fulfilment-v2`)
- **4 new HMAC keystream domains** (change blinding +
  on-chain recovery keystreams)

### Dependencies

None. Independent of all other amendments.

### Merge criteria

- [x] Peer review (2 rounds)
- [x] Reference implementation in dapp + worker
- [x] Signet e2e validation
- [x] **Merged into SPEC.md (2026-05-15)** — §5.7.6.1 (coordination
  layer + on-chain recovery) + §5.7.9 (T_AXFER_VAR wire format +
  validator) + 7 new domain tags in §3 + §5.5 dispatch branch +
  preamble opcode list extended with `0x37`
- [ ] Crypto review of m=2 BP / kernel-sig reuse + dual-OP_RETURN(80) encoding (post-merge)
- [ ] Backwards-compat replay test (50 historical T_AXFER txs)
- [ ] tacitscan parity confirmation

### Tracker notes

The most-mature amendment. End-to-end validated on signet (commit
`bcad53f6`, signet block 304223). On-chain recovery confirmed
working: scanner finds OP_RETURN(40), decrypts via ECDH, opens
Pedersen commitment from chain + privkey alone.

**As of 2026-05-15 the variable-amount amendment is fully merged into
`SPEC.md` (§5.7.6.1 coordination layer + §5.7.9 T_AXFER_VAR wire
format).** The standalone amendment file is preserved as a
historical record.

---

## Variable-fill bid intents

### Summary

Extends §5.7.7 bids so a single signed buy offer is partial-fillable
by multiple sellers. The on-chain settlement opcode is unchanged
from §5.7.9 — every partial fulfilment is a standard `T_AXFER_VAR`
(`0x37`) reveal. Only the off-chain coordination layer gains the
partial-fill shape, mirroring §5.7.6.1 on the ask side.

Combined with §5.7.6.1 (variable-amount asks), this completes the
orderbook UX: any party can partially match any other party's open
order, no AMM required as the matching engine. The two amendments
together are the pure-form Bitcoin orderbook DEX that runs
alongside the AMM (`T_SWAP_BATCH` / `T_SWAP_VAR`) as a peer
liquidity surface.

### Key additions

- **No new opcode** — partial fills settle via existing
  `T_AXFER_VAR` (`0x37`)
- **§5.7.7 bid record extension** — adds `min_fill_amount` field
  (whole-bid behaviour stays available as the natural case
  `min_fill_amount == amount`)
- **Per-bid fulfilment register** — worker tracks cumulative
  filled amount across multi-seller fan-out; bid is "live" until
  fully filled or expired
- **CAS race hardening** — variable-fill claims survive concurrent
  partial-fulfilment attempts under worker-side compare-and-swap
  (see commit `c45a314`)
- **0 new BIP-340 domain tags** — reuses `tacit-axintent-claim-v3`
  and `tacit-axintent-fulfilment-v2` from the variable-amount
  amendment; coordination-layer fan-out is off-chain

### Dependencies

- **Variable-amount T_AXFER** — fulfilment settles via
  `T_AXFER_VAR`; without it, partial fills have no atomic on-chain
  primitive

### Merge criteria

- [x] Peer review (2 rounds)
- [x] Reference implementation in dapp + worker (commits
  `436c3fc` re-credit cron, `3f28cf1` dapp builder, `327c2fc`
  bid-harness signet rehearsal, `c45a314` CAS hardening)
- [x] Signet e2e validation
- [ ] **Merging into SPEC.md as §5.7.7 extension** (in flight)
- [ ] Backwards-compat replay test (50 historical whole-bid txs)
- [ ] tacitscan parity confirmation

### Tracker notes

The asymmetric counterpart to variable-amount T_AXFER. Where
`T_AXFER_VAR` (§5.7.9) gave the ask side continuous partial
fills, this amendment gives the bid side the same property —
closing the orderbook DEX's depth-fragmentation problem.

The dapp's swap tile (`dapp/tacit.js`, commit `7f68faa`
"fill-then-bid") already routes through variable-fill bids as
the residual-fallback leg of a typed-budget swap. Worker-side
partial-fill cron (commit `436c3fc`) re-credits abandoned partial
fills so an aborted multi-seller fan doesn't strand the buyer's
sats.

---

## Orderbook preconfirmation channel

### Summary

Defines **canonical scope schemas and usage conventions** for
applying the protocol's scope-generic preconfirmation opcode
`T_INTENT_ATTEST` (`0x30`, SPEC.md §5.17) to orderbook intents.
**No new opcode**, **no new domain tag**, **no new cryptographic
primitive** — this amendment is a thin layer on top of the
existing `T_INTENT_ATTEST` envelope.

Worker maintains an off-chain commitment to its open orderbook
intent set per scope; broadcasts a signed hash on chain periodically
(default cadence: one attestation per Bitcoin block per non-empty
scope); traders verify their intent is included by fetching the
worker's published sorted intent-id list and recomputing the
SHA-256.

The orderbook is already in production; this amendment closes the
trust gap where traders rely on the worker's word for "your intent
is being tracked." Soft-confirm status becomes cryptographically
accountable within ~30 s of intent post. Because `T_INTENT_ATTEST`
has no Groth16 / no Pedersen / no ceremony, this ships
**independent of the AMM ceremony timeline** — the worker +
indexer dispatch can land as soon as the validator branch is
implemented.

### Key additions

- **No new opcode** — uses existing `T_INTENT_ATTEST` (`0x30`,
  SPEC.md §5.17) which is scope-generic by design.
- **No new domain tag** — reuses `tacit-intent-attest-v1`.
- **No new cryptographic primitives** — BIP-340 Schnorr + canonical
  SHA-256 list hashing.
- **§5.7.10 scope schemas** for orderbook use:
  - Per asset-pair: `SHA256("tacit-orderbook-pair-v1" ||
    asset_id_min || asset_id_max)`
  - Per worker global pool: `SHA256("tacit-orderbook-global-v1" ||
    worker_pubkey)`
- **Channel framing** — operationally analogous to a payment channel
  but with N-party state, no funding tx, no penalty mechanism,
  no covenants. Worker is fungible; unilateral exit always available
  (taker discovers maker UTXO from chain and self-completes via
  `T_AXFER_VAR`).
- **Shared dapp + worker code** with the AMM channel (one
  validator dispatch path, one trader UX component).

### Dependencies

- **`T_INTENT_ATTEST` (SPEC.md §5.17)** — the scope-generic
  attestation opcode this amendment provides scope schemas for.
- **Variable-amount T_AXFER** (`T_AXFER_VAR` `0x37`) — the
  settlement primitive the orderbook channel attests over.
- **Variable-fill bid intents** (§5.7.7) — the bid-side intent
  shape; together with §5.7.6.1 asks, this is what the channel
  commits to.

No dependency on AMM, the AMM ceremony, or any AMM opcode beyond
`T_INTENT_ATTEST` (which has no ceremony).

### Merge criteria

- [ ] Peer review (2 rounds)
- [ ] Reference dapp implementation (per-worker attestation watcher
      + soft-confirm UX surface; shared component with AMM channel)
- [ ] Reference worker / indexer implementation (per-scope intent-pool
      tracking + periodic `T_INTENT_ATTEST` broadcast + indexer
      dispatch; the dispatch path is shared with AMM scope
      attestations)
- [ ] Signet e2e validation (15 test items in amendment file)
- [ ] Cross-impl parity tests
- [ ] Merge into SPEC.md as §5.7.10

### Tracker notes

Drafted 2026-05-15 in response to the observation that the channel
construction in AMM.md (`T_INTENT_ATTEST` → tacit channel) is
intent-pool-generic — it doesn't depend on AMM-specific math. The
orderbook DEX is already in production and would benefit from the
same cryptographic accountability mechanism for soft-confirm UX.

Design history: the amendment was initially drafted as a parallel
opcode (`T_ORDERBOOK_ATTEST` at `0x43`). On reflection, since
nothing has shipped yet AND the AMM and orderbook channels are
cryptographically identical AND a trader's swap-tile flow already
composes both surfaces (fill-then-bid spans orderbook + AMM in one
logical trade), the decision was made to **unify under a single
scope-generic opcode** `T_INTENT_ATTEST` (renamed from
`T_AMM_ATTEST` to reflect its true generality). The orderbook
amendment now defines the orderbook-specific scope schemas + usage
conventions on top of that primitive.

Implementation reality: shipping the orderbook channel today
benefits both surfaces:
1. The orderbook trader gets cryptographically-accountable
   soft-confirm UX immediately.
2. The shared validator dispatch + UX component is built once,
   reused by the AMM channel when AMM ceremony lands.
3. The "AMM hasn't shipped yet" pre-launch posture is preserved —
   `T_INTENT_ATTEST` carries no Groth16 / no Pedersen / no
   ceremony, so it can launch as part of the orderbook track in
   step 1 of the recommended landing order.

---

## Tacit wrapper convention

### Summary

Adds CETCH metadata convention for **wrapped assets** — tacit-native
tokens backed by Bitcoin-layer assets (native sats, runes,
ordinals) custodied by an issuer with publicly auditable reserves.
Permissionless: anyone can CETCH a wrapper-tagged asset. The
convention enables dapp routing across competing variants, coverage
verification from chain alone, and issuer-attestation-based
liveness signals.

### Key additions

- **§4.2** wrapper convention (CETCH metadata extension)
- **§5.19** `T_WRAPPER_ATTEST` (`0x38`) — optional on-chain
  attestation envelope (originally drafted as §5.20; collapsed to
  §5.19 at merge time because variable-amount T_AXFER_VAR lives
  under §5.7 subsections rather than its own top-level §5.X slot)
- **1 new BIP-340 domain tag** (`tacit-wrapper-attest-v1`)
- **Cryptographic coverage check** computable from public chain data
- **Issuer attestation chain** (off-chain by default, on-chain
  optional via T_WRAPPER_ATTEST)

### Dependencies

- **Variable-amount T_AXFER** (recommended; variable-amount intents
  are the natural mint/burn primitive for federated wrappers).
  Wrapper convention works without it but is significantly more
  ergonomic with it.

### Merge criteria

- [x] Peer review (2 rounds)
- [x] **Merged into SPEC.md (2026-05-15)** — §4.2.1–§4.2.6 +
  §5.19 T_WRAPPER_ATTEST + `tacit-wrapper-attest-v1` BIP-340 tag
  + §5.5 validator dispatch branch
- [ ] Independent review of `tacit-wrapper-attest-v1` BIP-340
  message construction (post-merge, alongside CDP crypto review)
- [ ] Reference indexer + dapp wrapper-registry support
- [ ] First reference wrapper instance CETCHed on signet
- [ ] Backwards-compat replay test (50 historical CETCH txs)
- [ ] Production deployment + ~1 quarter operation across ≥3 wrapper
  variants

### Tracker notes

Reference cBTC instance documented in `CBTC-ISSUER-DESIGN.md` —
3-of-5 Taproot multisig with CSV escape, daily attestation cadence.
Not part of the spec; one possible application.

---

## Per-trade variable-amount AMM swap

### Summary

Adds a second AMM trader path: `T_SWAP_VAR` (`0x32`) settles single
trader fills against virtual pool reserves with continuous-amount
`[Y, X]` range semantics, reusing the CXFER N=2 cryptography from
`T_AXFER_VAR` (`0x37`). Lives alongside the existing batched-
uniform `T_SWAP_BATCH` (`0x2F`) as an opt-in alternative.

Two paths, deliberate trade-off:
- **`T_SWAP_BATCH`** — batched uniform clearing, fixed-amount
  intents, Groth16 proof hides trade size from chain observers
  (MEV-resistant, amount-confidential). 2–4 s settlement latency.
- **`T_SWAP_VAR`** — per-trade against curve, variable-amount
  range, no Groth16 proof, cleartext trade size on chain. One-
  block settlement, standard AMM UX. Trader's pre/post wallet
  balances still confidential via Pedersen commits.

Dapp UX defaults to `T_SWAP_VAR` for the swap-tile primary path;
`T_SWAP_BATCH` surfaces as "private mode" with the trade-off
explained.

### Key additions

- **Opcode `0x32`** `T_SWAP_VAR` — per-trade variable-amount AMM swap
- **SPEC.md §5.20** wire format + indexer-validation algorithm +
  tip mechanics + receipt-blinding scheme. (Appended as §5.20 to
  preserve back-reference stability with §5.19 T_WRAPPER_ATTEST;
  in opcode order this sits between §5.18 (`0x31`) and §5.19 (`0x38`).)
- **1 new BIP-340 domain tag + 4 new HMAC keystream domains**
  (BIP-340: `tacit-amm-swap-var-v1` for intent_msg; HMAC:
  `tacit-amm-swap-var-receipt-v1`, `tacit-amm-swap-var-recv-v1`,
  `tacit-amm-swap-var-change-v1`, `tacit-amm-swap-var-tip-v1`).
  Kernel-msg construction reuses CXFER's existing
  `tacit-kernel-v1` tag — no new kernel domain.
- **No new cryptographic primitives** — reuses CXFER N=2
  bulletproof + kernel-sig construction from `T_AXFER_VAR`
- **No new circuit / no new ceremony** — curve evaluation is pure
  indexer arithmetic against public `R_A_pre`, `R_B_pre`,
  `fee_bps`

### Dependencies

- **AMM.md** — defines pool state, fee mechanics, MINIMUM_LIQUIDITY,
  `T_SWAP_BATCH` co-resident opcode.
- **Variable-amount T_AXFER amendment** — defines the CXFER N=2
  bulletproof + kernel-sig construction that this amendment
  reuses verbatim, and the HMAC-keystream receipt-blinding
  convention adapted here for swap receipts.
- **NO dependency on the AMM V1 Groth16 ceremony.** `T_SWAP_VAR`
  settles against pools initialised via `POOL_INIT`, but its
  validator path uses no Groth16 proof — only Pedersen + bulletproof
  + kernel sig (all CXFER primitives, already in production).
  This is what makes `T_SWAP_VAR` shippable alongside V1 without
  waiting for the `amm_swap_batch.circom` Phase 2 setup; pools
  initialised pre-ceremony accept `T_SWAP_VAR` envelopes
  immediately. `T_SWAP_BATCH` against the same pools comes online
  once the ceremony completes.

### Merge criteria

- [x] Peer review round-1 (round-2 open questions tracked in amendment
      file, non-blocking for ship)
- [x] **Merged into SPEC.md (2026-05-16)** — appended as §5.20 with
      wire format + validator algorithm; back-pointer notes that in
      opcode order this sits between §5.18 (T_PROTOCOL_FEE_CLAIM,
      0x31) and §5.19 (T_WRAPPER_ATTEST, 0x38). Section numbering
      preserves back-reference stability rather than renumbering §5.19.
- [x] Validator integration — `validateSwapVar()` re-exported from
      `tests/amm-validator.mjs` as the single canonical entry point
      for all AMM-opcode validators (T_LP_ADD, T_LP_REMOVE,
      T_SWAP_BATCH, T_PROTOCOL_FEE_CLAIM, T_SWAP_VAR).
- [x] Spec-conformance pinning — `tests/amm-spec-conformance.test.mjs`
      pins `OPCODE_T_SWAP_VAR == 0x32`, the 5 new domain tags
      (`tacit-amm-swap-var-{v1,receipt-v1,recv-v1,change-v1,tip-v1}`),
      and the `tacit-kernel-v1` cross-surface tag the kernel msg
      reuses.
- [ ] Reference dapp implementation (swap-tile routing through
      `kind: 'amm-var'`) — dapp work, separate from this amendment
- [ ] Reference worker/indexer dispatch + intent-pool relay — worker
      work, separate from this amendment
- [ ] Signet e2e validation (16 test items in amendment file)
- [ ] Cross-impl parity tests (kernel-msg + intent-msg byte parity
      dapp ↔ worker)
- [ ] Crypto review post-merge (no new primitives but new domain
      tags need binding review)

### Tracker notes

Drafted 2026-05-15 in response to integration audit finding that
the existing AMM (`T_SWAP_BATCH` only) didn't compose with the
variable-amount opcodes shipped the same week. The two-paths
design preserves `T_SWAP_BATCH`'s unique privacy property
(amount-confidential batched clearing) while giving traders the
standard AMM UX they expect from Uniswap-style per-fill
settlement.

The fast-follow opportunity: this amendment unblocks the dapp's
AMM trader surface, which currently has zero implementation code
(`grep T_SWAP_BATCH|T_LP_ADD|T_LP_REMOVE dapp/tacit.js` returns
no matches). Once `T_SWAP_VAR` lands, the dapp can ship AMM
support in a single PR — the per-trade UX is much simpler than
the two-round-trip `T_SWAP_BATCH` flow, so it's the right
implementation order.

---

## Bulletproofs+ confidential transfer

### Summary

Adds `T_CXFER_BPP` (`0x22`) — a byte-for-byte parallel of
`T_CXFER` (`0x23`) carrying a **Bulletproofs+** aggregated
rangeproof in place of the standard Bulletproofs rangeproof.
~14% smaller witnesses across `m ∈ {1,2,4,8}` (Monero's
production-validated BP+ construction) with zero impact on
existing assets, listings, mixer pools, AMM pools, drops, slots,
or recovery flows. A universal fee cut on every confidential
transfer edge.

### Key additions

- **Opcode `0x22`** `T_CXFER_BPP` — confidential transfer
  carrying a Bulletproofs+ aggregated rangeproof. Pedersen
  commitment, kernel sig, ECDH amount recovery, aggregation
  cap `N ∈ {1,2,4,8}`, and the soft-fork unknown-opcode framing
  are all unchanged from `T_CXFER`.
- **No new domain tags** — kernel sigs reuse
  `tacit-kernel-v1`; BP+ generator vectors reuse
  `tacit-generator-H-v1` / `tacit-bp-G-v1` / `tacit-bp-H-v1` /
  `tacit-bp-Q-v1` from §3.1 verbatim. The pinned hex test
  vectors in §3.1 are the cross-impl parity check for both
  proof systems.
- **No new ceremony** — Bulletproofs+ shares Bulletproofs'
  trusted-setup-free posture (DLog hardness over the same
  secp256k1 curve).
- **Mixed-ancestry walks** — a `T_CXFER_BPP` envelope may
  consume `T_CXFER` ancestors and vice versa; the validator
  dispatches on the opcode byte to the correct rangeproof
  verifier. Both verifiers MUST be present in any conforming
  indexer.
- **Sender-side activation gate** — `bppEnabled()` defaults ON
  for signet, OFF for mainnet (mainnet flip via
  `localStorage['tacit-bpp-enable-mainnet-v1']`). Indexers
  accept the opcode on both networks unconditionally — the gate
  is producer-side only.

### Dependencies

None. Drop-in cost reduction over `T_CXFER`'s rangeproof bytes,
independent of every other amendment.

### Merge criteria

- [x] Peer review (BP+ prover/verifier construction + WIPA
  collapse equation cross-checked against Monero
  `bulletproofs_plus.cc`)
- [x] **Merged into SPEC.md** — §5.21 (wire format + kernel
  msg + rangeproof spec + validator algorithm + soundness +
  recovery + mixed-ancestry rule); §1.1 opcode table row for
  `0x22`; §5.5 validator dispatch branch
- [x] Reference implementation: `dapp/bulletproofs-plus.js`
  (907 LOC BP+ prover/verifier), `dapp/tacit.js` (encoder +
  decoder + validator dispatch + send-path `useBpp` flag),
  `worker/src/index.js` (decoder + ancestry-walk + canonical-
  order branches)
- [x] Test suite: 11 BP+ test files (roundtrip / adversarial /
  malicious-prover / monero-scenarios / pinned-fixtures /
  property-fuzz / symbolic-identity / witness-extractor /
  python-parity / bounded-exhaustive / prover-smoke) +
  `tests/cxfer-bpp-wire.test.mjs` (136 wire-format tests) +
  `tests/cxfer-bpp-integration.test.mjs` (full envelope →
  validator pipeline)
- [x] Signet on-chain harness at
  `tests/cxfer-bpp-onchain-e2e-signet.mjs` (mixed-ancestry
  CETCH → T_CXFER_BPP → T_CXFER round-trip)
- [x] Zero regression on existing test suite — pre-amendment
  CXFER UTXOs validate byte-identically under the unchanged
  §5.2 verifier
- [x] **First T_CXFER_BPP envelope confirmed on signet**
  (2026-05-18, block 304812). 3-hop mixed-ancestry round-trip
  CETCH (304810) → T_CXFER_BPP (304812) → standard T_CXFER
  (304813) validated end-to-end via
  `tests/cxfer-bpp-onchain-e2e-signet.mjs`; sender balance
  restored to 100,000 (99,000 change + 1,000 returned) and
  recipient credited 1,000 mid-chain. Both BPP↔BP dispatch
  directions exercised on real signet chain.
- [ ] **Extended signet bake in flight** (2-week soak) —
  ≥5-hop alternating mixed-ancestry chain exercise + organic
  signet usage across listings / AMM / mixer surfaces
- [ ] Mainnet activation — flip `bppEnabled()` default ON for
  mainnet after extended bake completes cleanly
- [x] Blind Python re-derivation cross-check
  (`.local/bpp-python-port/bpp.py` + `tests/bulletproofs-plus-python-parity.test.mjs`).
  Independent Python port produces byte-identical proofs to the
  JS port at all four aggregation levels (m=1/2/4/8, sizes
  591/657/723/789 B) given a shared deterministic RNG. 16/16
  passing as of 2026-05-18.

### Tracker notes

The single universal fee win on tacit's trading and transfer
surfaces. Every confidential transfer edge — direct sends, AXFER
OTC settlement, AMM swap input/change UTXOs, mixer deposits
sourced from prior transfers, batched preauth-take routes —
becomes ~14% cheaper in witness bytes when the sender opts in
via `useBpp: true`.

Because the kernel-msg construction, commitment encoding, and
amount-encryption keystream are byte-identical to §5.2, the
amount-recovery code paths in `dapp/tacit.js` and the worker
indexer require **zero** modification. Only the rangeproof
prover and verifier are swapped. Implementations that already
ship a correct `T_CXFER` rangeproof verifier already have the
right generator vectors for `T_CXFER_BPP`; a single typo in
either domain tag breaks both proof systems identically (the
existing failure mode).

Activation is gated sender-side via `bppEnabled()`. The signet
bake is in flight; mainnet activation flips the default ON
once the on-chain exercise completes cleanly. Pre-amendment
indexers see `T_CXFER_BPP` envelopes as unknown opcodes (per
the §5.5 unknown-opcode forward-compat rule) and treat them as
no-ops at the asset and pool-state level — the correct soft-
fork behavior.

---

## Protocol oracle + canonical cBTC + canonical cUSD

### Summary

Three layered protocols, in dependency order:

1. **§6.1 Protocol-level price oracle** — LP-staked threshold-Schnorr
   attesters publishing price feeds via `T_PRICE_ATTEST` (`0x39`).
   Verifiable computation, slashable. Bootstrap phase with a
   designated key, auto-graduation to threshold mode at AMM TVL
   threshold or 1-year sunset.
2. **§6.2 Canonical cBTC** — protocol-native 1:1 sat wrapper via
   user-locked DLCs with the oracle threshold as co-signer. No
   federation, no custody trust at trade time. Asset_id derived
   canonically (4th origin path).
3. **§6.3 Canonical cUSD** — MakerDAO-on-Bitcoin: users lock sats in
   DLCs, mint cUSD against oracle-priced collateral, liquidatable
   via pre-signed adaptor-sig outcomes. 150% min collateral / 115%
   liquidation threshold / 2% APR borrow rate.

### Key additions

- **10 new opcodes** (`0x39`–`0x42`): `T_PRICE_ATTEST`,
  `T_ORACLE_JOIN`, `T_ORACLE_SLASH`, `T_CDP_OPEN`, `T_CDP_CLOSE`,
  `T_CDP_LIQUIDATE`, `T_ORACLE_LEAVE`, `T_ORACLE_GRADUATE`,
  `T_ORACLE_EMERGENCY_DKG`, `T_CDP_ADAPTOR_BACKUP`
- **4th asset-id origin path** (canonical protocol assets)
- **FROST threshold Schnorr** for oracle attestation
- **DLC adaptor-sig CDPs** for cUSD price-conditional liquidation
- **Direct 2-of-2 cooperative signing** for cBTC fixed-peg redemption
- **10 new BIP-340 domain tags** (oracle + CDP message families)
- **Wrapper convention integration** populating `peg.kind =
  "oracle_priced"` and `custody.kind = "user_dlc"` placeholders

### Dependencies

- **Variable-amount T_AXFER** — implicitly used by canonical-asset
  marketplace operations
- **Tacit wrapper convention** — canonical cBTC and cUSD are
  wrapper-tagged assets; their discovery + routing UI builds on the
  wrapper registry
- **AMM ceremony complete** — oracle's price source is AMM TWAP;
  cannot operate before AMM pools have meaningful TVL

### Merge criteria

- [ ] Peer review (round 2 — major surface area, expect ≥2 rounds)
- [ ] **Independent crypto review**:
  - FROST DKG implementation
  - DLC adaptor-sig construction (band-specific nonce commitments)
  - Slashing validator algorithm
  - CSV self-rescue script semantics
- [ ] Reference indexer + dapp + worker implementation
- [ ] FROST DKG library (integrate existing or reimplement)
- [ ] DLC adaptor-sig library
- [ ] Signet bootstrap test: full cBTC + cUSD lifecycle with mock
  attester set, including liquidation + CSV rescue
- [ ] Reference oracle attester worker
- [ ] Reference keeper bot
- [ ] Public bootstrap deployment plan: bootstrap key holder,
  AMM TVL threshold measurement, graduation ceremony
- [ ] Production deployment + ≥1 epoch (1 week) of clean operation
  before merge into SPEC.md

### Tracker notes

The most ambitious amendment. ~900 lines after round-1 fixes.
Conservative timeline: 2 quarters from current state to mainnet
launch, gated on FROST DKG library maturity and AMM ceremony
completion. Bootstrap phase explicitly time-bounded to ~1 year
maximum trust window.

---

## LP-bond yield farms

### Summary

Adds MasterChef-style staked-LP rewards to the tacit AMM via **five**
new opcodes: `T_FARM_INIT` (`0x34`), `T_LP_BOND` (`0x35`),
`T_LP_UNBOND` (`0x36`), `T_LP_HARVEST` (`0x3B`), `T_FARM_REFUND`
(`0x3E`). Plus a documented convention for farm-state attestation
via the existing scope-generic `T_INTENT_ATTEST` (`0x30`), so no
separate attestation opcode is needed.

A launcher posts a `T_FARM_INIT` envelope
that consumes a tacit-asset UTXO (typically TAC) via kernel-sig
closure; the worker records a virtual `farm.treasury_remaining =
reward_total` balance in canonical farm state — **no on-chain
treasury UTXO is created.** This matches the existing tacit
virtual-pool pattern (`AMM.md`:1845: *"no UTXO holding pool funds,
so there is no key that can rug"*) used by AMM reserves, the mixer
pool, and the cBTC.tac insurance reserve.

LPs `T_LP_BOND` their `lp_asset_id` shares; the validator records a
per-outpoint bond record `{farm_id, bond_amount,
entry_acc_per_share, bonder_pubkey, bond_height}` indexed by
`vout[1].outpoint` of the bond tx, and increments `farm.total_bonded`.
Rewards crystallize lazily on every farm-mutating event using a
Q.96 fixed-point `acc_reward_per_share`, identical arithmetic shape
to the existing Uniswap-V2-style protocol-fee `mintFee`
(`AMM.md` §3352). `T_LP_UNBOND` references `bond_id` (the outpoint
of the bond's wallet-discovery dust), authenticates with a BIP-340
sig under `bonder_pubkey`, and the validator mints fresh
`lp_asset_id` + `reward_asset_id` UTXOs by decree — decrementing
`treasury_remaining` and deleting the bond record.

Bond receipts are **plain P2WPKH dust markers** at `vout[1]` of
`T_LP_BOND` — not a tacit asset class, not Pedersen-committed, not
transferable via tacit opcodes. They exist for wallet-discovery
convenience; ScanHoldings can also enumerate bonds by pubkey via
the `/farm/:farm_id/bonds?bonder=:pubkey` indexer endpoint. Bonds
are **non-transferable in v1**; reassignment requires unbond +
re-bond. A future `T_LP_BOND_ASSIGN` opcode could add explicit
transferability if secondary-market demand materialises.

Launcher is **not** a privileged operator post-init: cannot withdraw
unspent treasury (treasury is virtual — no UTXO, no key, no path
to recover), cannot modify parameters, cannot pause emissions. The
`start_height ≥ current_height + 3` gate ensures any LP can
position before the first reward block.

Pre-ceremony viable. Reuses the kernel-sig + Pedersen + bulletproof
stack from `T_SWAP_VAR` / `T_AXFER_VAR` (m=1 bulletproof on change
for `T_FARM_INIT` / `T_LP_BOND`; no bulletproof for `T_LP_UNBOND`).
No Groth16. No new ceremony.

### Key additions

- **Opcode `0x34`** `T_FARM_INIT` — launcher-funded farm creation;
  consumes reward-asset UTXO via kernel-sig closure into a virtual
  `treasury_remaining` balance (no on-chain treasury UTXO).
  ~676 bytes total wire.
- **Opcode `0x35`** `T_LP_BOND` — bond LP shares; consumes
  `lp_asset_id` UTXO via kernel-sig closure into virtual
  `farm.total_bonded`; emits per-outpoint bond record with Q.96
  `entry_acc_per_share` snapshot; emits plain P2WPKH dust at
  `vout[1]` for wallet discovery (NOT a tacit asset class).
  ~616 bytes total wire.
- **Opcode `0x36`** `T_LP_UNBOND` — references `bond_id`,
  authenticates via BIP-340 by `bonder_pubkey`; validator mints
  fresh `lp_asset_id` + `reward_asset_id` UTXOs by decree and
  decrements virtual `treasury_remaining`. No range proof, no
  kernel sigs (all openings public). ~259 bytes total wire.
- **Opcode `0x3B`** `T_LP_HARVEST` — claim accrued reward without
  unbonding. Updates `bond.entry_acc_per_share` to canonical exit
  value; does NOT touch `farm.total_bonded` or delete bond record.
  227 bytes total wire. MasterChef-equivalent of `harvest()` /
  `deposit(0)`.
- **Opcode `0x3E`** `T_FARM_REFUND` — launcher reclaims unspent
  `treasury_remaining` strictly after `end_height +
  AMM_FARM_REFUND_GRACE_BLOCKS` (~7 days). Single-shot, full-amount.
  Preserves "no privileged operator mid-stream" property: launcher
  has no spending authority during the active window. 175 bytes
  total wire.
- **Attestation reuse** of `T_INTENT_ATTEST` (`0x30`) per SPEC §5.45.
  `scope_id = farm_id`; `intent_pool_hash = buildFarmStateHash({treasury_remaining,
  total_bonded, acc_reward_per_share})` with the `tacit-farm-state-v1`
  domain tag. Equivocation detection comes free from the existing
  `T_INTENT_ATTEST` validator. Saves ~400 LOC vs. a dedicated
  attestation opcode and applies the same pattern to AMM pool /
  mixer state attestations.
- **SPEC.md §5.40–§5.44** + **§5.45** (final section numbers pinned
  at merge) — wire formats + validator algorithm + accrual math +
  conservation invariants + reorg discipline + attestation
  conventions.
- **6 new domain tags**:
  `tacit-amm-farm-init-v1` (farm_id derivation + init_msg),
  `tacit-amm-farm-bond-v1` (bond_msg),
  `tacit-amm-farm-unbond-v1` (unbond_msg),
  `tacit-amm-farm-harvest-v1` (harvest_msg),
  `tacit-amm-farm-refund-v1` (refund_msg),
  `tacit-farm-state-v1` (buildFarmStateHash → T_INTENT_ATTEST payload).
- **No new cryptographic primitives** — reuses CXFER N=1
  bulletproof + kernel sig from `T_AXFER_VAR` / `T_SWAP_VAR`
- **No new circuit / no new ceremony** — accrual is pure indexer
  arithmetic; conservation enforced by depth-3-pinned state +
  range_proof + kernel sigs
- **Bonds non-transferable in v1.** No `T_CXFER` interaction with
  bond records. Reassignment via unbond + re-bond.
- **Lock multipliers / veToken curves: NOT in this draft.** Every
  bond is 1x. Linear-bonus follow-up reserved.

### Dependencies

- **AMM.md** — defines `lp_asset_id`, pool state, depth-3
  confirmation gate, lazy `mintFee` accrual shape.
- **`SPEC.md` §5.20 `T_SWAP_VAR`** — kernel-sig + Pedersen opening
  pattern + bulletproof m=2/m=3 construction + no-change sentinel
  rule reused verbatim.
- **`SPEC-CBTC-TAC-AMENDMENT.md`** — canonical TAC asset_id and the
  cBTC.tac / TAC pool semantics referenced by the bootstrap
  section (TAC / cBTC.tac and cBTC.tac / cBTC.zk are the
  flagship farm targets).
- **NO dependency on the AMM V1 Groth16 ceremony.** All three
  opcodes ship pre-ceremony — the only AMM state they touch is
  POOL_INIT data (`pool_id`, `lp_asset_id`) which is ceremony-
  independent.

### Merge criteria

- [ ] Peer review round-1 (open questions tracked in amendment file,
      non-blocking for round-2)
- [ ] Reference implementation: `tests/amm-farm.mjs` (envelope
      build + validator + Q.96 accrual + reorg roll-forward)
- [ ] Wire-format roundtrip tests: encode → decode → re-encode
      byte-identity across `T_FARM_INIT` / `T_LP_BOND` / `T_LP_UNBOND`
- [ ] Adversarial tests: stale `entry_acc`, oversized
      `reward_amount`, under-funded treasury, replayed `bond_id`,
      cross-farm `bond_id` confusion, pubkey-rotation race on
      receipt `T_CXFER`
- [ ] Property fuzz: ≥10k random bond/unbond/transfer sequences
      against a reference oracle; conservation invariants 1–5 hold
- [ ] Signet on-chain harness: bond-emit-unbond cycle confirmed
      with mid-cycle receipt transfer
- [ ] Domain-tag collision audit (5 new tags vs SPEC.md inventory)
- [ ] SPEC.md §1.1 opcode table entries for `0x34` / `0x35` / `0x36`
- [ ] SPEC.md §5.40 / §5.41 / §5.42 (final numbers pinned at merge)
      authoritative-text merge
- [ ] AMM.md §"Pool state" baseline table update noting bonded LP
      shares stay accounted in `S` (no decrement at bond)
- [ ] Dapp integration: farm-tile UI (bond / unbond / pending
      reward display per-outpoint) — dapp work, separate from
      this amendment
- [ ] Worker integration: farm state slice + bond-record index +
      `/farm/:farm_id` and `/farm/:farm_id/bonds` endpoints

### Tracker notes

Round-1 initial draft 2026-05-18. Sanity-check pass same day
identified five corrections vs. existing tacit primitives:
treasury custody moved to virtual bookkeeping (matches AMM
reserves / mixer / cBTC.tac insurance — NUMS-spendable UTXO
pattern doesn't exist in tacit; `AMM.md`:770 NUMS_recipient is
permanently-unspendable only); bond receipts demoted from
fungible tacit asset class to plain P2WPKH dust markers (per-
outpoint `entry_acc` snapshots are inherently non-fungible);
input openings dropped to match `T_SWAP_VAR` privacy pattern;
bulletproof scope reduced (m=1 on `T_FARM_INIT` / `T_LP_BOND`,
none on `T_LP_UNBOND`); single sig on `T_LP_UNBOND` (kernel sigs
redundant when all openings public). Net wire weight: ~3.1 KB →
~1.5 KB.

Bootstrap target unchanged: TAC / cBTC.tac and cBTC.tac /
cBTC.zk pair pools — the two structurally important pairs for
the tacit ecosystem. Farm rewards stack additively on top of
AMM swap-fee compounding and (for cBTC.tac / TAC) the existing
protocol-fee insurance-pool sentinel, giving LPs three
concurrent yields. Permissionless launcher model — anyone (the
protocol team, a third-party launcher, a community treasury)
can fund a farm against any pool with a single `T_FARM_INIT`
broadcast.

---

## Cross-amendment dependencies

```
                              ┌──── variable-fill bid intents ───┐
                              │     (orderbook DEX, no new       │
                              │      opcode — composes with      │
                              │      T_AXFER_VAR for partial     │
                              │      fills on the bid side)      │
                              │                                  │
                              ├──── T_INTENT_ATTEST (0x30) ──────┤
                              │     scope-generic preconf channel│
                              │     (no Groth16 / no ceremony):  │
                              │     - orderbook scope today      │
                              │     - AMM-pool scope when AMM    │
                              │       ceremony lands             │
                              │                                  │
   variable-amount T_AXFER  ──┼──── T_SWAP_VAR (AMM per-trade ──┐│
                              │     with tick-fan coordination) ││
                              │                                 ││
                              ├──── wrapper convention ─────┐   ││
                              │                             │   ││
   AMM ceremony complete  ────┴──── protocol oracle  ───────┴───┴┴── canonical cUSD
                                          │
                                          └─────────── canonical cBTC
```

### Reading the graph

- Variable-amount T_AXFER is independent of everything else (already deployable)
- Variable-fill bid intents are an orderbook-side coordination layer
  that composes with variable-amount T_AXFER for partial-fill
  settlement; together they form a complete orderbook DEX with
  variable fills on both maker and taker sides
- T_SWAP_VAR (per-trade AMM swap) reuses variable-amount cryptography
  and requires the V1 AMM ceremony; once both land, the dapp ships
  a complete AMM swap experience alongside the orderbook DEX
- Wrapper convention benefits from variable-amount but doesn't require it
- Canonical wrappers (cBTC, cUSD) require the wrapper convention as
  the discovery + routing layer
- cUSD requires the protocol oracle for price-conditional liquidations
- Both canonical wrappers require AMM pools (for oracle TWAP source
  and for actual market liquidity)

### Recommended landing order

1. **Variable-amount T_AXFER + variable-fill bid intents +
   `T_INTENT_ATTEST` channel (orderbook scope first)** — already in
   flight; channel adds soft-confirm UX. The first two are
   deployed; `T_INTENT_ATTEST` ships next with orderbook scope
   schemas defined, giving cryptographically-accountable
   soft-confirm UX to every orderbook trader without waiting for
   the AMM ceremony. The same opcode (`0x30`) will later carry
   AMM-pool scope attestations once the AMM ceremony lands —
   sharing the dispatch path and dapp UX component.
2. **Wrapper convention** — small, metadata-only; enables federated
   wrapper marketplace immediately
3. **AMM ceremony + T_SWAP_VAR + T_SWAP_BATCH** — independent
   track; the ceremony gates the protocol oracle. `T_SWAP_VAR`
   ships as the dapp's primary AMM trader surface (simpler
   per-trade flow with tick-fan coordination eliminating most
   re-sign loops); `T_SWAP_BATCH` ships alongside as "private
   mode" (batched uniform clearing, amount-confidential). The
   AMM channel reuses `T_INTENT_ATTEST` (already shipped in step
   1) with pool_id as scope_id — no additional opcode work
   needed; just the AMM-side worker logic to populate
   pool-scoped attestations.
4. **Protocol oracle + canonical cBTC** — minimum viable for the
   canonical track
5. **Canonical cUSD** — adds full CDP machinery on top of cBTC
6. **Open the oracle role** — phase out bootstrap key, full
   LP-staked threshold

Each step adds value without requiring the next. Stopping after
step 1 yields a working orderbook DEX. Stopping after step 3 yields
that plus a working AMM + open wrapper marketplace. Stopping after
step 4 adds a trustless cBTC alternative. Step 5 adds a trustless
stablecoin.

---

## Out-of-scope work (separate amendments, future)

These are mentioned across the current amendments' "out of scope"
sections; tracked here for planning:

| Future amendment | Brief | Triggered by |
|---|---|---|
| Variable-amount preauth | Maker-offline continuous partial fills via fan-signing or adaptor sigs | Demand from order-book users wanting offline-maker liquidity |
| Multi-recipient T_AXFER batching | Single tx settling multiple variable-amount claims | Throughput pressure on T_AXFER_VAR per-fill cost |
| Concentrated-liquidity AMM (V2) | Range-LP positions per AMM.md §"Forward compatibility" | LP demand for capital efficiency |
| Cross-chain wrappers (non-bitcoin) | `underlying.chain != "bitcoin"` | Ecosystem extension to other UTXO chains |
| Multi-collateral CDPs | LP shares, runes, other tacit assets as cUSD collateral | After cUSD reaches significant TVL |
| Insurance fund | Protocol pool that backstops under-collateralised CDPs | After observing real-world liquidation gaps |
| Covenant-enforced reserve isolation | Cryptographic enforcement of wrapper reserve dedication | When BIP-119 / OP_VAULT / OP_CAT activates |
| Covenant-enforced CSV-rescue burn binding | Cryptographic enforcement of burn-on-rescue for CDPs | Same as above |
| Protocol-parameter governance | Adjust LTV, liquidation threshold, stability fee, etc. post-launch | After cUSD launch; needs TAC governance mechanics defined |
| Oracle pair extension | BTC/EUR, ASSET/USD, etc. | After BTC/USD is well-established |

---

## Workflow

### Drafting a new amendment

1. Create `SPEC-<NAME>-AMENDMENT.md` at repo root
2. Follow the style of existing amendments: motivation, normative
   sections (`§X.Y`), backwards compatibility, test plan, opcode +
   domain-tag additions, open questions, sign-off checklist
3. Add entry to this `AMENDMENTS.md` index with status 📝 Draft
4. Open peer review issue / PR

### Iterating on review

1. Reviewer publishes findings (critical / blocking / medium / minor)
2. Author applies fixes in-place (Round-N edits)
3. Author updates the sign-off checklist with round-N completion
4. Reviewer signs off or starts Round-N+1
5. Status in this index updates each round

### Crypto review

For amendments adding new cryptographic primitives (FROST, DLC,
threshold schemes, new domain tags binding novel inputs):

1. Author requests independent crypto review (separate from peer
   design review)
2. Reviewer evaluates: domain separation, adversary model, replay
   protection, soundness arguments
3. Findings published; author iterates
4. Crypto review sign-off recorded in the amendment's checklist
5. Status moves to 🛠️ Implementation

### Implementation

1. Reference implementation in dapp / worker / indexer
2. Test plan from amendment is exercised; coverage logged
3. Signet rehearsal — full lifecycle with synthetic actors
4. Status moves to 🚀 Deployed
5. Post-deployment soak period (typically 1 quarter for major
   amendments; less for small ones) before merge into SPEC.md

### Merge

1. Author opens a "merge" PR that:
   - Inlines the amendment's normative text into SPEC.md at the
     appropriate `§X.Y` location
   - Updates SPEC.md's preamble opcode list + domain-tag table
   - Marks the amendment file as "✅ Merged" in this index
   - Adds a one-line entry to SPEC.md's revision history pointing
     at the merge commit
2. The original `SPEC-*-AMENDMENT.md` file is preserved (kept in
   repo) as a historical record + traceability for future readers
3. Subsequent revisions to the merged section happen in SPEC.md;
   the amendment file is frozen

---

## Recent activity (changelog)

- **2026-05-18** — **LP-bond yield farms reference impl + worker
  integration + harvest + refund + attestation conventions
  shipped.** Adds two more opcodes on top of the round-1
  sanity-check design: `T_LP_HARVEST` (`0x3B`) for claim-without-
  unbond (MasterChef `harvest()` equivalent — bond stays alive
  with rolled-forward `entry_acc_per_share`) and `T_FARM_REFUND`
  (`0x3E`) for launcher reclaim of unspent treasury post-
  `end_height + 1008` blocks (~7 days grace). Plus farm-state
  attestation conventions reusing the existing scope-generic
  `T_INTENT_ATTEST` (`0x30`) — `scope_id = farm_id`,
  `intent_pool_hash = buildFarmStateHash(state)` with
  `tacit-farm-state-v1` domain. No dedicated attestation opcode
  saves ~400 LOC and extends the same pattern to AMM-pool / mixer
  state attestations. Full reference impl at `tests/amm-farm.mjs`
  (101 tests, 10k-trace property fuzz against an oracle, 6 cross-
  impl byte-parity tests). Worker integration at
  `worker/src/index.js` (full crypto-verifying chain-scan with
  BIP-340 + kernel-sig + bulletproof; KV state slice;
  receipt-index emit-resolver so minted UTXOs spend forward;
  `/farm/:farm_id` + `/farms?pool=` + `/farm/:farm_id/bonds`
  endpoints). Dapp wire-format at `dapp/amm-envelope.js`. Launcher
  CLI at `tests/tools/create-farm.mjs` with dry-run validator
  confirmation before deploy. Signet harness skeleton at
  `tests/amm-farm-e2e-signet.mjs` (FARM_INIT path dry-run verified
  end-to-end; broadcast paths wired via shared
  `broadcastFarmEnvelope` helper). 119/119 spec-conformance pins
  green (5 new opcodes + 6 new domain tags). Total wire across
  five opcodes: ~2.0 KB. Spec at
  `spec/amendments/SPEC-AMM-FARM-AMENDMENT.md` (~1500 lines, five
  §-numbered sections + attestation-reuse section + conservation
  proofs). Target SPEC.md §5.40–§5.45 merge.

- **2026-05-18** — **Round-1 sanity-check pass on LP-bond yield
  farms amendment.** Verified the draft against existing tacit
  primitives and corrected five issues. (1) Treasury custody moved
  from NUMS-sentinel on-chain UTXOs to virtual bookkeeping —
  NUMS-spendable-with-worker-enforcement is **not** a precedented
  tacit pattern (`AMM.md`:770 NUMS_recipient is used for
  *permanently unspendable* MINIMUM_LIQUIDITY only; `AMM.md`:1845
  is explicit that no party custodies pool funds and reserves are
  virtual indexer state). The corrected design mirrors AMM
  reserves, mixer pool, and cBTC.tac insurance custody exactly.
  (2) Dropped `lp_input_r` / `launcher_input_r` openings that
  would have leaked pre-tx wallet balance; adopted the `T_SWAP_VAR`
  pattern of closing via kernel-sig on the excess scalar.
  (3) Bond receipts demoted from a fungible tacit-asset class
  (`bond_receipt_asset_id`) with `T_CXFER` pubkey-rotation logic
  to plain P2WPKH dust markers — per-outpoint `entry_acc` snapshots
  are inherently non-fungible, so the fungibility framing was
  misleading. Bonds non-transferable in v1; reassignment by
  unbond + re-bond. Future `T_LP_BOND_ASSIGN` opcode reserved as
  follow-up. (4) Dropped both `kernel_sig_lp` and `kernel_sig_reward`
  on `T_LP_UNBOND` — with virtual treasury and all output openings
  public, only the BIP-340 envelope sig is load-bearing.
  (5) Bulletproof scope reduced: m=1 on change for `T_FARM_INIT`
  / `T_LP_BOND` (~360 B); none for `T_LP_UNBOND` (all amounts
  cleartext, openings public). Domain tags reduced from 5 to 3
  (`bond-receipt-v1` and `treasury-v1` eliminated). Total wire
  weight across the three opcodes: ~3.1 KB → ~1.5 KB. The
  bootstrap value proposition for TAC / cBTC.tac and cBTC.tac /
  cBTC.zk is unchanged.

- **2026-05-18** — **Round-1 draft of LP-bond yield farms amendment
  (`T_FARM_INIT` `0x34` / `T_LP_BOND` `0x35` / `T_LP_UNBOND` `0x36`)
  landed at `spec/amendments/SPEC-AMM-FARM-AMENDMENT.md`.**
  MasterChef-style staked-LP rewards on tacit AMM pools.
  Permissionless launcher-funded reward treasuries with NUMS-
  sentinel custody (no privileged operator post-init); Q.96 lazy
  per-Bitcoin-block accrual mirroring the protocol-fee `mintFee`
  pattern; UTXO-native bond receipts indexed by `vout[1]` outpoint
  with `{farm_id, bond_amount, entry_acc_per_share, bonder_pubkey}`
  records; receipt transferability via `T_CXFER` with worker-side
  pubkey rotation. Reuses kernel-sig + Pedersen + bulletproof from
  `T_SWAP_VAR` / `T_AXFER_VAR`; no Groth16, no new ceremony, no
  coupling to AMM Phase-2 ceremony. Bootstrap target: TAC /
  cBTC.tac and cBTC.tac / cBTC.zk pair pools, stacking additively
  on existing AMM swap-fee compounding and the cBTC.tac insurance-
  pool sentinel skim. Lock multipliers / veToken curves explicitly
  deferred to a follow-up amendment. Reference impl + signet
  harness + SPEC.md §5.40-§5.42 merge pending.

- **2026-05-18** — **First `T_CXFER_BPP` (`0x22`) envelope
  confirmed on signet.** End-to-end smoke via
  `tests/cxfer-bpp-onchain-e2e-signet.mjs` against funded
  signet wallets: CETCH `755919131ec8…` (block 304810) →
  T_CXFER_BPP `82a4356d77bd…` (block 304812, m=1, 1,000 base
  units, BP+ rangeproof) → standard T_CXFER `f463eada9185…`
  (block 304813) return. Sender balance restored to 100,000
  (99,000 change + 1,000 returned); recipient credited 1,000
  mid-chain via the mixed-ancestry walk. Validates the
  BPP↔BP dispatch in both directions on real signet chain.

- **2026-05-18** — **`T_CXFER_BPP` (`0x22`) merged into SPEC.md as
  §5.21.** Wire format + kernel msg + rangeproof spec + validator
  algorithm + soundness reduction + mixed-ancestry rule + recovery
  + activation gating now live in SPEC.md. The §1.1 opcode table
  row for `0x22` is flipped from ⬜ free to ✅ shipped (signet
  bake) and the §5.5 validator dispatch carries a dedicated
  `T_CXFER_BPP` branch. No new domain tags (kernel sig reuses
  `tacit-kernel-v1`; BP+ generators reuse `tacit-bp-{G,H,Q}-v1`
  and `tacit-generator-H-v1` from §3.1 verbatim). Reference impl
  is in production on signet: `dapp/bulletproofs-plus.js` BP+
  prover/verifier (907 LOC); `dapp/tacit.js` encoder/decoder +
  `validateOutpoint` dispatch + send-path `useBpp` flag;
  `worker/src/index.js` decoder + ancestry-walk + canonical-
  order branches; 11 BP+ test files + `cxfer-bpp-wire.test.mjs`
  + `cxfer-bpp-integration.test.mjs`. On-chain harness at
  `tests/cxfer-bpp-onchain-e2e-signet.mjs` exercises the
  mixed-ancestry CETCH → T_CXFER_BPP → T_CXFER round-trip.
  Activation gated sender-side via `bppEnabled()` (default ON
  signet, OFF mainnet); indexers accept the opcode on both
  networks. Universal ~14% witness reduction across every
  confidential-transfer edge — direct sends, AXFER OTC
  settlement, AMM swap input/change UTXOs, mixer deposits
  sourced from prior transfers, batched preauth-take routes.

- **2026-05-16** — **AMM v1 spec finalization and hardening pass.**
  Six normative additions to AMM.md / SPEC.md:
  1. **With-fee CFMM curve floor identity** added to `validateSwapBatch`.
     The prior constant-product non-decreasing check (`R_A·R_B (post)
     ≥ R_A·R_B (pre)`) enforced only the no-fee curve, admitting a
     ~`fee_bps`-wide settler/trader collusion gap (settler declares
     `|Δb|` along the 1-parameter family between with-fee and no-fee
     curves; LPs lose fee revenue). The new check is the
     public-quantities-only inequality `|Δb| · (R_A · γ_den + γ_num ·
     |Δa|) ≤ R_B · γ_num · |Δa|` (A-dom; symmetric for B-dom); per-
     trader floor dust accumulates downward, so the one-sided upper
     bound is tight. Codified in SPEC.md §5.16 step 13 + AMM.md
     §"Uniform clearing" constraint (4). The §"Uniform clearing"
     "no settler freedom in pricing" property is now operationally
     true at the indexer layer, not just a target.
  2. **`T_SWAP_VAR` (`0x32`) merged into SPEC.md as §5.20.** Wire
     format, 14-step validator algorithm, BIP-340 + HMAC domain-tag
     table. `validateSwapVar()` re-exported from
     `tests/amm-validator.mjs` as the single canonical entry point
     for all five AMM-opcode validators. Spec-conformance pins
     `OPCODE_T_SWAP_VAR == 0x32`, the 5 new domain tags
     (`tacit-amm-swap-var-{v1,receipt-v1,recv-v1,change-v1,tip-v1}`),
     and the `tacit-kernel-v1` cross-surface reuse.
  3. **`vk_cid` integrity self-check** (SPEC.md §5.16 step 8). Before
     passing vk bytes to the Groth16 verifier, the indexer MUST
     recompute the canonical CIDv1-raw-sha256 from the resolved vk
     bytes and verify it matches `pool.vk_cid` byte-for-byte. Closes
     the "misconfigured IPFS gateway returns malicious vk bytes"
     hazard. Reference impl: `deriveVkCid()` / `verifyVkCidBinding()`
     exported from `tests/amm-validator.mjs`.
  4. **Canonical Groth16 `publicSignals` serialization** exported as
     `buildPublicSignalsSwapBatch(env, pool)`. Produces the canonical
     123-element BN254-Fr-decimal-string array per AMM.md §6; pinned
     by 10 layout tests. Two independent indexers now produce byte-
     identical publicSignals arrays from the same `(env, pool)`. The
     layout matches circom 2.1.6's witness-flattening order (each
     declared `signal input` array emitted contiguously) so
     `snarkjs.groth16.verify` lines up byte-for-byte against the
     prover-emitted `public.json`. Verified empirically against
     `dapp/circuits/amm/build/amm_swap_batch.sym`.
  5. **Sigma-prover production gate.** `proveXCurve` (the platform-
     RNG randomized prover) hard-refuses under `NODE_ENV=production`
     unless an explicit `rng` argument is passed. Mirrors the
     `SKIP_GROTH16_VERIFY_UNSAFE` production-refusal pattern.
     `proveXCurveDeterministic` (the HMAC-derived nonce path) is the
     recommended production prover.
  6. **`assessMinLiqLockFraction()` UX helper** in `tests/amm-min-liq.mjs`.
     Returns `{ok, warn, high, reject}` severity + locked-bps +
     total-shares given `(Δa_init, Δb_init)`. Dapps SHOULD surface
     warnings at `POOL_INIT` for thin pools where the 1000-unit
     protocol lock is a significant fraction of the founder's stake.

  Additional clarifications:
  - AMM reorg-depth baselines table added to AMM.md §"Reorg safety"
    listing which pool-state fields are pinned at depth-3 vs
    surfaced as pending at depth < 3.
  - Disjoint-batches-same-block edge case documented in AMM.md
    §"Open caveats" (narrow race; operational mitigation only;
    V2 protocol-level fix sketched).
  - SPEC.md §3.10 sigma cross-curve binding aligned to the
    169-byte / 128-bit Fiat-Shamir form used by the impl (the
    earlier 157-byte / 80-bit draft language is superseded).
  - SPEC.md §5.14 POOL_INIT wire format aligned to the impl —
    explicit `arbiter_threshold_m`, `pool_meta_uri`, and
    `pool_capability_flags` fields documented in encoder order.
  - SPEC.md §5.16 arbiter block aligned to the impl m-of-n
    threshold quorum format (`arbiter_m + signer_indices + sigs`).
  - LP-share `share_amount == 0` rejected by validator (defense
    in depth at the wire layer).
  - Trailing-byte rejection covered for all AMM opcodes.

  All AMM tests + spec-conformance pins green.

- **2026-05-15** — **Channel-opcode consolidation: T_AMM_ATTEST
  → T_INTENT_ATTEST (scope-generic).** Renamed the preconfirmation
  attestation opcode from `T_AMM_ATTEST` to `T_INTENT_ATTEST` and
  the BIP-340 domain tag from `tacit-amm-attest-v1` to
  `tacit-intent-attest-v1`. Renamed the `pool_id` field to
  `scope_id` to reflect that it carries any 32-byte canonical
  identifier of an attested intent set — `pool_id` for AMM
  scopes, orderbook-derived hashes for orderbook scopes, anything
  else for future intent surfaces. The opcode keeps its slot
  (`0x30`) and its byte format; only naming + semantics
  generalised.

  **Why:** the crypto and wire format are byte-identical between
  AMM and orderbook use; the construction was always
  intent-pool-generic. Initially drafted as two parallel opcodes
  (`T_AMM_ATTEST` `0x30` for AMM scopes, `T_ORDERBOOK_ATTEST`
  `0x43` for orderbook scopes) — but with nothing shipped yet
  and traders' swap-tile flow already composing both surfaces
  (fill-then-bid spans orderbook + AMM in one logical trade),
  one unified opcode is cleaner: one validator dispatch path,
  one dapp UX component, one BIP-340 domain tag. Workers
  operating both surfaces (likely the common case) save chain
  bandwidth: one attestation per scope per epoch vs. two
  attestations under two opcodes for the same logical intent
  pool.

  **What ships now:** the orderbook scope schemas amendment
  (`SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md`, redrafted as a thin
  layer on top of `T_INTENT_ATTEST` rather than a parallel
  opcode). Adds the canonical orderbook-pair and
  orderbook-global scope derivations on top of the existing
  scope-generic opcode. **No new opcode, no new domain tag, no
  new crypto** — purely a usage convention. Ships independent
  of AMM ceremony (T_INTENT_ATTEST has no Groth16, no Pedersen,
  no ceremony). AMM scope attestations land later (when AMM
  ceremony lands) reusing the exact same opcode and dispatch
  path.

  Files touched: SPEC.md §5.17 (rewritten as scope-generic),
  AMM.md (all references renamed throughout, channel-framing
  section refers to scope_id), SPEC-VARIABLE-AMOUNT-AMENDMENT.md
  (opcode reference renamed), SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md
  (redrafted as thin scope-schema amendment), AMENDMENTS.md
  (index, dependency graph, landing order, this changelog
  entry).

- **2026-05-15** — `AMM.md`: **preconfirmation layer linearised to a
  "tacit channel" framing.** Replaced the sparse Merkle tree
  commitment with a single linear hash over the canonical-sorted
  intent_id list (`intent_pool_hash = SHA256(intent_id_0 || ... ||
  intent_id_{N-1})`). Same 32-byte on-chain footprint as the SMT
  root, dramatically simpler implementation — no depth-256 sparse
  storage tables, no precomputed empty-subtree hashes, no 8 KB
  Merkle inclusion proofs. Membership verification is now: trader
  fetches worker's published sorted list, rehashes locally,
  compares to the on-chain hash, binary-searches for their own
  intent_id. For tacit's expected pool sizes (hundreds of intents
  in flight) the full-list rehash is comparable to a Merkle proof
  in wire size and simpler in every other respect. Future
  amendments can swap in a vector commitment (KZG/FRI) for
  large-N regimes without changing the on-chain wire format.

  **Channel framing.** The preconf layer is reframed as a *tacit
  channel* — a multi-party off-chain commitment where the worker
  acts as channel operator, the open intent pool is the channel
  state, and each T_INTENT_ATTEST anchors the state to L1. The
  worker cannot steal (never holds funds), cannot censor
  unilaterally (traders have unilateral exit via T_SWAP_VAR
  self-broadcast), and cannot equivocate without leaving on-chain
  evidence. Compared to traditional payment channels: no funding
  tx, no commitment-tx exchange, no penalty-tx mechanism, no
  challenge protocol — just a hash commitment and a signature,
  fitting Bitcoin natively without covenants. Wire format
  `intent_pool_smt_root(32)` → `intent_pool_hash(32)`; SMT spec
  subsection removed; reference-test suite needs to swap
  Merkle-proof verification for full-list rehash verification.

- **2026-05-15** — `SPEC-SWAP-VAR-AMENDMENT.md`: **CRITICAL crypto
  fix.** A pre-V1-ceremony crypto review pass on T_SWAP_VAR's
  cross-asset adaptation surfaced an inflation attack on the asset-B
  receipt commit. The prior spec relied on the bulletproof's range
  gate + intent_sig binding to "incentive-align" the trader against
  misconstructing `C_receipt_secp` — but that argument only protects
  the trader from accidentally losing their own funds, not from
  *deliberately* creating asset-B out of thin air:

  Attack: trader constructs `C_receipt_secp = X · H_secp + r · G_secp`
  with X ≠ delta_out (X can be up to 2^64−1 and still pass the
  bulletproof's range gate). The indexer accepts the commit at face
  value, decrements pool R_B by delta_out (correct, per curve), and
  records the trader's receipt UTXO. The trader then spends C_receipt
  in a future CXFER claiming X of asset-B — and the system has no
  chain-wide Pedersen-sum invariant that would catch the inflation.
  Total asset-B in the system rises by (X − delta_out) from nothing.

  Why T_SWAP_BATCH and T_LP_REMOVE don't have this: both have
  Groth16 circuits that bind their output commits to specific
  cleartext values via in-circuit openings. T_SWAP_VAR dropped
  Groth16 for per-trade simplicity and inherited the gap.

  Why T_AXFER_VAR doesn't have this: its outputs are same-asset; the
  kernel-sig closure `C_recip + C_change − C_listed = excess · G`
  is a single-asset balance equation. T_SWAP_VAR's cross-asset
  structure puts C_receipt on asset-B with no participation in any
  closure — the unique gap from removing Groth16 in the cross-asset
  setting.

  Fix: publish `r_receipt` (32 bytes) in the on-chain envelope.
  Indexer verifies `C_receipt_secp == delta_out · H_secp +
  r_receipt · G_secp` directly. Closes the inflation. No privacy
  loss (delta_out was already cleartext; HMAC pseudo-randomness
  preserves secrecy of other r_receipt values). Compatible with the
  tick-fan coordination layer (r_receipt is tick-independent, same
  scalar across all K candidates). Off-chain intent-pool record
  format updated to carry r_receipt in shared fields.

- **2026-05-15** — `AMENDMENTS.md` + `SPEC-SWAP-VAR-AMENDMENT.md`:
  V1-completion pass folded in both deferred items.
  - **Variable-fill bid amendment registered.** Added
    `SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md` as a first-class entry
    in "Amendments at a glance" + new per-amendment summary
    section. Updated dependency graph to show variable-fill bids
    as the orderbook-DEX co-amendment with variable-amount
    T_AXFER (one provides taker-side partial fills, the other
    provides maker-side; together they form the pure-form
    Bitcoin orderbook DEX). Recommended landing order updated:
    step 1 now bundles the two as the orderbook track. Status:
    🚀 Deployed (dapp + worker shipped, signet-validated);
    SPEC.md §5.7.7 merge pending.
  - **T_SWAP_VAR tick-fan coordination layer folded into V1.**
    The "Adaptor-sig delegation for settler-chosen Δ" item
    previously deferred to v1.1 ships in V1 as a simpler
    tick-fan: trader pre-signs K ∈ {2, 4, 8, 16} candidate
    intents at deterministic log-spaced ticks across
    `[delta_in_min, delta_in_max]`. Settler picks the tick whose
    `delta_out` best matches live pool depth and broadcasts that
    single tick's data. **On-chain wire format is byte-identical
    to single-Δ broadcasts** — the K-tick fan is purely off-chain
    coordination in the worker's intent-pool relay. Tick-independent
    `r_receipt`, `r_change`, and `excess` keep wallet recovery
    + kernel-sig key-derivation unchanged; per-tick fields are
    only `delta_in_k`, `delta_out_k`, `C_change_secp_k`,
    `C_receipt_secp_k`, `bulletproof_k`, `intent_sig_k`.
    Eliminates the re-sign loop in the common pool-movement case
    without any new cryptographic primitives. Single-Δ flow
    stays available (`K = 1`) for self-broadcasts and small
    fills. Open question #1 ("re-sign frequency on volatile
    pools") resolved.

- **2026-05-15** — `SPEC-SWAP-VAR-AMENDMENT.md` + `AMM.md`:
  pre-V1-ceremony round-1 review pass landed 4 P0 fixes, 6 P1
  fixes, 6 P2 polish items.
  - **P0-1 (freshness gate):** changed T_SWAP_VAR freshness check
    from `pool state at settlement_block - 1` to `running pool
    state immediately before this tx_index` — prevents two same-
    block T_SWAP_VARs from double-dipping the same pre-block
    reserves, which would let traders bypass slippage compounding
    by splitting one large trade across multiple smaller fills.
  - **P0-2 (MINIMUM_LIQUIDITY unit mismatch):** dropped
    `R_A_post >= MINIMUM_LIQUIDITY` / `R_B_post >= MINIMUM_LIQUIDITY`
    checks from the T_SWAP_VAR validator. `MINIMUM_LIQUIDITY` is
    in LP-share base units, not asset-A/B reserve units —
    comparison was unit-mismatched. Replaced with
    `R_A_post > 0 ∧ R_B_post > 0`, which the constant-product
    curve already guarantees for finite Δ.
  - **P0-3 (identity-point sentinel encoding):** replaced the
    invalid `0x02 || 0x00…` (would parse as a non-identity SEC1
    point or be rejected as off-curve, depending on whether 7 is a
    QR mod p) with a normative 33-byte all-zero sentinel that
    conforming implementations MUST special-case BEFORE invoking
    the secp decoder. Verifier substitutes the additive identity
    (point at infinity) in the kernel-sig closure.
  - **P0-4 (relayed receipt-binding flow):** removed the
    "tentative delta_in / settler picks Δ within range" framing
    from the settlement-flow narrative. V1 locks to "trader signs
    a specific Δ" — load-bearing because `C_receipt_secp` is
    constructed against a specific `delta_out = curve(Δ)`. A
    settler-substituted Δ would cause the trader's pre-signed
    receipt commit to no longer open to the actual on-chain
    delta_out, leaving the receipt UTXO unspendable. Adaptor-sig
    delegation deferred to v1.1; open question #1 reframed
    accordingly.
  - **P1-1 (POOL_INIT same-asset check):** AMM.md §"Pool state"
    now requires strict `asset_A != asset_B` byte inequality at
    POOL_INIT validation.
  - **P1-2 (r_in transmission privacy):** T_SWAP_VAR settler-
    relay flow now states the trader transmits the `excess`
    scalar (= r_change − r_in), not `r_in` itself. r_in alone
    leaks the input UTXO blinding; excess scalar reveals nothing
    about either commit's individual blinding.
  - **P1-3, P1-4 (cross-amendment opcode framing):**
    SPEC-WRAPPER-AMENDMENT.md and SPEC-VARIABLE-AMOUNT-AMENDMENT.md
    updated to reflect that `0x32` is now V1-specified (not
    V2-reserved) per the swap-var amendment.
  - **P1-5 (stale "three opcodes" framing):** AMM.md intro, "How
    it works (architectural)" prose, "The three opcodes" → "The
    six opcodes", §"SPEC.md integration plan", §"Status" all
    updated. Added soundness-chain entries for T_SWAP_VAR,
    T_INTENT_ATTEST, T_PROTOCOL_FEE_CLAIM (previously omitted from
    the §"Soundness chain (per opcode)" enumeration).
  - **P1-6 (parity overstatement):** rewrote T_SWAP_VAR's
    "Cryptographic reuse with T_AXFER_VAR" section. The closure
    is **structurally parallel** to T_AXFER_VAR, not "exactly
    the same" — T_SWAP_VAR's kernel_msg lists one output commit
    (the change) where T_AXFER_VAR lists two (recipient + change,
    same asset); cleartext-outflow slot carries `delta_in_total`
    where T_AXFER_VAR carries `burned_amount = 0`. Crypto is
    sound either way; the prose now flags the differences
    explicitly so a reviewer doesn't miss the cross-asset
    adaptation.
  - **P2 polish:** opcode-space table split into "V1 ceremony-
    locked" (`0x2D`–`0x2F`) and "V1 non-ceremony" (`0x30`–`0x32`,
    distinguishing T_SWAP_VAR as a CXFER-N=2-reusing addition
    that doesn't go through the Groth16 ceremony); fee-accrual
    wording clarified (per-fill `k` updates, lazy mintFee
    crystallization at LP events — both opcodes feed uniformly);
    S_pre parenthetical added to T_LP_ADD soundness chain noting
    it's checked out-of-circuit; T_SWAP_VAR status moved from
    "Draft (round-1)" to "Round-1 review complete; ready for
    round-2"; AMM.md versioning table now lists all 5 T_SWAP_VAR
    domain tags (was only listing the intent_msg tag); privacy
    claim explicitly acknowledges the trader's wallet-balance
    confidentiality is inherited from the input UTXO's CXFER
    history, not added by T_SWAP_VAR itself.

- **2026-05-15** — `SPEC-VARIABLE-AMOUNT-AMENDMENT.md`: **✅ Merged
  into SPEC.md.** §5.7.6.1 (variable-amount atomic intents
  coordination layer with intent record, commit-phase timing,
  claim_msg_v3, fulfilment_msg_v2, worker state machine, bounded
  recipient amount, dual-party on-chain recovery) inserted between
  §5.7.6 and §5.7.7; §5.7.9 (T_AXFER_VAR `0x37` wire format +
  validator + soundness + comparison table) inserted after §5.7.8.
  7 new domain tags added to §3 (`tacit-axintent-publish-v1`,
  `tacit-axintent-claim-v3`, `tacit-axintent-fulfilment-v2`,
  `tacit-axintent-id-v1`, `tacit-axintent-change-v1`,
  `tacit-axintent-onchain-maker-amount-v1`,
  `tacit-axintent-onchain-maker-blinding-v1`). §5.5 dispatch
  extended with T_AXFER_VAR branch (kernel sig closure on
  `(C_recip + C_change − C_listed).x_only()` and mandatory
  `OP_RETURN(80)` recovery output at `vout[3]`). Preamble opcode
  list extended with `0x37`. Standalone amendment file preserved
  as historical record.
- **2026-05-15** — `SPEC-SWAP-VAR-AMENDMENT.md`: **new amendment
  drafted (round-1)**. Fully specifies `T_SWAP_VAR` (`0x32`),
  the per-trade variable-amount AMM swap opcode reserved in
  AMM.md's same-day P0+P1 pass. Covers wire format, kernel-msg
  + intent-msg construction, indexer validation algorithm (curve
  recompute with strict reserves-match gate), settler tip
  mechanics, receipt-blinding HMAC scheme, two settlement flows
  (relayed + self-broadcast), reorg discipline, LP fee accrual
  (per-fill, captured by Uniswap V2 lazy mintFee), and the
  privacy trade-off vs `T_SWAP_BATCH` (public per-fill amounts
  but trader pre/post wallet balances stay confidential).
  1 new BIP-340 domain tag (intent_msg) + 4 new HMAC keystream
  domains (receipt blinding, receipt-address derivation, change
  blinding, tip blinding); kernel-msg construction reuses
  CXFER's `tacit-kernel-v1` tag verbatim. No new cryptographic
  primitives (reuses CXFER N=2 from `T_AXFER_VAR` verbatim, no
  new ceremony). **Merged into SPEC.md (2026-05-16)** as §5.20
  (back-reference stable — preserves §5.19 T_WRAPPER_ATTEST
  numbering rather than renumbering). Dependency graph +
  recommended landing order updated to fold T_SWAP_VAR into AMM
  ceremony step 3 — though strictly T_SWAP_VAR ships
  independently because it carries no Groth16.

  **Round-1 self-review fix (same day):** initial draft had a
  cross-asset bug in the kernel-sig closure — wrote
  `(C_receipt + C_change − C_in).x_only` as if both sides
  balanced under one Pedersen H_secp generator. Pedersen commits
  across asset spaces share H_secp but do NOT balance via sum;
  the receipt is virtually paid by the pool (no UTXO to commit
  against). Rewrote the kernel-msg + closure to match
  `T_AXFER_VAR`'s pattern exactly: kernel sig closes only the
  trader's asset-A side with a cleartext `delta_in_total`
  outflow term (parallel to `T_AXFER_VAR`'s `burned_amount = 0`
  slot, repurposed for AMM outflow). `C_receipt_secp` is bound
  out-of-kernel by `intent_sig` + the m=2 bulletproof's range
  gate. Change UTXO uses fresh `r_change ≠ r_in` (CXFER
  rerandomisation), published explicitly in the envelope; not
  derivable by the indexer from `C_in_secp` alone. Whole-input
  case enforced by the kernel-sig closure itself (closure has a
  valid discrete log iff `amount_in == delta_in_total`).
- **2026-05-15** — `AMM.md`: P0+P1 harmonization pass.
  - **P0 #1 — broken pseudocode signature.** Removed unreachable
    `SPOT_CLEARING(0, 0, …)` branch in `SOLVE_CLEARING` (caller
    arity mismatch with the function's `(X, Y, R_A, R_B)`
    signature; degenerate-empty is rejected upstream).
  - **P0 #2 — arithmetic widths.** Made `(u128)` / `(u256)`
    pseudocode annotations normative in §"4. Deterministic
    clearing-solve algorithm" so two compliant indexers can't
    silently diverge on bigint width.
  - **P0 #3 — orderbook DEX + wrapper acknowledgement.** Added
    "Relationship to the orderbook DEX" subsection naming the
    variable-amount T_AXFER + variable-fill bid amendments as
    peer liquidity surfaces; documented dapp's fill-then-bid
    routing (`7f68faa`); noted wrapper convention's permissionless
    treatment at POOL_INIT. Intro: "three new opcodes" → "five
    normative opcodes". Opcode range `0x2D–0x30` → `0x2D–0x31`.
    Added "Last harmonized" header.
  - **P1 #4-5 — solve algorithm proof sketches.** Added monotonicity
    argument + termination bound (≤64 halvings cover 2^64 range)
    in `SOLVE_A_TO_B_DOMINANT`. Justified `best` (largest
    "too-small" mid) as the canonical fallback over `best+1`
    (conservation: settler can't claim more `Δa_net` than the
    curve produces). Added one-line underflow safety proof for
    `X - (u64)(yx/denom)`.
  - **P1 #6 — first-LP misprice.** Replaced "standard problem;
    standard fix" hand-wave with concrete mitigation cascade:
    mandatory dapp-side low-TVL warnings, orderbook arbitrage
    cross-check (V1), oracle cross-check (V2). Explicitly
    documented the rejected alternative (min-TVL gate at POOL_INIT
    breaks permissionless pool creation).
  - **P1 #7 — arbiter cleartext caveat.** Hoisted into §"Privacy
    model" as a normative MEV-vs-confidentiality trade-off
    paragraph. Dapp MUST surface at pool-creation and intent-post
    time for arbiter-pinned pools.
  - **P1 #8 — tip-output layout.** Reconciled §"How it works"
    abbreviated table (one tip output) with §"1. Envelope byte
    layouts" detailed table (zero / one / two outputs depending on
    per-asset aggregates). Both now describe the same per-asset
    aggregation model.
  - **Variable-amount integration.** Reserved `T_SWAP_VAR` (`0x32`)
    as a second AMM trader path: per-trade against-curve fills
    with `[Y, X]` range semantics, reusing the same CXFER N=2
    cryptography as `T_AXFER_VAR` (`0x37`). Lives alongside the
    existing `T_SWAP_BATCH` (`0x2F`) batched-uniform-clearing
    mode. Two paths, deliberate trade-off: `T_SWAP_BATCH` hides
    trader amounts (batch-auction privacy) but is fixed-amount;
    `T_SWAP_VAR` publishes trader amounts (per-fill, like Uniswap)
    but supports range/partial-fill semantics. Dapp UX defaults
    to `T_SWAP_VAR`, surfaces `T_SWAP_BATCH` as "private mode."
    Added `tacit-amm-swap-var-v1` BIP-340 domain tag. Wire format
    + circuit-free settlement detail lands in a follow-up
    `SPEC-SWAP-VAR-AMENDMENT.md`. Added "Dapp implementation
    status" note at the top of AMM.md flagging that no
    `T_SWAP_BATCH` has yet been broadcast by any tacit dapp.
    Opcode count in intro updated `five → six`; range V1
    `0x2D–0x31 → 0x2D–0x32`. V2 range-LP opcode reservations
    shifted (`T_LP_ADD_RANGE` etc. now `0x33+`); the speculative
    `T_SWAP_BATCH_RANGE` slot was reset to TBD since `0x37`–`0x42`
    are claimed by other amendments.
- **2026-05-15** — `SPEC-WRAPPER-AMENDMENT.md`: **✅ Merged into
  SPEC.md.** §4.2 wrapper convention (metadata field, peg/coverage
  semantics, attestation, registry, routing) inserted after §4.1
  LP-share asset_id origin path; §5.19 T_WRAPPER_ATTEST (`0x38`)
  added after §5.18 T_PROTOCOL_FEE_CLAIM; `tacit-wrapper-attest-v1`
  added to §3 BIP-340 signature-message tag list; §5.5 validator
  dispatch extended with the T_WRAPPER_ATTEST branch. The
  standalone amendment file is preserved as a historical record.
- **2026-05-15** — `SPEC-CUSD-CDP-AMENDMENT.md`: **round-4 fixes
  + AMM-CDP harmonization audit** (1 CRITICAL: DLC adaptor sig
  construction rewritten in terms of per-band adaptor points
  `S_k = s_k·G` instead of nonce points `R_k`, eliminating the
  unsafe "same-R reuse" framing from round-3; 6 BLOCKING: keeper
  bots removed from attester cost list, epoch-0 band-layout seed
  pinned as `genesis_seed_price_usd` spec constant, oracle pool
  enumeration formalised as wrapper-registry × AMM cross-join,
  attester bond restricted to canonical-pool LP shares for V1,
  new §6.4.4 disabling AMM protocol fee on canonical-asset pools
  to prevent LP double-charge, retention horizon pinned for
  indexers; 2 MEDIUM: `participating_count` 1..32 made normative
  MUST, `genesis_seed_price_usd` added to §6.7 genesis constants.
  AMM.md downstream edits noted for merge time).
- **2026-05-15** — `SPEC-CUSD-CDP-AMENDMENT.md`: round-3 fixes
  applied (3 CRITICAL: stale T_ORACLE_BOOTSTRAP_ABORT references
  cleared from §6.1.7; adaptor sig flow contradiction resolved —
  per-CDP FROST rounds at CDP open are required to produce the
  oracle-side adaptor pre-signatures, with per-epoch R_k commits
  reused; §6.2.5 CSV-rescue leaf-2 script stack bug fixed.
  7 BLOCKING: §6.1.5 slash_fraction wording reworked as fixed bps;
  T_ORACLE_SLASH `computed_price_num/den` shrunk to 8 bytes to
  match T_PRICE_ATTEST u64; T_PRICE_ATTEST envelope size math
  corrected to 161 bytes fixed; §6.3.6 band layout formalised as
  protocol-uniform absolute USD-price thresholds derived from
  prior epoch's final attestation price; bond_addr slashing
  documented as indexer-level enforcement after removing
  unenforceable on-chain leaf; keeper_hold_address scripted with
  per-(outpoint, band) uniqueness; missing `tacit-oracle-bond-v1`
  tag added to §6.5 listing.)
- **2026-05-15** — `SPEC-CUSD-CDP-AMENDMENT.md`: round-2 fixes
  applied (CDP-open per-epoch nonce-commit simplification;
  keeper enforcement via pre-signed exact-vout outcome txs with
  Bitcoin-script-enforced 5% stability fee; bootstrap key
  promoted to spec constant; FROST framing consistency; multiple
  consistency cleanups). 4 new genesis-constants subsection.
- **2026-05-15** — `SPEC-VARIABLE-AMOUNT-AMENDMENT.md`: **merging
  into SPEC.md on main**. Status → ✅ Merging. Standalone amendment
  file preserved as historical record.
- **2026-05-15** — `SPEC-CUSD-CDP-AMENDMENT.md`: round-1 fixes
  applied (DLC adaptor-sig pinning, cBTC simplification, slashing
  semantics, bootstrap accountability, borrow-rate economics
  reworked, dynamic min CDP size). 10 opcodes total.
- **2026-05-15** — `SPEC-WRAPPER-AMENDMENT.md`: round-2 fixes
  applied (coverage formula corrected, T_WRAPPER_ATTEST embedding
  clarified, attestation schedule numeric).
- **2026-05-15** — `CBTC-ISSUER-DESIGN.md`: round-1 fixes applied
  (per-fill economics, hot-wallet multisig, batching contradiction
  resolved, attestation key rotation paths).
- **2026-05-14** — `SPEC-VARIABLE-AMOUNT-AMENDMENT.md`: round-3
  fixes applied (commit-phase timing). Implementation deployed;
  signet e2e validated.

---

## Pointers

- Repo root: `/Users/z/tacit/`
- Primary spec: `SPEC.md`
- Per-amendment drafts: `SPEC-*-AMENDMENT.md`
- This index: `AMENDMENTS.md`
- Issue tracker / discussions: TODO (link to GitHub project once published)
