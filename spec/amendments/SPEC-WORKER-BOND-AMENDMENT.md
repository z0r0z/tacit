# SPEC Amendment — Worker Bond + Equivocation Slash for `T_INTENT_ATTEST`

> Status: 📝 Draft (round-1)
> Depends on: `T_INTENT_ATTEST` (`0x30`, SPEC.md §5.17) — the
> scope-generic preconfirmation primitive. `SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md`
> and the AMM channel scope schemas (AMM.md §"Preconfirmation
> layer") consume this primitive today.
> `SPEC-CBTC-TAC-AMENDMENT.md` (§5.34) established the TAC-as-
> slashable-bond pattern with indexer-state slashing (the
> `SLASH_DETECTED` precedent — slash as state event, no Bitcoin-
> layer spend of the bonded UTXO).
> `SPEC-WRAPPER-AMENDMENT.md` supplies the `protocol_bonded`
> Taproot construction the bond UTXO uses (cooperative key-path
> spending requires worker + federation co-sig; no unilateral
> worker withdrawal).
> `SPEC-GOVERNANCE-AMENDMENT.md` supplies the safety-band
> parameter framework (`INITIAL_BOND_RATIO`, `MAX_BONDED_FRAC_OF_TAC_FDV`).
>
> Adds three opcodes (`T_WORKER_BOND_OPEN`, `T_WORKER_BOND_CLOSE`,
> `T_WORKER_SLASH`; tentative bytes `0x5B`/`0x5C`/`0x5D` — final
> assignment at merge) that turn the existing per-worker
> equivocation flag into a **cryptographically evident, economically
> credible** consequence: a worker that signs two
> `T_INTENT_ATTEST` envelopes at the same `(scope_id, worker_pubkey,
> observed_height)` with different `intent_pool_hash` has its
> posted TAC bond **burned at the indexer layer** (removed from
> the TAC supply by reattribution), with a fixed fraction
> redirected to the slash submitter as a reporter bounty before
> the burn.
>
> The bond is denominated in **TAC**. No new cryptographic
> primitive. No new ceremony. No change to `T_INTENT_ATTEST`'s wire
> format or validator. The slash itself is an indexer-internal
> state transition — the reporter's tx pays only Bitcoin fees and
> publishes the evidence + their bounty-receipt vout; the bond
> UTXO is never spent on the Bitcoin layer and becomes inert
> dust after slash (federation refuses to co-sign any subsequent
> cooperative close).

---

## Motivation

The channel layer (T_INTENT_ATTEST plus the orderbook / AMM scope
schemas) is what lets traders act before Bitcoin confirmation:
post an intent to a worker, get a chain-attested
`intent_pool_hash` within ~30 s, fill against another trader's
matching intent inside the same window, and only hit Bitcoin once
for the eventual settlement (or, with T_TRADE_BATCH, once for the
combined settlement). The fee win is real: limit orders that
never match cost zero on-chain, and matched orders share a
Bitcoin tx via the existing batching primitives.

What the layer is missing — explicitly called out as out-of-scope
in the orderbook channel amendment ("equivocation evidence sits
in the indexer's flag-set; what dapps DO with that evidence is
policy") and in the mesh amendment ("any of these patterns is
**soft-suspicious** … but not slashable") — is an automated,
on-chain consequence for the one attack the channel construction
makes tamper-evident: per-worker equivocation across a single
`(scope_id, observed_height)`.

Today a trader who detects equivocation can only:

- mark the worker untrusted in their local dapp state,
- broadcast the evidence socially.

Neither hurts the worker enough to deter the attack at scale. A
worker that runs both sides of a market-making operation can
absorb a few reputation hits for a profitable equivocation that
front-runs a large trader's intent. The asymmetry — costless
attestation, costly detection, no slash — is what keeps the
channel layer "soft" and forces traders who care about safety to
wait for Bitcoin confirmation anyway.

This amendment closes that asymmetry. A worker that wants traders
to honor its `T_INTENT_ATTEST` envelopes as soft-confirms locks a
TAC bond in a `protocol_bonded` Taproot UTXO whose cooperative
release requires a fixed protocol federation's co-signature (the
same federation that gates cBTC.tac slot operations). The bond
is releasable cooperatively after a notice period with no
outstanding equivocation evidence; it is **slashable by anyone**
who submits two conflicting `T_INTENT_ATTEST` envelopes signed
by the same `worker_pubkey` at the same height for the same
scope.

Slashing is an indexer-internal state transition, not a Bitcoin-
layer UTXO spend: the indexer marks `bond.state = "slashed"`,
reattributes a configurable fraction of the bonded TAC to a vout
declared in the reporter's slash transaction (the bounty), and
removes the remainder from circulation by recording it as
burned. The bond UTXO itself sits on Bitcoin permanently — the
federation refuses to co-sign cooperative close once the slash
is indexer-recorded, so the worker cannot recover any of the
locked sats either. Honest monitoring becomes positive-expected-
value for any third party who can construct the evidence pair
from on-chain envelopes.

**Why TAC, not BTC, for the bond.** The ecosystem alignment is
the strong reason: TAC already underwrites cBTC.tac, has a
proven indexer-state slashing precedent (`SLASH_DETECTED`), and
has governance-bounded supply parameters. A second slashable-TAC
role for workers reuses the same TAC asset model and the same
value-capture loop without introducing a new collateral class.
The honest asymmetry — fraud opportunities are BTC-denominated,
the bond is TAC-denominated — is handled the same way cBTC.tac
handles it: `INITIAL_BOND_RATIO ≥ 2.0` overcollateralization,
governance-bounded ratio safety bands, and a soft-warning state
when the mark-to-market TWAP ratio drifts below threshold. Hard
slashing fires only on cryptographic evidence (the two-envelope
conflict proof); price drift alone never burns a bond.

**Why burn the slashed TAC instead of pooling it.** cBTC.tac
sinks its slashes into an insurance pool that pays back cBTC.tac
holders pro-rata — the wrapper's stakeholders and its slash
victims are the same set. Channel-layer slashes have a different
beneficiary topology: the traders harmed by a worker's
equivocation are arbitrary intent-posters, not identifiable as a
proportional class, and the cBTC.tac wrapper holders aren't the
party that was misled. Routing channel-layer slashes into the
cBTC.tac pool would be plumbing convenience, not principled
risk-bearing alignment.

Burning the slashed TAC (minus reporter bounty) sidesteps the
distribution question and exploits the protocol's structural
advantage: **TAC has a fixed 21-million-base-unit cap**, so a
burn is permanent supply contraction, not just a temporary
treasury redirect. Every TAC holder's pro-rata claim to the
fixed supply strengthens by the slash amount. The deterrent
also strengthens monotonically over time as the bonded base
grows against a shrinking float. No claim mechanism to design,
no cross-stakeholder weirdness, no on-chain insurance-pool
accounting to maintain alongside cBTC.tac's.

---

## §5.X Worker bond lifecycle (overview)

(SPEC.md section number tentative; lands as §5.X after the
existing channel-layer block. Sub-sections are §5.X.1 …
§5.X.5 below.)

A bond is identified by `(worker_pubkey, bond_outpoint)`. State
held by the indexer per bond:

```
bond_state = {
    worker_pubkey:        33-byte compressed secp256k1
    bond_outpoint:        txid_BE(32) || vout_LE(4); the UTXO holding
                          the bonded TAC (Pedersen commit + asset
                          binding per the standard tacit asset model)
    bond_amount_tac:      u64 (TAC base units; opening reveal)
    opened_at_height:     u32
    notice_initiated_at:  u32 | null  (set by T_WORKER_BOND_CLOSE
                                       step 1; null until then)
    state:                "active" | "closing" | "closed" | "slashed"
}
```

The worker may hold multiple concurrent bonds (e.g., to scale
soft-confirm coverage across many scopes); each is tracked
independently. The dapp's soft-confirm rating MAY sum bond
amounts across a worker's active bonds when deciding "is this
worker bonded enough to honor for this intent value."

State transitions:

```
            T_WORKER_BOND_OPEN
                  │
                  ▼
              active ─────────────────────┐
                  │                       │
       T_WORKER_BOND_CLOSE (step 1)       │
                  │                       │
                  ▼                       │
              closing ──────────────┐     │
                  │                 │     │
       wait notice_blocks; no       │     │
       equivocation evidence        │     │
                  │                 ▼     ▼
                  ▼              T_WORKER_SLASH
      T_WORKER_BOND_CLOSE             │
              (step 2)                ▼
                  │                slashed (terminal)
                  ▼
              closed (terminal)
```

`T_WORKER_SLASH` is valid in **either** "active" or "closing"
states — the notice period does not insulate a worker from
slashing for equivocation that occurred during their active
period. A bond in "slashed" or "closed" state is no longer
slashable (slash state transitions are terminal at the indexer;
cooperative close has already returned the TAC to the worker).

---

## §5.X.1 `T_WORKER_BOND_OPEN` (tentative `0x5B`) — open a bond

### Wire format

```
opcode(1)              = 0x5B
worker_pubkey(33)        compressed secp256k1; the attesting key
                         this bond underwrites
bond_tac_amount_LE(8)    u64; cleartext TAC amount being locked
C_bond_secp(33)          Pedersen commit to bond_tac_amount under
                         asset_id_TAC (standard tacit asset commit;
                         see SPEC.md §5.4)
C_bond_BJJ(32)           BJJ-curve commit (cross-curve binding;
                         standard tacit asset model)
xcurve_sigma(~200)       Cross-curve equivalence proof binding
                         C_bond_secp and C_bond_BJJ to the same
                         cleartext amount (standard primitive)
opener_sig(64)           BIP-340 over
                         SHA256("tacit-worker-bond-open-v1"
                                || worker_pubkey
                                || bond_tac_amount_LE
                                || C_bond_secp
                                || C_bond_BJJ
                                || vin[0] outpoint)
                         under worker_pubkey
```

The TAC-asset UTXO created by this tx at `vout[1]` — a
`protocol_bonded` Taproot output (cooperative MuSig2 key-path:
`worker_pubkey + federation_keyset`) — **is** the bond. Its
outpoint is the `bond_outpoint` recorded in `bond_state`. See
`Bitcoin tx layout` below for the full output discipline and
`Validator algorithm` for the rejection criteria when the wrapper
construction is malformed.

### Bitcoin tx layout (normative)

```
vin[0]                  worker's TAC input(s) — standard tacit
                        asset input covering bond_tac_amount;
                        signed SIGHASH_ALL by worker_pubkey
vout[0]                 OP_RETURN(envelope_hash) — 0 sat
vout[1]                 Bond UTXO — protocol_bonded Taproot output
                        per SPEC-WRAPPER-AMENDMENT.md. Key-path
                        spending is a MuSig2 aggregate of
                        worker_pubkey and the protocol federation
                        key-set fixed at indexer genesis (same
                        federation cBTC.tac slots use). No script-
                        path spend. The worker cannot unilaterally
                        spend; cooperative release requires
                        federation co-signature per §5.X.2 step 2.
                        Carries the TAC asset commit for
                        bond_tac_amount; sats value at protocol
                        dust minimum.
vout[2..]               Optional change / fee outputs
```

`bond_outpoint` resolves to `(txid_of_this_tx, 1)`.

### Validator algorithm

```
on T_WORKER_BOND_OPEN at confirmation depth ≥ 1:
    require opcode == 0x5B
    decode payload; reject on structural error
    verify opener_sig under worker_pubkey
    verify xcurve_sigma binds C_bond_secp ↔ C_bond_BJJ to
        bond_tac_amount under asset_id_TAC
    verify vin[0] supplies a valid TAC input ≥ bond_tac_amount
        (standard tacit asset input check)
    verify vout[1] is a protocol_bonded Taproot output (per
        SPEC-WRAPPER-AMENDMENT.md) whose internal-key MuSig2
        aggregate commits to {worker_pubkey} ∪ federation_keyset.
        Reject if any script-path leaf is present, or if the
        aggregate omits the federation. Without this check the
        worker could trivially supply a single-sig output and
        rug the bond.

    require bond_tac_amount ≥ MIN_BOND_TAC               (governance band)
    require bond_tac_amount ≤ MAX_BOND_TAC_PER_TX         (governance band; anti-mistake)
    require (total_active_worker_bonded_TAC + total_cBTC_TAC_collateral
                  + bond_tac_amount) / TAC_FIXED_SUPPLY
            ≤ MAX_BONDED_FRAC_OF_TAC_FDV
                                                          (system-wide cap shared with
                                                           cBTC.tac; TAC_FIXED_SUPPLY is
                                                           the hard 21M cap, not a live
                                                           oracle read — no MTM input)

    create bond_state = {
        worker_pubkey, bond_outpoint = (this_txid, 1),
        bond_amount_tac = bond_tac_amount,
        opened_at_height = current_height,
        notice_initiated_at = null,
        state = "active"
    }
    index by (worker_pubkey, bond_outpoint)
```

### Soft-confirm coupling (informative)

Dapps consuming `T_INTENT_ATTEST` envelopes from this worker MAY
upgrade their displayed soft-confirm status from
"soft_confirmed (unbonded)" to "soft_confirmed (bonded N TAC)"
once the open is observed at confirmation depth ≥ 1. The
specific upgrade threshold and how bond size weights confidence
is dapp policy; this amendment defines the on-chain primitive,
not the UX heuristic.

---

## §5.X.2 `T_WORKER_BOND_CLOSE` (tentative `0x5C`) — cooperative release

Two-step close to give traders watching the worker time to
observe and act if the worker withdraws while attestations are
still considered fresh.

### Step 1 — notice

```
opcode(1)              = 0x5C
subop(1)               = 0x01  (notice)
worker_pubkey(33)
bond_outpoint(36)        txid_BE(32) || vout_LE(4)
notice_sig(64)           BIP-340 over
                         SHA256("tacit-worker-bond-close-notice-v1"
                                || worker_pubkey
                                || bond_outpoint
                                || current_height_LE)
                         under worker_pubkey
```

Validator: looks up `bond_state[(worker_pubkey, bond_outpoint)]`;
requires `state == "active"`; transitions `state → "closing"`;
sets `notice_initiated_at = current_height`. Does **not** spend
the bond UTXO; the TAC remains locked.

### Step 2 — release

```
opcode(1)              = 0x5C
subop(1)               = 0x02  (release)
worker_pubkey(33)
bond_outpoint(36)
release_sig(64)          BIP-340 over
                         SHA256("tacit-worker-bond-close-release-v1"
                                || worker_pubkey
                                || bond_outpoint
                                || vout[1] script_pubkey   # release destination
                                || release_tac_amount_LE)
                         under worker_pubkey
```

### Bitcoin tx layout (normative, step 2)

```
vin[0]                  bond_outpoint (the bond UTXO being spent
                        via cooperative key-path: MuSig2 aggregate
                        of worker_pubkey + federation co-sig)
vin[1..]                Worker fee inputs
vout[0]                 OP_RETURN(envelope_hash)
vout[1]                 Released TAC — paid to worker's
                        declared destination script
vout[2..]               Change / fee
```

### Validator algorithm (step 2)

```
on T_WORKER_BOND_CLOSE step 2 at confirmation depth ≥ 1:
    bond := bond_state[(worker_pubkey, bond_outpoint)]
    require bond.state == "closing"
    require current_height - bond.notice_initiated_at >= BOND_NOTICE_BLOCKS
                                                          (governance band; default ~1008 blocks / ~1 week)
    require bond.state != "slashed"   # federation refuses to co-sign in this case;
                                       # belt-and-braces against any indexer race

    verify release_sig
    verify vin[0] is bond_outpoint and witness is a valid
        MuSig2 cooperative key-path spend (worker + federation
        share co-signed the SIGHASH); the federation participates
        only if its indexer mirror confirms bond.state == "closing",
        notice has elapsed, and no slash is recorded — federation
        acts as a tx-broadcast assistant, not a custody decision-
        maker
    verify vout[1].amount and asset = bond.bond_amount_tac TAC

    transition bond.state → "closed"
```

**Federation co-sign discipline (informative).** Federation
members run an indexer mirror and refuse to participate in the
MuSig2 cooperative spend whenever:

- `bond.state != "closing"` (open or already closed/slashed)
- notice not yet elapsed
- any T_WORKER_SLASH for this bond has been observed at any
  prior height

Federation members do not exercise discretion beyond these
checks. They are not graders of attestation quality, not jurors
of disputes, not policy actors. A federation key-set with N
members and threshold t (cBTC.tac's existing parameters) tolerates
N − t members offline or byzantine without blocking honest
cooperative close.

---

## §5.X.3 `T_WORKER_SLASH` (tentative `0x5D`) — equivocation evidence + slash

Anyone — not just the victim trader — can submit equivocation
evidence. The slash is permissionless. **The slash is an
indexer-state transition, not a Bitcoin-layer spend of the bond
UTXO.** The reporter's transaction does not consume `bond_outpoint`
(it can't — the reporter doesn't hold either the worker key or
the federation share). It carries the evidence in its envelope
payload and declares a bounty-receipt vout; the indexer applies
the slash by reattributing TAC value in its own state.

### Wire format

```
opcode(1)              = 0x5D
worker_pubkey(33)
bond_outpoint(36)        which bond to slash
scope_id(32)             from the conflicting attestations
observed_height_LE(4)    height both conflicting attestations
                         declared themselves bound to
ev_a_attest_txid(32)     txid of first T_INTENT_ATTEST envelope
ev_b_attest_txid(32)     txid of second T_INTENT_ATTEST envelope
                         (ev_a_attest_txid < ev_b_attest_txid
                          byte-lex ascending; canonical ordering
                          so different reporters with the same
                          evidence produce the same canonical
                          envelope hash)
reporter_pubkey(33)      whoever is submitting the slash
reporter_payout_script_hash(32)
                         SHA256(reporter's scriptPubKey for the
                         bounty receipt — the full scriptPubKey
                         appears in vout[1] of the Bitcoin tx; the
                         hash binds the envelope to it)
C_bounty_secp(33)        Pedersen commit under asset_id_TAC to
                         bounty_tac (the indexer recomputes
                         bounty_tac deterministically from
                         bond.bond_amount_tac × SLASH_REPORTER_BOUNTY_BPS;
                         this commit binds the reporter's bounty UTXO
                         to its declared asset value)
C_bounty_BJJ(32)         BJJ commit (cross-curve binding)
bounty_xcurve_sigma(~200) cross-curve equivalence proof
reporter_sig(64)         BIP-340 over
                         SHA256("tacit-worker-slash-v1"
                                || worker_pubkey || bond_outpoint
                                || scope_id || observed_height_LE
                                || ev_a_attest_txid || ev_b_attest_txid
                                || reporter_pubkey
                                || reporter_payout_script_hash
                                || C_bounty_secp || C_bounty_BJJ)
                         under reporter_pubkey
```

Note: `intent_pool_hash` and `worker_sig` for each envelope are
NOT included in the slash payload. The indexer already holds
these in `intent_attest_index[(attest_txid)]` (verified at
attestation-ingestion time per SPEC.md §5.17). Including them
again would be redundant and would make the evidence forgeable-
looking without buying any additional check.

### Bitcoin tx layout (normative)

```
vin[0]                  Reporter's BTC fee input(s); standard
                        SIGHASH_ALL signed by reporter_pubkey.
                        Does NOT spend bond_outpoint.
vout[0]                 OP_RETURN(envelope_hash) — 0 sat
vout[1]                 Reporter bounty receipt —
                        reporter-controlled (any standard tacit
                        asset-bearing script the reporter
                        chooses) with the asset value *indexer-
                        attributed*, not per-tx-input-backed.
                        scriptPubKey matches the SHA256 preimage
                        of reporter_payout_script_hash in the
                        envelope. Carries the TAC asset commit
                        pair (C_bounty_secp, C_bounty_BJJ). The
                        indexer attributes bounty_tac TAC to this
                        outpoint as a side effect of slash
                        application — the TAC is not consumed
                        from any Bitcoin input in this tx; it is
                        *reattributed* from the slashed bond's
                        indexer-state TAC value (see Conservation
                        note below).
vout[2..]               Optional reporter change / fee outputs
```

The bond UTXO at `bond_outpoint` is NOT in `vin[*]`. It remains
on Bitcoin permanently in the slashed state — the federation
will not co-sign any subsequent cooperative-close MuSig2 spend.

### Validator algorithm

```
on T_WORKER_SLASH at confirmation depth ≥ 1:
    bond := bond_state[(worker_pubkey, bond_outpoint)]
    require bond.state ∈ {"active", "closing"}    # NOT "closed" or "slashed"

    # Look up the two attestations from the indexer's existing
    # T_INTENT_ATTEST index (per SPEC.md §5.17).
    a := intent_attest_index[(ev_a_attest_txid)]
    b := intent_attest_index[(ev_b_attest_txid)]
    require a is not None and b is not None
    require a.worker_pubkey == worker_pubkey
    require b.worker_pubkey == worker_pubkey
    require a.scope_id == scope_id and b.scope_id == scope_id
    require a.observed_height == observed_height
    require b.observed_height == observed_height
    require a.intent_pool_hash != b.intent_pool_hash    # the actual equivocation
    require a.observed_height >= bond.opened_at_height
    require b.observed_height >= bond.opened_at_height
        # No retroactive slash for pre-bond bad acts

    # The two attestation signatures were verified by §5.17 at
    # ingestion time. The indexer trusts its own attestation
    # index — no re-verification here.

    verify reporter_sig under reporter_pubkey
    verify bounty_xcurve_sigma binds C_bounty_secp ↔ C_bounty_BJJ
        to some cleartext amount under asset_id_TAC

    # Compute the canonical split.
    bounty_tac := bond.bond_amount_tac × SLASH_REPORTER_BOUNTY_BPS / 10000
    burn_tac   := bond.bond_amount_tac - bounty_tac

    # Bind the reporter's bounty UTXO.
    verify vout[1].scriptPubKey hashes to reporter_payout_script_hash
    verify the C_bounty commit pair in vout[1]'s asset-commit
        encoding equals (C_bounty_secp, C_bounty_BJJ) from the
        payload (i.e., the reporter committed to the correct
        bounty_tac amount; the indexer rejects on mismatch)
    verify cleartext-amount-binding: C_bounty_secp matches
        bounty_tac under asset_id_TAC via the standard tacit
        asset binding check

    # Apply slash — pure per-outpoint TAC reattribution:
    bond_outpoint's attributed TAC value → 0
        # the Bitcoin UTXO at bond_outpoint is now inert dust;
        # if the worker or anyone else later spends it, the
        # indexer attributes zero TAC to the outputs (the TAC
        # is no longer there from the indexer's perspective)

    (slash_tx_id, vout[1])'s attributed TAC value → bounty_tac
        # the reporter's vout becomes a normal spendable TAC
        # UTXO worth bounty_tac, indexer-attributed but with no
        # corresponding TAC input on this tx

    bond_state[bond].bond_amount_tac → 0
    bond_state[bond].state → "slashed"
    worker_flag[worker_pubkey].equivocator = true
```

**Conservation note.** This is one of the few validator branches
where indexer-attributed TAC value moves between outpoints
without a same-tx input balancing the output. The per-outpoint
ledger before and after:

```
before slash:  attr(bond_outpoint)        = bond_amount_tac
               attr(slash_tx_id, vout[1]) = (does not exist)

after  slash:  attr(bond_outpoint)        = 0
               attr(slash_tx_id, vout[1]) = bounty_tac
```

The implied change to circulating supply is
`Δsupply = bounty_tac − bond_amount_tac = −burn_tac` —
*falls out of the per-outpoint accounting*; the indexer does
not maintain a separate `total_TAC_supply` counter that gets
decremented. The 21-million TAC fixed-supply cap is preserved
in spirit (never exceeded, monotonically contracting over
slashes); circulating supply is queryable at any time by
summing attributed TAC across all unspent outpoints minus the
inert-dust outpoints like slashed bonds.

This per-outpoint reattribution pattern is shared with cBTC.tac's
slashing path (the `SLASH_DETECTED` precedent) and the
`T_SLOT_BURN` outflow path — both rely on per-outpoint TAC
reattribution under indexer-state semantics, with the per-tx
asset-conservation rule of SPEC.md §5.4 carrying an explicit
exception list that this amendment extends to include
T_WORKER_SLASH. (Implementations should cross-check the precise
exception list against the canonical cBTC.tac validator before
ship — the precedent shape is reused, not the literal opcode
plumbing.)

### Race conditions (informative)

The slash is an indexer-state move that requires no Bitcoin-layer
UTXO consumption, so the classic "two-spenders race over one
outpoint" pattern doesn't apply. The remaining races:

- **Slash and step-2 close in the same block.** Step-2 close
  IS a Bitcoin-layer spend of `bond_outpoint`; slash is not.
  Per SPEC.md §11 within-block ordering (`tx_index` ascending),
  whichever tx the indexer processes first wins:
  - If the slash is processed first, `bond.state → "slashed"`;
    the close tx's federation co-sign would not have been
    produced by an honest federation (their mirror sees the
    slash), but if a malicious or stale federation did co-sign,
    the indexer rejects the close at `state != "closing"`. The
    bond UTXO may still spend on Bitcoin, but the indexer
    attributes zero TAC to its outputs.
  - If the close is processed first, the slash is rejected at
    `bond.state ∈ {"active", "closing"}` (now `"closed"`).
  The Bitcoin layer may still observe both txs confirming in
  the same block; only the indexer's state transition is
  authoritative.
- **Multiple slash submissions for the same evidence.** Each
  reporter pays their own fee and publishes their own evidence
  envelope. The indexer processes them in `tx_index` order; the
  first valid envelope flips `bond.state → "slashed"` and
  records that reporter's bounty. Subsequent envelopes hit
  `bond.state == "slashed"` and are rejected at the state-guard
  line above (their bounty vout becomes a worthless dust output).
  Mitigations: dapps SHOULD relay evidence to the originally
  affected trader first (most incentivized to slash) and SHOULD
  insert a small randomized delay before broadcasting a
  speculative slash.
- **Evidence with `observed_height < bond.opened_at_height`.**
  Rejected at the explicit guard above. A worker's pre-bond bad
  acts are not retroactively slashable.

---

## §5.X.4 Bond health and mark-to-market (informative)

The validator does **not** enforce mark-to-market liquidations.
A bond is honored as long as it is in `active` state and not
slashed. Price drift in TAC/BTC does not auto-burn the bond.

What dapps SHOULD do (UX heuristic, not normative):

```
soft_confirm_rating(worker_pubkey, intent_value_btc):
    let active_bonds = sum of bond.bond_amount_tac across
                       all active bonds for this worker
    let bond_value_btc = active_bonds × twap_TAC_BTC_180
    let ratio = bond_value_btc / intent_value_btc

    if ratio >= INITIAL_BOND_RATIO:        return "bonded (strong)"
    if ratio >= WARNING_RATIO:             return "bonded (warning)"
    if ratio >= LIQUIDATION_RATIO:         return "bonded (under-collateralized)"
    return "unbonded for this value"
```

Parameter defaults match cBTC.tac's existing bands
(`INITIAL_BOND_RATIO: 2.0`, `WARNING_RATIO: 1.5`,
`LIQUIDATION_RATIO: 1.2`). These reuse the same governance keys
where it makes semantic sense; an explicit
`WORKER_BOND_INITIAL_RATIO` separate-key alternative is open
question #2 below.

A worker observing their bond drift into "warning" SHOULD top
up by posting an additional `T_WORKER_BOND_OPEN` with more TAC.
There is no on-chain top-up opcode — the protocol treats
multiple bonds from the same worker as cumulative. Cleaner than
threading a top-up opcode through the close-period semantics.

---

## §5.X.5 Composition with channel layer (informative)

The bond's job is to make existing `T_INTENT_ATTEST`-based soft-
confirms credible. Nothing in T_INTENT_ATTEST or the orderbook
channel / AMM channel scope schemas changes:

- A worker may attest **without** posting a bond. Such
  attestations are still cryptographically equivocation-evident;
  the bond only adds an automated economic consequence.
- A trader's verification flow is unchanged (per SPEC.md §5.17
  step 5). The bond status is a **separate** local query against
  `bond_state` indexed by `worker_pubkey`.
- The dapp UX surfaces both — "intent verified in attestation,
  worker bonded N TAC" is one combined status line.

The construction composes naturally with the `tacit-mesh`
phase 0 cross-worker check: if mesh detects an inconsistency
between two bonded workers, the slash market becomes
*self-resolving* — whichever worker actually equivocated is the
one whose bond gets claimed (because only their evidence pair
produces a valid `T_WORKER_SLASH`); the honest worker has no
conflicting pair to submit and their bond remains untouched.

The bond also interacts cleanly with `T_TRADE_BATCH`: a settler
assembling a cross-surface batch from intents attested by a
bonded worker can advertise the batch as "bonded settlement"
in trader UX, with the bond covering the period between intent
post and Bitcoin confirmation of the batch.

---

## Governance parameters (within safety bands)

Per the `SPEC-GOVERNANCE-AMENDMENT.md` framework, this amendment
exposes the following bounded parameters:

```
governance_state["SPEC-WORKER-BOND-AMENDMENT-v1"].params = {
    MIN_BOND_TAC:                  100_000_000,      // 1 TAC (8-decimal base units); safety band [10_000_000, 10_000_000_000_000]
    MAX_BOND_TAC_PER_TX:           10_000_000_000_000, // 100k TAC; anti-mistake cap
    BOND_NOTICE_BLOCKS:            1008,             // ~1 week; safety band [144, 4320]
    SLASH_REPORTER_BOUNTY_BPS:     1000,             // 10% of slash to reporter; safety band [100, 3000]
    WARNING_RATIO:                 1.5,              // reused from cBTC.tac semantics; safety band [1.2, 2.0]
    LIQUIDATION_RATIO:             1.2,              // soft-only: dapp UX heuristic, no on-chain liquidation
}
```

Hard limits (not governance-addressable; require formal
amendment to change):

- Slashing on equivocation is unconditional whenever valid
  evidence is submitted before bond close; no parameter can
  disable it.
- Slashed TAC distribution: reporter bounty is paid to the
  reporter's declared vout, the remainder is burned (removed
  from `total_TAC_supply`). The slash never flows into the
  cBTC.tac insurance pool or any other pooled sink.
