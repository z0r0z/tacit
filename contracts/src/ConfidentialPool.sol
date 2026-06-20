// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

/// Canonical ERC20 the pool mints/burns for a Tacit-recorded asset (the pool is its
/// mint authority). `CanonicalBridgedERC20` implements this.
interface IMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function MINTER() external view returns (address);
}

/// The canonical-ERC20 factory (CREATE2, address = f(assetId)). Lets the pool lazily
/// deploy a Tacit asset's public ERC20 on first registration. `CanonicalAssetFactory`
/// implements this.
interface ICanonicalAssetFactory {
    /// The DEPLOYED canonical token for these params, or address(0) if not yet deployed — a stored
    /// mapping, NOT a CREATE2 prediction, so the pool deploys exactly when this returns address(0).
    function tokenOf(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        view
        returns (address);
    function deployCanonical(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        returns (address token);
}

/// Minimal ERC20 metadata read for deriving the Tacit-side scale of an external token.
interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

/// A canonical bridged ERC20 commits to its asset id at deploy. A cross-chain asset's
/// registry link is accepted only when the token's committed ASSET_ID matches the link,
/// so an unrelated token cannot claim a shared id (CanonicalBridgedERC20 implements this).
interface IAssetId {
    function ASSET_ID() external view returns (bytes32);
}

/// Bitcoin light-relay surface used to anchor reflection proofs to canonical Bitcoin (the same
/// BitcoinLightRelay the tETH bridge / SP1PoolRootVerifier use). `tip()` = the relay's canonical
/// best block hash; `blockParent(h)` = h's stored parent (for the sub-finality-window reorg walk).
interface IRelay {
    function tip() external view returns (bytes32);
    function blockParent(bytes32 blockHash) external view returns (bytes32);
}

/// One collateral basket leg (asset, public value) — mirrors the settle guest's CdpLeg + CollateralEngine.
/// File-level so both the CDP-controller interface and the pool's PublicValues share the exact tuple shape.
struct CdpLeg {
    bytes32 asset;
    uint256 value;
}

/// A mutable CDP controller (e.g. CollateralEngine) the pool calls during settle to apply ALL pricing/ratio
/// policy for its own controller-derived debt asset. The pool proves structure + conservation; the controller
/// reverts to DENY a mint / a liquidation. See ops/DESIGN-confidential-defi-v1.md §4.
interface ICdpController {
    function onCdpMint(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionLeaf) external;
    function onCdpClose(uint256 debtValue, CdpLeg[] calldata legs, bytes32 positionNullifier) external;
    function onCdpLiquidate(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionNullifier) external;
    function onCdpTopup(
        CdpLeg[] calldata oldLegs,
        CdpLeg[] calldata newLegs,
        uint256 debtValue,
        bytes32 oldPositionNullifier,
        bytes32 newPositionLeaf
    ) external;
}

/// The cBTC native-ETH escrow gate (CollateralEngine): the pool reads it before minting cBTC against a
/// reflection-recorded self-custody lock. The engine NEVER mints/moves backing — it only sizes the escrow.
interface ICollateralEngine {
    function escrowSufficient(bytes32 outpoint, uint256 vBtc) external view returns (bool);
}

/// @title ConfidentialPool
/// @notice Phase-1 confidential token: a multi-asset shielded pool on Ethereum
///         with arbitrary hidden amounts on secp256k1 notes (C = v·H + r·G), the
///         same note object as the Bitcoin layer. Per-op validity proofs are
///         verified by SP1 (the guest does all secp work — membership against the
///         on-chain root, Bulletproofs+ ranges, per-asset conservation, deposit
///         openings); this contract maintains the note-commitment tree (Keccak
///         incremental Merkle), the nullifier set, per-asset escrow, and pays the
///         public boundary effects (withdrawals + settler fees).
///
///  Shape: Railgun / Tornado-Nova, but with an SP1 proof instead of a bespoke
///  Groth16 circuit, so there is no new trusted setup (SP1's verifier is
///  universal; the program is pinned by PROGRAM_VKEY). Batch size is the only
///  dial — Phase 2 moves the tree + nullifier set in-guest and batches many ops
///  per proof; the contract surface here is the batch-size-1 form.
///
///  Forward-compat for the cross-chain generation (PLAN-confidential-cross-chain):
///  nullifiers are chain-independent (note-bound: keccak(Cx‖Cy‖"spent") — a function of
///  the commitment, not a free secret (spec B3); the proof, not the nullifier, carries the
///  chain binding), leaf hashing matches the
///  Bitcoin note scheme, the asset registry carries a cross-chain link, and the
///  public-values layout is versioned so the cross-chain tail is an append.
contract ConfidentialPool is ReentrancyGuardTransient {
    // ──────────────────── Constants ────────────────────

    uint256 internal constant TREE_LEVELS = 32;
    uint256 internal constant MAX_LEAVES = 1 << TREE_LEVELS;

    /// Decimals every Tacit-native asset is presented at on Ethereum (the ERC20
    /// convention). A Tacit asset's native precision (≤ 8, Bitcoin's limit) is harmonized
    /// up to this; `unitScale = 10^(ETH_DECIMALS − tacitDecimals)` does the amount scaling.
    uint8 internal constant ETH_DECIMALS = 18;
    uint16 internal constant PV_VERSION = 1;
    /// Cap on a confidential AMM pool's fee (basis points). createPair is permissionless + one-per-slot,
    /// so bounding the fee stops a front-runner from seeding the only slot with an unusable 100% fee.
    uint32 internal constant MAX_POOL_FEE_BPS = 1000; // 10%
    /// V2-style minimum liquidity: this many of a pool's seed shares are permanently locked by the first
    /// OP_LP_ADD — no note holds them — so a fully-exited pool keeps a live share/reserve floor and the
    /// one-per-(pair,fee) slot can never be emptied to a bricked, un-rejoinable state. The founder's own
    /// position is the REMAINDER (seed shares − this), recorded as a claimable LP-share note — so a
    /// founder recovers their seed rather than donating all of it (only this standard lock is donated).
    /// Enforced on-chain by the settle LP loop (sharesPost can never drop below this).
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;

    // ──────────────────── Immutables ────────────────────

    ISP1Verifier internal immutable SP1_VERIFIER;
    bytes32 internal immutable PROGRAM_VKEY;
    /// keccak(chainid, address(this)) — the guest stamps this into the public
    /// values, so a proof is bound to this deployment and cannot be replayed.
    bytes32 internal immutable CHAIN_BINDING;
    /// vkey of the Bitcoin-state relay prover. Bitcoin confidential-pool state (the note
    /// tree root + the spent-nullifier root) is attested ONLY by an SP1 proof against this
    /// vkey — re-derived from relayed Bitcoin headers (the SP1PoolRootVerifier pattern).
    /// No trusted oracle: the proof is the sole authority.
    bytes32 internal immutable BITCOIN_RELAY_VKEY;
    /// Bitcoin light relay used to anchor each reflection proof's header chain to canonical
    /// Bitcoin (mirrors SP1PoolRootVerifier). 0 ⇒ reflection inactive (the ctor bars a non-zero
    /// BITCOIN_RELAY_VKEY without a relay). When set, attest pins the proof's tip to a MATURED
    /// ancestor of RELAY.tip() (RELAY.tip() walked back REFLECTION_CONFIRMATIONS, then within
    /// REFLECTION_FINALITY_WINDOW) and its prev to the prior attested tip — which forces the whole
    /// proven chain to be canonical Bitcoin AND buries every folded effect that many confirmations.
    IRelay internal immutable HEADER_RELAY;
    /// Max ancestor distance accepted for the reflection prev/tip anchor (sub-window reorg tolerance).
    uint256 internal constant REFLECTION_FINALITY_WINDOW = 6;
    /// Maturity depth for a reflected batch: its tip must be buried at least this many blocks below the
    /// canonical relay tip, so every effect it folds — above all a bridge-burn that authorizes a
    /// bridge_mint — carries that many Bitcoin confirmations. Without it a burn at ~1 confirmation could
    /// authorize a mint, and a shallow tip reorg would then strand it (the burned note re-lives on
    /// Bitcoin while the Ethereum mint stands = value duplication). The on-chain analog of the mixer's
    /// CONFIRMATION_DEPTH — set per deployment (a faster test chain may pick fewer than mainnet's 6).
    uint256 internal immutable REFLECTION_CONFIRMATIONS;
    /// Upper bound on REFLECTION_CONFIRMATIONS: the anchor walks it (+ the window) in storage per attest,
    /// so an unbounded value would make attest exceed the block gas limit and brick reflection. 144 ≈ a
    /// day of Bitcoin blocks — far above any sane confirmation depth.
    uint256 internal constant MAX_REFLECTION_CONFIRMATIONS = 144;
    /// The Bitcoin block hash at the tip of the last attested reflection batch (the next batch's
    /// prev must equal this or a recent ancestor). Seeded to the genesis anchor in the ctor.
    bytes32 internal lastReflectionBlockHash;
    /// Monotonic guard: the highest Bitcoin height a relay proof has attested. A proof
    /// must not decrease it (equal heights are valid — a batch may fold several effects from one
    /// block), so a stale proof cannot roll the spent root backward.
    uint64 internal lastRelayHeight;
    /// Factory used to lazily deploy a Tacit asset's canonical ERC20 on first bridge_mint,
    /// with the guest-proven metadata (OP_ATTEST_META). 0 = auto-register disabled.
    ICanonicalAssetFactory internal immutable CANONICAL_FACTORY;
    /// Canonical Bitcoin-side asset id bound to NATIVE ETH (tETH = shielded ETH) for this generation,
    /// pinned at construction. Native ETH has no token whose ASSET_ID could authenticate a cross-chain
    /// link, so the link is set once here rather than via the permissionless registerWrapped — fixing it
    /// at deploy and keeping the tacit-side tETH id consistent across pool generations. 0 ⇒ no tETH here.
    bytes32 internal immutable TETH_BITCOIN_LINK;

    /// The cBTC native-ETH escrow gate (CollateralEngine). Immutable pointer set at deploy (the engine is
    /// itself the mutable, DAO-governed policy contract; this pointer just names it). 0 ⇒ cBTC mint is inert
    /// (no escrow gate available → OP_CBTC_MINT fails closed). The engine can NEVER mint/move backing — it
    /// only answers escrowSufficient; the proof + this contract hold the value.
    ICollateralEngine internal immutable COLLATERAL_ENGINE;

    // ──────────────────── Commitment tree (global, Keccak) ────────────────────

    uint256 public nextLeafIndex;
    bytes32 public currentRoot;
    bytes32[TREE_LEVELS] internal zeros;
    bytes32[TREE_LEVELS] internal filledSubtrees;
    mapping(bytes32 => bool) public everKnownRoot;

    // ──────────────────── Nullifiers (global) ────────────────────

    mapping(bytes32 => bool) public nullifierSpent;
    // No-inflation floor (defense-in-depth): cumulative count of EVM-HOMED note-spends. Every spend
    // references a note that was created as a leaf in THIS tree, so this can never exceed nextLeafIndex
    // (the total leaves ever created — deposits, settle outputs, bridge-mints). Bitcoin-homed cross-lane
    // spends are backed by the reflected Bitcoin tree, not this one, so they are excluded. Mirrors the
    // Bitcoin mixer's #spent ≤ #leaves reserve floor; bounds a guest/vkey compromise to real deposits.
    uint256 internal evmNullifiersSpent;

    // ──────────────────── Assets ────────────────────

    struct Asset {
        bool registered;
        address underlying; // ERC-20 backing; for poolMinted assets, the canonical ERC20 this pool mints/burns
        uint256 unitScale; // underlying base units per in-system value unit
        bytes32 crossChainLink; // Bitcoin-side asset id for shared-asset recognition (0 if none)
        bool poolMinted; // true ⇒ a Tacit-recorded asset whose canonical ERC20 the pool MINTS on exit
        // / BURNS on entry (no escrow); false ⇒ an external ERC20 the pool escrows
        string name;
        string symbol;
        uint8 decimals;
    }

    // Field order is LAYOUT-ONLY (the `assets()` getter fixes the external tuple order, and `_assets` is
    // internal + not storage-proven by any guest). The sub-word fields pack with the 20-byte address into ONE
    // slot (1+20+1+1 = 23 ≤ 32), so the hot trio registered/poolMinted/underlying shares a single warm SLOAD on
    // every wrap/payout, and a registration writes 3 slots. name/symbol are NOT stored — they ride the
    // `AssetRegistered` event (the dapp reads them there), saving two slots + the packing on every register.
    struct AssetStore {
        bool registered;
        address underlying; // ERC-20 backing; for poolMinted assets, the canonical ERC20 this pool mints/burns
        bool poolMinted; // true ⇒ this pool mints/burns the canonical ERC20; false ⇒ escrow-backed
        uint8 decimals;
        uint256 unitScale; // underlying base units per in-system value unit
        bytes32 crossChainLink; // Bitcoin-side asset id for shared-asset recognition (0 if none)
    }

    mapping(bytes32 => AssetStore) internal _assets; // asset_id => Asset
    mapping(bytes32 => uint256) public escrow; // asset_id => escrowed underlying

    // ──────────────────── Confidential AMM pools (OP_SWAP) ────────────────────

    // A constant-product pool over two in-system assets. Reserves are PUBLIC on-chain state
    // (the swap circuit reads them as input); only the per-trade amounts are hidden, cleared at
    // one uniform price for the whole batch. The slot is created empty by createPair; the first
    // OP_LP_ADD funds reserves from the founder's existing shielded notes, so reserves are always
    // backed by the same escrow that backs every circulating note (escrow is touched only at wrap).
    struct Pool {
        bool init;
        bytes32 assetA;
        bytes32 assetB;
        uint256 reserveA;
        uint256 reserveB;
        uint32 feeBps;
        uint256 totalShares;
    }
    mapping(bytes32 => Pool) public pools; // poolId => Pool

    // ──────────────────── Pending deposits (wraps awaiting inclusion) ────────────────────

    // depositId => 0 none, 1 pending, 2 consumed
    mapping(bytes32 => uint8) public depositStatus;

    // ──────────────────── Cross-chain (one note, Bitcoin or Ethereum) ────────────────────

    // A Bitcoin-side note burn, claimed once when its value is minted as an Ethereum
    // note. Keyed by the burned note's nullifier ν (the guest proves ν is spent on
    // Bitcoin via relay-attested spent-set membership). One mint per burned note.
    mapping(bytes32 => bool) public bridgeMinted;

    // Cross-OUT (Ethereum→Bitcoin) record: claimId => destCommitment, written on `settle`
    // when an Ethereum note is burned for Bitcoin (alongside the CrossOutRecorded event).
    // Persisted in STORAGE, not just the event, so the reverse-reflection prover can prove a
    // cross-out via a clean eth_getProof storage-slot proof (state trie) rather than parsing
    // receipts/logs. claimId is unique per burned note, so the write is idempotent. 0 = none.
    mapping(bytes32 => bytes32) public crossOutCommitment;

    // Bitcoin confidential-pool roots an SP1 relay proof has attested as canonical +
    // confirmed (attestBitcoinStateProven; no trusted oracle). A bridge_mint proves
    // the burned note's membership against one of
    // these, so a fake-tree note cannot be minted (the inflation-critical gate).
    // Also accepted as a `spendRoot` for the cross-lane fast lane (a
    // Bitcoin-homed note spent on Ethereum).
    mapping(bytes32 => bool) public knownBitcoinRoot;

    // The reflected Bitcoin spent-nullifier indexed-Merkle root (set ONLY by an SP1
    // relay proof, attestBitcoinStateProven). A settle that does cross-lane non-membership
    // in-guest
    // commits the root it checked against in `pv.bitcoinSpentRoot`; this must equal
    // the current reflected root, so a stale root (omitting recent Bitcoin spends)
    // can't be used. O(1) on-chain — the scalable cross-lane gate.
    bytes32 public knownBitcoinSpentRoot;

    // The reflected Bitcoin BRIDGE-BURN indexed-Merkle root: the nullifiers of notes that
    // were burned on Bitcoin WITH an Ethereum destination (a bridge-out), DISTINCT from the
    // generic spent set. A bridge_mint proves the burned note's ν is a MEMBER of this set —
    // never the spent set. The spent set holds every Bitcoin spend, so authorizing a mint
    // on spent-set membership would let any ordinarily-spent note be minted on Ethereum
    // (value duplication); the dedicated burn set authorizes only genuine bridge-outs.
    bytes32 public knownBitcoinBurnRoot;

    // The reflection prover resumes from the prior attested state and commits the new one as
    // a digest (every reflected root + leaf count + height). Each cycle proves it CONTINUES
    // this digest (priorDigest == knownReflectionDigest), then advances it — so the reflected
    // roots evolve as one append-only chain (O(Δ)/proof), never a fresh start or a rollback.
    // bytes32(0) before the first attestation (the genesis digest seeds the first cycle).
    bytes32 public knownReflectionDigest;

    // cBTC: the reflection-attested Σ of live self-custody cBTC.zk lock sats (the real-BTC backing behind
    // cBTC). Reflection-verified state, advanced each attestation — the off-pool CollateralEngine reads it via
    // the cbtcBackingSats() view to size the peg shortfall (circulating cBTC vs this). The peg itself is
    // oracle-free; this is consumed only by the (standalone, governable) buffer, never by settle. Exposed
    // through the named cbtcBackingSats() view (the buffer's integration point).
    uint256 public cbtcBackingSats;

    // The reflection prover's genesis digest — ScanReflection::genesis().digest() (the shipped
    // full-scan model): an empty note tree + sentinel-seeded spent/burn sets + empty live-UTXO set.
    // knownReflectionDigest is seeded to this so the first attestation continues genesis. Pinned in
    // cxfer-core (genesis_digest_matches_contract_constant). Tied to BITCOIN_RELAY_VKEY (one prover).
    bytes32 internal constant REFLECTION_GENESIS_DIGEST =
        0x7b058378c57dc5e8586e588ed5b010862924ec34dfce88495379135ae006ef41;

    // cBTC.zk's canonical asset id = keccak256("tacit-cbtc-zk-lock-v1") (cxfer-core CBTC_ZK_ASSET_ID) — the
    // fixed domain const the reflection guest mints real-BTC-locked cBTC notes under. Pinned so the
    // constructor can link it to the canonical cBTC.tac ERC20: it is a lock position, NOT a Bitcoin etch, so
    // the permissionless attest_meta link path can't reach it, and (unlike a foreign id) it has one canonical
    // backing. Public so launch scripts/dapps/engine config can assert one shared id before enabling cBTC.
    bytes32 public constant CBTC_ZK_ASSET_ID =
        0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;

    // The tacBTC (cBTC.tac) metadata CID (EIP-7572 contractURI) = sha256 of contracts/cbtc-tac-metadata.json
    // (raw CIDv1), whose image is contracts/cbtc-tac-icon.svg. Baked into the canonical factory address via
    // the CREATE2 salt, so it is immutable and fixes the tacBTC identity + address; pinned before the
    // cBTC-capable deploy. tacBTC = the public ERC-20 form of cBTC (Tacit's confidential Bitcoin).
    bytes32 internal constant CBTC_METADATA_CID =
        0x4fdafc3227875f0973780cc0aa6aa186c8cb00a0564fbed8bdf1f0cfa16b06cc;

    // The tacUSD (cUSD.tac) metadata CID (EIP-7572 contractURI) = sha256 of contracts/cusd-tac-metadata.json
    // (raw CIDv1), image contracts/cusd-tac-icon.svg. tacUSD = the public ERC-20 form of cUSD, Tacit's
    // cBTC-collateralized CDP dollar. Baked into the canonical factory address via the CREATE2 salt.
    bytes32 internal constant CUSD_METADATA_CID =
        0x927144081b10389996f30ec9e2182ae5c04c397d79f497e23947926a51214ab0;

    // A shared (Bitcoin-side) asset id => this pool's local registry key. A bridge_mint note
    // carries the SHARED id as its `asset` (it must, to prove membership in the Bitcoin
    // pool), so the registry resolves that id back to the local entry on unwrap — else a
    // bridged note could never exit. Set for a pool-minted asset whose canonical token commits to the
    // same id (via the guest-proven attest_meta path), or for NATIVE ETH (tETH) whose link is pinned in
    // the constructor (TETH_BITCOIN_LINK) — never a permissionless caller's choice, so it cannot be
    // squatted to misroute a payout.
    mapping(bytes32 => bytes32) public localAssetOf;

    // ──────────────────── Adaptor-swap lock set (OP_ADAPTOR_LOCK/CLAIM/REFUND) ────────────────────
    // Declared at the END of storage so the existing slot layout is unchanged (crossOutCommitment stays
    // at its slot, which the reverse-reflection prover reads via eth_getProof).

    // A locked note (the confidential conditional-spend leg of an atomic swap) lives in a SEPARATE
    // incremental-Merkle accumulator, never the note tree — so no OP_TRANSFER can spend it; only a
    // deadline-gated OP_ADAPTOR_CLAIM / OP_ADAPTOR_REFUND, which the guest proves against a known lock
    // root. Value conserves lock→claim/refund (the kernel), and the claim/refund OUTPUT is the note-tree
    // leaf that carries the value back out — so the lock set adds no note-tree leaves and never touches
    // the reserve floor. Same Keccak hashing + depth as the note tree (shares `zeros`).
    uint256 internal lockNextLeafIndex;
    bytes32 public lockRoot;
    bytes32[TREE_LEVELS] internal lockFilledSubtrees;
    mapping(bytes32 => bool) internal everKnownLockRoot;
    // ν of locked notes already claimed or refunded — spend-once (claim XOR refund). A namespace
    // distinct from `nullifierSpent`: a locked note was never a note-tree leaf, so a claim/refund must
    // neither be gated by nor consume the note-tree nullifier set.
    mapping(bytes32 => bool) internal lockSpent;

    // ──────────────────── Fast lane (Bitcoin-homed note spent on Ethereum) ────────────────────
    // Appended at the END of storage (like the lock set above) so existing slots are unchanged —
    // crossOutCommitment stays at its slot (76), the index the eth-reflection guest already reflects.

    // A Bitcoin-homed note's nullifier consumed by a value-exit on the Ethereum fast lane:
    // ν => the Bitcoin pool root (spendRoot) membership was proven against (non-zero = consumed).
    // The eth-reflection guest proves these slots (eth_getProof, the same mechanism as crossOutCommitment)
    // and the Bitcoin reflection guest folds them into the Bitcoin SPENT set, so the source note is marked
    // spent on Bitcoin (Ethereum-senior) — closing the one-directional-reflection gap the bridge-only bar
    // otherwise enforces. A DEDICATED map, never `nullifierSpent` (which holds native EVM spends that must
    // never enter Bitcoin's spent set). Written only on a btcHomed fast-lane value-exit; never read on-chain.
    mapping(bytes32 => bytes32) public bitcoinConsumed;

    // Monotone count of distinct `bitcoinConsumed` entries ever written — the fast-lane FRESHNESS anchor.
    // Each entry is a distinct ν (the nullifierSpent gate bars a repeat), so this is exactly the number of
    // consumed notes. The eth-reflection guest reads THIS slot via the same finalized storage proof it uses
    // for the entries, and asserts its folded `consumedNuCount == bitcoinConsumedCount` at that block. So a
    // worker cannot witness only a SUBSET of consumes (omitting recent ones) and leave the omitted source
    // notes live + double-spendable on Bitcoin: advancing the reflection's finalized slot now REQUIRES
    // folding every consume recorded as of that slot. Appended last so crossOutCommitment(76) /
    // bitcoinConsumed(119) keep the indices the eth-reflection guest hardcodes.
    uint256 public bitcoinConsumedCount;

    // Public (non-shielded) LP shares: poolId => owner => shares. APPENDED LAST (like the lock set +
    // fast-lane maps above) so crossOutCommitment(76) / bitcoinConsumed(119) / bitcoinConsumedCount(120)
    // keep the slots the eth-reflection guest hardcodes. The PUBLIC add/remove path
    // (createPairAndAddLiquidityPublic / removeLiquidityPublic) credits/burns here; the CONFIDENTIAL path
    // mints/burns shielded share NOTES (in the tree, not here). pools[poolId].totalShares is the single
    // shared accumulator = Σ public lpShares + Σ confidential note-shares + the locked MINIMUM_LIQUIDITY.
    mapping(bytes32 => mapping(address => uint256)) public lpShares;

    // ──────────────────── cBTC self-custody lock registry + CDP position set ────────────────────
    // APPENDED LAST (after the lock set + fast-lane maps + lpShares) so crossOutCommitment(76) /
    // bitcoinConsumed(119) / bitcoinConsumedCount(120) keep the slots the eth-reflection guest hardcodes.

    // cBTC: per-lock state recorded from the reflection's cbtcLocksFolded / cbtcLocksSpent. cbtcLockVBtc and
    // cbtcLockCommitment are the OP_CBTC_MINT gate (the note must match the lock's value + pre-committed
    // commitment); cbtcLockSpent flags a spend the CollateralEngine slashes if it wasn't a redemption;
    // cbtcMinted is the one-mint-per-lock gate. See ops/DESIGN-confidential-defi-v1.md §3.
    mapping(bytes32 => uint64) internal cbtcLockVBtc;
    mapping(bytes32 => bytes32) internal cbtcLockCommitment;
    mapping(bytes32 => bool) public cbtcLockSpent;
    mapping(bytes32 => bool) internal _cbtcMinted;

    // CDP position set (ops 15–17): a confidential CDP position lives in a SEPARATE incremental-Merkle
    // accumulator (same hashing/depth as the note + lock trees), never the note tree — so only an
    // OP_CDP_CLOSE / OP_CDP_LIQUIDATE / OP_CDP_TOPUP (proven against a known cdp root) can consume it.
    // The position is domain-separated in-guest; close/liquidate/top-up spend its nullifier once.
    uint256 internal cdpNextLeafIndex;
    bytes32 public cdpRoot;
    bytes32[TREE_LEVELS] internal cdpFilledSubtrees;
    mapping(bytes32 => bool) internal everKnownCdpRoot;
    mapping(bytes32 => bool) internal cdpPositionSpent;

    // Enumerable fast-lane consume log. The mapping form keeps append-only storage cheap while letting the
    // eth-reflection guest prove the exact index range [priorCount, bitcoinConsumedCount), rather than a
    // worker-selected set of `bitcoinConsumed[nu]` keys whose cardinality merely matches the counter.
    // APPENDED LAST: its declaration slot is a guest-pinned protocol interface.
    mapping(uint256 => bytes32) public bitcoinConsumedAt;

    // Value-free Bitcoin-authorized calls (SPEC-BITCOIN-HOOK-AMENDMENT §1.4): the reflection proves a signed
    // Bitcoin call envelope; attest records it here; the separate BtcCallExecutor fires it, so a hostile
    // target can never revert the attest. Stores only a 32-byte commitment per callId =
    // keccak(executor‖target‖calldataHash‖callerPubkey); the executor re-supplies those fields (public from the
    // Bitcoin tx) and checks them against this commitment. Appended after the guest-pinned slots.
    mapping(bytes32 => bytes32) public pendingBtcCall;

    // Escrow-mode farm treasury (ops/PLAN-evm-farm-rewards.md): controller => its escrow-backed reward asset
    // (pinned on first fundFarm) and the funded, not-yet-distributed budget (in-system units). The harvest bound
    // in _settle debits the budget by debtValue; fundFarm/recoverFarm reuse the escrow + payout machinery so the
    // invariant escrow[asset] == Σ outstanding reward notes + Σ farmTreasury holds. Internal (no getter) for the
    // codesize budget — the dapp reads the treasury from the controller's notify/harvest events.
    mapping(address => bytes32) internal farmRewardAsset;
    mapping(address => uint256) internal farmTreasury;

    // ──────────────────── Public-values layout ────────────────────

    // Boundary effects speak the in-system note value `v`; the contract scales it to
    // underlying by the asset's trusted `unitScale` on payout, so the guest (which
    // never sees unitScale) can never release more than a note is worth.
    struct Withdrawal {
        bytes32 assetId;
        address recipient;
        uint256 value;
    }

    struct FeePayment {
        bytes32 assetId;
        uint256 value;
    }

    // An Ethereum note burned for value on another chain. The guest proved the
    // burned value equals destCommitment's and nullified the note (ν in
    // `nullifiers`); Bitcoin validators mint the destination note once, off-chain.
    struct CrossOut {
        uint16 destChain;
        bytes32 destCommitment;
        bytes32 nullifier;
        bytes32 assetId;
        bytes32 claimId;
    }

    // Metadata the guest proved from a Bitcoin etch reveal (asset_id binds the txid, the
    // txid binds the on-chain envelope's ticker+decimals) — trustless first-mint metadata.
    struct AssetMeta {
        bytes32 assetId;
        bytes16 ticker;
        uint8 tickerLen;
        uint8 decimals;
        bytes32 cid;
    }

    // A confidential AMM batch settled against a pool (OP_SWAP). The guest proved, per intent,
    // membership + nullifier + the secp opening-sigma binding (a Schnorr PoK of the note blinding
    // for the public amount — the settle prover never learns r) + the hidden-amount clearing at the
    // pool's uniform price + reserve conservation; the trader notes flow through the
    // existing nullifiers/leaves. The guest reads the pool's CURRENT public reserves as `*Pre`
    // and computes `*Post` = pre + net deltas (conservation). The contract gates pre == the live
    // reserves (so the guest cleared against the real pool) and sets the reserves to post.
    struct SwapSettlement {
        bytes32 poolId;
        uint256 reserveAPre;
        uint256 reserveBPre;
        uint256 reserveAPost;
        uint256 reserveBPost;
    }

    struct LpSettlement {
        bytes32 poolId;
        uint256 reserveAPre;
        uint256 reserveBPre;
        uint256 sharesPre;
        uint256 reserveAPost;
        uint256 reserveBPost;
        uint256 sharesPost;
    }

    // Generic CDP (ops 15–17, 19) + cBTC mint (op 18). The guest proved structure + conservation; the contract
    // applies the controller's policy + the cBTC lock/escrow gate. See ops/DESIGN-confidential-defi-v1.md §§3,4.
    struct CdpMint {
        address controller;
        bytes32 debtAsset;
        uint256 debtValue;
        bytes32 positionLeaf;
        CdpLeg[] legs;
    }

    struct CdpClose {
        address controller;
        uint256 debtValue;
        bytes32 positionNullifier;
        CdpLeg[] legs;
    }

    struct CdpLiquidate {
        address controller;
        uint256 debtValue;
        bytes32 positionNullifier;
        CdpLeg[] legs;
    }

    struct CdpTopup {
        address controller;
        uint256 debtValue;
        bytes32 oldPositionNullifier;
        bytes32 newPositionLeaf;
        CdpLeg[] oldLegs;
        CdpLeg[] newLegs;
    }

    struct CbtcMint {
        bytes32 outpoint;
        uint256 vBtc;
        bytes32 commitment;
    }

    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot; // root the guest proved input membership against
        bytes32[] nullifiers; // spent-note nullifiers (chain-independent)
        bytes32[] leaves; // new leaves to append (consumed deposits + outputs + cross-mints)
        bytes32[] depositsConsumed; // deposit ids the guest validated + inserted
        Withdrawal[] withdrawals; // unwrap payouts (in-system value; scaled by unitScale)
        FeePayment[] fees; // settler fees (in-system value; scaled), paid to msg.sender
        bytes32[] bitcoinBurnsConsumed; // burned-note nullifiers minted here, gated once each
        CrossOut[] crossOuts; // Ethereum burns destined for Bitcoin
        bytes32[] bitcoinRootsUsed; // Bitcoin pool roots a bridge_mint proved membership against
        bytes32 bitcoinSpentRoot; // Bitcoin spent-set IMT root the guest proved non-membership against (0 = none)
        bytes32 bitcoinBurnRoot; // Bitcoin bridge-burn IMT root a bridge_mint proved burn membership against (0 = none)
        SwapSettlement[] swaps; // confidential AMM batches (OP_SWAP): pre→post pool reserves
        LpSettlement[] liquidity; // confidential LP (OP_LP_ADD/REMOVE): pre→post reserves + totalShares
        uint64 deadline; // settle expiry (unix secs); 0 = none. The guest commits the earliest op deadline
        // Adaptor-swap leg (OP_ADAPTOR_LOCK/CLAIM/REFUND): a confidential, deadline-gated conditional
        // spend. A locked note lives in a SEPARATE accumulator (below), never the note tree.
        bytes32 lockSetRoot; // lock-set root a claim/refund proved membership against (0 = none)
        bytes32[] lockLeaves; // new locked notes appended by OP_ADAPTOR_LOCK
        bytes32[] lockNullifiers; // locked-note ν spent by claim/refund (spend-once, claim XOR refund)
        bytes32[] adaptorClaimS; // each claim's completed kernel s (off-chain t-reveal; no ETH value)
        uint64 refundNotBefore; // latest refund deadline in the batch; a refund settles only at/after it
        // Generic CDP (ops 15–17, 19) + cBTC mint (op 18) — appended last.
        bytes32 cdpPositionRoot; // position-set root CLOSE/LIQUIDATE/TOPUP proved membership against (0 = none)
        CdpMint[] cdpMints; // open: append positionLeaf to the position set + controller.onCdpMint
        CdpClose[] cdpCloses; // close: dedup positionNullifier + controller.onCdpClose
        CdpLiquidate[] cdpLiquidations; // liquidate: dedup positionNullifier + controller.onCdpLiquidate (reverts if healthy)
        CdpTopup[] cdpTopups; // top-up: consume old position + append replacement with larger basket
        CbtcMint[] cbtcMints; // cBTC mint: gated on the recorded lock + the native-ETH escrow
    }

    // ──────────────────── Events ────────────────────

    event AssetRegistered(
        bytes32 indexed assetId,
        address indexed underlying,
        uint256 unitScale,
        string name,
        string symbol,
        uint8 decimals
    );
    // depositId binds (assetId, value, cx, cy, owner); the commitment coordinates and owner are NOT
    // published, so a deposit note's nullifier (a function of its commitment) stays externally
    // uncomputable and its later spend is unlinkable — the same standing as any in-pool note. `amount`
    // is public regardless (the underlying transfer reveals it) and lets a seed-only recovery match
    // re-derived candidate deposits to the emitted depositId.
    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount);
    // Note data availability for recovery: each inserted leaf with its encrypted
    // memo (owner-only; unverified passthrough), aligned, from firstLeafIndex.
    event LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos);
    event NullifiersSpent(bytes32[] nullifiers);
    // An Ethereum note was burned for Bitcoin; validators honor it once past finality.
    event CrossOutRecorded(
        bytes32 indexed claimId, uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 assetId
    );
    // Fast lane: Bitcoin-homed notes consumed by a value-exit on Ethereum, recorded in `bitcoinConsumed`
    // for the reverse reflection to fold into the Bitcoin spent set. `spendRoot` = the Bitcoin pool root
    // membership was proven against. The worker reads this to build the eth-reflection witness set.
    event BitcoinNotesConsumed(bytes32[] nullifiers, bytes32 spendRoot);

    // ──────────────────── Errors ────────────────────

    error Expired();
    error ZeroVKey();
    error SameAsset();
    error BadVersion();
    error FeeTooHigh();
    error PoolExists();
    error BadDecimals();
    error PoolNotInit();
    error UnknownRoot();
    error ZeroAddress();
    error NotAContract();
    error WrongEthPool();
    error ChainMismatch();
    error DepositExists();
    error NotRegistered();
    error PoolNotMinter();
    error CanonicalAsset();
    error MerkleTreeFull();
    error RefundTooEarly();
    error UnknownCdpRoot();
    error StaleRelayProof();
    error UnknownLockRoot();
    error ValueOutOfRange();
    error AmountNotAligned();
    error BadCdpController();
    error CbtcLockMismatch();
    error CrossChainEscrow();
    error EthValueMismatch();
    error LockAlreadySpent();
    error MemoLeafMismatch();
    error SlippageExceeded();
    error AlreadyRegistered();
    error BurnAlreadyMinted();
    error DepositNotPending();
    error ConsumedCountStale();
    error InsufficientEscrow();
    error ReserveFloorBreach();
    error UnknownBitcoinRoot();
    error CrossChainLinkTaken();
    error PoolReserveMismatch();
    error ZeroBitcoinPoolRoot();
    error StaleBitcoinBurnRoot();
    error UnanchoredReflection();
    error BridgeBurnNotEthHomed();
    error CrossOutClaimMismatch();
    error InsufficientLiquidity();
    error NullifierAlreadySpent();
    error StaleBitcoinSpentRoot();
    error StaleReflectionDigest();
    error CdpPositionAlreadySpent();
    error CrossChainTokenMismatch();
    error ConstantProductDecreased();
    error FeeOnTransferUnsupported();
    error CrossOutNullifierNotSpent();
    error BadReflectionConfirmations();
    error BtcHomedValueExitMustBridge();

    // ──────────────────── Constructor ────────────────────

    constructor(
        address sp1Verifier_,
        bytes32 programVKey_,
        bytes32 bitcoinRelayVKey_,
        address canonicalFactory_,
        address headerRelay_,
        bytes32 genesisReflectionAnchor_,
        uint256 reflectionConfirmations_,
        bytes32 reflectionResumeDigest_,
        bytes32 tethBitcoinLink_,
        address collateralEngine_
    ) {
        if (sp1Verifier_ == address(0)) revert ZeroAddress();
        if (programVKey_ == bytes32(0)) revert ZeroVKey();
        // Reflection can't be trustless without a relay to anchor the header chain: a non-zero
        // BITCOIN_RELAY_VKEY (cross-chain ON) requires a non-zero HEADER_RELAY. It also requires a
        // non-zero genesis anchor — the first batch's prev anchors to it, and a zero seed makes the
        // very first attest's _anchorReflection unsatisfiable forever (mirrors SP1PoolRootVerifier's
        // ZeroGenesis guard).
        if (bitcoinRelayVKey_ != bytes32(0) && headerRelay_ == address(0)) revert ZeroAddress();
        if (bitcoinRelayVKey_ != bytes32(0) && genesisReflectionAnchor_ == bytes32(0)) revert ZeroAddress();
        // When reflection is ON, the maturity depth must be a sane, gas-bounded, NON-ZERO value: zero
        // would anchor a batch's tip to the live relay tip (~1 confirmation), re-opening the bridge-burn
        // shallow-reorg window the maturity gate closes. Unused when reflection is off (anchor never runs).
        if (
            bitcoinRelayVKey_ != bytes32(0)
                && (reflectionConfirmations_ == 0 || reflectionConfirmations_ > MAX_REFLECTION_CONFIRMATIONS)
        ) {
            revert BadReflectionConfirmations();
        }
        SP1_VERIFIER = ISP1Verifier(sp1Verifier_);
        PROGRAM_VKEY = programVKey_;
        CHAIN_BINDING = keccak256(abi.encodePacked(block.chainid, address(this)));
        BITCOIN_RELAY_VKEY = bitcoinRelayVKey_; // the sole Bitcoin-state authority (a proof)
        HEADER_RELAY = IRelay(headerRelay_);
        lastReflectionBlockHash = genesisReflectionAnchor_; // the first batch's prev anchors here
        REFLECTION_CONFIRMATIONS = reflectionConfirmations_;
        // A non-zero factory must be a deployed contract: a mistyped/EOA address would silently disable
        // trustless first-mint metadata (_autoRegisterFromMeta skips on a zero factory; a non-contract
        // would revert every attest_meta settle) with no recovery on an immutable pool. 0 = disabled.
        if (canonicalFactory_ != address(0) && canonicalFactory_.code.length == 0) revert NotAContract();
        if (collateralEngine_ != address(0)) {
            if (canonicalFactory_ == address(0)) revert ZeroAddress();
            if (collateralEngine_.code.length == 0) revert NotAContract();
        }
        CANONICAL_FACTORY = ICanonicalAssetFactory(canonicalFactory_);
        // The reflection-resume anchor. 0 ⇒ a genesis-anchored deploy (gen-1): the first cycle continues the
        // protocol genesis digest. NON-ZERO ⇒ a GENERATIONAL deploy (gen-N) that joins the SHARED Bitcoin
        // reflection mid-stream — it seeds at the CURRENT (near-tip) reflected digest, so it never replays
        // Bitcoin history (the 73-block bootstrap OOM). It must be paired with the matching
        // `genesisReflectionAnchor_` (the same reflected state's tip); a mismatch is fail-closed (the first
        // attest reverts StaleReflectionDigest / UnanchoredReflection — no fund risk, just can't bootstrap).
        // See ops/PLAN-pool-generations.md.
        knownReflectionDigest =
            reflectionResumeDigest_ == bytes32(0) ? REFLECTION_GENESIS_DIGEST : reflectionResumeDigest_;

        // The CollateralEngine is the mutable policy contract; this pointer just names it (may be 0 ⇒ cBTC
        // mint inert). Non-zero cBTC mode is atomic: engine contract + canonical factory, so a cBTC note can
        // both mint privately and resolve to cBTC.tac on public exit/recovery.
        COLLATERAL_ENGINE = ICollateralEngine(collateralEngine_);

        bytes32 z = bytes32(0);
        for (uint256 i; i < TREE_LEVELS; ++i) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            lockFilledSubtrees[i] = z;
            cdpFilledSubtrees[i] = z;
            z = _hash(z, z);
        }
        currentRoot = z;
        everKnownRoot[z] = true;
        // The lock set is an independent tree with the same empty root; seed it identically so the first
        // claim/refund can pin a known (initially empty) lock root.
        lockRoot = z;
        everKnownLockRoot[z] = true;
        // The CDP position set is likewise an independent tree with the same empty root; seed it so the
        // first close/liquidate can pin a known (initially empty) position root.
        cdpRoot = z;
        everKnownCdpRoot[z] = true;

        // Pin native ETH (tETH) for this generation. Set here — not via the permissionless registerWrapped
        // — so the single native-ETH slot's cross-chain link is fixed at construction and identical across
        // generations. 0 ⇒ this generation doesn't host tETH (native ETH may still be registered later as a
        // plain link-free escrow asset). Native ETH at 18 dec → Tacit 8 ⇒ unitScale 10^10; the native-ETH
        // register path makes no external call, so this is constructor-safe.
        TETH_BITCOIN_LINK = tethBitcoinLink_;
        if (tethBitcoinLink_ != bytes32(0)) {
            _register(address(0), 10 ** 10, tethBitcoinLink_, false, "Tacit ETH", "tETH", 18);
        }

        // Day-1 cBTC.tac (hardcoded V1; iterate the brand/metadata via a later generation). When this is a
        // cBTC-capable deployment — a CanonicalAssetFactory to materialize the token AND a CollateralEngine
        // for the cBTC mint's native-ETH escrow gate — deploy-or-adopt the canonical cBTC.tac ERC20 (pool =
        // sole MINTER, deterministic factory address) and pin cBTC.zk → it. The reflection guest mints
        // real-BTC-locked cBTC notes under CBTC_ZK_ASSET_ID (the shared cross-chain id), so resolving that id
        // to a pool-minted ERC20 is what lets a cBTC note mint cBTC.tac on exit, a cUSD-CDP liquidation seize
        // pay out, and the engine's recoverSeizedCbtc resolve the token. cBTC.zk is a lock POSITION (not a
        // Bitcoin etch), so it has one canonical backing and the permissionless attest_meta link path can't
        // reach it — hence the constructor pin, mirroring tETH above. Native precision 8 (sats) → unitScale
        // 10^(18−8)=10^10 onto the 18-dec ERC20. deploy-or-adopt (tokenOf-first) is front-run-safe: the
        // factory address is salt-bound to (id, this, "tacBTC", 18, cid), so any pre-deploy IS the canonical
        // token (pool-minted, right id). 0 engine ⇒ no cBTC mint path here.
        if (collateralEngine_ != address(0)) {
            address cbtcTac =
                CANONICAL_FACTORY.tokenOf(CBTC_ZK_ASSET_ID, address(this), "tacBTC", ETH_DECIMALS, CBTC_METADATA_CID);
            if (cbtcTac == address(0)) {
                cbtcTac =
                    CANONICAL_FACTORY.deployCanonical(CBTC_ZK_ASSET_ID, address(this), "tacBTC", ETH_DECIMALS, CBTC_METADATA_CID);
            }
            _register(cbtcTac, 10 ** 10, CBTC_ZK_ASSET_ID, true, "Tacit Bitcoin", "tacBTC", ETH_DECIMALS);

            // Day-1 tacUSD (cUSD.tac). The engine IS the cUSD CDP controller, so the debt asset id is
            // keccak("tacit-cdp-debt-v1" ‖ engine) — derivable here from the engine address (mirrors
            // cxfer-core::cdp_debt_asset_id and the _settle CDP-mint check). Deploy-or-adopt its canonical
            // 18-dec ERC20 (pool = sole MINTER) and pin that debt id → it, so a cUSD CDP note exits to tacUSD
            // on unwrap and a wrapped tacUSD burns back into a shielded cUSD note. Symmetric to tacBTC. The
            // engine must be deployed with cusdDec = 8 (matches unitScale 10^10 onto the 18-dec ERC20).
            bytes32 cusdId = keccak256(abi.encodePacked("tacit-cdp-debt-v1", collateralEngine_));
            address cusdTac =
                CANONICAL_FACTORY.tokenOf(cusdId, address(this), "tacUSD", ETH_DECIMALS, CUSD_METADATA_CID);
            if (cusdTac == address(0)) {
                cusdTac =
                    CANONICAL_FACTORY.deployCanonical(cusdId, address(this), "tacUSD", ETH_DECIMALS, CUSD_METADATA_CID);
            }
            _register(cusdTac, 10 ** 10, cusdId, true, "Tacit USD", "tacUSD", ETH_DECIMALS);
        }
    }

    // ──────────────────── cBTC escrow views (the CollateralEngine reads these) ────────────────────

    function cbtcMinted(bytes32 outpoint) external view returns (bool) {
        return _cbtcMinted[outpoint];
    }

    // ──────────────────── Asset registry ────────────────────

    /// @notice Register an EXTERNAL ERC20 (e.g. USDC) as a confidential asset: the pool
    ///         escrows it on wrap and releases it on unwrap. `unitScale` maps underlying
    ///         base units to the in-system value unit (so a note's value stays within the
    ///         Bulletproofs+ range; wrap amounts must be a multiple of it). `crossChainLink`
    ///         MUST be 0 here. An external ERC20 escrow can never claim a Bitcoin-side id (a non-zero
    ///         link reverts CrossChainEscrow); native ETH's link (tETH) is pinned at construction
    ///         (`TETH_BITCOIN_LINK`), not on this permissionless path. A pool-minted asset's link is
    ///         bound only by the guest-proven attest_meta path.
    function registerWrapped(
        address underlying,
        uint256 unitScale,
        bytes32 crossChainLink,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external nonReentrant returns (bytes32 assetId) {
        // Native ETH's cross-chain link is pinned at construction (TETH_BITCOIN_LINK), never set here: as a
        // single-slot asset with no token to authenticate a link against, binding it on this permissionless
        // path would be first-writer-wins. A non-zero link on native ETH is rejected.
        if (underlying == address(0) && crossChainLink != bytes32(0)) revert CrossChainEscrow();
        return _register(underlying, unitScale, crossChainLink, false, name_, symbol_, decimals_);
    }

    /// @notice Register an external Ethereum-native ERC20, reading its metadata on-chain
    ///         and DERIVING the Tacit-side scale: the asset is represented at
    ///         min(decimals, 8) on Bitcoin/Tacit (its native limit), so
    ///         `unitScale = 10^(decimals − tacitDecimals)` (18-dec WETH → 8 on Tacit,
    ///         scale 10^10; 6-dec USDC → 6, scale 1). Symmetric to `registerMintedAuto`;
    ///         the pool escrows the ERC20 (no minting). `name`/`symbol` mirror the
    ///         underlying — external assets keep their own identity, not the Tacit brand.
    ///         `crossChainLink` MUST be 0 (see `registerWrapped`: an escrow asset can never
    ///         claim a Bitcoin-side id; a non-zero link reverts CrossChainEscrow).
    function registerWrappedAuto(address underlying, bytes32 crossChainLink)
        external
        nonReentrant
        returns (bytes32 assetId)
    {
        uint8 d = IERC20Metadata(underlying).decimals();
        uint8 tacitDecimals = d > 8 ? 8 : d;
        uint256 unitScale = 10 ** uint256(d - tacitDecimals);
        return _register(underlying, unitScale, crossChainLink, false, "", "", d);
    }

    /// @notice Register a LOCAL pool-minted asset whose canonical ERC20 THIS POOL mints/burns
    ///         (`canonicalErc20` must have its mint authority set to this pool): the public ERC20
    ///         is minted on unwrap, burned on wrap, no escrow. For a BRIDGED (cross-chain) asset,
    ///         the registry link is established trustlessly by the guest-proven attest_meta path
    ///         (not here), which binds the scale to the asset's real Bitcoin-etch decimals.
    /// @dev Registers a LOCAL (non-bridged) pool-minted asset. unitScale is DERIVED
    ///      (`10^(ETH_DECIMALS − tacitDecimals)`), never operator-chosen, and the canonical ERC20
    ///      must be at ETH_DECIMALS. registerMinted does NOT establish a cross-chain link: a
    ///      bridged-resolution link (`localAssetOf`, which every bridged unwrap resolves through) is
    ///      set ONLY by the guest-proven attest_meta path (`_autoRegisterFromMeta`), which binds the
    ///      scale to the asset's REAL decimals from its Bitcoin etch — so no permissionless caller
    ///      can poison a bridged asset's scale or token. (A local asset carries no bridged value, so
    ///      its scale only round-trips its own wrap/unwrap, never inflating.)
    function registerMinted(address canonicalErc20, string calldata name_, string calldata symbol_, uint8 tacitDecimals)
        external
        nonReentrant
        returns (bytes32 assetId)
    {
        // The pool must be able to mint/burn this ERC20, else the asset can never exit.
        if (IMintBurn(canonicalErc20).MINTER() != address(this)) revert PoolNotMinter();
        if (tacitDecimals > ETH_DECIMALS) revert BadDecimals();
        if (IERC20Metadata(canonicalErc20).decimals() != ETH_DECIMALS) revert BadDecimals();
        uint256 unitScale = 10 ** uint256(ETH_DECIMALS - tacitDecimals);
        return _register(canonicalErc20, unitScale, bytes32(0), true, name_, symbol_, ETH_DECIMALS);
    }

    function _register(
        address underlying,
        uint256 unitScale,
        bytes32 crossChainLink,
        bool poolMinted,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) internal returns (bytes32 assetId) {
        // `underlying == address(0)` is the NATIVE ETH sentinel — valid only for an escrow asset
        // (a pool-minted asset must have a real canonical ERC20). Native ETH escrows msg.value on
        // wrap and pays out via forceSafeTransferETH on unwrap (same note machinery, ETH transport).
        if (underlying == address(0) && poolMinted) revert ZeroAddress();
        if (unitScale == 0) revert AmountNotAligned();
        // Escrow registrations (external ERC20s) must be a deployed, non-canonical token:
        // a canonical token of this pool registers only via the guest-proven minted path
        // (_autoRegisterFromMeta), and a not-yet-deployed canonical address must not be
        // claimable as escrow (which would pre-empt its later auto-registration). Native ETH
        // (address(0)) is exempt — it is not a contract and is the protocol's own escrow.
        if (!poolMinted && underlying != address(0)) {
            if (underlying.code.length == 0) revert NotAContract();
            try IMintBurn(underlying).MINTER() returns (address mtr) {
                if (mtr == address(this)) revert CanonicalAsset();
            } catch {}
            // Bound the escrow scale to the token's whole-unit scale (10^decimals). A larger scale makes
            // value = amount/unitScale round to 0 for realistic amounts, so a permissionless front-run
            // with a runaway scale (registration is first-write-wins, no de-register) would brick every
            // wrap of the token's confidential lane. Capping at the real on-chain decimals keeps any
            // front-registered scale usable (no permanent brick). The cap covers all decimals whose
            // 10^d is representable (10^77 < 2^256 < 10^78); a token reporting d > 77 (or no/ reverting
            // decimals(), the catch below) keeps the supplied scale — a narrow, unusual surface.
            try IERC20Metadata(underlying).decimals() returns (uint8 d) {
                if (d <= 77 && unitScale > 10 ** uint256(d)) revert BadDecimals();
            } catch {}
        }
        // Native ETH is 18-decimal; bound its escrow scale the same way (poolMinted+address(0) reverted above).
        if (underlying == address(0) && unitScale > 10 ** uint256(ETH_DECIMALS)) revert BadDecimals();
        assetId = _evmAssetId(underlying);
        if (_assets[assetId].registered) revert AlreadyRegistered();
        // A cross-chain link makes the asset's SHARED id resolve to this local entry on unwrap of a
        // bridged note (H-2). TWO backings may claim a Bitcoin id:
        //  - a POOL-MINTED asset whose canonical token COMMITS to the same id (ASSET_ID == link); or
        //  - NATIVE ETH (tETH = shielded ETH, ops/PLAN-teth-subsumption.md): the protocol's OWN escrow backs
        //    the bridged supply. There is no token to commit the id (address(0) is not a contract), so the
        //    ASSET_ID check can't authenticate the link; instead the native-ETH link is set ONLY from the
        //    constructor (TETH_BITCOIN_LINK) — registerWrapped rejects it — so it is fixed at deploy and
        //    consistent across generations, never a permissionless first-writer choice. A FOREIGN ERC20
        //    escrow + a link stays CrossChainEscrow (its backing the pool can't control). Soundness rests on
        //    the escrow==supply invariant: tETH is minted ONLY against an ETH wrap, and the contract is
        //    FAIL-CLOSED on escrow (a shortfall reverts an unwrap with InsufficientEscrow).
        if (crossChainLink != bytes32(0)) {
            if (underlying == address(0)) {
                // native ETH (tETH): reached only from the constructor (registerWrapped bars a native-ETH
                // link); the protocol's own escrow is the bridged backing, and there is no token to commit.
            } else if (!poolMinted) {
                revert CrossChainEscrow(); // a foreign ERC20 escrow cannot back bridged supply
            } else {
                try IAssetId(underlying).ASSET_ID() returns (bytes32 aid) {
                    if (aid != crossChainLink) revert CrossChainTokenMismatch();
                } catch {
                    revert CrossChainTokenMismatch();
                }
            }
            if (localAssetOf[crossChainLink] != bytes32(0)) revert CrossChainLinkTaken();
            localAssetOf[crossChainLink] = assetId;
        }
        _assets[assetId] = AssetStore({
            registered: true,
            underlying: underlying,
            unitScale: unitScale,
            crossChainLink: crossChainLink,
            poolMinted: poolMinted,
            decimals: decimals_
        });
        emit AssetRegistered(assetId, underlying, unitScale, name_, symbol_, decimals_);
    }

    function assets(bytes32 assetId)
        external
        view
        returns (
            bool registered,
            address underlying,
            uint256 unitScale,
            bytes32 crossChainLink,
            bool poolMinted,
            uint8 decimals
        )
    {
        AssetStore storage a = _assets[assetId];
        // name/symbol are not stored — read them from the AssetRegistered event.
        registered = a.registered;
        underlying = a.underlying;
        unitScale = a.unitScale;
        crossChainLink = a.crossChainLink;
        poolMinted = a.poolMinted;
        decimals = a.decimals;
    }

    // ──────────────────── Wrap (public deposit) ────────────────────

    /// @notice Escrow `amount` of the asset's underlying and record a pending deposit for a note
    ///         commitment. `commit` = keccak(Cx‖Cy‖owner) is a digest of the note's secp256k1
    ///         commitment coordinates and owner — only the digest reaches the chain, never the raw
    ///         coords. So a deposit note's ν = keccak(Cx‖Cy‖"spent") stays externally uncomputable
    ///         (its later spend is unlinkable, the standing of any in-pool note) and the static
    ///         owner can't cluster a wallet's deposits. The note is inserted into the tree only when
    ///         a proof consumes the deposit (the guest, which holds the coords + owner, reproduces
    ///         `commit` and verifies C opens to amount/unitScale). Amount is public at this boundary
    ///         (the underlying transfer reveals it); everything after is blinded.
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable nonReentrant {
        AssetStore storage a = _assets[assetId];
        if (!a.registered) revert NotRegistered();
        if (amount == 0 || amount % a.unitScale != 0) revert AmountNotAligned();

        // The note commits to the in-system value v = amount / unitScale. Bind the
        // deposit to v (not the underlying amount): the guest knows only v and proves
        // C opens to it, so a matching deposit id forces v·unitScale == amount —
        // the note can never claim more value than was escrowed (the wrap-side
        // no-inflation gate, since the guest cannot see unitScale).
        uint256 value = amount / a.unitScale;
        // The guest carries `value` as a u64 (and the BP+ range is < 2^64). A wrap whose
        // value exceeds u64 would bind a deposit id the guest can never reproduce (its
        // value wraps), so the deposit — and the escrowed amount — would be unconsumable.
        // Reject at the boundary instead of locking funds.
        _ckU64(value);
        // The guest reproduces this exact id from (assetId, value, keccak(Cx‖Cy‖owner)) — the coords
        // and owner it holds as witness — so the value binding holds without the contract ever seeing
        // them. Distinct hash from ν, so the published id (in Wrap) never yields a note's nullifier.
        bytes32 depositId = keccak256(abi.encode(assetId, value, commit));
        if (depositStatus[depositId] != 0) revert DepositExists();
        depositStatus[depositId] = 1;

        // ETH coverage: native ETH (underlying 0) must arrive as exactly msg.value; every token path
        // (pool-minted burn or external ERC20 escrow) forbids ETH. CEI: depositStatus is already set above,
        // before this move's external token call.
        if (a.underlying == address(0)) {
            if (msg.value != amount) revert EthValueMismatch();
        } else if (msg.value != 0) {
            revert EthValueMismatch();
        }
        _moveInUnderlying(a, assetId, amount);
        emit Wrap(depositId, assetId, amount);
    }

    /// @notice Create an EMPTY confidential AMM pool SLOT for a (canonical pair, fee tier) — lazy,
    ///         constant-product style. The pool holds NO reserves until the FIRST OP_LP_ADD funds it
    ///         from the founder's shielded notes (a settle that spends an A note + a B note), which sets
    ///         totalShares = isqrt(dA·dB) and mints the founder isqrt − MINIMUM_LIQUIDITY, permanently
    ///         locking MINIMUM_LIQUIDITY as a NOTELESS floor (reserves can never fully drain → the
    ///         (pair,fee) slot can't be bricked). poolId = keccak256(canonical(assetA, assetB), feeBps);
    ///         one slot per (pair, fee). Permissionless + front-run-proof: a front-run only registers the
    ///         empty slot — the first funder becomes the founder, so the pair is never lost. No funding
    ///         here: the first add's reserves are backed by the spent notes' existing escrow (the same
    ///         escrow that backs every circulating note), so escrow is touched only at the wrap boundary.
    function createPair(bytes32 assetA, bytes32 assetB, uint32 feeBps) external nonReentrant returns (bytes32 poolId) {
        poolId = _ensurePair(assetA, assetB, feeBps, true); // standalone: revert if the slot already exists
    }

    /// @notice Atomic create-and-seed (zAMM-style standard UX): lazy-create the (assetA, assetB, feeBps)
    ///         pool if it doesn't exist, then settle — so ONE tx founds the pool AND seeds its
    ///         reserves/ratio/depth from the OP_LP_ADD carried in `publicValues`. A no-op create if the
    ///         slot is already initialized (the existing pool is reused, not reverted). EITHER side may be
    ///         native ETH (tETH) — the native-ETH asset id is a normal registered asset id here, so a
    ///         tETH/TOKEN pool is created + seeded atomically with no special-casing.
    ///         SECURITY — asset-id ordering + binding: `_ensurePair` stores the CANONICAL (sorted) pair, so
    ///         the created `poolId` is order-independent (createPairAndSettle(A,B,..) ≡ (B,A,..)) and equals
    ///         the guest's `pool_id(canonical(assetA,assetB), feeBps)`. The lp_add's committed
    ///         `LpSettlement.poolId` must hit an INITIALIZED slot in `_settle` (PoolNotInit), so a caller
    ///         that passes assets NOT matching the proof's notes just creates an unrelated empty slot and
    ///         the settle reverts — the (assetA,assetB) args can never rebind the proof to the wrong pool.
    function createPairAndSettle(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos
    ) external nonReentrant {
        _ensurePair(assetA, assetB, feeBps, false); // idempotent: reuse the slot if it already exists
        _settle(publicValues, proofBytes, memos);
    }

    /// @dev Validate + (idempotently) initialize a confidential AMM pool slot. `revertIfExists` selects the
    ///      standalone createPair semantics (revert PoolExists) vs the atomic create-and-seed path (reuse
    ///      an existing slot). The poolId + stored pool are CANONICAL (assets sorted) and FEE-BOUND,
    ///      mirroring the guest's pool_id and the Bitcoin AMM: (A,B) ≡ (B,A) is one pool, each fee a
    ///      DISTINCT pool. Permissionless + front-run-proof: a front-run only registers the empty slot —
    ///      the first funder (the first OP_LP_ADD) sets the reserves/ratio, so the pair is never lost.
    function _ensurePair(bytes32 assetA, bytes32 assetB, uint32 feeBps, bool revertIfExists)
        internal
        returns (bytes32 poolId)
    {
        if (assetA == assetB) revert SameAsset();
        if (!_assets[assetA].registered || !_assets[assetB].registered) revert NotRegistered();
        if (feeBps > MAX_POOL_FEE_BPS) revert FeeTooHigh();
        bytes32 lo;
        bytes32 hi;
        (poolId, lo, hi) = _poolIdFor(assetA, assetB, feeBps);
        if (pools[poolId].init) {
            if (revertIfExists) revert PoolExists();
            return poolId; // atomic create-and-seed: the slot already exists, reuse it
        }
        pools[poolId] =
            Pool({init: true, assetA: lo, assetB: hi, reserveA: 0, reserveB: 0, feeBps: feeBps, totalShares: 0});
    }

    function _poolId(bytes32 lo, bytes32 hi, uint32 feeBps) internal pure returns (bytes32 poolId) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, lo)
            mstore(add(m, 0x20), hi)
            mstore(add(m, 0x40), and(feeBps, 0xffffffff))
            poolId := keccak256(m, 0x60)
        }
    }

    /// @dev Canonical poolId + the sorted (lo, hi) asset ids for a pair — the shared sort every public-AMM
    ///      entrypoint (+ _ensurePair) needs, so (A,B) ≡ (B,A) maps to one pool in exactly one place.
    function _poolIdFor(bytes32 x, bytes32 y, uint32 feeBps)
        internal
        pure
        returns (bytes32 poolId, bytes32 lo, bytes32 hi)
    {
        (lo, hi) = x < y ? (x, y) : (y, x);
        poolId = _poolId(lo, hi, feeBps);
    }

    // ──────────────────── Public (non-shielded) AMM periphery ────────────────────
    // Public ERC20/ETH ⇄ public AMM, no proof — the surface a zRouter-style periphery composes for users
    // who want standard AMM UX (add/remove/swap) against the pool's PUBLIC reserves. Founding/adding
    // liquidity is public at the wrap boundary anyway, so no settle proof is needed; only HIDING a position
    // or amount needs the confidential (note + proof) path. Both forms share pools[poolId] (reserves +
    // totalShares) + escrow, so a confidential op reading the reserves/total stays correct.

    /// @dev Integer sqrt (Babylonian) for the first-mint share = isqrt(valueA·valueB).
    ///      The public add path rejects zero input amounts before calling this helper.
    function _isqrt(uint256 x) internal pure returns (uint256 y) {
        // Called only with u64·u64 ≤ 2^128, so x+1 and x/z+z never overflow.
        unchecked {
            uint256 z = (x + 1) / 2;
            y = x;
            while (z < y) {
                y = z;
                z = (x / z + z) / 2;
            }
        }
    }

    /// @dev Ceil division for the in-ratio liquidity add: charging the CEIL reserve required for the chosen
    ///      shares (vs floor) keeps an add from minting shares for slightly-less-than-pro-rata reserves, so
    ///      the rounding favors existing LPs (matching swap/remove). Always ≤ the leg's deposited value
    ///      (sharesMinted ≤ floor(v·totalShares/reserve) ⇒ sharesMinted·reserve/totalShares ≤ v), so the
    ///      refund stays ≥ 0.
    function _ceilDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            return (x + y - 1) / y;
        }
    }

    /// @dev Reject a value the note model can't carry (the BP+ range is < 2^64); shared by every boundary that
    ///      re-bounds a guest-carried u64 to its range.
    function _ckU64(uint256 v) internal pure {
        if (v > type(uint64).max) revert ValueOutOfRange();
    }

    /// @dev Move `amount` of the asset IN to the pool's custody: burn the canonical ERC20 (pool-minted),
    ///      escrow native ETH, or escrow an external ERC20 with a realized-delta (fee-on-transfer) guard.
    ///      Shared by `wrap` and `_ingestPublic`. msg.value coverage is the CALLER's responsibility — `wrap`
    ///      checks it per-asset; the public-AMM callers aggregate it across both legs.
    function _moveInUnderlying(AssetStore storage a, bytes32 assetId, uint256 amount) internal {
        if (a.poolMinted) {
            // Tacit-recorded asset: burn the canonical ERC20 (re-entering confidential).
            IMintBurn(a.underlying).burn(msg.sender, amount);
        } else if (a.underlying == address(0)) {
            escrow[assetId] += amount; // native ETH — caller verified msg.value covers it
        } else {
            // External ERC20: measure the realized balance delta and require it to equal `amount`. A
            // fee-on-transfer / deflationary token delivers less; crediting the full amount would over-state
            // escrow and short the LAST withdrawer of this asset. Reject it at the boundary instead.
            uint256 balBefore = SafeTransferLib.balanceOf(a.underlying, address(this));
            SafeTransferLib.safeTransferFrom(a.underlying, msg.sender, address(this), amount);
            if (SafeTransferLib.balanceOf(a.underlying, address(this)) - balBefore != amount) {
                revert FeeOnTransferUnsupported();
            }
            escrow[assetId] += amount;
        }
    }

    /// @dev Escrow a PUBLIC deposit of `amount` of `assetId` and return the in-system value (amount/unitScale).
    ///      Native-ETH msg.value coverage is checked by the caller (it knows which legs are ETH).
    function _ingestPublic(bytes32 assetId, uint256 amount) internal returns (uint256 value) {
        AssetStore storage a = _assets[assetId];
        if (!a.registered) revert NotRegistered();
        if (amount == 0 || amount % a.unitScale != 0) revert AmountNotAligned();
        value = amount / a.unitScale;
        _ckU64(value);
        _moveInUnderlying(a, assetId, amount);
    }

    /// @notice Atomic create-and-seed from PUBLIC funds (zAMM-style): lazy-create the pool, escrow public
    ///         `amountA`/`amountB` (ERC20 and/or native ETH via msg.value — EITHER side may be tETH), set
    ///         reserves, and credit public LP shares to `to`. First add → totalShares = isqrt(vA·vB) with
    ///         MINIMUM_LIQUIDITY locked (noteless floor); later add → proportional (limiting-leg min rule),
    ///         with the off-ratio excess of the other leg refunded to the caller (never donated to the pool).
    ///         One tx, no proof. `assetA`/`assetB` may be in any order; the pool is canonical, so reserves
    ///         line up with the stored low→high mapping.
    function createPairAndAddLiquidityPublic(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 amountA,
        uint256 amountB,
        uint256 minSharesOut,
        uint64 deadline,
        address to
    ) external payable nonReentrant returns (uint256 sharesMinted) {
        if (deadline != 0 && block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert ZeroAddress();
        bytes32 poolId = _ensurePair(assetA, assetB, feeBps, false);
        Pool storage p = pools[poolId];
        // Canonical orientation: reserveA is the LOW asset's reserve. Map the caller's (asset,amount) pairs.
        (bytes32 assetLo, bytes32 assetHi, uint256 amtLo, uint256 amtHi) =
            assetA < assetB ? (assetA, assetB, amountA, amountB) : (assetB, assetA, amountB, amountA);
        // ETH coverage: at most one leg is native ETH; msg.value must equal that leg's amount (0 if none).
        uint256 expectedEth = (_assets[assetLo].underlying == address(0) ? amtLo : 0)
            + (_assets[assetHi].underlying == address(0) ? amtHi : 0);
        if (msg.value != expectedEth) revert EthValueMismatch();
        uint256 vLo = _ingestPublic(assetLo, amtLo);
        uint256 vHi = _ingestPublic(assetHi, amtHi);
        if (p.totalShares != 0) {
            uint256 sA = (vLo * p.totalShares) / p.reserveA;
            uint256 sB = (vHi * p.totalShares) / p.reserveB;
            sharesMinted = sA < sB ? sA : sB;
            if (sharesMinted == 0) revert InsufficientLiquidity();
            if (sharesMinted < minSharesOut) revert SlippageExceeded(); // shares slippage (price moved before inclusion)
            // Charge the CEIL reserve required for the minted shares and refund the excess leg (CEI-last):
            // ceil (not floor) keeps the add from minting shares for under-pro-rata reserves, so the rounding
            // favors existing LPs (the swap/remove direction); it is always ≤ vLo/vHi, so the refund stays ≥ 0.
            uint256 addLo = _ceilDiv(sharesMinted * p.reserveA, p.totalShares);
            uint256 addHi = _ceilDiv(sharesMinted * p.reserveB, p.totalShares);
            p.reserveA += addLo;
            p.reserveB += addHi;
            p.totalShares += sharesMinted;
            lpShares[poolId][to] += sharesMinted;
            // Only the ACCUMULATING add can exceed u64; the first add below is vLo/vHi ≤ u64 (the
            // _ingestPublic gate) with minted = isqrt(vLo·vHi) ≤ 2^64 by construction.
            if (p.reserveA > type(uint64).max || p.reserveB > type(uint64).max || p.totalShares > type(uint64).max) {
                revert ValueOutOfRange();
            }
            if (vLo > addLo) _payout(assetLo, msg.sender, vLo - addLo);
            if (vHi > addHi) _payout(assetHi, msg.sender, vHi - addHi);
            return sharesMinted;
        }
        uint256 minted = _isqrt(vLo * vHi);
        if (minted <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
        p.reserveA = vLo;
        p.reserveB = vHi;
        p.totalShares = minted;
        sharesMinted = minted - MINIMUM_LIQUIDITY; // MINIMUM_LIQUIDITY is the permanent noteless floor
        if (sharesMinted < minSharesOut) revert SlippageExceeded(); // shares slippage on the first add too
        lpShares[poolId][to] += sharesMinted;
    }

    /// @notice Burn PUBLIC LP shares and withdraw the proportional reserves to `to` (public ERC20/ETH out).
    ///         Can never remove the locked MINIMUM_LIQUIDITY. Confidential (note) shares are untouched — a
    ///         caller can only burn their own `lpShares` balance.
    function removeLiquidityPublic(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 shares,
        uint256 minAmountA,
        uint256 minAmountB,
        uint64 deadline,
        address to
    ) external nonReentrant returns (uint256 amountLo, uint256 amountHi) {
        if (deadline != 0 && block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert ZeroAddress();
        (bytes32 poolId, bytes32 lo, bytes32 hi) = _poolIdFor(assetA, assetB, feeBps);
        Pool storage p = pools[poolId];
        if (!p.init) revert PoolNotInit();
        uint256 bal = lpShares[poolId][msg.sender];
        if (shares == 0 || shares > bal) revert InsufficientLiquidity();
        uint256 vLo;
        uint256 vHi;
        // shares ≤ bal ≤ u64 and u64 reserves keep the products in u256. The floor guard is written as an
        // addition (shares + MINIMUM_LIQUIDITY > totalShares), NOT totalShares − shares, so it can't underflow
        // and itself proves shares < totalShares — making every subtraction below non-negative (and vLo/vHi ≤
        // their reserve) even if a prior settle mis-set totalShares.
        unchecked {
            if (shares + MINIMUM_LIQUIDITY > p.totalShares) revert InsufficientLiquidity();
            vLo = p.reserveA * shares / p.totalShares;
            vHi = p.reserveB * shares / p.totalShares;
            lpShares[poolId][msg.sender] = bal - shares;
            p.totalShares -= shares;
            p.reserveA -= vLo;
            p.reserveB -= vHi;
        }
        amountLo = _payout(lo, to, vLo);
        amountHi = _payout(hi, to, vHi);
        // Output slippage in the caller's (assetA, assetB) orientation, mapped to canonical lo/hi.
        (uint256 minLo, uint256 minHi) = assetA < assetB ? (minAmountA, minAmountB) : (minAmountB, minAmountA);
        if (amountLo < minLo || amountHi < minHi) revert SlippageExceeded();
    }

    /// @notice PUBLIC swap against the pool's public reserves (no privacy — the amount is revealed; for a
    ///         hidden-amount swap use the confidential OP_SWAP). Constant-product with the pool fee; k can
    ///         only increase. `minAmountOut` is in the OUTPUT asset's underlying units (slippage bound);
    ///         `deadline` is a unix-secs expiry (0 = none) so a pending tx can't execute much later.
    function swapPublic(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (deadline != 0 && block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert ZeroAddress();
        if (assetIn == assetOut) revert SameAsset();
        (bytes32 poolId, bytes32 lo,) = _poolIdFor(assetIn, assetOut, feeBps);
        Pool storage p = pools[poolId];
        if (!p.init) revert PoolNotInit();
        uint256 expectedEth = _assets[assetIn].underlying == address(0) ? amountIn : 0;
        if (msg.value != expectedEth) revert EthValueMismatch();
        uint256 vIn = _ingestPublic(assetIn, amountIn);
        bool inIsLo = assetIn == lo;
        uint256 reserveIn = inIsLo ? p.reserveA : p.reserveB;
        uint256 reserveOut = inIsLo ? p.reserveB : p.reserveA;
        uint256 vOut;
        // u64-bounded reserves + fee ≤ MAX_POOL_FEE_BPS ⇒ products fit u256, γ-sub can't underflow, and
        // vOut < reserveOut is enforced before the reserve subtraction — so unchecked is safe.
        unchecked {
            uint256 kPre = p.reserveA * p.reserveB;
            // out = floor(reserveOut · vIn · γ / (reserveIn · 10000 + vIn · γ)), γ = 10000 − feeBps
            uint256 vInG = vIn * (10000 - uint256(p.feeBps));
            vOut = (reserveOut * vInG) / (reserveIn * 10000 + vInG);
            if (vOut == 0 || vOut >= reserveOut) revert InsufficientLiquidity();
            if (inIsLo) {
                p.reserveA += vIn;
                p.reserveB -= vOut;
            } else {
                p.reserveB += vIn;
                p.reserveA -= vOut;
            }
            if (p.reserveA * p.reserveB < kPre) revert ConstantProductDecreased(); // k non-decrease (mirrors settle)
        }
        _ckU64(p.reserveA);
        _ckU64(p.reserveB);
        amountOut = _payout(assetOut, to, vOut);
        if (amountOut < minAmountOut) revert SlippageExceeded();
    }

    /// @dev The pool-specific LP-share asset id = keccak(poolId‖"lp") — the SAME derivation the guest's
    ///      lp_share_id + the dapp's lpShareId use, so an OP_WRAP that mints the share note and the
    ///      OP_LP_REMOVE that spends it agree on the leaf's asset.
    function _lpShareId(bytes32 poolId) internal pure returns (bytes32 id) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, poolId)
            mstore(add(m, 0x20), shl(240, 0x6c70))
            id := keccak256(m, 0x22)
        }
    }

    /// @notice Opt-in privacy for an LP position: convert PUBLIC LP shares into a confidential LP-share
    ///         NOTE. Burns `shares` of the caller's public `lpShares` and records a pending deposit that the
    ///         EXISTING OP_WRAP settle consumes into a share note (commitment `commit` = keccak(Cx‖Cy‖owner),
    ///         exactly like wrap; the guest verifies the note opens to `shares` on consume — the amount
    ///         binding, so no on-chain EC + no new guest op). `pools[poolId].totalShares` is UNCHANGED — the
    ///         position only changes FORM (public ledger → hidden note), so reserves still back it and a
    ///         later confidential OP_LP_REMOVE withdraws the proportional amount. The minted share note is
    ///         spendable ONLY via OP_LP_REMOVE (its asset = lp_share_id, which is unregistered, so an
    ///         OP_UNWRAP of it reverts NotRegistered — it can't be drained as a plain asset).
    function shieldShares(bytes32 poolId, uint256 shares, bytes32 commit)
        external
        nonReentrant
        returns (bytes32 depositId)
    {
        if (!pools[poolId].init) revert PoolNotInit();
        uint256 bal = lpShares[poolId][msg.sender];
        if (shares == 0 || shares > bal) revert InsufficientLiquidity();
        _ckU64(shares); // the guest carries the note value as u64
        lpShares[poolId][msg.sender] = bal - shares; // burn public; totalShares unchanged (form change)
        depositId = keccak256(abi.encode(_lpShareId(poolId), shares, commit));
        if (depositStatus[depositId] != 0) revert DepositExists();
        depositStatus[depositId] = 1;
    }

    // ──────────────────── Farm escrow treasury (ops/PLAN-evm-farm-rewards.md) ────────────────────

    /// @notice Fund OR wind down a farm's escrow treasury (one entrypoint to share the dispatch + guard).
    ///         `amount > 0` FUNDS: the funder (msg.sender) deposits `amount` of an escrow-backed reward asset's
    ///         underlying into escrow, credited to `controller`'s budget with NO note — so the value backs the
    ///         controller's later harvest reward notes (the _settle harvest bound debits this budget). Pinned to
    ///         one reward asset on first fund (a pool-minted or native asset is rejected — those are mint-mode).
    ///         `amount == 0` RECOVERS: the controller (msg.sender) reclaims its full remaining budget (funded −
    ///         distributed) to `to` — exactly the escrow not backing outstanding reward notes, so it can never
    ///         reach another farm's backing. The FarmController calls this from `recover` after its period + grace.
    function farmEscrow(address controller, bytes32 rewardAsset, uint256 amount, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (amount == 0) {
            if (farmRewardAsset[msg.sender] != rewardAsset) revert NotRegistered();
            out = farmTreasury[msg.sender];
            farmTreasury[msg.sender] = 0;
            _payout(rewardAsset, to, out);
        } else {
            bytes32 pinned = farmRewardAsset[controller];
            if (pinned == bytes32(0)) {
                AssetStore storage a = _assets[rewardAsset];
                if (a.poolMinted || a.underlying == address(0)) revert NotRegistered();
                farmRewardAsset[controller] = rewardAsset;
            } else if (pinned != rewardAsset) {
                revert NotRegistered();
            }
            out = _ingestPublic(rewardAsset, amount);
            farmTreasury[controller] += out;
        }
    }

    // ──────────────────── Bitcoin state attestation (relay-proven, no oracle) ────────────────────

    /// Bitcoin state proven by the reflection prover (re-derived from relayed headers + the
    /// folded confirmed pool effects in SP1) — the trustless input to the bridge_mint root
    /// gate and the cross-lane spent-set. Field order matches the prover's commitment.
    // A self-custody cBTC.zk lock newly tracked this batch (mirrors the reflection guest's CbtcLockFolded).
    // attestBitcoinStateProven records cbtcLock{vBtc,commitment}[outpoint] so a later OP_CBTC_MINT can mint
    // the pre-committed cBTC note 1:1 against the lock, gated on a native-ETH escrow.
    struct CbtcLockFolded {
        bytes32 outpoint;
        uint256 vBtc;
        bytes32 commitment;
    }

    struct BitcoinRelayPublicValues {
        bytes32 priorDigest; // the reflected state this proof CONTINUES (== knownReflectionDigest)
        bytes32 bitcoinPoolRoot; // the Bitcoin confidential-pool note-tree root
        bytes32 bitcoinSpentRoot; // the Bitcoin spent-nullifier IMT root at this height
        bytes32 bitcoinBurnRoot; // the Bitcoin bridge-burn IMT root at this height (bridge_mint authority)
        uint64 bitcoinHeight; // the confirmed Bitcoin height the batch advanced to
        bytes32 newDigest; // the reflected state AFTER this proof (the next cycle's prior)
        bytes32 bitcoinPrevHash; // headers[0]'s prev field — anchored to the prior attested tip
        bytes32 bitcoinTipHash; // the batch's tip block hash — anchored to a matured ancestor of RELAY.tip()
        bytes32 ethPoolReflected; // Mode B: the eth-reflection's ethPool (gated == address(this) below)
        uint256 cbtcBackingSats; // cBTC: Σ live self-custody cBTC.zk lock sats (the off-pool buffer reads it)
        CbtcLockFolded[] cbtcLocksFolded; // locks newly tracked this batch → cbtcLock[] (the OP_CBTC_MINT gate)
        bytes32[] cbtcLocksSpent; // tracked locks spent this batch → cbtcLockSpent[] (the engine slashes if not redeemed)
        uint64 consumedCount; // fast-lane freshness: eth-consumed ν folded into the spent set; gated == bitcoinConsumedCount
        AssetMeta[] attestedAssetMetas; // etch-authenticated (asset_id,ticker,decimals,cid) → lazy-register canonical ERC20
        bytes32[] btcCallsFolded; // value-free Bitcoin-authorized calls, flat (callId, recordHash) pairs → pendingBtcCall[]
    }

    /// @notice Attest Bitcoin confidential-pool state via an SP1 relay proof — the ONLY
    ///         attestation path (no trusted oracle). Verifies the proof against
    ///         `BITCOIN_RELAY_VKEY`, then marks the proven pool root canonical (so a
    ///         bridge_mint can prove membership against it) and advances the reflected
    ///         spent-set root (the cross-lane non-membership freshness root). The height
    ///         must not decrease (equal heights are valid — a batch may fold several effects
    ///         from one block; only a rollback is rejected), so a stale proof can't roll the
    ///         spent set back.
    function attestBitcoinStateProven(bytes calldata publicValues, bytes calldata proofBytes) external nonReentrant {
        SP1_VERIFIER.verifyProof(BITCOIN_RELAY_VKEY, publicValues, proofBytes);
        BitcoinRelayPublicValues memory r = abi.decode(publicValues, (BitcoinRelayPublicValues));
        // Mode B: when this batch folds a crossOut, the eth-reflection proved crossOutCommitment storage
        // for `ethPoolReflected`; it MUST be THIS pool, else another pool's crossOuts could fold here
        // (cross-lane inflation). The contract knows its own address, so this gate breaks the pool↔vkey
        // circularity with no in-guest pool pin. A FORWARD-ONLY batch (burn-deposit / cmint / CXFER scan)
        // folds no crossOut and skips the eth-reflection recursion entirely; the guest commits the zero
        // sentinel (mode_b == 0 ⇒ crossout_set_root == 0 ⇒ every fold_crossout fails membership, so no
        // unverified crossOut can enter), and we accept it here. So either it reflects THIS pool's eth
        // state, or it attested none — never another pool's.
        address ethPool = address(uint160(uint256(r.ethPoolReflected)));
        if (ethPool != address(this) && ethPool != address(0)) revert WrongEthPool();
        // Chain: this cycle must CONTINUE the current attested reflection state (the prover
        // resumed from it), then it becomes the new state. So the reflected roots evolve as
        // one append-only chain — a proof can't fork off a stale state or restart from genesis
        // mid-stream. knownReflectionDigest is seeded to the prover's genesis digest, so the
        // first cycle continues genesis. A zero newDigest is never a valid reflected state.
        if (r.priorDigest != knownReflectionDigest) revert StaleReflectionDigest();
        if (r.newDigest == bytes32(0)) revert StaleReflectionDigest();
        // Height is non-decreasing (a batch may fold several effects from the same block, so
        // equal heights are valid; only a rollback is rejected — the digest chain bars replay).
        if (r.bitcoinHeight < lastRelayHeight) revert StaleRelayProof();
        // The reflected spent set is an IMT whose empty form has a NON-ZERO sentinel
        // root; a zero spent root would re-open the cross-lane gate's bypass (the guest
        // skips non-membership when the root is 0), so never accept it as canonical.
        if (r.bitcoinSpentRoot == bytes32(0)) revert StaleBitcoinSpentRoot();
        // Same non-zero-sentinel rule for the bridge-burn set: a zero would let a
        // bridge_mint skip its membership check (the guest keys it off `burn_root != 0`).
        if (r.bitcoinBurnRoot == bytes32(0)) revert StaleBitcoinBurnRoot();
        // The pool root authorizes bridge_mint membership (settle's bitcoinRootsUsed gate keys off
        // knownBitcoinRoot); a zero root would mark an empty tree canonical, so reject it too —
        // matching the spent/burn-root sentinels above.
        if (r.bitcoinPoolRoot == bytes32(0)) revert ZeroBitcoinPoolRoot();
        // FAST-LANE FRESHNESS: the reflection must have folded EVERY recorded fast-lane consume before it
        // may advance the spent set. The eth-reflection guest already ties its `consumedCount` to
        // `bitcoinConsumedCount` at its FINALIZED Ethereum slot; this gate ties it to NOW — so the proof's
        // finalized slot is forced recent enough to cover every consume. Without it a worker could attest a
        // racing Bitcoin spend of a note already fast-spent on Ethereum (its source still live) and
        // double-credit it. A consume landing between the proof's finalized slot and this tx makes the attest
        // revert; the worker re-attests with a fresher eth proof (a liveness retry, never a safety gap). Once
        // any consume exists, a forward-only (mode_b==0, consumedCount-unchanged) batch can no longer advance
        // the spent set — exactly the intended Ethereum-senior ordering.
        if (r.consumedCount != bitcoinConsumedCount) revert ConsumedCountStale();
        // Relay anchor (mirror SP1PoolRootVerifier): pin the batch's prev to the prior attested tip
        // and its tip to a MATURED ancestor of the canonical relay tip (≥ REFLECTION_CONFIRMATIONS deep,
        // each within the finality window). With the guest's verify_header_chain linking the batch back
        // via prev_hash + PoW, this forces the WHOLE proven chain to be canonical Bitcoin and buries
        // every folded effect that many confirmations. Skipped only when no relay is wired (reflection
        // inactive; the ctor bars a non-zero BITCOIN_RELAY_VKEY without a relay).
        if (address(HEADER_RELAY) != address(0)) {
            _anchorReflection(r.bitcoinPrevHash, r.bitcoinTipHash);
            lastReflectionBlockHash = r.bitcoinTipHash;
        }
        lastRelayHeight = r.bitcoinHeight;
        knownBitcoinRoot[r.bitcoinPoolRoot] = true;
        knownBitcoinSpentRoot = r.bitcoinSpentRoot;
        knownBitcoinBurnRoot = r.bitcoinBurnRoot;
        knownReflectionDigest = r.newDigest;
        cbtcBackingSats = r.cbtcBackingSats; // cBTC backing advances with the reflected state
        // cBTC per-lock registry (ops/DESIGN-confidential-defi-v1.md §3): record each newly-tracked lock so
        // a later OP_CBTC_MINT can mint the pre-committed note against it (gated on the CollateralEngine
        // escrow), and flag each spent lock so the engine can slash an un-redeemed rug. Proven arrays — the
        // same trust as cbtcBackingSats, just per-lock. The guest binds (outpoint, vBtc, commitment); vBtc is
        // a real u64 lock value (parse_tx_output) so the downcast is exact.
        for (uint256 i; i < r.cbtcLocksFolded.length; ++i) {
            CbtcLockFolded memory f = r.cbtcLocksFolded[i];
            if (f.vBtc == 0 || f.vBtc > type(uint64).max) revert ValueOutOfRange();
            cbtcLockVBtc[f.outpoint] = uint64(f.vBtc);
            cbtcLockCommitment[f.outpoint] = f.commitment;
        }
        for (uint256 i; i < r.cbtcLocksSpent.length; ++i) {
            cbtcLockSpent[r.cbtcLocksSpent[i]] = true;
        }
        // Trustless metadata: lazy-register the canonical ERC20 for each asset whose etch the reflection
        // authenticated (BIP141 witness commitment + canonical provenance header chain, proven by this SP1
        // proof). Idempotent — _autoRegisterFromMeta skips an already-registered asset — so a re-attested
        // meta is a no-op. This replaces the settle-side OP_ATTEST_META: the anchor the settle guest lacked
        // (no relay) already exists here, for an etch of any age.
        for (uint256 i; i < r.attestedAssetMetas.length; ++i) {
            _autoRegisterFromMeta(r.attestedAssetMetas[i]);
        }
        // Record each value-free Bitcoin-authorized call; BtcCallExecutor fires it (never inline — a hostile
        // target must not be able to revert this attest). Re-attesting a fired call is harmless (the executor
        // gates one-shot on its own `fired` set), so no spent-flag is kept here.
        bytes32[] memory calls = r.btcCallsFolded;
        for (uint256 i; i + 1 < calls.length; i += 2) {
            pendingBtcCall[calls[i]] = calls[i + 1];
        }
    }

    /// Anchor a reflection batch to canonical Bitcoin: `prev` must equal the prior attested tip or a
    /// recent ancestor of it (a sub-window reorg), and `tip` must equal the MATURED anchor — RELAY.tip()
    /// walked back REFLECTION_CONFIRMATIONS — or a recent ancestor of it (the relay's tip may have advanced
    /// past the proven batch). The ancestor walks follow the relay's stored parents,
    /// ≤ REFLECTION_CONFIRMATIONS + REFLECTION_FINALITY_WINDOW hops. Mirrors SP1PoolRootVerifier.
    function _anchorReflection(bytes32 prev, bytes32 tip) internal view {
        if (!_isTipOrRecentAncestor(prev, lastReflectionBlockHash)) revert UnanchoredReflection();
        // Maturity: anchor the batch's tip to the relay tip walked back REFLECTION_CONFIRMATIONS — NOT
        // the relay tip itself — so the tip (and every block this batch folded, all at or below it) is
        // buried at least that many confirmations. A burn folded into the bridge-burn set is then ≥
        // REFLECTION_CONFIRMATIONS deep before any bridge_mint can act on it, so a shallow tip reorg
        // cannot strand a mint (the burned note re-living on Bitcoin while the Ethereum mint stands).
        // `tip` must be that matured anchor or a recent ancestor (the relay may have advanced since the
        // batch was proven — REFLECTION_FINALITY_WINDOW absorbs that). Near genesis the relay isn't yet
        // that deep, so the walk hits 0 and the anchor reverts (reflection simply starts once the relay
        // matures — fail-closed, the same shape as the zero-genesis ctor guard).
        bytes32 matured = HEADER_RELAY.tip();
        for (uint256 i; i < REFLECTION_CONFIRMATIONS; ++i) {
            if (matured == bytes32(0)) revert UnanchoredReflection();
            matured = HEADER_RELAY.blockParent(matured);
        }
        if (!_isTipOrRecentAncestor(tip, matured)) revert UnanchoredReflection();
    }

    /// True iff `h == anchor` or `h` is within REFLECTION_FINALITY_WINDOW parents of `anchor`.
    function _isTipOrRecentAncestor(bytes32 h, bytes32 anchor) internal view returns (bool) {
        if (h == bytes32(0)) return false;
        if (h == anchor) return true;
        bytes32 walk = anchor;
        for (uint256 i; i < REFLECTION_FINALITY_WINDOW; ++i) {
            walk = HEADER_RELAY.blockParent(walk);
            if (walk == bytes32(0)) return false;
            if (walk == h) return true;
        }
        return false;
    }

    // ──────────────────── Settle (the one proof entrypoint) ────────────────────

    /// @notice Verify one SP1 proof and apply its effects: mark nullifiers, append
    ///         leaves, consume deposits, pay withdrawals and settler fees. Fees go
    ///         to msg.sender (the settler); self-prove sets no fees and pays only
    ///         gas. All amount/conservation/range checking happened in the guest.
    /// @param memos one encrypted note memo per inserted leaf (same order as
    ///        `pv.leaves`), data-availability only — unverified, owner-decryptable
    ///        for seed-only recovery. Emitted in `LeavesInserted`.
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos)
        external
        nonReentrant
    {
        _settle(publicValues, proofBytes, memos);
    }

    /// @dev The settle body, shared by the standalone `settle` and the atomic `createPairAndSettle`
    ///      (which lazy-creates the pool first). Internal so the create-and-seed wrapper reuses it under
    ///      one reentrancy guard — `settle` is `nonReentrant`, so `this.settle()` from a wrapper would
    ///      self-revert; the shared internal avoids that.
    function _settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) internal {
        SP1_VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proofBytes);
        PublicValues memory pv = abi.decode(publicValues, (PublicValues));

        if (pv.version != PV_VERSION) revert BadVersion();
        if (pv.chainBinding != CHAIN_BINDING) revert ChainMismatch();
        // Expired: a proof carrying a deadline can't be relayed past it (0 = no expiry). The guest commits
        // the earliest op deadline + binds it in each trader's sigma, so the box can't alter or sit on it.
        if (pv.deadline != 0 && block.timestamp > pv.deadline) revert Expired();
        // Adaptor REFUND is the strict mirror of the deadline ≤ gate above: a refund of a locked note may
        // settle only STRICTLY AFTER the lock's deadline (the guest commits the latest refund deadline in the
        // batch; 0 = no refund here). CLAIM is gated settle-at-or-before-deadline (≤), so making refund
        // settle-strictly-after (>, not ≥) leaves the two windows DISJOINT — at the exact deadline instant only
        // a claim passes, so there is no shared boundary second where both a claim and a refund of the same
        // lock would settle. Spend-once already bars double-execution; this removes the boundary ambiguity.
        if (pv.refundNotBefore != 0 && block.timestamp <= pv.refundNotBefore) revert RefundTooEarly();
        // Membership may be proven against an Ethereum root OR a reflected Bitcoin confidential-pool root
        // (cross-lane: a Bitcoin-homed note spent on the Ethereum fast lane). The Ethereum root is this
        // pool's own tree; the Bitcoin root is relay-attested (no trusted oracle). Resolve the home lane in
        // ONE read of each set: a known Ethereum root ⇒ EVM-homed; else a known relay-attested Bitcoin root
        // ⇒ btcHomed; else neither is known ⇒ UnknownRoot. spendRoot == 0 is a no-input batch (neither homed).
        bool btcHomed;
        if (pv.spendRoot != bytes32(0)) {
            if (everKnownRoot[pv.spendRoot]) {
                // Ethereum-homed: this pool's own note tree.
            } else if (knownBitcoinRoot[pv.spendRoot]) {
                btcHomed = true;
            } else {
                revert UnknownRoot();
            }
        }
        // Cross-lane non-membership (cross-lane): if the guest proved each
        // spent ν absent from the Bitcoin spent set, it must be against the CURRENT
        // reflected root — a stale root could omit a recent Bitcoin spend.
        if (pv.bitcoinSpentRoot != bytes32(0) && pv.bitcoinSpentRoot != knownBitcoinSpentRoot) {
            revert StaleBitcoinSpentRoot();
        }
        // Cross-lane non-membership is MANDATORY for a Bitcoin-homed spend (membership
        // proven against a relay-attested Bitcoin pool root, not an Ethereum root):
        // it must pin the CURRENT Bitcoin spent-set root, so a proof can't skip the
        // gate by committing a zero/omitted bitcoinSpentRoot and re-spend on Ethereum a
        // note already spent on Bitcoin. Ethereum-homed spends carry no Bitcoin history.
        // Fail closed: a Bitcoin-homed spend MUST pin the CURRENT, NON-ZERO reflected
        // spent-set root. A zero root means the cross-lane set is uninitialized (or a
        // relay reflected an empty set as 0) — allowing it would let the guest skip its
        // non-membership check (the guest keys it off `bitcoin_spent_root != 0`) and
        // re-spend on Ethereum a note already spent on Bitcoin. The reflection prover
        // seeds a non-zero empty-IMT sentinel, so a legitimate spent root is never 0.
        if (btcHomed && (pv.bitcoinSpentRoot == bytes32(0) || pv.bitcoinSpentRoot != knownBitcoinSpentRoot)) {
            revert StaleBitcoinSpentRoot();
        }
        // A bridge_burn (crossOut) emits an authoritative, one-per-claimId instruction to MINT a
        // note on Bitcoin, while the spent input is nullified ONLY in the Ethereum set. The reflection
        // prover reflects Bitcoin spends → Ethereum, never the reverse, so an Ethereum nullification is
        // never seen on Bitcoin. If the burned note were Bitcoin-homed (membership proven against a
        // knownBitcoinRoot), its original Bitcoin UTXO would stay live + spendable on Bitcoin while the
        // crossOut mints a fresh equal-value Bitcoin note — value duplication, no race/reorg needed. A
        // bridge_burn MUST therefore originate from an Ethereum-homed note; the contract sees the home
        // lane (the guest sees only the root bytes), so reject btcHomed + crossOuts here.
        if (btcHomed && pv.crossOuts.length != 0) revert BridgeBurnNotEthHomed();
        // Source-consume invariant (cross-lane): a Bitcoin-homed note's value may reach Ethereum ONLY if
        // the note is also retired on Bitcoin — otherwise its value leaves to Ethereum while the original
        // Bitcoin UTXO stays live + spendable there (duplication). Marking ν in the EVM `nullifierSpent`
        // set does not reach Bitcoin (forward reflection runs Bitcoin→Ethereum only), so a btcHomed
        // value-exit must additionally retire the source note on Bitcoin. The crossOut bar above is one
        // instance. Two paths satisfy the invariant:
        //  (1) bridge_burn (Bitcoin) → bridge_mint (here): retired on Bitcoin first, then minted against
        //      the reflected bridge-burn set. NOT btcHomed (membership is against its own pool_root,
        //      spendRoot ∈ EVM/0), so it never reaches this branch.
        //  (2) Fast lane: spend the note directly here and record each consumed ν in `bitcoinConsumed`.
        //      The reverse reflection — the eth-reflection guest proving that slot, the Bitcoin reflection
        //      guest folding ν into the Bitcoin spent set (Ethereum-senior) — then retires the source note
        //      on Bitcoin so it can't be re-spent. The guest pinned by BITCOIN_RELAY_VKEY MUST perform that
        //      fold; the safety rests on the vkey⇄guest coherence, as with every pairing here.
        // A plain spend → {Ethereum leaf, withdrawal, settler fee}, an AMM swap, LP add, CDP action, or cBTC
        // mint rides the fast lane only with its source ν recorded: a swap's input funds reserve-in / an
        // LP-add's inputs fund both reserves in ratio (guest-bound asset via the membership leaf + per-input
        // cross-lane non-membership), and CDP/cBTC still hit their controller/escrow gates below. The adaptor
        // lock set, onward crossOut (barred above), EVM-deposit consumption, and a bridge_mint
        // (bitcoinBurnsConsumed) each compose it with a lane the consumed-ν reflection doesn't cover, so those
        // still must bridge. Direct withdrawals/fees additionally must be pool-minted assets, because a
        // btcHomed batch must not pay native-ETH/ERC20 escrow here.
        // A bridge_mint is Ethereum-homed by construction (it proves the burned note's membership against
        // its own pool_root, not a knownBitcoinRoot), so an honest batch never reaches this with a burn —
        // barring it explicitly mirrors the crossOut bar above (defense-in-depth vs a compromised guest).
        // (An LP-remove of a btcHomed share can't form: LP-share notes are pool-minted on Ethereum, so they
        // are never members of a knownBitcoinRoot — the guest's membership check rejects it.)
        if (btcHomed) {
            if (
                pv.depositsConsumed.length != 0 || pv.lockLeaves.length != 0 || pv.lockNullifiers.length != 0
                    || pv.bitcoinBurnsConsumed.length != 0
            ) {
                revert BtcHomedValueExitMustBridge();
            }
            if (
                pv.withdrawals.length != 0 || pv.fees.length != 0 || pv.leaves.length != 0 || pv.swaps.length != 0
                    || pv.liquidity.length != 0 || pv.cdpMints.length != 0 || pv.cdpCloses.length != 0
                    || pv.cdpLiquidations.length != 0 || pv.cdpTopups.length != 0 || pv.cbtcMints.length != 0
            ) {
                if (pv.nullifiers.length == 0) revert BtcHomedValueExitMustBridge();
                // A Bitcoin-homed DIRECT exit (withdrawal/fee) must resolve to a POOL-MINTED asset: those
                // mint on exit, so a btcHomed batch never pays native-ETH/ERC20 escrow directly here. An
                // escrow-backed bridged asset (tETH) is thus not exitable as a direct withdrawal/fee in a
                // btcHomed batch; it exits as a LEAF, and its later, SEPARATE (non-btcHomed) unwrap draws
                // escrow — backed 1:1 by the source note the reverse reflection retires on Bitcoin
                // (bitcoinConsumed, below). Leaves are opaque, so the guest — not this contract — binds a
                // btcHomed output to the source note's bridged asset.
                for (uint256 i; i < pv.withdrawals.length; ++i) {
                    if (!_assets[_resolveAsset(pv.withdrawals[i].assetId)].poolMinted) {
                        revert BtcHomedValueExitMustBridge();
                    }
                }
                for (uint256 i; i < pv.fees.length; ++i) {
                    if (!_assets[_resolveAsset(pv.fees[i].assetId)].poolMinted) revert BtcHomedValueExitMustBridge();
                }
                // Record every consumed Bitcoin-homed ν (spendRoot = the Bitcoin pool root membership was
                // proven against) so the reverse reflection folds it into the Bitcoin spent set. The ν are
                // also marked in nullifierSpent below; this dedicated map is the slot the eth-reflection
                // guest reflects, and it never holds a native EVM spend.
                uint256 baseCount = bitcoinConsumedCount;
                uint256 nlen = pv.nullifiers.length;
                for (uint256 i; i < nlen; ++i) {
                    bytes32 nu = pv.nullifiers[i];
                    bitcoinConsumed[nu] = pv.spendRoot;
                    bitcoinConsumedAt[baseCount + i] = nu;
                }
                // Advance the freshness anchor: every ν here is a new entry — the nullifierSpent gate below
                // reverts any repeat in this same tx (rolling back this increment), so the count grows by
                // exactly the batch's distinct consumed-note count.
                bitcoinConsumedCount = baseCount + nlen;
                emit BitcoinNotesConsumed(pv.nullifiers, pv.spendRoot);
            }
        }
        // The lock-set root a claim/refund proved membership against must be a known lock root (the
        // empty-set root or one this contract has advanced) — so a forged lock set carrying an
        // attacker-authored locked note cannot authorize a claim/refund (mint from nothing). A batch that
        // spends a locked note (lockNullifiers non-empty) MUST pin a known, NON-ZERO lock root; a
        // lock-only batch (appends, no claim) may carry a zero root it never proved membership against.
        if (pv.lockSetRoot != bytes32(0) && !everKnownLockRoot[pv.lockSetRoot]) revert UnknownLockRoot();
        if (pv.lockNullifiers.length != 0 && (pv.lockSetRoot == bytes32(0) || !everKnownLockRoot[pv.lockSetRoot])) {
            revert UnknownLockRoot();
        }
        // bridge_mint authorizes a mint on the burned note's MEMBERSHIP in the dedicated
        // bridge-burn set, pinned to the CURRENT reflected root. A non-zero burn root must
        // be current; and whenever a bridge_mint is present (bitcoinBurnsConsumed non-empty)
        // it is MANDATORY and non-zero — so a mint can never be authorized against the
        // generic spent set (which would duplicate value, H-1) or a stale/omitted root.
        if (pv.bitcoinBurnRoot != bytes32(0) && pv.bitcoinBurnRoot != knownBitcoinBurnRoot) {
            revert StaleBitcoinBurnRoot();
        }
        if (
            pv.bitcoinBurnsConsumed.length != 0
                && (pv.bitcoinBurnRoot == bytes32(0) || pv.bitcoinBurnRoot != knownBitcoinBurnRoot)
        ) revert StaleBitcoinBurnRoot();
        if (memos.length != pv.leaves.length) revert MemoLeafMismatch();

        // Cross-lane gate (cross-lane): a note already spent on Bitcoin cannot be
        // fast-spent on Ethereum. Enforced trustlessly in-guest — the guest proves each
        // spent ν absent from the Bitcoin spent set against `pv.bitcoinSpentRoot`, which
        // the check above pins to the current relay-proven root. Bitcoin is the arbiter.
        for (uint256 i; i < pv.nullifiers.length; ++i) {
            bytes32 n = pv.nullifiers[i];
            if (nullifierSpent[n]) revert NullifierAlreadySpent();
            nullifierSpent[n] = true;
        }
        if (pv.nullifiers.length != 0) emit NullifiersSpent(pv.nullifiers);

        // Adaptor lock-set effects. Spend each locked note once (the spend-once gate: claim XOR refund,
        // and never twice — including within one batch via set-then-check), then append the batch's new
        // locked notes to the lock-set accumulator (advancing the lock root a later claim/refund pins).
        // Lock leaves are NOT note-tree leaves (domain-separated in-guest), so they never touch
        // nextLeafIndex or the reserve floor; the claim/refund OUTPUT note is the note-tree leaf carrying
        // the value, inserted with the rest in pv.leaves.
        for (uint256 i; i < pv.lockNullifiers.length; ++i) {
            bytes32 l = pv.lockNullifiers[i];
            if (lockSpent[l]) revert LockAlreadySpent();
            lockSpent[l] = true;
        }
        if (pv.lockLeaves.length != 0) {
            uint256 filledSlot;
            assembly ("memory-safe") {
                filledSlot := lockFilledSubtrees.slot
            }
            (uint256 endIdx, bytes32 root) = _appendLeaves(pv.lockLeaves, lockNextLeafIndex, filledSlot);
            lockNextLeafIndex = endIdx;
            lockRoot = root;
            everKnownLockRoot[root] = true;
        }

        // ── Generic CDP (ops 15–17, 19) + cBTC mint (op 18) ───────────────────────────────────────────
        // The CDP position set mirrors the lock set: CLOSE/LIQUIDATE/TOPUP prove membership against a KNOWN
        // cdp root; MINT/TOPUP append new positions (advancing it); a position's nullifier is spent once.
        // ALL pricing/ratio policy is the controller's (onCdpMint/onCdpLiquidate/onCdpTopup revert to DENY).
        // A position is ALWAYS the controller's OWN derived debt asset (`debtAsset == keccak("tacit-cdp-debt-v1"
        // ‖ controller)`), so a controller can only ever mint/free its own asset — never cBTC/TAC.
        if (pv.cdpPositionRoot != bytes32(0) && !everKnownCdpRoot[pv.cdpPositionRoot]) revert UnknownCdpRoot();
        if (
            (pv.cdpCloses.length != 0 || pv.cdpLiquidations.length != 0 || pv.cdpTopups.length != 0)
                && (pv.cdpPositionRoot == bytes32(0) || !everKnownCdpRoot[pv.cdpPositionRoot])
        ) revert UnknownCdpRoot();

        for (uint256 i; i < pv.cdpMints.length; ++i) {
            CdpMint memory m = pv.cdpMints[i];
            if (m.controller.code.length == 0) revert BadCdpController();
            if (m.debtAsset != keccak256(abi.encodePacked("tacit-cdp-debt-v1", m.controller))) {
                revert BadCdpController();
            }
            // positionLeaf sentinels (SPEC-CONTROLLER-VAULT-AMENDMENT): 0 = bare payout, 1 = farm receipt
            // (bond when debtValue == 0, harvest when > 0) — neither is a real position, so skip the insert
            // (real leaves are keccak, always > 1); the controller's onCdpMint applies the policy (a harvest
            // bounds reward = debtValue against the receipt checkpoint carried in the leg values).
            if (uint256(m.positionLeaf) > 1) _insertCdpPositionLeaf(m.positionLeaf);
            // Escrow-mode farm harvest: debit the funded treasury by the reward (positionLeaf == 1, debtValue > 0)
            // so a harvest never exceeds the funded budget; the reward note is backed by escrow[rewardAsset].
            if (farmRewardAsset[m.controller] != bytes32(0) && uint256(m.positionLeaf) == 1 && m.debtValue != 0) {
                if (farmTreasury[m.controller] < m.debtValue) revert InsufficientEscrow();
                farmTreasury[m.controller] -= m.debtValue;
            }
            ICdpController(m.controller).onCdpMint(m.legs, m.debtValue, m.positionLeaf);
        }
        if (pv.cdpMints.length != 0) everKnownCdpRoot[cdpRoot] = true;

        for (uint256 i; i < pv.cdpTopups.length; ++i) {
            CdpTopup memory t = pv.cdpTopups[i];
            // Mint already checked controller code + derived debtAsset for the position leaf the proof consumes.
            // Top-up keeps no duplicate debtAsset field here: the old/new leaves bind the same controller debt.
            if (cdpPositionSpent[t.oldPositionNullifier]) revert CdpPositionAlreadySpent();
            cdpPositionSpent[t.oldPositionNullifier] = true;
            _insertCdpPositionLeaf(t.newPositionLeaf);
            ICdpController(t.controller)
                .onCdpTopup(t.oldLegs, t.newLegs, t.debtValue, t.oldPositionNullifier, t.newPositionLeaf);
        }
        if (pv.cdpTopups.length != 0) everKnownCdpRoot[cdpRoot] = true;

        for (uint256 i; i < pv.cdpCloses.length; ++i) {
            CdpClose memory c = pv.cdpCloses[i];
            if (c.controller.code.length == 0) revert BadCdpController();
            if (cdpPositionSpent[c.positionNullifier]) revert CdpPositionAlreadySpent();
            cdpPositionSpent[c.positionNullifier] = true;
            ICdpController(c.controller).onCdpClose(c.debtValue, c.legs, c.positionNullifier);
        }
        for (uint256 i; i < pv.cdpLiquidations.length; ++i) {
            CdpLiquidate memory q = pv.cdpLiquidations[i];
            if (q.controller.code.length == 0) revert BadCdpController();
            if (cdpPositionSpent[q.positionNullifier]) revert CdpPositionAlreadySpent();
            cdpPositionSpent[q.positionNullifier] = true;
            // The guest already burned debt notes summing exactly to debtValue and produced the seized-basket
            // withdrawals. The controller proves (its oracle) the position is unhealthy; reverts if healthy.
            ICdpController(q.controller).onCdpLiquidate(q.legs, q.debtValue, q.positionNullifier);
        }

        // cBTC mint (op 18): the cBTC note leaf rides pv.leaves (inserted below, conservation-free value
        // entry like bridge_mint). Gate it on the reflection-recorded lock (the locked sats + the locker's
        // pre-committed commitment), one-mint-per-lock, and the native-ETH escrow at the CollateralEngine.
        for (uint256 i; i < pv.cbtcMints.length; ++i) {
            CbtcMint memory cm = pv.cbtcMints[i];
            if (cm.vBtc == 0 || cbtcLockVBtc[cm.outpoint] != cm.vBtc) revert CbtcLockMismatch();
            if (cbtcLockCommitment[cm.outpoint] != cm.commitment) revert CbtcLockMismatch();
            if (cbtcLockSpent[cm.outpoint] || _cbtcMinted[cm.outpoint]) revert CbtcLockMismatch();
            if (address(COLLATERAL_ENGINE) == address(0) || !COLLATERAL_ENGINE.escrowSufficient(cm.outpoint, cm.vBtc)) {
                revert CbtcLockMismatch();
            }
            _cbtcMinted[cm.outpoint] = true;
        }

        // No-inflation floor: count EVM-homed spends (Bitcoin-homed cross-lane spends are backed by the
        // reflected Bitcoin tree, not this one). The post-insert invariant below caps total EVM spends at
        // total EVM leaves created — a guest/vkey compromise can't spend more notes than were created here.
        // A bridge_mint pushes the BITCOIN burned-note ν into BOTH `nullifiers` and `bitcoinBurnsConsumed`,
        // and its batch is not btcHomed (it proves membership against its own pool_root, so spendRoot is an
        // EVM root or 0). Those ν are Bitcoin-homed — never an EVM leaf — so exclude exactly the nullifiers
        // that are a consumed bridge-burn, matched BY IDENTITY (not by raw array-length difference): a
        // disjoint `bitcoinBurnsConsumed` (a compromised guest pairing fabricated EVM spends with unrelated
        // real burns) then cannot suppress the count, while an honest full-overlap batch is unchanged, and a
        // bridge_mint's leaf still balances its later EVM re-spend (no false-trip drift).
        if (!btcHomed) {
            uint256 added;
            for (uint256 i; i < pv.nullifiers.length; ++i) {
                bytes32 n = pv.nullifiers[i];
                bool isBurn;
                for (uint256 j; j < pv.bitcoinBurnsConsumed.length; ++j) {
                    if (pv.bitcoinBurnsConsumed[j] == n) {
                        isBurn = true;
                        break;
                    }
                }
                if (!isBurn) ++added;
            }
            evmNullifiersSpent += added;
        }

        for (uint256 i; i < pv.depositsConsumed.length; ++i) {
            bytes32 id = pv.depositsConsumed[i];
            if (depositStatus[id] != 1) revert DepositNotPending();
            depositStatus[id] = 2;
        }

        // Cross-mint: a Bitcoin burn becomes an Ethereum note (leaf in pv.leaves), gated
        // one-mint-per-burn on the burned note's nullifier ν (the guest proved ν is a
        // member of the relay-attested Bitcoin spent set, so the note really was burned).
        // Keying the gate on ν — not a dest-bound claimId — means a single burn can mint
        // to exactly one destination, once.
        for (uint256 i; i < pv.bitcoinBurnsConsumed.length; ++i) {
            bytes32 burnNullifier = pv.bitcoinBurnsConsumed[i];
            if (bridgeMinted[burnNullifier]) revert BurnAlreadyMinted();
            bridgeMinted[burnNullifier] = true;
        }

        // Every Bitcoin pool root a bridge_mint proved membership against must be
        // relay-proven (canonical + confirmed) — the inflation-critical gate.
        for (uint256 i; i < pv.bitcoinRootsUsed.length; ++i) {
            if (!knownBitcoinRoot[pv.bitcoinRootsUsed[i]]) revert UnknownBitcoinRoot();
        }

        if (pv.leaves.length != 0) {
            uint256 firstLeafIndex = nextLeafIndex;
            uint256 filledSlot;
            assembly ("memory-safe") {
                filledSlot := filledSubtrees.slot
            }
            (uint256 endIdx, bytes32 root) = _appendLeaves(pv.leaves, firstLeafIndex, filledSlot);
            nextLeafIndex = endIdx;
            currentRoot = root;
            everKnownRoot[root] = true;
            emit LeavesInserted(firstLeafIndex, pv.leaves, memos);
        }
        // No-inflation reserve floor (mixer #spent ≤ #leaves): total EVM-homed spends can never exceed
        // total EVM leaves ever created. Holds for every legitimate settle (each spent note is a prior
        // leaf); a compromised proof that fabricates spends beyond the real leaf set trips this.
        if (evmNullifiersSpent > nextLeafIndex) revert ReserveFloorBreach();

        for (uint256 i; i < pv.withdrawals.length; ++i) {
            Withdrawal memory w = pv.withdrawals[i];
            // A note value is a guest-carried u64 (the BP+ range is < 2^64); re-bound it at the public
            // boundary, mirroring wrap's u64 gate, so a single effect can't carry a value the note model
            // can't represent. The paid underlying (value·unitScale) is still u256.
            _ckU64(w.value);
            _payout(w.assetId, w.recipient, w.value);
        }

        for (uint256 i; i < pv.fees.length; ++i) {
            _ckU64(pv.fees[i].value);
            _payout(pv.fees[i].assetId, msg.sender, pv.fees[i].value);
        }

        // Cross-burn: record Ethereum notes burned for Bitcoin. Re-derive claimId
        // on-chain so the emitted record is exactly what the claimId commits to —
        // a non-malleable instruction Bitcoin validators honor once past finality.
        for (uint256 i; i < pv.crossOuts.length; ++i) {
            CrossOut memory c = pv.crossOuts[i];
            if (keccak256(abi.encodePacked(c.destChain, c.destCommitment, c.nullifier, c.assetId)) != c.claimId) {
                revert CrossOutClaimMismatch();
            }
            // Bind the burn to its source on-chain: the crossOut's ν must be spent in THIS batch (present
            // in pv.nullifiers, all marked above). The guest nullifies it, but the contract enforces the
            // link so a crossOut can never mint a Bitcoin note without consuming its Ethereum source note.
            bool spentHere;
            for (uint256 j; j < pv.nullifiers.length; ++j) {
                if (pv.nullifiers[j] == c.nullifier) {
                    spentHere = true;
                    break;
                }
            }
            if (!spentHere) revert CrossOutNullifierNotSpent();
            crossOutCommitment[c.claimId] = c.destCommitment; // storage anchor for reverse-reflection inclusion proofs
            emit CrossOutRecorded(c.claimId, c.destChain, c.destCommitment, c.nullifier, c.assetId);
        }

        // Confidential AMM (OP_SWAP): the guest cleared each batch against the pool's CURRENT
        // reserves (membership + nullifier + sigma + hidden-amount clearing + conservation are in
        // the proof; the trader notes flowed through `nullifiers`/`leaves` above). Gate that the
        // proven pre-reserves are the LIVE reserves — so a stale/forged pre can't be used — then
        // move the pool to the proven post. No value escrows here: the post is conservation-bound
        // to the pre, and the notes carry the trader side.
        for (uint256 i; i < pv.swaps.length; ++i) {
            SwapSettlement memory s = pv.swaps[i];
            Pool storage p = pools[s.poolId];
            if (!p.init) revert PoolNotInit();
            if (p.reserveA != s.reserveAPre || p.reserveB != s.reserveBPre) revert PoolReserveMismatch();
            // Defense-in-depth floor (mirrors the nullifier reserve floor): a live constant-product
            // pool's reserves are never 0, so a guest-supplied post that zeroes a leg can only be a
            // compromise — reject it rather than let the pool be drained/bricked.
            if (s.reserveAPost == 0 || s.reserveBPost == 0) revert ReserveFloorBreach();
            // Reserves stay < 2^64 — the same bound the LP loop enforces at funding, so a pool can never
            // hold value the guest can't reproduce. The guest carries reserves as u64 (BP+ range), so an
            // out-of-range post would wrap when read back as the next pre, desyncing or locking the pool.
            _ckU64(s.reserveAPost);
            _ckU64(s.reserveBPost);
            // Defense-in-depth (mirrors the guest's OP_SWAP constant-product check): a swap moves reserves
            // along or above the k curve — fees keep k flat-or-growing, never shrinking. A post that drops
            // k below pre is a compromised-guest drain (the classic AMM attack), so reject it on-chain too.
            // Reserves are < 2^64 (checked above) so each product fits in u256; identical to the guest's
            // u128 comparison. LP add/remove legitimately change k → gated in the liquidity loop, not here.
            if (s.reserveAPost * s.reserveBPost < s.reserveAPre * s.reserveBPre) revert ConstantProductDecreased();
            p.reserveA = s.reserveAPost;
            p.reserveB = s.reserveBPost;
        }

        // Confidential LP (OP_LP_ADD/REMOVE): move reserves AND totalShares. Like swaps, gate the
        // proven pre-state == the live pool (a stale/forged pre reverts), then apply the post — the
        // guest proved the in-ratio add / proportional remove + the LP-share + asset note flows.
        // Applied AFTER the swap loop, so for a same-pool batch the guest must order each LP
        // pre-state against the post-swap reserves or this pre==live gate reverts.
        for (uint256 i; i < pv.liquidity.length; ++i) {
            LpSettlement memory l = pv.liquidity[i];
            Pool storage p = pools[l.poolId];
            if (!p.init) revert PoolNotInit();
            if (p.reserveA != l.reserveAPre || p.reserveB != l.reserveBPre || p.totalShares != l.sharesPre) {
                revert PoolReserveMismatch();
            }
            // Same defense-in-depth floor: reserves stay positive and totalShares can never drop below
            // the permanently-locked MINIMUM_LIQUIDITY (no note holds those shares), so a post that
            // breaks either is a compromise, not a legitimate proportional remove.
            if (l.reserveAPost == 0 || l.reserveBPost == 0 || l.sharesPost < MINIMUM_LIQUIDITY) {
                revert ReserveFloorBreach();
            }
            // First confidential add (sharesPre == 0): mirror the public first-add — totalShares must EXCEED
            // the locked MINIMUM_LIQUIDITY (not merely equal it), so the founder gets a real position rather
            // than a noteless pool where every share is the permanent floor. Public path rejects minted ≤ MIN.
            if (l.sharesPre == 0 && l.sharesPost <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            // Reserves AND totalShares stay < 2^64 (the BP+/u64 bound the first LP add sets at funding): a
            // post beyond it would wrap when the guest reads it back as the next pre, locking the pool.
            if (
                l.reserveAPost > type(uint64).max || l.reserveBPost > type(uint64).max
                    || l.sharesPost > type(uint64).max
            ) revert ValueOutOfRange();
            p.reserveA = l.reserveAPost;
            p.reserveB = l.reserveBPost;
            p.totalShares = l.sharesPost;
        }
    }

    // ──────────────────── Internals ────────────────────

    /// Lazy-register a Tacit asset from guest-proven metadata: deploy its canonical ERC20
    /// (address = f(asset_id)) with the proven `(symbol, decimals)` and `unitScale` derived
    /// to harmonize to `ETH_DECIMALS`. Idempotent — a malformed or already-known entry is skipped (returns
    /// early), so it never blocks the settle on bad metadata. A revert from the factory itself
    /// (tokenOf/deployCanonical) still propagates; the factory is a trusted immutable wired at construction.
    function _autoRegisterFromMeta(AssetMeta memory m) internal {
        if (address(CANONICAL_FACTORY) == address(0)) return; // not wired
        if (m.decimals > ETH_DECIMALS || m.tickerLen == 0 || m.tickerLen > 16) return;
        if (localAssetOf[m.assetId] != bytes32(0)) return; // shared id already linked (e.g. native tETH)
        string memory symbol_ = string(_sliceTicker(m.ticker, m.tickerLen));
        // The factory address binds `m.cid` into the salt, so a token pre-deployed with a
        // different cid lands at a different address and is never resolved here — the
        // adopted token always carries the etch-proven cid (trustless contractURI).
        address token = CANONICAL_FACTORY.tokenOf(m.assetId, address(this), symbol_, ETH_DECIMALS, m.cid);
        if (token == address(0)) {
            // m.cid = the etch's IPFS metadata content hash (logo/description JSON); the asset_id
            // binds it (txid → envelope), so the token's contractURI is trustless. 0 ⇒ no metadata.
            token = CANONICAL_FACTORY.deployCanonical(m.assetId, address(this), symbol_, ETH_DECIMALS, m.cid);
        }
        bytes32 internalId = _evmAssetId(token);
        uint256 unitScale = 10 ** uint256(ETH_DECIMALS - m.decimals);
        if (_assets[internalId].registered) {
            // The canonical token already has a LOCAL registry entry (e.g. a permissionless
            // registerMinted squat of this exact token, which sets no cross-chain link). That must
            // not strand the bridged shared id: adopt the GUEST-PROVEN scale (the authoritative one)
            // and HEAL the link so a bridged unwrap resolves. The token is salt-bound to
            // (m.assetId, pool, symbol, 18, m.cid), so it IS the canonical token. Overwriting the
            // scale cannot enable a scale-poison drain: a pool-minted asset has NO escrow and the
            // canonical ERC20 is pool-minted, so a squatter holds zero balance and could not have
            // wrapped (or pool-funded) any note — there is no outstanding value at the old scale.
            AssetStore storage healed = _assets[internalId];
            healed.unitScale = unitScale;
            healed.crossChainLink = m.assetId;
            localAssetOf[m.assetId] = internalId;
            // Re-emit the canonical brand + guest-proven ticker so indexers upsert the corrected record (the
            // name/symbol are event-carried, not stored).
            emit AssetRegistered(internalId, token, unitScale, "Tacit Token", symbol_, ETH_DECIMALS);
            return;
        }
        if (IMintBurn(token).MINTER() != address(this)) return; // not our token
        _register(token, unitScale, m.assetId, true, "Tacit Token", symbol_, ETH_DECIMALS);
    }

    function _sliceTicker(bytes16 t, uint8 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        assembly ("memory-safe") {
            mstore(add(out, 0x20), t)
        }
    }

    function _evmAssetId(address underlying) internal view returns (bytes32 assetId) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, shl(112, 0x74616369742d65766d2d746f6b656e2d7631)) // "tacit-evm-token-v1"
            mstore(add(m, 18), shl(192, chainid()))
            mstore(add(m, 26), shl(96, underlying))
            if iszero(staticcall(gas(), 2, m, 46, m, 32)) { revert(0, 0) }
            assetId := mload(m)
        }
    }

    /// Resolve a note's `asset` to this pool's local registry key: a native note carries
    /// the local id (already registered); a bridged note carries the SHARED (Bitcoin-side)
    /// id, which `localAssetOf` maps to the local entry. Returns the input unchanged if
    /// neither is registered (the caller then reverts NotRegistered).
    function _resolveAsset(bytes32 assetId) internal view returns (bytes32) {
        if (_assets[assetId].registered) return assetId;
        bytes32 local = localAssetOf[assetId];
        if (local != bytes32(0)) return local;
        return assetId;
    }

    /// @notice The canonical ERC20 this pool recognizes for `assetId` — resolving a cross-chain shared
    ///         id to its local entry — or `address(0)` if the pool backs no token for it. This is the
    ///         source of truth for "is `token` the real one?": an impostor ERC20 (same asset id / symbol,
    ///         a different minter) is never pool-registered, so `canonicalTokenFor(id) == token` rejects
    ///         it. The factory cannot answer this — it deploys every variant, impostors included — but the
    ///         backing authority can; first-write-wins on `localAssetOf` means a shared id stays bound to
    ///         the first (real) token, so an impostor can't hijack the resolution.
    function canonicalTokenFor(bytes32 assetId) external view returns (address) {
        AssetStore storage a = _assets[_resolveAsset(assetId)];
        return a.registered ? a.underlying : address(0);
    }

    /// Pay `value` in-system note units of `assetId` to `to`, scaling to underlying by
    /// the asset's trusted `unitScale` (so a note worth v releases exactly v·unitScale —
    /// the guest, which never sees unitScale, cannot inflate the payout). Returns the
    /// underlying amount paid.
    function _payout(bytes32 assetId, address to, uint256 value) internal returns (uint256 amount) {
        if (value == 0) return 0;
        // Resolve the note's asset: a bridged note carries the SHARED (Bitcoin-side) id,
        // which maps to this pool's local registry entry; a native note carries the local
        // id directly. Without this, a bridged note's shared id has no registry entry and
        // the unwrap reverts NotRegistered, locking the bridged value (H-2).
        assetId = _resolveAsset(assetId);
        AssetStore storage a = _assets[assetId];
        if (!a.registered) revert NotRegistered();
        if (to == address(0)) revert ZeroAddress();
        amount = value * a.unitScale;
        if (a.poolMinted) {
            // Tacit-recorded asset: mint the canonical ERC20 (exit to public). The
            // note being unwrapped was the backed unit; this just changes its form.
            IMintBurn(a.underlying).mint(to, amount);
        } else {
            if (escrow[assetId] < amount) revert InsufficientEscrow();
            unchecked {
                escrow[assetId] -= amount; // guarded by the check directly above
            }
            if (a.underlying == address(0)) {
                // Native ETH — force-send so a non-payable recipient can't brick the batch settle.
                // Safe under reentrancy: the escrow decrement is committed first (checks-effects-
                // interactions) and settle holds the nonReentrant guard, so even the gas-stipended
                // call forceSafeTransferETH attempts first (before its selfdestruct-push fallback)
                // cannot re-enter the pool.
                SafeTransferLib.forceSafeTransferETH(to, amount);
            } else {
                SafeTransferLib.safeTransfer(a.underlying, to, amount);
            }
        }
    }

    /// Append a batch of leaves to an incremental-Merkle accumulator in ONE pass: each leaf walks
    /// `_insertTreeLeaf` (updating `filledSlot`'s subtrees per level), and the caller writes the advanced
    /// leaf index + final root ONCE — vs the per-leaf path, which re-read the index and re-stored an
    /// intermediate (discarded) root on every leaf. `filledSlot` selects the tree, so the note + lock
    /// accumulators share this body; the CDP tree inserts singly (interleaved with controller calls) and
    /// keeps `_insertCdpPositionLeaf`. Returns the index past the last leaf and the final root.
    function _appendLeaves(bytes32[] memory leaves, uint256 startIdx, uint256 filledSlot)
        internal
        returns (uint256 endIdx, bytes32 root)
    {
        endIdx = startIdx;
        uint256 n = leaves.length;
        for (uint256 i; i < n; ++i) {
            root = _insertTreeLeaf(leaves[i], endIdx, filledSlot);
            unchecked {
                ++endIdx;
            }
        }
    }

    /// Append a CDP position to the position-set accumulator — identical machinery to `_appendLeaves` /
    /// `_insertTreeLeaf` on its own independent tree (shares `zeros` + `_hash`; depth-bounded by
    /// MAX_LEAVES). A position leaf is never a note-tree or lock-set leaf (domain-separated in-guest), so
    /// the trees stay disjoint.
    function _insertCdpPositionLeaf(bytes32 leaf) internal {
        uint256 idx = cdpNextLeafIndex;
        uint256 filledSlot;
        assembly ("memory-safe") {
            filledSlot := cdpFilledSubtrees.slot
        }
        cdpRoot = _insertTreeLeaf(leaf, idx, filledSlot);
        unchecked {
            cdpNextLeafIndex = idx + 1;
        }
    }

    function _insertTreeLeaf(bytes32 leaf, uint256 idx, uint256 filledSlot) internal returns (bytes32 h) {
        if (idx >= MAX_LEAVES) revert MerkleTreeFull();
        assembly ("memory-safe") {
            let zerosSlot := zeros.slot
            h := leaf
            for { let i := 0 } lt(i, 32) { i := add(i, 1) } {
                switch iszero(and(idx, 1))
                case 1 {
                    sstore(add(filledSlot, i), h)
                    mstore(0x00, h)
                    mstore(0x20, sload(add(zerosSlot, i)))
                }
                default {
                    mstore(0x00, sload(add(filledSlot, i)))
                    mstore(0x20, h)
                }
                h := keccak256(0x00, 0x40)
                idx := shr(1, idx)
            }
        }
    }

    function _hash(bytes32 l, bytes32 r) internal pure returns (bytes32 h) {
        // keccak(l ‖ r) over the two-word scratch space (0x00–0x40) — byte-identical to
        // keccak256(abi.encodePacked(l, r)) but without the memory alloc, on the Merkle hot path
        // (called TREE_LEVELS times per inserted leaf). The KAT test pins the resulting root to the
        // JS/guest tree, so a divergence here fails closed.
        assembly ("memory-safe") {
            mstore(0x00, l)
            mstore(0x20, r)
            h := keccak256(0x00, 0x40)
        }
    }
}
