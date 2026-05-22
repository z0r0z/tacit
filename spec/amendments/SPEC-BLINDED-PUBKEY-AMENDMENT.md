# SPEC Amendment — Blinded-Pubkey Commits (canonical primitive)

> **STATUS: DRAFT** (last revised 2026-05-22). Promotes the blinded-pubkey commit
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
sharedPt  =  ECDH( sender_priv,  P_recipient )
                =  sender_priv · P_recipient
                =  recipient_priv · P_sender          (by ECDH symmetry)

shared    =  SHA256( x_only(sharedPt) )                // 32 bytes — NORMATIVE

b  =  HMAC-SHA256( shared,
                   domain  ||  network_tag  ||  tx_anchor )  mod SECP_N

commit  =  P_recipient  +  b · G
```

**Shared-secret serialization (NORMATIVE).** The HMAC key `shared` is
**`SHA256(x_only(sharedPt))`** — the SHA256 hash of the x-only (32-byte)
serialization of the ECDH point, with parity byte stripped. This
matches the convention already in production in `dapp/tacit.js` for
amount-keystream ECDH derivation (per `SPEC.md §5.7.6` line 202),
fulfilling §G.2's promise that a single ECDH call drives both planes.
Two implementations that disagree on this byte-form will silently miss
each other's stealth receipts; the choice is pinned here once and
must NOT be substituted with the compressed (33-byte) or uncompressed
(65-byte) form.

The recipient knows `recipient_priv` and observes `P_sender` on chain
(from the tx's input witnesses, aggregated per §A.2.5). They re-derive
the same `sharedPt` via symmetric ECDH, hash to `shared` per above,
compute the same `b`, and recover
`tweaked_sk = (recipient_priv + b) mod SECP_N`.

`tx_anchor` is opcode-specific — ensures each transfer between the
same sender / recipient pair produces a distinct commit. `domain` is
from the registry in §C. For tacit envelope opcodes, `vin[0]` is
always the commit-reveal P2TR script-path input (ineligible per
§A.2.5 rule 5); the canonical class-2 transfer-opcode anchor uses
**`vin[1].outpoint` — the first asset input** — which is also the
existing amount-channel anchor, so a single outpoint binds both
privacy planes.

**txid byte-order in `tx_anchor` (NORMATIVE).** When an anchor
includes any txid reference, the txid bytes are serialized in
**little-endian Bitcoin wire order** (the natural raw bytes of the
txid as it appears in the tx's serialization, before the "display-
reverse" convention applied by block explorers). Specifically:
`tx_anchor_head = txid_LE_bytes(32) || vout_LE(4)`. Sender and
recipient MUST agree on this; the wire-order convention is
deterministic from the tx alone (no display-string round-trip).

Recovery from seed: given the recipient's wallet seed and on-chain tx
data, the recipient re-derives every credit deterministically. No
local subkey index, no scan-window limit.

### §A.2.5 Input-pubkey selection rule (ECDH variant)

For the ECDH-derived variant, the recipient must extract a
deterministic `P_sender` from the tx's input witnesses. Multi-input
transactions and adversarially-crafted input sets force a
specification: a naïve "use vin[0]" rule is breakable (an attacker
can prepend a dust input under their own key, breaking the
recipient's derivation; or split a payment across multiple senders,
ambiguating which input is the "sender"). This subsection specifies
the rule normatively.

**`P_sender` (the ECDH-eligible aggregate):**

```
P_sender  =  Σ over eligible inputs i of  P_i
```

where `P_i` is the input's signing pubkey, extracted per the
following input-eligibility rules (adapted from BIP-352 §"Inputs For
Shared Secret Derivation" with tacit-specific extensions):

The rules are applied **in the listed order**; the first matching
rule wins. Rule 1 (mixer-derived) MUST therefore be evaluated before
the script-shape rules — a mixer-withdraw recipient marker is itself
P2WPKH-shaped, and without precedence the wrong rule would fire.

1. **Mixer-derived inputs** — **excluded.** Defined mechanically:
   an input is mixer-derived iff its `prevout` was emitted as the
   recipient marker UTXO of a confirmed mixer-emitting envelope
   (per `SPEC.md §5.11`). The classification is observable from
   chain alone by walking the prevout's source tx, parsing the
   envelope at vout[0], and checking the opcode byte is in the
   mixer-emitting set `{ T_WITHDRAW (0x2A), T_SLOT_BURN (0x44), … }`.
   No off-chain state required; sender and recipient classifications
   are guaranteed identical.

   Rationale: the "sender" of a mixer-withdraw output is the
   anonymous-set holder who proved a leaf, not a Bitcoin-layer
   identity. ECDH against the withdraw recipient's fresh pubkey
   would not match any meaningful sender; treating the input as
   ineligible avoids ambiguity. Class-1 follow-up amendments that
   add stealth to T_WITHDRAW itself (via the `recovery_commit`
   field, per §C registry) handle their own commit construction
   independently — they don't pass through this aggregate.

   A reference matcher (in code: `isMixerDerivedInput(prevoutTx)`)
   walks the prevout's parent tx and returns true iff the parent
   tx's vout[0] envelope opcode is in the mixer-emitting set.
   Future class-1 additions extend this set via their amendment.

   No shipped tacit opcode currently emits **confidential asset**
   UTXOs from the mixer-emitting set (T_WITHDRAW / T_SLOT_BURN emit
   sats), so today no class-2 reveal tx's asset inputs can be
   mixer-derived. The rule is normative regardless — implementations
   MUST enforce it ahead of script-shape classification so the
   eligibility result remains correct the moment a class-1 stealth-
   withdraw amendment ships and asset UTXOs start flowing out of
   mixer-family opcodes.
2. **P2TR key-path spends** — include the input's `output_key` (the
   x-only key under which the Schnorr signature was generated),
   converted to a full pubkey by re-deriving Y per BIP-340 even-Y
   convention.
3. **P2WPKH spends** — include the pubkey from `witness[1]` (the
   33-byte compressed pubkey in the standard P2WPKH witness).
4. **P2WSH or other script-path inputs** — **excluded.** The signing
   key may be a multisig aggregate or unspecified; not usable as a
   sender identity for ECDH.
5. **P2TR script-path spends (non-key-path)** — **excluded** for the
   same reason. Tacit envelope inputs (the commit-reveal P2TR
   script-path that carries every tacit envelope opcode at vin[0])
   fall under this rule and are excluded from `P_sender`. The
   wallet's identity is already established by the asset inputs at
   vin[1+]; including the envelope input's xonly would add a
   redundant `wallet.pub` to the aggregate without changing any
   security property. A future opcode that has only an envelope
   input + sats funding (no asset inputs, so `P_sender = O` under
   this rule) would need its own amendment to either re-enable
   envelope-input eligibility for that opcode or supply an alternate
   anchor; no such opcode exists today.

The sum is taken in the secp256k1 group. If `P_sender = O` (the
point at infinity — vanishingly improbable for uniformly random
input pubkeys, but possible if an attacker constructs a tx where
inputs sum to zero), the recipient treats the tx as ineligible for
ECDH-variant matching and skips it.

**Sender-side derivation** uses the corresponding aggregate
private key. For inputs the sender controls, this is
`sk_sender = Σ over eligible inputs i of sk_i mod SECP_N`. The
sender's wallet must enumerate which inputs it owns + the eligibility
class of each, sum the corresponding scalars, and use the result
for the ECDH:

```
shared  =  sk_sender  ·  P_recipient
```

Note that `sk_sender · G = P_sender` by linearity, so the recipient's
symmetric derivation `recipient_priv · P_sender` yields the same
`shared`. Both sides land on the same secret without either
revealing their individual inputs to the other.

**Multi-sender transactions** (inputs from multiple wallets, e.g.,
CoinJoin-shaped settlements) require all participating senders to
contribute their `sk_sender` portion via a multi-party ECDH protocol
(or the recipient is paid via a separate, single-sender output).
The amendment does NOT specify multi-sender ECDH for v1; the dapp
SHOULD refuse to emit a blinded-recipient output in a multi-sender
tx for v1.

**Adversarial input injection.** An attacker who adds a dust input
to the sender's tx (e.g., a pin-down attempt) shifts `P_sender` by
the attacker's `P_extra`. The recipient's derivation becomes
`shared' = recipient_priv · (P_sender + P_extra)`, which differs from
the sender's `(sk_sender + sk_extra) · P_recipient` only if the
attacker doesn't actually contribute `sk_extra` to the tx (i.e.,
they pin without signing under the attacker's pubkey). Bitcoin
consensus requires every input to sign, so this attack reduces to
"the attacker contributes a fully-signed input." Under that
assumption, sender + attacker must both compute the ECDH using
their respective scalars and produce signatures consistent with
the aggregate. This is feasible only if they coordinate — i.e., if
the "attacker" is effectively a co-sender. The recipient receives
the payment normally.

