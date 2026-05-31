// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitBridgeMixer} from "../src/TacitBridgeMixer.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

/// Full withdrawFromBurn against the REAL Groth16Verifier with a REAL ceremony
/// proof and a REAL burn envelope (correct bind_hash + claim id), bound to a
/// deterministic mixer address. Only the two cross-chain consensus inputs are
/// stubbed: Bitcoin block inclusion (MockRelay returns the block root = txid)
/// and SP1 burn acceptance (MockPoolVerifier accepts the exact claim id). Every
/// on-chain seam the Sepolia mock e2e skipped runs for real here: envelope parse
/// -> bind_hash recompute -> claim id -> Groth16 verify through the G2-fixed
/// extraction -> escrow release. Fixture: tests/gen-withdraw-flow-fixture.mjs.
contract MockRelay {
    bytes32 public immutable root;
    constructor(bytes32 r) { root = r; }
    function verifyBlock(bytes calldata, uint256, uint256) external view returns (bytes32) { return root; }
}

contract MockPoolVerifier {
    bytes32 immutable _asset; address immutable _mixer; bytes32 immutable _claim;
    constructor(bytes32 a, address m, bytes32 c) { _asset = a; _mixer = m; _claim = c; }
    function isAcceptedBurn(bytes32 id) external view returns (bool) { return id == _claim; }
    function coversPool(bytes32) external pure returns (bool) { return true; }
    function ASSET_ID() external view returns (bytes32) { return _asset; }
    function MIXER() external view returns (address) { return _mixer; }
    // Audit blocker #3 — mixer deposit() queries this for the pool-tree
    // capacity gate. Returning 0 = empty pool, gate stays open for this test.
    function lastProvenPoolIndex(uint8) external pure returns (uint64) { return 0; }
    // Mock returns 0 so mixer's misorder cross-check soft-skips (real verifier
    // is non-zero by construction). Audit blocker #3 constructor cross-check.
    function denominations(uint256) external pure returns (bytes32) { return bytes32(0); }
}

contract BridgeWithdrawRealProofTest is Test {
    TacitBridgeMixer mixer;
    address constant DEPLOYER = 0x00000000000000000000000000000000DeaDBeef;

    bytes rawBtcTx;
    bytes32 claimId; bytes32 assetId; bytes32 nullifierHash;
    address ethRecipient; uint256 weiDenom;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/withdraw_flow.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        rawBtcTx = vm.parseJsonBytes(json, ".rawBtcTx");
        bytes32 txid = vm.parseJsonBytes32(json, ".txid");
        claimId = vm.parseJsonBytes32(json, ".claimId");
        assetId = vm.parseJsonBytes32(json, ".assetId");
        nullifierHash = vm.parseJsonBytes32(json, ".nullifierHash");
        ethRecipient = vm.parseJsonAddress(json, ".ethRecipient");
        weiDenom = vm.parseJsonUint(json, ".weiDenom");
        address fixtureMixer = vm.parseJsonAddress(json, ".mixer");

        address predicted = vm.computeCreateAddress(DEPLOYER, 0);
        require(predicted == fixtureMixer, "deployer/nonce drift vs fixture mixer address");

        MockRelay relay = new MockRelay(txid);
        Groth16Verifier g16 = new Groth16Verifier();
        MockPoolVerifier pv = new MockPoolVerifier(assetId, predicted, claimId);

        uint256[] memory denoms = new uint256[](1); denoms[0] = weiDenom;
        address[] memory verifiers = new address[](1); verifiers[0] = address(pv);

        vm.prank(DEPLOYER);
        mixer = new TacitBridgeMixer(address(relay), address(g16), address(0), 6, denoms, verifiers, 0x01, assetId);
        require(address(mixer) == predicted, "mixer landed at unexpected address");

        // Fund the pool with one real deposit of weiDenom.
        vm.deal(address(this), weiDenom);
        mixer.deposit{value: weiDenom}(bytes32(uint256(123456789)), weiDenom);
        assertEq(mixer.totalBalance(), weiDenom);
    }

    function test_realBurnProof_releasesEth() public {
        uint256 before = ethRecipient.balance;
        bytes32[] memory emptyProof = new bytes32[](0);
        mixer.withdrawFromBurn(rawBtcTx, hex"", 800000, emptyProof, 0);

        assertEq(ethRecipient.balance - before, weiDenom, "recipient did not receive the denomination");
        bytes32 pid = keccak256(abi.encode(assetId, weiDenom));
        assertTrue(mixer.isBurnNullifierSpent(pid, nullifierHash), "burn nullifier not marked spent");
        assertEq(mixer.totalBalance(), 0, "escrow balance not debited");
    }

    function test_doubleWithdraw_reverts() public {
        bytes32[] memory emptyProof = new bytes32[](0);
        mixer.withdrawFromBurn(rawBtcTx, hex"", 800000, emptyProof, 0);
        vm.expectRevert(); // NullifierAlreadySpent
        mixer.withdrawFromBurn(rawBtcTx, hex"", 800000, emptyProof, 0);
    }
}
