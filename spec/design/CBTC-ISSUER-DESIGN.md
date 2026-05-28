# cBTC Federated Issuer — Reference Operational Design

> **STATUS: OPEN ECOSYSTEM-OPERATOR REFERENCE** (2026-05-17). This
> document specifies a federated 3-of-5 multisig design that any
> ecosystem operator can choose to deploy as a wrapper variant
> under their own suffix (e.g., `cBTC.alice`, `cBTC.fed`,
> `cBTC.federation-X`). It is not a protocol-shipped variant and is
> not maintained by the TAC team — but the wrapper convention
> (`SPEC-WRAPPER-AMENDMENT.md`) is permissionless, so operators who
> want to launch a federated cBTC instance have this reference to
> work from.
>
> **The protocol-shipped cBTC variants are non-federated:**
>
> - **`cBTC.zk`** — self-custody slot wrapper (trustless whole-slot),
>   defined in `SPEC-CBTC-ZK-AMENDMENT.md` and its companions
>   (AMOUNT, FUNGIBILITY).
> - **`cBTC.tac`** — (TAC, tETH)-LP-bonded fractional wrapper (fungible
>   amount-granular), defined in `SPEC-CBTC-TAC-AMENDMENT.md`.
>
> Neither uses a multisig reserve or co-signer service. Both rely
> on either cryptographic self-custody (cBTC.zk) or TAC over-
> collateralization (cBTC.tac) instead of federation trust.
>
> **Why this design is preserved as an open ecosystem reference:**
> the federated approach is one valid point on the trust-vs-UX
> curve. Some users + use cases may prefer it:
>
> - Operations with KYC/regulatory requirements where federation
>   accountability is required
> - Users who want amount-granular wrapped BTC without dependence
>   on TAC collateral mechanics
> - Bridge integrations to centralized exchanges that prefer
>   federated-custody assets
> - Regional or jurisdictional federation variants
>
> Third-party operators considering this path will find concrete
> operational mechanics here: multisig setup, key ceremony, auto-
> lister + auto-taker worker design, reserve dashboard,
> attestation cadence, failure modes, key rotation. They are
> free to copy, modify, or extend this design for their own
> federated wrapper variant.
>
> **Scope.** This doc covers: multisig setup, key ceremony, auto-
> lister + auto-taker worker design, reserve dashboard, attestation
> cadence, failure modes, key rotation. The tacit protocol itself
> treats any federated wrapper variant exactly like any other
> wrapper variant under the convention — no special-casing, no
> protocol-level endorsement, no protocol-level coverage check
> beyond what the convention specifies.

---

## 1. What this issuer is

**Ticker:** `cBTC.tac` (the `.tac` suffix identifies this specific
issuer; other competing variants would use other suffixes).

**Backing:** native Bitcoin sats, 1:1 with cBTC.tac base units.

**Custody:** 3-of-5 Taproot multisig with CSV-locked escape path.

**Operator:** TAC team or designated federation, transparent
membership.

**Settlement:** every mint and every burn is an atomic T_AXFER_VAR
swap (single Bitcoin tx). Trustless at the moment of trade — the
user cannot be cheated of either the sats or the cBTC at the moment
of exchange; the swap either settles fully or doesn't broadcast.

### Trust profile (honest)

This is a **federated wrapper**, not a trustless one. Specifically:

- ✅ **Trustless at the moment of trade.** Atomic T_AXFER_VAR
  settlement on Bitcoin L1. No "deposit and wait" custody risk.
- ✅ **Coverage is publicly verifiable.** Anyone can compute
  `reserves_at(multisig) ≥ supply` from chain alone. Misbehaving
  federation is observable, not deniable.
- ⚠️ **Reserves can be drained by federation collusion.** 3-of-5
  threshold ⇒ 3 colluding members can move reserves. Mitigations:
  open membership, transparent identities, reputation cost.
- ⚠️ **CSV escape is partial.** §3.4 — the escape leaf is fixed at
  CETCH publish time, so only pre-declared escape participants can
  coordinate recovery. Users acquiring cBTC.tac after issuance have
  no direct path to escape funds if the federation goes offline.
  The pre-declared participants act as a recovery committee that
  could (off-chain) redistribute to current holders, but this
  requires trusting the committee.

For users wanting fully trustless wrapped BTC, the answer on
Bitcoin L1 today is: there isn't one — covenants haven't shipped.
cBTC.tac is the "atomic-trade + transparent-reserves + open-
issuance" point on the curve. Competing variants with different
trust trade-offs are encouraged by the wrapper convention.

