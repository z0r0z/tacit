// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice The narrow CollateralEngine surface this helper drives. `WSTETH`/`POOL` are read once at
///         construction (both are set-once-immutable-in-practice on the engine), so this helper needs no
///         constructor args of its own beyond the engine address — nothing to mismatch.
interface ICollateralEngineEscrow {
    function WSTETH() external view returns (address);
    function POOL() external view returns (address);
    function escrowOf(bytes32 outpoint, address funder) external view returns (uint256);
    function postEscrow(bytes32 outpoint, uint256 amount) external;
    function claimEscrow(bytes32 outpoint) external;
}

/// @notice Lido's wrapped staked ETH. `permit` is EIP-2612 (confirmed against the live mainnet deploy —
///         it exposes `DOMAIN_SEPARATOR`/`nonces` and accepts a standard permit signature). Sending it ETH
///         directly (empty calldata) hits its `receive()`, which stakes into stETH and mints wstETH — the
///         one-call ETH->wstETH path, no separate `submit`+`wrap`, no approval, verified live on a mainnet
///         fork (see test/CbtcEscrowHelper.t.sol).
interface IWstEth {
    function balanceOf(address) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface IConfidentialPoolSettle {
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
}

/// @title CbtcEscrowHelper
/// @notice Convenience wrapper collapsing CollateralEngine's cBTC wstETH escrow onto one transaction. The
///         engine's `postEscrow` is a plain `transferFrom` — no permit support — so funding an escrow today
///         needs a standing `approve()` first; this contract absorbs that friction (permit-in-one-tx, or
///         raw-ETH-in one tx) behind a single call, and separately collapses "mint cBTC + open a cUSD CDP
///         against it" into one Ethereum transaction when the caller already holds a proof for that batch.
///
///         Funder-of-record problem. CollateralEngine keys `escrowOf[outpoint][msg.sender]` by whoever called
///         `postEscrow`, and `claimEscrow` refunds `msg.sender` at CLAIM time. If this contract calls
///         `postEscrow` on a depositor's behalf, THIS CONTRACT becomes the engine's funder-of-record — only
///         it, not the original depositor, can ever call the engine's `claimEscrow`. This helper solves that
///         itself: `helperEscrowOf[outpoint][depositor]` tracks each depositor's own share of what THIS
///         contract has posted, and `reclaimEscrow` pulls the engine-held pot back to this contract (once, for
///         the whole outpoint — the engine has no per-depositor entry to give back partially) then forwards
///         exactly the caller's own tracked share, so multiple depositors funding the same outpoint through
///         this helper can each reclaim independently, in any order, once the engine will release it.
///
///         Solvency invariant: for every outpoint, `engine.escrowOf(outpoint, address(this))` plus this
///         contract's own wstETH balance already pulled back for that outpoint always equals the sum of
///         every not-yet-reclaimed `helperEscrowOf[outpoint][*]`. Posting only ever raises both sides by the
///         same amount (`_postToEngine`); reclaiming only ever pulls the engine's WHOLE remaining pot for an
///         outpoint the first time any depositor calls (subsequent callers for the same outpoint find the
///         engine side already drained and just take their share of this contract's balance). No cross-
///         outpoint mixing risk: each outpoint's engine-side entry is independent and this contract never
///         pulls for one outpoint to pay another.
///
///         Immutable, no proxy, no owner — matches this repo's peripheral-contract convention. Bound to
///         exactly one CollateralEngine (and, transitively, the ConfidentialPool wired to it at the time this
///         contract is deployed) for its whole lifetime.
contract CbtcEscrowHelper is ReentrancyGuard {
    ICollateralEngineEscrow public immutable COLLATERAL_ENGINE;
    IWstEth public immutable WSTETH;
    IConfidentialPoolSettle public immutable POOL;

    // outpoint => depositor => this depositor's own share of what this contract posted to the engine and has
    // not yet reclaimed.
    mapping(bytes32 => mapping(address => uint256)) public helperEscrowOf;

    event HelperEscrowPosted(bytes32 indexed outpoint, address indexed depositor, uint256 amount);
    event HelperEscrowStaked(bytes32 indexed outpoint, address indexed depositor, uint256 ethIn, uint256 wstEthOut);
    event HelperEscrowReclaimed(bytes32 indexed outpoint, address indexed depositor, uint256 amount);

    // Ordered by identifier length, then alphabetically (matches CollateralEngine's convention).
    error BadAmount();
    error BadParams();
    error StakeFailed();
    error NothingToRelease();

    constructor(address collateralEngine) {
        if (collateralEngine == address(0) || collateralEngine.code.length == 0) revert BadParams();
        COLLATERAL_ENGINE = ICollateralEngineEscrow(collateralEngine);
        address wstEth = COLLATERAL_ENGINE.WSTETH();
        address pool = COLLATERAL_ENGINE.POOL();
        if (wstEth == address(0) || wstEth.code.length == 0) revert BadParams();
        if (pool == address(0) || pool.code.length == 0) revert BadParams();
        WSTETH = IWstEth(wstEth);
        POOL = IConfidentialPoolSettle(pool);
    }

    /// @notice Post (or top up) escrow for `outpoint` in one transaction using an EIP-2612 permit instead of a
    ///         standing `approve()`. Credits the ORIGINAL caller (`msg.sender`), never this contract, in
    ///         `helperEscrowOf`. `permit` is best-effort (try/catch, mirroring ConfidentialRouter's
    ///         `_pull2612`): the following `safeTransferFrom` is what actually enforces the allowance, so a
    ///         permit already consumed by a front-run of the SAME signature does not grief this call.
    function postEscrowWithPermit(bytes32 outpoint, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        if (outpoint == bytes32(0) || amount == 0) revert BadAmount();
        try WSTETH.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        SafeTransferLib.safeTransferFrom(address(WSTETH), msg.sender, address(this), amount);
        _postToEngine(outpoint, msg.sender, amount);
    }

    /// @notice Post (or top up) escrow for `outpoint` funded directly with ETH: stakes `msg.value` into wstETH
    ///         (Lido's `stETH.submit` + share-mint via wstETH's `receive()`, one call, no approval) and posts
    ///         the EXACT resulting wstETH — measured by this contract's own balance before/after, never
    ///         estimated from `msg.value` at the current mark, since stETH:wstETH is a rebasing:non-rebasing
    ///         exchange rate that only ever grows. wstETH's `receive()` is all-or-nothing (it either mints a
    ///         real, nonzero wstETH amount from the whole `msg.value` or the call fails) — there is no partial
    ///         stake and so no ETH dust to refund; the only failure mode (an amount too small for the current
    ///         exchange rate to round to at least 1 share) reverts the WHOLE transaction, which unwinds the
    ///         stake along with it, so no ETH is ever lost to a zero-share stake.
    function postEscrowWithETH(bytes32 outpoint) external payable nonReentrant {
        if (outpoint == bytes32(0) || msg.value == 0) revert BadAmount();
        uint256 got = _stake();
        emit HelperEscrowStaked(outpoint, msg.sender, msg.value, got);
        _postToEngine(outpoint, msg.sender, got);
    }

    /// @notice One-transaction "mint cBTC + open a cUSD CDP against it": stakes `msg.value` into wstETH, posts
    ///         the resulting escrow for `outpoint` (so CollateralEngine's `escrowSufficient` reads true when
    ///         the pool checks it below — escrow accounting is a plain synchronous storage write, not
    ///         something that needs its own block to finalize), then settles the caller's own
    ///         already-proven `[OP_CBTC_MINT, OP_CDP_MINT]` batch in the SAME transaction.
    ///
    ///         Requires the batch's cBTC lock (`outpoint`) to already be reflection-recorded on the pool
    ///         (`cbtcLockVBtc`/`cbtcLockCommitment` set by a prior Bitcoin-side reflection) — this helper only
    ///         supplies the wstETH side, exactly like a standalone `postEscrow` + `settle` would.
    ///
    ///         IMPORTANT — self-prove batches only. `ConfidentialPool.settle` pays any settler fee (`pv.fees`)
    ///         or public withdrawal in the proof to `msg.sender`, which from the pool's perspective is THIS
    ///         CONTRACT when called from here, not the depositor. A cBTC mint and a CDP mint are both silent
    ///         confidential note insertions (no public payout), so a batch containing ONLY those two ops moves
    ///         no public value through this contract and this is a non-issue. This function does not decode
    ///         `publicValues` to enforce that shape (replicating the pool's full ABI layout here would be
    ///         fragile against an unrelated future field), so it is a hard CALLER-SIDE constraint: never build
    ///         a batch for this entrypoint that also carries a fee or a public withdrawal, or that value is
    ///         paid to this contract, not you. As a narrow safety net for the one payout form that could
    ///         plausibly still land here (a native-ETH withdrawal), any ETH this contract is holding after
    ///         `settle` returns is swept back to the caller in the same atomic transaction, before anyone else
    ///         could possibly observe or front-run it.
    function postEscrowWithETHAndSettle(
        bytes32 outpoint,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        if (outpoint == bytes32(0) || msg.value == 0) revert BadAmount();
        uint256 got = _stake();
        emit HelperEscrowStaked(outpoint, msg.sender, msg.value, got);
        _postToEngine(outpoint, msg.sender, got);
        POOL.settle(publicValues, proof, memos);
        // Safety net documented above: sweep back any stray native ETH a same-batch withdrawal paid to this
        // contract instead of the caller. No-op (and cheap) in the intended fee-free / withdrawal-free batch.
        uint256 stray = address(this).balance;
        if (stray != 0) SafeTransferLib.safeTransferETH(msg.sender, stray);
    }

    /// @notice Trustlessly reclaim your OWN tracked share of this contract's escrow for `outpoint`, once
    ///         CollateralEngine will release it (reflection-proven honest redeem, or no cBTC ever minted
    ///         against the lock) — permissionless, no owner, refund always goes to the caller's own tracked
    ///         share. Pulls the engine's whole remaining pot for this outpoint back to this contract only the
    ///         FIRST time any depositor reclaims (later callers for the same outpoint find it already here);
    ///         the engine's own `claimEscrow` reverts (`EscrowLocked`) if the lock genuinely isn't releasable
    ///         yet, which propagates here unchanged — this contract adds no new release condition.
    function reclaimEscrow(bytes32 outpoint) external nonReentrant {
        uint256 share = helperEscrowOf[outpoint][msg.sender];
        if (share == 0) revert NothingToRelease();
        if (COLLATERAL_ENGINE.escrowOf(outpoint, address(this)) != 0) {
            COLLATERAL_ENGINE.claimEscrow(outpoint);
        }
        helperEscrowOf[outpoint][msg.sender] = 0;
        SafeTransferLib.safeTransfer(address(WSTETH), msg.sender, share);
        emit HelperEscrowReclaimed(outpoint, msg.sender, share);
    }

    /// @dev Stake `msg.value` into wstETH via its `receive()` and return the EXACT wstETH minted, read from
    ///      this contract's own balance delta (never estimated from a read exchange rate, which could move
    ///      between the read and the stake).
    function _stake() internal returns (uint256 got) {
        uint256 before = WSTETH.balanceOf(address(this));
        (bool ok,) = address(WSTETH).call{value: msg.value}("");
        if (!ok) revert StakeFailed();
        got = WSTETH.balanceOf(address(this)) - before;
        if (got == 0) revert BadAmount(); // reverts the whole tx, unwinding the stake — no ETH is lost
    }

    /// @dev Credit `depositor`'s own share, then forward `amount` of this contract's wstETH into the engine's
    ///      escrow for `outpoint`. Approves exactly `amount` (consumed in full by the engine's `transferFrom`
    ///      in the same call), never a standing allowance.
    function _postToEngine(bytes32 outpoint, address depositor, uint256 amount) internal {
        helperEscrowOf[outpoint][depositor] += amount;
        SafeTransferLib.safeApprove(address(WSTETH), address(COLLATERAL_ENGINE), amount);
        COLLATERAL_ENGINE.postEscrow(outpoint, amount);
        emit HelperEscrowPosted(outpoint, depositor, amount);
    }

    /// @notice Let this contract receive a native-ETH withdrawal mid-`settle` (see `postEscrowWithETHAndSettle`);
    ///         rejects a bare direct send (no legitimate flow sends this contract ETH outside its own calls).
    receive() external payable {
        if (msg.sender != address(POOL)) revert BadAmount();
    }
}
