// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";
using PoolStateReader for ConfidentialPool;
import {assetOf, AssetView} from "./helpers/AssetView.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockERC20Decimals is ERC20 {
    uint8 internal immutable D;

    constructor(uint8 d) {
        D = d;
    }

    function name() public pure override returns (string memory) {
        return "Mock Decimals";
    }

    function symbol() public pure override returns (string memory) {
        return "MDEC";
    }

    function decimals() public view override returns (uint8) {
        return D;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// A fee-on-transfer token: delivers less than requested (1% skim). The pool must reject it at
// wrap/initPool (balance delta != amount) so escrow can never be over-credited.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        allowance[from][msg.sender] -= a;
        uint256 fee = a / 100; // skim 1%
        balanceOf[from] -= a;
        balanceOf[to] += a - fee;
        return true;
    }
}

// A token exposing MINTER() — stands in for a canonical pool-minted ERC20 (M-4 guard).
contract MockMinterToken {
    address public MINTER;

    constructor(address m) {
        MINTER = m;
    }
}

// A contract that rejects plain ETH (no receive/fallback) — to prove forceSafeTransferETH on the
// native-ETH unwrap path cannot be bricked by a hostile recipient in a batch settle.
contract EthRejector {}

/// A stand-in SP1 verifier: accepts unless toggled. The crypto is exercised by
/// the real-proof suite (next milestone); this suite pins the on-chain state
/// machine — escrow, the Keccak commitment tree, nullifiers, deposits, payouts —
/// independent of the proof system.
contract MockSP1Verifier is ISP1Verifier {
    bool public reverts;

    function setReverts(bool b) external {
        reverts = b;
    }

    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {
        require(!reverts, "mock: proof invalid");
    }
}

// A stand-in Bitcoin light relay for the reflection anchor: tip() = a settable canonical tip,
// blockParent for the ancestor walk. The attest tests anchor trivially (prev == tip == the seeded
// ANCHOR, which is also the relay tip), so the digest-chain mechanics are tested with the anchor ON.
contract MockRelay {
    bytes32 public tip;
    mapping(bytes32 => bytes32) public blockParent;

    constructor(bytes32 t) {
        tip = t;
    }

    function setTip(bytes32 t) external {
        tip = t;
    }

    function setParent(bytes32 child, bytes32 parent) external {
        blockParent[child] = parent;
    }
}

