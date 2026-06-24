// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CollateralEngine, CdpLeg} from "../src/CollateralEngine.sol";

/// Minimal ConfidentialPool stand-in implementing the surface the engine reads.
contract MockPool {
    mapping(bytes32 => uint64) public cbtcLockVBtc;
    mapping(bytes32 => bool) public cbtcLockSpent;
    mapping(bytes32 => bool) public cbtcLockRedeemed;
    mapping(bytes32 => bool) public cbtcMinted;
    uint256 public cbtcBackingSats;
    address public cbtcToken; // what canonicalTokenFor resolves cBTC to (0 = not pool-registered)

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
    uint256 constant RAY = 1e27;
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

    bytes32 constant RECEIPT = bytes32(uint256(1)); // the TSR savings receipt sentinel (positionLeaf == 1)

    /// A TSR bond/harvest receipt op's legs = [shares (cUSD), rps_entry].
    function _savingsLegs(bytes32 cusd, uint256 shares, uint256 rpsEntry) internal pure returns (CdpLeg[] memory legs) {
        legs = new CdpLeg[](2);
        legs[0] = CdpLeg({asset: cusd, value: shares});
        legs[1] = CdpLeg({asset: bytes32(0), value: rpsEntry});
    }

    function _single(bytes32 asset, uint256 v) internal pure returns (CdpLeg[] memory legs) {
        legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: asset, value: v});
    }

    /// Open a cUSD CDP, turn the fee on, accrue a year, and close it — collecting a stability fee that
    /// `_accrueFee` splits to current TSR savers. Returns the fee collected.
    function _feeFromCdp() internal returns (uint256 fee) {
        vm.prank(address(pool));
        eng.onCdpMint(_legs(1e8), 40000e8, keccak256("fee-cdp"), RAY);
        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19);
        vm.warp(block.timestamp + 365 days);
        btcUsd.setUpdatedAt(block.timestamp);
        uint256 owed = eng.currentDebt(40000e8, RAY);
        fee = owed - 40000e8;
        vm.prank(address(pool));
        eng.onCdpClose(40000e8, owed, RAY, _legs(1e8), keccak256("fee-cdp"));
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
        new CollateralEngine(address(0), CBTC, 8, 9, admin);

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

        // upper ceilings: staleness > 1 day, escrow ratio > 10x, cdp ratio > 10x all revert (fat-finger guard)
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(1 days + 1, 15000, 15000, 12500);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 100_001, 15000, 12500);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 15000, 100_001, 12500);

        // the ceilings themselves are accepted (boundary)
        vm.prank(admin);
        eng.setParams(1 days, 100_000, 100_000, 99_999);
        assertEq(eng.maxStaleness(), 1 days);
        assertEq(eng.cdpRatioBps(), 100_000);

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
        assertEq(eng.escrowOf(o, address(this)), 30 ether, "per-funder share");
        assertEq(eng.escrowTotal(o), 30 ether, "outpoint total");
    }

    function test_escrow_rejects_zero_empty_and_terminal_reposts() public {
        bytes32 o = keccak256("lock-terminal");

        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.postEscrow{value: 1 ether}(bytes32(0));

        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.postEscrow{value: 0}(o);

        // claim guards: zero outpoint and nothing posted by the caller
        vm.expectRevert(CollateralEngine.BadEscrow.selector);
        eng.claimEscrow(bytes32(0));
        vm.expectRevert(CollateralEngine.NothingToRelease.selector);
        eng.claimEscrow(o);

        // a SLASHED outpoint is terminal: no re-post, and the stale share is unclaimable
        eng.postEscrow{value: 30 ether}(o);
        pool.setMinted(o, true);
        pool.setSpent(o, true);
        eng.slash(o);
        assertFalse(eng.escrowSufficient(o, 1e8));
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.postEscrow{value: 30 ether}(o);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.claimEscrow(o);

        bytes32 redeemed = keccak256("lock-redeemed-terminal");
        pool.setRedeemed(redeemed, true);
        assertFalse(eng.escrowSufficient(redeemed, 1e8));
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.postEscrow{value: 30 ether}(redeemed);

        bytes32 spent = keccak256("lock-spent-terminal");
        pool.setSpent(spent, true);
        assertFalse(eng.escrowSufficient(spent, 1e8));
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.postEscrow{value: 30 ether}(spent);
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
        assertEq(eng.escrowTotal(o), 0);
        assertEq(eng.insuranceReserve(), 30 ether);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector); // one-shot
        eng.slash(o);
        assertFalse(eng.escrowSufficient(o, 1e8));
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.postEscrow{value: 1 ether}(o);
    }

    address constant ALICE = address(0xA11CE5);
    address constant BOB = address(0xB0B);

    /// A reflection-PROVEN redeem (mutually exclusive with a rug spend) lets the funder reclaim its share
    /// permissionlessly (no owner); the retired lock is never spent, so there is nothing to slash.
    function test_redeemed_escrow_is_claimable_not_slashable() public {
        vm.deal(ALICE, 100 ether);
        bytes32 o = keccak256("lock-redeemed");
        vm.prank(ALICE);
        eng.postEscrow{value: 30 ether}(o);
        pool.setMinted(o, true);
        pool.setRedeemed(o, true); // honest redeem proven by the reflection
        assertFalse(eng.escrowSufficient(o, 1e8), "redeemed lock cannot back a fresh mint");

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        eng.claimEscrow(o);
        assertEq(ALICE.balance, before + 30 ether, "funder reclaimed its share, no owner involved");
        assertEq(eng.escrowTotal(o), 0);
        vm.expectRevert(CollateralEngine.NothingToSlash.selector); // retired lock, never spent
        eng.slash(o);
    }

    /// A proven rug (minted ∧ spent, NOT redeemed) cannot be claimed — it is slashed to the reserve. An
    /// un-minted escrow is reclaimable by its funder (no cBTC was ever backed by it).
    function test_claim_blocked_on_rug_allowed_when_unminted() public {
        vm.deal(ALICE, 100 ether);

        bytes32 rugged = keccak256("lock-rugged");
        vm.prank(ALICE);
        eng.postEscrow{value: 30 ether}(rugged);
        pool.setMinted(rugged, true);
        pool.setSpent(rugged, true);
        vm.prank(ALICE);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.claimEscrow(rugged);
        eng.slash(rugged);
        assertEq(eng.insuranceReserve(), 30 ether);

        bytes32 unminted = keccak256("lock-unminted");
        vm.prank(ALICE);
        eng.postEscrow{value: 1 ether}(unminted);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        eng.claimEscrow(unminted); // never minted → reclaimable
        assertEq(ALICE.balance, before + 1 ether);
    }

    /// While the escrow backs OUTSTANDING cBTC (minted ∧ not-yet-redeemed) it is locked; the proven
    /// redemption is what unlocks it.
    function test_claim_blocked_while_backing_outstanding_cbtc() public {
        vm.deal(ALICE, 100 ether);
        bytes32 o = keccak256("lock-live");
        vm.prank(ALICE);
        eng.postEscrow{value: 30 ether}(o);
        pool.setMinted(o, true); // minted, not yet redeemed → locked
        vm.prank(ALICE);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.claimEscrow(o);
        pool.setRedeemed(o, true); // proven redemption unlocks it
        vm.prank(ALICE);
        eng.claimEscrow(o);
        assertEq(eng.escrowTotal(o), 0);
    }

    /// Per-funder shares: each funder reclaims exactly its own; neither can take the other's, no double-claim,
    /// and a non-funder gets nothing.
    function test_claim_per_funder_shares() public {
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        bytes32 o = keccak256("lock-shared");
        vm.prank(ALICE);
        eng.postEscrow{value: 20 ether}(o);
        vm.prank(BOB);
        eng.postEscrow{value: 10 ether}(o);
        assertEq(eng.escrowTotal(o), 30 ether);
        assertEq(eng.escrowOf(o, ALICE), 20 ether);
        assertEq(eng.escrowOf(o, BOB), 10 ether);
        pool.setRedeemed(o, true);

        vm.prank(address(0xC0FFEE)); // a non-funder
        vm.expectRevert(CollateralEngine.NothingToRelease.selector);
        eng.claimEscrow(o);

        uint256 aBefore = ALICE.balance;
        vm.prank(ALICE);
        eng.claimEscrow(o);
        assertEq(ALICE.balance, aBefore + 20 ether, "alice reclaimed only her share");
        assertEq(eng.escrowTotal(o), 10 ether, "bob's share remains");
        vm.prank(ALICE);
        vm.expectRevert(CollateralEngine.NothingToRelease.selector); // no double-claim
        eng.claimEscrow(o);

        uint256 bBefore = BOB.balance;
        vm.prank(BOB);
        eng.claimEscrow(o);
        assertEq(BOB.balance, bBefore + 10 ether);
        assertEq(eng.escrowTotal(o), 0);
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
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpMint(legs, 0, keccak256("p0"), RAY);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadPositionLeaf.selector);
        eng.onCdpMint(legs, 40000e8, bytes32(0), RAY); // positionLeaf == 0 (bare payout) still rejected
        // positionLeaf == 1 is now the TSR savings receipt: a CDP-shaped (1-leg, non-cUSD) basket is a malformed
        // savings op, not a CDP mint.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSavingsShape.selector);
        eng.onCdpMint(legs, 40000e8, bytes32(uint256(1)), RAY);
        // exactly at the floor: ok
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p1"), RAY);
        assertEq(eng.outstandingCusd(), 40000e8);
        // a hair over the floor: undercollateralized
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpMint(legs, 40000e8 + 1, keccak256("p2"), RAY);
    }

    function test_onCdpMint_rejects_invalid_collateral_baskets() public {
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: keccak256("not-cbtc"), value: 1e8});
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.NotCbtcCollateral.selector);
        eng.onCdpMint(legs, 1, keccak256("p"), RAY);

        CdpLeg[] memory empty = new CdpLeg[](0);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpMint(empty, 1, keccak256("empty"), RAY);

        CdpLeg[] memory zero = _legs(0);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpMint(zero, 1, keccak256("zero"), RAY);
    }

    function test_onCdpClose_decrements_and_reverts_on_accounting_underflow() public {
        CdpLeg[] memory legs = _legs(1e8); // 60000 USD collateral
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);

        // principal == 0 is now a TSR unbond; a non-cUSD basket is a malformed unbond, not a CDP close.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSavingsShape.selector);
        eng.onCdpClose(0, 0, RAY, legs, keccak256("close-zero"));

        vm.prank(address(pool));
        eng.onCdpClose(10000e8, 10000e8, RAY, legs, keccak256("close-1"));
        assertEq(eng.outstandingCusd(), 30000e8);

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.DebtAccountingUnderflow.selector);
        eng.onCdpClose(30000e8 + 1, 30000e8 + 1, RAY, legs, keccak256("close-over"));
    }

    function test_onCdpLiquidate_reverts_if_healthy_and_decrements_when_unhealthy() public {
        CdpLeg[] memory legs = _legs(1e8); // 60000 USD collateral
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);

        // healthy: debt small enough that collateral ≥ debt·liqRatio (1.25×). 40000 cUSD → 40000·1.25=50000 ≤ 60000 → healthy.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.PositionHealthy.selector);
        eng.onCdpLiquidate(legs, 40000e8, 40000e8, RAY, keccak256("p"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpLiquidate(legs, 0, 0, RAY, keccak256("p-zero"));

        // Price moves down: 1 BTC collateral = 45000 cUSD, below the 50000 liquidation threshold.
        btcUsd.setAnswer(45000e8);
        vm.prank(address(pool));
        eng.onCdpLiquidate(legs, 40000e8, 40000e8, RAY, keccak256("p"));
        assertEq(eng.outstandingCusd(), 0);

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.DebtAccountingUnderflow.selector);
        eng.onCdpLiquidate(legs, 1, 1, RAY, keccak256("p-over"));
    }

    function test_onCdpTopup_requires_real_improvement_and_restores_mint_floor() public {
        CdpLeg[] memory oldLegs = _legs(1e8); // 60000 USD collateral
        CdpLeg[] memory sameLegs = _legs(1e8);
        CdpLeg[] memory tooSmall = _legs(11e7); // 66000 USD collateral, below 1.5x for 50000 debt
        CdpLeg[] memory topped = _legs(2e8); // 120000 USD collateral

        vm.expectRevert(CollateralEngine.NotPool.selector);
        eng.onCdpTopup(oldLegs, topped, 50000e8, RAY, keccak256("old-nu"), keccak256("new-leaf"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.onCdpTopup(oldLegs, topped, 0, RAY, keccak256("old-nu"), keccak256("new-leaf"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadPositionLeaf.selector);
        eng.onCdpTopup(oldLegs, topped, 50000e8, RAY, keccak256("old-nu"), bytes32(0));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpTopup(oldLegs, sameLegs, 50000e8, RAY, keccak256("old-nu"), keccak256("same-leaf"));

        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpTopup(oldLegs, tooSmall, 50000e8, RAY, keccak256("old-nu"), keccak256("small-leaf"));

        vm.prank(address(pool));
        eng.onCdpTopup(oldLegs, topped, 50000e8, RAY, keccak256("old-nu"), keccak256("new-leaf"));
        assertEq(eng.outstandingCusd(), 0);
    }

    // ─────────────────────── cUSD stability fee (TSR) ───────────────────────

    function test_stabilityFee_dormant_by_default_is_interest_free() public {
        // Ships dormant: rate == RAY, fee == 0. A position's debt is exactly its principal forever, even after
        // time passes and drip() runs — provably identical to the interest-free path.
        assertEq(eng.rate(), RAY, "rate starts at 1.0");
        assertEq(eng.stabilityFeePerSecond(), 0, "fee dormant by default");
        assertEq(eng.currentDebt(40000e8, RAY), 40000e8, "owed == principal at t0");
        vm.warp(block.timestamp + 3650 days);
        eng.drip();
        assertEq(eng.rate(), RAY, "rate never moves while dormant");
        assertEq(eng.currentDebt(40000e8, RAY), 40000e8, "owed still == principal after a decade");
        btcUsd.setUpdatedAt(block.timestamp); // refresh the oracle past the long warp (it fail-closes on staleness)
        // dormant: the floor is the principal (underpay reverts); a rational borrower burns exactly it, so no
        // fee accrues. The 1% over-repay ceiling exists only to absorb active-fee drip drift.
        CdpLeg[] memory legs = _legs(1e8);
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadRepayment.selector);
        eng.onCdpClose(40000e8, 40000e8 - 1, RAY, legs, keccak256("p")); // underpay the principal → revert
        vm.prank(address(pool));
        eng.onCdpClose(40000e8, 40000e8, RAY, legs, keccak256("p")); // exactly the principal → ok, fee 0
        assertEq(eng.feesAccruedCusd(), 0, "no fee accrues while dormant");
    }

    function test_setStabilityFee_onlyOwner_and_bounded() public {
        vm.expectRevert(); // not owner
        eng.setStabilityFee(RAY);
        // below 1.0 (but non-zero) and above the sanity ceiling are rejected; 0, RAY, and the cap are ok.
        vm.startPrank(admin);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setStabilityFee(RAY - 1);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setStabilityFee(RAY + 1e20 + 1);
        eng.setStabilityFee(0);
        eng.setStabilityFee(RAY);
        eng.setStabilityFee(RAY + 1e20); // exactly the cap
        eng.setStabilityFee(RAY + 1e19);
        vm.stopPrank();
        assertEq(eng.stabilityFeePerSecond(), RAY + 1e19);
    }

    function test_currentDebt_rejects_subunit_snapshot() public {
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.currentDebt(40000e8, RAY - 1);
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.currentDebt(40000e8, RAY + 1);
    }

    function test_drip_compounds_rate_only_when_active() public {
        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19); // ~37%/yr at this per-second factor
        uint256 r0 = eng.rate();
        vm.warp(block.timestamp + 365 days);
        eng.drip();
        uint256 r1 = eng.rate();
        assertGt(r1, r0, "rate compounds forward under an active fee");
        assertLt(r1, 2 * RAY, "and stays in a sane band over a year");
        // idempotent within a block
        eng.drip();
        assertEq(eng.rate(), r1, "drip is a no-op at the same timestamp");
    }

    function test_active_fee_close_demands_accrued_repayment_and_funds_tsr() public {
        CdpLeg[] memory legs = _legs(1e8); // 60000 cUSD collateral
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY); // snapshot == RAY (rate at mint)

        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19);
        vm.warp(block.timestamp + 365 days);

        uint256 owed = eng.currentDebt(40000e8, RAY);
        assertGt(owed, 40000e8, "debt accrued past principal");

        // repaying only the principal is now insufficient — the close demands the accrued debt.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadRepayment.selector);
        eng.onCdpClose(40000e8, 40000e8, RAY, legs, keccak256("p"));

        // repaying exactly the accrued debt closes it; the fee (= owed − principal) funds the TSR budget.
        vm.prank(address(pool));
        eng.onCdpClose(40000e8, owed, RAY, legs, keccak256("p"));
        assertEq(eng.outstandingCusd(), 0, "principal cleared from outstanding");
        assertEq(eng.feeBudgetCusd(), owed - 40000e8, "fee captured into the re-mint budget");
        assertEq(eng.feesAccruedCusd(), owed - 40000e8, "cumulative fee tracked");
    }

    function test_active_fee_close_tolerates_prove_to_settle_drift() public {
        // Once the fee is active, `rate` drips every second, so the prover cannot hit the settle-time `owed`
        // exactly. The close accepts the accrued debt plus a small over-repay band, so a borrower burns a hair
        // more (covering the prove→settle drift) and settles; the excess funds the savers.
        CdpLeg[] memory legs = _legs(1e8);
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);
        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19);
        vm.warp(block.timestamp + 365 days);
        btcUsd.setUpdatedAt(block.timestamp);
        uint256 owed = eng.currentDebt(40000e8, RAY);

        // below the accrued debt (a stale prove-time amount that didn't cover the drift) → reverts
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadRepayment.selector);
        eng.onCdpClose(40000e8, owed - 1, RAY, legs, keccak256("p"));
        // above the 1% band (fat-finger over-burn) → reverts
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadRepayment.selector);
        eng.onCdpClose(40000e8, owed + owed / 100 + 1, RAY, legs, keccak256("p"));
        // a small over-repay inside the band → settles; the whole excess (interest + buffer) funds savers
        uint256 overRepay = owed + owed / 200; // +0.5%
        vm.prank(address(pool));
        eng.onCdpClose(40000e8, overRepay, RAY, legs, keccak256("p"));
        assertEq(eng.outstandingCusd(), 0);
        assertEq(eng.feeBudgetCusd(), overRepay - 40000e8, "interest + over-burn all fund the savings budget");
    }

    function test_active_fee_liquidate_tolerates_drift_band() public {
        CdpLeg[] memory legs = _legs(1e8);
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);
        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19);
        vm.warp(block.timestamp + 365 days);
        btcUsd.setUpdatedAt(block.timestamp);
        uint256 owed = eng.currentDebt(40000e8, RAY);
        // below the accrued debt → reverts; a small in-band over-repay seizes the basket
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadRepayment.selector);
        eng.onCdpLiquidate(legs, 40000e8, owed - 1, RAY, keccak256("p"));
        vm.prank(address(pool));
        eng.onCdpLiquidate(legs, 40000e8, owed + owed / 200, RAY, keccak256("p"));
        assertEq(eng.outstandingCusd(), 0);
    }

    function test_active_fee_makes_a_flat_position_liquidatable() public {
        CdpLeg[] memory legs = _legs(1e8); // 60000 cUSD collateral, flat
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);

        // Healthy at principal: 40000·1.25 = 50000 ≤ 60000.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.PositionHealthy.selector);
        eng.onCdpLiquidate(legs, 40000e8, 40000e8, RAY, keccak256("p"));

        // Same collateral, but the stability fee accrues the debt past the liquidation threshold.
        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19);
        vm.warp(block.timestamp + 365 days);
        btcUsd.setUpdatedAt(block.timestamp); // refresh oracle past the warp
        uint256 owed = eng.currentDebt(40000e8, RAY);
        assertGt(owed * 12500, 60000e8 * 10000, "accrued debt is now below the 1.25x liq ratio");

        // a stale (principal) repayment is rejected; liquidating at the accrued debt seizes the basket.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadRepayment.selector);
        eng.onCdpLiquidate(legs, 40000e8, 40000e8, RAY, keccak256("p"));
        vm.prank(address(pool));
        eng.onCdpLiquidate(legs, 40000e8, owed, RAY, keccak256("p"));
        assertEq(eng.outstandingCusd(), 0);
        assertEq(eng.feeBudgetCusd(), owed - 40000e8, "liquidation fee also funds the TSR");
    }

    function test_mint_rejects_future_or_subunit_snapshot() public {
        CdpLeg[] memory legs = _legs(1e8);
        // a FUTURE snapshot (> current rate) would let a borrower dodge accrued fees — barred.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.onCdpMint(legs, 40000e8, keccak256("future"), RAY + 1);
        // a snapshot below 1.0 is nonsensical (and would mis-scale owed) — barred.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.onCdpMint(legs, 40000e8, keccak256("sub"), RAY - 1);
        // a valid (stale-or-current) snapshot is accepted.
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("ok"), RAY);
    }

    function test_close_liquidate_and_topup_reject_bad_snapshots() public {
        CdpLeg[] memory legs = _legs(1e8);
        vm.prank(address(pool));
        eng.onCdpMint(legs, 40000e8, keccak256("p"), RAY);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.onCdpClose(40000e8, 40000e8, RAY - 1, legs, keccak256("p"));
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.onCdpClose(40000e8, 40000e8, RAY + 1, legs, keccak256("p"));
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.onCdpLiquidate(legs, 40000e8, 40000e8, RAY + 1, keccak256("p"));
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSnapshot.selector);
        eng.onCdpTopup(legs, _legs(2e8), 40000e8, RAY + 1, keccak256("p"), keccak256("new"));
    }

    function test_active_fee_topup_health_uses_accrued_debt() public {
        CdpLeg[] memory oldLegs = _legs(1e8); // 60000 collateral
        vm.prank(address(pool));
        eng.onCdpMint(oldLegs, 40000e8, keccak256("p"), RAY);

        vm.prank(admin);
        eng.setStabilityFee(RAY + 1e19);
        vm.warp(block.timestamp + 365 days);
        btcUsd.setUpdatedAt(block.timestamp); // refresh oracle past the warp
        uint256 owed = eng.currentDebt(40000e8, RAY);

        // A top-up that adds collateral but does not cover the ACCRUED debt at 1.5x is rejected — a dust
        // top-up cannot roll an interest-eroded position out of range.
        uint256 needSats = (owed * 15000 / 10000) * 1e8 / 60000e8; // sats whose USD == owed·1.5
        CdpLeg[] memory tooSmall = _legs(needSats - 1e6);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.Undercollateralized.selector);
        eng.onCdpTopup(oldLegs, tooSmall, 40000e8, RAY, keccak256("p"), keccak256("new"));
        // Enough collateral to cover the accrued debt at the mint floor is accepted.
        CdpLeg[] memory enough = _legs(needSats + 1e7);
        vm.prank(address(pool));
        eng.onCdpTopup(oldLegs, enough, 40000e8, RAY, keccak256("p"), keccak256("new"));
    }

    // ─────────────────────── cUSD savings rate (TSR) ───────────────────────

    function test_tsr_bond_fee_harvest_unbond_lifecycle() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        // saver bonds 1000 cUSD at the live rps (0, dormant)
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY);
        assertEq(eng.totalSavingsShares(), 1000e8, "shares staked");
        assertEq(eng.savingsRps(), 0, "no rps before any fee");

        uint256 fee = _feeFromCdp(); // a fee is collected and split to the sole saver
        assertEq(eng.feeBudgetCusd(), fee, "fee captured into the budget");
        assertGt(eng.savingsRps(), 0, "rps grew from the fee");

        uint256 reward = eng.pendingSavingsReward(1000e8, 0);
        assertApproxEqAbs(reward, fee, 1e8, "sole saver entitled to ~the whole fee");
        assertLe(reward, fee, "entitlement never exceeds the fee");

        // harvest mints `reward` cUSD (the guest pushed the note); the engine consumes the budget by exactly it
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), reward, RECEIPT, RAY);
        assertEq(eng.feeBudgetCusd(), fee - reward, "budget consumed by exactly the reward");
        assertEq(eng.totalSavingsShares(), 1000e8, "harvest keeps principal staked");

        // unbond releases the staked cUSD
        vm.prank(address(pool));
        eng.onCdpClose(0, 0, RAY, _single(cusd, 1000e8), keccak256("unbond"));
        assertEq(eng.totalSavingsShares(), 0, "shares released");
    }

    function test_tsr_dormant_pays_nothing() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY);
        // dormant: open + close a CDP with NO fee → no savings reward accrues
        vm.prank(address(pool));
        eng.onCdpMint(_legs(1e8), 40000e8, keccak256("c"), RAY);
        vm.prank(address(pool));
        eng.onCdpClose(40000e8, 40000e8, RAY, _legs(1e8), keccak256("c"));
        assertEq(eng.savingsRps(), 0, "no fee, no rps");
        assertEq(eng.pendingSavingsReward(1000e8, 0), 0, "saver earns nothing while dormant");
    }

    function test_tsr_bond_rejects_stale_rps_and_accepts_future_entry() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY);
        _feeFromCdp();
        uint256 live = eng.savingsRps();
        assertGt(live, 0, "fee advanced rps");
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.SavingsEntryNotLive.selector);
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY); // stale entry backdates rewards
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, live), 0, RECEIPT, RAY);
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, live + 1), 0, RECEIPT, RAY);
    }

    function test_tsr_harvest_cannot_overclaim_entitlement() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY);
        _feeFromCdp();
        uint256 reward = eng.pendingSavingsReward(1000e8, 0);
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.SavingsOverClaim.selector);
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), reward + 1, RECEIPT, RAY); // one over entitlement
    }

    function test_tsr_harvest_cannot_exceed_remaining_fee_budget() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY);
        _feeFromCdp();
        uint256 reward = eng.pendingSavingsReward(1000e8, 0);

        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), reward, RECEIPT, RAY);

        uint256 remaining = eng.feeBudgetCusd();
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.SavingsOverClaim.selector);
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), remaining + 1, RECEIPT, RAY);
    }

    function test_tsr_no_savers_fee_is_not_distributed() public {
        uint256 fee = _feeFromCdp(); // no savers bonded
        assertEq(eng.savingsRps(), 0, "no savers -> rps stays flat");
        assertEq(eng.feeBudgetCusd(), fee, "fee still captured (un-attributed, never minted)");
    }

    function test_tsr_fee_splits_pro_rata() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        // two savers staking 3:1
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 750e8, 0), 0, RECEIPT, RAY);
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 250e8, 0), 0, RECEIPT, RAY);
        uint256 fee = _feeFromCdp();
        uint256 r1 = eng.pendingSavingsReward(750e8, 0);
        uint256 r2 = eng.pendingSavingsReward(250e8, 0);
        assertApproxEqRel(r1, r2 * 3, 1e15, "rewards split with the stake (3:1)"); // within 0.1%
        assertLe(r1 + r2, fee, "total saver entitlement never exceeds the fee collected");
    }

    function test_tsr_unbond_rejects_non_cusd_or_oversized() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY);
        // A savings unbond is principal-only; any burned repayment belongs on a real CDP close, where it is
        // accounted into the fee budget.
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSavingsShape.selector);
        eng.onCdpClose(0, 1, RAY, _single(cusd, 1000e8), keccak256("u-repaid"));
        // releasing a non-cUSD asset is a malformed unbond
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSavingsShape.selector);
        eng.onCdpClose(0, 0, RAY, _single(CBTC, 1000e8), keccak256("u"));
        // releasing more than staked is rejected
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.BadSavingsShape.selector);
        eng.onCdpClose(0, 0, RAY, _single(cusd, 1000e8 + 1), keccak256("u"));
    }

    // The core no-inflation invariant across many interleaved fee/harvest rounds: the savings vault never
    // mints more cUSD than was collected as fees, and the budget always equals the un-harvested remainder.
    function test_tsr_cumulative_harvest_never_exceeds_fees() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 600e8, 0), 0, RECEIPT, RAY); // saver A
        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 400e8, 0), 0, RECEIPT, RAY); // saver B (3:2)

        uint256 totalFees;
        uint256 totalHarvested;
        uint256 entryA; // each saver's rps checkpoint, advanced on harvest like the guest's new receipt
        uint256 entryB;
        for (uint256 round = 0; round < 3; round++) {
            totalFees += _feeFromCdp();
            uint256 rps = eng.savingsRps();
            uint256 rA = eng.pendingSavingsReward(600e8, entryA);
            if (rA > 0) {
                vm.prank(address(pool));
                eng.onCdpMint(_savingsLegs(cusd, 600e8, entryA), rA, RECEIPT, RAY);
                totalHarvested += rA;
                entryA = rps;
            }
            uint256 rB = eng.pendingSavingsReward(400e8, entryB);
            if (rB > 0) {
                vm.prank(address(pool));
                eng.onCdpMint(_savingsLegs(cusd, 400e8, entryB), rB, RECEIPT, RAY);
                totalHarvested += rB;
                entryB = rps;
            }
        }
        assertLe(totalHarvested, totalFees, "cumulative harvest never exceeds cumulative fees");
        assertEq(eng.feeBudgetCusd(), totalFees - totalHarvested, "budget == fees - harvested, exactly");
    }

    // A saver who bonds AFTER a fee was collected with no savers has no claim on that stranded budget: it was
    // never attributed to any rps, and only fees arriving while they are bonded accrue to them.
    function test_tsr_late_saver_cannot_claim_stranded_budget() public {
        bytes32 cusd = eng.CUSD_ASSET_ID();
        uint256 stranded = _feeFromCdp(); // collected with no savers
        assertEq(eng.savingsRps(), 0, "no savers -> rps stays flat");
        assertEq(eng.feeBudgetCusd(), stranded, "fee stranded, un-attributed");

        vm.prank(address(pool));
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 0, RECEIPT, RAY); // bonds at the live rps (0)
        assertEq(eng.pendingSavingsReward(1000e8, 0), 0, "no claim on the pre-existing stranded fee");
        vm.prank(address(pool));
        vm.expectRevert(CollateralEngine.SavingsOverClaim.selector);
        eng.onCdpMint(_savingsLegs(cusd, 1000e8, 0), 1, RECEIPT, RAY); // even one base unit overclaims

        uint256 fresh = _feeFromCdp(); // a new fee DOES accrue to the now-bonded saver
        assertGt(eng.pendingSavingsReward(1000e8, 0), 0, "a fresh fee accrues to the bonded saver");
        assertEq(eng.feeBudgetCusd(), stranded + fresh, "stranded fee remains, never attributed");
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

        (bool ok,) = address(eng).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(eng.insuranceReserve(), 3 ether, "plain ETH receive is accounted as reserve");

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadAmount.selector);
        eng.drawInsurance(0, admin);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.InsufficientReserve.selector);
        eng.drawInsurance(4 ether, admin);

        uint256 before = admin.balance;
        vm.prank(admin);
        eng.drawInsurance(1 ether, admin);
        assertEq(eng.insuranceReserve(), 2 ether);
        assertEq(admin.balance, before + 1 ether);

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.BadPurpose.selector);
        eng.drawInsuranceFor(bytes32(0), 1, admin);

        before = admin.balance;
        vm.prank(admin);
        eng.drawInsuranceFor(keccak256("CDP_BAD_DEBT"), 2 ether, admin);
        assertEq(eng.insuranceReserve(), 0);
        assertEq(admin.balance, before + 2 ether);
    }

    function test_zero_recipients_revert() public {
        // claimEscrow refunds the funder (msg.sender) — no recipient to zero. The owner reserve draws still
        // guard the zero recipient.
        eng.fundInsurance{value: 1 ether}();
        vm.prank(admin);
        vm.expectRevert(CollateralEngine.ZeroRecipient.selector);
        eng.drawInsurance(1 ether, address(0));

        vm.prank(admin);
        vm.expectRevert(CollateralEngine.ZeroRecipient.selector);
        eng.drawInsuranceFor(keccak256("P"), 1 ether, address(0));
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

    // ─────────────────────── cBTC escrow health (margin call) — DORMANT seam ───────────────────────
    // Feeds: 1 ETH = 0.05 BTC ⇒ 1 BTC = 20 ETH. A 1 BTC lock (vBtc = 1e8) needs requiredEscrow = 30 ETH at
    // the 1.5× mint ratio; ethWeiForBtc(1e8) = 20 ETH.
    address module = address(0xB0D);

    function _liveMintedLock(bytes32 o, uint256 escrowWei) internal {
        pool.setLock(o, 1e8);
        pool.setMinted(o, true);
        vm.deal(address(this), escrowWei);
        eng.postEscrow{value: escrowWei}(o);
    }

    function test_escrow_health_dormant_by_default() public {
        bytes32 o = keccak256("health-dormant");
        _liveMintedLock(o, 1 ether); // far below any sane coverage…
        // …yet dormant maintenance (0) reports healthy regardless, so nothing is enforceable before arming.
        (bool healthy,, uint256 want) = eng.checkEscrowHealth(o, 1e8);
        assertTrue(healthy);
        assertEq(want, 0);
        // No module set ⇒ flag/enforce are unreachable.
        vm.expectRevert(CollateralEngine.NotEnforcementModule.selector);
        eng.flagEscrowUnhealthy(o, 1e8);
        vm.expectRevert(CollateralEngine.NotEnforcementModule.selector);
        eng.enforceEscrowToReserve(o, 1e8);
    }

    function test_escrow_enforcement_module_only() public {
        bytes32 o = keccak256("health-modonly");
        _liveMintedLock(o, 1 ether);
        vm.etch(module, hex"00"); // the module must be a contract; the engine never calls it (it calls the engine)
        vm.prank(admin);
        eng.setEscrowEnforcementModule(module);
        vm.prank(admin);
        eng.setEscrowHealthParams(11000, 1 days); // 1.1× maintenance, 1-day grace
        // A non-module caller still can't flag/enforce.
        vm.expectRevert(CollateralEngine.NotEnforcementModule.selector);
        eng.flagEscrowUnhealthy(o, 1e8);
    }

    function test_setEscrowHealthParams_bounds() public {
        vm.startPrank(admin);
        // below 100% rejected
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setEscrowHealthParams(9999, 1 days);
        // at/above the mint ratio (15000) rejected
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setEscrowHealthParams(15000, 1 days);
        // grace over 30 days rejected
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setEscrowHealthParams(11000, 31 days);
        // valid
        eng.setEscrowHealthParams(11000, 1 days);
        assertEq(eng.escrowMaintenanceBps(), 11000);
        assertEq(eng.escrowGraceWindow(), 1 days);
        // 0 disables (back to dormant)
        eng.setEscrowHealthParams(0, 0);
        assertEq(eng.escrowMaintenanceBps(), 0);
        vm.stopPrank();
    }

    function test_setParams_cannot_drop_ratio_to_or_below_armed_maintenance() public {
        vm.startPrank(admin);
        eng.setEscrowHealthParams(13000, 1 days); // arm maintenance at 1.3× (below the 1.5× mint ratio)
        // A ratio cut to/below 1.3× would make fresh mints instantly enforceable — rejected.
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 13000, 15000, 12500);
        vm.expectRevert(CollateralEngine.BadParams.selector);
        eng.setParams(3600, 12000, 15000, 12500);
        // A cut that stays above maintenance is fine.
        eng.setParams(3600, 14000, 15000, 12500);
        assertEq(eng.escrowRatioBps(), 14000);
        vm.stopPrank();
    }

    function test_escrow_margin_call_flag_grace_enforce() public {
        bytes32 o = keccak256("health-margincall");
        _liveMintedLock(o, 30 ether); // exactly the 1.5× mint requirement, healthy at arm time
        vm.etch(module, hex"00"); // the module must be a contract; the engine never calls it (it calls the engine)
        vm.prank(admin);
        eng.setEscrowEnforcementModule(module);
        vm.prank(admin);
        eng.setEscrowHealthParams(11000, 1 days);

        // Healthy now ⇒ cannot flag.
        vm.prank(module);
        vm.expectRevert(CollateralEngine.EscrowHealthy.selector);
        eng.flagEscrowUnhealthy(o, 1e8);

        // ETH depreciates vs BTC: 1 ETH = 0.02 BTC ⇒ 1 BTC = 50 ETH; want at 1.1× = 55 ETH > 30 escrow.
        ethBtc.setAnswer(0.02e8);
        (bool healthy,,) = eng.checkEscrowHealth(o, 1e8);
        assertFalse(healthy);

        vm.prank(module);
        eng.flagEscrowUnhealthy(o, 1e8);
        assertEq(eng.escrowUnhealthySince(o), block.timestamp);

        // Enforce before grace elapses ⇒ revert.
        vm.prank(module);
        vm.expectRevert(CollateralEngine.GraceNotElapsed.selector);
        eng.enforceEscrowToReserve(o, 1e8);

        // After grace ⇒ escrow swept to reserve, outpoint slashed (one-shot).
        vm.warp(block.timestamp + 1 days + 1);
        ethBtc.setAnswer(0.02e8); // refresh updatedAt past the warp
        uint256 reserveBefore = eng.insuranceReserve();
        vm.prank(module);
        eng.enforceEscrowToReserve(o, 1e8);
        assertEq(eng.insuranceReserve(), reserveBefore + 30 ether);
        assertTrue(eng.escrowSlashed(o));
        // Cannot enforce twice.
        vm.prank(module);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.enforceEscrowToReserve(o, 1e8);
    }

    function test_escrow_topup_cures_via_health_recheck_then_module_clears() public {
        bytes32 o = keccak256("health-cure");
        _liveMintedLock(o, 30 ether);
        vm.etch(module, hex"00"); // the module must be a contract; the engine never calls it (it calls the engine)
        vm.prank(admin);
        eng.setEscrowEnforcementModule(module);
        vm.prank(admin);
        eng.setEscrowHealthParams(11000, 1 days);

        ethBtc.setAnswer(0.02e8); // unhealthy (need 55, have 30)
        vm.prank(module);
        eng.flagEscrowUnhealthy(o, 1e8);
        assertGt(eng.escrowUnhealthySince(o), 0);

        // Locker tops up to restore health. The flag is NOT auto-cleared (a dust top-up must not dodge
        // enforcement), but the on-chain health re-check blocks enforcing a now-healthy escrow.
        vm.deal(address(this), 30 ether);
        eng.postEscrow{value: 30 ether}(o); // now 60 ETH ≥ 55 want
        assertGt(eng.escrowUnhealthySince(o), 0); // flag persists
        (bool healthy,,) = eng.checkEscrowHealth(o, 1e8);
        assertTrue(healthy);

        vm.warp(block.timestamp + 2 days);
        ethBtc.setAnswer(0.02e8);
        vm.prank(module);
        vm.expectRevert(CollateralEngine.EscrowHealthy.selector);
        eng.enforceEscrowToReserve(o, 1e8);

        // The module resets the grace clock on the observed cure (so a later dip gets fresh grace).
        vm.prank(module);
        eng.clearEscrowFlag(o);
        assertEq(eng.escrowUnhealthySince(o), 0);
    }

    function test_escrow_dust_topup_cannot_dodge_enforcement() public {
        bytes32 o = keccak256("health-grief");
        _liveMintedLock(o, 30 ether);
        vm.etch(module, hex"00");
        vm.prank(admin);
        eng.setEscrowEnforcementModule(module);
        vm.prank(admin);
        eng.setEscrowHealthParams(11000, 1 days);

        ethBtc.setAnswer(0.02e8); // unhealthy (need 55, have 30)
        vm.prank(module);
        eng.flagEscrowUnhealthy(o, 1e8);
        uint256 flaggedAt = eng.escrowUnhealthySince(o);

        // A dust top-up that does NOT restore health must not reset the grace clock.
        vm.deal(address(this), 1 wei);
        eng.postEscrow{value: 1 wei}(o);
        assertEq(eng.escrowUnhealthySince(o), flaggedAt);

        // Still unhealthy after grace ⇒ enforced despite the dust top-up.
        vm.warp(block.timestamp + 1 days + 1);
        ethBtc.setAnswer(0.02e8);
        vm.prank(module);
        eng.enforceEscrowToReserve(o, 1e8);
        assertTrue(eng.escrowSlashed(o));
    }

    function test_clearEscrowFlag_module_only() public {
        bytes32 o = keccak256("health-clearonly");
        vm.expectRevert(CollateralEngine.NotEnforcementModule.selector);
        eng.clearEscrowFlag(o);
    }

    function test_escrow_enforce_rejects_redeemed_or_disabled() public {
        bytes32 o = keccak256("health-redeemed");
        _liveMintedLock(o, 30 ether);
        vm.etch(module, hex"00"); // the module must be a contract; the engine never calls it (it calls the engine)
        vm.prank(admin);
        eng.setEscrowEnforcementModule(module);
        // Maintenance still 0 (module set but not armed) ⇒ EnforcementDisabled.
        vm.prank(module);
        vm.expectRevert(CollateralEngine.EnforcementDisabled.selector);
        eng.flagEscrowUnhealthy(o, 1e8);

        vm.prank(admin);
        eng.setEscrowHealthParams(11000, 1 days);
        // A redeemed lock has no live escrow to enforce.
        pool.setRedeemed(o, true);
        ethBtc.setAnswer(0.02e8);
        vm.prank(module);
        vm.expectRevert(CollateralEngine.EscrowLocked.selector);
        eng.flagEscrowUnhealthy(o, 1e8);
    }
}
