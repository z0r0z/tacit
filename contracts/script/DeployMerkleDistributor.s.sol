// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";

/// @notice Deploy (and optionally fund) a MerkleDistributor for a public-ERC20 airdrop (e.g. canonical
///         bridged TAC). One instance per airdrop root; iterative airdrops redeploy with a fresh root.
///
///  Flow:
///    1. Build the tree off-chain (tools/airdrop/build-merkle.mjs) → MERKLE_ROOT + total + per-account proofs.
///    2. Deploy this with TOKEN / MERKLE_ROOT / CLAIM_DEADLINE / TOTAL_ALLOCATION / OWNER.
///       With FUND=true the broadcaster's TOKEN is transferred in and the funded balance is ASSERTED to
///       cover TOTAL_ALLOCATION — so a misfunded drop fails at deploy, not at the first claim that runs dry.
///    3. Recipients call claim(index, account, amount, proof).
///    4. After CLAIM_DEADLINE the OWNER calls sweep(to) to reclaim the unclaimed remainder.
///
///  Env:
///    TOKEN            (required) the ERC20 to distribute (must have code)
///    MERKLE_ROOT      (required) bytes32 root from the tree builder
///    CLAIM_DEADLINE   (required) unix seconds; clawback opens at/after this
///    TOTAL_ALLOCATION (required) sum of all leaf amounts (the builder's `total`) — the funding target
///    OWNER            (default broadcaster) sweep authority — on mainnet, the ops multisig
///    FUND             (default false) if true, transfer TOTAL_ALLOCATION of TOKEN from the broadcaster
///    MIN_CLAIM_WINDOW (default 14 days, seconds) reject a deadline closer than this — guards a fat-fingered
///                     early-clawback window; set to 0 to bypass for a deliberately short drop
contract DeployMerkleDistributor is Script {
    function run() external {
        address token = vm.envAddress("TOKEN");
        bytes32 root = vm.envBytes32("MERKLE_ROOT");
        uint64 deadline = uint64(vm.envUint("CLAIM_DEADLINE"));
        uint256 total = vm.envUint("TOTAL_ALLOCATION");
        address owner_ = vm.envOr("OWNER", msg.sender);
        bool fund = vm.envOr("FUND", false);
        uint256 minWindow = vm.envOr("MIN_CLAIM_WINDOW", uint256(14 days));

        require(token != address(0) && token.code.length != 0, "TOKEN not a contract");
        require(root != bytes32(0), "MERKLE_ROOT required");
        require(total != 0, "TOTAL_ALLOCATION required");
        require(deadline > block.timestamp + minWindow, "CLAIM_DEADLINE too soon");
        require(owner_ != address(0), "OWNER is zero");

        vm.startBroadcast();
        MerkleDistributor dist = new MerkleDistributor(token, root, deadline, owner_, total);
        if (fund) SafeTransferLib.safeTransfer(token, address(dist), total);
        vm.stopBroadcast();

        // If we funded here (or the instance was pre-funded), the live balance MUST cover the allocation —
        // otherwise the last claims revert first-come and the drop strands honest recipients. When funding
        // is a later orchestration step, balance is 0 here and the check defers to that step.
        uint256 bal = SafeTransferLib.balanceOf(token, address(dist));
        if (fund || bal != 0) require(bal >= total, "distributor underfunded vs TOTAL_ALLOCATION");

        console2.log("MerkleDistributor:", address(dist));
        console2.log("token            :", token);
        console2.log("owner (sweep)    :", owner_);
        console2.log("claim deadline   :", deadline);
        console2.log("total allocation :", total);
        console2.log("funded balance   :", bal);
        console2.log("merkle root      :");
        console2.logBytes32(root);
        if (!fund) console2.log("NEXT: transfer >= TOTAL_ALLOCATION of TOKEN to the distributor, then publish proofs");
        else console2.log("FUNDED + VERIFIED. NEXT: publish proofs");
    }
}
