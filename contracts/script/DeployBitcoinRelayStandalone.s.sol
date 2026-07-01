// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/lib/BitcoinLightRelay.sol";

/// @notice Deploy a STANDALONE full-PoW BitcoinLightRelay for the V1 confidential-pool suite's HEADER_RELAY.
///         Mirrors Deploy.s.sol's relay genesis + header-validation EXACTLY, but deploys ONLY the relay
///         (no mixer, no denom pools). MAX_TARGET defaults to the MAINNET difficulty floor; do NOT pass
///         RELAY_MAX_TARGET on mainnet (a signet powLimit would accept easy headers). The header asserts
///         recompute the checkpoint from the real 80-byte Bitcoin headers so a typo fails LOUD at deploy.
///
///   Env: DEPLOYER_PRIVATE_KEY, BTC_GENESIS_EPOCH_START, BTC_GENESIS_TARGET, BTC_GENESIS_TIMESTAMP,
///        BTC_TIP_HASH (internal byte order), BTC_TIP_HEIGHT, BTC_TIP_WORK,
///        BTC_TIP_HEADER (80 bytes), BTC_EPOCH_START_HEADER (80 bytes).
contract DeployBitcoinRelayStandalone is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 genesisEpochStart = vm.envUint("BTC_GENESIS_EPOCH_START");
        uint256 genesisTarget = vm.envUint("BTC_GENESIS_TARGET");
        uint256 genesisTimestamp = vm.envUint("BTC_GENESIS_TIMESTAMP");
        bytes32 genesisTipHash = vm.envBytes32("BTC_TIP_HASH");
        uint256 genesisTipHeight = vm.envUint("BTC_TIP_HEIGHT");
        uint256 genesisTipWork = vm.envUint("BTC_TIP_WORK");

        require(block.chainid == 1, "relay: mainnet only (chainid != 1)");

        // Independently recompute the checkpoint from the real header bytes so a typo'd hash/target/timestamp
        // fails LOUD rather than bricking the immutable relay. tipWork/tipHeight/epochStart stay trusted env.
        bytes memory tipHeader = vm.envBytes("BTC_TIP_HEADER");
        bytes memory startHeader = vm.envBytes("BTC_EPOCH_START_HEADER");
        require(tipHeader.length == 80, "BTC_TIP_HEADER must be 80 bytes");
        require(startHeader.length == 80, "BTC_EPOCH_START_HEADER must be 80 bytes");
        require(_dsha256(tipHeader) == genesisTipHash, "BTC_TIP_HASH != dsha256(BTC_TIP_HEADER)");
        require(_targetOf(tipHeader) == genesisTarget, "BTC_GENESIS_TARGET != target(tip nBits)");
        require(_targetOf(startHeader) == genesisTarget, "BTC_GENESIS_TARGET != target(epoch-start nBits)");
        require(_timestampOf(startHeader) == genesisTimestamp, "BTC_GENESIS_TIMESTAMP != epoch-start ts");

        vm.startBroadcast(deployerKey);
        // Mainnet difficulty floor by default (network-specific). NEVER pass a signet powLimit on mainnet.
        uint256 relayMaxTarget =
            vm.envOr("RELAY_MAX_TARGET", uint256(0x00000000ffff0000000000000000000000000000000000000000000000000000));
        BitcoinLightRelay relay = new BitcoinLightRelay(relayMaxTarget);
        relay.genesis(genesisEpochStart, genesisTarget, genesisTimestamp,
                      genesisTipHash, genesisTipHeight, genesisTipWork);
        vm.stopBroadcast();

        console2.log("BitcoinLightRelay (mainnet, full PoW):", address(relay));
        console2.log("  tipHeight:", relay.tipHeight());
        console2.log("  tipWork:", relay.tipWork());
        console2.log("  maxTarget:", relayMaxTarget);
    }

    function _dsha256(bytes memory d) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(d)));
    }
    function _targetOf(bytes memory header) internal pure returns (uint256) {
        uint256 bits = uint256(uint8(header[72])) | (uint256(uint8(header[73])) << 8)
            | (uint256(uint8(header[74])) << 16) | (uint256(uint8(header[75])) << 24);
        uint256 exp = bits >> 24;
        uint256 mantissa = bits & 0x7fffff;
        return exp <= 3 ? mantissa >> (8 * (3 - exp)) : mantissa << (8 * (exp - 3));
    }
    function _timestampOf(bytes memory header) internal pure returns (uint256) {
        return uint256(uint8(header[68])) | (uint256(uint8(header[69])) << 8)
            | (uint256(uint8(header[70])) << 16) | (uint256(uint8(header[71])) << 24);
    }
}