- `MAX_BONDED_FRAC_OF_TAC_FDV` (system-wide cap on bonded TAC
  across all worker bonds plus all cBTC.tac positions) is shared
  with the cBTC.tac amendment and remains a hard limit at
  `0.25` of TAC FDV.

---

## Backwards-compatibility statement

Purely additive. Three new opcodes; no modification to existing
ones. Indexers without bond support continue to operate
correctly: they index `T_INTENT_ATTEST` envelopes and flag
equivocation; they simply lack the automated slash branch. Dapps
querying such indexers see "equivocator" flag but no slash event
— degraded experience, not broken.

This amendment does NOT modify:

- `T_INTENT_ATTEST` wire format or validator (§5.17 unchanged)
- Orderbook channel scope schemas (SPEC-ORDERBOOK-CHANNEL-AMENDMENT
  unchanged)
- AMM channel scope schemas (AMM.md §"Preconfirmation layer"
  unchanged)
- The standard tacit asset model or TAC's asset_id
- The cBTC.tac insurance pool, its sink, or `T_SHARE_SLASH_CLAIM`
  semantics — worker-bond slashes do not touch any of these
- `T_TRADE_BATCH` wire format or validator
- The `protocol_bonded` Taproot construction itself (consumed
  from SPEC-WRAPPER-AMENDMENT.md; no change to its definition)

