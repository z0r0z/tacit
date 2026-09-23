// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {WrapTokenTipForwarder, IPermit2} from "../src/WrapTokenTipForwarder.sol";

interface IRealPool {
    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount);
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    // No bool return declared: real USDT's approve() returns nothing at all (ends via STOP, zero return
    // data) — decoding a bool from that reverts. Omitting the return type works for both USDT and every
    // standard ERC20 (Solidity just ignores unread return data when a call succeeds).
    function approve(address, uint256) external;
}

interface IERC2612Like {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
}

interface IPermit2View {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// Runs against the REAL, live ConfidentialPool, real Permit2, and real mainnet tokens — not mocks. Covers
/// all three legs of the pull waterfall against the real thing, and both branches ConfidentialPool.wrap()
/// itself picks between (see ReflectionLib.moveInUnderlying): escrow-backed (real USDC/USDT, transferFrom
/// into the pool) and poolMinted (real TAC, burned directly from whoever called wrap).
///   FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-path test/WrapTokenTipForwarderFork.t.sol
/// Skips (not fails) when FORK_URL is unset, so the regular suite never depends on network access.
contract WrapTokenTipForwarderForkTest is Test {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Verified live against the pool before writing this test: cast call POOL "assets(bytes32)(...)" <id>.
    bytes32 constant USDC_ASSET_ID = 0xc05bfed4c4eb61d2b39b643f841b78964ec96715a5795853b94be0dbc569c1d6;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // escrow-backed, real EIP-2612 support
    bytes32 constant USDT_ASSET_ID = 0xc50e8dd9666f64a23e5457d686382901f08aaea3554328fc4ac25d2f9fac6c00;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // escrow-backed, NO permit() at all
    bytes32 constant TAC_ASSET_ID = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279; // poolMinted (underlying == itself)

    // ERC-2612 (https://eips.ethereum.org/EIPS/eip-2612): Permit(owner,spender,value,nonce,deadline) — nonce
    // BEFORE deadline, unlike Permit2's own struct. Verified against the spec text before writing this.
    bytes32 constant _EIP2612_PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    bytes32 constant _PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 constant _PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    uint256 depositorPk = 0xA11CE;
    address depositor;
    address relay = address(0xBEEF);
    WrapTokenTipForwarder fwd;

    function _maybeFork() internal returns (bool ok) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping live-pool fork test"); return false; }
        vm.createSelectFork(url);
        depositor = vm.addr(depositorPk);
        fwd = new WrapTokenTipForwarder(POOL);
        return true;
    }

    function _emptyPermit2612() internal pure returns (WrapTokenTipForwarder.Permit2612 memory) {
        return WrapTokenTipForwarder.Permit2612({deadline: 0, v: 0, r: 0, s: 0});
    }

    function _emptyPermit2() internal pure returns (IPermit2.PermitSingle memory p, bytes memory sig) {
        p = IPermit2.PermitSingle({details: IPermit2.PermitDetails({token: address(0), amount: 0, expiration: 0, nonce: 0}), spender: address(0), sigDeadline: 0});
        sig = "";
    }

