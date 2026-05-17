# SPEC Amendment — T_AXFER_BPP + T_AXFER_VAR_BPP (Bulletproofs+ atomic OTC settlement)

> **Status: 📝 DRAFT (round-1).** Extends the Bulletproofs+ proof system
> already shipped for `T_CXFER_BPP` (`0x22`, SPEC.md §5.21) to the atomic
> OTC settlement opcodes:
>
> - `T_AXFER_BPP` (`0x3C`) — BP+ variant of `T_AXFER` (SPEC §5.7).
>   Byte-for-byte parallel; only the leading opcode byte and the
>   rangeproof bytes differ.
> - `T_AXFER_VAR_BPP` (`0x3D`) — BP+ variant of `T_AXFER_VAR`
>   (SPEC §5.7.9). Same N=2 + `asset_input_count = 1` tightenings,
>   same interleaved-vout layout, same mandatory OP_RETURN(80)
>   dual-recovery payload. Only the rangeproof bytes change.
>
> No new domain tags. No new cryptographic primitives. No new ceremony.
> Same Pedersen commitments, same `tacit-kernel-v1` kernel-msg construction,
> same ECDH amount-recovery code paths. Reuses the existing
> `dapp/bulletproofs-plus.js` BP+ prover/verifier and the existing §3.1
> generator vectors verbatim.

> **Why now.** `T_CXFER_BPP` shaves ~14% wire bytes off every confidential
> transfer edge, but the OTC + AMM-swap settlement surface (`T_AXFER`,
> `T_AXFER_VAR`, `T_SWAP_VAR`) still carries standard Bulletproofs.
> Extending BP+ to those opcodes lifts the universal fee cut across the
> trading surface — listings, fills, swap settlements, batched preauth-take
> routes. The required infrastructure (BP+ prover/verifier + Pippenger
> MSM verifier optimization) is already in production on signet under
> `T_CXFER_BPP`.

---

## Motivation

`T_AXFER` and `T_AXFER_VAR` are the on-chain settlement opcodes for
tacit's OTC marketplace and variable-amount partial fills. Every
listing-take and every variable-fill carries an aggregated Bulletproofs
rangeproof in the envelope's `rangeproof` field — ~688 B at m=1
(whole-UTXO take) and ~754 B at m=2 (variable-amount split).

The `T_CXFER_BPP` amendment (SPEC.md §5.21) demonstrated that swapping
the rangeproof from Bulletproofs to Bulletproofs+ yields a ~14% witness
reduction across `m ∈ {1, 2, 4, 8}` with:

- **Zero impact on Pedersen-commitment semantics** — same `C = v·H + γ·G`.
- **Zero impact on kernel-sig semantics** — same `tacit-kernel-v1` domain,
  same Mimblewimble balance equation.
- **Zero impact on ECDH amount recovery** — same domain tags, same
  keystream derivation.
- **Zero impact on indexer verifier cost** — after the Pippenger MSM
  port (see `dapp/bulletproofs-plus.js` `bppRangeVerify`), BP+ verify
  lands in the same wall-time class as standard BP verify at every m
  (bench: `tests/bulletproofs-plus.bench.mjs`).

This amendment lifts the same swap to the atomic-OTC settlement surface
under two new opcodes. The wire formats are bit-identical to the
existing T_AXFER / T_AXFER_VAR layouts except for the opcode byte and
the rangeproof bytes. The off-chain coordination layers (§5.7.6 atomic
intents, §5.7.6.1 variable-amount coordination, §5.7.7 bid intents,
§5.7.8 preauth sales, §5.7.8.1 batched preauth-take) are entirely
unchanged — they reference only the kernel-msg and commitment fields,
both byte-identical between BP and BP+ variants.

---

## §1.1 opcode table delta

Replace the `0x3C` / `0x3D` rows (currently part of the free range
`0x3B – 0x42`) with:

| Opcode | Name | Status | Section | Role |
|---|---|---|---|---|
| `0x3C` | `T_AXFER_BPP` | 📝 drafted | `SPEC-AXFER-BPP-AMENDMENT.md` | BP+ variant of `T_AXFER` (`0x26`); byte-identical wire shape modulo opcode + rangeproof bytes. ~14% smaller witness. |
| `0x3D` | `T_AXFER_VAR_BPP` | 📝 drafted | `SPEC-AXFER-BPP-AMENDMENT.md` | BP+ variant of `T_AXFER_VAR` (`0x37`); byte-identical wire shape (incl. N=2 + asset_input_count=1 tightenings + interleaved vout layout + mandatory OP_RETURN(80)) modulo opcode + rangeproof bytes. |