It DOES add:

- Three new opcodes (`0x5B`, `0x5C`, `0x5D`; tentative)
- Four new BIP-340 domain tags:
  - `tacit-worker-bond-open-v1`
  - `tacit-worker-bond-close-notice-v1`
  - `tacit-worker-bond-close-release-v1`
  - `tacit-worker-slash-v1`
- One new indexer state table (`bond_state` keyed by
  `(worker_pubkey, bond_outpoint)`) plus one global flag
  (`worker_flag[worker_pubkey].equivocator`)
- Worker-side tooling: open / monitor / cooperative-close flows
- Dapp-side tooling: bond-health display, equivocator detection
  surfaced in soft-confirm rating, optional slash-submission UX

---

## Test plan (informative — non-normative)

End-to-end signet rehearsal:

1. **Open + cooperative close (happy path).** Worker posts
   `T_WORKER_BOND_OPEN` for 1 TAC; attests honestly to a scope
   for 1 epoch; posts `T_WORKER_BOND_CLOSE` step 1; waits
   `BOND_NOTICE_BLOCKS`; posts step 2; receives full TAC back.
2. **Equivocation slash.** Worker posts a bond, then issues two
   conflicting `T_INTENT_ATTEST` envelopes for the same
   `(scope_id, observed_height)`. A third-party reporter submits
   `T_WORKER_SLASH`; verify reporter's declared vout receives
   `bounty_tac = bond_amount × 10%` worth of indexer-attributed
   TAC, the remaining 90% decrements `total_TAC_supply` (burn),
   `bond.bond_amount_tac → 0`, `bond.state → "slashed"`,
   `worker_flag.equivocator = true`. The bond UTXO at
   `bond_outpoint` is still present on Bitcoin but the indexer
   attributes zero TAC value to it.
