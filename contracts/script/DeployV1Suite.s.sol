// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";
import {BtcCallExecutor} from "../src/BtcCallExecutor.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {ChainlinkEthBtcAdapter} from "../src/ChainlinkEthBtcAdapter.sol";
import {FarmController} from "../src/FarmController.sol";
import {FixedSupplyMinter} from "../src/CanonicalMinters.sol";

/// @notice One-shot orchestrator for the Tacit V1 suite — deploys + WIRES every contract in the one order
///         the immutable pool + the engine↔pool circular dep allow, registers the day-1 assets, founds the
///         TAC-centric core pools, and deploys a reward farm per pool. The standalone Deploy* scripts stay
///         for surgical redeploys; this is the cohesive testnet rehearsal that doubles as the mainnet
///         template (swap the env: multisig admin, codehash pins, mainnet feeds, real verifier/relay).
///
///         Wiring crux: the pool's engine pointer is immutable and the engine's pool pointer is a one-shot
///         setter, so the engine deploys FIRST with the broadcaster as owner, the pool deploys pointing at
///         it (ctor deploy-or-adopts tacBTC + tacUSD), then `engine.setPool(pool)` — and ONLY THEN is
///         ownership handed to ENGINE_ADMIN. Doing the handoff before setPool would strand the wiring.
///
///         Day-1 pools (TAC-centric: TAC is the common leg + incentive currency, ops/PLAN-day1-assets-and-
///         incentives.md): TAC/cETH, TAC/cBTC, cUSD/cBTC, cUSD/cETH, cETH/cBTC. Each pool gets a
///         FarmController staking its LP-share id (keccak(poolId‖"lp")) and emitting cTAC (escrow mode).
///         Pairs/farms whose legs didn't resolve (e.g. no engine ⇒ no cBTC/cUSD; no TAC underlying) are
///         skipped with a log line — never silently. Pair creation + farm deploy are direct calls;
///         FUNDING the farms + ADDING liquidity are box-proven settles (tests/v1-day1-bootstrap-*.mjs).
contract DeployV1Suite is Script {
    address constant MAINNET_OPS_MULTISIG = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    address constant TEST_BOT_ADMIN = 0x000000000e8CB9ed9DC2114d79d9215eacb9cB07;
    bytes32 constant CBTC_ZK_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    // Market-standard risk params (mirror DeployCollateralEngine).
    uint256 constant ESCROW_RATIO_BPS = 15000;
    uint256 constant CDP_RATIO_BPS = 15000;
    uint256 constant LIQ_RATIO_BPS = 13000;

    struct Config {
        address sp1Verifier;
        bytes32 programVkey;
        bytes32 bitcoinRelayVkey;
        address canonicalFactory; // 0 ⇒ deploy a fresh one
        address headerRelay; // BitcoinLightRelay for reflection (0 ⇒ reflection off)
        bytes32 genesisReflectionAnchor;
        uint256 reflectionConfirmations;
        bytes32 reflectionResumeDigest;
        bytes32 tethBitcoinId; // pins native ETH (cETH); 0 ⇒ no cETH this generation
        bool deployEngine; // false ⇒ Ethereum-only, cBTC/cUSD dormant
        address ethUsdFeed;
        address btcUsdFeed;
        uint256 maxStaleness;
        address engineAdmin; // engine owner after setPool
        address farmGov;
        address tacUnderlying; // public TAC ERC20 (0 ⇒ deploy a testnet TAC if deployTestnetTac, else skip)
        bool deployTestnetTac; // testnet only: etch a fixed-supply 21M TAC when tacUnderlying is unset
        address tacRecipient; // receives the 21M testnet TAC supply
        uint256 tacUnitScale;
        uint8 tacDecimals;
        uint32 feeBps; // day-1 pool fee tier
        // Protocol (creator) fee for the TAC-paired pools (TAC/cETH + TAC/cBTC): a per-swap skim of
        // protocolFeeBps/10000 of the LP fee accrues to the treasury recipient (rcptPrefix‖rcptX). 0 recipient
        // ⇒ no-skim (the pools stay canonical). protocolFeeBps is the fee-switch fraction (≤ 10000 = 100%).
        uint8 protocolFeeRcptPrefix;
        bytes32 protocolFeeRcptX;
        uint32 protocolFeeBps;
        bool deployRouter;
        address zRouter; // router's zRouter aggregator (0 ⇒ zaps disabled; e.g. a chain without zRouter)
        address permit2; // router's Permit2 (canonical singleton)
        bool deployRelayer;
        bool deployBtcCallExecutor;
        uint256 farmLockUntil;
    }

    struct Deployed {
        address factory;
        address adapter;
        address engine;
        address pool;
        address router;
        address relayer;
        address btcCallExecutor;
        address tac; // the public TAC ERC20 (provided or testnet-etched)
        bytes32 cTac;
        bytes32 cEth;
        bytes32 cBtc;
        bytes32 cUsd;
        bytes32[] poolIds;
        address[] farms;
        string[] poolNames;
    }

    // ───────────────────────── pure deploy + wire (no env, no broadcast) — forge-testable ─────────────────────────

    function deploySuite(Config memory c) public returns (Deployed memory d) {
        // 1. Canonical asset factory (reuse or fresh).
        d.factory = c.canonicalFactory == address(0) ? address(new CanonicalAssetFactory()) : c.canonicalFactory;

        // 2. Oracle adapter + CollateralEngine (broadcaster stays owner until after setPool).
        address engineAddr;
        CollateralEngine engine;
        if (c.deployEngine) {
            ChainlinkEthBtcAdapter adapter = new ChainlinkEthBtcAdapter(c.ethUsdFeed, c.btcUsdFeed);
            d.adapter = address(adapter);
            engine = new CollateralEngine(address(0), CBTC_ZK_ASSET_ID, 8, 8, tx.origin);
            engine.setFeeds(address(adapter), c.btcUsdFeed, address(0), address(0));
            engine.setParams(c.maxStaleness, ESCROW_RATIO_BPS, CDP_RATIO_BPS, LIQ_RATIO_BPS);
            engineAddr = address(engine);
            d.engine = engineAddr;
        }

        // 3. ConfidentialPool — ctor deploy-or-adopts tacBTC + tacUSD and pins cETH (when wired).
        ConfidentialPool pool = new ConfidentialPool(
            c.sp1Verifier,
            c.programVkey,
            c.bitcoinRelayVkey,
            d.factory,
            c.headerRelay,
            c.genesisReflectionAnchor,
            c.reflectionConfirmations,
            c.reflectionResumeDigest,
            c.tethBitcoinId,
            engineAddr
        );
        d.pool = address(pool);

        // 4. Break the circular dep, THEN hand the engine to its admin.
        if (c.deployEngine) {
            engine.setPool(address(pool));
            if (c.engineAdmin != tx.origin) engine.transferOwnership(c.engineAdmin);
        }

        // 5. Periphery (immutable, no post-wiring).
        if (c.deployRouter) d.router = address(new ConfidentialRouter(address(pool), c.zRouter, c.permit2));
        if (c.deployRelayer) d.relayer = address(new TacitRelayer(address(pool)));
        if (c.deployBtcCallExecutor) d.btcCallExecutor = address(new BtcCallExecutor(address(pool)));

        // 6. Public TAC. On mainnet pass the real bridged-TAC ERC20 via tacUnderlying. On testnet, with no
        //    tacUnderlying, etch a deploy-and-die fixed-supply 21M TAC (8-dec) to the ops recipient — the
        //    funding source for the airdrop distributor + LP/farm incentives. Then register it as a
        //    confidential escrow asset (cTAC). The Bitcoin-side link is set later by the guest-proven
        //    attest_meta path, never here (escrow assets reject a cross link).
        d.tac = c.tacUnderlying;
        if (d.tac == address(0) && c.deployTestnetTac) {
            require(block.chainid != 1, "testnet TAC etch forbidden on mainnet (pass the real bridged TAC)");
            FixedSupplyMinter m = new FixedSupplyMinter(
                CanonicalAssetFactory(d.factory), c.tacRecipient, bytes32(uint256(0x7ac)), "TAC", 8, bytes32(0), 21_000_000 * 10 ** 8, c.tacRecipient
            );
            d.tac = address(m.TOKEN());
        }
        if (d.tac != address(0)) {
            d.cTac = pool.registerWrapped(d.tac, c.tacUnitScale, bytes32(0), "Confidential TAC", "cTAC", c.tacDecimals);
        }

        // 7. Resolve the ctor-registered day-1 assets.
        if (c.tethBitcoinId != bytes32(0)) d.cEth = pool.localAssetOf(c.tethBitcoinId);
        if (c.deployEngine) {
            d.cBtc = pool.localAssetOf(CBTC_ZK_ASSET_ID);
            d.cUsd = pool.localAssetOf(engine.CUSD_ASSET_ID());
        }

        // 8. Found the TAC-centric core pools + a cTAC-emitting farm per pool. Two passes (count valid legs,
        //    then fill exact-size arrays) so a leg that didn't resolve is skipped, not silently zero-padded.
        bytes32[5] memory legA = [d.cTac, d.cTac, d.cUsd, d.cUsd, d.cEth];
        bytes32[5] memory legB = [d.cEth, d.cBtc, d.cBtc, d.cEth, d.cBtc];
        string[5] memory labels = ["TAC/cETH", "TAC/cBTC", "cUSD/cBTC", "cUSD/cETH", "cETH/cBTC"];

        uint256 cnt;
        for (uint256 i = 0; i < 5; i++) {
            if (legA[i] != bytes32(0) && legB[i] != bytes32(0)) cnt++;
        }
        d.poolIds = new bytes32[](cnt);
        d.farms = new address[](cnt);
        d.poolNames = new string[](cnt);

        uint256 j;
        for (uint256 i = 0; i < 5; i++) {
            if (legA[i] == bytes32(0) || legB[i] == bytes32(0)) {
                console2.log(string.concat("  skip pool ", labels[i], " (a leg did not resolve)"));
                continue;
            }
            // The protocol-fee skim stays fully supported protocol-wide (guest OP_SWAP carve + contract
            // createPair fee config). It is just not used by the day-1 admin deploy: all 5 pools launch
            // canonical/no-skim (createPair bps=0 ⇒ the 3-arg poolId). A fee pool can be added later via a
            // follow-up admin createPair (or a permissionless creator-fee pool) without any code change.
            bool feePool = false;
            bytes32 poolId = pool.createPair(
                legA[i],
                legB[i],
                c.feeBps,
                feePool ? c.protocolFeeRcptPrefix : 0,
                feePool ? c.protocolFeeRcptX : bytes32(0),
                feePool ? c.protocolFeeBps : 0
            );
            bytes32 lpShareId = keccak256(abi.encodePacked(poolId, "lp"));
            // Reward in cTAC (escrow mode) to make TAC the common incentive currency; fall back to the
            // pool's own LP id only if TAC didn't resolve (day-1 always has cTAC).
            bytes32 rewardAsset = d.cTac != bytes32(0) ? d.cTac : lpShareId;
            FarmController farm = new FarmController(address(pool), lpShareId, rewardAsset, true, true, c.farmGov, c.farmLockUntil);
            d.poolIds[j] = poolId;
            d.farms[j] = address(farm);
            d.poolNames[j] = labels[i];
            j++;
        }
    }

    // ───────────────────────────────────── env entrypoint ─────────────────────────────────────

    function run() external {
        Config memory c = _envConfig();

        // Pin coherence (the tETH deploy bar): the deployed guest must be the proven one.
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        bytes32 pinnedVkey = vm.parseJsonBytes32(pin, ".program_vkey");
        if (c.programVkey != pinnedVkey) {
            require(vm.envOr("ALLOW_UNPINNED_VKEY", false), "PROGRAM_VKEY != elf-vkey-pin.json (set ALLOW_UNPINNED_VKEY=1 for an intentional guest change)");
        }
        if (c.bitcoinRelayVkey != bytes32(0)) {
            require(c.bitcoinRelayVkey == vm.parseJsonBytes32(pin, ".bitcoin_relay_vkey"), "BITCOIN_RELAY_VKEY != pinned bitcoin_relay_vkey");
        }
        // Mainnet verifier provenance guard (the tETH lesson).
        bytes32 expectedVerifierCodehash = vm.envOr("EXPECTED_VERIFIER_CODEHASH", bytes32(0));
        require(block.chainid != 1 || expectedVerifierCodehash != bytes32(0), "mainnet: set EXPECTED_VERIFIER_CODEHASH");
        if (expectedVerifierCodehash != bytes32(0)) {
            require(c.sp1Verifier.codehash == expectedVerifierCodehash, "SP1_VERIFIER codehash != EXPECTED_VERIFIER_CODEHASH");
        }
        require(block.chainid != 1 || c.engineAdmin == MAINNET_OPS_MULTISIG || !c.deployEngine, "mainnet: ENGINE_ADMIN must be the ops multisig");
        // The pool ctor sets localAssetOf[TETH_BITCOIN_ID] = cETH_id ONCE (never permissionless), so a
        // forgotten TETH_BITCOIN_ID permanently breaks the tETH<->cETH cross-chain link on an immutable
        // pool. Fail closed on mainnet unless explicitly waived.
        require(
            block.chainid != 1 || c.tethBitcoinId != bytes32(0) || vm.envOr("ALLOW_NO_TETH_LINK", false),
            "mainnet: set TETH_BITCOIN_ID (the canonical tETH Bitcoin id) for the tETH<->cETH link, or ALLOW_NO_TETH_LINK=1"
        );
        // Reflection is immutable-OFF if deployed with a zero relay vkey. The pool ctor already reverts when the
        // relay vkey is set but HEADER_RELAY/anchor are zero; this catches the other direction: shipping mainnet
        // with reflection silently disabled. Waivable only for an explicit eth-only deployment.
        require(
            block.chainid != 1 || c.bitcoinRelayVkey != bytes32(0) || vm.envOr("ALLOW_NO_REFLECTION", false),
            "mainnet: reflection must be ON (BITCOIN_RELAY_VKEY pinned + HEADER_RELAY set), or ALLOW_NO_REFLECTION=1"
        );

        vm.startBroadcast();
        Deployed memory d = deploySuite(c);
        vm.stopBroadcast();

        _report(c, d);
        if (vm.envOr("WRITE_MANIFEST", true)) _writeManifest(c, d);
    }

    function _envConfig() internal view returns (Config memory c) {
        c.sp1Verifier = vm.envAddress("SP1_VERIFIER");
        require(c.sp1Verifier != address(0) && c.sp1Verifier.code.length != 0, "SP1_VERIFIER not a contract");
        c.programVkey = vm.envOr("PROGRAM_VKEY", bytes32(0x0081360d92f2589bc5e0ebf27e0ce8e3227c8bae887c5d41b8faf23cca334d06));
        c.bitcoinRelayVkey = vm.envOr("BITCOIN_RELAY_VKEY", bytes32(0x001e0f7b634d01fc4b3030fba41ef05fa2f735ef2a308cd215e2da3c28075f74));
        c.canonicalFactory = vm.envOr("CANONICAL_FACTORY", address(0));
        c.headerRelay = vm.envOr("HEADER_RELAY", address(0));
        c.genesisReflectionAnchor = vm.envOr("GENESIS_REFLECTION_ANCHOR", bytes32(0));
        c.reflectionConfirmations = vm.envOr("REFLECTION_CONFIRMATIONS", uint256(6));
        c.reflectionResumeDigest = vm.envOr("REFLECTION_RESUME_DIGEST", bytes32(0));
        c.tethBitcoinId = vm.envOr("TETH_BITCOIN_ID", bytes32(0));
        c.deployEngine = vm.envOr("DEPLOY_ENGINE", true);
        (c.ethUsdFeed, c.btcUsdFeed, c.maxStaleness) = _feeds();
        c.engineAdmin = vm.envOr("ENGINE_ADMIN", _defaultAdmin());
        c.farmGov = vm.envOr("FARM_GOV", c.engineAdmin);
        c.tacUnderlying = vm.envOr("TAC_UNDERLYING", address(0));
        c.deployTestnetTac = vm.envOr("DEPLOY_TESTNET_TAC", block.chainid != 1);
        c.tacRecipient = vm.envOr("TAC_RECIPIENT", c.engineAdmin);
        c.tacUnitScale = vm.envOr("TAC_UNIT_SCALE", uint256(1)); // 8-dec TAC ERC20 → tacit 8 ⇒ scale 1
        c.tacDecimals = uint8(vm.envOr("TAC_DECIMALS", uint256(8)));
        c.feeBps = uint32(vm.envOr("DAY1_FEE_BPS", uint256(30)));
        // Protocol/creator fee for the TAC pools: 1667 bps = Uniswap's 1/6 fee-switch (the protocol takes 1/6
        // of the LP fee; e.g. on a 30bps pool the protocol gets ~5bps of volume, LPs ~25bps). This bps has the
        // SAME meaning on both lanes — EVM per-swap (cut = LP_fee·bps/10000) and Bitcoin lazy-mintFee
        // (protocol_fee_shares, bps=1667 ↔ the 5:1 ⇒ 1/6) — so the two chains charge identical economics.
        // Applied only when a treasury recipient pubkey is set (PROTOCOL_FEE_RECIPIENT_X + its y-parity).
        c.protocolFeeBps = uint32(vm.envOr("PROTOCOL_FEE_BPS", uint256(1667)));
        c.protocolFeeRcptX = vm.envOr("PROTOCOL_FEE_RECIPIENT_X", bytes32(0));
        c.protocolFeeRcptPrefix = uint8(vm.envOr("PROTOCOL_FEE_RECIPIENT_PARITY", uint256(2)));
        c.deployRouter = vm.envOr("DEPLOY_ROUTER", true);
        c.zRouter = vm.envOr("ZROUTER", ZROUTER);
        c.permit2 = vm.envOr("PERMIT2", PERMIT2);
        c.deployRelayer = vm.envOr("DEPLOY_RELAYER", true);
        c.deployBtcCallExecutor = vm.envOr("DEPLOY_BTC_CALL_EXECUTOR", true);
        c.farmLockUntil = vm.envOr("FARM_LOCK_UNTIL", uint256(0));
    }

    function _feeds() internal view returns (address ethUsd, address btcUsd, uint256 staleness) {
        if (block.chainid == 1) return (0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419, 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c, 3900);
        if (block.chainid == 11155111) return (0x694AA1769357215DE4FAC081bf1f309aDC325306, 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43, 86400);
        // Local/other: must be supplied (the forge rehearsal passes mock feeds via deploySuite directly).
        return (vm.envAddress("ETH_USD_FEED"), vm.envAddress("BTC_USD_FEED"), vm.envOr("MAX_STALENESS", uint256(86400)));
    }

    function _defaultAdmin() internal view returns (address) {
        if (block.chainid == 1) return MAINNET_OPS_MULTISIG;
        if (block.chainid == 11155111) return TEST_BOT_ADMIN;
        return msg.sender;
    }

    function _report(Config memory c, Deployed memory d) internal pure {
        console2.log("=== Tacit V1 suite ===");
        console2.log("CanonicalAssetFactory:", d.factory);
        console2.log("ChainlinkEthBtcAdapter:", d.adapter);
        console2.log("CollateralEngine:", d.engine);
        console2.log("ConfidentialPool:", d.pool);
        console2.log("ConfidentialRouter:", d.router);
        console2.log("TacitRelayer:", d.relayer);
        console2.log("BtcCallExecutor:", d.btcCallExecutor);
        for (uint256 i = 0; i < d.poolIds.length; i++) {
            console2.log(string.concat("pool ", d.poolNames[i], " farm:"), d.farms[i]);
        }
    }

    function _writeManifest(Config memory c, Deployed memory d) internal {
        string memory k = "v1suite";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "adapter", d.adapter);
        vm.serializeAddress(k, "engine", d.engine);
        vm.serializeAddress(k, "router", d.router);
        vm.serializeAddress(k, "relayer", d.relayer);
        vm.serializeAddress(k, "btcCallExecutor", d.btcCallExecutor);
        vm.serializeAddress(k, "tac", d.tac);
        vm.serializeBytes32(k, "cTac", d.cTac);
        vm.serializeBytes32(k, "cEth", d.cEth);
        vm.serializeBytes32(k, "cBtc", d.cBtc);
        vm.serializeBytes32(k, "cUsd", d.cUsd);
        vm.serializeAddress(k, "farms", d.farms);
        vm.serializeString(k, "poolNames", d.poolNames);
        string memory poolIdsHex = "[";
        for (uint256 i = 0; i < d.poolIds.length; i++) {
            poolIdsHex = string.concat(poolIdsHex, i == 0 ? "\"" : ",\"", vm.toString(d.poolIds[i]), "\"");
        }
        poolIdsHex = string.concat(poolIdsHex, "]");
        vm.serializeString(k, "poolIds", poolIdsHex);
        string memory out = vm.serializeAddress(k, "pool", d.pool);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("manifest:", path);
    }
}
