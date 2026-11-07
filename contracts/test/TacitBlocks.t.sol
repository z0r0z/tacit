// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier, ITurns, IConfidentialPool} from "../src/TacitBlocks.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";

/// Accepts every proof: what is under test is the landing rules, not SP1's verifier.
contract AcceptAll is ISP1BlockVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// A token with `d` decimals that anyone may mint and the confidential pool stand-in burns from.
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

    function burn(address from, uint256 v) external {
        balanceOf[from] -= v;
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

/// The confidential pool as hops see it: TAC registered in its unit and minted by the pool, and `wrap` burning what comes in.
contract ConfidentialStandIn is IConfidentialPool {
    address public immutable tac;
    bytes32 public immutable tacId;
    uint256 public unitScale = 1e10;
    bool public minted = true;
    uint256 public wraps;
    uint256 public lastAmount;
    bytes32 public lastCommit;

    constructor(address t, bytes32 id) {
        tac = t;
        tacId = id;
    }

    function setTerms(uint256 scale, bool mints) external {
        unitScale = scale;
        minted = mints;
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (id == tacId, tac, unitScale, bytes32(0), minted, 18);
    }

    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable {
        require(assetId == tacId && msg.value == 0, "not TAC");
        Token(tac).burn(msg.sender, amount);
        wraps += 1;
        lastAmount = amount;
        lastCommit = commit;
    }
}

/// Lands the chain tacit-block's host writes (`tacit-block fixture`): the block program's own public values and lists for a shield
/// of 500 units of TAC, a spend that keeps 380 and exits 120 to an address, a block of the queue alone that takes a spend of the 380
/// posted with `force`, a spend that hops 300 into the confidential pool keeping 80, and a block of the queue alone that takes a hop
/// of the 80 posted with `force`. The fixture's spends are bound to the contract at its `lander` on chain 31337, so that is where the
/// test puts it, and its TAC is the token at the fixture's `tac`.
contract TacitBlocksTest is Test {
    TacitBlocks blocks;
    ISP1BlockVerifier verifier;
    TacitSeats turns;
    Token tac;
    ConfidentialStandIn pool;
    string fx;
    address constant SEQ = address(0x5E9);
    uint256 constant WINDOW = 600;
    uint256 constant FORCE_DELAY = 1 hours;
    uint256 constant UNIT = 1e10;
    bytes32 constant CTAC = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    uint256 constant FORCED_REST_AT = 384 + 2080 + 1280 + 3 * 128;
    uint256 constant FORCED_MAX = FORCED_REST_AT + 20 + 32 + 2 * 41 + 1 + 265 + 128;

    function setUp() public {
        fx = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks.json"));
        // the time the fixture's blocks name (block 7 names a later one)
        vm.warp(vm.parseJsonUint(fx, ".time"));
        verifier = new AcceptAll();
        deployCodeTo("TacitBlocks.t.sol:Token", abi.encode(uint8(18)), vm.parseJsonAddress(fx, ".tac"));
        tac = Token(vm.parseJsonAddress(fx, ".tac"));
        pool = new ConfidentialStandIn(address(tac), CTAC);
        // no one holds a seat, so SEQ leads every turn
        turns = new TacitSeats(IERC20Seats(address(tac)), 1000e18, 50, SEQ);
        blocks = deploy(vm.parseJsonBytes32(fx, ".spendVk"));
    }

    function deploy(bytes32 spendVk) internal returns (TacitBlocks) {
        address at = vm.parseJsonAddress(fx, ".lander");
        deployCodeTo("TacitBlocks.sol:TacitBlocks", abi.encode(verifier, bytes32(uint256(1)), spendVk, turns, WINDOW, FORCE_DELAY, address(tac), pool, CTAC), at);
        return TacitBlocks(at);
    }

    function key(uint256 b, string memory field) internal pure returns (string memory) {
        return string.concat(".blocks[", vm.toString(b), "].", field);
    }

    function pv(uint256 b) internal view returns (bytes memory) {
        return vm.parseJsonBytes(fx, key(b, "publicValues"));
    }

    function words(uint256 b) internal view returns (bytes32[15] memory) {
        return abi.decode(pv(b), (bytes32[15]));
    }

    function lists(uint256 b) internal view returns (TacitBlocks.Lists memory l) {
        l.leaves = vm.parseJsonBytes(fx, key(b, "leaves"));
        l.memos = vm.parseJsonBytes(fx, key(b, "memos"));
        l.nullifiers = vm.parseJsonBytes32Array(fx, key(b, "nullifiers"));
        l.anchors = vm.parseJsonBytes32Array(fx, key(b, "anchors"));
        l.deposits = vm.parseJsonBytes(fx, key(b, "deposits"));
        l.exits = vm.parseJsonBytes(fx, key(b, "exits"));
        l.hops = vm.parseJsonBytes(fx, key(b, "hops"));
        l.claims = vm.parseJsonBytes(fx, key(b, "claims"));
    }

    function dep() internal view returns (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) {
        v = vm.parseJsonUint(fx, ".deposit.value");
        cx = vm.parseJsonBytes32(fx, ".deposit.cx");
        cy = vm.parseJsonBytes32(fx, ".deposit.cy");
        body = vm.parseJsonBytes32(fx, ".deposit.body");
    }

    function depositFixture() internal {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        tac.mint(address(this), v * UNIT);
        tac.approve(address(blocks), v * UNIT);
        blocks.deposit(v, cx, cy, body);
    }

    function land(uint256 b) internal {
        if (block.timestamp < uint256(words(b)[14])) vm.warp(uint256(words(b)[14]));
        vm.prank(SEQ);
        blocks.land(pv(b), "", lists(b));
    }

    /// The fixture's first three blocks, the queue's entry for block 2 posted.
    function toTheHop() internal {
        depositFixture();
        land(0);
        land(1);
        blocks.force(vm.parseJsonBytes(fx, ".forced"));
        land(2);
    }

    function listHash(uint8 tag, uint256 count, bytes memory items) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("tacit-block-list-v1", tag, uint64(count), items));
    }

    /// Public values for a block on top of the current state that publishes only `l` and moves the queue to `done`
    /// (the verifier here takes any proof, so the landing rules alone decide).
    function craftQ(TacitBlocks.Lists memory l, uint256 done) internal view returns (bytes memory) {
        bytes32[15] memory w = abi.decode(craft(l), (bytes32[15]));
        w[10] = bytes32(done);
        w[11] = blocks.queueHash(done);
        return abi.encode(w);
    }

    /// As `craftQ`, leaving the queue where it is.
    function craft(TacitBlocks.Lists memory l) internal view returns (bytes memory) {
        bytes32[15] memory w;
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
        w[12] = listHash(6, l.hops.length / 96, l.hops);
        w[13] = listHash(7, l.claims.length / 64, l.claims);
        w[14] = bytes32(block.timestamp);
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
        bytes memory d = opened ? bytes.concat(hex"01", bytes8(value), new bytes(32)) : bytes(hex"00");
        return bytes.concat(abi.encodePacked(w), new bytes(FORCED_REST_AT - 384), new bytes(20 + 32), d, hex"00");
    }

    /// A shield of the fixture's deposit as `force` takes it.
    function shieldPosting() internal view returns (bytes memory) {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32[12] memory w = nothing();
        w[1] = body;
        w[2] = blocks.TAC_ASSET();
        w[10] = cx;
        w[11] = cy;
        return posting(w, true, uint64(v));
    }

    function queueStep(bytes32 before, bytes memory p) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("tacit-block-queue-v1", before, sha256(p)));
    }

    function head(bytes calldata p) external pure returns (uint256) {
        return uint256(bytes32(p[0:32]));
    }

    function hopKey(uint256 value, bytes32 commit) internal pure returns (bytes32) {
        return keccak256(abi.encode(value, commit));
    }

    function test_genesisIsTheProgramsBoundHere() public view {
        assertEq(blocks.CHAIN(), vm.parseJsonBytes32(fx, ".chain"), "the binding derived from the chain id and the address");
        assertEq(blocks.state(), vm.parseJsonBytes32(fx, ".genesisState"), "the program's genesis state for it");
        assertEq(blocks.noteRoot(), vm.parseJsonBytes32(fx, ".genesisRoot"));
        assertEq(block.chainid, vm.parseJsonUint(fx, ".chainId"));
    }

    function test_landsTheChain() public {
        depositFixture();
        assertEq(tac.balanceOf(address(blocks)), 500 * UNIT);
        land(0);
        assertEq(blocks.height(), 1);
        assertEq(blocks.state(), words(0)[1]);
        assertEq(blocks.noteRoot(), words(0)[3]);
        assertTrue(blocks.knownRoot(words(0)[3]));
        land(1);
        assertEq(blocks.height(), 2);
        assertEq(blocks.state(), words(1)[1]);
        address to = vm.parseJsonAddress(fx, ".exit.to");
        assertEq(blocks.owed(to), 120 * UNIT, "120 units: 120 x 10^-8 TAC");
        vm.prank(address(0xBEEF));
        blocks.withdraw(to);
        assertEq(tac.balanceOf(to), 120 * UNIT, "anyone sends an exit on, to its address");
        assertEq(tac.balanceOf(address(blocks)), 380 * UNIT);
        assertEq(blocks.owed(to), 0);
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

    /// Block 3 hops 300 into the confidential pool and block 4 takes a hop of the 80 posted to the queue: each is kept until anyone
    /// sends it on, which the pool takes as its deposit for the hop's commitment, burning the TAC.
    function test_hopsGoIntoTheConfidentialPool() public {
        toTheHop();
        uint256 v = vm.parseJsonUint(fx, ".hop.value");
        bytes32 commit = vm.parseJsonBytes32(fx, ".hop.commit");
        vm.expectRevert(TacitBlocks.NoSuchHop.selector);
        blocks.sendHop(v, commit);
        land(3);
        assertEq(blocks.hops(hopKey(v, commit)), 1);
        vm.prank(address(0xBEEF));
        blocks.sendHop(v, commit);
        assertEq(pool.wraps(), 1);
        assertEq(pool.lastAmount(), 300 * UNIT, "the hop's value in the pool's unit, unchanged");
        assertEq(pool.lastCommit(), commit);
        // 500 in, 120 owed to the exit's address, 300 gone into the pool
        assertEq(tac.balanceOf(address(blocks)), 200 * UNIT);
        vm.expectRevert(TacitBlocks.NoSuchHop.selector);
        blocks.sendHop(v, commit);
        // the 80 hops in through the queue
        bytes memory forced = vm.parseJsonBytes(fx, ".forcedHop");
        blocks.force(forced);
        land(4);
        assertEq(blocks.queueDone(), 2);
        blocks.sendHop(vm.parseJsonUint(fx, ".hop2.value"), vm.parseJsonBytes32(fx, ".hop2.commit"));
        assertEq(pool.lastAmount(), 80 * UNIT);
        assertEq(tac.balanceOf(address(blocks)), 120 * UNIT, "only the exit's credit is left");
        blocks.withdraw(vm.parseJsonAddress(fx, ".exit.to"));
        assertEq(tac.balanceOf(address(blocks)), 0);
    }

    function test_hopsMustBeTheCommittedOnes() public {
        toTheHop();
        bytes memory p3 = pv(3);
        TacitBlocks.Lists memory l3 = lists(3);
        assertEq(l3.hops.length, 96);
        l3.hops[95] = bytes1(uint8(l3.hops[95]) ^ 1);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 6));
        blocks.land(p3, "", l3);
        l3 = lists(3);
        l3.hops = bytes.concat(l3.hops, hex"00");
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 6));
        blocks.land(p3, "", l3);
        l3.hops = "";
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 6));
        blocks.land(p3, "", l3);
        // a hop of another asset could never be sent on
        TacitBlocks.Lists memory l;
        l.hops = abi.encode(keccak256("not TAC"), uint256(1), bytes32(uint256(7)));
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NotTac.selector, keccak256("not TAC")));
        blocks.land(p, "", l);
        land(3);
        assertEq(blocks.height(), 4);
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

    function test_whatForceRefuses() public {
        bytes memory ok = posting(nothing(), false, 0);
        vm.expectRevert(TacitBlocks.BadPayload.selector);
        blocks.force(bytes.concat(ok, new bytes(FORCED_MAX - ok.length + 1)));
        bytes memory short = new bytes(ok.length - 1);
        vm.expectRevert(TacitBlocks.BadPayload.selector);
        blocks.force(short);
        // an exit (or a hop) of anything but TAC could not be paid when a block takes it
        bytes32[12] memory w = nothing();
        w[2] = keccak256("not TAC");
        w[8] = bytes32(uint256(5));
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NotTac.selector, w[2]));
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
        blocks.force(bytes.concat(ok, new bytes(FORCED_MAX - ok.length)));
        assertEq(blocks.queued(), 3);
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
        bytes32[15] memory w = abi.decode(craftQ(none, 1), (bytes32[15]));
        w[11] = keccak256("another queue");
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.BadQueue.selector);
        blocks.land(abi.encode(w), "", none);
        w = abi.decode(craftQ(none, 1), (bytes32[15]));
        w[10] = bytes32(uint256(2));
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.BadQueue.selector);
        blocks.land(abi.encode(w), "", none);
    }

    function test_aQueuedDepositWaitsForItsEntry() public {
        depositFixture();
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        blocks.force(shieldPosting());
        (,, uint56 forced) = blocks.pending(keccak256(abi.encode(blocks.TAC_ASSET(), v, cx, cy, body)));
        assertEq(forced, 1);
        // neither taken in by another spend nor reclaimed before the chain reaches the entry
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.land(p0, "", l0);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.reclaim(v, cx, cy, body);
        // the block that reaches the entry takes it in
        TacitBlocks.Lists memory l;
        l.deposits = l0.deposits;
        bytes memory p = craftQ(l, 1);
        vm.prank(SEQ);
        blocks.land(p, "", l);
        vm.expectRevert(TacitBlocks.NotPending.selector);
        blocks.reclaim(v, cx, cy, body);
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
        uint256 before = tac.balanceOf(address(this));
        blocks.reclaim(v, cx, cy, body);
        assertEq(tac.balanceOf(address(this)) - before, v * UNIT);
    }

    function test_assetFieldIsTheCircuits() public view {
        bytes memory d = lists(0).deposits;
        bytes32 asset;
        assembly {
            asset := mload(add(d, 32))
        }
        assertEq(blocks.TAC_ASSET(), asset);
        assertEq(blocks.assetOf(address(tac)), asset);
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
        bytes32[15] memory w = abi.decode(craft(none), (bytes32[15]));
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

    function test_anExitMustBeTac() public {
        TacitBlocks.Lists memory l;
        l.exits = abi.encode(keccak256("not TAC"), uint256(1), uint256(uint160(address(0xBEEF))));
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NotTac.selector, keccak256("not TAC")));
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

    /// Two holders' seats in the draw: the start of the next epoch, its seed set.
    function twoSeats(address a, address b) internal returns (uint256 e, uint256 epochBlocks) {
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? a : b;
            tac.mint(who, 1000e18);
            vm.startPrank(who);
            tac.approve(address(turns), 1000e18);
            turns.join();
            vm.stopPrank();
        }
        epochBlocks = turns.SLOT_BLOCKS() * turns.EPOCH_SLOTS();
        e = block.number / epochBlocks + 1;
        vm.roll(e * epochBlocks);
        vm.setBlockhash(e * epochBlocks - 1, keccak256("an epoch's seed"));
    }

    function test_stakersLandInTurn() public {
        address a = address(0xA);
        address b = address(0xB);
        (uint256 e, uint256 epochBlocks) = twoSeats(a, b);
        address lead = turns.leader();
        assertTrue(lead == a || lead == b);
        address other = lead == a ? b : a;
        depositFixture();
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        // within WINDOW of the last landing only the turn's leader lands: not the bootstrap, not another seat
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p0, "", l0);
        vm.prank(other);
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p0, "", l0);
        vm.prank(lead);
        blocks.land(p0, "", l0);
        assertEq(turns.seedOf(e), keccak256("an epoch's seed"), "landing keeps the epoch's seed");
        // a later turn of the other seat
        uint256 slot = turns.SLOT_BLOCKS();
        uint256 j = 1;
        while (j < turns.EPOCH_SLOTS() && turns.leaderAt(e * epochBlocks + j * slot) != other) ++j;
        assertLt(j, turns.EPOCH_SLOTS(), "the other seat leads a turn of the epoch");
        vm.roll(e * epochBlocks + j * slot);
        bytes memory p1 = pv(1);
        TacitBlocks.Lists memory l1 = lists(1);
        vm.prank(lead);
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p1, "", l1);
        vm.prank(other);
        blocks.land(p1, "", l1);
        // and once the chain has gone WINDOW without a block, anyone with one lands
        blocks.force(vm.parseJsonBytes(fx, ".forced"));
        bytes memory p2 = pv(2);
        TacitBlocks.Lists memory l2 = lists(2);
        vm.prank(address(0xF00D));
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p2, "", l2);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(address(0xF00D));
        blocks.land(p2, "", l2);
        assertEq(blocks.height(), 3);
    }

    function test_aTurnNoOneLeadsIsAnyones() public {
        (uint256 e, uint256 epochBlocks) = twoSeats(address(0xA), address(0xB));
        // the epoch's seed was never kept and its block hash is out of reach: no one leads
        vm.roll(e * epochBlocks + 300);
        assertEq(turns.leader(), address(0));
        depositFixture();
        vm.prank(SEQ);
        blocks.land(pv(0), "", lists(0));
        bytes memory p1 = pv(1);
        TacitBlocks.Lists memory l1 = lists(1);
        vm.prank(address(0xF00D));
        blocks.land(p1, "", l1);
        assertEq(blocks.height(), 2);
    }

    function test_depositValuesAndCommitments() public {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        tac.mint(address(this), 2 ** 70 * UNIT);
        tac.approve(address(blocks), type(uint256).max);
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit(0, cx, cy, body);
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit(2 ** 64, cx, cy, body);
        vm.expectRevert(TacitBlocks.BadCommitment.selector);
        blocks.deposit(v, cx, bytes32(uint256(cy) ^ 1), body);
        vm.expectRevert(TacitBlocks.BadCommitment.selector);
        blocks.deposit(v, 0, bytes32(uint256(1)), body);
        vm.expectRevert(TacitBlocks.BadCommitment.selector);
        blocks.deposit(v, cx, cy, bytes32(type(uint256).max));
        blocks.deposit(v, cx, cy, body);
        vm.expectRevert(TacitBlocks.DepositPending.selector);
        blocks.deposit(v, cx, cy, body);
        // without TAC approved nothing is taken
        vm.prank(address(0xA11CE));
        vm.expectRevert();
        blocks.deposit(v + 1, cx, cy, body);
    }

    function test_aDepositNoBlockTookGoesBack() public {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        address alice = address(0xA11CE);
        tac.mint(alice, v * UNIT);
        vm.startPrank(alice);
        tac.approve(address(blocks), v * UNIT);
        blocks.deposit(v, cx, cy, body);
        vm.stopPrank();
        vm.expectRevert(TacitBlocks.TooSoon.selector);
        blocks.reclaim(v, cx, cy, body);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        blocks.reclaim(v, cx, cy, body);
        assertEq(tac.balanceOf(alice), v * UNIT, "back to whoever made it, whoever asks");
        vm.expectRevert(TacitBlocks.NotPending.selector);
        blocks.reclaim(v, cx, cy, body);
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.warp(vm.parseJsonUint(fx, ".time"));
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.NoSuchDeposit.selector, 0));
        blocks.land(p0, "", l0);
    }

    function lockDeposits() internal {
        for (uint256 i; i < 2; ++i) {
            string memory d = string.concat(".lockDeposits[", vm.toString(i), "]");
            uint256 v = vm.parseJsonUint(fx, string.concat(d, ".value"));
            tac.mint(address(this), v * UNIT);
            tac.approve(address(blocks), v * UNIT);
            blocks.deposit(v, vm.parseJsonBytes32(fx, string.concat(d, ".cx")), vm.parseJsonBytes32(fx, string.concat(d, ".cy")), vm.parseJsonBytes32(fx, string.concat(d, ".body")));
        }
    }

    /// The fixture through its hops, then two deposits straight into locks (block 5), the recipient's claim of the first (block 6,
    /// publishing its signature) and a refund of the second posted to the queue (block 7, naming its deadline).
    function test_locksClaimsAndRefunds() public {
        toTheHop();
        land(3);
        blocks.force(vm.parseJsonBytes(fx, ".forcedHop"));
        land(4);
        lockDeposits();
        land(5);
        land(6);
        assertEq(lists(6).claims, vm.parseJsonBytes(fx, ".claimSig"), "the claim's signature is published for the swap's counterparty");
        bytes memory refund = vm.parseJsonBytes(fx, ".forcedRefund");
        vm.prank(address(0xF00D));
        blocks.force(refund);
        land(7);
        assertEq(blocks.height(), 8);
        assertEq(blocks.queueDone(), 3);
        // what stays on the chain: 120 owed to the exit, 300 + 80 to send into the pool, 1,000 claimed and 500 refunded as notes
        assertEq(tac.balanceOf(address(blocks)), (120 + 380 + 1_500) * UNIT);
    }

    function test_aBlockLandsWithinItsTime() public {
        depositFixture();
        uint256 t = uint256(words(0)[14]);
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.warp(t - 1);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.BadTime.selector);
        blocks.land(p0, "", l0);
        vm.warp(t + blocks.TIME_WINDOW() + 1);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.BadTime.selector);
        blocks.land(p0, "", l0);
        vm.warp(t + blocks.TIME_WINDOW());
        vm.prank(SEQ);
        blocks.land(p0, "", l0);
        assertEq(blocks.height(), 1);
    }

    function test_claimsMustBeTheCommittedOnes() public {
        toTheHop();
        land(3);
        blocks.force(vm.parseJsonBytes(fx, ".forcedHop"));
        land(4);
        lockDeposits();
        land(5);
        bytes memory p6 = pv(6);
        TacitBlocks.Lists memory l6 = lists(6);
        l6.claims[63] = bytes1(uint8(l6.claims[63]) ^ 1);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 7));
        blocks.land(p6, "", l6);
        l6.claims = "";
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 7));
        blocks.land(p6, "", l6);
        land(6);
    }

    /// A claim or refund is posted only at its exact size and against a root a block ended at.
    function test_whatForceRefusesOfASettle() public {
        bytes memory refund = vm.parseJsonBytes(fx, ".forcedRefund");
        bytes32 root;
        assembly {
            root := mload(add(add(refund, 32), 313))
        }
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.UnknownAnchor.selector, root));
        blocks.force(refund);
        vm.expectRevert(TacitBlocks.BadPayload.selector);
        blocks.force(bytes.concat(refund, hex"00"));
    }

    function test_constructorChecks() public {
        vm.expectRevert(TacitBlocks.BadVerifier.selector);
        new TacitBlocks(ISP1BlockVerifier(address(0x1234)), bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, FORCE_DELAY, address(tac), pool, CTAC);
        vm.expectRevert(TacitBlocks.BadTurns.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(SEQ), WINDOW, FORCE_DELAY, address(tac), pool, CTAC);
        vm.expectRevert(TacitBlocks.BadWindow.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), 1 days + 1, FORCE_DELAY, address(tac), pool, CTAC);
        vm.expectRevert(TacitBlocks.BadForceDelay.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, 10 minutes - 1, address(tac), pool, CTAC);
        vm.expectRevert(TacitBlocks.BadForceDelay.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, 1 days + 1, address(tac), pool, CTAC);
        vm.expectRevert(TacitBlocks.BadToken.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, FORCE_DELAY, address(0x7AC), pool, CTAC);
        // the pool must count TAC in this chain's unit and mint it, under the id given
        vm.expectRevert(TacitBlocks.BadPool.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, FORCE_DELAY, address(tac), pool, keccak256("another id"));
        pool.setTerms(1e9, true);
        vm.expectRevert(TacitBlocks.BadPool.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, FORCE_DELAY, address(tac), pool, CTAC);
        pool.setTerms(1e10, false);
        vm.expectRevert(TacitBlocks.BadPool.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), ITurns(address(turns)), WINDOW, FORCE_DELAY, address(tac), pool, CTAC);
    }
}
