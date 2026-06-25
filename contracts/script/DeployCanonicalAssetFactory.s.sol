// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";

/// @notice Deploy the CanonicalAssetFactory — the stateless CREATE2 deployer the pool uses to lazily
///         issue a Tacit asset's public ERC20 (cBTC.tac, cUSD, bridged tokens). Standalone so a suite
///         deploy can reuse one factory across generations; the address is the only thing the pool needs.
///
///         Logs the factory's `extcodehash`, which is the value to pass as EXPECTED_FACTORY_CODEHASH to
///         DeployConfidentialPool (REQUIRED on mainnet when a factory is wired).
contract DeployCanonicalAssetFactory is Script {
    function run() external {
        vm.startBroadcast();
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        vm.stopBroadcast();

        console2.log("CanonicalAssetFactory:", address(factory));
        console2.log("EXPECTED_FACTORY_CODEHASH (for the pool deploy):");
        console2.logBytes32(address(factory).codehash);
    }
}
