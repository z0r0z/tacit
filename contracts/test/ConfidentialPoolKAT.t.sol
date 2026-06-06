// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";

contract AcceptVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Cross-implementation KAT. Vectors are produced by the JS client
/// (dapp/confidential-pool.js) via tests/gen-confidential-pool-fixture.mjs. This
/// asserts the Solidity contract agrees with the JS on: the Keccak incremental
/// Merkle root, the leaf / nullifier / deposit-id preimage layouts, and the
/// membership-path fold (the same algorithm the SP1 guest's keccak_merkle_verify
/// runs). Agreement of three independent implementations locks the interface.
contract ConfidentialPoolKATTest is Test {
    ConfidentialPool pool;
    string json;

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(address(new AcceptVerifier()), bytes32(uint256(0xABCD)));
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/confidential_pool.json"));
    }

    function test_tree_root_matches_js() public {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, ".treeLeaves");

        ConfidentialPool.PublicValues memory pv;
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.leaves = leaves;
        pool.settle(abi.encode(pv), "");

        bytes32 jsRoot = vm.parseJsonBytes32(json, ".treeRoot");
        assertEq(pool.currentRoot(), jsRoot, "on-chain Keccak tree root == JS root");
        assertTrue(pool.everKnownRoot(jsRoot), "root recorded");
    }

    function test_leaf_nullifier_depositid_layout() public view {
        bytes32 assetId = vm.parseJsonBytes32(json, ".assetId");
        bytes32 owner = vm.parseJsonBytes32(json, ".owner");
        uint256 n = vm.parseJsonBytes32Array(json, ".treeLeaves").length;

        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".notes[", vm.toString(i), "]");
            bytes32 cx = vm.parseJsonBytes32(json, string.concat(base, ".cx"));
            bytes32 cy = vm.parseJsonBytes32(json, string.concat(base, ".cy"));
            bytes32 secret = vm.parseJsonBytes32(json, string.concat(base, ".secret"));
            uint256 amount = vm.parseJsonUint(json, string.concat(base, ".amount"));

            bytes32 leaf = keccak256(abi.encodePacked(assetId, cx, cy, owner));
            assertEq(leaf, vm.parseJsonBytes32(json, string.concat(base, ".leaf")), "leaf layout");

            bytes32 nullifier = keccak256(abi.encodePacked(secret));
            assertEq(nullifier, vm.parseJsonBytes32(json, string.concat(base, ".nullifier")), "nullifier layout");

            // matches ConfidentialPool.wrap()'s keccak256(abi.encode(...))
            bytes32 depositId = keccak256(abi.encode(assetId, amount, cx, cy, owner));
            assertEq(depositId, vm.parseJsonBytes32(json, string.concat(base, ".depositId")), "depositId layout");
        }
    }

    function test_membership_path_folds() public {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, ".treeLeaves");
        ConfidentialPool.PublicValues memory pv;
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.leaves = leaves;
        pool.settle(abi.encode(pv), "");

        uint256 idx = vm.parseJsonUint(json, ".memberIndex");
        bytes32[] memory path = vm.parseJsonBytes32Array(json, ".memberPath");
        bytes32 leaf = leaves[idx];

        assertTrue(_verifyPath(leaf, idx, path, pool.currentRoot()), "member path folds to root");

        path[0] = bytes32(uint256(path[0]) ^ 1); // tamper one sibling
        assertFalse(_verifyPath(leaf, idx, path, pool.currentRoot()), "tampered path rejected");
    }

    /// Mirror of the SP1 guest's keccak_merkle_verify (and contract _insertLeaf
    /// ordering): fold the leaf up with its siblings using the index bits.
    function _verifyPath(bytes32 leaf, uint256 index, bytes32[] memory path, bytes32 root)
        internal pure returns (bool)
    {
        bytes32 h = leaf;
        for (uint256 i; i < path.length; ++i) {
            h = (index >> i) & 1 == 1
                ? keccak256(abi.encodePacked(path[i], h))
                : keccak256(abi.encodePacked(h, path[i]));
        }
        return h == root;
    }
}
