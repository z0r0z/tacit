// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {TacitEvmPool, ITransactVerifier} from "../src/TacitEvmPool.sol";
import {TransactVerifierDev} from "./TransactVerifierDev.sol";

contract PoolToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Pool Token";
    }

    function symbol() public pure override returns (string memory) {
        return "PTK";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract AcceptTransact is ITransactVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// Real proofs from tests/gen-evm-pool-fixture.mjs (DEV zkey), verified by the snarkjs-exported verifier: the
/// contract's asset field, extDataHash and publicAmount must agree with dapp/evm-pool-zk.js bit for bit.
contract TacitEvmPoolRealProofTest is Test {
    struct Step {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[11] pub;
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
    }

    PoolToken token;
    TransactVerifierDev verifier;
    TacitEvmPool pool;
    string json;
    address depositor;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/evm_pool_transact.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        assertEq(address(this), vm.parseJsonAddress(json, ".testContract"), "fixture assumes the default test contract");
        token = new PoolToken();
        verifier = new TransactVerifierDev();
        pool = new TacitEvmPool(address(verifier), address(token));
        assertEq(address(token), vm.parseJsonAddress(json, ".token"), "fixture token address");
        assertEq(address(pool), vm.parseJsonAddress(json, ".pool"), "fixture pool address");
        depositor = vm.parseJsonAddress(json, ".depositor");
        token.mint(depositor, 1000);
        vm.prank(depositor);
        token.approve(address(pool), type(uint256).max);
    }

    function _step(uint256 i) internal view returns (Step memory s) {
        string memory k = string.concat(".steps[", vm.toString(i), "]");
        uint256[] memory a = vm.parseJsonUintArray(json, string.concat(k, ".pA"));
        uint256[] memory b0 = vm.parseJsonUintArray(json, string.concat(k, ".pB[0]"));
        uint256[] memory b1 = vm.parseJsonUintArray(json, string.concat(k, ".pB[1]"));
        uint256[] memory c = vm.parseJsonUintArray(json, string.concat(k, ".pC"));
        uint256[] memory p = vm.parseJsonUintArray(json, string.concat(k, ".publicInputs"));
        s.pA = [a[0], a[1]];
        s.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        s.pC = [c[0], c[1]];
        for (uint256 j; j < 11; ++j) s.pub[j] = p[j];
        s.recipient = vm.parseJsonAddress(json, string.concat(k, ".recipient"));
        s.extAmount = vm.parseInt(vm.parseJsonString(json, string.concat(k, ".extAmount")));
        s.relayer = vm.parseJsonAddress(json, string.concat(k, ".relayer"));
        s.fee = vm.parseUint(vm.parseJsonString(json, string.concat(k, ".fee")));
        s.memo0 = vm.parseJsonBytes(json, string.concat(k, ".memo0"));
        s.memo1 = vm.parseJsonBytes(json, string.concat(k, ".memo1"));
    }

    function _send(Step memory s) internal {
        pool.transact(s.pA, s.pB, s.pC, s.pub, s.recipient, s.extAmount, s.relayer, s.fee, s.memo0, s.memo1);
    }

    function _deposit() internal {
        vm.prank(depositor);
        _send(_step(0));
    }

    function test_lifecycle_deposit_transfer_withdraw() public {
        Step memory d = _step(0);
        vm.prank(depositor);
        uint256 g = gasleft();
        _send(d);
        emit log_named_uint("deposit gas", g - gasleft());
        assertEq(token.balanceOf(address(pool)), 1000);
        assertEq(token.balanceOf(depositor), 0);
        assertEq(pool.root(), bytes32(d.pub[2]));
        assertEq(pool.nextIndex(), 2);
        assertTrue(pool.everKnownRoot(bytes32(d.pub[2])));

        Step memory t = _step(1);
        g = gasleft();
        _send(t);
        emit log_named_uint("transfer gas", g - gasleft());
        assertTrue(pool.nullified(bytes32(t.pub[7])));
        assertEq(token.balanceOf(t.relayer), 5);
        assertEq(token.balanceOf(address(pool)), 995);
        assertEq(pool.nextIndex(), 4);

        Step memory w = _step(2);
        g = gasleft();
        _send(w);
        emit log_named_uint("withdraw gas", g - gasleft());
        assertTrue(pool.nullified(bytes32(w.pub[7])));
        assertEq(token.balanceOf(w.recipient), 690);
        assertEq(token.balanceOf(w.relayer), 15);
        assertEq(token.balanceOf(address(pool)), 295);
        assertEq(pool.root(), bytes32(w.pub[1]), "a withdrawal without change inserts nothing");
        assertEq(pool.nextIndex(), 4);
    }

    function test_replay_is_stale() public {
        _deposit();
        Step memory t = _step(1);
        _send(t);
        vm.expectRevert(TacitEvmPool.StaleRoot.selector);
        _send(t);
    }

    function test_out_of_order_is_stale() public {
        vm.expectRevert(TacitEvmPool.StaleRoot.selector);
        _send(_step(1));
    }

    function test_redirected_recipient_rejected() public {
        _deposit();
        _send(_step(1));
        Step memory w = _step(2);
        w.recipient = address(0xBAD);
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        _send(w);
    }

    function test_raised_fee_rejected() public {
        _deposit();
        Step memory t = _step(1);
        t.fee = 6;
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        _send(t);
    }

    function test_redirected_relayer_rejected() public {
        _deposit();
        Step memory t = _step(1);
        t.relayer = address(0xBAD);
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        _send(t);
    }

    function test_swapped_memo_rejected() public {
        _deposit();
        Step memory t = _step(1);
        t.memo0 = hex"deadbeef";
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        _send(t);
    }

    function test_corrupted_proof_rejected() public {
        Step memory d = _step(0);
        d.pC[0] = d.pC[0] ^ 1;
        vm.prank(depositor);
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        _send(d);
    }

    function test_forged_public_input_rejected() public {
        _deposit();
        Step memory t = _step(1);
        t.pub[9] = t.pub[9] ^ 1;
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        _send(t);
    }

    function test_other_pool_rejects_the_proof() public {
        TacitEvmPool other = new TacitEvmPool(address(verifier), address(token));
        Step memory d = _step(0);
        vm.prank(depositor);
        token.approve(address(other), type(uint256).max);
        vm.prank(depositor);
        vm.expectRevert(TacitEvmPool.WrongAsset.selector);
        other.transact(d.pA, d.pB, d.pC, d.pub, d.recipient, d.extAmount, d.relayer, d.fee, d.memo0, d.memo1);
    }
}