---

## 2. CETCH metadata (concrete instance)

The CETCH metadata blob (JCS-canonical JSON, IPFS-pinned,
content-addressed by `metadata_cid`):

```jsonc
{
  "ticker": "cBTC.tac",
  "decimals": 8,
  "image_uri": "ipfs://bafybei...cbtc-logo",
  "description": "TAC-operated reference wrapper for native Bitcoin sats. 1:1 backed by sats in a public 3-of-5 multisig with CSV escape.",

  "tacit_wrapper": {
    "version": 1,
    "underlying": {
      "chain": "bitcoin",
      "asset": "native",
      "unit": "satoshi"
    },
    "peg": {
      "numerator": 1,
      "denominator": 1,
      "kind": "fixed"
    },
    "custody": {
      "kind": "multisig",
      "reserve_address": "bc1p... (TBD at key ceremony)",
      "threshold_k": 3,
      "threshold_n": 5,
      "escape": {
        "kind": "csv_timeout",
        "blocks": 26280
      }
    },
    "redemption": {
      "fee_bps": 10,
      "min_request_units": 1000
    },
    "attestation": {
      "issuer_pubkey": "02... (TBD at attestation-key ceremony)",
      "schedule_blocks": 144
    }
  }
}
```

**Decisions explained:**

- **Decimals 8.** Matches Bitcoin's native granularity (1 cBTC = 10⁸
  cBTC base units; 1 base unit = 1 sat). Avoids fractional-sat math.
- **CETCH `mint_authority`.** The CETCH envelope itself (not its
  metadata blob) carries a `mint_authority` field per SPEC §5.1.
  For cBTC.tac, `mint_authority` = the x-only Schnorr-aggregated
  pubkey corresponding to the 3-of-5 multisig members (MuSig2
  aggregate key). Subsequent T_MINT events require a BIP-340
  signature under this aggregate key, which requires 3 of 5
  federation members to co-sign via MuSig2 nonce-share + sig-share
  rounds. (The metadata-level `tacit_wrapper.custody.threshold_k/n`
  documents the human-readable threshold; the cryptographic
  enforcement lives in the CETCH-level `mint_authority`.)
- **3-of-5 multisig.** Tolerates 2 key losses and 2 compromised
  members. Larger thresholds (5-of-9, 7-of-11) reduce single-point
  risk further but increase coordination cost per mint/burn.
  3-of-5 is the standard institutional-grade Bitcoin custody
  threshold; sufficient for V1 launch.
- **CSV escape: 26280 blocks (~6 months).** Long enough that
  short-term federation outages don't trigger the escape path;
  short enough that catastrophic federation failure (all keys lost)
  doesn't strand users indefinitely. Holders can coordinate a
  Schnorr-aggregated spend via the escape leaf after the timeout.
- **Redemption fee 10 bps (0.1%).** Covers operational cost
  (multisig signing infrastructure, attestation publication, dashboard
  hosting) without dominating user UX. Competitive vs. typical
  wrapped-asset issuers (1-30 bps).
- **`min_request_units` = 1000.** Symmetric mint/burn floor. 1000
  sats ≈ $0.50–1 at typical prices; below this, the proportional
  BTC payment risks falling below Bitcoin's dust threshold (546 sats
  for P2WPKH).
- **Attestation cadence 144 blocks (~daily).** Common cadence;
  balances liveness signal value vs. on-chain attestation cost.

---

## 3. Multisig setup

### 3.1 Membership

**5 members**, each holding one Taproot script-path signing key.
Membership is published in the CETCH metadata's `description` and on
the operator dashboard. Suggested mix:

- 2 TAC team members (CEO + CTO or equivalent operational pair)
- 1 trusted external operator (e.g., an aligned issuer or
  ecosystem partner)
- 1 cold-storage custodian (a custody-service provider with no
  operational role)
- 1 community-aligned member (e.g., a long-time tacit LP or
  large cBTC.tac holder; rotation procedure documented in §6.3)

Diversifies single-actor risk. No single party can unilaterally
sign (3 needed). No single failure point loses funds (2 may fail).

### 3.2 Taproot script construction

The reserve address is a single P2TR with two script-path leaves:

**Leaf 1 — Multisig redemption (primary path):**

```
<Member1_xonly> OP_CHECKSIG
<Member2_xonly> OP_CHECKSIGADD
<Member3_xonly> OP_CHECKSIGADD
<Member4_xonly> OP_CHECKSIGADD
<Member5_xonly> OP_CHECKSIGADD
OP_3 OP_EQUAL
```

