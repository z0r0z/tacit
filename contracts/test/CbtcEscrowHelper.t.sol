// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {CollateralEngine, CdpLeg} from "../src/CollateralEngine.sol";
import {CbtcEscrowHelper} from "../src/CbtcEscrowHelper.sol";

/// Minimal ConfidentialPool stand-in — same surface CollateralEngine.t.sol's MockPool exposes for
/// IConfidentialPoolCollateral, plus a `settle` this suite controls so it can assert the exact
/// `postEscrowWithETHAndSettle` ordering claim (escrow posted BEFORE the pool checks `escrowSufficient`)
/// against the REAL CollateralEngine contract, without needing a full SP1-verified ConfidentialPool.
contract MockPool {
    mapping(bytes32 => uint64) public cbtcLockVBtc;
    mapping(bytes32 => bool) public cbtcLockSpent;
    mapping(bytes32 => bool) public cbtcLockRedeemed;
    mapping(bytes32 => bool) public cbtcMinted;
    uint256 public cbtcBackingSats;
    address public cbtcToken;
    address public COLLATERAL_ENGINE;

    // What the next `settle()` call should check / do — set by the test right before calling the helper.
    bytes32 public pendingOutpoint;
    uint256 public pendingVBtc;
    uint256 public pendingEthRefund; // if != 0, sent to msg.sender (the helper) during settle
    bool public lastSettleObservedSufficient;
    bool public lastSettleCalled;

    error InsufficientEscrowMock();

    function setEngine(address e) external {
        COLLATERAL_ENGINE = e;
    }

    function setLock(bytes32 o, uint64 v) external {
        cbtcLockVBtc[o] = v;
    }

    function setSpent(bytes32 o, bool s) external {
        cbtcLockSpent[o] = s;
    }

    function setRedeemed(bytes32 o, bool r) external {
        cbtcLockRedeemed[o] = r;
    }

    function setMinted(bytes32 o, bool m) external {
        cbtcMinted[o] = m;
    }

    function canonicalTokenFor(bytes32) external view returns (address) {
        return cbtcToken;
    }

    function setPendingSettleCheck(bytes32 outpoint, uint256 vBtc, uint256 ethRefund) external {
        pendingOutpoint = outpoint;
        pendingVBtc = vBtc;
        pendingEthRefund = ethRefund;
    }

    /// Mirrors the real ConfidentialPool.settle's cBTC-mint gate exactly: reads escrowSufficient off the REAL
    /// CollateralEngine, at settle time, for whatever the caller just posted. Reverts if insufficient — same
    /// fail-closed shape as `CbtcLockMismatch` in the real pool. Ignores the actual publicValues/proof/memos
    /// bytes (this suite tests the helper's ordering + fund-safety, not the SP1 verifier or proof shape).
    function settle(bytes calldata, bytes calldata, bytes[] calldata) external {
        lastSettleCalled = true;
        bool ok = CollateralEngine(COLLATERAL_ENGINE).escrowSufficient(pendingOutpoint, pendingVBtc);
        lastSettleObservedSufficient = ok;
        if (!ok) revert InsufficientEscrowMock();
        if (pendingEthRefund != 0) {
            (bool sent,) = msg.sender.call{value: pendingEthRefund}("");
            require(sent, "mock refund send failed");
        }
    }

    receive() external payable {}
}

contract MockFeed {
    int256 public ans;
    uint8 public immutable dec;
    uint256 public upAt;

    constructor(int256 a, uint8 d) {
        ans = a;
        dec = d;
        upAt = block.timestamp;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, ans, upAt, upAt, 1);
    }
}

interface IWstEthTest {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
    function stEthPerToken() external view returns (uint256);
}

