// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitRelayer} from "../src/TacitRelayer.sol";

// Minimal SafeTransferLib-compatible ERC20 (balanceOf + transfer returning bool).
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

// Stand-in ConfidentialPool: settle() reads `proof` as (feeAsset, feeAmount, doRevert) and, unless doRevert,
// pays feeAmount of feeAsset (ETH if feeAsset == address(0)) to msg.sender — modeling a FeePayment leg landing
// on the caller (the relayer). Pre-funded by the test so it can pay.
contract MockPool {
    // Mirrors the pool's canonical (sorted) pair keying + revert-if-exists semantics, so the relayer's
    // idempotent try/catch prelude can be exercised.
    mapping(bytes32 => bool) public pairExists;
    uint256 public createPairCalls;

    function settle(bytes calldata, bytes calldata proof, bytes[] calldata) external {
        (address feeAsset, uint256 feeAmount, bool doRevert) = abi.decode(proof, (address, uint256, bool));
        require(!doRevert, "settle revert");
        if (feeAmount != 0) {
            if (feeAsset == address(0)) {
                (bool ok,) = msg.sender.call{value: feeAmount}("");
                require(ok, "eth pay");
            } else {
                MockERC20(feeAsset).transfer(msg.sender, feeAmount);
            }
        }
    }

    function createPair(bytes32 a, bytes32 b, uint32 feeBps, uint8, bytes32, uint32) external returns (bytes32 id) {
        ++createPairCalls;
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        id = keccak256(abi.encode(lo, hi, feeBps)); // relayer auto-creates no-skim (0/0/0) ⇒ 3-arg id, matches pairId()
        require(!pairExists[id], "PoolExists"); // standalone createPair reverts if the slot is taken
        pairExists[id] = true;
    }

    function pairId(bytes32 a, bytes32 b, uint32 feeBps) external pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(lo, hi, feeBps));
    }

    receive() external payable {}
}

// A recipient that rejects ETH — proves a bad ETH recipient reverts the batch atomically (caller-chosen risk).
contract RejectsETH {
    receive() external payable {
        revert("no eth");
    }
}

