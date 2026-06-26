// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployCollateralEngine} from "../script/DeployCollateralEngine.s.sol";

contract DeployCollateralEngineAdminTest is Test {
    function test_default_admins_by_chain() public {
        DeployCollateralEngine script = new DeployCollateralEngine();
        address broadcaster = address(0xBEEF);

        assertEq(script.defaultEngineAdmin(1, broadcaster), script.MAINNET_OPS_MULTISIG(), "mainnet ops multisig");
        assertEq(script.defaultEngineAdmin(11155111, broadcaster), script.TEST_BOT_ADMIN(), "sepolia bot admin");
        assertEq(script.defaultEngineAdmin(31337, broadcaster), broadcaster, "local broadcaster");
    }
}
