# SPEC §4.2 Amendment — Tacit Wrapper Convention

> **STATUS: ✅ MERGED into SPEC.md on 2026-05-15.** §4.2 + §5.19
> T_WRAPPER_ATTEST (`0x38`) + `tacit-wrapper-attest-v1` BIP-340
> message tag are now part of the SPEC.md normative text. This
> amendment file is preserved as a historical record of the
> drafting process.

> Adds an asset-metadata convention for **wrapped assets** — tacit-native
> tokens backed by underlying Bitcoin-layer assets (native sats, runes,
> ordinals, etc.) custodied by an issuer with publicly auditable
> reserves. Convention-only: no new opcode, no protocol-level change, no
> indexer trust requirement on any issuer. Permissionless — anyone can
> CETCH a wrapper-tagged asset and bootstrap their own variant.
>
> **Scope of unchanged behavior.** This amendment does not change any
> opcode, wire format, validator rule, or existing asset. Wrapper-
> tagged assets are regular tacit assets (CETCH origin, §4.1) that
> additionally carry a structured metadata field. Indexers without
> the wrapper-convention upgrade treat them as plain CETCH assets.

---

## Motivation

Tacit can already represent any asset that can be cryptographically
custodied: CETCH defines fungible tokens; T_MINT lets an issuer
expand supply against a `mint_authority`. The orderbook + AMM trade
these assets natively.

What's missing is a **convention for assets that represent something
held outside the tacit indexer's namespace.** A maker who custodies
1 BTC and issues 1 cBTC-against-it has no on-chain way to *attest
that backing relationship* in a form the indexer + dapp can read.
Without convention, every wrapped asset implementation invents its
own metadata shape, dapp discovery is bespoke, and routing logic
between wrapped variants is impossible.

This amendment specifies the convention. Goals:

1. **Permissionless issuance.** Any CETCH issuer can self-tag their
   asset as a wrapper. No registry, no whitelist, no approval gate.
2. **Reserve verifiability without trusting the issuer.** Reserve
   addresses are public on chain; supply is observable from tacit
   indexer state. Coverage = `reserves(asset) ≥ supply × peg_ratio`
   is computed by any indexer from public data.
