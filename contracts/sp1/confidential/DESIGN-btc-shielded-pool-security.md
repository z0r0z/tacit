# Security and privacy analysis: Bitcoin-native shielded pool

Status: DESIGN, companion to `DESIGN-btc-shielded-pool.md` (the design), which defines the keys, notes,
opcodes, relation and replay analyzed here. Section references of the form "design §N" point there.

Each security goal is stated as an experiment with a named advantage term and reduced to the assumptions
in §1. The reductions are worked by hand and are the object of the external review listed in §7.

## 0. Scope and custody boundary

The pool conserves Tacit asset value. It does not create, hold or release BTC. Value enters only by
spending transparent Tacit notes that already exist and leaves only as new transparent notes of the same
asset, so the pool's backing is whatever already backs the asset. BTC exposure inside the pool is exposure
to cBTC and inherits cBTC's model exactly (SPEC §5.7): the lock is self-custodied, and its enforcement is
economic, not a Bitcoin script constraint.

A transferable note that anyone holding it can trustlessly redeem for locked sats is not achievable on
today's Bitcoin. Without a covenant, the lock's key holder can always spend the lock outside the protocol,
and without a bridge nothing else can pay the holder. This design does not claim that property. What it
claims is privacy for value that already exists: hidden amounts, sources and counterparties, with exact
conservation across the boundary.

## 1. Assumptions

**A1. Ledger.** Confirmed Bitcoin history is a common prefix among honest nodes except with negligible
probability, at a depth the indexer and wallet choose. Shallower reorgs are handled by the undo log
(design §5), not assumed away. The indexer reads blocks from a data source and validates the header chain
itself, by proof of work from a pinned checkpoint, following the most-work chain. A source can withhold
headers but cannot fabricate a chain without doing its proof of work.

**A2. Data availability.** Every accepted envelope's bytes, and the transactions its rules read (shield
inputs and their transparent ancestry, exit outputs), are retrievable from confirmed Bitcoin data. Each
block, and each ancestor transaction a rule reads, is checked against its header's merkle root and
coinbase witness commitment, so a source can withhold data but cannot substitute it. Missing data, a block
or an ancestor, is unavailability: the indexer halts and retries, and never rejects an envelope because
data is missing. A2 is therefore a liveness assumption: its failure stops an indexer and never changes
its result.

**A3. Proof system.** SP1 with its Groth16 wrap is knowledge-sound for the relation `R` of design §4,
with advantage `Adv^ks_R`: from any prover that outputs an accepting proof for public values `x`, an
extractor recovers a witness `w` with `R(x, w) = 1`. It is zero-knowledge, with advantage `Adv^zk_R`: a
simulator `Sim(x)` produces proofs indistinguishable from real ones. Non-malleability of proof bytes is
not assumed. Groth16 proofs can be re-randomized, and nothing here treats a proof's bytes as an identity.

**A4. Hash.** `keccak` is collision-resistant (`Adv^cr`). The privacy and nullifier-secrecy arguments
model `keccak`, including the scalar hash `Hs`, as a random oracle, with `q_H` the adversary's oracle
queries. `SHA-256`, used in the shield kernel message and `dest_spk_hash`, is collision-resistant.

**A5. secp256k1.**
- **A5a.** Discrete log is hard (`Adv^dl`).
- **A5b.** BIP-340 is existentially unforgeable under chosen-message attack, including for keys with a
  known additive tweak `A + t·G`, the same related-key setting BIP-341 key tweaks rely on
  (`Adv^euf`). Schnorr signatures are also proofs of knowledge of the signing key, extractable in the
  random-oracle model by forking.
- **A5c.** Decisional Diffie–Hellman is hard (`Adv^ddh`). This makes the stealth secret `s = e·V`
  pseudorandom to anyone without `e` or `v`.

**A6. Pedersen commitments.** `C = v·H + r·G`, with `H` from SPEC §2.1 and `log_G H` unknown, is
perfectly hiding and computationally binding. A second opening yields `log_G H`, so
`Adv^bind ≤ Adv^dl`.

**A7. Canonical implementation.** Every correct indexer uses the same parser, acceptance order (block,
transaction, then input), leaf and nullifier derivation, anchor window, carrier-binding check, root
retention, undo log, verifier and pinned key. Shield inputs are validated by Tacit's canonical transparent
validator (`validateOutpoint`), and every transparent validator applies the same seam rule for outputs of
`T_BTC_SPEND` carriers (design §5). No acceptance rule is implementation-defined.

**A8. Wallet freshness.** Honest wallets sample or derive `e` (and so `pk_eph`, `s`, the tweaks and `k`)
and the blinding `r` for every note so that each is uniform to anyone without the wallet's secrets, and
never reuse them. A derived value is a keyed hash of wallet secrets and a per-spend unique input (design
§3), which the random-oracle model makes uniform. BIP-340 signing nonces follow BIP-340. This is a
precondition on honest behavior, not a computational term.

**A9. Hosted acceptance records.** The acceptance records for `T_CROSSOUT_MINT` and AMM swaps that the Tacit
worker serves to `validateOutpoint` are correct. A9 is used only for shields whose inputs' ancestry
includes a `T_CROSSOUT_MINT` or AMM output, and applies until cross-out mints are proof-verified (design
§9) and the indexer tracks AMM state itself.

**A10. Wallet's replay source.** A wallet reads pool state (roots, paths, nullifier status, exit records)
from its own replay or from an indexer it trusts. The hosted replay service is one such indexer, not an
assumption of the protocol.

