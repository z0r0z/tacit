// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CdpLeg} from "../src/ConfidentialPool.sol";
import {FarmController} from "../src/FarmController.sol";

/// The test plays the pool (POOL = address(this)) + the guest (it supplies the receipt's revealed
/// `(shares, rps_entry)` as the two harvest leg values) + the farm-treasury seam (fundFarm/recoverFarm stubs).
/// It exercises the fair harvest riding the existing `onCdpMint` call (positionLeaf sentinel 1 = harvest), the
/// rps fairness bound, the Synthetix notify/period-clamp, and the escrow recover gating — ops/PLAN-evm-farm-rewards.md.
contract FarmControllerTest is Test {
    FarmController farm;
    bytes32 constant HARVEST = bytes32(uint256(1));
    bytes32 constant STAKE = keccak256("LP");
    bytes32 constant REWARD = keccak256("REWARD");
    uint256 constant YR = 365 days;

    // ── farm-treasury recover seam stub (the pool's job in Phase 2; funding is the funder's direct pool call) ──
    uint256 public stubTreasury;

    function farmEscrow(address, bytes32, uint256, address) external returns (uint256 out) {
        out = stubTreasury;
        stubTreasury = 0;
    }

    function setUp() public {
        // MINT-mode farm (no treasury); rate = 100 units/sec over a long window so the existing accrual tests
        // are unaffected by the period clamp. rate = (100·YR)/YR = 100.
        farm = new FarmController(address(this), STAKE, REWARD, false, false, address(this), 0);
        farm.notifyRewardAmount(100 * YR, YR);
    }

    function _bond(uint256 shares, bytes32 leaf) internal {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, shares);
        farm.onCdpMint(legs, 0, leaf);
    }

    function _harvest(uint256 shares, uint256 rpsEntry, uint256 reward) internal {
        CdpLeg[] memory legs = new CdpLeg[](2);
        legs[0] = CdpLeg(REWARD, shares);
        legs[1] = CdpLeg(bytes32(0), rpsEntry);
        farm.onCdpMint(legs, reward, HARVEST);
    }

    // A receipt bond rides the SAME sentinel (positionLeaf == 1) with debtValue == 0; the guest appends the
    // receipt note committing (shares, rps_entry), and the controller binds rps_entry == the live rps.
    function _receiptBond(uint256 shares, uint256 rpsEntry) internal {
        CdpLeg[] memory legs = new CdpLeg[](2);
        legs[0] = CdpLeg(STAKE, shares);
        legs[1] = CdpLeg(bytes32(0), rpsEntry);
        farm.onCdpMint(legs, 0, HARVEST); // debtValue == 0 ⇒ BOND
    }

    /// The receipt bond binds rps_entry to the live rps (no backdating), and harvest keeps the principal staked.
    function test_receipt_bond_binds_entry_and_harvest_keeps_stake() public {
        _receiptBond(100, 0); // first bond: rps == 0, so entry must be 0
        assertEq(farm.totalShares(), 100);
        vm.expectRevert(FarmController.EntryNotLive.selector);
        _receiptBond(50, 999); // a backdated/forged entry is rejected

        skip(10); // sole staker accrues; rps advances
        uint256 live = farm.currentRps();
        assertGt(live, 0, "rps advanced");
        vm.expectRevert(FarmController.EntryNotLive.selector);
        _receiptBond(50, 0); // a stale entry is rejected
        _receiptBond(50, live); // the live entry is accepted
        assertEq(farm.totalShares(), 150);

        // harvest does NOT touch totalShares — the principal stays staked (bond once, harvest many)
        _harvest(100, 0, 100); // alice's 100-share receipt, some reward ≤ accrual
        assertEq(farm.totalShares(), 150, "principal still staked after harvest");
    }

    function test_bond_tracks_weight() public {
        _bond(100, keccak256("p1"));
        assertEq(farm.totalShares(), 100);
        _bond(50, keccak256("p2"));
        assertEq(farm.totalShares(), 150);
    }

    /// Harvest rides onCdpMint(leaf == 1); the reward is bounded to the real accrual.
    function test_harvest_caps_to_accrual() public {
        _bond(100, keccak256("p1"));
        skip(10); // sole staker accrues 100*10 = 1000
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(100, 0, 1001);
        _harvest(100, 0, 1000); // exactly the accrual
    }

    /// Two stakers split the emission proportionally.
    function test_proportional() public {
        _bond(100, keccak256("p1"));
        _bond(300, keccak256("p2")); // totalShares 400
        skip(10); // pool emits 1000
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(100, 0, 251); // alice = 100/400 = 250
        _harvest(100, 0, 250);
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(300, 0, 751); // bob = 300/400 = 750
        _harvest(300, 0, 750);
    }

    function test_bare_payout_unsupported() public {
        CdpLeg[] memory none = new CdpLeg[](0);
        vm.expectRevert(FarmController.BarePayoutUnsupported.selector);
        farm.onCdpMint(none, 100, bytes32(0));
    }

    function test_harvest_requires_pinned_reward_asset() public {
        _receiptBond(100, 0);
        skip(10);
        CdpLeg[] memory legs = new CdpLeg[](2);
        legs[0] = CdpLeg(keccak256("WRONG"), 100);
        legs[1] = CdpLeg(bytes32(0), 0);
        vm.expectRevert(FarmController.WrongRewardAsset.selector);
        farm.onCdpMint(legs, 100, HARVEST);
    }

    function test_bare_bond_cannot_mint_debt() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        farm.onCdpMint(legs, 1, keccak256("bare-position"));
    }

    function test_bond_and_unbond_require_pinned_stake_asset() public {
        CdpLeg[] memory receipt = new CdpLeg[](2);
        receipt[0] = CdpLeg(keccak256("WRONG-LP"), 100);
        receipt[1] = CdpLeg(bytes32(0), 0);
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        farm.onCdpMint(receipt, 0, HARVEST);

        CdpLeg[] memory bare = new CdpLeg[](1);
        bare[0] = CdpLeg(keccak256("WRONG-LP"), 100);
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        farm.onCdpMint(bare, 0, keccak256("bare-position"));

        _bond(100, keccak256("p1"));
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        farm.onCdpClose(0, bare, keccak256("n1"));
    }

    function test_unbond_enforces_lockup() public {
        FarmController lockedFarm =
            new FarmController(address(this), STAKE, REWARD, false, false, address(this), block.timestamp + 7 days);
        CdpLeg[] memory bondLegs = new CdpLeg[](1);
        bondLegs[0] = CdpLeg(STAKE, 100);
        lockedFarm.onCdpMint(bondLegs, 0, keccak256("p1"));

        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.Locked.selector);
        lockedFarm.onCdpClose(0, legs, keccak256("n1"));
        skip(7 days);
        lockedFarm.onCdpClose(0, legs, keccak256("n1"));
        assertEq(lockedFarm.totalShares(), 0);
    }

    function test_lock_until_can_only_shorten_or_clear() public {
        uint256 initialLock = block.timestamp + 7 days;
        FarmController lockedFarm = new FarmController(address(this), STAKE, REWARD, false, false, address(this), initialLock);

        vm.expectRevert(FarmController.LockExtensionForbidden.selector);
        lockedFarm.setLockUntil(initialLock + 1);

        lockedFarm.setLockUntil(block.timestamp + 1 days);
        assertEq(lockedFarm.lockUntil(), block.timestamp + 1 days);

        lockedFarm.setLockUntil(0);
        assertEq(lockedFarm.lockUntil(), 0);

        vm.prank(address(0xBEEF));
        vm.expectRevert(FarmController.NotGov.selector);
        lockedFarm.setLockUntil(0);
    }

    function test_unbond_rejects_debt_or_excess_weight() public {
        _bond(100, keccak256("p1"));
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        farm.onCdpClose(1, legs, keccak256("n1"));

        legs[0] = CdpLeg(STAKE, 101);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        farm.onCdpClose(0, legs, keccak256("n2"));
    }

    function test_liquidate_and_topup_unsupported() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 1);
        vm.expectRevert(FarmController.NotSupported.selector);
        farm.onCdpLiquidate(legs, 0, keccak256("n1"));
        vm.expectRevert(FarmController.NotSupported.selector);
        farm.onCdpTopup(legs, legs, 0, keccak256("n1"), keccak256("p2"));
    }

    function test_only_pool() public {
        FarmController other = new FarmController(address(0xBEEF), STAKE, REWARD, false, false, address(this), 0);
        vm.expectRevert(FarmController.NotPool.selector);
        other.onCdpClose(0, new CdpLeg[](0), keccak256("n1"));
    }

    // ── v2: Synthetix notify + period clamp + recover ──

    /// notify rolls the unspent remaining emission into the new rate (Synthetix), and extends the period.
    function test_notify_rolls_rate() public {
        FarmController f = new FarmController(address(this), STAKE, REWARD, false, false, address(this), 0);
        f.notifyRewardAmount(1000, 100); // rate = 10, periodFinish = t0 + 100
        assertEq(f.rate(), 10, "first rate");
        skip(50); // 50s elapsed; 50*10 = 500 remaining
        f.notifyRewardAmount(1000, 100); // leftover 500 rolls in → (1000+500)/100 = 15
        assertEq(f.rate(), 15, "rolled rate");
        assertEq(f.periodFinish(), block.timestamp + 100, "period extended");
    }

    /// Accrual is clamped to periodFinish — no emission past the funded window.
    function test_period_clamp() public {
        FarmController f = new FarmController(address(this), STAKE, REWARD, false, false, address(this), 0);
        f.notifyRewardAmount(100, 10); // rate = 10, periodFinish = t0 + 10
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        f.onCdpMint(legs, 0, keccak256("p1")); // bond 100 at t0
        skip(20); // 20s, but the window closed at t0 + 10
        // accrual capped at 10s: rps = 10·10·PRECISION/100 = PRECISION (NOT 2·PRECISION)
        assertEq(f.currentRps(), f.PRECISION(), "accrual clamped to periodFinish");
    }

    /// recover: MINT mode has no escrow → unsupported; ESCROW mode is gated to creator + post period+grace.
    function test_recover_gating() public {
        // MINT mode: no treasury to refund
        vm.expectRevert(FarmController.NotSupported.selector);
        farm.recover(address(this));

        // ESCROW mode: the funder funds the treasury directly via pool.fundFarm (here: seed the stub); notify
        // only sets the rate. recover is gated to creator + post period+grace.
        FarmController esc = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        esc.notifyRewardAmount(1000, 100); // sets rate; funding is separate (pool.fundFarm)
        stubTreasury = 1000;
        vm.expectRevert(FarmController.TooEarly.selector);
        esc.recover(address(this)); // before periodFinish + grace
        skip(100 + 7 days + 1); // past periodFinish + RECOVER_GRACE
        uint256 released = esc.recover(address(this));
        assertEq(released, 1000, "leftover reclaimed");
        assertEq(stubTreasury, 0, "treasury drained on recover");
    }

    function test_notify_only_gov() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(FarmController.NotGov.selector);
        farm.notifyRewardAmount(100, 10);
    }

    /// A reward farm (RECEIPT_MODE) rejects bare position locks (positionLeaf > 1) — they would inflate
    /// totalShares and dilute receipt holders' rps without ever harvesting. Receipt ops still work.
    function test_receipt_mode_rejects_bare_bond() public {
        FarmController rf = new FarmController(address(this), STAKE, REWARD, false, true, address(this), 0);
        CdpLeg[] memory bare = new CdpLeg[](1);
        bare[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.NotSupported.selector);
        rf.onCdpMint(bare, 0, keccak256("bare-position")); // leaf > 1 rejected in receipt mode

        CdpLeg[] memory receipt = new CdpLeg[](2);
        receipt[0] = CdpLeg(STAKE, 100);
        receipt[1] = CdpLeg(bytes32(0), 0);
        rf.onCdpMint(receipt, 0, HARVEST); // receipt bond (leaf == 1) still accepted
        assertEq(rf.totalShares(), 100, "receipt bond tracked");
    }

    /// notify rejects a rate that would overflow accrual (and thereby lock principal by reverting unbond).
    function test_notify_rejects_overflowing_rate() public {
        vm.expectRevert(FarmController.RateTooHigh.selector);
        farm.notifyRewardAmount(type(uint256).max / 2, 1);
    }
}
