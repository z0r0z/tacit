// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BtcCallExecutor} from "../src/BtcCallExecutor.sol";

/// @notice Deploy the BtcCallExecutor — the permissionless executor that fires a Bitcoin-authorized call
///         the pool has pre-committed (`pendingBtcCall`). Bound to one pool, immutable, custodies nothing.
///
///  Env:
///    POOL  (required) the deployed ConfidentialPool address
contract DeployBtcCallExecutor is Script {
    function run() external {
        address pool = vm.envAddress("POOL");
        require(pool != address(0) && pool.code.length != 0, "POOL not a contract");

        vm.startBroadcast();
        BtcCallExecutor exec = new BtcCallExecutor(pool);
        vm.stopBroadcast();

        console2.log("BtcCallExecutor:", address(exec));
        console2.log("pool           :", pool);
    }
}
