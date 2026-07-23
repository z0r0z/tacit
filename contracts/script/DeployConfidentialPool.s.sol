// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";

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
    // Confidential guest vkey: the complete gen-1 settle op set — wrap/transfer/unwrap/bridge_burn/
    // bridge_mint/crossout + the cross-lane non-membership gate (IMT, bitcoinSpentRoot); the confidential
    // AMM (OP_SWAP / OP_LP_ADD / OP_LP_REMOVE / OP_SWAP_ROUTE), OP_OTC (2-party swap), OP_BID (buyer-
    // offline partial-fill); the adaptor swap (OP_ADAPTOR_LOCK / CLAIM / REFUND); the CDP / cUSD vault
    // (OP_CDP_MINT / CLOSE / LIQUIDATE / TOPUP), OP_CBTC_MINT, and the fair-farm (OP_FARM_BOND / HARVEST /
    // UNBOND). Value notes are bound by opening sigmas (proof of knowledge of the note blinding) so the
    // settle prover never learns r. Pinned to the committed canonical ELF sp1/confidential/elf/cxfer-guest,
    // sha256 7b7a3f1e… (elf-vkey-pin.json); a real Groth16 of this ELF verifies on-chain at this vkey for
    // every op (test/Confidential*ProofReal). Override via PROGRAM_VKEY env if the guest changes.
    bytes32 constant DEFAULT_VKEY = 0x0081360d92f2589bc5e0ebf27e0ce8e3227c8bae887c5d41b8faf23cca334d06;

    // cBTC.zk canonical asset id (cxfer-core CBTC_ZK_ASSET_ID) — the shared id real-BTC-locked cBTC notes
    // mint under. When a factory + a CollateralEngine are both wired, the pool constructor deploy-or-adopts
    // the canonical cBTC.tac ERC20 and pins cBTC.zk → it (so a cBTC note / a cUSD-CDP seize exits to a
    // mintable token); this id is how the deploy confirms that pin landed.
    bytes32 constant CBTC_ZK_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;

    // ConfidentialRouter singletons (same address on most chains): Uniswap Permit2 (AllowanceTransfer) and the
    // pinned zRouter aggregator (routes a swap across V2/V3/V4/Curve/zAMM). The router pins both IMMUTABLY;
    // override via PERMIT2 / ZROUTER env on a chain/test where they differ. Skip the router with DEPLOY_ROUTER=false.
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;

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
        // Pin the factory codehash like the verifier: the pool trusts whatever factory it is wired to,
        // forever, to issue canonical tokens (a malicious factory could return tokens that fake MINTER()/
        // ASSET_ID()). EXPECTED_FACTORY_CODEHASH = the deployed CanonicalAssetFactory's extcodehash —
        // REQUIRED on mainnet (chainid 1) when a factory is wired, and enforced whenever supplied
        // elsewhere. CANONICAL_FACTORY=0 (auto-register off) needs no pin.
        bytes32 expectedFactoryCodehash = vm.envOr("EXPECTED_FACTORY_CODEHASH", bytes32(0));
        require(
            canonicalFactory == address(0) || block.chainid != 1 || expectedFactoryCodehash != bytes32(0),
            "mainnet: set EXPECTED_FACTORY_CODEHASH to the canonical CanonicalAssetFactory codehash (or CANONICAL_FACTORY=0)"
        );
        if (canonicalFactory != address(0) && expectedFactoryCodehash != bytes32(0)) {
            require(canonicalFactory.codehash == expectedFactoryCodehash, "CANONICAL_FACTORY codehash != EXPECTED_FACTORY_CODEHASH (wrong/impostor factory?)");
        }
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
        // This catches the exact drift the repo's docs have hit before: a stale literal deploy vkey
        // against freshly committed ELF bytes. An intentional guest change sets ALLOW_UNPINNED_VKEY=1.
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
            // The anchor is the relay-internal (little-endian) block hash — the same byte order the
            // reflection guest commits as bitcoinPrevHash and the relay keys blockHeight by. Require a nonzero
            // relay height for it so the anchor is a real, relay-validated header in the correct order before
            // an immutable pool binds it.
            (bool okAnchor, bytes memory anchorRet) =
                headerRelay.staticcall(abi.encodeWithSignature("blockHeight(bytes32)", genesisReflectionAnchor));
            require(
                okAnchor && anchorRet.length == 32 && abi.decode(anchorRet, (uint256)) != 0,
                "GENESIS_REFLECTION_ANCHOR is not a header the relay knows - use the little-endian INTERNAL block hash (relay byte order), not the big-endian display hash"
            );
            require(vm.envOr("ACK_REFLECTION_ANCHORED", false), "reflection F1-F4 closed + proven on-chain (relay anchor + full-scan completeness); set ACK_REFLECTION_ANCHORED=1 to acknowledge the residual deep-reorg-beyond-REFLECTION_CONFIRMATIONS + relay-liveness posture");
        }
        // Optional chainid pin: set EXPECTED_CHAIN_ID to fail a wrong-network broadcast.
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        require(expectedChainId == 0 || block.chainid == expectedChainId, "block.chainid != EXPECTED_CHAIN_ID");

        // The CollateralEngine (cBTC native-ETH escrow gate + cUSD CDP controller). With a CANONICAL_FACTORY
        // ALSO wired, the pool constructor deploys-or-adopts the canonical cBTC.tac ERC20 + pins cBTC.zk → it
        // (day-1 cBTC, confirmed below). 0 ⇒ cBTC mint is inert (the lock-fold + CDP ops stay in the immutable
        // surface, dormant); turn cBTC on later by deploying the engine and a fresh pool that points at it
        // (engine↔pool circular dep: deploy the engine first with pool=0, then the pool with the engine
        // address, then engine.setPool(pool)). See ops/DESIGN-confidential-defi-v1.md §6.
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
            require(tethAsset != bytes32(0), "tETH link not bound");
        }

        // Day-1 cBTC.tac: when a factory + a CollateralEngine are both wired, the constructor deploy-or-adopts
        // the canonical cBTC.tac ERC20 and pins cBTC.zk → it. Confirm it landed (fail closed), so a broadcast
        // can't silently ship a cBTC-capable pool whose cBTC notes can't exit.
        address cbtcTac;
        if (canonicalFactory != address(0) && collateralEngine != address(0)) {
            cbtcTac = pool.canonicalTokenFor(CBTC_ZK_ASSET_ID);
            require(cbtcTac != address(0), "cBTC.tac not pinned by constructor (factory/engine wired)");
        }

        // Periphery router (one-tx wrap / private payment / public-AMM / zaps), pinned to this pool + the
        // canonical Permit2 + the pinned zRouter aggregator (all immutable). It custodies nothing across calls,
        // so it needs no post-deploy wiring. DEPLOY_ROUTER=false skips it (e.g. a router-less core deploy).
        address router;
        if (vm.envOr("DEPLOY_ROUTER", true)) {
            address zr = vm.envOr("ZROUTER", ZROUTER);
            address p2 = vm.envOr("PERMIT2", PERMIT2);
            router = address(new ConfidentialRouter(address(pool), zr, p2));
        }

        // Permissionless batching + fee-routing relayer, pinned to this pool. Ownerless, immutable, custodies
        // nothing across calls — needs no post-deploy wiring. DEPLOY_RELAYER=false skips it.
        address relayer;
        if (vm.envOr("DEPLOY_RELAYER", true)) {
            relayer = address(new TacitRelayer(address(pool)));
        }
        vm.stopBroadcast();

        console2.log("ConfidentialPool:", address(pool));
        console2.log("SP1 verifier:    ", sp1Verifier);
        console2.log("program vkey:");
        console2.logBytes32(vkey);
        console2.log("genesis root:");
        console2.logBytes32(pool.currentRoot());
        console2.log("chain binding:");
        console2.logBytes32(keccak256(abi.encodePacked(block.chainid, address(pool))));
        if (sampleUnderlying != address(0)) {
            console2.log("sample asset underlying:", sampleUnderlying);
            console2.logBytes32(sampleAsset);
        }
        if (tethBitcoinId != bytes32(0)) {
            console2.log("tETH asset (native-ETH shielded ETH, unwrap -> ETH):");
            console2.logBytes32(tethAsset);
        }
        if (cbtcTac != address(0)) {
            console2.log("cBTC.tac (canonical confidential-Bitcoin ERC20, pool-minted):", cbtcTac);
        }
        if (router != address(0)) {
            console2.log("ConfidentialRouter (wrap/pay/swap/zap periphery):", router);
        }
        if (relayer != address(0)) {
            console2.log("TacitRelayer (batching + fee-routing periphery):", relayer);
        }
    }
}
