# Tacit — public-ramp review, gen5 live surface (Claude Opus 5, multi-agent)

**Date:** 2026-09-23 → 09-24 · **Branch:** `main`, starting at `c644d8b1` · **Posture:** gen5 has been live on
Ethereum mainnet since 2026-09-18 and exercised in production. This round asks the question the earlier
reviews deferred: is the whole running system — contracts, guests, services and client — ready to be opened to
a materially larger public, and is any of it worth redeploying before that happens?

One reviewer holding the thread, with nine delegated reviewers across two waves: four over the operational
surface (control-plane API, relay backbone, browser client, periphery contracts) and four over the deployed
guest Rust (settle ops, the shared `cxfer-core` crate, the Bitcoin↔Ethereum reflection lane, and the
nested-Groth16 / BabyJubJub / AMM surface). Every load-bearing claim in this report was re-derived from source
by the reviewer holding the thread before it was accepted; two delegated findings were refuted that way and are
recorded as refuted below.

## Verdict

**The immutable surface is sound as deployed. No redeploy.** Every finding in this round is in the operational
layer around it — services, client and configuration — and every one is fixable in place.

## The deployed code is the audited code

Earlier rounds compared the compiled artifact against a pin. This round compared the artifact against the
chain, which is a stronger statement and worth stating precisely:

- The pool's deployed runtime is **24,290 bytes and byte-identical** to the artifact compiled from this tree,
  once the twelve `ReflectionLib` link references and the nineteen immutable slots are normalised in both.
  Zero differing bytes.
- The library the pool delegatecalls, read from the link offsets baked into that runtime, is **byte-identical**
  to its own compile except for one twenty-byte run at offset 19 — the library's own address.
- All nineteen immutables hold the expected values, read straight out of the runtime: both verifying keys match
  `elf-vkey-pin.json`; the SP1 verifier, header relay, collateral engine, public AMM, canonical factory and
  tETH link id match the deployment manifest; the lineage steward is the ops multisig; reflection
  confirmations is 24. `CHAIN_BINDING` was independently re-derived as
  `keccak256(abi.encodePacked(uint256(1), pool))` and matches at both sites it appears.

Note that the verifying keys are `internal immutable` and have no getter — a `PROGRAM_VKEY()` call reverts.
They must be read from the bytecode. `tools/verify-live.mjs` now performs this whole check on demand against
live mainnet; `docs/VERIFY-LIVE.md` states what it does and does not establish.

One fact surfaced by that read and worth recording: **`PREDECESSOR` is the zero address.** This generation is
self-anchored rather than rebased from its predecessor, so `ReflectionLib`'s migration branch never executes
and the multi-generation rebase path is dormant here. Genesis comes from the compiled-in
`REFLECTION_GENESIS_DIGEST` that the guest checks.

## Guest review

Roughly 28,000 lines of deployed Rust, read line by line across four reviewers.

**No reachable inflation, double-spend, theft, cross-op re-typing or third-party halt was found**, in any of
the four slices. Recorded positively, because a negative result is only useful if its coverage is stated:

- **Conservation** reduces cleanly to `log_G H`, and `H` is verifiably nothing-up-my-sleeve — the derivation
  was recomputed and counter 1 reproduces the published generator exactly. All sixteen kernel call sites either
  range-prove every output or bind it by an opening sigma.
- **Nullifiers** are leaf-bound, and the leaf domains are disjoint by both distinct length and distinct tag.
  A note cannot carry two nullifiers: the native and Bitcoin-homed schemes meet at a single chokepoint that
  branches unambiguously.
- **Range proofs** dispatch between classic Bulletproofs and BP+ by a constant 97-byte length margin that
  cannot be confused, with commitments absorbed into the transcript before every challenge.
- **The indexed-Merkle accumulator avoids the classic insert bug** — a new leaf is verified against the
  post-rewire intermediate root, not the prior root — and non-membership cannot be forged for a present leaf.
- **The nested Groth16 verifier** checks against a ceremony key that is pinned and never read from the witness;
  the key blob's hash was verified independently, all 124 IC points are on-curve, canonical and non-zero, and
  the G2 elements are subgroup-checked. The public signals are re-derived from the same fields the guest then
  acts on rather than re-read from a witness.
