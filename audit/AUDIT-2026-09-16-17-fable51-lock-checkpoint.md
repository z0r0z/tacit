# Tacit — v1 lock checkpoint (Claude Fable 5.1 → Claude Opus 5)

**Dates:** 2026-09-16 → 2026-09-17 · **Scope:** the full v1 immutable surface — `ConfidentialPool.sol`,
`ReflectionLib.sol`, the collateral engine, periphery, and the settle + reflection SP1 guests — reviewed
adversarially, fixed, then re-audited by fresh reviewers with no knowledge of the original findings. This is the
review that gated the lock and deploy of the surface now live as gen5.

This page summarizes what two consecutive rounds collectively established and fixed. The full line-by-line
findings, evidence and reproduction steps are in the two source reports:
[`AUDIT-2026-09-16-fable51-v1-final-prelock`](./AUDIT-2026-09-16-fable51-v1-final-prelock.md) and
[`AUDIT-2026-09-17-closing-review`](./AUDIT-2026-09-17-closing-review.md), which supersedes the first round's
verdict.

## Why two rounds

The first round (2026-09-16) reviewed the surface as it stood, found and fixed a Critical in the reflection
guest plus a cluster of retirement-mechanism and guest↔JS parity defects, and called the tree lockable. A
second, independent pass the same day found one more Medium. A follow-on closing review (2026-09-16 → 17) then
re-read the fixed tree from scratch and found a second Critical the first round had missed, in a different
part of the settle guest — which is why its verdict explicitly supersedes the first. That closing review's own
fixes were then re-audited by three fresh reviewers with no knowledge of the original findings' reasoning, who
found the fix batch sound.

## What was found and fixed, across both rounds

- **Two Critical findings, both fixed before deploy.** A burn-deposit provenance shortcut could let a note's
  owner onboard its value on Ethereum while the note stayed live and spendable on Bitcoin. A shared kernel
  transcript meant certain other operations' signed witnesses would also verify as a plain transfer, which a
  relay could have used to redirect a user's public amount to itself while burning the real operation's
  ability to ever settle. Both required no on-chain redeploy path once caught this early — both guests were
  rebuilt, re-proved and re-pinned before launch.
- **The cross-generation retirement mechanism was substantially redesigned**, not just patched: what began as
  a registry-backed handoff authenticated by inactivity (griefable, capturable, and blocking cross-generation
  Bitcoin exits and cBTC redemption paths) became the pool acting as the factory of its own successor, with
  the lineage authenticated by construction and no dependency on anyone's uptime to progress.
- **A recurring class of guest↔JS parity drift** — a JS mirror or dapp builder disagreeing with the guest's
  exact predicate — accounted for the majority of the remaining High and Medium findings across both rounds.
  Left alone, each was a way for one crafted or even accidental Bitcoin transaction to desynchronize the
  attester and halt reflection, or to destroy a trader's own input by mismatching what the guest expected.
  Each was closed by making the mirror match the guest's exact check; several fixture-based regression tests
  were added specifically to keep the two from drifting again.
- **The Bitcoin-side light client's trust anchor was given a rotation path** rather than pinning one committee
  forever, closing both a long-lived forgery surface and a liveness deadline the fixed anchor would otherwise
  have hit.
- **The collateral engine's owner-trust surface was narrowed**: escrow policy, enforcement module and feed
  changes now carry a notice window before they can take effect, instead of allowing same-block confiscation.
- Every fix was pinned by tests, and both rounds independently re-derived the guest vkeys locally and matched
  them against the pin before signing off.

## Recorded limitations, not code-fixed

A small number of items were deliberately left as documented tradeoffs rather than code changes, because a
correct fix needs a next-generation guest change or is already adequately mitigated client-side: memo
authentication is not bound into user authorization in-guest (client-side comparison and save ship instead);
cross-generation tETH escrow custody is per-generation until a future generation introduces shared custody;
liquidation surplus return is bounded by the loan-to-value cap rather than an in-guest owner-return path. Each
is described in full in the closing review's "Design decisions recorded, not code-fixed" section.

One item flagged as informational in the first round — a Bitcoin-lane refund reusing its input note's own key,
which yields a technically-valid but unreachable-via-fast-lane note — carried forward as builder guidance
rather than a guest fix. It was closed on 2026-09-24 for the two lanes that have real builders, in follow-up
work alongside [`AUDIT-2026-09-24-pashov-solidity-auditor-v4`](./AUDIT-2026-09-24-pashov-solidity-auditor-v4.md).

## Verdict

Both rounds' fixes were rebuilt, re-proved, re-pinned and re-tested before this surface was deployed. Live
since 2026-09-18 as gen5; see [`AUDITS.md`](./AUDITS.md) for the post-deploy reviews that verified the deployed
bytecode matches this audited source exactly.
