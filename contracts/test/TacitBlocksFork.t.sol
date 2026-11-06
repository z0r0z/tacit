// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier} from "../src/TacitBlocks.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";
import {Token} from "./TacitBlocks.t.sol";

/// The chain `tacit-block fixture test/fixtures/tacit-blocks-mainnet.json 1 <lander>` writes, landed on a mainnet fork with the
/// block program's real Groth16 proofs (tacit-block-gpu --groth16 on each FILE.b<i>.stdin, kept as FILE.b<i>.stdin.groth16) through
/// the SP1 v6.1.0 Groth16 verifier the pool uses: a shield, a spend with an exit, a block of the queue alone that takes a spend posted
/// with `force`, a pool of ETH and a token made from two deposits, swaps both ways from deposits (one limit missed and sent back), and
/// half the pool's shares taken out by a posted spend beside a spend that exits the token the ETH bought. Skipped unless
/// TACIT_BLOCKS_FORK_RPC names an Ethereum node and the proofs exist.
contract TacitBlocksForkTest is Test {
    address constant SP1_GROTH16_V6_1_0 = 0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2;
    /// The TAC ERC-20 on Ethereum.
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    /// `cargo prove vkey --elf contracts/sp1/confidential/tacit-block/elf/tacit-block`
    bytes32 constant BLOCK_VKEY = 0x00fd2dda9a4db3b4decaa533108818f93ca34ec09c4664cc9416800a79f3f21b;
    address constant SEQ = address(0x5E9);
    uint256 constant GWEI = 1e9;

    string path;
    string fx;
    TacitBlocks blocks;
    bool ready;

    function setUp() public {
        path = string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks-mainnet.json");
        string memory rpc = vm.envOr("TACIT_BLOCKS_FORK_RPC", string(""));
        if (bytes(rpc).length == 0 || !vm.exists(string.concat(path, ".b5.stdin.groth16"))) return;
        vm.createSelectFork(rpc);
        fx = vm.readFile(path);
        address at = vm.parseJsonAddress(fx, ".lander");
        // no seat is held on the fork, so SEQ leads every turn
        TacitSeats turns = new TacitSeats(IERC20Seats(TAC), 1000e18, 50, SEQ);
        deployCodeTo("TacitBlocks.sol:TacitBlocks", abi.encode(SP1_GROTH16_V6_1_0, BLOCK_VKEY, vm.parseJsonBytes32(fx, ".spendVk"), turns, uint256(600), uint256(1 hours)), at);
        blocks = TacitBlocks(at);
        deployCodeTo("TacitBlocks.t.sol:Token", abi.encode(uint8(18)), vm.parseJsonAddress(fx, ".token"));
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
        l.pools = vm.parseJsonBytes(fx, key(b, "pools"));
    }

    /// The fixture's deposits for its pool and swaps: ETH as value, the token from a balance.
    function depositOps() internal {
        for (uint256 i; i < 5; ++i) {
            string memory d = string.concat(".opDeposits[", vm.toString(i), "]");
            address token = vm.parseJsonAddress(fx, string.concat(d, ".token"));
            uint256 v = vm.parseJsonUint(fx, string.concat(d, ".value"));
            bytes32 cx = vm.parseJsonBytes32(fx, string.concat(d, ".cx"));
            bytes32 cy = vm.parseJsonBytes32(fx, string.concat(d, ".cy"));
            bytes32 body = vm.parseJsonBytes32(fx, string.concat(d, ".body"));
            if (token == address(0)) {
                blocks.deposit{value: v * GWEI}(address(0), v, cx, cy, body);
            } else {
                Token(token).mint(address(this), v * GWEI);
                Token(token).approve(address(blocks), v * GWEI);
                blocks.deposit(token, v, cx, cy, body);
            }
        }
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

        depositOps();
        landReal(3, "a pool made from two deposits");
        landReal(4, "three swaps from deposits, one limit missed");
        bytes memory rm = vm.parseJsonBytes(fx, ".forcedRemove");
        data = abi.encodeCall(TacitBlocks.force, (rm));
        vm.prank(address(0xF0));
        g = gasleft();
        blocks.force(rm);
        report("post a removal of liquidity to the queue", data, g - gasleft());
        landReal(5, "a forced removal of liquidity and a token exit");
        assertEq(blocks.height(), 6);
        assertEq(blocks.queueDone(), 2);
        address token = vm.parseJsonAddress(fx, ".token");
        address tokenTo = vm.parseJsonAddress(fx, ".tokenExit.to");
        uint256 got = vm.parseJsonUint(fx, ".tokenExit.value");
        blocks.withdraw(token, tokenTo);
        assertEq(Token(token).balanceOf(tokenTo), got * GWEI, "the token the ETH bought, paid on L1");
        assertEq(address(blocks).balance, (380 + 1_000_000 + 10_000 + 5_000) * GWEI);
        assertEq(Token(token).balanceOf(address(blocks)), (4_000_000 + 30_000 - got) * GWEI);
    }
}
