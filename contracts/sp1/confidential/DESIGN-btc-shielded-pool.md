# Bitcoin-native shielded pool: source-hidden payment, no second chain

Status: DESIGN (not implemented). Fixes the gap in `DESIGN-btc-only-wrap.md`: `T_CXFER` hides amount but
not source, because its kernel signature is bound to the literal spent `txid:vout`. This proposes a
decoupled note — not a spendable Bitcoin UTXO — so spending never requires the carrying transaction to
reference the note's own prior output at all. Reuses Tacit's own toolkit throughout: Pedersen/Bulletproofs+
for variable amounts, the existing note-leaf/nullifier shape, the existing viewing-key scanning pattern,
and SP1 for the proof — deliberately not a circom+Groth16 circuit, for the reason in §4.

## 1. What actually leaks today, and why

Bitcoin consensus requires every transaction input to name a specific prior output. Tacit's Bitcoin-side
kernel signature (SPEC §2.4) hashes those outpoints directly into the signed message, so there is no way
to make a `T_CXFER` spend without revealing which earlier output it consumed — this is a design choice
(notes are real UTXOs, interoperable with ordinary Bitcoin tooling), not an oversight, but it means
`T_CXFER` alone can't give Bob a way to pay Alice without a chain observer tracing the payment back to
whichever output funded it. SPEC §11 says as much itself: "Public: Bitcoin addresses and the transaction
graph." Genuine source-hiding needs the note's existence and spend to be decoupled from Bitcoin's UTXO
graph — exactly the trick shielded-note designs (including the "Shielded Bitcoin" paper this responds to)
use: the note is an opaque commitment, spending publishes a nullifier instead of consuming a matching
input, and the transaction's real Bitcoin inputs can be whatever coins the wallet uses to pay fees.

## 2. Note model

New domain, distinct from the existing Bitcoin-homed note (which *is* a real UTXO and stays exactly as
specified for its own purpose — cross-chain spend authority, `DESIGN-btc-note-authority.md`):

```
leaf       = keccak(asset ‖ Cx ‖ Cy ‖ spend_key ‖ "tacit-btc-pool-note-v1")
nf_secret  = keccak("tacit-btc-pool-nf-v1" ‖ sk_note)
nullifier  = keccak(leaf ‖ nf_secret ‖ "spent")
```

`leaf` follows the same shape as the existing Bitcoin-homed formula, but `nullifier` deliberately does
not: reusing Bitcoin-homed's `nullifier = keccak(leaf‖"spent")` verbatim is fine there but breaks here.
The difference matters: a Bitcoin-homed
note's `auth_key` is already a real, publicly observable Bitcoin UTXO key, so that formula was never
claiming strong unlinkability to begin with. This note's `spend_key` is *not* tied to any real UTXO — the
entire point is decoupling — and every field `leaf` depends on (`asset, Cx, Cy, spend_key`) is published in
plaintext at creation. If `nullifier` were a function of `leaf` alone, **any passive chain observer could
precompute it the moment the note is created** and then simply watch for that exact value reappearing —
zero unlinkability, not partial. Folding in `nf_secret`, a value derived from the recipient's private
`sk_note` (§2 below) and never published, closes this: only the note's actual owner can ever compute the
right `nullifier`, the same role Zcash's `ρ`/`sknf` play and the same reason the competitor paper's own
nullifier depends on a private `sknf`, not on public note fields alone.

Spend authorization is proven **inside the circuit** by witnessing `sk_note` directly and constraining
`spend_key = sk_note·G` — not by a detached signature. This is simpler, not just different: once `h_body`
(§4) is itself a public input the proof is verified against, the proof already can't be repointed to a
different envelope (Groth16/SP1 proofs are bound to their exact public-input vector), so a separate
signature was never adding non-malleability — only authorization, and witnessing the secret directly proves
that more directly than signing something with it does.

