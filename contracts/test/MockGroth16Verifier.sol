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
}
