// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IChainlinkFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice AggregatorV3-shaped adapter exposing ETH/BTC (BTC per 1 ETH) = ETH/USD ÷ BTC/USD.
///         Wired as the CollateralEngine's `ethBtcFeed` so:
///           • both engine feeds (this + BTC/USD direct) ride the liquid USD feeds' ~1h heartbeat — a single
///             tight `maxStaleness` covers cBTC escrow pricing AND the BTC/USD-load-bearing cUSD peg, instead
///             of pairing the fast BTC/USD feed with a slow (~24h) native ETH/BTC pair, and
///           • networks with no native ETH/BTC feed (e.g. Sepolia) still get a sound ETH/BTC mark.
///         Output decimals = 8 (Chainlink USD convention). Fail-closed: reverts on a non-positive or
///         carried-over underlying round; returns the OLDER `updatedAt` so the engine's single staleness
///         check covers both source feeds. View-only, immutable sources — nothing here is governable.
contract ChainlinkEthBtcAdapter {
    IChainlinkFeed public immutable ETH_USD;
    IChainlinkFeed public immutable BTC_USD;
    uint8 public immutable ETH_USD_DEC;
    uint8 public immutable BTC_USD_DEC;
    uint8 public constant decimals = 8;

    error BadFeed();
    error StaleRound();

    constructor(address ethUsd, address btcUsd) {
        if (ethUsd == address(0) || btcUsd == address(0)) revert BadFeed();
        ETH_USD = IChainlinkFeed(ethUsd);
        BTC_USD = IChainlinkFeed(btcUsd);
        uint8 de = IChainlinkFeed(ethUsd).decimals();
        uint8 db = IChainlinkFeed(btcUsd).decimals();
        if (de == 0 || de > 18 || db == 0 || db > 18) revert BadFeed();
        ETH_USD_DEC = de;
        BTC_USD_DEC = db;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint80 rE, int256 aE,, uint256 uE, uint80 arE) = ETH_USD.latestRoundData();
        (uint80 rB, int256 aB,, uint256 uB, uint80 arB) = BTC_USD.latestRoundData();
        if (aE <= 0 || aB <= 0) revert BadFeed();
        if (arE < rE || arB < rB) revert StaleRound(); // a carried-over (incomplete) source round
        // BTC per ETH at 8 dec = (aE / 10^de) / (aB / 10^db) · 10^8 = aE · 10^(db+8) / (aB · 10^de)
        uint256 num = uint256(aE) * (10 ** (uint256(BTC_USD_DEC) + 8));
        answer = int256(num / (uint256(aB) * (10 ** uint256(ETH_USD_DEC))));
        updatedAt = uE < uB ? uE : uB; // oldest of the two → engine staleness gates both
        startedAt = updatedAt;
        roundId = rE < rB ? rE : rB;
        answeredInRound = roundId; // == roundId ⇒ passes the engine's carried-over check on this synthetic round
    }
}
