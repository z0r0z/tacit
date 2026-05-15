# SPEC Amendment — Tacit Mesh (opt-in browser-side channel cross-validation)

> Status: 📝 Draft (round-1) — **phase 0 is the actual deliverable;**
> **phases 1 + 2 are exploratory.**
> Depends on: `T_INTENT_ATTEST` (`0x30`, SPEC.md §5.17) — the
> scope-generic preconfirmation channel primitive. No new opcode,
> no new domain tag, no new cryptographic primitive in this
> amendment.
>
> **Phase 0 (passive verifier) is the meaningful contribution.**
> Each dapp instance fetches `T_INTENT_ATTEST` envelopes from
> multiple workers and cross-checks them against each other,
> catching the "selective censorship" attack where one worker
> serves different intent-pool views to different traders.
> Cryptographic — the cross-check is a SHA-256 comparison of
> sets; inconsistency is publicly visible evidence.
>
> Phase 1 (WebRTC snapshot relay) is essentially a CDN —
> peer-to-peer redundancy for fetching the worker's published
> intent list when the primary `snapshot_uri` is offline. Useful
> for operational resilience; not crypto-novel.
>
> Phase 2 (active browser attesters broadcasting under ephemeral
> per-device keys) is genuinely overengineered for the security
> model. Marginal gain over phase 0; implementation complexity
> (Service Workers, ephemeral key rotation, sat-balance UX) is
> high. Documented here as a design exploration, not a planned
> deliverable.

---

## Motivation

The tacit channel construction (SPEC.md §5.17) supports
multi-worker attestation out of the box: different `worker_pubkey`
values attesting to the same `(scope_id, observed_height)` with
different hashes is **not equivocation** — just independent
observers maintaining independent views of the open intent set.
Equivocation is per-worker.

**The single concrete attack phase 0 closes** is *selective worker
censorship*: a malicious worker silently omits a specific
trader's intent from the snapshot it publishes, while still
signing an attestation whose hash commits to the omitted set.
The victim trader's local check ("is my intent_id in the worker's
list?") fails. Without any cross-comparison, the trader can't
distinguish "worker is honestly behind on indexing" from "worker
is deliberately censoring me." With phase 0, the trader fetches
the same scope's attestation from ≥ 1 other worker and compares
sets: if the second worker's list includes the intent, the first
worker is provably either lagging or censoring; either way, an
escalation signal.

Phase 1 (WebRTC mesh relay) addresses a different concern: the
worker's HTTP `snapshot_uri` endpoint going offline. The
chain-recorded `intent_pool_hash` is still verifiable, but
recipients can't fetch the underlying list to do the SHA-256
comparison. Mesh peers cache the list and serve it peer-to-peer.
This is honestly just a CDN — IPFS or a multi-endpoint mirror
would do the same job. Useful operational resilience, not a
cryptographic innovation.

Phase 2 (active browser attesters) would let user browsers
broadcast their own `T_INTENT_ATTEST` envelopes, densifying the
attestation graph beyond the worker set. The notional benefit is
"more independent attesters → harder to coordinate a censorship
attack across all of them." In practice, the worker-set-collusion
threat the phase addresses is rare and already largely mitigated
by phase 0's cross-check (an attacker would need to control all
of the trader's trusted workers, AND none of the user-attesters
in the same scope catches it). The implementation complexity
(Service Workers across browsers, ephemeral per-device key
rotation, sat-balance UX for broadcast fees) is high. Documented
here as a design exploration; not on the V1 path.

---

## Phase 0: Passive verifier (default opt-in)

The simplest role. Every tacit dapp instance maintains a small set
of subscribed workers (configured locally; default seeded by the
deployer) and fetches each worker's published intent-pool snapshot
for each scope the user cares about (typically: scopes containing
the user's own open intents, plus any pools/pairs they're actively
watching).

**Verification per worker per scope:**

1. Fetch the worker's `T_INTENT_ATTEST` envelope from chain (latest
   matching `(scope_id, worker_pubkey)`).
2. Fetch the worker's published `sorted_intent_ids[]` from
   `snapshot_uri`.
