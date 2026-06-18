// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";

/// Accepts any proof — the proof crypto is validated end-to-end elsewhere
/// (cxfer-core native, the SP1 guest execute, ConfidentialProofReal on-chain). This
/// walkthrough is the CONTRACT-level lifecycle of a Tacit-recorded asset on Ethereum.
contract AcceptVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// End-to-end TAC on Ethereum, the asset-hub lifecycle:
///   Bitcoin TAC burn ─bridge_mint→ confidential note ─unwrap→ public TAC.erc20
///   ─transfer→ tradeable (Uniswap) ─wrap→ back to a confidential note.
/// The pool is TAC.erc20's sole minter (mint on exit, burn on entry) — single supply
/// authority; the backing is the Tacit record (the bridge_mint), no Ethereum escrow.
contract ConfidentialTacWalkthroughTest is Test {
    ConfidentialPool pool;
    CanonicalBridgedERC20 tac;
    bytes32 tacAsset;

    address constant USER = address(0xA11CE);   // bridges TAC in, exits to public
    address constant BOB = address(0xB0B);       // a counterparty who receives public TAC
    address constant ALICE = address(0xA71CE);   // receives TAC confidentially, then exits

    /// Attest the Bitcoin pool root via the relay-proven path (no oracle). AcceptVerifier
    /// no-ops the proof; this exercises the contract gate.
    bytes32 constant BURN_SENTINEL = keccak256("imt-empty-burn-sentinel");

    function _attestBtc(bytes32 poolRoot) internal {
        // spent / burn roots are the non-zero empty-IMT sentinels (a zero root is rejected —
        // it would re-open the cross-lane / bridge-mint bypass); this walkthrough only needs
        // the pool root canonical for the bridge_mint, so the sentinels stand in for the sets.
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot));
        pool.attestBitcoinStateProven(
            abi.encode(ConfidentialPool.BitcoinRelayPublicValues(prior, poolRoot, keccak256("imt-empty-sentinel"), BURN_SENTINEL, 1, next, bytes32(0), bytes32(0), bytes32(uint256(uint160(address(pool)))), 0, uint64(pool.bitcoinConsumedCount()))), ""
        );
    }

    function setUp() public {
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        pool = new ConfidentialPool(address(new AcceptVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(factory), address(0), bytes32(0), 6, bytes32(0), bytes32(0));
        // Deploy TAC's canonical ERC20 (ETH_DECIMALS) with the POOL as its sole minter.
        tac = CanonicalBridgedERC20(factory.deployCanonical(keccak256("TAC"), address(pool), "TAC", 18));
        // Register it as a LOCAL Tacit-recorded (pool-minted) asset: wrap burns, unwrap mints.
        // unitScale is derived (tacitDecimals == ETH_DECIMALS ⇒ 1).
        tacAsset = pool.registerMinted(address(tac), "Conf TAC", "TAC", 18);
    }

    function _settle(ConfidentialPool.PublicValues memory pv, bytes[] memory memos) internal {
        pool.settle(abi.encode(pv), "", memos);
    }
    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    function test_tac_end_to_end() public {
        uint256 amount = 50e8; // 50 TAC (8 decimals), hidden in the note; public only at exit

        // ── 1. bridge_mint: a confirmed Bitcoin TAC burn becomes a confidential note ──
        bytes32 btcRoot = keccak256("bitcoin-tac-pool-root");
        _attestBtc(btcRoot); // the relay proves the canonical Bitcoin pool root

        bytes32 noteLeaf = keccak256("user-TAC-note");           // the dest note the guest minted
        bytes32 claimId = keccak256("btc-tac-burn-claim");        // one mint per Bitcoin burn
        ConfidentialPool.PublicValues memory mintPv = _pv();
        mintPv.bitcoinRootsUsed = new bytes32[](1); mintPv.bitcoinRootsUsed[0] = btcRoot;
        mintPv.bitcoinBurnsConsumed = new bytes32[](1); mintPv.bitcoinBurnsConsumed[0] = claimId;
        mintPv.bitcoinBurnRoot = BURN_SENTINEL;
        mintPv.leaves = new bytes32[](1); mintPv.leaves[0] = noteLeaf;
        bytes[] memory memos = new bytes[](1); memos[0] = hex"ab"; // owner-encrypted memo (recovery)
        _settle(mintPv, memos);

        assertTrue(pool.bridgeMinted(claimId), "Bitcoin burn claimed once");
        assertEq(pool.nextLeafIndex(), 1, "TAC note now lives confidentially in the pool");
        assertEq(tac.totalSupply(), 0, "no public ERC20 yet - value is confidential");

        // ── 2. unwrap (exit): spend the note; the pool MINTS public TAC.erc20 ──
        ConfidentialPool.PublicValues memory exitPv = _pv();
        exitPv.spendRoot = pool.currentRoot(); // membership proven against the post-mint root
        exitPv.nullifiers = new bytes32[](1); exitPv.nullifiers[0] = keccak256("user-TAC-note-nu");
        exitPv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        exitPv.withdrawals[0] = ConfidentialPool.Withdrawal(tacAsset, USER, amount);
        _settle(exitPv, new bytes[](0));

        assertEq(tac.balanceOf(USER), amount, "exit minted public TAC to the user");
        assertEq(tac.totalSupply(), amount, "public supply = exited amount (single authority)");
        assertEq(pool.escrow(tacAsset), 0, "no escrow - the pool minted, it didn't release");

        // ── 3. tradeable: TAC.erc20 is a plain ERC20 (Uniswap, transfers, …) ──
        vm.prank(USER);
        tac.transfer(BOB, 20e8);
        assertEq(tac.balanceOf(USER), 30e8, "user keeps 30");
        assertEq(tac.balanceOf(BOB), 20e8, "counterparty holds public TAC");

        // ── 4. wrap (re-enter): back to confidential — the pool BURNS the ERC20 ──
        vm.prank(BOB);
        pool.wrap(tacAsset, 20e8, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))));
        assertEq(tac.balanceOf(BOB), 0, "re-entry burned BOB's public TAC");
        assertEq(tac.totalSupply(), 30e8, "supply back to 30 (only USER's stays public)");
    }

    /// Bob sends TAC to Alice CONFIDENTIALLY, then Alice withdraws it on Ethereum as
    /// the public TAC.erc20. Bob's entry + the Bob→Alice transfer are private (hidden
    /// amounts, unlinkable); only Alice's exit reveals the amount + her address.
    function test_bob_sends_alice_who_exits_to_public_erc20() public {
        uint256 amount = 30e8;
        bytes[] memory oneMemo = new bytes[](1); oneMemo[0] = hex"cd";

        // 1. bridge_mint: Bob's confidential TAC note enters the pool.
        bytes32 btcRoot = keccak256("btc-tac-root-2");
        _attestBtc(btcRoot);
        ConfidentialPool.PublicValues memory mintPv = _pv();
        mintPv.bitcoinRootsUsed = new bytes32[](1); mintPv.bitcoinRootsUsed[0] = btcRoot;
        mintPv.bitcoinBurnsConsumed = new bytes32[](1); mintPv.bitcoinBurnsConsumed[0] = keccak256("bob-tac-burn");
        mintPv.bitcoinBurnRoot = BURN_SENTINEL;
        mintPv.leaves = new bytes32[](1); mintPv.leaves[0] = keccak256("bob-TAC-note");
        _settle(mintPv, oneMemo);
        bytes32 afterMint = pool.currentRoot();

        // 2. Bob → Alice: a confidential transfer. Bob's note is nullified; Alice's
        //    note (owned by her, memo sealed to her) is inserted. Amount hidden.
        ConfidentialPool.PublicValues memory xferPv = _pv();
        xferPv.spendRoot = afterMint; // Bob proves his note's membership against this root
        xferPv.nullifiers = new bytes32[](1); xferPv.nullifiers[0] = keccak256("bob-note-nu");
        xferPv.leaves = new bytes32[](1); xferPv.leaves[0] = keccak256("alice-TAC-note");
        _settle(xferPv, oneMemo); // memo lets Alice recover the note from her seed
        bytes32 afterXfer = pool.currentRoot();

        // 3. Alice exits: unwrap her received note → the pool MINTS public TAC.erc20
        //    to Alice's Ethereum address.
        ConfidentialPool.PublicValues memory exitPv = _pv();
        exitPv.spendRoot = afterXfer;
        exitPv.nullifiers = new bytes32[](1); exitPv.nullifiers[0] = keccak256("alice-note-nu");
        exitPv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        exitPv.withdrawals[0] = ConfidentialPool.Withdrawal(tacAsset, ALICE, amount);
        _settle(exitPv, new bytes[](0));

        assertEq(tac.balanceOf(ALICE), amount, "Alice withdrew TAC as public ERC20");
        assertEq(tac.balanceOf(BOB), 0, "Bob never held public TAC; he sent it confidentially");
        assertEq(tac.totalSupply(), amount, "single supply authority = the pool");
        assertTrue(pool.nullifierSpent(keccak256("bob-note-nu")), "Bob's note spent");
        assertTrue(pool.nullifierSpent(keccak256("alice-note-nu")), "Alice's note spent on exit");

        // Alice's public TAC trades like any ERC20.
        vm.prank(ALICE);
        tac.transfer(BOB, 10e8);
        assertEq(tac.balanceOf(BOB), 10e8, "public TAC moves freely (Uniswap, transfers)");
    }
}
