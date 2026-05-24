// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../src/TacitETHMixer.sol";

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

/// @dev Mock SP1 pool root verifier. All burns accepted, state settable.
contract MockPoolRootVerifier is IPoolRootVerifier {
    bytes32 public currentPoolRoot;

    function setPoolRoot(bytes32 poolRoot_) external {
        currentPoolRoot = poolRoot_;
    }

    function isAcceptedBurn(bytes32) external pure returns (bool) { return true; }
    function currentState() external view returns (
        bytes32, bytes32, bytes32, uint64, bytes32
    ) {
        return (currentPoolRoot, bytes32(0), bytes32(0), 0, bytes32(0));
    }
}

/// @dev Rejecting pool root verifier.
contract RejectingPoolRootVerifier is IPoolRootVerifier {
    function isAcceptedBurn(bytes32) external pure returns (bool) { return false; }
    function currentState() external pure returns (
        bytes32, bytes32, bytes32, uint64, bytes32
    ) {
        return (bytes32(0), bytes32(0), bytes32(0), 0, bytes32(0));
    }
}
