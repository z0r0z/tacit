// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier} from "../src/TacitBlocks.sol";

/// Accepts every proof: what is under test is the landing rules, not SP1's verifier.
contract AcceptAll is ISP1BlockVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Lands the chain tacit-block's host writes (`tacit-block fixture`): the block program's own public values and
/// lists for a 500-wei ETH shield, then a spend that keeps 380 and exits 120 to an address.
contract TacitBlocksTest is Test {
    TacitBlocks blocks;
    string fx;
    address constant SEQ = address(0x5E9);
    uint256 constant WINDOW = 600;

    function setUp() public {
        fx = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks.json"));
        blocks = deploy(vm.parseJsonBytes32(fx, ".spendVk"));
    }

    function deploy(bytes32 spendVk) internal returns (TacitBlocks) {
        return new TacitBlocks(
            new AcceptAll(), bytes32(uint256(1)), spendVk, SEQ, WINDOW, vm.parseJsonBytes32(fx, ".genesisState"), vm.parseJsonBytes32(fx, ".genesisRoot")
        );
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
        l.outputs = vm.parseJsonBytes(fx, key(b, "outputs"));
        l.memos = vm.parseJsonBytesArray(fx, key(b, "memos"));
        l.nullifiers = vm.parseJsonBytes32Array(fx, key(b, "nullifiers"));
        l.anchors = vm.parseJsonBytes32Array(fx, key(b, "anchors"));
        l.deposits = vm.parseJsonBytes(fx, key(b, "deposits"));
        l.exits = vm.parseJsonBytes(fx, key(b, "exits"));
    }

    function depositFixture() internal {
        uint256 v = vm.parseJsonUint(fx, ".deposit.value");
        blocks.deposit{value: v}(
            address(0), v, vm.parseJsonBytes32(fx, ".deposit.cx"), vm.parseJsonBytes32(fx, ".deposit.cy"), vm.parseJsonBytes32(fx, ".deposit.body")
        );
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
        bytes32[12] memory w;
        w[0] = blocks.state();
        w[1] = keccak256("next");
        w[3] = keccak256("root");
        w[5] = bytes32(l.memos.length);
        w[6] = listHash(1, l.memos.length, l.outputs);
        w[7] = listHash(2, l.nullifiers.length, abi.encodePacked(l.nullifiers));
        w[8] = listHash(3, l.anchors.length, abi.encodePacked(l.anchors));
        w[9] = listHash(4, l.deposits.length / 160, l.deposits);
        w[10] = listHash(5, l.exits.length / 96, l.exits);
        w[11] = blocks.SPEND_VK();
        return abi.encode(w);
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
        assertEq(blocks.owed(address(0), to), 120);
        vm.prank(to);
        blocks.withdraw(address(0));
        assertEq(to.balance, 120);
        assertEq(address(blocks).balance, 380);
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
        vm.prank(SEQ);
        bytes memory p1 = pv(1);
        TacitBlocks.Lists memory l1 = lists(1);
        vm.expectRevert(TacitBlocks.NotOnTop.selector);
        blocks.land(p1, "", l1);
        land(0);
        bytes memory p0 = pv(0);
        TacitBlocks.Lists memory l0 = lists(0);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.NotOnTop.selector);
        blocks.land(p0, "", l0);
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
        l0.memos[0] = bytes.concat(l0.memos[0], "x");
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadMemo.selector, 0));
        blocks.land(p0, "", l0);
        l0 = lists(0);
        l0.outputs[0] = bytes1(uint8(l0.outputs[0]) ^ 1);
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

    function test_anOldAnchorMustBeKnown() public {
        TacitBlocks.Lists memory l;
        l.anchors = new bytes32[](1);
        l.anchors[0] = keccak256("a root no block ended at");
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.UnknownAnchor.selector, l.anchors[0]));
        blocks.land(p, "", l);
        l.anchors[0] = vm.parseJsonBytes32(fx, ".genesisRoot");
        p = craft(l);
        vm.prank(SEQ);
        blocks.land(p, "", l);
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

    function test_depositValues() public {
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit{value: 0}(address(0), 0, 0, 0, 0);
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit{value: 1}(address(0), 2, 0, 0, 0);
        vm.deal(address(this), 2 ** 65);
        vm.expectRevert(TacitBlocks.BadValue.selector);
        blocks.deposit{value: 2 ** 64}(address(0), 2 ** 64, 0, 0, 0);
    }
}