**The circuit must also constrain `sk_note·G` to have an even y-coordinate, rejecting otherwise — this is
load-bearing, not a style choice.** `spend_key` is
x-only: for any scalar `d`, both `d` and `n−d` (the curve order minus `d`) produce points sharing the same
x-coordinate, so both pass an x-only equality check against the same `spend_key`. Since `nf_secret` (above)
hashes the *full* scalar, not the x-only key, `d` and `n−d` produce **different nullifiers for the same
note** — meaning the note's own owner could spend it twice, each time with a different valid nullifier,
duplicating real value. BIP-340 avoids this by canonicalizing to a single even-y representative during
signing; direct scalar-witnessing needs the same canonicalization enforced explicitly, since nothing else
provides it once there's no signature scheme's own convention to lean on. With the even-y constraint, only
one of `{d, n−d}` is ever accepted, closing the ambiguity entirely.

**`spend_key` must be a fresh one-time key per note, never a reused address — this is load-bearing, not
optional wallet hygiene.** Because the indexer derives `leaf` from public envelope fields, `spend_key` is
necessarily public. Publishing the *same* `spend_key` across two notes would make them trivially linkable
by anyone grepping the chain, independent of everything else this design hides — a real break, not a
theoretical one. The fix reuses a mechanism Tacit has already shipped rather than inventing one: the
one-time-key construction behind "pay by stealth" for the EVM pool (README). A recipient publishes a
stable receiving key `pk_recv` (their address, given out once, reused across many payments). For each
note, the sender picks a fresh ephemeral secret, publishes `pk_eph = eph·G`, and computes

```
shared  = ECDH(eph, pk_recv)
spend_key = pk_recv + H(shared)·G
```

The recipient recomputes the same `shared` from their own `sk_recv` and the published `pk_eph`, and can
therefore derive the one-time spend secret `sk_note = sk_recv + H(shared) (mod n)` to spend the note
later — witnessed directly in the proof (§4), never revealed — but no outside observer, seeing only
`spend_key` and `pk_eph`, can link this note to `pk_recv` or to any other note paid to the same recipient,
and (with the nullifier formula above, folding in `nf_secret`) cannot precompute its nullifier either, since that also
requires `sk_note`. `spend_key` is now a fresh, unlinkable-looking public value on every note, which is
what makes publishing it safe. `T_BTC_SHIELD` uses the same construction, self-directed (the depositor is
their own recipient) — no special-cased path, one derivation rule everywhere.

## 3. Two opcodes

Claims the next free Bitcoin bytes after `DESIGN-btc-only-wrap.md`'s `0x6A`/`0x6B` (SPEC §3.9, §10).

