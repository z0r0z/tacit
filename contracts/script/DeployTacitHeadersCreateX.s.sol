// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TacitHeaders, IPoolView, IRelayView} from "../src/TacitHeaders.sol";

interface ICreateX3 {
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address);
}

/// @notice Deploy TacitHeaders via CreateX CREATE3 at a salt the community mined (GET https://api.tacit.finance/prover/salt/bank): a salt
///         guarded to Tacit's deployer, so only it can deploy there, at the same address on every chain. SALT_TACIT_HEADERS (the banked
///         salt) and EXPECTED_TACIT_HEADERS (its address, as the bank lists it) are required; POOL_ADDR and HEADER_RELAY_ADDR default to the
///         live pool and light relay. Broadcast from the deployer (0x68575B07…67C7), the salt's first twenty bytes.
contract DeployTacitHeadersCreateX is Script {
    ICreateX3 constant CREATEX = ICreateX3(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        bytes32 salt = vm.envBytes32("SALT_TACIT_HEADERS");
        address expected = vm.envAddress("EXPECTED_TACIT_HEADERS");
        address pool = vm.envOr("POOL_ADDR", address(0x000000000Ed1eabD231Be41d93b719056F7febFC));
        address relay = vm.envOr("HEADER_RELAY_ADDR", address(0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0));
        require(uint8(salt[20]) == 0x00, "salt byte[20] must be 0x00: guarded to the deployer, the same address on every chain");
        bytes memory initCode = abi.encodePacked(type(TacitHeaders).creationCode, abi.encode(IPoolView(pool), IRelayView(relay)));
        // From any other sender CreateX would guard the salt differently and deploy elsewhere: the check below fails in forge's simulation,
        // before anything is broadcast.
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(salt, initCode);
        vm.stopBroadcast();
        console2.log("TacitHeaders deployed at:", deployed);
        require(deployed == expected, "did NOT land at the expected address");
        require(address(TacitHeaders(deployed).POOL()) == pool && address(TacitHeaders(deployed).RELAY()) == relay, "wired to the wrong pool or relay");
    }
}
