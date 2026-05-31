// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) { return "Mock"; }
    function symbol() public pure override returns (string memory) { return "MCK"; }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract TacitBridgeMixerTest is TestHelper {
    TacitBridgeMixer mixer;
    BitcoinLightRelay relay;

    uint256 constant DENOM_1ETH = 1 ether;
    uint256 constant DENOM_01ETH = 0.1 ether;
    bytes32 constant AID = bytes32(uint256(1));
    bytes32 poolId1ETH;
    bytes32 poolId01ETH;

    function setUp() public {
        relay = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        poolId1ETH = keccak256(abi.encode(AID, DENOM_1ETH));
        poolId01ETH = keccak256(abi.encode(AID, DENOM_01ETH));
        uint256[] memory denoms = new uint256[](2);
        denoms[0] = DENOM_1ETH;
        denoms[1] = DENOM_01ETH;
        address predictedMixer = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        bytes32[] memory pids1 = new bytes32[](1);
        pids1[0] = poolId1ETH;
        bytes32[] memory pids2 = new bytes32[](1);
        pids2[0] = poolId01ETH;
        MockPoolRootVerifier prv1 = new MockPoolRootVerifier(pids1, AID, predictedMixer);
        MockPoolRootVerifier prv2 = new MockPoolRootVerifier(pids2, AID, predictedMixer);
        address[] memory verifiers = new address[](2);
        verifiers[0] = address(prv1);
        verifiers[1] = address(prv2);
        mixer = new TacitBridgeMixer(address(relay), address(v), address(0), 6, denoms, verifiers, 0x00, AID);
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
        vm.expectRevert(TacitBridgeMixer.InvalidDenomination.selector);
        mixer.deposit{value: 0.5 ether}(bytes32(uint256(42)), 0.5 ether);
    }

    function test_deposit_emits_event() public {
        vm.deal(address(this), 10 ether);
        vm.expectEmit(true, true, false, true);
        emit TacitBridgeMixer.Deposit(poolId1ETH, bytes32(uint256(42)), 0, block.timestamp);
        mixer.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
    }

    function test_deposit_field_overflow_reverts() public {
        vm.deal(address(this), 10 ether);
        uint256 fs = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        vm.expectRevert(TacitBridgeMixer.InvalidFieldElement.selector);
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
        vm.expectRevert(TacitBridgeMixer.DuplicateCommitment.selector);
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
        vm.expectRevert(TacitBridgeMixer.InvalidDenomination.selector);
        payable(address(mixer)).transfer(0.01 ether);
    }

    function test_constructor_zero_relay_reverts() public {
        MockGroth16Verifier v = new MockGroth16Verifier();
        uint256[] memory d = new uint256[](0);
        address[] memory vf = new address[](0);
        vm.expectRevert(TacitBridgeMixer.ZeroAddress.selector);
        new TacitBridgeMixer(address(0), address(v), address(0), 6, d, vf, 0x00, AID);
    }

    function test_constructor_zero_burn_verifier_reverts() public {
        BitcoinLightRelay r = _deployRelay();
        uint256[] memory d = new uint256[](0);
        address[] memory vf = new address[](0);
        vm.expectRevert(TacitBridgeMixer.ZeroAddress.selector);
        new TacitBridgeMixer(address(r), address(0), address(0), 6, d, vf, 0x00, AID);
    }

    function test_constructor_mismatched_arrays_reverts() public {
        BitcoinLightRelay r = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        uint256[] memory d = new uint256[](1);
        d[0] = DENOM_1ETH;
        address[] memory vf = new address[](0);
        vm.expectRevert();
        new TacitBridgeMixer(address(r), address(v), address(0), 6, d, vf, 0x00, AID);
    }

    function test_constructor_verifier_mismatch_reverts() public {
        BitcoinLightRelay r = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        bytes32 wrongPoolId = keccak256(abi.encode(AID, uint256(999 ether)));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        bytes32[] memory wrongPids = new bytes32[](1);
        wrongPids[0] = wrongPoolId;
        MockPoolRootVerifier badPrv = new MockPoolRootVerifier(wrongPids, AID, predicted);
        uint256[] memory d = new uint256[](1);
        d[0] = DENOM_1ETH;
        address[] memory vf = new address[](1);
        vf[0] = address(badPrv);
        vm.expectRevert(TacitBridgeMixer.VerifierMismatch.selector);
        new TacitBridgeMixer(address(r), address(v), address(0), 6, d, vf, 0x00, AID);
    }

    function test_batch_deposit_duplicate_commitment_reverts() public {
        vm.deal(address(this), 10 ether);
        bytes32[] memory comms = new bytes32[](2);
        comms[0] = bytes32(uint256(42));
        comms[1] = bytes32(uint256(42));
        uint256[] memory denoms = new uint256[](2);
        denoms[0] = DENOM_1ETH;
        denoms[1] = DENOM_1ETH;
        vm.expectRevert(TacitBridgeMixer.DuplicateCommitment.selector);
        mixer.batchDeposit{value: 2 ether}(comms, denoms);
    }

    function test_batch_deposit() public {
        vm.deal(address(this), 10 ether);
        bytes32[] memory comms = new bytes32[](3);
        comms[0] = bytes32(uint256(10));
        comms[1] = bytes32(uint256(11));
        comms[2] = bytes32(uint256(12));
        uint256[] memory denoms = new uint256[](3);
        denoms[0] = DENOM_1ETH;
        denoms[1] = DENOM_1ETH;
        denoms[2] = DENOM_01ETH;
        mixer.batchDeposit{value: 2.1 ether}(comms, denoms);
        assertEq(mixer.getNextLeafIndex(poolId1ETH), 2);
        assertEq(mixer.getNextLeafIndex(poolId01ETH), 1);
        assertEq(mixer.totalBalance(), 2.1 ether);
    }

    function test_batch_deposit_wrong_value_reverts() public {
        vm.deal(address(this), 10 ether);
        bytes32[] memory comms = new bytes32[](2);
        comms[0] = bytes32(uint256(10));
        comms[1] = bytes32(uint256(11));
        uint256[] memory denoms = new uint256[](2);
        denoms[0] = DENOM_1ETH;
        denoms[1] = DENOM_01ETH;
        vm.expectRevert(TacitBridgeMixer.InvalidDenomination.selector);
        mixer.batchDeposit{value: 1 ether}(comms, denoms);
    }
}

