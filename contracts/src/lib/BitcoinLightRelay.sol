// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BitcoinLightRelay
/// @notice Epoch-based Bitcoin light client with heaviest-chain fork choice
///         and canonical-chain anchoring. Stores per-epoch difficulty targets,
///         epoch-start timestamps, and a chain tip tracked by cumulative work.
///         Anyone can advance the tip. Reorgs are supported: a competing chain
///         with more cumulative work overtakes the tip. Withdrawal proofs must
///         chain forward to the stored tip.
///
///         Operational notes:
///         - Tip advances are permissionless. Anyone can call advanceTip().
///         - Retargets occur every 2016 blocks. The relay must be at the exact
///           epoch boundary (tipHeight == epoch * 2016 - 1) before retarget().
///         - The relay requires exact tip equality for SP1 proof acceptance.
///           This means a relay tip advance between SP1 proof generation and
///           submission will make the proof stale. The prover should retry with
///           updated headers. For production, this can be relaxed to a finality
///           window (tip or ancestor within N blocks) without changing security.
///         - Genesis checkpoint is set by the deployer and is trusted. Values
///           should be independently verifiable from any Bitcoin block explorer.
///         - Deep reorgs crossing retarget boundaries are out of scope for v1.
///           The relay uses global epoch targets, not branch-specific retargets.
///           This is acceptable because such reorgs have never occurred on
///           Bitcoin mainnet (deepest historical reorg: 4 blocks, 2013).
contract BitcoinLightRelay {
    // ──────────────────── Constants ────────────────────

    uint256 public constant EPOCH_LENGTH = 2016;
    uint256 public constant TARGET_TIMESPAN = 14 * 24 * 60 * 60;
    uint256 public constant MAX_TARGET = 0x00000000ffff0000000000000000000000000000000000000000000000000000;
    uint256 public constant PROOF_LENGTH = 4;

    // ──────────────────── Storage ────────────────────

    address public immutable DEPLOYER;

    uint256 public genesisEpoch;
    uint256 public currentEpoch;
    mapping(uint256 => uint256) public epochTarget;
    mapping(uint256 => uint256) public epochStartTimestamp;

    // Heaviest-chain tip. advanceTip accepts any chain extending a known
    // ancestor with more cumulative work than the current tip.
    bytes32 public tip;
    uint256 public tipHeight;
    uint256 public tipWork;

    // Per-block-hash: stored parent + cumulative work for fork resolution.
    mapping(bytes32 => bytes32) public blockParent;
    mapping(bytes32 => uint256) public blockWork;
    mapping(bytes32 => uint256) public blockHeight;

    bool public initialized;

    // ──────────────────── Events ────────────────────

    event Genesis(uint256 indexed epoch, uint256 target, bytes32 tipHash);
    event TipAdvanced(bytes32 indexed newTip, uint256 newHeight, uint256 newWork);
    event Retarget(uint256 indexed oldEpoch, uint256 indexed newEpoch, uint256 newTarget);

    // ──────────────────── Errors ────────────────────

    error AlreadyInitialized();
    error ChainNotAnchored();
    error InvalidChainLength();
    error InvalidHeaderChain();
    error InvalidPoW();
    error InvalidTarget();
    error NotInitialized();
    error Unauthorized();
    error UnknownEpoch();
    error UnknownParent();

    // ──────────────────── Constructor ────────────────────

    constructor() { DEPLOYER = msg.sender; }

    // ──────────────────── Genesis ────────────────────

    function genesis(
        uint256 epochStart,
        uint256 target,
        uint256 startTimestamp,
        bytes32 tipHash,
        uint256 tipHeight_,
        uint256 tipWork_
    ) external {
        if (msg.sender != DEPLOYER) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        if (epochStart % EPOCH_LENGTH != 0) revert InvalidChainLength();
        if (target == 0 || target > MAX_TARGET) revert InvalidTarget();
        require(tipWork_ > 0);

        uint256 epoch = epochStart / EPOCH_LENGTH;
        genesisEpoch = epoch;
        currentEpoch = epoch;
        epochTarget[epoch] = target;
        epochStartTimestamp[epoch] = startTimestamp;

        tip = tipHash;
        tipHeight = tipHeight_;
        tipWork = tipWork_;
        blockWork[tipHash] = tipWork_;
        blockHeight[tipHash] = tipHeight_;

        initialized = true;
        emit Genesis(epoch, target, tipHash);
    }

    // ──────────────────── Tip advancement ────────────────────

    /// @notice Submit headers extending any known block. If the resulting
    ///         cumulative work exceeds the current tip, the tip is updated.
    ///         This implements Bitcoin's heaviest-chain fork choice.
    function advanceTip(bytes calldata headers) external {
        if (!initialized) revert NotInitialized();
        uint256 n = headers.length / 80;
        if (n == 0 || headers.length % 80 != 0) revert InvalidChainLength();

        bytes32 prevHash;
        uint256 cumWork;
        uint256 height;
        uint256 pendingEpochStart;
        uint256 pendingEpochTs;

        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 bh = _dsha256(h);
            (bytes32 prev, , uint32 ts, uint32 bits, ) = _parseHeader(h);

            if (i == 0) {
                // First header must extend a known block.
                if (blockWork[prev] == 0 && prev != tip) revert UnknownParent();
                cumWork = prev == tip ? tipWork : blockWork[prev];
                height = prev == tip ? tipHeight : blockHeight[prev];
                prevHash = prev;
            } else {
                if (prev != prevHash) revert InvalidHeaderChain();
            }

            ++height;
            uint256 epoch = height / EPOCH_LENGTH;
            uint256 expectedTarget = epochTarget[epoch];
            if (expectedTarget == 0) revert UnknownEpoch();

            uint256 target = _bitsToTarget(bits);
            if (target != expectedTarget) revert InvalidPoW();
            if (_reverseU256(uint256(bh)) > target) revert InvalidPoW();

            cumWork += _workFromTarget(target);
            prevHash = bh;

            // Store block metadata for fork resolution.
            blockParent[bh] = prev;
            blockWork[bh] = cumWork;
            blockHeight[bh] = height;

            // Track epoch-boundary timestamp; only commit when chain becomes tip.
            if (height % EPOCH_LENGTH == 0) {
                pendingEpochStart = height / EPOCH_LENGTH;
                pendingEpochTs = ts;
            }
        }

        // Heaviest-chain rule: update tip only if this chain has more work.
        if (cumWork > tipWork) {
            tip = prevHash;
            tipHeight = height;
            tipWork = cumWork;
            if (pendingEpochTs != 0 && epochStartTimestamp[pendingEpochStart] == 0) {
                epochStartTimestamp[pendingEpochStart] = pendingEpochTs;
            }
            emit TipAdvanced(prevHash, height, cumWork);
        }
    }

    // ──────────────────── Retarget ────────────────────

    /// @notice Submit headers spanning a difficulty retarget boundary.
    ///         Anchored: tip must be at the last block of the old epoch, and
    ///         the last old-epoch header in the proof must equal the stored tip.
    function retarget(bytes calldata headers) external {
        if (!initialized) revert NotInitialized();
        uint256 n = headers.length / 80;
        if (n != PROOF_LENGTH * 2 || headers.length % 80 != 0) revert InvalidChainLength();

        uint256 oldEpoch = currentEpoch;
        uint256 oldTarget = epochTarget[oldEpoch];
        if (oldTarget == 0) revert UnknownEpoch();

        // Tip must be at the last block of the old epoch.
        uint256 expectedLastOldHeight = ((oldEpoch + 1) * EPOCH_LENGTH) - 1;
        if (tipHeight != expectedLastOldHeight) revert ChainNotAnchored();

        uint256 lastOldTimestamp;
        bytes32 prevHash;

        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 bh = _dsha256(h);
            (bytes32 prev, , uint32 ts, uint32 bits, ) = _parseHeader(h);

            if (i > 0 && prev != prevHash) revert InvalidHeaderChain();

            uint256 target = _bitsToTarget(bits);

            if (i < PROOF_LENGTH) {
                if (target != oldTarget) revert InvalidPoW();
            } else if (i == PROOF_LENGTH) {
                uint256 epochStartTs = epochStartTimestamp[oldEpoch];
                uint256 elapsed = lastOldTimestamp - epochStartTs;
                if (elapsed < TARGET_TIMESPAN / 4) elapsed = TARGET_TIMESPAN / 4;
                if (elapsed > TARGET_TIMESPAN * 4) elapsed = TARGET_TIMESPAN * 4;
                uint256 rawTarget = (oldTarget * elapsed) / TARGET_TIMESPAN;
                if (rawTarget > MAX_TARGET) rawTarget = MAX_TARGET;
                // Compact-encode then re-expand to match Bitcoin's precision truncation.
                uint256 newTarget = _bitsToTarget(_targetToCompact(rawTarget));
                epochTarget[oldEpoch + 1] = newTarget;
                // Epoch start timestamp set by advanceTip when it processes
                // the first canonical block of the new epoch — not here.
                if (target != newTarget) revert InvalidPoW();
            } else {
                if (target != epochTarget[oldEpoch + 1]) revert InvalidPoW();
            }

            if (_reverseU256(uint256(bh)) > target) revert InvalidPoW();
            if (i == PROOF_LENGTH - 1) {
                lastOldTimestamp = ts;
                if (bh != tip) revert ChainNotAnchored();
            }
            prevHash = bh;
        }

        currentEpoch = oldEpoch + 1;
        emit Retarget(oldEpoch, oldEpoch + 1, epochTarget[oldEpoch + 1]);
    }

    // ──────────────────── Proof Verification ────────────────────

    /// @notice Validate headers from burn block forward to the stored tip.
    function verifyBlock(
        bytes calldata headers,
        uint256 blockHeight_,
        uint256 confirmations
    ) external view virtual returns (bytes32 merkleRoot) {
        if (!initialized) revert NotInitialized();
        uint256 n = headers.length / 80;
        if (headers.length % 80 != 0 || n < 1 + confirmations) revert InvalidChainLength();
        if (blockHeight_ + n - 1 != tipHeight) revert ChainNotAnchored();

        bytes32 prevHash;
        bytes32 lastHash;
        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 bh = _dsha256(h);
            (bytes32 prev, bytes32 mr, , uint32 bits, ) = _parseHeader(h);

            if (i > 0 && prev != prevHash) revert InvalidHeaderChain();

            uint256 height = blockHeight_ + i;
            uint256 epoch = height / EPOCH_LENGTH;
            uint256 expectedTarget = epochTarget[epoch];
            if (expectedTarget == 0) revert UnknownEpoch();

            uint256 target = _bitsToTarget(bits);
            if (target != expectedTarget) revert InvalidPoW();
            if (_reverseU256(uint256(bh)) > target) revert InvalidPoW();

            if (i == 0) merkleRoot = mr;
            prevHash = bh;
            lastHash = bh;
        }

        if (lastHash != tip) revert ChainNotAnchored();
    }

    // ──────────────────── Internal ────────────────────

    function _parseHeader(bytes memory raw)
        internal pure
        returns (bytes32 prevBlock, bytes32 merkleRoot, uint32 ts, uint32 bits, uint32 nonce)
    {
        assembly ("memory-safe") {
            let ptr := add(raw, 32)
            prevBlock := mload(add(ptr, 4))
            merkleRoot := mload(add(ptr, 36))
            let t := byte(0, mload(add(ptr, 68)))
            t := or(t, shl(8, byte(0, mload(add(ptr, 69)))))
            t := or(t, shl(16, byte(0, mload(add(ptr, 70)))))
            t := or(t, shl(24, byte(0, mload(add(ptr, 71)))))
            ts := t
            let b := byte(0, mload(add(ptr, 72)))
            b := or(b, shl(8, byte(0, mload(add(ptr, 73)))))
            b := or(b, shl(16, byte(0, mload(add(ptr, 74)))))
            b := or(b, shl(24, byte(0, mload(add(ptr, 75)))))
            bits := b
            let n := byte(0, mload(add(ptr, 76)))
            n := or(n, shl(8, byte(0, mload(add(ptr, 77)))))
            n := or(n, shl(16, byte(0, mload(add(ptr, 78)))))
            n := or(n, shl(24, byte(0, mload(add(ptr, 79)))))
            nonce := n
        }
    }

    function _bitsToTarget(uint32 bits) internal pure returns (uint256) {
        if (bits & 0x00800000 != 0) revert InvalidTarget();
        uint256 exp = bits >> 24;
        uint256 mantissa = bits & 0x7fffff;
        if (mantissa == 0) revert InvalidTarget();
        uint256 target;
        if (exp <= 3) {
            target = mantissa >> (8 * (3 - exp));
        } else {
            if (exp > 32) revert InvalidPoW();
            target = mantissa << (8 * (exp - 3));
        }
        if (target == 0 || target > MAX_TARGET) revert InvalidTarget();
        return target;
    }

    /// @dev Compact-encode a 256-bit target to nBits, matching Bitcoin's SetCompact.
    ///      Used to truncate the retarget arithmetic result to the precision that
    ///      Bitcoin headers actually carry.
    function _targetToCompact(uint256 target) internal pure returns (uint32) {
        if (target == 0) return 0;
        // Find the most significant byte position (1-indexed from the right).
        uint256 size;
        uint256 t = target;
        while (t > 0) { ++size; t >>= 8; }
        // Extract 3-byte mantissa from the top.
        uint256 mantissa;
        if (size <= 3) {
            mantissa = target << (8 * (3 - size));
        } else {
            mantissa = target >> (8 * (size - 3));
        }
        // If the high bit of the mantissa is set, shift right to avoid sign confusion.
        if (mantissa & 0x800000 != 0) { mantissa >>= 8; ++size; }
        return uint32((size << 24) | (mantissa & 0x7fffff));
    }

    function _workFromTarget(uint256 target) internal pure returns (uint256) {
        if (target == 0) return type(uint256).max;
        return (~target / (target + 1)) + 1;
    }

    function _reverseU256(uint256 v) internal pure returns (uint256 r) {
        assembly ("memory-safe") {
            r := byte(31, v)
            r := or(r, shl(8, byte(30, v)))
            r := or(r, shl(16, byte(29, v)))
            r := or(r, shl(24, byte(28, v)))
            r := or(r, shl(32, byte(27, v)))
            r := or(r, shl(40, byte(26, v)))
            r := or(r, shl(48, byte(25, v)))
            r := or(r, shl(56, byte(24, v)))
            r := or(r, shl(64, byte(23, v)))
            r := or(r, shl(72, byte(22, v)))
            r := or(r, shl(80, byte(21, v)))
            r := or(r, shl(88, byte(20, v)))
            r := or(r, shl(96, byte(19, v)))
            r := or(r, shl(104, byte(18, v)))
            r := or(r, shl(112, byte(17, v)))
            r := or(r, shl(120, byte(16, v)))
            r := or(r, shl(128, byte(15, v)))
            r := or(r, shl(136, byte(14, v)))
            r := or(r, shl(144, byte(13, v)))
            r := or(r, shl(152, byte(12, v)))
            r := or(r, shl(160, byte(11, v)))
            r := or(r, shl(168, byte(10, v)))
            r := or(r, shl(176, byte(9, v)))
            r := or(r, shl(184, byte(8, v)))
            r := or(r, shl(192, byte(7, v)))
            r := or(r, shl(200, byte(6, v)))
            r := or(r, shl(208, byte(5, v)))
            r := or(r, shl(216, byte(4, v)))
            r := or(r, shl(224, byte(3, v)))
            r := or(r, shl(232, byte(2, v)))
            r := or(r, shl(240, byte(1, v)))
            r := or(r, shl(248, byte(0, v)))
        }
    }

    function _dsha256(bytes memory d) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(d)));
    }
}
