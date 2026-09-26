// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {LibClone} from "solady/utils/LibClone.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IPermit2, IERC2612, IERC20Allowance} from "./ConfidentialRouter.sol";

interface ITacitEvmPool {
    function ASSET() external view returns (address);
    function transact(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[11] calldata publicInputs,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes calldata memo0,
        bytes calldata memo1
    ) external payable;
}

/// The two ConfidentialPool calls a wrap box needs.
interface IConfidentialPoolWrap {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

/// @title TacitEvmPoolRouter
/// @notice Periphery for one TacitEvmPool, and its bridge to and from the confidential pool (V1):
///
///   1. DEPOSIT (depositWith*) — a signature approval (EIP-2612 / Permit2) instead of a separate approve tx.
///   2. ZAPS (zap*) — swap ETH or any token into the pool's asset through the pinned aggregator (zRouter) and
///      deposit it in the same transaction.
///   3. DEPOSIT BOXES (depositBoxOf / completeDeposit / reclaimDeposit) — a counterfactual address per deposit
///      intent. Anything can pay it: a V1 withdrawal, a V1 exit recipe's sweep, an exchange, a bridge. Later,
///      anyone completes the deposit with a proof built against the pool's root at that moment. A pool deposit
///      proof goes stale as soon as another transaction lands, so a source that settles minutes later (a V1
///      batch) cannot carry one; the box decouples the two. The intent fixes the amount, both output leaves
///      and both memos, so the completer can only deliver exactly the notes the owner chose. The completer is
///      paid the pool's relayer fee, which the leaves fix at amount − Σ output values.
///   4. WRAP BOXES (wrapBoxOf / completeWrap / reclaimWrap) — the same for a V1 note: any source pays the box,
///      anyone completes `wrap(assetId, amount, commit)` into the confidential pool and is paid `tip`.
///   5. POOL → V1 (withdrawToV1) — withdraw from this pool straight into a wrap box and complete it, one tx.
///
/// Leaving this pool for anything else needs nothing here: a withdrawal whose recipient is a ConfidentialRouter
/// exit-recipe escrow is run by that router's permissionless `activateExit`.
///
/// Trust model, as ConfidentialRouter: tokens pass through only within a call and each named leg is swept
/// back to the caller; any stray balance is swept by the next caller, so never leave value resting here. The
/// pool, zRouter, Permit2 and V1 pool are immutable. A box holds only the funds paid to it and releases them
/// only to its intent's destination (the pool deposit / V1 wrap) or, after its deadline, to its `refund`. A
/// tampered intent maps to a different, empty box. nonReentrant on every entrypoint.
contract TacitEvmPoolRouter is ReentrancyGuardTransient {
    ITacitEvmPool public immutable POOL;
    address public immutable ASSET; // the pool's asset, address(0) = native ETH
    address public immutable ZROUTER; // optional (address(0) disables zaps)
    IPermit2 public immutable PERMIT2; // optional (address(0) disables Permit2 flows)
    IConfidentialPoolWrap public immutable V1; // optional (address(0) disables wrap boxes)
    address public immutable boxImpl;

    bytes32 internal constant DEPOSIT_TAG = keccak256("tacit-evm-pool-deposit-box-v1");
    bytes32 internal constant WRAP_TAG = keccak256("tacit-evm-pool-wrap-box-v1");

    /// A proof-carrying pool transaction, passed through verbatim.
    struct Tx {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[11] publicInputs;
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
    }

    /// A pool deposit a box completes. The leaves fix the notes and their values; the fee to the completer is
    /// whatever `amount` exceeds their sum.
    struct DepositIntent {
        uint256 amount;
        uint256 outLeaf0;
        uint256 outLeaf1;
        bytes32 memo0Hash;
        bytes32 memo1Hash;
        address refund;
        uint64 deadline; // reclaim opens after this; completion stays open while the box holds `amount`
        uint256 nonce;
    }

    /// A V1 wrap a box completes: `wrap(assetId, amount, commit)` on V1, `tip` of the same token to the completer.
    struct WrapIntent {
        bytes32 assetId;
        uint256 amount;
        uint256 tip;
        bytes32 commit;
        address refund;
        uint64 deadline;
        uint256 nonce;
    }

    error BadTarget();
    error BadIntent();
    error BadPermit2();
    error AmountTooLarge();
    error ShortSwapOutput();
    error ZRouterCallFailed();
    error NotExpired();
    error NothingToReclaim();

    event DepositBoxCompleted(address indexed box, address indexed completer);
    event WrapBoxCompleted(address indexed box, address indexed completer);
    event BoxReclaimed(address indexed box, address indexed refund, uint256 amount);

    constructor(address pool_, address zRouter_, address permit2_, address v1_) {
        if (pool_ == address(0) || pool_.code.length == 0) revert BadTarget();
        if (zRouter_ != address(0) && zRouter_.code.length == 0) revert BadTarget();
        if (permit2_ != address(0) && permit2_.code.length == 0) revert BadTarget();
        if (v1_ != address(0) && v1_.code.length == 0) revert BadTarget();
        POOL = ITacitEvmPool(pool_);
        ASSET = ITacitEvmPool(pool_).ASSET();
        ZROUTER = zRouter_;
        PERMIT2 = IPermit2(permit2_);
        V1 = IConfidentialPoolWrap(v1_);
        boxImpl = address(new TacitBox());
    }

    /// ETH arrives from boxes being released and from token→ETH zap swaps.
    receive() external payable {}

    // ──────────────────── 1. Deposits with a signature approval ────────────────────

    function depositWithPermit(Tx calldata t, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        uint256 amount = _depositAmount(t);
        if (ASSET == address(0)) revert BadTarget();
        try IERC2612(ASSET).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        SafeTransferLib.safeTransferFrom(ASSET, msg.sender, address(this), amount);
        _deposit(t, amount);
    }

    function depositWithPermit2(Tx calldata t, IPermit2.PermitSingle calldata permitSingle, bytes calldata signature)
        external
        nonReentrant
    {
        uint256 amount = _depositAmount(t);
        if (ASSET == address(0)) revert BadTarget();
        _pullPermit2(ASSET, amount, permitSingle, signature);
        _deposit(t, amount);
    }

    // ──────────────────── 2. Zaps ────────────────────

    /// ETH → the pool's ERC-20 through zRouter (output to this router), then deposit exactly `t.extAmount`.
    /// Surplus output and unspent ETH go back to the caller.
    function zapETHToDeposit(Tx calldata t, bytes calldata zrSwapData) external payable nonReentrant {
        uint256 amount = _depositAmount(t);
        if (ASSET == address(0)) revert BadTarget();
        if (_zRouterReceive(ASSET, msg.value, zrSwapData) < amount) revert ShortSwapOutput();
        _deposit(t, amount);
        _refund(ASSET, msg.sender);
        _refundETH(msg.sender);
    }

    /// Any ERC-20 (via Permit2) → the pool's asset (ERC-20 or ETH) through zRouter, then deposit exactly
    /// `t.extAmount`. Unspent input and surplus output go back to the caller.
    function zapTokenToDepositWithPermit2(
        Tx calldata t,
        uint256 amountIn,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) external nonReentrant {
        uint256 amount = _depositAmount(t);
        address tokenIn = permitSingle.details.token;
        if (tokenIn == ASSET) revert BadTarget();
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        _lazyApprove(tokenIn, ZROUTER, amountIn);
        if (_zRouterReceive(ASSET, 0, zrSwapData) < amount) revert ShortSwapOutput();
        _deposit(t, amount);
        _refund(tokenIn, msg.sender);
        if (ASSET == address(0)) _refundETH(msg.sender);
        else _refund(ASSET, msg.sender);
    }

    // ──────────────────── 3. Deposit boxes ────────────────────

    function depositBoxOf(DepositIntent calldata intent) public view returns (address) {
        return LibClone.predictDeterministicAddress_PUSH0(boxImpl, _depositSalt(intent), address(this));
    }

    /// Permissionless. `t` must be a deposit of exactly `intent.amount` producing the intent's leaves and memos;
    /// the completer names `t.relayer` (normally itself) to collect the fee.
    function completeDeposit(DepositIntent calldata intent, Tx calldata t) external nonReentrant {
        if (t.extAmount != _int(intent.amount) || t.recipient != address(0)) revert BadIntent();
        if (t.publicInputs[9] != intent.outLeaf0 || t.publicInputs[10] != intent.outLeaf1) revert BadIntent();
        if (keccak256(t.memo0) != intent.memo0Hash || keccak256(t.memo1) != intent.memo1Hash) revert BadIntent();
        address box = _deployBox(_depositSalt(intent));
        TacitBox(payable(box)).release(ASSET, address(this), intent.amount);
        _deposit(t, intent.amount);
        emit DepositBoxCompleted(box, msg.sender);
    }

    /// Permissionless, after the deadline: the box's whole balance of the pool asset goes to `intent.refund`.
    function reclaimDeposit(DepositIntent calldata intent) external nonReentrant {
        _reclaim(_depositSalt(intent), ASSET, intent.refund, intent.deadline);
    }

    // ──────────────────── 4. Wrap boxes (into a V1 note) ────────────────────

    function wrapBoxOf(WrapIntent calldata intent) public view returns (address) {
        return LibClone.predictDeterministicAddress_PUSH0(boxImpl, _wrapSalt(intent), address(this));
    }

    /// Permissionless: wraps `intent.amount` to `intent.commit` on V1 and pays `intent.tip` to the caller.
    function completeWrap(WrapIntent calldata intent) external nonReentrant {
        _completeWrap(intent);
    }

    function reclaimWrap(WrapIntent calldata intent) external nonReentrant {
        (address token,) = _wrapToken(intent.assetId);
        _reclaim(_wrapSalt(intent), token, intent.refund, intent.deadline);
    }

    // ──────────────────── 5. Pool → V1 in one transaction ────────────────────

    /// Withdraw from the pool into `intent`'s wrap box (the proof binds the box as recipient, so the
    /// destination cannot be changed) and complete the wrap. The pool's relayer fee goes to `t.relayer`; the
    /// wrap tip goes to the caller.
    function withdrawToV1(Tx calldata t, WrapIntent calldata intent) external nonReentrant {
        if (t.extAmount >= 0 || t.recipient != wrapBoxOf(intent)) revert BadIntent();
        POOL.transact(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
        _completeWrap(intent);
    }

    // ──────────────────── internals ────────────────────

    function _depositAmount(Tx calldata t) internal pure returns (uint256) {
        if (t.extAmount <= 0) revert BadIntent();
        return uint256(t.extAmount);
    }

    /// Deposit `amount` held by this router. The pool pulls an ERC-20 from msg.sender (this router).
    function _deposit(Tx calldata t, uint256 amount) internal {
        if (ASSET == address(0)) {
            POOL.transact{value: amount}(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
        } else {
            _lazyApprove(ASSET, address(POOL), amount);
            POOL.transact(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
        }
    }

    function _completeWrap(WrapIntent calldata intent) internal {
        if (address(V1) == address(0)) revert BadTarget();
        (address token, bool poolMinted) = _wrapToken(intent.assetId);
        address box = _deployBox(_wrapSalt(intent));
        TacitBox(payable(box)).release(token, address(this), intent.amount + intent.tip);
        if (token == address(0)) {
            V1.wrap{value: intent.amount}(intent.assetId, intent.amount, intent.commit);
        } else {
            // A pool-minted canonical token is burned from the caller; an external token is pulled.
            if (!poolMinted) _lazyApprove(token, address(V1), intent.amount);
            V1.wrap(intent.assetId, intent.amount, intent.commit);
        }
        _deliver(token, msg.sender, intent.tip);
        emit WrapBoxCompleted(box, msg.sender);
    }

    function _wrapToken(bytes32 assetId) internal view returns (address token, bool poolMinted) {
        if (address(V1) == address(0)) revert BadTarget();
        bool registered;
        (registered, token,,, poolMinted,) = V1.assets(assetId);
        if (!registered) revert BadTarget();
    }

    function _reclaim(bytes32 salt, address token, address refund, uint64 deadline) internal {
        if (block.timestamp <= deadline) revert NotExpired();
        if (refund == address(0)) revert BadIntent();
        address box = _deployBox(salt);
        uint256 bal = token == address(0) ? box.balance : SafeTransferLib.balanceOf(token, box);
        if (bal == 0) revert NothingToReclaim();
        TacitBox(payable(box)).release(token, refund, bal);
        emit BoxReclaimed(box, refund, bal);
    }

    function _depositSalt(DepositIntent calldata intent) internal pure returns (bytes32) {
        return keccak256(abi.encode(DEPOSIT_TAG, intent));
    }

    function _wrapSalt(WrapIntent calldata intent) internal pure returns (bytes32) {
        return keccak256(abi.encode(WRAP_TAG, intent));
    }

    function _deployBox(bytes32 salt) internal returns (address box) {
        box = LibClone.predictDeterministicAddress_PUSH0(boxImpl, salt, address(this));
        if (box.code.length == 0) LibClone.cloneDeterministic_PUSH0(boxImpl, salt);
    }

    function _pullPermit2(address token, uint256 amount, IPermit2.PermitSingle calldata permitSingle, bytes calldata signature)
        internal
    {
        if (address(PERMIT2) == address(0)) revert BadTarget();
        if (amount > type(uint160).max) revert AmountTooLarge();
        if (
            permitSingle.details.token != token || permitSingle.spender != address(this)
                || permitSingle.details.amount < amount || permitSingle.sigDeadline < block.timestamp
        ) revert BadPermit2();
        try PERMIT2.permit(msg.sender, permitSingle, signature) {} catch {}
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), token);
    }

    /// Call zRouter with the caller's swap calldata and return what it delivered here in `token`
    /// (address(0) = ETH, measured net of the `value` sent).
    function _zRouterReceive(address token, uint256 value, bytes calldata zrSwapData) internal returns (uint256) {
        if (ZROUTER == address(0)) revert BadTarget();
        uint256 before = token == address(0) ? address(this).balance - value : SafeTransferLib.balanceOf(token, address(this));
        (bool ok, bytes memory ret) = ZROUTER.call{value: value}(zrSwapData);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
        uint256 after_ = token == address(0) ? address(this).balance : SafeTransferLib.balanceOf(token, address(this));
        return after_ - before;
    }

    function _lazyApprove(address token, address spender, uint256 amount) internal {
        if (IERC20Allowance(token).allowance(address(this), spender) < amount) {
            SafeTransferLib.safeApproveWithRetry(token, spender, type(uint256).max);
        }
    }

    function _deliver(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) SafeTransferLib.forceSafeTransferETH(to, amount);
        else SafeTransferLib.safeTransfer(token, to, amount);
    }

    function _refund(address token, address to) internal {
        uint256 bal = SafeTransferLib.balanceOf(token, address(this));
        if (bal != 0) SafeTransferLib.safeTransfer(token, to, bal);
    }

    function _refundETH(address to) internal {
        uint256 bal = address(this).balance;
        if (bal != 0) SafeTransferLib.forceSafeTransferETH(to, bal);
    }

    function _int(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert AmountTooLarge();
        return int256(x);
    }
}

/// A counterfactual box: a PUSH0 minimal-proxy clone at an intent-bound address. It accepts any payment
/// before or after deployment and releases only on its router's instruction.
contract TacitBox {
    address private immutable ROUTER;

    error NotRouter();

    constructor() {
        ROUTER = msg.sender;
    }

    function release(address token, address to, uint256 amount) external {
        if (msg.sender != ROUTER) revert NotRouter();
        if (token == address(0)) SafeTransferLib.forceSafeTransferETH(to, amount);
        else SafeTransferLib.safeTransfer(token, to, amount);
    }

    receive() external payable {}
}
