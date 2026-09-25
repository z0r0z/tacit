# Security and privacy analysis: Bitcoin-native shielded pool

Status: DRAFT (Phase 1 of `DESIGN-btc-shielded-pool.md` §12). Companion to that design, not a
replacement — read it first for the opcodes, note model, and proof relation this analyzes.

§3 below states each security goal as a formal experiment with a named advantage term and reduces it to
the assumptions in §1 (A1–A8, A5a, and two assumptions this analysis adds — A9, A10 — that the earlier
informal sketch relied on implicitly without naming). This gives an external cryptographer or auditor
concrete reductions to check, at the rigor level of SPEC.md's own analyses and the competitor paper's
Theorem 1/2, not a substitute for that review.

## 1. Assumptions

**A1. Bitcoin ledger.** Confirmed Bitcoin history above a chosen depth is stable with overwhelming
probability, per ordinary Bitcoin security assumptions. Reorgs below that depth are handled by §10's
rebuild rule, not assumed away.

**A2. Data availability.** Accepted envelope bytes are retrievable from confirmed Bitcoin transactions.
An indexer or wallet that cannot retrieve an envelope treats it as absent from its replay input.

**A3. Proof system.** The SP1 zkVM, wrapped to Groth16 output, is knowledge-sound for the relation in
`DESIGN-btc-shielded-pool.md` §4: an accepting proof implies the prover knew a witness satisfying it,
except with the negligible advantage of forging an SP1/Groth16 proof. It is zero-knowledge for that
statement: proof bytes reveal nothing about the witness beyond the public statement. Both properties are
inherited from SP1's own soundness/zero-knowledge claims, not re-derived here — this design adds no new
proof-system assumption, only a new relation proved inside the existing one. This assumption does **not**
include non-malleability of the proof bytes themselves — Groth16 proofs are re-randomizable, and nothing
here relies on a specific proof's bytes as an identity (design doc §4 argues why that's safe: replay
protection is nullifier-based, not proof-identity-based).

**A4. Hash and leaf binding.** `keccak` is collision-resistant, so the leaf function in §2 is
position-binding: no two distinct `(asset, Cx, Cy, spend_key)` tuples produce the same leaf, and no two
distinct leaves produce the same nullifier, except by a keccak collision.

**A5. Spend-key binding.** The discrete logarithm problem is hard on secp256k1: given `spend_key`, no PPT
adversary can find `sk_note` such that `spend_key = sk_note·G`, except with negligible probability. This is
what the relation's authorization check (§4 of the design doc: witness `sk_note`, constrain
`spend_key = sk_note·G`) reduces to. Direct witnessing is both simpler and
the more standard construction for this kind of relation than a detached signature (it's what makes the nullifier formula
in A5a possible at all). Non-malleability (no field can be altered after proof generation) is not this
assumption's job — it follows from A3 instead, since `h_body` is itself a public input the proof is bound
to.

**Canonical witness requirement.** Since `spend_key` is x-only, both `sk_note = d` and `sk_note = n−d` (curve order minus
`d`) satisfy `spend_key = sk_note·G` for the same `spend_key` — they produce points with the same
x-coordinate. `nf_secret` (A5a) hashes the *full* scalar, so `d` and `n−d` produce **different**
`nf_secret` values and therefore different nullifiers for the same note, meaning its owner could spend it
twice under two distinct, individually-valid proofs — a genuine double-mint path, not just a linkability
issue. The relation must additionally constrain `sk_note·G` to have even y (rejecting
otherwise), the same canonicalization BIP-340 signing already performs implicitly — with it, only one of
`{d, n−d}` is ever an accepted witness for a given `spend_key`, and the ambiguity closes completely. Every
downstream claim about `sk_note` (A5a, G2, G4) assumes this canonicalization holds.

**A5a. Nullifier-secret privacy.** `nf_secret = keccak("tacit-btc-pool-nf-v1" ‖ sk_note)` is a value only
the note's owner can compute, because computing it requires `sk_note`, which A5 says is infeasible to
recover from the public `spend_key` alone. This is the assumption `nullifier = keccak(leaf‖nf_secret‖
"spent")`'s unlinkability rests on, stated as its own assumption because it is a distinct requirement from
A4/A5: with
`leaf` fully public at creation time, a nullifier formula that depended on `leaf` alone would let anyone
precompute it without knowing any secret at all (see design doc §2's formula, which folds in `nf_secret`
for exactly this reason).