/// Accounting and state-machine checks with a verifier that accepts everything, so each rule the contract enforces
/// itself (outside the proof) is exercised in isolation.
contract TacitEvmPoolRulesTest is Test {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 constant EMPTY_ROOT = bytes32(uint256(21443572485391568159800782191812935835534334817699172242223315142338162256601));

    TacitEvmPool ethPool;
    TacitEvmPool tokenPool;
    PoolToken token;
    address constant RECIPIENT = address(0xC0FFEE);
    address constant RELAYER = address(0xFEE);

    function setUp() public {
        address v = address(new AcceptTransact());
        token = new PoolToken();
        ethPool = new TacitEvmPool(v, address(0));
        tokenPool = new TacitEvmPool(v, address(token));
    }

    function _assetField(TacitEvmPool pool, address asset) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(pool), asset))) % P;
    }

    function _pa(int256 ext, uint256 fee) internal pure returns (uint256) {
        int256 x = (ext - int256(fee)) % int256(P);
        return uint256(x < 0 ? x + int256(P) : x);
    }

    struct Call {
        TacitEvmPool pool;
        address asset;
        bytes32 membershipRoot;
        uint256 newRoot;
        uint256 nf0;
        uint256 nf1;
        address recipient;
        int256 ext;
        uint256 fee;
        uint256 value;
        bool noInsert;
    }

    function _call(Call memory c) internal {
        _callExpect(c, bytes4(0));
    }

    function _callExpect(Call memory c, bytes4 err) internal {
        uint256[11] memory pub;
        pub[0] = uint256(c.membershipRoot);
        pub[1] = uint256(c.pool.root());
        pub[2] = c.newRoot;
        pub[3] = c.pool.nextIndex();
        pub[4] = _pa(c.ext, c.fee);
        pub[5] = uint256(keccak256(abi.encode(block.chainid, address(c.pool), c.recipient, c.ext, RELAYER, c.fee, keccak256(""), keccak256("")))) % P;
        pub[6] = _assetField(c.pool, c.asset);
        pub[7] = c.nf0;
        pub[8] = c.nf1;
        pub[9] = c.noInsert ? 0 : 1;
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        if (err != bytes4(0)) vm.expectRevert(err);
        c.pool.transact{value: c.value}(z2, z22, z2, pub, c.recipient, c.ext, RELAYER, c.fee, "", "");
    }

    function _eth(uint256 newRoot, uint256 nf0, uint256 nf1, int256 ext, uint256 fee, uint256 value) internal pure returns (Call memory c) {
        c.newRoot = newRoot;
        c.nf0 = nf0;
        c.nf1 = nf1;
        c.recipient = RECIPIENT;
        c.ext = ext;
        c.fee = fee;
        c.value = value;
    }

    function _onEth(Call memory c) internal view returns (Call memory) {
        c.pool = ethPool;
        c.asset = address(0);
        if (c.membershipRoot == bytes32(0)) c.membershipRoot = ethPool.root();
        return c;
    }

    function test_constructor_validation() public {
        vm.expectRevert(TacitEvmPool.ZeroAddress.selector);
        new TacitEvmPool(address(0), address(0));
        vm.expectRevert(TacitEvmPool.NotAContract.selector);
        new TacitEvmPool(address(0x1234), address(0));
        address v = address(new AcceptTransact());
        vm.expectRevert(TacitEvmPool.NotAContract.selector);
        new TacitEvmPool(v, address(0x1234));
        assertEq(ethPool.root(), EMPTY_ROOT);
        assertTrue(ethPool.everKnownRoot(EMPTY_ROOT));
        assertEq(ethPool.nextIndex(), 0);
    }

    function test_eth_deposit_and_withdraw_pay_recipient_and_relayer() public {
        _call(_onEth(_eth(111, 0, 0, 1 ether, 0, 1 ether)));
        assertEq(address(ethPool).balance, 1 ether);
        _call(_onEth(_eth(222, 7, 0, -0.9 ether, 0.01 ether, 0)));
        assertEq(RECIPIENT.balance, 0.9 ether);
        assertEq(RELAYER.balance, 0.01 ether);
        assertEq(address(ethPool).balance, 0.09 ether);
        assertEq(ethPool.nextIndex(), 4);
        assertEq(ethPool.root(), bytes32(uint256(222)));
    }

    function test_eth_value_must_match_deposit() public {
        Call memory c = _onEth(_eth(111, 0, 0, 1 ether, 0, 1 ether - 1));
        _callExpect(c, TacitEvmPool.EthValueMismatch.selector);
        c = _onEth(_eth(111, 5, 0, -1, 0, 1));
        _callExpect(c, TacitEvmPool.EthValueMismatch.selector);
    }

    function test_token_pool_refuses_eth() public {
        token.mint(address(this), 10);
        token.approve(address(tokenPool), 10);
        Call memory c = _eth(111, 0, 0, 10, 0, 1);
        c.pool = tokenPool;
        c.asset = address(token);
        c.membershipRoot = tokenPool.root();
        _callExpect(c, TacitEvmPool.EthNotAccepted.selector);
    }

    function test_nullifier_cannot_be_spent_twice() public {
        _call(_onEth(_eth(111, 0, 0, 1 ether, 0, 1 ether)));
        _call(_onEth(_eth(222, 42, 0, 0, 0, 0)));
        _callExpect(_onEth(_eth(333, 42, 0, 0, 0, 0)), TacitEvmPool.AlreadyNullified.selector);
        _callExpect(_onEth(_eth(333, 0, 42, 0, 0, 0)), TacitEvmPool.AlreadyNullified.selector);
    }

    function test_same_nullifier_in_both_slots_rejected() public {
        _callExpect(_onEth(_eth(111, 9, 9, 0, 0, 0)), TacitEvmPool.AlreadyNullified.selector);
    }

    function test_membership_root_may_be_historical_but_must_be_known() public {
        _call(_onEth(_eth(111, 0, 0, 1 ether, 0, 1 ether)));
        _call(_onEth(_eth(222, 0, 0, 1 ether, 0, 1 ether)));
        Call memory c = _onEth(_eth(333, 1, 0, 0, 0, 0));
        c.membershipRoot = bytes32(uint256(111));
        _call(c);
        c = _onEth(_eth(444, 2, 0, 0, 0, 0));
        c.membershipRoot = bytes32(uint256(999));
        _callExpect(c, TacitEvmPool.UnknownMembershipRoot.selector);
    }

    function test_insertion_index_must_be_the_pool_size() public {
        uint256[11] memory pub;
        pub[0] = uint256(ethPool.root());
        pub[1] = uint256(ethPool.root());
        pub[3] = 2;
        pub[6] = _assetField(ethPool, address(0));
        pub[9] = 1;
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        vm.expectRevert(TacitEvmPool.WrongInsertionIndex.selector);
        ethPool.transact(z2, z22, z2, pub, RECIPIENT, 0, RELAYER, 0, "", "");
    }

    function test_value_range_enforced() public {
        _callExpect(_onEth(_eth(111, 0, 0, int256(1 << 120), 0, 0)), TacitEvmPool.ValueOutOfRange.selector);
        _callExpect(_onEth(_eth(111, 5, 0, -int256(1 << 120), 0, 0)), TacitEvmPool.ValueOutOfRange.selector);
        _callExpect(_onEth(_eth(111, 5, 0, 0, 1 << 120, 0)), TacitEvmPool.ValueOutOfRange.selector);
    }

    function test_public_amount_must_match_ext_and_fee() public {
        uint256[11] memory pub;
        pub[0] = uint256(ethPool.root());
        pub[1] = uint256(ethPool.root());
        pub[4] = _pa(1 ether, 0) + 1;
        pub[5] = uint256(keccak256(abi.encode(block.chainid, address(ethPool), RECIPIENT, int256(1 ether), RELAYER, uint256(0), keccak256(""), keccak256("")))) % P;
        pub[6] = _assetField(ethPool, address(0));
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        vm.expectRevert(TacitEvmPool.BadProof.selector);
        ethPool.transact{value: 1 ether}(z2, z22, z2, pub, RECIPIENT, 1 ether, RELAYER, 0, "", "");
    }

    function test_call_without_outputs_inserts_nothing_and_never_goes_stale() public {
        _call(_onEth(_eth(111, 0, 0, 1 ether, 0, 1 ether)));
        Call memory c = _onEth(_eth(999, 5, 0, -0.5 ether, 0, 0));
        c.noInsert = true;
        uint256[11] memory pub;
        pub[0] = uint256(ethPool.root());
        pub[1] = 12345; // not the head: irrelevant when nothing is inserted
        pub[2] = 12345;
        pub[3] = 77;
        pub[4] = _pa(c.ext, 0);
        pub[5] = uint256(keccak256(abi.encode(block.chainid, address(ethPool), RECIPIENT, c.ext, RELAYER, uint256(0), keccak256(""), keccak256("")))) % P;
        pub[6] = _assetField(ethPool, address(0));
        pub[7] = 5;
        bytes32 rootBefore = ethPool.root();
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        ethPool.transact(z2, z22, z2, pub, RECIPIENT, c.ext, RELAYER, 0, "", "");
        assertEq(ethPool.root(), rootBefore);
        assertEq(ethPool.nextIndex(), 2);
        assertEq(RECIPIENT.balance, 0.5 ether);
        assertTrue(ethPool.nullified(bytes32(uint256(5))));
    }

    function test_fee_needs_a_relayer_and_a_withdrawal_needs_a_recipient() public {
        _call(_onEth(_eth(111, 0, 0, 1 ether, 0, 1 ether)));
        uint256[11] memory pub;
        pub[0] = uint256(ethPool.root());
        pub[1] = uint256(ethPool.root());
        pub[3] = ethPool.nextIndex();
        pub[6] = _assetField(ethPool, address(0));
        pub[9] = 1;
        uint256[2] memory z2;
        uint256[2][2] memory z22;
        vm.expectRevert(TacitEvmPool.ZeroAddress.selector);
        ethPool.transact(z2, z22, z2, pub, RECIPIENT, 0, address(0), 1, "", "");
        vm.expectRevert(TacitEvmPool.ZeroAddress.selector);
        ethPool.transact(z2, z22, z2, pub, address(0), -1, RELAYER, 0, "", "");
    }

    function test_fee_on_transfer_token_rejected() public {
        FeeToken ft = new FeeToken();
        TacitEvmPool p = new TacitEvmPool(address(new AcceptTransact()), address(ft));
        ft.mint(address(this), 100);
        ft.approve(address(p), 100);
        Call memory c = _eth(111, 0, 0, 100, 0, 0);
        c.pool = p;
        c.asset = address(ft);
        c.membershipRoot = p.root();
        _callExpect(c, TacitEvmPool.FeeOnTransferAsset.selector);
    }

    receive() external payable {}
}

contract FeeToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Fee";
    }

    function symbol() public pure override returns (string memory) {
        return "FEE";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - 1);
        _burn(from, 1);
        return true;
    }
}
