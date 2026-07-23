// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DeployV1Suite} from "./DeployV1Suite.s.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";
import {BtcCallExecutor} from "../src/BtcCallExecutor.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {ChainlinkEthBtcAdapter} from "../src/ChainlinkEthBtcAdapter.sol";

/// @notice CreateX CREATE3 deploy of the Tacit V1 core contracts at CROSS-CHAIN-IDENTICAL vanity
///         addresses (4 leading zero bytes). See ops/CREATEX-VANITY-DEPLOY.md for the salt-scheme
///         analysis. The key facts this script relies on:
///
///         1. CREATE3 address = f(CreateX, guardedSalt) — independent of initCode. So the same salt
///            yields the same address on Sepolia / mainnet / every L2, even though our per-chain
///            constructor args (vkeys / admin / feeds) differ.
///
///         2. For a portable address the salt MUST guard to the same value on every chain. We use
///            the "Random" salt form (high 20 bytes are free vanity entropy != msg.sender and != 0;
///            byte[20] != 0x01), which CreateX guards to keccak256(abi.encode(salt)) — no msg.sender,
///            no block.chainid. The miner (tools/mine-vanity-salts.sh) produces such salts.
///
///         3. deployCreate3(salt,…) APPLIES _guard; computeCreate3Address(salt) does NOT. So to
///            predict a deploy we precompute with the guarded salt: computeCreate3Address(_guard(salt)).
///            CREATE3 thus removes deploy-ordering deps — we know the pool address before deploying
///            the engine and vice-versa, so the engine↔pool immutable circular dep is no longer an
///            address problem (still honored as STATE wiring: engine.setPool then ownership handoff).
///
///         This script deploys the engine + pool + periphery (router/relayer/btcExecutor) at vanity
///         addresses. The asset-registration / pool-founding / farm deploys (which are NOT vanity
///         and depend on live pool state) are left to the standard DeployV1Suite once the core is up,
///         or can be appended; this script's remit is the cross-chain-identical CORE addresses.
contract DeployV1SuiteCreateX is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    address constant MAINNET_OPS_MULTISIG = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    address constant TEST_BOT_ADMIN = 0x000000000e8CB9ed9DC2114d79d9215eacb9cB07;
    bytes32 constant CBTC_ZK_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    uint256 constant ESCROW_RATIO_BPS = 15000;
    uint256 constant CDP_RATIO_BPS = 15000;
    uint256 constant LIQ_RATIO_BPS = 13000;

    /// @dev Raw (un-guarded) mined vanity salts, one per core contract. Filled by the miner; the
    ///      defaults are the all-Random placeholder (byte[20]=0x00) so a dry-run on a local fork
    ///      still produces deterministic — if not 4-zero — addresses. Override via env on the live run.
    struct Salts {
        bytes32 factory;
        bytes32 adapter;
        bytes32 engine;
        bytes32 pool;
        bytes32 router;
        bytes32 relayer;
        bytes32 btcCallExecutor;
    }

    struct Addrs {
        address factory;
        address adapter;
        address engine;
        address pool;
        address router;
        address relayer;
        address btcCallExecutor;
    }

    // ───────────────── CreateX salt-guard mirror (must match CreateX for portable Random salts) ─────────────────

    /// @notice The guardedSalt CreateX uses for a "Random" salt: keccak256(abi.encode(salt)). This is
    ///         the ONLY input to computeCreate3Address that predicts a deployCreate3(salt,…) landing.
    ///         A Random salt has salt[0:20] != msg.sender && != 0; we additionally require salt[20] != 0x01
    ///         so it never enters the chainid/sender-mixing branches — keeping the address portable.
    function guardRandom(bytes32 salt) public pure returns (bytes32) {
        require(salt[20] != 0x01, "salt byte[20]=0x01 enables redeploy protection (chainid-mixed, non-portable)");
        // Permissioned vanity salt (salt[0:20] == the deploying EOA): CreateX guards to
        // keccak256(abi.encode(sender, salt)) — front-run-proof AND still cross-chain-portable (the deployer
        // is the same address on every chain). The deploy's `deployCreate3(...) == predict(...)` require
        // re-verifies the broadcaster matches salt[0:20] at runtime, so a wrong sender fails closed.
        // salt[0:20] == 0 (or a Random salt whose sender does not deploy) guards to keccak256(abi.encode(salt)).
        address s = address(bytes20(salt));
        if (s != address(0)) return keccak256(abi.encode(s, salt));
        return keccak256(abi.encode(salt));
    }

    /// @notice Address deployCreate3(salt,…) will land at on EVERY CreateX chain.
    function predict(bytes32 salt) public view returns (address) {
        return CREATEX.computeCreate3Address(guardRandom(salt));
    }

    // ───────────────────────────────────── deploy ─────────────────────────────────────

    function run() external {
        DeployV1Suite.Config memory c = _envConfig();
        Salts memory s = _envSalts();

        // Pin coherence (the tETH deploy bar) — identical guard to DeployV1Suite.
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        bytes32 pinnedVkey = vm.parseJsonBytes32(pin, ".program_vkey");
        if (c.programVkey != pinnedVkey) {
            require(vm.envOr("ALLOW_UNPINNED_VKEY", false), "PROGRAM_VKEY != elf-vkey-pin.json (set ALLOW_UNPINNED_VKEY=1 for an intentional guest change)");
        }
        if (c.bitcoinRelayVkey != bytes32(0)) {
            require(c.bitcoinRelayVkey == vm.parseJsonBytes32(pin, ".bitcoin_relay_vkey"), "BITCOIN_RELAY_VKEY != pinned bitcoin_relay_vkey");
        }
        bytes32 expectedVerifierCodehash = vm.envOr("EXPECTED_VERIFIER_CODEHASH", bytes32(0));
        require(block.chainid != 1 || expectedVerifierCodehash != bytes32(0), "mainnet: set EXPECTED_VERIFIER_CODEHASH");
        if (expectedVerifierCodehash != bytes32(0)) {
            require(c.sp1Verifier.codehash == expectedVerifierCodehash, "SP1_VERIFIER codehash != EXPECTED_VERIFIER_CODEHASH");
        }
        require(block.chainid != 1 || c.engineAdmin == MAINNET_OPS_MULTISIG || !c.deployEngine, "mainnet: ENGINE_ADMIN must be the ops multisig");
        // The pool ctor sets localAssetOf[TETH_BITCOIN_ID] = cETH_id ONCE (never permissionless), so a
        // forgotten TETH_BITCOIN_ID permanently breaks the tETH<->cETH cross-chain link on an immutable
        // pool. Fail closed on mainnet (and any chain that opts in) unless explicitly waived.
        require(
            block.chainid != 1 || c.tethBitcoinId != bytes32(0) || vm.envOr("ALLOW_NO_TETH_LINK", false),
            "mainnet: set TETH_BITCOIN_ID (the canonical tETH Bitcoin id) for the tETH<->cETH link, or ALLOW_NO_TETH_LINK=1"
        );
        // Reflection (Bitcoin lane) is immutable-OFF if deployed with a zero relay vkey. The pool ctor
        // already reverts when the relay vkey is set but HEADER_RELAY/anchor are zero — this catches the
        // OTHER direction: shipping mainnet with reflection silently disabled. Waivable for an eth-only chain.
        require(
            block.chainid != 1 || c.bitcoinRelayVkey != bytes32(0) || vm.envOr("ALLOW_NO_REFLECTION", false),
            "mainnet: reflection must be ON (BITCOIN_RELAY_VKEY pinned + HEADER_RELAY set), or ALLOW_NO_REFLECTION=1"
        );
        // The genesis reflection anchor is the relay-internal (little-endian) block hash — the same byte
        // order the reflection guest commits as bitcoinPrevHash and the relay keys blockHeight by. Require a
        // nonzero relay height for it so the anchor is a real, relay-validated header in the correct order
        // before an immutable pool binds it.
        if (c.bitcoinRelayVkey != bytes32(0) && c.headerRelay != address(0)) {
            (bool okAnchor, bytes memory anchorRet) =
                c.headerRelay.staticcall(abi.encodeWithSignature("blockHeight(bytes32)", c.genesisReflectionAnchor));
            require(
                okAnchor && anchorRet.length == 32 && abi.decode(anchorRet, (uint256)) != 0,
                "GENESIS_REFLECTION_ANCHOR is not a header the relay knows - use the little-endian INTERNAL block hash (relay byte order), not the big-endian display hash"
            );
        }
        require(address(CREATEX).code.length != 0, "CreateX not deployed on this chain");

        // 1. PRECOMPUTE every address (CREATE3 = ordering-independent). These are the cross-chain-identical
        //    vanity addresses; assert they actually carry the mined 4-zero prefix on the live run.
        Addrs memory a;
        // A reused canonical factory (CANONICAL_FACTORY set) is not CREATE3'd here, so predict from its
        // real address — otherwise the vanity check below would test an empty-salt prediction and fail.
        a.factory = c.canonicalFactory != address(0) ? c.canonicalFactory : predict(s.factory);
        a.pool = predict(s.pool);
        // A reused price adapter (CANONICAL_ADAPTER set) is not CREATE3'd here — predict from its real address.
        address canonicalAdapter = vm.envOr("CANONICAL_ADAPTER", address(0));
        if (c.deployEngine) {
            a.adapter = canonicalAdapter != address(0) ? canonicalAdapter : predict(s.adapter);
            a.engine = predict(s.engine);
        }
        if (c.deployRouter) a.router = predict(s.router);
        if (c.deployRelayer) a.relayer = predict(s.relayer);
        if (c.deployBtcCallExecutor) a.btcCallExecutor = predict(s.btcCallExecutor);

        if (vm.envOr("REQUIRE_VANITY", block.chainid == 1)) {
            _requireFourZeroBytes(a.pool, "pool");
            if (c.deployEngine) _requireFourZeroBytes(a.engine, "engine");
            _requireFourZeroBytes(a.factory, "factory");
            if (c.deployRouter) _requireFourZeroBytes(a.router, "router");
            if (c.deployRelayer) _requireFourZeroBytes(a.relayer, "relayer");
            if (c.deployBtcCallExecutor) _requireFourZeroBytes(a.btcCallExecutor, "btcCallExecutor");
        }

        vm.startBroadcast();

        // 2. Factory (allow reuse of a pre-existing canonical factory; else CREATE3 it).
        if (c.canonicalFactory != address(0)) {
            a.factory = c.canonicalFactory;
        } else {
            address got = CREATEX.deployCreate3(s.factory, type(CanonicalAssetFactory).creationCode);
            require(got == a.factory, "factory address mismatch");
        }

        // 3. Engine + adapter. Engine's pool ptr is a one-shot setter and its ctor takes the owner; the
        //    pool ptr is set AFTER the pool exists. CREATE3 means we already know the pool address, but the
        //    engine doesn't need it at ctor time, so the ordering is purely about STATE wiring now.
        if (c.deployEngine) {
            if (canonicalAdapter == address(0)) {
                bytes memory adapterCode = abi.encodePacked(type(ChainlinkEthBtcAdapter).creationCode, abi.encode(c.ethUsdFeed, c.btcUsdFeed));
                require(CREATEX.deployCreate3(s.adapter, adapterCode) == a.adapter, "adapter address mismatch");
            }

            bytes memory engineCode = abi.encodePacked(
                type(CollateralEngine).creationCode, abi.encode(address(0), CBTC_ZK_ASSET_ID, uint8(8), uint8(8), tx.origin)
            );
            require(CREATEX.deployCreate3(s.engine, engineCode) == a.engine, "engine address mismatch");
            CollateralEngine engine = CollateralEngine(payable(a.engine));
            engine.setFeeds(a.adapter, c.btcUsdFeed, address(0), address(0));
            engine.setParams(c.maxStaleness, ESCROW_RATIO_BPS, CDP_RATIO_BPS, LIQ_RATIO_BPS);
        }

        // 4. Pool (ctor takes the engine addr — known/zero up front).
        bytes memory poolCode = abi.encodePacked(
            type(ConfidentialPool).creationCode,
            abi.encode(
                c.sp1Verifier,
                c.programVkey,
                c.bitcoinRelayVkey,
                a.factory,
                c.headerRelay,
                c.genesisReflectionAnchor,
                c.reflectionConfirmations,
                c.reflectionResumeDigest,
                c.tethBitcoinId,
                c.deployEngine ? a.engine : address(0)
            )
        );
        require(CREATEX.deployCreate3(s.pool, poolCode) == a.pool, "pool address mismatch");

        // 5. Break the circular dep, THEN hand the engine to its admin (STATE wiring; addresses already fixed).
        if (c.deployEngine) {
            CollateralEngine engine = CollateralEngine(payable(a.engine));
            engine.setPool(a.pool);
            if (c.engineAdmin != tx.origin) engine.transferOwnership(c.engineAdmin);
        }

        // 6. Periphery.
        if (c.deployRouter) {
            bytes memory code = abi.encodePacked(type(ConfidentialRouter).creationCode, abi.encode(a.pool, c.zRouter, c.permit2));
            require(CREATEX.deployCreate3(s.router, code) == a.router, "router address mismatch");
        }
        if (c.deployRelayer) {
            bytes memory code = abi.encodePacked(type(TacitRelayer).creationCode, abi.encode(a.pool));
            require(CREATEX.deployCreate3(s.relayer, code) == a.relayer, "relayer address mismatch");
        }
        if (c.deployBtcCallExecutor) {
            bytes memory code = abi.encodePacked(type(BtcCallExecutor).creationCode, abi.encode(a.pool));
            require(CREATEX.deployCreate3(s.btcCallExecutor, code) == a.btcCallExecutor, "btcCallExecutor address mismatch");
        }

        vm.stopBroadcast();

        _report(a);
        if (vm.envOr("WRITE_MANIFEST", true)) _writeManifest(a);
    }

    function _requireFourZeroBytes(address x, string memory name) internal pure {
        require(uint160(x) >> 128 == 0, string.concat("vanity check failed (need 4 leading zero bytes): ", name));
    }

    // ───────────────────────────────────── env ─────────────────────────────────────

    function _envSalts() internal view returns (Salts memory s) {
        s.factory = vm.envOr("SALT_FACTORY", bytes32(0));
        s.adapter = vm.envOr("SALT_ADAPTER", bytes32(0));
        s.engine = vm.envOr("SALT_ENGINE", bytes32(0));
        s.pool = vm.envOr("SALT_POOL", bytes32(0));
        s.router = vm.envOr("SALT_ROUTER", bytes32(0));
        s.relayer = vm.envOr("SALT_RELAYER", bytes32(0));
        s.btcCallExecutor = vm.envOr("SALT_BTC_CALL_EXECUTOR", bytes32(0));
    }

    function _envConfig() internal view returns (DeployV1Suite.Config memory c) {
        c.sp1Verifier = vm.envAddress("SP1_VERIFIER");
        require(c.sp1Verifier != address(0) && c.sp1Verifier.code.length != 0, "SP1_VERIFIER not a contract");
        c.programVkey = vm.envOr("PROGRAM_VKEY", bytes32(0x0081360d92f2589bc5e0ebf27e0ce8e3227c8bae887c5d41b8faf23cca334d06));
        c.bitcoinRelayVkey = vm.envOr("BITCOIN_RELAY_VKEY", bytes32(0x00580f84706d9b410082ce7a5f0fab145e10d4e260ee0e1f186841272e02a9c5));
        c.canonicalFactory = vm.envOr("CANONICAL_FACTORY", address(0));
        c.headerRelay = vm.envOr("HEADER_RELAY", address(0));
        c.genesisReflectionAnchor = vm.envOr("GENESIS_REFLECTION_ANCHOR", bytes32(0));
        c.reflectionConfirmations = vm.envOr("REFLECTION_CONFIRMATIONS", uint256(6));
        c.reflectionResumeDigest = vm.envOr("REFLECTION_RESUME_DIGEST", bytes32(0));
        c.tethBitcoinId = vm.envOr("TETH_BITCOIN_ID", bytes32(0));
        c.deployEngine = vm.envOr("DEPLOY_ENGINE", true);
        (c.ethUsdFeed, c.btcUsdFeed, c.maxStaleness) = _feeds();
        c.engineAdmin = vm.envOr("ENGINE_ADMIN", _defaultAdmin());
        c.zRouter = vm.envOr("ZROUTER", ZROUTER);
        c.permit2 = vm.envOr("PERMIT2", PERMIT2);
        c.deployRouter = vm.envOr("DEPLOY_ROUTER", true);
        c.deployRelayer = vm.envOr("DEPLOY_RELAYER", true);
        c.deployBtcCallExecutor = vm.envOr("DEPLOY_BTC_CALL_EXECUTOR", true);
    }

    function _feeds() internal view returns (address ethUsd, address btcUsd, uint256 staleness) {
        if (block.chainid == 1) return (0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419, 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c, 3900);
        if (block.chainid == 11155111) return (0x694AA1769357215DE4FAC081bf1f309aDC325306, 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43, 86400);
        return (vm.envAddress("ETH_USD_FEED"), vm.envAddress("BTC_USD_FEED"), vm.envOr("MAX_STALENESS", uint256(86400)));
    }

    function _defaultAdmin() internal view returns (address) {
        if (block.chainid == 1) return MAINNET_OPS_MULTISIG;
        if (block.chainid == 11155111) return TEST_BOT_ADMIN;
        return msg.sender;
    }

    function _report(Addrs memory a) internal pure {
        console2.log("=== Tacit V1 suite (CreateX CREATE3, cross-chain-identical) ===");
        console2.log("CanonicalAssetFactory:", a.factory);
        console2.log("ChainlinkEthBtcAdapter:", a.adapter);
        console2.log("CollateralEngine:", a.engine);
        console2.log("ConfidentialPool:", a.pool);
        console2.log("ConfidentialRouter:", a.router);
        console2.log("TacitRelayer:", a.relayer);
        console2.log("BtcCallExecutor:", a.btcCallExecutor);
    }

    function _writeManifest(Addrs memory a) internal {
        string memory k = "v1suiteCreateX";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "createX", address(CREATEX));
        vm.serializeAddress(k, "factory", a.factory);
        vm.serializeAddress(k, "adapter", a.adapter);
        vm.serializeAddress(k, "engine", a.engine);
        vm.serializeAddress(k, "router", a.router);
        vm.serializeAddress(k, "relayer", a.relayer);
        vm.serializeAddress(k, "btcCallExecutor", a.btcCallExecutor);
        string memory out = vm.serializeAddress(k, "pool", a.pool);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), "-createx.json");
        vm.writeJson(out, path);
        console2.log("manifest:", path);
    }
}
