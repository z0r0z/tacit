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

    // Median-time-past must use the median of the last 11 ancestors, NOT the
    // immediate parent's timestamp. Bitcoin block timestamps wobble (a valid
    // block's ts can dip below its parent's), so the old strict-monotonic check
    // wrongly rejected canonical headers and bricked the relay at mainnet 952005.
    function test_mtp_uses_median_not_parent() public {
        uint32[11] memory tss = [uint32(500), 520, 510, 530, 525, 540, 535, 550, 545, 560, 555];
        bytes32 parent = bytes32(0);
        bytes32 tip;
        for (uint256 i; i < 11; ++i) {
            bytes32 bh = keccak256(abi.encodePacked("blk", i));
            relay.seedBlock(bh, parent, tss[i]);
            parent = bh;
            tip = bh;
        }
        // Sorted: [500,510,520,525,530,535,540,545,550,555,560] -> median = 535,
        // not the tip's own ts (555) nor the max (560).
        assertEq(relay.exposed_medianTimePast(tip), 535);
        // ts=552 dips below its parent (555) yet exceeds the median (535): valid.
        assertGt(uint256(552), uint256(relay.exposed_medianTimePast(tip)));
    }

    function test_mtp_partial_window_below_11() public {
        uint32[3] memory tss = [uint32(100), 300, 200];
        bytes32 parent = bytes32(0);
        bytes32 tip;
        for (uint256 i; i < 3; ++i) {
            bytes32 bh = keccak256(abi.encodePacked("p", i));
            relay.seedBlock(bh, parent, tss[i]);
            parent = bh;
            tip = bh;
        }
        // Fewer than 11 ancestors: median of [100,200,300] = 200 (Bitcoin's
        // early-chain behaviour — use the median of what's available).
        assertEq(relay.exposed_medianTimePast(tip), 200);
    }

    // Real mainnet difficulty-retarget at the epoch 471->472 boundary (block
    // 951552). Genesis anchored at the last block of epoch 471 (951551), then
    // retarget() with the 8 real boundary headers (4 old + 4 new). Asserts the
    // contract reproduces Bitcoin's actual adjustment: bits 0x17020f79 ->
    // 0x1702068f, computed from elapsed = 951551.ts - 949536.ts. Guards against
    // a retarget bug bricking the relay at the live mainnet boundary (953568).
    function test_retarget_real_mainnet_471_to_472() public {
        TestLightRelay r = new TestLightRelay(); // retarget() uses the real BitcoinLightRelay logic
        bytes memory h48 = hex"00403b224db1673e13cbfceadf0e779c8836a0b6ca2a1c5ee0e6000000000000000000006d02ba1190a57e3ac7550b53266b32ad53917b8339168ab16497c388e2989be2e961196a790f02173b04fafa";
        bytes memory h49 = hex"00e00020443827f43d0cb8db69ded9b5df758d128a8e1f908b1401000000000000000000cf67b5629994bc3bff35b2231de572ba1345c845dbecc3440a9603be354e25508f62196a790f0217c8f008de";
        bytes memory h50 = hex"0020cf2cc087b7a6c63b4efe3704246570571f1602ec6a54f4df010000000000000000006ca5a966665036584d71601f49779195dc0e0d39f8e6f80fd51dad19cc507f8ade66196a790f021791ae1370";
        bytes memory h51 = hex"0060012023af18bbc7d27a88edd1608079125d238ff939a98aef01000000000000000000327873f5c6eb22fc90fa130ff01dee2314b9df925ae3e78c6c754fc176a6165d7c68196a790f021798d22209";
        bytes memory h52 = hex"046021200d794080a57a498c0d80e681de3e443488359077dd9501000000000000000000d52087be6c9a811306bd2da144e60e868ec93fb7803748fa7f62a701458987989a6a196a8f0602176f9614b2";
        bytes memory h53 = hex"00a0032064bb14bdb8129ee34bb19f6086828c14862f92f172b401000000000000000000b25feda6b4d2a9548cd74778943ee735f2fa84cecbb2f38eebe5ff6ac26ba887f66a196a8f060217cc679697";
        bytes memory h54 = hex"00000920b4255a86dff807d13901e9d70bf0136683fc7e3b92b70100000000000000000030b723af5ab379ca6c5f3a19181e5c3203e87c3c94dd8bbb1c2ebffa11158988336d196a8f060217729ca88a";
        bytes memory h55 = hex"00e05d2408e06f8bac0bcd5639824d01fc0959e951ee77e3c7e20100000000000000000024e78d80f297b199de35a0603c4ecb6d1454254fc97aadd26070f408b12df61f606d196a8f06021717be074d";

        bytes32 tip951551 = sha256(abi.encodePacked(sha256(h51)));
        uint256 oldTarget = uint256(0x020f79) << 160; // bits 0x17020f79
        // epoch 471 start = 471*2016 = 949536; startTimestamp = block 949536 ts.
        r.genesis(949536, oldTarget, 1778860884, tip951551, 951551, 1);

        r.retarget(bytes.concat(h48, h49, h50, h51, h52, h53, h54, h55));

        assertEq(r.currentEpoch(), 472);
        assertEq(r.epochTarget(472), uint256(0x02068f) << 160); // real new bits 0x1702068f
    }

    // Burn-inclusion proofs anchor to the tip OR a canonical ancestor within
    // FINALITY_WINDOW (6), so a tip advance mid-withdrawal doesn't revert — while
    // still rejecting beyond-window, forged-side-chain, and ahead-of-tip claims.
    function test_anchorChain_finality_window() public {
        TestLightRelay r = new TestLightRelay();
        // Canonical chain bh[0..6] at heights 100..106, tip at 106.
        bytes32[] memory bh = new bytes32[](7);
        for (uint256 i; i < 7; ++i) bh[i] = keccak256(abi.encodePacked("blk", i));
        for (uint256 i = 1; i < 7; ++i) r.seedBlock(bh[i], bh[i - 1], 0);
        r.seedTip(bh[6], 106);

        r.exposed_anchorChain(106, bh[6]); // ends at tip
        r.exposed_anchorChain(100, bh[0]); // exactly FINALITY_WINDOW behind
        r.exposed_anchorChain(103, bh[3]); // mid-window ancestor

        vm.expectRevert(); // beyond the window (7 behind)
        r.exposed_anchorChain(99, bh[0]);
        vm.expectRevert(); // forged side-chain block at a valid height
        r.exposed_anchorChain(103, keccak256("fork"));
        vm.expectRevert(); // claims to end ahead of the tip
        r.exposed_anchorChain(107, bh[6]);
    }
}
