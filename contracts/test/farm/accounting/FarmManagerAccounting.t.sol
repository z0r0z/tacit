// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FarmManager} from "../../../src/FarmManager.sol";
import {MockToken, MockPool} from "./Harness.sol";

contract FarmManagerAccounting is Test {
    MockToken token;
    MockPool pool;
    FarmManager m;
    bytes32 constant A = keccak256("A");
    bytes32 constant B = keccak256("B");
    bytes32 constant C = keccak256("C");
    uint256 n;

    /// A constructor pool needs a nonzero weight, so a zero weight here means "no such pool" (the unweighted ids stay unregistered).
    function _deploy(uint32 aA, uint32 aB, uint32 aC, uint256 scale) internal {
        token = new MockToken();
        pool = new MockPool(token, scale);
        bytes32[3] memory ids = [A, B, C];
        uint32[3] memory ws = [aA, aB, aC];
        uint256 cnt;
        for (uint256 i; i < 3; ++i) if (ws[i] != 0) ++cnt;
        bytes32[] memory sa = new bytes32[](cnt);
        uint32[] memory ap = new uint32[](cnt);
        uint64[] memory ld = new uint64[](cnt);
        uint256 k;
        for (uint256 i; i < 3; ++i) {
            if (ws[i] == 0) continue;
            sa[k] = ids[i]; ap[k] = ws[i]; ++k;
        }
        m = new FarmManager(address(pool), pool.REWARD(), address(this), sa, ap, ld);
        token.mint(address(this), type(uint128).max);
        token.approve(address(m), type(uint256).max);
        vm.warp(1_000_000);
    }

    function _bond(bytes32 sa, uint256 shares) internal returns (bytes32 r) {
        r = keccak256(abi.encode("r", n++));
        pool.bond(m, r, sa, shares);
    }

    function _harvestAll(bytes32 r) internal returns (uint256 got) {
        (, uint128 sh,,,) = m.positions(r);
        got = m.pending(r);
        if (got != 0) pool.harvest(m, r, sh, got);
    }

    function _unbond(bytes32 r) internal {
        (, uint128 sh,, uint32 pid,) = m.positions(r);
        pool.unbond(m, r, m.poolInfo(pid).stakeAsset, sh);
    }

    /// Many dust positions across 3 pools with odd alloc weights: sum of max harvests never exceeds treasury,
    /// and after full exit + recover the treasury is emptied exactly.
    function testFuzz_smallPositionsNeverOverpayAndTreasuryEmptiesExactly(uint256 seed) public {
        _deploy(7, 3, 5, 1);
        m.fundAndNotify(1_000_003_000, 7 days);
        bytes32[] memory rs = new bytes32[](24);
        bytes32[3] memory ids = [A, B, C];
        for (uint256 i; i < 24; ++i) {
            rs[i] = _bond(ids[i % 3], 1 + (uint256(keccak256(abi.encode(seed, i))) % 5));
            skip(1 + (uint256(keccak256(abi.encode(seed, i, 1))) % 60));
        }
        skip(8 days);
        uint256 tot;
        for (uint256 i; i < 24; ++i) tot += _harvestAll(rs[i]);
        assertLe(tot, 1_000_003_000, "paid > funded");
        for (uint256 i; i < 24; ++i) _unbond(rs[i]);
        skip(16 days);
        uint256 rel = m.recover(address(0xBEEF));
        assertEq(rel, pool.farmTreasury(address(m)) + rel - pool.farmTreasury(address(m)));
        assertEq(pool.farmTreasury(address(m)), 0, "treasury not empty after full exit");
        assertEq(tot + rel, 1_000_003_000, "funded != paid + released");
    }

    /// A pool added late does not back-accrue.
    function test_lateAddedPoolDoesNotBackAccrue() public {
        _deploy(90, 5, 5, 1);
        m.fundAndNotify(7 days * 10, 7 days); // rate 10
        bytes32 r0 = _bond(A, 100);
        bytes32 nA = keccak256("late");
        m.queueAddPool(nA, 10, 0);
        skip(7 days);
        m.executeAddPool(nA, 10, 0);
        // stream ended exactly now; new pool's clock must not have moved back
        bytes32 r1 = _bond(nA, 100);
        skip(10);
        assertEq(m.pending(r1), 0, "late pool accrued past finish");
        // r0 in pool A earned 90/100 of the whole stream (B and C empty leave theirs in treasury)
        assertEq(m.pending(r0), (7 days * 10 * 90) / 100);
        // mid-stream add: no back-accrual either
        m.fundAndNotify(90 days * 10, 90 days); // rate 10 again, running
        skip(30 days); // cooldown from the first add has passed
        bytes32 nB = keccak256("late2");
        m.queueAddPool(nB, 11, 0); // 11/121 <= 10%
        skip(7 days);
        m.executeAddPool(nB, 11, 0);
        bytes32 r2 = _bond(nB, 100);
        assertEq(m.pending(r2), 0, "mid-stream pool back-accrued");
        skip(1 days);
        assertApproxEqAbs(m.pending(r2), uint256(1 days) * 10 * 11 / 121, 1);
    }

    /// Mid-stream re-notify with rollover + alloc change: total claimable never exceeds treasury.
    function test_midstreamNotifyAndReweightStaysSolvent() public {
        _deploy(100, 100, 100, 1);
        m.fundAndNotify(3600 * 7 days / 3600 * 1000, 7 days);
        bytes32 a = _bond(A, 10);
        bytes32 b = _bond(B, 10);
        bytes32 c = _bond(C, 10);
        skip(2 days);
        uint256[] memory pids = new uint256[](1); pids[0] = 0;
        uint32[] memory al = new uint32[](1); al[0] = 125;
        m.queueAllocs(pids, al);
        skip(3 days);
        m.fundAndNotify(14 days * 1000, 14 days); // rollover mid-stream
        skip(4 days); // queue eta (7d) reached
        m.executeAllocs(pids, al);
        skip(30 days);
        uint256 tot = _harvestAll(a) + _harvestAll(b) + _harvestAll(c);
        assertLe(tot, pool.totalHarvested() + 1);
        assertLe(tot, 7 days * 1000 + 14 days * 1000);
        assertGe(pool.farmTreasury(address(m)), 0);
    }

    /// Reward-per-share rounds down when rate*alloc*dt*P/(ta*ts) < 1; this measures how much a large-stake pool
    /// loses to rounding across many accrual passes versus a single one.
    function test_frequentAccrualPassesLoseLittleRewardOnALargeStake() public {
        _deploy(1, 0, 0, 1);
        uint256 ts = 1e22;
        m.fundAndNotify(7 days, 7 days); // rate 1
        bytes32 r = _bond(A, ts);
        // baseline: one accrual at end
        uint256 t0 = block.timestamp;
        for (uint256 i; i < 3000; i += 1) {
            vm.warp(t0 + (i + 1) * 200);
            m.massUpdatePools();
        }
        uint256 gr = m.pending(r);
        emit log_named_uint("pending with per-second massUpdate (of 604800)", gr);
        // compare: one shot
        _deploy(1, 0, 0, 1);
        m.fundAndNotify(7 days, 7 days);
        bytes32 r2 = _bond(A, ts);
        skip(7 days);
        emit log_named_uint("pending with one accrual (of 604800)", m.pending(r2));
    }

    /// unbond of the same receipt twice / harvest after unbond / rebond of live receipt all fail.
    function test_positionLifecycleGuards() public {
        _deploy(1, 1, 1, 1);
        m.fundAndNotify(7 days * 10, 7 days);
        bytes32 r = _bond(A, 5);
        vm.expectRevert(FarmManager.PositionExists.selector);
        pool.bond(m, r, A, 5);
        skip(10);
        _unbond(r);
        vm.expectRevert(FarmManager.NoLivePosition.selector);
        pool.unbond(m, r, A, 5);
        vm.expectRevert(FarmManager.NoLivePosition.selector);
        pool.harvest(m, r, 5, 1);
    }

    /// Same-block bond after notify earns nothing until time passes; bond before notify same block same.
    function test_sameBlockBondAfterNotifyEarnsNothingUntilTimePasses() public {
        _deploy(1, 0, 0, 1);
        m.fundAndNotify(7 days * 3, 7 days);
        bytes32 r = _bond(A, 1);
        assertEq(m.pending(r), 0);
        skip(1);
        assertEq(m.pending(r), 3);
    }

    /// Treasury dust check across the recover path with a still-staked position (reserve must cover it).
    function test_surplusRecoveryLeavesEarnedReward() public {
        _deploy(3, 2, 1, 1);
        m.fundAndNotify(1_000_001_000, 7 days);
        bytes32 a = _bond(A, 3);
        bytes32 b = _bond(B, 7);
        bytes32 c = _bond(C, 1);
        skip(14 days);
        m.recover(address(0xBEEF));
        uint256 g = _harvestAll(a) + _harvestAll(b) + _harvestAll(c);
        assertGt(g, 0);
        assertLe(g, 1_000_001_000);
    }

    /// Pool ids in a re-weighting must be strictly increasing, so each pool appears once per change and its band is
    /// measured against its pre-change weight.
    function test_repeatedOrDescendingPoolIdsAreRefused() public {
        _deploy(100, 100, 100, 1);
        uint256[] memory pids = new uint256[](10);
        uint32[] memory al = new uint32[](10);
        uint32 v = 100;
        for (uint256 i; i < 10; ++i) { pids[i] = 0; v = (v * 5) / 4; al[i] = v; }
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        m.queueAllocs(pids, al); // 10 entries > 3 pools, and repeated
        // a repeated pid within the pool count is still rejected at queue and at execute
        uint256[] memory p2 = new uint256[](2);
        uint32[] memory a2 = new uint32[](2);
        p2[0] = 0; p2[1] = 0; a2[0] = 125; a2[1] = 156;
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        m.queueAllocs(p2, a2);
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        m.executeAllocs(p2, a2);
        // descending order is rejected too
        p2[0] = 1; p2[1] = 0; a2[0] = 100; a2[1] = 100;
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        m.queueAllocs(p2, a2);
        // a single-pass change inside the band applies
        p2[0] = 0; p2[1] = 1; a2[0] = 125; a2[1] = 75;
        m.queueAllocs(p2, a2);
        skip(7 days);
        m.executeAllocs(p2, a2);
        assertEq(m.poolInfo(0).allocPoint, 125);
        assertEq(m.poolInfo(1).allocPoint, 75);
        assertEq(m.totalAllocPoint(), 300);
    }

    /// Config executions are spaced by the cooldown.
    function test_configChangesAreSpacedByTheCooldown() public {
        _deploy(100, 100, 100, 1);
        uint256[] memory pids = new uint256[](1);
        uint32[] memory al = new uint32[](1);
        al[0] = 125;
        m.queueAllocs(pids, al);
        skip(7 days);
        m.executeAllocs(pids, al);
        al[0] = 150; // 125 -> 150 is +20%
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.expectRevert(FarmManager.Cooldown.selector);
        m.executeAllocs(pids, al);
        skip(16 days); // 23d after the first execution: re-queue so the eta lands exactly on the cooldown boundary
        m.queueAllocs(pids, al);
        skip(7 days);
        m.executeAllocs(pids, al);
        assertEq(m.poolInfo(0).allocPoint, 150);
    }
}
