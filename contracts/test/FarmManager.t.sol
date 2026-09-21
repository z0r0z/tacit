// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {FarmManager} from "../src/FarmManager.sol";
import {CdpLeg} from "../src/ConfidentialPool.sol";

contract RewardToken is ERC20 {
    function name() public pure override returns (string memory) { return "wTAC"; }
    function symbol() public pure override returns (string memory) { return "wTAC"; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

interface IOutstanding { function outstandingReward() external view returns (uint256); }

/// A pool stand-in with the real pool's farm semantics: funding credits a per-controller treasury in value units (amount / scale),
/// harvest debits it BEFORE the hook runs (failing closed), recover releases treasury minus the controller's outstandingReward().
contract MockFarmPool {
    RewardToken public token;
    bytes32 public rewardAsset;
    uint256 public constant SCALE = 1e10;
    bool public poolMintedFlag;
    mapping(address => uint256) public farmTreasury;
    uint256 public totalPaid; // value units harvested
    uint256 public totalFunded; // value units funded

    error InsufficientEscrow();

    constructor(RewardToken t, bytes32 asset) { token = t; rewardAsset = asset; }
    function setPoolMinted(bool v) external { poolMintedFlag = v; }

    function assets(bytes32) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (true, address(token), SCALE, bytes32(0), poolMintedFlag, 18);
    }

    function farmEscrow(address controller, bytes32, uint256 amount, address to) external returns (uint256 out) {
        if (amount == 0) {
            uint256 reserve = IOutstanding(msg.sender).outstandingReward();
            out = farmTreasury[msg.sender];
            out = out > reserve ? out - reserve : 0;
            farmTreasury[msg.sender] -= out;
            token.transfer(to, out * SCALE);
        } else {
            token.transferFrom(msg.sender, address(this), amount);
            out = amount / SCALE;
            farmTreasury[controller] += out;
            totalFunded += out;
        }
    }

    function bond(FarmManager m, bytes32 receipt, bytes32 stakeAsset, uint256 shares) external {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: stakeAsset, value: shares});
        m.onCdpMint(legs, 0, bytes32(uint256(1)), uint256(receipt));
    }

    function harvest(FarmManager m, bytes32 receipt, uint256 shares, uint256 reward) external {
        if (farmTreasury[address(m)] < reward) revert InsufficientEscrow();
        farmTreasury[address(m)] -= reward;
        totalPaid += reward;
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: rewardAsset, value: shares});
        m.onCdpMint(legs, reward, bytes32(uint256(1)), uint256(receipt));
    }

    function unbond(FarmManager m, bytes32 receipt, bytes32 stakeAsset, uint256 shares) external {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: stakeAsset, value: shares});
        m.onCdpClose(0, 0, uint256(receipt), legs, bytes32(0));
    }

    function callBare(FarmManager m, bytes32 leaf) external {
        CdpLeg[] memory legs = new CdpLeg[](0);
        m.onCdpMint(legs, 0, leaf, 1);
    }
}

