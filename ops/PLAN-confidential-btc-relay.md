# PLAN — Bitcoin-root relay (bridge_mint trust root)

`bridge_mint` (BTC → ETH) lets a confidential note burned on Bitcoin be minted on
Ethereum. The Ethereum guest verifies the burn cryptographically — Bitcoin header
PoW, tx-in-block, the `0x2B` envelope, the burned note's **membership against a
Bitcoin pool root**, value conservation. But "is this pool root the *real,
confirmed* Bitcoin confidential-pool root?" cannot be decided inside the mint
proof alone. The **relay** answers that: it attests canonical, confirmed Bitcoin
pool roots to `ConfidentialPool.attestBitcoinRoot`, and a mint only settles
against an attested root (`knownBitcoinRoot`). This is the inflation-critical
gate — without it, a note proven in a *fabricated* tree could be minted.

It mirrors the live tETH `SP1PoolRootVerifier`, which relays Bitcoin pool state
onto Ethereum for the bridge today.

## Contract surface (shipped)

`ConfidentialPool` (commit `ca17110`):
- `address immutable BITCOIN_ROOT_ORACLE` — the only caller allowed to attest.
  `address(0)` ⇒ bridge_mint disabled (a pool with no cross-chain mint).
- `attestBitcoinRoot(bytes32 root) onlyOracle` → sets `knownBitcoinRoot[root]`,
  emits `BitcoinRootAttested`.
- `settle` rejects any bridge_mint whose `bitcoinRootsUsed` contains an
  un-attested root (`UnknownBitcoinRoot`).

So the relay is whatever address holds `BITCOIN_ROOT_ORACLE`; the trust model is
*who/what that address is*.

## Two models

### Pilot — trusted operator (ship first)
The operator runs the Bitcoin indexer (the same off-chain validator that already
enforces Bitcoin Tacit validity), computes the confidential-pool root once it is
buried ≥ K confirmations, and sends `attestBitcoinRoot`. `BITCOIN_ROOT_ORACLE` is
the operator's key. Trust: the operator attests honest, confirmed roots — the same
trust class as the rest of the gated pilot (AMM worker, tETH relay operator).

`dapp/confidential-btc-relay.js` is the operator toolkit:
- `computeRoot(leaves)` — the canonical root via the **same keccak incremental
  Merkle** the pool and guest use, so the attested root is exactly the one a mint
  proves membership against (locked in `tests/confidential-btc-relay.mjs` against
  the real bridge_mint witness).
- `attestCalldata(root)` / `buildAttestTx(operatorPriv, pool, root, fees)` — builds
  the signed EIP-1559 `attestBitcoinRoot` tx from a **Tacit seed** (reusing the
  in-wallet EVM signer; no MetaMask). The operator EVM account is derived from the
  same seed as everything else.

### Trustless — SP1-proven root (follow-up)
Replace the operator's say-so with a proof: an SP1 guest verifies the Bitcoin
confidential-pool root from confirmed Bitcoin headers + the note set (the tETH
`SP1PoolRootVerifier` shape, reusing `cxfer-core::bitcoin`), and an oracle contract
calls `attestBitcoinRoot` only on a valid proof. Same calldata, same gate — only
the oracle changes from an EOA to a verifier contract. This removes the operator
from the trust path entirely.

## Confirmation discipline + the reorg residual

The relay must only attest roots that are **buried ≥ K confirmations** — that is
where burn-block canonicality is enforced. The mint guest itself checks the burn
block's PoW but not its linkage to the canonical tip; a privately-mined or
deep-reorged burn block is the documented residual (accept-and-document, the same
posture as tETH `LOCK-1` and the AMM). Full in-proof closure = a header-chain-to-
relay-tip check in the mint guest (the tETH multi-header pattern), a later
hardening. The pilot relay's confirmation discipline bounds it operationally.

## Data flow (pilot)

1. A user burns a confidential note on Bitcoin with a `0x2B` envelope committing
   `(asset, btc_pool_root, ν, dest_commitment)`.
2. The indexer sees the burn; after K confirmations it (re)computes the Bitcoin
   confidential-pool root and the operator `attestBitcoinRoot(root)`s it on Ethereum.
3. The user (or a settler) proves `bridge_mint` against that root and `settle`s it;
   the Ethereum note is minted, the claim is gated once (`bridgeMinted`).

## Migration

Pilot → trustless is an oracle swap with no note/format change: deploy the
SP1-proven verifier, point a new `ConfidentialPool` (or a governance-set oracle, if
later made mutable) at it. The calldata, the `knownBitcoinRoot` gate, and the mint
guest are unchanged.
