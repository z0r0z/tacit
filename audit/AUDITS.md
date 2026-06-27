# Tacit — Security Audits

Tacit's confidential-pool + Bitcoin↔Ethereum cross-chain core was put through **multiple independent,
adversarial AI-model audits** (GPT-5.5 Pro and Claude Opus 4.8, Max mode) across several rounds before the code was
frozen for immutable deployment. Every report and a point-by-point maintainer response is committed in this
`audit/` directory and pinned to the exact commit reviewed, so anyone can trace a finding to the line of code
and to its resolution.

## Conclusive GPT-5.5 Pro audit (public transcript)

The final holistic readiness review, at commit `034308e`, is publicly readable in full:

**→ https://chatgpt.com/share/6a3d6968-5e2c-83ec-ad1b-535279feeccc** — GPT-5.5 Pro, full-scope, pre-lock.

Maintainer response: [`TACIT_FINANCE_FINAL_AUDIT_GPT55PRO-RESPONSE.md`](./TACIT_FINANCE_FINAL_AUDIT_GPT55PRO-RESPONSE.md).

A conclusive **Claude Opus 4.8 (Max mode)** pass ran the same full surface in parallel and returned the same verdict —
**lockable, no fund-critical and no High** — conditional only on the documented deploy-time gates. Response:
[`TACIT_FINANCE_FINAL_AUDIT_OPUS48-RESPONSE.md`](./TACIT_FINANCE_FINAL_AUDIT_OPUS48-RESPONSE.md).

## Follow-up hardening run — Opus 4.8 Ultracode (2026-06-27)

A later **multi-agent fan-out** pass (Claude **Opus 4.8, Ultracode** mode — parallel finder → adversarial
verifier → synthesizer workflows, ~75 sub-agents) re-audited the newest immutable work: the trustless
Bitcoin-lane farm (LP_BOND/HARVEST/UNBOND), cross-chain OTC/AMM/LP/farm parity, and the relay-fee surface.
It caught **two lock-blockers introduced by the in-flight farm work** (a receipt-spend authorization gap and
a resume-stream desync) plus several guest↔mirror parity gaps — all fixed and re-verified. Report, with the
findings table and a hand-off prompt for the next fresh-context round:

**→ [`AUDIT-2026-06-27-ultracode-opus48-farm-hardening.md`](./AUDIT-2026-06-27-ultracode-opus48-farm-hardening.md).**

## Greenlight pass round 1 — GPT-5.5 Pro (2026-06-27)

A pre-reprove pass over the frozen immutable surface, scoped to greenlight the re-prove + testnet
launch. Publicly readable in full:

**→ https://chatgpt.com/share/6a3fdedd-ac54-83ec-ada0-27b4a6d1875d** — GPT-5.5 Pro, immutable-surface, pre-reprove.

It caught **two real delegated-proving authorization gaps** — economically-meaningful witness fields not
bound into a per-op opening-sigma context: `rate_snapshot` in the CDP-mint family (a box could substitute a
stale snapshot to overcharge a borrower once a stability fee arms — High, dormant) and `rps_entry` in the
farm/LP-bond family (a box could future-date a receipt and grief yield — Medium). **Both fixed** (bound into
the guest contexts, JS mirrors + fixtures regenerated in lockstep). It also raised two non-issues we
dispositioned: the CDP-liquidation recipient binding (permissionless; the burned debt notes are the
liquidator's own) and the ETH-reflection storage-slot offset (false positive — the guest constants match the
compiled layout). Response, with all four dispositions:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE.md).**

## Greenlight pass round 2 — GPT-5.5 Pro (2026-06-27)

A second pre-reprove pass at commit `e90a1ba`, focused on the delegated-proving authorization seam, publicly
readable in full:

**→ https://chatgpt.com/share/6a3ff1d2-f85c-83ec-9e3a-60ab97fff599** — GPT-5.5 Pro, EVM farm + cross-lane.

It found **two real cross-component launch-blockers** in the EVM-lane farm receipt spends: harvest/unbond
omitted the Bitcoin spent-set nonmembership check on the cross-lane receipt nullifier (a cross-chain
double-spend path), and lacked the receipt-owner BIP-340 authorization the Bitcoin lane already requires (a
delegated box could capture the reward/principal). Both **fixed**, plus a Medium `LP_ADD` pool-identity
binding and a Low protocol-fee-recipient validation. Response, with all four dispositions:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2.md).**

## Greenlight pass round 3 — GPT-5.5 Pro (2026-06-28)

