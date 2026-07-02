# Mainnet canonical assets + immutable-surface config

The plan to register cBTC and the other canonical assets with correct metadata on the mainnet immutable
surface, and the config deltas vs the Sepolia rehearsal. The CID is committed into the asset identity
(`deriveAssetId` → `metaHash = sha256(len‖symbol‖decimals‖cid)`), so every CID below must be FINAL before the
immutable deploy.

## Canonical assets (verified against ConfidentialPool + SeedV1Pools)

| Asset | Tacit side | Public ERC20 | Metadata | How registered |
|-------|-----------|--------------|----------|----------------|
| **TAC** | cTAC (8 dec) | **TAC** (etch-proven — no `tac` prefix; TAC's root IS Tacit, so it exports as itself, not a wrapper like tacBTC/tacUSD) | **real bridged TAC `f0bbe868…`** — symbol/decimals/CID from the Bitcoin etch | **bridged**: first bridge_mint → `_autoRegisterFromMeta` adopts the canonical ERC20 trustlessly with the etch-declared symbol `TAC` (NOT registerWrapped; NOT DeployCanonicalTac which is testnet-only). Display name cosmetic (not in metaHash). |
| **ETH** | cETH = tETH (18 dec, unitScale 10¹⁰) | tacETH (not day-1 relevant) | **reuses alpha-mixer tETH metadata**, same Tacit asset id, multi-gen | pinned in pool ctor via `TETH_BITCOIN_LINK` → `_register(0, 10¹⁰, link, false, "Tacit ETH", "tETH", 18)` |
| **BTC** | cBTC (8 dec) | tacBTC (18 dec) | `CBTC_METADATA_CID = 0x4fdafc3227875f0973780cc0aa6aa186c8cb00a0564fbed8bdf1f0cfa16b06cc` (own SVG, pinned) | pool ctor `deployCanonical(CBTC_ZK_ASSET_ID, pool, "tacBTC", 18, CBTC_METADATA_CID)` |
| **USD** | cUSD (8 dec) | tacUSD (18 dec) | `CUSD_METADATA_CID = 0x927144081b10389996f30ec9e2182ae5c04c397d79f497e23947926a51214ab0` (own SVG, pinned) | pool ctor `deployCanonical(cusdId, pool, "tacUSD", 18, CUSD_METADATA_CID)` |

cBTC + cUSD CIDs are pinned constants (each its own SVG/meta). cETH reuses the tETH metadata from the alpha
mixer and the same Tacit asset id across generations — nothing new to pin. cTAC wraps the public canonical TAC
(FixedSupplyMinter — mints once for the 2.5M airdrop + incentives, MINTER then provably inert ⇒ supply fixed).

## Mainnet config deltas vs the Sepolia rehearsal

The 4 metadata CIDs above carry over unchanged (chain-independent content hashes). The immutable-surface deltas:

1. **SP1_VERIFIER** — the mainnet immutable SP1VerifierGroth16 LEAF (not the gateway). Confirm `VERIFIER_HASH`
   first 4 bytes == our proof selector `0x4388a21c` (the Sepolia leaf `0xF745fa89…` matched).
2. **vkeys** — already the re-proven values, identical cross-chain: PROGRAM_VKEY `0x0079b755…`,
   BITCOIN_RELAY_VKEY `0x0012ef33…`, ETH_REFLECTION_VKEY `0x00e6463f…` (the pin must match at deploy; the
   DeployV1SuiteCreateX pin-coherence guard enforces it).
3. **HEADER_RELAY + GENESIS_REFLECTION_ANCHOR** — deploy the real BitcoinLightRelay genesis'd NEAR the mainnet
   BTC tip (deploy-mainnet.sh anchor-fetch: tip−6, chainwork from a keyless RPC), anchor = a matured near-tip
   block, so the reflection lane resolves recent inclusion proofs without a long walk.
4. **TETH_BITCOIN_LINK** — the mainnet tETH asset id (consistent multi-gen; if mainnet tETH shares the id, reuse
   it verbatim — confirm before deploy since it is immutable).
5. **Admin / governance** — `ENGINE_ADMIN` / farm gov = the mainnet ops multisig (env-swapped; the suite's
   fail-closed guards require it on chainid 1).
6. **Vanity salts** — the fresh mainnet set (mining the 5-byte tier on the box now; same salts → same addresses).
7. **REQUIRE_VANITY / EXPECTED_VERIFIER_CODEHASH** — both default-on for chainid 1 (assert the 0x0000… prefix +
   the verifier codehash).

## Pre-mainnet checklist

- [ ] cBTC/cUSD SVG+meta JSON pinned on IPFS, CIDs == the pinned constants (verify, don't re-pin blindly).
- [ ] cETH/tETH: confirm the mainnet tETH asset id (TETH_BITCOIN_LINK) — same as alpha-mixer or mainnet-specific.
- [ ] canonical TAC: FixedSupplyMinter total == airdrop + incentives; merkle root finalized; distributor wired.
- [ ] mainnet SP1_VERIFIER leaf address + codehash captured; selector matches.
- [ ] mainnet relay anchor fetched (near tip, matured) + chainwork; advancer + attest loops staffed.
- [ ] vanity salts finalized (mainnet set); REQUIRE_VANITY on.
- [ ] ops multisig set as admin; dirty-tree + pin-coherence guards green.
- [ ] day-1 farms: manual `DeployFarmController` per incentivized pool (cTAC reward), then re-sync manifest.
