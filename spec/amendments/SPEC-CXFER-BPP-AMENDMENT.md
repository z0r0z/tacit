# SPEC §5.21 Amendment — T_CXFER_BPP (Bulletproofs+ Confidential Transfer)

> **STATUS: 🚀 Shipped to signet; merged into SPEC.md as §5.21.**
> Normative wire format + kernel msg + validator algorithm + soundness
> reduction now live in [`SPEC.md`](../../SPEC.md) §5.21; the §1.1 opcode
> table row for `0x22` and the §5.5 dispatch branch for `T_CXFER_BPP`
> are landed. This amendment file is preserved as the extended-narrative
> record — design rationale, test plan, sign-off checklist, future-
> evolution notes.
>
> **Reference implementation is in production on signet:**
> `dapp/bulletproofs-plus.js` (BP+ prover/verifier, 907 LOC),
> `dapp/tacit.js` (`encodeCXferBppPayload` / `decodeCXferBppPayload` /
> `validateOutpoint` dispatch / `bppEnabled` / `buildAndBroadcastCXfer*`
> `useBpp` flag), `worker/src/index.js` (T_CXFER_BPP constant + decoder
> + ancestry-walk + canonical-order branches), 11 test files under
> `tests/bulletproofs-plus-*` + `tests/cxfer-bpp-wire.test.mjs` +
> `tests/cxfer-bpp-integration.test.mjs` + on-chain harness at
> `tests/cxfer-bpp-onchain-e2e-signet.mjs`.
>
> **Activation.** `bppEnabled()` defaults ON for signet, OFF for mainnet
> (mainnet flip via `localStorage['tacit-bpp-enable-mainnet-v1']`). A
> signet bake is currently in flight; mainnet activation follows once
> the soak completes cleanly. Indexers accept `T_CXFER_BPP` envelopes
> on both networks unconditionally — the gate is sender-side only.
>
> The §5.47.* numbering below references the original draft target; the
> back-reference-stable merge slot in SPEC.md is §5.21 (next available
> after §5.20 `T_SWAP_VAR`). Where the amendment says "§5.47", the live
> SPEC.md text is at §5.21.
>
> Adds a single new envelope opcode `T_CXFER_BPP` (`0x22`) carrying a
> **Bulletproofs+** aggregated range proof in place of the standard
> Bulletproofs proof used by `T_CXFER` (§5.2). Same Pedersen commitment,
> same Mimblewimble kernel signature, same ECDH-encrypted amount, same
> aggregation cap `N ∈ {1,2,4,8}`, same forward-compat semantics. Yields
> ~14% smaller witnesses on every transfer with zero impact on existing
> assets, listings, mixer pools, AMM pools, drops, or recovery flows.
>
> **Scope of unchanged behavior.** No existing opcode, asset_id
> derivation, kernel-message format, commitment encoding, encrypted-
> amount scheme, validator rule, or transaction shape changes. This
> amendment ADDS a single opcode at code point `0x22` that mirrors
> `T_CXFER` byte-for-byte except for the rangeproof field. Pre-amendment
> indexers see the new opcode as an unknown envelope (forward-compat
> per §"Unknown-opcode forward-compatibility rule") and are unaffected
> — they simply stop crediting balances that flow through a
> `T_CXFER_BPP` edge, which is the correct soft-fork behavior.

---

## Motivation

`T_CXFER`'s witness footprint is dominated by the aggregated
Bulletproofs rangeproof: ~688 B at `m=1`, ~754 B at `m=2`,
~886 B at `m=8`. Per the README's "Known limitations / roadmap"
section, **Bulletproofs+ is already named as the follow-up cost-reduction
candidate** — a drop-in successor with ~11-14% smaller proofs and
identical security assumptions (DLog hardness over the same secp256k1
curve; no trusted setup).

The Bulletproofs+ construction (Chung, Han, Lai, Maller, Mohnblatt,
Sarkar, Sharma; 2020) preserves every property tacit relies on:

- Same Pedersen commitment scheme (`C = v·H + γ·G`)
- Same range `[0, 2⁶⁴)`
- Same aggregation property (one proof for `m` commitments)
- Same logarithmic proof size (`O(log m)`)
- Same non-interactive Fiat-Shamir transform
- No trusted setup
- Production-validated (Monero ships it as of v18 / "Fluorine Fermi")