## 2. Goals

- **G1. Replay agreement.** Two correct indexers that process the same confirmed prefix derive the same
  leaves, nullifier set, root history and recorded exits.
- **G2. Double-spend resistance.** Each appended note has exactly one position and exactly one
  nullifier, and no nullifier is accepted twice, including across envelopes in one transaction.
- **G3. Conservation.** Shields and spends (pay, exit, or both) neither create nor destroy value of any
  asset, and every value that any party can later open is a `u64`. For an asset whose shielded notes
  descend from `T_CROSSOUT_MINT` or AMM outputs, G3 also rests on A9.
- **G4. Spend authorization.** A note is consumed only by a body its owner signed, including when the
  adversary is the note's sender or holds a delegated witness.
- **G5. Body binding.** A proof accepted for one body cannot be accepted for any other body, and a signed
  body cannot be redirected by whoever carries it.
- **G6. Transcript privacy.** Two histories that agree on the leakage function (§4) produce
  indistinguishable envelopes and replayed state.
- **G7. Recovery completeness.** A wallet holding its seed finds every note paid to its addresses and every
  exit it made, with openings, from chain data, and accepts no note it cannot spend.
- **G8. Delegated-party safety.** A prover given the full witness for one spend, or a relayer or maker given
  the finished payload, cannot redirect funds, cannot spend the owner's other notes and cannot link them. A
  payload bound to a relayer's UTXO can be posted by that relayer alone. A payload with a want is accepted
  only in a carrier that pays the want, so no one takes its exit without paying for it.
- **G9. Batch independence.** Envelopes sharing a carrier are accepted or rejected independently, and
  batching weakens none of G1–G5.

## 3. Proofs

### 3.0 Setup

`Replay(C)` is the deterministic function of design §5 over a confirmed prefix `C` and, for shield
inputs with `T_CROSSOUT_MINT` or AMM ancestry, the A9 records. The adversary `A` is
PPT. It assembles prefixes and interacts with an honest-party oracle `O` that, on request, creates honest
addresses; shields, pays or exits honestly on their behalf; signs a body for an honest note; hands `A` a
delegated witness for a named spend; or hands `A`, as relayer, a finished payload that pays `A` a fee. `A` may also act as the sender of any note, in which case it
learns `(e, s, t_a, t_n, k, v_amt, r)` for that note but not the recipient's `v`, `a` or `n`. Advantage is
`Pr[win]` for a bad-event game and `|Pr[b' = b] − 1/2|` for a distinguishing game.

### 3.1 G1: Replay agreement

**Claim.** `Adv^repl = 0` under A7, for indexers that read the same A9 records.

**Proof.** Design §5 processes envelopes in block, transaction and input order. Each check (parse, shield
input validation and kernel, anchor window, carrier binding, nullifier freshness, exit output claim and
hash, proof verification) is a predicate of `C`, the state so far and, for shield inputs of cross-out or
AMM ancestry, the A9 records. A failing envelope changes nothing. The state so far includes the effects
of earlier envelopes in the same transaction, which is the only coupling between envelopes (§3.9). Shield
inputs are decided by the one canonical transparent validator. Proof verification is local against a
pinned key and makes no network call. The anchor
window depends only on the envelope's block height `H`, not on a node's view of the tip. An indexer
missing data halts rather than deciding (A2), so incomplete data delays it and never diverts it. After a
reorg, the undo log restores the state at the fork point, and replaying the new branch yields `Replay` of
the new prefix. Two implementations of one total function agree on every input, so any disagreement is a
violation of A7 and not a cryptographic event. ∎

### 3.2 G2: Double-spend resistance

**Lemma 1 (one nullifier key per leaf).** For a fixed `nk_pub`, at most one 32-byte string `nk` satisfies
`0 < nk < n` and `compress(nk·G) = nk_pub`.

*Proof.* On `[1, n−1]`, `nk ↦ nk·G` is a bijection onto the non-identity points, and `compress` is
injective on those points because the 33-byte encoding fixes both `x` and the parity of `y`. The
canonical big-endian encoding with the range check gives each scalar exactly one byte string. ∎

The two aliasing routes that break x-only constructions are therefore closed:

- **`d` vs `n − d`.** `(n−d)·G = −(d·G)` has the same `x` and the opposite parity, so its compression
  differs in the prefix byte (`02` vs `03`). The leaf commits the full point, parity included, so only
  one of the two matches.
- **`d` vs `d + n`.** The same point, but `d + n ≥ n` fails the range check. A 32-byte encoding of a
  value at or above `n` is rejected rather than reduced.

**Lemma 2 (one position per leaf).** For an appended leaf at position `p`, exactly one `leaf_index`
passes relation step 2, namely `p`.

*Proof.* The tree has depth 32, so a membership path reads only the low 32 bits of the index: an index
`p + k·2^32` authenticates the same leaf along the same path. Relation step 2 requires
`leaf_index < 2^32`, which leaves each position one index. An index `q ≠ p` below `2^32` passes only if
the same leaf bytes sit at `q`, which makes it a spend of the note at `q`, not of the note at `p`;
otherwise passing is a keccak collision (A4). ∎

Without the range check, `p + 2^32` would satisfy membership and hash to a different nullifier, giving the
note a second nullifier. The range check is part of nullifier uniqueness, not an encoding detail.

