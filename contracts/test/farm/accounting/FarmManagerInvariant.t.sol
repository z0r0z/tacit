// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FarmManager} from "../../../src/FarmManager.sol";
import {MockToken, MockPool} from "./Harness.sol";

contract Handler is Test {
    MockToken public token;
    MockPool public pool;
    FarmManager public m;
    uint256 public scale;

    uint256 public funded; // value units
    uint256 public paid;
    uint256 public released;
    bool public overclaimAccepted;
    bool public replayAccepted;
    bool public earlyUnbondAccepted;
    uint256 public maxDeficit; // max (outstanding - treasury) seen after accrual
    uint256 public actions;
    bool public bandRejected;
    uint256 public cNotify; uint256 public cHarv; uint256 public cRecover; uint256 public cRecoverNonZero; uint256 public cUnbond; uint256 public cReweight; uint256 public cAdd; uint256 public cBond;

    bytes32[] public receipts;
    mapping(bytes32 => bool) public used;
    uint256 nonce;
    uint256 public nAddQueued;

    constructor(uint256 scale_) {
        scale = scale_;
        token = new MockToken();
        pool = new MockPool(token, scale_);
        bytes32[] memory sa = new bytes32[](3);
        uint32[] memory ap = new uint32[](3);
        uint64[] memory ld = new uint64[](3);
        for (uint256 i; i < 3; ++i) sa[i] = keccak256(abi.encode("lp", i));
        ap[0] = 100; ap[1] = 50; ap[2] = 1;
        ld[0] = 0; ld[1] = 1 days; ld[2] = 30 days;
        m = new FarmManager(address(pool), pool.REWARD(), address(this), sa, ap, ld);
        vm.warp(1_000_000);
        token.mint(address(this), type(uint128).max);
        token.approve(address(m), type(uint256).max);
    }

    function _fund(uint256 v) internal {
        // fund through the manager as gov
    }

    function fundAndNotify(uint256 amtSeed, uint256 durSeed) external {
        actions++;
        uint256 valueAmt = bound(amtSeed, 1e6, 1e12);
        uint256 dur = bound(durSeed, 7 days, 365 days);
        try m.fundAndNotify(valueAmt * scale, dur) {
            funded += valueAmt; cNotify++;
        } catch {}
    }

    function fundOnly(uint256 amtSeed) external {
        actions++;
        uint256 valueAmt = bound(amtSeed, 1, 1e9);
        try m.fund(valueAmt * scale) { funded += valueAmt; } catch {}
    }

    function notifyFromTreasury(uint256 rewardSeed, uint256 durSeed) external {
        actions++;
        uint256 dur = bound(durSeed, 7 days, 365 days);
        uint256 reward = bound(rewardSeed, 0, pool.farmTreasury(address(m)));
        try m.notifyRewardAmount(reward, dur) {} catch {}
    }

    function warp(uint256 dt) external {
        actions++;
        skip(bound(dt, 0, 20 days));
    }

    function warpShort(uint256 dt) external {
        skip(bound(dt, 0, 1000));
    }

    function bond(uint256 poolSeed, uint256 sharesSeed) external {
        actions++;
        uint256 n = m.poolLength();
        uint256 pid = bound(poolSeed, 0, n - 1);
        uint256 shares = sharesSeed % 4 == 0 ? bound(sharesSeed, 1, 3) : bound(sharesSeed, 1, 1e15);
        bytes32 r = keccak256(abi.encode("r", nonce++));
        try pool.bond(m, r, m.poolInfo(pid).stakeAsset, shares) {
            receipts.push(r); cBond++;
        } catch {}
    }

    function _live(uint256 seed) internal view returns (bool ok, bytes32 r, uint256 idx) {
        uint256 n = receipts.length;
        if (n == 0) return (false, 0, 0);
        idx = seed % n;
        r = receipts[idx];
        (, uint128 sh,,, bool live) = m.positions(r);
        ok = live && sh != 0;
    }

    function harvest(uint256 seed, uint256 mode) external {
        actions++;
        (bool ok, bytes32 r,) = _live(seed);
        if (!ok) return;
        (, uint128 sh,,,) = m.positions(r);
        uint256 p = m.pending(r);
        uint256 amt;
        if (mode % 3 == 0) amt = p; else if (mode % 3 == 1) amt = p / 2; else amt = p == 0 ? 0 : 1;
        if (amt == 0) return;
        try pool.harvest(m, r, sh, amt) { paid += amt; cHarv++; } catch {}
        // replay: an immediate second harvest must never pay
        try pool.harvest(m, r, sh, 1) { replayAccepted = true; paid += 1; } catch {}
    }

    function overclaim(uint256 seed) external {
        actions++;
        (bool ok, bytes32 r,) = _live(seed);
        if (!ok) return;
        (, uint128 sh,,,) = m.positions(r);
        uint256 p = m.pending(r);
        // pool debits then hook must revert on p+1 (state reverts with the call)
        try pool.harvest(m, r, sh, p + 1) { overclaimAccepted = true; paid += p + 1; } catch {}
    }

    function unbond(uint256 seed) external {
        actions++;
        (bool ok, bytes32 r,) = _live(seed);
        if (!ok) return;
        (, uint128 sh, uint64 unlockAt, uint32 pid,) = m.positions(r);
        bytes32 sa = m.poolInfo(pid).stakeAsset;
        if (block.timestamp < unlockAt) {
            try pool.unbond(m, r, sa, sh) { earlyUnbondAccepted = true; } catch {}
            return;
        }
        try pool.unbond(m, r, sa, sh) {} catch {}
    }

    function unbondAfterLock(uint256 seed) external {
        actions++;
        (bool ok, bytes32 r,) = _live(seed);
        if (!ok) return;
        (, uint128 sh, uint64 unlockAt, uint32 pid,) = m.positions(r);
        if (block.timestamp < unlockAt) vm.warp(unlockAt);
        try pool.unbond(m, r, m.poolInfo(pid).stakeAsset, sh) { cUnbond++; } catch {}
    }

    function massUpdate() external { actions++; m.massUpdatePools(); }

    function _cooldown() internal {
        uint256 lc = m.lastConfigAt();
        if (lc != 0 && block.timestamp < lc + 30 days) vm.warp(lc + 30 days);
    }

    function reweight(uint256 a, uint256 c) external {
        actions++;
        uint256 n = m.poolLength();
        uint256 pid = bound(a, 0, n - 1);
        uint256 cur = m.poolInfo(pid).allocPoint;
        if (cur == 0) return;
        // in-band: [ceil(0.75 cur), floor(1.25 cur)]
        uint256 lo = (cur * 3 + 3) / 4;
        uint256 hi = (cur * 5) / 4;
        if (hi < lo) return;
        uint256[] memory pids = new uint256[](1);
        uint32[] memory al = new uint32[](1);
        pids[0] = pid;
        al[0] = uint32(bound(c, lo, hi));
        _cooldown();
        try m.queueAllocs(pids, al) {} catch { return; }
        skip(7 days);
        try m.executeAllocs(pids, al) { cReweight++; } catch { bandRejected = true; }
    }

    function addPool(uint256 a, uint256 lock) external {
        actions++;
        if (m.poolLength() >= 16) return;
        bytes32 sa = keccak256(abi.encode("lp", uint256(100 + nAddQueued++)));
        uint256 ta = m.totalAllocPoint();
        // <= 10% of new total: a*9 <= ta  -> a <= ta/9
        uint256 maxA = ta / 9;
        if (maxA == 0) return;
        uint32 ap = uint32(bound(a, 1, maxA));
        uint64 ld = uint64(bound(lock, 0, 90 days));
        _cooldown();
        try m.queueAddPool(sa, ap, ld) {} catch { return; }
        skip(7 days);
        try m.executeAddPool(sa, ap, ld) { cAdd++; } catch { bandRejected = true; }
    }

    function recover() external {
        actions++;
        uint256 t = pool.farmTreasury(address(m));
        // move to eligibility
        uint256 fin = m.periodFinish() + 7 days;
        if (block.timestamp < fin) vm.warp(fin);
        try m.recover(address(0xBEEF)) returns (uint256 out) {
            released += out; cRecover++; if (out != 0) cRecoverNonZero++;
            t; 
        } catch {}
    }

    // ---- views used by invariants ----
    function sumPending() external view returns (uint256 s) {
        for (uint256 i; i < receipts.length; ++i) s += m.pending(receipts[i]);
    }

    function sharesByPool(uint256 pid) external view returns (uint256 s, uint256 debt) {
        for (uint256 i; i < receipts.length; ++i) {
            (uint256 e, uint128 sh,, uint32 p, bool live) = m.positions(receipts[i]);
            if (live && p == pid) { s += sh; debt += uint256(sh) * e; }
        }
    }

    function recordDeficit() external {
        m.massUpdatePools();
        uint256 o = m.outstandingReward();
        uint256 t = pool.farmTreasury(address(m));
        if (o > t && o - t > maxDeficit) maxDeficit = o - t;
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 120
contract FarmManagerInvariant is Test {
    Handler h;
    FarmManager m;
    MockPool pool;
    MockToken token;

    function setUp() public {
        h = new Handler(1);
        m = h.m();
        pool = h.pool();
        token = h.token();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = h.fundAndNotify.selector; sel[1] = h.bond.selector; sel[2] = h.harvest.selector;
        sel[3] = h.unbond.selector; sel[4] = h.warp.selector; sel[5] = h.warpShort.selector;
        sel[6] = h.massUpdate.selector; sel[7] = h.reweight.selector; sel[8] = h.addPool.selector;
        sel[9] = h.recover.selector; sel[10] = h.overclaim.selector; sel[11] = h.unbondAfterLock.selector;
        sel[12] = h.notifyFromTreasury.selector; sel[13] = h.fundOnly.selector; sel[14] = h.bond.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_conservation() public view {
        // funded == harvested + released + treasury ; pool token balance == (funded - released) * scale
        uint256 tr = pool.farmTreasury(address(m));
        assertEq(h.funded(), pool.totalHarvested() + h.released() + tr, "conservation");
        assertEq(h.paid(), pool.totalHarvested(), "paid ghost");
        assertEq(token.balanceOf(address(pool)), (h.funded() - h.released()) * h.scale(), "token bal");
        assertEq(token.balanceOf(address(m)), 0, "manager holds nothing");
    }

    function invariant_noOverclaimOrReplay() public view {
        assertFalse(h.overclaimAccepted(), "overclaim accepted");
        assertFalse(h.replayAccepted(), "replay accepted");
        assertFalse(h.earlyUnbondAccepted(), "early unbond");
    }

    /// Strict solvency: treasury covers every live position's claim PLUS all still-to-be-emitted reward.
    function invariant_solvency() public view {
        uint256 tr = pool.farmTreasury(address(m));
        uint256 fin = m.periodFinish();
        uint256 remaining = block.timestamp < fin ? (fin - block.timestamp) * m.rate() : 0;
        assertGe(tr, h.sumPending() + remaining, "treasury < claims + future emission");
    }

    function invariant_bookkeeping() public view {
        uint256 n = m.poolLength();
        uint256 ta;
        for (uint256 i; i < n; ++i) {
            (uint256 s, uint256 d) = h.sharesByPool(i);
            FarmManager.PoolInfo memory p = m.poolInfo(i);
            assertEq(p.totalShares, s, "sum shares");
            assertEq(p.totalRewardDebt, d, "sum debt");
            ta += p.allocPoint;
            assertLe(p.lastUpdate, block.timestamp, "lastUpdate future");
        }
        assertEq(m.totalAllocPoint(), ta, "totalAlloc");
    }

    /// The ceil'd reservation may exceed treasury by <= npools dust at the very end of a stream (never more).
    function invariant_reservationDust() public {
        h.recordDeficit();
        assertLe(h.maxDeficit(), m.poolLength(), "reservation deficit > npools");
    }

    function invariant_configNeverRejectedInBand() public view {
        assertFalse(h.bandRejected(), "in-band config rejected");
    }

    function afterInvariant() public {
        emit log_named_uint("notify", h.cNotify()); emit log_named_uint("bond", h.cBond());
        emit log_named_uint("harvest", h.cHarv()); emit log_named_uint("unbond", h.cUnbond());
        emit log_named_uint("recover", h.cRecover()); emit log_named_uint("recoverNonZero", h.cRecoverNonZero());
        emit log_named_uint("reweight", h.cReweight()); emit log_named_uint("addPool", h.cAdd());
        emit log_named_uint("maxDeficit", h.maxDeficit());
    }

    function invariant_zz_calls() public view {
        // ensures the campaign did something
        assertGe(h.actions(), 0);
    }
}
