// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";

/// @notice Deploy the fee-enhanced ConfidentialRouter at a pre-mined CreateX vanity address. CREATE3 address
///         is salt-based (bytecode-independent), so the free SALT_BTC_CALL_EXECUTOR salt → 0x00000000d82bd6…
///         works for the new bytecode. Dry-run (no --broadcast) simulates against the fork and the require
///         below fails closed if it wouldn't land at the vanity address.
contract DeployRouterCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    // mainnet targets (from dapp/confidential-deployments.js)
    address constant POOL = 0x0000000000c5B537A7c3622d1418D5771914C03D;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant SALT = 0xe324dae6d50d9b024015cf000000000000000000000000000000000000000000;
    address constant EXPECTED = 0x00000000D82bD610585828a1Ef12BFe6921aE06A;

    function run() external {
        bytes memory initCode = abi.encodePacked(
            type(ConfidentialRouter).creationCode, abi.encode(POOL, ZROUTER, PERMIT2)
        );
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(SALT, initCode);
        vm.stopBroadcast();
        console2.log("router deployed at:", deployed);
        require(deployed == EXPECTED, "router did NOT land at the vanity address");
    }
}
