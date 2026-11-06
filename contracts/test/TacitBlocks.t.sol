// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier} from "../src/TacitBlocks.sol";

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

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// Lands the chain tacit-block's host writes (`tacit-block fixture`): the block program's own public values and
/// lists for a shield of 500 units of ETH, then a spend that keeps 380 and exits 120 to an address. The fixture's
/// spends are bound to the contract at its `lander` on chain 31337, so that is where the test puts it.
contract TacitBlocksTest is Test {
    TacitBlocks blocks;
    ISP1BlockVerifier verifier;
    string fx;
    address constant SEQ = address(0x5E9);
    uint256 constant WINDOW = 600;
    uint256 constant GWEI = 1e9;

    function setUp() public {
        fx = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks.json"));
        verifier = new AcceptAll();
        blocks = deploy(vm.parseJsonBytes32(fx, ".spendVk"));
    }

    function deploy(bytes32 spendVk) internal returns (TacitBlocks) {
        address at = vm.parseJsonAddress(fx, ".lander");
        deployCodeTo("TacitBlocks.sol:TacitBlocks", abi.encode(verifier, bytes32(uint256(1)), spendVk, SEQ, WINDOW), at);
        return TacitBlocks(at);
    }

    function key(uint256 b, string memory field) internal pure returns (string memory) {
        return string.concat(".blocks[", vm.toString(b), "].", field);
    }

    function pv(uint256 b) internal view returns (bytes memory) {
        return vm.parseJsonBytes(fx, key(b, "publicValues"));
    }

    function words(uint256 b) internal view returns (bytes32[10] memory) {
        return abi.decode(pv(b), (bytes32[10]));
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

    /// Public values for a block on top of the current state that publishes only `l` (the verifier here takes
    /// any proof, so the landing rules alone decide).
    function craft(TacitBlocks.Lists memory l) internal view returns (bytes memory) {
        bytes32[10] memory w;
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
        return abi.encode(w);
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
    }

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
        bytes32[10] memory w = abi.decode(craft(none), (bytes32[10]));
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
        vm.expectRevert(TacitBlocks.SequencerWindow.selector);
        blocks.land(p0, "", l0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(address(0xA11CE));
        blocks.land(p0, "", l0);
        assertEq(blocks.height(), 1);
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

    function test_constructorChecks() public {
        vm.expectRevert(TacitBlocks.BadVerifier.selector);
        new TacitBlocks(ISP1BlockVerifier(address(0x1234)), bytes32(0), bytes32(0), SEQ, WINDOW);
        vm.expectRevert(TacitBlocks.BadWindow.selector);
        new TacitBlocks(verifier, bytes32(0), bytes32(0), SEQ, 1 days + 1);
    }
}
