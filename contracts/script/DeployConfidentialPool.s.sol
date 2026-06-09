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
    // Confidential guest vkey: the complete gen-1 op set — wrap/transfer/unwrap/bridge_burn/
    // bridge_mint — plus the improved-platinum cross-lane non-membership gate (IMT,
    // bitcoinSpentRoot), OP_ATTEST_META (trustless first-mint metadata from the etch), and
    // OP_SWAP (confidential AMM batch against public pool reserves). Pinned to the committed
    // canonical ELF: sp1/confidential/elf/cxfer-guest, sha256 4ee12556… (verify-vkey-pin.sh).
    // A real Groth16 of this ELF verifies on-chain at this vkey (test/ConfidentialSwapProofReal).
    // Override via PROGRAM_VKEY env if the guest changes. (Prior: 0x0063293d, 0x00b3ebb4, 0x00f02859.)
    bytes32 constant DEFAULT_VKEY = 0x00bc5661436d99a5beaed7d7c5d9c99ceb9f67c1c42d74c845d97fd83874c93d;

    function run() external {
        address sp1Verifier = vm.envAddress("SP1_VERIFIER");
        require(sp1Verifier != address(0), "set SP1_VERIFIER (pinned immutable Groth16 leaf)");
        bytes32 vkey = vm.envOr("PROGRAM_VKEY", DEFAULT_VKEY);
        // Bitcoin-state relay vkey: an SP1 proof against it is the ONLY way to attest the
        // Bitcoin pool root / spent-set (no trusted oracle). bytes32(0) deploys with
        // cross-chain attestation disabled. The reflection guest is GPU-proven + on-chain
        // verified (ConfidentialReflectionProofReal) at vkey
        // 0x00116c0299a1093b9d25cc6e2728fae76ad03be1257b9dfbd00e6430d573303e — set
        // BITCOIN_RELAY_VKEY to it once the worker produces reflection proofs continuously.
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
