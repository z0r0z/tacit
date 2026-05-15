# SPEC §6 Amendment — Protocol Oracle, Canonical cUSD, Canonical cBTC

> Adds three load-bearing protocol layers, in dependency order:
>
> 1. **§6.1 Protocol-level price oracle** — open-membership LP-staked
>    threshold-signing attesters publishing price feeds via a new
>    opcode `T_PRICE_ATTEST` (`0x39`). Verifiable computation, slashable.
> 2. **§6.2 Canonical cBTC** — protocol-native 1:1 sat wrapper via
>    user-locked DLCs with the oracle threshold as co-signer. No
>    federation, no custody trust at trade time. Asset_id derived
>    canonically; one cBTC across the protocol.
> 3. **§6.3 Canonical cUSD** — MakerDAO-on-Bitcoin: user locks sats in
>    a DLC, mints cUSD against oracle-priced collateral, liquidatable
>    via pre-signed adaptor outcomes. The first oracle-priced wrapper
>    using the convention's `peg.kind = "oracle_priced"` placeholder.
>
> **Scope of unchanged behavior.** Every existing opcode, every
> existing asset, every existing AMM pool, every existing T_AXFER
> intent — all validate identically before and after. This amendment
> ADDS infrastructure; it doesn't change anything that exists.

---

## Motivation

The wrapper convention (§4.2 / `SPEC-WRAPPER-AMENDMENT.md`) lets
anyone CETCH a wrapper-tagged asset and self-custody reserves. That's
permissionless and works for 1:1 federated wrappers like
`cBTC.tac`. But two gaps remain:

1. **Federated cBTC requires trusting an issuer.** Even with
   transparent reserves + atomic-at-trade settlement, the federation
   can rugpull. The wrapper convention can't fix this without
   covenants — but a **DLC-based per-user-collateral pattern** can.
2. **Stablecoins (oracle-priced wrappers) need a price oracle.** The
   convention reserves `peg.kind = "oracle_priced"` but doesn't
   specify the oracle. Without one, no synthetic cUSD-style asset is
   buildable on tacit.

This amendment closes both gaps with **one shared piece of
infrastructure**: a protocol-level price oracle plus DLC machinery
that lets users mint canonical wrappers against their own sats
without trusting any federation.

The resulting cUSD is **MakerDAO on Bitcoin**, in spirit: each
holder's cUSD is backed by their own locked sats; liquidation is
oracle-priced and keeper-driven; the protocol takes a small
stability fee that flows to LP-staked oracle attesters as their
slashable-bond yield.

The resulting cBTC is **trustless wrapped Bitcoin**, in the sense
that each cBTC unit is backed by sats locked under a DLC where the
user is one of the two signers — no party can move the sats without
the user's cooperation, and the user can always self-redeem after
the CSV timeout if the oracle goes offline.

---

## §6.1 Protocol-level price oracle

### 6.1.1 Architecture

The oracle is a **threshold-Schnorr-signing attester set** that
publishes (asset_pair, price, height) tuples via a new opcode
`T_PRICE_ATTEST` (`0x39`). The attestation chain feeds DLC
adaptor-secret release for cUSD CDP settlements, wrapper-convention
coverage checks for oracle-priced pegs, and any future protocol
component that needs a chain-verifiable price.

Three properties define the oracle:

1. **Open membership.** Any LP holding ≥ `min_oracle_bond_bps` of
   the total `cUSD/cBTC` AMM pool TVL can apply to join the
   attester set. No whitelist, no approval gate.
2. **Verifiable computation.** Each attester independently computes
   `median_TWAP(asset_pair, window)` from public chain data and
   signs a threshold share. Dishonest signatures are *provably
   wrong* against the deterministic function; bond is slashed.
3. **Permissionless rotation.** The attester set rotates every
   epoch (1008 blocks ≈ 1 week). Joiners post bond and sign for
   the upcoming epoch's DKG; leavers withdraw bond after a
   cooling-off period (next epoch boundary).

### 6.1.2 Attester eligibility and bond

To become an attester for epoch `E`, a candidate must:

1. Hold ≥ `min_oracle_bond_lp_shares` units of LP shares in the
   **canonical `cUSD/cBTC` pool** specifically (i.e., the AMM pool
   identified by `pool_id = SHA256("tacit-amm-pool-v1" ||
   min(canonical_cbtc_asset_id, canonical_cusd_asset_id) ||
   max(canonical_cbtc_asset_id, canonical_cusd_asset_id))`).
   `min_oracle_bond_lp_shares` is dynamically computed as 1% of
   that pool's `lp_total_shares` at the time of T_ORACLE_JOIN.

   **V1 scope: canonical-pool-only bond.** Federated cBTC variant
   pools (e.g., `cBTC.tac/cUSD`) feed the oracle's TWAP **price
   computation** (§6.1.3) but do NOT qualify as bond collateral.
   This keeps V1's attester accounting simple (one lp_asset_id,
   one bond UTXO per attester). Future amendments may extend
   bond eligibility to wrapper-variant LP shares with appropriate
   value-conversion rules.
2. Lock those LP shares under a **bond UTXO** at a protocol-derived
   address: `bond_addr = SHA256("tacit-oracle-bond-v1" || pubkey)`.
   The LP shares cannot be spent for the duration of the
   attester's epoch participation + cooling-off.
3. Sign an `T_ORACLE_JOIN` envelope (opcode `0x3A`) declaring their
   public attester key and the bonded LP-share UTXO outpoints.
4. Wait until the next epoch boundary. Joiners are queued; the
   active set is fixed for the duration of the current epoch.

At the epoch boundary, the active attester set transitions:

- **Joiners** (signed T_ORACLE_JOIN in the previous epoch) become
  active.
- **Leavers** (signed `T_ORACLE_LEAVE` envelope at any point during
  the previous epoch) become eligible to withdraw bond at the
  *next* epoch boundary (one full epoch cooling-off).

The active set runs a **FROST distributed key generation (DKG)**
at the epoch boundary, producing:

- `attester_aggregate_key` (x-only) — used to verify all
  threshold-signed attestations for this epoch.
- Individual signing shares held by each active attester.

Threshold: `t = ceil(2/3 × |active_set|)`. Two-thirds quorum
prevents a minority from publishing a divergent attestation;
prevents a single attester from blocking attestations.

### 6.1.3 Price computation (deterministic)

Each attester computes prices identically as a function of public
chain state. The pool universe is enumerated from the indexer's
**combined wrapper-registry + AMM-pool view**:

```
function pools_for(asset_pair):
  // asset_pair is the hash SHA256("tacit-oracle-pair-v1" || A || B)
  // where A < B lexicographically; for BTC/USD, A = canonical_cbtc,
  // B = canonical_cusd by canonical lex-ordering.
  variants_a = wrapper_registry.variants_for(A)
               // = { canonical_cbtc } ∪ { cBTC.tac, cBTC.federation_X, … }
               // — all wrapper-tagged assets whose underlying matches A's
               // (chain, asset) tuple per the wrapper convention §4.2.
  variants_b = wrapper_registry.variants_for(B)
               // For canonical cUSD: includes canonical_cusd plus any
               // future cUSD.* wrapper-tagged variants.
  result = []
  for asset_a in variants_a:
    for asset_b in variants_b:
      pool_id = SHA256("tacit-amm-pool-v1" || min(asset_a, asset_b)
                                            || max(asset_a, asset_b))
      if amm_state.pool_exists(pool_id):
        result.append(pool_id)
  return result

function median_twap(asset_pair, window_blocks, end_height):
  pools = pools_for(asset_pair)
  prices_per_block = []
  for h in (end_height - window_blocks + 1) .. end_height:
    block_prices = []
    for pool_id in pools:
      pool = amm_state.pool_at_block(pool_id, h)
      if pool.tvl_at_block_in_sats >= min_pool_tvl_for_oracle:
        block_prices.append((pool.spot_price, pool.tvl_at_block_in_sats))
    if len(block_prices) > 0:
      // TVL-weighted median across pools at block h
      prices_per_block.append(weighted_median(block_prices))
  // Time-weighted across the window
  return weighted_median(prices_per_block, weights=block_weight)
```

**Indexer retention requirement.** Indexers serving as oracle
sources or oracle verifiers MUST retain pool state for at least
`max(window_blocks, 1008)` blocks. With V1 defaults
(`window_blocks = 144`, epoch = 1008), the retention horizon is
1008 blocks (~1 week). Pool state for older blocks may be
discarded; the indexer can re-derive it on demand from chain
history if needed.

Where:

- `window_blocks` defaults to **144** (~24 hours).
- `min_pool_tvl_for_oracle` defaults to **10,000 sats** equivalent.
  Pools below this don't contribute (resistance against tiny-pool
  manipulation).
- `weighted_median` is the standard "median weighted by pool TVL"
  computation: sort entries by price, walk weights, return the
  price whose cumulative weight crosses 50%.

The function is **deterministic from public chain state**. Two
honest attesters compute the same number to the bit. Any attester
who signs a different number is provably wrong.

### 6.1.4 T_PRICE_ATTEST envelope (opcode `0x39`)

```
T_PRICE_ATTEST(2)
   envelope_version  0x01
   opcode            0x39
   network_tag       1 byte
   epoch             4 bytes (u32; epoch number)
   asset_pair        32 bytes (SHA256("tacit-oracle-pair-v1" || asset_id_A || asset_id_B)
                                where A < B lexicographically)
   price_num         8 bytes  (u64 LE; integer numerator of price ratio)
   price_den         8 bytes  (u64 LE; denominator)
   window_blocks     4 bytes  (u32; TWAP window used)
   end_height        4 bytes  (u32; bitcoin block height of attestation)
   band_index        1 byte   (u8; encoding:
                                  0..N-1  → liquidation band; releases adaptor secret
                                            for the matching cUSD CDP outcome
                                  254     → cUSD self-redeem observation event;
                                            releases adaptor secret for leaf-1
                                            (full self-burn) outcome
                                  255     → informational only; no adaptor secret
                                            released (default for cBTC, which has
                                            no adaptor-sig outcomes))
   nonce_commit_root 32 bytes (root of merkle tree over per-band attester
                               nonce commitments for this epoch; lets observers
                               verify which band-secret is being released)
   participating_count 1 byte (number of attesters in the threshold sig; 1..32)
   participating[]   32×count bytes (x-only pubkeys of participating attesters,
                                     sorted ascending — fixes the slash target set)
   threshold_sig     64 bytes (BIP-340 over attestation_msg under aggregate of
                               participating attesters)
```

Variable size: `161 + 32 × participating_count` bytes (sum:
envelope_version 1 + opcode 1 + network_tag 1 + epoch 4 +
asset_pair 32 + price_num 8 + price_den 8 + window_blocks 4 +
end_height 4 + band_index 1 + nonce_commit_root 32 +
participating_count 1 + threshold_sig 64 = 161 fixed). For t=15
attesters (typical): 161 + 480 = **641 bytes**. Still small
enough to fit in a single commit-reveal pair.

**`participating_count` MUST be in the range 1..32 in V1.**
Values outside this range are reserved; indexers MUST reject
envelopes carrying `participating_count == 0` or
`participating_count > 32`. The cap keeps envelopes within
typical witness-size budgets and bounds the slashing-target
enumeration cost.

```
attestation_msg = SHA256(
    "tacit-oracle-price-v1"
    || network_tag(1)
    || epoch_LE(4)
    || asset_pair(32)
    || price_num_LE(8) || price_den_LE(8)
    || window_blocks_LE(4)
    || end_height_LE(4)
    || band_index(1)
    || nonce_commit_root(32)
    || participating_count(1)
    || participating[](32 × count)
)
```

**u64 price representation.** u64 is sufficient for any realistic
BTC/USD price ratio with reasonable decimal precision. A future
amendment can widen to u128 if higher-precision asset pairs need
it (e.g., satoshi-precision stablecoins for low-cap assets).

**band_index for adaptor secret release.** When a price falls into
liquidation band K, the attestation signs with
`band_index = K`. The threshold signing uses the pre-committed
nonce R_K (from this epoch's nonce_commit_root). The published
signature reveals the discrete log of R_K combined with the
attested data — this is the **adaptor secret** for outcome K.
Anyone observing the attestation can derive the secret and complete
the matching cUSD liquidation tx (see §6.3.4). When
`band_index = 254`, the secret released is for cUSD's leaf-1 (full
self-redeem) outcome — a separate epoch-level nonce slot reserved
for redemption events. When `band_index = 255`, the attestation
is purely informational (no adaptor secret to release — default
for cBTC, which has no price-conditional outcomes).

