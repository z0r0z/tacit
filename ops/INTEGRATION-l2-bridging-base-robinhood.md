# Integration handoff: confidential-pool exit → Base and Robinhood Chain (Arbitrum Orbit)

Status: engineering handoff. Everything below was built AND live-tested against mainnet on
2026-09-05 with real ETH on both target chains — this is not a design sketch, it's a working,
proven path with tx hashes to check. Addresses re-verified live immediately before writing this
doc. Do not copy any address into long-lived config without re-checking this repo at
integration time (this suite has redeployed before).

**Prerequisite**: this doc assumes you've already read
`ops/INTEGRATION-simple-wrap-send-claim-eth.md` for the base wrap/send/claim/unwrap mechanics,
the native-ETH asset-id gotcha (§2a there), and the local-vs-relay proving options. This doc
covers only what's specific to exiting a shielded note into an L2 — Base and Robinhood Chain —
and does not repeat that ground.

## 1. The flow, in plain English

A shielded note exits atomically into a canonical L2 bridge: **unwrap → a recipe-bound,
one-shot escrow contract → the escrow's single call is the L2 bridge's own deposit function.**
No new contract is deployed for this feature — both Base (OP-Stack) and Robinhood Chain
(Arbitrum Orbit) already have their own trustless, audited canonical bridges; the only new code
here is the client-side recipe construction and a JS calldata builder per bridge type. The
on-chain machinery (`ConfidentialRouter.exitAndExecute` / `activateExit` / `reclaimExit` /
`escrowAddressFor`) is generic and already lives on the immutable mainnet router — nothing was
added to Solidity for this feature.

```
unwrap(note, recipient = escrow) → escrow deployed & funded → escrow calls the L2 bridge → L2 credit
```

## 2. Contracts in use (mainnet, re-verified 2026-09-05)

```
pool                = 0x0000000000047DD77CeCEfE5Dc015EB7bFa9C677
router              = 0x000000004c5BF191225F9049b385d6F3820E09BC
router.executorImpl = 0x3f202d64F58DAf07380a06E8A874bb0036E9945E   (read live, never hardcode)
ETH assetId (shared) = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34

Base (OP-Stack, chain id 8453):
  L1StandardBridge  = 0x3154Cf16ccdb4C6d922629664174b904d80F2C35
  OTHER_BRIDGE()    = 0x4200000000000000000000000000000000000010  (the L2 predeploy — cross-check this)

Robinhood Chain (Arbitrum Orbit, chain id 4663):
  Inbox (deposits)  = 0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D
  Bridge            = 0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3   (Inbox.bridge() must match this)
  Outbox (withdraw) = 0xf0ce991ea4A0d2400A4Ab49b20ae333f6Dce3DE9
  L2 RPC            = https://rpc.mainnet.chain.robinhood.com
```

`router.executorImpl()` is part of the CREATE2 initcode hash that determines every escrow
address — read it live every time, never pin it. Same discipline for the bridge/inbox
cross-checks: `Base.OTHER_BRIDGE()` and `Robinhood.Inbox.bridge()` should be re-verified at
integration time, not trusted from this document alone.

## 3. Building the exit recipe

Both targets use the identical generic machinery from `dapp/confidential-router.js`:

- `escrowAddressFor(recipe)` (on-chain view) / `exitRecipeEscrow(executorImpl, recipe, router)`
  (local JS mirror, MUST be cross-checked against the on-chain view before building any proof —
  a mismatch means the proof would pay the wrong address)
- `exitAndExecuteCalldata` / `activateExitCalldata` / `reclaimExitCalldata`

The only thing that differs per target chain is which `ExitCall` goes into the recipe's single
`calls[]` entry:

**Base** — `buildBridgeExit`:
```js
const recipe = router.buildBridgeExit({
  exitedAsset: ETH_ASSET_ID,
  amount,            // wei — the FULL amount credited on L2, no prepaid overhead
  l2Recipient,
  chainId: 8453,
  finalRecipient,    // an L1 address, NOT l2Recipient — see gotcha #3 below
  deadline, nonce,
});
recipe.sweepTokens = ['0x0000000000000000000000000000000000000000']; // defensive residue sweep
recipe.minOuts = [0n];
```
L1→L2 credit lands in ~1–3 minutes, no separate "redeem" step.

**Robinhood Chain** — `buildArbitrumBridgeExit`:
```js
const recipe = router.buildArbitrumBridgeExit({
  exitedAsset: ETH_ASSET_ID,
  l2Recipient,
  chainId: 4663,
  inbox: '0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D',
  l2CallValue,          // what actually lands on L2 — LESS than the unwrapped amount, see below
  maxSubmissionCost,    // from Inbox.calculateRetryableSubmissionFee(dataLen=0, l1BaseFee*2)
  gasLimit,             // from Robinhood's NodeInterface.estimateRetryableTicket via eth_estimateGas
  maxFeePerGas,         // ~2x Robinhood Chain's own eth_gasPrice
  deadline, nonce,
});
```
Unlike Base, `msg.value` here must be `l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas`
— Arbitrum retryables prepay L2 execution gas out of the escrow. `l2CallValue` is therefore
smaller than the unwrapped amount by that overhead (typically ~0.00002–0.00005 ETH at normal
gas). Auto-redemption on Robinhood Chain took a few minutes in testing (budget up to ~10).