**`T_BTC_SHIELD` (0x6C) — deposit, same transaction as the lock, no escrow.**
```
0x6C ‖ asset(32) ‖ lock_vout(4 LE) ‖ Cx(32) ‖ Cy(32) ‖ pk_eph(32) ‖ spend_key(32) ‖ opening_proof(64)
```
Identical atomicity trick as `T_BTC_WRAP`: `lock_vout` names this transaction's own self-custody output,
and its value is read directly from that output — public, same as any peg-in amount is public in every
design including the competitor's (their own §20.4 admits boundary amounts are never hidden). `Cx‖Cy` is
the note's Pedersen commitment, matching the two-coordinate encoding every other Bitcoin op already uses
(e.g. `T_CBTC_LOCK`), not a compressed point — one encoding convention across the whole metaprotocol.
`opening_proof` is the same Schnorr NIZK from `T_BTC_WRAP` binding `C` to the lock's public value.
`pk_eph`/`spend_key` are the one-time-key pair from §2. `asset` names which Tacit Bitcoin asset this note
holds (raw BTC or any `T_CETCH`-issued asset — §8 of this doc). The indexer derives `leaf` from
`(asset, Cx, Cy, spend_key)` and appends it to a Bitcoin-only Merkle tree it maintains purely by replaying
accepted envelopes — the same category of indexer-derived state Tacit's Bitcoin metaprotocol already
maintains for every other op (README: "any indexer running the spec reaches the same state from the chain
alone"). This is not a new trust model, just a new tree.

**`T_BTC_SPEND` (0x6D) — pay or exit, never mixed; source and amount both hidden for a pay.**
```
0x6D ‖ asset(32) ‖ n_in(1) ‖ nf[32 × n_in] ‖ out_kind(1)
     ‖ out_kind = 0x00 (pay):  n_out(1) ‖ (Cx(32)‖Cy(32)‖pk_eph(32)‖spend_key(32)‖ct_note(56)) × n_out
     ‖ out_kind = 0x01 (exit): exit_vout(4 LE) ‖ exit_value(8 LE) ‖ dest_spk_hash(32)
     ‖ h_anchor(4 LE) ‖ proof
```
One opcode, two mutually exclusive output shapes, picked by `out_kind` — simpler than a separate exit
opcode, and it's the only way `T_BTC_UNWRAP`'s "same-tx burn" pattern (§5) actually gets implemented rather
than gestured at. `n_in` capped at 2 for v1, `n_out` (pay case) capped at 2 — covers pay-with-change and
simple consolidation without the padding question the competitor's own §22.1 leaves open for larger
arities. For `out_kind = 0x01`, `exit_vout` names this same transaction's real Bitcoin output the redeemed
value pays to, and the envelope carries both the claimed `exit_value` (u64) and `dest_spk_hash` (a hash of
the scriptPubKey that output must pay). All three must match — the indexer checks `outputs[exit_vout]`'s
real value against `exit_value` **and** its real scriptPubKey hash against `dest_spk_hash`, exactly (§10
step 2a). Both checks are load-bearing, not just the value one: binding value alone leaves the destination free
for anyone reassembling the signed envelope into a different carrier transaction to redirect the payout —
value-correct, recipient-wrong. `dest_spk_hash` closes that and is part of the canonical envelope body, covered
by `h_body` (§4), so it's signed the same way every other field is — the proof alone still doesn't
establish the real chain-data match (the guest can't see the carrying transaction's other outputs), that
part is still §10 step 2a's job, same as `T_BTC_SHIELD`'s `opening_proof`/`lock_vout` pairing.

`h_anchor` is a Bitcoin block height selecting which retained tree root the membership proof is checked
against — the sliding anchor window from the competitor's paper (their §8) is a genuinely good idea worth
taking outright: it decouples proof construction from the live chain tip the same way their
`hanchor`/valid-root window does, so a wallet doesn't have to race the chain tip to get a proof included.
`proof` is a Groth16-wrapped SP1 proof (§4); its exact byte width is fixed once the guest is compiled, not
asserted here — canonical parsing (§10) needs a real fixed width, not an approximate one, so this stays an
open field until then. `ct_note = AEAD(key derived from the §2 shared secret, plaintext = v(8) ‖ r(32),
16-byte tag)`, 56 bytes exact — just the Pedersen opening the recipient needs to later spend the note.

No fee field. Miner fees for the carrying Bitcoin transaction come from whatever unrelated coins the
wallet uses to pay them (next paragraph) — never from the pool relation itself. `Σ v_in = Σ v_out` (pay) or
`Σ v_in = value(outputs[exit_vout])` (exit) must hold exactly; the relation has no notion of a fee to skim,
which is simpler than defining one and gets the same result for v1.

**Critically: the transaction's real Bitcoin inputs/outputs are whatever coins the sender uses to pay
miner fees.** They are unrelated to the note being spent. Nothing in this envelope requires consuming a
specific prior output — that's what makes source-hiding real instead of asserted.

## 4. The proof: a fourth SP1 guest, not a new ceremony

**Whole-envelope tamper-evidence instead of enumerating fields.** Naming which specific fields need
protecting risks missing one (e.g. `pk_eph`/`ct_note` or the exit destination left unbound), so instead the
guest commits every raw envelope field — `asset`,
every nullifier, every output's full contents (`Cx, Cy, pk_eph, spend_key, ct_note` for a pay;
`exit_vout, dest_spk_hash` for an exit), and `h_anchor` — directly as its public statement (the
`BtcPoolSpendValues` the guest ABI-encodes and commits). Because a Groth16/SP1 proof is only valid for the
exact public-input vector it was generated against, this alone makes the whole envelope tamper-evident —
the same anti-malleability idea as the existing `btc_note_spend_msg` in `DESIGN-btc-note-authority.md`,
generalized to "commit the whole envelope" instead of signing a hand-picked field list. `h_body` (the hash
defined below) is a useful *concept* for reasoning about this — "one hash covers everything" — but the
guest doesn't need to commit it as a separate discrete field to get the property; committing the raw
fields directly is a strictly equivalent (if not tighter) binding, and is what the implementation actually
does. An indexer verifies by comparing the guest's committed values field-by-field against the parsed
envelope, not by recomputing and comparing a single `h_body` hash.