3. **Issuer liveness signal.** Periodic issuer-signed attestations
   provide a heartbeat ("I'm online and committed to honour
   redemptions"). Absence of attestations is detectable; presence
   does not constitute trust transferral.
4. **Cross-variant routing.** The dapp can discover all wrapper-
   tagged assets of a given kind (e.g., all `cBTC.*` variants),
   score them by `(coverage, peg deviation, fee, liveness)`, and
   route trades through the best-scoring variant.

The convention deliberately **does not** introduce trust in any
specific issuer. The TAC team MAY operate the first cBTC variant
as a reference implementation, but the convention is built so the
ecosystem can include competing variants with no protocol-level
distinction between them.

---

## §4.2 Wrapper convention (CETCH metadata extension)

### 4.2.1 Wrapper metadata field

CETCH asset metadata (§3.X — IPFS-pinned JCS-canonical JSON blob
content-addressed by the CETCH's `metadata_cid`) MAY include a
top-level `tacit_wrapper` field. Presence of this field declares
the asset to be a wrapper; absence declares it a plain asset.

The example below is annotated with `//` comments for clarity; the
actual on-chain bytes are JCS-canonical JSON (RFC 8785) and do NOT
contain comments. JCS canonicalisation also sorts object keys
alphabetically and normalises numeric encoding — encoders and
decoders must round-trip through canonical form for the
`metadata_cid` to match.

```jsonc
{
  // existing CETCH metadata fields: ticker, decimals, image_uri, etc.
  // ...

  "tacit_wrapper": {
    "version": 1,                        // convention version
    "underlying": {                      // what the asset wraps
      "chain": "bitcoin",                // chain identifier
      "asset": "native",                 // "native" | "rune:<rune_id>" | "ordinal:<inscription_id>"
      "unit": "satoshi"                  // base unit of the underlying
    },
    "peg": {
      "numerator": 1,                    // u64; 1 base unit of cBTC
      "denominator": 1,                  // u64; = 1 satoshi
      "kind": "fixed"                    // "fixed" | "oracle_priced"
    },
    "custody": {
      "kind": "multisig",                // "multisig" | "user_dlc" | "burn" | "user_custody"
      "reserve_address": "bc1p...",      // bech32; where reserves are observable on chain.
                                         // MUST be used solely for wrapper reserves;
                                         // commingling with other funds is a protocol
                                         // violation (see §4.2.3 *Reserve isolation*).
      "threshold_k": 3,                  // optional; signing threshold for multisig
      "threshold_n": 5,                  // optional; total signer count
      "escape": {                        // optional; reserve-loss mitigation
        "kind": "csv_timeout",
        "blocks": 26280                  // ~6 months; after timeout, holders can coordinate spend
      }
    },
    "redemption": {
      "fee_bps": 10,                     // maximum basis points charged on burn.
                                         // Actual fee MAY be lower (advertised
                                         // via the issuer's auto-taker intent)
                                         // but MUST NOT exceed this ceiling.
      "min_request_units": 1000,         // optional; minimum tacit-base-unit amount
                                         // accepted in EITHER direction (mint or burn).
      "endpoint": "https://..."          // optional; off-band coordination URL
    },
    "attestation": {
      "issuer_pubkey": "02ab...",        // 33-byte compressed; signs attestations
      "schedule_blocks": 144             // expected gap between attestations, in Bitcoin blocks.
                                         // Conventional values: 6 (hourly), 144 (daily),
                                         // 1008 (weekly). 0 = "on_demand" (no schedule).
      // Note: the signing-message domain is implied by `version` (= 1 ⇒
      // "tacit-wrapper-attest-v1"). No explicit domain field — version
      // pinning prevents drift.
    }
  }
}
```

All fields under `tacit_wrapper` MUST be present unless explicitly
marked optional. Implementations encountering an unknown `version`
value MUST treat the asset as a plain asset (forward compat).

### 4.2.2 Field semantics

**`underlying.chain`** identifies the source-layer chain. v1 supports
`"bitcoin"`; future versions MAY add other chains.

**`underlying.asset`** identifies the specific asset on that chain:
- `"native"` — native chain currency (sats for Bitcoin)
- `"rune:<rune_id>"` — a specific rune (rune_id format per Runes spec)
- `"ordinal:<inscription_id>"` — a specific inscription
- Other values MAY be defined by future convention extensions.

**`underlying.unit`** names the indivisible base unit of the
underlying. For Bitcoin native: `"satoshi"`. For runes: per-rune.

**`peg.numerator` / `peg.denominator`** define the exchange ratio:

```
base_units_of_tacit_asset = (underlying_units × numerator) / denominator
```

Equivalently, the underlying backing required per tacit base unit is
`denominator / numerator`. Examples:

- **cBTC at 1:1 with sats**: `numerator = 1, denominator = 1`. One sat
  backs one cBTC base unit.
- **"100-sat cBTC unit" wrapper** (each cBTC base unit represents 100
  sats of backing): `numerator = 1, denominator = 100`. From the formula:
  100 underlying sats × 1 / 100 = 1 cBTC base unit. Backing per cBTC
  base unit = 100 / 1 = 100 sats.
- **"Fractional cBTC unit" wrapper** (each cBTC base unit represents
  one one-hundredth of a sat — degenerate but illustrative):
  `numerator = 100, denominator = 1`. From the formula: 1 sat ×
  100 / 1 = 100 cBTC base units. Backing per cBTC base unit = 1 / 100
  sat (impossible without fractional sats; included only to show the
  formula direction).

Implementations MUST ensure the coverage check in §4.2.3 uses the
*backing-per-tacit-unit* form (`denominator / numerator`), not the
inverse.

**`peg.kind`**:
- `"fixed"` — peg is constant. Reserves backing is checked as
  `reserves ≥ supply × numerator / denominator`.
- `"oracle_priced"` — peg varies (e.g., USD-pegged stablecoin
  collateralized in sats). Coverage check requires an oracle price
  feed; specified by a separate amendment (see *Out of scope*).
  v1 wrappers SHOULD use `"fixed"`; `"oracle_priced"` placeholder
  is reserved for a future cUSD-style amendment.

**`custody.kind`**:
- `"multisig"` — issuer custodies reserves in an N-of-M Taproot
  multisig at `reserve_address`. `threshold_k` and `threshold_n`
  describe the signing threshold.
- `"user_dlc"` — reserves are individually held in 2-of-2 DLCs
  per user (MakerDAO-style; reserved for cUSD-style amendment).
- `"burn"` — reserves are provably destroyed (one-way wrapping;
  no redemption path; useful for proof-of-burn assets).
- `"user_custody"` — each holder custodies their own backing
  (e.g., HTLC-locked sats per cBTC unit); placeholder for
  research-grade variants.

**`custody.reserve_address`** is the bech32 chain address where
reserves are observable. Indexers compute `reserves_balance` by
summing the UTXOs at this address.

**`custody.escape`** describes the holder-side mitigation if the
issuer goes offline:
- `"csv_timeout"` — after `blocks` confirmations of no issuer
  activity, holders coordinate to spend the multisig via the
  CSV-locked escape path. Specifics depend on the multisig script.

**`attestation.issuer_pubkey`** signs periodic reserve-coverage
attestations and the issuer's commitment to honour redemptions.
Compromise of this key compromises the *issuer-attestation
trustworthiness*; it does NOT compromise the reserves themselves
(those are held in `reserve_address` under multisig keys).

**`attestation.schedule_blocks`** is the expected interval, in
Bitcoin blocks, between successive issuer attestations. Conventional
values:

- `6` blocks (~hourly): high-volume issuers wanting tight liveness
- `144` blocks (~daily): typical issuer cadence
- `1008` blocks (~weekly): low-touch issuers
- `0`: `"on_demand"` — no fixed schedule; freshness defined per
  indexer policy (e.g., "attestation within last 7 days").

Indexers compute `attestation_freshness_factor` as a function of
the gap between `now_block_height` and the most recent attestation's
`as_of_height`. The reference formula:

```
gap = max(0, current_height − latest_attestation.as_of_height)
freshness =
  1.0                            if schedule_blocks == 0 (on-demand)
  1.0                            if gap ≤ schedule_blocks
  max(0.0, 1.0 − (gap − schedule_blocks) / (2 × schedule_blocks))
                                  otherwise (linear decay to 0 over 2× schedule)
```

So a daily-schedule issuer (144 blocks) is fully fresh up to 144
blocks late, then linearly decays to 0 over the next 288 blocks
(3× total schedule duration). Tunable per dapp policy.

**`redemption.fee_bps`** is the **maximum** fee the issuer charges
on burn (in basis points). Issuers MAY charge less by advertising a
lower fee in their auto-taker intent, but MUST NOT charge more.
Indexer scoring uses this max as the worst-case cost.

**`redemption.min_request_units`** is the minimum tacit-base-unit
amount accepted in either direction (mint or burn). Setting it to
1000 means an issuer's auto-lister won't honor mint requests for
fewer than 1000 base units, and the auto-taker won't accept burn
requests for fewer either. Symmetry simplifies the issuer's
inventory logic. If asymmetry is needed in a future amendment,
split into `min_mint_units` / `min_burn_units`.

### 4.2.3 Cryptographic reserve coverage check

Indexers SHOULD compute, for each wrapper-tagged asset whose
`underlying.chain` + `underlying.asset` it supports, the coverage
ratio:

```
expected_reserves = supply(asset) × peg.denominator / peg.numerator
coverage(asset)   = reserves_balance(asset.custody.reserve_address)
                  / expected_reserves
```

Where:

- `reserves_balance(addr)` is the sum of `underlying.asset` balances
  at `addr` (for bitcoin native: sum of UTXO values in satoshis; for
  runes: per-rune balance per the rune protocol; for ordinals: count
  of inscriptions held at the address).
- `supply(asset)` is the cumulative issued supply minus burned
  supply, derived from tacit indexer state: `Σ T_MINT amounts − Σ
  T_BURN amounts` for the asset_id.
- `peg.denominator / peg.numerator` is the backing-per-tacit-unit
  ratio derived from the peg semantics formula in §4.2.2. For a 1:1
  peg this is 1; for "100-sat cBTC unit" it is 100; etc.

**Indexer support scope.** This is `SHOULD` (not `MUST`) because
indexers cannot compute coverage for underlyings they don't speak.
A tacit indexer that only knows the Bitcoin chain layer can compute
coverage for `underlying.chain="bitcoin", underlying.asset="native"`
trivially (UTXO sum), but for `"rune:..."` or `"ordinal:..."` it must
either embed rune/ordinal protocol parsing or mark coverage as
**unknown** in registry queries. Dapps SHOULD treat
coverage-unknown variants as "no liveness signal" rather than
"untrustworthy" — the asset can still be traded; the user just has
less automated information about backing.

Indexers that DO support a given `(chain, asset)` pair MUST surface
under-collateralised state (`coverage < 1.0`) in every query that
returns the wrapper. The dapp SHOULD score under-collateralised
variants proportionally lower in routing decisions.

**Reserve isolation (MUST).** The `custody.reserve_address` MUST be
used **exclusively** for wrapper reserves. Issuers MUST NOT commingle
protocol fees, treasury holdings, payment receipts, or any other
non-reserve funds at this address. Commingling inflates the
computed `coverage` ratio (non-reserve UTXOs are indistinguishable
from reserve UTXOs at the chain layer) and is a protocol violation.
Indexers MAY perform heuristic detection of commingling — e.g.,
flagging issuers whose `reserve_address` shows spend patterns
inconsistent with redemption flows — but rigorous cryptographic
enforcement requires covenants (not available on Bitcoin L1
today) and is left to a future amendment. In v1, this is a
normative rule enforced by ecosystem reputation rather than chain
script.

**No trust transferral.** The coverage check is a pure function of
public on-chain data. Anyone running an indexer can compute it.
Disagreements between indexers indicate data-fetch bugs, not
adversarial issuers.

**No protocol-level rejection.** An indexer does NOT reject
transactions involving under-collateralised wrapper assets; the
asset's UTXOs remain valid and spendable. The convention is
advisory: it lets the ecosystem *see* under-collateralisation, not
*prevent* it. Issuer competition + market pricing handle the rest.

### 4.2.4 Issuer attestation

Issuers SHOULD periodically publish a signed attestation:

```
attestation_msg = SHA256(
    "tacit-wrapper-attest-v1"
    || network_tag(1)                 // 0x00=mainnet, 0x01=signet, 0x02=regtest
    || asset_id(32)
    || issuer_pubkey(33)
    || reserves_balance_LE(8)         // claimed reserves at as_of_height
    || supply_LE(8)                   // claimed supply at as_of_height
    || as_of_height_LE(4)             // bitcoin block height of attestation
    || timestamp_LE(8)                // unix seconds
)

attestation_sig = BIP-340 over attestation_msg under issuer_pubkey
```

The `network_tag` byte prevents cross-network replay. Although
`asset_id` derives from `etch_txid` (network-specific in practice),
the tag closes the theoretical hole where two networks have
colliding asset_ids and an attestation from one network could be
replayed against the other.

The attestation is published off-chain (issuer's website, IPFS, or
the tacit worker). It serves three purposes:

1. **Liveness signal.** A recent attestation proves the issuer is
   online. Indexers SHOULD downgrade routing weight for variants
   whose most-recent attestation is older than 3× the declared
   `attestation.schedule` interval.
2. **Commitment to honour redemption.** The attestation message
   binds the issuer's public commitment to the (reserves, supply)
   pair as of a specific height. A misbehaving issuer who
   subsequently rugpulls leaves a publicly-signed claim on record.
3. **Independent verification.** Any third party can fetch the
   attestation, verify the signature, fetch the named reserve and
   supply values from chain, and confirm the issuer's claim
   matches reality. Discrepancies are publishable.

Attestations are NOT consensus-relevant. Indexers MUST NOT use
attestations to reject transactions. The attestation is a
*reputation primitive*, not a *protocol primitive*.

### 4.2.5 Indexer discovery + routing

Indexers MAINTAIN a wrapper registry derived from CETCH metadata:

```
wrapper_registry: Map<(underlying.chain, underlying.asset), Set<asset_id>>
```

Populated by scanning every confirmed CETCH for a `tacit_wrapper`
metadata field, with v1 version compatibility check.

Indexers expose two query endpoints:

```
GET /wrappers/{chain}/{asset}
  → list of variants with: asset_id, ticker, issuer_pubkey,
    coverage_ratio, latest_attestation_timestamp,
    custody.kind, custody.reserve_address, redemption.fee_bps,
    routing_score

GET /wrappers/{asset_id}
  → full tacit_wrapper metadata + computed coverage + latest
    attestation (if any) + AMM-pool depth across pairs
```

Dapps consume these endpoints to:

- Surface "send/receive BTC" UI that resolves to wrapper variants
- Route trades against best-scoring variants
- Surface coverage warnings when a variant is under-collateralised
- Show issuer attestation freshness as a trust signal

### 4.2.6 Routing score (informative)

Reference scoring function used by the canonical dapp:

```
routing_score(variant) =
    w_coverage    × min(1.0, coverage_ratio)           // capped at 1.0
  − w_deviation   × abs(amm_price_vs_peg − 1.0)        // peg deviation
  + w_liveness    × attestation_freshness_factor        // 0.0..1.0
  − w_fee         × (redemption.fee_bps / 10000.0)     // higher fee = lower score
  + w_depth       × log10(1 + amm_total_tvl_sats)      // deeper liquidity preferred
```

Weights are dapp-tunable. The reference values (subject to change
as the ecosystem matures): `w_coverage = 1.0, w_deviation = 0.5,
w_liveness = 0.3, w_fee = 0.2, w_depth = 0.4`.

Variants with `coverage < 0.98` are flagged for user attention.
Variants with `attestation_freshness_factor < 0.3` (no attestation
in 3× schedule interval) are demoted in routing.

The scoring function is **dapp policy**, not protocol. Competing
dapps MAY score differently. Issuers compete on the underlying
trust signals, not on dapp ranking.

---

## §5.20 T_WRAPPER_ATTEST (`0x38`) — optional on-chain attestation

> **Status:** OPTIONAL. Issuers MAY publish attestations off-chain
> (IPFS, website) without ever using this opcode. The opcode is
> defined for issuers who want their attestation timestamped onto
> Bitcoin chain itself, providing a stronger liveness signal at the
> cost of ~2 Bitcoin txs per attestation (commit + reveal pair —
> see *On-chain embedding pattern* below).

### Wire format (envelope payload)

```
T_WRAPPER_ATTEST(2)
   envelope_version  0x01
   opcode            0x38
   network_tag       1 byte  (0x00=mainnet, 0x01=signet, 0x02=regtest)
   asset_id          32 bytes
   issuer_pubkey     33 bytes (compressed)
   reserves_LE       8 bytes (u64; reserves balance at as_of_height)
   supply_LE         8 bytes (u64; circulating supply at as_of_height)
   as_of_height_LE   4 bytes (u32; Bitcoin block height)
   timestamp_LE      8 bytes (u64; unix seconds)
   attestation_sig   64 bytes (BIP-340 over attestation_msg per §4.2.4)
```

Fixed-size envelope payload: **158 bytes**. No Pedersen commitments,
no range proofs, no asset-input chain. Purely a signed-data envelope.

### On-chain embedding pattern

158 bytes exceeds Bitcoin's standard `OP_RETURN` policy limit (80
bytes of data). T_WRAPPER_ATTEST therefore uses the **standard
tacit commit-reveal pattern** identical to T_AXFER / T_AXFER_VAR /
mixer envelopes (§5):

- **Commit tx**: a Bitcoin transaction with one P2TR output. The
  P2TR's tap-tree is a single leaf whose script is the
  envelope-bearing tacit script (`OP_FALSE OP_IF "TACIT" 0x01
  <payload> OP_ENDIF`). The internal key is NUMS so only the
  script-path is spendable.
- **Reveal tx**: a Bitcoin transaction whose `vin[0]` spends the
  commit's P2TR output via script-path, revealing the envelope as
  the script-path witness. The reveal tx has no required tacit
  vouts (the attestation produces no asset UTXO). Optional vouts MAY
  carry BTC change at the issuer's discretion.

Concretely, **two Bitcoin transactions** are required per
attestation: the commit and the reveal. Total on-chain cost is
roughly equivalent to a T_AXFER atomic-intent settlement.

Issuers wanting a lower-cost attestation path SHOULD publish
attestations off-chain (IPFS, website, tacit worker) — those carry
the same `attestation_msg` content and BIP-340 signature, just
without the Bitcoin-anchored timestamp. The trade-off is liveness
proof: an on-chain attestation has miner-block-time as a
non-spoofable timestamp; an off-chain one relies on the publishing
infrastructure's clock.

### Per-tx cost estimate

| Component | Approx vbytes | Notes |
|---|---|---|
| Commit tx | ~115 vbytes | 1 input (P2WPKH funding) + 1 P2TR output + 1 P2WPKH change |
| Reveal tx | ~270 vbytes | 1 commit input (script-path with 158-byte envelope) + optional vouts |
| Total | ~385 vbytes | At 10 sat/vB: ~3850 sats per attestation |

Daily attestation at mainnet fee rates: ~$1-2/day at current sats
prices. Issuers MAY skip on-chain attestation entirely if cost is
prohibitive; the off-chain channel remains canonical.

### Validator algorithm

```
if envelope.opcode == T_WRAPPER_ATTEST:
    require envelope.asset_id is well-formed
    require envelope.issuer_pubkey is a valid compressed secp256k1 point
    require envelope.network_tag matches the local network identifier

    // Height bound — applied differently at mempool admission vs
    // post-confirmation:
    if validating at mempool admission:
        require envelope.as_of_height ≤ current_tip_height
    if validating post-confirmation:
        require envelope.as_of_height ≤ this_tx.confirmation_height

    recompute attestation_msg per §4.2.4 (binds the same network_tag)
    require attestation_sig verifies under issuer_pubkey

    if all checks pass:
        // Three-case dedup against the wrapper-attestation log keyed by
        // (network, asset_id, issuer_pubkey, as_of_height):
        let existing = log.get(network, asset_id, issuer_pubkey, as_of_height)
        if existing is None:
            log.put(...)                                       // first-confirmed: record
            accept envelope
        else if existing.{reserves,supply,timestamp} == envelope.{...}:
            accept envelope (idempotent duplicate; no state change)
        else:
            flag issuer_pubkey as EQUIVOCATOR in wrapper registry
            reject envelope (do not overwrite the canonical entry)
```

The reveal tx's vouts MAY carry anything (BTC change, etc.); none
of them are tacit UTXOs. The envelope sits in `vin[0].witness[1]`
as the script-path leaf script, not in any vout.

### Soundness

The opcode emits no asset UTXOs and modifies no asset state. Its
only effect is appending an entry to the indexer's wrapper-
attestation log keyed by `(network, asset_id, issuer_pubkey,
as_of_height)`. An adversarial issuer attestation is *publishable*
(the sig verifies) but is *easily refuted* by anyone who fetches
the named reserve and supply values from chain and observes a
mismatch.

Replay protection — three distinct cases:

1. **First attestation per (network, asset_id, issuer_pubkey,
   as_of_height)**: indexer records it; accept.
2. **Duplicate attestation with byte-identical content**: accept
   silently (idempotent; safe for retry/rebroadcast scenarios).
3. **Equivocation** — same `(network, asset_id, issuer_pubkey,
   as_of_height)` tuple, but a different `(reserves, supply,
   timestamp)`: flag the issuer in the wrapper registry as an
   equivocator. Subsequent attestations from this issuer MAY be
   downweighted or rejected by indexers (per dapp policy). The
   canonical entry remains the first-confirmed one.

---

## Reference implementations (informative)

A reference implementation of one specific wrapper (cBTC backed by
native sats, federated multisig custody) is documented separately
in `../design/CBTC-ISSUER-DESIGN.md`. That document is **not part of this
spec**; it describes one *example* application of the convention.
The TAC team MAY operate the instance described there, but doing so
is not required by the protocol and does not grant TAC any special
status. Any competing issuer can publish their own variant under
the same convention with no protocol-level distinction.

The convention itself ends here. The wrapper-tagged asset is a
plain CETCH plus an additional metadata field, with indexer-derived
discovery + scoring built on top. Everything operational lives
outside SPEC.md.

---

## Backwards-compatibility statement

This amendment does **not** modify any existing wire format, opcode,
domain tag, validator rule, asset_id derivation, or transaction
shape. Specifically:

- **Existing CETCH envelopes are not modified.** A CETCH whose
  metadata does not include `tacit_wrapper` validates exactly as it
  does today.
- **Existing assets (TAC, etc.) are unaffected.** Their metadata
  doesn't include `tacit_wrapper`; the convention is opt-in via
  metadata at CETCH publish time.
- **Indexers without the wrapper-convention upgrade** treat
  wrapper-tagged CETCHes as plain CETCHes. No transactions become
  invisible; the asset behaves identically modulo the absence of
  the new convention-derived registry.
- **T_WRAPPER_ATTEST (opcode 0x38) is forward-compatible.**
  Pre-amendment indexers encountering this opcode treat it as an
  unknown envelope per §4.1; no asset-state effect. The
  attestation chain becomes invisible to old indexers; nothing
  breaks.

### Coordinated rollout

The convention can be deployed in any order:

1. SPEC.md amendment lands.
2. Reference indexer + dapp gain wrapper-registry support.
3. First issuer (e.g., TAC team) CETCHes a wrapper-tagged asset.

Step 3 produces a wrapper variant the moment it confirms. Steps 1
and 2 unblock discovery; step 3 unblocks usage. The order between
1 and 2 is unconstrained because the convention is opt-in.

A daily mainnet canary continues to verify no existing asset's
behavior drifts. The TAC asset's state remains pinned identically
before and after this amendment.

---

## Test plan (informative — non-normative)

Implementation PRs landing this amendment MUST include:

1. **Metadata round-trip tests.** Encoder + decoder for the
   `tacit_wrapper` JCS field across all v1 fields, including
   optional / absent fields. At least 50 random fixtures with
   pinned byte-level test vectors.

2. **Coverage computation tests.** Given synthetic chain state
   (reserve UTXOs at a fixed address, supply mints/burns), verify
   `coverage(asset)` matches the expected ratio. Include edge cases:
   zero supply, zero reserves, reserves exactly equal to supply,
   over-collateralisation.

3. **Attestation message + sig parity tests.** Independent
   implementations (dapp, worker, third-party indexer) produce
   byte-identical `attestation_msg` and verify byte-identical
   `attestation_sig` under a known keypair.

4. **Wrapper registry indexing tests.** Indexer scans a synthetic
   chain containing N wrapper-tagged CETCHes; query
   `GET /wrappers/{chain}/{asset}` returns the expected variants
   with correct coverage + scoring.

5. **Routing-score regression tests.** For a synthetic variant set
   with varying coverage / liveness / fee, the routing score
   ordering is deterministic and matches the expected ranking.

6. **End-to-end mint/burn signet flow.** Same harness as
   `axintent-onchain-e2e-signet.mjs`: a reference cBTC variant
   issues, a user mints via the auto-lister intent, a user burns
   via the auto-taker, reserves coverage stays > 1.0 throughout.

7. **Equivocation detection.** Two `T_WRAPPER_ATTEST` envelopes
   from the same issuer with the same `as_of_height` but different
   `(reserves, supply)` values: indexer flags the issuer.

8. **Backwards-compat replay.** Snapshot 50 historical mainnet
   CETCH transactions; verdicts before/after the amendment are
   byte-identical. (Same shape as the variable-amount amendment's
   replay test.)

9. **TAC canary.** Existing mainnet canary passes before and after.

---

## Domain tag additions

Add to §3 *Domain labels*:

- (none — `tacit-wrapper-attest-v1` is a BIP-340 message tag, not
  an HMAC keystream domain)

Add to §3 *BIP-340 Schnorr signature-message tags*:

- `tacit-wrapper-attest-v1` — issuer's signed attestation of
  (reserves, supply, as_of_height, timestamp) per §4.2.4.

Add to §3 *opcodes table*:

- `0x38` `T_WRAPPER_ATTEST` — optional on-chain attestation
  envelope (§5.20). Sits immediately after `T_AXFER_VAR (0x37)`;
  does not collide with V1-AMM opcodes (`0x2D`–`0x32`, which now
  includes `T_SWAP_VAR` at `0x32` per the swap-var amendment) or
  the V2-AMM range-LP reservation (`0x33`–`0x36`).

---

## What this amendment explicitly does NOT specify

Out of scope, left for future amendments:

1. **Oracle-priced pegs.** `peg.kind = "oracle_priced"` is reserved
   in the schema but its validator rules require a price-oracle
   primitive (LP-staked-Schnorr threshold attestation, FROST-style
   DKG, slashing). Specified by a separate cUSD amendment.
2. **User-DLC custody.** `custody.kind = "user_dlc"` is reserved for
   the cUSD-style CDP amendment where each user locks their own BTC
   collateral in a 2-of-2 with a price-oracle counterparty. Out of
   scope here.
3. **Cross-chain wrappers beyond bitcoin.** `underlying.chain` is
   defined for `"bitcoin"`; other chains MAY be added by future
   amendments but require careful trust-model analysis per chain.
4. **Issuer governance / federation rotation.** Multi-issuer
   federations rotating membership require additional protocol
   surface (multisig key rotation under a chain-attested
   governance procedure). Out of scope for v1; reference cBTC.tac
   uses static membership with CSV escape.
5. **Liquidity mining incentives** for cBTC-pool LPs. Pure dapp
   policy; no protocol-level support needed.

---

## Open questions for review

1. **Coverage rounding.** The coverage ratio is a float computed
   from u64 reserves and u64 supply. Should the spec mandate exact
   rational arithmetic (numerator/denominator pair) to avoid
   indexer disagreement on edge cases like coverage = 0.9999999?
   Reference impl uses 64-bit float and `coverage < 0.98` threshold,
   which gives ~6 significant digits of headroom against rounding
   drift. Acceptable for v1; revisit if disagreements emerge.

2. **Multi-issuer namespace collision.** Two issuers could both
   ticker their wrapper `cBTC` if no `.suffix` convention exists.
   Reference convention uses dotted suffixes (`cBTC.tac`,
   `cBTC.alice`) but the spec doesn't enforce this. Recommendation:
   leave as social convention for v1; if collisions become a
   problem, mandate `<base>.<issuer_pubkey_prefix>` form.

3. **Reserve address verification.** A misbehaving issuer could
   point `reserve_address` at a multisig they don't actually
   control (or at someone else's address). Mitigations: (a)
   indexer cross-checks that `reserves_address`'s historical
   spending patterns are consistent with claimed multisig threshold;
   (b) attestations are signed by `issuer_pubkey` whose ECDH
   relationship to the multisig members can be verified during a
   challenge. Both are best-effort, not cryptographic guarantees.
   v1 spec leaves this to dapp-level reputation; future amendments
   could add proofs.

4. **Cryptographic enforcement of reserve isolation.** §4.2.3
   mandates `reserve_address` be dedicated to wrapper reserves but
   cannot enforce this on-chain without covenants (BIP-119 OP_CTV /
   OP_VAULT / BitVM). v1 relies on ecosystem reputation +
   heuristic detection by indexers. A future amendment could
   require `reserve_address` to be a specific covenant-locked
   script type once Bitcoin gains the necessary opcodes.

---

## Sign-off checklist for landing

Before this amendment merges into `SPEC.md`:

- [x] Initial author draft (this file).
- [x] Peer-agent review (round 1) — `§5.21` reference instance
  in-spec / off-spec ambiguity flagged; network-tag missing from
  attestation_msg; reserve-commingling under-specified; redundant
  `attestation.domain` field; T_WRAPPER_ATTEST validator-timing
  ambiguity; attestation-dedup cases not enumerated.
- [x] Round 1 fix: removed `§5.21 Reference cBTC instance`; the
  reference implementation lives in `../design/CBTC-ISSUER-DESIGN.md`
  (separate doc), keeping SPEC.md purely about the convention.
- [x] Round 1 fix: added `network_tag(1)` byte to
  `attestation_msg` and to the `T_WRAPPER_ATTEST` envelope.
  Defends against cross-network replay even if asset_ids collide.
- [x] Round 1 fix: §4.2.3 now mandates `reserve_address` MUST be
  used exclusively for wrapper reserves (no commingling). Notes
  the limitation that v1 enforcement is reputational; future
  cryptographic enforcement requires covenants.
- [x] Round 1 fix: dropped redundant `attestation.domain` field
  from the schema. Domain is determined by `version`.
- [x] Round 1 fix: T_WRAPPER_ATTEST validator algorithm now
  distinguishes mempool-admission checks from post-confirmation
  checks for the `as_of_height` bound.
- [x] Round 1 fix: T_WRAPPER_ATTEST replay-protection now
  enumerates three cases (first-confirmed, idempotent duplicate,
  equivocation) with explicit handling rules.
- [x] Peer-agent review (round 2) — coverage-formula peg-ratio
  inversion identified (critical); T_WRAPPER_ATTEST wire-format
  embedding ambiguity flagged; coverage MUST too strong for non-sat
  underlyings; attestation schedule values not numerically defined;
  JCS/JSONC presentation mismatch; redemption.fee_bps ceiling
  semantics; min_request_units direction ambiguity.
- [x] Round 2 fix (CRITICAL): coverage formula corrected to
  `reserves / (supply × peg.denominator / peg.numerator)` —
  previously had numerator/denominator inverted, breaking non-1:1
  pegs. Example direction fixed: "100-sat cBTC unit" now
  `numerator=1, denominator=100`. Peg semantics block expanded with
  three worked examples.
- [x] Round 2 fix (BLOCKING): T_WRAPPER_ATTEST embedding pattern
  now explicit — commit-reveal (envelope in vin[0].witness[1] as
  Taproot script-path leaf, NOT in OP_RETURN). Per-tx cost
  estimate added (~385 vbytes total, ~2 txs per attestation).
- [x] Round 2 fix: coverage MUST softened to SHOULD for
  underlyings the indexer doesn't support. Indexers without rune /
  ordinal protocol awareness mark coverage as "unknown" rather
  than miscomputing.
- [x] Round 2 fix: `attestation.schedule` renamed to
  `attestation.schedule_blocks` with numeric Bitcoin-block values
  (6/144/1008/0). Reference freshness-factor formula added.
- [x] Round 2 fix: JCS vs JSONC presentation distinction noted
  inline at the schema example. Encoders/decoders round-trip
  through canonical form for `metadata_cid` consistency.
- [x] Round 2 fix: `redemption.fee_bps` schema comment now states
  "maximum" + "actual MAY be lower" explicitly.
- [x] Round 2 fix: `min_request_units` semantics clarified —
  symmetric (both mint and burn floors). Future asymmetry would
  split into `min_mint_units` / `min_burn_units`.
- [x] Confirm `0x38` opcode collision-free against the live
  opcode list (checked against §5.1–§5.18 + variable-amount `0x37`).
- [x] Confirm `tacit-wrapper-attest-v1` domain tag collision-free
  against the live §3 list.
- [x] **Merged into SPEC.md** (2026-05-15): §4.2.1–§4.2.6 added as
  the wrapper-convention section; §5.19 T_WRAPPER_ATTEST (`0x38`)
  added as the optional on-chain attestation envelope; §3 BIP-340
  signature-message tag list extended with `tacit-wrapper-attest-v1`;
  §5.5 validator dispatch extended with the T_WRAPPER_ATTEST branch.
- [ ] Independent review of the `tacit-wrapper-attest-v1` BIP-340
  message construction (post-merge, alongside crypto review of
  the cUSD CDP amendment which builds on the same primitive).
- [ ] Indexer + dapp + worker implementation PR opened (separate).
- [ ] Wrapper-registry integration tests landed.
- [ ] cBTC reference issuer operational design doc landed
  (separate file: `../design/CBTC-ISSUER-DESIGN.md`).
- [ ] First reference cBTC variant CETCHed on signet for testing.
- [ ] Migration plan for AMM cBTC pools post-ceremony.

---

*End of amendment draft.*
