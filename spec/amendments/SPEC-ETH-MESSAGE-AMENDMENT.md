# SPEC — Ethereum→Bitcoin authenticated messages (`T_ETH_CALL`, opcode `0x69`)

Status: **as-built**, shipped in the V1 launch reprove. The reverse of
[`SPEC-BITCOIN-HOOK-AMENDMENT.md`](./SPEC-BITCOIN-HOOK-AMENDMENT.md) (`T_BTC_CALL`, `0x68`): there a
Bitcoin party authorizes an Ethereum call; here an Ethereum party authorizes an instruction the Bitcoin-side
Tacit metaprotocol honors. Design rationale: [`ops/DESIGN-eth-call-outbox.md`](../../ops/DESIGN-eth-call-outbox.md).

## §1 The anchor — `EthCallOutbox`

A standalone, privilege-free contract (`contracts/src/EthCallOutbox.sol`), CREATE3-deployed at an address
**pinned in the Bitcoin reflection guest**. Deliberately separate from `ConfidentialPool`: the pool is the
minter for canonical ERC20s and holds the verifier, so a permissionless message anchor must not live behind
those privileges, and the pool's storage layout stays uncoupled from the message format.

`send(uint16 destChain, bytes32 ns, bytes payload) → msgId`:

```
recordHash = keccak(destChain_be2 ‖ ns ‖ sender20 ‖ keccak(payload))
msgId      = keccak(outbox20 ‖ chainid_be32 ‖ recordHash ‖ index_be8)
```

Storage — **consensus, read by index** (`msgCount` 0, `msgAt` 1, `msgRecord` 2), pinned by
`contracts/test/EthCallOutbox.t.sol`. Guards: `destChain != 0`, `payload.length <= 1024` (`MAX_PAYLOAD`).
There is no payable path: `recordHash` commits no amount, so no value is ever authorized.

**Authorization is `msg.sender`, carried verbatim** — the mirror of `callerPubkey` in `T_BTC_CALL`. Any
Ethereum contract (a timelock, a module) is an authority with no new key material.

## §2 Proving — the eth-reflection guest

The guest proves outbox `msgRecord[msgId]` slots against the finalized execution state root (a **second**
proven account alongside the pool) and appends `eth_message_leaf = keccak(msgId ‖ recordHash)` to a keccak
append-tree. Three fields are appended to `EthReflectionPublicValues` (now **14 words**):
`ethOutbox`, `ethMsgSetRoot`, `ethMsgCount`.

**Membership-only — there is NO completeness gate.** Unlike `crossOutCommitment` (omission = censorship of a
confirmed mint) and `bitcoinConsumed` (omission = a double-spend), omitting a message means it does not
apply. Those two sets survive their completeness gates only because entry is expensive; an outbox `send` is
cheap, so a completeness-gated message set would let anyone force unbounded per-cycle accumulator work on
every future reflection proof — a permanent liveness attack on the bridge.

**The accumulator indexes by its own append order, never `msgAt`.** A contiguous-index rule would make
reaching a later message require folding every earlier one — the same brick vector by another name.
Soundness does not need the order: the leaf binds `msgId` to the `msgRecord[msgId]` value read from proven
storage, and the slot key is derived *from* `msgId`, so a witness cannot pair one message's id with
another's record. `msgAt` therefore exists for indexers only and is not read by any guest.

The message set is bound into `eth_refl_digest` (the cross-cycle anchor) alongside the other two — a set
root left out could be swapped for a forged one between cycles.

## §3 The Bitcoin envelope — `T_ETH_CALL` (`0x69`)

```
opcode(1)=0x69 ‖ msg_id(32) ‖ ns(32) ‖ sender(20) ‖ dest_chain(2 BE) ‖ payload_hash(32) ‖ payload_len(2 LE) ‖ payload(N)
```

