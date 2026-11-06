// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TacitBlocks, ISP1BlockVerifier} from "../src/TacitBlocks.sol";

/// @notice Deploys TacitBlocks.
///
///  - SP1_VERIFIER MUST be the immutable SP1VerifierGroth16 leaf of the SP1 version the block program is built
///    with, never the owner-upgradeable gateway: the contract holds it immutable and every landing trusts it.
///    EXPECTED_VERIFIER_CODEHASH (the leaf's extcodehash) is required on mainnet and checked wherever it is set.
///  - BLOCK_VKEY is the block program's verifying key (`cargo prove vkey` on tacit-block's ELF), SPEND_VK the spend
///    relation as the program commits it (tacit-block `fixture` prints it as spendVk), SEQUENCER and WINDOW the
///    sequencer and its window (at most a day).
///  - The chain's binding is derived by the contract from the chain id and its own address; the sequencer reads
///    it as CHAIN() and the wallets put it in every spend's body.
contract DeployTacitBlocks is Script {
    function run() external returns (TacitBlocks blocks) {
        address verifier = vm.envAddress("SP1_VERIFIER");
        require(verifier.code.length != 0, "SP1_VERIFIER has no code");
        bytes32 expected = vm.envOr("EXPECTED_VERIFIER_CODEHASH", bytes32(0));
        require(block.chainid != 1 || expected != bytes32(0), "mainnet: set EXPECTED_VERIFIER_CODEHASH to the immutable SP1VerifierGroth16 leaf's codehash");
        if (expected != bytes32(0)) require(verifier.codehash == expected, "SP1_VERIFIER codehash != EXPECTED_VERIFIER_CODEHASH (a gateway or another version?)");
        bytes32 blockVkey = vm.envBytes32("BLOCK_VKEY");
        bytes32 spendVk = vm.envBytes32("SPEND_VK");
        address sequencer = vm.envAddress("SEQUENCER");
        uint256 window = vm.envOr("WINDOW", uint256(600));
        vm.startBroadcast();
        blocks = new TacitBlocks(ISP1BlockVerifier(verifier), blockVkey, spendVk, sequencer, window);
        vm.stopBroadcast();
        console2.log("TacitBlocks", address(blocks));
        console2.logBytes32(blocks.CHAIN());
    }
}