By Lemmas 1 and 2, `nf = keccak("tacit-btc-pool-nf-v1" ‖ leaf ‖ nk_note ‖ leaf_index)` is a function of
the appended note alone, meaning its bytes and its position, whoever proves the spend. The signing key does
not enter the nullifier, so its x-only ambiguity (BIP-340 negates `sk_spend` internally when `P` has odd
`y`) cannot create a second nullifier.

**Experiment.** `A` wins if `Replay(C)` accepts two spends that consume the same appended note, or one
spend that lists a nullifier twice.

**Claim.** `Adv^ds ≤ Adv^ks_R + Adv^cr`.

**Proof.** A repeat within one envelope violates relation step 3 and acceptance step 3. Across envelopes,
the nullifier set rejects any nullifier already present. This includes envelopes in the same transaction:
they are processed one at a time in input order, and an accepted envelope's nullifiers are in the set
before the next envelope is checked. Two accepted spends of one note must therefore publish different
nullifiers. Extracting both witnesses (A3) yields either two valid nullifier keys for one `nk_pub`, which
Lemma 1 rules out, or two indices for one position, which Lemma 2 rules out up to `Adv^cr`, or a nullifier
not computed as specified, which is a knowledge-soundness failure. ∎

**Identical leaves.** Every leaf is fully funded when appended: a shield by its kernel inputs, a pay by
conservation. Two byte-identical leaves at different positions are two notes and carry different
nullifiers, so both are spendable and neither destroys the other's value.

**Nullifier squatting.** Publishing an honest note's nullifier ahead of its owner requires either
computing it (querying the oracle on `nk_note`, which is `log_G nk_pub`, so `≤ q_H·Adv^dl` under the
random-oracle model) or an accepted spend of a different leaf whose nullifier collides with it
(`Adv^cr`).

### 3.3 G3: Conservation

Define, per asset, supply as the sum of the values of unspent transparent notes plus the sum of the values
of unspent pool leaves. G3 says every accepted envelope leaves supply unchanged and every note it creates
opens to a `u64` (or, for the shield case below, is provably unspendable if it cannot). Batching does not
change this: supply is additive over envelopes, and each accepted envelope is checked on its own (§3.9).

**Shield.** The kernel is the `T_CXFER` kernel (SPEC §2.4) with the pool note as its only output. Let
`E = C_pool − ΣC_in`. A valid `kernel_sig` under `x(E)` is, under A5b and forking in the random-oracle
model, a proof that the signer knows `x` with `±E = x·G`. Write `C_pool = w·H + ρ·G` for any opening the
signer or a later spender uses. Then

```
(w − Σ v_in)·H = ±x·G + (Σ r_in − ρ)·G
```

so `w ≠ Σ v_in (mod n)` yields `log_G H`. Hence `Adv^cons_shield ≤ Adv^ext_kernel + Adv^dl`, where
`Adv^ext_kernel` is the forking extractor's failure probability, as for every `T_CXFER` today.

Values stay range-valid without a range proof on `C_pool`. Each input is a valid transparent note of
`asset` as the canonical `validateOutpoint` decides it, over full ancestry (acceptance step 2), and every
valid transparent note has a value in `[0, 2^64)` (SPEC §2.2–§2.3):
by its creating op's range proof or public amount, or, for a note created by an exit, by relation step 4's
`u64` opening. With `n_in ≤ 8`, `Σ v_in < 2^67 < n`, so the H-component is the exact integer sum with no wrap. If
the sum reaches `2^64`, no `u64` opens `C_pool` (A6), so the leaf can never satisfy relation step 2 and is
unspendable. Its `ct_note` also cannot carry the amount, so no wallet receives it (§3.7). That outcome is
self-inflicted by the shielder, removes value rather than creating it, and is refused by the canonical
wallet.

The shield's inputs are Bitcoin-spent by the carrier, so the transparent layer cannot spend them again.
The kernel binds each `txid:vout` and every field of the new note, so the signature cannot be moved to
another carrier or another note.

**Spend.** A pay, a full exit and a partial exit are one equation. Relation step 2 opens each input `C_i`
to a `u64 v_i`. Step 4 opens each output commitment and, if `has_exit = 1`, the exit commitment to a
`u64`. Step 5 requires `Σ v_in = Σ v_out + v_exit` over `u128`, with `v_exit = 0` when there is no exit.
With `n_in ≤ 2` and `n_out ≤ 3`, both sides stay below `2^66`, so neither wraps. The input leaves are
fixed by membership in `root`, so their commitments are the ones created on-chain. An accepted spend that
breaks conservation either lacks a satisfying witness (`Adv^ks_R`) or opens a committed value two ways
(`Adv^bind`). So `Adv^cons_spend ≤ Adv^ks_R + Adv^dl`.

The exit's `u64` opening is what makes the resulting transparent note range-valid for the transparent
layer and for a later shield of it. A relayer's fee is an ordinary output, inside the same equation, so
relaying adds no value term. The parse rule `n_out + has_exit ≥ 1` excludes a spend that creates nothing.

**Asset separation.** Every input leaf and every output leaf is computed with the body's `asset`, and the
exit records `(asset, Cx, Cy)`. The shield requires every input to be of `asset` and signs `asset` into the
kernel. No envelope can move value between assets.

**Seam.** An exit's transparent note exists exactly when the pool's replay recorded it, and transparent
validators consult that record for outputs of `T_BTC_SPEND` carriers whose `vin[0]` holds no transparent
op, whichever inputs carry the spends (A7). An output of such a carrier that the pool did not record is
not a Tacit note. The seam rule is load-bearing: a transparent validator
that treated those outputs as ordinary notes without the record would admit unrecorded value.