**Exact `canonical_body` encoding**, the one authoritative reference for it:

```
canonical_body := 0x6D ‖ asset(32) ‖ n_in(1) ‖ nf[32×n_in]  ‖ out_kind(1)
     ‖ out_kind = 0x00: n_out(1) ‖ (Cx(32)‖Cy(32)‖pk_eph(32)‖spend_key(32)‖ct_note(56)) × n_out
     ‖ out_kind = 0x01: exit_vout(4, big-endian) ‖ dest_spk_hash(32)
     ‖ h_anchor(4, big-endian)
```

Multi-byte integers inside `canonical_body` are big-endian — this differs from the envelope's own
**on-wire** encoding (§3 uses little-endian for `lock_vout`, `exit_vout`, `h_anchor`, matching the rest of
this metaprotocol's field convention), and that's deliberate, not a bug: big-endian internal hashing
alongside little-endian wire fields is the same split `T_CXFER`'s own kernel message already uses (`txid`
big-endian, `vout` little-endian, SPEC §2.4) — one more place this design reuses an existing convention
rather than inventing a new one. **`exit_value` is deliberately absent from `canonical_body`** — it doesn't
need `h_body` coverage to be tamper-resistant, because the relation already constrains it directly as a
public input via `Σv_in = exit_value` (§10 step 2a's job is checking that public input against real chain
data, not re-deriving it from `h_body`). Every count field (`n_in`, `n_out`) is a single byte, matching the
envelope's own count widths; there is no separate length prefix on any fixed-width list, since every
element in every list here has a fixed width already — nothing about this encoding is ambiguous to parse.

