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

/// @notice Injected BTC valuer: the BTC-equivalent (in cBTC.tac base units / sats) of `amount` of `token`.
///         A concrete adapter prices tETH via a Chainlink ETH/BTC quorum and TAC via a shielded-pool
///         AMM-TWAP — never a hot key. MUST be fail-closed: revert on an unpriceable token or a stale/bad
///         feed, so a broken oracle only blanks the backstop's BTC valuation, never the cBTC.tac peg.
interface IBtcValuer {
    function btcValueSats(address token, uint256 amount) external view returns (uint256);
}

/// @title InsuranceVault
/// @notice Custody-insurance backstop for cBTC.tac. cBTC.tac's peg is trustless by construction — each unit
///         is a claim on real BTC locked in a cBTC.zk lock (conservation in the reflection's
///         `fold_cbtc_lock`). This vault covers only the residual custody risk: if the lock is spent without
///         a matching cBTC.tac redemption, the reflection-attested backing drops below the circulating
///         supply. It is a PASSIVE (TAC, tETH) reserve: TAC and cBTC.tac are Tacit-native and trade only in
///         the confidential (async, proof-settled) AMM, so there is no synchronous on-chain DEX to buy back
///         into. Instead the reserve's BTC-equivalent value (via an injected, fail-closed `IBtcValuer`)
///         counts toward backing — `uncoveredShortfall` is the true peg-solvency signal — and the actual
///         conversion to cover a redemption runs through the existing ASYNC redemption path, never an
///         on-chain buyback here. Capital is released to honor a redemption by the owner/DAO (or, later, an
///         authorized redemption module).
/// @dev Deliberately minimal (Solady `Ownable`): owner = deployer to start, `transferOwnership(dao)` later.
///      BOUNDED by construction — the owner sizes the valuer + manages backstop *capital*, but can NEVER
///      mint cBTC.tac, move the BTC backing, or break the peg. Worst case is an under-funded or owner-drained
///      *backstop*, never broken money. The core ConfidentialPool is untouched (only its read-only
///      `cbtcBackingSats()` view is consumed).
contract InsuranceVault is Ownable {
    IPoolBacking public immutable POOL;
    address public immutable CBTC_TAC; // the cBTC.tac canonical ERC20 (same unit as backing sats)
    address public immutable TAC; // insurance capital legs
    address public immutable TETH;

    // --- owner-governed (owner = you -> DAO) ---
    IBtcValuer public valuer; // prices the (TAC, tETH) reserve in BTC sats; fail-closed

    event ValuerSet(address indexed valuer);
    event CapitalAdded(address indexed leg, uint256 amount, address indexed from);
    event CapitalWithdrawn(address indexed leg, uint256 amount, address indexed to);

    error BadLeg();
    error NoValuer();

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

    /// @notice Release capital from the reserve — owner/DAO only. This is how the backstop funds a
    ///         redemption shortfall (the conversion runs through the async redemption path, not here), and
    ///         how surplus is recovered. Never mints cBTC.tac or touches the BTC backing.
    function withdrawCapital(address leg, uint256 amount, address to) external onlyOwner {
        if (leg != TAC && leg != TETH) revert BadLeg();
        SafeTransferLib.safeTransfer(leg, to, amount);
        emit CapitalWithdrawn(leg, amount, to);
    }

    // ---------- owner-governed sizing ----------

    function setValuer(address v) external onlyOwner {
        valuer = IBtcValuer(v);
        emit ValuerSet(v);
    }

    // ---------- the peg shortfall (proven, not asserted) ----------

    /// @notice Circulating cBTC.tac (totalSupply minus what this vault holds) over the reflection-attested
    ///         live backing. > 0 only after a custody failure removed locked sats.
    function pegShortfall() public view returns (uint256) {
        uint256 backing = POOL.cbtcBackingSats();
        uint256 held = IERC20Min(CBTC_TAC).balanceOf(address(this));
        uint256 supply = IERC20Min(CBTC_TAC).totalSupply();
        uint256 circulating = supply > held ? supply - held : 0;
        return circulating > backing ? circulating - backing : 0;
    }

    // ---------- passive solvency view (the reserve's contribution to backing) ----------

    /// @notice The (TAC, tETH) reserve expressed as BTC-equivalent sats via the injected valuer. This is
    ///         what the backstop adds to cBTC.tac's backing. Reverts (fail-closed) with no valuer set or if
    ///         the valuer cannot price a leg.
    function backstopBtcValueSats() public view returns (uint256) {
        if (address(valuer) == address(0)) revert NoValuer();
        uint256 tacVal = valuer.btcValueSats(TAC, IERC20Min(TAC).balanceOf(address(this)));
        uint256 tethVal = valuer.btcValueSats(TETH, IERC20Min(TETH).balanceOf(address(this)));
        return tacVal + tethVal;
    }

    /// @notice The residual under-collateralization after the backstop: real-BTC shortfall minus the
    ///         reserve's BTC value. 0 means circulating cBTC.tac is fully covered by real locks + the
    ///         reserve. A non-zero value is the true peg-solvency signal (a custody loss the backstop can't
    ///         fully absorb).
    function uncoveredShortfall() external view returns (uint256) {
        uint256 shortfall = pegShortfall();
        if (shortfall == 0) return 0;
        uint256 cover = backstopBtcValueSats();
        return shortfall > cover ? shortfall - cover : 0;
    }
}
