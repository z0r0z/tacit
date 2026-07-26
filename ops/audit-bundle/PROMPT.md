# Tacit V1 — final independent security audit (for publication)

You are performing the **final, independent, adversarial security audit** of the **Tacit V1 immutable core**: a
shielded, cross-chain DeFi protocol spanning Ethereum and a Tacit Bitcoin asset layer. This bundle is the
complete immutable code surface — the SP1 zero-knowledge guests and the Solidity contracts — that will hold
real user funds. There is **no admin, no pause, no upgrade**; the SP1 program verifying key and the AMM
ceremony key are burned/locked at deployment. **Anything you miss ships permanently.**

**We intend to publish this review.** Your GO/NO-GO will be relied on by depositors, bridgers, LPs, and
integrators to commit real funds to an un-pausable, un-upgradeable contract. Treat it as final sign-off, not
interim feedback.

## What we are asking for

Your **independent professional judgment on whether this immutable surface is safe to deploy to hold real user
funds**, as a holistic pass over the *entire* surface — not a re-check of prior findings. Earlier review rounds
are closed and their findings are remediated (see `CHANGES-SINCE-LAST-ROUND.md`); that document exists only so
you do not waste effort re-deriving history. **Audit the code as if for the first time.** Do not anchor on the
changelog, the design docs, or any prior conclusion. Re-establish every fund-safety property yourself, against
the source in front of you.

We are not asking you to certify that no bugs exist — review establishes the presence of defects, not their
absence, and we do not want a statement no honest reviewer can make. We want your **reasoned GO / NO-GO**: the
defects you found, the properties you personally verified and how deeply, the surface you could not reach, and
your resulting judgment on fund-safety readiness. **Report everything you consider a real risk**, including
anything below we have framed as intentional or out of scope — if you judge it unsafe, say so; the framing is
context, not a boundary on what you may report. If the surface clears your bar, say so plainly and show the
basis. If it does not, the single most important defect is worth more than the verdict.

## Read order

`SYSTEM-OVERVIEW.md` (architecture + file map), then `DESIGN-unified-source-identity.md`,
`DESIGN-btc-note-authority.md`, `OP-REVIEW-CHECKLIST.md`, `DESIGN-NOTES.md` (intentional design postures), then
the source under `guest/` and `contracts/`. `CHANGES-SINCE-LAST-ROUND.md` is a focus aid only.

**Scope note:** `BitcoinLightRelay.sol` (`contracts/src/lib/`) is in scope — the reflection anchor and every
Bitcoin-derived property depend on it. The legacy denomination-pool mixer (`TacitBridgeMixer`, its
`SP1PoolRootVerifier` guest, and the standalone Groth16 verifier) is NOT part of the Tacit V1 confidential
surface and is out of scope.

## Scope — the entire protocol, both sides

Audit every part. Nothing is out of scope for correctness or fund-safety:

- **The confidential note model & accumulators** — Pedersen commitments, the bearer/kernel spend model, leaf &
  nullifier derivation, the note tree / spent-set IMT / UTXO IMT / consumed-outpoints IMT / bridge-burn set /
  lock set, range proofs, and every cryptographic primitive (`groth16.rs`, `babyjubjub.rs`, `bjj.rs`,
  `sigma.rs`, the circom circuits).
- **Every settle op** — wrap/unwrap, transfer, AMM swap (cleartext and prover-blind), route, LP add/remove/
  bond, OTC, BID, CDP mint/close/top-up/liquidate, farm init/bond/harvest/unbond/refund, stealth lock/claim/
  refund, adaptor lock/claim/refund, bridge mint/stealth-mint/burn, crossOut, cBTC lock/redeem, cmint,
  burn-deposit.
- **The two-way bridge & reflection** — the reflection guest's per-op folds, the Bitcoin tx/relay parsing
  (`bitcoin.rs`), witness-commitment and header-chain/PoW binding, the burn↔mint seam, the fast lane and
  Mode-B reverse reflection, the consumed-outpoints cross-lane double-mint gate, the provenance DAG for
  scan-free onboarding, and cross-generation/resume.
- **All contracts** — `ConfidentialPool`, `ConfidentialRouter`/`ExitExecutor`, `CollateralEngine`,
  `FarmController`, the canonical asset/minter/bridged-ERC20 factory, `BitcoinLightRelay`, `TacitRelayer`,
  `BtcCallExecutor`, `ChainlinkEthBtcAdapter`.
- **Composition** — multi-op batches where individually-sound ops interact through shared accumulators
  (nullifiers, leaves, lock leaves, pool reserves, consumed-source alignment) in an unenumerated order; MEV /
  ordering; and the guest↔contract split (what the proof enforces vs. what the contract re-checks).

## What matters most (the properties an authoritative audit must settle)

1. **No inflation / no unauthorized mint.** Per-asset conservation everywhere; no note, share, cUSD, cBTC,
   farm reward, or bridged asset can be created from nothing or above what was burned/deposited/backed.
