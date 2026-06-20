// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CollateralEngine, CdpLeg} from "../src/CollateralEngine.sol";

/// Minimal ConfidentialPool stand-in implementing the surface the engine reads.
contract MockPool {
    mapping(bytes32 => uint64) public cbtcLockVBtc;
    mapping(bytes32 => bool) public cbtcLockSpent;
    mapping(bytes32 => bool) public cbtcMinted;
    uint256 public cbtcBackingSats;
    address public cbtcToken; // what canonicalTokenFor resolves cBTC to (0 = not pool-registered)

    function setLock(bytes32 o, uint64 v) external {
        cbtcLockVBtc[o] = v;
    }

    function setSpent(bytes32 o, bool s) external {
        cbtcLockSpent[o] = s;
    }

    function setMinted(bytes32 o, bool m) external {
        cbtcMinted[o] = m;
    }

    function setBacking(uint256 b) external {
        cbtcBackingSats = b;
    }

    function setCanonicalToken(address t) external {
        cbtcToken = t;
    }

    function canonicalTokenFor(bytes32) external view returns (address) {
        return cbtcToken;
    }
}

/// Minimal ERC20 for the stranded-cBTC recovery path (just enough for SafeTransferLib.safeTransfer).
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// Minimal Chainlink AggregatorV3 returning a fixed, fresh answer.
contract MockFeed {
    int256 public ans;
    uint8 public immutable dec;
    uint256 public upAt; // fixed at construction so a vm.warp can make it stale

    constructor(int256 a, uint8 d) {
        ans = a;
        dec = d;
        upAt = block.timestamp;
    }

    function setAnswer(int256 a) external {
        ans = a;
        upAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        upAt = t;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, ans, upAt, upAt, 1);
    }
}

