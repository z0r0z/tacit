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

> **gen5 — live on mainnet 2026-09-18.** Deploy block 25998736. Resumes gen4's shared Bitcoin
> reflection state exactly (no catch-up gap); the previous generation's addresses are retained in
> git history for reference.

| Contract | Address |
| --- | --- |
| ConfidentialPool | [`0x000000000Ed1eabD231Be41d93b719056F7febFC`](https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC) |
| CollateralEngine | [`0x000000003f608BDdF0ca45934003ffb9DbDF70DB`](https://etherscan.io/address/0x000000003f608BDdF0ca45934003ffb9DbDF70DB) |
| CanonicalAssetFactory (reused from gen4, unchanged) | [`0x0000000042c2D57499Df64BAF81bfA2C6E100535`](https://etherscan.io/address/0x0000000042c2D57499Df64BAF81bfA2C6E100535) |
| TacitPublicAmm | [`0x00000000E36C7EC997CC59DCda9E03673B448119`](https://etherscan.io/address/0x00000000E36C7EC997CC59DCda9E03673B448119) |
| ConfidentialRouter | [`0x000000005dA3E3B73726af3c774Deeb9472D4992`](https://etherscan.io/address/0x000000005dA3E3B73726af3c774Deeb9472D4992) |
| TacitRelayer | [`0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3`](https://etherscan.io/address/0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3) |
| BtcCallExecutor | [`0x00000000Df8263Ac5810C53B31AaE20ee53C247f`](https://etherscan.io/address/0x00000000Df8263Ac5810C53B31AaE20ee53C247f) |
| Adapter (zRouter/zap integration) | [`0x000000005010E4A43e83a658D36BF3ADb38ed62c`](https://etherscan.io/address/0x000000005010E4A43e83a658D36BF3ADb38ed62c) |
| EthCallOutbox (BTC-authorized call outbox, reverse ETH→BTC lane; guest-pinned per generation) | [`0x00000000a26a6E291972666a9687741dBa11Af46`](https://etherscan.io/address/0x00000000a26a6E291972666a9687741dBa11Af46) |
| CbtcEscrowHelper (one-tx escrow convenience; deployed separately, after CollateralEngine — its constructor binds to the engine's address, so as of gen5 it's per-generation, not shared infra) | [`0x00000000689c71e690e5842df088af97f9d4f71b`](https://etherscan.io/address/0x00000000689c71e690e5842df088af97f9d4f71b) |

These match `contracts/deployments/1-createx.json` exactly (deploy block 25998736) — that
manifest is the actual source of truth; re-run `tools/sync-deployment-config.mjs` and refresh
this table from it after any redeploy rather than hand-editing addresses here.

One more contract is live but generation-independent — shared infra the manifest above
doesn't track because it isn't part of the per-generation CreateX redeploy:

| Contract | Address |
| --- | --- |
| WstEthUsdFeed (BTC-per-wstETH adapter) | [`0x0000000000BfA0573fA22DaEd427545baa9b18cF`](https://etherscan.io/address/0x0000000000BfA0573fA22DaEd427545baa9b18cF) |
| BitcoinLightRelay (header relay, reused from gen4, unchanged) | [`0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0`](https://etherscan.io/address/0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0) |

### Canonical bridged / pool-minted ERC20s

Each canonical ERC20 is minter-bound to the pool, so its address is unique to
this suite. Bridged and pool-minted assets are keyed in the pool registry by
their shared cross-chain id, so a bridged note and an ERC20-wrapped note of the
same asset are one confidential asset. Native ETH is registered under its
Bitcoin-side (tETH) link id, `0x3cba71e1…03126f34`, with scale 1e10.

| Token | Address | Asset id |
| --- | --- | --- |
| TAC | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) | `0xf0bbe868…3f94762b` (unchanged) |
| tacBTC (cBTC) | [`0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696`](https://etherscan.io/address/0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696) | `0x62a20d98…cf0679c8` (unchanged) |
| tacUSD (cUSD) | [`0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564`](https://etherscan.io/address/0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564) | `0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d` |

The cUSD asset id is `keccak256("tacit-cdp-debt-v1" ‖ engine)`, so it too is
specific to this suite's CollateralEngine.

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf, reused from gen4) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey (settle guest) | `0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3` |
| Bitcoin relay vkey (reflection guest) | `0x00bb158ba04f18a100f998af0e3b074b5368771f22b8b6e4fd1d66823a074bc5` |
| Eth reflection vkey (eth-reflection guest) | `0x00ca817124b59c05eb6f2731d48a6d7145dc4aff06510e0ba710a7312f6aea72` |
| Reflection confirmations | 24 (gen4 uses 6) |
| Ops multisig (engine admin, unchanged) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25998736 |
| BTC anchor height (reflection seed) | 967040 |

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
