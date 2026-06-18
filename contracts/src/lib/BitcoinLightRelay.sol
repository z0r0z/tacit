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
///           epoch boundary (tipHeight == (currentEpoch + 1) * 2016 - 1) before retarget().
///         - Withdrawal burn-inclusion proofs (verifyBlock) anchor to the tip
///           or a recent ancestor within FINALITY_WINDOW, and SP1 state proofs
///           tolerate the same window in the verifier — so a tip advance between
///           proof construction and submission doesn't revert. Burial depth is
///           preserved: the chain end sits at or below the tip.
///         - Genesis checkpoint is set by the deployer and is trusted. Values
///           should be independently verifiable from any Bitcoin block explorer.
///         - Deep reorgs crossing retarget boundaries are currently out of scope.
///           The relay uses global epoch targets, not branch-specific retargets.
///           This is acceptable because such reorgs have never occurred on
///           Bitcoin mainnet (deepest historical reorg: 4 blocks, 2013).
contract BitcoinLightRelay {
    // ──────────────────── Constants ────────────────────

    uint256 public constant EPOCH_LENGTH = 2016;
    uint256 public constant TARGET_TIMESPAN = 14 * 24 * 60 * 60;
    // Difficulty floor: the easiest (largest) valid target — caps genesis + retarget. NETWORK-SPECIFIC, so
    // it is a ctor immutable, NOT a constant: MAINNET MUST pass the canonical mainnet cap
    // 0x00000000ffff0000…; signet passes its (easier, larger) powLimit 0x00000377ae… (signet blocks are
    // below mainnet difficulty, so the mainnet cap would reject every real signet header).
    uint256 public immutable MAX_TARGET;
    uint256 public constant PROOF_LENGTH = 4;
    /// Burn-inclusion proofs (verifyBlock) may anchor to the tip or a recent
    /// ancestor within this many blocks, so a tip advance between header fetch
    /// and withdrawal submission doesn't revert. Burial depth is preserved —
    /// the chain end is at or below the tip, so the burn stays >= confirmations
    /// deep below the canonical tip.
    uint256 public constant FINALITY_WINDOW = 6;

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
    /// @notice Header `timestamp` per block. Feeds advanceTip's median-time-past
    ///         check (Bitcoin's consensus rule: a header's ts must exceed the
    ///         median of up to the last 11 ancestors' timestamps).
    mapping(bytes32 => uint32) public blockTimestamp;

    bool public initialized;

    // ──────────────────── Events ────────────────────

    event Genesis(uint256 indexed epoch, uint256 target, bytes32 tipHash);
    event TipAdvanced(bytes32 indexed newTip, uint256 newHeight, uint256 newWork);
    event Retarget(uint256 indexed oldEpoch, uint256 indexed newEpoch, uint256 newTarget);

    // ──────────────────── Errors ────────────────────

    error AlreadyInitialized();
    error ChainNotAnchored();
    error InvalidAnchor();
    error InvalidChainLength();
    error InvalidHeaderChain();
    error InvalidPoW();
    error InvalidTarget();
    error InvalidTimestamp();
    error NotInitialized();
    error Unauthorized();
    error UnknownEpoch();
    error UnknownParent();

    // ──────────────────── Constructor ────────────────────

    constructor(uint256 maxTarget_) {
        if (maxTarget_ == 0) revert InvalidTarget();
        DEPLOYER = msg.sender;
        MAX_TARGET = maxTarget_;
    }

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
        // The target must be compact-canonical: equal to the decode of its own nBits
        // encoding. advanceTip checks each header against _bitsToTarget(bits), and every
        // retarget result is already compact-truncated — so a non-canonical genesis
        // target matches no real header and silently bricks the relay at the first
        // advance. Reject it here so a malformed checkpoint fails loud at deploy rather
        // than locking the bridge behind an immutable contract. (This makes every stored
        // epochTarget canonical: genesis here, retargets via _retargetTarget's round-trip.)
        if (target != _bitsToTarget(_targetToCompact(target))) revert InvalidTarget();
        // The anchor checkpoint must be a real block with non-zero cumulative work: a zero tipHash
        // terminates the blockParent / median-time-past walks early (bytes32(0) is the walk sentinel)
        // and a zero tipWork lets any single-block chain overtake the bare anchor, so reject both.
        if (tipHash == bytes32(0) || tipWork_ == 0) revert InvalidAnchor();
        // The anchor must sit inside the seeded epoch [epochStart, epochStart + EPOCH_LENGTH):
        // only this epoch's target is stored below. An anchor at or beyond the next epoch
        // start has no stored target for the block above it, so the first advanceTip reverts
        // UnknownEpoch and bricks the relay. An anchor at the epoch's last block stays in
        // range — there the boundary is crossed by retarget() (which sets the next target)
        // before advanceTip, never by advanceTip alone.
        if (tipHeight_ < epochStart || tipHeight_ >= epochStart + EPOCH_LENGTH) revert InvalidChainLength();
        // startTimestamp is cast to the anchor's uint32 header timestamp; a value
        // past uint32 would truncate and corrupt the median-time-past baseline.
        if (startTimestamp > type(uint32).max) revert InvalidTimestamp();

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
        // startTimestamp MUST be the genesis epoch's first-block timestamp
        // (height == epochStart): the first retarget() computes elapsed against
        // epochStartTimestamp[epoch] above, so a wrong value there mis-targets
        // the next epoch and bricks tip advancement at the boundary. The tip may
        // be anchored mid-epoch (tipHeight_ >= epochStart); seeding the anchor's
        // stored timestamp with the epoch-start value (<= the anchor's own ts)
        // gives advanceTip's median-time-past check a safe, loose baseline until
        // the anchor ages out of the 11-block window.
        blockTimestamp[tipHash] = uint32(startTimestamp);

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
            (bytes32 prev, , uint32 ts, uint32 bits) = _parseHeader(h);

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

            // Timestamp validation. (a) Future-drift: header ts must not exceed
            // block.timestamp + 2h (Bitcoin Core's MAX_FUTURE_BLOCK_TIME).
            // (b) Median-time-past: header ts must exceed the median of up to the
            // last 11 ancestors' timestamps — Bitcoin's actual consensus rule. A
            // block's timestamp need NOT exceed its immediate parent's (miner
            // clocks drift, so a valid block's ts can dip below its parent's), so a
            // strict-monotonic check wrongly rejects canonical headers and would
            // stall the tip permanently the first time Bitcoin mines a sub-parent
            // timestamp — which happens every few blocks.
            if (ts > block.timestamp + 7200) revert InvalidTimestamp();
            {
                uint32 mtp = _medianTimePast(prev);
                if (mtp != 0 && ts <= mtp) revert InvalidTimestamp();
            }

            cumWork += _workFromTarget(target);
            prevHash = bh;

            // Store block metadata for fork resolution.
            blockParent[bh] = prev;
            blockWork[bh] = cumWork;
            blockHeight[bh] = height;
            blockTimestamp[bh] = ts;

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
            // Commit the new epoch's first-block timestamp from the WINNING chain. Overwrite (not
            // first-write-wins): a sub-finality-window reorg can replace the boundary block, and
            // retarget() reads this value as the epoch-start anchor — caching the losing fork's
            // timestamp would mis-target the next epoch (even a 1s difference flips the compact
            // mantissa) and permanently revert retarget(). The winning chain is canonical by the
            // work rule, so its boundary timestamp is the correct one. (Genesis-epoch start stays
            // the deployer value: blocks below the anchor are never re-submitted here.)
            if (pendingEpochTs != 0) {
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
            (bytes32 prev, , uint32 ts, uint32 bits) = _parseHeader(h);

            if (i > 0 && prev != prevHash) revert InvalidHeaderChain();

            uint256 target = _bitsToTarget(bits);

            if (i < PROOF_LENGTH) {
                if (target != oldTarget) revert InvalidPoW();
            } else if (i == PROOF_LENGTH) {
                uint256 newTarget = _retargetTarget(oldTarget, epochStartTimestamp[oldEpoch], lastOldTimestamp);
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

        bytes32 prevHash;
        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 bh = _dsha256(h);
            (bytes32 prev, bytes32 mr, , uint32 bits) = _parseHeader(h);

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
        }

        _anchorChain(blockHeight_ + n - 1, prevHash);
    }

    /// @dev A burn-inclusion chain anchors if it ends at the tip or a canonical
    ///      ancestor within FINALITY_WINDOW; lastHash must be the relay's block
    ///      at endHeight (reached by walking blockParent back from the tip), so a
    ///      forged side-chain at a valid height is rejected. Burial depth is
    ///      preserved: endHeight <= tipHeight, so the burn stays >= confirmations
    ///      deep below the canonical tip.
    function _anchorChain(uint256 endHeight, bytes32 lastHash) internal view {
        if (endHeight > tipHeight || endHeight + FINALITY_WINDOW < tipHeight) revert ChainNotAnchored();
        bytes32 anchor = tip;
        for (uint256 h = tipHeight; h > endHeight; --h) anchor = blockParent[anchor];
        if (anchor != lastHash) revert ChainNotAnchored();
    }

    // ──────────────────── Internal ────────────────────

    function _parseHeader(bytes memory raw)
        internal pure
        returns (bytes32 prevBlock, bytes32 merkleRoot, uint32 ts, uint32 bits)
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
        }
    }

    function _bitsToTarget(uint32 bits) internal view virtual returns (uint256) {
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

    /// @dev The next epoch's difficulty target from Bitcoin's retarget formula:
    ///      newTarget = clamp(oldTarget * actualTimespan / TARGET_TIMESPAN), compact-truncated.
    ///      `lastTs - firstTs` is Bitcoin's SIGNED nActualTimespan; a last-block timestamp earlier than
    ///      the first-block timestamp (a negative span) floors to 0 here, which the [TARGET_TIMESPAN/4,
    ///      TARGET_TIMESPAN*4] clamp lifts to TARGET_TIMESPAN/4 — the exact value Bitcoin Core computes —
    ///      rather than reverting on the uint underflow (which would brick the relay at that boundary).
    function _retargetTarget(uint256 oldTarget, uint256 firstTs, uint256 lastTs) internal view returns (uint256) {
        uint256 elapsed = lastTs > firstTs ? lastTs - firstTs : 0;
        if (elapsed < TARGET_TIMESPAN / 4) elapsed = TARGET_TIMESPAN / 4;
        if (elapsed > TARGET_TIMESPAN * 4) elapsed = TARGET_TIMESPAN * 4;
        uint256 rawTarget = (oldTarget * elapsed) / TARGET_TIMESPAN;
        if (rawTarget > MAX_TARGET) rawTarget = MAX_TARGET;
        // Compact-encode then re-expand to match Bitcoin's precision truncation.
        return _bitsToTarget(_targetToCompact(rawTarget));
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
            r := byte(0, v)
            r := or(r, shl(8, byte(1, v)))
            r := or(r, shl(16, byte(2, v)))
            r := or(r, shl(24, byte(3, v)))
            r := or(r, shl(32, byte(4, v)))
            r := or(r, shl(40, byte(5, v)))
            r := or(r, shl(48, byte(6, v)))
            r := or(r, shl(56, byte(7, v)))
            r := or(r, shl(64, byte(8, v)))
            r := or(r, shl(72, byte(9, v)))
            r := or(r, shl(80, byte(10, v)))
            r := or(r, shl(88, byte(11, v)))
            r := or(r, shl(96, byte(12, v)))
            r := or(r, shl(104, byte(13, v)))
            r := or(r, shl(112, byte(14, v)))
            r := or(r, shl(120, byte(15, v)))
            r := or(r, shl(128, byte(16, v)))
            r := or(r, shl(136, byte(17, v)))
            r := or(r, shl(144, byte(18, v)))
            r := or(r, shl(152, byte(19, v)))
            r := or(r, shl(160, byte(20, v)))
            r := or(r, shl(168, byte(21, v)))
            r := or(r, shl(176, byte(22, v)))
            r := or(r, shl(184, byte(23, v)))
            r := or(r, shl(192, byte(24, v)))
            r := or(r, shl(200, byte(25, v)))
            r := or(r, shl(208, byte(26, v)))
            r := or(r, shl(216, byte(27, v)))
            r := or(r, shl(224, byte(28, v)))
            r := or(r, shl(232, byte(29, v)))
            r := or(r, shl(240, byte(30, v)))
            r := or(r, shl(248, byte(31, v)))
        }
    }

    function _dsha256(bytes memory d) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(d)));
    }

    /// @dev Bitcoin median-time-past: the median of up to the last 11 ancestors'
    ///      timestamps, walking blockParent from `parent`. Returns 0 only if no
    ///      ancestor timestamp is stored (pre-genesis). Near genesis fewer than 11
    ///      ancestors exist; the median of what is available is used, matching
    ///      Bitcoin's own behaviour for the early chain. Ancestors added earlier in
    ///      the same advanceTip batch are already in storage, so the window spans
    ///      the batch and the stored chain seamlessly.
    function _medianTimePast(bytes32 parent) internal view returns (uint32) {
        uint32[11] memory window;
        uint256 count;
        bytes32 cur = parent;
        while (count < 11 && cur != bytes32(0)) {
            uint32 t = blockTimestamp[cur];
            if (t == 0) break;
            window[count++] = t;
            cur = blockParent[cur];
        }
        if (count == 0) return 0;
        // Insertion sort window[0..count); count <= 11.
        for (uint256 i = 1; i < count; ++i) {
            uint32 key = window[i];
            uint256 j = i;
            while (j > 0 && window[j - 1] > key) { window[j] = window[j - 1]; --j; }
            window[j] = key;
        }
        return window[count / 2];
    }
}
