// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IVanityShop {
    function buy(uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline) external;
}

/// @title ShopZap: pays for a VanityShop address with ETH, in one transaction
/// @notice A buyer who holds ETH and no TAC sends the ETH here with zRouter's own calldata for a swap into TAC (the legs the TAC tile builds, with this contract as the
///         buyer and the one the TAC is paid to). When the swap is done this contract buys the address with that TAC, the token going to the address the buyer names,
///         and sends back whatever is left: TAC the swap paid beyond the price, and any ETH the router did not use. Nothing is ever kept here, and there is no owner,
///         no setting and nothing to approve: it holds nothing between transactions and takes no token from anyone. It calls the router and the shop it was built with,
///         TAC, and the buyer it pays back. If the swap pays less than the price, or the shop refuses the purchase, everything reverts and the buyer keeps the ETH.
///         Send nothing here except through `buyWithEth`: whatever sits here when a purchase ends goes back to whoever made that purchase.
/// @dev    It has no fallback and answers no ERC-1271 call, and must stay that way: TAC gives Permit2 an unlimited allowance on every address, so a contract that held TAC and
///         approved signatures it should not would be emptied by one bad signature.
contract ShopZap {
    using SafeTransferLib for address;

    address public immutable ZROUTER;
    address public immutable TAC;
    address public immutable SHOP;

    /// The token would be minted to this contract or to the router, neither of which has a way to move it.
    error BadRecipient();

    /// Payable on purpose. The market's deploy hands the whole balance of the contract's deploy address to its constructor, and anyone can put a wei there beforehand: a
    /// constructor that refuses ETH would then never deploy. Whatever arrives that way is paid back to the first buyer, like anything else left here.
    constructor(address zrouter, address tac, address shop) payable {
        ZROUTER = zrouter;
        TAC = tac;
        SHOP = shop;
    }

    /// The router sends back ETH it did not use.
    receive() external payable {}

    /// `swapData` is the call to the router that turns the ETH sent here into at least `maxPrice` of TAC for this contract; `id`, `to`, `nonce` and `maxPrice` are the
    /// purchase as the shop takes it (the nonce the buyer was shown, the most they will pay), and `deadline` its last moment.
    function buyWithEth(bytes calldata swapData, uint256 id, address to, uint8 nonce, uint256 maxPrice, uint256 deadline) external payable {
        if (to == address(this) || to == ZROUTER) revert BadRecipient();
        (bool ok, bytes memory ret) = ZROUTER.call{value: msg.value}(swapData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        TAC.safeApprove(SHOP, maxPrice);
        IVanityShop(SHOP).buy(id, to, nonce, maxPrice, deadline);
        TAC.safeApprove(SHOP, 0);
        uint256 left = TAC.balanceOf(address(this));
        if (left != 0) TAC.safeTransfer(msg.sender, left);
        left = address(this).balance;
        if (left != 0) msg.sender.safeTransferETH(left);
    }
}