contract MockTwap {
    uint256 public price;
    uint8 public dec;

    constructor(uint256 p, uint8 d) {
        price = p;
        dec = d;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function twap() external view returns (uint256, uint8) {
        return (price, dec);
    }
}

contract CollateralEngineTest is Test {
    CollateralEngine eng;
    MockPool pool;
    MockFeed ethBtc; // 1 ETH = 0.05 BTC → answer 0.05e8
    MockFeed btcUsd; // 1 BTC = 60000 USD → answer 60000e8
    bytes32 constant CBTC = keccak256("tacit-cbtc-zk-lock-v1");
    address admin = address(0xA11CE);

    function setUp() public {
        pool = new MockPool();
        eng = new CollateralEngine(address(pool), CBTC, 8, 8, admin);
        ethBtc = new MockFeed(0.05e8, 8);
        btcUsd = new MockFeed(60000e8, 8);
        vm.prank(admin);
        eng.setFeeds(address(ethBtc), address(btcUsd), address(0), address(0));
    }

    function _legs(uint256 v) internal pure returns (CdpLeg[] memory legs) {
        legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: v});
    }

    function test_constructor_rejects_bad_config() public {
        vm.expectRevert(CollateralEngine.BadParams.selector);
        new CollateralEngine(address(0), bytes32(0), 8, 8, admin);

        vm.expectRevert(CollateralEngine.BadParams.selector);
        new CollateralEngine(address(0), bytes32(uint256(CBTC) ^ 1), 8, 8, admin);

        vm.expectRevert(CollateralEngine.BadParams.selector);
        new CollateralEngine(address(0), CBTC, 7, 8, admin);

        vm.expectRevert(CollateralEngine.BadParams.selector);
        new CollateralEngine(address(0), CBTC, 19, 8, admin);

        vm.expectRevert(CollateralEngine.BadParams.selector);
        new CollateralEngine(address(0), CBTC, 8, 19, admin);

        vm.expectRevert(CollateralEngine.BadParams.selector);
        new CollateralEngine(address(0), CBTC, 8, 8, address(0));

        vm.expectRevert(CollateralEngine.BadPool.selector);
        new CollateralEngine(address(0xBEEF), CBTC, 8, 8, admin);
    }

    function test_canonical_cbtc_id_is_pinned() public view {
        assertEq(eng.CANONICAL_CBTC_ASSET_ID(), CBTC);
        assertEq(eng.CANONICAL_CBTC_DECIMALS(), 8);
        assertEq(eng.CBTC_ASSET_ID(), CBTC);
        assertEq(eng.CBTC_DEC(), 8);
    }

    function test_setPool_once_breaks_circular_dep() public {
        // deploy with pool unknown (the real-deploy order: engine first), then wire it once.
        CollateralEngine e = new CollateralEngine(address(0), CBTC, 8, 8, admin);
        assertEq(address(e.POOL()), address(0));
        vm.prank(admin);
        e.setPool(address(pool));
        assertEq(address(e.POOL()), address(pool));
        // one-shot: re-set reverts
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.PoolAlreadySet.selector);
        e.setPool(address(0xdead));
        // fresh engine rejects zero/non-contract pool wires
        CollateralEngine e2 = new CollateralEngine(address(0), CBTC, 8, 8, admin);
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadPool.selector);
        e2.setPool(address(0));
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadPool.selector);
        e2.setPool(address(0xdead));
        // owner-only
        CollateralEngine e3 = new CollateralEngine(address(0), CBTC, 8, 8, admin);
        vm.expectRevert();
        e3.setPool(address(pool));
    }

    function test_setFeeds_rejects_bad_addresses_and_accepts_contract_twaps() public {
        MockTwap twap = new MockTwap(60000e8, 8);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadFeed.selector);
        eng.setFeeds(address(0), address(btcUsd), address(0), address(0));

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadFeed.selector);
        eng.setFeeds(address(0xBEEF), address(btcUsd), address(0), address(0));

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadFeed.selector);
        eng.setFeeds(address(ethBtc), address(btcUsd), address(0xBEEF), address(0));

        vm.prank(admin);
        eng.setFeeds(address(ethBtc), address(btcUsd), address(0), address(twap));
        assertEq(address(eng.btcUsdTwap()), address(twap));
    }

    function test_setParams_and_deviation_bounds() public {
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(0, 15000, 15000, 12500);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 9999, 15000, 12500);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 15000, 15000, 15000);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 15000, 15000, 9999);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setDeviationBound(10001);

        vm.prank(admin);
        eng.setParams(7200, 12000, 16000, 13000);
        assertEq(eng.maxStaleness(), 7200);
        assertEq(eng.escrowRatioBps(), 12000);
        assertEq(eng.cdpRatioBps(), 16000);
        assertEq(eng.liqRatioBps(), 13000);
    }

    function test_cusd_asset_id_is_controller_derived() public view {
        assertEq(eng.CUSD_ASSET_ID(), keccak256(abi.encodePacked("tacit-cdp-debt-v1", bytes20(uint160(address(eng))))));
    }

    function test_escrow_sizing_and_sufficiency() public {
        bytes32 o = keccak256("lock-1");
        uint64 vBtc = 1e8; // 1 BTC
        // 1 BTC at 0.05 BTC/ETH = 20 ETH; ×1.5 ratio = 30 ETH required.
        assertEq(eng.ethWeiForBtc(vBtc), 20 ether);
        assertEq(eng.requiredEscrow(vBtc), 30 ether);
        assertFalse(eng.escrowSufficient(o, vBtc));
        eng.postEscrow{value: 30 ether}(o);
        assertTrue(eng.escrowSufficient(o, vBtc));
        assertEq(eng.escrowOf(o), 30 ether);
    }

    function test_escrow_rejects_zero_empty_and_terminal_reposts() public {
        bytes32 o = keccak256("lock-terminal");

        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.postEscrow{value: 1 ether}(bytes32(0));

        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.postEscrow{value: 0}(o);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.releaseEscrow(bytes32(0), admin);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.NothingToRelease.selector);
        eng.releaseEscrow(o, admin);

        eng.postEscrow{value: 30 ether}(o);
        vm.prank(admin);
        eng.releaseEscrow(o, admin);
        assertFalse(eng.escrowSufficient(o, 1e8));

        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.postEscrow{value: 30 ether}(o);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.releaseEscrow(o, admin);
    }

    function test_slash_only_on_proven_unredeemed_rug() public {
        bytes32 o = keccak256("lock-2");
        eng.postEscrow{value: 30 ether}(o);
        // not minted / not spent → nothing to slash
        vm.expectRevert(CollateralEngine.NothingToSlash.selector);
        eng.slash(o);
        pool.setMinted(o, true);
        vm.expectRevert(CollateralEngine.NothingToSlash.selector); // minted but not spent
        eng.slash(o);
        pool.setSpent(o, true);
        eng.slash(o); // proven rug -> slashed into the protocol reserve
        assertEq(eng.escrowOf(o), 0);
        assertEq(eng.insuranceReserve(), 30 ether);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector); // one-shot
        eng.slash(o);
        assertFalse(eng.escrowSufficient(o, 1e8));
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.postEscrow{value: 1 ether}(o);
    }

    function test_released_escrow_not_slashable() public {
        bytes32 o = keccak256("lock-3");
        eng.postEscrow{value: 30 ether}(o);
        pool.setMinted(o, true);
        vm.prank(admin);
        eng.releaseEscrow(o, admin); // proven honest redeem
        pool.setSpent(o, true);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.slash(o);
    }

    function test_release_rejects_proven_minted_spent_lock_but_allows_unminted_spent_lock() public {
        bytes32 rugged = keccak256("lock-rugged");
        eng.postEscrow{value: 30 ether}(rugged);
        pool.setMinted(rugged, true);
        pool.setSpent(rugged, true);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.releaseEscrow(rugged, admin);

        eng.slash(rugged);
        assertEq(eng.insuranceReserve(), 30 ether);

        bytes32 unminted = keccak256("lock-unminted-spent");
        eng.postEscrow{value: 1 ether}(unminted);
        pool.setSpent(unminted, true);
        uint256 before = admin.balance;
        vm.prank(admin);
        eng.releaseEscrow(unminted, admin);
        assertEq(admin.balance, before + 1 ether);
    }

    function test_slash_requires_pool_and_nonzero_outpoint() public {
        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.slash(bytes32(0));

        CollateralEngine e = new CollateralEngine(address(0), CBTC, 8, 8, admin);
        vm.expectRevert(CollateralEngine.BadPool.selector);
        e.slash(keccak256("lock-no-pool"));
    }

    function test_onCdpMint_enforces_ratio_and_onlyPool() public {
        // 1 BTC collateral = 60000 cUSD value; max debt at 1.5× = 40000 cUSD (40000e8).
        CdpLeg[] memory legs = _legs(1e8);
        vm.expectRevert(CollateralEngine.NotPool.selector);
        eng.onCdpMint(legs, 40000e8, keccak256("p"));
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpMint(legs, 0, keccak256("p0"));
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadPositionLeaf.selector);
        eng.onCdpMint(legs, 40000e8, bytes32(0));
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadPositionLeaf.selector);
        eng.onCdpMint(legs, 40000e8, bytes32(uint256(1)));
        // exactly at the floor: ok
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p1"));
        assertEq(eng.outstandingCusd(), 40000e8);
        // a hair over the floor: undercollateralized
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpMint(legs, 40000e8 + 1, keccak256("p2"));
    }

    function test_onCdpMint_rejects_invalid_collateral_baskets() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: keccak256("not-cbtc"), value: 1e8});
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.NotCbtcCollateral.selector);
        eng.onCdpMint(legs, 1, keccak256("p"));

        CdpLeg[] memory empty = new CdpLeg[](0);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpMint(empty, 1, keccak256("empty"));

        CdpLeg[] memory zero = _legs(0);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpMint(zero, 1, keccak256("zero"));
    }

    function test_onCdpClose_decrements_and_reverts_on_accounting_underflow() public {
        CdpLeg[] memory legs = _legs(1e8); // 60000 USD collateral
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpClose(0, legs, keccak256("close-zero"));

        vm.prank(address(pool));
        eng.onCdpClose(10000e8, legs, keccak256("close-1"));
        assertEq(eng.outstandingCusd(), 30000e8);

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.DebtAccountingUnderflow.selector);
        eng.onCdpClose(30000e8 + 1, legs, keccak256("close-over"));
    }

    function test_onCdpLiquidate_reverts_if_healthy_and_decrements_when_unhealthy() public {
        CdpLeg[] memory legs = _legs(1e8); // 60000 USD collateral
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"));

        // healthy: debt small enough that collateral ≥ debt·liqRatio (1.25×). 40000 cUSD → 40000·1.25=50000 ≤ 60000 → healthy.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.PositionHealthy.selector);
        eng.onCdpLiquidate(legs, 40000e8, keccak256("p"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpLiquidate(legs, 0, keccak256("p-zero"));

        // Price moves down: 1 BTC collateral = 45000 cUSD, below the 50000 liquidation threshold.
        btcUsd.setAnswer(45000e8);
        vm.prank(address(pool));
        eng.onCdpLiquidate(legs, 40000e8, keccak256("p"));
        assertEq(eng.outstandingCusd(), 0);

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.DebtAccountingUnderflow.selector);
        eng.onCdpLiquidate(legs, 1, keccak256("p-over"));
    }

    function test_onCdpTopup_requires_real_improvement_and_restores_mint_floor() public {
        CdpLeg[] memory oldLegs = _legs(1e8); // 60000 USD collateral
        CdpLeg[] memory sameLegs = _legs(1e8);
        CdpLeg[] memory tooSmall = _legs(11e7); // 66000 USD collateral, below 1.5x for 50000 debt
        CdpLeg[] memory topped = _legs(2e8); // 120000 USD collateral

        vm.expectRevert(CollateralEngine.NotPool.selector);
        eng.onCdpTopup(oldLegs, topped, 50000e8, keccak256("old-nu"), keccak256("new-leaf"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpTopup(oldLegs, topped, 0, keccak256("old-nu"), keccak256("new-leaf"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadPositionLeaf.selector);
        eng.onCdpTopup(oldLegs, topped, 50000e8, keccak256("old-nu"), bytes32(0));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpTopup(oldLegs, sameLegs, 50000e8, keccak256("old-nu"), keccak256("same-leaf"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpTopup(oldLegs, tooSmall, 50000e8, keccak256("old-nu"), keccak256("small-leaf"));

        vm.prank(address(pool));
        eng.onCdpTopup(oldLegs, topped, 50000e8, keccak256("old-nu"), keccak256("new-leaf"));
        assertEq(eng.outstandingCusd(), 0);
    }

    function test_stale_feed_fails_closed() public {
        // advance time past staleness with a feed that never updates updatedAt beyond setUp's block.
        vm.warp(block.timestamp + 7200);
        vm.expectRevert(CollateralEngine.StaleFeed.selector);
        eng.requiredEscrow(1e8);
    }

    function test_future_feed_timestamp_fails_closed() public {
        btcUsd.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert(CollateralEngine.StaleFeed.selector);
        eng.btcToUsd(1e8);
    }

    function test_twap_deviation_bound_fails_closed() public {
        MockTwap badBtcUsdTwap = new MockTwap(50000e8, 8);

        vm.prank(admin);
        eng.setFeeds(address(ethBtc), address(btcUsd), address(0), address(badBtcUsdTwap));
        vm.prank(admin);
        eng.setDeviationBound(500); // 5%

        vm.expectRevert(CollateralEngine.FeedDeviation.selector);
        eng.btcToUsd(1e8);

        badBtcUsdTwap.setPrice(60000e8);
        assertEq(eng.btcToUsd(1e8), 60000e8);
    }

    function test_insurance_reserve_accounting() public {
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.fundInsurance{value: 0}();

        eng.fundInsurance{value: 2 ether}();
        assertEq(eng.insuranceReserve(), 2 ether);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.drawInsurance(0, admin);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.InsufficientReserve.selector);
        eng.drawInsurance(3 ether, admin);

        uint256 before = admin.balance;
        vm.prank(admin);
        eng.drawInsurance(1 ether, admin);
        assertEq(eng.insuranceReserve(), 1 ether);
        assertEq(admin.balance, before + 1 ether);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadPurpose.selector);
        eng.drawInsuranceFor(bytes32(0), 1, admin);

        before = admin.balance;
        vm.prank(admin);
        eng.drawInsuranceFor(keccak256("CDP_BAD_DEBT"), 1 ether, admin);
        assertEq(eng.insuranceReserve(), 0);
        assertEq(admin.balance, before + 1 ether);
    }

    function test_zero_recipients_revert() public {
        bytes32 o = keccak256("lock-zero-recipient");
        eng.postEscrow{value: 1 ether}(o);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.ZeroRecipient.selector);
        eng.releaseEscrow(o, address(0));

        eng.fundInsurance{value: 1 ether}();
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.ZeroRecipient.selector);
        eng.drawInsurance(1 ether, address(0));
    }

    // If cBTC is explicitly/accidentally paid to the engine, recoverSeizedCbtc is the ONLY way it leaves,
    // scoped to exactly the pool-resolved cBTC token (never an arbitrary balance), and never touches the
    // native-ETH escrow/insurance (those leave only via release/draw).
    function test_recoverSeizedCbtc_routes_only_the_pool_resolved_token() public {
        MockERC20 cbtc = new MockERC20();
        pool.setCanonicalToken(address(cbtc));
        cbtc.mint(address(eng), 5e18); // explicit engine-recipient payout

        // also hold native ETH (escrow + insurance) — recovery must leave it untouched.
        eng.postEscrow{value: 30 ether}(keccak256("untouched-escrow"));
        eng.fundInsurance{value: 2 ether}();
        uint256 ethBefore = address(eng).balance;

        address dao = address(0xDA0);
        // guards
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.ZeroRecipient.selector);
        eng.recoverSeizedCbtc(1e18, address(0));
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.recoverSeizedCbtc(0, dao);
        // owner-only
        vm.expectRevert();
        eng.recoverSeizedCbtc(1e18, dao);

        // happy: the DAO moves stranded cBTC into the recovery destination
        vm.prank(admin);
        eng.recoverSeizedCbtc(5e18, dao);
        assertEq(cbtc.balanceOf(dao), 5e18);
        assertEq(cbtc.balanceOf(address(eng)), 0);
        assertEq(address(eng).balance, ethBefore); // ETH escrow/insurance untouched
        assertEq(eng.insuranceReserve(), 2 ether);
    }

    function test_recoverSeizedCbtc_reverts_when_cbtc_not_pool_registered() public {
        // pool resolves cBTC to address(0), so no public cBTC withdrawal could have paid this engine.
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.NotCbtcCollateral.selector);
        eng.recoverSeizedCbtc(1e18, address(0xDA0));
    }
}
