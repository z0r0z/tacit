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

| Amendment | Status | Opcodes / features added | Implementation | File |
|---|---|---|---|---|
| Variable-amount T_AXFER | ✅ Merging to main | `T_AXFER_VAR` (`0x37`); §5.7.6.1 coordination layer; OP_RETURN(80) dual-party recovery | dapp + worker shipped; signet-validated; SPEC.md merge in progress | [`SPEC-VARIABLE-AMOUNT-AMENDMENT.md`](./SPEC-VARIABLE-AMOUNT-AMENDMENT.md) |
| Tacit wrapper convention | ✅ Merged | CETCH metadata `tacit_wrapper` field; `T_WRAPPER_ATTEST` (`0x38`); coverage check + open-issuer marketplace | SPEC.md §4.2 + §5.19 ✅; indexer + dapp work pending | [`SPEC-WRAPPER-AMENDMENT.md`](./SPEC-WRAPPER-AMENDMENT.md) |
| Protocol oracle + canonical cBTC + canonical cUSD | 📝 Draft (round-4 fixes + AMM harmonization landed) | 10 new opcodes (`0x39`–`0x42`); FROST threshold oracle; per-user DLC CDPs; MakerDAO-on-Bitcoin | Not started | [`SPEC-CUSD-CDP-AMENDMENT.md`](./SPEC-CUSD-CDP-AMENDMENT.md) |

### Supporting docs (not amendments, informative only)

| Document | Status | Purpose | File |
|---|---|---|---|
| cBTC reference issuer operational design | 📝 Round-1 fixes landed | One concrete application of the wrapper convention — TAC-operated federated 3-of-5 multisig cBTC variant | [`CBTC-ISSUER-DESIGN.md`](./CBTC-ISSUER-DESIGN.md) |

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
- [x] **Merging into SPEC.md (in progress on main)**
- [ ] Crypto review of m=2 BP / kernel-sig reuse + dual-OP_RETURN(80) encoding (post-merge)
- [ ] Backwards-compat replay test (50 historical T_AXFER txs)
- [ ] tacitscan parity confirmation

### Tracker notes

The most-mature amendment. End-to-end validated on signet (commit
`bcad53f6`, signet block 304223). On-chain recovery confirmed
working: scanner finds OP_RETURN(40), decrypts via ECDH, opens
Pedersen commitment from chain + privkey alone.

**As of 2026-05-15 the variable-amount amendment is merging into
`SPEC.md` on main.** Once the merge PR lands, this entry transitions
to ✅ Merged and the standalone amendment file is preserved as a
historical record.

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
- **§5.20** `T_WRAPPER_ATTEST` (`0x38`) — optional on-chain
  attestation envelope
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

## Cross-amendment dependencies

```
   variable-amount T_AXFER  ──┐
                              ├──── wrapper convention ──┐
                              │                          │
   AMM ceremony complete  ────┴──── protocol oracle  ────┴──── canonical cUSD
                                          │
                                          └─────────── canonical cBTC
```

### Reading the graph

- Variable-amount T_AXFER is independent of everything else (already deployable)
- Wrapper convention benefits from variable-amount but doesn't require it
- Canonical wrappers (cBTC, cUSD) require the wrapper convention as
  the discovery + routing layer
- cUSD requires the protocol oracle for price-conditional liquidations
- Both canonical wrappers require AMM pools (for oracle TWAP source
  and for actual market liquidity)

### Recommended landing order

1. **Variable-amount T_AXFER** (already in flight) — independent,
   most mature, lowest risk
2. **Wrapper convention** — small, metadata-only; enables federated
   wrapper marketplace immediately
3. **AMM ceremony** — independent track; gates the protocol oracle
4. **Protocol oracle + canonical cBTC** — minimum viable for the
   canonical track
5. **Canonical cUSD** — adds full CDP machinery on top of cBTC
6. **Open the oracle role** — phase out bootstrap key, full
   LP-staked threshold

Each step adds value without requiring the next. Stopping after
step 3 yields a working AMM + open wrapper marketplace. Stopping
after step 4 adds a trustless cBTC alternative. Step 5 adds a
trustless stablecoin.

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
