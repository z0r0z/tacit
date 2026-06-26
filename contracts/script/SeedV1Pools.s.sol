// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {FarmController} from "../src/FarmController.sol";

/// Seed an already-deployed CreateX v1 pool with the day-1 assets, the 5 TAC-centric pools, and a
/// cTAC-emitting FarmController per pool — the registration/createPair/farm steps the core CreateX
/// deploy intentionally skips. Mirrors DeployV1Suite step 6-8. Direct txs (no proof). Env:
///   POOL, ENGINE, TAC (existing ERC20), FARM_GOV (default ENGINE_ADMIN-style), FEE_BPS (default 30).
contract SeedV1Pools is Script {
    bytes32 constant CBTC_ZK_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;

    function run() external {
        ConfidentialPool pool = ConfidentialPool(vm.envAddress("POOL"));
        CollateralEngine engine = CollateralEngine(payable(vm.envAddress("ENGINE")));
        address tac = vm.envAddress("TAC");
        bytes32 tethId = vm.envOr("TETH_BITCOIN_ID", bytes32(0));
        address farmGov = vm.envOr("FARM_GOV", vm.envAddress("ENGINE_ADMIN"));
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(30)));

        vm.startBroadcast(vm.envUint("PK"));

        bytes32 cTac = pool.registerWrapped(tac, 1, bytes32(0), "Confidential TAC", "cTAC", 8);
        bytes32 cEth = tethId != bytes32(0) ? pool.localAssetOf(tethId) : bytes32(0);
        bytes32 cBtc = pool.localAssetOf(CBTC_ZK_ASSET_ID);
        bytes32 cUsd = pool.localAssetOf(engine.CUSD_ASSET_ID());
        console2.log("cTac/cEth/cBtc/cUsd resolved:");
        console2.logBytes32(cTac); console2.logBytes32(cEth); console2.logBytes32(cBtc); console2.logBytes32(cUsd);

        bytes32[5] memory legA = [cTac, cTac, cUsd, cUsd, cEth];
        bytes32[5] memory legB = [cEth, cBtc, cBtc, cEth, cBtc];
        string[5] memory labels = ["TAC/cETH", "TAC/cBTC", "cUSD/cBTC", "cUSD/cETH", "cETH/cBTC"];

        for (uint256 i = 0; i < 5; i++) {
            if (legA[i] == bytes32(0) || legB[i] == bytes32(0)) { console2.log(string.concat("  skip ", labels[i])); continue; }
            bytes32 poolId = pool.createPair(legA[i], legB[i], feeBps, 0, bytes32(0), 0);
            bytes32 lpShareId = keccak256(abi.encodePacked(poolId, "lp"));
            FarmController farm = new FarmController(address(pool), lpShareId, cTac, true, true, farmGov, 0);
            console2.log(string.concat("  pool ", labels[i], " farm:"), address(farm));
        }
        vm.stopBroadcast();
    }
}
