# Pool backing: the anchor a burn proof is missing

Status: design + tests. No deployed contract, verifying key or ELF changes. Entry for
`docs/STUCK-TAC-BOUNTY.md` option D.

- Code: `contracts/sp1/confidential/provenance-anchor/` (crate `provenance-anchor`, 32 offline tests)
- Read first: `docs/STUCK-TAC-BOUNTY.md` §1, `contracts/sp1/confidential/DESIGN-btc-shielded-pool.md` §3
- Fold it changes: `contracts/sp1/confidential/cxfer-core/src/burn_deposit.rs`
  (`fold_burn_deposit`, the `ncx > 256` bound), `contracts/sp1/confidential/src/reflect.rs` step 4

## 0. One page

**What it does.** It adds the fact the burn proof is missing: how much value the shielded pool is holding
against the transparent notes it has already handed out. A shield credits that ledger through
`read_shield`, which reads it out of a confirmed Bitcoin transaction the same way; an exit is read out by
`read_exit` and debited by
`admit_exit`; the exit note then becomes a leaf the provenance DAG can resolve, alongside `C_0` and cmint
leaves. A second piece lets a lineage longer than 256 transfers be presented from a nearer anchor instead of
the etch.

**Why not just accept the exit.** Membership in the pool is not supply. `reflect.rs` step 4 already refuses
a pool-membership leaf for exactly this reason, and this entry does not relax that — it supplies the missing
backing instead.

**What it assumes.** Three things, worst first. (1) `verify_btc_pool_spend` is sound — the pool half of
every exit is still the extension's proof, and the ledger inherits whatever that proof fails to say. (2) The
boundary seam is honest because the caller passes the right closure: `read_shield` and `read_exit` take
`boundary_ok` as an argument, and a caller who substitutes a permissive closure still credits and debits
anything. `boundary_opens` is the in-crate check a caller must pass — it runs
`btc-pool-zk-core::boundary::verify_bytes` and `cxfer_core::verify_pedersen_opening`, and
`boundary_opens_verifies_a_real_prover_output_and_refuses_a_doctored_one` pins it against a vector the dapp
prover itself produced — but nothing in the crate's types forces its use. (3) The
wire layout is `DESIGN-btc-shielded-pool.md` §3 as read, not as parsed from a real mainnet transaction.

**Numbers.** Out of 4,546 unspent notes, 230 (5.06%) are over the history limit, pool exits not counted.
At 100 TAC per bridge with no screening, a provider's dead balance is `0.0506 · L` per bridge: 50.6 TAC at
10 bridges, 506 TAC at 100, 2,530 TAC at 500. This entry can close those **only if** every stuck note is a
covered class and an anchor is in reach, so the table is a bound (`≤`), not a projection to zero. The 5.06%
is a share of *notes*, valued at par — I did not measure the value split.

**Risks.** The ledger trusts the pool-proof seam above; the two idempotence sets grow without bound like the
spent set does; `Lineage::Anchored` shortening is argued, not machine-checked; the crate is unwired, so no
digest or ELF actually changes yet. Adding `backing` to the committed set is a hard fork when it is wired — §7 says so
instead of claiming digest compatibility.

**What I did not test.** No prover, no verifying key, no live pool, no signet round trip. The wire format is
pinned by reading two sources, not by parsing a real transaction; the boundary is the one exception, now pinned
against a real prover vector. Nothing calls `admit_exit`; the fold-side
change in §7 is a description, not code. The §6 residual — a note past the cap with no anchor in reach — is
unmeasured.

