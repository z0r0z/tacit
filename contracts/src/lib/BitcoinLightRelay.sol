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
///         - Retargets occur every 2016 blocks and are handled inside advanceTip(): the first block
///           of a new epoch derives its target from its OWN branch's just-completed epoch, so any
///           branch — not just the current tip — can cross a boundary.
///         - Withdrawal burn-inclusion proofs (verifyBlock) anchor to the tip
///           or a recent ancestor within FINALITY_WINDOW, and SP1 state proofs
///           tolerate the same window in the verifier — so a tip advance between
///           proof construction and submission doesn't revert. Burial depth is
///           preserved: the chain end sits at or below the tip.
///         - Genesis checkpoint is set by the deployer and is trusted. Values
///           should be independently verifiable from any Bitcoin block explorer.
///         - Difficulty targets AND epoch-start timestamps are stored PER BLOCK (blockTarget, epochStartTs),
///           never per epoch: a per-epoch global could only ever be crossed on the current tip, so a reorg of
///           a boundary-height tip pinned the relay to the orphan forever (R-1). Per-block storage also makes a
///           boundary crossing O(1) instead of a 2015-parent walk. Reorgs follow ordinary heaviest-chain fork
///           choice, across boundaries included.
abstract contract BitcoinLightRelayBase {
    // ──────────────────── Constants ────────────────────

    uint256 public constant EPOCH_LENGTH = 2016;
    uint256 public constant TARGET_TIMESPAN = 14 * 24 * 60 * 60;
    // Difficulty floor: the easiest (largest) valid target — caps genesis + retarget. NETWORK-SPECIFIC, so
    // it is a ctor immutable, NOT a constant: MAINNET MUST pass the canonical mainnet cap
    // 0x00000000ffff0000…; signet passes its (easier, larger) powLimit 0x00000377ae… (signet blocks are
    // below mainnet difficulty, so the mainnet cap would reject every real signet header).
    uint256 public immutable MAX_TARGET;
    /// Burn-inclusion proofs (verifyBlock) may anchor to the tip or a recent
    /// ancestor within this many blocks, so a tip advance between header fetch
    /// and withdrawal submission doesn't revert. Burial depth is preserved —
    /// the chain end is at or below the tip, so the burn stays >= confirmations
    /// deep below the canonical tip.
    uint256 public constant FINALITY_WINDOW = 6;

    // ──────────────────── Storage ────────────────────

    address public immutable DEPLOYER;

    uint256 public genesisEpoch;
    /// @notice The genesis epoch's first-block timestamp, seeded by the deployer. Read ONLY for
    ///         genesisEpoch (that block sits below the mid-epoch anchor and is never submitted);
    ///         every later epoch's start timestamp is carried per-block in `epochStartTs`.
    mapping(uint256 => uint256) public epochStartTimestamp;
    /// @notice Per-block first-block timestamp of the block's OWN epoch — the branch-local, O(1) source for
    ///         the retarget timespan. A block inherits its parent's value within an epoch and takes its own
    ///         timestamp when it opens a new epoch (height % EPOCH_LENGTH == 0); the anchor is seeded with the
    ///         genesis epoch-start ts. This replaces walking `blockParent` back to the epoch's first block, so a
    ///         retarget boundary costs one SSTORE per header instead of a 2015-SLOAD walk — and it stays
    ///         branch-local, so a reorg that crosses a boundary derives the timespan from its OWN headers.
    mapping(bytes32 => uint32) public epochStartTs;

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
    /// @notice The difficulty target each block was mined at, on its OWN branch. Within an epoch a block
    ///         inherits its parent's target; the first block of a new epoch derives a fresh target from its
    ///         branch's just-completed epoch (its first-block ts + the boundary block's ts). Keying the target
    ///         per-block rather than per-epoch is what lets a reorg cross a retarget boundary on ANY branch: the
    ///         old single global `epochTarget[epoch]` could only be crossed on the current tip (R-1 freeze).
    mapping(bytes32 => uint256) public blockTarget;

    bool public initialized;

    // ──────────────────── Events ────────────────────

    event Genesis(uint256 indexed epoch, uint256 target, bytes32 tipHash);
    event TipAdvanced(bytes32 indexed newTip, uint256 newHeight, uint256 newWork);

    // ──────────────────── Errors ────────────────────

    error InvalidPoW();
    error Unauthorized();
    error UnknownEpoch();
    error InvalidAnchor();
    error InvalidTarget();
    error UnknownParent();
    error NotInitialized();
    error ChainNotAnchored();
    error InvalidTimestamp();
    error AlreadyInitialized();
    error InvalidChainLength();
    error InvalidHeaderChain();

    // ──────────────────── Constructor ────────────────────

    constructor(uint256 maxTarget_) {
        if (maxTarget_ == 0) revert InvalidTarget();
        DEPLOYER = msg.sender;
        MAX_TARGET = maxTarget_;
    }

    // ──────────────────── Genesis ────────────────────

    /// @param startTimestamp the genesis epoch's FIRST-block (height == epochStart) header timestamp. DEPLOY-
    ///        CRITICAL (R-3): it seeds the first retarget's timespan, and a wrong value — even off by ONE
    ///        second — mis-targets epoch genesisEpoch+1 (a 1s error flips the compact mantissa) and bricks the
    ///        relay at the first boundary, after the pool is funded. It cannot be verified on-chain: the epoch's
    ///        first block sits below the mid-epoch anchor and is never submitted. The deploy checklist MUST take
    ///        it from the REAL first-block header (never hand-type it) and cross-check the exact value against
    ///        two independent block explorers, recording it in the deployment artifact beside the anchor.
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
        // blockTarget canonical: the genesis seed here, boundary derivations via _retargetTarget's
        // round-trip, and in-epoch inheritance of an already-canonical parent value.)
        if (target != _bitsToTarget(_targetToCompact(target))) revert InvalidTarget();
        // The anchor checkpoint must be a real block with non-zero cumulative work: a zero tipHash
        // terminates the blockParent / median-time-past walks early (bytes32(0) is the walk sentinel)
        // and a zero tipWork lets any single-block chain overtake the bare anchor, so reject both.
        if (tipHash == bytes32(0) || tipWork_ == 0) revert InvalidAnchor();
        // The anchor must sit inside the seeded epoch, in [epochStart, epochStart + EPOCH_LENGTH - 1):
        // only this epoch's target is stored below, so an anchor at or beyond the next epoch start has no
        // stored target for the block above it (first advanceTip reverts UnknownEpoch, bricking the relay).
        // The LAST block of the epoch (epochStart + EPOCH_LENGTH - 1) is ALSO rejected: the first boundary
        // crossing derives the next target with lastTs = blockTimestamp[boundary], and for a boundary anchor
        // that is the seeded startTimestamp (== the epoch-start ts), giving elapsed 0 → a mis-clamped target
        // that rejects every real next-epoch header and bricks the relay at the first retarget. Excluding the
        // boundary block means the boundary is always reached by advanceTip and carries its own real timestamp.
        if (tipHeight_ < epochStart || tipHeight_ >= epochStart + EPOCH_LENGTH - 1) revert InvalidChainLength();
        // startTimestamp is cast to the anchor's uint32 header timestamp; a value past uint32 would truncate
        // and corrupt the median-time-past baseline, and zero would store a 0 anchor timestamp that makes
        // `_medianTimePast` return 0 and silently disable the `ts <= mtp` rule for every block above the anchor.
        if (startTimestamp == 0 || startTimestamp > type(uint32).max) revert InvalidTimestamp();

        uint256 epoch = epochStart / EPOCH_LENGTH;
        genesisEpoch = epoch;
        epochStartTimestamp[epoch] = startTimestamp;

        tip = tipHash;
        tipHeight = tipHeight_;
        tipWork = tipWork_;
        blockWork[tipHash] = tipWork_;
        blockHeight[tipHash] = tipHeight_;
        blockTarget[tipHash] = target; // the anchor's epoch target; blocks above it inherit/derive from here
        // startTimestamp MUST be the genesis epoch's first-block timestamp (height == epochStart): the anchor's
        // epochStartTs is seeded with it below and inherited up the chain, so the first boundary crossing
        // computes elapsed against it — a wrong value mis-targets the next epoch and bricks tip advancement at
        // the boundary. The anchor's own stored timestamp is seeded with this same value as an MTP baseline.
        // NEAR-GENESIS MTP CAVEAT (deploy-checklist, low): the anchor has no stored ancestors, so
        // _medianTimePast for the first <=11 descendants runs on a partial window seeded here at the epoch-start
        // ts (<= the anchor's real ts). That window is more permissive than Bitcoin's full 11-block median, so
        // a header with a below-real-MTP timestamp could be accepted locally for ~11 blocks after genesis.
        // Exploiting it needs a full-difficulty mined header with a manipulated timestamp (a real block never
        // carries a below-MTP ts), and the window is bounded — so this is left as an operational note: anchor
        // the relay at a deeply-buried, stable block. It does not affect PoW, work, or retarget validation.
        blockTimestamp[tipHash] = uint32(startTimestamp);
        epochStartTs[tipHash] = uint32(startTimestamp); // anchor inherits the genesis epoch's first-block ts

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

        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 bh = _dsha256(h);
            (bytes32 prev,, uint32 ts, uint32 bits) = _parseHeader(h);

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
            // Derive this block's difficulty target from ITS OWN branch, not a single global per-epoch value —
            // this is what lets a reorg cross a retarget boundary on ANY branch (the R-1 fix). Within an epoch a
            // block carries its parent's target; the first block of a new epoch (height % EPOCH_LENGTH == 0)
            // derives a fresh target from its branch's just-completed epoch — `prev` is that epoch's last block,
            // and `epochStartTs[prev]` is that epoch's first-block timestamp (carried per-block on prev's own
            // branch), so a fork's boundary block yields the fork's own target rather than the tip's.
            uint256 parentTarget = blockTarget[prev];
            if (parentTarget == 0) revert UnknownEpoch();
            uint256 expectedTarget = height % EPOCH_LENGTH == 0
                ? _retargetTarget(parentTarget, epochStartTs[prev], blockTimestamp[prev])
                : parentTarget;

            // Exact canonical compact, not just an equal-decoding alias: Bitcoin Core rejects a non-canonical
            // nBits (e.g. a leading-zero mantissa) that decodes to the same target. expectedTarget is canonical
            // (genesis guard + _retargetTarget round-trip + inheritance), so this is the nBits a real header
            // carries and the decoded target equals expectedTarget — no separate _bitsToTarget needed.
            if (bits != _targetToCompact(expectedTarget)) revert InvalidPoW();
            _verifyPow(bh, expectedTarget);

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

            cumWork += _workFromTarget(expectedTarget);
            prevHash = bh;

            // Store block metadata for fork resolution.
            blockParent[bh] = prev;
            blockWork[bh] = cumWork;
            blockHeight[bh] = height;
            blockTimestamp[bh] = ts;
            blockTarget[bh] = expectedTarget; // per-branch target this block was mined at (inherited or derived)
            // Branch-local epoch-start ts: a block that opens a new epoch records its own timestamp; every other
            // block inherits its parent's. This is the value a later boundary crossing on this branch reads.
            epochStartTs[bh] = height % EPOCH_LENGTH == 0 ? ts : epochStartTs[prev];
        }

        // Heaviest-chain rule: update tip only if this chain has more work.
        if (cumWork > tipWork) {
            tip = prevHash;
            tipHeight = height;
            tipWork = cumWork;
            // No global epoch-start cache is written here: a boundary crossing reads its branch's epoch-start
            // timestamp from `epochStartTs[prev]`, carried per-block on that branch — never from a global
            // per-epoch cache, which would be written by whichever branch won at the time and would mis-target
            // a later crossing on a branch that replaced the boundary block. The anchor's value is seeded once
            // by the deployer (the genesis epoch's first block sits below it and is never submitted).
            emit TipAdvanced(prevHash, height, cumWork);
        }
    }

    // ──────────────────── Proof Verification ────────────────────

    /// @notice Validate headers from burn block forward to the stored tip.
    function verifyBlock(bytes calldata headers, uint256 blockHeight_, uint256 confirmations)
        external
        view
        virtual
        returns (bytes32 merkleRoot)
    {
        if (!initialized) revert NotInitialized();
        uint256 n = headers.length / 80;
        if (headers.length % 80 != 0 || n < 1 + confirmations) revert InvalidChainLength();

        bytes32 prevHash;
        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 bh = _dsha256(h);
            (bytes32 prev, bytes32 mr,, uint32 bits) = _parseHeader(h);

            if (i > 0 && prev != prevHash) revert InvalidHeaderChain();

            // Per-branch target: the burn block + its confirmations are canonical (advanceTip stored them),
            // so read the exact target this block was mined at. An unknown block (0) — a fabricated header at a
            // valid height — is rejected here, and _anchorChain below still pins the chain end to the tip.
            uint256 expectedTarget = blockTarget[bh];
            if (expectedTarget == 0) revert UnknownEpoch();
            // Exact canonical compact, not just an equal-decoding alias (Bitcoin Core rejects a non-canonical
            // nBits that decodes equal). expectedTarget is canonical, so this is the nBits a real header carries.
            if (bits != _targetToCompact(expectedTarget)) revert InvalidPoW();
            if (_reverseU256(uint256(bh)) > expectedTarget) revert InvalidPoW();

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
        for (uint256 h = tipHeight; h > endHeight; --h) {
            anchor = blockParent[anchor];
        }
        if (anchor != lastHash) revert ChainNotAnchored();
    }

    // ──────────────────── Internal ────────────────────

    function _parseHeader(bytes memory raw)
        internal
        pure
        returns (bytes32 prevBlock, bytes32 merkleRoot, uint32 ts, uint32 bits)
    {
        assembly ("memory-safe") {
            let ptr := add(raw, 32)
            prevBlock := mload(add(ptr, 4))
            merkleRoot := mload(add(ptr, 36))
            // One in-bounds word covers header bytes [44,76) — both the timestamp (68..71) and the compact
            // target (72..75) — so the reads stay inside the 80-byte header's allocation (memory-safe).
            let w := mload(add(ptr, 44))
            ts := or(or(byte(24, w), shl(8, byte(25, w))), or(shl(16, byte(26, w)), shl(24, byte(27, w))))
            bits := or(or(byte(28, w), shl(8, byte(29, w))), or(shl(16, byte(30, w)), shl(24, byte(31, w))))
        }
    }

    /// @dev Proof-of-work check: the block hash (little-endian) must not exceed its target. `virtual` ONLY on
    ///      this abstract base so a test relay (extending the base) can mock PoW and exercise
    ///      fork-choice/target-inheritance logic with synthetic headers that can't be mined in-test. The
    ///      production `BitcoinLightRelay` below SEALS it (non-virtual override), so a deployed relay whose
    ///      source is BitcoinLightRelay is provably PoW-enforcing and cannot be a one-line mock (R-A).
    function _verifyPow(bytes32 bh, uint256 target) internal view virtual {
        if (_reverseU256(uint256(bh)) > target) revert InvalidPoW();
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
        while (t > 0) {
            ++size;
            t >>= 8;
        }
        // Extract 3-byte mantissa from the top.
        uint256 mantissa;
        if (size <= 3) {
            mantissa = target << (8 * (3 - size));
        } else {
            mantissa = target >> (8 * (size - 3));
        }
        // If the high bit of the mantissa is set, shift right to avoid sign confusion.
        if (mantissa & 0x800000 != 0) {
            mantissa >>= 8;
            ++size;
        }
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
            while (j > 0 && window[j - 1] > key) {
                window[j] = window[j - 1];
                --j;
            }
            window[j] = key;
        }
        return window[count / 2];
    }
}