**Per-epoch adaptor-commit lifecycle (load-bearing for CDP open).**
At epoch start, the FROST-DKG output includes not only the
`attester_aggregate_key` but also per-band **adaptor-point
commitments**:

```
nonce_commit_root = MerkleRoot([
   S_0, S_1, ..., S_{N-1},      // one per liquidation band (V1: N=20)
   S_254,                        // cUSD self-redeem reservation
   S_255_unused (placeholder)    // informational/no-release reservation
])
```

Each `S_k = s_k·G` is the curve-point commitment to the scalar
`s_k` the oracle threshold collectively commits to reveal when
band K's attestation event fires during this epoch. Adaptor
pre-signatures bound to `S_k` complete once `s_k` is revealed.
The name `nonce_commit_root` is retained for backwards
compatibility with prior drafts; the values stored at the leaves
are adaptor points S_k, not FROST nonces R.

The key property: **per-band adaptor points are per-epoch, not
per-CDP**. The oracle threshold commits to one **adaptor point**
`S_k = s_k·G` per band K per epoch at DKG; these S_k points are
reused as adaptor points across every CDP opened in that epoch.
(S_k is the curve point of the **would-be attestation signature
scalar** for band K — not the nonce point R that the FROST
signing round uses. The distinction is load-bearing: reusing a
nonce R across different message hashes leaks the private key,
but reusing the same S as an adaptor point across different
adaptor pre-signatures is safe by the discrete-log assumption.)

CDP open still requires the oracle threshold to produce a
**per-CDP adaptor pre-signature** for each band's outcome tx
(since each CDP's outcome tx sighash is unique — different
`dlc_outpoint`, different vouts). The pre-signature is an oracle
threshold sig over outcome_tx_K's sighash, adaptor-encrypted under
S_k via a fresh per-CDP FROST nonce `R'_K` (distinct from S_k).
Producing N pre-signatures (N = N_BANDS = 20 in V1) requires N
FROST signing rounds at CDP open. Operationally:

- Per-CDP-open cost: ~N FROST signing rounds (parallelizable;
  practical at typical CDP open frequencies of <1 per minute).
- Per-epoch cost: 1 FROST DKG run producing per-band adaptor
  points `S_0..S_{N-1}, S_254`, `attester_aggregate_key`, and
  the `nonce_commit_root` Merkle commitment.
- Per-attestation cost: 1 FROST signing round per published
  T_PRICE_ATTEST (every 6 blocks per active pair). Attestations
  use their own fresh nonces; the **attested scalar `s_k`** for
  the band-K event is derived from the published threshold sig
  alongside its message hash and the FROST aggregate key.

When the oracle later attests band K via T_PRICE_ATTEST, the
threshold sig over the attestation message **reveals the scalar
s_k** (the discrete log of the pre-committed adaptor point S_k).
Anyone observing the attestation derives s_k, completes every
CDP's K-th outcome tx pre-signature (adaptor-encrypted under
S_k), and broadcasts the matching outcome tx.

**Adaptor sig construction.** Implementations MUST follow a
validated single-extract DLC adaptor scheme such that:

1. The oracle's per-epoch DKG produces both an aggregate
   threshold key AND per-band adaptor commitments `S_k = s_k·G`,
   where `s_k` is the discrete log the oracle commits to reveal
   when (and only when) band K's attestation event fires.
2. Per-CDP outcome tx pre-signatures are constructed under the
   oracle aggregate key, using a fresh per-CDP nonce `R'_K` and
   adaptor-encrypted under `S_k`. Completing a pre-signature
   requires `s_k`.
3. The band-K attestation publishing event reveals `s_k`
   atomically (e.g., the attestation's threshold-sig structure
   binds the attestation message hash to s_k via the discrete-
   log relation `s_k·G = S_k`, so the published sig encodes
   exactly the scalar needed).
4. No FROST signing nonce is reused across messages within an
   epoch — each per-CDP pre-signature and each attestation uses
   a fresh FROST nonce.

The implementation reference (independent crypto review pending)
follows the standard DLC-on-Schnorr-threshold pattern from the
DLC literature with threshold-Schnorr extensions per FROST RFC
9591 + DLC v0 specs.

Trade-off: an adaptor secret released for band K applies to
**every CDP open during this epoch**. All those CDPs liquidate
together if the price falls into band K. This is the standard
"one-shot oracle outcome" DLC pattern; per-CDP variation would
require per-CDP DKG (far heavier oracle workload).

**participating[] fixes the slash target set.** §6.1.5 slashing
slashes each pubkey in `participating[]` proportionally.
Implementations SHOULD verify each listed pubkey was a valid
active-set member at this epoch (the indexer's per-epoch attester
roster is the source of truth).

**Embedding pattern**: commit-reveal (same as T_WRAPPER_ATTEST per
wrapper amendment §5.19 — drafted as §5.20, collapsed to §5.19 at
SPEC merge time). Envelope sits in `vin[0].witness[1]` as
a Taproot script-path leaf. ~2 Bitcoin txs per attestation; ~600
vbytes for typical t=15 attestation.

**Cadence**: one attestation per asset pair per **6 blocks**
(~hourly) by default, increasing to per-block if liquidations are
pending. Cost: ~$3-10 per attestation at mainnet rates; covered
by the protocol stability fee.

### 6.1.5 Slashing

A signature is **provably wrong** if the threshold sig verifies but
the (price_num, price_den) it commits to differs from the
deterministic recomputation of `median_twap(asset_pair,
window_blocks, end_height)` from public chain state.

Any party can publish a **slashing claim**:

```
T_ORACLE_SLASH(2)                                    // opcode 0x3B
   envelope_version  0x01
   opcode            0x3B
   network_tag       1 byte
   target_epoch      4 bytes
   wrong_attestation_txid_BE   32 bytes
   computed_price_num   8 bytes   (u64 LE; matches T_PRICE_ATTEST width)
   computed_price_den   8 bytes   (u64 LE; matches T_PRICE_ATTEST width)
   challenger_pubkey    33 bytes
   challenger_sig       64 bytes  (BIP-340 over slash_msg)
```

Validator algorithm: re-fetch the named chain state, recompute
`median_twap` per the deterministic function, compare to the
attestation's claimed `(price_num, price_den)`. If they disagree:

- **Slash all participating attesters by a fixed `slash_fraction`
  of their bond.** A threshold sig is collectively produced by
  t-of-N attesters; all participating signers are equally
  responsible for the wrong value. V1 default
  `slash_fraction = 10000 bps` (100%, full slashing). The pooled
  slashed amount across all participating attesters flows to the
  challenger as reward (V1 default: 100% to challenger). Future
  amendments may set `slash_fraction < 10000` (partial slashing)
  or `challenger_reward_bps < 10000` (rest to protocol treasury).
- **The participating-attester set is published in the wrong
  attestation's envelope** (added below in §6.1.4 *T_PRICE_ATTEST
  envelope* — `participating_attesters` field listing the x-only
  pubkeys of each contributing signer). This makes the slash
  target set unambiguous: it's whichever attesters' shares
  contributed to the wrong sig.
- **Eject all slashed attesters** from the active set immediately.
  If the threshold drops below `t`, the epoch enters degraded
  mode (see §6.1.6).

The "participating attesters" field requires each FROST signing
round to also record which signers contributed. Standard FROST
signing protocols expose this — implementations MUST surface the
contributor set into the on-chain attestation. This costs
~22 × 32 = 704 bytes per attestation (for t ≤ 22 typical), which
is acceptable given attestations happen at most once every 6 blocks.

If the challenge is incorrect (the attestation was actually right):

- The challenger's `challenger_pubkey` is flagged as a griefer.
  Repeat griefers are rate-limited by the indexer (each slash
  claim from the same pubkey requires an escalating bond posted
  in `tacit_oracle_griefer_bond_addr` derived from challenger
  pubkey).

Slashing claims must be made within `slash_window_blocks` (default
432, ~3 days) of the wrong attestation's confirmation. After this
window, the attestation is considered final and immutable.

### 6.1.6 Threshold degradation

If slashing reduces the active set below `t`, the oracle enters
**degraded mode**:

- New attestations cannot reach quorum until the next epoch.
- Pending CDP liquidations cannot fire (oracle adaptor secrets
  unavailable).
- User self-redemption via CSV escape (§6.2.5 / §6.3 *Liveness*)
  remains available.

Degraded mode is detectable from indexer state (active_set_size <
t). Any surviving attester MAY publish a `T_ORACLE_EMERGENCY_DKG`
envelope signaling readiness to participate in an early DKG. Once
≥ `t_new` surviving attesters have signaled (where `t_new` is the
threshold for the post-DKG size, conservatively `t_new ≥ 2/3 ×
queued_joiners + survivors`), an emergency DKG runs and produces a
fresh `attester_aggregate_key`. Attestations resume mid-epoch.

```
T_ORACLE_EMERGENCY_DKG(2)                            // opcode 0x41
   envelope_version  0x01
   opcode            0x41
   network_tag       1 byte
   target_epoch      4 bytes  (current epoch in degraded mode)
   attester_pubkey   33 bytes (signaling attester)
   sig               64 bytes (BIP-340 over emergency_dkg_msg)
```

```
emergency_dkg_msg = SHA256(
    "tacit-oracle-emergency-dkg-v1"
    || network_tag(1)
    || target_epoch_LE(4)
    || attester_pubkey(33)
)
```

If degraded mode persists for `dkg_petition_blocks` (default 144,
~24 hours) without reaching `t_new` survivors:

- The next-epoch boundary fires the normal DKG with whatever set
  is available.
