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
    // (trustless first-mint metadata from the etch, now binding the IPFS contractURI cid), OP_SWAP
    // (confidential AMM batch), OP_LP_ADD/OP_LP_REMOVE (confidential liquidity), OP_OTC (2-party
    // direct swap), and OP_BID (buyer-offline partial-fill bid). Swap/LP/OTC/BID amounts are bound
    // by an opening sigma (proof of knowledge of the note blinding) so the settle prover never
    // learns r. Pinned to the committed canonical ELF: sp1/confidential/elf/cxfer-guest, sha256
    // c49ba0d3… (elf-vkey-pin.json). A real Groth16 of this ELF verifies on-chain at this vkey
    // (test/Confidential{Swap,Lp,Otc,Bid}ProofReal). Override via PROGRAM_VKEY env if the guest changes.
    // (Prior: …0x009cb098 (AMM), 0x0026dabb (AMM consolidation) — superseded by the cBTC.zk re-prove.)
    bytes32 constant DEFAULT_VKEY = 0x00d5b572003254b7bb0e50b567d1d92a273b915f0117f5e3bc328236326a9df7;

    function run() external {
        address sp1Verifier = vm.envAddress("SP1_VERIFIER");
        require(sp1Verifier != address(0), "set SP1_VERIFIER (pinned immutable Groth16 leaf)");
        require(sp1Verifier.code.length != 0, "SP1_VERIFIER has no code");
        // Verifier provenance is the single most consequential trust decision in this deploy: the pool
        // hard-wires SP1_VERIFIER as immutable and every settle/attest trusts it forever. Pin the
        // IMMUTABLE SP1VerifierGroth16 leaf, never the owner-upgradeable gateway (the tETH lesson). Make
        // it a programmatic gate, not just operator discipline: assert the deployed code matches the
        // published leaf's codehash. EXPECTED_VERIFIER_CODEHASH is REQUIRED on mainnet (chainid 1) and
        // enforced whenever supplied elsewhere; obtain it from the verified leaf (`extcodehash`).
        bytes32 expectedVerifierCodehash = vm.envOr("EXPECTED_VERIFIER_CODEHASH", bytes32(0));
        require(
            block.chainid != 1 || expectedVerifierCodehash != bytes32(0),
            "mainnet: set EXPECTED_VERIFIER_CODEHASH to the published immutable SP1VerifierGroth16 leaf codehash"
        );
        if (expectedVerifierCodehash != bytes32(0)) {
            require(sp1Verifier.codehash == expectedVerifierCodehash, "SP1_VERIFIER codehash != EXPECTED_VERIFIER_CODEHASH (wrong/upgradeable verifier?)");
        }
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
        // Reflection maturity depth: a reflected batch's tip must be buried this many blocks below the
        // relay tip, so a bridge-burn carries that many Bitcoin confirmations before a mint can act on it
        // (default 6, the mainnet standard; a faster test chain may pick fewer). Unused when reflection is
        // off; ctor-bounded to 1..144 when on.
        uint256 reflectionConfirmations = vm.envOr("REFLECTION_CONFIRMATIONS", uint256(6));
        // GENERATIONAL deploys: the reflection-resume digest. 0 (default) = a genesis-anchored gen-1 (the
        // first cycle continues the protocol genesis digest). For a later generation that JOINS the shared
        // Bitcoin reflection mid-stream, set this to the CURRENT reflected digest (paired with a near-tip
        // GENESIS_REFLECTION_ANCHOR) so it never replays Bitcoin history. See ops/PLAN-pool-generations.md.
        bytes32 reflectionResumeDigest = vm.envOr("REFLECTION_RESUME_DIGEST", bytes32(0));
        // tETH (shielded ETH, ops/PLAN-teth-subsumption.md): the canonical Bitcoin-side tETH asset id, bound
        // to native ETH at CONSTRUCTION so the single native-ETH slot's link is fixed at deploy and identical
        // across generations (registerWrapped can't set a native-ETH link). 0 = this deploy doesn't host tETH.
        bytes32 tethBitcoinId = vm.envOr("TETH_BITCOIN_ID", bytes32(0));

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
        // Cross-chain activation gate. Reflection F1-F4 are all CLOSED and PROVEN: the guest commits
        // its prev/tip hashes and the pool pins them to a MATURED ancestor of HEADER_RELAY.tip()
        // (≥ REFLECTION_CONFIRMATIONS deep, within a finality window — F1/F2/F3: anchor /
        // self-declared-difficulty / confirmation), and the pinned reflection vkey (elf-vkey-pin.json
        // .bitcoin_relay_vkey) is the FULL-SCAN model — every tx of every block + every vin against the
        // handed live set, so no pool-note spend can be omitted (F4 — spent-set completeness). The cross-lane
        // gate is sound. The residual is operational only: a Bitcoin reorg deeper than REFLECTION_CONFIRMATIONS
        // (accept-and-document, as on the tETH bridge / AMM) and the relay running (liveness). So require
        // (a) BITCOIN_RELAY_VKEY == the pinned reflection vkey, (b) a wired HEADER_RELAY (also
        // ctor-enforced), (c) the genesis anchor, and (d) an explicit ack of that operational posture.
        if (bitcoinRelayVKey != bytes32(0)) {
            require(bitcoinRelayVKey == vm.parseJsonBytes32(pin, ".bitcoin_relay_vkey"), "BITCOIN_RELAY_VKEY != pinned bitcoin_relay_vkey");
            require(headerRelay != address(0), "set HEADER_RELAY (BitcoinLightRelay) to anchor reflection proofs");
            require(genesisReflectionAnchor != bytes32(0), "set GENESIS_REFLECTION_ANCHOR (the Bitcoin block hash the first reflection batch resumes from) - a zero seed bricks the first attest");
            require(vm.envOr("ACK_REFLECTION_ANCHORED", false), "reflection F1-F4 closed + proven on-chain (relay anchor + full-scan completeness); set ACK_REFLECTION_ANCHORED=1 to acknowledge the residual deep-reorg-beyond-REFLECTION_CONFIRMATIONS + relay-liveness posture");
        }
        // Optional chainid pin: set EXPECTED_CHAIN_ID to fail a wrong-network broadcast.
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        require(expectedChainId == 0 || block.chainid == expectedChainId, "block.chainid != EXPECTED_CHAIN_ID");

        // The CollateralEngine (cBTC native-ETH escrow gate + cUSD CDP controller). 0 ⇒ cBTC mint is inert
        // at launch (the lock-fold + CDP ops are still in the immutable surface; cBTC turns on later by
        // deploying the engine and a fresh pool that points at it, or via CREATE2 address-prediction so the
        // engine and pool can reference each other). See ops/DESIGN-confidential-defi-v1.md §6.
        address collateralEngine = vm.envOr("COLLATERAL_ENGINE", address(0));
        vm.startBroadcast();
        ConfidentialPool pool = new ConfidentialPool(sp1Verifier, vkey, bitcoinRelayVKey, canonicalFactory, headerRelay, genesisReflectionAnchor, reflectionConfirmations, reflectionResumeDigest, tethBitcoinId, collateralEngine);

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

        // tETH (native ETH at 18 dec → Tacit 8 ⇒ unitScale 10^10) was pinned in the constructor above when
        // TETH_BITCOIN_ID != 0; the Bitcoin etch id is the link, so a bridged/fast-laned tETH note resolves
        // here on unwrap. Confirm the ctor bound it.
        bytes32 tethAsset;
        if (tethBitcoinId != bytes32(0)) {
            tethAsset = pool.localAssetOf(tethBitcoinId);
            require(tethAsset != bytes32(0) && pool.TETH_BITCOIN_LINK() == tethBitcoinId, "tETH link not bound");
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
        if (tethBitcoinId != bytes32(0)) {
            console2.log("tETH asset (native-ETH shielded ETH, unwrap -> ETH):");
            console2.logBytes32(tethAsset);
        }
    }
}