2. **No theft / no unauthorized spend or redirection.** Only the rightful holder can spend or move value;
   destinations and recipients are bound; a delegated prover, relayer, searcher, or observer cannot redirect,
   substitute, or front-run value to themselves. Public openings (where they exist) must not become spend
   authority.
3. **No double-spend across lanes.** A note cannot be live-and-spent on both chains; the fast lane, bridge, and
   reflection retirement are consistent; nullifier/burn identities cannot collide across notes to enable theft,
   inflation, or permanent freeze.
4. **Solvency & backing.** Pool reserves, CDP collateralization, escrow accounting, farm budgets, and cBTC
   backing hold under every op and combination; nothing lets liabilities exceed assets.
5. **Functional integrity / no fund-stranding.** Users can always deposit, transact, and exit; no permissionless
   action can permanently strand, freeze, or brick a user's funds or the pool/bridge; liveness of the exit and
   rescue paths.
6. **Contract independence.** The on-chain gates (roots, pre-reserves, escrow, one-shot flags, reentrancy) hold
   even against a compromised/malicious prover — the contract must not simply trust the guest for value-bearing
   effects.

## Ground rules

- **Verify against code, not comments.** Comments and design docs describe intent; confirm the code matches.
  This applies to `CHANGES-SINCE-LAST-ROUND.md` too — a remediation is not correct because it is listed there.
- **Intentional postures are documented in `DESIGN-NOTES.md`** — the open-bounty relay-fee model (fee →
  `msg.sender`; settles are copyable), one-live-funded-generation as an operational invariant, DAO-governed
  `CollateralEngine` parameters, and the native-nullifier invariants (§3). These are recorded so you know they
  are deliberate, not to place them beyond reporting. Evaluate whether the code upholds them and whether they
  are safe; if you judge a posture to be a fund-safety risk (e.g. an unenforced operational invariant standing
  in for an on-chain control), report it — a published review should surface it as a disclosed risk, not omit
  it.
- **The reviewed guest ↔ deployed vkey binding.** The in-scope settle guest and reflection guest are the
  programs consumed on-chain via `ConfidentialPool`'s constructor-set `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY`.
  The binding mechanism is `pins/elf-vkey-pin.json` + `verify-vkey-pin.sh`: `sha256(ELF) == elf_sha256` and,
  where the SP1 toolchain is present, `vkey(ELF) == program_vkey`. The reviewed source in this bundle includes
  remediations that rotate the ELF/vkey (see `CHANGES`), so the pin's `program_vkey` reflects the *previous*
  generation and is informational; the definitive `sha256(ELF)==` / `vkey==` binding for **this** source is
  produced by the pending re-prove and published at deploy. Note explicitly in your review that your
  conclusions are conditional on the deployed vkey being that of the source you reviewed.
- **`OP_SWAP_BLIND` (op 31) and the in-guest BN254 Groth16 verifier are present in the vkey but ship without a
  live emitter.** They are a real part of the immutable surface — audit them for soundness. Their end-to-end
  guest-execution validation and any dapp/worker emitter are gated behind a separate step and are not armed by
  this bundle. Per-asset relay tips on that path are asserted fail-closed to zero. The `amm_swap_batch`
  circuit and its ceremony key are **locked**; you may audit the circuit's constraints and the in-guest
  verifier for soundness, but treat the ceremony/vkey as fixed (a circuit change is future work).
- **Bytecode/vkey reproducibility and guest↔dapp mirror parity are a separate build step** — this bundle is
  source. The pinned artifacts under `pins/` are informational and may be ahead of or behind any deployed
  instance. If a property depends on the compiled ELF/vkey or the off-chain mirror matching the source, say so;
  don't assume it, and don't treat it as a source defect.
- Assume an adversary with capital, MEV/ordering control, the ability to craft arbitrary (proof-backed and raw)
  transactions on both chains, and knowledge of any publicly-derivable value. Assume the prover may be
  malicious except where a real SP1 proof is required.

## Deliverable

A clear, publishable **GO / NO-GO** for deploying this immutable core to hold real user funds. Specifically:

- **Findings**, ranked by severity, each with: file:line, the broken invariant, a concrete attacker sequence
  with inputs, who loses funds (or how solvency/liveness breaks), and a minimal patch.
- A **feature-by-feature soundness statement** — for each op/surface (AMM incl. blind swap, OTC, BID, LP, CDP/
  cUSD, farms, transfers, wrap/unwrap, stealth, adaptor, the two-way bridge + fast lane + Mode-B, reflection +
  provenance, cBTC, the router exit path, and every contract) — whether you consider it sound, and why.
- An honest **coverage ledger**: what you examined and how deeply, what you did not reach, and your assessment
  of the residual known- and unknown-unknowns. Where you could not reach part of the surface, bound it
  explicitly rather than imply a soundness you did not establish — and if the depth achievable in one pass is
  not enough to support the judgment being asked, say that too.

State your **GO / NO-GO** and the basis for it. If it clears your bar, say so plainly. If it does not, give the
single most important thing to fix. Publish the coverage bounds alongside the verdict — a review that reached a
subset of the surface should say so, so no reader mistakes it for more than it is.
