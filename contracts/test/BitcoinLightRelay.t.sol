// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";

contract BitcoinLightRelayTest is TestHelper {
    TestLightRelay relay;

    function setUp() public {
        relay = _deployRelay();
    }

    function test_genesis_sets_epoch() public view {
        assertEq(relay.genesisEpoch(), 0);
        assertEq(relay.epochStartTimestamp(0), 1000);
        // The anchor carries its branch's target; blocks above it inherit or derive from it.
        assertEq(relay.blockTarget(keccak256("test-genesis-tip")), TEST_TARGET);
        assertTrue(relay.initialized());
    }

    // seedAnchorHistory completes the median-time-past window: the anchor's OWN header timestamp replaces the
    // epoch-start placeholder (MTP only — retargeting still reads epochStartTs), and the ten canonical ancestors
    // below it give a full 11-block median from the first submitted header. One-shot, deployer-only.
    function test_seed_anchor_history_completes_mtp_window() public {
        bytes32 anchor = keccak256("test-genesis-tip");
        bytes32[] memory hashes = new bytes32[](2);
        uint32[] memory times = new uint32[](2);
        hashes[0] = keccak256("a1");
        hashes[1] = keccak256("a2");
        times[0] = 1400;
        times[1] = 1300;

        relay.seedAnchorHistory(1500, hashes, times);

        assertEq(relay.blockTimestamp(anchor), 1500, "the anchor carries its real header timestamp");
        assertEq(relay.epochStartTs(anchor), 1000, "retarget input is untouched");
        assertEq(relay.epochStartTimestamp(0), 1000, "epoch-start timestamp is untouched");
        assertEq(relay.blockParent(anchor), hashes[0], "ancestors are linked below the anchor");
        assertEq(relay.blockTimestamp(hashes[1]), 1300, "ancestor timestamps are stored");
        assertTrue(relay.historySeeded());

        // One-shot.
        vm.expectRevert(BitcoinLightRelayBase.AlreadyInitialized.selector);
        relay.seedAnchorHistory(1500, hashes, times);
    }

    function test_seed_anchor_history_rejects_bad_input() public {
        bytes32[] memory hashes = new bytes32[](1);
        uint32[] memory times = new uint32[](1);
        hashes[0] = keccak256("a1");
        times[0] = 1400;

        // An anchor timestamp below the seeded epoch start is impossible for a block inside that epoch.
        vm.expectRevert(BitcoinLightRelayBase.InvalidTimestamp.selector);
        relay.seedAnchorHistory(999, hashes, times);

        // A zero ancestor hash or timestamp is a walk sentinel, never a usable ancestor.
        hashes[0] = bytes32(0);
        vm.expectRevert(BitcoinLightRelayBase.InvalidTimestamp.selector);
        relay.seedAnchorHistory(1500, hashes, times);
        hashes[0] = keccak256("a1");
        times[0] = 0;
        vm.expectRevert(BitcoinLightRelayBase.InvalidTimestamp.selector);
        relay.seedAnchorHistory(1500, hashes, times);

        // Mismatched lengths / over the 11-block window.
        times[0] = 1400;
        uint32[] memory two = new uint32[](2);
        vm.expectRevert(BitcoinLightRelayBase.InvalidChainLength.selector);
        relay.seedAnchorHistory(1500, hashes, two);
    }

    function test_constructor_rejects_zero_max_target() public {
        vm.expectRevert(BitcoinLightRelayBase.InvalidTarget.selector);
        new BitcoinLightRelay(0);
    }

    function test_genesis_reverts_if_already_initialized() public {
        vm.expectRevert(BitcoinLightRelayBase.AlreadyInitialized.selector);
        relay.genesis(0, TEST_TARGET, 1000, keccak256("x"), 0, 1);
    }

    // The anchor must sit inside the seeded epoch — otherwise the first
    // advanceTip reverts UnknownEpoch and the relay is bricked. Genesis rejects
    // an anchor at or past the next epoch boundary (and below the epoch start).
    function test_genesis_rejects_anchor_outside_epoch() public {
        TestLightRelay r = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidChainLength.selector);
        r.genesis(0, TEST_TARGET, 1000, keccak256("x"), 2016, 1); // tipHeight == next epoch start

        TestLightRelay r2 = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidChainLength.selector);
        r2.genesis(2016, TEST_TARGET, 1000, keccak256("x"), 2015, 1); // below epoch start
    }

    // A genesis anchor at the epoch's LAST block (the boundary) is rejected: the first retarget would read
    // lastTs = blockTimestamp[boundary] = the seeded epoch-start ts, giving elapsed 0 and a mis-clamped target
    // that bricks the relay at the first boundary. Excluding it forces the boundary to be reached by advanceTip
    // (carrying a real timestamp). The block BEFORE the boundary is still a valid anchor.
    function test_genesis_rejects_anchor_at_epoch_boundary() public {
        TestLightRelay r = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidChainLength.selector);
        r.genesis(0, TEST_TARGET, 1000, keccak256("x"), 2015, 1); // last block of the epoch — rejected

        TestLightRelay r2 = new TestLightRelay();
        r2.genesis(0, TEST_TARGET, 1000, keccak256("x"), 2014, 1); // one below the boundary — accepted
        assertEq(r2.blockTarget(keccak256("x")), TEST_TARGET);
        assertTrue(r2.initialized());
    }

    function test_genesis_rejects_oversized_timestamp() public {
        TestLightRelay r = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidTimestamp.selector);
        r.genesis(0, TEST_TARGET, uint256(type(uint32).max) + 1, keccak256("x"), 0, 1);
    }

    // A non-canonical target — one that compact-encodes to a DIFFERENT value, so
    // no real header's bits could ever decode to it — would silently brick the
    // relay at the first advanceTip. Genesis rejects it; the canonical target it
    // truncates to is accepted, keeping every stored blockTarget canonical.
    function test_genesis_rejects_noncanonical_target() public {
        uint256 canonical = uint256(0x020f79) << 160; // == _bitsToTarget(0x17020f79)

        TestLightRelay r = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidTarget.selector);
        r.genesis(0, canonical | 1, 1000, keccak256("x"), 0, 1); // low bit truncated by compact

        TestLightRelay r2 = new TestLightRelay();
        r2.genesis(0, canonical, 1000, keccak256("x"), 0, 1); // canonical: accepted
        assertEq(r2.blockTarget(keccak256("x")), canonical);
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
        vm.expectRevert(BitcoinLightRelayBase.InvalidChainLength.selector);
        relay.verifyBlock(chain, 0, 6);
    }

    function test_verifyBlock_rejects_broken_chain() public {
        bytes memory a = _buildChain(bytes32(0), bytes32(uint256(1)), 1);
        bytes memory b = _buildChain(bytes32(uint256(0xDEAD)), bytes32(uint256(2)), 1);
        bytes memory broken = abi.encodePacked(a, b);
        vm.expectRevert(BitcoinLightRelayBase.InvalidHeaderChain.selector);
        relay.verifyBlock(broken, 0, 1);
    }

    // Real Bitcoin mainnet block #100000 header vector.
    function test_real_mainnet_header() public pure {
        bytes memory raw =
            hex"0100000050120119172a610421a6c3011dd330d9df07b63616c2cc1f1cd00200000000006657a9252aacd5c0b2940996ecff952228c3067cc38d4885efb5a4ac4247e9f337221b4d4c86041b0f2b5710";
        assertEq(raw.length, 80);

        bytes32 blockHash = sha256(abi.encodePacked(sha256(raw)));
        assertEq(blockHash, 0x06e533fd1ada86391f3f6c343204b0d278d4aaec1c0b20aa27ba030000000000);

        uint256 reversed;
        uint256 v = uint256(blockHash);
        for (uint256 i; i < 32; ++i) {
            reversed = (reversed << 8) | ((v >> (i * 8)) & 0xff);
        }
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
    // GROUND TRUTH for the per-branch boundary crossing: the 8 REAL mainnet headers spanning the
    // 471→472 boundary (951548..951555), driven through the production advanceTip path with REAL PoW.
    // The crossing block (951552) must derive Bitcoin's actual adjustment — bits 0x17020f79 → 0x1702068f,
    // from elapsed = 951551.ts - 949536.ts — entirely from its own branch, and every header's nBits must
    // match. A wrong derivation reverts InvalidPoW here rather than bricking the live relay at a boundary.
    function test_advanceTip_crosses_real_mainnet_471_to_472_boundary() public {
        TestLightRelay r = new TestLightRelay(); // real PoW, real target derivation
        bytes memory h48 =
            hex"00403b224db1673e13cbfceadf0e779c8836a0b6ca2a1c5ee0e6000000000000000000006d02ba1190a57e3ac7550b53266b32ad53917b8339168ab16497c388e2989be2e961196a790f02173b04fafa";
        bytes memory h49 =
            hex"00e00020443827f43d0cb8db69ded9b5df758d128a8e1f908b1401000000000000000000cf67b5629994bc3bff35b2231de572ba1345c845dbecc3440a9603be354e25508f62196a790f0217c8f008de";
        bytes memory h50 =
            hex"0020cf2cc087b7a6c63b4efe3704246570571f1602ec6a54f4df010000000000000000006ca5a966665036584d71601f49779195dc0e0d39f8e6f80fd51dad19cc507f8ade66196a790f021791ae1370";
        bytes memory h51 =
            hex"0060012023af18bbc7d27a88edd1608079125d238ff939a98aef01000000000000000000327873f5c6eb22fc90fa130ff01dee2314b9df925ae3e78c6c754fc176a6165d7c68196a790f021798d22209";
        bytes memory h52 =
            hex"046021200d794080a57a498c0d80e681de3e443488359077dd9501000000000000000000d52087be6c9a811306bd2da144e60e868ec93fb7803748fa7f62a701458987989a6a196a8f0602176f9614b2";
        bytes memory h53 =
            hex"00a0032064bb14bdb8129ee34bb19f6086828c14862f92f172b401000000000000000000b25feda6b4d2a9548cd74778943ee735f2fa84cecbb2f38eebe5ff6ac26ba887f66a196a8f060217cc679697";
        bytes memory h54 =
            hex"00000920b4255a86dff807d13901e9d70bf0136683fc7e3b92b70100000000000000000030b723af5ab379ca6c5f3a19181e5c3203e87c3c94dd8bbb1c2ebffa11158988336d196a8f060217729ca88a";
        bytes memory h55 =
            hex"00e05d2408e06f8bac0bcd5639824d01fc0959e951ee77e3c7e20100000000000000000024e78d80f297b199de35a0603c4ecb6d1454254fc97aadd26070f408b12df61f606d196a8f06021717be074d";

        uint256 oldTarget = uint256(0x020f79) << 160; // bits 0x17020f79
        uint256 newTarget = uint256(0x02068f) << 160; // real new bits 0x1702068f
        // Anchor at 951547 == h48's prevBlock (raw header bytes), inside epoch 471 (genesisEpoch).
        bytes32 anchor = bytes32(hex"4db1673e13cbfceadf0e779c8836a0b6ca2a1c5ee0e600000000000000000000");
        r.genesis(949536, oldTarget, 1778860884, anchor, 951547, 1);

        vm.warp(1780060000); // past the last header's ts, inside the +2h future-drift bound
        r.advanceTip(bytes.concat(h48, h49, h50, h51, h52, h53, h54, h55));

        assertEq(r.tipHeight(), 951555, "advanced across the real boundary");
        // Pre-boundary blocks carry the old epoch's target; the crossing block and after carry the derived one.
        assertEq(r.blockTarget(_dsha256(h51)), oldTarget, "951551 (last of epoch 471) keeps the old target");
        assertEq(r.blockTarget(_dsha256(h52)), newTarget, "951552 derives Bitcoin's real epoch-472 target");
        assertEq(r.blockTarget(_dsha256(h55)), newTarget, "later epoch-472 blocks inherit it");
    }

    // R-1: a fork that diverged at a retarget boundary can now CROSS the boundary and overtake the tip. The
    // old single global epoch target barred any non-tip branch from crossing, so a boundary-height reorg
    // permanently pinned the tip to the orphaned block and bricked the whole Bitcoin lane. With the per-branch
    // `blockTarget`, the crossing block derives its own epoch target from its branch, so a heavier fork wins.
    // PoW is mocked (synthetic headers can't be mined) — target derivation, crossing, cumulative work, and the
    // heaviest-chain rule all run the production path.
    function test_advanceTip_fork_crosses_retarget_boundary_and_overtakes() public {
        MockPowLightRelay r = new MockPowLightRelay();
        uint256 T = 1_700_000_000;
        uint256 TS = r.TARGET_TIMESPAN(); // 2 weeks → the crossing keeps the target unchanged (elapsed == TS)
        bytes32 anchor = keccak256("epoch0-anchor");
        r.genesis(0, TEST_TARGET, T, anchor, 100, 1); // anchor mid-epoch; epochStartTimestamp[0] = T

        // Canonical boundary block A (height 2015) is the current tip; a competing fork boundary block B at the
        // SAME height has equal work (same epoch target) and is NOT the tip.
        bytes32 A = keccak256("boundary-A-canonical");
        bytes32 B = keccak256("boundary-B-fork");
        r.seedKnownBlock(A, anchor, uint32(T + TS), 2015, 1000);
        r.seedBlockTarget(A, TEST_TARGET);
        r.seedTipFull(A, 2015, 1000);
        r.seedKnownBlock(B, anchor, uint32(T + TS), 2015, 1000);
        r.seedBlockTarget(B, TEST_TARGET);

        // Submit the fork's boundary crossing (height 2016, prev == B != tip). Its target derives from B's
        // branch (epoch-start T, boundary ts T+TS ⇒ unchanged TEST_TARGET), so its nBits (0x1d00ffff) match.
        vm.warp(T + TS + 700);
        bytes memory cross = _makeHeader(B, keccak256("fork-2016"), uint32(T + TS + 600), 42);
        bytes32 crossHash = _dsha256(cross);
        r.advanceTip(cross);

        assertEq(r.tipHeight(), 2016, "fork crossed the boundary and became the tip");
        assertEq(r.tip(), crossHash, "tip is the fork's crossing block");
        assertEq(r.blockTarget(crossHash), TEST_TARGET, "crossing block carries its branch's derived target");
    }

    // The retarget arithmetic compact-encodes its result to header precision then
    // re-expands it (Bitcoin's SetCompact/GetCompact). Round-trip the real
    // mainnet boundary targets and the powLimit to guard that truncation.
    function test_compact_roundtrip() public {
        TestLightRelay r = new TestLightRelay();
        // Real mainnet nBits across recent epochs.
        uint32[3] memory bits = [uint32(0x17020f79), 0x1702068f, 0x1d00ffff];
        for (uint256 i; i < 3; ++i) {
            uint256 t = r.exposed_bitsToTarget(bits[i]);
            assertEq(r.exposed_targetToCompact(t), bits[i]);
            assertEq(r.exposed_bitsToTarget(r.exposed_targetToCompact(t)), t);
        }
        // powLimit (MAX_TARGET) compacts to 0x1d00ffff and back.
        uint256 maxT = relay.MAX_TARGET();
        assertEq(r.exposed_targetToCompact(maxT), 0x1d00ffff);
        assertEq(r.exposed_bitsToTarget(r.exposed_targetToCompact(maxT)), maxT);
    }

    function test_bitsToTarget_rejects_invalid_compact_targets() public {
        TestLightRelay r = new TestLightRelay();

        vm.expectRevert(BitcoinLightRelayBase.InvalidTarget.selector);
        r.exposed_bitsToTarget(0x01800000); // sign bit set

        vm.expectRevert(BitcoinLightRelayBase.InvalidTarget.selector);
        r.exposed_bitsToTarget(0x01000000); // zero mantissa

        vm.expectRevert(BitcoinLightRelayBase.InvalidTarget.selector);
        r.exposed_bitsToTarget(0x1d010000); // target above max target
    }

    // A last-block timestamp earlier than the first-block timestamp is a NEGATIVE actualTimespan on
    // Bitcoin, which Core clamps up to TARGET_TIMESPAN/4. The relay must compute the SAME target (never
    // revert on the uint underflow), so a sub-finality reorg at a boundary can't brick retarget.
    function test_retarget_target_clamps_negative_timespan() public {
        TestLightRelay r = new TestLightRelay();
        uint256 oldTarget = r.exposed_bitsToTarget(0x1702068f); // a recent mainnet target
        uint256 timespan = r.TARGET_TIMESPAN();

        // last < first (negative span) floors to 0 → clamps to TARGET_TIMESPAN/4 (no revert).
        uint256 negSpan = r.exposed_retargetTarget(oldTarget, 1000, 500);
        // An explicit minimal span (exactly TARGET_TIMESPAN/4) yields the identical clamped target.
        uint256 minSpan = r.exposed_retargetTarget(oldTarget, 0, timespan / 4);
        assertEq(negSpan, minSpan, "negative span clamps to TARGET_TIMESPAN/4");
        // Below an even (no-change) span's target, confirming the clamp raised difficulty as Core does.
        uint256 evenSpan = r.exposed_retargetTarget(oldTarget, 0, timespan);
        assertLt(negSpan, evenSpan, "min-span target sits below the even-span target");
        // A span at/over the upper clamp can't exceed the *4 cap either.
        uint256 hugeSpan = r.exposed_retargetTarget(oldTarget, 0, timespan * 100);
        assertEq(hugeSpan, r.exposed_retargetTarget(oldTarget, 0, timespan * 4), "huge span clamps to *4");
    }

    // Genesis rejects a malformed anchor checkpoint: a zero tipHash (which would terminate the
    // blockParent / median-time-past walks) or zero cumulative work (which any block could tie).
    function test_genesis_rejects_zero_anchor() public {
        TestLightRelay r = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidAnchor.selector);
        r.genesis(0, TEST_TARGET, 1000, bytes32(0), 0, 1); // zero tipHash

        TestLightRelay r2 = new TestLightRelay();
        vm.expectRevert(BitcoinLightRelayBase.InvalidAnchor.selector);
        r2.genesis(0, TEST_TARGET, 1000, keccak256("x"), 0, 0); // zero tipWork
    }

    // Burn-inclusion proofs anchor to the tip OR a canonical ancestor within
    // FINALITY_WINDOW (6), so a tip advance mid-withdrawal doesn't revert — while
    // still rejecting beyond-window, forged-side-chain, and ahead-of-tip claims.
    function test_anchorChain_finality_window() public {
        TestLightRelay r = new TestLightRelay();
        // Canonical chain bh[0..6] at heights 100..106, tip at 106.
        bytes32[] memory bh = new bytes32[](7);
        for (uint256 i; i < 7; ++i) {
            bh[i] = keccak256(abi.encodePacked("blk", i));
        }
        for (uint256 i = 1; i < 7; ++i) {
            r.seedBlock(bh[i], bh[i - 1], 0);
        }
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

    // The epoch-start timestamp feeding a boundary crossing is carried PER BLOCK on the crossing branch
    // (epochStartTs), never from a global per-epoch value. Two branches that replaced each other's epoch-1
    // first block must therefore carry DIFFERENT epoch-start timestamps — the crux of the R-1 per-branch
    // retarget. Each branch's epoch-1 blocks inherit their own boundary block's timestamp.
    function test_epoch_start_ts_is_branch_local_not_cached() public {
        TestLightRelay r = new TestLightRelay();
        r.genesis(0, TEST_TARGET, 1000, keccak256("g"), 0, 1); // genesisEpoch = 0
        bytes32 b2015 = keccak256("b2015");
        // Branch X: epoch-1 first block at 2016 (a boundary) with ts 5000, extended to 2018 (inherits 5000).
        bytes32 x2016 = keccak256("x2016");
        bytes32 x2017 = keccak256("x2017");
        bytes32 x2018 = keccak256("x2018");
        r.seedKnownBlock(x2016, b2015, 5000, 2016, 10);
        r.seedKnownBlock(x2017, x2016, 5001, 2017, 11);
        r.seedKnownBlock(x2018, x2017, 5002, 2018, 12);
        // Branch Y: a COMPETING epoch-1 first block at 2016 with a different ts (7000).
        bytes32 y2016 = keccak256("y2016");
        bytes32 y2017 = keccak256("y2017");
        bytes32 y2018 = keccak256("y2018");
        r.seedKnownBlock(y2016, b2015, 7000, 2016, 10);
        r.seedKnownBlock(y2017, y2016, 7001, 2017, 11);
        r.seedKnownBlock(y2018, y2017, 7002, 2018, 12);
        r.seedTip(x2018, 2018); // X is the canonical tip — Y must STILL carry its own epoch start

        assertEq(r.epochStartTs(x2016), 5000, "X's boundary block records its own ts");
        assertEq(r.epochStartTs(x2018), 5000, "branch X carries its own epoch-1 first-block ts");
        assertEq(r.epochStartTs(y2018), 7000, "branch Y carries ITS own, not the tip's");
        // The anchor is seeded with the genesis epoch's first-block ts.
        assertEq(r.epochStartTs(keccak256("g")), 1000, "genesis: deployer-seeded epoch-start on the anchor");
    }

    // ──────────────────── R-1: reorg / per-branch-target coverage ────────────────────

    /// @dev A header carrying arbitrary nBits (TestHelper's _makeHeader hardcodes 0x1d00ffff), so a
    ///      boundary crossing can be submitted with a branch's OWN derived target.
    function _makeHeaderWithBits(bytes32 prevBlock, bytes32 merkleRoot, uint32 ts, uint32 bits)
        internal
        pure
        returns (bytes memory h)
    {
        h = new bytes(80);
        h[0] = 0x01;
        for (uint256 i; i < 32; ++i) {
            h[4 + i] = prevBlock[i];
            h[36 + i] = merkleRoot[i];
        }
        h[68] = bytes1(uint8(ts));
        h[69] = bytes1(uint8(ts >> 8));
        h[70] = bytes1(uint8(ts >> 16));
        h[71] = bytes1(uint8(ts >> 24));
        h[72] = bytes1(uint8(bits));
        h[73] = bytes1(uint8(bits >> 8));
        h[74] = bytes1(uint8(bits >> 16));
        h[75] = bytes1(uint8(bits >> 24));
    }

    // (a) Ordinary within-epoch reorg: a longer competing branch off the same parent overtakes the tip,
    // and the losing branch's blocks stay stored (so a later extension of it can still win).
    function test_advanceTip_within_epoch_reorg_heaviest_wins() public {
        MockPowLightRelay r = new MockPowLightRelay();
        uint32 T = 1_700_000_000;
        bytes32 anchor = keccak256("anchor");
        r.genesis(0, TEST_TARGET, T, anchor, 100, 1);
        vm.warp(T + 100_000);

        // Branch X: two blocks (heights 101, 102) — becomes the tip.
        bytes memory x1 = _makeHeader(anchor, keccak256("x1"), T + 600, 1);
        bytes memory x2 = _makeHeader(_dsha256(x1), keccak256("x2"), T + 1200, 2);
        r.advanceTip(bytes.concat(x1, x2));
        assertEq(r.tip(), _dsha256(x2), "X is the tip");
        uint256 xWork = r.tipWork();

        // Branch Y: two blocks off the same parent — EQUAL work, so the strict `>` rule keeps X as tip.
        bytes memory y1 = _makeHeader(anchor, keccak256("y1"), T + 700, 3);
        bytes memory y2 = _makeHeader(_dsha256(y1), keccak256("y2"), T + 1300, 4);
        r.advanceTip(bytes.concat(y1, y2));
        assertEq(r.tip(), _dsha256(x2), "equal work does NOT reorg (first-seen wins)");
        assertEq(r.tipWork(), xWork);
        assertEq(r.blockHeight(_dsha256(y2)), 102, "losing branch is still stored");

        // Extending Y by one block makes it heavier — now it takes the tip.
        bytes memory y3 = _makeHeader(_dsha256(y2), keccak256("y3"), T + 1900, 5);
        r.advanceTip(y3);
        assertEq(r.tip(), _dsha256(y3), "heavier branch reorgs the tip");
        assertEq(r.tipHeight(), 103);
        assertGt(r.tipWork(), xWork);
    }

    // (b) A multi-block fork that crosses a retarget boundary and overtakes, and a competing crossing on
    // the other branch that LOSES. Both cross — the boundary is no longer a tip-only privilege (R-1) — but
    // only the heavier one moves the tip.
    function test_advanceTip_multiblock_boundary_fork_winner_and_loser() public {
        MockPowLightRelay r = new MockPowLightRelay();
        uint32 T = 1_700_000_000;
        uint32 TS = uint32(r.TARGET_TIMESPAN()); // elapsed == TARGET_TIMESPAN ⇒ target unchanged
        bytes32 anchor = keccak256("anchor");
        r.genesis(0, TEST_TARGET, T, anchor, 2000, 1);
        vm.warp(uint256(T) + TS + 100_000);

        // Two competing epoch-0 boundary blocks at height 2015, equal work; A is the tip.
        bytes32 A = keccak256("A-2015");
        bytes32 B = keccak256("B-2015");
        r.seedKnownBlock(A, anchor, T + TS, 2015, 1000);
        r.seedBlockTarget(A, TEST_TARGET);
        r.seedKnownBlock(B, anchor, T + TS, 2015, 1000);
        r.seedBlockTarget(B, TEST_TARGET);
        r.seedTipFull(A, 2015, 1000);

        // Fork B crosses the boundary with THREE blocks and overtakes.
        bytes memory b1 = _makeHeader(B, keccak256("b1"), T + TS + 600, 1);
        bytes memory b2 = _makeHeader(_dsha256(b1), keccak256("b2"), T + TS + 1200, 2);
        bytes memory b3 = _makeHeader(_dsha256(b2), keccak256("b3"), T + TS + 1800, 3);
        r.advanceTip(bytes.concat(b1, b2, b3));
        assertEq(r.tip(), _dsha256(b3), "multi-block fork crossed the boundary and took the tip");
        assertEq(r.tipHeight(), 2018);
        assertEq(r.blockTarget(_dsha256(b1)), TEST_TARGET, "crossing block derived its own branch's target");

        // Branch A also crosses — but with only ONE block, so it loses the fork choice. It is still stored
        // with a correct per-branch target, so a later extension of A can win without re-submitting it.
        bytes memory a1 = _makeHeader(A, keccak256("a1"), T + TS + 700, 4);
        r.advanceTip(a1);
        assertEq(r.tip(), _dsha256(b3), "the lighter crossing does not take the tip");
        assertEq(r.blockHeight(_dsha256(a1)), 2016, "but the losing crossing IS stored");
        assertEq(r.blockTarget(_dsha256(a1)), TEST_TARGET, "with its own branch-derived target");
    }

    // (c) THE CRUX OF R-1: two branches whose epoch-0 boundary timestamps differ enough to derive DIFFERENT
    // epoch-1 targets. Each branch's crossing block must validate against ITS OWN derived target — and a
    // crossing carrying the OTHER branch's nBits must be rejected. A single global epochTarget cannot
    // express this: whichever branch crossed first would fix the target for both.
    function test_advanceTip_diverging_branches_derive_different_targets() public {
        MockPowLightRelay r = new MockPowLightRelay();
        uint32 T = 1_700_000_000;
        uint32 TS = uint32(r.TARGET_TIMESPAN());
        // Genesis target strictly below MAX_TARGET so an EASIER derived target isn't clipped by the cap.
        uint256 G = uint256(0xffff) << 200; // canonical: bits 0x1c00ffff
        bytes32 anchor = keccak256("anchor");
        r.genesis(0, G, T, anchor, 2000, 1);

        // Branch A's boundary block: elapsed == TARGET_TIMESPAN ⇒ target unchanged.
        bytes32 A = keccak256("A-2015");
        r.seedKnownBlock(A, anchor, T + TS, 2015, 1000);
        r.seedBlockTarget(A, G);
        // Branch B's boundary block: a far later timestamp ⇒ elapsed clamps to 4x ⇒ a 4x EASIER target.
        bytes32 B = keccak256("B-2015");
        uint32 bTs = T + 5 * TS;
        r.seedKnownBlock(B, anchor, bTs, 2015, 1000);
        r.seedBlockTarget(B, G);
        r.seedTipFull(A, 2015, 1000);
        vm.warp(uint256(bTs) + 100_000);

        uint256 targetA = r.exposed_retargetTarget(G, T, T + TS);
        uint256 targetB = r.exposed_retargetTarget(G, T, bTs);
        assertEq(targetA, G, "branch A: unchanged");
        assertGt(targetB, targetA, "branch B: a genuinely different (easier) per-branch target");

        // Each branch's crossing validates against its OWN target.
        bytes memory a1 =
            _makeHeaderWithBits(A, keccak256("a1"), T + TS + 600, r.exposed_targetToCompact(targetA));
        r.advanceTip(a1);
        assertEq(r.blockTarget(_dsha256(a1)), targetA, "A's crossing carries A's derived target");

        bytes memory b1 = _makeHeaderWithBits(B, keccak256("b1"), bTs + 600, r.exposed_targetToCompact(targetB));
        r.advanceTip(b1);
        assertEq(r.blockTarget(_dsha256(b1)), targetB, "B's crossing carries B's OWN, different target");

        // Cross-using the other branch's nBits is rejected — a branch cannot borrow a cheaper target.
        bytes memory bad =
            _makeHeaderWithBits(A, keccak256("bad"), T + TS + 900, r.exposed_targetToCompact(targetB));
        vm.expectRevert(BitcoinLightRelayBase.InvalidPoW.selector);
        r.advanceTip(bad);
    }

    // (d) The genesis epoch's first block sits below the mid-epoch anchor and is never submitted, so the
    // FIRST boundary crossing must use the deployer-seeded epochStartTimestamp — and must reproduce
    // _retargetTarget over exactly (seeded epoch start, boundary block ts).
    function test_advanceTip_genesis_epoch_crossing_uses_seeded_epoch_start() public {
        MockPowLightRelay r = new MockPowLightRelay();
        uint32 T = 1_700_000_000;
        uint32 TS = uint32(r.TARGET_TIMESPAN());
        uint256 G = uint256(0xffff) << 200;
        bytes32 anchor = keccak256("anchor");
        r.genesis(0, G, T, anchor, 2000, 1);

        // A boundary block whose ts yields a target that is neither unchanged nor clamped.
        uint32 bTs = T + TS + (TS / 2);
        bytes32 A = keccak256("A-2015");
        r.seedKnownBlock(A, anchor, bTs, 2015, 1000);
        r.seedBlockTarget(A, G);
        r.seedTipFull(A, 2015, 1000);
        vm.warp(uint256(bTs) + 100_000);

        uint256 expected = r.exposed_retargetTarget(G, T, bTs); // T == epochStartTimestamp[0], the seed
        assertGt(expected, G, "a longer-than-target epoch eases difficulty");
        bytes memory a1 =
            _makeHeaderWithBits(A, keccak256("a1"), bTs + 600, r.exposed_targetToCompact(expected));
        r.advanceTip(a1);
        assertEq(r.blockTarget(_dsha256(a1)), expected, "genesis-epoch crossing used the seeded epoch start");
        assertEq(r.tipHeight(), 2016);
    }

    // (e) A NON-genesis crossing reads the branch's epoch-start timestamp in O(1) from the boundary parent's
    // per-block `epochStartTs` — no walk. Seeds a full epoch, confirms the boundary parent carries epoch 1's
    // first-block ts, crosses the boundary, and asserts the crossing costs a normal advance (not the former
    // 2015-SLOAD, ~4.2M-gas spike) — the crossing is no longer a standing liveness dependency.
    function test_advanceTip_non_genesis_crossing_is_o1() public {
        MockPowLightRelay r = new MockPowLightRelay();
        uint32 T = 1_700_000_000;
        uint32 TS = uint32(r.TARGET_TIMESPAN());
        uint256 G = uint256(0xffff) << 200;
        r.genesis(0, G, T, keccak256("anchor"), 100, 1);

        // Seed all of epoch 1: heights 2016 (its first block) .. 4031 (its boundary block), 600s apart.
        uint32 epoch1Start = T + TS; // ts of height 2016 — the epoch-start value carried per block
        bytes32 prev = keccak256("b2015");
        for (uint256 h = 2016; h <= 4031; ++h) {
            bytes32 bh = keccak256(abi.encodePacked("e1-", h));
            r.seedKnownBlock(bh, prev, epoch1Start + uint32((h - 2016) * 600), h, 1000 + h);
            r.seedBlockTarget(bh, G);
            prev = bh;
        }
        bytes32 last = prev; // height 4031, the last block of epoch 1
        r.seedTipFull(last, 4031, 1000 + 4031);
        uint32 lastTs = epoch1Start + uint32(2015 * 600);
        vm.warp(uint256(lastTs) + 100_000);

        assertEq(r.epochStartTs(last), epoch1Start, "boundary parent carries epoch 1's first-block ts");
        uint256 expected = r.exposed_retargetTarget(G, epoch1Start, lastTs);

        bytes memory cross =
            _makeHeaderWithBits(last, keccak256("cross4032"), lastTs + 600, r.exposed_targetToCompact(expected));
        // Cool the relay's storage so the measured cost reflects real cold-SLOAD on-chain pricing.
        vm.cool(address(r));
        uint256 gasBefore = gasleft();
        r.advanceTip(cross);
        uint256 used = gasBefore - gasleft();

        assertEq(r.tipHeight(), 4032, "crossed the non-genesis boundary");
        assertEq(r.blockTarget(_dsha256(cross)), expected, "target derived from the branch's own epoch-start ts");
        // The crossing now reads ONE per-block epochStartTs slot instead of walking 2015 parents, so it costs
        // an ordinary advance — orders of magnitude below the former ~4.2M-gas boundary spike.
        assertLt(used, 500_000, "boundary crossing is O(1), no longer a 4.2M-gas liveness dependency");
        emit log_named_uint("boundary-crossing advanceTip gas", used);
    }
}
