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

## Rounds

| Round | Scope | Model(s) | Report + response |
|---|---|---|---|
| 1 | Confidential pool + EVM core | GPT-5.5 Pro · Opus 4.8 | `…CONFIDENTIAL_POOL_AUDIT_*` (+ `-RESPONSE`) |
| 2 | Bitcoin↔Ethereum cross-chain trust path | GPT-5.5 Pro · Opus 4.8 | `…CROSSCHAIN_*` (+ `-RESPONSE`) |
| 3 | Full immutable surface (new ops) | GPT-5.5 Pro | `…FULL_AUDIT_GPT55PRO-…-RESPONSE` |
| Final | Holistic production-readiness @ `034308e` | GPT-5.5 Pro + Opus 4.8 (conclusive) | this page + `…FINAL_AUDIT_{GPT55PRO,OPUS48}-RESPONSE` |

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
