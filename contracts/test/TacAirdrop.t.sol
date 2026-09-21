// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {MerkleTreeLib} from "solady/utils/MerkleTreeLib.sol";
import {TacAirdrop} from "../src/TacAirdrop.sol";

/// Pool-minted token: the minter (the pool) may burn from any holder, exactly like the canonical TAC.
contract AirdropToken is ERC20 {
    address public minter;
    constructor(address m) { minter = m; }
    function name() public pure override returns (string memory) { return "TAC"; }
    function symbol() public pure override returns (string memory) { return "TAC"; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function burn(address from, uint256 a) external { require(msg.sender == minter, "minter"); _burn(from, a); }
}

/// A pool stand-in with the real pool's `wrap` semantics for a pool-minted asset: the amount must be a positive multiple of
/// the unit scale, the deposit id is keccak(assetId, value, commit), a repeated id reverts, and the caller's tokens are burned
/// without an allowance.
contract MockAirdropPool {
    AirdropToken public token;
    bytes32 public assetId;
    uint256 public constant SCALE = 1e10;
    bool public poolMinted = true;
    mapping(bytes32 => uint8) public depositStatus;
    bool public failNext;

    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount);
    error AmountNotAligned();
    error DepositExists();

    constructor(bytes32 id) { assetId = id; }
    function setToken(AirdropToken t) external { token = t; }
    function setPoolMinted(bool v) external { poolMinted = v; }
    function setFailNext(bool v) external { failNext = v; }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        if (id != assetId) return (false, address(0), 0, bytes32(0), false, 0);
        return (true, address(token), SCALE, bytes32(0), poolMinted, 18);
    }

    function wrap(bytes32 id, uint256 amount, bytes32 commit) external payable {
        require(!failNext, "pool down");
        if (amount == 0 || amount % SCALE != 0) revert AmountNotAligned();
        bytes32 depositId = keccak256(abi.encodePacked(id, amount / SCALE, commit));
        if (depositStatus[depositId] != 0) revert DepositExists();
        depositStatus[depositId] = 1;
        token.burn(msg.sender, amount);
        emit Wrap(depositId, id, amount);
    }
}

/// transfer returns no data at all, like several widely used tokens.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external { balanceOf[msg.sender] -= a; balanceOf[to] += a; }
}

/// transfer reports failure with `false` instead of reverting.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
}

contract AirdropBase is Test {
    AirdropToken tok;
    MockAirdropPool pool;
    TacAirdrop drop;
    address guardian = address(0x6A2D);
    address stranger = address(0xBEEF);
    bytes32 constant ASSET = keccak256("tac-asset");
    uint64 deadline;

    address[] accts;
    uint256[] amts;
    bytes32[] tree;
    uint256 total;

    function _leaf(uint256 i, address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(i, a, amt))));
    }

    /// Recipient i is address(0x1000 + i) and is owed (i + 1) whole TAC.
    function _makeTree(uint256 n) internal {
        delete accts; delete amts; total = 0;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            address a = address(uint160(0x1000 + i));
            uint256 amt = (i + 1) * 1e18;
            accts.push(a); amts.push(amt); total += amt;
            leaves[i] = _leaf(i, a, amt);
        }
        tree = MerkleTreeLib.build(leaves);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) { return MerkleTreeLib.leafProof(tree, i); }

    function _deploy(uint256 n) internal {
        deadline = uint64(block.timestamp + 30 days);
        vm.etch(guardian, hex"00"); // the guardian is a contract (the ops multisig)
        pool = new MockAirdropPool(ASSET);
        tok = new AirdropToken(address(pool));
        pool.setToken(tok);
        _makeTree(n);
        drop = new TacAirdrop(address(tok), MerkleTreeLib.root(tree), guardian, deadline, address(pool), ASSET);
        tok.mint(address(drop), total);
    }

    function setUp() public virtual { _deploy(10); }
}