Both slots are in the explicitly-free range `0x3B–0x42` released by the
retired cUSD-CDP / FROST-oracle amendments (per `SPEC-CUSD-TAC-AMENDMENT.md`).

---

## T_AXFER_BPP (`0x3C`) — atomic OTC settlement with Bulletproofs+

### Wire format

```
T_AXFER_BPP(1)              = 0x3C
|| asset_id(32)
|| asset_input_count(1)     u8, 1..255 — vin[1..1+asset_input_count] are tacit asset inputs
|| kernel_sig(64)           Schnorr sig over kernel_msg, see SPEC §5.7
|| N(1)                     number of tacit outputs, ∈ {1, 2, 4, 8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)       aggregated Bulletproofs+, m=N, n=64
```

**Byte-level delta from §5.7 (T_AXFER):** the leading opcode byte is
`0x3C` instead of `0x26`, and the `rangeproof` bytes carry a
Bulletproofs+ proof rather than a Bulletproofs proof. **Every other
field is byte-identical** to §5.7 and produced by the same encoder
paths.

### Kernel message

Identical to §5.7. The kernel signs:

```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || asset_input_count(1) || (input_txid_BE(32) || input_vout_LE(4))*asset_input_count
    || N(1) || output_commitment(33)*N
    || burned_amount_LE(8)    # 0 for T_AXFER_BPP
)
```

Same `tacit-kernel-v1` domain as `T_AXFER` (`0x26`) and `T_CXFER` (`0x23`).
A kernel signature produced for one of those opcodes verifies the same
balance equation under `T_AXFER_BPP` (and vice versa) — this is harmless
because the asset inputs and output commitments are themselves part of
the msg, and the prover cannot synthesize a valid sig over a different
tx's asset side. The opcode byte is a presentation choice, not a
cryptographic invariant.

### Validator algorithm

The §5.5 dispatch branches on `T_AXFER_BPP` identically to `T_AXFER`,
swapping only the rangeproof verifier:

```
if envelope.opcode in {T_AXFER, T_AXFER_BPP}:
    decode asset_input_count, kernel_sig, outputs[0..N], rangeproof from payload
    require asset_input_count >= 1 and asset_input_count + 1 <= len(tx.vin)
    require N in {1, 2, 4, 8}
    asset_inputs = tx.vin[1 .. 1+asset_input_count]
    recursively validateOutpoint each input outpoint in asset_inputs
    if envelope.opcode == T_AXFER_BPP:
        verify aggregated Bulletproofs+ rangeproof for outputs (m=N) via bppRangeVerify
    else:
        verify aggregated Bulletproofs rangeproof for outputs (m=N) via bpRangeAggVerify
    verify asset_id consistency: every parent envelope of asset_inputs declares the same asset_id
    compute E' from asset_inputs + outputs and verify kernel_sig under E'.x_only()
    return true
```

**Mixed-ancestry rule.** A `T_AXFER_BPP` envelope MAY consume inputs
produced by any of `T_CETCH`, `T_MINT`, `T_CXFER`, `T_CXFER_BPP`,
`T_AXFER`, `T_AXFER_VAR`, `T_AXFER_VAR_BPP`, `T_PMINT`, `T_WITHDRAW`,
`T_DCLAIM`, `T_PROTOCOL_FEE_CLAIM`, or any other producing opcode.
The reverse also holds. The ancestry walk recurses across the
producing-opcode's verifier (Bulletproofs for non-BPP ancestors,
Bulletproofs+ for BPP ancestors); both verifiers MUST be present in
any conforming indexer.

### Soundness

Identical reduction shape to §5.7 (Mimblewimble + range-proof argument):

1. **No inflation downstream.** `E' = Σ_out_tacit C − Σ_asset_in C`.
   Balanced tx: `E' = excess·G` (no H component), kernel sig verifies.
   Unbalanced: `E'` carries a non-zero H component, sig requires
   breaking DLP for H w.r.t. G — hard since H is NUMS.
2. **No negative-amount smuggling.** Aggregated BP+ rangeproof on
   `outputs[0..N]` bounds each amount to `[0, 2⁶⁴)`. Soundness reduces
   to the DLog assumption over secp256k1 (Chung et al. 2020 Theorem 4.4).
3. **No cross-asset confusion.** `asset_id` is committed in the kernel
   msg; asset_id consistency asserted across every input.