The indexer recomputes `leaf` (and, for exit, checks step 2a's real-chain-data fields) from the published
bytes before verifying — it does not need to separately recompute `h_body`, since the guest's committed
statement already carries the raw fields to compare against directly.

Per spent input: leaf membership under the root at `h_anchor` (the indexer supplies `root` as a public
input, the same `spendRoot` pattern the existing settle guest already uses — the guest doesn't derive
`root` from `h_anchor` itself, the indexer's own replay does, and independently verifies the two match);
`spend_key = sk_note·G` for a witnessed `sk_note`, **with `sk_note·G` constrained to even y** (§2 — this is
the authorization check, done by directly witnessing the secret rather than a detached signature; the
even-y constraint is what stops the same note being spent twice under `sk_note` and its negation);
correct nullifier derivation,
`nullifier = keccak(leaf ‖ keccak("tacit-btc-pool-nf-v1" ‖ sk_note) ‖ "spent")` (§2 — this is why `sk_note`
has to be witnessed regardless of how authorization is proven: the nullifier formula needs it).
Per created output (pay case): leaf correctly derived from `(asset, Cx, Cy, spend_key)`. Value conservation
as stated in §3, range-checked, no fee term.

Write this as a Rust SP1 guest — a fourth program alongside the settle, Bitcoin-reflection, and
Ethereum-reflection guests already in production — instead of a circom circuit. `docs/CEREMONY.md` states
plainly: "Tacit's transparent stack (SP1, Bulletproofs+, Schnorr kernels) needs no trusted setup." The two
existing Groth16 ceremonies (`amm_swap_batch`, the legacy mixer) exist because those two circuits were
written in circom, not because compact proofs inherently require a bespoke multi-party ceremony. SP1
already wraps STARK proofs down to Groth16-sized output using its own shared setup — the same mechanism
already producing the settle and reflection guests' proofs today. Writing this relation as an SP1 program
means: no new ceremony, same GPU proving box, same ELF-hash pinning and reproducible-build process already
in place (`docs/REPRODUCIBLE-BUILDS.md`). This is the concrete "hanging fruit": reuse the prover
infrastructure Tacit already operates instead of standing up new ceremony machinery to match a competitor
who also needs one.

To be precise about what this does *not* eliminate: it's not zero trust. It trades a bespoke multi-party
ceremony for trusting Succinct's SP1 Groth16-wrapping setup — the same trust Tacit already extends to
every other guest's proofs, not a new assumption.

**Proof malleability is a non-issue here.** Groth16 proofs
are known to be re-randomizable — a valid proof can be transformed into a different, still-valid proof for
the same statement (SPEC itself flags this elsewhere for other circuits). That would matter if anything
here treated a *specific proof's bytes* as an identity. Nothing does: replay protection is nullifier-based
(§10), and the statement a re-randomized proof verifies against — nullifiers, output leaves, `h_anchor` —
is unchanged by re-randomization. A re-randomized copy of an already-accepted envelope just republishes
the same nullifiers and gets rejected as a repeat, the same conclusion the competitor's own analysis
reaches for the identical reason (their §19.5).

## 5. Exit

`T_BTC_SPEND` with `out_kind = 0x01` (§3): the spent note's nullifier is published with no replacement
leaf, and its value pays out through `exit_vout` — a real output of the same transaction, read directly,
no separate destination field. Same same-transaction atomicity as `T_BTC_UNWRAP`, same signature scheme,
no separate opcode.

## 6. Recipient detection

Unmodified reuse of the pool's existing pattern: scan accepted envelopes, attempt ECDH decryption of each
`ct_note` with the viewing key, verify the recovered plaintext re-derives the published leaf. Exactly
`DESIGN-btc-note-authority.md`'s spend-authorization discipline, mirrored for detection.

## 7. Complementary, not competing: confidential CoinJoin

None of the above is needed to get *some* source-hiding shippable sooner: batch several independent
`T_CXFER` envelopes into one Bitcoin transaction (randomized input/output order), the way ordinary CoinJoin
does. Because `T_CXFER` amounts are already hidden by Bulletproofs+, this batch resists the value-
correlation attack that undermines most real-world CoinJoins needing equal-value outputs — a genuine
synergy from already having amount-hiding before adding batching. Anonymity set is bounded by batch size,
not by the whole tree, so it's strictly weaker than §2–§6 above, but it's zero new cryptography and could
run through the existing relay (`worker-relay`) today. The two are not exclusive: `T_BTC_SHIELD`/`T_BTC_SPEND`
envelopes could themselves be CoinJoin-batched for extra timing decorrelation against network-layer
observation, the one leakage surface neither design closes (§8).

## 8. What's reused vs. genuinely new

Reused unmodified: Pedersen/Bulletproofs+ amount hiding, the note-leaf shape (though not the nullifier
formula — §2 explains why the pool needed a different one than `DESIGN-btc-note-authority.md`'s), the
anchor-window idea (credited to the competitor paper, worth taking), the pool's note-encryption/scanning
pattern, `T_BTC_WRAP`'s atomic-lock trick for entry, `T_BTC_UNWRAP`'s same-tx burn for exit, SP1's
existing proving pipeline.

Genuinely new: a Bitcoin-only Merkle tree and nullifier set maintained purely by the indexer (a new state
machine, even if the same trust category as existing indexer-derived state); a fourth SP1 guest and its
own audit; wallet-side scanning wired to Bitcoin witness data instead of EVM calldata.

## Relationship to the EVM confidential pool

This pool and the EVM confidential pool are not two views of the same thing — they give different
guarantees, and deliberately don't interoperate directly. Stated here on purpose, not left for someone to
discover as a missing feature later.

**Why they're separate, not just separately implemented.** Tacit already has a way for Bitcoin-origin
value to be spent confidentially inside the EVM pool: a Bitcoin-homed note (`DESIGN-btc-note-authority.md`),
whose `auth_key` is derived from a *real* Bitcoin UTXO's scriptPubKey — reflection carries that note's
spend authority into the EVM guest precisely because the note **is** a real, spendable Bitcoin output.
This pool's `spend_key` is deliberately **not** tied to any real UTXO (§1–§2) — that decoupling is the
entire mechanism that makes source-hiding real rather than asserted. A note can be reflectable, or it can
be UTXO-decoupled; it can't be both, because reflection's own trust model requires the thing it reflects to
literally be a Bitcoin output. This is a property tradeoff, not a gap either design failed to close.

**What this means in practice.** A note shielded here can pay another note in this same pool, or exit back
to plain BTC (§5) — that's the complete set of things it can do while staying inside this pool. Getting
that value into DeFi (AMM, CDP, farms) means exiting first (public amount and destination, §9's leakage
already covers this) and re-entering through the existing, separate `T_CBTC_LOCK` → reflection →
`OP_CBTC_MINT` path. There is no silent bridge between "maximally private, Bitcoin-only" and
"DeFi-capable" — crossing between them is always a public boundary event on one side or the other. That's
the accepted cost of this pool's core property, not an oversight to fix in a later revision.

**What is shared, genuinely, not just superficially:** the cryptographic toolkit (Pedersen/Bulletproofs+,
BIP-340, keccak leaves), the note-encryption and viewing-key scanning pattern, and — via the `asset` field
(§2–§3) — the same multi-asset model the rest of the metaprotocol already uses: this pool shields any
`T_CETCH`-issued Bitcoin asset, not only raw BTC, the same way the EVM pool holds ETH, ERC-20s, and cBTC
alike. The three privacy surfaces Tacit now has — `T_CXFER` (amount-hidden, source-visible, cheap), this
pool (amount- and source-hidden, Bitcoin-only, no DeFi), and the EVM confidential pool (amount- and
source-hidden, DeFi-capable, bridge-dependent) — are a real menu of different tradeoffs, not three
attempts at the same thing.

## Fit with the rest of Tacit V1

**Nothing here touches the immutable core.** Every deployed EVM contract — `ConfidentialPool.sol`,
`CollateralEngine.sol`, the settle/reflection guests and their pinned verifying keys — stays exactly as it
is today. This design adds two new Bitcoin opcodes, a fourth SP1 guest, and new indexer/wallet state; it
does not touch, extend, or depend on anything already live. Whatever this pool's own risk turns out to be,
it's additive risk on top of the existing immutable core, not new risk introduced *into* it — the
distinction the V1 security philosophy already draws between "the immutable core protects the pot" and
everything built alongside it.

**Upgrade path, stated now rather than assumed later.** SPEC's own deployment-lineage model (§8: successor
pools, exits from a retired pool always stay open) is the right frame for this pool too, and should be
adopted explicitly rather than left to whichever future guest change forces the question. If the guest
relation ever needs to change — a bug, a better proof system, a new arity — that's a new leaf domain and a
new opcode pair, not a mutation of `0x6C`/`0x6D` or the deployed verifying key. Old notes remain provably
spendable against the old, immutable guest forever; nothing about a new pool version should ever require
touching a note that already exists.

**No new governance surface.** The anchor window (`W = 144`, `Kmin = 1`, §10) and the arity caps (§3) are
protocol constants baked into indexer/guest logic, not parameters the ops multisig or any other governed
piece can adjust — consistent with this design's whole point of needing no escrow, no economic security,
and (unlike cBTC's `CollateralEngine`) no governed knob at all.

**Claiming the opcode bytes is a real, specified step, not implicit.** SPEC §3.9 already states the
procedure: "A new opcode is claimed by updating this table together with `dapp/tacit.js`,
`worker/src/index.js` and, if it folds into the pool, `cxfer-core` and the reflection guest." `0x6A–0xFF`
is confirmed free today (SPEC §3.9); `0x6A`/`0x6B` (`T_BTC_WRAP`/`T_BTC_UNWRAP`) and `0x6C`/`0x6D`
(`T_BTC_SHIELD`/`T_BTC_SPEND`) don't collide with anything live. Updating SPEC.md's own opcode table is
part of Phase 3 (§12), not optional documentation cleanup — until it's updated there, this pool isn't
actually claimed, just proposed.

## 9. Limitations, stated plainly

- **New attack surface.** A new circuit is a new place to get soundness or circuit-correctness wrong — the
  same category of risk the competitor's own Theorem 1/2 exist to bound formally. This design needs the
  same kind of security and privacy write-up before anyone should trust it, not just a working prototype.
- **No covenant on the lock**, same as `T_BTC_WRAP`: self-inflicted footgun for the depositor alone, not a
  fund-safety risk to anyone else, closes once a covenant primitive lands.
- **Fee-wallet linkage.** If the sender always pays Bitcoin fees from the same visible wallet, that alone
  can fingerprint them regardless of how well the note layer hides everything else — the competitor's own
  §20.5 admits the identical limitation. Not solved here either.
- **Engineering lift is real.** This is not a documentation change; it's a new guest, new indexer state,
  and new wallet code, on the scale of the existing settle/reflection guests, not a small patch.

## 10. Replay and acceptance order

Same discipline as the rest of Tacit's Bitcoin metaprotocol (the `validateOutpoint` recursive-ancestry
pattern already in `dapp/tacit.js`). For a
candidate envelope in block `H`, an indexer mutates its Bitcoin-only tree and nullifier set only after, in
order, **processing candidate envelopes within a block in that block's own canonical transaction-index
order** (the order Bitcoin itself records them in — deterministic, no separate tie-break rule needed): (1)
canonical parse — fixed widths, counts match `n_in`/`n_out`, no trailing bytes; (2) for
`T_BTC_SHIELD`, `lock_vout` names a real output of this same transaction, is a recognized self-custody
lock script, and `opening_proof` verifies `C` against that output's value; (2a) for `T_BTC_SPEND` with
`out_kind = 0x01` (exit), `exit_vout` names a real output of this same transaction, and **that output's
actual value must equal the envelope's `exit_value` exactly, and its actual scriptPubKey must hash to
`dest_spk_hash` exactly** — the same class of check as (2), and just as load-bearing: nothing about the
proof itself constrains either against real chain data, because the guest has no visibility into the
carrying transaction's other outputs (it only sees the note witness and the anchor root). Without both
halves of this check, a prover could claim any `exit_value` (silent value destruction if claimed-high,
free extraction if claimed-low), and separately, a valid signed envelope and proof could be
lifted whole and rebroadcast inside a *different* carrier transaction whose `exit_vout` pays the right
amount to an attacker's own script instead of the intended destination. Value-only binding closes the
first problem but leaves the second wide open; checking the script hash too closes both, because
`dest_spk_hash` is itself covered by `h_body` (§3), so it's signed exactly like every other field, and step
2a confirms the real transaction actually honors what was signed. `h_body` and step 2a are doing two
different jobs, not one: `h_body` proves the envelope wasn't tampered with after signing; step 2a proves
the envelope's claims about real chain data are true. Neither alone is sufficient. (3) for `T_BTC_SPEND`, every `nf` is absent from the replayed nullifier set and
pairwise distinct within the envelope; (4) `h_anchor` falls inside the valid-root window (below) and the
indexer derives the corresponding root from its own replayed history; (5) the proof verifies against that
root, and the guest's committed statement matches the published envelope field-by-field (nullifiers, every
output's contents for a pay, `exit_vout`/`dest_spk_hash` for an exit); (6) only then:
append new leaves (pay) or none (exit), insert nullifiers, and — after the whole block has been replayed,
not per-envelope — record the block-level root. A rejected envelope mutates nothing.

Two indexers replaying the same active chain with the same rules converge to the same state; a reorg
invalidates roots for the replaced heights and anything after them, and any spend anchored there must be
rebuilt against the new active chain before it can be accepted — the same reorg handling the competitor's
own §15 specifies, adopted directly because it's correct. **Exit-specific case:** if a block containing an accepted exit is reorged out, the nullifier it
published rolls back along with the rest of that block's state mutation (§8's `Definition 2`-style
atomicity: nothing about acceptance is partial, and neither is its rollback) — the spent note becomes
spendable again on the new active chain, exactly as if the exit had never been accepted. There is no leaf
to reinsert (an exit creates none), so "rebuild" here means the wallet resubmits a fresh exit envelope
against the new chain, not that anything needs repairing. If the underlying carrier transaction itself
reorgs into a different block but keeps the same `exit_vout` value and script, replay simply reprocesses
it at its new height; if it vanishes from the active chain entirely, it was never accepted there and this
case doesn't arise.

**Anchor window:** `W = 144` blocks (~1 day — more generous than the competitor's 100-block/~16h choice,
because SP1 proving can run longer than a circom-native prove), `Kmin = 1` (smallest depth at which a root
is already defined when the anchor block is replayed).

## 11. Security goals

Stated as goals here, not proved — a full write-up in the style of the competitor's own Theorem 1/2 is
Phase 1 of §12, a prerequisite for code, not an afterthought.

- **No double-spend.** A nullifier already in the replayed set, or repeated within one envelope, is
  rejected — same nullifier-set mechanism already live for Bitcoin-homed notes, unmodified.
- **Value conservation.** The proof enforces `Σ v_in = Σ v_out` over range-checked canonical amounts; no
  transfer with unbalanced or out-of-range values can produce an accepting proof.
- **Spend authorization.** An accepting proof requires a valid BIP-340 signature under the spent note's
  `spend_key`, bound into the leaf at shield time. Forging a spend means breaking BIP-340 or SP1/Groth16
  soundness — not something an indexer, relay, or the fee-paying wallet can do on its own.
- **Replay agreement.** One canonical parser, one acceptance order, no implementation-defined behavior —
  any two correct indexers replaying the same active chain derive the same tree and nullifier set.
- **Transcript privacy (informal, needs a real leakage function before launch).** Once accepted, the only
  public data are nullifiers (unlinkable to the spent leaf without the witness), fresh commitments, and
  encrypted ciphertexts. Arity, timing, `h_anchor` age, and fee-transaction metadata stay public — the
  same leakage class the competitor's own `Leak()` function names, not something this design avoids
  either.

## 12. Path to mainnet

This is new cryptography touching real BTC custody, so it follows the same bar every other Tacit mainnet
component has cleared, not a shortcut past it — the immutable-core-first-time philosophy already applied
elsewhere in this codebase (`SPEC.md`'s own launch history) applies here too.

1. **Formal write-up.** Turn §10/§11 into an actual security and privacy analysis at the rigor level of
   `SPEC.md` itself — assumptions, goals, and a leakage function, reviewed before any code is written.
   Draft: [`DESIGN-btc-shielded-pool-security.md`](./DESIGN-btc-shielded-pool-security.md).
2. **Guest implementation.** The SP1 Rust program for the relation in §4, with test vectors, ELF-hash
   pinning, and reproducible builds — same process as the existing three guests
   (`docs/REPRODUCIBLE-BUILDS.md`).
3. **Indexer and wallet wiring.** The Bitcoin-only tree/nullifier state machine in the worker/indexer, and
   shield/spend construction plus note scanning in the dapp — including formally claiming `0x6C`/`0x6D` by
   updating SPEC §3.9's opcode table itself, per its own stated procedure ("Fit with the rest of Tacit
   V1" above), not just shipping code against unclaimed bytes.
4. **Signet/testnet dry run.** Real locks, real spends, and adversarial testing — double-spend attempts,
   malformed envelopes, reorg handling — before any real value touches it.
5. **Independent security review**, same bar as the Pashov and Astra rounds every other mainnet component
   went through, before real BTC is at risk. Not optional: the lock has no covenant yet (§9), and this is
   new proof-system surface, so it gets the same scrutiny as everything else that's ever gone live here.
6. **Mainnet, value-capped initially**, scaling up as the design accrues live usage without incident — the
   same posture Tacit already takes with new surfaces (e.g. cBTC's escrow ratio, OP_BID's guest-verified
   but UI-less rollout).

## Resolved for v1

- **Arity:** 2-in/2-out, covers pay-with-change and simple consolidation. Larger arities are a later
  extension, not a blocker.
- **`spend_key` disclosure:** publishing it in plaintext is fine *given* the one-time stealth derivation in
  §2 is mandatory, not optional — that mandatory derivation is what closes the reuse problem publishing it
  in plaintext would otherwise open.
- **Within-block ordering** for conflicting envelopes: canonical transaction-index order (§10), combined
  with the existing nullifier-absence check — no separate tie-break rule needed.

## Still open

- Whether a future multi-asset version needs per-asset anchor windows or one shared tree suffices.
- Exact wording of the leakage function (`DESIGN-btc-shielded-pool-security.md` §4) before Phase 1 closes.
- Exact `proof` byte width — fixed once the guest is compiled (Phase 2), not before.
