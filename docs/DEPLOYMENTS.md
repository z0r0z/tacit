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
[`contracts/deployments/1.json`](../contracts/deployments/1.json); this page is
its human-readable mirror.

## Ethereum mainnet (chainId 1)

| Contract | Address |
| --- | --- |
| ConfidentialPool | [`0x0000000000f88564FCFe77d0D16c12dFdD7f717a`](https://etherscan.io/address/0x0000000000f88564FCFe77d0D16c12dFdD7f717a) |
| CollateralEngine | [`0x000000000043398698768C914B53Ae9E63B9EC32`](https://etherscan.io/address/0x000000000043398698768C914B53Ae9E63B9EC32) |
| CanonicalAssetFactory | [`0x000000000059B401D24F8381159157d21CF3bf64`](https://etherscan.io/address/0x000000000059B401D24F8381159157d21CF3bf64) |
| ConfidentialRouter | [`0x00000000005280f3497FDB6A2637b584320FA57d`](https://etherscan.io/address/0x00000000005280f3497FDB6A2637b584320FA57d) |
| TacitRelayer | [`0x000000000098714f55e9660c120baf5acd1095f8`](https://etherscan.io/address/0x000000000098714f55e9660c120baf5acd1095f8) |
| ChainlinkEthBtcAdapter | [`0x000000000082aD7DD5318E567Cba5710aA1Bd3DE`](https://etherscan.io/address/0x000000000082aD7DD5318E567Cba5710aA1Bd3DE) |
| BtcCallExecutor | [`0x00000000004b0ea73a7f669c1402bb445076bc2c`](https://etherscan.io/address/0x00000000004b0ea73a7f669c1402bb445076bc2c) |
| BitcoinLightRelay (header relay) | [`0x1677A5A3669a6D365431e916678566DAaa2e9094`](https://etherscan.io/address/0x1677A5A3669a6D365431e916678566DAaa2e9094) |

### Canonical bridged / pool-minted ERC20s

Each canonical ERC20 is minter-bound to the pool, so its address is unique to
this suite. Bridged and pool-minted assets are keyed in the pool registry by
their shared cross-chain id, so a bridged note and an ERC20-wrapped note of the
same asset are one confidential asset.

| Token | Address | Asset id |
| --- | --- | --- |
| TAC | [`0x59177Bf64244F79d35CC205C51d520BaeFf30AF7`](https://etherscan.io/address/0x59177Bf64244F79d35CC205C51d520BaeFf30AF7) | `0xf0bbe868…3f94762b` |
| cBTC | [`0x5f727E7EE4cDD38B13c9DAe910002fd3894e9A78`](https://etherscan.io/address/0x5f727E7EE4cDD38B13c9DAe910002fd3894e9A78) | `0x62a20d98…cf0679c8` |
| cUSD | [`0xa93e7e8ae66A2FAdc75893DdcA7d807e28133202`](https://etherscan.io/address/0xa93e7e8ae66A2FAdc75893DdcA7d807e28133202) | `0x1abcbdeb…4d7b0f7a` |

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey | `0x0093404c720746027ab2f9128272dc8015fd0fb810f6afa8b7cff09741b12c04` |
| Bitcoin relay vkey | `0x00b76e778f5e9d0c4a149e109f8bf05cfaf4685301dae8fd14839ef4e430decf` |
| Ops multisig (engine admin) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25510658 |
| BTC anchor height (reflection seed) | 957443 |

This suite is **mainnet-Mode-B-anchored**: the eth-reflection program re-anchored
to the Ethereum mainnet beacon at slot 14745600, so cross-chain (Mode B) value
folds are proven against the mainnet beacon rather than a testnet anchor.

The pool is deployed with a **fully-validated Bitcoin light relay** (full
proof-of-work, mainnet target floor) and the **immutable** SP1 Groth16 verifier
leaf — not the upgradeable gateway.

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
