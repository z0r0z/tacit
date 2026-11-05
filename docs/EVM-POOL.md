# EVM pool: integration guide

A native-ETH shielded pool that users prove on their own device. Balances are fungible notes of any amount; a
single transaction can deposit, pay someone privately with change, withdraw, and pay a relayer. The contracts are
immutable: no owner, no pause, no upgrade. Design and measurements: [`DESIGN-evm-client-pool.md`](../contracts/sp1/confidential/DESIGN-evm-client-pool.md).

**Status.** The circuit's public trusted-setup ceremony is closed: 176 contributions, sealed with Bitcoin block
968840 as the beacon. The full suite is live at the addresses below on Ethereum, Base and Robinhood Chain, and the core
(pool, router, verifier) on MegaETH; deploy blocks and transactions are in
[`contracts/deployments/evm-pool.json`](../contracts/deployments/evm-pool.json). Scan events from each chain's deploy block.

**Which pool.** This is the smaller of Tacit's two pools: one fixed circuit, ETH only, multichain, with no
prover but the user's own device. For DeFi (swap, LP, lend, farm, OTC, bids), multi-asset notes, or the
Bitcoin bridge, see [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) — the confidential pool on Ethereum
mainnet, one SP1 program for every op. The two pools share nothing on chain; a hop between them is a public
exit/entry (["Moving between V1 and this pool"](#moving-between-v1-and-this-pool)).

## Where to use it

| App | What it is | Chains |
|---|---|---|
| [anon.wei.limo](https://anon.wei.limo/) | The reference app: one page that shields, sends privately, withdraws, takes payments at a deposit address, and shields from or withdraws as a token. Also served by name as `anon.wei` ([the reference app](#the-reference-app-anonwei)). | Ethereum, Base, Robinhood Chain |
| [tacit.finance/pay/eth](https://tacit.finance/pay/eth/), and "On this device" on the [tacit.finance](https://tacit.finance/) front page | The same pool without token swaps: shield, send, withdraw, a deposit address, payment links. On Ethereum an asset row under the chain row picks the private USDC, USDT and TAC pools beside ETH ([addresses](#addresses)): each its own balance, deposit (a permit signed for its router, else the approval in one batch with it, else an approval first), private send, withdrawal through the relay (its fee in the token) or the wallet, and Receive, whose payment link and QR name the token (`#pay=…&asset=usdc&amount=25`); one Tacit address takes payments in any of them. The front page's Send tab offers the same three (balance, relay fee in the token, then the device sheet's form with the address and the amount filled). | Ethereum, Base, Robinhood Chain and **MegaETH** (the token pools: Ethereum) |
| [tacit.finance](https://tacit.finance/#card=swap), the front page's Swap tab, "Swap privately" | A swap in two halves: the wallet's ETH or a token deposited now (into the ETH pool, a token through the zap, below, or into the token's own pool where it is open, [addresses](#addresses)); later the swap's share withdrawn into a swap that pays another address (withdraw-and-call, sent by the keeper), the rest left a note. | Ethereum |
| [Secret Sats](https://tacit.finance/sats/), ETH tab | The same pool beside the Bitcoin pool: one address (`bp1…`) receives in both. | Ethereum, Base, Robinhood Chain |
| [The standalone wallet](#standalone-wallet) | The whole wallet as one ES module, for your own app. | Ethereum, Base, Robinhood Chain and MegaETH |
| Your own app | The contracts are at the same addresses on every chain they are on ([build one](#megaeth-and-building-an-app-on-another-chain)). | Any chain with the suite |

**MegaETH** has the core: the pool, router, verifier, deposit addresses, a relay and withdraw-and-call. It has no token
swaps, because zRouter, zQuoter and the token list are not deployed there. The standalone wallet knows it; the
tacit.finance pages and anon.wei list the other three chains. See
[Swaps and zaps](#swaps-and-zaps) and [MegaETH](#megaeth-and-building-an-app-on-another-chain).

## Addresses

The same on Ethereum (1), Base (8453), Robinhood Chain (4663) and MegaETH (4326), the chains the suite is deployed on
(CreateX CREATE3, salts locked to deployer `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`; no other sender can deploy at
these addresses). On any other chain, treat code at these addresses as unrelated.

| Contract | Address |
|---|---|
| Pool (`TacitEvmPool`, native ETH) | `0x000000c2A20657CE25f2Ba99737933D031AFBEE9` |
| Router (`TacitEvmPoolRouter`) | `0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5` |
| Groth16 verifier | `0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153` |
| PoseidonT5 (four-input Poseidon, used by receive boxes) | `0x555333f3f677Ca3930Bf7c56ffc75144c51D9767` |
| Zap (`TacitEvmPoolZap`, shields a token in one transaction; not on MegaETH) | `0x0000008EbBF2323f95c4fBc18254f3D65C53998c` |

**The TAC vaults' token pools, on Ethereum only: TAC, TACD and TACE.** `TacitEvmPool` takes its asset in its constructor and the
proof's `asset` input is `keccak256(abi.encode(chainId, pool, token)) mod p`, so the same circuit, proving key and verifier serve an
ERC-20 pool. Three were deployed with the TAC vaults ([`contracts/deployments/tac-vaults.json`](../contracts/deployments/tac-vaults.json)),
for TAC and the vaults' two synths, TACD (a dollar) and TACE (an ether); each pool's first block is 26,201,971 and its router's 26,201,972.
The relay serves them: the keeper service runs one keeper per pool beside the ETH pool's, at
`https://tacit-evm-pool-keepers.onrender.com/1-tac/evm-pool/keeper` (and `/1-tacd/`, `/1-tace/`), with the same routes as every
keeper (quote, relay, deposit boxes, receive boxes, the history feed). They send from the Ethereum keeper's address,
`0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0` (one wallet for the gas, its sends in one queue), which fronts the gas in ETH and is paid in
the pool's token: the fee for a relay is its
gas, plus the keeper's margin, at the token's price in ETH, which the keeper reads from the chain every minute (TAC: the lower of the
two venues' spot prices the vaults' pair oracle `0x000000cE58D7…1271` reads; TACD: a dollar at Chainlink's ETH/USD; TACE: one ETH). With no
price it can read for a quarter of an hour, it refuses fees in that token rather than guess. A wallet can still send anything itself, paying
the network fee in ETH. A deposit goes through the router, which takes the token from an allowance already in place, an EIP-2612 permit
(`depositWithPermit`) or a Permit2 signature (`depositWithPermit2`), so a signature can stand in for the approval; the "On this device" TAC
pool on the [tacit.finance](https://tacit.finance/) front page asks for them in that order, then an approval and the deposit in one
EIP-5792 batch, and only otherwise an approval transaction first, always for exactly the deposit's amount.

| Contract | Address (Ethereum) |
|---|---|
| TAC pool (`TacitEvmPool`, asset TAC `0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`) | `0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe` |
| TAC router (`TacitEvmPoolRouter`, bound to the TAC pool) | `0x000000fA029Eaf69840C1490Bf9AA6C094794D5a` |
| TACD pool (asset TACD `0xA0f6B02561C8ef08335B69aD25e022C0B342147C`) and router | `0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA`, `0x000000e96fcFf90F220fa65F8b82C6114Cd1Cc30` |
| TACE pool (asset TACE `0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570`) and router | `0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1`, `0x000000e66C32bEC739180A5eDeeB40A8225c5223` |

**Any other ERC-20: a pool anyone opens, on Ethereum.** Every other token's pool is the same two contracts with that token as the asset:
`TacitEvmPool(verifier, token)` and its own `TacitEvmPoolRouter(pool, zRouter, Permit2, V1, PoseidonT5)` (a router is bound to one pool and
takes its token by an allowance, an EIP-2612 permit, Permit2 or a wallet batch, so no other router is needed). Both sit at CreateX CREATE2
addresses fixed by the token alone, under open salts: 20 zero bytes, the flag `0x00`, then the first 11 bytes of
`keccak256("tacit-evm-token-pool-v1" ‖ uint256(chainId) ‖ token)` (the router's salt says `router`). The init code is the creation code the
live TAC pool and router were built from ([`dapp/evm-pool/token-pool-code.json`](../dapp/evm-pool/token-pool-code.json), written by
`tools/token-pool-code.mjs` only if it rebuilds their init-code hashes), so whoever sends it, the contract is the same, and
[`dapp/evm-pool-tokens.js`](../dapp/evm-pool-tokens.js) gives any page a token's pool and router from the token alone (`poolOf`) and
checks they are there (`poolState`).
- **Opening one.** One transaction from anyone, `openTx(token)`: Multicall3's `aggregate3` calling CreateX's `deployCreate2` for the
  pool and then its router (about 4.4M gas, paid in ETH by whoever sends it), or only the router if the pool is there. The swap page
  reads whether a token's pool and router are there in one call (Multicall3, `poolState`) and offers the opening to the first person who
  swaps privately from any token whose pool is not open, beside the ETH pool's route;
  `tools/token-pool-open.mjs` writes the transaction for each served pool not open yet, for any wallet to send, and each is a job on
  [tacit.finance/tasks](https://tacit.finance/tasks/) (paid in TAC; see docs/TASKS.md).
- **The relay.** It serves the pools of the tokens in `SERVED` (USDC and USDT; their pool and router addresses are listed there) and any
  its operator adds (`EVM_POOL_TOKEN_POOLS_ALLOW_1`): tokens deep enough on chain that whoever opens a pool cannot set the price its fees
  are taken at. Other tokens' holders swap privately through the ETH pool (the zap), whose crowd a pool of their own would only split.
  Any other token's pool is kept once someone names it: `POST https://tacit-evm-pool-keepers.onrender.com/token-pools` with
  `{ "token": "0x…" }` (the swap page does, after opening one and when it finds one open that the relay does not serve yet; `GET` lists
  the pools served). Its pool and router must be on chain where the salts put them, and it is served on a daily allowance of gas (0.003 ETH
  by default): its token's price is only as sound as its thinnest market, so a send past the allowance, or a quote for one, is refused. The keeper service reads CreateX's `ContractCreation` logs under those tokens' pool salts, keeps a creation
  only at the address the salts give, and serves the pool once its router answers `POOL()` with it, at
  `https://tacit-evm-pool-keepers.onrender.com/1-x<the token's first ten hex digits>/evm-pool/keeper`, with the routes every keeper has.
  It sends from `0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0` like the others and is paid in the token, at the lowest price zQuoter gave for
  one token in ETH over the last ten minutes; with no quote it refuses fees in the token. A wallet takes a quote only from that address, for
  that pool, and at most `maxRelayFee` (about 0.05 ETH's worth). Any other token's pool can be opened the same way and used from a wallet
  that sends itself, paying gas in ETH.
- **What it hides.** A withdrawal hides which of the pool's deposits paid it; a pool's crowd is its own deposits, so a new one has few.
  Moving notes to V1 works only for an asset V1 has registered.

The catch-up registry (`TacitEvmPoolCheckpoints`, see Catch-up points under Keys and recovery) is deployed through CreateX's
CREATE2 under one salt anyone may use (20 zero bytes and the flag `0x00`, which CreateX guards as `keccak256(salt)` alone, so
no deployer and no chain id is mixed in): it lands at the same address on every chain, and the address is fixed by the registry's
init code (19,163 bytes, hash `0x0a66d640…1031`, built under the `checkpoints` foundry profile: no via-IR, 200 runs, no metadata
hash), so nothing but that exact code can ever be there and any account may deploy it. It is deployed on Ethereum, Base, Robinhood
Chain and MegaETH by the `anon-wei-4` job on tacit.finance/tasks, or by hand from the localhost admin page
`contracts/script/deploy-checkpoints.mjs`, which also shows each chain's newest point and posts one. It is not deployed on any chain
yet; this section lists the chains once it is.

| Catch-up registry (`TacitEvmPoolCheckpoints`) | `0x00000000C3267616ED5E0DAA6F6490D109d6844D` |

PoseidonT5 is the standard deterministic deployment (poseidon-solidity, CREATE2 proxy
`0x4e59b44847b379578588920cA78FbF26c0B4956C`); the deploy script lands it first on chains that lack it. The zap goes
through the same proxy with a fixed salt, so its address follows from its code and constructor arguments (the pool,
zRouter, Permit2): code at that address on any chain is this contract, whoever deployed it
(`contracts/script/deploy-zap.mjs`).

What is deployed where:

| Piece | Ethereum | Base | Robinhood Chain | MegaETH |
|---|---|---|---|---|
| Pool, router, verifier, PoseidonT5 | yes | yes | yes | yes |
| Zap | yes | yes | yes | no |
| zRouter (swap aggregator), zQuoter | yes | yes | yes | no |
| Token list (token.list.wei; one registry, on Ethereum, that names the chain of each token) | yes | no | no | no |
| Router's own zap entry points | on | on | on | off (the router was deployed with zRouter set to zero, and cannot change) |
| Relay (keeper) | yes | yes | yes | yes |
| V1 wrap boxes and `withdrawToV1` | yes | no | no | no |

Everything the pool does (shield, private send, withdraw, deposit addresses, withdraw-and-call) needs only the first
row. The rest is optional periphery for DeFi flows: see [Swaps and zaps](#swaps-and-zaps).

Related Ethereum mainnet contracts:

| Contract | Address |
|---|---|
| Confidential pool (V1) | `0x000000000Ed1eabD231Be41d93b719056F7febFC` |
| ConfidentialRouter (V1 exit recipes) | `0x000000005dA3E3B73726af3c774Deeb9472D4992` |
| Native ETH asset id on V1 | `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34` |

ABIs: [`docs/evm-pool/abi/`](./evm-pool/abi/). The script that deploys them is
`contracts/script/DeployEvmPoolCreateX.s.sol`; it refuses any verifier other than the ceremony's.

## Proving on the user's device

The relation is one Groth16 circuit, [`transact.circom`](../dapp/circuits/evm-pool/transact.circom): 2 inputs,
2 outputs, 120-bit values, a depth-32 Poseidon tree, 44,414 constraints. Proofs are 256 bytes and verify in one
pairing check on chain.

| Artifact | Size | Where |
|---|---|---|
| `transact.wasm` (witness generator) | ~4.9 MB | `bafybeia7b7euebs6dr7muhhvwf4yh472ftxodikyecxubipam4d7o7sxta`, and tacit.finance/evm-pool/ |
| `transact_final.zkey` (proving key) | ~28.5 MB | `bafybeia6c36bgww2svm6jfg6nl2pk337prc7t6gcfsvhuo5sufqjpi7z4a`, and tacit.finance/evm-pool/ |
| verification key hash | 32 B | `43d11e6e1607e1ea7f3980c9bca91beed95e2e80d173d0873189e99d402e5757`; clients refuse any other key |
| ceremony bundle (transcript, keys, verifier) | | `bafybeia4yvn2zoggvgpjwg5vpwpt6aivjbcm6tgzxoxsukao2nm5yyypfy` |

### Rebuild and check it

Everything above comes from the circuit source. With circom 2.2.3 and `npm ci` run in `dapp/circuits`:

```sh
cd dapp/circuits/evm-pool
circom transact.circom --r1cs --wasm --O2 -o /tmp/transact
shasum -a 256 /tmp/transact/transact.r1cs /tmp/transact/transact_js/transact.wasm
../node_modules/.bin/snarkjs zkey verify /tmp/transact/transact.r1cs powersOfTau28_hez_final_16.ptau ../../evm-pool/transact_final.zkey
cd ../../.. && node -e "import('./dapp/evm-pool-zk-prover.js').then(m => console.log(m.vkHash(JSON.parse(require('fs').readFileSync('dapp/evm-pool/transact_vk.json')))))"
```

| Check | Expected |
|---|---|
| `transact.r1cs` sha256 (the circuit hash) | `b0a246d1790151c722e42ccfa89450cb96c7f5a9f4b70a2162b7d9fc79b6ddb3` |
| `transact.wasm` sha256 | `02dd5e84970e5bc629a7a3cd4d7eae5fc9ca05579fa22c9b39b5ea70c8d8a6c1` |
| `zkey verify` | `ZKey Ok!`: the shipped key replays through all 176 contributions and the Bitcoin block 968840 beacon back to this r1cs |
| verification key hash | `43d11e6e1607e1ea7f3980c9bca91beed95e2e80d173d0873189e99d402e5757` |

The ptau is Hermez `powersOfTau28_hez_final_16.ptau`, BLAKE2b
`6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf43eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125`.
The verifier contract is [`TransactVerifier.sol`](../contracts/src/TransactVerifier.sol) (sha256
`78d6a432bf95502b0c3f1ffba041970014d054b998b48ebdeb02dc757cf0c0cb`), exported from that key; its source and init-code
hashes are recorded in [`contracts/deployments/evm-pool.json`](../contracts/deployments/evm-pool.json). All hashes are
also in [`dapp/evm-pool/pin.json`](../dapp/evm-pool/pin.json).

The reference client is plain ES modules with no build step:

- [`dapp/evm-pool-zk.js`](../dapp/evm-pool-zk.js): keys, notes, tree, nullifiers, witness.
- [`dapp/evm-pool-zk-prover.js`](../dapp/evm-pool-zk-prover.js): `makeGroth16System({ vk, wasm, zkey, pinnedVkHash })`
  → `prove(input)` / `verify(publics, wire)`. snarkjs, in the browser or Node.
- [`dapp/evm-pool-gateway.js`](../dapp/evm-pool-gateway.js): deposit-box intents, keeper completions, receive boxes,
  withdrawals to a box or escrow.
- [`dapp/evm-pool-wallet.js`](../dapp/evm-pool-wallet.js): the wallet on top of them (sync, send, withdraw, relay,
  recovery). [The standalone wallet](#standalone-wallet) bundles it.

Proving time on a laptop is 5–14 s in Node.
A signature, not the spending key, authorizes a spend (EdDSA-Poseidon over the transaction message), so a device
too slow to prove can hand the witness to another prover without giving up custody.

### Note model

```
npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)            Ak = per-note spend key, NK = nk·Base8 (BabyJubJub)
leaf = Poseidon(asset, v, npk, rho)                v < 2^120
nf   = Poseidon(nk, leaf, index)
asset        = keccak256(abi.encode(chainId, pool, address(0))) mod p     (the pool's ASSET_FIELD())
extDataHash  = keccak256(abi.encode(chainId, pool, recipient, extAmount, relayer, fee,
                                    keccak256(memo0), keccak256(memo1))) mod p
publicAmount = extAmount − fee mod p
Σ inputs + publicAmount = Σ outputs
```

Keys and stealth derivation are the Bitcoin shielded pool's (`dapp/btc-pool-zk.js`): one wallet seed serves both,
and one Secret Sats address (`bp1…`) receives in both pools. A `tacit1…` address can carry the same 97 bytes as its
pool lane (flag `0x04`; flags `0x85` in full, 276 characters), so one address receives here too; see *Tacit address
format* in `BUILD-A-TACIT-DAPP.md`.

Each output note carries a 65-byte memo in `memo0` / `memo1` so its recipient can find it
(`dapp/evm-pool-wallet.js` `sealNote` / `openNote`):

```
memo = pk_eph (33) ‖ ct (16) ‖ tag (16)
s    = compress(e·V)  (sender)  =  compress(v·pk_eph)  (recipient)      V = the address's view key
npk, rho = outputKeys(A, N, s)                                          (the Bitcoin pool's per-note keys)
k    = keccak256("tacit-evm-pool-aead-v1" ‖ s)
ct   = be16(value) ⊕ keccak256(k ‖ 0x0000)[0..16)
tag  = keccak256("tacit-evm-pool-aead-tag-v1" ‖ k ‖ ct)[0..16)
```

In this guide `beN(x)` is `x` as N big-endian bytes. A wallet accepts a memo only if `Poseidon(asset, value, npk, rho)`
equals the output's leaf.
Public signal order: `root, oldRoot, newRoot, startIndex, publicAmount, extDataHash, asset, nf[2], outLeaf[2]`.

### Payment proofs and payment links

In `dapp/evm-pool-wallet.js`, and so in the standalone wallet below, which bundles it, a spend's one-time keys are
derived from the sender's key, so the sender finds its payments again from the key alone (`paymentKey`); a deposit's
are random:

```
e_k = HMAC-SHA256(sha256("tacit-evm-pool-eph-v1" ‖ be32(v)), be32(chainId) ‖ be32(nf0) ‖ k [‖ a]) mod n
      v = the sender's view scalar, nf0 = the spend's first nullifier, k = the output (0 or 1)
      a = the attempt, one byte 1 to 15, appended only when non-zero
```

A spend that never landed and is built again from the same note (a new quote, so a new change amount) takes the next
attempt, so a rebuilt spend does not reuse an earlier attempt's one-time key or keystream (up to 16 attempts per note,
counted in the wallet's local state). The wallet looks through attempts 0 to 15 when it finds its payments again.
Attempt 0 is the plain form above, so existing proofs are unchanged.

A payment proof is `(chain, tx, k, e_k)`. Anyone holding the recipient's address checks it (`verifyPayment`):
`e_k·G` is the memo's `pk_eph`, the memo opens under `s = compress(e_k·V)`, and the note it opens to is the output's
leaf. It shows nothing about any other address.

A payment request link is
`#pay=<address>&n=<npk, 64 hex>&ns=<r‖s, 128 hex>&amount=<ETH>&chain=<name or id>&chains=<names>&for=<note>`, everything
after the address optional (`chain` is a name such as `base` or an id such as `8453`; `chains` lists every chain the
payee accepts). `n` names the payee's deposit address (`receiveBoxOf(n, 25)`) and `ns` signs it: a secp256k1 signature,
under the view key inside the pool address, over `keccak256("tacit-pay-box-v1" ‖ be32(n))`. A payer's page pays the
deposit address only when the signature checks against the address in the link; otherwise it pays the pool address
directly, so a link whose `n` was swapped cannot redirect a payment. A link can instead ask for a token:
`#pay=<0x… address or name>&token=<token address>&amount=<in the token>&chain=<name or id>&for=<note>`, on that one
chain, paid from the payer's private balance by a swap that sends the token to that address.

A payment link hands over a key of its own, whose pool balance holds the payment:

```
seed_i = HMAC-SHA256(identity key, "tacit-pay-gift-v1" ‖ be4(chainId) ‖ be4(i))        i = 0, 1, 2, …
https://tacit.finance/pay/eth/#gift=<seed_i hex>&chain=<name or id>&for=<note>
```

`seed_i` is an identity key like any other: its pool keys are `evmPoolKeys(zk, seed_i)`, and whoever opens the link
withdraws its balance to an address or sends it into their own. The sender funds link `i` with a private send, so the
key alone finds every link it sent: each of its sends' paid outputs, opened with `e_k` under the keys of links `0, 1, …`
(ten past the last one found). A link was taken once its note's nullifier is on chain; taken back if that transaction
paid the sender. A link's index is chosen only after that chain's history is read, so no seed is funded twice.

### An onchain copy of the proving files (Base Sepolia)

The files a wallet fetches from tacit.finance or IPFS and checks against a pinned SHA-256 are also stored as contract code
on Base Sepolia (chain 84532), written on 4 October 2026 (the standalone wallet's current build on 12 October 2026). An
app can read them from any Base Sepolia node when every mirror is down, and must still check the hash. A testnet is not
permanent: this is one copy among several, not a replacement for the mirrors.

| File | Bytes | Contracts | SHA-256 | Manifest |
|---|---|---|---|---|
| `transact_final.zkey` (proving key) | 28,558,285 | 1,163 | `40758061a0786fb0bdc5e5dec4c354bbf85fc106f7412716e25e781af4e79c4b` | `0xF7679584f6dc84495374dA5B5350C2E7828ad620` |
| `transact.wasm` (witness program) | 4,916,992 | 201 | `02dd5e84970e5bc629a7a3cd4d7eae5fc9ca05579fa22c9b39b5ea70c8d8a6c1` | `0xc63e43d159429583A9fb3fF0b5053e4D12415F55` |
| `transact_vk.json` (verifying key) | 4,761 | 1 | `f3e36ac06ad59428003b90abd80b807180badeb06c3960c50b060ebc59b626b3` | `0x8649Dd8ec5b0DE7de9F6934A13188E2b868B975B` |
| `pin.json` | 1,501 | 1 | `79ddf12a68239eb9d1ddeaff9518d05ef57fa56e20deea8aae730413c3be78f9` | `0x75578ab320147Af1f8d39e7e3643621Bc57e5bE9` |
| `tacit-evm-pool-wallet.js` (standalone wallet, as served) | 667,636 | 28 | `384a88220fb78f576e60480439bceb3e91e0fe8a32557f5c01c672390b81f5bc` | `0x0bFAcFe74c2FfA357BCcd211Ac8b2C687788c0b8` |

The wallet's earlier build (`cdc59dd5d5c95370a30161dd64637e32590b85290241944184283a05098c15c0`, 705,182 bytes in 29
pieces, manifest `0x202fF20B540794CD6f8F54cF80A0Af6170BEaDB4`) is there too. Each file was read back and matched its
SHA-256 when it was written.

- **How it is stored.** Each file is cut into pieces of up to 24,575 bytes. A piece is the runtime code of its own contract:
  one STOP byte (so it never runs), then the bytes. Pieces and manifests are created through the deterministic CREATE2
  proxy (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, salt 0), so every address follows from its bytes alone. A manifest
  is the same kind of contract: `0x00 ‖ "tacit-artifact-v1" ‖ sha256 ‖ size (uint64) ‖ count (uint16) ‖ count piece
  addresses`. The six files (the wallet's earlier build included) make 1,423 pieces and 6 manifests; with the index
  below, 1,430 contracts.
- **Why an explorer shows "contract call".** A creation through the proxy is a call to the proxy, which creates the
  contract internally, so each transaction is listed as a call and each new contract as an internal creation. Read a
  manifest's code to see the file, not the transaction list.
- **Reading it.** `TacitArtifacts` at `0x250FCb513A809727b9b538A313895Eec5A36674C` (verified on Sourcify and Basescan)
  names the four ceremony files and the wallet's earlier build in `files()`; `manifest(m)` (SHA-256, size and piece
  addresses), `piece(m, i)`, and `check(m)` (reassembles a small file onchain and compares its SHA-256) read any manifest,
  the wallet's current one included. Or fetch the pieces with `eth_getCode` and join them
  without their first byte, then check the SHA-256. A reader that does this and checks the hash is
  `tacit-pay/deploy/artifact-read.mjs` in the ERC8244/dapps repository.
- **What is not there.** The Groth16 verifier contract is not on Base Sepolia. It lives at the address above on each
  chain; the verifying key here is its key as a file, for apps that verify proofs themselves.

## Calling the pool

```solidity
function transact(
    uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[11] publicInputs,
    address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1
) external payable;
```

| `extAmount` | Effect |
|---|---|
| `> 0` | Deposit: send exactly `extAmount` wei as `msg.value`. |
| `< 0` | Withdraw `-extAmount` wei to `recipient` (must be non-zero). |
| `0` | Private transfer inside the pool. |

A withdrawal to a contract first calls it with 100,000 gas. If the contract does not accept the ETH, the pool delivers
it by a forced transfer that runs no code on the contract (`forceSafeTransferETH`), so the withdrawal does not revert.

`fee` goes to `relayer` in the same call (a non-zero fee needs a non-zero relayer). The contract recomputes the asset,
`extDataHash` and `publicAmount` itself, so recipient, amounts, relayer, fee and memos cannot be altered after the
owner signs. `pB` takes snarkjs's `pi_b` with each pair swapped: `[[b01, b00], [b11, b10]]` for `[[b00, b01], [b10, b11]]`.

**Ordering.** A transaction with an output inserts two leaves at the pool's current size, so it is proven against the
current root (`oldRoot == root()`, `startIndex == nextIndex()`; `head()` returns both in one call). If another
transaction lands first it reverts with `StaleRoot` or `WrongInsertionIndex`: rebuild the witness against the new leaves
and prove again; the owner's signature does not change. Submit through private order flow. A transaction with no
outputs (a full withdrawal) inserts nothing and never goes stale. The anon.wei page always fills both outputs (an unused
one is a zero-value note under a key no one holds), so each of its proofs inserts and is bound to the current head, and
a payment without change looks like one with change. Membership may be proven against any root the pool has held
(`everKnownRoot`); `rootSize(root)` is the leaf count the tree had when that root was current.

**Indexing.** Rebuild the tree from `Transact` events in `firstIndex` order, appending `(outLeaf0, outLeaf1)`; skip
events where both are zero (nothing was inserted). Notes are found by trial-decrypting the memos, and receive-box
notes from the router's `Received` events. Key notes by
`(leaf, index)`: the same leaf can appear twice if a deposit box is paid twice, and each copy is separately spendable.
`isSpent(nullifiers)` checks many notes in one call but tells the node which nullifiers are yours; a wallet scanning
`Transact` events already has every spent nullifier (`nf0`, `nf1`).

### What each action shows

| Action | Public | Hidden |
|---|---|---|
| Deposit (`extAmount > 0`) | The depositing wallet and the amount. | Whose note it creates. |
| Deposit from a token | The wallet, the token and the amount it spent, and the ETH deposited. | Whose note it creates. |
| Private transfer (`extAmount = 0`) | The nullifiers, the two new leaves, the encrypted memos, and who submitted it (relayer and `fee`, or the sending wallet). | Sender, recipient and amount. |
| Withdrawal (`extAmount < 0`) | `recipient`, the amount, `relayer`, `fee`, and who submitted it. | Which deposit funds it, and the value of any change note. |
| Plain payment to a receive box | The payer, the amount and the box address. | Which wallet owns the box. |
| `sweepReceive` | The amount swept and the box's note key (`npk`) in the call data. | Anything tying `npk` to the wallet's shielded address. |

The pool hides which deposit pays a withdrawal and who pays whom in a private transfer. Amounts and addresses of
deposits and withdrawals are public, and while the pool is small, the timing and amount of a withdrawal can match it to
a deposit. A spend submitted from the user's own wallet shows that wallet as the sender; a relayed spend shows the
relayer.

## Router

The router is optional periphery: deposit, transfer and withdraw need only the pool. The router adds addresses anyone
can pay (deposit, wrap and receive boxes) and calls run in the same transaction as a withdrawal.

**Deposit boxes: pay an address now, get a note later.** A `DepositIntent` fixes the amount, both output leaves, both
memo hashes, a refund address and a deadline. `depositBoxOf(intent)` is a counterfactual address that holds only
what is paid to it. Any source can pay it: a wallet, an exchange withdrawal, a bridge, or a V1 withdrawal. Anyone
then calls `completeDeposit(intent, tx)` with a proof against the pool's root at that moment and collects the fee,
which is `amount − Σ output values`. The intent pins the notes, so a completer can only deliver exactly what the
owner chose. After the deadline, `reclaimDeposit(intent, token)` returns any token or ETH in the box to the refund
address. The completer learns each output's value (the leaves hide it) but cannot link later spends.
`depositBoxOf(intent)` is the same address on every chain, but the leaves bind the chain's asset, so a box funded
on the wrong chain can never be completed there, only reclaimed. Fund a box with a plain call carrying normal gas:
once completed it has code, and a 2300-gas stipend transfer to it can fail.

A keeper service completes boxes for its fee: `POST /evm-pool/keeper/deposit` with `{ intent, hint }` from
`depositIntent()` (each chain's keeper URL is `keeper` in `contracts/deployments/evm-pool.json`). Anyone can run one
(`worker-relay/src/evm-pool-keeper.js`); the same service sweeps receive boxes and relays ([Relaying](#relaying)).
Its `GET /quote` says what completing a box costs it: `depositGas` (its `EVM_POOL_KEEPER_DEPOSIT_GAS`, default 500,000) and `depositFee`, the
least fee a box may carry at that gas. A page that makes the box takes its fee from that figure (a half over it, so a rise in gas before the
completion does not strand the box); an older keeper without the fields is asked for a quote at 500,000 gas.

With `EVM_POOL_KEEPER_RECLAIM=1` the keeper also sends back what a box still holds once its deadline has passed, to the intent's `refund` (the router lets anyone
do this): the whole of a box it never completed, and what a completed one holds above its `amount` (what a swap that funded it paid over). The gas is the keeper's
own, since the router sends the whole balance to the refund, so it does either only when the balance is worth the send (ETH: three times the gas of the send, about
44,000 gas; a token: the keeper's minimum fee and, where it has a price, the gas at that price), and only inside the signer's day budget and over its reserve (the sweep
subsidy's `EVM_POOL_KEEPER_SWEEP_SUBSIDY_DAILY_WEI` and `EVM_POOL_KEEPER_SUBSIDY_RESERVE_WEI`; with neither set there is no bound). A balance not worth it stays in the box
(an unfinished box is watched as it is with reclaim off and expires after its grace). The leftover of a completed box is looked for every
`EVM_POOL_KEEPER_SURPLUS_SECS` (600) in batches of `EVM_POOL_KEEPER_SURPLUS_BATCH` (10), oldest deadline first, and a box is marked once it is settled (sent, nothing
left, too small, or refused by the router for good). Reclaim is off by default; like the other settings it can be set for one chain (`…_RECLAIM_1`) or one pool.

**Handing a box to a funding page.** A page that funds boxes on the user's behalf takes
`#tacit-box=<base64url(JSON.stringify({ chainId, intent, hint }))>`, where `intent` and `hint` are exactly the
keeper intake body above (integers as decimal strings or `0x` hex). The page checks the router has code on
`chainId`, forwards `{ intent, hint }` to a keeper, and funds exactly `intent.amount` there only once a keeper
accepts it, so no one pays a box nobody will complete. A funding page should also refuse a box that already holds
funds or has code (no reuse) and one whose deadline is less than an hour away. For funding from a V1 note, keep
`amount` a multiple of 10^10 wei.

**Wrap boxes and `withdrawToV1` (Ethereum only: the router's `V1` is zero on Base, Robinhood Chain and MegaETH).** A
`WrapIntent` fixes a V1 asset id, amount, tip, tip recipient (zero = whoever completes), V1 note commitment, refund and
deadline. `completeWrap(intent)` wraps the box's funds into that V1 note. `withdrawToV1(tx, intent)` withdraws from the
pool into the wrap box and wraps in one transaction; the proof binds the box as recipient.

**Receive boxes: one standing address, paid any number of times.** `receiveBoxOf(npk, feeBps)` is an address
tied to one note key of the owner and a fee cap in basis points. Anyone pays it ETH, as often as they like, from any
wallet or exchange. Anyone then calls `sweepReceive(npk, feeBps, tx)` to move its whole balance into the pool
(a sweep proves exactly the balance it finds, so rebuild if a payment lands first): the router computes the note
itself, `leaf = Poseidon(asset, amount − fee, npk, rho)` with
`rho = keccak256(abi.encode(keccak256("tacit-evm-pool-receive-box-v1"), box, n)) mod p` for the box's `n`-th sweep
(`receiveCount(box)`), so a sweeper can only credit the owner and keeps at most `feeBps` of what it sweeps.
`receiveState(npk, feeBps)` returns the box, its next `n` and `rho`, and the balance a sweep would take. The
sweep takes no memos and a single output. Each sweep emits `Received(box, n, index, value, rho, fee)`. The box's
contract exists only inside a sweep (created, emptied and removed in one transaction), so between sweeps the address
has no code and takes any payment, including a plain 21,000-gas transfer from an exchange.

- Keys: `receiveKeys(zk, wallet, i)` gives box `i`'s note key. It derives from the wallet's nullifier secret, so a
  box cannot be tied to the wallet's shielded address, and a wallet can hand out a separate box per counterparty.
- Recovery needs only the seed: for each `i`, `receiveKeys` → `receiveBoxOf(npk, feeBps)` → its `Received` events →
  `receivedNote(zk, wallet, i, event)` is a spendable input.
- Sweeping: `sweepWitness(zk, { npk, feeBps, box, n, amount, fee, relayer, … })`. The owner can sweep with no fee
  from any account; a zero-fee box (`feeBps = 0`) is swept only that way.
- Payments into one box are public and linked to each other, like any reused address. Spends of the swept notes
  are not: they reveal nullifiers, never the note key.
- Only the pool's asset leaves a receive box. Anything else sent to it stays there.

**Receive address (canonical, every app shows the same one).** The address a wallet displays depends on every
value below, so all apps use exactly these:

| | |
|---|---|
| Pool wallet seed | `HMAC-SHA256(key = Tacit identity private key (32 bytes), msg = "tacit-btc-pool-seed-v1")` |
| Wallet keys | `walletKeys(seed, "mainnet")` (`dapp/btc-pool-zk.js`), the `"mainnet"` tag on every EVM chain |
| Box key | `receiveKeys(zk, wallet, 0)`: `ownedKeys(wallet, s)` with `s = 0x00 ‖ keccak256("tacit-evm-pool-receive-key-v1" ‖ be32(n) ‖ be32(i))`, `n` = the wallet's nullifier scalar, `i = 0` |
| Fee cap | `feeBps = 25` |
| Address | `receiveBoxOf(npk, 25)` on the router; offline, `receiveBoxAddress(npk)`. The same address on every chain. |

`evmPoolWallet(zk, identityKey)` and `receiveBoxAddress(npk)` in `dapp/evm-pool-gateway.js` implement this.
Vectors (identity key `0x11` × 32):

```
a      = 0x030d4f8c609bcd6f5c961113e9a379b14b5eacfe0cb693e3ee3a21f148144d9e
n      = 0x04b517b015712270664ae5481e694562bb14b28685c492be2436898a8ec97306
npk(0) = 4783613888947850950044057964142544727340891053660060203316524895455918575012
npk(1) = 2799937100355739972349309475928188484188423058204235589221587582372656968697
address (box 0, feeBps 25) = 0x52fc37ee7741468a15CE879320a7a41CEBaeb232
address (box 0, feeBps 0)  = 0x7ABc01dEAC9A65A0d2480a87DB6F22EbC1342639
```

**Keeper intake for receive boxes.** A plain payment to a box emits no event, so a keeper
sweeps only boxes it has been told about: `POST /evm-pool/keeper/receive` with `{ chainId, npk, feeBps }`
(idempotent; keeper URLs as above). The keeper then watches the box's balance and sweeps whenever the
capped fee covers its gas. Registering tells the keeper which box belongs to which note key, which the first sweep
makes public anyway; it never learns anything that spends. The owner can always sweep without a keeper.
At capacity the keeper makes room for a new registration, and for a new deposit or wrap intent, by dropping the
oldest idle one, so registrations that never pay cannot lock out new users; register again before paying if a box was
dropped. Requests are rate limited per client address (an IPv6 client by its /64).

**Shielding a token in one transaction (`TacitEvmPoolZap`).** A separate contract (`contracts/src/TacitEvmPoolZap.sol`)
takes a token from its caller, swaps it through zRouter for ETH, and deposits exactly the proof's `extAmount` with the
caller's own deposit proof, all in one transaction. Unspent token and any ETH above the deposit go back to the caller.
Its three entry points differ only in how the token is taken:

- `zapToken(tx, tokenIn, amountIn, swap)`: an allowance to the zap, approved before or in the same wallet batch.
- `zapTokenWithPermit(tx, tokenIn, amountIn, deadline, v, r, s, swap)`: an EIP-2612 permit to the zap. A failing permit
  is skipped, so one already used (for example, copied from the mempool and sent first) still leaves its allowance.
- `zapTokenWithPermit2(tx, tokenIn, amountIn, nonce, deadline, signature, swap)`: a Permit2 `PermitTransferFrom`
  signed with the zap as spender, for a token already approved to Permit2.

`swap` is zRouter calldata that pays at least `extAmount` ETH to the zap: an exact-out route from zQuoter with the zap
as recipient, or an exact-in route for an amount of the token sized so its floor covers `extAmount` (the swap page's
Swap privately sizes it that way, so splits and two-hop routes can be used; the ETH over the deposit comes back). The proof is an ordinary deposit, built against the pool's head; if another deposit lands first, the call
reverts (`StaleRoot`) and nothing moves. The zap holds nothing between transactions, takes tokens only from
`msg.sender`, allows zRouter only within the call (reset to zero after the swap), and accepts ETH only during a zap.
The router has the same idea in one entry point of its own, `zapTokenToDepositWithPermit2(tx, amountIn, permit, sig,
swapData)`, which is off where the router was deployed without zRouter (MegaETH).

A wallet picks the way that asks least of the user, in this order: an allowance it already has; an EIP-2612 signature
(an ordinary account, or one delegated under EIP-7702); a Permit2 signature when the token is already approved to
Permit2; the approval and the zap in one atomic batch (EIP-5792 `wallet_sendCalls`) when the wallet supports it; and
only otherwise an approval transaction first. Approve exactly `amountIn`, so no allowance is left behind.

**With no ETH for the gas.** The deposit above is the wallet's own transaction, so its gas is ETH from the wallet. A wallet that holds a token the gas
relay (`TacitGasRelay`) takes its fee in (USDC or TAC, or a token approved to Permit2) can sign one order instead: the relay sells the token through
zRouter for ETH paid to a deposit box of the ETH pool for the wallet's key, and the pool's keeper completes the box for a fee out of it. The box's amount
is the deposit and that fee; the order's signed `minOut` is the box's amount, so a shortfall reverts it all and nothing is spent; what the sale pays
above the box stays in it, refundable to an address only the key knows after the box's deadline. No ETH leaves the wallet. ETH itself cannot go this way:
it moves only in a transaction its holder sends. The swap page does this when the wallet holds too little ETH, or when its holder picks the token or TAC
for the deposit's gas (`dapp/swap/later.js` `startBoxed`, `dapp/gas-relay.js` `placeOrder`). Every swap out after the deposit is sent by the pool's
relay and costs the wallet no gas either way.

**Withdraw and call.** A withdrawal can run actions with the funds in the same transaction: a swap, a bridge deposit, a
wrap or zap into a V1 note, or any call. A `CallIntent` lists the calls (target, value, data, and a token to transfer or
approve first), the tokens to deliver to `to` with their minimum amounts, a refund address and a deadline.
`callEscrowOf(intent)` is its escrow address; a withdrawal with that recipient binds the whole intent through the proof,
so a relayer can change neither the calls nor where their outputs go. `withdrawAndCall(tx, intent)` withdraws and runs
it at once: if any call fails or an output falls short, the transaction reverts and nothing is spent. Funds that reach
the escrow another way are run by anyone with `executeCall(intent)` before the deadline, and returned to `refund` with
`refundCall(intent, token)` after it. Whatever is left of the pool asset after the calls goes to `refund`; making
`refund` the owner's own receive box (`callRefundBox`) returns it to the pool privately. A keeper sweeps a box only when
its capped fee covers the gas, so on Ethereum a small refund waits there until it grows or the owner sweeps it. Calls
cannot target the pool, the router or the escrow itself. Client helpers in `dapp/evm-pool-gateway.js`: `callIntent`,
`callEscrowAddress`, `callWithdrawalWitness`, and call builders for V1 (`v1WrapCall`, `v1ZapShieldedNoteCall`,
`v1ZapCanonicalNoteCall`).

Rules the router enforces: `withdrawAndCall` needs a negative `extAmount` and a recipient equal to
`callEscrowOf(intent)`; it reverts after `deadline`; `refund` must be non-zero; `outTokens` and `minOuts` must be the
same length, and `to` must be non-zero when there are outputs. Each output token's whole escrow balance goes to `to`
(ETH is `address(0)`), so ETH listed as an output leaves nothing for `refund`. The calls, their targets and values, the
outputs, `refund` and the amount are public call data; which note paid is not.

**Funding with a call.** Contracts and bridge messages that deliver funds by calling a contract use
`fundDeposit(intent, hint)` (pays a deposit box exactly `intent.amount` and publishes the keeper hint in
`DepositFunded`) or `fundReceive(npk, feeBps, amount)` (pays a receive box and announces it in `ReceiveFunded`). A
keeper that reads these events can act from chain data alone; the reference keeper reads only `Transact` and
`Received`, so also post the intent to `/deposit` or register the box at `/receive`. A published hint shows the note's
value and public key material; it does not let anyone spend the note or link its later spends.

## Swaps and zaps

For flows beyond shield, send and withdraw, the pool works with a swap aggregator through two router features:
withdraw-and-call (a withdrawal runs calls in the same transaction) and the zap (shield from a token). None of it changes
the pool; each piece is optional and a chain without it still has the full pool.

| Piece | Address | Where |
|---|---|---|
| zRouter (swap aggregator) | `0x000000000000FB114709235f1ccBFfb925F600e4` | Ethereum, Base, Robinhood Chain |
| zQuoter (finds routes onchain; `eth_call` only) | `0x000000bd2DB80567c23E353ca95a251c573cBf9B` | Ethereum, Base, Robinhood Chain |
| Token list registry (token.list.wei) | `0x0000006013dF75A31678B786061C2B54bf531524` | Ethereum only; its entries name the chain each token is on, and the anon.wei page reads it from Ethereum for every chain |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | all four |
| Zap | `0x0000008EbBF2323f95c4fBc18254f3D65C53998c` | Ethereum, Base, Robinhood Chain |

- **Withdraw as a token.** Withdraw-and-call with one call to zRouter along the route zQuoter returns, with the recipient
  written into the route after the quote (see "Can a withdrawal arrive as a token?" below).
- **Shield from a token.** The zap takes the token from its caller, swaps it through zRouter for exactly the deposit's ETH
  and deposits it with the caller's proof, in one transaction (see "Shielding a token in one transaction" under Router).
  Its approval can be an allowance, an EIP-2612 permit, a Permit2 signature or part of a wallet batch.
- **Swapping inside the pool.** A pool holds one asset (the ETH pool ETH, a token pool its token). A swap is a withdrawal into a
  call, and the result is public at the destination; the pool hides which deposit paid, not the swap.
- **A chain without them (MegaETH today).** The pool, router, deposit addresses and withdraw-and-call to any target work.
  The zap cannot be deployed until zRouter exists on the chain (its constructor requires code there), and the router on
  MegaETH was deployed with zRouter set to zero, so its own zap functions stay off. A page for such a chain is the
  simplified one: shield, send, withdraw, a deposit address and payment links, with no token forms. An app that wants swaps there can build them against that chain's own
  aggregator through withdraw-and-call, or deploy the zap when zRouter arrives.

## What it costs

The contracts take no fee. Shielding, sending, withdrawing and collecting a deposit-address payment can each go from
your own wallet for the network gas alone. A relayer is an optional convenience: it submits the transaction for a small
fee, so you need no gas and none of your accounts appears on chain. Anyone can run a relayer, and nothing depends on a
particular one.

| Action | From your own wallet | Through a relayer |
| --- | --- | --- |
| Shield (deposit) | network gas only | not relayed: a deposit is sent by whoever pays it |
| Send privately to another address | network gas only | relayer fee, no gas |
| Withdraw (unshield) | network gas only | relayer fee, no gas |
| Collect a payment sent to a deposit address (a receive box) | network gas only, any amount | relayer fee, at most 0.25%, for payments above a minimum |

A relayer's fee comes out of the shielded balance in the same transaction, on top of the amount: the recipient receives
the full amount. A collected deposit-address payment is credited minus its fee. The fee follows the transaction's
network cost plus a margin, with a floor per chain, so it moves with gas. A balance held in several notes can need
combining before a large spend; each combine is one more transaction, with its own gas or relayer fee.

### Current estimates

On live transactions a shield, send or withdraw typically uses about 350,000 to 440,000 gas on Ethereum, Base and Robinhood
Chain, and collecting a deposit-address payment about 470,000 to 510,000. MegaETH prices storage and contract creation
higher, so the same actions use more gas there (measured on 5 October 2026: about 580,000 to 625,000, and about 1.1
million for collecting a deposit-address payment) at a far lower price per unit. Fees are each relay's quote on 12 October
2026, with ETH at about $2,555. `GET /evm-pool/keeper/quote` returns the fee now.

| | Ethereum | Base | Robinhood Chain | MegaETH |
| --- | --- | --- | --- | --- |
| Your own wallet: shield, send or withdraw | about 0.00003 ETH ($0.08) | about 0.000005 ETH ($0.013) | about 0.000008 ETH ($0.020) | about 0.000001 ETH ($0.003) |
| Relayer fee: send or withdraw | 0.0000679 ETH ($0.17) | 0.000005 ETH ($0.013) | 0.0000109 ETH ($0.028) | 0.0000011 ETH ($0.003) |
| Relayer fee: collect a deposit-address payment | 0.0000906 ETH ($0.23) | 0.0000043 ETH ($0.011) | 0.0000145 ETH ($0.037) | 0.0000018 ETH ($0.005) |
| Smallest payment a relayer collects | 0.0362 ETH ($93) | 0.0017 ETH ($4.42) | 0.0058 ETH ($15) | 0.00072 ETH ($1.84) |

A payment below the minimum waits at its address until it grows or you collect it yourself, which costs gas only.

### Privacy by route

| Route | Visible on chain |
| --- | --- |
| Shield | the depositing account and the amount |
| Send from your own wallet | that your account made a private transfer; not the recipient or the amount |
| Send through a relayer | that the relayer made a private transfer; nothing about you |
| Withdraw from your own wallet | your account as the sender, the recipient and the amount; not which deposit it spends |
| Withdraw through a relayer | the recipient and the amount, sent by the relayer; nothing names your wallet |

Amounts are public at both ends: a withdrawal that empties exactly what one deposit put in pairs with it. Withdrawing a
different amount, or later, keeps the two apart.

Spending authority is the Tacit key, not the account that sends the transaction. The proof does not name a sender, so
any account can submit your send or withdrawal. Submitting from an account that did not make the deposit, and is not
otherwise tied to you, keeps your depositing account off the transaction, with no relayer fee. The wallet library takes
any signer for this.

### Never stuck

Shield, send, withdraw and collecting a deposit-address payment each have an own-wallet path, offered next to the
relayer's. A move to an L2 goes through a keeper. Relayers are interchangeable: `dapp/evm-pool-wallet.js` takes a relayer
endpoint per chain, and a chain config that names your relayer (`relayer`, `maxRelayFee`) holds it to the same fee
ceiling as any other; its address is the `relayer` the proof binds. Run a relayer from
`worker-relay/src/evm-pool-keeper.js`.

## Relaying

A user never needs gas or a funded address: a relayer submits the transaction and is paid `fee` out of the user's
shielded funds in the same call. The proof binds `relayer` and `fee` (with recipient, amount and memos), so a relayer
cannot redirect the funds or raise its fee after it is signed, and a copy of the transaction submitted by anyone else
still pays the named relayer. Withdrawing to a fresh, empty address through a relayer leaves no on-chain link to the
depositor's wallet beyond what the amounts and timing show.

**How a quote is checked.** Before signing, the wallet checks the relayer's quote, so a compromised relayer cannot quote
more than the wallet allows:
- it names this chain and this pool;
- the fee is within a per-chain ceiling: 0.05 ETH on Ethereum, 0.002 ETH on Base, Robinhood Chain and MegaETH;
- in a browser on a real origin, it comes from the relayer address the wallet expects for the chain (`RELAYERS`,
  `MAX_RELAY_FEE` in `dapp/evm-pool-wallet.js`; a chain config can set `relayer` and `maxRelayFee` itself);
- on the anon.wei page, the fee is also at most the larger of 0.0001 ETH and 8 times the cost of the quoted gas at the
  node's current gas price, and a fee that later moves more than 20% above the one shown asks the user to confirm again.

**What the relay sees.** Your IP address; the transaction it is asked to send (all of which becomes public); at
`/reserve`, the new leaves and the nullifiers being spent; at `/receive`, the chain, note key and fee cap of each box
it is asked to watch; and at `/events`, the block a history read begins in: the start of a range of blocks after an absence, not the wallet's
own place, and the wallet's own place only when it read the feed in the last ten minutes. It cannot change the recipient, amount,
relayer or fee, and it holds no key that can spend. Sending from the user's own wallet is always possible.

With the keeper service (each chain's `keeper` URL and `keeperAddress` are in `contracts/deployments/evm-pool.json`):

1. `GET /evm-pool/keeper/quote` → `{ relayer, fee, sweepFee, receiveMin, … }`: the keeper's address and the fee it
   accepts now, plus what collecting a receive box costs now (`sweepFee`) and the smallest box balance whose 0.25%
   cap pays for it (`receiveMin`). A smaller balance stays in its box, owned by its keys, and is collected once more
   arrives or gas falls.
2. Build and prove the transaction with that `relayer` and `fee` (`withdrawalWitness` for a withdrawal, or a
   transfer with `extAmount = 0`).
3. `POST /evm-pool/keeper/relay` with `{ tx: { pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0,
   memo1 } }` (integers as decimal strings) → `{ txHash }`.

**Many users at once.** The pool inserts only against its current head, so two transactions proven against the
same head cannot both land. The keeper keeps a queue instead of a race. Output leaves are fixed before proving, and
a spend's signature does not cover the root.
1. `POST /reserve { outLeaf0, outLeaf1, nfs }` → `{ id, oldRoot, start, root, size, pending, expires }`: a slot. The
   wallet proves from `oldRoot` at `start`, which is the pool at `root`/`size` with the `pending` leaves appended.
   Wallets prove at once, each in its own slot, up to the queue's depth (24 by default) and two open slots per client.
2. `POST /relay { tx, reservation: id }`: the keeper checks the proof off chain against the slot and the transaction
   (proof, extDataHash, fee, nullifiers), then sends the slots in order, several per block.
3. A slot that is not fulfilled within 90 s is cut, with the slots behind it, and those wallets reserve again.
   `POST /cancel { reservation }` gives a slot up early. A slot that lapses, or is given up, with other slots behind
   it costs those wallets their proofs, so its requester may not reserve again for ten minutes (`403`); such a
   wallet proves against the queue's tail and sends without a reservation. A lapse with nobody behind it costs
   nothing and is not counted.

Unreserved relays still work: proven against `GET /head`'s `tail`, one takes the next slot. A withdraw-and-call or a
move to V1 is simulated before it is sent, so it waits for an empty queue. The queue runs wherever the keeper sends to
the chain's public mempool, which is every chain but Ethereum by default; on Ethereum the keeper sends through private
endpoints, which drop a reverting transaction and would leave a nonce gap, so each insertion proves against the head.

**History feed.** `GET /evm-pool/keeper/events?from=<block>` → `{ through, events }`: the pool's `Transact` and the
router's `Received` events in blocks `from..through`, confirmed, in chain order, whole blocks per page. A wallet syncs
most of its history from it in a few requests instead of thousands of log queries. A wallet that has been away asks from the
start of the range of blocks its place falls in (`feedStart` in `dapp/evm-pool-wallet.js`; ranges counted from the pool's first
block, a day on Ethereum and an hour on Base, where a day holds thousands of events), not from its own place, so the request does
not tell the keeper where this wallet last was, and keeps only the events from its place on. A wallet that read the feed in the
last ten minutes asks from where that read ended, so a poll is sent only what is new; that block is one the keeper itself gave to
every wallet that read at the same moment, and says no more than the time of the request does. It trusts nothing in it: each page is
kept only if the tree it builds is one the pool has held at that size (`rootSize(root) == size`). A feed can at most
hide a note (by withholding its memo or `Received` event, or by listing its nullifier as spent) or a spend of one;
`rescan()` rebuilds from chain logs alone, and a spend that keeps failing runs it.

**Catch-up point.** `GET /evm-pool/keeper/point` → `{ chainId, pool, registry, size, block, filled, data }`: the keeper's confirmed
tree's right edge at its count and the block it is read through, with `data`, the call that posts it to the registry
(`post(size, blockNumber, filled)`), for anyone to send from their own wallet (the /tasks job's first-point steps do). The registry
keeps a post only if the pool held its root at that count, so a wrong point reverts and costs its sender only a failed estimate.
`404` when the keeper names no registry, `503` before it has read the pool.

A `409` with `stale: true` means another transaction landed first: rebuild against the new root and prove again
(the owner's signature does not change). A `400` carrying `needFee` means gas moved; re-quote. Deposits are not
relayed, since a deposit is paid by whoever sends it.

### Private route

A keeper sees the address each request comes from. The private route takes that away. A wallet seals every request to the keeper's
gateway key and sends it through a forwarder, which hands it to the keeper's `POST /evm-pool/keeper/sealed`. The keeper opens it, runs
it through the handler a direct request reaches, and seals the answer to the request's one-time key. The multi-keeper service has one
`POST /sealed` for every pool it serves, which carries any pool's routes (`/<id>/evm-pool/keeper/…`) under one key and one forwarder target.

| | sees |
|---|---|
| the forwarder | the caller's address, when an envelope came and how large it is (4, 8, 16, 32 or 64 KiB; answers in steps from 1 KiB), never what is in it |
| the keeper | the forwarder's address, and the request |
| whatever hosts the keeper | the forwarder's address and a sealed envelope |

It hides a caller from the keeper only while the forwarder and the keeper are not one party: a forwarder run by the keeper's operator, or
one that shares its log with it, hides nothing. Chain reads (`rpc`) are unchanged and go where the wallet sends them.

**What it carries.** `info`, `head`, `quote`, `events`, `point`, `totals`, `status/<box>`, `relay`, `receive`, `deposit` and `wrap`; anything
else is refused inside the envelope. It does not carry `reserve` or `cancel`: a caller has no address of its own to hold a slot under, so a
wallet on this route proves against the queue's tail and sends without a reservation (`reserveSlot` in `dapp/evm-pool-wallet.js`), as a
wallet whose reservations are paused does. Limits apply to the address an envelope came from, so every caller behind one forwarder shares its
allowance. A forwarder named in `EVM_POOL_KEEPER_FORWARDERS` may send ten times as much, and the forwarder limits each caller by its own
address. An envelope is counted against its sender before it is opened, and each request inside it by the keeper it names, as if the sender
had made it alone.

**Bursts.** One envelope carries up to 24 requests and is answered with one answer for each, in order, so a poll of every pool (a quote and a
feed read for a dozen of them, together, every two minutes) is a few envelopes, not two dozen: in a test over a simulated network the burst
went from 24 envelopes and 98 KB sent to 3 envelopes and 12 KB, and finished within about 50 ms of the same time. `makeSealedFetch` does this
itself. A read is sent at once unless another read is in flight; then it waits for that one to come back, or for `batchMs` (200), whichever is
first, and goes with the reads waiting, so a read that follows another (a page after a page) waits for nothing. A write is always sent alone and
at once, since a `/relay` can wait minutes for its turn and must not hold the reads up. A caller that aborts stops waiting at once, and an answer
too large to share an envelope (the answers of an envelope together are at most 8 MB) is asked for again by itself.

**The envelope** (`dapp/sealed-request.js`). The caller makes a one-time secp256k1 key, takes the shared secret with the gateway key, and
derives an AES-256-GCM key and iv for the request and, from a reply nonce, another pair for the answer (the platform's WebCrypto, which runs
off the event loop: a page of a million bytes seals in under a millisecond, so the history feed is carried like the rest). Only the gateway
key opens a request or makes an answer that passes its tag, so a forwarder can drop or delay one but cannot read, change or answer it. A
request is single use and must be within five minutes of the keeper's clock. The gateway key is long-lived,
so whoever gets it can read the envelopes they recorded: keep it to the keeper's environment, and if it may have been seen, make a new one
(a new key id) and update the pages. A wallet that cannot reach any forwarder fails; it never falls back to a direct request, which would
show its address.

**What a page's switch hides.** A page that offers the route (`dapp/private-route.js`; the pay page's wallet sheet: "Hide my address from the relay")
sends every request it makes to a relay through a forwarder, from its first request of a visit once a person has turned it on, and fails a
request when no forwarder answers rather than send it directly. It hides the person's address from the relay and from whatever hosts it. It does
not hide it from the chain nodes the page reads through (they see the wallet's receive-box addresses, some seventy balance reads a minute for a
signed-in tab), or from any other service a page asks (the points lookups at `api.tacit.finance` send the connected Ethereum wallet's address, when one is
connected). The page says the first in one line under the switch.

**Turning it on.** Each step can be left standing; nothing a person sees changes until the last.
1. Deploy the keepers with this code. The route is off without a key: `GET /<id>/evm-pool/keeper/info` has no `sealed`, `POST /sealed` is a 404.
2. `node worker-relay/src/sealed-keygen.js` makes a key. The secret goes in the keeper's `EVM_POOL_KEEPER_GATEWAY_KEY` (`…_<chainId>` for one
   chain) and nowhere else; the public key is what a page pins. On the multi-keeper service the one key in the base environment turns on
   `POST /sealed` for every pool, and `EVM_POOL_KEEPER_FORWARDERS` names the forwarders' addresses (so each may send ten times what a caller
   may). A restart does not read a changed environment; a deploy does. `GET /<id>/evm-pool/keeper/info` shows the key as `sealed` once the route
   is on, so what a page pins can be checked against what the keeper holds.
3. Run a forwarder somewhere that is not the keeper's host, and, for the route to hide anyone from the keeper's operator, not run by the
   operator: `FORWARDER_GATEWAYS='{"k":"https://<the service>/sealed"}' node worker-relay/src/evm-pool-forwarder.js` (an id is a chain's, a pool's, or a
   service's; a single keeper's is `{"1":"https://…/1/evm-pool/keeper/sealed"}`). It holds no key, forwards no header of the caller's and keeps nothing.
4. `node tools/private-route-check.mjs --service https://<the service> --gateway <public key> --forwarder https://<a forwarder>` (once for each
   forwarder, or with `--forwarder` repeated) checks it from outside: the key a pool holds is the key to pin, a page's origin may call the forwarder,
   a burst of reads comes back sealed and equal to the direct answers, and what the route does not carry is refused. It must pass before a page is pointed at it.
5. In `dapp/private-route.js` set `ROUTE.gateway` and `ROUTE.forwarders`, add each forwarder's origin to the pay page's `connect-src`, run
   `node build/build.mjs` and push. The wallet sheet then offers the switch, off until a person turns it on; turning it on tries the route once and
   stays off if it does not answer.
6. To take it away from everyone, empty `ROUTE.forwarders` and push. A page without a forwarder neither offers nor uses the route, so nobody who
   had turned it on is left unable to reach the relay; clearing the key from the service does the same for a page that still names it, with an
   error until the page is updated.

## Keys and recovery

The Tacit identity key is a hash of an Ethereum wallet's signature over one fixed message (`dapp/identity-message.js`),
the same in every Tacit app, so one wallet opens the same balances anywhere. The signature is the key: sign it only in a
Tacit app you trust. A smart-contract wallet cannot open a key. Everything else derives from the key (the wallet seed,
the Secret Sats address, every receive box), so balances rebuild from the key and the chain alone.

A wallet stores view-level state only: the tree's right edge, the paths of its notes, and each note's position, value and
shared secret. Spending keys are derived when needed and never stored. The anon.wei page seals that state under a key
derived from the view key.

### Catch-up points

The pool keeps no leaves: its tree is proven in-circuit, and the contract holds only the root and, for every root it has
held, the leaf count it had then (`rootSize`). A wallet rebuilds the tree from the pool's `Transact` events, which on a
busy chain is the slow part of opening a key on a new device: every event since the pool's first block, then a Poseidon
hash per leaf and a curve multiplication per memo.

A catch-up point cuts the first part out. It is the tree's right edge at a leaf count (the 32 filled subtrees of an
incremental Merkle tree, from which the root at that count follows with 32 hashes) together with the block at whose end
the tree had that count. Anyone who has read the pool that far can post one to the registry (`TacitEvmPoolCheckpoints`,
`post(size, blockNumber, filled)`); the registry folds the edge to its root and keeps the post only if the pool's
`rootSize(root)` equals `size`. So every point in the registry is one the pool itself vouches for, whoever posted it, and
a wallet can take the newest (`latest()`, `pointAt(size)`), check it the same way, continue the tree from it, and prove
spends of any note inserted after it at once.

The block number is the poster's word: the registry holds it only to a size that fits, since some chains' `block.number`
is their parent chain's and cannot be compared with the post. A wallet takes it as the place to start reading, and checks
it. It must lie between the pool's first block and the newest block the wallet trusts; where its node serves a state that
old, the pool must not already have held more leaves than the point's count at that block (a block later than the real one
would leave a gap, and the wallet passes that point over for the one posted before it, `prev`); and an earlier block only
costs reading events the edge already holds. The events after the point must then begin at its count, which the wallet
checks again as it reads; if they do not, it drops the point and reads from the pool's first block. Nothing older than the
point is lost: the wallet reads the history behind it in the background, from the pool's first block, into a second state
that takes the first one's place once both are read through the same block with the same root; until then, older notes are
not shown, and no one-time address is issued (the next index follows the last one used, which that history holds).

Posting costs gas and nothing else (about 1.7M gas: 32 Poseidon hashes and the edge in storage). anon.wei offers it
under Activity → Catch-up points to a wallet that has read the whole history; the keepers post one on each chain when the
pool has grown by `EVM_POOL_KEEPER_POINTS_EVERY` leaves (default 2,000), or a day (`EVM_POOL_KEEPER_POINTS_MAX_AGE_SECS`,
default 86,400) has passed with at least a tenth of that growth, since the newest point; `EVM_POOL_KEEPER_POINTS_GAS`
(default 2,500,000) sizes the post and `EVM_POOL_KEEPER_POINTS=0` turns posting off. One post per count, the first to land.

## Standalone wallet

`dapp/evm-pool/tacit-evm-pool-wallet.js` (built by `node build/build-evm-pool-wallet.mjs`) is the whole private-ETH
wallet as one ES module with no imports: key derivation, note scanning, proving (snarkjs 0.7.6 in a worker started
from a Blob) and submission. It checks the ceremony files against their pinned hashes before it uses them. It is
served at `https://tacit.finance/evm-pool/tacit-evm-pool-wallet.js` with `Access-Control-Allow-Origin: *`, as are the
ceremony files beside it.

Current build (667,636 bytes): sha256 `384a88220fb78f576e60480439bceb3e91e0fe8a32557f5c01c672390b81f5bc`, IPFS
`bafybeihtthsjejf4ij3g2yfpkcvhavkvvw6tfryismkrw5c6ij5ifb6u3y` (pinned on Filebase), onchain copy on Base Sepolia
([above](#an-onchain-copy-of-the-proving-files-base-sepolia)). The build is deterministic from the repository: `npm ci`
in `build/`, then `node build/build-evm-pool-wallet.mjs` prints the same hash. The build before it, which knew only
Ethereum, Base and Robinhood Chain, was
`cdc59dd5d5c95370a30161dd64637e32590b85290241944184283a05098c15c0` (IPFS
`bafybeigatwjp4gda4y3hj4zza7mgmk4qsipqs7gcgqipudql7625eefthy`).

The wallet keeps its synced state in storage sealed under a key from the wallet's view scalar. It finds history
through the keeper's feed and checks every batch, from the feed or from a node's logs, against the pool (`rootSize`).
It never sends a note's nullifier to a node to ask whether it is spent. A feed could withhold a memo and so hide an
incoming note; `rescan()` rebuilds the state from chain logs alone, and a spend that keeps failing runs it.

```js
import { makeEvmPoolWallet } from './tacit-evm-pool-wallet.js';
const w = await makeEvmPoolWallet({
  provider,                 // EIP-1193, on chainId; signs, and reads unless `rpc` is given
  chainId: 8453,
  identityKey,              // the 32-byte Tacit identity key
  artifacts: { wasm, zkey, vk },   // transact.wasm, transact_final.zkey, transact_vk.json
  relay,                    // optional keeper base, …/evm-pool/keeper
});
await w.sync();                         // { balance, notes, leaves, block }
await w.deposit(wei);                   // from the user's wallet
await w.receive.sweep();                // the private ETH address → a note, from the user's wallet, no fee
await w.send('bp1…', wei);              // private payment
await w.withdraw('0x…', wei);           // to any address
```

`artifacts` may also be an async loader, called the first time an action proves, or left out and set later with
`w.setArtifacts(...)`: opening, `sync`, `balance`, the addresses and a view-only wallet (`rpc` without `provider`) never
download the proving files, and opening never asks the wallet to connect. On Ethereum, `w.toV1(wei, commit)` (`wei` a
multiple of 10^10) moves ETH into a V1 tETH note in one `withdrawToV1` (commit = V1's wrap commitment for the wallet's
own next note; the V1 wallet finds and settles it as any wrap), and `w.bridgeOut(toChainId, wei, { l2Rpc })` moves it to the
wallet's private ETH address on Base or Robinhood Chain.

With no `relay`, every action but `bridgeOut` is proved on the device and sent from `provider`: no keeper, no relayer,
no fee beyond gas; `bridgeOut` needs `relay`. With `relay`, `send`, `withdraw` and `toV1` go through the keeper (its
fee, no gas) unless called with `{ via: 'self' }`; `deposit` and `receive.sweep` always send from `provider`. Each
action takes `{ via, maxFee, onStep(msg) }` as its last argument (`bridgeOut`: `{ l2Rpc, maxFee, onStep }`): `maxFee`
(wei) is the most a relayed spend may pay the relayer, the fee the caller showed, and a dearer quote is refused before
anything is signed (the error's `feeMoved` is the new fee). `w.quote(gas?)` reads the relayer's quote, priced for a
spend that burns `gas` when given. A spend the wallet must merge notes for first pays the fee once per merge, and is
refused before the first when the notes cannot cover it. `w.receive.address` is the private ETH address and
`w.receive.waiting()` what sits there unswept. This module does not register its private ETH address with a keeper;
`w.receive.sweep()` collects it. With `relay`, confirmed history is read from the keeper's feed first (checked as
above); `w.rescan()` rebuilds from chain logs alone. `w.terminate()` stops the worker. Synced state stays small as the
pool grows: the tree's right edge and the paths of the wallet's own notes.

**Chains and confirmations.** `makeEvmPoolWallet` accepts `confirmations` (default 3 here; `dapp/evm-pool-wallet.js`
itself defaults to 12): history is kept once it is that many blocks deep. The anon.wei page uses 3 on Ethereum and 10 on
Base and Robinhood Chain. The bundle knows the deploy blocks of Ethereum (1), Base (8453), Robinhood Chain (4663) and
MegaETH (4326, where it reads logs 100,000 blocks at a time) and, with a `relay` on a real origin, holds a quote to each
one's pinned relayer address and fee ceiling. For another chain with the suite pass `deployBlock` (and `logChunk`, the
block range of one log read, 5,000 by default); `bridgeOut` starts from Ethereum and goes to Base or Robinhood Chain only
([MegaETH](#megaeth-and-building-an-app-on-another-chain)).

## Moving to an L2

From the Ethereum pool, `bridgeOut({ toChainId, amount, l2Rpc })` in `dapp/evm-pool-wallet.js`
(`w.bridgeOut(toChainId, wei, { l2Rpc })` in the standalone wallet; `l2Rpc` is only needed for Robinhood Chain)
withdraws through a keeper into a call escrow whose one call deposits through the L2's canonical bridge to the wallet's
own private ETH address there (a receive box is at the same address on every chain, since the router is). That chain's
keeper sweeps it into a note once the box is registered there (`watchReceive()` on the L2 wallet, or
`POST /evm-pool/keeper/receive`) and holds at least the keeper's `receiveMin`; a smaller amount waits for the owner's
sweep. Gateway builder: `bridgeEthCall`. It arrives in minutes; the amount and the address are public on both chains,
which deposit paid is not.

The anon.wei page offers the same under Withdraw ("My Base", "My Robinhood"), sent to a new one-time receive box that
has never been used or shown, registered with that chain's keeper before the move, and only for amounts at or above
that keeper's `receiveMin`.

| To | Call from the escrow | Notes |
|---|---|---|
| Base (8453) | `L1StandardBridge.depositETHTo(to, 200000, 0x)` at `0x3154Cf16ccdb4C6d922629664174b904d80F2C35` | `depositETH` is EOA-only. Arrives in 1–3 min, exact. The deposit costs about 620k L1 gas in all, most of it the portal burning gas to buy the deposit's L2 gas. |
| Robinhood Chain (4663) | `Inbox.createRetryableTicket(to, amount, sc, to, to, gasLimit, maxFeePerGas, 0x)` at `0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D` | Never `depositEth`, which credits a contract's L2 alias. `sc` = `calculateRetryableSubmissionFee(0, 8 × L1 basefee)`; `gasLimit` = 1.5 × `NodeInterface.estimateRetryableTicket`, never less than 100,000; `maxFeePerGas` = max(8 × L2 gas price, 0.1 gwei), so the ticket runs even if the L2 fee moves. Unused gas refunds to `to` on L2. `to` must have no code on Ethereum when the ticket is made. |

There is no move to MegaETH built in: shield there from a wallet, or pay a deposit address there. Coming back from an L2
is the rollup's own exit, which takes days; no fast path is wired.

## Moving between V1 and this pool

The pools keep separate notes, so value moves by a public exit from one and a public entry into the other. Both
ends show the amount: a hop is linkable by amount, and by address once a box is completed. What the V1 route adds is
that the funds' origin is any V1 note holder rather than a public wallet.

| From → to | How |
|---|---|
| V1 → pool | A V1 settle withdrawal with `recipient = depositBoxOf(intent)` (native ETH, `value × 10^10` wei). `settle` pays an address with no code, so it cannot revert on the box. A keeper given `{ intent, hint }` at `/deposit` completes the deposit afterwards. |
| V1, other asset → pool | A V1 exit recipe (`ConfidentialRouter.exitAndExecute`) swaps to ETH and sweeps to `finalRecipient = depositBoxOf(intent)`. |
| Pool → V1 | `withdrawToV1(tx, intent)` with `intent.assetId` = the native ETH id above and `intent.commit` = the V1 note commitment. |
| Pool → V1 shielded note (any asset) | `withdrawAndCall` with a `v1ZapShieldedNoteCall` or `v1ZapCanonicalNoteCall`: swap and shield into V1 in the same transaction. |
| Pool → anything | `withdrawAndCall(tx, intent)` (above), on every chain. On Ethereum, a withdrawal can also name `ConfidentialRouter.escrowAddressFor(recipe)`, run by anyone with `activateExit(recipe)`. |

## The reference app: anon.wei

[anon.wei.limo](https://anon.wei.limo/) is a complete app for this pool in one HTML file, served from contract code on
Ethereum. It offers Ethereum, Base and Robinhood Chain, the most liquid of the chains the pool is on: shield from a
wallet or a token, send, withdraw to an address or as a token, a standing deposit address, payment links and a move to
Base or Robinhood Chain. A community that wants the same service on another chain (the core pool is also on MegaETH, and
more chains may follow) can start from it instead of from nothing.

| Where | What |
|---|---|
| `https://anon.wei.limo/` | The page, by name. `anon.wei` is registered in WNS (`0x0000000000696760e15f265e828db644a0c242eb`): `computeId("anon")`, then `resolve(id)` gives the contract that serves it. |
| `https://<contract>.w4eth.io/` | The same page by contract address, through an ERC-8244 gateway (any contract with `html()`). |
| `https://<contract>.1.w3link.io/` | Through ERC-4804 (`request()`). This gateway adds a script of its own after `<body>`, so its bytes are not the contract's. |
| `html()` on the contract | The page itself, from any node: `cast call <contract> "html()(string)" --rpc-url <rpc>`. The call is a read: about 1.1 million gas for the current page, far under the usual 50 million call cap. |

**Finding the newest version.** The contract is a versioned wrapper. `latest()` called on any version walks `successor` to
the newest, `successor()` and `PREVIOUS()` give the neighbours, and `PAGE_HASH`, `PAGE_LENGTH`, `chunkCount()` and
`chunkAt(i)` describe what it serves. A version never redirects: it serves its own bytes forever, so a reader who audited
one stays on it by not walking, and the keccak256 of `html()` must equal `PAGE_HASH`. The page also pins the proving key
and witness program by SHA-256 and uses them only when they match, so a mirror cannot change what it proves with. On 12
October 2026 the newest version is `0x0000002145004Fd9637c0FA5AED0A9Ea05E89A9D` (`PAGE_LENGTH` 340,906 bytes in 14
chunks; `PAGE_HASH` `0x3aef828273b39c6b095d18c26d190ced0baf531ba076c9dc768898907c32d649`).

**Adapting it to a chain.** The source is the deployed page. Fetch `html()` and edit it, or read it with its chunker and
deploy tools in `tacit-pay/` of the `ERC8244/dapps` repository. The places to change:
- `CHAINS`: one entry per chain, with `chainId`, names, `explorer`, `relay` (the relay URL, or none), `deployBlock` (the
  pool's deploy block), `confirmations`, `gasReserve` and a list of `rpc` URLs. Add an entry for the new chain; a chain
  with no relay sends every spend from the user's wallet.
- `POOL`, `ROUTER` and the verifier are the same addresses on every chain, and need no change.
- The token flows (shield from a token, withdraw as a token) use `ZROUTER`, `ZQUOTER`, `TLIST` and `ZAP`, which exist only
  on Ethereum, Base and Robinhood Chain. On a chain without them, remove or hide those forms; the rest of the app does not
  use them.
- The document's security policy pins its one script by SHA-256 in `script-src`. After any edit to the script, hash the
  module text (SHA-256, base64) and replace the pin, or the browser will not run it. `connect-src` already allows any
  https host, so a new node or relay needs no change there.
- Test before publishing. `tools/evm-pool-mega-check.mjs` runs a shield, a private send, a withdrawal and a deposit-address
  sweep on a chain from a script, with or without a relay.

To publish an edited page as contract code, use the same wrapper pattern (the chunk contracts and a constructor that checks
the page hash); or serve it as an ordinary static page, since it needs nothing from a server. An agent can do the whole
adaptation from this guide, the live page and the check tool.

## MegaETH and building an app on another chain

The pool, router, verifier and PoseidonT5 are live on MegaETH (chain 4326) at the addresses above, deployed on 5 October
2026 (pool deploy block 28,397,750; transactions in [`contracts/deployments/evm-pool.json`](../contracts/deployments/evm-pool.json)).
The code is the same as on the other chains: the verifier and PoseidonT5 are byte-identical, and the pool and router differ
only in their immutables. A relay runs at `https://tacit-evm-pool-keepers.onrender.com/4326/evm-pool/keeper`.

**Where it is supported.** The standalone wallet knows it ([below](#standalone-wallet)): shield, send, withdraw, a deposit
address, payment links and the relay, with reads in 100,000-block ranges. The tacit.finance pages and anon.wei do not list
it. It is the simplified pool: no token swaps or token forms, since zRouter, zQuoter, the token list and the zap are not
on the chain ([Swaps and zaps](#swaps-and-zaps)), and no move from Ethereum. An app of your own can use MegaETH now.

| On MegaETH | |
|---|---|
| Works | Shield, private send, withdraw, deposit addresses (receive boxes), the relay, withdraw-and-call to any target |
| Not there | Shield from a token, withdraw as a token (zRouter, zQuoter, the zap, the token list), V1 wrap boxes, a move from Ethereum |

**What was tried on MegaETH, with real ETH.** On 5 October 2026: a shield from a wallet; a private send with change; a
withdrawal to a fresh address from the recipient's own wallet; the same withdrawal through the relay (exact amount, fee
paid from the note, the recipient needing no gas); and a deposit address (a receive box) paid by a plain transfer and swept
by its owner, which closed with no code and no balance. The relay's own sweeping of a deposit address needs a payment above
its minimum (0.00072 ETH) and was not exercised. The check is `tools/evm-pool-mega-check.mjs`, a runnable example of an app
with no relay: it proves and sends everything itself.

**Differences to plan for on MegaETH.**
- A plain ETH transfer needs at least 60,000 gas there, not 21,000. A wallet or exchange that hard-codes 21,000 for the
  transfer to a deposit address will be refused by the node.
- Storage and contract creation cost far more gas than on Ethereum (about 10,000 gas per byte of deployed code), so
  estimate gas with the node (`eth_estimateGas`) and not with a local simulation. A pool transaction is about 0.6 million gas.
- `eth_getProof` is not supported. The public RPC served `eth_getLogs` over a 100,000-block range in testing.
- Blocks are very short (about one a second), so a relay waits a few hundred blocks (200 here) before treating a deposit as
  settled.

**What an app needs.** Start from [the reference app](#the-reference-app-anonwei), and see these in the library it uses.
1. Detect the pool by code at its address, and read its events from the chain's deploy block.
2. The proving key and witness program, from tacit.finance, IPFS or the [Base Sepolia copy](#an-onchain-copy-of-the-proving-files-base-sepolia),
   each checked against its SHA-256 (`pin.json`), and the verifying key hash pinned in `makeGroth16System({ pinnedVkHash })`.
3. The wallet library: `makeEvmPoolWallet` in `dapp/evm-pool-wallet.js` with `dapp/evm-pool-gateway.js` and
   `dapp/evm-pool-zk-prover.js`, or [the pinned standalone bundle](#standalone-wallet) (`tacit-evm-pool-wallet.js`, which
   knows MegaETH). Pass a `signer` for self-sent actions, and a `keeper` URL to relay. Keys
   derive from a wallet signature over the Tacit identity message, so one key opens the same balance on every chain, and
   the deposit address is the same on every chain. For a chain with short blocks, set the chain's `logChunk` (100,000 on
   MegaETH).
4. Optionally a relay. Run `worker-relay/src/evm-pool-keeper.js` (env-configured: `EVM_POOL_ADDR`, `EVM_POOL_ROUTER_ADDR`,
   `EVM_POOL_CHAIN_ID`, `EVM_POOL_RPC_URL`, `EVM_POOL_START_BLOCK`, `EVM_POOL_CONFIRMATIONS`, and per-action gas such as
   `EVM_POOL_KEEPER_SWEEP_GAS`), or point a wallet at the one above. Set `maxRelayFee` and the expected `relayer` in the
   chain config so a relay cannot quote more than you allow; the library's built-in tables (`RELAYERS`, `MAX_RELAY_FEE` in
   `dapp/evm-pool-wallet.js`) cover Ethereum, Base, Robinhood Chain and MegaETH, and a chain missing from them is not
   checked unless you set both.
5. The notes of a pool are bound to its chain: nothing moves between chains except by withdrawing and depositing, and a
   user's balance on each chain is found again from their key and that chain's events.

## Questions

Answers for people using the private ETH pool through anon.wei.limo or tacit.finance, and for integrators. Chains:
Ethereum (1), Base (8453), Robinhood Chain (4663) and, for the core pool, MegaETH (4326). The anon.wei page offers the
first three; the tacit.finance pay page offers all four.

### What is public and what is hidden

**What does each action show on chain?**
See [What each action shows](#what-each-action-shows).

**Where does the privacy end?**
The pool hides which deposit pays a withdrawal, and who pays whom in a private send. Amounts and addresses of deposits and withdrawals are public. While the pool is small, the timing and amount of a withdrawal can match it to a deposit.

**What changes if my wallet sends the transaction instead of the relay?**
The wallet's address shows as the sender. For a withdrawal or a private send, anyone can tell that wallet used the pool; the amount of a private send and the source of a withdrawal stay hidden. For a shield, your wallet always sends the transaction, because a deposit is paid by whoever sends it. A relayed transaction shows the relay's address as sender and the fee it was paid. Nothing names your wallet.

**Can I prove I paid someone?**
Yes. A spend's one-time key is derived from your key, the spend's first nullifier and the output position, so the reference wallet can derive it again later. With the recipient's address, anyone can check that the output pays them and read the amount (`paymentKey`, `verifyPayment` in `dapp/evm-pool-wallet.js`). Deposits use a random key and have no such proof.

### Withdrawing well

**What does "linked" mean when a withdrawal goes to my own wallet?**
It means the same address appears on both sides: it shielded, and it received a withdrawal. That address ties the two together. A withdrawal sent from your own wallet has the same effect: the wallet shows as the sender. To keep deposits and withdrawals apart, withdraw to an address that never shielded, and let the relay send it.

**Does repeating a withdrawal address, or leaving a balance, matter?**
Two withdrawals to one address tie to each other. They do not tie to your deposits or to what stays in your balance. You do not need to empty your balance: what stays in the pool is a new note whose value is not visible. Take out the part you need.

**Which amounts and timing work best?**
Use a round amount and let time pass between a deposit and its withdrawal. An exact amount soon after a deposit of the same size is the easiest match to make. On a form whose amount shows on chain, the page's Max rounds down to two significant digits (for example 1.2345 ETH becomes 1.2 ETH) and says what stays private.

**Where should a withdrawal go?**
To a fresh address, through the relay. The page refuses your own deposit addresses as a destination, and asks you to confirm before paying a contract.

**What happens when I withdraw to a contract?**
The pool sends the ETH with a limited gas allowance (100,000 gas). If the contract does not accept it, the pool still delivers it by a forced transfer that runs no code on the contract. Pay a contract only if it is built to hold ETH.

**What if I have many small notes?**
One transaction spends at most two notes. A balance in more than two parts needs combining first, and each combine pays the relay's fee once (or gas, from your wallet). One payment combines at most seven times by itself; a balance in more parts than that is combined first with Combine, which the page offers when this applies, and leaves notes worth less than a step's fee as they are.

### The relay

**What does the relay see?**
Your IP address, as any web server does; the transaction it is asked to send, which becomes public anyway; the new note commitments and spent nullifiers when you reserve a slot; the deposit addresses you ask it to watch (chain, note key, fee cap); and the block your history read begins in: the start of a range of blocks (a day on Ethereum, an hour on Base) if you have been away, not your own place in it, and where your last read ended if that was in the last ten minutes. The page also asks each chain's relay for its fee when you start signing in. See [Relaying](#relaying).

**What can the relay not do?**
Redirect funds or change an amount. The proof binds the recipient, amount, relayer address and fee, and the pool recomputes that binding on chain. A copy of the transaction sent by someone else still pays the relay named in it. The relay never holds a key that can spend: a spend needs your signature inside the proof.

**How is the relay's fee bounded?**
The page checks each quote before anything is signed: it is for this chain and this pool, from the relay address the page expects, within a fixed ceiling per chain, and no more than the larger of 0.0001 ETH and 8 times what the quoted gas costs now. A fee that later moves more than 20% above the one you were shown asks you to confirm again. The ceilings are under [Relaying](#relaying). A relay you set under Endpoints is held to the ceiling, not to the default relay's address.

**Can I always send from my own wallet?**
Yes. The pool does not require a relay. Choose "send from my wallet" on the form, or leave out `relay` in the standalone wallet. You prove on your device and pay the gas, and your address shows as the sender.

**What if the relay does not answer?**
A payment whose proof has left your device holds its notes until the chain shows whether it landed. Trying again reuses the same notes, so the payment cannot happen twice.

**Which nodes learn what?**
The page reads the pool's logs for the whole chain and finds your notes on your device, so no node is asked about your notes. A node is asked the balance of your standing deposit address with each refresh. One-time deposit addresses are read one per request, from randomly chosen nodes, seconds apart. A proof sent by your wallet is checked through your wallet's own node; a relayed proof is checked by the relay. Reads that name your wallet go through your wallet's own node.

**Can I use my own node?**
Yes: under Endpoints, enter one node URL per chain (your own node, or a private RPC); two, separated by a space, must agree. The reads that say what you are doing then go only to it: the names you pay (read on Ethereum, so set one there too), swap routes, withdrawal addresses, your deposit addresses and the pool's checks. Only the pool's history, the same for every reader, falls back to the public nodes, and only when your node does not serve it. Under Endpoints you can set your own relay too.

### Deposit addresses and payment links

**What is a deposit address?**
A standing Ethereum address for one note key of yours. Anyone can pay it, any number of times, from any wallet or exchange. Anyone can then sweep its balance into the pool as a note for you. The same address works on every chain.

**What can I send to it?**
Plain ETH transfers, from any wallet or exchange. Only the pool's asset leaves a deposit address, so anything else sent there stays there. A plain transfer works because the address has no code between sweeps: a sweep creates the box, empties it and removes it in one transaction.

**Who sweeps it, and what does that cost?**
Anyone can. A relay keeps at most 0.25% of the swept balance, and only when that covers its gas. You can sweep from your own wallet for no fee, at any amount. Ask the relay to watch an address, or fund it through the router's `fundReceive`, so the relay knows to look.

**What do payments to one deposit address show?**
They are public and linked to each other, like any reused address. A sweep shows the amount. Spending the swept notes shows nothing about the note key.

**Why should each payer get their own address?**
One-time addresses keep one payer's payment apart from another's. Your key issues them, nothing on chain ties two of them together, and your key finds them again from the key alone.

**Can I pay a deposit address from a private pool?**
Yes. A withdrawal from a private pool is an ordinary payment to the address, so your depositing wallet never appears here. Pay a one-time address (tacit pay, Deposit, Fresh address), once: an address that also took an exchange payment ties the two together. The amount shows at both ends, so use a round one, and wait between the pool deposit and the withdrawal. How well that pool hides you is its own, not this pool's.

**What does a payment link reveal?**
A link carries a deposit address and your signature over it, made with the view key of your pool address. The payer's page uses it to check that the address is yours. Anyone who holds the link can tell the address is yours.

### Keys and recovery

**Where does my key come from?**
Your wallet signs one fixed message, and the key is a hash of that signature. The message is the same in every Tacit app (`dapp/identity-message.js`), so the same wallet opens the same balances anywhere. The first sign-in in a browser asks for the signature twice, to confirm your wallet signs the same way each time. The signature is the key: sign it only on anon.wei.limo or tacit.finance.

**Can I sign in with a smart-contract wallet?**
No. A key opens only from an ordinary account (an account with an EIP-7702 delegation works).

**What do I back up?**
Nothing besides your wallet. Balances, notes and deposit addresses rebuild from the key and the chain. The page finds up to 20 unused one-time deposit addresses on every chain, so use the ones you have issued before issuing more.

**What does the browser store?**
View-level state: the tree's right edge, the paths of your notes, and each note's position, value and shared secret. It is sealed under a key derived from your view key, under storage names derived from it too. Spending keys are derived when needed and not stored. The proving key (about 33 MB) is cached and checked against its SHA-256 before each use. "Rebuild" reads the chain's logs alone.

### Names

**What does a name lookup reveal?**
The nodes asked see the name, and your IP address. Nothing goes on chain. The page asks two nodes first, and counts an answer when two agree. It reads the name again just before paying, and sends nothing if the name has moved. On the anon.wei page, reads that name your wallet go to your wallet's own node, so the nodes that see a name do not also see your wallet. With your own Ethereum node set under Endpoints, only it sees the names you look up. A link that carries a `tacit1…` address instead of a name needs no lookup.

**What must a name publish?**
To receive a send or a shield, a `.wei`, `.gwei` or `.eth` name must publish a Tacit address (`tacit1…` or `bp1…`) in its `finance.tacit` text record. To receive a withdrawal, it needs only an address record. `.base.eth` names and names whose records are kept off chain are not read.

### Contracts

**Who controls the contracts, and what if a change is needed?**
No one. The pool and router have no owner, no pause and no upgrade. Nothing can freeze or seize funds. The pool can be called directly; the router is optional periphery. A change ships as a new contract at a new address. Users withdraw from the old pool and shield into the new one.

**Where are they?**
[Addresses](#addresses): the same on all four chains. Do not send ETH to the pool or the router: a plain transfer to the pool reverts, and the router hands a stray balance to its next caller. The zap has no owner either and refuses a plain transfer.

### Withdraw and call

**What is it?**
`router.withdrawAndCall(tx, intent)` withdraws and, in the same transaction, runs the calls in a `CallIntent`: a swap, a bridge deposit, a wrap into V1, or any call. The withdrawal's recipient is the intent's escrow address, so the proof binds the whole intent and a relayer can change neither the calls nor where their outputs go. The calls, outputs, refund address, amount and the relay's fee are public; which note paid stays hidden. If any call fails or an output falls short of its minimum, the whole transaction reverts and nothing is spent. The rules and the refund are under [Router](#router).

**Can a withdrawal arrive as a token?**
On the anon.wei page, yes: under Withdraw, pick a token from the onchain token list (token.list.wei, read from Ethereum for every chain). The amount can be set in ETH or in the token.
The withdrawal pays a call intent whose one call is zRouter (`0x000000000000FB114709235f1ccBFfb925F600e4`), along the
route the onchain quoter zQuoter (`0x000000bd2db80567c23e353ca95a251c573cbf9b`) finds, and zRouter sends the token
straight to the address you give. zRouter enforces the route's minimum, so a short fill reverts the withdrawal. The
quote is read with a stand-in recipient, so the nodes asked do not learn the address, and two nodes must return the
same route. The token, the amount and the address are public; which deposit paid is not.

**Can I shield from a token?**
On the anon.wei page, yes: under Shield, "From my wallet", pick a token from the same list. By
default, one transaction from your wallet swaps it through zRouter for an exact amount of ETH and shields it through the
zap: no fee, and your wallet pays the gas of the swap and the deposit. Or let the relay move it in: the swap pays a new
deposit address of yours, and the relay sweeps it into your balance for up to 0.25%, your wallet paying only the swap's
gas. Either way the approval is a signature where the token and wallet allow it, or part of one wallet batch; a separate
approval transaction is needed only when neither works. Your wallet, the token and the ETH amount are public; whose
balance it lands in is not.

**How do I get a refund back into the pool?**
Make `refund` one of your own deposit addresses (`callRefundBox`). A relay sweeps it when its capped fee covers its gas, and you can sweep it yourself.

### Several chains

**Are the pools connected?**
No. Each chain has its own pool, and a note is bound to its chain. One key opens your balance on every chain, and a deposit address is the same on every chain.

**How does ETH move between chains?**
From the Ethereum pool to Base or Robinhood Chain, one withdraw-and-call through the rollup's own bridge pays a deposit address of yours there, which that chain's relay sweeps into a note ([Moving to an L2](#moving-to-an-l2)). The anon.wei page offers it under Withdraw, "My Base" and "My Robinhood". On arrival the rollup's relay keeps up to 0.25%. Between any other pair of chains, including MegaETH, withdraw on one and shield on the other.

To move ETH back from a rollup, withdraw there and use the rollup's own bridge. No faster path is built into the pool.

### Compared with other designs

**Arbitrary amounts or fixed denominations?**
Notes hold any amount below 2^120 wei, so you pay and withdraw exactly what you mean. A pool with fixed denominations gives every deposit a standard size. Arbitrary amounts mean an unusual amount is easier to match, which is why the page rounds Max and why round amounts help.

**Why two inputs and two outputs?**
The circuit has 2 inputs and 2 outputs. A transaction can spend two notes and create a payment and change. A balance in more than two parts is combined first.

**Where are proofs made?**
In your browser, in web workers. The page downloads the proving files once (about 33 MB), checks them against pinned hashes, and keeps them. The standalone wallet checks the same hashes. The page checks each proof it sends from your wallet against the pool's verifier first; the relay checks the proofs it sends.

**Contracts: immutable or upgradeable?**
This pool is immutable. A design with governance can change its rules after deployment; this one cannot, so a change means a new pool and a move (see Contracts).

## Checklist

- Detect deployment by code at the pool address; fetch the final `wasm`/`zkey` by CID and pin the verification key
  hash in `makeGroth16System({ pinnedVkHash })`.
- Retry stale proofs automatically; send through private order flow.
- Always set a non-zero refund address on a box intent, and amounts below 2^120.
- Relayers: never submit someone else's deposit (`extAmount > 0` pulls `msg.value` from the sender).
- Chains need Shanghai (PUSH0) and Cancun (transient storage).
- Size gas from the node, not from a local simulation (MegaETH charges far more for storage and contract creation), and
  allow at least 60,000 gas for a plain transfer to a deposit address there.
