// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// @notice Deploy ConfidentialPool, wired to the SP1 verifier and the full
///         confidential guest's program vkey.
///
///  - PROGRAM_VKEY defaults to the full-guest vkey (contracts/sp1/confidential,
///    derived via `cargo prove vkey`); override only after a guest change.
///  - SP1_VERIFIER MUST be the SP1 verifier deployed on the target network. Pin
///    the **immutable Groth16 verifier leaf**, not the upgradeable gateway — the
///    tETH hardening lesson (no owner-upgradeable component on the verify path).
///  - The pool is multi-asset; register assets after deploy with
///    `registerWrapped(underlying, unitScale, crossChainLink, name, symbol, decimals)`.
///    For a testnet round-trip, set SAMPLE_UNDERLYING (+ optional SAMPLE_*) and
///    one asset is registered in the same broadcast.
///
///  Sepolia:
///    SP1_VERIFIER=0x... forge script script/DeployConfidentialPool.s.sol \
///      --rpc-url $RPC --private-key $PK --broadcast --verify
contract DeployConfidentialPool is Script {
    // Confidential guest vkey: the complete gen-1 op set — wrap/transfer/unwrap/
    // bridge_burn/bridge_mint — plus the improved-platinum cross-lane non-membership
    // gate (IMT, bitcoinSpentRoot) and OP_ATTEST_META (trustless first-mint metadata from
    // the etch). 2026-06-08; built + executed on the box (PLATINUM_OK). Override via
    // PROGRAM_VKEY env if the guest changes. (Prior op set: 0x0063293d…)
    bytes32 constant DEFAULT_VKEY = 0x00630a966a8f7aed7bdcea1d02318fee16456b6b3782bdd16765c0d8b1d1cbaa;

    function run() external {
        address sp1Verifier = vm.envAddress("SP1_VERIFIER");
        require(sp1Verifier != address(0), "set SP1_VERIFIER (pinned immutable Groth16 leaf)");
        bytes32 vkey = vm.envOr("PROGRAM_VKEY", DEFAULT_VKEY);
        // Bitcoin-state relay vkey: an SP1 proof against it is the ONLY way to attest the
        // Bitcoin pool root / spent-set (no trusted oracle). bytes32(0) deploys with
        // cross-chain attestation disabled until the relay prover's vkey is known.
        bytes32 bitcoinRelayVKey = vm.envOr("BITCOIN_RELAY_VKEY", bytes32(0));
        // Canonical-asset factory: lets the pool lazily deploy a Tacit asset's public ERC20
        // on first bridge_mint with the guest-proven metadata. address(0) = explicit
        // registerMintedAuto only (auto-register disabled).
        address canonicalFactory = vm.envOr("CANONICAL_FACTORY", address(0));

        vm.startBroadcast();
        ConfidentialPool pool = new ConfidentialPool(sp1Verifier, vkey, bitcoinRelayVKey, canonicalFactory);

        address sampleUnderlying = vm.envOr("SAMPLE_UNDERLYING", address(0));
        bytes32 sampleAsset;
        if (sampleUnderlying != address(0)) {
            sampleAsset = pool.registerWrapped(
                sampleUnderlying,
                vm.envOr("SAMPLE_UNIT_SCALE", uint256(1)),
                bytes32(0),
                vm.envOr("SAMPLE_NAME", string("Confidential Sample")),
                vm.envOr("SAMPLE_SYMBOL", string("cSMPL")),
                uint8(vm.envOr("SAMPLE_DECIMALS", uint256(18)))
            );
        }
        vm.stopBroadcast();

        console2.log("ConfidentialPool:", address(pool));
        console2.log("SP1 verifier:    ", sp1Verifier);
        console2.log("program vkey:");
        console2.logBytes32(vkey);
        console2.log("genesis root:");
        console2.logBytes32(pool.currentRoot());
        console2.log("chain binding:");
        console2.logBytes32(pool.CHAIN_BINDING());
        if (sampleUnderlying != address(0)) {
            console2.log("sample asset underlying:", sampleUnderlying);
            console2.logBytes32(sampleAsset);
        }
    }
}
