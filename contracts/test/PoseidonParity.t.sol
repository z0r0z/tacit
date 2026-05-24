// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";
import "../src/lib/PoseidonT3.sol";
import "../src/lib/PoseidonT4.sol";

contract PoseidonParityTest is TestHelper {
    TacitETHMixer mixer;
    bytes32 poolId;

    function setUp() public {
        BitcoinLightRelay relay = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = 1 ether;
        MockPoolRootVerifier prv = new MockPoolRootVerifier();
        mixer = new TacitETHMixer(address(relay), address(v), address(prv), address(0), 6, denoms, 0x00, bytes32(uint256(1)));
        poolId = keccak256(abi.encode(bytes32(uint256(1)), uint256(1 ether)));
    }

    function test_poseidonT3_zero_inputs() public pure {
        uint256[2] memory inp;
        assertEq(PoseidonT3.hash(inp), 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864);
    }

    function test_poseidonT3_one_zero() public pure {
        uint256[2] memory inp;
        inp[0] = 1;
        assertEq(PoseidonT3.hash(inp), 0x28bb28a2c7566e896a177dc7328d4298d197973bcac177fb8291984a1cc43b7f);
    }

    function test_poseidonT3_small_values() public pure {
        uint256[2] memory inp;
        inp[0] = 42; inp[1] = 69;
        assertEq(PoseidonT3.hash(inp), 0x1037bbd601699449424c4121cfd5943113a34cbe78114fbc1199a56e0f2b2f07);
    }

    function test_poseidonT4_leaf_commitment() public pure {
        uint256[3] memory inp;
        inp[0] = 0x1111111111111111111111111111111111111111111111111111111111111111;
        inp[1] = 0x2222222222222222222222222222222222222222222222222222222222222222;
        inp[2] = 100000000;
        assertEq(PoseidonT4.hash(inp), 0x2355681d4287dc996a84de1401f295a9a7be70471528320ca235d600d670f679);
    }

    function test_single_deposit_root() public {
        bytes32 commitment = bytes32(uint256(42));
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: 1 ether}(commitment, 1 ether);

        bytes32 root = mixer.getPoolRoot(poolId);
        bytes32 expected = _computeRoot(commitment);
        assertEq(root, expected);
    }

    function test_two_deposits_root() public {
        bytes32 c1 = bytes32(uint256(100));
        bytes32 c2 = bytes32(uint256(200));
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: 1 ether}(c1, 1 ether);
        mixer.deposit{value: 1 ether}(c2, 1 ether);

        bytes32 root = mixer.getPoolRoot(poolId);
        bytes32 level0 = _poseidonHash(c1, c2);
        bytes32 current = level0;
        bytes32 zero = _poseidonHash(bytes32(0), bytes32(0));
        for (uint256 i = 1; i < 20; ++i) {
            current = _poseidonHash(current, zero);
            zero = _poseidonHash(zero, zero);
        }
        assertEq(root, current);
    }

    function test_roots_are_distinct() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: 1 ether}(bytes32(uint256(100)), 1 ether);
        bytes32 r1 = mixer.getPoolRoot(poolId);
        mixer.deposit{value: 1 ether}(bytes32(uint256(200)), 1 ether);
        bytes32 r2 = mixer.getPoolRoot(poolId);
        mixer.deposit{value: 1 ether}(bytes32(uint256(300)), 1 ether);
        bytes32 r3 = mixer.getPoolRoot(poolId);
        assertTrue(r1 != r2 && r2 != r3 && r1 != r3);
    }

    function _poseidonHash(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        uint256[2] memory inp;
        inp[0] = uint256(l); inp[1] = uint256(r);
        return bytes32(PoseidonT3.hash(inp));
    }

    function _computeRoot(bytes32 leaf) internal pure returns (bytes32) {
        bytes32 cur = leaf;
        bytes32 zero = bytes32(0);
        for (uint256 i; i < 20; ++i) {
            cur = _poseidonHash(cur, zero);
            zero = _poseidonHash(zero, zero);
        }
        return cur;
    }
}
