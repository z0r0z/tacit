// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacBuyback} from "../src/TacBuyback.sol";

/// @notice Deploy TacBuyback (plain CREATE; the deployer gets no role). Mainnet defaults; BUYBACK_KEEPER is
///         required because the keeper is fixed at deploy.
///   BUYBACK_KEEPER=0x… forge script script/DeployTacBuyback.s.sol --rpc-url $RPC            (simulate)
///   … --broadcast --private-key $KEY                                                         (deploy)
contract DeployTacBuyback is Script {
    function run() external returns (TacBuyback bb) {
        address amm = vm.envOr("BUYBACK_AMM", address(0x00000000E36C7EC997CC59DCda9E03673B448119));
        address precision = vm.envOr("BUYBACK_PRECISION", address(0x0155358241411dB868BA714aE7c83A27087e3D6E));
        address reserve = vm.envOr("BUYBACK_RESERVE", address(0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2));
        address keeper = vm.envAddress("BUYBACK_KEEPER");
        bytes32 ethAsset = vm.envOr("BUYBACK_ETH_ASSET", bytes32(0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34));
        bytes32 tacAsset = vm.envOr("BUYBACK_TAC_ASSET", bytes32(0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b));
        uint32 feeBps = uint32(vm.envOr("BUYBACK_FEE_BPS", uint256(30)));
        uint256 maxPerBuy = vm.envOr("BUYBACK_MAX_PER_BUY", uint256(0.25 ether));
        uint256 cooldown = vm.envOr("BUYBACK_COOLDOWN", uint256(6 hours));
        uint256 maxImpactBps = vm.envOr("BUYBACK_MAX_IMPACT_BPS", uint256(100));

        vm.startBroadcast();
        bb = new TacBuyback(amm, precision, reserve, keeper, ethAsset, tacAsset, feeBps, maxPerBuy, cooldown, maxImpactBps);
        vm.stopBroadcast();

        console2.log("TacBuyback deployed at:", address(bb));
        require(bb.RESERVE() == reserve && bb.KEEPER() == keeper && address(bb.PRECISION()) == precision, "wiring mismatch");
    }
}
