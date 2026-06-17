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

        // Fail closed even if the bash wrapper is bypassed: this is a mainnet
        // deploy, and the VKs must equal the committed ELF/ceremony pin or every
        // proveStateTransition reverts (InvalidVkHash / SP1 verify) and deposits brick.
        require(block.chainid == 1, "Deploy: mainnet only (chainid != 1)");
        string memory pin = vm.readFile("sp1/elf-vkey-pin.json");
        require(programVKey == vm.parseJsonBytes32(pin, ".program_vkey"), "SP1_PROGRAM_VKEY != pin");
        require(groth16VkHash == vm.parseJsonBytes32(pin, ".groth16_vk_hash"), "GROTH16_VK_HASH != pin");

        // Finer denoms = whole-note fractional sends without CXFER.
        // Smallest = 0.00001 ETH (10^13 wei = 1000 tacit-units) — fits well
        // above the 10^10-wei UNIT_SCALE floor. Max array bound is 16 per
        // SP1PoolRootVerifier (we use 8).
        uint256[] memory denoms = new uint256[](8);
        denoms[0] = 0.00001 ether;
        denoms[1] = 0.0001 ether;
        denoms[2] = 0.001 ether;
        denoms[3] = 0.01 ether;
        denoms[4] = 0.1 ether;
        denoms[5] = 1 ether;
        denoms[6] = 10 ether;
        denoms[7] = 100 ether;

        vm.startBroadcast(deployerKey);

        // MAX_TARGET is network-specific: mainnet cap by default; signet passes its powLimit via env.
        uint256 relayMaxTarget = vm.envOr("RELAY_MAX_TARGET", uint256(0x00000000ffff0000000000000000000000000000000000000000000000000000));
        BitcoinLightRelay relay = new BitcoinLightRelay(relayMaxTarget);
        relay.genesis(genesisEpochStart, genesisTarget, genesisTimestamp,
                      genesisTipHash, genesisTipHeight, genesisTipWork);

        address deployer = vm.addr(deployerKey);
        // One verifier covers all denominations, so the mixer is the next deploy after it.
        address predictedMixer = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);

        bytes32[] memory poolIds = new bytes32[](denoms.length);
        bytes32[] memory denomsTacit = new bytes32[](denoms.length);
        for (uint256 i; i < denoms.length; ++i) {
            poolIds[i] = keccak256(abi.encode(assetId, denoms[i]));
            denomsTacit[i] = bytes32(denoms[i] / 10_000_000_000);
        }

        SP1PoolRootVerifier verifier = new SP1PoolRootVerifier(
            sp1Verifier, address(relay), programVKey, predictedMixer,
            assetId, networkTag, groth16VkHash, poolIds, denomsTacit,
            genesisTipHash
        );
        console.log("SP1PoolRootVerifier (all denoms):", address(verifier));

        address[] memory verifiers = new address[](denoms.length);
        for (uint256 i; i < denoms.length; ++i) verifiers[i] = address(verifier);

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
