// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WrapTokenTipForwarder, IPermit2} from "../src/WrapTokenTipForwarder.sol";

/// Mirrors ConfidentialPool.wrap's real contract for a TOKEN asset: payable but reverts on any nonzero
/// msg.value, pulls TOKEN via transferFrom(msg.sender, ...) regardless of poolMinted/escrow-backed (the real
/// pool's own internal branch is the only thing that differs; a forwarder-level test only needs to see it
/// gets called correctly). Not a full pool — just enough surface for this forwarder, and generic over
/// multiple registered assets since the forwarder itself is now asset-agnostic per call.
contract MockWrapPool {
    mapping(bytes32 => bool) public registeredOf;
    mapping(bytes32 => address) public underlyingOf;
    bytes32 public lastAssetId;
    uint256 public lastAmount;
    bytes32 public lastCommit;
    uint256 public callCount;
    bool public failNext;

    error EthValueMismatch();

    function register(bytes32 assetId, address underlying) external {
        registeredOf[assetId] = true;
        underlyingOf[assetId] = underlying;
    }

    function setFailNext(bool v) external { failNext = v; }

    function assets(bytes32 assetId) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (registeredOf[assetId], underlyingOf[assetId], 1, bytes32(0), false, 18);
    }

    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable {
        if (failNext) revert("pool down");
        if (msg.value != 0) revert EthValueMismatch(); // every token asset forbids value, poolMinted or not
        MockERC20(underlyingOf[assetId]).transferFrom(msg.sender, address(this), amount);
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

/// Same as MockERC20 but with a `permit()` — simulating a real EIP-2612 token (USDC, wstETH). Not real
/// signature verification (that's WrapTokenTipForwarderFork.t.sol's job against the real thing); this just
/// needs to set allowance on success, or revert when told to, so the forwarder's own waterfall logic — try
/// permit, fall back to the allowance already there — is what's under test here.
contract MockERC20Permit is MockERC20 {
    bool public failPermit;

    function setFailPermit(bool v) external { failPermit = v; }

    function permit(address owner, address spender, uint256 value, uint256, uint8, bytes32, bytes32) external {
        if (failPermit) revert("stale nonce");
        allowance[owner][spender] = value;
    }
}

/// A real Permit2 verifies the signature and enforces its own nonce/deadline/spender rules; none of that is
/// this forwarder's code to test (that's the fork suite, against the real deployed Permit2). This mock only
/// needs to move tokens on `transferFrom` (simulating the user's real, one-time token.approve(PERMIT2, max))
/// and to optionally fail `permit()` so the try/catch best-effort path is exercised.
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
    MockERC20Permit usdcLike; // supports EIP-2612
    MockERC20 usdtLike; // no permit() at all, exactly like real USDT
    MockWrapPool pool;
    WrapTokenTipForwarder fwd;
    bytes32 constant USDC_ASSET = keccak256("cusdc-asset");
    bytes32 constant USDT_ASSET = keccak256("cusdt-asset");
    address depositor = address(0xD0);
    address relay = address(0xBEEF);

    event WrappedWithTip(bytes32 indexed assetId, bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient);

    function setUp() public {
        usdcLike = new MockERC20Permit();
        usdtLike = new MockERC20();
        pool = new MockWrapPool();
        pool.register(USDC_ASSET, address(usdcLike));
        pool.register(USDT_ASSET, address(usdtLike));

        MockPermit2 real = new MockPermit2();
        vm.etch(0x000000000022D473030F116dDEE9F6B43aC78BA3, address(real).code);

        fwd = new WrapTokenTipForwarder(address(pool));

        usdcLike.mint(depositor, 1_000_000e18);
        usdtLike.mint(depositor, 1_000_000e18);
        vm.prank(depositor);
        usdtLike.approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, type(uint256).max); // one-time real-world Permit2 approve
        vm.deal(depositor, 10 ether);
    }

    function _noPermit2612() internal pure returns (WrapTokenTipForwarder.Permit2612 memory) {
        return WrapTokenTipForwarder.Permit2612({deadline: 0, v: 0, r: 0, s: 0});
    }

    function _permit2612(uint256 amount) internal view returns (WrapTokenTipForwarder.Permit2612 memory) {
        // v=1 is not a valid secp256k1 recovery id, but MockERC20Permit doesn't check the signature at all —
        // it only needs v != 0 to be attempted. Real verification is the fork suite's job.
        return WrapTokenTipForwarder.Permit2612({deadline: block.timestamp + 1 days, v: 1, r: bytes32(amount), s: bytes32(0)});
    }

    function _noPermit2() internal pure returns (IPermit2.PermitSingle memory p, bytes memory sig) {
        p = IPermit2.PermitSingle({details: IPermit2.PermitDetails({token: address(0), amount: 0, expiration: 0, nonce: 0}), spender: address(0), sigDeadline: 0});
        sig = "";
    }

    function _permit2(address token, uint256 amount) internal view returns (IPermit2.PermitSingle memory p, bytes memory sig) {
        p = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: token, amount: uint160(amount), expiration: uint48(block.timestamp + 1 days), nonce: 0}),
            spender: address(fwd),
            sigDeadline: block.timestamp + 1 days
        });
        sig = "not-checked-by-mock";
    }

    // ── construction ──

    function test_constructorSetsImmutables() public view {
        assertEq(fwd.POOL(), address(pool));
    }

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(0));
        vm.expectRevert(WrapTokenTipForwarder.BadConfig.selector);
        new WrapTokenTipForwarder(address(0xDEAD)); // no code deployed at this address in a fresh test EVM
    }

    // ── per-call asset validation ──

    function test_revertsOnUnregisteredAsset() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _noPermit2();
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadAsset.selector);
        fwd.wrapWithTip(keccak256("unknown"), 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    function test_revertsOnNativeEthAsset() public {
        bytes32 ethAsset = keccak256("eth-asset");
        pool.register(ethAsset, address(0)); // native ETH belongs to WrapTipForwarder, not this contract
        (IPermit2.PermitSingle memory p, bytes memory sig) = _noPermit2();
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadAsset.selector);
        fwd.wrapWithTip(ethAsset, 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    // ── pull waterfall ──

    function test_pullsViaEip2612Permit() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _noPermit2();
        vm.prank(depositor);
        fwd.wrapWithTip(USDC_ASSET, 100e18, keccak256("c"), relay, _permit2612(100e18), p, sig);
        assertEq(pool.lastAmount(), 100e18);
        assertEq(usdcLike.balanceOf(address(pool)), 100e18);
    }

    function test_pullsViaExistingPlainAllowanceNoSignatureAtAll() public {
        // The depositor already did a normal approve() at some point before — no permit, no Permit2 signature.
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 100e18);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _noPermit2();
        vm.prank(depositor);
        fwd.wrapWithTip(USDC_ASSET, 100e18, keccak256("c"), relay, _noPermit2612(), p, sig);
        assertEq(pool.lastAmount(), 100e18);
    }

    function test_eip2612FailureStillSucceedsViaExistingAllowance() public {
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 50e18);
        usdcLike.setFailPermit(true);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _noPermit2();
        vm.prank(depositor);
        fwd.wrapWithTip(USDC_ASSET, 50e18, keccak256("c"), relay, _permit2612(50e18), p, sig);
        assertEq(pool.lastAmount(), 50e18);
    }

    function test_fallsThroughToPermit2WhenNoEip2612Support() public {
        // usdtLike has no permit() at all, exactly like real USDT — the EIP-2612 attempt must be skipped
        // (v=0) or it would revert on a nonexistent function; either way there's no allowance, so this must
        // fall through to Permit2.
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdtLike), 200e18);
        vm.prank(depositor);
        fwd.wrapWithTip(USDT_ASSET, 200e18, keccak256("c"), relay, _noPermit2612(), p, sig);
        assertEq(pool.lastAmount(), 200e18);
        assertEq(usdtLike.balanceOf(address(pool)), 200e18);
    }

    function test_permit2FailureStillSucceedsViaExistingPermit2Allowance() public {
        MockPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3).setFailPermit(true);
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdtLike), 75e18);
        vm.prank(depositor);
        fwd.wrapWithTip(USDT_ASSET, 75e18, keccak256("c"), relay, _noPermit2612(), p, sig);
        assertEq(pool.lastAmount(), 75e18);
    }

    function test_revertsWhenNoPullPathAuthorized() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _noPermit2();
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.NoPullAuthorized.selector);
        fwd.wrapWithTip(USDT_ASSET, 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    function test_revertsOnWrongPermit2Token() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdcLike), 10e18); // wrong token for USDT_ASSET
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(USDT_ASSET, 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    function test_revertsOnWrongPermit2Spender() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdtLike), 10e18);
        p.spender = address(0xBAD);
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(USDT_ASSET, 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    function test_revertsOnPermit2AmountBelowWrapAmount() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdtLike), 5e18); // signed for less
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(USDT_ASSET, 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    function test_revertsOnExpiredPermit2SigDeadline() public {
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdtLike), 10e18);
        p.sigDeadline = block.timestamp == 0 ? 0 : block.timestamp - 1;
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadPermit2.selector);
        fwd.wrapWithTip(USDT_ASSET, 10e18, keccak256("c"), relay, _noPermit2612(), p, sig);
    }

    // ── generic dispatch ──

    function test_sameForwarderHandlesTwoDifferentAssets() public {
        vm.startPrank(depositor);
        usdcLike.approve(address(fwd), 10e18);
        fwd.wrapWithTip(USDC_ASSET, 10e18, keccak256("a"), relay, _noPermit2612(), _emptyPermit2(), "");
        (IPermit2.PermitSingle memory p, bytes memory sig) = _permit2(address(usdtLike), 20e18);
        fwd.wrapWithTip(USDT_ASSET, 20e18, keccak256("b"), relay, _noPermit2612(), p, sig);
        vm.stopPrank();
        assertEq(pool.callCount(), 2);
        assertEq(usdcLike.balanceOf(address(pool)), 10e18);
        assertEq(usdtLike.balanceOf(address(pool)), 20e18);
    }

    function _emptyPermit2() internal pure returns (IPermit2.PermitSingle memory p) {
        (p,) = _noPermit2();
    }

    // ── tip / happy path ──

    function test_wrapWithTipEmitsAndForwardsEthTip() public {
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 100e18);
        uint256 relayBefore = relay.balance;
        bytes32 commit = keccak256("commit-1");

        vm.prank(depositor);
        vm.expectEmit(true, true, true, true);
        emit WrappedWithTip(USDC_ASSET, commit, 100e18, 0.01 ether, relay);
        fwd.wrapWithTip{value: 0.01 ether}(USDC_ASSET, 100e18, commit, relay, _noPermit2612(), _emptyPermit2(), "");

        assertEq(pool.lastAssetId(), USDC_ASSET);
        assertEq(pool.lastAmount(), 100e18);
        assertEq(usdcLike.balanceOf(address(fwd)), 0);
        assertEq(relay.balance, relayBefore + 0.01 ether);
        assertEq(address(fwd).balance, 0);
    }

    function test_zeroTipIsValidLossLeader() public {
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 50e18);
        vm.prank(depositor);
        fwd.wrapWithTip(USDC_ASSET, 50e18, keccak256("c"), relay, _noPermit2612(), _emptyPermit2(), "");
        assertEq(relay.balance, 0);
    }

    function test_zeroTipAllowsZeroRecipient() public {
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 10e18);
        vm.prank(depositor);
        fwd.wrapWithTip(USDC_ASSET, 10e18, keccak256("c"), address(0), _noPermit2612(), _emptyPermit2(), "");
        assertEq(pool.lastAmount(), 10e18);
    }

    function test_revertsOnNonzeroTipToZeroRecipient() public {
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 10e18);
        vm.prank(depositor);
        vm.expectRevert(WrapTokenTipForwarder.BadRecipient.selector);
        fwd.wrapWithTip{value: 0.01 ether}(USDC_ASSET, 10e18, keccak256("c"), address(0), _noPermit2612(), _emptyPermit2(), "");
    }

    function test_poolRevertRollsBackEverythingIncludingTipAndPull() public {
        vm.prank(depositor);
        usdcLike.approve(address(fwd), 10e18);
        pool.setFailNext(true);
        uint256 relayBefore = relay.balance;
        uint256 depositorTokenBefore = usdcLike.balanceOf(depositor);
        vm.prank(depositor);
        vm.expectRevert("pool down");
        fwd.wrapWithTip{value: 0.01 ether}(USDC_ASSET, 10e18, keccak256("c"), relay, _noPermit2612(), _emptyPermit2(), "");
        assertEq(relay.balance, relayBefore);
        assertEq(usdcLike.balanceOf(depositor), depositorTokenBefore);
        assertEq(address(fwd).balance, 0);
    }

    // ── fuzz ──

    function testFuzz_wrapWithTipNeverStrandsValue(uint128 amountRaw, uint96 tipRaw) public {
        uint256 amount = bound(amountRaw, 1, 1_000_000e18);
        uint256 tip = bound(tipRaw, 0, 5 ether);
        vm.deal(depositor, tip);
        vm.prank(depositor);
        usdcLike.approve(address(fwd), amount);

        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(USDC_ASSET, amount, keccak256(abi.encode(amount, tip)), relay, _noPermit2612(), _emptyPermit2(), "");

        assertEq(usdcLike.balanceOf(address(pool)), amount);
        assertEq(usdcLike.balanceOf(address(fwd)), 0);
        assertEq(address(fwd).balance, 0);
    }
}
