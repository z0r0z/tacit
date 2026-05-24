// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";

contract BitcoinLightRelayTest is TestHelper {
    TestLightRelay relay;

    function setUp() public {
        relay = _deployRelay();
    }

    function test_genesis_sets_epoch() public view {
        assertEq(relay.currentEpoch(), 0);
        assertEq(relay.epochTarget(0), TEST_TARGET);
        assertTrue(relay.initialized());
    }

    function test_genesis_reverts_if_already_initialized() public {
        vm.expectRevert(BitcoinLightRelay.AlreadyInitialized.selector);
        relay.genesis(0, TEST_TARGET, 1000, keccak256("x"), 0, 1);
    }

    function test_verifyBlock_single_header() public view {
        bytes memory chain = _buildChain(bytes32(0), bytes32(uint256(0xBEEF)), 1);
        bytes32 mr = relay.verifyBlock(chain, 0, 0);
        assertEq(mr, bytes32(uint256(0xBEEF)));
    }

    function test_verifyBlock_with_confirmations() public view {
        bytes memory chain = _buildChain(bytes32(0), bytes32(uint256(0xCAFE)), 7);
        bytes32 mr = relay.verifyBlock(chain, 0, 6);
        assertEq(mr, bytes32(uint256(0xCAFE)));
    }

    function test_verifyBlock_rejects_insufficient_confirmations() public {
        bytes memory chain = _buildChain(bytes32(0), bytes32(uint256(0xCAFE)), 3);
        vm.expectRevert(BitcoinLightRelay.InvalidChainLength.selector);
        relay.verifyBlock(chain, 0, 6);
    }

    function test_verifyBlock_rejects_broken_chain() public {
        bytes memory a = _buildChain(bytes32(0), bytes32(uint256(1)), 1);
        bytes memory b = _buildChain(bytes32(uint256(0xDEAD)), bytes32(uint256(2)), 1);
        bytes memory broken = abi.encodePacked(a, b);
        vm.expectRevert(BitcoinLightRelay.InvalidHeaderChain.selector);
        relay.verifyBlock(broken, 0, 1);
    }

    // Real Bitcoin mainnet block #100000 header vector.
    function test_real_mainnet_header() public pure {
        bytes memory raw = hex"0100000050120119172a610421a6c3011dd330d9df07b63616c2cc1f1cd00200000000006657a9252aacd5c0b2940996ecff952228c3067cc38d4885efb5a4ac4247e9f337221b4d4c86041b0f2b5710";
        assertEq(raw.length, 80);

        bytes32 blockHash = sha256(abi.encodePacked(sha256(raw)));
        assertEq(blockHash, 0x06e533fd1ada86391f3f6c343204b0d278d4aaec1c0b20aa27ba030000000000);

        uint256 reversed;
        uint256 v = uint256(blockHash);
        for (uint256 i; i < 32; ++i) reversed = (reversed << 8) | ((v >> (i * 8)) & 0xff);
        assertEq(bytes32(reversed), 0x000000000003ba27aa200b1cecaad478d2b00432346c3f1f3986da1afd33e506);

        uint256 target = uint256(0x04864c) << 192;
        assertLe(reversed, target);
    }
}
