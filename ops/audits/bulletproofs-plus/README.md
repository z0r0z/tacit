# Bulletproofs+ audit bundle

Security / production-readiness audit of Tacit's Bulletproofs+ aggregated range
proof (the JS prover+verifier and the Rust SP1-guest verifier).

**Verdict: SOUND / production-safe** (2026-06-11). No CRITICAL/HIGH findings; no
soundness break, no completeness break, no consumer-side fail-open, no JS↔Rust
divergence. Full reasoning, 11-finding table, 13-property checklist, and the
Monero-match backbone are in the report.

## Contents (this folder)

| File | What it is |
|------|------------|
| `AUDIT-bulletproofs-plus-2026-06-11.md` | The audit report (verdict, findings BPP-1…11, resolutions, property checklist, coverage gaps). |
| `AUDIT-PROMPT-bulletproofs-plus.md` | The audit brief the review was run against. |
| `AUDIT-bulletproofs-plus-test-commands.md` | Test-invocation notes. |
| `poc-bpp-audit.mjs` | PoC harness (35/35): MSM-vs-naïve, out-of-range, boundary completeness, crafted malformations, binding, malleability. `node ops/audits/bulletproofs-plus/poc-bpp-audit.mjs` |
| `poc-soundness-edges.mjs` | Second PoC (11/11): independent soundness edges. `node ops/audits/bulletproofs-plus/poc-soundness-edges.mjs` |

## Landed as production artifacts (outside this folder)

The audit's actionable fixes were committed to the codebase, not kept here:

- `tests/bulletproofs-plus-msm.test.mjs` — Pippenger MSM cross-check (BPP-1).
- `tests/bulletproofs-plus-malformed-body.test.mjs` — crafted-body malformations (BPP-2).
- `scripts/bpp-differential-check.mjs` — regenerate-then-diff JS↔Rust differential (BPP-3).
- `dapp/bulletproofs-plus.js` — dead-code removal in the verifier (BPP-4).
- `dapp/tacit.js` — `bppEnabled()` soft-fork gate extended to `T_AXFER_BPP` / `T_AXFER_VAR_BPP` (BPP-9).

## Reproduce

```
# core proof system (each prints "N passed, M failed"; not node:test — run directly)
node tests/bulletproofs-plus-msm.test.mjs
node tests/bulletproofs-plus-malformed-body.test.mjs
node ops/audits/bulletproofs-plus/poc-bpp-audit.mjs
node ops/audits/bulletproofs-plus/poc-soundness-edges.mjs

# JS↔Rust differential (regenerates fixtures, runs the Rust verifier, restores)
node scripts/bpp-differential-check.mjs

# Rust consensus verifier suite
( cd contracts/sp1/confidential/cxfer-core && cargo test --release )
```