**Output claims.** Within one transaction each carrier output is claimed by at most one accepted exit or
want. Without that rule two exits in one carrier could record two notes at one outpoint. Bitcoin spends an
outpoint once, so one record's value would be unspendable and the seam would have no single answer for
that outpoint. With it, each recorded exit note has its own outpoint. A want moves no pool value, so G3
does not rest on it; its claim keeps one payment from satisfying two wants (§3.8).

**Hosted records.** A shield input's validity is decided over its full ancestry. Where that ancestry
includes a `T_CROSSOUT_MINT` or AMM output, the validator uses the A9 records for those ops, and
conservation for value of that ancestry holds under A9. Every other ancestry is decided from Bitcoin data.

**Bound notes.** A note bound to a pool deployment (`T_CXFER_BOUND`) is also spendable in that
deployment's fast lane until reflection retires it (SPEC §6.3). Shield acceptance refuses bound notes as
inputs (design §5), so a bound note never enters the pool.

Every term is negligible, so `Adv^cons ≤ Adv^ext_kernel + Adv^ks_R + 2·Adv^dl`, under A9 for value of
cross-out or AMM ancestry.

### 3.4 G4: Spend authorization

**Experiment.** `O` creates a target note `nt` for an honest address. `A` may act as its sender, may
request signatures from `O` on any body for any honest note, and may request delegated witnesses, which
include signatures. `A` wins if `Replay(C)` accepts a spend of `nt` whose body `O` never signed for `nt`.

**Claim.** `Adv^auth ≤ Adv^ks_R + Adv^euf + Adv^cr`.

**Proof.** Extract the witness of the winning spend (A3). It contains a BIP-340 signature valid under
`nt`'s `spend_key` `P = A + t_a·G` on `msg = keccak("tacit-btc-pool-spend-v1" ‖ body)`. If `O` signed a
different body with the same `msg`, that is a keccak collision. Otherwise the signature is a forgery
under a known-tweak key of the honest `A`: a sender knows `t_a` but not `a`, and a delegated prover holds
signatures only on the bodies `O` chose (A5b). The fresh `P` per note (A8) means a signature for one note
is not a signature for another. ∎

The nullifier key is a second, independent secret. A signature without `nk_note` cannot produce the
nullifier, and `nk_note` without a signature on the new body does not satisfy relation step 2.

### 3.5 G5: Body binding

The public values are `(version, root, keccak(body))`, and the indexer recomputes the last two from the
envelope bytes and its own root history. `body` is every byte before `proof_len`, so it covers `asset`,
`h_anchor` (and through it `root`), `bind`, every nullifier, `n_out`, every output field (`pk_eph` and `ct_note`
included, and so any relayer fee output), `has_exit`, for an exit `exit_vout`, its commitment and
`dest_spk_hash`, `has_want`, and for a want its `vout`, `value` and `spk_hash`.

**Claim.** A proof accepted for a body `b' ≠ b` that `O` did not sign is bounded by `Adv^auth`.

**Proof.** Binding does not depend on proof non-malleability. Suppose `A` turns a proof for `b` into an
accepting proof for `b'`. Knowledge soundness extracts a witness for `b'`, which contains signatures by
every input's `spend_key` over `b'`. For an honest input that is a G4 forgery. Changing a field that no
input owner signed is therefore impossible, whether the field is an output, a ciphertext or the anchor. ∎

**Carriage.** With `bind` non-zero, a carrier is accepted only if it spends the bound outpoint, so only
the holder of that UTXO can carry the payload, at any input of a batched carrier. With `bind` zero, anyone
may place a signed body and its proof in a different carrier; the effect is identical (the same
nullifiers and leaves), and the owner's own carrier then fails the freshness check. An exit binds its destination through `exit_vout` and
`dest_spk_hash`. A re-carried exit must place, at `exit_vout`, an output whose scriptPubKey hashes to that
value, so the new transparent note is controlled by the owner's script at the carrier's expense. Because
`h_anchor` is signed, a signed body expires once its anchor leaves the 144-block window. Relaying is this
case with the owner's consent (§3.8). A want binds its carrier the same way: a re-carried body is accepted
only where the output at `vout` pays at least `value` to the owner's `spk_hash`.

The shield has the same property through its kernel. The kernel message covers every field of the pool
note, so no relayer can swap `pk_eph`, `ct_note`, `spend_key` or `nk_pub` and keep the signature.

### 3.6 G6: Transcript privacy

**Experiment.** `A` chooses two histories `h_0`, `h_1` of honest shields, pays and exits that have equal
leakage `L(h_0) = L(h_1)` (§4). The notes in both histories are between honest addresses whose `v` and `n`
`A` does not hold, and none of them is delegated to `A` for proving. `A` may relay any of the spends; the
fee outputs then paid to `A` are `A`'s own notes and are part of `L`. The challenger runs `h_b` under A8,
and `A` sees every envelope, the replayed state and the oracle, and outputs `b'`. `A` may run any other
activity of its own alongside.

Let `q_s` be the spends and `q_n` the notes created in the challenge history, excluding fee notes paid to
`A`. A relayed payload reaches `A` before broadcast, but it is the same bytes that go on chain, so it adds
nothing to the view beyond its arrival time and origin, which are network-layer and outside `L`.

- **Game 0.** The real experiment.
- **Game 1.** Replace each proof by `Sim(x)`. The spend signatures, openings, paths and nullifier keys
  appear only in the witness, so they vanish from the view. Loss: `q_s·Adv^zk_R`.
