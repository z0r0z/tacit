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
            (bytes32 prev, bytes32 mr, , , ) = _parseHeader(h);
            if (i > 0 && prev != prevHash) revert InvalidHeaderChain();
            if (i == 0) merkleRoot = mr;
            prevHash = blockHash;
        }
    }
}