The pin-down-without-signing attack is therefore structurally
blocked by Bitcoin's input-signing requirement, not by an additional
spec rule.

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

**Class 1 — validator-coordinated commits (require per-opcode
wire-format change).** The envelope itself carries a commit field
that the validator dispatches on.

| Opcode / role | Variant | Anchor | Domain tag | Status |
|---|---|---|---|---|
| `T_CBTC_TAC_DEPOSIT` depositor recovery | self-derived | `target_leaf_hash` | `tacit-cbtc-tac-recovery-blinding-v1` | normative; **code shipped** in `dapp/tacit.js` + `worker/src/index.js` per SPEC-CBTC-TAC §5.36.7 (modulo cBTC.tac §5.42 bootstrap) |
| `T_FARM_INIT` launcher | self-derived | `pool_id \|\| farm_nonce` | `tacit-amm-farm-launcher-blinding-v1` | normative; **code pending** — SPEC-AMM-FARM amendment specifies `launcher_commit`, but `worker/src/index.js` decoder still reads `launcher_pubkey`. Migration is a follow-up; the construction is reserved. |
| `T_LP_BOND` bonder | self-derived | `farm_id \|\| bond_nonce` | `tacit-amm-bond-blinding-v1` | normative; **code pending** — same shape as the T_FARM_INIT row |
| `T_WITHDRAW` recovery | self-derived | `nullifier_hash` | `tacit-mixer-withdraw-recovery-v1` | proposed; envelope adds optional `recovery_commit` field |
| `T_SLOT_BURN` recovery | self-derived | `nullifier_hash` | `tacit-slot-burn-recovery-v1` | proposed; envelope adds optional `recovery_commit` field |
| `T_SWAP_BATCH` trader | self-derived | `intent_id` | `tacit-amm-trader-v1` | proposed; ceremony-gated; envelope field replaces `trader_pubkey` |
| `T_SWAP_VAR` trader | self-derived | `intent_id` | `tacit-amm-trader-var-v1` | proposed; envelope field replaces `trader_pubkey` |
| Orderbook intent `maker_commit` | self-derived | `intent_id` | `tacit-axintent-maker-v1` | proposed; off-chain schema-versioned record per §E.3 |

