# Bounty requirements and submission gap checklist

Source: https://github.com/z0r0z/tacit/blob/main/docs/STUCK-TAC-BOUNTY.md (checked 2026-11-25).

| Bounty requirement | Current lab evidence | Status / remaining work |
|---|---|---|
| Choose one valid route (A desk, B daemon, C pricing, D design) | Option A: bounded Bitcoin-to-Bitcoin stuck-TAC desk | Proposed; upstream desk exists but is built, not running |
| One-page behavior and assumptions | bounty/bounty-entry-draft.md | Draft exists; tighten to one page before PR |
| Code and tests, offline where possible | Upstream simulated-chain desk tests; lab accounting model; Signet readiness guard | Offline CI green; no upstream implementation change submitted |
| Chain tests on fork or Signet | bounty/signet-e2e-runbook.md | Not done; Signet TAC asset mapping/inventory unavailable |
| Numerical provider holdings after N bridges | Draft example: 10,000 TAC start, 10 x 1,000 TAC bridges, five stuck, 1% desk haircut | Example present; verify executable model against text |
| Risks identified | Inventory, lineage, timeout/refund, reorg, replay/restart, pricing, key risk | Present |
| Explicit untested items | Draft and runbook list Signet, real proof, reorg, live mint, production liquidity | Present |
| No prohibited changes | Lab does not modify deployed contracts, pool, proof, VK, or compatibility | Satisfied by current lab; no upstream PR yet |
| No new dependencies / remote resources / minified code | Lab additions use Node built-ins; upstream lockfile installed as-is | Satisfied for lab additions |
| Safety floor / no central custody | Tracked inventory, explicit bounded fee, per-swap keys | Design requirements; production operator behavior not audited |
| Submission mechanism | PR to z0r0z/tacit titled 'stuck TAC: <your name>' | Not submitted; lab repo is not a fork |

## Exact upstream source pin

CI is pinned to upstream Tacit commit: e4bb9297880502d5b8a341383b0baf69eefff509.

The pin is immutable for repeatability. If upstream changes the desk or tests, update this SHA deliberately and rerun CI. A green result at a pinned revision does not imply later revisions were tested.

## Submission decision

Current evidence supports an option-A design/prototype entry, not a claim that a new production desk has been implemented or deployed. The most material remaining gap is the real chain path: Signet TAC asset/pool mapping, funded tracked test inventory, and an end-to-end Signet swap plus bridge review. Do not claim this gap is closed until that test is run.

## Pre-PR checklist

- [ ] Confirm the bounty is still open and reward terms unchanged.
- [ ] Get maintainer-confirmed Signet TAC asset ID, pool deployment, and funded test inventory.
- [ ] Run CI against the pinned upstream SHA and record the run URL.
- [ ] Re-run the integer accounting example and include exact assumptions.
- [ ] Keep the final explanation to one page and link evidence/runbook separately.
- [ ] Clearly label the entry as design/prototype if Signet remains unavailable.
- [ ] User reviews and submits the PR; no PR has been created by this lab.