121-byte header plus payload; witness-carried like `T_BTC_CALL` (variable length). The parser requires the
**exact** length — trailing bytes would let two distinct envelopes carry one message — and enforces the
1024-byte cap so the fold's hash stays bounded regardless of Ethereum's behavior.

The guest fold (`ScanReflection::fold_eth_message`):
1. re-derives `record` from the envelope's own `(dest_chain, ns, sender, payload_hash)`;
2. re-checks `payload_hash == keccak(payload)` — the payload is bound, not merely asserted;
3. requires `dest_chain == BITCOIN`;
4. proves `keccak(msg_id ‖ record) ∈ ethMsgSetRoot`; **non-member ⇒ skip, not abort**;
5. inserts `msg_id` into the honored-message IMT (one-shot; a replay is a membership-gated no-op).

Step 4's skip-not-panic is load-bearing: absence is legitimate (not folded this cycle) as well as
fraudulent, and aborting would hand anyone a relay stall for the price of one Bitcoin transaction.

## §4 Honored-message set — the effect and the replay gate

`ScanReflection.honored_msg_root / honored_msg_count`, sentinel-seeded (count 1), committed in `digest()`
right after the cross-out replay gate and **preserved across a generational rebase** (an honored message
stays honored, like an already-minted cross-out claim).

For the day-one handler this set **is** the effect: honoring a message means recording it here, which makes
it Bitcoin-derived Tacit state — replayable by anyone, pinned by the resume digest — rather than data that
merely happens to be verifiable. Adding it rotated `REFLECTION_GENESIS_DIGEST` to
`0x943d32812a0683fd7f2202e696fb047854ac5618c115e3572a6b9417506eb79d`.

## §5 Namespaces — `ns = keccak("tacit-ns-<handler>-v1")`

Derived, not registered: the guest pins the handful it implements and ignores the rest, so allocating a
namespace needs no registry and no coordination. An unknown `ns` is an unhandled attestation, not an error.

**Day-one handler set: exactly one — `NS_ATTEST`, which records and mutates nothing.** A handler here is a
consensus rule in the liveness path of the attest, with no escrow-containment analogue (unlike the Ethereum
side's ephemeral per-recipe escrow), honored under a sync-committee anchor rather than PoW. Those three
facts are what bound the handler set; none of them are relaxed by proving being cheap.

## §6 Assembler mirror (NORMATIVE for liveness)

`worker/src/reflection-attest.js` refuses to attest any block containing an envelope the guest folds but the
JS scan does not mirror. A `0x69` fold without its mirror is therefore a **one-transaction relay stall**, so
the mirror is not optional: `dapp/burn-deposit-bitcoin.js` routes `0x69` to `type: 'eth_call'` and
`dapp/confidential-pool.js` emits the witness pair (set membership, then the honored-set insert) for **every**
`0x69` — member or not, forward batch or reverse — so the guest's input stream stays in sync.

## §7 Trust model

Inherited from Mode B unchanged: sync-committee verification inside the eth-reflection guest,
weak-subjectivity anchored, finalized headers only, recursively verified under a pinned vkey. This is **not**
symmetric with the forward direction (Bitcoin PoW verified in an immutable contract), which is the second
reason the day-one handler set mutates nothing — a value-mutating handler would expose value to the weaker
anchor.

## §8 Cross-language parity (NORMATIVE)

`recordHash` is derived in four places that must agree byte-for-byte — Solidity (the **binding** side: it
refuses what the guest could not fold), Rust (both guests), and JS (assembler + worker). The shared KAT:

| input | value |
|---|---|
| `ns` | `keccak("tacit-ns-attest-v1")` |
| `sender` | `0x000000000000000000000000000000000000a11c` |
| `payloadHash` | `keccak("hello")` |
| **`recordHash`** | `0x0d6a81b8062c850eabea90ec9a223a5e2aba6f7e8ddaf5d46c102e63507241be` |

Asserted in `contracts/test/EthCallOutbox.t.sol`, `cxfer-core/src/eth_reflection.rs`, and
`tests/eth-message-parity.mjs`.
