// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WrapTokenTipForwarder, IPermit2} from "../src/WrapTokenTipForwarder.sol";

/// Mirrors ConfidentialPool.wrap's real contract for a TOKEN asset: payable but reverts on any nonzero
/// msg.value, pulls TOKEN via transferFrom(msg.sender, ...) regardless of poolMinted/escrow-backed (the real
/// pool's own internal branch is the only thing that differs; a forwarder-level test only needs to see it
/// gets called correctly). Not a full pool — just enough surface for this forwarder.
contract MockWrapPool {
    bytes32 public lastAssetId;
    uint256 public lastAmount;
    bytes32 public lastCommit;
    uint256 public callCount;
    bool public failNext;
    bool public registeredOverride = true;
    address public underlyingOverride;

    error EthValueMismatch();

    constructor(address underlying) { underlyingOverride = underlying; }

    function setFailNext(bool v) external { failNext = v; }
    function setAssetConfig(bool registered, address underlying) external { registeredOverride = registered; underlyingOverride = underlying; }

    function assets(bytes32) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (registeredOverride, underlyingOverride, 1, bytes32(0), false, 18);
    }

    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable {
        if (failNext) revert("pool down");
        if (msg.value != 0) revert EthValueMismatch(); // every token asset forbids value, poolMinted or not
        MockERC20(underlyingOverride).transferFrom(msg.sender, address(this), amount);
        lastAssetId = assetId;
        lastAmount = amount;
        lastCommit = commit;
        callCount++;
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != from) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A real Permit2 verifies the signature and enforces its own nonce/deadline/spender rules; none of that is
/// this forwarder's code to test (that's WrapTokenTipForwarderFork.t.sol, against the real deployed Permit2).
/// This mock only needs to move tokens on `transferFrom` (simulating the user's real, one-time
/// token.approve(PERMIT2, max)) and to optionally fail `permit()` so the try/catch best-effort path is
/// exercised.
contract MockPermit2 {
    bool public failPermit;
    uint256 public permitCallCount;

    function setFailPermit(bool v) external { failPermit = v; }

    function permit(address, IPermit2.PermitSingle calldata, bytes calldata) external {
        if (failPermit) revert("stale nonce");
        permitCallCount++;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        MockERC20(token).transferFrom(from, to, amount);
    }
}

