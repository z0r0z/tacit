# SPEC §5.60–§5.63 Amendment — Trustless ETH Bridge (tETH)

> **STATUS: DRAFT.** Adds a trustless Ethereum↔Tacit bridge using a
> Tornado-shape mixer on Ethereum for deposit privacy plus a ZK Bitcoin
> inclusion proof for trustless withdrawal. Introduces four new opcodes:
> `T_BRIDGE_DEPOSIT` (`0x60`), `T_BRIDGE_BURN` (`0x61`),
> `T_BRIDGE_ROTATE` (`0x62`), `T_BRIDGE_NOTE` (`0x63`).
>
> The reference instance is **tETH** — ETH wrapped 1:1 (wei-denominated
> pools at fixed denominations), minted trustlessly by proving a deposit
> into the Ethereum mixer contract, redeemable trustlessly by proving a
> Tacit-side burn to the Ethereum contract via a ZK Bitcoin inclusion
> proof.
>
> **Trust profile:** Groth16 soundness, Poseidon collision resistance,
> secp256k1 discrete-log hardness, Ethereum contract correctness, Bitcoin
> PoW header chain validity. No federation, no oracle, no co-signer, no
> bonded operator.
>
> **Scope of unchanged behavior.** No existing opcode, asset, AMM pool,
> or intent semantics change. This amendment ADDS a fifth custody-kind
> (`"eth_bridge_slot"`) alongside existing kinds; introduces four new
> envelope opcodes; and extends the wrapper registry to handle cross-chain
> state verification. Pre-amendment indexers see new opcodes as unknown
> envelopes (forward-compat per SPEC §4.1).

---

## What tETH is for

tETH is **trustless wrapped ETH on Tacit** — real ETH locked in an
Ethereum mixer contract, minted as a Tacit-native token with full
protocol composability (AMM, orderbook, private sends, farms).

1. **Deposit privacy.** The Ethereum mixer breaks the link between the
   ETH depositor's Ethereum address and their Tacit identity. An
   observer sees ETH enter the mixer but cannot determine which Tacit
   wallet received the corresponding tETH.
2. **Full Tacit composability.** Once minted, tETH is a standard Tacit
   token — AMM pools, confidential transfers (CXFER), orderbook intents,
   farm deposits all work identically to any other Tacit asset.
3. **Trustless exit.** tETH holders can burn their tokens on Tacit and
   recover ETH from the Ethereum contract by proving the Bitcoin-side
   burn via a ZK inclusion proof. No relayer trust, no challenge period,
   no liquidity provider required.

**Naming rationale:** `tETH` — the `t` prefix is established Tacit
convention (TAC, cBTC.tac). "tETH" reads naturally as "Tacit ETH" and
avoids overloading the `z` prefix already used for cBTC.zk privacy
features.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ETHEREUM L1                                  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              TacitETHMixer.sol                                │   │
│  │                                                             │   │
│  │  deposit(commitment) → add leaf to ETH merkle tree          │   │
│  │  withdraw(proof, nullifier, recipient) → release ETH        │   │
│  │                                                             │   │
│  │  State:                                                     │   │
│  │    - deposit_tree: Poseidon merkle tree (L=20)              │   │
│  │    - burn_nullifiers: set of spent tETH nullifiers          │   │
│  │    - btc_headers: Bitcoin header chain (relay)              │   │
│  │    - deposit_nullifiers: set of minted deposit nullifiers   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└──────────────┬──────────────────────────────────────┬───────────────┘
               │ deposit proof                        │ burn inclusion proof
               ▼                                      ▲
┌─────────────────────────────────────────────────────────────────────┐
│                       BITCOIN L1 (TACIT)                             │
│                                                                     │
│  T_BRIDGE_DEPOSIT (0x60):                                          │
│    Groth16 proof of valid deposit in ETH mixer tree                │
│    → mint tETH leaf in Tacit pool                                  │
│                                                                     │
│  T_BRIDGE_BURN (0x61):                                             │
│    Standard mixer withdraw (nullifier + Groth16)                   │
│    → mark leaf spent, emit burn_commitment for ETH recovery        │
│                                                                     │
│  T_BRIDGE_ROTATE (0x62):                                           │
│    Transfer tETH between wallets (same as T_SLOT_ROTATE pattern)   │
│                                                                     │
│  T_BRIDGE_NOTE (0x63):                                             │
│    Encrypted recipient-detection memo (same as T_SLOT_NOTE)        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Cryptographic design

