// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import "forge-std/Test.sol";
import {CdpLeg} from "../../../src/ConfidentialPool.sol";
import {FarmManager} from "../../../src/FarmManager.sol";

contract MTok {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

interface IOut { function outstandingReward() external view returns (uint256); function REWARD_ASSET() external view returns (bytes32); }

/// Mirrors the real pool's farm seam: funding pulls the ERC20 and credits the per-controller treasury (amount/scale),
/// recover releases treasury - controller.outstandingReward(), harvest debits the treasury BEFORE the hook.
contract MockPool {
    MTok public tok;
    uint256 public scale;
    bytes32 public constant RA = keccak256("wTAC");
    mapping(address => bytes32) public pinned;
    mapping(address => uint256) public farmTreasury;

    constructor(MTok t, uint256 s) { tok = t; scale = s; }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        if (id != RA) return (false, address(0), 0, bytes32(0), false, 0);
        return (true, address(tok), scale, bytes32(0), false, 18);
    }

    function farmEscrow(address controller, bytes32 ra, uint256 amount, address to) external returns (uint256 out) {
        if (amount == 0) {
            require(pinned[msg.sender] != 0 && pinned[msg.sender] == ra, "nopin");
            uint256 reserve = IOut(msg.sender).outstandingReward();
            out = farmTreasury[msg.sender];
            out = out > reserve ? out - reserve : 0;
            farmTreasury[msg.sender] -= out;
            tok.transfer(to, out * scale);
        } else {
            if (pinned[controller] == 0) {
                require(ra == IOut(controller).REWARD_ASSET(), "asset");
                pinned[controller] = ra;
            }
            require(amount % scale == 0, "align");
            tok.transferFrom(msg.sender, address(this), amount);
            out = amount / scale;
            farmTreasury[controller] += out;
        }
    }

    function bond(FarmManager m, bytes32 receipt, bytes32 stakeAsset, uint256 shares) external {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stakeAsset, shares);
        m.onCdpMint(l, 0, bytes32(uint256(1)), uint256(receipt));
    }

    function harvest(FarmManager m, bytes32 receipt, uint256 shares, uint256 amt) external {
        require(farmTreasury[address(m)] >= amt, "InsufficientEscrow");
        farmTreasury[address(m)] -= amt;
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(RA, shares);
        m.onCdpMint(l, amt, bytes32(uint256(1)), uint256(receipt));
    }

    function unbond(FarmManager m, bytes32 receipt, bytes32 stakeAsset, uint256 shares) external {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stakeAsset, shares);
        m.onCdpClose(0, 0, uint256(receipt), l, bytes32(0));
    }
}

