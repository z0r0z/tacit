# Maintainer response — GPT greenlight audit, round 18 (bundle @ `fc96f7d`)

Eighteenth pass. Three fund-impacting findings (2 Critical, 1 High), all in the prover-supplied-witness
censorship class. F-01 and F-02 are fixed on the immutable surface; F-03's minimal immutable fix is locked and
landing next, with the worker/dapp (JS) mirrors following in parallel.

| ID | Title | Severity | Verdict | Disposition |
|----|-------|----------|---------|-------------|
| F-01 | Duplicate cross-out claimIds brick all future attestations | Critical (forward-stall) | **Real** | **Fixed** (`a2f17b8`) |
| F-02 | A bad cross-out membership path skips a confirmed 0x65 mint | High (censor) | **Real** | **Fixed — guest** (`4afa875`); worker mirror in progress |
| F-03 | A bad burn-deposit provenance witness skips a real burn | Critical (permanent lock) | **Real** | **Design locked**, immutable fix landing; dapp mirror in progress |

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

## F-03 — burn-deposit provenance — design corrected to witness-bound

The burn-deposit provenance is a CXFER DAG (up to 1024 BIP-141-authenticated txs) supplied **discretionarily by
the prover** from the proof's private witness; a bad DAG → the real (already-burned) note skips → permanent
loss.

A minimal 32-byte "provenance digest in the burn envelope" fix was evaluated and **rejected as unsound**: the
guest cannot distinguish a malicious prover withholding a real burn's provenance (which must abort) from an
honest prover that cannot reproduce a fake burn's tx-creator-chosen commitment (which must skip), because the
lineage is off-chain and the commitment is set by the tx creator. Aborting on a digest mismatch lets a griefer
permanently stall the forward chain with a fake burn carrying a non-reproducible commitment; skipping is the
original censorship. No fixed-size commitment closes a prover-discretionary witness.

The sound fix makes the provenance **non-discretionary** by carrying the provenance DAG in the burn tx's
**Taproot witness** — committed by the burn tx's wtxid, which the guest already authenticates (the
witness-merkle + same-block coinbase commitment path it uses to authenticate the etch's `C_0`). The guest then
reads the provenance from the authenticated witness instead of from the proof's private stdin: a real burn's tx
carries valid provenance → folds; a fake's tx does not → skips; a prover cannot substitute the provenance
without changing the burn txid (which fails the block's txid-merkle). Scope: the burn-deposit tx format (dapp
builder embeds the DAG in the Taproot witness), the guest's burn-deposit read (from the wtxid-authenticated
witness rather than stdin), fixtures, re-prove.

## Verification
cxfer-core 154/154; the settle + reflection + eth-reflection guests build; the pool stays 24,566 / +10 under
EIP-170. The reflection DIGEST gate re-greens once the F-02 worker mirror + fixture regen land (the guest IMT
is authoritative + independently tested).

## Net
F-01 closed; F-02 closed on the immutable surface (the consensus-authoritative guest), worker mirror landing;
F-03's minimal immutable fix locked + landing. The immutable surface is rebundled for the next confirmatory
audit while the JS mirrors (F-02 worker + F-03 dapp) catch up in parallel.