- **Game 2.** For each note, replace `s = compress(e·V)` with the compression of an independent uniform
  point. `(G, V, E, s)` is a DDH tuple, and `E = e·G` stays published. Loss: `q_n·Adv^ddh`.
- **Game 3.** Replace `t_a`, `t_n` and `k` with independent uniform values. `s` is now uniform and never
  queried by `A` except with probability `q_H·q_n/2^255`, and the three domain tags separate the queries.
  Then `P = A + t_a·G` and `NK = N + t_n·G` are uniform points independent of the address, so
  `spend_key` and `nk_pub` are uniform. The keystream and tag are uniform, so `ct_note` is uniform. Loss:
  `O(q_H·q_n/2^255)`.
- **Game 4.** `r` is fresh and uniform (A8), and after Game 3 its only other appearance, `ct_note`, is
  independent of it. So `(Cx, Cy)` is a uniform point independent of `v_amt` (A6, perfect hiding). At a
  shield, `E = C_pool − ΣC_in` is then uniform, and `kernel_sig` is simulated by programming the oracle
  (Schnorr HVZK). Loss: `O(q_H·q_n/2^256)`.
- **Game 5.** Replace each published nullifier with a uniform 256-bit string. After Game 3,
  `nk_note = n + t_n` is uniform and independent of everything else in the view except
  `nk_pub = nk_note·G`. `A` distinguishes only by querying the oracle at `nk_note`, which is computing a
  discrete log. Loss: `q_s·Adv^dl` (random-oracle model).

Game 5 depends on `b` only through `L`. Proofs are simulated from `(version, root, keccak(body))`, and
every nullifier, commitment, `spend_key`, `nk_pub`, `pk_eph`, `ct_note` and kernel signature is
independently uniform. Which leaf a spend consumed, the amounts and the parties do not appear. Therefore

```
Adv^priv ≤ q_s·Adv^zk_R + q_n·Adv^ddh + q_s·Adv^dl + O(q_H·(q_n + q_s)/2^255).
```

A8 is a precondition on admissible histories, not a term. A reused `e` repeats `pk_eph` and the tweaks,
and a reused `r` makes `ct_note` and the commitment correlate, either of which `A` detects by inspection.

### 3.7 G7: Recovery completeness

**Completeness.** The recipient computes `compress(v·E) = compress(v·e·G) = compress(e·V) = s`, so it
derives the same `t_a`, `t_n` and `k` as the sender, decrypts `ct_note`, checks the opening against
`(Cx, Cy)`, and recomputes `spend_key` and `nk_pub` from `(A, N)`. An honest note paid to it passes all of
these with probability 1. Because every output field is signed (G5), no relayer can make an honest
payment undeliverable.

**Soundness.** A note that passes receipt is spendable. The wallet knows `sk_spend = a + t_a`, whose key is
`spend_key`, and `nk_note = n + t_n` with `compress(nk_note·G) = nk_pub` (range-checked as in Lemma 1),
along with a `u64` opening of the committed amount. With the leaf's path from replay, that is a full
witness. A note meant for another address passes only if its tag verifies under this wallet's `k` and
its keys match this wallet's tweaks, which happens with probability `O(q_H/2^128)` from the 16-byte tag.
A sender who seals a wrong amount or a malformed key makes only its own payment undeliverable.

**Exits.** A wallet finds its own spends by the nullifiers of its notes. The exit blinding is
`r_exit = Hs("tacit-btc-pool-exit-v1" ‖ nk_note_0 ‖ body with the exit commitment zeroed)`, and each
output's `e` is derived from `nk_note_0`, `nf_0`, the output index and the output's commitment (design §3), so `r_exit` and the wallet's own outputs are
recomputable from the seed. With every input value and output value of the spend known, `v_exit` is their
difference, checked against the exit commitment. Exit scripts come from the seed by a counter (design §6),
so the wallet also finds the exit outputs by script.

**Viewing tiers.** Change and padding are paid to the internal address `(V_int, A, N)` (design §2).

| Keys | Sees | Cannot |
|---|---|---|
| `v` | Incoming notes to the external address and their amounts | See change, see what was spent or sent, spend |
| `(v, v_int)` | Also change and padding, so the amount each spend sent out | See which notes are spent, spend |
| `(v, v_int, n)` | Everything above, every nullifier, the balance net of spends | Spend |
| `(v, v_int, a, n)` | Everything | — |

### 3.8 G8: Delegated-party safety

**Delegated prover.** A delegated prover receives the witness for one spend: the body, each input's opening, leaf, path,
`nk_note` and signature, and each output's opening. It does not receive `v`, `a`, `n`, `s` or the tweaks.

- **No redirection.** It holds signatures on one body only. Any other accepted spend of those inputs is a
  G4 forgery, and any change to the body invalidates the proof it was given (G5). It can submit the body
  as signed, which is what the owner asked for, or withhold it. Withholding is a liveness failure only,
  since the owner can sign and prove elsewhere, and the signed body lapses when its anchor ages out.
- **No spending of other notes.** Each other note has its own `P`, whose discrete log is `a + t_a'` with
  `t_a'` pseudorandom (A5c, A4). The prover's signatures are under different keys, so spending another
  note needs a forgery (A5b).