    /// Signs a real EIP-2612 permit exactly as the token itself will verify it — DOMAIN_SEPARATOR and nonce
    /// both read live from the token rather than assumed, so this holds even if depositor already has history.
    function _signEip2612(address token, uint256 amount) internal view returns (WrapTokenTipForwarder.Permit2612 memory p) {
        uint256 nonce = IERC2612Like(token).nonces(depositor);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 structHash = keccak256(abi.encode(_EIP2612_PERMIT_TYPEHASH, depositor, address(fwd), amount, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC2612Like(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(depositorPk, digest);
        p = WrapTokenTipForwarder.Permit2612({deadline: deadline, v: v, r: r, s: s});
    }

    /// Signs a real Permit2 AllowanceTransfer PermitSingle exactly as Permit2 itself will verify it.
    function _signPermit2(address token, uint256 amount) internal view returns (IPermit2.PermitSingle memory p, bytes memory signature) {
        (,, uint48 nonce) = IPermit2View(PERMIT2).allowance(depositor, token, address(fwd));
        p = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: token, amount: uint160(amount), expiration: uint48(block.timestamp + 1 days), nonce: nonce}),
            spender: address(fwd),
            sigDeadline: block.timestamp + 1 days
        });
        bytes32 detailsHash = keccak256(abi.encode(_PERMIT_DETAILS_TYPEHASH, p.details.token, p.details.amount, p.details.expiration, p.details.nonce));
        bytes32 structHash = keccak256(abi.encode(_PERMIT_SINGLE_TYPEHASH, detailsHash, p.spender, p.sigDeadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2View(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(depositorPk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _assertRealWrap(bytes32 assetId, Vm.Log[] memory logs) internal {
        bool sawWrap;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == POOL && logs[i].topics[0] == IRealPool.Wrap.selector) {
                assertEq(logs[i].topics[2], assetId, "wrong asset id in real Wrap event");
                sawWrap = true;
            }
        }
        assertTrue(sawWrap, "real pool never emitted Wrap");
    }

    // ── leg 1: real EIP-2612 permit (real USDC) ──

    function test_realUsdcViaEip2612Permit() public {
        if (!_maybeFork()) return;

        uint256 amount = 100e6; // 100 USDC (6 decimals)
        uint256 tip = 0.0001 ether;
        deal(USDC, depositor, amount);
        vm.deal(depositor, 1 ether);

        WrapTokenTipForwarder.Permit2612 memory permit2612 = _signEip2612(USDC, amount);
        (IPermit2.PermitSingle memory p2, bytes memory sig2) = _emptyPermit2();
        bytes32 commit = keccak256("wraptokentipforwarder-fork-usdc-eip2612");

        uint256 poolUsdcBefore = IERC20Like(USDC).balanceOf(POOL);
        uint256 relayBefore = relay.balance;
        uint256 fwdEthBefore = address(fwd).balance;

        vm.recordLogs();
        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(USDC_ASSET_ID, amount, commit, relay, permit2612, p2, sig2);

        _assertRealWrap(USDC_ASSET_ID, vm.getRecordedLogs());
        assertEq(IERC20Like(USDC).balanceOf(POOL), poolUsdcBefore + amount, "pool didn't escrow exactly the USDC amount");
        assertEq(IERC20Like(USDC).balanceOf(address(fwd)), 0, "forwarder kept USDC dust");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(address(fwd).balance, fwdEthBefore, "forwarder's ETH balance changed - it should pass everything through");
    }

    // ── leg 2: plain pre-existing allowance, no signature at all (real TAC, exercises the burn path) ──

    function test_realTacViaPlainAllowanceNoSignature() public {
        if (!_maybeFork()) return;

        uint256 amount = 100e18; // unitScale is 1e10 for cTAC, so this must be a multiple of that
        uint256 tip = 0.0001 ether;
        deal(TAC, depositor, amount);
        vm.prank(depositor);
        IERC20Like(TAC).approve(address(fwd), amount); // plain approve directly to the forwarder - no signing at all
        vm.deal(depositor, 1 ether);

        (IPermit2.PermitSingle memory p2, bytes memory sig2) = _emptyPermit2();
        bytes32 commit = keccak256("wraptokentipforwarder-fork-tac-allowance");

        uint256 relayBefore = relay.balance;
        uint256 depositorTacBefore = IERC20Like(TAC).balanceOf(depositor);
        uint256 fwdEthBefore = address(fwd).balance;

        vm.recordLogs();
        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(TAC_ASSET_ID, amount, commit, relay, _emptyPermit2612(), p2, sig2);

        _assertRealWrap(TAC_ASSET_ID, vm.getRecordedLogs());
        // poolMinted: the pool BURNS the forwarder's balance rather than escrowing it, so the depositor's
        // balance decreasing by exactly `amount` (with nothing left resting in the forwarder) is what proves
        // the burn happened correctly.
        assertEq(IERC20Like(TAC).balanceOf(depositor), depositorTacBefore - amount, "depositor's TAC wasn't burned");
        assertEq(IERC20Like(TAC).balanceOf(address(fwd)), 0, "forwarder kept TAC dust");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(address(fwd).balance, fwdEthBefore, "forwarder's ETH balance changed - it should pass everything through");
    }

    // ── leg 3: Permit2 fallback (real USDT, which has NO permit() at all) ──

    function test_realUsdtViaPermit2Fallback() public {
        if (!_maybeFork()) return;

        uint256 amount = 100e6; // 100 USDT (6 decimals)
        uint256 tip = 0.0001 ether;
        deal(USDT, depositor, amount);
        vm.prank(depositor);
        IERC20Like(USDT).approve(PERMIT2, type(uint256).max); // the one real prerequisite: one-time approve to Permit2
        vm.deal(depositor, 1 ether);

        (IPermit2.PermitSingle memory p2, bytes memory sig2) = _signPermit2(USDT, amount);
        bytes32 commit = keccak256("wraptokentipforwarder-fork-usdt-permit2");

        uint256 poolUsdtBefore = IERC20Like(USDT).balanceOf(POOL);
        uint256 relayBefore = relay.balance;
        uint256 fwdEthBefore = address(fwd).balance;

        vm.recordLogs();
        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(USDT_ASSET_ID, amount, commit, relay, _emptyPermit2612(), p2, sig2);

        _assertRealWrap(USDT_ASSET_ID, vm.getRecordedLogs());
        assertEq(IERC20Like(USDT).balanceOf(POOL), poolUsdtBefore + amount, "pool didn't escrow exactly the USDT amount");
        assertEq(IERC20Like(USDT).balanceOf(address(fwd)), 0, "forwarder kept USDT dust");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(address(fwd).balance, fwdEthBefore, "forwarder's ETH balance changed - it should pass everything through");
    }
}
