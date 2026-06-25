# STATUS — Confidential token system (Ethereum + cross-chain)

One picture of what's built, what's proven, and what's left to go live. Companion
plans: `PLAN-confidential-token-rollup.md` (Phase 1/2), `PLAN-confidential-cross-chain.md`
(cross-chain + dual lane), `PLAN-canonical-asset-hub.md` (the ERC20 hub),
`PLAN-confidential-btc-relay.md` (the relay), `RUNBOOK-confidential-pool-deploy.md`,
`RUNBOOK-confidential-mainnet-deploy.md`, `PLAN-teth-confidential-onboarding.md`.

## CURRENT STATE — 2026-06-21 (Sepolia full-suite cleanup)

**Canonical bridge direction:** `ConfidentialPool` is the bridge and DeFi surface for new testing.
The old `TacitBridgeMixer` tETH bridge is sunset alpha infrastructure: keep it for existing-note
recovery/migration and historical audits only. Do not use it as the target path for new ETH/tETH
Sepolia testing.

**Current repo pins for the next Sepolia deploy/redeploy:** read the authoritative values from
`contracts/sp1/confidential/elf-vkey-pin.json`:
- `PROGRAM_VKEY` **`0x00516e622d8fa554b8ef2c6cee2c3436aafda1a33b39f86a131072a7ae52e0ea`**.
- `BITCOIN_RELAY_VKEY` **`0x00fdfe08721b3ad298529bf632975a2f0ca29440004536d1fa5f43eadd3b0891`**.
- Settle ELF sha256 **`7b7a3f1ed6f07f6917e6a04cb44edc531e0a515aab917408f827bf1e04d77397`**.
- Reflection ELF sha256 **`27863304fe6acf4f3a1a790d197caa4ab331cbc454073a5cf14e2d1bbb8403b7`**.

`DeployConfidentialPool.DEFAULT_VKEY` and `verify-vkey-pin.sh` currently match those pins. A deploy
with any other vkey must be treated as a deliberate new re-prove, not as Sepolia full-suite testing.

**Historical live pilot on Sepolia + signet:** the confidential shielded pool + bidirectional bridge pilot.
- Pool **`0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79`** was proven live on prior pins. Treat it as historical
  unless it is redeployed/repointed to the current authoritative pins above.
- **First on-chain reflection attest landed** (Bitcoin→ETH proven, tx `0xf6940dd4…`); the signet relay
  advances on the GH Actions cron. Settle stack proven (cETH wrap→settle→seed-only-recover). Shielded
  Pool tab live at tacit.finance (the dapp serves this pool).
