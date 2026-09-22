# Ceremony artifacts

Tacit's transparent stack (SP1, Bulletproofs+, Schnorr kernels) needs no trusted setup. Two finalized
Groth16 ceremonies supply keys for circuits that are expensive to express otherwise
([SPEC §2.8](../SPEC.md#28-circuits-and-ceremonies)). This page lists every artifact, where it lives, and how
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
| r1cs | `bafybeico2tziscjb2k3pknvyo5tqx652xcby2mcibnmgivav25fnsv72w4` · [`dapp/circuits/amm/build/amm_swap_batch.r1cs`](../dapp/circuits/amm/build/) |
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

## Mixer ceremony

`withdraw.circom` (Poseidon-Merkle depth 20, nullifier, unspent-leaf membership) backs the fixed-denomination
mixer ([SPEC §3.8](../SPEC.md#38-legacy-ops)).

- Phase 1: Hermez `pot14`.
- Phase 2: 2,227 contributions, beacon at Bitcoin block 948,824.

| Artifact | Identifier |
|---|---|
| Bundle (r1cs, ptau, final zkey, vk, attestations) | `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u` |
| Verifying key | `bafkreidwbautgstcnl54oszez7yqlc7mr5lrj6ac65h3p5sjw2rgz2jtv4`, SHA-256 `760829334a626afbc74b24cff1058bec8f5714f802f74fb7f649b6a26ce933af` |

File hashes and a local verification recipe are in
[`dapp/circuits/ceremony-bundle/README.md`](../dapp/circuits/ceremony-bundle/README.md).

## Availability and backup

- **Ceremony coordinator.** `GET https://api.tacit.finance/ceremony/<circuit_hash>` returns each chain's state:
  `head_cid` (the final zkey), `r1cs_cid`, `ptau_cid`, contribution count and beacon.
- **Where the dapp gets the zkey.** The dapp resolves the head zkey from the coordinator. If the coordinator is
  unreachable, it fetches the pinned CID above. A zkey that is not the finalized one produces proofs the
  guests reject, so a wrong download fails closed.
- **Mirrors.** Every CID on this page is in [`tools/mirror-pins.sh`](../tools/mirror-pins.sh):
  - `FILEBASE_BUCKET=<bucket> tools/mirror-pins.sh` copies them to another provider;
  - `tools/mirror-pins.sh audit` reconciles what a provider holds.

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
