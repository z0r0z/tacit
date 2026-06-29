# Maintainer response — GPT greenlight audit, round 20 (bundle @ `586f931`)

Twentieth pass. One fund-impacting **High** — a continuation of the prover-supplied-witness class the prior
rounds chased — plus one **Low** hygiene item. Both fixed on the immutable surface. The auditor re-confirmed the
round-18 fixes and the round-19 hardenings with no regression, and found no other fund-impacting issue.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| 1 | Burn-deposit note opening still prover-discretionary → real burn censored | High (lock/loss) | **Real** | **Fixed** (`5e8b466`) |
| 2 | Stale append-tree cross-out membership helper + test | Low | **Real** | **Fixed** (`e980327`) |

## #1 — burn-deposit opening bound to the authenticated provenance — FIXED

Round 18 bound the burn-deposit *provenance* to the burn tx's witness, but the burned note opening
`(burned_cx, burned_cy)` remained a prover input, checked only by `nullifier(cx,cy) == env_nu` and by hashing
to a value the DAG had to contain. A malicious prover scanning a block with a real burn-deposit could supply a
**wrong opening** → both checks fail → `verified = None` → the tx is skipped, the digest advances past the
Bitcoin block, and the confirmed burn can never be re-folded → the deposit is permanently unmintable on
Ethereum. The auditor's analysis is correct; this is the same skip-controlling-prover-witness class as F-02/F-03.

The discretion is removed by deriving the binding from the authenticated DAG rather than the prover:
`verify_provenance_dag_leaves` now **returns the commitment hash the provenance DAG reaches at the burned
outpoint** (the DAG is the burn tx's wtxid-authenticated witness, so a prover can't alter it). `reflect.rs`
then:
- if the outpoint is **not reachable** from supply → `verify_provenance_leaves` returns `Err` → **skip** (a
  genuinely fake/unreachable burn — deterministic, identical for every prover);
- if it **is** reachable → **assert** `commitment_hash(burned_cx, burned_cy) == real_ch`. A prover that supplies
  a wrong opening for a confirmed burn now **aborts** (it cannot both drop the burn and advance the chain), so
  the honest fold is the only way to produce a valid proof;
- the envelope-ν consistency (`nullifier == env_nu`) remains a **skip** (a malformed on-chain burn is a
  tx-validity fact, deterministic once the opening is forced to the authenticated commitment).

This is **guest-only**: the honest worker already supplies the real opening, so no serializer/JS/fixture change,
and a valid burn folds identically (the digest is unchanged — the assert simply passes for honest inputs). The
`verify_provenance_dag_leaves` return-hash behaviour is unit-tested in cxfer-core; the single-leaf
`verify_provenance_dag` wrapper keeps its `bool` API (comparing the returned hash) so its existing KATs are
unchanged.

## #2 — stale append-tree cross-out helper/test — FIXED

`eth_crossout_member` (the legacy keccak-append membership helper) had no live caller after the round-18 IMT
conversion — only the `accumulator_membership_round_trips` test exercised it. Removed both, and refreshed the
module doc to reference `eth_crossout_imt`. The IMT membership/non-membership path is covered by
`fold_crossout_gates_on_eth_set_membership` in `cxfer-core/src/lib.rs` (member-fold / fake-skip / replay-no-op /
censorship-abort / forward-skip).

## Verification
cxfer-core 154/154 (one test removed with its helper); all three guests build; the reflection ELF rebuilds from
current source. The pool is unchanged (no contract change this round — stays 24,566 / +10 under EIP-170). The
guest↔JS DIGEST gate, run against a freshly-built ELF, passes the cross-out IMT fixtures (`reflection_crossout`,
`reflection_modeb`) — the worker cross-out mirror is in lockstep with the IMT guest. The `reflection_burn_deposit`
fixture remains red pending the dapp burn-deposit **witness-serialization mirror** + fixture regen (the F-03
worker-side mirror, non-consensus; the guest is authoritative).

## Net
The burn-deposit opening censorship is closed on the immutable surface, the Low is cleaned, and the round-18/19
fixes are re-confirmed with no regression. Remaining to a lock: the F-03 worker burn-deposit mirror (re-greens
the last gate fixture) and the mainnet `ETH_GENESIS_*` / `ETH_REFLECTION_VKEY` re-anchor (deploy-time; the
immutable vkey binds the chain).
