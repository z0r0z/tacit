// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, ICdpController, CdpLeg} from "../src/ConfidentialPool.sol";

contract MockVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Accepts every callback — the pool's escrow treasury bound is what's under test here, not the rps policy.
contract MockController is ICdpController {
    function onCdpMint(CdpLeg[] calldata, uint256, bytes32) external {}
    function onCdpClose(uint256, CdpLeg[] calldata, bytes32) external {}
    function onCdpLiquidate(CdpLeg[] calldata, uint256, bytes32) external {}
    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, bytes32, bytes32) external {}
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 18;

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
        rewardId = pool.registerWrapped(address(reward), 1, bytes32(0), "Reward", "RWD", 18);
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
            legs: legs
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

    function test_fund_rejects_pool_minted_or_native() public {
        // native ETH (underlying 0) is not registered escrow-backed for a farm
        vm.prank(creator);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.farmEscrow(address(controller), bytes32(uint256(0xDEAD)), 100, address(0));
    }
}
