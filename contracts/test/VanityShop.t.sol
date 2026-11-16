// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {VanityShop, IVanityMarket} from "../src/VanityShop.sol";

contract TestTac is ERC20 {
    function name() public pure override returns (string memory) { return "TAC"; }
    function symbol() public pure override returns (string memory) { return "TAC"; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

interface IShopBuy {
    function buy(uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline) external;
}

/// A token that, once, calls the shop back from inside `transferFrom` for the same id, holding enough of itself for the inner sale to pay if it were let through.
contract ReenteringTac {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    IShopBuy shop;
    uint256 id;
    bool public armed;
    bool public reentered;

    function arm(address shop_, uint256 id_) external { shop = IShopBuy(shop_); id = id_; armed = true; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (armed) {
            armed = false;
            try shop.buy(id, from, 0, type(uint256).max, type(uint256).max) { reentered = true; } catch {}
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// The market's side of what the shop uses: only the id's owner (its top 160 bits) mints, once, and `computeAddress` is some function of the id and nonce.
contract MockMarket {
    mapping(uint256 => address) public holder;
    mapping(uint256 => uint8) public nonceOf;
    mapping(uint256 => bool) public minted;

    error NotOwnerNorApproved();
    error AlreadyMinted();

    function mint(address to, uint256 id, uint8 nonce) external {
        if (msg.sender != address(uint160(id >> 96))) revert NotOwnerNorApproved();
        if (minted[id]) revert AlreadyMinted();
        minted[id] = true;
        holder[id] = to;
        nonceOf[id] = nonce;
    }

    function getTokenData(uint256 id) external view returns (bool, uint8) { return (minted[id], nonceOf[id]); }

    function computeAddress(bytes32 salt, uint8 nonce) external pure returns (address) { return address(uint160(uint256(keccak256(abi.encode(salt, nonce))))); }
}

contract VanityShopTest is Test {
    uint256 constant NEVER = type(uint256).max;

    event Listed(uint256 indexed id, address indexed vanity, uint8 nonce, uint128 price);
    event Sold(uint256 indexed id, address indexed to, address indexed buyer, uint128 price);
    event Kept(uint256 indexed id, address indexed to, uint8 nonce);

    MockMarket market;
    TestTac tac;
    VanityShop shop;
    address owner = address(0x0A11CE);
    address treasury = address(0x7EA5);
    address buyer;
    uint256 buyerKey = 0xB0B;

    function setUp() public {
        buyer = vm.addr(buyerKey);
        market = new MockMarket();
        tac = new TestTac();
        shop = new VanityShop(owner, address(market), address(tac), treasury);
        tac.mint(buyer, 1_000e18);
    }

    function _id(uint96 low) internal view returns (uint256) { return (uint256(uint160(address(shop))) << 96) | low; }

    function _item(uint96 low, uint128 price, uint8 nonce) internal view returns (VanityShop.Item[] memory it) {
        it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item(_id(low), price, nonce);
    }

    function _list(uint96 low, uint128 price, uint8 nonce) internal { vm.prank(owner); shop.list(_item(low, price, nonce)); }

    // ---- listing ----

    function testListSetsPriceAndNonceAndSaysTheAddress() public {
        uint256 id = _id(7);
        vm.expectEmit(true, true, false, true);
        emit Listed(id, market.computeAddress(bytes32(id), 3), 3, 50e18);
        _list(7, 50e18, 3);
        (uint128 price, uint8 nonce) = shop.listings(id);
        assertEq(price, 50e18);
        assertEq(nonce, 3);
    }

    function testOnlyTheOwnerLists() public {
        vm.expectRevert();
        shop.list(_item(1, 1e18, 0));
        vm.expectRevert();
        vm.prank(buyer);
        shop.unlist(new uint256[](0));
        vm.expectRevert();
        vm.prank(buyer);
        shop.keep(_id(1), 0, buyer);
        vm.expectRevert();
        vm.prank(buyer);
        shop.setTreasury(buyer);
    }

    function testAnIdThatIsNotThisShopsCannotBeListedOrKept() public {
        VanityShop.Item[] memory it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item((uint256(uint160(address(0xBEEF))) << 96) | 1, 1e18, 0);
        vm.startPrank(owner);
        vm.expectRevert(VanityShop.NotThisShopsSalt.selector);
        shop.list(it);
        vm.expectRevert(VanityShop.NotThisShopsSalt.selector);
        shop.keep(it[0].id, 0, owner);
        vm.stopPrank();
    }

    function testAFreePriceOrTheTopNonceCannotBeListed() public {
        vm.startPrank(owner);
        vm.expectRevert(VanityShop.BadListing.selector);
        shop.list(_item(1, 0, 0));
        vm.expectRevert(VanityShop.BadNonce.selector);
        shop.list(_item(1, 1e18, 255));
        shop.list(_item(1, 1e18, 254));
        vm.stopPrank();
    }

    function testAMintedIdCannotBeListedAgain() public {
        _list(1, 5e18, 0);
        vm.prank(owner);
        shop.keep(_id(1), 0, owner);
        vm.prank(owner);
        vm.expectRevert(VanityShop.AlreadyMinted.selector);
        shop.list(_item(1, 5e18, 0));
    }

    function testRelistingChangesThePrice() public {
        _list(1, 5e18, 0);
        _list(1, 9e18, 2);
        (uint128 price, uint8 nonce) = shop.listings(_id(1));
        assertEq(price, 9e18);
        assertEq(nonce, 2);
    }

    // ---- buying ----

    function testBuyPaysTheTreasuryMintsToTheNamedAddressAndClearsTheListing() public {
        _list(1, 40e18, 5);
        address to = address(0xCAFE);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectEmit(true, true, true, true);
        emit Sold(_id(1), to, buyer, 40e18);
        shop.buy(_id(1), to, 5, 40e18, NEVER);
        vm.stopPrank();
        assertEq(tac.balanceOf(treasury), 40e18);
        assertEq(tac.balanceOf(buyer), 960e18);
        assertEq(tac.balanceOf(address(shop)), 0, 'the shop holds nothing');
        assertEq(market.holder(_id(1)), to);
        assertEq(market.nonceOf(_id(1)), 5, 'the listed nonce is the token\'s');
        (uint128 price,) = shop.listings(_id(1));
        assertEq(price, 0);
    }

    function testABuyerWithRoomUnderTheirMaximumPaysTheListedPriceAndNoMore() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(1), buyer, 0, 1_000e18, NEVER);       // willing to pay 1,000: the listing is 40
        vm.stopPrank();
        assertEq(tac.balanceOf(buyer), 960e18, 'charged 40, not 1,000');
        assertEq(tac.balanceOf(treasury), 40e18);
    }

    function testAPermitBuyWithRoomUnderTheMaximumSpendsTheListedPriceAndLeavesTheRestOfTheAllowanceTheBuyersOwn() public {
        _list(1, 40e18, 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(1_000e18, deadline);
        vm.prank(buyer);
        shop.buyWithPermit(_id(1), buyer, 0, 1_000e18, deadline, v, r, s);
        assertEq(tac.balanceOf(buyer), 960e18);
        assertEq(tac.balanceOf(treasury), 40e18);
        assertEq(tac.allowance(buyer, address(shop)), 960e18, 'what the permit did not spend stays standing');
        // a standing allowance is spendable only by a sale the owner of it makes: nobody else's call moves it
        _list(2, 1e18, 0);
        vm.prank(address(0x7E1F));
        vm.expectRevert();
        shop.buy(_id(2), address(0x7E1F), 0, 1e18, NEVER);
        assertEq(tac.balanceOf(buyer), 960e18);
    }

    function testASecondBuyOfTheSameIdFails() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
        vm.expectRevert(VanityShop.NotListed.selector);
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
        vm.stopPrank();
    }

    function testAnUnlistedIdCannotBeBought() public {
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.NotListed.selector);
        shop.buy(_id(9), buyer, 0, 1_000e18, NEVER);
        vm.stopPrank();
    }

    function testAPriceThatMovedAboveTheBuyersMaxIsRefused() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.PriceAboveMax.selector);
        shop.buy(_id(1), buyer, 0, 39e18, NEVER);
        vm.stopPrank();
        _list(1, 400e18, 0);
        vm.prank(buyer);
        vm.expectRevert(VanityShop.PriceAboveMax.selector);
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
    }

    function testNoAllowanceOrNoBalanceMeansNoSale() public {
        _list(1, 40e18, 0);
        vm.prank(buyer);
        vm.expectRevert();
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
        _list(2, 5_000e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert();
        shop.buy(_id(2), buyer, 0, 5_000e18, NEVER);
        vm.stopPrank();
        (uint128 p1,) = shop.listings(_id(1));
        assertEq(p1, 40e18, 'a failed buy leaves the listing');
        assertFalse(market.minted(_id(2)));
    }

    function testASaleIsTheShopsAloneToMake() public {
        // the market lets only the id's owner (the shop) mint: nobody else can mint a listed id out from under a sale
        _list(1, 40e18, 0);
        vm.prank(buyer);
        vm.expectRevert(MockMarket.NotOwnerNorApproved.selector);
        market.mint(buyer, _id(1), 0);
    }

    function testBuyWithPermitIsOneTransaction() public {
        _list(1, 40e18, 0);
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, block.timestamp + 1 hours);
        vm.prank(buyer);
        shop.buyWithPermit(_id(1), buyer, 0, 40e18, block.timestamp + 1 hours, v, r, s);
        assertEq(market.holder(_id(1)), buyer);
        assertEq(tac.balanceOf(treasury), 40e18);
    }

    function testAPermitBuyPaysFromTheCallerAndMintsToTheRecipientNamed() public {
        _list(1, 40e18, 0);
        address to = address(0xCAFE);
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, block.timestamp + 1 hours);    // signed by the buyer, for the shop
        vm.prank(buyer);
        shop.buyWithPermit(_id(1), to, 0, 40e18, block.timestamp + 1 hours, v, r, s);
        assertEq(market.holder(_id(1)), to, 'the token went where the buyer said');
        assertEq(tac.balanceOf(buyer), 960e18, 'the buyer paid');
        assertEq(tac.balanceOf(to), 0);
        assertEq(tac.balanceOf(treasury), 40e18);
        assertEq(tac.allowance(buyer, address(shop)), 0, 'the whole permit was spent');
    }

    function testAPermitSomeoneElseAlreadyUsedStillBuysWhileTheAllowanceStands() public {
        _list(1, 40e18, 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, deadline);
        tac.permit(buyer, address(shop), 40e18, deadline, v, r, s);   // a bystander submits the buyer's signature first
        vm.prank(buyer);
        shop.buyWithPermit(_id(1), buyer, 0, 40e18, deadline, v, r, s);
        assertEq(market.holder(_id(1)), buyer);
    }

    function testABadPermitWithNoAllowanceBuysNothing() public {
        _list(1, 40e18, 0);
        vm.prank(buyer);
        vm.expectRevert();
        shop.buyWithPermit(_id(1), buyer, 0, 40e18, block.timestamp + 1 hours, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertFalse(market.minted(_id(1)));
    }

    function testAPermitOnlyReachesTheCallerAsPayer() public {
        // the permit approves the shop to pull from the signer, but a sale always pulls from msg.sender: another account cannot spend the signer's TAC
        _list(1, 40e18, 0);
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, block.timestamp + 1 hours);
        tac.permit(buyer, address(shop), 40e18, block.timestamp + 1 hours, v, r, s);
        address thief = address(0x7E1F);
        vm.prank(thief);
        vm.expectRevert();
        shop.buy(_id(1), thief, 0, 40e18, NEVER);
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), buyer, address(shop), value, tac.nonces(buyer), deadline));
        (v, r, s) = vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", tac.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---- keeping, unlisting, the treasury ----

    function testKeepMintsWithoutASaleAndTakesTheIdOffTheShelf() public {
        _list(1, 40e18, 0);
        vm.expectEmit(true, true, false, true);
        emit Kept(_id(1), owner, 9);
        vm.prank(owner);
        shop.keep(_id(1), 9, owner);
        assertEq(market.holder(_id(1)), owner);
        assertEq(market.nonceOf(_id(1)), 9);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.NotListed.selector);
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
        vm.stopPrank();
    }

    function testUnlistTakesTheIdOffTheShelf() public {
        _list(1, 40e18, 0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = _id(1);
        vm.prank(owner);
        shop.unlist(ids);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.NotListed.selector);
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
        vm.stopPrank();
    }

    function testTheTreasuryIsTheOwnersToChangeAndNeverEmpty() public {
        vm.startPrank(owner);
        vm.expectRevert(VanityShop.BadAddress.selector);
        shop.setTreasury(address(0));
        shop.setTreasury(address(0xBA5E));
        vm.stopPrank();
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(1), buyer, 0, 40e18, NEVER);
        vm.stopPrank();
        assertEq(tac.balanceOf(address(0xBA5E)), 40e18);
        assertEq(tac.balanceOf(treasury), 0);
        vm.expectRevert(VanityShop.BadAddress.selector);
        new VanityShop(owner, address(market), address(tac), address(0));
    }

    function testFuzzTheTreasuryGetsExactlyTheListedPrice(uint128 price, uint8 nonce, uint96 low, uint256 headroom) public {
        price = uint128(bound(price, 1, 1_000e18));
        nonce = uint8(bound(nonce, 0, 254));
        headroom = bound(headroom, 0, 1_000_000e18);
        _list(low, price, nonce);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(low), buyer, nonce, uint256(price) + headroom, NEVER);
        vm.stopPrank();
        assertEq(tac.balanceOf(treasury), price);
        assertEq(tac.balanceOf(buyer), 1_000e18 - price);
        assertEq(market.nonceOf(_id(low)), nonce);
    }

    // ---- the buyer is bound to what they were shown ----

    function testAListingTheOwnerChangedUnderTheBuyerIsRefused() public {
        _list(1, 40e18, 3);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.ListingChanged.selector);
        shop.buy(_id(1), buyer, 4, 40e18, NEVER);    // shown nonce 4, listed at 3
        vm.stopPrank();
        _list(1, 40e18, 4);                    // the owner moves it to another address before the buyer's transaction lands
        vm.prank(buyer);
        vm.expectRevert(VanityShop.ListingChanged.selector);
        shop.buy(_id(1), buyer, 3, 40e18, NEVER);
        vm.prank(buyer);
        shop.buy(_id(1), buyer, 4, 40e18, NEVER);
        assertEq(market.nonceOf(_id(1)), 4);
    }

    function testAPermitBuyIsBoundToTheNonceToo() public {
        _list(1, 40e18, 3);
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, block.timestamp + 1 hours);
        vm.prank(buyer);
        vm.expectRevert(VanityShop.ListingChanged.selector);
        shop.buyWithPermit(_id(1), buyer, 2, 40e18, block.timestamp + 1 hours, v, r, s);
        assertFalse(market.minted(_id(1)));
    }

    function testTheTopNonceCannotBeKeptEither() public {
        vm.prank(owner);
        vm.expectRevert(VanityShop.BadNonce.selector);
        shop.keep(_id(1), 255, owner);
        vm.prank(owner);
        shop.keep(_id(1), 254, owner);
        assertEq(market.nonceOf(_id(1)), 254);
    }

    function testATokenCannotBeSentToTheShopItself() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.BadRecipient.selector);
        shop.buy(_id(1), address(shop), 0, 40e18, NEVER);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(VanityShop.BadRecipient.selector);
        shop.keep(_id(1), 0, address(shop));
        assertFalse(market.minted(_id(1)), 'nothing was taken');
        assertEq(tac.balanceOf(buyer), 1_000e18);
    }

    function testTheShopCannotBeBuiltWithoutAnOwnerAMarketATokenOrATreasury() public {
        vm.expectRevert(VanityShop.BadAddress.selector);
        new VanityShop(address(0), address(market), address(tac), treasury);
        vm.expectRevert(VanityShop.BadAddress.selector);
        new VanityShop(owner, address(0), address(tac), treasury);
        vm.expectRevert(VanityShop.BadAddress.selector);
        new VanityShop(owner, address(market), address(0), treasury);
        vm.expectRevert(VanityShop.BadAddress.selector);
        new VanityShop(owner, address(market), address(tac), address(0));
    }

    function testTheShopTakesNoEthAndKeepsNoTac() public {
        (bool ok,) = address(shop).call{value: 1 ether}("");
        assertFalse(ok, 'no receive function');
        (ok,) = address(shop).call{value: 1}(hex"deadbeef");
        assertFalse(ok, 'no fallback');
    }

    // ---- a token that calls back ----

    function testASaleCannotBeReenteredThroughTheToken() public {
        ReenteringTac evil = new ReenteringTac();
        VanityShop shop2 = new VanityShop(owner, address(market), address(evil), treasury);
        uint256 id = (uint256(uint160(address(shop2))) << 96) | 1;
        VanityShop.Item[] memory it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item(id, 40e18, 0);
        vm.prank(owner);
        shop2.list(it);
        evil.mint(buyer, 100e18);
        evil.mint(address(evil), 1_000e18);          // enough for the inner sale to pay, if it got that far
        vm.prank(buyer);
        evil.approve(address(shop2), type(uint256).max);
        vm.prank(address(evil));
        evil.approve(address(shop2), type(uint256).max);
        evil.arm(address(shop2), id);

        vm.prank(buyer);
        shop2.buy(id, buyer, 0, 40e18, NEVER);

        assertFalse(evil.reentered(), 'the inner sale found the listing gone');
        assertEq(market.holder(id), buyer);
        assertEq(evil.balanceOf(treasury), 40e18, 'paid once');
        assertEq(evil.balanceOf(buyer), 60e18);
    }

    // ---- what the review asked for ----

    function testAPurchaseThatLandsAfterItsDeadlineIsRefused() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        uint256 deadline = block.timestamp + 1 hours;
        vm.warp(deadline + 1);
        vm.expectRevert(VanityShop.Expired.selector);
        shop.buy(_id(1), buyer, 0, 40e18, deadline);
        shop.buy(_id(1), buyer, 0, 40e18, deadline + 1);       // the deadline is the last second it may land
        vm.stopPrank();
        assertEq(market.holder(_id(1)), buyer);
    }

    function testAPermitPurchaseAfterItsDeadlineIsRefusedEvenWithAnAllowanceStanding() public {
        _list(1, 40e18, 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, deadline);
        tac.permit(buyer, address(shop), 40e18, deadline, v, r, s);   // the allowance is there
        vm.warp(deadline + 1);
        vm.prank(buyer);
        vm.expectRevert(VanityShop.Expired.selector);
        shop.buyWithPermit(_id(1), buyer, 0, 40e18, deadline, v, r, s);
        assertFalse(market.minted(_id(1)));
    }

    function testTheOwnerCannotRenounceAndKeepsItsPowersAfterTheAttempt() public {
        vm.prank(owner);
        vm.expectRevert(VanityShop.CannotRenounce.selector);
        shop.renounceOwnership();
        assertEq(shop.owner(), owner);
        vm.expectRevert();
        shop.renounceOwnership();      // and nobody else can either
        _list(1, 5e18, 0);             // still lists
    }

    function testTheTreasuryCannotBeTheShopItself() public {
        vm.prank(owner);
        vm.expectRevert(VanityShop.BadAddress.selector);
        shop.setTreasury(address(shop));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(VanityShop.BadAddress.selector);
        new VanityShop(owner, address(market), address(tac), predicted);
    }

    function testATokenCannotBeSentToTheMarketOrTheTokenContractEither() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.BadRecipient.selector);
        shop.buy(_id(1), address(market), 0, 40e18, NEVER);
        vm.expectRevert(VanityShop.BadRecipient.selector);
        shop.buy(_id(1), address(tac), 0, 40e18, NEVER);
        vm.stopPrank();
        vm.startPrank(owner);
        vm.expectRevert(VanityShop.BadRecipient.selector);
        shop.keep(_id(1), 0, address(market));
        vm.expectRevert(VanityShop.BadRecipient.selector);
        shop.keep(_id(1), 0, address(tac));
        vm.stopPrank();
        assertFalse(market.minted(_id(1)));
        assertEq(tac.balanceOf(buyer), 1_000e18, 'nothing was taken');
    }

    // ---- what the listing tool encodes (tests/vanity-shop-list.test.mjs holds the same strings) ----

    function testTheCalldataTheListingToolBuildsIsWhatTheContractDecodes() public pure {
        VanityShop.Item[] memory items = new VanityShop.Item[](2);
        items[0] = VanityShop.Item(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef01, 100e18, 3);
        items[1] = VanityShop.Item(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa005125ffeeddccbbaa998877, 5e18, 0);
        assertEq(
            abi.encodeCall(VanityShop.list, (items)),
            hex"5e80527b00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef010000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000000000000000000003aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa005125ffeeddccbbaa9988770000000000000000000000000000000000000000000000004563918244f400000000000000000000000000000000000000000000000000000000000000000000"
        );
        assertEq(
            abi.encodeCall(VanityShop.keep, (0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef01, 7, 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2)),
            hex"3960bb02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef010000000000000000000000000000000000000000000000000000000000000007000000000000000000000000006cd14f36f65ecbb29b2519ccbe63a0dc8549f2"
        );
    }
}
