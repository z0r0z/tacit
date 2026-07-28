# Targeted review — ETH→BTC authenticated messages (`EthCallOutbox` + `T_ETH_CALL` 0x69)

Scope: the ETH→BTC message channel added for the V1 launch reprove. This is **new code on the immutable
surface** (one new contract) and on the **consensus surface** (both reflection guests + the resume format).
Attack it adversarially; assume a malicious permissionless prover, a malicious relayer/broadcaster, and a
malicious message sender. Verify against code, not these notes.

Normative spec: [`spec/amendments/SPEC-ETH-MESSAGE-AMENDMENT.md`](../spec/amendments/SPEC-ETH-MESSAGE-AMENDMENT.md).
Design rationale: [`DESIGN-eth-call-outbox.md`](./DESIGN-eth-call-outbox.md).

## What it is, in one paragraph

The reverse of `T_BTC_CALL`/`BtcCallExecutor`. An Ethereum party calls `EthCallOutbox.send`, which commits
`recordHash = keccak(destChain ‖ ns ‖ sender ‖ keccak(payload))` under a one-shot `msgId`. The
eth-reflection guest proves that storage slot against a finalized execution state root and accumulates
`keccak(msgId ‖ recordHash)` into a membership set. A wallet broadcasts a `T_ETH_CALL` (0x69) Taproot-witness
envelope on Bitcoin carrying the full payload; the Bitcoin reflection guest re-derives the record from the
envelope, proves set membership, and records `msgId` in the honored-message set — which is committed in the
resume digest. **No value is ever authorized**; the day-one handler (`NS_ATTEST`) records and mutates nothing.

## Files in scope

**Immutable / on-chain**
- `contracts/src/EthCallOutbox.sol` — the whole contract (~60 lines). No privileges, no payable path, no
  constructor (so CREATE3 init code is identical on every chain).
- `contracts/src/ConfidentialPool.sol` — **one constant only**: `REFLECTION_GENESIS_DIGEST` rotated to
  `0x943d32812a0683fd7f2202e696fb047854ac5618c115e3572a6b9417506eb79d` because the resume digest gained the
  honored-message set. No storage, ABI, or logic change.

**Consensus (guests)**
- `contracts/sp1/eth-reflection/src/main.rs` — the outbox slot filter, the message accumulator, the three
  appended `EthReflectionPublicValues` fields (now 14 words).
- `contracts/sp1/confidential/src/reflect.rs` — the 14-word assert, the pinned `ETH_CALL_OUTBOX` gate, the
  message-root read, the `0x69` fold arm, the honored-set resume read.
- `contracts/sp1/confidential/cxfer-core/src/eth_reflection.rs` — `eth_message_record` / `eth_message_leaf` /
  `eth_message_member`, the outbox slot indices, `MAX_ETH_MESSAGE_PAYLOAD`, and the extended `eth_refl_digest`.
- `contracts/sp1/confidential/cxfer-core/src/bitcoin.rs` — `parse_eth_call_envelope`.
- `contracts/sp1/confidential/cxfer-core/src/lib.rs` — `fold_eth_message`, the `honored_msg_*` state, its
  `digest()` binding, `keccak_bytes`.
- `contracts/sp1/reflect-stdin/src/lib.rs` — the honored-set resume + the per-`0x69` witness order.

**Liveness-critical off-chain (not consensus, but a stall vector)**
- `dapp/burn-deposit-bitcoin.js` (`parseEthCallEnvelope` + dispatch), `dapp/confidential-pool.js`
  (`foldEthMessage`, the assembler arm, the digest mirror, snapshot/restore).

## Invariants the new code must uphold

1. **No unbacked honor.** A `msgId` can only be honored if `msgRecord[msgId]` was proven non-zero in outbox
   storage at a finalized Ethereum block. Only `send` writes that slot. A fabricated `0x69` must fold nothing.
2. **No tampering in transit.** The envelope re-supplies `(ns, sender, payload)`; the guest re-derives
   `record` and re-checks `keccak(payload) == payload_hash`. Altering any field must break set membership.
   A relayer must not be able to redirect a message's handler, sender attribution, or payload.
3. **One-shot.** A `msgId` is honored at most once. A re-broadcast `0x69` is a membership-gated no-op, and the
   honored set cannot be rolled back across cycles (it rides `digest()` and is preserved through a
   generational rebase).
4. **No prover-forced stall.** A non-member `0x69` must SKIP, never abort. Absence is legitimate (not folded
   this cycle) as well as fraudulent, so aborting would be a one-transaction relay stall.
5. **No prover-forced work.** The message set is membership-only with **no completeness gate**, and the
   accumulator indexes by its own append order — never the outbox `msgAt` index. Confirm no path makes
   folding message N require folding messages 0..N-1.
6. **Cross-cycle binding.** `ethMsgSetRoot`/`ethMsgCount` are inside `eth_refl_digest`, so a witnessed prior
   accumulator cannot be forged between cycles.
7. **Guest↔JS parity.** The assembler must emit the `0x69` witness pair for EVERY parseable `0x69` — member or
   not, forward batch or reverse — or the guest's input stream desyncs into a wrong, un-chainable digest.

