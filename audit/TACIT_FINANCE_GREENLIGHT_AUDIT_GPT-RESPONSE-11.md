# Maintainer response — GPT greenlight audit, round 11 (bundle @ `bd83e5e`)

Eleventh pass — the re-confirmation round after round 10's reopened Critical. **Verdict: LOCK — 0
fund-critical findings.** The auditor specifically re-attacked the round-10 reflection fix (the one-tx
coinbase merge, the kept-coinbase `n_tx ≥ 2` merge against the witness commitment, duplicate-tail on both the
txid and wtxid trees, and honest-prover panic surfaces) and swept the whole system (relayer threat model, ETH
reflection recursion + Bitcoin consumed-root freshness, cBTC backing/escrow, in-guest authorization +
contract surfacing, conservation, identity) — and confirmed all of it holds. Two non-fund-critical
documentation/discipline items, both addressed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| Q-1 | A `nonwitness_tx_exact_len` comment still stated the disproven round-8 "foreign-block / zero-control" rationale | Low (comment only) | **Real (stale comment)** | **Fixed** |
| Q-2 | `verify_tx_witness_committed` uses `assert!` for a coinbase-downgrade reject | Informational | **Accepted (deliberate boundary)** | **Clarified** |

This is the clean confirmation we were waiting for — and unlike round 9's clean result (which was on code that
still contained the round-10 Critical), this one is on the **fixed** code with the fix itself stress-tested by
the auditor. The seven safety-confirmation rows (each a re-run exploit attempt that failed) are the substance
of this pass.

## Q-1 — stale reflection rationale — FIXED

The `nonwitness_tx_exact_len` doc still argued safety from "FOREIGN proof-of-work / the attacker has ZERO
control / if he mines himself there is no foreign tx to hide" — the exact mental model round 10's
miner-mined attack invalidated. The executable code is safe (the full-scan coinbase gate is the real defense),
so there is no current exploit, but the stale rationale is a maintenance hazard (it could lead someone to
weaken the real fix). **Fixed:** the comment now states that this parse only preserves liveness (admits a real
64-byte tx) and is explicitly NOT the soundness defense — the merge is blocked by the full-scan block-body
authentication (coinbase at `tx[0]`, no later coinbase, witness commitment, duplicate-tail-checked merkle).

## Q-2 — `assert!` in `verify_tx_witness_committed` — accepted (deliberate boundary), clarified

`verify_tx_witness_committed` asserts when a coinbase carries a BIP-141 commitment output but its
SegWit-committed witness is stripped (a prover downgrading a SegWit block to legacy to silently drop a
bridge-burn / cmint provenance envelope). The auditor confirms this is **not** fund-critical and **not** a
miner-forced stall: the block-level path uses `verify_witness_commitment` (which returns `Some(false)`), and
this per-tx helper only runs on **prover-supplied** provenance witnesses — a downgrade is tampering never
present in an honestly-supplied real coinbase, so the abort is a hard reject of that one malicious proof, not
reachable by an honest prover over a real block. The auditor's own guidance carves out "unless the panic is a
deliberate proof rejection boundary," which this is (it mirrors the block-level commitment panic). Converting
the `Option<()>` return to a typed reject would require restructuring the callers' `?`-propagated reject
semantics — net risk on a lock-eve Informational item — so we **clarified the comment** to mark it explicitly
as the deliberate, honest-prover-unreachable rejection boundary it is.

## Net
0 fund-critical; the round-10 fix and the whole-system surface re-confirmed by an auditor who specifically
re-ran the prior exploits. The two items were comment/discipline only (no functional change; cxfer-core
154/154 unchanged, no fixture/digest impact). **This is a clean LOCK verdict on the current code** — the
re-prove gate ("no fund-critical on the latest code, the fix itself stress-tested") is met.