- Merged to production `main` (PR #48); CI green at the time. New testing should gate on the confidential
  pool checks, not the sunset tETH mixer path.

**Immediate Sepolia full-suite gate:** deploy a fresh `ConfidentialPool` at the authoritative pins,
register native-ETH/tETH + TAC/cBTC/cUSD test assets, start the reflection + settle loops, then run:
wrap/transfer/unwrap, bridge_mint, bridge_burn/crossOut, swap, LP add/remove, OTC/BID, farm bond/harvest/
unbond, cBTC mint/settle, and cUSD CDP mint/topup/close/liquidate fixtures.

**Mainnet path — tasks #11/#12 (`RUNBOOK-confidential-mainnet-deploy.md`):** gated on a reflection
re-anchor + mainnet re-prove (the eth weak-subjectivity anchor is Sepolia-specific → new
`BITCOIN_RELAY_VKEY`; mainnet may also rotate settle if source changed), then a near-tip deploy. tETH
onboards under its existing id `3cba71e1…`.

> The sections below are build history; vkey/address references in them predate the current frozen pin.

## What it is

A multi-asset shielded pool on Ethereum (`ConfidentialPool`) with arbitrary hidden
amounts on secp256k1 notes — the same note object as the Bitcoin layer. Validity is
SP1-proven (one guest: wrap / transfer / unwrap / bridge_burn / bridge_mint, plus the
cross-lane non-membership gate); the contract maintains the commitment tree, the
nullifier set, and pays the public boundary. A canonical ERC20 layer
(`CanonicalAssetFactory` + `CanonicalBridgedERC20`) gives every Tacit-recorded asset a
public face (Uniswap-tradeable) with the pool as its sole minter (mint on exit, burn
on entry). Cross-chain uses `BitcoinLightRelay` plus the confidential reflection prover
verified by `ConfidentialPool.attestBitcoinStateProven`; the old tETH mixer verifier is not
part of the new bridge path.

## Built + proven

| Layer | Evidence |
|---|---|
| `ConfidentialPool` (multi-asset, escrow + pool-minted modes, cross-lane gate) | 57 forge tests |
| SP1 settle guest — wrap/transfer/unwrap/bridge_burn/bridge_mint/attest_meta/swap/lp/route/OTC/BID/adaptor/CDP/cBTC/farm | committed ELF + authoritative `program_vkey` in `elf-vkey-pin.json`; `DeployConfidentialPool` rejects a mismatched deploy vkey |
| SP1 reflection guest — full-scan Bitcoin reflection, bridge-burn set, cBTC/crossOut/consumed-nullifier folds | committed ELF + authoritative `bitcoin_relay_vkey` in `elf-vkey-pin.json`; `verify-vkey-pin.sh` guards the frozen Sepolia testing vkey/sha |
| Crypto core (`cxfer-core`: BP+ range, kernel, keccak primitives, bitcoin, IMT, bridge-burn UTXO accumulator) | 27 native tests, JS↔Solidity↔Rust KATs |
| Real Groth16 proof verified **on-chain** via the genuine SP1 verifier | `ConfidentialProofReal` 5/5 |
| In-zkVM op execution (transfer FULLOP_OK, bridge_mint BRIDGEMINT_OK, cross-lane CROSSLANE_OK) | box execute |
| Dapp prover/recovery (transfer, memo, indexer, evm wallet, evm-log decoder, relay) | ~47 node checks |
| Asset hub — canonical ERC20 factory + pool-minted mode | factory + TAC walkthroughs |
| TAC end-to-end (Bitcoin burn → confidential → public ERC20 → tradeable → back; Bob→Alice→exit) | 2 walkthrough tests |

The Ethereum-side cryptography and contracts for the whole system — confidential
settlement, arbitrary amounts, cross-chain, the dual-lane gate, the public/confidential
asset hub — are implemented and tested; the proving stack produces a real,
on-chain-verifiable proof.

## Go-live sequence

1. **Deploy `ConfidentialPool`** (`RUNBOOK-confidential-pool-deploy.md`): needs a
   deployer key/RPC + the SP1 v6.1.0 verifier address for the chain. The instant it
   lands, confidential transfers + matched swaps settle on Ethereum (~12s) — this is
   Ethereum fast settlement.
2. **Register assets:** `registerWrapped(WETH/USDC/…)` for external ERC20s (escrow);
   `registerMinted(canonicalErc20)` for Tacit-recorded assets (the pool mints/burns).
3. **Dapp tile** for wrap / transfer / unwrap / recover (builds + submits proofs).
4. **Relay** feeding `attestBitcoinStateProven` (the Bitcoin-state reflection) plus the
   settle prover queue; needed for bridge_mint, bridge_burn/crossOut, and the fast lane.
5. **Batcher** (later) for cheap-at-scale: the guest already settles many ops per proof
   (`numOps`); an off-chain sequencer amortizes proving + gas.

## Open items (carried in the plans)

- **Per-op proving latency** until batching; instant assurance is client-side
  (recipient verifies the BP+ proof), Ethereum settle follows.
- **bridge_mint finality:** the burn block's depth is enforced by the relay's
  confirmation discipline (it attests buried roots); deep-reorg handling is
  accept-and-document for the pilot.
- **Cross-lane freshness:** a settle's `bitcoinSpentRoot` must equal the current
  reflected root (exact match → a prover races the relay; a recent-root window is the
  follow-up).
- **Bitcoin peer:** cross-chain assets need the Bitcoin side to maintain the same note
  tree + spent-set the reflection proves; collateral/etch live there, not on Ethereum.
- **Canonical deployment:** the asset hub's factory is permissionless; for the pilot
  the team deploys canonicals first (a `msg.sender == minter` gate is a later harden).

## Not changed by any of the above

The current committed `settle` and reflection guests are the Sepolia testing target. Every remaining
item for this pass is deployment, off-chain relay/settle operation, dapp wiring, and test execution.
Any source change under the guests is a new re-prove and must rotate the pin/deploy defaults/fixtures
in one commit.