contract FarmManagerTest is Test {
    RewardToken tok;
    MockFarmPool pool;
    FarmManager m;
    address gov = address(0x60A);
    address other = address(0xBAD);
    bytes32 constant REWARD = keccak256("wTAC-asset");
    bytes32 constant LP_A = keccak256("lpA");
    bytes32 constant LP_B = keccak256("lpB");
    bytes32 constant LP_C = keccak256("lpC");
    uint256 constant BUDGET = 1_000_000e8; // value units
    uint256 constant DURATION = 90 days;

    function _init(uint32 a, uint32 b, uint32 c, uint64 lockA) internal {
        tok = new RewardToken();
        pool = new MockFarmPool(tok, REWARD);
        bytes32[] memory s = new bytes32[](3); s[0] = LP_A; s[1] = LP_B; s[2] = LP_C;
        uint32[] memory al = new uint32[](3); al[0] = a; al[1] = b; al[2] = c;
        uint64[] memory lk = new uint64[](3); lk[0] = lockA; lk[1] = 0; lk[2] = 0;
        m = new FarmManager(address(pool), REWARD, gov, s, al, lk);
    }

    function setUp() public {
        _init(50, 30, 20, 0);
        tok.mint(gov, BUDGET * pool.SCALE());
        vm.startPrank(gov);
        tok.approve(address(m), type(uint256).max);
        m.fundAndNotify(BUDGET * pool.SCALE(), DURATION);
        vm.stopPrank();
    }

    function test_constructorSetsTheProgram() public view {
        assertEq(m.poolLength(), 3);
        assertEq(m.totalAllocPoint(), 100);
        assertEq(m.gov(), gov);
        assertEq(m.REWARD_TOKEN(), address(tok));
        assertEq(m.UNIT_SCALE(), 1e10);
        assertEq(m.rate(), BUDGET / DURATION);
        assertEq(m.periodFinish(), block.timestamp + DURATION);
    }

    function test_weightsSplitTheStreamAndHarvestsAreExact() public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        pool.bond(m, bytes32(uint256(12)), LP_B, 1000);
        pool.bond(m, bytes32(uint256(13)), LP_C, 1000);
        vm.warp(block.timestamp + 30 days);
        uint256 total = (BUDGET / DURATION) * 30 days;
        uint256 pa = m.pending(bytes32(uint256(11))); uint256 pb = m.pending(bytes32(uint256(12))); uint256 pc = m.pending(bytes32(uint256(13)));
        assertApproxEqAbs(pa, total * 50 / 100, 2);
        assertApproxEqAbs(pb, total * 30 / 100, 2);
        assertApproxEqAbs(pc, total * 20 / 100, 2);
        pool.harvest(m, bytes32(uint256(11)), 1000, pa);
        assertEq(m.pending(bytes32(uint256(11))), 0);
    }

    function test_cannotOverclaimOrReplay() public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        vm.warp(block.timestamp + 10 days);
        uint256 p = m.pending(bytes32(uint256(11)));
        vm.expectRevert(FarmManager.OverClaim.selector);
        pool.harvest(m, bytes32(uint256(11)), 1000, p + 1);
        pool.harvest(m, bytes32(uint256(11)), 1000, p);
        vm.expectRevert(FarmManager.OverClaim.selector);
        pool.harvest(m, bytes32(uint256(11)), 1000, 1); // the same window cannot be claimed twice
    }

    function test_aPoolWithNoStakersAccruesNothingAndItsShareIsRecoverable() public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000); // only pool A is staked
        vm.warp(block.timestamp + DURATION + 8 days);
        uint256 earned = m.pending(bytes32(uint256(11)));
        assertApproxEqAbs(earned, (BUDGET / DURATION) * DURATION * 50 / 100, 4);
        vm.prank(gov);
        uint256 released = m.recover(gov);
        assertApproxEqAbs(released + earned, BUDGET, 8); // the whole funded budget: what stakers earned plus everything else, incl. the rate's rounding remainder
        pool.harvest(m, bytes32(uint256(11)), 1000, earned); // the staker can still harvest after recover
    }

    function _one(uint256 pid, uint32 a) internal pure returns (uint256[] memory pids, uint32[] memory al) {
        pids = new uint256[](1); pids[0] = pid;
        al = new uint32[](1); al[0] = a;
    }

    function test_reweightingIsTimelockedBoundedAndDoesNotTouchEarnedReward() public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        vm.warp(block.timestamp + 10 days);
        uint256 before = m.pending(bytes32(uint256(11)));
        uint256[] memory pids = new uint256[](2); pids[0] = 0; pids[1] = 1;
        uint32[] memory al = new uint32[](2); al[0] = 40; al[1] = 37; // -20% and +23%: inside the ±25% band
        vm.startPrank(gov);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(pids, al);
        m.queueAllocs(pids, al);
        vm.expectRevert(FarmManager.NotReady.selector);
        m.executeAllocs(pids, al);
        vm.warp(block.timestamp + 7 days);
        m.executeAllocs(pids, al);
        vm.stopPrank();
        assertGe(m.pending(bytes32(uint256(11))), before); // earned reward only ever grows
        assertEq(m.poolInfo(0).allocPoint, 40);
        assertEq(m.totalAllocPoint(), 40 + 37 + 20);
    }

    function test_weightsCannotBeZeroedOrMovedMoreThanAQuarter() public {
        vm.startPrank(gov);
        (uint256[] memory pids, uint32[] memory al) = _one(0, 0);
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAllocs(pids, al); // zeroing
        (pids, al) = _one(0, 99);
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAllocs(pids, al); // 50 -> 99
        (pids, al) = _one(0, 37);
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAllocs(pids, al); // 50 -> 37 is -26%
        vm.stopPrank();
    }

    function test_aPoolCannotBeRepeatedToCompoundTheBand() public {
        uint256[] memory pids = new uint256[](3); pids[0] = 0; pids[1] = 0; pids[2] = 0;
        uint32[] memory al = new uint32[](3); al[0] = 62; al[1] = 77; al[2] = 96;
        vm.startPrank(gov);
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        m.queueAllocs(pids, al);
        pids[1] = 1; pids[2] = 2; pids[0] = 2; // not strictly increasing either
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        m.queueAllocs(pids, al);
        vm.stopPrank();
    }

    function test_configChangesAreRateLimited() public {
        (uint256[] memory pids, uint32[] memory al) = _one(0, 55);
        vm.startPrank(gov);
        m.queueAllocs(pids, al);
        skip(7 days);
        m.executeAllocs(pids, al);
        (pids, al) = _one(0, 60);
        m.queueAllocs(pids, al);
        skip(7 days);
        vm.expectRevert(FarmManager.Cooldown.selector);
        m.executeAllocs(pids, al); // 7 days after the last change, cooldown is 30
        skip(23 days);
        vm.expectRevert(FarmManager.Expired.selector);
        m.executeAllocs(pids, al); // and a stale queue entry expires rather than lingering
        m.queueAllocs(pids, al);
        skip(7 days);
        m.executeAllocs(pids, al);
        vm.stopPrank();
    }

    function test_aQueuedChangeExpiresAndCannotBeReplayedOrChanged() public {
        (uint256[] memory pids, uint32[] memory al) = _one(0, 55);
        (, uint32[] memory other2) = _one(0, 56);
        vm.startPrank(gov);
        m.queueAllocs(pids, al);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(pids, other2); // different args than were queued
        m.executeAllocs(pids, al);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(pids, al); // consumed: no replay
        vm.warp(block.timestamp + 30 days);
        m.queueAllocs(pids, al);
        vm.warp(block.timestamp + 7 days + 14 days + 1);
        vm.expectRevert(FarmManager.Expired.selector);
        m.executeAllocs(pids, al);
        vm.stopPrank();
    }

    function test_addingAPoolIsTimelockedAndCapped() public {
        bytes32 lpD = keccak256("lpD");
        vm.startPrank(gov);
        m.queueAddPool(lpD, 10, 0);
        vm.expectRevert(FarmManager.NotReady.selector);
        m.executeAddPool(lpD, 10, 0);
        vm.warp(block.timestamp + 7 days);
        m.executeAddPool(lpD, 10, 0);
        assertEq(m.poolLength(), 4);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAddPool(lpD, 10, 0);
        vm.stopPrank();
        vm.prank(other);
        vm.expectRevert(FarmManager.NotGov.selector);
        m.queueAddPool(keccak256("x"), 1, 0);
    }

    function test_aNewPoolMayNotTakeMoreThanATenthOfTheStream() public {
        bytes32 lpD = keccak256("lpD");
        vm.startPrank(gov);
        m.queueAddPool(lpD, 12, 0); // 12 / 112 > 10%
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAddPool(lpD, 12, 0);
        m.queueAddPool(lpD, 0, 0);
        skip(7 days);
        vm.expectRevert(FarmManager.BadAlloc.selector);
        m.executeAddPool(lpD, 0, 0);
        vm.stopPrank();
    }

    function test_theOutgoingGovernorsQueueDiesAtHandover() public {
        (uint256[] memory pids, uint32[] memory al) = _one(0, 55);
        vm.prank(gov);
        m.queueAllocs(pids, al);
        vm.prank(gov);
        m.proposeGov(other);
        vm.prank(other);
        m.acceptGov();
        vm.warp(block.timestamp + 7 days);
        vm.prank(other);
        vm.expectRevert(FarmManager.NotQueued.selector);
        m.executeAllocs(pids, al);
    }

    function test_runningScheduleEndNeverMovesEarlierAndDurationHasAFloor() public {
        vm.warp(block.timestamp + 10 days);
        tok.mint(gov, 1000e8 * 1e10);
        vm.startPrank(gov);
        vm.expectRevert(FarmManager.DurationTooShort.selector);
        m.notifyRewardAmount(0, 1); // one second is below the minimum duration
        uint256 remaining = m.periodFinish() - block.timestamp;
        vm.expectRevert(FarmManager.EndMovesEarlier.selector);
        m.fundAndNotify(1000e8 * 1e10, remaining - 1 days); // any earlier end is refused
        m.fundAndNotify(1000e8 * 1e10, remaining); // the same end is fine
        vm.stopPrank();
    }

    function test_aStrayDonationCannotBlockFunding() public {
        tok.mint(address(m), 1);
        tok.mint(gov, 100e8 * 1e10);
        vm.prank(gov);
        m.fundAndNotify(100e8 * 1e10, 90 days);
        tok.mint(other, 100e8 * 1e10);
        vm.startPrank(other);
        tok.approve(address(m), type(uint256).max);
        m.fund(100e8 * 1e10);
        vm.stopPrank();
    }

    function test_rateCanBeRaisedButNeverLoweredMidProgram() public {
        vm.warp(block.timestamp + 10 days);
        uint256 oldRate = m.rate();
        tok.mint(gov, 1000e8 * 1e10);
        vm.startPrank(gov);
        // a tiny top-up stretched over a long duration would LOWER the rate: refused
        vm.expectRevert(FarmManager.RateDecrease.selector);
        m.fundAndNotify(1e8 * 1e10, 365 days);
        // the same top-up over the remaining time keeps/raises it
        uint256 remaining = m.periodFinish() - block.timestamp;
        m.fundAndNotify(1000e8 * 1e10, remaining);
        vm.stopPrank();
        assertGt(m.rate(), oldRate);
    }

    function test_durationCappedAndZeroRefused() public {
        vm.warp(block.timestamp + DURATION + 1);
        tok.mint(gov, 100e8 * 1e10);
        vm.startPrank(gov);
        vm.expectRevert(FarmManager.DurationTooLong.selector);
        m.fundAndNotify(100e8 * 1e10, 365 days + 1);
        vm.expectRevert(FarmManager.ZeroDuration.selector);
        m.notifyRewardAmount(1, 0);
        vm.stopPrank();
    }

    function test_unfundedRateIsRefused() public {
        vm.warp(block.timestamp + DURATION + 1);
        vm.startPrank(gov);
        m.notifyRewardAmount(BUDGET / 2, 30 days); // unspent budget legitimately backs a new program
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(FarmManager.UnfundedRate.selector);
        m.notifyRewardAmount(2 * BUDGET, 30 days); // but asking for more than the treasury holds is refused
        vm.stopPrank();
    }

    function test_perPositionLockIsRecordedAtBond() public {
        _init(50, 30, 20, 30 days);
        tok.mint(gov, BUDGET * pool.SCALE());
        vm.startPrank(gov);
        tok.approve(address(m), type(uint256).max);
        m.fundAndNotify(BUDGET * pool.SCALE(), DURATION);
        vm.stopPrank();
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        vm.warp(block.timestamp + 29 days);
        vm.expectRevert(FarmManager.Locked.selector);
        pool.unbond(m, bytes32(uint256(11)), LP_A, 1000);
        vm.warp(block.timestamp + 1 days);
        pool.unbond(m, bytes32(uint256(11)), LP_A, 1000);
        (,,, , bool live) = m.positions(bytes32(uint256(11)));
        assertFalse(live);
    }

    function test_recoverNeedsTheGraceAndKeepsWhatIsEarned() public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        pool.bond(m, bytes32(uint256(12)), LP_B, 1000);
        pool.bond(m, bytes32(uint256(13)), LP_C, 1000);
        vm.warp(block.timestamp + DURATION);
        vm.prank(gov);
        vm.expectRevert(FarmManager.TooEarly.selector);
        m.recover(gov);
        vm.warp(block.timestamp + 7 days + 1);
        uint256 e = m.pending(bytes32(uint256(11))) + m.pending(bytes32(uint256(12))) + m.pending(bytes32(uint256(13)));
        vm.prank(gov);
        uint256 released = m.recover(gov);
        assertLe(released, BUDGET - e + 8); // never releases what stakers earned
        pool.harvest(m, bytes32(uint256(11)), 1000, m.pending(bytes32(uint256(11))));
        pool.harvest(m, bytes32(uint256(12)), 1000, m.pending(bytes32(uint256(12))));
        pool.harvest(m, bytes32(uint256(13)), 1000, m.pending(bytes32(uint256(13))));
    }

    function test_fullExitThenRecoverReturnsTheWholeUnpaidBudget() public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        vm.warp(block.timestamp + 20 days);
        pool.unbond(m, bytes32(uint256(11)), LP_A, 1000); // un-harvested tail forfeits to the surplus
        vm.warp(block.timestamp + DURATION + 8 days);
        vm.prank(gov);
        uint256 released = m.recover(gov);
        assertEq(released, pool.totalFunded() - pool.totalPaid());
        assertEq(m.outstandingReward(), 0);
    }

    function test_twoStepGovHandover() public {
        vm.prank(gov);
        m.proposeGov(other);
        vm.prank(address(0xCAFE));
        vm.expectRevert(FarmManager.NotGov.selector);
        m.acceptGov();
        vm.prank(other);
        m.acceptGov();
        assertEq(m.gov(), other);
        vm.prank(gov);
        vm.expectRevert(FarmManager.NotGov.selector);
        m.notifyRewardAmount(1, 7 days);
    }

    function test_onlyThePoolCanCallTheHooksAndUnsupportedOpsRevert() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: LP_A, value: 5});
        vm.expectRevert(FarmManager.NotPool.selector);
        m.onCdpMint(legs, 0, bytes32(uint256(1)), 1);
        vm.expectRevert(FarmManager.NotPool.selector);
        m.onCdpClose(0, 0, 1, legs, bytes32(0));
        vm.expectRevert(FarmManager.BarePayoutUnsupported.selector);
        pool.callBare(m, bytes32(0));
        vm.expectRevert(FarmManager.NotSupported.selector);
        pool.callBare(m, bytes32(uint256(2)));
    }

    function test_wrongStakeAssetAndDoubleBondRevert() public {
        vm.expectRevert(FarmManager.WrongStakeAsset.selector);
        pool.bond(m, bytes32(uint256(11)), keccak256("unknown"), 1000);
        pool.bond(m, bytes32(uint256(11)), LP_A, 1000);
        vm.expectRevert(FarmManager.PositionExists.selector);
        pool.bond(m, bytes32(uint256(11)), LP_B, 1000);
        vm.expectRevert(FarmManager.WrongStakeAsset.selector);
        pool.unbond(m, bytes32(uint256(11)), LP_B, 1000); // released asset must be the bonded pool's stake asset
    }

    function test_constructorRefusesBadRewardAssetsAndShapes() public {
        RewardToken t2 = new RewardToken();
        MockFarmPool p2 = new MockFarmPool(t2, REWARD);
        p2.setPoolMinted(true);
        bytes32[] memory s = new bytes32[](0); uint32[] memory a = new uint32[](0); uint64[] memory l = new uint64[](0);
        vm.expectRevert(FarmManager.BadRewardAsset.selector);
        new FarmManager(address(p2), REWARD, gov, s, a, l);
        p2.setPoolMinted(false);
        bytes32[] memory s1 = new bytes32[](1); s1[0] = REWARD;
        uint32[] memory a1 = new uint32[](1); a1[0] = 1; uint64[] memory l1 = new uint64[](1);
        vm.expectRevert(FarmManager.BadPool.selector); // the reward asset can never be a stake asset
        new FarmManager(address(p2), REWARD, gov, s1, a1, l1);
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        new FarmManager(address(p2), REWARD, gov, s1, new uint32[](2), l1);
    }

    function test_fundIsOpenToAnyoneAndOnlyAddsBudget() public {
        tok.mint(other, 5e8 * 1e10);
        vm.startPrank(other);
        tok.approve(address(m), type(uint256).max);
        uint256 before = pool.farmTreasury(address(m));
        m.fund(5e8 * 1e10);
        vm.stopPrank();
        assertEq(pool.farmTreasury(address(m)), before + 5e8);
        assertEq(m.rate(), BUDGET / DURATION); // the schedule did not move
        assertEq(tok.balanceOf(address(m)), 0);
    }

    /// Solvency under random play on one pool: the treasury always covers what stakers have earned, and total paid never exceeds
    /// total funded.
    function testFuzz_solvencyAndPaidNeverExceedFunded(uint32 t1, uint32 t2, uint32 t3, uint8 hp) public {
        pool.bond(m, bytes32(uint256(11)), LP_A, 1_000);
        vm.warp(block.timestamp + bound(t1, 1, 30 days));
        pool.bond(m, bytes32(uint256(12)), LP_A, 3_000);
        vm.warp(block.timestamp + bound(t2, 1, 30 days));
        m.massUpdatePools();
        assertGe(pool.farmTreasury(address(m)), m.outstandingReward());
        uint256 p = m.pending(bytes32(uint256(12)));
        if (hp % 2 == 0 && p > 0) pool.harvest(m, bytes32(uint256(12)), 3_000, p);
        vm.warp(block.timestamp + bound(t3, 1, 30 days));
        pool.unbond(m, bytes32(uint256(11)), LP_A, 1_000);
        m.massUpdatePools();
        assertGe(pool.farmTreasury(address(m)), m.outstandingReward());
        assertLe(pool.totalPaid(), pool.totalFunded());
    }
}
