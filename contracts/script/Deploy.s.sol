// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/TacitETHMixer.sol";
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

        vm.startBroadcast(deployerKey);

        BitcoinLightRelay relay = new BitcoinLightRelay();
        relay.genesis(genesisEpochStart, genesisTarget, genesisTimestamp,
                      genesisTipHash, genesisTipHeight, genesisTipWork);

        // Deploy SP1 pool root verifier (permissionless proof submission).
        // Mixer address predicted via deployer nonce.
        address predictedMixer = vm.computeCreateAddress(msg.sender, vm.getNonce(msg.sender) + 1);
        bytes32 primaryPoolId = keccak256(abi.encode(assetId, uint256(1 ether)));
        SP1PoolRootVerifier rootVerifier = new SP1PoolRootVerifier(sp1Verifier, address(relay), programVKey, predictedMixer, assetId, networkTag, groth16VkHash, primaryPoolId);

        uint256[] memory denoms = new uint256[](5);
        denoms[0] = 0.01 ether;
        denoms[1] = 0.1 ether;
        denoms[2] = 1 ether;
        denoms[3] = 10 ether;
        denoms[4] = 100 ether;

        TacitETHMixer mixer = new TacitETHMixer(
            address(relay), burnVerifier, address(rootVerifier),
            address(0), // native ETH; pass ERC-20 address for token bridges
            6, denoms, networkTag, assetId
        );
        require(address(mixer) == predictedMixer, "nonce mismatch");

        vm.stopBroadcast();

        console.log("BitcoinLightRelay:", address(relay));
        console.log("SP1PoolRootVerifier:", address(rootVerifier));
        console.log("TacitETHMixer:", address(mixer));
    }
}
