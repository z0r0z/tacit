// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title WrappedTac — a 1:1 wrapper of the canonical TAC ERC20
/// @notice The confidential pool's escrow farms cannot pay in canonical TAC (it is pool-minted, and the pool refuses to
///         register it a second time as an escrow asset). This wrapper is an ordinary escrow-able ERC20 that is always
///         redeemable one-for-one for TAC, so a farm can pay wTAC and a staker still ends with public TAC:
///         harvest -> unwrap to public wTAC -> `withdraw` -> TAC.
/// @dev No owner, no upgrade path, no fees, no hooks, no admin mint. `deposit` mints exactly what it received (a token that
///      delivers less than requested reverts, so the backing can never fall below the supply); `withdraw` burns before it
///      pays. Anything sent straight to this contract is not redeemable by anyone; it only makes the backing exceed the supply.
contract WrappedTac is ERC20 {
    address public immutable TAC;

    error ZeroAddress();
    error ZeroAmount();
    error ShortDelivery();

    event Deposit(address indexed from, address indexed to, uint256 amount);
    event Withdraw(address indexed from, address indexed to, uint256 amount);

    constructor(address tac) {
        if (tac == address(0)) revert ZeroAddress();
        TAC = tac;
    }

    function name() public pure override returns (string memory) {
        return "Wrapped TAC";
    }

    function symbol() public pure override returns (string memory) {
        return "wTAC";
    }

    /// TAC has 18 decimals, so wTAC does too and the wrapper is exactly 1:1 in base units.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// Pull `amount` TAC from the caller and mint the same amount of wTAC to `to`.
    function deposit(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 before = ERC20(TAC).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(TAC, msg.sender, address(this), amount);
        if (ERC20(TAC).balanceOf(address(this)) - before != amount) revert ShortDelivery();
        _mint(to, amount);
        emit Deposit(msg.sender, to, amount);
    }

    /// Burn `amount` of the caller's wTAC and send the same amount of TAC to `to`.
    function withdraw(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        _burn(msg.sender, amount);
        SafeTransferLib.safeTransfer(TAC, to, amount);
        emit Withdraw(msg.sender, to, amount);
    }
}