- **No linking.** `nk_note = n + t_n` is `n` masked by a pseudorandom `t_n` that the prover does not know,
  and each note's mask is independent. Knowing `nk_note` for delegated notes reveals nothing about `n` or
  about any other note's `t_n'`. Deciding whether another leaf belongs to the same address requires
  distinguishing its `(spend_key, nk_pub, pk_eph)` from uniform given `(V, A, N)`. That is Game 2–3 of §3.6
  with the delegated notes' secrets as extra, independent information, so the advantage is bounded by
  `q_n·Adv^ddh + O(q_H·q_n/2^255)`. Signatures under `P` reveal nothing about `a` beyond `P` (Schnorr
  zero-knowledge in the random-oracle model).
- **What it does learn.** It learns everything about the spend it proves: which leaves are consumed, their
  amounts, the output openings and the nullifiers. That spend is not private from the prover, and a
  wallet that needs it to be proves locally.

**Relayer.** A relayer (design §6) receives the finished payload, `body ‖ proof_len ‖ proof`, after the
sender has signed and proved. It is strictly weaker than a delegated prover: its view is a function of the
prover's view with the witness removed, plus the payload's arrival time and network origin. Every bound
above therefore holds for it, and on chain data alone its linking advantage is the chain observer's
(§3.6).

- **No redirection.** The body is signed, so the relayer cannot change any output, the fee output
  included, nor move an exit (G5). For a relayed exit it assigns `exit_vout` before the sender signs, and
  it builds the carrier, but the exit is accepted only if that output's scriptPubKey hashes to the signed
  `dest_spk_hash`. It can pay the sender's script or make the exit fail, nothing else.
- **No spending.** It never sees `sk_spend`, `nk_note` or any opening.
- **What it does learn.** Its own fee note, which it receives like any payment; the payload's arrival
  time and network origin; and, for an exit, which origin owns which exit script. The sender needs no
  Bitcoin wallet, so no fee-paying input of the sender's appears on chain. Submission over an anonymizing
  transport removes the origin.
- **What it marks.** A relayer's envelope key and change script recur across its carriers, so chain
  observers see which relayer carried a spend. Relayer choice partitions the anonymity set by relayer.
- **What it can do.** Withhold, delay, or choose the batch. The owner can submit elsewhere with a new
  body, and the old body lapses when its anchor leaves the window or when its bound UTXO is spent.
- **Relayer's own safety.** Before paying the Bitcoin fee it checks locally that the proof verifies
  against its own replayed root, that the nullifiers are unspent, that `bind` is its quoted UTXO, and that
  an output is received under its viewing key (design §2) for at least its quoted fee. An envelope that
  passes these and is then accepted pays the relayer. `bind` means no one else can post the payload first.
  Its remaining exposure is a conflicting spend of the same nullifiers, in another body, confirming first,
  which costs it that carrier's fee share (§6). The relayer duties of design §6 bound it.

**Maker (exit to sats, design §9).** A maker receives the finished payload of a spend that exits `amount` to
the maker's script at `exit_vout` and wants `sats` at `vout` to the owner's script, plus the exit's opening.

- **No exit without payment.** Suppose a carrier `T` accepted by `Replay` records the exit of a body `b` with
  a want `(vout, value, spk_hash)`. Acceptance (design §5 step 6) required `T.vout[vout]` to exist with
  value at least `value` and `SHA-256(scriptPubKey) = spk_hash`, and `b` is the signed body (G5): a maker
  that edits `want` in `b'` needs a signature by every input's `spend_key` over `b'`, which is a G4 forgery.
  A carrier omitting or underpaying the output, or paying another script, is rejected whole, so the
  nullifiers stay unspent and no exit is recorded. The claim rule gives each output of `T` to at most one
  accepted exit or want, so one payment cannot satisfy two wants, nor double as the exit it pays for.
  Finding a second script with the same SHA-256 is a collision (A4).
- **No redirection.** The exit's `exit_vout` and `dest_spk_hash` are signed, so the maker can pay only its
  own agreed script. The pool outputs (change, padding) are signed like any output.
- **What it does learn.** The exit's opening, which it needs to spend the resulting transparent note; the
  payout script, a fresh key of the owner's (design §6); the payload's arrival time and origin. The change
  stays under the owner's internal address.
- **Maker's own safety.** Before building the carrier it checks that the exit opens to the agreed amount at
  its script and index, that the want asks at most the agreed sats to the script it was given, that `bind`
  is the outpoint it chose (or zero), and optionally the proof against its replayed root. With `bind` zero,
  a third party may carry the payload; it then pays the owner the want and delivers the exit to the maker,
  which moves value only from that third party.

### 3.9 G9: Batching

A `T_BTC_SPEND` may ride any input of a carrier whose witness is a Tacit envelope leaf, so one Bitcoin
transaction carries many spends. `T_BTC_SHIELD` stays at `vin[0]`, since its shielded notes are
`vin[1..n_in]`. Envelopes in one transaction are processed one at a time in input order.

- **Independent acceptance.** Each envelope is accepted or rejected on its own checks against the state
  left by the envelopes before it, and a rejected envelope changes nothing. One invalid envelope does not
  invalidate the others.
- **Nullifier distinctness.** An accepted envelope's nullifiers are inserted before the next envelope is
  checked, so two envelopes in one transaction that share a nullifier cannot both be accepted: the later
  one fails freshness (§3.2).
- **Output-claim uniqueness.** Each carrier output is claimed by at most one accepted exit or want in the
  transaction (§3.3, §3.8).
- **No carrier position in the proof.** Public values are `(version, root, keccak(body))`. The carrier
  terms, `bind` and `want`, are inside `body` and name an outpoint the carrier spends at any input and an
  output index, so they do not depend on the envelope's input position or on the other envelopes. Batching changes no proof
  and no signature, and spends bound to one UTXO share a carrier.
