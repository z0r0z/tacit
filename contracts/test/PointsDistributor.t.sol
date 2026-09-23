// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {MerkleTreeLib} from "solady/utils/MerkleTreeLib.sol";
import {PointsDistributor} from "../src/PointsDistributor.sol";

contract PointsToken is ERC20 {
    function name() public pure override returns (string memory) { return "TAC"; }
    function symbol() public pure override returns (string memory) { return "TAC"; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
}

contract PointsDistributorBase is Test {
    PointsToken tok;
    PointsDistributor dist;
    address guardian = address(0x6A2D);
    address rootSetter = address(0x50717E);
    address stranger = address(0xBEEF);
    uint64 deadline;

    address[] accts;
    uint256[] amts;
    bytes32[] tree;
    uint256 total;

    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, amt))));
    }

    /// Recipient i is address(0x1000 + i), cumulative amount (i + 1) whole TAC.
    function _makeTree(uint256 n, uint256 mul) internal {
        delete accts; delete amts; total = 0;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            address a = address(uint160(0x1000 + i));
            uint256 amt = (i + 1) * mul;
            accts.push(a); amts.push(amt); total += amt;
            leaves[i] = _leaf(a, amt);
        }
        tree = MerkleTreeLib.build(leaves);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) { return MerkleTreeLib.leafProof(tree, i); }

    function setUp() public virtual {
        deadline = uint64(block.timestamp + 90 days);
        vm.etch(guardian, hex"00"); // the guardian is a contract (the ops multisig)
        tok = new PointsToken();
        dist = new PointsDistributor(address(tok), guardian, rootSetter, deadline);
        _makeTree(10, 1e18);
    }

    function _fundAndSetRoot(uint256 fundAmount, uint256 declaredTotal) internal {
        tok.mint(address(dist), fundAmount);
        vm.prank(rootSetter);
        dist.updateRoot(MerkleTreeLib.root(tree), declaredTotal);
    }
}

