// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";

contract TacitETHMixerTest is TestHelper {
    TacitETHMixer mixer;
    BitcoinLightRelay relay;

    uint256 constant DENOM_1ETH = 1 ether;
    uint256 constant DENOM_01ETH = 0.1 ether;
    bytes32 constant AID = bytes32(uint256(1));
    bytes32 poolId1ETH;
    bytes32 poolId01ETH;

    function setUp() public {
        relay = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        uint256[] memory denoms = new uint256[](2);
        denoms[0] = DENOM_1ETH;
        denoms[1] = DENOM_01ETH;
        MockPoolRootVerifier prv = new MockPoolRootVerifier();
        mixer = new TacitETHMixer(address(relay), address(v), address(prv), address(0), 6, denoms, 0x00, AID);
        poolId1ETH = keccak256(abi.encode(AID, DENOM_1ETH));
        poolId01ETH = keccak256(abi.encode(AID, DENOM_01ETH));
    }

    function test_deposit_success() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
        assertEq(address(mixer).balance, DENOM_1ETH);
        assertEq(mixer.getNextLeafIndex(poolId1ETH), 1);
    }

    function test_deposit_updates_root() public {
        vm.deal(address(this), 10 ether);
        bytes32 r0 = mixer.getPoolRoot(poolId1ETH);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(100)), DENOM_1ETH);
        bytes32 r1 = mixer.getPoolRoot(poolId1ETH);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(200)), DENOM_1ETH);
        bytes32 r2 = mixer.getPoolRoot(poolId1ETH);
        assertTrue(r0 != r1 && r1 != r2);
    }

    function test_deposit_root_in_history() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
        assertTrue(mixer.isKnownDepositRoot(poolId1ETH, mixer.getPoolRoot(poolId1ETH)));
    }

    function test_deposit_wrong_denomination_reverts() public {
        vm.deal(address(this), 10 ether);
        vm.expectRevert(TacitETHMixer.InvalidDenomination.selector);
        mixer.deposit{value: 0.5 ether}(bytes32(uint256(42)), 0.5 ether);
    }

    function test_deposit_emits_event() public {
        vm.deal(address(this), 10 ether);
        vm.expectEmit(true, true, false, true);
        emit TacitETHMixer.Deposit(poolId1ETH, bytes32(uint256(42)), 0, block.timestamp);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
    }

    function test_deposit_field_overflow_reverts() public {
        vm.deal(address(this), 10 ether);
        uint256 fs = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        vm.expectRevert(TacitETHMixer.InvalidFieldElement.selector);
        mixer.deposit{value: DENOM_1ETH}(bytes32(fs), DENOM_1ETH);
    }

    function test_deposit_multiple_pools() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(1)), DENOM_1ETH);
        mixer.deposit{value: DENOM_01ETH}(bytes32(uint256(2)), DENOM_01ETH);
        assertEq(mixer.getNextLeafIndex(poolId1ETH), 1);
        assertEq(mixer.getNextLeafIndex(poolId01ETH), 1);
    }

    function test_deposit_duplicate_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
        vm.expectRevert(TacitETHMixer.DuplicateCommitment.selector);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
    }

    function test_pool_denomination() public view {
        assertEq(mixer.getPoolDenomination(poolId1ETH), DENOM_1ETH);
        assertEq(mixer.getPoolDenomination(poolId01ETH), DENOM_01ETH);
    }

    function test_burn_nullifier_initially_unspent() public view {
        assertFalse(mixer.isBurnNullifierSpent(poolId1ETH, bytes32(uint256(999))));
    }

    function test_receive_reverts() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TacitETHMixer.InvalidDenomination.selector);
        payable(address(mixer)).transfer(0.01 ether);
    }
}
