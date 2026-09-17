// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";

/// @notice Deploy the ConfidentialRouter at a pre-mined CreateX vanity address (CREATE3: salt-based, so the address
///         does not depend on the bytecode). POOL, PUBLIC_AMM, SALT_ROUTER and EXPECTED_ROUTER come from the
///         environment; a dry run (no --broadcast) fails closed if the router would not land at EXPECTED_ROUTER.
contract DeployRouterCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        address pool = vm.envAddress("POOL");
        address publicAmm = vm.envAddress("PUBLIC_AMM");
        address expected = vm.envAddress("EXPECTED_ROUTER");
        bytes memory initCode = abi.encodePacked(
            type(ConfidentialRouter).creationCode, abi.encode(pool, publicAmm, ZROUTER, PERMIT2)
        );
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(vm.envBytes32("SALT_ROUTER"), initCode);
        vm.stopBroadcast();
        console2.log("router deployed at:", deployed);
        require(deployed == expected, "router did NOT land at the vanity address");
    }
}
