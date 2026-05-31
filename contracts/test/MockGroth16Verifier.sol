// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../src/TacitBridgeMixer.sol";

/// @dev Mock Groth16 verifier that always returns true.
contract MockGroth16Verifier is IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external pure returns (bool) {
        return true;
    }
}

/// @dev Mock Groth16 verifier that always returns false.
contract RejectingGroth16Verifier is IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external pure returns (bool) {
        return false;
    }
}

/// @dev Mock SP1 pool root verifier. All burns accepted.
contract MockPoolRootVerifier is IPoolRootVerifier {
    mapping(bytes32 => bool) public poolIdSet;
    bytes32 public ASSET_ID;
    address public MIXER;

    constructor(bytes32[] memory poolIds_, bytes32 assetId_, address mixer_) {
        ASSET_ID = assetId_;
        MIXER = mixer_;
        for (uint256 i; i < poolIds_.length; ++i) poolIdSet[poolIds_[i]] = true;
    }

    function isAcceptedBurn(bytes32) external pure returns (bool) { return true; }
    function coversPool(bytes32 pid) external view returns (bool) { return poolIdSet[pid]; }
    // Default mock: always returns 0 (empty pool) so capacity gate is open.
    // Tests that need to exercise the gate use MockPoolRootVerifierWithIndex.
    function lastProvenPoolIndex(uint8) external pure returns (uint64) { return 0; }
    // Mocks return 0 for denominations(); mixer's constructor soft-skips the
    // misorder check when this returns 0, so existing tests keep passing.
    function denominations(uint256) external pure returns (bytes32) { return bytes32(0); }
}

/// @dev Rejecting pool root verifier.
contract RejectingPoolRootVerifier is IPoolRootVerifier {
    mapping(bytes32 => bool) public poolIdSet;
    bytes32 public ASSET_ID;
    address public MIXER;

    constructor(bytes32[] memory poolIds_, bytes32 assetId_, address mixer_) {
        ASSET_ID = assetId_;
        MIXER = mixer_;
        for (uint256 i; i < poolIds_.length; ++i) poolIdSet[poolIds_[i]] = true;
    }

    function isAcceptedBurn(bytes32) external pure returns (bool) { return false; }
    function coversPool(bytes32 pid) external view returns (bool) { return poolIdSet[pid]; }
    function lastProvenPoolIndex(uint8) external pure returns (uint64) { return 0; }
    function denominations(uint256) external pure returns (bytes32) { return bytes32(0); }
}

/// @dev Mock with controllable per-pool index — exercises the capacity gate.
contract MockPoolRootVerifierWithIndex is IPoolRootVerifier {
    mapping(bytes32 => bool) public poolIdSet;
    bytes32 public ASSET_ID;
    address public MIXER;
    mapping(uint8 => uint64) public lastProvenPoolIndex;

    constructor(bytes32[] memory poolIds_, bytes32 assetId_, address mixer_) {
        ASSET_ID = assetId_;
        MIXER = mixer_;
        for (uint256 i; i < poolIds_.length; ++i) poolIdSet[poolIds_[i]] = true;
    }

    function setPoolIndex(uint8 denomIdx, uint64 idx) external { lastProvenPoolIndex[denomIdx] = idx; }
    function isAcceptedBurn(bytes32) external pure returns (bool) { return true; }
    function coversPool(bytes32 pid) external view returns (bool) { return poolIdSet[pid]; }
    function denominations(uint256) external pure returns (bytes32) { return bytes32(0); }
}
