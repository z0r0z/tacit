// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CdpLeg, ICdpController} from "./ConfidentialPool.sol";

/// The pool seam the controller drives to wind an ESCROW-mode farm down:
/// `farmEscrow(this, rewardAsset, 0, to)` releases the unspent treasury to `to`, gated by the controller's pinned
/// reward asset. Funding is the funder's direct `pool.farmEscrow(controller, rewardAsset, amount, 0)` (reuses the
/// pool's deposit path), so the controller never custodies the reward — it only sets the rate and authorizes the
/// wind-down recover.
interface IFarmPool {
    function farmEscrow(address controller, bytes32 rewardAsset, uint256 amount, address to)
        external
        returns (uint256 out);
    function farmTreasury(address controller) external view returns (uint256 treasury);
}

/// Reward controller — a plain `ICdpController`, so the pool needs NO
/// dedicated harvest seam: it reuses the existing `onCdpMint` call site, branching on the `positionLeaf`
/// sentinel the guest sets (`1` = receipt bond/harvest, `0` = bare payout, `> 1` = a bare position lock). The
/// pool skips the position insert for the sentinel leaves.
///
/// Per-stake rewards over STAKE-ANYTIME positions via the MasterChef/Synthetix reward-per-share accumulator.
/// The per-position checkpoint is STAMPED AT EXECUTION (`entryRps[receiptLeaf] = rps`), exactly as MasterChef
/// sets `user.rewardDebt` on deposit — the live `rps` moves every second, so it is simply not knowable when
/// the minutes-long bond proof is built. The guest creates the receipt leaf (a stable position id committing
/// `(shares, owner, nonce)`) and surfaces `shares` as the single leg value; this contract stamps the entry at
/// bond, bounds `reward*PRECISION <= shares*(rps - entryRps[leaf])` at harvest and RE-STAMPS it (so a replayed
/// harvest pays 0), and clears the stamp at unbond.
///
/// Privacy: `shares` and the position id are public (the same posture as a CDP position leaf), but the OWNER
/// stays hidden — every harvest/unbond is authorized by the receipt owner's signature inside the proof, and
/// this contract stores nothing that names them.
///
/// ONE primitive, two reward sources (chosen by the reward asset's pool registration, so there is no separate
/// flag to keep coherent):
///   • ESCROW mode (Bitcoin parity, refundable) — `REWARD_ASSET` is an escrow-backed pool asset. The funder
///     deposits rewards into the per-farm treasury through the pool; `notify` sets the emission rate, harvest
///     pays notes drawn from that treasury, and `recover` reclaims the unspent remainder after the period ends.
///     Fund once + `notify` once + `recover` = MasterChef fixed-budget; repeat funding + `notify` each period =
///     Synthetix.
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
    /// `2 ** 64` to equal the Bitcoin reflection's `FARM_RPS_PRECISION` byte-for-byte — so a position's entry
    /// is the SAME number on both chains and a deterministic farm position can bridge across them. The bound
    /// `reward·PRECISION ≤ shares·(rps − entryRps)` is PRECISION-independent (it cancels), so this only sets the
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
    // Σ over live positions of `shares_i · entryRps_i` — the MasterChef reward debt, in rps units. Bumped by
    // `shares·rps` at bond, by `shares·(rps − entry)` at each harvest (the window just paid out), and retired
    // exactly at unbond. `rps·totalShares − totalRewardDebt` is therefore the EXACT unclaimed entitlement.
    // Exact, not an upper bound, precisely because every entry is a stamped LIVE value: no position can hold
    // a future-dated checkpoint whose emission nobody can ever claim. The funding check (notify) and the
    // recover reservation both read it, so a rollover can't over-promise and a recover can't reclaim reward a
    // staker has earned — and when the last position leaves, it is 0, so the sponsor recovers everything.
    uint256 public totalRewardDebt;
    // Per-position entry checkpoint, keyed by the guest's receipt leaf. Stamped with the LIVE `rps` at bond,
    // re-stamped at each harvest, deleted at unbond. Non-zero ⇔ a live position (a bond at rps == 0 is the one
    // exception, handled by the `entryStamped` flag below, so a first-block staker isn't mistaken for absent).
    mapping(bytes32 => uint256) public entryRps;
    // `entryRps[leaf]` alone can't distinguish "staked at rps == 0" from "never staked", and an empty farm's
    // first bond is exactly the rps == 0 case. This is the liveness bit; both are cleared at unbond.
    mapping(bytes32 => bool) public entryStamped;

    error Locked();
    error NotGov();
    error NotPool();
    error TooEarly();
    error OverClaim();
    error RateTooHigh();
    error UnfundedRate();
    error ZeroAddress();
    error BadFarmShape();
    error NotSupported();
    error ZeroDuration();
    error NoLivePosition();
    error PositionExists();
    error WrongStakeAsset();
    error WrongRewardAsset();
    error BarePayoutUnsupported();
    error LockExtensionForbidden();

    event RewardNotified(uint256 reward, uint256 rate, uint256 periodFinish);
    event Recovered(address indexed to, uint256 amount);

    modifier onlyPool() {
        _onlyPool();
        _;
    }

    function _onlyPool() internal view {
        if (msg.sender != POOL) revert NotPool();
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
        bytes32 debtAsset = keccak256(abi.encodePacked("tacit-cdp-debt-v1", address(this)));
        if (escrowMode == (rewardAsset == debtAsset)) revert BadFarmShape();
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
    /// `pool.farmEscrow(this, REWARD_ASSET, reward, address(0))` (the funder's direct deposit — harvest fails closed on an
    /// under-funded treasury). MINT farms mint the reward fresh. One call with a fixed duration is the MasterChef
    /// fixed-budget program (then `recover`); repeated calls are the Synthetix streaming model.
    function notifyRewardAmount(uint256 reward, uint256 duration) external {
        if (msg.sender != gov) revert NotGov();
        if (duration == 0) revert ZeroDuration();
        _accrue();
        uint256 newRate;
        if (block.timestamp >= periodFinish) {
            newRate = reward / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rate;
            newRate = (reward + leftover) / duration;
        }
        if (newRate == 0) revert BadFarmShape();
        // Bound the rate so accrual (`rate · dt · PRECISION`) and the harvest check (`shares · (rps − entry)`)
        // can never overflow u256 for any realistic elapsed time. An unchecked overflow in `_accrue` would
        // revert every bond/harvest AND unbond (onCdpClose accrues too), locking stakers' principal — so a
        // fat-fingered or hostile rate must fail here instead. u64/sec dwarfs any real farm's emission.
        if (newRate > type(uint64).max) revert RateTooHigh();
        // ESCROW farms emit from a pre-funded pool treasury; refuse to set a rate the treasury can't back so
        // stakers never bond against a campaign whose harvests would later fail closed. (MINT farms coin the
        // reward fresh, so there is nothing to pre-fund.)
        // Fund check must cover BOTH the new schedule AND the already-earned-but-unharvested liability, or a
        // mid-period rollover would promise more than the treasury backs — early harvesters would then drain
        // the reserve and late valid harvests fail closed. `_accrue()` above brought `rps` current, so
        // `outstandingReward()` is the exact liability.
        if (ESCROW_MODE && IFarmPool(POOL).farmTreasury(address(this)) < outstandingReward() + newRate * duration) {
            revert UnfundedRate();
        }
        rate = newRate;
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
        _accrue(); // bring `rps` current (to periodFinish) so the reservation covers the full earned liability
        // The pool releases only `treasury - outstandingReward()`, reserving every live position's earned-but-
        // unharvested reward EXACTLY. A staker can still harvest after recover; only the truly unspent surplus
        // (no-staker intervals, forfeited un-harvested tails, and rounding) leaves. When every position has
        // unbonded the reservation is 0 and the sponsor gets the whole remaining treasury back.
        released = IFarmPool(POOL).farmEscrow(address(this), REWARD_ASSET, 0, to);
        emit Recovered(to, released);
    }

    /// Reward-per-share accrual clamped to the funded window (`min(now, periodFinish)`) and to active stake
    /// (`totalShares > 0`) — intervals with no stakers don't accrue, so that reward stays in the treasury and is
    /// recoverable (the Bitcoin "no-staker reward refunds to the launcher" behaviour). `lastUpdate` caps at
    /// `periodFinish` (Synthetix `lastTimeRewardApplicable`) so the gap between periods never back-accrues.
    function _accrue() internal {
        uint256 fin = periodFinish;
        uint256 applicable = block.timestamp < fin ? block.timestamp : fin;
        uint256 last = lastUpdate;
        if (applicable <= last) return;
        uint256 ts = totalShares;
        if (ts != 0) {
            rps += (rate * (applicable - last) * PRECISION) / ts;
        }
        lastUpdate = applicable;
    }

    /// The EXACT reward every live position could still claim: `(rps·totalShares − totalRewardDebt)/PRECISION`.
    /// This is what `recover` must leave behind and what `notify` must fund on top of the new schedule. Reads
    /// the STORED `rps`, so callers must `_accrue()` first (both do). `totalShares == 0` ⇒ `totalRewardDebt`
    /// is 0 too ⇒ 0, so a fully-exited farm leaves no residual dust reserved.
    function outstandingReward() public view returns (uint256) {
        return (rps * totalShares - totalRewardDebt) / PRECISION;
    }

    function currentRps() public view returns (uint256) {
        uint256 fin = periodFinish;
        uint256 applicable = block.timestamp < fin ? block.timestamp : fin;
        uint256 last = lastUpdate;
        uint256 ts = totalShares;
        if (ts == 0 || applicable <= last) return rps;
        return rps + (rate * (applicable - last) * PRECISION) / ts;
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
    /// position lock (leaf > 1), and a bare payout (leaf == 0). `legs = [shares]` for the receipt ops, and
    /// `rateSnapshot` carries the guest's RECEIPT LEAF — the position key this contract stamps. That field is
    /// otherwise inert for a farm (no cUSD debt, no stability fee), so reusing it keeps the frozen pool's
    /// ICdpController tuple unchanged. The guest computes the leaf and the CdpMint field in one step from the
    /// same value it appends to the note tree, so a prover cannot key a stamp on a leaf it never bonded.
    /// ESCROW harvests are additionally treasury-bounded by the pool BEFORE this call (it debits the per-farm
    /// treasury by debtValue), so a harvest can never exceed the funded reward — here we only enforce the rps
    /// fairness bound, identical in both modes.
    function onCdpMint(
        CdpLeg[] calldata legs,
        uint256 debtValue,
        bytes32 positionLeaf,
        uint256 rateSnapshot
    )
        external
        onlyPool
    {
        _accrue();
        if (positionLeaf == RECEIPT) {
            // Receipt ops (bond/harvest) belong only to a reward farm. A plain position-lock vault
            // (RECEIPT_MODE == false) must reject them — the mirror of the bare-bond gate below — else a
            // receipt bond/harvest could drive rps/reward accounting on a controller never meant to support it.
            if (!RECEIPT_MODE) revert NotSupported();
            if (legs.length != 1 || legs[0].value == 0) revert BadFarmShape();
            bytes32 receipt = bytes32(rateSnapshot);
            if (receipt == bytes32(0)) revert BadFarmShape();
            uint256 shares = legs[0].value;
            uint256 liveRps = rps; // `_accrue` just synced it; read once for the branch below
            if (debtValue == 0) {
                // BOND: stamp the checkpoint with the LIVE reward-per-share — MasterChef's
                // `user.rewardDebt = amount·accRewardPerShare` on deposit. Stamping HERE is the whole point:
                // the proof cannot know the settle-time `rps`, so any pre-committed checkpoint drifts. A
                // stamped entry can be neither backdated (which would overclaim at harvest) nor future-dated
                // (which would strand emission no receipt can claim), so joining mid-campaign is now exact.
                if (legs[0].asset != STAKE_ASSET) revert WrongStakeAsset();
                // A position id is bonded once. Re-bonding a live leaf would overwrite its stamp and silently
                // burn its accrued entitlement (and double-count its shares); the staker uses a fresh nonce.
                if (entryStamped[receipt]) revert PositionExists();
                entryStamped[receipt] = true;
                entryRps[receipt] = liveRps;
                totalShares += shares;
                totalRewardDebt += shares * liveRps;
            } else {
                // HARVEST: bound the reward to this position's real accrual, against ITS OWN stamp, then
                // re-stamp to the live rps. The re-stamp is what makes a replay pay nothing: a second harvest
                // bounds against `shares·(rps − rps) == 0` and reverts OverClaim. The receipt leaf is not
                // consumed (bond once, harvest many) and totalShares is untouched — the principal stays staked.
                if (legs[0].asset != REWARD_ASSET) revert WrongRewardAsset();
                if (!entryStamped[receipt]) revert NoLivePosition();
                uint256 entry = entryRps[receipt];
                uint256 window = liveRps - entry; // entry <= rps: a stamp is only ever set to a past live rps
                if (debtValue * PRECISION > shares * window) revert OverClaim();
                // The whole window is now consumed — the debt takes it on, so `outstandingReward()` drops by
                // exactly what this position could still have claimed (any unclaimed dust is forfeited).
                totalRewardDebt += shares * window;
                entryRps[receipt] = liveRps;
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

    /// unbond: enforce the global lock-up, then release; `legs` = the released basket (public). `repaid` is
    /// inert here (a farm never accrues a cUSD debt) and `principal` (the position debt) must be 0;
    /// `rateSnapshot` carries the guest's RECEIPT LEAF, whose stamp and reward debt this retires.
    function onCdpClose(
        uint256 principal,
        uint256 repaid,
        uint256 rateSnapshot,
        CdpLeg[] calldata legs,
        bytes32 /*positionNullifier*/
    )
        external
        onlyPool
    {
        if (principal != 0 || repaid != 0) revert BadFarmShape();
        if (block.timestamp < lockUntil) revert Locked();
        _accrue();
        uint256 w = _stakeWeight(legs);
        // A RECEIPT_MODE farm's unbond closes a stamped position: retire exactly `shares · entryRps[leaf]` of
        // reward debt and delete the stamp. Retiring the STAMPED product (not a recomputed one) is what keeps
        // `totalRewardDebt` from underflowing and what makes an un-harvested tail forfeit to the sponsor's
        // recoverable surplus — the same launcher-refund-after-exit semantics the Bitcoin farm has. Deleting
        // the stamp also makes unbond terminal: nothing left to harvest, nothing to replay.
        // A plain lock vault (no receipts) has no stamp; its `rateSnapshot` must be 0.
        bytes32 receipt = bytes32(rateSnapshot);
        if (RECEIPT_MODE) {
            if (!entryStamped[receipt]) revert NoLivePosition();
            totalRewardDebt -= w * entryRps[receipt];
            delete entryRps[receipt];
            delete entryStamped[receipt];
        } else if (receipt != bytes32(0)) {
            revert BadFarmShape();
        }
        if (w > totalShares) revert BadFarmShape();
        totalShares -= w;
    }

    function onCdpLiquidate(CdpLeg[] calldata, uint256, uint256, uint256, bytes32) external view onlyPool {
        revert NotSupported();
    }

    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, uint256, bytes32, bytes32)
        external
        view
        onlyPool
    {
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
