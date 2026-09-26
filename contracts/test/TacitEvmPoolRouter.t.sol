// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter, TacitBox} from "../src/TacitEvmPoolRouter.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {TacitPublicAmm} from "../src/TacitPublicAmm.sol";
import {IPermit2} from "../src/ConfidentialRouter.sol";
import {StubVerifier, MockUSDC, MockPermit2, MockZRouter} from "./ConfidentialRouter.t.sol";
import {AcceptTransact, PoolToken} from "./TacitEvmPool.t.sol";
import {TransactVerifierDev} from "./TransactVerifierDev.sol";

/// Token → ETH leg for the zap tests: pulls the input and pays `outAmount` ETH from its own balance.
contract MockZRouterToEth {
    function swapTokenForETH(address tokenIn, uint256 inAmount, uint256 outAmount) external {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), inAmount);
        SafeTransferLib.safeTransferETH(msg.sender, outAmount);
    }

    receive() external payable {}
}

/// Builds the public inputs the pool itself checks, so an accept-all verifier exercises every non-proof rule.
abstract contract TxBuilder is Test {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function _tx(
        TacitEvmPool pool,
        uint256 newRoot,
        uint256 nf0,
        uint256[2] memory leaves,
        address recipient,
        int256 ext,
        address relayer,
        uint256 fee,
        bytes memory memo0,
        bytes memory memo1
    ) internal view returns (TacitEvmPoolRouter.Tx memory t) {
        t.publicInputs[0] = uint256(pool.root());
        t.publicInputs[1] = uint256(pool.root());
        t.publicInputs[2] = newRoot;
        t.publicInputs[3] = pool.nextIndex();
        int256 pa = (ext - int256(fee)) % int256(P);
        t.publicInputs[4] = uint256(pa < 0 ? pa + int256(P) : pa);
        t.publicInputs[5] = uint256(
            keccak256(abi.encode(block.chainid, address(pool), recipient, ext, relayer, fee, keccak256(memo0), keccak256(memo1)))
        ) % P;
        t.publicInputs[6] = uint256(keccak256(abi.encode(block.chainid, address(pool), pool.ASSET()))) % P;
        t.publicInputs[7] = nf0;
        t.publicInputs[9] = leaves[0];
        t.publicInputs[10] = leaves[1];
        t.recipient = recipient;
        t.extAmount = ext;
        t.relayer = relayer;
        t.fee = fee;
        t.memo0 = memo0;
        t.memo1 = memo1;
    }

    function _send(TacitEvmPool pool, TacitEvmPoolRouter.Tx memory t, uint256 value) internal {
        pool.transact{value: value}(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
    }

    function _noLeaves() internal pure returns (uint256[2] memory l) {}

    function _leaves(uint256 a, uint256 b) internal pure returns (uint256[2] memory l) {
        l[0] = a;
        l[1] = b;
    }
}

contract TacitEvmPoolRouterTest is TxBuilder {
    bytes32 constant TETH_LINK = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant COMMIT = keccak256("v1-note-commit");
    uint256 constant USER_PK = 0xA11CE;

    MockUSDC usdc;
    TacitEvmPool pool;
    TacitEvmPool ethPool;
    TacitEvmPoolRouter router;
    TacitEvmPoolRouter ethRouter;
    MockPermit2 permit2;
    MockZRouter zr;
    MockZRouterToEth zrEth;
    ConfidentialPool v1;
    bytes32 usdcId;
    address user;
    address keeper = address(0x4EE9E5);
    address refund = address(0x5AFE);

    function setUp() public {
        vm.chainId(1);
        user = vm.addr(USER_PK);
        usdc = new MockUSDC();
        address verifier = address(new AcceptTransact());
        pool = new TacitEvmPool(verifier, address(usdc));
        ethPool = new TacitEvmPool(verifier, address(0));
        permit2 = new MockPermit2();
        zr = new MockZRouter();
        zrEth = new MockZRouterToEth();
        vm.deal(address(zrEth), 100 ether);

        TacitPublicAmm amm = new TacitPublicAmm(address(this));
        v1 = new ConfidentialPool(
            address(new StubVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 0,
            bytes32(0), TETH_LINK, address(0), address(0), address(0), address(amm)
        );
        amm.initialize(address(v1));
        usdcId = v1.registerWrapped(address(usdc), 1, bytes32(0), "USD Coin", "USDC", 6);

        router = new TacitEvmPoolRouter(address(pool), address(zr), address(permit2), address(v1));
        ethRouter = new TacitEvmPoolRouter(address(ethPool), address(zrEth), address(permit2), address(v1));
        usdc.mint(user, 1_000_000);
        vm.deal(user, 10 ether);
    }

    // ──────────────────── helpers ────────────────────

    function _permit(address token, uint256 amount, address spender) internal view returns (IPermit2.PermitSingle memory) {
        return IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({token: token, amount: uint160(amount), expiration: type(uint48).max, nonce: 0}),
            spender: spender,
            sigDeadline: block.timestamp + 1 hours
        });
    }

    function _depositIntent(uint256 amount, uint256[2] memory leaves, bytes memory memo0)
        internal
        view
        returns (TacitEvmPoolRouter.DepositIntent memory i)
    {
        i.amount = amount;
        i.outLeaf0 = leaves[0];
        i.outLeaf1 = leaves[1];
        i.memo0Hash = keccak256(memo0);
        i.memo1Hash = keccak256("");
        i.refund = refund;
        i.deadline = uint64(block.timestamp + 1 days);
        i.nonce = 1;
    }

    function _wrapIntent(bytes32 assetId, uint256 amount, uint256 tip) internal view returns (TacitEvmPoolRouter.WrapIntent memory w) {
        w.assetId = assetId;
        w.amount = amount;
        w.tip = tip;
        w.commit = COMMIT;
        w.refund = refund;
        w.deadline = uint64(block.timestamp + 1 days);
        w.nonce = 7;
    }

    // ──────────────────── 1. signature-approved deposits ────────────────────

    function test_depositWithPermit2() public {
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(1, 0), address(0), 500, address(0), 0, "", "");
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        router.depositWithPermit2(t, _permit(address(usdc), 500, address(router)), "");
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(pool)), 500);
        assertEq(usdc.balanceOf(user), 1_000_000 - 500);
        assertEq(pool.nextIndex(), 2);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_depositWithPermit_2612() public {
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(1, 0), address(0), 700, address(0), 0, "", "");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        user, address(router), uint256(700), usdc.nonces(user), deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        vm.prank(user);
        router.depositWithPermit(t, deadline, v, r, s);
        assertEq(usdc.balanceOf(address(pool)), 700);
    }

    function test_deposit_helpers_reject_withdrawals() public {
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 5, _leaves(0, 0), user, -1, address(0), 0, "", "");
        IPermit2.PermitSingle memory ps = _permit(address(usdc), 1, address(router));
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.depositWithPermit2(t, ps, "");
    }

    // ──────────────────── 2. zaps ────────────────────

    function test_zapETHToDeposit_refunds_surplus() public {
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(1, 0), address(0), 1000, address(0), 0, "", "");
        bytes memory swap = abi.encodeWithSelector(MockZRouter.swapETHForToken.selector, address(usdc), uint256(1030));
        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        router.zapETHToDeposit{value: 0.1 ether}(t, swap);
        assertEq(usdc.balanceOf(address(pool)), 1000);
        assertEq(usdc.balanceOf(user), before + 30, "surplus output refunded");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_zapETHToDeposit_short_swap_reverts() public {
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(1, 0), address(0), 1000, address(0), 0, "", "");
        bytes memory swap = abi.encodeWithSelector(MockZRouter.swapETHForToken.selector, address(usdc), uint256(999));
        vm.prank(user);
        vm.expectRevert(TacitEvmPoolRouter.ShortSwapOutput.selector);
        router.zapETHToDeposit{value: 0.1 ether}(t, swap);
    }

    function test_zapTokenToDeposit_into_eth_pool() public {
        TacitEvmPoolRouter.Tx memory t = _tx(ethPool, 11, 0, _leaves(1, 0), address(0), 1 ether, address(0), 0, "", "");
        bytes memory swap = abi.encodeWithSelector(MockZRouterToEth.swapTokenForETH.selector, address(usdc), uint256(5000), uint256(1.2 ether));
        uint256 ethBefore = user.balance;
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        ethRouter.zapTokenToDepositWithPermit2(t, 6000, _permit(address(usdc), 6000, address(ethRouter)), "", swap);
        vm.stopPrank();
        assertEq(address(ethPool).balance, 1 ether);
        assertEq(user.balance, ethBefore + 0.2 ether, "surplus ETH refunded");
        assertEq(usdc.balanceOf(user), 1_000_000 - 5000, "unspent input refunded");
        assertEq(address(ethRouter).balance, 0);
    }

    // ──────────────────── 3. deposit boxes ────────────────────

    function test_deposit_box_completed_by_keeper_who_earns_the_fee() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box = router.depositBoxOf(i);
        assertEq(box.code.length, 0);
        vm.prank(user);
        usdc.transfer(box, 1000); // e.g. a V1 withdrawal whose recipient is the box
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(21, 22), address(0), 1000, keeper, 7, hex"aa", "");
        vm.prank(keeper);
        router.completeDeposit(i, t);
        assertEq(usdc.balanceOf(address(pool)), 993);
        assertEq(usdc.balanceOf(keeper), 7);
        assertEq(usdc.balanceOf(box), 0);
        assertEq(pool.nextIndex(), 2);
    }

    function test_deposit_box_rejects_other_notes_memos_or_amounts() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box_ = router.depositBoxOf(i);
        vm.prank(user);
        usdc.transfer(box_, 1000);

        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(21, 99), address(0), 1000, keeper, 0, hex"aa", "");
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.completeDeposit(i, t);

        t = _tx(pool, 11, 0, _leaves(21, 22), address(0), 1000, keeper, 0, hex"bb", "");
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.completeDeposit(i, t);

        t = _tx(pool, 11, 0, _leaves(21, 22), address(0), 999, keeper, 0, hex"aa", "");
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.completeDeposit(i, t);

        t = _tx(pool, 11, 0, _leaves(21, 22), keeper, 1000, keeper, 0, hex"aa", "");
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.completeDeposit(i, t);
    }

    function test_tampered_intent_maps_to_an_empty_box() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box_ = router.depositBoxOf(i);
        vm.prank(user);
        usdc.transfer(box_, 1000);
        TacitEvmPoolRouter.DepositIntent memory other = _depositIntent(1000, _leaves(21, 22), hex"aa");
        other.refund = keeper;
        assertTrue(router.depositBoxOf(other) != router.depositBoxOf(i));
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(21, 22), address(0), 1000, keeper, 0, hex"aa", "");
        vm.expectRevert();
        router.completeDeposit(other, t);
    }

    function test_underfunded_box_cannot_complete() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box_ = router.depositBoxOf(i);
        vm.prank(user);
        usdc.transfer(box_, 999);
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(21, 22), address(0), 1000, keeper, 0, hex"aa", "");
        vm.expectRevert();
        router.completeDeposit(i, t);
    }

    function test_deposit_box_reclaim_only_after_deadline_and_only_to_refund() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box = router.depositBoxOf(i);
        vm.prank(user);
        usdc.transfer(box, 1234);
        vm.expectRevert(TacitEvmPoolRouter.NotExpired.selector);
        router.reclaimDeposit(i, address(usdc));
        vm.warp(i.deadline + 1);
        vm.prank(keeper);
        router.reclaimDeposit(i, address(usdc));
        assertEq(usdc.balanceOf(refund), 1234);
        assertEq(usdc.balanceOf(box), 0);
        vm.expectRevert(TacitEvmPoolRouter.NothingToReclaim.selector);
        router.reclaimDeposit(i, address(usdc));
    }

    function test_surplus_left_after_completion_is_reclaimable() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box = router.depositBoxOf(i);
        vm.prank(user);
        usdc.transfer(box, 1100);
        router.completeDeposit(i, _tx(pool, 11, 0, _leaves(21, 22), address(0), 1000, keeper, 0, hex"aa", ""));
        vm.warp(i.deadline + 1);
        router.reclaimDeposit(i, address(usdc));
        assertEq(usdc.balanceOf(refund), 100);
    }

    function test_eth_deposit_box_funded_before_deployment() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1 ether, _leaves(31, 0), "");
        address box = ethRouter.depositBoxOf(i);
        vm.prank(user);
        SafeTransferLib.safeTransferETH(box, 1 ether);
        vm.prank(keeper);
        ethRouter.completeDeposit(i, _tx(ethPool, 11, 0, _leaves(31, 0), address(0), 1 ether, keeper, 0.01 ether, "", ""));
        assertEq(address(ethPool).balance, 0.99 ether);
        assertEq(keeper.balance, 0.01 ether);
        assertEq(box.balance, 0);
    }

    function test_box_only_releases_to_its_router() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box = router.depositBoxOf(i);
        vm.prank(user);
        usdc.transfer(box, 1000);
        router.completeDeposit(i, _tx(pool, 11, 0, _leaves(21, 22), address(0), 1000, keeper, 0, hex"aa", ""));
        vm.expectRevert(TacitBox.NotRouter.selector);
        TacitBox(payable(box)).release(address(usdc), user, 0);
    }

    // ──────────────────── 4. wrap boxes (into V1) ────────────────────

    function test_wrap_box_wraps_into_v1_and_tips_the_keeper() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(usdcId, 5000, 50);
        address box = router.wrapBoxOf(w);
        vm.prank(user);
        usdc.transfer(box, 5050);
        vm.prank(keeper);
        router.completeWrap(w);
        assertEq(usdc.balanceOf(address(v1)), 5000);
        assertEq(usdc.balanceOf(keeper), 50);
        assertEq(usdc.balanceOf(box), 0);
    }

    function test_wrap_tip_bound_to_tipTo() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(usdcId, 5000, 50);
        w.tipTo = keeper;
        address box = router.wrapBoxOf(w);
        vm.prank(user);
        usdc.transfer(box, 5050);
        vm.prank(address(0xC0B1E5));
        router.completeWrap(w);
        assertEq(usdc.balanceOf(keeper), 50, "tip goes to tipTo, not the caller");
        assertEq(usdc.balanceOf(address(0xC0B1E5)), 0);
    }

    function test_eth_wrap_box_into_v1() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(TETH_LINK, 1 ether, 0);
        address box = router.wrapBoxOf(w);
        vm.prank(user);
        SafeTransferLib.safeTransferETH(box, 1 ether);
        router.completeWrap(w);
        assertEq(address(v1).balance, 1 ether);
    }

    function test_wrap_box_unknown_asset_reverts() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(bytes32(uint256(0xdead)), 1, 0);
        vm.expectRevert(TacitEvmPoolRouter.BadTarget.selector);
        router.completeWrap(w);
    }

    function test_reclaim_recovers_a_token_the_box_was_not_meant_for() public {
        TacitEvmPoolRouter.DepositIntent memory i = _depositIntent(1000, _leaves(21, 22), hex"aa");
        address box = router.depositBoxOf(i);
        vm.prank(user);
        SafeTransferLib.safeTransferETH(box, 0.5 ether);
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(bytes32(uint256(0xdead)), 1, 0);
        address wbox = router.wrapBoxOf(w);
        vm.prank(user);
        usdc.transfer(wbox, 77);
        vm.warp(i.deadline + 1);
        router.reclaimDeposit(i, address(0));
        router.reclaimWrap(w, address(usdc));
        assertEq(refund.balance, 0.5 ether, "ETH sent to a token-pool box");
        assertEq(usdc.balanceOf(refund), 77, "funds at a box for an unregistered V1 asset");
    }

    function test_wrap_box_reclaim() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(usdcId, 5000, 0);
        address box_ = router.wrapBoxOf(w);
        vm.prank(user);
        usdc.transfer(box_, 5000);
        vm.expectRevert(TacitEvmPoolRouter.NotExpired.selector);
        router.reclaimWrap(w, address(usdc));
        vm.warp(w.deadline + 1);
        router.reclaimWrap(w, address(usdc));
        assertEq(usdc.balanceOf(refund), 5000);
    }

    // ──────────────────── 5. pool → V1 in one transaction ────────────────────

    function test_withdrawToV1_one_transaction() public {
        vm.startPrank(user);
        usdc.approve(address(pool), type(uint256).max);
        _send(pool, _tx(pool, 11, 0, _leaves(1, 0), address(0), 3000, address(0), 0, "", ""), 0);
        vm.stopPrank();

        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(usdcId, 2980, 10);
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 22, 5, _noLeaves(), router.wrapBoxOf(w), -2990, keeper, 10, "", "");
        vm.prank(keeper);
        router.withdrawToV1(t, w);
        assertEq(usdc.balanceOf(address(v1)), 2980, "wrapped into V1");
        assertEq(usdc.balanceOf(keeper), 20, "pool relayer fee + wrap tip");
        assertEq(usdc.balanceOf(address(pool)), 0);
        assertTrue(pool.nullified(bytes32(uint256(5))));
    }

    function test_withdrawToV1_requires_the_intent_box_as_recipient() public {
        TacitEvmPoolRouter.WrapIntent memory w = _wrapIntent(usdcId, 100, 0);
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 22, 5, _noLeaves(), user, -100, keeper, 0, "", "");
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        router.withdrawToV1(t, w);
    }

    // ──────────────────── configuration ────────────────────

    function test_constructor_and_optional_pieces() public {
        vm.expectRevert(TacitEvmPoolRouter.BadTarget.selector);
        new TacitEvmPoolRouter(address(0), address(0), address(0), address(0));
        vm.expectRevert(TacitEvmPoolRouter.BadTarget.selector);
        new TacitEvmPoolRouter(address(pool), address(0xBEEF), address(0), address(0));
        TacitEvmPoolRouter bare = new TacitEvmPoolRouter(address(pool), address(0), address(0), address(0));
        assertEq(bare.ASSET(), address(usdc));
        TacitEvmPoolRouter.Tx memory t = _tx(pool, 11, 0, _leaves(1, 0), address(0), 1, address(0), 0, "", "");
        vm.expectRevert(TacitEvmPoolRouter.BadTarget.selector);
        bare.zapETHToDeposit{value: 1}(t, "");
        vm.expectRevert(TacitEvmPoolRouter.BadTarget.selector);
        bare.completeWrap(_wrapIntent(usdcId, 1, 0));
    }
}