**Class 2 — pure-dapp transfer recipients (no wire-format change).**
The recipient marker is a Bitcoin output script chosen by the
sender's dapp; the protocol-layer envelope does not reference it.
The dapp + recipient wallet coordinate via the address-format
capability signal in §D and the scanner rule in §D.2. No opcode
reservation; no envelope change.

For every row below, `first_asset_in.outpoint` is `vin[1].outpoint`
in the reveal tx — `vin[0]` is reserved for the commit-reveal
envelope input (ineligible per §A.2.5 rule 5). The anchor matches
the existing amount-channel anchor convention so a single outpoint
binds both privacy planes.

| Surface | Variant | Anchor | Domain tag | Status |
|---|---|---|---|---|
| `T_CXFER` recipient marker | ECDH-derived | `first_asset_in.outpoint \|\| vout_index` | `tacit-cxfer-stealth-v1` | normative; **code shipped** in `dapp/tacit.js` |
| `T_CXFER_BPP` recipient marker | ECDH-derived | `first_asset_in.outpoint \|\| vout_index` | `tacit-cxfer-bpp-stealth-v1` | normative; **code shipped** in `dapp/tacit.js` |
| `T_AXFER` recipient marker | ECDH-derived | `first_asset_in.outpoint \|\| vout_index` | `tacit-axfer-stealth-v1` | proposed; dapp + scanner only |
| `T_AXFER_BPP` recipient marker | ECDH-derived | `first_asset_in.outpoint \|\| vout_index` | `tacit-axfer-bpp-stealth-v1` | proposed; dapp + scanner only |
| `T_AXFER_VAR` recipient marker | ECDH-derived | `first_asset_in.outpoint \|\| vout_index` | `tacit-axfer-var-stealth-v1` | proposed; dapp + scanner only |
| `T_AXFER_VAR_BPP` recipient marker | ECDH-derived | `first_asset_in.outpoint \|\| vout_index` | `tacit-axfer-var-bpp-stealth-v1` | proposed; dapp + scanner only |
| `T_LP_ADD` LP-share recipient marker | ECDH-derived | `pool_id \|\| first_asset_in.outpoint \|\| vout_index` | `tacit-lp-add-stealth-v1` | proposed; dapp + scanner only |
| `T_LP_REMOVE` payout markers | ECDH-derived | `pool_id \|\| first_asset_in.outpoint \|\| vout_index` | `tacit-lp-remove-stealth-v1` | proposed; dapp + scanner only |

The `vout_index` suffix in the class-2 anchors prevents collision when
a single tx produces multiple outputs to the same recipient — without
it, two outputs paying the same address would land at the same
stealth commit and observers could cluster them.

Future opcodes that bear a cleartext pubkey field SHOULD add a registry
row rather than re-deriving the construction inline. Class-1 entries
require an opcode-specific amendment; class-2 entries require only a
dapp/scanner implementation note plus a row here.

---

## §D. Capability signaling — tacit address formats

The blinded-pubkey scheme is opt-in per recipient. Senders need a way
to know whether a given recipient will detect a blinded output before
emitting one.

### §D.1 Address-format encoding (normative)

This amendment reserves a new tacit address format variant. The
encoding piggybacks on the existing bech32m machinery; the
discriminator distinguishes the two capabilities.

**Classical receiving address** (existing, unchanged):

```
hrp           =  network HRP per SPEC.md §4.3
                 ("bc" mainnet, "tb" signet, "bcrt" regtest)
witness_ver   =  0          (P2WPKH)  OR  1 (P2TR)
payload       =  hash160(P_recipient) (20 bytes for WPKH)
                 OR x_only(P_recipient) (32 bytes for P2TR)
address       =  bech32m_encode(hrp, [witness_ver] ++ payload_5bit)
```

Standard Bitcoin segwit address shape; no tacit-specific changes.
Signals "send me classical outputs at `P_recipient`."

**Stealth-capable receiving address** (new):

```
hrp           =  tacit-specific HRP per network:
                   "tcs"   on mainnet (tacit stealth)
                   "tcsts" on signet
                   "tcsrt" on regtest
                 (distinct from segwit HRPs to prevent classical-
                  segwit parsers from silently accepting and
                  misinterpreting these addresses)
version       =  0x00  (one byte; this amendment's format version;
                        future revisions increment)
mode          =  0x00  for single-pubkey scheme
                 0x01  for dual-pubkey (scan/spend split) per §D.3
payload       =
  mode == 0x00:  P_recipient_compressed             (33 bytes)
  mode == 0x01:  P_scan_compressed  ||
                 P_spend_compressed                  (66 bytes)
checksum      =  bech32m checksum (6 chars, post-encoding)
address       =  bech32m_encode(hrp,
                                [version, mode] ++ payload ++ checksum)
```

Encoded payload length:

| mode | payload bytes | 5-bit groups | total bech32m chars (incl. checksum + sep) |
|---|---|---|---|
| 0x00 single | 35 | 56 | ~70 chars on mainnet (incl. 3-char HRP + 1-char separator + 6-char checksum) |
| 0x01 dual | 68 | 109 | ~125 chars on mainnet |

Parser rules:

1. If the address's HRP matches a known **segwit** HRP (`bc` /
   `tb` / `bcrt`), parse as a classical Bitcoin segwit address.
   This amendment does not affect classical-address parsing.
2. If the address's HRP matches a known **tacit-stealth** HRP
   (`tcs` / `tcsts` / `tcsrt`), parse the payload as
   `[version, mode] ++ pubkey(s)`.
3. The `version` byte gates forward-compat: a parser MUST reject
   any version it doesn't understand (no silent fallback). v1
   parsers accept version `0x00` only.
