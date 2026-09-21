// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {CdpLeg, ICdpController} from "./ConfidentialPool.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IManagerPool {
    function farmEscrow(address controller, bytes32 rewardAsset, uint256 amount, address to) external returns (uint256 out);
    function farmTreasury(address controller) external view returns (uint256 treasury);
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

/// @title FarmManager — a MasterChef-style singleton reward controller for the confidential pool's LP farms
/// @notice ONE budget, many pools. Governance sets allocation points per stake asset (an LP-share id); the global emission
///         rate streams to each pool in proportion, exactly like SushiSwap's MasterChef. It is an ordinary `ICdpController`, so the
///         pool needs no change: the pool binds a controller address to ONE reward asset and ONE escrow treasury, and calls this
///         contract's hooks for bond / harvest / unbond. Stake and reward stay private inside the pool — only shares and
///         positions ids are public, as with the single-pool `FarmController`.
///
///         Differences from `FarmController` (one pool per contract):
///         - many pools under one treasury, weighted by `allocPoint`, re-weightable by governance at any time;
///         - PER-POSITION lock-ups: each position keeps the unlock time it was bonded with, so governance can change a pool's
///           lock for NEW bonds but can never extend anyone's exit horizon;
///         - `fundAndNotify`: fund the treasury and start/roll the stream in one governor call;
///         - two-step governor handover (a singleton is long-lived, unlike a per-farm controller).
///
/// @dev The pool passes stake at BOND (`legs[0].asset` = the LP-share id, which selects the pool) but only the reward asset at
///      HARVEST, so the pool a receipt belongs to is recorded at bond and looked up thereafter. Accounting per pool is the
///      unchanged MasterChef/Synthetix reward-per-share accumulator with the same fairness bound
///      `reward · PRECISION ≤ shares · (rps − entryRps)`. Emission is clamped to the funded window and to active stake:
///      a pool with nobody staked, or with zero allocation, accrues nothing, so its share stays in the treasury and is
///      recoverable. The pool debits its per-controller treasury on every harvest BEFORE calling here, so a harvest can never
///      exceed what was funded; this contract additionally refuses to set a rate the treasury cannot back.
contract FarmManager is ICdpController {
    address public immutable POOL;
    /// The pinned reward asset (an escrow-backed pool asset — for TAC rewards, the wTAC wrapper's asset id).
    bytes32 public immutable REWARD_ASSET;
    /// The reward asset's underlying ERC20 and the pool's derived unit scale (underlying base units per value unit).
    address public immutable REWARD_TOKEN;
    uint256 public immutable UNIT_SCALE;

    /// Matches the Bitcoin reflection's `FARM_RPS_PRECISION` byte for byte (see `FarmController`).
    uint256 public constant PRECISION = 2 ** 64;
    uint256 public constant RECOVER_GRACE = 7 days;
    uint256 public constant MAX_POOLS = 16;
    uint256 public constant MAX_LOCK = 90 days;
    /// A program lasts between a week and a year. A schedule's END can never move earlier and its rate can never fall, so an
    /// announced stream cannot be compressed into a moment or stretched thin.
    uint256 public constant MIN_DURATION = 7 days;
    uint256 public constant MAX_DURATION = 365 days;
    /// Re-weighting or adding a pool is queued in public and executable only after this delay (LPs can see it coming).
    uint256 public constant CONFIG_DELAY = 7 days;
    uint256 public constant CONFIG_WINDOW = 14 days;
    /// Weights are bounded so no governor can divert or void the stream: at most one change per cooldown, an existing pool
    /// moves at most ±25% per change (and can never be zeroed), and a new pool starts at no more than 10% of the total.
    uint256 public constant CONFIG_COOLDOWN = 30 days;
    uint256 public constant MAX_NEW_POOL_BPS = 1000;
    bytes32 internal constant RECEIPT = bytes32(uint256(1));

    struct PoolInfo {
        bytes32 stakeAsset;
        uint256 totalShares;
        uint256 rps; // Σ rate·alloc/totalAlloc·dt·PRECISION/totalShares over the funded window
        uint256 totalRewardDebt; // Σ shares·entryRps over live positions
        uint32 allocPoint;
        uint64 lastUpdate;
        uint64 lockDuration; // applied to positions bonded from now on
    }

    struct Position {
        uint256 entryRps;
        uint128 shares;
        uint64 unlockAt;
        uint32 pid;
        bool live;
    }

    address public gov;
    address public pendingGov;
    /// Bumped on every handover and folded into each queued id, so an outgoing governor's queue dies with its tenure.
    uint256 public govEpoch;
    uint256 public lastConfigAt;
    uint256 public rate; // total reward value-units/sec across all pools
    uint256 public periodFinish;
    uint256 public totalAllocPoint;

    /// Queued configuration changes: id -> earliest execution time (0 = not queued).
    mapping(bytes32 => uint256) public queuedAt;

    PoolInfo[] internal _pools;
    mapping(bytes32 => uint256) internal _pidPlusOne; // stakeAsset -> pid + 1
    mapping(bytes32 => Position) public positions; // keyed by the guest's receipt leaf

    error Locked();
    error NotGov();
    error NotPool();
    error TooEarly();
    error OverClaim();
    error BadPool();
    error RateTooHigh();
    error TooManyPools();
    error ZeroAddress();
    error BadFarmShape();
    error NotSupported();
    error UnfundedRate();
    error ZeroDuration();
    error LockTooLong();
    error PoolExists();
    error NoLivePosition();
    error PositionExists();
    error WrongStakeAsset();
    error WrongRewardAsset();
    error BadRewardAsset();
    error BarePayoutUnsupported();
    error RateDecrease();
    error DurationTooLong();
    error NotQueued();
    error NotReady();
    error Expired();
    error Cooldown();
    error BadAlloc();
    error DurationTooShort();
    error EndMovesEarlier();

    event PoolAdded(uint256 indexed pid, bytes32 stakeAsset, uint32 allocPoint, uint64 lockDuration);
    event AllocSet(uint256 indexed pid, uint32 allocPoint);
    event ConfigQueued(bytes32 indexed id, uint256 eta);
    event ConfigCancelled(bytes32 indexed id);
    event RewardNotified(uint256 reward, uint256 rate, uint256 periodFinish);
    event Recovered(address indexed to, uint256 amount);
    event Funded(address indexed funder, uint256 amount, uint256 value);
    event Bonded(bytes32 indexed receipt, uint256 indexed pid, uint256 shares, uint256 unlockAt);
    event Harvested(bytes32 indexed receipt, uint256 indexed pid, uint256 reward);
    event Unbonded(bytes32 indexed receipt, uint256 indexed pid, uint256 shares);
    event GovProposed(address indexed pending);
    event GovAccepted(address indexed gov);

    modifier onlyPool() {
        if (msg.sender != POOL) revert NotPool();
        _;
    }

    modifier onlyGov() {
        if (msg.sender != gov) revert NotGov();
        _;
    }

    /// The launch program is set HERE, in the constructor: pools, weights and lock-ups exactly as announced, with no post-deploy
    /// transaction needed to start it. Lock-ups are fixed per pool for the life of the contract.
    constructor(
        address pool,
        bytes32 rewardAsset,
        address gov_,
        bytes32[] memory stakeAssets,
        uint32[] memory allocPoints,
        uint64[] memory lockDurations
    ) {
        if (pool == address(0) || gov_ == address(0)) revert ZeroAddress();
        if (rewardAsset == bytes32(0)) revert BadRewardAsset();
        (bool registered, address underlying, uint256 scale,, bool poolMinted,) = IManagerPool(pool).assets(rewardAsset);
        // The pool's first-fund check rejects a pool-minted or underlying-less reward; refuse it here so a bad manager
        // cannot be deployed at all.
        if (!registered || poolMinted || underlying == address(0)) revert BadRewardAsset();
        POOL = pool;
        REWARD_ASSET = rewardAsset;
        REWARD_TOKEN = underlying;
        UNIT_SCALE = scale;
        gov = gov_;
        if (stakeAssets.length != allocPoints.length || stakeAssets.length != lockDurations.length) revert BadFarmShape();
        for (uint256 i; i < stakeAssets.length; ++i) {
            if (allocPoints[i] == 0) revert BadAlloc(); // a zero weight could never be raised again
            _addPool(stakeAssets[i], allocPoints[i], lockDurations[i]);
        }
    }

    // ────────────────────────────── governance ──────────────────────────────

    function proposeGov(address next) external onlyGov {
        if (next == address(0)) revert ZeroAddress();
        pendingGov = next;
        emit GovProposed(next);
    }

    function acceptGov() external {
        if (msg.sender != pendingGov) revert NotGov();
        gov = msg.sender;
        pendingGov = address(0);
        ++govEpoch;
        emit GovAccepted(msg.sender);
    }

    /// Queue adding a pool. It becomes executable after `CONFIG_DELAY` and stays executable for `CONFIG_WINDOW`; anyone can watch
    /// the event. Existing stakers' earned reward is never affected (everything is accrued first).
    function queueAddPool(bytes32 stakeAsset, uint32 allocPoint, uint64 lockDuration) external onlyGov returns (bytes32 id) {
        id = keccak256(abi.encode("add", govEpoch, stakeAsset, allocPoint, lockDuration));
        _queue(id);
    }

    function executeAddPool(bytes32 stakeAsset, uint32 allocPoint, uint64 lockDuration) external onlyGov {
        _consume(keccak256(abi.encode("add", govEpoch, stakeAsset, allocPoint, lockDuration)));
        _massUpdate();
        // A new pool is a bounded slice of the stream: nonzero and at most MAX_NEW_POOL_BPS of the new total.
        if (allocPoint == 0 || uint256(allocPoint) * 10_000 > MAX_NEW_POOL_BPS * (totalAllocPoint + allocPoint)) {
            revert BadAlloc();
        }
        _addPool(stakeAsset, allocPoint, lockDuration);
    }

    /// Queue a re-weighting of one or more pools.
    function queueAllocs(uint256[] calldata pids, uint32[] calldata allocPoints) external onlyGov returns (bytes32 id) {
        _checkAllocShape(pids, allocPoints);
        id = keccak256(abi.encode("alloc", govEpoch, pids, allocPoints));
        _queue(id);
    }

    function executeAllocs(uint256[] calldata pids, uint32[] calldata allocPoints) external onlyGov {
        _checkAllocShape(pids, allocPoints);
        _consume(keccak256(abi.encode("alloc", govEpoch, pids, allocPoints)));
        _massUpdate();
        for (uint256 i; i < pids.length; ++i) {
            _setAlloc(pids[i], allocPoints[i]);
        }
    }

    /// Strictly increasing pids: a pool appears once per change, so the ±25% band is measured against its pre-change weight
    /// and cannot be compounded by repeating an entry.
    function _checkAllocShape(uint256[] calldata pids, uint32[] calldata allocPoints) internal view {
        uint256 n = pids.length;
        if (n != allocPoints.length || n == 0 || n > _pools.length) revert BadFarmShape();
        for (uint256 i = 1; i < n; ++i) {
            if (pids[i] <= pids[i - 1]) revert BadFarmShape();
        }
    }

    function cancel(bytes32 id) external onlyGov {
        if (queuedAt[id] == 0) revert NotQueued();
        delete queuedAt[id];
        emit ConfigCancelled(id);
    }

    function _queue(bytes32 id) internal {
        uint256 eta = block.timestamp + CONFIG_DELAY;
        queuedAt[id] = eta;
        emit ConfigQueued(id, eta);
    }

    function _consume(bytes32 id) internal {
        uint256 eta = queuedAt[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert NotReady();
        if (block.timestamp > eta + CONFIG_WINDOW) revert Expired();
        if (lastConfigAt != 0 && block.timestamp < lastConfigAt + CONFIG_COOLDOWN) revert Cooldown();
        delete queuedAt[id];
        lastConfigAt = block.timestamp;
    }

    function _addPool(bytes32 stakeAsset, uint32 allocPoint, uint64 lockDuration) internal returns (uint256 pid) {
        if (stakeAsset == bytes32(0) || stakeAsset == REWARD_ASSET) revert BadPool();
        if (_pidPlusOne[stakeAsset] != 0) revert PoolExists();
        if (_pools.length >= MAX_POOLS) revert TooManyPools();
        if (lockDuration > MAX_LOCK) revert LockTooLong();
        pid = _pools.length;
        _pools.push(
            PoolInfo({
                stakeAsset: stakeAsset,
                totalShares: 0,
                rps: 0,
                totalRewardDebt: 0,
                allocPoint: allocPoint,
                lastUpdate: uint64(_applicable()),
                lockDuration: lockDuration
            })
        );
        _pidPlusOne[stakeAsset] = pid + 1;
        totalAllocPoint += allocPoint;
        emit PoolAdded(pid, stakeAsset, allocPoint, lockDuration);
    }

    function _setAlloc(uint256 pid, uint32 allocPoint) internal {
        if (pid >= _pools.length) revert BadPool();
        PoolInfo storage p = _pools[pid];
        uint256 cur = p.allocPoint;
        // ±25% of the current weight, and never to zero (a zero-weight pool cannot be raised again either).
        if (allocPoint == 0 || uint256(allocPoint) * 4 < cur * 3 || uint256(allocPoint) * 4 > cur * 5) revert BadAlloc();
        totalAllocPoint = totalAllocPoint - cur + allocPoint;
        p.allocPoint = allocPoint;
        emit AllocSet(pid, allocPoint);
    }

    // ───────────────────────── funding, streaming, reclaim ─────────────────────────

    /// Pull `amount` of the reward token from the governor, escrow it in this manager's pool treasury, and start (or roll) the
    /// stream over `duration` — one transaction. Repeating it is a Synthetix-style top-up: unspent emission rolls into the new
    /// schedule. The governor must have approved this contract for `amount` of the reward token.
    function fundAndNotify(uint256 amount, uint256 duration) external onlyGov {
        uint256 value = _pullAndEscrow(amount);
        _notify(value, duration);
    }

    /// Set/roll the stream from budget ALREADY in the treasury (funded by anyone, e.g. through `TacFarmFunder`, or left over).
    function notifyRewardAmount(uint256 reward, uint256 duration) external onlyGov {
        _notify(reward, duration);
    }

    /// Add to the treasury without changing the schedule. Open to anyone: it can only ADD budget the governor may later stream
    /// (a donation), never take anything out.
    function fund(uint256 amount) external {
        _pullAndEscrow(amount);
    }

    function _pullAndEscrow(uint256 amount) internal returns (uint256 value) {
        uint256 held = ERC20(REWARD_TOKEN).balanceOf(address(this)); // a stray donation must not block funding
        SafeTransferLib.safeTransferFrom(REWARD_TOKEN, msg.sender, address(this), amount);
        SafeTransferLib.safeApprove(REWARD_TOKEN, POOL, amount);
        value = IManagerPool(POOL).farmEscrow(address(this), REWARD_ASSET, amount, address(0));
        if (ERC20(REWARD_TOKEN).balanceOf(address(this)) != held) revert BadFarmShape(); // nothing of the pull may stay behind
        emit Funded(msg.sender, amount, value);
    }

    function _notify(uint256 reward, uint256 duration) internal {
        if (duration == 0) revert ZeroDuration();
        if (duration < MIN_DURATION) revert DurationTooShort();
        if (duration > MAX_DURATION) revert DurationTooLong();
        // A running schedule's end may only stay or move later: the remainder can never be compressed into a moment.
        if (block.timestamp < periodFinish && block.timestamp + duration < periodFinish) revert EndMovesEarlier();
        _massUpdate();
        uint256 newRate;
        if (block.timestamp >= periodFinish) {
            newRate = reward / duration;
        } else {
            newRate = (reward + (periodFinish - block.timestamp) * rate) / duration;
        }
        if (newRate == 0) revert BadFarmShape();
        if (newRate > type(uint64).max) revert RateTooHigh();
        // A running program's rate may be kept or raised, never lowered: no promised emission can be stretched thin.
        if (block.timestamp < periodFinish && newRate < rate) revert RateDecrease();
        // The treasury must back the new schedule AND every already-earned-but-unharvested reward, or early harvesters
        // could drain the reserve and later valid harvests would fail closed.
        if (IManagerPool(POOL).farmTreasury(address(this)) < outstandingReward() + newRate * duration) revert UnfundedRate();
        rate = newRate;
        periodFinish = block.timestamp + duration;
        // Every pool restarts its clock at the new schedule so the gap between periods never back-accrues.
        uint256 n = _pools.length;
        for (uint256 i; i < n; ++i) {
            _pools[i].lastUpdate = uint64(block.timestamp);
        }
        emit RewardNotified(reward, newRate, periodFinish);
    }

    /// Reclaim the unspent treasury after the period plus grace. The pool releases only what does not back reward that stakers
    /// have already earned (`outstandingReward`), so a staker can still harvest after this.
    function recover(address to) external onlyGov returns (uint256 released) {
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp < periodFinish + RECOVER_GRACE) revert TooEarly();
        _massUpdate();
        released = IManagerPool(POOL).farmEscrow(address(this), REWARD_ASSET, 0, to);
        emit Recovered(to, released);
    }

    // ───────────────────────────────── accrual ─────────────────────────────────

    function _applicable() internal view returns (uint256) {
        uint256 fin = periodFinish;
        return block.timestamp < fin ? block.timestamp : fin;
    }

    function _accruePool(uint256 pid) internal {
        PoolInfo storage p = _pools[pid];
        uint256 applicable = _applicable();
        uint256 last = p.lastUpdate;
        if (applicable <= last) return;
        uint256 ts = p.totalShares;
        uint256 ta = totalAllocPoint;
        if (ts != 0 && ta != 0 && p.allocPoint != 0) {
            p.rps += (rate * p.allocPoint * (applicable - last) * PRECISION) / (ta * ts);
        }
        p.lastUpdate = uint64(applicable);
    }

    function _massUpdate() internal {
        uint256 n = _pools.length;
        for (uint256 i; i < n; ++i) {
            _accruePool(i);
        }
    }

    /// Public accrual pass (anyone may call; it only moves accounting forward to now).
    function massUpdatePools() external {
        _massUpdate();
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function poolLength() external view returns (uint256) {
        return _pools.length;
    }

    function poolInfo(uint256 pid) external view returns (PoolInfo memory) {
        return _pools[pid];
    }

    function pidOf(bytes32 stakeAsset) external view returns (uint256 pid, bool exists) {
        uint256 p = _pidPlusOne[stakeAsset];
        return (p == 0 ? 0 : p - 1, p != 0);
    }

    /// Reward-per-share of `pid` as of now (without writing).
    function currentRps(uint256 pid) public view returns (uint256) {
        PoolInfo storage p = _pools[pid];
        uint256 applicable = _applicable();
        uint256 last = p.lastUpdate;
        uint256 ts = p.totalShares;
        uint256 ta = totalAllocPoint;
        if (ts == 0 || ta == 0 || p.allocPoint == 0 || applicable <= last) return p.rps;
        return p.rps + (rate * p.allocPoint * (applicable - last) * PRECISION) / (ta * ts);
    }

    /// Reward a live position could harvest right now.
    function pending(bytes32 receipt) external view returns (uint256) {
        Position storage pos = positions[receipt];
        if (!pos.live) return 0;
        return (uint256(pos.shares) * (currentRps(pos.pid) - pos.entryRps)) / PRECISION;
    }

    /// The exact reward every live position could still claim, summed over pools and ROUNDED UP per pool so the pool's
    /// recover reservation can never fall short of a valid harvest. Reads stored `rps`: callers accrue first (`recover` does).
    function outstandingReward() public view returns (uint256 total) {
        uint256 n = _pools.length;
        for (uint256 i; i < n; ++i) {
            PoolInfo storage p = _pools[i];
            uint256 x = p.rps * p.totalShares - p.totalRewardDebt;
            total += (x + PRECISION - 1) / PRECISION;
        }
    }

    // ───────────────────────────── pool hooks (proof-driven) ─────────────────────────────

    /// Receipt bond (debtValue == 0) and harvest (debtValue > 0), the pool's sentinel `positionLeaf == 1`. `legs[0].value` is the
    /// receipt's shares; `rateSnapshot` carries the receipt leaf (the position key).
    function onCdpMint(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionLeaf, uint256 rateSnapshot)
        external
        onlyPool
    {
        if (positionLeaf == bytes32(0)) revert BarePayoutUnsupported();
        if (positionLeaf != RECEIPT) revert NotSupported(); // bare position locks belong to a plain lock vault, not a reward farm
        if (legs.length != 1 || legs[0].value == 0) revert BadFarmShape();
        bytes32 receipt = bytes32(rateSnapshot);
        if (receipt == bytes32(0)) revert BadFarmShape();
        uint256 shares = legs[0].value;

        if (debtValue == 0) {
            // BOND: the stake asset selects the pool; stamp the LIVE rps as the entry checkpoint (MasterChef rewardDebt).
            uint256 pidp = _pidPlusOne[legs[0].asset];
            if (pidp == 0) revert WrongStakeAsset();
            uint256 pid = pidp - 1;
            Position storage pos = positions[receipt];
            if (pos.live) revert PositionExists();
            if (shares > type(uint128).max) revert BadFarmShape();
            _accruePool(pid);
            PoolInfo storage p = _pools[pid];
            uint256 unlockAt = block.timestamp + p.lockDuration;
            pos.entryRps = p.rps;
            pos.shares = uint128(shares);
            pos.unlockAt = uint64(unlockAt);
            pos.pid = uint32(pid);
            pos.live = true;
            p.totalShares += shares;
            p.totalRewardDebt += shares * p.rps;
            emit Bonded(receipt, pid, shares, unlockAt);
        } else {
            // HARVEST: bound the reward to this position's own window, then re-stamp so a replay pays nothing.
            if (legs[0].asset != REWARD_ASSET) revert WrongRewardAsset();
            Position storage pos = positions[receipt];
            if (!pos.live) revert NoLivePosition();
            if (shares != pos.shares) revert BadFarmShape(); // the proof's shares must be the shares bonded
            uint256 pid = pos.pid;
            _accruePool(pid);
            PoolInfo storage p = _pools[pid];
            uint256 window = p.rps - pos.entryRps;
            if (debtValue * PRECISION > shares * window) revert OverClaim();
            p.totalRewardDebt += shares * window;
            pos.entryRps = p.rps;
            emit Harvested(receipt, pid, debtValue);
        }
    }

    /// Unbond: enforce THIS position's lock, retire its stamp and reward debt, release the stake. Un-harvested reward is
    /// forfeited to the recoverable surplus (the same semantics as the single-pool farm).
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
        bytes32 receipt = bytes32(rateSnapshot);
        Position storage pos = positions[receipt];
        if (!pos.live) revert NoLivePosition();
        if (block.timestamp < pos.unlockAt) revert Locked();
        uint256 pid = pos.pid;
        _accruePool(pid);
        PoolInfo storage p = _pools[pid];
        uint256 w;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].asset != p.stakeAsset) revert WrongStakeAsset();
            if (legs[i].value == 0) revert BadFarmShape();
            w += legs[i].value;
        }
        if (w == 0 || w != pos.shares) revert BadFarmShape();
        p.totalRewardDebt -= w * pos.entryRps;
        p.totalShares -= w;
        delete positions[receipt];
        emit Unbonded(receipt, pid, w);
    }

    function onCdpLiquidate(CdpLeg[] calldata, uint256, uint256, uint256, bytes32) external view onlyPool {
        revert NotSupported();
    }

    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, uint256, bytes32, bytes32) external view onlyPool {
        revert NotSupported();
    }
}
