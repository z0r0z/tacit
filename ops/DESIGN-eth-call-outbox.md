# DESIGN — Ethereum→Bitcoin authenticated messages (`EthCallOutbox` + `T_ETH_CALL`)

Status: **built** (see `spec/amendments/SPEC-ETH-MESSAGE-AMENDMENT.md` for the as-built normative spec), scoped into the V1 launch reprove. The reverse of the Bitcoin-authorized Ethereum call
([`SPEC-BITCOIN-HOOK-AMENDMENT.md`](../spec/amendments/SPEC-BITCOIN-HOOK-AMENDMENT.md),
[`BtcCallExecutor.sol`](../contracts/src/BtcCallExecutor.sol)): an Ethereum party authorizes an
instruction that the Bitcoin-side Tacit metaprotocol honors, carried on the Mode-B reverse-reflection
channel that already moves value ETH→BTC. **No `ConfidentialPool` change** — the anchor is a new
periphery contract, and both guests change.

## The asymmetry that shapes the design

Bitcoin has no execution, so there is no reverse of `BtcCallExecutor` firing `onBitcoinReflect` into an
arbitrary target. The executor in this direction **is the reflection guest**, and its "targets" are
whatever handlers the guest implements. That has two consequences worth stating up front:

- **A message's effect is a consensus rule, not a contract call.** Adding a handler is a guest change +
  reprove, not a deploy. So the handler set must stay small and the day-one payload should be *data the
  metaprotocol records*, not *state it mutates*.
- **There is no blast-containment analogue.** The Ethereum side contains an arbitrary target inside an
  ephemeral escrow ([`DESIGN-exit-and-call.md`](./DESIGN-exit-and-call.md)); a bad handler here is in the
  liveness-critical path of the attest. This is why the delivery posture below is **pull**, not push.

## Why the existing cross-out channel cannot carry it