4. The `mode` byte gates the payload layout: v0 parsers accept
   `0x00` and `0x01` only.
5. The pubkey(s) MUST be valid compressed secp256k1 points; the
   parser rejects malformed or non-curve points.
6. Wallets that don't recognize the tacit-stealth HRP MUST fail
   address parsing with an explicit error ("this wallet does not
   support tacit stealth addresses; please update"). No silent
   fallback to "extract a classical pubkey somehow" — the user
   must know their wallet can't reach the recipient under their
   intended privacy mode.

The HRP choice prevents the failure mode where a classical Bitcoin
wallet silently accepts a tacit-stealth address and emits a
malformed classical output. Classical segwit parsers reject `tcs`
HRPs at the bech32m HRP-validation step.

**Cross-network HRP collisions** are avoided by network-specific
prefixes (`tcs` vs `tcsts` vs `tcsrt`), matching the existing
segwit-HRP convention.

**HRP namespace claim.** The `tcs` / `tcsts` / `tcsrt` HRPs are
not registered with any external standards body (Bitcoin doesn't
maintain a formal HRP registry beyond the segwit and silent-payment
BIPs). This amendment claims them by first-deployment convention
for tacit-stealth addresses on mainnet / signet / regtest
respectively. The prefixes are distinct from every HRP currently in
production use across the Bitcoin ecosystem (`bc`, `tb`, `bcrt`,
`sp`, `tsp`, `sprt`, plus Lightning's `lnbc`/`lntb`/`lnbcrt`); they
do not collide with any deployed scheme at the time of this
amendment. Future cross-protocol claims on the `tcs*` namespace
should defer to this amendment's prior use.

### §D.2 Recipient-side dual-scan

A wallet implementing the new scheme MUST scan for receipts at:

- Its classical P2WPKH address (for senders who used the old scheme).
- All candidate commit-derived addresses (for senders who used the
  new scheme), iterating both `P2WPKH(hash160(commit))` and
  `P2TR(x_only(commit))` output script shapes per output.

**Dust output script type (normative).** Senders emitting class-2
stealth outputs SHOULD default to `P2WPKH(hash160(commit_compressed))`.
Rationale: P2WPKH is the cheapest output type (22-byte scriptpubkey)
and is universally supported by Bitcoin tooling. Senders MAY emit
`P2TR(x_only(commit))` instead for use cases that already use P2TR
(e.g., a sender whose other outputs are P2TR and wants script-type
uniformity), but the choice is per-tx and per-output; the recipient
scanner MUST handle both shapes. The address format (§D.1) does NOT
encode a script-type preference — the recipient's scanner tries
both shapes for every candidate commit.

**Domain-tag dispatch.** The scan loop iterates the set of
domain tags for opcodes the wallet supports. For class-2
transfer recipients (CXFER, AXFER, AXFER_VAR, BPP twins, LP_ADD,
LP_REMOVE per §C), the wallet first identifies the tx's tacit
envelope opcode (parsing the OP_RETURN at vout[0] if present)
and dispatches to the matching domain tag from the anchor
registry. For txs with no recognizable tacit envelope (a pure
Bitcoin tx, or a tacit envelope opcode the wallet doesn't
support), the wallet skips stealth scanning for that tx — there
is no domain context, so no candidate commit can be derived.

A wallet supporting multiple stealth-using opcodes runs the inner
HMAC + EC scalar multiplication pass once per matching opcode's
domain tag. The ECDH (the dominant cost) is computed once and
shared across all per-domain passes for the same tx.

The scan loop per-tx (single-pubkey mode):

```
for tx in chain since last_scan:
    // Classical receipts (existing behavior, unchanged)
    for output in tx.outputs:
        if output.script == P2WPKH(hash160(wallet.pub)):
            credit(output)  // classical receipt

    // Identify the tx's tacit envelope opcode (if any).
    envelope_opcode = parse_envelope_opcode(tx) or None
    if envelope_opcode is None:
        continue   // pure Bitcoin tx — no stealth scan possible
    domain = lookup_anchor_registry_domain(envelope_opcode) or None
    if domain is None:
        continue   // opcode not in §C; no stealth domain applies

    // Stealth receipts (new — class-2 dual scan)
    P_sender = aggregate_eligible_input_pubkeys(tx)  // per §A.2.5
    if P_sender == O:                                 // point at infinity
        continue                                       // tx ineligible; skip
    shared = ECDH(wallet.priv, P_sender)               // ONE ECDH per tx
    tx_anchor_head = tx.vin[1].outpoint                // first asset input —
                                                       // vin[0] is the envelope
                                                       // input (ineligible)
    for (vout_index, output) in enumerate(tx.outputs):
        b = HMAC(shared,
                 domain ||                            // per anchor registry §C
                 network_tag ||
                 tx_anchor_head ||                    // per §C registry
                 u32_LE(vout_index))                  // per-output disambiguator
        C = wallet.pub + b · G
        C_compressed = compress(C)
        C_xonly      = x_only(C)
        if output.script == P2WPKH(hash160(C_compressed)):
            credit(output,
                   tweaked_sk     = (wallet.priv + b) mod SECP_N,
                   script_kind    = 'p2wpkh',
                   sigKind        = 'ecdsa')
        elif output.script == P2TR(C_xonly):
            credit(output,
                   tweaked_sk     = (wallet.priv + b) mod SECP_N,
                   script_kind    = 'p2tr',
                   sigKind        = 'schnorr')
```

The `vout_index` in the anchor disambiguates multiple outputs to the
same recipient in the same tx (e.g., merchant batched payouts) —
without it, two outputs at the same recipient would land at identical
addresses, defeating the per-payment unlinkability.

**Scan cost summary** (cost authority — overrides any conflicting
phrasing elsewhere in this amendment):

| Operation | Per | Cost |
|---|---|---|
| ECDH | tx | ~100 µs (dominant) |
| HMAC + EC scalar mul | output | ~20 µs |
| Hash compare (P2WPKH) | output | ~1 µs |
| Hash compare (P2TR) | output | ~1 µs |

For a single-output tx: ~120 µs total. For a 100-output batch tx:
~100 µs (ECDH) + 100 × 22 µs (per-output) = ~2.3 ms.

For multi-domain wallets (supporting CXFER + AXFER + AXFER_VAR
stealth simultaneously, three domain tags), per-tx cost is ECDH +
3 × (HMAC + EC scalar mul + 2 hash compares) per output. ECDH
amortized.

**Stored credit metadata.** When the scanner credits a stealth
receipt, it persists `(txid, vout, sender_pub_aggregate, vout_index,
domain_tag)` so the spend-path can re-derive `b` and `tweaked_sk`
on demand. Implementations MAY also cache the derived `tweaked_sk`
alongside this record as a spend-path performance optimization; see
§H.2 for the security envelope.

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

**Privacy trade-off (load-bearing).** Sharing `P_scan` with a scan
server gives that server the same on-chain identification ability
the wallet has — the server learns every receipt to the wallet, the
exact amount on Bitcoin-script-level outputs, and the wallet's
chain-graph footprint. This is equivalent in posture to a watch-only
address handed to a third party. It does NOT leak spending authority
(the server can't move funds without `P_spend`'s private key), but
it DOES leak full receipt-side privacy to the server. Wallet
implementers MUST NOT present scan-key delegation as "free privacy"
— it trades chain-graph exposure to the user's chosen scan server
for scan performance against an arbitrary public observer.

Single-pubkey mode (no scan delegation) is sufficient for self-
scanning wallets and preserves stronger privacy properties. The
dual-pubkey variant exists for genuinely resource-constrained
clients that can't afford full-chain scans; use it accordingly.

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

CXFER / AXFER / AXFER_VAR UTXOs don't expire. The migration approach
here is **subtler than it first appears** — the right answer for
transfer-recipient stealth is **zero new opcodes, zero wire-format
changes**. Reasoning:

The protocol-layer envelope (`T_CXFER`, `T_AXFER`, `T_AXFER_VAR`)
carries `recipient_commit` as a Pedersen amount commitment at the
protocol layer. The validator identifies the recipient by this
Pedersen point, not by the Bitcoin script of the dust marker. The
worker indexes the resulting asset UTXO by `(txid, vout)` plus the
envelope's commits — the Bitcoin output script is irrelevant to
protocol-level state.

The only party that cares about the dust output's Bitcoin script is
the **recipient's wallet**, which uses it to identify its receipts.
A wallet supporting the stealth scheme scans for both classical-
shaped outputs (at its own `hash160(P_recipient)`) AND stealth-
derived outputs (per §D.2). A wallet not supporting stealth scans
only its classical address — but no sender will emit stealth-shaped
outputs to a recipient whose published address signals classical
only, per §D.1's address-format capability signaling.

**Migration plan for transfer-recipient stealth:**

1. **No envelope-level changes.** `T_CXFER` (`0x23`), `T_AXFER`
   (`0x26`), `T_AXFER_VAR` (`0x37`), and their BP+ twins (`0x22`,
   `0x3C`, `0x3D`) all keep their current wire formats unchanged.
2. **Dapp-level changes only.** The sender's wallet, when emitting
   to a stealth-capable address, computes the recipient marker at
   `P2WPKH(hash160(commit_compressed))` instead of
   `P2WPKH(hash160(P_recipient))`. The recipient's wallet's scanner
   adds an ECDH + commit-derivation pass per §D.2.
3. **No worker change.** The validator dispatch, the asset-UTXO
   indexer, the OP_RETURN handling, and the ancestry-walk logic are
   all unaffected. The worker doesn't see a difference between a
   classical CXFER and a stealth CXFER.
4. **Old wallets unaffected.** They don't recognize tacit-stealth
   address formats (per §D.1) and so don't receive stealth-shaped
   payments; their classical address keeps receiving classical
   outputs from any sender.

**Design rationale — why this works without new opcodes.**

Two classes of stealth use exist in tacit:

- **Class 1 — validator-coordinated commits.** The envelope's
  payload carries a commit field that the validator dispatches on
  (Schnorr sig verification, payout routing, position lookup, etc.).
  Examples: cBTC.tac `depositor_recovery_commit`, farm
  `launcher_commit`/`bonder_commit`/`unbonder_commit`/
  `harvester_commit`, future `T_WITHDRAW` and `T_SLOT_BURN`
  `recovery_commit` fields. **These DO need per-opcode wire-format
  changes** — already handled in the respective amendments
  (SPEC-CBTC-TAC §5.36.7, SPEC-AMM-FARM, future SPEC-MIXER-STEALTH-
  WITHDRAW, etc.). The protocol-layer state machine needs to know
  the commit value.

- **Class 2 — pure-dapp transfer recipients.** The recipient marker
  is purely a Bitcoin output script chosen by the sender's dapp.
  The protocol-layer envelope doesn't reference the marker's script;
  the validator never inspects it. Examples: CXFER, AXFER,
  AXFER_VAR, their BP+ twins, T_LP_ADD/T_LP_REMOVE recipient outputs,
  any future transfer-shaped opcode. **These need zero wire-format
  changes.** The dapp's output-script choice is invisible to the
  protocol; only the recipient's scanner cares.

The distinction is whether the validator's state machine needs to
*know* the commit, or whether the commit is only relevant for
recipient-side wallet identification. Wherever the answer is the
latter, no opcode change is required.

**Why earlier drafts considered new opcodes — and why that's wrong
for class 2.** A first-pass design assumed every privacy-mode change
needed a protocol-layer signal (new opcode, flag bit, or inline
kind byte). On reflection, this conflates two genuinely independent
concerns: what the protocol coordinates (validator state) vs what
the participants coordinate off-chain (recipient wallet scan). For
class-1 cases the protocol must coordinate; for class-2 cases it
doesn't have to and shouldn't. Adding new opcodes for class 2 would
bloat the opcode table without giving the protocol any new
authority — pure overhead.

The amendment therefore reserves NO new opcodes for transfer-
recipient stealth. The class-1 cases continue to land via their
own per-opcode amendments as previously planned.

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

### §F.6 Adversarial scan-flooding

A recipient performing the ECDH-derived scan does one ECDH + one
HMAC + one EC scalar multiplication per candidate tx. An adversary
who broadcasts many transactions with arbitrary sender pubkeys
forces every stealth-capable wallet to perform that work even
though none of the transactions actually pay them. With chain
growth bounded by Bitcoin's blockspace, this is a rate-limited
attack — an attacker can't make a wallet do more ECDH work than the
chain itself can produce (typically 5–50 transactions per block,
~720–7200 per hour).

For a full-wallet client on commodity hardware (~100 µs per ECDH),
the worst-case scan cost is bounded at ~700 ms per hour of chain
growth — well within practical wallet refresh budgets. For
constrained clients (mobile, watch, embedded), the cost is higher
and may motivate the scan-filter and dual-pubkey optimizations
described in §H.5.

**Mitigation paths** (in priority order, none required for v1):

1. **Scan filters (deferred, see §H.5).** A wallet pre-screens
   candidate txs using a compact filter (analogous to BIP-158)
   that lets it skip txs it could not possibly own a stealth
   output in. Reduces ECDH cost to O(actual relevant txs) rather
   than O(all txs).
2. **Scan-pubkey delegation (§D.3).** A wallet hands its
   `P_scan` to a light-client server, which does the per-tx ECDH
   work on behalf of many wallets, batching costs across users.
3. **Tier-restriction.** A future amendment MAY require the
   sender-side aggregate `P_sender` to satisfy a structural
   property (e.g., correspond to inputs from a specific class
   of UTXOs) that scan-flooding attackers can't easily satisfy.
   Not required for v1; mitigation paths 1 and 2 are sufficient.

The scan-flooding attack is well-known in BIP-352 literature and
the mitigations parallel BIP-352's compact-filter design. Tacit
inherits both the attack surface and the mitigation toolkit; this
amendment does not block the path to either.

### §F.7 Sender-pubkey unextractable inputs

For ECDH-variant derivation, the recipient extracts `P_sender` from
the tx's input witnesses per §A.2.5. Some input types deliberately
exclude themselves from this extraction:

- **P2WSH and P2TR script-path inputs**: the signing key is a
  multisig aggregate or unspecified, not a single-identity pubkey.
  Excluded per §A.2.5 rule 4–5.
- **Already-spent mixer-pool inputs** (`T_WITHDRAW` recipient
  UTXOs spent by their owners, etc.): the spending key is fresh
  per-output; the "sender" notion is the protocol counterparty,
  not a Bitcoin pubkey.

If every eligible input under §A.2.5 is excluded, the aggregate
`P_sender = O` and the tx is ineligible for ECDH-variant matching.
The recipient skips such txs. A sender's dapp emitting a stealth-
shaped output in such a tx (where the recipient cannot derive the
shared secret) creates an unrecoverable payment — funds are at the
output script but no one can identify or spend them.

**Mixed-ownership inputs are the harder failure mode.** A subtler
fund-loss case arises when the tx contains eligible inputs from
multiple parties (e.g., the emitting wallet contributes one
P2WPKH input + an external co-signer contributes another P2WPKH
input). The aggregate `P_sender = P_emitter + P_external`, but the
emitting wallet only knows `sk_emitter` — it cannot compute the
correct ECDH shared secret using `sk_emitter + sk_external` (which
would be needed to land on the same `b` the recipient derives via
`recipient_priv · (P_emitter + P_external)`). If the emitter
naively does `ECDH(sk_emitter, P_recipient)` and emits a commit
under that, the recipient's derivation will produce a different
commit and miss the receipt — funds are at an unmatchable script
and cannot be spent by either party.

**Refusal rule (NORMATIVE, load-bearing).** An emitter MUST refuse
to produce a class-2 stealth output unless **every** eligible input
(per §A.2.5) in the tx is owned by the emitting wallet. Multi-
owner eligible inputs are explicitly out of scope for v1.
Equivalently: the emitter must hold the full set of secret scalars
whose sum corresponds to `P_sender`. This MUST be verified BEFORE
the tx is signed — even a fully-signed tx with mixed-ownership
eligible inputs cannot retroactively be made stealth-spendable
because the emitter never knew `sk_external` to begin with.

In PSBT-style flows where some inputs may be filled in by an
external co-signer after the emitting dapp decides whether to
emit stealth, the dapp MUST either:
1. Fix the input set before emitting (no later co-signer inputs
   permitted in this tx), OR
2. Refuse to emit stealth and fall back to a classical-recipient
   output instead.

**Implementation test obligation (load-bearing).** This refusal
check is fund-critical: a buggy dapp that emits a stealth output
to a tx with even one external-owned eligible input burns the
recipient's funds. Reference implementations of class-2 stealth-
output emission MUST include adversarial unit tests that:

1. Construct a tx with only ineligible inputs (P2WSH, P2TR
   script-path) — emitter must refuse.
2. Construct a tx with mixed-ownership eligible inputs (one wallet-
   owned P2WPKH + one foreign P2WPKH) — emitter must refuse.

The signet harness MUST exercise both refusal paths. Failure to
implement these checks is a release-blocker for any wallet
shipping class-2 stealth support.

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
                            network || first_asset_in.outpoint)  mod SECP_N
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

The construction is **functionally equivalent** to BIP-352 — same
user-visible property (recipient publishes one address, sender
derives per-tx unique output address, recipient retains custody
via a deterministic seed-derived tweak), same underlying BIP-341
key-tweak math, same security argument.

The construction is **not byte-compatible** with BIP-352. Specific
differences:

| Aspect | BIP-352 | This amendment |
|---|---|---|
| Shared-secret derivation | `tn = hash_BIP0352/Inputs(A_sum)` + per-output counter | `HMAC-SHA256(ECDH-shared, domain ‖ network ‖ tx_anchor)` |
| Input-pubkey aggregation rule | BIP-352 §"Inputs For Shared Secret Derivation" | §A.2.5 of this amendment (adapted, plus tacit envelope inputs) |
| Address format | bech32m, HRP `sp` / `tsp` / `sprt`, BIP-352 §"Encoding addresses" | bech32m, HRP `tcs` / `tcsts` / `tcsrt`, payload per §D.1 |
| Scan/spend key split | first-class in BIP-352; default for light clients | optional per §D.3 mode `0x01` |
| Scan filter spec | BIP-352 §"Scanning" with specific filter formats | deferred to future amendment per §H.5 |
| Scope | Bitcoin sat transfers | tacit confidential-asset surface (transfers, mixer withdraws, slot burns, AMM trader, marketplace makers, validator-coordinated commits) |

**Practical consequence:** a wallet library implementing BIP-352
for Bitcoin will not automatically work for tacit-stealth payments,
and vice versa. Cross-protocol wallet ergonomics (one wallet, both
chains, single scan path) would require BIP-352-byte-compatibility
which this amendment does not provide.

**Why tacit-native rather than BIP-352-byte-compatible.** Three
reasons drove the choice:

1. **Tacit-specific input eligibility.** BIP-352's `A_sum` rule
   covers Bitcoin script types. Tacit has additional input shapes
   (commit-reveal P2TR envelopes, mixer-pool-consumed inputs,
   slot K_btc inputs) that BIP-352's rule doesn't anticipate.
   §A.2.5 specifies the tacit-specific rule directly.
2. **Composition with tacit ECDH stack.** The same shared secret
   that drives stealth address derivation also drives existing
   amount-encryption keystreams (`SPEC.md §5.7.6`). Using the
   tacit HMAC stack lets one ECDH call drive both privacy planes
   via domain separation; using BIP-352's derivation would require
   either two ECDH calls or carrying both schemes in parallel.
3. **Scope mismatch.** BIP-352 specifies one application (sat
   transfers). Tacit's anchor registry (§C) covers a dozen
   different opcodes with different anchor needs. A tacit-native
   primitive accommodates these naturally; a BIP-352 port would
   need an extension per opcode.

**Future BIP-352 byte-compatibility (optional).** A follow-up
amendment MAY add a BIP-352-byte-compatible variant for the
specific case of CXFER/AXFER transfer recipients (the class-2
surface most likely to share users with Bitcoin-only wallets).
The variant would coexist with the tacit-native form per the same
address-format capability signaling shape. Not required for v1;
viable as a cross-protocol-ergonomics enhancement post-launch.

---

## §H. Dapp implementation notes

### §H.1 Scanner

Wallets implementing variant-2 (ECDH-derived) must add an ECDH +
commit-derivation pass to their chain scan. Per the loop in §D.2,
the per-tx cost is:

- **One ECDH per tx** — computed once over the aggregate
  `P_sender` (§A.2.5) and cached across all candidate outputs in
  the same tx. NOT one ECDH per output, NOT one per tx-input.
- **One HMAC + one EC scalar multiplication per output** —
  varies the per-vout_index portion of the anchor.
- **Two hash comparisons per output** — one for the candidate
  P2WPKH script, one for the candidate P2TR script.

For a single-output tx, ~120 µs total on commodity hardware
(dominated by the one ECDH). For a 100-output batch tx, ~1.2 ms.
The ECDH cost is amortized across outputs.

For cold-load (wallet bootstrap or post-offline-rejoin), the
aggregate cost is `O(eligible_chain_txs × 120 µs)` for a
single-stealth-opcode wallet. With domain-tag fanout across N
stealth-using opcodes that a wallet supports simultaneously
(currently just one — CXFER stealth in v1; more in follow-up
amendments), the cost scales linearly in N because the ECDH is
shared but each opcode requires its own HMAC pass per output.
Practical implementations SHOULD also cache `b · G` derivations
per-(domain, vout_index) pair when scanning the same anchor
repeatedly under different domains.

A benchmark commitment of "≥ 500 txs/sec single-opcode scan rate
on commodity hardware" suffices for v1 and is achievable with
straightforward implementation. Performance regressions below this
threshold are a release blocker for the stealth-default address
format toggle.

### §H.2 Spend-path key derivation

At spend time, the wallet looks up the per-UTXO derivation inputs
from its receipts ledger and recomputes `b` and `tweaked_sk`. The
canonical persistence model stores the derivation inputs only
(`txid`, `vout_index`, `sender_aggregate_pub`, `domain_tag`, plus
the existing credit metadata `amount` + `blinding`) and re-derives
`tweaked_sk = (wallet.priv + b) mod SECP_N` on demand. Recomputation
cost is one ECDH + one HMAC + one scalar add per spent UTXO —
negligible at spend time, but non-zero in batch operations.

**Caching tweaked_sk is permitted (NORMATIVE).** Implementations
MAY cache the derived `tweaked_sk` per credit alongside the rest of
the credit record. The security envelope is identical: the credit
record already persists `amount`, `blinding`, and
`sender_aggregate_pub` for that UTXO, all of which leak together if
the wallet's persistence layer is compromised. Storing the
precomputed `tweaked_sk` adds no new exposure relative to the inputs
needed to derive it — an attacker with read access to the credit
record and without `wallet.priv` cannot spend either way (they
already had every input but the wallet master key); an attacker
with `wallet.priv` can spend regardless. Implementations that cache
SHOULD treat `tweaked_sk` as part of the same trust boundary as
`wallet.priv` itself — i.e., encrypt-at-rest if the master key is
encrypted-at-rest. Implementations that do not cache and prefer
on-demand recomputation are equally compliant; the choice is a
performance/storage trade-off, not a security one.

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

**Self-payments (sender = recipient).** A wallet paying its own
stealth-capable address is mechanically valid: `ECDH(self_priv,
self_pub)` produces a well-defined shared secret, the dapp computes
the commit, the recipient (same wallet) re-derives the same secret
and finds the receipt. The privacy benefit is narrower than for
cross-party transfers and worth stating precisely:

- **Not gained**: sender↔recipient unlinkability (trivially zero —
  same identity).
- **Not gained**: hiding from a chain analyst who has already
  clustered the wallet's input UTXOs. Such an analyst sees the
  input cluster spend and the new output address derived from it;
  the wallet's `P_underlying` is implicitly in the cluster.
- **Gained**: the derived output address does NOT cluster with the
  wallet's OTHER receiving addresses (classical receipts, prior
  stealth receipts from external senders, etc.). Each self-payment
  lands at a fresh address that, considered in isolation, looks
  unrelated to the wallet's other receive points.

