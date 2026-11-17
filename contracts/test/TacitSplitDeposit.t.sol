// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitSplitDeposit, TacitTx} from "../src/TacitSplitDeposit.sol";

/// A fixed-denomination pool as Tornado Cash's ETH pools behave for a deposit: the exact size, once per commitment.
contract MockFixedPool {
    uint256 public immutable denomination;
    mapping(bytes32 => bool) public commitments;
    uint32 public nextIndex;

    constructor(uint256 d) {
        denomination = d;
    }

    function deposit(bytes32 c) external payable {
        require(!commitments[c], "The commitment has been submitted");
        require(msg.value == denomination, "Please send `mixDenomination` ETH along with transaction");
        commitments[c] = true;
        nextIndex++;
    }
}

/// The Tacit ETH pool's `transact` for a deposit: the ETH sent is `extAmount`; it can be made to refuse as a stale proof does.
contract TacitPoolMock {
    error StaleRoot();

    uint256 public received;
    uint256 public calls;
    bool public stale;
    address public lastSender;

    function setStale(bool s) external {
        stale = s;
    }

    function transact(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[11] calldata,
        address,
        int256 extAmount,
        address,
        uint256,
        bytes calldata,
        bytes calldata
    ) external payable {
        if (stale) revert StaleRoot();
        require(extAmount > 0 && msg.value == uint256(extAmount), "value");
        received += msg.value;
        calls++;
        lastSender = msg.sender;
    }
}

/// Another contract calling the forwarder, as zRouter's SafeExecutor does for `snwap`: the sender is not the depositor.
contract ExecutorCaller {
    function run(address fwd, bytes calldata data) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = fwd.call{value: msg.value}(data);
    }
}

