// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacitConfidentialFactory} from "../src/TacitConfidentialFactory.sol";

/// @notice Deploy the confidential-token factory and etch one sample token.
///
///  The denomination ladder (d_i = 10**i and the points D_i = d_i·H) is
///  protocol-wide and baked into the token, so nothing ladder-specific is
///  configured here; the points are verifiable via denomPoints() in
///  dapp/evm-confidential.js.
///
///  Local simulation:
///    forge script script/DeployConfidential.s.sol
///  Testnet:
///    forge script script/DeployConfidential.s.sol \
///      --rpc-url $RPC --private-key $PK --broadcast --verify
///  Env (optional): MINT_AUTHORITY, ETCH_SALT, META_URI.
contract DeployConfidential is Script {
    function run() external {
        address mintAuthority = vm.envOr("MINT_AUTHORITY", msg.sender);
        bytes32 salt = vm.envOr("ETCH_SALT", bytes32(uint256(1)));
        TacitConfidentialFactory.Meta memory meta = TacitConfidentialFactory.Meta({
            name: vm.envOr("TOKEN_NAME", string("Tacit Confidential Sample")),
            symbol: vm.envOr("TOKEN_SYMBOL", string("tCSMPL")),
            decimals: uint8(vm.envOr("TOKEN_DECIMALS", uint256(8))),
            uri: vm.envOr("META_URI", string(""))
        });

        vm.startBroadcast();
        TacitConfidentialFactory factory = new TacitConfidentialFactory();
        (address token, bytes32 assetId) = factory.etchAuthority(mintAuthority, meta, salt);
        vm.stopBroadcast();

        console2.log("factory:      ", address(factory));
        console2.log("sample token: ", token);
        console2.log("mintAuthority:", mintAuthority);
        console2.logBytes32(assetId);
    }
}