The only meaningful difference vs standard Bulletproofs is the
inner-product argument's structure (a weighted inner-product
relation instead of the bare IPA), yielding ~13–17% smaller proofs
in practice across the `m ∈ {1,2,4,8}` aggregation range used by tacit.

**Why a new opcode rather than a CXFER revision?** SPEC §"Unknown-
opcode forward-compatibility rule" mandates: *"opcodes already
defined in this spec MUST NOT be redefined or reused with different
semantics."* The standard-Bulletproofs verifier must continue to
validate every CXFER UTXO ever broadcast — ancestry walks across
existing chain history depend on it. The cleanest path is therefore
a parallel opcode that hosts the new proof system while the original
remains canonical for prior state.

---

## §1.1 opcode table delta

Replace `0x22` ⬜ free row with:

| Opcode | Name | Status | Section | Role |
|---|---|---|---|---|
| `0x22` | `T_CXFER_BPP` | 📝 drafted | `SPEC-CXFER-BPP-AMENDMENT.md` §5.47 | Confidential transfer with Bulletproofs+ aggregated rangeproof. Identical semantics to `T_CXFER` (`0x23`) except for the proof system; ~17% smaller witness. |

---

## §5.47 T_CXFER_BPP (`0x22`) — confidential transfer (Bulletproofs+)

### 5.47.1 Wire format (envelope payload)

```
T_CXFER_BPP(1)
|| asset_id(32)
|| kernel_sig(64)            Schnorr sig over kernel_msg, see §5.2
|| N(1)                      number of outputs, ∈ {1,2,4,8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)        aggregated Bulletproofs+, m=N, n=64
```

**Byte-level delta from §5.2 (T_CXFER):** the leading opcode byte
is `0x22` instead of `0x23`, and the `rangeproof` bytes are a
Bulletproofs+ proof. **Every other field is byte-identical to
§5.2** and produced by the same encoder paths.

### 5.47.2 Kernel message

Identical to §5.2. The kernel signs:

```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || in_count(1) || (input_txid_BE(32) || input_vout_LE(4))*in_count
    || out_count(1) || output_commitment(33)*out_count
    || burned_amount_LE(8)    # 0 for T_CXFER_BPP
)
```

**Domain-tag reuse is deliberate.** `"tacit-kernel-v1"` is correct
here — the kernel signature secures the asset-side balance equation
`(Σ output_commitments) − (Σ input_commitments) = excess·G`, which
is identical between T_CXFER and T_CXFER_BPP. Reusing the tag means
existing kernel-signing helpers in `dapp/tacit.js` and worker
indexers require no signature-path code changes; only the rangeproof
prover/verifier are swapped.

### 5.47.3 Rangeproof specification

The `rangeproof` field is an aggregated Bulletproofs+ proof per
Chung et al. 2020 §3 (Weighted Inner Product Argument) + §4.4
(Aggregated Range Proof). Public parameters:

| Parameter | Value |
|---|---|
| Curve | secp256k1 (same as T_CXFER) |
| Range size `n` | `64` (commitments prove `v ∈ [0, 2⁶⁴)`) |
| Aggregation `m` | `N` (1, 2, 4, or 8 — matches output count) |
| Generator `G` | secp256k1 base point (same as T_CXFER) |
| Generator `H` | NUMS point per §3.1 (same as T_CXFER) |
| Vector generators `G_vec[i]`, `H_vec[i]`, i ∈ [0, 64·8) | **Reused unchanged from §3.1** under existing domain tags `"tacit-bp-G-v1"` / `"tacit-bp-H-v1"` |
| Aux generator `Q` | **Reused unchanged from §3.1** under existing domain tag `"tacit-bp-Q-v1"` |
| Hash | SHA-256 for Fiat-Shamir transcript (same as T_CXFER's bulletproof transcript) |

Proof size at each aggregation level (measured against the reference port
in `dapp/bulletproofs-plus.js`):

| m | T_CXFER (BP) | T_CXFER_BPP (BP+) | Saving |
|---|---|---|---|
| 1 | ~688 B | **591 B** | -14% |
| 2 | ~754 B | **657 B** | -13% |
| 4 | ~820 B | **723 B** | -12% |
| 8 | ~886 B | **789 B** | -11% |

The constant ~97-byte saving across all m comes from BP+'s reduced
baseline: 3 group elements (A, A1, B) + 3 scalars (r1, s1, d1) = 195 B,
vs standard BP's 4 group elements (A, S, T1, T2) + 5 scalars (t_hat,
tau_x, mu, a_final, b_final) = 292 B. The per-round (L_k, R_k) overhead
is identical at 66 B in both schemes.