contract TacitSplitDepositTest is Test {
    MockFixedPool p01 = new MockFixedPool(0.1 ether);
    MockFixedPool p1 = new MockFixedPool(1 ether);
    MockFixedPool p10 = new MockFixedPool(10 ether);
    MockFixedPool p100 = new MockFixedPool(100 ether);
    TacitPoolMock tacit = new TacitPoolMock();
    TacitSplitDeposit fwd;
    address alice = address(0xA11CE);

    function setUp() public {
        address[] memory pools = new address[](4);
        pools[0] = address(p01);
        pools[1] = address(p1);
        pools[2] = address(p10);
        pools[3] = address(p100);
        fwd = new TacitSplitDeposit(address(tacit), pools);
        vm.deal(alice, 10_000 ether);
    }

    function _tx(int256 ext) internal pure returns (TacitTx memory t) {
        t.extAmount = ext;
        t.memo0 = hex"aa";
        t.memo1 = hex"bb";
    }

    function _notes(MockFixedPool a, MockFixedPool b) internal pure returns (address[] memory pools) {
        pools = new address[](2);
        pools[0] = address(a);
        pools[1] = address(b);
    }

    function _commits(uint256 n) internal pure returns (bytes32[] memory c) {
        c = new bytes32[](n);
        for (uint256 i; i < n; ++i) c[i] = keccak256(abi.encode("commitment", i));
    }

    // ── what goes where ──

    function test_splitsTheValueBetweenNotesAndTacit() public {
        address[] memory pools = _notes(p1, p01);
        bytes32[] memory c = _commits(2);
        vm.expectEmit(true, false, false, true);
        emit TacitSplitDeposit.SplitDeposit(alice, 2, 1.1 ether, 0.05 ether);
        vm.prank(alice);
        fwd.splitDeposit{value: 1.15 ether}(pools, c, _tx(0.05 ether));
        assertTrue(p1.commitments(c[0]) && p01.commitments(c[1]));
        assertEq(address(p1).balance, 1 ether);
        assertEq(address(p01).balance, 0.1 ether);
        assertEq(tacit.received(), 0.05 ether);
        assertEq(tacit.calls(), 1);
        assertEq(address(fwd).balance, 0, "nothing stays");
        assertEq(alice.balance, 10_000 ether - 1.15 ether);
    }

    function test_notesOnlyWhenTheTacitPartIsZero_andTheTxIsNotUsed() public {
        address[] memory pools = _notes(p10, p1);
        bytes32[] memory c = _commits(2);
        TacitTx memory t = _tx(0);
        t.recipient = address(0xdead); // junk with extAmount 0 is not read
        vm.prank(alice);
        fwd.splitDeposit{value: 11 ether}(pools, c, t);
        assertEq(tacit.calls(), 0);
        assertEq(address(fwd).balance, 0);
    }

    function test_tacitOnly() public {
        vm.prank(alice);
        fwd.splitDeposit{value: 3 ether}(new address[](0), new bytes32[](0), _tx(3 ether));
        assertEq(tacit.received(), 3 ether);
    }

    function test_aPoolMayRepeat() public {
        address[] memory pools = new address[](3);
        pools[0] = address(p1);
        pools[1] = address(p1);
        pools[2] = address(p1);
        bytes32[] memory c = _commits(3);
        vm.prank(alice);
        fwd.splitDeposit{value: 3 ether}(pools, c, _tx(0));
        assertEq(p1.nextIndex(), 3);
    }

    function test_theTacitPoolSeesTheForwarderAsSender() public {
        vm.prank(alice);
        fwd.splitDeposit{value: 1 ether}(new address[](0), new bytes32[](0), _tx(1 ether));
        assertEq(tacit.lastSender(), address(fwd));
    }

    // ── the value is exact ──

    function test_valueMustBeExact_overAndUnder() public {
        address[] memory pools = _notes(p1, p01);
        bytes32[] memory c = _commits(2);
        TacitTx memory t = _tx(0.05 ether);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TacitSplitDeposit.WrongValue.selector, 1.15 ether + 1, 1.15 ether));
        fwd.splitDeposit{value: 1.15 ether + 1}(pools, c, t);
        vm.expectRevert(abi.encodeWithSelector(TacitSplitDeposit.WrongValue.selector, 1.15 ether - 1, 1.15 ether));
        fwd.splitDeposit{value: 1.15 ether - 1}(pools, c, t);
        vm.expectRevert(abi.encodeWithSelector(TacitSplitDeposit.WrongValue.selector, 0, 1.15 ether));
        fwd.splitDeposit(pools, c, t);
        vm.stopPrank();
        assertEq(p1.nextIndex(), 0);
    }

    function testFuzz_exactValueGoesThrough_otherwiseNothing(uint8 a, uint8 b, uint8 d, uint96 tacitAmt, bool over) public {
        uint256 na = bound(a, 0, 4);
        uint256 nb = bound(b, 0, 4);
        uint256 nd = bound(d, 0, 4);
        uint256 n = na + nb + nd;
        uint256 tacitWei = n == 0 ? bound(tacitAmt, 1, 500 ether) : bound(tacitAmt, 0, 500 ether);
        address[] memory pools = new address[](n);
        uint256 k;
        for (uint256 i; i < na; ++i) pools[k++] = address(p01);
        for (uint256 i; i < nb; ++i) pools[k++] = address(p1);
        for (uint256 i; i < nd; ++i) pools[k++] = address(p10);
        bytes32[] memory c = _commits(n);
        uint256 exact = na * 0.1 ether + nb * 1 ether + nd * 10 ether + tacitWei;
        vm.startPrank(alice);
        vm.expectRevert();
        fwd.splitDeposit{value: over ? exact + 1 : exact - 1}(pools, c, _tx(int256(tacitWei)));
        fwd.splitDeposit{value: exact}(pools, c, _tx(int256(tacitWei)));
        vm.stopPrank();
        assertEq(address(fwd).balance, 0);
        assertEq(address(p01).balance + address(p1).balance + address(p10).balance + address(tacit).balance, exact);
        assertEq(p01.nextIndex(), na);
        assertEq(tacit.received(), tacitWei);
    }

    // ── what it refuses ──

    function test_refusesAPoolItWasNotBuiltWith() public {
        MockFixedPool rogue = new MockFixedPool(1 ether);
        address[] memory pools = new address[](1);
        pools[0] = address(rogue);
        vm.prank(alice);
        vm.expectRevert(TacitSplitDeposit.NotAPool.selector);
        fwd.splitDeposit{value: 1 ether}(pools, _commits(1), _tx(0));
        vm.prank(alice);
        vm.expectRevert(TacitSplitDeposit.NotAPool.selector);
        pools[0] = alice;
        fwd.splitDeposit{value: 1 ether}(pools, _commits(1), _tx(0));
    }

    function test_refusesMismatchedListsTooManyNotesNothingAtAll() public {
        vm.startPrank(alice);
        vm.expectRevert(TacitSplitDeposit.LengthMismatch.selector);
        fwd.splitDeposit{value: 1 ether}(_notes(p1, p1), _commits(1), _tx(0));
        address[] memory many = new address[](17);
        for (uint256 i; i < 17; ++i) many[i] = address(p01);
        vm.expectRevert(TacitSplitDeposit.TooManyNotes.selector);
        fwd.splitDeposit{value: 1.7 ether}(many, _commits(17), _tx(0));
        vm.expectRevert(TacitSplitDeposit.NothingToDeposit.selector);
        fwd.splitDeposit(new address[](0), new bytes32[](0), _tx(0));
        vm.stopPrank();
    }

    function test_refusesAWithdrawal() public {
        vm.prank(alice);
        vm.expectRevert(TacitSplitDeposit.NotADeposit.selector);
        fwd.splitDeposit(_notes(p1, p1), _commits(2), _tx(-1));
    }

    function test_refusesPlainETH() public {
        vm.prank(alice);
        (bool ok,) = address(fwd).call{value: 1 ether}("");
        assertFalse(ok, "no receive, no fallback");
    }

    // ── all or nothing, and the pool's own error comes back ──

    function test_aStaleTacitProofRevertsTheNotesToo_andTheErrorIsThePools() public {
        tacit.setStale(true);
        address[] memory pools = _notes(p1, p01);
        bytes32[] memory c = _commits(2);
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(fwd).call{value: 1.15 ether}(abi.encodeCall(fwd.splitDeposit, (pools, c, _tx(0.05 ether))));
        assertFalse(ok);
        assertEq(bytes4(ret), TacitPoolMock.StaleRoot.selector, "the wallet reads this to prove again");
        assertEq(p1.nextIndex() + p01.nextIndex(), 0, "no note was placed");
        assertEq(address(fwd).balance, 0);
        assertEq(alice.balance, 10_000 ether);
    }

    function test_aNoteThatCannotBePlacedStopsTheRest_withThePoolsMessage() public {
        bytes32[] memory c = _commits(2);
        c[1] = c[0]; // the same commitment twice: the second is refused by the pool
        vm.prank(alice);
        vm.expectRevert(bytes("The commitment has been submitted"));
        fwd.splitDeposit{value: 2.05 ether}(_notes(p1, p1), c, _tx(0.05 ether));
        assertEq(p1.nextIndex(), 0);
        assertEq(tacit.calls(), 0);
    }

    function test_worksCalledByAnotherContract_asAZRouterSnwapExecutorWould() public {
        ExecutorCaller ex = new ExecutorCaller();
        address[] memory pools = _notes(p1, p01);
        bytes32[] memory c = _commits(2);
        vm.prank(alice);
        (bool ok,) = ex.run{value: 1.15 ether}(address(fwd), abi.encodeCall(fwd.splitDeposit, (pools, c, _tx(0.05 ether))));
        assertTrue(ok);
        assertEq(tacit.lastSender(), address(fwd));
        assertEq(address(ex).balance + address(fwd).balance, 0);
    }

    // ── construction ──

    function test_constructorRefusesNoPools_aDeadTacitPool_aZeroSize_aRepeatedPool() public {
        address[] memory none = new address[](0);
        vm.expectRevert(TacitSplitDeposit.BadPools.selector);
        new TacitSplitDeposit(address(tacit), none);
        address[] memory one = new address[](1);
        one[0] = address(p1);
        vm.expectRevert(TacitSplitDeposit.BadPools.selector);
        new TacitSplitDeposit(address(0xBEEF), one);
        one[0] = address(new MockFixedPool(0));
        vm.expectRevert(TacitSplitDeposit.BadPools.selector);
        new TacitSplitDeposit(address(tacit), one);
        address[] memory twice = new address[](2);
        twice[0] = address(p1);
        twice[1] = address(p1);
        vm.expectRevert(TacitSplitDeposit.BadPools.selector);
        new TacitSplitDeposit(address(tacit), twice);
    }

    function test_theSizesAreTheOnesReadAtConstruction() public view {
        assertEq(fwd.denominationOf(address(p01)), 0.1 ether);
        assertEq(fwd.denominationOf(address(p100)), 100 ether);
        assertEq(fwd.denominationOf(address(0x1234)), 0);
        assertEq(address(fwd.TACIT_POOL()), address(tacit));
    }
}