- All in-flight CDPs whose attester set has fully departed (no
  surviving attester from the CDP's open-epoch) revert to CSV
  self-rescue mode immediately (§6.2.5 / §6.3).
- Users SHOULD treat extended degraded mode as a signal to close
  CDPs proactively before the CSV-rescue window opens.

### 6.1.7 Bootstrap

The protocol oracle cannot operate before any AMM pool exists. The
chicken-and-egg requires a **bootstrap phase**:

#### Bootstrap epoch (epoch 0)

A designated bootstrap key (the `bootstrap_pubkey` spec constant
declared in §6.7 *Genesis Constants*) acts as a single-attester
oracle. The period is explicitly trusted; users opting into cUSD
or cBTC during bootstrap know they're trusting the bootstrap
operator.

**Bootstrap price source specification (mandatory):**

During bootstrap, BTC/USD prices come from a deterministic median
across **at least 3 of these named external sources**, queried
within the same 60-second window:

- **Pyth Network**: BTC/USD price feed (on-chain, Solana mainnet)
- **Coinbase Spot**: BTC-USD spot tick (REST API)
- **Kraken Spot**: XBT/USD spot tick (REST API)
- **Binance Spot**: BTCUSDT spot tick (REST API, treated as
  USD-equivalent given USDT's typical 0.998–1.002 peg)
- **mempool.space**: BTC price oracle (REST API)

The bootstrap operator MUST:

1. Query at least 3 of these sources within the same 60-second
   window before each attestation.
2. Compute the **median** of the resulting prices.
3. Compute the **deviation** (max - min) / median across the
   queried sources.
4. If deviation > 2%, **skip** publishing the attestation for
   that interval. The absence of an attestation is itself the
   signal (silence-as-signal per §6.7); no `T_ORACLE_BOOTSTRAP_ABORT`
   envelope is published. Indexers SHOULD alert when bootstrap
   attestation freshness drops below 3× the schedule.
5. Otherwise, sign the T_PRICE_ATTEST envelope with the bootstrap key.

The published attestation MUST include `bootstrap_source_set` as
an extra field (a sorted list of the 3+ sources used) so anyone
can verify the operator's price was within plausible range of the
named sources at the attestation's timestamp.

**Bootstrap accountability:**

- All bootstrap attestations are publicly verifiable post-hoc
  against archived source feeds (Pyth on Solana chain; CEX
  historical APIs).
- Discrepancies between the bootstrap operator's published price
  and the verifiable median of named sources are
  challenge-publishable via `T_ORACLE_SLASH` even during
  bootstrap (with the slash going to the challenger's bond
  account instead of LP shares, since there are no LP shares
  yet).
- The bootstrap operator MUST post a **bootstrap-period bond** in
  cBTC equivalent (default 1 BTC equivalent) at a protocol-derived
  address, slashable for proven discrepancies. The bond is
  refunded after graduation if no successful challenges land.

#### Auto-graduation

Graduation transitions the oracle from single-attester-bootstrap
to threshold-FROST mode. Triggered when:

- AMM TVL across `cUSD/cBTC*` pools crosses **100 BTC equivalent**
  (computed at the attesting block height), AND
- ≥ 3 candidate attesters have posted LP-share bonds and signed
  `T_ORACLE_JOIN` envelopes.

The bootstrap key signs a `T_ORACLE_GRADUATE` envelope declaring
the transition. The first post-graduation epoch boundary triggers
DKG with the queued attesters; thereafter, the bootstrap key has
no special status and the threshold-signing protocol runs
normally.

#### Sunset clause

Even if AMM TVL doesn't reach 100 BTC, the bootstrap operator MUST
publish a graduation envelope at epoch 52 (~1 year). Failure to do
so:

- Flags the bootstrap as adversarial (indexer marks state).
- Triggers immediate CSV-escape rights for all CDPs regardless of
  the standard `csv_escape_blocks` countdown.
- Forfeits the bootstrap bond to a protocol-managed treasury
  (post-launch governance decides allocation).

Bootstrap operator's trust is **time-bounded, observable, and
bondable**. Users can wait until graduation if they want full
decentralization. Early users (during bootstrap) accept the trust
trade-off in exchange for being there for cUSD's launch.

---

## §6.2 Canonical cBTC

### 6.2.1 Asset identity

The canonical cBTC asset_id is **protocol-derived**, not from an
etch_txid:

```
canonical_cbtc_asset_id = SHA256(
    "tacit-canonical-cbtc-v1"
    || network_tag(1)
)
```

Per network:
- mainnet: `SHA256("tacit-canonical-cbtc-v1" || 0x00)`
- signet: `SHA256("tacit-canonical-cbtc-v1" || 0x01)`
- regtest: `SHA256("tacit-canonical-cbtc-v1" || 0x02)`

This is a **fourth asset-id origin path** alongside §4.1's three
(CETCH, T_PETCH, POOL_INIT-LP). The asset_id is fixed and known to
every indexer at protocol genesis; no CETCH transaction creates it.

### 6.2.2 CDP-style backing (1:1 peg)

Each cBTC unit is backed by 1 satoshi locked in a per-user DLC
contract. The DLC is a 2-of-2 Taproot multisig between:

- **User**: holds one key, controls one of the two signing slots
- **Oracle aggregate**: the threshold-signed `attester_aggregate_key`
  for the current epoch (NOT a single oracle member; the threshold
  signs collectively)

Each DLC has three spending paths via the Taproot tap-tree:

```
LEAF 1 — burn-and-redeem (user-initiated):
  <oracle_aggregate_xonly> OP_CHECKSIGVERIFY
  <user_xonly>             OP_CHECKSIG

LEAF 2 — CSV self-redeem (user escape):
  <26280> OP_CSV OP_DROP
  <user_xonly> OP_CHECKSIG

INTERNAL KEY: NUMS (key-path disabled)
```

**Leaf 1** is the happy path: user wants to redeem, both parties
sign a burn-and-unlock transaction. The oracle threshold co-signs
via a **direct FROST cooperative signing round** after observing
the matching on-chain T_BURN event — NOT via adaptor sig. cBTC
has no price-conditional outcomes, so the adaptor-sig DLC pattern
is unnecessary for cBTC redemption (it's reserved for cUSD; see
§6.3).

**Leaf 2** is the escape hatch: after 26280 blocks (~6 months) of
the DLC sitting unspent, the user can unilaterally claim their
sats back via the CSV path. This protects users if the oracle
threshold disappears (e.g., degraded mode persists past graduation
sunset).

### 6.2.3 cBTC mint operation

**Design simplification**: cBTC has a fixed 1:1 peg with no
price-conditional outcomes, so adaptor-sig DLC machinery is
unnecessary. The protocol uses **direct 2-of-2 cooperative
signing** for cBTC redemption — the oracle threshold simply
co-signs the redemption tx after observing the matching T_BURN
event on chain. No pre-signed adaptor outcomes required at CDP
open.

(cUSD CDPs DO require full DLC adaptor-sig machinery for
price-conditional liquidation outcomes — see §6.3.)

A user wishing to mint `N` cBTC base units:

1. Constructs a **DLC funding tx**: vin = user's sats UTXOs
   totaling ≥ N sats; vout = (a) `N` sats to the DLC P2TR address,
   (b) BTC change to user.
2. Broadcasts the funding tx + posts the asset_id binding to the
   protocol indexer via the T_CDP_OPEN envelope:

```
T_CDP_OPEN(2)                                        // opcode 0x3C
   envelope_version    0x01
   opcode              0x3C
   network_tag         1 byte
   collateral_kind     1 byte (0x00 = cBTC, 0x01 = cUSD)
   asset_id            32 bytes (canonical_cbtc or canonical_cusd per kind)
   collateral_sats_LE  8 bytes (u64; sats locked)
   mint_amount_LE      8 bytes (u64; tacit asset minted)
                                For cBTC: mint_amount == collateral_sats (1:1).
                                For cUSD: mint_amount = collateral_sats × oracle_price × LTV.
   user_pubkey         33 bytes
   dlc_outpoint        36 bytes (txid_BE(32) || vout_LE(4)) — references the DLC funding tx vout
   adaptor_sigs_cid    36 bytes (CIDv1 raw multihash (sha256), where the user's
                                  pre-signed adaptor sigs are stored — one per
                                  liquidation band + one self-redeem; cUSD only.
                                  All-zeros for cBTC — direct co-signing path.)
   adaptor_sigs_count  1 byte   (number of adaptor sigs at adaptor_sigs_cid;
                                  0 for cBTC; 1 + N_BANDS for cUSD)
   user_sig            64 bytes (BIP-340 over cdp_open_msg under user_pubkey)
```

```
cdp_open_msg = SHA256(
    "tacit-cdp-open-v1"
    || network_tag(1)
    || collateral_kind(1)
    || asset_id(32)
    || collateral_sats_LE(8) || mint_amount_LE(8)
    || user_pubkey(33)
    || dlc_outpoint(36)
    || adaptor_sigs_cid(36) || adaptor_sigs_count(1)
)
```

Validator algorithm:

1. Verify `dlc_outpoint` references a confirmed Bitcoin tx whose
   matching vout is a P2TR with the protocol-derived DLC address
   for `(user_pubkey, oracle_aggregate_xonly_for_current_epoch,
   collateral_kind)`. cBTC uses a 2-leaf tap-tree; cUSD uses a
   ~22-leaf tap-tree per §6.3.3. The address derivation is
   deterministic; the indexer recomputes and compares.
2. Verify `collateral_sats_LE` matches the value at that vout.
3. For cBTC: verify `mint_amount == collateral_sats` AND
   `adaptor_sigs_count == 0`. For cUSD: verify `mint_amount ≤
   floor(collateral_sats × latest_oracle_price × ltv_factor)` AND
   `adaptor_sigs_count == 1 + N_BANDS` (V1 default: N_BANDS = 20).
4. For cUSD: verify `adaptor_sigs_cid` is a well-formed IPFS CID.
   The CID contents are NOT validated at envelope-decode time
   (the indexer cannot reach IPFS during validation); instead,
   liquidation tx broadcasts later in §6.3.4 will fail if the
   referenced adaptor sigs at the CID are missing or wrong. The
   user is incentivised to keep the CID pinned (and the worker
   pins it on the user's behalf as a service — see §6.3.10).
5. Verify `user_sig` over `cdp_open_msg` under `user_pubkey`.

If all checks pass:
- Mint `mint_amount` of the canonical asset (cBTC or cUSD) at the
  user's tacit address.
- Record the CDP in indexer state: `(dlc_outpoint, user_pubkey,
  collateral_sats, mint_amount, asset_id, adaptor_sigs_cid)`.
- Update protocol-level `canonical_cbtc.supply` or
  `canonical_cusd.supply` counters.

### 6.2.4 cBTC burn-and-redeem operation

**For cBTC (direct co-signing)**:

1. User constructs a `T_CDP_CLOSE` envelope (below) and submits to
   the oracle threshold as a redemption request.
2. Oracle threshold observes the request, verifies the CDP exists,
   the user holds ≥ `burn_amount` of cBTC, and the user is the
   declared `user_pubkey`. Threshold members run a FROST signing
   round over the redemption tx (leaf-1 spend).
3. Once the threshold sig is produced, the redemption tx is
   broadcastable. The user (or anyone) appends their cBTC burn
   to the tx (via T_BURN at an additional vin) and broadcasts.
4. Indexer validates: T_CDP_CLOSE confirms; T_BURN of the matching
   amount is in the same tx; sats unlock to the user.

```
T_CDP_CLOSE(2)                                       // opcode 0x3D
   envelope_version    0x01
   opcode              0x3D
   network_tag         1 byte
   collateral_kind     1 byte
   asset_id            32 bytes
   dlc_outpoint        36 bytes
   burn_amount_LE      8 bytes (must equal mint_amount recorded in CDP state;
                                for cUSD with accrued borrow rate, see §6.3.8)
   user_pubkey         33 bytes
   threshold_sig       64 bytes (BIP-340 from oracle threshold over redemption tx;
                                 attached after oracle signing round completes)
   user_sig            64 bytes (BIP-340 over close_msg under user_pubkey)
```

```
close_msg = SHA256(
    "tacit-cdp-close-v1"
    || network_tag(1)
    || dlc_outpoint(36)
    || burn_amount_LE(8)
    || user_pubkey(33)
)
```

**Note**: T_CDP_CLOSE is issued as a request before the threshold
sig is collected; the indexer's worker-side mechanics handle the
back-and-forth (user request → oracle threshold signs →
co-signed close envelope ready for broadcast). The on-chain
envelope carries the final co-signed threshold_sig.

**For cUSD self-redeem (adaptor-sig path)**:

cUSD redemption uses the pre-signed adaptor sig for leaf-1 (the
self-redeem outcome) stored at `adaptor_sigs_cid[0]`. The oracle's
"redemption observed" attestation (a special T_PRICE_ATTEST with
`band_index = 254` reserved for redemption events, distinct from
the 0..N-1 liquidation bands) releases the adaptor secret. The
user composes the final redemption tx and broadcasts.

This requires no oracle FROST signing round — the secret is
released through the standard attestation mechanism. Trade-off:
cBTC's direct-cosigning is simpler operationally but requires the
oracle to be online for each redemption; cUSD's pre-signed-adaptor
model is more complex but lets redemption fire any time the
oracle has published a recent attestation with the matching band.

The protocol-side accounting: T_BURN reduces canonical_cbtc.supply
by `burn_amount`, matching the lock-side decrease. Coverage stays
exactly 1.0 (the protocol coverage formula treats canonical_cbtc as
"reserves = Σ all open CDP collateral; supply = Σ all open CDP
mints"; both decrease in lockstep).

### 6.2.5 Liveness / fallback

If the oracle threshold is unreachable (degraded mode, post-
graduation sunset), users can use the **CSV self-redeem** path
(leaf 2):

- After `dlc_outpoint.confirmed_height + 26280 blocks`, the user
  unilaterally signs a leaf-2 spend.
- The protocol still requires the matching T_BURN to credit the
  redemption. T_BURN amounts the user is REQUIRED to burn equal
  the original mint_amount; failure to burn would leave the cBTC
  in circulation while collateral was unlocked (depeg).

Bitcoin script can't enforce the T_BURN binding directly (would
need covenants), so the leaf-2 (CSV self-rescue) script stays
minimal and the binding is enforced **off-chain at the tacit
indexer level**:

```
LEAF 2 (CSV self-rescue):
  <26280> OP_CSV OP_DROP
  <user_pubkey> OP_CHECKSIG
  // Indexer enforces: tx must also burn the matching amount of
  // canonical cBTC via a T_BURN envelope in the same Bitcoin tx;
  // otherwise the unlock is flagged as a "violation" and the
  // user's cBTC supply continues to be marked as outstanding.
```

V1 enforcement is at the **tacit indexer level**:
the indexer refuses to credit the unlock unless the same Bitcoin tx
also burns the matching cBTC supply. A user who broadcasts a
leaf-2 unlock without the corresponding burn has their unlock
flagged as a violation — their cBTC continues to be marked as
"supply" in the indexer, so the user-side cBTC is effectively
"ghost" (unrecognized by other indexers as backed). Their unlocked
sats are spendable but the violation is publicly visible.

This is a meaningful but not perfect deterrent. Future covenant-
enabled enforcement could make this cryptographic.

---

## §6.3 Canonical cUSD

### 6.3.1 Asset identity

```
canonical_cusd_asset_id = SHA256(
    "tacit-canonical-cusd-v1"
    || network_tag(1)
)
```

Same pattern as canonical cBTC. Fixed per network, known to all
indexers at protocol genesis.

### 6.3.2 CDP structure (oracle-priced, liquidatable)

cUSD is collateralized by sats locked in DLCs, similar to cBTC, but
with three key differences:

1. **Oracle-priced peg.** The amount of cUSD that can be minted
   against a given sats collateral depends on the current BTC/USD
   oracle price.
2. **Loan-to-value (LTV) factor < 1.** A user locking N sats
   worth $X can mint at most `X × LTV` cUSD where LTV defaults to
   `0.66` (= 150% collateralization minimum).
3. **Liquidation via pre-signed DLC outcomes.** If the user's
   collateral ratio drops below the liquidation threshold (e.g.,
   115% — a buffer above the minimum), keepers can broadcast a
   pre-signed liquidation tx that burns the user's cUSD and
   transfers the collateral to the keeper at a 5% discount.

### 6.3.3 DLC tap-tree for cUSD CDP

The DLC is a 2-of-2 between user and oracle aggregate, with three
leaves:

```
LEAF 1 — user self-redeem (full burn):
  <oracle_aggregate_xonly> OP_CHECKSIGVERIFY
  <user_xonly>             OP_CHECKSIG
  // adaptor sig releases when oracle observes T_CDP_CLOSE + T_BURN
  // for the full mint_amount

LEAF 2 — liquidation at price band P_k:
  <oracle_aggregate_xonly> OP_CHECKSIG
  // Single oracle threshold sig validates any liquidation outcome.
  // All N liquidation bands share this same leaf script byte-for-byte
  // — they collapse to a single tap-tree leaf at the script level.
  // The per-band distinction lives in the per-CDP outcome tx
  // sighashes: each band K has its own pre-signed outcome_tx_K
  // (vout: 95% to keeper_hold_address, 5% to protocol_yield_address),
  // and each band's oracle adaptor pre-signature is bound to R_k.
  // When the oracle attests band K (revealing s_k), the K-th
  // pre-signature completes into a valid oracle sig over
  // outcome_tx_K's sighash; any keeper can broadcast it.

LEAF 3 — CSV self-rescue:
  <26280> OP_CSV OP_DROP
  <user_xonly> OP_CHECKSIG
  // 6-month escape if oracle goes dark
```

Tap-tree depth: **3 distinct leaves** (self-redeem, liquidation,
CSV self-rescue) regardless of band count, since all liquidation
bands share leaf 2. Depth 2. The per-band distinction lives in
the per-CDP pre-signed outcome txs and the per-band adaptor
pre-signatures stored at `adaptor_sigs_cid`, NOT in the tap-tree
script itself.

**Bands are protocol-uniform absolute-price levels.** A band is
"price ≤ $X_K" for fixed protocol thresholds X_0 > X_1 > ... >
X_{N-1}. V1 defaults: 20 bands spanning a configurable USD range
(see §6.3.6 for the canonical layout). Every CDP in a given
epoch pre-signs outcome txs for every band; for bands above the
CDP's own liquidation price, the outcome tx is a no-op refund to
the user (pay-all-to-user, vout[1] and vout[2] zero-valued and
omitted). For bands at or below the CDP's liquidation price, the
outcome tx is the standard 95% / 5% / residual split.

At any time, the oracle's latest threshold-signed attestation
reveals the adaptor secret for **exactly one band** (the lowest
band whose threshold is at or above the current price). Once
revealed, every CDP's K-th outcome tx becomes broadcastable; the
keeper economy picks only the CDPs whose K-th outcome is a real
liquidation (not a no-op refund).

### 6.3.4 Liquidation flow

Liquidation uses **pre-signed exact-vout outcome txs** so the
protocol's 5% stability fee is enforced at the Bitcoin script
level (not merely indexer policy). Keeper competition is resolved
by a first-broadcast-wins race on a downstream claim tx.

#### Pre-signed outcome tx (per band, at CDP open)

For each liquidation band K, the user pre-signs an exact-vout
outcome tx:

```
outcome_tx_K {
  vin[0]:  DLC outpoint (script-path spend, leaf K)
  vout[0]: floor(collateral_sats × (10000 − liquidation_discount_bps) / 10000)
           sats to keeper_hold_address(dlc_outpoint, K)
  vout[1]: floor(collateral_sats × stability_fee_bps / 10000)
           sats to protocol_yield_address(current_epoch)
  vout[2]: floor(collateral_sats − vout[0].value − vout[1].value)
           sats refunded to user (residual; ~0 in V1 since 9500 + 500 = 10000 bps)
}
```

The user's adaptor sig over `outcome_tx_K` binds the exact vout
structure. The keeper cannot redirect funds without invalidating
the signature.

#### keeper_hold_address (anyone-can-claim with race window)

`keeper_hold_address(dlc_outpoint, band_K)` is a Taproot P2TR
parameterised so each (dlc_outpoint, band_K) yields a **distinct
address** (without this, all liquidation outputs would conflate to
one address and a single keeper claim would sweep all outstanding
liquidations):

- Internal key: NUMS (key-path disabled)
- Single script-path leaf:
  ```
  <dlc_outpoint(36)>  OP_DROP
  <band_K(1)>         OP_DROP
  OP_TRUE
  ```

The two OP_DROPs are no-ops at execution time but distinguish
the script's bytes (and thus the leaf hash, the tap-tree merkle
root, and the P2TR address) per (dlc_outpoint, band_K). Spending
requires no witness signature (OP_TRUE leaves a non-empty stack)
so the address is effectively anyone-can-spend, but only for the
one UTXO at that specific address.

After the outcome tx confirms (creating one keeper_hold UTXO per
liquidation, at its own per-(dlc_outpoint, band_K) address),
anyone may broadcast a follow-up "claim tx" spending the
keeper_hold UTXO to their own address. The first valid claim tx
wins; subsequent attempts targeting the same UTXO conflict at
the mempool level.

A keeper's incentive structure:
- Watch the mempool for the moment an oracle attestation reveals
  band K's adaptor secret
- Race to broadcast outcome_tx_K (this is the "trigger" tx)
- Simultaneously CPFP-bundle the claim tx that sweeps keeper_hold
  to their address
- First miner to include the bundle wins; the keeper gets the
  95% discount

This puts liquidation competition at the **transaction-fee market**
level, which is the standard MEV-resistant approach: keepers
compete on Bitcoin fee rate, not on extracting more than the spec'd
discount.

#### protocol_yield_address

Derived per current epoch:

```
protocol_yield_address(epoch) = P2TR(NUMS, [
   OP_CHECKSIG <attester_aggregate_key[epoch]>  // FROST threshold spend
])
```

The protocol's 5% stability fee accumulates at this address.
Each epoch boundary, the threshold-FROST signing round distributes
the accumulated balance per §6.3.5.

#### Indexer accounting (T_CDP_LIQUIDATE)

The on-chain outcome tx triggers the liquidation. The keeper
broadcasts T_CDP_LIQUIDATE as a separate envelope (single tx,
indexer-validated) confirming the accounting:

```
T_CDP_LIQUIDATE(2)                                   // opcode 0x3E
   envelope_version          0x01
   opcode                    0x3E
   network_tag               1 byte
   asset_id                  32 bytes (canonical_cusd)
   dlc_outpoint              36 bytes
   liquidation_band          1 byte (price band index 0..N-1)
   oracle_attestation_txid   32 bytes (the T_PRICE_ATTEST releasing this band)
   outcome_tx_txid           32 bytes (the pre-signed outcome tx broadcasted)
   keeper_claim_tx_txid      32 bytes (the keeper's follow-up claim tx;
                                       sweeps keeper_hold to keeper's address)
   burn_amount_LE            8 bytes (cUSD burned, must equal mint_amount in CDP)
   keeper_pubkey             33 bytes
   keeper_sig                64 bytes (BIP-340 over liquidate_msg)
```

```
liquidate_msg = SHA256(
    "tacit-cdp-liquidate-v1"
    || network_tag(1) || asset_id(32) || dlc_outpoint(36)
    || liquidation_band(1)
    || oracle_attestation_txid(32)
    || outcome_tx_txid(32) || keeper_claim_tx_txid(32)
    || burn_amount_LE(8) || keeper_pubkey(33)
)
```

Validator algorithm:
1. Verify CDP exists at `dlc_outpoint` with matching `mint_amount`.
2. Verify oracle's T_PRICE_ATTEST at `oracle_attestation_txid`
   commits to a price within `liquidation_band`.
3. Verify the band-K leaf's adaptor sig was released by the
   attestation.
4. Verify `outcome_tx_txid` is the on-chain confirmed tx with the
   expected vout structure (the user-pre-signed outcome for band K
   at this CDP's `adaptor_sigs_cid`).
5. Verify `keeper_claim_tx_txid` is a follow-up tx that spends
   `keeper_hold_address(dlc_outpoint, K)` to a vout owned by
   `keeper_pubkey` (via P2WPKH or equivalent).
6. Verify `burn_amount == mint_amount` (full burn; no partial
   liquidations in V1).
7. Verify keeper actually burned `burn_amount` of cUSD in either
   the outcome tx or the claim tx (a T_BURN envelope co-broadcast
   with one of them).
8. Mark CDP as liquidated; reduce canonical_cusd.supply by
   `burn_amount`; remove CDP from indexer state.

The 5% discount goes to the keeper (via `keeper_hold` → claim_tx).
The 5% stability fee goes to the protocol via the pre-signed
outcome tx's vout[1] — enforced at Bitcoin script level.

Keeper race resolution: only ONE keeper's claim_tx can confirm
(spending keeper_hold once). Losing keepers see their claim
attempts rejected by Bitcoin mempool. T_CDP_LIQUIDATE under
indexer rules is idempotent — the first valid one for a given
dlc_outpoint wins; subsequent are no-ops.

### 6.3.5 Stability fee + attester yield

The protocol collects revenue from two sources, both of which
**mint new cUSD** into a protocol-managed yield account (avoiding
the supply-fixed appreciation pressure that would otherwise push
cUSD above peg as borrowers race to acquire cUSD to close CDPs):

1. **Borrow rate revenue** (annual % accrued on outstanding cUSD).
   The protocol mints `(borrow_rate × outstanding_cusd × elapsed
   / year)` of new cUSD each epoch, depositing into the yield
   account. The user's CDP solvency check uses
   `effective_supply_owed = original_mint × (1 + borrow_rate ×
   t_seconds / year)` — so user must burn the original mint AND
   acquire the accrued borrow-rate amount from market to close.
   The acquired cUSD is the same cUSD the protocol minted into
   the yield account (eventually flowing to attesters who
   redeem it for sats via the open market). Net: supply grows
   with fees; outstanding purchasing power stays at peg.
   Reference borrow rate: **2% APR**.

2. **Liquidation stability fee** (5% of each liquidation's
   collateral, in sats). Deposited into the yield account as
   sats. Held at `protocol_yield_address(epoch)` — a P2TR with a
   FROST-threshold-spendable script-path leaf controlled by the
   current epoch's `attester_aggregate_key` (the SAME threshold
   key that signs attestations). No separate multisig is needed.
   Distribution requires one FROST signing round per epoch
   boundary.

**Attester yield distribution:**

At each epoch boundary, the yield account distributes to active
attesters pro-rata by bond size:

- cUSD revenue (from borrow rate): each attester receives cUSD
  proportional to their bond. They sell on market for sats if
  desired.
- sats revenue (from liquidation discount): each attester
  receives sats proportional to their bond.

If liquidation stability-fee sats exceed the cost of running the
oracle infrastructure (publishing attestations, hosting IPFS
pins for CDP adaptor sigs, FROST DKG participation, etc. —
*keepers are not part of this — they are anyone-can-claim third
parties competing on Bitcoin-fee market*), the excess accumulates
in the yield account; future-epoch attesters benefit. Alternatively,
governance
(future amendment) may direct excess to a protocol insurance fund
or to T_BURN against canonical cUSD/cBTC supply (deflationary).

**No mint-without-bond.** The protocol cannot mint cUSD outside
this accounting flow. Mint events are: (a) user CDP opens (1 per
T_CDP_OPEN), (b) borrow-rate accrual (epoch-boundary protocol
mint to yield account). Burn events: (a) user CDP close, (b)
liquidation, (c) attester market-sells the cUSD they earned.
All flows are observable; supply is fully accounted.

### 6.3.6 Collateral ratio + liquidation threshold + band layout

| Parameter | V1 value | Rationale |
|---|---|---|
| **Maximum LTV** (mint-time) | 0.66 (150% min collateral ratio) | Maker DAO-style buffer; conservative for V1 |
| **Liquidation collateral ratio** | 1.15 (~87% LTV) | Triggers when CDP's collateral value drops to 115% of mint value |
| **Liquidation discount (`liquidation_discount_bps`)** | 500 (5%) | Standard incentive; competitive with Maker/Compound |
| **Stability fee (`stability_fee_bps`)** | 500 (5%) | Bitcoin-script-enforced via outcome tx's vout[1] |
| **Borrow rate (`borrow_rate_bps_per_year`)** | 200 (2% APR) | Below typical TradFi rate; competitive with Maker |
| **Min CDP size (floor)** | 100,000 sats (~$50) | Hard floor; below this, T_CDP_OPEN envelope is invalid |
| **Min CDP size (dynamic)** | `max(100,000, current_fee_rate × 700 / 0.05)` | Operational minimum scaled to keep per-CDP Bitcoin fee below 5% of CDP value |
| **Min collateral** | 10,000 sats (no upper limit) | Sufficient buffer over Bitcoin dust |
| **N_BANDS** | 20 | Per-epoch band count |
| **Band step (price_step_usd_bps)** | 500 bps of band-0 | 5% relative price step between adjacent bands |
| **Band-0 USD threshold** | Genesis: 2× attestation price at amendment activation; per-epoch: 2× current attestation price | Top band covers prices well above current; lower bands trigger liquidation |

**Band layout (protocol-uniform; per-epoch, recomputed at DKG):**

At each epoch's DKG, the oracle threshold publishes (alongside
`attester_aggregate_key` and `nonce_commit_root`) a **band layout
vector** `[X_0, X_1, ..., X_{N-1}]` of N=20 absolute USD-price
thresholds. The vector is deterministic from a per-epoch **seed
price `P_seed`** and the band step:

```
X_K = floor(P_seed × 2 × (10000 − K × price_step_usd_bps) / 10000)
                      ↑ band-0 = 2× P_seed; X_19 = 0.05 × P_seed
```

`P_seed` is:
- **For epoch 0 (bootstrap)**: the spec-constant
  `genesis_seed_price_usd` (V1 default: $50,000 per BTC, encoded
  in §6.7 *Genesis Constants*). The bootstrap operator's first
  attestation MUST commit to this band layout regardless of the
  external median; if the external median diverges by more than
  10× from `genesis_seed_price_usd`, the operator alerts and
  defers band-conditional liquidations until graduation.
- **For epoch E ≥ 1**: the last successfully-published attestation
  price `P_final` from epoch E-1. If epoch E-1 produced no
  attestations (degraded mode), the seed inherits from the most
  recent prior epoch with attestations.

For example, if `P_seed = $50,000`:
- X_0 = $100,000 (band 0; price below = mild)
- X_5 = $75,000 (band 5; price below = within 1.5× P_seed)
- X_10 = $50,000 (band 10; price below = current spot)
- X_15 = $25,000 (band 15; price below = 0.5× P_seed)
- X_19 = $5,000 (band 19; price below = ~10% of P_seed)

**Per-CDP liquidation threshold (in USD price):** A CDP minted at
price `P_mint` with LTV `L_mint` has liquidation triggered at
price `P_liq = (P_mint × L_mint / 1.15)` (the price at which
collateral value drops to 115% of mint value). The CDP's
outcome txs for bands K where `X_K > P_liq` are no-op refunds
(pay everything back to user); outcome txs for bands K where
`X_K ≤ P_liq` are the canonical 95% / 5% / residual liquidation.
Each CDP pre-signs all N=20 outcome txs at open; only the bands
matching real liquidation conditions will ever produce non-trivial
liquidations.

**Band-layout determinism is critical.** All indexers MUST compute
the same `[X_0..X_{N-1}]` vector for a given epoch; the formula
above is the canonical derivation. The band layout is also
published in the epoch-boundary attestation envelope so that any
party computing the same value can verify their derivation.

The **dynamic minimum** is enforced by the dapp/worker layer
(client-side warning + intent rejection), not at the indexer level
(protocol accepts any size ≥ the hard floor). The dynamic minimum
formula uses `current_fee_rate` from the mempool and approximates
the T_CDP_OPEN tx size as ~700 vbytes (envelope + funding tx +
DLC P2TR construction):

- At 10 sat/vB (calm mempool): dynamic minimum ≈ 140,000 sats
- At 30 sat/vB (busy): ≈ 420,000 sats
- At 100 sat/vB (rare congestion): ≈ 1.4M sats

The dapp surfaces this in real-time so users see the right
minimum at the right moment.

These parameters are **upgradable via protocol-parameter
governance** (V2; not specified in this amendment). V1 ships with
the values above.

### 6.3.7 Mint operation (T_CDP_OPEN with cUSD kind)

Reuses the `T_CDP_OPEN` envelope from §6.2.3 with
`collateral_kind = 0x01` (cUSD). Difference vs cBTC:

- `mint_amount_LE` is the cUSD amount, bounded by:
  ```
  mint_amount ≤ floor(collateral_sats × oracle_price_btc_usd × ltv_factor)
  ```
- The DLC tap-tree has the full set of N+2 leaves (per §6.3.3),
  not just the 2 leaves of cBTC.
- The user pre-signs N+1 adaptor sigs (one per band + one for
  self-redeem), each binding to a different oracle attestation
  point.

### 6.3.8 Self-redeem (T_CDP_CLOSE with cUSD kind)

Same envelope as cBTC redemption, but the user must burn their
**full original mint_amount × (1 + borrow_rate × elapsed_seconds /
year)** of cUSD to unlock the collateral. The borrow-rate
accumulation means a year-long CDP must burn 2% more cUSD than was
originally minted; the excess is supplied by the user (purchased
on market) or carried via partial top-ups.

### 6.3.9 Honest trust profile

Even with the protocol oracle, cUSD has trust assumptions:

| Assumption | Mitigation |
|---|---|
| Oracle threshold doesn't collude on a wrong price | Open-membership, slashable, verifiable computation. Collusion requires 2/3 of LP-staked attesters to coordinate; provably wrong attestations are slashable. |
| Oracle threshold doesn't go fully offline | CSV self-rescue (leaf N+2) after 26280 blocks. User can always recover collateral; cUSD supply may be over-issued (user keeps cUSD without burning) until covenant-based enforcement lands. |
| User can keep cUSD after CSV self-rescue | V1: indexer marks the user's CSV-rescued sats as a "violation" event; their address is publicly flagged. Future covenants: cryptographic enforcement of burn-on-rescue. |
| AMM has enough liquidity for oracle TWAP to be manipulation-resistant | Min pool TVL threshold (10k sats) per-pool; multi-pool aggregation. Manipulation costs scale with AMM depth. |
| Bootstrap key doesn't misbehave | Time-bounded (1 epoch / week + 1 year sunset). Users who don't trust bootstrap can wait for graduation. |

Compared to MakerDAO's trust profile (MKR governance,
multiple-collateral risks, oracle network):

