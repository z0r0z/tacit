# Meta-Protocol Consensus — Architecture Overview

> Status: 📐 Architecture reference (not a normative amendment).
> Scope: how the channel-layer, mesh, batching, and worker-bond
> amendments compose into a single accountability stack for
> indexer-tracked tacit state — and why that composition is the
> first concrete shipping answer to a problem every Bitcoin
> meta-protocol has.
>
> Audience: protocol designers reviewing how the pieces fit;
> integrators trying to decide which primitives they need;
> reviewers checking that the stack is coherent before any
> single amendment merges.
>
> This document is descriptive — it summarizes the normative
> amendments and maps their composition. Where this overview
> and a normative amendment disagree, the amendment wins.

---

## The problem (and why it's not just tacit's problem)

Every Bitcoin meta-protocol — runes, ordinals, BRC-20, tacit —
shares one structural gap: the protocol's state lives in
indexers, not in Bitcoin. Bitcoin only validates the underlying
transactions; what those transactions *mean* in the meta-
protocol is interpreted off-chain by each indexer. Two indexers
can disagree about meta-protocol state with no on-chain
mechanism to force convergence.

The current answer everywhere is **social consensus among
operators**: everyone runs the same code, sees the same
Bitcoin chain, computes the same state. This works until:

- An indexer operator has an incentive to lie (front-running a
  trader by misrepresenting which intents are in flight).