Spend requires 3 valid signatures from the 5 named members.
Standard `OP_CHECKSIGADD` tally pattern (BIP-342 compatible).

**Leaf 2 — CSV escape (recovery path):**

```
<26280> OP_CHECKSEQUENCEVERIFY OP_DROP
<EscapeMultisig_xonly> OP_CHECKSIG
```

After 26280 blocks (~6 months) of the reserve UTXO sitting unspent,
the escape leaf becomes spendable. `<EscapeMultisig_xonly>` is a
holder-coordinated MuSig2 aggregation across cBTC holders who opt
into the recovery — see §3.4.

**Internal key:** NUMS. Only the script-path is spendable;
key-path spend is structurally disabled. Standard NUMS construction
(SHA-256-derived counter, no DLP knowledge).

### 3.3 Reserve / hot-wallet separation and capital flow

User mint/burn settlements are **per-fill atomic** via T_AXFER_VAR
(§5.7.6.1) — each settlement is its own Bitcoin tx with the user
and issuer's hot wallet as counterparties. The reserve multisig is
**not directly involved** in user-facing settlements.

The flow:

```
USER MINT path:
  user sats UTXO  ──┐
                    │  T_AXFER_VAR atomic settlement (per fill)
  hot stockpile  ───┤  → user gets cBTC, hot wallet gets sats
  (cBTC.tac)        │
                    │  [periodic federation sweep, ~daily]
                    └─→ hot wallet sats moved to reserve multisig

USER BURN path:
  user cBTC UTXO ───┐
                    │  T_AXFER_VAR atomic settlement (per fill)
  hot sats float ───┤  → user gets sats, hot wallet gets cBTC
  (paid out)        │
                    │  [periodic federation refill, when float low]
                    └─→ reserve multisig pays back to hot wallet
```

**Two distinct cadences:**

| Operation | Cadence | Atomicity | Signers |
|---|---|---|---|
| User mint or burn | Per fill (sub-minute) | Atomic (single Bitcoin tx) | User + hot-wallet operator |
| Hot wallet → reserve sweep | Per day (or when float exceeds threshold) | Single multisig tx | 3-of-5 federation |
| Reserve → hot wallet refill | When hot float drops below threshold | Single multisig tx | 3-of-5 federation |
| Stockpile T_MINT refill | When stockpile below threshold | Single multisig tx | 3-of-5 federation |

The reserve multisig is touched only by federation-coordinated
operations, not by every user fill. Federation member coordination
typically takes hours-to-a-day (geographically distributed signers
exchanging PSBT), so all federation operations are designed to be
*infrequent and batched* relative to user fills.

**Single-UTXO vs multi-UTXO reserve:** the reserve address MAY hold
its backing as a single large UTXO or as a small number of UTXOs.
A single-UTXO design means each federation operation spends and
recreates the entire reserve in one tx — simple but means parallel
federation operations are serialized through mempool. Multi-UTXO
design allows concurrent federation operations at slightly higher
operational complexity. Reference design uses **single-UTXO** for
simplicity since federation operations are infrequent.

### 3.4 CSV escape mechanics

After 26280 blocks of no reserve-UTXO movement, the escape path
activates. The escape leaf requires a single Schnorr signature
under `<EscapeMultisig_xonly>` — a MuSig2 aggregation of holder
pubkeys.

**Coordination protocol (off-chain):**

1. Affected cBTC holders aggregate their pubkeys into a MuSig2 key
   via the standard nonce-share + key-share protocol.
2. The aggregated pubkey is what `<EscapeMultisig_xonly>` evaluates
   to in the escape leaf script. **But the escape leaf bytes are
   fixed at CETCH publish time**, so the escape MuSig2 pubkey must
   be known at issuance.

This is the **achievable v1 design** but limits the escape to
holders who declared their participation pre-issuance. Realistic v1
escape: the operator publishes the *escape multisig membership*
alongside the CETCH metadata (a fixed set of 5-7 holder-volunteers
who agree to coordinate recovery if needed). The escape isn't
guaranteed to recover *all* held value; it recovers value to the
declared escape participants who then redistribute manually.

A future amendment with covenants (BIP-119 OP_CTV) could enforce
"escape sends to all current holders pro-rata via a covenant-locked
distribution tx" — trustless but currently impossible.

