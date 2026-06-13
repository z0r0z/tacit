// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @dev The reflection-attested live locked sats backing cBTC.tac (sum of live cBTC.zk vault outpoints),
///      surfaced by ConfidentialPool from BITCOIN_RELAY_VKEY-verified reflection state.
interface IPoolBacking {
    function cbtcBackingSats() external view returns (uint256);
}

interface IERC20Min {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Owner-set venue that swaps insurance capital -> cBTC.tac, delivered to `to`.
///         Concrete impl (a public-AMM adapter or a confidential-pool adapter) is wired at deploy.
interface IInsuranceRouter {
    /// @dev Acquire exactly `amountOut` cBTC.tac for `to`, spending at most `maxIn` of `capital`.
    function buyExactCbtc(address capital, address cbtcTac, uint256 amountOut, uint256 maxIn, address to, bytes calldata route)
        external
        returns (uint256 spent);
}

/// @title InsuranceVault
/// @notice Custody-insurance backstop for cBTC.tac. cBTC.tac's peg is trustless by construction — each
///         unit is a claim on real BTC locked in a cBTC.zk lock (conservation in the reflection's
///         `fold_cbtc_lock`). This vault covers only the residual §3 CUSTODY risk: if the vault key moves
///         locked sats without a matching cBTC.tac redemption, the reflection-attested backing drops below
///         the circulating supply, and anyone can call `coverShortfall` to buy the excess cBTC.tac off the
///         AMM with (TAC, tETH) capital and SEQUESTER it here — dropping circulating supply back to <=
///         backing. The shortfall is read from proven state, never asserted by the caller.
/// @dev Deliberately minimal (Solady `Ownable`): owner = deployer to start, `transferOwnership(dao)` later.
///      BOUNDED by construction — the owner sizes the buyback (caps + router) and manages backstop
///      *capital*, but can NEVER mint cBTC.tac, move the BTC backing, or break the peg. Worst case is an
///      under-funded or owner-drained *backstop*, never broken money. The core ConfidentialPool is
///      untouched (only its read-only `cbtcBackingSats()` view is consumed).
contract InsuranceVault is Ownable {
    IPoolBacking public immutable POOL;
    address public immutable CBTC_TAC; // the cBTC.tac canonical ERC20 (same unit as backing sats)
    address public immutable TAC; // insurance capital legs
    address public immutable TETH;

    // --- owner-governed knobs (owner = you -> DAO) ---
    IInsuranceRouter public router; // buyback venue
    uint256 public maxBuybackPerClaim; // ceiling on cBTC.tac bought per call (bounds repeated/spurious triggers)
    uint256 public maxCapitalPerClaim; // ceiling on capital spent per call (the per-claim slippage/grief bound)

    event RouterSet(address indexed router);
    event ParamsSet(uint256 maxBuybackPerClaim, uint256 maxCapitalPerClaim);
    event CapitalAdded(address indexed leg, uint256 amount, address indexed from);
    event CapitalWithdrawn(address indexed leg, uint256 amount, address indexed to);
    event ShortfallCovered(uint256 shortfall, uint256 bought, address indexed capital, uint256 spent);

    error BadLeg();
    error NoShortfall();
    error NoRouter();
    error Overspend();

    constructor(address pool, address cbtcTac, address tac, address teth, address admin) {
        POOL = IPoolBacking(pool);
        CBTC_TAC = cbtcTac;
        TAC = tac;
        TETH = teth;
        _initializeOwner(admin); // Solady: you to start; transferOwnership(dao) when ready
    }

    // ---------- capital: anyone funds; owner manages (bounded to capital, never the peg) ----------

    function addCapital(address leg, uint256 amount) external {
        if (leg != TAC && leg != TETH) revert BadLeg();
        SafeTransferLib.safeTransferFrom(leg, msg.sender, address(this), amount);
        emit CapitalAdded(leg, amount, msg.sender);
    }

    function withdrawCapital(address leg, uint256 amount, address to) external onlyOwner {
        if (leg != TAC && leg != TETH) revert BadLeg();
        SafeTransferLib.safeTransfer(leg, to, amount);
        emit CapitalWithdrawn(leg, amount, to);
    }

    // ---------- owner-governed sizing ----------

    function setRouter(address r) external onlyOwner {
        router = IInsuranceRouter(r);
        emit RouterSet(r);
    }

    function setParams(uint256 _maxBuybackPerClaim, uint256 _maxCapitalPerClaim) external onlyOwner {
        maxBuybackPerClaim = _maxBuybackPerClaim;
        maxCapitalPerClaim = _maxCapitalPerClaim;
        emit ParamsSet(_maxBuybackPerClaim, _maxCapitalPerClaim);
    }

    // ---------- the peg shortfall (proven, not asserted) ----------

    /// @notice Circulating cBTC.tac (totalSupply minus what this vault has sequestered) over the
    ///         reflection-attested live backing. > 0 only after a custody failure removed locked sats.
    function pegShortfall() public view returns (uint256) {
        uint256 backing = POOL.cbtcBackingSats();
        uint256 held = IERC20Min(CBTC_TAC).balanceOf(address(this));
        uint256 supply = IERC20Min(CBTC_TAC).totalSupply();
        uint256 circulating = supply > held ? supply - held : 0;
        return circulating > backing ? circulating - backing : 0;
    }

    // ---------- claim: permissionless, bounded buy-and-sequester ----------

    /// @notice Cover the proven shortfall: buy cBTC.tac off the AMM (via the owner-set router) with
    ///         insurance `capital` and SEQUESTER it here, restoring circulating supply <= backing.
    ///         Permissionless — the shortfall is reflection-attested, and the owner ceilings bound the
    ///         per-call buy + spend so a caller can't drain the backstop.
    function coverShortfall(address capital, bytes calldata route) external returns (uint256 bought, uint256 spent) {
        if (capital != TAC && capital != TETH) revert BadLeg();
        if (address(router) == address(0)) revert NoRouter();
        uint256 shortfall = pegShortfall();
        if (shortfall == 0) revert NoShortfall();

        bought = shortfall < maxBuybackPerClaim ? shortfall : maxBuybackPerClaim;
        uint256 maxIn = maxCapitalPerClaim;

        SafeTransferLib.safeApprove(capital, address(router), maxIn);
        spent = router.buyExactCbtc(capital, CBTC_TAC, bought, maxIn, address(this), route);
        SafeTransferLib.safeApprove(capital, address(router), 0);
        if (spent > maxIn) revert Overspend(); // defense-in-depth (router should honor maxIn)

        emit ShortfallCovered(shortfall, bought, capital, spent);
    }
}