None of these three gas parameters should be guessed — see `scripts/confidential-exit-robinhood.mjs`'s
`quoteRetryableGas()` for the exact live-quoting sequence.

## 4. Three participant paths — all live-tested, on both chains

### Path A — self-submit (fully self-sufficient; user claims and sends in one atomic tx)

The user (or anyone holding the note's secret) proves the unwrap themselves (relay
`mode:'prove'`, or their own SP1 prover) and submits `exitAndExecute` directly:

```js
const built = ux.buildUnwrap({ note, walletPriv, recipient: escrow, selfSettle: true }); // fee = 0
const proven = await ux.relay.prove({ type: 'unwrap', op: built.op, memos: [] });
const calldata = router.exitAndExecuteCalldata({ publicValues: proven.publicValues, proof: proven.proof, memos: [], recipe });
// sign + send `calldata` to `router` from any funded EOA
```

**Gas**: this needs far more than a naive estimate — SP1 Groth16 verification + escrow clone
deploy + the bridge call + a residue sweep, all in one atomic tx. Confirmed live: 900k gas
reverted out-of-gas at 94% usage; 2,000,000 gas clears it comfortably on both chains. Always
dry-run via `eth_call` with a state override before spending a proof on this — see §6.

Nobody but the caller pays gas here — no dependency on any relay operator.

### Path B — relayed settle + separate permissionless `activate` (the privacy-preserving path)

This is the path that keeps the depositor's own key off the exit transaction entirely:

```js
// 1. Submit the unwrap to the relay — it proves AND settles, paying its own gas, collecting its fee.
await ux.unwrap({ note, walletPriv, recipient: escrow, feeOpts: { feeBps: 0n, minFee: await ux.quoteOpFee('cETH','unwrap') } });
// 2. ANYONE can now call activateExit(recipe) — permissionless, no proof needed — to fire the bridge call.
const data = router.activateExitCalldata(recipe);
// sign + send `data` to `router` from any funded EOA
```

**Fee-gate note**: the relay's fee is flat (gas-derived), not a percentage — see
`ux.quoteUnwrapFee`. For a small note this flat fee can be a large fraction of the note's
value; a well-behaved client should refuse (or warn loudly) when the fee exceeds ~3% of the
note, since an outlier fee is itself a privacy-defeating fingerprint. Confirmed live at 1.10%
on a 0.01 ETH note — comfortably clears the gate.

**Gas**: `activateExit` alone (no proof verification, since settle already happened) still
needs more than a naive guess — confirmed live: 400k reverted out-of-gas at 92% usage on Base;
800k (Base) / 1,000,000 (Robinhood) clears it. Cap the pre-flight `eth_call` dry-run at the
SAME gas limit the real tx will use — an uncapped `eth_call` succeeds regardless of the real
tx's limit and will silently miss this class of bug.

### Path C — "self claim": the end-user activates their own exit

Step 2 of Path B is permissionless by design — the end-user (not just an operator or relay) can
call `activateExit(recipe)` themselves once they see their escrow is funded, using any wallet
with a small amount of gas. This is the mechanism for a user who wants to complete their own
exit without waiting on an operator, while still getting the privacy benefit of a relay-settled
unwrap. `scripts/confidential-exit-{base,robinhood}.mjs status` shows escrow funding state and
whether `activate` is ready to call.

### Rescue path — `reclaimExit` (both chains, same mechanism)

After `recipe.deadline`, anyone can call `reclaimExitCalldata(recipe, extraTokens)` to sweep the
escrow's holdings to `finalRecipient` on L1 without running the batch — covers a bridge call
that becomes permanently unexecutable for any reason. No proof needed.

## 5. Running the relay (bootstrap mode — we operate this ourselves for now)

`worker/src/index.js` + `worker/src/confidential-settle.js` implement the relay. **Confirmed
live and responding correctly as of this doc** (2026-09-05):

```
$ curl https://api.tacit.finance/confidential/status?id=0xdead...
{"error":"unknown job"}                          # 404 — correct behavior for an unknown id

$ curl -X POST https://api.tacit.finance/confidential/submit -d '{"type":"bogus","op":{}}'
{"ok":false,"error":"submitJob: unknown type bogus"}   # 400 — correct input validation
```

