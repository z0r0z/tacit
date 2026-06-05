// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "./lib/PoseidonT3.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a, uint256[2][2] calldata b,
        uint256[2] calldata c, uint256[5] calldata input
    ) external view returns (bool);
}

/// @title ShieldedPool
/// @notice Native ETH shielded pool on Ethereum L1. Deposit and withdraw run
///         entirely on Ethereum — no Bitcoin relay, no SP1, no bridge. Reuses
///         the Tacit mixer ceremony's Groth16 withdraw circuit: the canonical
///         BURN_VERIFIER is stateless and serves every pool, so this contract
///         binds to the same deployed verifier the bridge uses.
///
///  Two operations:
///    deposit()  — lock ETH, add a note commitment to the denomination's
///                 Poseidon deposit tree
///    withdraw() — verify a Groth16 proof of knowledge of a leaf's secrets
///                 against a known historical root, release funds to a fresh
///                 recipient (optionally via a fee-taking relayer)
///
///  The withdraw circuit is domain-generic: `denomination` is a public input
///  and `bind_hash` is constrained only as `bind_squared == bind_hash²`, so the
///  preimage layout is this contract's choice. The "tacit-eth-withdraw-v1"
///  domain binds recipient, relayer, and fee into the proof — they cannot be
///  changed in the mempool — and is distinct from the bridge burn domain, so
///  proofs are never reusable across the two surfaces.
///
///  Notes are byte-identical to bridge notes at the same denomination ladder:
///  the circuit public input `denomination` is in Tacit 8-decimal units, so the
///  leaf commits `Poseidon₃(secret, ν, denom_tacit_units)`. withdraw() takes
///  amounts in wei and scales by UNIT_SCALE for the public input; bindHash binds
///  the recipient-facing wei amounts.
contract ShieldedPool is ReentrancyGuardTransient {
    // ──────────────────── Constants ────────────────────

    uint256 public constant TREE_LEVELS = 20;
    uint256 public constant MAX_LEAVES = 1 << TREE_LEVELS;
    uint8 public constant TACIT_DECIMALS = 8;

    uint256 internal constant _FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ──────────────────── Immutables ────────────────────

    IGroth16Verifier public immutable BURN_VERIFIER;
    uint256 public immutable UNIT_SCALE; // 10^(18 - 8) for native ETH
    bytes32 public immutable ASSET_ID;

    // ──────────────────── Storage ────────────────────

    struct Pool {
        uint256 denomination;
        uint256 nextLeafIndex;
        bytes32 currentRoot;
        mapping(uint256 => bytes32) filledSubtrees;
        mapping(bytes32 => bool) nullifiers;
        mapping(bytes32 => bool) commitments;
    }

    mapping(bytes32 => Pool) internal _pools;
    /// Total escrowed ETH across all denominations of this asset. Withdrawals
    /// gate on this aggregate, not per-pool, so any denomination stays fungible
    /// once the pool holds enough backing (the Groth16 proof + per-pool
    /// nullifier set already cap redeemable value to deposits).
    uint256 public totalBalance;
    mapping(bytes32 => mapping(bytes32 => bool)) public everKnownRoot;
    bytes32[] public poolIds;
    bytes32[TREE_LEVELS] public zeros;

    // ──────────────────── Events ────────────────────

    event Deposit(bytes32 indexed poolId, bytes32 indexed commitment, uint256 leafIndex, uint256 timestamp);
    event Withdrawal(bytes32 indexed poolId, bytes32 indexed nullifierHash, address recipient, address relayer, uint256 fee);

    // ──────────────────── Errors ────────────────────

    error ZeroAddress();
    error MerkleTreeFull();
    error DuplicateCommitment();
    error InvalidDenomination();
    error DuplicateDenomination();
    error DenominationNotAligned();
    error InvalidFieldElement();
    error InvalidGroth16Proof();
    error NullifierAlreadySpent();
    error InsufficientBalance();
    error UnknownRoot();
    error FeeExceedsDenomination();
    error InvalidRelayer();

    // ──────────────────── Constructor ────────────────────

    constructor(address burnVerifier_, uint256[] memory denominations_) {
        if (burnVerifier_ == address(0)) revert ZeroAddress();
        require(denominations_.length > 0);

        BURN_VERIFIER = IGroth16Verifier(burnVerifier_);
        UNIT_SCALE = 10 ** (18 - TACIT_DECIMALS);
        ASSET_ID = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), address(0)));

        bytes32 z = bytes32(0);
        for (uint256 i; i < TREE_LEVELS; ++i) { zeros[i] = z; z = _hash(z, z); }

        for (uint256 i; i < denominations_.length; ++i) {
            uint256 d = denominations_[i];
            if (d == 0 || d >= _FIELD_SIZE) revert DenominationNotAligned();
            if (d % UNIT_SCALE != 0) revert DenominationNotAligned();
            bytes32 pid = keccak256(abi.encode(ASSET_ID, d));
            if (_pools[pid].denomination != 0) revert DuplicateDenomination();
            Pool storage p = _pools[pid];
            p.denomination = d;
            for (uint256 j; j < TREE_LEVELS; ++j) p.filledSubtrees[j] = zeros[j];
            p.currentRoot = z;
            poolIds.push(pid);
        }
    }

    receive() external payable { revert InvalidDenomination(); }

    // ──────────────────── 1. Deposit ────────────────────

    /// @notice Batch deposit — split an amount into multiple denominations in
    ///         one tx. msg.value must equal the sum of all denominations.
    function batchDeposit(bytes32[] calldata commitments, uint256[] calldata denominations) external payable nonReentrant {
        require(commitments.length == denominations.length);
        uint256 totalValue;
        for (uint256 i; i < commitments.length; ++i) {
            _insertDeposit(commitments[i], denominations[i]);
            totalValue += denominations[i];
        }
        if (msg.value != totalValue) revert InvalidDenomination();
    }

    /// @notice Single deposit. msg.value must equal denomination.
    function deposit(bytes32 commitment, uint256 denomination) external payable nonReentrant {
        _insertDeposit(commitment, denomination);
        if (msg.value != denomination) revert InvalidDenomination();
    }

    function _insertDeposit(bytes32 commitment, uint256 denomination) internal {
        bytes32 pid = keccak256(abi.encode(ASSET_ID, denomination));
        Pool storage p = _pools[pid];
        if (p.denomination == 0 || p.denomination != denomination) revert InvalidDenomination();
        if (p.nextLeafIndex >= MAX_LEAVES) revert MerkleTreeFull();
        if (uint256(commitment) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (p.commitments[commitment]) revert DuplicateCommitment();

        p.commitments[commitment] = true;

        uint256 idx = p.nextLeafIndex;
        bytes32 h = commitment;
        for (uint256 i; i < TREE_LEVELS; ++i) {
            if (idx & 1 == 0) { p.filledSubtrees[i] = h; h = _hash(h, zeros[i]); }
            else { h = _hash(p.filledSubtrees[i], h); }
            idx >>= 1;
        }

        p.currentRoot = h;
        everKnownRoot[pid][h] = true;
        p.nextLeafIndex++;
        totalBalance += denomination;

        emit Deposit(pid, commitment, p.nextLeafIndex - 1, block.timestamp);
    }

    // ──────────────────── 2. Withdraw ────────────────────

    /// @notice Verify a Groth16 proof of knowledge of a leaf's secrets against
    ///         a known historical root and release funds. recipient, relayer,
    ///         and fee are bound into the proof via bindHash, so they are not
    ///         malleable in the mempool. denomination and fee are in wei.
    ///         a/b/c are in snarkjs `exportSolidityCallData` order (the G2 point
    ///         b is already swapped to the pairing-precompile order); the
    ///         contract passes them straight to the verifier with no swap.
    function withdraw(
        uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c,
        bytes32 root, bytes32 nullifierHash,
        uint256 denomination, uint256 rLeaf,
        address recipient, address relayer, uint256 fee
    ) external nonReentrant {
        bytes32 pid = keccak256(abi.encode(ASSET_ID, denomination));
        Pool storage p = _pools[pid];
        if (p.denomination == 0 || p.denomination != denomination) revert InvalidDenomination();
        if (!everKnownRoot[pid][root]) revert UnknownRoot();
        if (p.nullifiers[nullifierHash]) revert NullifierAlreadySpent();
        if (recipient == address(0)) revert ZeroAddress();
        if (fee > denomination) revert FeeExceedsDenomination();
        if (fee != 0 && relayer == address(0)) revert InvalidRelayer();
        if (totalBalance < denomination) revert InsufficientBalance();

        uint256 denomTacit = denomination / UNIT_SCALE;
        bytes32 bindHash = bytes32(uint256(sha256(abi.encodePacked(
            "tacit-eth-withdraw-v1", block.chainid, address(this),
            ASSET_ID, denomination, recipient, relayer, fee
        ))) % _FIELD_SIZE);

        _verifyProof(a, b, c, root, nullifierHash, denomTacit, rLeaf, bindHash);

        p.nullifiers[nullifierHash] = true;
        totalBalance -= denomination;
        emit Withdrawal(pid, nullifierHash, recipient, relayer, fee);

        SafeTransferLib.forceSafeTransferETH(recipient, denomination - fee);
        if (fee != 0) SafeTransferLib.forceSafeTransferETH(relayer, fee);
    }

    // ──────────────────── Views ────────────────────

    function getPoolId(uint256 denomination) external view returns (bytes32) {
        return keccak256(abi.encode(ASSET_ID, denomination));
    }
    function getPoolRoot(bytes32 pid) external view returns (bytes32) { return _pools[pid].currentRoot; }
    function isKnownDepositRoot(bytes32 pid, bytes32 root) external view returns (bool) { return everKnownRoot[pid][root]; }
    function isNullifierSpent(bytes32 pid, bytes32 n) external view returns (bool) { return _pools[pid].nullifiers[n]; }
    function getPoolDenomination(bytes32 pid) external view returns (uint256) { return _pools[pid].denomination; }
    function getNextLeafIndex(bytes32 pid) external view returns (uint256) { return _pools[pid].nextLeafIndex; }
    function poolCount() external view returns (uint256) { return poolIds.length; }

    // ──────────────────── Internals: Groth16 ────────────────────

    function _verifyProof(
        uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c,
        bytes32 root, bytes32 nh, uint256 den, uint256 rl, bytes32 bh
    ) internal view {
        if (uint256(root) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (uint256(nh) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (den >= _FIELD_SIZE) revert InvalidFieldElement();
        if (rl >= _FIELD_SIZE) revert InvalidFieldElement();

        uint256[5] memory pub;
        pub[0] = uint256(root); pub[1] = uint256(nh);
        pub[2] = den; pub[3] = rl; pub[4] = uint256(bh);

        if (!BURN_VERIFIER.verifyProof(a, b, c, pub)) revert InvalidGroth16Proof();
    }

    // ──────────────────── Internals: Poseidon ────────────────────

    function _hash(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        uint256[2] memory inp; inp[0] = uint256(l); inp[1] = uint256(r);
        return bytes32(PoseidonT3.hash(inp));
    }
}