That last property is useful for consolidation flows where the user
wants UTXOs to land at fresh addresses rather than at a single
re-used wallet address. It's not a substitute for Bitcoin-level
mixing if the user's goal is to break the input-cluster ↔ output
link entirely.

The dapp need not special-case self-payments. The recipient scanner
will find the receipt via the standard ECDH dual-scan path. A dapp
MAY surface a hint that the user is paying themselves with stealth
derivation engaged, but this is UX polish, not a correctness
requirement. Self-payments to one's own classical address remain
valid too — the choice between stealth-self-payment and classical-
self-payment is a per-tx user choice, same as for cross-party
transfers.

### §H.5 Historical-bootstrap and scan filters

Wallets joining the network fresh (new install, recovery from seed
after extended offline period) must scan chain history back to their
relevant horizon. Per-tx scan cost (§H.1) is bounded but cumulative;
for a wallet rejoining after a year of offline time, the chain may
contain hundreds of thousands of stealth-eligible txs that the
wallet must process before its balance display stabilizes.

This amendment does NOT specify a compact-filter design for v1.
Justification: the primary v1 deployment surface is class-1
(validator-coordinated commits), where the wallet scans only its
own positions (typically tens, not millions). For class-2 transfer
recipients, full-history scan is workable for moderate-usage
wallets and the optimization can be deferred.

