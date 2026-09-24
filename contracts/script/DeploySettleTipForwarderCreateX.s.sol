// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {SettleTipForwarder} from "../src/SettleTipForwarder.sol";

/// @notice Deploy SettleTipForwarder via CreateX CREATE3. Stateless and pool-scoped only (no asset), so
///         one deployment covers every asset's self-settle path against that pool.
contract DeploySettleTipForwarderCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        address pool = vm.envOr("SETTLE_POOL", address(0x000000000Ed1eabD231Be41d93b719056F7febFC));
        bytes32 salt = vm.envBytes32("SALT_SETTLE_TIP_FORWARDER");
        address expected = vm.envAddress("EXPECTED_SETTLE_TIP_FORWARDER");
        require(uint8(salt[20]) != 0x01, "salt byte[20] == 0x01 (redeploy-protection flag) - pick another");
        bytes memory initCode = abi.encodePacked(type(SettleTipForwarder).creationCode, abi.encode(pool));
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(salt, initCode);
        vm.stopBroadcast();
        console2.log("SettleTipForwarder deployed at:", deployed);
        require(deployed == expected, "did NOT land at the expected address");
    }
}
