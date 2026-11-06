// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TacitBlocks, ISP1BlockVerifier, ITurns} from "../src/TacitBlocks.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";

/// @notice Deploys TacitSeats (whose turn it is to land) and TacitBlocks.
///
///  - SP1_VERIFIER MUST be the immutable SP1VerifierGroth16 leaf of the SP1 version the block program is built
///    with, never the owner-upgradeable gateway: the contract holds it immutable and every landing trusts it.
///    EXPECTED_VERIFIER_CODEHASH (the leaf's extcodehash) is required on mainnet and checked wherever it is set.
///  - BLOCK_VKEY is the block program's verifying key (`cargo prove vkey` on tacit-block's ELF), SPEND_VK the spend
///    relation as the program commits it (tacit-block `fixture` prints it as spendVk), WINDOW how long after a
///    landing only the turn's leader may land (at most a day), FORCE_DELAY how long a block may leave an entry of
///    the queue behind (ten minutes to a day; longer than a block takes to prove).
///  - TAC is the TAC ERC-20 the seats lock, SEAT the TAC one seat locks, SLOT_BLOCKS how many Ethereum blocks each
///    turn lasts (5 to 300; 50 is about ten minutes) and BOOTSTRAP who leads while no one holds a seat.
///  - The chain's binding is derived by the contract from the chain id and its own address; a leader reads
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
        address tac = vm.envAddress("TAC");
        uint256 seat = vm.envUint("SEAT");
        uint256 slot = vm.envOr("SLOT_BLOCKS", uint256(50));
        address bootstrap = vm.envAddress("BOOTSTRAP");
        uint256 window = vm.envOr("WINDOW", uint256(600));
        uint256 forceDelay = vm.envOr("FORCE_DELAY", uint256(1 hours));
        vm.startBroadcast();
        TacitSeats turns = new TacitSeats(IERC20Seats(tac), seat, slot, bootstrap);
        blocks = new TacitBlocks(ISP1BlockVerifier(verifier), blockVkey, spendVk, ITurns(address(turns)), window, forceDelay);
        vm.stopBroadcast();
        console2.log("TacitSeats", address(turns));
        console2.log("TacitBlocks", address(blocks));
        console2.logBytes32(blocks.CHAIN());
    }
}
