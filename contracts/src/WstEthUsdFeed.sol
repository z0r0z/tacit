// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IChainlinkFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IWstEth {
    /// @dev Lido's wstETH: internally `stETH.getPooledEthByShares(1e18)` — the protocol's own oracle-reported
    ///      pooled-ETH accounting, not a market price. Returns real ETH-per-wstETH directly, 18 decimals.
    function stEthPerToken() external view returns (uint256);
}

/// @notice AggregatorV3-shaped BTC-per-wstETH feed, composed entirely from open, ungated on-chain sources —
///         no Chainlink wstETH/USD, wstETH/ETH, stETH/USD, or stETH/ETH feed is usable here. Checked live:
///         wstETH/USD and wstETH/ETH aren't registered in Chainlink's Feed Registry at all, and the two
///         stETH-denominated feeds that ARE registered (stETH/USD `0x26f19680…`, stETH/ETH `0xC9c8Efa8…`)
///         are `AccessControlledOCR2Aggregator`s gated by `tx.origin == msg.sender` — they answer a bare
///         `cast call` (which sets both fields equal) but revert for any real contract-to-contract call,
///         forever. Verified via an actual forge fork test (a real STATICCALL), not just an RPC call.
///
///         Instead this composes from primitives that ARE genuinely open to any contract: wstETH's own
///         `stEthPerToken()` (ETH-per-wstETH, Lido's real pooled-ETH accounting — not a stETH:ETH market
///         peg assumption; the rebase mechanism itself keeps 1 stETH defined as 1 ETH of underlying claim)
///         times BTC-per-ETH derived from the canonical, universally-open `ETH/USD` and `BTC/USD` Chainlink
///         feeds (the same two feeds `ChainlinkEthBtcAdapter` already uses for the analogous native-ETH case).
///         Output decimals = 8 (Chainlink USD convention). Fail-closed: reverts on a non-positive or
///         carried-over underlying round, or a zero exchange rate. View-only, immutable sources — nothing
///         here is governable.
contract WstEthUsdFeed {
    IWstEth public immutable WSTETH;
    IChainlinkFeed public immutable ETH_USD;
    IChainlinkFeed public immutable BTC_USD;
    uint8 public immutable ETH_USD_DEC;
    uint8 public immutable BTC_USD_DEC;
    uint8 public constant decimals = 8;

    error BadFeed();
    error StaleRound();

    constructor(address wstEth, address ethUsd, address btcUsd) {
        if (wstEth == address(0) || ethUsd == address(0) || btcUsd == address(0)) revert BadFeed();
        WSTETH = IWstEth(wstEth);
        ETH_USD = IChainlinkFeed(ethUsd);
        BTC_USD = IChainlinkFeed(btcUsd);
        uint8 de = IChainlinkFeed(ethUsd).decimals();
        uint8 db = IChainlinkFeed(btcUsd).decimals();
        if (de == 0 || de > 18 || db == 0 || db > 18) revert BadFeed();
        ETH_USD_DEC = de;
        BTC_USD_DEC = db;
        if (IWstEth(wstEth).stEthPerToken() == 0) revert BadFeed();
    }

    /// @dev Returns BTC per 1 wstETH, 8 decimals, in `answer`.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint80 rE, int256 aE,, uint256 uE, uint80 arE) = ETH_USD.latestRoundData();
        (uint80 rB, int256 aB,, uint256 uB, uint80 arB) = BTC_USD.latestRoundData();
        if (aE <= 0 || aB <= 0) revert BadFeed();
        if (arE < rE || arB < rB) revert StaleRound(); // a carried-over (incomplete) source round
        uint256 ethPerWsteth = WSTETH.stEthPerToken(); // 18 decimals
        if (ethPerWsteth == 0) revert BadFeed();
        // BTC per wstETH (8 dec) = (BTC per ETH, 8 dec) · ethPerWsteth / 1e18
        //                        = [aE · 10^(db+8) / (aB · 10^de)] · ethPerWsteth / 1e18
        uint256 btcPerEthNum = uint256(aE) * (10 ** (uint256(BTC_USD_DEC) + 8));
        uint256 btcPerEthDen = uint256(aB) * (10 ** uint256(ETH_USD_DEC));
        answer = int256((btcPerEthNum * ethPerWsteth) / (btcPerEthDen * 1e18));
        updatedAt = uE < uB ? uE : uB; // oldest of the two → engine staleness gates both
        startedAt = updatedAt;
        roundId = rE < rB ? rE : rB;
        answeredInRound = roundId; // == roundId ⇒ passes the engine's carried-over check on this synthetic round
    }
}
