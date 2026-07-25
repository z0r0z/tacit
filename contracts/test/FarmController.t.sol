// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CdpLeg} from "../src/ConfidentialPool.sol";
import {FarmController} from "../src/FarmController.sol";

/// The test plays the pool (POOL = address(this)) + the guest (it supplies `shares` as the single leg value
/// and the receipt leaf via `rateSnapshot`) + the farm-treasury seam (`farmEscrow` stub). It exercises the
/// EXECUTION-STAMPED entry (SPEC-masterchef-farm-stake-anytime): a mid-campaign join at an arbitrary live
/// rps, per-position fairness across stakers that joined at different rps, replayed harvests paying 0, the
/// exact `totalRewardDebt` reserve invariant, the Synthetix notify/period-clamp, and escrow recover gating.
contract FarmControllerTest is Test {
    FarmController farm;  // receiptMode = true — the V1 reward-farm config (DeployV1Suite/SeedV1Pools)
    FarmController vault; // receiptMode = false — a plain position-lock vault (bare bonds, no receipt rewards)
    bytes32 constant HARVEST = bytes32(uint256(1));
    bytes32 constant STAKE = keccak256("LP");
    bytes32 constant REWARD = keccak256("REWARD");
    uint256 constant YR = 365 days;

    // ── farm-treasury recover seam stub (the pool's job in Phase 2; funding is the funder's direct pool call) ──
    uint256 public stubTreasury;
    // The pool view the controller reads to refuse an unbacked rate; default high so accrual/recover tests
    // (which don't exercise the L-02 preflight) notify freely. `test_notify_rejects_unbacked_rate` drives it.
    uint256 public stubBacking = type(uint256).max;

    function farmEscrow(address, bytes32, uint256, address) external returns (uint256 out) {
        out = stubTreasury;
        stubTreasury = 0;
    }

    function farmTreasury(address) external view returns (uint256) {
        return stubBacking;
    }

    function setUp() public {
        // ESCROW-mode farm; rate = 100 units/sec over a long window so the existing accrual tests
        // are unaffected by the period clamp. rate = (100·YR)/YR = 100.
        farm = new FarmController(address(this), STAKE, REWARD, true, true, address(this), 0);
        farm.notifyRewardAmount(100 * YR, YR);
        // A plain-vault controller (receiptMode = false) for the bare-bond tests — the inverse of `farm`.
        vault = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        vault.notifyRewardAmount(100 * YR, YR);
    }

    function test_notify_rejects_unbacked_rate() public {
        // ESCROW farm: a rate whose full emission (rate·duration) exceeds the pool treasury is refused, so
        // stakers never bond against a campaign whose harvests would later fail closed.
        FarmController esc = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        stubBacking = 999; // rate = 1000/100 = 10, 10·100 = 1000 > 999
        vm.expectRevert(FarmController.UnfundedRate.selector);
        esc.notifyRewardAmount(1000, 100);
        stubBacking = 1000; // exactly backed now
        esc.notifyRewardAmount(1000, 100);
    }

    function _newMintFarm() internal returns (FarmController) {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 debtReward = keccak256(abi.encodePacked("tacit-cdp-debt-v1", next));
        return new FarmController(address(this), STAKE, debtReward, false, false, address(this), 0);
    }

    function test_constructor_rejects_bad_config() public {
        vm.expectRevert(FarmController.ZeroAddress.selector);
        new FarmController(address(0), STAKE, REWARD, false, false, address(this), 0);

        vm.expectRevert(FarmController.ZeroAddress.selector);
        new FarmController(address(this), STAKE, REWARD, false, false, address(0), 0);

        vm.expectRevert(FarmController.BadFarmShape.selector);
        new FarmController(address(this), bytes32(0), REWARD, false, false, address(this), 0);

        vm.expectRevert(FarmController.BadFarmShape.selector);
        new FarmController(address(this), STAKE, bytes32(0), false, false, address(this), 0);
    }

    // Bare bond (real position leaf, no receipt) — only a plain vault (receiptMode = false) accepts it.
    function _bond(uint256 shares, bytes32 leaf) internal {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, shares);
        vault.onCdpMint(legs, 0, leaf, 0);
    }

    // Harvest against position `receipt`. `shares` rides the single leg; the receipt leaf rides rateSnapshot.
    function _harvest(bytes32 receipt, uint256 shares, uint256 reward) internal {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(REWARD, shares);
        farm.onCdpMint(legs, reward, HARVEST, uint256(receipt));
    }

    // A receipt bond rides the SAME sentinel (positionLeaf == 1) with debtValue == 0; the guest appends the
    // receipt note (the stable position id) and passes it here, and the controller STAMPS the live rps onto it.
    function _receiptBond(bytes32 receipt, uint256 shares) internal {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, shares);
        farm.onCdpMint(legs, 0, HARVEST, uint256(receipt)); // debtValue == 0 ⇒ BOND
    }

    function _receiptUnbond(bytes32 receipt, uint256 shares) internal {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, shares);
        farm.onCdpClose(0, 0, uint256(receipt), legs, keccak256(abi.encode(receipt)));
    }

    /// THE POINT OF THE SPEC: a bond lands at an ARBITRARY live rps mid-campaign. The old exact-equality bind
    /// made this unbuildable — `rps` moves every second, so a minutes-long bond proof always arrived stale.
    function test_bond_succeeds_mid_campaign_at_arbitrary_live_rps() public {
        _receiptBond(keccak256("alice"), 100);
        skip(10); // sole staker accrues; rps advances to a value no proof could have predicted
        uint256 live = farm.currentRps();
        assertGt(live, 0, "rps advanced mid-campaign");

        _receiptBond(keccak256("bob"), 50); // no checkpoint argument at all — the controller stamps it
        assertEq(farm.entryRps(keccak256("bob")), live, "bob's entry stamped at the live rps");
        assertTrue(farm.entryStamped(keccak256("bob")));
        assertEq(farm.totalShares(), 150);

        // bob cannot claim any of the pre-join emission
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("bob"), 50, 1);

        // harvest does NOT touch totalShares — the principal stays staked (bond once, harvest many)
        _harvest(keccak256("alice"), 100, 100);
        assertEq(farm.totalShares(), 150, "principal still staked after harvest");
    }

    /// Two stakers joining at DIFFERENT rps each harvest exactly their own entitlement, never each other's.
    function test_stakers_joining_at_different_rps_each_get_exact_entitlement() public {
        _receiptBond(keccak256("alice"), 100); // t0, rps 0
        skip(10); // alice alone: emits 1000, all hers
        _receiptBond(keccak256("bob"), 100); // joins at rps = 10·PRECISION
        skip(10); // 1000 more, split 50/50 over 200 shares

        // alice: 1000 (solo window) + 500 (shared window) = 1500
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("alice"), 100, 1501);
        _harvest(keccak256("alice"), 100, 1500);

        // bob: only the shared window = 500
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("bob"), 100, 501);
        _harvest(keccak256("bob"), 100, 500);

        // everything emitted is now paid out; nothing stays reserved
        assertEq(farm.outstandingReward(), 0, "all entitlements settled");
    }

    /// A replayed harvest pays 0: the re-stamp moved the entry to the live rps, so the window is empty.
    function test_replayed_harvest_pays_zero() public {
        _receiptBond(keccak256("alice"), 100);
        skip(10);
        _harvest(keccak256("alice"), 100, 1000);
        assertEq(farm.entryRps(keccak256("alice")), farm.rps(), "re-stamped to live rps");
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("alice"), 100, 1); // replay claims nothing
        skip(10);
        _harvest(keccak256("alice"), 100, 1000); // but the NEXT window accrues normally
    }

    /// A position id is bonded once, and harvest/unbond require a live stamp.
    function test_position_lifecycle_gates() public {
        vm.expectRevert(FarmController.NoLivePosition.selector);
        _harvest(keccak256("ghost"), 100, 1); // never bonded

        _receiptBond(keccak256("alice"), 100);
        vm.expectRevert(FarmController.PositionExists.selector);
        _receiptBond(keccak256("alice"), 100); // re-bonding would burn the live position's accrual

        _receiptUnbond(keccak256("alice"), 100);
        assertFalse(farm.entryStamped(keccak256("alice")), "unbond clears the stamp");
        vm.expectRevert(FarmController.NoLivePosition.selector);
        _harvest(keccak256("alice"), 100, 1); // closed positions can't harvest
        vm.expectRevert(FarmController.NoLivePosition.selector);
        _receiptUnbond(keccak256("alice"), 100); // nor unbond twice

        // A zero receipt leaf is not a position.
        vm.expectRevert(FarmController.BadFarmShape.selector);
        _receiptBond(bytes32(0), 100);
    }

    /// `outstandingReward()` is EXACTLY Σ shares_i·(rps − entry_i)/PRECISION — the reserve invariant `recover`
    /// and `notify` both depend on, and the reason the H-01 upper-bound accumulator could be deleted.
    function test_reward_debt_reserve_invariant() public {
        _receiptBond(keccak256("alice"), 100);
        skip(10);
        _receiptBond(keccak256("bob"), 300); // joins at a non-zero rps
        skip(10);

        // Any receipt op brings the stored `rps` current; measure the invariant against the post-call state.
        _harvest(keccak256("bob"), 300, 1);
        uint256 rps = farm.rps();
        uint256 expected = (100 * (rps - farm.entryRps(keccak256("alice")))
            + 300 * (rps - farm.entryRps(keccak256("bob")))) / farm.PRECISION();
        assertEq(farm.outstandingReward(), expected, "reserve == sum of live entitlements");
        assertEq(farm.entryRps(keccak256("bob")), rps, "bob's window is fully retired by his re-stamp");
    }

    function test_bond_tracks_weight() public {
        _bond(100, keccak256("p1"));
        assertEq(vault.totalShares(), 100);
        _bond(50, keccak256("p2"));
        assertEq(vault.totalShares(), 150);
    }

    /// Q-01: a plain vault (receiptMode == false) rejects receipt ops — bond/harvest belong to a reward farm.
    function test_plain_vault_rejects_receipt_ops() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.NotSupported.selector);
        vault.onCdpMint(legs, 0, HARVEST, uint256(keccak256("r"))); // receipt BOND on a plain vault
        legs[0] = CdpLeg(REWARD, 100);
        vm.expectRevert(FarmController.NotSupported.selector);
        vault.onCdpMint(legs, 50, HARVEST, uint256(keccak256("r"))); // receipt HARVEST on a plain vault
    }

    /// Harvest rides onCdpMint(leaf == 1); the reward is bounded to the real accrual.
    function test_harvest_caps_to_accrual() public {
        _receiptBond(keccak256("alice"), 100);
        skip(10); // sole staker accrues 100*10 = 1000
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("alice"), 100, 1001);
        _harvest(keccak256("alice"), 100, 1000); // exactly the accrual
    }

    /// Two stakers who joined together split the emission proportionally.
    function test_proportional() public {
        _receiptBond(keccak256("alice"), 100);
        _receiptBond(keccak256("bob"), 300); // totalShares 400
        skip(10); // pool emits 1000
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("alice"), 100, 251); // alice = 100/400 = 250
        _harvest(keccak256("alice"), 100, 250);
        vm.expectRevert(FarmController.OverClaim.selector);
        _harvest(keccak256("bob"), 300, 751); // bob = 300/400 = 750
        _harvest(keccak256("bob"), 300, 750);
    }

    function test_bare_payout_unsupported() public {
        CdpLeg[] memory none = new CdpLeg[](0);
        vm.expectRevert(FarmController.BarePayoutUnsupported.selector);
        farm.onCdpMint(none, 100, bytes32(0), 0);
    }

    function test_harvest_requires_pinned_reward_asset() public {
        _receiptBond(keccak256("alice"), 100);
        skip(10);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(keccak256("WRONG"), 100);
        vm.expectRevert(FarmController.WrongRewardAsset.selector);
        farm.onCdpMint(legs, 100, HARVEST, uint256(keccak256("alice")));
    }

    function test_bare_bond_cannot_mint_debt() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        vault.onCdpMint(legs, 1, keccak256("bare-position"), 0); // bare bond with debt → BadFarmShape (plain vault)
    }

    function test_bond_and_unbond_require_pinned_stake_asset() public {
        CdpLeg[] memory receipt = new CdpLeg[](1);
        receipt[0] = CdpLeg(keccak256("WRONG-LP"), 100);
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        farm.onCdpMint(receipt, 0, HARVEST, uint256(keccak256("alice")));

        CdpLeg[] memory bare = new CdpLeg[](1);
        bare[0] = CdpLeg(keccak256("WRONG-LP"), 100);
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        vault.onCdpMint(bare, 0, keccak256("bare-position"), 0); // bare bond is a plain-vault op

        _bond(100, keccak256("p1")); // bonds on `vault`
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        vault.onCdpClose(0, 0, 0, bare, keccak256("n1"));
    }

    function test_unbond_enforces_lockup() public {
        FarmController lockedFarm =
            new FarmController(address(this), STAKE, REWARD, true, false, address(this), block.timestamp + 7 days);
        CdpLeg[] memory bondLegs = new CdpLeg[](1);
        bondLegs[0] = CdpLeg(STAKE, 100);
        lockedFarm.onCdpMint(bondLegs, 0, keccak256("p1"), 0);

        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.Locked.selector);
        lockedFarm.onCdpClose(0, 0, 0, legs, keccak256("n1"));
        skip(7 days);
        lockedFarm.onCdpClose(0, 0, 0, legs, keccak256("n1"));
        assertEq(lockedFarm.totalShares(), 0);
    }

    function test_lock_until_can_only_shorten_or_clear() public {
        uint256 initialLock = block.timestamp + 7 days;
        FarmController lockedFarm =
            new FarmController(address(this), STAKE, REWARD, true, false, address(this), initialLock);

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
        _bond(100, keccak256("p1")); // bonds on `vault`
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        vault.onCdpClose(1, 0, 0, legs, keccak256("n1"));

        legs[0] = CdpLeg(STAKE, 101);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        vault.onCdpClose(0, 0, 0, legs, keccak256("n2"));
    }

    function test_liquidate_and_topup_unsupported() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 1);
        vm.expectRevert(FarmController.NotSupported.selector);
        farm.onCdpLiquidate(legs, 0, 0, 0, keccak256("n1"));
        vm.expectRevert(FarmController.NotSupported.selector);
        farm.onCdpTopup(legs, legs, 0, 0, keccak256("n1"), keccak256("p2"));
    }

    function test_only_pool() public {
        FarmController other = new FarmController(address(0xBEEF), STAKE, REWARD, true, false, address(this), 0);
        vm.expectRevert(FarmController.NotPool.selector);
        other.onCdpClose(0, 0, 0, new CdpLeg[](0), keccak256("n1"));
    }

    // ── v2: Synthetix notify + period clamp + recover ──

    /// notify rolls the unspent remaining emission into the new rate (Synthetix), and extends the period.
    function test_notify_rolls_rate() public {
        FarmController f = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        f.notifyRewardAmount(1000, 100); // rate = 10, periodFinish = t0 + 100
        assertEq(f.rate(), 10, "first rate");
        skip(50); // 50s elapsed; 50*10 = 500 remaining
        f.notifyRewardAmount(1000, 100); // leftover 500 rolls in → (1000+500)/100 = 15
        assertEq(f.rate(), 15, "rolled rate");
        assertEq(f.periodFinish(), block.timestamp + 100, "period extended");
    }

    /// Accrual is clamped to periodFinish — no emission past the funded window.
    function test_period_clamp() public {
        FarmController f = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        f.notifyRewardAmount(100, 10); // rate = 10, periodFinish = t0 + 10
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        f.onCdpMint(legs, 0, keccak256("p1"), 0); // bond 100 at t0
        skip(20); // 20s, but the window closed at t0 + 10
        // accrual capped at 10s: rps = 10·10·PRECISION/100 = PRECISION (NOT 2·PRECISION)
        assertEq(f.currentRps(), f.PRECISION(), "accrual clamped to periodFinish");
    }

    function test_no_staker_interval_does_not_accrue() public {
        FarmController f = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        f.notifyRewardAmount(1000, 100); // rate = 10
        skip(50);
        assertEq(f.currentRps(), 0, "no shares means no rps accrual");

        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(STAKE, 100);
        f.onCdpMint(legs, 0, keccak256("p1"), 0);
        skip(10);
        assertEq(f.currentRps(), f.PRECISION(), "only post-bond emission accrues");
    }

    /// recover: MINT mode has no escrow → unsupported; ESCROW mode is gated to creator + post period+grace.
    function test_recover_gating() public {
        // MINT mode: no treasury to refund
        FarmController mintFarm = _newMintFarm();
        vm.expectRevert(FarmController.NotSupported.selector);
        mintFarm.recover(address(this));

        // ESCROW mode: the funder funds the treasury directly via pool.farmEscrow (here: seed the stub); notify
        // only sets the rate. recover is gated to creator + post period+grace.
        FarmController esc = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        esc.notifyRewardAmount(1000, 100); // sets rate; funding is separate (pool.farmEscrow)
        stubTreasury = 1000;
        vm.prank(address(0xBEEF));
        vm.expectRevert(FarmController.NotGov.selector);
        esc.recover(address(this));
        vm.expectRevert(FarmController.ZeroAddress.selector);
        esc.recover(address(0));
        vm.expectRevert(FarmController.TooEarly.selector);
        esc.recover(address(this)); // before periodFinish + grace
        skip(100 + 7 days + 1); // past periodFinish + RECOVER_GRACE
        uint256 released = esc.recover(address(this));
        assertEq(released, 1000, "leftover reclaimed");
        assertEq(stubTreasury, 0, "treasury drained on recover");
    }

    /// A staker that bonds then unbonds WITHOUT harvesting forfeits its reward, and once the last share leaves
    /// the reservation is exactly 0, so the sponsor recovers the ENTIRE treasury. (The H-01 clear-on-zero hack
    /// is gone: `totalRewardDebt` retires the stamped debt exactly, which makes the reservation 0 by itself.)
    function test_recover_returns_forfeited_budget_after_full_unbond() public {
        FarmController esc = new FarmController(address(this), STAKE, REWARD, true, true, address(this), 0);
        esc.notifyRewardAmount(1000, 100); // rate 10/sec over 100s
        stubTreasury = 1000;

        // Bond a dust share, accrue the whole campaign, unbond without harvesting.
        CdpLeg[] memory bond = new CdpLeg[](1);
        bond[0] = CdpLeg(STAKE, 1);
        esc.onCdpMint(bond, 0, HARVEST, uint256(keccak256("dust")));
        skip(100); // full campaign emits while the share is live
        assertGt(esc.currentRps(), 0, "campaign emitted reward-per-share");

        CdpLeg[] memory unbond = new CdpLeg[](1);
        unbond[0] = CdpLeg(STAKE, 1);
        esc.onCdpClose(0, 0, uint256(keccak256("dust")), unbond, bytes32(0)); // no prior harvest ⇒ forfeited
        assertEq(esc.totalShares(), 0, "no shares left");
        assertEq(esc.totalRewardDebt(), 0, "stamped debt retired exactly");
        assertEq(esc.outstandingReward(), 0, "nothing reserved for a position that no longer exists");

        skip(7 days + 1); // past periodFinish + RECOVER_GRACE
        assertEq(esc.recover(address(this)), 1000, "sponsor recovers the entire abandoned budget");
    }

    function test_notify_only_gov() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(FarmController.NotGov.selector);
        farm.notifyRewardAmount(100, 10);
    }

    function test_notify_rejects_zero_effective_rate() public {
        FarmController f = new FarmController(address(this), STAKE, REWARD, true, false, address(this), 0);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        f.notifyRewardAmount(0, 10);

        vm.expectRevert(FarmController.BadFarmShape.selector);
        f.notifyRewardAmount(9, 10);
    }

    function test_farm_callbacks_reject_debt_snapshot_fields() public {
        CdpLeg[] memory bondLegs = new CdpLeg[](1);
        bondLegs[0] = CdpLeg(STAKE, 100);

        vault.onCdpMint(bondLegs, 0, keccak256("p1"), 0); // bare bond on the plain vault

        CdpLeg[] memory closeLegs = new CdpLeg[](1);
        closeLegs[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.BadFarmShape.selector);
        vault.onCdpClose(0, 1, 0, closeLegs, keccak256("n1"));
        // A plain vault has no stamped positions, so it must not be handed a receipt leaf.
        vm.expectRevert(FarmController.BadFarmShape.selector);
        vault.onCdpClose(0, 0, 1, closeLegs, keccak256("n2"));
    }

    /// A reward farm (RECEIPT_MODE) rejects bare position locks (positionLeaf > 1) — they would inflate
    /// totalShares and dilute receipt holders' rps without ever harvesting. Receipt ops still work.
    function test_receipt_mode_rejects_bare_bond() public {
        FarmController rf = new FarmController(address(this), STAKE, REWARD, true, true, address(this), 0);
        CdpLeg[] memory bare = new CdpLeg[](1);
        bare[0] = CdpLeg(STAKE, 100);
        vm.expectRevert(FarmController.NotSupported.selector);
        rf.onCdpMint(bare, 0, keccak256("bare-position"), 0); // leaf > 1 rejected in receipt mode

        CdpLeg[] memory receipt = new CdpLeg[](1);
        receipt[0] = CdpLeg(STAKE, 100);
        rf.onCdpMint(receipt, 0, HARVEST, uint256(keccak256("alice"))); // receipt bond (leaf == 1) accepted
        assertEq(rf.totalShares(), 100, "receipt bond tracked");
    }

    /// notify rejects a rate that would overflow accrual (and thereby lock principal by reverting unbond).
    function test_notify_rejects_overflowing_rate() public {
        vm.expectRevert(FarmController.RateTooHigh.selector);
        farm.notifyRewardAmount(type(uint256).max / 2, 1);
    }
}