A third pre-reprove pass at commit `3b2ecfc`. It found **one fund-critical lock**: duplicate CDP position
leaves share one position nullifier, so spending one permanently locks the other's collateral — fixed
contract-side with a duplicate-leaf guard (no re-prove; the guest-pinned reflection slots are unchanged, and
the pool stays under the bytecode limit). Plus a Medium `OP_LP_BOND` pool-identity binding (mirroring the
round-2 `LP_ADD` fix, **fixed**), and a route path-binding flagged as by-design (the output opening binds the
exact `amount_out`, so the user gets what they authorized regardless of the relay's path). Response:

**→ [`TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-3.md`](./TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-3.md).**

## Rounds

| Round | Scope | Model(s) | Report + response |
|---|---|---|---|
| 1 | Confidential pool + EVM core | GPT-5.5 Pro · Opus 4.8 | `…CONFIDENTIAL_POOL_AUDIT_*` (+ `-RESPONSE`) |
| 2 | Bitcoin↔Ethereum cross-chain trust path | GPT-5.5 Pro · Opus 4.8 | `…CROSSCHAIN_*` (+ `-RESPONSE`) |
| 3 | Full immutable surface (new ops) | GPT-5.5 Pro | `…FULL_AUDIT_GPT55PRO-…-RESPONSE` |
| Final | Holistic production-readiness @ `034308e` | GPT-5.5 Pro + Opus 4.8 (conclusive) | this page + `…FINAL_AUDIT_{GPT55PRO,OPUS48}-RESPONSE` |
| Hardening | Newest farm / cross-chain work (multi-agent) | Opus 4.8 Ultracode | `AUDIT-2026-06-27-ultracode-opus48-farm-hardening` |
| Greenlight 1 | Frozen immutable surface, pre-reprove @ `af73a2e` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE` |
| Greenlight 2 | EVM farm + cross-lane, pre-reprove @ `e90a1ba` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-2` |
| Greenlight 3 | CDP uniqueness + lp-bond, pre-reprove @ `3b2ecfc` | GPT-5.5 Pro | `TACIT_FINANCE_GREENLIGHT_AUDIT_GPT-RESPONSE-3` |

## Findings → what we did

Every finding across all rounds is **fixed, dispositioned as not-a-bug, or documented as a deploy-time
gate.** A summary (full reasoning + line citations in the per-round responses):

| Area | Finding | Resolution |
|---|---|---|
| Bitcoin data | Coinbase-witness envelope binding (the highest-severity item) | Fixed — coinbase is never an envelope source; commitment shape enforced |
| Bitcoin data | Duplicate-tail merkle alias; 64-byte stripped-txid guard | Fixed — checked merkle root; stripped-length guard |
| Wrap/send ops | Wrap-CDP-mint authorization could be reused across intents | Fixed — op-specific, intent-complete sigma context |
| Wrap/send ops | Transfer output owner not bound (delegated proving) | Fixed — output leaves bound into the conservation kernel |
| Wrap/send ops | Send-unwrap arithmetic hardening | Fixed — checked arithmetic |
| Batch path | In-guest Groth16 verifier validation | Validated — accepts real proofs, rejects forgeries (committed vector + test) |
| Collateral | Oracle/TWAP decimals; cBTC margin authority; farm funding | Fixed — bounds + authoritative pool reads + funding preflight |
| Router | Permit2 pull binding; relayed-settle fee handling | Fixed — bound to the exact transfer; fee-free relay enforced |
| Reflection | Source-domain anchoring; enable-ordering; storage-slot pinning | Deploy-gated (mainnet re-anchor) + CI layout assertion in place |
| Reflection (final) | Reported storage-slot drift | Not a bug — verified against the compiled layout; CI assertion confirms |
| CDP / farms (greenlight 1) | `rate_snapshot` (CDP mint) + `rps_entry` (bond) unbound in the opening-sigma context | Fixed — bound into the guest contexts so a delegated prover can't substitute them |
| Farms / cross-lane (greenlight 2) | EVM farm harvest/unbond missing the Bitcoin spent-set freshness gate + receipt-owner authorization | Fixed — cross-lane nonmembership check + BIP-340 owner sig on both spends (parity with the Bitcoin lane) |
| LP / swap (greenlight 2) | `LP_ADD` pool identity unbound (first-add fee-tier redirect); protocol-fee recipient not on-curve-validated | Fixed — bind `(lp_asset, pid)` into the lp-add context; reject an off-curve protocol-fee recipient |
| CDP / lp-bond (greenlight 3) | Duplicate CDP position leaves lock one position; `LP_BOND` pool identity unbound | Fixed — duplicate-leaf guard at insertion (contract-only); bind `(lp_asset, pid)` into the lp-bond context |

Confirmed sound by independent review (not exhaustive): the per-op conservation kernel and fee bounds, the
burn→mint provenance integrity, the cross-lane consumed-nullifier completeness with the on-chain freshness
gate, the cross-curve binding (with verified nothing-up-my-sleeve generators), the reserve floor, and the
encode↔decode trust boundary between the guest and the contracts.

## How verification works here

- **Reproducible:** each report pins the reviewed commit; findings cite `file:line`.
- **Mechanically gated:** a production-readiness gate (POOL / BRIDGE / DAY1 tiers) runs the full Solidity +
  guest + cross-impl suites, on-chain real-proof verification, a guest↔JS parity check, and a compiled
  storage-layout assertion — and is green across all tiers.
- **Trusted dependencies are scoped:** the SP1 Groth16 verifier and the Zellic-audited beacon light-client are
  treated as sound; the audits target the in-house logic around them.