## Soft spots — go here first (where I am least certain)

1. **Witness-stream desync (most important, and structurally untested).** The guest reads `set_index`,
   `set_path`, then a 5-field honored-set insert witness for every parseable `0x69`. `reflect-stdin` and the
   JS assembler must emit exactly that, in exactly that order, in every batch shape (forward, Mode-B, member,
   non-member, replay, malformed-payload-hash). Unit tests cannot catch a desync — it produces a wrong digest,
   not an error. **This is what the reprove fixtures must cover, and it is the single highest-value thing to
   review.** Note the fold arm has never executed under the zkVM: everything green today is cxfer-core unit
   tests, JS mirror tests, and compilation.
2. **The `msgId` is not re-derived in-guest.** The guest reads `msgRecord[msgId]` at a slot key *derived from*
   `msgId`, which I argue forces the pairing without re-deriving `keccak(outbox ‖ chainid ‖ record ‖ index)`.
   Check that reasoning — it is the one place I chose a derivation over an explicit check.
3. **Second-account proving.** The eth guest now filters two addresses out of one `verified` slot list.
   Confirm `outbox_slots.len() == messages.len()` genuinely excludes stray slots, and that pool-slot
   accounting is unaffected by the new account.
4. **Payload cap agreement.** `EthCallOutbox.MAX_PAYLOAD` (1024) and `MAX_ETH_MESSAGE_PAYLOAD` must agree. The
   contract is the binding side, but the parser must reject independently — it cannot assume Ethereum was
   well-behaved.
5. **Envelope parsing.** Exact-length (trailing bytes would let two envelopes carry one message), the
   `payload_len` over-read, and the witness-commitment gate it inherits (coinbase excluded — BIP-141 fixes the
   coinbase wtxid to zero, so its witness is unbound).

## Known and accepted (do not report as findings)

- **Weaker anchor than the forward lane.** ETH→BTC is anchored by the Ethereum sync committee under weak
  subjectivity; BTC→ETH by Bitcoin PoW in an immutable contract. Inherited from Mode B, not introduced here,
  and the primary reason the day-one handler set mutates nothing.
- **Message censorship is possible.** Omission is liveness-only; anyone can supply the witness later. The
  completeness gate that would prevent it is exactly what creates the spam-brick vector (invariant 5).
- **Unbounded honored-set growth.** One permanent IMT entry per honored message, rate-limited by the cost of
  one Ethereum plus one Bitcoin transaction. Same shape as the cross-out replay gate.
- **No fee on `send`.** Deliberate, and a one-way door on an immutable contract: under membership-only,
  unwitnessed spam costs the guest nothing, so a fee would only deter legitimate use.
- **`msgAt` is unused by any guest.** It exists for indexers.
- **Witness data is prunable.** The payload lives in the Taproot witness — committed and in the block, but
  retrieval later depends on an archival source. Same as every existing Tacit envelope.

## Cross-artifact parity (must not drift)

`recordHash` is derived in four places — Solidity (binding), Rust (both guests), JS (assembler + wallet).
Shared KAT, asserted in `contracts/test/EthCallOutbox.t.sol`, `cxfer-core/src/eth_reflection.rs`, and
`tests/eth-message-parity.mjs`:

| field | value |
|---|---|
| `ns` | `keccak("tacit-ns-attest-v1")` |
| `sender` | `0x000000000000000000000000000000000000a11c` |
| `payloadHash` | `keccak("hello")` |
| **`recordHash`** | `0x0d6a81b8062c850eabea90ec9a223a5e2aba6f7e8ddaf5d46c102e63507241be` |

## State of the tree at handover

- `contracts/sp1/confidential/cxfer-core`: **188 tests pass**.
- `contracts/test/EthCallOutbox.t.sol`: **16 tests pass**.
- `tests/eth-call-fold-verify.mjs` (18 checks), `tests/eth-message-parity.mjs`,
  `tests/confidential-reflection-scan.mjs`, `tests/crossout-mint-fold-verify.mjs`: pass.
- `forge test`: **318 failures, identical to the pre-change baseline** (stale fixtures on this mid-reprove
  branch). None attributable to this work — measured by reverting the digest constant and re-running.
- **Placeholders that fail closed:** `ETH_CALL_OUTBOX = [0u8; 20]` in `reflect.rs` (fill from the mined
  CREATE3 salt **before** the ELF build — see the ordering gate in `RUNBOOK-launch-deploy-READY.md`), and
  `ETH_REFLECTION_VKEY` (regenerate at build; any eth-guest rebuild rotates it).
- **Not built:** host-side message discovery in `prover-host/src/bin/eth_prove.rs` (it folds an empty message
  set, which is always a valid cycle under membership-only). Until it lands, messages are provable but never
  folded. It is operational, not consensus — but it cannot be compiled off the prover box, which is why it
  was not written blind.
- **Pre-existing, out of scope:** `contracts/sp1/eth-reflection/host/eth_reflection_exec.rs` mirrors
  `EthReflInputs` but predates the fast-lane fields and cannot produce a valid input as-is.
