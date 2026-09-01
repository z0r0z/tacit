// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IChainlinkFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice AggregatorV3-shaped adapter exposing wstETH/BTC (BTC per 1 wstETH) = wstETH/USD ÷ BTC/USD, both
///         canonical Chainlink feeds (wstETH/USD already prices in the stETH:wstETH exchange rate — Chainlink's
///         feed, not an on-contract read of Lido's `stEthPerToken()`, so this composes exactly like the
///         existing `ChainlinkEthBtcAdapter` (ETH/USD ÷ BTC/USD) with no extra on-chain rate source to trust).
///         Wired as the CollateralEngine's `wstEthBtcFeed`. Output decimals = 8 (Chainlink USD convention).
///         Fail-closed: reverts on a non-positive or carried-over underlying round; returns the OLDER
///         `updatedAt` so the engine's single staleness check covers both source feeds. View-only, immutable
///         sources — nothing here is governable.
contract ChainlinkWstEthBtcAdapter {
    IChainlinkFeed public immutable WSTETH_USD;
    IChainlinkFeed public immutable BTC_USD;
    uint8 public immutable WSTETH_USD_DEC;
    uint8 public immutable BTC_USD_DEC;
    uint8 public constant decimals = 8;

    error BadFeed();
    error StaleRound();

    constructor(address wstEthUsd, address btcUsd) {
        if (wstEthUsd == address(0) || btcUsd == address(0)) revert BadFeed();
        WSTETH_USD = IChainlinkFeed(wstEthUsd);
        BTC_USD = IChainlinkFeed(btcUsd);
        uint8 dw = IChainlinkFeed(wstEthUsd).decimals();
        uint8 db = IChainlinkFeed(btcUsd).decimals();
        if (dw == 0 || dw > 18 || db == 0 || db > 18) revert BadFeed();
        WSTETH_USD_DEC = dw;
        BTC_USD_DEC = db;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint80 rW, int256 aW,, uint256 uW, uint80 arW) = WSTETH_USD.latestRoundData();
        (uint80 rB, int256 aB,, uint256 uB, uint80 arB) = BTC_USD.latestRoundData();
        if (aW <= 0 || aB <= 0) revert BadFeed();
        if (arW < rW || arB < rB) revert StaleRound(); // a carried-over (incomplete) source round
        // BTC per wstETH at 8 dec = (aW / 10^dw) / (aB / 10^db) · 10^8 = aW · 10^(db+8) / (aB · 10^dw)
        uint256 num = uint256(aW) * (10 ** (uint256(BTC_USD_DEC) + 8));
        answer = int256(num / (uint256(aB) * (10 ** uint256(WSTETH_USD_DEC))));
        updatedAt = uW < uB ? uW : uB; // oldest of the two → engine staleness gates both
        startedAt = updatedAt;
        roundId = rW < rB ? rW : rB;
        answeredInRound = roundId; // == roundId ⇒ passes the engine's carried-over check on this synthetic round
    }
}
