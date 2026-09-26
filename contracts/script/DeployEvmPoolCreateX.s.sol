// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ICreateX} from "../src/ICreateX.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";

/// @notice Deploy the EVM client-proved pool suite (verifier, native-ETH pool, router) via CreateX CREATE3 at
///         addresses fixed in advance. The salts are permissioned (bytes 0..19 = DEPLOYER, byte 20 = 0x00), so
///         CreateX guards them as keccak256(abi.encode(DEPLOYER, salt)): only DEPLOYER can land these
///         addresses, and it lands the same ones on every chain regardless of bytecode or constructor args.
///
///         The verifier must be the ceremony's: its init code hash is pinned by EVM_POOL_VERIFIER_INITCODE_HASH
///         (printed by dapp/circuits/evm-pool finalize), so a development key cannot be deployed here.
///
///         EVM_POOL_VERIFIER_INITCODE_HASH=0x… forge script script/DeployEvmPoolCreateX.s.sol \
///             --rpc-url $RPC --broadcast --private-key <DEPLOYER key>
contract DeployEvmPoolCreateX is Script {
    ICreateX internal constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    address internal constant DEPLOYER = 0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7;

    bytes32 internal constant SALT_VERIFIER = 0x68575b073de49a94e3e3acf6f3a0d6e3b66267c70000000280000000000520ff;
    bytes32 internal constant SALT_POOL = 0x68575b073de49a94e3e3acf6f3a0d6e3b66267c70000000140000000003bb2ac;
    bytes32 internal constant SALT_ROUTER = 0x68575b073de49a94e3e3acf6f3a0d6e3b66267c700000003180000000007ecfe;

    address internal constant VERIFIER = 0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153;
    address internal constant POOL = 0x000000c2A20657CE25f2Ba99737933D031AFBEE9;
    address internal constant ROUTER = 0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5;

    address internal constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant V1_POOL_MAINNET = 0x000000000Ed1eabD231Be41d93b719056F7febFC;

    bytes32 internal constant CREATE3_PROXY_INITCODE_HASH = 0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f;

    function predict(bytes32 salt) public pure returns (address) {
        bytes32 guarded = keccak256(abi.encode(DEPLOYER, salt));
        address proxy = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(CREATEX), guarded, CREATE3_PROXY_INITCODE_HASH)))));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
    }

    function run() external {
        deploy(
            vm.envOr("EVM_POOL_VERIFIER_ARTIFACT", string("TransactVerifier.sol:TransactVerifier")),
            vm.envBytes32("EVM_POOL_VERIFIER_INITCODE_HASH")
        );
    }

    function deploy(string memory verifierArtifact, bytes32 verifierInitCodeHash) public {
        require(predict(SALT_VERIFIER) == VERIFIER && predict(SALT_POOL) == POOL && predict(SALT_ROUTER) == ROUTER, "salt/address mismatch");
        require(address(CREATEX).code.length != 0, "CreateX not on this chain");

        bytes memory verifierInit = vm.getCode(verifierArtifact);
        require(keccak256(verifierInit) == verifierInitCodeHash, "verifier is not the pinned ceremony verifier");

        address v1 = vm.envOr("EVM_POOL_V1", block.chainid == 1 ? V1_POOL_MAINNET : address(0));
        address zRouter = ZROUTER.code.length != 0 ? ZROUTER : address(0);
        address permit2 = PERMIT2.code.length != 0 ? PERMIT2 : address(0);

        vm.startBroadcast(DEPLOYER);
        _deploy(SALT_VERIFIER, verifierInit, VERIFIER);
        _deploy(SALT_POOL, abi.encodePacked(type(TacitEvmPool).creationCode, abi.encode(VERIFIER, address(0))), POOL);
        _deploy(
            SALT_ROUTER,
            abi.encodePacked(type(TacitEvmPoolRouter).creationCode, abi.encode(POOL, zRouter, permit2, v1)),
            ROUTER
        );
        vm.stopBroadcast();

        console2.log("verifier", VERIFIER);
        console2.log("pool    ", POOL);
        console2.log("router  ", ROUTER);
        console2.log("v1      ", v1);
    }

    function _deploy(bytes32 salt, bytes memory initCode, address expected) internal {
        if (expected.code.length != 0) {
            console2.log("already deployed:", expected);
            return;
        }
        require(CREATEX.deployCreate3(salt, initCode) == expected, "did not land at the expected address");
    }
}