**Sync-cost estimates** (rough, for sizing the future-work problem):

| Scenario | Eligible txs / day | Scan cost / day | One-year backfill |
|---|---|---|---|
| Class-1 only (cBTC.tac + farms) | tens | seconds | seconds |
| Class-2 sparse (early stealth adoption) | hundreds | ~minute | tens of minutes |
| Class-2 dense (mature stealth adoption) | thousands | ~minutes | hours |
| Adversarial flood (§F.6) | bounded by blockspace | ~hour | ~hours |

The "dense + adversarial" worst case suggests that compact-filter
support becomes valuable once class-2 stealth volume exceeds
~1000 txs/day. Below that threshold, full-history scan on
commodity hardware completes in well under an hour even for
year-long recoveries.

**Deferred design directions** (to be addressed in a follow-up
amendment when class-2 volume motivates it):

1. **BIP-158-style compact block filters for tacit stealth.** Each
   block emits a Golomb-coded set of "stealth output candidate"
   identifiers. A wallet downloads filters, pre-screens which
   blocks contain candidate matches, and only does ECDH on those.
   Reduces scan cost to O(actual blocks with relevant txs).
2. **Scan-pubkey delegation infrastructure.** A wallet's `P_scan`
   (per §D.3) can be handed to a light-client server that does the
   ECDH work and returns a candidate-receipts list. Multiple
   wallets share the server's per-tx ECDH cost. The server cannot
   spend (no `P_spend`).
3. **Birthday hint in the address.** The stealth address format
   could carry an optional "wallet birthday" hint (block height
   before which the wallet didn't exist), letting fresh wallets
   skip scanning earlier history. Trivial to add to the v0
   address format in a v1 revision.

For the present amendment, the deferred status is honest: scan-
filter design is future-work, and the v1 deployment surfaces
don't exercise the failure mode that filters would solve. Wallets
that need long-history scans before filters land SHOULD use a
trusted-server scan-delegation arrangement.

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
