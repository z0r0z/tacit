// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitBlocks, ISP1BlockVerifier, IConfidentialPool} from "../src/TacitBlocks.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";

interface IERC20Fork {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// The chain `tacit-block fixture test/fixtures/tacit-blocks-mainnet.json 1 <lander>` writes, landed on a mainnet fork with the
/// block program's real Groth16 proofs (tacit-block-gpu --groth16 on each FILE.b<i>.stdin, kept as FILE.b<i>.stdin.groth16) through
/// the SP1 v6.1.0 Groth16 verifier the pool uses, in real TAC, its hops going into the live confidential pool: a shield, a spend with
/// an exit, a block of the queue alone that takes a spend posted with `force`, a hop of 300 into the confidential pool, and a block
/// of the queue alone that takes a hop posted with `force`, two deposits straight into locks, the recipient's claim of one (its
/// signature published) and a refund of the other posted with `force`. Skipped unless TACIT_BLOCKS_FORK_RPC names an Ethereum node and the
/// proofs exist.
/// Accepts every proof, for checking the live confidential pool's side of a hop before real proofs exist.
contract AcceptAllFork is ISP1BlockVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract TacitBlocksForkTest is Test {
    address constant SP1_GROTH16_V6_1_0 = 0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2;
    /// The TAC ERC-20 on Ethereum, the confidential pool that mints it, and TAC's id there.
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address constant CONFIDENTIAL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    bytes32 constant CTAC = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    /// `cargo prove vkey --elf contracts/sp1/confidential/tacit-block/elf/tacit-block`
    bytes32 constant BLOCK_VKEY = 0x00593e61d413e93c1a15eac1e8a3987cd8577a63a88ef1d60b6ec8a660e05f64;
    address constant SEQ = address(0x5E9);
    uint256 constant UNIT = 1e10;

    string path;
    string fx;
    TacitBlocks blocks;
    bool ready;

    function setUp() public {
        path = string.concat(vm.projectRoot(), "/test/fixtures/tacit-blocks-mainnet.json");
        string memory rpc = vm.envOr("TACIT_BLOCKS_FORK_RPC", string(""));
        if (bytes(rpc).length == 0 || !vm.exists(string.concat(path, ".b8.stdin.groth16"))) return;
        vm.createSelectFork(rpc);
        fx = vm.readFile(path);
        vm.warp(vm.parseJsonUint(fx, ".time"));
        address at = vm.parseJsonAddress(fx, ".lander");
        // no seat is held on the fork, so SEQ leads every turn
        TacitSeats turns = new TacitSeats(IERC20Seats(TAC), 1000e18, 50, SEQ);
        deployCodeTo(
            "TacitBlocks.sol:TacitBlocks",
            abi.encode(SP1_GROTH16_V6_1_0, BLOCK_VKEY, vm.parseJsonBytes32(fx, ".spendVk"), turns, uint256(600), uint256(1 hours), TAC, CONFIDENTIAL, CTAC),
            at
        );
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
        l.hops = vm.parseJsonBytes(fx, key(b, "hops"));
        l.claims = vm.parseJsonBytes(fx, key(b, "claims"));
        l.blobs = vm.parseJsonBytes(fx, key(b, "blobs"));
        l.migrations = vm.parseJsonBytes(fx, key(b, "migrations"));
        l.migrationTotals = vm.parseJsonBytes(fx, key(b, "migrationTotals"));
    }

    /// A blob block is landed with its blobs' versioned hashes in the transaction and its data-only lists left out.
    function asBlobBlock(TacitBlocks.Lists memory l) internal {
        uint256 n = l.blobs.length / 160;
        if (n == 0) return;
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            bytes memory c = new bytes(48);
            for (uint256 j; j < 48; ++j) {
                c[j] = l.blobs[160 * i + j];
            }
            hashes[i] = bytes32((uint256(sha256(c)) & (type(uint256).max >> 8)) | (uint256(1) << 248));
        }
        vm.blobhashes(hashes);
        delete l.leaves;
        delete l.memos;
        delete l.nullifiers;
        delete l.claims;
    }

