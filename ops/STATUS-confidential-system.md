# STATUS — Confidential token system (Ethereum + cross-chain)

One picture of what's built, what's proven, and what's left to go live. Companion
plans: `PLAN-confidential-token-rollup.md` (Phase 1/2), `PLAN-confidential-cross-chain.md`
(cross-chain + dual lane), `PLAN-canonical-asset-hub.md` (the ERC20 hub),
`PLAN-confidential-btc-relay.md` (the relay), `RUNBOOK-confidential-pool-deploy.md`,
`RUNBOOK-confidential-mainnet-deploy.md`, `PLAN-teth-confidential-onboarding.md`.

## CURRENT STATE — 2026-06-14 (live pilot + path to mainnet)

**Live on Sepolia + signet, on `main`:** the confidential shielded pool + bidirectional bridge pilot.
- Pool **`0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79`**, `PROGRAM_VKEY` **`0x00d5b572`** (settle) /
  `BITCOIN_RELAY_VKEY` **`0x005e6adc`** (reflection) — both FROZEN (`elf-vkey-pin.json`). cETH registered.
- **First on-chain reflection attest landed** (Bitcoin→ETH proven, tx `0xf6940dd4…`); the signet relay
  advances on the GH Actions cron. Settle stack proven (cETH wrap→settle→seed-only-recover). Shielded
  Pool tab live at tacit.finance (the dapp serves this pool).
- Merged to production `main` (PR #48); CI green (TAC canary + tETH bridge guards).

**In progress — task #10 (the go/no-go gate before mainnet):** durable prover loop + a real bridge_mint
round-trip (signet note → non-empty reflect → mint) + cBTC-lock + live swap/LP/OTC/BID on the pilot.

**Mainnet path — tasks #11/#12 (`RUNBOOK-confidential-mainnet-deploy.md`):** gated on a reflection
re-anchor + re-prove (the eth weak-subjectivity anchor is Sepolia-specific → new `BITCOIN_RELAY_VKEY`;
settle vkey unchanged), then a near-tip deploy. tETH onboards under its existing id `3cba71e1…`.

> The sections below are build history; vkey/address references in them predate the current frozen pin.

## What it is

A multi-asset shielded pool on Ethereum (`ConfidentialPool`) with arbitrary hidden
amounts on secp256k1 notes — the same note object as the Bitcoin layer. Validity is
SP1-proven (one guest: wrap / transfer / unwrap / bridge_burn / bridge_mint, plus the
cross-lane non-membership gate); the contract maintains the commitment tree, the
nullifier set, and pays the public boundary. A canonical ERC20 layer
(`CanonicalAssetFactory` + `CanonicalBridgedERC20`) gives every Tacit-recorded asset a
public face (Uniswap-tradeable) with the pool as its sole minter (mint on exit, burn
on entry). Cross-chain rides the live tETH stack (`BitcoinLightRelay` +
`SP1PoolRootVerifier`).

## Built + proven

| Layer | Evidence |
|---|---|
| `ConfidentialPool` (multi-asset, escrow + pool-minted modes, cross-lane gate) | 57 forge tests |
| SP1 guest — full op set (wrap/transfer/unwrap/bridge_burn/bridge_mint/attest_meta/swap/lp) + IMT cross-lane non-membership + bridge-burn-set mint; swap/LP amounts bound by an opening sigma (settle prover never learns `r`) | compiles in-zkVM; canonical pinned vkey `0x00bb82ef…` (`elf-vkey-pin.json`; the opening-sigma swap/LP rebuild froze the current pin). The live pool's `PROGRAM_VKEY` must equal the pin — any superseded vkey (`0x0063293d`/`0x00b3ebb4`/`0x00f02859`/`0x00bc5661`/`0x00cc4e72`) requires a redeploy (live Sepolia is at `0x00cc4e72` → redeploy pending); the deploy script enforces it |
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
4. **Relay** feeding `attestBitcoinRoot` / `reflectBitcoinSpentRoot` / `bridge_mint`
   (the Bitcoin-state reflection — reuses the live tETH SP1 stack); needed for the
   cross-chain entry + the dual-lane fast lane.
5. **Batcher** (later) for cheap-at-scale: the guest already settles many ops per proof
   (`numOps`); an off-chain sequencer amortizes proving + gas.

## Open items (carried in the plans)

- **Per-op proving latency** until batching; instant assurance is client-side
  (recipient verifies the BP+ proof), Ethereum settle follows.
- **bridge_mint finality:** the burn block's depth is enforced by the relay's
  confirmation discipline (it attests buried roots); deep-reorg handling is
  accept-and-document for the pilot, as on the tETH bridge and the AMM.
- **Cross-lane freshness:** a settle's `bitcoinSpentRoot` must equal the current
  reflected root (exact match → a prover races the relay; a recent-root window is the
  follow-up).
- **Bitcoin peer:** cross-chain assets need the Bitcoin side to maintain the same note
  tree + spent-set the reflection proves; collateral/etch live there, not on Ethereum.
- **Canonical deployment:** the asset hub's factory is permissionless; for the pilot
  the team deploys canonicals first (a `msg.sender == minter` gate is a later harden).

## Not changed by any of the above

The confidential `settle` guest, its vkey, and the SP1 ceremony are fixed — every
remaining item is deployment, off-chain relay/batcher, the dapp, or the Bitcoin peer.
No new circuit and no new ceremony are required to go live.
