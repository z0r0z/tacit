// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitSplitDeposit} from "../src/TacitSplitDeposit.sol";

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

    function ASSET() external pure returns (address) {
        return address(0);
    }

    function setStale(bool s) external {
        stale = s;
    }

    // a hash of every argument as the pool received it, to check that the forwarder passes the caller's deposit on exactly as it was given
    bytes32 public lastArgs;

    function transact(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[11] calldata publicInputs,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes calldata memo0,
        bytes calldata memo1
    ) external payable {
        if (stale) revert StaleRoot();
        require(extAmount > 0 && msg.value == uint256(extAmount), "value");
        received += msg.value;
        calls++;
        lastSender = msg.sender;
        lastArgs = keccak256(abi.encode(pA, pB, pC, publicInputs, recipient, extAmount, relayer, fee, memo0, memo1));
    }
}

/// A Tacit pool for a token: its `ASSET()` is not the zero address, so ETH can never be deposited into it.
contract TokenPoolMock {
    function ASSET() external pure returns (address) {
        return address(0xC0FFEE);
    }
}

/// A note pool that takes all the gas it is given: a deposit into it is never cheap.
contract GasHogPool {
    uint256 public constant denomination = 1 ether;

    function deposit(bytes32) external payable {
        while (true) {}
    }
}