3. Verify `worker_sig`, freshness, hash-equality, and that the
   user's own `intent_id` (if any) is in the list — per SPEC.md
   §5.17 trader-side soft-confirm verification.

**Cross-worker consistency check:** when ≥ 2 workers attest to the
same scope at the same height, the dapp compares their published
intent sets. Any of these patterns is **soft-suspicious** (surfaced
in UI but not slashable):

- One worker's set is a strict subset of another's: the smaller-set
  worker is missing intents that the larger-set worker tracks.
  Could be benign (relay-latency lag) or could be censorship.
- The sets are disjoint or near-disjoint: the workers serve
  different trader populations, or one is misbehaving.
- One worker's set contains intent_ids that don't validate against
  the indexer's intent records: the worker is fabricating intents
  (extremely suspicious; possibly attempting a phishing surface).

The dapp's UX MUST surface:

- ✅ "Confirmed in N workers' attestations" (N ≥ 2 of the trusted
  set agree your intent is included).
- ⚠️ "Confirmed in only 1 of N trusted workers" (weak confirmation;
  re-fetch later or expand trusted set).
- ❌ "Not in any trusted worker's attestation" (worker_missing or
  relay failure; settlement may still happen but cryptographic
  accountability is degraded).
- 🔥 "Cross-worker inconsistency detected" (one or more workers
  disagree about intent membership; user should investigate before
  relying on soft-confirm for any high-value action).

**Cost:** CPU for SHA-256 over the published list (microseconds per
worker), bandwidth for fetching `sorted_intent_ids[]` (tens of KB
per worker per scope per epoch). **Zero chain footprint.** No
ephemeral key needed (verification is read-side only).

**Phase 0 is the default opt-in for the V1 dapp.** Users with the
dapp open are automatically passive verifiers for the scopes
relevant to them.

---

## Phase 1: Mesh relay (opt-in WebRTC snapshot distribution)

A subset of users who opt in to mesh-relay mode cache intent-pool
snapshots and serve them to other browsers via WebRTC. Reduces the
production dapp's reliance on the primary worker's `snapshot_uri`
endpoint.

**Mechanism (informative, not protocol-level):**

