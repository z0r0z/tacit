// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {ShieldedPool, IGroth16Verifier} from "../src/ShieldedPool.sol";
import {PoseidonT3} from "../src/lib/PoseidonT3.sol";

/// @dev Accepts any proof — accounting/flow tests.
contract AcceptVerifier is IGroth16Verifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external pure returns (bool) { return true; }
}

/// @dev Rejects every proof.
contract RejectVerifier is IGroth16Verifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external pure returns (bool) { return false; }
}

/// @dev Accepts only when pubSignals[4] (bindHash) equals an expected value —
///      proves the contract feeds the recipient/relayer/fee-bound bindHash to
///      the verifier as public input 4.
contract BindHashAssertingVerifier is IGroth16Verifier {
    uint256 public immutable expectedBindHash;
    constructor(uint256 e) { expectedBindHash = e; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata input)
        external view returns (bool) { return input[4] == expectedBindHash; }
}

contract ShieldedPoolTest is Test {
    uint256 constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant UNIT_SCALE = 1e10;

    ShieldedPool pool;
    uint256 constant DENOM_1ETH = 1 ether;
    uint256 constant DENOM_01ETH = 0.1 ether;
    bytes32 pid1;
    bytes32 pid01;

    // Empty proof — the mock verifiers ignore it.
    uint256[2] zA;
    uint256[2][2] zB;
    uint256[2] zC;

    function setUp() public {
        AcceptVerifier v = new AcceptVerifier();
        uint256[] memory denoms = new uint256[](2);
        denoms[0] = DENOM_1ETH;
        denoms[1] = DENOM_01ETH;
        pool = new ShieldedPool(address(v), denoms);
        pid1 = pool.getPoolId(DENOM_1ETH);
        pid01 = pool.getPoolId(DENOM_01ETH);
        vm.deal(address(this), 1000 ether);
    }

    // ──────────────────── deposit ────────────────────

    function test_deposit_success() public {
        pool.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
        assertEq(address(pool).balance, DENOM_1ETH);
        assertEq(pool.totalBalance(), DENOM_1ETH);
        assertEq(pool.getNextLeafIndex(pid1), 1);
    }

    function test_deposit_emits_event_and_records_root() public {
        pool.deposit{value: DENOM_1ETH}(bytes32(uint256(42)), DENOM_1ETH);
        assertTrue(pool.isKnownDepositRoot(pid1, pool.getPoolRoot(pid1)));
    }

    function test_deposit_duplicate_commitment_reverts() public {
        pool.deposit{value: DENOM_1ETH}(bytes32(uint256(7)), DENOM_1ETH);
        vm.expectRevert(ShieldedPool.DuplicateCommitment.selector);
        pool.deposit{value: DENOM_1ETH}(bytes32(uint256(7)), DENOM_1ETH);
    }

    function test_deposit_wrong_value_reverts() public {
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.deposit{value: 0.5 ether}(bytes32(uint256(1)), DENOM_1ETH);
    }

    function test_deposit_unknown_denomination_reverts() public {
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.deposit{value: 2 ether}(bytes32(uint256(1)), 2 ether);
    }

    function test_deposit_non_field_commitment_reverts() public {
        vm.expectRevert(ShieldedPool.InvalidFieldElement.selector);
        pool.deposit{value: DENOM_1ETH}(bytes32(FIELD_SIZE), DENOM_1ETH);
    }

    function test_batchDeposit_sum_and_mixed_denoms() public {
        bytes32[] memory cs = new bytes32[](3);
        cs[0] = bytes32(uint256(1)); cs[1] = bytes32(uint256(2)); cs[2] = bytes32(uint256(3));
        uint256[] memory ds = new uint256[](3);
        ds[0] = DENOM_1ETH; ds[1] = DENOM_01ETH; ds[2] = DENOM_01ETH;
        pool.batchDeposit{value: DENOM_1ETH + 2 * DENOM_01ETH}(cs, ds);
        assertEq(pool.getNextLeafIndex(pid1), 1);
        assertEq(pool.getNextLeafIndex(pid01), 2);
        assertEq(pool.totalBalance(), DENOM_1ETH + 2 * DENOM_01ETH);
    }

    function test_batchDeposit_wrong_sum_reverts() public {
        bytes32[] memory cs = new bytes32[](1);
        cs[0] = bytes32(uint256(1));
        uint256[] memory ds = new uint256[](1);
        ds[0] = DENOM_1ETH;
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.batchDeposit{value: DENOM_01ETH}(cs, ds);
    }

    // ──────────────────── tree parity ────────────────────

    function test_zeros_chain_matches_reference() public view {
        bytes32 z = bytes32(0);
        for (uint256 i; i < pool.TREE_LEVELS(); ++i) {
            assertEq(pool.zeros(i), z);
            z = _poseidon(z, z);
        }
    }

    function test_first_leaf_root_matches_reference() public {
        bytes32 commitment = bytes32(uint256(123456));
        pool.deposit{value: DENOM_1ETH}(commitment, DENOM_1ETH);

        bytes32 h = commitment;
        bytes32 z = bytes32(0);
        for (uint256 i; i < pool.TREE_LEVELS(); ++i) {
            h = _poseidon(h, z);    // index 0 → always left child
            z = _poseidon(z, z);
        }
        assertEq(pool.getPoolRoot(pid1), h);
    }

    // ──────────────────── withdraw ────────────────────

    function _depositAndRoot(bytes32 commitment) internal returns (bytes32 root) {
        pool.deposit{value: DENOM_1ETH}(commitment, DENOM_1ETH);
        root = pool.getPoolRoot(pid1);
    }

    function test_withdraw_happy_path() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        address recipient = makeAddr("recipient");
        bytes32 nh = bytes32(uint256(555));

        pool.withdraw(zA, zB, zC, root, nh, DENOM_1ETH, uint256(777), recipient, address(0), 0);

        assertEq(recipient.balance, DENOM_1ETH);
        assertEq(pool.totalBalance(), 0);
        assertTrue(pool.isNullifierSpent(pid1, nh));
    }

    function test_withdraw_with_relayer_fee() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        address recipient = makeAddr("recipient");
        address relayer = makeAddr("relayer");
        uint256 fee = 0.01 ether;

        pool.withdraw(zA, zB, zC, root, bytes32(uint256(1)), DENOM_1ETH, 0, recipient, relayer, fee);

        assertEq(recipient.balance, DENOM_1ETH - fee);
        assertEq(relayer.balance, fee);
    }

    function test_withdraw_reused_nullifier_reverts() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        pool.deposit{value: DENOM_1ETH}(bytes32(uint256(100)), DENOM_1ETH);
        bytes32 root2 = pool.getPoolRoot(pid1);
        address recipient = makeAddr("recipient");
        bytes32 nh = bytes32(uint256(555));

        pool.withdraw(zA, zB, zC, root, nh, DENOM_1ETH, 0, recipient, address(0), 0);
        vm.expectRevert(ShieldedPool.NullifierAlreadySpent.selector);
        pool.withdraw(zA, zB, zC, root2, nh, DENOM_1ETH, 0, recipient, address(0), 0);
    }

    function test_withdraw_unknown_root_reverts() public {
        _depositAndRoot(bytes32(uint256(99)));
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.withdraw(zA, zB, zC, bytes32(uint256(0xdead)), bytes32(uint256(1)), DENOM_1ETH, 0, makeAddr("r"), address(0), 0);
    }

    function test_withdraw_fee_exceeds_denom_reverts() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        vm.expectRevert(ShieldedPool.FeeExceedsDenomination.selector);
        pool.withdraw(zA, zB, zC, root, bytes32(uint256(1)), DENOM_1ETH, 0, makeAddr("r"), makeAddr("relayer"), DENOM_1ETH + 1);
    }

    function test_withdraw_zero_recipient_reverts() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        vm.expectRevert(ShieldedPool.ZeroAddress.selector);
        pool.withdraw(zA, zB, zC, root, bytes32(uint256(1)), DENOM_1ETH, 0, address(0), address(0), 0);
    }

    function test_withdraw_zero_relayer_with_fee_reverts() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        vm.expectRevert(ShieldedPool.InvalidRelayer.selector);
        pool.withdraw(zA, zB, zC, root, bytes32(uint256(1)), DENOM_1ETH, 0, makeAddr("r"), address(0), 1);
    }

    function test_withdraw_unknown_denomination_reverts() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        vm.expectRevert(ShieldedPool.InvalidDenomination.selector);
        pool.withdraw(zA, zB, zC, root, bytes32(uint256(1)), 2 ether, 0, makeAddr("r"), address(0), 0);
    }

    function test_withdraw_out_of_field_nullifier_reverts() public {
        bytes32 root = _depositAndRoot(bytes32(uint256(99)));
        vm.expectRevert(ShieldedPool.InvalidFieldElement.selector);
        pool.withdraw(zA, zB, zC, root, bytes32(FIELD_SIZE), DENOM_1ETH, 0, makeAddr("r"), address(0), 0);
    }

    function test_withdraw_verifier_false_reverts() public {
        RejectVerifier rv = new RejectVerifier();
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = DENOM_1ETH;
        ShieldedPool p = new ShieldedPool(address(rv), denoms);
        bytes32 ppid = p.getPoolId(DENOM_1ETH);
        p.deposit{value: DENOM_1ETH}(bytes32(uint256(1)), DENOM_1ETH);
        bytes32 root = p.getPoolRoot(ppid);
        vm.expectRevert(ShieldedPool.InvalidGroth16Proof.selector);
        p.withdraw(zA, zB, zC, root, bytes32(uint256(1)), DENOM_1ETH, 0, makeAddr("r"), address(0), 0);
    }

    // ──────────────────── bindHash binding ────────────────────

    function test_bindHash_binds_recipient_relayer_fee() public {
        // Predict the pool address so the asserting verifier can be built with
        // the exact bindHash the contract will compute (bindHash binds address(this)).
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        bytes32 assetId = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), address(0)));
        address recipient = makeAddr("recipient");
        address relayer = makeAddr("relayer");
        uint256 fee = 0.02 ether;
        uint256 expectedBindHash = uint256(sha256(abi.encodePacked(
            "tacit-eth-withdraw-v1", block.chainid, predicted,
            assetId, DENOM_1ETH, recipient, relayer, fee
        ))) % FIELD_SIZE;

        BindHashAssertingVerifier v = new BindHashAssertingVerifier(expectedBindHash);
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = DENOM_1ETH;
        ShieldedPool p = new ShieldedPool(address(v), denoms);
        assertEq(address(p), predicted);
        bytes32 ppid = p.getPoolId(DENOM_1ETH);
        p.deposit{value: DENOM_1ETH}(bytes32(uint256(1)), DENOM_1ETH);
        bytes32 root = p.getPoolRoot(ppid);

        // Correct (recipient, relayer, fee) → bindHash matches → accepted.
        p.withdraw(zA, zB, zC, root, bytes32(uint256(1)), DENOM_1ETH, 0, recipient, relayer, fee);
        assertEq(recipient.balance, DENOM_1ETH - fee);

        // A different recipient → different bindHash → verifier rejects.
        p.deposit{value: DENOM_1ETH}(bytes32(uint256(2)), DENOM_1ETH);
        bytes32 root2 = p.getPoolRoot(ppid);
        vm.expectRevert(ShieldedPool.InvalidGroth16Proof.selector);
        p.withdraw(zA, zB, zC, root2, bytes32(uint256(2)), DENOM_1ETH, 0, makeAddr("other"), relayer, fee);
    }

    // ──────────────────── capacity edge ────────────────────

    function test_deposit_tree_full_reverts() public {
        // _pools is mapping at slot 0; Pool.nextLeafIndex is field offset 1.
        bytes32 base = keccak256(abi.encode(pid1, uint256(0)));
        bytes32 nextLeafSlot = bytes32(uint256(base) + 1);
        vm.store(address(pool), nextLeafSlot, bytes32(pool.MAX_LEAVES()));
        assertEq(pool.getNextLeafIndex(pid1), pool.MAX_LEAVES());
        vm.expectRevert(ShieldedPool.MerkleTreeFull.selector);
        pool.deposit{value: DENOM_1ETH}(bytes32(uint256(1)), DENOM_1ETH);
    }

    // ──────────────────── helpers ────────────────────

    function _poseidon(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        uint256[2] memory inp; inp[0] = uint256(l); inp[1] = uint256(r);
        return bytes32(PoseidonT3.hash(inp));
    }
}
