// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {VanityShop} from "../src/VanityShop.sol";

interface IMarketFull {
    function ownerOf(uint256 id) external view returns (address);
    function addressOf(uint256 id) external view returns (address);
    function computeAddress(bytes32 salt, uint8 nonce) external view returns (address);
    function deploy(uint256 id, bytes calldata initcode) external payable returns (address);
    function getTokenData(uint256 id) external view returns (bool minted, uint8 nonce);
}

interface ITac {
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// The shop against the live vanity market and the live TAC on a mainnet fork. Requires an RPC URL:
///   FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-path test/VanityShopFork.t.sol
/// Skips (not fails) when FORK_URL is unset.
contract VanityShopForkTest is Test {
    IMarketFull constant MARKET = IMarketFull(0x000000000000b361194cfe6312EE3210d53C15AA);
    ITac constant TAC = ITac(0xA1313eb9f3A445606D9583bcAc3ebeB56a858279);
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;

    VanityShop shop;
    uint256 buyerKey = 0xB0B;
    address buyer;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping"); return false; }
        vm.createSelectFork(url);
        buyer = vm.addr(buyerKey);
        shop = new VanityShop(OPS, address(MARKET), address(TAC), OPS);
        deal(address(TAC), buyer, 1_000e18);
        return true;
    }

    function _id(uint96 low) internal view returns (uint256) { return (uint256(uint160(address(shop))) << 96) | low; }

    function _list(uint96 low, uint128 price, uint8 nonce) internal {
        VanityShop.Item[] memory it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item(_id(low), price, nonce);
        vm.prank(OPS);
        shop.list(it);
    }

    // a one-byte contract: its init code stores 0x01 and returns it
    bytes constant INITCODE = hex"600160005360016000f3";

    function testASaleMintsTheRealTokenAndTheBuyerDeploysToTheListedAddress() public {
        if (!_fork()) return;
        uint256 id = _id(0x1234);
        address vanity = MARKET.computeAddress(bytes32(id), 3);
        assertEq(vanity.code.length, 0, 'nothing is at the address yet');
        _list(0x1234, 100e18, 3);

        uint256 treasuryBefore = TAC.balanceOf(OPS);
        vm.startPrank(buyer);
        TAC.approve(address(shop), 100e18);
        shop.buy(id, buyer, 100e18);
        vm.stopPrank();

        assertEq(MARKET.ownerOf(id), buyer);
        assertEq(MARKET.addressOf(id), vanity, 'the token stands for the address the listing named');
        (bool minted, uint8 nonce) = MARKET.getTokenData(id);
        assertTrue(minted);
        assertEq(nonce, 3);
        assertEq(TAC.balanceOf(OPS) - treasuryBefore, 100e18);
        assertEq(TAC.balanceOf(address(shop)), 0);

        vm.prank(buyer);
        address deployed = MARKET.deploy(id, INITCODE);
        assertEq(deployed, vanity, 'the contract lands at the vanity address');
        assertEq(vanity.code.length, 1);
    }

    function testTheLiveTacTakesTheBuyersPermit() public {
        if (!_fork()) return;
        uint256 id = _id(0x5678);
        _list(0x5678, 25e18, 0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), buyer, address(shop), 25e18, TAC.nonces(buyer), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", TAC.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(buyer);
        shop.buyWithPermit(id, buyer, 25e18, deadline, v, r, s);
        assertEq(MARKET.ownerOf(id), buyer);
    }

    function testKeepMintsToTheOpsAddressAndAnyoneElseCannotMintTheShopsIds() public {
        if (!_fork()) return;
        uint256 id = _id(0x9);
        _list(0x9, 7e18, 0);
        vm.prank(OPS);
        shop.keep(id, 0, OPS);
        assertEq(MARKET.ownerOf(id), OPS);
        // the market's own mint is the id's owner's: the shop is that owner, and it mints only through its own functions
        vm.prank(buyer);
        vm.expectRevert();
        IMarketMint(address(MARKET)).mint(buyer, _id(0xA), 0);
    }

    function testAnIdTheMarketAlreadyHasCannotBeListed() public {
        if (!_fork()) return;
        _list(0xB, 1e18, 0);
        vm.prank(OPS);
        shop.keep(_id(0xB), 0, OPS);
        VanityShop.Item[] memory it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item(_id(0xB), 1e18, 0);
        vm.prank(OPS);
        vm.expectRevert(VanityShop.AlreadyMinted.selector);
        shop.list(it);
    }
}

interface IMarketMint {
    function mint(address to, uint256 id, uint8 nonce) external;
}
