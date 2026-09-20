// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IWrappedTacLike {
    function TAC() external view returns (address);
    function deposit(uint256 amount, address to) external;
}

interface IFarmPoolLike {
    function farmEscrow(address controller, bytes32 rewardAsset, uint256 amount, address to) external returns (uint256);
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

/// @title TacFarmFunder — fund a wTAC-reward farm from plain public TAC in ONE transaction
/// @notice Without this the funder does: approve TAC, wrap to wTAC, approve wTAC, `farmEscrow` (four transactions). Here the
///         caller approves (or signs an EIP-2612 permit for) TAC once and calls `fund`; the helper wraps and escrows in the
///         same call. `notifyRewardAmount` stays a separate call by the farm's governor, because only the governor may set the rate.
/// @dev Holds no funds between calls, has no owner and no admin, and never keeps an allowance: every approval is for exactly
///      the amount spent in the same call. Funding is bound to the farm's own reward asset by the pool (a controller whose
///      REWARD_ASSET differs is rejected), so a caller can only ever fund a farm with their own tokens.
contract TacFarmFunder {
    address public immutable TAC;
    address public immutable WTAC;
    address public immutable POOL;
    bytes32 public immutable WTAC_ASSET_ID;
    /// Underlying base units per in-system value unit for wTAC (the pool's derived scale); amounts must be a multiple of it.
    uint256 public immutable UNIT_SCALE;

    error Misaligned();
    error WrongAsset();
    error Leftover();

    event Funded(address indexed funder, address indexed controller, uint256 amount);

    constructor(address wtac, address pool, bytes32 wtacAssetId) {
        TAC = IWrappedTacLike(wtac).TAC();
        WTAC = wtac;
        POOL = pool;
        WTAC_ASSET_ID = wtacAssetId;
        (bool registered, address underlying, uint256 scale,, bool poolMinted,) = IFarmPoolLike(pool).assets(wtacAssetId);
        if (!registered || poolMinted || underlying != wtac) revert WrongAsset();
        UNIT_SCALE = scale;
    }

    /// Fund `controller` with `amount` of the caller's TAC (approve this contract for TAC first).
    function fund(address controller, uint256 amount) public {
        if (amount == 0 || amount % UNIT_SCALE != 0) revert Misaligned();
        SafeTransferLib.safeTransferFrom(TAC, msg.sender, address(this), amount);
        SafeTransferLib.safeApprove(TAC, WTAC, amount);
        IWrappedTacLike(WTAC).deposit(amount, address(this));
        SafeTransferLib.safeApprove(WTAC, POOL, amount);
        IFarmPoolLike(POOL).farmEscrow(controller, WTAC_ASSET_ID, amount, address(0));
        if (ERC20(WTAC).balanceOf(address(this)) != 0 || ERC20(TAC).balanceOf(address(this)) != 0) revert Leftover();
        emit Funded(msg.sender, controller, amount);
    }

    /// Same, with an EIP-2612 permit for TAC so the caller needs no separate approval transaction.
    function fundWithPermit(address controller, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        // A front-run permit only burns the nonce; if the allowance is already there the funding can still proceed.
        try ERC20(TAC).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        fund(controller, amount);
    }
}
