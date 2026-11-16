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
        vm.expectRevert(VanityShop.BadListing.selector);
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
        shop.buy(_id(1), to, 40e18);
        vm.stopPrank();
        assertEq(tac.balanceOf(treasury), 40e18);
        assertEq(tac.balanceOf(buyer), 960e18);
        assertEq(tac.balanceOf(address(shop)), 0, 'the shop holds nothing');
        assertEq(market.holder(_id(1)), to);
        assertEq(market.nonceOf(_id(1)), 5, 'the listed nonce is the token\'s');
        (uint128 price,) = shop.listings(_id(1));
        assertEq(price, 0);
    }

    function testASecondBuyOfTheSameIdFails() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(1), buyer, 40e18);
        vm.expectRevert(VanityShop.NotListed.selector);
        shop.buy(_id(1), buyer, 40e18);
        vm.stopPrank();
    }

    function testAnUnlistedIdCannotBeBought() public {
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.NotListed.selector);
        shop.buy(_id(9), buyer, 1_000e18);
        vm.stopPrank();
    }

    function testAPriceThatMovedAboveTheBuyersMaxIsRefused() public {
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert(VanityShop.PriceAboveMax.selector);
        shop.buy(_id(1), buyer, 39e18);
        vm.stopPrank();
        _list(1, 400e18, 0);
        vm.prank(buyer);
        vm.expectRevert(VanityShop.PriceAboveMax.selector);
        shop.buy(_id(1), buyer, 40e18);
    }

    function testNoAllowanceOrNoBalanceMeansNoSale() public {
        _list(1, 40e18, 0);
        vm.prank(buyer);
        vm.expectRevert();
        shop.buy(_id(1), buyer, 40e18);
        _list(2, 5_000e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        vm.expectRevert();
        shop.buy(_id(2), buyer, 5_000e18);
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
        shop.buyWithPermit(_id(1), buyer, 40e18, block.timestamp + 1 hours, v, r, s);
        assertEq(market.holder(_id(1)), buyer);
        assertEq(tac.balanceOf(treasury), 40e18);
    }

    function testAPermitSomeoneElseAlreadyUsedStillBuysWhileTheAllowanceStands() public {
        _list(1, 40e18, 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(40e18, deadline);
        tac.permit(buyer, address(shop), 40e18, deadline, v, r, s);   // a bystander submits the buyer's signature first
        vm.prank(buyer);
        shop.buyWithPermit(_id(1), buyer, 40e18, deadline, v, r, s);
        assertEq(market.holder(_id(1)), buyer);
    }

    function testABadPermitWithNoAllowanceBuysNothing() public {
        _list(1, 40e18, 0);
        vm.prank(buyer);
        vm.expectRevert();
        shop.buyWithPermit(_id(1), buyer, 40e18, block.timestamp + 1 hours, 27, bytes32(uint256(1)), bytes32(uint256(2)));
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
        shop.buy(_id(1), thief, 40e18);
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
        shop.buy(_id(1), buyer, 40e18);
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
        shop.buy(_id(1), buyer, 40e18);
        vm.stopPrank();
    }

    function testTheTreasuryIsTheOwnersToChangeAndNeverEmpty() public {
        vm.startPrank(owner);
        vm.expectRevert(VanityShop.BadTreasury.selector);
        shop.setTreasury(address(0));
        shop.setTreasury(address(0xBA5E));
        vm.stopPrank();
        _list(1, 40e18, 0);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(1), buyer, 40e18);
        vm.stopPrank();
        assertEq(tac.balanceOf(address(0xBA5E)), 40e18);
        assertEq(tac.balanceOf(treasury), 0);
        vm.expectRevert(VanityShop.BadTreasury.selector);
        new VanityShop(owner, address(market), address(tac), address(0));
    }

    function testFuzzTheTreasuryGetsExactlyTheListedPrice(uint128 price, uint8 nonce, uint96 low) public {
        price = uint128(bound(price, 1, 1_000e18));
        nonce = uint8(bound(nonce, 0, 254));
        _list(low, price, nonce);
        vm.startPrank(buyer);
        tac.approve(address(shop), type(uint256).max);
        shop.buy(_id(low), buyer, price);
        vm.stopPrank();
        assertEq(tac.balanceOf(treasury), price);
        assertEq(tac.balanceOf(buyer), 1_000e18 - price);
        assertEq(market.nonceOf(_id(low)), nonce);
    }
}
