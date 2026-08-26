// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";
import {BtcCallExecutor} from "../src/BtcCallExecutor.sol";
import {TacitPublicAmm} from "../src/TacitPublicAmm.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
    function computeCreate3Address(bytes32 guardedSalt) external view returns (address);
}

/// Finisher for a partial DeployV1SuiteCreateX broadcast where the engine + publicAmm deployed (and the
/// engine's setFeeds/setParams ran) but the POOL deploy hit the RPC gas cap, so nothing after it sent.
/// Deploys ONLY the remaining steps at the SAME args the main script uses — pool (with the corrected
/// REFLECTION_RESUME_DIGEST), the one-shot wiring (publicAmm.initialize, engine.setPool, transferOwnership),
/// then router/relayer/btcExecutor. Skips anything already on-chain. Run with a gas multiplier that keeps
/// the pool tx under the RPC's per-tx cap.
contract DeployV1PoolFinish is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;

    function guardRandom(bytes32 salt) internal pure returns (bytes32) {
        address s = address(bytes20(salt));
        if (s != address(0)) return keccak256(abi.encode(s, salt));
        return keccak256(abi.encode(salt));
    }

    function predict(bytes32 salt) public view returns (address) {
        return CREATEX.computeCreate3Address(guardRandom(salt));
    }

    function _deploy(bytes32 salt, bytes memory initCode, address expect, string memory name) internal {
        if (expect.code.length != 0) return; // already deployed — skip
        require(CREATEX.deployCreate3(salt, initCode) == expect, string.concat(name, " address mismatch"));
    }

    function run() external {
        // Reused / already-deployed inputs
        address factory = vm.envAddress("CANONICAL_FACTORY");
        address engine = predict(vm.envBytes32("SALT_ENGINE"));
        address publicAmm = predict(vm.envBytes32("SALT_PUBLIC_AMM"));
        address pool = predict(vm.envBytes32("SALT_POOL"));
        bytes32 sPool = vm.envBytes32("SALT_POOL");
        bytes32 sRouter = vm.envBytes32("SALT_ROUTER");
        bytes32 sRelayer = vm.envBytes32("SALT_RELAYER");
        bytes32 sBtc = vm.envBytes32("SALT_BTC_CALL_EXECUTOR");
        require(engine.code.length != 0, "engine not deployed");
        require(publicAmm.code.length != 0, "publicAmm not deployed");

        bytes memory poolArgs = abi.encode(
            vm.envAddress("SP1_VERIFIER"),
            vm.envBytes32("PROGRAM_VKEY"),
            vm.envBytes32("BITCOIN_RELAY_VKEY"),
            factory,
            vm.envAddress("HEADER_RELAY"),
            vm.envBytes32("GENESIS_REFLECTION_ANCHOR"),
            vm.envUint("REFLECTION_CONFIRMATIONS"),
            vm.envBytes32("REFLECTION_RESUME_DIGEST"),
            vm.envBytes32("TETH_BITCOIN_ID"),
            engine,
            vm.envOr("PREDECESSOR", address(0)),
            publicAmm
        );
        require(poolArgs.length == 12 * 32, "pool ctor arity != 12");

        vm.startBroadcast();
        // 1. Pool (the gas-heavy one).
        _deploy(sPool, abi.encodePacked(type(ConfidentialPool).creationCode, poolArgs), pool, "pool");
        // 2. One-shot wiring (idempotent-guarded).
        if (address(TacitPublicAmm(publicAmm).POOL()) == address(0)) TacitPublicAmm(publicAmm).initialize(pool);
        CollateralEngine eng = CollateralEngine(payable(engine));
        if (address(eng.POOL()) == address(0)) eng.setPool(pool);
        address admin = vm.envAddress("ENGINE_ADMIN");
        if (eng.owner() == tx.origin && admin != tx.origin) eng.transferOwnership(admin);
        // 3. Leaf periphery.
        _deploy(
            sRouter,
            abi.encodePacked(
                type(ConfidentialRouter).creationCode, abi.encode(pool, publicAmm, ZROUTER, PERMIT2)
            ),
            predict(sRouter),
            "router"
        );
        _deploy(sRelayer, abi.encodePacked(type(TacitRelayer).creationCode, abi.encode(pool)), predict(sRelayer), "relayer");
        _deploy(sBtc, abi.encodePacked(type(BtcCallExecutor).creationCode, abi.encode(pool)), predict(sBtc), "btcCallExecutor");
        vm.stopBroadcast();
    }
}
