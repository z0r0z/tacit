// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IAirdropPool {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

/// @title TacAirdrop — a one-shot merkle distributor for the public TAC ERC20
/// @notice A single funded pool of TAC, committed to a merkle root of `(index, account, amount)` leaves. Each leaf is claimed at
///         most once, either as public TAC (`claim`, `claimTo`) or straight into a confidential-pool wrap deposit
///         (`claimAndShield`). Everything that defines the airdrop is immutable: the token, the root, the claim deadline and the
///         guardian. There is no proxy, no owner and no way to change any of them.
///
///         The guardian (the ops multisig, which must be a contract) can pause claims, and can sweep any balance out at any time, including before the
///         deadline. It cannot change the root, the token or the deadline, and it cannot claim on anyone's behalf.
///
///         Leaf: `keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))`. Internal nodes hash the sorted pair.
///
/// @dev `claimAndShield` relies on the pool burning the pool-minted TAC straight from this contract's balance in `wrap`, so no
///      allowance is ever granted; the constructor refuses any asset that is not pool-minted. The pool has no cancel or refund
///      path for a pending deposit: it is cleared only by the depositor's own wrap proof, which needs the note secrets the
///      caller derived with the commit. Nothing is ever owed back to this contract.
///      Every claim path sets its bit before it calls the token or the pool, both fixed at deployment, so a repeated entry
///      cannot claim a leaf twice and no reentrancy guard is needed.
contract TacAirdrop {
    address public immutable TOKEN;
    bytes32 public immutable MERKLE_ROOT;
    address public immutable GUARDIAN;
    /// Last second at which a claim is accepted; from the next second on claims revert and only the guardian can move funds.
    uint64 public immutable CLAIM_DEADLINE;
    address public immutable POOL;
    bytes32 public immutable ASSET_ID;
    /// The pool's base units per value unit for the asset (1e10 for TAC). A shielded claim must be a multiple of it.
    uint256 public immutable UNIT_SCALE;

    bool public paused;

    /// index / 256 => 256 claim bits
    mapping(uint256 => uint256) private _claimed;

    error Paused();
    error NotGuardian();
    error BadConfig();
    error BadRecipient();
    error BadProof();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error AmountNotAligned();
    error ZeroCommit();

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event PausedSet(bool paused);

    modifier onlyGuardian() {
        if (msg.sender != GUARDIAN) revert NotGuardian();
        _;
    }

    /// @param pool the confidential pool `claimAndShield` deposits into
    /// @param assetId the pool's asset id for `token` (a pool-minted, registered asset whose underlying is `token`)
    constructor(address token, bytes32 root, address guardian, uint64 claimDeadline, address pool, bytes32 assetId) {
        if (token == address(0) || guardian == address(0) || pool == address(0)) revert BadConfig();
        if (root == bytes32(0) || claimDeadline <= block.timestamp || claimDeadline > block.timestamp + 400 days) revert BadConfig();
        if (guardian.code.length == 0) revert BadConfig();
        (bool registered, address underlying, uint256 scale,, bool poolMinted,) = IAirdropPool(pool).assets(assetId);
        if (!registered || !poolMinted || underlying != token || scale == 0) revert BadConfig();
        TOKEN = token;
        MERKLE_ROOT = root;
        GUARDIAN = guardian;
        CLAIM_DEADLINE = claimDeadline;
        POOL = pool;
        ASSET_ID = assetId;
        UNIT_SCALE = scale;
    }

    // ────────────────────────────── claims ──────────────────────────────

    /// Anyone may submit a claim; the tokens always go to `account`.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        _consume(index, account, amount, proof);
        _send(account, amount);
    }

    /// The eligible account sends its own allocation to `to`.
    function claimTo(uint256 index, uint256 amount, bytes32[] calldata proof, address to) external {
        _consume(index, msg.sender, amount, proof);
        _send(to, amount);
    }

    /// The eligible account claims and deposits the whole amount into the confidential pool in one transaction. `commit` is the
    /// pool deposit commit the caller built from its own key (`keccak(Cx ‖ Cy ‖ owner)`), so the resulting note is recoverable
    /// from that key alone. The amount must be a multiple of `UNIT_SCALE`; otherwise this reverts and the leaf stays claimable
    /// through `claim` or `claimTo`. Any failure in the pool reverts the whole call, bit included.
    function claimAndShield(uint256 index, uint256 amount, bytes32[] calldata proof, bytes32 commit) external {
        if (commit == bytes32(0)) revert ZeroCommit();
        if (amount % UNIT_SCALE != 0) revert AmountNotAligned();
        _consume(index, msg.sender, amount, proof);
        IAirdropPool(POOL).wrap(ASSET_ID, amount, commit);
    }

    // ────────────────────────────── views ──────────────────────────────

    function isClaimed(uint256 index) external view returns (bool) {
        return _claimed[index >> 8] & (1 << (index & 0xff)) != 0;
    }

    /// True when `proof` shows `(index, account, amount)` is a leaf of the root. Says nothing about whether it was claimed.
    function verify(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external view returns (bool) {
        return MerkleProofLib.verifyCalldata(proof, MERKLE_ROOT, _leaf(index, account, amount));
    }

    // ────────────────────────────── guardian ──────────────────────────────

    /// Circuit breaker: blocks every claim path. Moves no funds and does not extend the deadline.
    function pause() external onlyGuardian {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyGuardian {
        paused = false;
        emit PausedSet(false);
    }

    /// Move `amount` of the airdrop token to `to`, at any time.
    function sweep(address to, uint256 amount) external onlyGuardian {
        if (to == address(0)) revert BadRecipient();
        SafeTransferLib.safeTransfer(TOKEN, to, amount);
        emit Swept(to, amount);
    }

    /// Move any other token, or native ETH when `token` is the zero address, to `to`.
    function sweepToken(address token, address to, uint256 amount) external onlyGuardian {
        if (to == address(0)) revert BadRecipient();
        if (token == address(0)) SafeTransferLib.safeTransferETH(to, amount);
        else SafeTransferLib.safeTransfer(token, to, amount);
        emit TokenSwept(token, to, amount);
    }

    // ────────────────────────────── internals ──────────────────────────────

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    /// Checks the claim and sets its bit. Every caller moves the tokens afterwards, so a failed transfer reverts the bit too.
    function _consume(uint256 index, address account, uint256 amount, bytes32[] calldata proof) internal {
        if (paused) revert Paused();
        if (block.timestamp > CLAIM_DEADLINE) revert ClaimWindowClosed();
        uint256 word = _claimed[index >> 8];
        uint256 mask = 1 << (index & 0xff);
        if (word & mask != 0) revert AlreadyClaimed();
        if (!MerkleProofLib.verifyCalldata(proof, MERKLE_ROOT, _leaf(index, account, amount))) revert BadProof();
        _claimed[index >> 8] = word | mask;
        emit Claimed(index, account, amount);
    }

    /// Never sends to the zero address, this contract, the token or the pool (none of which can return the funds).
    function _send(address to, uint256 amount) internal {
        if (to == address(0) || to == address(this) || to == TOKEN || to == POOL) revert BadRecipient();
        SafeTransferLib.safeTransfer(TOKEN, to, amount);
    }
}
