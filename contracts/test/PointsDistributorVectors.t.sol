// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PointsDistributor} from "../src/PointsDistributor.sol";
import {PointsToken} from "./PointsDistributor.t.sol";

/// Proof files written by tools/points-tree.mjs, checked against the contract verifier and claim path. The
/// fixtures are regenerated with `node contracts/test/fixtures/points/generate.mjs`; the checked-in copies pin
/// the leaf encoding (address, cumulativeAmount) — no index, unlike TacAirdrop's fixtures, since a cumulative
/// distributor's root moves over time and claims are keyed by address alone.
contract PointsDistributorVectorsTest is Test {
    address guardian = address(0x6A2D);
    address rootSetter = address(0x50717E);

    function _run(string memory file, uint256 expectedCount) internal {
        string memory json = vm.readFile(string.concat("test/fixtures/points/", file));
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        uint256 count = vm.parseJsonUint(json, ".count");
        uint256 totalWei = vm.parseUint(vm.parseJsonString(json, ".totalWei"));
        assertEq(count, expectedCount);

        vm.etch(guardian, hex"00");
        PointsToken tok = new PointsToken();
        PointsDistributor dist = new PointsDistributor(address(tok), guardian, rootSetter, uint64(block.timestamp + 1 days));
        tok.mint(address(dist), totalWei);
        vm.prank(rootSetter);
        dist.updateRoot(root, totalWei);

        string[] memory keys = vm.parseJsonKeys(json, ".claims");
        assertEq(keys.length, count);
        uint256 paid;
        for (uint256 k; k < keys.length; ++k) {
            string memory base = string.concat(".claims.", keys[k]);
            address account = vm.parseJsonAddress(json, string.concat(base, ".address"));
            uint256 amount = vm.parseUint(vm.parseJsonString(json, string.concat(base, ".cumulativeAmount")));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(base, ".proof"));

            assertTrue(dist.verify(account, amount, proof), "JS proof rejected");
            assertFalse(dist.verify(account, amount + 1, proof), "amount not bound");
            assertFalse(dist.verify(address(uint160(account) ^ 1), amount, proof), "account not bound");

            vm.prank(account);
            dist.claim(amount, proof);
            assertEq(tok.balanceOf(account), amount);
            assertEq(dist.claimed(account), amount);
            paid += amount;
        }
        assertEq(paid, totalWei);
        assertEq(tok.balanceOf(address(dist)), 0);
    }

    function test_singleLeafFile() public { _run("tree-1.json", 1); }
    function test_smallFile() public { _run("tree-5.json", 5); }
    function test_fileSpanningTwoBitmapWords() public { _run("tree-260.json", 260); }
}