/// Against the real pools on mainnet. Skipped unless FORK_URL is set:
///   FORK_URL=https://rpc.mevblocker.io forge test --match-contract TacitSplitDepositForkTest -vv
contract TacitSplitDepositForkTest is Test {
    address constant TACIT_ETH_POOL = 0x000000c2A20657CE25f2Ba99737933D031AFBEE9;
    address constant T01 = 0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc;
    address constant T1 = 0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936;
    address constant T10 = 0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF;
    address constant T100 = 0xA160cdAB225685dA1d56aa342Ad8841c3b53f291;
    error WrongAsset();

    TacitSplitDeposit fwd;
    address alice = address(0xA11CE);

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url);
        address[] memory pools = new address[](4);
        pools[0] = T01;
        pools[1] = T1;
        pools[2] = T10;
        pools[3] = T100;
        fwd = new TacitSplitDeposit(TACIT_ETH_POOL, pools);
        vm.deal(alice, 1000 ether);
        return true;
    }

    // a note's commitment is a Pedersen hash, inside the BN254 field; the real pools refuse one outside it ("_right should be inside the field")
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function _commitment(string memory what, uint256 i) internal view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(what, block.number, i))) % FIELD);
    }

    function _nextIndex(address pool) internal view returns (uint256) {
        (bool ok, bytes memory r) = pool.staticcall(abi.encodeWithSignature("nextIndex()"));
        require(ok, "nextIndex");
        return abi.decode(r, (uint256));
    }

    function _has(address pool, bytes32 c) internal view returns (bool) {
        (bool ok, bytes memory r) = pool.staticcall(abi.encodeWithSignature("commitments(bytes32)", c));
        require(ok, "commitments");
        return abi.decode(r, (bool));
    }

    function test_fork_theRealPoolsSizes() public {
        if (!_fork()) return;
        assertEq(fwd.denominationOf(T01), 0.1 ether);
        assertEq(fwd.denominationOf(T1), 1 ether);
        assertEq(fwd.denominationOf(T10), 10 ether);
        assertEq(fwd.denominationOf(T100), 100 ether);
    }

    function test_fork_notesGoIntoTheRealPools() public {
        if (!_fork()) return;
        address[] memory pools = new address[](3);
        pools[0] = T01;
        pools[1] = T1;
        pools[2] = T01;
        bytes32[] memory c = new bytes32[](3);
        for (uint256 i; i < 3; ++i) c[i] = _commitment("fork canary commitment", i);
        uint256 a = _nextIndex(T01);
        uint256 b = _nextIndex(T1);
        TacitTx memory none;
        uint256 held = address(fwd).balance; // the test's address may already hold some ETH on mainnet: what matters is that the call adds none
        vm.prank(alice);
        fwd.splitDeposit{value: 1.2 ether}(pools, c, none);
        assertEq(_nextIndex(T01), a + 2);
        assertEq(_nextIndex(T1), b + 1);
        assertTrue(_has(T01, c[0]) && _has(T1, c[1]) && _has(T01, c[2]));
        assertEq(address(fwd).balance, held, "nothing stays");
        assertEq(alice.balance, 1000 ether - 1.2 ether);
    }

    function test_fork_theRealTacitPoolRefusesAJunkProof_andTheNotesGoWithIt() public {
        if (!_fork()) return;
        address[] memory pools = new address[](1);
        pools[0] = T01;
        bytes32[] memory c = new bytes32[](1);
        c[0] = _commitment("fork junk", 0);
        uint256 a = _nextIndex(T01);
        TacitTx memory t; // an all-zero proof for a 0.05 ETH deposit: the real pool refuses it on the asset check
        t.extAmount = 0.05 ether;
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(fwd).call{value: 0.15 ether}(abi.encodeCall(fwd.splitDeposit, (pools, c, t)));
        assertFalse(ok, "a junk proof must not go through");
        assertEq(bytes4(ret), WrongAsset.selector, "the real pool's own error comes back");
        assertEq(_nextIndex(T01), a, "the note was not placed");
        assertFalse(_has(T01, c[0]));
        assertEq(alice.balance, 1000 ether);
    }
}
