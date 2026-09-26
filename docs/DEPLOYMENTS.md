# Deployed contracts

The `ConfidentialPool`, router, and SP1 guests are **immutable**: no proxy, no upgrade path, no pause switch,
and no admin key over escrow, exits or payouts. The pool's three privileged callers (the lineage steward, the
public AMM and the farm controller) are listed in [SPEC §7.1](../SPEC.md#71-immutable-surface); none can move a
note or escrow. The steward's one call, `createNextGen`, is described under [Lineage](#lineage).

The **`CollateralEngine`** (CDP/cUSD and cBTC escrow) is governed. Its owner is the ops multisig, which can
set the oracle and CDP parameters, drive cBTC-escrow enforcement and draw on the insurance reserve. Its
bounds are on-chain: capped ratios and fee, notice before borrower-adverse changes, and an immutable minimum
escrow grace window.

Every contract here is deployed at a deterministic CREATE3 address via
[CreateX](https://github.com/pcaversaccio/createx), so the same address is reproducible across chains.

The machine-readable source of truth is
[`contracts/deployments/1-createx.json`](../contracts/deployments/1-createx.json), written by
`DeployV1SuiteCreateX.s.sol` at broadcast. This page mirrors it. `tools/sync-deployment-config.mjs` writes it into
the dapp's deployment config, which the API also imports.

## Ethereum mainnet (chainId 1)

> **Live on mainnet since 2026-09-18.** Deploy block 25998736.

| Contract | Address |
| --- | --- |
| ConfidentialPool | [`0x000000000Ed1eabD231Be41d93b719056F7febFC`](https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC) |
| CollateralEngine | [`0x000000003f608BDdF0ca45934003ffb9DbDF70DB`](https://etherscan.io/address/0x000000003f608BDdF0ca45934003ffb9DbDF70DB) |
| CanonicalAssetFactory | [`0x0000000042c2D57499Df64BAF81bfA2C6E100535`](https://etherscan.io/address/0x0000000042c2D57499Df64BAF81bfA2C6E100535) |
| TacitPublicAmm | [`0x00000000E36C7EC997CC59DCda9E03673B448119`](https://etherscan.io/address/0x00000000E36C7EC997CC59DCda9E03673B448119) |
| ConfidentialRouter | [`0x000000005dA3E3B73726af3c774Deeb9472D4992`](https://etherscan.io/address/0x000000005dA3E3B73726af3c774Deeb9472D4992) |
| TacitRelayer | [`0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3`](https://etherscan.io/address/0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3) |
| BtcCallExecutor | [`0x00000000Df8263Ac5810C53B31AaE20ee53C247f`](https://etherscan.io/address/0x00000000Df8263Ac5810C53B31AaE20ee53C247f) |
| WstEthUsdFeed (the engine's BTC-per-wstETH price feed) | [`0x000000005010E4A43e83a658D36BF3ADb38ed62c`](https://etherscan.io/address/0x000000005010E4A43e83a658D36BF3ADb38ed62c) |
| EthCallOutbox (Ethereum→Bitcoin message outbox; pinned in the Bitcoin reflection guest) | [`0x00000000a26a6E291972666a9687741dBa11Af46`](https://etherscan.io/address/0x00000000a26a6E291972666a9687741dBa11Af46) |
| CbtcEscrowHelper (one-transaction wstETH escrow; bound to this engine) | [`0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA`](https://etherscan.io/address/0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA) |
| CbtcEscrowHelperTipForwarder (splits a tip off a self-proved escrow+settle call to the helper above) | [`0x000000006fcb52Aa67AC4A420a4D43A0e48F136F`](https://etherscan.io/address/0x000000006fcb52Aa67AC4A420a4D43A0e48F136F) |

Every row but CbtcEscrowHelper/CbtcEscrowHelperTipForwarder matches `contracts/deployments/1-createx.json`
exactly. Both are deployed by their own scripts (`DeployCbtcEscrowHelperCreateX.s.sol`,
`DeployCbtcEscrowHelperTipForwarderCreateX.s.sol`), and their addresses live in `contracts/deployments/1.json`
instead.

An earlier CbtcEscrowHelper (`0x00000000689c71e690e5842df088af97f9d4f71b`) and an earlier
CbtcEscrowHelperTipForwarder pointed at it (`0x000000fB551f7Ef4936a59ECdD431ae253139E8d`) remain deployed and
fully reachable — `reclaimEscrow` on the old helper still works for any escrow already posted through it —
but neither should be used for new deposits: the old forwarder credits its own address rather than the real
depositor for `helperEscrowOf`, so any NEW escrow posted through it would be unreachable by anyone. The
current helper adds `postEscrowWithETHAndSettleFor(outpoint, depositor, …)`, which the current forwarder
calls with the real caller as `depositor`, so new deposits routed through either helper's other entry points
or the current forwarder credit correctly.

Shared infrastructure outside the CreateX manifest:

| Contract | Address |
| --- | --- |
| BitcoinLightRelay (header relay) | [`0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0`](https://etherscan.io/address/0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0) |

### Canonical bridged / pool-minted ERC20s

Each canonical ERC20 is minted only by this pool, so its address is unique to this deployment. Bridged and
pool-minted assets are keyed by their shared cross-chain id, so a bridged note and an ERC20-wrapped note of the
same asset are one confidential asset ([SPEC §4.2](../SPEC.md#42-assets-and-units)). Native ETH is registered
under its Bitcoin-side (tETH) link id, `0x3cba71e1…03126f34`, with scale 1e10.

| Token | Address | Asset id |
| --- | --- | --- |
| TAC | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) | `0xf0bbe868…3f94762b` |
| tacBTC (cBTC) | [`0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696`](https://etherscan.io/address/0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696) | `0x62a20d98…cf0679c8` |
| tacUSD (cUSD) | [`0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564`](https://etherscan.io/address/0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564) | `0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d` |

The cUSD asset id is `keccak256("tacit-cdp-debt-v1" ‖ engine)`, so it is specific to this CollateralEngine.

### TAC

TAC is the protocol's native asset ([SPEC §7.3](../SPEC.md#73-tac)): "Tacit Coin" on Bitcoin, "Tacit Token" as
its Ethereum ERC-20 name. Issued once via `T_CETCH` with a zero mint authority, so its supply is fixed and
untouched since.

| Field | Value |
| --- | --- |
| Asset id (the canonical Tacit protocol id, both chains) | `0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b` |
| Genesis (`T_CETCH` reveal) | [`e2d10be1…ee2ca481e`](https://mempool.space/tx/e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e), height 948242 (2026-05-07) |
| Total supply | 21,000,000 TAC — the on-chain commitment opens to this exactly; the `(supply, blinding)` is disclosed and pinned at [its metadata CID](https://ipfs.filebase.io/ipfs/bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai), so anyone can re-derive and check it against the chain alone |
| Logo | [PNG, pinned on IPFS](https://ipfs.filebase.io/ipfs/bafkreibwpxssdmoczx75vsqmk5vpdyztwwz3qmykpucn5xow64ku5ht46m) alongside the CETCH metadata (also `dapp/tac-logo.png` in this repo); the SVG mark inlined on-chain in [TAC's token.list.wei listing](https://token.list.wei.limo) is mirrored at [`assets/tac-onchain.svg`](../assets/tac-onchain.svg) |
| Ethereum ERC-20 | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) |
| Buyback | [`TacBuyback` `0x6919cbEf0e70AFFA02Ae02c86c532A137154f250`](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250): buys TAC for the reserve (the ops multisig) on the public TAC/ETH market; see [`TAC.md`](./TAC.md) |
| Bridged supply | the ERC-20's live `totalSupply()` — currently ~2.5M TAC, all of it minted only against a proven Bitcoin-side burn |
| Bitcoin activity | ~1,957 holders; 4,166 confidential transfers; 229 orderbook trades against real BTC since 2026-05-24 |

**A full round trip, ETH → BTC → ETH**, each leg a real settled transaction: a pool crossOut
([`0xc7bfc7ce…3c29a8f`](https://etherscan.io/tx/0xc7bfc7cec938e59c5d256d1c44c2aea5269eb7c237ac018878f21b2a93c29a8f)),
its Bitcoin-side re-mint (commit [`285bea41…60c10b`](https://mempool.space/tx/285bea41d08e51233a73b3b33630ce6053878a78f217f1c9f58e0b616e60c10b)
/ reveal [`aaa68792…97bcf2`](https://mempool.space/tx/aaa687924435ef64f056aa83beb7fabef4f57087f315655b52c596f83897bcf2)),
a return burn on Bitcoin (commit [`2d98a89e…3117944`](https://mempool.space/tx/2d98a89e53c9266ab4fd8bfac1b93e3ae43410b5721eb08ca85ff36c73117944)
/ reveal [`7320b6b6…36b0fbb`](https://mempool.space/tx/7320b6b654726ba99489bcf47f3d31dcf8a87040241def827b5fccd8836b0fbb)),
and the mint back on Ethereum
([`0f0793f6…006465bb`](https://etherscan.io/tx/0x0f0793f61e57a0eb40ef551ef516e9a33ba0f270343abedf4ea014aa006465bb)) —
the same note, both chains, proven twice.

### cBTC, cUSD and tETH

Unlike TAC, cBTC and cUSD are pool-minted, not Bitcoin-issued: neither has a `T_CETCH` genesis, and
neither has been unwrapped to its public ERC-20 form yet — `tacBTC`
([`0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696`](https://etherscan.io/address/0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696))
and `tacUSD`
([`0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564`](https://etherscan.io/address/0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564))
both read `totalSupply() == 0` on mainnet today, so what's minted so far lives entirely as confidential
pool notes. Icons: [`cbtc-zk-icon.svg`](../contracts/tokenlist-drafts/cbtc-zk-icon.svg) and
[`cusd-zk-icon.svg`](../contracts/tokenlist-drafts/cusd-zk-icon.svg), standalone marks distinct from the
composite cBTC/TAC and cUSD/TAC pairing icons elsewhere in `contracts/`.

**cBTC** mints against real Bitcoin locks ([SPEC §5.7](../SPEC.md#57-cdp-cusd-and-cbtc)): `cbtcBackingSats()`
on the pool — the cumulative value of every `T_CBTC_LOCK` reflection has recorded — currently reads
**6,800 sats** (`cast call` against the live pool). Of that, three locks (`cbtcLockVBtc` of 700, 700 and
2,000 sats, each independently confirmed live) have cleared the 1.5× wstETH escrow gate and actually
minted; the remaining lock sits under-escrowed and correctly stays unmintable.

**cUSD** mints as CDP debt against cBTC collateral, at the same 150% mint / 130% liquidation thresholds
([SPEC §5.7](../SPEC.md#57-cdp-cusd-and-cbtc)). `CollateralEngine.outstandingCusd()` currently reads
**49,815,650** (in-system units) across the engine's two currently-open positions; the insurance reserve is
still empty (nothing has ever been liquidated). Three real `CdpMinted` mints and one `CdpClosed` close, all
on the current engine:
[`0xb4a1f32d…afa7d4908`](https://etherscan.io/tx/0xb4a1f32d80ff1cd413d58023811eaafa8aed3388d3fa82741f52f06afa7d4908),
[`0x6da330c1…ebceaccb479b3229`](https://etherscan.io/tx/0x6da330c161f236030ef83ce5c9c77268c735a52e7f9789c7ebceaccb479b3229)
(open), [`0x23851ea3…14e44232e`](https://etherscan.io/tx/0x23851ea3ec4c0434940a1120505b0efe1878023e3d6faac9cea41ad14e44232e)
(closed), [`0x5f20ec5c…ffe52ec`](https://etherscan.io/tx/0x5f20ec5cc1dc1ecd31cd8f60970e8947ca61165500dbb4cb27bb9c048ffe52ec)
(open).

**tETH** is not a separate asset from cETH — it's the same shared asset id
(`0x3cba71e1…03126f34`, [SPEC §4.2](../SPEC.md#42-assets-and-units)) named by chain context: "cETH" when
you're wrapping native ETH into the pool from Ethereum, "tETH" when the same note is spent on Bitcoin.
There's no bridge or swap between the two names, and no separate tETH ERC-20 — one note, read either way.
It has its own standalone Bitcoin-side mark: [`teth.svg`](../contracts/teth.svg) /
[`teth-icon.svg`](../contracts/teth-icon.svg), a "T" in Ethereum's brand purple. It's the asset the
[Bitcoin-native AMM pool](#bitcoin-native-amm-pool) actually trades: its founding reserves are tETH against
TAC.

### TAC launch farms

A reward program on the pool, outside the CreateX manifest. The `FarmManager` is a pool controller (the pool
calls it during a settle, [SPEC §5.8](../SPEC.md#58-farms-and-locks)) and pays in **wTAC**, a 1:1 ERC20 wrapper
of TAC registered in the pool as an escrow asset. The dapp reads it from the `farm` block of its deployment
config. Integrator guide: [`FARMS.md`](./FARMS.md).

| Contract | Address |
| --- | --- |
| FarmManager (CREATE3, Etherscan-verified; 3 pools, no lock) | [`0x000031C47Cb61faB1CE2790a69625FABB71EDE24`](https://etherscan.io/address/0x000031C47Cb61faB1CE2790a69625FABB71EDE24) |
| WrappedTac (wTAC, 1:1 wrapper of the TAC ERC20) | [`0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf`](https://etherscan.io/address/0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf) |
| TacFarmFunder (wrap TAC to wTAC and escrow it in one transaction) | [`0x7fc40b13c7a99a1d2c41f8b5382978363d18525a`](https://etherscan.io/address/0x7fc40b13c7a99a1d2c41f8b5382978363d18525a) |

| Field | Value |
| --- | --- |
| wTAC asset id (reward) | `0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832` |
| Pool 0, TAC / cETH (weight 50) | LP-share id `0x17c56713…9249ef99`, pool id `0x248497bf…11dc7c00` |
| Pool 1, cETH / cUSD (weight 30) | LP-share id `0xd608b0c3…45262571`, pool id `0x5925c0c2…4e909da7` |
| Pool 2, cETH / cBTC (weight 20) | LP-share id `0x0a0cce17…48b68254`, pool id `0x8359cd1f…bf5cd331` |
| Epoch 1 | 99,700 TAC over 90 days from 2026-09-21; stream end (unix) `1797712559` |
| Governor | the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` (accepted from the deployer in `0x6074f810491dff24cf130490ac55f9994c953cf1dab852f180003b7646735f39`) |

Weights are governed on-chain and can change (timelocked, bounded), so read `poolInfo(pid)` for the live values.
Full ids are in [`FARMS.md`](./FARMS.md).

### Bitcoin-native AMM pool

A pool founded directly on Bitcoin via `T_LP_ADD` variant 1 (`POOL_INIT`, [SPEC §5.5](../SPEC.md#55-amm)) — no
Ethereum contract, no CreateX manifest. Reserves and LP shares are ordinary Tacit assets the indexer tracks
from the chain alone, the same as any other Bitcoin-side pool.

| Field | Value |
| --- | --- |
| Pool, tETH / TAC | pool id `0xaa3eab26…33eb79`, LP-share id `0x1f117528…d8dd8c3` |
| Founding reserves | 0.0002 tETH / 1.82704255 TAC |
| Founder LP shares | 1,910,566 (of 1,911,566 total; 1,000 locked as `MINIMUM_LIQUIDITY`) |
| Commit / reveal | [`1ab6e965…144a9e04c`](https://mempool.space/tx/1ab6e965474ca6e09e23117c151a779c981643f7bb2aa930e40995d144a9e04c) / [`665bdd4b…c2437bd5`](https://mempool.space/tx/665bdd4b1b9d6220d62aa3d154a8de9870dd9a9ae92658ab03452660c2437bd5) |

Live in the indexer since 2026-09-25 (`GET /amm/pool/aa3eab26…33eb79` returns `validation: "xcurve-verified"`),
funded directly from Bitcoin-side notes with no intervening bridge hop.

### Verification anchors

| Field | Value |
| --- | --- |
| SP1 verifier (immutable Groth16 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| Program vkey (settle guest) | `0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3` |
| Bitcoin relay vkey (Bitcoin reflection guest) | `0x00bb158ba04f18a100f998af0e3b074b5368771f22b8b6e4fd1d66823a074bc5` |
| Eth reflection vkey (Ethereum reflection guest) | `0x00ca817124b59c05eb6f2731d48a6d7145dc4aff06510e0ba710a7312f6aea72` |
| Swap-batch Groth16 key (compiled into both guests) | `batch_vk.bin` SHA-256 `31fd05cc…bbc7c`; final zkey `bafybeieb5hafaix2xwvnmsodby4vkvcpdv4bpt4ny3etza4lpy2rxefwqm` ([ceremony artifacts](./CEREMONY.md)) |
| Reflection confirmations | 24 |
| Ops multisig (engine admin and the pool's lineage steward) | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Deploy block | 25998736 |
| BTC anchor height (reflection seed) | 967040 |

### Key-only recovery reads

What [key-only recovery](./RECOVERY.md) reads besides the pool's note events.

| Read | Value |
| --- | --- |
| `Wrap(depositId, assetId, amount)` | pool event; deposit ids matched to the wallet's derived wrap notes |
| `CdpPositionInserted(leaf)` | pool event; the position's fields are in that settle's calldata |
| `Bonded(receipt, pid, shares, unlockAt)` | FarmManager event; matched to receipts derived from the wallet key |
| `cbtcLockVBtc(outpoint)` | pool view; the recorded value of a cBTC lock |
| `lockSpent` (mapping, storage slot 119) | pool storage, keyed by the lock nullifier; set once a lock is claimed or refunded |
| `cdpPositionSpent` (mapping, storage slot 163) | pool storage, keyed by the position nullifier; set once a position is closed |

The three guest ELFs behind these keys rebuild byte for byte; see [Reproducible builds](./REPRODUCIBLE-BUILDS.md).

The pool uses a fully validated Bitcoin header relay (full proof-of-work, mainnet target floor) and the
immutable SP1 Groth16 verifier, not the upgradeable gateway. Its reflection state starts from an attested
Bitcoin digest at the anchor height above.

## TAC airdrop (merkle distributor)

| | |
|---|---|
| `TacAirdrop` | `0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8` (Etherscan-verified, deployed 2026-09-21 20:52 UTC, block 26028383) |
| Token | the public TAC, `0xA1313eb9f3A445606D9583bcAc3ebeB56a858279` |
| Root | `0x27451b320d5aa9631f7a3fd8adcfa537db8d792dd49aad9ab0951af0c2986a10` (8,652 recipients, 999,999 TAC) |
| Guardian | the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |
| Claim deadline | 1797803449 (2026-12-20 21:50 UTC) |
| Proof files | `dapp/airdrop/v1/proofs`, served at `https://tacit.finance/airdrop/v1/proofs/<xx>.json` (`<xx>` is the first byte of the lowercase address) |
| Client | [`dapp/tac-airdrop.js`](../dapp/tac-airdrop.js), `tacit.tacAirdrop` on the pool ux |

Roles, claim paths, the emergency sweep and the runbook are in [`AIRDROP.md`](./AIRDROP.md); the inputs and how to rebuild the root are in
[`airdrop/v1/README.md`](../airdrop/v1/README.md).

## Lineage

A `ConfidentialPool` cannot be upgraded. The protocol evolves by deploying a successor that users opt into by
exiting one pool and entering the next ([SPEC §8](../SPEC.md#8-deployment-lineage)). The current pool is the
root of its lineage.

- **Isolation.** Each pool's claim state (nullifiers, bridge mints, fast-lane consumes, cBTC locks and roots)
  is local to that contract. Every proof is bound to `chainId ‖ pool address`, and canonical tokens are
  addressed by their minter. A look-alike pool deployed by anyone else cannot spend this pool's escrow, mint
  its tokens or write its state; users should transact only with the addresses above.
- **One pool takes new value.** Setting `successor` closes this pool to new value, so at most one pool per
  lineage accepts it at a time.

### The lineage steward

The steward's entry point is `createNextGen(initCode, salt)`. Only the pool's immutable
`LINEAGE_STEWARD` (the ops multisig above) can call it, and only once. It deploys the successor from the
pool's own address and records it as `successor`, and that is the whole of its authority: the steward
chooses the successor's code and nothing else. `pool.successor()` reads zero while this pool is active. When
it is set, the pool emits `GenerationRetired(successor)`.

Once `successor` is set, the pool closes to new value:

- **Refused:** wraps of external assets, swaps, liquidity adds, cBTC mints, new CDP positions, farm bonds
  and surplus draws, public-AMM entry, farm funding, and any spend of a Bitcoin-homed note.
- **Still open:** every exit and every release of value already committed. That covers unwraps and
  transfers, liquidity removals, position closes, top-ups and liquidations, farm harvests, stealth and
  adaptor claims and refunds, deposits already escrowed, mints of Bitcoin burns that targeted this pool,
  and burning its own canonical token back into a note.
- **Cross-outs** reopen once the pool has written its handoff record, at its first attest after
  retirement. Its Bitcoin reflection stays open throughout.

The steward cannot touch escrow, freeze an exit, redirect a payout or set `successor` a second time.