This is smaller than the 16-19% range earlier drafts of this amendment
quoted; reality from the Monero source + working port is ~11-14%.

### 5.47.4 Generator-vector reuse

Bulletproofs+ uses **exactly the same set of public parameters as
Bulletproofs over the same curve**: a pair of group elements `(G, H)`
plus length-`n·m` vectors `G_vec`, `H_vec`, plus an auxiliary
generator `Q`. Both schemes operate over the same algebraic group
(secp256k1) with the same NUMS-binding requirements; only the
proof construction (Weighted Inner-Product Argument vs the bare
Inner-Product Argument) differs.

This amendment therefore introduces **no new generators and no new
domain tags**. T_CXFER_BPP rangeproofs MUST use:

| Generator | Source |
|---|---|
| `G` | secp256k1 base point |
| `H` | §3.1 NUMS construction under `"tacit-generator-H-v1"` |
| `G_vec[0..511]` | §3.1 try-and-increment under `"tacit-bp-G-v1"` |
| `H_vec[0..511]` | §3.1 try-and-increment under `"tacit-bp-H-v1"` |
| `Q` | §3.1 try-and-increment under `"tacit-bp-Q-v1"` |

The pinned hex-encoded reference test vectors in §3.1
(`G_vec[0..3]`, `H_vec[0..3]`, `H`, `Q`) remain the authoritative
cross-implementation parity check for both T_CXFER and T_CXFER_BPP.
A re-implementation that produces correct CXFER rangeproofs already
has the right generator vectors for CXFER_BPP — no additional
fixture work is required, and a single typo in either domain tag
breaks both proof systems identically (the existing failure mode).

This reuse matches Monero's Bulletproofs → Bulletproofs+ migration
pattern: the curve points are scheme-agnostic; only the prover and
verifier code change.

### 5.47.5 Validator algorithm

Append to §5.5 (Validator algorithm) — `validateOutpoint` recursive
function — a new branch:

```python
if envelope.opcode in {T_CXFER_BPP}:
    recursively validateOutpoint each input outpoint (tx.vin[1..])
    verify aggregated Bulletproofs+ rangeproof for outputs
    verify asset_id consistency: every input's parent envelope must declare the same asset_id
    compute E' (no burn term — T_CXFER_BPP is not a burn variant) and verify kernel_sig under E'.x_only()
    return true
```

**Mixed-ancestry rule.** A `T_CXFER_BPP` envelope MAY consume inputs
created under `T_CETCH`, `T_MINT`, `T_CXFER`, `T_AXFER`, `T_AXFER_VAR`,
`T_PMINT`, `T_WITHDRAW`, `T_DCLAIM`, `T_PROTOCOL_FEE_CLAIM`, or any
other producing opcode. The reverse also holds: a `T_CXFER` (or
`T_AXFER` / `T_BURN`) envelope MAY consume inputs created under
`T_CXFER_BPP`. The ancestry walk recurses across the producing-
opcode's verifier (Bulletproofs for CXFER ancestors, Bulletproofs+
for T_CXFER_BPP ancestors), and **both verifiers MUST be present
in the indexer**.

### 5.47.6 Soundness

Soundness rests on the same Mimblewimble + range-proof argument
as §5.2:

1. **Conservation of value.** The kernel signature verifies under
   `E'.x_only()` where `E' = (Σ output_commitments) − (Σ input_commitments)`.
   If amounts balance, `E' = excess·G` (no `H` component) and the
   signature verifies. If they don't, `E'` carries a non-zero `H`
   component and producing a valid signature requires solving the
   discrete log of `H` w.r.t. `G` — hard since `H` is NUMS.

2. **No inflation via negative amounts.** The aggregated Bulletproofs+
   proof binds each output's committed value to `[0, 2⁶⁴)`.
   Soundness reduces to the DLog assumption over secp256k1 (Chung
   et al. 2020 Theorem 4.4 — identical reduction shape to standard
   Bulletproofs).

3. **No cross-asset confusion.** The kernel msg binds `asset_id`,
   and the validator asserts asset_id consistency across every
   recursively-validated input. Identical to §5.2.

4. **No replay across outpoints.** The kernel msg binds every
   input outpoint (`txid_BE || vout_LE`). Identical to §5.2.

### 5.47.7 ECDH amount recovery

Identical to §3.5 and §5.2. The `amount_ct` field encrypts the
output amount under an HMAC-keystream derived from the ECDH shared
secret between the sender's transient pubkey (carried in the
blinding-hint structure per §6 path 2) and the recipient's
identity pubkey. **Bulletproofs+ changes only the rangeproof bytes
— amount-recovery code paths in `dapp/tacit.js` and the worker
require zero modification.**

A holder recovering on a fresh device from privkey alone walks
their ancestry across whatever mix of `T_CXFER` and `T_CXFER_BPP`
envelopes appears in chain history. The recovery branch dispatches
on the opcode byte to the correct rangeproof verifier; the rest
of the recovery flow is opcode-agnostic.

---

## Backwards-compatibility

This amendment does NOT modify any existing wire format, opcode,
domain tag, validator rule, asset_id derivation, transaction shape,
recovery path, or attestation flow. Specifically:

- **Every existing CXFER UTXO** keeps validating under the
  unchanged §5.2 verifier branch. The standard-Bulletproofs verifier
  remains permanently present in `dapp/tacit.js`, worker, and any
  re-implementation.
- **Every existing T_AXFER / T_AXFER_VAR listing** keeps settling
  unchanged. Sellers MAY pre-split via `T_CXFER_BPP` instead of
  `T_CXFER`; resulting UTXOs list and settle identically because
  AXFER's settlement layer reads the input commitment, not the
  rangeproof.
- **Every existing mixer pool** (`T_DEPOSIT` / `T_WITHDRAW`)
  accepts a `T_CXFER_BPP`-sourced UTXO as a deposit input
  unchanged: deposit validation reads the Pedersen commitment and
  the asset_id, both of which are byte-identical in scheme between
  T_CXFER and T_CXFER_BPP.
- **Every existing drop** (`T_DROP` / `T_DCLAIM`) continues to
  function. Issuers MAY route fulfillment CXFERs through
  `T_CXFER_BPP` for cost savings; recipients claim with no UI
  delta.
- **Every existing AMM pool** (`T_LP_ADD` / `T_LP_REMOVE` /
  `T_SWAP_BATCH` / `T_SWAP_VAR`) accepts `T_CXFER_BPP`-sourced
  asset UTXOs as LP-deposit or swap-intent inputs. Pool reserves,
  share commitments, and clearing-price machinery are unaffected.
- **Every existing cBTC.zk slot** (`T_SLOT_MINT` / `T_SLOT_BURN` /
  `T_SLOT_ROTATE`) and **cBTC.tac position** (`T_CBTC_TAC_DEPOSIT` /
  `T_CBTC_TAC_WITHDRAW`) continues to function. None of these
  opcodes carry a tacit-asset rangeproof of the kind T_CXFER_BPP
  replaces; the slot proofs are Groth16 and the cBTC.tac LP-shaped
  legs use the cBTC.zk + TAC primitives unchanged.
- **Pre-amendment indexers** see `T_CXFER_BPP` envelopes as
  unknown opcodes (per the "Unknown-opcode forward-compatibility
  rule") and treat them as no-ops at the asset and pool-state level.
  This is the correct soft-fork behavior: old clients see a partial
  view of the chain (missing balances that have transited through
  BPP edges) but never produce divergent verdicts on the state they
  do see.

A daily mainnet canary continues to verify no existing asset's
behavior drifts across the BPP rollout.

---

## Domain tag additions

Add to §3 *BIP-340 Schnorr signature-message tags*: **(none — kernel
signatures reuse `"tacit-kernel-v1"` unchanged)**.

Add to §3 *NUMS-derivation domain tags*: **(none — Bulletproofs+
reuses the existing `"tacit-generator-H-v1"`, `"tacit-bp-G-v1"`,
`"tacit-bp-H-v1"`, and `"tacit-bp-Q-v1"` from §3.1 unchanged. See
§5.47.4)**.

Add to §1.1 *Opcode table*:

- `0x22` `T_CXFER_BPP` — confidential transfer with Bulletproofs+ (§5.47)

---

## Test plan (informative — non-normative)

Implementation PRs landing this amendment MUST include:

### 1. Non-regression on existing protocol state (the gate that has to pass before anything else)

1.1. **Existing test-suite parity.** The full pre-amendment test
suite (every `tests/*.mjs` and `tests/*.test.mjs`) passes
byte-identically with the BPP code merged. No existing test is
modified, removed, or has its assertions relaxed.

1.2. **Mainnet canary parity.** The daily mainnet canary confirms
zero state divergence on any pre-BPP asset, listing, mixer pool,
AMM pool, drop, cBTC.zk slot, or cBTC.tac position.

1.3. **Cross-build determinism.** Two clean browser builds (the
pre-amendment IPFS-pinned CID and the post-amendment build)
replayed against mainnet head produce identical balances, ticker
metadata, and pool states for every pre-BPP envelope. The new
build sees additional state from BPP envelopes; the old build
sees those as no-ops. On the intersection (pre-BPP state), the
two builds agree byte-for-byte.

### 2. Cryptographic correctness

2.1. **BP+ prover/verifier conformance.** Generate fixtures against
published Bulletproofs+ test vectors (Monero's `bulletproofs_plus.cc`
test corpus is the recommended reference). At least 200 random
fixtures across `m ∈ {1,2,4,8}` with pinned byte-level hex.

2.2. **Generator-vector parity with §3.1.** No new fixtures
required — §3.1 already pins `G_vec[0..3]` and `H_vec[0..3]` and
those vectors are reused unchanged for T_CXFER_BPP per §5.47.4.
A separate parity test confirms the BP+ prover and verifier both
load generators that match the §3.1 hex constants byte-for-byte.

2.3. **Negative tests.** Malformed proofs reject deterministically:
truncated bytes, flipped Fiat-Shamir challenges, wrong aggregation
factor `m`, commitments off-curve, range exceeding `2⁶⁴`. Each
malformation produces a distinct rejection reason in the validator
logs.

2.4. **Mixed-ancestry chain.** Construct a 5-hop ancestry:
`CETCH → CXFER → CXFER_BPP → CXFER → CXFER_BPP → CXFER_BPP`.
Validate end-to-end on a fresh client with no cache. Verify each
layer dispatches to the correct rangeproof verifier.

### 3. Wallet recovery on mixed chains

3.1. **Fresh-device privkey-only recovery.** Recover a wallet whose
ancestry includes both CXFER and CXFER_BPP envelopes. ECDH amount
decryption succeeds across all hops. Final balance matches expected.

3.2. **Recovery across all §6 paths.** Each recovery path (paths 1–10
in §6, including the AMM-receipt and mixer-note paths) tolerates
mixed CXFER/CXFER_BPP ancestry without modification.

### 4. Cross-surface integration on signet

4.1. **T_CXFER_BPP → mixer deposit.** Wrap a UTXO created via
T_CXFER_BPP into a mixer pool; verify deposit credit and merkle
root advancement.

4.2. **T_CXFER_BPP → marketplace listing.** List a UTXO created
via T_CXFER_BPP as a T_AXFER offer; verify a buyer can settle the
listing in one Bitcoin tx with no UI delta vs a CXFER-sourced
listing.

4.3. **T_CXFER_BPP → AMM deposit.** Use a T_CXFER_BPP-sourced UTXO
as an LP_ADD input to a confidential AMM pool; verify share
issuance.

4.4. **Drop fulfillment via T_CXFER_BPP.** Run a 7-recipient
batched drop where the issuer broadcasts a single T_CXFER_BPP
(m=8) instead of T_CXFER. Verify all recipients claim successfully.

4.5. **T_CXFER_BPP spending mixer withdrawals.** Withdraw from a
mixer pool to a fresh UTXO; spend that UTXO via T_CXFER_BPP.
Verify ancestry walk crosses the mixer boundary cleanly.

### 5. End-to-end signet lifecycle

Single scripted run: etch → mint additional supply → send via
T_CXFER_BPP at m=2 → recipient receives → send batched via
T_CXFER_BPP at m=4 → range-disclose `balance ≥ K` → list on
marketplace → settle via T_AXFER → deposit residual to mixer →
withdraw to fresh pubkey → spend withdrawn UTXO via T_CXFER_BPP.
Every hop validates on a fresh client. Mirror the harness shape
of `tests/cbtc-tac-onchain-e2e-signet.mjs`.

### 6. Bake on public signet

Several weeks minimum of real signet usage before mainnet activation.
Public announcement so external implementers (worker re-hosts, IPFS
pins of the dapp, third-party indexers) can run their own builds
against the BPP flow. Monitor the cross-endpoint divergence
watchdog (`mempool.space` vs `blockstream.info`) across the bake —
any tip disagreement during BPP usage must resolve cleanly.

### 7. Operational checks

7.1. **Worker handles both opcodes** in its canonical-ordering loops
(`/assets`, `/petch-assets`, `/pools`, `/drops`, `/airdrops/*/claims`,
balance hints, trade records).

7.2. **IPFS-pinned dapp build** contains both verifiers. Older pinned
CIDs remain reachable so users mid-recovery on the old build aren't
stranded.

7.3. **Cold-load scan time** does not regress for users with
pre-BPP-only ancestry (regression test against a wallet snapshot
fixed at the amendment-shipping commit).

---

## Future evolution

Once T_CXFER_BPP is stable and broadly adopted on mainnet, follow-on
amendments naturally compose on top:

- **T_AXFER_BPP / T_AXFER_VAR_BPP** — Bulletproofs+ variants of
  the atomic OTC opcodes. Same rationale: ~17% smaller settlement
  txs for confidential atomic OTC. Parallel new opcode points,
  identical soundness argument.

- **T_BURN_BPP** — BP+ variant of the burn opcode. Lower priority
  (burns are rare); ship if there's demonstrated user demand.

- **T_CXFER_MULTI** (already noted in README) — multi-asset transfer
  envelope. Independent design space; can be specified to use BP+
  from the start without first specifying a BP variant.

- **Higher aggregation cap** (m=16, m=32). Currently pinned at
  `N ∈ {1,2,4,8}` for both CXFER and CXFER_BPP. A future amendment
  could ship `T_CXFER_BPP_M16` if drop-batch flows become a hot
  path; bulletproof size is `O(log m)` so the savings per recipient
  continue to grow logarithmically.

- **Block-batched CXFER (T_CXFER_BATCH)** — Groth16-gated
  uniform-clearing-price batch settlement, mirroring `T_SWAP_BATCH`'s
  shape from AMM.md. Potentially `<100 vB/transfer` amortized across
  hundreds of CXFERs per block. Requires a Phase 2 ceremony for the
  proving key; explicit liveness assumption on the batch coordinator
  (no custody risk).

None of these are prerequisites for T_CXFER_BPP. They are listed
here for design-context only.

---

## What this amendment does NOT specify

Out of scope, deferred:

1. **BP+ variants of AXFER / BURN.** Specified as separate amendments
   (see *Future evolution*). Holders MAY freely combine T_CXFER_BPP
   with the existing AXFER / BURN opcodes in the meantime.

2. **Higher aggregation cap.** `N ∈ {1,2,4,8}` is preserved for
   parity with T_CXFER. A future amendment adds higher caps under
   a fresh opcode.

3. **Proof-system pluggability.** Each proof system gets its own
   opcode; the validator dispatches on opcode byte. No "proof_type"
   field is introduced inside the envelope, because that would
   require versioning the §5.2 / §5.47 wire layouts — at which point
   a new opcode is the cleaner solution anyway.

4. **Aggregation across transactions.** Recursive proof composition
   (Halo2 / Nova-style) is a separate research track. T_CXFER_BPP
   is strictly a drop-in proof-size reduction within the existing
   per-tx rangeproof model.

5. **Auto-route choice in the dapp.** Whether the dapp send-path
   defaults to T_CXFER_BPP, defaults to T_CXFER, or surfaces an
   explicit toggle is a UX decision for the dapp implementation
   PR, not a protocol concern. Both opcodes are equally valid at
   the wire layer.

---

## Open questions for review

1. **Dapp default opcode for new sends.** Once T_CXFER_BPP is
   shipped and battle-tested on signet, should the dapp auto-route
   all new sends through it (saving ~17% silently), or keep CXFER
   as the default with BPP as an explicit toggle until adoption
   crosses a threshold? Recommendation: auto-route after a
   user-visible mainnet announcement + a one-time toast on first
   send post-activation explaining the change.

2. **Worker convenience-cache opcode tagging.** Worker-cached
   balance hints currently carry no opcode info. Should
   T_CXFER_BPP-sourced hints be tagged distinctly so the dapp can
   surface "this transfer used BPP" UI for power users, or kept
   opcode-agnostic to match the existing hint schema? Recommendation:
   opcode-agnostic — the dapp re-verifies locally anyway and the
   distinction is irrelevant to balance correctness.

3. **Mainnet activation gating.** Should activation be:
   (a) hard code-path switch (the new dapp build ships with BPP
   enabled by default), or
   (b) feature-flag gated by a height threshold (BPP envelopes
   before height H are indexer-rejected; after H, accepted)?
   Recommendation: (a) — soft-fork semantics mean no height gate
   is required for safety, and adding one creates an unnecessary
   coordination surface. Users who upgrade earlier see BPP earlier;
   users on older pinned CIDs continue to function with no degraded
   view of CXFER state.

---

## Sign-off checklist for landing

- [x] Initial author draft (this file)
- [x] Opcode `0x22` confirmed collision-free against the live
  opcode list at §1.1
- [x] Confirmed no new domain tags introduced (§5.47.4 reuses
  the existing §3.1 generator vectors verbatim — parity-tested:
  `bulletproofs-plus-prover-smoke.test.mjs` pins Gvec[0], Hvec[0],
  and H byte-for-byte against SPEC §3.1)
- [x] BP+ prover + verifier landed at `dapp/bulletproofs-plus.js`
  (hand-port of Monero `bulletproofs_plus.cc` with curve secp256k1
  substitution and SHA-256 transcript; gated to signet by default
  via `bppEnabled()` until on-chain bake completes)
- [x] Round-trip self-consistency tests: 20/20 passing
  (`tests/bulletproofs-plus-roundtrip.test.mjs`)
- [x] Adversarial test battery: 39/39 passing
  (`tests/bulletproofs-plus-adversarial.test.mjs` — bit-flip survey
  across every structural field, commitment-swap rejection,
  cross-proof substitution rejection, aggregation-factor mismatch
  rejection, length tamper rejection)
- [x] Wire-format integration: 136/136 passing
  (`tests/cxfer-bpp-wire.test.mjs`)
- [x] End-to-end real-proof integration: full envelope wrap →
  decode → bppRangeVerify pipeline + kernel-sig parity under
  `tacit-kernel-v1` (`tests/cxfer-bpp-integration.test.mjs`)
- [x] Zero regression on existing test suite (392 existing tests
  re-run, all still passing)
- [x] Peer-agent review — NUMS generator-vector construction
  (byte-identity with §3.1 confirmed: `_hashToCurveSecp` mirrors
  `_bpHashToCurve` line-for-line; smoke test KAT asserts both
  paths produce the same pinned Gvec[0]/Hvec[0]/H hex)
- [x] Peer-agent review — WIPA collapse equation, d-windowed
  vector, challenges_cache reverse-index, MSM check shape
  (vs `.local/monero-bpp-ref/bulletproofs_plus.cc`: no soundness
  bugs found; every scalar formula in the verifier MSM maps 1:1
  to Monero's batched verifier with weight=1, cofactor=1
  simplification applied consistently in every place Monero uses
  `INV_EIGHT` / `scalarmult8`)
- [x] Peer-agent review — mixed-ancestry validator correctness
  (validator branch confirmed correct; review surfaced 7 missing
  BPP branches in adjacent code paths — `worker/commitmentForUtxo`,
  worker cron transfer/holder counters, `/hint` transfer counter,
  backfill-holders, worker exports, dapp `importShareLink`,
  dapp drop cross-check — all fixed)
- [x] Peer-agent review — wallet recovery on mixed chains
  (covered by the validator review: holdings scan, amount-recovery
  scan, `getParentEnvelopeData`, and BFS ancestry walker all
  dispatch on T_CXFER_BPP; share-link import path patched)
- [x] bppRangeProve / bppRangeVerify wired into the validator
  branch at `dapp/tacit.js` validateOutpoint; gated by
  `bppEnabled()` (default ON on signet, OFF on mainnet via
  `localStorage['tacit-bpp-enable-mainnet-v1']`)
- [x] BPP tests wired into `tests/package.json` test script
  (smoke, roundtrip, adversarial, monero-scenarios, wire,
  integration)
- [x] Monero-scenario test parity — adversarial corpus mirroring
  Monero's BP+ unit-test classes (boundary values, identity /
  off-curve commitments, transcript replay, out-of-order
  commitments, repeated verification, cross-m wire substitution):
  22/22 passing in `bulletproofs-plus-monero-scenarios.test.mjs`.
- [x] Malicious-prover attack suite — 11 shaped attacks (bit
  forgery, out-of-range smuggling, aggregation cross-contamination,
  blinding substitution, transcript bind via V order, r1↔s1 swap,
  G/H swap, duplicate commitment slots, L/R round permutation,
  A/B substitution, m=2 → m=4 replay): 22/22 rejected in
  `bulletproofs-plus-malicious-prover.test.mjs`. The actual attack
  surface, made concrete.
- [x] Pinned deterministic proof fixtures — `bppRangeProve`
  exercised with a seeded RNG; proof hex pinned at every m ∈
  {1,2,4,8}; generator KAT extended to Gvec[0..3] / Hvec[0..3].
  Any future change that drifts a single byte trips
  `bulletproofs-plus-pinned-fixtures.test.mjs`.
- [x] Property-based fuzz — 50 honest proofs per m verify
  (completeness); 50 random byte-flip tampers per m reject
  (soundness sanity); 50 commitment-order swap attempts reject
  (binding). `bulletproofs-plus-property-fuzz.test.mjs`.
- [x] Blind Python re-derivation cross-check — independent
  Python port of BP+ on secp256k1 hand-written from the Monero
  C++ reference + SPEC amendment without seeing the JS port at
  `.local/bpp-python-port/bpp.py` (~600 LOC, complete BP+ prover
  on secp256k1 with SHA-256 transcript + cofactor=1 simplification).
  Byte-compared via `tests/bulletproofs-plus-python-parity.test.mjs`
  (16/16 passing as of 2026-05-18): JS and Python produce
  bit-identical 591/657/723/789-byte proofs at m=1/2/4/8 given a
  shared deterministic RNG (`sha256("bpp-test-rng-v1" || counter_BE_u16)`).
  Two independent implementations converging on the same proof
  bytes — strongest static-analysis evidence of soundness available.
- [x] Worker hot-path BPP branches landed — `commitmentForUtxo`,
  cron transfer+holder counters, `/hint` transfer counter,
  backfill-holders, test exports
- [x] Dapp send-path: `buildAndBroadcastCXfer` + `…Multi` accept
  `useBpp: true` to produce T_CXFER_BPP envelopes; receive path
  is opcode-agnostic (decoder dispatch wired everywhere
  `T_CXFER` appears in the scan loops)
- [x] Signet smoke harness landed
  (`tests/cxfer-bpp-onchain-e2e-signet.mjs`): CETCH → T_CXFER_BPP
  send → recipient credit check → standard T_CXFER return →
  mixed-ancestry final balance check. Resumable; wallet generator
  at `tests/gen-cxfer-bpp-signet-wallets.mjs`.
- [x] First T_CXFER_BPP envelope broadcast on signet
  (2026-05-18, block 304812: commit `c6f2af0f4997…`, reveal
  `82a4356d77bd…`; sender `tb1qkkg6pevxykxutq85p3ja53xlrxwfhga8xj8ecu`
  → recipient `tb1qwp2ds83m3uj04c99zpvn7rtjs3tuc6u42vmghq`,
  m=1, 1,000 base units, BP+ rangeproof).
- [x] First mixed-ancestry chain exercised end-to-end on signet
  via `tests/cxfer-bpp-onchain-e2e-signet.mjs` (2026-05-18):
  block 304810 CETCH `755919131ec8…` → block 304812 T_CXFER_BPP
  `82a4356d77bd…` → block 304813 standard T_CXFER `f463eada9185…`
  return; sender balance restored to 100,000 (99,000 change +
  1,000 returned) and recipient credited 1,000 mid-chain — both
  directions of the BPP↔BP validator dispatch validated on real
  signet chain. **Note:** the harness exercises 3 hops; extending
  to ≥5 hops alternating CXFER ↔ T_CXFER_BPP is a follow-up bake
  task tracked under the 2-week soak.
- [ ] ≥5-hop alternating mixed-ancestry chain on signet
  (extended-soak deliverable)
- [ ] First mainnet T_CXFER_BPP envelope after signet exercise

---

*End of amendment draft.*