1. User opts in to mesh-relay mode (UI toggle: "Help distribute
   tacit channel data — uses bandwidth and storage, no chain cost
   and no signing").
2. The browser subscribes to a libp2p / WebRTC signaling room keyed
   by `scope_id`. Each room is a swarm of mesh-relay browsers
   caching the same scope's snapshots.
3. On observing a new `T_INTENT_ATTEST` envelope on chain, each
   relay browser fetches the corresponding snapshot from
   `snapshot_uri` (or from another mesh peer), caches it, and
   announces availability to the swarm.
4. Browsers that fail to fetch from the primary `snapshot_uri`
   request the snapshot from any mesh peer in the swarm.
5. Each fetched snapshot is verified against the chain-recorded
   `intent_pool_hash` before being trusted — the relay's role is
   only to deliver bytes, not to assert correctness.

**Trust model:**

- Mesh peers cannot serve forged snapshots — recipients verify
  against the chain-recorded hash before trust.
- Mesh peers cannot censor specific intents in the snapshot —
  serving a partial / modified snapshot would fail the hash check.
- Mesh peers can refuse to serve at all — in which case the
  recipient falls back to the next peer or the worker's
  `snapshot_uri`. No-op DoS at worst.

**Cost:** outbound bandwidth proportional to other peers' fetch
requests. Storage proportional to snapshot sizes the peer chooses
to cache (configurable; default: 24 hours of snapshots for each
subscribed scope). No chain footprint. No signing required.

**Phase 1 is a network-resilience layer.** Skipping it means the
dapp falls back to fetching directly from worker-published
`snapshot_uri`s — still functional, just less resilient to
worker-side outages.

---

## Phase 2: Active attester (heavier opt-in, chain cost)

A user opts in to becoming an **active channel attester**. Their
browser maintains its own view of the open intent pool by
subscribing to multiple workers + scanning the chain for relevant
intents, signs `T_INTENT_ATTEST` envelopes under an ephemeral
per-device pubkey, and broadcasts them on chain at a low cadence
(default: every 10 Bitcoin blocks per scope, configurable down to
1 block for high-stakes attestation).

**Why this densifies the channel graph.** Each active-attester
browser is just another worker from the protocol's perspective.
Multiple browser-attesters cross-validate the workers' views in
real time. If a worker silently drops intents, multiple
browser-attesters whose `intent_pool_hash` includes those intents
will visibly disagree with the worker's hash on chain — and the
divergence is permanent evidence.

**Ephemeral per-device pubkey (normative when implementing phase 2):**

The active-attester role MUST NOT reuse the user's main tacit
identity key for attestation. Each device generates its own
ephemeral attester pubkey, distinct from the user's trading key.
Reasons:

1. **Cross-device equivocation avoidance.** A user running the dapp
   on phone + laptop at slightly different latencies would otherwise
   produce two attestations under the same pubkey at the same
   `(scope_id, observed_height)` with different `intent_pool_hash`
   values — equivocation flag-set false positive. Per-device keys
   eliminate this.
2. **Reputation isolation.** A compromised or buggy device's
   attestation key can be rotated out without burning the user's
   trading identity.
3. **Privacy.** The user's attestation activity is not trivially
   linkable to their trading activity unless they choose to publish
   the binding.

**Off-chain delegation message (informative; lets observers verify
the device is acting on behalf of a known user):**

```
delegation_msg = SHA256(
    "tacit-mesh-delegation-v1"
    || user_main_pubkey(33)
    || device_attester_pubkey(33)
    || not_before_height_LE(4)
    || not_after_height_LE(4)
    || device_label_utf8(0..64)        # optional human-readable name
)
delegation_sig = BIP-340 sig under user_main_pubkey over delegation_msg
```

The device publishes `(device_attester_pubkey, delegation_msg,
delegation_sig, user_main_pubkey)` over the mesh (or over the
worker's relay) when it joins as an attester. Observers verify the
sig and treat the device as an authorized attester for the user
within the declared height window. The delegation is **purely
off-chain metadata** — the indexer doesn't consume it and doesn't
care; the only on-chain footprint is the `T_INTENT_ATTEST`
envelopes themselves (signed under `device_attester_pubkey`).

Devices MAY operate without a delegation (pure pseudo-anonymous
attester, identity unbound) — observers see a worker pubkey they
don't recognize, factor it into their trust accordingly.

**Operational gotchas:**

- **Chain footprint.** Each active-attester broadcasts on average
  one `T_INTENT_ATTEST` envelope (~210 B) per scope per chosen
  epoch cadence. Implementers SHOULD default to low cadence (10
  blocks) for browser attesters and surface the per-attestation
  sat cost in the opt-in UI before enabling.
- **Browser-throttling reality.** Modern browsers aggressively
  throttle background tabs. Active-attester mode SHOULD use a
  Service Worker (persists across tab focus changes), and SHOULD
  pause attestation if the user closes the browser entirely.
  Service Workers can broadcast over RPC endpoints + sign with
  IndexedDB-stored keys; no native-app capability required.
- **Equivocation flag-set self-protection.** A misconfigured
  active-attester could produce inconsistent attestations and flag
  its own ephemeral key. The dapp MUST surface "your attestation
  key has been flagged" and offer one-click rotation to a fresh
  ephemeral key, preserving phase-2 participation without
  re-establishing the user's trading identity.
- **Sat funding.** Active attesters need a small sat balance to
  pay broadcast fees. UX SHOULD surface "your attester balance is
  low — top up to keep attesting" with explicit numbers. Workers
  may optionally subsidize active-attester broadcasts as a public
  good (similar to AMM's `free_claims_when_treasury_above_sats`
  pattern), but no protocol-level subsidy mechanism is specified
  here.

**Cost summary:**

| Role | CPU | Bandwidth | Storage | Chain | Signing |
|---|---|---|---|---|---|
| Phase 0 (passive verifier) | tiny | small | none | none | none |
| Phase 1 (mesh relay) | small | medium | medium | none | none |
| Phase 2 (active attester) | small | medium | medium | ~210 B / scope / epoch | per attestation |

---

## What this amendment does NOT specify

- **On-chain delegation binding.** The amendment uses off-chain
  delegation messages; an on-chain `T_MESH_DELEGATION` opcode is
  out of scope (no compelling use case for V1).
- **Reputation scoring for ephemeral attester keys.** Trust-set
  curation is dapp-side policy; the amendment specifies no
  protocol-level reputation primitive.
- **Rate limiting at the indexer.** A user spamming attestations
  pays Bitcoin tx fees per envelope, which is the natural rate
  limit. Whether indexers add an explicit ceiling
  (e.g., max 1 attestation per `(scope_id, worker_pubkey)` per
  block) is a future amendment; default V1 has no ceiling.
- **Snapshot-fetch protocol details.** WebRTC signaling room
  naming, peer discovery, snapshot encoding, libp2p protocol
  identifiers — all dapp implementation choices, not protocol
  surface.
- **Mesh-side incentive layer.** Active-attester compensation
  (paid by traders for the soft-confirm UX, or by workers for
  outsourcing attestation work) is operational, not protocol.

---

## Test plan (informative — non-normative)

**Phase 0 (passive verifier):**

1. Dapp subscribes to 3 workers attesting to the same scope. All
   three publish identical sets; dapp surfaces "confirmed in 3 of
   3 workers."
2. One of three workers omits a specific intent. Dapp surfaces
   "confirmed in 2 of 3 workers (worker X is missing your
   intent)."
3. One of three workers publishes an inconsistent set (different
   `intent_pool_hash` for the same scope+height). Dapp surfaces
   "cross-worker inconsistency detected" — orange/red UX.
4. Worker `snapshot_uri` returns 404. Dapp falls back to other
   workers (or, with phase 1, the mesh).

**Phase 1 (mesh relay):**

5. Dapp opts in to mesh-relay mode for `scope_id = X`. Browser
   joins WebRTC signaling room. Cache 24 hours of snapshots.
6. Another browser fetches snapshot X from this relay successfully.
7. Verifying browser confirms snapshot hash matches chain.
8. Primary `snapshot_uri` goes offline; phase-1 browsers serve
   each other; no UX degradation.
9. Mesh peer disconnect/reconnect — cache state preserved across
   reconnect.

**Phase 2 (active attester):**

10. Dapp generates an ephemeral attester pubkey. Signs delegation
    message with user's main key. Publishes delegation to mesh.
11. Browser subscribes to chain + workers, maintains its own
    intent-pool view, signs `T_INTENT_ATTEST` every 10 blocks,
    broadcasts.
12. A different browser (active or passive verifier) observes the
    on-chain attestation, fetches the delegation message via mesh,
    confirms the ephemeral key is delegated by a recognised user.
13. Two devices for the same user (phone + laptop) generate
    distinct ephemeral keys; no cross-device equivocation.
14. Misconfigured browser publishes inconsistent attestations
    under its ephemeral key; flag-set marks the key; dapp prompts
    rotation; user generates fresh ephemeral key and resumes
    without re-publishing main-key delegation.
15. Phase-2 worker observes its ephemeral attestation key's sat
    balance falling below the configured threshold; dapp surfaces
    a "top up to continue attesting" prompt; balance restored;
    attestation resumes.

**Cross-phase end-to-end:**

16. User trader posts orderbook intent. Worker attests at block
    H. Phase-0 verifier on user device cross-checks vs 2 other
    workers; phase-1 mesh peer caches the snapshot; phase-2
    active attester independently attests at block H+10; all four
    attestation streams cross-validate. Equivocation evidence is
    null (no disagreement).

---

## Phasing recommendation (informative)

The three phases are NOT a commitment to ship all three. Honest
assessment after design review:

- **Phase 0 ships with the orderbook channel implementation.** ~1
  day of additional dapp work on top of the orderbook channel
  impl. Default-enable for all users. Real cryptographic value:
  detects selective worker censorship via cross-worker
  `intent_pool_hash` + set comparison. This is the actual
  deliverable.

- **Phase 1 is deferred indefinitely.** Reduces to "use a CDN
  or IPFS for snapshot redundancy" — useful operationally when
  worker `snapshot_uri` outages become a real problem, but not
  crypto-novel. Implement reactively when ops pressure calls
  for it; design can fold into the dapp's existing snapshot-
  fetch fallback logic without protocol-level changes. The
  WebRTC framing in this amendment is one implementation choice
  among many (IPFS, multi-endpoint, S3 mirrors, etc.) — none
  are mandated.

- **Phase 2 is not on the V1 path and likely not on any path.**
  The marginal security gain over phase 0 (densifying the
  attestation graph past the worker set) doesn't justify the
  implementation complexity (Service Workers, ephemeral
  per-device key rotation, sat-balance UX for trader-paid
  broadcast fees). Documented here as a design exploration
  rather than a planned deliverable, so the team has thought
  through the option but doesn't commit to building it. Revisit
  only if real operational data shows phase 0's cross-worker
  check is insufficient against observed attacks.

What "tacit mesh" actually delivers in V1, then, is phase 0:
trader browsers cross-validating multiple workers' channel
attestations and surfacing inconsistencies. Same cryptographic
substrate as certificate transparency for TLS — anyone can audit;
inconsistency is publicly visible evidence; the trust model
shifts from "trust one worker" to "trust the cross-check."

---

## Domain-tag additions

Add to SPEC.md §3 *BIP-340 domain tags*:

- `tacit-mesh-delegation-v1` — off-chain delegation message for
  binding an ephemeral attester pubkey to a user's main pubkey.
  Used in phase 2 only. Not consumed by the indexer.

No new opcodes. No new on-chain primitives. The mesh is entirely
built on top of the existing `T_INTENT_ATTEST` (`0x30`).

---

## Backwards-compatibility statement

This amendment is **purely additive at the dapp / worker /
network layer**. No protocol-level changes. Indexers do not need
updates; they already accept `T_INTENT_ATTEST` envelopes from any
pubkey at any cadence. Multi-worker attestation support has been
structural in `T_INTENT_ATTEST` since SPEC.md §5.17.

This amendment does NOT modify:
- Any opcode wire format
- Any indexer validator branch
- Any existing BIP-340 domain tag
- Any HMAC keystream domain
- Any cryptographic primitive

It DOES add:
- `tacit-mesh-delegation-v1` BIP-340 domain (off-chain only)
- Dapp UX for passive verification (phase 0), mesh relay (phase 1),
  and active attestation (phase 2)
- Operational conventions for ephemeral attester key generation
  and rotation
- WebRTC mesh protocol details (dapp implementation choice)

---

## Open questions for round-2 review

1. **Default phase-0 subscribed-worker count.** How many workers
   should the dapp subscribe to by default for cross-validation?
   3 seems like the right balance (enough redundancy for
   majority-correct heuristics, low bandwidth). Tunable per-user.

2. **Phase-2 active-attester wake-up cadence.** Default 10 blocks
   = ~100 minutes between broadcasts. Too high might miss
   short-window equivocations; too low burns sats unnecessarily.
   Empirical signet measurement under simulated equivocation
   attacks will inform.

3. **Service Worker reliability for background attestation.**
   Modern Service Workers can run with reasonable reliability when
   the browser is open, but get killed under low-memory pressure
   and after long inactivity. Worth measuring real-world wake-up
   rates before recommending Phase 2 as a primary deployment
   strategy vs a complementary one alongside dedicated workers.

4. **Mesh-relay incentive layer.** Should phase-1 mesh peers be
   compensated by phase-0/phase-2 fetchers? Pure-altruism mode
   works at small scale; a microtransaction layer (e.g., Lightning
   pay-per-MB) could scale better but adds operational complexity.
   Not blocking; punt to a future amendment if mesh-relay capacity
   becomes a real bottleneck.

---

## Sign-off checklist

**Phase 0 (the actual deliverable):**

- [ ] Round-1 peer review of phase 0 spec
- [ ] Reference dapp implementation, phase 0 (cross-worker
      attestation verification + UI surface)
- [ ] Signet rehearsal of phase 0 (test items 1–4 above)
- [ ] Production deployment alongside the orderbook channel
- [ ] Merge phase 0 into SPEC.md as §5.17.1 (Tacit mesh — passive
      cross-validation)

**Phases 1 + 2 are exploratory and not on the V1 path.** No sign-
off commitments. Sections preserved as design records; revisit if
operational data justifies the additional complexity.