For V1 ship: the escape is a **last-resort coordination primitive,
not a perfect recovery mechanism**. Document this prominently in
the cBTC.tac landing page. Users with very large holdings should
either (a) participate in the escape multisig, (b) prefer competing
variants with different escape designs, or (c) treat cBTC.tac as
"federation must continue operating" — same trust profile as
typical wrapped-BTC products.

---

## 4. Worker design

Two daemon processes maintain the user-facing market:

### 4.1 Auto-mint-lister

**Purpose:** keep one standing T_AXFER_VAR atomic intent open at
all times, advertising "selling up to N cBTC.tac for sats at par +
10 bps."

**Intent parameters (price math at intent level, not per-base-unit):**

- `asset_utxo` = current stockpile UTXO (pre-T_MINTed cBTC.tac held
  at the operator hot wallet).
- `amount` (the listed UTXO amount) = stockpile_balance — the
  maximum cBTC.tac that can be filled from this intent.
- `min_take_amount` = `redemption.min_request_units` (see §2; we
  set this to a value that makes per-fill economics workable —
  see §4.4 *Per-fill economics*).
- `price_sats` (total) = `ceil(amount × (10000 + fee_bps) / 10000)`.
  Example with `fee_bps = 10`: a 100,000,000 stockpile lists at
  `ceil(100,000,000 × 10010 / 10000)` = **100,100,000 sats**.

Per the T_AXFER_VAR convention (§5.7.6.1 *Bounded recipient amount*),
a taker requesting `A` base units pays:

```
payment_sats = floor(A × price_sats / amount)
             = floor(A × 100,100,000 / 100,000,000)
             = floor(A × 1.001)
```

So a 1,000,000-base-unit (~$5 worth) take pays 1,001,000 sats (10
bps fee captured). A 1,000-base-unit (~$0.005) take pays 1,001 sats
(10 bps still captured at this scale). For very small takes near
the `floor()` rounding boundary, some fee is lost to rounding — the
maker explicitly accepts this when posting the intent (§5.7.6.1
*Bounded recipient amount*).

**Lifecycle:**

1. On startup, fetch current stockpile UTXO. Construct intent with
   parameters above. Publish to worker.
2. When a taker claims with `requested_amount A`:
   - Construct T_AXFER_VAR commit + partial reveal per §5.7.6.1
   - Post fulfilment to worker
   - Wait for taker completion + worker broadcast + confirmation
3. On settlement confirmation:
   - The stockpile UTXO is spent; `vout[2]` is the new stockpile
     UTXO with `(stockpile − A)` base units.
   - Hot wallet has gained `payment_sats` BTC at `vout[1]`.
4. Re-publish intent with the new stockpile UTXO + remaining
   `amount`. Goto 2.

**Stockpile refill:** when stockpile drops below a threshold
(e.g., 25% of pre-mint quantity, or estimated 3 days of throughput),
the auto-mint-lister alerts the federation. Federation members
coordinate to sign a `T_MINT` event minting additional cBTC.tac
against the multisig's `mint_authority` (which is the reserve
multisig itself — see §2 metadata). This requires 3-of-5 sigs,
typically takes hours to a day. To avoid mint-stockpile depletion
during the coordination window, the operator pre-mints **at least
2× the alert threshold**; e.g., if alert fires at 3 days remaining,
the operator wants ≥6 days of buffer at refill time. Reference
design starts launch with **30 days** pre-minted stockpile, alerts
at 7 days, refills to 30 days.

### 4.2 Auto-burn-taker

**Purpose:** monitor the marketplace for users selling cBTC.tac and
take any sell intent priced at par − 10 bps or better.

**Behavior:**

- Poll the worker's atomic-intent listings for cBTC.tac sell intents.
- For each intent: parse the per-unit price; if `price_sats per
  cBTC.tac base unit ≥ (10000 − fee_bps) / 10000`, the intent is
  takeable.
- For variable-amount intents (T_AXFER_VAR), compute the maximum
  request size that:
  - The hot-wallet has sats to cover: `requested ≤
    hot_wallet_sats_balance / price_per_unit`
  - Doesn't exceed user-imposed cap: `requested ≤ intent.max_amount`
- Submit a claim with the chosen `requested_amount`.
- On worker `COMMIT_READY` callback (maker, i.e. the user, has
  posted fulfilment): verify the fulfilment, complete the reveal
  with funding inputs, submit to worker for broadcast.
- On settlement confirmation: the cBTC.tac received goes back into
  the stockpile (offsetting future mints — effectively, burns are
  re-minted to the next minter, conserving total supply).

