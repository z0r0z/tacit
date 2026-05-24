// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";

contract BridgeIntegrationTest is TestHelper {
    TacitETHMixer mixer;
    TestLightRelay relay;
    MockPoolRootVerifier prv;

    uint256 constant DENOM = 1 ether;
    bytes32 constant AID = bytes32(uint256(0xAA));
    bytes32 poolId;

    function setUp() public {
        relay = _deployRelay();
        MockGroth16Verifier v = new MockGroth16Verifier();
        prv = new MockPoolRootVerifier();
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = DENOM;
        mixer = new TacitETHMixer(address(relay), address(v), address(prv), address(0), 3, denoms, 0x00, AID);
        poolId = keccak256(abi.encode(AID, DENOM));
    }

    function test_full_deposit_and_withdrawal() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        prv.setPoolRoot(bytes32(uint256(0xF00D)));
        bytes memory rawTx = _makeBurnTx(bytes32(uint256(0xCAFE)), address(0xBEEF));
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        uint256 bal = address(0xBEEF).balance;
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
        assertEq(address(0xBEEF).balance, bal + DENOM);
    }

    function test_double_withdrawal_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        prv.setPoolRoot(bytes32(uint256(0xF00D)));
        bytes memory rawTx = _makeBurnTx(bytes32(uint256(0xCAFE)), address(0xBEEF));
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
        vm.expectRevert(TacitETHMixer.NullifierAlreadySpent.selector);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_insufficient_confirmations_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        bytes memory rawTx = _makeBurnTx(bytes32(uint256(0xCAFE)), address(0xBEEF));
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 2);
        vm.expectRevert(BitcoinLightRelay.InvalidChainLength.selector);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_wrong_opcode_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        bytes memory env = _buildEnvelope(0x60, bytes32(uint256(0xCAFE)), address(0xBEEF));
        bytes memory rawTx = _wrapInBtcTx(env);
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        vm.expectRevert(TacitETHMixer.InvalidBurnProof.selector);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_wrong_network_tag_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        bytes memory env = _buildEnvelope(0x61, bytes32(uint256(0xCAFE)), address(0xBEEF));
        env[1] = 0x01;
        bytes memory rawTx = _wrapInBtcTx(env);
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        vm.expectRevert(TacitETHMixer.InvalidNetworkTag.selector);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_unproven_root_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        bytes memory env = _buildEnvelope(0x61, bytes32(uint256(0xCAFE)), address(0xBEEF), bytes32(uint256(0xDEAD)), address(mixer));
        bytes memory rawTx = _wrapInBtcTx(env);
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        vm.expectRevert(TacitETHMixer.UnprovenRoot.selector);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_invalid_groth16_proof_reverts() public {
        RejectingGroth16Verifier badV = new RejectingGroth16Verifier();
        MockPoolRootVerifier prv2 = new MockPoolRootVerifier();
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = DENOM;
        TacitETHMixer strict = new TacitETHMixer(address(relay), address(badV), address(prv2), address(0), 3, denoms, 0x00, AID);
        prv2.setPoolRoot(bytes32(uint256(0xF00D)));
        vm.deal(address(this), 10 ether);
        strict.deposit{value: DENOM}(bytes32(uint256(99)), DENOM);
        bytes memory env = _buildEnvelope(0x61, bytes32(uint256(0xCAFE)), address(0xBEEF), bytes32(uint256(0xF00D)), address(strict));
        bytes memory rawTx = _wrapInBtcTx(env);
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        vm.expectRevert(TacitETHMixer.InvalidGroth16Proof.selector);
        strict.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_tampered_tx_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        bytes memory rawTx = _makeBurnTx(bytes32(uint256(0xCAFE)), address(0xBEEF));
        bytes memory ph = _buildChain(bytes32(0), _dsha256(rawTx), 4);
        rawTx[rawTx.length - 100] ^= 0xff;
        vm.expectRevert(TacitETHMixer.InvalidBurnProof.selector);
        mixer.withdrawFromBurn(rawTx, ph, 0, new bytes32[](0), 0);
    }

    function test_root_history_window() public {
        vm.deal(address(this), 200 ether);
        bytes32 firstRoot;
        for (uint256 i = 1; i <= 101; ++i) {
            mixer.deposit{value: DENOM}(bytes32(i), DENOM);
            if (i == 1) firstRoot = mixer.getPoolRoot(poolId);
        }
        assertFalse(mixer.isKnownDepositRoot(poolId, firstRoot));
        assertTrue(mixer.isKnownDepositRoot(poolId, mixer.getPoolRoot(poolId)));
    }

    function test_pool_balance_tracks() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(1)), DENOM);
        mixer.deposit{value: DENOM}(bytes32(uint256(2)), DENOM);
        assertEq(mixer.getPoolBalance(poolId), 2 ether);
    }

    function test_duplicate_commitment_reverts() public {
        vm.deal(address(this), 10 ether);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
        vm.expectRevert(TacitETHMixer.DuplicateCommitment.selector);
        mixer.deposit{value: DENOM}(bytes32(uint256(42)), DENOM);
    }

    // ──────────────────── Helpers ────────────────────

    function _makeBurnTx(bytes32 nullHash, address recipient) internal view returns (bytes memory) {
        return _wrapInBtcTx(_buildEnvelope(0x61, nullHash, recipient, bytes32(uint256(0xF00D)), address(mixer)));
    }

    function _buildEnvelope(uint8 opcode, bytes32 nullHash, address recipient) internal view returns (bytes memory) {
        return _buildEnvelope(opcode, nullHash, recipient, bytes32(uint256(0xF00D)), address(mixer));
    }

    function _buildEnvelope(uint8 opcode, bytes32 nullHash, address recipient, bytes32 root, address mixerAddr) internal view returns (bytes memory) {
        bytes memory env = new bytes(281 + 256);
        env[0] = bytes1(opcode);
        env[1] = 0x00;
        for (uint256 i; i < 32; ++i) env[2 + i] = AID[i];
        bytes32 d = bytes32(DENOM);
        for (uint256 i; i < 32; ++i) env[34 + i] = d[i];
        for (uint256 i; i < 32; ++i) env[66 + i] = root[i];
        for (uint256 i; i < 32; ++i) env[98 + i] = nullHash[i];
        bytes20 rb = bytes20(recipient);
        for (uint256 i; i < 20; ++i) env[195 + i] = rb[i];
        uint256 FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        bytes memory rc = new bytes(33);
        bytes memory er = new bytes(20);
        for (uint256 i; i < 20; ++i) er[i] = rb[i];
        bytes32 bindHash = bytes32(uint256(sha256(abi.encodePacked(
            "tacit-bridge-burn-v1", block.chainid, mixerAddr,
            uint8(0x00), AID, d, root, nullHash, rc, bytes32(0), er, bytes32(0)
        ))) % FIELD);
        for (uint256 i; i < 32; ++i) env[247 + i] = bindHash[i];
        env[279] = 0x00; env[280] = 0x01;
        return env;
    }
}
