# SPEC Amendment — Tacit Mesh (browser-side channel cross-validation)

> Status: 📝 Draft (round-1) — **phase 0 only; this is the
> entire deliverable.**
> Depends on: `T_INTENT_ATTEST` (`0x30`, SPEC.md §5.17) — the
> scope-generic preconfirmation channel primitive.
> Consumed by: `SPEC-WORKER-BOND-AMENDMENT.md` — mesh produces
> evidence; worker-bond turns evidence into automated slash.
>
> No new opcode. No new domain tag. No new cryptographic
> primitive. Pure dapp-side cross-validation built on top of
> the existing channel layer.
>
> Each dapp instance fetches `T_INTENT_ATTEST` envelopes from
> multiple workers and cross-checks them against each other.
> Catches selective worker censorship — the attack where a
> worker quietly omits a specific intent from its published
> list while signing an attestation whose hash commits to the
> omitted set. The cross-check is a SHA-256 comparison of
> published intent-id sets across workers; inconsistency is
> publicly visible evidence (consumable by the worker-bond
> equivocation slash path when the inconsistency rises to
> two conflicting signatures from the same worker).
>
> Earlier drafts of this amendment included two additional
> speculative phases (WebRTC snapshot relay; active browser
> attesters). Both were removed from the ship path as either
> not crypto-novel (just a CDN) or overengineered for the
> threat model (Service Workers + ephemeral per-device keys
> for marginal gain). The current document is phase 0 as the
> entire deliverable; see git history for the prior text if
> the operational picture later changes.

---

## Motivation

The tacit channel construction (SPEC.md §5.17) supports
multi-worker attestation out of the box: different `worker_pubkey`
values attesting to the same `(scope_id, observed_height)` with
different hashes is **not** per-worker equivocation — different
workers can legitimately track different intent sub-pools.
Equivocation is per-worker (two attestations from the same
worker at the same `(scope_id, height)` with different
`intent_pool_hash`).

The concrete attack the mesh closes is **selective worker
censorship**: a malicious worker silently omits a specific
trader's intent from the snapshot it publishes, while still
signing an attestation whose hash commits to the omitted set.
The victim trader's local check ("is my `intent_id` in the
worker's list?") fails. Without any cross-comparison, the
trader cannot distinguish "worker is honestly behind on
indexing" from "worker is deliberately censoring me."

With cross-worker validation, the trader fetches the same
scope's attestation from ≥ 1 other worker and compares sets.
If the second worker's list includes the intent, the first
worker is provably either lagging or censoring — either way,
an escalation signal. If two workers publish lists whose
hashes commit to *different* membership for the same
`(scope_id, observed_height)`, that's the cryptographic
equivocation case that `T_WORKER_SLASH` consumes directly.

The mesh is the **evidence-production layer** in the four-layer
channel stack (see `spec/design/META-PROTOCOL-CONSENSUS.md`).
It does not act on evidence — it surfaces it. Acting on
evidence is the worker-bond layer's job.

---

## Phase 0: Passive verifier (default opt-in)