contract ConfidentialPoolTest is Test {
    ConfidentialPool pool;
    MockSP1Verifier verifier;
    MockERC20 token;
    bytes32 assetId;
    CanonicalAssetFactory factory;

    address constant USER = address(0xA11CE);
    address constant RECIP = address(0xB0B);
    address constant SETTLER = address(0x5E771E2);
    bytes32 constant VKEY = bytes32(uint256(0xABCD)); // placeholder program vkey
    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF)); // placeholder Bitcoin-relay vkey
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0)); // seeded reflection anchor == mock relay tip
    bytes32 constant REFLECTION_GENESIS_DIGEST = 0x7b058378c57dc5e8586e588ed5b010862924ec34dfce88495379135ae006ef41;
    MockRelay relay;

    function setUp() public {
        vm.chainId(1);
        verifier = new MockSP1Verifier();
        factory = new CanonicalAssetFactory();
        relay = new MockRelay(ANCHOR);
        pool = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        // The pool now anchors a reflection batch's tip to the relay tip walked back
        // REFLECTION_CONFIRMATIONS (the maturity guard), so seed a chain that buries ANCHOR exactly that
        // deep: walking the relay's parents back REFLECTION_CONFIRMATIONS hops reaches ANCHOR. The attest
        // tests then anchor a batch whose tip == ANCHOR (a matured, deep-enough tip).
        _seedMaturedRelay(ANCHOR);
        token = new MockERC20();
        assetId = pool.registerWrapped(address(token), 1, bytes32(0), "Conf Mock", "cMCK", 8);

        token.mint(USER, 1_000);
        vm.prank(USER);
        token.approve(address(pool), type(uint256).max);
    }

    // Exhaustiveness tripwire for the btcHomed value-exit enumeration in _settle: the cross-lane gate
    // there must name EVERY value-bearing PublicValues field by hand (no compile-time reflection). An
    // empty PublicValues abi-encodes to a fixed width (one head word per top-level field + one length
    // word per empty dynamic array), so adding OR removing any field changes this length and trips the
    // assert — forcing a maintainer to revisit the enumeration before the change can land.
    function test_PublicValues_btcHomedEnumeration_tripwire() public pure {
        ConfidentialPool.PublicValues memory pv;
        // 1472 bytes = 46 words: 1 leading offset (the struct is dynamic) + 27 top-level field heads + 18
        // empty-dynamic-array length tails. If this fails, a PublicValues field was added/removed: update the
        // btcHomed enumeration in ConfidentialPool._settle (both the bar list and the gate list) to match,
        // then update this expected width.
        assertEq(abi.encode(pv).length, 1472, "PublicValues width changed: revisit _settle btcHomed gate");
    }

    // ──────────────────── helpers ────────────────────

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.spendRoot = bytes32(0);
    }

    // Like _pv but bound to a specific pool deployment (for tests that spin up their own pool).
    function _pvFor(ConfidentialPool target) internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(target)));
        pv.spendRoot = bytes32(0);
    }

    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        bytes[] memory memos = new bytes[](pv.leaves.length);
        pool.settle(abi.encode(pv), "", memos);
    }

    // Seed `n` leaves via a settle so the no-inflation floor (#evm-spends ≤ #leaves) has headroom.
    // In production every spent note is a real prior leaf; mock spend tests must seed them first.
    function _seedLeaves(uint256 n) internal {
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            seed.leaves[i] = keccak256(abi.encodePacked("seed-leaf", i));
        }
        _settle(seed);
    }

    function _wrap(uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner) internal returns (bytes32 depositId) {
        vm.prank(USER);
        pool.wrap(assetId, amount, keccak256(abi.encodePacked(cx, cy, owner)));
        // the contract binds the deposit to the in-system value = amount/unitScale, over the
        // coord/owner digest keccak(Cx‖Cy‖owner) (the raw coords never reach the chain).
        uint256 value = amount / assetOf(pool, assetId).unitScale;
        depositId = keccak256(abi.encode(assetId, value, keccak256(abi.encodePacked(cx, cy, owner))));
    }

    function _arr(bytes32 a) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = a;
    }

    // Seed the mock relay with a chain that buries `reflTip` exactly REFLECTION_CONFIRMATIONS deep below
    // the relay tip, so the pool's maturity anchor (relay tip walked back that many hops) resolves to
    // `reflTip`. A batch whose committed tip == reflTip is then accepted as matured.
    function _seedMaturedRelay(bytes32 reflTip) internal {
        bytes32 t = reflTip;
        for (uint256 i; i < 6; ++i) {
            bytes32 child = keccak256(abi.encodePacked("matured-relay", reflTip, i));
            relay.setParent(child, t);
            t = child;
        }
        relay.setTip(t);
    }

    /// Attest Bitcoin state via the relay-proven path (the only path — no oracle). The
    /// MockSP1Verifier no-ops verifyProof, so this exercises the contract's decode + gates.
    function _attestBtc(bytes32 poolRoot, bytes32 spentRoot, uint64 height) internal returns (bytes32 burnRoot) {
        burnRoot = keccak256(abi.encodePacked(spentRoot, "burn"));
        bytes32 prior = pool.knownReflectionDigest(); // continue the current attested state
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, height));
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            poolRoot,
            spentRoot,
            burnRoot,
            height,
            next,
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // cBTC: the same attest path carrying a cbtcBackingSats (the reflection-attested Σ live cBTC.zk lock sats).
    function _attestBtcBacking(bytes32 poolRoot, bytes32 spentRoot, uint64 height, uint256 backing) internal {
        bytes32 burnRoot = keccak256(abi.encodePacked(spentRoot, "burn"));
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, height, backing));
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            poolRoot,
            spentRoot,
            burnRoot,
            height,
            next,
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            backing,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    function test_cbtcBackingSats_attested_and_advances() public {
        _seedMaturedRelay(ANCHOR);
        assertEq(pool.cbtcBackingSats(), 0, "genesis backing 0");
        _attestBtcBacking(keccak256("cb-pr1"), keccak256("cb-sr1"), 1, 50_000);
        assertEq(pool.cbtcBackingSats(), 50_000, "backing attested (the off-pool buffer reads this)");
        // a later attestation advances it — e.g. a self-custody rug spent a lock, dropping the backing
        _attestBtcBacking(keccak256("cb-pr2"), keccak256("cb-sr2"), 2, 30_000);
        assertEq(pool.cbtcBackingSats(), 30_000, "backing advances with the reflected state");
    }

    // ──────────────────── wrap ────────────────────

    function test_register_and_wrap() public {
        assertEq(pool.escrow(assetId), 0);
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        assertEq(pool.escrow(assetId), 100, "escrow");
        assertEq(token.balanceOf(address(pool)), 100, "held");
        assertEq(pool.depositStatus(id), 1, "pending");

        AssetView memory a = assetOf(pool, assetId);
        assertEq(a.decimals, 8); // name/symbol now ride the AssetRegistered event, not assets()
    }

    function test_wrap_duplicate_reverts() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.DepositExists.selector);
        pool.wrap(
            assetId, 100, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
    }

    function test_wrap_unaligned_reverts() public {
        bytes32 a2 = pool.registerWrapped(address(new MockERC20Decimals(18)), 1e10, bytes32(0), "X", "X", 18);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.AmountNotAligned.selector);
        pool.wrap(a2, 5, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))));
    }

    function test_wrap_value_over_u64_reverts() public {
        // unitScale == 1 for the setup asset, so value == amount. A value > u64 max would
        // bind a deposit id the guest (u64 value) can't reproduce → unconsumable escrow.
        uint256 huge = uint256(type(uint64).max) + 1;
        token.mint(USER, huge);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.wrap(
            assetId, huge, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
    }

    function test_register_duplicate_reverts() public {
        vm.expectRevert(ConfidentialPool.AlreadyRegistered.selector);
        pool.registerWrapped(address(token), 1, bytes32(0), "Conf Mock", "cMCK", 8);
    }

    // Escrow registration of a not-yet-deployed address is rejected: a canonical token's
    // address is deterministic, so it must not be claimable as escrow before it exists.
    function test_register_wrapped_rejects_non_contract() public {
        vm.expectRevert(ConfidentialPool.NotAContract.selector);
        pool.registerWrapped(address(0xBEEF), 1, bytes32(0), "X", "X", 18);
    }

    // Escrow registration of a canonical token of this pool (MINTER() == pool) is rejected
    // — canonical assets register only via the guest-proven minted path.
    function test_register_wrapped_rejects_canonical_token() public {
        MockMinterToken canon = new MockMinterToken(address(pool));
        vm.expectRevert(ConfidentialPool.CanonicalAsset.selector);
        pool.registerWrapped(address(canon), 1, bytes32(0), "X", "X", 18);
    }

    function test_register_wrapped_auto_derives_scale_and_rejects_link() public {
        MockERC20Decimals usdcLike = new MockERC20Decimals(6);
        bytes32 usdcAsset = pool.registerWrappedAuto(address(usdcLike), bytes32(0));
        AssetView memory usdc = assetOf(pool, usdcAsset);
        assertTrue(usdc.registered, "registered");
        assertEq(usdc.underlying, address(usdcLike), "underlying");
        assertEq(usdc.unitScale, 1, "6-dec asset keeps native precision");
        assertEq(usdc.decimals, 6, "metadata decimals recorded");

        MockERC20Decimals wethLike = new MockERC20Decimals(18);
        bytes32 wethAsset = pool.registerWrappedAuto(address(wethLike), bytes32(0));
        AssetView memory weth = assetOf(pool, wethAsset);
        assertEq(weth.unitScale, 10 ** 10, "18-dec asset harmonizes to 8 Tacit decimals");

        MockERC20Decimals griefedWeth = new MockERC20Decimals(18);
        vm.expectRevert(ConfidentialPool.BadDecimals.selector);
        pool.registerWrapped(address(griefedWeth), 1, bytes32(0), "Bad WETH", "bWETH", 18);

        MockERC20Decimals linkedEscrow = new MockERC20Decimals(18);
        vm.expectRevert(ConfidentialPool.CrossChainEscrow.selector);
        pool.registerWrappedAuto(address(linkedEscrow), keccak256("escrow-cannot-claim-shared-id"));
    }

    // ──────────────────── native ETH (address(0)) ────────────────────

    function test_register_native_eth() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "Confidential ETH", "cETH", 18);
        AssetView memory a = assetOf(pool, ethId);
        assertTrue(a.registered && !a.poolMinted, "ETH is a registered escrow asset");
        assertEq(a.underlying, address(0), "native ETH sentinel");
        assertEq(a.unitScale, 1e10, "8-dec in-system granularity (10 gwei)");
    }

    function test_wrap_native_eth_escrows_msg_value() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        uint256 amt = 5e10; // 5 in-system units
        vm.deal(USER, amt);
        vm.prank(USER);
        pool.wrap{value: amt}(
            ethId, amt, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
        assertEq(pool.escrow(ethId), amt, "ETH escrowed");
        assertEq(address(pool).balance, amt, "pool holds the wei");
    }

    function test_wrap_native_eth_value_mismatch_reverts() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        vm.deal(USER, 1e10);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.EthValueMismatch.selector);
        pool.wrap{value: 1e10 - 1}(
            ethId, 1e10, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
    }

    function test_unwrap_native_eth_pays_recipient() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        vm.deal(USER, 7e10);
        vm.prank(USER);
        pool.wrap{value: 7e10}(
            ethId, 7e10, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(ethId, RECIP, 7); // value 7 → 7·1e10 wei
        uint256 before = RECIP.balance;
        _settle(pv);
        assertEq(RECIP.balance - before, 7e10, "recipient received ETH");
        assertEq(pool.escrow(ethId), 0, "escrow drained");
    }

    function test_unwrap_native_eth_to_non_payable_not_bricked() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        vm.deal(USER, 1e10);
        vm.prank(USER);
        pool.wrap{value: 1e10}(
            ethId, 1e10, keccak256(abi.encodePacked(bytes32(uint256(9)), bytes32(uint256(8)), bytes32(uint256(7))))
        );
        address rejector = address(new EthRejector());
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(ethId, rejector, 1);
        _settle(pv); // must NOT revert — forceSafeTransferETH delivers despite no receiver
        assertEq(rejector.balance, 1e10, "force-sent ETH to a non-payable recipient");
    }

    function test_stray_eth_rejected() public {
        vm.deal(USER, 1 ether);
        vm.prank(USER);
        (bool ok,) = address(pool).call{value: 1 ether}("");
        assertFalse(ok, "bare ETH send is rejected (only wrap accepts ETH; createPair takes no funds)");
    }

    // ──────────────────── settle: deposit consumption ────────────────────

    function test_settle_consumes_deposit_and_inserts_leaf() public {
        bytes32 emptyRoot = pool.currentRoot();
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = _arr(keccak256("leaf-A"));
        pv.depositsConsumed = _arr(id);
        _settle(pv);

        assertEq(pool.depositStatus(id), 2, "consumed");
        assertEq(pool.nextLeafIndex(), 1, "one leaf");
        assertTrue(pool.currentRoot() != emptyRoot, "root advanced");
        assertTrue(pool.everKnownRoot(pool.currentRoot()), "root known");
    }

    function test_settle_unknown_deposit_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = _arr(keccak256("leaf-A"));
        pv.depositsConsumed = _arr(keccak256("nope"));
        vm.expectRevert(ConfidentialPool.DepositNotPending.selector);
        _settle(pv);
    }

    // ──────────────────── settle: transfer (nullifiers + membership root) ────────────────────

    function test_settle_transfer_spends_nullifier() public {
        // seed a leaf so a non-empty known root exists
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = _arr(keccak256("leaf-A"));
        seed.depositsConsumed = _arr(id);
        _settle(seed);
        bytes32 root = pool.currentRoot();

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = root;
        pv.nullifiers = _arr(keccak256("null-1"));
        pv.leaves = _arr(keccak256("out-1"));
        _settle(pv);

        assertTrue(pool.nullifierSpent(keccak256("null-1")), "nullifier marked");
        assertEq(pool.nextLeafIndex(), 2, "two leaves");
    }

    function test_settle_nullifier_reuse_reverts() public {
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = _arr(keccak256("leaf-A"));
        seed.depositsConsumed = _arr(id);
        _settle(seed);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = pool.currentRoot();
        pv.nullifiers = _arr(keccak256("null-1"));
        pv.leaves = _arr(keccak256("out-1"));
        _settle(pv);

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.spendRoot = pool.currentRoot();
        pv2.nullifiers = _arr(keccak256("null-1"));
        pv2.leaves = _arr(keccak256("out-2"));
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        _settle(pv2);
    }

    function test_settle_unknown_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = bytes32(uint256(0xdead));
        pv.nullifiers = _arr(keccak256("null-1"));
        vm.expectRevert(ConfidentialPool.UnknownRoot.selector);
        _settle(pv);
    }

    // ──────────────────── settle: withdraw + fee ────────────────────

    function test_settle_withdraw_pays_recipient() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 30);
        _settle(pv);
        assertEq(token.balanceOf(RECIP), 30, "recipient paid");
        assertEq(pool.escrow(assetId), 70, "escrow reduced");
    }

    function test_settle_fee_pays_settler() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment(assetId, 5);
        vm.prank(SETTLER);
        _settle(pv);
        assertEq(token.balanceOf(SETTLER), 5, "settler paid fee");
        assertEq(pool.escrow(assetId), 95, "escrow reduced by fee");
    }

    function test_settle_withdraw_over_escrow_reverts() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 101);
        vm.expectRevert(ConfidentialPool.InsufficientEscrow.selector);
        _settle(pv);
    }

    /// Boundary effects speak the in-system note value `v`; the contract scales by the
    /// asset's trusted unitScale. With unitScale != 1 (the dust-on-Eth case): a wrap of
    /// `amount` binds the deposit to v = amount/unitScale (NOT the underlying amount), and
    /// an unwrap of `v` releases exactly v·unitScale — the guest, blind to unitScale,
    /// can never inflate the payout. (All other tests use unitScale = 1, where v == amount
    /// and the scaling is invisible.)
    function test_value_scaling_wrap_and_unwrap() public {
        uint256 scale = 1e10;
        MockERC20Decimals t8 = new MockERC20Decimals(18);
        bytes32 a8 = pool.registerWrapped(address(t8), scale, bytes32(0), "Conf8", "c8", 18);
        t8.mint(USER, 3 * scale);
        vm.prank(USER);
        t8.approve(address(pool), type(uint256).max);

        bytes32 cx = bytes32(uint256(0x8c1));
        bytes32 cy = bytes32(uint256(0x8c2));
        bytes32 owner = bytes32(uint256(0x8c3));

        // wrap amount = 3·scale → in-system value 3; deposit is bound to the value.
        vm.prank(USER);
        pool.wrap(a8, 3 * scale, keccak256(abi.encodePacked(cx, cy, owner)));
        bytes32 commit = keccak256(abi.encodePacked(cx, cy, owner));
        bytes32 id = keccak256(abi.encode(a8, uint256(3), commit));
        assertEq(pool.depositStatus(id), 1, "deposit bound to value, not amount");
        // the amount-bound id (the pre-harmonization layout) must NOT exist.
        assertEq(pool.depositStatus(keccak256(abi.encode(a8, 3 * scale, commit))), 0, "not bound to amount");
        assertEq(pool.escrow(a8), 3 * scale, "escrow holds the underlying");

        // settle: consume the deposit (insert its leaf) and unwrap value 2 to RECIP.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = _arr(keccak256("leaf8"));
        pv.depositsConsumed = _arr(id);
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(a8, RECIP, 2);
        _settle(pv);

        assertEq(t8.balanceOf(RECIP), 2 * scale, "payout scaled value*unitScale");
        assertEq(pool.escrow(a8), 1 * scale, "escrow reduced by value*unitScale");
        assertEq(pool.depositStatus(id), 2, "deposit consumed");
    }

    // ──────────────────── settle: domain / proof gating ────────────────────

    function test_settle_bad_version_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.version = 2;
        vm.expectRevert(ConfidentialPool.BadVersion.selector);
        _settle(pv);
    }

    function test_settle_chain_mismatch_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.chainBinding = keccak256("wrong");
        vm.expectRevert(ConfidentialPool.ChainMismatch.selector);
        _settle(pv);
    }

    function test_settle_proof_rejected_reverts() public {
        verifier.setReverts(true);
        ConfidentialPool.PublicValues memory pv = _pv();
        vm.expectRevert(bytes("mock: proof invalid"));
        _settle(pv);
    }

    // ──────────────────── batched rollup path ────────────────────

    /// One proof carrying a mixed batch — 2 deposits consumed, a transfer
    /// (1 nullifier + 2 outputs), an unwrap (1 nullifier + 1 withdrawal), and a
    /// fee — exercises the Phase-2 shape: every effect applied in a single settle,
    /// escrow conserved as deposits − withdrawal − fee.
    function test_batched_multi_op_settle() public {
        bytes32 id1 = _wrap(100, bytes32(uint256(11)), bytes32(uint256(12)), bytes32(uint256(13)));
        bytes32 id2 = _wrap(50, bytes32(uint256(21)), bytes32(uint256(22)), bytes32(uint256(23)));
        assertEq(pool.escrow(assetId), 150);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = id1;
        pv.depositsConsumed[1] = id2;
        pv.leaves = new bytes32[](4); // 2 deposit leaves + 2 transfer outputs
        pv.leaves[0] = keccak256("dep1");
        pv.leaves[1] = keccak256("dep2");
        pv.leaves[2] = keccak256("out0");
        pv.leaves[3] = keccak256("out1");
        pv.nullifiers = new bytes32[](2); // transfer input + unwrap
        pv.nullifiers[0] = keccak256("nT");
        pv.nullifiers[1] = keccak256("nU");
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 30);
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment(assetId, 5);

        vm.prank(SETTLER);
        _settle(pv);

        assertEq(pool.depositStatus(id1), 2, "dep1 consumed");
        assertEq(pool.depositStatus(id2), 2, "dep2 consumed");
        assertEq(pool.nextLeafIndex(), 4, "4 leaves inserted");
        assertTrue(pool.nullifierSpent(keccak256("nT")), "transfer nullifier");
        assertTrue(pool.nullifierSpent(keccak256("nU")), "unwrap nullifier");
        assertEq(token.balanceOf(RECIP), 30, "unwrap paid");
        assertEq(token.balanceOf(SETTLER), 5, "settler fee paid");
        assertEq(pool.escrow(assetId), 115, "escrow = 150 - 30 - 5");
        assertTrue(pool.everKnownRoot(pool.currentRoot()), "root known");
    }

    /// A batch touching two assets keeps escrow per-asset independent.
    function test_multi_asset_independent_escrow() public {
        MockERC20 tokenB = new MockERC20();
        bytes32 assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 8);
        tokenB.mint(USER, 1_000);
        vm.prank(USER);
        tokenB.approve(address(pool), type(uint256).max);

        bytes32 idA = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.prank(USER);
        pool.wrap(
            assetB, 200, keccak256(abi.encodePacked(bytes32(uint256(4)), bytes32(uint256(5)), bytes32(uint256(6))))
        );
        bytes32 idB = keccak256(
            abi.encode(
                assetB,
                uint256(200),
                keccak256(abi.encodePacked(bytes32(uint256(4)), bytes32(uint256(5)), bytes32(uint256(6))))
            )
        );

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = idA;
        pv.depositsConsumed[1] = idB;
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("lA");
        pv.leaves[1] = keccak256("lB");
        pv.withdrawals = new ConfidentialPool.Withdrawal[](2);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 40);
        pv.withdrawals[1] = ConfidentialPool.Withdrawal(assetB, RECIP, 70);
        _settle(pv);

        assertEq(pool.escrow(assetId), 60, "asset A escrow");
        assertEq(pool.escrow(assetB), 130, "asset B escrow");
        assertEq(token.balanceOf(RECIP), 40, "A paid");
        assertEq(tokenB.balanceOf(RECIP), 70, "B paid");
    }

    // ──────────────────── recovery data availability (memos) ────────────────────

    event LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos);
    event NullifiersSpent(bytes32[] nullifiers);

    /// settle emits the leaves+memos+nullifiers an indexer needs to reconstruct a
    /// wallet's notes from chain alone — firstLeafIndex anchors them to tree slots.
    function test_settle_emits_recovery_data() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("L0");
        pv.leaves[1] = keccak256("L1");
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = keccak256("nu");

        bytes[] memory memos = new bytes[](2);
        memos[0] = hex"deadbeef";
        memos[1] = hex"cafe";

        vm.expectEmit(true, false, false, true, address(pool));
        emit NullifiersSpent(pv.nullifiers);
        vm.expectEmit(true, false, false, true, address(pool));
        emit LeavesInserted(0, pv.leaves, memos);
        pool.settle(abi.encode(pv), "", memos);

        assertEq(pool.nextLeafIndex(), 2, "two leaves landed");
    }

    /// A second settle's leaves are anchored at the running nextLeafIndex.
    function test_settle_recovery_index_advances() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("a");
        pv.leaves[1] = keccak256("b");
        pool.settle(abi.encode(pv), "", new bytes[](2));

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.leaves = new bytes32[](1);
        pv2.leaves[0] = keccak256("c");
        bytes[] memory memos2 = new bytes[](1);
        memos2[0] = hex"01";
        vm.expectEmit(true, false, false, true, address(pool));
        emit LeavesInserted(2, pv2.leaves, memos2);
        pool.settle(abi.encode(pv2), "", memos2);
    }

    function test_settle_memo_count_mismatch_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("x");
        pv.leaves[1] = keccak256("y");
        vm.expectRevert(ConfidentialPool.MemoLeafMismatch.selector);
        pool.settle(abi.encode(pv), "", new bytes[](1)); // one memo, two leaves
    }

    // ──────────────────── cross-chain (Phase 3 in gen-1) ────────────────────

    event CrossOutRecorded(
        bytes32 indexed claimId, uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 assetId
    );

    function _claimId(uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 asset)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(destChain, destCommitment, nullifier, asset));
    }

    /// A Bitcoin burn mints an Ethereum note (leaf) gated one-mint-per-burn on the burned
    /// note's nullifier, and marks bridgeMinted — the tETH acceptedBitcoinBurns pattern.
    function test_bridge_mint_marks_claim_and_inserts_leaf() public {
        bytes32 root = keccak256("bm-pool-1");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-spent-1"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 burnNullifier = keccak256("btc-burn-1");
        pv.nullifiers = _arr(burnNullifier);
        pv.bitcoinBurnsConsumed = _arr(burnNullifier);
        pv.bitcoinRootsUsed = _arr(root);
        pv.bitcoinBurnRoot = burnRoot;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("minted-note");

        pool.settle(abi.encode(pv), "", new bytes[](1));

        assertTrue(pool.bridgeMinted(burnNullifier), "burn marked minted");
        assertEq(pool.nextLeafIndex(), 1, "minted leaf inserted");
    }

    function test_bridge_mint_excludes_burn_nullifier_not_first_in_consumed_list() public {
        bytes32 root = keccak256("bm-pool-second");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-spent-second"), 1);
        bytes32 burnA = keccak256("btc-burn-a");
        bytes32 burnB = keccak256("btc-burn-b");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinBurnsConsumed = new bytes32[](2);
        pv.bitcoinBurnsConsumed[0] = burnA;
        pv.bitcoinBurnsConsumed[1] = burnB;
        pv.bitcoinBurnRoot = burnRoot;
        pv.bitcoinRootsUsed = new bytes32[](2);
        pv.bitcoinRootsUsed[0] = root;
        pv.bitcoinRootsUsed[1] = root;
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = burnB;
        pv.nullifiers[1] = burnA;

        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertTrue(pool.bridgeMinted(burnA), "first burn marked");
        assertTrue(pool.bridgeMinted(burnB), "second burn marked");
        assertTrue(pool.nullifierSpent(burnB), "burn nullifier spent");
        assertTrue(pool.nullifierSpent(burnA), "other burn nullifier spent");
    }

    /// The same Bitcoin burn cannot be minted twice (one note, not two).
    function test_bridge_mint_double_claim_reverts() public {
        bytes32 root = keccak256("bm-pool-2");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-spent-2"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 burnNullifier = keccak256("btc-burn-2");
        pv.nullifiers = _arr(burnNullifier);
        pv.bitcoinBurnsConsumed = _arr(burnNullifier);
        pv.bitcoinRootsUsed = _arr(root);
        pv.bitcoinBurnRoot = burnRoot;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("note");
        pool.settle(abi.encode(pv), "", new bytes[](1));

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.nullifiers = _arr(burnNullifier);
        pv2.bitcoinBurnsConsumed = _arr(burnNullifier); // replay
        pv2.bitcoinRootsUsed = _arr(root);
        pv2.bitcoinBurnRoot = burnRoot;
        pv2.leaves = new bytes32[](1);
        pv2.leaves[0] = keccak256("note2");
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        pool.settle(abi.encode(pv2), "", new bytes[](1));
    }

    /// An intra-batch duplicate Bitcoin-burn claim is rejected too.
    function test_bridge_mint_intrabatch_duplicate_reverts() public {
        bytes32 root = keccak256("bm-pool-3");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-spent-3"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 burnNullifier = keccak256("btc-burn-3");
        pv.bitcoinBurnsConsumed = new bytes32[](2);
        pv.bitcoinBurnsConsumed[0] = burnNullifier;
        pv.bitcoinBurnsConsumed[1] = burnNullifier;
        pv.nullifiers = _arr(burnNullifier);
        pv.bitcoinRootsUsed = new bytes32[](2);
        pv.bitcoinRootsUsed[0] = root;
        pv.bitcoinRootsUsed[1] = root;
        pv.bitcoinBurnRoot = burnRoot;
        vm.expectRevert(ConfidentialPool.BurnAlreadyMinted.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    function test_bridge_mint_requires_burn_nullifier_in_global_nullifiers() public {
        bytes32 root = keccak256("bm-pool-nu-required");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-spent-nu-required"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 burnNullifier = keccak256("btc-burn-nu-required");
        pv.bitcoinBurnsConsumed = _arr(burnNullifier);
        pv.bitcoinRootsUsed = _arr(root);
        pv.bitcoinBurnRoot = burnRoot;
        vm.expectRevert(ConfidentialPool.BridgeBurnNotNullified.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    function test_bridge_mint_requires_root_for_each_burn() public {
        bytes32 root = keccak256("bm-pool-root-required");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-spent-root-required"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 burnNullifier = keccak256("btc-burn-root-required");
        pv.nullifiers = _arr(burnNullifier);
        pv.bitcoinBurnsConsumed = _arr(burnNullifier);
        pv.bitcoinBurnRoot = burnRoot;
        vm.expectRevert(ConfidentialPool.BridgeMintRootMismatch.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// H-1 guard: a bridge_mint MUST pin a burn root. A mint that omits it (burnRoot == 0)
    /// is rejected — otherwise a note spent on Bitcoin for ANY reason (an ordinary transfer,
    /// not a bridge burn) could be minted on Ethereum, duplicating value across chains. This
    /// is the contract backstop to the guest's bridge-burn-set membership.
    function test_bridge_mint_without_burn_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = keccak256("btc-burn-no-root");
        // pv.bitcoinBurnRoot left 0 — no burn authority pinned.
        vm.expectRevert(ConfidentialPool.StaleBitcoinBurnRoot.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// H-1 guard: a bridge_mint against a STALE burn root (not the current reflected one) is
    /// rejected — a mint must prove burn membership against the freshest Bitcoin burn set, so
    /// it can't replay an old root that omits a since-reflected burn or predates it.
    function test_bridge_mint_stale_burn_root_reverts() public {
        _attestBtc(keccak256("bm-pool-stale"), keccak256("bm-spent-stale"), 1); // sets knownBitcoinBurnRoot
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = keccak256("btc-burn-stale");
        pv.bitcoinBurnRoot = keccak256("a-different-old-burn-root"); // != knownBitcoinBurnRoot
        vm.expectRevert(ConfidentialPool.StaleBitcoinBurnRoot.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// An Ethereum note burned for Bitcoin: the note is nullified and a
    /// non-malleable CrossOut record is emitted for Bitcoin validators to honor.
    function test_cross_out_emits_record_and_spends_note() public {
        _seedLeaves(1); // the burned note is a prior leaf
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nu = keccak256("eth-note-nu");
        bytes32 destC = keccak256("btc-dest-commitment");
        uint16 destChain = 1; // bitcoin
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);

        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        vm.expectEmit(true, false, false, true, address(pool));
        emit CrossOutRecorded(claimId, destChain, destC, nu, assetId);
        pool.settle(abi.encode(pv), "", new bytes[](0));

        assertTrue(pool.nullifierSpent(nu), "burned note nullified");
        // Storage anchor for the reverse-reflection (Mode B) inclusion proof: the cross-out is
        // persisted in the state trie (claimId => destCommitment), not just the event.
        assertEq(vm.load(address(pool), keccak256(abi.encode(claimId, uint256(76)))), destC, "cross-out anchored in storage");
    }

    function test_cross_out_accepts_nullifier_not_first_in_batch() public {
        _seedLeaves(2);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 otherNu = keccak256("eth-note-other-nu");
        bytes32 nu = keccak256("eth-note-second-nu");
        bytes32 destC = keccak256("btc-dest-second");
        uint16 destChain = 1;
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);

        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = otherNu;
        pv.nullifiers[1] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertTrue(pool.nullifierSpent(otherNu), "first note nullified");
        assertTrue(pool.nullifierSpent(nu), "cross-out note nullified");
        assertEq(vm.load(address(pool), keccak256(abi.encode(claimId, uint256(76)))), destC, "cross-out anchored");
    }

    /// Mode-B invariant: the eth-reflection guest proves `crossOutCommitment[claimId]` via an
    /// eth_getProof storage-slot proof at `keccak256(abi.encode(claimId, SLOT))` with SLOT=76 (the
    /// guest's CROSSOUT_SLOT_INDEX). Lock SLOT + the mapping-slot derivation against the real layout so
    /// the guest reads the right slot — a mismatch would only surface after a full prover build+execute.
    function test_crossout_storage_slot_layout() public {
        _seedLeaves(1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nu = keccak256("slot-nu");
        bytes32 destC = keccak256("slot-destC");
        bytes32 claimId = _claimId(1, destC, nu, assetId);
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(1, destC, nu, assetId, claimId);
        pool.settle(abi.encode(pv), "", new bytes[](0));

        bytes32 slot = keccak256(abi.encode(claimId, uint256(76))); // guest's CROSSOUT_SLOT_INDEX
        assertEq(vm.load(address(pool), slot), destC, "crossOutCommitment[claimId] is at keccak(claimId,76)");
    }

    /// A crossOut whose claimId doesn't bind its own fields is rejected — the
    /// on-chain re-derivation blocks a malleable instruction to Bitcoin.
    function test_cross_out_claim_mismatch_reverts() public {
        _seedLeaves(1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nu = keccak256("nu2");
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(1, keccak256("dest"), nu, assetId, keccak256("wrong-claim"));
        vm.expectRevert(ConfidentialPool.CrossOutClaimMismatch.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// A crossOut whose nullifier is NOT spent in the same batch is rejected: the burn must consume
    /// its Ethereum source note (ν in pv.nullifiers), else it would mint a Bitcoin note for free.
    function test_cross_out_nullifier_not_spent_reverts() public {
        _seedLeaves(1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nu = keccak256("unspent-nu");
        bytes32 destC = keccak256("dest-c");
        bytes32 claimId = _claimId(1, destC, nu, assetId);
        // No pv.nullifiers — the crossOut references nu but the batch never spends it.
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(1, destC, nu, assetId, claimId);
        vm.expectRevert(ConfidentialPool.CrossOutNullifierNotSpent.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// A bridge_burn whose spent input is BITCOIN-homed (membership proven against a
    /// knownBitcoinRoot) is rejected: the crossOut would mint a fresh equal-value note on
    /// Bitcoin while the original Bitcoin UTXO stays live + spendable there (the reflection
    /// prover never reflects an Ethereum nullification back to Bitcoin) — value duplication.
    /// A bridge_burn must originate from an Ethereum-homed note.
    function test_bridge_burn_btc_homed_input_reverts() public {
        bytes32 poolRoot = keccak256("btc-pool-for-burn");
        bytes32 spentRoot = keccak256("btc-spent-for-burn");
        _attestBtc(poolRoot, spentRoot, 1); // poolRoot becomes a knownBitcoinRoot

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = poolRoot; // Bitcoin-homed spend
        pv.bitcoinSpentRoot = spentRoot; // pin the current reflected spent root
        bytes32 nu = keccak256("btc-homed-burn-nu");
        bytes32 destC = keccak256("btc-dest-from-btc-homed");
        uint16 destChain = 1;
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        vm.expectRevert(ConfidentialPool.BridgeBurnNotEthHomed.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// Control: the SAME crossOut from an ETHEREUM-homed note (spendRoot = an everKnownRoot)
    /// settles fine — the guard only bars the Bitcoin-homed lane.
    function test_bridge_burn_eth_homed_input_ok() public {
        // Seed an Ethereum root via a prior leaf insertion, then spend against it.
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = new bytes32[](1);
        seed.leaves[0] = keccak256("eth-note-leaf");
        _settle(seed);
        bytes32 ethRoot = pool.currentRoot();
        assertTrue(pool.everKnownRoot(ethRoot), "eth root known");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = ethRoot; // Ethereum-homed spend
        bytes32 nu = keccak256("eth-homed-burn-nu");
        bytes32 destC = keccak256("btc-dest-from-eth-homed");
        uint16 destChain = 1;
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertTrue(pool.nullifierSpent(nu), "eth-homed burn note nullified");
    }

    /// Atomic cross-chain swap: one settle carries both legs — Bob's X output
    /// lands as an Ethereum leaf, Alice's Y output is recorded as a Bitcoin
    /// crossOut, both input notes are nullified — all applied in one call.
    function test_atomic_cross_chain_swap() public {
        _seedLeaves(2); // both input notes are prior leaves
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nuAliceX = keccak256("alice-X-in");
        bytes32 nuBobY = keccak256("bob-Y-in");
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = nuAliceX;
        pv.nullifiers[1] = nuBobY;

        // ETH leg: Bob's new X note as a leaf.
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("bob-X-out");

        // BTC leg: Alice's new Y note as a crossOut.
        bytes32 assetY = keccak256("asset-Y");
        bytes32 destC = keccak256("alice-Y-on-bitcoin");
        bytes32 cid = _claimId(1, destC, nuBobY, assetY);
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(1, destC, nuBobY, assetY, cid);

        uint256 preLeaves = pool.nextLeafIndex();
        vm.expectEmit(true, false, false, true, address(pool));
        emit CrossOutRecorded(cid, 1, destC, nuBobY, assetY);
        pool.settle(abi.encode(pv), "", new bytes[](1));

        assertTrue(pool.nullifierSpent(nuAliceX), "Alice's X input spent");
        assertTrue(pool.nullifierSpent(nuBobY), "Bob's Y input spent");
        assertEq(pool.nextLeafIndex(), preLeaves + 1, "Bob's X minted on Ethereum (one new leaf)");
    }

    // ──────────────────── bridge_mint: Bitcoin pool-root attestation ────────────────────

    /// Bitcoin state is attested ONLY by an SP1 relay proof (no trusted oracle): the
    /// proven pool root becomes canonical and the spent-set root advances.
    function test_attest_bitcoin_state_proven() public {
        bytes32 poolRoot = keccak256("btc-pool-root");
        bytes32 spentRoot = keccak256("btc-spent-root");
        _attestBtc(poolRoot, spentRoot, 100);
        assertTrue((vm.load(address(pool), keccak256(abi.encode(poolRoot, uint256(77)))) != bytes32(0)), "pool root attested by proof");
        assertEq(vm.load(address(pool), bytes32(uint256(78))), spentRoot, "spent root advanced");
    }

    /// A stale relay proof (height not strictly advancing) is rejected — it can't roll
    /// the reflected spent set backward to omit a recent Bitcoin spend.
    function test_stale_relay_proof_rejected() public {
        _attestBtc(keccak256("r1"), keccak256("s1"), 200);
        // a height DECREASE (rollback) is rejected; equal heights are allowed (same-block
        // effects), and the digest chain bars replay of an already-attested state.
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("r2"),
            keccak256("s2"),
            keccak256("b2"),
            199,
            keccak256("next2"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.StaleRelayProof.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// A bridge_mint against an un-attested Bitcoin root is rejected — the gate
    /// that stops minting a note proven in a fabricated tree.
    function test_bridge_mint_requires_attested_root() public {
        // A current burn root is attested (so the burn-root pin passes); the bridge_mint
        // still fails because its POOL root is not relay-attested — the membership gate.
        bytes32 burnRoot = _attestBtc(keccak256("bm-pool-4"), keccak256("bm-spent-4"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 root = keccak256("unknown-btc-root");
        bytes32 burnNullifier = keccak256("mint-burn");
        pv.nullifiers = _arr(burnNullifier);
        pv.bitcoinBurnsConsumed = _arr(burnNullifier);
        pv.bitcoinBurnRoot = burnRoot;
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = root;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("minted");
        vm.expectRevert(ConfidentialPool.UnknownBitcoinRoot.selector);
        pool.settle(abi.encode(pv), "", new bytes[](1));
    }

    /// A bridge_mint against an attested root mints the Ethereum note and marks
    /// the burn nullifier — the full BTC→ETH effect on the contract side.
    function test_bridge_mint_with_attested_root_succeeds() public {
        bytes32 root = keccak256("good-btc-root");
        bytes32 burnRoot = _attestBtc(root, keccak256("imt-empty-sentinel"), 1); // non-zero spent root (empty-IMT sentinel)

        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 burnNullifier = keccak256("mint-burn-2");
        pv.nullifiers = _arr(burnNullifier);
        pv.bitcoinBurnsConsumed = _arr(burnNullifier);
        pv.bitcoinBurnRoot = burnRoot;
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = root;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("minted-note");

        pool.settle(abi.encode(pv), "", new bytes[](1));

        assertTrue(pool.bridgeMinted(burnNullifier), "burn claimed");
        assertEq(pool.nextLeafIndex(), 1, "ETH note minted");
    }

    // ──────────────────── trustless first-mint metadata (OP_ATTEST_META) ────────────────────

    /// Trustless metadata via the REFLECTION attestation (the v1 path): the reflection authenticates an
    /// asset's etch (BIP141 witness commitment + canonical provenance header chain — any age) and surfaces
    /// (asset_id, ticker, decimals, cid) in `attestedAssetMetas`; attestBitcoinStateProven lazy-registers the
    /// canonical ERC20 from it. No settle op, no on-chain etch-block anchor needed (the reflection already
    /// anchored it). This is what registers TAC and other Tacit-native assets.
    function test_attest_auto_registers_from_attested_meta() public {
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        ConfidentialPool p = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );

        bytes32 tacId = keccak256("attested-TAC");
        bytes32 prior = p.knownReflectionDigest();
        ConfidentialPool.AssetMeta[] memory metas = new ConfidentialPool.AssetMeta[](1);
        metas[0] = ConfidentialPool.AssetMeta(tacId, bytes16("TAC"), 3, 8, bytes32(0)); // ticker "TAC", 8 dec
        ConfidentialPool.BitcoinRelayPublicValues memory rl = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("attested-pool-root"),
            keccak256("sentinel"),
            keccak256("sentinel-burn"),
            1,
            keccak256("next"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(p)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(p.bitcoinConsumedCount()),
            metas,
            new bytes32[](0)
        );
        p.attestBitcoinStateProven(abi.encode(rl), "");

        // The reflection attestation alone lazy-deployed + linked the canonical ERC20 — no settle involved.
        address token = factory.tokenOf(tacId, address(p), "TAC", 18);
        assertTrue(token != address(0), "lazy-deployed at attest time");
        assertEq(token, factory.predict(tacId, address(p), "TAC", 18), "at f(asset_id, pool, meta)");
        assertEq(CanonicalBridgedERC20(token).symbol(), "TAC", "proven ticker");
        assertEq(CanonicalBridgedERC20(token).decimals(), 18, "harmonized to 18");
        assertEq(CanonicalBridgedERC20(token).MINTER(), address(p), "pool is minter");

        bytes32 internalId = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), token));
        AssetView memory a = assetOf(p, internalId);
        assertTrue(a.registered, "registered");
        assertEq(a.unitScale, 1e10, "unitScale = 10^(18-8)");
        assertEq(a.crossChainLink, tacId, "linked to the Bitcoin asset id");
    }

    // ──────────────────── Tacit-recorded asset: pool is the canonical ERC20 minter ────────────────────

    /// A Tacit-recorded asset (TAC, a cBTC equivalent, …) whose canonical public
    /// ERC20 the POOL mints on exit and burns on entry — no escrow, the pool is the
    /// single supply authority. Round-trip: unwrap → mint ERC20 (public); wrap →
    /// burn ERC20 (confidential).
    function test_pool_minted_asset_exit_and_reenter() public {
        bytes32 canonId = keccak256("TAC");
        CanonicalBridgedERC20 tac = CanonicalBridgedERC20(
            factory.deployCanonical(canonId, address(pool), "TAC", 18) // MINTER = the pool
        );
        // A local pool-minted asset (unitScale derived = 1); no cross-chain link (that path is
        // attest_meta-only). The exit/re-enter below uses the local asset id `a`.
        bytes32 a = pool.registerMinted(address(tac), "Conf TAC", "TAC", 18);

        // EXIT: an unwrap pays out by MINTING the canonical ERC20 to the recipient.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(a, USER, 1000);
        _settle(pv);
        assertEq(tac.balanceOf(USER), 1000, "exit minted the public ERC20");
        assertEq(tac.totalSupply(), 1000, "supply = exited amount");
        assertEq(pool.escrow(a), 0, "no escrow for a pool-minted asset");

        // RE-ENTER: a wrap BURNS the canonical ERC20 (back to confidential).
        vm.prank(USER);
        pool.wrap(a, 1000, keccak256(abi.encodePacked(bytes32(uint256(7)), bytes32(uint256(8)), bytes32(uint256(9)))));
        assertEq(tac.balanceOf(USER), 0, "re-entry burned the public ERC20");
        assertEq(tac.totalSupply(), 0, "supply back to confidential");
        assertEq(pool.escrow(a), 0, "still no escrow");
    }

    // ──────────────────── cross-lane: cross-lane gate ────────────────────

    /// A note homed on Bitcoin can be spent on the Ethereum fast lane by proving
    /// membership against a relay-proven Bitcoin pool root — but ONLY while pinning the
    /// current, non-zero reflected spent-set root (so the guest's non-membership check
    /// is enforced; see test_btc_homed_spend_omitting_gate_reverts for the bypass).
    function test_spend_against_reflected_bitcoin_root() public {
        bytes32 btcRoot = keccak256("bitcoin-pool-root");
        bytes32 spent = keccak256("bitcoin-spent-set"); // non-zero reflected spent set
        _attestBtc(btcRoot, spent, 1);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot; // membership proven against the proven Bitcoin root
        pv.bitcoinSpentRoot = spent; // pins the current spent set (guest proved non-membership)
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = keccak256("btc-homed-note");
        _settle(pv); // no UnknownRoot revert — Bitcoin root accepted as a spend root
        assertTrue(pool.nullifierSpent(keccak256("btc-homed-note")), "fast-spent on Ethereum");
    }

    /// The relay can never reflect a ZERO spent-set root: an empty Bitcoin spent set has
    /// a non-zero empty-IMT sentinel root, and a zero root would re-open the cross-lane
    /// bypass (the guest skips its non-membership check when bitcoin_spent_root == 0).
    function test_attest_zero_spent_root_rejected() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("some-pool-root"),
            bytes32(0),
            keccak256("b"),
            1,
            keccak256("n"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.StaleBitcoinSpentRoot.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// Symmetric to the zero-spent-root rejection: a zero bridge-BURN root must also be
    /// rejected at attest. The guest keys bridge_mint's burn-set membership off
    /// `bitcoin_burn_root != 0`, so a relay reflecting an empty burn set as 0 would let a
    /// bridge_mint skip its membership check — the contract backstop (ConfidentialPool.sol
    /// StaleBitcoinBurnRoot at attest) keeps that honest. The reflection prover seeds the
    /// empty burn set to a non-zero sentinel, so a legitimate burn root is never 0.
    function test_attest_zero_burn_root_rejected() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("some-pool-root"),
            keccak256("s"),
            bytes32(0),
            1,
            keccak256("n"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.StaleBitcoinBurnRoot.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// Symmetric to the zero spent/burn-root rejections: a zero Bitcoin POOL root must also be
    /// rejected. bridge_mint proves the burned note's membership against a knownBitcoinRoot, so
    /// marking an empty tree (root 0) canonical would let a mint prove membership against nothing.
    /// The reflection prover seeds a non-zero empty-tree root, so a legitimate pool root is never 0.
    function test_attest_zero_pool_root_rejected() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            bytes32(0),
            keccak256("s"),
            keccak256("b"),
            1,
            keccak256("n"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.ZeroBitcoinPoolRoot.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// Mode B cross-lane inflation guard: a reflection proof must declare THIS pool as the reflected
    /// eth pool (ethPoolReflected == address(this)). The contract knows its own address, so a proof
    /// carrying a DIFFERENT pool's address — whose crossOuts would otherwise fold into this pool's
    /// reflected state (cross-lane inflation) — is rejected, breaking the pool<->vkey circularity
    /// with no in-guest pool pin.
    function test_attest_wrong_eth_pool_rejected() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("pr"),
            keccak256("s"),
            keccak256("b"),
            1,
            keccak256("n"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(0xBADBAD)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.WrongEthPool.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// A FORWARD-ONLY reflection batch (burn-deposit / cmint / CXFER scan) folds no crossOut and skips the
    /// eth-reflection recursion (mode_b == 0 in the guest), committing the zero ethPoolReflected sentinel.
    /// That is accepted (it attested no eth-state), where a non-zero non-self pool is still rejected above —
    /// so the forward bridge can attest + advance without Mode-B being operational, with no inflation path
    /// (the guest's sentinel crossout_set_root makes every fold_crossout fail membership).
    function test_attest_zero_eth_pool_accepted_forward_only() public {
        bytes32 poolRoot = keccak256("fwd-pool-root");
        bytes32 spentRoot = keccak256("fwd-spent-root");
        bytes32 burnRoot = keccak256(abi.encodePacked(spentRoot, "burn"));
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, uint64(101)));
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            poolRoot,
            spentRoot,
            burnRoot,
            101,
            next,
            ANCHOR,
            ANCHOR,
            bytes32(0),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        ); // ethPool = 0 sentinel
        pool.attestBitcoinStateProven(abi.encode(r), "");
        assertTrue((vm.load(address(pool), keccak256(abi.encode(poolRoot, uint256(77)))) != bytes32(0)), "forward-only batch (zero ethPool) attests + advances");
        assertEq(pool.knownReflectionDigest(), next, "reflection digest advanced on the sentinel batch");
    }

    // The relay anchor (F1): a batch whose tip doesn't match the relay tip (nor a recent ancestor)
    // is rejected — so the proven header chain must be canonical Bitcoin, not a free witness.
    function test_reflection_anchor_rejects_wrong_tip() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("pr"),
            keccak256("s"),
            keccak256("sb"),
            1,
            keccak256("n"),
            ANCHOR,
            keccak256("not-the-relay-tip"),
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.UnanchoredReflection.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // And a batch whose prev doesn't continue the prior attested tip (nor a recent ancestor) is rejected.
    function test_reflection_anchor_rejects_wrong_prev() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("pr"),
            keccak256("s"),
            keccak256("sb"),
            1,
            keccak256("n"),
            keccak256("not-the-prior-tip"),
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.UnanchoredReflection.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // Maturity (the bridge-burn reorg guard): a batch whose tip is NOT buried REFLECTION_CONFIRMATIONS
    // below the relay tip — here the live relay tip itself (0 confirmations) — is rejected. So a
    // bridge-burn can never authorize a mint at a shallow depth where a tip reorg would strand it
    // (the burned note re-living on Bitcoin while the Ethereum mint stands).
    function test_reflection_anchor_rejects_immature_tip() public {
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 freshTip = relay.tip(); // 0 confirmations deep — above the matured anchor, not buried
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("pr"),
            keccak256("s"),
            keccak256("sb"),
            1,
            keccak256("n"),
            ANCHOR,
            freshTip,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.UnanchoredReflection.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // The reflection digest chains: a proof must continue knownReflectionDigest, and each
    // accepted proof advances it — so the reflected roots are one append-only chain.
    function test_reflection_digest_chains() public {
        assertEq(pool.knownReflectionDigest(), REFLECTION_GENESIS_DIGEST, "seeded to genesis");
        _attestBtc(keccak256("r1"), keccak256("s1"), 10);
        bytes32 advanced = pool.knownReflectionDigest();
        assertTrue(advanced != REFLECTION_GENESIS_DIGEST, "digest advanced");

        // a proof that doesn't continue the current digest is rejected
        ConfidentialPool.BitcoinRelayPublicValues memory bad = ConfidentialPool.BitcoinRelayPublicValues(
            keccak256("wrong-prior"),
            keccak256("r2"),
            keccak256("s2"),
            keccak256("b2"),
            11,
            keccak256("n2"),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.StaleReflectionDigest.selector);
        pool.attestBitcoinStateProven(abi.encode(bad), "");

        // a zero newDigest is never a valid reflected state
        ConfidentialPool.BitcoinRelayPublicValues memory z = ConfidentialPool.BitcoinRelayPublicValues(
            advanced,
            keccak256("r3"),
            keccak256("s3"),
            keccak256("b3"),
            11,
            bytes32(0),
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.StaleReflectionDigest.selector);
        pool.attestBitcoinStateProven(abi.encode(z), "");
    }

    /// An unattested Bitcoin root is rejected as a spend root.
    function test_spend_against_unattested_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = keccak256("not-attested");
        vm.expectRevert(ConfidentialPool.UnknownRoot.selector);
        _settle(pv);
    }

    // ──────────────────── cross-lane: reflected spent-set root (IMT) ────────────────────

    /// A settle whose in-guest non-membership used a stale Bitcoin spent-set root is
    /// rejected — it could omit a recent Bitcoin spend. The fresh root is relay-proven.
    function test_stale_bitcoin_spent_root_rejected() public {
        _attestBtc(keccak256("pool"), keccak256("current-root"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinSpentRoot = keccak256("stale-root");
        vm.expectRevert(ConfidentialPool.StaleBitcoinSpentRoot.selector);
        _settle(pv);
    }

    /// A settle against the current relay-proven root is accepted (the guest proved
    /// non-membership of each spent ν against exactly this root).
    function test_fresh_bitcoin_spent_root_accepted() public {
        bytes32 r = keccak256("the-root");
        _attestBtc(keccak256("pool"), r, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinSpentRoot = r;
        _settle(pv); // matches → no revert
        assertEq(vm.load(address(pool), bytes32(uint256(78))), r, "unchanged");
    }

    /// The cross-lane non-membership gate is MANDATORY for a Bitcoin-homed spend
    /// (membership against a relay-proven Bitcoin root). When a non-zero Bitcoin spent
    /// set exists, a spend that omits the gate (bitcoinSpentRoot = 0) is rejected —
    /// otherwise a note already spent on Bitcoin could be re-spent on the Ethereum fast
    /// lane by simply not proving non-membership. (Contrast the spentRoot=0 case in
    /// test_spend_against_reflected_bitcoin_root, which passes only because no Bitcoin
    /// spend exists yet, so 0 IS the current spent-set root.)
    function test_btc_homed_spend_omitting_gate_reverts() public {
        bytes32 btcRoot = keccak256("btc-pool");
        _attestBtc(btcRoot, keccak256("btc-spent-set"), 1); // a real spent set exists

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot; // Bitcoin-homed: membership vs a Bitcoin root
        pv.nullifiers = _arr(keccak256("nu-note"));
        // pv.bitcoinSpentRoot left 0 → skips the cross-lane non-membership check
        vm.expectRevert(ConfidentialPool.StaleBitcoinSpentRoot.selector);
        _settle(pv);
    }

    /// The same Bitcoin-homed spend that DOES pin the current spent-set root settles —
    /// the guest proved each ν absent from exactly this Bitcoin spent set.
    function test_btc_homed_spend_with_current_gate_succeeds() public {
        bytes32 btcRoot = keccak256("btc-pool");
        bytes32 spent = keccak256("btc-spent-set");
        _attestBtc(btcRoot, spent, 1);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent; // pins the current root → gate satisfied
        pv.nullifiers = _arr(keccak256("nu-note"));
        _settle(pv);
        assertTrue(pool.nullifierSpent(keccak256("nu-note")), "fast-spent with cross-lane proof");
    }

    /// Cross-lane single-spend: a Bitcoin-homed note fast-spent on Ethereum cannot then be
    /// burned on Bitcoin and bridge-minted for the same value. The guest emits the burned ν
    /// into `nullifiers` (not just `bitcoinBurnsConsumed`), so once the fast-lane spend has
    /// consumed ν the later bridge_mint hits the nullifier set — closing fastlane→burn→mint.
    function test_btc_homed_fastspend_then_bridge_mint_reverts() public {
        bytes32 btcRoot = keccak256("btc-pool");
        bytes32 spentEmpty = keccak256("imt-empty-sentinel"); // non-zero empty-IMT sentinel
        bytes32 nu = keccak256("nu-crosslane");
        _attestBtc(btcRoot, spentEmpty, 1);

        // 1) fast-lane spend on Ethereum: ν absent from the Bitcoin spent set (not yet burned).
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spentEmpty;
        pv.nullifiers = _arr(nu);
        _settle(pv);
        assertTrue(pool.nullifierSpent(nu), "fast-spent");

        // 2) note later burned on Bitcoin (ν now in the reflected spent set); a bridge_mint
        //    of the SAME ν carries ν in `nullifiers` (post-fix guest) → must revert.
        bytes32 spentWithNu = keccak256("btc-spent-with-nu");
        bytes32 burnRoot2 = _attestBtc(btcRoot, spentWithNu, 2);
        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.bitcoinRootsUsed = _arr(btcRoot);
        pv2.bitcoinBurnsConsumed = _arr(nu);
        pv2.nullifiers = _arr(nu); // post-fix: burned ν consumed in the global nullifier set
        pv2.bitcoinSpentRoot = spentWithNu;
        pv2.bitcoinBurnRoot = burnRoot2;
        pv2.leaves = _arr(keccak256("minted-from-burn"));
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        pool.settle(abi.encode(pv2), "", new bytes[](1));
    }

    // ──────────────────── on-chain defense-in-depth (intra-batch) ────────────────────

    function test_settle_intrabatch_duplicate_nullifier_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = keccak256("dup");
        pv.nullifiers[1] = keccak256("dup");
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        _settle(pv);
    }

    function test_settle_intrabatch_duplicate_deposit_reverts() public {
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = id;
        pv.depositsConsumed[1] = id;
        vm.expectRevert(ConfidentialPool.DepositNotPending.selector);
        _settle(pv);
    }

    function test_settle_withdraw_zero_recipient_reverts() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, address(0), 10);
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        _settle(pv);
    }

    /// A cross-chain deploy (non-zero relay vkey) must wire BOTH a header relay AND a non-zero
    /// genesis anchor — otherwise _anchorReflection is unsatisfiable and the first attest bricks
    /// (UnanchoredReflection) forever. Both are ctor-enforced.
    function test_ctor_reflection_requires_relay_and_anchor() public {
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector); // missing header relay
        new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(0),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector); // missing genesis anchor
        new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            bytes32(0),
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        // Both present → deploys, anchor seeded.
        new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
    }

    function test_ctor_rejects_zero_verifier_zero_vkey_and_noncontract_factory() public {
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        new ConfidentialPool(
            address(0), VKEY, bytes32(0), address(0), address(0), bytes32(0), 0, bytes32(0), bytes32(0), address(0)
        );

        vm.expectRevert(ConfidentialPool.ZeroVKey.selector);
        new ConfidentialPool(
            address(verifier),
            bytes32(0),
            bytes32(0),
            address(0),
            address(0),
            bytes32(0),
            0,
            bytes32(0),
            bytes32(0),
            address(0)
        );

        vm.expectRevert(ConfidentialPool.NotAContract.selector);
        new ConfidentialPool(
            address(verifier),
            VKEY,
            bytes32(0),
            address(0xBEEF),
            address(0),
            bytes32(0),
            0,
            bytes32(0),
            bytes32(0),
            address(0)
        );
    }

    /// A cross-chain deploy must set a sane, non-zero, gas-bounded maturity depth: 0 would anchor a
    /// batch to the live relay tip (~1 confirmation, re-opening the bridge-burn reorg window), and an
    /// unbounded value would make attest exceed the block gas limit. Both revert; an Ethereum-only
    /// deploy (relay vkey 0) doesn't read the value, so any value is accepted.
    function test_ctor_reflection_confirmations_bounds() public {
        vm.expectRevert(ConfidentialPool.BadReflectionConfirmations.selector); // zero maturity with reflection on
        new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            0,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        vm.expectRevert(ConfidentialPool.BadReflectionConfirmations.selector); // above MAX
        new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            145,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        // a deeper-but-bounded depth is fine
        ConfidentialPool deep = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            144,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        assertTrue(address(deep) != address(0), "max maturity depth");
        // reflection OFF: the maturity value is unused, so even 0 deploys
        ConfidentialPool off = new ConfidentialPool(
            address(verifier),
            VKEY,
            bytes32(0),
            address(factory),
            address(0),
            bytes32(0),
            0,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        assertTrue(address(off) != address(0), "off: unvalidated, unused");
    }

    /// GENERATIONAL anchoring (ops/PLAN-pool-generations.md): a gen deployed with `reflectionResumeDigest`
    /// = 0 seeds `knownReflectionDigest` to the protocol genesis (gen-1, continues genesis); a NON-ZERO
    /// resume digest seeds it there — a gen-N joining the SHARED Bitcoin reflection mid-stream at near-tip,
    /// so it never replays Bitcoin history. The block-anchor + this digest are the matched resume pair.
    function test_generational_reflection_resume_digest() public {
        // gen-1: default 0 ⇒ continues the protocol genesis digest.
        ConfidentialPool gen1 = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        assertEq(gen1.knownReflectionDigest(), REFLECTION_GENESIS_DIGEST, "gen-1 seeds the genesis digest");

        // gen-N: a non-zero near-tip resume digest seeds knownReflectionDigest to it (no history replay).
        bytes32 nearTip = keccak256("near-tip-reflected-digest");
        ConfidentialPool genN = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            nearTip,
            bytes32(0),
            address(0)
        );
        assertEq(genN.knownReflectionDigest(), nearTip, "gen-N resumes at the near-tip digest");
        assertTrue(genN.knownReflectionDigest() != REFLECTION_GENESIS_DIGEST, "gen-N is not genesis-anchored");
    }

    /// STAGE 1 — tETH subsumption (ops/PLAN-teth-subsumption.md): NATIVE ETH carries a cross-chain link
    /// PINNED AT CONSTRUCTION (tETH = shielded ETH); the permissionless registerWrapped can't set a
    /// native-ETH link, and a FOREIGN ERC20 escrow + a link stays barred. The escrow==supply invariant:
    /// wrap ETH → escrow tracks it; an unwrap draws EXACTLY the value released; and the contract is
    /// FAIL-CLOSED on escrow (an unwrap beyond escrow reverts InsufficientEscrow — locks, never drains).
    /// No escrow-drain-defense change: tETH→ETH is a normal (non-btcHomed) unwrap, so the defense never fires.
    function test_teth_native_eth_link_and_escrow_supply_invariant() public {
        bytes32 tethBitcoinId = keccak256("teth-bitcoin-canonical-id");
        // The native-ETH (address(0)) cross-chain link is set ONLY by the constructor (TETH_BITCOIN_LINK).
        ConfidentialPool p = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            tethBitcoinId,
            address(0)
        );
        bytes32 teth = p.localAssetOf(tethBitcoinId);
        assertTrue(teth != bytes32(0), "ctor pinned the Bitcoin tETH id to the native-ETH asset");
        (, address und,, bytes32 link, bool pm,) = p.assets(teth);
        assertEq(und, address(0), "native ETH backing");
        assertEq(link, tethBitcoinId, "carries the Bitcoin link");
        assertTrue(!pm, "escrow-backed, not pool-minted");

        // The PUBLIC registerWrapped can't bind a native-ETH link (the slot is also already taken).
        vm.expectRevert(ConfidentialPool.CrossChainEscrow.selector);
        p.registerWrapped(address(0), 10 ** 10, keccak256("another-link"), "X", "X", 18);

        // A FOREIGN ERC20 escrow + a link is STILL barred (its backing the pool can't control).
        MockERC20 ext = new MockERC20();
        vm.expectRevert(ConfidentialPool.CrossChainEscrow.selector);
        p.registerWrapped(address(ext), 1, keccak256("foreign-link"), "X", "X", 8);

        // Wrap ETH → tETH: escrow == the deposited ETH (escrow tracks supply).
        uint256 amt = 0.5 ether; // a multiple of UNIT_SCALE (1e10)
        p.wrap{value: amt}(
            teth, amt, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
        assertEq(p.escrow(teth), amt, "escrow == deposited ETH");

        // headroom for the no-inflation floor (a withdrawal spends a nullifier)
        ConfidentialPool.PublicValues memory seed = _pvFor(p);
        seed.leaves = new bytes32[](2);
        seed.leaves[0] = keccak256("teth-seed-0");
        seed.leaves[1] = keccak256("teth-seed-1");
        p.settle(abi.encode(seed), "", new bytes[](2));

        // Unwrap part — a NORMAL (non-btcHomed) withdrawal: native ETH released, escrow drawn by exactly it.
        uint256 outValue = (amt / 1e10) / 2; // half, in tacit-units
        ConfidentialPool.PublicValues memory pv = _pvFor(p);
        pv.nullifiers = _arr(keccak256("teth-note-nu"));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(teth, RECIP, outValue);
        uint256 balBefore = RECIP.balance;
        p.settle(abi.encode(pv), "", new bytes[](0));
        assertEq(p.escrow(teth), amt - outValue * 1e10, "escrow drawn by exactly the unwrapped value");
        assertEq(RECIP.balance - balBefore, outValue * 1e10, "native ETH released to the recipient");

        // FAIL-CLOSED: an unwrap beyond the remaining escrow reverts (a shortfall locks, never drains).
        ConfidentialPool.PublicValues memory over = _pvFor(p);
        over.nullifiers = _arr(keccak256("teth-note-nu-2"));
        over.withdrawals = new ConfidentialPool.Withdrawal[](1);
        over.withdrawals[0] = ConfidentialPool.Withdrawal(teth, RECIP, amt / 1e10); // > remaining escrow
        vm.expectRevert(ConfidentialPool.InsufficientEscrow.selector);
        p.settle(abi.encode(over), "", new bytes[](0));
    }

    /// The native-ETH cross-chain link can be bound ONLY at construction — the permissionless registerWrapped
    /// rejects a native-ETH link (single slot, no token to authenticate it against), and an unlinked native-ETH
    /// escrow asset is still registerable.
    function test_native_eth_link_rejected_on_registerWrapped() public {
        // Fresh pool with NO tETH link: native ETH may still be registered as a plain link-free escrow asset.
        ConfidentialPool p = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        // A native-ETH link on the permissionless path reverts.
        vm.expectRevert(ConfidentialPool.CrossChainEscrow.selector);
        p.registerWrapped(address(0), 1, keccak256("squat-link"), "cETH", "cETH", 18);
        // The same native-ETH registration WITHOUT a link succeeds (plain shielded ETH).
        bytes32 ceth = p.registerWrapped(address(0), 10 ** 10, bytes32(0), "cETH", "cETH", 18);
        assertTrue(ceth != bytes32(0), "link-free native ETH registers");
        assertEq(p.localAssetOf(keccak256("squat-link")), bytes32(0), "no link was bound");
    }

    function test_teth_attested_meta_does_not_deploy_shadow_erc20() public {
        bytes32 tethBitcoinId = keccak256("teth-bitcoin-canonical-id");
        ConfidentialPool p = new ConfidentialPool(
            address(verifier),
            VKEY,
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            tethBitcoinId,
            address(0)
        );
        bytes32 nativeId = p.localAssetOf(tethBitcoinId);
        assertTrue(nativeId != bytes32(0), "native tETH link pinned");

        ConfidentialPool.AssetMeta[] memory metas = new ConfidentialPool.AssetMeta[](1);
        metas[0] = ConfidentialPool.AssetMeta(tethBitcoinId, bytes16("tETH"), 4, 8, _metaCid(tethBitcoinId));
        p.attestBitcoinStateProven(
            abi.encode(
                ConfidentialPool.BitcoinRelayPublicValues(
                    p.knownReflectionDigest(),
                    keccak256("teth-meta-root"),
                    keccak256("teth-meta-spent"),
                    keccak256("teth-meta-burn"),
                    1,
                    keccak256("teth-meta-digest"),
                    ANCHOR,
                    ANCHOR,
                    bytes32(uint256(uint160(address(p)))),
                    0,
                    new ConfidentialPool.CbtcLockFolded[](0),
                    new bytes32[](0),
                    new bytes32[](0),
                    uint64(p.bitcoinConsumedCount()),
                    metas,
                    new bytes32[](0)
                )
            ),
            ""
        );

        assertEq(p.localAssetOf(tethBitcoinId), nativeId, "shared id still resolves to native ETH");
        (, address underlying,, bytes32 link, bool poolMinted,) = p.assets(nativeId);
        assertEq(underlying, address(0), "native ETH backing preserved");
        assertEq(link, tethBitcoinId, "tETH link preserved");
        assertTrue(!poolMinted, "not converted to pool-minted ERC20");
        assertEq(
            factory.tokenOf(tethBitcoinId, address(p), "tETH", 18, _metaCid(tethBitcoinId)),
            address(0),
            "no shadow canonical ERC20 deployed for native tETH"
        );
    }

    function test_settle_withdraw_unregistered_asset_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(keccak256("ghost-asset"), RECIP, 10);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        _settle(pv);
    }

    // ──────────────────── H-2: cross-chain shared-id resolution ────────────────────

    /// Establish a cross-chain link the ONLY sanctioned way: a guest-proven attest_meta. Attest a
    /// Bitcoin pool root, then settle an AssetMeta carrying the proven (ticker, decimals) — which
    /// lazy-deploys the canonical ERC20 and links `assetId` → it with the DERIVED scale. The mock
    /// verifier stands in for the guest; the point is that decimals come from the proof path.
    function _linkViaAttest(bytes32 assetId, string memory symbol_, uint8 decimals_) internal returns (address token) {
        bytes32 attRoot = keccak256(abi.encode("att-root", assetId));
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.AssetMeta[] memory metas = new ConfidentialPool.AssetMeta[](1);
        metas[0] = ConfidentialPool.AssetMeta(
            assetId, bytes16(bytes(symbol_)), uint8(bytes(symbol_).length), decimals_, _metaCid(assetId)
        );
        pool.attestBitcoinStateProven(
            abi.encode(
                ConfidentialPool.BitcoinRelayPublicValues(
                    prior,
                    attRoot,
                    keccak256("s"),
                    keccak256("sb"),
                    1,
                    keccak256("n"),
                    ANCHOR,
                    ANCHOR,
                    bytes32(uint256(uint160(address(pool)))),
                    0,
                    new ConfidentialPool.CbtcLockFolded[](0),
                    new bytes32[](0),
                    new bytes32[](0),
                    uint64(pool.bitcoinConsumedCount()),
                    metas,
                    new bytes32[](0)
                )
            ),
            ""
        );
        token = factory.tokenOf(assetId, address(pool), symbol_, 18, _metaCid(assetId));
    }

    /// A deterministic stand-in for the etch's IPFS metadata content hash.
    function _metaCid(bytes32 assetId) internal pure returns (bytes32) {
        return keccak256(abi.encode("test-meta-cid", assetId));
    }

    /// The etch-proven metadata CID flows attest_meta → factory → token, and contractURI()
    /// reconstructs a base16 CIDv1 from it — trustless (bound into asset_id), not operator-set.
    function test_attest_meta_sets_trustless_contractURI() public {
        bytes32 shared = keccak256("uri-asset");
        address tok = _linkViaAttest(shared, "cBTC", 8);
        assertEq(CanonicalBridgedERC20(tok).METADATA_CID(), _metaCid(shared), "etch CID stored on the token");
        bytes memory uri = bytes(CanonicalBridgedERC20(tok).contractURI());
        assertEq(uri.length, 80, "ipfs://f01551220 + 64 hex"); // 16 + 64
        for (uint256 i; i < 16; ++i) {
            assertEq(uri[i], bytes("ipfs://f01551220")[i], "CIDv1 base16 prefix");
        }
    }

    /// A front-runner cannot poison the trustless contractURI: deploying the canonical token at
    /// its f(asset_id) slot ahead of the pool's attest_meta with a DIFFERENT cid must not be
    /// adopted by the pool. The etch binds exactly one cid into asset_id, so the registered token
    /// must carry the etch-proven cid regardless of any pre-deploy.
    function test_attest_meta_cid_not_poisonable_by_front_run() public {
        bytes32 shared = keccak256("frontrun-asset");
        bytes32 attackerCid = keccak256("attacker-metadata");
        bytes32 provenCid = _metaCid(shared);
        assertTrue(attackerCid != provenCid, "distinct cids");

        // Attacker pre-deploys a canonical ERC20 for (asset_id, pool, symbol, 18) with their OWN
        // cid. Because cid is bound into the CREATE2 salt, this lands at a different address than
        // the etch-proven one — it can never shadow it.
        address attackerTok = factory.deployCanonical(shared, address(pool), "cBTC", 18, attackerCid);
        assertEq(CanonicalBridgedERC20(attackerTok).METADATA_CID(), attackerCid, "attacker token has attacker cid");

        // The pool now runs the guest-proven attest_meta carrying the etch's REAL cid.
        address tok = _linkViaAttest(shared, "cBTC", 8);

        // The pool deploys/uses the token at the cid-bound slot — a DIFFERENT address from the
        // attacker's, carrying the etch-proven cid (trustless contractURI, un-poisonable).
        assertTrue(tok != attackerTok, "pool's canonical token is NOT the wrong-cid pre-deploy");
        assertEq(CanonicalBridgedERC20(tok).METADATA_CID(), provenCid, "registered token carries the etch-proven cid");
        // The pool's local registry resolves the shared id to the correct-cid token.
        bytes32 localId = pool.localAssetOf(shared);
        assertEq(assetOf(pool, localId).underlying, tok, "linked to the etch-proven token");
    }

    /// A bridged note carries the SHARED (Bitcoin-side) asset id. The attest_meta path links the
    /// shared id to the lazy-deployed canonical token, so an unwrap whose withdrawal speaks the
    /// shared id resolves to it and mints. Without the link the bridged value would be locked (H-2).
    function test_bridged_note_unwraps_via_shared_id() public {
        bytes32 shared = keccak256("shared-btc-asset");
        address tok = _linkViaAttest(shared, "cBTC", 8); // proven 8 decimals → scale 10^10
        assertTrue(pool.localAssetOf(shared) != bytes32(0), "shared id linked via attest_meta");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(shared, RECIP, 7); // note speaks the shared id
        _settle(pv);
        assertEq(CanonicalBridgedERC20(tok).balanceOf(RECIP), 7 * 10 ** 10, "bridged note unwrapped via shared id");
    }

    /// An external/escrow asset can never claim a shared id — escrow can't back bridged
    /// supply, so a bridge_mint could not drain escrow it never funded.
    function test_escrow_cannot_claim_shared_id() public {
        MockERC20 ext = new MockERC20();
        vm.expectRevert(ConfidentialPool.CrossChainEscrow.selector);
        pool.registerWrapped(address(ext), 1, keccak256("some-shared-id"), "x", "x", 8);
    }

    /// F1: registerMinted registers a LOCAL asset only — it establishes NO cross-chain link, so a
    /// permissionless caller can never bind localAssetOf (and thus can't poison a bridged asset's
    /// scale or token). The only link path is the guest-proven attest_meta above.
    function test_registerMinted_is_local_only_no_link() public {
        address tok = factory.deployCanonical(keccak256("local-asset"), address(pool), "LOC", 18);
        bytes32 a = pool.registerMinted(tok, "Conf LOC", "LOC", 18);
        (,,, bytes32 link,,) = pool.assets(a);
        assertEq(link, bytes32(0), "registerMinted establishes no cross-chain link");
        assertEq(pool.localAssetOf(keccak256("local-asset")), bytes32(0), "no localAssetOf entry");
    }

    /// F1: a BRIDGED asset's scale is bound to the GUEST-PROVEN decimals (attest_meta), not a
    /// caller's word — a bridged unwrap pays value · 10^(18 − provenDecimals), set by the proof, so
    /// a front-runner cannot register a too-large scale and over-mint the real canonical ERC20.
    function test_bridged_scale_bound_to_proven_decimals() public {
        bytes32 shared = keccak256("proven-8dec");
        address tok = _linkViaAttest(shared, "cBTC", 8); // proven 8 decimals → scale 10^10
        bytes32 localId = pool.localAssetOf(shared);
        (,, uint256 unitScale,,,) = pool.assets(localId);
        assertEq(unitScale, 10 ** 10, "scale derived from PROVEN decimals (8), not caller-chosen");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(shared, RECIP, 3);
        _settle(pv);
        assertEq(CanonicalBridgedERC20(tok).balanceOf(RECIP), 3 * 10 ** 10, "payout = value * proven-derived scale");
    }

    /// CID-1: a permissionless registerMinted SQUAT of the EXACT etch-proven canonical token (pre-
    /// registering its internalId with a deliberately-WRONG scale) must NOT permanently lock the
    /// bridged shared id. attest_meta heals the link AND adopts the GUEST-PROVEN scale (overwriting
    /// the squat's), so the bridged value exits at the correct rate instead of reverting NotRegistered.
    /// (Overwrite is drain-safe: the canonical ERC20 is pool-minted, so a squatter holds zero balance
    /// and could not have wrapped any note at the wrong scale.)
    function test_registerMinted_squat_does_not_lock_bridged_asset() public {
        bytes32 shared = keccak256("squat-asset");
        bytes32 provenCid = _metaCid(shared);

        // Attacker pre-deploys the EXACT etch-proven canonical token (proven symbol + cid, 18 dec) and
        // registerMinted's it with a WRONG scale: tacitDecimals 18 → scale 1 (proven is 8 dec → 10^10).
        address tok = factory.deployCanonical(shared, address(pool), "cBTC", 18, provenCid);
        bytes32 internalId = pool.registerMinted(tok, "squat-name", "SQUAT", 18);
        assertEq(pool.localAssetOf(shared), bytes32(0), "squat establishes no cross-chain link");
        AssetView memory aBefore = assetOf(pool, internalId);
        assertEq(aBefore.unitScale, 1, "squatter registered the wrong scale");

        // The pool runs the guest-proven attest_meta (proven 8 decimals → scale 10^10).
        address proven = _linkViaAttest(shared, "cBTC", 8);
        assertEq(proven, tok, "attest_meta resolves the same salt-bound token (not a fresh deploy)");
        assertEq(pool.localAssetOf(shared), internalId, "link HEALED despite the prior squat");
        (,, uint256 scaleAfter, bytes32 link,,) = pool.assets(internalId);
        assertEq(scaleAfter, 10 ** 10, "scale OVERWRITTEN to the proven scale (squat's wrong scale discarded)");
        assertEq(link, shared, "crossChainLink healed to the shared id");
        // The squat's bogus display name/symbol are healed too — now via the re-emitted AssetRegistered event
        // ("Tacit Token" / the proven ticker), not stored, so not asserted through assets() here.

        // A bridged withdrawal now exits at the proven scale instead of reverting NotRegistered.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(shared, RECIP, 4);
        _settle(pv);
        assertEq(CanonicalBridgedERC20(tok).balanceOf(RECIP), 4 * 10 ** 10, "bridged exit at proven scale, not locked");
    }

    // ──────────────────── cross-lane: source-consume invariant ────────────────────

    /// FAST LANE escrow guard: a Bitcoin-homed value-exit must mint its bridged (pool-minted) asset, never
    /// pay from escrow funded by Ethereum wraps. `assetId` here is an EXTERNAL escrow ERC20 (not bridged),
    /// so a btcHomed withdrawal of it is rejected — otherwise a (compromised) guest could drain others'
    /// escrow against a Bitcoin-homed note that never funded it.
    function test_btc_homed_withdrawal_escrow_asset_reverts() public {
        bytes32 btcRoot = keccak256("btc-pool-ve");
        bytes32 spent = keccak256("btc-spent-ve");
        _attestBtc(btcRoot, spent, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot; // Bitcoin-homed
        pv.bitcoinSpentRoot = spent; // current reflected spent set (passes the freshness gate)
        pv.nullifiers = _arr(keccak256("ve-nu"));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 1); // assetId = escrow ERC20, not pool-minted
        vm.expectRevert(ConfidentialPool.BtcHomedValueExitMustBridge.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// FAST LANE: a Bitcoin-homed spend MAY move value onto Ethereum as a new note (a leaf), recording
    /// each consumed ν in `bitcoinConsumed` so the reverse reflection folds it into the Bitcoin spent set
    /// (Ethereum-senior). Safety is the vkey⇄guest pairing — the reflection guest pinned by
    /// BITCOIN_RELAY_VKEY must perform that fold (asserted off-chain, not here).
    function test_btc_homed_fast_lane_records_consumed() public {
        bytes32 btcRoot = keccak256("btc-pool-leaf");
        bytes32 spent = keccak256("btc-spent-leaf");
        _attestBtc(btcRoot, spent, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        bytes32 nu = keccak256("leaf-nu");
        pv.nullifiers = _arr(nu);
        pv.leaves = _arr(keccak256("ethereum-leaf-from-btc-note"));
        vm.expectEmit(false, false, false, true, address(pool));
        emit ConfidentialPool.BitcoinNotesConsumed(_arr(nu), btcRoot);
        pool.settle(abi.encode(pv), "", new bytes[](1));
        assertEq(pool.bitcoinConsumed(nu), btcRoot, "consumed nu recorded for the reverse reflection");
        assertTrue(pool.nullifierSpent(nu), "nullifier marked");
    }

    /// FRESHNESS ANCHOR: each fast-lane value-exit advances `bitcoinConsumedCount` by exactly its
    /// consumed-note count (every ν is new — the nullifierSpent gate bars repeats), the counter equals the
    /// number of distinct recorded entries, and it is cumulative + monotone across batches. The
    /// eth-reflection guest reads this slot from the same finalized state and asserts its folded
    /// `consumedNuCount` equals it — so a worker cannot witness only a SUBSET of consumes, leaving the
    /// omitted source notes live + double-spendable on Bitcoin.
    function test_fast_lane_consumed_count_advances() public {
        bytes32 btcRoot = keccak256("btc-pool-count");
        bytes32 spent = keccak256("btc-spent-count");
        _attestBtc(btcRoot, spent, 1);
        assertEq(pool.bitcoinConsumedCount(), 0, "starts at zero");

        // Batch 1: two consumed notes + a leaf → count advances by 2, both entries recorded.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = keccak256("cnt-nu-a");
        pv.nullifiers[1] = keccak256("cnt-nu-b");
        pv.leaves = _arr(keccak256("cnt-leaf-1"));
        pool.settle(abi.encode(pv), "", new bytes[](1));
        assertEq(pool.bitcoinConsumedCount(), 2, "advanced by the batch's consumed count");
        assertEq(pool.bitcoinConsumed(keccak256("cnt-nu-a")), btcRoot, "entry a recorded");
        assertEq(pool.bitcoinConsumed(keccak256("cnt-nu-b")), btcRoot, "entry b recorded");
        assertEq(
            bytes32(vm.load(address(pool), keccak256(abi.encode(uint256(0), uint256(163))))),
            keccak256("cnt-nu-a"),
            "index 0 enumerates entry a"
        );
        assertEq(
            bytes32(vm.load(address(pool), keccak256(abi.encode(uint256(1), uint256(163))))),
            keccak256("cnt-nu-b"),
            "index 1 enumerates entry b"
        );

        // Batch 2: one more consumed note → cumulative count = 3 (monotone across batches).
        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.spendRoot = btcRoot;
        pv2.bitcoinSpentRoot = spent;
        pv2.nullifiers = _arr(keccak256("cnt-nu-c"));
        pv2.leaves = _arr(keccak256("cnt-leaf-2"));
        pool.settle(abi.encode(pv2), "", new bytes[](1));
        assertEq(pool.bitcoinConsumedCount(), 3, "cumulative across batches");
        assertEq(
            bytes32(vm.load(address(pool), keccak256(abi.encode(uint256(2), uint256(163))))),
            keccak256("cnt-nu-c"),
            "next batch appends at index 2"
        );
    }

    /// The freshness counter advances ONLY when a consume is recorded (a value-exit). A nullifier-only
    /// btcHomed batch writes neither `bitcoinConsumed` nor the counter, so `count == #entries` stays exact
    /// and the eth-reflection equality has no phantom count the guest could never witness a slot for.
    function test_fast_lane_consumed_count_tracks_only_value_exits() public {
        bytes32 btcRoot = keccak256("btc-pool-noexit");
        bytes32 spent = keccak256("btc-spent-noexit");
        _attestBtc(btcRoot, spent, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = _arr(keccak256("noexit-nu"));
        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertEq(pool.bitcoinConsumedCount(), 0, "no value-exit => counter unchanged");
    }

    /// FAST-LANE FRESHNESS GATE: once a consume is recorded, a reflection that has NOT folded it
    /// (`consumedCount < bitcoinConsumedCount`) cannot advance the spent set — this is the contract-side
    /// close of the stale-eth-proof double-credit (a worker can't attest a racing Bitcoin spend while a
    /// recent consume's source note is still live). The same reflection that DID fold it attests normally.
    function test_fast_lane_freshness_gate_rejects_stale_attest() public {
        bytes32 btcRoot = keccak256("fl-fresh-pool");
        bytes32 spent = keccak256("fl-fresh-spent");
        _attestBtc(btcRoot, spent, 1); // setup; bitcoinConsumedCount == 0

        // Fast-lane consume: a btcHomed leaf records bitcoinConsumed[ν] and bumps the counter to 1.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = _arr(keccak256("fresh-nu"));
        pv.leaves = _arr(keccak256("fresh-leaf"));
        pool.settle(abi.encode(pv), "", new bytes[](1));
        assertEq(pool.bitcoinConsumedCount(), 1, "consume recorded");

        bytes32 prior = pool.knownReflectionDigest();
        bytes32 ethPool = bytes32(uint256(uint160(address(pool))));
        // A reflection that did NOT fold the consume (consumedCount 0) is rejected before it can advance.
        ConfidentialPool.BitcoinRelayPublicValues memory stale = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("fl-r2"),
            keccak256("fl-s2"),
            keccak256("fl-b2"),
            2,
            keccak256("fl-next"),
            ANCHOR,
            ANCHOR,
            ethPool,
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            0,
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        vm.expectRevert(ConfidentialPool.ConsumedCountStale.selector);
        pool.attestBitcoinStateProven(abi.encode(stale), "");

        // The same reflection that DID fold it (consumedCount 1) attests.
        ConfidentialPool.BitcoinRelayPublicValues memory fresh = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            keccak256("fl-r2"),
            keccak256("fl-s2"),
            keccak256("fl-b2"),
            2,
            keccak256("fl-next"),
            ANCHOR,
            ANCHOR,
            ethPool,
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            1,
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        pool.attestBitcoinStateProven(abi.encode(fresh), "");
    }

    /// FAST-LANE SWAP (one-settle): a Bitcoin-homed note may be the INPUT to an Ethereum AMM swap in a
    /// single settle. The guest already binds the input's asset (membership leaf) + the per-input
    /// cross-lane non-membership, so this is a contract-only relaxation; the consumed ν is recorded for the
    /// reverse reflection exactly like a leaf exit, and a swap pays no escrow (its output is a note backed
    /// by the pool's LP-funded reserve). Locks, EVM-deposit consumption and bridge_mint stay barred (the
    /// reverts tests below); swap + LP-add ride the fast lane.
    function test_btc_homed_swap_records_consumed() public {
        // A funded pool over (assetId, a fresh assetB).
        MockERC20 tokenB = new MockERC20();
        bytes32 assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 8);
        (bytes32 lo, bytes32 hi) = assetId < assetB ? (assetId, assetB) : (assetB, assetId);
        bytes32 pid = pool.createPair(lo, hi, 30, 0, bytes32(0), 0);
        ConfidentialPool.PublicValues memory lp = _pv();
        lp.liquidity = new ConfidentialPool.LpSettlement[](1);
        lp.liquidity[0] = ConfidentialPool.LpSettlement(pid, 0, 0, 0, 100000, 200000, 100000);
        _settle(lp);

        // Bob's Bitcoin-homed note funds the swap in ONE settle (spendRoot is a knownBitcoinRoot).
        bytes32 btcRoot = keccak256("btc-pool-swap");
        bytes32 spent = keccak256("btc-spent-swap");
        _attestBtc(btcRoot, spent, 1);
        bytes32 nu = keccak256("swap-nu");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = _arr(nu);
        pv.leaves = _arr(keccak256("swap-out-note")); // the trader's received note (a pool-backed leaf)
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = ConfidentialPool.SwapSettlement(pid, 100000, 200000, 110000, 182000); // k grows (fee)
        vm.expectEmit(false, false, false, true, address(pool));
        emit ConfidentialPool.BitcoinNotesConsumed(_arr(nu), btcRoot);
        pool.settle(abi.encode(pv), "", new bytes[](1));
        assertEq(pool.bitcoinConsumed(nu), btcRoot, "consumed swap-input nu recorded for the reverse reflection");
        assertEq(pool.bitcoinConsumedCount(), 1, "freshness count advanced by the swap consume");
        assertTrue(pool.nullifierSpent(nu), "nullifier marked");
        (,,, uint256 ra,,,) = pool.pools(pid);
        assertEq(ra, 110000, "the btcHomed swap advanced the pool");
    }

    /// FAST-LANE LP-ADD (one-settle): a Bitcoin holder may add liquidity in one settle. The guest binds both
    /// input assets (membership leaves) + the per-input cross-lane non-membership + the in-ratio
    /// conservation, and the output is a shielded LP-share note (no escrow payout). Both consumed ν are
    /// recorded for the reverse reflection. (A btcHomed LP-REMOVE can't form — LP-share notes are
    /// pool-minted on Ethereum, so membership against a Bitcoin root fails in the guest.)
    function test_btc_homed_lp_add_records_consumed() public {
        // A pool with initial liquidity.
        MockERC20 tokenB = new MockERC20();
        bytes32 assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 8);
        (bytes32 lo, bytes32 hi) = assetId < assetB ? (assetId, assetB) : (assetB, assetId);
        bytes32 pid = pool.createPair(lo, hi, 30, 0, bytes32(0), 0);
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.liquidity = new ConfidentialPool.LpSettlement[](1);
        seed.liquidity[0] = ConfidentialPool.LpSettlement(pid, 0, 0, 0, 100000, 200000, 100000);
        _settle(seed);

        // Bob's two Bitcoin-homed notes add liquidity in-ratio in ONE settle.
        bytes32 btcRoot = keccak256("btc-pool-lp");
        bytes32 spent = keccak256("btc-spent-lp");
        _attestBtc(btcRoot, spent, 1);
        bytes32 nuA = keccak256("lp-nu-a");
        bytes32 nuB = keccak256("lp-nu-b");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = nuA;
        pv.nullifiers[1] = nuB;
        pv.leaves = _arr(keccak256("lp-share-note")); // the shielded LP-share note
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = ConfidentialPool.LpSettlement(pid, 100000, 200000, 100000, 110000, 220000, 110000); // +10% in ratio
        pool.settle(abi.encode(pv), "", new bytes[](1));
        assertEq(pool.bitcoinConsumed(nuA), btcRoot, "consumed lp-input A recorded for the reverse reflection");
        assertEq(pool.bitcoinConsumed(nuB), btcRoot, "consumed lp-input B recorded");
        assertEq(pool.bitcoinConsumedCount(), 2, "freshness count advanced by both inputs");
        (,,, uint256 ra,,,) = pool.pools(pid);
        assertEq(ra, 110000, "the btcHomed LP-add grew reserve A");
    }

    /// FAST-LANE OTC FILL (one-settle, BOTH legs Bitcoin-homed): two Bitcoin holders match a confidential
    /// order directly on Ethereum in one settle. A batch proves membership against a SINGLE spendRoot, so a
    /// btcHomed OTC necessarily has both legs Bitcoin-homed (both notes are members of the same Bitcoin pool
    /// root). A MIXED-lane fill (one Bitcoin party, one Ethereum party) cannot be a single batch — the one
    /// spendRoot can't be both a Bitcoin and an EVM root — and is the two-settle on-ramp instead
    /// (test_stage2_swap_via_two_settle is the same shape). The op emits only leaves + nullifiers, so it rides
    /// the relaxed leaves bar; both spent ν are recorded in bitcoinConsumed for the reverse reflection (the
    /// guest runs check_btc_nonmembership per input — main.rs:750/774). ops/PLAN-fast-lane-trading.md (Flow A).
    function test_btc_homed_otc_records_consumed() public {
        bytes32 btcRoot = keccak256("btc-pool-otc");
        bytes32 spent = keccak256("btc-spent-otc");
        _attestBtc(btcRoot, spent, 1);
        bytes32 mNu = keccak256("otc-maker-nu");
        bytes32 tNu = keccak256("otc-taker-nu");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = mNu; // maker input (asset_a)
        pv.nullifiers[1] = tNu; // taker input (asset_b)
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("otc-taker-recv"); // taker receives asset_a
        pv.leaves[1] = keccak256("otc-maker-recv"); // maker receives asset_b
        vm.expectEmit(false, false, false, true, address(pool));
        emit ConfidentialPool.BitcoinNotesConsumed(pv.nullifiers, btcRoot);
        pool.settle(abi.encode(pv), "", new bytes[](2));
        assertEq(pool.bitcoinConsumed(mNu), btcRoot, "maker leg recorded for the reverse reflection");
        assertEq(pool.bitcoinConsumed(tNu), btcRoot, "taker leg recorded");
        assertEq(pool.bitcoinConsumedCount(), 2, "freshness count advanced by both OTC legs");
    }

    /// FAST-LANE BID FILL (one-settle, BOTH legs Bitcoin-homed): a resting confidential limit order matched
    /// directly on Ethereum — the buyer's funding note + the seller's note both Bitcoin-homed (single
    /// spendRoot, same reasoning as the OTC test above). OP_BID emits only leaves + nullifiers, so it rides
    /// the relaxed leaves bar; both spent ν (funding + seller) are recorded in bitcoinConsumed for the
    /// reverse reflection (the guest runs check_btc_nonmembership per input — main.rs:874/914). A partial
    /// fill emits 4 leaves (buyer fill + seller pay + buyer refund + seller change).
    /// ops/PLAN-fast-lane-trading.md (Flow A).
    function test_btc_homed_bid_records_consumed() public {
        bytes32 btcRoot = keccak256("btc-pool-bid");
        bytes32 spent = keccak256("btc-spent-bid");
        _attestBtc(btcRoot, spent, 1);
        bytes32 fundNu = keccak256("bid-fund-nu");
        bytes32 sellerNu = keccak256("bid-seller-nu");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = fundNu; // buyer funding (asset_b)
        pv.nullifiers[1] = sellerNu; // seller input (asset_a)
        pv.leaves = new bytes32[](4);
        pv.leaves[0] = keccak256("bid-buyer-recv-a"); // buyer receives asset_a (chosen_f)
        pv.leaves[1] = keccak256("bid-seller-recv-b"); // seller receives asset_b (pay)
        pv.leaves[2] = keccak256("bid-buyer-refund"); // partial-fill refund (asset_b)
        pv.leaves[3] = keccak256("bid-seller-change"); // seller change (asset_a)
        vm.expectEmit(false, false, false, true, address(pool));
        emit ConfidentialPool.BitcoinNotesConsumed(pv.nullifiers, btcRoot);
        pool.settle(abi.encode(pv), "", new bytes[](4));
        assertEq(pool.bitcoinConsumed(fundNu), btcRoot, "buyer funding leg recorded for the reverse reflection");
        assertEq(pool.bitcoinConsumed(sellerNu), btcRoot, "seller leg recorded");
        assertEq(pool.bitcoinConsumedCount(), 2, "freshness count advanced by both BID legs");
    }

    /// TWO-SETTLE SWAP (still supported alongside the one-settle path): a Bitcoin holder can also swap via
    /// (1) a btcHomed fast-spend that produces an Ethereum LEAF (the on-ramp), then (2) a NORMAL
    /// non-btcHomed swap of that note. This path touches no bar and stays valid; the one-settle atomic
    /// version (test_btc_homed_swap_records_consumed) is the contract-relaxed shortcut. ops/PLAN-fast-lane-trading.md.
    function test_stage2_swap_via_two_settle_no_bar_change() public {
        // A funded pool over (assetId, a fresh assetB).
        MockERC20 tokenB = new MockERC20();
        bytes32 assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 8);
        (bytes32 lo, bytes32 hi) = assetId < assetB ? (assetId, assetB) : (assetB, assetId);
        bytes32 pid = pool.createPair(lo, hi, 30, 0, bytes32(0), 0);
        ConfidentialPool.PublicValues memory lp = _pv();
        lp.liquidity = new ConfidentialPool.LpSettlement[](1);
        lp.liquidity[0] = ConfidentialPool.LpSettlement(pid, 0, 0, 0, 100000, 200000, 100000);
        _settle(lp);

        // (1) On-ramp: Bob's Bitcoin-homed note → an Ethereum LEAF via the fast lane (a btcHomed leaf).
        bytes32 btcRoot = keccak256("s2-btc-pool");
        bytes32 spent = keccak256("s2-btc-spent");
        _attestBtc(btcRoot, spent, 1);
        ConfidentialPool.PublicValues memory ramp = _pv();
        ramp.spendRoot = btcRoot;
        ramp.bitcoinSpentRoot = spent;
        ramp.nullifiers = _arr(keccak256("s2-onramp-nu"));
        ramp.leaves = _arr(keccak256("s2-eth-note")); // the Ethereum note Bob now holds
        pool.settle(abi.encode(ramp), "", new bytes[](1));
        assertEq(pool.bitcoinConsumed(keccak256("s2-onramp-nu")), btcRoot, "fast-laned, recorded for reflection");

        // (2) NORMAL swap of the fast-laned note — non-btcHomed (spendRoot is an EVM root), no bar change.
        ConfidentialPool.PublicValues memory sw = _pv();
        sw.spendRoot = pool.currentRoot();
        sw.nullifiers = _arr(keccak256("s2-eth-note-nu"));
        sw.leaves = _arr(keccak256("s2-out-note"));
        sw.swaps = new ConfidentialPool.SwapSettlement[](1);
        sw.swaps[0] = ConfidentialPool.SwapSettlement(pid, 100000, 200000, 110000, 182000); // k grows (fee)
        pool.settle(abi.encode(sw), "", new bytes[](1));
        (,,, uint256 ra,,,) = pool.pools(pid);
        assertEq(ra, 110000, "the pool advanced by a NORMAL swap of the fast-laned note");
    }

    /// A nullifier-only Bitcoin-homed spend (no value-exit) is still accepted and records NOTHING in
    /// bitcoinConsumed — the consumed-set write is precisely on value movement, not the lane itself.
    function test_btc_homed_nullifier_only_ok() public {
        bytes32 btcRoot = keccak256("btc-pool-noop");
        bytes32 spent = keccak256("btc-spent-noop");
        _attestBtc(btcRoot, spent, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = _arr(keccak256("noop-nu"));
        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertTrue(pool.nullifierSpent(keccak256("noop-nu")), "nullifier marked");
        assertEq(pool.bitcoinConsumed(keccak256("noop-nu")), bytes32(0), "no value-exit => no consumed record");
    }

    // A btcHomed batch may not consume an EVM deposit: it composes the fast lane with EVM-side escrow
    // accounting the consumed-ν reflection doesn't cover, so it stays bridge-only (the bar above).
    function test_btc_homed_deposit_consume_reverts() public {
        bytes32 btcRoot = keccak256("btc-pool-dep");
        bytes32 spent = keccak256("btc-spent-dep");
        _attestBtc(btcRoot, spent, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;
        pv.nullifiers = _arr(keccak256("dep-nu"));
        pv.depositsConsumed = _arr(keccak256("some-deposit"));
        vm.expectRevert(ConfidentialPool.BtcHomedValueExitMustBridge.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    // ──────────────────── reserve floor: bridge_mint accounting ────────────────────

    /// A bridge_mint pushes the BITCOIN burned-note ν into BOTH nullifiers and bitcoinBurnsConsumed.
    /// That ν is Bitcoin-homed (never an EVM leaf), so it must NOT count toward the EVM spend floor.
    function test_bridge_mint_excluded_from_reserve_floor() public {
        bytes32 root = keccak256("bm-floor-pool");
        bytes32 burnRoot = _attestBtc(root, keccak256("bm-floor-spent"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 bridgeNu = keccak256("bridge-nu-floor");
        pv.nullifiers = _arr(bridgeNu); // real guest: ν in both arrays
        pv.bitcoinBurnsConsumed = _arr(bridgeNu);
        pv.bitcoinRootsUsed = _arr(root);
        pv.bitcoinBurnRoot = burnRoot;
        pv.leaves = _arr(keccak256("bridge-dest-floor"));
        pool.settle(abi.encode(pv), "", new bytes[](1));
        assertEq(pool.nextLeafIndex(), 1, "dest leaf inserted");
    }

    /// A bridge round-trip (mint then a true EVM spend of an equal-magnitude note) must NOT false-trip
    /// the reserve floor. Under the old accounting the bridge ν was double-counted, so the second
    /// settle saw evmNullifiersSpent (2) > nextLeafIndex (1) and reverted ReserveFloorBreach.
    function test_bridge_round_trip_does_not_trip_floor() public {
        _wrap(10, bytes32(uint256(0x100)), bytes32(uint256(0x101)), bytes32(uint256(0x102))); // seed escrow
        bytes32 root = keccak256("rt-pool");
        bytes32 burnRoot = _attestBtc(root, keccak256("rt-spent"), 1);

        ConfidentialPool.PublicValues memory mint = _pv();
        bytes32 bridgeNu = keccak256("rt-bridge-nu");
        mint.nullifiers = _arr(bridgeNu);
        mint.bitcoinBurnsConsumed = _arr(bridgeNu);
        mint.bitcoinRootsUsed = _arr(root);
        mint.bitcoinBurnRoot = burnRoot;
        mint.leaves = _arr(keccak256("rt-dest"));
        pool.settle(abi.encode(mint), "", new bytes[](1));

        ConfidentialPool.PublicValues memory wd = _pv();
        wd.spendRoot = pool.currentRoot(); // an everKnownRoot (EVM-homed spend)
        wd.nullifiers = _arr(keccak256("rt-evm-nu"));
        wd.withdrawals = new ConfidentialPool.Withdrawal[](1);
        wd.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 5);
        pool.settle(abi.encode(wd), "", new bytes[](0)); // must NOT revert ReserveFloorBreach
    }

    // ──────────────────── wrap: fee-on-transfer rejection ────────────────────

    /// A fee-on-transfer token over-credits escrow if booked at the declared amount (last withdrawer
    /// goes short). wrap must reject it: the realized balance delta != amount.
    function test_wrap_fee_on_transfer_reverts() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        bytes32 fotAsset = pool.registerWrapped(address(fot), 1, bytes32(0), "Fee", "FEE", 8);
        fot.mint(USER, 1_000);
        vm.startPrank(USER);
        fot.approve(address(pool), type(uint256).max);
        vm.expectRevert(ConfidentialPool.FeeOnTransferUnsupported.selector);
        pool.wrap(
            fotAsset, 100, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))))
        );
        vm.stopPrank();
    }

    // ──────────────────── reserve floor: trips on overspend + boundary bounds ────────────────────

    /// The no-inflation floor (#EVM-spends ≤ #leaves) must REJECT a settle that nullifies more notes
    /// than the tree ever created — the on-chain backstop against a guest/vkey compromise fabricating
    /// spends. Seed 2 leaves, then a batch marking 3 distinct EVM nullifiers (no new leaves): 3 > 2.
    function test_reserve_floor_trips_on_overspend() public {
        _seedLeaves(2);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = pool.currentRoot(); // an everKnownRoot (EVM-homed spend)
        pv.nullifiers = new bytes32[](3);
        pv.nullifiers[0] = keccak256("ovr-a");
        pv.nullifiers[1] = keccak256("ovr-b");
        pv.nullifiers[2] = keccak256("ovr-c");
        vm.expectRevert(ConfidentialPool.ReserveFloorBreach.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// Bridge burns must be a subset of the global nullifier list, so disjoint arrays are rejected before
    /// they could suppress the EVM reserve-floor count.
    function test_disjoint_bridge_burns_revert() public {
        bytes32 root = keccak256("dj-pool");
        bytes32 burnRoot = _attestBtc(root, keccak256("dj-spent"), 1);
        _seedLeaves(1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = pool.currentRoot();
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = keccak256("dj-evm-a");
        pv.nullifiers[1] = keccak256("dj-evm-b");
        pv.bitcoinBurnsConsumed = new bytes32[](2); // disjoint from nullifiers
        pv.bitcoinBurnsConsumed[0] = keccak256("dj-burn-x");
        pv.bitcoinBurnsConsumed[1] = keccak256("dj-burn-y");
        pv.bitcoinRootsUsed = new bytes32[](2);
        pv.bitcoinRootsUsed[0] = root;
        pv.bitcoinRootsUsed[1] = root;
        pv.bitcoinBurnRoot = burnRoot;
        vm.expectRevert(ConfidentialPool.BridgeBurnNotNullified.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// A withdrawal value is re-bounded to u64 at the public boundary (the note model carries u64),
    /// mirroring wrap's gate — a value above 2^64 is rejected before any payout.
    function test_withdrawal_value_over_u64_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, uint256(type(uint64).max) + 1);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// Same u64 boundary bound on a settler fee.
    function test_fee_value_over_u64_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment(assetId, uint256(type(uint64).max) + 1);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    // ──────────────────── adaptor-swap lock set (OP_ADAPTOR_LOCK/CLAIM/REFUND) ────────────────────
    //
    // The guest proves the lock/claim/refund crypto (membership, ν, opening sigmas, kernel conservation,
    // the deadline binding); the contract owns the lock-set accumulator + the spend-once / lock-root /
    // refund-time gates these tests lock. Each test exercises the contract gate with the mock verifier
    // (verifyProof no-ops), so it is the contract's decode + state machine under test.

    // A LOCK batch appends one locked-note leaf and advances the lock root a later claim/refund pins.
    function _adaptorLock(bytes32 lockLeaf) internal returns (bytes32 newLockRoot) {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.lockLeaves = _arr(lockLeaf);
        _settle(pv);
        newLockRoot = pool.lockRoot();
    }

    function test_adaptor_lock_then_claim() public {
        bytes32 lockRoot0 = pool.lockRoot();
        bytes32 lockRoot1 = _adaptorLock(keccak256("lock-leaf-1"));
        assertTrue(lockRoot1 != lockRoot0, "lock append advanced the lock root");
        assertEq(pool.nextLeafIndex(), 0, "a lock adds NO note-tree leaf (reserve floor untouched)");

        // CLAIM: pin the known lock root, spend ν_L once, mint the recipient output, reveal the kernel s.
        bytes32 lNu = keccak256("lock-nullifier-1");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.lockSetRoot = lockRoot1;
        pv.lockNullifiers = _arr(lNu);
        pv.leaves = _arr(keccak256("claim-output-1"));
        pv.adaptorClaimS = _arr(bytes32(uint256(0x5)));
        _settle(pv);
        assertEq(pool.nextLeafIndex(), 1, "claim minted exactly the output note");
    }

    // The fund-critical gate: a locked note can be spent ONCE (claim XOR refund) — never claimed then
    // refunded (or claimed twice). Without the contract's lockSpent dedup the locked value is withdrawable
    // arbitrarily many times.
    function test_adaptor_lock_double_spend_across_batches_reverts() public {
        bytes32 lockRoot1 = _adaptorLock(keccak256("lock-leaf-2"));
        bytes32 lNu = keccak256("lock-nullifier-2");

        ConfidentialPool.PublicValues memory claim = _pv();
        claim.lockSetRoot = lockRoot1;
        claim.lockNullifiers = _arr(lNu);
        claim.leaves = _arr(keccak256("out-2a"));
        _settle(claim);

        // Now a refund of the SAME ν_L must revert (claim already consumed it).
        ConfidentialPool.PublicValues memory refund = _pv();
        refund.lockSetRoot = lockRoot1;
        refund.lockNullifiers = _arr(lNu);
        refund.leaves = _arr(keccak256("out-2b"));
        vm.expectRevert(ConfidentialPool.LockAlreadySpent.selector);
        _settle(refund);
    }

    // The same ν_L twice within ONE batch is also rejected (set-then-check), so a single proof can't
    // double-claim a locked note.
    function test_adaptor_lock_double_spend_in_one_batch_reverts() public {
        bytes32 lockRoot1 = _adaptorLock(keccak256("lock-leaf-2b"));
        bytes32 lNu = keccak256("lock-nullifier-2b");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.lockSetRoot = lockRoot1;
        pv.lockNullifiers = new bytes32[](2);
        pv.lockNullifiers[0] = lNu;
        pv.lockNullifiers[1] = lNu;
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("out-2c");
        pv.leaves[1] = keccak256("out-2d");
        vm.expectRevert(ConfidentialPool.LockAlreadySpent.selector);
        _settle(pv);
    }

    // A refund settles only at/after the lock's deadline (the ≥ mirror of the claim ≤ gate) — so claim
    // and refund are mutually exclusive on the verified chain time.
    function test_adaptor_refund_before_deadline_reverts() public {
        bytes32 lockRoot1 = _adaptorLock(keccak256("lock-leaf-3"));
        bytes32 lNu = keccak256("lock-nullifier-3");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.lockSetRoot = lockRoot1;
        pv.lockNullifiers = _arr(lNu);
        pv.leaves = _arr(keccak256("refund-out-3"));
        pv.refundNotBefore = uint64(block.timestamp + 1000);

        vm.expectRevert(ConfidentialPool.RefundTooEarly.selector);
        _settle(pv);

        // AT the deadline the refund is STILL too early: the boundary instant belongs to CLAIM (which settles
        // at ≤ deadline), so refund settles only STRICTLY AFTER it — the claim/refund windows are disjoint,
        // with no shared second where both would pass.
        vm.warp(block.timestamp + 1000);
        vm.expectRevert(ConfidentialPool.RefundTooEarly.selector);
        _settle(pv);

        // one second past the deadline the refund is allowed
        vm.warp(block.timestamp + 1);
        _settle(pv);
    }

    // A claim/refund must prove membership against a KNOWN lock root; a forged root (carrying an
    // attacker-authored locked note) is rejected — closing the "mint from a fabricated lock set" path.
    function test_adaptor_claim_unknown_lock_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.lockSetRoot = bytes32(uint256(0xBADBAD));
        pv.lockNullifiers = _arr(keccak256("lock-nullifier-4"));
        pv.leaves = _arr(keccak256("out-4"));
        vm.expectRevert(ConfidentialPool.UnknownLockRoot.selector);
        _settle(pv);
    }

    // A claim (lockNullifiers non-empty) must pin a NON-ZERO known root; a zero root would skip the
    // in-guest membership gate.
    function test_adaptor_claim_zero_lock_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.lockSetRoot = bytes32(0);
        pv.lockNullifiers = _arr(keccak256("lock-nullifier-4b"));
        pv.leaves = _arr(keccak256("out-4b"));
        vm.expectRevert(ConfidentialPool.UnknownLockRoot.selector);
        _settle(pv);
    }

    // Cross-lane safety: a Bitcoin-homed spend may NOT lock (lockLeaves) — that would move Bitcoin-homed
    // value into the EVM lock set while its Bitcoin UTXO stays live (duplication). It must bridge instead.
    function test_adaptor_lock_from_btc_homed_note_reverts() public {
        _seedMaturedRelay(ANCHOR);
        bytes32 poolRoot = keccak256("btc-pool-root-adaptor");
        _attestBtc(poolRoot, keccak256("btc-spent-root-adaptor"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = poolRoot; // btcHomed (a known Bitcoin pool root)
        pv.bitcoinSpentRoot = vm.load(address(pool), bytes32(uint256(78))); // pin the current spent root (mandatory)
        pv.lockLeaves = _arr(keccak256("btc-lock-leaf"));
        vm.expectRevert(ConfidentialPool.BtcHomedValueExitMustBridge.selector);
        _settle(pv);
    }

    /// SPEC-BITCOIN-HOOK-AMENDMENT §1.4: attestBitcoinStateProven records each flat (callId, recordHash) pair
    /// from the reflection's `btcCallsFolded` into `pendingBtcCall` — the guest→contract round-trip the
    /// off-pool BtcCallExecutor reads. Exercises the 15-field relay-PV decode with a NON-empty calls array.
    function test_attest_records_btc_calls() public {
        bytes32 callId = keccak256("btc-call-1");
        bytes32 recordHash = keccak256("record-1");
        assertEq(pool.pendingBtcCall(callId), bytes32(0), "unset before attest");

        bytes32 poolRoot = keccak256("btccall-pool");
        bytes32 spentRoot = keccak256("btccall-spent");
        bytes32 burnRoot = keccak256(abi.encodePacked(spentRoot, "burn"));
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, uint64(1), "btccall"));
        bytes32[] memory calls = new bytes32[](2);
        calls[0] = callId;
        calls[1] = recordHash;
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            poolRoot,
            spentRoot,
            burnRoot,
            uint64(1),
            next,
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            calls
        );
        pool.attestBitcoinStateProven(abi.encode(r), "");
        assertEq(pool.pendingBtcCall(callId), recordHash, "attest recorded the call commitment");
    }

    function test_attest_rejects_odd_btc_call_pairs() public {
        bytes32 poolRoot = keccak256("btccall-odd-pool");
        bytes32 spentRoot = keccak256("btccall-odd-spent");
        bytes32 burnRoot = keccak256(abi.encodePacked(spentRoot, "burn"));
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, uint64(1), "btccall-odd"));
        bytes32[] memory calls = new bytes32[](1);
        calls[0] = keccak256("dangling-call-id");
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            poolRoot,
            spentRoot,
            burnRoot,
            uint64(1),
            next,
            ANCHOR,
            ANCHOR,
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            calls
        );

        vm.expectRevert(ConfidentialPool.BadBtcCallPairs.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }
}