- ✅ More transparent: every step is on-chain and verifiable
- ✅ No governance token: no MKR-equivalent extracting value
- ✅ Single-asset collateral (sats): no multi-collateral risk
- ⚠️ Oracle is smaller (LP-staked vs Chainlink-style): less
  diverse but more accountable
- ⚠️ Bootstrap requires a trusted key for ~1 year: real but
  time-bounded

### 6.3.10 Adaptor sig pinning + recovery

Each cUSD CDP at open time produces — via per-CDP FROST signing
rounds run by the current epoch's oracle threshold — the following
**oracle threshold adaptor pre-signatures**:

- 1 self-redeem adaptor pre-sig (band_index = 254; bound to R_254)
- N liquidation-band adaptor pre-sigs (one per band; V1 N=20;
  bound to R_0..R_{N-1} respectively)
- 1 CSV self-rescue (no adaptor needed; CSV unlocks via time)

Total: **21 oracle adaptor pre-sigs of 64 bytes each = 1344 bytes**
per CDP. Too large to fit in the T_CDP_OPEN envelope. Stored
externally under an IPFS CID referenced by `adaptor_sigs_cid`
(§6.2.3).

The pre-signatures are produced collaboratively by the oracle
threshold (FROST signing rounds; current epoch's threshold members
participate) over the per-CDP outcome_tx sighashes (which are
deterministic from the user's `dlc_outpoint` and the canonical
vout structure per band; see §6.3.4). The user does NOT sign the
adaptor pre-signatures themselves — the oracle threshold is the
sole signer for leaf-2 spends, so all adaptor cryptography is on
the oracle side. The user's only signature is over T_CDP_OPEN
(authorizing the protocol to request the oracle's pre-signatures
against their DLC outpoint).