### Shared commitment scheme

Both sides use the same Poseidon-based commitment scheme as the existing
Tacit mixer, enabling circuit reuse:

```
leaf = Poseidon₃(secret, nullifier_preimage, denomination)
nullifier_hash = Poseidon₁(nullifier_preimage)
r_leaf = Poseidon₂(secret, nullifier_preimage)
```

The Ethereum contract implements Poseidon over BN254 (Ethereum precompile-
friendly). The Tacit indexer uses the same Poseidon parameters (already
deployed for cBTC.zk). One circuit, one ceremony, two chains.

### Deposit direction: ETH → tETH

```
User                          Ethereum                      Tacit (Bitcoin)
  │                              │                              │
  │  generate (secret, ν)        │                              │
  │  commitment = Poseidon₃(secret, ν, denom)                  │
  │                              │                              │
  │─── deposit(commitment) ─────▶│                              │
  │    (ETH + commitment)        │                              │
  │                              │── leaf added to tree ──┐     │
  │                              │                        │     │
  │    wait for anonymity set growth (≥10 more deposits)  │     │
  │                              │                        │     │
  │    generate withdraw proof:  │                        │     │
  │    prove leaf ∈ ETH tree     │                        │     │
  │    (same withdraw.circom)    │                        │     │
  │                              │                        │     │
  │─── T_BRIDGE_DEPOSIT ─────────┼────────────────────────┼────▶│
  │    (proof, nullifier_hash,   │                        │     │
  │     eth_root, r_leaf)        │                        │     │── mint tETH
  │                              │                        │     │   (same leaf!)
```