**Reserve credit:** when burns net-exceed mints over a period, the
hot-wallet sats balance grows. Excess sats are periodically swept
back to the reserve multisig (the inverse flow of stockpile
refill). Manual federation step, daily/weekly.

### 4.3 Hot-wallet vs reserve separation

The operator runs two distinct wallets:

| Wallet | Purpose | Key control | Balance (default) |
|---|---|---|---|
| **Hot wallet** | Auto-lister + auto-taker operations | 2-of-3 (operator + 1 federation + auto-signer) | ~1 day of expected throughput (see open question #2) |
| **Reserve multisig** | Long-term backing for all outstanding cBTC.tac | 3-of-5 federation | Full backing minus hot-wallet float |

The hot wallet **MUST NOT** hold reserves declared in the CETCH
metadata's `reserve_address` field — only the reserve multisig
does. The hot wallet is operating capital; its balance is **not
counted** in coverage calculations.

**Hot-wallet key protection** (mitigations against single-point-of-
failure on the hot-wallet signer):

- **2-of-3 multisig hot wallet** (reference default). Quorum:
  operator key (online) + 1 federation member (delegated to a
  responsive signer with HSM backing) + 1 auto-signer (HSM-protected
  worker that signs only ratified intents per policy). Compromise of
  any single key does not drain funds; compromise of both operator
  and auto-signer requires breaking 2 systems.
- **HSM/hardware-key protection** for each hot-wallet key. No raw
  private keys in worker memory.
- **Aggressive sweep frequency.** Hot wallet sweeps to reserve
  multisig hourly or when float exceeds a threshold (e.g., $5k
  USD-equivalent), whichever is sooner. Minimizes at-risk balance.
- **Per-tx cap.** Auto-signer policy refuses to sign individual
  outflows above a configurable cap (e.g., $1k). Forces large
  outflows through manual federation review.

This means: if the hot wallet is fully drained (every signer
compromised simultaneously), mints/burns stop but **outstanding
cBTC.tac holders are still fully backed** by the reserve multisig.
Coverage stays ≥ 1.0 because the supply hasn't grown beyond what's
in the reserve.

Hot-wallet compromise of a SINGLE signer is recoverable: the
federation rotates that signer's key (no chain action required —
the multisig threshold address has been derived with the full set
of pre-declared rotation candidates; rotation is a tap-tree leaf
selection). The compromised key's signature can no longer combine
to reach quorum.

**Loss bound** at any moment ≈ current hot-wallet balance ≤ 1 day
of throughput. At $100k/day throughput with $5k float cap, that's
$5k max exposure. Acceptable for a custody-trusted federated wrap.

### 4.4 Per-fill economics

Each T_AXFER_VAR settlement (mint or burn) costs **~550 vbytes** on
chain (commit ~150 vbytes + reveal ~400 vbytes). At typical mainnet
fee rates of 10–50 sat/vB, this is **5,500–27,500 sats per fill**.

Per-fill economics, in sats:

| Mint size | BTC fee @ 10 sat/vB | Fee as % of value |
|---|---|---|
| 1,000 (~$0.50) | 5,500 | **550%** (uneconomic) |
| 10,000 (~$5) | 5,500 | 55% (still uneconomic) |
| 100,000 (~$50) | 5,500 | 5.5% (tolerable for users who really want this size) |
| 1,000,000 (~$500) | 5,500 | 0.55% (reasonable) |
| 10,000,000 (~$5,000) | 5,500 | 0.055% (efficient) |

**Implication for `min_request_units`:** the spec-level minimum of
1000 sats is technically valid but uneconomic for users. The
reference cBTC.tac sets **`min_request_units = 100,000`** (~$50)
as the operational minimum so the per-fill Bitcoin fee stays below
~5% of value. Issuers MAY set a higher minimum if they want to
guarantee lower fee percentages; lower minimums work in principle
but the UX warns users that small fills are fee-dominated.

Higher-fee-rate environments make the minimum more painful. The
operator's auto-lister monitors current mempool fee rates and
adjusts `min_request_units` dynamically:

```
operational_min_request_units = max(
  min_request_units (from metadata),    // floor — anything below is refused
  bitcoin_fee_per_fill / 0.05            // floor of 5% fee-vs-value ratio
)
```

At 50 sat/vB (busy mempool): fee = 27,500 sats; min ~ 550,000 sats
(~$300) to stay under 5%. The dapp surfaces this in real-time.

For comparison: legacy wrapped-BTC products on Ethereum L2 have
per-fill costs of $0.50–5.00 — significantly cheaper. cBTC.tac
trades Bitcoin-L1 settlement guarantees for per-fill cost. Users
choose based on what matters more.