- Indexer implementations drift (one supports an opcode the
  other doesn't; their states diverge silently).
- An adversary stands up a malicious indexer in front of a
  victim trader's dapp and feeds them a doctored state view.

No Bitcoin meta-protocol shipping today has an on-chain
accountability mechanism for any of these. Tacit's channel +
mesh + bond stack is the first concrete answer: indexer state
becomes **cryptographically committed** (channel layer),
**multi-observer verified** (mesh), and **economically
accountable** (worker bond). Together these turn indexer state
from "soft social consensus" into "cryptographically + economically
accountable consensus" without any change to Bitcoin L1.

The pattern is general. Any meta-protocol whose indexer
maintains stateful per-account or per-asset bookkeeping
(balances, intents, positions) can adopt the same primitives.
Tacit is the first; nothing about the construction is
tacit-specific beyond the asset model.

---

## The stack

```
                         ┌─────────────────────────────────────┐
                         │  L4 — Economic accountability       │
                         │  SPEC-WORKER-BOND-AMENDMENT         │
                         │  (TAC bond; equivocation slash;     │
                         │   burn-on-slash + reporter bounty)  │
                         └─────────────┬───────────────────────┘
                                       │ slashable on evidence from
                                       ▼
                         ┌─────────────────────────────────────┐
                         │  L3 — Cross-validation              │
                         │  SPEC-TACIT-MESH-AMENDMENT          │
                         │  (passive multi-worker comparison;  │
                         │   selective-censorship detection)   │
                         └─────────────┬───────────────────────┘
                                       │ produces evidence consumable by
                                       ▼
                         ┌─────────────────────────────────────┐
                         │  L2 — Preconfirmation commitment    │
                         │  T_INTENT_ATTEST (SPEC.md §5.17)    │
                         │  + SPEC-ORDERBOOK-CHANNEL scope     │
                         │  + AMM channel scope schemas        │
                         │  (worker signs hash of open intent  │
                         │   set; equivocation cryptographically│
                         │   evident)                          │
                         └─────────────┬───────────────────────┘
                                       │ attests to intents that settle via
                                       ▼
                         ┌─────────────────────────────────────┐
                         │  L1 — Atomic settlement primitives  │
                         │  T_AXFER / T_AXFER_VAR / T_SWAP_*   │
                         │  / T_TRADE_BATCH / preauth-sale /   │
                         │  T_PREAUTH_BID                       │
                         │  (trustless Bitcoin txs)            │
                         └─────────────────────────────────────┘
```

Each layer is **independently useful**: L1 settlement works
without any worker, L2 attestation works without a bond, L3
mesh works without slashing. The layers compose to give
strictly stronger guarantees, but none of them creates a hard
dependency on the layer above.

### L1 — Atomic settlement primitives

What actually moves TAC and sats. These are trustless Bitcoin
transactions; no worker is required to settle.

| Primitive | Opcode | Role |
|---|---|---|
| `T_AXFER` | `0x26` | pairwise asset transfer (fixed-amount) |
| `T_AXFER_VAR` | `0x37` | variable-amount orderbook fill |
| `T_SWAP_VAR` | `0x32` | AMM variable swap |
| `T_SWAP_BATCH` | (per SPEC.md §5.16) | AMM batched settlement |
| `T_TRADE_BATCH` | `0x39` | atomic cross-surface batch (AMM + orderbook in one tx) |
| preauth-sale | (SPEC.md §5.7.8) | seller-offline pre-signed listing |
| `T_PREAUTH_BID` | `0x5B` | buyer-offline pre-signed bid |

These are the canonical "trade done, state final" envelopes.
Channel layer (L2+) is about what happens *before* one of
these confirms.

### L2 — Preconfirmation commitment

The channel primitive: workers commit, on-chain, to the hash
of their open intent set. Traders verify their intent is in
the set. Equivocation across a single
`(worker_pubkey, scope_id, observed_height)` is detected by the
indexer when a second envelope with the same key but a
different hash arrives.

| Component | Source | Role |
|---|---|---|
| `T_INTENT_ATTEST` | SPEC.md §5.17 | scope-generic primitive (✅ merged) |
| Orderbook scope schemas | `SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md` | per-pair / per-worker orderbook attestation conventions |
| AMM channel scope schemas | `spec/amm/dapp-checklist.md` + `spec/amm/wire-formats.md` | per-pool AMM attestation conventions |

`T_INTENT_ATTEST` is **scope-generic** by design: the `scope_id`
field carries a 32-byte canonical identifier of the attested
intent set, treated as opaque by the indexer. The same opcode
serves AMM intents (scope = `pool_id`), orderbook intents
(scope per pair or per worker), and any future intent surface
without spec changes — register a new scope-id schema, the
opcode handles it.

A trader posts an intent to a worker (off-chain RPC). The
worker accepts, includes it in the next attestation, broadcasts
a `T_INTENT_ATTEST` envelope covering the scope. The trader
verifies inclusion via SHA-256 over the worker's published
sorted intent-id list. Within ~30 s the soft-confirm is
cryptographically grounded — a worker that later denies the
intent or serves a different list to a different trader is
caught by the next layer up.

### L3 — Cross-validation

`T_INTENT_ATTEST` is per-worker. Two workers attesting to the
same scope at the same height with different hashes is **not**
equivocation — they could just be tracking different intent
sub-pools. The selective-censorship attack — one worker quietly
omits a specific intent from its published list — is
cryptographically silent at L2 alone.

`SPEC-TACIT-MESH-AMENDMENT.md` phase 0 closes that gap by
having dapps cross-check attestations from N workers. Patterns
the mesh detects:

- A worker's intent set is a strict subset of another's
- Sets are disjoint or near-disjoint
- A worker's set contains intent-ids that don't validate
  against the indexer's intent records

The amendment is explicit: these patterns are **soft-suspicious
only**. The mesh surfaces them in UI; it does not slash. The
mesh's job is to *produce evidence*; L4 is what *acts* on it.

(Phases 1 and 2 of the mesh amendment — WebRTC snapshot relay
and active browser attesters — are documented but not on the
V1 path; phase 0 is the meaningful deliverable.)

### L4 — Economic accountability

`SPEC-WORKER-BOND-AMENDMENT.md` turns the cryptographic evidence
the L2/L3 layers produce into an automated economic consequence:

- A worker that wants traders to honor its attestations as
  soft-confirms locks a TAC bond using the **cBTC.tac §5.47
  lien pattern**: standard worker-controlled P2TR carrying a
  TAC asset commit, with the indexer recording a lien in
  `bond_state` that `commitmentForUtxo` refuses to honor
  unauthorized spends of. No federation, no multisig, no
  covenant; the lien is enforced by validator coordination,
  not by Bitcoin script.
- Cooperative bond release requires a notice period
  (`BOND_NOTICE_BLOCKS`) with no slash evidence in that window.
- **Anyone** can submit `T_WORKER_SLASH` referencing two
  conflicting `T_INTENT_ATTEST` envelopes signed by the same
  worker at the same height for the same scope. The indexer
  validates the evidence (lookups against its existing attest
  index — no signature re-verification needed), reattributes a
  configurable fraction (`SLASH_REPORTER_BOUNTY_BPS`, default
  10%) to the reporter's declared vout, burns the remainder
  (per-outpoint reattribution: `bond_outpoint`'s attributed TAC
  drops to zero with no offsetting attribution; supply
  contracts against the 21M fixed cap), and globally flags the
  worker as `equivocator`.

The bond is denominated in TAC. The reasoning is in
SPEC-WORKER-BOND-AMENDMENT.md's "Why TAC, not BTC, for the
bond" / "Why burn instead of pool" sections; the short version
is that TAC's fixed-supply cap makes burn permanent supply
contraction (every TAC holder's pro-rata claim strengthens),
the cBTC.tac precedent is already proven (`SLASH_DETECTED`),
and channel-layer slashes have a different beneficiary
topology than wrapper-layer slashes (so the burn keeps the
distribution question from arising).

---

## The composition story

The four layers stack to make a single guarantee:

> If you act on a soft-confirmed intent attested by a bonded
> worker, then either (a) the intent settles via L1 as the
> attestation said it would, or (b) the worker loses their
> bond and you have permissionless on-chain evidence of why.

L1 alone gives (a) under honest worker assumption. L2 makes
worker behavior cryptographically observable. L3 catches the
attacks L2 misses (selective censorship via cross-worker view
comparison). L4 makes the attacks L2 catches *expensive* —
specifically expensive in the TAC currency that already
underwrites cBTC.tac, with the same indexer-state-reattribution
machinery.

The composition also extends cleanly to **cross-surface
atomic settlement**: a settler assembling a `T_TRADE_BATCH`
from intents attested by a bonded worker can advertise the
batch as "bonded preconfirmation, atomic Bitcoin settlement" —
the strongest UX position the protocol offers, with no new
primitive required.

---

## Why this is meta-protocol consensus

The construction is functionally a **lightweight finality
gadget for indexer state**. Compare to proof-of-stake L1
finality:

| Aspect | PoS finality gadget | Tacit channel + bond |
|---|---|---|
| What is attested | next block / state root | open intent set at a height |
| Who attests | bonded validators | bonded workers |
| Signature scheme | BLS / Schnorr | BIP-340 Schnorr |
| Equivocation evidence | two conflicting votes | two conflicting `intent_pool_hash`es |
| Slashing | stake burned + reporter reward | TAC burned + reporter bounty |
| Scope | L1 chain state | meta-protocol indexer state |

The differences are scope and trust horizon. PoS finality
secures the L1 chain itself; tacit's channel + bond secures
the meta-protocol's interpretation of an L1 chain it doesn't
control. The shape of the consensus mechanism is otherwise
identical.

This means a future tacit-adjacent meta-protocol (or any
Bitcoin meta-protocol willing to adopt the pattern) can
inherit indexer-state accountability by adopting:

1. The intent-attest primitive (or its analog — any scope-
   generic signed commitment to indexer-tracked state).
2. A TAC-denominated bond + slash opcode pair following the
   `T_WORKER_*` shape.
3. Whatever scope schemas its own state model needs.

No L1 fork required. No new cryptographic primitive. The
ceiling on adoption is operational, not protocol-level.

---

## Trust assumptions that still apply

The stack does not eliminate all trust — it eliminates the
specific trust that *worker attestations are honest*. The
following remain unchanged, as they were before this stack
existed:

1. **Bitcoin L1 consensus.** Cryptographic; native.
2. **BTC self-custody in cBTC.zk / cBTC.tac slots.** Depositor
   holds the slot's BIP-340 Schnorr key; no third party can
   spend the underlying sats. (Loss of the slot key is loss of
   the slot — same as any Bitcoin wallet.)
3. **AMM ceremony soundness.** Standard 1-of-N honest setup
   assumption; ceremony locks the verification key for the
   AMM Groth16 circuit.
4. **TAC asset model.** Standard tacit asset binding via
   cross-curve Pedersen commitments + asset-id binding (per
   SPEC.md §5.4). The bond inherits this — if the asset model
   were broken, all TAC-denominated state would be too.
5. **TAC price stability for the bond's risk profile.**
   `INITIAL_BOND_RATIO ≥ 2.0` overcollateralization plus the
   `MAX_BONDED_FRAC_OF_TAC_FDV ≤ 0.25` cap (shared with
   cBTC.tac) are the existing mechanisms. Catastrophic TAC
   depeg degrades the bond's deterrent value but does not
   directly forge attestations.
6. **Indexer determinism.** All indexers running the canonical
   validator on the same Bitcoin chain compute the same state.
   This is the assumption the entire meta-protocol relies on
   pre-stack; the stack adds accountability *given* this
   assumption holds, it does not enforce it.

The stack reduces the trust surface to "the canonical
validator is implemented correctly across indexers" + the
five items above. Worker honesty is no longer in that set.

---

## What's still soft (and why)

Three classes of attack the stack does not hard-prevent:

### Selective censorship

A worker can omit a specific intent from its published list,
sign an attestation whose hash commits to the omitted set, and
serve a different (compliant) view to other traders. Mesh
phase 0 detects this when traders cross-check; the victim
trader knows. But it is **not slashable** — the worker can
plausibly claim "I hadn't seen that intent yet at attestation
time." Worker-bond explicitly excludes censorship from the
slashable set.

A follow-up amendment could add inclusion-promise sigs: a
worker signs "I commit to including intent X in my next
attestation"; breaking that promise becomes slashable. Out of
scope for the current stack; tracked as future work.

### Mempool-stage races

The slash and cooperative-close envelopes both target indexer
state, not Bitcoin UTXO consumption (the bond UTXO is
unspendable). Within-block ordering is `tx_index` ascending
per SPEC.md §11, so whichever envelope confirms first wins
deterministically. The remaining soft case: a slash sitting
in mempool while a close confirms ahead of it. The slash then
hits `state != "closing"` and is rejected, the worker walks
with the bond. This is real but bounded by the close-notice
period (default 1008 blocks ~ 1 week): evidence-holders have
that window to broadcast slashes.

### Multi-indexer set discovery

Today the trusted-worker set is deployer-seeded in dapps.
Decentralized discovery (an on-chain worker registry, opt-in
indexer-of-indexers) is a follow-up; not in the current
amendment set.

---

## Open architectural questions

1. **Inclusion-promise primitive.** Worth designing the
   slashable-censorship variant or sticking with mesh-as-
   detection-only? Adds complexity (workers sign promises,
   indexer tracks fulfillment); buys hard-slashable censorship.

2. **Indexer-level accountability beyond channels.** This
   document frames worker-bond as channel-layer accountability,
   but the same primitive could underwrite other indexer-
   tracked state (AMM pool state attestations, cBTC.tac slot
   integrity attestations, future wrapper attestations).
   Whether to generalize the bond opcode's scope or keep one
   bond-type per consumer is a structural decision.

3. **Cross-meta-protocol portability.** If a future Bitcoin
   meta-protocol adopts the tacit channel + bond pattern, do
   the bonds remain TAC-denominated (inheriting tacit's
   collateral economy) or can they be denominated in the
   meta-protocol's own asset? TAC bonds bind worker incentives
   to tacit-wide health; native bonds bind to local health.
   Likely orthogonal — the bond opcode is asset-generic; the
   denomination is a deployer parameter.

4. **Bond auctioning / worker key rotation.** A worker
   migrating to a new `worker_pubkey` currently closes the old
   bond cooperatively and opens a new one. Atomic rotation
   (one tx, no notice-period gap in soft-confirm coverage)
   would be a follow-up convenience.

5. **Insurance variant.** Worker-bond currently burns the
   slashed TAC. An insurance variant (slashed TAC funds a
   pool that pays out to traders harmed by the equivocation,
   subject to claim mechanism design) is a stronger guarantee
   for traders but adds significant complexity. Tracked as a
   future amendment if claim mechanisms can be designed
   without admitting governance-over-victim-identification.

---

## Where each amendment fits

| Amendment | Status | Layer | Role |
|---|---|---|---|
| `T_INTENT_ATTEST` (SPEC.md §5.17) | ✅ Merged | L2 | scope-generic preconfirmation primitive |
| `SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md` | 📝 Draft (round-1) | L2 | orderbook-side scope schemas |
| AMM channel scope schemas (`spec/amm/`) | ✅ In-tree | L2 | AMM-side scope schemas |
| `SPEC-TACIT-MESH-AMENDMENT.md` | 📝 Draft (round-1, phase 0 only) | L3 | passive multi-worker cross-validation |
| `SPEC-WORKER-BOND-AMENDMENT.md` | 📝 Draft (round-1) | L4 | TAC bond + equivocation slash |
| `SPEC-TRADE-BATCH-AMENDMENT.md` | 📝 Draft (round-1, ref impl deferred) | L1 | atomic cross-surface settlement |
| `SPEC-CBTC-TAC-AMENDMENT.md` | (in-flight) | (adjacent) | precedent for TAC-bond, §5.47 lien-via-`commitmentForUtxo` mechanism, indexer-state slash (`SLASH_DETECTED` §5.39.2), and TAC-creation-without-input conservation exception (`T_SHARE_SLASH_CLAIM` §5.39.4) |
| `SPEC-WRAPPER-AMENDMENT.md` | (in-flight) | (adjacent) | wrapper metadata convention |

The "Status" column reflects each amendment's individual
shipping cadence. None of them blocks any other — pieces can
land in whatever order the implementation work resolves.

---

## What this document does NOT do

- It is **not** a normative amendment. Where it summarizes,
  the source amendment is canonical.
- It does **not** introduce any new opcode, primitive, or
  parameter. It is purely a composition map.
- It does **not** specify cross-meta-protocol portability
  details — those would need a separate "Adopt the tacit
  channel + bond pattern for your meta-protocol" guide.
- It does **not** address dapp UX (`spec/design/CHANNEL-UX-DESIGN.md`
  covers that — read both for the complete picture).

---

## Reading order for a new reviewer

If you're trying to assess whether the channel/bond stack is
coherent, read in this order:

1. **This document** — get the composition map.
2. **SPEC.md §5.17** (`T_INTENT_ATTEST`) — the primitive.
3. **`SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md`** + AMM channel
   scope schemas in `spec/amm/dapp-checklist.md` — see the
   primitive's two concrete consumers.
4. **`SPEC-TACIT-MESH-AMENDMENT.md`** (phase 0 section) —
   how the multi-observer layer detects what the primitive
   alone can't catch.
5. **`SPEC-WORKER-BOND-AMENDMENT.md`** — how detection
   becomes consequence.
6. **`SPEC-CBTC-TAC-AMENDMENT.md` §5.47 + §5.39** — the
   `commitmentForUtxo` lien precedent (§5.47.3) plus the
   indexer-state slashing + conservation-exception precedents
   (`SLASH_DETECTED` §5.39.2, `T_SHARE_SLASH_CLAIM` §5.39.4).
7. **`SPEC-TRADE-BATCH-AMENDMENT.md`** — how all of the above
   composes with cross-surface atomic settlement.
8. **`spec/design/CHANNEL-UX-DESIGN.md`** — what the user sees.

After step 5 you have enough context to decide whether the
worker-bond amendment specifically is sound. After step 7 you
have enough to decide whether the whole stack is sound.

---

## Change log

- Initial draft. Captures the L1–L4 stack as of the current
  amendment set and frames it as the first concrete shipping
  answer to the meta-protocol-consensus gap on Bitcoin.