/// A deposit box completed with a real proof: step 0 of the pool fixture is a deposit of 1000 with relayer 0
/// and fee 0, so it completes a box whose intent names its leaves and memos.
contract TacitEvmPoolRouterRealProofTest is Test {
    PoolToken token;
    TacitEvmPool pool;
    TacitEvmPoolRouter router;
    string json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/evm_pool_transact.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        token = new PoolToken();
        TransactVerifierDev verifier = new TransactVerifierDev();
        pool = new TacitEvmPool(address(verifier), address(token));
        assertEq(address(pool), vm.parseJsonAddress(json, ".pool"), "fixture pool address");
        router = new TacitEvmPoolRouter(address(pool), address(0), address(0), address(0));
    }

    function test_real_proof_completes_a_deposit_box() public {
        TacitEvmPoolRouter.Tx memory t;
        uint256[] memory a = vm.parseJsonUintArray(json, ".steps[0].pA");
        uint256[] memory b0 = vm.parseJsonUintArray(json, ".steps[0].pB[0]");
        uint256[] memory b1 = vm.parseJsonUintArray(json, ".steps[0].pB[1]");
        uint256[] memory c = vm.parseJsonUintArray(json, ".steps[0].pC");
        uint256[] memory p = vm.parseJsonUintArray(json, ".steps[0].publicInputs");
        t.pA = [a[0], a[1]];
        t.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        t.pC = [c[0], c[1]];
        for (uint256 j; j < 11; ++j) t.publicInputs[j] = p[j];
        t.extAmount = 1000;
        t.memo0 = vm.parseJsonBytes(json, ".steps[0].memo0");
        t.memo1 = vm.parseJsonBytes(json, ".steps[0].memo1");

        TacitEvmPoolRouter.DepositIntent memory i;
        i.amount = 1000;
        i.outLeaf0 = p[9];
        i.outLeaf1 = p[10];
        i.memo0Hash = keccak256(t.memo0);
        i.memo1Hash = keccak256(t.memo1);
        i.refund = address(0x5AFE);
        i.deadline = uint64(block.timestamp + 1 days);
        token.mint(router.depositBoxOf(i), 1000);

        vm.prank(address(0x4EE9E5));
        router.completeDeposit(i, t);
        assertEq(token.balanceOf(address(pool)), 1000);
        assertEq(pool.root(), bytes32(p[2]));
        assertEq(pool.nextIndex(), 2);
    }
}