**Pinning responsibilities:**

| Party | Responsibility |
|---|---|
| **User** | Generates adaptor sigs at CDP open; signs each one with their key; pins to IPFS. |
| **Worker** | Mirrors the pin on its own IPFS infrastructure. Pin guaranteed for the CDP's lifetime + 1 year cooling-off. |
| **Oracle threshold** | Mirrors the pin (each active attester runs a pinning node). At-least-1-of-N attester must pin for the duration of the active epoch. |
| **Keepers** | Fetch the CID at liquidation time. Liquidator nodes typically mirror common-CDP CIDs preemptively. |

**Multi-pinner redundancy** ensures the adaptor sigs are reachable
even if any single party (worker / one attester / user) goes
offline. Pinning is one-time + ~1 KB; cost is negligible.

**Recovery scenario**: user wallet wipe + worker goes dark
simultaneously. Worker is the canonical mirror; if it's gone, the
user falls back to: (a) any current-epoch attester's mirror, OR
(b) the original CID's other public IPFS gateways. If all of
these fail, the user falls through to CSV self-rescue (§6.3
*Liveness*) — they don't lose collateral, just lose the ability
to redeem cleanly before the CSV timeout.

**On-chain backup option**: a user MAY broadcast a
`T_CDP_ADAPTOR_BACKUP` envelope (opcode `0x42`) that records all
21 adaptor sigs on chain. ~1500 vbytes per backup; cost ~15k sats
at 10 sat/vB. Worth it for high-value CDPs. Not mandatory.

```
T_CDP_ADAPTOR_BACKUP(2)                              // opcode 0x42
   envelope_version       0x01
   opcode                 0x42
   network_tag            1 byte
   dlc_outpoint           36 bytes
   adaptor_sigs_count     1 byte (must match CDP's recorded count; 21 for cUSD)
   adaptor_sigs[]         64 × count bytes (sequence of pre-signed adaptor sigs,
                                            ordered by band index 0..N-1, then
                                            self-redeem at index N)
   user_pubkey            33 bytes
   user_sig               64 bytes (BIP-340 over backup_msg)
```

```
backup_msg = SHA256(
    "tacit-cdp-adaptor-backup-v1"
    || network_tag(1)
    || dlc_outpoint(36)
    || adaptor_sigs_count(1)
    || adaptor_sigs_concat(64 × count)
    || user_pubkey(33)
)
```

The on-chain backup is the ultimate recovery mechanism. After
publishing one, the user is guaranteed-recoverable regardless of
IPFS / worker / attester state.

---

## §6.4 Wrapper convention integration

The wrapper convention (`SPEC-WRAPPER-AMENDMENT.md`) reserved
`peg.kind = "oracle_priced"` and `custody.kind = "user_dlc"`. This
amendment populates both:

### 6.4.1 `peg.kind = "oracle_priced"`

For wrappers using oracle-priced pegs, the metadata MUST additionally
specify:

```jsonc
"peg": {
  "kind": "oracle_priced",
  "oracle_pair": "btc_usd",                  // pair identifier
  "ltv_factor_bps": 6600,                    // max LTV in basis points (0.66 = 6600)
  "liquidation_threshold_bps": 8700,         // liquidation triggers above this fraction
  "liquidation_discount_bps": 500,           // keeper discount in basis points
  "stability_fee_bps": 500,                  // protocol share of liquidation
  "borrow_rate_bps_per_year": 200            // annual rate
}
```

Canonical cUSD uses these exact parameters as its metadata.

### 6.4.2 `custody.kind = "user_dlc"`

For wrappers using per-user DLC custody, metadata specifies:

```jsonc
"custody": {
  "kind": "user_dlc",
  // reserve_address is OMITTED per §4.2.2 — backing is per-CDP, not at one address.
  "oracle_aggregate_pubkey": "02ab...",      // ADVISORY: current epoch's attester aggregate.
                                              // Stale-allowed; see note below.
  "epoch_blocks": 1008,                       // epoch length (authoritative)
  "csv_escape_blocks": 26280                  // user-side CSV unlock timeout (authoritative)
}
```

**`oracle_aggregate_pubkey` is advisory and may be stale.** It records
the attester aggregate at metadata-pinning time but rotates every
`epoch_blocks` Bitcoin blocks. Indexers MUST resolve the *current*
aggregate from the latest `T_ORACLE_GRADUATE` (epoch 0 → 1
transition) and subsequent epoch-boundary DKG records, NOT from the
static metadata field. The metadata value is preserved for archival
verification and for pre-amendment-aware UIs that want to display
the genesis-epoch aggregate. Wallets and indexers MUST NOT use the
metadata value to sign or verify current-epoch operations.