contract TacAirdropTest is AirdropBase {
    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event PausedSet(bool paused);
    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount);

    // ── construction ──

    function test_constructorSetsImmutables() public view {
        assertEq(drop.TOKEN(), address(tok));
        assertEq(drop.MERKLE_ROOT(), MerkleTreeLib.root(tree));
        assertEq(drop.GUARDIAN(), guardian);
        assertEq(drop.CLAIM_DEADLINE(), deadline);
        assertEq(drop.POOL(), address(pool));
        assertEq(drop.ASSET_ID(), ASSET);
        assertEq(drop.UNIT_SCALE(), 1e10);
        assertFalse(drop.paused());
    }

    function test_constructorRejectsBadConfig() public {
        bytes32 r = MerkleTreeLib.root(tree);
        address t = address(tok);
        address p = address(pool);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(address(0), r, guardian, deadline, p, ASSET);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(t, bytes32(0), guardian, deadline, p, ASSET);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(t, r, address(0), deadline, p, ASSET);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(t, r, guardian, uint64(block.timestamp), p, ASSET);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(t, r, guardian, deadline, address(0), ASSET);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(t, r, guardian, deadline, p, keccak256("other-asset")); // not registered
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(address(0xCAFE), r, guardian, deadline, p, ASSET); // registered underlying is a different token
        pool.setPoolMinted(false);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(t, r, guardian, deadline, p, ASSET); // an escrow-backed asset would need an allowance
    }

    function test_constructorRejectsAnEoaGuardianAndAFarDeadline() public {
        bytes32 r = MerkleTreeLib.root(tree);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(address(tok), r, address(0xE0A), deadline, address(pool), ASSET); // no code: a mistyped guardian
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(address(tok), r, guardian, uint64(block.timestamp + 401 days), address(pool), ASSET);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(address(tok), r, guardian, uint64(1_790_000_000_000), address(pool), ASSET); // a timestamp in milliseconds
        new TacAirdrop(address(tok), r, guardian, uint64(block.timestamp + 400 days), address(pool), ASSET);
    }

    function test_claimToThePoolAddressIsRefused() public {
        vm.prank(accts[0]);
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.claimTo(0, amts[0], _proof(0), address(pool));
    }

    // ── claim ──

    function test_claimPaysTheAccountWhoeverSubmits() public {
        vm.expectEmit(true, true, false, true);
        emit Claimed(3, accts[3], amts[3]);
        vm.prank(stranger);
        drop.claim(3, accts[3], amts[3], _proof(3));
        assertEq(tok.balanceOf(accts[3]), amts[3]);
        assertEq(tok.balanceOf(stranger), 0);
        assertEq(tok.balanceOf(address(drop)), total - amts[3]);
        assertTrue(drop.isClaimed(3));
        assertFalse(drop.isClaimed(2));
        assertFalse(drop.isClaimed(4));
    }

    function test_everyLeafClaimsOnceAndTheContractEmpties() public {
        for (uint256 i; i < accts.length; ++i) drop.claim(i, accts[i], amts[i], _proof(i));
        assertEq(tok.balanceOf(address(drop)), 0);
        for (uint256 i; i < accts.length; ++i) {
            assertTrue(drop.isClaimed(i));
            assertEq(tok.balanceOf(accts[i]), amts[i]);
        }
    }

    function test_doubleClaimReverts() public {
        drop.claim(1, accts[1], amts[1], _proof(1));
        vm.expectRevert(TacAirdrop.AlreadyClaimed.selector);
        drop.claim(1, accts[1], amts[1], _proof(1));
        vm.prank(accts[1]);
        vm.expectRevert(TacAirdrop.AlreadyClaimed.selector);
        drop.claimTo(1, amts[1], _proof(1), accts[1]);
    }

    function test_wrongLeafFieldsRevert() public {
        bytes32[] memory p = _proof(2);
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(3, accts[2], amts[2], p); // index
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(2, accts[3], amts[2], p); // account
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(2, accts[2], amts[2] + 1, p); // amount
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(2, accts[2], amts[2], _proof(3)); // proof of another leaf
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(2, accts[2], amts[2], new bytes32[](0)); // empty proof
        bytes32[] memory tampered = _proof(2);
        tampered[0] = bytes32(uint256(tampered[0]) ^ 1);
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(2, accts[2], amts[2], tampered);
        assertFalse(drop.isClaimed(2));
    }

    function test_indexOutsideTheTreeReverts() public {
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(10, accts[0], amts[0], _proof(0));
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claim(type(uint256).max, accts[0], amts[0], _proof(0));
    }

    function test_deadlineBoundary() public {
        vm.warp(deadline); // the deadline second itself is still open
        drop.claim(0, accts[0], amts[0], _proof(0));
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(TacAirdrop.ClaimWindowClosed.selector);
        drop.claim(1, accts[1], amts[1], _proof(1));
        vm.prank(accts[1]);
        vm.expectRevert(TacAirdrop.ClaimWindowClosed.selector);
        drop.claimTo(1, amts[1], _proof(1), accts[1]);
        vm.prank(accts[1]);
        vm.expectRevert(TacAirdrop.ClaimWindowClosed.selector);
        drop.claimAndShield(1, amts[1], _proof(1), bytes32(uint256(1)));
    }

    function test_afterTheDeadlineTheGuardianRecoversTheRemainder() public {
        drop.claim(0, accts[0], amts[0], _proof(0));
        vm.warp(uint256(deadline) + 1);
        uint256 left = tok.balanceOf(address(drop));
        vm.prank(guardian);
        drop.sweep(guardian, left);
        assertEq(tok.balanceOf(guardian), left);
        assertEq(tok.balanceOf(address(drop)), 0);
    }

    function test_claimToRecipientsThatCouldNeverReturnTheFundsRevert() public {
        _makeTokenLeaf();
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.claim(0, address(tok), 1e18, new bytes32[](0));
        assertFalse(drop.isClaimed(0));
        vm.prank(address(tok));
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.claimTo(0, 1e18, new bytes32[](0), address(0));
    }

    /// A one-leaf tree whose account is the token contract itself.
    function _makeTokenLeaf() internal {
        drop = new TacAirdrop(address(tok), _leaf(0, address(tok), 1e18), guardian, deadline, address(pool), ASSET);
        tok.mint(address(drop), 1e18);
    }

    // ── claimTo ──

    function test_claimToSendsToTheChosenAddress() public {
        address to = address(0xD00D);
        vm.expectEmit(true, true, false, true);
        emit Claimed(4, accts[4], amts[4]);
        vm.prank(accts[4]);
        drop.claimTo(4, amts[4], _proof(4), to);
        assertEq(tok.balanceOf(to), amts[4]);
        assertEq(tok.balanceOf(accts[4]), 0);
        assertTrue(drop.isClaimed(4));
    }

    function test_claimToIsOnlyForTheEligibleAccount() public {
        vm.prank(stranger);
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claimTo(4, amts[4], _proof(4), stranger);
        vm.prank(accts[5]);
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claimTo(4, amts[4], _proof(4), accts[5]);
        assertFalse(drop.isClaimed(4));
    }

    function test_claimToRejectsBadRecipients() public {
        vm.startPrank(accts[4]);
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.claimTo(4, amts[4], _proof(4), address(0));
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.claimTo(4, amts[4], _proof(4), address(drop));
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.claimTo(4, amts[4], _proof(4), address(tok));
        vm.stopPrank();
        assertFalse(drop.isClaimed(4));
    }

    // ── claimAndShield ──

    function test_claimAndShieldDepositsTheWholeAmountUnderTheSuppliedCommit() public {
        bytes32 commit = keccak256("commit-4");
        bytes32 depositId = keccak256(abi.encodePacked(ASSET, amts[4] / 1e10, commit));
        vm.expectEmit(true, true, false, true, address(drop));
        emit Claimed(4, accts[4], amts[4]);
        vm.expectEmit(true, true, false, true, address(pool));
        emit Wrap(depositId, ASSET, amts[4]);
        vm.prank(accts[4]);
        drop.claimAndShield(4, amts[4], _proof(4), commit);
        assertEq(pool.depositStatus(depositId), 1);
        assertTrue(drop.isClaimed(4));
        assertEq(tok.balanceOf(address(drop)), total - amts[4]);
        assertEq(tok.totalSupply(), total - amts[4]); // burned by the pool, never held by anyone
        assertEq(tok.balanceOf(accts[4]), 0);
        assertEq(tok.balanceOf(address(pool)), 0);
        assertEq(tok.allowance(address(drop), address(pool)), 0);
    }

    function test_claimAndShieldIsOnlyForTheEligibleAccount() public {
        vm.prank(stranger);
        vm.expectRevert(TacAirdrop.BadProof.selector);
        drop.claimAndShield(4, amts[4], _proof(4), bytes32(uint256(7)));
        assertFalse(drop.isClaimed(4));
    }

    function test_claimAndShieldRejectsAZeroCommit() public {
        vm.prank(accts[4]);
        vm.expectRevert(TacAirdrop.ZeroCommit.selector);
        drop.claimAndShield(4, amts[4], _proof(4), bytes32(0));
    }

    function test_claimAndShieldRevertsWholeWhenThePoolFails() public {
        pool.setFailNext(true);
        vm.prank(accts[4]);
        vm.expectRevert(bytes("pool down"));
        drop.claimAndShield(4, amts[4], _proof(4), bytes32(uint256(7)));
        assertFalse(drop.isClaimed(4));
        assertEq(tok.balanceOf(address(drop)), total);
        pool.setFailNext(false);
        vm.prank(accts[4]);
        drop.claimTo(4, amts[4], _proof(4), accts[4]); // the leaf is still claimable in the clear
        assertEq(tok.balanceOf(accts[4]), amts[4]);
    }

    function test_claimAndShieldRepeatedCommitAndValueRevertsWithoutLosingTheLeaf() public {
        // two leaves with equal amounts, so a repeated commit collides on the pool's deposit id
        address a = address(0xA11CE);
        address b = address(0xB0B);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = _leaf(0, a, 5e18);
        leaves[1] = _leaf(1, b, 5e18);
        tree = MerkleTreeLib.build(leaves);
        drop = new TacAirdrop(address(tok), MerkleTreeLib.root(tree), guardian, deadline, address(pool), ASSET);
        tok.mint(address(drop), 10e18);
        vm.prank(a);
        drop.claimAndShield(0, 5e18, _proof(0), bytes32(uint256(9)));
        vm.prank(b);
        vm.expectRevert(MockAirdropPool.DepositExists.selector);
        drop.claimAndShield(1, 5e18, _proof(1), bytes32(uint256(9)));
        assertFalse(drop.isClaimed(1));
        vm.prank(b);
        drop.claimAndShield(1, 5e18, _proof(1), bytes32(uint256(10)));
        assertEq(tok.balanceOf(address(drop)), 0);
    }

    function test_claimAndShieldSubUnitDustRevertsAndStaysClaimable() public {
        address a = address(0xA11CE);
        uint256 dusty = 5e18 + 1;
        drop = new TacAirdrop(address(tok), _leaf(0, a, dusty), guardian, deadline, address(pool), ASSET);
        tok.mint(address(drop), dusty);
        vm.prank(a);
        vm.expectRevert(TacAirdrop.AmountNotAligned.selector);
        drop.claimAndShield(0, dusty, new bytes32[](0), bytes32(uint256(1)));
        assertFalse(drop.isClaimed(0));
        vm.prank(a);
        drop.claimTo(0, dusty, new bytes32[](0), a); // the whole amount, dust included, is still paid in the clear
        assertEq(tok.balanceOf(a), dusty);
        assertEq(tok.balanceOf(address(drop)), 0);
    }

    // ── pause ──

    function test_pauseBlocksEveryClaimPathAndUnpauseRestoresThem() public {
        vm.expectEmit(false, false, false, true);
        emit PausedSet(true);
        vm.prank(guardian);
        drop.pause();
        assertTrue(drop.paused());
        vm.expectRevert(TacAirdrop.Paused.selector);
        drop.claim(0, accts[0], amts[0], _proof(0));
        vm.prank(accts[0]);
        vm.expectRevert(TacAirdrop.Paused.selector);
        drop.claimTo(0, amts[0], _proof(0), accts[0]);
        vm.prank(accts[0]);
        vm.expectRevert(TacAirdrop.Paused.selector);
        drop.claimAndShield(0, amts[0], _proof(0), bytes32(uint256(1)));
        // pausing moves nothing and the guardian can still sweep
        assertEq(tok.balanceOf(address(drop)), total);
        vm.prank(guardian);
        drop.sweep(guardian, 1e18);
        vm.expectEmit(false, false, false, true);
        emit PausedSet(false);
        vm.prank(guardian);
        drop.unpause();
        assertFalse(drop.paused());
        drop.claim(0, accts[0], amts[0], _proof(0));
        assertTrue(drop.isClaimed(0));
    }

    function test_onlyTheGuardianCanPauseAndUnpause() public {
        vm.prank(stranger);
        vm.expectRevert(TacAirdrop.NotGuardian.selector);
        drop.pause();
        vm.prank(guardian);
        drop.pause();
        vm.prank(stranger);
        vm.expectRevert(TacAirdrop.NotGuardian.selector);
        drop.unpause();
        vm.prank(accts[0]);
        vm.expectRevert(TacAirdrop.NotGuardian.selector);
        drop.unpause();
    }

    // ── sweep ──

    function test_guardianSweepsAtAnyTimeAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Swept(address(0x5AFE), 3e18);
        vm.prank(guardian);
        drop.sweep(address(0x5AFE), 3e18);
        assertEq(tok.balanceOf(address(0x5AFE)), 3e18);
        assertEq(tok.balanceOf(address(drop)), total - 3e18);
        vm.prank(guardian);
        drop.sweep(address(0x5AFE), total - 3e18);
        assertEq(tok.balanceOf(address(drop)), 0);
    }

    function test_sweepIsGuardianOnlyAndBounded() public {
        vm.prank(stranger);
        vm.expectRevert(TacAirdrop.NotGuardian.selector);
        drop.sweep(stranger, 1);
        vm.prank(accts[0]);
        vm.expectRevert(TacAirdrop.NotGuardian.selector);
        drop.sweep(accts[0], 1);
        vm.startPrank(guardian);
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.sweep(address(0), 1);
        vm.expectRevert(); // more than the balance
        drop.sweep(guardian, total + 1);
        vm.stopPrank();
        assertEq(tok.balanceOf(address(drop)), total);
    }

    function test_aClaimAfterASweepRevertsWholeAndLeavesTheLeafOpen() public {
        vm.prank(guardian);
        drop.sweep(guardian, total);
        vm.expectRevert();
        drop.claim(0, accts[0], amts[0], _proof(0));
        assertFalse(drop.isClaimed(0));
        tok.mint(address(drop), amts[0]); // topping up makes the same claim work again
        drop.claim(0, accts[0], amts[0], _proof(0));
        assertEq(tok.balanceOf(accts[0]), amts[0]);
    }

    function test_sweepTokenMovesStrayTokensAndEth() public {
        AirdropToken stray = new AirdropToken(address(0));
        stray.mint(address(drop), 7e18);
        vm.expectEmit(true, true, false, true);
        emit TokenSwept(address(stray), guardian, 7e18);
        vm.prank(guardian);
        drop.sweepToken(address(stray), guardian, 7e18);
        assertEq(stray.balanceOf(guardian), 7e18);

        vm.deal(address(drop), 2 ether);
        vm.prank(guardian);
        drop.sweepToken(address(0), address(0xE7E7), 2 ether);
        assertEq(address(0xE7E7).balance, 2 ether);
        assertEq(address(drop).balance, 0);
    }

    function test_sweepTokenIsGuardianOnlyAndNeedsARecipient() public {
        vm.prank(stranger);
        vm.expectRevert(TacAirdrop.NotGuardian.selector);
        drop.sweepToken(address(tok), stranger, 1);
        vm.prank(guardian);
        vm.expectRevert(TacAirdrop.BadRecipient.selector);
        drop.sweepToken(address(tok), address(0), 1);
    }

    function test_theContractTakesNoEther() public {
        (bool ok,) = address(drop).call{value: 1}("");
        assertFalse(ok);
    }

    // ── odd tokens ──

    function test_tokenThatReturnsNothingDoesNotBrickClaimsOrSweeps() public {
        NoReturnToken odd = new NoReturnToken();
        MockAirdropPool p = new MockAirdropPool(ASSET);
        // the pool only reads `underlying`, so the odd token stands in as the airdrop token
        vm.mockCall(address(p), abi.encodeWithSelector(MockAirdropPool.assets.selector, ASSET), abi.encode(true, address(odd), uint256(1e10), bytes32(0), true, uint8(18)));
        TacAirdrop d = new TacAirdrop(address(odd), _leaf(0, accts[0], 1e18), guardian, deadline, address(p), ASSET);
        odd.mint(address(d), 2e18);
        d.claim(0, accts[0], 1e18, new bytes32[](0));
        assertEq(odd.balanceOf(accts[0]), 1e18);
        vm.prank(guardian);
        d.sweep(guardian, 1e18);
        assertEq(odd.balanceOf(guardian), 1e18);
    }

    function test_tokenThatReturnsFalseRevertsCleanly() public {
        FalseReturnToken odd = new FalseReturnToken();
        MockAirdropPool p = new MockAirdropPool(ASSET);
        vm.mockCall(address(p), abi.encodeWithSelector(MockAirdropPool.assets.selector, ASSET), abi.encode(true, address(odd), uint256(1e10), bytes32(0), true, uint8(18)));
        TacAirdrop d = new TacAirdrop(address(odd), _leaf(0, accts[0], 1e18), guardian, deadline, address(p), ASSET);
        odd.mint(address(d), 2e18);
        vm.expectRevert();
        d.claim(0, accts[0], 1e18, new bytes32[](0));
        assertFalse(d.isClaimed(0));
    }

    function test_aStrayNoReturnTokenCanBeSwept() public {
        NoReturnToken odd = new NoReturnToken();
        odd.mint(address(drop), 5);
        vm.prank(guardian);
        drop.sweepToken(address(odd), guardian, 5);
        assertEq(odd.balanceOf(guardian), 5);
    }

    // ── views ──

    function test_verifyAgreesWithClaims() public view {
        assertTrue(drop.verify(6, accts[6], amts[6], _proof(6)));
        assertFalse(drop.verify(6, accts[6], amts[6] + 1, _proof(6)));
        assertFalse(drop.verify(6, accts[7], amts[6], _proof(6)));
        assertFalse(drop.verify(7, accts[6], amts[6], _proof(6)));
    }

    function test_verifyIsIndependentOfClaimedState() public {
        drop.claim(6, accts[6], amts[6], _proof(6));
        assertTrue(drop.verify(6, accts[6], amts[6], _proof(6)));
        assertTrue(drop.isClaimed(6));
    }

    function test_bitmapCrossesWordBoundaries() public {
        _deploy(600);
        uint256[5] memory picks = [uint256(0), 255, 256, 511, 599];
        for (uint256 k; k < picks.length; ++k) {
            uint256 i = picks[k];
            drop.claim(i, accts[i], amts[i], _proof(i));
            assertTrue(drop.isClaimed(i));
        }
        for (uint256 k; k < picks.length; ++k) assertTrue(drop.isClaimed(picks[k]));
        assertFalse(drop.isClaimed(1));
        assertFalse(drop.isClaimed(254));
        assertFalse(drop.isClaimed(257));
        assertFalse(drop.isClaimed(510));
        assertFalse(drop.isClaimed(512));
        assertFalse(drop.isClaimed(598));
    }

    function test_singleLeafTreeUsesAnEmptyProof() public {
        address a = address(0xA11CE);
        drop = new TacAirdrop(address(tok), _leaf(0, a, 3e18), guardian, deadline, address(pool), ASSET);
        tok.mint(address(drop), 3e18);
        drop.claim(0, a, 3e18, new bytes32[](0));
        assertEq(tok.balanceOf(a), 3e18);
    }

    // ── fuzz ──

    function testFuzz_aRandomTreeClaimsExactlyItsLeaves(uint8 count, uint256 seed, uint8 pick) public {
        uint256 n = bound(count, 1, 70);
        bytes32[] memory leaves = new bytes32[](n);
        address[] memory as_ = new address[](n);
        uint256[] memory vs = new uint256[](n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            as_[i] = address(uint160(uint256(keccak256(abi.encode(seed, i))) | 1 << 20));
            vs[i] = (uint256(keccak256(abi.encode(seed, i, "v"))) % 1e9 + 1) * 1e10;
            sum += vs[i];
            leaves[i] = _leaf(i, as_[i], vs[i]);
        }
        bytes32[] memory t = MerkleTreeLib.build(leaves);
        TacAirdrop d = new TacAirdrop(address(tok), MerkleTreeLib.root(t), guardian, deadline, address(pool), ASSET);
        tok.mint(address(d), sum);
        uint256 k = pick % n;
        d.claim(k, as_[k], vs[k], MerkleTreeLib.leafProof(t, k));
        assertEq(tok.balanceOf(as_[k]), vs[k]);
        assertEq(tok.balanceOf(address(d)), sum - vs[k]);
        // a leaf field or a proof word changed by any amount no longer verifies
        uint256 other = (k + 1) % n;
        if (n > 1) assertFalse(d.verify(other, as_[k], vs[k], MerkleTreeLib.leafProof(t, other)));
        assertFalse(d.verify(k, as_[k], vs[k] + 1e10, MerkleTreeLib.leafProof(t, k)));
    }

    function testFuzz_aProofWithAnyWordChangedDoesNotVerify(uint256 flip, uint8 which, uint8 idx) public view {
        uint256 i = idx % 10;
        bytes32[] memory p = _proof(i);
        vm.assume(flip != 0);
        uint256 w = which % p.length;
        p[w] = bytes32(uint256(p[w]) ^ flip);
        assertFalse(drop.verify(i, accts[i], amts[i], p));
    }

    function testFuzz_aProofWithWordsDroppedOrAddedDoesNotVerify(uint8 idx, bytes32 extra) public view {
        uint256 i = idx % 10;
        bytes32[] memory p = _proof(i);
        bytes32[] memory shorter = new bytes32[](p.length - 1);
        for (uint256 j; j < shorter.length; ++j) shorter[j] = p[j];
        assertFalse(drop.verify(i, accts[i], amts[i], shorter));
        bytes32[] memory longer = new bytes32[](p.length + 1);
        for (uint256 j; j < p.length; ++j) longer[j] = p[j];
        longer[p.length] = extra;
        assertFalse(drop.verify(i, accts[i], amts[i], longer));
    }

    function testFuzz_theLeafIsNotAnInternalNode(uint8 idx) public view {
        // a 64-byte node preimage can never stand in as a leaf: the leaf is a hash of a hash
        uint256 i = idx % 10;
        bytes32 asNode = keccak256(abi.encode(i, accts[i], amts[i]));
        assertTrue(asNode != _leaf(i, accts[i], amts[i]));
    }
}

