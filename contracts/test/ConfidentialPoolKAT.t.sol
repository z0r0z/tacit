// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";
using PoolStateReader for ConfidentialPool;

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
        pool = new ConfidentialPool(address(new AcceptVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 6, bytes32(0), bytes32(0), address(0));
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/confidential_pool.json"));
    }

    function test_tree_root_matches_js() public {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, ".treeLeaves");

        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.leaves = leaves;
        bytes[] memory _m = new bytes[](leaves.length);
        bytes32 _mr; for (uint256 _i; _i < _m.length; ++_i) _mr = keccak256(abi.encodePacked(_mr, keccak256(_m[_i])));
        pv.memoRoot = _mr;
        pool.settle(abi.encode(pv), "", _m);

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
            uint256 value = vm.parseJsonUint(json, string.concat(base, ".value"));

            bytes32 leaf = keccak256(abi.encodePacked(assetId, cx, cy, owner));
            assertEq(leaf, vm.parseJsonBytes32(json, string.concat(base, ".leaf")), "leaf layout");

            // note-bound nullifier (spec B3): keccak(Cx ‖ Cy ‖ "spent"), derived from the
            // commitment not a free secret, so a note has exactly one nullifier. Matches
            // cxfer-core::nullifier, the guest, and dapp/confidential-pool.js.
            bytes32 nullifier = keccak256(abi.encodePacked(cx, cy, "spent"));
            assertEq(nullifier, vm.parseJsonBytes32(json, string.concat(base, ".nullifier")), "nullifier layout");

            // commit = keccak(Cx ‖ Cy ‖ owner): the digest wrap takes in place of the raw coords +
            // owner, matching cxfer-core::deposit_commit, the guest, and dapp/confidential-pool.js.
            bytes32 commit = keccak256(abi.encodePacked(cx, cy, owner));
            assertEq(commit, vm.parseJsonBytes32(json, string.concat(base, ".commit")), "commit layout");

            // matches ConfidentialPool.wrap()'s keccak256(abi.encode(assetId, value, commit)),
            // where value = amount/unitScale is derived on-chain (binds note value to escrow).
            bytes32 depositId = keccak256(abi.encode(assetId, value, commit));
            assertEq(depositId, vm.parseJsonBytes32(json, string.concat(base, ".depositId")), "depositId layout");
        }
    }

    function test_membership_path_folds() public {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(json, ".treeLeaves");
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.leaves = leaves;
        bytes[] memory _m = new bytes[](leaves.length);
        bytes32 _mr; for (uint256 _i; _i < _m.length; ++_i) _mr = keccak256(abi.encodePacked(_mr, keccak256(_m[_i])));
        pv.memoRoot = _mr;
        pool.settle(abi.encode(pv), "", _m);

        uint256 idx = vm.parseJsonUint(json, ".memberIndex");
        bytes32[] memory path = vm.parseJsonBytes32Array(json, ".memberPath");
        bytes32 leaf = leaves[idx];

        assertTrue(_verifyPath(leaf, idx, path, pool.currentRoot()), "member path folds to root");

        path[0] = bytes32(uint256(path[0]) ^ 1); // tamper one sibling
        assertFalse(_verifyPath(leaf, idx, path, pool.currentRoot()), "tampered path rejected");
    }

    /// Cross-chain: the JS prover's destCommitment (Bitcoin leaf) and claimId
    /// must equal the contract's keccak(abi.encodePacked(...)) re-derivations —
    /// otherwise a settle would reject the crossOut or mint the wrong note.
    function test_crossout_claimid_matches_js() public view {
        string memory bb = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/bridge_burn.json"));
        bytes32 assetId = vm.parseJsonBytes32(bb, ".assetId");
        uint16 destChain = uint16(vm.parseJsonUint(bb, ".destChain"));
        bytes32 bindNullifier = vm.parseJsonBytes32(bb, ".bindNullifier");
        uint256 m = vm.parseJsonUint(bb, ".count");

        for (uint256 i; i < m; ++i) {
            string memory base = string.concat(".crossOuts[", vm.toString(i), "]");
            bytes32 cx = vm.parseJsonBytes32(bb, string.concat(base, ".cx"));
            bytes32 cy = vm.parseJsonBytes32(bb, string.concat(base, ".cy"));
            bytes32 owner = vm.parseJsonBytes32(bb, string.concat(base, ".owner"));

            bytes32 destCommitment = keccak256(abi.encodePacked(assetId, cx, cy, owner));
            assertEq(destCommitment, vm.parseJsonBytes32(bb, string.concat(base, ".destCommitment")), "destCommitment layout");

            bytes32 claimId = keccak256(abi.encodePacked(destChain, destCommitment, bindNullifier, assetId));
            assertEq(claimId, vm.parseJsonBytes32(bb, string.concat(base, ".claimId")), "claimId layout");
        }
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
