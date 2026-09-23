// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20BalanceOf {
    function balanceOf(address) external view returns (uint256);
}

/// @title PointsDistributor — a cumulative merkle distributor for the ETH-wrap points program
/// @notice Each root commits to a snapshot of `(account, cumulativeAmount)` leaves: the TOTAL TAC an account has
///         ever earned to date, not a per-epoch delta. A claim pays `cumulativeAmount - claimed[account]` and
///         records the new total, so a later root that raises an account's amount is claimable for just the
///         difference, and re-claiming against a root already claimed pays zero rather than reverting.
///
///         ROOT_SETTER (a hot wallet run by the points indexer) publishes a new root roughly once a day. It
///         cannot invent tokens: `updateRoot` bounds its DECLARED `totalAllocated` to what this contract
///         currently holds plus everything already paid out, and every claim is separately bounded against that
///         same `totalAllocated` regardless of what an individual leaf claims — `updateRoot` never checks that a
///         tree's leaves actually sum to the total it declares, so without that second, per-claim bound a single
///         oversized leaf could sit dormant under an honestly-funded root and drain every future top-up the
///         moment it lands, not just what was funded when that root was published. With both bounds in place,
///         the worst a compromised or buggy setter key can do in one root is redirect whatever is CURRENTLY
///         funded — not the program's full budget, and not anything funded after the fact. Fund it incrementally
///         to keep that bound small; there is no separate `fund()` — funding is a plain TOKEN transfer to this
///         address, exactly like TacAirdrop.
///
///         GUARDIAN (the ops multisig) can pause claims and root updates, sweep the token back at any time, and
///         rotate ROOT_SETTER if its key is ever suspected compromised. It cannot claim on anyone's behalf and
///         cannot lower an account's already-recorded cumulative total.
///
///         Leaf: `keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))))` — same double-hash
///         convention as TacAirdrop.sol, keyed by address alone: a cumulative distributor's root moves over time,
///         so there is no fixed index set to bitmask claims against.
contract PointsDistributor {
    address public immutable TOKEN;
    address public immutable GUARDIAN;
    /// After this, ROOT_SETTER can no longer publish a new root — bounds how long a hot key can allocate funds
    /// even if the guardian never notices a compromise. Claims stay open indefinitely past it.
    uint64 public immutable ROOT_UPDATE_DEADLINE;

    address public rootSetter;
    bytes32 public root;
    /// Sum of every leaf's cumulativeAmount in the current tree. Bounds `updateRoot` to what is actually funded;
    /// says nothing about who holds what share — the tree carries that.
    uint256 public totalAllocated;
    /// Sum ever paid out across every claim, tracked separately so `updateRoot`'s funded check
    /// (`balanceOf + totalClaimed`) still reflects true lifetime funding after tokens have left via claims.
    uint256 public totalClaimed;

    bool public paused;

    mapping(address => uint256) public claimed;

    error Paused();
    error NotGuardian();
    error NotRootSetter();
    error BadConfig();
    error BadRecipient();
    error BadProof();
    error NothingOwed();
    error RootUpdatesClosed();
    error OverFunded();
    error TotalDecreased();
    error OverAllocated();

    event Claimed(address indexed account, uint256 amount, uint256 cumulativeAmount);
    event RootUpdated(bytes32 root, uint256 totalAllocated);
    event RootSetterUpdated(address indexed rootSetter);
    event Swept(address indexed to, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event PausedSet(bool paused);

    modifier onlyGuardian() {
        if (msg.sender != GUARDIAN) revert NotGuardian();
        _;
    }

    modifier onlyRootSetter() {
        if (msg.sender != rootSetter) revert NotRootSetter();
        _;
    }

    constructor(address token, address guardian, address rootSetter_, uint64 rootUpdateDeadline) {
        if (token == address(0) || guardian == address(0) || rootSetter_ == address(0)) revert BadConfig();
        if (guardian.code.length == 0 || token.code.length == 0) revert BadConfig();
        if (rootUpdateDeadline <= block.timestamp || rootUpdateDeadline > block.timestamp + 400 days) revert BadConfig();
        TOKEN = token;
        GUARDIAN = guardian;
        rootSetter = rootSetter_;
        ROOT_UPDATE_DEADLINE = rootUpdateDeadline;
    }

    // ────────────────────────────── claims ──────────────────────────────

    /// The eligible account claims its own accrued amount.
    function claim(uint256 cumulativeAmount, bytes32[] calldata proof) external {
        uint256 amount = _consume(msg.sender, cumulativeAmount, proof);
        SafeTransferLib.safeTransfer(TOKEN, msg.sender, amount);
    }

    /// The eligible account sends its own accrued amount to `to`.
    function claimTo(uint256 cumulativeAmount, bytes32[] calldata proof, address to) external {
        if (to == address(0) || to == address(this) || to == TOKEN) revert BadRecipient();
        uint256 amount = _consume(msg.sender, cumulativeAmount, proof);
        SafeTransferLib.safeTransfer(TOKEN, to, amount);
    }

    // ────────────────────────────── views ──────────────────────────────

    /// What `account` could claim right now against `(account, cumulativeAmount)`, without checking the proof.
    function owed(address account, uint256 cumulativeAmount) external view returns (uint256) {
        uint256 already = claimed[account];
        return cumulativeAmount > already ? cumulativeAmount - already : 0;
    }

    /// True when `(account, cumulativeAmount)` is a leaf of the current root. Says nothing about what remains
    /// unclaimed of it.
    function verify(address account, uint256 cumulativeAmount, bytes32[] calldata proof) external view returns (bool) {
        return MerkleProofLib.verifyCalldata(proof, root, _leaf(account, cumulativeAmount));
    }

    // ────────────────────────────── root setter ──────────────────────────────

    /// `newTotalAllocated` must be the sum of every leaf in the new tree — this contract cannot check that
    /// itself, only that it is (a) not less than the last committed total (an honest re-settlement only ever
    /// adds newly earned points, never erases them) and (b) fully covered by what this contract currently holds
    /// plus what has already been paid out, so no root can promise more than is actually funded.
    function updateRoot(bytes32 newRoot, uint256 newTotalAllocated) external onlyRootSetter {
        if (paused) revert Paused();
        if (newRoot == bytes32(0)) revert BadConfig();
        if (block.timestamp > ROOT_UPDATE_DEADLINE) revert RootUpdatesClosed();
        if (newTotalAllocated < totalAllocated) revert TotalDecreased();
        uint256 funded = IERC20BalanceOf(TOKEN).balanceOf(address(this)) + totalClaimed;
        if (newTotalAllocated > funded) revert OverFunded();
        root = newRoot;
        totalAllocated = newTotalAllocated;
        emit RootUpdated(newRoot, newTotalAllocated);
    }

    // ────────────────────────────── guardian ──────────────────────────────

    /// Circuit breaker: blocks claims AND root updates. Moves no funds.
    function pause() external onlyGuardian {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyGuardian {
        paused = false;
        emit PausedSet(false);
    }

    /// Rotate the hot indexer key without redeploying anything — the guardian's answer to a suspected leak.
    function setRootSetter(address newRootSetter) external onlyGuardian {
        if (newRootSetter == address(0)) revert BadConfig();
        rootSetter = newRootSetter;
        emit RootSetterUpdated(newRootSetter);
    }

    /// Move `amount` of the distributed token to `to`, at any time.
    function sweep(address to, uint256 amount) external onlyGuardian {
        if (to == address(0) || to == address(this) || to == TOKEN) revert BadRecipient();
        SafeTransferLib.safeTransfer(TOKEN, to, amount);
        emit Swept(to, amount);
    }

    /// Move any other token, or native ETH when `token` is the zero address, to `to`.
    function sweepToken(address token, address to, uint256 amount) external onlyGuardian {
        if (to == address(0) || to == address(this) || to == token) revert BadRecipient();
        if (token == address(0)) SafeTransferLib.safeTransferETH(to, amount);
        else SafeTransferLib.safeTransfer(token, to, amount);
        emit TokenSwept(token, to, amount);
    }

    // ────────────────────────────── internals ──────────────────────────────

    function _leaf(address account, uint256 cumulativeAmount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
    }

    function _consume(address account, uint256 cumulativeAmount, bytes32[] calldata proof) internal returns (uint256 amount) {
        if (paused) revert Paused();
        if (!MerkleProofLib.verifyCalldata(proof, root, _leaf(account, cumulativeAmount))) revert BadProof();
        uint256 already = claimed[account];
        if (cumulativeAmount <= already) revert NothingOwed();
        amount = cumulativeAmount - already;
        // Bounds any single leaf to what THIS root's declared total actually covers, regardless of how large
        // that leaf's own cumulativeAmount claims to be. Without this, a root whose declared totalAllocated
        // passed updateRoot's funded check honestly could still carry one wildly oversized leaf alongside it —
        // updateRoot never checks that leaves sum to the declared total, only that the declared total itself is
        // funded — and that leaf would otherwise be free to drain every future top-up the moment it lands, not
        // just what was funded when the bad root was published.
        if (totalClaimed + amount > totalAllocated) revert OverAllocated();
        claimed[account] = cumulativeAmount;
        totalClaimed += amount;
        emit Claimed(account, amount, cumulativeAmount);
    }
}
