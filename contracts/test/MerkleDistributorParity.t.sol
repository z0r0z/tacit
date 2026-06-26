// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";

contract PTAC is ERC20 {
    function name() public pure override returns (string memory) {
        return "Tacit";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Cross-impl parity: the merkle tree built by tools/airdrop/build-merkle.mjs (untagged keccak,
///         sorted-pair) must be accepted on-chain by MerkleDistributor (Solady MerkleProofLib). Reads the
///         committed fixture (regenerate with the JS tool) and asserts every claim verifies + lands.
contract MerkleDistributorParityTest is Test {
    function test_jsBuiltTree_acceptedOnChain() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/airdrop_merkle_sample.json"));
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        uint256 total = vm.parseJsonUint(json, ".total");
        uint256 count = vm.parseJsonUint(json, ".count");

        PTAC tac = new PTAC();
        MerkleDistributor dist = new MerkleDistributor(address(tac), root, uint64(block.timestamp + 7 days), address(0xA11CE), total);
        tac.mint(address(dist), total);

        uint256 paid;
        for (uint256 i = 0; i < count; i++) {
            string memory base = string.concat(".claims[", vm.toString(i), "]");
            uint256 index = vm.parseJsonUint(json, string.concat(base, ".index"));
            address account = vm.parseJsonAddress(json, string.concat(base, ".account"));
            uint256 amount = vm.parseJsonUint(json, string.concat(base, ".amount"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(base, ".proof"));

            assertFalse(dist.isClaimed(index), "pre-claim flag set");
            uint256 before = tac.balanceOf(account);
            dist.claim(index, account, amount, proof);
            assertTrue(dist.isClaimed(index), "claim flag not set");
            assertEq(tac.balanceOf(account) - before, amount, "wrong payout");
            paid += amount;
        }
        assertEq(paid, total, "sum of claims != committed total");
        assertEq(tac.balanceOf(address(dist)), 0, "distributor not fully drained");
    }
}
