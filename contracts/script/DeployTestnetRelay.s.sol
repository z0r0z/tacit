// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TestnetLightRelay} from "./DeployTestnet.s.sol";

/// @notice Deploy + seed a standalone signet BitcoinLightRelay (relaxed PoW) for the ConfidentialPool
///         reflection lane (cBTC backing + cross-chain). Decoupled from the sunset tETH mixer deploy: this
///         is the relay the V1 suite anchors reflection proofs to (HEADER_RELAY). Mainnet uses the real
///         BitcoinLightRelay via Deploy.s.sol genesis path; this is the testnet (signet) variant.
///
///  Env (signet defaults provided — override to re-anchor at a fresher matured tip):
///    BTC_GENESIS_EPOCH_START  multiple of 2016 (epoch start)
///    BTC_GENESIS_TARGET       compact difficulty target at that epoch
///    BTC_GENESIS_TIMESTAMP    epoch start block timestamp
///    BTC_TIP_HASH             anchor block hash (internal byte order)
///    BTC_TIP_HEIGHT           anchor height
///    BTC_TIP_WORK             cumulative work at the anchor (non-zero)
contract DeployTestnetRelay is Script {
    function run() external {
        uint256 epochStart = vm.envOr("BTC_GENESIS_EPOCH_START", uint256(304416));
        uint256 target = vm.envOr("BTC_GENESIS_TARGET", uint256(567861154474712223338616632446767823243784673126349960471809951268864));
        uint256 timestamp = vm.envOr("BTC_GENESIS_TIMESTAMP", uint256(1778816519));
        bytes32 tipHash = vm.envOr("BTC_TIP_HASH", bytes32(0x9adb35bb0996d74cf63498f0b60297ee85e44b18f0347e831f38710515000000));
        uint256 tipHeight = vm.envOr("BTC_TIP_HEIGHT", uint256(306094));
        uint256 tipWork = vm.envOr("BTC_TIP_WORK", uint256(62415369196664));
        require(tipWork > 0, "BTC_TIP_WORK must be non-zero");

        vm.startBroadcast();
        TestnetLightRelay relay = new TestnetLightRelay();
        relay.initTestnetGenesis(epochStart, target, timestamp, tipHash, tipHeight, tipWork);
        vm.stopBroadcast();

        console2.log("BitcoinLightRelay (signet):", address(relay));
        console2.log("anchor height:", tipHeight);
        console2.log("anchor hash:");
        console2.logBytes32(tipHash);
        console2.log("NEXT: pass HEADER_RELAY=<above> + GENESIS_REFLECTION_ANCHOR=<near-tip block hash> to DeployV1Suite");
    }
}
