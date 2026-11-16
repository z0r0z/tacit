// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {VanityShop} from "../src/VanityShop.sol";

interface IMarketHash {
    function DEPLOY_PROXY_INITHASH() external view returns (bytes32);
}

interface ICreateX3 {
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
    function computeCreate3Address(bytes32 guardedSalt, address deployer) external pure returns (address computedAddress);
}

/// @notice Deploys VanityShop. Mainnet defaults. The shop's address leads every salt the pool's market miners grind, so it is final once mining starts.
///
///         With SHOP_SALT (a banked salt of the deployer: the pool's /prover/salt/bank, deployer 0x68575B07…) the shop goes to CreateX's CREATE3 address for that
///         salt, which depends on the salt and the deployer alone: the address is known before the deploy, whatever the owner and treasury, and no other
///         account can deploy to it on any chain. The address is the deployer key's to put code at, on every chain, until it has: deploy before the pool is told
///         the address (SALT_SHOP), and deploy on each chain a token is to be sold on. SHOP_PLAIN=1 deploys by a plain CREATE instead, to an address that depends
///         on the deployer's next nonce (a test, or a chain with no salt for it): do not publish that address before the deploy has landed.
///           SHOP_SALT=0x… forge script script/DeployVanityShop.s.sol --rpc-url $RPC --sender $DEPLOYER                (simulate: prints the address and the pool settings)
///           SHOP_SALT=0x… forge script script/DeployVanityShop.s.sol --rpc-url $RPC --broadcast --private-key $KEY    (deploy)
///         SHOP_EXPECTED (the address the bank lists for the salt) makes the run refuse any other. SHOP_OWNER and SHOP_TREASURY default to the ops multisig. The
///         owner can list, unlist, keep (mint to itself or anyone) and change the treasury, so a hot key is a bad owner: a multisig's delay is the price of that.
///         SHOP_MARKET and SHOP_TAC are the vanity market and TAC on mainnet.
contract DeployVanityShop is Script {
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    address constant MARKET = 0x000000000000b361194cfe6312EE3210d53C15AA;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    ICreateX3 constant CREATEX = ICreateX3(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    // the hash of the market's deploy proxy: the pool's miners hold the proxy code, so a market that hashes differently would be ground for wrongly
    bytes32 constant PROXY_INITHASH = 0x1decbcf04b355d500cbc3bd83c892545b4df34bd5b2c9d91b9f7f8165e2095c3;

    function run() external returns (VanityShop shop) {
        address owner = vm.envOr("SHOP_OWNER", OPS);
        address treasury = vm.envOr("SHOP_TREASURY", OPS);
        address market = vm.envOr("SHOP_MARKET", MARKET);
        address tac = vm.envOr("SHOP_TAC", TAC);
        bytes32 salt = vm.envOr("SHOP_SALT", bytes32(0));
        address expected = vm.envOr("SHOP_EXPECTED", address(0));

        require(salt != bytes32(0) || vm.envOr("SHOP_PLAIN", false), "set SHOP_SALT (a banked salt of the deployer), or SHOP_PLAIN=1 for an address that depends on the deployer's nonce");
        require(owner != address(0) && treasury != address(0), "owner and treasury must be set");
        require(owner.code.length > 0 || vm.envOr("SHOP_OWNER_IS_EOA", false), "SHOP_OWNER has no code on this chain (the ops multisig is not here): name an owner, or SHOP_OWNER_IS_EOA=1 for a key");
        require(market.code.length > 0, "no vanity market at SHOP_MARKET on this chain");
        require(tac.code.length > 0, "no token at SHOP_TAC on this chain");
        require(IMarketHash(market).DEPLOY_PROXY_INITHASH() == PROXY_INITHASH, "this market's deploy proxy is not the one the miners know");

        vm.startBroadcast();
        if (salt == bytes32(0)) {
            shop = new VanityShop(owner, market, tac, treasury);
        } else {
            (, address deployer,) = vm.readCallers();
            // CreateX guards a salt that leads with its sender and a zero flag byte as keccak256(sender ‖ salt): only that sender can deploy with it
            require(address(bytes20(salt)) == deployer, "this salt is not the deployer's: its first 20 bytes are another address");
            require(salt[20] == 0x00, "this salt's flag byte is not 0x00");
            address predicted = CREATEX.computeCreate3Address(keccak256(abi.encode(deployer, salt)), address(CREATEX));
            require(predicted.code.length == 0, "something is already at this salt's address (spent)");
            require(expected == address(0) || predicted == expected, "this salt's address is not SHOP_EXPECTED");
            bytes memory initCode = abi.encodePacked(type(VanityShop).creationCode, abi.encode(owner, market, tac, treasury));
            address deployed = CREATEX.deployCreate3(salt, initCode);
            require(deployed == predicted, "did NOT land at the predicted address");
            shop = VanityShop(deployed);
        }
        vm.stopBroadcast();

        require(shop.owner() == owner && shop.treasury() == treasury && address(shop.MARKET()) == market && shop.TAC() == tac, "wiring mismatch");

        console2.log("VanityShop deployed at:", address(shop));
        console2.log("  owner:   ", owner);
        console2.log("  treasury:", treasury);
        console2.log("The pool takes its salts with (tacit-api environment):");
        console2.log("  SALT_SHOP=", address(shop));
        console2.log("  SALT_SCHEMES=market,createx   (createx alone until then)");
    }
}
