// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacitConfidentialFactory} from "../src/TacitConfidentialFactory.sol";

/// @notice Deploy the confidential-token factory and etch one sample token.
///
///  The denomination ladder and its constants D_i = d_i·H come from
///  script/confidential-ladder.json (generated via dapp/evm-confidential.js;
///  publicly verifiable as d_i·H). A production deploy regenerates that file for
///  its chosen ladder before broadcasting.
///
///  Local simulation:
///    forge script script/DeployConfidential.s.sol
///  Testnet:
///    forge script script/DeployConfidential.s.sol \
///      --rpc-url $RPC --private-key $PK --broadcast --verify
///  Env (optional): MINT_AUTHORITY, ETCH_SALT, META_URI.
contract DeployConfidential is Script {
    function run() external {
        string memory p = vm.readFile(string.concat(vm.projectRoot(), "/script/confidential-ladder.json"));
        uint256[8] memory ladder = _u8(p, ".ladder");
        uint256[8] memory Dx = _u8(p, ".Dx");
        uint256[8] memory Dy = _u8(p, ".Dy");

        address mintAuthority = vm.envOr("MINT_AUTHORITY", msg.sender);
        bytes32 salt = vm.envOr("ETCH_SALT", bytes32(uint256(1)));
        string memory meta = vm.envOr("META_URI", string(""));
        uint256[4] memory noPetch;

        vm.startBroadcast();
        TacitConfidentialFactory factory = new TacitConfidentialFactory();
        (address token, bytes32 assetId) = factory.etch(mintAuthority, ladder, Dx, Dy, noPetch, salt, meta);
        vm.stopBroadcast();

        console2.log("factory:      ", address(factory));
        console2.log("sample token: ", token);
        console2.log("mintAuthority:", mintAuthority);
        console2.logBytes32(assetId);
    }

    function _u8(string memory j, string memory k) internal view returns (uint256[8] memory out) {
        uint256[] memory a = vm.parseJsonUintArray(j, k);
        for (uint256 i; i < 8; ++i) out[i] = a[i];
    }
}
