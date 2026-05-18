# SPEC Amendment — Blinded-Pubkey Commits (canonical primitive)

> **STATUS: DRAFT** (2026-05-19). Promotes the blinded-pubkey commit
> construction from inline definition in
> `SPEC-CBTC-TAC-AMENDMENT.md §5.36.7` to a citeable standalone
> primitive. Defines two derivation variants (self-derived for single-
> party use; ECDH-derived for sender ↔ recipient pairs), specifies a
> canonical anchor registry across opcodes, and lays out a backwards-
> compatible phased rollout for shipped surfaces.
>
> Reuses BIP-341 key-tweak math; no new cryptography. Composes
> orthogonally with Pedersen amount commits, so tacit surfaces two
> privacy capabilities side-by-side:
>
> - **Shielded amount** (current default) — Pedersen amount privacy
>   with the recipient's pubkey visible at the dust marker. Suits
>   audit-friendly business flows where the recipient wants to be
>   identifiable but amounts must be private.
> - **Shielded amount + shielded address** (opt-in via this amendment)
>   — both amount and recipient pubkey hidden; the on-chain marker
>   sits at a per-transaction unique address with no apparent link to
>   the recipient's published identity. Suits maximum-privacy peer-
>   to-peer flows and any opcode where on-chain identity clustering
>   is the residual leak.
>
> Wallets opt into the latter by advertising support in their address
> format; senders pick the scheme at tx-build time based on the
> recipient's signaled capability. Both schemes remain valid
> indefinitely; the protocol enforces neither.
>
> Companion to:
> - `SPEC-CBTC-TAC-AMENDMENT.md §5.36.7` (first deployment of the
>   construction; recovery-pk commit anchor)
> - `SPEC-AMM-FARM-AMENDMENT.md` (launcher_commit, bonder_commit,
>   second deployment of the construction)
> - BIP-340 (Schnorr signatures), BIP-341 (Taproot key tweaks),
>   BIP-352 (Silent Payments — same construction with specific
>   shared-secret derivation; tacit's stealth-recipient variant
>   reaches the same property via tacit's own ECDH stack)

---

## Motivation

Tacit's existing privacy stack hides amounts at every layer:

- Pedersen amount commits on every confidential asset UTXO
  (`SPEC.md §3.6–§3.8`).
- ECDH-derived keystream encryption of `(amount, blinding)` for
  recipient-side recovery (`SPEC.md §5.7.6` and amount-recovery
  appendices).
- Groth16 mixer for unlinkability between deposit and withdraw at
  the protocol envelope layer (`SPEC.md §5.10–§5.11`).

What this stack does **not** hide is the recipient's secp256k1 pubkey
at the on-chain dust marker. Every CXFER / AXFER output sits at
`P2WPKH(hash160(recipient_pub))` for a stable `recipient_pub`. Two
transfers to the same recipient land at the **same Bitcoin address**
— chain-graph clustering links them trivially. The mixer withdraw
recipient (`SPEC.md §5.11`) and the slot-burn payout
(`SPEC-CBTC-ZK-AMENDMENT.md §5.22`) have the same leak at their
respective payout markers.

The leak exists today as a soft cost mitigated by user discipline:
the spec recommends fresh-pubkey-per-transfer (and a dapp can
implement this via BIP-32 / staking-subkey allocation). User
discipline is a SHOULD, not a structural guarantee. Where users opt
out — by reusing addresses, by skipping the fresh-key step, by
sharing an address publicly — the chain-graph leak resurfaces.

This amendment specifies a construction that **promotes the
fresh-pubkey-per-transfer property from a SHOULD to a structural
guarantee** without changing the recipient's custody model. The
recipient's wallet seed remains the sole spending authority; only
the on-chain visibility of "recipient X received payment Y" changes.

The construction is mechanically identical to BIP-341 Taproot key
tweaking with a chosen tweak source — well-understood machinery,
already deployed in Bitcoin mainnet for two years. The novelty here
is **the uniform protocol-wide application via opcode-specific
anchor selection** and the standardization of derivation variants
into a single citeable primitive.

---

## §A. The construction

### §A.1 Definition

Given an underlying secp256k1 public key `P_underlying` (33 bytes
compressed) and a uniformly random scalar `b ∈ [1, SECP_N − 1]`:

```
commit  =  P_underlying  +  b · G
```

where `G` is the secp256k1 base point. The commit is itself a
compressed secp256k1 point (33 bytes) — identical wire format and
on-chain representation to any other compressed pubkey.

The corresponding spending-authority scalar is the **tweaked secret**:

```
tweaked_sk  =  (sk_underlying  +  b)  mod SECP_N
```

where `sk_underlying` is the private key of `P_underlying`. Holders
of `tweaked_sk` can:

- Sign BIP-340 Schnorr against `x_only(commit)` — used when the
  output script is P2TR (key-path).
- Sign ECDSA against `commit_compressed` — used when the output
  script is P2WPKH with program `hash160(commit_compressed)`.

Both signing modes are valid; the choice is per-opcode, driven by
the output script type chosen for that opcode. The construction
itself is signature-mode-agnostic.

### §A.2 Two derivation variants

The randomness source for `b` is opcode-specific. This amendment
defines two canonical derivation variants.

**Variant 1 — self-derived** (single party, no counterparty).

Used when the party computing the commit is also the holder of
`sk_underlying`. Anchors:

```
b  =  HMAC-SHA256( wallet.priv,
                   domain  ||  network_tag  ||  anchor )  mod SECP_N
```

`anchor` is an opcode-specific public value (e.g., `target_leaf_hash`
for `T_CBTC_TAC_DEPOSIT`, `farm_id || farm_nonce` for `T_FARM_INIT`,
`intent_id` for marketplace intents). `domain` is a per-opcode domain
tag from the registry in §C below.

Recovery from seed: the party with `wallet.priv` re-derives `b` from
any on-chain anchor and recovers `tweaked_sk`. Stateless; no local
persistence required.

**Variant 2 — ECDH-derived** (sender ↔ recipient).

Used when one party (the sender) computes the commit, and a different
party (the recipient) must independently re-derive it. Anchors:

```
shared    =  ECDH( sender_priv,  P_recipient )
                =  sender_priv · P_recipient
                =  recipient_priv · P_sender          (by ECDH symmetry)

b  =  HMAC-SHA256( shared,
                   domain  ||  network_tag  ||  tx_anchor )  mod SECP_N

commit  =  P_recipient  +  b · G
```

The recipient knows `recipient_priv` and observes `P_sender` on chain
(from the tx's input witnesses). They re-derive the same `shared`
secret via symmetric ECDH, compute the same `b`, and recover
`tweaked_sk = (recipient_priv + b) mod SECP_N`.

`tx_anchor` is opcode-specific (typically `vin[0]` outpoint or a
similar per-tx unique value) — ensures each transfer between the same
sender / recipient pair produces a distinct commit. `domain` is from
the registry in §C.

Recovery from seed: given the recipient's wallet seed and on-chain tx
data, the recipient re-derives every credit deterministically. No
local subkey index, no scan-window limit.

### §A.3 Spending

A holder spending a UTXO whose script binds the commit:

1. Recompute `b` from the stored derivation inputs (anchor + sender
   pubkey if ECDH-variant).
2. Compute `tweaked_sk = (sk_underlying + b) mod SECP_N`.
3. Sign:
   - **P2TR key-path**: BIP-340 Schnorr over the standard sighash
     under `tweaked_sk`. BIP-340 even-Y handling is internal to the
     signer (negates the secret if the derived pubkey has odd Y).
     Witness: 64-byte (or 65-byte with sighash flag) Schnorr sig.
   - **P2WPKH**: ECDSA over the standard sighash under `tweaked_sk`,
     with `commit_compressed` in the witness as the pubkey. Witness:
     standard P2WPKH (sig + 33-byte pubkey).

Both shapes are spend-cost-equivalent to their classical analogs
(P2TR key-path under a static pubkey vs P2WPKH under a static pubkey).
**The blinded-pubkey commit adds zero on-chain cost** relative to a
classical fresh-pubkey approach at the same output script type.

### §A.4 Properties

- **Pubkey hiding**: under DLOG, an observer with knowledge of
  `commit` alone cannot recover `P_underlying` or `b`. For uniformly
  random `b`, the commit distribution is computationally
  indistinguishable from a fresh random secp256k1 pubkey.
- **Pubkey binding**: given a commit, only one pair
  `(P_underlying, b)` opens it (under DLOG). The commit is
  computationally binding to its derivation inputs.
- **Custody preservation**: the recipient's wallet seed remains the
  sole spending authority. Loss-of-seed loses every UTXO at every
  derived commit — same loss model as classical wallets. Compromise-
  of-seed compromises every UTXO at every derived commit — same
  threat model as classical wallets.
- **Per-anchor unlinkability**: distinct anchors produce
  cryptographically unlinkable commits. An observer with knowledge
  of `commit_1` and `commit_2` cannot determine they share a common
  underlying pubkey without one of the derivation secrets.
- **Composition with Pedersen amounts**: orthogonal. Pedersen hides
  amounts; the commit hides pubkey identity. In CXFER specifically,
  the same ECDH shared secret derives both keystreams (one for amount
  encryption, one for pubkey blinding) with different domain tags —
  single ECDH call, two privacy planes.

---

## §B. Two capabilities, surfaced side-by-side

Tacit retains both privacy modes simultaneously; users (or their
dapps) pick per-transaction.

### §B.1 Shielded amount

The current default. Pedersen amount privacy applies to every
confidential asset UTXO. The recipient's on-chain dust marker sits at
`P2WPKH(hash160(P_recipient))` for a stable `P_recipient`. Multiple
transfers to the same recipient cluster at the same Bitcoin address.

Use cases:

- Business flows where the recipient publishes a stable invoice
  address and wants payments visibly aggregated under that identity
  (audit, accounting, reputation).
- Backwards-compat receipts from senders whose wallets don't support
  the blinded-pubkey scheme.
- Custodial recipient pubkeys where on-chain clustering is acceptable
  or desired (e.g., a treasury address that reports balances on
  chain).

### §B.2 Shielded amount + shielded address

Opt-in via this amendment. Pedersen amount commits plus blinded-
pubkey commits on the recipient marker. Per-transaction unique
dust addresses, no apparent link to the recipient's published
identity, same custody model.

Use cases:

- Peer-to-peer transfers where neither side wants chain-graph
  clustering.
- Mixer withdraw recipients (closing the residual operational-
  privacy leak SPEC.md §5.11 line 2336 acknowledges).
- Slot-burn payout recipients (closing the analogous leak in the
  cBTC.zk burn flow).
- AMM trader / orderbook maker / marketplace intent participants
  who want intent-level identity privacy without dapp-side fresh-
  subkey discipline.
- Farm launchers and LP bonders (already standardized to this scheme
  in SPEC-AMM-FARM-AMENDMENT.md).
- cBTC.tac depositor recovery (already standardized in
  SPEC-CBTC-TAC-AMENDMENT.md §5.36.7).

### §B.3 The choice is per-tx and reversible

Neither mode is structurally enforced. A wallet that supports the
blinded-pubkey scheme can still emit classical outputs to recipients
who don't signal support, and can receive at its classical address
from senders who don't emit blinded outputs. The two modes coexist
indefinitely.

---

## §C. Canonical anchor registry

The registry standardizes which value plays the role of `anchor` /
`tx_anchor` per opcode, and pins the per-opcode domain tag. Adding a
new entry requires a one-line registry update; the construction
itself is unchanged.

| Opcode / role | Variant | Anchor | Domain tag | Status |
|---|---|---|---|---|
| `T_CBTC_TAC_DEPOSIT` depositor recovery | self-derived | `target_leaf_hash` | `tacit-cbtc-tac-recovery-blinding-v1` | normative; shipped in SPEC-CBTC-TAC §5.36.7 |
| `T_FARM_INIT` launcher | self-derived | `pool_id \|\| farm_nonce` | `tacit-amm-farm-launcher-blinding-v1` | normative; shipped in SPEC-AMM-FARM |
| `T_LP_BOND` bonder | self-derived | `farm_id \|\| bond_nonce` | `tacit-amm-bond-blinding-v1` | normative; shipped in SPEC-AMM-FARM |
| `T_CXFER` recipient | ECDH-derived | `vin[0].outpoint` | `tacit-cxfer-stealth-v1` | proposed; phased rollout in §E |
| `T_AXFER` recipient | ECDH-derived | `vin[0].outpoint` | `tacit-axfer-stealth-v1` | proposed; phased rollout in §E |
| `T_AXFER_VAR` recipient | ECDH-derived | `vin[0].outpoint` | `tacit-axfer-var-stealth-v1` | proposed |
| `T_WITHDRAW` recipient | self-derived | `nullifier_hash` | `tacit-mixer-withdraw-recovery-v1` | proposed |
| `T_SLOT_BURN` recipient | self-derived | `nullifier_hash` | `tacit-slot-burn-recovery-v1` | proposed |
| `T_SWAP_BATCH` trader | self-derived | `intent_id` | `tacit-amm-trader-v1` | proposed; ceremony-gated rollout |
| `T_SWAP_VAR` trader | self-derived | `intent_id` | `tacit-amm-trader-var-v1` | proposed |
| Orderbook intent `maker_commit` | self-derived | `intent_id` | `tacit-axintent-maker-v1` | proposed; deferred for shipped intents per §E.3 |

Future opcodes that bear a cleartext pubkey field SHOULD add a registry
row rather than re-deriving the construction inline.

---

## §D. Capability signaling — tacit address formats

The blinded-pubkey scheme is opt-in per recipient. Senders need a way
to know whether a given recipient will detect a blinded output before
emitting one.

### §D.1 Address-format encoding

This amendment reserves a new tacit address format variant. The
encoding piggybacks on the existing bech32m address scheme; the
discriminator distinguishes the two capabilities:

- **Classical receiving address** (existing): bech32m encoding of
  `(network_hrp, 0, hash160(P_recipient))`. Signals "send me classical
  P2WPKH outputs at P_recipient."
- **Stealth-capable receiving address** (new): bech32m encoding of
  `(network_hrp, 1, P_recipient_compressed[1:33])` — i.e., a longer
  payload that publishes the recipient's compressed pubkey (or
  scan-pubkey if dual-key for light-client scanning per §D.3 below)
  instead of its hash. Signals "I support the blinded-pubkey scheme;
  use ECDH-derived commits when paying me."

Senders parse the address, observe the discriminator, and pick the
output script accordingly. Wallets that don't understand the new
discriminator reject the address with a parse error (no silent
fallback to classical — the user must know they're sending to a
stealth-capable recipient).

### §D.2 Recipient-side dual-scan

A wallet implementing the new scheme MUST scan for receipts at:

- Its classical P2WPKH address (for senders who used the old scheme).
- All candidate commit-derived addresses (for senders who used the
  new scheme).

The scan loop per-tx:

```
for tx in chain since last_scan:
    for output in tx.outputs:
        if output.script == P2WPKH(hash160(wallet.pub)):
            credit(output)  // classical receipt
        else:
            for sender_pub in extract_sender_pubkeys(tx.inputs):
                shared = ECDH(wallet.priv, sender_pub)
                b = HMAC(shared, "tacit-cxfer-stealth-v1" || network ||
                                  tx.vin[0].outpoint)
                C = wallet.pub + b·G
                if output.script == P2WPKH(hash160(C_compressed)):
                    credit(output, tweaked_sk = wallet.priv + b)
```

Scan cost: one ECDH + one HMAC + one EC scalar multiplication + one
hash comparison per tx-output × sender-input combination. For a
typical wallet observing single-input txs, this is a few thousand
operations per second — well within practical limits.

### §D.3 Optional dual-pubkey for light clients

Wallets that want to delegate scanning to a light-client server
without giving up spending authority MAY use a dual-pubkey format
analogous to BIP-352's split:

- `P_scan` — given to the scanning server. Enables ECDH + commit
  derivation + hash matching; sufficient to identify receipts.
- `P_spend` — kept on the wallet. Used as `P_underlying` in the
  commit construction.

The address format then encodes both `(P_scan, P_spend)`. The scan
server identifies candidate receipts; the wallet performs the
tweaked-sk computation only at spend time.

Light-client variant is optional; single-pubkey is sufficient for
self-scanning wallets.

---

## §E. Phased rollout

The blinded-pubkey scheme is soft-fork-additive at every layer. No
existing UTXO is at risk, no existing intent breaks, no consensus
change is required.

### §E.1 Pre-launch surfaces

Surfaces not yet shipped MAY adopt the construction as their default.
This includes:

- `T_SWAP_BATCH` trader_pubkey (ceremony-gated; reachable only after
  Phase 2 trusted setup completes).
- Pre-launch amendments at draft / round-1 status per
  `AMENDMENTS.md`.

For these, list the appropriate row in §C's anchor registry; the
opcode wire format references `*_commit` in place of `*_pubkey`.
Zero migration cost.

### §E.2 Pre-activation surfaces

Surfaces with reference implementations shipped but no live mainnet
state — currently cBTC.tac and the farm amendment — adopt the
construction directly. Already done; see §5.36.7 and the farm
amendment.

### §E.3 Shipped surfaces with natural expiration

Orderbook intent records (§5.7) carry an expiry ≤365 days. Migration
plan:

1. Add a `schema_version` field to the off-chain intent record.
2. v1 records carry `maker_pubkey` (cleartext); v2 records carry
   `maker_commit` (blinded). Workers + takers validate either.
3. Dapps emit v2 for new intents post-amendment. v1 intents in
   storage continue to validate until they expire.
4. After ~1 year, every active intent is v2. Workers MAY deprecate
   v1 validation logic at that point or retain it indefinitely
   (cost is negligible).

No consensus break; settlement on chain is via standard `T_AXFER`
and consensus-side validators don't see the maker_pubkey / maker_commit
distinction.

### §E.4 Shipped surfaces with persistent state

CXFER / AXFER UTXOs don't expire. Migration plan:

1. Reserve new opcodes for blinded variants: `T_CXFER_STEALTH`,
   `T_AXFER_STEALTH` (specific opcode bytes TBD; reserve from the
   `0x60`-block per the opcode-space convention).
2. Wire format is byte-identical to the classical variant except the
   recipient marker output script is `P2WPKH(hash160(commit))` or
   `P2TR(x_only(commit))` instead of `P2WPKH(hash160(P_recipient))`.
3. Old wallets ignore unknown opcodes per `SPEC.md §5.5`; they don't
   process new-variant envelopes but their classical-variant flows
   keep working unchanged.
4. New wallets dual-scan per §D.2.
5. Senders pick variant based on the recipient's address format
   per §D.1.
6. No sunset. The two variants coexist indefinitely; the protocol
   never forces a migration.

### §E.5 Wire-format compatibility statement

Old indexers (pre-amendment) processing a chain that includes new-
variant envelopes correctly ignore them per the unknown-opcode rule.
They do NOT mis-attribute outputs at commit-derived addresses to the
classical wallet at that hash160; the hash160 of a uniformly random
commit is itself uniformly random and will not collide with any
wallet's classical hash160 except with negligible probability.

---

## §F. Soundness arguments

### §F.1 Hiding

For uniformly random `b ∈ [1, SECP_N − 1]`, the commit
`commit = P_underlying + b · G` is the sum of a fixed point and a
uniformly random group element. The result is uniformly distributed
over the group (a property of any additive group action). Therefore
an observer with `commit` alone cannot statistically distinguish it
from a fresh random secp256k1 pubkey.

Under the variant-2 ECDH derivation, `b` is HMAC-derived from a
shared secret; for any adversary without one of the two contributing
private keys, the shared secret is computationally indistinguishable
from random under the decisional Diffie-Hellman assumption, so `b` is
computationally uniform and the same hiding argument applies.

### §F.2 Binding

Given a commit `C`, an adversary who could produce two different
opening pairs `(P_1, b_1)` and `(P_2, b_2)` with
`P_1 + b_1 · G = P_2 + b_2 · G` could compute
`(P_1 - P_2) = (b_2 - b_1) · G` — i.e., solve a discrete-log
relation between `P_1 - P_2` and `G`. Under DLOG, this is
computationally infeasible. The commit is computationally binding to
its derivation inputs.

### §F.3 Unforgeability

A holder of `tweaked_sk` who signs against the commit produces a
valid BIP-340 (or ECDSA) signature for that commit's pubkey shape.
An adversary without `sk_underlying` or `b` cannot construct
`tweaked_sk`, so cannot forge such a signature under standard
EUF-CMA assumptions on BIP-340 / ECDSA. This is identical in posture
to BIP-341 key-path security; the security reduction is to the same
underlying assumption.

### §F.4 Custody model preservation

The spending authority for any UTXO at a commit-derived address is
solely `tweaked_sk = (sk_underlying + b) mod SECP_N`. Loss of
`sk_underlying` loses `tweaked_sk` (same loss model as classical
wallets). Compromise of `sk_underlying` plus knowledge of the
anchor (always public on chain) yields `tweaked_sk` (same threat
model as classical wallets; the anchor adds no privacy against an
adversary who already has `sk_underlying`).

The construction adds no new attack surface relative to classical
single-key custody; it just rotates the on-chain identifier
deterministically.

### §F.5 Even-Y handling

For P2TR key-path signing, BIP-340 requires the verification pubkey
to have even Y. If `commit` has odd Y, the signer negates the
tweaked secret before signing:
`tweaked_sk' = SECP_N - tweaked_sk` if `commit.y` is odd.
Verification under `x_only(commit)` succeeds with either parity.
Standard `signSchnorr` implementations handle this internally.

For P2WPKH (ECDSA), there is no Y constraint; the signer uses
`tweaked_sk` directly and the witness carries `commit_compressed`
(including its parity byte).

---

## §G. Composition with existing primitives

### §G.1 With Pedersen amount commits

Orthogonal. The blinded-pubkey commit lives on the **recipient pubkey
plane**; the Pedersen commit lives on the **amount plane**. A single
CXFER output can use both: the recipient marker at
`P2WPKH(hash160(commit))` (pubkey hidden) carrying a Pedersen-
committed amount (amount hidden).

### §G.2 With ECDH amount keystreams

In the ECDH-derived variant, the same shared secret used for amount
keystream encryption (per `SPEC.md §5.7.6`) is reused to derive the
blinding scalar. Single ECDH call, two domain-separated HMACs:

```
shared       = ECDH(sender_priv, P_recipient)
ks_amount    = HMAC(shared, "tacit-axintent-onchain-amount-v1" || ...)
ks_blinding  = HMAC(shared, "tacit-axintent-onchain-blinding-v1" || ...)
b_pubkey     = HMAC(shared, "tacit-cxfer-stealth-v1" ||
                            network || vin[0].outpoint)  mod SECP_N
commit       = P_recipient + b_pubkey · G
```

The recipient does the same ECDH once and derives all three values.
No new ECDH calls; no new dependencies.

### §G.3 With Groth16 mixer

The mixer hides the deposit ↔ withdraw link at the protocol envelope
layer. The blinded-pubkey commit applied to the withdraw recipient
hides the recipient identity at the on-chain payout marker — the
residual leak that `SPEC.md §5.11` line 2336 already acknowledges
under "operational privacy." The two combine to give full envelope-
layer unlinkability AND output-layer unlinkability.

### §G.4 With nullifiers

Orthogonal. Nullifiers prevent double-spend; commits hide identity.
Both appear in the same envelope (e.g., `T_WITHDRAW` carries a
nullifier and, post-amendment, can carry a recovery commit).

### §G.5 With BIP-352 Silent Payments

The construction is functionally equivalent to BIP-352. Differences
are purely in derivation specifics: BIP-352 specifies a particular
shared-secret-to-tweak derivation (with optional dual scan/spend
pubkey for light clients); this amendment uses tacit's existing HMAC
stack with opcode-specific domain tags. A wallet implementing BIP-352
on Bitcoin and this amendment on tacit shares the same custody
primitives and the same scanner architecture; only the per-protocol
derivation inputs differ.

Tacit MAY adopt BIP-352-byte-compatibility as a future amendment
(useful for cross-protocol wallet libraries); the present amendment
does not require it.

---

## §H. Dapp implementation notes

### §H.1 Scanner

Wallets implementing variant-2 (ECDH-derived) must add an ECDH +
commit-derivation pass to their chain scan. Cost is one ECDH + one
EC scalar multiplication per (tx-input, tx-output) pair. For a
single-input tx, that's a few hundred microseconds on commodity
hardware — well within wallet refresh budgets.

Implementations SHOULD cache the per-tx shared secret across all
candidate outputs in the same tx (single ECDH per tx).

### §H.2 Spend-path key derivation

At spend time, the wallet looks up the per-UTXO derivation inputs
from its receipts ledger and recomputes `b` and `tweaked_sk`
on demand. No persistent storage of per-UTXO tweaked secrets — they
are deterministic functions of `(wallet.priv, anchor)`.

### §H.3 UI: unified balance, optional power-user view

The keyring of derived addresses MUST NOT surface in the default UI.
Wallets present a single balance summing all UTXOs the wallet
controls — across classical and commit-derived addresses. Activity
feeds show receipts and sends without reference to derived address
identity. Send flows pick UTXOs across all addresses transparently.

Wallets MAY expose a power-user audit view showing the on-chain
footprint (all derived addresses + their balances) for users who
want to inspect chain-graph exposure. This is a debug surface, not
default UI.

### §H.4 Address format presentation

The dapp's "share my receiving address" surface SHOULD present both
the classical and the stealth-capable address formats, defaulting to
stealth when the user has opted in. Senders sending TO the user
parse whichever address they receive; if both are advertised, the
sender picks stealth.

The "privacy mode" toggle in the dapp's settings governs the default:
on (stealth address advertised by default) or off (classical only).
Per-transaction overrides remain available via an advanced toggle.

---

## §I. Cross-references

- `SPEC-CBTC-TAC-AMENDMENT.md §5.36.7` — first deployment; see for
  worked example of the self-derived variant.
- `SPEC-AMM-FARM-AMENDMENT.md` — second deployment; launcher and
  bonder commits.
- `AMM.md` "LP privacy via blinded-pubkey commits" — narrative
  introduction; this amendment is its normative basis.
- `BIP-340` — Schnorr signatures, even-Y handling, P2TR key-path
  spending.
- `BIP-341` — Taproot key tweak construction; mathematically
  identical to this amendment's commit construction.
- `BIP-352` — Silent Payments on Bitcoin; this amendment's variant-2
  is functionally equivalent.
- `SPEC.md §5.5` — unknown-opcode rule; load-bearing for the soft-
  fork-additive rollout strategy in §E.

---

## Summary

A single normative primitive consolidating an ad-hoc privacy
technique that has emerged across multiple tacit amendments into a
citeable canonical reference. Defines two derivation variants, an
anchor registry, a phased rollout for shipped surfaces, and a
backwards-compatible capability signal so users opt in via address
format.

Zero new cryptography. Zero on-chain cost. Zero migration risk for
shipped state. The protocol exposes both "shielded amount" and
"shielded amount + shielded address" capabilities side-by-side
indefinitely; users pick at receipt time via their published address
format, and senders honor the choice at tx-build time.