---

## 5. Attestation publishing

Daily (every 144 blocks):

1. Compute current `reserves_balance` from chain (sum of multisig
   UTXOs).
2. Compute current `supply` from tacit indexer state (cumulative
   T_MINT amounts − cumulative T_BURN amounts for asset_id).
3. Construct `attestation_msg` per `tacit-wrapper-attest-v1`
   (§4.2.4 of the wrapper convention).
4. Sign with the operator's `issuer_pubkey` (a key separate from
   the multisig keys and the hot-wallet key — pure attestation
   signing).
5. Publish to:
   - The operator's website / dashboard (canonical)
   - IPFS (content-addressed, durable)
   - Optionally: an on-chain T_WRAPPER_ATTEST envelope (extra
     liveness signal, ~$1-2/day at 10 sat/vB)

**Schedule discipline:** miss a daily attestation, and the
indexer's freshness factor begins decaying (per the SPEC
amendment's freshness formula). After 3× the schedule (432 blocks
late), routing weight reaches zero. Operator dashboards SHOULD
alert when an attestation is ≥1 day overdue.

**Attestation key compromise:** if `issuer_pubkey` is compromised,
the attacker can publish fake attestations. Mitigation: the
attestation only signals liveness — coverage verification remains
cryptographic from chain. A fake attestation claiming high
coverage is refuted by anyone checking chain. The operator
rotates `issuer_pubkey` via a new CETCH metadata pinning
(content-addressed, generates a new asset_id — see §6).

---

## 6. Key rotation procedures

### 6.1 Hot-wallet key rotation (routine)

- Generate new hot-wallet key offline.
- Federation signs a tx moving hot-wallet sats from old key to new.
- Update worker config to use new key.
- Re-publish auto-lister intent under new key.

No CETCH change required. Hot-wallet key is operational and not
in metadata.

### 6.2 Attestation key rotation (semi-routine)

- Generate new `issuer_pubkey` offline.
- Federation publishes a CETCH metadata update — but wait, CETCH
  metadata is content-addressed by `metadata_cid`. Updating
  metadata changes the CID, which changes the asset_id.

**This is the core constraint:** CETCH `asset_id = SHA256(reveal_txid
|| 0_LE)` is bound to the *original* metadata via `metadata_cid`.
The metadata cannot be updated in place.

Two real options:

**(a) Hard rotation — new asset_id.** Publish a *new* CETCH
(`cBTC.tac.v2`) with the new attestation key. The old `cBTC.tac`
asset_id remains in circulation; the operator continues honouring
redemptions on it but stops issuing new mints. Users gradually
migrate by burning old + minting new. Painful UX but correctly
sound.

**(b) Soft rotation — out-of-band publication.** Operator publishes
a new attestation key signed by the old key in a deprecation
notice. Indexers update their "current attestation key" record by
following the chain of attestation-key signatures. The CETCH
metadata's `attestation.issuer_pubkey` becomes the
*genesis* attestation key; subsequent rotations are appended chains.

Soft rotation requires an addendum to the wrapper convention — not
spec'd in v1. **For v1, cBTC.tac uses hard rotation if needed.**
This argues for the issuer_pubkey being a *strong* key (hardware-
backed, multi-party-derived, long-lived).

### 6.3 Multisig member rotation (governance)

Two distinct rotation paths, mirroring Liquid Federation's design:

**(a) On-chain "hard" rotation** — changing the multisig pubkeys
themselves. Required when a key is lost (member can no longer
sign) or compromised (need to remove the leaked key).

1. Generate the new member's signing key offline.
2. 3-of-5 of the current members sign a tx that moves all reserve
   UTXOs to a NEW Taproot address constructed with the updated
   member set.
3. Update the CETCH metadata's `reserve_address` field.
4. Since CETCH metadata is content-addressed by `metadata_cid`,
   updating means: publish a new CETCH with a new asset_id (e.g.,
   `cBTC.tac.v2`). The old `cBTC.tac` continues to be honored for
   burns but no new mints; users migrate by burn-then-remint.

Painful UX, so hard rotation is reserved for forced events (key
loss / compromise).

**(b) Off-chain "soft" rotation** — keeping the multisig pubkeys
fixed but changing who *operates* them. This is the common case for
governance-routine member changes (annual rotation of community-
aligned seat, etc.).

The CETCH metadata records "institutional" identities:

```
"member_3": {
  "pubkey": "02ab... (fixed for lifetime of asset_id)",
  "beneficial_holder": "Community-Aligned Member (rotating)"
}
```

The pubkey is fixed. The beneficial holder (the person or org
actually responsible for that key) can change via off-chain
delegation: outgoing holder transfers the key material (HSM,
signing infrastructure) to incoming holder under a signed governance
record. Public attestation of the rotation (issuer-pubkey-signed
announcement) goes on the dashboard.

Trust assumption: the beneficial holders behave honestly during
handover. If an outgoing holder doesn't properly destroy their copy
of the key, they retain signing power — this is a real risk that
mitigation depends on hardware-key separation (HSM doesn't expose
private key bytes; rotation rotates *which* HSM is in the signing
set, not the key bytes).

For V1 cBTC.tac: most rotations expected to be type (b). Hard
rotations only for emergency key compromise. Community-aligned seat
holder rotates via type (b) — the same multisig pubkey continues
across multiple beneficial holders.

V1 documentation of the federation membership distinguishes:
- **CETCH-recorded multisig pubkeys**: the on-chain identities.
  Stable for the lifetime of the asset_id (subject to type-(a)
  hard rotation only on key compromise).
- **Beneficial members**: the people/orgs who hold those keys at a
  given time. Rotate via type-(b) off-chain delegation. Public
  dashboard tracks current beneficial holders + history of changes.

---

## 7. Reserve dashboard

A public dashboard at `cbtc.tac.io` (or equivalent) surfaces:

- **Current reserves balance** (sats at `reserve_address`, queried
  from chain every block).
- **Current cBTC.tac supply** (queried from tacit indexer).
- **Coverage ratio** (live).
- **Latest attestation** (timestamp + signature + verification
  status).
