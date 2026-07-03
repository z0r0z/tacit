# Deployed contracts

All Tacit V1 contracts are **immutable** (no proxy, no admin upgrade path) and
deployed at deterministic CREATE3 vanity addresses via
[CreateX](https://github.com/pcaversaccio/createx) — so the same address is
reproducible across chains. Every address below is verified on Etherscan.

The machine-readable source of truth is
[`contracts/deployments/1.json`](../contracts/deployments/1.json); this page is
its human-readable mirror.

## Ethereum mainnet (chainId 1)

| Contract | Address |
| --- | --- |
| ConfidentialPool | [`0x000000000049Cc3f65588E74d9c25B66781da8dB`](https://etherscan.io/address/0x000000000049Cc3f65588E74d9c25B66781da8dB) |
| CollateralEngine | [`0x00000000008b177D7E1a5BC7A036dD72B330C97C`](https://etherscan.io/address/0x00000000008b177D7E1a5BC7A036dD72B330C97C) |
| CanonicalAssetFactory | [`0x000000000059B401D24F8381159157d21CF3bf64`](https://etherscan.io/address/0x000000000059B401D24F8381159157d21CF3bf64) |
| ConfidentialRouter | [`0x00000000004eEC8e98c3acb45eE854C27A1da754`](https://etherscan.io/address/0x00000000004eEC8e98c3acb45eE854C27A1da754) |
| TacitRelayer | [`0x0000000000634b90b64c07a94EbD5983AF833407`](https://etherscan.io/address/0x0000000000634b90b64c07a94EbD5983AF833407) |
| ChainlinkEthBtcAdapter | [`0x0000000000826721f2B5D55a1A67c7229Db4EE38`](https://etherscan.io/address/0x0000000000826721f2B5D55a1A67c7229Db4EE38) |
| BtcCallExecutor | [`0x0000000000B72F79B78d14365FeCf486D0Ead8C0`](https://etherscan.io/address/0x0000000000B72F79B78d14365FeCf486D0Ead8C0) |
| BitcoinLightRelay (header relay) | [`0x1677A5A3669a6D365431e916678566DAaa2e9094`](https://etherscan.io/address/0x1677A5A3669a6D365431e916678566DAaa2e9094) |

### Canonical bridged ERC20s (minted by the pool)

| Token | Address |
| --- | --- |
| tacBTC | [`0x92987ddcA71C15FdC554947Bf7be2157d90FD047`](https://etherscan.io/address/0x92987ddcA71C15FdC554947Bf7be2157d90FD047) |
| tacUSD | [`0x5Db7f31e116e26D024526e0b5b889430B775333C`](https://etherscan.io/address/0x5Db7f31e116e26D024526e0b5b889430B775333C) |

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey | `0x0093404c720746027ab2f9128272dc8015fd0fb810f6afa8b7cff09741b12c04` |
| Bitcoin relay vkey | `0x00de8331bd06d7150c49218de747dba446615d0081e139b1f41a9c3e7e827583` |
| Ops multisig (engine admin) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25444513 |
| BTC anchor height | 956223 |

The pool is deployed with a **fully-validated Bitcoin light relay** (full
proof-of-work, mainnet target floor) and the **immutable** SP1 Groth16 verifier
leaf — not the upgradeable gateway.