Both endpoints are live, gated on `CONFIDENTIAL_SETTLE=1`, and validating input correctly — the
service is up and behaving as designed. `type` values relevant to this feature: `'wrap'`
(settles a pending deposit into a spendable note) and `'unwrap'` (the exit step in Path B
above). `mode: 'settle'` (default) proves and submits on-chain; `mode: 'prove'` returns the
proof for self-submission (Path A). No separate relay job type exists for `exitAndExecute` or
`activateExit` — those are always self-submitted by whoever wants to trigger them (see §4).

**Operationally, since we're running this to bootstrap**: the relay box needs to stay up and
funded to pay its own settle gas; it earns back the flat per-op fee from each settle it
performs. There's no automated "activator" service yet — Path B's step 2 (`activateExit`) is
currently triggered manually (via the ops scripts, or an equivalent client call) rather than by
a bot that watches for funded escrows and activates them automatically. That's the natural next
piece of infrastructure once this needs to run unattended at any volume — a `watch` mode that
scans for funded, un-activated escrows and calls `activateExit` on them for a small
self-funding fee, so users never have to complete their own exit manually.

## 6. Verification ladder — do this before spending a real proof

All zero-cost, all `eth_call`, confirmed to catch real bugs during development:

1. Live-pin checks: `router.executorImpl()`, `Base.OTHER_BRIDGE()`, `Robinhood.Inbox.bridge()`,
   `Robinhood` RPC's `eth_chainId == 4663`, `pool.assets(ETH_ASSET_ID)` registered with
   `underlying == 0x0`.
2. Escrow parity: local `exitRecipeEscrow(...)` MUST equal on-chain `escrowAddressFor(recipe)`.
   Abort on any mismatch — this is the single check that prevents proving a withdrawal to the
   wrong address.
3. State-override dry-run: `eth_call activateExitCalldata(recipe)` with
   `stateOverride = { [escrow]: { balance: <the exact amount the batch will need, in hex> } }`.
   A clean `"0x"` result means the whole batch (clone deploy, bridge call, sweep) will succeed
   against real state — cap the `gas` param at whatever the real tx will use (see §4's gas
   notes).
4. For Robinhood specifically: `eth_getCode` on `l2Recipient` — if it has L1 contract code
   (a smart wallet, an EIP-7702 delegation), Arbitrum will silently ALIAS both retryable refund
   addresses. **Confirmed live, both branches**: the main deposit (`l2CallValue`) is never
   affected either way, but any unused prepaid gas refunds to the aliased address (not
   trivially reachable) when the recipient has contract code, versus refunding directly to the
   recipient when it doesn't. Warn the user before proving if this check fires.

## 7. Privacy boundary (same as the base send/claim doc)

The exit amount, `l2Recipient`, and timing are all public on L1 the moment `activateExit`
lands. This is "shielded accumulation, then exit anywhere" — never present it as a private
cross-chain transfer. The privacy value comes entirely from the size of the pool's anonymity
set at the time of exit, not from anything in the exit mechanism itself. As of this writing the
pool has minimal real volume — treat any exit today as a functional test, not a privacy
demonstration, until real concurrent usage exists.

## 8. Reference implementations and further reading

- `dapp/confidential-router.js` — `buildBridgeExit` / `buildArbitrumBridgeExit` and all the
  calldata builders referenced above; this is the source of truth for the exact ABI encodings.
- `scripts/confidential-exit-base.mjs` / `scripts/confidential-exit-robinhood.mjs` — complete,
  live-tested CLI reference implementations (`plan / wrap / status / exit / activate / reclaim`
  subcommands) covering both Path A and Path B end to end. The most direct thing to adapt.
- `ops/DESIGN-confidential-base-exit.md` / `ops/DESIGN-confidential-robinhood-exit.md` — full
  design rationale, every gotcha found, and the exact live mainnet transaction hashes from
  testing (both the successes and the bugs that got fixed along the way).
- `tests/exit-recipe-escrow.test.mjs` — offline parity tests for every calldata builder;
  extend this when adding a new target chain's bridge builder.

## 9. Adding a new target chain

Every OP-Stack chain is a one-line addition to `OP_STACK_L1_BRIDGE` in
`dapp/confidential-router.js` (verify `OTHER_BRIDGE()` first). Every Arbitrum Orbit chain is a
one-line addition to `ARBITRUM_ORBIT_INBOX` (verify `Inbox.bridge()` first) — the
`buildArbitrumBridgeExit` machinery, the `eth_getCode` aliasing check, and the gas-quoting
sequence are all already chain-generic. Anything outside these two families (a different
rollup stack entirely) needs its own `buildXBridgeExit` following the same pattern: one
`ExitCall` in the recipe, whatever calldata that chain's canonical bridge needs, and — the one
question that must be answered before writing it — **does that bridge behave differently for a
contract caller than an EOA, and if so, does it revert (safe) or silently misdeliver
(dangerous, needs an explicit workaround like Arbitrum's)?**