The simplest role. Every tacit dapp instance maintains a small
set of subscribed workers (configured locally; default seeded
by the deployer) and fetches each worker's published
intent-pool snapshot for each scope the user cares about
(typically: scopes containing the user's own open intents,
plus any pools/pairs they're actively watching).

### Verification per worker per scope

1. Fetch the worker's latest `T_INTENT_ATTEST` envelope from
   chain (filtered by `(scope_id, worker_pubkey)`).
2. Fetch the worker's published `sorted_intent_ids[]` from
   the worker's advertised `snapshot_uri`.
3. Verify `worker_sig`, freshness (TTL 300 s default),
   hash-equality (`SHA256(concat(sorted_intent_ids[]))` matches
   the on-chain `intent_pool_hash`), and that the user's own
   `intent_id` (if any) is in the list — per SPEC.md §5.17
   trader-side soft-confirm verification.

### Cross-worker consistency check

When ≥ 2 workers attest to the same scope at the same height,
the dapp compares their published intent sets. Patterns the
mesh detects:

- **Strict subset.** One worker's set is a strict subset of
  another's: the smaller-set worker is missing intents the
  larger-set worker tracks. Could be benign (relay-latency
  lag) or could be censorship.
- **Disjoint or near-disjoint sets.** The workers serve
  different trader populations, or one is misbehaving.
- **Invalid `intent_id`s.** A worker's set contains
  `intent_id`s that don't validate against the indexer's
  intent records. Worker is fabricating intents (extremely
  suspicious; possibly attempting a phishing surface).
- **Per-worker equivocation.** Same worker, same
  `(scope_id, observed_height)`, two attestations with
  different `intent_pool_hash`. This is the cryptographic
  case — sufficient evidence for a `T_WORKER_SLASH` envelope.

### Dapp UX surface

The dapp MUST surface, per intent:

- ✅ **Confirmed in N workers' attestations** (N ≥ 2 of the
  trusted set agree the intent is included).
- ⚠️ **Confirmed in only 1 of N trusted workers** (weak
  confirmation; refetch later or expand trusted set).
- ❌ **Not in any trusted worker's attestation**
  (`worker_missing` or relay failure; settlement may still
  succeed but cryptographic accountability is degraded).
- 🔥 **Cross-worker inconsistency detected** (one or more
  workers disagree about intent membership; user should
  investigate before relying on soft-confirm for any
  high-value action).

For per-worker equivocation (the strongest detection case),
the dapp SHOULD additionally:

- Offer the user a "submit slash evidence" UI affordance
  that assembles the `T_WORKER_SLASH` envelope referencing
  the two conflicting `T_INTENT_ATTEST` txids and
  broadcasts under the user's key as `reporter_pubkey`.
- Continue to display soft-confirm status correctly until
  the slash confirms (per the worker-bond amendment).

### Cost

CPU for SHA-256 over the published list (microseconds per
worker). Bandwidth for fetching `sorted_intent_ids[]` (tens
of KB per worker per scope per epoch). **Zero chain
footprint** for the verification itself; only the optional
`T_WORKER_SLASH` submission hits the chain, and only when
equivocation actually fires.

---

## Composition with the worker-bond layer

Mesh and worker-bond are tightly coupled by design:

- Mesh produces the evidence — the two conflicting
  attestation txids from a single worker for a single
  `(scope_id, observed_height)`.
- Worker-bond consumes the evidence — the dapp (or any
  permissionless reporter) submits `T_WORKER_SLASH`
  referencing the two txids.
- The slash:
  - Zeros the offending bond's TAC value
  - Pays a configurable bounty (`SLASH_REPORTER_BOUNTY_BPS`,
    default 10%) to the reporter
  - Burns the remainder (per-outpoint reattribution against
    the 21M fixed TAC cap)
  - Sets `worker_flag.equivocator = true` globally

A worker who has not posted a bond still gets the global
`equivocator` flag set if their equivocation is reported,
but no economic slash applies — pure reputation
consequence. With a bond, the consequence is automated and
economic.

The mesh is the **only** detection layer for *selective
censorship* (which `T_INTENT_ATTEST` alone cannot detect — a
worker quietly omitting one intent from a set still produces
a valid attestation over the omitted set). Per-worker
equivocation is detectable from the chain alone, but mesh
surfaces it to dapps in real time without requiring traders
to walk the full attestation history.

---

## Backwards-compatibility statement

Purely additive at the dapp / worker / network layer. No
protocol-level changes. Indexers do not need updates; they
already accept `T_INTENT_ATTEST` envelopes from any pubkey
at any cadence per SPEC.md §5.17. Multi-worker attestation
support has been structural in `T_INTENT_ATTEST` since its
introduction.

This amendment does NOT modify:
- Any opcode wire format
- Any indexer validator branch
- Any existing BIP-340 domain tag
- Any HMAC keystream domain
- Any cryptographic primitive
- `T_INTENT_ATTEST` semantics (§5.17 unchanged)
- `T_WORKER_*` opcodes (consumed by mesh as evidence sink,
  not modified)

