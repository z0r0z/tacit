// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployEvmPoolCreateX} from "../script/DeployEvmPoolCreateX.s.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";
import {TransactVerifierDev} from "./TransactVerifierDev.sol";

/// CreateX's CREATE3 path with its permissioned-salt guard (bytes 0..19 == msg.sender, byte 20 == 0x00 →
/// keccak256(abi.encode(msg.sender, salt)); any other sender falls through to the random guard).
contract MockCreateXPermissioned {
    bytes internal constant PROXY_INITCODE = hex"67363d3d37363d34f03d5260086018f3";

    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address child) {
        bytes32 guarded = address(bytes20(salt)) == msg.sender && salt[20] == 0x00
            ? keccak256(abi.encode(msg.sender, salt))
            : keccak256(abi.encode(salt));
        bytes memory init = PROXY_INITCODE;
        address proxy;
        assembly {
            proxy := create2(0, add(init, 0x20), mload(init), guarded)
        }
        require(proxy != address(0), "proxy");
        (bool ok,) = proxy.call(initCode);
        require(ok, "child");
        child = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
        require(child.code.length != 0, "no code");
    }
}

contract DeployEvmPoolCreateXTest is Test {
    address constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    address constant DEPLOYER = 0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7;

    function test_proxy_initcode_hash_matches_createx() public pure {
        assertEq(keccak256(hex"67363d3d37363d34f03d5260086018f3"), 0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f);
    }

    function test_deploys_the_suite_at_the_published_addresses() public {
        vm.etch(CREATEX, address(new MockCreateXPermissioned()).code);
        bytes memory init = vm.getCode("TransactVerifierDev.sol:TransactVerifierDev");
        vm.chainId(1);
        vm.etch(0x000000000Ed1eabD231Be41d93b719056F7febFC, hex"00");
        new DeployEvmPoolCreateX().deploy("TransactVerifierDev.sol:TransactVerifierDev", keccak256(init));

        TacitEvmPool pool = TacitEvmPool(payable(0x000000c2A20657CE25f2Ba99737933D031AFBEE9));
        TacitEvmPoolRouter router = TacitEvmPoolRouter(payable(0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5));
        assertEq(address(pool.VERIFIER()), 0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153);
        assertEq(pool.ASSET(), address(0));
        assertEq(address(router.POOL()), address(pool));
        assertEq(address(router.V1()), 0x000000000Ed1eabD231Be41d93b719056F7febFC);
        assertEq(router.ASSET(), address(0));
    }

    function test_refuses_an_unpinned_verifier() public {
        vm.etch(CREATEX, address(new MockCreateXPermissioned()).code);
        DeployEvmPoolCreateX s = new DeployEvmPoolCreateX();
        vm.expectRevert("verifier is not the pinned ceremony verifier");
        s.deploy("TransactVerifierDev.sol:TransactVerifierDev", bytes32(uint256(1)));
    }

    function test_another_sender_cannot_take_the_addresses() public {
        MockCreateXPermissioned cx = MockCreateXPermissioned(CREATEX);
        vm.etch(CREATEX, address(new MockCreateXPermissioned()).code);
        vm.prank(address(0xBAD));
        address got = cx.deployCreate3(0x68575b073de49a94e3e3acf6f3a0d6e3b66267c70000000140000000003bb2ac, hex"600160005360016000f3");
        assertTrue(got != 0x000000c2A20657CE25f2Ba99737933D031AFBEE9);
    }
}
