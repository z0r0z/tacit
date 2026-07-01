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
| ConfidentialPool | [`0x00000000002Af3e631ddC7c2CCebd97956d8bb0E`](https://etherscan.io/address/0x00000000002Af3e631ddC7c2CCebd97956d8bb0E) |
| CollateralEngine | [`0x0000000000Ed3F648615972f36f0161dF5413B28`](https://etherscan.io/address/0x0000000000Ed3F648615972f36f0161dF5413B28) |
| CanonicalAssetFactory | [`0x000000000059B401D24F8381159157d21CF3bf64`](https://etherscan.io/address/0x000000000059B401D24F8381159157d21CF3bf64) |
| ConfidentialRouter | [`0x0000000000cE1cB94Caa6cde60aCc85d6532a6ff`](https://etherscan.io/address/0x0000000000cE1cB94Caa6cde60aCc85d6532a6ff) |
| TacitRelayer | [`0x0000000000e5b70e9cefFBAe41A839108B28D266`](https://etherscan.io/address/0x0000000000e5b70e9cefFBAe41A839108B28D266) |
| ChainlinkEthBtcAdapter | [`0x00000000005ce234E5130727edeDFD80343DD415`](https://etherscan.io/address/0x00000000005ce234E5130727edeDFD80343DD415) |
| BtcCallExecutor | [`0x00000000005c74049dE8A69De17e9565332951DF`](https://etherscan.io/address/0x00000000005c74049dE8A69De17e9565332951DF) |
| BitcoinLightRelay (header relay) | [`0x1677A5A3669a6D365431e916678566DAaa2e9094`](https://etherscan.io/address/0x1677A5A3669a6D365431e916678566DAaa2e9094) |

### Canonical bridged ERC20s (minted by the pool)

| Token | Address |
| --- | --- |
| tacBTC | [`0xAF064d09CFC3aD37CF72807e16BDbD1506805338`](https://etherscan.io/address/0xAF064d09CFC3aD37CF72807e16BDbD1506805338) |
| tacUSD | [`0xDF260B99650daAbB9ae6c61deFEf4B7f586e32AE`](https://etherscan.io/address/0xDF260B99650daAbB9ae6c61deFEf4B7f586e32AE) |

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey | `0x0079b7559416907fe29e534cb81ed19ad67436734bb324821e855bf30505f55b` |
| Bitcoin relay vkey | `0x0012ef33fcb522d8006ed4324ecf1e5dff1cb3f1d9891ae587d096289f06ca67` |
| Ops multisig (engine admin) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25438725 |
| BTC anchor height | 956223 |

The pool is deployed with a **fully-validated Bitcoin light relay** (full
proof-of-work, mainnet target floor) and the **immutable** SP1 Groth16 verifier
leaf — not the upgradeable gateway.
