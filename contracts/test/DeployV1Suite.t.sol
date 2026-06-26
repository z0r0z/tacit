// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {DeployV1Suite} from "../script/DeployV1Suite.s.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {FarmController} from "../src/FarmController.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";
import {BtcCallExecutor} from "../src/BtcCallExecutor.sol";

contract MockSP1 {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockFeedS {
    int256 public ans;
    uint8 public immutable dec;
    uint256 public upAt;

    constructor(int256 a, uint8 d) {
        ans = a;
        dec = d;
        upAt = block.timestamp;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, ans, upAt, upAt, 1);
    }
}

contract MockTacToken is ERC20 {
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

/// @notice Deterministic deployment REHEARSAL — runs DeployV1Suite.deploySuite with mock verifier/feeds and
///         asserts the full wiring graph the live one-command deploy must produce: engine↔pool circular dep
///         broken (setPool) BEFORE the ownership handoff; cBTC.tac + cUSD.tac + cETH ctor-pinned; all 5
///         TAC-centric pools founded; a cTAC farm per pool with the right stake/reward ids; periphery
///         pinned to the pool. This is the "did the orchestrator wire everything" gate, no box required.
contract DeployV1SuiteTest is Test {
    bytes32 constant CBTC_ZK_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;
    bytes32 constant TETH_BITCOIN_ID = keccak256("test-teth-bitcoin-id");
    address constant ADMIN = address(0xA11CE);
    address constant GOV = address(0x600D);

    // Canonical singletons the ConfidentialRouter ctor requires to have code (it never calls them at
    // construction, only checks code.length) — stubbed locally with vm.etch.
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;

    DeployV1Suite suite;
    MockTacToken tac;
    address sp1;
    address ethUsd;
    address btcUsd;

    function setUp() public {
        suite = new DeployV1Suite();
        tac = new MockTacToken();
        sp1 = address(new MockSP1());
        ethUsd = address(new MockFeedS(2000e8, 8)); // $2000 ETH
        btcUsd = address(new MockFeedS(60000e8, 8)); // $60k BTC
        vm.etch(PERMIT2, hex"00"); // code present so the router ctor accepts it
        vm.etch(ZROUTER, hex"00");
    }

    function _cfg() internal view returns (DeployV1Suite.Config memory c) {
        c.sp1Verifier = sp1;
        c.programVkey = 0x00bf15b20c26315fab76fd1c93038111c799c6c9e95f6fce93670b78c35ee8ed;
        c.bitcoinRelayVkey = bytes32(0); // reflection off for the rehearsal
        c.canonicalFactory = address(0); // fresh
        c.headerRelay = address(0);
        c.genesisReflectionAnchor = bytes32(0);
        c.reflectionConfirmations = 6;
        c.reflectionResumeDigest = bytes32(0);
        c.tethBitcoinId = TETH_BITCOIN_ID;
        c.deployEngine = true;
        c.ethUsdFeed = ethUsd;
        c.btcUsdFeed = btcUsd;
        c.maxStaleness = 86400;
        c.engineAdmin = ADMIN;
        c.farmGov = GOV;
        c.tacUnderlying = address(tac);
        c.deployTestnetTac = false;
        c.tacRecipient = ADMIN;
        c.tacUnitScale = 1;
        c.tacDecimals = 8;
        c.feeBps = 30;
        c.deployRouter = true;
        c.zRouter = ZROUTER;
        c.permit2 = PERMIT2;
        c.deployRelayer = true;
        c.deployBtcCallExecutor = true;
        c.farmLockUntil = 0;
    }

    function test_fullWiringGraph() public {
        // Mirror the real broadcast/CreateX deploy (deployer == configurer == tx.origin) so the engine's
        // tx.origin-owned config calls are authorized; no broadcast in tests, so prank both for this call.
        vm.prank(address(suite), address(suite));
        DeployV1Suite.Deployed memory d = suite.deploySuite(_cfg());

        // Core contracts exist.
        assertTrue(d.factory.code.length != 0, "no factory");
        assertTrue(d.engine.code.length != 0, "no engine");
        assertTrue(d.pool.code.length != 0, "no pool");
        assertTrue(d.adapter.code.length != 0, "no adapter");

        // Circular dep broken THEN ownership handed off.
        assertEq(address(CollateralEngine(payable(d.engine)).POOL()), d.pool, "engine.POOL != pool");
        assertEq(Ownable(d.engine).owner(), ADMIN, "engine owner != admin");

        // Day-1 assets all resolved (ctor pinned cETH/cBTC.tac/cUSD.tac; TAC registered).
        assertTrue(d.cTac != bytes32(0), "cTac unresolved");
        assertTrue(d.cEth != bytes32(0), "cEth unresolved");
        assertTrue(d.cBtc != bytes32(0), "cBtc unresolved");
        assertTrue(d.cUsd != bytes32(0), "cUsd unresolved");

        // cBTC.tac + cUSD.tac canonical ERC20s pinned by the ctor.
        assertTrue(ConfidentialPool(payable(d.pool)).canonicalTokenFor(CBTC_ZK_ASSET_ID) != address(0), "cBTC.tac not pinned");

        // All 5 TAC-centric pools founded + a farm each.
        assertEq(d.poolIds.length, 5, "expected 5 pools");
        assertEq(d.farms.length, 5, "expected 5 farms");
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(d.poolIds[i] != bytes32(0), "pool id zero");
            FarmController f = FarmController(d.farms[i]);
            assertEq(f.POOL(), d.pool, "farm.POOL != pool");
            assertEq(f.STAKE_ASSET(), keccak256(abi.encodePacked(d.poolIds[i], "lp")), "farm stake != lp share id");
            assertEq(f.REWARD_ASSET(), d.cTac, "farm reward != cTAC");
            assertTrue(f.ESCROW_MODE(), "farm not escrow mode");
        }

        // Periphery pinned to the pool.
        assertEq(address(TacitRelayer(payable(d.relayer)).POOL()), d.pool, "relayer.POOL != pool");
        assertEq(address(BtcCallExecutor(d.btcCallExecutor).POOL()), d.pool, "btcCallExecutor.POOL != pool");
        assertTrue(d.router.code.length != 0, "no router");
    }

    function test_ethereumOnly_noEngine_skipsCbtcCusdPools() public {
        // No engine ⇒ cBTC/cUSD dormant ⇒ only the TAC/cETH pool resolves (the one pair with both legs).
        DeployV1Suite.Config memory c = _cfg();
        c.deployEngine = false;
        DeployV1Suite.Deployed memory d = suite.deploySuite(c);
        assertEq(d.engine, address(0), "engine deployed");
        assertTrue(d.cBtc == bytes32(0) && d.cUsd == bytes32(0), "cBTC/cUSD should be unresolved");
        assertEq(d.poolIds.length, 1, "only TAC/cETH should resolve");
        assertEq(d.poolNames[0], "TAC/cETH", "wrong surviving pool");
    }

    function test_noTac_skipsTacPools() public {
        DeployV1Suite.Config memory c = _cfg();
        c.tacUnderlying = address(0);
        c.deployTestnetTac = false;
        vm.prank(address(suite), address(suite));
        DeployV1Suite.Deployed memory d = suite.deploySuite(c);
        assertTrue(d.cTac == bytes32(0), "cTac should be unresolved");
        // TAC/cETH + TAC/cBTC drop; cUSD/cBTC + cUSD/cETH + cETH/cBTC remain.
        assertEq(d.poolIds.length, 3, "expected the 3 non-TAC pools");
    }

    function test_testnetTacEtch_fundsAllFivePools() public {
        // No external TAC supplied: the suite etches a 21M fixed-supply TAC to the recipient and wires it.
        DeployV1Suite.Config memory c = _cfg();
        c.tacUnderlying = address(0);
        c.deployTestnetTac = true;
        c.tacRecipient = ADMIN;
        vm.prank(address(suite), address(suite));
        DeployV1Suite.Deployed memory d = suite.deploySuite(c);
        assertTrue(d.tac != address(0), "TAC not etched");
        assertTrue(d.cTac != bytes32(0), "cTac unresolved");
        assertEq(ERC20(d.tac).balanceOf(ADMIN), 21_000_000 * 10 ** 8, "wrong TAC supply to recipient");
        assertEq(ERC20(d.tac).decimals(), 8, "TAC decimals != 8");
        assertEq(d.poolIds.length, 5, "expected all 5 pools");
    }
}