3. **Slash during close-notice period.** Worker posts bond,
   attests honestly, then submits close-notice. Mid-notice,
   equivocation evidence from the worker's earlier active period
   is submitted. Slash lands during the notice window; verify
   `bond.state → "slashed"`; verify any subsequent step-2 close
   tx is rejected by the indexer (federation refuses to co-sign,
   and the validator's `state != "closing"` guard would catch any
   stale co-signature).
4. **Slash after close completes.** Worker fully closes their
   bond (federation co-signs after notice; TAC released to
   worker). Evidence from their active period is then submitted.
   Verify slash is rejected: `bond.state == "closed"`.
5. **Pre-bond evidence.** Two attestations with `observed_height
   < bond.opened_at_height`. Verify slash is rejected at the
   explicit guard.
6. **Worker with multiple bonds.** Worker holds 3 active bonds.
   Equivocation evidence references one specific
   `bond_outpoint`; verify only that bond is zeroed and burned,
   the other 2 remain active, but the worker's `equivocator`
   flag is set globally.
7. **Race: simultaneous slash submissions.** Two reporters
   submit valid slash evidence for the same bond in the same
   block. Verify within-block ordering: the first envelope (by
   `tx_index`) flips `bond.state → "slashed"` and credits its
   reporter's bounty vout; the second envelope is rejected at
   the state-guard line; the second reporter's declared bounty
   vout receives zero indexer-attributed TAC (becomes dust).
