# Security reviews

Tacit's immutable surface is the `ConfidentialPool` and `ReflectionLib` contracts, the three SP1 guest programs,
and the shared `cxfer-core` crate. Before and after deployment it went through repeated independent,
adversarial reviews by frontier models: GPT-5.5 Pro, Claude Opus 4.8, Claude Fable 5.1 and Claude Opus 5. Each
report pins the commit it reviewed and cites `file:line`. Every finding was fixed, dispositioned with reasoning,
or recorded as a stated limitation. Earlier working rounds, prompts and point responses remain in git history.

## Reports

| Date | Scope | Reviewer | Verdict | Report |
|---|---|---|---|---|
| 2026-06-23 | Confidential DeFi + bridge, first full pass | GPT-5.5 Pro | Findings fixed | [`AUDIT-2026-06-23-…`](./AUDIT-2026-06-23-tacit-v1-confidential-defi-bridge.md) |
| 2026-06-24 | Confidential pool | GPT-5.5 Pro | Findings fixed | [report](./TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_GPT55PRO_2026-06-24.md) · [response](./TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_GPT55PRO_2026-06-24-RESPONSE.md) |
| 2026-06-24 | Cross-chain reflection | GPT-5.5 Pro | Findings fixed | [report](./TACIT_FINANCE_CROSSCHAIN_REFLECTION_AUDIT_GPT55PRO_2026-06-24.md) · [response](./TACIT_FINANCE_CROSSCHAIN_REFLECTION_AUDIT_GPT55PRO_2026-06-24-RESPONSE.md) |
| 2026-06-24 | Privacy leakage | Claude Opus 4.8 | Findings fixed | [`AUDIT-2026-06-24-…`](./AUDIT-2026-06-24-confidential-privacy-leaks.md) |
| 2026-06-25 | Confidential pool | Claude Opus 4.8 | Findings fixed | [report](./TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_CLAUDE_OPUS_2026-06-25.md) |
| 2026-06-25 | Cross-chain trust path | Claude Opus 4.8 | Findings fixed | [report](./TACIT_FINANCE_CROSSCHAIN_AUDIT_CLAUDE_OPUS_2026-06-25.md) · [response](./TACIT_FINANCE_CROSSCHAIN_AUDIT_CLAUDE_OPUS_2026-06-25-RESPONSE.md) |
| 2026-06-25 | Contract surface, coalesced | multiple | Findings fixed | [`AUDIT-2026-06-25-…-coalesced`](./AUDIT-2026-06-25-v1-contract-surface-coalesced.md) · [bug hunt](./AUDIT-2026-06-25-v1-mainnet-bughunt.md) · [full-surface response](./TACIT_FINANCE_FULL_AUDIT_GPT55PRO_2026-06-25-RESPONSE.md) |
| 2026-06-26 | Holistic readiness | GPT-5.5 Pro · Opus 4.8 | No fund-critical | [GPT response](./TACIT_FINANCE_FINAL_AUDIT_GPT55PRO-RESPONSE.md) · [Opus response](./TACIT_FINANCE_FINAL_AUDIT_OPUS48-RESPONSE.md) · [public transcript](https://chatgpt.com/share/6a3d6968-5e2c-83ec-ad1b-535279feeccc) |
| 2026-06-27 | Farms + relay-fee hardening | Opus 4.8 (multi-agent) · Codex | Findings fixed | [Opus](./AUDIT-2026-06-27-ultracode-opus48-farm-hardening.md) · [Codex](./AUDIT-2026-06-27-codex-farm-hardening-findings.md) |
| 2026-06-27 → 07-03 | Frozen surface, 24 iterative greenlight rounds | GPT-5.5 Pro · Opus 4.8 | Clean lock | Folded into the later reports; per-round responses in git history |
| 2026-08-24 | Freeze-readiness scans | Opus 4.8 · Codex | Findings fixed | [Opus](./AUDIT-2026-08-24-opus48max-with-responses.md) · [Codex](./AUDIT-2026-08-24-codex-scan-with-responses.md) · [sign-off](./FREEZE-READINESS-SIGNOFF.md) · [engine trust boundary](./collateral-engine-trust-boundary.md) |
| 2026-09-16 | Pre-lock, whole immutable surface | Claude Fable 5.1 | Findings fixed | [`AUDIT-2026-09-16-…`](./AUDIT-2026-09-16-fable51-v1-final-prelock.md) |
| 2026-09-17 | Closing review + re-audit of fixes | Fable 5.1 → Opus 5 | Freeze, re-prove | [`AUDIT-2026-09-17-closing-review`](./AUDIT-2026-09-17-closing-review.md) |
| 2026-09-19 | Public release (post-deploy) | Claude Opus 5 | Clear to publish | [`AUDIT-2026-09-19-public-release-review`](./AUDIT-2026-09-19-public-release-review.md) |
| 2026-09-19 | cBTC / cUSD / CDP | Claude Opus 5 | Mechanism sound | [`AUDIT-2026-09-19-cbtc-cusd-cdp-review`](./AUDIT-2026-09-19-cbtc-cusd-cdp-review.md) |
| 2026-09-20 | Launch review (post-deploy) | Claude Opus 5 | Green-lit | [`AUDIT-2026-09-20-v1-launch-review`](./AUDIT-2026-09-20-v1-launch-review.md) |
| 2026-09-23 | Public ramp: whole live surface + guest Rust line by line | Claude Opus 5 (multi-agent) | Immutable surface sound, no redeploy | [`AUDIT-2026-09-23-public-ramp-review`](./AUDIT-2026-09-23-public-ramp-review.md) |

## What the post-deploy reviews established

- **The code reviewed is the code running.** The live pool's runtime bytecode matches a fresh local build byte for
  byte once link references and immutables are normalised. Both program vkeys and `CHAIN_BINDING` were read out of
  the deployed bytecode and match the pins.
- **The guests rebuild reproducibly.** All three SP1 ELFs rebuild byte for byte from source. See
  [`docs/REPRODUCIBLE-BUILDS.md`](../docs/REPRODUCIBLE-BUILDS.md).
- **Stated limitations**, recorded rather than hidden:
  - Reflection liveness depends on someone running the reflection prover. Ethereum-homed notes stay spendable
    regardless.
  - A Bitcoin reorg deeper than the reflection confirmation depth halts reflection by design.
  - Relayed settles can be front-run. This is the deliberate cost of a relayer-agnostic proof.
  - cBTC is economically secured, not custodially guaranteed.
  - cUSD's peg depends on an oracle.

## How verification works

- **Pinned:** every report names its commit, and `contracts/sp1/confidential/elf-vkey-pin.json` ties each guest
  ELF to its on-chain vkey.
- **Gated:** `contracts/sp1/confidential/readiness-gate.sh` and `verify-lockstep-pins.sh` run the Solidity, guest
  and cross-implementation suites, real-proof verification, guest↔JS parity and a compiled storage-layout
  assertion.
- **Scoped trust:** the SP1 Groth16 verifier and the sp1-helios light client are treated as sound. The reviews
  target the Tacit logic around them.