4. **No replay across outpoints.** Every input outpoint is committed in
   the kernel msg.
5. **Aux BTC tampering.** Aux inputs at `vin[1+asset_input_count..]`
   don't enter the kernel msg or the rangeproof; SPEC §5.7's
   SIGHASH discipline governs them unchanged.

### Off-chain coordination — unchanged

The §5.7.3 PSBT-style flow, §5.7.6 atomic intents, §5.7.6.1
variable-amount intents (when settling via `T_AXFER_BPP` for whole-UTXO
fills), §5.7.7 bid intents, §5.7.8 preauth sales, and §5.7.8.1 batched
preauth-take all work unchanged with `T_AXFER_BPP` as the on-chain
settlement opcode. The intent records reference the
`opcode` field generically; clients dispatch the rangeproof prover
(`bpRangeAggProve` vs `bppRangeProve`) on the seller's choice at
fulfillment time.

---

## T_AXFER_VAR_BPP (`0x3D`) — variable-amount atomic OTC with Bulletproofs+

### Wire format

```
T_AXFER_VAR_BPP(1)          = 0x3D
|| asset_id(32)
|| asset_input_count(1)     = 0x01 EXACTLY (tightened from T_AXFER, same as T_AXFER_VAR)
|| kernel_sig(64)
|| N(1)                     = 0x02 (recipient_commit, maker_change_commit)
|| (commitment(33) || amount_ct(8)) × 2
|| rp_len(2)
|| rangeproof(rp_len)       aggregated Bulletproofs+, m=2, n=64
```

**Byte-level delta from §5.7.9 (T_AXFER_VAR):** the leading opcode byte
is `0x3D` instead of `0x37`, and the `rangeproof` bytes carry a BP+
proof rather than a BP proof. Every other field is byte-identical.

### Bitcoin transaction layout (normative — unchanged from §5.7.9)

```
vin[0]              = commit P2TR (envelope-bearing taproot script-path spend)
vin[1]              = maker's single tacit asset input (signed SIGHASH_SINGLE_ACP)
vin[2..]            = taker's BTC funding inputs (signed SIGHASH_ALL)

vout[0]             = recipient tacit       (DUST P2WPKH(taker_pubkey))
vout[1]             = maker BTC payment     (bound by vin[1] SIGHASH_SINGLE)
vout[2]             = maker change tacit    (DUST P2WPKH(maker_pubkey))
vout[3]             = OP_RETURN(80) dual-recovery payload (MANDATORY)
vout[4..]           = taker BTC change
```

Indexers MUST reject any `T_AXFER_VAR_BPP` whose tx layout deviates from
the above — same posture as `T_AXFER_VAR`. The OP_RETURN(80)
dual-recovery payload at `vout[3]` is mandatory and uses the same
domain tags + HMAC-keystream construction defined in SPEC §5.7.6.1
(`tacit-axintent-onchain-amount-v1`, etc.). Recovery from chain + privkey
alone is unaffected — the rangeproof swap doesn't touch any recovery
path.

### Kernel message — identical to §5.7.9

Same `tacit-kernel-v1` domain, same shape:

```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || asset_input_count_LE(1)              # = 0x01
    || asset_input_outpoint                 # txid_BE(32) || vout_LE(4) of vin[1]
    || output_commitments_concat(2 × 33B)   # C_recip || C_change
    || burned_amount_LE(8) = 0
)
```

Kernel sig verifies under `(C_recip + C_change − C_listed).x_only()`
with `excess = r_recip + r_change − r_listed` (mod n).

### Validator algorithm

```
if envelope.opcode in {T_AXFER_VAR, T_AXFER_VAR_BPP}:
    require envelope.asset_id is well-formed (32 bytes)
    require N == 2
    require asset_input_count == 1
    require tx.vin.length >= 2
    let asset_input = tx.vin[1]
    require asset_input is a validateOutpoint() ⇒ true asset UTXO of envelope.asset_id

    require vout[3] is the mandatory OP_RETURN(80) dual-recovery payload
        (see SPEC §5.7.9 *On-chain recovery* — accept both single-OP_RETURN(80)
         and split OP_RETURN(40)+OP_RETURN(40) forms).

    if envelope.opcode == T_AXFER_VAR_BPP:
        verify aggregated Bulletproofs+ rangeproof over N=2 commitments via bppRangeVerify
    else:
        verify aggregated Bulletproofs rangeproof over N=2 commitments via bpRangeAggVerify

    verify kernel_sig under (C_recip + C_change − C_listed).x_only()
```

