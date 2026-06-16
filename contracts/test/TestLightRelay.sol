// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../src/lib/BitcoinLightRelay.sol";

/// @dev Test relay that skips PoW and tip-anchoring checks.
///      Validates chain linkage only. Production uses BitcoinLightRelay directly.
contract TestLightRelay is BitcoinLightRelay {
    function verifyBlock(
        bytes calldata headers,
        uint256,
        uint256 confirmations
    ) external view override returns (bytes32 merkleRoot) {
        uint256 n = headers.length / 80;
        if (headers.length % 80 != 0 || n < 1 + confirmations) revert InvalidChainLength();

        bytes32 prevHash;
        for (uint256 i; i < n; ++i) {
            bytes memory h = bytes(headers[i * 80:(i + 1) * 80]);
            bytes32 blockHash = _dsha256(h);
            (bytes32 prev, bytes32 mr, , ) = _parseHeader(h);
            if (i > 0 && prev != prevHash) revert InvalidHeaderChain();
            if (i == 0) merkleRoot = mr;
            prevHash = blockHash;
        }
    }

    /// @dev Test hooks for the median-time-past check. advanceTip's real PoW
    ///      validation makes synthetic headers impractical, so seed the maps
    ///      directly and exercise the median logic in isolation.
    function seedBlock(bytes32 bh, bytes32 parent, uint32 ts) external {
        blockParent[bh] = parent;
        blockTimestamp[bh] = ts;
    }

    function exposed_medianTimePast(bytes32 parent) external view returns (uint32) {
        return _medianTimePast(parent);
    }

    /// @dev Set tip/height directly so the finality-window anchor check can be
    ///      exercised in isolation (advanceTip's real PoW makes synthetic tips
    ///      impractical), mirroring the median-time-past test hooks above.
    function seedTip(bytes32 t, uint256 th) external {
        tip = t;
        tipHeight = th;
    }

    function exposed_anchorChain(uint256 endHeight, bytes32 lastHash) external view {
        _anchorChain(endHeight, lastHash);
    }

    /// @dev Expose the retarget compact-encoding helpers for round-trip tests.
    function exposed_bitsToTarget(uint32 bits) external pure returns (uint256) {
        return _bitsToTarget(bits);
    }

    function exposed_targetToCompact(uint256 target) external pure returns (uint32) {
        return _targetToCompact(target);
    }

    function exposed_retargetTarget(uint256 oldTarget, uint256 firstTs, uint256 lastTs)
        external pure returns (uint256)
    {
        return _retargetTarget(oldTarget, firstTs, lastTs);
    }
}