/// Audit blocker #3 — pool-tree exhaustion gate. The mixer must reject
/// new deposits when the SP1 pool tree (which also grows from off-chain
/// rotate/import) is within POOL_TREE_RESERVE of MAX_LEAVES. Without
/// this, an adversary spamming rotates on signet can fill the pool tree
/// while honest deposits still pass the deposit-tree gate, leaving their
/// ETH locked because the guest then silently skips the mint.
contract TacitBridgeMixerPoolCapacityTest is TestHelper {
    TacitBridgeMixer mixer;
    BitcoinLightRelay relay;
    MockPoolRootVerifierWithIndex prv;
    uint256 constant DENOM = 1 ether;
    bytes32 constant AID = bytes32(uint256(1));
    bytes32 pid;

    function setUp() public {
        relay = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        pid = keccak256(abi.encode(AID, DENOM));
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = DENOM;
        address predictedMixer = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        bytes32[] memory pids = new bytes32[](1);
        pids[0] = pid;
        prv = new MockPoolRootVerifierWithIndex(pids, AID, predictedMixer);
        address[] memory verifiers = new address[](1);
        verifiers[0] = address(prv);
        mixer = new TacitBridgeMixer(address(relay), address(v), address(0), 6, denoms, verifiers, 0x00, AID);
    }

    function test_deposit_succeeds_when_pool_below_reserve() public {
        vm.deal(address(this), 10 ether);
        uint64 reserve = mixer.POOL_TREE_RESERVE();
        uint64 maxLeaves = uint64(mixer.MAX_LEAVES());
        // Headroom: pool well below cap.
        prv.setPoolIndex(0, maxLeaves - reserve - 100);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        assertEq(mixer.getNextLeafIndex(pid), 1);
    }

    function test_deposit_reverts_when_pool_within_reserve() public {
        vm.deal(address(this), 10 ether);
        uint64 reserve = mixer.POOL_TREE_RESERVE();
        uint64 maxLeaves = uint64(mixer.MAX_LEAVES());
        // Inside the reserve window — gate must trip.
        prv.setPoolIndex(0, maxLeaves - reserve);
        vm.expectRevert(TacitBridgeMixer.MerkleTreeFull.selector);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
    }

    function test_deposit_reverts_when_pool_at_capacity() public {
        vm.deal(address(this), 10 ether);
        uint64 maxLeaves = uint64(mixer.MAX_LEAVES());
        // Pool tree completely full.
        prv.setPoolIndex(0, maxLeaves);
        vm.expectRevert(TacitBridgeMixer.MerkleTreeFull.selector);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
    }
}

contract TacitBridgeMixerERC20Test is TestHelper {
    TacitBridgeMixer mixer;
    MockERC20 token;
    bytes32 constant AID = bytes32(uint256(2));
    uint256 constant DENOM = 1_000_000; // 1 USDC (6 decimals)
    bytes32 poolId;

    function setUp() public {
        BitcoinLightRelay relay = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        token = new MockERC20();
        poolId = keccak256(abi.encode(AID, DENOM));
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = DENOM;
        address predictedMixer = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        bytes32[] memory pids = new bytes32[](1);
        pids[0] = poolId;
        MockPoolRootVerifier prv = new MockPoolRootVerifier(pids, AID, predictedMixer);
        address[] memory verifiers = new address[](1);
        verifiers[0] = address(prv);
        mixer = new TacitBridgeMixer(address(relay), address(v), address(token), 6, denoms, verifiers, 0x00, AID);
    }

    function test_erc20_deposit() public {
        token.mint(address(this), 10_000_000);
        token.approve(address(mixer), type(uint256).max);
        mixer.deposit(bytes32(uint256(42)), DENOM);
        assertEq(token.balanceOf(address(mixer)), DENOM);
        assertEq(mixer.getNextLeafIndex(poolId), 1);
        assertEq(mixer.totalBalance(), DENOM);
    }

    function test_erc20_deposit_with_eth_reverts() public {
        token.mint(address(this), 10_000_000);
        token.approve(address(mixer), type(uint256).max);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TacitBridgeMixer.InvalidDenomination.selector);
        mixer.deposit{value: 1}(bytes32(uint256(42)), DENOM);
    }

    function test_erc20_batch_deposit() public {
        token.mint(address(this), 10_000_000);
        token.approve(address(mixer), type(uint256).max);
        bytes32[] memory comms = new bytes32[](3);
        comms[0] = bytes32(uint256(1));
        comms[1] = bytes32(uint256(2));
        comms[2] = bytes32(uint256(3));
        uint256[] memory denoms = new uint256[](3);
        denoms[0] = DENOM;
        denoms[1] = DENOM;
        denoms[2] = DENOM;
        mixer.batchDeposit(comms, denoms);
        assertEq(token.balanceOf(address(mixer)), 3 * DENOM);
        assertEq(mixer.getNextLeafIndex(poolId), 3);
    }

    function test_erc20_unit_scale() public view {
        assertEq(mixer.UNIT_SCALE(), 1);
        assertEq(mixer.TACIT_DECIMALS(), 8);
    }
}
