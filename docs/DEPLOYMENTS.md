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
| ConfidentialPool | [`0x0000000000dc5A8083a1E00363f2aCDAd9e6fFEd`](https://etherscan.io/address/0x0000000000dc5A8083a1E00363f2aCDAd9e6fFEd) |
| CollateralEngine | [`0x0000000000E38DFE8156220705a9Cb7Af3CbDd70`](https://etherscan.io/address/0x0000000000E38DFE8156220705a9Cb7Af3CbDd70) |
| CanonicalAssetFactory | [`0x000000000059B401D24F8381159157d21CF3bf64`](https://etherscan.io/address/0x000000000059B401D24F8381159157d21CF3bf64) |
| ConfidentialRouter | [`0x00000000008Fe3728105e9D561b9F6358CC6fC49`](https://etherscan.io/address/0x00000000008Fe3728105e9D561b9F6358CC6fC49) |
| TacitRelayer | [`0x00000000005E04968e39a2E19eB19A1580B19178`](https://etherscan.io/address/0x00000000005E04968e39a2E19eB19A1580B19178) |
| ChainlinkEthBtcAdapter | [`0x00000000004e097ec24eaDc6C4198949CD2F1922`](https://etherscan.io/address/0x00000000004e097ec24eaDc6C4198949CD2F1922) |
| BtcCallExecutor | [`0x0000000000E17970238B6F7F3AbcEeAAecD3a0dE`](https://etherscan.io/address/0x0000000000E17970238B6F7F3AbcEeAAecD3a0dE) |
| BitcoinLightRelay (header relay) | [`0x1677A5A3669a6D365431e916678566DAaa2e9094`](https://etherscan.io/address/0x1677A5A3669a6D365431e916678566DAaa2e9094) |

### Canonical bridged ERC20s (minted by the pool)

| Token | Address |
| --- | --- |
| tacBTC | [`0x5163375A1d674f72012B447429Fd9a283672b281`](https://etherscan.io/address/0x5163375A1d674f72012B447429Fd9a283672b281) |
| tacUSD | [`0x285daf73be5ef22da0b46d02f0cc1e5e2c707c8e`](https://etherscan.io/address/0x285daf73be5ef22da0b46d02f0cc1e5e2c707c8e) |

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey | `0x0079b7559416907fe29e534cb81ed19ad67436734bb324821e855bf30505f55b` |
| Bitcoin relay vkey | `0x0012ef33fcb522d8006ed4324ecf1e5dff1cb3f1d9891ae587d096289f06ca67` |
| Ops multisig (engine admin) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25444513 |
| BTC anchor height | 956223 |

The pool is deployed with a **fully-validated Bitcoin light relay** (full
proof-of-work, mainnet target floor) and the **immutable** SP1 Groth16 verifier
leaf — not the upgradeable gateway.