/// Drives a funded airdrop through random claims, sweeps, pauses and clock moves while tracking what was paid.
contract AirdropHandler is Test {
    TacAirdrop public drop;
    AirdropToken public tok;
    MockAirdropPool public pool;
    address public guardian;
    bytes32[] public tree;
    address[] public accts;
    uint256[] public amts;
    uint256 public funded;

    uint256 public claimedTotal;
    uint256 public sweptTotal;
    mapping(uint256 => uint256) public paid; // index => amount paid out through any claim path
    mapping(uint256 => uint256) public claimCount;
    uint256[] public everClaimed;

    constructor(TacAirdrop d, AirdropToken t, MockAirdropPool p, address g, bytes32[] memory tr, address[] memory a, uint256[] memory v, uint256 f) {
        drop = d; tok = t; pool = p; guardian = g; tree = tr; accts = a; amts = v; funded = f;
    }

    function everClaimedLength() external view returns (uint256) { return everClaimed.length; }

    function _record(uint256 i) internal {
        paid[i] += amts[i];
        ++claimCount[i];
        claimedTotal += amts[i];
        everClaimed.push(i);
    }

    function claim(uint256 seed) external {
        uint256 i = seed % accts.length;
        try drop.claim(i, accts[i], amts[i], MerkleTreeLib.leafProof(tree, i)) { _record(i); } catch {}
    }

    function claimTo(uint256 seed, address to) external {
        uint256 i = seed % accts.length;
        vm.prank(accts[i]);
        try drop.claimTo(i, amts[i], MerkleTreeLib.leafProof(tree, i), to) { _record(i); } catch {}
    }

    function claimAndShield(uint256 seed, bytes32 commit) external {
        uint256 i = seed % accts.length;
        vm.prank(accts[i]);
        try drop.claimAndShield(i, amts[i], MerkleTreeLib.leafProof(tree, i), commit) { _record(i); } catch {}
    }

    function claimWrongAmount(uint256 seed, uint256 delta) external {
        uint256 i = seed % accts.length;
        delta = bound(delta, 1, 1e30);
        try drop.claim(i, accts[i], amts[i] + delta, MerkleTreeLib.leafProof(tree, i)) { revert("paid a wrong amount"); } catch {}
    }

    function sweep(uint256 amount) external {
        uint256 bal = tok.balanceOf(address(drop));
        amount = bound(amount, 0, bal);
        vm.prank(guardian);
        drop.sweep(guardian, amount);
        sweptTotal += amount;
    }

    function setPaused(bool p) external {
        vm.prank(guardian);
        if (p) drop.pause(); else drop.unpause();
    }

    function warp(uint256 dt) external { vm.warp(block.timestamp + bound(dt, 0, 20 days)); }
}

