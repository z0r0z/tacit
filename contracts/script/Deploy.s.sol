// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/TacitBridgeMixer.sol";
import "../src/lib/BitcoinLightRelay.sol";
import "../src/SP1PoolRootVerifier.sol";

contract DeployTacitBridge is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint8 networkTag = uint8(vm.envUint("NETWORK_TAG"));
        bytes32 assetId = vm.envBytes32("TETH_ASSET_ID");
        address burnVerifier = vm.envAddress("BURN_VERIFIER");
        address sp1Verifier = vm.envAddress("SP1_VERIFIER");
        bytes32 programVKey = vm.envBytes32("SP1_PROGRAM_VKEY");
        bytes32 groth16VkHash = vm.envBytes32("GROTH16_VK_HASH");
        uint256 genesisEpochStart = vm.envUint("BTC_GENESIS_EPOCH_START");
        uint256 genesisTarget = vm.envUint("BTC_GENESIS_TARGET");
        uint256 genesisTimestamp = vm.envUint("BTC_GENESIS_TIMESTAMP");
        bytes32 genesisTipHash = vm.envBytes32("BTC_TIP_HASH");
        uint256 genesisTipHeight = vm.envUint("BTC_TIP_HEIGHT");
        uint256 genesisTipWork = vm.envUint("BTC_TIP_WORK");

        uint256[] memory denoms = new uint256[](6);
        denoms[0] = 0.001 ether;
        denoms[1] = 0.01 ether;
        denoms[2] = 0.1 ether;
        denoms[3] = 1 ether;
        denoms[4] = 10 ether;
        denoms[5] = 100 ether;

        vm.startBroadcast(deployerKey);

        BitcoinLightRelay relay = new BitcoinLightRelay();
        relay.genesis(genesisEpochStart, genesisTarget, genesisTimestamp,
                      genesisTipHash, genesisTipHeight, genesisTipWork);

        address deployer = vm.addr(deployerKey);
        address predictedMixer = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + denoms.length);

        address[] memory verifiers = new address[](denoms.length);
        for (uint256 i; i < denoms.length; ++i) {
            bytes32 poolId = keccak256(abi.encode(assetId, denoms[i]));
            SP1PoolRootVerifier v = new SP1PoolRootVerifier(
                sp1Verifier, address(relay), programVKey, predictedMixer,
                assetId, networkTag, groth16VkHash, poolId, bytes32(denoms[i] / 10_000_000_000),
                genesisTipHash
            );
            verifiers[i] = address(v);
            console.log("SP1PoolRootVerifier [denom %s]:", denoms[i]);
            console.log("  ", address(v));
        }

        TacitBridgeMixer mixer = new TacitBridgeMixer(
            address(relay), burnVerifier, address(0),
            6, denoms, verifiers, networkTag, assetId
        );
        require(address(mixer) == predictedMixer, "nonce mismatch");

        vm.stopBroadcast();

        console.log("BitcoinLightRelay:", address(relay));
        console.log("TacitBridgeMixer:", address(mixer));
    }
}
