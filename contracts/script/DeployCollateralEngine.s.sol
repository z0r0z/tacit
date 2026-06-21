// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {ChainlinkEthBtcAdapter} from "../src/ChainlinkEthBtcAdapter.sol";

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

/// @notice Deploy the CollateralEngine — the cBTC native-ETH escrow gate + the cUSD CDP controller
///         (cBTC-collateralized, Chainlink-priced) — with per-network feeds + market-standard risk params.
///
///  Oracle: the engine wants ETH/BTC (BTC per ETH) + BTC/USD. We derive ETH/BTC from the two liquid USD
///  feeds via ChainlinkEthBtcAdapter (ETH/USD ÷ BTC/USD) so both engine feeds share a ~1h heartbeat and
///  Sepolia (no native ETH/BTC) still works. BTC/USD is used directly (the cUSD peg, load-bearing).
///
///  Risk params (market-standard, MakerDAO/Aave-ish for BTC collateral):
///    • escrowRatioBps 15000 (1.5×)  — cBTC self-custody native-ETH escrow over-collateralization
///    • cdpRatioBps    15000 (1.5×)  — cUSD mint floor (DAI-like)
///    • liqRatioBps    13000 (1.3×)  — cUSD liquidation threshold (< mint floor)
///    • maxDeviationBps 0            — single-source Chainlink at launch (enable once a tacUSD/tacBTC pool deepens)
///
///  Ownership: deployed with the broadcaster as initial owner so this script can configure it, then
///  transferred to ENGINE_ADMIN (a DAO/multisig on mainnet; defaults to the broadcaster on testnet).
///
///  Flow (engine↔pool circular dep — the pool's engine pointer is immutable, so the engine deploys first):
///    1. forge script script/DeployCollateralEngine.s.sol --rpc-url $RPC --private-key $PK --broadcast
///    2. COLLATERAL_ENGINE=<engine> CANONICAL_FACTORY=<factory> forge script script/DeployConfidentialPool...
///       (the pool constructor deploy-or-adopts tacBTC + tacUSD and pins their ids)
///    3. engine.setPool(<pool>)   — called by the owner (ENGINE_ADMIN)
contract DeployCollateralEngine is Script {
    // cBTC.zk canonical id (must equal CollateralEngine.CANONICAL_CBTC_ASSET_ID; the ctor enforces it).
    bytes32 constant CANONICAL_CBTC_ASSET_ID =
        0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;

    // Market params (bps). cUSD liquidation sits below the mint floor; cBTC escrow ≥ 100% of locked value.
    uint256 constant ESCROW_RATIO_BPS = 15000;
    uint256 constant CDP_RATIO_BPS = 15000;
    uint256 constant LIQ_RATIO_BPS = 13000;

    struct NetCfg {
        address ethUsd;
        address btcUsd;
        uint256 maxStaleness;
        string name;
    }

    function _cfg() internal view returns (NetCfg memory c) {
        if (block.chainid == 1) {
            // Ethereum mainnet Chainlink feeds (8-dec).
            c.ethUsd = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419; // ETH/USD
            c.btcUsd = 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c; // BTC/USD
            c.maxStaleness = 3900; // ~65 min (feeds heartbeat ~1h + grace)
            c.name = "mainnet";
        } else if (block.chainid == 11155111) {
            // Sepolia Chainlink feeds (8-dec).
            c.ethUsd = 0x694AA1769357215DE4FAC081bf1f309aDC325306; // ETH/USD
            c.btcUsd = 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43; // BTC/USD
            c.maxStaleness = 86400; // testnet feeds update erratically — wide staleness so tests don't fail-closed
            c.name = "sepolia";
        } else {
            revert("DeployCollateralEngine: unsupported chainid (expect 1 or 11155111)");
        }
    }

    function run() external {
        NetCfg memory c = _cfg();
        address admin = vm.envOr("ENGINE_ADMIN", msg.sender);
        require(admin != address(0), "ENGINE_ADMIN is zero");

        // Fail-closed against a wrong/stale feed address BEFORE we deploy anything against it.
        _assertFeedSane(c.btcUsd, 10_000, 500_000, "BTC/USD"); // $10k–$500k
        _assertFeedSane(c.ethUsd, 100, 100_000, "ETH/USD"); //   $100–$100k

        vm.startBroadcast();
        ChainlinkEthBtcAdapter adapter = new ChainlinkEthBtcAdapter(c.ethUsd, c.btcUsd);
        // pool=0 (wired post-pool via setPool). cBTC id canonical; cBTC + cUSD base precision = 8 (sats /
        // cents-of-a-dollar) → unitScale 10^10 onto the pool's 18-dec tacBTC/tacUSD ERC20s.
        CollateralEngine engine = new CollateralEngine(address(0), CANONICAL_CBTC_ASSET_ID, 8, 8, msg.sender);
        engine.setFeeds(address(adapter), c.btcUsd, address(0), address(0));
        engine.setParams(c.maxStaleness, ESCROW_RATIO_BPS, CDP_RATIO_BPS, LIQ_RATIO_BPS);
        if (admin != msg.sender) engine.transferOwnership(admin); // hand to the DAO/multisig
        vm.stopBroadcast();

        // Post-deploy sanity: the derived ETH/BTC mark is plausible (BTC per ETH ~0.005–0.5).
        (, int256 ethBtc,,,) = IFeed(address(adapter)).latestRoundData();
        require(ethBtc > 0.005e8 && ethBtc < 0.5e8, "ETH/BTC adapter out of range");

        console2.log("network         :", c.name);
        console2.log("EthBtcAdapter   :", address(adapter));
        console2.log("CollateralEngine:", address(engine));
        console2.log("engine owner    :", admin);
        console2.log("cUSD asset id   :");
        console2.logBytes32(engine.CUSD_ASSET_ID());
        console2.log("ETH/BTC (8dec)  :", uint256(ethBtc));
        console2.log("NEXT: deploy pool with COLLATERAL_ENGINE = engine above, then owner calls engine.setPool(pool)");
    }

    function _assertFeedSane(address feed, uint256 loUsd, uint256 hiUsd, string memory tag) internal view {
        (, int256 a,, uint256 updatedAt,) = IFeed(feed).latestRoundData();
        require(a > 0, string.concat(tag, ": non-positive answer (wrong feed?)"));
        require(updatedAt != 0 && block.timestamp - updatedAt < 2 days, string.concat(tag, ": stale"));
        uint256 whole = uint256(a) / (10 ** uint256(IFeed(feed).decimals()));
        require(whole >= loUsd && whole <= hiUsd, string.concat(tag, ": out of plausible USD range (wrong feed?)"));
    }
}
