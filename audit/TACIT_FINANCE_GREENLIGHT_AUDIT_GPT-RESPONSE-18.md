# Maintainer response — GPT greenlight audit, round 18 (bundle @ `fc96f7d`)

Eighteenth pass. Three fund-impacting findings (2 Critical, 1 High), all in the prover-supplied-witness
censorship class. F-01 and F-02 are fixed on the immutable surface; F-03's minimal immutable fix is locked and
landing next, with the worker/dapp (JS) mirrors following in parallel.

| ID | Title | Severity | Verdict | Disposition |
|----|-------|----------|---------|-------------|
| F-01 | Duplicate cross-out claimIds brick all future attestations | Critical (forward-stall) | **Real** | **Fixed** (`a2f17b8`) |
| F-02 | A bad cross-out membership path skips a confirmed 0x65 mint | High (censor) | **Real** | **Fixed — guest** (`4afa875`); worker mirror in progress |
| F-03 | A bad burn-deposit provenance witness skips a real burn | Critical (permanent lock) | **Real** | **Fixed — guest** (`f2976e8`); dapp mirror + fixtures in progress |

Mode-B (the ETH→BTC reverse bridge) is a day-1 V1 feature in this re-prove, so all three are fixed on the
immutable surface — none is deferred or gated.

## F-01 — duplicate-claimId attestation brick — FIXED

A single `OP_BRIDGE_BURN` with two identical destination commitments derives the same claimId (the ν + asset
are fixed for the op), which the enumerable cross-out log records twice, making the full-range eth-reflection
completeness proof unsatisfiable → all future attestations bricked. **Fixed:** the settle guest asserts the
destination commitments are distinct before emitting any `CrossOut`, so the on-chain log stays unique; no
contract bytecode added (pool stays 24,566 / +10).

## F-02 — cross-out membership skip — FIXED (guest)

The cross-out set was a keccak append-tree (membership-only), so a prover could supply a bad membership path
and a confirmed 0x65 mint would skip — the forward-only digest advances past it → censorship. **Fixed** by
making the cross-out set an Indexed-Merkle tree keyed by the cross-out leaf: the eth-reflection guest builds it
with `imt_insert_transition`, and `fold_crossout` requires, per 0x65, EITHER a membership proof (→ fold) OR a
non-membership proof (→ skip a fake). A real cross-out's leaf is deterministically present, so non-membership
is unprovable — a prover can no longer skip a real mint (it aborts); a fake 0x65 still skips via a valid
non-membership proof. The cross-cycle eth-reflection genesis now uses the IMT empty root. cxfer-core 154/154,
with a test covering member-fold / fake-skip / replay-no-op / censorship-abort / forward-skip; all three guests
build. The worker (`buildModeBBatch` + `foldCrossout`) and SP1-stdin serializer mirror + the
`reflection_crossout`/`reflection_modeb` fixture regeneration are in progress (the guest is authoritative; the
DIGEST gate re-greens once they land).

## F-03 — burn-deposit provenance — FIXED (guest, witness-bound)

The burn-deposit provenance is a CXFER DAG (up to 1024 BIP-141-authenticated txs). It was supplied
**discretionarily by the prover** from the proof's private input, so a malicious prover could supply a broken
DAG for a real (already-burned) note → it skips → permanent loss. (`verify_provenance_leaves` follows the DAG
deterministically by outpoint, so a broken DAG is indistinguishable from a genuinely fake burn — there is no
skip-vs-abort line, and a 32-byte commitment is unsound: a tx-creator-chosen commitment a fake burn can't
reproduce lets a griefer permanently stall the chain.)

**Fixed** by making the provenance **non-discretionary**: it now lives in the burn tx's **Taproot witness**
(appended after the 129-byte burn envelope inscription), committed by the burn tx's wtxid. The guest reads it
from the wtxid-authenticated witness (`verify_tx_witness_committed` on the burn tx — the same witness-merkle +
same-block coinbase path used for the etch `C_0`), then *verifies the actual provenance there* rather than
matching a commitment: a real burn's witness carries valid provenance → folds; a fake's carries an invalid one
→ skips (no stall); a prover cannot substitute it (that changes the burn txid). The provenance blob is a
length-prefixed serialization (`cxfer_core::burn_deposit::ProvenanceBlob`, round-trip tested) the dapp mirrors;
`parse_burn_envelope` reads the 129-byte envelope and the burn-deposit slices `env[129..]` as the blob. The
guest's burn-deposit no longer reads provenance from stdin — only the burn tx's witness-commitment proof.
cxfer-core 155/155 (incl. the blob round-trip + truncation/trailing-byte rejection); all three guests build.
The dapp burn-deposit builder (serialize the blob into the witness) + the burn-deposit fixture regeneration are
the worker (JS) mirror — the guest is authoritative; the DIGEST gate's burn-deposit case re-greens once they
land.

## Verification
cxfer-core 154/154; the settle + reflection + eth-reflection guests build; the pool stays 24,566 / +10 under
EIP-170. The reflection DIGEST gate re-greens once the F-02 worker mirror + fixture regen land (the guest IMT
is authoritative + independently tested).

## Net
All three are now closed on the immutable surface (the consensus-authoritative guests + cxfer-core): F-01 (the
settle-guest distinct-destination check), F-02 (the cross-out indexed-Merkle membership/non-membership), and
F-03 (witness-bound burn-deposit provenance). The immutable surface is rebundled for the next confirmatory
audit. The worker (JS) mirrors — F-02's `buildModeBBatch`/`foldCrossout` and F-03's burn-deposit witness
serialization + fixture regeneration — are the remaining work and re-green the DIGEST gate; the guests are
authoritative and independently tested (cxfer-core 155/155).