contract WrapTokenTipForwarderTest is Test {
    MockERC20 token;
    MockWrapPool pool;
    WrapTokenTipForwarder fwd;
    bytes32 constant ASSET = keccak256("cusdc-asset");
    address depositor = address(0xD0);
    address relay = address(0xBEEF);

    event WrappedWithTip(bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient);

    function setUp() public {
        token = new MockERC20();
        pool = new MockWrapPool(address(token));
        // Real Permit2 lives at a fixed canonical address; the forwarder hardcodes it as a `constant`, so
        // the mock must be etched at that exact address rather than constructed normally.
        MockPermit2 real = new MockPermit2();
        vm.etch(0x000000000022D473030F116dDEE9F6B43aC78BA3, address(real).code);

        fwd = new WrapTokenTipForwarder(address(pool), ASSET);

        token.mint(depositor, 1_000_000e18);
        // The one real-world prerequisite this forwarder relies on: a one-time approve to Permit2 itself.
        vm.prank(depositor);
        token.approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, type(uint256).max);
        vm.deal(depositor, 10 ether);
    }

    function _permit(uint256 amount) internal view returns (IPermit2.PermitSingle memory p) {
        p = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: address(token), amount: uint160(amount), expiration: uint48(block.timestamp + 1 days), nonce: 0}),
            spender: address(fwd),
            sigDeadline: block.timestamp + 1 days
        });
    }

    // ── construction ──

    function test_constructorSetsImmutables() public view {
        assertEq(fwd.POOL(), address(pool));
        assertEq(fwd.ASSET_ID(), ASSET);
        assertEq(fwd.TOKEN(), address(token));
    }

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(0), ASSET);
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(pool), bytes32(0));
    }

    function test_constructorRejectsCodelessPool() public {
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(0xDEAD), ASSET);
    }

    function test_constructorRejectsUnregisteredAsset() public {
        pool.setAssetConfig(false, address(token));
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(pool), ASSET);
    }

    function test_constructorRejectsNativeEthUnderlying() public {
        // underlying == address(0) is WrapTipForwarder's (the ETH sibling's) asset, not this contract's.
        pool.setAssetConfig(true, address(0));
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(pool), ASSET);
    }

    // ── happy path ──

    function test_wrapWithTipPullsExactAmountAndForwardsTip() public {
        bytes32 commit = keccak256("commit-1");
        uint256 amount = 1_000e18;
        uint256 tip = 0.01 ether;
        uint256 relayBefore = relay.balance;

        vm.prank(depositor);
        vm.expectEmit(true, true, true, true);
        emit WrappedWithTip(commit, amount, tip, relay);
        fwd.wrapWithTip{value: tip}(commit, amount, relay, _permit(amount), "");

        assertEq(pool.lastAssetId(), ASSET);
        assertEq(pool.lastAmount(), amount);
        assertEq(pool.lastCommit(), commit);
        assertEq(pool.callCount(), 1);
        assertEq(token.balanceOf(address(pool)), amount);
        assertEq(token.balanceOf(address(fwd)), 0);
        assertEq(relay.balance, relayBefore + tip);
        assertEq(address(fwd).balance, 0);
    }

    function test_zeroTipIsValidLossLeader() public {
        bytes32 commit = keccak256("commit-2");
        uint256 amount = 500e18;

        vm.prank(depositor);
        vm.expectEmit(true, true, true, true);
        emit WrappedWithTip(commit, amount, 0, relay);
        fwd.wrapWithTip(commit, amount, relay, _permit(amount), ""); // no value sent at all

        assertEq(pool.lastAmount(), amount);
        assertEq(relay.balance, 0);
    }

    function test_zeroTipAllowsZeroRecipient() public {
        vm.prank(depositor);
        fwd.wrapWithTip(keccak256("c"), 100e18, address(0), _permit(100e18), "");
        assertEq(pool.lastAmount(), 100e18);
    }

    function test_secondWrapReusesInfiniteApprovalWithoutReapproving() public {
        // The pool pulls exactly `amount` each time, fully consuming what MockERC20 tracks as allowance from
        // the forwarder — but the forwarder's own allowance CHECK (`allowance(this, POOL) < amount`) only
        // re-approves when insufficient, so a max approve on the first call should make the second call's
        // approve a no-op. This isn't directly observable via MockERC20 alone, so just confirm both wraps
        // succeed correctly back-to-back, which they can't if lazy-approve logic were broken.
        vm.startPrank(depositor);
        fwd.wrapWithTip(keccak256("a"), 10e18, relay, _permit(10e18), "");
        fwd.wrapWithTip(keccak256("b"), 20e18, relay, _permit(20e18), "");
        vm.stopPrank();
        assertEq(pool.callCount(), 2);
        assertEq(token.balanceOf(address(pool)), 30e18);
    }

    // ── best-effort permit ──

    function test_permitFailureStillSucceedsViaExistingAllowance() public {
        // Simulates a replayed/already-applied permit: permit() reverts on its stale nonce, but Permit2's
        // transferFrom still works off the allowance the user already granted directly.
        MockPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3).setFailPermit(true);
        vm.prank(depositor);
        fwd.wrapWithTip(keccak256("c"), 50e18, relay, _permit(50e18), "");
        assertEq(pool.lastAmount(), 50e18);
    }

    // ── rejections ──

    function test_revertsOnWrongPermitToken() public {
        IPermit2.PermitSingle memory p = _permit(10e18);
        p.details.token = address(0xBAD);
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(keccak256("c"), 10e18, relay, p, "");
    }

    function test_revertsOnWrongSpender() public {
        IPermit2.PermitSingle memory p = _permit(10e18);
        p.spender = address(0xBAD); // not this forwarder
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(keccak256("c"), 10e18, relay, p, "");
    }

    function test_revertsOnPermitAmountBelowWrapAmount() public {
        IPermit2.PermitSingle memory p = _permit(5e18); // signed for less than the wrap amount
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(keccak256("c"), 10e18, relay, p, "");
    }

    function test_revertsOnExpiredSigDeadline() public {
        IPermit2.PermitSingle memory p = _permit(10e18);
        p.sigDeadline = block.timestamp == 0 ? 0 : block.timestamp - 1;
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(keccak256("c"), 10e18, relay, p, "");
    }

    function test_revertsOnNonzeroTipToZeroRecipient() public {
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadRecipient.selector);
        fwd.wrapWithTip{value: 0.01 ether}(keccak256("c"), 10e18, address(0), _permit(10e18), "");
    }

    function test_poolRevertRollsBackEverythingIncludingTipAndPull() public {
        pool.setFailNext(true);
        uint256 relayBefore = relay.balance;
        uint256 depositorTokenBefore = token.balanceOf(depositor);
        vm.prank(depositor);
        vm.expectRevert("pool down");
        fwd.wrapWithTip{value: 0.01 ether}(keccak256("c"), 10e18, relay, _permit(10e18), "");
        // Atomic: a failed wrap never pays a tip and never leaves the pull half-done.
        assertEq(relay.balance, relayBefore);
        assertEq(token.balanceOf(depositor), depositorTokenBefore);
        assertEq(address(fwd).balance, 0);
    }

    // ── fuzz ──

    function testFuzz_wrapWithTipNeverStrandsValue(uint128 amountRaw, uint96 tipRaw) public {
        uint256 amount = bound(amountRaw, 1, 1_000_000e18);
        uint256 tip = bound(tipRaw, 0, 5 ether);
        vm.deal(depositor, tip);

        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(keccak256(abi.encode(amount, tip)), amount, relay, _permit(amount), "");

        assertEq(token.balanceOf(address(pool)), amount);
        assertEq(token.balanceOf(address(fwd)), 0);
        assertEq(address(fwd).balance, 0);
    }
}