- **The bridge** authorises every mint by proof rather than assertion, in all three directions, and the prior
  provenance-shortcut finding is closed at two independent layers. `overflow-checks` is on in release, which
  makes the arithmetic class structurally dead.

Two places in the settle guest are under-constrained on their own and are caught outside it. `OP_FARM_HARVEST`
lets the prover name the reward asset, which the immutable pool independently bounds against a funded per-farm
treasury, keyed off the guest-bound leg so a controller cannot evade it. `OP_CDP_MINT` admits an empty basket,
which every registered controller rejects; the pool does not, so that one rests on controller discipline. Both
belong on the next generation's list — bind the reward asset into the receipt leaf, and have the pool reject
the bare-payout shape itself — and neither is reachable today.

The next-generation list also carries several encodings that are correct by caller convention rather than by
construction: the conservation kernel and the intent context concatenate variable-length regions without
length prefixes, which is the same class a prior round already had to fix once elsewhere in the crate. Nothing
exploitable was constructible, but a discrete-log argument is a weaker guarantee than an injective encoding,
and these are three lines each to fix properly.

## Operational findings

All fixed and deployed unless stated.

- **An unauthenticated route could halt the Bitcoin→Ethereum lane permanently.** Burn-deposit provenance
  registration is open by design so a holder can register their own, but the stored bundle was structurally
  unvalidated and later dereferenced against every transaction in a scan range, with no isolation. Bundles are
  now validated at the door, the header walk is bounded, and an unusable bundle is skipped rather than
  propagating — which was already the correct semantics, since such a burn stays pending and completes in any
  later batch. First-writer-wins prevents one registration displacing another.
- **Two more places had the same shape, found in a follow-up pass — not yet deployed.** The reflection scanner
  classifies a transaction's type from its envelope structure alone, ahead of any signature or spend check, so
  a transaction that merely looks like a given op can still reach the code that folds it. Two spots let that
  reach an unguarded exception rather than a graceful skip: the batch assembler's own duplicate-refund check
  (detailed further down, under the stated batch tradeoff), and commitment decompression for ordinary
  confidential transfers, which fails to parse for a wide range of otherwise well-formed-looking input. Both
  now fall through to the same "not a real fold" path every other malformed case already takes, isolated to
  the one transaction rather than the whole scan.
- **Error text published to unauthenticated endpoints could carry endpoint URLs.** A viem exception embeds the
  request URL in its message and viem's own redaction covers basic-auth credentials only, never a
  path-embedded key. Heartbeat notes and job-ack errors now pass through a sanitiser.
- **Counter updates were not serialised.** Token buckets and daily budgets read, computed and wrote across an
  await, so concurrent callers all observed the same value. A keyed mutex makes a burst mean what it says;
  this matters because the daily caps are the only bound on prover spend from a permissionless route.
- **Signing keys and the control-plane token were scoped more widely than needed**, including onto a
  public-facing service with no use for them. Config now reads secrets lazily so a service that signs nothing
  needs no key, and the public service holds none.
- **The coverage endpoint integrators are told to gate on was effectively unreachable**, metered hard and
  uncached; it is now cached and shares the ordinary read bucket. An integrator who cannot reach that gate is
  one who broadcasts without it, and a premature Bitcoin-side mint is unrecoverable.
- **Monitoring covered one of three services** and derived its alert thresholds from a window that did not
  match the real one, producing a critical alert that recommended a destructive action before self-heal was
  due. All three are checked, thresholds derive from the configured window, and a new check watches for
  cross-outs that never fold.

## Client findings

The theme is uniform: several checks could not run and reported success rather than saying so.

- `settle()` dropped the settle transaction hash on the submit-dedup path, so a relay answering "already
  settled" skipped the emitted-memo comparison entirely — the one client-side defence against memo
  substitution, opt-out by the party it defends against. A stealth lock ships no note leaves and so bypassed
  that check completely, while carrying both the recipient's discovery material and the sender's refund key;
  it is now read back from the settle calldata and compared. An unreadable receipt now persists the sealed
  memos rather than dropping them.
