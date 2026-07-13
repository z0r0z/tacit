// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, ICdpController, CdpLeg} from "../src/ConfidentialPool.sol";

contract MockVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Accepts every callback — the pool's escrow treasury bound is what's under test here, not the rps policy.
/// Exposes REWARD_ASSET (like a real FarmController) so farmEscrow's first-fund pin binds to the controller.
contract MockController is ICdpController {
    bytes32 public REWARD_ASSET;
    function setRewardAsset(bytes32 r) external { REWARD_ASSET = r; }
    function accrued() external pure returns (uint256) { return 0; }
    function onCdpMint(CdpLeg[] calldata, uint256, bytes32, uint256) external {}
    function onCdpClose(uint256, uint256, uint256, CdpLeg[] calldata, bytes32) external {}
    function onCdpLiquidate(CdpLeg[] calldata, uint256, uint256, uint256, bytes32) external {}
    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, uint256, bytes32, bytes32) external {}
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 8;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// The escrow-mode farm treasury accounting (ops/PLAN-evm-farm-rewards.md): farmEscrow fund → the _settle
/// harvest bound debits the budget by debtValue → farmEscrow recover returns the leftover. The invariant
/// escrow == Σ outstanding reward notes + Σ farmTreasury holds with equality.
contract ConfidentialFarmEscrowTest is Test {
    ConfidentialPool pool;
    MockController controller;
    MockERC20 reward;
    bytes32 rewardId;
    address creator = address(0xC0FFEE);

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(
            address(new MockVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0),
            bytes32(0), 6, bytes32(0), bytes32(0), address(0)
        );
        controller = new MockController();
        reward = new MockERC20();
        // Register the reward ERC20 as an escrow-backed asset, unitScale 1 (value == amount).
        rewardId = pool.registerWrapped(address(reward), 1, bytes32(0), "Reward", "RWD", 8);
        controller.setRewardAsset(rewardId); // the pin binds to the controller's declared reward asset
        reward.mint(creator, 1000);
        vm.prank(creator);
        reward.approve(address(pool), type(uint256).max);
    }

    function _fund(uint256 amount) internal {
        vm.prank(creator);
        pool.farmEscrow(address(controller), rewardId, amount, address(0));
    }

    // A harvest settle: CdpMint(positionLeaf == 1, debtValue == reward) + a reward-note leaf + the old-receipt ν.
    function _harvest(uint256 rewardAmt) internal {
        _harvestAsset(rewardAmt, rewardId); // escrow reward (the funded asset)
    }

    function _harvestAsset(uint256 rewardAmt, bytes32 rewardAsset) internal {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = keccak256(abi.encodePacked("nu", rewardAmt));
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256(abi.encodePacked("rewardnote", rewardAmt));
        pv.cdpMints = new ConfidentialPool.CdpMint[](1);
        CdpLeg[] memory legs = new CdpLeg[](2);
        // The guest binds legs[0].asset to the minted reward note's asset; the pool reads it to require escrow
        // backing for any non-debt (escrow) reward asset.
        legs[0] = CdpLeg(rewardAsset, 100); // (rewardAsset, shares)
        legs[1] = CdpLeg(bytes32(0), 0); // rps_entry
        pv.cdpMints[0] = ConfidentialPool.CdpMint({
            controller: address(controller),
            debtAsset: keccak256(abi.encodePacked("tacit-cdp-debt-v1", address(controller))),
            debtValue: rewardAmt,
            positionLeaf: bytes32(uint256(1)),
            rateSnapshot: 0,
            legs: legs,
            owner: bytes32(0)
        });
        pool.settle(abi.encode(pv), "", new bytes[](1));
    }

    function _recover(address to) internal returns (uint256) {
        vm.prank(address(controller));
        return pool.farmEscrow(address(controller), rewardId, 0, to);
    }

    function test_fund_credits_escrow() public {
        _fund(1000);
        assertEq(reward.balanceOf(address(pool)), 1000, "escrow funded");
        assertEq(reward.balanceOf(creator), 0, "creator deposited");
    }

    function test_harvest_debits_treasury_then_recover_returns_leftover() public {
        _fund(1000);
        _harvest(600); // distributes 600 of the budget
        _harvest(300); // 300 more — 900 total, 100 left
        uint256 back = _recover(creator);
        assertEq(back, 100, "leftover = funded - distributed");
        assertEq(reward.balanceOf(creator), 100, "creator reclaimed 100");
        // escrow now exactly backs the 900 distributed reward notes
        assertEq(reward.balanceOf(address(pool)), 900, "escrow == outstanding reward notes");
    }

    function test_harvest_over_treasury_reverts() public {
        _fund(500);
        vm.expectRevert(ConfidentialPool.InsufficientEscrow.selector);
        _harvest(501); // exceeds the funded budget
    }

    /// An UNFUNDED escrow farm cannot harvest: an escrow-asset reward (legs[0].asset == rewardId, != the
    /// controller's debt asset) must be treasury-backed even when farmRewardAsset was never pinned — otherwise
    /// the reward note would be drawn from the pool's shared escrow of that asset.
    function test_unfunded_escrow_harvest_reverts() public {
        vm.expectRevert(ConfidentialPool.InsufficientEscrow.selector);
        _harvest(100); // no _fund() ⇒ no backing
    }

    /// MINT mode: the reward IS the controller's own pool-minted debt asset (legs[0].asset == debtAsset), so
    /// no treasury is needed (un-minted is un-inflated) and the harvest settles unfunded.
    function test_mint_mode_harvest_needs_no_treasury() public {
        bytes32 debtAsset = keccak256(abi.encodePacked("tacit-cdp-debt-v1", address(controller)));
        _harvestAsset(100, debtAsset); // no revert (no escrow backing required)
    }

    function test_recover_gated_to_pinned_controller() public {
        _fund(1000);
        vm.prank(address(0xBEEF)); // not the controller
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.farmEscrow(address(controller), rewardId, 0, creator);
    }

    function test_recover_unfunded_controller_reverts_cleanly() public {
        // A controller that never funded (pinned == 0) has no budget to reclaim — even when it passes a
        // matching-looking zero rewardAsset (the old `pinned != rewardAsset` guard let 0 == 0 fall through
        // to a vacuous zero payout). Now it reverts NotRegistered.
        vm.prank(address(controller));
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.farmEscrow(address(controller), bytes32(0), 0, creator);
    }

    function test_fund_rejects_pool_minted_or_native() public {
        // native ETH (underlying 0) is not registered escrow-backed for a farm
        vm.prank(creator);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.farmEscrow(address(controller), bytes32(uint256(0xDEAD)), 100, address(0));
    }

    function test_fund_rejects_zero_controller() public {
        vm.prank(creator);
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        pool.farmEscrow(address(0), rewardId, 100, address(0));
    }

    // REGRESSION (farmEscrow pin-squat): the first-fund pin binds to the controller's own REWARD_ASSET, so a
    // griefer cannot pin a DIFFERENT registered asset for a controller (which would permanently brick its
    // real reward funding). A fund whose asset != controller.REWARD_ASSET() reverts NotRegistered.
    function test_fund_squat_wrong_asset_reverts() public {
        MockERC20 reward2 = new MockERC20();
        bytes32 rewardId2 = pool.registerWrapped(address(reward2), 1, bytes32(0), "Reward2", "RWD2", 8);
        reward2.mint(creator, 1000);
        vm.prank(creator);
        reward2.approve(address(pool), type(uint256).max);
        // controller.REWARD_ASSET() == rewardId (set in setUp), NOT rewardId2 → squat rejected.
        vm.prank(creator);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.farmEscrow(address(controller), rewardId2, 100, address(0));
    }

    // REGRESSION: a controller that does not declare a matching REWARD_ASSET (unconfigured / a pre-deploy
    // squat target) cannot be first-funded — the pin can't be set against it.
    function test_fund_squat_controller_without_matching_reward_asset_reverts() public {
        MockController other = new MockController(); // REWARD_ASSET == 0 (unset)
        vm.prank(creator);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.farmEscrow(address(other), rewardId, 100, address(0));
    }
}
