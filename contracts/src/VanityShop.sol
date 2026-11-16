// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// The vanity-address market (VanityMarket): a salt is a 256-bit id whose top 160 bits name its owner, and the owner turns it into an
/// ERC-721 that deploys any contract to the address the id fixes, on any chain the market is on.
interface IVanityMarket {
    function mint(address to, uint256 id, uint8 nonce) external;
    function getTokenData(uint256 id) external view returns (bool minted, uint8 nonce);
    function computeAddress(bytes32 salt, uint8 nonce) external view returns (address);
}

interface IPermit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @title VanityShop: sells vanity-address tokens for TAC
/// @notice The salts the community pool grinds carry this contract's address in their top 160 bits, so this contract is the only account that can turn
///         them into tokens. The owner lists the ones to sell at a price in TAC each; the best are kept back (`keep`) and never listed. A buyer pays the
///         listed price and the token is minted to the address they name in the same transaction, so a sale is atomic and the shop holds nothing: the TAC
///         goes straight to the treasury and the token straight to the buyer. The buyer then owns an ordinary vanity-address token: it can be traded
///         anywhere, or burned in `VanityMarket.deploy` to put any contract at the address.
///
///         A listing fixes the id's nonce (which of the id's addresses the token stands for) and a price, nothing else; the vanity address it buys is in the
///         `Listed` event and `VanityMarket.computeAddress(id, nonce)`. A listing is for one sale: a purchase removes it. The price is the owner's to set and
///         change, so `buy` takes the most the buyer will pay and refuses a listing that has moved above it.
contract VanityShop is Ownable {
    using SafeTransferLib for address;

    struct Listing {
        uint128 price; // TAC, 18 decimals; 0 = not for sale
        uint8 nonce;
    }

    struct Item {
        uint256 id;
        uint128 price;
        uint8 nonce;
    }

    IVanityMarket public immutable MARKET;
    address public immutable TAC;
    address public treasury;

    mapping(uint256 id => Listing) public listings;

    error NotThisShopsSalt();
    error AlreadyMinted();
    error BadListing();
    error NotListed();
    error PriceAboveMax();
    error BadTreasury();

    event Listed(uint256 indexed id, address indexed vanity, uint8 nonce, uint128 price);
    event Unlisted(uint256 indexed id);
    event Sold(uint256 indexed id, address indexed to, address indexed buyer, uint128 price);
    event Kept(uint256 indexed id, address indexed to, uint8 nonce);
    event TreasurySet(address treasury);

    constructor(address owner_, address market, address tac, address treasury_) {
        if (treasury_ == address(0)) revert BadTreasury();
        _initializeOwner(owner_);
        MARKET = IVanityMarket(market);
        TAC = tac;
        treasury = treasury_;
    }

    // ---- owner ----

    /// Puts ids up for sale, or changes the price or nonce of ones already listed. An id must be one of this shop's (its top 160 bits are this contract)
    /// and not yet a token. The highest nonce a market address can have is 254.
    function list(Item[] calldata items) external onlyOwner {
        for (uint256 i; i < items.length; ++i) {
            Item calldata it = items[i];
            if (it.price == 0 || it.nonce == type(uint8).max) revert BadListing();
            _check(it.id);
            listings[it.id] = Listing(it.price, it.nonce);
            emit Listed(it.id, MARKET.computeAddress(bytes32(it.id), it.nonce), it.nonce, it.price);
        }
    }

    function unlist(uint256[] calldata ids) external onlyOwner {
        for (uint256 i; i < ids.length; ++i) {
            delete listings[ids[i]];
            emit Unlisted(ids[i]);
        }
    }

    /// Mints an id's token to `to` without a sale (the ones kept back): any id of this shop's, listed or not.
    function keep(uint256 id, uint8 nonce, address to) external onlyOwner {
        _check(id);
        delete listings[id];
        MARKET.mint(to, id, nonce);
        emit Kept(id, to, nonce);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert BadTreasury();
        emit TreasurySet(treasury = treasury_);
    }

    // ---- buyers ----

    /// Buys a listed id: TAC from the caller (who has approved this shop) to the treasury, the token to `to`.
    function buy(uint256 id, address to, uint256 maxPrice) external {
        _buy(id, to, maxPrice);
    }

    /// The same with TAC's EIP-2612 permit (for `maxPrice`) in one transaction. A permit someone else already used is not an error while the allowance stands.
    function buyWithPermit(uint256 id, address to, uint256 maxPrice, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IPermit(TAC).permit(msg.sender, address(this), maxPrice, deadline, v, r, s) {} catch {}
        _buy(id, to, maxPrice);
    }

    function _buy(uint256 id, address to, uint256 maxPrice) internal {
        Listing memory l = listings[id];
        if (l.price == 0) revert NotListed();
        if (l.price > maxPrice) revert PriceAboveMax();
        delete listings[id];
        TAC.safeTransferFrom(msg.sender, treasury, l.price);
        MARKET.mint(to, id, l.nonce);
        emit Sold(id, to, msg.sender, l.price);
    }

    function _check(uint256 id) internal view {
        if (address(uint160(id >> 96)) != address(this)) revert NotThisShopsSalt();
        (bool minted,) = MARKET.getTokenData(id);
        if (minted) revert AlreadyMinted();
    }
}
