# Ceremony artifacts

Tacit's transparent stack (SP1, Bulletproofs+, Schnorr kernels) needs no trusted setup of its own; SP1's proofs are
wrapped in Groth16 for Ethereum under SP1's own setup. The Bitcoin shielded pool and the Tacit chain prove spends with
Halo2-KZG over the public Hermez `pot18` powers of tau, so they need no ceremony of their own either. Three finalized
Groth16 ceremonies supply keys for circuits that are expensive to express otherwise: the AMM and mixer ceremonies
([SPEC §2.8](../SPEC.md#28-circuits-and-ceremonies)) and the EVM pool ceremony. This page lists every artifact, where it lives, and how
to check it. Each value below was re-derived from the fetched bytes.

## AMM ceremony — used in production

`amm_swap_batch` clears blind batch swaps: up to 16 intents at one uniform price, with amounts hidden on chain and from the SP1 prover.
Its verifying key is compiled into both SP1 guests:

- `OP_SWAP_BLIND` in the confidential pool, verified by the settle guest ([SPEC §5.6](../SPEC.md#56-prover-blind-swaps)).
- `T_SWAP_BATCH` on Bitcoin, verified by the Bitcoin reflection guest ([SPEC §3.5](../SPEC.md#35-trading-amm-and-farms)).

A proof is valid only under the finalized zkey below.

**Setup**
- Phase 1: Hermez powers of tau truncated to 2^18 (`pot18_final.ptau`,
  `bafybeigb43fb66kxs4wlxwsgasr22g7itd6yzotgtu2dosjt7zcegsizri`).
- Phase 2: one chain per circuit, each sealed by the same beacon: Bitcoin block 951,267
  (`000000000000000000000be3845df0e8d28faad2476c8b1722468f988af129fd`), 10 iterations.

### `amm_swap_batch` (production)

| Artifact | Identifier |
|---|---|
| Circuit hash (r1cs SHA-256) | `2d9db81d741e59d65e1b52ac3d37c5da521ef8c3728e9cd715c9a8a45bd495f4` |
| r1cs | `bafybeico2tziscjb2k3pknvyo5tqx652xcby2mcibnmgivav25fnsv72w4`, built from [`amm_swap_batch.circom`](../dapp/circuits/amm/amm_swap_batch.circom) by [`dapp/circuits/amm/build.sh`](../dapp/circuits/amm/build.sh) |
| Phase 2 | 5,018 contributions + beacon |
| **Final zkey** | **`bafybeieb5hafaix2xwvnmsodby4vkvcpdv4bpt4ny3etza4lpy2rxefwqm`**, 97,468,648 bytes, SHA-256 `6ed30983a1c2faf287f3d2fc95fae08cc926aa563b2df2dc752c01f46ee03031` |
| Verifying key (JSON) | `bafkreidc35fn7w3pxa4u7phjulzgrgm3js5ifmgqil7liedkqb2bdgdtp4` · [`dapp/circuits/artifacts-amm/amm_swap_batch_vk.json`](../dapp/circuits/artifacts-amm/amm_swap_batch_vk.json) |
| Verifying key (guest bytes) | `contracts/sp1/confidential/src/batch_vk.bin`, SHA-256 `31fd05cc1b3d1f7df0459a321eaaf1d7f8bed702a4bc402787eef16ca16bbc7c` |
| Witness generator | [`dapp/vendor/amm_swap_batch.wasm`](../dapp/vendor/amm_swap_batch.wasm), SHA-256 `f5cbfb17770016c3f89cc8a2b85933f64d39020d1594b6de3b83313318034677`, CID `bafybeif7ov6xsch246wg24ve2lzn5mmqzkrherlwzp6yxovahwo4u4yony` |

The zkey's exported verifying key equals the JSON above, and that JSON equals the guest's
`fixtures/swap_batch_vk.json`, from which `batch_vk.bin` is serialized. The guest asserts `BATCH_VK_SHA256` at
run time, and the key is also fixed by the guests' own verifying keys (`PROGRAM_VKEY`, `BITCOIN_RELAY_VKEY`).

### `amm_lp_add` / `amm_lp_remove`

Finalized in the same ceremony. The deployed guests check liquidity changes with a kernel signature and a
Pedersen opening instead of these proofs, so no current op needs them.

| Circuit | Circuit hash | Contributions | Final zkey | Size / SHA-256 |
|---|---|---|---|---|
| `amm_lp_add` | `5a67cdcc9e432d8474147a212dabf35e65425522bac111f8a1805d9386afb701` | 13,668 | `bafybeifrj5wkuxpoa22o7rh7cu5mhnfvjoo77jhhdtouqbkut6rmms3e5q` | 4,624,696 / `3a6e3deb87491ccb321bb7ddba94675a32d6bbb485617c9c5d625c1dff127e4c` |
| `amm_lp_remove` | `005a38bfe8acc4d644e600aa91d08e08dba87170f87279bfb5b087230a4399b1` | 13,703 | `bafybeid6j7prcptds2yidi2ksyceldo2zkq4lscp77swfkgsixh7igbdpy` | 6,421,223 / `c370d9dd2f1e6a6cddd1759bdfe6ded35453e6f49d993de6e7360fff171647d0` |

Other AMM identifiers:
- Verifying-key wrapper for all three circuits: `bafkreibjpe4xfqtq2ziki4uupydnkeiakqi76m674xtdhmxnfbrn4iomp4`
  (`CANONICAL_AMM_VK_CID` in `dapp/tacit.js`).
- VK and transcript bundle: `bafybeiheww2ndia2gld4mu7x2h7iwzawv6likpmfpklm6x5kj3btaniuam`.

## EVM pool ceremony (Secret Sats EVM pool) — used in production

`transact.circom` backs the EVM pools on Ethereum, Base, Robinhood Chain and MegaETH ([EVM-POOL.md](./EVM-POOL.md)). Its key came from
one open ceremony on 26 and 27 September 2026: 176 contributions from 120 distinct public keys, sealed with the hash of
Bitcoin block 968,840 as the final beacon.

- Phase 1: Hermez `powersOfTau28_hez_final_16.ptau` (2^16); its hashes are in [`dapp/evm-pool/pin.json`](../dapp/evm-pool/pin.json).
- Phase 2: circuit hash `b0a246d1790151c722e42ccfa89450cb96c7f5a9f4b70a2162b7d9fc79b6ddb3`, beacon Bitcoin block 968,840
  (`000000000000000000019b1eec61f35a8da876de173e61f8a32109986182c033`), 10 iterations.

| Artifact | Identifier |
|---|---|
| Bundle (transcript, keys, verifier) | `bafybeia4yvn2zoggvgpjwg5vpwpt6aivjbcm6tgzxoxsukao2nm5yyypfy` |
| Final zkey | `bafybeia6c36bgww2svm6jfg6nl2pk337prc7t6gcfsvhuo5sufqjpi7z4a`, 28,558,285 bytes, SHA-256 `40758061a0786fb0bdc5e5dec4c354bbf85fc106f7412716e25e781af4e79c4b` |
| Verifying key | `transact_vk.json`, hash `43d11e6e1607e1ea7f3980c9bca91beed95e2e80d173d0873189e99d402e5757` |

**Records.** `GET https://api.tacit.finance/ceremony/b0a246d1790151c722e42ccfa89450cb96c7f5a9f4b70a2162b7d9fc79b6ddb3/attestations?limit=500`
lists every contribution: its index, an optional name, the contributor's public key, the contribution hash, the IPFS CID
of the full key after it, the CID of the key before it, and the time. All 176 keys are on IPFS under those CIDs (each is
about 400 bytes larger than the one before), and each contribution's previous CID is the one before it, so the chain can be
fetched and replayed from the genesis key.

**Who could contribute, and what the keys are.**
- The ceremony was open: no TAC holding or other eligibility proof was needed (the AMM ceremonies required one). Queue joins
  were rate-limited per address.
- Names were optional. 171 contributions are "anonymous"; five are Tacit's own test entries (#4, #6, #8, #9, #11).
- Each contribution records a public key: the contributor's Tacit wallet key, or a key kept in the browser when there is no
  wallet. The coordinator checks that the contributor holds it: joining the queue takes a BIP-340 Schnorr signature by that
  key over `sha256("tacit-ceremony-reserve-v1" ‖ circuit_hash ‖ pubkey ‖ queue_token)`, and the upload must come from the key
  that holds the head of the queue.
- An open ceremony accepts repeat contributions from a key, since each one mixes in fresh randomness. The browser keeps the
  key, so a returning contributor reuses it; the 176 contributions come from 120 keys.
- The success screen shows the contributor their contribution hash and recorded key. Contributors who chose to identify
  themselves did so by posting those.

**Code that ran it.** At the commit that closed the ceremony
([`ed2ffbf0a`](https://github.com/src-company/tacit/commit/ed2ffbf0a0947a0d54a5424b03b95134ddaad847)):
the coordinator is [`worker/src/index.js`](https://github.com/src-company/tacit/blob/ed2ffbf0a0947a0d54a5424b03b95134ddaad847/worker/src/index.js)
(`handleCeremonyInit`, `handleCeremonyReserve`, `handleCeremonyContribute`, `handleCeremonyAttestations`,
`handleCeremonyFinalize`); the browser client is [`dapp/tacit.js`](https://github.com/src-company/tacit/blob/ed2ffbf0a0947a0d54a5424b03b95134ddaad847/dapp/tacit.js)
(`snarkjs.zKey.contribute` runs in the page; `_ceremonyReserveSig` signs the queue join); the status page is
[`dapp/ceremony/index.html`](../dapp/ceremony/index.html); the tooling is [`dapp/circuits/evm-pool/`](../dapp/circuits/evm-pool)
(`ceremony-init.sh`, `ceremony-verify.sh`, `finalize.sh`); the test is
[`tests/ceremony-evm-pool.test.mjs`](../tests/ceremony-evm-pool.test.mjs).

**Verify.** `bash dapp/circuits/evm-pool/ceremony-verify.sh transact_final.zkey` replays every contribution back to the
genesis key against the pinned ptau (the script's header lists the files it expects). The pool's deploy script refuses
any verifier other than the ceremony's.

## Mixer ceremony

`withdraw.circom` (Poseidon-Merkle depth 20, nullifier, unspent-leaf membership) backs the fixed-denomination
mixer ([SPEC §3.8](../SPEC.md#38-legacy-ops)).

- Phase 1: Hermez `pot14`.
- Phase 2: 2,227 contributions, beacon at Bitcoin block 948,824.

| Artifact | Identifier |
|---|---|
| Bundle (r1cs, ptau, final zkey, vk, attestations) | `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u` |
| Verifying key | `bafkreidwbautgstcnl54oszez7yqlc7mr5lrj6ac65h3p5sjw2rgz2jtv4`, SHA-256 `760829334a626afbc74b24cff1058bec8f5714f802f74fb7f649b6a26ce933af` |

File hashes and a local verification recipe are in the bundle's `README.md`.

## Availability and backup

- **Ceremony coordinator.** `GET https://api.tacit.finance/ceremony/<circuit_hash>` returns each chain's state:
  `head_cid` (the final zkey), `r1cs_cid`, `ptau_cid`, contribution count and beacon.
- **Where the dapp gets the zkey.** The dapp resolves the head zkey from the coordinator. If the coordinator is
  unreachable, it fetches the pinned CID above. A zkey that is not the finalized one produces proofs the
  guests reject, so a wrong download fails closed.
- **Mirrors.** Every CID on this page except the EVM pool's final zkey is in [`tools/mirror-pins.sh`](../tools/mirror-pins.sh)
  (that zkey's CID and SHA-256 are in [`dapp/evm-pool/pin.json`](../dapp/evm-pool/pin.json)):
  - `FILEBASE_BUCKET=<bucket> tools/mirror-pins.sh` copies them to another provider;
  - `FILEBASE_BUCKET=<bucket> tools/mirror-pins.sh audit` reconciles what a provider holds.

  Multi-block artifacts (the zkeys, r1cs and ptau) need a local Kubo daemon so each block is hash-verified.

## Verify

```sh
# 1. The bytes are the recorded artifact
ipfs add --only-hash -Q --cid-version 1 amm_swap_batch_final.zkey   # → bafybeieb5haf…xefwqm
shasum -a 256 amm_swap_batch_final.zkey                              # → 6ed30983…3031

# 2. The zkey extends the ceremony chain
npx snarkjs zkey verify amm_swap_batch.r1cs pot18_final.ptau amm_swap_batch_final.zkey

# 3. Its verifying key is the one the guests enforce
npx snarkjs zkey export verificationkey amm_swap_batch_final.zkey vk.json
diff <(jq -S 'del(.vk_alphabeta_12)' vk.json) \
     <(jq -S 'del(.vk_alphabeta_12)' contracts/sp1/confidential/fixtures/swap_batch_vk.json)
```
