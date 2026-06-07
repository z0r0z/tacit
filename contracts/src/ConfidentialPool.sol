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
    function tokenOf(bytes32 assetId) external view returns (address);
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

    // A Bitcoin-side note burn, claimed once when its value is minted as an
    // Ethereum note. claimId = keccak(destChain ‖ destCommitment ‖ ν ‖ assetId),
    // computed identically on both chains. One mint per burn (the tETH pattern).
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

    // ──────────────────── Public-values layout ────────────────────

    struct Withdrawal { bytes32 assetId; address recipient; uint256 amount; }
    struct FeePayment { bytes32 assetId; uint256 amount; }
    // An Ethereum note burned for value on another chain. The guest proved the
    // burned value equals destCommitment's and nullified the note (ν in
    // `nullifiers`); Bitcoin validators mint the destination note once, off-chain.
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }

    struct PublicValues {
        uint16 version;
        bytes32 chainBinding;
        bytes32 spendRoot;              // root the guest proved input membership against
        bytes32[] nullifiers;          // spent-note nullifiers (chain-independent)
        bytes32[] leaves;              // new leaves to append (consumed deposits + outputs + cross-mints)
        bytes32[] depositsConsumed;    // deposit ids the guest validated + inserted
        Withdrawal[] withdrawals;      // unwrap payouts (underlying units)
        FeePayment[] fees;             // settler fees (underlying units), paid to msg.sender
        bytes32[] bitcoinBurnsConsumed; // claimIds of Bitcoin burns minted here, gated once
        CrossOut[] crossOuts;          // Ethereum burns destined for Bitcoin
        bytes32[] bitcoinRootsUsed;    // Bitcoin pool roots a bridge_mint proved membership against
        bytes32 bitcoinSpentRoot;     // Bitcoin spent-set IMT root the guest proved non-membership against (0 = none)
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
    // An Ethereum note was burned for Bitcoin; validators honor it once past finality.
    event CrossOutRecorded(bytes32 indexed claimId, uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 assetId);

    // ──────────────────── Errors ────────────────────

    error ZeroAddress();
    error ZeroVKey();
    error AlreadyRegistered();
    error NotRegistered();
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

    // ──────────────────── Constructor ────────────────────

    constructor(address sp1Verifier_, bytes32 programVKey_, bytes32 bitcoinRelayVKey_) {
        if (sp1Verifier_ == address(0)) revert ZeroAddress();
        if (programVKey_ == bytes32(0)) revert ZeroVKey();
        SP1_VERIFIER = ISP1Verifier(sp1Verifier_);
        PROGRAM_VKEY = programVKey_;
        CHAIN_BINDING = keccak256(abi.encodePacked(block.chainid, address(this)));
        BITCOIN_RELAY_VKEY = bitcoinRelayVKey_; // the sole Bitcoin-state authority (a proof)

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
        token = ICanonicalAssetFactory(factory).tokenOf(tacitAssetId);
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
        assetId = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying));
        if (assets[assetId].registered) revert AlreadyRegistered();
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

        bytes32 depositId = keccak256(abi.encode(assetId, amount, cx, cy, owner));
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

    /// Bitcoin state proven by the relay (re-derived from relayed headers in SP1) — the
    /// trustless input to the bridge_mint root gate and the cross-lane spent-set.
    struct BitcoinRelayPublicValues {
        bytes32 bitcoinPoolRoot;  // the Bitcoin confidential-pool note-tree root
        bytes32 bitcoinSpentRoot; // the Bitcoin spent-nullifier IMT root at this height
        uint64 bitcoinHeight;     // the confirmed Bitcoin height the relay proved up to
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
        if (r.bitcoinHeight <= lastRelayHeight) revert StaleRelayProof();
        lastRelayHeight = r.bitcoinHeight;
        knownBitcoinRoot[r.bitcoinPoolRoot] = true;
        knownBitcoinSpentRoot = r.bitcoinSpentRoot;
        emit BitcoinRootAttested(r.bitcoinPoolRoot);
        emit BitcoinSpentRootReflected(r.bitcoinSpentRoot);
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

        // Cross-mint: a Bitcoin burn becomes an Ethereum note (leaf in pv.leaves),
        // gated one-mint-per-burn on its claimId — the tETH acceptedBitcoinBurns pattern.
        for (uint256 i; i < pv.bitcoinBurnsConsumed.length; ++i) {
            bytes32 claimId = pv.bitcoinBurnsConsumed[i];
            if (bridgeMinted[claimId]) revert BurnAlreadyMinted();
            bridgeMinted[claimId] = true;
            emit BridgeMinted(claimId);
        }

        // Every Bitcoin pool root a bridge_mint proved membership against must be
        // oracle-attested (canonical + confirmed) — the inflation-critical gate.
        for (uint256 i; i < pv.bitcoinRootsUsed.length; ++i) {
            if (!knownBitcoinRoot[pv.bitcoinRootsUsed[i]]) revert UnknownBitcoinRoot();
        }

        if (pv.leaves.length != 0) {
            uint256 firstLeafIndex = nextLeafIndex;
            for (uint256 i; i < pv.leaves.length; ++i) _insertLeaf(pv.leaves[i]);
            everKnownRoot[currentRoot] = true;
            emit LeavesInserted(firstLeafIndex, pv.leaves, memos);
        }

        for (uint256 i; i < pv.withdrawals.length; ++i) {
            Withdrawal memory w = pv.withdrawals[i];
            _payout(w.assetId, w.recipient, w.amount);
            emit Withdraw(w.assetId, w.recipient, w.amount);
        }

        for (uint256 i; i < pv.fees.length; ++i) {
            _payout(pv.fees[i].assetId, msg.sender, pv.fees[i].amount);
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

    function _payout(bytes32 assetId, address to, uint256 amount) internal {
        if (amount == 0) return;
        Asset storage a = assets[assetId];
        if (!a.registered) revert NotRegistered();
        if (to == address(0)) revert ZeroAddress();
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
