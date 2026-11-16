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
        shop.buy(id, buyer, 3, 100e18, type(uint256).max);
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
        shop.buyWithPermit(id, buyer, 0, 25e18, deadline, v, r, s);
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

    // ---- the market's signature paths cannot reach the shop's ids ----
    // The market lets an id's owner (the top 160 bits) act by signature: `permitForAll` makes an operator who can mint all of an owner's ids, `claimGivenUpWithSig` and
    // `mintAndBuyWithSig` mint one. The owner here is the shop, a contract with no key and no ERC-1271 `isValidSignature`, so no signature can be valid for it. This
    // test is what keeps it so: a shop that ever answered ERC-1271 would let whoever could satisfy it mint every id it owns.
    function testNoSignatureCanMakeAnyoneTheShopsOperatorOrMintItsIds() public {
        if (!_fork()) return;
        uint256 id = _id(0xC);
        uint256 attackerKey = 0xA77AC;
        address attacker = vm.addr(attackerKey);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerKey, bytes32(uint256(1)));
        bytes memory sig = abi.encodePacked(r, s, v);
        uint256 deadline = block.timestamp + 1 hours;
        IMarketSigs market = IMarketSigs(address(MARKET));

        vm.expectRevert();
        market.permitForAll(address(shop), attacker, 0, deadline, sig);
        vm.prank(attacker);
        vm.expectRevert();
        market.claimGivenUpWithSig(attacker, id, 0, attacker, deadline, sig);
        vm.prank(attacker);
        vm.expectRevert();
        market.mintAndBuyWithSig(attacker, id, 0, attacker, 0, address(0), 0, deadline, sig);
        // an empty or zero signature fares no better
        vm.expectRevert();
        market.permitForAll(address(shop), attacker, 1, deadline, new bytes(65));
        vm.expectRevert();
        market.permitForAll(address(shop), attacker, 2, deadline, "");

        assertFalse(market.isApprovedForAll(address(shop), attacker));
        (bool minted,) = MARKET.getTokenData(id);
        assertFalse(minted);
        vm.prank(attacker);
        vm.expectRevert();
        IMarketMint(address(MARKET)).mint(attacker, id, 0);

        (bool ok,) = address(shop).staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", bytes32(uint256(1)), sig));
        assertFalse(ok, 'the shop answers no ERC-1271 query');
    }

    // ---- the banked salt (the pool's /prover/salt/bank, 45 bits; the address is what the bank lists) ----

    address constant DEPLOYER = 0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7;
    ICreateX3 constant CREATEX = ICreateX3(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    bytes32 constant BANKED_SALT = 0x68575b073de49a94e3e3acf6f3a0d6e3b66267c700511e15cfb659b100a2723d;
    address constant BANKED_ADDRESS = 0x00000000000785882df83d4CC6ED45c21eB1176C;

    function testTheBankedSaltPutsTheShopAtItsBankedAddressAndOnlyTheDeployerCanReachIt() public {
        if (!_fork()) return;
        bytes memory init = abi.encodePacked(type(VanityShop).creationCode, abi.encode(OPS, address(MARKET), address(TAC), OPS));
        assertEq(BANKED_ADDRESS.code.length, 0, 'the salt is unspent');
        assertEq(CREATEX.computeCreate3Address(keccak256(abi.encode(DEPLOYER, BANKED_SALT)), address(CREATEX)), BANKED_ADDRESS, 'the bank lists the address CreateX computes');

        // a stranger using the salt lands somewhere else: CreateX hashes it for a sender it does not lead with
        address stranger = address(0x5712A);
        vm.prank(stranger);
        address elsewhere = CREATEX.deployCreate3(BANKED_SALT, init);
        assertTrue(elsewhere != BANKED_ADDRESS);
        assertEq(BANKED_ADDRESS.code.length, 0, 'and the banked address is still free');

        vm.prank(DEPLOYER);
        address deployed = CREATEX.deployCreate3(BANKED_SALT, init);
        assertEq(deployed, BANKED_ADDRESS);
        VanityShop banked = VanityShop(deployed);
        assertEq(banked.owner(), OPS);
        assertEq(address(banked.MARKET()), address(MARKET));

        // the address does not depend on the constructor arguments: another owner, the same address (so the pool can name the shop before it is deployed)
        assertEq(CREATEX.computeCreate3Address(keccak256(abi.encode(DEPLOYER, BANKED_SALT)), address(CREATEX)), deployed);

        // and it is one use: the address is taken
        vm.prank(DEPLOYER);
        vm.expectRevert();
        CREATEX.deployCreate3{gas: 5_000_000}(BANKED_SALT, init);

        // the shop there sells: ids lead with its address
        uint256 id = (uint256(uint160(deployed)) << 96) | 0x1;
        VanityShop.Item[] memory it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item(id, 1e18, 0);
        vm.prank(OPS);
        banked.list(it);
        (uint128 price,) = banked.listings(id);
        assertEq(price, 1e18);
    }
}