8. **Burn accounting.** Track `total_TAC_supply` across several
   slashes. After the test run, verify
   `Δ(total_TAC_supply) == -Σ(burn_tac per slash)`. Verify the
   reporter bounty UTXOs sum to `Σ(bounty_tac per slash)` and
   each is indexer-attributed but unbacked by any per-tx TAC
   input.
9. **Cross-worker mesh detection → slash.** Mesh phase 0 surfaces
   an inconsistency between worker A and worker B. The victim
   trader assembles slash evidence (the two A-signed envelopes
   from chain) and submits. Verify A's bond is slashed; B's
   bond — uninvolved in the evidence — is untouched.

Cross-impl parity:

10. Dapp builds each of the three opcodes' envelopes; worker
    validates and indexes correctly.
11. Worker builds; dapp validates.
12. Canonical pre-image byte-parity check for the four BIP-340
    domain tags.

Adversarial:

13. Slash referencing an `ev_a_attest_txid` not present in
    `intent_attest_index` (forged on-chain reference). Indexer
    rejects at the lookup-is-not-None guard.
14. Forged reporter_sig. Rejected at sig check.
15. Replay of confirmed slash. Bitcoin rejects (duplicate tx);
    indexer never re-processes.
16. Slash referencing two attestations with the same hash (not
    actually equivocation). Rejected at
    `a.intent_pool_hash != b.intent_pool_hash` check.
