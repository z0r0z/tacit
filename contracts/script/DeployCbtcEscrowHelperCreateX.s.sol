// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {CbtcEscrowHelper} from "../src/CbtcEscrowHelper.sol";

/// @notice Deploy CbtcEscrowHelper via CreateX CREATE3. The helper's constructor binds to one CollateralEngine,
///         so each engine needs its own helper: COLLATERAL_ENGINE and EXPECTED_CBTC_ESCROW_HELPER are required.
///         The live helper is listed in docs/DEPLOYMENTS.md.
contract DeployCbtcEscrowHelperCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        address collateralEngine = vm.envAddress("COLLATERAL_ENGINE");
        bytes32 salt = vm.envOr("SALT_CBTC_ESCROW_HELPER", keccak256("tacit-cbtc-escrow-helper-v1"));
        address expected = vm.envAddress("EXPECTED_CBTC_ESCROW_HELPER");
        require(uint8(salt[20]) != 0x01, "salt byte[20] == 0x01 (redeploy-protection flag) - pick another");
        bytes memory initCode =
            abi.encodePacked(type(CbtcEscrowHelper).creationCode, abi.encode(collateralEngine));
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(salt, initCode);
        vm.stopBroadcast();
        console2.log("CbtcEscrowHelper deployed at:", deployed);
        require(deployed == expected, "did NOT land at the expected address");
    }
}
