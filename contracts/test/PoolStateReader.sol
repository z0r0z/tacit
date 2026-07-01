// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// @dev Test-only re-exposers for ConfidentialPool state whose public getters were internalized to fit
///      EIP-170 (the per-swap protocol-fee anchor needed the bytecode). These read the storage slots
///      directly via the `vm.load` cheatcode, so they add ZERO production bytecode. A test file does
///      `using PoolStateReader for ConfidentialPool;` and its existing `pool.bitcoinConsumedCount()` /
///      `pool.bridgeMinted(k)` / etc. calls resolve here unchanged. Slots are from
///      `forge inspect ConfidentialPool storageLayout` (re-check if the layout shifts).
interface IVmLoad {
    function load(address target, bytes32 slot) external view returns (bytes32);
}

library PoolStateReader {
    IVmLoad constant VM = IVmLoad(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D); // forge cheatcode address

    function bitcoinConsumedCount(ConfidentialPool p) internal view returns (uint256) {
        return uint256(VM.load(address(p), bytes32(uint256(120))));
    }

    function crossOutCount(ConfidentialPool p) internal view returns (uint256) {
        return uint256(VM.load(address(p), bytes32(uint256(169))));
    }

    function lockRoot(ConfidentialPool p) internal view returns (bytes32) {
        return VM.load(address(p), bytes32(uint256(84)));
    }

    function cdpRoot(ConfidentialPool p) internal view returns (bytes32) {
        return VM.load(address(p), bytes32(uint256(128)));
    }

    function everKnownRoot(ConfidentialPool p, bytes32 root) internal view returns (bool) {
        return VM.load(address(p), keccak256(abi.encode(root, uint256(68)))) != bytes32(0);
    }

    function bridgeMinted(ConfidentialPool p, bytes32 nu) internal view returns (bool) {
        return VM.load(address(p), keccak256(abi.encode(nu, uint256(75)))) != bytes32(0);
    }

    function bitcoinConsumed(ConfidentialPool p, bytes32 nu) internal view returns (bytes32) {
        return VM.load(address(p), keccak256(abi.encode(nu, uint256(119))));
    }

    function knownReflectionDigest(ConfidentialPool p) internal view returns (bytes32) {
        return VM.load(address(p), bytes32(uint256(80)));
    }

    function nullifierSpent(ConfidentialPool p, bytes32 nu) internal view returns (bool) {
        return VM.load(address(p), keccak256(abi.encode(nu, uint256(69)))) != bytes32(0);
    }

    function lpShares(ConfidentialPool p, bytes32 poolId, address owner) internal view returns (uint256) {
        return uint256(VM.load(address(p), keccak256(abi.encode(owner, keccak256(abi.encode(poolId, uint256(121)))))));
    }
}
