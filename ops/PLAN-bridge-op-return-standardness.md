# Bridge OP_RETURN >80B standardness — mainnet relay blocker

## Problem

Bridge envelopes (0x60–0x64) are emitted as bare-OP_RETURN payloads, sized:

| Op    | Opcode | Observed payload size |
|-------|--------|------------------------|
| MINT    | 0x60 | 517 B                 |
| BURN    | 0x61 | 537 B                 |
| ROTATE  | 0x62 | 484 B                 |
| EXPORT  | 0x63 | 485 B                 |
| IMPORT  | 0x64 | 164 B                 |

Bitcoin Core's default policy caps `nMaxDatacarrierBytes = 83` (single OP_RETURN, payload ≤ 80 B). Every bridge envelope is non-standard on mainnet; default-policy nodes (the vast majority) will not relay, so the tx sits in the user's local mempool and never reaches a miner.

Signet does not enforce this cap, so all current testnet 3a/3b broadcasts confirm. Mainnet behavior diverges silently.

## Why this surfaced now

Mixer ops (`T_WITHDRAW` 0x2A, CXFER 0x22/0x23) already use Taproot script-path reveals — the envelope rides in the reveal tx's witness item 1, which has no datacarrier cap. The bridge guest code path was an OP_RETURN shortcut; it works on signet and stayed that way.

## Options

### A — Migrate bridge ops to Taproot reveal (recommended)

Two-tx commit+reveal, identical pattern to `buildAndBroadcastWithdraw` (`dapp/tacit.js:28118-28154`):

- Dapp: rewrite `buildAndBroadcastBridge{Deposit,Burn,Rotate,Export,Import}` (5 functions, ~300 LOC) to use `encodeEnvelopeScript`, `tapLeafHash`, `tweakedOutputKey`, `p2trScript`, `signTaprootScriptPathInput`.
- Guest: add Taproot dispatch for 0x60–0x64 alongside the existing OP_RETURN path in `program/src/main.rs`. Each handler is ~30 LOC. Existing OP_RETURN path can stay (transition) or be removed (cleanup).
- Worker: remove the `_fromTaproot` reject at `worker/src/index.js:20362` (the explicit skip that currently disqualifies Taproot bridge envelopes).
- Tests: 3a/3b harnesses use OP_RETURN today; either keep that (signet relays it) or mirror the dapp.
- Trade-off: more code, but consistent with mixer ops, relayable on mainnet via default-policy nodes.

### B — Keep OP_RETURN, document miner reliance

Submit non-standard txs directly to mining pools that accept oversized OP_RETURNs (Marathon, MARA, F2Pool variants — verify each currently accepts >80 B). Add submission failover in the dapp: try public mempool, fall back to direct miner API.

- Pros: no code migration; preserves existing signet code path 1:1.
- Cons: centralized submission; miners can change policy without notice; users without direct miner access can't broadcast.

### C — Multi-output OP_RETURN chaining

Does not work. Default policy is one OP_RETURN per tx; splitting into 7 outputs doesn't bypass the cap and is non-standard for a separate reason.

## Recommendation

Option A. The migration is mechanical and brings bridge ops into structural parity with mixer ops. Sequence after the in-flight signet round-trip validates the baseline:

1. ✅ **Worker**: dropped the `_fromTaproot` reject for bridge opcodes (`worker/src/index.js:20362` removed). Worker now indexes either source.
2. ✅ **Guest**: Taproot dispatch for 0x60–0x64 added next to the OP_RETURN path in `program/src/main.rs` (and 0x2A moved to the Taproot path). Cargo tests cover Taproot-envelope extraction + dispatch-placement structural pins. ELF rebuilt → new vkey pinned (`elf-vkey-pin.json`). *Forces verifier redeploy.*
3. ✅ **Dapp**: all 5 `buildAndBroadcastBridge{Deposit,Burn,Rotate,Export,Import}` migrated to commit+reveal (template: `buildAndBroadcastWithdraw`). Notes: EXPORT now emits its stealth tETH UTXO at reveal **vout 0** (guest registers it there on the Taproot path; `recordStealthCredit`/`recordOpening` + `bridgeSendFractional`'s lookup updated to vout 0; recovery scan was already vout-agnostic). IMPORT rides the consumed tETH UTXO as the reveal's **2nd input** so the guest's `extract_input_outpoints` match still fires; commit funded by separate sats. ROTATE mirrors the burn builder (no created output).
4. **Tests**: update `tests/bridge-3a.mjs` + `tests/bridge-3b.mjs` to use commit+reveal for bridge ops too (mirror the new dapp). Signet still relays either, so the test harness change just keeps parity with dapp.
5. **Deploy cycle**: rebuild ELF → new vkey → redeploy verifier + mixer → re-run full 3a/3b round-trip on Taproot dapp flow → commit when round-trip clean.
6. **Cleanup**: after one successful Taproot-only release, retire the OP_RETURN dispatch path in the guest (both paths can coexist for one release if rollback is wanted, then drop the OP_RETURN side).

## Status

- Worker: ✅ done
- Guest: ✅ done (ELF rebuilt + vkey pinned)
- Dapp: ✅ done (all 5 builders commit+reveal; export vout 0; import spends tETH UTXO in reveal)
- Tests (`bridge-3a/3b`): remaining — drive a full Taproot round-trip on the fresh signet mixer before mainnet
- Remaining to mainnet: signet round-trip validation on the Taproot path + the runbook deploy gates (BURN_VERIFIER vk hand-check, one mainnet retarget)

## Decision

This is the right call but it is post-current-round-trip work. The signet round-trip in flight is still a meaningful baseline — it validates everything from deposit through proof-on-chain and withdraw. Once that lands cleanly, the Taproot migration is the next discrete unit of work before mainnet.