This is the only field in the wrapper convention that may legitimately
become stale relative to chain state. All other `tacit_wrapper`
fields are immutable per asset_id (since metadata is content-
addressed; rotating any other field requires a new CETCH and a new
asset_id — for canonical assets, a future amendment).

### 6.4.3 Canonical assets bypass CETCH

Canonical cBTC and cUSD do **not** require a CETCH transaction at
genesis. Their asset_ids are protocol-derived, and indexers know
about them from this spec amendment. The wrapper-convention
metadata is **synthesized** by the indexer from spec constants +
current epoch's oracle state.

Canonical assets enter the wrapper registry via the **protocol-derived
registration path** documented in SPEC.md §4.2.5 (item 2). Indexers
post-amendment MUST include canonical cBTC and canonical cUSD in
every `GET /wrappers/{chain}/{asset}` response for `(bitcoin, native)`
and `(usd, oracle)` respectively, returning them as first-class
variants alongside any CETCH-issued ones. Routing, coverage, and
attestation queries treat synthesized variants identically to
CETCH-derived ones.

A query for `GET /wrappers/{canonical_cbtc_asset_id}` returns the
canonical metadata as if it had been etched, but without an
underlying CETCH tx.

**Synthesized metadata is never stale.** Unlike CETCH-pinned
metadata (immutable per asset_id), synthesized metadata is rebuilt
on demand from current spec constants + current epoch state at
query time. The `oracle_aggregate_pubkey` flagged as advisory-only
in §6.4.2 is therefore always the current value when read from a
canonical asset's synthesized blob — the staleness caveat applies
to CETCH-pinned user_dlc variants, not to canonical assets.

**Metadata-CID divergence from wrapper convention.** The wrapper
convention (§4.2.1) describes wrapper metadata as IPFS-pinned and
content-addressed by `metadata_cid`. Canonical wrappers don't have
a `metadata_cid` — there's no IPFS pin, no CETCH-recorded reference.
Instead, the canonical metadata is **deterministically derivable**
from this spec amendment's text plus current oracle state.

Indexers MUST treat canonical assets as if their metadata were
JCS-canonicalised from the spec's reference metadata template
(below). Pre-amendment indexers don't know about canonical assets;
post-amendment indexers synthesise on demand.

The reference canonical metadata template:

```jsonc
// canonical cBTC, mainnet:
{
  "ticker": "cBTC",
  "decimals": 8,
  "tacit_wrapper": {
    "version": 1,
    "underlying": { "chain": "bitcoin", "asset": "native", "unit": "satoshi" },
    "peg": { "numerator": 1, "denominator": 1, "kind": "fixed" },
    "custody": {
      "kind": "user_dlc",
      "oracle_aggregate_pubkey": <current epoch's value>,
      "epoch_blocks": 1008,
      "csv_escape_blocks": 26280
    },
    "redemption": {
      "fee_bps": 0,              // canonical cBTC has no issuer fee
      "min_request_units": 100000
    },
    "attestation": {
      "issuer_pubkey": <current epoch's oracle aggregate>,
      "schedule_blocks": 6
    }
  }
}
```

cUSD's template is similar but with `peg.kind = "oracle_priced"`
and the full set of LTV / liquidation / borrow-rate parameters from
§6.3.6.

### 6.4.4 Canonical-pool AMM-fee constraint

Any AMM `POOL_INIT` (`T_LP_ADD(variant=1)`) whose `asset_A` or
`asset_B` is `canonical_cbtc_asset_id` or `canonical_cusd_asset_id`
**MUST** set `protocol_fee_address = 33×0x00` (disabled) and
`protocol_fee_bps = 0`. Indexers MUST reject canonical-pool inits
that violate this constraint.

This is the **amendment-scoped exception** anticipated by SPEC.md
§4.2.3 ("No protocol-level rejection — Exception"). The wrapper
convention's default is advisory; the CDP amendment overrides that
default for AMM-pool inits touching canonical assets specifically.
The override does NOT extend to other transaction kinds against
canonical assets (transfers, swaps, T_CDP_OPEN/CLOSE, etc.) — those
remain governed by their respective validator rules. The override
also does NOT extend to non-canonical wrapper variants — federated
variants (`cBTC.tac/cUSD.federation`, etc.) remain free to choose
their own protocol-fee parameters.

**Rationale.** The CDP machinery (§6.3.5) already collects two
streams of protocol revenue from canonical-asset users:
- a 5% stability fee on every cUSD liquidation, paid in sats to
  the protocol yield account
- a 2% annual borrow rate, minted as new cUSD into the yield
  account

Stacking the AMM protocol-fee skim on top would double-charge
liquidity providers in canonical-pair pools, dampening the
LP-incentive that backstops the oracle bond.

### 6.4.5 Open-issuer marketplace coexistence

Canonical cUSD and canonical cBTC coexist with marketplace variants
(`cBTC.tac`, `cUSD.federation`, etc.). The dapp's router treats
them as competing variants under the same `(chain, asset)` key in
the wrapper registry. Users + market choose.

Expectation: canonical cBTC will have higher trust (no federation)
but worse UX during oracle bootstrap or degraded mode. Federated
cBTC variants offer simpler operation. Both coexist; users route
through the variant matching their trust + liquidity preferences.

---

## §6.5 New opcodes and domain tags

### Opcodes

| Opcode | Name | Purpose |
|---|---|---|
| `0x39` | T_PRICE_ATTEST | Oracle threshold-signed price attestation |
| `0x3A` | T_ORACLE_JOIN | Attester applies to join active set |
| `0x3B` | T_ORACLE_SLASH | Slashing claim for divergent attestation |
| `0x3C` | T_CDP_OPEN | Open CDP, mint canonical wrapper |
| `0x3D` | T_CDP_CLOSE | Close CDP, burn wrapper, redeem collateral |
| `0x3E` | T_CDP_LIQUIDATE | Keeper liquidates undercollateralized CDP |
| `0x3F` | T_ORACLE_LEAVE | Attester signals exit (cooling-off epoch) |
| `0x40` | T_ORACLE_GRADUATE | Bootstrap → threshold transition |
| `0x41` | T_ORACLE_EMERGENCY_DKG | Mid-epoch DKG request after slashing degradation |
| `0x42` | T_CDP_ADAPTOR_BACKUP | On-chain backup of cUSD CDP adaptor sigs |

Opcodes `0x39`–`0x42` occupy a contiguous block. Next available:
`0x43`.

### Domain tags

Add to §3 *BIP-340 Schnorr signature-message tags*:

- `tacit-oracle-price-v1` — T_PRICE_ATTEST attestation_msg
- `tacit-oracle-join-v1` — T_ORACLE_JOIN candidacy
- `tacit-oracle-slash-v1` — T_ORACLE_SLASH challenge
- `tacit-oracle-leave-v1` — T_ORACLE_LEAVE departure
- `tacit-oracle-graduate-v1` — T_ORACLE_GRADUATE transition
- `tacit-oracle-emergency-dkg-v1` — T_ORACLE_EMERGENCY_DKG signal
- `tacit-cdp-open-v1` — T_CDP_OPEN cdp_open_msg
- `tacit-cdp-close-v1` — T_CDP_CLOSE close_msg
- `tacit-cdp-liquidate-v1` — T_CDP_LIQUIDATE liquidate_msg
- `tacit-cdp-csv-redeem-v1` — leaf-2 CSV self-rescue spend
- `tacit-cdp-adaptor-backup-v1` — T_CDP_ADAPTOR_BACKUP backup_msg
- `tacit-oracle-pair-v1` — `asset_pair` hash derivation
- `tacit-oracle-bond-v1` — `bond_addr` leaf script distinguisher

Add to §4.1 *asset-id origin paths*:

- **Origin path 4**: Canonical protocol assets.
  `canonical_cbtc_asset_id = SHA256("tacit-canonical-cbtc-v1" || network_tag(1))`
  `canonical_cusd_asset_id = SHA256("tacit-canonical-cusd-v1" || network_tag(1))`
  These coexist with paths 1–3 (CETCH, T_PETCH, POOL_INIT-LP); the
  preimage shape (24 bytes) is length-distinct from all three so
  cross-origin collisions reduce to SHA256 preimage resistance under
  disjoint domain tags. Update SPEC.md §4.1's "Three-origin
  resolution" to "Four-origin resolution".

Add to *Address / script derivations* (inline at the relevant §6
locations rather than a separate §3 subsection — SPEC.md has no
dedicated address-derivation table):

- **`bond_addr(attester_pubkey)`** — P2TR address holding an oracle
  attester's bonded LP-share UTXO:

  ```
  bond_addr(pubkey) = P2TR(
    internal_key: NUMS,
    leaves: [
      // Single leaf: CSV-locked withdraw by the attester (one full
      // epoch + leave-signal cooling-off). Slashing is NOT enforced
      // by this script — see slashing-model note below.
      <SHA256("tacit-oracle-bond-v1" || pubkey)>  OP_DROP
      <1008> OP_CSV OP_DROP
      <attester_pubkey> OP_CHECKSIG
    ]
  )
  ```

  The hashed `tacit-oracle-bond-v1` domain tag inside the leaf
  makes the script unambiguously belong to a specific attester
  (no collision with other Taproot script templates).

  **Slashing-model note.** Bitcoin script cannot enforce a "third
  party can sweep this UTXO on proof of misbehavior" condition
  without covenants. V1 slashing is therefore enforced at the
  **tacit indexer level**:

  - The on-chain UTXO at `bond_addr` is a CSV-locked withdraw path
    controlled only by the attester. The attester CAN unilaterally
    withdraw after the cooling-off period regardless of slashing.
  - But the indexer's account-level state for the attester's bond
    is separate. A confirmed T_ORACLE_SLASH against the attester
    causes the indexer to mark the LP shares as **forfeit**: they
    are no longer counted toward the attester's bond, and an
    equivalent amount of LP shares is credited to the challenger's
    account in the indexer's state.
  - When the attester later broadcasts the on-chain CSV withdraw,
    the indexer sees the UTXO consumed but refuses to credit the
    LP shares back to the attester — they were already forfeit.
    The on-chain bitcoin sats unlock but the indexer-level LP
    accounting honors the slash.
  - In effect: the attester's CSV unlock returns a "zero-value"
    LP-share withdrawal (no economic value); the challenger
    redeems their credited LP shares against the AMM pool at
    market price.

  This is meaningful but not perfect — the attester could refuse
  to broadcast the withdraw, leaving sats stuck on-chain
  indefinitely (their loss). A future covenant-enabled enforcement
  could make slashing on-chain cryptographic.

- **`protocol_yield_address(epoch)`** — see §6.3.4. Holds
  accumulated 5% stability fees + per-epoch cUSD borrow-rate
  mints; distributed at epoch boundary via FROST signing round.

- **`keeper_hold_address(dlc_outpoint, band_K)`** — see §6.3.4.
  Anyone-can-spend Taproot output created by a liquidation
  outcome tx. The leaf script `<dlc_outpoint> OP_DROP <band_K>
  OP_DROP OP_TRUE` makes each (dlc_outpoint, band_K) yield a
  **distinct address**, preventing conflation of concurrent
  liquidations. First keeper to broadcast a claim_tx wins the
  contents of that specific UTXO.

---

## §6.6 Bootstrap operational requirements (cross-reference)

Bootstrap-phase operational mechanics are normatively specified in
**§6.1.7 *Bootstrap*** above. Summary:

- Bootstrap key is a **spec constant** declared in this amendment's
  Genesis Constants section (§6.8) rather than via a runtime
  envelope. Eliminates a per-deployment trust ceremony.
- Bootstrap operator publishes T_PRICE_ATTEST at the same cadence
  the threshold oracle would (per 6 blocks for active pairs).
- External price source: named-sources median per §6.1.7
  (Pyth Network, Coinbase, Kraken, Binance, mempool.space), with
  2% deviation check + slashable bond.
- Sunset deadline: graduation by epoch 52 OR forfeiture of bootstrap
  bond + immediate CSV-rescue rights for all open CDPs.

After graduation (§6.1.7):
- Bootstrap key has no protocol-level privileges.
- All attestations are FROST-threshold-signed.
- Bootstrap operator MAY remain as one of the active attesters by
  bonding LP shares like anyone else.

---

## §6.7 Genesis constants

This amendment introduces three protocol constants that must be
pinned at amendment land-time (before any cBTC or cUSD CDP can
open):

