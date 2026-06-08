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
    function tokenOf(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_)
        external
        view
        returns (address);
    function deployCanonical(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_)
        external
        returns (address token);
}

/// Minimal ERC20 metadata read for deriving the Tacit-side scale of an external token.
interface IERC20Metadata {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// A canonical bridged ERC20 commits to its asset id at deploy. A cross-chain asset's
/// registry link is accepted only when the token's committed ASSET_ID matches the link,
/// so an unrelated token cannot claim a shared id (CanonicalBridgedERC20 implements this).
interface IAssetId {
    function ASSET_ID() external view returns (bytes32);
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
///  nullifiers are chain-independent (the guest derives keccak(note_secret); the
///  proof, not the nullifier, carries the chain binding), leaf hashing matches the
///  Bitcoin note scheme, the asset registry carries a cross-chain link, and the
///  public-values layout is versioned so the cross-chain tail is an append.
contract ConfidentialPool is ReentrancyGuardTransient {
    // ──────────────────── Constants ────────────────────

    uint256 public constant TREE_LEVELS = 32;
    uint256 public constant MAX_LEAVES = 1 << TREE_LEVELS;

    /// Decimals every Tacit-native asset is presented at on Ethereum (the ERC20
    /// convention). A Tacit asset's native precision (≤ 8, Bitcoin's limit) is harmonized
    /// up to this; `unitScale = 10^(ETH_DECIMALS − tacitDecimals)` does the amount scaling.
    uint8 public constant ETH_DECIMALS = 18;
    uint16 public constant PV_VERSION = 1;

    // ──────────────────── Immutables ────────────────────

    ISP1Verifier public immutable SP1_VERIFIER;
    bytes32 public immutable PROGRAM_VKEY;
    /// keccak(chainid, address(this)) — the guest stamps this into the public
    /// values, so a proof is bound to this deployment and cannot be replayed.
    bytes32 public immutable CHAIN_BINDING;
    /// vkey of the Bitcoin-state relay prover. Bitcoin confidential-pool state (the note
    /// tree root + the spent-nullifier root) is attested ONLY by an SP1 proof against this
    /// vkey — re-derived from relayed Bitcoin headers (the SP1PoolRootVerifier pattern).
    /// No trusted oracle: the proof is the sole authority.
    bytes32 public immutable BITCOIN_RELAY_VKEY;
    /// Monotonic guard: the highest Bitcoin height a relay proof has attested. A proof
    /// must strictly advance it, so a stale proof cannot roll the spent root backward.
    uint64 public lastRelayHeight;
    /// Factory used to lazily deploy a Tacit asset's canonical ERC20 on first bridge_mint,
    /// with the guest-proven metadata (OP_ATTEST_META). 0 = auto-register disabled.
    ICanonicalAssetFactory public immutable CANONICAL_FACTORY;

    // ──────────────────── Commitment tree (global, Keccak) ────────────────────

    uint256 public nextLeafIndex;
    bytes32 public currentRoot;
    bytes32[TREE_LEVELS] public zeros;
    bytes32[TREE_LEVELS] public filledSubtrees;
    mapping(bytes32 => bool) public everKnownRoot;

    // ──────────────────── Nullifiers (global) ────────────────────

    mapping(bytes32 => bool) public nullifierSpent;

    // ──────────────────── Assets ────────────────────

    struct Asset {
        bool registered;
        address underlying;   // ERC-20 backing; for poolMinted assets, the canonical ERC20 this pool mints/burns
        uint256 unitScale;    // underlying base units per in-system value unit
        bytes32 crossChainLink; // Bitcoin-side asset id for shared-asset recognition (0 if none)
        bool poolMinted;      // true ⇒ a Tacit-recorded asset whose canonical ERC20 the pool MINTS on exit
                              // / BURNS on entry (no escrow); false ⇒ an external ERC20 the pool escrows
        string name;
        string symbol;
        uint8 decimals;
    }

    mapping(bytes32 => Asset) public assets;     // asset_id => Asset
    mapping(bytes32 => uint256) public escrow;   // asset_id => escrowed underlying

    // ──────────────────── Pending deposits (wraps awaiting inclusion) ────────────────────

    // depositId => 0 none, 1 pending, 2 consumed
    mapping(bytes32 => uint8) public depositStatus;

    // ──────────────────── Cross-chain (one note, Bitcoin or Ethereum) ────────────────────

    // A Bitcoin-side note burn, claimed once when its value is minted as an Ethereum
    // note. Keyed by the burned note's nullifier ν (the guest proves ν is spent on
    // Bitcoin via relay-attested spent-set membership). One mint per burned note.
    mapping(bytes32 => bool) public bridgeMinted;

    // Bitcoin confidential-pool roots the oracle has attested as canonical +
    // confirmed. A bridge_mint proves the burned note's membership against one of
    // these, so a fake-tree note cannot be minted (the inflation-critical gate).
    // Also accepted as a `spendRoot` for the improved-platinum fast lane (a
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

    // The reflection prover's genesis digest — WitnessedReflection::genesis().digest(): an
    // empty note tree + sentinel-seeded spent/burn/UTXO sets. knownReflectionDigest is seeded
    // to this so the first attestation continues genesis. Tied to BITCOIN_RELAY_VKEY (one prover).
    bytes32 public constant REFLECTION_GENESIS_DIGEST =
        0x0ca539ff3a68ab1969e7df9234359872225fff86fc72192d9127f8d8b94a5b9f;

    // A shared (Bitcoin-side) asset id => this pool's local registry key. A bridge_mint note
    // carries the SHARED id as its `asset` (it must, to prove membership in the Bitcoin
    // pool), so the registry resolves that id back to the local entry on unwrap — else a
    // bridged note could never exit. Set only for a pool-minted asset whose canonical token
    // commits to the same id; first-write-wins, so it cannot be squatted to misroute a payout.
    mapping(bytes32 => bytes32) public localAssetOf;

    // ──────────────────── Public-values layout ────────────────────

    // Boundary effects speak the in-system note value `v`; the contract scales it to
    // underlying by the asset's trusted `unitScale` on payout, so the guest (which
    // never sees unitScale) can never release more than a note is worth.
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    // An Ethereum note burned for value on another chain. The guest proved the
    // burned value equals destCommitment's and nullified the note (ν in
    // `nullifiers`); Bitcoin validators mint the destination note once, off-chain.
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    // Metadata the guest proved from a Bitcoin etch reveal (asset_id binds the txid, the
    // txid binds the on-chain envelope's ticker+decimals) — trustless first-mint metadata.
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; }

    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot;              // root the guest proved input membership against
        bytes32[] nullifiers;          // spent-note nullifiers (chain-independent)
        bytes32[] leaves;              // new leaves to append (consumed deposits + outputs + cross-mints)
        bytes32[] depositsConsumed;    // deposit ids the guest validated + inserted
        Withdrawal[] withdrawals;      // unwrap payouts (in-system value; scaled by unitScale)
        FeePayment[] fees;             // settler fees (in-system value; scaled), paid to msg.sender
        bytes32[] bitcoinBurnsConsumed; // burned-note nullifiers minted here, gated once each
        CrossOut[] crossOuts;          // Ethereum burns destined for Bitcoin
        bytes32[] bitcoinRootsUsed;    // Bitcoin pool roots a bridge_mint proved membership against
        bytes32 bitcoinSpentRoot;     // Bitcoin spent-set IMT root the guest proved non-membership against (0 = none)
        bytes32 bitcoinBurnRoot;      // Bitcoin bridge-burn IMT root a bridge_mint proved burn membership against (0 = none)
        AssetMeta[] assetMetas;        // etch-proven (asset_id, ticker, decimals) → trustless lazy-register
    }