contract TacitRelayerTest is Test {
    TacitRelayer relayer;
    MockPool pool;
    MockERC20 token;

    event Relayed(address indexed relayer, address indexed to, uint256 submitted, uint256 landed);

    address constant RELAYER_EOA = address(0xBEEF);
    address constant AFFILIATE = address(0xA11CE);
    address constant THIRD = address(0xCAFE);

    function setUp() public {
        pool = new MockPool();
        relayer = new TacitRelayer(address(pool));
        token = new MockERC20();
        token.mint(address(pool), 1_000 ether);
        vm.deal(address(pool), 100 ether);
    }

    function _call(address feeAsset, uint256 feeAmount, bool doRevert)
        internal
        pure
        returns (TacitRelayer.SettleCall memory c)
    {
        c.proof = abi.encode(feeAsset, feeAmount, doRevert);
        c.memos = new bytes[](0);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _one(uint256 v) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = v;
    }

    function testBatchAndForwardERC20() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](2);
        calls[0] = _call(address(token), 10 ether, false);
        calls[1] = _call(address(token), 15 ether, false);
        uint256 landed = relayer.relaySettle(
            calls, _one(address(token)), _one(uint256(25 ether)), _one(RELAYER_EOA), _one(uint256(10000))
        );
        assertEq(landed, 2);
        assertEq(token.balanceOf(RELAYER_EOA), 25 ether);
        assertEq(token.balanceOf(address(relayer)), 0, "relayer holds nothing between calls");
    }

    function testSkipsFailedSettle() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](3);
        calls[0] = _call(address(token), 10 ether, false);
        calls[1] = _call(address(token), 0, true); // reverts → skipped (try/catch)
        calls[2] = _call(address(token), 5 ether, false);
        uint256 landed = relayer.relaySettle(
            calls, _one(address(token)), _one(uint256(15 ether)), _one(RELAYER_EOA), _one(uint256(10000))
        );
        assertEq(landed, 2, "the failed settle is skipped, the other two land");
        assertEq(token.balanceOf(RELAYER_EOA), 15 ether);
    }

    function testBelowMinIsAtomic() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 10 ether, false);
        vm.expectRevert(); // BelowMin(token, 10e18, 20e18)
        relayer.relaySettle(
            calls, _one(address(token)), _one(uint256(20 ether)), _one(RELAYER_EOA), _one(uint256(10000))
        );
        // the revert rolls the settle back too — nothing was consumed
        assertEq(token.balanceOf(RELAYER_EOA), 0);
        assertEq(token.balanceOf(address(pool)), 1_000 ether);
    }

    function testAffiliateSplit() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 100 ether, false);
        address[] memory rec = new address[](2);
        rec[0] = RELAYER_EOA;
        rec[1] = AFFILIATE;
        uint256[] memory bps = new uint256[](2);
        bps[0] = 8000;
        bps[1] = 2000;
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(100 ether)), rec, bps);
        assertEq(token.balanceOf(RELAYER_EOA), 80 ether);
        assertEq(token.balanceOf(AFFILIATE), 20 ether);
    }

    function testAffiliateSplitDustToLast() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 100, false); // 100 wei, indivisible by the bps below
        address[] memory rec = new address[](3);
        rec[0] = RELAYER_EOA;
        rec[1] = AFFILIATE;
        rec[2] = THIRD;
        uint256[] memory bps = new uint256[](3);
        bps[0] = 3333;
        bps[1] = 3333;
        bps[2] = 3334;
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(0)), rec, bps);
        assertEq(token.balanceOf(RELAYER_EOA), 33);
        assertEq(token.balanceOf(AFFILIATE), 33);
        assertEq(token.balanceOf(THIRD), 34, "last recipient sweeps the remainder - no dust lost");
        assertEq(token.balanceOf(address(relayer)), 0);
    }

    function testETHFeeForwarded() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(0), 3 ether, false);
        relayer.relaySettle(calls, _one(address(0)), _one(uint256(3 ether)), _one(RELAYER_EOA), _one(uint256(10000)));
        assertEq(RELAYER_EOA.balance, 3 ether);
        assertEq(address(relayer).balance, 0);
    }

    function testMultipleFeeAssetsForwardedInOneBatch() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](2);
        calls[0] = _call(address(token), 12 ether, false);
        calls[1] = _call(address(0), 2 ether, false);
        address[] memory assets = new address[](2);
        assets[0] = address(token);
        assets[1] = address(0);
        uint256[] memory mins = new uint256[](2);
        mins[0] = 12 ether;
        mins[1] = 2 ether;

        uint256 landed = relayer.relaySettle(calls, assets, mins, _one(RELAYER_EOA), _one(uint256(10000)));

        assertEq(landed, 2);
        assertEq(token.balanceOf(RELAYER_EOA), 12 ether);
        assertEq(RELAYER_EOA.balance, 2 ether);
        assertEq(token.balanceOf(address(relayer)), 0);
        assertEq(address(relayer).balance, 0);
    }

    function testRelayedEventReportsSubmittedAndLanded() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](2);
        calls[0] = _call(address(token), 6 ether, false);
        calls[1] = _call(address(token), 0, true);

        vm.prank(RELAYER_EOA);
        vm.expectEmit(true, true, false, true, address(relayer));
        emit Relayed(RELAYER_EOA, RELAYER_EOA, 2, 1);
        relayer.relaySettle(
            calls, _one(address(token)), _one(uint256(6 ether)), _one(RELAYER_EOA), _one(uint256(10000))
        );
    }

    function testUndeclaredFeeNotForwarded() public {
        // declare NO fee assets → the earned token isn't burned, it sits in the relayer for the next caller.
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 7 ether, false);
        address[] memory noAssets = new address[](0);
        uint256[] memory noMins = new uint256[](0);
        uint256 landed = relayer.relaySettle(calls, noAssets, noMins, _one(RELAYER_EOA), _one(uint256(10000)));
        assertEq(landed, 1);
        assertEq(token.balanceOf(RELAYER_EOA), 0);
        assertEq(token.balanceOf(address(relayer)), 7 ether, "undeclared fee is claimable, not burned");
    }

    function testBadArgsBpsSum() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](0);
        vm.expectRevert(TacitRelayer.BadArgs.selector);
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(0)), _one(RELAYER_EOA), _one(uint256(9999)));
    }

    function testBadArgsZeroRecipient() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](0);
        vm.expectRevert(TacitRelayer.BadArgs.selector);
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(0)), _one(address(0)), _one(uint256(10000)));
    }

    function testBadArgsLengthMismatch() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](0);
        uint256[] memory twoMins = new uint256[](2);
        vm.expectRevert(TacitRelayer.BadArgs.selector);
        relayer.relaySettle(calls, _one(address(token)), twoMins, _one(RELAYER_EOA), _one(uint256(10000)));
    }

    function testBadArgsEmptyRecipientsAndSplitLengthMismatch() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](0);
        address[] memory none = new address[](0);
        uint256[] memory oneBps = _one(uint256(10000));

        vm.expectRevert(TacitRelayer.BadArgs.selector);
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(0)), none, oneBps);

        address[] memory twoRecipients = new address[](2);
        twoRecipients[0] = RELAYER_EOA;
        twoRecipients[1] = AFFILIATE;
        vm.expectRevert(TacitRelayer.BadArgs.selector);
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(0)), twoRecipients, oneBps);
    }

    // ── found-and-seed overload: a batch may lazily create the pools its ops settle against ──

    function testFoundAndSeedCreatesPairThenSettles() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        TacitRelayer.PairInit[] memory pairs = new TacitRelayer.PairInit[](1);
        pairs[0] = TacitRelayer.PairInit(a, b, 30);

        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 5 ether, false);

        uint256 landed = relayer.relaySettle(
            pairs, calls, _one(address(token)), _one(uint256(5 ether)), _one(RELAYER_EOA), _one(uint256(10000))
        );
        assertEq(landed, 1);
        assertTrue(pool.pairExists(pool.pairId(a, b, 30)), "pool founded before settle");
        assertEq(token.balanceOf(RELAYER_EOA), 5 ether);
    }

    function testFoundAndSeedSwallowsAlreadyExists() public {
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");
        TacitRelayer.PairInit[] memory pairs = new TacitRelayer.PairInit[](2);
        pairs[0] = TacitRelayer.PairInit(a, b, 30);
        pairs[1] = TacitRelayer.PairInit(b, a, 30); // canonical-equal duplicate → 2nd createPair reverts, swallowed

        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 5 ether, false);

        uint256 landed = relayer.relaySettle(
            pairs, calls, _one(address(token)), _one(uint256(5 ether)), _one(RELAYER_EOA), _one(uint256(10000))
        );
        assertEq(landed, 1, "the already-exists race is swallowed, the batch still settles");
        assertEq(pool.createPairCalls(), 1, "the duplicate create reverted and rolled back; only one persists");
        assertTrue(pool.pairExists(pool.pairId(a, b, 30)));
        assertEq(token.balanceOf(RELAYER_EOA), 5 ether);
    }

    // ── invariant coverage: stranded value is rescued by an empty-calls sweep, never stuck ──

    function testRescueStrandedViaEmptyCalls() public {
        // a stray transfer lands tokens in the relayer with no settle that earned them
        token.mint(address(relayer), 9 ether);
        TacitRelayer.SettleCall[] memory none = new TacitRelayer.SettleCall[](0);
        uint256 landed =
            relayer.relaySettle(none, _one(address(token)), _one(uint256(0)), _one(RELAYER_EOA), _one(uint256(10000)));
        assertEq(landed, 0);
        assertEq(token.balanceOf(RELAYER_EOA), 9 ether, "stranded balance swept to caller's recipient");
        assertEq(token.balanceOf(address(relayer)), 0);
    }

    function testRescueStrandedEthViaEmptyCalls() public {
        vm.deal(address(relayer), 4 ether);
        TacitRelayer.SettleCall[] memory none = new TacitRelayer.SettleCall[](0);
        uint256 landed =
            relayer.relaySettle(none, _one(address(0)), _one(uint256(0)), _one(RELAYER_EOA), _one(uint256(10000)));
        assertEq(landed, 0);
        assertEq(RELAYER_EOA.balance, 4 ether, "stranded ETH swept to caller's recipient");
        assertEq(address(relayer).balance, 0);
    }

    // ── caller-error edge cases are atomic, never a silent loss ──

    function testDuplicateFeeAssetWithMinReverts() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 10 ether, false);
        address[] memory dupAssets = new address[](2);
        dupAssets[0] = address(token);
        dupAssets[1] = address(token); // first pass zeroes the balance; second pass with a >0 floor trips BelowMin
        uint256[] memory mins = new uint256[](2);
        mins[0] = 10 ether;
        mins[1] = 1; // any positive floor on the now-zero balance
        vm.expectRevert(); // BelowMin — and it rolls the settle back too
        relayer.relaySettle(calls, dupAssets, mins, _one(RELAYER_EOA), _one(uint256(10000)));
        assertEq(token.balanceOf(RELAYER_EOA), 0);
        assertEq(token.balanceOf(address(pool)), 1_000 ether, "atomic: nothing consumed");
    }

    function testRevertingEthRecipientRevertsBatch() public {
        RejectsETH bad = new RejectsETH();
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(0), 3 ether, false);
        vm.expectRevert(); // safeTransferETH to a rejecting recipient reverts the whole batch (caller's choice)
        relayer.relaySettle(calls, _one(address(0)), _one(uint256(0)), _one(address(bad)), _one(uint256(10000)));
        assertEq(address(pool).balance, 100 ether, "atomic: the settle rolled back too");
    }

    function testZeroBpsMiddleRecipientGetsNothing() public {
        TacitRelayer.SettleCall[] memory calls = new TacitRelayer.SettleCall[](1);
        calls[0] = _call(address(token), 100 ether, false);
        address[] memory rec = new address[](3);
        rec[0] = RELAYER_EOA;
        rec[1] = AFFILIATE;
        rec[2] = THIRD;
        uint256[] memory bps = new uint256[](3);
        bps[0] = 6000;
        bps[1] = 0;
        bps[2] = 4000;
        relayer.relaySettle(calls, _one(address(token)), _one(uint256(0)), rec, bps);
        assertEq(token.balanceOf(RELAYER_EOA), 60 ether);
        assertEq(token.balanceOf(AFFILIATE), 0, "a 0-bps recipient receives nothing");
        assertEq(token.balanceOf(THIRD), 40 ether);
        assertEq(token.balanceOf(address(relayer)), 0);
    }

    function testConstructorRejectsNonContract() public {
        vm.expectRevert(TacitRelayer.PoolZero.selector);
        new TacitRelayer(address(0));
        vm.expectRevert(TacitRelayer.PoolZero.selector);
        new TacitRelayer(address(0x1234)); // EOA / no code
    }
}
