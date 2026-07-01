# Maintainer response — GPT greenlight audit, round 21 (bundle @ `ec322d7`)

**Clean lock.** The twenty-first pass returned **no fund-impacting finding** (0 Critical / 0 High / 0 Medium /
0 Low) and **no regression** of any prior fix. The auditor confirmed the round-20 burn-deposit opening binding
is correct and swept the full prover-supplied-witness fold/skip class, the ETH-reflection set
completeness/currency, cross-chain conservation + one-mint-per-burn, cBTC composition, and the
relayer/router/BTC-call surfaces — all clean. The verdict is **lock at `ec322d7`, subject only to the
already-documented production re-prove/build checklist**.

| Class | Critical | High | Medium | Low | Info |
|-------|---------:|-----:|-------:|----:|-----:|
| Fund-impacting | 0 | 0 | 0 | 0 | 0 |
| Quality / defensive | 0 | 0 | 0 | 0 | 1 (deploy check) |

## Confirmed clean (the auditor's own sweep)
- **Round-20 burn-deposit opening** — the discretion is gone: `verify_provenance_dag_leaves` returns the
  commitment hash the authenticated DAG reaches at the burned outpoint, and the guest asserts the prover's
  `(burned_cx, burned_cy)` hashes to it. A real reachable burn with a wrong opening aborts the proof; a
  fake/unreachable burn skips; a valid burn folds identically.
- **Burn-deposit skip/abort split** — fake/unreachable/malformed-provenance → skip; reachable + wrong opening →
  abort; malformed envelope-ν → skip (a deterministic on-chain fact). A griefer can't post a fake burn that
  stalls the forward chain.
- **The whole confirmed-tx fold/skip class** — spent, burn, CXFER, cross-out IMT membership/non-membership,
  receipt, swap/batch, farm, cBTC: no branch decision is left to a free prover witness in a censoring way; bad
  deterministic witnesses abort, fakes skip without mutating value.
- **ETH-reflection sets complete + current**; **cross-chain conservation + one-mint-per-burn**; **cBTC
  lock/spend/redeem**; **relayer/router/BTC-call add no fund authority** — all confirmed, no regression.

## The one Info item — production re-prove/build checklist (not a code defect)
The auditor restated our documented deploy gate: the ETH light-client constants are the **Sepolia rehearsal**
anchor and must be re-anchored to the intended production chain (genesis / finalized checkpoint / sync
committee) in lockstep before the production re-prove, and the build profile frozen. The immutable
`ETH_REFLECTION_VKEY` binds the chain (a Sepolia-anchored proof can't verify under a mainnet vkey), so this is
an operational step, not a vulnerability. The CI gate they suggest (fail unless production ETH constants match
the intended chain, slot KATs pass, vkeys match the final ELFs, every runtime stays under EIP-170) is the right
shape for the re-prove.

## State of the surface at lock
All round-18/19/20 fixes are in; cxfer-core 154/154; all three guests build; the reflection ELF rebuilds from
current source; the guest↔JS DIGEST gate (against a freshly-built ELF) passes every fixture except
`reflection_burn_deposit` (the F-03 **worker** witness-serialization mirror + fixture regen — non-consensus,
the guest is authoritative) and `reflection_swapbatch` (box-gated ceremony zkey). `ConfidentialPool` stays
24,566 / 24,576 under EIP-170.

## Net
Twenty-one adversarial rounds drove the immutable surface to a clean lock verdict with no outstanding
fund-impacting finding. The path to the production lock is now purely operational: the worker F-03 burn-deposit
mirror (re-greens the last gate fixture) and the mainnet `ETH_GENESIS_*` / `ETH_REFLECTION_VKEY` re-anchor +
re-prove under a frozen build profile.
