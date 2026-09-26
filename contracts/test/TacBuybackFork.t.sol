// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBuyback} from "../src/TacBuyback.sol";

interface IErc20Balance {
    function balanceOf(address) external view returns (uint256);
}

interface IPrecisionQuote {
    function quoteExactIn(address sender, address tokenIn, uint256 amountIn) external view returns (uint256 amountOut, bool fits);
    function reserve0() external view returns (uint256);
}

interface IAmmQuote {
    function quoteSwap(bytes32 assetIn, bytes32 assetOut, uint32 feeBps, uint256 amountIn) external view returns (uint256);
}

/// Runs against the live ConfidentialPool and TacitPublicAmm on a mainnet fork. Requires an RPC URL:
///   FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-path test/TacBuybackFork.t.sol
/// Skips (not fails) when FORK_URL is unset.
contract TacBuybackForkTest is Test {
    address constant AMM = 0x00000000E36C7EC997CC59DCda9E03673B448119;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    uint32 constant FEE = 30;
    address constant KEEPER = address(0xCAFE);
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;

    TacBuyback bb;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping"); return false; }
        vm.createSelectFork(url);
        // Generous impact cap (10%) so the buy fits whatever the live pool depth is; the impact test below
        // deploys its own tight instance.
        bb = new TacBuyback(AMM, PRECISION, OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 1 hours, 1000);
        vm.deal(address(bb), 1 ether);
        return true;
    }

    function _smallBuy() internal view returns (uint256 amountIn) {
        (, bytes32 a,, uint256 rA, uint256 rB,,) = bb.AMM().POOL().pools(bb.POOL_ID());
        uint256 ethReserveUnits = a == ETH_ASSET ? rA : rB;
        amountIn = (ethReserveUnits / 100) * bb.UNIT(); // 1% of the ETH side
        if (amountIn == 0) amountIn = bb.UNIT();
    }

    function test_buySendsTacStraightToReserve() public {
        if (!_fork()) return;
        uint256 amountIn = _smallBuy();
        uint256 quoted = IAmmQuote(AMM).quoteSwap(ETH_ASSET, TAC_ASSET, FEE, amountIn);
        uint256 opsBefore = IErc20Balance(TAC).balanceOf(OPS);
        uint256 ethBefore = address(bb).balance;

        vm.prank(KEEPER);
        uint256 out = bb.buy(0, amountIn, quoted, 0);

        assertEq(out, quoted, "clears at the quote");
        assertEq(IErc20Balance(TAC).balanceOf(OPS) - opsBefore, out, "TAC lands at the reserve");
        assertEq(IErc20Balance(TAC).balanceOf(address(bb)), 0, "buyback never holds TAC");
        assertEq(ethBefore - address(bb).balance, amountIn, "spent exactly amountIn");
    }

    function test_onlyKeeperBuys_andCooldownHolds() public {
        if (!_fork()) return;
        uint256 amountIn = _smallBuy();
        vm.expectRevert(TacBuyback.NotKeeper.selector);
        bb.buy(0, amountIn, 1, 0);

        vm.prank(KEEPER);
        bb.buy(0, amountIn, 1, 0);
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.TooSoon.selector);
        bb.buy(0, amountIn, 1, 0);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(KEEPER);
        bb.buy(0, amountIn, 1, 0);
    }

    function test_boundsHoldWhateverTheKeeperPasses() public {
        if (!_fork()) return;
        uint256 small = _smallBuy();
        uint256 unit = bb.UNIT();
        vm.startPrank(KEEPER);
        vm.expectRevert(TacBuyback.BadAmount.selector);
        bb.buy(0, 2 ether, 1, 0); // over MAX_PER_BUY
        vm.expectRevert(TacBuyback.BadAmount.selector);
        bb.buy(0, small, 0, 0); // zero minOut
        vm.expectRevert(TacBuyback.BadAmount.selector);
        bb.buy(0, unit - 1, 1, 0); // rounds to zero
        vm.stopPrank();

        // A buy bigger than the impact cap is refused before it reaches the pool.
        TacBuyback tight = new TacBuyback(AMM, PRECISION, OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 0, 1);
        vm.deal(address(tight), 1 ether);
        (, bytes32 a,, uint256 rA, uint256 rB,,) = tight.AMM().POOL().pools(tight.POOL_ID());
        uint256 ethReserveUnits = a == ETH_ASSET ? rA : rB;
        uint256 over = (ethReserveUnits / 10_000 + 1) * tight.UNIT() * 2;
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.TooMuchImpact.selector);
        tight.buy(0, over, 1, 0);
    }

    function test_minOutAboveQuoteReverts() public {
        if (!_fork()) return;
        uint256 amountIn = _smallBuy();
        uint256 quoted = IAmmQuote(AMM).quoteSwap(ETH_ASSET, TAC_ASSET, FEE, amountIn);
        vm.prank(KEEPER);
        vm.expectRevert();
        bb.buy(0, amountIn, quoted + 1, 0);
        assertEq(bb.lastBuyAt(), 0, "a failed buy does not start the cooldown");
    }

    function test_flushOnlyToReserve() public {
        if (!_fork()) return;
        vm.expectRevert(TacBuyback.NotAllowed.selector);
        bb.flush();

        uint256 opsBefore = OPS.balance;
        vm.prank(OPS);
        bb.flush();
        assertEq(address(bb).balance, 0);
        assertEq(OPS.balance - opsBefore, 1 ether);
    }

    function test_constructorRejectsWrongAssetsOrPool() public {
        if (!_fork()) return;
        vm.expectRevert(TacBuyback.BadConfig.selector);
        new TacBuyback(AMM, PRECISION, OPS, KEEPER, TAC_ASSET, ETH_ASSET, FEE, 1 ether, 0, 100); // input not native ETH
        vm.expectRevert(TacBuyback.BadConfig.selector);
        new TacBuyback(AMM, PRECISION, OPS, KEEPER, ETH_ASSET, TAC_ASSET, 31, 1 ether, 0, 100); // no such fee tier
        vm.expectRevert(TacBuyback.BadConfig.selector);
        new TacBuyback(AMM, PRECISION, OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 0, 1001); // impact cap > 10%
        vm.expectRevert(TacBuyback.BadConfig.selector);
        new TacBuyback(AMM, PRECISION, address(0), KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 0, 100);
        vm.expectRevert(TacBuyback.BadConfig.selector);
        new TacBuyback(AMM, PRECISION, OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 30 days + 1, 100); // cooldown bound
    }

    function test_precisionVenueSendsTacStraightToReserve() public {
        if (!_fork()) return;
        uint256 amountIn = (IPrecisionQuote(PRECISION).reserve0() / 100 / bb.UNIT()) * bb.UNIT(); // 1% of its ETH
        (uint256 quoted, bool fits) = IPrecisionQuote(PRECISION).quoteExactIn(address(bb), address(0), amountIn);
        assertTrue(fits && quoted > 0, "fits the band");
        uint256 opsBefore = IErc20Balance(TAC).balanceOf(OPS);

        vm.prank(KEEPER);
        uint256 out = bb.buy(1, amountIn, quoted, 0);

        assertEq(out, quoted, "clears at the quote");
        assertEq(IErc20Balance(TAC).balanceOf(OPS) - opsBefore, out, "TAC lands at the reserve");
        assertEq(IErc20Balance(TAC).balanceOf(address(bb)), 0, "buyback never holds TAC");
    }

    function test_venuesShareOneCooldown_andDeadlineHolds() public {
        if (!_fork()) return;
        uint256 small = _smallBuy();
        vm.prank(KEEPER);
        bb.buy(0, small, 1, 0);
        uint256 p = (IPrecisionQuote(PRECISION).reserve0() / 100 / bb.UNIT()) * bb.UNIT();
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.TooSoon.selector);
        bb.buy(1, p, 1, 0);

        vm.warp(block.timestamp + 1 hours);
        uint64 past = uint64(block.timestamp - 1);
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.Expired.selector);
        bb.buy(1, p, 1, past);
    }

    function test_precisionImpactCap_andMissingVenue() public {
        if (!_fork()) return;
        TacBuyback tight = new TacBuyback(AMM, PRECISION, OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 0, 1);
        vm.deal(address(tight), 1 ether);
        uint256 over = (IPrecisionQuote(PRECISION).reserve0() / 1000 / tight.UNIT() + 1) * tight.UNIT();
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.TooMuchImpact.selector);
        tight.buy(1, over, 1, 0);

        TacBuyback tacitOnly = new TacBuyback(AMM, address(0), OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 0, 1000);
        vm.deal(address(tacitOnly), 1 ether);
        uint256 unit = tacitOnly.UNIT();
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.NoVenue.selector);
        tacitOnly.buy(1, unit, 1, 0);
        vm.prank(KEEPER);
        vm.expectRevert(TacBuyback.NoVenue.selector);
        bb.buy(2, unit, 1, 0);
    }

    function test_constructorRejectsPrecisionPoolForOtherToken() public {
        if (!_fork()) return;
        vm.expectRevert(); // not a Precision pool at all
        new TacBuyback(AMM, AMM, OPS, KEEPER, ETH_ASSET, TAC_ASSET, FEE, 1 ether, 0, 100);
    }
}