- **Anchors.** Every spend in block `H` anchors to a root of a block at or below `H − 1`, so intra-block
  order never changes which roots an envelope may use.

**Claim.** G1–G5 hold for batched carriers with the same bounds. G1 holds because input order is part of
the canonical order (A7). G2 and G3 hold by the sequential nullifier and output-claim rules. G4 and G5
reference the carrier only through the signed `bind` and `want`. ∎

### 3.10 Local verification

Indexers verify with `sp1_verifier::Groth16Verifier` against the SP1 Groth16 key. That key is
byte-identical to the one embedded by the immutable mainnet leaf
`0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2`: `VERIFIER_HASH 0x4388a21c…ee696` and
`VK_ROOT 0x002f850e…5352`. A proof produced by the SP1 prover network for the `btc-pool-prover` guest was
accepted by both the local verifier and the mainnet leaf, and a copy with one byte changed was rejected by
both. Local acceptance is therefore the acceptance mainnet already relies on, and A3 is one assumption
shared with the settle and reflection guests, not a second one.

### 3.11 Assumption dependencies

| Goal | Reduces to |
|---|---|
| G1 replay agreement | A7 (no cryptographic term), A1 for input agreement, A2 for liveness, A9 for shield inputs of cross-out or AMM ancestry |
| G2 double-spend resistance | A3, A4; A5a for squatting |
| G3 conservation | A3, A5a, A5b (kernel extraction), A6, A7 (seam, transparent validator); A9 for assets of cross-out or AMM ancestry |
| G4 spend authorization | A3, A4, A5b, A8 |
| G5 body binding | A3, A4, A5b |
| G6 transcript privacy | A3, A4 (random oracle), A5a, A5c, A6, A8 |
| G7 recovery completeness | A4, A5c, A8, A10 |
| G8 delegated-party safety | A4 (random oracle, SHA-256 collision resistance for `spk_hash`), A5b, A5c, A8 |
| G9 batching | A7, and the goals it preserves |

## 4. Leakage function

`L(h)` of a history is exactly the design §7 table's public column, stated precisely:

- **Bitcoin metadata.** Block height, transaction order and fee of each carrier, and which envelopes share
  a carrier at which inputs.
- **Fee-paying inputs, when self-broadcast.** A sender who broadcasts its own carrier exposes its fee
  inputs and any clustering they carry. A relayed carrier's inputs are the relayer's and say nothing about
  the sender.
- **Shape.** The opcode, `n_in`, `n_out`, `has_exit`, `has_want`, whether `bind` is set, the envelope size, and the
  positions of appended leaves. Under the wallet defaults every pay has 3 outputs with zero-value padding,
  and 2 inputs when the wallet holds a second note of the asset, else 1. A wallet's first spend after a
  shield is therefore 1-in.
- **Anchor age.** `H − h_anchor` for each spend. Under the shared anchor policy (`tip − 6`, rounded down to
  a multiple of 6), the age reveals only the proving-to-confirmation delay to within six blocks, the same
  for every wallet following the policy.
- **Shield boundary.** Which transparent notes were shielded (their outpoints and so their transparent
  history), and the asset.
- **Exit boundary.** The exit's carrier output and its script, the asset, and the new transparent note's
  outpoint. Under the wallet defaults each exit pays to a fresh key, so the script links to nothing else.
- **Public openings.** The amount of any shielded transparent note whose opening is public (sale lots,
  public mints, published etch supply), and of any exit later sold.
- **Wants.** A want's output index, sats and payout script, so the price of an exit to sats and the
  carrier that paid it. Under the wallet defaults the payout script is a fresh key. To the maker only: the
  exit's opening.
- **Relayer.** Which relayer carried each spend, since its envelope key and change script recur across
  its carriers. To the relayer only: its own fee notes, received as ordinary payments, the arrival time
  and origin of each payload it relays, and which origin owns which exit script.

Not in `L`: any amount inside the pool; amounts at shield and exit, other than public openings; which
leaf a spend consumes; sender and recipient; whether two notes were paid to one address; and, when
relayed, the sender's Bitcoin wallet.

**Anonymity set.** The nominal set for a spend is every leaf of `asset` in the anchor root. The effective
set is smaller by whatever an observer knows beyond `L`: leaves it created or received, timing, and the
transparent history of shielded notes, since a shield followed shortly by an exit of the same asset
narrows it. A wallet that departs from the defaults (odd arity, its own anchor rule, a reused exit script,
self-broadcast) adds its own fingerprint. Relaying removes the sender's fee inputs, and batching many
senders into one carrier removes the one-carrier-per-spend timing signal. Each relayer's carriers form
their own subset, so the set seen by an observer is partitioned by relayer. Network-layer observation
(mempool, broadcast origin) is outside `L` and outside this analysis.

## 5. Comparison with "Shielded Bitcoin" (allocinit, Sep 2026)

That paper states a transfer layer with a canonical-implementation assumption, a double-spend lemma
(knowledge soundness plus a collision term), a hybrid-game privacy theorem over admissible challenge
pairs, and an explicit leakage function. It defers peg-in and peg-out to a follow-up paper and does not
claim trustless entry or exit.