contract TacAirdropInvariantTest is AirdropBase {
    AirdropHandler h;

    function setUp() public override {
        _deploy(40);
        h = new AirdropHandler(drop, tok, pool, guardian, tree, accts, amts, total);
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](7);
        sels[0] = AirdropHandler.claim.selector;
        sels[1] = AirdropHandler.claimTo.selector;
        sels[2] = AirdropHandler.claimAndShield.selector;
        sels[3] = AirdropHandler.claimWrongAmount.selector;
        sels[4] = AirdropHandler.sweep.selector;
        sels[5] = AirdropHandler.setPaused.selector;
        sels[6] = AirdropHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    /// claimed + still held + swept never exceeds what was funded (tokens paid to a recipient, shielded or swept all leave the balance).
    function invariant_paidPlusHeldPlusSweptIsWithinFunding() public view {
        assertLe(h.claimedTotal() + tok.balanceOf(address(drop)) + h.sweptTotal(), total);
        assertEq(h.claimedTotal() + tok.balanceOf(address(drop)) + h.sweptTotal(), total);
    }

    function invariant_balanceMatchesTheLedger() public view {
        assertEq(tok.balanceOf(address(drop)), total - h.claimedTotal() - h.sweptTotal());
    }

    function invariant_aClaimedIndexStaysClaimed() public view {
        uint256 n = h.everClaimedLength();
        for (uint256 k; k < n; ++k) assertTrue(drop.isClaimed(h.everClaimed(k)));
    }

    function invariant_anIndexIsPaidAtMostOnceAndOnlyItsLeafAmount() public view {
        for (uint256 i; i < accts.length; ++i) {
            assertLe(h.claimCount(i), 1);
            uint256 p = h.paid(i);
            assertTrue(p == 0 || p == amts[i]);
            assertEq(drop.isClaimed(i), h.claimCount(i) == 1);
        }
    }

    function invariant_configurationNeverMoves() public view {
        assertEq(drop.MERKLE_ROOT(), MerkleTreeLib.root(tree));
        assertEq(drop.GUARDIAN(), guardian);
        assertEq(drop.TOKEN(), address(tok));
        assertEq(drop.CLAIM_DEADLINE(), deadline);
    }

    function invariant_noAllowanceIsEverGranted() public view {
        assertEq(tok.allowance(address(drop), address(pool)), 0);
    }
}
