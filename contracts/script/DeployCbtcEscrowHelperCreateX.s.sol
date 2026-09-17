// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {CbtcEscrowHelper} from "../src/CbtcEscrowHelper.sol";

/// @notice Deploy CbtcEscrowHelper via CreateX CREATE3, parameterized per generation via env (COLLATERAL_ENGINE
///         / SALT / EXPECTED) since each generation's engine address differs and the helper's constructor binds
///         to one specific engine — a helper minted for a prior generation cannot be reused by the next one.
///
///         The FIRST generation's instance is LIVE on mainnet at 0x1D60E0587F8d4e698baBf0fdd369442CC0311e4c
///         (tx 0xb32ea70a01a27f532aa4ac4fda7b7c006baf2db06075c1d22a5cee4ea7d9aa38, block 25923989), bound to
///         engine 0x000000008cAD17f5BB485A7D521E89A9C4716cC0 — kept as the default fallback below purely for
///         reproducibility of that historical deploy, NOT as a value to reuse for a new generation.
contract DeployCbtcEscrowHelperCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        address collateralEngine = vm.envOr("COLLATERAL_ENGINE", address(0x000000008cAD17f5BB485A7D521E89A9C4716cC0));
        bytes32 salt = vm.envOr("SALT_CBTC_ESCROW_HELPER", keccak256("tacit-cbtc-escrow-helper-v1"));
        address expected = vm.envOr("EXPECTED_CBTC_ESCROW_HELPER", address(0x1D60E0587F8d4e698baBf0fdd369442CC0311e4c));
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