/// Another contract calling the forwarder with ETH: the sender is not the depositor.
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

    function _tx(int256 ext) internal pure returns (TacitSplitDeposit.Tx memory t) {
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
        TacitSplitDeposit.Tx memory t = _tx(0);
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

    // every field of the caller's deposit reaches the Tacit pool exactly as given: the proof, the recipient, the amount, the relayer, the fee and both memos
    function test_theTacitDepositIsPassedOnExactlyAsGiven() public {
        TacitSplitDeposit.Tx memory t;
        t.pA = [uint256(11), 12];
        t.pB = [[uint256(21), 22], [uint256(23), 24]];
        t.pC = [uint256(31), 32];
        for (uint256 i; i < 11; ++i) t.publicInputs[i] = 1000 + i;
        t.recipient = address(0xBEEF01);
        t.extAmount = 0.07 ether;
        t.relayer = address(0xBEEF02);
        t.fee = 12345;
        t.memo0 = abi.encodePacked(keccak256("memo zero"), keccak256("padding"), hex"01");
        t.memo1 = hex"0102030405060708090a0b0c0d0e0f10";
        vm.prank(alice);
        fwd.splitDeposit{value: 1.17 ether}(_notes(p1, p01), _commits(2), t);
        assertEq(tacit.lastArgs(), keccak256(abi.encode(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1)));
        assertEq(tacit.received(), 0.07 ether);
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
        TacitSplitDeposit.Tx memory t = _tx(0.05 ether);
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

    function testFuzz_exactValueGoesThrough_otherwiseNothing(uint8 a, uint8 b, uint8 d, uint8 e, uint96 tacitAmt, bool over) public {
        uint256[4] memory count = [bound(a, 0, 4), bound(b, 0, 4), bound(d, 0, 4), bound(e, 0, 2)];
        address[4] memory pool = [address(p01), address(p1), address(p10), address(p100)];
        uint256[4] memory size = [uint256(0.1 ether), 1 ether, 10 ether, 100 ether];
        uint256 n = count[0] + count[1] + count[2] + count[3];
        uint256 tacitWei = n == 0 ? bound(tacitAmt, 1, 500 ether) : bound(tacitAmt, 0, 500 ether);
        // the pools in an interleaved order (the notes of one pool are not together), not grouped
        address[] memory pools = new address[](n);
        uint256[4] memory left = [count[0], count[1], count[2], count[3]];
        uint256 exact = tacitWei;
        for (uint256 k; k < n;) {
            for (uint256 j; j < 4; ++j) {
                if (left[j] == 0) continue;
                pools[k++] = pool[j];
                exact += size[j];
                --left[j];
            }
        }
        bytes32[] memory c = _commits(n);
        vm.startPrank(alice);
        vm.expectRevert();
        fwd.splitDeposit{value: over ? exact + 1 : exact - 1}(pools, c, _tx(int256(tacitWei)));
        fwd.splitDeposit{value: exact}(pools, c, _tx(int256(tacitWei)));
        vm.stopPrank();
        assertEq(address(fwd).balance, 0);
        assertEq(address(p01).balance + address(p1).balance + address(p10).balance + address(p100).balance + address(tacit).balance, exact);
        assertEq(p01.nextIndex() + p1.nextIndex() + p10.nextIndex() + p100.nextIndex(), n);
        assertEq(p100.nextIndex(), count[3]);
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

    // The Tacit deposit is made before any note, so the likeliest failure, a stale proof, costs a few tens of thousands of gas and not the notes' million or two.
    // A note pool that burns all the gas it is given stands for that cost: the stale proof must be refused before it is ever called.
    function test_theTacitDepositGoesFirst_soAStaleProofNeverReachesTheNotes() public {
        GasHogPool hog = new GasHogPool();
        address[] memory pools = new address[](1);
        pools[0] = address(hog);
        TacitSplitDeposit f = new TacitSplitDeposit(address(tacit), pools);
        tacit.setStale(true);
        address[] memory list = new address[](3);
        for (uint256 i; i < 3; ++i) list[i] = address(hog);
        vm.prank(alice);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(f).call{value: 3.05 ether, gas: 400_000}(abi.encodeCall(f.splitDeposit, (list, _commits(3), _tx(0.05 ether))));
        uint256 used = before - gasleft();
        assertFalse(ok);
        assertEq(bytes4(ret), TacitPoolMock.StaleRoot.selector, "the pool's refusal, not an out-of-gas");
        assertLt(used, 100_000, "refused early");
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

    function test_worksCalledByAnotherContractWithETH() public {
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

    function test_constructorRefusesEachMisconfigurationByName() public {
        address[] memory none = new address[](0);
        vm.expectRevert(TacitSplitDeposit.NoPools.selector);
        new TacitSplitDeposit(address(tacit), none);
        address[] memory one = new address[](1);
        one[0] = address(p1);
        address tokenPool = address(new TokenPoolMock());
        address zeroSize = address(new MockFixedPool(0));
        vm.expectRevert(TacitSplitDeposit.NotAnEthPool.selector);
        new TacitSplitDeposit(address(0xBEEF), one);
        vm.expectRevert(TacitSplitDeposit.NotAnEthPool.selector);
        new TacitSplitDeposit(tokenPool, one);
        one[0] = zeroSize;
        vm.expectRevert(TacitSplitDeposit.BadSize.selector);
        new TacitSplitDeposit(address(tacit), one);
        address[] memory twice = new address[](2);
        twice[0] = address(p1);
        twice[1] = address(p1);
        vm.expectRevert(TacitSplitDeposit.RepeatedPool.selector);
        new TacitSplitDeposit(address(tacit), twice);
    }

    function test_theSizesAreTheOnesReadAtConstruction() public view {
        assertEq(fwd.denominationOf(address(p01)), 0.1 ether);
        assertEq(fwd.denominationOf(address(p100)), 100 ether);
        assertEq(fwd.denominationOf(address(0x1234)), 0);
        assertEq(address(fwd.TACIT_POOL()), address(tacit));
    }

    // ── more edges ──

    function test_ETHForcedInDoesNotBreakIt() public {
        vm.deal(address(fwd), 5 ether); // what a selfdestruct could do
        vm.prank(alice);
        fwd.splitDeposit{value: 1.15 ether}(_notes(p1, p01), _commits(2), _tx(0.05 ether));
        assertEq(address(fwd).balance, 5 ether, "the forced ETH is neither used nor touched");
        assertEq(tacit.received(), 0.05 ether);
    }

    function test_theForwarderTheTacitPoolAndZeroAreNotPools() public {
        address[3] memory bad = [address(fwd), address(tacit), address(0)];
        for (uint256 i; i < 3; ++i) {
            address[] memory pools = new address[](1);
            pools[0] = bad[i];
            vm.prank(alice);
            vm.expectRevert(TacitSplitDeposit.NotAPool.selector);
            fwd.splitDeposit{value: 1 ether}(pools, _commits(1), _tx(0));
        }
    }

    function test_moreCommitmentsThanPoolsIsAMismatchToo() public {
        vm.prank(alice);
        vm.expectRevert(TacitSplitDeposit.LengthMismatch.selector);
        fwd.splitDeposit{value: 1 ether}(_notes(p1, p1), _commits(3), _tx(0));
    }

    function test_exactlySixteenNotesGoThrough() public {
        address[] memory pools = new address[](16);
        for (uint256 i; i < 16; ++i) pools[i] = address(p01);
        vm.prank(alice);
        fwd.splitDeposit{value: 1.6 ether}(pools, _commits(16), _tx(0));
        assertEq(p01.nextIndex(), 16);
    }

    function test_theExtremesOfExtAmount() public {
        vm.startPrank(alice);
        vm.expectRevert(TacitSplitDeposit.NotADeposit.selector);
        fwd.splitDeposit(new address[](0), new bytes32[](0), _tx(type(int256).min));
        vm.expectRevert(abi.encodeWithSelector(TacitSplitDeposit.WrongValue.selector, 1 ether, uint256(type(int256).max)));
        fwd.splitDeposit{value: 1 ether}(new address[](0), new bytes32[](0), _tx(type(int256).max));
        vm.stopPrank();
    }

    // a note pool that calls back in must not be able to spend anything but what it sends: the call is checked against its own value
    function test_aReenteringNotePoolGainsNothing() public {
        ReenteringPool rp = new ReenteringPool();
        address[] memory pools = new address[](1);
        pools[0] = address(rp);
        TacitSplitDeposit f = new TacitSplitDeposit(address(tacit), pools);
        rp.aim(f);
        address[] memory list = new address[](1);
        list[0] = address(rp);
        vm.prank(alice);
        f.splitDeposit{value: 1 ether}(list, _commits(1), _tx(0));
        assertEq(rp.reentryOK(), 0, "a re-entering call with no value of its own is refused");
        assertEq(address(f).balance, 0);
        assertEq(address(rp).balance, 1 ether);
    }
}

/// A note pool that, when deposited into, tries to use the forwarder again without sending it anything.
contract ReenteringPool {
    uint256 public constant denomination = 1 ether;
    TacitSplitDeposit public f;
    uint256 public reentryOK;

    function aim(TacitSplitDeposit f_) external {
        f = f_;
    }

    function deposit(bytes32) external payable {
        address[] memory pools = new address[](1);
        pools[0] = address(this);
        bytes32[] memory c = new bytes32[](1);
        c[0] = bytes32(uint256(1));
        TacitSplitDeposit.Tx memory t;
        (bool ok,) = address(f).call(abi.encodeCall(f.splitDeposit, (pools, c, t)));
        if (ok) reentryOK = 1;
    }
}

/// The real Tacit pool's code, with a verifier that accepts any proof: everything the pool checks except the zero-knowledge proof itself runs (the
/// head and the insertion index, the binding of recipient, amount, relayer, fee and both memos, the ETH value, the relayer's fee payout).
/// TacitEvmPool is pinned to another compiler than this contract, so it is deployed by its artifact.
interface IRealTacitPool {
    function head() external view returns (bytes32, uint256);
    function ASSET_FIELD() external view returns (uint256);
    function nextIndex() external view returns (uint256);
}

contract YesVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata) external pure returns (bool) {
        return true;
    }
}

/// A relayer that is a contract: it records the gas the pool pays it with, and uses the forwarder again with the fee it was paid.
contract ReentrantRelayer {
    TacitSplitDeposit public fwd;
    address public note;

    constructor(TacitSplitDeposit f, address n) {
        fwd = f;
        note = n;
    }

    // transient storage: a plain storage write would cost more than the gas the pool gives a relayer
    function gasSeen() external view returns (uint256 g) {
        assembly { g := tload(1) }
    }

    function reentryOK() external view returns (uint256 g) {
        assembly { g := tload(2) }
    }

    receive() external payable {
        uint256 g = gasleft();
        assembly { tstore(1, g) }
        address[] memory pools = new address[](1);
        pools[0] = note;
        bytes32[] memory c = new bytes32[](1);
        c[0] = keccak256("the relayer's own note");
        TacitSplitDeposit.Tx memory t;
        (bool ok,) = address(fwd).call{value: msg.value}(abi.encodeCall(fwd.splitDeposit, (pools, c, t)));
        uint256 k = ok ? 1 : 0;
        assembly { tstore(2, k) }
    }
}

contract TacitSplitDepositRealPoolTest is Test {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    IRealTacitPool pool;
    TacitSplitDeposit fwd;
    MockFixedPool p01 = new MockFixedPool(0.1 ether);
    MockFixedPool p1 = new MockFixedPool(1 ether);
    address alice = address(0xA11CE);

    function setUp() public {
        pool = IRealTacitPool(deployCode("TacitEvmPool.sol:TacitEvmPool", abi.encode(address(new YesVerifier()), address(0))));
        address[] memory ps = new address[](2);
        ps[0] = address(p01);
        ps[1] = address(p1);
        fwd = new TacitSplitDeposit(address(pool), ps);
        vm.deal(alice, 1000 ether);
    }

    // a deposit the real pool accepts for the pool's head now: the root and index it must be built on, and the hash that binds its outside fields
    function _dep(uint256 ext, address relayer, uint256 fee) internal view returns (TacitSplitDeposit.Tx memory t) {
        t.extAmount = int256(ext);
        t.relayer = relayer;
        t.fee = fee;
        t.memo0 = hex"aa";
        t.memo1 = hex"bb";
        (bytes32 r, uint256 idx) = pool.head();
        t.publicInputs[0] = uint256(r);
        t.publicInputs[1] = uint256(r);
        t.publicInputs[2] = uint256(keccak256(abi.encode("new root", idx))) % P;
        t.publicInputs[3] = idx;
        t.publicInputs[4] = (ext - fee) % P;
        t.publicInputs[5] = uint256(keccak256(abi.encode(block.chainid, address(pool), t.recipient, t.extAmount, relayer, fee, keccak256(t.memo0), keccak256(t.memo1)))) % P;
        t.publicInputs[6] = pool.ASSET_FIELD();
        t.publicInputs[9] = uint256(keccak256(abi.encode("leaf", idx))) % P;
    }

    function _one(address a) internal pure returns (address[] memory p, bytes32[] memory cs) {
        p = new address[](1);
        p[0] = a;
        cs = new bytes32[](1);
        cs[0] = keccak256("note");
    }

    function test_theRealPoolTakesTheDepositThroughTheForwarder_andTheNoteToo() public {
        (address[] memory p, bytes32[] memory cs) = _one(address(p1));
        vm.prank(alice);
        fwd.splitDeposit{value: 1.5 ether}(p, cs, _dep(0.5 ether, address(0), 0));
        assertEq(address(pool).balance, 0.5 ether);
        assertEq(pool.nextIndex(), 2, "the pool inserted the deposit's two leaves");
        assertEq(address(fwd).balance, 0);
        assertEq(p1.nextIndex(), 1);
    }

    function test_aRelayerThatIsAContractIsPaidWith100kGas_andCanUseTheForwarderOnlyWithItsOwnValue() public {
        ReentrantRelayer rel = new ReentrantRelayer(fwd, address(p01));
        (address[] memory p, bytes32[] memory cs) = _one(address(p1));
        vm.prank(alice);
        fwd.splitDeposit{value: 2 ether}(p, cs, _dep(1 ether, address(rel), 0.1 ether));
        assertGt(rel.gasSeen(), 50_000, "the pool pays a relayer with 100,000 gas, not 2,300");
        assertEq(rel.reentryOK(), 1, "it could call back in, with the fee it was paid");
        assertEq(p01.nextIndex(), 1, "and its own note went in");
        assertEq(address(rel).balance, 0);
        assertEq(address(fwd).balance, 0);
        assertEq(address(pool).balance, 0.9 ether, "the pool kept the deposit less the fee");
    }

    function test_aProofNamingTheForwarderAsRelayerStrandsItsOwnFeeThere() public {
        vm.prank(alice);
        fwd.splitDeposit{value: 1 ether}(new address[](0), new bytes32[](0), _dep(1 ether, address(fwd), 0.1 ether));
        assertEq(address(fwd).balance, 0.1 ether, "the caller's own fee, paid where nobody can take it: the proof is the caller's to make");
    }

    function test_aStaleProofThroughTheRealPoolIsRefusedForLittleGas() public {
        (address[] memory p, bytes32[] memory cs) = _one(address(p1));
        TacitSplitDeposit.Tx memory stale = _dep(1 ether, address(0), 0);
        vm.prank(alice);
        fwd.splitDeposit{value: 2 ether}(p, cs, _dep(1 ether, address(0), 0)); // another deposit lands first
        bytes32[] memory cs2 = new bytes32[](1);
        cs2[0] = keccak256("another note");
        vm.prank(alice);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(fwd).call{value: 2 ether}(abi.encodeCall(fwd.splitDeposit, (p, cs2, stale)));
        uint256 used = before - gasleft();
        assertFalse(ok);
        assertEq(bytes4(ret), bytes4(keccak256("StaleRoot()")), "the pool's own error, which the wallet reads to prove again");
        assertLt(used, 80_000, "refused before any note is touched");
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
        TacitSplitDeposit.Tx memory none;
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
        TacitSplitDeposit.Tx memory t; // an all-zero proof for a 0.05 ETH deposit: the real pool refuses it on the asset check
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