### Recovery — unchanged

§5.7.9's dual-party OP_RETURN(80) recovery scheme is unchanged. Both
recipient and maker decrypt their respective 40-byte halves from chain
+ privkey alone, using the same `tacit-axintent-onchain-{amount,
blinding}-v1` and `tacit-axintent-onchain-maker-{amount, blinding}-v1`
HMAC keystreams defined in SPEC §5.7.6.1. The rangeproof verifier swap
doesn't affect the recovery code paths in any wallet implementation.

---

## Domain-tag additions

**None.**

- Kernel signatures reuse `tacit-kernel-v1` (same as CXFER / T_AXFER /
  T_AXFER_VAR).
- BP+ generator vectors reuse `tacit-bp-G-v1` / `tacit-bp-H-v1` /
  `tacit-bp-Q-v1` and `tacit-generator-H-v1` from SPEC §3.1.
- ECDH amount-recovery keystreams reuse the existing `tacit-blind-v1`,
  `tacit-amount-v1`, `tacit-change-v1`, `tacit-amount-self-v1` tags
  per §3.5.
- T_AXFER_VAR_BPP OP_RETURN(80) keystreams reuse the
  `tacit-axintent-onchain-{amount, blinding}-v1` +
  `tacit-axintent-onchain-maker-{amount, blinding}-v1` tags per §5.7.6.1.

---

## Backwards-compatibility

This amendment does NOT modify any existing wire format, opcode,
domain tag, validator rule, asset_id derivation, transaction shape,
recovery path, or coordination layer. Specifically:

- **Every existing T_AXFER / T_AXFER_VAR listing** keeps settling
  unchanged under the pre-amendment validator branches.
- **Pre-amendment indexers** see `T_AXFER_BPP` / `T_AXFER_VAR_BPP`
  envelopes as unknown opcodes and treat them as no-ops at the
  asset and pool-state level (per the §5.5 unknown-opcode forward-
  compat rule). They simply stop crediting balances that flow through
  a BPP edge — the correct soft-fork behavior.
- **The §5.7.6 / §5.7.6.1 / §5.7.7 / §5.7.8 / §5.7.8.1 off-chain
  coordination layers** function identically — they reference
  `opcode` generically and dispatch the rangeproof prover on the
  seller's choice at fulfillment time.
- **The §5.7.9 OP_RETURN(80) dual-recovery** mechanism is unchanged
  byte-for-byte for T_AXFER_VAR_BPP.

A daily mainnet canary continues to verify no existing asset's behavior
drifts across the BPP rollout.

---

## Activation gating

`bppEnabled()` (defined in `dapp/bulletproofs-plus.js`) governs the
**sender-side** choice of opcode. The flag defaults ON for signet, OFF
for mainnet, and flips via
`localStorage['tacit-bpp-enable-mainnet-v1']`. Indexers MUST accept BPP
envelopes on both networks unconditionally — the gate is producer-side
only.

The reference dapp's `buildAndBroadcast{Axfer, AxferVar}` send paths
SHOULD accept a `useBpp` flag mirroring the existing `useBpp` flag on
`buildAndBroadcastCXfer` / `buildAndBroadcastCXferMulti`. Default
selection follows `bppEnabled()`.

---

## Test plan

### 1. Wire format

- `tests/axfer-bpp-wire.test.mjs` — encode → decode roundtrip across
  `N ∈ {1, 2, 4, 8}` for T_AXFER_BPP and N=2 for T_AXFER_VAR_BPP;
  rejection cases (wrong opcode byte, truncated payload, invalid
  asset_input_count, N≠2 for VAR); byte-level structural invariant
  (T_AXFER vs T_AXFER_BPP differ in opcode byte only when rangeproof
  bytes match).

### 2. Validator integration

- Extend the existing `validateOutpoint` dispatch test to include
  T_AXFER_BPP and T_AXFER_VAR_BPP branches. Real BP+ proofs from
  `bppRangeProve` round-trip through `bppRangeVerify` inside the
  validator; rejection on malformed proofs / wrong opcode / asset_id
  mismatch / kernel-sig invalidation.

### 3. Mixed-ancestry walks

- 5-hop chain alternating CXFER → AXFER → CXFER_BPP → AXFER_BPP →
  AXFER_VAR_BPP; final scan validates correct dispatch at each depth.
  Mirrors `tests/cxfer-bpp-onchain-e2e-signet.mjs`.

