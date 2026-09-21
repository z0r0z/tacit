# TAC airdrop: inputs, method and how to check the root

This is the Ethereum-side distribution for the confidential pool and the formal v1 launch. It is separate from the earlier Bitcoin-side
airdrop described in [`../README.md`](../README.md), and is not a continuation of it.

A one-time distribution of 999,999 TAC (the public ERC20) to holders of seven tokens, through
[`TacAirdrop`](../contracts/src/TacAirdrop.sol). The contract, its roles and the claim paths are described in
[`docs/AIRDROP.md`](../docs/AIRDROP.md). This folder holds the inputs that produce the merkle root, so anyone can rebuild it.

| | |
|---|---|
| Contract | `0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8` (verified source) |
| Merkle root | `0x27451b320d5aa9631f7a3fd8adcfa537db8d792dd49aad9ab0951af0c2986a10` |
| Recipients | 8,652 |
| Total | 999,999 TAC |
| Claim window | until unix time 1797803449 (2026-12-20 21:50 UTC) |
| Guardian | the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |

## Tokens and weights

Each token gets a share of the pool by its rank, descending in equal steps (weights 7, 6, 5, 4, 3, 2, 1 out of 28). Inside a token,
each eligible holder takes its balance over the token's eligible supply, so decimals and units do not matter: an 18-decimal token
and an ERC721 count are both reduced to a fraction before they are added. An address that holds several tokens receives the sum.

| Rank | Token | Type | Share of pool |
|---|---|---|---|
| 1 | `0x00a6bA94BBb5474725515De88fE04F854f2dCb12` | ERC20 | 25.00% |
| 2 | `0xe9b1cfea55baa219e34301f2f31b9fd0921664ed` | ERC20 | 21.43% |
| 3 | `0x00000000008835cef3e0d2333695f288ee6b63a6` | ERC721 | 17.86% |
| 4 | `0x00000000000007C8612bA63Df8DdEfD9E6077c97` | ERC20 | 14.29% |
| 5 | `0x0000000000696760E15f265e828DB644A0c242EB` | ERC721 | 10.71% |
| 6 | `0xf142CfA6Ca3DFa4A131f12aACEF4890e390d70D6` | ERC20 | 7.14% |
| 7 | `0x883d646d0C8202Aa23F01d4aF45E4E73804c3a49` | ERC20 | 3.57% |

Addresses in [`tools/airdrop-blacklist.json`](../tools/airdrop-blacklist.json) are removed from every token's supply before shares
are computed, so their balances neither receive an allocation nor dilute anyone else. The list holds pool, router, vault,
exchange and token contracts and burn addresses. There is no minimum allocation and no per-address cap. Amounts are rounded down to
the pool's unit (1e10 wei) and the remainder is handed out one unit at a time by largest fractional remainder, so the list adds up
to the total exactly.

## Snapshot

`snapshot/` (here, `airdrop/v1/snapshot/`) holds one file per token: every holder and its raw balance (ERC721: the count of tokens owned).

- Tokens 2, 3, 5, 6 and 7 were rebuilt from chain data at block 26028062 (2026-09-21 19:47:35 UTC). Each was checked against the
  token's total supply where it has one, and every listed balance was checked against `balanceOf`.
- Tokens 1 and 4 come from the public holder exports, with every balance re-read from the chain (`balanceOf`, latest block) a little
  later that day. Their totals equal the tokens' total supply.
- The holder export for token 2 lagged the chain (the token's balances live in a multi-token contract), so it was not used.

## Rebuild the root

```sh
node tools/airdrop-weights.mjs --snapshot airdrop/v1/snapshot --total 999999 --weights linear --out list.json
cmp list.json airdrop/v1/list.json                                   # same list, byte for byte
node tools/airdrop-tree.mjs --input list.json --unit wei --expect-total 999999000000000000000000 --out-shards proofs
# the printed root must equal the contract's MERKLE_ROOT
cast call 0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8 'MERKLE_ROOT()(bytes32)' --rpc-url $RPC
```

`proofs/` holds the claim proofs, one file per leading address byte: `{ root, claims: { <address>: { index, amount, proof } } }`.
`node tools/airdrop-verify.mjs --contract <address> --address <recipient> --proofs airdrop/v1/proofs` checks one recipient against the
deployed contract without sending a transaction.
