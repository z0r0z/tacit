// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {ShopZap} from "../src/ShopZap.sol";

interface IShopWires {
    function TAC() external view returns (address);
}

/// @notice Deploys ShopZap (pays for a VanityShop address with ETH in one transaction). Mainnet defaults. It has no owner and no setting, so any account can deploy it and nothing
///         depends on who did: the shop page is pointed at the address it prints (`ZAP` in dapp/shop/shelf.js), and that is the only step that makes it live.
///           forge script script/DeployShopZap.s.sol --rpc-url $RPC --sender $DEPLOYER                            (simulate: prints the address it would have and the page setting)
///           forge script script/DeployShopZap.s.sol --rpc-url $RPC --broadcast --private-key $KEY                (deploy)
///         ZAP_ZROUTER, ZAP_TAC and ZAP_SHOP are zRouter, TAC and the VanityShop on mainnet. The run refuses a shop whose TAC is another token.
///         To put it at an address bought from the shop instead, the shop page's form for a contract of one's own takes its creation code with these three addresses on the end
///         (abi-encoded, after the code); the constructor is payable, so ETH sent to the address the market deploys from beforehand cannot stop that deploy.
contract DeployShopZap is Script {
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address constant SHOP = 0x00000000000785882df83d4CC6ED45c21eB1176C;

    function run() external returns (ShopZap zap) {
        address zrouter = vm.envOr("ZAP_ZROUTER", ZROUTER);
        address tac = vm.envOr("ZAP_TAC", TAC);
        address shop = vm.envOr("ZAP_SHOP", SHOP);
        require(zrouter.code.length > 0, "no zRouter at ZAP_ZROUTER on this chain");
        require(tac.code.length > 0, "no token at ZAP_TAC on this chain");
        require(shop.code.length > 0, "no shop at ZAP_SHOP on this chain");
        require(IShopWires(shop).TAC() == tac, "that shop sells for another token than ZAP_TAC");

        vm.startBroadcast();
        zap = new ShopZap(zrouter, tac, shop);
        vm.stopBroadcast();

        require(zap.ZROUTER() == zrouter && zap.TAC() == tac && zap.SHOP() == shop, "the new contract is wired wrongly");
        console2.log("ShopZap:", address(zap));
        console2.log("zRouter:", zrouter);
        console2.log("TAC:    ", tac);
        console2.log("shop:   ", shop);
        console2.log("page:    set ZAP in dapp/shop/shelf.js to the address above (build, push); until it holds code the page offers no ETH button");
    }
}