interface IMarketMint {
    function mint(address to, uint256 id, uint8 nonce) external;
}

import {DeployVanityShop, ICreateX3} from "../script/DeployVanityShop.s.sol";

/// The deploy script on the fork: it deploys a working shop with the defaults, honours the overrides, and refuses what is not the market the miners know.
/// One test, in order: the script reads process environment, which tests running side by side would trample.
contract DeployVanityShopForkTest is Test {
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    address constant MARKET = 0x000000000000b361194cfe6312EE3210d53C15AA;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;

    function testTheScriptDeploysAWorkingShopHonoursItsSettingsAndRefusesAForeignMarket() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping"); return; }
        vm.createSelectFork(url);
        DeployVanityShop script = new DeployVanityShop();

        // a deploy names its salt, or says that it means a plain CREATE
        vm.expectRevert(bytes("set SHOP_SALT (a banked salt of the deployer), or SHOP_PLAIN=1 for an address that depends on the deployer's nonce"));
        script.run();
        vm.setEnv("SHOP_PLAIN", "1");

        // the defaults: the ops multisig owns it and is paid, on the real market and TAC
        VanityShop shop = script.run();
        assertEq(shop.owner(), OPS);
        assertEq(shop.treasury(), OPS);
        assertEq(address(shop.MARKET()), MARKET);
        assertEq(shop.TAC(), TAC);
        // and it sells: a listing by the owner, a purchase by anyone with TAC
        uint256 id = (uint256(uint160(address(shop))) << 96) | 0x77;
        VanityShop.Item[] memory it = new VanityShop.Item[](1);
        it[0] = VanityShop.Item(id, 10e18, 1);
        vm.prank(OPS);
        shop.list(it);
        address buyer = address(0xB0B);
        deal(TAC, buyer, 10e18);
        vm.startPrank(buyer);
        ITac(TAC).approve(address(shop), 10e18);
        shop.buy(id, buyer, 1, 10e18, type(uint256).max);
        vm.stopPrank();
        assertEq(IMarketFull(MARKET).ownerOf(id), buyer);

        // the settings; an owner with no code on the chain (a key, or the ops multisig on a chain it is not on) has to be asked for by name
        vm.setEnv("SHOP_OWNER", "0x00000000000000000000000000000000000A11CE");
        vm.setEnv("SHOP_TREASURY", "0x0000000000000000000000000000000000007EA5");
        vm.expectRevert(bytes("SHOP_OWNER has no code on this chain (the ops multisig is not here): name an owner, or SHOP_OWNER_IS_EOA=1 for a key"));
        script.run();
        vm.setEnv("SHOP_OWNER_IS_EOA", "1");
        VanityShop other = script.run();
        assertEq(other.owner(), address(0xA11CE));
        assertEq(other.treasury(), address(0x7EA5));
        vm.setEnv("SHOP_OWNER_IS_EOA", "0");
        vm.setEnv("SHOP_OWNER", "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2");
        vm.setEnv("SHOP_TREASURY", "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2");

        // a market whose deploy proxy hashes differently is not the one the miners ground for
        vm.etch(address(0xDEAD1), hex"7f000000000000000000000000000000000000000000000000000000000000000160005260206000f3");
        vm.setEnv("SHOP_MARKET", "0x00000000000000000000000000000000000DEAD1");
        vm.expectRevert(bytes("this market's deploy proxy is not the one the miners know"));
        script.run();
        // no market on the chain at all
        vm.setEnv("SHOP_MARKET", "0x0000000000000000000000000000000000000BAD");
        vm.expectRevert(bytes("no vanity market at SHOP_MARKET on this chain"));
        script.run();
        vm.setEnv("SHOP_MARKET", "0x000000000000b361194cfe6312EE3210d53C15AA");
        vm.setEnv("SHOP_PLAIN", "0");
    }
}

interface IMarketSigs {
    function permitForAll(address owner, address operator, uint256 nonce, uint256 deadline, bytes calldata signature) external;
    function claimGivenUpWithSig(address to, uint256 id, uint8 nonce, address claimer, uint256 deadline, bytes calldata signature) external;
    function mintAndBuyWithSig(address to, uint256 id, uint8 saltNonce, address beneficiary, uint256 sellerPrice, address buyer, uint256 nonce, uint256 deadline, bytes calldata signature) external payable;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}
