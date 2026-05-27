// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/TacitBridgeMixer.sol";
import "../src/lib/BitcoinLightRelay.sol";
import "../src/SP1PoolRootVerifier.sol";

contract MockSP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockBurnVerifier {
    function verifyProof(
        uint256[2] calldata, uint256[2][2] calldata,
        uint256[2] calldata, uint256[5] calldata
    ) external pure returns (bool) { return true; }
}

contract TestnetLightRelay is BitcoinLightRelay {
    function _bitsToTarget(uint32 bits) internal pure override returns (uint256) {
        if (bits & 0x00800000 != 0) revert InvalidTarget();
        uint256 exp = bits >> 24;
        uint256 mantissa = bits & 0x7fffff;
        if (mantissa == 0) revert InvalidTarget();
        uint256 target;
        if (exp <= 3) {
            target = mantissa >> (8 * (3 - exp));
        } else {
            if (exp > 32) revert InvalidPoW();
            target = mantissa << (8 * (exp - 3));
        }
        if (target == 0) revert InvalidTarget();
        return target;
    }
    function testnetGenesis(
        uint256 epochStart, uint256 target, uint256 startTimestamp,
        bytes32 tipHash, uint256 tipHeight_, uint256 tipWork_
    ) external {
        if (msg.sender != DEPLOYER) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        require(tipWork_ > 0);
        uint256 epoch = epochStart / EPOCH_LENGTH;
        genesisEpoch = epoch;
        currentEpoch = epoch;
        epochTarget[epoch] = target;
        epochStartTimestamp[epoch] = startTimestamp;
        tip = tipHash;
        tipHeight = tipHeight_;
        tipWork = tipWork_;
        blockWork[tipHash] = tipWork_;
        blockHeight[tipHash] = tipHeight_;
        initialized = true;
    }
}

contract DeployTestnet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint8 networkTag = 0x01; // signet

        vm.startBroadcast(deployerKey);

        MockSP1Verifier sp1Mock = new MockSP1Verifier();
        MockBurnVerifier burnMock = new MockBurnVerifier();
        console.log("MockSP1Verifier:", address(sp1Mock));
        console.log("MockBurnVerifier:", address(burnMock));

        TestnetLightRelay relay = new TestnetLightRelay();
        uint256 signetEpochStart = vm.envUint("BTC_GENESIS_EPOCH_START");
        uint256 signetTarget = vm.envUint("BTC_GENESIS_TARGET");
        uint256 signetTimestamp = vm.envUint("BTC_GENESIS_TIMESTAMP");
        bytes32 signetTipHash = vm.envBytes32("BTC_TIP_HASH");
        uint256 signetTipHeight = vm.envUint("BTC_TIP_HEIGHT");
        uint256 signetTipWork = vm.envUint("BTC_TIP_WORK");
        relay.testnetGenesis(signetEpochStart, signetTarget, signetTimestamp,
                             signetTipHash, signetTipHeight, signetTipWork);
        console.log("BitcoinLightRelay:", address(relay));

        // Placeholder domain values for testnet
        // tETH signet asset_id from CETCH reveal txid afbc72e0...
        bytes32 assetId = vm.envOr("TETH_ASSET_ID", bytes32(0xd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b));
        bytes32 programVKey = bytes32(uint256(1));
        bytes32 groth16VkHash = bytes32(uint256(1));

        uint256[] memory denoms = new uint256[](6);
        denoms[0] = 0.001 ether;
        denoms[1] = 0.01 ether;
        denoms[2] = 0.1 ether;
        denoms[3] = 1 ether;
        denoms[4] = 10 ether;
        denoms[5] = 100 ether;

        address deployer = vm.addr(deployerKey);
        address predictedMixer = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + denoms.length);

        address[] memory verifiers = new address[](denoms.length);
        for (uint256 i; i < denoms.length; ++i) {
            bytes32 poolId = keccak256(abi.encode(assetId, denoms[i]));
            SP1PoolRootVerifier v = new SP1PoolRootVerifier(
                address(sp1Mock), address(relay), programVKey, predictedMixer,
                assetId, networkTag, groth16VkHash, poolId, bytes32(denoms[i] / 10_000_000_000),
                signetTipHash
            );
            verifiers[i] = address(v);
            console.log("Verifier [%s wei]:", denoms[i]);
            console.log("  ", address(v));
        }

        TacitBridgeMixer mixer = new TacitBridgeMixer(
            address(relay), address(burnMock), address(0),
            6, denoms, verifiers, networkTag, assetId
        );
        require(address(mixer) == predictedMixer, "nonce mismatch");

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYED ===");
        console.log("TacitBridgeMixer:", address(mixer));
        console.log("BitcoinLightRelay:", address(relay));
        console.log("Network: Sepolia + Signet");
        console.log("Denominations: 0.001 / 0.01 / 0.1 / 1 / 10 / 100 ETH");
    }
}
