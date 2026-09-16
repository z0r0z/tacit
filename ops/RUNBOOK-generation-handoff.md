# Runbook — handing a ConfidentialPool lineage to its next generation

A generation is retired by creating its successor. Nothing else retires it, and nothing about the handoff is
a proof, a delay or a registry: the pool is the factory of its own successor, and the successor authenticates
its predecessor by having been created by it.

## What the mechanism guarantees

- `createNextGen(initCode, salt)` on the live generation, callable only by its immutable lineage steward
  (the ops multisig on mainnet), one-shot. It CREATE2-deploys the successor from the pool's own address and
  records it as `successor`. A successor lands at `keccak256(0xff ‖ predecessor ‖ salt ‖ keccak256(initCode))`,
  so a vanity address is mined against that formula.
- The successor's constructor accepts a predecessor only when `msg.sender` is that predecessor, and only with
  both reflected-genesis inputs (resume digest, genesis anchor) zero: its genesis is proven, never pinned.
- `successor != 0` is retirement. On the retired generation: wraps, public-AMM entry, swaps, liquidity adds,
  cBTC mints, new positions/bonds/draws, Bitcoin-homed spends and cross-outs are refused. Everything that
  releases value already inside stays open: unwraps, transfers, LP removes, position closes/top-ups/harvests,
  stealth/adaptor locks and their claims/refunds, bridge mints of burns that targeted this generation, and
  the deferred-effect drains. Its reflection (`attestBitcoinStateProven`) stays open too.
- The successor's FIRST attest is a rebase cycle: the proof carries `rebasedFromDigest` bound to the
  predecessor's attested digest + drained counters and continues from the matching tip. Two anchors are
  accepted: the predecessor's handoff record (`handoffReflectionDigest` / `handoffReflectionTip`, fixed at its
  first attest after retirement — a proof built against it stays valid however often the predecessor attests
  afterwards) or its live state (`attestedReflectionDigest` / `attestedReflectionTip`, for the freshest tip).
- What the steward can do: choose the successor's code. What it cannot do: touch escrow, freeze an exit,
  redirect a payout, or move the pointer twice.

## Sequence

1. Deploy the successor's periphery that it binds at construction (canonical factory if new, engine with
   `pool = 0`, public AMM, header relay reused). Predict the successor's address from the init code and salt.
2. Broadcast `CreateNextGen.s.sol` from the steward (`PREDECESSOR`, `SALT_NEXT_GEN`, the constructor env).
   The script asserts the predicted address and that the predecessor recorded it.
3. Wire the periphery: engine `setPool(successor)`, public AMM `initialize(successor)`, executor/outbox as
   for a genesis deploy. Point the dapp and the relay at the successor.
4. Reflection: attest the predecessor once after step 2 (this fixes its handoff record), then have the
   successor's relay lane produce the rebase cycle from that record (digest, counters, tip — all public
   getters) and submit it; a rebase from the predecessor's live state is accepted too. Ordinary cycles follow.
5. Keep the predecessor's reflection lane running for as long as value can still arrive there: any Bitcoin
   burn broadcast with the predecessor's chain binding before the dapp switched, and every cBTC lock
   registered on the predecessor whose redemption its engine must see (`claimEscrow`). The lane can pause
   and resume; it only has to stay within `REFLECTION_MAX_LAG` (2016 blocks) of the relay anchor, so revisit
   it at least every ~10 days until the predecessor's lock set is fully redeemed or slashed and no
   predecessor-bound burn can still be outstanding.
6. Users holding Bitcoin-homed notes need no action: the successor resumed the same reflected state. Users
   holding EVM notes on the predecessor exit them there (exits never close) and re-enter on the successor.

## Trust residue, stated plainly

The steward key names the successor's code; users are never obliged to use a successor, and a steward that
retires a generation prematurely costs users nothing but the trip out and back in. A generation deployed with
a zero steward can never be retired; a lineage whose steward is lost ends at that generation, and a fresh
genesis lineage can be started at any time.

## Token continuity across generations

Each generation mints its own canonical ERC20s (`CanonicalBridgedERC20.MINTER` is immutable and in the CREATE2
salt), so a retired generation's public tacBTC / TAC / bridged tokens are not the successor's. They can always
re-enter the generation that minted them (`wrap` of a pool-minted asset stays open after retirement), but a
retired generation refuses cross-outs, so those tokens have no path to Bitcoin or to the successor on their own.
Continuity is a trust decision made at migration time, never a standing lever, and it belongs in the SUCCESSOR's
code:

- Do NOT give the successor mint authority over the predecessor's tokens (a lineage-aware minter). The steward
  names the successor's code, so that would let a steward dilute existing holders through whatever it names, and
  would import a compromised predecessor's supply straight into the successor's shared asset.
- If the predecessor is being retired sound (a routine upgrade), the successor may ADOPT its tokens one way: at
  construction, for each shared id it registers, record `PREDECESSOR.canonicalTokenFor(sharedId)` as an adopted
  underlying, and offer a wrap that pulls that token into the successor (retired there for good — the successor
  cannot mint it, so it is never released) and records a deposit under the shared id with the same value binding
  as an ordinary wrap. The settle guest consumes such a deposit unchanged. Supply is conserved: the old token
  leaves circulation as the new note is created.
- If the predecessor is being retired because its guest or vkey is suspect, do not adopt; its holders exit on the
  predecessor and re-enter through assets whose backing is exogenous (native ETH, external ERC20s), or through
  Bitcoin for value that was already Bitcoin-homed.
- tacUSD is generation-bound by nature (it is one engine's debt asset) and is never adopted: positions are closed
  on the predecessor (which is why its `wrap` of tacUSD stays open) and reopened on the successor.
