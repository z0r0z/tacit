// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {DeployV1Suite} from "../script/DeployV1Suite.s.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;
import {FarmController} from "../src/FarmController.sol";

contract MockSP1I {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockFeedI {
    int256 immutable a;
    uint8 immutable d;

    constructor(int256 a_, uint8 d_) {
        a = a_;
        d = d_;
    }

    function decimals() external view returns (uint8) {
        return d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, a, block.timestamp, block.timestamp, 1);
    }
}

contract MockTacI is ERC20 {
    function name() public pure override returns (string memory) {
        return "Tacit";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Day-1 walkthrough on the WIRED suite (DeployV1Suite.deploySuite) using the DIRECT public paths
///         that need no proof — the orchestrator's output is exercised end-to-end:
///           public LP add → public swap → farm fund (farmEscrow, direct) + notifyRewardAmount → LP remove.
///         Confidential (proof-bound) ops are covered by the *ProofReal suites; relayed settle by
///         TacitRelayer.t.sol; self-settle by the pool.settle in those suites. This proves the deployed
///         pool/engine/farm/AMM/token wiring actually transacts (not isolated unit mocks).
contract V1Day1IntegrationTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    bytes32 constant TETH_BITCOIN_ID = keccak256("test-teth-bitcoin-id");
    address constant GOV = address(0x600D);
    uint32 constant FEE = 30;

    DeployV1Suite suite;
    MockTacI tac;
    ConfidentialPool pool;
    bytes32 cTac;
    bytes32 cEth;
    bytes32 tacEthPoolId;
    address farm;

    receive() external payable {} // accept native-ETH payouts (swap/remove output)

    function setUp() public {
        vm.etch(PERMIT2, hex"00");
        vm.etch(ZROUTER, hex"00");
        suite = new DeployV1Suite();
        tac = new MockTacI();

        DeployV1Suite.Config memory c;
        c.sp1Verifier = address(new MockSP1I());
        c.programVkey = 0x00bf15b20c26315fab76fd1c93038111c799c6c9e95f6fce93670b78c35ee8ed;
        c.canonicalFactory = address(0);
        c.reflectionConfirmations = 6;
        c.tethBitcoinId = TETH_BITCOIN_ID;
        c.deployEngine = true;
        c.ethUsdFeed = address(new MockFeedI(2000e8, 8));
        c.btcUsdFeed = address(new MockFeedI(60000e8, 8));
        c.maxStaleness = 86400;
        c.engineAdmin = address(0xA11CE);
        c.farmGov = GOV;
        c.tacUnderlying = address(tac);
        c.tacUnitScale = 1;
        c.tacDecimals = 8;
        c.feeBps = FEE;
        c.deployRouter = true;
        c.zRouter = ZROUTER;
        c.permit2 = PERMIT2;
        c.deployRelayer = true;
        c.deployBtcCallExecutor = true;

        // deploySuite owns the engine as tx.origin and configures it (setFeeds/setParams/setPool) from its
        // own frame — mirror the real broadcast/CreateX deploy where deployer == configurer == tx.origin by
        // pranking both to the suite's address for this call (no broadcast in tests).
        vm.prank(address(suite), address(suite));
        DeployV1Suite.Deployed memory d = suite.deploySuite(c);
        pool = ConfidentialPool(payable(d.pool));
        cTac = d.cTac;
        cEth = d.cEth;
        tacEthPoolId = d.poolIds[0]; // TAC/cETH is the first founded pool
        farm = d.farms[0];

        tac.mint(address(this), 1_000_000e8);
        tac.approve(address(pool), type(uint256).max);
        vm.deal(address(this), 1_000 ether);
    }

    function test_day1_publicLp_swap_farmFund_remove() public {
        // ── public LP add: 100,000 TAC + 50 ETH into TAC/cETH ──
        uint256 tacAmt = 100_000e8; // TAC base units (8-dec, unitScale 1)
        uint256 ethWei = 50 ether; // native ETH leg (unitScale 1e10)
        uint256 shares = pool.createPairAndAddLiquidityPublic{value: ethWei}(
            cTac, cEth, FEE, tacAmt, ethWei, 0, uint64(block.timestamp + 1), address(this)
        );
        assertGt(shares, 0, "no LP shares minted");
        assertEq(pool.lpShares(tacEthPoolId, address(this)), shares, "shares not credited");

        // ── public swap: 1,000 TAC -> ETH against the new reserves ──
        uint256 ethBefore = address(this).balance;
        uint256 out = pool.swapPublic(cTac, cEth, FEE, 1_000e8, 0, uint64(block.timestamp + 1), address(this));
        assertGt(out, 0, "swap returned nothing");
        assertEq(address(this).balance, ethBefore + out, "ETH out not received");

        // ── fund the TAC/cETH farm directly (escrow path, no proof) + start emission ──
        uint256 reward = 50_000e8;
        uint256 got = pool.farmEscrow(farm, cTac, reward, address(0));
        assertEq(got, reward, "farmEscrow ingested wrong amount");
        vm.prank(GOV);
        FarmController(farm).notifyRewardAmount(reward, 30 days);
        assertGt(FarmController(farm).rate(), 0, "farm emission not started");
        assertEq(FarmController(farm).REWARD_ASSET(), cTac, "farm reward != cTAC");

        // ── exit: remove all public LP ──
        (uint256 aOut, uint256 bOut) = pool.removeLiquidityPublicFrom(
            cTac, cEth, FEE, shares, 0, 0, uint64(block.timestamp + 1), address(this), address(this)
        );
        assertGt(aOut, 0, "no asset A returned");
        assertGt(bOut, 0, "no asset B returned");
        assertEq(pool.lpShares(tacEthPoolId, address(this)), 0, "shares not burned on exit");
    }
}