**A6. Pedersen commitment binding and hiding.** `C = v·H + r·G` is computationally binding (opening to two
different values requires solving discrete log) and perfectly hiding (for a uniformly random `r`, `C`
reveals nothing about `v`) — the same assumption already relied on throughout Tacit's existing Bitcoin
metaprotocol, not new to this design.

**A7. Canonical implementation.** Every correct indexer uses the same parser, acceptance order (§10 of
the design doc), leaf/nullifier derivation, and proof-verification algorithm. There is no
implementation-defined acceptance rule — the same assumption the competitor paper names as A8, adopted
here for the identical reason: without it, replay agreement (G1 below) doesn't hold.

**A9. Random oracle.** `keccak` behaves as a random oracle: on any input not previously queried, it returns
a value drawn uniformly from `{0,1}^256`, independent of every other output. A4 (collision resistance) is
strictly weaker and does not by itself give pseudorandomness — the hybrid reduction for G6 (§3) needs the
stronger property, specifically that `nf_secret = keccak("tacit-btc-pool-nf-v1"‖sk_note)` and
`H(shared)` (the stealth-derivation hash in the design doc's §2) are indistinguishable from uniform
strings to anyone without the corresponding secret, not merely that they're hard to collide. Stated as its
own assumption because it's genuinely stronger than A4, not a restatement of it.

**A10. DDH on secp256k1.** The Decisional Diffie-Hellman problem is hard on secp256k1: given `(G, a·G,
b·G)`, no PPT adversary distinguishes `ab·G` from a uniformly random group element with non-negligible
advantage. This is what the ECDH shared secret in the design doc's §2 stealth derivation
(`shared = ECDH(eph, pk_recv)`) rests on for indistinguishability from random, not just A5's plain
discrete-log hardness — DDH is what makes `spend_key`/`pk_eph`/the AEAD key indistinguishable from
independent random values to an observer who holds neither `eph` nor `sk_recv`. The same assumption
already underlies Tacit's shipped EVM stealth-send construction (README); this design adds no new trust
here, only names the assumption the existing construction was always relying on.

**A8. Wallet behavior.** Honest wallets sample fresh randomness for every note (`r` in `C`, the ephemeral
secret feeding `pk_eph`), never reuse it across notes, and choose an anchor depth they're willing to trust
against reorg risk before building a proof. Load-bearing specifically: **the sending wallet derives a
fresh one-time `spend_key` per note via the §2 stealth construction and never publishes a raw, reused
`spend_key`.** Because `spend_key` is necessarily public (the indexer derives `leaf` from it), reuse across
notes is a real linkability break, not a hygiene nice-to-have — G6 (transcript privacy) holds only under
this assumption, not merely under A3/A5/A6.

## 2. Security goals

**G1. Replay agreement.** Any two correct indexers (A7) that process the same confirmed Bitcoin prefix
derive the same tree, nullifier set, and root history.

**G2. Double-spend resistance.** No two accepted `T_BTC_SPEND` envelopes publish the same nullifier, and
no envelope contains a repeated nullifier internally. This depends on the same note always producing the
same nullifier regardless of which valid witness spends it — which in turn depends on the canonical-witness
requirement above (A5's addendum). Without it, G2 fails outright: the note's own owner could produce two
different nullifiers for the same note by witnessing `d` in one proof and `n−d` in another.

**G3. Value conservation.** For every accepted spend, the sum of input values equals the sum of output
values (pay) or the exit output's real Bitcoin value (exit), and every value is a canonical amount in
range — no accepted spend can mint or destroy value. No fee term exists at this layer (design doc §3);
Bitcoin carrier fees are paid from unrelated coins, entirely outside this relation.

**G3 for exit depends on an acceptance-order check, not the proof alone.** `exit_value` is a constrained
public input (so a proof cannot verify against a tampered `exit_value`), and design doc §10 step (2a)
checks `outputs[exit_vout]`'s real value against it, closing "claim any amount." Value alone is not
sufficient, though: nothing would then bind *who* `exit_vout` pays, so a validly-signed envelope and proof
could be rebroadcast inside a different carrier transaction whose `exit_vout` paid the right amount to an
attacker's own script — value-correct, recipient-wrong. `dest_spk_hash` closes that: bound
into `h_body` (so it's signed, not just claimed) and checked against the real output's scriptPubKey by
step (2a) alongside the value. G3 for exit therefore depends on step (2a) checking **both** halves — value and
destination — neither alone is sufficient.

**G4. Spend authorization.** An accepted spend of a note implies the prover held `sk_note`, the secret
committed (via `spend_key = sk_note·G`) at that note's shield time — proven by witnessing it directly in
the relation rather than by a detached signature, which is simpler and is also what the nullifier formula
(A5a) requires anyway.

**G5. Envelope binding.** A proof accepted for one published envelope cannot be repointed to a different
one — changing *any* field of the envelope (not a hand-picked subset) invalidates the proof, because
`h_body`, a hash of the whole canonical envelope, is itself one of the proof's public inputs, and a
Groth16/SP1 proof is only valid for the exact public-input vector it was generated against (A3). Binding
the whole envelope rather than an enumerated field list (e.g. "nullifiers, output leaves, fee, `h_anchor`")
matters: leaving `pk_eph` and `ct_note` unbound would let a relayer swap them post-signature without
invalidating the proof — the note would stay spendable but become silently undiscoverable to its intended
recipient. `h_body` covers everything by construction, not by remembering to list it — and needs no
signature layer on top, since the proof's own public-input binding already does this job.

**G6. Transcript privacy.** For two valid histories that agree on everything a passive observer already
sees (arity, timing, `h_anchor` age, fee metadata — the leakage function in §4), the published envelopes
and replayed state are indistinguishable between them.

**G7. Recovery completeness.** A wallet holding the recipient secret `sk_recv` and replaying accepted
history recovers every note paid to it and no others — i.e. scanning (§6 of the design doc: trial ECDH
against each published `pk_eph`) is both complete (misses nothing genuinely addressed to it) and sound
(never mistakes another recipient's note for its own). Not covered elsewhere in G1–G6, which are all about
spend-side correctness; this is the corresponding receive-side guarantee.

## 3. Formal security and privacy analysis

### 3.0 Setup

Fix a security parameter `λ`. Let `negl(λ)` denote an unspecified negligible function. Let `C` denote a
finite prefix of the Bitcoin ledger (a sequence of confirmed blocks), and let `Replay(C)` denote the
deterministic function the design doc's §10 acceptance order computes over `C`: a tree, a nullifier set,
and a root history, per a fixed canonical implementation (A7). All experiments below are run against a
PPT adversary `A`, who either outputs a candidate prefix `C` directly (for statements about what a
prefix can contain) or interacts with an **honest-party oracle** `O` that, on request, runs the honest
`T_BTC_SHIELD`/`T_BTC_SPEND` wallet construction (design doc §2–§3) using freshly sampled randomness (A8)
and appends the resulting envelope to a prefix `A` controls the assembly of. An experiment `Exp` returns a
bit; `A`'s advantage is `Adv(A) = |Pr[Exp^A = 1] - c|` for the experiment's stated baseline `c` (0 for a
"bad event" experiment, 1/2 for a distinguishing experiment).

The proof system is treated as a black box per A3, with two named advantage terms for the relation `R`
defined in `DESIGN-btc-shielded-pool.md` §4 (`verify_btc_pool_spend` in `btc_pool.rs`):

- `Adv^ks_R(λ)` — the probability a PPT adversary produces an accepting proof `π` for a public statement
  `x` without the extractor recovering a witness `w` such that `R(x, w) = 1`. (Knowledge soundness.)
- `Adv^zk_R(λ)` — the maximum distinguishing advantage between a real proof for `(x, w)` and a proof
  produced by SP1/Groth16's zero-knowledge simulator `Sim(x)` given only the public statement. (Zero-
  knowledge.)

Both are inherited from SP1's own security claims (A3) and are not re-derived here; this analysis only
uses them as reduction targets.

### 3.1 G1 — Replay agreement

**Experiment `Exp^{repl}_A(λ)`:** `A` outputs a prefix `C`. Two honest indexer implementations `I1`, `I2`
(both instantiating A7's canonical parser/acceptance-order/derivation/verification) each compute
`Replay(C)` independently. The experiment returns 1 if `I1`'s output differs from `I2`'s.

**Claim.** `Pr[Exp^{repl}_A(λ) = 1] = 0` given A7.

**Proof.** The acceptance order in the design doc's §10 is a total function of `C`: every candidate
envelope is processed in a fixed, block-and-transaction-index-determined order, each step (parse, opening
proof, anchor-window/root check, nullifier-absence check, SP1 verification) is a pure predicate over `C`
and the state accumulated so far, and rejection mutates nothing. A7 states this exact algorithm is what
every correct indexer runs. Two implementations of the same deterministic total function over the same
input produce the same output by definition; any observed difference would mean at least one of `I1`,
`I2` is not, in fact, running the canonical algorithm — i.e. A7 is violated, not that G1 has a
cryptographic counterexample. `Adv^{repl}_A(λ) = 0` unconditionally under A7 (not merely negligible — this
goal has no cryptographic reduction at all, only a correctness-of-specification one). ∎

### 3.2 G2 — Double-spend resistance

**Experiment `Exp^{ds}_A(λ)`:** `A` interacts with `O` and assembles a prefix `C`. The experiment computes
`Replay(C)` and returns 1 if either (a) two distinct accepted `T_BTC_SPEND` envelopes in `C` publish the
same nullifier, or (b) one accepted envelope publishes a repeated nullifier internally.

**Claim.** `Adv^{ds}_A(λ) ≤ Adv^{ks}_R(λ) + q·Adv^{cr}_{keccak}(λ)`, where `q` is the number of accepted
`T_BTC_SPEND` envelopes and `Adv^{cr}_{keccak}` is the keccak collision-finding advantage (A4).

**Proof.** Case (b) is caught directly by the relation: `verify_btc_pool_spend` computes each input's
nullifier and checks it against the ones already pushed for that same proof (`nullifiers.contains(&nf)`,
`btc_pool.rs`), so an accepting proof cannot contain an internal repeat except via `Adv^{ks}_R` (a proof
accepted without a satisfying witness). Case (a) is caught by the acceptance order's nullifier-absence
check against the replayed set (design doc §10 step 3) — the second of two envelopes publishing an
already-present nullifier is rejected outright. The only way (a) succeeds is if the *same note* produces
**two different** accepted nullifiers across two proofs, letting its owner (or anyone who obtained the
witness) spend it twice each time past the absence check. `nullifier = keccak(leaf‖nf_secret‖"spent")`
(A4) is deterministic in `(leaf, nf_secret)`, and `leaf` is fixed once a note's `(asset, Cx, Cy,
spend_key)` is fixed (A4's position-binding). So two different nullifiers for the same note require two
different accepted `nf_secret` values for the same `leaf` — i.e. two different accepted `sk_note` values
satisfying `spend_key = sk_note·G` for the same `spend_key`.

This is exactly where the canonical-witness requirement (A5's addendum) is load-bearing, not decorative.
`spend_key` is x-only: for any scalar `d` with `spend_key = compress(d·G)`, the negation `n−d` (mod curve
order `n`) satisfies the same x-only equality, `compress((n−d)·G)` sharing the same x-coordinate but odd
y. `nf_secret = keccak(domain‖sk_note)` hashes the *full* scalar, so `d` and `n−d` hash to different
`nf_secret` and therefore different nullifiers for the same `leaf`. **Without** the even-y constraint, the
reduction does not go through at all: an adversary who knows any valid `sk_note = d` for a note trivially
computes `sk_note' = n−d`, which also satisfies `spend_key = sk_note'·G` (A5), gets a distinct accepting
proof, and double-spends with zero cryptographic break — `Adv^{ds}_A(λ) = 1` in that variant, not
negligible. `verify_btc_pool_spend` closes this by rejecting any witnessed `sk_note` whose point is not
the even-y representative (`btc_pool.rs`'s `c[0] != 0x02` check) before the equality check even runs, so
only one of `{d, n−d}` is ever an accepted witness for a given `spend_key`. **With** that constraint, the
map from `spend_key` to its unique accepted `sk_note` is injective, so `leaf → nf_secret` is a
deterministic function (not merely a relation), and two different accepted `nf_secret` values for the same
`leaf` require either an `A3` knowledge-soundness break (a proof accepted with an `sk_note` that isn't
actually the even-y witness for that `spend_key`) or a keccak collision on `leaf`'s own preimage fields
(A4, since the same `leaf` bit-string would then have to arise from two different `(asset, Cx, Cy,
spend_key)` tuples for the case where the attacker instead tries to forge a second `leaf` colliding with
the first). Unioning the knowledge-soundness failure once (a single break suffices to forge a bad witness
anywhere in the `q`-envelope prefix) with a keccak-collision search across the `q` accepted leaves gives
`Adv^{ds}_A(λ) ≤ Adv^{ks}_R(λ) + q·Adv^{cr}_{keccak}(λ)`, both negligible in `λ` by A3 and A4. Structurally
this is the same shape as the competitor's own Lemma 1 (a knowledge-soundness term plus a `q`-way
collision term), with the canonicalization step making the reduction's second half hold at all. ∎

### 3.3 G3 — Value conservation

**Experiment `Exp^{cons}_A(λ)`:** `A` interacts with `O` and assembles `C`. The experiment returns 1 if
`Replay(C)` accepts a `T_BTC_SPEND` envelope for which `Σ v_in ≠ Σ v_out` (pay) or `Σ v_in ≠
value(outputs[exit_vout])` (exit).

**Claim.** `Adv^{cons}_A(λ) ≤ Adv^{ks}_R(λ) + Adv^{bind}_{Ped}(λ)`, where `Adv^{bind}_{Ped}` is the
Pedersen-binding-break advantage (A6, itself a discrete-log reduction, A5).

**Proof.** `R` constrains `Σv_in = Σv_out` (pay) or `Σv_in = exit_value` (exit) directly over the
witnessed openings, and constrains `exit_value` itself as a public input the design doc's §10 step 2a
checks against the real chain output (closing the "claim any amount" and "claim any destination" gaps
separately, per G3's own exit clause). An accepting proof without a witness satisfying this equality
requires `Adv^{ks}_R`. A witness satisfying the *in-circuit* equality but opening a commitment `C` to two
different values (e.g. the value used to build `C` publicly differs from the value the witness supplies)
requires breaking Pedersen binding, which reduces to discrete log (A5/A6). Summing these two disjoint
failure modes gives the bound; the exit destination half of G3 (`dest_spk_hash`) is argued under G5 below,
since it's a special case of envelope-binding rather than a conservation property per se. ∎

### 3.4 G4 — Spend authorization

**Experiment `Exp^{auth}_A(λ)`:** `A` interacts with `O` and assembles `C`, without ever querying `O` to
spend a specific target note `nt` created by an earlier `O` call. The experiment returns 1 if `Replay(C)`
accepts a `T_BTC_SPEND` envelope whose nullifier corresponds to `nt`.

**Claim.** `Adv^{auth}_A(λ) ≤ Adv^{ks}_R(λ) + Adv^{dl}_{secp256k1}(λ)`, where `Adv^{dl}` is the discrete-
log-solving advantage (A5).

**Proof.** By A3, an accepting proof implies a witness `sk_note` satisfying `spend_key = sk_note·G` for
`nt`'s committed `spend_key` (the relation's authorization check, `btc_pool.rs`). `A` never received
`sk_note` from `O` (it did not query a spend of `nt`), so either `A` forged an accepting proof without
such a witness (`Adv^{ks}_R`) or `A` itself computed `sk_note` from the public `spend_key`, which is
exactly the DL problem A5 assumes hard. No detached-signature forgery term is needed — this design proves
authorization by direct witnessing (design doc §2), so the only two failure paths are proof-system break
or DL break, one term each. ∎

### 3.5 G5 — Envelope binding

**Experiment `Exp^{bind}_A(λ)`:** `A` interacts with `O`. `O` accepts one query, produces `(π, x)` for
some honestly-assembled envelope `env`, and gives both to `A`. `A` outputs an envelope `env' ≠ env` and
resubmits `π` against `env'`'s recomputed public statement `x'`. The experiment returns 1 if the
recomputed `x'` verifies against `π`.

**Claim.** `Adv^{bind}_A(λ) ≤ Adv^{ks}_R(λ)` (in fact `= 0` given exact SP1/Groth16 public-input binding,
with `Adv^{ks}_R` covering only the degenerate case `x' = x` under a field the indexer doesn't recompute).

**Proof.** The guest commits every raw field of `canonical_body` — `asset`, every nullifier, `out_kind`,
every output's full contents for a pay or `exit_vout`/`dest_spk_hash` for an exit, and `h_anchor` —
directly as `BtcPoolSpendValues`, the proof's public statement (`btc_pool.rs`, design doc §4). A
Groth16/SP1 proof verifies only against the exact public-input vector it was generated for; changing any
field the guest commits changes that vector, so `π` fails verification against `x' ≠ x` by the proof
system's own completeness/soundness (not a reduction to any assumption in §1 — this is SP1's binding
property directly, inherited via A3). The only residual risk is a field the guest does *not* commit but
the indexer still trusts from the envelope bytes — there is none by construction (§4's "whole envelope,
not an enumerated list" design), so `Adv^{bind}_A(λ) = 0` for every field the relation commits, with no
term beyond A3 itself. ∎

### 3.6 G6 — Transcript privacy

This is the property the design exists to provide, and is argued here as a hybrid-game sequence in the
style of the competitor's own Theorem 2, mirroring their `G0 → G1 → G2 → G3` structure.

**Experiment `Exp^{priv}_{A,b}(λ)`:** `A` selects two equal-shape spend histories `h_0`, `h_1` that agree
on every field the leakage function (§4) already makes public — arity, timing, `h_anchor` age, fee
metadata, per-note asset — and differ only in which real notes are spent/created and to whom. The
challenger runs history `h_b` through the honest construction, publishes the resulting envelopes and
replayed state to `A`, and `A` outputs a guess `b'`. `Adv^{priv}_A(λ) = |Pr[b' = b] - 1/2|`.

- **G0 (real game).** Exactly `Exp^{priv}_{A,b}`, honest proofs, honest ciphertexts, honest nullifiers.
- **G1.** Replace every proof `π` with `Sim(x)`, the SP1 zero-knowledge simulator, given only the public
  statement. `|Pr[G0 = 1] - Pr[G1 = 1]| ≤ Adv^{zk}_R(λ)` (A3), applied once per spend in the challenge
  history (a standard hybrid over the number of spends, still bounded by a single `Adv^{zk}_R` term up to
  a polynomial factor the reduction absorbs).
- **G2.** For every output note in the challenge history, replace `ct_note` with an AEAD encryption of an
  all-zero plaintext under an independently-sampled key, and replace `pk_eph`/`spend_key` with
  independently-sampled uniform values (instead of the DH-derived ones). `pk_eph = eph·G` for freshly
  sampled `eph` (A8) is already uniform on its own — no gap there. The gap is `spend_key = pk_recv +
  H(shared)·G` and the AEAD key, both derived from `shared = ECDH(eph, pk_recv)`: distinguishing these
  from independent uniform values reduces to distinguishing `shared` from a random group element, which is
  exactly DDH (**A10**), composed with `keccak`/the AEAD key-derivation function behaving as a random
  oracle (**A9**) to carry that indistinguishability through the hash. `|Pr[G1 = 1] - Pr[G2 = 1]| ≤
  Adv^{ddh}_{secp256k1}(λ) + Adv^{ro}_{keccak}(λ)` (A10, A9), unioned over the polynomially many output
  notes in the challenge history.
- **G3.** For every input note in the challenge history, replace the published `nullifier` with a
  uniformly random 256-bit string. `nullifier = keccak(leaf‖nf_secret‖"spent")` with `leaf` already public
  (it was published at the note's creation, possibly outside the challenge window) and `nf_secret =
  keccak(domain‖sk_note)`. This step needs `nf_secret` itself to be indistinguishable from uniform, which
  needs `sk_note` to carry enough entropy into a random-oracle `keccak` (A9) — not automatic, since
  `sk_note = sk_recv + H(shared) mod n` is a *specific* value, not sampled fresh at spend time. Under A9,
  `H(shared)` is itself uniform over `Z_n` (a fresh `keccak` query on an input `A` cannot have queried
  without breaking A10 first), and adding a uniform value mod `n` to any fixed `sk_recv` yields a value
  uniform over `Z_n`; restricting to the even-y canonical representative (the note-creation-time
  canonicalization the design doc's §2 already requires of the *sender*) halves the support but preserves
  uniformity over it. So `sk_note` has full min-entropy over its actual support given A9/A10, and a fresh
  `keccak` query on it under A9 is uniform and independent of every other oracle output. `|Pr[G2 = 1] -
  Pr[G3 = 1]| ≤ Adv^{ro}_{keccak}(λ) + Adv^{ddh}_{secp256k1}(λ)` (A9, A10 again, for the `sk_note` entropy
  argument this time rather than the ciphertext argument in G2).

`G3` is independent of `b`: every proof is simulated from public data alone, every ciphertext is an
encryption of zero under an independent key, every `spend_key`/`pk_eph` pair is independently uniform, and
every nullifier is an independent uniform string — none of these depend on which real notes `h_0`/`h_1`
actually spent or created, only on the public shape both histories share by construction. So `Pr[G3 = 1] =
1/2` exactly, and

```
Adv^{priv}_A(λ) ≤ Adv^{zk}_R(λ) + 2·Adv^{ddh}_{secp256k1}(λ) + 2·Adv^{ro}_{keccak}(λ)
```

each term negligible in `λ` under A3, A9, A10. This bound holds **given A8** (fresh randomness per note):
if a wallet reuses `spend_key` across two notes in `h_0` or `h_1`, `A` distinguishes trivially by
inspection (`Adv^{priv}_A(λ) = 1`) with no game-hop needed — A8 is not folded into the advantage terms
above because it is not a computational assumption the reduction bounds against a negligible term, it is a
behavioral precondition on the challenge histories themselves: this theorem is only meaningful for
histories `A` submits that respect it, the same way the competitor's own Theorem 2 is stated over
"admissible" challenge pairs. ∎

### 3.7 G7 — Recovery completeness

**Experiment `Exp^{rec}_A(λ)`:** the challenger runs `O` honestly to produce a set of notes, some
addressed to an honest recipient key pair `(sk_recv, pk_recv)` unknown to `A`, some to keys `A` controls.
`A` outputs a prefix `C ⊇` the honestly-produced envelopes plus anything else `A` assembled. The
experiment returns 1 if the honest recipient's scan over `Replay(C)` either misses a note genuinely
addressed to `pk_recv` (completeness failure) or recovers a note not addressed to `pk_recv` (soundness
failure).

**Claim.** `Adv^{rec}_A(λ) ≤ Adv^{ro}_{keccak}(λ)` (A9; A4's weaker collision bound also suffices for this
goal specifically, since it only needs the two `H(shared)` evaluations to disagree, not to individually
look random).

**Proof.** Completeness: for a note genuinely addressed to `pk_recv`, the sender computed `shared =
ECDH(eph, pk_recv)` and `spend_key = pk_recv + H(shared)·G`; the recipient computes `shared' =
ECDH(sk_recv, pk_eph)`. Standard DH shared-secret equality (`eph·pk_recv = eph·sk_recv·G = sk_recv·pk_eph`
as group elements) gives `shared = shared'` exactly, so the recipient's derived `sk_note = sk_recv +
H(shared')` reproduces the sender's `spend_key` bit-for-bit; the scan always succeeds for every note
actually addressed to `pk_recv`, with probability 1, no assumption needed for this half. Soundness: the
recipient misattributes a note addressed to someone else's `pk_recv''` only if `H(ECDH(sk_recv,
pk_eph''))·G` happens to reconstruct that other note's `spend_key`, i.e. a `keccak`-output collision
between two distinct DH outputs (A4) or, for a random-oracle-style bound on the false-positive rate
itself, A9. `Adv^{rec}_A(λ) ≤ Adv^{cr}_{keccak}(λ)` unconditionally suffices for a bound; A9 gives a
tighter, birthday-style bound if wanted, but is not required — G7 is the one goal in this section whose
weaker A4-only bound is enough on its own. ∎

### 3.8 Summary of assumption dependencies

| Goal | Reduces to |
|---|---|
| G1 replay agreement | A7 (no cryptographic term) |
| G2 double-spend resistance | A3, A4, A5 (canonical-witness addendum) |
| G3 value conservation | A3, A5, A6 |
| G4 spend authorization | A3, A5 |
| G5 envelope binding | A3 |
| G6 transcript privacy | A3, A8 (behavioral precondition), A9, A10 |
| G7 recovery completeness | A4 (A9 for a tighter bound) |

No goal above required an assumption this analysis could not state precisely, and no genuine new
vulnerability turned up while working the reductions through — the one real gap the exercise found was a
missing formalization (A9, A10 were implicit in the informal sketch's "look independently random" and
"unlinkable" language but never named), not a hole in the design itself. The even-y canonicalization
already implemented in `btc_pool.rs` is what makes G2's reduction go through at all; had it been absent,
this section would report a genuine break rather than a proof.

## 4. Leakage function

Mirrors the shape of the competitor's own `Leak(X)` (their §20.1), stated precisely so §12's Phase 1
sign-off has something concrete to check implementations against:

- **Bitcoin publication metadata** — block height, transaction order, carrier-transaction fee behavior,
  and whatever wallet-clustering the fee-paying inputs expose (§9's fee-linkage caveat, unresolved here).
- **Envelope shape** — `n_in`, `n_out`, envelope size, opcode (shield vs. spend).
- **`h_anchor` age** — how far behind the chain tip the referenced root is; unusually old anchors can
  fingerprint a wallet's proving delay, same observation the competitor makes about their own `hanchor`.
- **Replay schedule** — which block accepted the envelope, and the ordinal position of the new leaf(ves)
  in the tree, though not which position was *spent*.
- **Shield-time boundary data** — the locked amount is public (it's a real Bitcoin output's value) and so
  is the lock's own output/script, same as every other design's peg-in leakage, including the
  competitor's.
- **Exit-time boundary data.** `exit_value` (the full redeemed amount) and
  `exit_vout`'s destination script are both public, checked directly against real chain data (§10 step
  2a). Symmetric with shield-time leakage, not a smaller or larger surface — cashing out reveals amount
  and destination the same way locking in does.

**Not leaked**, given A3/A5/**A5a**/A6/**A8** hold: spent-note value, which leaf a spend's nullifier
closes (this specifically depends on A5a: a nullifier formula depending on `leaf` alone would make this
*trivially* leaked, since `leaf` is fully public at creation time and anyone could precompute the
nullifier without any secret at all; A5a's `nf_secret`, derivable only from `sk_note`, is what actually
closes this, not `h_body` or A8), recipient identity beyond a one-time `spend_key`/`pk_eph` pair (unlinkable
to any other note paid to the same recipient, or to any real-world identity, absent other metadata — but
*only* because A8 requires it be fresh; a reused `spend_key` reopens this immediately), and the
input→output mapping within a spend.

**Privacy set caveat**, same one the competitor names in their own §20.6: the *nominal* anonymity set for
a spend under anchor root `h_anchor` is every leaf appended to the tree by that height, but the *effective*
set shrinks with any auxiliary information an observer has (leaves they control, timing correlation via
`h_anchor` age, fee-wallet clustering). This design doesn't claim a uniform lower bound on real-world
privacy any more than the competitor's does — that depends on adoption and wallet policy, not on the
proof system.

## 5. What Phase 1 does not close

- **Independent verification of the reductions in §3.** These are worked by hand, not machine-checked or
  externally reviewed — the same bar every other Tacit mainnet component clears before launch (Pashov/
  Astra-style review, `DESIGN-btc-shielded-pool.md` §12 step 5) still applies to this section specifically
  before Phase 5 sign-off.
- **A9 (random oracle) and A10 (DDH on secp256k1) are new assumptions this analysis introduced**, not
  present in the design doc's own informal treatment. Neither is unusual — A9 is the standard modeling
  choice for hash-based nullifier/PRF arguments, A10 is what every stealth-address scheme already reduces
  to, including Tacit's shipped EVM construction — but they are additions a reviewer should scrutinize
  specifically, since they weren't named before this pass.
- No treatment of network-layer privacy (mempool observation, broadcast timing) — out of scope here, same
  as it's out of scope for the competitor's own paper (their §20.7).
- No fuzzing/formal-verification plan for the SP1 guest itself — that belongs to Phase 2, once code
  exists to verify.

This closes Phase 1's rigor bar: G1–G7 now have named experiments, advantage terms, and reductions to the
assumptions in §1 (including the two, A9/A10, this pass added), at the same level SPEC.md's other analyses
and the competitor's Theorem 1/2 use. What remains is independent review of those reductions, not writing
them for the first time. Phase 2 (the guest implementation) is next.
