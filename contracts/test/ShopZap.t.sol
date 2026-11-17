// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ShopZap} from "../src/ShopZap.sol";

contract MockTac is ERC20 {
    function name() public pure override returns (string memory) { return "Tacit Token"; }
    function symbol() public pure override returns (string memory) { return "TAC"; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// takes the TAC from the buyer the way the real shop does and records the sale
contract MockShop {
    MockTac public tac;
    address public treasury;
    uint256 public price;
    bool public refuse;
    mapping(uint256 id => address) public soldTo;
    uint8 public lastNonce;
    uint256 public lastMaxPrice;

    constructor(MockTac t, address treasury_, uint256 price_) { tac = t; treasury = treasury_; price = price_; }
    function setRefuse(bool r) external { refuse = r; }
    function setPrice(uint256 p) external { price = p; }

    function buy(uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline) external {
        require(!refuse, "the shop refused");
        require(block.timestamp <= deadline, "expired");
        require(price <= maxPrice, "price above the most");
        tac.transferFrom(msg.sender, treasury, price);
        soldTo[id] = to; lastNonce = nonce; lastMaxPrice = maxPrice;
    }
}

/// pays TAC to its caller for the ETH it is sent, and can hand some ETH back
contract MockRouter {
    MockTac public tac;
    constructor(MockTac t) { tac = t; }
    function swap(uint256 tacOut, uint256 ethBack) external payable {
        tac.transfer(msg.sender, tacOut);
        if (ethBack != 0) { (bool ok,) = msg.sender.call{value: ethBack}(""); require(ok, "no refund"); }
    }
    function fail() external payable { revert("the router said no"); }
}

/// a buyer that cannot take ETH back
contract Closed {
    function go(ShopZap zap, bytes calldata data, uint256 id, address to, uint256 maxPrice) external payable {
        zap.buyWithEth{value: msg.value}(data, id, to, 3, maxPrice, block.timestamp + 1 hours);
    }
}

contract ShopZapTest is Test {
    MockTac tac; MockShop shop; MockRouter router; ShopZap zap;
    address treasury = address(0x7777); address user = address(0xAAAA); address recipient = address(0xBBBB);
    uint256 constant PRICE = 28e18; uint256 constant ID = 0x1234;

    function setUp() public {
        tac = new MockTac(); shop = new MockShop(tac, treasury, PRICE); router = new MockRouter(tac);
        zap = new ShopZap(address(router), address(tac), address(shop));
        tac.mint(address(router), 1_000_000e18);
        vm.deal(user, 100 ether);
    }

    function _swap(uint256 tacOut, uint256 ethBack) internal view returns (bytes memory) { return abi.encodeCall(MockRouter.swap, (tacOut, ethBack)); }
    function _buy(uint256 value, bytes memory swapData, uint256 maxPrice) internal {
        vm.prank(user);
        zap.buyWithEth{value: value}(swapData, ID, recipient, 3, maxPrice, block.timestamp + 1 hours);
    }

    function testABuyPaysTheShopAndSendsBackWhatIsLeft() public {
        uint256 ethBefore = user.balance;
        _buy(1 ether, _swap(PRICE + 0.4e18, 0.1 ether), PRICE);
        assertEq(shop.soldTo(ID), recipient, 'the token goes to the address named');
        assertEq(shop.lastNonce(), 3, 'the nonce is the one given');
        assertEq(tac.balanceOf(treasury), PRICE, 'the shop was paid its price');
        assertEq(tac.balanceOf(user), 0.4e18, 'the TAC the swap paid beyond the price comes back to the buyer');
        assertEq(tac.balanceOf(recipient), 0, 'and not to the one the token went to');
        assertEq(ethBefore - user.balance, 0.9 ether, 'the ETH the router did not use comes back');
        assertEq(tac.balanceOf(address(zap)), 0); assertEq(address(zap).balance, 0);
        assertEq(tac.allowance(address(zap), address(shop)), 0, 'no allowance is left');
    }

    function testAnExactSwapLeavesNothingToSendBack() public {
        _buy(1 ether, _swap(PRICE, 0), PRICE);
        assertEq(tac.balanceOf(user), 0); assertEq(user.balance, 99 ether);
        assertEq(tac.balanceOf(address(zap)), 0); assertEq(address(zap).balance, 0);
    }

    function testAMostAboveThePriceStillTakesOnlyThePrice() public {
        _buy(1 ether, _swap(PRICE + 5e18, 0), PRICE + 3e18);
        assertEq(tac.balanceOf(treasury), PRICE, 'the listed price, not the most');
        assertEq(tac.balanceOf(user), 5e18, 'the rest comes back');
        assertEq(tac.allowance(address(zap), address(shop)), 0, 'and the approval for the most is taken back');
    }

    function testASwapThatPaysTooLittleRevertsAndTheBuyerKeepsTheEth() public {
        uint256 before = user.balance;
        vm.prank(user);
        vm.expectRevert();
        zap.buyWithEth{value: 1 ether}(_swap(PRICE - 1, 0), ID, recipient, 3, PRICE, block.timestamp + 1 hours);
        assertEq(user.balance, before); assertEq(tac.balanceOf(treasury), 0); assertEq(shop.soldTo(ID), address(0));
    }

    function testATokenCannotBeSentToTheZapItselfOrTheRouter() public {
        uint256 before = user.balance;
        for (uint256 i; i < 2; i++) {
            vm.prank(user);
            vm.expectRevert(ShopZap.BadRecipient.selector);
            zap.buyWithEth{value: 1 ether}(_swap(PRICE, 0), ID, i == 0 ? address(zap) : address(router), 3, PRICE, block.timestamp + 1 hours);
        }
        assertEq(user.balance, before, 'the buyer keeps the ETH'); assertEq(shop.soldTo(ID), address(0)); assertEq(tac.balanceOf(treasury), 0);
    }

    function testItAnswersNoSignatureCheck() public {
        // TAC gives Permit2 an unlimited allowance on every address: a contract holding TAC that said yes to a bad signature would be emptied. The zap has no fallback to say it.
        (bool ok,) = address(zap).call(abi.encodeWithSignature('isValidSignature(bytes32,bytes)', bytes32(uint256(1)), new bytes(65)));
        assertFalse(ok, 'an ERC-1271 call to the zap reverts');
        (ok,) = address(zap).call(abi.encodeWithSignature('onERC721Received(address,address,uint256,bytes)', user, user, 1, ''));
        assertFalse(ok, 'and so does a token transfer that asks for a receiver');
    }

    function testItDeploysEvenWithEthInTheConstructorCall() public {
        // the market's deploy gives the constructor the whole balance of its deploy address, and a wei can be sent there beforehand
        ShopZap funded = new ShopZap{value: 1}(address(router), address(tac), address(shop));
        assertEq(address(funded).balance, 1);
        vm.deal(user, 100 ether);
        vm.prank(user);
        funded.buyWithEth{value: 1 ether}(_swap(PRICE, 0), ID, recipient, 3, PRICE, block.timestamp + 1 hours);
        assertEq(address(funded).balance, 0, 'the wei goes to the first buyer, with the rest');
        assertEq(user.balance, 100 ether - 1 ether + 1, 'the buyer paid the 1 ETH it sent and got the wei');
    }

    function testTheRoutersOwnRevertIsPassedOn() public {
        vm.prank(user);
        vm.expectRevert(bytes('the router said no'));
        zap.buyWithEth{value: 1 ether}(abi.encodeCall(MockRouter.fail, ()), ID, recipient, 3, PRICE, block.timestamp + 1 hours);
    }

    function testAShopThatRefusesRevertsEverything() public {
        shop.setRefuse(true);
        uint256 before = user.balance;
        vm.prank(user);
        vm.expectRevert(bytes('the shop refused'));
        zap.buyWithEth{value: 1 ether}(_swap(PRICE, 0), ID, recipient, 3, PRICE, block.timestamp + 1 hours);
        assertEq(user.balance, before); assertEq(tac.balanceOf(address(zap)), 0);
    }

    function testAPriceThatMovedAboveTheMostRevertsEverything() public {
        shop.setPrice(PRICE + 1);
        vm.prank(user);
        vm.expectRevert(bytes('price above the most'));
        zap.buyWithEth{value: 1 ether}(_swap(PRICE + 1, 0), ID, recipient, 3, PRICE, block.timestamp + 1 hours);
    }

    function testAnExpiredPurchaseReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes('expired'));
        zap.buyWithEth{value: 1 ether}(_swap(PRICE, 0), ID, recipient, 3, PRICE, block.timestamp - 1);
    }

    function testABuyerThatCannotTakeEthBackOnlyFailsWhenThereIsEthToReturn() public {
        Closed closed = new Closed();
        vm.deal(address(closed), 10 ether);
        closed.go{value: 1 ether}(zap, _swap(PRICE, 0), ID, recipient, PRICE);                  // nothing to send back: it goes through
        assertEq(shop.soldTo(ID), recipient);
        vm.expectRevert();
        closed.go{value: 1 ether}(zap, _swap(PRICE, 0.1 ether), ID + 1, recipient, PRICE);       // some ETH to send back to a contract that refuses it: the whole buy reverts
        assertEq(shop.soldTo(ID + 1), address(0));
    }

    function testItAcceptsEthFromTheRouterAndFromNoOneElseThroughAnyFunction() public {
        vm.deal(address(router), 1 ether);
        vm.prank(address(router));
        (bool ok,) = address(zap).call{value: 1 ether}("");
        assertTrue(ok, 'plain ETH is taken (the router returns what it did not use)');
        (ok,) = address(zap).call(abi.encodeWithSignature('anything()'));
        assertFalse(ok, 'there is no other function and no fallback');
    }

    function testItOnlyCallsTheRouterItWasBuiltWith() public {
        // the swap data goes to the router, whatever it says: a call to some other contract's selector is the router's to refuse
        vm.prank(user);
        vm.expectRevert();
        zap.buyWithEth{value: 1 ether}(abi.encodeWithSignature('transfer(address,uint256)', user, 1), ID, recipient, 3, PRICE, block.timestamp + 1 hours);
        assertEq(tac.balanceOf(treasury), 0);
    }

    function testFuzzNothingIsKeptAndTheBuyerPaysOnlyWhatTheRouterTook(uint96 tacOut, uint64 ethBack, uint64 value) public {
        uint256 out = bound(uint256(tacOut), PRICE, 900_000e18);
        uint256 sent = bound(uint256(value), 1, 50 ether);
        uint256 back = bound(uint256(ethBack), 0, sent);
        uint256 before = user.balance;
        _buy(sent, _swap(out, back), PRICE);
        assertEq(tac.balanceOf(address(zap)), 0); assertEq(address(zap).balance, 0);
        assertEq(tac.balanceOf(treasury), PRICE); assertEq(tac.balanceOf(user), out - PRICE);
        assertEq(before - user.balance, sent - back);
        assertEq(tac.allowance(address(zap), address(shop)), 0);
    }
}
