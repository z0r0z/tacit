// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CanonicalAssetFactory} from "./CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "./CanonicalBridgedERC20.sol";

/// @title CanonicalMinter
/// @notice Base for supply-policy minters of a canonical EVM-etch token. In ONE deploy it etches an
///         EVM-native canonical asset (the self-certifying id) and becomes that token's sole mint/burn
///         authority; a subclass supplies the policy. The token (`CanonicalBridgedERC20`) stays
///         deliberately dumb — the policy lives here, in its immutable `MINTER`.
///
///         The token address is `f(assetId, address(this), metadata)`, i.e.
///         `factory.predict(ASSET_ID, address(thisMinter), symbol, decimals, cid)`.
///
///         SAFETY — these helpers can never make a bridged Bitcoin-native asset mintable. They only
///         `etchCanonical` a FRESH EVM-native id (`deriveAssetId`, namespaced by the EVM etch tag +
///         chainid + factory), which is disjoint from a Bitcoin asset's id — so a helper cannot target a
///         Bitcoin asset at all. And a bridged asset's ERC20 must have the pool/bridge as its `MINTER`
///         (the pool backs only tokens it itself mints, minting solely against proof), so a free-mintable
///         minter can never be a bridged asset's authority. A Bitcoin-etch / wrapped id uses the
///         `deployCanonical` path with the bridge/pool as minter, never these standalone helpers.
abstract contract CanonicalMinter {
    CanonicalBridgedERC20 public immutable TOKEN;
    bytes32 public immutable ASSET_ID;

    constructor(
        CanonicalAssetFactory factory,
        address etcher,
        bytes32 salt,
        string memory symbol_,
        uint8 decimals_,
        bytes32 cid
    ) {
        (bytes32 assetId, address token) = factory.etchCanonical(etcher, salt, address(this), symbol_, decimals_, cid);
        ASSET_ID = assetId;
        TOKEN = CanonicalBridgedERC20(token);
    }
}

/// @title FixedSupplyMinter
/// @notice Fixed-supply EVM etch — the `T_CETCH` analog. Mints the entire `totalSupply` to `recipient`
///         in its constructor, then is INERT forever: it exposes no mint, no burn, no admin. The token's
///         only `MINTER` can provably never act again, so the supply is immutably fixed. Maximally
///         trustless — a deploy-and-die minter with no further surface.
contract FixedSupplyMinter is CanonicalMinter {
    constructor(
        CanonicalAssetFactory factory,
        address etcher,
        bytes32 salt,
        string memory symbol_,
        uint8 decimals_,
        bytes32 cid,
        uint256 totalSupply,
        address recipient
    ) CanonicalMinter(factory, etcher, salt, symbol_, decimals_, cid) {
        TOKEN.mint(recipient, totalSupply);
    }
}

/// @title CappedMintMinter
/// @notice Mintable + burnable EVM etch — the `T_PETCH` analog. `mintAuthority` may mint up to `cap`
///         (0 = uncapped) until `mintDeadline` (0 = open forever); any holder may burn its own balance
///         (deflationary). `cap` is a LIFETIME mint ceiling — burns never reopen room — i.e. standard
///         "max supply" semantics. No owner, no pause, no authority transfer: every term is immutable.
contract CappedMintMinter is CanonicalMinter {
    address public immutable MINT_AUTHORITY;
    uint256 public immutable CAP;          // 0 = uncapped
    uint64 public immutable MINT_DEADLINE; // 0 = open forever
    uint256 public minted;                 // lifetime minted; monotone (burns do not decrease it)

    error NotAuthority();
    error CapExceeded();
    error MintClosed();

    event Minted(address indexed to, uint256 amount, uint256 minted);
    event Burned(address indexed from, uint256 amount);

    constructor(
        CanonicalAssetFactory factory,
        address etcher,
        bytes32 salt,
        string memory symbol_,
        uint8 decimals_,
        bytes32 cid,
        address mintAuthority,
        uint256 cap,
        uint64 mintDeadline
    ) CanonicalMinter(factory, etcher, salt, symbol_, decimals_, cid) {
        MINT_AUTHORITY = mintAuthority;
        CAP = cap;
        MINT_DEADLINE = mintDeadline;
    }

    /// @notice Mint up to the lifetime cap, before the deadline. Authority-only.
    function mint(address to, uint256 amount) external {
        if (msg.sender != MINT_AUTHORITY) revert NotAuthority();
        if (MINT_DEADLINE != 0 && block.timestamp > MINT_DEADLINE) revert MintClosed();
        uint256 m = minted + amount;
        if (CAP != 0 && m > CAP) revert CapExceeded();
        minted = m;
        TOKEN.mint(to, amount);
        emit Minted(to, amount, m);
    }

    /// @notice Burn your own balance (deflationary). The lifetime cap is unaffected.
    function burn(uint256 amount) external {
        TOKEN.burn(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }

    /// @notice Remaining mintable headroom (`type(uint256).max` when uncapped).
    function remaining() external view returns (uint256) {
        return CAP == 0 ? type(uint256).max : CAP - minted;
    }
}