17. Slash referencing attestations with different `scope_id`
    (worker honestly attested to two different scopes at the
    same height). Rejected at scope-id match check.
18. Bond open with a `vout[1]` that isn't a `protocol_bonded`
    Taproot output (e.g., plain worker single-sig P2TR). Indexer
    rejects at the protocol_bonded discipline check; no
    `bond_state` entry created; the worker's TAC stays at vout[1]
    as ordinary TAC, not bonded.
19. Bond open that exceeds `MAX_BONDED_FRAC_OF_TAC_FDV`.
    Indexer rejects; worker's bond UTXO is created on Bitcoin
    but treated as unbonded TAC (indexer state has no
    `bond_state` entry; dapps display "unbonded").
20. Slash with `C_bounty_secp` that does not bind to
    `bounty_tac = bond.bond_amount_tac × SLASH_REPORTER_BOUNTY_BPS / 10000`.
    Indexer rejects at the bounty-binding check (reporter
    cannot overclaim or underclaim by choosing a different
    commit).

---

## What this amendment explicitly does NOT specify

- **Slashable conditions beyond equivocation.** Selective
  censorship (worker omits a specific intent from its published
  list) is **soft-suspicious only** — the mesh amendment surfaces
  it; no slash. Reason: censorship lacks the clean cryptographic
  evidence equivocation has (worker can plausibly claim "I hadn't
  seen the intent yet"). A future amendment could add inclusion-
  promise sigs and slash on broken promises; out of scope here.
- **Reputation / leaderboards.** Off-chain UX concern.
- **Bond auctioning or rotation.** A worker who wants to migrate
  to a new `worker_pubkey` closes the old bond cooperatively
  and opens a new one. Atomic rotation in one tx is a follow-up
  optimization if operationally useful.
- **Bond aggregation across workers (mutualization).** No
  shared-pool bond construction. Each worker bonds independently.
- **Cross-chain bond denominations.** Bond is TAC. cBTC.tac and
  cUSD.tac are not eligible; the bonded TAC must be the bare
  asset (`asset_id_TAC` per the cBTC.tac amendment).

---

## Open questions for round-2 review

1. **Reporter-bounty BPS sizing.** 10% is a round number that
   makes monitoring obviously profitable for a non-victim
   third party watching a large bond. Lower bounty burns more
   TAC per slash (stronger deflationary signal, weaker monitor
   incentive); higher bounty densifies the monitor population
   at the cost of the deterrent's pure-burn fraction. Empirical
   question; revisit after signet rehearsal item 7 quantifies
   wasted-fee costs from slash races at this BPS.

2. **Shared vs. separate ratio parameters.** Should
   `INITIAL_BOND_RATIO`, `WARNING_RATIO`, `LIQUIDATION_RATIO`
   be the same governance keys as cBTC.tac (so one vote moves
   both) or namespaced separately
   (`WORKER_BOND_INITIAL_RATIO`, …)? The semantics are similar
   but the underlying risk profiles aren't identical (a worker
   bond covers attestation honesty, not BTC self-custody).
   Lean toward separate keys; flag for review.