contract PointsDistributorTest is PointsDistributorBase {
    event Claimed(address indexed account, uint256 amount, uint256 cumulativeAmount);
    event RootUpdated(bytes32 root, uint256 totalAllocated);
    event RootSetterUpdated(address indexed rootSetter);
    event Swept(address indexed to, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event PausedSet(bool paused);

    // ── construction ──

    function test_constructorSetsImmutables() public view {
        assertEq(dist.TOKEN(), address(tok));
        assertEq(dist.GUARDIAN(), guardian);
        assertEq(dist.rootSetter(), rootSetter);
        assertEq(dist.ROOT_UPDATE_DEADLINE(), deadline);
        assertFalse(dist.paused());
        assertEq(dist.totalAllocated(), 0);
        assertEq(dist.totalClaimed(), 0);
    }

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(0), guardian, rootSetter, deadline);
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(tok), address(0), rootSetter, deadline);
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(tok), guardian, address(0), deadline);
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(tok), address(0xE0A), rootSetter, deadline); // EOA guardian, no code
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(tok), guardian, rootSetter, uint64(block.timestamp)); // deadline in the past
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(tok), guardian, rootSetter, uint64(block.timestamp + 401 days));
        new PointsDistributor(address(tok), guardian, rootSetter, uint64(block.timestamp + 400 days)); // fine
    }

    // ── updateRoot ──

    function test_updateRootOnlyRootSetter() public {
        vm.prank(stranger);
        vm.expectRevert(PointsDistributor.NotRootSetter.selector);
        dist.updateRoot(MerkleTreeLib.root(tree), total);
    }

    function test_updateRootRejectsOverFunded() public {
        tok.mint(address(dist), total - 1);
        vm.prank(rootSetter);
        vm.expectRevert(PointsDistributor.OverFunded.selector);
        dist.updateRoot(MerkleTreeLib.root(tree), total);
    }

    function test_updateRootRejectsDecreasingTotal() public {
        _fundAndSetRoot(total, total);
        uint256 committed = dist.totalAllocated();
        _makeTree(5, 1e18); // a smaller declared total than what's already committed
        tok.mint(address(dist), total);
        bytes32 newRoot = MerkleTreeLib.root(tree);
        uint256 smallerTotal = total; // precomputed: no external call between expectRevert and the target call
        assertLt(smallerTotal, committed);
        vm.prank(rootSetter);
        vm.expectRevert(PointsDistributor.TotalDecreased.selector);
        dist.updateRoot(newRoot, smallerTotal);
    }

    function test_updateRootSucceedsAndEmits() public {
        tok.mint(address(dist), total);
        vm.expectEmit(true, true, true, true);
        emit RootUpdated(MerkleTreeLib.root(tree), total);
        vm.prank(rootSetter);
        dist.updateRoot(MerkleTreeLib.root(tree), total);
        assertEq(dist.root(), MerkleTreeLib.root(tree));
        assertEq(dist.totalAllocated(), total);
    }

    function test_updateRootRejectsWhenPaused() public {
        vm.prank(guardian);
        dist.pause();
        vm.prank(rootSetter);
        vm.expectRevert(PointsDistributor.Paused.selector);
        dist.updateRoot(MerkleTreeLib.root(tree), total);
    }

    function test_updateRootRejectsAfterDeadline() public {
        vm.warp(deadline + 1);
        vm.prank(rootSetter);
        vm.expectRevert(PointsDistributor.RootUpdatesClosed.selector);
        dist.updateRoot(MerkleTreeLib.root(tree), total);
    }

    // ── claim ──

    function test_claimPaysAndEmits() public {
        _fundAndSetRoot(total, total);
        vm.expectEmit(true, true, true, true);
        emit Claimed(accts[0], amts[0], amts[0]);
        vm.prank(accts[0]);
        dist.claim(amts[0], _proof(0));
        assertEq(tok.balanceOf(accts[0]), amts[0]);
        assertEq(dist.claimed(accts[0]), amts[0]);
        assertEq(dist.totalClaimed(), amts[0]);
    }

    function test_claimRejectsBadProof() public {
        _fundAndSetRoot(total, total);
        vm.prank(accts[0]);
        vm.expectRevert(PointsDistributor.BadProof.selector);
        dist.claim(amts[0] + 1, _proof(0));
    }

    function test_claimRejectsWrongCaller() public {
        _fundAndSetRoot(total, total);
        vm.prank(stranger);
        vm.expectRevert(PointsDistributor.BadProof.selector); // leaf is keyed to accts[0], not stranger
        dist.claim(amts[0], _proof(0));
    }

    function test_secondClaimAgainstSameRootPaysNothing() public {
        _fundAndSetRoot(total, total);
        vm.startPrank(accts[0]);
        dist.claim(amts[0], _proof(0));
        vm.expectRevert(PointsDistributor.NothingOwed.selector);
        dist.claim(amts[0], _proof(0));
        vm.stopPrank();
    }

    function test_claimAfterRootRaisesPaysOnlyTheDelta() public {
        _fundAndSetRoot(total, total);
        vm.prank(accts[0]);
        dist.claim(amts[0], _proof(0)); // claims day-1 entitlement in full

        // Day 2: same account's cumulative total grows; everyone else unchanged in this toy tree.
        uint256 raised = amts[0] + 3e18;
        bytes32[] memory leaves = new bytes32[](accts.length);
        leaves[0] = _leaf(accts[0], raised);
        for (uint256 i = 1; i < accts.length; ++i) leaves[i] = _leaf(accts[i], amts[i]);
        tree = MerkleTreeLib.build(leaves);
        uint256 newTotal = total + 3e18;
        tok.mint(address(dist), 3e18);
        vm.prank(rootSetter);
        dist.updateRoot(MerkleTreeLib.root(tree), newTotal);

        vm.prank(accts[0]);
        vm.expectEmit(true, true, true, true);
        emit Claimed(accts[0], 3e18, raised);
        dist.claim(raised, MerkleTreeLib.leafProof(tree, 0));
        assertEq(tok.balanceOf(accts[0]), raised);
        assertEq(dist.claimed(accts[0]), raised);
    }

    function test_claimRejectsWhenPaused() public {
        _fundAndSetRoot(total, total);
        vm.prank(guardian);
        dist.pause();
        vm.prank(accts[0]);
        vm.expectRevert(PointsDistributor.Paused.selector);
        dist.claim(amts[0], _proof(0));
    }

    function test_claimToRejectsBadRecipients() public {
        _fundAndSetRoot(total, total);
        vm.startPrank(accts[0]);
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.claimTo(amts[0], _proof(0), address(0));
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.claimTo(amts[0], _proof(0), address(dist));
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.claimTo(amts[0], _proof(0), address(tok));
        vm.stopPrank();
    }

    function test_claimToSendsElsewhere() public {
        _fundAndSetRoot(total, total);
        vm.prank(accts[0]);
        dist.claimTo(amts[0], _proof(0), stranger);
        assertEq(tok.balanceOf(stranger), amts[0]);
        assertEq(tok.balanceOf(accts[0]), 0);
    }

    // ── views ──

    function test_owedAndVerify() public {
        _fundAndSetRoot(total, total);
        assertEq(dist.owed(accts[0], amts[0]), amts[0]);
        assertTrue(dist.verify(accts[0], amts[0], _proof(0)));
        assertFalse(dist.verify(accts[0], amts[0] + 1, _proof(0)));

        vm.prank(accts[0]);
        dist.claim(amts[0], _proof(0));
        assertEq(dist.owed(accts[0], amts[0]), 0);
    }

    // ── guardian ──

    function test_onlyGuardianGates() public {
        vm.startPrank(stranger);
        vm.expectRevert(PointsDistributor.NotGuardian.selector);
        dist.pause();
        vm.expectRevert(PointsDistributor.NotGuardian.selector);
        dist.setRootSetter(stranger);
        vm.expectRevert(PointsDistributor.NotGuardian.selector);
        dist.sweep(stranger, 1);
        vm.stopPrank();
    }

    function test_setRootSetterRotatesAccess() public {
        address fresh = address(0xF12E5);
        vm.prank(guardian);
        vm.expectEmit(true, true, true, true);
        emit RootSetterUpdated(fresh);
        dist.setRootSetter(fresh);

        vm.prank(rootSetter); // old key
        vm.expectRevert(PointsDistributor.NotRootSetter.selector);
        dist.updateRoot(MerkleTreeLib.root(tree), total);

        tok.mint(address(dist), total);
        vm.prank(fresh);
        dist.updateRoot(MerkleTreeLib.root(tree), total); // new key works
        assertEq(dist.totalAllocated(), total);
    }

    function test_sweepMovesFunds() public {
        _fundAndSetRoot(total, total);
        vm.prank(guardian);
        dist.sweep(stranger, total);
        assertEq(tok.balanceOf(stranger), total);
        assertEq(tok.balanceOf(address(dist)), 0);
    }

    function test_sweepTokenMovesOtherTokenAndEth() public {
        FalseReturnToken other = new FalseReturnToken();
        // sweepToken uses SafeTransferLib against a real ERC20; use PointsToken as the "other" token instead
        PointsToken otherReal = new PointsToken();
        otherReal.mint(address(dist), 5e18);
        vm.prank(guardian);
        dist.sweepToken(address(otherReal), stranger, 5e18);
        assertEq(otherReal.balanceOf(stranger), 5e18);

        vm.deal(address(dist), 1 ether);
        vm.prank(guardian);
        dist.sweepToken(address(0), stranger, 1 ether);
        assertEq(stranger.balance, 1 ether);
        other; // silence unused warning if compiler flags it
    }

    // ── regression: landmine leaf can't outrun totalAllocated ──

    /// A root whose declared totalAllocated honestly passes updateRoot's funded check can still carry one
    /// wildly oversized leaf alongside legitimate ones. That leaf must never be able to claim past what THIS
    /// root's totalAllocated covers, even though its own cumulativeAmount is far larger and even after more
    /// funding arrives later (which would otherwise make the stale leaf immediately claimable again).
    function test_oversizedLeafCappedByTotalAllocatedNotItsOwnAmount() public {
        address attacker = address(0xACC0);
        uint256 landmine = 1_000_000e18; // far more than will ever be funded
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = _leaf(accts[0], amts[0]); // one legitimate leaf
        leaves[1] = _leaf(attacker, landmine); // the landmine
        tree = MerkleTreeLib.build(leaves);

        uint256 declaredTotal = amts[0] + 10e18; // small, honestly funded — nowhere near `landmine`
        tok.mint(address(dist), declaredTotal);
        vm.prank(rootSetter);
        dist.updateRoot(MerkleTreeLib.root(tree), declaredTotal);

        // The legitimate leaf claims fine.
        vm.prank(accts[0]);
        dist.claim(amts[0], MerkleTreeLib.leafProof(tree, 0));

        // The landmine leaf's proof verifies (it IS a real leaf of the current root) but can only ever pay out
        // up to what remains of totalAllocated, never its own declared cumulativeAmount.
        assertTrue(dist.verify(attacker, landmine, MerkleTreeLib.leafProof(tree, 1)));
        vm.prank(attacker);
        vm.expectRevert(PointsDistributor.OverAllocated.selector);
        dist.claim(landmine, MerkleTreeLib.leafProof(tree, 1));

        // Even after a routine, honest future top-up (more program budget arriving), the stale landmine leaf
        // still can't run past the CURRENT totalAllocated unless a new updateRoot explicitly raises it.
        tok.mint(address(dist), 500_000e18);
        vm.prank(attacker);
        vm.expectRevert(PointsDistributor.OverAllocated.selector);
        dist.claim(landmine, MerkleTreeLib.leafProof(tree, 1));
    }

    function test_updateRootRejectsZeroRoot() public {
        vm.prank(rootSetter);
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        dist.updateRoot(bytes32(0), 0);
    }

    function test_constructorRejectsEoaToken() public {
        vm.expectRevert(PointsDistributor.BadConfig.selector);
        new PointsDistributor(address(0xE0A), guardian, rootSetter, deadline);
    }

    function test_sweepRejectsSelfAndTokenAddress() public {
        _fundAndSetRoot(total, total);
        vm.startPrank(guardian);
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.sweep(address(dist), 1);
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.sweep(address(tok), 1);
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.sweepToken(address(tok), address(dist), 1);
        vm.expectRevert(PointsDistributor.BadRecipient.selector);
        dist.sweepToken(address(tok), address(tok), 1);
        vm.stopPrank();
    }

    function test_sweepRevertsOnFalseReturnToken() public {
        // sweep() itself only ever moves TOKEN (a real ERC20 in production); this checks the SafeTransferLib
        // path reverts loudly rather than silently succeeding if TOKEN ever behaved like a false-return token.
        PointsDistributor badDist = new PointsDistributor(address(new FalseReturnTokenWrapper()), guardian, rootSetter, deadline);
        vm.expectRevert();
        vm.prank(guardian);
        badDist.sweep(stranger, 1);
    }
}

/// Wraps FalseReturnToken so it satisfies the constructor's `code.length` checks trivially (it's already a
/// contract) while giving SafeTransferLib a `transfer` that reports failure via return value instead of revert.
contract FalseReturnTokenWrapper is FalseReturnToken {}
