// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CdpLeg, ICdpController} from "./ConfidentialPool.sol";

/// The pool seam the controller drives to wind an ESCROW-mode farm down (ops/PLAN-evm-farm-rewards.md):
/// `farmEscrow(this, rewardAsset, 0, to)` releases the unspent treasury to `to`, gated by the controller's pinned
/// reward asset. Funding is the funder's direct `pool.farmEscrow(controller, rewardAsset, amount, 0)` (reuses the
/// pool's deposit path), so the controller never custodies the reward — it only sets the rate and authorizes the
/// wind-down recover.
interface IFarmPool {
    function farmEscrow(address controller, bytes32 rewardAsset, uint256 amount, address to)
        external
        returns (uint256 out);
}

/// Reward controller (SPEC-CONTROLLER-VAULT-AMENDMENT §4) — a plain `ICdpController`, so the pool needs NO
/// dedicated harvest seam: it reuses the existing `onCdpMint` call site, branching on the `positionLeaf`
/// sentinel the guest sets (`1` = receipt bond/harvest, `0` = bare payout, `> 1` = a bare position lock). The
/// pool skips the position insert for the sentinel leaves.
///
/// Per-stake rewards over CONFIDENTIAL, UNLINKABLE positions via the MasterChef/Synthetix reward-per-share
/// accumulator, the per-staker checkpoint living in a SHIELDED RECEIPT NOTE committing `(shares, rps_entry)`.
/// This contract holds ONLY global state (`rps`, `totalShares`, `rate`, `periodFinish`) — nothing per-owner to
/// deanonymize. The guest creates/advances the receipt and surfaces `(shares, rps_entry)` as the two leg
/// values; this contract binds `rps_entry == rps` at bond (no backdating) and bounds `reward·PRECISION ≤
/// shares·(rps − rps_entry)` at harvest, against its live reward-per-share.
///
/// ONE primitive, two reward sources (chosen by the reward asset's pool registration, so there is no separate
/// flag to keep coherent):
///   • ESCROW mode (Bitcoin parity, refundable) — `REWARD_ASSET` is an escrow-backed pool asset. `notify` pulls
///     the funder's reward into a per-farm treasury; harvest pays notes drawn from it; `recover` reclaims the
///     unspent remainder after the period ends. `notify` once + `recover` = MasterChef fixed-budget; `notify`
///     each period = Synthetix.
///   • MINT mode (inflationary) — `REWARD_ASSET` is the controller's pool-minted debt asset; harvest mints the
///     reward note fresh. No treasury, no `recover` (un-minted = un-inflated); `notify` only sets the rate.
contract FarmController is ICdpController {
    address public immutable POOL;
    /// The single asset accepted as farm stake / LP shares.
    bytes32 public immutable STAKE_ASSET;
    /// The asset paid as reward. ESCROW: an escrow-backed pool asset the funder deposits. MINT: the controller's
    /// own pool-minted debt asset (`keccak("tacit-cdp-debt-v1" ‖ this)`). ESCROW_MODE selects the treasury path.
    bytes32 public immutable REWARD_ASSET;
    bool public immutable ESCROW_MODE;
    /// true ⇒ a reward farm: only receipt ops (bond/harvest, positionLeaf == 1) are accepted, so a bare
    /// position lock can't be routed here to inflate `totalShares` and dilute receipt holders' rps without
    /// ever harvesting. false ⇒ a plain position-lock vault (bare bonds, no rps receipts).
    bool public immutable RECEIPT_MODE;

    /// PRECISION ≥ the max share count (note values, ≤ u64) so any reward ≥ 1 advances the checkpoint. Pinned to
    /// `2 ** 64` to equal the Bitcoin reflection's `FARM_RPS_PRECISION` byte-for-byte — so a receipt's `rps_entry`
    /// is the SAME number on both chains and a deterministic farm position can bridge across them (§5). The bound
    /// `reward·PRECISION ≤ shares·(rps − rps_entry)` is PRECISION-independent (it cancels), so this only sets the
    /// sub-unit dust granularity, not the economics.
    uint256 public constant PRECISION = 2 ** 64;
    /// Recover grace after the emission period ends — mirrors the Bitcoin farm's ~1008-block (~7-day) window
    /// before the launcher may reclaim the unspent treasury, so late harvests still land first.
    uint256 public constant RECOVER_GRACE = 7 days;
    /// positionLeaf == 1 is the RECEIPT sentinel (a note-receipt bond or harvest; debtValue discriminates them);
    /// the pool skips the position insert for it. positionLeaf > 1 is a bare position lock (no rps receipt).
    bytes32 internal constant RECEIPT = bytes32(uint256(1));

    address public immutable gov; // the farm creator/funder (ESCROW) or the protocol (MINT): notify + recover authority
    uint256 public rate; // reward units/sec (Synthetix `rewardRate`); set by notify, backed by the treasury in ESCROW
    uint256 public periodFinish; // emission ends here; accrual is clamped to it (no emission past the funded window)
    uint256 public lockUntil; // global lock-up: no unbond before this; gov may only shorten/clear it
    uint256 public totalShares;
    uint256 public rps; // Σ rate·dt·PRECISION/totalShares over [start, min(now, periodFinish)] — reward-per-share
    uint256 public lastUpdate;

    error Locked();
    error NotGov();
    error NotPool();
    error TooEarly();
    error OverClaim();
    error ZeroAddress();
    error EntryNotLive();
    error NotSupported();
    error ZeroDuration();
    error EntryAheadOfRps();
    error BarePayoutUnsupported();
    error BadFarmShape();
    error WrongStakeAsset();
    error WrongRewardAsset();
    error LockExtensionForbidden();
    error RateTooHigh();

    event RewardNotified(uint256 reward, uint256 rate, uint256 periodFinish);
    event Recovered(address indexed to, uint256 amount);

    modifier onlyPool() {
        if (msg.sender != POOL) revert NotPool();
        _;
    }

    constructor(
        address pool,
        bytes32 stakeAsset,
        bytes32 rewardAsset,
        bool escrowMode,
        bool receiptMode,
        address gov_,
        uint256 lockUntil_
    ) {
        if (pool == address(0) || gov_ == address(0)) revert ZeroAddress();
        if (stakeAsset == bytes32(0) || rewardAsset == bytes32(0)) revert BadFarmShape();
        POOL = pool;
        STAKE_ASSET = stakeAsset;
        REWARD_ASSET = rewardAsset;
        ESCROW_MODE = escrowMode;
        RECEIPT_MODE = receiptMode;
        gov = gov_;
        lockUntil = lockUntil_;
        lastUpdate = block.timestamp;
    }

    /// (Re)set the emission rate, Synthetix-style: `rate = reward/duration`, rolling any unspent remaining
    /// emission into the new rate, and extend `periodFinish`. ESCROW farms must be funded to back this rate via
    /// `pool.fundFarm(this, REWARD_ASSET, reward)` (the funder's direct deposit — harvest fails closed on an
    /// under-funded treasury). MINT farms mint the reward fresh. One call with a fixed duration is the MasterChef
    /// fixed-budget program (then `recover`); repeated calls are the Synthetix streaming model.
    function notifyRewardAmount(uint256 reward, uint256 duration) external {
        if (msg.sender != gov) revert NotGov();
        if (duration == 0) revert ZeroDuration();
        _accrue();
        if (block.timestamp >= periodFinish) {
            rate = reward / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rate;
            rate = (reward + leftover) / duration;
        }
        // Bound the rate so accrual (`rate · dt · PRECISION`) and the harvest check (`shares · (rps − entry)`)
        // can never overflow u256 for any realistic elapsed time. An unchecked overflow in `_accrue` would
        // revert every bond/harvest AND unbond (onCdpClose accrues too), locking stakers' principal — so a
        // fat-fingered or hostile rate must fail here instead. u64/sec dwarfs any real farm's emission.
        if (rate > type(uint64).max) revert RateTooHigh();
        periodFinish = block.timestamp + duration;
        lastUpdate = block.timestamp;
        emit RewardNotified(reward, rate, periodFinish);
    }

    /// Reclaim the unspent treasury after the period + grace (ESCROW only). The pool releases the full remaining
    /// per-farm treasury (= funded − distributed), leaving exactly the escrow that backs outstanding reward
    /// notes — so this can never reach another farm's backing. MINT has nothing escrowed, so there is no refund.
    function recover(address to) external returns (uint256 released) {
        if (msg.sender != gov) revert NotGov();
        if (!ESCROW_MODE) revert NotSupported();
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp < periodFinish + RECOVER_GRACE) revert TooEarly();
        released = IFarmPool(POOL).farmEscrow(address(this), REWARD_ASSET, 0, to);
        emit Recovered(to, released);
    }

    /// Reward-per-share accrual clamped to the funded window (`min(now, periodFinish)`) and to active stake
    /// (`totalShares > 0`) — intervals with no stakers don't accrue, so that reward stays in the treasury and is
    /// recoverable (the Bitcoin "no-staker reward refunds to the launcher" behaviour). `lastUpdate` caps at
    /// `periodFinish` (Synthetix `lastTimeRewardApplicable`) so the gap between periods never back-accrues.
    function _accrue() internal {
        uint256 applicable = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (totalShares != 0 && applicable > lastUpdate) {
            rps += (rate * (applicable - lastUpdate) * PRECISION) / totalShares;
        }
        if (applicable > lastUpdate) lastUpdate = applicable;
    }

    function currentRps() public view returns (uint256) {
        uint256 applicable = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (totalShares == 0 || applicable <= lastUpdate) return rps;
        return rps + (rate * (applicable - lastUpdate) * PRECISION) / totalShares;
    }

    function _stakeWeight(CdpLeg[] calldata legs) internal view returns (uint256 w) {
        if (legs.length == 0) revert BadFarmShape();
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].asset != STAKE_ASSET) revert WrongStakeAsset();
            if (legs[i].value == 0) revert BadFarmShape();
            w += legs[i].value;
        }
    }

    /// One callback for the receipt sentinel (leaf == 1: bond when debtValue == 0, harvest when > 0), a bare
    /// position lock (leaf > 1), and a bare payout (leaf == 0). `legs = [shares, rps_entry]` for the receipt ops.
    /// ESCROW harvests are additionally treasury-bounded by the pool BEFORE this call (it debits the per-farm
    /// treasury by debtValue), so a harvest can never exceed the funded reward — here we only enforce the rps
    /// fairness bound, identical in both modes.
    function onCdpMint(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionLeaf) external onlyPool {
        _accrue();
        if (positionLeaf == RECEIPT) {
            if (legs.length != 2 || legs[0].value == 0 || legs[1].asset != bytes32(0)) revert BadFarmShape();
            uint256 shares = legs[0].value;
            uint256 rpsEntry = legs[1].value;
            if (debtValue == 0) {
                // BOND: the receipt note commits rps_entry — it MUST equal the live rps, so a backdated receipt
                // can't earn pre-bond reward (the one spot that can need a prove→settle retry if rps moved).
                if (legs[0].asset != STAKE_ASSET) revert WrongStakeAsset();
                if (rpsEntry != rps) revert EntryNotLive();
                totalShares += shares;
            } else {
                // HARVEST: bound the reward to real accrual. totalShares is untouched — the principal stays
                // staked (the receipt is consumed + re-minted advanced by the guest; bond once, harvest many).
                if (legs[0].asset != REWARD_ASSET) revert WrongRewardAsset();
                if (rpsEntry > rps) revert EntryAheadOfRps();
                if (debtValue * PRECISION > shares * (rps - rpsEntry)) revert OverClaim();
            }
        } else if (positionLeaf == bytes32(0)) {
            revert BarePayoutUnsupported(); // this farm meters every payout; it has no unmetered faucet
        } else {
            // bare bond: lock a position basket with no rps receipt; track the public bonded weight. A reward
            // farm (RECEIPT_MODE) rejects it — bare weight would dilute receipt holders' rps without ever
            // harvesting; only a plain lock vault accepts bare bonds.
            if (RECEIPT_MODE) revert NotSupported();
            if (debtValue != 0) revert BadFarmShape();
            totalShares += _stakeWeight(legs);
        }
    }

    /// unbond: enforce the global lock-up, then release; `legs` = the released basket (public).
    function onCdpClose(
        uint256 debtValue,
        CdpLeg[] calldata legs,
        bytes32 /*positionNullifier*/
    )
        external
        onlyPool
    {
        if (debtValue != 0) revert BadFarmShape();
        if (block.timestamp < lockUntil) revert Locked();
        _accrue();
        uint256 w = _stakeWeight(legs);
        if (w > totalShares) revert BadFarmShape();
        totalShares -= w;
    }

    function onCdpLiquidate(CdpLeg[] calldata, uint256, bytes32) external view onlyPool {
        revert NotSupported();
    }

    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, bytes32, bytes32) external view onlyPool {
        revert NotSupported();
    }

    /// Shorten/clear the unbond lock-up. The initial maximum lock is a deploy-time choice; after users enter,
    /// governance must not be able to extend their exit horizon.
    function setLockUntil(uint256 newLockUntil) external {
        if (msg.sender != gov) revert NotGov();
        if (newLockUntil > lockUntil) revert LockExtensionForbidden();
        lockUntil = newLockUntil;
    }
}
