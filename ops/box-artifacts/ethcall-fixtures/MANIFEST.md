# ETH→BTC authenticated message (T_ETH_CALL, 0x69) fold — reflect-exec DIGEST_MATCH fixtures

The reflection guest folds an Ethereum→Bitcoin authenticated message (`EthCallOutbox.send`, Bitcoin envelope
opcode 0x69) by recording its `msg_id` in the honored-message set — the effect of an attestation handler, which
doubles as the one-shot replay gate. Authority is the message's membership in the eth-reflection message set
(`mode_b=1`), re-derived from the envelope's own `(ns, sender, payload_hash)` so a relayer that alters any field
reconstructs a different leaf and fails membership. No note, no mint, no value.

Each fixture is a full reflection scan input carrying the JS assembler's `newDigest`; `reflect-exec` re-folds the
block in-guest and MUST land on that digest (DIGEST_MATCH). Generator: `tests/gen-reflection-ethcall-synth.mjs`
(`ETHCALL_SCENARIO=<vector>`). JS-level field binding + the record known-answer vector are pinned by
`tests/eth-message-parity.mjs` (Solidity `EthCallOutbox.recordHashOf` ↔ Rust `eth_message_record` ↔ JS).

## Pinned outbox
The guest's `ETH_CALL_OUTBOX` const is `[0u8;20]` until the CREATE3 salt is mined. Every fixture leaves the eth
proof's surfaced `ethOutbox` word zero (`buildEthPv` outbox=null), so the guest's `assert_eq!(outbox_word[12..32],
ETH_CALL_OUTBOX)` passes. A nonzero outbox here would abort the Mode-B gate fail-closed — intended until the salt
is pinned and the ELF rebuilt.

## Record
`record = keccak(dest_chain(2 BE) ‖ ns(32) ‖ sender(20) ‖ payload_hash(32))`; the honored leaf is
`keccak(msg_id ‖ record)`. Known-answer vector for `(dest_chain=1, ns=keccak("tacit-ns-attest-v1"),
sender=…a11c, payload_hash=keccak("hello"))`: `0x0d6a81b8062c850eabea90ec9a223a5e2aba6f7e8ddaf5d46c102e63507241be`.

## Vectors
| Fixture | mode_b | Scenario | Expected outcome | newDigest |
|---|---|---|---|---|
| forward.json | 0 | parseable 0x69, NO eth cycle (forward-only) | DIGEST_MATCH-with-skip — witnesses read (bogus), `eth_msg_set_root=0` fails membership, honored unchanged | 0x74e0e48f… |
| member.json | 1 | 0x69 whose message IS a set member | DIGEST_MATCH-with-honor — `honored_msg_count` 1→2, digest advances | 0x002a2a58… |
| replay.json | 1 | the SAME message in two txs of one block | DIGEST_MATCH-with-honor-once — first honors, the dup is a membership-gated no-op (identical digest to member.json: one honored msg_id) | 0x002a2a58… |
| payload-mismatch.json | 1 | member set present, but envelope payload ≠ its payload_hash | DIGEST_MATCH-with-skip — guest re-derives `keccak(payload)` and skips, honored unchanged | 0x339bf12b… |
| wrong-destchain.json | 1 | member set present, but `dest_chain != Bitcoin` | DIGEST_MATCH-with-skip — not honored, honored unchanged | 0x339bf12b… |
| batched.json | 1 | 0x69 (member) + 0x65 crossout mint (member) + 0x2B reflected bridge burn, ONE block | DIGEST_MATCH-all-fold — message honored, crossout onboarded, burn recorded; the mixed-envelope stream stays in sync | 0xd205cc6e… |

`payload-mismatch` and `wrong-destchain` share a digest: both skip with identical block-level state effect (only
the envelope bytes differ, which the digest does not cover). `member` and `replay` share a digest: both honor
exactly one `msg_id` into the same set.

## Stream order (reflect-stdin ↔ guest, per 0x69)
For every parseable 0x69 the guest reads, in order: `set_index`, `set_path` (message-set membership), then the
honored-set IMT insert witness (`sLowValue`, `sLowNext`, `sLowIndex`, `sLowPath`, `sNewPath`). The assembler
emits this set for EVERY 0x69 (member or not) via `foldEthMessage`, so a non-member / mismatched / wrong-chain
0x69 folds nothing but still consumes an aligned witness — the stream never desyncs. `batched.json` is the guard
that this holds when 0x69 shares a block with other witness-carrying folds (0x65 crossout, 0x2B burn).

## Running
`reflect-exec` runs the reflection ELF on the host RISC-V emulator (no GPU) via the shared `write_stdin`
serializer — the same bytes the box recursion prover writes:

```
REFLECT_ELF=contracts/sp1/confidential/elf/reflection-prover \
  cargo run --release --manifest-path contracts/sp1/reflect-exec/Cargo.toml --bin reflect-execute -- \
  ops/box-artifacts/ethcall-fixtures/<vector>.json
```

Regenerate: `for s in forward member replay payload-mismatch wrong-destchain batched; do
ETHCALL_SCENARIO=$s node tests/gen-reflection-ethcall-synth.mjs > ops/box-artifacts/ethcall-fixtures/$s.json; done`.
