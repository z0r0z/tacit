// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {ChainlinkWstEthBtcAdapter} from "../src/ChainlinkWstEthBtcAdapter.sol";

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

/// @notice Deploy the CollateralEngine — the cBTC wstETH escrow gate + the cUSD CDP controller
///         (cBTC-collateralized, Chainlink-priced) — with per-network feeds + market-standard risk params.
///
///  Oracle: the engine wants wstETH/BTC (BTC per wstETH) + BTC/USD. We derive wstETH/BTC from two liquid
///  USD feeds via ChainlinkWstEthBtcAdapter (wstETH/USD ÷ BTC/USD) so both engine feeds share a ~1h
///  heartbeat. WSTETH_USD_FEED MUST be a real, verified canonical Chainlink wstETH/USD feed address for the
///  target network — this script deliberately does NOT hardcode one (a wrong oracle address here is a
///  direct fund-loss risk); supply it via env var and double-check it against docs.chain.link before any
///  mainnet broadcast. BTC/USD is used directly (the cUSD peg, load-bearing).
///
///  Risk params (market-standard, MakerDAO/Aave-ish for BTC collateral):
///    • escrowRatioBps 15000 (1.5×)  — cBTC self-custody wstETH escrow over-collateralization
///    • cdpRatioBps    15000 (1.5×)  — cUSD mint floor (DAI-like)
///    • liqRatioBps    13000 (1.3×)  — cUSD liquidation threshold (< mint floor)
///    • maxDeviationBps 0            — single-source Chainlink at launch (enable once a tacUSD/tacBTC pool deepens)
///
///  Ownership: deployed with the broadcaster as initial owner so this script can configure it, then
///  transferred to ENGINE_ADMIN. On mainnet ENGINE_ADMIN is required to be a contract multisig/timelock.
///
///  Flow (engine↔pool circular dep — the pool's engine pointer is immutable, so the engine deploys first):
///    1. ENGINE_ADMIN=<multisig> forge script script/DeployCollateralEngine.s.sol --rpc-url $RPC --private-key $PK --broadcast
///    2. COLLATERAL_ENGINE=<engine> CANONICAL_FACTORY=<factory> forge script script/DeployConfidentialPool...
///       (the pool constructor deploy-or-adopts tacBTC + tacUSD and pins their ids)
///    3. engine.setPool(<pool>)   — called by the owner (ENGINE_ADMIN)
contract DeployCollateralEngine is Script {
    address public constant MAINNET_OPS_MULTISIG = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    address public constant TEST_BOT_ADMIN = 0x000000000e8CB9ed9DC2114d79d9215eacb9cB07;

    // cBTC.zk canonical id (must equal CollateralEngine.CANONICAL_CBTC_ASSET_ID; the ctor enforces it).
    bytes32 constant CANONICAL_CBTC_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;

    // Market params (bps). cUSD liquidation sits below the mint floor; cBTC escrow ≥ 100% of locked value.
    uint256 constant ESCROW_RATIO_BPS = 15000;
    uint256 constant CDP_RATIO_BPS = 15000;
    uint256 constant LIQ_RATIO_BPS = 13000;

    // wstETH token address per network (Lido's canonical wrapped staked ETH — verified, well-known deploys).
    address constant MAINNET_WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    struct NetCfg {
        address wstEth;
        address wstEthUsd;
        address btcUsd;
        uint256 maxStaleness;
        string name;
    }

    function _cfg() internal view returns (NetCfg memory c) {
        if (block.chainid == 1) {
            // Ethereum mainnet. BTC/USD is a fixed canonical Chainlink feed; wstETH/USD MUST be supplied via
            // env (verify the address against docs.chain.link before broadcasting — see contract-level note).
            c.wstEth = MAINNET_WSTETH;
            c.wstEthUsd = vm.envAddress("WSTETH_USD_FEED");
            c.btcUsd = 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c; // BTC/USD
            c.maxStaleness = 3900; // ~65 min (feeds heartbeat ~1h + grace)
            c.name = "mainnet";
        } else if (block.chainid == 11155111) {
            // Sepolia — no canonical wstETH/USD feed; require an explicit (test) feed + token via env.
            c.wstEth = vm.envAddress("SEPOLIA_WSTETH");
            c.wstEthUsd = vm.envAddress("WSTETH_USD_FEED");
            c.btcUsd = 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43; // BTC/USD
            c.maxStaleness = 86400; // testnet feeds update erratically — wide staleness so tests don't fail-closed
            c.name = "sepolia";
        } else {
            revert("DeployCollateralEngine: unsupported chainid (expect 1 or 11155111)");
        }
        require(c.wstEth != address(0) && c.wstEth.code.length != 0, "wstETH address invalid");
        require(c.wstEthUsd != address(0) && c.wstEthUsd.code.length != 0, "WSTETH_USD_FEED invalid");
    }

    function defaultEngineAdmin(uint256 chainId, address broadcaster) public pure returns (address) {
        if (chainId == 1) return MAINNET_OPS_MULTISIG;
        if (chainId == 11155111) return TEST_BOT_ADMIN;
        return broadcaster;
    }

    function run() external {
        NetCfg memory c = _cfg();
        address admin = vm.envOr("ENGINE_ADMIN", defaultEngineAdmin(block.chainid, msg.sender));
        require(admin != address(0), "ENGINE_ADMIN is zero");
        require(block.chainid != 1 || admin == MAINNET_OPS_MULTISIG, "mainnet: ENGINE_ADMIN must be ops multisig");
        require(block.chainid != 1 || admin.code.length != 0, "mainnet: ENGINE_ADMIN must be a contract");

        // Fail-closed against a wrong/stale feed address BEFORE we deploy anything against it.
        _assertFeedSane(c.btcUsd, 10_000, 500_000, "BTC/USD"); // $10k–$500k
        _assertFeedSane(c.wstEthUsd, 100, 150_000, "wstETH/USD"); // $100–$150k (wstETH trades above raw ETH)

        vm.startBroadcast();
        ChainlinkWstEthBtcAdapter adapter = new ChainlinkWstEthBtcAdapter(c.wstEthUsd, c.btcUsd);
        // pool=0 (wired post-pool via setPool). cBTC id canonical; cBTC + cUSD base precision = 8 (sats /
        // cents-of-a-dollar) → unitScale 10^10 onto the pool's 18-dec tacBTC/tacUSD ERC20s.
        CollateralEngine engine =
            new CollateralEngine(address(0), CANONICAL_CBTC_ASSET_ID, 8, 8, msg.sender, c.wstEth);
        engine.setFeeds(address(adapter), c.btcUsd, address(0), address(0));
        engine.setParams(c.maxStaleness, ESCROW_RATIO_BPS, CDP_RATIO_BPS, LIQ_RATIO_BPS);
        // The cBTC escrow margin call (escrowMaintenanceBps / escrowEnforcementModule) is left at its DORMANT
        // zero default on purpose — it activates post-launch once the deviation guard + pools are live. See
        // ops/DESIGN-cbtc-escrow-health-module.md. Deliberately NOT set here.
        if (admin != msg.sender) engine.transferOwnership(admin); // hand to the DAO/multisig
        vm.stopBroadcast();

        // Post-deploy sanity: the derived wstETH/BTC mark is plausible (BTC per wstETH ~0.005–0.6, wider
        // than raw ETH/BTC since wstETH trades at a premium to ETH).
        (, int256 wstEthBtc,,,) = IFeed(address(adapter)).latestRoundData();
        require(wstEthBtc > 0.005e8 && wstEthBtc < 0.6e8, "wstETH/BTC adapter out of range");

        console2.log("network           :", c.name);
        console2.log("WstEthBtcAdapter  :", address(adapter));
        console2.log("CollateralEngine  :", address(engine));
        console2.log("engine owner      :", admin);
        console2.log("cUSD asset id     :");
        console2.logBytes32(engine.CUSD_ASSET_ID());
        console2.log("wstETH/BTC (8dec) :", uint256(wstEthBtc));
        console2.log("escrow margincall: DORMANT (escrowMaintenanceBps=0); activate post-launch per ops doc");
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
