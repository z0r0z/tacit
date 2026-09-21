// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {MerkleTreeLib} from "solady/utils/MerkleTreeLib.sol";
import {TacAirdrop} from "../src/TacAirdrop.sol";

interface IForkPool {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function depositStatus(bytes32 depositId) external view returns (uint8);
}

interface ITacMint { function mint(address to, uint256 amount) external; }

/// MAINNET FORK ONLY (skipped elsewhere): the airdrop against the live pool and the live TAC token.
///   forge test --match-contract TacAirdropFork --fork-url https://ethereum-rpc.publicnode.com -vv
/// The deposits a shield claim registers can only be consumed by the pool's proof, which a fork cannot run; these tests assert
/// the registered state and the exact token accounting, and compare it with a direct `wrap` by an ordinary holder.
contract TacAirdropFork is Test {
    address pool;
    address tac;
    bytes32 tacAssetId;
    bytes32 cusdAssetId;
    address guardian;

    TacAirdrop drop;
    bytes32[] tree;
    address[] accts;
    uint256[] amts;
    uint256 total;
    uint64 deadline;
    uint256 vectorAmount;
    bytes32 vectorCommit;
    bytes32 vectorDepositId;

    function setUp() public {
        if (block.chainid != 1) vm.skip(true);
        string memory d = vm.readFile("deployments/1.json");
        pool = vm.parseJsonAddress(d, ".pool");
        tac = vm.parseJsonAddress(d, ".tacToken");
        tacAssetId = vm.parseJsonBytes32(d, ".tacAssetId");
        cusdAssetId = vm.parseJsonBytes32(d, ".cusdAssetId");
        guardian = vm.parseJsonAddress(d, ".engineAdmin");

        string memory wv = vm.readFile("test/fixtures/airdrop/wrap-vector.json");
        require(vm.parseJsonBytes32(wv, ".assetId") == tacAssetId, "fixture asset");
        vectorAmount = vm.parseUint(vm.parseJsonString(wv, ".amountWei"));
        vectorCommit = vm.parseJsonBytes32(wv, ".commit");
        vectorDepositId = vm.parseJsonBytes32(wv, ".depositId");

        uint256 n = 8;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            address a = address(uint160(0xA000 + i));
            uint256 amt = (i == 6 ? 5 : 1000 + i) * 1e18 + (i == 6 ? 1 : 0); // leaf 6 carries sub-unit dust
            if (i == 7) amt = vectorAmount; // leaf 7 is the amount of the dapp-built deposit fixture
            accts.push(a); amts.push(amt); total += amt;
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(i, a, amt))));
        }
        tree = MerkleTreeLib.build(leaves);
        deadline = uint64(block.timestamp + 30 days);
        drop = new TacAirdrop(tac, MerkleTreeLib.root(tree), guardian, deadline, pool, tacAssetId);
        vm.prank(pool);
        ITacMint(tac).mint(address(drop), total);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) { return MerkleTreeLib.leafProof(tree, i); }
    function _depositId(uint256 amount, bytes32 commit) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(tacAssetId, amount / 1e10, commit));
    }

    function test_constructorMatchesTheLivePoolRegistration() public view {
        assertEq(drop.UNIT_SCALE(), 1e10);
        assertEq(drop.GUARDIAN(), guardian);
        assertEq(drop.POOL(), pool);
        assertEq(drop.ASSET_ID(), tacAssetId);
    }

    function test_anotherAssetIsRefused() public {
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(tac, MerkleTreeLib.root(tree), guardian, deadline, pool, cusdAssetId);
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(tac, MerkleTreeLib.root(tree), guardian, deadline, pool, keccak256("unregistered"));
        vm.expectRevert(TacAirdrop.BadConfig.selector);
        new TacAirdrop(address(0xdead), MerkleTreeLib.root(tree), guardian, deadline, pool, tacAssetId);
    }

    function test_shieldRegistersTheDepositAndBurnsExactlyTheAmount() public {
        bytes32 commit = keccak256("fork-commit-0");
        bytes32 id = _depositId(amts[0], commit);
        assertEq(IForkPool(pool).depositStatus(id), 0);
        uint256 supply = ERC20(tac).totalSupply();
        uint256 poolBal = ERC20(tac).balanceOf(pool);

        vm.expectEmit(true, true, false, true, pool);
        emit Wrap(id, tacAssetId, amts[0]);
        vm.prank(accts[0]);
        drop.claimAndShield(0, amts[0], _proof(0), commit);

        assertEq(IForkPool(pool).depositStatus(id), 1, "deposit registered under the supplied commit");
        assertEq(ERC20(tac).totalSupply(), supply - amts[0], "exactly the claimed amount left the supply");
        assertEq(ERC20(tac).balanceOf(address(drop)), total - amts[0]);
        assertEq(ERC20(tac).balanceOf(pool), poolBal, "the pool holds no TAC");
        assertEq(ERC20(tac).balanceOf(accts[0]), 0);
        assertEq(ERC20(tac).allowance(address(drop), pool), 0);
        assertTrue(drop.isClaimed(0));
    }

    /// The commit and deposit id come from the dapp's buildWrap (contracts/test/fixtures/airdrop/wrap-vector.mjs), so this
    /// pins that the id the wallet will look for is the id the pool registers.
    function test_aDappBuiltCommitRegistersTheDepositIdTheWalletExpects() public {
        assertEq(IForkPool(pool).depositStatus(vectorDepositId), 0);
        vm.prank(accts[7]);
        drop.claimAndShield(7, amts[7], _proof(7), vectorCommit);
        assertEq(IForkPool(pool).depositStatus(vectorDepositId), 1);
    }

    /// The same state change a holder gets from calling the pool's `wrap` themselves.
    function test_shieldMatchesADirectWrap() public {
        address holder = address(0x401DE2);
        vm.prank(pool);
        ITacMint(tac).mint(holder, amts[1]);
        bytes32 directCommit = keccak256("direct-commit");
        uint256 supply0 = ERC20(tac).totalSupply();
        vm.prank(holder);
        IForkPool(pool).wrap(tacAssetId, amts[1], directCommit);
        uint256 directBurn = supply0 - ERC20(tac).totalSupply();
        uint8 directStatus = IForkPool(pool).depositStatus(_depositId(amts[1], directCommit));

        bytes32 viaCommit = keccak256("via-airdrop-commit");
        uint256 supply1 = ERC20(tac).totalSupply();
        vm.prank(accts[1]);
        drop.claimAndShield(1, amts[1], _proof(1), viaCommit);
        assertEq(supply1 - ERC20(tac).totalSupply(), directBurn);
        assertEq(IForkPool(pool).depositStatus(_depositId(amts[1], viaCommit)), directStatus);
    }

    function test_aCollidingDepositRevertsWholeAndTheLeafStaysClaimable() public {
        bytes32 commit = keccak256("shared-commit");
        // an earlier direct deposit of the same value under the same commit takes the deposit id
        address holder = address(0x401DE2);
        vm.prank(pool);
        ITacMint(tac).mint(holder, amts[2]);
        vm.prank(holder);
        IForkPool(pool).wrap(tacAssetId, amts[2], commit);

        vm.prank(accts[2]);
        vm.expectRevert(); // the pool's DepositExists
        drop.claimAndShield(2, amts[2], _proof(2), commit);
        assertFalse(drop.isClaimed(2));
        assertEq(ERC20(tac).balanceOf(address(drop)), total);

        vm.prank(accts[2]);
        drop.claimAndShield(2, amts[2], _proof(2), keccak256("fresh-commit"));
        assertTrue(drop.isClaimed(2));
    }

    function test_subUnitDustCannotBeShieldedButIsStillClaimable() public {
        vm.prank(accts[6]);
        vm.expectRevert(TacAirdrop.AmountNotAligned.selector);
        drop.claimAndShield(6, amts[6], _proof(6), keccak256("dust-commit"));
        assertFalse(drop.isClaimed(6));
        vm.prank(accts[6]);
        drop.claimTo(6, amts[6], _proof(6), accts[6]);
        assertEq(ERC20(tac).balanceOf(accts[6]), amts[6]);
    }

    function test_publicClaimsAndTheFullDrain() public {
        drop.claim(3, accts[3], amts[3], _proof(3));
        assertEq(ERC20(tac).balanceOf(accts[3]), amts[3]);
        vm.prank(accts[4]);
        drop.claimTo(4, amts[4], _proof(4), address(0xD00D));
        assertEq(ERC20(tac).balanceOf(address(0xD00D)), amts[4]);
        uint256 supply = ERC20(tac).totalSupply();
        uint256 shielded;
        for (uint256 i; i < accts.length; ++i) {
            if (drop.isClaimed(i)) continue;
            if (amts[i] % 1e10 == 0 && i % 2 == 0) {
                vm.prank(accts[i]);
                drop.claimAndShield(i, amts[i], _proof(i), keccak256(abi.encode("c", i)));
                shielded += amts[i];
            } else {
                drop.claim(i, accts[i], amts[i], _proof(i));
            }
        }
        assertEq(ERC20(tac).balanceOf(address(drop)), 0);
        assertEq(ERC20(tac).totalSupply(), supply - shielded);
    }

    function test_theOpsMultisigCanPauseAndSweepAtAnyTime() public {
        vm.prank(guardian);
        drop.pause();
        vm.expectRevert(TacAirdrop.Paused.selector);
        drop.claim(0, accts[0], amts[0], _proof(0));
        vm.prank(guardian);
        drop.unpause();
        vm.prank(guardian);
        drop.sweep(guardian, total);
        assertEq(ERC20(tac).balanceOf(guardian) >= total, true);
        assertEq(ERC20(tac).balanceOf(address(drop)), 0);
    }

    function test_claimsCloseAfterTheDeadlineOnTheRealToken() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(TacAirdrop.ClaimWindowClosed.selector);
        drop.claim(0, accts[0], amts[0], _proof(0));
    }

    /// Execution gas of each claim path on the real token and pool for trees of 1,024 and 100,000 leaves (depth 10 and 17), with
    /// every touched account cold, as in a fresh transaction. A transaction adds 21,000 base gas and about 16 gas per calldata
    /// byte (a proof word is 32 bytes). Run with `-vv` to print.
    function test_gasByProofDepth() public {
        uint256[2] memory sizes = [uint256(1024), 100_000];
        for (uint256 s = 0; s < 2; ++s) {
            uint256 n = sizes[s];
            vm.pauseGasMetering();
            bytes32[] memory leaves = new bytes32[](n);
            for (uint256 i; i < n; ++i) leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(i, address(uint160(0xC0000 + i)), uint256(1e18)))));
            bytes32[] memory t = MerkleTreeLib.build(leaves);
            TacAirdrop d = new TacAirdrop(tac, MerkleTreeLib.root(t), guardian, deadline, pool, tacAssetId);
            vm.prank(pool);
            ITacMint(tac).mint(address(d), n * 1e18);
            vm.resumeGasMetering();
            uint256[3] memory picks = [n / 2, n / 2 + 1, n - 1]; // the first two share a bitmap word
            uint256 g;
            bytes32[] memory p = MerkleTreeLib.leafProof(t, picks[0]);
            vm.cool(address(d)); vm.cool(tac); vm.cool(pool);
            g = gasleft();
            d.claim(picks[0], address(uint160(0xC0000 + picks[0])), 1e18, p);
            console2.log("leaves / proof words / claim (first claim in a bitmap word):", n, p.length, g - gasleft());
            p = MerkleTreeLib.leafProof(t, picks[1]);
            vm.cool(address(d)); vm.cool(tac); vm.cool(pool);
            g = gasleft();
            d.claim(picks[1], address(uint160(0xC0000 + picks[1])), 1e18, p);
            console2.log("claim (later claim in the same word):", g - gasleft());
            p = MerkleTreeLib.leafProof(t, picks[2]);
            vm.prank(address(uint160(0xC0000 + picks[2])));
            vm.cool(address(d)); vm.cool(tac); vm.cool(pool);
            g = gasleft();
            d.claimTo(picks[2], 1e18, p, address(0xD00D));
            console2.log("claimTo (first claim in its word):", g - gasleft());
            uint256 k = 3;
            p = MerkleTreeLib.leafProof(t, k);
            vm.prank(address(uint160(0xC0000 + k)));
            vm.cool(address(d)); vm.cool(tac); vm.cool(pool);
            g = gasleft();
            d.claimAndShield(k, 1e18, p, keccak256(abi.encode("gas-commit", n)));
            console2.log("claimAndShield (first claim in its word):", g - gasleft());
            k = 4;
            p = MerkleTreeLib.leafProof(t, k);
            vm.prank(address(uint160(0xC0000 + k)));
            vm.cool(address(d)); vm.cool(tac); vm.cool(pool);
            g = gasleft();
            d.claimAndShield(k, 1e18, p, keccak256(abi.encode("gas-commit-2", n)));
            console2.log("claimAndShield (later claim in the same word):", g - gasleft());
        }
    }

    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount);
}
