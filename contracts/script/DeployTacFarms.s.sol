// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {FarmController} from "../src/FarmController.sol";
import {WrappedTac} from "../src/WrappedTac.sol";
import {TacFarmFunder} from "../src/TacFarmFunder.sol";

/// One broadcast deploys everything a TAC-paying farm set needs on gen5: the wTAC wrapper, its escrow registration, the
/// one-transaction funder, and one escrow/receipt FarmController per pool. Env: POOL, TAC, GOV (immutable governor: notify + recover),
/// STAKE_0..STAKE_2 (each pool's LP-share id = keccak(poolId ‖ "lp")), PK. Dry run (no broadcast) on a fork first.
contract DeployTacFarms is Script {
    function run() external {
        address pool = vm.envAddress("POOL");
        address tac = vm.envAddress("TAC");
        address gov = vm.envAddress("GOV");
        bytes32[3] memory stakes = [vm.envBytes32("STAKE_0"), vm.envBytes32("STAKE_1"), vm.envBytes32("STAKE_2")];

        vm.startBroadcast(vm.envUint("PK"));
        WrappedTac wtac = new WrappedTac(tac);
        bytes32 wId = ConfidentialPool(payable(pool)).registerWrappedAuto(address(wtac), bytes32(0));
        TacFarmFunder funder = new TacFarmFunder(address(wtac), pool, wId);
        console2.log("wTAC", address(wtac));
        console2.log("wTAC asset id");
        console2.logBytes32(wId);
        console2.log("funder", address(funder));
        for (uint256 i = 0; i < 3; i++) {
            FarmController farm = new FarmController(pool, stakes[i], wId, true, true, gov, 0);
            console2.log("farm", i, address(farm));
        }
        vm.stopBroadcast();
    }
}
