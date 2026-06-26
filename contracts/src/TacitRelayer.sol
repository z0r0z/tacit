// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";

interface IConfidentialPool {
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
    function createPair(bytes32 assetA, bytes32 assetB, uint32 feeBps, uint8 rcptPrefix, bytes32 rcptX, uint32 protocolFeeBps) external returns (bytes32 poolId);
}

/// @title  TacitRelayer — a permissionless batching + fee-forwarding utility for the confidential pool.
/// @notice OPTIONAL. The default relayer is just an EOA calling `ConfidentialPool.settle()` directly — that
///         already covers every confidential op and earns the `FeePayment` (paid to `msg.sender`). This
///         contract adds three things an EOA can't, and is open to ANYONE (you run the first relayer; the
///         market is permissionless):
///           1. BATCHING — land many self-proved ops in one tx (amortize the base tx + calldata, one nonce).
///           2. ATOMIC PROFITABILITY — `minOut` reverts the whole batch unless the fees actually materialize,
///              so a relayer can NEVER land a batch that doesn't pay (gas-loss protection the EOA path lacks).
///           3. FEE ROUTING — forward the earned fees to recipient(s), optionally split for an affiliate.
///
///         It is **ownerless, immutable, and holds no funds between calls** — it cannot touch a user's value
///         (the fee is bound in each proof; this contract can't change it) and cannot rug a relayer (fees are
///         forwarded in the same tx). It is not required for coverage or privacy — only an efficiency layer.
///
///         INVARIANT — this relayer keeps NO per-account accounting and custodies nothing: all reserves and
///         escrow live in the pool. So its ENTIRE balance is treated as distributable relay fees — anything
///         that lands here (a proof's `FeePayment` leg, an undeclared leftover, a stray transfer) is forwarded
///         to the recipients of the NEXT `relaySettle` caller. Never route user value here except as a
///         proof-bound fee — a withdrawal addressed to this contract would be swept by the next caller. The
///         flip side is free rescue: a call with empty `calls` and the asset declared sweeps any stranded
///         balance to its recipients, so no value is ever permanently stuck.
contract TacitRelayer is ReentrancyGuardTransient {
    IConfidentialPool public immutable POOL;

    struct SettleCall {
        bytes publicValues;
        bytes proof;
        bytes[] memos;
    }

    /// @dev A pool to lazily found before the settles (an existing pair is harmlessly skipped), so a batch
    ///      can include the OP_LP_ADD that *founds* a confidential AMM pool, not only ops on existing ones.
    struct PairInit {
        bytes32 assetA;
        bytes32 assetB;
        uint32 feeBps;
    }

    event Relayed(address indexed relayer, address indexed to, uint256 submitted, uint256 landed);

    error BadArgs();
    error BelowMin(address asset, uint256 got, uint256 min);
    error PoolZero();

    constructor(address pool_) {
        if (pool_ == address(0) || pool_.code.length == 0) revert PoolZero();
        POOL = IConfidentialPool(pool_);
    }

    /// @notice Settle a batch of self-proved confidential ops and forward the earned relay fees, split by
    ///         basis points across `recipients` — so a relayer can natively share its fee with an AFFILIATE
    ///         (the wallet or front-end that routed the flow), a built-in distribution lever for integrators.
    ///         Single-recipient is just `recipients=[you], bps=[10000]`.
    /// @dev    Permissionless. The pool independently verifies each proof against PROGRAM_VKEY, so a malformed
    ///         or stale `calls[i]` just fails its own `settle` and is SKIPPED (try/catch) — one late proof
    ///         (lost the race, expired deadline) never wastes the batch, and this contract holds no trust.
    ///         After the settles, for each declared `feeAssets[i]` the contract takes its FULL balance (it
    ///         holds nothing between calls), reverts if that balance is below `minOut[i]` (an atomic
    ///         profitability guard — a revert rolls back the settles too, so an unprofitable batch consumes
    ///         nothing), then splits it `bps`-wise across `recipients` (the last recipient gets the remainder,
    ///         dust-safe). Declare EVERY asset your batch earns fees in; anything undeclared isn't burned —
    ///         it's claimable by the next caller that declares it.
    /// @param  calls       (publicValues, proof, memos) per op.
    /// @param  feeAssets   fee assets to forward (`address(0)` = native ETH); same length as `minOut`.
    /// @param  minOut      per-asset minimum that must materialize (`0` = no floor / disable the guard).
    /// @param  recipients  fee recipients (e.g. `[relayer, affiliate]`); non-empty, same length as `bps`.
    /// @param  bps         per-recipient split in basis points; MUST sum to 10000.
    /// @return landed      how many of the submitted ops settled on-chain.
    function relaySettle(
        SettleCall[] calldata calls,
        address[] calldata feeAssets,
        uint256[] calldata minOut,
        address[] calldata recipients,
        uint256[] calldata bps
    ) external nonReentrant returns (uint256 landed) {
        return _relay(calls, feeAssets, minOut, recipients, bps);
    }

    /// @notice Found-and-seed variant of `relaySettle`: lazily create each pool in `pairs` first, then run the
    ///         same batch. Lets a confidential OP_LP_ADD that FOUNDS a pool be relayed gaslessly with fee
    ///         routing — not only ops against pools that already exist. `createPair` is permissionless and
    ///         front-run-proof (an empty slot is harmless; the first OP_LP_ADD seeds the reserves), so each
    ///         create is wrapped in try/catch: an already-exists race or a bad-asset arg is swallowed, and a
    ///         pool that ends up uninitialized simply fails its own op's `settle` (fail-closed, skipped).
    /// @param  pairs the (assetA, assetB, feeBps) pools to ensure exist before settling; canonicalized pool-side.
    function relaySettle(
        PairInit[] calldata pairs,
        SettleCall[] calldata calls,
        address[] calldata feeAssets,
        uint256[] calldata minOut,
        address[] calldata recipients,
        uint256[] calldata bps
    ) external nonReentrant returns (uint256 landed) {
        for (uint256 i; i < pairs.length; ++i) {
            try POOL.createPair(pairs[i].assetA, pairs[i].assetB, pairs[i].feeBps, 0, bytes32(0), 0) {} catch {} // no-skim auto-create
        }
        return _relay(calls, feeAssets, minOut, recipients, bps);
    }

    /// @dev Shared body for both `relaySettle` overloads; the public entrypoints carry the `nonReentrant` guard.
    function _relay(
        SettleCall[] calldata calls,
        address[] calldata feeAssets,
        uint256[] calldata minOut,
        address[] calldata recipients,
        uint256[] calldata bps
    ) internal returns (uint256 landed) {
        if (feeAssets.length != minOut.length || recipients.length == 0 || recipients.length != bps.length) {
            revert BadArgs();
        }
        uint256 totalBps;
        for (uint256 j; j < bps.length; ++j) {
            if (recipients[j] == address(0)) revert BadArgs();
            totalBps += bps[j];
        }
        if (totalBps != 10000) revert BadArgs();

        uint256 len = calls.length;
        for (uint256 i; i < len; ++i) {
            try POOL.settle(calls[i].publicValues, calls[i].proof, calls[i].memos) {
                unchecked {
                    ++landed;
                }
            } catch {
                // skip a failed/late settle — its FeePayment simply never lands
            }
        }

        for (uint256 i; i < feeAssets.length; ++i) {
            address asset = feeAssets[i];
            uint256 bal =
                asset == address(0) ? address(this).balance : SafeTransferLib.balanceOf(asset, address(this));
            if (bal < minOut[i]) revert BelowMin(asset, bal, minOut[i]);
            if (bal == 0) continue;
            uint256 distributed;
            for (uint256 j; j < recipients.length; ++j) {
                // last recipient sweeps the remainder so rounding never strands dust
                uint256 share = j + 1 == recipients.length ? bal - distributed : (bal * bps[j]) / 10000;
                distributed += share;
                if (share == 0) continue;
                if (asset == address(0)) SafeTransferLib.safeTransferETH(recipients[j], share);
                else SafeTransferLib.safeTransfer(asset, recipients[j], share);
            }
        }
        emit Relayed(msg.sender, recipients[0], len, landed);
    }

    /// @notice Native-ETH fees (a native-asset op) are paid to this contract during settle; accept them.
    receive() external payable {}
}
