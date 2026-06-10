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
    // bridge_mint — plus the cross-lane non-membership gate (IMT, bitcoinSpentRoot), OP_ATTEST_META
    // (trustless first-mint metadata from the etch), OP_SWAP (confidential AMM batch against public
    // pool reserves), and OP_LP_ADD/OP_LP_REMOVE (confidential liquidity: in-ratio add minting a
    // shielded LP-share note, proportional remove). Swap/LP amounts are bound by an opening sigma
    // (proof of knowledge of the note blinding) so the settle prover never learns r. Pinned to the
    // committed canonical ELF: sp1/confidential/elf/cxfer-guest, sha256 4a64dd59… (elf-vkey-pin.json).
    // A real Groth16 of this ELF verifies on-chain at this vkey (test/ConfidentialSwapProofReal +
    // ConfidentialLpProofReal). Override via PROGRAM_VKEY env if the guest changes.
    // (Prior: 0x0063293d, 0x00b3ebb4, 0x00f02859, 0x00bc5661, 0x00cc4e72 — the pre-opening-sigma guest.)
    bytes32 constant DEFAULT_VKEY = 0x00d0fb85d51de5b0743bce2161dcfca3d36f5ce67eb00b8dda0fe7a999939eeb;

    function run() external {
        address sp1Verifier = vm.envAddress("SP1_VERIFIER");
        require(sp1Verifier != address(0), "set SP1_VERIFIER (pinned immutable Groth16 leaf)");
        bytes32 vkey = vm.envOr("PROGRAM_VKEY", DEFAULT_VKEY);
        // Bitcoin-state relay vkey: an SP1 proof against it is the ONLY way to attest the
        // Bitcoin pool root / spent-set (no trusted oracle). bytes32(0) deploys with cross-chain
        // attestation disabled. The reflection guest is GPU-proven + on-chain verified
        // (ConfidentialReflectionProofReal); set BITCOIN_RELAY_VKEY to the CURRENT pinned value in
        // sp1/confidential/elf-vkey-pin.json (`.bitcoin_relay_vkey`) — the require below enforces
        // that it equals the pin, so the deploy fails closed rather than trust a stale literal.
        bytes32 bitcoinRelayVKey = vm.envOr("BITCOIN_RELAY_VKEY", bytes32(0));
        // Canonical-asset factory: lets the pool lazily deploy a Tacit asset's public ERC20 from
        // the guest-proven etch metadata (attest_meta) — the only path that establishes a
        // cross-chain registry link. address(0) leaves auto-register disabled (local assets only).
        address canonicalFactory = vm.envOr("CANONICAL_FACTORY", address(0));
        // Bitcoin light relay (BitcoinLightRelay) used to anchor each reflection proof's header tip to
        // canonical Bitcoin. REQUIRED when BITCOIN_RELAY_VKEY != 0 (the ctor enforces it); address(0)
        // for an Ethereum-only deploy. GENESIS_REFLECTION_ANCHOR = the Bitcoin block hash the first
        // reflection batch resumes from (headers[0]'s prev), i.e. the relay's tip at activation.
        address headerRelay = vm.envOr("HEADER_RELAY", address(0));
        bytes32 genesisReflectionAnchor = vm.envOr("GENESIS_REFLECTION_ANCHOR", bytes32(0));

        // ── Coherence guards (the tETH deploy bar): the deployed guest must be the proven one ──
        // Pin cross-check: the PROGRAM_VKEY must equal the committed elf-vkey-pin.json
        // program_vkey, else the box's canonical-ELF proofs would all revert on the live pool.
        // This catches the exact drift the repo's docs showed (stale 0x0063293d/0x00f02859 vs the
        // pinned 0x00d0fb85). An intentional guest change sets ALLOW_UNPINNED_VKEY=1.
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        bytes32 pinnedVkey = vm.parseJsonBytes32(pin, ".program_vkey");
        if (vkey != pinnedVkey) {
            require(vm.envOr("ALLOW_UNPINNED_VKEY", false), "PROGRAM_VKEY != elf-vkey-pin.json program_vkey (set ALLOW_UNPINNED_VKEY=1 only for an intentional guest change)");
        }
        // Cross-chain activation gate. The reflection header chain IS anchored to canonical Bitcoin:
        // the guest commits its prev/tip hashes and the pool pins them to HEADER_RELAY.tip() (within a
        // finality window), forcing the whole proven chain to be canonical — closing the F1/F2/F3
        // (anchor / self-declared-difficulty / confirmation) blockers. The PINNED reflection vkey
        // (0x0050d656) is this anchor model, so the remaining caveat is F4 (spent-set completeness — a
        // relayer could omit a witnessed spend); bridge_mint is unaffected (burns are tx-confirmed) but
        // the cross-lane gate carries the F4 caveat until the full-scan re-prove lands (the full-scan
        // guest + JS indexer + signet-307547 fixture are built; its GPU re-prove will REPLACE the pinned
        // vkey + drop this ack). So require (a) BITCOIN_RELAY_VKEY == the pinned reflection vkey, (b) a
        // wired HEADER_RELAY (also ctor-enforced), (c) the genesis anchor, and (d) an explicit ack that
        // the F4 cross-lane caveat is understood.
        if (bitcoinRelayVKey != bytes32(0)) {
            require(bitcoinRelayVKey == vm.parseJsonBytes32(pin, ".bitcoin_relay_vkey"), "BITCOIN_RELAY_VKEY != pinned bitcoin_relay_vkey");
            require(headerRelay != address(0), "set HEADER_RELAY (BitcoinLightRelay) to anchor reflection proofs");
            require(genesisReflectionAnchor != bytes32(0), "set GENESIS_REFLECTION_ANCHOR (the Bitcoin block hash the first reflection batch resumes from) - a zero seed bricks the first attest");
            require(vm.envOr("ACK_REFLECTION_ANCHORED", false), "F1/F2/F3 closed (relay anchor); the pinned reflection vkey is the witnessed-anchor model - set ACK_REFLECTION_ANCHORED=1 to acknowledge the residual F4 cross-lane completeness caveat (closed by the pending full-scan re-prove)");
        }
        // Optional chainid pin: set EXPECTED_CHAIN_ID to fail a wrong-network broadcast.
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        require(expectedChainId == 0 || block.chainid == expectedChainId, "block.chainid != EXPECTED_CHAIN_ID");

        vm.startBroadcast();
        ConfidentialPool pool = new ConfidentialPool(sp1Verifier, vkey, bitcoinRelayVKey, canonicalFactory, headerRelay, genesisReflectionAnchor);

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
