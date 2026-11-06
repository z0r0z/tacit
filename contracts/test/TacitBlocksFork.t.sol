// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier} from "../src/TacitBlocks.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";

/// The chain `tacit-block fixture test/fixtures/tacit-blocks-mainnet.json 1 <lander>` writes, landed on a mainnet fork with the
/// block program's real Groth16 proofs (tacit-block-gpu --groth16 on each FILE.b<i>.stdin, kept as FILE.b<i>.stdin.groth16) through
/// the SP1 v6.1.0 Groth16 verifier the pool uses: a shield, a spend with an exit, and a block of the queue alone that takes a spend
/// posted with `force`. Skipped unless TACIT_BLOCKS_FORK_RPC names an Ethereum node and the proofs exist.
contract TacitBlocksForkTest is Test {
    address constant SP1_GROTH16_V6_1_0 = 0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2;
    /// The TAC ERC-20 on Ethereum.
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    /// `cargo prove vkey --elf contracts/sp1/confidential/tacit-block/elf/tacit-block`
    bytes32 constant BLOCK_VKEY = 0x00eca3f04c5b16c739d3f11bb7829513251a602fdd1d048935e3654b4c9b73bc;
    address constant SEQ = address(0x5E9);
    uint256 constant GWEI = 1e9;

    string path;
    string fx;
    TacitBlocks blocks;
    bool ready;

    function setUp() public {
        path = string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks-mainnet.json");
        string memory rpc = vm.envOr("TACIT_BLOCKS_FORK_RPC", string(""));
        if (bytes(rpc).length == 0 || !vm.exists(string.concat(path, ".b2.stdin.groth16"))) return;
        vm.createSelectFork(rpc);
        fx = vm.readFile(path);
        address at = vm.parseJsonAddress(fx, ".lander");
        // no seat is held on the fork, so SEQ leads every turn
        TacitSeats turns = new TacitSeats(IERC20Seats(TAC), 1000e18, 10 minutes, SEQ);
        deployCodeTo("TacitBlocks.sol:TacitBlocks", abi.encode(SP1_GROTH16_V6_1_0, BLOCK_VKEY, vm.parseJsonBytes32(fx, ".spendVk"), turns, uint256(600), uint256(1 hours)), at);
        blocks = TacitBlocks(at);
        ready = true;
    }

    function proof(uint256 b) internal returns (bytes memory pf, bytes memory pv) {
        string memory f = string.concat(path, ".b", vm.toString(b), ".stdin.groth16");
        pf = vm.parseBytes(vm.readLine(f));
        pv = vm.parseBytes(vm.readLine(f));
        vm.closeFile(f);
    }

    function key(uint256 b, string memory field) internal pure returns (string memory) {
        return string.concat(".blocks[", vm.toString(b), "].", field);
    }

    function lists(uint256 b) internal view returns (TacitBlocks.Lists memory l) {
        l.leaves = vm.parseJsonBytes(fx, key(b, "leaves"));
        l.memos = vm.parseJsonBytes(fx, key(b, "memos"));
        l.nullifiers = vm.parseJsonBytes32Array(fx, key(b, "nullifiers"));
        l.anchors = vm.parseJsonBytes32Array(fx, key(b, "anchors"));
        l.deposits = vm.parseJsonBytes(fx, key(b, "deposits"));
        l.exits = vm.parseJsonBytes(fx, key(b, "exits"));
    }

    /// What a transaction carrying `data` that spends `exec` gas executing pays in all: 21,000, calldata at 4 gas per
    /// token (a zero byte one token, any other four), or the EIP-7623 floor of 10 per token when that is more.
    function txGas(bytes memory data, uint256 exec) internal pure returns (uint256) {
        uint256 tokens;
        for (uint256 i; i < data.length; ++i) {
            tokens += data[i] == 0 ? 1 : 4;
        }
        uint256 standard = 4 * tokens + exec;
        return 21000 + (standard > 10 * tokens ? standard : 10 * tokens);
    }

    function report(string memory what, bytes memory data, uint256 exec) internal {
        emit log_named_uint(string.concat(what, ": execution gas"), exec);
        emit log_named_uint(string.concat(what, ": transaction gas, calldata included"), txGas(data, exec));
    }

    /// Lands fixture block `b` with its real proof, its gas measured apart from reading the fixture.
    function landReal(uint256 b, string memory what) internal {
        (bytes memory pf, bytes memory pv) = proof(b);
        assertEq(pv, vm.parseJsonBytes(fx, key(b, "publicValues")), "the proof commits the fixture's public values");
        TacitBlocks.Lists memory l = lists(b);
        bytes memory data = abi.encodeCall(TacitBlocks.land, (pv, pf, l));
        vm.prank(SEQ);
        uint256 g = gasleft();
        blocks.land(pv, pf, l);
        report(string.concat("land block ", vm.toString(b), " (", what, ")"), data, g - gasleft());
    }

    function test_realBlocksLandThroughTheRealVerifier() public {
        if (!ready) return;
        assertEq(block.chainid, 1);
        assertEq(blocks.CHAIN(), vm.parseJsonBytes32(fx, ".chain"), "the binding the fixture's spends carry");
        assertEq(blocks.state(), vm.parseJsonBytes32(fx, ".genesisState"));
        uint256 v = vm.parseJsonUint(fx, ".deposit.value");
        blocks.deposit{value: v * GWEI}(address(0), v, vm.parseJsonBytes32(fx, ".deposit.cx"), vm.parseJsonBytes32(fx, ".deposit.cy"), vm.parseJsonBytes32(fx, ".deposit.body"));

        // the real verifier refuses a proof for other public values
        (bytes memory pf0, bytes memory pv0) = proof(0);
        TacitBlocks.Lists memory l0 = lists(0);
        bytes memory bad = bytes.concat(pv0);
        bad[31] = bytes1(uint8(bad[31]) ^ 1);
        vm.prank(SEQ);
        vm.expectRevert();
        blocks.land(bad, pf0, l0);

        landReal(0, "one shield");
        landReal(1, "one spend with an exit");
        assertEq(blocks.height(), 2);
        address to = vm.parseJsonAddress(fx, ".exit.to");
        uint256 before = to.balance;
        blocks.withdraw(address(0), to);
        assertEq(to.balance - before, 120 * GWEI, "the exit is paid");

        bytes memory forced = vm.parseJsonBytes(fx, ".forced");
        bytes memory data = abi.encodeCall(TacitBlocks.force, (forced));
        vm.prank(address(0xF0));
        uint256 g = gasleft();
        blocks.force(forced);
        report("post a spend to the queue", data, g - gasleft());
        landReal(2, "the queue alone: one forced spend");
        assertEq(blocks.height(), 3);
        assertEq(blocks.queueDone(), 1);
    }
}