/// MAINNET-FORK suite: drives CbtcEscrowHelper against the REAL, live wstETH contract (staking + EIP-2612
/// permit) and a FRESH, freshly-deployed-on-fork CollateralEngine (same source as the live one, not the live
/// instance itself) with a MockPool standing in for the ConfidentialPool. This suite exists specifically for
/// the two claims that cannot be exercised against live production state at all:
///   - `postEscrowWithETHAndSettle`'s ordering claim needs `POOL.settle()` to actually run and return/revert
///     on demand, which requires a real SP1/Groth16 proof against the live ConfidentialPool — infeasible here.
///   - The "escrow still locked" claim needs a lock outpoint with `cbtcMinted == true` on the pool, and as of
///     writing NO cBTC has ever been minted against the live gen4 pool (cBTC lock/redeem has not launched),
///     so no such real outpoint exists to test against.
/// See `CbtcEscrowHelperLiveEngineForkTest` below for the suite that drives the same helper against the REAL
/// deployed CollateralEngine (0x000000008cAD17f5BB485A7D521E89A9C4716cC0 on mainnet) and its real, immutably
/// wired live ConfidentialPool for every path that doesn't require the above.
contract CbtcEscrowHelperForkTest is Test {
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0; // Lido wstETH (verified live mainnet)
    bytes32 constant CBTC = keccak256("tacit-cbtc-zk-lock-v1");

    CollateralEngine eng;
    MockPool pool;
    CbtcEscrowHelper helper;
    IWstEthTest wsteth;
    bool forked;

    address admin = address(0xA11CE);

    // EIP-2612 owner for the permit test.
    uint256 constant OWNER_PK = 0xBEEF;
    address owner;

    function setUp() public {
        string[5] memory rpcs = [
            "https://eth.drpc.org",
            "https://ethereum-rpc.publicnode.com",
            "https://cloudflare-eth.com",
            "https://rpc.ankr.com/eth",
            "https://eth.llamarpc.com"
        ];
        for (uint256 i; i < rpcs.length; ++i) {
            try vm.createSelectFork(rpcs[i]) {
                forked = true;
                console2.log("forked (head) via:", rpcs[i]);
                break;
            } catch {
                console2.log("rpc failed:", rpcs[i]);
            }
        }
        if (!forked) {
            console2.log("ALL public RPCs failed/ratelimited - skipping fork test");
            return;
        }
        require(WSTETH.code.length != 0, "wstETH not deployed on fork");

        wsteth = IWstEthTest(WSTETH);
        owner = vm.addr(OWNER_PK);

        pool = new MockPool();
        eng = new CollateralEngine(address(0), CBTC, 8, 8, admin, WSTETH);
        pool.setEngine(address(eng));
        vm.prank(admin);
        eng.setPool(address(pool));

        MockFeed wstEthBtc = new MockFeed(0.05e8, 8); // 1 wstETH ~= 0.05 BTC
        MockFeed btcUsd = new MockFeed(60_000e8, 8);
        vm.startPrank(admin);
        eng.setFeeds(address(wstEthBtc), address(btcUsd), address(0), address(0));
        eng.setParams(3600, 15_000, 15_000, 13_000); // 1.5x escrow, 1.5x cdp mint, 1.3x liq
        vm.stopPrank();

        helper = new CbtcEscrowHelper(address(eng));
        assertEq(address(helper.WSTETH()), WSTETH);
        assertEq(address(helper.POOL()), address(pool));
    }

    /// Stakes real ETH into the real wstETH contract directly (bypassing the helper) — used as an independent
    /// oracle on "how much wstETH does X ETH actually buy right now" to cross-check the helper's own staking.
    function _stakeDirect(address who, uint256 ethIn) internal returns (uint256 got) {
        vm.deal(who, ethIn);
        uint256 before = wsteth.balanceOf(who);
        vm.prank(who);
        (bool ok,) = WSTETH.call{value: ethIn}("");
        require(ok, "direct stake failed");
        got = wsteth.balanceOf(who) - before;
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    // ─────────────────────── postEscrowWithETH ───────────────────────

    function test_postEscrowWithETH_postsActualStakedAmount_notMsgValue() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("outpoint-eth");
        uint256 ethIn = 3 ether;

        // Independent oracle: what would 3 ETH staked directly yield, right now, on the real contract.
        uint256 expected = _stakeDirect(address(0xFEED), ethIn);
        assertTrue(expected > 0 && expected < ethIn, "wstETH received should be less than ETH in (rate > 1)");

        vm.deal(depositor, ethIn);
        vm.prank(depositor);
        helper.postEscrowWithETH{value: ethIn}(outpoint);

        assertEq(helper.helperEscrowOf(outpoint, depositor), expected, "helper must credit the ACTUAL wstETH minted");
        assertEq(eng.escrowOf(outpoint, address(helper)), expected, "engine must hold exactly the actual amount");
        assertEq(eng.escrowTotal(outpoint), expected);
        assertEq(address(helper).balance, 0, "no ETH dust left in the helper");
        assertEq(wsteth.balanceOf(address(helper)), 0, "no wstETH left idle in the helper (all posted)");
    }

    function test_postEscrowWithETH_zeroValueReverts() public {
        _skipUnlessForked();
        vm.expectRevert(CbtcEscrowHelper.BadAmount.selector);
        helper.postEscrowWithETH(keccak256("x"));
    }

    // ─────────────────────── postEscrowWithPermit ───────────────────────

    function test_postEscrowWithPermit_creditsOriginalCaller() public {
        _skipUnlessForked();
        bytes32 outpoint = keccak256("outpoint-permit");
        uint256 amount = _stakeDirect(owner, 2 ether); // fund `owner` with real wstETH first

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(helper), amount, wsteth.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wsteth.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);

        uint256 ownerBalBefore = wsteth.balanceOf(owner);
        vm.prank(owner);
        helper.postEscrowWithPermit(outpoint, amount, deadline, v, r, s);

        assertEq(wsteth.balanceOf(owner), ownerBalBefore - amount, "permit path must pull from the signer");
        assertEq(helper.helperEscrowOf(outpoint, owner), amount, "credited to the ORIGINAL signer, not the helper");
        assertEq(eng.escrowOf(outpoint, address(helper)), amount, "helper is the engine's funder-of-record");
        assertEq(eng.escrowOf(outpoint, owner), 0, "the signer itself never touches the engine directly");
    }

    // ─────────────────────── reclaimEscrow ───────────────────────

    function test_reclaimEscrow_returnsToOriginalDepositor_notHelper() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("outpoint-reclaim");
        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        helper.postEscrowWithETH{value: 1 ether}(outpoint);
        uint256 posted = helper.helperEscrowOf(outpoint, depositor);
        assertTrue(posted > 0);

        // Never minted against this lock -> claimEscrow's release condition is met.
        pool.setMinted(outpoint, false);

        uint256 before = wsteth.balanceOf(depositor);
        vm.prank(depositor);
        helper.reclaimEscrow(outpoint);

        assertEq(wsteth.balanceOf(depositor), before + posted, "depositor recovers exactly its posted amount");
        assertEq(helper.helperEscrowOf(outpoint, depositor), 0);
        assertEq(eng.escrowOf(outpoint, address(helper)), 0);
        assertEq(wsteth.balanceOf(address(helper)), 0, "nothing left stuck in the helper");
    }

    function test_reclaimEscrow_lockedRevertsThroughUnchanged() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("outpoint-locked");
        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        helper.postEscrowWithETH{value: 1 ether}(outpoint);

        // Minted AND not redeemed -> still backing outstanding cBTC -> engine.claimEscrow reverts EscrowLocked.
        pool.setMinted(outpoint, true);
        pool.setRedeemed(outpoint, false);

        vm.prank(depositor);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        helper.reclaimEscrow(outpoint);
    }

    function test_reclaimEscrow_noShareReverts() public {
        _skipUnlessForked();
        vm.expectRevert(CbtcEscrowHelper.NothingToRelease.selector);
        vm.prank(address(0xD0F0));
        helper.reclaimEscrow(keccak256("never-posted"));
    }

    /// Two depositors fund the SAME outpoint through the helper; the engine has only one funder-of-record (the
    /// helper) and a single combined balance for it, but each depositor must be able to reclaim independently,
    /// in any order, for exactly their own share — the core "solves the funder-of-record problem" claim.
    function test_reclaimEscrow_multiDepositor_sameOutpoint_eachGetsOwnShare() public {
        _skipUnlessForked();
        address a = address(0xA);
        address b = address(0xB);
        bytes32 outpoint = keccak256("outpoint-multi");

        vm.deal(a, 1 ether);
        vm.prank(a);
        helper.postEscrowWithETH{value: 1 ether}(outpoint);
        uint256 shareA = helper.helperEscrowOf(outpoint, a);

        vm.deal(b, 2 ether);
        vm.prank(b);
        helper.postEscrowWithETH{value: 2 ether}(outpoint);
        uint256 shareB = helper.helperEscrowOf(outpoint, b);

        assertEq(eng.escrowOf(outpoint, address(helper)), shareA + shareB);
        pool.setMinted(outpoint, false); // releasable

        // B reclaims FIRST: pulls the WHOLE engine-side pot into the helper, keeps only its own share.
        uint256 bBefore = wsteth.balanceOf(b);
        vm.prank(b);
        helper.reclaimEscrow(outpoint);
        assertEq(wsteth.balanceOf(b), bBefore + shareB);
        assertEq(eng.escrowOf(outpoint, address(helper)), 0, "engine side fully drained by the first reclaim");
        assertEq(wsteth.balanceOf(address(helper)), shareA, "A's share now sits in the helper, not the engine");

        // A reclaims SECOND: engine side is already 0, so the helper must pay out of its own held balance.
        uint256 aBefore = wsteth.balanceOf(a);
        vm.prank(a);
        helper.reclaimEscrow(outpoint);
        assertEq(wsteth.balanceOf(a), aBefore + shareA);
        assertEq(wsteth.balanceOf(address(helper)), 0, "fully drained, nothing stuck");
    }

    // ─────────────────────── postEscrowWithETHAndSettle ───────────────────────

    /// The core ordering claim: escrow posted by THIS call must already be visible to
    /// CollateralEngine.escrowSufficient by the time `settle` (called later in the SAME transaction) checks it.
    function test_postEscrowWithETHAndSettle_orderingIsSufficient() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("outpoint-settle-ok");
        uint64 vBtc = 1_000_000; // 0.01 BTC -> requiredEscrow = 0.3 wstETH at the fixture's feeds
        pool.setLock(outpoint, vBtc);
        pool.setPendingSettleCheck(outpoint, vBtc, 0);

        vm.deal(depositor, 1 ether); // stakes to ~0.8 wstETH, comfortably over the 0.3 requirement
        vm.prank(depositor);
        helper.postEscrowWithETHAndSettle{value: 1 ether}(outpoint, "", "", new bytes[](0));

        assertTrue(pool.lastSettleCalled());
        assertTrue(pool.lastSettleObservedSufficient(), "escrow posted by this call must already read sufficient");
    }

    /// Same call, but the caller under-stakes: the pool's escrowSufficient check (the real engine logic) must
    /// still fail closed, and the whole transaction (stake + post) reverts atomically.
    function test_postEscrowWithETHAndSettle_insufficientStakeRevertsAtomically() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("outpoint-settle-fail");
        uint64 vBtc = 1e8; // 1 BTC -> requiredEscrow = 30 wstETH, far more than 1 ETH ever stakes to
        pool.setLock(outpoint, vBtc);
        pool.setPendingSettleCheck(outpoint, vBtc, 0);

        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        vm.expectRevert(MockPool.InsufficientEscrowMock.selector);
        helper.postEscrowWithETHAndSettle{value: 1 ether}(outpoint, "", "", new bytes[](0));

        // Atomic revert: no residual escrow, no stray ETH/wstETH anywhere.
        assertEq(eng.escrowOf(outpoint, address(helper)), 0);
        assertEq(helper.helperEscrowOf(outpoint, depositor), 0);
        assertEq(depositor.balance, 1 ether, "ETH fully refunded by the revert");
    }

    /// Defense-in-depth: if the settle call causes the pool to pay native ETH back to the helper (e.g. a
    /// same-batch withdrawal), the helper must sweep it to the original caller in the same transaction rather
    /// than stranding it.
    function test_postEscrowWithETHAndSettle_sweepsStrayEthToCaller() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("outpoint-settle-refund");
        uint64 vBtc = 1_000_000;
        pool.setLock(outpoint, vBtc);
        vm.deal(address(pool), 5 ether);
        pool.setPendingSettleCheck(outpoint, vBtc, 0.5 ether);

        vm.deal(depositor, 1 ether);
        uint256 before = depositor.balance;
        vm.prank(depositor);
        helper.postEscrowWithETHAndSettle{value: 1 ether}(outpoint, "", "", new bytes[](0));

        assertEq(depositor.balance, before - 1 ether + 0.5 ether, "stray ETH swept back to the depositor");
        assertEq(address(helper).balance, 0, "nothing left resting in the helper");
    }

    function test_receive_rejectsDirectSendFromNonPool() public {
        _skipUnlessForked();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(helper).call{value: 1 ether}("");
        assertFalse(ok, "a bare direct ETH send from a random address must be rejected");
    }
}