The deposit proof proves (using `withdraw.circom` as-is):
1. The prover knows `(secret, ν)` for a leaf in the Ethereum mixer tree
2. `nullifier_hash = Poseidon₁(ν)` (prevents double-mint)
3. `r_leaf = Poseidon₂(secret, ν)` (Pedersen blinding — also serves as
   the new Tacit note's blinding scalar)
4. The denomination matches

The Tacit indexer validates:
- `eth_root` is in a recent-roots window (fed by an Ethereum header relay
  or a periodic root attestation committed to Bitcoin)
- The Groth16 proof verifies against `vk_mixer` (the SAME verifying key
  already deployed for mixer withdrawals)
- The deposit nullifier is not in the Tacit-side spent set
- `recipient_commitment = denom·H + r_leaf·G` (standard Pedersen check)

### Withdrawal direction: tETH → ETH (the hard direction)

```
User                          Tacit (Bitcoin)               Ethereum
  │                              │                              │
  │─── T_BRIDGE_BURN ───────────▶│                              │
  │    (mixer withdraw proof,    │── mark nullifier spent       │
  │     burn_commitment)         │── emit burn envelope         │
  │                              │                              │
  │    wait for Bitcoin confirmation (6+ blocks)                │
  │                              │                              │
  │    generate btc_inclusion_proof:                            │
  │    prove T_BRIDGE_BURN tx ∈ Bitcoin block                   │
  │    whose header is in the relayed chain                     │
  │                              │                              │
  │─── withdraw(btc_proof, ─────┼──────────────────────────────▶│
  │     nullifier, recipient)    │                              │── release ETH
  │                              │                              │
```

The withdrawal proof proves:
1. A T_BRIDGE_BURN transaction exists in a Bitcoin block
2. That block's header is part of the chain the Ethereum relay knows
3. The burn envelope contains a valid nullifier + burn_commitment
   binding the withdrawal to a specific ETH recipient
4. The burn_commitment has not been used before on Ethereum

---

## §4.2.y Wrapper convention extension — `eth_bridge_slot`

```jsonc
{
  "tacit_wrapper": {
    "version": 1,
    "underlying": {
      "chain": "ethereum",
      "asset": "native",
      "unit": "wei"
    },
    "peg": { "numerator": 1, "denominator": 1, "kind": "fixed" },
    "custody": {
      "kind": "eth_bridge_slot",
      "denom_wei": "1000000000000000000",
      "eth_mixer_address": "0x...",
      "eth_chain_id": 1,
      "reserve_address": null,
      "btc_header_relay": "embedded",
      "max_supply": null,
      "threshold_k": null,
      "threshold_n": null,
      "escape": null
    },
    "redemption": {
      "fee_bps": 0,
      "min_request_units": 1
    },
    "attestation": null
  }
}
```

### 4.2.y.1 Field semantics under `eth_bridge_slot`

- **`denom_wei`** (string-encoded u256, required): ETH denomination per
  tETH unit. Fixed denominations (like cBTC.zk) for anonymity-set
  uniformity. Canonical pools: 0.01 ETH, 0.1 ETH, 1 ETH, 10 ETH, 100 ETH.

- **`eth_mixer_address`** (20-byte hex, required): address of the
  deployed TacitETHMixer contract on Ethereum. Indexers verify deposit
  proofs against this contract's state.

- **`eth_chain_id`** (u64, required): Ethereum chain ID. 1 = mainnet,
  11155111 = Sepolia.

- **`reserve_address`** MUST be `null`. Reserves are the mixer
  contract's ETH balance (publicly auditable at `eth_mixer_address`).

- **`btc_header_relay`** — `"embedded"` means the Ethereum contract
  maintains its own Bitcoin header chain. Future: `"zk_compressed"`
  for a SNARK-verified header chain.

---

## §5.60 T_BRIDGE_DEPOSIT (`0x60`)

Trustless cross-chain mint. A Bitcoin transaction carrying this envelope
mints tETH on Tacit by proving a valid deposit exists in the Ethereum
mixer contract.

### 5.60.1 Wire format

```
T_BRIDGE_DEPOSIT
   opcode              1 byte   (0x60)
   network_tag         1 byte   (0x00=mainnet, 0x01=signet)
   asset_id            32 bytes (tETH wrapper asset's CETCH-derived asset_id)
   denom_wei           32 bytes (u256 big-endian; MUST match metadata.custody.denom_wei.
                                 Byte order matches Solidity's native uint256 encoding
                                 and the Ethereum ABI convention. NOTE: the existing
                                 T_WITHDRAW uses an 8-byte LE denomination for historical
                                 reasons; bridge envelopes use 32-byte BE for direct
                                 compatibility with the Ethereum contract's storage.)
   eth_root            32 bytes (Ethereum mixer tree root proven against)
   nullifier_hash      32 bytes (Poseidon₁(ν); marks deposit as claimed)
   recipient_commit    33 bytes (Tacit mixer Pedersen commitment: denom·H + r_leaf·G)
   leaf_hash           32 bytes (Poseidon₃(secret, ν, denom) — same as ETH deposit)
   r_leaf              32 bytes (Poseidon₂(secret, ν); Pedersen blinding scalar)
   bind_hash           32 bytes (SHA256 binding per §5.60.3)
   proof_length        2 bytes  (u16 LE)
   deposit_proof       VAR bytes (Groth16 proof via vk_mixer)
```

Total fixed header: **261 bytes** + variable proof.

### 5.60.2 Circuit reuse — `withdraw.circom` without modification

**No new circuit. No new ceremony.** T_BRIDGE_DEPOSIT reuses
`withdraw.circom` (the existing mixer withdrawal circuit) directly.
The deposit proof is structurally identical to a mixer withdraw: the
user proves membership in a tree and reveals a nullifier. The only
difference is semantic — the tree root is the Ethereum mixer's root
instead of a Tacit pool root.

Public inputs (same 5 signals as T_WITHDRAW):
- `root` — the Ethereum mixer tree root (`eth_root`)
- `nullifier_hash` — `Poseidon₁(ν)`; prevents double-mint on Tacit
- `denomination` — pool denomination
- `r_leaf` — `Poseidon₂(secret, ν)`; Pedersen blinding scalar
- `bind_hash` — ties proof to this specific mint request

Private witness (same as T_WITHDRAW):
- `secret` — depositor's random Fr
- `nullifier_preimage` — depositor's random Fr
- `path_elements[20]` — Ethereum tree merkle siblings
- `path_indices[20]` — left/right bits

**Why r_leaf publication doesn't break privacy:** An observer sees
`r_leaf` on Bitcoin and knows the Ethereum deposit commitments. To
link them, they'd need to find `(secret, ν)` such that both
`Poseidon₃(secret, ν, denom) = commitment` AND `Poseidon₂(secret, ν)
= r_leaf`. This is a Poseidon preimage search — computationally
infeasible.

**Same (secret, ν) for both chains.** The user SHOULD use the same
`(secret, ν)` pair for their Ethereum deposit and their Tacit note.
This means:
- Ethereum leaf = Tacit leaf = `Poseidon₃(secret, ν, denom)`
- The published `r_leaf` becomes the Pedersen blinding for the new
  Tacit note's `recipient_commitment = denom·H + r_leaf·G`
- One secret pair, one ceremony, one circuit, two chains

The existing mixer ceremony's verifying key (`vk_mixer`) validates
both T_WITHDRAW proofs and T_BRIDGE_DEPOSIT proofs. The indexer
distinguishes them by opcode and validates `root` against different
sources (local pool root vs. Ethereum state root).

### 5.60.3 Bind hash computation

```
bind_hash = SHA256(
    "tacit-bridge-deposit-v1"
    || network_tag(1)
    || asset_id(32)
    || denom_wei(32)
    || eth_root(32)
    || nullifier_hash(32)
    || recipient_commit(33)
    || leaf_hash(32)
    || r_leaf(32)
)
```

### 5.60.4 Ethereum state verification

The indexer MUST verify `eth_root` is a valid recent root of the
Ethereum mixer contract. Two verification modes:

**Mode A: Ethereum header relay on Tacit worker.**
The worker maintains an Ethereum light-client state:
- Accepts Ethereum block headers (PoS finality gadget or PoW ommer check)
- Stores recent finalized state roots
- The dApp queries the mixer contract's storage slot for the current
  merkle root and provides a Merkle-Patricia proof against a finalized
  Ethereum state root

**Mode B: Periodic root attestation (bootstrap mode).**
A bonded attestor posts `eth_root` snapshots to Tacit at regular
intervals (every ~32 Ethereum slots / 6.4 minutes). The bond is slashable
if a fraud proof demonstrates the posted root doesn't match the actual
contract state. This is a training-wheels mechanism for initial launch;
Mode A is the long-term target.

### 5.60.5 Validator algorithm

```
on T_BRIDGE_DEPOSIT:
  require envelope.network_tag matches local network
  require asset_id is registered as eth_bridge_slot wrapper
  require envelope.denom_wei == metadata.custody.denom_wei

  // Ethereum root freshness
  require envelope.eth_root ∈ recent_eth_roots window

  // Double-mint prevention
  require envelope.nullifier_hash ∉ deposit_nullifiers_set(asset_id)

  // Pedersen check (secp256k1) — same as T_WITHDRAW / T_SLOT_BURN
  expected_commit = denomination · H + r_leaf · G_secp256k1
  require expected_commit == envelope.recipient_commit

  // Bind hash
  recompute bind_hash per §5.60.3
  require envelope.bind_hash == recomputed bind_hash

  // Groth16 verification — SAME vk_mixer as T_WITHDRAW
  require snarkjs.groth16.verify(
    vk_mixer,
    [eth_root, nullifier_hash, denomination, r_leaf, bind_hash],
    envelope.deposit_proof
  )

  // Leaf — same as ETH deposit commitment (same secret pair)
  require envelope.leaf_hash is a valid BN254 field element

  if all checks pass:
    insert nullifier_hash into deposit_nullifiers_set(asset_id)
    append envelope.leaf_hash to mixer pool for (asset_id, denomination)
    supply(asset_id) += 1
    accept envelope
```

### 5.60.6 Privacy at deposit time

An on-chain observer (Bitcoin side) sees:
- A T_BRIDGE_DEPOSIT envelope referencing `eth_root` and `deposit_nullifier`
- The new `recipient_commit` and `leaf_hash` added to the Tacit pool

They CANNOT determine:
- Which Ethereum deposit corresponds to this mint (mixer anonymity set)
- The depositor's Ethereum address
- Any link between the Ethereum-side identity and the Tacit-side identity

The Ethereum mixer provides k-anonymity where k = number of deposits at
that denomination before this withdrawal. Standard Tornado-shape privacy
guarantees apply.

---

## §5.61 T_BRIDGE_BURN (`0x61`)

Trustless cross-chain redemption (Tacit side). Burns a tETH leaf on
Tacit and commits to an Ethereum withdrawal recipient. The burn
envelope on Bitcoin becomes the proof artifact the user later presents
to the Ethereum contract.

### 5.61.1 Wire format

```
T_BRIDGE_BURN
   opcode              1 byte   (0x61)
   network_tag         1 byte
   asset_id            32 bytes
   denom_wei           32 bytes
   merkle_root         32 bytes (Tacit pool root, BN254)
   nullifier_hash      32 bytes (Poseidon₁(ν_tacit); marks tETH leaf spent)
   recipient_commit    33 bytes (same leaf Pedersen commitment)
   r_leaf              32 bytes (BN254 / secp256k1 scalar)
   eth_recipient       20 bytes (Ethereum address to receive ETH)
   burn_nonce          32 bytes (random; prevents replay on Ethereum side)
   bind_hash           32 bytes (per §5.61.3)
   proof_length        2 bytes  (u16 LE)
   groth16_proof       VAR bytes (mixer withdraw proof)
```

Total fixed header: **281 bytes** + variable proof.

### 5.61.2 Circuit

Reuses `withdraw.circom` without modification — identical to T_WITHDRAW
or T_SLOT_BURN. The circuit proves the user knows `(secret, ν)` for a
leaf in the tETH pool and publishes the nullifier.

Public inputs: `[merkle_root, nullifier_hash, denomination, r_leaf, bind_hash]`

### 5.61.3 Bind hash computation

```
bind_hash = SHA256(
    "tacit-bridge-burn-v1"
    || network_tag(1)
    || asset_id(32)
    || denom_wei(32)
    || merkle_root(32)
    || nullifier_hash(32)
    || recipient_commit(33)
    || r_leaf(32)
    || eth_recipient(20)
    || burn_nonce(32)
)
```

The `eth_recipient` and `burn_nonce` are bound into the proof via
`bind_hash`, so a relayer cannot substitute the ETH recipient address
on a captured proof. This is critical: without it, a mempool observer
could front-run the Ethereum withdrawal by submitting their own address.

### 5.61.4 Validator algorithm

```
on T_BRIDGE_BURN:
  require envelope.network_tag matches local network
  require asset_id is registered as eth_bridge_slot wrapper
  require envelope.denom_wei == metadata.custody.denom_wei

  // Standard mixer-withdraw checks
  require envelope.merkle_root ∈ recent-roots window for (asset_id, denom)
  require envelope.nullifier_hash ∉ spent-set for (asset_id, denom)

  // Pedersen check
  expected_commit = denomination · H + r_leaf · G_secp256k1
  require expected_commit == envelope.recipient_commit

  // Bind hash
  recompute bind_hash per §5.61.3
  require envelope.bind_hash == recomputed bind_hash

  // Groth16 verification
  require snarkjs.groth16.verify(
    vk_mixer,
    [merkle_root, nullifier_hash, denomination, r_leaf, bind_hash],
    envelope.groth16_proof
  )

  // eth_recipient well-formedness
  require envelope.eth_recipient is 20 bytes, nonzero

  if all checks pass:
    insert nullifier_hash into spent-set for (asset_id, denom)
    supply(asset_id) -= 1
    emit burn_record {
      nullifier_hash,
      eth_recipient,
      denom_wei,
      burn_nonce,
      burn_txid: this_tx.txid,
      burn_block_height: this_block.height
    }
    accept envelope
```

### 5.61.5 Ethereum-side withdrawal

After T_BRIDGE_BURN confirms on Bitcoin (6+ blocks recommended), the
user constructs a withdrawal transaction on Ethereum:

```solidity
function withdrawFromBurn(
    bytes32 burnTxid,
    bytes32 burnBlockHash,
    uint256 burnBlockHeight,
    bytes calldata bitcoinMerkleProof,  // tx inclusion in block
    bytes calldata headerChainProof,    // block in relayed chain
    bytes32 nullifierHash,
    address ethRecipient,
    bytes32 burnNonce,
    uint256 denomination
) external
```

The Ethereum contract verifies:
1. `burnBlockHash` is in the relayed Bitcoin header chain
2. `burnTxid` is included in the block via the Bitcoin merkle proof
3. The envelope at `burnTxid` contains a valid T_BRIDGE_BURN with
   matching `nullifierHash`, `ethRecipient`, `denomination`, `burnNonce`
4. `nullifierHash` has not been withdrawn before on Ethereum
5. Contract has sufficient ETH balance

If all checks pass: transfer `denomination` wei to `ethRecipient`, mark
`nullifierHash` as withdrawn.

### 5.61.6 Bitcoin header relay on Ethereum

The contract maintains a Bitcoin header chain:

```solidity
struct BitcoinHeader {
    bytes32 prevBlock;
    bytes32 merkleRoot;
    uint32 timestamp;
    uint32 bits;     // difficulty target
    uint32 nonce;
    uint256 chainWork;
}

mapping(bytes32 => BitcoinHeader) public headers;
bytes32 public tip;
uint256 public tipChainWork;
```

Anyone can submit Bitcoin headers. The contract:
- Verifies PoW (double-SHA256 ≤ target)
- Follows the heaviest chain (most cumulative work)
- Requires N confirmations before a block is considered finalized
  (configurable; 6 recommended for amounts < 100 ETH, higher for larger)

Gas cost: ~60k gas per header submission. At 1 block/10min, daily relay
cost ≈ 144 headers × 60k gas ≈ 8.6M gas/day (≈ $5-15/day at typical
gas prices). Relay incentive: anyone can relay; MEV searchers, the tETH
dApp, or altruistic relayers.

### 5.61.7 ZK-compressed header relay (future optimization)

For reduced on-chain cost, a ZK proof can compress N Bitcoin headers
into a single SNARK:

- Prove: "I know headers H₁...Hₙ where each Hᵢ.prevBlock = hash(Hᵢ₋₁),
  each satisfies its PoW target, and cumulative work = W"
- On-chain: verify one Groth16/PLONK proof, update tip + chainWork
- Amortizes relay cost across many blocks

This is an optimization for post-launch; the naive relay is sufficient
for launch.

---

## §5.62 T_BRIDGE_ROTATE (`0x62`)

Transfer tETH between Tacit wallets. Structurally identical to
T_SLOT_ROTATE (§5.23) but for tETH leaves. Consumes one nullifier,
appends a fresh leaf — standard mixer rotate.

### 5.62.1 Wire format

```
T_BRIDGE_ROTATE
   opcode              1 byte   (0x62)
   network_tag         1 byte
   asset_id            32 bytes
   denom_wei           32 bytes

   // --- old leaf burn leg ---
   merkle_root         32 bytes
   nullifier_hash      32 bytes
   old_recipient_commit 33 bytes
   r_leaf_old          32 bytes
   bind_hash_old       32 bytes
   proof_length_old    2 bytes
   groth16_proof_old   VAR bytes

   // --- new leaf mint leg ---
   new_recipient_commit 33 bytes
   new_leaf_hash       32 bytes

   // --- sender signature ---
   sender_pubkey       33 bytes
   sender_sig          64 bytes (BIP-340 over rotate_msg)
```

### 5.62.2 Validator algorithm

Combines the T_BRIDGE_BURN validation (for old leaf) with fresh leaf
insertion (for new leaf). The sender_sig binds both legs atomically.

---

## §5.63 T_BRIDGE_NOTE (`0x63`)

Encrypted recipient-detection memo for tETH transfers. Identical pattern
to T_SLOT_NOTE (§5.26): ECDH + AES-256-GCM encrypted payload containing
`(secret, ν)` so the recipient can detect and spend their note without
out-of-band communication.

---

## Ethereum contract: TacitETHMixer.sol

### Interface

```solidity
interface ITacitETHMixer {
    // === Deposit (ETH → tETH direction) ===
    function deposit(bytes32 commitment) external payable;

    // === Withdrawal (tETH → ETH direction) ===
    function withdrawFromBurn(
        bytes32 burnTxid,
        bytes32 burnBlockHash,
        uint256 burnBlockHeight,
        bytes calldata txInclusionProof,
        bytes32 nullifierHash,
        address payable ethRecipient,
        bytes32 burnNonce,
        uint256 denomination
    ) external;

    // === Bitcoin header relay ===
    function submitHeaders(bytes[] calldata rawHeaders) external;

    // === View functions ===
    function getDepositRoot() external view returns (bytes32);
    function isDepositNullifierSpent(bytes32) external view returns (bool);
    function isBurnNullifierSpent(bytes32) external view returns (bool);
    function getBitcoinTip() external view returns (bytes32 hash, uint256 height);
    function isHeaderFinalized(bytes32 blockHash) external view returns (bool);
}
```

### Deposit tree

- Same Poseidon₃ leaf commitment as Tacit: `leaf = Poseidon₃(secret, ν, denomination)`
- Tree depth: 20 (matches Tacit pool depth — 1,048,576 leaves max)
- Poseidon implemented over BN254 scalar field using EVM precompile
  (EIP-196/197) for pairing checks, or a gas-optimized Solidity/Yul
  implementation

### Decimal scaling

ETH uses 18 decimals (wei). Tacit amounts are `u64`, which overflows
above ~18.4e18 at 18 decimals. tETH therefore uses **8 decimals** on
Tacit (same as BTC/satoshis), with a scaling factor of `1e10`:

```
1 tETH base unit = 1e10 wei = 10 gwei
```

The Ethereum contract stores and transacts in wei (18 decimals).
The Tacit pool stores denominations in tETH base units (8 decimals).
Conversion at the bridge boundary:
- **Deposit**: contract accepts `msg.value` in wei; Tacit denomination =
  `msg.value / 1e10`
- **Withdrawal**: Tacit denomination × `1e10` = wei sent to recipient

All fixed pool denominations are cleanly divisible by `1e10`:

| Pool | Ethereum (wei) | Tacit (8-dec base units) | Human |
|------|----------------|--------------------------|-------|
| A | 1e16 | 1e6 (1,000,000) | 0.01 ETH |
| B | 1e17 | 1e7 (10,000,000) | 0.1 ETH |
| C | 1e18 | 1e8 (100,000,000) | 1 ETH |
| D | 1e19 | 1e9 (1,000,000,000) | 10 ETH |
| E | 1e20 | 1e10 (10,000,000,000) | 100 ETH |

All Tacit-side values fit comfortably in `u64` (max ~1.84e19). Each
denomination is a separate deposit tree + separate Tacit pool. Anonymity
set grows independently per denomination.

### Security properties

1. **Deposit soundness.** ETH is locked in the contract; only a valid
   T_BRIDGE_BURN on Bitcoin + header-relayed inclusion proof can
   release it.
2. **No double-mint.** Deposit nullifiers are tracked on Tacit side;
   each ETH deposit can only mint one tETH.
3. **No double-withdraw.** Burn nullifiers are tracked on Ethereum side;
   each tETH burn can only release ETH once.
4. **Recipient binding.** `eth_recipient` is bound into the burn's
   `bind_hash` via the Groth16 proof, preventing front-running.
5. **Header chain security.** Bitcoin PoW makes header forgery
   computationally infeasible. Confirmation depth gates withdrawal
   finality.

---

## Ethereum wallet association

Tacit wallets already support derivation from Ethereum private keys (via
the existing secp256k1 key reuse path). For tETH UX:

- User connects their Ethereum wallet (MetaMask, etc.)
- Same secp256k1 keypair derives both their Ethereum address AND their
  Tacit wallet's blinded pubkey
- Deposit on Ethereum + mint on Tacit happens from the same key context
- For burn: user signs the T_BRIDGE_BURN on Bitcoin using their Tacit
  wallet, then submits the withdrawal on Ethereum using the same key

This means a single key manages the full lifecycle: deposit ETH →
receive tETH → trade/transfer/AMM → burn tETH → recover ETH.

---

## Circuit requirements summary

| Circuit | New? | Constraints | Ceremony |
|---------|------|-------------|----------|
| `withdraw.circom` (deposit + burn) | NO | 5,644 | Existing mixer ceremony — **reused as-is** |
| `btc_inclusion.circom` (future) | YES | ~500k–1M (optional ZK header compression) | Requires `pot20` or PLONK |

**No new circuit, no new ceremony.** Both T_BRIDGE_DEPOSIT and
T_BRIDGE_BURN use `withdraw.circom` and the existing mixer verifying
key. The bridge adds zero ZK infrastructure — it reuses what's already
deployed and ceremony-finalized.

---

## Privacy analysis

### Deposit privacy (ETH → tETH)

| Observer | Learns | Does NOT learn |
|----------|--------|----------------|
| Ethereum chain watcher | Someone deposited X ETH | Who minted tETH |
| Bitcoin chain watcher | A T_BRIDGE_DEPOSIT referencing an eth_root | Which ETH deposit funded it |
| Cross-chain correlator | Timing correlation (deposit→mint gap) | Direct cryptographic link |

**Mitigation for timing correlation:** Users SHOULD wait a random delay
between ETH deposit and tETH mint. The dApp SHOULD suggest or enforce a
minimum delay (e.g., wait for ≥10 additional deposits at same denomination
before minting).

### Transfer privacy (tETH on Tacit)

Standard Tacit mixer privacy: k-anonymity within the pool's unspent
leaf set. Confidential amounts via CXFER for non-pool transfers.

### Withdrawal privacy (tETH → ETH)

| Observer | Learns | Does NOT learn |
|----------|--------|----------------|
| Bitcoin watcher | A T_BRIDGE_BURN happened, sees eth_recipient | Which tETH leaf was burned (mixer privacy) |
| Ethereum watcher | ETH released to eth_recipient from burn proof | Link to original depositor |
| Cross-chain correlator | burn→withdrawal timing | Which original deposit funded this withdrawal |

The full chain: Deposit (Ethereum mixer) → Mint (Tacit) → N transfers
(Tacit mixer) → Burn (Tacit mixer) → Withdraw (Ethereum). At minimum
two layers of mixer privacy (ETH deposit mixer + Tacit pool mixer).

---

## Deployment sequence

### Phase 1: Deposit direction (ETH → tETH)

1. Deploy `TacitETHMixer.sol` on Ethereum (deposit + tree management)
2. Verify `withdraw.circom` ceremony output covers deposit proofs (no new circuit or ceremony needed — see §5.60.2)
3. Deploy T_BRIDGE_DEPOSIT (0x60) indexer rule
4. CETCH the tETH asset with `eth_bridge_slot` metadata
5. Users can deposit ETH → mint tETH → use on Tacit

Withdrawal at this phase: bonded relayer (Mode B from §5.60.4) submits
Tacit pool roots to Ethereum. Slashable if incorrect. Fast-exit via
atomic swap with LP (HTLC) as alternative for users who don't want to
wait for relay confirmation.

### Phase 2: Trustless withdrawal (tETH → ETH)

6. Deploy Bitcoin header relay in `TacitETHMixer.sol`
7. Deploy `withdrawFromBurn` function
8. Header relayers begin submitting Bitcoin blocks
9. Users can burn tETH → prove on Ethereum → recover ETH trustlessly

### Phase 3: ZK-compressed relay (gas optimization)

10. Compile `btc_header_chain.circom` (or use PLONK for larger circuits)
11. Batched header proofs reduce relay cost by ~100×
12. Optional: recursive proofs for unbounded header chain length

---

## Comparison with existing bridges

| Property | tBTC v2 | wBTC | tETH (this amendment) |
|----------|---------|------|----------------------|
| Custody | Threshold network (9-of-15) | BitGo custodian | Self-custody (contract + PoW relay) |
| Trust | Honest majority among signers | Single custodian | Math (ZK + PoW + contract correctness) |
| Deposit privacy | None | None (KYC) | Tornado-shape mixer (k-anonymity) |
| Exit privacy | None | None | Mixer on both sides |
| Exit delay | ~hours (signing rounds) | Business days | ~1 hour (6 Bitcoin confirmations) |
| Collateral | $ETH staked by signers | Custodian reputation | None (fully collateralized in contract) |
| Composability target | Ethereum DeFi | Ethereum DeFi | Tacit DeFi (AMM, orderbook, farms) |

---

## Open questions / future extensions

1. **Multi-asset generalization.** The same architecture works for any
   ERC-20 token (not just native ETH). The mixer contract accepts
   `token.transferFrom()` instead of `msg.value`. tUSDC, tDAI, etc.
   become trivial extensions.

2. **Reverse bridge (BTC → Ethereum via Tacit).** Users could deposit
   BTC into a cBTC.zk slot, rotate it to a bridge-aware pool, and exit
   to Ethereum as wrapped BTC. Requires an additional Ethereum contract
   for BTC-denominated withdrawals.

3. **Privacy-preserving withdrawal.** The current design reveals
   `eth_recipient` in the T_BRIDGE_BURN envelope (necessary for the
   Ethereum contract to know where to send ETH). A steganographic
   extension could encrypt `eth_recipient` to the contract's key and
   decrypt in a ZK-friendly way, but this adds significant complexity.

4. **Confirmation depth parameterization.** Different denominations may
   warrant different confirmation depths. 0.1 ETH pool might accept 3
   confirmations; 100 ETH pool might require 12+.
