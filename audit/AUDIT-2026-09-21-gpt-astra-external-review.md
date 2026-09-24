# Tacit — external automated review and response, gen5 pre-launch

**Date reviewed:** 2026-09-21 · **Tool:** an external automated security scan run against the gen5 working tree
via OpenAI's Codex security-scan tooling (referred to internally as "GPT-Astra"; the tool does not self-report
an exact underlying model version). **External verdict:** BLOCK. **Our validation, same day:** gen5 stays
launchable — nothing found moves or steals funds. Five independent findings and a set of guide corrections;
each is dispositioned below with what we found on independent review.

The external scan itself notes real limits on its own coverage: it could not start the Node test suite in its
checkout (dependencies were absent), did not independently read back mainnet bytecode or prover identity, and
was not exhaustive across the repository. Our response below re-derived or reproduced every load-bearing claim
against source and, where applicable, against live chain and prover state.

## Disposition

| # | Finding (external) | Our finding |
|---|---|---|
| 1 | High — release integrity: the committed reflection-prover ELF appeared to be behind its source. | **Hygiene only, not a safety gap.** The scan's freshness check counted a directory the reflection prover does not compile as part of its source. The deployed vkeys match the pin and match on-chain; all three guest programs were independently rebuilt from the exact pinned commit and reproduce byte-for-byte. Fixed the gate's source-freshness check; re-pinned with a clarifying note. |
| 2 | Medium — memo substitution: user authorization does not bind the memo root, so a compromised relay could substitute a recovery memo. | **Real, but bounded to recoverability, not funds.** A substituted memo can make a note harder for its owner to find from chain + seed alone; it cannot redirect, inflate, or steal value — the underlying leaf and nullifier are unaffected. Binding memo hashes into user authorization would need a guest change, which is out of scope for this generation. Mitigated client-side: the dapp compares emitted memos against what it sealed and keeps a local copy on mismatch; the relay independently asserts the memo root before submitting. |
| 3 | Medium — a crafted memo could throw and abort a wallet's whole recovery scan. | **Real, fixed.** One malformed memo could stop a scan rather than being skipped. Memo parsing is now total: an unreadable memo is skipped, not fatal, across every scan path. |
| 4 | Medium — a settlement that both minted a note and settled a stealth lock in the same transaction could lose the lock. | **Real, fixed.** The scanner compared the combined memo count against a plain-note-shaped prefix, so this mixed shape was silently dropped. It now reads lock insertions directly and checks the reconstructed root and count, independent of memo layout. |
| 5 | Medium — concurrent submissions to the relay queue could race and leave a submission permanently stuck. | **Real, fixed.** A read-modify-write across an await let two concurrent submissions collide. Queue mutation is now serialized per key, with an orphan-requeue path for anything that still lands stuck. |
| — | Guide corrections (five items: an accessor's return shape, a claim about what the relay does and doesn't see, an admin-capability qualification, a claim about witness staleness, and a sample-code default that reused note material). | **All real, all corrected** in the integrator guide, plus one client-side fix (a fresh index by default instead of a reused one). |

## What this changed

Everything above marked "fixed" landed the same day. The one item that cannot be closed without a guest change
(memo substitution) is a recorded, documented limitation — bounded to recoverability, with a client-side and
relay-side mitigation in place — rather than an open risk to funds.

## Scope note

This was a targeted review of the live path described in the integrator guide, not an exhaustive pass over the
repository, and is complementary to the line-by-line adversarial reviews in the rest of this index — see
[`AUDITS.md`](./AUDITS.md).