/// MAINNET-FORK suite, driven against the REAL, live, deployed CollateralEngine
/// (0x000000008cAD17f5BB485A7D521E89A9C4716cC0 — verified via `contracts/deployments/1-createx.json`'s
/// `engine` field and confirmed live via `eth_getCode`) and, transitively, its REAL immutably-wired
/// ConfidentialPool (0x0000000098A73197B3255aD9db1ed8544410f5Ba — confirmed via the engine's own `POOL()`
/// getter and the pool's reciprocal `COLLATERAL_ENGINE()` pointer). Nothing here is deployed fresh: the helper
/// is constructed directly against the live engine address and reads its real `WSTETH()`/`POOL()` at
/// construction, exactly as a real deploy would.
///
/// Scope: every path that only touches `CollateralEngine.postEscrow`/`claimEscrow` and the pool's
/// `cbtcLockSpent`/`cbtcLockRedeemed`/`cbtcMinted` VIEW gates — none of which take a price feed or governance
/// param, so this suite needs no admin prank, no feed stub, and no param setup; it reads the engine exactly as
/// governance left it live. Test outpoints are fresh `keccak256` values never seen by the live pool, so the
/// gates read their real default (false/false/false) storage — confirmed live via `cast call` before writing
/// this suite — meaning `postEscrow`/`claimEscrow` take their real "never locked, never minted" branch on
/// genuine production storage, not a stand-in for it.
///
/// Out of scope (see `CbtcEscrowHelperForkTest` above for why, and what stands in instead):
///   - `postEscrowWithETHAndSettle` / the settle-ordering and stray-ETH-sweep claims — the live pool's
///     `settle` needs a real SP1/Groth16 proof, which this suite cannot manufacture.
///   - The "escrow still locked" revert path — needs a real outpoint with `cbtcMinted == true` on the live
///     pool, and none exists yet (cBTC lock/redeem has not launched on gen4 as of writing).
contract CbtcEscrowHelperLiveEngineForkTest is Test {
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0; // Lido wstETH (verified live mainnet)
    address constant LIVE_ENGINE = 0x000000008cAD17f5BB485A7D521E89A9C4716cC0; // REAL deployed CollateralEngine

    CbtcEscrowHelper helper;
    IWstEthTest wsteth;
    bool forked;

    // EIP-2612 owner for the permit test.
    uint256 constant OWNER_PK = 0xBEEF;
    address owner;

    function setUp() public {
        string[5] memory rpcs = [
            "https://eth.drpc.org",
            "https://ethereum-rpc.publicnode.com",
            "https://cloudflare-eth.com",
            "https://rpc.ankr.com/eth",
            "https://eth.llamarpc.com"
        ];
        for (uint256 i; i < rpcs.length; ++i) {
            try vm.createSelectFork(rpcs[i]) {
                forked = true;
                console2.log("forked (head) via:", rpcs[i]);
                break;
            } catch {
                console2.log("rpc failed:", rpcs[i]);
            }
        }
        if (!forked) {
            console2.log("ALL public RPCs failed/ratelimited - skipping live-engine fork test");
            return;
        }
        require(LIVE_ENGINE.code.length != 0, "CollateralEngine not deployed on fork (unexpected)");
        require(WSTETH.code.length != 0, "wstETH not deployed on fork");

        wsteth = IWstEthTest(WSTETH);
        owner = vm.addr(OWNER_PK);

        // No admin prank, no setPool/setFeeds/setParams: constructed directly against the LIVE engine, which
        // is already fully configured on mainnet. Confirms the helper's constructor-time reads
        // (`COLLATERAL_ENGINE.WSTETH()`/`.POOL()`) resolve correctly against real deployed state.
        helper = new CbtcEscrowHelper(LIVE_ENGINE);
        // The deterministic CREATE address this lands on (a function of this test contract's own deploy nonce,
        // nothing to do with the helper or engine) can coincidentally already carry real, unrelated mainnet ETH
        // history on the forked chain — confirmed happening here (~5.77e14 wei) via an isolated probe. A real
        // deploy would never inherit stray balance like this, so pin the fixture to the clean start every other
        // "no ETH dust" assertion in this suite assumes.
        vm.deal(address(helper), 0);
        assertEq(address(helper.WSTETH()), WSTETH);
        assertEq(address(helper.COLLATERAL_ENGINE()), LIVE_ENGINE);
        // The real engine's live POOL — confirmed via cast against the reciprocal COLLATERAL_ENGINE() pointer.
        assertEq(address(helper.POOL()), 0x0000000098A73197B3255aD9db1ed8544410f5Ba);
    }

    function _stakeDirect(address who, uint256 ethIn) internal returns (uint256 got) {
        vm.deal(who, ethIn);
        uint256 before = wsteth.balanceOf(who);
        vm.prank(who);
        (bool ok,) = WSTETH.call{value: ethIn}("");
        require(ok, "direct stake failed");
        got = wsteth.balanceOf(who) - before;
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    function test_live_postEscrowWithETH_postsActualStakedAmount() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("live-outpoint-eth");
        uint256 ethIn = 3 ether;

        uint256 expected = _stakeDirect(address(0xFEED), ethIn);
        assertTrue(expected > 0 && expected < ethIn, "wstETH received should be less than ETH in (rate > 1)");

        vm.deal(depositor, ethIn);
        vm.prank(depositor);
        helper.postEscrowWithETH{value: ethIn}(outpoint);

        assertEq(helper.helperEscrowOf(outpoint, depositor), expected, "helper must credit the ACTUAL wstETH minted");
        assertEq(
            CollateralEngine(LIVE_ENGINE).escrowOf(outpoint, address(helper)),
            expected,
            "the REAL live engine must hold exactly the actual amount"
        );
        assertEq(CollateralEngine(LIVE_ENGINE).escrowTotal(outpoint), expected);
        assertEq(address(helper).balance, 0, "no ETH dust left in the helper");
        assertEq(wsteth.balanceOf(address(helper)), 0, "no wstETH left idle in the helper (all posted)");
    }

    function test_live_postEscrowWithPermit_creditsOriginalCaller() public {
        _skipUnlessForked();
        bytes32 outpoint = keccak256("live-outpoint-permit");
        uint256 amount = _stakeDirect(owner, 2 ether);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(helper), amount, wsteth.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wsteth.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);

        uint256 ownerBalBefore = wsteth.balanceOf(owner);
        vm.prank(owner);
        helper.postEscrowWithPermit(outpoint, amount, deadline, v, r, s);

        assertEq(wsteth.balanceOf(owner), ownerBalBefore - amount, "permit path must pull from the signer");
        assertEq(helper.helperEscrowOf(outpoint, owner), amount, "credited to the ORIGINAL signer, not the helper");
        assertEq(CollateralEngine(LIVE_ENGINE).escrowOf(outpoint, address(helper)), amount);
        assertEq(CollateralEngine(LIVE_ENGINE).escrowOf(outpoint, owner), 0);
    }

    function test_live_reclaimEscrow_returnsToOriginalDepositor() public {
        _skipUnlessForked();
        address depositor = address(0xD0F0);
        bytes32 outpoint = keccak256("live-outpoint-reclaim");
        vm.deal(depositor, 1 ether);
        vm.prank(depositor);
        helper.postEscrowWithETH{value: 1 ether}(outpoint);
        uint256 posted = helper.helperEscrowOf(outpoint, depositor);
        assertTrue(posted > 0);

        // Fresh outpoint the live pool has never seen -> cbtcMinted reads false live -> claimEscrow's release
        // condition (`!cbtcMinted`) is met on REAL pool storage, no stub involved.
        uint256 before = wsteth.balanceOf(depositor);
        vm.prank(depositor);
        helper.reclaimEscrow(outpoint);

        assertEq(wsteth.balanceOf(depositor), before + posted, "depositor recovers exactly its posted amount");
        assertEq(helper.helperEscrowOf(outpoint, depositor), 0);
        assertEq(CollateralEngine(LIVE_ENGINE).escrowOf(outpoint, address(helper)), 0);
    }

    function test_live_reclaimEscrow_noShareReverts() public {
        _skipUnlessForked();
        vm.expectRevert(CbtcEscrowHelper.NothingToRelease.selector);
        vm.prank(address(0xD0F0));
        helper.reclaimEscrow(keccak256("live-never-posted"));
    }

    /// Same "solves the funder-of-record problem" claim as the mock suite's version, but the engine-side
    /// combined balance being drained/reconstructed is REAL live `escrowOf`/`escrowTotal` storage on
    /// 0x000000008cAD17f5BB485A7D521E89A9C4716cC0, not a fresh instance of it.
    function test_live_reclaimEscrow_multiDepositor_sameOutpoint_eachGetsOwnShare() public {
        _skipUnlessForked();
        address a = address(0xA);
        address b = address(0xB);
        bytes32 outpoint = keccak256("live-outpoint-multi");

        vm.deal(a, 1 ether);
        vm.prank(a);
        helper.postEscrowWithETH{value: 1 ether}(outpoint);
        uint256 shareA = helper.helperEscrowOf(outpoint, a);

        vm.deal(b, 2 ether);
        vm.prank(b);
        helper.postEscrowWithETH{value: 2 ether}(outpoint);
        uint256 shareB = helper.helperEscrowOf(outpoint, b);

        assertEq(CollateralEngine(LIVE_ENGINE).escrowOf(outpoint, address(helper)), shareA + shareB);

        uint256 bBefore = wsteth.balanceOf(b);
        vm.prank(b);
        helper.reclaimEscrow(outpoint);
        assertEq(wsteth.balanceOf(b), bBefore + shareB);
        assertEq(CollateralEngine(LIVE_ENGINE).escrowOf(outpoint, address(helper)), 0);
        assertEq(wsteth.balanceOf(address(helper)), shareA);

        uint256 aBefore = wsteth.balanceOf(a);
        vm.prank(a);
        helper.reclaimEscrow(outpoint);
        assertEq(wsteth.balanceOf(a), aBefore + shareA);
        assertEq(wsteth.balanceOf(address(helper)), 0, "fully drained, nothing stuck");
    }

    function test_live_receive_rejectsDirectSendFromNonPool() public {
        _skipUnlessForked();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(helper).call{value: 1 ether}("");
        assertFalse(ok, "a bare direct ETH send from a random address must be rejected");
    }
}