    /// Moves the clock to the time block `b` names when it is later.
    function toTime(uint256 b) internal {
        uint256 t = uint256(abi.decode(vm.parseJsonBytes(fx, key(b, "publicValues")), (bytes32[19]))[14]);
        if (block.timestamp < t) vm.warp(t);
    }

    /// The fixture's shield deposit, made with real TAC: the shares it buys and the TAC it pays.
    function depositFixture() internal {
        uint256 a = vm.parseJsonUint(fx, ".deposit.amount");
        deal(TAC, address(this), a * UNIT);
        IERC20Fork(TAC).approve(address(blocks), a * UNIT);
        blocks.deposit(
            vm.parseJsonUint(fx, ".deposit.shares"), a, vm.parseJsonBytes32(fx, ".deposit.cx"), vm.parseJsonBytes32(fx, ".deposit.cy"), vm.parseJsonBytes32(fx, ".deposit.body")
        );
    }

    function lockDeposits() internal {
        for (uint256 i; i < 2; ++i) {
            string memory d = string.concat(".lockDeposits[", vm.toString(i), "]");
            uint256 s = vm.parseJsonUint(fx, string.concat(d, ".shares"));
            uint256 a = vm.parseJsonUint(fx, string.concat(d, ".amount"));
            deal(TAC, address(this), a * UNIT);
            IERC20Fork(TAC).approve(address(blocks), a * UNIT);
            blocks.deposit(s, a, vm.parseJsonBytes32(fx, string.concat(d, ".cx")), vm.parseJsonBytes32(fx, string.concat(d, ".cy")), vm.parseJsonBytes32(fx, string.concat(d, ".body")));
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
        asBlobBlock(l);
        toTime(b);
        bytes memory data = abi.encodeCall(TacitBlocks.land, (pv, pf, l));
        vm.prank(SEQ);
        uint256 g = gasleft();
        blocks.land(pv, pf, l);
        report(string.concat("land block ", vm.toString(b), " (", what, ")"), data, g - gasleft());
    }

    function sendHop(uint256 value, bytes32 commit, string memory what) internal {
        uint256 supply = IERC20Fork(TAC).totalSupply();
        bytes memory data = abi.encodeCall(TacitBlocks.sendHop, (value, commit));
        uint256 g = gasleft();
        blocks.sendHop(value, commit);
        report(what, data, g - gasleft());
        assertEq(supply - IERC20Fork(TAC).totalSupply(), value * UNIT, "the confidential pool burns what hops in, to mint it as its note");
    }

    function test_realBlocksLandThroughTheRealVerifier() public {
        if (!ready) return;
        assertEq(block.chainid, 1);
        assertEq(blocks.CHAIN(), vm.parseJsonBytes32(fx, ".chain"), "the binding the fixture's spends carry");
        assertEq(blocks.state(), vm.parseJsonBytes32(fx, ".genesisState"));
        depositFixture();

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
        address to = vm.parseJsonAddress(fx, ".exit.to");
        blocks.withdraw(to);
        assertEq(IERC20Fork(TAC).balanceOf(to), vm.parseJsonUint(fx, ".exit.amount") * UNIT, "the exit is paid in TAC");

        bytes memory forced = vm.parseJsonBytes(fx, ".forced");
        bytes memory data = abi.encodeCall(TacitBlocks.force, (forced));
        vm.prank(address(0xF0));
        uint256 g = gasleft();
        blocks.force(forced);
        report("post a spend to the queue", data, g - gasleft());
        landReal(2, "the queue alone: one forced spend");

        landReal(3, "one spend hopping 300 into the confidential pool");
        sendHop(vm.parseJsonUint(fx, ".hop.amount"), vm.parseJsonBytes32(fx, ".hop.commit"), "send a hop into the confidential pool");
        bytes memory forcedHop = vm.parseJsonBytes(fx, ".forcedHop");
        vm.prank(address(0xF0));
        blocks.force(forcedHop);
        landReal(4, "the queue alone: one forced hop");
        sendHop(vm.parseJsonUint(fx, ".hop2.amount"), vm.parseJsonBytes32(fx, ".hop2.commit"), "send the forced hop on");
        assertEq(IERC20Fork(TAC).balanceOf(address(blocks)), blocks.inChain() * UNIT, "every TAC that came in went out (an exit and two hops) but their fees");

        lockDeposits();
        landReal(5, "two deposits straight into locks");
        landReal(6, "a claim of a lock, its signature published");
        bytes memory refund = vm.parseJsonBytes(fx, ".forcedRefund");
        data = abi.encodeCall(TacitBlocks.force, (refund));
        vm.prank(address(0xF0));
        g = gasleft();
        blocks.force(refund);
        report("post a refund to the queue", data, g - gasleft());
        landReal(7, "the queue alone: a refund after its deadline");
        assertEq(blocks.height(), 8);
        assertEq(blocks.queueDone(), 3);
        landReal(8, "a payment whose notes, memos and nullifiers are in a blob");
        assertEq(blocks.height(), 9);
        assertEq(IERC20Fork(TAC).balanceOf(address(blocks)), blocks.inChain() * UNIT, "the claimed and refunded locks stay on the chain as notes");
        assertEq(blocks.pool(), blocks.inChain());
    }

    /// The same chain landed through a verifier that takes any proof, so the live confidential pool's side is checked without
    /// real proofs: each hop, sent on, is the pool's `wrap` of TAC (burning it) for the hop's commitment. Runs with only
    /// TACIT_BLOCKS_FORK_RPC set.
    function test_hopsGoIntoTheLiveConfidentialPool() public {
        string memory rpc = vm.envOr("TACIT_BLOCKS_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        fx = vm.readFile(path);
        vm.warp(vm.parseJsonUint(fx, ".time"));
        TacitSeats turns = new TacitSeats(IERC20Seats(TAC), 1000e18, 50, SEQ);
        deployCodeTo(
            "TacitBlocks.sol:TacitBlocks",
            abi.encode(new AcceptAllFork(), bytes32(0), vm.parseJsonBytes32(fx, ".spendVk"), turns, uint256(600), uint256(1 hours), TAC, CONFIDENTIAL, CTAC),
            vm.parseJsonAddress(fx, ".lander")
        );
        blocks = TacitBlocks(vm.parseJsonAddress(fx, ".lander"));
        depositFixture();
        for (uint256 b; b < 9; ++b) {
            if (b == 2) blocks.force(vm.parseJsonBytes(fx, ".forced"));
            if (b == 4) blocks.force(vm.parseJsonBytes(fx, ".forcedHop"));
            if (b == 5) lockDeposits();
            if (b == 7) blocks.force(vm.parseJsonBytes(fx, ".forcedRefund"));
            toTime(b);
            TacitBlocks.Lists memory l = lists(b);
            asBlobBlock(l);
            vm.prank(SEQ);
            blocks.land(vm.parseJsonBytes(fx, key(b, "publicValues")), "", l);
            if (b == 3) sendHop(vm.parseJsonUint(fx, ".hop.amount"), vm.parseJsonBytes32(fx, ".hop.commit"), "send a hop into the live confidential pool");
        }
        sendHop(vm.parseJsonUint(fx, ".hop2.amount"), vm.parseJsonBytes32(fx, ".hop2.commit"), "send the forced hop on");
        blocks.withdraw(vm.parseJsonAddress(fx, ".exit.to"));
        assertEq(IERC20Fork(TAC).balanceOf(address(blocks)), blocks.inChain() * UNIT, "out: an exit, two hops and a migration; on the chain: the notes left");
        assertEq(blocks.pool(), blocks.inChain());
    }
}
