// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {WrappedTac} from "../../../src/WrappedTac.sol";
import {FarmManager} from "../../../src/FarmManager.sol";
import {ConfidentialPool, CdpLeg} from "../../../src/ConfidentialPool.sol";

interface ITacMint {
    function mint(address to, uint256 amount) external;
    function approve(address, uint256) external returns (bool);
}

/// MAINNET FORK: FarmManager against the LIVE gen5 pool, hooks driven by pranking the pool with the exact
/// (legs, debtValue, positionLeaf, rateSnapshot) shapes the guest emits (main.rs OP_FARM_BOND / OP_LP_BOND /
/// OP_FARM_HARVEST / OP_FARM_UNBOND). The pool's per-harvest farmTreasury debit is replayed via a storage write.
contract FarmManagerLivePool is Test {
    using stdStorage for StdStorage;

    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address gov = address(0x60A);
    address funder = address(0xF00D);
    bytes32 constant ONE = bytes32(uint256(1));

    WrappedTac w;
    bytes32 wId;
    FarmManager m;
    bytes32[] stakes;
    uint256 scale;

    function setUp() public {
        if (block.chainid != 1) vm.skip(true);
        w = new WrappedTac(TAC);
        wId = ConfidentialPool(payable(POOL)).registerWrappedAuto(address(w), bytes32(0));
        (,, scale,,,) = ConfidentialPool(payable(POOL)).assets(wId);
        uint32[] memory allocs = new uint32[](16);
        uint64[] memory locks = new uint64[](16);
        for (uint256 i; i < 16; ++i) {
            stakes.push(keccak256(abi.encode("lp", i)));
            allocs[i] = uint32(100 + i);
            locks[i] = uint64(i * 1 days);
        }
        m = new FarmManager(POOL, wId, gov, stakes, allocs, locks);
        vm.prank(POOL);
        ITacMint(TAC).mint(funder, 1_000_000 ether);
        vm.startPrank(funder);
        ITacMint(TAC).approve(address(w), type(uint256).max);
        w.deposit(1_000_000 ether, funder);
        w.transfer(gov, 500_000 ether);
        vm.stopPrank();
        vm.startPrank(gov);
        w.approve(address(m), type(uint256).max);
        vm.stopPrank();
    }

    function _treasury() internal view returns (uint256) {
        return ConfidentialPool(payable(POOL)).farmTreasury(address(m));
    }

    function _setTreasury(uint256 v) internal {
        stdstore.target(POOL).sig("farmTreasury(address)").with_key(address(m)).checked_write(v);
    }

    function _bond(bytes32 stake, uint256 shares, bytes32 receipt) internal {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stake, shares);
        vm.prank(POOL);
        m.onCdpMint(l, 0, ONE, uint256(receipt));
    }

    /// pool semantics: debit farmTreasury by `reward` BEFORE the hook (ConfidentialPool.sol:2028-2034)
    function _harvest(bytes32 receipt, uint256 shares, uint256 reward) internal {
        uint256 t = _treasury();
        require(t >= reward, "pool would revert InsufficientEscrow");
        _setTreasury(t - reward);
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(wId, shares);
        vm.prank(POOL);
        m.onCdpMint(l, reward, ONE, uint256(receipt));
    }

    /// guest OP_FARM_UNBOND emits ONE leg with the GROSS shares (relay fee carved from the released note, not the leg)
    function _unbond(bytes32 receipt, bytes32 stake, uint256 shares) internal {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stake, shares);
        vm.prank(POOL);
        m.onCdpClose(0, 0, uint256(receipt), l, bytes32(0));
    }

    function _fund(uint256 tokens, uint256 dur) internal {
        vm.prank(gov);
        m.fundAndNotify(tokens, dur);
    }

    // ---------------- integration with the real pool ----------------

    function test_ctorAndFundPinAgainstRealPool() public {
        assertEq(m.REWARD_TOKEN(), address(w));
        assertEq(m.UNIT_SCALE(), scale);
        assertEq(m.poolLength(), 16);
        _fund(250_000 ether, 90 days);
        assertEq(_treasury(), 250_000 ether / scale);
        assertEq(w.balanceOf(POOL), 250_000 ether);
        assertEq(w.balanceOf(address(m)), 0);
        assertEq(w.allowance(address(m), POOL), 0);
        assertEq(m.rate(), (250_000 ether / scale) / 90 days);
        // a second fund reuses the pin
        _fund(1_000 ether, 90 days);
    }

    function test_unalignedFundRevertsAtomically() public {
        vm.prank(gov);
        vm.expectRevert();
        m.fundAndNotify(1000 ether + 1, 30 days);
        assertEq(w.balanceOf(address(m)), 0);
        assertEq(_treasury(), 0);
    }

    function test_wrongRewardAssetRejectedInCtor() public {
        bytes32[] memory s = new bytes32[](0);
        uint32[] memory a = new uint32[](0);
        uint64[] memory d = new uint64[](0);
        vm.expectRevert(FarmManager.BadRewardAsset.selector);
        new FarmManager(POOL, keccak256("nope"), gov, s, a, d);
        // canonical pool-minted TAC (the reason wTAC exists) is rejected at construction
        vm.expectRevert(FarmManager.BadRewardAsset.selector);
        new FarmManager(POOL, 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b, gov, s, a, d);
    }

    function test_onlyPoolCanCallHooks() public {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stakes[0], 5);
        vm.expectRevert(FarmManager.NotPool.selector);
        m.onCdpMint(l, 0, ONE, 1);
        vm.expectRevert(FarmManager.NotPool.selector);
        m.onCdpClose(0, 0, 1, l, bytes32(0));
    }

    /// Funding compares the pull against the balance before and after, so a stray wTAC balance does not affect it.
    function test_fundingWorksWithAStrayTokenBalance() public {
        vm.prank(funder);
        w.transfer(address(m), 1);
        vm.prank(gov);
        m.fundAndNotify(1000 ether, 30 days);
        assertGt(m.rate(), 0);
        vm.prank(gov);
        m.fund(1000 ether);
        assertEq(_treasury(), 2000 ether / scale);
        assertEq(w.balanceOf(address(m)), 1, "only the stray balance stays behind");
    }

    function test_directPoolFundBeforeManagerNotify() public {
        // TacFarmFunder-style: fund the manager as controller directly via the pool
        vm.startPrank(funder);
        w.approve(POOL, type(uint256).max);
        ConfidentialPool(payable(POOL)).farmEscrow(address(m), wId, 5_000 ether, address(0));
        vm.stopPrank();
        vm.prank(gov);
        m.notifyRewardAmount(5_000 ether / scale, 30 days);
        vm.prank(gov);
        vm.expectRevert(FarmManager.UnfundedRate.selector);
        m.notifyRewardAmount(5_001 ether / scale, 30 days);
    }

    // ---------------- hook lifecycle with pool semantics ----------------

    function test_bondHarvestUnbondLifecycleAndRecover() public {
        _fund(100_000 ether, 30 days);
        bytes32 r1 = keccak256("r1");
        bytes32 r2 = keccak256("r2");
        _bond(stakes[3], 1_000e8, r1); // lock = 3 days
        _bond(stakes[3], 3_000e8, r2);
        skip(10 days);
        uint256 p1 = m.pending(r1);
        uint256 p2 = m.pending(r2);
        assertGt(p1, 0);
        assertApproxEqAbs(p2, p1 * 3, 3);
        _harvest(r1, 1_000e8, p1);
        // replay pays nothing
        vm.expectRevert(FarmManager.OverClaim.selector);
        _harvestNoDebit(r1, 1_000e8, 1);
        // proof shares != bonded shares -> BadFarmShape (cannot happen in a real proof: shares are inside the receipt leaf)
        vm.expectRevert(FarmManager.BadFarmShape.selector);
        _harvestNoDebit(r2, 2_999e8, 1);
        skip(25 days); // past periodFinish
        uint256 q1 = m.pending(r1);
        uint256 q2 = m.pending(r2);
        _harvest(r1, 1_000e8, q1);
        _unbond(r1, stakes[3], 1_000e8);
        // unbond deleted the position: harvest is closed (matches FarmController: stamp deleted)
        vm.expectRevert(FarmManager.NoLivePosition.selector);
        _harvestNoDebit(r1, 1_000e8, 1);
        // recover after grace: pool must reserve r2's earned reward exactly (manager.outstandingReward via the real pool)
        skip(8 days);
        uint256 tBefore = _treasury();
        vm.prank(gov);
        uint256 released = m.recover(address(0xBEEF));
        uint256 reserve = m.outstandingReward();
        assertGe(reserve, p2 + q2 - p2, "reserve covers r2's tail"); // r2 never harvested
        assertEq(released, tBefore - reserve);
        assertEq(_treasury(), reserve);
        assertEq(w.balanceOf(address(0xBEEF)), released * scale);
        // r2 can still harvest its full tail after recover
        uint256 owed = m.pending(r2);
        assertLe(owed, _treasury());
        _harvest(r2, 3_000e8, owed);
        _unbond(r2, stakes[3], 3_000e8);
        assertEq(m.outstandingReward(), 0);
        // now a full-exit recover returns everything left
        vm.prank(gov);
        m.recover(address(0xBEEF));
        assertEq(_treasury(), 0);
    }

    function _harvestNoDebit(bytes32 receipt, uint256 shares, uint256 reward) internal {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(wId, shares);
        vm.prank(POOL);
        m.onCdpMint(l, reward, ONE, uint256(receipt));
    }

    function test_lockIsPerPositionAndUnbondGross() public {
        _fund(10_000 ether, 30 days);
        bytes32 r = keccak256("r");
        _bond(stakes[5], 777, r); // 5 day lock
        vm.expectRevert(FarmManager.Locked.selector);
        _unbond(r, stakes[5], 777);
        skip(5 days);
        _unbond(r, stakes[5], 777);
    }

    function test_recoverBeforeAnyNotifyAndRetiredPool() public {
        // fund through the pool, never notify, recover returns everything after 7d
        vm.startPrank(funder);
        w.approve(POOL, type(uint256).max);
        ConfidentialPool(payable(POOL)).farmEscrow(address(m), wId, 5_000 ether, address(0));
        vm.stopPrank();
        skip(8 days);
        // simulate retirement of the generation: successor != 0
        stdstore.target(POOL).sig("successor()").checked_write(address(0xDEAD));
        // funding barred, recover (an exit) stays open
        vm.prank(gov);
        vm.expectRevert();
        m.fundAndNotify(1 ether, 30 days);
        vm.prank(gov);
        uint256 out = m.recover(address(0xBEEF));
        assertEq(out, 5_000 ether / scale);
    }

    // ---------------- rounding / solvency ----------------

    function test_outstandingRoundUpNeverBelowSumOfMaxHarvests() public {
        _fund(1_000 ether, 7 days);
        uint256 n = 40;
        bytes32[] memory rs = new bytes32[](n);
        uint256[] memory sh = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            rs[i] = keccak256(abi.encode("rr", i));
            sh[i] = 7 + i * 13;
            _bond(stakes[i % 16], sh[i], rs[i]);
            skip(1 hours + i * 7 seconds);
        }
        skip(8 days);
        vm.prank(gov);
        m.massUpdatePools();
        uint256 sum;
        for (uint256 i; i < n; ++i) sum += m.pending(rs[i]);
        assertGe(m.outstandingReward(), sum);
        assertLe(m.outstandingReward() - sum, 16 + n, "slack <= #pools (ceil) + #positions (per-position floor)");
        // total ever payable never exceeds what was funded
        assertLe(sum, _treasury());
    }

    // ---------------- gas / size ----------------

    function test_gasMassUpdate16Pools() public {
        _fund(10_000 ether, 30 days);
        for (uint256 i; i < 16; ++i) _bond(stakes[i], 1e8 + i, keccak256(abi.encode("g", i)));
        skip(1 days);
        uint256 g = gasleft();
        m.massUpdatePools();
        emit log_named_uint("massUpdatePools(16 pools, all staked) gas", g - gasleft());
        skip(1 days);
        g = gasleft();
        _harvestGas();
        emit log_named_uint("single harvest hook gas (accrues 1 pool)", g - gasleft());
        g = gasleft();
        vm.prank(gov);
        m.fundAndNotify(1000 ether, 30 days);
        emit log_named_uint("fundAndNotify top-up (16 pools, pull+escrow+massUpdate+outstanding) gas", g - gasleft());
    }

    function _harvestGas() internal {
        bytes32 r = keccak256(abi.encode("g", uint256(0)));
        uint256 pend = m.pending(r);
        _setTreasury(_treasury());
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(wId, 1e8);
        vm.prank(POOL);
        m.onCdpMint(l, pend, ONE, uint256(r));
    }

    function test_codeSize() public {
        emit log_named_uint("FarmManager runtime bytes", address(m).code.length);
        assertLt(address(m).code.length, 24576);
    }
}
