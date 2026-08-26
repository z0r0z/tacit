// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";
import {BtcCallExecutor} from "../src/BtcCallExecutor.sol";
import {EthCallOutbox} from "../src/EthCallOutbox.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
    function computeCreate3Address(bytes32 guardedSalt) external view returns (address);
}

/// Finisher for a PARTIAL DeployV1SuiteCreateX broadcast: the pool + factory + engine + adapter + publicAmm
/// (and their wiring) already deployed and confirmed; the router deploy ran out of gas and the three leaf
/// deploys after it never sent. These four are leaf periphery with NO post-wiring (the pool never references
/// them), so this script deploys ONLY them at their canonical salts, skipping any that already carry code.
/// Router gas is heavy (its ctor also deploys the exit-executor impl) — run with a generous gas multiplier.
contract DeployV1PeripheryFinish is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;

    // Mirrors DeployV1SuiteCreateX.guardRandom/predict: permissioned salt (salt[0:20]==deployer) guards to
    // keccak256(abi.encode(sender, salt)); predict via computeCreate3Address of that guarded salt.
    function guardRandom(bytes32 salt) internal pure returns (bytes32) {
        address s = address(bytes20(salt));
        if (s != address(0)) return keccak256(abi.encode(s, salt));
        return keccak256(abi.encode(salt));
    }

    function predict(bytes32 salt) public view returns (address) {
        return CREATEX.computeCreate3Address(guardRandom(salt));
    }

    function _deploy(bytes32 salt, bytes memory initCode, string memory name) internal {
        address at = predict(salt);
        if (at.code.length != 0) {
            console2.log(string.concat("skip (already deployed) ", name), at);
            return;
        }
        require(CREATEX.deployCreate3(salt, initCode) == at, string.concat(name, " address mismatch"));
        console2.log(string.concat("deployed ", name), at);
    }

    function run() external {
        bytes32 sRouter = vm.envBytes32("SALT_ROUTER");
        bytes32 sRelayer = vm.envBytes32("SALT_RELAYER");
        bytes32 sBtc = vm.envBytes32("SALT_BTC_CALL_EXECUTOR");
        bytes32 sOutbox = vm.envBytes32("SALT_ETH_CALL_OUTBOX");
        bytes32 sPool = vm.envBytes32("SALT_POOL");
        bytes32 sPublicAmm = vm.envBytes32("SALT_PUBLIC_AMM");

        address pool = predict(sPool);
        address publicAmm = predict(sPublicAmm);
        address zRouter = vm.envOr("ZROUTER", ZROUTER);
        address permit2 = vm.envOr("PERMIT2", PERMIT2);
        require(pool.code.length != 0, "pool not deployed - wrong salts/env");

        vm.startBroadcast();
        _deploy(
            sRouter,
            abi.encodePacked(type(ConfidentialRouter).creationCode, abi.encode(pool, publicAmm, zRouter, permit2)),
            "router"
        );
        _deploy(sRelayer, abi.encodePacked(type(TacitRelayer).creationCode, abi.encode(pool)), "relayer");
        _deploy(sBtc, abi.encodePacked(type(BtcCallExecutor).creationCode, abi.encode(pool)), "btcCallExecutor");
        _deploy(sOutbox, type(EthCallOutbox).creationCode, "ethCallOutbox");
        vm.stopBroadcast();
    }
}