contract FarmManagerConfigTest is Test {
    MTok tok;
    MockPool pool;
    FarmManager m;
    address gov = address(0xC0FFEE);
    address other = address(0xB0B);
    bytes32 constant S0 = keccak256("lp0");
    bytes32 constant S1 = keccak256("lp1");
    bytes32 constant S2 = keccak256("lp2");

    /// `a1 == 0` deploys a single-pool manager (a constructor pool needs a nonzero weight).
    function _deploy(uint32 a0, uint32 a1, uint64 l0, uint64 l1) internal {
        tok = new MTok();
        pool = new MockPool(tok, 1);
        uint256 n = a1 == 0 ? 1 : 2;
        bytes32[] memory s = new bytes32[](n);
        uint32[] memory a = new uint32[](n);
        uint64[] memory l = new uint64[](n);
        s[0] = S0; a[0] = a0; l[0] = l0;
        if (n == 2) { s[1] = S1; a[1] = a1; l[1] = l1; }
        m = new FarmManager(address(pool), pool.RA(), gov, s, a, l);
        tok.mint(gov, 1e30);
        vm.prank(gov);
        tok.approve(address(m), type(uint256).max);
    }

    function _fundStart(uint256 amt, uint256 dur) internal {
        vm.prank(gov);
        m.fundAndNotify(amt, dur);
    }

    // ───────────────────────── schedule bounds ─────────────────────────
    /// A program lasts at least MIN_DURATION and a running schedule's end can never move earlier.
    function test_scheduleEndNeverMovesEarlier() public {
        _deploy(100, 0, 0, 0);
        uint256 budget = 100 days * 1e9; // rate = 1e9 value units / s
        _fundStart(budget, 100 days);
        pool.bond(m, bytes32(uint256(11)), S0, 100);
        skip(1 days);
        uint256 rateBefore = m.rate();
        uint256 finishBefore = m.periodFinish();
        vm.startPrank(gov);
        vm.expectRevert(FarmManager.DurationTooShort.selector);
        m.notifyRewardAmount(0, 1); // below the minimum duration
        vm.expectRevert(FarmManager.DurationTooShort.selector);
        m.notifyRewardAmount(0, 7 days - 1);
        vm.expectRevert(FarmManager.EndMovesEarlier.selector);
        m.notifyRewardAmount(0, 7 days); // the shortest legal duration still ends 92d before the running schedule
        vm.expectRevert(FarmManager.EndMovesEarlier.selector);
        m.notifyRewardAmount(0, 98 days); // any earlier end
        vm.stopPrank();
        assertEq(m.rate(), rateBefore);
        assertEq(m.periodFinish(), finishBefore);
        // a staked position keeps earning at the unchanged rate
        skip(1 days);
        assertApproxEqAbs(m.pending(bytes32(uint256(11))), 2 days * 1e9, 2);
    }

    // ───────────────────────── weights ─────────────────────────
    /// A weight can never go to 0 and moves at most +-25% per change, so a locked pool keeps a bounded share of the stream.
    function test_weightsStayWithinTheBand() public {
        _deploy(50, 50, 30 days, 0); // pool0: 30d lock, pool1: no lock
        _fundStart(90 days * 1e6, 90 days);
        pool.bond(m, bytes32(uint256(1)), S0, 1000); // pool0 position
        pool.bond(m, bytes32(uint256(2)), S1, 1); // pool1 position
        uint256[] memory pids = new uint256[](2);
        uint32[] memory al = new uint32[](2);
        pids[0] = 0; pids[1] = 1; al[0] = 0; al[1] = 100;
        vm.prank(gov);
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.prank(gov);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAllocs(pids, al);
        // the widest legal change: 50/50 -> 38/62 (each within +-25%)
        al[0] = 38; al[1] = 62;
        vm.startPrank(gov);
        m.queueAllocs(pids, al);
        skip(7 days);
        m.executeAllocs(pids, al);
        vm.stopPrank();
        // the pool0 position is still locked (30d > the 7d notice) and keeps a 38% weight
        vm.expectRevert(FarmManager.Locked.selector);
        pool.unbond(m, bytes32(uint256(1)), S0, 1000);
        skip(60 days);
        uint256 h = m.pending(bytes32(uint256(1)));
        uint256 g = m.pending(bytes32(uint256(2)));
        emit log_named_uint("pool0 pending after the reweight", h);
        emit log_named_uint("pool1 pending after the reweight", g);
        assertGt(h * 100, (h + g) * 35, "pool0 keeps >35% of the stream");
        assertGt(g, 0);
    }

    /// A new pool's weight must be nonzero and at most 10% of the new total.
    function test_newPoolWeightIsCapped() public {
        _deploy(100, 0, 0, 0);
        _fundStart(90 days * 1e6, 90 days);
        pool.bond(m, bytes32(uint256(1)), S0, 1000);
        vm.startPrank(gov);
        m.queueAddPool(S2, 4_000_000_000, 0);
        m.queueAddPool(S2, 12, 0); // 12/112 > 10%
        m.queueAddPool(S2, 0, 0);
        m.queueAddPool(S2, 11, 0); // 11/111 <= 10%
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAddPool(S2, 4_000_000_000, 0);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAddPool(S2, 12, 0);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAddPool(S2, 0, 0);
        m.executeAddPool(S2, 11, 0);
        vm.stopPrank();
        assertEq(m.totalAllocPoint(), 111);
        // the existing pool keeps 100/111 of the stream
        skip(90 days + 7 days);
        uint256 earned = m.pending(bytes32(uint256(1)));
        vm.prank(gov);
        uint256 rec = m.recover(other);
        emit log_named_uint("earned", earned);
        emit log_named_uint("recovered", rec);
        assertLt(rec, uint256(90 days) * 1e6 / 9, "recoverable slice is only the empty pool's <=10%");
    }

    /// No weight can be set to 0, so the total allocation never reaches zero.
    function test_weightsCannotAllBeZeroed() public {
        _deploy(50, 50, 0, 0);
        _fundStart(90 days * 1e6, 90 days);
        pool.bond(m, bytes32(uint256(1)), S0, 1000);
        uint256[] memory pids = new uint256[](2);
        uint32[] memory al = new uint32[](2);
        pids[0] = 0; pids[1] = 1;
        vm.startPrank(gov);
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAllocs(pids, al);
        vm.stopPrank();
        assertEq(m.totalAllocPoint(), 100);
    }

    // ───────────────────────── funding ─────────────────────────
    /// Funding measures the pull against the balance before and after, so a stray token balance does not affect it.
    function test_fundingWorksWithAStrayTokenBalance() public {
        _deploy(100, 0, 0, 0);
        tok.mint(other, 1);
        vm.prank(other);
        tok.transfer(address(m), 1);
        vm.prank(gov);
        m.fundAndNotify(30 days * 1000, 30 days);
        assertGt(m.rate(), 0);
        vm.prank(gov);
        m.fund(1000);
        assertEq(pool.farmTreasury(address(m)), 30 days * 1000 + 1000);
        assertEq(tok.balanceOf(address(m)), 1, "only the stray balance stays behind");
    }

    // ───────────────────────── queue, window and handover ─────────────────────────
    function test_queuedChangeMatchesItsArgumentsAndRunsOnce() public {
        _deploy(50, 50, 0, 0);
        uint256[] memory p = new uint256[](1);
        uint32[] memory a = new uint32[](1);
        p[0] = 0; a[0] = 40;
        vm.prank(gov);
        m.queueAllocs(p, a);
        skip(7 days);
        a[0] = 41;
        vm.prank(gov);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(p, a);
        a[0] = 40;
        vm.startPrank(gov);
        m.executeAllocs(p, a);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(p, a);
        vm.stopPrank();
    }

    function test_changeRunsOnlyInsideItsWindow() public {
        _deploy(50, 50, 0, 0);
        uint256[] memory p = new uint256[](1);
        uint32[] memory a = new uint32[](1);
        a[0] = 40;
        vm.startPrank(gov);
        m.queueAllocs(p, a);
        skip(7 days - 1);
        vm.expectRevert(FarmManager.NotReady.selector);
        m.executeAllocs(p, a);
        skip(14 days + 2);
        vm.expectRevert(FarmManager.Expired.selector);
        m.executeAllocs(p, a);
        vm.stopPrank();
    }

    /// A governor handover invalidates the previous governor's queued changes (queue ids are bound to the governor tenure).
    function test_governorHandoverClearsTheQueue() public {
        _deploy(50, 50, 0, 0);
        uint256[] memory p = new uint256[](1);
        uint32[] memory a = new uint32[](1);
        a[0] = 40;
        vm.prank(gov);
        m.queueAllocs(p, a);
        vm.prank(gov);
        m.proposeGov(other);
        vm.prank(other);
        m.acceptGov();
        skip(7 days);
        vm.prank(other);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(p, a);
        vm.prank(gov);
        vm.expectRevert(FarmManager.NotGov.selector);
        m.executeAllocs(p, a);
    }

    function test_recoverWaitsForGraceAndReleasesOnlyTheSurplus() public {
        _deploy(100, 0, 0, 0);
        _fundStart(100 days * 1e6, 100 days);
        pool.bond(m, bytes32(uint256(1)), S0, 1000);
        vm.prank(gov);
        vm.expectRevert(FarmManager.TooEarly.selector);
        m.recover(gov);
        skip(100 days + 7 days - 1);
        vm.prank(gov);
        vm.expectRevert(FarmManager.TooEarly.selector);
        m.recover(gov);
        skip(1);
        vm.prank(gov);
        uint256 rec = m.recover(gov);
        assertLe(rec, 1, "only rounding dust released; the staker's earned reward is reserved");
        uint256 pend = m.pending(bytes32(uint256(1)));
        pool.harvest(m, bytes32(uint256(1)), 1000, pend);
        assertEq(pool.farmTreasury(address(m)), 0);
    }

    function test_scheduleRateAndDurationBounds() public {
        _deploy(100, 0, 0, 0);
        _fundStart(100 days * 1e6, 100 days);
        skip(10 days);
        vm.startPrank(gov);
        vm.expectRevert(FarmManager.RateDecrease.selector);
        m.notifyRewardAmount(0, 100 days);
        vm.expectRevert(FarmManager.RateDecrease.selector);
        m.notifyRewardAmount(0, 90 days + 1);
        vm.expectRevert(FarmManager.RateDecrease.selector);
        m.notifyRewardAmount(0, 365 days);
        vm.expectRevert(FarmManager.EndMovesEarlier.selector);
        m.notifyRewardAmount(0, 89 days);
        vm.expectRevert(FarmManager.ZeroDuration.selector);
        m.notifyRewardAmount(0, 0);
        vm.expectRevert(FarmManager.DurationTooLong.selector);
        m.notifyRewardAmount(0, 365 days + 1);
        vm.stopPrank();
    }

    function test_governorHandoverIsTwoStep() public {
        _deploy(100, 0, 0, 0);
        vm.prank(gov);
        m.proposeGov(other);
        vm.expectRevert(FarmManager.NotGov.selector);
        m.acceptGov();
        vm.prank(address(0xdead));
        vm.expectRevert(FarmManager.NotGov.selector);
        m.acceptGov();
        vm.prank(other);
        vm.expectRevert(FarmManager.NotGov.selector);
        m.proposeGov(other);
        vm.prank(other);
        m.acceptGov();
        assertEq(m.gov(), other);
        vm.prank(other);
        vm.expectRevert(FarmManager.NotGov.selector);
        m.acceptGov();
    }

    function test_hooksAreOnlyCallableByThePool() public {
        _deploy(100, 0, 0, 0);
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(S0, 1);
        vm.prank(other);
        vm.expectRevert(FarmManager.NotPool.selector);
        m.onCdpMint(l, 0, bytes32(uint256(1)), 1);
    }

    // notify with zero stakers everywhere: nothing accrues, recover returns the full pot; then stakers cannot be harmed
    function test_unstakedProgramIsFullyRecoverable() public {
        _deploy(100, 0, 0, 0);
        _fundStart(100 days * 1e6, 100 days);
        skip(107 days);
        vm.prank(gov);
        uint256 rec = m.recover(gov);
        assertEq(rec, 100 days * 1e6);
    }

    // stakers after recover / late bond cannot pull more than funded and unbond always works
    function test_unbondWorksAfterTheScheduleAndAWeightChange() public {
        _deploy(50, 50, 10 days, 10 days);
        _fundStart(100 days * 1e6, 100 days);
        pool.bond(m, bytes32(uint256(1)), S0, 777);
        pool.bond(m, bytes32(uint256(2)), S1, 333);
        uint256[] memory p = new uint256[](2);
        uint32[] memory a = new uint32[](2);
        p[0] = 0; p[1] = 1; a[0] = 62; a[1] = 62; // the widest legal single change
        vm.startPrank(gov);
        m.queueAllocs(p, a);
        skip(10 days);
        m.executeAllocs(p, a);
        vm.stopPrank();
        pool.unbond(m, bytes32(uint256(1)), S0, 777);
        pool.unbond(m, bytes32(uint256(2)), S1, 333);
    }

    // ───────────────────────── solvency fuzz: treasury always covers every earned reward ─────────────────────────
    function testFuzz_treasuryAlwaysCoversEarnedReward(uint256 seed) public {
        _deploy(40, 60, 1 days, 0);
        bytes32[4] memory rec;
        uint256[4] memory sh;
        uint256[4] memory pid;
        bool[4] memory live;
        uint256 harvested;
        uint256 funded;
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = seed % 7;
            uint256 k = (seed >> 8) % 4;
            if (op == 0) {
                uint256 amt = ((seed >> 16) % 1e12) + 1;
                uint256 dur = 7 days + ((seed >> 60) % (358 days + 1));
                vm.prank(gov);
                try m.fundAndNotify(amt, dur) { funded += amt; } catch {}
            } else if (op == 1 && !live[k]) {
                rec[k] = bytes32(uint256(100 + k + i * 10));
                sh[k] = ((seed >> 20) % 1e9) + 1;
                pid[k] = (seed >> 40) % 2;
                pool.bond(m, rec[k], pid[k] == 0 ? S0 : S1, sh[k]);
                live[k] = true;
            } else if (op == 2 && live[k]) {
                uint256 p = m.pending(rec[k]);
                if (p > 0) { pool.harvest(m, rec[k], sh[k], p); harvested += p; }
            } else if (op == 3 && live[k]) {
                try pool.unbond(m, rec[k], pid[k] == 0 ? S0 : S1, sh[k]) { live[k] = false; } catch {}
            } else if (op == 4) {
                skip((seed >> 30) % 30 days);
            } else if (op == 5) {
                // an in-band re-weight: each pool moves within [ceil(0.75 cur), floor(1.25 cur)]; the cooldown may reject it
                uint256[] memory p = new uint256[](2);
                uint32[] memory a = new uint32[](2);
                p[1] = 1;
                for (uint256 j; j < 2; ++j) {
                    uint256 cur = m.poolInfo(j).allocPoint;
                    uint256 lo = (cur * 3 + 3) / 4;
                    uint256 hi = (cur * 5) / 4;
                    a[j] = uint32(lo + (seed >> (30 + 20 * j)) % (hi - lo + 1));
                }
                vm.startPrank(gov);
                m.queueAllocs(p, a);
                skip(7 days);
                try m.executeAllocs(p, a) {} catch {}
                vm.stopPrank();
            } else if (op == 6) {
                vm.prank(gov);
                try m.recover(gov) {} catch {}
            }
            m.massUpdatePools();
            assertGe(pool.farmTreasury(address(m)), m.outstandingReward(), "insolvent");
        }
        assertLe(harvested, funded);
        m.massUpdatePools();
        for (uint256 k; k < 4; ++k) {
            if (live[k]) {
                uint256 p = m.pending(rec[k]);
                if (p > 0) pool.harvest(m, rec[k], sh[k], p); // must never revert for want of funds
            }
        }
    }
}