- **Hot-wallet status** (auto-lister liveness, auto-taker liveness).
- **Federation member list** (with key fingerprints + verification
  links to each member's PGP identity / Twitter / etc.).
- **Multisig escape clock** (countdown to CSV unlock if reserves
  haven't moved).
- **Historical activity log** (mint events, burn events, attestation
  history, federation changes).

The dashboard is operational transparency — it doesn't add trust
(coverage is verifiable from chain by anyone), but it makes the
trust-verifying easier for non-technical users.

---

## 8. Failure modes (operational runbook)

| Failure | Detection | Recovery |
|---|---|---|
| **Auto-lister offline (no mint intent posted)** | Worker observability + dashboard health-check | Restart worker; investigate logs. Users can't mint until restored; existing supply unaffected. |
| **Auto-taker offline (burn intents linger)** | Same as above | Same. Users may have to wait or use competing variants. |
| **Hot-wallet sats depleted** | Worker logs "insufficient funding" | Federation tops up hot wallet from reserves (one multisig spend). |
| **One federation member unreachable** | 3-of-5 still meets quorum | No immediate impact. Plan rotation if persistent. |
| **Two federation members unreachable** | 3-of-5 quorum at risk; 3 remaining must coordinate carefully | Pause mints temporarily; plan rotation. |
| **Three+ federation members unreachable** | Cannot sign multisig transactions | Reserves locked. After 26280 blocks, holder-coordinated CSV escape activates. Communicate publicly. |
| **Reserve multisig key compromise (1 key)** | Federation detection + monitoring | Rotate the compromised member (hard rotation: new asset_id, gradual migration). |
| **Reserve multisig key compromise (3+ keys)** | Reserves drained | Catastrophic. All outstanding cBTC.tac unbacked. Coverage drops to 0. cBTC.tac depegs. Holders migrate to competing variants. Public post-mortem. |
| **Hot-wallet key compromise** | Hot-wallet sats drained | Rotate hot-wallet key (routine). Supply unaffected. |
| **Attestation key compromise** | Fake attestations published | Coverage verification still works from chain; fake attestations refutable. Rotate attestation key (hard rotation, see §6.2). |
| **Worker (off-chain coordination) compromised** | Tampered intent listings | Settlement is atomic on-chain — worker can't substitute amounts or recipients without breaking sigs. Outstanding intents may be censored; users use alternate workers. |
| **Mass redemption ("bank run")** | Hot-wallet drained quickly + auto-taker can't keep up | Federation tops up hot-wallet; users may experience temporary spreads as auto-taker prices defensively. cBTC.tac may trade at slight discount during high-burn periods. Coverage stays ≥ 1.0 as long as reserves are honored. |

---

## 9. Launch checklist

Before the first cBTC.tac mints:

- [ ] Federation members selected; identities published.
- [ ] 5 multisig signing keys generated offline (hardware-backed:
  Ledger Nano / Coldcard / Specter DIY).
- [ ] Multisig Taproot address constructed with both leaves:
  3-of-5 primary, CSV-escape secondary.
- [ ] Escape-leaf MuSig2 participant set established (5-7 holder
  volunteers).
- [ ] Operator hot-wallet key generated.
- [ ] Issuer attestation key generated (separate from above).
- [ ] CETCH metadata blob assembled with all production values;
  pinned to IPFS; CID recorded.
- [ ] Initial CETCH transaction broadcast; asset_id derived from
  reveal_txid.
- [ ] Pre-mint stockpile minted via T_MINT (federation 3-of-5
  signed via MuSig2 aggregation); **30 days** expected throughput
  (see §4.1 refill cadence). Pre-launch throughput estimate is
  necessarily uncertain; over-provision the initial stockpile and
  burn excess (T_BURN) after 30 days if actual demand is lower.
- [ ] Auto-mint-lister + auto-burn-taker workers deployed.
- [ ] Reserve dashboard live with chain-queries against the new
  reserve_address.
- [ ] First daily attestation published (off-chain + optionally
  on-chain).
- [ ] AMM pool seeded (post-ceremony work; deferred until ceremony
  completes).
- [ ] Public communication: announcement, federation member list,
  custody design doc, support channel.
- [ ] Monitoring + alerting: stockpile-low, attestation-late,
  worker-down, multisig-unmoved-but-tx-pending.
- [ ] Signet rehearsal complete: full mint + burn + recovery cycle
  exercised end-to-end with synthetic data.

---

## 10. Comparison with existing wrapped-BTC products

| Property | cBTC.tac (this design) | wBTC (BitGo) | tBTC (Threshold) | Liquid L-BTC |
|---|---|---|---|---|
| Custody | 3-of-5 federation | 1 custodian (BitGo) | t-of-n threshold network | 11-of-15 federation |
| Reserve transparency | Chain-observable, daily attest | Custodian audit reports | Chain-observable | Federation publishes |
| Atomic mint/burn | Yes (T_AXFER_VAR) | No (multi-step) | Yes (chain swap) | Yes (peg-in/out) |
| Holder escape | CSV unlock @ 6mo | None (custodian or bust) | t-of-n threshold | None |
| Permissionless competing variants | Yes (open convention) | No | No | No |
| Settlement | Bitcoin L1 | Ethereum L2 | Ethereum L1 + BTC | Liquid sidechain |
| Open-source operator code | Yes (this doc + worker repo) | Closed | Yes | Yes |

cBTC.tac's positioning: **wBTC's atomic settlement, tBTC's
transparency, Liquid's federation pattern, with permissionless
competing variants on top.** Not strictly more decentralized than
tBTC; strictly more transparent than wBTC; strictly more
Bitcoin-native than any L2-hosted wrap.

---

## 11. Open questions for operational review

1. **Federation member selection criteria.** Who specifically?
   Public process or operator's discretion? Should there be a
   formal vetting procedure?

2. **Hot-wallet float sizing.** Reference default (§4.3) is **1
   day** of expected throughput with hourly sweep to reserves. This
   minimizes at-risk balance from operator-key compromise (capped at
   ~1 day's revenue + un-swept hour's mint flow). Alternative: 7-day
   float reduces sweep frequency (one federation operation per week
   instead of per day) at the cost of 7× max exposure. Open
   question is whether the operational simplicity of weekly sweeps
   outweighs the additional exposure. For V1 launch, recommend
   1-day float with hourly sweep; revisit after 90 days of
   production telemetry.

3. **Pre-mint stockpile policy.** Mint 100% of expected lifetime
   supply up-front? Or refill in tranches? Up-front means lower
   coordination overhead; tranches mean less pre-committed
   capital.

4. **Geographic distribution of federation members.** All in one
   jurisdiction is operationally simple but creates single
   regulatory failure point. Spread across 3+ jurisdictions for
   resilience but complicates legal coordination.

5. **Insurance.** Should there be a treasury-backed insurance fund
   that covers losses up to some threshold? Could be funded by a
   small portion of the 10bps redemption fee.

6. **Audit cadence.** Annual external audit of the operational
   procedures + reserve verification? Quarterly? Self-audit
   only?

7. **Sunset criteria.** When does cBTC.tac wind down? Migration
   path for outstanding supply when a competing variant becomes
   clearly better.

---

*End of operational design doc.*