/// @title BitcoinLightRelay — production relay.
/// @notice Seals the proof-of-work check and the header validator so the deployed bytecode is provably
///         PoW-enforcing. Because these overrides are non-virtual, no contract extending BitcoinLightRelay can
///         re-mock PoW; a test double that skips PoW must extend BitcoinLightRelayBase directly and is therefore
///         a DIFFERENT contract with different verified source. So confirming a deployed relay's source is
///         `BitcoinLightRelay` is sufficient to know PoW is enforced — closing R-A (a mislinked or mocked relay
///         can no longer masquerade as the real one behind the pool's bare IRelay address).
contract BitcoinLightRelay is BitcoinLightRelayBase {
    constructor(uint256 maxTarget_) BitcoinLightRelayBase(maxTarget_) {}

    /// Seals the proof-of-work check on the pool-critical path: `advanceTip` (which sets `blockTarget` /
    /// `knownBitcoinRoot`, the pool's mint authority) calls `_verifyPow`, so a non-virtual override here means
    /// no `is BitcoinLightRelay` subclass can skip PoW. `verifyBlock` (base, virtual) is used only by the
    /// out-of-scope mixer, never by the pool.
    function _verifyPow(bytes32 bh, uint256 target) internal view override {
        super._verifyPow(bh, target);
    }

    /// Seals the difficulty decode too, so a deployed BitcoinLightRelay's target derivation is the mainnet
    /// rule (a signet/testnet relay that loosens it must extend the base — a different, separately-verified
    /// contract). `advanceTip` decodes each header's target through this, so it is pool-critical.
    function _bitsToTarget(uint32 bits) internal view override returns (uint256) {
        return super._bitsToTarget(bits);
    }
}
