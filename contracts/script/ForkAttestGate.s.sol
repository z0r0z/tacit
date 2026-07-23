// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// Pre-deploy GATE: on a mainnet fork, deploy the pool with the candidate seed digest + anchor and run the
/// REAL first attest (proof + public values from the box). It exercises every attest precondition the
/// contract enforces — SP1 proof verification, priorDigest == knownReflectionDigest, and the anchor/relay-tip
/// check that reverted UnanchoredReflection (0xd3897419) in production. If this returns without reverting,
/// the real deploy+attest will land. If it reverts, we do NOT deploy. Run:
///   forge script script/ForkAttestGate.s.sol:ForkAttestGate --fork-url $MAINNET_RPC
contract ForkAttestGate is Script {
    function run() external {
        ConfidentialPool pool = new ConfidentialPool(
            vm.envAddress("SP1_VERIFIER"),
            vm.envBytes32("PROGRAM_VKEY"),
            vm.envBytes32("BITCOIN_RELAY_VKEY"),
            vm.envAddress("CANONICAL_FACTORY"),
            vm.envAddress("HEADER_RELAY"),
            vm.envBytes32("GENESIS_REFLECTION_ANCHOR"),
            vm.envOr("REFLECTION_CONFIRMATIONS", uint256(6)),
            vm.envBytes32("REFLECTION_RESUME_DIGEST"),
            vm.envBytes32("TETH_BITCOIN_ID"),
            address(0) // engine not needed to validate the attest
        );
        console2.log("pool on fork:", address(pool));
        bytes memory pv = vm.envBytes("ATTEST_PV");
        bytes memory proof = vm.envBytes("ATTEST_PROOF");
        pool.attestBitcoinStateProven(pv, proof); // reverts if any precondition fails
        console2.log("ATTEST OK ON FORK - GATE PASSED");
    }
}