It DOES add:
- Dapp-side cross-worker fetch + comparison logic
- Dapp-side UX states surfacing the four patterns above
- An optional "submit slash evidence" UI affordance when
  per-worker equivocation is detected (the actual
  `T_WORKER_SLASH` envelope is normative to
  `SPEC-WORKER-BOND-AMENDMENT.md`, not this one)

No worker-side changes (workers continue publishing
attestations + snapshots per the existing convention).

---

## Test plan (informative — non-normative)

1. **Three honest workers, same scope, same height.** Dapp
   subscribes to all three. All publish identical sets;
   dapp surfaces "confirmed in 3 of 3 workers."
2. **One worker omits a specific intent (selective
   censorship).** Other two include it. Dapp surfaces
   "confirmed in 2 of 3 workers (worker X is missing your
   intent)"; surfaces "worker X may be censoring" indicator.
3. **One worker publishes an inconsistent hash (per-worker
   equivocation).** Same worker, same `(scope_id, height)`,
   two distinct attestation txs with different
   `intent_pool_hash`. Dapp surfaces "🔥 cross-worker
   inconsistency detected — worker X equivocated"; offers
   "submit slash evidence" UI; the assembled
   `T_WORKER_SLASH` envelope is validated by the dapp's
   local validator before broadcast.
4. **Worker `snapshot_uri` returns 404.** Dapp falls back to
   other workers' snapshots for the same scope; UX displays
   "snapshot fetch failed for worker X — verifying against
   remaining N − 1 workers."
5. **Worker publishes invalid intent_ids.** Dapp detects
   intent_ids in the snapshot that don't validate against
   indexer records; surfaces "worker X fabricating intents
   — recommend untrust."
6. **Slash submission end-to-end.** Dapp detects per-worker
   equivocation (test 3); user clicks "submit slash";
   `T_WORKER_SLASH` envelope confirms; verify
   `worker_flag.equivocator = true` post-confirm and the
   bounty TAC is attributed to the user's declared vout.
7. **Multi-scope worker.** One worker attests to two
   different scopes; dapp tracks each scope independently;
   inconsistency in one scope does NOT cross-contaminate
   the other scope's verification state.
8. **Trusted-set rotation.** User removes worker X from
   their trusted set; dapp's verification thresholds
   recompute against the smaller set; previously cached
   evidence from X is preserved for cross-validation but no
   longer counted toward "confirmed in N" counters.

---

## Open questions for round-2 review

1. **Default trusted-worker count.** How many workers
   should the dapp subscribe to by default? 3 seems like the
   right balance (enough redundancy for majority-correct
   heuristics, low bandwidth). Tunable per user.
2. **Snapshot-cache TTL.** 300 s default for treating a
   fetched snapshot as fresh. Too short burns bandwidth on
   refetches; too long risks acting on stale views during a
   block-level state change. Empirical.
3. **Slash-submission gating.** Should the dapp auto-prompt
   the user to submit `T_WORKER_SLASH` whenever
   equivocation is detected, or wait for explicit user
   action? Auto-prompt risks fee-burn from races against
   other reporters; explicit-action loses some
   first-mover bounties. Lean toward explicit-action; flag
   for round-2.
4. **Cross-worker discovery.** How do dapps find honest
   workers? Today the trusted set is deployer-seeded. An
   on-chain worker registry (opt-in indexer-of-indexers)
   is a follow-up; not in scope here.

---

## Sign-off checklist

- [ ] Round-1 peer review of the cross-validation logic
- [ ] Reference dapp implementation (fetch + compare + UI
      surface + slash-submission affordance)
- [ ] Signet rehearsal of test items 1–8
- [ ] Production deployment alongside the orderbook channel
      and worker-bond amendments
- [ ] Merge into SPEC.md as §5.17.1 (Tacit mesh — passive
      cross-validation) and mark `✅ Merged` in
      `AMENDMENTS.md`