| Goal | Shielded Bitcoin | This design |
|---|---|---|
| Replay agreement | Canonical implementation assumed | Same (A7), with local verification, height-based anchor window and an undo log |
| Double-spend resistance | Knowledge soundness plus collision term | Knowledge soundness. Nullifier uniqueness is proved (Lemma 1) and not left to a collision bound |
| Conservation, in-pool | Proved | Proved (§3.3) |
| Conservation, boundary | Deferred | Proved: the `T_CXFER` kernel at shield, an in-circuit `u64` opening at exit, and the seam rule |
| Spend authorization | Proved for its relation | Proved, against the note's sender and a delegated prover (§3.4) |
| Body binding | Public-input binding | Every body byte is hashed into the public values and signed by each input owner, so binding holds without proof non-malleability (§3.5) |
| Transcript privacy | Hybrid argument | Hybrid argument (§3.6) |
| Boundary amounts | No working boundary | Hidden at shield and exit, except where the transparent note's opening is public |
| Boundary custody | Not claimed trustless | Not claimed trustless. The pool adds no custody, and BTC exposure is cBTC's (§0) |
| Setup | The paper's own instantiation | No new ceremony: the SP1 Groth16 key already relied on by mainnet, confirmed byte-identical (§3.10) |
| Delegated proving | Not addressed as a goal | G8: redirect-proof and unlinkable, with the prover's view stated |
| Batching | Out of scope | Many spends per carrier, each accepted independently, with sequential nullifier and output-claim rules (§3.9) |
| Fee payment | Left to future PIPE fee vaults | A relayer paid by an in-pool fee output; the sender needs no Bitcoin wallet and exposes no fee inputs (§3.8) |

**Where this design goes further.** Boundary amounts are hidden unless the transparent note's opening is
public. The boundary works today through
existing Tacit assets, rather than being deferred. No new trusted setup is introduced. Proving can be
delegated without handing over spend authority or linkability. Spends batch into shared carriers, and fees
are paid inside the pool through relayers, so a sender needs no Bitcoin wallet.

**Where the paper is more rigorous.** It is a standalone formal treatment, and this analysis is not yet
independently reviewed. This design's soundness base is SP1 end to end (a zkVM, its recursion and the
Groth16 wrap), which is larger and less formally analyzed than a dedicated circuit. The related-key
unforgeability of tweaked BIP-340 is assumed here, not proved (A5b). The kernel's knowledge extraction is
the non-tight forking argument that already underlies `T_CXFER`.

## 6. Residual risks

- **Self-inflicted loss.** A shield whose sum reaches `2^64`, a note with an invalid `spend_key` or
  `nk_pub`, a wrong amount in `ct_note`, and a duplicate leaf each strand only the value of the party that
  created them. The canonical wallet refuses to build them.
- **Seam divergence.** A transparent validator that mishandles outputs of `T_BTC_SPEND` carriers either
  rejects valid exit notes (liveness) or accepts unrecorded ones (supply). Both validators must share the
  pool's record (A7).
- **Reorgs deeper than retained undo history** require a replay from an earlier checkpoint. They do not
  change the result, only the cost.
- **Data unavailability** halts an indexer until the data is found (A2). It is a liveness risk, not a
  divergence risk.
- **Hosted records.** Shields of cross-out or AMM ancestry rely on A9 until cross-out mints are
  proof-verified (design §9) and the indexer tracks AMM state itself.
- **Fast-lane lag.** A bound Bitcoin-homed note is spendable in the Ethereum fast lane until reflection
  retires it on Bitcoin. Wallets and the indexer refuse bound notes as shield inputs, so this lag does
  not reach the pool. Transparent spends of a bound note during the lag are the fast lane's own rules
  (SPEC §6.3).
- **Relayer exposure.** A relayer pays the Bitcoin fee before the spend confirms. `bind` stops anyone else
  from posting its payload. If a conflicting spend of the same nullifiers, in another body, confirms
  first, its envelope is rejected and it loses that carrier's fee share. The relayer duties (design §6)
  bound this. It affects only the relayer.
- **Relayer liveness.** A relayer can withhold or delay a payload. The owner can submit a new body
  elsewhere; the old one lapses with its anchor or its bound UTXO.
- **Maker liveness.** A maker can withhold an exit-to-sats payload. The owner signs another body elsewhere;
  the old one lapses with its anchor, and cannot be carried without paying its want.
- **Viewing-key scope.** `v` reveals every note received at the external address and its amount; `v_int`
  adds change and padding; neither shows which notes are spent.

## 7. For external review

- The reductions in §3, in particular Lemmas 1 and 2, the kernel extraction at the shield, the Game 3 and
  Game 5 hops, and the G8 linking argument.
- A3 as instantiated: that the pinned SP1 version's Groth16 wrap samples fresh blinding for every proof
  (zero-knowledge of the published proof rests on it, since the inner STARK is part of the wrap's
  witness), and that the wrap is knowledge-sound for the guest's committed public values.
- A5b's related-key clause for `A + t·G` with an even-`y` adjustment, as used for `spend_key`.
- The guest's parser and range checks against design §3–§4: canonical `nk_note` below `n`,
  `leaf_index < 2^32`, compressed point validity for `nk_pub` and `pk_eph`, x-only validity for
  `spend_key`, the `n_out`/`has_exit`/`has_want` bounds, `u64` openings of every output and the exit, and the `u128`
  sum with the exit term.
- The indexer's acceptance order within a transaction, carrier binding, exit and want output claims, root
  retention at the window edge, undo log, header-chain validation, and the transparent seam, under adversarial replay and reorg tests, including a carrier
  whose `vin[0]` holds a transparent op whose outputs could coincide with an `exit_vout`.