**Where this sits against the brief.** Option D: a design with tests and no deploy. No dependency leaves the
tree (`cxfer-core` and `btc-pool-zk-core` are both path deps beside it, and the latter is already what the
pool's own indexer path compiles), nothing is minified, no deployed contract or verifying key moves, and the
outside file it relies on for its wire assumptions (`worker/src/btc-shielded-pool.js`, 657 lines) was read in
full. `read_exit` now mirrors five of that file's six carrier checks — `exit_vout is not an output of the
carrier`, `exit scriptPubKey does not match dest_spk_hash`, `carrier does not spend the bound outpoint`,
`exit in a carrier whose vin[0] holds a transparent Tacit op`, and `exit_vout already claimed by an earlier
exit or want`. The sixth, `nullifier already spent`, is the one it cannot mirror alone: it needs the pool's
whole spent set, which is §10 risk 6's residual.

## 0.5 Genesis: what the ledger holds on the day this ships

`funded` starts at zero and is raised only by `read_shield` over a `T_BTC_SHIELD` the reflection folds. That
means **this crate can back only exits whose shield it has already seen.** On the day it is switched on, the
custody the pool already holds is not in the ledger, so every pre-existing exit is refused by
`debit` (`value > available()`), not admitted at a loss — the failure is closed, not silent.

There are three ways to seed it, and this entry does not pick one:

1. **Replay from the pool's own genesis.** Fold every historical `T_BTC_SHIELD` once, in block order, before
   the first exit. Exact, and it costs one full rescan; the counters and the two sets end up identical to a
   ledger that had run since genesis.
2. **Checkpoint at the fork block.** Take `funded` as the sum of the pool's unspent note values at the fork
   height, attested by the indexer's root at that height, and start the sets empty. Cheaper, but it trusts the
   indexer's sum at one point in time — the same trust the fold already places in `pool_root`.
3. **Start empty and treat old exits as out of scope.** Simplest to state, and it is what the code does today.
   Under it, the numbers in §6 apply only to shields after the fork, and every note currently stuck remains
   stuck — which is the situation the bounty is trying to fix.

Whichever is chosen, the choice belongs in the fold's first cycle, not in this crate. §11.3 covers the related
question of carrying `funded` across a generational rebase.

## 1. The problem, stated as an accounting gap

The berry bounty names two edges where a burn-deposit provenance walk stops:

1. **a pool exit.** A note that left Bitcoin's shielded pool — a `T_BTC_SPEND` (`0x6D`) with
   `has_exit = 1` — reappears as an ordinary transparent note at the carrier's `exit_vout`. Behind it
   there is no `T_CXFER` history, because the value did not arrive by transfer. The DAG reaches a leaf it
   cannot resolve and the fold refuses the burn.
2. **a long history.** `burn_deposit.rs` refuses a blob whose transfer count exceeds `256`
   (`ncx > 256`). This is a proving-cost bound on an adversary-chosen input, not a statement about
   Bitcoin: a note that has changed hands 300 times is perfectly real.

Both look like "the fold is too strict", and the obvious fix for (1) is to accept the exit because the
pool proved the note exists. **That fix is unsound, and the fold already says so.** `reflect.rs` step 4
refuses to treat a pool-membership leaf as mintable supply, for the reason that makes the whole
reflection safe: pool membership proves a note is *in the pool*, not that the value behind it is real.
Accepting exits on membership alone would let a prover mint against value that was never proven real —
folding a hole in the supply into the supply.

So the missing fact is not "is this note in the pool". It is:

> **How much value is the shielded pool holding for the transparent notes it has handed out?**

Today nothing tracks it. The pool conserves value among its own notes (`btc-pool-core`'s
`verify_btc_pool_spend` enforces `Σ v_in = Σ v_out` per spend), and a shield's inputs are transparent
Tacit notes with their own histories. That chain of custody exists — it is just not committed anywhere
the reflection can read. This design commits it, and nothing else.

## 2. The backing ledger

Per asset, two monotone counters plus the two idempotence sets:

```rust
pub struct BackingLedger {
    funded: u128,                    // Σ of every shield's custody increase
    exited: u128,                    // Σ of every admitted exit
    shielded: BTreeSet<[u8; 32]>,    // sha256 of each credited shield body
    exited_at: BTreeSet<[u8; 32]>,   // exit outpoints already debited
}

impl BackingLedger {
    pub fn available(&self) -> u128 { self.funded.saturating_sub(self.exited) }
    pub fn funded(&self) -> u128 { self.funded }
    pub fn exited(&self) -> u128 { self.exited }
    pub fn shield_count(&self) -> usize { self.shielded.len() }
    pub fn exit_count(&self) -> usize { self.exited_at.len() }
}
```

Both counters only grow, in the order the reflection folds events, so the pair is order-dependent exactly
as the pool's own state is — the `priorDigest` chain already forces that discipline on every other
counter, and a resumed cycle that reorders events gets a different pair and therefore a different digest.
`u128` because one batch may legitimately sum more than 2⁶⁴ sats of witnesses; the on-chain encoding is
two `u64` fields and saturates rather than wrapping.

The two sets are not optional bookkeeping. The counters alone cannot tell a **re-folded** event from a
**second** event, so a resumed cycle that re-folds a block would credit the same shield twice (minting
backing) or debit the same exit twice (draining it) — the exact hole this design exists to close,
reintroduced by the fix. Both transitions are therefore keyed and idempotent: a repeat books nothing.

They are two sets, not one, because the shield key is derived from the shield body while an exit key is an
outpoint. A single namespace would let the two collide and silently suppress a real event. Both grow with
history for the same reason the spent set and the burn set do, and ride the batch digest the same way.

### 2.1 Value enters only through a proven shield

The entry point is `read_shield`, mirroring `read_exit`: the shield must ride `vin[0]` of a confirmed
carrier (the pool refuses any other input), the carrier must hold at least `n_in + 1` inputs, and the
transaction must be proven into the attested block by its merkle path and its BIP141 witness commitment.
Only then is the parsed body handed to `credit_shield`:

```rust
pub fn credit_shield(
    ledger: &mut BackingLedger,
    asset: &[u8; 32],          // the asset this fold is accounting for
    body: &ShieldBody<'_>,     // parsed by `ShieldBody::parse`, the §3 layout
    shielded: u64,
    blinding: &[u8; 32],
    pool_root: &[u8; 32],
    pool_ok: ShieldProofCheck<'_>,
    boundary_ok: BoundaryCheck<'_>,
) -> Option<()>
```

A `T_BTC_SHIELD` (`0x6C`) moves transparent notes into the pool: the carrier's `vin[1..n_in]` are the
notes being shielded and `Σ v_in = depC` is what the pool now holds. The ledger credits that sum, but
only when

- the shield is for **this asset** (a shield of another asset cannot fund this fold),
- the shield's pool proof verified at its root (`⌐` the caller's `ShieldProofCheck`), and
- the boundary opens to exactly `shielded` under `blinding` — i.e. `depC = v·H + r·G` for the claimed `v`.

A shield that moved nothing (`shielded == 0`) or whose boundary does not open is refused and credits
nothing, and a shield body already credited is refused so a re-fold cannot mint backing. The key is
`sha256` of the canonical parsed body, not a caller-supplied txid: a caller-supplied key let one verified
shield body be credited again under a fresh value, which is a mint. This is the only place `funded` moves:
`fund` is private, `credit_shield` is its only caller, and the counters and sets are private too, so no
public path in this crate credits or debits out of band. What that still does **not** buy is the pool half:
`pool_ok` is a closure the caller supplies — this crate cannot resolve a shield's inputs to a note — so a
caller that passes `|_, _| true` can credit a body whose proof it never checked. `boundary_ok` has an
in-crate replacement (`boundary_opens`), but the type does not force it either. §10 states both seams; the
honest reading is "no unverified *carrier*", not "no unverified *claim*".

### 2.2 An exit is admissible iff the ledger covers it, and admitting it debits exactly that much

```rust
pub fn admit_exit(ledger: &mut BackingLedger, anchor: &ExitAnchor, asset: &[u8; 32]) -> Option<()> {
    if &anchor.asset != asset {
        return None; // an exit of another asset cannot drain this one's backing
    }
    ledger.debit(&anchor.outpoint, anchor.value)
}
```

`debit` refuses rather than clamps: `value == 0` is refused (a zero-value exit backs nothing and would
let a prover pad the anchor set), `value > available()` is refused with **nothing booked** so one
unbacked exit cannot be split into two acceptable halves across cycles, and an outpoint already in
`exited_at` is refused so one exit can never back two debits.

That is the entire acceptance rule for pool exits. No discount, no haircut, no bps parameter, no
"trusted relayer" knob. And refusing burns nothing: the note stays spendable on Bitcoin, the pool's own
state is untouched, and the prover simply cannot mint against it.

### 2.3 Why this makes an exit real supply

An exit note is now admissible on the same footing as `C_0`, because

- the value behind it is on the ledger, and
- that value entered through shields whose pool proofs verified and whose boundaries opened.

So the exit is backed by value the reflection can trace, not by pool membership alone. The DAG gains one
more admissible leaf. That **is** a new acceptance rule — a blob presenting an admitted anchor is newly
accepted — but nothing is relaxed: `valid_leaves` only grows, and a blob that presents no anchor folds
byte-for-byte as it does today.

## 3. Reading an exit out of a confirmed transaction

`read_exit` authenticates a `T_BTC_SPEND` carrying an exit all the way to a block's txid root. Every field
it depends on is either read back out of the confirmed bytes or attested by the caller's header chain. Every
field that would otherwise be free is bound: `exit_vout` must name an output the carrier has,
`dest_spk_hash` must be that output's script hash, `bind` must be an outpoint the carrier spends, no other
envelope in the carrier may already claim the same vout, and vin[0] must not carry a transparent Tacit op.
The spend itself must also be one the live pool would accept: the witness stack must be the three-item shape
`inputEnvelope` reads, an unsatisfied `want` rejects the whole spend, and `h_anchor` must sit inside the
144-block `ANCHOR_WINDOW` below the confirming block (`ExitWitness::confirmed_block_height`). Without those
three, `read_exit` would anchor an exit riding a spend the pool rejects or never reads — counting one pool
note twice.
`value` and `blinding` are still the caller's, but they are checked against the commitment: `boundary_ok` is
called with them, and `boundary_opens` is the in-crate implementation a caller passes to get the real check.
Nothing forces its use, so §10 risk 1 stays open for both the pool proof and the boundary seam.

```rust
pub fn read_exit(
    w: &ExitWitness,
    asset: &[u8; 32],
    pool_ok: PoolProofCheck<'_>,
    boundary_ok: BoundaryCheck<'_>,
) -> Option<ExitAnchor>
```

Checks, in order, each returning `None` on failure:

1. `compute_txid(tx)` folds up `merkle_siblings` at `merkle_index` to `confirmed_block_root`.
2. `verify_tx_witness_committed` — the BIP141 binding. **This is the check that matters.** Swapping a
   transaction's witness for a forged Tacit envelope leaves the txid unchanged, so the txid merkle path
   still passes; only the wtxid commitment catches it. A test pins exactly that attack
   (`read_exit_refuses_a_tampered_carrier`).
3. The envelope on input `vin` (witness item 1, the slot `worker-relay` reads) decodes as
   `OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF` with no trailing bytes and a present
   `OP_ENDIF`.
4. `parse_spend` accepts the payload as a canonical `T_BTC_SPEND` (the `DESIGN-btc-shielded-pool.md`
   §3 rules; §4 below records where `btc-pool-core` disagrees with them).
5. `body.asset == asset` — a spend of another asset cannot back this fold.
6. `carrier_spends_bind(tx, body.bind)` — the carrier spends the outpoint the body binds, or the body binds
   none. Mirrors `carrier does not spend the bound outpoint`.
7. `!vin0_holds_a_transparent_op(tx)` — vin[0] carries no transparent Tacit op. Mirrors `exit in a carrier
   whose vin[0] holds a transparent Tacit op`.
8. `value != 0`.
9. `pool_ok(body, pool_root)` — the pool-side seam (Halo2/SP1 verification against the root the indexer
   committed at `h_anchor`).
10. `body.exit.is_some()` — a spend that creates no transparent note anchors nothing.
11. No envelope in the carrier claims `exit.exit_vout`, as an exit or a want. Mirrors `exit_vout already
    claimed by an earlier exit or want`.
12. `parse_tx_output(tx, exit.exit_vout)` returns an output, and `sha256(scriptPubKey)` equals
   `exit.dest_spk_hash` — the exit names an output this carrier actually has, and pays the script the body
   committed to. Mirrors `worker/src/btc-shielded-pool.js` (`exit_vout is not an output of the carrier`,
   `exit scriptPubKey does not match dest_spk_hash`). Without it `exit_vout` is a free witness: one
   confirmed exit could be forked into unlimited anchors and each would debit the ledger.
13. `boundary_ok(exit.boundary, value, blinding)` — the exit's commitment opens to the claimed value. The
    crate ships `boundary_opens` as the honest implementation: it verifies the 169-byte cross-curve sigma and
    the 591-byte Bulletproofs+ range proof through `btc-pool-zk-core::boundary::verify` (already in-tree, the
    same code the pool's indexer path uses) and the opening through
    `cxfer_core::verify_pedersen_opening`. The seam stays so a guest can supply a cheaper equivalent, but the
    entry no longer depends on the caller telling the truth.
14. `commitment_hash_compressed(exit.boundary.c_secp)` — the DAG's identity for the note is the same
    `commitment_hash` the reflection stores for a transparent note.

The result:

```rust
pub struct ExitAnchor {
    pub outpoint: [u8; 32],    // outpoint_key(txid, exit_vout)
    pub commitment: [u8; 32],  // commitment_hash(Cx, Cy)
    pub asset: [u8; 32],
    pub value: u64,
}
```

No partial acceptance and no "skip this one": a skipped event is a silent hole in the fold's accounting,
which is the failure mode this whole design exists to prevent.

## 4. Wire format, and one real divergence

The parser follows `DESIGN-btc-shielded-pool.md` §3 byte-for-byte, because that is also what
`worker/src/btc-shielded-pool.js` parses and encodes on the live path:

```
T_BTC_SPEND = 0x6D ‖ asset(32) ‖ h_anchor(4) ‖ bind(36) ‖ n_in(1) ‖ nf(32)×n_in
            ‖ n_out(1) ‖ output(89)×n_out ‖ has_exit(1) ‖ [exit(861)] ‖ has_want(1) ‖ [want(44)]
            ‖ proof_len(2) ‖ proof

output = leaf(32) ‖ pk_eph(33) ‖ ct_note(24)
exit   = exit_vout(4) ‖ dest_spk_hash(32) ‖ boundary(825)
boundary = C_secp(33) ‖ C_bjj(32) ‖ sigma(169) ‖ bpp(591)
```

Rules enforced by `parse_spend`: `n_in ∈ [1, 2]`, `n_out ≤ 3`, `has_exit, has_want ∈ {0, 1}`,
`n_out + has_exit ≥ 1`, `proof_len ≤ 4096`, no trailing bytes, no zero nullifier, no nullifier repeated
inside one spend, and the declared `proof_len` must exactly consume the rest.

`proof_len = 0` is **legal and load-bearing**: a proofless spend, covered later in the same carrier by one
`T_BTC_AGG` (`0x6E`) whose single proof binds every covered spend's publics
(`worker/src/btc-shielded-pool.js` `aggregateFor`). A parser that insists on a non-empty proof silently
drops every aggregated spend — an early draft of this crate did exactly that, and it is the reason
`parse_spend` now accepts the shape and leaves the aggregate decision to the `pool_ok` seam.

**Divergence worth reporting.** `btc-pool-core::BtcPoolSpendBody` does *not* match §3:

- its `BTC_POOL_OUTPUT_LEN` is `32+32+32+33+33+56 = 218` (`Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖ pk_eph ‖
  ct_note(56)`), against §3's 89;
- its `BTC_POOL_EXIT_LEN` is `4+32+32+32 = 100` (`exit_vout ‖ Cx ‖ Cy ‖ dest_spk_hash`), against §3's
  861 — it keeps the boundary outside the body.

Reading an exit out of a confirmed transaction means reading the **wire** form, so this crate pins §3 and
does not reuse `btc-pool-core`'s body type. That divergence is a finding, not something this entry
silently papers over: either `btc-pool-core`'s constant or §3/`worker` is wrong, and only one of them can
describe what lands on Bitcoin. Worth an issue either way — the guest that folds pool envelopes cannot be
correct against both.

## 5. The 256-transfer cap

`ncx > 256` bounds proving cost. A **re-anchoring** rule makes a long lineage presentable inside the same
bound:

```rust
pub enum Lineage {
    Full     { hops: u32, steps: u32 },                        // fits: present it all
    Anchored { hops: u32, from: [u8; 32], distance: u32 },     // present from the nearest anchor
    Refused  { hops: u32, cap: u32 },                          // nothing in reach
}

pub fn lineage(hops: u32, anchor: Option<([u8; 32], u32)>) -> Lineage
```

- `hops <= 256` → `Full`, the existing path unchanged. The bound is inclusive because `burn_deposit.rs`
  refuses only `ncx > 256`: a 256-step lineage parses today and must keep parsing.
- otherwise, with an anchor at distance `d <= 256` → `Anchored`: present the `d` transfers from that
  anchor down to the burned note, and name the anchor instead of the etch. Admissible anchors are an
  admitted exit note, a cmint leaf, or `C_0` — all supply the fold already accepts.
- otherwise → `Refused`. A burn whose provenance cannot be shown is not mintable, which is the
  conservative direction.

Soundness of the shortened presentation rests on what the fold already checks for every presented step
(inclusion in a confirmed block, value conservation) plus the anchor being admitted supply. Shortening
cannot hide a gap: an unresolved outpoint is a dangling input the DAG already rejects, and an anchor is
not free — it is either `C_0`, a cmint leaf, or an exit the ledger had to cover.

## 6. What a provider holds after N bridges

The brief asks for numbers. These are derived from the bounty's own count on 2026-11-22 — **230 of 4,546
unspent notes (5.06%) over the history limit, pool exits not counted** — not from a fresh scan, and the
pool-exit class is the one this design adds, so the real stuck share is **higher** than 5.06%.

Assume a provider takes `L = 100 TAC` per bridge and screens nothing (`anyTac`). Stuck value is additive:
`0.0506 · L` per bridge — **but only under an assumption the bounty's count does not support.** 230 of
4,546 is a count of *notes*, not of *value*: it says 5.06% of unspent notes are over the limit, and turns
into 5.06% of value only if stuck notes are the same size as clean ones. A provider whose stuck notes are
larger than average loses more than this column says; one whose stuck notes are dust loses less. I did not
measure the value split, so read the numbers below as "5.06% *of notes*, valued at par", not as a measured
haircut.

The last column is what the entry can close **if** every stuck note is a covered class and an anchor is in
reach. It is not `0`, because neither condition holds for every note.

| Bridges | Taken on Bitcoin | Stuck without this entry | Stuck this entry can close |
| --- | --- | --- | --- |
| 10 | 1 000 | 50.6 TAC | ≤ 50.6 TAC |
| 50 | 5 000 | 253 TAC | ≤ 253 TAC |
| 100 | 10 000 | 506 TAC | ≤ 506 TAC |
| 500 | 50 000 | 2 530 TAC | ≤ 2 530 TAC |

Read the share, not the absolute: stuck inventory is a **constant fraction** (≈5%) of Bitcoin-side
holdings, not a growing percentage — every bridge contributes the same slice. What grows is the absolute
dead balance, linearly with volume, and it is dead permanently: the regular bridge cannot carry it and
nothing in the current system can turn it back into lendable TAC.

With the entry, the covered classes become admissible again, so a provider that takes them does not leak
capacity on them. That is the whole mechanism — no subsidy, no discount, no rebalancing loop:

- **Pool exits (`0x6d`)** become provable because the exit is anchored against a ledger of verified
  shields, which is supply the fold already accepts (§2).
- **Histories past 256** become presentable by re-anchoring at an admitted exit note, a cmint leaf, or
  `C_0` (§5).

**What is not modelled here, stated plainly:** the last column assumes every stuck note is one of the two
covered classes and that an anchor is in reach within 256 hops. A note past the cap with **no** admitted
anchor within reach is still `Refused` — that residual is real, unbounded in principle, and I did not
measure it. The honest claim is a bound on what this closes, not a claim that stuck TAC goes to zero.

Note also that the 230/4,546 count does not separate the two classes: it counts notes over the history
limit, not notes this design can present. The `≤` column is arithmetic on a share I was given, not a
measurement of this entry's effect.

## 7. The fold change

Three edits in `burn_deposit.rs`, none of them crypto:

1. **Carry the ledger.** `fold_burn_deposit` already threads its spent set, pool set and burn set through
   the cycle. Add `backing: BTreeMap<[u8; 32], BackingLedger>` and commit each entry's
   `(funded, exited, shielded, exited_at)` in `digest()` exactly as the other counters are. Committing the
   two sets is what makes a re-fold detectable: if they were left out of the digest, a resumed cycle could
   present a ledger whose counters already include an event whose set entry was dropped, and every
   transition would re-book.
2. **Fold pool envelopes.** For each `T_BTC_SHIELD`/`T_BTC_SPEND` the reflection already sees, call
   `read_shield` or `read_exit` + `admit_exit`. The per-event crypto stays where it is: the pool proof,
   the boundary sigma, the range proofs are all still verified by the existing call sites; this adds the
   accounting transition after them.
3. **Grow the leaf set.** Pass `valid_leaves(&existing, &admitted)` into the provenance DAG, and route a
   `Lineage::Anchored` verdict to present from `from` instead of the etch. A `Lineage::Refused` verdict
   keeps today's behaviour: the burn is refused.

This is not a change that leaves the fold untouched. Two claims that look tempting do not hold:

- **"Nothing here is a new acceptance rule."** False. `read_exit` decides which confirmed transactions
  count as supply, and `lineage` decides which presentation shapes the parser accepts. Both are new rules,
  and a blob that presents a pool-exit anchor is newly accepted because of them. The narrower true claim is
  the other direction: no hop the DAG accepted before is refused now.
- **"A node that does not fold pool envelopes produces the same digests it does today."** False, and it
  contradicts §7.1 three paragraphs above. Adding `backing` to the committed set changes `digest()`. A node
  on the old code and a node on the new code diverge the moment a pool envelope is folded, which is a hard
  fork, not an additive side-table. Either the field is committed — and the digests differ, as an upgrade
  must — or it is not committed, and §7.1's re-fold argument collapses. This entry takes the first option
  and says so.

What *is* additive is the state, not the digest: the ledger is a new field, and the events that move it
already exist in the reflection. That is what makes the change reviewable — but reviewable is not
digest-compatible.

## 8. What the 32 tests cover

All offline: `cargo +stable test -p provenance-anchor` (no prover, no network, no pool).

Line counts: 3 277 lines of Rust (1 195 `lib.rs`, 2 082 `tests.rs`).

| Test | What it pins |
| --- | --- |
| `ledger_refuses_unfunded_and_never_partially_books` | an uncovered exit books nothing, then books once covered |
| `ledger_cannot_be_drained_past_its_funding` | the 11th exit is refused, not clamped |
| `the_same_exit_cannot_back_two_debits` | re-folding the same exit books nothing the second time |
| `ledger_fund_saturates_and_value_zero_is_never_an_anchor` | `u128` saturation; a zero-value exit is not an anchor |
| `shield_parse_reads_the_layout_and_refuses_non_canonical_shapes` | §3 shield layout field by field; wrong opcode, `n_in`/`n_out` out of range, every truncation, trailing bytes |
| `read_shield_authenticates_the_carrier_before_crediting` | a shield must ride a real input of a confirmed transaction whose merkle path reaches the attested block, and the carrier must hold `n_in + 1` inputs; a re-fold credits nothing |
| `credit_shield_requires_a_matching_boundary` | a shield that moved nothing, of another asset, whose pool proof failed, or whose boundary does not open, credits nothing — and re-folding it mints nothing |
| `read_shield_refuses_a_shield_that_does_not_ride_vin0` | a confirmed shield on a later input is a spend the pool rejected whole, so it credits nothing |
| `read_shield_refuses_a_carrier_whose_witness_commitment_is_broken` | the merkle path alone is not enough: a carrier failing its BIP141 commitment is refused |
| `no_path_credits_backing_without_a_shield` | one verified shield body credits once whatever the caller passes, so a fresh key cannot re-mint; the ledger can only be credited through a shield |
| `boundary_parse_rejects_every_wrong_length` | 824 and 826 bytes are refused |
| `spend_parse_reads_the_exit_where_the_layout_puts_it` | §3 offset arithmetic, field by field |
| `spend_parse_refuses_every_non_canonical_shape` | wrong opcode, every truncation, trailing bytes, zero/duplicate nullifier, `n_in = 0`, `has_exit = 2`, a spend that creates nothing |
| `read_exit_authenticates_a_real_carrier_and_books_it` | end to end on a real SegWit carrier in a real one-tx block, then the ledger |
| `read_exit_refuses_a_wrong_asset_or_a_seam_that_says_no` | both seams are load-bearing |
| `read_exit_refuses_a_spend_without_an_exit` | no exit, no anchor |
| `read_exit_refuses_a_tampered_carrier` | **the witness-swap forgery** (txid unchanged, commitment breaks), wrong block, wrong opening, zero value |
| `lineage_presents_short_histories_whole` | a 255-hop lineage is presented whole even when an anchor exists, and 256 hops stay `Full` to match `ncx > 256` |
| `lineage_re_anchors_past_the_cap` | 257 and 10 000 hops re-anchor; an anchor at distance 256 is still in reach |
| `lineage_refuses_an_out_of_reach_anchor` | no anchor, or an anchor beyond the cap, refuses |
| `no_path_credits_backing_without_a_shield` | the figment route: zero-value, wrong-asset and failed-pool shields credit nothing, a re-fold mints nothing, and a permissive `boundary_ok` *does* mint — §10 as a test |
| `read_exit_binds_vout_to_a_real_output_and_its_script` | `exit_vout` must name a real output and `dest_spk_hash` must be that output's script, both directions |
| `admit_exit_refuses_an_anchor_in_another_asset` | one asset's backing cannot pay another asset's exit |
| `valid_leaves_adds_each_anchor_once` | dedupe; the base set is never re-pointed |
| `witness_reading_is_panic_free_on_every_truncation` | every prefix of a carrier; missing `OP_ENDIF`; trailing bytes; foreign magic |
| `boundary_opens_verifies_a_real_prover_output_and_refuses_a_doctored_one` | the JS prover's own 825-byte boundary, pinned: accepted for its value and blinding, refused for a different value, a different blinding, a zero value, one flipped byte in the range proof, one flipped byte in the sigma, and a one-byte-short proof |
| `read_exit_refuses_a_carrier_whose_vin0_holds_a_transparent_op` | `ctx.vin0TacitOp`: a transparent `0x39` in vin[0] refuses the exit; a pool op in vin[0] does not |
| `read_exit_refuses_a_carrier_that_does_not_spend_the_bound_outpoint` | `s.bind`: a bind the carrier spends is accepted, a bind it does not spend is refused |
| `read_exit_refuses_a_spend_the_live_pool_would_reject` | the witness must carry the pool's three-item stack, an unsatisfied `want` rejects the whole spend, and `h_anchor` must sit inside the 144-block window below the confirming block — each a way to anchor an exit riding a spend the pool never read |
| `read_exit_refuses_a_carrier_that_already_claims_the_same_vout` | `claimed(vout)`: two exits naming one vout are both refused, two exits on two outputs both read |
| `spend_parse_is_panic_free_on_a_hostile_corpus` | 4 000 pseudo-random payloads, runaway `n_in` |
| `one_note_cannot_be_debited_through_a_second_carrier` | one note carried by two transactions has two outpoints but one commitment: the second debit is refused, so a `bind = 0` exit cannot be replayed into a second payout |
| `valid_leaves_refuses_an_anchor_of_another_asset` | the leaf set of one fold cannot bottom out at another asset's exit |

Run: `cd contracts/sp1/confidential/provenance-anchor && cargo test`
Result: `test result: ok. 32 passed; 0 failed; 0 ignored` (rust 1.100.0, 19 s).

This crate is not a workspace member, so `cargo test -p provenance-anchor` from
`contracts/sp1/confidential/` fails with `did not match any packages`. Run it from the crate directory.

## 9. What this does not do

- **No deploy, no verifying key, no ELF change.** The crate is standalone; no guest links it, so the
  deployed reflection and settle ELFs are byte-identical.
- **No new proof system.** The pool proof, boundary sigma, range proofs, header chain and witness
  commitments are all still the caller's, injected through `PoolProofCheck` and `BoundaryCheck`. This
  crate adds accounting and parsing.
- **No change to the blob format**, so old provers keep working and a blob with no anchor folds exactly as
  today.
- **Not a soundness proof of the pool itself.** It assumes `verify_btc_pool_spend` is sound; if it is not,
  the ledger inherits that.

## 10. Risks

Stated the way the brief asks, worst first.

1. **The value is bound to a commitment, not to the pool actually moving it.** `read_shield` and `read_exit`
   authenticate their carrier — real input, merkle path to the attested block, BIP141 — so bytes cannot be
   made up, but `w.value` / `shielded` are still bound only to the *boundary* (`depC = v·H + r·G`). What
   proves the pool moved that much is `pool_ok`, the `resolveInput` / `depC` / `verify_btc_pool_spend`
   relation, which arrives as a closure. **If that relation is unsound or stubbed, the ledger inherits it and
   a caller can inflate either side.** A merge would have to wire the real check, not a stub.
2. **The three idempotence sets grow without bound.** `shielded`, `exited_at` and `exited_notes` are
   `BTreeSet<[u8; 32]>`, one entry per event, forever. `exited_notes` is keyed on the note's own commitment
   rather than its carrier, because a `bind = 0` exit may be carried by anyone: two carriers for one note are
   two outpoints and one commitment, and keying on the outpoint alone paid it twice. At 4 546 unspent notes today that is nothing; over years it is the same
   problem the spent set and burn set already have, inherited rather than solved. A production version
   wants a rolling commitment or a nullifier set the pool already maintains.
3. **There is no on-chain encoding in this crate.** §2 says the encoding is two `u64` fields that
   saturate, and that is the intended shape — but nothing here writes it, so the claim is a design
   statement, not code. A reader should not assume a serialization already exists.
4. **`Lineage::Anchored` shortens a history, and shortening is where proofs go wrong.** The argument is
   that an anchor is not free (it is `C_0`, a cmint leaf, or an exit the ledger had to cover) and that an
   unresolved outpoint is a dangling input the DAG already rejects. I believe the argument, but it is an
   argument, not a machine-checked proof, and the re-anchoring path is exercised only on synthetic
   lineages in this crate — not against the real DAG.
5. **Scope.** 3 277 lines of Rust (1 195 `lib.rs`, 2 082 `tests.rs`) for a design entry is more than the
   brief needs. If a maintainer wants less surface to review, the survivable cut is the whole `Lineage`
   half (§5), leaving the ledger and the exit reader: that is the part that is specific to pool exits, and
   it stands alone.
6. **Five of the worker's six carrier checks are now mirrored; the sixth cannot be, alone.** This revision
   closed the three gaps the previous one admitted, and each has a test that fails if the check is removed
   (verified by mutation: flipping any one of them reddens exactly one test).
   - `if (ctx.vin0TacitOp) return reject(...)` — `read_exit` now refuses a carrier whose vin[0] holds a
     transparent Tacit op, and accepts one whose vin[0] holds a pool op, which is the worker's rule exactly.
   - `if (claimed(s.exit.exitVout)) return reject(...)` — `carrier_claims_vout` walks every envelope in the
     carrier, so two exits naming one vout are both refused at the read step rather than one of them being
     caught later by the ledger's `exited_at`. Note the worker's set also holds *wants*, which this crate does
     not fold; a want-claimed vout is only visible to us when the want rides the same carrier, and that is the
     case the scan covers.
   - `if (s.bind && ...) return reject('carrier does not spend the bound outpoint')` — `carrier_spends_bind`
     compares `bind` byte-exactly against `extract_inputs`.

   **Now mirrored within one carrier: `carrier_repeats_a_nullifier`.** Two envelopes in the same carrier that
   spend the same note are both refused at the read step, so one carrier cannot debit twice for value that left
   once. The cross-block case is still the pool's.

   **Still not mirrored: `if (this.nullifiers.has(nf)) return reject('nullifier already spent')`.** That is the
   pool's cross-block spent set; this crate sees one carrier and cannot reach it. It does not need to for the
   accounting rule to be sound — a nullifier the pool already spent would have been refused by the fold before
   the carrier was ever confirmed, so `pool_ok` (which the caller wires to the pool's own verification) is
   where that check belongs. But a reviewer should read this list as five of six, not six of six.
7. **What I did not test.** No prover, no verifying key, no live pool, no signet round trip. The wire
   format is pinned to `DESIGN-btc-shielded-pool.md` §3 and `worker/src/btc-shielded-pool.js` by reading,
   not by parsing a real mainnet transaction — except the boundary, which is now pinned against a real prover
   vector. The N-bridge numbers in §6 are derived from the bounty's own
   2026-11-22 count, not from a fresh scan, and the pool-exit class is not in that count. The residual in
   §6 — a note past the cap with no admitted anchor in reach — is not measured.

## 11. Open questions a reviewer should push on

1. **Which wire constant is right?** §3 + `worker` (89/861) or `btc-pool-core` (218/100). This entry pins
   §3 because it is what lands on Bitcoin, but the contradiction should be resolved in-tree.
2. **Debit at admission or at spend?** The code debits in `admit_exit`, i.e. at admission: once an exit is
   confirmed and admitted, the value has left the pool and the transparent note is an ordinary Tacit note
   with its own history. **Nothing calls `admit_exit` yet** — no guest links this crate (§9), so "this design
   debits at admission" is a statement about where the transition belongs, not an observed behaviour. The
   argument for that placement is that deferring the debit to the burn would let one exit back two anchors.
   Whichever is chosen, the transition must stay keyed on the outpoint (see §2): the counters cannot
   distinguish a re-fold on their own.
3. **What happens to `funded` across a generational rebase?** The ledger must ride the same rebase anchor
   as the other counters (`generational_rebase_anchor`), or a successor generation starts funded by
   nothing.
4. **Should the ledger be per-asset or global?** Per asset, because the pool conserves per spend and a
   cross-asset debit would let a prover drain one asset's backing with another's exit.