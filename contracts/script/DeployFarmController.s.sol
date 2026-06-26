// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FarmController} from "../src/FarmController.sol";

/// @notice Deploy a FarmController — a confidential reward farm over a deployed ConfidentialPool. The farm is an
///         `ICdpController`, so the pool needs NO new seam: bond/harvest/unbond reuse the CDP call sites
///         (positionLeaf sentinel). This deploys the controller; FUNDING is a separate funder action:
///         `pool.farmEscrow(controller, REWARD_ASSET, amount, 0)` (ESCROW) then `controller.notifyRewardAmount`,
///         and the pool operator must pin `farmRewardAsset` for the reward asset. (TSR savers do NOT need a
///         FarmController — the CollateralEngine is itself the savings controller; this is for AMM/LP-share or
///         token-incentive farms.)
///
/// Env:
///   POOL          (required) the deployed ConfidentialPool address
///   STAKE_ASSET   (required) bytes32 — the staked asset (an LP-share asset id, or a token to lock)
///   REWARD_ASSET  (required) bytes32 — ESCROW: an escrow-backed pool asset; MINT: keccak("tacit-cdp-debt-v1"‖controller)
///   ESCROW_MODE   (default true)  — true = treasury-backed refundable rewards; false = controller-minted (inflationary)
///   RECEIPT_MODE  (default true)  — true = only receipt bonds (no bare position-lock rps dilution)
///   FARM_GOV      (default broadcaster) — notify/recover/setLockUntil authority (the farm creator/funder)
///   LOCK_UNTIL    (default 0)     — global unbond lock-up (gov may only shorten/clear it)
contract DeployFarmController is Script {
    function run() external {
        address pool = vm.envAddress("POOL");
        bytes32 stakeAsset = vm.envBytes32("STAKE_ASSET");
        bytes32 rewardAsset = vm.envBytes32("REWARD_ASSET");
        bool escrowMode = vm.envOr("ESCROW_MODE", true);
        bool receiptMode = vm.envOr("RECEIPT_MODE", true);
        address gov = vm.envOr("FARM_GOV", msg.sender);
        uint256 lockUntil = vm.envOr("LOCK_UNTIL", uint256(0));

        require(pool != address(0) && pool.code.length != 0, "POOL not a contract");
        require(stakeAsset != bytes32(0) && rewardAsset != bytes32(0), "STAKE_ASSET / REWARD_ASSET required");
        require(gov != address(0), "FARM_GOV is zero");

        vm.startBroadcast();
        FarmController farm = new FarmController(pool, stakeAsset, rewardAsset, escrowMode, receiptMode, gov, lockUntil);
        vm.stopBroadcast();

        console2.log("FarmController :", address(farm));
        console2.log("pool          :", pool);
        console2.log("gov           :", gov);
        console2.log("escrowMode    :", escrowMode);
        console2.log("receiptMode   :", receiptMode);
        console2.log("lockUntil     :", lockUntil);
        console2.log("stakeAsset    :");
        console2.logBytes32(stakeAsset);
        console2.log("rewardAsset   :");
        console2.logBytes32(rewardAsset);
        console2.log(
            "NEXT (ESCROW): funder calls pool.farmEscrow(farm, REWARD_ASSET, amount, 0), then gov calls farm.notifyRewardAmount(reward, duration); pool operator pins farmRewardAsset"
        );
    }
}
