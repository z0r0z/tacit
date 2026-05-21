# SPEC Amendment — Worker Bond + Equivocation Slash for `T_INTENT_ATTEST`

> Status: 📝 Draft (round-1)
> Depends on: `T_INTENT_ATTEST` (`0x30`, SPEC.md §5.17) — the
> scope-generic preconfirmation primitive.
> `SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md` and the AMM channel scope
> schemas (`spec/amm/dapp-checklist.md`, `spec/amm/wire-formats.md`)
> consume this primitive today.
> `SPEC-CBTC-TAC-AMENDMENT.md` established the covenant-free
> TAC-bond pattern this amendment inherits directly. Note that
> §5.35.2's original "no-spending-key escrow" framing requires
> covenant primitives Bitcoin does not have on mainnet; **§5.47
> ("v1 lien model — trustless collateral without covenants") is
> the shipped construction** and the one this amendment uses. In
> the §5.47 model, the bond UTXO is a standard tacit asset UTXO
> in the worker's own wallet (single-sig Schnorr key-path P2TR);
> the "bondedness" is enforced at the indexer / worker layer by
> a **lien** recorded in `bond_state` that validator coordination
> refuses to honor unauthorized spends of (per cBTC.tac §5.47.3
> — the `commitmentForUtxo` enforcement point). Authorized
> lien-release paths: `T_WORKER_BOND_CLOSE` step 2 (cooperative)
> and `T_WORKER_SLASH` (forced, on equivocation evidence). The
> indexer-state slashing precedent is `SLASH_DETECTED` (§5.39.2);
> the conservation-exception precedent for TAC-creation-without-
> per-tx-input is `T_SHARE_SLASH_CLAIM` (§5.39.4). cBTC.tac is
> explicitly federation-free (§5.35.2: "no federation, no
> multisig, no co-signer"); this amendment inherits that trust
> profile.
> `SPEC-GOVERNANCE-AMENDMENT.md` supplies the safety-band
> parameter framework (`INITIAL_BOND_RATIO`,
> `MAX_BONDED_FRAC_OF_TAC_FDV`).
>
> Adds three opcodes (`T_WORKER_BOND_OPEN`, `T_WORKER_BOND_CLOSE`,
> `T_WORKER_SLASH`; tentative bytes `0x5F`/`0x60`/`0x61` — final
> assignment at merge; shifted from prior `0x5B`/`0x5C`/`0x5D`
> draft once the preauth/offline-trading family block at
> `0x5B`–`0x5E` was reserved by `SPEC-PREAUTH-BID-AMENDMENT.md`)
> that turn the existing per-worker
> equivocation flag into a **cryptographically evident, economically
> credible** consequence: a worker that signs two
> `T_INTENT_ATTEST` envelopes at the same `(scope_id, worker_pubkey,
> observed_height)` with different `intent_pool_hash` has its
> posted TAC bond **burned at the indexer layer** (removed from
> the TAC supply by reattribution), with a fixed fraction
> redirected to the slash submitter as a reporter bounty before
> the burn.
>
> The bond is denominated in **TAC** (raw TAC; not LP shares —
> worker bonds are smaller and more transient than cBTC.tac slot
> positions, so the yield-while-bonded property cBTC.tac §5.47
> optimizes for isn't worth the implementation complexity here).
> No new cryptographic primitive. No new ceremony. No new trust
> assumption. No change to `T_INTENT_ATTEST`'s wire format or
> validator. The bond UTXO is a standard worker-controlled
> P2TR; lifecycle transitions (open, cooperative close, slash)
> all run through the lien recorded in `bond_state` and the
> `commitmentForUtxo` enforcement point that cBTC.tac §5.47.3
> already specifies.

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
to honor its `T_INTENT_ATTEST` envelopes as soft-confirms posts
a TAC bond using the **cBTC.tac §5.47 lien pattern**: the bond
UTXO is a standard tacit asset UTXO in the worker's own wallet
(single-sig Schnorr key-path P2TR carrying a TAC asset commit
under standard tacit asset binding); on receiving a valid
`T_WORKER_BOND_OPEN` envelope, the indexer records a **lien**
entry in `bond_state` keyed by `(worker_pubkey, bond_outpoint)`.

The lien is enforced exactly as cBTC.tac §5.47.3 specifies:
`commitmentForUtxo` (the worker's universal asset-UTXO resolver)
refuses any outpoint in the `bond_state` table's `active` or
`closing` state, throwing as if the UTXO doesn't exist. Every
downstream consumer (`T_AXFER_VAR`, `T_SWAP_VAR`, `T_CXFER`,
etc.) hits this helper and automatically refuses to recognize
the liened UTXO as TAC-bearing. The only handlers that bypass
the lien check are the worker-bond opcodes themselves
(`T_WORKER_BOND_CLOSE` step 2 for cooperative release;
`T_WORKER_SLASH` for forced reattribution under equivocation
evidence). If a worker spends their liened UTXO on Bitcoin
outside the protocol, the spend confirms at the Bitcoin layer
but the indexer attributes zero TAC to the outputs (analogous
to a cBTC.tac depositor "rugging" — except there's no separate
backing asset to lose, just the bond itself).

The bond is releasable cooperatively after a notice period via
`T_WORKER_BOND_CLOSE` step 2 — the worker spends the
bond_outpoint on Bitcoin to their declared destination, and the
indexer authorizes the spend (TAC attribution follows the normal
asset-flow rules) because the lien-release conditions are met.
It is **slashable by anyone** who submits two conflicting
`T_INTENT_ATTEST` envelopes signed by the same `worker_pubkey`
at the same height for the same scope; the slash envelope
declares a reporter bounty destination, the indexer reattributes
the configured bounty fraction to that outpoint and burns the
remainder by zeroing the bond's TAC value with no offsetting
attribution.

Honest monitoring becomes positive-expected-value for any third
party who can construct the evidence pair from on-chain
envelopes.

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
                  ┊
                  ┊ T_WORKER_SLASH (flag-only branch)
                  ┊ — no state change; sets
                  ┊   worker_flag.equivocator
                  ▼
              closed + equivocator-flagged
              (state remains "closed";
               flag is on the worker_pubkey,
               not the bond)
```

`T_WORKER_SLASH` is valid in **any non-slashed** state:

- `active` or `closing` → full economic slash (bond TAC zeroed,
  bounty paid, remainder burned, equivocator flag set).
- `closed` → public-good flag-set only. The bond TAC is already
  gone (returned to worker via cooperative close); the reporter
  receives no bounty; the only effect is
  `worker_flag.equivocator = true`. A reporter pays Bitcoin
  fees with no economic upside, but the worker still gets
  globally flagged.
- `slashed` → rejected (double-slash).

This closes the gap where a worker who equivocates, then
closes their bond before evidence surfaces, would otherwise
escape both the slash AND the global flag. They still escape
the slash itself (the TAC is gone), but the global flag —
which is what dapps use to downgrade the worker's soft-confirm
rating going forward — still applies.

---

## §5.X.1 `T_WORKER_BOND_OPEN` (tentative `0x5F`) — open a bond

### Wire format

```
opcode(1)              = 0x5F
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
**standard worker-controlled P2TR** carrying a TAC asset commit
— **is** the bond. Its outpoint is the `bond_outpoint` recorded
in `bond_state`. The UTXO is *technically* spendable by the
worker on Bitcoin at any time (it's a normal single-sig
output), but the indexer's lien (per cBTC.tac §5.47.3
`commitmentForUtxo` enforcement) refuses to recognize any spend
of a liened UTXO as TAC-bearing. The only authorized lien-
release paths are `T_WORKER_BOND_CLOSE` step 2 and
`T_WORKER_SLASH`; any other spend confirms on Bitcoin as a
worthless dust transfer (the indexer attributes zero TAC to
the outputs).

### Bitcoin tx layout (normative)

```
vin[0]                  worker's TAC input(s) — standard tacit
                        asset input covering bond_tac_amount;
                        signed SIGHASH_ALL by worker_pubkey
vout[0]                 OP_RETURN(envelope_hash) — 0 sat
vout[1]                 Bond UTXO — standard P2TR controlled by
                        `worker_pubkey` (BIP-340 Schnorr key-path,
                        no script-path leaf required). Carries the
                        TAC asset commit pair (C_bond_secp,
                        C_bond_BJJ) under standard tacit asset
                        binding; sats value at protocol dust
                        minimum (330 sats for current P2TR dust
                        relay). The lien recorded in bond_state on
                        envelope acceptance is what makes this
                        UTXO economically immobile — not the
                        Bitcoin script.
vout[2..]               Optional change / fee outputs
```

`bond_outpoint` resolves to `(txid_of_this_tx, 1)`.

### Validator algorithm

```
on T_WORKER_BOND_OPEN at confirmation depth ≥ 1:
    require opcode == 0x5F
    decode payload; reject on structural error
    verify opener_sig under worker_pubkey
    verify xcurve_sigma binds C_bond_secp ↔ C_bond_BJJ to
        bond_tac_amount under asset_id_TAC
    verify vin[0] supplies a valid TAC input ≥ bond_tac_amount
        (standard tacit asset input check)
    verify vout[1] is a standard P2TR output controlled by
        worker_pubkey (BIP-340 internal-key matching the opener_sig
        key). No script-path leaf required. The bond is enforced
        by the lien recorded in bond_state below, not by a
        special Bitcoin script — per cBTC.tac §5.47.3 the spend-
        refusal happens at `commitmentForUtxo`, not at the
        Bitcoin layer.

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

## §5.X.2 `T_WORKER_BOND_CLOSE` (tentative `0x60`) — cooperative release

Two-step close to give traders watching the worker time to
observe and act if the worker withdraws while attestations are
still considered fresh.

### Step 1 — notice

```
opcode(1)              = 0x60
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
opcode(1)              = 0x60
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

The bond UTXO IS spent in this tx (standard worker single-sig
Schnorr key-path spend). The envelope authorizes the lien
release; the indexer then accepts the spend's TAC flow per the
normal asset-flow rules.

```
vin[0]                  bond_outpoint — worker spends with
                        BIP-340 Schnorr key-path single-sig under
                        worker_pubkey. SIGHASH_ALL.
vin[1..]                Worker's optional additional fee inputs
                        (sats).
vout[0]                 OP_RETURN(envelope_hash) — 0 sat
vout[1]                 Released TAC destination — any standard
                        tacit asset-bearing P2TR (or other
                        accepted tacit asset output type) the
                        worker chooses. Carries the TAC asset
                        commit binding to bond.bond_amount_tac
                        via standard tacit asset-flow rules (i.e.,
                        with the lien released, the bond_outpoint's
                        TAC input cleanly backs vout[1]'s TAC
                        output — this is NOT a conservation-
                        exception branch; the asset flow is
                        ordinary).
vout[2..]               Optional change / fee outputs
```

### Validator algorithm (step 2)

```
on T_WORKER_BOND_CLOSE step 2 at confirmation depth ≥ 1:
    bond := bond_state[(worker_pubkey, bond_outpoint)]
    require bond.state == "closing"
    require current_height - bond.notice_initiated_at >= BOND_NOTICE_BLOCKS
                                                          (governance band; default ~1008 blocks / ~1 week)
    require vin[0] consumes bond_outpoint and Bitcoin sig
        verifies under worker_pubkey (key-path Schnorr)

    verify release_sig under worker_pubkey
    verify vout[1] is a standard tacit asset-bearing output with
        TAC asset commit binding to bond.bond_amount_tac (the
        envelope's release_sig pre-image includes vout[1]
        script_pubkey and release_tac_amount_LE, so the worker
        cannot reroute or change the amount after signing)

    # Release the lien — bond_outpoint is now ordinary spent
    # input from the indexer's perspective; vout[1] carries the
    # TAC out under normal asset-flow rules.
    bond_state[bond].state → "closed"
    bond_state[bond].released_at_height = current_height
        # bond_state record stays in the table as historical
        # evidence ("this bond was closed cooperatively at
        # height H") for audit; downstream state queries
        # MAY garbage-collect closed bonds after some grace
        # period if storage pressure justifies it.

    # No special TAC reattribution needed — the spend's vout[1]
    # carries the TAC value per the standard tacit asset model;
    # commitmentForUtxo no longer refuses the bond_outpoint (it's
    # consumed) and accepts vout[1] as the natural successor.
```

The cooperative-close path is the ONE worker-bond lifecycle
branch where Bitcoin-layer asset flow does the work — slash and
open both rely on indexer-state moves. This asymmetry is
intentional: cooperative close is the happy path and benefits
from being indistinguishable from any ordinary tacit asset
spend at the Bitcoin layer (only the indexer notices the lien
release).

Race against a same-block slash (§5.X.3 below) is resolved by
within-block `tx_index` ordering plus the explicit `bond.state`
guards on each opcode.

No federation involvement at any step. Same trust profile as
cBTC.tac §5.47: lien enforced by validator coordination, not
covenant.

---

## §5.X.3 `T_WORKER_SLASH` (tentative `0x61`) — equivocation evidence + slash

Anyone — not just the victim trader — can submit equivocation
evidence. The slash is permissionless. **The slash is an
indexer-state transition, not a Bitcoin-layer spend of the bond
UTXO.** The reporter does not (and cannot) consume `bond_outpoint`
— that UTXO is controlled by `worker_pubkey`'s key, which the
reporter does not hold. The slash carries the evidence in its
envelope payload and declares a bounty-receipt vout; the indexer
applies the slash by transferring the bond's lien-recorded TAC
value to the bounty outpoint (configured fraction) and burning
the remainder (per-outpoint zeroing of the bond's recorded TAC).

### Wire format

```
opcode(1)              = 0x61
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

The bond UTXO at `bond_outpoint` is NOT in `vin[*]` — the
reporter does not hold `worker_pubkey`'s key. If the worker
themselves later spends `bond_outpoint` on Bitcoin (post-slash,
unauthorized), the spend confirms at the Bitcoin layer but the
indexer's lien refuses to attribute any TAC to its outputs —
the slashed bond is dead at the indexer layer regardless of
its Bitcoin-layer state.

### Validator algorithm

```
on T_WORKER_SLASH at confirmation depth ≥ 1:
    bond := bond_state[(worker_pubkey, bond_outpoint)]
    require bond.state != "slashed"   # double-slash rejected;
                                       # active/closing/closed all
                                       # proceed (closed → flag-only,
                                       # no bounty paid, see below)

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

    # Always set the equivocator flag — even if the bond is
    # already closed and there is no economic slash to apply.
    # This is the "public-good submission" branch: a reporter
    # who finds equivocation evidence after the worker closed
    # their bond still gets to tar the worker_pubkey globally,
    # even though there is nothing left to slash.
    worker_flag[worker_pubkey].equivocator = true

    if bond.state == "closed":
        # No bond TAC left to slash — flag-set only, no bounty,
        # no burn. The reporter pays only their Bitcoin fees;
        # their declared vout[1] receives zero indexer-attributed
        # TAC (becomes dust). Slash envelope still finalizes the
        # equivocator flag.
        return  # done

    # Otherwise bond.state ∈ {"active", "closing"} — proceed
    # with full economic slash.

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
    bond_outpoint's lien-recorded TAC value → 0
        # commitmentForUtxo continues to refuse bond_outpoint
        # post-slash (lien is in "slashed" state). If the
        # worker later spends bond_outpoint on Bitcoin, the
        # indexer attributes zero TAC to the outputs — the
        # TAC has been redirected to the bounty + burned.

    (slash_tx_id, vout[1])'s attributed TAC value → bounty_tac
        # the reporter's vout becomes a normal spendable TAC
        # UTXO worth bounty_tac, indexer-attributed but with no
        # corresponding TAC input on this tx — this IS a
        # conservation-exception branch (the only one in this
        # amendment); see Conservation note below.

    bond_state[bond].bond_amount_tac → 0
    bond_state[bond].state → "slashed"
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

This per-outpoint reattribution pattern is **directly precedented**
by cBTC.tac's `T_SHARE_SLASH_CLAIM` opcode (§5.39.4 — pays TAC
to a `recipient_commit` declared in the envelope with no TAC
input on the same tx, drawing from `insurance_pool_TAC`). The
cBTC.tac amendment treats it as an established branch of the
§5.4 asset-conservation rule. This amendment adds
`T_WORKER_SLASH` as another member of the same conservation-
exception family — same shape, different source of the
indexer-side TAC value (a slashed bond's lien-recorded amount
rather than a pooled insurance reserve).

Note that the **cooperative-close path is NOT a conservation
exception** — it's an ordinary tacit asset spend. The bond
UTXO is consumed at the Bitcoin layer, vout[1] carries the
TAC value per standard asset-flow rules, and the only indexer-
state effect is releasing the lien. Slash and cooperative
close are mechanically different precisely because the slash
doesn't have access to the bond UTXO's key; the same TAC moves
in both, but via different plumbing.

### Race conditions (informative)

The cooperative-close path DOES consume `bond_outpoint` (worker
single-sig spend). The slash path does NOT. The races and their
resolutions:

- **Slash and step-2 close in the same block (different txs).**
  Both can confirm at the Bitcoin layer (close consumes
  `bond_outpoint`; slash does not touch it; no Bitcoin-layer
  conflict). Per SPEC.md §11 within-block ordering (`tx_index`
  ascending), whichever envelope the indexer processes first
  wins the economic effect:
  - If the slash is processed first, `bond.state → "slashed"`;
    bounty paid; remainder burned; equivocator flag set. When
    the close is then processed, `commitmentForUtxo` will have
    already noted bond_outpoint's lien is in "slashed" state,
    so the close's vin[0] won't validate as a TAC-bearing input.
    The close envelope is rejected at the `state != "closing"`
    guard; the close tx's vout[1] receives zero indexer-
    attributed TAC.
  - If the close is processed first, `bond.state → "closed"`;
    TAC released cleanly to worker's destination. The slash
    envelope then hits the `"closed"` branch — equivocator
    flag still sets, no bounty paid, bond stays in `"closed"`.
    The worker has walked with the TAC but earned the global
    equivocator flag anyway.
  Both txs confirm at the Bitcoin layer (ordinary fee-paying
  txs); only the indexer's state determines TAC attribution
  and flag state.
- **Worker spends bond_outpoint outside of a step-2 close
  envelope (unauthorized).** The Bitcoin spend confirms; the
  indexer attributes zero TAC to its outputs (the lien refuses
  to recognize the spend as TAC-bearing — same enforcement as
  cBTC.tac §5.47.3). The TAC is implicitly burned (gone from
  bond_outpoint, not credited anywhere). `bond_state` stays
  "active" (or "closing") with the original `bond_amount_tac`
  — i.e., a subsequent slash for valid equivocation evidence
  STILL works at the indexer state level (transfers the
  recorded TAC value to bounty + burns rest). This may look
  like double-burning the same TAC; it isn't — the worker
  burned their UTXO unilaterally (no value moved); the slash
  burns the indexer-recorded bond value (which was the only
  thing that could have moved authoritatively).
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
  reporter's declared vout (`bounty_tac` attributed there); the
  remainder is burned via per-outpoint reattribution
  (`bond_outpoint`'s attributed TAC drops to zero with no
  offsetting attribution to any other outpoint, contracting
  circulating supply against the 21M cap). The slash never
  flows into the cBTC.tac insurance pool or any other pooled
  sink.
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
- The cBTC.tac §5.47 lien mechanism itself (inherited as-is;
  this amendment is one more consumer of the same
  `commitmentForUtxo` enforcement point, with a different
  bond-state table and different authorized lien-release
  opcodes — no change to the lien-enforcement code path)

It DOES add:

- Three new opcodes (`0x5F`, `0x60`, `0x61`; tentative)
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
   `bounty_tac = bond_amount_tac × 10%` worth of indexer-
   attributed TAC; the remaining 90% is burned (per-outpoint:
   `bond_outpoint`'s attributed TAC drops to zero with no
   offsetting attribution); `bond.bond_amount_tac → 0`,
   `bond.state → "slashed"`, `worker_flag.equivocator = true`.
   The bond UTXO at `bond_outpoint` is still present on Bitcoin
   but the indexer attributes zero TAC value to it.
3. **Slash during close-notice period.** Worker posts bond,
   attests honestly, then submits close-notice. Mid-notice,
   equivocation evidence from the worker's earlier active period
   is submitted. Slash lands during the notice window; verify
   `bond.state → "slashed"`; verify any subsequent step-2 close
   envelope is rejected by the indexer's `state != "closing"`
   guard and its declared vout[1] receives zero indexer-
   attributed TAC.
4. **Slash after close completes (public-good flag-set).**
   Worker fully closes their bond (notice elapses; step-2 close
   envelope reattributes TAC to the worker's destination).
   Evidence from their active period is then submitted. Verify
   the slash envelope is **accepted** (not rejected):
   `worker_flag.equivocator → true`; bond stays in "closed"
   state (no transition to slashed — TAC already returned);
   the reporter's declared vout[1] receives **zero** indexer-
   attributed TAC (no bounty — nothing to pay from). Reporter
   has paid Bitcoin fees with no economic return, but the
   worker is now flagged for all future dapp queries.
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
8. **Burn accounting.** Compute circulating TAC before and
   after the test run as `Σ commitmentForUtxo(o).tac across
   all unspent outpoints` (the helper returns 0 for liens in
   `slashed` state, so slashed bonds naturally drop out).
   Verify `Δcirculating_TAC == -Σ(burn_tac per slash)`. Verify
   the reporter bounty UTXOs sum to `Σ(bounty_tac per slash)`
   and each is indexer-attributed but unbacked by any per-tx
   TAC input. Verify slashed `bond_state` entries have
   `bond_amount_tac == 0` and `state == "slashed"`.
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
18. **Worker spends bond_outpoint without authorization (rug
    attempt).** Worker opens a bond, attests honestly for a
    while, then spends `bond_outpoint` to themselves via an
    ordinary `T_AXFER` without going through
    `T_WORKER_BOND_CLOSE` step 2. The Bitcoin spend confirms;
    the indexer's lien refuses to attribute TAC to the outputs
    of the unauthorized spend; the worker's resulting UTXO has
    zero TAC value. `bond_state[bond].state` stays "active"
    with the original `bond_amount_tac`. A subsequent slash
    (if equivocation evidence exists) still successfully
    transfers `bounty_tac` to the reporter and burns the rest,
    even though no real TAC UTXO underlies the bond_state
    record anymore. This is the critical adversarial test —
    the lien must hold against unauthorized spends; a
    miscompiled `commitmentForUtxo` here would let workers rug
    bonds.
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
      slash determinism semantics, the integration with cBTC.tac
      §5.47.3 `commitmentForUtxo` lien enforcement, and the
      conservation-exception accounting for slash-bounty
      TAC reattribution)
- [ ] Reference dapp implementation
- [ ] Reference worker / indexer implementation
- [ ] Signet e2e validation
- [ ] Cross-impl parity tests
- [ ] Merge into `SPEC.md` as §5.X and mark `✅ Merged` in
      `AMENDMENTS.md`
