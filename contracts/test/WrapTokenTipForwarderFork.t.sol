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
    function approve(address, uint256) external returns (bool);
}

interface IPermit2View {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// Runs against the REAL, live ConfidentialPool and the REAL, live Permit2 on a mainnet fork — not mocks.
/// Covers both branches ConfidentialPool.wrap() itself picks between (see ReflectionLib.moveInUnderlying):
/// an escrow-backed asset (real USDC, transferFrom into the pool) and a poolMinted asset (real TAC, burned
/// directly from whoever called wrap — this forwarder, once Permit2 has handed it the tokens).
///   FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-path test/WrapTokenTipForwarderFork.t.sol
/// Skips (not fails) when FORK_URL is unset, so the regular suite never depends on network access.
contract WrapTokenTipForwarderForkTest is Test {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Verified live against the pool: cast call POOL "assets(bytes32)(...)" <id> before writing this test.
    bytes32 constant USDC_ASSET_ID = 0xc05bfed4c4eb61d2b39b643f841b78964ec96715a5795853b94be0dbc569c1d6;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // escrow-backed (poolMinted=false)
    bytes32 constant TAC_ASSET_ID = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279; // poolMinted=true (underlying == itself)

    bytes32 constant _PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 constant _PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    uint256 depositorPk = 0xA11CE;
    address depositor;
    address relay = address(0xBEEF);

    function _maybeFork() internal returns (bool ok) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping live-pool fork test"); return false; }
        vm.createSelectFork(url);
        depositor = vm.addr(depositorPk);
        return true;
    }

    /// Signs a real Permit2 AllowanceTransfer PermitSingle exactly as Permit2 itself will verify it —
    /// DOMAIN_SEPARATOR is read live from the real contract (it recomputes on the fly if block.chainid
    /// differs from what was cached at its own deployment, so this is correct on a fork regardless), and the
    /// nonce is read live too rather than assumed to be 0, so this holds even if depositor already has
    /// on-chain Permit2 history.
    function _signPermit(address token, address spender, uint256 amount)
        internal
        view
        returns (IPermit2.PermitSingle memory p, bytes memory signature)
    {
        (,, uint48 nonce) = IPermit2View(PERMIT2).allowance(depositor, token, spender);
        p = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: token, amount: uint160(amount), expiration: uint48(block.timestamp + 1 days), nonce: nonce}),
            spender: spender,
            sigDeadline: block.timestamp + 1 days
        });
        bytes32 detailsHash = keccak256(abi.encode(_PERMIT_DETAILS_TYPEHASH, p.details.token, p.details.amount, p.details.expiration, p.details.nonce));
        bytes32 structHash = keccak256(abi.encode(_PERMIT_SINGLE_TYPEHASH, detailsHash, p.spender, p.sigDeadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2View(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(depositorPk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function test_realEscrowBackedAssetUsdc() public {
        if (!_maybeFork()) return;
        WrapTokenTipForwarder fwd = new WrapTokenTipForwarder(POOL, USDC_ASSET_ID);

        uint256 amount = 100e6; // 100 USDC (6 decimals)
        uint256 tip = 0.0001 ether;
        deal(USDC, depositor, amount);
        vm.prank(depositor);
        IERC20Like(USDC).approve(PERMIT2, type(uint256).max); // the one real prerequisite: one-time approve to Permit2
        vm.deal(depositor, 1 ether);

        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(USDC, address(fwd), amount);
        bytes32 commit = keccak256("wraptokentipforwarder-fork-usdc");

        // Forked mainnet state: the pool, relay, and even this freshly-CREATE'd forwarder's own address may
        // already hold real mainnet balance (a fresh test-contract nonce sequence can land a new CREATE
        // address on one that's already active on live mainnet) — assert on the DELTA everywhere, never an
        // absolute value. Same reasoning as WrapTipForwarderFork.t.sol's equivalent comment.
        uint256 poolUsdcBefore = IERC20Like(USDC).balanceOf(POOL);
        uint256 relayBefore = relay.balance;
        uint256 fwdUsdcBefore = IERC20Like(USDC).balanceOf(address(fwd));
        uint256 fwdEthBefore = address(fwd).balance;

        vm.recordLogs();
        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(commit, amount, relay, p, sig);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawWrap;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == POOL && logs[i].topics[0] == IRealPool.Wrap.selector) {
                assertEq(logs[i].topics[2], USDC_ASSET_ID, "wrong asset id in real Wrap event");
                sawWrap = true;
            }
        }
        assertTrue(sawWrap, "real pool never emitted Wrap for USDC");
        assertEq(IERC20Like(USDC).balanceOf(POOL), poolUsdcBefore + amount, "pool didn't escrow exactly the USDC amount");
        assertEq(IERC20Like(USDC).balanceOf(address(fwd)), fwdUsdcBefore, "forwarder's USDC balance changed - it should pass everything through");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(address(fwd).balance, fwdEthBefore, "forwarder's ETH balance changed - it should pass everything through");
    }

    function test_realPoolMintedAssetTac() public {
        if (!_maybeFork()) return;
        WrapTokenTipForwarder fwd = new WrapTokenTipForwarder(POOL, TAC_ASSET_ID);

        uint256 amount = 100e18; // unitScale is 1e10 for cTAC, so this must be a multiple of that
        uint256 tip = 0.0001 ether;
        deal(TAC, depositor, amount);
        vm.prank(depositor);
        IERC20Like(TAC).approve(PERMIT2, type(uint256).max);
        vm.deal(depositor, 1 ether);

        (IPermit2.PermitSingle memory p, bytes memory sig) = _signPermit(TAC, address(fwd), amount);
        bytes32 commit = keccak256("wraptokentipforwarder-fork-tac");

        // See test_realEscrowBackedAssetUsdc's comment: forked mainnet state means this forwarder's own
        // address may already hold real balance, so assert on the delta, never an absolute value.
        uint256 relayBefore = relay.balance;
        uint256 depositorTacBefore = IERC20Like(TAC).balanceOf(depositor);
        uint256 fwdTacBefore = IERC20Like(TAC).balanceOf(address(fwd));
        uint256 fwdEthBefore = address(fwd).balance;

        vm.recordLogs();
        vm.prank(depositor);
        fwd.wrapWithTip{value: tip}(commit, amount, relay, p, sig);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawWrap;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == POOL && logs[i].topics[0] == IRealPool.Wrap.selector) {
                assertEq(logs[i].topics[2], TAC_ASSET_ID, "wrong asset id in real Wrap event");
                sawWrap = true;
            }
        }
        assertTrue(sawWrap, "real pool never emitted Wrap for TAC");
        // poolMinted: the pool BURNS the forwarder's balance rather than escrowing it, so unlike USDC there
        // is no pool-side balance increase to check — the depositor's balance decreasing by exactly `amount`
        // (with nothing left resting in the forwarder) is what proves the burn happened correctly.
        assertEq(IERC20Like(TAC).balanceOf(depositor), depositorTacBefore - amount, "depositor's TAC wasn't burned");
        assertEq(IERC20Like(TAC).balanceOf(address(fwd)), fwdTacBefore, "forwarder's TAC balance changed - it should pass everything through");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(address(fwd).balance, fwdEthBefore, "forwarder's ETH balance changed - it should pass everything through");
    }
}
