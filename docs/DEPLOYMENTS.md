# Deployed contracts

The `ConfidentialPool`, router, and SP1 guests are **immutable** (no proxy, no
admin, no pause, no upgrade path). The **`CollateralEngine`** (CDP/cUSD + cBTC
escrow) is the exception: it is **DAO-governed** — its owner sets the oracle
and CDP parameters and drives cBTC-escrow enforcement and insurance-reserve
draws (a trusted, timelocked governance role, bounded on-chain by an immutable
minimum escrow grace window so lockers always get a public window to exit
before any slash). All are deployed at deterministic CREATE3 vanity addresses
via [CreateX](https://github.com/pcaversaccio/createx) — so the same address is
reproducible across chains.

The machine-readable source of truth is
[`contracts/deployments/1-createx.json`](../contracts/deployments/1-createx.json)
(written by `DeployV1SuiteCreateX.s.sol` at broadcast); this page is its
human-readable mirror. The dapp and relay read that manifest through
`tools/sync-deployment-config.mjs`, never from a copy.

## Ethereum mainnet (chainId 1)

| Contract | Address |
| --- | --- |
| ConfidentialPool | [`0x0000000000047DD77CeCEfE5Dc015EB7bFa9C677`](https://etherscan.io/address/0x0000000000047DD77CeCEfE5Dc015EB7bFa9C677) |
| CollateralEngine | [`0x00000000005b13bAFbf951Ff58cCbAa29de8B51A`](https://etherscan.io/address/0x00000000005b13bAFbf951Ff58cCbAa29de8B51A) |
| CanonicalAssetFactory | [`0x0000000042c2D57499Df64BAF81bfA2C6E100535`](https://etherscan.io/address/0x0000000042c2D57499Df64BAF81bfA2C6E100535) |
| TacitPublicAmm | [`0x00000000f7393Ea752bDCcA608bf79C07035ED24`](https://etherscan.io/address/0x00000000f7393Ea752bDCcA608bf79C07035ED24) |
| ConfidentialRouter | [`0x000000004c5BF191225F9049b385d6F3820E09BC`](https://etherscan.io/address/0x000000004c5BF191225F9049b385d6F3820E09BC) |
| TacitRelayer | [`0x0000000031e3b085713DfC2A64f85789278710ea`](https://etherscan.io/address/0x0000000031e3b085713DfC2A64f85789278710ea) |
| WstEthUsdFeed (BTC-per-wstETH adapter) | [`0x0000000000BfA0573fA22DaEd427545baa9b18cF`](https://etherscan.io/address/0x0000000000BfA0573fA22DaEd427545baa9b18cF) |
| BtcCallExecutor | [`0x000000002A11496d860f0d06f92B71B1d1979600`](https://etherscan.io/address/0x000000002A11496d860f0d06f92B71B1d1979600) |
| BitcoinLightRelay (header relay) | [`0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0`](https://etherscan.io/address/0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0) |

### Canonical bridged / pool-minted ERC20s

Each canonical ERC20 is minter-bound to the pool, so its address is unique to
this suite. Bridged and pool-minted assets are keyed in the pool registry by
their shared cross-chain id, so a bridged note and an ERC20-wrapped note of the
same asset are one confidential asset. Native ETH is registered under its
Bitcoin-side (tETH) link id, `0x3cba71e1…03126f34`, with scale 1e10.

| Token | Address | Asset id |
| --- | --- | --- |
| TAC | [`0x522101A9bDd348aCdD8C3d7B9eD6e64da6F52004`](https://etherscan.io/address/0x522101A9bDd348aCdD8C3d7B9eD6e64da6F52004) | `0xf0bbe868…3f94762b` |
| tacBTC (cBTC) | [`0x5572077d4C7E5a9f366f70b09131C4c46a7d58EE`](https://etherscan.io/address/0x5572077d4C7E5a9f366f70b09131C4c46a7d58EE) | `0x62a20d98…cf0679c8` |
| tacUSD (cUSD) | [`0x2CB2109aC1d80FDeB50ef8FD6EE44ca0a04a95d6`](https://etherscan.io/address/0x2CB2109aC1d80FDeB50ef8FD6EE44ca0a04a95d6) | `0xb097257e…63a20ecf` |

The cUSD asset id is `keccak256("tacit-cdp-debt-v1" ‖ engine)`, so it too is
specific to this suite's CollateralEngine.

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey | `0x00711089f0dc47b5512aae81461535cfd754ecbaec86dc88dc821c3ef1f4c0a4` |
| Bitcoin relay vkey | `0x00df27576a1b1c3f7055811045c9535e22298e7d816df1753a316007c7d30b02` |
| Ops multisig (engine admin) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25892003 |
| BTC anchor height (reflection seed) | 964471 |

The pool is deployed with a **fully-validated Bitcoin light relay** (full
proof-of-work, mainnet target floor) and the **immutable** SP1 Groth16 verifier
leaf — not the upgradeable gateway. Its reflection state resumes the shared
Bitcoin lane from the predecessor generation's attested digest at the anchor
height above.

## Generations & lifecycle

A `ConfidentialPool` is immutable and cannot be upgraded; the protocol evolves by
deploying a **new generation** that resumes from its predecessor's Bitcoin-reflection
digest. Each pool's single-use claim state — spent nullifiers, recorded bridge mints,
fast-lane consumes, cBTC locks, and known roots — is **local to that contract**, and
every proof is bound to its own pool (`chainId ‖ pool address`). Canonical tokens are
addressed by their minter, so a token minted by one pool is a distinct contract from
one minted by another.

Two consequences follow, and they are worth stating plainly:

- **No external party can affect a live pool by deploying its own.** Because state,
  backing, and proof-binding are all per-contract, anyone can deploy a look-alike or
  a shared-lineage pool, but it is an isolated island: it cannot spend this pool's
  escrow, mint this pool's tokens, or write this pool's state. Its only risk is the
  ordinary one of any imitation — users should transact only with the canonical
  addresses listed above.
- **Migration is drain-first.** Because a Bitcoin source is checked for single use
  *per pool*, the operational rule is that **at most one funded generation is live per
  lineage at a time**: a successor accepts value only after its predecessor is drained
  to zero. This is a property of how migrations are sequenced, not a control anyone
  else can influence.

A future Bitcoin protocol version may commit the generation identity into the
bridge/fast-lane records directly, making this a consensus rule rather than a
sequencing property; until then it is handled at migration time.
