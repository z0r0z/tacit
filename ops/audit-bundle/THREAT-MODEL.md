# Threat model — assets, actors, invariants

This states what the immutable surface must protect, who may attack it, and the security invariants each op is
required to uphold. It is an orientation for the reviewer, not a proof of correctness — verify every invariant
against the source. Where an invariant depends on an off-chain component (the reflection assembler) or an
operational posture rather than an on-chain control, that is called out explicitly.

## Assets at risk

- **Pool escrow (Ethereum).** The ERC20/ETH backing held by `ConfidentialPool` for every wrapped note. A break
  here lets an attacker withdraw more than they wrapped, or strand others' backing.
- **Canonical-token supply.** `CanonicalBridgedERC20` mint authority is gated by the pool's bridge-mint /
  crossOut / cmint paths. The invariant is one mint per burn/deposit, value carried verbatim; a break inflates a
  bridged asset from nothing.
- **CDP collateral & cUSD (`CollateralEngine`).** Collateral locked against minted cUSD, the cBTC escrow, and
  the insurance reserve. At risk: under-collateralized mint, equity theft on close/liquidate, escrow slash
  without the grace window, bad-debt socialization.
- **Farm treasuries (`FarmController` + reflection farm folds).** Escrow-funded plus inflationary reward
  budgets. At risk: over-harvest, receipt-ownership redirection, budget freeze, double-claim.
- **Bitcoin-lane note value.** Confidential notes carried in Bitcoin transactions and folded by the reflection
  guest. At risk: reflected-note inflation, receipt redirection, and — distinctly — permanent reflection halt,
  which strands every note that would have been folded after the halting transaction.
- **Liveness itself is an asset.** Because the pool and guests are un-pausable and un-upgradeable, a
  permissionless action that permanently freezes the pool, the bridge, or reflection is a fund-loss event with
  no recovery path. Skip-not-abort discipline in reflection exists to protect this.

## Actors

- **Rightful holder.** Knows a note's blinding `r` (and, for a Bitcoin-homed note, controls its `auth_key`).
  Should be the only party able to spend or redirect that note's value.
- **Coordinator / settler / relayer.** Relays proofs and Bitcoin transactions and collects the bound relay fee.
  Expected to be able to *carry* value but never to *redirect* it — cannot change a destination, recipient,
  price, or receipt owner, nor mint to itself. The open-bounty relay-fee model (fee → `msg.sender`) makes
  settles copyable by design; the invariant is that copying a settle changes only who earns the fee.
- **Malicious prover.** May produce a valid SP1 proof for any guest-permitted statement, and may supply
  arbitrary non-membership / provenance / tx witnesses. The contract must re-check every value-bearing gate
  (roots, pre-reserves, escrow, one-shot flags) rather than trust the guest, and reflection witnesses must fail
  *closed* (member/non-member verdict proven, not prover-asserted).
- **Cross-lane attacker.** Crafts raw and proof-backed transactions on both chains, aiming to make a note live
  on both, double-mint a burn across the fast-lane and burn-deposit paths, or collide a nullifier/burn identity
  across notes.
- **MEV / ordering adversary.** Controls transaction ordering, can front-run or reorder multi-op batches that
  interact through shared accumulators, and can copy a pending settle.
- **DAO owner of `CollateralEngine`.** A trusted-but-privileged role (expected timelock/multisig): sets oracle
  feeds and CDP parameters, drives cBTC-escrow enforcement and insurance-reserve draws. Bounded by the immutable
  `MIN_ESCROW_GRACE_WINDOW` floor so a locker always has a public, non-instant exit window. Evaluate what this
  role can do; the rest of the surface assumes no such role exists.

## Security invariants (what each op must uphold)

1. **Value conservation per op, per asset.** Every settle op and every reflection fold conserves value within
   each asset — the Schnorr/kernel proof over `ΣC_in − ΣC_out` binds `Σv_in = Σv_out`; AMM ops conserve against
   current reserves (constant-product, fee floor) with a refund floor rather than a declared-value payout;
   bridge mint/crossOut/cmint carry value verbatim from a single consumed burn/deposit. No path creates value
   from nothing or above what was backed.
2. **Authorization & destination binding.** Spend authority is knowledge of the blinding (and, on the Bitcoin
   lane, a BIP-340 signature under `auth_key`). Every output destination / recipient / receipt owner is bound
   in the signed message the guest reconstructs and verifies — a relayer or settler cannot redirect a transfer,
   a swap receipt/change, an LP receipt, a farm treasury/receipt, a bridge mint, or a router exit sweep.
3. **No cross-lane double-spend.** A note has exactly one nullifier over its full authenticated leaf; the
   fast-lane consume, the bridge burn set, and the reflection retirement are mutually consistent; burn-deposit
   proves non-membership against the consumed-outpoints IMT so a fast-lane-retired outpoint cannot also be
   onboarded. Nullifier/burn identities cannot collide across distinct notes.
4. **Skip-not-abort in reflection.** Any transaction-controlled or prover-controlled malformation must cause the
   affected fold to be SKIPPED (its input, already nullified in the general scan, self-strands its own
   initiator), never to abort the guest. An abort on canonical-block content is a permissionless, permanent
   reflection halt. A membership/non-membership witness, by contrast, must fail *closed* (prove the verdict; a
   lying/malformed witness aborts) so a prover cannot censor a valid fold.
5. **One funded generation per lineage.** An operational deployment invariant: exactly one live funded pool
   generation per asset lineage, so retired generations cannot re-mint. This is a posture, not an on-chain
   control — evaluate whether relying on it is safe.
6. **Contract independence from the prover.** On-chain gates (attested roots, pre-reserves, k-non-decrease,
   escrow accounting, one-shot flags, reentrancy guards) hold even against a malicious prover producing valid
   proofs. The contract does not trust the guest for value-bearing effects.
7. **Off-chain / on-chain fold parity (assembler mirror).** The reflection assembler (`dapp/confidential-pool.js`
   + `confidential-swapbatch.js` + `burn-deposit-bitcoin.js`) must apply *exactly* the same accept/skip verdict
   the guest applies, for every op. A gate the guest enforces but the assembler skips (or vice versa) diverges
   the digest chain and halts reflection at the first divergent transaction. This mirror is consensus-critical
   even though the assembler is mutable — see the execute-mode validation findings in
   `CHANGES-SINCE-LAST-ROUND.md`.

## Range-proof soundness

Hidden amounts are non-negative by Bulletproofs+ range proofs (a legacy classic-Bulletproofs verifier is also
accepted). Both verifiers must reject non-canonical scalar encodings identically (no proof malleability across
the two paths), and the sentinel / no-change edge cases must be handled uniformly by guest and assembler.

## Groth16 / vkey pinning

The settle and reflection guests are consumed on-chain via the constructor-burned `PROGRAM_VKEY` /
`BITCOIN_RELAY_VKEY`. The in-guest BN254 Groth16 verifier (`groth16.rs`) and the locked `amm_swap_batch`
ceremony key underpin `OP_SWAP_BLIND` (present in the vkey, shipped without a live emitter). Any conclusion
about the deployed system is conditional on the deployed vkey being that of the reviewed source; the pin/verify
mechanism is described in `PROMPT.md` and `BUILD-AND-VALIDATE.md`.