| Constant | Mainnet value | Signet value | Purpose |
|---|---|---|---|
| `bootstrap_pubkey` | TBD before mainnet land (e.g., TAC team x-only pubkey) | Hardcoded TBD | Single-attester oracle key during epoch 0 |
| `bootstrap_bond_address` | P2TR(NUMS, [OP_CHECKSIG bootstrap_pubkey] OP_CSV 52×1008) | analogous | Slashable bond escrow during bootstrap |
| `bootstrap_bond_amount` | 100,000,000 (1 BTC) | 100,000,000 | Bond size |
| `genesis_seed_price_usd` | 50000 (u32 USD/BTC, integer) | 50000 | Epoch-0 band-layout seed price (§6.3.6); rebased at each subsequent epoch boundary from the prior epoch's last attestation |

Because these are spec constants (not runtime envelopes), no
`T_ORACLE_INIT` opcode is needed at protocol activation. Indexers
hardcode the values at amendment-land time. Discrepant bootstrap
keys across implementations would fork; the spec is the source of
truth.

If the bootstrap operator must be replaced before graduation (key
compromise, operator abdication), a hard fork via a new spec
amendment is the only path — no in-protocol replacement mechanism
in V1.

### Genesis envelope (T_ORACLE_INIT replacement — none needed)

Round-1 referenced a `T_ORACLE_INIT` envelope; on reflection,
that's eliminated in favor of spec constants. Indexers initialise
the oracle state at amendment-activation height directly:

```
oracle_state @ activation_height = {
  epoch: 0,
  attester_aggregate_key: bootstrap_pubkey,
  active_set: { bootstrap_pubkey },
  threshold: 1,    // single-key bootstrap; FROST trivially-1
  nonce_commit_root: empty (no banded outcomes during bootstrap),
  bond_account: bootstrap_bond_address (preloaded 100,000,000 sats)
}
```

The bootstrap key publishes T_PRICE_ATTEST envelopes (§6.1.4) with
`participating_count = 1, participating[] = [bootstrap_pubkey]`.
These are valid sigs under bootstrap_pubkey directly (no FROST
aggregation needed for trivial 1-of-1).

### Bootstrap source-divergence aborts

If the named external sources (§6.1.7 *Bootstrap price source
specification*) diverge by more than 2%, the bootstrap operator
SKIPS publishing the attestation for that interval. **No special
abort envelope is published**; the absence of an attestation is
itself the signal. Indexers SHOULD alert when bootstrap attestation
freshness drops below 3× the schedule (per the freshness factor
formula in the wrapper amendment §4.2.4).

This removes the `T_ORACLE_BOOTSTRAP_ABORT` opcode referenced in
round-1 — silence is the signal, not a noise-producing envelope.

### Graduation-delay justification

If AMM TVL hasn't reached the 100-BTC graduation threshold by
epoch 52, the bootstrap operator publishes a regular
`T_ORACLE_GRADUATE` envelope (opcode `0x40`) with a special flag
indicating graduation against the sunset clock (rather than the
TVL trigger). The indexer accepts the graduation and proceeds
with FROST DKG against whatever attesters are queued. If no
attesters are queued, all open CDPs revert to CSV-rescue mode
immediately (§6.1.7 *Sunset clause*).

This removes the `T_ORACLE_EMERGENCY` opcode referenced in
round-1 — graduation against the sunset clock uses the existing
T_ORACLE_GRADUATE machinery with a flag rather than a separate
envelope type.

---

## §6.8 Test plan

The implementation PR landing this amendment MUST include:

1. **Oracle DKG correctness.** Independent attesters run FROST DKG,
   produce a coherent `attester_aggregate_key`, sign a test
   attestation, verify under the aggregate key. At least 4-of-5 and
   7-of-11 threshold tests.

2. **Deterministic price computation.** Three independent
   implementations (TS, Python, Rust) compute identical
   `median_twap` over a 1000-block synthetic AMM history. Output
   bit-equal.

3. **Slashing detection.** Inject a divergent attestation; verify
   that any party can publish a T_ORACLE_SLASH that the indexer
   validates and applies. Verify the slashed attester's bond is
   transferred to the challenger.

4. **CDP lifecycle (cBTC).** End-to-end on signet: user opens CDP,
   mints cBTC, trades cBTC in AMM, burns cBTC, redeems sats. Verify
   coverage stays exactly 1.0 throughout.

5. **CDP lifecycle (cUSD).** Similar but with oracle-priced mint
   ceiling. Verify: mint at 150% collateral; price drops 20%;
   liquidation fires; keeper claims at 5% discount; protocol earns
   5%. Verify all amounts.

6. **CSV self-rescue.** Mock oracle going dark; advance chain by
   26280 blocks; verify user can unilaterally recover sats via
   leaf-N+2 path; verify their cBTC/cUSD is marked as "violation
   supply" in indexer state.

7. **Bootstrap → graduation transition.** Simulate AMM TVL
   crossing 100 BTC equivalent; verify graduation envelope is
   accepted; verify bootstrap key loses special status.

8. **Multi-attester rotation.** Run 3 epochs with different
   attester sets; verify each epoch's attestations are valid only
   under the corresponding epoch's aggregate key.

9. **AMM-oracle integration.** With canonical cBTC + cUSD live on
   signet, seed AMM pools, run synthetic trade history, verify
   that the oracle's published TWAP matches the expected
   median-weighted value within 0.1%.

10. **Backwards-compat replay.** Snapshot 50 historical mainnet
    transactions; verify verdicts before/after the amendment
    byte-identical.

---

## Backwards compatibility

Same shape as the wrapper amendment:

- **Every existing opcode and asset is unaffected.** The amendment
  adds opcodes `0x39`–`0x42` and asset-id origin path 4. Nothing
  existing changes.
- **Pre-amendment indexers** encountering T_PRICE_ATTEST,
  T_ORACLE_*, T_CDP_* envelopes treat them as unknown opcodes per
  §4.1 (transactions ignored). No state corruption; no chain
  rejection.
- **Canonical cBTC and cUSD asset_ids do not exist** in pre-
  amendment indexer state. After the amendment lands, indexers
  synthesize them from the spec constants; they appear as
  zero-supply assets until the first T_CDP_OPEN mint.
- **AMM pools using canonical asset_ids** can only be opened after
  the amendment lands. POOL_INIT validators that don't recognize
  the asset_ids reject the pool init — same as for any unknown
  asset_id. Post-amendment indexers accept the pools.

---

## Out of scope

1. **Protocol-parameter governance.** Adjusting LTV, liquidation
   threshold, stability fee, borrow rate post-launch. V2 amendment
   covers this.
2. **Multi-collateral CDPs.** V1 cUSD accepts only sats as
   collateral. Future: lock LP shares, other tacit assets, or
   wrapped runes as collateral.
3. **Partial liquidations.** V1 liquidates the full CDP at once.
   Future: keeper can partially close a CDP, leaving the remaining
   collateralization intact.
4. **Cross-margining.** Multiple CDPs sharing collateral risk pool.
5. **Insurance fund.** Protocol-managed pool that backstops
   under-collateralized CDPs (where collateral value drops below
   100% before liquidation completes). V1 socializes shortfall
   across cUSD holders (proportional supply reduction); insurance
   would smooth this.
6. **Covenant-enforced burn binding.** CSV self-rescue leaves a
   "violation supply" anomaly without enforcing burn. Future
   covenants would fix this cryptographically.
7. **Oracle attester reward customization.** All attesters share
   stability fees equally weighted by bond. Future: performance-
   based weighting (uptime, attestation freshness).

---

## Open questions for review

1. **Bootstrap operator selection.** Who specifically? TAC team
   alone or a multi-party operator? Should bootstrap require
   threshold even during phase 0?

2. **Liquidation discount sizing.** 5% to keeper vs 8% vs 10%.
   Higher discount = more aggressive keeper pursuit = tighter
   peg, at the cost of liquidated users' worse recovery.
   Reference impl uses 5% but worth a market study.

3. **Borrow rate dynamism.** Fixed 2% APR is simple but doesn't
   respond to market conditions. Maker uses dynamic rates per
   collateral type. V2 candidate.

4. **CSV escape duration.** 26280 blocks (~6 months) is long but
   conservative. Trade-off: longer escape = stronger commitment
   from oracle but more user illiquidity if they need to escape.

5. **FROST DKG vs MuSig2 aggregation.** FROST allows dynamic
   set rotation; MuSig2 is simpler but requires full re-DKG on
   changes. V1 uses FROST for flexibility; MuSig2 considered if
   FROST libs prove fragile.

6. **Attester reward burn-vs-distribute.** Excess stability fees:
   burn (deflationary for cBTC) or distribute to all canonical
   cBTC holders pro-rata? Burn is simpler; distribute is fairer.

7. **Oracle pair scope.** V1 only attests BTC/USD (via cUSD/cBTC
   pools). Future pairs (BTC/EUR, BTC/JPY, ASSET/USD) require
   per-pair attester sets or a single set attesting many pairs.

---

## Sign-off checklist for landing

- [x] Initial author draft (this file).
- [x] Peer-agent review (round 1) — DLC adaptor sig storage gap,
  oracle non-price event mechanism, slashing target ambiguity,
  T_ORACLE_PETITION undefined, nonce pre-commitment lifecycle,
  bootstrap external price source under-specified, borrow-rate
  economics, fixed min CDP size, cBTC over-engineering, u128 vs
  u64 price, canonical metadata IPFS-pin mismatch.
- [x] Round 1 fix (CRITICAL): added `adaptor_sigs_cid` field to
  T_CDP_OPEN; new §6.3.10 *Adaptor sig pinning* with worker +
  attester pinning responsibilities + optional on-chain backup
  via new T_CDP_ADAPTOR_BACKUP opcode (`0x42`).
- [x] Round 1 fix (CRITICAL): cBTC simplified to direct 2-of-2
  threshold cooperative signing — no adaptor-sig DLC machinery
  required for fixed-peg cBTC; oracle co-signs on burn observation
  via FROST round. cUSD keeps full adaptor-sig DLC for
  price-conditional outcomes.
- [x] Round 1 fix (CRITICAL): slashing now applies to ALL
  participating attesters proportionally; T_PRICE_ATTEST envelope
  adds `participating_count + participating[]` fields fixing the
  slash target set unambiguously.
- [x] Round 1 fix (CRITICAL): T_ORACLE_PETITION removed; replaced
  with concrete `T_ORACLE_EMERGENCY_DKG` opcode (`0x41`) for
  mid-epoch DKG after slashing degradation; conditions and
  fallback behavior specified.
- [x] Round 1 fix (BLOCKING): nonce pre-commitment lifecycle
  spec'd via `nonce_commit_root` in T_PRICE_ATTEST plus
  `band_index` field for per-band adaptor secret release;
  attesters publish per-band nonce commitments at epoch start
  via FROST DKG (implementation-level detail).
- [x] Round 1 fix (BLOCKING): bootstrap external price source
  pinned to 3+ specific named sources (Pyth, Coinbase, Kraken,
  Binance, mempool.space); median computation + 2% deviation
  threshold + bootstrap operator bond (1 BTC) for accountability;
  slashable during bootstrap via T_ORACLE_SLASH.
- [x] Round 1 fix (MEDIUM): cUSD borrow rate reworked — protocol
  MINTS new cUSD into a yield account each epoch instead of
  fixing supply; outstanding cUSD purchasing power stays at peg
  without squeeze pressure on borrowers; attesters paid in cUSD
  (sells on market) + liquidation sats.
- [x] Round 1 fix (MEDIUM): min CDP size has hard floor (100k
  sats) AND dynamic operational minimum based on current fee
  rate (keeps per-CDP Bitcoin fee below 5% of CDP value);
  dapp/worker enforces dynamic minimum, indexer enforces hard
  floor.
- [x] Round 1 fix (MINOR): cBTC direct co-signing (as above).
- [x] Round 1 fix (MINOR): u64 price ratios in T_PRICE_ATTEST
  (was u128).
- [x] Round 1 fix (MINOR): §6.4.3 explicit about metadata-CID
  divergence for canonical wrappers; reference metadata
  template provided.
- [x] Peer-agent review (round 2) — oracle CDP-open protocol
  ambiguity, keeper enforcement gap, §6.2.2/§6.2.3 inconsistency,
  band_index 254 enum missing, §6.6 stale bootstrap text, opcode
  range mismatch in backwards-compat/checklist, FROST/multisig
  framing confusion in §6.3.5, undefined opcodes
  (T_ORACLE_INIT/BOOTSTRAP_ABORT/EMERGENCY), missing domain tags,
  undefined backup_msg, decimal-vs-integer liquidation math,
  CID length, bps consistency.
