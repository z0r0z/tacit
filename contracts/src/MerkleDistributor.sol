// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @title  MerkleDistributor — a Uniswap-style merkle airdrop with a clawback deadline.
/// @notice The Ethereum-side distribution for a public, canonical bridged token (e.g. TAC bridged from
///         Bitcoin as a `CanonicalBridgedERC20`). Recipients are committed off-chain into a merkle tree;
///         each one redeems exactly once against an inclusion proof. After `CLAIM_DEADLINE` the owner may
///         `sweep` whatever is unclaimed back to the protocol, so an airdrop can never strand funds.
///
///         It is deliberately minimal and holds no per-account state beyond a claimed-bitmap:
///           • the tree root, the token, and the deadline are IMMUTABLE — a distributor instance is bound to
///             one airdrop and cannot be re-pointed at another root or token;
///           • a fresh instance is deployed per airdrop (the same pattern serves iterative airdrops);
///           • funding is just an ERC20 transfer to this address — the contract custodies the airdrop pool
///             until claimed or swept, and the deadline bounds how long it can sit.
///
///         Leaf encoding (the off-chain tree builder MUST match exactly):
///             leaf = keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))
///         Internal nodes use Solady `MerkleProofLib` commutative hashing — keccak256 of the two children in
///         ascending byte order — so the builder sorts each pair before hashing.
contract MerkleDistributor is Ownable {
    /// @notice The ERC20 being distributed.
    address public immutable TOKEN;
    /// @notice The merkle root committing the full `(index, account, amount)` set.
    bytes32 public immutable MERKLE_ROOT;
    /// @notice Unix time at/after which the owner may `sweep` the unclaimed remainder. Claims stay open
    ///         until swept (the deadline gates the clawback, not the claim).
    uint64 public immutable CLAIM_DEADLINE;
    /// @notice The summed allocation the off-chain builder committed into the tree (`sum(amount)` over every
    ///         leaf). Claims stay closed until this contract is funded to at least this amount, so an
    ///         under-funded or over-allocated airdrop fails loudly and deterministically before anyone claims
    ///         — instead of silently stranding the last valid claimants on a `safeTransfer` revert.
    uint256 public immutable EXPECTED_TOTAL;

    /// @notice True once the contract has been observed funded to `EXPECTED_TOTAL`. Latched on the first claim
    ///         (one-shot); thereafter the balance legitimately falls below the total as recipients claim.
    bool public opened;

    /// @dev Packed claimed flags: word index => 256 claim bits.
    mapping(uint256 => uint256) private _claimedBitMap;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event Opened(uint256 funded);

    error AlreadyClaimed();
    error InvalidProof();
    error DeadlineNotReached();
    error NotFunded();
    error BadConfig();

    /// @param token          the ERC20 to distribute (must have code).
    /// @param root           the merkle root over the leaves (non-zero).
    /// @param deadline       unix time from which `sweep` is allowed (must be in the future at deploy).
    /// @param owner_         the sweep authority (the protocol ops account / multisig).
    /// @param expectedTotal  the summed leaf allocation; claims stay closed until the contract holds at least
    ///                       this (the same figure the builder computes to know how much to fund).
    constructor(address token, bytes32 root, uint64 deadline, address owner_, uint256 expectedTotal) {
        if (token == address(0) || token.code.length == 0) revert BadConfig();
        if (root == bytes32(0)) revert BadConfig();
        if (deadline <= block.timestamp) revert BadConfig();
        if (owner_ == address(0)) revert BadConfig();
        if (expectedTotal == 0) revert BadConfig();
        TOKEN = token;
        MERKLE_ROOT = root;
        CLAIM_DEADLINE = deadline;
        EXPECTED_TOTAL = expectedTotal;
        _initializeOwner(owner_);
    }

    /// @notice True once `index` has been claimed.
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 word = _claimedBitMap[index >> 8];
        uint256 mask = 1 << (index & 0xff);
        return word & mask != 0;
    }

    /// @notice Redeem an allocation. Permissionless: anyone can submit a valid proof, but the tokens always
    ///         go to the committed `account`, so a third party can only ever pay gas to deliver someone's
    ///         airdrop. Reverts if already claimed or the proof does not reconstruct the root.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        if (!opened) {
            // One-shot funding latch: the first claim of a fully-funded airdrop opens it; an under-funded
            // airdrop reverts here for EVERY claimant until topped up to `EXPECTED_TOTAL`, so a builder's
            // over-allocation surfaces immediately rather than stranding whoever claims last.
            uint256 funded = SafeTransferLib.balanceOf(TOKEN, address(this));
            if (funded < EXPECTED_TOTAL) revert NotFunded();
            opened = true;
            emit Opened(funded);
        }
        if (isClaimed(index)) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encodePacked(index, account, amount));
        if (!MerkleProofLib.verifyCalldata(proof, MERKLE_ROOT, leaf)) revert InvalidProof();
        _claimedBitMap[index >> 8] |= (1 << (index & 0xff));
        SafeTransferLib.safeTransfer(TOKEN, account, amount);
        emit Claimed(index, account, amount);
    }

    /// @notice After the deadline, return the unclaimed remainder to `to`. Claiming is never disabled by the
    ///         deadline; this only lets the owner reclaim what's left once the window has passed.
    function sweep(address to) external onlyOwner {
        if (block.timestamp < CLAIM_DEADLINE) revert DeadlineNotReached();
        if (to == address(0)) revert BadConfig();
        uint256 bal = SafeTransferLib.balanceOf(TOKEN, address(this));
        SafeTransferLib.safeTransfer(TOKEN, to, bal);
        emit Swept(to, bal);
    }
}