### 4. Wallet recovery on mixed chains

- Fresh-device privkey-only recovery across a chain containing BP and
  BP+ AXFER variants. ECDH amount decryption succeeds across all
  hops. T_AXFER_VAR_BPP recovery via OP_RETURN(80) decode works
  identically to T_AXFER_VAR.

### 5. Cross-surface integration on signet

- T_AXFER_BPP listing-take end-to-end (maker publishes intent, taker
  claims, fulfillment broadcast, recipient + change credit).
- T_AXFER_VAR_BPP variable-amount fill end-to-end (maker pre-signs,
  taker selects fill_amount, settlement broadcast, OP_RETURN(80)
  recovery verified on both sides).

### 6. Batched preauth-take with BPP

- N preauth sales by N distinct sellers settled in one
  T_AXFER_BPP reveal (asset_input_count = N). Confirms the §5.7.8.1
  position-independent SIGHASH_SINGLE_ACP optimization composes with
  BPP. Worker hint indexing (fill_count, instant-batch
  listing_kind) unaffected.

---

## What this amendment explicitly does NOT specify

Out of scope, left for follow-up amendments:

1. **`T_SWAP_VAR_BPP` (BP+ variant of `T_SWAP_VAR` `0x32`).** The AMM
   per-trade swap surface is conceptually the same opportunity but has
   different envelope structure (no `asset_input_count`, different
   intent-msg shape, different receipt-blinding). Separate amendment.

2. **`T_BURN_BPP`.** Burns are rare; lower priority. Could be added in
   a follow-up amendment if there's demonstrated user demand.

3. **Higher aggregation cap (m=16, m=32).** Currently pinned at
   `N ∈ {1, 2, 4, 8}` for parity with T_AXFER. Bigger m gives
   logarithmic witness savings on multi-recipient sends. Future
   amendment if drop-batch flows become a hot path.

4. **Auto-route choice in the dapp.** Whether the send path defaults
   to BPP, defaults to BP, or surfaces an explicit toggle is a UX
   decision for the dapp implementation, not a protocol concern.
   Both are equally valid at the wire layer.

---

## Sign-off checklist

- [x] Initial author draft (this file)
- [x] Opcode `0x3C` / `0x3D` confirmed collision-free against the
  live opcode list at SPEC.md §1.1 (both in the explicitly-free
  range `0x3B–0x42`)
- [x] No new domain tags introduced
- [x] Reference implementation landed in `dapp/tacit.js`:
  - `T_AXFER_BPP = 0x3C` and `T_AXFER_VAR_BPP = 0x3D` constants
  - `encodeAxferBppPayload` / `decodeAxferBppPayload`
  - `encodeAxferVarBppPayload` / `decodeAxferVarBppPayload`
  - `validateOutpoint` dispatch branches for both new opcodes
    (invoke `bppRangeVerify` instead of `bpRangeAggVerify`;
    everything else byte-identical)
  - `getParentEnvelopeData` ancestry-walk handlers
  - `scanHoldings` recipient-discovery + amount-recovery paths
    extended to recognize both new opcodes
- [x] Reference implementation landed in `worker/src/index.js`:
  - `T_AXFER_BPP` / `T_AXFER_VAR_BPP` constants
  - `decodeAxferBppPayload` / `decodeAxferVarBppPayload` structural
    decoders
- [x] Wire-format test (`tests/axfer-bpp-wire.test.mjs`)
- [ ] Validator-integration test (mirror
  `tests/cxfer-bpp-integration.test.mjs`)
- [ ] Adversarial test (mirror
  `tests/bulletproofs-plus-adversarial.test.mjs` for the AXFER
  decoders' rejection paths)
- [ ] Pinned deterministic proof fixtures for both opcodes
- [ ] Worker dispatch sites extended to recognize BPP opcodes in
  cron scan loops, balance hints, `commitmentForUtxo`, transfer
  counters
- [ ] Dapp `buildAndBroadcastTAxfer` + `buildAndBroadcastTAxferVar`
  send paths accept a `useBpp` flag (mirror the existing flag on
  `buildAndBroadcastCXfer`)
- [ ] Signet on-chain harness exercising listing-take + variable-fill
  via BPP variants
- [ ] First T_AXFER_BPP envelope broadcast on signet
- [ ] First T_AXFER_VAR_BPP envelope broadcast on signet
- [ ] First mainnet activation after signet bake

---

*End of amendment draft.*