The obvious shortcut — a third `destChain` selector on `CrossOut`, with `destCommitment` repurposed as
`keccak(payload)` — does not work. `destCommitment` is **kernel-bound**: the settle guest hashes the
destination leaves into the conservation challenge and range-proves the matching output points
([`main.rs:804`](../contracts/sp1/confidential/src/main.rs#L804)), and the contract requires every
cross-out's nullifier to be spent in the same batch
([`ConfidentialPool.sol:2335`](../contracts/src/ConfidentialPool.sol#L2335)). A cross-out is a *value
leaf*, not a byte string. Arbitrary payloads need their own anchor.

## The anchor — a separate periphery contract

The eth-reflection guest already verifies a **`Vec<ContractStorage>`, each entry with its own address**,
against one finalized execution state root ([`main.rs:242`](../contracts/sp1/eth-reflection/src/main.rs#L242));
it simply filters to `ethr.pool` afterwards. Proving a second account is therefore a pinned address and a
second filter — no new proving machinery.

```solidity
contract EthCallOutbox {
    uint64  public msgCount;                        // slot 0 — enumeration cursor
    mapping(uint64  => bytes32) public msgAt;       // slot 1 — index => msgId
    mapping(bytes32 => bytes32) public msgRecord;   // slot 2 — msgId => recordHash

    event EthMessageSent(bytes32 indexed msgId, uint16 destChain, bytes32 indexed ns, address indexed sender, bytes payload);

    function send(uint16 destChain, bytes32 ns, bytes calldata payload) external returns (bytes32 msgId);
}
```

`recordHash = keccak(destChain ‖ ns ‖ sender ‖ keccak(payload))` and
`msgId = keccak(address(this) ‖ block.chainid ‖ recordHash ‖ msgCount)`.

This mirrors `pendingBtcCall`'s record exactly: the payload is committed by hash, and the Bitcoin envelope
re-supplies `(ns, sender, payload)` so the guest re-derives the record and can neither be redirected nor
have its calldata altered by whoever relays it. `address(this) ‖ chainid` in the `msgId` is the reverse of
`BtcCallExecutor` binding `address(this)` into its record — no cross-deployment replay.

**Authorization is `msg.sender`, carried verbatim.** It is the mirror of `callerPubkey`: a Bitcoin-side
handler gates on the Ethereum sender the way an `IBitcoinHook` target gates on the Bitcoin signer. This
means any Ethereum contract — including a DAO timelock or a pool-adjacent module — can be an authority
without new key material.

**No value, ever.** `recordHash` commits no amount, so none is authorized, and the outbox holds no balance
and no privilege anywhere. Same posture, same reasons as `BtcCallExecutor`.

## Delivery posture — pull, and deliberately NOT completeness-gated

The two existing reverse-lane sets sit at opposite ends and the choice between them is the main design
decision here:

| set | omission is | so the guest must |
|---|---|---|
| `crossOutCommitment` (value) | censorship of a confirmed mint | fold **all** — `count == onchain_crossOutCount`, IMT non-membership so a prover cannot claim-away a real one |
| `bitcoinConsumed` (fast-lane ν) | a **double-spend** | fold **all**, every cycle |

A message is neither. Omitting one means it simply does not apply — the sender re-sends, or anyone
supplies the witness. So the message set is a **plain append-only membership accumulator with no coverage
assert**: the guest proves a message is genuinely committed, and absence just means "skip."

That is not a weakening; it removes a brick vector the completeness-gated sets only survive because entry
is expensive. A cross-out costs a note burn plus settle gas. An outbox `send` is cheap, so a
completeness-gated message set would let anyone force unbounded per-cycle accumulator work on every future
reflection proof — a permanent liveness attack on the bridge. Membership-only makes spam cost the spammer
and cost the guest nothing.

`msgCount` is still surfaced (an audit cursor, and it keeps `msgAt` enumerable for indexers) but is **not**
asserted equal to the fold count.

## Bitcoin side — `T_ETH_CALL`, opcode `0x69`

`0x65`–`0x68` are taken (`T_CROSSOUT_MINT`, `T_CBTC_LOCK`, `T_CBTC_REDEEM`, `T_BTC_CALL`); `0x69` is free.

```
opcode(1)=0x69 ‖ msg_id(32) ‖ ns(32) ‖ sender(20) ‖ dest_chain(2 BE) ‖ payload_hash(32) ‖ payload_len(2 LE) ‖ payload(N)
```

Variable-length, so witness-carried like `T_BTC_CALL` rather than squeezed into an `OP_RETURN`. The guest:

1. re-derives `recordHash` and `leaf = keccak(msgId ‖ recordHash)`;
2. asserts `keccak(payload) == payload_hash` — the payload is bound, not merely asserted;
3. proves `leaf ∈ ethMsgSetRoot` (skip on absence — a fabricated `0x69` folds nothing);
4. asserts `dest_chain == DEST_CHAIN_BITCOIN`;
5. one-shot on `msgId` against a fired set in reflection state — the mirror of `BtcCallExecutor.fired`;
6. dispatches on `ns`.

Steps 1–5 are the transport and should be built and frozen once. Step 6 is where every future consensus
change lands.

### Day-one handler set: exactly one — and a free reprove does not change this

The argument for a minimal handler set was never about proving cost, so landing inside the launch reprove
does not relax it. A handler is a consensus rule sitting in the liveness path of the attest, with no
escrow-containment analogue on this side, honored under a sync-committee anchor rather than PoW. Those
three facts are unchanged by the reprove being free. Ship the transport complete; ship one handler.

`NS_ATTEST` — record the message and change nothing else. The metaprotocol gains an authenticated
Ethereum-origin datum at a known height; it mutates no note, no root, no registry. Every richer handler
(registry writes, parameter sets, Ethereum-authorized mints) is a separate proposal with its own review,
and none of them should ride the first deployment of the transport.

This is also what makes the channel useful to **third-party Bitcoin metaprotocols**: what is on offer is an
*attestation*, not enforcement. An indexer that does not run the SP1 stack can honor the same `0x69`
envelope by checking the Ethereum event over RPC at a confirmation depth, and upgrade later to verifying
the reflection proof — the mode-A/mode-B split already written down in
[`PLAN-crossout-consumer.md`](./PLAN-crossout-consumer.md), with the wallet flow unchanged across the
upgrade.

## Trust model

Inherited from Mode B, with nothing added: Ethereum sync-committee verification inside the eth-reflection
guest, weak-subjectivity anchored, finalized headers only, recursively verified under a pinned vkey by the
Bitcoin guest. Worth naming plainly, because it is **not** symmetric with the forward direction: BTC→ETH is
anchored by Bitcoin PoW verified in an immutable contract, ETH→BTC by a committee majority verified in a
guest. A message channel inherits that gap rather than widening it — but a handler that mutates value would
be exposing value to the weaker anchor, which is the second reason the day-one handler set is attestation
only.

## Diff surface

1. **`contracts/src/EthCallOutbox.sol`** — new, ~60 lines, no privileges, plus unit tests. `ConfidentialPool`
   needs no structural or ABI change, but binding the honored-message set into the resume digest DOES rotate
   its `REFLECTION_GENESIS_DIGEST` constant (to `0x943d3281…`) — a value rotation of the kind a reprove does
   routinely, not a migration, and free pre-launch.
2. **eth-reflection guest** — pin `ETH_OUTBOX`; filter outbox slots alongside `pool_slots`; a membership
   accumulator over message leaves; append `ethMsgSetRoot` + `ethMsgCount` to
   `EthReflectionPublicValues` (appending keeps the Bitcoin guest's by-offset reads valid — the pattern the
   fast-lane fields already used). ⇒ **new `ETH_REFLECTION_VKEY`.**
3. **Bitcoin reflection guest** — bump the pinned `ETH_REFLECTION_VKEY`; read the two new PV fields;
   `parse_eth_call_envelope` in [`bitcoin.rs`](../contracts/sp1/confidential/cxfer-core/src/bitcoin.rs)
   next to `parse_crossout_mint_envelope`; the fold + fired-set in
   [`reflect.rs`](../contracts/sp1/confidential/src/reflect.rs) next to the `0x65` arm.
4. **`reflect-stdin`** — witness plumbing for the message membership paths, mirroring the `0x65` arm.
5. **dapp + worker** — the `0x69` decoder + assembler mirror (NOT optional: the fail-loud
   `unsupportedEnvelopes` gate makes an unmirrored fold a one-transaction relay stall), the honored-set
   snapshot/restore, and `EthMessageSent` decode alongside `CrossOutRecorded` (`confidential-evm-log.js`).
6. **Fixtures / box vectors** for both guests.

### Why shipping this pre-launch is strictly cheaper than adding it later

Landing inside the V1 reprove removes the entire cost centre rather than amortising it. The fired set is new
reflection state, which post-launch would be a **resume-format consensus change with a live-state
migration**; at launch it is simply part of the genesis format and migrates nothing. There is no deployed
pool whose `BITCOIN_RELAY_VKEY` pin has to be rotated, no attestation gap to sequence around, and no users
holding notes across the change. The marginal cost over the reprove already happening is the guest code
itself.

The same reasoning says the *transport* should be complete and frozen at launch — parser, fold, fired set,
one-shot, membership gate — because that is the part which becomes expensive to revise. It does **not**
extend to the handler set: see below.

### The ordering constraint this creates (new, and it gates the ELF build)

The Bitcoin guest pins `ETH_OUTBOX`, so **the outbox address must be known before the eth-reflection ELF is
built** — which is before the reprove, which is before the launch deploy. CREATE3 is what makes that
possible at all: the address is a pure function of the salt and the deployer, independent of init code, so
it can be computed and pinned while the contract is still being written.

Concretely, the outbox salt joins the launch vanity-salt set
(`contracts/deployments/vanity-salts-*.env`) and the launch runbook gains a dependency: **salt fixed →
address pinned in both guests → ELF build → reprove → deploy**. Getting this backwards means rebuilding the
ELF and re-proving, so it belongs in [`RUNBOOK-launch-deploy-READY.md`](./RUNBOOK-launch-deploy-READY.md)
explicitly rather than as tribal knowledge.

## Threat checklist

- [x] **Fabricated message** — a `0x69` whose leaf is absent from `ethMsgSetRoot` folds nothing.
- [x] **Payload substitution / relay tampering** — `payload_hash` is committed on Ethereum inside
      `recordHash`, re-derived in-guest, and checked against `keccak(payload)`.
- [x] **Cross-deployment replay** — `address(outbox) ‖ chainid` inside `msgId`.
- [x] **Replay on Bitcoin** — one-shot fired set keyed by `msgId`.
- [x] **Spam → attest brick** — membership-only, no coverage assert; unwitnessed messages cost the guest
      nothing. This is the reason for the posture, not a side effect.
- [x] **Value inflation** — no handler touches value day one; the outbox commits no amount and holds none.
- [x] **Ethereum reorg** — finalized headers only, same gate as cross-outs.
- [x] **Censorship of a message** — possible, and accepted: omission is liveness-only and anyone can
      supply the witness. The completeness-gated posture that would prevent it is what creates the brick
      vector above.
- [x] **Pool immutability** — the outbox is a separate account; `ConfidentialPool` storage layout and ABI are
      unchanged (only the genesis-digest constant rotates, as any resume-format change does).

## If a future handler needs to move value (read this before stretching the payload)

`recordHash` commits **no amount**, deliberately. A future value-moving handler could carry an amount inside
the payload — the payload is handler-defined and hash-bound, so it would be authenticated — but that is
strictly weaker than how the rest of the system binds value, and the difference is worth stating before
someone treats the payload route as blessed:

- `bridge_burn` binds value through the **kernel**: the destination leaves are hashed into the conservation
  challenge and range-proved, so the Ethereum side cryptographically enforces that the sender authorized that
  exact amount. An amount in a message payload has no such enforcement — the outbox commits it only as
  opaque bytes, and the guest alone would decide what it means.
- The outbox is immutable, so an amount field cannot be added later.

So the recommendation is explicit: **an ETH-authorized value movement on the Bitcoin lane should get a second
outbox with a first-class amount field, not an amount smuggled through this one's payload.** Deploying a
second outbox is cheap (no privileges, no constructor, CREATE3); weakening the value-binding model is not.
This also keeps the current contract honest about what it is — an authenticated *message* anchor with no
value semantics at all.

Note that the binding constraint on richer handlers is **not** Bitcoin's lack of covenants. The executor on
this side is already the reflection guest, which can implement any state transition; what limits the handler
set is the trust anchor (sync committee vs PoW) and the consensus/liveness surface. Covenants would not let
Bitcoin script verify an SP1 or Ethereum state proof — what they would enable is pre-committed spend paths,
which is a different (and complementary) mechanism, not a lift on this ceiling.

## Decisions (locked — all three are immutable or consensus, so none can be deferred past launch)

- **No fee on `send`.** Under membership-only, unwitnessed spam costs the guest nothing, so a fee buys no
  safety; it only deters legitimate use. A fee cannot be added to an immutable contract afterwards, so this
  is a real one-way door and it is being taken deliberately.
- **`ns` is derived, not registered:** `ns = keccak("tacit-ns-<handler>-v1")`. The guest pins the handful it
  implements and ignores the rest, so allocating a namespace needs no registry and no coordination — an
  unknown `ns` is simply an attestation nobody handles.
- **Payload cap: 1024 bytes**, asserted in-guest and in the outbox. The envelope is witness-carried so
  Bitcoin standardness is not the binding limit; the fold's keccak over the payload is. 1024 is ample for
  any structured instruction and keeps the per-message fold cost flat.