    // ──────────────────── Events ────────────────────

    event AssetRegistered(bytes32 indexed assetId, address indexed underlying, uint256 unitScale, string name, string symbol, uint8 decimals);
    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner);
    event Settled(bytes32 indexed newRoot, uint256 leavesInserted, uint256 nullifiersSpent);
    event Withdraw(bytes32 indexed assetId, address indexed recipient, uint256 amount);
    // Note data availability for recovery: each inserted leaf with its encrypted
    // memo (owner-only; unverified passthrough), aligned, from firstLeafIndex.
    event LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos);
    event NullifiersSpent(bytes32[] nullifiers);
    // A Bitcoin burn was minted as an Ethereum note (claimed once).
    event BridgeMinted(bytes32 indexed claimId);
    // The oracle attested a canonical, confirmed Bitcoin confidential-pool root.
    event BitcoinRootAttested(bytes32 indexed root);
    // The reflected Bitcoin spent-set indexed-Merkle root advanced.
    event BitcoinSpentRootReflected(bytes32 indexed root);
    // The reflected Bitcoin bridge-burn indexed-Merkle root advanced.
    event BitcoinBurnRootReflected(bytes32 indexed root);
    // The reflected Bitcoin state advanced one cycle (the digest chain extended).
    event BitcoinReflectionAdvanced(bytes32 indexed priorDigest, bytes32 indexed newDigest, uint64 height);
    // An Ethereum note was burned for Bitcoin; validators honor it once past finality.
    event CrossOutRecorded(bytes32 indexed claimId, uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 assetId);

    // ──────────────────── Errors ────────────────────

    error ZeroAddress();
    error ZeroVKey();
    error AlreadyRegistered();
    error NotRegistered();
    error NotAContract();
    error CanonicalAsset();
    error AmountNotAligned();
    error DepositExists();
    error MerkleTreeFull();
    error BadVersion();
    error ChainMismatch();
    error UnknownRoot();
    error NullifierAlreadySpent();
    error DepositNotPending();
    error InsufficientEscrow();
    error MemoLeafMismatch();
    error BurnAlreadyMinted();
    error CrossOutClaimMismatch();
    error UnknownBitcoinRoot();
    error StaleBitcoinSpentRoot();
    error PoolNotMinter();
    error BadDecimals();
    error StaleRelayProof();
    error ValueOutOfRange();
    error StaleBitcoinBurnRoot();
    error StaleReflectionDigest();
    error CrossChainEscrow();
    error CrossChainTokenMismatch();
    error CrossChainLinkTaken();

    // ──────────────────── Constructor ────────────────────

    constructor(address sp1Verifier_, bytes32 programVKey_, bytes32 bitcoinRelayVKey_, address canonicalFactory_) {
        if (sp1Verifier_ == address(0)) revert ZeroAddress();
        if (programVKey_ == bytes32(0)) revert ZeroVKey();
        SP1_VERIFIER = ISP1Verifier(sp1Verifier_);
        PROGRAM_VKEY = programVKey_;
        CHAIN_BINDING = keccak256(abi.encodePacked(block.chainid, address(this)));
        BITCOIN_RELAY_VKEY = bitcoinRelayVKey_; // the sole Bitcoin-state authority (a proof)
        CANONICAL_FACTORY = ICanonicalAssetFactory(canonicalFactory_);
        knownReflectionDigest = REFLECTION_GENESIS_DIGEST; // the first cycle continues genesis

        bytes32 z = bytes32(0);
        for (uint256 i; i < TREE_LEVELS; ++i) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = _hash(z, z);
        }
        currentRoot = z;
        everKnownRoot[z] = true;
    }

    // ──────────────────── Asset registry ────────────────────

    /// @notice Register a wrapped ERC-20 as a confidential asset. `unitScale`
    ///         maps underlying base units to the in-system value unit so a note's
    ///         value stays within the Bulletproofs+ range; wrap amounts must be a
    ///         multiple of it. `crossChainLink` ties this asset to its Bitcoin-side
    ///         id for the cross-chain generation (0 if none).
    /// @notice Register an EXTERNAL ERC20 (e.g. USDC) as a confidential asset. The
    ///         pool escrows it on wrap and releases it on unwrap.
    function registerWrapped(
        address underlying,
        uint256 unitScale,
        bytes32 crossChainLink,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external returns (bytes32 assetId) {
        return _register(underlying, unitScale, crossChainLink, false, name_, symbol_, decimals_);
    }

    /// @notice Register an external Ethereum-native ERC20, reading its metadata on-chain
    ///         and DERIVING the Tacit-side scale: the asset is represented at
    ///         min(decimals, 8) on Bitcoin/Tacit (its native limit), so
    ///         `unitScale = 10^(decimals − tacitDecimals)` (18-dec WETH → 8 on Tacit,
    ///         scale 10^10; 6-dec USDC → 6, scale 1). Symmetric to `registerMintedAuto`;
    ///         the pool escrows the ERC20 (no minting). `name`/`symbol` mirror the
    ///         underlying — external assets keep their own identity, not the Tacit brand.
    function registerWrappedAuto(address underlying, bytes32 crossChainLink)
        external
        returns (bytes32 assetId)
    {
        uint8 d = IERC20Metadata(underlying).decimals();
        uint8 tacitDecimals = d > 8 ? 8 : d;
        uint256 unitScale = 10 ** uint256(d - tacitDecimals);
        return _register(
            underlying, unitScale, crossChainLink, false,
            IERC20Metadata(underlying).name(), IERC20Metadata(underlying).symbol(), d
        );
    }

    /// @notice Register a TACIT-RECORDED asset (TAC, a cBTC equivalent, any Tacit
    ///         asset) whose canonical ERC20 THIS POOL mints/burns. `canonicalErc20`
    ///         must have its mint authority set to this pool. The asset's value
    ///         enters Ethereum as a confidential note (bridge_mint, backed by the
    ///         Tacit record); the public ERC20 is its exit form — minted on unwrap,
    ///         burned on wrap. No escrow: the pool is the single supply authority.
    function registerMinted(
        address canonicalErc20,
        uint256 unitScale,
        bytes32 crossChainLink,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external returns (bytes32 assetId) {
        // The pool must be able to mint/burn this ERC20, else the asset can never exit.
        if (IMintBurn(canonicalErc20).MINTER() != address(this)) revert PoolNotMinter();
        return _register(canonicalErc20, unitScale, crossChainLink, true, name_, symbol_, decimals_);
    }

    /// @notice Register a Tacit-native asset by its cross-chain `tacitAssetId`, lazily
    ///         deploying its canonical ERC20 through `factory` (address = f(tacitAssetId))
    ///         if it does not exist yet, with THIS POOL as minter. Decimals are harmonized
    ///         to Ethereum (`ETH_DECIMALS`) and `unitScale` is DERIVED deterministically
    ///         from the asset's native precision — `10^(ETH_DECIMALS − tacitDecimals)` —
    ///         so an 8-decimal Tacit asset becomes an 18-decimal ERC20 with a 10^10 scale,
    ///         no operator-chosen scale to get wrong. `name` is the constant brand; the
    ///         only per-asset metadata is `(symbol, tacitDecimals)`, deterministic to the
    ///         real asset (carried in its etch).
    function registerMintedAuto(address factory, bytes32 tacitAssetId, string calldata symbol_, uint8 tacitDecimals)
        external
        returns (bytes32 assetId, address token)
    {
        if (tacitDecimals > ETH_DECIMALS) revert BadDecimals();
        // Look up / deploy at this pool's slot — f(assetId, this-pool, symbol, ETH_DECIMALS).
        // The canonical address is specific to (asset, minter, metadata).
        token = ICanonicalAssetFactory(factory).tokenOf(tacitAssetId, address(this), symbol_, ETH_DECIMALS);
        if (token == address(0)) {
            // first touch: deploy the public ERC20 at its canonical CREATE2 address.
            token = ICanonicalAssetFactory(factory).deployCanonical(tacitAssetId, address(this), symbol_, ETH_DECIMALS);
        }
        if (IMintBurn(token).MINTER() != address(this)) revert PoolNotMinter();
        uint256 unitScale = 10 ** uint256(ETH_DECIMALS - tacitDecimals);
        assetId = _register(token, unitScale, tacitAssetId, true, "Tacit Token", symbol_, ETH_DECIMALS);
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
        if (underlying == address(0)) revert ZeroAddress();
        if (unitScale == 0) revert AmountNotAligned();
        // Escrow registrations (external ERC20s) must be a deployed, non-canonical token:
        // a canonical token of this pool registers only via the guest-proven minted path
        // (_autoRegisterFromMeta), and a not-yet-deployed canonical address must not be
        // claimable as escrow (which would pre-empt its later auto-registration).
        if (!poolMinted) {
            if (underlying.code.length == 0) revert NotAContract();
            try IMintBurn(underlying).MINTER() returns (address mtr) {
                if (mtr == address(this)) revert CanonicalAsset();
            } catch {}
        }
        assetId = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying));
        if (assets[assetId].registered) revert AlreadyRegistered();
        // A cross-chain link makes the asset's SHARED id resolve to this local entry on
        // unwrap of a bridged note (H-2). Accept it only for a pool-minted asset whose
        // canonical token COMMITS to the same id (ASSET_ID == link) — an external/escrow
        // token can never claim a shared id — and first-write-wins, so it cannot be
        // squatted to misroute a bridged payout.
        if (crossChainLink != bytes32(0)) {
            if (!poolMinted) revert CrossChainEscrow();
            try IAssetId(underlying).ASSET_ID() returns (bytes32 aid) {
                if (aid != crossChainLink) revert CrossChainTokenMismatch();
            } catch {
                revert CrossChainTokenMismatch();
            }
            if (localAssetOf[crossChainLink] != bytes32(0)) revert CrossChainLinkTaken();
            localAssetOf[crossChainLink] = assetId;
        }
        assets[assetId] = Asset(true, underlying, unitScale, crossChainLink, poolMinted, name_, symbol_, decimals_);
        emit AssetRegistered(assetId, underlying, unitScale, name_, symbol_, decimals_);
    }

    // ──────────────────── Wrap (public deposit) ────────────────────

    /// @notice Escrow `amount` of the asset's underlying and record a pending
    ///         deposit for the note commitment C = (cx, cy) owned by `owner`. The
    ///         note is inserted into the tree only when a proof consumes the
    ///         deposit (the guest verifies C opens to amount/unitScale). Amount is
    ///         public at this boundary; everything after is blinded.
    function wrap(bytes32 assetId, uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner) external nonReentrant {
        Asset storage a = assets[assetId];
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
        if (value > type(uint64).max) revert ValueOutOfRange();
        bytes32 depositId = keccak256(abi.encode(assetId, value, cx, cy, owner));
        if (depositStatus[depositId] != 0) revert DepositExists();
        depositStatus[depositId] = 1;

        if (a.poolMinted) {
            // Tacit-recorded asset: burn the canonical ERC20 (re-entering confidential).
            IMintBurn(a.underlying).burn(msg.sender, amount);
        } else {
            // External ERC20: escrow it.
            escrow[assetId] += amount;
            SafeTransferLib.safeTransferFrom(a.underlying, msg.sender, address(this), amount);
        }
        emit Wrap(depositId, assetId, amount, cx, cy, owner);
    }

    // ──────────────────── Bitcoin state attestation (relay-proven, no oracle) ────────────────────

    /// Bitcoin state proven by the reflection prover (re-derived from relayed headers + the
    /// folded confirmed pool effects in SP1) — the trustless input to the bridge_mint root
    /// gate and the cross-lane spent-set. Field order matches the prover's commitment.
    struct BitcoinRelayPublicValues {
        bytes32 priorDigest;      // the reflected state this proof CONTINUES (== knownReflectionDigest)
        bytes32 bitcoinPoolRoot;  // the Bitcoin confidential-pool note-tree root
        bytes32 bitcoinSpentRoot; // the Bitcoin spent-nullifier IMT root at this height
        bytes32 bitcoinBurnRoot;  // the Bitcoin bridge-burn IMT root at this height (bridge_mint authority)
        uint64 bitcoinHeight;     // the confirmed Bitcoin height the batch advanced to
        bytes32 newDigest;        // the reflected state AFTER this proof (the next cycle's prior)
    }

    /// @notice Attest Bitcoin confidential-pool state via an SP1 relay proof — the ONLY
    ///         attestation path (no trusted oracle). Verifies the proof against
    ///         `BITCOIN_RELAY_VKEY`, then marks the proven pool root canonical (so a
    ///         bridge_mint can prove membership against it) and advances the reflected
    ///         spent-set root (the cross-lane non-membership freshness root). The height
    ///         must strictly increase, so a stale proof can't roll the spent set back.
    function attestBitcoinStateProven(bytes calldata publicValues, bytes calldata proofBytes) external {
        SP1_VERIFIER.verifyProof(BITCOIN_RELAY_VKEY, publicValues, proofBytes);
        BitcoinRelayPublicValues memory r = abi.decode(publicValues, (BitcoinRelayPublicValues));
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
        lastRelayHeight = r.bitcoinHeight;
        knownBitcoinRoot[r.bitcoinPoolRoot] = true;
        knownBitcoinSpentRoot = r.bitcoinSpentRoot;
        knownBitcoinBurnRoot = r.bitcoinBurnRoot;
        knownReflectionDigest = r.newDigest;
        emit BitcoinRootAttested(r.bitcoinPoolRoot);
        emit BitcoinSpentRootReflected(r.bitcoinSpentRoot);
        emit BitcoinBurnRootReflected(r.bitcoinBurnRoot);
        emit BitcoinReflectionAdvanced(r.priorDigest, r.newDigest, r.bitcoinHeight);
    }

    // ──────────────────── Settle (the one proof entrypoint) ────────────────────

    /// @notice Verify one SP1 proof and apply its effects: mark nullifiers, append
    ///         leaves, consume deposits, pay withdrawals and settler fees. Fees go
    ///         to msg.sender (the settler); self-prove sets no fees and pays only
    ///         gas. All amount/conservation/range checking happened in the guest.
    /// @param memos one encrypted note memo per inserted leaf (same order as
    ///        `pv.leaves`), data-availability only — unverified, owner-decryptable
    ///        for seed-only recovery. Emitted in `LeavesInserted`.
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external nonReentrant {
        SP1_VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proofBytes);
        PublicValues memory pv = abi.decode(publicValues, (PublicValues));

        if (pv.version != PV_VERSION) revert BadVersion();
        if (pv.chainBinding != CHAIN_BINDING) revert ChainMismatch();
        // Membership may be proven against an Ethereum root OR a reflected Bitcoin
        // confidential-pool root (improved platinum: a Bitcoin-homed note spent on
        // the Ethereum fast lane). Both are oracle/relay-attested.
        if (pv.spendRoot != bytes32(0) && !everKnownRoot[pv.spendRoot] && !knownBitcoinRoot[pv.spendRoot]) revert UnknownRoot();
        // Cross-lane non-membership (improved platinum): if the guest proved each
        // spent ν absent from the Bitcoin spent set, it must be against the CURRENT
        // reflected root — a stale root could omit a recent Bitcoin spend.
        if (pv.bitcoinSpentRoot != bytes32(0) && pv.bitcoinSpentRoot != knownBitcoinSpentRoot) revert StaleBitcoinSpentRoot();
        // Cross-lane non-membership is MANDATORY for a Bitcoin-homed spend (membership
        // proven against a relay-attested Bitcoin pool root, not an Ethereum root):
        // it must pin the CURRENT Bitcoin spent-set root, so a proof can't skip the
        // gate by committing a zero/omitted bitcoinSpentRoot and re-spend on Ethereum a
        // note already spent on Bitcoin. Ethereum-homed spends carry no Bitcoin history.
        bool btcHomed = pv.spendRoot != bytes32(0) && !everKnownRoot[pv.spendRoot] && knownBitcoinRoot[pv.spendRoot];
        // Fail closed: a Bitcoin-homed spend MUST pin the CURRENT, NON-ZERO reflected
        // spent-set root. A zero root means the cross-lane set is uninitialized (or a
        // relay reflected an empty set as 0) — allowing it would let the guest skip its
        // non-membership check (the guest keys it off `bitcoin_spent_root != 0`) and
        // re-spend on Ethereum a note already spent on Bitcoin. The reflection prover
        // seeds a non-zero empty-IMT sentinel, so a legitimate spent root is never 0.
        if (btcHomed && (pv.bitcoinSpentRoot == bytes32(0) || pv.bitcoinSpentRoot != knownBitcoinSpentRoot)) revert StaleBitcoinSpentRoot();
        // bridge_mint authorizes a mint on the burned note's MEMBERSHIP in the dedicated
        // bridge-burn set, pinned to the CURRENT reflected root. A non-zero burn root must
        // be current; and whenever a bridge_mint is present (bitcoinBurnsConsumed non-empty)
        // it is MANDATORY and non-zero — so a mint can never be authorized against the
        // generic spent set (which would duplicate value, H-1) or a stale/omitted root.
        if (pv.bitcoinBurnRoot != bytes32(0) && pv.bitcoinBurnRoot != knownBitcoinBurnRoot) revert StaleBitcoinBurnRoot();
        if (pv.bitcoinBurnsConsumed.length != 0 && (pv.bitcoinBurnRoot == bytes32(0) || pv.bitcoinBurnRoot != knownBitcoinBurnRoot)) revert StaleBitcoinBurnRoot();
        if (memos.length != pv.leaves.length) revert MemoLeafMismatch();

        // Cross-lane gate (improved platinum): a note already spent on Bitcoin cannot be
        // fast-spent on Ethereum. Enforced trustlessly in-guest — the guest proves each
        // spent ν absent from the Bitcoin spent set against `pv.bitcoinSpentRoot`, which
        // the check above pins to the current relay-proven root. Bitcoin is the arbiter.
        for (uint256 i; i < pv.nullifiers.length; ++i) {
            bytes32 n = pv.nullifiers[i];
            if (nullifierSpent[n]) revert NullifierAlreadySpent();
            nullifierSpent[n] = true;
        }
        if (pv.nullifiers.length != 0) emit NullifiersSpent(pv.nullifiers);

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
            emit BridgeMinted(burnNullifier);
        }

        // Every Bitcoin pool root a bridge_mint proved membership against must be
        // relay-proven (canonical + confirmed) — the inflation-critical gate.
        for (uint256 i; i < pv.bitcoinRootsUsed.length; ++i) {
            if (!knownBitcoinRoot[pv.bitcoinRootsUsed[i]]) revert UnknownBitcoinRoot();
        }

        if (pv.leaves.length != 0) {
            uint256 firstLeafIndex = nextLeafIndex;
            for (uint256 i; i < pv.leaves.length; ++i) _insertLeaf(pv.leaves[i]);
            everKnownRoot[currentRoot] = true;
            emit LeavesInserted(firstLeafIndex, pv.leaves, memos);
        }

        // Trustless first-mint metadata: lazy-register any Tacit asset whose (ticker,
        // decimals) the guest proved from its etch (OP_ATTEST_META) — deploy its canonical
        // ERC20 at the factory's f(asset_id) address with the proven metadata + derived
        // scale, so a later unwrap can mint it. One-time per asset; skipped once registered.
        for (uint256 i; i < pv.assetMetas.length; ++i) _autoRegisterFromMeta(pv.assetMetas[i]);

        for (uint256 i; i < pv.withdrawals.length; ++i) {
            Withdrawal memory w = pv.withdrawals[i];
            uint256 paid = _payout(w.assetId, w.recipient, w.value);
            emit Withdraw(w.assetId, w.recipient, paid);
        }

        for (uint256 i; i < pv.fees.length; ++i) {
            _payout(pv.fees[i].assetId, msg.sender, pv.fees[i].value);
        }

        // Cross-burn: record Ethereum notes burned for Bitcoin. Re-derive claimId
        // on-chain so the emitted record is exactly what the claimId commits to —
        // a non-malleable instruction Bitcoin validators honor once past finality.
        for (uint256 i; i < pv.crossOuts.length; ++i) {
            CrossOut memory c = pv.crossOuts[i];
            if (keccak256(abi.encodePacked(c.destChain, c.destCommitment, c.nullifier, c.assetId)) != c.claimId) revert CrossOutClaimMismatch();
            emit CrossOutRecorded(c.claimId, c.destChain, c.destCommitment, c.nullifier, c.assetId);
        }

        emit Settled(currentRoot, pv.leaves.length, pv.nullifiers.length);
    }

    // ──────────────────── Views ────────────────────

    function isKnownRoot(bytes32 root) external view returns (bool) { return everKnownRoot[root]; }
    function isNullifierSpent(bytes32 n) external view returns (bool) { return nullifierSpent[n]; }
    function getAsset(bytes32 assetId) external view returns (Asset memory) { return assets[assetId]; }

    // ──────────────────── Internals ────────────────────

    /// Lazy-register a Tacit asset from guest-proven metadata: deploy its canonical ERC20
    /// (address = f(asset_id)) with the proven `(symbol, decimals)` and `unitScale` derived
    /// to harmonize to `ETH_DECIMALS`. Idempotent + tolerant — a malformed or already-known
    /// entry is skipped, never reverting the whole settle.
    function _autoRegisterFromMeta(AssetMeta memory m) internal {
        if (address(CANONICAL_FACTORY) == address(0)) return; // not wired
        if (m.decimals > ETH_DECIMALS || m.tickerLen == 0 || m.tickerLen > 16) return;
        string memory symbol_ = string(_sliceTicker(m.ticker, m.tickerLen));
        address token = CANONICAL_FACTORY.tokenOf(m.assetId, address(this), symbol_, ETH_DECIMALS);
        if (token == address(0)) {
            token = CANONICAL_FACTORY.deployCanonical(m.assetId, address(this), symbol_, ETH_DECIMALS);
        }
        bytes32 internalId = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), token));
        if (assets[internalId].registered) return; // already registered
        if (localAssetOf[m.assetId] != bytes32(0)) return; // shared id already linked
        if (IMintBurn(token).MINTER() != address(this)) return; // not our token
        uint256 unitScale = 10 ** uint256(ETH_DECIMALS - m.decimals);
        _register(token, unitScale, m.assetId, true, "Tacit Token", symbol_, ETH_DECIMALS);
    }

    function _sliceTicker(bytes16 t, uint8 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = t[i];
    }

    /// Resolve a note's `asset` to this pool's local registry key: a native note carries
    /// the local id (already registered); a bridged note carries the SHARED (Bitcoin-side)
    /// id, which `localAssetOf` maps to the local entry. Returns the input unchanged if
    /// neither is registered (the caller then reverts NotRegistered).
    function _resolveAsset(bytes32 assetId) internal view returns (bytes32) {
        if (assets[assetId].registered) return assetId;
        bytes32 local = localAssetOf[assetId];
        if (local != bytes32(0)) return local;
        return assetId;
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
        Asset storage a = assets[assetId];
        if (!a.registered) revert NotRegistered();
        if (to == address(0)) revert ZeroAddress();
        amount = value * a.unitScale;
        if (a.poolMinted) {
            // Tacit-recorded asset: mint the canonical ERC20 (exit to public). The
            // note being unwrapped was the backed unit; this just changes its form.
            IMintBurn(a.underlying).mint(to, amount);
        } else {
            if (escrow[assetId] < amount) revert InsufficientEscrow();
            escrow[assetId] -= amount;
            SafeTransferLib.safeTransfer(a.underlying, to, amount);
        }
    }

    function _insertLeaf(bytes32 leaf) internal {
        if (nextLeafIndex >= MAX_LEAVES) revert MerkleTreeFull();
        uint256 idx = nextLeafIndex;
        bytes32 h = leaf;
        for (uint256 i; i < TREE_LEVELS; ++i) {
            if (idx & 1 == 0) { filledSubtrees[i] = h; h = _hash(h, zeros[i]); }
            else { h = _hash(filledSubtrees[i], h); }
            idx >>= 1;
        }
        currentRoot = h;
        nextLeafIndex++;
    }

    function _hash(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(l, r));
    }
}
