// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {CbtcEscrowHelperTipForwarder} from "../src/CbtcEscrowHelperTipForwarder.sol";

/// @notice Deploy CbtcEscrowHelperTipForwarder via CreateX CREATE3. Stateless and helper-scoped only (no
///         asset/outpoint), so one deployment covers every escrow-and-settle call against that helper.
contract DeployCbtcEscrowHelperTipForwarderCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        address helper = vm.envOr("CBTC_ESCROW_HELPER", address(0x00000000689C71E690E5842dF088AF97F9d4f71b));
        bytes32 salt = vm.envBytes32("SALT_CBTC_ESCROW_HELPER_TIP_FORWARDER");
        address expected = vm.envAddress("EXPECTED_CBTC_ESCROW_HELPER_TIP_FORWARDER");
        require(uint8(salt[20]) != 0x01, "salt byte[20] == 0x01 (redeploy-protection flag) - pick another");
        bytes memory initCode = abi.encodePacked(type(CbtcEscrowHelperTipForwarder).creationCode, abi.encode(helper));
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(salt, initCode);
        vm.stopBroadcast();
        console2.log("CbtcEscrowHelperTipForwarder deployed at:", deployed);
        require(deployed == expected, "did NOT land at the expected address");
    }
}