3. **Bond minimum (`MIN_BOND_TAC`).** 1 TAC default is
   intentionally low so small / experimental workers can
   participate. Higher minimum prevents trivially-bonded
   workers from claiming the same UX rating as serious ones,
   but may concentrate attestation in a few large workers
   (against the mesh amendment's decentralization thesis).
   Empirical.

4. **Cooperative-close notice length.** 1008 blocks (~1 week)
   matches typical fraud-proof windows but may be longer than
   needed given equivocation evidence is always synchronously
   constructable from on-chain envelopes (no off-chain witness
   data). 144 blocks (~1 day) may be safe. Conservative band
   for V1; tune empirically.

---

## Integration checklist for landing in `SPEC.md`

- [ ] §5.X (number TBD) "Worker bond + equivocation slash"
      added after the channel-layer block.
- [ ] §3 opcode table adds `T_WORKER_BOND_OPEN`,
      `T_WORKER_BOND_CLOSE`, `T_WORKER_SLASH` with final byte
      assignments.
- [ ] §3 BIP-340 domain tags table adds:
      - `tacit-worker-bond-open-v1`
      - `tacit-worker-bond-close-notice-v1`
      - `tacit-worker-bond-close-release-v1`
      - `tacit-worker-slash-v1`
- [ ] §5.5 validator dispatch extended with three new branches.
- [ ] §11 indexer determinism rules extended with bond-state
      transition order: within a single block containing both
      a step-2 close and a slash for the same bond, the
      earlier-`tx_index` envelope wins; the later one is
      rejected at its respective state guard. (Slash does NOT
      spend `bond_outpoint`, so there is no Bitcoin-layer
      outpoint conflict — the ordering is purely an indexer-
      state determinism rule.)
- [ ] Governance amendment registers
      `"SPEC-WORKER-BOND-AMENDMENT-v1"` parameter block with
      safety bands.
- [ ] Reference dapp:
      - Bond-open / bond-close UX flow for worker operators
      - Bond-health display in soft-confirm rating
      - Optional slash-submission UI for users who detect
        equivocation
- [ ] Reference worker:
      - Bond-state tracker per worker_pubkey
      - Periodic self-audit (does my outstanding attestation
        history contain any pair I should be worried about?)
- [ ] Reference indexer:
      - bond_state table + indexes
      - T_WORKER_SLASH validator branch — indexer-state slash
        applying the bounty attribution + burn (shares
        accounting plumbing with cBTC.tac's SLASH_DETECTED for
        the "TAC moves without per-tx input backing" pattern,
        but does NOT use cBTC.tac's insurance-pool sink)
- [ ] Cross-impl parity tests: canonical envelopes for each of
      the three opcodes shared between dapp and worker.
- [ ] Signet rehearsal: items 1–20 from the test plan, all
      green.

---

## Sign-off checklist

- [ ] Round-1 peer review of wire format + validator algorithm
- [ ] Round-2 peer review (especially the cooperative-close /
      slash race semantics, the MuSig2 federation co-sign
      discipline, and the conservation-exception accounting for
      bounty attribution + burn)
- [ ] Reference dapp implementation
- [ ] Reference worker / indexer implementation
- [ ] Signet e2e validation
- [ ] Cross-impl parity tests
- [ ] Merge into `SPEC.md` as §5.X and mark `✅ Merged` in
      `AMENDMENTS.md`
