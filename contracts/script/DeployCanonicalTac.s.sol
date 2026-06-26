// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {FixedSupplyMinter} from "../src/CanonicalMinters.sol";

/// @notice Deploy a TESTNET stand-in for canonical TAC.
///
///         The real canonical TAC already lives on Bitcoin mainnet and is hardcoded in the dapp; on mainnet
///         the public Ethereum TAC is the canonical token bridged from that asset (NOT this script). On
///         TESTNET we etch a deploy-and-die fixed-supply 21,000,000 TAC (8-dec, matching the Bitcoin asset's
///         base precision) minted to the ops recipient — the funding source for the airdrop distributor and
///         the LP/farm incentives. The minter is inert after construction, so the testnet supply is fixed.
///
///  Env:
///    CANONICAL_FACTORY (required) the deployed CanonicalAssetFactory
///    TAC_RECIPIENT     (default broadcaster) receives the full 21,000,000 TAC supply (the ops treasury)
///    TAC_ETCHER        (default TAC_RECIPIENT) CREATE2 namespace for the asset id
///    TAC_SALT          (default 0x7ac) CREATE2 salt
///    TAC_CID           (default 0) metadata cid (EIP-7572 contractURI)
contract DeployCanonicalTac is Script {
    uint8 constant TAC_DECIMALS = 8;
    uint256 constant TAC_SUPPLY = 21_000_000 * 10 ** 8;

    function run() external {
        require(block.chainid != 1, "DeployCanonicalTac: testnet only (mainnet uses the real bridged TAC)");
        address factory = vm.envAddress("CANONICAL_FACTORY");
        require(factory != address(0) && factory.code.length != 0, "CANONICAL_FACTORY not a contract");
        address recipient = vm.envOr("TAC_RECIPIENT", msg.sender);
        address etcher = vm.envOr("TAC_ETCHER", recipient);
        bytes32 salt = vm.envOr("TAC_SALT", bytes32(uint256(0x7ac)));
        bytes32 cid = vm.envOr("TAC_CID", bytes32(0));
        require(recipient != address(0), "TAC_RECIPIENT is zero");

        vm.startBroadcast();
        FixedSupplyMinter minter =
            new FixedSupplyMinter(CanonicalAssetFactory(factory), etcher, salt, "TAC", TAC_DECIMALS, cid, TAC_SUPPLY, recipient);
        vm.stopBroadcast();

        console2.log("TAC FixedSupplyMinter:", address(minter));
        console2.log("TAC ERC20 (public)   :", address(minter.TOKEN()));
        console2.log("recipient (21M TAC)  :", recipient);
        console2.log("TAC asset id         :");
        console2.logBytes32(minter.ASSET_ID());
    }
}
