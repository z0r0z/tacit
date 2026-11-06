// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier, ITurns} from "../src/TacitBlocks.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";

/// Accepts every proof: what is under test is the landing rules, not SP1's verifier.
contract AcceptAll is ISP1BlockVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// A token with `d` decimals, for the unit an asset gets.
contract Token {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 d) {
        decimals = d;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external virtual returns (bool) {
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// Lands the chain tacit-block's host writes (`tacit-block fixture`): the block program's own public values and
/// lists for a shield of 500 units of ETH, then a spend that keeps 380 and exits 120 to an address, then a block of
/// the queue alone, which takes a spend of the 380 posted with `force`. The fixture's spends are bound to the
/// contract at its `lander` on chain 31337, so that is where the test puts it.
contract TacitBlocksTest is Test {
    TacitBlocks blocks;
    ISP1BlockVerifier verifier;
    TacitSeats turns;
    Token tac;
    string fx;
    address constant SEQ = address(0x5E9);
    uint256 constant WINDOW = 600;
    uint256 constant FORCE_DELAY = 1 hours;
    uint256 constant GWEI = 1e9;
    uint256 constant FORCED_REST_AT = 384 + 2080 + 1280 + 3 * 128;

    function setUp() public {
        fx = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks.json"));
        verifier = new AcceptAll();
        tac = new Token(18);
        // no one holds a seat, so SEQ leads every turn
        turns = new TacitSeats(IERC20Seats(address(tac)), 1000e18, 10 minutes, SEQ);
        blocks = deploy(vm.parseJsonBytes32(fx, ".spendVk"));
    }

    function deploy(bytes32 spendVk) internal returns (TacitBlocks) {
        address at = vm.parseJsonAddress(fx, ".lander");
        deployCodeTo("TacitBlocks.sol:TacitBlocks", abi.encode(verifier, bytes32(uint256(1)), spendVk, turns, WINDOW, FORCE_DELAY), at);
        return TacitBlocks(at);
    }

    function key(uint256 b, string memory field) internal pure returns (string memory) {
        return string.concat(".blocks[", vm.toString(b), "].", field);
    }

    function pv(uint256 b) internal view returns (bytes memory) {
        return vm.parseJsonBytes(fx, key(b, "publicValues"));
    }

    function words(uint256 b) internal view returns (bytes32[12] memory) {
        return abi.decode(pv(b), (bytes32[12]));
    }

    function lists(uint256 b) internal view returns (TacitBlocks.Lists memory l) {
        l.leaves = vm.parseJsonBytes(fx, key(b, "leaves"));
        l.memos = vm.parseJsonBytes(fx, key(b, "memos"));
        l.nullifiers = vm.parseJsonBytes32Array(fx, key(b, "nullifiers"));
        l.anchors = vm.parseJsonBytes32Array(fx, key(b, "anchors"));
        l.deposits = vm.parseJsonBytes(fx, key(b, "deposits"));
        l.exits = vm.parseJsonBytes(fx, key(b, "exits"));
    }

    function dep() internal view returns (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) {
        v = vm.parseJsonUint(fx, ".deposit.value");
        cx = vm.parseJsonBytes32(fx, ".deposit.cx");
        cy = vm.parseJsonBytes32(fx, ".deposit.cy");
        body = vm.parseJsonBytes32(fx, ".deposit.body");
    }

    function depositFixture() internal {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        blocks.deposit{value: v * GWEI}(address(0), v, cx, cy, body);
    }

    function land(uint256 b) internal {
        vm.prank(SEQ);
        blocks.land(pv(b), "", lists(b));
    }

    function listHash(uint8 tag, uint256 count, bytes memory items) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("tacit-block-list-v1", tag, uint64(count), items));
    }

    /// Public values for a block on top of the current state that publishes only `l` and moves the queue to `done`
    /// (the verifier here takes any proof, so the landing rules alone decide).
    function craftQ(TacitBlocks.Lists memory l, uint256 done) internal view returns (bytes memory) {
        bytes32[12] memory w = abi.decode(craft(l), (bytes32[12]));
        w[10] = bytes32(done);
        w[11] = blocks.queueHash(done);
        return abi.encode(w);
    }

    /// As `craftQ`, leaving the queue where it is.
    function craft(TacitBlocks.Lists memory l) internal view returns (bytes memory) {
        bytes32[12] memory w;
        w[0] = blocks.state();
        w[1] = keccak256(abi.encode("next", blocks.height()));
        w[2] = blocks.noteRoot();
        w[3] = keccak256(abi.encode("root", blocks.height()));
        uint256 n = l.leaves.length / 32;
        bytes memory items;
        for (uint256 i; i < n; ++i) {
            bytes memory memo = new bytes(128);
            for (uint256 j; j < 128; ++j) {
                memo[j] = l.memos[128 * i + j];
            }
            bytes32 leaf;
            bytes memory leaves = l.leaves;
            assembly {
                leaf := mload(add(add(leaves, 32), mul(32, i)))
            }
            items = bytes.concat(items, leaf, sha256(abi.encodePacked("tacit-block-memo-v1", memo)));
        }
        w[4] = listHash(1, n, items);
        w[5] = listHash(2, l.nullifiers.length, abi.encodePacked(l.nullifiers));
        w[6] = listHash(3, l.anchors.length, abi.encodePacked(l.anchors));
        w[7] = listHash(4, l.deposits.length / 160, l.deposits);
        w[8] = listHash(5, l.exits.length / 96, l.exits);
        w[9] = blocks.SPEND_VK();
        w[10] = bytes32(uint256(blocks.queueDone()));
        w[11] = blocks.queueHash(blocks.queueDone());
        return abi.encode(w);
    }

    /// The publics of a spend with no inputs, outputs, exit or deposit (the identity point (0, 1) for each of those).
    function nothing() internal pure returns (bytes32[12] memory w) {
        w[9] = bytes32(uint256(1));
        w[11] = bytes32(uint256(1));
    }

    /// A payload `force` takes with publics `w`, a zero proof, hints and memos, and the deposit's opening present (of
    /// `value`) or not: the block program passes it over, and what `force` checks is under test.
    function posting(bytes32[12] memory w, bool opened, uint64 value) internal pure returns (bytes memory) {
        bytes memory dep = opened ? bytes.concat(hex"01", bytes8(value), new bytes(32)) : bytes(hex"00");
        return bytes.concat(abi.encodePacked(w), new bytes(FORCED_REST_AT - 384), new bytes(20 + 32), dep, hex"00");
    }

    /// A shield of the fixture's deposit as `force` takes it.
    function shieldPosting() internal view returns (bytes memory) {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32[12] memory w = nothing();
        w[1] = body;
        w[2] = blocks.assetOf(address(0));
        w[10] = cx;
        w[11] = cy;
        return posting(w, true, uint64(v));
    }

    function queueStep(bytes32 before, bytes memory p) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("tacit-block-queue-v1", before, sha256(p)));
    }

    function test_genesisIsTheProgramsBoundHere() public view {
        assertEq(blocks.CHAIN(), vm.parseJsonBytes32(fx, ".chain"), "the binding derived from the chain id and the address");
        assertEq(blocks.state(), vm.parseJsonBytes32(fx, ".genesisState"), "the program's genesis state for it");
        assertEq(blocks.noteRoot(), vm.parseJsonBytes32(fx, ".genesisRoot"));
        assertEq(block.chainid, vm.parseJsonUint(fx, ".chainId"));
    }

    function test_landsTheChain() public {
        depositFixture();
        land(0);
        assertEq(blocks.height(), 1);
        assertEq(blocks.state(), words(0)[1]);
        assertEq(blocks.noteRoot(), words(0)[3]);
        assertTrue(blocks.knownRoot(words(0)[3]));
        land(1);
        assertEq(blocks.height(), 2);
        assertEq(blocks.state(), words(1)[1]);
        address to = vm.parseJsonAddress(fx, ".exit.to");
        assertEq(blocks.owed(address(0), to), 120 * GWEI, "120 units of ETH: 120 gwei");
        vm.prank(address(0xBEEF));
        blocks.withdraw(address(0), to);
        assertEq(to.balance, 120 * GWEI, "anyone sends an exit on, to its address");
        assertEq(address(blocks).balance, 380 * GWEI);
        assertEq(blocks.owed(address(0), to), 0);
        // block 2 takes the queue alone: the spend of the 380 someone posted
        bytes memory forced = vm.parseJsonBytes(fx, ".forced");
        vm.prank(address(0xF0));
        blocks.force(forced);
        assertEq(blocks.queued(), 1);
        assertEq(blocks.queueHash(1), queueStep(bytes32(0), forced), "the queue chains what was posted as the program does");
        assertEq(words(2)[11], blocks.queueHash(1));
        land(2);
        assertEq(blocks.height(), 3);
        assertEq(blocks.queueDone(), 1);
        assertEq(blocks.state(), words(2)[1]);
    }

    function test_aForcedSpendNamesARootABlockEndedAt() public {
        depositFixture();
        land(0);
        bytes memory forced = vm.parseJsonBytes(fx, ".forced");
        bytes32 root = bytes32(this.head(forced));
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.UnknownAnchor.selector, root));
        blocks.force(forced);
        land(1);
        blocks.force(forced);
        assertEq(blocks.queued(), 1);
    }

    function head(bytes calldata p) external pure returns (uint256) {
        return uint256(bytes32(p[0:32]));
    }

    function test_whatForceRefuses() public {
        bytes memory ok = posting(nothing(), false, 0);
        vm.expectRevert(TacitBlocks.BadPayload.selector);
        blocks.force(bytes.concat(ok, new bytes(81)));
        bytes memory short = new bytes(ok.length - 1);
        vm.expectRevert(TacitBlocks.BadPayload.selector);
        blocks.force(short);
        // an exit of an asset never deposited could not be credited when a block takes it
        bytes32[12] memory w = nothing();
        w[2] = keccak256("never deposited");
        w[8] = bytes32(uint256(5));
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.UnknownAsset.selector, w[2]));
        blocks.force(posting(w, false, 0));
        // a deposit is named by its opening, and only its depositor may queue it
        depositFixture();
        bytes memory s = shieldPosting();
        s[FORCED_REST_AT + 52] = 0x00;
        vm.expectRevert(TacitBlocks.BadPayload.selector);
        blocks.force(s);
        s = shieldPosting();
        vm.prank(address(0xBAD));
        vm.expectRevert(TacitBlocks.NotDepositor.selector);
        blocks.force(s);
        bytes memory other = shieldPosting();
        other[FORCED_REST_AT + 60] = bytes1(uint8(other[FORCED_REST_AT + 60]) ^ 1);
        vm.expectRevert(TacitBlocks.NotDepositor.selector);
        blocks.force(other);
        blocks.force(s);
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.force(s);
        // anything else in bounds is queued, for the block program to pass over
        blocks.force(ok);
        assertEq(blocks.queued(), 2);
    }

    function test_aBlockMustReachEveryOverdueEntry() public {
        bytes memory junk = posting(nothing(), false, 0);
        blocks.force(junk);
        TacitBlocks.Lists memory none;
        // a block may leave a young entry for later
        vm.warp(block.timestamp + FORCE_DELAY - 1);
        bytes memory p = craft(none);
        vm.prank(SEQ);
        blocks.land(p, "", none);
        // not an overdue one, whoever lands
        vm.warp(block.timestamp + 1);
        p = craft(none);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.QueueOverdue.selector);
        blocks.land(p, "", none);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(address(0xA11CE));
        vm.expectRevert(TacitBlocks.QueueOverdue.selector);
        blocks.land(p, "", none);
        // a block that reaches it lands
        p = craftQ(none, 1);
        vm.prank(address(0xA11CE));
        blocks.land(p, "", none);
        assertEq(blocks.queueDone(), 1);
    }

    function test_aBlockOfMaxForcedEntriesMayLeaveTheRest() public {
        uint256 n = blocks.MAX_FORCED() + 2;
        for (uint256 i; i < n; ++i) {
            bytes32[12] memory w = nothing();
            w[5] = bytes32(i + 1);
            blocks.force(posting(w, false, 0));
        }
        vm.warp(block.timestamp + FORCE_DELAY);
        TacitBlocks.Lists memory none;
        bytes memory p = craftQ(none, blocks.MAX_FORCED() - 1);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.QueueOverdue.selector);
        blocks.land(p, "", none);
        p = craftQ(none, blocks.MAX_FORCED());
        vm.prank(SEQ);
        blocks.land(p, "", none);
        p = craft(none);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.QueueOverdue.selector);
        blocks.land(p, "", none);
        p = craftQ(none, n);
        vm.prank(SEQ);
        blocks.land(p, "", none);
        assertEq(blocks.queueDone(), n);
    }

    function test_theQueueWordsMustBeTheContracts() public {
        blocks.force(posting(nothing(), false, 0));
        TacitBlocks.Lists memory none;
        bytes32[12] memory w = abi.decode(craftQ(none, 1), (bytes32[12]));
        w[11] = keccak256("another queue");
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.BadQueue.selector);
        blocks.land(abi.encode(w), "", none);
        w = abi.decode(craftQ(none, 1), (bytes32[12]));
        w[10] = bytes32(uint256(2));
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.BadQueue.selector);
        blocks.land(abi.encode(w), "", none);
    }

    function test_aQueuedDepositWaitsForItsEntry() public {
        depositFixture();
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        blocks.force(shieldPosting());
        (,, uint56 forced) = blocks.pending(keccak256(abi.encode(blocks.assetOf(address(0)), v, cx, cy, body)));
        assertEq(forced, 1);
        // neither taken in by another spend nor reclaimed before the chain reaches the entry
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.land(p0, "", l0);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.reclaim(address(0), v, cx, cy, body);
        // the block that reaches the entry takes it in
        TacitBlocks.Lists memory l;
        l.deposits = l0.deposits;
        bytes memory p = craftQ(l, 1);
        vm.prank(SEQ);
        blocks.land(p, "", l);
        vm.expectRevert(TacitBlocks.NotPending.selector);
        blocks.reclaim(address(0), v, cx, cy, body);
    }

    function test_aQueuedDepositPassedOverIsFreeAgain() public {
        depositFixture();
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes memory s = shieldPosting();
        blocks.force(s);
        TacitBlocks.Lists memory none;
        bytes memory p = craftQ(none, 1);
        vm.prank(SEQ);
        blocks.land(p, "", none);
        // its depositor may queue it again, and once the chain is past every entry for it, reclaim it
        blocks.force(s);
        p = craftQ(none, 2);
        vm.prank(SEQ);
        blocks.land(p, "", none);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        uint256 before = address(this).balance;
        blocks.reclaim(address(0), v, cx, cy, body);
        assertEq(address(this).balance - before, v * GWEI);
    }

    receive() external payable {}

    function test_assetFieldIsTheCircuits() public view {
        bytes memory d = lists(0).deposits;
        bytes32 asset;
        assembly {
            asset := mload(add(d, 32))
        }
        assertEq(blocks.assetOf(address(0)), asset);
    }

    function test_onlyOnTopOfTheState() public {
        depositFixture();
        bytes memory p1 = pv(1);
        TacitBlocks.Lists memory l1 = lists(1);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.NotOnTop.selector);
        blocks.land(p1, "", l1);
        land(0);
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.NotOnTop.selector);
        blocks.land(p0, "", l0);
        // a block whose note root before is not the one held, though its state digest is
        TacitBlocks.Lists memory none;
        bytes32[12] memory w = abi.decode(craft(none), (bytes32[12]));
        w[2] = keccak256("another root");
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.NotOnTop.selector);
        blocks.land(abi.encode(w), "", none);
    }

    function test_aShieldNeedsItsDeposit() public {
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NoSuchDeposit.selector, 0));
        blocks.land(p0, "", l0);
    }

    function test_aDepositIsTakenInOnce() public {
        depositFixture();
        land(0);
        TacitBlocks.Lists memory l;
        l.deposits = lists(0).deposits;
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NoSuchDeposit.selector, 0));
        blocks.land(p, "", l);
    }

    function test_memosAndListsMustBeTheCommittedOnes() public {
        depositFixture();
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        l0.memos[5] = bytes1(uint8(l0.memos[5]) ^ 1);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 1));
        blocks.land(p0, "", l0);
        l0 = lists(0);
        l0.memos = bytes.concat(l0.memos, hex"00");
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 1));
        blocks.land(p0, "", l0);
        l0 = lists(0);
        l0.leaves[0] = bytes1(uint8(l0.leaves[0]) ^ 1);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 1));
        blocks.land(p0, "", l0);
        land(0);
        bytes memory p1 = pv(1);
        TacitBlocks.Lists memory l1 = lists(1);
        l1.nullifiers[0] = bytes32(uint256(l1.nullifiers[0]) ^ 1);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 2));
        blocks.land(p1, "", l1);
    }

    function test_theSpendRelationIsPinned() public {
        blocks = deploy(keccak256("another relation"));
        depositFixture();
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.WrongRelation.selector);
        blocks.land(p0, "", l0);
    }

    function test_anOldAnchorMustBeOneABlockEndedAt() public {
        TacitBlocks.Lists memory l;
        l.anchors = new bytes32[](1);
        l.anchors[0] = keccak256("a root no block ended at");
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.UnknownAnchor.selector, l.anchors[0]));
        blocks.land(p, "", l);
        depositFixture();
        land(0);
        l.anchors[0] = words(0)[3];
        p = craft(l);
        vm.prank(SEQ);
        blocks.land(p, "", l);
        assertEq(blocks.height(), 2);
    }

    function test_anExitNeedsADepositedAsset() public {
        TacitBlocks.Lists memory l;
        l.exits = abi.encode(keccak256("never deposited"), uint256(1), uint256(uint160(address(0xBEEF))));
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.UnknownAsset.selector, keccak256("never deposited")));
        blocks.land(p, "", l);
    }

    function test_theSequencerWindowThenAnyone() public {
        depositFixture();
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(address(0xA11CE));
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p0, "", l0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(address(0xA11CE));
        blocks.land(p0, "", l0);
        assertEq(blocks.height(), 1);
    }

    function test_stakersLandInTurn() public {
        address a = address(0xA);
        address b = address(0xB);
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? a : b;
            tac.mint(who, 1000e18);
            vm.startPrank(who);
            tac.approve(address(turns), 1000e18);
            turns.join();
            vm.stopPrank();
        }
        // turns of ten minutes, seat (now / 600) mod 2: a's turn, halfway through it
        uint256 t = 1200 * 100;
        vm.warp(t + 300);
        assertEq(turns.leader(), a);
        depositFixture();
        vm.prank(a);
        blocks.land(pv(0), "", lists(0));
        // within WINDOW of that landing only the turn's leader lands: not the bootstrap, not another seat
        bytes memory p1 = pv(1);
        TacitBlocks.Lists memory l1 = lists(1);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p1, "", l1);
        vm.prank(b);
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p1, "", l1);
        // b's turn
        vm.warp(t + 600);
        assertEq(turns.leader(), b);
        vm.prank(a);
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p1, "", l1);
        vm.prank(b);
        blocks.land(p1, "", l1);
        // and once the chain has gone WINDOW without a block, anyone with one lands
        blocks.force(vm.parseJsonBytes(fx, ".forced"));
        bytes memory p2 = pv(2);
        TacitBlocks.Lists memory l2 = lists(2);
        vm.prank(address(0xF00D));
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p2, "", l2);
        vm.warp(t + 600 + WINDOW);
        vm.prank(address(0xF00D));
        blocks.land(p2, "", l2);
        assertEq(blocks.height(), 3);
    }

    function test_depositValuesAndCommitments() public {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit{value: 0}(address(0), 0, cx, cy, body);
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit{value: v}(address(0), v, cx, cy, body);
        vm.deal(address(this), 2 ** 100);
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit{value: 2 ** 64 * GWEI}(address(0), 2 ** 64, cx, cy, body);
        vm.expectRevert(TacitBlocks.BadCommitment.selector);
        blocks.deposit{value: v * GWEI}(address(0), v, cx, bytes32(uint256(cy) ^ 1), body);
        vm.expectRevert(TacitBlocks.BadCommitment.selector);
        blocks.deposit{value: v * GWEI}(address(0), v, 0, bytes32(uint256(1)), body);
        vm.expectRevert(TacitBlocks.BadCommitment.selector);
        blocks.deposit{value: v * GWEI}(address(0), v, cx, cy, bytes32(type(uint256).max));
        depositFixture();
        vm.expectRevert(TacitBlocks.DepositPending.selector);
        blocks.deposit{value: v * GWEI}(address(0), v, cx, cy, body);
    }

    function test_aDepositNoBlockTookGoesBack() public {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        address alice = address(0xA11CE);
        vm.deal(alice, v * GWEI);
        vm.prank(alice);
        blocks.deposit{value: v * GWEI}(address(0), v, cx, cy, body);
        vm.expectRevert(TacitBlocks.TooSoon.selector);
        blocks.reclaim(address(0), v, cx, cy, body);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        blocks.reclaim(address(0), v, cx, cy, body);
        assertEq(alice.balance, v * GWEI, "back to whoever made it, whoever asks");
        vm.expectRevert(TacitBlocks.NotPending.selector);
        blocks.reclaim(address(0), v, cx, cy, body);
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NoSuchDeposit.selector, 0));
        blocks.land(p0, "", l0);
    }

    function test_tokenUnits() public {
        (, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        Token t18 = new Token(18);
        Token t6 = new Token(6);
        t18.mint(address(this), 5e9);
        t18.approve(address(blocks), type(uint256).max);
        blocks.deposit(address(t18), 5, cx, cy, body);
        assertEq(blocks.unitOf(blocks.assetOf(address(t18))), 1e9, "a unit of an 18-decimal token is 1e9 of its smallest");
        assertEq(t18.balanceOf(address(blocks)), 5e9);
        t6.mint(address(this), 7);
        t6.approve(address(blocks), type(uint256).max);
        blocks.deposit(address(t6), 7, cx, cy, body);
        assertEq(blocks.unitOf(blocks.assetOf(address(t6))), 1, "a 6-decimal token's unit is its smallest");
    }

    function test_tokenUnitsAreBounded() public {
        (, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        Token t36 = new Token(36);
        Token t37 = new Token(37);
        t36.mint(address(this), 1e27);
        t36.approve(address(blocks), type(uint256).max);
        blocks.deposit(address(t36), 1, cx, cy, body);
        assertEq(blocks.unitOf(blocks.assetOf(address(t36))), 1e27);
        t37.mint(address(this), 1);
        t37.approve(address(blocks), type(uint256).max);
        blocks.deposit(address(t37), 1, cx, cy, body);
        assertEq(blocks.unitOf(blocks.assetOf(address(t37))), 1, "past 36 decimals a unit is the smallest, so no exit overflows");
    }

    function test_constructorChecks() public {
        vm.expectRevert(TacitBlocks.BadVerifier.selector);
        new TacitBlocks(ISP1BlockVerifier(address(0x1234)), bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, FORCE_DELAY);
        vm.expectRevert(TacitBlocks.BadTurns.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(SEQ), WINDOW, FORCE_DELAY);
        vm.expectRevert(TacitBlocks.BadWindow.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), 1 days + 1, FORCE_DELAY);
        vm.expectRevert(TacitBlocks.BadForceDelay.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, 10 minutes - 1);
        vm.expectRevert(TacitBlocks.BadForceDelay.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, 1 days + 1);
    }
}