- [x] Round 2 fix (CRITICAL): per-epoch nonce-commit lifecycle
  formalised — FROST DKG output now includes a Merkle root over
  per-band nonces (R_0..R_{N-1}, R_254, R_255_unused); CDP open
  binds adaptor sigs to epoch-level commits without per-CDP FROST
  rounds. Trade-off documented: a band-K release liquidates ALL
  CDPs open in that epoch with adaptor sigs at band K.
- [x] Round 2 fix (CRITICAL): keeper enforcement spec'd via
  pre-signed exact-vout outcome txs (95% to keeper_hold_address,
  5% to protocol_yield_address) — protocol fee is now
  Bitcoin-script-enforced at the vout structure level, not merely
  indexer policy. Keeper race resolved by first-broadcast on the
  follow-up claim tx (keeper_hold is anyone-can-spend).
- [x] Round 2 fix (BLOCKING): §6.2.2 leaf-1 description aligned
  with §6.2.3 simplification — cBTC uses direct FROST cooperative
  signing, not adaptor sigs.
- [x] Round 2 fix (BLOCKING): `band_index = 254` added to §6.1.4
  enum for cUSD self-redeem; full encoding documented.
- [x] Round 2 fix (BLOCKING): §6.6 replaced with cross-reference
  pointing back to §6.1.7's detailed bootstrap spec.
- [x] Round 2 fix (BLOCKING): opcode range corrected to
  `0x39`–`0x42` in backwards-compat + sign-off checklist.
- [x] Round 2 fix: bootstrap key is now a **spec constant**
  (§6.7 *Genesis constants*) rather than runtime envelope —
  T_ORACLE_INIT eliminated. T_ORACLE_BOOTSTRAP_ABORT eliminated
  (silence-as-signal). T_ORACLE_EMERGENCY eliminated (reuse
  T_ORACLE_GRADUATE with flag).
- [x] Round 2 fix: §6.3.5 "3-of-5 multisig" replaced with
  "FROST threshold at `protocol_yield_address(epoch)`" — same
  threshold key signs attestations + distributes yield. No
  separate multisig.
- [x] Round 2 fix: added `tacit-oracle-emergency-dkg-v1` and
  `tacit-cdp-adaptor-backup-v1` to §6.5 BIP-340 message tags;
  defined `backup_msg` formula at §6.3.10.
- [x] Round 2 fix: liquidation discount + stability fee now use
  bps integer arithmetic; `liquidation_discount_bps = 500`,
  `stability_fee_bps = 500`; outcome tx vouts computed by
  `floor(collateral × bps / 10000)`.
- [x] Round 2 fix: `adaptor_sigs_cid` widened to 36 bytes (CIDv1
  raw sha256 multihash) per realistic IPFS CID size.
- [x] Round 2 fix: §6.5 *Address / script derivations* expanded
  with full Taproot script templates for `bond_addr`,
  `protocol_yield_address`, `keeper_hold_address`.
- [x] **Third-round peer review** of round-2 revisions completed.
  Found: stale T_ORACLE_BOOTSTRAP_ABORT reference in §6.1.7;
  per-CDP-FROST-round contradiction between §6.1.4 and §6.3.3;
  §6.2.5 CSV-rescue leaf-2 script stack bug (OP_TOALTSTACK after
  empty stack); §6.1.5 slash_fraction wording self-contradictory;
  T_ORACLE_SLASH `computed_price_num/den` 16-byte vs
  T_PRICE_ATTEST 8-byte mismatch; T_PRICE_ATTEST envelope size
  math wrong (123 vs actual 161); band-index semantics ambiguous
  (per-CDP-relative vs protocol-uniform); bond_addr leaf A
  required attester's own sig for slashing (unenforceable);
  keeper_hold_address identical script across all (dlc_outpoint,
  band_K) collapsed to a single address; `tacit-oracle-bond-v1`
  domain tag missing from §6.5 listing.
- [x] Round 3 fix (CRITICAL): §6.1.7 stale `T_ORACLE_INIT` /
  `T_ORACLE_BOOTSTRAP_ABORT` references removed; bootstrap key
  declared via §6.7 *Genesis Constants*; bootstrap source-
  divergence handled via silence-as-signal (no abort envelope).
- [x] Round 3 fix (CRITICAL): adaptor sig flow clarified. §6.1.4
  no longer claims "no per-CDP FROST round"; documents the actual
  cost (N FROST rounds per CDP open producing oracle-side adaptor
  pre-signatures over per-CDP outcome tx sighashes, with per-epoch
  R_k commitments reused across all CDPs). §6.3.3 leaf-2
  comment rewritten: all N bands share the same leaf script; the
  per-band distinction lives in pre-signed outcome txs +
  adaptor_sigs_cid contents, not in the tap-tree. §6.3.10
  updated: pre-sigs are oracle-threshold-produced, not user-
  produced; user's only sig is over T_CDP_OPEN.
- [x] Round 3 fix (CRITICAL): §6.2.5 CSV-rescue leaf-2 script
  reverted to clean form (`<26280> OP_CSV OP_DROP <user_pubkey>
  OP_CHECKSIG`); broken OP_TOALTSTACK removed; indexer-level
  T_BURN binding documented as off-chain enforcement.
- [x] Round 3 fix (BLOCKING): §6.1.5 slash fraction reworked.
  `slash_fraction` is a fixed bps-denominated fraction of each
  participating attester's bond (V1 default 10000 bps = 100%
  slashing); slashed pool distributed to challenger
  (V1 default 100%). Separable bps for future amendments.
- [x] Round 3 fix (BLOCKING): T_ORACLE_SLASH `computed_price_num`
  and `computed_price_den` widths reduced from 16 to 8 bytes,
  matching T_PRICE_ATTEST's u64 representation.
- [x] Round 3 fix (BLOCKING): T_PRICE_ATTEST envelope size math
  corrected from `123 + 32 × participating_count` to
  `161 + 32 × participating_count`. Typical t=15 attestation:
  641 bytes (not 603). `participating_count` valid range
  documented (1..32 in V1).
- [x] Round 3 fix (BLOCKING): §6.3.6 band layout spec'd as
  **protocol-uniform absolute USD-price thresholds**, not per-CDP
  collateral-ratio bands. Per-epoch band vector `[X_0..X_{N-1}]`
  derived deterministically from prior epoch's final attestation
  price (band-0 = 2× P_final, step 5% relative, N=20). Per-CDP
  outcome txs cover all N bands; bands above CDP's liquidation
  price are no-op refunds.
- [x] Round 3 fix (BLOCKING): `bond_addr` leaf-A removed (it was
  unenforceable — required attester's own sig for slashing).
  Single CSV-locked withdraw leaf retained; slashing model
  documented as indexer-level (LP-share account marked forfeit;
  on-chain UTXO unlock returns zero-value LP-share withdrawal).
- [x] Round 3 fix (BLOCKING): `keeper_hold_address(dlc_outpoint,
  band_K)` script revised to include `<dlc_outpoint> OP_DROP
  <band_K> OP_DROP OP_TRUE` — distinct addresses per
  (dlc_outpoint, band_K) instead of one shared anyone-can-spend
  address.
- [x] Round 3 fix (BLOCKING): `tacit-oracle-bond-v1` domain tag
  added to §6.5 BIP-340 message tag list.
- [x] **Fourth-round peer review** of round-3 revisions completed,
  with AMM-CDP harmonization audit. Found: §6.1.4 R_k vs S_k
  naming confusion (R = nonce point, S = adaptor point = s·G;
  reuse semantics differ); §6.3.5 "running keeper bots" incorrectly
  listed under attester cost (keepers are anyone-can-spend);
  §6.3.6 band-layout seed `P_final` undefined for epoch 0; §6.1.3
  `wrapper_registry.pools_for(asset_pair)` underspecified;
  §6.1.2 attester bond aggregation across multiple lp_asset_ids
  ambiguous; AMM ↔ CDP integration gaps: canonical-asset pools
  must disable AMM protocol fee (else double-charging LPs);
  oracle TWAP retention horizon unspecified on indexer side.
- [x] Round 4 fix (CRITICAL): §6.1.4 adaptor sig construction
  rewritten in terms of `S_k = s_k·G` (per-band adaptor-point
  commitments) instead of `R_k` (which would imply nonce reuse).
  Per-CDP pre-sigs use fresh FROST nonce R'_K adaptor-encrypted
  under S_k; revealing `s_k` (scalar) completes them.
  `nonce_commit_root` Merkle leaves now documented as S_k values,
  name retained for backwards compat with prior drafts.
  Implementation MUST follow the validated DLC-on-FROST adaptor
  pattern (RFC 9591 + DLC v0).
- [x] Round 4 fix (BLOCKING): §6.3.5 attester-yield list cleaned —
  removed "running keeper bots" (keepers are not attester
  responsibility); kept attestation publishing, IPFS pinning, and
  FROST DKG participation as legitimate attester costs.
- [x] Round 4 fix (BLOCKING): §6.3.6 epoch-0 band layout handled
  via new `genesis_seed_price_usd` spec constant (§6.7; V1 default
  $50,000/BTC). Subsequent epochs rebase from prior epoch's final
  attestation price; degraded-mode fallback inherits from the
  most recent valid prior epoch.
- [x] Round 4 fix (BLOCKING): §6.1.3 `pools_for(asset_pair)`
  formalised as indexer-derived view: wrapper-registry enumeration
  of variants for each asset, cross-joined against AMM pool
  existence (one `pool_id` per `(variant_A, variant_B)` pair).
- [x] Round 4 fix (BLOCKING): §6.1.2 attester bond restricted to
  the **canonical cUSD/cBTC pool's `lp_asset_id` only** for V1.
  Federated variant pools feed price TWAP but don't qualify as
  bond collateral. Eliminates multi-lp_asset_id bond accounting.
- [x] Round 4 fix (BLOCKING): new §6.4.4 *Canonical-pool AMM-fee
  constraint* — POOL_INIT for any pool containing canonical cBTC
  or cUSD MUST set `protocol_fee_address = 33×0x00`. Prevents
  double-charging LPs (CDP stability fee + borrow rate is the
  protocol revenue mechanism; AMM protocol fee on top would
  dampen LP incentive for the oracle bond pool).
- [x] Round 4 fix (BLOCKING): §6.1.3 indexer retention requirement
  pinned at `max(window_blocks, 1008)` blocks for any indexer
  serving as an oracle source or verifier.
- [x] Round 4 fix (MEDIUM): §6.1.4 `participating_count` range
  1..32 in V1 documented as a normative MUST (was informational).
- [x] Round 4 fix (MEDIUM): `genesis_seed_price_usd` added to
  §6.7 Genesis Constants.
- [ ] **Fifth-round peer review** of round-4 revisions (optional
  per past convention).
- [ ] Independent crypto review (round 1).
- [ ] Independent crypto review (round 1).
- [ ] Independent crypto review: FROST DKG; adaptor sig
  construction for cBTC + cUSD liquidation outcomes; slashing
  validator algorithm; CSV self-rescue script semantics.
- [ ] Confirm opcodes `0x39`–`0x42` collision-free against the
  live + reserved opcode list.
- [ ] Confirm all new domain tags collision-free.
- [ ] Confirm canonical asset_id derivations (path 4) do not
  collide with any extant asset_id on any network.
- [ ] Update the `SPEC.md` preamble opcode list.
- [ ] Update §3 (BIP-340 message tag list with the 12 new tags
  enumerated above; SHA256 domain tag list with `tacit-oracle-bond-v1`).
- [ ] Update §4.1 (extend "Three-origin resolution" → "Four-origin
  resolution" with the canonical-asset path).
- [ ] Update §6 to add §6.1–§6.8.
- [ ] **AMM.md downstream edits (at merge time):** update
  "Three-origin asset_id resolution" to "Four-origin" with the
  canonical cBTC/cUSD path; cross-reference §6.4.4's
  canonical-pool AMM-fee disable rule from AMM's
  "Protocol fee mechanism" section; note CDP oracle's retention
  requirement on the indexer-state retention discussion (if added).
- [ ] Indexer + dapp + worker implementation PR opened (separate).
- [ ] DLC adaptor-sig library landed (oracle attester + user signing).
- [ ] FROST DKG library integrated or reimplemented.
- [ ] Signet bootstrap test: full cBTC + cUSD lifecycle with mock
  attester set, including liquidation + CSV rescue.
- [ ] Reference dApp UI: CDP open / close / monitor.
- [ ] Reference oracle attester worker.
- [ ] Reference keeper bot.
- [ ] Public bootstrap deployment plan: who is the bootstrap key,
  how is the AMM TVL threshold measured, what's the graduation
  ceremony.

---

*End of amendment draft.*
