// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacAirdrop} from "../src/TacAirdrop.sol";
import {AirdropToken, MockAirdropPool} from "./TacAirdrop.t.sol";

/// Proof files written by tools/airdrop-tree.mjs, checked against the contract verifier and claim path. The fixtures are
/// regenerated with `node contracts/test/fixtures/airdrop/generate.mjs`; the checked-in copies pin the encoding.
contract TacAirdropVectorsTest is Test {
    bytes32 constant ASSET = keccak256("tac-asset");
    address guardian = address(0x6A2D);

    function _run(string memory file, uint256 expectedCount) internal {
        string memory json = vm.readFile(string.concat("test/fixtures/airdrop/", file));
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        uint256 count = vm.parseJsonUint(json, ".count");
        uint256 totalWei = vm.parseUint(vm.parseJsonString(json, ".totalWei"));
        assertEq(count, expectedCount);

        MockAirdropPool pool = new MockAirdropPool(ASSET);
        AirdropToken tok = new AirdropToken(address(pool));
        pool.setToken(tok);
        vm.etch(guardian, hex"00");
        TacAirdrop drop = new TacAirdrop(address(tok), root, guardian, uint64(block.timestamp + 1 days), address(pool), ASSET);
        tok.mint(address(drop), totalWei);

        string[] memory keys = vm.parseJsonKeys(json, ".claims");
        assertEq(keys.length, count);
        uint256 paid;
        for (uint256 k; k < keys.length; ++k) {
            string memory base = string.concat(".claims.", keys[k]);
            uint256 index = vm.parseJsonUint(json, string.concat(base, ".index"));
            address account = vm.parseJsonAddress(json, string.concat(base, ".address"));
            uint256 amount = vm.parseUint(vm.parseJsonString(json, string.concat(base, ".amount")));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(base, ".proof"));

            assertTrue(drop.verify(index, account, amount, proof), "JS proof rejected");
            assertFalse(drop.verify(index, account, amount + 1e10, proof), "amount not bound");
            assertFalse(drop.verify(index + 1, account, amount, proof), "index not bound");
            assertFalse(drop.verify(index, address(uint160(account) ^ 1), amount, proof), "account not bound");

            // half of the leaves claim in the clear, half shielded, so both paths run against JS-built proofs
            if (index % 2 == 0) {
                drop.claim(index, account, amount, proof);
                assertEq(tok.balanceOf(account), amount);
            } else {
                vm.prank(account);
                drop.claimAndShield(index, amount, proof, bytes32(uint256(index) + 1));
            }
            assertTrue(drop.isClaimed(index));
            paid += amount;
        }
        assertEq(paid, totalWei);
        assertEq(tok.balanceOf(address(drop)), 0);
    }

    function test_singleLeafFile() public { _run("tree-1.json", 1); }
    function test_smallFile() public { _run("tree-5.json", 5); }
    function test_fileSpanningTwoBitmapWords() public { _run("tree-260.json", 260); }
}
