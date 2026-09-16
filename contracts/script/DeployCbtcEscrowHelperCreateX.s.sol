// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {CbtcEscrowHelper} from "../src/CbtcEscrowHelper.sol";

/// @notice Deploy CbtcEscrowHelper via CreateX CREATE3. No vanity salt was mined for this one (the box's
///         OpenCL toolchain wasn't cooperating and this contract's address has no cross-chain-identity
///         requirement the way the core suite's does), so SALT is arbitrary — just guarded correctly (byte[20]
///         != 0x01, the "portable Random" form per ops/CREATEX-VANITY-DEPLOY.md).
///
///         LIVE on mainnet at EXPECTED below (tx 0xb32ea70a01a27f532aa4ac4fda7b7c006baf2db06075c1d22a5cee4ea7d9aa38,
///         block 25923989) — this script is kept for reproducibility, not as a pending action.
contract DeployCbtcEscrowHelperCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    // mainnet target — the real live CollateralEngine (contracts/deployments/1-createx.json)
    address constant COLLATERAL_ENGINE = 0x000000008cAD17f5BB485A7D521E89A9C4716cC0;

    bytes32 constant SALT = keccak256("tacit-cbtc-escrow-helper-v1");
    address constant EXPECTED = 0x1D60E0587F8d4e698baBf0fdd369442CC0311e4c;

    function run() external {
        require(uint8(SALT[20]) != 0x01, "salt byte[20] == 0x01 (redeploy-protection flag) - pick another");
        bytes memory initCode =
            abi.encodePacked(type(CbtcEscrowHelper).creationCode, abi.encode(COLLATERAL_ENGINE));
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(SALT, initCode);
        vm.stopBroadcast();
        console2.log("CbtcEscrowHelper deployed at:", deployed);
        require(deployed == EXPECTED, "did NOT land at the expected address");
    }
}