- `crossOut()` reports whether its predicted claim id was corroborated against the real event, and the
  completion helper refuses to broadcast without it. A predicted-but-wrong claim id can never fold, and fails
  exactly as quietly as broadcasting too early.
- **Bitcoin-lane AMM refunds need a fresh key.** A refund commits the spent input's commitment verbatim, and a
  Bitcoin-homed note's leaf carries no outpoint, so refunding to a key one of the inputs was homed at
  reproduces the nullifier just spent. `assertFreshRefundKey` existed and was tested at the time of this
  review, but was not yet called anywhere — this round confirmed it and closed the gap: the two builders that
  exist (`buildSwapVarEnvelopeSelfFulfill`, `buildSwapRouteEnvelopeSelfFulfill`) now derive a fresh, per-swap
  key before signing and call the guard as a second check. The guest only ever sees the key the transaction
  pays to, which is why this belongs in the builder. The batch lane has no builder yet, so there is nothing to
  wire the guard into there; see below for what the batch assembler's own rejection needed instead.
- **cBTC lock funding bypassed the asset-UTXO classifier**, because that module builds its own chain client;
  one guarded accessor now covers both the funding pick and the fee top-up.
- **The on-chain page loader trusted whichever RPC answered first** and executed the document it returned, on
  an origin that asks for the identity signature. It now requires two independent providers to agree and
  refuses on disagreement.
- **A non-canonical signature is now declined rather than hashed.** ECDSA is malleable in `s`, and a malleated
  signature recovers the same address while deriving a different, empty identity. Declining changes no existing
  identity — every compliant signer has produced canonical signatures since EIP-2 — and cannot split funds
  across two keys, which normalising unilaterally would risk while this derivation is shared with other apps.

## A stated tradeoff, confirmed enforced by default

The Bitcoin-lane swap batch publishes its net reserve deltas in the envelope, as cleartext `u64`. That is what
lets any indexer reproduce the pool's reserves from the chain alone, which is the property the whole
Bitcoin-side AMM rests on. The cost is that a batch of one has no anonymity set at all: with a single intent,
the net delta *is* that trade, readable straight off the transaction — no cryptographic work required. The
settle lane does not share this shape; `OP_SWAP_BLIND` proves the excess with a Schnorr proof of knowledge
instead.

This is a design consequence rather than a defect. `assertBatchAnonymitySet` is a builder-side helper meant
to refuse a single-intent batch unless the caller acknowledges it, but there is no batch builder in the
codebase yet for it to be called from — this round confirmed that directly rather than assuming the helper's
existence meant the property held. What actually enforces the minimum today sits a layer down: the relay
declines to process any Bitcoin-lane batch below a floor of two intents unless a pool explicitly opts in to
allow a solo one, and a live check found no pool that has. That default is what to preserve; the helper
becomes load-bearing only once a batch builder exists to call it. The fold itself is untouched —
`n_intents == 1` is consensus-valid and must stay that way.

## Refuted

Two delegated findings did not survive re-derivation, recorded so they are not raised again.

- The coverage gate was reported unsound on the grounds that a forward batch would silently drop a Bitcoin-side
  mint. `ReflectionLib`'s freshness gate makes a forward attest unlandable while any cross-out is outstanding,
  and all sixty-plus landed attests were decoded to confirm every one is Mode-B. The gate is sound; the
  condition it guards against is broadcasting before the Ethereum side has settled at all.
- `worker-src 'self' blob:` was reported as an unused script-execution surface. The grep behind it covered the
  application sources but not the vendored bundle, which does spawn a worker. The directive is load-bearing.

## Stated limits

- The guest review is a source review. `cargo` was unavailable, so no fixture was executed and no proof was
  regenerated in this round; the pinned suites were relied on for that.
- Verifying that a guest ELF derives its pinned verifying key is not something an on-chain read can establish.
  That binding is enforced at prove time and at deploy time, and was demonstrated reproducibly in an earlier
  round.
- Several safety properties in the reflection lane are emergent from gates in different files rather than
  asserted where they are consumed. Each was checked and holds; on an unpatchable program that indirectness is
  itself the residual risk, and the next generation should make those invariants local.
